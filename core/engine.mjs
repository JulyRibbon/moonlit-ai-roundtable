import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import {
  BRIDGE_EVENT_TYPES,
  ROOM_EVENT_TYPES,
  createRoomEvent,
} from './events.mjs';
import {
  HALT_MODES,
  HALT_SCOPES,
} from './halt.mjs';
import {
  ACTIONS,
  OWNER_ACTOR,
  SCHEDULER_ACTOR,
  assertOwner,
  createRoomState,
  restore,
  transition,
} from './room-state.mjs';
import {
  MAX_CASUAL_ATTEMPTS,
  applyMessage,
  createSchedule,
  isPass,
  migrateSchedule,
  recordResult,
  selectNext,
} from './scheduler.mjs';
import { estimateInputTokens } from './budget.mjs';

export const ENGINE_SCHEMA_VERSION = 1;

const DEFAULT_CONTEXT_TEXT = '请继续当前话题。';

const STORE_METHODS = Object.freeze([
  'load',
  'appendEvent',
  'appendMessage',
  'appendAttempt',
  'saveCheckpoint',
  'exportMarkdown',
]);

const ACTOR_SYSTEM_INIT = 'system:init';

const ACTIVE_ROOM_STATE = 'active';

export class RoomEngineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoomEngineError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RoomEngineError);
    }
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function assertStore(store) {
  if (!store || typeof store !== 'object') {
    throw new RoomEngineError('STORE_INVALID', 'store must be an object.');
  }
  for (const method of STORE_METHODS) {
    if (typeof store[method] !== 'function') {
      throw new RoomEngineError('STORE_METHOD_MISSING', `store.${method}() is required.`, { method });
    }
  }
}

function assertBridges(bridges) {
  if (!bridges || typeof bridges.entries !== 'function') {
    throw new RoomEngineError('BRIDGES_INVALID', 'bridges must be a Map<seatId, Bridge>.');
  }
  const map = new Map(bridges);
  if (map.size === 0) {
    throw new RoomEngineError('BRIDGES_EMPTY', 'At least one bridge is required.');
  }
  for (const [seatId, bridge] of map) {
    if (typeof seatId !== 'string' || seatId.length === 0) {
      throw new RoomEngineError('SEAT_ID_INVALID', 'Bridge keys must be non-empty seat ids.');
    }
    for (const method of ['connect', 'subscribe', 'send', 'close']) {
      if (typeof bridge?.[method] !== 'function') {
        throw new RoomEngineError(
          'BRIDGE_METHOD_MISSING',
          `Bridge ${seatId} is missing ${method}().`,
          { seatId, method },
        );
      }
    }
  }
  return map;
}

function assertHaltGuard(haltGuard) {
  if (haltGuard === undefined || haltGuard === null) return null;
  for (const method of ['check', 'signal', 'registerAttempt', 'request', 'resume', 'snapshot', 'close']) {
    if (typeof haltGuard[method] !== 'function') {
      throw new RoomEngineError(
        'HALT_GUARD_INVALID',
        `haltGuard.${method}() is required.`,
        { method },
      );
    }
  }
  return haltGuard;
}

function assertBudgetGuard(budgetGuard) {
  if (budgetGuard === undefined || budgetGuard === null) return null;
  for (const method of ['beforeAttempt', 'settle', 'snapshot']) {
    if (typeof budgetGuard[method] !== 'function') {
      throw new RoomEngineError(
        'BUDGET_GUARD_INVALID',
        `budgetGuard.${method}() is required.`,
        { method },
      );
    }
  }
  return budgetGuard;
}

function normalizeMaxAttempts(value) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CASUAL_ATTEMPTS) {
    throw new RoomEngineError(
      'MAX_ATTEMPTS_INVALID',
      `maxAttempts must be an integer between 1 and ${MAX_CASUAL_ATTEMPTS}.`,
      { maxAttempts: value },
    );
  }
  return value;
}

function mergeUsage(current, incoming) {
  if (incoming === undefined || incoming === null) return current ?? null;
  if (typeof incoming !== 'object' || Array.isArray(incoming)) {
    return current ?? clone(incoming);
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return clone(incoming);
  }
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (typeof value === 'number' && typeof merged[key] === 'number') {
      merged[key] += value;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeUsage(merged[key], value);
    } else {
      merged[key] = clone(value);
    }
  }
  return merged;
}

function assertOwnerOption(options) {
  return assertOwner(options?.actor ?? OWNER_ACTOR);
}

/**
 * 房间引擎：把 Bridge 事件、排程器和房间状态粘在一起。
 *
 * 设计约束：
 * - 所有房间事件都经 createRoomEvent 生成，roomSeq 连续。
 * - 每次 append 之后都写 checkpoint，恢复游标永远与最后一条事件对齐。
 * - 引擎不删除原生会话；close() 只结束迭代器并关闭 Bridge。
 * - 语音事件只转发，不进入排程等待链。
 * - 恢复 active 由 restore() 降为 paused，绝不自动续聊。
 */
