import { ROOM_EVENT_TYPES, createRoomEvent } from './events.mjs';

export const ROOM_STATE_SCHEMA_VERSION = 1;

export const ROOM_STATES = Object.freeze([
  'draft',
  'active',
  'paused',
  'review',
  'confirmed',
  'archived',
  'halted',
]);

const STATE_SET = new Set(ROOM_STATES);

export const OWNER_ACTOR = 'owner';
export const SCHEDULER_ACTOR = 'system:scheduler';
export const RESTORE_ACTOR = 'system:restart';
export const RESTORE_ACTION = 'restore-pause';

export const ACTIONS = Object.freeze({
  ACTIVATE: 'activate',
  PAUSE: 'pause',
  RESUME: 'resume',
  REQUEST_REVIEW: 'request-review',
  CONTINUE: 'continue',
  CONFIRM: 'confirm',
  ARCHIVE: 'archive',
  HALT: 'halt',
  UNHALT: 'unhalt',
});

const IDEMPOTENT_ACTIONS = new Set([ACTIONS.CONFIRM, ACTIONS.ARCHIVE, ACTIONS.HALT]);

const ACTION_DEFINITIONS = Object.freeze({
  [ACTIONS.ACTIVATE]: { from: ['draft'], to: 'active' },
  [ACTIONS.PAUSE]: { from: ['active'], to: 'paused' },
  [ACTIONS.RESUME]: { from: ['paused'], to: 'active' },
  [ACTIONS.REQUEST_REVIEW]: { from: ['active', 'paused'], to: 'review' },
  [ACTIONS.CONTINUE]: { from: ['review'], to: 'active' },
  [ACTIONS.CONFIRM]: { from: ['review'], to: 'confirmed' },
  [ACTIONS.ARCHIVE]: { from: ['confirmed'], to: 'archived' },
  [ACTIONS.HALT]: { from: ['draft', 'active', 'paused', 'review', 'confirmed'], to: 'halted' },
  [ACTIONS.UNHALT]: { from: ['halted'], to: 'paused' },
});

const LEGAL_PAIRS = new Set();
for (const [action, definition] of Object.entries(ACTION_DEFINITIONS)) {
  for (const from of definition.from) {
    LEGAL_PAIRS.add(`${from}->${definition.to}`);
  }
  if (IDEMPOTENT_ACTIONS.has(action)) {
    LEGAL_PAIRS.add(`${definition.to}->${definition.to}`);
  }
}

const NON_OWNER_ACTOR_HEADS = new Set([
  'seat',
  'system',
  'ai',
  'assistant',
  'member',
  'room',
  'message',
  'ui',
  'client',
  'agent',
]);

export class RoomStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RoomStateError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, RoomStateError);
    }
  }
}

function actorKind(actor) {
  if (typeof actor !== 'string' || actor.length === 0 || actor.trim() !== actor) {
    return 'invalid';
  }
  if (actor === OWNER_ACTOR) {
    return 'owner';
  }
  const colon = actor.indexOf(':');
  const head = colon === -1 ? actor : actor.slice(0, colon);
  if (NON_OWNER_ACTOR_HEADS.has(head)) {
    return 'non-owner';
  }
  return 'unknown';
}

function isAuthorizedActor(actor) {
  const kind = actorKind(actor);
  if (kind === 'owner') {
    return true;
  }
  if (kind === 'non-owner') {
    return false;
  }
  if (kind === 'unknown') {
    throw new RoomStateError('UNKNOWN_ACTOR', `Unknown actor: ${String(actor)}`, { actor });
  }
  throw new RoomStateError('ACTOR_INVALID', 'Actor must be a non-empty string without surrounding whitespace.', { actor });
}

/**
 * 自动调度器只能请求 review，不能执行任何机主管理动作。
 * 该 actor 故意不通过 assertOwner；只有 transition/canTransition 的
 * REQUEST_REVIEW 路径会显式放行。
 */
