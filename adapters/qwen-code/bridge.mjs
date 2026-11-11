// Qwen Code Bridge v1：把本机 `qwen serve`（http-bridge）的原生会话接进房间。
//
// 行为约束（与 adapters/contract.mjs 一致）：
// - probe 只读：只打 /health、/capabilities、/session/:id/status、/context；不建/不归档/不改会话；
// - connect 只挂接 config.nativeSessionRef：会话已 live 就按 workspace 挂成新 client，
//   已存在但不在内存就 POST /session {sessionId} 恢复；绝不创建新 id、绝不替换；
// - send 先登记 attempt 再投递（idempotencyKey=attemptId）；202 只是接收回执，
//   正文和终态全部由 SSE 事件确认（turn_complete / turn_error）；
// - 正文只累加 session_update 里 agent_message_chunk 的 text；thought / tool 一律不进正文；
// - 去重键是 (sessionId, promptId)，不是文本；
// - 断线用 Last-Event-ID + X-Qwen-Event-Epoch 续传；续不上就报 unknown，不猜；
// - session_died / 会话 404 用同一 sessionRef 恢复并重置事件基线；发送与 SSE 共用恢复锁；
//   仅明确 404 拒绝的 prompt 可按原 attemptId 重投一次，202 已接受的请求绝不自动重放；
// - cancel 幂等：RPC 被接受 ≠ attempt 已终结，最终仍由 turn_complete 确认；
// - close 只断开自己的 SSE/HTTP，不杀守护进程、不动会话。

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  BridgeError,
  VOICE_MODES,
  assertContextPacket,
  normalizeCapabilities,
  unsupportedCapability,
} from '../contract.mjs';
import { BRIDGE_EVENT_TYPES, createBridgeEvent } from '../../core/events.mjs';
import { QWEN_DEFAULT_BASE_URL, QwenDaemonClient, QwenDaemonError } from './client.mjs';

export { QWEN_DEFAULT_BASE_URL };
export const DEFAULT_BASE_URL = QWEN_DEFAULT_BASE_URL;
export const DEFAULT_CLIENT_VERSION = 'qwen-code/unknown';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
/** ACP initialize 默认 10s；恢复会话时先预热，预算给 60s（与服务端上限一致）。 */
const DEFAULT_PREHEAT_TIMEOUT_MS = 60000;
const MAX_QUEUED_EVENTS = 500;

/**
 * 恢复会话时的瞬态失败：initialize 超时、网络/Abort 超时、守护进程暂不可达。
 * 这类失败预热 ACP 后值得原样重试一次；404/参数错误等非瞬态失败不重试。
 */
export function isTransientAttachError(error) {
  if (!error) return false;
  const name = error.name ?? '';
  if (name === 'BridgeTimeoutError' || name === 'TimeoutError' || name === 'AbortError') return true;
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === 'ABORT_ERR' || /(?:^|_)timeout$/i.test(code)) return true;
  if (code === 'QWEN_DAEMON_UNREACHABLE') return true;
  const message = String(error.message ?? '');
  if (/initialize.*timeout|timeout.*initialize/i.test(message)) return true;
  if (error instanceof QwenDaemonError && (error.status === undefined || error.status === null)) return true;
  return false;
}

function isSessionMissingError(error) {
  if (!(error instanceof QwenDaemonError) || error.status !== 404) return false;
  return error.code === 'session_not_found'
    || /no session|session.*not found/i.test(String(error.message ?? ''));
}

/** 把 ACP 风格的 content 压成纯文本（只取 type=text 的块）。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  if (Array.isArray(content)) return content.map((part) => textOfContent(part)).join('');
  if (typeof content.text === 'string') return content.text;
  if (content.type === 'text' ? typeof content.text === 'string' : false) return content.text;
  return '';
}

/** 从 /context 的 state 里读模型与思考强度（只读字段，不改任何设置）。 */
export function readModelState(contextBody) {
  const state = contextBody?.state ?? {};
  const currentModelId = typeof state?.models?.currentModelId === 'string'
    ? state.models.currentModelId
    : null;
  const configOptions = Array.isArray(state.configOptions) ? state.configOptions : [];
  const effort = configOptions.find((option) => option?.id === 'reasoning_effort') ?? null;
  const mode = configOptions.find((option) => option?.id === 'mode') ?? null;
  return {
    modelId: currentModelId,
    reasoningEffort: typeof effort?.currentValue === 'string' ? effort.currentValue : null,
    permissionMode: typeof mode?.currentValue === 'string' ? mode.currentValue : null,
  };
}