export class RoomEngine {
  constructor({ roomId, bridges, store, maxAttempts, haltGuard, budgetGuard, settings = {} } = {}) {
    if (typeof roomId !== 'string' || roomId.length === 0) {
      throw new RoomEngineError('ROOM_ID_INVALID', 'roomId must be a non-empty string.');
    }
    this.roomId = roomId;
    this.store = store;
    assertStore(store);
    this.bridges = assertBridges(bridges);
    this.maxAttempts = normalizeMaxAttempts(maxAttempts);
    this.haltGuard = assertHaltGuard(haltGuard);
    this.budgetGuard = assertBudgetGuard(budgetGuard);
    this._ownerName = settings.ownerName ?? '机主';
    this._contextMessages = settings.contextMessages ?? 8;
    this._seatProfiles = new Map();
    for (const seatId of this.bridges.keys()) {
      const profile = settings.seats?.find((seat) => seat.seatId === seatId) ?? {};
      this._seatProfiles.set(seatId, {
        seatId,
        displayName: profile.displayName ?? seatId,
        color: profile.color ?? null,
        clientType: profile.clientType ?? null,
      });
    }

    this._emitter = new EventEmitter();
    this._room = null;
    this._schedule = null;
    this._transcript = [];
    this._attempts = new Map();
    this._foreignTurns = [];
    this._health = new Map();
    this._iterators = new Map();
    this._pumps = [];
    this._pending = new Map();
    this._terminals = new Map();
    this._seenBridgeEventIds = new Set();
    this._seenNativeFinalRefs = new Set();
    this._contextEpoch = `epoch_${roomId}`;
    this._counterEpoch = { round: 1, resetAt: null };
    this._initialized = false;
    this._initPromise = null;
    this._closed = false;
    this._closePromise = null;
    this._runPromise = null;
    this._lock = Promise.resolve();
    this._listenerErrors = [];
    this._attemptUnregisters = new Map();
    this._lastHalt = null;
    this._budgetPlans = new Map();
    this._lastBudgetError = null;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────────────

  init() {
    if (this._initPromise) return this._initPromise;
    const promise = this._doInit().catch((error) => {
      this._initPromise = null;
      throw error;
    });
    this._initPromise = promise;
    return promise;
  }

  async _doInit() {
    if (this._closed) {
      throw new RoomEngineError('ENGINE_CLOSED', 'Cannot init a closed engine.');
    }
    await this._locked(() => this._loadState());
    await this._connectAll();
    this._initialized = true;
  }

  async _loadState() {
    const loaded = await this.store.load();
    if (!loaded || !loaded.room) {
      this._room = createRoomState({ roomId: this.roomId });
      await this._appendRoomEvent(ROOM_EVENT_TYPES.ROOM_CREATED, ACTOR_SYSTEM_INIT, {
        state: this._room.state,
      });
      return;
    }

    this._room = clone(loaded.room);
    this._schedule = loaded.schedule ? migrateSchedule(clone(loaded.schedule)) : null;
    if (Array.isArray(loaded.transcript)) this._transcript = clone(loaded.transcript);
    else if (Array.isArray(loaded.messages)) this._transcript = clone(loaded.messages);
    if (Array.isArray(loaded.attempts)) {
      this._attempts = new Map(loaded.attempts.map((attempt) => [attempt.attemptId, clone(attempt)]));
    }
    if (Array.isArray(loaded.foreignTurns)) this._foreignTurns = clone(loaded.foreignTurns);

    const restored = restore(this._room);
    if (restored.changed) {
      await this._commitTransition(restored);
    }
  }

  async _connectAll() {
    for (const [seatId, bridge] of this.bridges) {
      const health = { seatId, connected: false, closed: false, lastError: null, identity: null };
      this._health.set(seatId, health);
      await bridge.connect();
      health.connected = true;
      if (typeof bridge.getIdentity === 'function') {
        try {
          health.identity = clone(await bridge.getIdentity());
        } catch (error) {
          health.identityError = String(error?.message ?? error);
        }
      }
      const iterator = bridge.subscribe();
      this._iterators.set(seatId, iterator);
      this._pumps.push(this._pump(seatId, iterator));
    }
  }

  async _pump(seatId, iterator) {
    try {
      while (!this._closed) {
        const step = await iterator.next();
        if (step.done) break;
        if (this._closed) break;
        await this._locked(() => this._handleBridgeEvent(seatId, step.value));
      }
    } catch (error) {
      const health = this._health.get(seatId);
      if (health) health.lastError = error;
      this._emitSafely('engine-error', { seatId, error });
    }
  }

  /**
   * 幂等关闭：结束所有 Bridge 订阅迭代器、关闭 Bridge，但不删除原生会话。
   * 若 run() 正卡在等待终态，会把在途 attempt 结算为 aborted 后解除等待。
   */
  close() {
    if (this._closePromise) return this._closePromise;
    this._closed = true;

    for (const unregister of this._attemptUnregisters.values()) {
      try {
        unregister();
      } catch (error) {
        this._emitSafely('engine-error', { phase: 'close-unregister', error });
      }
    }
    this._attemptUnregisters.clear();

    for (const [attemptId, resolve] of this._pending) {
      resolve({ outcome: 'aborted', reason: 'engine-closed', error: { code: 'ENGINE_CLOSED' } });
      this._pending.delete(attemptId);
    }

    // 已预占但尚未收到终态的 attempt 在关闭时按 unknown 结算并释放，
    // 避免预算永久停留在 reserved。
    for (const [attemptId, plan] of [...this._budgetPlans]) {
      this._settleBudget(
        { attemptId, seatId: plan.seatId },
        { outcome: 'aborted', reason: 'engine-closed', usage: null },
      );
    }

    this._closePromise = (async () => {
      for (const iterator of this._iterators.values()) {
        try {
          await iterator.return?.();
        } catch (error) {
          this._emitSafely('engine-error', { phase: 'close-iterator', error });
        }
      }
      await Promise.allSettled(this._pumps);
      for (const [seatId, bridge] of this.bridges) {
        try {
          await bridge.close();
        } catch (error) {
          this._emitSafely('engine-error', { phase: 'close-bridge', seatId, error });
        }
        const health = this._health.get(seatId);
        if (health) {
          health.connected = false;
          health.closed = true;
        }
      }
      if (this.haltGuard) {
        try {
          await this.haltGuard.close();
        } catch (error) {
          this._emitSafely('engine-error', { phase: 'close-halt-guard', error });
        }
      }
    })();

    return this._closePromise;
  }

  // ── 对外动作 ────────────────────────────────────────────────────────────────

  /** 额外便利方法：把 draft 房间激活。仅 owner 可调用。 */
  async activate(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    return this._locked(async () => {
      const result = await this._applyTransition(ACTIONS.ACTIVATE, options);
      return this._actionResult(result);
    });
  }

  async postOwnerMessage(input = {}) {
    const actor = assertOwner(input?.actor ?? OWNER_ACTOR);
    this._assertInitialized();
    const text = input?.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new RoomEngineError('MESSAGE_TEXT_INVALID', 'postOwnerMessage requires a non-empty text.');
    }
    const mentions = normalizeStringArray(input.mentions, 'mentions');
    const nominations = normalizeStringArray(input.nominations, 'nominations');
    const replyTo = input.replyTo;
    if (replyTo !== undefined && replyTo !== null && typeof replyTo !== 'string') {
      throw new RoomEngineError('MESSAGE_REPLY_INVALID', 'replyTo must be a string when provided.');
    }

    return this._locked(async () => {
      this._ensureSchedule();
      this._schedule = applyMessage(this._schedule, {
        from: 'owner',
        mentions,
        ...(replyTo === undefined || replyTo === null ? {} : { replyTo }),
        nominations,
      });

      const messageId = `m_${randomUUID()}`;
      const now = new Date().toISOString();
      // 先预留下一条房间事件的序号，保证 transcript 与 MessagePosted 对齐。
      const roomSeq = this._room.lastRoomSeq + 1;
      const message = {
        id: messageId,
        messageId,
        roomId: this.roomId,
        roomSeq,
        turnId: null,
        attemptId: null,
        from: 'owner',
        actor,
        seatId: null,
        text,
        mentions,
        replyTo: replyTo ?? null,
        nominations,
        createdAt: now,
        occurredAt: now,
      };
      this._transcript.push(message);
      await this.store.appendMessage(clone(message));
      await this._checkpoint();
      await this._appendRoomEvent(ROOM_EVENT_TYPES.MESSAGE_POSTED, actor, {
        messageId: message.messageId,
        roomSeq,
        from: 'owner',
        text,
        mentions,
        replyTo: message.replyTo,
        nominations,
      });
      return clone(message);
    });
  }

  /**
   * 运行调度循环。幂等防重入：同一时刻只有一条循环。
   * 只有 room.state === 'active' 才会真正选席。
   */
  run() {
    if (this._closed) {
      return Promise.resolve({ ran: false, reason: 'engine-closed', state: this._room?.state ?? null });
    }
    if (this._runPromise) return this._runPromise;
    const promise = this._runLoop().finally(() => {
      if (this._runPromise === promise) this._runPromise = null;
    });
    this._runPromise = promise;
    return promise;
  }

