/**
 * 纯发言调度器。
 *
 * 约束：
 * - 不导入任何模块，不做 I/O、不读时钟、不启动计时器。
 * - 不区分客户端，也不读取语音状态；座位状态只作为输入快照。
 * - 所有公开函数的输入、返回值都是可 JSON 序列化的普通数据。
 * - 不修改传入的 state / config / message / result。
 *
 * 终态 attempt 才消耗预算；选择下一席本身不消耗。
 * casual 按席位记录 PASS：成员发言后其余席位都跳过，或机主新话题后全部跳过，本轮结束。
 */

export const SCHEDULER_SCHEMA_VERSION = 1;

export const SCHEDULER_MODES = Object.freeze(['manual', 'addressed', 'casual']);

export const TERMINAL_OUTCOMES = Object.freeze(['completed', 'pass', 'failed', 'aborted']);

export const DEFAULT_CASUAL_MAX_ATTEMPTS = 8;
export const MAX_CASUAL_ATTEMPTS = 12;

/**
 * 这些状态表示席位当前无法接受文本发言，调度时跳过。
 * 注意：speaking 只表示原生语音，muted 只表示语音静音，均不阻止文本发言。
 */
export const BLOCKING_SEAT_STATUSES = Object.freeze([
  'disabled',
  'thinking',
  'paused',
  'error',
  'halted',
]);

const MODE_SET = new Set(SCHEDULER_MODES);
const OUTCOME_SET = new Set(TERMINAL_OUTCOMES);
const BLOCKING_STATUS_SET = new Set(BLOCKING_SEAT_STATUSES);

export function isSpeakableStatus(status) {
  return !BLOCKING_STATUS_SET.has(status);
}

/** PASS 只认去除首尾空白后与 [PASS] 完全相等。 */
export function isPass(text) {
  return typeof text === 'string' && text.trim() === '[PASS]';
}

/**
 * 创建一个可序列化的排程状态。
 *
 * @param {Object} config
 * @param {'manual'|'addressed'|'casual'} config.mode
 * @param {Array<string|{seatId:string,status?:string}>} config.seats 稳定席位顺序
 * @param {number} [config.maxAttempts] 仅 casual；默认 8，范围 1..12
 */
export function createSchedule(config = {}) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('createSchedule() requires a config object.');
  }
  if (!MODE_SET.has(config.mode)) {
    throw new TypeError(`Unknown scheduler mode: ${String(config.mode)}`);
  }
  if (!Array.isArray(config.seats) || config.seats.length === 0) {
    throw new TypeError('createSchedule() requires a non-empty seats array.');
  }
  if (config.mode !== 'casual' && config.maxAttempts !== undefined) {
    throw new TypeError('maxAttempts is only valid for casual mode.');
  }

  const seats = normalizeSeats(config.seats);
  const maxAttempts = config.mode === 'casual'
    ? normalizeMaxAttempts(config.maxAttempts)
    : null;

  return {
    schemaVersion: SCHEDULER_SCHEMA_VERSION,
    mode: config.mode,
    round: 1,
    maxAttempts,
    attemptsUsed: 0,
    passSeatIds: [],
    lastSpeakerSeatId: null,
    selectionSeq: 0,
    messageSeq: 0,
    started: true,
    ended: false,
    awaiting: null,
    lastSelected: null,
    seats,
    ownerPriority: [],
    directQueue: [],
    manualQueue: [],
    terminalAttempts: [],
    stats: {
      completed: 0,
      pass: 0,
      failed: 0,
      aborted: 0,
    },
  };
}

export function migrateSchedule(state) {
  assertState(state);
  const counts = new Map();
  for (const attempt of state.terminalAttempts) {
    if (!OUTCOME_SET.has(attempt.outcome)) continue;
    const current = counts.get(attempt.seatId) ?? { completed: 0, pass: 0, failed: 0, aborted: 0 };
    current[attempt.outcome] += 1;
    counts.set(attempt.seatId, current);
  }
  return {
    ...state,
    seats: state.seats.map((seat) => ({
      ...seat,
      stats: seat.stats ?? counts.get(seat.seatId) ?? { completed: 0, pass: 0, failed: 0, aborted: 0 },
    })),
  };
}

