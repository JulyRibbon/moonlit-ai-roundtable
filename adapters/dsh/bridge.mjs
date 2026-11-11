// DSH Bridge v1 实现。
//
// 只使用 adapters/dsh/dsh-client.mjs 的公开门面（NodeApiClient / callUnary /
// events.mux / events.follow）与公开解析函数（createTurnCollector、
// inboxItemsOfProjections、inboxItemIds），不发明协议字段。
//
// 关键约束：
// - probe 只读：sessions.list 确认会话存在，绝不创建/归档会话，不产生模型调用；
// - connect 等待首个快照基线就位；send 也等待基线，再记录「发送时最新 turn」；
// - send 先登记 pending attempt 与 collector，再 sessions.prompt；
// - prompt 的 accepted:true 只是接收回执，正文与终态全部由 turn/end 事件确认；
// - attempt 只能按「该会话下一个新 turn」绑定（prompt 不返回 turn id）；
// - 快照不重放旧历史，但必须把断线前在途 attempt 的 Completed/Aborted/Failed
//   按快照正文恰好结算一次；
// - 去重键是 (sessionId, turn)，不是正文；
// - 无 pending attempt 的新 turn 只发 ForeignTurn，绝不进字幕。

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
  NodeApiClient,
  createTurnCollector,
  inboxItemIds,
  inboxItemsOfProjections,
} from './dsh-client.mjs';
import { createTurnLedger, messageKeyFor, turnKey } from './dedupe.mjs';

const DEFAULT_BASE_URL = 'http://127.0.0.1:2955';
export const DSH_DEFAULT_BASE_URL = DEFAULT_BASE_URL;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 5000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2000;

const DSH_CAPABILITIES = Object.freeze({
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
  voiceTrigger: false,
  voiceStartedFinishedEvents: false,
  voiceStop: false,
  voiceMute: false,
});

export function nativeTurnRefFor(sessionId, turn) {
  return `${sessionId}#turn:${turn}`;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function errorPayload(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'DSH_BRIDGE_ERROR',
    message: typeof error?.message === 'string' ? error.message : String(error),
    retryable: error?.retryable === true,
  };
}

function reasonKindOf(data) {
  const reason = data?.reason;
  if (typeof reason === 'string') return reason;
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind;
  return null;
}

function recordEventsOf(snapshot) {
  const records = snapshot?.records ?? snapshot?.events;
  if (!Array.isArray(records)) return [];
  const events = [];
  for (const record of records) {
    let event = record;
    if (event && event.type === 'event' && event.event) event = event.event;
    else if (event && !event.type && event.event) event = event.event;
    if (event && typeof event.type === 'string') events.push(event);
  }
  return events;
}

function syntheticStart(turn) {
  return { type: 'turn/start', data: { turn } };
}

function modelSelectionOf(values) {
  const selection = values?.modelSelection;
  if (!selection || typeof selection !== 'object') {
    return { provider: null, model: null, reasoningEffort: null };
  }
  // 真实 DSH 投影形状是 { lastUsed, next }；旧版/测试 fixture 是扁平 { provider, model }。
  // 优先 lastUsed，其次 next，最后扁平结构兜底。
  for (const candidate of [selection.lastUsed, selection.next, selection]) {
    if (!candidate || typeof candidate !== 'object') continue;
    const provider = typeof candidate.provider === 'string' ? candidate.provider : null;
    const model = typeof candidate.model === 'string' ? candidate.model : null;
    if (provider === null && model === null) continue;
    return {
      provider,
      model,
      reasoningEffort: typeof candidate.reasoningEffort === 'string' ? candidate.reasoningEffort : null,
    };
  }
  return { provider: null, model: null, reasoningEffort: null };
}