  async _runLoop() {
    this._assertInitialized();
    if (this._closed) {
      return { ran: false, reason: 'engine-closed', state: this._room?.state ?? null };
    }
    if (this.haltGuard) {
      const gate = this._guardStatus();
      if (!gate.dispatchable) {
        const reason = this._guardStopReason(gate);
        return {
          ran: false,
          reason,
          state: this._room.state,
          halted: reason === 'halted',
          paused: reason === 'paused',
        };
      }
    }
    if (this._room.state !== ACTIVE_ROOM_STATE) {
      return { ran: false, reason: 'room-not-active', state: this._room.state };
    }

    const turns = [];
    let stopReason = null;
    let budgetError = null;
    while (!this._closed && this._room.state === ACTIVE_ROOM_STATE) {
      const plan = await this._locked(() => this._beginTurn());
      if (!plan.selected) {
        if (plan.guardStop || plan.budgetStop) stopReason = plan.reason;
        if (plan.budgetStop) budgetError = plan.budgetError;
        await this._locked(() => this._maybeFinishRound());
        break;
      }

      turns.push({ attemptId: plan.attemptId, seatId: plan.seatId, selectionSeq: plan.selectionSeq });

      const bridge = this.bridges.get(plan.seatId);

      if (this._closed) {
        await this._locked(() => this._settleTurn(plan, {
          outcome: 'aborted',
          reason: 'engine-closed',
          error: { code: 'ENGINE_CLOSED' },
        }));
        break;
      }

      // 选择与登记之间不能再让 guard 窗口漏过：这里同步 check → register → send。
      if (this.haltGuard) {
        const gate = this._guardStatus();
        if (!gate.dispatchable) {
          stopReason = this._guardStopReason(gate);
          await this._locked(() => this._settleUnsent(plan));
          break;
        }
        const unregister = this.haltGuard.registerAttempt({
          roomId: this.roomId,
          attemptId: plan.attemptId,
          seatId: plan.seatId,
          cancel: () => bridge.cancel(plan.attemptId),
        });
        this._attemptUnregisters.set(plan.attemptId, unregister);
      }

      try {
        await bridge.send(plan.packet);
      } catch (error) {
        this._unregisterAttempt(plan.attemptId);
        await this._locked(() => this._failSend(plan, error));
        continue;
      }

      if (this._closed) {
        await this._locked(() => this._settleTurn(plan, {
          outcome: 'aborted',
          reason: 'engine-closed',
          error: { code: 'ENGINE_CLOSED' },
        }));
        break;
      }

      const terminal = await this._waitForTerminal(plan.attemptId);
      await this._locked(() => this._settleTurn(plan, terminal));
    }

    if (stopReason === null && this.haltGuard && !this._closed) {
      const gate = this._guardStatus();
      if (!gate.dispatchable) stopReason = this._guardStopReason(gate);
    }

    return {
      ran: true,
      turns,
      state: this._room?.state ?? null,
      attemptsUsed: this._schedule?.attemptsUsed ?? 0,
      ended: Boolean(this._schedule?.ended),
      closed: this._closed,
      ...(stopReason === null
        ? {}
        : { reason: stopReason, halted: stopReason === 'halted', paused: stopReason === 'paused' }),
      ...(budgetError === null ? {} : { budgetError, budgetStopped: true }),
    };
  }

  async _beginTurn() {
    if (this.haltGuard) {
      const gate = this._guardStatus();
      if (!gate.dispatchable) {
        return {
          selected: false,
          guardStop: true,
          reason: this._guardStopReason(gate),
          halt: gate,
        };
      }
    }
    this._ensureSchedule();
    const selected = selectNext(this._schedule);

    if (!selected.decision.selected) {
      this._schedule = selected.state;
      await this._checkpoint();
      return { selected: false, reason: selected.decision.reason };
    }

    const { decision } = selected;
    const attemptId = `a_${randomUUID()}`;
    const text = this._renderTurnText(decision.seatId);

    // 预算检查发生在提交 selection 和追加 TurnRequested 之前：
    // 拒绝时本轮排程保持不变，且绝不会调用 bridge.send()。
    if (this.budgetGuard) {
      const gate = this._budgetBeforeAttempt({ attemptId, seatId: decision.seatId, text });
      if (!gate.allowed) {
        return {
          selected: false,
          budgetStop: true,
          reason: 'budget-exceeded',
          budgetError: gate.error,
        };
      }
    }

    this._schedule = selected.state;
    await this._checkpoint();

    let turnEvent;
    try {
      turnEvent = await this._appendRoomEvent(
        ROOM_EVENT_TYPES.TURN_REQUESTED,
        'scheduler',
        {
          attemptId,
          seatId: decision.seatId,
          mode: decision.mode,
          reason: decision.reason,
          round: decision.round,
          selectionSeq: decision.selectionSeq,
        },
      );
    } catch (error) {
      this._settleBudget(
        { attemptId, seatId: decision.seatId },
        { outcome: 'failed', usage: null, error: { code: 'TURN_EVENT_FAILED' } },
      );
      throw error;
    }

    const packet = {
      roomId: this.roomId,
      roomSeq: turnEvent.roomSeq,
      turnId: turnIdForAttempt(attemptId),
      attemptId,
      seatId: decision.seatId,
      contextEpoch: this._contextEpoch,
      text,
    };

    return {
      selected: true,
      attemptId,
      seatId: decision.seatId,
      selectionSeq: decision.selectionSeq,
      packet,
    };
  }

  async _failSend(plan, error) {
    this._unregisterAttempt(plan.attemptId);
    const code = typeof error?.code === 'string' ? error.code : 'BRIDGE_SEND_FAILED';
    // 发送失败没有原生 usage：按 unknown 结算并立即释放预占。
    this._settleBudget(plan, { outcome: 'failed', usage: null, error: { code } });
    if (this._closed) return;
    const attempt = {
      attemptId: plan.attemptId,
      seatId: plan.seatId,
      status: 'failed',
      terminal: true,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      text: null,
      partialText: '',
      usage: null,
      error: { code, message: String(error?.message ?? 'send failed') },
      nativeTurnRef: null,
      nativeMessageRef: null,
    };
    this._attempts.set(plan.attemptId, attempt);
    await this.store.appendAttempt(clone(attempt));
    await this._checkpoint();
    await this._appendRoomEvent(ROOM_EVENT_TYPES.MEMBER_FAILED, `seat:${plan.seatId}`, {
      attemptId: plan.attemptId,
      seatId: plan.seatId,
      error: attempt.error,
    });
    this._recordSettled(plan, { outcome: 'failed', error: attempt.error });
    await this._checkpoint();
    await this._maybeFinishRound();
  }

  async _settleTurn(plan, terminal) {
    this._unregisterAttempt(plan.attemptId);
    const attempt = this._attempts.get(plan.attemptId);
    if (attempt && !attempt.terminal) {
      attempt.status = 'aborted';
      attempt.terminal = true;
      attempt.endedAt = new Date().toISOString();
      attempt.reason = terminal.reason ?? null;
      await this.store.appendAttempt(clone(attempt));
      await this._checkpoint();
    }

    // 终态可能是 completed / pass / failed / aborted；全部都要结算并释放预占。
    this._settleBudget(plan, terminal);
    const result = this._recordSettled(plan, terminal);
    await this._checkpoint();
    if (result?.ended) await this._maybeFinishRound();
  }