/** QWEN.md 只存引用与版本，不复制正文。 */
export function readPersonaRef(home = os.homedir()) {
  const file = path.join(home, '.qwen', 'QWEN.md');
  try {
    const bytes = fs.readFileSync(file);
    return { sourceRef: file, revision: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { sourceRef: file, revision: 'missing' };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class QwenCodeBridge {
  constructor(config = {}) {
    this._baseConfig = {
      baseUrl: DEFAULT_BASE_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
      closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
      reconnectDelayMs: DEFAULT_RECONNECT_DELAY_MS,
      preheatTimeoutMs: DEFAULT_PREHEAT_TIMEOUT_MS,
      voiceMode: VOICE_MODES.EXTERNAL,
      clientFactory: null,
      fetchImpl: null,
      cwd: null,
      ...config,
    };
    this._config = this._baseConfig;
    this._sessionRef = config.nativeSessionRef ?? null;
    this._connected = false;
    this._closed = false;
    this._client = null;
    this._clientId = null;
    this._pumpAbort = null;
    this._pumpDone = null;
    this._recoveryPromise = null;
    this._subscribers = new Set();
    this._pendingEvents = [];
    this._activeAttempt = null;
    this._attempts = new Map();
    this._settledPromptIds = new Set();
    this._foreignPromptIds = new Set();
    this._cancelReceipts = new Map();
    this._lastEventId = null;
    this._eventEpoch = null;
    this._streamId = null;
    this._model = { modelId: null, reasoningEffort: null, permissionMode: null };
    this._clientVersion = DEFAULT_CLIENT_VERSION;
    this._warnings = [];
    this._health = { connected: false, lastError: null };
    this._reconnectDelayMs = this._config.reconnectDelayMs;
    this._sleep = this._config.sleep ?? sleep;
  }

  // ── Bridge v1 ─────────────────────────────────────────────────────────────

  _assertOpen() {
    if (this._closed) throw new BridgeError('BRIDGE_CLOSED', 'QwenCodeBridge 已关闭。');
  }

  _mergedConfig(config = {}) {
    return { ...this._baseConfig, ...config };
  }

  _requireSeat(config) {
    if (typeof config.seatId !== 'string' || config.seatId.length === 0) {
      throw new BridgeError('SEAT_REQUIRED', 'seatId 不能为空。');
    }
    if (typeof config.baseUrl !== 'string' || !/^https?:\/\//.test(config.baseUrl)) {
      throw new BridgeError('BASE_URL_INVALID', `baseUrl 必须是 http(s) 地址，当前：${config.baseUrl}`);
    }
  }

  _makeClient(config) {
    if (typeof config.clientFactory === 'function') return config.clientFactory(config);
    return new QwenDaemonClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    });
  }

  async probe(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    const client = this._makeClient(cfg);
    const capabilities = normalizeCapabilities({
      nativeSession: true,
      nativeIdentity: true,
      sendToExistingSession: true,
      finalMessageEvent: true,
      messageDeduplication: true,
      snapshotRecovery: true,
      foreignTurnDetection: true,
      queueClear: false,
      requestAbort: true,
      providerUsage: null,
      voiceTrigger: false,
      voiceStartedFinishedEvents: false,
      voiceStop: false,
      voiceMute: false,
    });
    const warnings = [];
    let clientVersion = cfg.clientVersion ?? DEFAULT_CLIENT_VERSION;
    let identity;
    const sessionRef = cfg.nativeSessionRef ?? this._sessionRef;
    try {
      const caps = await client.capabilities();
      if (typeof caps?.body?.qwenCodeVersion === 'string') clientVersion = caps.body.qwenCodeVersion;
      const features = Array.isArray(caps?.body?.features) ? caps.body.features : [];
      if (!features.includes('session_id_override')) {
        warnings.push('守护进程未声明 session_id_override：只能挂接已 live 的会话，无法在重启后恢复同一 id。');
      }
    } catch (error) {
      warnings.push(`无法读取 /capabilities：${error?.message ?? error}`);
    }
    if (typeof sessionRef === 'string' && sessionRef.length > 0) {
      try {
        const status = await client.sessionStatus(sessionRef);
        const context = await client.sessionContext(sessionRef);
        this._model = readModelState(context?.body);
        identity = this._identityFor(cfg, sessionRef);
      } catch (error) {
        if (!(error instanceof QwenDaemonError && error.status === 404)) {
          throw new BridgeError(
            'PROBE_FAILED',
            `无法读取 Qwen 会话 ${sessionRef}：${error?.message ?? error}`,
            { retryable: true },
          );
        }
        warnings.push(`会话 ${sessionRef} 当前不在守护进程内存里（connect 时会尝试恢复）。`);
      }
    }
    return {
      capabilities,
      ...(identity ? { identity } : {}),
      clientVersion,
      voiceMode: cfg.voiceMode ?? VOICE_MODES.EXTERNAL,
      warnings,
    };
  }

  async connect(config = {}) {
    this._assertOpen();
    if (this._connected) return;
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    const sessionRef = cfg.nativeSessionRef ?? this._sessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError(
        'SESSION_REQUIRED',
        'connect() 需要 nativeSessionRef：QwenCodeBridge 不会主动创建新会话。',
      );
    }
    this._sessionRef = sessionRef;
    this._config = cfg;
    const client = this._makeClient(cfg);
    this._client = client;

    await this._waitHealthy(client, cfg);
    const attach = await this._attachSession(client, cfg, sessionRef);
    this._clientId = attach.clientId ?? null;
    this._clientVersion = cfg.clientVersion ?? this._clientVersion;
    try {
      const context = await client.sessionContext(sessionRef);
      this._model = readModelState(context?.body);
    } catch (error) {
      this._warnings.push(`连接后读 context 失败：${error?.message ?? error}`);
    }
    this._connected = true;
    this._health.connected = true;
    this._startPump(client, sessionRef);
  }

  async _waitHealthy(client, cfg) {
    const deadline = Date.now() + (cfg.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);
    let lastError = null;
    for (;;) {
      try {
        await client.health({ timeoutMs: 1500 });
        return;
      } catch (error) {
        lastError = error;
        if (Date.now() >= deadline) {
          throw new BridgeError(
            'QWEN_DAEMON_UNREACHABLE',
            `连不上 Qwen 守护进程 ${cfg.baseUrl}：${lastError?.message ?? lastError}`,
            { retryable: true, details: { baseUrl: cfg.baseUrl } },
          );
        }
        await this._sleep(300);
      }
    }
  }

  async _attachSession(client, cfg, sessionRef) {
    let status = null;
    try {
      status = await client.sessionStatus(sessionRef);
    } catch (error) {
      if (!(error instanceof QwenDaemonError && error.status === 404)) throw error;
    }
    const body = { cwd: cfg.cwd ?? null };
    if (status === null) {
      // 会话不在内存、但可能已持久化：用 /resume 按 id 恢复（绝不新建 id）。
      if (!body.cwd) {
        throw new BridgeError(
          'CWD_REQUIRED',
          '恢复 Qwen 会话需要 client.cwd（该 workspace 的绝对路径）。',
        );
      }
      let resumed;
      try {
        resumed = await this._resumeSession(client, cfg, sessionRef, body.cwd);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError(
          'SESSION_NOT_FOUND',
          `按 id 恢复 Qwen 会话 ${sessionRef} 失败：${error?.message ?? error}`,
          { retryable: error?.status === undefined || error?.status >= 500 },
        );
      }
      const returnedId = resumed?.body?.sessionId;
      if (returnedId !== sessionRef) {
        throw new BridgeError(
          'SESSION_MISMATCH',
          `守护进程返回了 ${returnedId}，与配置的 ${sessionRef} 不一致，已拒绝继续。`,
        );
      }
      return { ...resumed.body, clientId: resumed?.body?.clientId ?? null };
    }
    // 会话已 live：也按 id 调 /resume（服务端返回同一 id + attached:true + 新 clientId）。
    // 绝不 createOrAttachSession({cwd})：那会让服务端挑会话，可能挂到别的 id。
    if (!body.cwd) {
      throw new BridgeError(
        'CWD_REQUIRED',
        '挂接已 live 的 Qwen 会话需要 client.cwd（该 workspace 的绝对路径）。',
      );
    }
    let attached;
    try {
      attached = typeof client.resumeSession === 'function'
        ? await this._resumeSession(client, cfg, sessionRef, body.cwd)
        : await client.createOrAttachSession({ cwd: body.cwd });
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError(
        'SESSION_RESUME_FAILED',
        `挂接已 live 的 Qwen 会话 ${sessionRef} 失败：${error?.message ?? error}`,
        { retryable: error?.status === undefined || error?.status >= 500, details: { sessionRef, phase: 'attach' } },
      );
    }
    const returnedId = attached?.body?.sessionId;
    if (returnedId !== sessionRef) {
      throw new BridgeError(
        'SESSION_MISMATCH',
        `守护进程挂到了 ${returnedId}，与配置的 ${sessionRef} 不一致，已拒绝继续。`,
      );
    }
    return { ...attached.body, attached: true, clientId: attached?.body?.clientId ?? null };
  }

  _resumeOnce(client, sessionRef, cwd) {
    return typeof client.resumeSession === 'function'
      ? client.resumeSession(sessionRef, { cwd })
      : client.createOrAttachSession({ cwd, sessionId: sessionRef });
  }

  /**
   * 按 id 恢复：瞬态失败（initialize 超时等）先预热 ACP，再原样重试一次；
   * 仍失败抛 SESSION_RESUME_FAILED（retryable=true）。非瞬态失败原样抛出，
   * 由调用方保持旧的 SESSION_NOT_FOUND 语义。
   */
  async _resumeSession(client, cfg, sessionRef, cwd) {
    try {
      return await this._resumeOnce(client, sessionRef, cwd);
    } catch (error) {
      if (!isTransientAttachError(error) || typeof client.workspaceAcpPreheat !== 'function') throw error;
      const preheatTimeoutMs = cfg.preheatTimeoutMs ?? DEFAULT_PREHEAT_TIMEOUT_MS;
      try {
        await client.workspaceAcpPreheat({ timeoutMs: preheatTimeoutMs });
      } catch (preheatError) {
        throw new BridgeError(
          'SESSION_RESUME_FAILED',
          `按 id 恢复 Qwen 会话 ${sessionRef} 遇到瞬态失败（${error?.message ?? error}），`
            + `ACP 预热也失败（${preheatError?.message ?? preheatError}）。`,
          { retryable: true, details: { sessionRef, phase: 'preheat' } },
        );
      }
      try {
        return await this._resumeOnce(client, sessionRef, cwd);
      } catch (retryError) {
        throw new BridgeError(
          'SESSION_RESUME_FAILED',
          `按 id 恢复 Qwen 会话 ${sessionRef} 失败（已预热 ACP 并重试一次）：`
            + `${retryError?.message ?? retryError}`,
          { retryable: true, details: { sessionRef, phase: 'resume' } },
        );
      }
    }
  }

  async _recoverSession() {
    if (this._recoveryPromise) return this._recoveryPromise;
    const promise = this._recoverSessionOnce();
    this._recoveryPromise = promise;
    try {
      await promise;
    } finally {
      if (this._recoveryPromise === promise) this._recoveryPromise = null;
    }
  }

  async _recoverSessionOnce() {
    this._assertOpen();
    const attach = await this._attachSession(this._client, this._config, this._sessionRef);
    this._assertOpen();
    this._clientId = attach.clientId ?? null;
    this._lastEventId = null;
    this._eventEpoch = null;
    this._streamId = null;
    this._pumpAbort?.abort();
    this._health.connected = true;
    this._health.lastError = null;
    this._startPump(this._client, this._sessionRef);
  }

  async getIdentity() {
    const sessionRef = this._sessionRef ?? this._config.nativeSessionRef ?? null;
    if (sessionRef === null) {
      throw new BridgeError('IDENTITY_UNAVAILABLE', '没有可用的 Qwen 原生会话引用。');
    }
    return this._identityFor(this._config, sessionRef);
  }

  _identityFor(cfg, sessionRef) {
    const persona = readPersonaRef();
    const metadata = {
      sessionId: sessionRef,
      ...(cfg.cwd ? { workspaceCwd: cfg.cwd } : {}),
      ...(this._model.modelId ? { model: this._model.modelId } : {}),
      ...(this._model.reasoningEffort ? { reasoningEffort: this._model.reasoningEffort } : {}),
      ...(this._model.permissionMode ? { permissionMode: this._model.permissionMode } : {}),
      personaSource: persona.sourceRef,
      personaRevision: persona.revision,
    };
    const revision = createHash('sha256')
      .update(JSON.stringify({ seatId: cfg.seatId, sessionRef, metadata }))
      .digest('hex');
    return {
      sourceRef: persona.sourceRef,
      revision,
      nativeSessionRef: sessionRef,
      metadata,
    };
  }

  async createNativeSession() {
    this._assertOpen();
    const cwd = this._config.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new BridgeError('CWD_REQUIRED', '创建 Qwen 会话需要 client.cwd。');
    }
    const created = await this._client.createOrAttachSession({ cwd });
    const nativeSessionRef = created?.body?.sessionId ?? null;
    if (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0) {
      throw new BridgeError('SESSION_CREATE_FAILED', 'Qwen 创建会话的响应缺少 sessionId。');
    }
    await this._client.sessionStatus(nativeSessionRef);
    return { nativeSessionRef };
  }

  async send(packet) {
    this._assertOpen();
    if (!this._connected) {
      throw new BridgeError('BRIDGE_NOT_CONNECTED', '调用 send() 前必须先 connect()。');
    }
    assertContextPacket(packet);
    if (this._activeAttempt && this._activeAttempt.status === 'running') {
      throw new BridgeError('BRIDGE_BUSY', '该席位同时只能有一个在飞 attempt。', {
        details: { attemptId: this._activeAttempt.attemptId },
      });
    }
    const attempt = {
      attemptId: packet.attemptId,
      promptId: null,
      status: 'running',
      text: '',
      nativeTurnRef: null,
      startedAt: new Date().toISOString(),
      cancelRequested: false,
      cancelAccepted: false,
    };
    this._attempts.set(attempt.attemptId, attempt);
    this._activeAttempt = attempt;

    try {
      const deliver = () => this._client.prompt(this._sessionRef, {
        text: packet.text,
        idempotencyKey: packet.attemptId,
        clientId: this._clientId,
      });
      let response;
      try {
        response = await deliver();
      } catch (error) {
        if (!isSessionMissingError(error)) throw error;
        await this._recoverSession();
        response = await deliver();
      }
      if (response.status === 202 && response.body?.promptId) {
        attempt.promptId = response.body.promptId;
        attempt.nativeTurnRef = this._nativeTurnRef(attempt.promptId);
        if (Number.isSafeInteger(response.body.lastEventId)) {
          this._noteEventId(response.body.lastEventId);
        }
        if (typeof response.body.eventEpoch === 'string') this._eventEpoch = response.body.eventEpoch;
        this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_STARTED, attempt.attemptId, {
          nativeTurnRef: attempt.nativeTurnRef,
        });
        return {
          attemptId: attempt.attemptId,
          accepted: true,
          nativeRequestRef: attempt.promptId,
        };
      }
      // 极少数情况会同步返回（非 202）：按「已接受但终态未知」处理，等事件。
      attempt.nativeTurnRef = attempt.nativeTurnRef ?? this._nativeTurnRef(packet.attemptId);
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_STARTED, attempt.attemptId, {
        nativeTurnRef: attempt.nativeTurnRef,
      });
      return { attemptId: attempt.attemptId, accepted: true, nativeRequestRef: packet.attemptId };
    } catch (error) {
      this._settleAttempt(attempt, 'failed', {
        error: {
          code: error?.code ?? 'PROMPT_REJECTED',
          message: error?.message ?? String(error),
          retryable: error?.status === undefined || error?.status >= 500,
        },
      });
      throw new BridgeError(
        error?.code ?? 'PROMPT_REJECTED',
        `投递 Qwen prompt 失败：${error?.message ?? error}`,
        { retryable: error?.status === undefined || error?.status >= 500 },
      );
    }
  }

  subscribe() {
    const initial = this._pendingEvents;
    this._pendingEvents = [];
    const subscriber = { queue: initial, wake: null, closed: this._closed };
    if (!this._closed) this._subscribers.add(subscriber);
    const generator = this._iterate(subscriber);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => generator.next(),
      return: (value) => {
        subscriber.closed = true;
        this._subscribers.delete(subscriber);
        const wake = subscriber.wake;
        subscriber.wake = null;
        wake?.();
        return generator.return(value);
      },
      throw: (error) => generator.throw(error),
    };
  }

  async *_iterate(subscriber) {
    for (;;) {
      if (subscriber.queue.length > 0) {
        yield subscriber.queue.shift();
        continue;
      }
      if (subscriber.closed || this._closed) return;
      await new Promise((resolve) => {
        subscriber.wake = resolve;
      });
    }
  }

  _emit(type, attemptId = null, payload = {}) {
    if (this._closed && type !== BRIDGE_EVENT_TYPES.BRIDGE_CLOSED) return null;
    const event = createBridgeEvent({
      type,
      seatId: this._config.seatId,
      attemptId,
      payload,
    });
    if (this._subscribers.size === 0) {
      this._pendingEvents.push(event);
      if (this._pendingEvents.length > MAX_QUEUED_EVENTS) this._pendingEvents.shift();
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

  // ── SSE 泵 ────────────────────────────────────────────────────────────────

  _startPump(client, sessionRef) {
    const abort = new AbortController();
    this._pumpAbort = abort;
    this._pumpDone = (async () => {
      let delay = this._reconnectDelayMs;
      while (!this._closed && !abort.signal.aborted) {
        try {
          for await (const event of client.subscribeEvents(sessionRef, {
            clientId: this._clientId,
            signal: abort.signal,
            lastEventId: this._lastEventId,
            epoch: this._eventEpoch,
            onStreamInfo: (info) => {
              if (info?.streamId) this._streamId = info.streamId;
              if (info?.epoch) this._eventEpoch = info.epoch;
            },
          })) {
            if (this._closed) return;
            this._noteEventId(event.id);
            this._handleEvent(event);
            delay = this._reconnectDelayMs;
          }
        } catch (error) {
          if (this._closed || abort.signal.aborted) return;
          if (isSessionMissingError(error)) {
            try {
              await this._recoverSession();
              continue;
            } catch (recoveryError) {
              error = recoveryError;
            }
          }
          this._health.lastError = error?.message ?? String(error);
          this._emit(BRIDGE_EVENT_TYPES.BRIDGE_ERROR, null, {
            error: {
              code: error?.code ?? 'QWEN_EVENTS_ERROR',
              message: error?.message ?? String(error),
              retryable: true,
            },
          });
        }
        if (this._closed || abort.signal.aborted) return;
        await this._sleep(delay);
        delay = Math.min(delay * 2, 15000);
      }
    })().catch((error) => {
      if (!this._closed) {
        this._emit(BRIDGE_EVENT_TYPES.BRIDGE_ERROR, null, {
          error: {
            code: 'QWEN_PUMP_CRASHED',
            message: error?.message ?? String(error),
            retryable: true,
          },
        });
      }
    });
  }

  _noteEventId(id) {
    if (!Number.isSafeInteger(id)) return;
    if (this._lastEventId === null || id > this._lastEventId) this._lastEventId = id;
  }

  _nativeTurnRef(promptId) {
    return `${this._sessionRef}#prompt:${promptId}`;
  }

  _handleEvent(event) {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'session_update') {
      this._handleSessionUpdate(event);
      return;
    }
    if (event.type === 'turn_complete') {
      this._handleTurnComplete(event);
      return;
    }
    if (event.type === 'turn_error') {
      this._handleTurnError(event);
      return;
    }
    if (event.type === 'session_closed' || event.type === 'session_died') {
      this._handleSessionGone(event);
      return;
    }
    if (event.type === 'model_switched') {
      const model = event.data?.modelId ?? event.data?.model ?? null;
      if (typeof model === 'string' && model.length > 0) this._model.modelId = model;
      return;
    }
    if (event.type === 'permission_request') {
      this._handlePermissionRequest(event);
    }
  }

  _handleSessionUpdate(event) {
    const update = event.data?.update;
    if (!update || typeof update !== 'object') return;
    if (update.sessionUpdate !== 'agent_message_chunk') return;
    const text = textOfContent(update.content);
    if (text.length === 0) return;
    const attempt = this._activeAttempt;
    if (!attempt || attempt.status !== 'running') return; // 非房间回合的正文：不进房间
    attempt.text += text;
  }

  _handleTurnComplete(event) {
    const promptId = event.data?.promptId;
    if (typeof promptId !== 'string' || promptId.length === 0) return;
    const attempt = this._activeAttempt;
    const matches = attempt && attempt.status === 'running'
      && (attempt.promptId === null || attempt.promptId === promptId);
    if (!matches) {
      this._emitForeignTurn(promptId);
      return;
    }
    if (attempt.promptId === null) attempt.promptId = promptId;
    const stopReason = event.data?.stopReason ?? 'end_turn';
    if (stopReason === 'end_turn' || stopReason === 'end-turn' || stopReason === 'success') {
      this._settleAttempt(attempt, 'completed', { nativeTurnRef: this._nativeTurnRef(promptId) });
      return;
    }
    this._settleAttempt(attempt, 'aborted', {
      nativeTurnRef: this._nativeTurnRef(promptId),
      partialText: attempt.text,
      reason: stopReason,
    });
  }

  _handleTurnError(event) {
    const promptId = event.data?.promptId ?? null;
    const attempt = this._activeAttempt;
    const matches = attempt && attempt.status === 'running'
      && (attempt.promptId === null || attempt.promptId === promptId);
    if (!matches) {
      if (typeof promptId === 'string') this._emitForeignTurn(promptId);
      return;
    }
    const error = {
      code: typeof event.data?.code === 'string' ? event.data.code : 'TURN_ERROR',
      message: typeof event.data?.message === 'string' ? event.data.message : 'Qwen 回合失败。',
      retryable: event.data?.retryable === true,
    };
    this._settleAttempt(attempt, 'failed', {
      error,
      nativeTurnRef: promptId ? this._nativeTurnRef(promptId) : undefined,
      partialText: attempt.text,
    });
  }

  _handleSessionGone(event) {
    const message = event.type === 'session_died'
      ? 'Qwen 会话进程已退出。'
      : 'Qwen 会话已关闭。';
    this._health.connected = false;
    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_ERROR, null, {
      error: { code: 'QWEN_SESSION_GONE', message, retryable: true },
    });
    const attempt = this._activeAttempt;
    if (attempt && attempt.status === 'running') {
      this._settleAttempt(attempt, 'failed', {
        error: { code: 'QWEN_SESSION_GONE', message, retryable: true },
        partialText: attempt.text,
      });
    }
  }

  _handlePermissionRequest(event) {
    const attempt = this._activeAttempt;
    const message = 'Qwen 请求工具/权限审批：房间无法代答，请在 Qwen Code 客户端处理后再试。';
    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_ERROR, null, {
      error: { code: 'QWEN_PERMISSION_REQUIRED', message, retryable: false },
    });
    if (attempt && attempt.status === 'running') {
      this._settleAttempt(attempt, 'failed', {
        error: { code: 'QWEN_PERMISSION_REQUIRED', message, retryable: false },
        partialText: attempt.text,
      });
    }
  }

  _emitForeignTurn(promptId) {
    if (this._foreignPromptIds.has(promptId)) return;
    this._foreignPromptIds.add(promptId);
    this._emit(BRIDGE_EVENT_TYPES.FOREIGN_TURN, null, {
      nativeTurnRef: this._nativeTurnRef(promptId),
      reason: 'prompt-not-ours',
    });
  }

  _settleAttempt(attempt, status, { error, reason, partialText, nativeTurnRef } = {}) {
    if (!attempt || attempt.status !== 'running') return;
    attempt.status = status;
    attempt.endedAt = new Date().toISOString();
    if (typeof nativeTurnRef === 'string') attempt.nativeTurnRef = nativeTurnRef;
    if (this._activeAttempt === attempt) this._activeAttempt = null;
    if (attempt.promptId) this._settledPromptIds.add(attempt.promptId);
    const base = {
      nativeTurnRef: attempt.nativeTurnRef ?? this._nativeTurnRef(attempt.attemptId),
    };
    if (status === 'completed') {
      const text = attempt.text;
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_COMPLETED, attempt.attemptId, {
        ...base,
        nativeMessageRef: `${base.nativeTurnRef}:message`,
        text,
      });
    } else if (status === 'aborted') {
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_ABORTED, attempt.attemptId, {
        ...base,
        partialText: typeof partialText === 'string' ? partialText : attempt.text,
        ...(reason ? { reason } : {}),
      });
    } else {
      this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, {
        ...base,
        error: error ?? { code: 'QWEN_ATTEMPT_FAILED', message: 'Qwen 回合失败。', retryable: false },
        ...(typeof partialText === 'string' ? { partialText } : {}),
      });
    }
    const receipt = this._cancelReceipts.get(attempt.attemptId);
    if (receipt) receipt.settlement = status === 'aborted' ? 'confirmed' : 'failed';
  }

  async cancel(attemptId) {
    this._assertOpen();
    if (typeof attemptId !== 'string' || attemptId.length === 0) {
      throw new BridgeError('ATTEMPT_ID_REQUIRED', 'cancel() 需要 attemptId。');
    }
    const cached = this._cancelReceipts.get(attemptId);
    const attempt = this._attempts.get(attemptId);
    if (!attempt || attempt.status !== 'running') {
      if (cached) return { ...cached };
      return {
        attemptId,
        accepted: false,
        settlement: 'failed',
        error: { code: 'ATTEMPT_NOT_RUNNING', message: '该 attempt 不存在或已终结。', retryable: false },
      };
    }
    if (cached) return { ...cached };
    attempt.cancelRequested = true;
    const receipt = {
      attemptId,
      accepted: false,
      settlement: 'pending',
      ...(attempt.nativeTurnRef ? { nativeTurnRef: attempt.nativeTurnRef } : {}),
    };
    this._cancelReceipts.set(attemptId, receipt);
    try {
      await this._client.cancel(this._sessionRef, { clientId: this._clientId, cancelReason: 'interrupted' });
      attempt.cancelAccepted = true;
      receipt.accepted = true;
      return { ...receipt };
    } catch (error) {
      receipt.accepted = false;
      receipt.settlement = 'failed';
      receipt.error = {
        code: error?.code ?? 'CANCEL_FAILED',
        message: error?.message ?? String(error),
        retryable: error?.status === undefined || error?.status >= 500,
      };
      return { ...receipt };
    }
  }

  async setMuted() {
    return unsupportedCapability('voiceMute');
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._health.connected = false;
    try {
      this._pumpAbort?.abort();
    } catch {
      // ignore
    }
    try {
      await Promise.race([this._pumpDone, this._sleep(this._config.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS)]);
    } catch {
      // ignore
    }
    this._pumpAbort = null;
    this._pumpDone = null;
    const attempt = this._activeAttempt;
    if (attempt && attempt.status === 'running') {
      // 关闭不等于取消：不伪造终态，交给 Core 以 unknown 结算。
      attempt.status = 'unknown';
      this._activeAttempt = null;
    }
    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_CLOSED, null, { reason: 'closed' });
    for (const subscriber of this._subscribers) {
      subscriber.closed = true;
      const wake = subscriber.wake;
      subscriber.wake = null;
      wake?.();
    }
    this._subscribers.clear();
  }

  /** 只读健康快照，供房间状态展示。 */
  snapshot() {
    return {
      seatId: this._config.seatId,
      nativeSessionRef: this._sessionRef,
      connected: this._connected && this._health.connected && !this._closed,
      closed: this._closed,
      model: { ...this._model },
      lastEventId: this._lastEventId,
      eventEpoch: this._eventEpoch,
      streamId: this._streamId,
      activeAttemptId: this._activeAttempt?.attemptId ?? null,
      warnings: [...this._warnings],
      lastError: this._health.lastError,
    };
  }
}

export function createQwenCodeBridge(config) {
  return new QwenCodeBridge(config);
}

export default createQwenCodeBridge;
