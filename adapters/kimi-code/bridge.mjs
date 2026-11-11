// Kimi Code Web Bridge v1。
//
// 只走本机 `kimi web` 的 REST + WebSocket：
// - probe 只读：先用 REST 确认会话存在，再读 meta / OpenAPI / AsyncAPI；
//   绝不创建、fork、takeover、归档会话，也不产生模型调用；
// - connect 只连接既有会话，先建立 snapshot/transcript 基线，再 subscribe；
// - send 先登记 pending attempt，再 POST prompts，prompt_id = attemptId；
//   accepted 只是投递回执，正文与终态全部由事件和 messages/transcript 对账确认；
// - 最终正文不依赖 volatile delta：turn.ended 后按 prompt_id 对账；
// - 断线后按 snapshot 的 as_of_seq / epoch / in_flight_turn 与 transcript_since 恢复，
//   断线窗口完成的 prompt 恰好结算一次，历史 foreign 不重放；
// - cancel 幂等：先清 queued prompt，再 session :abort，最终由 turn.ended 确认；
// - close 只释放 WS / 泵，不关闭 kimi web，不归档会话。

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
  KIMI_DEFAULT_BASE_URL,
  KimiCodeClient,
  resolveToken,
} from './client.mjs';

export { KIMI_DEFAULT_BASE_URL };
export const DEFAULT_BASE_URL = KIMI_DEFAULT_BASE_URL;

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_RECONCILE_ATTEMPTS = 3;
const DEFAULT_RECONCILE_RETRY_DELAY_MS = 150;

const KIMI_CAPABILITIES = Object.freeze({
  nativeSession: true,
  nativeIdentity: true,
  sendToExistingSession: true,
  finalMessageEvent: true,
  messageDeduplication: true,
  snapshotRecovery: true,
  foreignTurnDetection: true,
  queueClear: true,
  requestAbort: true,
  providerUsage: true,
  // 语音：官方 Server API 没有事件族，本机也未实测 Stop hook 是否触发。
  voiceTrigger: null,
  voiceStartedFinishedEvents: false,
  voiceStop: false,
  voiceMute: false,
});

const TURN_STARTED_TYPES = new Set(['turn.started', 'turn_started', 'turn.start']);
const TURN_ENDED_TYPES = new Set(['turn.ended', 'turn_ended', 'turn.end']);
const TURN_FAILED_TYPES = new Set(['turn.failed', 'turn_failed', 'turn.error']);
const DELTA_TYPES = new Set(['assistant.delta', 'assistant_chunk', 'assistant.chunk']);
const MESSAGE_TYPES = new Set(['assistant.message', 'assistant.message.completed', 'assistant_message']);
const RESET_TYPES = new Set(['transcript.reset', 'transcript_reset']);
const OPS_TYPES = new Set(['transcript.ops', 'transcript_ops']);
const TERMINAL_TURN_STATES = new Set(['completed', 'failed', 'cancelled', 'canceled', 'aborted']);

const COMPLETED_KINDS = new Set(['completed', 'complete', 'done', 'success', 'succeeded', 'ok', 'finished']);
const ABORTED_KINDS = new Set(['aborted', 'abort', 'cancelled', 'canceled', 'interrupted', 'stopped', 'user_abort']);
const FAILED_KINDS = new Set(['failed', 'failure', 'error', 'errored']);

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function maxFinite(values) {
  let max = 0;
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > max) max = number;
  }
  return max;
}

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

function promptKey(promptId) {
  return `prompt:${String(promptId)}`;
}

function turnKey(turnRef) {
  return `turn:${String(turnRef)}`;
}

export function nativeTurnRefFor(sessionRef, turnRef) {
  return `${sessionRef}#turn:${String(turnRef)}`;
}

function errorPayload(error, fallbackCode = 'KIMI_BRIDGE_ERROR') {
  return {
    code: typeof error?.code === 'string' ? error.code : fallbackCode,
    message: typeof error?.message === 'string' ? error.message : String(error),
    retryable: error?.retryable === true,
  };
}

function blockText(block) {
  if (typeof block === 'string') return block;
  if (!block || typeof block !== 'object') return '';
  const type = typeof block.type === 'string' ? block.type.toLowerCase() : null;
  if (type && ['thinking', 'reasoning', 'tool_use', 'tool_result', 'tool_call', 'tool-call', 'function_call'].includes(type)) {
    return '';
  }
  if (typeof block.text === 'string') return block.text;
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) return block.content.map(blockText).join('');
  return '';
}

function textOf(value) {
  if (!value || typeof value !== 'object') return '';
  if (typeof value.text === 'string') return value.text;
  const content = value.content ?? value.blocks;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join('');
  if (content && typeof content === 'object') return blockText(content);
  if (value.message && typeof value.message === 'object' && value.message !== value) return textOf(value.message);
  return '';
}

function promptIdOf(data) {
  if (!data || typeof data !== 'object') return null;
  return stringOf(
    data.prompt_id
      ?? data.promptId
      ?? data.current_prompt_id
      ?? data.currentPromptId
      ?? data.prompt?.id
      ?? data.prompt?.prompt_id
      ?? data.message?.prompt_id
      ?? data.message?.promptId
      ?? data.turn?.prompt_id
      ?? data.turn?.promptId
      ?? null,
  );
}

function turnRefOf(data) {
  if (!data || typeof data !== 'object') return null;
  const turn = data.turn_id ?? data.turnId ?? data.turn;
  const raw = turn && typeof turn === 'object'
    ? turn.id ?? turn.turn_id ?? turn.turnId ?? null
    : turn;
  return stringOf(raw);
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const source = raw.message && typeof raw.message === 'object' && raw.message !== raw
    ? {
        ...raw,
        ...raw.message,
        prompt_id: raw.message.prompt_id ?? raw.message.promptId ?? raw.prompt_id ?? raw.promptId,
        turn_id: raw.message.turn_id ?? raw.message.turnId ?? raw.turn_id ?? raw.turnId,
      }
    : raw.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload)
      ? { ...raw, ...raw.payload }
      : raw;

  const id = source.id ?? source.message_id ?? source.messageId ?? null;
  const promptId = source.prompt_id ?? source.promptId ?? source.metadata?.prompt_id ?? null;
  const turnRef = source.turn_id
    ?? source.turnId
    ?? (source.turn && typeof source.turn === 'object' ? source.turn.id : source.turn)
    ?? null;
  const role = source.role ?? source.author?.role ?? null;
  const sequence = source.seq ?? source.sequence ?? source.index ?? null;

  return {
    id: stringOf(id),
    promptId: stringOf(promptId),
    promptIds: Array.isArray(source.promptIds)
      ? source.promptIds.map((value) => String(value))
      : null,
    turnRef: stringOf(turnRef),
    role: typeof role === 'string' ? role.toLowerCase() : null,
    type: typeof source.type === 'string' ? source.type : null,
    text: textOf(source),
    seq: Number.isFinite(Number(sequence)) ? Number(sequence) : null,
    volatile: source.volatile === true,
  };
}

function isMessageLike(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (
        typeof value.role === 'string'
        || typeof value.text === 'string'
        || value.content !== undefined
        || typeof value.message_id === 'string'
        || typeof value.prompt_id === 'string'
      ),
  );
}

function messagesFromTurn(turn) {
  if (!turn || typeof turn !== 'object') return [];
  const promptId = stringOf(turn.triggerPromptId ?? turn.promptId ?? turn.prompt_id ?? null);
  const turnRef = stringOf(turn.turnId ?? turn.turn_id ?? null);
  const output = [];
  const steps = Array.isArray(turn.steps)
    ? turn.steps
    : Array.isArray(turn.frames)
      ? [{ ordinal: 0, frames: turn.frames }]
      : [];
  let frameIndex = 0;

  for (const step of steps) {
    const frames = Array.isArray(step?.frames) ? step.frames : [];
    for (const frame of frames) {
      if (!frame || frame.kind !== 'text') continue;
      if (frame.role && frame.role !== 'assistant') continue;
      const text = typeof frame.text === 'string' ? frame.text : textOf(frame);
      if (!hasText(text)) continue;
      output.push({
        id: stringOf(frame.frameId ?? frame.id ?? null),
        promptId,
        turnRef,
        role: 'assistant',
        type: 'text',
        text,
        seq: (Number(turn.ordinal) || 0) * 1000
          + (Number(step.ordinal) || 0) * 10
          + frameIndex,
        volatile: false,
      });
      frameIndex += 1;
    }
  }
  return output;
}

