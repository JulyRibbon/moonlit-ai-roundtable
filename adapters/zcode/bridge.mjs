// ZCode app-server Bridge v1。
//
// 只走 ZCode.exe 自带的 app-server（NDJSON，内部协议），不创建、不归档、
// 不 fork、不关闭原生会话，也不打开 GUI。
//
// 关键约束：
// - probe 只读 `session/list`，确认目标会话存在；不 resume/send/stop，不产生模型调用；
// - connect 先确认会话，再 `session/resume` 与 `session/subscribe`；
//   resume 只传 sessionId，不传 workspace / modelSelection / thoughtLevel / mode；
// - subscribe 使用 deliveryKind=desktop-continuous、afterSeq、includeSnapshot；
// - send 先登记 pending attempt，再 `session/send`，inputId = attemptId；
//   不默认传 toolDenylist，保持客户端原权限；
// - turn.started 按 inputId 关联 AttemptStarted；part.delta / message.upserted
//   只积累 partial；正文只认 turn.completed.payload.response；
// - eventId / seq 去重，inputId / turnId / messageId 关联，绝不按文本关联；
// - 断线后 snapshot + subscribe + 只读 events/messages 对账，
//   断线窗口完成的 attempt 恰好结算一次，历史 foreign 不重放；
// - cancel 只 `session/stop`，无 queueClear；最终由 turn.completed(cancelled) 确认；
// - close 只退订并结束本次 app-server，等待子进程退出，不碰原生会话。

import { createHash } from 'node:crypto';

import {
  BridgeError,
  VOICE_MODES,
  assertContextPacket,
  normalizeCapabilities,
  unsupportedCapability,
} from '../contract.mjs';
import { BRIDGE_EVENT_TYPES, createBridgeEvent } from '../../core/events.mjs';
import {
  DEFAULT_ZCODE_CLI,
  DEFAULT_ZCODE_EXE,
  ZCODE_DEFAULT_RUNTIME_PREFERENCES,
  ZCODE_KNOWN_CLI_VERSION,
  ZCODE_PROTOCOL_VERSION,
  ZCodeAppServerClient,
  redact,
} from './client.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_RESUME_TIMEOUT_MS = 120000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 60000;
const DEFAULT_READ_TIMEOUT_MS = 30000;
const DEFAULT_CLOSE_TIMEOUT_MS = 8000;
const DEFAULT_BASELINE_TIMEOUT_MS = 5000;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_RECONCILE_ATTEMPTS = 2;
const DEFAULT_RECONCILE_RETRY_DELAY_MS = 50;
const DEFAULT_SESSION_LIST_LIMIT = 100;

const RUNTIME_PREFERENCE_KEYS = Object.freeze([
  'additionalDirectories',
  'nativeSearchEnhancementsEnabled',
  'toolSearchMode',
  'subagentRuntimeConfigEnabled',
  'memoryEnabled',
  'askUserQuestionAutoResolutionEnabled',
  'integratedTerminalShell',
  'modelContextBudgetStrategy',
]);

const TOOL_SEARCH_MODES = new Set(['auto', 'local', 'off']);
const CONTEXT_BUDGET_STRATEGIES = new Set(['legacy', 'preflight-v1']);

export function normalizeRuntimePreferences(overrides = {}, base = ZCODE_DEFAULT_RUNTIME_PREFERENCES) {
  const result = { ...base };
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return result;

  for (const key of RUNTIME_PREFERENCE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    const value = overrides[key];
    if (key === 'additionalDirectories') {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        result[key] = value.slice(0, 256);
      }
      continue;
    }
    if (key === 'toolSearchMode') {
      if (typeof value === 'string' && TOOL_SEARCH_MODES.has(value)) result[key] = value;
      continue;
    }
    if (key === 'modelContextBudgetStrategy') {
      if (typeof value === 'string' && CONTEXT_BUDGET_STRATEGIES.has(value)) result[key] = value;
      continue;
    }
    if (key === 'integratedTerminalShell') {
      if (!value || typeof value !== 'object') continue;
      if (value.mode === 'auto') result[key] = { mode: 'auto' };
      else if (
        value.mode === 'shell'
        && (value.dialect === 'cmd' || value.dialect === 'git-bash')
        && typeof value.id === 'string' && value.id.length > 0
        && typeof value.label === 'string' && value.label.length > 0
        && typeof value.path === 'string' && value.path.length > 0
      ) {
        result[key] = {
          mode: 'shell',
          dialect: value.dialect,
          id: value.id,
          label: value.label,
          path: value.path,
        };
      }
      continue;
    }
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

const ZCODE_CAPABILITIES = Object.freeze({
  nativeSession: true,
  nativeIdentity: true,
  sendToExistingSession: true,
  finalMessageEvent: true,
  messageDeduplication: true,
  snapshotRecovery: true,
  foreignTurnDetection: true,
  queueClear: false,
  requestAbort: true,
  providerUsage: true,
  // 房间只展示外部 Stop hook 的语音状态，不主动触发 TTS，也不仲裁语音。
  voiceTrigger: false,
  voiceStartedFinishedEvents: false,
  voiceStop: false,
  voiceMute: false,
});

export function nativeTurnRefFor(sessionRef, turnRef) {
  return `${sessionRef}#turn:${String(turnRef)}`;
}

const TURN_STARTED_TYPES = new Set(['turn.started', 'turn_started', 'turn.start']);
const TURN_COMPLETED_TYPES = new Set(['turn.completed', 'turn_completed', 'turn.complete']);
const TURN_FAILED_TYPES = new Set(['turn.failed', 'turn_failed', 'turn.error']);
const PART_DELTA_TYPES = new Set(['part.delta', 'part_delta', 'message.delta']);
const MESSAGE_UPSERT_TYPES = new Set(['message.upserted', 'message_upserted', 'message.updated']);

function stringOf(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  const type = typeof block.type === 'string' ? block.type.toLowerCase() : null;
  if (type && ['thinking', 'reasoning', 'tool_use', 'tool_result', 'tool_call', 'tool-call'].includes(type)) {
    return '';
  }
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(blockText).join('');
  return '';
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  const content = value.content ?? value.blocks ?? value.parts;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('');
  if (content && typeof content === 'object') return blockText(content);
  if (value.message && typeof value.message === 'object' && value.message !== value) {
    return textOf(value.message);
  }
  return '';
}

function unwrapEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let event = raw.event ?? raw;
  if (event.record && typeof event.record === 'object') event = event.record;
  if (event.event && typeof event.event === 'object' && typeof event.type !== 'string') {
    event = event.event;
  }
  if (!event || typeof event.type !== 'string') return null;

  const payload = {
    ...(event.payload && typeof event.payload === 'object' ? event.payload : {}),
    ...(event.data && typeof event.data === 'object' ? event.data : {}),
  };
  for (const key of [
    'inputId',
    'turnId',
    'messageId',
    'resultType',
    'response',
    'delta',
    'offset',
    'text',
    'role',
    'error',
    'usage',
  ]) {
    if (event[key] !== undefined && payload[key] === undefined) payload[key] = event[key];
  }

  return {
    eventId: stringOf(event.eventId ?? event.id ?? event.event_id),
    seq: numberOrNull(event.seq ?? event.sequence ?? payload.seq),
    type: event.type,
    sessionId: stringOf(event.sessionId ?? payload.sessionId),
    payload,
  };
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const envelope = raw.message && typeof raw.message === 'object' ? raw.message : raw;
  const message = envelope.info && typeof envelope.info === 'object' ? envelope.info : envelope;
  const parts = Array.isArray(envelope.parts)
    ? envelope.parts
    : Array.isArray(message.parts)
      ? message.parts
      : null;
  const id = message.messageId
    ?? message.message_id
    ?? message.id
    ?? null;
  const inputId = message.inputId
    ?? message.input_id
    ?? message.promptId
    ?? message.prompt_id
    ?? envelope.inputId
    ?? envelope.turnId
    ?? message.metadata?.inputId
    ?? null;
  const turnId = message.turnId
    ?? message.turn_id
    ?? envelope.turnId
    ?? (message.turn && typeof message.turn === 'object' ? message.turn.id : message.turn)
    ?? null;
  const role = typeof message.role === 'string'
    ? message.role.toLowerCase()
    : typeof message.author?.role === 'string'
      ? message.author.role.toLowerCase()
      : null;
  const partText = parts
    ? parts.map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
    : '';
  return {
    messageId: stringOf(id),
    inputId: stringOf(inputId),
    turnId: stringOf(turnId),
    role,
    text: partText || textOf(message),
    ...(message.model && typeof message.model === 'object' ? { info: { model: message.model } } : {}),
    seq: numberOrNull(message.seq ?? message.sequence),
  };
}