  /** 已经被 guard 拦下、尚未 send 的 turn：只结算排程，不伪造 Bridge attempt。 */
  async _settleUnsent(plan) {
    this._unregisterAttempt(plan.attemptId);
    this._settleBudget(plan, {
      outcome: 'aborted',
      reason: 'halt-before-send',
      usage: null,
      error: { code: 'HALT_BEFORE_SEND' },
    });
    this._recordSettled(plan, {
      outcome: 'aborted',
      reason: 'halt-before-send',
      error: { code: 'HALT_BEFORE_SEND' },
    });
    await this._checkpoint();
  }

  _budgetBeforeAttempt({ attemptId, seatId, text }) {
    const estimatedInputTokens = estimateInputTokens(text);
    try {
      const result = this.budgetGuard.beforeAttempt({
        attemptId,
        seatId,
        estimatedInputTokens,
      });
      if (result?.allowed) {
        this._budgetPlans.set(attemptId, { seatId, estimatedInputTokens });
        return { allowed: true, result };
      }
      const error = {
        code: typeof result?.code === 'string' ? result.code : 'BUDGET_REJECTED',
        message: typeof result?.message === 'string' ? result.message : 'Budget rejected the attempt.',
        attemptId,
        seatId,
        estimatedInputTokens,
        ...(result?.rejection ? { rejection: clone(result.rejection) } : {}),
      };
      this._lastBudgetError = error;
      this._emitSafely('budget-rejected', clone(error));
      return { allowed: false, error };
    } catch (cause) {
      // 预算层自身出错时按 fail-closed 处理：不派发，并保留明确错误。
      const error = {
        code: 'BUDGET_GUARD_ERROR',
        message: `Budget guard failed before dispatch: ${cause?.message ?? cause}`,
        attemptId,
        seatId,
        estimatedInputTokens,
      };
      this._lastBudgetError = error;
      this._emitSafely('engine-error', { phase: 'budget-check', attemptId, seatId, error: cause });
      this._emitSafely('budget-rejected', clone(error));
      return { allowed: false, error };
    }
  }

  _settleBudget(plan, terminal) {
    if (!this.budgetGuard) return null;
    const info = this._budgetPlans.get(plan.attemptId);
    if (!info) return null;
    this._budgetPlans.delete(plan.attemptId);
    try {
      const settlement = this.budgetGuard.settle({
        attemptId: plan.attemptId,
        seatId: info.seatId,
        usage: terminal?.usage ?? null,
        outcome: terminal?.outcome ?? null,
        ...(terminal?.error === undefined ? {} : { error: terminal.error }),
      });
      this._emitSafely('budget-settled', clone({
        attemptId: plan.attemptId,
        seatId: info.seatId,
        outcome: terminal?.outcome ?? null,
        quality: settlement?.quality ?? 'unknown',
        cost: settlement?.cost ?? null,
      }));
      return settlement;
    } catch (error) {
      this._emitSafely('engine-error', {
        phase: 'budget-settle',
        attemptId: plan.attemptId,
        seatId: info.seatId,
        error,
      });
      return null;
    }
  }

  _recordSettled(plan, terminal) {
    const outcome = terminal.outcome === 'pass' ? 'pass' : terminal.outcome;
    const recorded = recordResult(this._schedule, {
      attemptId: plan.attemptId,
      seatId: plan.seatId,
      outcome,
      text: terminal.text,
      error: terminal.error,
    });
    this._schedule = recorded.state;
    this._emitSafely('attempt-settled', {
      attemptId: plan.attemptId,
      seatId: plan.seatId,
      outcome: recorded.outcome ?? outcome,
      applied: recorded.applied,
      duplicate: recorded.duplicate,
      ended: recorded.ended,
    });
    return recorded;
  }

  async pause(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    if (this.haltGuard) {
      await this.haltGuard.request({
        scope: HALT_SCOPES.ROOM,
        roomId: this.roomId,
        mode: HALT_MODES.PAUSE,
        actor: OWNER_ACTOR,
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      });
    }
    return this._locked(async () => this._actionResult(
      await this._applyTransition(ACTIONS.PAUSE, options),
    ));
  }

  async resume(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    // 只有 paused 才同步解除 guard 的暂停标记；halted 必须走 resumeHalt。
    if (this.haltGuard && this._room.state === 'paused') {
      await this.haltGuard.resume({
        scope: HALT_SCOPES.ROOM,
        roomId: this.roomId,
        actor: OWNER_ACTOR,
      });
    }
    return this._locked(async () => this._actionResult(
      await this._applyTransition(ACTIONS.RESUME, options),
    ));
  }

  /**
   * 请求停止。mode='halt' 时先落哨兵并取消在途 attempt，再切房间 halted；
   * mode='pause' 时只设置 guard 暂停并切房间 paused。
   */
  async halt(options = {}) {
    const actor = assertOwnerOption(options);
    this._assertInitialized();
    if (!this.haltGuard) {
      throw new RoomEngineError(
        'HALT_GUARD_MISSING',
        'This engine was created without a haltGuard.',
      );
    }
    const scope = options.scope ?? HALT_SCOPES.ROOM;
    const mode = options.mode ?? HALT_MODES.HALT;
    const reason = options.reason;

    const receipt = await this.haltGuard.request({
      scope,
      roomId: this.roomId,
      mode,
      actor,
      ...(reason === undefined ? {} : { reason }),
    });

    if (mode === HALT_MODES.HALT) {
      await this._locked(() => this._appendRoomEvent(ROOM_EVENT_TYPES.HALT_REQUESTED, actor, {
        scope,
        mode,
        stopped: receipt.stopped,
        sentinelWritten: receipt.sentinelWritten,
        ...(reason === undefined ? {} : { reason }),
      }));
    }

    const action = mode === HALT_MODES.PAUSE ? ACTIONS.PAUSE : ACTIONS.HALT;
    const transitionResult = await this._locked(() => this._applyTransition(action, {
      ...(reason === undefined ? {} : { reason }),
    }));

    if (mode === HALT_MODES.HALT) {
      await this._locked(() => this._appendRoomEvent(
        ROOM_EVENT_TYPES.HALT_SETTLED,
        actor,
        {
          scope,
          mode,
          stopped: receipt.stopped,
          halted: receipt.halted,
          aborted: receipt.aborted,
          degraded: receipt.degraded,
          pending: receipt.pending,
          fullySettled: receipt.fullySettled,
          sentinelWritten: receipt.sentinelWritten,
          attempts: clone(receipt.attempts),
        },
      ));
    }

    this._lastHalt = clone(receipt);
    return {
      ...clone(receipt),
      roomState: this._room.state,
      roomChanged: transitionResult.changed,
      events: clone(transitionResult.events),
    };
  }

  /** 解除停止：guard resume 后把 halted 房间降为 paused，不自动 run。 */
  async resumeHalt(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    if (!this.haltGuard) {
      throw new RoomEngineError(
        'HALT_GUARD_MISSING',
        'This engine was created without a haltGuard.',
      );
    }
    const scope = options.scope ?? HALT_SCOPES.ROOM;
    const receipt = await this.haltGuard.resume({
      scope,
      roomId: this.roomId,
      actor: OWNER_ACTOR,
    });

    let transitionResult = null;
    if (this._room.state === 'halted') {
      transitionResult = await this._locked(() => this._applyTransition(ACTIONS.UNHALT, {
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      }));
    }

    this._lastHalt = clone(receipt);
    return {
      ...clone(receipt),
      roomState: this._room.state,
      roomChanged: transitionResult?.changed ?? false,
      events: clone(transitionResult?.events ?? []),
    };
  }