function extractMessages(value, depth = 0) {
  if (!value || depth > 4) return [];
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(...extractMessages(item, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return [];

  const out = [];
  if (value.kind === 'turn' && (value.turnId || value.turn_id)) {
    out.push(...messagesFromTurn(value));
  }
  for (const key of ['messages', 'items', 'entries', 'transcript', 'events', 'records']) {
    const child = value[key];
    if (Array.isArray(child) || (child && typeof child === 'object')) {
      out.push(...extractMessages(child, depth + 1));
    }
  }

  const nested = value.message ?? value.entry ?? value.event ?? value.payload ?? null;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    out.push(...extractMessages(nested, depth + 1));
  }

  if (isMessageLike(value)) {
    const message = normalizeMessage(value);
    if (message) out.push(message);
  }
  return out;
}

function boolOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function busyOf(busyRaw, mainTurnActive) {
  const busy = boolOrNull(busyRaw);
  if (busy === true || mainTurnActive === true) return true;
  if (busy === false || mainTurnActive === false) return false;
  return null;
}

export function normalizeSnapshot(data) {
  const root = data && typeof data === 'object' ? data : {};
  const snapshot = root.snapshot && typeof root.snapshot === 'object'
    ? { ...root, ...root.snapshot }
    : root;
  const inFlight = snapshot.in_flight_turn
    ?? snapshot.inFlightTurn
    ?? snapshot.inflight_turn
    ?? null;
  const inFlightPromptId = (typeof inFlight === 'string' ? inFlight : null)
    ?? inFlight?.current_prompt_id
    ?? inFlight?.currentPromptId
    ?? inFlight?.prompt_id
    ?? inFlight?.promptId
    ?? snapshot.current_prompt_id
    ?? snapshot.currentPromptId
    ?? null;
  const inFlightTurnRef = inFlight?.turn_id
    ?? inFlight?.turnId
    ?? inFlight?.id
    ?? snapshot.turn_id
    ?? snapshot.turnId
    ?? null;
  const mainTurnActive = boolOrNull(
    snapshot.main_turn_active ?? snapshot.mainTurnActive ?? null,
  );
  const inFlightKnown = Object.prototype.hasOwnProperty.call(snapshot, 'in_flight_turn')
    || Object.prototype.hasOwnProperty.call(snapshot, 'inFlightTurn')
    || Object.prototype.hasOwnProperty.call(snapshot, 'current_prompt_id')
    || Object.prototype.hasOwnProperty.call(snapshot, 'currentPromptId');

  return {
    raw: snapshot,
    source: 'snapshot',
    epoch: stringOf(snapshot.epoch),
    asOfSeq: maxFinite([snapshot.as_of_seq, snapshot.asOfSeq, snapshot.last_seq, snapshot.seq]),
    transcriptSince: maxFinite([snapshot.transcript_since, snapshot.transcriptSince, snapshot.since]),
    inFlightPromptId: stringOf(inFlightPromptId),
    inFlightTurnRef: stringOf(inFlightTurnRef),
    inFlightKnown,
    busy: busyOf(snapshot.busy, mainTurnActive),
    mainTurnActive,
    pendingInteraction: snapshot.pending_interaction ?? snapshot.pendingInteraction ?? null,
    usage: snapshot.usage ?? snapshot.token_usage ?? snapshot.tokenUsage ?? snapshot.session?.usage ?? null,
    usageSource: 'snapshot',
    lastTurnReason: snapshot.last_turn_reason ?? snapshot.lastTurnReason ?? null,
    lastTurnError: snapshot.last_turn_error ?? snapshot.lastTurnError ?? null,
    model: snapshot.agent_config?.model ?? snapshot.agentConfig?.model ?? null,
    cwd: snapshot.cwd ?? snapshot.metadata?.cwd ?? null,
    messages: extractMessages(snapshot.messages ?? snapshot.transcript_messages ?? []),
    turns: extractTurns(snapshot),
  };
}

export function normalizeProfileSnapshot(profile, docs = {}) {
  const session = profile?.session && typeof profile.session === 'object'
    ? profile.session
    : profile;
  const source = session && typeof session === 'object' ? session : {};
  const transcript = normalizeTranscript(docs.transcript);
  const mainTurnActive = boolOrNull(
    source.main_turn_active ?? source.mainTurnActive ?? null,
  );
  const busy = busyOf(source.busy, mainTurnActive);
  const currentPromptId = stringOf(
    source.current_prompt_id ?? source.currentPromptId ?? null,
  );
  // profile 没有可用的 in_flight 结构：busy 且明确给出 current_prompt_id 才认，
  // 其余情况 in_flight 明确为空，不自行拼一个 turn。
  const inFlightPromptId = busy === true ? currentPromptId : null;

  return {
    raw: source,
    source: 'session-profile',
    epoch: null,
    asOfSeq: maxFinite([transcript.asOfSeq]),
    transcriptSince: maxFinite([transcript.transcriptSince]),
    inFlightPromptId,
    inFlightTurnRef: null,
    inFlightKnown: true,
    busy,
    mainTurnActive,
    pendingInteraction: source.pending_interaction ?? source.pendingInteraction ?? null,
    usage: source.usage ?? source.token_usage ?? source.tokenUsage ?? null,
    usageSource: 'session-profile',
    lastTurnReason: source.last_turn_reason ?? source.lastTurnReason ?? null,
    lastTurnError: source.last_turn_error ?? source.lastTurnError ?? null,
    model: source.agent_config?.model ?? source.agentConfig?.model ?? null,
    cwd: source.cwd ?? source.metadata?.cwd ?? null,
    messages: extractMessages(docs.messages ?? null),
    turns: [],
  };
}

function extractTurns(snapshot) {
  const list = snapshot.turns ?? snapshot.turn_states ?? snapshot.turnStates;
  if (!Array.isArray(list)) return [];
  return list.map((turn) => {
    const reason = turn?.reason ?? turn?.status ?? turn?.state ?? null;
    let status = typeof reason === 'string'
      ? reason
      : reason?.kind ?? reason?.status ?? null;
    if (status === null && turn?.ended === true) status = 'completed';
    if (status === null && turn?.ended === false) status = 'running';
    const normalizedStatus = status === null ? null : String(status).toLowerCase();
    return {
      turnRef: stringOf(turn?.turn_id ?? turn?.turnId ?? turn?.id ?? (typeof turn?.turn === 'object' ? turn.turn?.id : turn?.turn)),
      promptId: stringOf(turn?.current_prompt_id ?? turn?.prompt_id ?? turn?.promptId),
      status: normalizedStatus,
      text: textOf(turn),
      messageId: stringOf(turn?.message_id ?? turn?.messageId ?? turn?.message?.id),
      ended: ['completed', 'complete', 'done', 'success', 'aborted', 'abort', 'cancelled', 'canceled', 'interrupted', 'failed', 'failure', 'error'].includes(normalizedStatus),
    };
  });
}

function normalizeTurnItem(turn) {
  const reason = turn?.state ?? turn?.status ?? turn?.reason ?? null;
  const status = reason === null
    ? null
    : String(typeof reason === 'string' ? reason : reason?.kind ?? reason?.status ?? '').toLowerCase() || null;
  const messages = messagesFromTurn(turn);
  return {
    raw: turn,
    turnRef: stringOf(turn?.turnId ?? turn?.turn_id ?? turn?.id),
    promptId: stringOf(turn?.triggerPromptId ?? turn?.prompt_id ?? turn?.promptId),
    status,
    text: messages.length > 0 ? messages.map((message) => message.text).join('') : textOf(turn),
    messageId: messages.length > 0 ? messages[messages.length - 1].id : null,
    error: turn?.error ?? null,
    usage: turn?.usage ?? null,
    startedAtMs: Number.isFinite(Date.parse(turn?.startedAt ?? '')) ? Date.parse(turn.startedAt) : null,
    endedAtMs: Number.isFinite(Date.parse(turn?.endedAt ?? '')) ? Date.parse(turn.endedAt) : null,
  };
}

function extractTurnItems(value, depth = 0) {
  if (!value || depth > 4) return [];
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(...extractTurnItems(item, depth + 1));
    return out;
  }
  if (typeof value !== 'object') return [];

  const out = [];
  if (value.kind === 'turn' && (value.turnId || value.turn_id)) out.push(normalizeTurnItem(value));
  for (const key of ['items', 'turns', 'transcript', 'events', 'records']) {
    const child = value[key];
    if (Array.isArray(child) || (child && typeof child === 'object')) {
      out.push(...extractTurnItems(child, depth + 1));
    }
  }
  return out;
}

function normalizeTranscript(data) {
  const root = data?.transcript && typeof data.transcript === 'object' ? data.transcript : data ?? {};
  return {
    asOfSeq: maxFinite([root.as_of_seq, root.asOfSeq, root.last_seq, root.seq]),
    transcriptSince: maxFinite([root.transcript_since, root.transcriptSince, root.since]),
    messages: extractMessages(root),
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
    inputTokens: pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens', 'uncached_input_tokens', 'uncachedInputTokens'),
    outputTokens: pick('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens'),
    cacheReadTokens: pick('cache_read_tokens', 'cacheReadTokens', 'cache_read', 'cacheRead')
      ?? pick('prompt_tokens_details.cached_tokens')
      ?? (typeof bag.prompt_tokens_details?.cached_tokens === 'number' ? bag.prompt_tokens_details.cached_tokens : null),
    cacheWriteTokens: pick('cache_write_tokens', 'cacheWriteTokens', 'cache_write', 'cacheWrite', 'cache_creation_tokens', 'cacheCreationTokens'),
    totalTokens: pick('total_tokens', 'totalTokens'),
  };
  if (Object.values(usage).every((value) => value === null)) return null;
  return usage;
}

function normalizeError(raw, kind) {
  if (raw && typeof raw === 'object') {
    return {
      code: typeof raw.code === 'string' ? raw.code : kind ? `TURN_${String(kind).toUpperCase()}` : 'TURN_FAILED',
      message: typeof raw.message === 'string' ? raw.message : String(raw.message ?? 'Turn failed.'),
      retryable: raw.retryable === true,
    };
  }
  if (typeof raw === 'string' && raw.length > 0) {
    return { code: kind ? `TURN_${String(kind).toUpperCase()}` : 'TURN_FAILED', message: raw, retryable: false };
  }
  return {
    code: kind ? `TURN_${String(kind).toUpperCase()}` : 'TURN_ENDED_UNEXPECTED',
    message: `Turn ended without a completable reason: ${kind ?? 'unknown'}`,
    retryable: false,
  };
}

function reasonKindOfValue(raw) {
  const kind = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object'
      ? raw.kind ?? raw.status ?? raw.type ?? null
      : null;
  return kind === null || kind === undefined ? null : String(kind).toLowerCase();
}

function normalizeTurnError(turn) {
  const steps = Array.isArray(turn?.steps) ? turn.steps : [];
  const candidates = [];
  for (const step of steps) {
    if (step?.endMessage) candidates.push(step.endMessage);
    if (step?.error) candidates.push(step.error);
  }
  if (turn?.error) candidates.push(turn.error);

  const coded = candidates.find((value) => typeof value === 'string' && /^\s*\[[^\]]+\]/.test(value));
  const raw = coded ?? turn?.error ?? candidates[0] ?? null;
  if (raw && typeof raw === 'object') return normalizeError(raw, null);
  if (typeof raw === 'string' && raw.length > 0) {
    const match = raw.match(/^\s*\[([^\]]+)\]\s*([\s\S]*)$/);
    if (match) {
      const nativeCode = match[1];
      const code = nativeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_') || 'TURN_FAILED';
      return {
        code,
        message: match[2] || raw,
        retryable: false,
        details: { nativeCode },
      };
    }
    return { code: 'TURN_FAILED', message: raw, retryable: false };
  }
  return normalizeError(null, 'failed');
}

function turnTextOf(turn) {
  const messages = messagesFromTurn(turn);
  if (messages.length === 0) return '';
  return messages.map((message) => message.text).join('');
}

function classifyTurnEnd(data) {  const rawReason = data?.reason ?? data?.status ?? data?.outcome ?? data?.result ?? null;
  const reasonKind = typeof rawReason === 'string'
    ? rawReason
    : rawReason?.kind ?? rawReason?.status ?? rawReason?.type ?? null;
  const kind = reasonKind === null ? null : String(reasonKind).toLowerCase();
  const rawError = data?.error ?? (rawReason && typeof rawReason === 'object' ? rawReason.error : null) ?? data?.failure ?? null;

  if (COMPLETED_KINDS.has(kind)) return { kind: 'completed', error: null };
  if (ABORTED_KINDS.has(kind)) return { kind: 'aborted', error: null };
  if (kind && !COMPLETED_KINDS.has(kind) && !ABORTED_KINDS.has(kind)) {
    return { kind: 'failed', error: normalizeError(rawError, kind) };
  }
  if (rawError) return { kind: 'failed', error: normalizeError(rawError, kind) };
  return { kind: 'failed', error: normalizeError(null, kind) };
}

function isAssistantMessage(message) {
  if (!message || message.volatile) return false;
  if (message.role === 'user' || message.role === 'human') return false;
  if (message.type && /user|human|prompt/i.test(message.type)) return false;
  return true;
}