export class DshBridge {
  constructor(config = {}) {
    this._config = { ...config };
    this._api = config.api ?? null;
    this._apiFactory = config.apiFactory ?? null;
    this._sessionRef = config.nativeSessionRef ?? null;
    this._sessionSummary = null;

    this._connected = false;
    this._closed = false;
    this._connectPromise = null;
    this._closePromise = null;

    this._collector = createTurnCollector();
    this._ledger = createTurnLedger();
    this._finishedTurns = new Set();

    this._attempts = new Map();
    this._turnToAttempt = new Map();
    this._activeAttempt = null;

    // 发送时回合基线：记录发送前见过的最大 turn 与全部 turn 值。
    this._latestTurn = null;
    this._seenTurnValues = new Set();

    // 首个快照基线门槛：connect 与 send 都等它，避免把旧历史误绑到新 attempt。
    this._baselineReady = null;
    this._resolveBaseline = null;
    this._baselineSettled = false;

    this._lastSnapshotFingerprint = null;

    this._pendingEvents = [];
    this._subscribers = new Set();

    this._pumpAbort = null;
    this._pumpPromise = null;
    this._reconnectDelayMs = Number.isFinite(config.reconnectDelayMs)
      ? Math.max(0, config.reconnectDelayMs)
      : DEFAULT_RECONNECT_DELAY_MS;
    this._snapshotTimeoutMs = Number.isFinite(config.snapshotReadyTimeoutMs)
      ? Math.max(1, config.snapshotReadyTimeoutMs)
      : DEFAULT_SNAPSHOT_TIMEOUT_MS;
    this._closeTimeoutMs = Number.isFinite(config.closeTimeoutMs)
      ? Math.max(1, config.closeTimeoutMs)
      : DEFAULT_CLOSE_TIMEOUT_MS;

    this._closedPromise = new Promise((resolve) => {
      this._resolveClosed = resolve;
    });
  }

  // ── Bridge v1 接口 ──────────────────────────────────────────────────────────

  /** 只读探测：确认原生会话存在，汇报能力与身份元数据；不启动事件泵。 */
  async probe(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    const sessionRef = cfg.nativeSessionRef ?? this._sessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError('SESSION_REQUIRED', 'probe() requires nativeSessionRef.');
    }

    const api = await this._resolveApi(cfg);
    let summary;
    try {
      summary = await this._fetchSession(api, sessionRef);
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('SESSION_LIST_FAILED', `Unable to list DSH sessions: ${error?.message ?? error}`, {
        retryable: true,
        details: { cause: String(error?.message ?? error) },
      });
    }