  async requestReview(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    return this._locked(async () => this._actionResult(await this._requestReviewLocked(options)));
  }

  async confirm(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    return this._locked(async () => {
      const result = await this._applyTransition(ACTIONS.CONFIRM, options);
      return this._actionResult(result);
    });
  }

  /**
   * review -> active，并重置 casual 的尝试、公平与沉默信息。
   * 尚未派发的机主 / 成员指向保留；transcript / attempts / roomSeq / bridges / contextEpoch 不变；不自动 run。
   */
  async continueRound(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    return this._locked(async () => {
      const result = await this._applyTransition(ACTIONS.CONTINUE, options);
      const previous = this._schedule;
      const schedule = createSchedule({
        mode: 'casual',
        seats: [...this.bridges.keys()],
        ...(this.maxAttempts === undefined ? {} : { maxAttempts: this.maxAttempts }),
      });
      schedule.round = (previous?.round ?? 0) + 1;
      schedule.messageSeq = previous?.messageSeq ?? 0;
      schedule.ownerPriority = clone(previous?.ownerPriority ?? []);
      schedule.directQueue = clone(previous?.directQueue ?? []);
      this._schedule = schedule;
      this._counterEpoch = { round: schedule.round, resetAt: new Date().toISOString() };
      await this._checkpoint();
      this._emitSafely('schedule-reset', clone(this._schedule));
      return {
        ...this._actionResult(result),
        schedule: clone(this._schedule),
      };
    });
  }

  _assertManagementIdle() {
    if (this._runPromise || this._schedule?.awaiting) {
      throw new RoomEngineError('ROOM_BUSY', '请先暂停并等待当前回合结束，再修改房间设置。');
    }
  }

  assertManagementIdle() {
    this._assertInitialized();
    this._assertManagementIdle();
  }

  _settingsSnapshot() {
    return {
      ownerName: this._ownerName,
      contextMessages: this._contextMessages,
      maxAttempts: this.maxAttempts ?? null,
      seatOrder: [...this.bridges.keys()],
      seats: [...this._seatProfiles.values()].map((profile) => ({ ...profile })),
    };
  }

  getCounters() {
    const usageBySeat = {};
    for (const seatId of this.bridges.keys()) {
      let usage = null;
      for (const attempt of this._attempts.values()) {
        if (attempt.seatId !== seatId) continue;
        if (this._counterEpoch.resetAt && attempt.startedAt < this._counterEpoch.resetAt) continue;
        usage = mergeUsage(usage, attempt.usage);
      }
      usageBySeat[seatId] = usage;
    }
    return clone({
      schemaVersion: 1,
      roomId: this.roomId,
      exportedAt: new Date().toISOString(),
      counterEpoch: this._counterEpoch,
      settings: this._settingsSnapshot(),
      schedule: this._schedule,
      totals: {
        messages: this._transcript.length,
        attemptsInStore: this._attempts.size,
      },
      usageBySeat,
    });
  }

  async resetCounters(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    return this._locked(async () => {
      this._assertManagementIdle();
      if (typeof this.store.backupCounters !== 'function') {
        throw new RoomEngineError('STORE_METHOD_MISSING', 'store.backupCounters() is required.');
      }
      const previous = this._schedule;
      const backupPath = await this.store.backupCounters(this.getCounters());
      const schedule = createSchedule({
        mode: 'casual',
        seats: [...this.bridges.keys()],
        ...(this.maxAttempts === undefined ? {} : { maxAttempts: this.maxAttempts }),
      });
      schedule.round = (previous?.round ?? 0) + 1;
      schedule.messageSeq = previous?.messageSeq ?? 0;
      schedule.ownerPriority = clone(previous?.ownerPriority ?? []);
      schedule.directQueue = clone(previous?.directQueue ?? []);
      schedule.manualQueue = clone(previous?.manualQueue ?? []);
      this._schedule = schedule;
      this._counterEpoch = { round: schedule.round, resetAt: new Date().toISOString() };
      await this._appendRoomEvent(ROOM_EVENT_TYPES.COUNTERS_RESET, 'owner', {
        round: schedule.round,
        backupPath,
        previousStats: previous?.stats ?? null,
      });
      return { round: schedule.round, backupPath, counters: this.getCounters() };
    });
  }

  async clearTranscript(options = {}) {
    assertOwnerOption(options);
    this._assertInitialized();
    return this._locked(async () => {
      this._assertManagementIdle();
      if (typeof this.store.clearTranscript !== 'function') {
        throw new RoomEngineError('STORE_METHOD_MISSING', 'store.clearTranscript() is required.');
      }
      const receipt = await this.store.clearTranscript();
      this._transcript = [];
      await this._appendRoomEvent(ROOM_EVENT_TYPES.TRANSCRIPT_CLEARED, 'owner', receipt);
      return receipt;
    });
  }

  async updateSettings(input = {}) {
    assertOwnerOption(input);
    this._assertInitialized();
    return this._locked(async () => {
      this._assertManagementIdle();
      const order = input.seatOrder;
      if (!Array.isArray(order) || order.length !== this.bridges.size
        || new Set(order).size !== order.length
        || order.some((seatId) => !this.bridges.has(seatId))) {
        throw new RoomEngineError('SEAT_ORDER_INVALID', 'seatOrder 必须恰好包含每个启用席位一次。');
      }
      if (typeof input.ownerName !== 'string' || input.ownerName.trim().length === 0) {
        throw new RoomEngineError('OWNER_NAME_INVALID', '机主昵称不能为空。');
      }
      if (!Number.isSafeInteger(input.contextMessages)
        || input.contextMessages < 1 || input.contextMessages > 20) {
        throw new RoomEngineError('CONTEXT_MESSAGES_INVALID', 'contextMessages 必须是 1..20 的整数。');
      }
      const profiles = new Map(input.seats.map((seat) => [seat.seatId, seat]));
      this.bridges = new Map(order.map((seatId) => [seatId, this.bridges.get(seatId)]));
      this._seatProfiles = new Map(order.map((seatId) => {
        const profile = profiles.get(seatId) ?? {};
        return [seatId, {
          seatId,
          displayName: profile.displayName ?? seatId,
          color: profile.color ?? null,
          clientType: profile.clientType ?? null,
        }];
      }));
      this._ownerName = input.ownerName.trim();
      this._contextMessages = input.contextMessages;
      this.maxAttempts = normalizeMaxAttempts(input.maxAttempts);
      if (this._schedule) {
        this._schedule = {
          ...this._schedule,
          seats: order.map((seatId) => this._schedule.seats.find((seat) => seat.seatId === seatId)),
        };
      }
      await this._checkpoint();
      const settings = this._settingsSnapshot();
      await this._appendRoomEvent(ROOM_EVENT_TYPES.SETTINGS_CHANGED, 'owner', { settings });
      return { settings, schedule: clone(this._schedule) };
    });
  }