/**
 * 机主或成员发言进入调度器。
 *
 * - owner：manual 队列追加显式点名；addressed/casual 追加最高优先级的直接指向。
 * - member：addressed/casual 的 @ / replyTo 进入普通直达队列。
 * - manual 模式忽略成员 @；只有机主点名会进入队列。
 *
 * @param {Object} state
 * @param {Object} message
 * @param {'owner'|'member'} message.from
 * @param {string[]} [message.mentions]
 * @param {string} [message.replyTo]
 * @param {string[]} [message.nominations] 仅 owner 有效
 */
export function applyMessage(state, message = {}) {
  assertState(state);
  if (!message || typeof message !== 'object') {
    throw new TypeError('applyMessage() requires a message object.');
  }
  const isOwner = message.from === 'owner';
  if (!isOwner && message.from !== 'member') {
    throw new TypeError("message.from must be 'owner' or 'member'.");
  }

  const next = cloneState(state);
  const targets = collectTargets(message, next.seats, isOwner);

  if (isOwner && next.mode === 'casual') {
    next.started = true;
    next.passSeatIds = [];
    next.lastSpeakerSeatId = null;
  }
  if (targets.length === 0) return next;

  next.messageSeq += 1;
  const issued = targets.map((target) => ({
    ...target,
    issuedSeq: next.messageSeq,
  }));

  if (next.mode === 'manual') {
    if (isOwner) next.manualQueue.push(...issued);
    return next;
  }
  if (isOwner) {
    next.ownerPriority.push(...issued);
  } else {
    next.directQueue.push(...issued);
  }
  return next;
}

/**
 * 选择下一席，但不消耗 attempt 预算。
 *
 * 返回 { state, decision }：
 * - decision.selected === true 时包含 seatId / reason / selectionSeq。
 * - 没有可派发对象时 selected === false，并给出稳定 reason。
 * - 已有在途 attempt 时不会重复选择。
 *
 * @param {Object} state
 * @returns {{state: Object, decision: Object}}
 */
export function selectNext(state) {
  assertState(state);

  if (state.ended) return noSelection(state, 'round-complete');
  if (state.awaiting !== null) return noSelection(state, 'attempt-in-flight');

  if (state.mode === 'casual' && state.attemptsUsed >= state.maxAttempts) {
    const ended = cloneState(state);
    ended.ended = true;
    return noSelection(ended, 'round-complete');
  }

  const next = cloneState(state);

  if (next.mode === 'manual') {
    const selected = selectFromQueue(next, 'manualQueue');
    if (selected) return selected;
    return noSelection(next, 'no-nomination');
  }

  // 机主点名始终先于普通消息产生的直达目标，
  // 因此尚未开始的旧自动排程不能越过机主插话。
  const ownerSelected = selectFromQueue(next, 'ownerPriority');
  if (ownerSelected) return ownerSelected;

  const directSelected = selectFromQueue(next, 'directQueue');
  if (directSelected) return directSelected;

  if (next.mode === 'addressed') {
    return noSelection(next, 'no-addressed-target');
  }

  return selectFairly(next);
}

/**
 * 记录一个终态结果。
 *
 * completed / pass / failed / aborted 都消耗一次 attempt。
 * completed 且正文为 [PASS] 时自动归类为 pass；显式 outcome:'pass'
 * 必须同时给出精确的 [PASS] 正文。
 *
 * 同一 attemptId 的重复终态返回 duplicate:true，不重复消耗预算。
 *
 * @param {Object} state
 * @param {Object} result
 * @param {string} result.attemptId
 * @param {string} result.seatId
 * @param {'completed'|'pass'|'failed'|'aborted'} result.outcome
 * @param {string} [result.text] completed/pass 必填
 * @param {{code?:string}} [result.error]
 * @returns {{state:Object, applied:boolean, duplicate:boolean, reason?:string, outcome?:string, attemptSeq?:number, ended:boolean}}
 */