function collectEvents(value) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(value?.events)
      ? value.events
      : Array.isArray(value?.records)
        ? value.records
        : [];
  const events = [];
  for (const item of list) {
    const event = unwrapEvent(item);
    if (event) events.push(event);
  }
  return events;
}

function collectMessages(value) {
  const list = Array.isArray(value)
    ? value
    : Array.isArray(value?.messages)
      ? value.messages
      : Array.isArray(value?.transcript)
        ? value.transcript
        : [];
  const messages = [];
  for (const item of list) {
    const message = normalizeMessage(item);
    if (message) messages.push(message);
  }
  return messages;
}

function hasSnapshotShape(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (
        Array.isArray(value.events)
        || Array.isArray(value.records)
        || Array.isArray(value.messages)
        || Array.isArray(value.transcript)
        || value.seq !== undefined
        || value.lastSeq !== undefined
        || value.eventSeq !== undefined
        || value.runtime !== undefined
      ),
  );
}

function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') {
    return { events: [], messages: [], usage: null, seq: 0 };
  }
  const root = hasSnapshotShape(raw.snapshot) ? raw.snapshot : raw;
  const events = collectEvents(root);
  const messages = collectMessages(root);
  let seq = numberOrNull(
    root.seq
      ?? root.lastSeq
      ?? root.last_seq
      ?? root.eventSeq
      ?? root.lastEventSeq
      ?? root.afterSeq
      ?? root.runtime?.eventSeq
      ?? root.projection?.eventSeq,
  ) ?? 0;
  for (const event of events) {
    if (event.seq !== null && event.seq > seq) seq = event.seq;
  }
  for (const message of messages) {
    if (message.seq !== null && message.seq > seq) seq = message.seq;
  }
  return {
    events,
    messages,
    usage: root.usage ?? root.tokenUsage ?? root.token_usage ?? null,
    seq,
  };
}

function snapshotOf(result) {
  if (!result || typeof result !== 'object') return null;

  let snapshot = null;
  if (hasSnapshotShape(result.snapshot)) {
    snapshot = normalizeSnapshot(result.snapshot);
  } else if (hasSnapshotShape(result.record)) {
    snapshot = normalizeSnapshot(result.record);
  } else if (hasSnapshotShape(result)) {
    snapshot = normalizeSnapshot(result);
  }

  const siblingEvents = collectEvents(result.events);
  const persistedMessages = collectMessages(result.persistedMessages);
  const eventSeq = numberOrNull(result.eventSeq ?? result.lastEventSeq);

  if (!snapshot && siblingEvents.length === 0 && persistedMessages.length === 0 && eventSeq === null) {
    return null;
  }
  if (!snapshot) {
    snapshot = { events: [], messages: [], usage: null, seq: 0 };
  }

  snapshot.events.push(...siblingEvents);
  snapshot.messages.push(...persistedMessages);
  if (eventSeq !== null && eventSeq > snapshot.seq) snapshot.seq = eventSeq;
  for (const event of siblingEvents) {
    if (event.seq !== null && event.seq > snapshot.seq) snapshot.seq = event.seq;
  }
  return snapshot;
}

function modelInfoOfMessage(message) {
  const info = message?.info;
  const selection = info?.model
    ?? info?.metadata?.inputIntent?.modelSelection
    ?? info?.metadata?.conversationInputIntent?.modelSelection
    ?? null;
  if (!selection || typeof selection.modelId !== 'string' || selection.modelId.length === 0) return null;
  return {
    model: selection.modelId,
    provider: typeof selection.providerId === 'string' ? selection.providerId : null,
    reasoningEffort: typeof selection.options?.reasoningLevel === 'string'
      ? selection.options.reasoningLevel
      : null,
    selection,
  };
}