  async replaceSeatBridge(input = {}) {
    assertOwnerOption(input);
    this._assertInitialized();
    return this._locked(async () => {
      this._assertManagementIdle();
      const { seatId, bridge, nativeSessionRef } = input;
      const oldBridge = this.bridges.get(seatId);
      if (!oldBridge) throw new RoomEngineError('SEAT_NOT_FOUND', `未知席位：${seatId}`);
      if (typeof oldBridge.adoptNativeSession === 'function') {
        await oldBridge.adoptNativeSession(nativeSessionRef);
        const health = { seatId, connected: true, closed: false, lastError: null, identity: null };
        if (typeof oldBridge.getIdentity === 'function') {
          try {
            health.identity = clone(await oldBridge.getIdentity());
          } catch (error) {
            health.identityError = String(error?.message ?? error);
          }
        }
        this._health.set(seatId, health);
        await this._appendRoomEvent(ROOM_EVENT_TYPES.SEAT_SESSION_CHANGED, 'owner', {
          seatId,
          nativeSessionRef,
        });
        return { seatId, nativeSessionRef, identity: health.identity };
      }
      if (!bridge || typeof bridge.connect !== 'function' || typeof bridge.subscribe !== 'function') {
        throw new RoomEngineError('BRIDGES_INVALID', '新席位 Bridge 不完整。');
      }
      await bridge.connect();
      let iterator;
      try {
        iterator = bridge.subscribe();
      } catch (error) {
        await bridge.close().catch(() => {});
        throw error;
      }
      const health = { seatId, connected: true, closed: false, lastError: null, identity: null };
      if (typeof bridge.getIdentity === 'function') {
        try {
          health.identity = clone(await bridge.getIdentity());
        } catch (error) {
          health.identityError = String(error?.message ?? error);
        }
      }
      const oldIterator = this._iterators.get(seatId);
      this.bridges.set(seatId, bridge);
      this._iterators.set(seatId, iterator);
      this._health.set(seatId, health);
      this._pumps.push(this._pump(seatId, iterator));
      if (oldIterator) await oldIterator.return?.();
      await oldBridge.close().catch(() => {});
      await this._appendRoomEvent(ROOM_EVENT_TYPES.SEAT_SESSION_CHANGED, 'owner', {
        seatId,
        nativeSessionRef,
      });
      return { seatId, nativeSessionRef, identity: health.identity };
    });
  }

  getSnapshot() {
    return clone({
      schemaVersion: ENGINE_SCHEMA_VERSION,
      roomId: this.roomId,
      room: this._room,
      schedule: this._schedule,
      settings: this._settingsSnapshot(),
      counterEpoch: this._counterEpoch,
      transcript: this._transcript,
      attempts: [...this._attempts.values()],
      foreignTurns: this._foreignTurns,
      bridges: [...this._health.values()],
      contextEpoch: this._contextEpoch,
      running: Boolean(this._runPromise),
      initialized: this._initialized,
      closed: this._closed,
      ...(this.haltGuard
        ? { halt: this.haltGuard.snapshot(this.roomId), lastHalt: this._lastHalt }
        : {}),
      ...(this.budgetGuard
        ? { budget: this.budgetGuard.snapshot(), lastBudgetError: this._lastBudgetError }
        : {}),
    });
  }

  exportMarkdown() {
    return this.store.exportMarkdown();
  }

  /** 订阅房间事件。返回取消订阅函数。type 为 'event' 时接收所有房间事件。 */
  on(type, listener) {
    this._emitter.on(type, listener);
    return () => this._emitter.off(type, listener);
  }

  once(type, listener) {
    this._emitter.once(type, listener);
    return () => this._emitter.off(type, listener);
  }

  off(type, listener) {
    this._emitter.off(type, listener);
    return this;
  }

  subscribe(listener) {
    return this.on('event', listener);
  }

  // ── 内部：状态、事件与检查点 ────────────────────────────────────────────────

  _assertInitialized() {
    if (!this._initialized) {
      throw new RoomEngineError('ENGINE_NOT_INITIALIZED', 'Call init() before using the engine.');
    }
  }

  _ensureSchedule() {
    if (this._schedule) return;
    this._schedule = createSchedule({
      mode: 'casual',
      seats: [...this.bridges.keys()],
      ...(this.maxAttempts === undefined ? {} : { maxAttempts: this.maxAttempts }),
    });
  }

  _guardStatus() {
    if (!this.haltGuard) return { dispatchable: true, halted: false, paused: false, aborted: false };
    this.haltGuard.signal(this.roomId);
    return this.haltGuard.check(this.roomId);
  }

  _guardStopReason(status) {
    return status.halted ? 'halted' : 'paused';
  }

  _unregisterAttempt(attemptId) {
    const unregister = this._attemptUnregisters.get(attemptId);
    if (!unregister) return;
    this._attemptUnregisters.delete(attemptId);
    try {
      unregister();
    } catch (error) {
      this._emitSafely('engine-error', { phase: 'unregister-attempt', attemptId, error });
    }
  }

  _seatLabel(seatId, includeId = false) {
    if (typeof seatId !== 'string' || seatId.length === 0) return '成员';
    const profile = this._seatProfiles.get(seatId);
    const name = profile?.displayName ?? seatId;
    return includeId && name !== seatId ? `${name}(${seatId})` : name;
  }

  _renderTurnText(seatId) {
    const history = this._transcript
      .filter((message) => typeof message?.text === 'string' && message.text.length > 0)
      .slice(-this._contextMessages)
      .map((message) => {
        const who = message.from === 'owner' ? this._ownerName : this._seatLabel(message.seatId, true);
        return `${who}：${message.text}`;
      });
    if (history.length === 0) history.push(DEFAULT_CONTEXT_TEXT);
    const members = [...this.bridges.keys()].map((id) => this._seatLabel(id, true));
    return [
      `【本机群聊 ${this.roomId}】`,
      `你是 ${this._seatLabel(seatId, true)}。成员：${this._ownerName}、${members.join('、')}。`,
      '以下是共享的最近聊天记录。你可以回应其中任何一条，不必承接最后一条，也不必逐一点评或总结。',
      '保持你原本的人格和说话方式。没有真正想说的话，整句只回复 [PASS]，不要因为被轮到就勉强发言。',
      '想请某位成员接话，可以在正文中 @其 seatId 或昵称。',
      '【最近聊天记录】',
      ...history,
    ].join('\n');
  }

  async _maybeFinishRound() {
    if (!this._schedule) return;
    if (this._schedule.mode !== 'casual' || !this._schedule.ended) return;
    if (this._room.state !== ACTIVE_ROOM_STATE) return;
    await this._requestReviewLocked({
      reason: 'casual-round-complete',
      actor: SCHEDULER_ACTOR,
    });
  }

  async _requestReviewLocked(options = {}) {
    const result = await this._applyTransition(ACTIONS.REQUEST_REVIEW, options);
    if (result.changed) {
      await this._appendRoomEvent(
        ROOM_EVENT_TYPES.REVIEW_REQUESTED,
        result.event?.actor ?? options.actor ?? OWNER_ACTOR,
        {
          ...(result.event?.payload?.reason ? { reason: result.event.payload.reason } : {}),
          from: result.event?.payload?.from ?? null,
          attemptsUsed: this._schedule?.attemptsUsed ?? 0,
        },
      );
    }
    return result;
  }