    return {
      capabilities: normalizeCapabilities(DSH_CAPABILITIES),
      identity: this._buildIdentity(summary, sessionRef),
      clientVersion: cfg.clientVersion ?? api.clientVersion ?? null,
      voiceMode: VOICE_MODES.NONE,
      warnings: [],
    };
  }

  /**
   * 连接既有原生会话并启动事件泵；不创建、不归档、不替换会话。
   * 返回前等待首个快照基线，避免调用方在历史未就位时投递。
   */
  async connect(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    this._requireSeat(cfg);
    this._config = cfg;
    if (this._connected) return;
    if (this._connectPromise) return this._connectPromise;

    this._connectPromise = (async () => {
      const sessionRef = cfg.nativeSessionRef ?? this._sessionRef;
      if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
        throw new BridgeError('SESSION_REQUIRED', 'connect() requires nativeSessionRef; this bridge never creates sessions.');
      }

      const api = await this._resolveApi(cfg);
      let summary;
      try {
        summary = await this._fetchSession(api, sessionRef);
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('SESSION_LIST_FAILED', `Unable to list DSH sessions: ${error?.message ?? error}`, {
          retryable: true,
          details: { cause: String(error?.message ?? error) },
        });
      }

      this._api = api;
      this._sessionRef = sessionRef;
      this._sessionSummary = summary;
      this._collector = createTurnCollector();
      this._baselineReady = new Promise((resolve) => {
        this._resolveBaseline = resolve;
      });
      this._baselineSettled = false;
      this._connected = true;
      this._startPump();

      try {
        await this._waitForBaseline();
      } catch (error) {
        this._connected = false;
        try {
          this._pumpAbort?.abort();
        } catch {
          // 泵已经结束时 abort 是空操作。
        }
        throw error;
      }
    })();

    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /** 原生身份引用与版本；只含名称 / preset / cwd / model 等元数据，无人格正文。 */
  async getIdentity() {
    this._assertOpen();
    const sessionRef = this._sessionRef ?? this._config.nativeSessionRef;
    if (typeof sessionRef !== 'string' || sessionRef.length === 0) {
      throw new BridgeError('IDENTITY_UNAVAILABLE', 'No native session reference is available.');
    }

    const api = await this._resolveApi(this._config);
    try {
      const summary = await this._fetchSession(api, sessionRef);
      this._sessionSummary = summary;
      return this._buildIdentity(summary, sessionRef);
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'SESSION_NOT_FOUND') throw error;
      if (this._sessionSummary) return this._buildIdentity(this._sessionSummary, sessionRef);
      throw new BridgeError('IDENTITY_UNAVAILABLE', `Unable to read DSH identity: ${error?.message ?? error}`, {
        retryable: true,
        details: { cause: String(error?.message ?? error) },
      });
    }
  }

  async createNativeSession(config = {}) {
    this._assertOpen();
    const cfg = this._mergedConfig(config);
    const api = await this._resolveApi(cfg);
    const current = await this._fetchSession(api, this._sessionRef);
    const cwd = cfg.cwd ?? current.cwd;
    if (typeof cwd !== 'string' || cwd.length === 0) {
      throw new BridgeError('CWD_REQUIRED', '创建 DSH 会话需要沿用当前会话的 cwd。');
    }
    const agentPreset = cfg.agentPreset
      ?? current.agentPreset
      ?? current.projections?.values?.agentPreset
      ?? null;
    const response = await api.sessions.create({
      cwd,
      ...(typeof agentPreset === 'string' && agentPreset.length > 0 ? { agentPreset } : {}),
    });
    const result = response?.result;
    if (result?.ok !== true) {
      throw new BridgeError('SESSION_CREATE_FAILED', `DSH 创建会话失败：${result?.error?.message ?? '未知错误'}`);
    }
    const value = result.value ?? {};
    const nativeSessionRef = value.sessionId ?? value.id ?? value.session?.sessionId ?? null;
    if (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0) {
      throw new BridgeError('SESSION_CREATE_FAILED', 'DSH 创建会话的响应缺少 sessionId。');
    }
    await this._fetchSession(api, nativeSessionRef);
    return { nativeSessionRef };
  }

  /**
   * 等待首个快照基线 → 登记 pending attempt 与 collector → 记录发送时 turn 基线
   * → sessions.prompt。返回的 accepted 只表示客户端已接收；最终回复必须等事件。
   */
  async send(packet) {
    this._assertOpen();
    if (!this._connected && this._connectPromise) await this._connectPromise;
    this._assertOpen();
    if (!this._connected) {
      throw new BridgeError('BRIDGE_NOT_CONNECTED', 'connect() must be called before send().');
    }
    await this._waitForBaseline();
    this._assertOpen();
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
      boundTurn: null,
      nativeTurnRef: null,
      lastMessageId: null,
      seenMessageKeys: new Set(),
      // 发送时基线：恢复只认比它更新、且发送前没见过的 turn。
      baselineTurn: this._latestTurn,
      baselineTurns: new Set(this._seenTurnValues),
      packet: { ...packet },
      cancelReceipt: null,
      cancelPromise: null,
    };
    // 先登记再投递：turn/start 可能比 prompt 的 HTTP 响应更早到。
    this._attempts.set(attempt.attemptId, attempt);
    this._activeAttempt = attempt;

    let response;
    try {
      response = await this._api.sessions.prompt({
        sessionId: this._sessionRef,
        mode: 'queue',
        content: [{ type: 'text', text: packet.text }],
      });
    } catch (error) {
      this._abandonAttempt(attempt, {
        code: typeof error?.code === 'string' ? error.code : 'PROMPT_FAILED',
        message: String(error?.message ?? error),
        retryable: true,
      });
      throw new BridgeError(
        typeof error?.code === 'string' ? error.code : 'PROMPT_FAILED',
        `sessions.prompt failed: ${error?.message ?? error}`,
        { retryable: true, details: { cause: String(error?.message ?? error) } },
      );
    }

    const result = response?.result;
    if (result?.ok !== true || result?.value?.accepted !== true) {
      const rpcError = result?.error ?? {};
      const payload = {
        code: typeof rpcError.code === 'string' ? rpcError.code : 'PROMPT_NOT_ACCEPTED',
        message: typeof rpcError.message === 'string' ? rpcError.message : 'sessions.prompt was not accepted.',
        retryable: rpcError.retryable === true,
      };
      this._abandonAttempt(attempt, payload);
      throw new BridgeError(payload.code, payload.message, {
        retryable: payload.retryable,
        details: { attemptId: attempt.attemptId },
      });
    }

    const receipt = { attemptId: attempt.attemptId, accepted: true };
    if (typeof response?.rpcId === 'string' && response.rpcId.length > 0) {
      receipt.nativeRequestRef = response.rpcId;
    }
    return receipt;
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

  /**
   * 幂等取消：先读 inbox 并逐项 remove，再 session/cancel。
   * 返回的 settlement 是 RPC 层面的真实结果；最终 aborted 由 turn/end 事件确认。
   */
  async cancel(attemptId) {
    const attempt = this._attempts.get(attemptId);
    if (!attempt) {
      return {
        attemptId,
        accepted: false,
        settlement: 'failed',
        error: { code: 'ATTEMPT_NOT_FOUND', message: `Unknown attempt: ${attemptId}`, retryable: false },
      };
    }
    if (attempt.status === 'aborted') {
      return this._abortedReceipt(attempt);
    }
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

  /**
   * 幂等关闭：先标记 closed、发 BridgeClosed、唤醒订阅者，再 abort 事件泵并
   * 等待它真正退出；不归档、不删除原生会话。
   */
  async close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;
    this._connected = false;
    this._resolveClosed?.();
    this._resolveBaseline?.();

    const pump = this._pumpPromise;
    try {
      this._pumpAbort?.abort();
    } catch {
      // 事件泵已经结束时 abort 是空操作。
    }

    this._emit(BRIDGE_EVENT_TYPES.BRIDGE_CLOSED, null, { reason: 'closed' });
    for (const subscriber of this._subscribers) {
      subscriber.closed = true;
      const wake = subscriber.wake;
      subscriber.wake = null;
      wake?.();
    }
    this._subscribers.clear();

    this._closePromise = (async () => {
      if (pump) await this._awaitPumpExit(pump);
    })();
    return this._closePromise;
  }

  // ── 公开只读状态（测试 / 诊断用，不产生事件） ──────────────────────────────

  inspect() {
    return {
      seatId: this._config.seatId ?? null,
      connected: this._connected,
      closed: this._closed,
      sessionRef: this._sessionRef,
      sessionSummary: clone(this._sessionSummary),
      activeAttemptId: this._activeAttempt?.attemptId ?? null,
      attemptCount: this._attempts.size,
      latestTurn: this._latestTurn,
      baselineSettled: this._baselineSettled,
      pendingEventCount: this._pendingEvents.length,
      subscriberCount: this._subscribers.size,
      openCollectorTurns: this._collector.size(),
      ledger: this._ledger.size(),
      pumpRunning: this._pumpPromise !== null,
    };
  }

  // ── 事件泵 ──────────────────────────────────────────────────────────────────

  _startPump() {
    if (this._pumpPromise) return;
    this._pumpPromise = this._runPump();
    // 泵内部的错误已经转成 BridgeError 事件；这里只防止未处理拒绝。
    this._pumpPromise.catch(() => {});
  }

  async _runPump() {
    try {
      while (!this._closed) {
        const controller = new AbortController();
        this._pumpAbort = controller;
        let failure = null;
        try {
          const stream = this._api.events.mux({}, controller.signal);
          this._api.events.follow?.(this._sessionRef);
          for await (const envelope of stream) {
            if (this._closed) break;
            this._ingestEnvelope(envelope);
          }
        } catch (error) {
          failure = error;
        }
        if (this._closed) break;
        this._emitBridgeError({
          code: 'STREAM_DISCONNECTED',
          message: failure
            ? `DSH event stream failed: ${failure?.message ?? failure}`
            : 'DSH event stream ended; reconnecting and rebuilding open turns from the next snapshot.',
          retryable: true,
        });
        await this._sleep(this._reconnectDelayMs);
      }
    } finally {
      this._pumpPromise = null;
    }
  }

  _ingestEnvelope(envelope) {
    const frame = envelope?.payload ?? envelope;
    if (!frame || typeof frame.type !== 'string') return;
    const sessionId = typeof frame.sessionId === 'string' ? frame.sessionId : this._sessionRef;
    if (sessionId !== this._sessionRef) return;

    if (frame.type === 'session/snapshot') {
      this._handleSnapshot(frame.snapshot ?? {}, sessionId);
      return;
    }
    if (frame.type === 'session/event') {
      this._handleLiveEvent(frame.event, sessionId);
    }
  }

  // ── 快照恢复 ────────────────────────────────────────────────────────────────

  /**
   * 快照处理分三步：
   * 1. 记账所有 turn（start/end），更新最新 turn 游标；
   * 2. 找到「本桥在途 attempt 对应的那个 turn」——已绑定 turn，或发送基线之后
   *    最早出现的新 turn——按快照正文重建 collector，若已终结则恰好结算一次；
   * 3. 只把仍未结束、且不属于本桥 attempt 的 turn 报为 ForeignTurn。
   *
   * 旧历史（发送基线之前的 completed/aborted/failed）不重放、不 Foreign、不进字幕。
   */
  _handleSnapshot(snapshot, sessionId) {
    const events = recordEventsOf(snapshot);
    const fingerprint = createHash('sha256').update(JSON.stringify(events)).digest('hex');

    for (const event of events) {
      this._observeTurn(event?.data?.turn, sessionId);
    }

    if (fingerprint === this._lastSnapshotFingerprint) {
      this._resolveBaselineReady();
      return;
    }
    this._lastSnapshotFingerprint = fingerprint;

    const infos = this._collectSnapshotTurns(events, sessionId);

    const active = this._activeAttempt && this._activeAttempt.status === 'running'
      ? this._activeAttempt
      : null;
    let target = null;
    let targetAttempt = null;

    if (active && active.boundTurn !== null) {
      const key = turnKey(sessionId, active.boundTurn);
      const info = infos.get(key);
      if (info && !this._finishedTurns.has(key)) {
        target = info;
        targetAttempt = active;
      }
    } else if (active) {
      for (const info of infos.values()) {
        const key = turnKey(sessionId, info.turn);
        if (this._finishedTurns.has(key)) continue;
        if (this._ledger.isForeign(sessionId, info.turn)) continue;
        if (!this._isNewForAttempt(active, info.turn)) continue;
        target = info;
        targetAttempt = active;
        break;
      }
    }

    if (target && targetAttempt) {
      this._bindAttempt(
        targetAttempt,
        target.turn,
        sessionId,
        target.startEvent ?? syntheticStart(target.turn),
        { allowEnded: true },
      );
      this._rebuildFromSnapshot(targetAttempt, target);
      if (target.endEvent) {
        this._handleTurnEnd(target.endEvent, sessionId, target.turn);
      }
    }

    // 旧历史 closed turn 一律沉默；只有仍未结束的陌生 turn 才可能是机主的手工回合。
    for (const info of infos.values()) {
      if (info.endEvent) continue;
      if (this._turnToAttempt.has(turnKey(sessionId, info.turn))) continue;
      this._emitForeignTurn(sessionId, info.turn);
    }

    this._resolveBaselineReady();
  }

  _collectSnapshotTurns(events, sessionId) {
    const infos = new Map();
    const ensure = (turn) => {
      const key = turnKey(sessionId, turn);
      let info = infos.get(key);
      if (!info) {
        info = { turn, startEvent: null, endEvent: null, messages: [] };
        infos.set(key, info);
      }
      return info;
    };

    for (const event of events) {
      const turn = event?.data?.turn;
      if (turn === undefined) continue;
      if (event.type === 'turn/start') {
        const info = ensure(turn);
        if (!info.startEvent) info.startEvent = event;
        this._ledger.startTurn(sessionId, turn);
      } else if (event.type === 'assistant/message') {
        ensure(turn).messages.push(event);
      } else if (event.type === 'turn/end') {
        const info = ensure(turn);
        info.endEvent = event;
        this._ledger.endTurn(sessionId, turn);
      }
    }

    return infos;
  }

  /** 用快照里的 start + assistant/message 重建该 attempt 的 collector。 */
  _rebuildFromSnapshot(attempt, info) {
    const turn = info.turn;
    const shouldRebuild = info.messages.length > 0
      || (!this._collector.has(turn) && info.startEvent !== null);

    if (!shouldRebuild) {
      if (!this._collector.has(turn)) this._collector.push(info.startEvent ?? syntheticStart(turn));
      return;
    }

    const collector = createTurnCollector();
    collector.push(info.startEvent ?? syntheticStart(turn));

    const seen = new Set();
    let lastMessageId = attempt.lastMessageId ?? null;
    for (const message of info.messages) {
      const key = messageKeyFor(message);
      if (key !== null) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      collector.push(message);
      const id = message?.data?.message?.id;
      if (typeof id === 'string' && id.length > 0) lastMessageId = id;
    }

    // 只有一个 active attempt 会被收集，替换 collector 不会丢别的在途回合。
    this._collector = collector;
    attempt.seenMessageKeys = seen;
    attempt.lastMessageId = lastMessageId;
  }

  // ── live 事件 ───────────────────────────────────────────────────────────────

  _handleLiveEvent(event, sessionId) {
    if (!event || typeof event.type !== 'string') return;
    const data = event.data ?? {};
    const turn = data.turn;

    if (event.type === 'turn/start') {
      if (turn === undefined) return;
      this._observeTurn(turn, sessionId);
      this._ledger.startTurn(sessionId, turn);
      const key = turnKey(sessionId, turn);
      if (this._turnToAttempt.has(key)) return;
      if (this._ledger.isForeign(sessionId, turn)) return;
      if (this._finishedTurns.has(key) || this._ledger.hasEnded(sessionId, turn)) return;

      const attempt = this._findUnboundAttempt();
      if (attempt && this._isNewForAttempt(attempt, turn)) {
        this._bindAttempt(attempt, turn, sessionId, event);
      } else if (!attempt) {
        this._emitForeignTurn(sessionId, turn);
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (turn === undefined) return;
      const attempt = this._turnToAttempt.get(turnKey(sessionId, turn));
      if (!attempt || attempt.status !== 'running') return;
      this._appendAssistantMessage(attempt, event);
      return;
    }

    if (event.type === 'assistant/chunk') return;

    if (event.type === 'turn/end') {
      if (turn === undefined) return;
      this._observeTurn(turn, sessionId);
      this._handleTurnEnd(event, sessionId, turn);
    }
  }

  _handleTurnEnd(event, sessionId, turn) {
    const key = turnKey(sessionId, turn);
    const freshEnd = this._ledger.endTurn(sessionId, turn);
    const attempt = this._turnToAttempt.get(key) ?? null;

    if (!attempt) {
      // 重复的历史 turn/end（快照已记过 end）不产生任何东西。
      if (!freshEnd) return;
      this._emitForeignTurn(sessionId, turn);
      return;
    }

    if (attempt.status !== 'running') return;

    if (!this._collector.has(turn)) this._collector.push(syntheticStart(turn));
    const ended = this._collector.push(event);
    const text = typeof ended?.text === 'string' ? ended.text : '';
    attempt.partialText = text;

    const kind = reasonKindOf(event.data);
    if (kind === 'completed') {
      this._completeAttempt(attempt, text);
    } else if (kind === 'aborted') {
      this._abortAttempt(attempt, text);
    } else {
      this._failAttempt(attempt, this._failureFromEvent(event, kind));
    }
  }

  // ── 回合游标与基线 ─────────────────────────────────────────────────────────

  _observeTurn(turn, sessionId) {
    if (turn === undefined || turn === null) return;
    const key = turnKey(sessionId, turn);
    this._seenTurnValues.add(key);
    const numeric = Number(turn);
    if (Number.isFinite(numeric)) {
      if (this._latestTurn === null || numeric > this._latestTurn) this._latestTurn = numeric;
    }
  }

  /** 该 turn 是否在 attempt 发送时之后才产生。 */
  _isNewForAttempt(attempt, turn) {
    const key = turnKey(this._sessionRef, turn);
    if (attempt.baselineTurns.has(key)) return false;
    const numeric = Number(turn);
    if (Number.isFinite(numeric) && Number.isFinite(attempt.baselineTurn)) {
      return numeric > attempt.baselineTurn;
    }
    return true;
  }

  _resolveBaselineReady() {
    if (this._baselineSettled) return;
    this._baselineSettled = true;
    this._resolveBaseline?.();
  }

  async _waitForBaseline() {
    if (this._baselineSettled) return;
    if (!this._baselineReady) {
      throw new BridgeError('BRIDGE_NOT_CONNECTED', 'No DSH event stream is active.');
    }
    let timer;
    try {
      await Promise.race([
        this._baselineReady,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new BridgeError(
              'BASELINE_TIMEOUT',
              `Timed out after ${this._snapshotTimeoutMs}ms waiting for the opening DSH snapshot.`,
              { retryable: true },
            ));
          }, this._snapshotTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── attempt 生命周期 ───────────────────────────────────────────────────────

  _findUnboundAttempt() {
    const attempt = this._activeAttempt;
    if (attempt && attempt.status === 'running' && attempt.boundTurn === null) return attempt;
    return null;
  }

  _bindAttempt(attempt, turn, sessionId, startEvent, options = {}) {
    const key = turnKey(sessionId, turn);
    if (attempt.boundTurn !== null && attempt.boundTurn !== turn) return false;
    if (this._turnToAttempt.has(key)) {
      attempt.boundTurn = turn;
      if (!attempt.nativeTurnRef) attempt.nativeTurnRef = nativeTurnRefFor(sessionId, turn);
      if (!this._collector.has(turn)) {
        this._collector.push(startEvent ?? syntheticStart(turn));
      }
      return true;
    }
    if (this._ledger.isForeign(sessionId, turn)) return false;
    if (!options.allowEnded && this._ledger.hasEnded(sessionId, turn)) return false;
    if (this._finishedTurns.has(key)) return false;

    attempt.boundTurn = turn;
    attempt.nativeTurnRef = nativeTurnRefFor(sessionId, turn);
    this._turnToAttempt.set(key, attempt);
    this._ledger.startTurn(sessionId, turn);

    if (!this._collector.has(turn)) {
      this._collector.push(startEvent ?? syntheticStart(turn));
    }
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_STARTED, attempt.attemptId, {
      nativeTurnRef: attempt.nativeTurnRef,
    });
    return true;
  }

  _appendAssistantMessage(attempt, event) {
    const turn = attempt.boundTurn;
    if (turn === null) return;
    const messageKey = messageKeyFor(event);
    if (messageKey !== null) {
      if (attempt.seenMessageKeys.has(messageKey)) return;
      attempt.seenMessageKeys.add(messageKey);
    }
    const messageId = event?.data?.message?.id;
    if (typeof messageId === 'string' && messageId.length > 0) attempt.lastMessageId = messageId;
    if (!this._collector.has(turn)) this._collector.push(syntheticStart(turn));
    this._collector.push(event);
  }

  _completeAttempt(attempt, text) {
    const nativeMessageRef = attempt.lastMessageId ?? `${attempt.nativeTurnRef}:message`;
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_COMPLETED, attempt.attemptId, {
      nativeTurnRef: attempt.nativeTurnRef,
      nativeMessageRef,
      text,
    });
    this._finishAttempt(attempt, 'completed');
  }

  _abortAttempt(attempt, partialText) {
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_ABORTED, attempt.attemptId, {
      nativeTurnRef: attempt.nativeTurnRef,
      partialText,
    });
    this._finishAttempt(attempt, 'aborted');
  }

  _failAttempt(attempt, error) {
    this._emit(BRIDGE_EVENT_TYPES.ATTEMPT_FAILED, attempt.attemptId, {
      error,
      nativeTurnRef: attempt.nativeTurnRef,
    });
    this._finishAttempt(attempt, 'failed');
  }

  _finishAttempt(attempt, status) {
    attempt.status = status;
    attempt.endedAt = new Date().toISOString();
    if (this._activeAttempt === attempt) this._activeAttempt = null;
    if (attempt.boundTurn !== null) {
      const key = turnKey(this._sessionRef, attempt.boundTurn);
      this._finishedTurns.add(key);
      this._turnToAttempt.delete(key);
    }
  }

  _abandonAttempt(attempt, error) {
    if (attempt.status !== 'running') return;
    attempt.status = 'failed';
    attempt.error = error;
    if (this._activeAttempt === attempt) this._activeAttempt = null;
    if (attempt.boundTurn !== null) {
      this._failAttempt(attempt, error);
    }
  }

  _failureFromEvent(event, kind) {
    const raw = event?.data?.error;
    if (raw && typeof raw === 'object') {
      return {
        code: typeof raw.code === 'string' ? raw.code : 'TURN_FAILED',
        message: typeof raw.message === 'string' ? raw.message : `DSH turn ended with reason: ${kind ?? 'unknown'}`,
        retryable: raw.retryable === true,
      };
    }
    return {
      code: kind ? `TURN_${String(kind).toUpperCase()}` : 'TURN_ENDED_UNEXPECTED',
      message: `DSH turn ended without a completable reason: ${kind ?? 'unknown'}`,
      retryable: false,
    };
  }

  // ── 取消 ───────────────────────────────────────────────────────────────────

  async _performCancel(attempt) {
    const sessionId = this._sessionRef;
    const errors = [];

    try {
      const itemIds = await this._readInboxIds(sessionId);
      for (const itemId of new Set(itemIds)) {
        const response = await this._api.callUnary('session/updateQueue', {
          sessionId,
          itemId,
          action: { kind: 'remove' },
        });
        const result = response?.result;
        if (result?.ok) continue;
        if (result?.error?.code === 'session/queue-item-not-found') continue;
        if (result?.error) errors.push(result.error);
      }
    } catch (error) {
      errors.push({ code: 'QUEUE_CLEAR_FAILED', message: String(error?.message ?? error) });
    }

    let cancelResult = null;
    try {
      const response = await this._api.callUnary('session/cancel', { sessionId });
      cancelResult = response?.result ?? null;
    } catch (error) {
      errors.push({ code: 'CANCEL_FAILED', message: String(error?.message ?? error) });
    }

    if (attempt.status !== 'running') {
      if (attempt.status === 'aborted') return this._abortedReceipt(attempt);
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

    if (cancelResult?.ok !== true) {
      const rpcError = cancelResult?.error ?? errors[0] ?? {
        code: 'CANCEL_FAILED',
        message: 'session/cancel was not accepted.',
      };
      return {
        attemptId: attempt.attemptId,
        accepted: false,
        settlement: 'failed',
        ...(attempt.nativeTurnRef ? { nativeTurnRef: attempt.nativeTurnRef } : {}),
        error: {
          code: typeof rpcError.code === 'string' ? rpcError.code : 'CANCEL_FAILED',
          message: typeof rpcError.message === 'string' ? rpcError.message : String(rpcError),
          retryable: rpcError.retryable === true,
        },
      };
    }

    const receipt = {
      attemptId: attempt.attemptId,
      accepted: true,
      settlement: 'pending',
    };
    if (attempt.nativeTurnRef) receipt.nativeTurnRef = attempt.nativeTurnRef;
    if (errors.length > 0) {
      receipt.error = {
        code: typeof errors[0].code === 'string' ? errors[0].code : 'QUEUE_CLEAR_FAILED',
        message: String(errors[0].message ?? 'queue clear failed before cancel'),
        retryable: true,
      };
    }
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

  async _readInboxIds(sessionId) {
    const response = await this._api.callUnary('session/projections', { sessionId });
    const result = response?.result;
    if (result?.ok === true) {
      const items = inboxItemsOfProjections(result.value?.values ?? null);
      return inboxItemIds(items);
    }
    if (result?.error?.code === 'session/not-found') return [];
    throw new Error(
      `session/projections failed: ${result?.error?.code ?? 'unknown'}: ${result?.error?.message ?? 'no result'}`,
    );
  }

  // ── 订阅与发布 ─────────────────────────────────────────────────────────────

  _emit(type, attemptId, payload) {
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

  _emitForeignTurn(sessionId, turn) {
    if (turn === undefined) return;
    if (!this._ledger.markForeign(sessionId, turn)) return;
    this._emit(BRIDGE_EVENT_TYPES.FOREIGN_TURN, null, {
      nativeTurnRef: nativeTurnRefFor(sessionId, turn),
      reason: 'foreign-turn',
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
      throw new BridgeError('CONFIG_INVALID', 'DshBridge requires a non-empty seatId.');
    }
  }

  _assertOpen() {
    if (this._closed) {
      throw new BridgeError('BRIDGE_CLOSED', 'Bridge is closed.');
    }
  }

  async _resolveApi(config) {
    if (config?.api) return config.api;
    if (this._api) return this._api;
    if (this._apiFactory) {
      const api = await this._apiFactory(config);
      if (!api) throw new BridgeError('CONFIG_INVALID', 'apiFactory returned no API client.');
      this._api = api;
      return api;
    }
    this._api = new NodeApiClient(
      config?.baseUrl ?? DEFAULT_BASE_URL,
      config?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      config?.auth ?? {},
    );
    return this._api;
  }

  async _fetchSession(api, sessionRef) {
    const response = await api.sessions.list({});
    const result = response?.result;
    if (result?.ok !== true) {
      const rpcError = result?.error ?? {};
      throw new BridgeError(
        typeof rpcError.code === 'string' ? rpcError.code : 'SESSION_LIST_FAILED',
        `sessions.list failed: ${rpcError.message ?? 'no result'}`,
        { retryable: rpcError.retryable === true, details: { code: rpcError.code ?? null } },
      );
    }
    const items = Array.isArray(result.value?.items) ? result.value.items : [];
    const summary = items.find((item) => item?.sessionId === sessionRef);
    if (!summary) {
      throw new BridgeError('SESSION_NOT_FOUND', `DSH session does not exist: ${sessionRef}`, {
        details: { sessionId: sessionRef },
      });
    }
    return summary;
  }

  _buildIdentity(summary, sessionRef) {
    const values = summary?.projections?.values ?? {};
    const selection = modelSelectionOf(values);
    const metadata = {
      name: typeof summary?.title === 'string' ? summary.title : null,
      agentPreset: summary?.agentPreset ?? values.agentPreset ?? null,
      cwd: typeof summary?.cwd === 'string' ? summary.cwd : null,
      model: selection.model,
      provider: selection.provider,
    };
    if (selection.reasoningEffort !== null) metadata.reasoningEffort = selection.reasoningEffort;
    const revision = createHash('sha256')
      .update(JSON.stringify([
        sessionRef,
        metadata.name,
        metadata.agentPreset,
        metadata.cwd,
        metadata.model,
        metadata.provider,
        metadata.reasoningEffort ?? null,
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

  async _sleep(ms) {
    if (this._closed || ms <= 0) return;
    await Promise.race([
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
      this._closedPromise,
    ]);
  }

  async _awaitPumpExit(pump) {
    let timer;
    try {
      await Promise.race([
        pump,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this._closeTimeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createDshBridge(config) {
  return new DshBridge(config);
}