export function recordResult(state, result = {}) {
  assertState(state);
  if (!result || typeof result !== 'object') {
    throw new TypeError('recordResult() requires a result object.');
  }
  if (typeof result.attemptId !== 'string' || result.attemptId.length === 0) {
    throw new TypeError('result.attemptId must be a non-empty string.');
  }
  if (typeof result.seatId !== 'string' || result.seatId.length === 0) {
    throw new TypeError('result.seatId must be a non-empty string.');
  }
  const seat = state.seats.find((entry) => entry.seatId === result.seatId);
  if (!seat) {
    throw new RangeError(`Unknown seatId: ${result.seatId}`);
  }
  if (!OUTCOME_SET.has(result.outcome)) {
    throw new TypeError(`Unknown terminal outcome: ${String(result.outcome)}`);
  }
  if (result.text !== undefined && typeof result.text !== 'string') {
    throw new TypeError('result.text must be a string when provided.');
  }

  const outcome = normalizeOutcome(result);

  const existing = state.terminalAttempts.find(
    (entry) => entry.attemptId === result.attemptId,
  );
  if (existing) {
    return {
      state,
      applied: false,
      duplicate: true,
      outcome: existing.outcome,
      attemptSeq: existing.attemptSeq,
      ended: state.ended,
    };
  }

  if (state.awaiting !== null && state.awaiting.seatId !== result.seatId) {
    throw new TypeError(
      `Result for seat ${result.seatId} does not match in-flight seat ${state.awaiting.seatId}.`,
    );
  }
  if (state.ended) {
    return {
      state,
      applied: false,
      duplicate: false,
      reason: 'round-ended',
      ended: true,
    };
  }

  const next = cloneState(state);
  const nextSeat = next.seats.find((entry) => entry.seatId === result.seatId);

  if (next.awaiting !== null && next.awaiting.seatId === result.seatId) {
    next.awaiting = null;
  }

  const attemptSeq = next.attemptsUsed + 1;
  next.attemptsUsed = attemptSeq;
  next.stats[outcome] += 1;
  nextSeat.stats = {
    completed: 0,
    pass: 0,
    failed: 0,
    aborted: 0,
    ...nextSeat.stats,
  };
  nextSeat.stats[outcome] += 1;

  const lastAttempt = {
    attemptId: result.attemptId,
    outcome,
    attemptSeq,
    round: next.round,
  };
  if (typeof result.error?.code === 'string') {
    lastAttempt.errorCode = result.error.code;
  }
  nextSeat.lastAttempt = lastAttempt;
  nextSeat.lastAttemptSeq = attemptSeq;

  if (outcome === 'completed') {
    nextSeat.lastSpokeSeq = attemptSeq;
    nextSeat.lastCompleted = {
      attemptId: result.attemptId,
      attemptSeq,
      round: next.round,
    };
  }

  next.terminalAttempts.push({
    attemptId: result.attemptId,
    seatId: result.seatId,
    outcome,
    attemptSeq,
    round: next.round,
  });

  if (next.mode === 'casual') {
    next.lastSpeakerSeatId ??= null;
    const previousPasses = Array.isArray(next.passSeatIds) ? next.passSeatIds : [];
    next.passSeatIds = previousPasses;
    if (outcome === 'completed') {
      next.lastSpeakerSeatId = result.seatId;
      next.passSeatIds = [];
    } else if (outcome === 'pass') {
      next.passSeatIds = previousPasses.includes(result.seatId)
        ? previousPasses
        : [...previousPasses, result.seatId];
    }
    const waitingCount = next.seats.filter((seat) => (
      isSpeakableStatus(seat.status)
      && seat.seatId !== next.lastSpeakerSeatId
      && !next.passSeatIds.includes(seat.seatId)
    )).length;
    const allOthersPassed = waitingCount === 0
      && (next.lastSpeakerSeatId !== null || next.passSeatIds.length > 0);
    if (next.attemptsUsed >= next.maxAttempts || allOthersPassed) next.ended = true;
  }

  return {
    state: next,
    applied: true,
    duplicate: false,
    outcome,
    attemptSeq,
    ended: next.ended,
  };
}