  async _applyTransition(action, options = {}) {
    const result = transition(this._room, action, {
      actor: options.actor ?? OWNER_ACTOR,
      ...(options.reason === undefined ? {} : { reason: options.reason }),
    });
    if (result.changed) await this._commitTransition(result);
    return result;
  }

  async _commitTransition(result) {
    for (const event of result.events) {
      this._room = { ...result.snapshot, lastRoomSeq: event.roomSeq };
      await this.store.appendEvent(clone(event));
      await this._checkpoint();
      this._emitRoomEvent(event);
    }
  }

  _actionResult(result) {
    return {
      changed: result.changed,
      state: result.state,
      events: clone(result.events),
      lastRoomSeq: this._room.lastRoomSeq,
    };
  }

  async _appendRoomEvent(type, actor, payload = {}) {
    const roomSeq = this._room.lastRoomSeq + 1;
    const event = createRoomEvent({
      type,
      roomId: this.roomId,
      roomSeq,
      actor,
      payload,
    });
    this._room = { ...this._room, lastRoomSeq: roomSeq };
    await this.store.appendEvent(clone(event));
    await this._checkpoint();
    this._emitRoomEvent(event);
    return event;
  }

  async _checkpoint() {
    await this.store.saveCheckpoint({
      room: clone(this._room),
      schedule: this._schedule === null ? null : clone(this._schedule),
      cursors: {
        roomSeq: this._room.lastRoomSeq,
        messageCount: this._transcript.length,
        attemptCount: this._attempts.size,
        selectionSeq: this._schedule?.selectionSeq ?? 0,
        contextEpoch: this._contextEpoch,
      },
    });
  }

  // 兼容同步记录路径：recordResult 本身是纯函数，实际检查点由调用方 await。
  _emitRoomEvent(event) {
    this._emitSafely('event', event);
    this._emitSafely(event.type, event);
  }

  _emitSafely(type, payload) {
    try {
      this._emitter.emit(type, payload);
    } catch (error) {
      this._listenerErrors.push(error);
    }
  }

  _locked(task) {
    const result = this._lock.then(task, task);
    this._lock = result.then(() => undefined, () => undefined);
    return result;
  }

  _waitForTerminal(attemptId) {
    if (this._terminals.has(attemptId)) {
      return Promise.resolve(this._terminals.get(attemptId));
    }
    if (this._closed) {
      return Promise.resolve({
        outcome: 'aborted',
        reason: 'engine-closed',
        error: { code: 'ENGINE_CLOSED' },
      });
    }
    return new Promise((resolve) => {
      this._pending.set(attemptId, resolve);
    });
  }

  _settleAttempt(attemptId, terminal) {
    this._unregisterAttempt(attemptId);
    this._terminals.set(attemptId, terminal);
    const resolve = this._pending.get(attemptId);
    if (resolve) {
      this._pending.delete(attemptId);
      resolve(terminal);
    }
  }

  // ── 内部：Bridge 事件泵 ────────────────────────────────────────────────────

  async _handleBridgeEvent(pumpSeatId, event) {
    if (!event || typeof event !== 'object') return;
    if (this._closed) return;
    if (event.eventId && this._seenBridgeEventIds.has(event.eventId)) return;
    if (event.eventId) this._seenBridgeEventIds.add(event.eventId);

    const seatId = typeof event.seatId === 'string' && event.seatId.length > 0
      ? event.seatId
      : pumpSeatId;
    const attemptId = event.attemptId ?? null;
    const payload = event.payload ?? {};
    const actor = `seat:${seatId}`;

    this._emitSafely('bridge-event', event);

    switch (event.type) {
      case BRIDGE_EVENT_TYPES.ATTEMPT_STARTED: {
        if (!attemptId) return;
        const attempt = this._getOrCreateAttempt(attemptId, seatId, event.occurredAt);
        attempt.status = 'running';
        attempt.nativeTurnRef = payload.nativeTurnRef ?? attempt.nativeTurnRef;
        await this.store.appendAttempt(clone(attempt));
        await this._checkpoint();
        await this._appendRoomEvent(ROOM_EVENT_TYPES.MEMBER_THINKING, actor, {
          attemptId,
          seatId,
          nativeTurnRef: attempt.nativeTurnRef,
          ...(this._awaitingSelectionSeq(seatId, attemptId)),
        });
        return;
      }

      case BRIDGE_EVENT_TYPES.ATTEMPT_COMPLETED:
        await this._handleAttemptCompleted(seatId, attemptId, payload, event.occurredAt);
        return;

      case BRIDGE_EVENT_TYPES.ATTEMPT_ABORTED:
        await this._handleAttemptAborted(seatId, attemptId, payload, event.occurredAt);
        return;

      case BRIDGE_EVENT_TYPES.ATTEMPT_FAILED:
        await this._handleAttemptFailed(seatId, attemptId, payload, event.occurredAt);
        return;

      case BRIDGE_EVENT_TYPES.USAGE_REPORTED:
        await this._handleUsageReported(seatId, attemptId, payload);
        return;

      case BRIDGE_EVENT_TYPES.FOREIGN_TURN: {
        const record = {
          seatId,
          nativeTurnRef: payload.nativeTurnRef ?? null,
          reason: payload.reason ?? null,
          occurredAt: event.occurredAt ?? new Date().toISOString(),
        };
        this._foreignTurns.push(record);
        this._emitSafely('foreign-turn', record);
        return;
      }

      case BRIDGE_EVENT_TYPES.SPEECH_STARTED:
      case BRIDGE_EVENT_TYPES.SPEECH_FINISHED:
      case BRIDGE_EVENT_TYPES.SPEECH_FAILED: {
        const type = event.type === BRIDGE_EVENT_TYPES.SPEECH_STARTED
          ? ROOM_EVENT_TYPES.SPEECH_STARTED
          : event.type === BRIDGE_EVENT_TYPES.SPEECH_FINISHED
            ? ROOM_EVENT_TYPES.SPEECH_FINISHED
            : ROOM_EVENT_TYPES.SPEECH_FAILED;
        await this._appendRoomEvent(type, actor, {
          attemptId,
          seatId,
          ...clone(payload),
        });
        return;
      }

      case BRIDGE_EVENT_TYPES.BRIDGE_ERROR: {
        const health = this._health.get(seatId);
        if (health) health.lastError = clone(payload.error ?? payload);
        this._emitSafely('bridge-error', { seatId, error: clone(payload.error ?? payload) });
        return;
      }

      case BRIDGE_EVENT_TYPES.BRIDGE_CLOSED: {
        const health = this._health.get(seatId);
        if (health) {
          health.connected = false;
          health.closed = true;
        }
        this._emitSafely('bridge-closed', { seatId, reason: payload.reason ?? null });
        return;
      }

      default:
        this._emitSafely('unknown-bridge-event', { seatId, event });
    }
  }

