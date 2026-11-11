import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import { createRoomEngine } from '../../core/engine.mjs';
import { HALT_FILENAME, createHaltGuard } from '../../core/halt.mjs';
import { SCHEDULER_ACTOR, createRoomState } from '../../core/room-state.mjs';
import { createSchedule } from '../../core/scheduler.mjs';

// ── 内存 store：与 createRoomStore(roomDir) 同形，但不写真实文件 ──────────────

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createMemoryStore(seed = {}) {
  const state = {
    room: seed.room ? clone(seed.room) : null,
    schedule: seed.schedule ? clone(seed.schedule) : null,
    events: [],
    messages: [],
    attempts: [],
    checkpoints: [],
    markdown: seed.markdown ?? '# room\n',
  };

  return {
    state,
    async load() {
      if (!state.room) return null;
      return {
        room: clone(state.room),
        schedule: state.schedule ? clone(state.schedule) : null,
        transcript: state.messages.map(clone),
        attempts: state.attempts.map(clone),
      };
    },
    async appendEvent(event) {
      state.events.push(clone(event));
    },
    async appendMessage(message) {
      state.messages.push(clone(message));
    },
    async appendAttempt(attempt) {
      state.attempts.push(clone(attempt));
    },
    async saveCheckpoint(checkpoint) {
      state.checkpoints.push(clone(checkpoint));
      state.room = clone(checkpoint.room);
      state.schedule = checkpoint.schedule === null ? null : clone(checkpoint.schedule);
    },
    async exportMarkdown() {
      return state.markdown;
    },
  };
}

