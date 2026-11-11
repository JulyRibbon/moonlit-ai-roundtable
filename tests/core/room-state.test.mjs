import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoomEvent } from '../../core/events.mjs';
import {
  ACTIONS,
  OWNER_ACTOR,
  RESTORE_ACTOR,
  SCHEDULER_ACTOR,
  ROOM_STATES,
  RoomStateError,
  assertOwner,
  canTransition,
  createRoomState,
  restore,
  transition,
} from '../../core/room-state.mjs';

const ROOM_ID = 'r_main';
const FIXED_TIME = '2026-11-09T00:00:00.000Z';

function snapshotIn(state, overrides = {}) {
  return createRoomState({ roomId: ROOM_ID, state, lastRoomSeq: 0, ...overrides });
}

function ownerTransition(snapshot, action, options = {}) {
  return transition(snapshot, action, { actor: OWNER_ACTOR, occurredAt: FIXED_TIME, ...options });
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof RoomStateError, `expected RoomStateError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

const CHANGED_PATHS = [
  ['draft', ACTIONS.ACTIVATE, 'active'],
  ['active', ACTIONS.PAUSE, 'paused'],
  ['paused', ACTIONS.RESUME, 'active'],
  ['active', ACTIONS.REQUEST_REVIEW, 'review'],
  ['paused', ACTIONS.REQUEST_REVIEW, 'review'],
  ['review', ACTIONS.CONTINUE, 'active'],
  ['review', ACTIONS.CONFIRM, 'confirmed'],
  ['confirmed', ACTIONS.ARCHIVE, 'archived'],
  ['halted', ACTIONS.UNHALT, 'paused'],
];

const ILLEGAL_PATHS = [
  ['draft', ACTIONS.PAUSE],
  ['draft', ACTIONS.RESUME],
  ['draft', ACTIONS.REQUEST_REVIEW],
  ['draft', ACTIONS.CONTINUE],
  ['draft', ACTIONS.CONFIRM],
  ['draft', ACTIONS.ARCHIVE],
  ['active', ACTIONS.ACTIVATE],
  ['active', ACTIONS.RESUME],
  ['active', ACTIONS.CONTINUE],
  ['active', ACTIONS.CONFIRM],
  ['active', ACTIONS.ARCHIVE],
  ['active', ACTIONS.UNHALT],
  ['paused', ACTIONS.ACTIVATE],
  ['paused', ACTIONS.PAUSE],
  ['paused', ACTIONS.CONTINUE],
  ['paused', ACTIONS.CONFIRM],
  ['paused', ACTIONS.ARCHIVE],
  ['paused', ACTIONS.UNHALT],
  ['review', ACTIONS.ACTIVATE],
  ['review', ACTIONS.PAUSE],
  ['review', ACTIONS.RESUME],
  ['review', ACTIONS.ARCHIVE],
  ['review', ACTIONS.UNHALT],
  ['confirmed', ACTIONS.ACTIVATE],
  ['confirmed', ACTIONS.PAUSE],
  ['confirmed', ACTIONS.RESUME],
  ['confirmed', ACTIONS.REQUEST_REVIEW],
  ['confirmed', ACTIONS.CONTINUE],
  ['confirmed', ACTIONS.UNHALT],
  ['archived', ACTIONS.ACTIVATE],
  ['archived', ACTIONS.PAUSE],
  ['archived', ACTIONS.RESUME],
  ['archived', ACTIONS.REQUEST_REVIEW],
  ['archived', ACTIONS.CONTINUE],
  ['archived', ACTIONS.CONFIRM],
  ['archived', ACTIONS.HALT],
  ['archived', ACTIONS.UNHALT],
  ['halted', ACTIONS.ACTIVATE],
  ['halted', ACTIONS.PAUSE],
  ['halted', ACTIONS.RESUME],
  ['halted', ACTIONS.REQUEST_REVIEW],
  ['halted', ACTIONS.CONTINUE],
  ['halted', ACTIONS.CONFIRM],
  ['halted', ACTIONS.ARCHIVE],
];

test('exposes exactly the seven room states and does not mutate createRoomState extras', () => {
  assert.deepEqual(ROOM_STATES, ['draft', 'active', 'paused', 'review', 'confirmed', 'archived', 'halted']);

  const state = createRoomState({
    roomId: ROOM_ID,
    metadata: { title: '闲聊' },
    lastRoomSeq: 7,
  });
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.roomId, ROOM_ID);
  assert.equal(state.state, 'draft');
  assert.equal(state.lastRoomSeq, 7);
  assert.deepEqual(state.metadata, { title: '闲聊' });
});

test('createRoomState rejects unknown state, empty roomId and invalid seq with codes', () => {
  expectCode(() => createRoomState({ roomId: '' }), 'INVALID_ROOM_ID');
  expectCode(() => createRoomState({}), 'INVALID_ROOM_ID');
  expectCode(() => createRoomState({ roomId: ROOM_ID, state: 'live' }), 'UNKNOWN_STATE');
  expectCode(() => createRoomState({ roomId: ROOM_ID, lastRoomSeq: -1 }), 'INVALID_ROOM_SEQ');
  expectCode(() => createRoomState({ roomId: ROOM_ID, lastRoomSeq: 1.5 }), 'INVALID_ROOM_SEQ');
  expectCode(() => createRoomState({ roomId: ROOM_ID, lastRoomSeq: '1' }), 'INVALID_ROOM_SEQ');
});

test('every declared legal path changes state and emits one RoomStateChanged', () => {
  for (const [from, action, to] of CHANGED_PATHS) {
    const input = snapshotIn(from);
    const before = structuredClone(input);
    const result = ownerTransition(input, action);

    assert.equal(result.changed, true, `${from} --${action}--> ${to}`);
    assert.equal(result.state, to);
    assert.equal(result.snapshot.state, to);
    assert.equal(result.snapshot.lastRoomSeq, action === ACTIONS.CONFIRM ? 2 : 1);
    assert.notEqual(result.snapshot, input);
    assert.deepEqual(input, before, 'input snapshot must not be mutated');

    const types = result.events.map((event) => event.type);
    if (action === ACTIONS.CONFIRM) {
      assert.deepEqual(types, ['RoomStateChanged', 'ResultConfirmed']);
      assert.equal(result.events[1].roomSeq, 2);
      assert.equal(result.snapshot.lastRoomSeq, 2);
    } else {
      assert.deepEqual(types, ['RoomStateChanged']);
    }
    assert.equal(result.event, result.events[0]);
  }
});

test('every illegal action/state pair is rejected with INVALID_TRANSITION and leaves state untouched', () => {
  for (const [from, action] of ILLEGAL_PATHS) {
    const input = snapshotIn(from);
    const before = structuredClone(input);
    expectCode(() => ownerTransition(input, action), 'INVALID_TRANSITION');
    assert.deepEqual(input, before, `${from} + ${action} must not mutate`);
  }
});

test('draft -> active and active <-> paused paths work as designed', () => {
  let room = snapshotIn('draft');
  room = ownerTransition(room, ACTIONS.ACTIVATE).snapshot;
  assert.equal(room.state, 'active');

  room = ownerTransition(room, ACTIONS.PAUSE).snapshot;
  assert.equal(room.state, 'paused');

  room = ownerTransition(room, ACTIONS.RESUME).snapshot;
  assert.equal(room.state, 'active');
});

test('review can return to active when the owner keeps chatting', () => {
  const review = snapshotIn('review', { lastRoomSeq: 4 });
  const result = ownerTransition(review, ACTIONS.CONTINUE);

  assert.equal(result.state, 'active');
  assert.equal(result.events.length, 1);
  assert.equal(result.event.payload.action, ACTIONS.CONTINUE);
  assert.equal(result.snapshot.lastRoomSeq, 5);
});

test('halt reaches halted from every non-terminal state and never jumps to active', () => {
  for (const from of ['draft', 'active', 'paused', 'review', 'confirmed']) {
    const result = ownerTransition(snapshotIn(from), ACTIONS.HALT);
    assert.equal(result.state, 'halted');
    assert.equal(result.events[0].payload.from, from);
    assert.equal(result.events[0].payload.to, 'halted');
  }

  expectCode(() => ownerTransition(snapshotIn('halted'), ACTIONS.ACTIVATE), 'INVALID_TRANSITION');
  expectCode(() => ownerTransition(snapshotIn('halted'), ACTIONS.RESUME), 'INVALID_TRANSITION');
});

test('halted only recovers to paused, then requires an explicit resume', () => {
  const halted = ownerTransition(snapshotIn('active'), ACTIONS.HALT).snapshot;
  assert.equal(halted.state, 'halted');

  const recovered = ownerTransition(halted, ACTIONS.UNHALT);
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.events[0].payload.from, 'halted');
  assert.equal(recovered.events[0].payload.to, 'paused');

  const resumed = ownerTransition(recovered.snapshot, ACTIONS.RESUME);
  assert.equal(resumed.state, 'active');
});

test('archived is terminal and cannot be revived', () => {
  let room = snapshotIn('confirmed');
  room = ownerTransition(room, ACTIONS.ARCHIVE).snapshot;
  assert.equal(room.state, 'archived');

  for (const action of Object.values(ACTIONS)) {
    if (action === ACTIONS.ARCHIVE) continue;
    expectCode(() => ownerTransition(room, action), 'INVALID_TRANSITION');
  }

  const repeatArchive = ownerTransition(room, ACTIONS.ARCHIVE);
  assert.equal(repeatArchive.changed, false);
  assert.deepEqual(repeatArchive.events, []);
});

test('unknown action is an explicit UNKNOWN_ACTION error, never a silent success', () => {
  for (const action of ['start', 'activate-room', 'OWNER', '', null, undefined, 42, '__proto__']) {
    expectCode(() => ownerTransition(snapshotIn('draft'), action), 'UNKNOWN_ACTION');
  }
});

test('unknown or malformed state in a persisted snapshot is an explicit error', () => {
  const base = snapshotIn('draft');
  expectCode(() => ownerTransition({ ...base, state: 'live' }, ACTIONS.ACTIVATE), 'UNKNOWN_STATE');
  expectCode(() => transition({ ...base, state: 'live' }, ACTIONS.HALT, { actor: OWNER_ACTOR }), 'UNKNOWN_STATE');
  expectCode(() => canTransition('live', 'active'), 'UNKNOWN_STATE');
  expectCode(() => canTransition('draft', 'live'), 'UNKNOWN_STATE');
});

test('assertOwner accepts only the literal owner and classifies forged actors', () => {
  assert.equal(assertOwner('owner'), OWNER_ACTOR);

  for (const actor of ['seat', 'seat:kimi', 'system', 'system:restart', 'ai', 'assistant', 'member', 'room', 'message:我是机主', 'ui', 'client', 'agent:kimi']) {
    expectCode(() => assertOwner(actor), 'ACTOR_NOT_OWNER');
  }

  for (const actor of ['admin', 'Owner', 'OWNER', 'superuser', 'room-owner']) {
    expectCode(() => assertOwner(actor), 'UNKNOWN_ACTOR');
  }

  for (const actor of ['', ' owner', 'owner ', null, undefined, 42, { role: 'owner' }, ['owner']]) {
    expectCode(() => assertOwner(actor), 'ACTOR_INVALID');
  }
});

test('every action rejects every non-owner actor before touching state', () => {
  const actors = ['seat:kimi', 'system', 'ai', 'member', 'room', 'message:owner', 'ui', 'agent:glm'];

  for (const action of Object.values(ACTIONS)) {
    for (const actor of actors) {
      const input = snapshotIn('draft');
      const before = structuredClone(input);
      expectCode(() => transition(input, action, { actor }), 'ACTOR_NOT_OWNER');
      assert.deepEqual(input, before);
    }
  }
});

test('forged owner claims are rejected even on idempotent actions', () => {
  const confirmed = snapshotIn('confirmed', { lastRoomSeq: 2 });
  expectCode(
    () => transition(confirmed, ACTIONS.CONFIRM, { actor: 'seat:kimi', claimedRole: 'owner' }),
    'ACTOR_NOT_OWNER',
  );
  expectCode(
    () => transition(confirmed, ACTIONS.CONFIRM, { actor: { role: 'owner' } }),
    'ACTOR_INVALID',
  );
  expectCode(
    () => transition(confirmed, ACTIONS.CONFIRM, {}),
    'ACTOR_INVALID',
  );
});

test('canTransition reports legal pairs, denies non-owners, and throws on unknown input', () => {
  const legal = [
    ['draft', 'active'],
    ['active', 'paused'],
    ['paused', 'active'],
    ['active', 'review'],
    ['paused', 'review'],
    ['review', 'active'],
    ['review', 'confirmed'],
    ['confirmed', 'archived'],
    ['draft', 'halted'],
    ['active', 'halted'],
    ['paused', 'halted'],
    ['review', 'halted'],
    ['confirmed', 'halted'],
    ['halted', 'paused'],
    ['confirmed', 'confirmed'],
    ['archived', 'archived'],
    ['halted', 'halted'],
  ];
  for (const [from, to] of legal) {
    assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
    assert.equal(canTransition(from, to, { actor: OWNER_ACTOR }), true);
  }

  const illegal = [
    ['draft', 'paused'],
    ['draft', 'review'],
    ['draft', 'confirmed'],
    ['draft', 'archived'],
    ['draft', 'draft'],
    ['active', 'active'],
    ['active', 'confirmed'],
    ['active', 'archived'],
    ['paused', 'confirmed'],
    ['review', 'archived'],
    ['review', 'review'],
    ['confirmed', 'active'],
    ['confirmed', 'review'],
    ['archived', 'active'],
    ['archived', 'halted'],
    ['halted', 'active'],
    ['halted', 'confirmed'],
    ['halted', 'archived'],
  ];
  for (const [from, to] of illegal) {
    assert.equal(canTransition(from, to), false, `${from} -> ${to}`);
  }

  assert.equal(canTransition('draft', 'active', { actor: 'seat:kimi' }), false);
  assert.equal(canTransition('review', 'confirmed', { actor: 'system' }), false);
  expectCode(() => canTransition('draft', 'active', { actor: 'admin' }), 'UNKNOWN_ACTOR');
  expectCode(() => canTransition('draft', 'active', { actor: 42 }), 'ACTOR_INVALID');
});

test('RoomStateChanged event shape matches core/events.mjs and carries owner actor', () => {
  const result = ownerTransition(snapshotIn('draft'), ACTIONS.ACTIVATE);
  const event = result.event;

  assert.equal(event.schemaVersion, 1);
  assert.match(event.eventId, /^re_/);
  assert.equal(event.type, 'RoomStateChanged');
  assert.equal(event.roomId, ROOM_ID);
  assert.equal(event.roomSeq, 1);
  assert.equal(event.actor, 'owner');
  assert.equal(event.occurredAt, FIXED_TIME);
  assert.deepEqual(event.payload, { from: 'draft', to: 'active', action: 'activate' });

  assert.doesNotThrow(() => createRoomEvent({
    type: event.type,
    roomId: event.roomId,
    roomSeq: event.roomSeq,
    actor: event.actor,
    payload: event.payload,
  }));
});

test('confirm emits RoomStateChanged then ResultConfirmed with contiguous roomSeq', () => {
  const review = snapshotIn('review', { lastRoomSeq: 10 });
  const result = ownerTransition(review, ACTIONS.CONFIRM, { reason: 'owner-approved' });

  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map((event) => event.type), ['RoomStateChanged', 'ResultConfirmed']);
  assert.deepEqual(result.events.map((event) => event.roomSeq), [11, 12]);
  assert.equal(result.snapshot.lastRoomSeq, 12);

  const [stateEvent, confirmedEvent] = result.events;
  assert.deepEqual(stateEvent.payload, {
    from: 'review',
    to: 'confirmed',
    action: 'confirm',
    reason: 'owner-approved',
  });
  assert.deepEqual(confirmedEvent.payload, { from: 'review', to: 'confirmed' });
  for (const event of result.events) {
    assert.equal(event.roomId, ROOM_ID);
    assert.equal(event.actor, 'owner');
    assert.equal(event.occurredAt, FIXED_TIME);
    assert.match(event.eventId, /^re_/);
    assert.doesNotThrow(() => createRoomEvent({
      type: event.type,
      roomId: event.roomId,
      roomSeq: event.roomSeq,
      actor: event.actor,
      payload: event.payload,
    }));
  }
});

test('ResultConfirmed appears only on the owner review -> confirmed transition', () => {
  for (const [from, action] of CHANGED_PATHS) {
    if (action === ACTIONS.CONFIRM) continue;
    const result = ownerTransition(snapshotIn(from), action);
    assert.equal(
      result.events.some((event) => event.type === 'ResultConfirmed'),
      false,
      `${from} + ${action} must not confirm a result`,
    );
  }

  const repeat = ownerTransition(snapshotIn('confirmed'), ACTIONS.CONFIRM);
  assert.equal(repeat.changed, false);
  assert.deepEqual(repeat.events, []);
});

test('roomSeq is strictly increasing and never regresses across a full session', () => {
  let room = snapshotIn('draft');
  const seqs = [];

  room = ownerTransition(room, ACTIONS.ACTIVATE).snapshot;
  seqs.push(room.lastRoomSeq);
  room = ownerTransition(room, ACTIONS.PAUSE).snapshot;
  seqs.push(room.lastRoomSeq);
  room = ownerTransition(room, ACTIONS.RESUME).snapshot;
  seqs.push(room.lastRoomSeq);
  room = ownerTransition(room, ACTIONS.REQUEST_REVIEW).snapshot;
  seqs.push(room.lastRoomSeq);

  const confirmed = ownerTransition(room, ACTIONS.CONFIRM);
  seqs.push(...confirmed.events.map((event) => event.roomSeq));
  room = confirmed.snapshot;

  const archived = ownerTransition(room, ACTIONS.ARCHIVE);
  seqs.push(...archived.events.map((event) => event.roomSeq));
  room = archived.snapshot;

  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(room.lastRoomSeq, 7);
});

test('repeated confirm, archive and halt are idempotent no-ops with no new events', () => {
  const confirmed = snapshotIn('confirmed', { lastRoomSeq: 2 });
  const againConfirm = ownerTransition(confirmed, ACTIONS.CONFIRM);
  assert.equal(againConfirm.changed, false);
  assert.equal(againConfirm.snapshot, confirmed);
  assert.equal(againConfirm.snapshot.lastRoomSeq, 2);
  assert.equal(againConfirm.event, null);
  assert.deepEqual(againConfirm.events, []);

  const archived = snapshotIn('archived', { lastRoomSeq: 5 });
  const againArchive = ownerTransition(archived, ACTIONS.ARCHIVE);
  assert.equal(againArchive.changed, false);
  assert.equal(againArchive.snapshot, archived);
  assert.deepEqual(againArchive.events, []);

  const halted = snapshotIn('halted', { lastRoomSeq: 9 });
  const againHalt = ownerTransition(halted, ACTIONS.HALT);
  assert.equal(againHalt.changed, false);
  assert.equal(againHalt.snapshot, halted);
  assert.deepEqual(againHalt.events, []);

  expectCode(() => ownerTransition(archived, ACTIONS.CONFIRM), 'INVALID_TRANSITION');
  expectCode(() => ownerTransition(snapshotIn('review'), ACTIONS.ARCHIVE), 'INVALID_TRANSITION');
  expectCode(() => ownerTransition(snapshotIn('paused'), ACTIONS.PAUSE), 'INVALID_TRANSITION');
});

test('system:scheduler may only request review and the event keeps that actor', () => {
  for (const from of ['active', 'paused']) {
    const result = transition(snapshotIn(from), ACTIONS.REQUEST_REVIEW, {
      actor: SCHEDULER_ACTOR,
      occurredAt: FIXED_TIME,
    });
    assert.equal(result.changed, true, `${from} + scheduler request-review`);
    assert.equal(result.state, 'review');
    assert.equal(result.event.actor, SCHEDULER_ACTOR);
    assert.equal(result.event.payload.action, ACTIONS.REQUEST_REVIEW);
    assert.equal(result.event.payload.from, from);
    assert.equal(result.event.payload.to, 'review');
  }

  for (const action of Object.values(ACTIONS)) {
    if (action === ACTIONS.REQUEST_REVIEW) continue;
    expectCode(
      () => transition(snapshotIn('active'), action, { actor: SCHEDULER_ACTOR }),
      'ACTOR_NOT_OWNER',
    );
  }

  // 已完成状态下 confirm 是幂等 no-op，但 scheduler 仍不得冒充机主。
  expectCode(
    () => transition(snapshotIn('confirmed'), ACTIONS.CONFIRM, { actor: SCHEDULER_ACTOR }),
    'ACTOR_NOT_OWNER',
  );

  for (const actor of ['system', 'system:restart', 'system:other', 'seat:kimi']) {
    expectCode(
      () => transition(snapshotIn('active'), ACTIONS.REQUEST_REVIEW, { actor }),
      'ACTOR_NOT_OWNER',
    );
  }

  // assertOwner 本身仍不向 scheduler 放权。
  expectCode(() => assertOwner(SCHEDULER_ACTOR), 'ACTOR_NOT_OWNER');
});

test('canTransition lets system:scheduler request review only', () => {
  assert.equal(canTransition('active', 'review', { actor: SCHEDULER_ACTOR }), true);
  assert.equal(canTransition('paused', 'review', { actor: SCHEDULER_ACTOR }), true);

  for (const [from, to] of [
    ['draft', 'active'],
    ['active', 'paused'],
    ['paused', 'active'],
    ['review', 'active'],
    ['review', 'confirmed'],
    ['confirmed', 'archived'],
    ['active', 'halted'],
    ['halted', 'paused'],
  ]) {
    assert.equal(canTransition(from, to, { actor: SCHEDULER_ACTOR }), false, `${from}->${to}`);
  }
});

test('owner manual request-review still carries actor owner', () => {
  const result = ownerTransition(snapshotIn('active'), ACTIONS.REQUEST_REVIEW);
  assert.equal(result.changed, true);
  assert.equal(result.event.actor, OWNER_ACTOR);
  assert.equal(result.event.payload.action, ACTIONS.REQUEST_REVIEW);
});

test('restore matrix: active becomes paused, every other state is preserved', () => {
  let restored = restore(snapshotIn('active'));
  assert.equal(restored.changed, true);
  assert.equal(restored.state, 'paused');
  assert.equal(restored.snapshot.state, 'paused');
  assert.equal(restored.autoResumed, false);
  assert.equal(restored.events.length, 1);
  assert.equal(restored.event.type, 'RoomStateChanged');
  assert.equal(restored.event.actor, RESTORE_ACTOR);
  assert.equal(restored.event.payload.from, 'active');
  assert.equal(restored.event.payload.to, 'paused');
  assert.equal(restored.event.payload.action, 'restore-pause');
  assert.equal(restored.event.payload.reason, 'restart-no-autoresume');
  assert.equal(restored.snapshot.lastRoomSeq, 1);

  for (const state of ['draft', 'paused', 'review', 'confirmed', 'archived', 'halted']) {
    const input = snapshotIn(state, { lastRoomSeq: 4 });
    const result = restore(input);
    assert.equal(result.changed, false, `${state} must not change on restore`);
    assert.equal(result.state, state);
    assert.equal(result.snapshot, input);
    assert.equal(result.snapshot.lastRoomSeq, 4);
    assert.equal(result.event, null);
    assert.deepEqual(result.events, []);
    assert.equal(result.autoResumed, false);
  }
});

test('restore never auto-resumes chat: halted stays halted and review needs the owner', () => {
  const halted = restore(snapshotIn('halted', { lastRoomSeq: 3 }));
  assert.equal(halted.state, 'halted');
  assert.equal(halted.autoResumed, false);

  const review = restore(snapshotIn('review'));
  assert.equal(review.state, 'review');

  const twice = restore(restore(snapshotIn('active')).snapshot);
  assert.equal(twice.state, 'paused');
  assert.equal(twice.changed, false);
  assert.equal(twice.autoResumed, false);
});

test('restore preserves extra fields and rejects invalid persisted snapshots', () => {
  const input = createRoomState({
    roomId: ROOM_ID,
    state: 'active',
    lastRoomSeq: 2,
    cursor: { seat: 'kimi', turn: 8 },
  });
  const result = restore(input);
  assert.deepEqual(result.snapshot.cursor, { seat: 'kimi', turn: 8 });
  assert.equal(result.snapshot.lastRoomSeq, 3);

  expectCode(() => restore(null), 'INVALID_SNAPSHOT');
  expectCode(() => restore([]), 'INVALID_SNAPSHOT');
  expectCode(() => restore({ state: 'active', lastRoomSeq: 0 }), 'INVALID_ROOM_ID');
  expectCode(() => restore({ roomId: ROOM_ID, state: 'active', lastRoomSeq: -2 }), 'INVALID_ROOM_SEQ');
  expectCode(() => restore({ roomId: ROOM_ID, state: 'active', lastRoomSeq: 1.2 }), 'INVALID_ROOM_SEQ');
  expectCode(
    () => restore({ roomId: ROOM_ID, state: 'active', lastRoomSeq: 0, schemaVersion: 2 }),
    'UNSUPPORTED_SNAPSHOT_VERSION',
  );
});

test('transition validates snapshot shape with explicit codes', () => {
  const base = snapshotIn('draft');
  expectCode(() => ownerTransition(null, ACTIONS.ACTIVATE), 'INVALID_SNAPSHOT');
  expectCode(() => ownerTransition([], ACTIONS.ACTIVATE), 'INVALID_SNAPSHOT');
  expectCode(() => ownerTransition({ ...base, roomId: '' }, ACTIONS.ACTIVATE), 'INVALID_ROOM_ID');
  expectCode(() => ownerTransition({ ...base, lastRoomSeq: -1 }, ACTIONS.ACTIVATE), 'INVALID_ROOM_SEQ');
  expectCode(() => ownerTransition({ ...base, lastRoomSeq: 2.5 }, ACTIONS.ACTIVATE), 'INVALID_ROOM_SEQ');
  expectCode(
    () => ownerTransition({ ...base, schemaVersion: 99 }, ACTIONS.ACTIVATE),
    'UNSUPPORTED_SNAPSHOT_VERSION',
  );
});

test('snapshots and events survive JSON round-trips and continue the sequence', () => {
  let room = snapshotIn('draft');
  room = ownerTransition(room, ACTIONS.ACTIVATE).snapshot;
  room = ownerTransition(room, ACTIONS.REQUEST_REVIEW).snapshot;

  const confirmed = ownerTransition(room, ACTIONS.CONFIRM);
  const persisted = JSON.parse(JSON.stringify(confirmed.snapshot));
  assert.deepEqual(persisted, confirmed.snapshot);

  const restored = restore(persisted);
  assert.deepEqual(JSON.parse(JSON.stringify(restored.snapshot)), persisted);

  const archived = ownerTransition(restored.snapshot, ACTIONS.ARCHIVE);
  assert.equal(archived.snapshot.state, 'archived');
  assert.equal(archived.event.roomSeq, confirmed.snapshot.lastRoomSeq + 1);

  for (const event of confirmed.events) {
    assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  }
});

test('transition errors expose code, message and details for callers', () => {
  try {
    ownerTransition(snapshotIn('draft'), ACTIONS.PAUSE);
    assert.fail('expected transition to throw');
  } catch (error) {
    assert.ok(error instanceof RoomStateError);
    assert.equal(error.code, 'INVALID_TRANSITION');
    assert.match(error.message, /pause/);
    assert.equal(error.details.from, 'draft');
    assert.equal(error.details.action, ACTIONS.PAUSE);
    assert.equal(error.details.to, 'paused');
  }
});