function normalizeUsage(raw) {
  const source = raw && typeof raw === 'object' ? raw : null;
  if (!source) return null;
  const bag = source.usage && typeof source.usage === 'object' ? source.usage : source;

  const pick = (...keys) => {
    for (const key of keys) {
      const value = bag[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };

  const usage = {
    inputTokens: pick('inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens'),
    outputTokens: pick('outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens'),
    cacheReadTokens: pick('cacheReadTokens', 'cache_read_tokens', 'cacheRead', 'cache_read'),
    cacheWriteTokens: pick('cacheWriteTokens', 'cache_write_tokens', 'cacheWrite', 'cache_write'),
    totalTokens: pick('totalTokens', 'total_tokens'),
  };
  if (Object.values(usage).every((value) => value === null)) return null;
  return usage;
}

function normalizeError(raw, fallbackCode = 'TURN_FAILED') {
  if (raw && typeof raw === 'object') {
    return {
      code: typeof raw.code === 'string' ? raw.code : fallbackCode,
      message: redact(typeof raw.message === 'string' ? raw.message : String(raw.message ?? 'Turn failed.')),
      retryable: raw.retryable === true,
    };
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return { code: fallbackCode, message: redact(raw), retryable: false };
  }
  return {
    code: fallbackCode,
    message: 'ZCode turn ended without a completable result.',
    retryable: false,
  };
}

function responseTextOf(payload) {
  const response = payload?.response;
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    return textOf(response) || (typeof response.text === 'string' ? response.text : '');
  }
  return '';
}

function resultTypeOf(payload) {
  const raw = payload?.resultType
    ?? payload?.result_type
    ?? payload?.result?.type
    ?? payload?.result?.kind
    ?? null;
  return raw === null || raw === undefined ? null : String(raw).toLowerCase();
}

function turnKey(turnId) {
  return `turn:${String(turnId)}`;
}

export class ZCodeBridge {
  constructor(config = {}) {
    this._config = { ...config };
    this._seatId = config.seatId ?? null;
    this._sessionRef = config.nativeSessionRef ?? null;
    this._sessionSummary = null;
    this._nativeModel = { model: null, provider: null };
    this._creatingNativeSession = false;

    this._client = config.client ?? null;
    this._apiFactory = config.apiFactory ?? null;
    this._managedClient = !config.client && !config.apiFactory;

    this._connected = false;
    this._connecting = false;
    this._everConnected = false;
    this._closed = false;
    this._closing = false;
    this._connectPromise = null;
    this._closePromise = null;
    this._reconnectPromise = null;

    this._subscribed = false;
    this._buffered = [];
    this._eventChain = Promise.resolve();

    this._attempts = new Map();
    this._activeAttempt = null;
    this._turnToAttempt = new Map();
    this._finishedTurns = new Set();
    this._settledAttempts = new Set();
    this._seenEventIds = new Set();
    this._seenSeqs = new Set();
    this._historicalKeys = new Set();
    this._foreignKeys = new Set();
    this._usageKeys = new Set();
    this._snapshotMessages = [];

    this._highestSeq = 0;
    this._baselineSettled = false;
    this._baselineReady = null;
    this._baselineResolve = null;
    this._baselineWarning = null;

    this._pendingEvents = [];
    this._subscribers = new Set();

    this._requestTimeoutMs = numberOrNull(config.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this._resumeTimeoutMs = numberOrNull(config.resumeTimeoutMs) ?? DEFAULT_RESUME_TIMEOUT_MS;
    this._subscribeTimeoutMs = numberOrNull(config.subscribeTimeoutMs) ?? DEFAULT_SUBSCRIBE_TIMEOUT_MS;
    this._readTimeoutMs = numberOrNull(config.readTimeoutMs) ?? DEFAULT_READ_TIMEOUT_MS;
    this._closeTimeoutMs = numberOrNull(config.closeTimeoutMs) ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this._baselineTimeoutMs = numberOrNull(config.baselineTimeoutMs) ?? DEFAULT_BASELINE_TIMEOUT_MS;
    this._reconnectDelayMs = numberOrNull(config.reconnectDelayMs) ?? DEFAULT_RECONNECT_DELAY_MS;
    this._reconcileAttempts = Math.max(
      1,
      Math.floor(numberOrNull(config.reconcileAttempts) ?? DEFAULT_RECONCILE_ATTEMPTS),
    );
    this._reconcileRetryDelayMs = numberOrNull(config.reconcileRetryDelayMs)
      ?? DEFAULT_RECONCILE_RETRY_DELAY_MS;
    this._autoReconnect = config.autoReconnect !== false;
    this._expectedClientVersion = config.expectedClientVersion ?? ZCODE_KNOWN_CLI_VERSION;
    this._expectedProtocolVersion = config.expectedProtocolVersion ?? ZCODE_PROTOCOL_VERSION;
    this._runtimePreferences = normalizeRuntimePreferences(config.runtimePreferences);

    this._closedPromise = new Promise((resolve) => {
      this._resolveClosed = resolve;
    });
  }

  // ── Bridge v1 接口 ──────────────────────────────────────────────────────────

  /** 只读探测：仅 session/list 确认目标会话存在，汇报能力、身份与漂移警告。 */
  async probe(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    const sessionRef = cfg.nativeSessionRef ?? this._sessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError('SESSION_REQUIRED', 'probe() requires nativeSessionRef; this bridge never creates sessions.');
    }

    const { client, temporary } = await this._clientForProbe(cfg);
    let result;
    try {
      result = await this._call(client, 'session/list', {
        limit: numberOrNull(cfg.sessionLimit) ?? DEFAULT_SESSION_LIST_LIMIT,
      });
    } catch (error) {
      throw this._mapError(error, 'SESSION_LIST_FAILED');
    } finally {
      if (temporary) {
        await Promise.resolve().then(() => client.close()).catch(() => null);
      }
    }

    const sessions = Array.isArray(result)
      ? result
      : Array.isArray(result?.sessions)
        ? result.sessions
        : null;
    if (!sessions) {
      throw new BridgeError('SESSION_LIST_SHAPE_CHANGED', 'session/list did not return a sessions array.', {
        retryable: true,
        details: { resultType: typeof result },
      });
    }

    const summary = sessions.find((item) => item && item.sessionId === sessionRef);
    if (!summary) {
      throw new BridgeError('SESSION_NOT_FOUND', `ZCode session does not exist: ${sessionRef}`, {
        details: { sessionId: sessionRef },
      });
    }
    this._sessionSummary = summary;
    this._sessionRef = sessionRef;

    const warnings = [];
    const clientVersion = cfg.clientVersion
      ?? client.clientVersion
      ?? result?.version
      ?? result?.clientVersion
      ?? null;
    if (clientVersion === null || clientVersion === undefined) {
      warnings.push('zcode-client-version-unknown');
    } else if (String(clientVersion) !== String(this._expectedClientVersion)) {
      warnings.push('zcode-version-drift');
    }

    const protocolVersion = result?.protocolVersion
      ?? result?.protocol_version
      ?? client.protocolVersion
      ?? null;
    if (protocolVersion === null || protocolVersion === undefined) {
      warnings.push('zcode-protocol-version-unreported');
    } else if (Number(protocolVersion) !== Number(this._expectedProtocolVersion)) {
      warnings.push('zcode-protocol-version-drift');
    }

    if (client.envelopeShape && client.envelopeShape !== 'result') {
      warnings.push('zcode-protocol-envelope-drift');
    }
    if (!sessionRef.startsWith('sess_')) {
      warnings.push('zcode-session-id-shape-changed');
    }

    return {
      capabilities: normalizeCapabilities(ZCODE_CAPABILITIES),
      identity: this._buildIdentity(summary, sessionRef),
      clientVersion: clientVersion === null || clientVersion === undefined ? null : String(clientVersion),
      voiceMode: VOICE_MODES.EXTERNAL,
      warnings,
    };
  }

  /**
   * 连接既有会话：确认会话 → resume → subscribe(includeSnapshot) → 基线。
   * 不创建、不 fork、不归档、不改 modelSelection / thoughtLevel / mode。
   */
  async connect(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    const sessionRef = cfg.nativeSessionRef ?? this._sessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError('SESSION_REQUIRED', 'connect() requires nativeSessionRef; this bridge never creates sessions.');
    }
    if (this._connected) return;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      this._config = { ...cfg };
      const recovering = this._everConnected || this._runningAttempts().length > 0;
      this._connecting = true;
      this._baselineSettled = false;
      this._baselineWarning = null;
      this._baselineReady = new Promise((resolve) => {
        this._baselineResolve = resolve;
      });

      try {
        const client = await this._ensureClient(cfg, { recovering });
        this._client = client;
        this._attachClient(client);

        const summary = await this._fetchSession(client, sessionRef);
        this._sessionRef = sessionRef;
        this._sessionSummary = summary;

        const resume = await this._call(
          client,
          'session/resume',
          { sessionId: sessionRef },
          { timeoutMs: this._resumeTimeoutMs },
        );
        const openForeign = new Map();
        const resumeSnapshot = snapshotOf(resume);
        if (resumeSnapshot) {
          await this._seedSnapshot(resumeSnapshot, {
            recovery: true,
            openForeign,
            finalizeForeign: false,
          });
        }

        const afterSeq = this._highestSeq;
        const subscription = await this._call(client, 'session/subscribe', {
          sessionId: sessionRef,
          deliveryKind: 'desktop-continuous',
          afterSeq,
          includeSnapshot: true,
        }, { timeoutMs: this._subscribeTimeoutMs });

        const subscribeSnapshot = snapshotOf(subscription);
        if (subscribeSnapshot) {
          await this._seedSnapshot(subscribeSnapshot, {
            recovery: true,
            openForeign,
            finalizeForeign: true,
          });
        } else {
          this._finalizeOpenForeign(openForeign);
        }

        if (!this._baselineSettled) {
          // includeSnapshot 也可能以通知形式迟到；短暂等待，不让 connect 永久挂起。
          await this._waitForBaseline(this._baselineTimeoutMs);
          this._finalizeOpenForeign(openForeign);
        }

        this._subscribed = true;
        await this._flushBuffered();
        await this._eventChain;

        if (recovering) {
          await this._reconcileRecoveringAttempts();
        }

        if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'Bridge was closed while connecting.');
        this._connected = true;
        this._everConnected = true;
        this._resolveBaseline();
      } catch (error) {
        this._connected = false;
        this._subscribed = false;
        if (!this._closed) throw this._mapError(error, 'CONNECT_FAILED');
        throw error;
      } finally {
        this._connecting = false;
      }
    })();

    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /** 原生身份引用与版本；只含 session / workspace / model / mode / status 等元数据。 */
  async getIdentity() {
    this._assertOpen();
    const sessionRef = this._sessionRef ?? this._config.nativeSessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError('IDENTITY_UNAVAILABLE', 'No native session reference is available.');
    }
    const client = await this._ensureClient(this._config, { recovering: false });
    this._client = client;
    this._attachClient(client);
    try {
      const summary = await this._fetchSession(client, sessionRef);
      this._sessionSummary = summary;
      return this._buildIdentity(summary, sessionRef);
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'SESSION_NOT_FOUND') throw error;
      if (this._sessionSummary) return this._buildIdentity(this._sessionSummary, sessionRef);
      throw new BridgeError('IDENTITY_UNAVAILABLE', `Unable to read ZCode identity: ${redact(error?.message ?? error)}`, {
        retryable: true,
        details: { cause: redact(error?.message ?? error) },
      });
    }
  }

  async createNativeSession(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    const client = await this._ensureClient(cfg, { recovering: false });
    this._client = client;
    this._attachClient(client);
    const summary = await this._fetchSession(client, this._sessionRef);
    const workspace = summary.workspace ?? (cfg.cwd ? { workspacePath: cfg.cwd } : null);
    if (!workspace || typeof workspace !== 'object') {
      throw new BridgeError('CWD_REQUIRED', '创建 ZCode 会话需要沿用当前会话的 workspace。');
    }
    this._creatingNativeSession = true;
    let result;
    try {
      result = await this._call(client, 'session/create', {
        workspace,
        persistence: 'immediate',
        ...(this._nativeModel.reasoningEffort ? { model: this._nativeModel.selection } : {}),
        ...(this._nativeModel.reasoningEffort ? { thoughtLevel: this._nativeModel.reasoningEffort } : {}),
      });
    } finally {
      this._creatingNativeSession = false;
    }
    const nativeSessionRef = result?.sessionId
      ?? result?.session_id
      ?? result?.id
      ?? result?.session?.sessionId
      ?? result?.session?.id
      ?? null;
    if (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0) {
      throw new BridgeError('SESSION_CREATE_FAILED', 'ZCode session/create 的响应缺少 sessionId。');
    }
    await this._fetchSession(client, nativeSessionRef);
    return { nativeSessionRef };
  }

  async adoptNativeSession(nativeSessionRef) {
    this._assertOpen();
    if (this._runningAttempts().length > 0) {
      throw new BridgeError('BRIDGE_BUSY', '当前回合结束后才能切换 ZCode 会话。');
    }
    const client = await this._ensureClient(this._config, { recovering: false });
    this._client = client;
    this._attachClient(client);
    const summary = await this._fetchSession(client, nativeSessionRef);
    this._sessionRef = nativeSessionRef;
    this._sessionSummary = summary;
    this._attempts.clear();
    this._activeAttempt = null;
    this._turnToAttempt.clear();
    this._finishedTurns.clear();
    this._settledAttempts.clear();
    this._seenEventIds.clear();
    this._seenSeqs.clear();
    this._historicalKeys.clear();
    this._foreignKeys.clear();
    this._usageKeys.clear();
    this._snapshotMessages = [];
    this._buffered = [];
    this._highestSeq = 0;
    this._baselineSettled = false;
    this._baselineWarning = null;
    this._baselineReady = new Promise((resolve) => {
      this._baselineResolve = resolve;
    });
    this._nativeModel = { model: null, provider: null };
    this._eventChain = Promise.resolve();

    const resume = await this._call(client, 'session/resume', { sessionId: nativeSessionRef });
    const resumeSnapshot = snapshotOf(resume);
    if (resumeSnapshot) {
      await this._seedSnapshot(resumeSnapshot, {
        recovery: true,
        openForeign: new Map(),
        finalizeForeign: false,
      });
    }
    const subscription = await this._call(client, 'session/subscribe', {
      sessionId: nativeSessionRef,
      deliveryKind: 'desktop-continuous',
      afterSeq: this._highestSeq,
      includeSnapshot: true,
    });
    const subscribeSnapshot = snapshotOf(subscription);
    if (subscribeSnapshot) {
      await this._seedSnapshot(subscribeSnapshot, {
        recovery: true,
        openForeign: new Map(),
        finalizeForeign: true,
      });
    }
    this._connected = true;
    this._subscribed = true;
    this._resolveBaseline();
    return this.getIdentity();
  }

  /** 先登记 attempt，再 session/send；inputId=attemptId，accepted 只是回执。 */
  async send(packet) {
    this._assertOpen();
    if (!this._connected && this._connectPromise) await this._connectPromise;
    this._assertOpen();
    if (!this._connected) {
      throw new BridgeError('BRIDGE_NOT_CONNECTED', 'connect() must be called before send().');
    }
    assertContextPacket(packet);
    if (packet.seatId !== this._config.seatId) {
      throw new BridgeError('CONTEXT_SEAT_MISMATCH', 'Context packet seatId does not match this bridge.', {
        details: { expected: this._config.seatId, actual: packet.seatId },
      });
    }
    if (this._attempts.has(packet.attemptId)) {
      throw new BridgeError('ATTEMPT_ID_REUSED', `Attempt already exists: ${packet.attemptId}`, {
        details: { attemptId: packet.attemptId },
      });
    }
    if (this._activeAttempt) {
      throw new BridgeError('BRIDGE_BUSY', 'Seat already has an active attempt.', {
        retryable: true,
        details: { attemptId: this._activeAttempt.attemptId },
      });
    }

    const attempt = {
      attemptId: packet.attemptId,
      seatId: packet.seatId,
      status: 'running',
      inputId: packet.attemptId,
      turnId: null,
      nativeTurnRef: null,
      nativeMessageRef: null,
      startedEmitted: false,
      baselineSeq: this._highestSeq,
      deltaParts: new Map(),
      unsequencedDeltas: [],
      upsertText: null,
      packet: { ...packet },
      cancelReceipt: null,
      cancelPromise: null,
      settlePromise: null,
    };

    // 必须先登记：turn.started 可能早于 session/send 的响应到达。
    this._attempts.set(attempt.attemptId, attempt);
    this._activeAttempt = attempt;

    let result;
    try {
      result = await this._call(this._client, 'session/send', {
        sessionId: this._sessionRef,
        inputId: attempt.attemptId,
        content: packet.text,
      });
    } catch (error) {
      this._abandonAttempt(attempt);
      throw this._mapError(error, 'SEND_FAILED');
    }

    if (result?.accepted === false || result?.ok === false) {
      const mapped = new BridgeError('PROMPT_NOT_ACCEPTED', 'ZCode did not accept session/send.', {
        retryable: true,
        details: { attemptId: attempt.attemptId },
      });
      this._abandonAttempt(attempt);
      throw mapped;
    }

    const receipt = { attemptId: attempt.attemptId, accepted: true };
    const requestRef = stringOf(result?.requestId ?? result?.inputId ?? result?.messageId);
    if (requestRef) receipt.nativeRequestRef = requestRef;
    return receipt;
  }

  subscribe() {
    const initial = this._pendingEvents;
    this._pendingEvents = [];
    const subscriber = { queue: initial, wake: null, closed: this._closed };
    if (!this._closed) this._subscribers.add(subscriber);
    const iterator = this._iterate(subscriber);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => iterator.next(),
      return: (value) => {
        subscriber.closed = true;
        this._subscribers.delete(subscriber);
        const wake = subscriber.wake;
        subscriber.wake = null;
        wake?.();
        return iterator.return(value);
      },
      throw: (error) => iterator.throw(error),
    };
  }

  /** 幂等取消：只 session/stop，无 queueClear；最终由 turn.completed(cancelled) 确认。 */
  async cancel(attemptId) {
    this._assertOpen();
    const attempt = this._attempts.get(attemptId);
    if (!attempt) {
      return {
        attemptId,
        accepted: false,
        settlement: 'failed',
        error: { code: 'ATTEMPT_NOT_FOUND', message: `Unknown attempt: ${attemptId}`, retryable: false },
      };
    }
    if (attempt.status === 'aborted') return this._abortedReceipt(attempt);
    if (attempt.status !== 'running') {
      return {
        attemptId,
        accepted: false,
        settlement: 'failed',
        ...(attempt.nativeTurnRef ? { nativeTurnRef: attempt.nativeTurnRef } : {}),
        error: {
          code: 'ATTEMPT_ALREADY_FINISHED',
          message: `Attempt is already ${attempt.status}.`,
          retryable: false,
        },
      };
    }
    if (attempt.cancelReceipt) return clone(attempt.cancelReceipt);
    if (attempt.cancelPromise) return attempt.cancelPromise;

    attempt.cancelPromise = this._performCancel(attempt);
    try {
      const receipt = await attempt.cancelPromise;
      if (attempt.status === 'running') attempt.cancelReceipt = receipt;
      return clone(receipt);
    } finally {
      attempt.cancelPromise = null;
    }
  }

  async setMuted() {
    return unsupportedCapability('voiceMute');
  }

  /** 幂等关闭：退订并结束本次 app-server，等待子进程退出；不关闭/删除原生会话。 */
  async close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._closing = true;
    this._connected = false;
    this._subscribed = false;
    this._resolveClosed();
    this._baselineResolve?.();

    const client = this._client;

    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_CLOSED, null, { reason: 'closed' });
    for (const subscriber of this._subscribers) {
      subscriber.closed = true;
      const wake = subscriber.wake;
      subscriber.wake = null;
      wake?.();
    }
    this._subscribers.clear();

    this._closePromise = (async () => {
      const reconnect = this._reconnectPromise;
      if (reconnect) {
        await Promise.race([
          Promise.resolve(reconnect).catch(() => null),
          this._delay(this._closeTimeoutMs),
        ]);
      }
      // ZCode 协议没有 session/unsubscribe：结束本次 app-server 就是退订。
      if (client && typeof client.close === 'function') {
        await Promise.race([
          Promise.resolve().then(() => client.close()).catch(() => null),
          this._delay(this._closeTimeoutMs + 3000),
        ]);
      }
      this._closing = false;
    })();
    return this._closePromise;
  }

  // ── 公开只读状态（测试 / 诊断用） ──────────────────────────────────────────

  inspect() {
    return {
      seatId: this._config.seatId ?? null,
      connected: this._connected,
      connecting: this._connecting,
      closed: this._closed,
      sessionRef: this._sessionRef,
      subscribed: this._subscribed,
      activeAttemptId: this._activeAttempt?.attemptId ?? null,
      attemptCount: this._attempts.size,
      settledAttemptCount: this._settledAttempts.size,
      highestSeq: this._highestSeq,
      baselineSettled: this._baselineSettled,
      baselineWarning: this._baselineWarning,
      pendingEventCount: this._pendingEvents.length,
      subscriberCount: this._subscribers.size,
      bufferedCount: this._buffered.length,
      turnMapSize: this._turnToAttempt.size,
      clientStarted: Boolean(this._client?.started),
      clientDead: Boolean(this._client?.dead),
      reconnectRunning: this._reconnectPromise !== null,
    };
  }

  // ── 通知、事件与去重 ────────────────────────────────────────────────────────

  _attachClient(client) {
    if (!client) return;
    client.onNotification = (message) => this._onNotification(message);
    client.onServerRequest = (message) => this._onServerRequest(message);
    client.onExit = (info) => this._onClientExit(client, info);
  }

  /**
   * app-server → client 的主动请求。
   * session/resume 期间它会请求运行时偏好；只返回 ACP 运行时偏好，
   * 不含 workspace / modelSelection / thoughtLevel / mode。
   */
  _onServerRequest(message) {
    if (!message || typeof message.method !== 'string') return null;
    if (message.method === 'session/requestRuntimePreferences') {
      const params = message.params && typeof message.params === 'object' ? message.params : {};
      if (params.sessionId && this._sessionRef && params.sessionId !== this._sessionRef
        && !this._creatingNativeSession) {
        return {
          error: {
            code: -32602,
            message: 'session/requestRuntimePreferences sessionId does not match this bridge.',
          },
        };
      }
      return { result: clone(this._runtimePreferences) };
    }
    return null;
  }

  _onNotification(message) {
    if (this._closed || !message || typeof message.method !== 'string') return;
    const params = message.params && typeof message.params === 'object' ? message.params : {};

    if (message.method === 'session/event') {
      const event = unwrapEvent(params.event ?? params);
      if (!event) return;
      if (event.sessionId && event.sessionId !== this._sessionRef) return;
      if (!this._subscribed) {
        this._buffered.push({ event, options: { recovery: false } });
        return;
      }
      this._enqueue(event, { recovery: false });
      return;
    }

    if (message.method === 'session/snapshot') {
      const snapshot = normalizeSnapshot(params.snapshot ?? params);
      if (!this._subscribed) {
        this._buffered.push({ snapshot, options: { recovery: false } });
        return;
      }
      void this._enqueueSnapshot(snapshot);
      return;
    }

    if (message.method === 'session/usage') {
      this._emitUsage(params.usage ?? params, {});
    }
  }

  async _flushBuffered() {
    const buffered = this._buffered.splice(0);
    const pending = [];
    for (const item of buffered) {
      if (item.event) pending.push(this._enqueue(item.event, { recovery: false }));
      else if (item.snapshot) pending.push(this._enqueueSnapshot(item.snapshot));
    }
    if (pending.length > 0) await Promise.allSettled(pending);
  }

  async _enqueueSnapshot(snapshot) {
    if (!snapshot) return;
    const openForeign = new Map();
    await this._seedSnapshot(snapshot, { recovery: true, openForeign, finalizeForeign: true });
  }

  _enqueue(event, options) {
    this._eventChain = this._eventChain
      .then(() => this._handleEvent(event, options))
      .catch((error) => {
        this._emitBridgeError({
          code: 'EVENT_HANDLING_FAILED',
          message: redact(error?.message ?? error),
          retryable: false,
        });
      });
    return this._eventChain;
  }

  async _handleEvent(event, { recovery = false, openForeign = null } = {}) {
    if (this._closed || !event || typeof event.type !== 'string') return;
    if (event.sessionId && event.sessionId !== this._sessionRef) return;
    if (this._isDuplicate(event)) return;
    this._markSeen(event);

    const payload = event.payload ?? {};
    if (TURN_STARTED_TYPES.has(event.type)) {
      this._onTurnStarted(payload, { recovery, openForeign });
      return;
    }
    if (PART_DELTA_TYPES.has(event.type)) {
      this._onPartDelta(payload);
      return;
    }
    if (MESSAGE_UPSERT_TYPES.has(event.type)) {
      this._onMessageUpserted(payload);
      return;
    }
    if (TURN_COMPLETED_TYPES.has(event.type)) {
      await this._onTurnCompleted(payload, { recovery, openForeign });
      return;
    }
    if (TURN_FAILED_TYPES.has(event.type)) {
      this._onTurnFailed(payload, { recovery, openForeign });
    }
  }

  _isDuplicate(event) {
    if (event.eventId && this._seenEventIds.has(event.eventId)) return true;
    if (event.seq !== null && this._seenSeqs.has(event.seq)) return true;
    return false;
  }

  _markSeen(event) {
    if (event.eventId) this._seenEventIds.add(event.eventId);
    if (event.seq !== null) {
      this._seenSeqs.add(event.seq);
      if (event.seq > this._highestSeq) this._highestSeq = event.seq;
    }
  }

  _resolveAttempt(payload) {
    const inputId = stringOf(payload?.inputId ?? payload?.input_id);
    if (inputId && this._attempts.has(inputId)) return this._attempts.get(inputId);
    const turnId = stringOf(payload?.turnId ?? payload?.turn_id);
    if (turnId && this._turnToAttempt.has(turnKey(turnId))) {
      return this._turnToAttempt.get(turnKey(turnId));
    }
    return null;
  }

  _onTurnStarted(payload, { recovery, openForeign }) {
    const inputId = stringOf(payload?.inputId ?? payload?.input_id);
    const turnId = stringOf(payload?.turnId ?? payload?.turn_id);
    const attempt = this._resolveAttempt({ inputId, turnId });

    if (attempt) {
      if (attempt.status !== 'running') return;
      this._bindAttempt(attempt, { turnId, inputId });
      return;
    }

    if (recovery) {
      if (openForeign && (inputId || turnId)) {
        openForeign.set(inputId ?? turnId, { inputId, turnId });
      } else {
        this._markHistorical(inputId, turnId);
      }
      return;
    }

    this._emitForeign({ inputId, turnId, reason: 'no-pending-attempt' });
  }

  _onPartDelta(payload) {
    const attempt = this._resolveAttempt(payload);
    if (!attempt || attempt.status !== 'running') return;
    if (payload.field && payload.field !== 'text') return;
    if (payload.messageId) attempt.nativeMessageRef = stringOf(payload.messageId);
    const text = typeof payload.delta === 'string' ? payload.delta : textOf(payload.delta ?? payload.text);
    if (!text) return;
    const offset = numberOrNull(payload.offset ?? payload.index);
    if (offset !== null) {
      if (!attempt.deltaParts.has(offset)) attempt.deltaParts.set(offset, text);
    } else {
      attempt.unsequencedDeltas.push(text);
    }
  }

  _onMessageUpserted(payload) {
    const attempt = this._resolveAttempt(payload);
    if (!attempt || attempt.status !== 'running') return;
    const messageId = stringOf(payload.messageId ?? payload.message_id);
    if (messageId) attempt.nativeMessageRef = messageId;
    const text = textOf(payload);
    // 只作为 partial 参考，绝不当作最终正文。
    if (hasText(text)) attempt.upsertText = text;
  }

  async _onTurnCompleted(payload, { recovery, openForeign }) {
    const inputId = stringOf(payload?.inputId ?? payload?.input_id);
    const turnId = stringOf(payload?.turnId ?? payload?.turn_id);
    const attempt = this._resolveAttempt({ inputId, turnId });

    if (!attempt) {
      if (recovery) {
        this._removeOpenForeign(openForeign, inputId, turnId);
        this._markHistorical(inputId, turnId);
      }
      return;
    }
    if (attempt.status !== 'running') return;

    this._bindAttempt(attempt, { turnId, inputId });
    if (payload.usage) {
      this._emitUsage(payload.usage, { nativeTurnRef: attempt.nativeTurnRef });
    }

    const resultType = resultTypeOf(payload);
    if (resultType === 'success') {
      let text = responseTextOf(payload);
      let messageRef = stringOf(payload.messageId ?? payload.message_id) ?? attempt.nativeMessageRef;

      if (!hasText(text)) {
        const reconciled = await this._reconcileAttemptText(attempt);
        if (hasText(reconciled.text)) {
          text = reconciled.text;
          messageRef = reconciled.messageId ?? messageRef;
        } else {
          if (attempt.status !== 'running') return;
          this._settledAttempts.add(attempt.attemptId);
          this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, {
            error: {
              code: 'FINAL_TEXT_UNAVAILABLE',
              message: 'ZCode reported success but no final text was available from snapshot/events/messages.',
              retryable: true,
              details: {
                attempts: reconciled.attempts,
                readErrors: reconciled.errors,
              },
            },
            nativeTurnRef: attempt.nativeTurnRef,
          });
          this._finishAttempt(attempt, 'failed');
          return;
        }
      }

      if (attempt.status !== 'running') return;
      this._settledAttempts.add(attempt.attemptId);
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_COMPLETED, attempt.attemptId, {
        nativeTurnRef: attempt.nativeTurnRef,
        nativeMessageRef: messageRef ?? `${attempt.nativeTurnRef}:message`,
        text,
      });
      this._finishAttempt(attempt, 'completed');
      return;
    }

    if (resultType === 'cancelled' || resultType === 'canceled') {
      const partialText = this._partialText(attempt) || responseTextOf(payload) || '';
      if (attempt.status !== 'running') return;
      this._settledAttempts.add(attempt.attemptId);
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_ABORTED, attempt.attemptId, {
        nativeTurnRef: attempt.nativeTurnRef,
        partialText,
      });
      this._finishAttempt(attempt, 'aborted');
      return;
    }

    if (attempt.status !== 'running') return;
    this._settledAttempts.add(attempt.attemptId);
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, {
      error: normalizeError(payload.error, 'TURN_RESULT_UNEXPECTED'),
      nativeTurnRef: attempt.nativeTurnRef,
    });
    this._finishAttempt(attempt, 'failed');
  }

  _onTurnFailed(payload, { recovery, openForeign }) {
    const inputId = stringOf(payload?.inputId ?? payload?.input_id);
    const turnId = stringOf(payload?.turnId ?? payload?.turn_id);
    const attempt = this._resolveAttempt({ inputId, turnId });

    if (!attempt) {
      if (recovery) {
        this._removeOpenForeign(openForeign, inputId, turnId);
        this._markHistorical(inputId, turnId);
      }
      return;
    }
    if (attempt.status !== 'running') return;

    this._bindAttempt(attempt, { turnId, inputId });
    if (payload.usage) {
      this._emitUsage(payload.usage, { nativeTurnRef: attempt.nativeTurnRef });
    }
    this._settledAttempts.add(attempt.attemptId);
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, {
      error: normalizeError(payload.error, 'TURN_FAILED'),
      nativeTurnRef: attempt.nativeTurnRef,
    });
    this._finishAttempt(attempt, 'failed');
  }

  _bindAttempt(attempt, { turnId, inputId }) {
    if (attempt.status !== 'running') return false;
    if (turnId) {
      if (attempt.turnId && attempt.turnId !== turnId) return false;
      attempt.turnId = turnId;
      attempt.nativeTurnRef = nativeTurnRefFor(this._sessionRef, turnId);
      this._turnToAttempt.set(turnKey(turnId), attempt);
    }
    if (!attempt.nativeTurnRef) {
      attempt.nativeTurnRef = nativeTurnRefFor(this._sessionRef, turnId ?? inputId ?? attempt.attemptId);
    }
    if (!attempt.startedEmitted) {
      attempt.startedEmitted = true;
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_STARTED, attempt.attemptId, {
        nativeTurnRef: attempt.nativeTurnRef,
      });
    }
    return true;
  }

  _partialText(attempt) {
    const chunks = [];
    const offsets = [...attempt.deltaParts.keys()].sort((a, b) => a - b);
    for (const offset of offsets) chunks.push(attempt.deltaParts.get(offset));
    chunks.push(...attempt.unsequencedDeltas);
    let text = chunks.join('');
    if (!text && attempt.upsertText) text = attempt.upsertText;
    return text;
  }

  _finishAttempt(attempt, status) {
    attempt.status = status;
    attempt.endedAt = new Date().toISOString();
    if (this._activeAttempt === attempt) this._activeAttempt = null;
    if (attempt.turnId) {
      this._finishedTurns.add(turnKey(attempt.turnId));
      if (this._turnToAttempt.get(turnKey(attempt.turnId)) === attempt) {
        this._turnToAttempt.delete(turnKey(attempt.turnId));
      }
    }
  }

  _abandonAttempt(attempt) {
    attempt.status = 'failed';
    if (this._activeAttempt === attempt) this._activeAttempt = null;
  }

  _runningAttempts() {
    return [...this._attempts.values()].filter((attempt) => attempt.status === 'running');
  }

  // ── 快照与断线恢复 ──────────────────────────────────────────────────────────

  async _seedSnapshot(snapshot, { recovery, openForeign, finalizeForeign }) {
    if (!snapshot) return;
    if (snapshot.seq > this._highestSeq) this._highestSeq = snapshot.seq;
    for (const message of snapshot.messages.slice(-20)) {
      const model = modelInfoOfMessage(message);
      if (model?.reasoningEffort || !this._nativeModel.selection) this._nativeModel = model;
    }
    const context = { recovery: true, openForeign };
    for (const event of snapshot.events) {
      await this._enqueue(event, context);
    }
    for (const message of snapshot.messages) {
      this._rememberSnapshotMessage(message);
    }
    if (snapshot.usage) this._emitUsage(snapshot.usage, {});
    if (finalizeForeign) this._finalizeOpenForeign(openForeign);
    this._resolveBaseline();
  }

  _finalizeOpenForeign(openForeign) {
    if (!openForeign) return;
    for (const entry of openForeign.values()) {
      if (this._historicalKeys.has(`input:${entry.inputId}`) || this._historicalKeys.has(`turn:${entry.turnId}`)) {
        continue;
      }
      this._emitForeign({
        inputId: entry.inputId,
        turnId: entry.turnId,
        reason: 'foreign-turn-open',
      });
    }
    openForeign.clear();
  }

  _removeOpenForeign(openForeign, inputId, turnId) {
    if (!openForeign) return;
    if (inputId) openForeign.delete(inputId);
    if (turnId) openForeign.delete(turnId);
  }

  _rememberSnapshotMessage(message) {
    if (!message) return;
    const key = message.messageId ?? `seq:${message.seq ?? this._snapshotMessages.length}`;
    if (!this._snapshotMessages.some((item) => (item.messageId ?? `seq:${item.seq}`) === key)) {
      this._snapshotMessages.push(message);
      if (this._snapshotMessages.length > 1000) this._snapshotMessages.shift();
    }

    const attempt = this._resolveAttempt({ inputId: message.inputId, turnId: message.turnId });
    if (attempt) {
      if (message.messageId && message.role !== 'user') attempt.nativeMessageRef = message.messageId;
      return;
    }
    if (message.inputId) this._historicalKeys.add(`input:${message.inputId}`);
    if (message.turnId) this._historicalKeys.add(`turn:${message.turnId}`);
  }

  async _reconcileRecoveringAttempts() {
    const running = this._runningAttempts();
    if (running.length === 0) return;

    const afterSeq = Math.max(
      0,
      Math.min(...running.map((attempt) => attempt.baselineSeq ?? 0)),
    );

    const [eventsResult, messagesResult] = await Promise.allSettled([
      this._call(
        this._client,
        'session/events',
        { sessionId: this._sessionRef, afterSeq },
        { timeoutMs: this._readTimeoutMs },
      ),
      this._call(
        this._client,
        'session/messages',
        { sessionId: this._sessionRef, limit: 200 },
        { timeoutMs: this._readTimeoutMs },
      ),
    ]);

    if (eventsResult.status === 'fulfilled') {
      const openForeign = new Map();
      for (const event of collectEvents(eventsResult.value)) {
        await this._enqueue(event, { recovery: true, openForeign });
      }
      await this._eventChain;
      this._finalizeOpenForeign(openForeign);
    } else if (!this._closed) {
      this._emitBridgeError({
        code: 'RECOVERY_EVENTS_FAILED',
        message: redact(eventsResult.reason?.message ?? eventsResult.reason),
        retryable: true,
      });
    }

    if (messagesResult.status === 'fulfilled') {
      for (const message of collectMessages(messagesResult.value)) {
        this._rememberSnapshotMessage(message);
      }
    } else if (!this._closed) {
      this._emitBridgeError({
        code: 'RECOVERY_MESSAGES_FAILED',
        message: redact(messagesResult.reason?.message ?? messagesResult.reason),
        retryable: true,
      });
    }
  }

  async _reconcileAttemptText(attempt) {
    const snapshotMatch = this._findAssistantMessage(this._snapshotMessages, attempt);
    if (snapshotMatch) {
      return { text: snapshotMatch.text, messageId: snapshotMatch.messageId, errors: [], attempts: 0 };
    }

    const errors = [];
    let attempts = 0;
    for (let index = 0; index < this._reconcileAttempts; index += 1) {
      if (this._closed || attempt.status !== 'running') break;
      attempts += 1;
      const afterSeq = attempt.baselineSeq ?? 0;
      const results = await Promise.allSettled([
        this._call(
          this._client,
          'session/events',
          {
            sessionId: this._sessionRef,
            afterSeq,
          },
          { timeoutMs: this._readTimeoutMs },
        ),
        this._call(
          this._client,
          'session/messages',
          {
            sessionId: this._sessionRef,
            limit: 200,
          },
          { timeoutMs: this._readTimeoutMs },
        ),
      ]);

      if (results[0].status === 'fulfilled') {
        const events = collectEvents(results[0].value);
        for (const event of events) {
          if (!TURN_COMPLETED_TYPES.has(event.type)) continue;
          const eventInput = stringOf(event.payload?.inputId ?? event.payload?.input_id);
          const eventTurn = stringOf(event.payload?.turnId ?? event.payload?.turn_id);
          const matches = (eventInput && eventInput === attempt.inputId)
            || (attempt.turnId && eventTurn && eventTurn === attempt.turnId);
          if (!matches) continue;
          const text = responseTextOf(event.payload);
          if (hasText(text)) {
            return {
              text,
              messageId: stringOf(event.payload?.messageId ?? event.payload?.message_id) ?? attempt.nativeMessageRef,
              errors,
              attempts,
            };
          }
        }
      } else {
        errors.push({
          source: 'events',
          code: eventsErrorCode(results[0].reason),
          message: redact(results[0].reason?.message ?? results[0].reason),
          retryable: results[0].reason?.retryable === true,
        });
      }

      if (results[1].status === 'fulfilled') {
        const messages = collectMessages(results[1].value);
        const match = this._findAssistantMessage(messages, attempt);
        if (match) {
          return { text: match.text, messageId: match.messageId, errors, attempts };
        }
      } else {
        errors.push({
          source: 'messages',
          code: results[1].reason?.code ?? 'MESSAGES_READ_FAILED',
          message: redact(results[1].reason?.message ?? results[1].reason),
          retryable: results[1].reason?.retryable === true,
        });
      }

      if (index + 1 < this._reconcileAttempts) {
        await this._delay(this._reconcileRetryDelayMs);
      }
    }

    return { text: null, messageId: null, errors, attempts };
  }

  _findAssistantMessage(messages, attempt) {
    let match = null;
    for (const message of messages) {
      if (!message || !hasText(message.text)) continue;
      if (message.role === 'user' || message.role === 'human') continue;
      const matches = (message.inputId && message.inputId === attempt.inputId)
        || (attempt.turnId && message.turnId && message.turnId === attempt.turnId);
      if (!matches) continue;
      if (!match || (message.seq ?? 0) >= (match.seq ?? 0)) match = message;
    }
    return match;
  }

  // ── 取消 ───────────────────────────────────────────────────────────────────

  async _performCancel(attempt) {
    let result = null;
    let error = null;
    try {
      result = await this._call(this._client, 'session/stop', { sessionId: this._sessionRef });
    } catch (failure) {
      error = failure;
    }

    if (attempt.status === 'aborted') return this._abortedReceipt(attempt);
    if (attempt.status !== 'running') {
      return {
        attemptId: attempt.attemptId,
        accepted: false,
        settlement: 'failed',
        ...(attempt.nativeTurnRef ? { nativeTurnRef: attempt.nativeTurnRef } : {}),
        error: {
          code: 'ATTEMPT_ALREADY_FINISHED',
          message: `Attempt is already ${attempt.status}.`,
          retryable: false,
        },
      };
    }

    if (error || result?.stopped === false || result?.ok === false || result?.accepted === false) {
      const mapped = error ? this._mapError(error, 'CANCEL_FAILED') : null;
      return {
        attemptId: attempt.attemptId,
        accepted: false,
        settlement: 'failed',
        ...(attempt.nativeTurnRef ? { nativeTurnRef: attempt.nativeTurnRef } : {}),
        error: mapped
          ? { code: mapped.code, message: mapped.message, retryable: mapped.retryable }
          : {
              code: 'CANCEL_REJECTED',
              message: 'session/stop was rejected.',
              retryable: true,
            },
      };
    }

    const receipt = {
      attemptId: attempt.attemptId,
      accepted: true,
      settlement: 'pending',
    };
    if (attempt.nativeTurnRef) receipt.nativeTurnRef = attempt.nativeTurnRef;
    return receipt;
  }

  _abortedReceipt(attempt) {
    const receipt = {
      attemptId: attempt.attemptId,
      accepted: true,
      settlement: 'confirmed',
    };
    if (attempt.nativeTurnRef) receipt.nativeTurnRef = attempt.nativeTurnRef;
    return receipt;
  }

  // ── 发布 ───────────────────────────────────────────────────────────────────

  _emit(type, attemptId, payload) {
    if (this._closed && type !== BRIDGE_EVENT_TYPES.BRIDGE_CLOSED) return null;
    const event = createBridgeEvent({
      type,
      seatId: this._config.seatId,
      attemptId,
      payload,
    });
    if (this._subscribers.size === 0) {
      this._pendingEvents.push(event);
      return event;
    }
    for (const subscriber of this._subscribers) {
      subscriber.queue.push(event);
      const wake = subscriber.wake;
      subscriber.wake = null;
      wake?.();
    }
    return event;
  }

  _emitBridgeError(error) {
    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_ERROR, null, {
      error: {
        code: typeof error?.code === 'string' ? error.code : 'ZCODE_BRIDGE_ERROR',
        message: redact(error?.message ?? String(error)),
        retryable: error?.retryable === true,
      },
    });
  }

  _emitUsage(raw, { nativeTurnRef } = {}) {
    const usage = normalizeUsage(raw);
    if (!usage) return;
    const key = `${nativeTurnRef ?? ''}:${JSON.stringify(usage)}`;
    if (this._usageKeys.has(key)) return;
    this._usageKeys.add(key);
    const payload = { usage };
    if (nativeTurnRef) payload.nativeTurnRef = nativeTurnRef;
    this._emit(BRIDGE_EVENT_TYPES.USAGE_REPORTED, null, payload);
  }

  _emitForeign({ inputId, turnId, reason }) {
    const keys = [
      inputId ? `input:${inputId}` : null,
      turnId ? `turn:${turnId}` : null,
    ].filter(Boolean);
    if (keys.length === 0) return;
    if (keys.some((key) => this._foreignKeys.has(key) || this._historicalKeys.has(key))) return;
    for (const key of keys) this._foreignKeys.add(key);
    this._emit(BRIDGE_EVENT_TYPES.FOREIGN_TURN, null, {
      nativeTurnRef: nativeTurnRefFor(this._sessionRef, turnId ?? inputId),
      reason,
    });
  }

  _markHistorical(inputId, turnId) {
    if (inputId) this._historicalKeys.add(`input:${inputId}`);
    if (turnId) this._historicalKeys.add(`turn:${turnId}`);
  }

  async *_iterate(subscriber) {
    try {
      while (true) {
        while (subscriber.queue.length > 0) {
          yield subscriber.queue.shift();
        }
        if (subscriber.closed) return;
        await new Promise((resolve) => {
          subscriber.wake = resolve;
        });
      }
    } finally {
      this._subscribers.delete(subscriber);
      subscriber.closed = true;
      subscriber.wake = null;
    }
  }

  // ── 客户端、会话与错误映射 ─────────────────────────────────────────────────

  _createClient(config) {
    return new ZCodeAppServerClient({
      exe: config.exe ?? DEFAULT_ZCODE_EXE,
      cli: config.cli ?? DEFAULT_ZCODE_CLI,
      surface: config.surface ?? 'desktop',
      cwd: config.cwd,
      env: config.env,
      requestTimeoutMs: this._requestTimeoutMs,
      closeGraceMs: config.closeGraceMs ?? this._closeTimeoutMs,
      clientVersion: config.clientVersion ?? null,
      protocolVersion: config.protocolVersion ?? null,
    });
  }

  async _clientForProbe(cfg) {
    if (cfg.client) {
      const client = cfg.client;
      this._attachClient(client);
      if (!client.started && typeof client.start === 'function') await client.start();
      return { client, temporary: false };
    }
    if (this._client && !this._client.dead) {
      this._attachClient(this._client);
      return { client: this._client, temporary: false };
    }
    if (this._apiFactory) {
      const client = await this._apiFactory(cfg);
      if (!client) throw new BridgeError('CONFIG_INVALID', 'apiFactory returned no client.');
      this._client = client;
      this._attachClient(client);
      if (!client.started && typeof client.start === 'function') await client.start();
      return { client, temporary: false };
    }
    const client = this._createClient(cfg);
    this._attachClient(client);
    await client.start();
    return { client, temporary: true };
  }

  async _ensureClient(cfg, { recovering }) {
    if (cfg.client) {
      const client = cfg.client;
      this._attachClient(client);
      if (recovering && typeof client.restart === 'function') await client.restart();
      if (!client.started && typeof client.start === 'function') await client.start();
      return client;
    }

    if (this._apiFactory) {
      if (this._client && !this._client.dead && !recovering) {
        this._attachClient(this._client);
        if (!this._client.started && typeof this._client.start === 'function') await this._client.start();
        return this._client;
      }
      const client = await this._apiFactory(cfg);
      if (!client) throw new BridgeError('CONFIG_INVALID', 'apiFactory returned no client.');
      this._client = client;
      this._attachClient(client);
      if (!client.started && typeof client.start === 'function') await client.start();
      return client;
    }

    if (!this._client || this._client.dead || recovering) {
      this._client = this._createClient(cfg);
    }
    this._attachClient(this._client);
    if (!this._client.started) await this._client.start();
    return this._client;
  }

  async _fetchSession(client, sessionRef) {
    let result;
    try {
      result = await this._call(client, 'session/list', {
        limit: numberOrNull(this._config.sessionLimit) ?? DEFAULT_SESSION_LIST_LIMIT,
      });
    } catch (error) {
      throw this._mapError(error, 'SESSION_LIST_FAILED');
    }
    const sessions = Array.isArray(result)
      ? result
      : Array.isArray(result?.sessions)
        ? result.sessions
        : null;
    if (!sessions) {
      throw new BridgeError('SESSION_LIST_SHAPE_CHANGED', 'session/list did not return a sessions array.', {
        retryable: true,
      });
    }
    const summary = sessions.find((item) => item && item.sessionId === sessionRef);
    if (!summary) {
      throw new BridgeError('SESSION_NOT_FOUND', `ZCode session does not exist: ${sessionRef}`, {
        details: { sessionId: sessionRef },
      });
    }
    return summary;
  }

  async _call(client, method, params, options) {
    if (!client || typeof client.request !== 'function') {
      throw new BridgeError('CLIENT_INVALID', 'ZCode client is not available.', {
        details: { method },
      });
    }
    return client.request(method, params, {
      timeoutMs: this._requestTimeoutMs,
      ...(options ?? {}),
    });
  }

  _mapError(error, fallbackCode) {
    if (error instanceof BridgeError) return error;
    const rawCode = error?.code;
    let code = rawCode !== undefined && rawCode !== null && rawCode !== ''
      ? rawCode
      : fallbackCode;
    const nativeCode = typeof code === 'number' ? code : null;
    if (typeof code === 'number') {
      const known = {
        [-32601]: 'METHOD_NOT_FOUND',
        [-32602]: 'INVALID_PARAMS',
        [-32009]: 'REVISION_MISMATCH',
        [-32010]: 'SESSION_NOT_READY',
        [-32020]: 'CLIENT_NOT_ATTACHED',
        [-32021]: 'REQUEST_CANCELLED',
        [-32022]: 'REQUEST_TIMEOUT',
        [-32031]: 'SESSION_RESTORE_WARNING',
      };
      code = known[code] ?? `ZCODE_RPC_${Math.abs(code)}`;
    }
    const lower = String(code).toLowerCase();
    if (lower.includes('not_found') || lower.includes('not-found') || lower.includes('session_not_found')) {
      code = 'SESSION_NOT_FOUND';
    }
    return new BridgeError(String(code), redact(error?.message ?? String(error)), {
      retryable: error?.retryable === true
        || code === 'SESSION_NOT_FOUND'
        || code === 'REQUEST_TIMEOUT'
        || code === 'SESSION_NOT_READY',
      details: {
        method: error?.method ?? null,
        nativeCode,
        ...(error?.details && typeof error.details === 'object' ? { cause: error.details } : {}),
      },
    });
  }

  _buildIdentity(summary, sessionRef) {
    const workspace = summary?.workspace?.workspacePath
      ?? summary?.workspace?.workspaceKey
      ?? summary?.workspacePath
      ?? (typeof summary?.workspace === 'string' ? summary.workspace : null);
    const rawModel = summary?.model
      ?? summary?.modelSelection?.model
      ?? summary?.model_selection?.model
      ?? null;
    const model = typeof rawModel === 'string'
      ? rawModel
      : rawModel?.modelId ?? this._nativeModel.model;
    const provider = rawModel?.providerId ?? this._nativeModel.provider;
    const metadata = {
      sessionId: sessionRef,
      name: typeof summary?.title === 'string' ? summary.title : null,
      workspace: workspace === undefined ? null : workspace,
      model,
      ...(provider ? { provider } : {}),
      mode: summary?.mode ?? null,
      status: summary?.status ?? null,
      sessionKind: summary?.sessionKind ?? null,
      updatedAt: summary?.updatedAt ?? null,
    };
    for (const key of Object.keys(metadata)) {
      if (metadata[key] === undefined) delete metadata[key];
    }

    const revision = createHash('sha256')
      .update(JSON.stringify([
        sessionRef,
        metadata.workspace,
        metadata.model,
        metadata.mode,
        metadata.status,
        metadata.updatedAt,
      ]))
      .digest('hex')
      .slice(0, 16);

    return {
      sourceRef: `${sessionRef}#identity`,
      revision,
      nativeSessionRef: sessionRef,
      metadata,
    };
  }

  // ── 连接生命周期 ───────────────────────────────────────────────────────────

  _onClientExit(client, info) {
    if (this._closed || this._closing) return;
    if (client !== this._client) return;
    const wasConnected = this._connected;
    this._connected = false;
    this._subscribed = false;
    this._emitBridgeError({
      code: 'STREAM_DISCONNECTED',
      message: `ZCode app-server exited (code=${info?.code ?? '-'}); reconnecting from snapshot.`,
      retryable: true,
    });
    if (wasConnected && this._autoReconnect) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectPromise || this._closed || !this._autoReconnect) return;
    this._reconnectPromise = (async () => {
      while (!this._closed) {
        await this._sleep(this._reconnectDelayMs);
        if (this._closed) break;
        try {
          await this.connect();
          return;
        } catch (error) {
          if (this._closed) break;
          this._emitBridgeError(this._mapError(error, 'RECONNECT_FAILED'));
        }
      }
    })().finally(() => {
      this._reconnectPromise = null;
    });
  }

  _resolveBaseline() {
    if (this._baselineSettled) return;
    this._baselineSettled = true;
    this._baselineResolve?.();
  }

  async _waitForBaseline(timeoutMs) {
    if (this._baselineSettled) return;
    let timer;
    await Promise.race([
      this._baselineReady,
      new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(1, timeoutMs));
        timer.unref?.();
      }),
    ]);
    clearTimeout(timer);
    if (!this._baselineSettled) {
      this._baselineWarning = 'baseline-not-observed';
      this._resolveBaseline();
    }
  }

  _mergedConfig(config) {
    return { ...this._config, ...config };
  }

  _requireSeat(config) {
    if (typeof config?.seatId !== 'string' || config.seatId.length === 0) {
      throw new BridgeError('CONFIG_INVALID', 'ZCodeBridge requires a non-empty seatId.');
    }
  }

  _assertOpen() {
    if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'Bridge is closed.');
  }

  _delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      timer.unref?.();
    });
  }

  async _sleep(ms) {
    if (this._closed || ms <= 0) return;
    await Promise.race([
      this._delay(ms),
      this._closedPromise,
    ]);
  }
}

function eventsErrorCode(error) {
  return typeof error?.code === 'string' ? error.code : 'EVENTS_READ_FAILED';
}

export function createZCodeBridge(config) {
  return new ZCodeBridge(config);
}