/** 只更新调度器保存的座位状态快照；不影响公平信息。 */
export function setSeatStatus(state, seatId, status) {
  assertState(state);
  if (typeof status !== 'string' || status.length === 0) {
    throw new TypeError('status must be a non-empty string.');
  }
  const index = state.seats.findIndex((seat) => seat.seatId === seatId);
  if (index === -1) throw new RangeError(`Unknown seatId: ${seatId}`);
  const next = cloneState(state);
  next.seats[index].status = status;
  return next;
}

// ── 内部实现 ────────────────────────────────────────────────────────────────

function normalizeSeats(rawSeats) {
  const seen = new Set();
  return rawSeats.map((raw) => {
    const seat = typeof raw === 'string' ? { seatId: raw } : raw;
    if (!seat || typeof seat !== 'object') {
      throw new TypeError('Each seat must be a string or an object.');
    }
    if (typeof seat.seatId !== 'string' || seat.seatId.length === 0) {
      throw new TypeError('Each seat requires a non-empty seatId.');
    }
    if (seen.has(seat.seatId)) {
      throw new TypeError(`Duplicate seatId: ${seat.seatId}`);
    }
    seen.add(seat.seatId);
    const status = seat.status === undefined ? 'idle' : seat.status;
    if (typeof status !== 'string' || status.length === 0) {
      throw new TypeError(`Seat ${seat.seatId} requires a non-empty status.`);
    }
    // 刻意不复制 voice / voiceState 等语音字段：语音不参与调度。
    return {
      seatId: seat.seatId,
      status,
      lastSelectedSeq: 0,
      lastAttemptSeq: 0,
      lastSpokeSeq: 0,
      lastAttempt: null,
      lastCompleted: null,
      stats: { completed: 0, pass: 0, failed: 0, aborted: 0 },
    };
  });
}

function normalizeMaxAttempts(value) {
  const maxAttempts = value === undefined ? DEFAULT_CASUAL_MAX_ATTEMPTS : value;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_CASUAL_ATTEMPTS) {
    throw new RangeError(
      `casual maxAttempts must be an integer between 1 and ${MAX_CASUAL_ATTEMPTS}.`,
    );
  }
  return maxAttempts;
}

function collectTargets(message, seats, isOwner) {
  const mentions = message.mentions === undefined ? [] : message.mentions;
  if (!Array.isArray(mentions)) {
    throw new TypeError('message.mentions must be an array when provided.');
  }
  const nominations = message.nominations === undefined ? [] : message.nominations;
  if (!Array.isArray(nominations)) {
    throw new TypeError('message.nominations must be an array when provided.');
  }
  if (message.replyTo !== undefined && typeof message.replyTo !== 'string') {
    throw new TypeError('message.replyTo must be a string when provided.');
  }

  const known = new Set(seats.map((seat) => seat.seatId));
  const targets = [];
  const add = (seatId, source) => {
    if (typeof seatId !== 'string' || !known.has(seatId)) return;
    if (targets.some((target) => target.seatId === seatId)) return;
    targets.push({ seatId, source });
  };

  for (const seatId of mentions) {
    add(seatId, isOwner ? 'owner-mention' : 'mention');
  }
  if (message.replyTo !== undefined) {
    add(message.replyTo, isOwner ? 'owner-reply' : 'replyTo');
  }
  if (isOwner) {
    for (const seatId of nominations) {
      add(seatId, 'owner-nomination');
    }
  }
  return targets;
}

function selectFromQueue(next, queueKey) {
  const queue = next[queueKey];
  let index = 0;
  while (index < queue.length) {
    const item = queue[index];
    const seat = next.seats.find((entry) => entry.seatId === item.seatId);
    if (!seat || !isSpeakableStatus(seat.status)) {
      queue.splice(index, 1);
      continue;
    }
    queue.splice(index, 1);
    return selectSeat(next, seat, item.source);
  }
  return null;
}