  _awaitingSelectionSeq(seatId, attemptId) {
    if (!this._schedule?.awaiting || this._schedule.awaiting.seatId !== seatId) return {};
    return { selectionSeq: this._schedule.awaiting.selectionSeq };
  }

  _getOrCreateAttempt(attemptId, seatId, occurredAt) {
    if (!attemptId) return null;
    let attempt = this._attempts.get(attemptId);
    if (attempt) return attempt;
    attempt = {
      attemptId,
      seatId,
      status: 'running',
      terminal: false,
      startedAt: occurredAt ?? new Date().toISOString(),
      endedAt: null,
      text: null,
      partialText: '',
      usage: null,
      error: null,
      nativeTurnRef: null,
      nativeMessageRef: null,
    };
    this._attempts.set(attemptId, attempt);
    return attempt;
  }

  async _handleAttemptCompleted(seatId, attemptId, payload, occurredAt) {
    if (!attemptId) return;
    const nativeMessageRef = payload.nativeMessageRef ?? null;
    if (nativeMessageRef && this._seenNativeFinalRefs.has(nativeMessageRef)) return;
    const attempt = this._getOrCreateAttempt(attemptId, seatId, occurredAt);
    if (attempt.terminal) return;
    if (nativeMessageRef) this._seenNativeFinalRefs.add(nativeMessageRef);

    const text = typeof payload.text === 'string' ? payload.text : '';
    attempt.status = 'completed';
    attempt.terminal = true;
    attempt.text = text;
    attempt.nativeTurnRef = payload.nativeTurnRef ?? attempt.nativeTurnRef;
    attempt.nativeMessageRef = nativeMessageRef;
    attempt.usage = mergeUsage(attempt.usage, payload.usage);
    attempt.endedAt = occurredAt ?? new Date().toISOString();
    await this.store.appendAttempt(clone(attempt));
    await this._checkpoint();

    const actor = `seat:${seatId}`;
    const terminal = { outcome: 'completed', text, usage: attempt.usage };

    if (isPass(text)) {
      await this._appendRoomEvent(ROOM_EVENT_TYPES.MEMBER_PASSED, actor, {
        attemptId,
        seatId,
        nativeTurnRef: attempt.nativeTurnRef,
        nativeMessageRef,
      });
      terminal.outcome = 'pass';
      this._settleAttempt(attemptId, terminal);
      return;
    }

    await this._appendRoomEvent(ROOM_EVENT_TYPES.MEMBER_RESPONDED, actor, {
      attemptId,
      seatId,
      text,
      nativeTurnRef: attempt.nativeTurnRef,
      nativeMessageRef,
    });

    const messageId = `m_${randomUUID()}`;
    const now = occurredAt ?? new Date().toISOString();
    const mentions = extractMemberMentions(text, seatId, this._seatProfiles);
    // MemberResponded 已追加，这里预留紧随其后的 MessagePosted 序号。
    const roomSeq = this._room.lastRoomSeq + 1;
    const message = {
      id: messageId,
      messageId,
      roomId: this.roomId,
      roomSeq,
      turnId: turnIdForAttempt(attemptId),
      attemptId,
      from: 'member',
      actor,
      seatId,
      text,
      mentions,
      replyTo: null,
      nominations: [],
      createdAt: now,
      occurredAt: now,
    };
    this._transcript.push(message);
    await this.store.appendMessage(clone(message));
    this._schedule = applyMessage(this._schedule, {
      from: 'member',
      seatId,
      mentions,
    });
    await this._checkpoint();

    await this._appendRoomEvent(ROOM_EVENT_TYPES.MESSAGE_POSTED, actor, {
      messageId: message.messageId,
      roomSeq,
      from: 'member',
      seatId,
      text,
      mentions,
      attemptId,
      turnId: message.turnId,
    });

    this._settleAttempt(attemptId, terminal);
  }

  async _handleAttemptAborted(seatId, attemptId, payload, occurredAt) {
    if (!attemptId) return;
    const attempt = this._getOrCreateAttempt(attemptId, seatId, occurredAt);
    if (attempt.terminal) return;
    attempt.status = 'aborted';
    attempt.terminal = true;
    attempt.partialText = typeof payload.partialText === 'string' ? payload.partialText : '';
    attempt.nativeTurnRef = payload.nativeTurnRef ?? attempt.nativeTurnRef;
    attempt.usage = mergeUsage(attempt.usage, payload.usage);
    attempt.endedAt = occurredAt ?? new Date().toISOString();
    await this.store.appendAttempt(clone(attempt));
    await this._checkpoint();
    this._settleAttempt(attemptId, {
      outcome: 'aborted',
      text: undefined,
      usage: attempt.usage,
    });
  }

  async _handleAttemptFailed(seatId, attemptId, payload, occurredAt) {
    if (!attemptId) return;
    const attempt = this._getOrCreateAttempt(attemptId, seatId, occurredAt);
    if (attempt.terminal) return;
    const error = clone(payload.error ?? { code: 'ATTEMPT_FAILED' });
    attempt.status = 'failed';
    attempt.terminal = true;
    attempt.error = error;
    attempt.nativeTurnRef = payload.nativeTurnRef ?? attempt.nativeTurnRef;
    attempt.usage = mergeUsage(attempt.usage, payload.usage);
    attempt.endedAt = occurredAt ?? new Date().toISOString();
    await this.store.appendAttempt(clone(attempt));
    await this._checkpoint();
    await this._appendRoomEvent(ROOM_EVENT_TYPES.MEMBER_FAILED, `seat:${seatId}`, {
      attemptId,
      seatId,
      error,
      nativeTurnRef: attempt.nativeTurnRef,
    });
    this._settleAttempt(attemptId, { outcome: 'failed', error, usage: attempt.usage });
  }

  async _handleUsageReported(seatId, attemptId, payload) {
    const usage = payload.usage ?? null;
    if (!attemptId) return;
    const attempt = this._getOrCreateAttempt(attemptId, seatId, new Date().toISOString());
    attempt.usage = mergeUsage(attempt.usage, usage);
    attempt.nativeTurnRef = payload.nativeTurnRef ?? attempt.nativeTurnRef;
    await this.store.appendAttempt(clone(attempt));
    await this._checkpoint();
  }
}

function turnIdForAttempt(attemptId) {
  return `turn_${attemptId}`;
}

function extractMemberMentions(text, senderSeatId, seatProfiles) {
  const known = new Map();
  for (const profile of seatProfiles.values()) {
    known.set(profile.seatId.toLowerCase(), profile.seatId);
    known.set(profile.displayName.toLowerCase(), profile.seatId);
  }
  const mentions = [];
  for (const match of text.matchAll(/@([^\s@]+)/g)) {
    const alias = match[1].replace(/[\s.,，。!！?？:：;；、)\]}）】》]+$/g, '');
    const seatId = known.get(alias.toLowerCase());
    if (!seatId || seatId === senderSeatId || mentions.includes(seatId)) continue;
    mentions.push(seatId);
  }
  return mentions;
}

function normalizeStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new RoomEngineError('MESSAGE_TARGET_INVALID', `${field} must be an array of seat ids.`, { field });
  }
  return [...value];
}

export function createRoomEngine(config = {}) {
  return new RoomEngine(config);
}