async function createGuardedHarness(t, {
  roomId = 'r_halt',
  seats = ['alpha'],
  maxAttempts = 1,
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-room-halt-'));
  const store = createMemoryStore();
  const bridges = makeBridges(seats);
  const haltGuard = createHaltGuard({ stateDir: dir });
  const engine = createRoomEngine({
    roomId,
    bridges,
    store,
    maxAttempts,
    haltGuard,
  });
  t.after(async () => {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  await engine.init();
  return { engine, bridges, store, haltGuard, dir, roomId };
}

function sentinelPath(dir, roomId) {
  return path.join(dir, `${HALT_FILENAME}.${roomId}`);
}

function makeBridges(seatIds, config = {}) {
  return new Map(seatIds.map((seatId) => [seatId, new FakeBridge({
    seatId,
    nativeSessionRef: `native_${seatId}`,
    ...config,
  })]));
}

function collectEvents(engine) {
  const events = [];
  const off = engine.on('event', (event) => events.push(event));
  return { events, off };
}

/** 订阅 TurnRequested，并在下一个宏任务里驱动 Bridge（此时 send 已完成）。 */
function driveTurns(engine, steps) {
  const pending = [];
  const errors = [];
  const off = engine.on('TurnRequested', (event) => {
    const step = steps.shift();
    if (typeof step !== 'function') {
      errors.push(new Error(`unexpected TurnRequested for ${event.payload.seatId}`));
      return;
    }
    pending.push(new Promise((resolve) => {
      setImmediate(async () => {
        try {
          await step(event);
        } catch (error) {
          errors.push(error);
        }
        resolve();
      });
    }));
  });
  return {
    off,
    async done() {
      off();
      await Promise.all(pending);
      if (errors.length > 0) throw errors[0];
    },
  };
}

async function waitFor(predicate, message, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${message}`);
}

function eventTypes(events) {
  return events.map((event) => event.type);
}

function assertContiguousSeqs(events) {
  const seqs = events.map((event) => event.roomSeq);
  assert.deepEqual(seqs, seqs.map((_, index) => seqs[0] + index));
}

// ── 测试 ──────────────────────────────────────────────────────────────────────

test('init creates a draft, connects every bridge and starts the pump before any send', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['a', 'b']);
  const engine = createRoomEngine({ roomId: 'r_init', bridges, store });
  t.after(() => engine.close());

  await engine.init();
  const snapshot = engine.getSnapshot();

  assert.equal(snapshot.roomId, 'r_init');
  assert.equal(snapshot.room.state, 'draft');
  assert.equal(snapshot.schedule, null);
  assert.equal(snapshot.closed, false);
  assert.equal(snapshot.halt, undefined);
  assert.equal(store.state.events.length, 1);
  assert.equal(store.state.events[0].type, 'RoomCreated');
  assert.equal(store.state.events[0].roomSeq, 1);
  assert.equal(store.state.events[0].actor, 'system:init');
  assert.ok(store.state.checkpoints.length >= 1);

  for (const bridge of bridges.values()) {
    const inspected = bridge.inspect();
    assert.equal(inspected.connected, true);
    assert.equal(inspected.subscriberCount, 1);
    assert.equal(inspected.activeAttemptId, null);
  }
});

test('postOwnerMessage rejects non-owner actors and records mentions, replyTo and nominations', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['a', 'b', 'c']);
  const engine = createRoomEngine({ roomId: 'r_owner', bridges, store });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();

  await assert.rejects(
    engine.postOwnerMessage({ text: '伪造机主', actor: 'seat:a' }),
    (error) => error.code === 'ACTOR_NOT_OWNER',
  );
  await assert.rejects(
    engine.postOwnerMessage({ text: '伪造机主', actor: 'admin' }),
    (error) => error.code === 'UNKNOWN_ACTOR',
  );

  const message = await engine.postOwnerMessage({
    text: '请 c 先回答，然后 a、b',
    mentions: ['c'],
    replyTo: 'a',
    nominations: ['b'],
  });

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.schedule.mode, 'casual');
  assert.deepEqual(snapshot.schedule.seats.map((seat) => seat.seatId), ['a', 'b', 'c']);
  assert.deepEqual(
    snapshot.schedule.ownerPriority.map((entry) => entry.seatId),
    ['c', 'a', 'b'],
  );
  assert.equal(snapshot.transcript.length, 1);
  assert.deepEqual(snapshot.transcript[0], message);
  assert.deepEqual(message.mentions, ['c']);
  assert.equal(message.replyTo, 'a');
  assert.deepEqual(message.nominations, ['b']);

  const posted = store.state.events.find((event) => event.type === 'MessagePosted');
  assert.equal(posted.payload.messageId, message.messageId);
  assert.equal(posted.payload.text, message.text);
  assert.equal(posted.actor, 'owner');
});

test('three seats complete a casual round with contiguous roomSeq and checkpointed cursors', async (t) => {
  const seats = ['deepseek', 'kimi', 'glm'];
  const store = createMemoryStore();
  const bridges = makeBridges(seats);
  const engine = createRoomEngine({ roomId: 'r_round', bridges, store, maxAttempts: 3 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '大家聊聊今天的进展。' });

  const turns = [];
  const offTurn = engine.on('TurnRequested', (event) => turns.push(event.payload.seatId));
  const collected = collectEvents(engine);

  const driver = driveTurns(engine, ['回复一', '回复二', '回复三'].map((text) => (event) => {
    const receipt = bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text });
    assert.equal(receipt.delivered, true);
  }));

  const result = await engine.run();
  await driver.done();
  await collected.off();
  offTurn();

  assert.deepEqual(turns, seats);
  assert.equal(result.ran, true);
  assert.equal(result.turns.length, 3);
  assert.equal(result.attemptsUsed, 3);
  assert.equal(result.state, 'review');

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'review');
  assert.equal(snapshot.schedule.attemptsUsed, 3);
  assert.equal(snapshot.schedule.ended, true);
  assert.deepEqual(snapshot.schedule.stats, { completed: 3, pass: 0, failed: 0, aborted: 0 });
  assert.equal(snapshot.transcript.length, 4);
  assert.deepEqual(
    snapshot.transcript.map((message) => message.from),
    ['owner', 'member', 'member', 'member'],
  );

  const types = eventTypes(collected.events);
  assert.equal(types.filter((type) => type === 'MemberThinking').length, 3);
  assert.equal(types.filter((type) => type === 'MemberResponded').length, 3);
  // collectEvents 从机主消息之后开始，因此这里只统计三名成员的 MessagePosted。
  assert.equal(types.filter((type) => type === 'MessagePosted').length, 3);
  assert.equal(types.filter((type) => type === 'ReviewRequested').length, 1);
  assertContiguousSeqs(collected.events);

  const autoReview = collected.events.find(
    (event) => event.type === 'RoomStateChanged' && event.payload.action === 'request-review',
  );
  assert.equal(autoReview.actor, SCHEDULER_ACTOR);
  const reviewRequested = collected.events.find((event) => event.type === 'ReviewRequested');
  assert.equal(reviewRequested.actor, SCHEDULER_ACTOR);
  assert.equal(reviewRequested.payload.reason, 'casual-round-complete');

  const lastCheckpoint = store.state.checkpoints.at(-1);
  assert.equal(lastCheckpoint.cursors.roomSeq, lastCheckpoint.room.lastRoomSeq);
  assert.equal(lastCheckpoint.room.lastRoomSeq, snapshot.room.lastRoomSeq);
  assert.equal(lastCheckpoint.cursors.messageCount, 4);
  assert.ok(store.state.checkpoints.length >= store.state.events.length);
});

test('PASS emits MemberPassed only and never posts a member message', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_pass', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '有人想说吗？' });

  const collected = collectEvents(engine);
  const driver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '[PASS]' });
  }]);

  await engine.run();
  await driver.done();
  await collected.off();

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'review');
  assert.equal(snapshot.schedule.stats.pass, 1);
  assert.equal(snapshot.transcript.length, 1);
  assert.equal(snapshot.transcript[0].from, 'owner');

  const types = eventTypes(collected.events);
  assert.equal(types.filter((type) => type === 'MemberPassed').length, 1);
  assert.equal(types.filter((type) => type === 'MemberResponded').length, 0);
  assert.equal(types.filter((type) => type === 'MessagePosted').length, 0);
  assertContiguousSeqs(collected.events);
});

test('failed attempt writes attempts and MemberFailed but no subtitle text', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['glm']);
  const engine = createRoomEngine({ roomId: 'r_fail', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '试一下。' });

  const collected = collectEvents(engine);
  const driver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).failAttempt(event.payload.attemptId, {
      error: { code: 'BOOM', message: 'boom', retryable: false },
    });
  }]);

  await engine.run();
  await driver.done();
  await collected.off();

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'review');
  assert.equal(snapshot.schedule.stats.failed, 1);
  assert.equal(snapshot.transcript.length, 1);
  assert.equal(snapshot.attempts.at(-1).status, 'failed');
  assert.equal(snapshot.attempts.at(-1).error.code, 'BOOM');

  const types = eventTypes(collected.events);
  assert.equal(types.filter((type) => type === 'MemberFailed').length, 1);
  assert.equal(types.filter((type) => type === 'MemberResponded').length, 0);
  assert.equal(types.filter((type) => type === 'MessagePosted').length, 0);
  assertContiguousSeqs(collected.events);
});

test('aborted attempt keeps partial text out of subtitles and records only state', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_abort', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '能说完吗？' });

  const collected = collectEvents(engine);
  const driver = driveTurns(engine, [async (event) => {
    const bridge = bridges.get(event.payload.seatId);
    bridge.appendPartialText(event.payload.attemptId, '半句话');
    const receipt = await bridge.cancel(event.payload.attemptId);
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.settlement, 'confirmed');
  }]);

  await engine.run();
  await driver.done();
  await collected.off();

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'review');
  assert.equal(snapshot.schedule.stats.aborted, 1);
  assert.equal(snapshot.transcript.length, 1);
  const attempt = snapshot.attempts.at(-1);
  assert.equal(attempt.status, 'aborted');
  assert.equal(attempt.partialText, '半句话');

  const types = eventTypes(collected.events);
  assert.equal(types.filter((type) => type === 'MemberResponded').length, 0);
  assert.equal(types.filter((type) => type === 'MemberFailed').length, 0);
  assert.equal(types.filter((type) => type === 'MessagePosted').length, 0);
  assertContiguousSeqs(collected.events);
});

test('ForeignTurn is recorded without a room event and UsageReported merges the attempt', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['deepseek']);
  const engine = createRoomEngine({ roomId: 'r_foreign', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  const attemptIds = [];
  const collected = collectEvents(engine);
  const driver = driveTurns(engine, [
    (event) => {
      attemptIds.push(event.payload.attemptId);
      const bridge = bridges.get(event.payload.seatId);
      bridge.completeAttempt(event.payload.attemptId, {
        text: '第一段',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
      bridge.injectForeignTurn({ nativeTurnRef: 'native_foreign_1', reason: 'manual-ui-turn' });
      bridge._emit('UsageReported', event.payload.attemptId, {
        usage: { inputTokens: 2, outputTokens: 3 },
      });
    },
  ]);

  await engine.run();
  await driver.done();
  await collected.off();

  await waitFor(
    () => engine.getSnapshot().foreignTurns.length === 1,
    'foreign turn record',
  );
  await waitFor(
    () => engine.getSnapshot().attempts.find((attempt) => attempt.attemptId === attemptIds[0])?.usage?.inputTokens === 12,
    'usage merge',
  );

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.transcript.length, 2);
  assert.equal(snapshot.foreignTurns[0].nativeTurnRef, 'native_foreign_1');
  const merged = snapshot.attempts.find((attempt) => attempt.attemptId === attemptIds[0]);
  assert.deepEqual(merged.usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(eventTypes(collected.events).includes('ForeignTurn'), false);
  assertContiguousSeqs(collected.events);
});

test('pause does not cancel the in-flight attempt and resume never auto-runs', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['a', 'b']);
  const engine = createRoomEngine({ roomId: 'r_pause', bridges, store, maxAttempts: 2 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event.payload.seatId));

  const firstDriver = driveTurns(engine, [async (event) => {
    await engine.pause();
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '第一段' });
  }]);

  const first = await engine.run();
  await firstDriver.done();

  assert.deepEqual(turns, ['a']);
  assert.equal(first.state, 'paused');
  assert.equal(first.attemptsUsed, 1);
  assert.equal(engine.getSnapshot().room.state, 'paused');
  assert.equal(bridges.get('b').inspect().activeAttemptId, null);

  await engine.resume();
  assert.equal(engine.getSnapshot().room.state, 'active');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(turns, ['a'], 'resume must not start a new run by itself');

  const secondDriver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '第二段' });
  }]);
  const second = await engine.run();
  await secondDriver.done();

  assert.equal(second.state, 'review');
  assert.equal(second.attemptsUsed, 2);
  assert.equal(engine.getSnapshot().room.state, 'review');
});

test('an owner interjection only affects turns that have not started yet', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['a', 'b', 'c']);
  const engine = createRoomEngine({ roomId: 'r_interject', bridges, store, maxAttempts: 3 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event.payload.seatId));

  const driver = driveTurns(engine, [
    async (event) => {
      await engine.postOwnerMessage({ text: 'c 先来。', mentions: ['c'] });
      bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: 'a 先答' });
    },
    (event) => {
      assert.equal(event.payload.seatId, 'c');
      bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: 'c 回答' });
    },
    (event) => {
      bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: 'b 回答' });
    },
  ]);

  await engine.run();
  await driver.done();

  assert.deepEqual(turns, ['a', 'c', 'b']);
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.transcript.length, 5);
  assert.equal(snapshot.schedule.attemptsUsed, 3);
});

test('run is re-entrant safe and returns the same in-flight promise', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_reentry', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '一次就好。' });

  let turnCount = 0;
  engine.on('TurnRequested', () => {
    turnCount += 1;
  });
  const driver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '好的' });
  }]);

  const first = engine.run();
  const second = engine.run();
  assert.equal(first, second);

  await first;
  await driver.done();

  assert.equal(turnCount, 1);
  assert.equal(engine.getSnapshot().schedule.attemptsUsed, 1);
});

test('casual exhaustion enters review and confirm appends ResultConfirmed', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_review', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '收个尾。' });

  const collected = collectEvents(engine);
  const driver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '完成' });
  }]);

  await engine.run();
  await driver.done();

  assert.equal(engine.getSnapshot().room.state, 'review');
  const reviewRequested = collected.events.filter((event) => event.type === 'ReviewRequested');
  assert.equal(reviewRequested.length, 1);

  await assert.rejects(engine.confirm({ actor: 'seat:kimi' }), (error) => error.code === 'ACTOR_NOT_OWNER');
  const confirmed = await engine.confirm();

  assert.equal(confirmed.changed, true);
  assert.equal(confirmed.state, 'confirmed');
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'confirmed');
  assert.equal(eventTypes(collected.events).filter((type) => type === 'ResultConfirmed').length, 1);
  assertContiguousSeqs(collected.events);
  await collected.off();
});

test('manual requestReview remains an owner action while the scheduler cannot confirm', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_manual_review', bridges, store, maxAttempts: 3 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();

  const collected = collectEvents(engine);
  await engine.requestReview();

  assert.equal(engine.getSnapshot().room.state, 'review');
  const stateChanged = collected.events.find((event) => event.type === 'RoomStateChanged');
  const reviewRequested = collected.events.find((event) => event.type === 'ReviewRequested');
  assert.equal(stateChanged.actor, 'owner');
  assert.equal(reviewRequested.actor, 'owner');
  assertContiguousSeqs(collected.events);

  await assert.rejects(
    engine.confirm({ actor: SCHEDULER_ACTOR }),
    (error) => error.code === 'ACTOR_NOT_OWNER',
  );
  const confirmed = await engine.confirm();
  assert.equal(confirmed.state, 'confirmed');
  await collected.off();
});

test('transcript messages follow the planned schema and match their MessagePosted roomSeq', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_schema', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();

  const collected = collectEvents(engine);
  const ownerMessage = await engine.postOwnerMessage({ text: '请回答。' });

  const driver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '回答。' });
  }]);
  await engine.run();
  await driver.done();

  const snapshot = engine.getSnapshot();
  const [owner, member] = snapshot.transcript;
  const postedEvents = collected.events.filter((event) => event.type === 'MessagePosted');
  const ownerPosted = postedEvents.find((event) => event.payload.from === 'owner');
  const memberPosted = postedEvents.find((event) => event.payload.from === 'member');
  const turnRequested = collected.events.find((event) => event.type === 'TurnRequested');
  const packet = bridges.get('kimi')._attempts.get(member.attemptId).packet;

  assert.equal(owner.id, owner.messageId);
  assert.equal(owner.id, ownerMessage.id);
  assert.equal(owner.roomId, 'r_schema');
  assert.equal(owner.roomSeq, ownerPosted.roomSeq);
  assert.equal(ownerPosted.payload.roomSeq, owner.roomSeq);
  assert.equal(owner.turnId, null);
  assert.equal(owner.attemptId, null);
  assert.equal(owner.createdAt, owner.occurredAt);

  assert.equal(member.id, member.messageId);
  assert.equal(member.roomId, 'r_schema');
  assert.equal(member.roomSeq, memberPosted.roomSeq);
  assert.equal(memberPosted.payload.roomSeq, member.roomSeq);
  assert.equal(member.attemptId, turnRequested.payload.attemptId);
  assert.equal(member.turnId, `turn_${member.attemptId}`);
  assert.equal(member.turnId, packet.turnId);
  assert.equal(member.createdAt, member.occurredAt);

  await collected.off();
});

test('restart restores active as paused and never resumes the conversation automatically', async (t) => {
  const store = createMemoryStore();
  const firstBridges = makeBridges(['a', 'b']);
  const firstEngine = createRoomEngine({ roomId: 'r_restart', bridges: firstBridges, store, maxAttempts: 4 });
  t.after(() => firstEngine.close());

  await firstEngine.init();
  await firstEngine.activate();
  await firstEngine.postOwnerMessage({ text: '重启前。' });
  const beforeRestart = store.state.events.length;
  assert.equal(store.state.room.state, 'active');
  await firstEngine.close();

  const secondBridges = makeBridges(['a', 'b']);
  const secondEngine = createRoomEngine({ roomId: 'r_restart', bridges: secondBridges, store, maxAttempts: 4 });
  t.after(() => secondEngine.close());

  await secondEngine.init();
  const snapshot = secondEngine.getSnapshot();

  assert.equal(snapshot.room.state, 'paused');
  assert.equal(snapshot.transcript.length, 1);
  assert.equal(snapshot.schedule.attemptsUsed, 0);
  assert.equal(secondBridges.get('a').inspect().activeAttemptId, null);

  const restoreEvent = store.state.events.at(-1);
  assert.equal(store.state.events.length, beforeRestart + 1);
  assert.equal(restoreEvent.type, 'RoomStateChanged');
  assert.equal(restoreEvent.actor, 'system:restart');
  assert.deepEqual(
    { from: restoreEvent.payload.from, to: restoreEvent.payload.to },
    { from: 'active', to: 'paused' },
  );

  const result = await secondEngine.run();
  assert.equal(result.ran, false);
  assert.equal(result.reason, 'room-not-active');
  assert.equal(store.state.events.filter((event) => event.type === 'TurnRequested').length, 0);
});

test('close settles an in-flight run, ends iterators and closes bridges without deleting sessions', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_close', bridges, store, maxAttempts: 5 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  let turnEvent = null;
  engine.on('TurnRequested', (event) => {
    turnEvent = event;
  });

  const runPromise = engine.run();
  await waitFor(() => turnEvent !== null, 'TurnRequested');
  await waitFor(
    () => bridges.get('kimi').inspect().activeAttemptId === turnEvent.payload.attemptId,
    'native attempt to start',
  );

  await engine.close();
  const result = await Promise.race([
    runPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('run hung after close')), 1000)),
  ]);

  assert.equal(result.closed, true);
  assert.equal(result.turns.length, 1);
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.closed, true);
  assert.equal(snapshot.schedule.attemptsUsed, 1);
  assert.equal(snapshot.attempts.at(-1).status, 'aborted');

  const inspected = bridges.get('kimi').inspect();
  assert.equal(inspected.closed, true);
  assert.equal(inspected.connected, false);
  assert.equal(inspected.subscriberCount, 0);
  assert.equal(inspected.sessionRef, 'native_kimi');

  await engine.close();
});

test('speech events are forwarded but never block the text turn', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['deepseek'], { voiceMode: 'native' });
  const engine = createRoomEngine({ roomId: 'r_voice', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '说一句。' });

  const collected = collectEvents(engine);
  const driver = driveTurns(engine, [(event) => {
    const bridge = bridges.get(event.payload.seatId);
    bridge.injectSpeechStarted({ nativeMessageRef: 'voice_1' });
    bridge.completeAttempt(event.payload.attemptId, { text: '语音与文本互不阻塞' });
    bridge.injectSpeechFinished({});
  }]);

  await engine.run();
  await driver.done();

  await waitFor(
    () => eventTypes(collected.events).includes('SpeechFinished'),
    'SpeechFinished room event',
  );

  const types = eventTypes(collected.events);
  assert.equal(types.includes('SpeechStarted'), true);
  assert.equal(types.includes('SpeechFinished'), true);
  assert.equal(engine.getSnapshot().room.state, 'review');
  assert.equal(engine.getSnapshot().transcript.length, 2);
  assertContiguousSeqs(collected.events);
  await collected.off();
});

test('run stops immediately when no seat is eligible instead of spinning', async (t) => {
  const schedule = createSchedule({
    mode: 'casual',
    seats: [{ seatId: 'a', status: 'disabled' }],
    maxAttempts: 3,
  });
  const store = createMemoryStore({
    room: createRoomState({ roomId: 'r_idle' }),
    schedule,
  });
  const bridges = makeBridges(['a']);
  const engine = createRoomEngine({ roomId: 'r_idle', bridges, store });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();

  let turnCount = 0;
  engine.on('TurnRequested', () => {
    turnCount += 1;
  });

  const result = await engine.run();
  assert.equal(result.ran, true);
  assert.deepEqual(result.turns, []);
  assert.equal(turnCount, 0);
  assert.equal(result.attemptsUsed, 0);
  assert.equal(result.state, 'active');
  assert.equal(store.state.events.filter((event) => event.type === 'TurnRequested').length, 0);
});

test('continueRound resets a finished casual round and the next run starts a new one', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['kimi']);
  const engine = createRoomEngine({ roomId: 'r_continue', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '第一轮。' });

  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event.payload.seatId));

  const firstDriver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '第一轮回复' });
  }]);
  await engine.run();
  await firstDriver.done();

  const reviewed = engine.getSnapshot();
  assert.equal(reviewed.room.state, 'review');
  assert.equal(reviewed.schedule.attemptsUsed, 1);
  assert.equal(reviewed.schedule.ended, true);
  assert.equal(reviewed.transcript.length, 2);
  const attemptsBefore = reviewed.attempts.length;
  const roomSeqBefore = reviewed.room.lastRoomSeq;

  const continued = await engine.continueRound();
  assert.equal(continued.changed, true);
  assert.equal(continued.state, 'active');
  assert.equal(continued.schedule.mode, 'casual');
  assert.equal(continued.schedule.attemptsUsed, 0);
  assert.equal(continued.schedule.ended, false);
  assert.equal(continued.schedule.maxAttempts, 1);

  const resumed = engine.getSnapshot();
  assert.equal(resumed.room.state, 'active');
  assert.equal(resumed.room.lastRoomSeq, roomSeqBefore + 1);
  assert.equal(resumed.transcript.length, 2);
  assert.equal(resumed.attempts.length, attemptsBefore);
  assert.equal(resumed.schedule.attemptsUsed, 0);
  assert.equal(resumed.schedule.ended, false);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(turns, ['kimi'], 'continueRound must not run by itself');

  await assert.rejects(
    engine.continueRound({ actor: 'seat:kimi' }),
    (error) => error.code === 'ACTOR_NOT_OWNER',
  );
  await assert.rejects(
    engine.continueRound(),
    (error) => error.code === 'INVALID_TRANSITION',
  );

  const secondDriver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '第二轮回复' });
  }]);
  const secondRun = await engine.run();
  await secondDriver.done();

  assert.equal(secondRun.state, 'review');
  assert.equal(secondRun.attemptsUsed, 1);
  assert.deepEqual(turns, ['kimi', 'kimi']);
  const final = engine.getSnapshot();
  assert.equal(final.room.state, 'review');
  assert.equal(final.schedule.attemptsUsed, 1);
  assert.equal(final.schedule.ended, true);
  assert.equal(final.transcript.length, 3);
});

test('each member receives recent shared history instead of only the previous message', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['deepseek', 'kimi', 'glm']);
  const engine = createRoomEngine({ roomId: 'r_context', bridges, store, maxAttempts: 3 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '机主的原始话题' });

  const packets = [];
  const driver = driveTurns(engine, ['第一段回复', '第二段回复', '第三段回复'].map((text) => (event) => {
    const bridge = bridges.get(event.payload.seatId);
    packets.push(bridge._attempts.get(event.payload.attemptId).packet.text);
    bridge.completeAttempt(event.payload.attemptId, { text });
  }));

  await engine.run();
  await driver.done();

  assert.equal(packets.length, 3);
  assert.ok(packets[0].includes('【最近聊天记录】\n机主：机主的原始话题'));
  assert.ok(packets[1].includes('机主：机主的原始话题\ndeepseek：第一段回复'));
  assert.ok(packets[2].includes('deepseek：第一段回复\nkimi：第二段回复'));
  assert.ok(packets.every((packet) => packet.includes('不必承接最后一条')));
  assert.ok(packets.every((packet) => packet.includes('[PASS]')));
});

test('member mentions choose the next speaker and ignore email, self and unknown targets', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['deepseek', 'kimi', 'glm']);
  const engine = createRoomEngine({ roomId: 'r_mentions', bridges, store, maxAttempts: 2 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '自由接话。' });

  const turns = [];
  const driver = driveTurns(engine, [
    (event) => {
      turns.push(event.payload);
      bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, {
        text: 'test@kimi.com 只是邮箱；@Kimi 和 @glm 怎么看？@deepseek 不用自点名，@nobody 不存在。',
      });
    },
    (event) => {
      turns.push(event.payload);
      bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: 'Kimi 接话。' });
    },
  ]);

  await engine.run();
  await driver.done();

  assert.deepEqual(turns.map((turn) => turn.seatId), ['deepseek', 'kimi']);
  assert.equal(turns[1].reason, 'mention');
  const snapshot = engine.getSnapshot();
  assert.deepEqual(snapshot.transcript[1].mentions, ['kimi', 'glm']);
  const posted = store.state.events.find((event) => (
    event.type === 'MessagePosted' && event.payload.seatId === 'deepseek'
  ));
  assert.deepEqual(posted.payload.mentions, ['kimi', 'glm']);
});

test('a visible reply followed by every other seat passing ends the round without forced subtitles', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['deepseek', 'kimi', 'glm']);
  const engine = createRoomEngine({ roomId: 'r_passes', bridges, store, maxAttempts: 8 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '有话就说，没有就跳过。' });

  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event.payload.seatId));
  const driver = driveTurns(engine, ['只有 DeepSeek 想说', '[PASS]', '[PASS]'].map((text) => (event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text });
  }));

  const result = await engine.run();
  await driver.done();

  assert.deepEqual(turns, ['deepseek', 'kimi', 'glm']);
  assert.equal(result.state, 'review');
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.schedule.attemptsUsed, 3);
  assert.deepEqual(snapshot.schedule.passSeatIds, ['kimi', 'glm']);
  assert.deepEqual(snapshot.schedule.stats, { completed: 1, pass: 2, failed: 0, aborted: 0 });
  assert.deepEqual(snapshot.transcript.map((message) => message.text), [
    '有话就说，没有就跳过。',
    '只有 DeepSeek 想说',
  ]);
});

test('continueRound preserves unserved owner and member targets while resetting attempts', async (t) => {
  const store = createMemoryStore();
  const bridges = makeBridges(['a', 'b']);
  const engine = createRoomEngine({ roomId: 'r_pending_targets', bridges, store, maxAttempts: 1 });
  t.after(() => engine.close());

  await engine.init();
  await engine.activate();
  await engine.postOwnerMessage({ text: '第一轮。' });

  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event.payload));
  const firstDriver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: '@b 下轮继续。' });
  }]);
  await engine.run();
  await firstDriver.done();
  assert.deepEqual(engine.getSnapshot().schedule.directQueue.map((entry) => entry.seatId), ['b']);

  await engine.postOwnerMessage({ text: '第二轮仍请 b 先说。', mentions: ['b'] });
  const continued = await engine.continueRound();
  assert.equal(continued.schedule.attemptsUsed, 0);
  assert.deepEqual(continued.schedule.ownerPriority.map((entry) => entry.seatId), ['b']);
  assert.deepEqual(continued.schedule.directQueue.map((entry) => entry.seatId), ['b']);

  const secondDriver = driveTurns(engine, [(event) => {
    bridges.get(event.payload.seatId).completeAttempt(event.payload.attemptId, { text: 'b 接话。' });
  }]);
  await engine.run();
  await secondDriver.done();

  assert.deepEqual(turns.map((turn) => turn.seatId), ['a', 'b']);
  assert.equal(turns[1].reason, 'owner-mention');
});

// ── halt guard 集成 ───────────────────────────────────────────────────────────

test('halt cancels the in-flight turn, keeps a real receipt and stops dispatch', async (t) => {
  const { engine, haltGuard, store, dir, roomId } = await createGuardedHarness(t, {
    seats: ['alpha', 'beta'],
    maxAttempts: 3,
  });
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event.payload.seatId));
  const runPromise = engine.run();
  await waitFor(() => turns.length === 1, 'first turn');

  const before = engine.getSnapshot().halt;
  assert.equal(before.inFlight, 1);
  assert.equal(before.dispatchable, true);

  const receipt = await engine.halt({ reason: 'integration-stop' });
  const runResult = await runPromise;

  assert.equal(receipt.stopped, true);
  assert.equal(receipt.halted, true);
  assert.equal(receipt.sentinelWritten, true);
  assert.equal(receipt.aborted, 1);
  assert.equal(receipt.degraded, 0);
  assert.equal(receipt.pending, 0);
  assert.equal(receipt.fullySettled, true);
  assert.equal(receipt.roomState, 'halted');
  assert.equal(receipt.attempts.length, 1);
  assert.equal(receipt.attempts[0].status, 'aborted');
  assert.equal(receipt.attempts[0].settlement, 'confirmed');

  assert.equal(runResult.reason, 'halted');
  assert.equal(runResult.halted, true);
  assert.deepEqual(turns, ['alpha']);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'halted');
  assert.equal(snapshot.halt.halted, true);
  assert.equal(snapshot.halt.dispatchable, false);
  assert.equal(snapshot.halt.inFlight, 0);

  const types = store.state.events.map((event) => event.type);
  assert.ok(types.indexOf('HaltRequested') < types.indexOf('HaltSettled'));
  const haltedChanges = store.state.events.filter(
    (event) => event.type === 'RoomStateChanged' && event.payload.to === 'halted',
  );
  assert.equal(haltedChanges.length, 1);
  const haltEvents = store.state.events.filter((event) => (
    event.type === 'HaltRequested' || event.type === 'HaltSettled'
  ));
  assert.ok(haltEvents.every((event) => event.actor === 'owner'));
  assert.equal(existsSync(sentinelPath(dir, roomId)), true);
  assert.equal(haltGuard.check(roomId).dispatchable, false);
});

test('halt with a failed cancel reports degraded instead of a fake full stop', async (t) => {
  const { engine, bridges } = await createGuardedHarness(t);
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  let turn = null;
  engine.on('TurnRequested', (event) => {
    turn = event;
  });
  const runPromise = engine.run();
  await waitFor(() => turn !== null, 'turn');

  const bridge = bridges.get('alpha');
  const attemptId = turn.payload.attemptId;
  bridge.cancel = async () => ({
    attemptId,
    accepted: false,
    settlement: 'failed',
    error: { code: 'CANCEL_DENIED', message: 'denied', retryable: false },
  });

  const receipt = await engine.halt();
  assert.equal(receipt.sentinelWritten, true);
  assert.equal(receipt.halted, true);
  assert.equal(receipt.aborted, 0);
  assert.equal(receipt.degraded, 1);
  assert.equal(receipt.pending, 0);
  assert.equal(receipt.fullySettled, false);
  assert.equal(receipt.attempts[0].status, 'failed');
  assert.equal(receipt.attempts[0].errorCode, 'CANCEL_DENIED');
  assert.equal(engine.getSnapshot().room.state, 'halted');

  // 让仍卡在等待终态的 run 结束，验证 halt 结果不会被伪造成 completed。
  bridge.failAttempt(attemptId, {
    error: { code: 'AFTER_HALT', message: 'late failure', retryable: false },
  });
  const runResult = await runPromise;
  assert.equal(runResult.reason, 'halted');
});

test('halt with a pending cancel keeps pending and fullySettled false', async (t) => {
  const { engine, bridges } = await createGuardedHarness(t);
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  let turn = null;
  engine.on('TurnRequested', (event) => {
    turn = event;
  });
  const runPromise = engine.run();
  await waitFor(() => turn !== null, 'turn');

  const bridge = bridges.get('alpha');
  const attemptId = turn.payload.attemptId;
  bridge.cancel = async () => ({ attemptId, accepted: true, settlement: 'pending' });

  const receipt = await engine.halt();
  assert.equal(receipt.aborted, 0);
  assert.equal(receipt.degraded, 0);
  assert.equal(receipt.pending, 1);
  assert.equal(receipt.fullySettled, false);
  assert.equal(receipt.attempts[0].status, 'pending');
  assert.equal(receipt.halted, true);

  bridge.failAttempt(attemptId, {
    error: { code: 'AFTER_HALT', message: 'late failure', retryable: false },
  });
  const runResult = await runPromise;
  assert.equal(runResult.reason, 'halted');
});

test('repeated halt is idempotent and emits settled no-op state', async (t) => {
  const { engine, store } = await createGuardedHarness(t);
  await engine.activate();

  const first = await engine.halt();
  const second = await engine.halt();

  assert.equal(first.halted, true);
  assert.equal(second.halted, true);
  assert.equal(second.sentinelWritten, true);
  assert.equal(second.aborted, 0);
  assert.equal(second.fullySettled, true);
  assert.equal(second.roomChanged, false);
  assert.equal(engine.getSnapshot().room.state, 'halted');

  const stateChanges = store.state.events.filter(
    (event) => event.type === 'RoomStateChanged' && event.payload.to === 'halted',
  );
  assert.equal(stateChanges.length, 1);
  assert.equal(store.state.events.filter((event) => event.type === 'HaltRequested').length, 2);
  assert.equal(store.state.events.filter((event) => event.type === 'HaltSettled').length, 2);

  const runResult = await engine.run();
  assert.equal(runResult.ran, false);
  assert.equal(runResult.reason, 'halted');
});

test('pause lets the in-flight attempt finish, then stops before the next seat', async (t) => {
  const { engine, bridges } = await createGuardedHarness(t, {
    seats: ['alpha', 'beta'],
    maxAttempts: 3,
  });
  await engine.activate();
  await engine.postOwnerMessage({ text: '开始。' });

  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event));
  const runPromise = engine.run();
  await waitFor(() => turns.length === 1, 'first turn');

  await engine.pause();
  assert.equal(engine.getSnapshot().room.state, 'paused');
  assert.equal(engine.getSnapshot().halt.paused, true);
  assert.equal(engine.getSnapshot().halt.dispatchable, false);

  bridges.get('alpha').completeAttempt(turns[0].payload.attemptId, { text: '仍可完成' });
  const runResult = await runPromise;

  assert.equal(turns.length, 1);
  assert.equal(runResult.reason, 'paused');
  assert.equal(engine.getSnapshot().schedule.attemptsUsed, 1);
  assert.equal(engine.getSnapshot().transcript.length, 2);

  await engine.resume();
  assert.equal(engine.getSnapshot().room.state, 'active');
  assert.equal(engine.getSnapshot().halt.paused, false);
  assert.equal(engine.getSnapshot().halt.dispatchable, true);
});

test('resumeHalt goes halted -> paused without auto-run and a global halt still blocks', async (t) => {
  const { engine } = await createGuardedHarness(t);
  await engine.activate();
  const turns = [];
  engine.on('TurnRequested', (event) => turns.push(event.payload.seatId));

  await engine.halt();
  assert.equal(engine.getSnapshot().room.state, 'halted');

  const resumed = await engine.resumeHalt();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.halted, false);
  assert.equal(resumed.roomState, 'paused');
  assert.equal(resumed.roomChanged, true);
  assert.equal(engine.getSnapshot().room.state, 'paused');
  assert.equal(engine.getSnapshot().halt.halted, false);
  assert.equal(engine.getSnapshot().halt.dispatchable, true);

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(turns, [], 'resumeHalt must not run by itself');
  let runResult = await engine.run();
  assert.equal(runResult.ran, false);
  assert.equal(runResult.reason, 'room-not-active');

  await engine.halt({ scope: 'all' });
  assert.equal(engine.getSnapshot().halt.globalHalted, true);
  assert.equal(engine.getSnapshot().halt.halted, true);
  const roomOnly = await engine.resumeHalt({ scope: 'room' });
  assert.equal(roomOnly.globalHalted, true);
  assert.equal(roomOnly.resumed, false);
  assert.equal(engine.getSnapshot().room.state, 'paused');
  assert.equal(engine.getSnapshot().halt.dispatchable, false);

  runResult = await engine.run();
  assert.equal(runResult.reason, 'halted');

  const globalResume = await engine.resumeHalt({ scope: 'all' });
  assert.equal(globalResume.resumed, true);
  assert.equal(engine.getSnapshot().halt.dispatchable, true);
  assert.equal(engine.getSnapshot().room.state, 'paused');
});

test('an external sentinel blocks beginTurn without emitting TurnRequested', async (t) => {
  const { engine, store, dir, roomId } = await createGuardedHarness(t);
  await engine.activate();
  await writeFile(sentinelPath(dir, roomId), '{"type":"Halt"}\n', 'utf8');

  const result = await engine.run();

  assert.equal(result.ran, false);
  assert.equal(result.reason, 'halted');
  assert.equal(result.state, 'active');
  assert.equal(store.state.events.filter((event) => event.type === 'TurnRequested').length, 0);
  assert.equal(engine.getSnapshot().halt.halted, true);
  assert.equal(engine.getSnapshot().halt.dispatchable, false);
  assert.equal(engine.getSnapshot().room.state, 'active');
});

test('close calls guard.close but preserves the halt sentinel', async (t) => {
  const { engine, dir, roomId } = await createGuardedHarness(t);
  await engine.activate();
  await engine.halt();
  const sentinel = sentinelPath(dir, roomId);
  assert.equal(existsSync(sentinel), true);

  await engine.close();
  assert.equal(existsSync(sentinel), true);
  assert.equal(engine.getSnapshot().closed, true);
  assert.equal(engine.getSnapshot().room.state, 'halted');
  await engine.close();
});