function selectFairly(next) {
  const speakable = next.seats
    .map((seat, index) => ({ seat, index }))
    .filter(({ seat }) => isSpeakableStatus(seat.status));

  if (speakable.length === 0) {
    return noSelection(next, 'no-eligible-seat');
  }

  const lastSeatId = next.lastSelected === null ? null : next.lastSelected.seatId;
  const candidates = speakable.filter(({ seat }) => seat.seatId !== lastSeatId);
  if (candidates.length === 0) {
    return noSelection(next, 'consecutive-blocked');
  }

  candidates.sort((left, right) => {
    if (left.seat.lastSpokeSeq !== right.seat.lastSpokeSeq) {
      return left.seat.lastSpokeSeq - right.seat.lastSpokeSeq;
    }
    return left.index - right.index;
  });

  return selectSeat(next, candidates[0].seat, 'longest-silence');
}

function selectSeat(next, seat, reason) {
  next.selectionSeq += 1;
  seat.lastSelectedSeq = next.selectionSeq;
  next.awaiting = {
    seatId: seat.seatId,
    selectionSeq: next.selectionSeq,
    round: next.round,
    mode: next.mode,
  };
  next.lastSelected = {
    seatId: seat.seatId,
    selectionSeq: next.selectionSeq,
    round: next.round,
    reason,
  };
  return {
    state: next,
    decision: {
      selected: true,
      seatId: seat.seatId,
      mode: next.mode,
      reason,
      round: next.round,
      selectionSeq: next.selectionSeq,
      attemptsUsed: next.attemptsUsed,
      maxAttempts: next.maxAttempts,
    },
  };
}

function noSelection(state, reason) {
  return {
    state,
    decision: {
      selected: false,
      seatId: null,
      mode: state.mode,
      reason,
      round: state.round,
      selectionSeq: state.selectionSeq,
      attemptsUsed: state.attemptsUsed,
      maxAttempts: state.maxAttempts,
    },
  };
}

function normalizeOutcome(result) {
  if (result.outcome === 'completed') {
    if (typeof result.text !== 'string') {
      throw new TypeError('completed result requires a text string.');
    }
    return isPass(result.text) ? 'pass' : 'completed';
  }
  if (result.outcome === 'pass') {
    if (!isPass(result.text)) {
      throw new RangeError('pass result requires text that trims to exactly [PASS].');
    }
    return 'pass';
  }
  return result.outcome;
}

function cloneState(state) {
  return {
    ...state,
    seats: state.seats.map((seat) => ({
      ...seat,
      lastAttempt: seat.lastAttempt === null ? null : { ...seat.lastAttempt },
      lastCompleted: seat.lastCompleted === null ? null : { ...seat.lastCompleted },
      stats: { ...seat.stats },
    })),
    awaiting: state.awaiting === null ? null : { ...state.awaiting },
    lastSelected: state.lastSelected === null ? null : { ...state.lastSelected },
    ownerPriority: state.ownerPriority.map((item) => ({ ...item })),
    directQueue: state.directQueue.map((item) => ({ ...item })),
    manualQueue: state.manualQueue.map((item) => ({ ...item })),
    terminalAttempts: state.terminalAttempts.map((entry) => ({ ...entry })),
    passSeatIds: Array.isArray(state.passSeatIds) ? [...state.passSeatIds] : [],
    stats: { ...state.stats },
  };
}

function assertState(state) {
  if (!state || typeof state !== 'object') {
    throw new TypeError('Scheduler state must be an object.');
  }
  if (state.schemaVersion !== SCHEDULER_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported scheduler schemaVersion: ${String(state.schemaVersion)}`);
  }
  if (!MODE_SET.has(state.mode)) {
    throw new TypeError(`Unknown scheduler mode: ${String(state.mode)}`);
  }
  if (!Array.isArray(state.seats) || state.seats.length === 0) {
    throw new TypeError('Scheduler state requires seats.');
  }
  if (!Array.isArray(state.ownerPriority)
    || !Array.isArray(state.directQueue)
    || !Array.isArray(state.manualQueue)
    || !Array.isArray(state.terminalAttempts)) {
    throw new TypeError('Scheduler state queues are invalid.');
  }
}