function resolveTransitionActor(actor, action) {
  if (actor === SCHEDULER_ACTOR) {
    if (action === ACTIONS.REQUEST_REVIEW) return SCHEDULER_ACTOR;
    throw new RoomStateError(
      'ACTOR_NOT_OWNER',
      'The scheduler may only request review.',
      { actor, required: OWNER_ACTOR, action },
    );
  }
  assertOwner(actor);
  return OWNER_ACTOR;
}

/**
 * 管理操作只接受 actor='owner'。seat/system/AI/房间文本等一律拒绝，
 * 字符串大小写、空白、冒号前缀都不会被提升权限。
 */
export function assertOwner(actor) {
  if (isAuthorizedActor(actor)) {
    return OWNER_ACTOR;
  }
  throw new RoomStateError(
    'ACTOR_NOT_OWNER',
    'Only the room owner may change room state.',
    { actor, required: OWNER_ACTOR },
  );
}

function assertStateValue(state) {
  if (typeof state !== 'string' || !STATE_SET.has(state)) {
    throw new RoomStateError(
      'UNKNOWN_STATE',
      `Unknown room state: ${String(state)}`,
      { state, known: ROOM_STATES },
    );
  }
}

function assertSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new RoomStateError('INVALID_SNAPSHOT', 'Room snapshot must be a plain object.', {
      snapshotType: typeof snapshot,
    });
  }
  if (snapshot.schemaVersion !== undefined && snapshot.schemaVersion !== ROOM_STATE_SCHEMA_VERSION) {
    throw new RoomStateError(
      'UNSUPPORTED_SNAPSHOT_VERSION',
      `Unsupported room snapshot schema version: ${String(snapshot.schemaVersion)}`,
      { schemaVersion: snapshot.schemaVersion, supported: ROOM_STATE_SCHEMA_VERSION },
    );
  }
  if (typeof snapshot.roomId !== 'string' || snapshot.roomId.length === 0) {
    throw new RoomStateError('INVALID_ROOM_ID', 'Room snapshot requires a non-empty roomId.', {
      roomId: snapshot.roomId,
    });
  }
  assertStateValue(snapshot.state);
  if (!Number.isSafeInteger(snapshot.lastRoomSeq) || snapshot.lastRoomSeq < 0) {
    throw new RoomStateError('INVALID_ROOM_SEQ', 'Room snapshot requires lastRoomSeq as a safe integer >= 0.', {
      lastRoomSeq: snapshot.lastRoomSeq,
    });
  }
}

export function createRoomState({ roomId, state = 'draft', lastRoomSeq = 0, ...rest } = {}) {
  if (typeof roomId !== 'string' || roomId.length === 0) {
    throw new RoomStateError('INVALID_ROOM_ID', 'Room state requires a non-empty roomId.', { roomId });
  }
  assertStateValue(state);
  if (!Number.isSafeInteger(lastRoomSeq) || lastRoomSeq < 0) {
    throw new RoomStateError('INVALID_ROOM_SEQ', 'lastRoomSeq must be a safe integer >= 0.', { lastRoomSeq });
  }
  return {
    ...rest,
    schemaVersion: ROOM_STATE_SCHEMA_VERSION,
    roomId,
    state,
    lastRoomSeq,
  };
}

/**
 * 纯能力判断：给定 from/to 与 actor 是否允许一步转换。
 * 未知状态或未知 actor 会抛错；已识别的非机主 actor 返回 false（不报错）。
 * 该函数只是查询，真正的强制点在 transition/assertOwner。
 */
export function canTransition(from, to, options = {}) {
  const { actor = OWNER_ACTOR } = options ?? {};
  assertStateValue(from);
  assertStateValue(to);
  const pair = `${from}->${to}`;
  if (actor === SCHEDULER_ACTOR) {
    return pair === 'active->review' || pair === 'paused->review';
  }
  if (!isAuthorizedActor(actor)) {
    return false;
  }
  return LEGAL_PAIRS.has(pair);
}