function findFinalMessage(messages, attempt) {
  const promptIds = [attempt.attemptId, attempt.serverPromptId].filter(Boolean);
  const matches = messages.filter((message) => {
    if (!message || !message.text || !isAssistantMessage(message)) return false;
    if (message.promptId && promptIds.includes(message.promptId)) return true;
    if (Array.isArray(message.promptIds) && message.promptIds.some((id) => promptIds.includes(id))) return true;
    if (attempt.turnRef && message.turnRef === attempt.turnRef) return true;
    return false;
  });
  if (matches.length === 0) return null;

  const seen = new Set();
  const ordered = [];
  for (const message of matches) {
    const key = message.id ?? `seq:${message.seq ?? ordered.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(message);
  }
  ordered.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const last = ordered[ordered.length - 1];
  return { text: last.text, messageId: last.id };
}

function unwrapFrame(frame) {
  let current = frame;
  if (current?.type === 'session_event') {
    const inner = current.payload?.event ?? current.payload;
    if (inner && typeof inner === 'object') {
      current = { ...inner, session_id: current.session_id ?? inner.session_id };
    }
  } else if (current?.type === 'event' && current.event && typeof current.event === 'object') {
    current = { ...current.event, session_id: current.session_id ?? current.event.session_id };
  }
  return current;
}

function frameData(frame) {
  const data = { ...frame };
  for (const key of ['payload', 'data']) {
    const value = frame?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(data, value);
    }
  }
  return data;
}

export class KimiCodeBridge {
  constructor(config = {}) {
    this._config = { ...config };
    this._seatId = config.seatId ?? null;
    this._sessionRef = config.nativeSessionRef ?? null;
    this._session = null;

    this._client = config.client ?? config.api ?? null;
    this._clientFactory = config.apiFactory ?? null;

    this._connected = false;
    this._connecting = false;
    this._closed = false;
    this._closing = false;
    this._connectPromise = null;
    this._closePromise = null;

    this._stream = null;
    this._subscribed = false;
    this._preSubscribeFrames = [];

    this._attempts = new Map();
    this._activeAttempt = null;
    this._turnToAttempt = new Map();
    this._turnRecords = new Map();
    this._settledPromptIds = new Set();
    this._deliveredMessageRefs = new Set();
    this._issuedPromptIds = new Set();
    this._foreignKeys = new Set();
    this._historicalKeys = new Set();
    this._endedTurnKeys = new Set();
    this._usageKeys = new Set();

    this._baseline = { epoch: null, asOfSeq: 0, transcriptSince: 0 };
    this._pendingEvents = [];
    this._subscribers = new Set();

    this._reconnectPromise = null;
    this._recoverPromise = null;

    this._requestTimeoutMs = finite(config.requestTimeoutMs ?? config.timeoutMs, DEFAULT_TIMEOUT_MS);
    this._connectTimeoutMs = finite(config.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this._closeTimeoutMs = finite(config.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
    this._subscribeTimeoutMs = finite(config.subscribeTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS);
    this._reconnectDelayMs = finite(config.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
    this._reconcileAttempts = finite(config.reconcileAttempts, DEFAULT_RECONCILE_ATTEMPTS);
    this._reconcileRetryDelayMs = finite(config.reconcileRetryDelayMs, DEFAULT_RECONCILE_RETRY_DELAY_MS);
    this._agentId = typeof config.agentId === 'string' && config.agentId.length > 0
      ? config.agentId
      : 'main';

    this._closedPromise = new Promise((resolve) => {
      this._resolveClosed = resolve;
    });
  }

  // ── Bridge v1 接口 ──────────────────────────────────────────────────────────

  /** 只读探测：先用 REST 确认会话存在，再读本机协议；不打开 WS、不投递 prompt。 */
  async probe(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    const sessionRef = cfg.nativeSessionRef ?? this._sessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError('SESSION_REQUIRED', 'probe() requires nativeSessionRef; this bridge never creates sessions.');
    }

    const client = await this._resolveClient(cfg);
    // 顺序是契约的一部分：先确认会话存在，再读协议；subscribe ack 不能证明会话存在。
    const session = await this._fetchSession(client, sessionRef);

    let meta;
    let openapi;
    let asyncapi;
    try {
      meta = await client.meta();
      openapi = await client.openapi();
      asyncapi = await client.asyncapi();
    } catch (error) {
      throw this._mapApiError(error, 'PROBE_FAILED');
    }

    const warnings = [];
    const requestedVoice = cfg.voiceMode;
    const voiceMode = requestedVoice === VOICE_MODES.EXTERNAL ? VOICE_MODES.EXTERNAL : VOICE_MODES.NONE;
    if (requestedVoice === VOICE_MODES.NATIVE) warnings.push('native-voice-not-measured');

    return {
      capabilities: normalizeCapabilities(KIMI_CAPABILITIES),
      identity: this._buildIdentity(session, sessionRef),
      clientVersion: meta?.server_version ?? meta?.version ?? null,
      voiceMode,
      warnings,
    };
  }

  /** 连接既有原生会话；不创建、不 fork、不 takeover、不归档。 */
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
      const client = await this._resolveClient(cfg);
      this._sessionRef = sessionRef;
      this._session = await this._fetchSession(client, sessionRef);

      this._connecting = true;
      try {
        await this._openChannel({ initial: true });
        this._connected = true;
      } catch (error) {
        this._connected = false;
        throw this._mapApiError(error, 'CONNECT_FAILED');
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

  /** 原生身份引用与版本；只含 session / cwd / model 等元数据，无人格正文。 */
  async getIdentity() {
    this._assertOpen();
    const sessionRef = this._sessionRef ?? this._config.nativeSessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError('IDENTITY_UNAVAILABLE', 'No native session reference is available.');
    }
    const client = await this._resolveClient(this._config);
    try {
      const session = await this._fetchSession(client, sessionRef);
      this._session = session;
      return this._buildIdentity(session, sessionRef);
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'SESSION_NOT_FOUND') throw error;
      if (this._session) return this._buildIdentity(this._session, sessionRef);
      throw new BridgeError('IDENTITY_UNAVAILABLE', `Unable to read Kimi Code identity: ${this._safeMessage(error)}`, {
        retryable: true,
        details: { cause: this._safeMessage(error) },
      });
    }
  }

  async createNativeSession(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    const client = await this._resolveClient(cfg);
    const current = await this._fetchSession(client, this._sessionRef);
    this._session = current;
    const identity = this._buildIdentity(current, this._sessionRef);
    const cwd = cfg.cwd ?? identity.metadata.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new BridgeError('CWD_REQUIRED', '创建 Kimi Code 会话需要沿用当前会话的 cwd。');
    }
    const model = cfg.model ?? identity.metadata.model?.id ?? identity.metadata.model;
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new BridgeError(
        'SESSION_MODEL_REQUIRED',
        '当前 Kimi Code 会话没有可继承的模型；请先在原客户端选择模型，再创建新会话。',
      );
    }
    const created = await client.createSession({ cwd, model });
    const nativeSessionRef = created?.sessionId
      ?? created?.session_id
      ?? created?.id
      ?? created?.session?.sessionId
      ?? created?.session?.session_id
      ?? created?.session?.id
      ?? null;
    if (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0) {
      throw new BridgeError('SESSION_CREATE_FAILED', 'Kimi Code 创建会话的响应缺少 sessionId。');
    }
    await client.updateSessionModel(nativeSessionRef, { model });
    const confirmed = await this._fetchSession(client, nativeSessionRef);
    const confirmedModel = confirmed?.agent_config?.model ?? confirmed?.model?.id ?? confirmed?.model;
    if (typeof confirmedModel !== 'string' || confirmedModel.trim().length === 0) {
      throw new BridgeError(
        'SESSION_MODEL_REQUIRED',
        'Kimi Code 新会话创建后仍没有模型，已拒绝接入。',
      );
    }
    return { nativeSessionRef };
  }

  /** 先登记 attempt，再 POST prompts；prompt_id 固定等于 attemptId。 */
  async send(packet) {
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
      createdAtMs: Date.now(),
      promptId: packet.attemptId,
      serverPromptId: null,
      turnRef: null,
      boundKey: null,
      nativeTurnRef: null,
      startedEmitted: false,
      settlePromise: null,
      deltas: new Map(),
      unsequencedDeltas: [],
      lastAssistantText: '',
      finalFrameText: null,
      lastMessageRef: null,
      liveUsage: null,
      baselineTranscriptSince: this._baseline.transcriptSince,
      packet: { ...packet },
      cancelReceipt: null,
      cancelPromise: null,
    };

    // 必须先登记：turn.started 可能早于 POST 的 HTTP 响应。
    this._attempts.set(attempt.attemptId, attempt);
    this._issuedPromptIds.add(attempt.attemptId);
    this._activeAttempt = attempt;

    let response;
    try {
      response = await this._client.postPrompt(this._sessionRef, {
        promptId: attempt.attemptId,
        text: packet.text,
      });
    } catch (error) {
      attempt.status = 'failed';
      attempt.error = errorPayload(this._mapApiError(error, 'PROMPT_FAILED'), 'PROMPT_FAILED');
      if (this._activeAttempt === attempt) this._activeAttempt = null;
      throw this._mapApiError(error, 'PROMPT_FAILED');
    }

    const accepted = response?.accepted !== false
      && response?.ok !== false
      && response?.prompt?.accepted !== false;
    if (!accepted) {
      const mapped = new BridgeError('PROMPT_NOT_ACCEPTED', 'Kimi Code did not accept the prompt.', {
        retryable: true,
        details: { attemptId: attempt.attemptId },
      });
      attempt.status = 'failed';
      attempt.error = errorPayload(mapped);
      if (this._activeAttempt === attempt) this._activeAttempt = null;
      throw mapped;
    }

    const receipt = { attemptId: attempt.attemptId, accepted: true };
    const nativeRequestRef = response?.request_id
      ?? response?.prompt?.id
      ?? null;
    if (nativeRequestRef !== null && nativeRequestRef !== undefined) {
      receipt.nativeRequestRef = String(nativeRequestRef);
    }
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

  /**
   * 幂等取消：先按队列顺序 abort 已投递的 queued prompt，再 session :abort。
   * RPC 接受只是 pending；最终 aborted 由 turn.ended / 对账确认。
   */
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

  /** 幂等关闭：只关 WS / 泵，不关闭 kimi web，不归档会话。 */
  async close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._closing = true;
    this._connected = false;
    this._subscribed = false;
    this._resolveClosed();

    const stream = this._stream;
    this._stream = null;

    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_CLOSED, null, { reason: 'closed' });
    for (const subscriber of this._subscribers) {
      subscriber.closed = true;
      const wake = subscriber.wake;
      subscriber.wake = null;
      wake?.();
    }
    this._subscribers.clear();

    this._closePromise = (async () => {
      if (stream) {
        if (typeof stream.unsubscribe === 'function') {
          await this._withTimeout(
            Promise.resolve().then(() => stream.unsubscribe()),
            this._closeTimeoutMs,
            'UNSUBSCRIBE_TIMEOUT',
          ).catch(() => null);
        }
        await Promise.resolve()
          .then(() => stream.close?.(1000, 'bridge close'))
          .catch(() => null);
        await this._withTimeout(stream.closed, this._closeTimeoutMs, 'WS_CLOSE_TIMEOUT').catch(() => null);
      }
      if (this._connectPromise) {
        await this._withTimeout(
          Promise.resolve(this._connectPromise).catch(() => null),
          this._closeTimeoutMs,
          'CONNECT_CLOSE_TIMEOUT',
        ).catch(() => null);
      }
      if (this._reconnectPromise) {
        await this._withTimeout(this._reconnectPromise, this._closeTimeoutMs, 'RECONNECT_CLOSE_TIMEOUT').catch(() => null);
      }
      if (this._recoverPromise) {
        await this._withTimeout(this._recoverPromise, this._closeTimeoutMs, 'RECOVERY_CLOSE_TIMEOUT').catch(() => null);
      }
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
      turnMapSize: this._turnToAttempt.size,
      turnRecordCount: this._turnRecords.size,
      baseline: { ...this._baseline },
      pendingEventCount: this._pendingEvents.length,
      subscriberCount: this._subscribers.size,
      reconnectRunning: this._reconnectPromise !== null,
      streamOpen: this._stream !== null,
      usageKeys: this._usageKeys.size,
    };
  }

  // ── 连接、基线与恢复 ────────────────────────────────────────────────────────

  async _openChannel({ initial }) {
    const stream = this._client.openStream({
      sessionId: this._sessionRef,
      timeoutMs: this._connectTimeoutMs,
      onFrame: (frame) => this._receiveFrame(frame),
      onAck: () => {},
      onClose: (info) => {
        void this._handleStreamClose(stream, info);
      },
      onError: (error) => {
        if (!this._closing && this._connected) this._emitBridgeError(errorPayload(error, 'STREAM_ERROR'));
      },
    });

    this._stream = stream;
    this._preSubscribeFrames = [];
    this._subscribed = false;

    try {
      await this._withTimeout(stream.ready, this._connectTimeoutMs, 'WS_HELLO_TIMEOUT');
      if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'Bridge was closed while connecting.');

      const docs = await this._fetchBaseline({ recovery: !initial });
      if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'Bridge was closed while connecting.');
      this._seedBaseline(docs, { initial });
      if (!initial) await this._recoverAttempts(docs);
      if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'Bridge was closed while connecting.');

      await this._withTimeout(
        stream.subscribe({
          transcriptSince: this._baseline.transcriptSince,
          grade: this._config.transcriptGrade ?? 'turn',
        }),
        this._subscribeTimeoutMs,
        'SUBSCRIBE_TIMEOUT',
      );
      if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'Bridge was closed while connecting.');

      this._subscribed = true;
      this._connected = true;
      const buffered = this._preSubscribeFrames.splice(0);
      for (const frame of buffered) this._handleFrame(frame);
    } catch (error) {
      this._subscribed = false;
      if (this._stream === stream) this._stream = null;
      await Promise.resolve().then(() => stream.close?.(1000, 'setup failed')).catch(() => null);
      await this._withTimeout(stream.closed, this._closeTimeoutMs, 'WS_CLOSE_TIMEOUT').catch(() => null);
      throw error;
    }
  }

  async _fetchBaseline({ recovery }) {
    const since = this._baseline.transcriptSince > 0 ? this._baseline.transcriptSince : undefined;

    let snapshot;
    try {
      snapshot = await this._client.getSnapshot(this._sessionRef);
    } catch (error) {
      if (!this._isSnapshotRouteMissing(error)) {
        throw this._mapApiError(error, recovery ? 'RECOVERY_FAILED' : 'BASELINE_FAILED');
      }
      return this._fetchProfileBaseline({ since, recovery, snapshotError: error });
    }

    try {
      const [transcript, messages] = await Promise.all([
        this._client.getTranscript(this._sessionRef, { since, agentId: this._agentIdValue() }),
        recovery ? this._client.getMessages(this._sessionRef, { since }) : Promise.resolve(null),
      ]);
      return { snapshot, transcript, messages, source: 'snapshot' };
    } catch (error) {
      throw this._mapApiError(error, recovery ? 'RECOVERY_FAILED' : 'BASELINE_FAILED');
    }
  }

  async _fetchProfileBaseline({ since, recovery, snapshotError }) {
    try {
      const [session, transcript, messages] = await Promise.all([
        this._fetchSession(this._client, this._sessionRef),
        this._client.getTranscript(this._sessionRef, { since, agentId: this._agentIdValue() }),
        this._client.getMessages(this._sessionRef, { since }),
      ]);
      return {
        profile: session,
        transcript,
        messages,
        source: 'session-profile',
        snapshotError: this._safeMessage(snapshotError),
      };
    } catch (error) {
      throw this._mapApiError(error, recovery ? 'RECOVERY_FAILED' : 'BASELINE_FAILED');
    }
  }

  _isSnapshotRouteMissing(error) {
    if (!error) return false;
    // 会话已经由 getSession 确认存在；此时 snapshot 的任何 HTTP 404
    // 都表示该路由未实现，包括 code=null 的 {message,error,statusCode} 形状。
    if (Number(error.httpStatus) === 404) return true;
    if (error.code === 40401 || error.code === '40401') return true;
    if (Number(error.code) === 404) return true;

    // 少数实例可能不填 httpStatus，仅给明确的 route-not-found 文本。
    return /route\s*(?:not\s*found|missing)|no\s+route|cannot\s+(?:get|post)\s+/i
      .test(this._safeMessage(error));
  }

  _seedBaseline(docs, { initial }) {
    const snapshot = docs.profile
      ? normalizeProfileSnapshot(docs.profile, docs)
      : normalizeSnapshot(docs.snapshot);
    const transcript = normalizeTranscript(docs.transcript);
    const messages = [
      ...extractMessages(docs.snapshot),
      ...extractMessages(docs.profile),
      ...extractMessages(docs.transcript),
      ...extractMessages(docs.messages ?? null),
      ...snapshot.messages,
      ...transcript.messages,
    ];

    this._baseline = {
      epoch: snapshot.source === 'session-profile'
        ? null
        : (snapshot.epoch ?? this._baseline.epoch),
      asOfSeq: maxFinite([snapshot.asOfSeq, transcript.asOfSeq, this._baseline.asOfSeq]),
      transcriptSince: maxFinite([
        snapshot.transcriptSince,
        snapshot.asOfSeq,
        transcript.transcriptSince,
        transcript.asOfSeq,
        this._baseline.transcriptSince,
      ]),
      source: snapshot.source ?? 'snapshot',
      busy: snapshot.busy ?? null,
      mainTurnActive: snapshot.mainTurnActive ?? null,
      pendingInteraction: snapshot.pendingInteraction ?? null,
      lastTurnReason: snapshot.lastTurnReason ?? null,
      model: snapshot.model ?? null,
      cwd: snapshot.cwd ?? null,
      inFlightPromptId: snapshot.inFlightPromptId ?? null,
      inFlightTurnRef: snapshot.inFlightTurnRef ?? null,
      inFlightKnown: snapshot.inFlightKnown === true,
      usageSource: snapshot.usageSource ?? 'snapshot',
    };

    for (const message of messages) {
      if (!message) continue;
      if (this._runningAttemptForPrompt(message.promptId) || this._runningAttemptForTurn(message.turnRef)) continue;
      if (message.promptId && message.promptId === snapshot.inFlightPromptId) continue;
      if (message.turnRef && message.turnRef === snapshot.inFlightTurnRef) continue;
      if (message.promptId) this._historicalKeys.add(promptKey(message.promptId));
      if (message.turnRef) this._historicalKeys.add(turnKey(message.turnRef));
      if (message.id) this._deliveredMessageRefs.add(message.id);
    }

    for (const turn of snapshot.turns) {
      if (!turn) continue;
      if (this._runningAttemptForPrompt(turn.promptId) || this._runningAttemptForTurn(turn.turnRef)) continue;
      if (turn.promptId && turn.promptId === snapshot.inFlightPromptId) continue;
      if (turn.turnRef && turn.turnRef === snapshot.inFlightTurnRef) continue;
      if (turn.promptId) this._historicalKeys.add(promptKey(turn.promptId));
      if (turn.turnRef) this._historicalKeys.add(turnKey(turn.turnRef));
      if (turn.ended) this._endedTurnKeys.add(this._endedKey(turn.turnRef, turn.promptId));
    }

    const usage = normalizeUsage(snapshot.usage);
    if (usage) {
      const usageSource = snapshot.usageSource ?? 'snapshot';
      this._emitUsage(usage, snapshot, {
        quality: usageSource === 'snapshot' ? 'exact' : 'unknown',
        source: usageSource,
      });
    }

    if (snapshot.inFlightPromptId) {
      const inFlightId = snapshot.inFlightPromptId;
      const known = this._attempts.get(inFlightId) ?? this._runningAttemptForPrompt(inFlightId);
      let attempt = known?.status === 'running' ? known : null;
      if (!attempt) {
        const active = this._activeAttempt;
        if (active?.status === 'running' && !active.boundKey) attempt = active;
      }
      if (attempt) {
        if (inFlightId !== attempt.attemptId) attempt.serverPromptId = inFlightId;
        this._bindStart(attempt, {
          promptId: attempt.attemptId,
          turnRef: snapshot.inFlightTurnRef,
        });
        if (snapshot.inFlightTurnRef) {
          this._turnToAttempt.set(turnKey(snapshot.inFlightTurnRef), attempt);
        }
        if (inFlightId !== attempt.attemptId) {
          this._turnToAttempt.set(promptKey(inFlightId), attempt);
        }
      } else if (!known) {
        this._emitForeign({
          promptId: inFlightId,
          turnRef: snapshot.inFlightTurnRef,
          reason: initial ? 'foreign-turn' : 'foreign-turn-open',
        });
      }
    }
  }

  async _recoverAttempts(docs) {
    const snapshot = docs.profile
      ? normalizeProfileSnapshot(docs.profile, docs)
      : normalizeSnapshot(docs.snapshot);
    const messages = [
      ...extractMessages(docs.profile),
      ...extractMessages(docs.snapshot),
      ...extractMessages(docs.transcript),
      ...extractMessages(docs.messages ?? null),
      ...snapshot.messages,
    ];

    for (const attempt of [...this._attempts.values()]) {
      if (attempt.status !== 'running') continue;
      const inFlightAttempt = this._runningAttemptForPrompt(snapshot.inFlightPromptId);
      let inFlight = inFlightAttempt === attempt
        || Boolean(attempt.serverPromptId && snapshot.inFlightPromptId === attempt.serverPromptId);

      const turns = [
        ...snapshot.turns,
        ...extractTurnItems(docs.transcript),
        ...extractTurnItems(docs.snapshot),
      ];
      let turn = turns.find((item) => (
        (item.promptId && (item.promptId === attempt.attemptId || item.promptId === attempt.serverPromptId))
        || (item.turnRef && attempt.turnRef && item.turnRef === attempt.turnRef)
      ));
      if (!turn && !attempt.serverPromptId && !attempt.turnRef) {
        const candidates = turns.filter((item) => {
          if (!item.promptId) return false;
          const unclaimed = !this._historicalKeys.has(promptKey(item.promptId))
            && !this._historicalKeys.has(turnKey(item.turnRef));
          const afterAttempt = Number.isFinite(item.startedAtMs)
            && Number.isFinite(attempt.createdAtMs)
            && item.startedAtMs >= attempt.createdAtMs - 1000;
          return unclaimed || afterAttempt;
        });
        if (candidates.length > 0) {
          candidates.sort((a, b) => (a.endedAtMs ?? a.startedAtMs ?? 0) - (b.endedAtMs ?? b.startedAtMs ?? 0));
          turn = candidates[candidates.length - 1];
        }
      }
      if (turn) {
        if (!attempt.serverPromptId && turn.promptId) attempt.serverPromptId = turn.promptId;
        if (!attempt.turnRef && turn.turnRef) attempt.turnRef = turn.turnRef;
        inFlight = inFlight || Boolean(attempt.serverPromptId && snapshot.inFlightPromptId === attempt.serverPromptId);
      }

      if (turn && !inFlight) {
        const turnUsage = normalizeUsage(turn.usage);
        if (turnUsage) attempt.liveUsage = turnUsage;
        if (COMPLETED_KINDS.has(turn.status)) {
          await this._settleAttempt(attempt, 'completed', {
            prefetchedText: turn.text || undefined,
            prefetchedMessageId: turn.messageId ?? undefined,
          });
          continue;
        }
        if (ABORTED_KINDS.has(turn.status)) {
          await this._settleAttempt(attempt, 'aborted', { partialText: turn.text || undefined });
          continue;
        }
        if (turn.status) {
          await this._settleAttempt(attempt, 'failed', {
            error: normalizeTurnError(turn.raw ?? turn.error ?? null),
          });
          continue;
        }
      }

      if (!attempt.serverPromptId && !inFlight) {
        const unclaimed = messages.filter((message) => (
          message?.promptId
          && hasText(message.text)
          && isAssistantMessage(message)
          && !this._historicalKeys.has(promptKey(message.promptId))
        ));
        if (unclaimed.length > 0) attempt.serverPromptId = unclaimed[unclaimed.length - 1].promptId;
      }

      const final = findFinalMessage(messages, attempt);
      if (final && !inFlight) {
        const lastKind = reasonKindOfValue(snapshot.lastTurnReason);
        if (lastKind && ABORTED_KINDS.has(lastKind)) {
          await this._settleAttempt(attempt, 'aborted', { partialText: final.text });
          continue;
        }
        if (lastKind && !COMPLETED_KINDS.has(lastKind) && (FAILED_KINDS.has(lastKind) || snapshot.lastTurnError)) {
          await this._settleAttempt(attempt, 'failed', {
            error: normalizeError(snapshot.lastTurnError, lastKind),
          });
          continue;
        }
        await this._settleAttempt(attempt, 'completed', {
          prefetchedText: final.text,
          prefetchedMessageId: final.messageId,
        });
        continue;
      }

      if (inFlight) {
        this._bindStart(attempt, {
          promptId: attempt.attemptId,
          turnRef: snapshot.inFlightTurnRef ?? attempt.turnRef,
        });
      }
    }

    if (maxFinite([snapshot.asOfSeq]) > this._baseline.transcriptSince) {
      this._baseline.transcriptSince = snapshot.asOfSeq;
    }
  }

  async _handleStreamClose(stream, info) {
    // 旧连接的迟到 close 不能把已经建立的新连接标成断开。
    if (this._stream && this._stream !== stream) return;
    if (this._stream === stream) this._stream = null;
    this._subscribed = false;
    const wasConnected = this._connected;
    this._connected = false;

    if (this._closed || this._closing || this._connecting) return;
    if (wasConnected) {
      this._emitBridgeError({
        code: 'STREAM_DISCONNECTED',
        message: `Kimi Code event stream closed (code=${info?.code ?? '?'}); reconnecting from snapshot.`,
        retryable: true,
      });
    }
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectPromise || this._closed) return;
    this._reconnectPromise = (async () => {
      while (!this._closed) {
        await this._sleep(this._reconnectDelayMs);
        if (this._closed) break;
        try {
          await this._openChannel({ initial: false });
          return;
        } catch (error) {
          if (this._closed) break;
          this._emitBridgeError(errorPayload(this._mapApiError(error, 'RECONNECT_FAILED')));
        }
      }
    })().finally(() => {
      this._reconnectPromise = null;
    });
  }

  // ── WS 帧 ───────────────────────────────────────────────────────────────────

  _receiveFrame(frame) {
    if (this._closed) return;
    const sid = frame?.session_id ?? frame?.payload?.session_id ?? null;
    if (sid !== null && sid !== undefined && sid !== this._sessionRef) return;
    if (!this._subscribed) {
      this._preSubscribeFrames.push(frame);
      return;
    }
    this._handleFrame(frame);
  }

  _handleFrame(rawFrame) {
    try {
      const frame = unwrapFrame(rawFrame);
      if (!frame || typeof frame.type !== 'string') return;

      const sid = frame.session_id ?? frame.payload?.session_id ?? null;
      if (sid !== null && sid !== undefined && sid !== this._sessionRef) return;

      const data = frameData(frame);
      const type = frame.type;

      if (TURN_STARTED_TYPES.has(type)) {
        this._handleTurnStarted(data);
        return;
      }
      if (TURN_ENDED_TYPES.has(type)) {
        void this._handleTurnEnded(data);
        return;
      }
      if (TURN_FAILED_TYPES.has(type)) {
        void this._handleTurnEnded({ ...data, status: 'failed', error: data.error ?? { message: data.msg ?? 'Turn failed.' } });
        return;
      }
      if (DELTA_TYPES.has(type)) {
        this._handleDelta(data, frame);
        return;
      }
      if (MESSAGE_TYPES.has(type)) {
        this._handleAssistantMessage(data, frame);
        return;
      }
      if (RESET_TYPES.has(type)) {
        this._handleTranscriptReset(data);
        return;
      }
      if (OPS_TYPES.has(type)) {
        this._handleTranscriptOps(data);
        return;
      }
      if (type === 'usage') {
        this._handleUsageFrame(data);
        return;
      }
      if (type === 'agent') {
        this._handleAgentFrame(data);
        return;
      }
      // goal / todo / task.list 等不参与文本回合。
    } catch (error) {
      this._emitBridgeError({
        code: 'FRAME_HANDLING_FAILED',
        message: this._safeMessage(error),
        retryable: false,
      });
    }
  }

  _handleTurnStarted(data) {
    const promptId = promptIdOf(data);
    const turnRef = turnRefOf(data);
    if (turnRef && this._endedTurnKeys.has(turnKey(turnRef))) return;

    const attempt = this._resolveAttempt(promptId, turnRef);

    if (attempt) {
      if (attempt.status !== 'running') return;
      this._bindStart(attempt, { promptId, turnRef });
      return;
    }
    if (promptId && this._attempts.has(promptId)) return;
    this._emitForeign({ promptId, turnRef, reason: 'no-pending-attempt' });
  }

  async _handleTurnEnded(data) {
    const promptId = promptIdOf(data);
    const turnRef = turnRefOf(data);
    const attempt = this._resolveAttempt(promptId, turnRef);
    const outcome = classifyTurnEnd(data);
    const endedKey = this._endedKey(turnRef, promptId);
    const freshEnd = !this._endedTurnKeys.has(endedKey);
    this._endedTurnKeys.add(endedKey);

    if (attempt) {
      if (attempt.status !== 'running') return;
      const bound = this._bindStart(attempt, { promptId, turnRef });
      if (!bound && attempt.boundKey) return;
      await this._settleAttempt(attempt, outcome.kind, {
        text: textOf(data),
        error: outcome.error,
        partialText: textOf(data),
      });
      return;
    }

    if (!freshEnd) return;
    const historyKey = promptId ? promptKey(promptId) : turnRef ? turnKey(turnRef) : null;
    if (historyKey && this._historicalKeys.has(historyKey)) return;
    this._emitForeign({ promptId, turnRef, reason: 'unattributed-turn-end' });
  }

  _handleDelta(data, frame) {
    const messageId = String(
      data.message_id
        ?? data.messageId
        ?? data.message?.id
        ?? data.id
        ?? 'default',
    );
    const text = textOf(data)
      || (typeof data.delta === 'string' ? data.delta : textOf(data.delta))
      || textOf(data.chunk);
    if (!text) return;

    const attempt = this._resolveAttempt(promptIdOf(data), turnRefOf(data));
    if (!attempt || attempt.status !== 'running') return;

    const rawOffset = data.offset ?? data.delta_index ?? data.index ?? frame?.seq ?? data.seq;
    const offset = Number(rawOffset);
    if (Number.isFinite(offset)) {
      let bucket = attempt.deltas.get(messageId);
      if (!bucket) {
        bucket = new Map();
        attempt.deltas.set(messageId, bucket);
      }
      // 只按 offset 去重，不按文本比较。
      if (!bucket.has(offset)) bucket.set(offset, text);
      return;
    }
    attempt.unsequencedDeltas.push(text);
  }

  _handleAssistantMessage(data, frame) {
    const raw = data.message && typeof data.message === 'object' ? data.message : data;
    const message = normalizeMessage(raw);
    if (!message || !message.text || !isAssistantMessage(message)) return;

    const attempt = this._resolveAttempt(
      message.promptId ?? promptIdOf(data),
      message.turnRef ?? turnRefOf(data),
    );
    if (!attempt || attempt.status !== 'running') return;

    attempt.lastAssistantText = message.text;
    if (message.id) attempt.lastMessageRef = message.id;
    if (data.volatile !== true && message.volatile !== true) {
      attempt.finalFrameText = message.text;
    }
    if (frame?.seq && !attempt.turnRef) {
      attempt.baselineTranscriptSince = maxFinite([attempt.baselineTranscriptSince, frame.seq]);
    }
  }

  _handleUsageFrame(data) {
    const usage = normalizeUsage(data.usage ?? data);
    if (!usage) return;
    const promptId = promptIdOf(data);
    const attempt = promptId ? this._attempts.get(promptId) : null;
    if (attempt && attempt.status === 'running') attempt.liveUsage = usage;
  }

  _handleAgentFrame(data) {
    const promptId = promptIdOf(data);
    const busy = data.busy === true
      || data.running === true
      || data.status === 'running'
      || data.agent?.busy === true
      || data.agent?.status === 'running';
    if (!busy || !promptId) return;

    const attempt = this._attempts.get(promptId);
    if (attempt && attempt.status === 'running' && !attempt.startedEmitted) {
      this._bindStart(attempt, { promptId, turnRef: turnRefOf(data) });
      return;
    }
    if (!attempt) {
      this._emitForeign({ promptId, turnRef: turnRefOf(data), reason: 'foreign-turn-open' });
    }
  }

  _advanceTranscriptSeq(seq) {
    const value = Number(seq);
    if (Number.isFinite(value) && value > this._baseline.transcriptSince) {
      this._baseline.transcriptSince = value;
    }
  }

  _runningAttemptForPrompt(promptId) {
    if (!promptId) return null;
    const direct = this._attempts.get(promptId);
    if (direct?.status === 'running') return direct;
    for (const attempt of this._attempts.values()) {
      if (attempt.status === 'running' && attempt.serverPromptId === promptId) return attempt;
    }
    return null;
  }

  _runningAttemptForTurn(turnRef) {
    if (!turnRef) return null;
    const attempt = this._turnToAttempt.get(turnKey(turnRef));
    return attempt?.status === 'running' ? attempt : null;
  }

  _mergeTurnRecord(turn) {
    if (!turn || typeof turn !== 'object') return turn;
    const turnRef = stringOf(turn.turnId ?? turn.turn_id);
    if (!turnRef) return turn;
    const previous = this._turnRecords.get(turnRef) ?? { kind: 'turn', turnId: turnRef, steps: [] };
    const steps = new Map(
      (Array.isArray(previous.steps) ? previous.steps : []).map((step) => [String(step.stepId), step]),
    );
    for (const step of Array.isArray(turn.steps) ? turn.steps : []) {
      if (!step) continue;
      const stepId = String(step.stepId ?? `step_${steps.size + 1}`);
      steps.set(stepId, { ...(steps.get(stepId) ?? {}), ...step });
    }
    const merged = { ...previous, ...turn, steps: [...steps.values()] };
    this._turnRecords.set(turnRef, merged);
    return merged;
  }

  _mergeTurnStep(turnId, step) {
    const turnRef = stringOf(turnId);
    if (!turnRef || !step || typeof step !== 'object') return;
    const previous = this._turnRecords.get(turnRef) ?? { kind: 'turn', turnId: turnRef, steps: [] };
    const steps = new Map(
      (Array.isArray(previous.steps) ? previous.steps : []).map((item) => [String(item.stepId), item]),
    );
    const stepId = String(step.stepId ?? `step_${steps.size + 1}`);
    steps.set(stepId, { ...(steps.get(stepId) ?? {}), ...step });
    this._turnRecords.set(turnRef, { ...previous, steps: [...steps.values()] });
  }

  _mergeTurnFrame(op) {
    const turnRef = stringOf(op?.turnId ?? op?.turn_id);
    const stepId = stringOf(op?.stepId ?? op?.step_id);
    const frame = op?.frame;
    if (!turnRef || !stepId || !frame) return;
    const previous = this._turnRecords.get(turnRef) ?? { kind: 'turn', turnId: turnRef, steps: [] };
    const steps = new Map(
      (Array.isArray(previous.steps) ? previous.steps : []).map((item) => [String(item.stepId), item]),
    );
    const step = { ...(steps.get(stepId) ?? { kind: 'step', stepId, turnId: turnRef, frames: [] }) };
    const frames = new Map(
      (Array.isArray(step.frames) ? step.frames : []).map((item) => [String(item.frameId ?? item.id), item]),
    );
    frames.set(String(frame.frameId ?? frame.id ?? frames.size + 1), { ...(frames.get(String(frame.frameId ?? frame.id ?? '')) ?? {}), ...frame });
    step.frames = [...frames.values()];
    steps.set(stepId, step);
    this._turnRecords.set(turnRef, { ...previous, steps: [...steps.values()] });
  }

  _handleTranscriptOps(data) {
    this._advanceTranscriptSeq(data.seq);
    const agentId = data.agent_id ?? data.agentId ?? null;
    if (agentId && agentId !== 'main' && agentId !== this._agentIdValue()) return;

    const ops = Array.isArray(data.ops) ? data.ops : [];
    const turns = [];
    for (const op of ops) {
      const kind = op?.op ?? op?.kind ?? null;
      try {
        if (kind === 'reset' && op?.snapshot) {
          this._applyTranscriptSnapshot(op.snapshot, { live: false });
        } else if (kind === 'turn.upsert' && op?.turn) {
          // 同一帧里可能先 upsert 回合，再补 step/frame；先合并，帧结束后统一交给状态机。
          turns.push(this._mergeTurnRecord(op.turn));
        } else if (kind === 'step.upsert' && op?.step) {
          this._mergeTurnStep(op.turnId ?? op.turn_id, op.step);
        } else if (kind === 'prompt.upsert' && op?.prompt) {
          this._handlePromptUpsert(op.prompt, { live: true });
        } else if (kind === 'frame.upsert' && op?.frame) {
          this._mergeTurnFrame(op);
          this._handleTurnFrame(op);
        } else if (kind === 'append') {
          this._handleTurnAppend(op);
        }
      } catch (error) {
        this._emitBridgeError({
          code: 'TRANSCRIPT_OPS_FAILED',
          message: this._safeMessage(error),
          retryable: false,
        });
      }
    }
    for (const turn of turns) {
      const turnRef = stringOf(turn?.turnId ?? turn?.turn_id);
      const latest = turnRef ? this._turnRecords.get(turnRef) ?? turn : turn;
      this._dispatchTranscriptTurn(latest, { live: true });
    }
  }

  _dispatchTranscriptTurn(turn, options) {
    void this._handleTranscriptTurn(turn, options).catch((error) => {
      this._emitBridgeError({
        code: 'TRANSCRIPT_TURN_FAILED',
        message: this._safeMessage(error),
        retryable: true,
      });
    });
  }

  _handleTranscriptReset(data) {
    const since = maxFinite([data.transcript_since, data.transcriptSince, data.as_of_seq, data.asOfSeq, data.seq]);
    this._advanceTranscriptSeq(since);

    const snapshot = data.snapshot ?? data.payload?.snapshot ?? null;
    if (snapshot) {
      this._applyTranscriptSnapshot(snapshot, { live: false });
      return;
    }

    const messages = extractMessages(data.messages ?? data.items ?? data.payload?.messages ?? null);
    for (const message of messages) {
      if (!message?.promptId || this._runningAttemptForPrompt(message.promptId)) continue;
      if (message.promptId) this._historicalKeys.add(promptKey(message.promptId));
      if (message.turnRef) this._historicalKeys.add(turnKey(message.turnRef));
    }
    for (const prompt of Array.isArray(data.prompts) ? data.prompts : []) {
      this._handlePromptUpsert(prompt, { live: false });
    }
  }

  _applyTranscriptSnapshot(snapshot, { live }) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    const prompts = Array.isArray(snapshot.prompts) ? snapshot.prompts : [];
    const inFlightId = this._baseline.inFlightPromptId ?? null;

    for (const item of items) {
      if (item?.kind !== 'turn') continue;
      const turnRef = stringOf(item.turnId ?? item.turn_id);
      const promptId = stringOf(item.triggerPromptId ?? item.prompt_id ?? item.promptId);
      const currentInFlight = Boolean(promptId && inFlightId && promptId === inFlightId);
      if (!currentInFlight
          && !this._runningAttemptForPrompt(promptId)
          && !this._runningAttemptForTurn(turnRef)) {
        this._markHistoricalTurn(promptId, turnRef);
      }
      const state = String(item.state ?? '').toLowerCase();
      if (TERMINAL_TURN_STATES.has(state)) {
        this._endedTurnKeys.add(this._endedKey(turnRef, promptId));
      }
    }

    for (const prompt of prompts) this._handlePromptUpsert(prompt, { live });
    for (const item of items) {
      if (item?.kind === 'turn') {
        this._dispatchTranscriptTurn(this._mergeTurnRecord(item), { live });
      }
    }
  }

  _markHistoricalTurn(promptId, turnRef) {
    if (turnRef) this._historicalKeys.add(turnKey(turnRef));
    if (promptId) this._historicalKeys.add(promptKey(promptId));
  }

  _handlePromptUpsert(prompt, { live }) {
    if (!prompt || typeof prompt !== 'object') return;
    const promptId = stringOf(prompt.promptId ?? prompt.prompt_id);
    if (!promptId) return;
    const status = String(prompt.status ?? '').toLowerCase();
    const inFlightId = this._baseline.inFlightPromptId ?? null;
    const currentInFlight = Boolean(inFlightId && promptId === inFlightId);

    let attempt = this._resolveAttempt(promptId, null);
    if (!attempt && !this._historicalKeys.has(promptKey(promptId))) {
      const active = this._activeAttempt;
      if (active?.status === 'running' && !active.boundKey
          && (live || currentInFlight || status === 'running' || status === 'queued')) {
        attempt = active;
      }
    }

    if (!attempt) {
      if (!currentInFlight && (!live || TERMINAL_TURN_STATES.has(status) || status === 'queued' || status === 'blocked')) {
        this._historicalKeys.add(promptKey(promptId));
      }
      return;
    }
    if (attempt.status !== 'running') return;
    if (promptId !== attempt.attemptId) attempt.serverPromptId = promptId;
    this._turnToAttempt.set(promptKey(promptId), attempt);
    attempt.promptStatus = status || attempt.promptStatus;
  }

  async _handleTranscriptTurn(turn, { live }) {
    if (!turn || typeof turn !== 'object') return;
    const turnRef = stringOf(turn.turnId ?? turn.turn_id);
    if (!turnRef) return;
    const promptId = stringOf(turn.triggerPromptId ?? turn.prompt_id ?? turn.promptId);
    const state = String(turn.state ?? '').toLowerCase();
    const turnK = turnKey(turnRef);
    const promptK = promptId ? promptKey(promptId) : null;
    const historical = this._historicalKeys.has(turnK) || (promptK && this._historicalKeys.has(promptK));
    const ended = this._endedTurnKeys.has(this._endedKey(turnRef, promptId));

    let attempt = this._resolveAttempt(promptId, turnRef);
    if (!attempt && !historical && !ended) {
      const active = this._activeAttempt;
      if (active?.status === 'running' && !active.boundKey) attempt = active;
    }
    if (!attempt) {
      if (historical || ended) return;
      if (state === 'running') {
        this._emitForeign({ promptId, turnRef, reason: 'foreign-turn-open' });
      } else if (TERMINAL_TURN_STATES.has(state)) {
        this._emitForeign({ promptId, turnRef, reason: 'unattributed-turn-end' });
      }
      return;
    }
    if (attempt.status !== 'running') return;

    if (promptId && promptId !== attempt.attemptId) attempt.serverPromptId = promptId;
    const bound = this._bindStart(attempt, { promptId: attempt.attemptId, turnRef });
    if (!bound && attempt.boundKey) return;
    if (promptId) this._turnToAttempt.set(promptKey(promptId), attempt);
    this._turnToAttempt.set(turnK, attempt);

    if (!TERMINAL_TURN_STATES.has(state)) return;
    this._endedTurnKeys.add(this._endedKey(turnRef, promptId));
    this._markHistoricalTurn(promptId, turnRef);

    const usage = normalizeUsage(turn.usage);
    if (usage) attempt.liveUsage = usage;
    const text = turnTextOf(turn);

    if (state === 'completed') {
      await this._settleAttempt(attempt, 'completed', { text: text || undefined });
      return;
    }
    if (state === 'failed') {
      await this._settleAttempt(attempt, 'failed', { error: normalizeTurnError(turn) });
      return;
    }
    await this._settleAttempt(attempt, 'aborted', { partialText: text || undefined });
  }

  _handleTurnFrame(op) {
    const attempt = this._runningAttemptForTurn(op?.turnId ?? op?.turn_id);
    if (!attempt || !op?.frame) return;
    const frame = op.frame;
    if (frame.kind !== 'text' || (frame.role && frame.role !== 'assistant')) return;
    const text = typeof frame.text === 'string' ? frame.text : '';
    if (!hasText(text)) return;
    attempt.lastAssistantText = text;
    attempt.finalFrameText = text;
    if (frame.frameId) attempt.lastMessageRef = String(frame.frameId);
  }

  _handleTurnAppend(op) {
    const target = op?.target ?? null;
    const turnRef = target?.turnId ?? op?.turnId ?? null;
    const attempt = this._runningAttemptForTurn(turnRef);
    if (!attempt || typeof op?.text !== 'string' || op.text.length === 0) return;
    const offset = Number(op.offset);
    if (Number.isInteger(offset)) {
      if (!attempt.streamOffsets) attempt.streamOffsets = new Set();
      if (attempt.streamOffsets.has(offset)) return;
      attempt.streamOffsets.add(offset);
    }
    attempt.finalFrameText = `${attempt.finalFrameText ?? ''}${op.text}`;
    attempt.lastAssistantText = attempt.finalFrameText;
    if (target?.frameId) attempt.lastMessageRef = String(target.frameId);
  }

  // ── attempt 生命周期 ────────────────────────────────────────────────────────

  _resolveAttempt(promptId, turnRef) {
    if (promptId) {
      if (this._attempts.has(promptId)) return this._attempts.get(promptId);
      for (const attempt of this._attempts.values()) {
        if (attempt.serverPromptId === promptId) return attempt;
      }
      const byPrompt = this._turnToAttempt.get(promptKey(promptId));
      if (byPrompt) return byPrompt;
    }
    if (turnRef) {
      const byTurn = this._turnToAttempt.get(turnKey(turnRef));
      if (byTurn) return byTurn;
    }
    if (!promptId && !turnRef) {
      return this._activeAttempt?.status === 'running' ? this._activeAttempt : null;
    }
    if (!promptId) {
      const active = this._activeAttempt;
      if (active?.status === 'running' && !active.boundKey) return active;
    }
    return null;
  }

  _bindStart(attempt, { promptId, turnRef }) {
    if (attempt.status !== 'running') return false;
    const key = promptId
      ? promptKey(promptId)
      : turnRef
        ? turnKey(turnRef)
        : promptKey(attempt.attemptId);

    if (attempt.boundKey && attempt.boundKey !== key) return false;
    attempt.boundKey = key;
    if (turnRef) attempt.turnRef = turnRef;
    if (turnRef || !attempt.nativeTurnRef) {
      attempt.nativeTurnRef = nativeTurnRefFor(this._sessionRef, turnRef ?? promptId ?? attempt.attemptId);
    }
    this._turnToAttempt.set(key, attempt);
    if (turnRef) this._turnToAttempt.set(turnKey(turnRef), attempt);

    if (!attempt.startedEmitted) {
      attempt.startedEmitted = true;
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_STARTED, attempt.attemptId, {
        nativeTurnRef: attempt.nativeTurnRef,
      });
    }
    return true;
  }

  async _settleAttempt(attempt, kind, options = {}) {
    if (attempt.status !== 'running' || attempt.settlePromise) return;
    if (this._settledPromptIds.has(attempt.attemptId)) return;

    attempt.settlePromise = (async () => {
      const usage = attempt.liveUsage ?? undefined;

      if (kind === 'completed') {
        let text = hasText(options.prefetchedText) ? options.prefetchedText : null;
        let messageId = options.prefetchedMessageId ?? null;
        let readErrors = [];
        let readAttempts = 0;

        if (!hasText(text)) {
          const reconciled = await this._reconcileFinalText(attempt);
          readErrors = reconciled.errors;
          readAttempts = reconciled.attempts;
          if (hasText(reconciled.text)) {
            text = reconciled.text;
            messageId = reconciled.messageId ?? messageId;
          } else if (hasText(options.text)) {
            text = options.text;
          } else if (hasText(attempt.finalFrameText)) {
            text = attempt.finalFrameText;
          }
        }
        if (this._closed || attempt.status !== 'running') return;

        if (!hasText(text)) {
          this._settledPromptIds.add(attempt.attemptId);
          const error = {
            code: 'FINAL_TEXT_UNAVAILABLE',
            message: 'Kimi Code completed the turn but no final text was available from messages/transcript.',
            retryable: true,
            details: {
              attempts: readAttempts,
              readErrors,
            },
          };
          const payload = {
            error,
            nativeTurnRef: attempt.nativeTurnRef,
          };
          if (usage) payload.usage = usage;
          this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, payload);
          this._finishAttempt(attempt, 'failed');
          return;
        }

        const nativeMessageRef = messageId
          ?? attempt.lastMessageRef
          ?? `${attempt.nativeTurnRef}:message`;

        this._settledPromptIds.add(attempt.attemptId);
        this._deliveredMessageRefs.add(String(nativeMessageRef));
        const payload = {
          nativeTurnRef: attempt.nativeTurnRef,
          nativeMessageRef,
          text,
        };
        if (usage) payload.usage = usage;
        this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_COMPLETED, attempt.attemptId, payload);
        this._finishAttempt(attempt, 'completed');
        return;
      }

      if (kind === 'aborted') {
        this._settledPromptIds.add(attempt.attemptId);
        let partialText = options.partialText || this._partialText(attempt);
        if (!partialText) {
          const reconciled = await this._reconcileFinalText(attempt, { maxAttempts: 1 });
          partialText = reconciled.text ?? '';
        }
        if (attempt.status !== 'running') return;
        const payload = {
          nativeTurnRef: attempt.nativeTurnRef,
          partialText,
        };
        if (usage) payload.usage = usage;
        this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_ABORTED, attempt.attemptId, payload);
        this._finishAttempt(attempt, 'aborted');
        return;
      }

      this._settledPromptIds.add(attempt.attemptId);
      const payload = {
        error: options.error ?? normalizeError(null, null),
        nativeTurnRef: attempt.nativeTurnRef,
      };
      if (usage) payload.usage = usage;
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, payload);
      this._finishAttempt(attempt, 'failed');
    })().catch((error) => {
      // 兜底：结算本身出错也必须终结 active attempt，不能让席位永久卡住。
      if (attempt.status === 'running') {
        this._settledPromptIds.add(attempt.attemptId);
        this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, {
          error: {
            code: 'SETTLEMENT_FAILED',
            message: this._safeMessage(error),
            retryable: true,
            details: { cause: this._safeMessage(error) },
          },
          nativeTurnRef: attempt.nativeTurnRef,
        });
        this._finishAttempt(attempt, 'failed');
        return;
      }
      this._emitBridgeError({
        code: 'SETTLEMENT_FAILED',
        message: this._safeMessage(error),
        retryable: true,
      });
    }).finally(() => {
      attempt.settlePromise = null;
    });

    await attempt.settlePromise;
  }

  _readErrorDetail(source, error) {
    const detail = {
      source,
      code: typeof error?.code === 'string' ? error.code : 'READ_FAILED',
      message: this._safeMessage(error),
      retryable: error?.retryable === true,
    };
    if (typeof error?.code === 'number') detail.nativeCode = error.code;
    if (error?.details && typeof error.details === 'object') detail.details = error.details;
    return detail;
  }

  async _reconcileFinalText(attempt, { maxAttempts: maxAttemptsOverride } = {}) {
    const maxAttempts = maxAttemptsOverride ?? this._reconcileAttemptLimit();
    const retryDelayMs = this._reconcileRetryDelayMsValue();
    const errors = [];
    let attempts = 0;
    let messageId = null;

    for (let index = 0; index < maxAttempts; index += 1) {
      if (this._closed || attempt.status !== 'running') break;
      attempts += 1;

      const since = Number.isFinite(attempt.baselineTranscriptSince)
        ? attempt.baselineTranscriptSince
        : this._baseline.transcriptSince;

      const results = await Promise.allSettled([
        this._client.getMessages(this._sessionRef, { since, promptId: attempt.attemptId }),
        this._client.getTranscript(this._sessionRef, {
          since,
          promptId: attempt.attemptId,
          agentId: this._agentIdValue(),
        }),
      ]);
      const sources = ['messages', 'transcript'];
      const messages = [];
      for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
        const result = results[resultIndex];
        if (result.status === 'fulfilled') messages.push(...extractMessages(result.value));
        else errors.push(this._readErrorDetail(sources[resultIndex], result.reason));
      }

      const found = findFinalMessage(messages, attempt);
      if (found && hasText(found.text)) {
        return {
          text: found.text,
          messageId: found.messageId ?? null,
          errors,
          attempts,
        };
      }
      if (found?.messageId) messageId = found.messageId;

      if (index + 1 < maxAttempts) {
        await this._sleep(retryDelayMs);
        if (this._closed || attempt.status !== 'running') break;
      }
    }

    return { text: null, messageId, errors, attempts };
  }

  _partialText(attempt) {
    const chunks = [];
    for (const bucket of attempt.deltas.values()) {
      const offsets = [...bucket.keys()].sort((a, b) => a - b);
      for (const offset of offsets) chunks.push(bucket.get(offset));
    }
    chunks.push(...attempt.unsequencedDeltas);
    let text = chunks.join('');
    if (!text && attempt.lastAssistantText) text = attempt.lastAssistantText;
    if (!text && attempt.finalFrameText) text = attempt.finalFrameText;
    return text;
  }

  _finishAttempt(attempt, status) {
    attempt.status = status;
    attempt.endedAt = new Date().toISOString();
    if (this._activeAttempt === attempt) this._activeAttempt = null;

    const aliases = new Set(
      [
        attempt.boundKey,
        attempt.turnRef ? turnKey(attempt.turnRef) : null,
        attempt.serverPromptId ? promptKey(attempt.serverPromptId) : null,
        promptKey(attempt.attemptId),
      ].filter(Boolean),
    );
    for (const alias of aliases) {
      if (this._turnToAttempt.get(alias) === attempt) this._turnToAttempt.delete(alias);
    }
    attempt.boundKey = null;
    if (attempt.turnRef) this._turnRecords.delete(attempt.turnRef);
  }

  _endedKey(turnRef, promptId) {
    return turnRef ? turnKey(turnRef) : promptId ? promptKey(promptId) : 'unknown';
  }

  // ── 取消 ───────────────────────────────────────────────────────────────────

  async _performCancel(attempt) {
    const errors = [];
    let sessionAbort = null;

    try {
      const queue = await this._client.getPrompts(this._sessionRef);
      const queuedIds = this._queuedPromptIds(queue);
      for (const promptId of queuedIds) {
        if (!this._issuedPromptIds.has(promptId)) continue;
        try {
          await this._client.abortPrompt(this._sessionRef, promptId);
        } catch (error) {
          const mapped = this._mapApiError(error, 'PROMPT_ABORT_FAILED');
          // 已经不存在视为已取消，不加入错误。
          if (mapped.code !== 'PROMPT_NOT_FOUND' && mapped.code !== 'SESSION_NOT_FOUND') {
            errors.push(errorPayload(mapped));
          }
        }
      }
    } catch (error) {
      errors.push(errorPayload(this._mapApiError(error, 'QUEUE_READ_FAILED')));
    }

    try {
      sessionAbort = await this._client.abortSession(this._sessionRef);
    } catch (error) {
      errors.push(errorPayload(this._mapApiError(error, 'CANCEL_FAILED')));
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

    if (sessionAbort?.aborted === false || sessionAbort?.ok === false) {
      errors.push({ code: 'CANCEL_REJECTED', message: 'session :abort was rejected.', retryable: true });
    }

    if (errors.length > 0 && sessionAbort?.aborted !== true && sessionAbort?.ok !== true) {
      return {
        attemptId: attempt.attemptId,
        accepted: false,
        settlement: 'failed',
        ...(attempt.nativeTurnRef ? { nativeTurnRef: attempt.nativeTurnRef } : {}),
        error: errors[0],
      };
    }

    const receipt = {
      attemptId: attempt.attemptId,
      accepted: true,
      settlement: 'pending',
    };
    if (attempt.nativeTurnRef) receipt.nativeTurnRef = attempt.nativeTurnRef;
    if (errors.length > 0) receipt.error = errors[0];
    return receipt;
  }

  _queuedPromptIds(queue) {
    const list = Array.isArray(queue)
      ? queue
      : queue?.prompts ?? queue?.items ?? queue?.queue ?? queue?.data ?? [];
    if (!Array.isArray(list)) return [];
    const ids = [];
    for (const item of list) {
      const status = typeof item?.status === 'string' ? item.status.toLowerCase() : null;
      if (status && !['queued', 'pending', 'waiting'].includes(status)) continue;
      const id = item?.prompt_id ?? item?.promptId ?? item?.id ?? null;
      if (id !== null && id !== undefined && !ids.includes(String(id))) ids.push(String(id));
    }
    return ids;
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
    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_ERROR, null, { error: errorPayload(error) });
  }

  _emitUsage(usage, snapshot, { quality = 'exact', source = 'snapshot' } = {}) {
    const key = `${source}:${quality}:${snapshot.epoch ?? ''}:${JSON.stringify(usage)}`;
    if (this._usageKeys.has(key)) return;
    this._usageKeys.add(key);
    const payload = {
      usage,
      usageQuality: quality,
      usageKnown: quality === 'exact',
      usageSource: source,
    };
    if (snapshot.inFlightPromptId) {
      payload.nativeTurnRef = nativeTurnRefFor(
        this._sessionRef,
        snapshot.inFlightTurnRef ?? snapshot.inFlightPromptId,
      );
    }
    this._emit(BRIDGE_EVENT_TYPES.USAGE_REPORTED, null, payload);
  }

  _emitForeign({ promptId, turnRef, reason }) {
    const keys = [
      promptId ? promptKey(promptId) : null,
      turnRef ? turnKey(turnRef) : null,
    ].filter(Boolean);
    if (keys.length === 0) return;
    if (keys.some((key) => this._foreignKeys.has(key) || this._historicalKeys.has(key))) return;
    for (const key of keys) this._foreignKeys.add(key);
    this._emit(BRIDGE_EVENT_TYPES.FOREIGN_TURN, null, {
      nativeTurnRef: nativeTurnRefFor(this._sessionRef, turnRef ?? promptId),
      reason,
    });
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

  // ── 配置 / API 注入 ────────────────────────────────────────────────────────

  _mergedConfig(config) {
    return { ...this._config, ...config };
  }

  _requireSeat(config) {
    if (typeof config?.seatId !== 'string' || config.seatId.length === 0) {
      throw new BridgeError('CONFIG_INVALID', 'KimiCodeBridge requires a non-empty seatId.');
    }
  }

  _assertOpen() {
    if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'Bridge is closed.');
  }

  _agentIdValue() {
    const configured = this._config.agentId ?? this._config.transcriptAgentId;
    return typeof configured === 'string' && configured.length > 0 ? configured : this._agentId;
  }

  _reconcileAttemptLimit() {
    const retries = Number(this._config.reconcileRetries);
    if (Number.isFinite(retries) && retries >= 0) return Math.max(1, Math.floor(retries) + 1);

    const raw = Number(this._config.reconcileAttempts ?? this._reconcileAttempts);
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_RECONCILE_ATTEMPTS;
    return Math.max(1, Math.floor(raw));
  }

  _reconcileRetryDelayMsValue() {
    const raw = Number(
      this._config.reconcileRetryDelayMs
        ?? this._config.reconcileDelayMs
        ?? this._reconcileRetryDelayMs,
    );
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RECONCILE_RETRY_DELAY_MS;
  }

  async _resolveClient(config = {}) {
    const effective = { ...this._config, ...config };
    if (effective.client) {
      this._client = effective.client;
      return this._client;
    }
    if (effective.api) {
      this._client = effective.api;
      return this._client;
    }
    if (this._client) return this._client;
    if (this._clientFactory) {
      const client = await this._clientFactory(effective);
      if (!client) throw new BridgeError('CONFIG_INVALID', 'apiFactory returned no client.');
      this._client = client;
      return client;
    }

    const transport = effective.transport ?? null;
    let token;
    if (typeof effective.token === 'string') token = effective.token;
    else if (transport) token = '';
    else token = await resolveToken(effective);

    this._client = new KimiCodeClient({
      baseUrl: effective.baseUrl ?? KIMI_DEFAULT_BASE_URL,
      token,
      timeoutMs: this._requestTimeoutMs,
      transport,
    });
    return this._client;
  }

  async _fetchSession(client, sessionRef) {
    let data;
    try {
      data = await client.getSession(sessionRef);
    } catch (error) {
      throw this._mapApiError(error, 'SESSION_READ_FAILED');
    }
    const session = data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'session')
      ? data.session
      : data;
    if (!session || typeof session !== 'object') {
      throw new BridgeError('SESSION_NOT_FOUND', `Kimi Code session does not exist: ${sessionRef}`, {
        details: { sessionId: sessionRef },
      });
    }
    return session;
  }

  _buildIdentity(session, sessionRef) {
    const cwd = session?.cwd
      ?? session?.work_dir
      ?? session?.workDir
      ?? session?.workspace?.cwd
      ?? session?.metadata?.cwd
      ?? null;
    const model = session?.model?.id
      ?? session?.model?.model
      ?? session?.model?.name
      ?? session?.model
      ?? session?.model_id
      ?? session?.modelId
      ?? session?.agent?.model
      ?? session?.agent_config?.model
      ?? session?.agentConfig?.model
      ?? null;
    const name = session?.title ?? session?.name ?? null;
    const version = session?.updated_at ?? session?.updatedAt ?? session?.version ?? session?.revision ?? null;

    const metadata = {
      name,
      cwd,
      model,
      version,
      identityLevel: 'session+cwd',
    };
    for (const key of Object.keys(metadata)) {
      if (metadata[key] === undefined || metadata[key] === null) delete metadata[key];
    }

    const revision = createHash('sha256')
      .update(JSON.stringify([sessionRef, metadata.cwd ?? null, metadata.model ?? null, metadata.version ?? null]))
      .digest('hex')
      .slice(0, 16);

    return {
      sourceRef: `${sessionRef}#identity`,
      revision,
      nativeSessionRef: sessionRef,
      metadata,
    };
  }

  _mapApiError(error, fallbackCode) {
    if (error instanceof BridgeError) return error;
    const rawCode = error?.code;
    const code = typeof rawCode === 'number'
      ? rawCode
      : typeof rawCode === 'string' && /^\d+$/.test(rawCode)
        ? Number(rawCode)
        : null;

    let mapped = fallbackCode;
    if (code === 40401) mapped = 'SESSION_NOT_FOUND';
    else if (code === 40101 || code === 40301) mapped = 'AUTH_FAILED';
    else if (error?.httpStatus === 401 || error?.httpStatus === 403) mapped = 'AUTH_FAILED';
    else if (code === 40931) mapped = 'BRIDGE_BUSY';
    else if (code === 40932) mapped = 'BRIDGE_CONFLICT';

    return new BridgeError(
      mapped,
      this._safeMessage(error),
      {
        retryable: error?.retryable === true || code === 40931 || code === 40932 || mapped === 'PROBE_FAILED',
        details: {
          nativeCode: code,
          httpStatus: error?.httpStatus ?? null,
          ...(mapped === 'SESSION_NOT_FOUND' ? { sessionId: this._sessionRef } : {}),
        },
      },
    );
  }

  _safeMessage(error) {
    const text = error?.message ?? String(error);
    if (this._client && typeof this._client.redact === 'function') return this._client.redact(text);
    return text;
  }

  async _sleep(ms) {
    if (this._closed || ms <= 0) return;
    let timer;
    await Promise.race([
      new Promise((resolve) => {
        timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
      this._closedPromise,
    ]);
    clearTimeout(timer);
  }

  _withTimeout(promise, ms, code) {
    let timer;
    return Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new BridgeError(code, `Timed out after ${ms}ms (${code}).`, { retryable: true }));
        }, Math.max(1, ms));
        timer.unref?.();
      }),
    ]).finally(() => {
      clearTimeout(timer);
    });
  }
}

export function createKimiCodeBridge(config) {
  return new KimiCodeBridge(config);
}