function unchangedResult(snapshot) {
  return {
    snapshot,
    state: snapshot.state,
    changed: false,
    event: null,
    events: [],
  };
}

function applyChange(snapshot, {
  from,
  to,
  action,
  actor,
  reason,
  occurredAt,
}) {
  const payload = { from, to, action };
  if (reason !== undefined) {
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new RoomStateError('INVALID_REASON', 'reason must be a non-empty string.', { reason });
    }
    payload.reason = reason;
  }

  const events = [
    createRoomEvent({
      type: ROOM_EVENT_TYPES.ROOM_STATE_CHANGED,
      roomId: snapshot.roomId,
      roomSeq: snapshot.lastRoomSeq + 1,
      actor,
      payload,
      occurredAt,
    }),
  ];

  if (action === ACTIONS.CONFIRM) {
    events.push(createRoomEvent({
      type: ROOM_EVENT_TYPES.RESULT_CONFIRMED,
      roomId: snapshot.roomId,
      roomSeq: snapshot.lastRoomSeq + 2,
      actor,
      payload: { from, to },
      occurredAt,
    }));
  }

  const lastRoomSeq = events[events.length - 1].roomSeq;
  return {
    snapshot: { ...snapshot, state: to, lastRoomSeq },
    state: to,
    changed: true,
    event: events[0],
    events,
  };
}

/**
 * 纯状态转换。snapshot 是唯一事实来源，包含 roomId/state/lastRoomSeq。
 * 合法操作返回新 snapshot 与 1~2 个事件（confirm 额外产生 ResultConfirmed），
 * roomSeq 在 snapshot.lastRoomSeq 基础上严格 +1，不回退。
 * 重复 confirm/archive/halt 是幂等 no-op：返回原 snapshot、changed:false、无事件。
 * 其他非法转换抛 RoomStateError('INVALID_TRANSITION')。
 */
export function transition(snapshot, action, options = {}) {
  assertSnapshot(snapshot);
  if (typeof action !== 'string' || !Object.hasOwn(ACTION_DEFINITIONS, action)) {
    throw new RoomStateError(
      'UNKNOWN_ACTION',
      `Unknown room action: ${String(action)}`,
      { action, known: Object.keys(ACTION_DEFINITIONS) },
    );
  }

  const { actor, reason, occurredAt } = options ?? {};
  const resolvedActor = resolveTransitionActor(actor, action);

  const definition = ACTION_DEFINITIONS[action];
  const from = snapshot.state;

  if (!definition.from.includes(from)) {
    if (IDEMPOTENT_ACTIONS.has(action) && from === definition.to) {
      return unchangedResult(snapshot);
    }
    throw new RoomStateError(
      'INVALID_TRANSITION',
      `Cannot apply action ${action} from state ${from}.`,
      { from, action, to: definition.to },
    );
  }

  return applyChange(snapshot, {
    from,
    to: definition.to,
    action,
    actor: resolvedActor,
    reason,
    occurredAt,
  });
}

/**
 * 启动恢复：输入持久化 snapshot。active 一律降为 paused（并发 RoomStateChanged，
 * actor='system:restart'），其余状态原样保留，尤其 halted 不会自动恢复。
 * 返回值恒带 autoResumed:false，明确表示重启不自动续聊。
 * 恢复只做这一条固定归一化，不能代替任何机主管理转换。
 */
export function restore(snapshot, options = {}) {
  assertSnapshot(snapshot);
  const { reason = 'restart-no-autoresume', occurredAt } = options ?? {};

  if (snapshot.state !== 'active') {
    return { ...unchangedResult(snapshot), autoResumed: false };
  }

  const result = applyChange(snapshot, {
    from: 'active',
    to: 'paused',
    action: RESTORE_ACTION,
    actor: RESTORE_ACTOR,
    reason,
    occurredAt,
  });
  return { ...result, autoResumed: false };
}
