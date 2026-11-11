import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SETTLE_TIMEOUT_MS,
  HaltGuardError,
  createHaltGuard,
} from '../../core/halt.mjs';

const OWNER = 'owner';

async function makeStateDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-halt-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function makeGuard(t, stateDir, options = {}) {
  const guard = createHaltGuard({ stateDir, ...options });
  t.after(() => guard.close());
  return guard;
}

function sentinelPath(stateDir, roomId) {
  return roomId === undefined
    ? path.join(stateDir, 'HALT')
    : path.join(stateDir, `HALT.${roomId}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof HaltGuardError, `expected HaltGuardError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function expectRejectsCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof HaltGuardError, `expected HaltGuardError, got ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('room halt writes only that room sentinel and cancels only that room attempt', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  const signalA = guard.signal('r_a');
  const signalB = guard.signal('r_b');
  let cancelledA = 0;
  let cancelledB = 0;

  guard.registerAttempt({
    roomId: 'r_a',
    attemptId: 'a1',
    seatId: 's1',
    cancel: () => {
      cancelledA += 1;
      return { settlement: 'confirmed' };
    },
  });
  guard.registerAttempt({
    roomId: 'r_b',
    attemptId: 'b1',
    seatId: 's2',
    cancel: () => {
      cancelledB += 1;
      return { settlement: 'confirmed' };
    },
  });

  const receipt = await guard.request({
    scope: 'room',
    roomId: 'r_a',
    mode: 'halt',
    actor: 'system:test',
  });

  assert.equal(receipt.stopped, true);
  assert.equal(receipt.halted, true);
  assert.equal(receipt.scope, 'room');
  assert.equal(receipt.mode, 'halt');
  assert.equal(receipt.aborted, 1);
  assert.equal(receipt.degraded, 0);
  assert.equal(receipt.pending, 0);
  assert.equal(receipt.fullySettled, true);
  assert.ok(existsSync(sentinelPath(stateDir, 'r_a')));
  assert.ok(!existsSync(sentinelPath(stateDir)));
  assert.equal(cancelledA, 1);
  assert.equal(cancelledB, 0);
  assert.equal(signalA.aborted, true);
  assert.equal(signalB.aborted, false);

  const roomA = guard.check('r_a');
  assert.equal(roomA.halted, true);
  assert.equal(roomA.roomHalted, true);
  assert.equal(roomA.globalHalted, false);
  assert.equal(roomA.dispatchable, false);

  const roomB = guard.check('r_b');
  assert.equal(roomB.halted, false);
  assert.equal(roomB.aborted, false);
  assert.equal(roomB.dispatchable, true);

  const globalReceipt = await guard.request({
    scope: 'all',
    mode: 'halt',
    actor: 'owner',
  });
  assert.equal(globalReceipt.stopped, true);
  assert.equal(globalReceipt.aborted, 1);
  assert.equal(globalReceipt.attempts[0].roomId, 'r_b');
  assert.ok(existsSync(sentinelPath(stateDir)));
  assert.equal(signalB.aborted, true);
  assert.equal(guard.check('r_b').globalHalted, true);
  assert.equal(guard.check('r_b').halted, true);
});

test('pause marks dispatch paused without sentinel or abort; halt still works later', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  const signal = guard.signal('r_pause');

  const receipt = await guard.request({
    scope: 'room',
    roomId: 'r_pause',
    mode: 'pause',
    actor: 'system:test',
  });

  assert.equal(receipt.stopped, true);
  assert.equal(receipt.halted, false);
  assert.equal(receipt.mode, 'pause');
  assert.equal(receipt.aborted, 0);
  assert.equal(receipt.attempts.length, 0);
  assert.ok(!existsSync(sentinelPath(stateDir)));
  assert.ok(!existsSync(sentinelPath(stateDir, 'r_pause')));
  assert.equal(signal.aborted, false);

  const paused = guard.check('r_pause');
  assert.equal(paused.paused, true);
  assert.equal(paused.halted, false);
  assert.equal(paused.dispatchable, false);
  assert.equal(paused.mode, 'pause');

  const halted = await guard.request({
    scope: 'room',
    roomId: 'r_pause',
    mode: 'halt',
    actor: 'owner',
  });
  assert.equal(halted.stopped, true);
  assert.equal(signal.aborted, true);
  assert.ok(existsSync(sentinelPath(stateDir, 'r_pause')));
  assert.equal(guard.check('r_pause').mode, 'halt');

  const allPaused = await guard.request({
    scope: 'all',
    mode: 'pause',
    actor: 'system:test',
  });
  assert.equal(allPaused.stopped, true);
  assert.equal(guard.check('r_other').paused, true);
});

test('external sentinel is observed at the next check and requires explicit resume', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  const signal = guard.signal('r_ext');
  assert.equal(signal.aborted, false);

  await writeFile(sentinelPath(stateDir, 'r_ext'), 'manual stop\n', 'utf8');
  const halted = guard.check('r_ext');
  assert.equal(halted.halted, true);
  assert.equal(halted.roomHalted, true);
  assert.equal(halted.aborted, true);
  assert.equal(halted.dispatchable, false);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.code, 'HALT');
  assert.equal(signal.reason.source, 'sentinel');

  await unlink(sentinelPath(stateDir, 'r_ext'));
  const unlinked = guard.check('r_ext');
  assert.equal(unlinked.halted, false);
  assert.equal(unlinked.aborted, true);
  assert.equal(unlinked.dispatchable, false);

  const resumed = await guard.resume({ roomId: 'r_ext', actor: OWNER });
  assert.equal(resumed.cleared, false);
  assert.equal(resumed.resumed, true);
  assert.equal(guard.check('r_ext').dispatchable, true);
  assert.equal(guard.signal('r_ext').aborted, false);

  await writeFile(sentinelPath(stateDir), 'manual global stop\n', 'utf8');
  const global = guard.check('r_global_ext');
  assert.equal(global.globalHalted, true);
  assert.equal(global.dispatchable, false);
  assert.equal(guard.signal('r_global_ext').aborted, true);
});

test('repeated halt requests are idempotent and do not recancel settled attempts', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  let calls = 0;
  const unregister = guard.registerAttempt({
    roomId: 'r_idem',
    attemptId: 'already-done',
    seatId: 's1',
    cancel: () => {
      calls += 1;
      return { settlement: 'confirmed' };
    },
  });

  const first = await guard.request({
    scope: 'room',
    roomId: 'r_idem',
    mode: 'halt',
    actor: 'owner',
  });
  assert.equal(first.aborted, 1);
  assert.equal(first.fullySettled, true);
  assert.equal(calls, 1);
  const firstSentinel = await readFile(sentinelPath(stateDir, 'r_idem'), 'utf8');

  const second = await guard.request({
    scope: 'room',
    roomId: 'r_idem',
    mode: 'halt',
    actor: 'owner',
  });
  assert.equal(second.stopped, true);
  assert.equal(second.halted, true);
  assert.equal(second.aborted, 0);
  assert.equal(second.degraded, 0);
  assert.equal(second.pending, 0);
  assert.equal(second.fullySettled, true);
  assert.equal(second.attempts.length, 0);
  assert.equal(calls, 1);
  assert.equal(
    await readFile(sentinelPath(stateDir, 'r_idem'), 'utf8'),
    firstSentinel,
  );
  assert.equal(guard.snapshot('r_idem').inFlight, 0);

  assert.equal(unregister(), true);
  assert.equal(unregister(), false);
});

test('unregister removes an attempt before halt so it is never cancelled', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  let calls = 0;
  const unregister = guard.registerAttempt({
    roomId: 'r_unreg',
    attemptId: 'a1',
    seatId: 's1',
    cancel: () => {
      calls += 1;
      return { settlement: 'confirmed' };
    },
  });

  unregister();
  const receipt = await guard.request({
    scope: 'room',
    roomId: 'r_unreg',
    mode: 'halt',
    actor: 'owner',
  });
  assert.equal(calls, 0);
  assert.equal(receipt.attempts.length, 0);
  assert.equal(guard.snapshot('r_unreg').inFlight, 0);
});

test('cancel receives signal and ids, runs in parallel, and isolates seat failures', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir, { settleTimeoutMs: 500 });
  const seen = [];
  let active = 0;
  let maxActive = 0;

  guard.registerAttempt({
    roomId: 'r_parallel',
    attemptId: 'a_ok',
    seatId: 's_ok',
    cancel: async (input) => {
      seen.push(input);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active -= 1;
      return { settlement: 'confirmed' };
    },
  });
  guard.registerAttempt({
    roomId: 'r_parallel',
    attemptId: 'a_async_fail',
    seatId: 's_async_fail',
    cancel: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(30);
      active -= 1;
      throw Object.assign(new Error('seat bridge down'), { code: 'SEAT_DOWN' });
    },
  });
  guard.registerAttempt({
    roomId: 'r_parallel',
    attemptId: 'a_sync_fail',
    seatId: 's_sync_fail',
    cancel: () => {
      throw Object.assign(new Error('sync failure'), { code: 'SYNC_DOWN' });
    },
  });
  guard.registerAttempt({
    roomId: 'r_parallel',
    attemptId: 'a_sync_ok',
    seatId: 's_sync_ok',
    cancel: () => true,
  });

  const receipt = await guard.request({
    scope: 'room',
    roomId: 'r_parallel',
    mode: 'halt',
    actor: 'owner',
  });

  assert.ok(maxActive >= 2, `expected parallel cancels, saw max concurrency ${maxActive}`);
  assert.equal(receipt.stopped, true);
  assert.equal(receipt.aborted, 2);
  assert.equal(receipt.degraded, 2);
  assert.equal(receipt.pending, 0);
  assert.equal(receipt.fullySettled, false);
  assert.equal(receipt.attempts.length, 4);

  const byId = Object.fromEntries(receipt.attempts.map((attempt) => [attempt.attemptId, attempt]));
  assert.equal(byId.a_ok.status, 'aborted');
  assert.equal(byId.a_ok.settlement, 'confirmed');
  assert.equal(byId.a_sync_ok.status, 'aborted');
  assert.equal(byId.a_sync_ok.settlement, 'confirmed');
  assert.equal(byId.a_async_fail.status, 'failed');
  assert.equal(byId.a_async_fail.errorCode, 'SEAT_DOWN');
  assert.equal(byId.a_sync_fail.status, 'failed');
  assert.equal(byId.a_sync_fail.errorCode, 'SYNC_DOWN');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].attemptId, 'a_ok');
  assert.equal(seen[0].seatId, 's_ok');
  assert.equal(seen[0].roomId, 'r_parallel');
  assert.equal(seen[0].signal.aborted, true);
});

test('timeout is reported as pending and degraded, never as confirmed stop', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir, { settleTimeoutMs: 25 });
  let releaseLate;

  guard.registerAttempt({
    roomId: 'r_timeout',
    attemptId: 'a_never',
    seatId: 's1',
    cancel: () => new Promise((resolve) => {
      releaseLate = resolve;
    }),
  });

  const startedAt = Date.now();
  const receipt = await guard.request({
    scope: 'room',
    roomId: 'r_timeout',
    mode: 'halt',
    actor: 'owner',
  });
  assert.ok(Date.now() - startedAt >= 20);
  assert.equal(receipt.stopped, true);
  assert.equal(receipt.aborted, 0);
  assert.equal(receipt.pending, 1);
  assert.equal(receipt.degraded, 1);
  assert.equal(receipt.fullySettled, false);
  assert.equal(receipt.attempts[0].status, 'pending');
  assert.equal(receipt.attempts[0].settlement, 'timeout');
  assert.equal(receipt.attempts[0].errorCode, 'CANCEL_TIMEOUT');
  assert.equal(guard.snapshot('r_timeout').inFlight, 1);

  releaseLate({ settlement: 'confirmed' });
  await delay(5);
});

test('unknown or missing cancel settlement is never reported as confirmed', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  guard.registerAttempt({
    roomId: 'r_unknown',
    attemptId: 'a_unknown',
    seatId: 's1',
    cancel: () => ({ settlement: 'mystery' }),
  });
  guard.registerAttempt({
    roomId: 'r_unknown',
    attemptId: 'a_missing',
    seatId: 's2',
    cancel: async () => ({}),
  });

  const receipt = await guard.request({
    scope: 'room',
    roomId: 'r_unknown',
    mode: 'halt',
    actor: 'owner',
  });

  assert.equal(receipt.stopped, true);
  assert.equal(receipt.aborted, 0);
  assert.equal(receipt.pending, 2);
  assert.equal(receipt.degraded, 2);
  assert.equal(receipt.fullySettled, false);
  const byId = Object.fromEntries(receipt.attempts.map((attempt) => [attempt.attemptId, attempt]));
  assert.equal(byId.a_unknown.status, 'pending');
  assert.equal(byId.a_unknown.settlement, 'unsupported');
  assert.equal(byId.a_unknown.errorCode, 'UNKNOWN_SETTLEMENT');
  assert.equal(byId.a_missing.status, 'pending');
  assert.equal(byId.a_missing.errorCode, 'SETTLEMENT_MISSING');
});

test('resume requires owner and a room resume cannot override global halt', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  await guard.request({ scope: 'room', roomId: 'r_owner', mode: 'halt', actor: 'system:test' });

  await assert.rejects(
    guard.resume({ roomId: 'r_owner', actor: 'seat:s1' }),
    (error) => error.code === 'ACTOR_NOT_OWNER',
  );
  await assert.rejects(
    guard.resume({ roomId: 'r_owner', actor: 'stranger' }),
    (error) => error.code === 'UNKNOWN_ACTOR',
  );
  await assert.rejects(
    guard.resume({ roomId: 'r_owner', actor: ' owner' }),
    (error) => error.code === 'ACTOR_INVALID',
  );
  assert.ok(existsSync(sentinelPath(stateDir, 'r_owner')));

  await guard.request({ scope: 'all', mode: 'halt', actor: 'system:test' });
  const roomResume = await guard.resume({ roomId: 'r_owner', actor: OWNER });
  assert.equal(roomResume.cleared, true);
  assert.equal(roomResume.resumed, false);
  assert.equal(roomResume.halted, true);
  assert.equal(roomResume.globalHalted, true);
  assert.ok(!existsSync(sentinelPath(stateDir, 'r_owner')));
  assert.ok(existsSync(sentinelPath(stateDir)));
  assert.equal(guard.check('r_owner').halted, true);
  assert.equal(guard.check('r_owner').dispatchable, false);
});

test('resume all clears global halt but leaves room sentinels untouched', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  await guard.request({ scope: 'room', roomId: 'r_a', mode: 'halt', actor: 'system:test' });
  await guard.request({ scope: 'room', roomId: 'r_b', mode: 'halt', actor: 'system:test' });

  const sigC = guard.signal('r_c');
  await guard.request({ scope: 'all', mode: 'halt', actor: 'system:test' });
  assert.equal(sigC.aborted, true);

  const receipt = await guard.resume({ scope: 'all', actor: OWNER });
  assert.equal(receipt.cleared, true);
  assert.equal(receipt.resumed, true);
  assert.equal(receipt.halted, false);
  assert.deepEqual(receipt.haltedRooms.sort(), ['r_a', 'r_b']);
  assert.ok(!existsSync(sentinelPath(stateDir)));
  assert.ok(existsSync(sentinelPath(stateDir, 'r_a')));
  assert.ok(existsSync(sentinelPath(stateDir, 'r_b')));

  assert.equal(guard.check('r_c').halted, false);
  assert.equal(guard.check('r_c').dispatchable, true);
  assert.equal(guard.signal('r_c').aborted, false);
  assert.equal(guard.check('r_a').halted, true);
  assert.equal(guard.check('r_b').halted, true);

  const roomResume = await guard.resume({ roomId: 'r_a', actor: OWNER });
  assert.equal(roomResume.resumed, true);
  assert.equal(guard.check('r_a').dispatchable, true);
  assert.equal(guard.signal('r_a').aborted, false);
  assert.equal(guard.check('r_b').halted, true);

  const repeated = await guard.resume({ roomId: 'r_a', actor: OWNER });
  assert.equal(repeated.cleared, false);
  assert.equal(repeated.resumed, true);
});

test('close keeps sentinels and a fresh guard does not auto-resume halted rooms', async (t) => {
  const stateDir = await makeStateDir(t);
  const first = createHaltGuard({ stateDir });
  await first.request({ scope: 'room', roomId: 'r_restart', mode: 'halt', actor: 'owner' });
  await first.close();

  assert.ok(existsSync(sentinelPath(stateDir, 'r_restart')));
  assert.ok(!existsSync(sentinelPath(stateDir)));

  const second = makeGuard(t, stateDir);
  const status = second.check('r_restart');
  assert.equal(status.halted, true);
  assert.equal(status.dispatchable, false);
  assert.equal(second.signal('r_restart').aborted, true);

  await second.close();
  assert.ok(existsSync(sentinelPath(stateDir, 'r_restart')));
});

test('close does not cancel registered attempts and only clears memory', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = createHaltGuard({ stateDir });
  let calls = 0;
  guard.registerAttempt({
    roomId: 'r_close',
    attemptId: 'a1',
    seatId: 's1',
    cancel: () => {
      calls += 1;
      return { settlement: 'confirmed' };
    },
  });

  await guard.close();
  assert.equal(calls, 0);
  assert.equal(existsSync(sentinelPath(stateDir)), false);
});

test('audit appends request, degraded and resume records without secrets', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  guard.registerAttempt({
    roomId: 'r_audit',
    attemptId: 'a_ok',
    seatId: 's_ok',
    cancel: () => ({ settlement: 'confirmed' }),
  });
  guard.registerAttempt({
    roomId: 'r_audit',
    attemptId: 'a_bad',
    seatId: 's_bad',
    cancel: () => {
      throw Object.assign(new Error('bridge unavailable'), { code: 'BRIDGE_DOWN' });
    },
  });

  await guard.request({
    scope: 'room',
    roomId: 'r_audit',
    mode: 'halt',
    actor: 'system:watchdog',
    reason: 'SECRET_REASON_MUST_NOT_BE_LOGGED',
  });
  await guard.resume({ roomId: 'r_audit', actor: OWNER });

  const raw = await readFile(path.join(stateDir, 'audit.jsonl'), 'utf8');
  assert.ok(!raw.includes('SECRET_REASON_MUST_NOT_BE_LOGGED'));
  assert.ok(!raw.includes('bridge unavailable'));

  const records = raw.trim().split('\n').map((line) => JSON.parse(line));
  const requestRecord = records.find((record) => record.event === 'halt.request');
  const degradedRecord = records.find((record) => record.event === 'halt.degraded');
  const resumeRecord = records.find((record) => record.event === 'halt.resume');

  assert.ok(requestRecord);
  assert.equal(requestRecord.scope, 'room');
  assert.equal(requestRecord.mode, 'halt');
  assert.equal(requestRecord.stopped, true);
  assert.equal(requestRecord.aborted, 1);
  assert.equal(requestRecord.degraded, 1);
  assert.deepEqual(requestRecord.attemptIds.sort(), ['a_bad', 'a_ok']);
  assert.equal('reason' in requestRecord, false);

  assert.ok(degradedRecord);
  assert.equal(degradedRecord.attemptId, 'a_bad');
  assert.equal(degradedRecord.errorCode, 'BRIDGE_DOWN');

  assert.ok(resumeRecord);
  assert.equal(resumeRecord.actor, OWNER);
  assert.equal(resumeRecord.cleared, true);
});

test('audit write failure does not block halt or resume', async (t) => {
  const stateDir = await makeStateDir(t);
  const auditDir = path.join(stateDir, 'audit.jsonl');
  await mkdir(auditDir);
  const guard = makeGuard(t, stateDir, { auditFile: auditDir });

  const receipt = await guard.request({
    scope: 'room',
    roomId: 'r_audit_fail',
    mode: 'halt',
    actor: 'owner',
  });
  assert.equal(receipt.stopped, true);
  assert.ok(existsSync(sentinelPath(stateDir, 'r_audit_fail')));

  const resumed = await guard.resume({ roomId: 'r_audit_fail', actor: OWNER });
  assert.equal(resumed.resumed, true);
  assert.ok(!existsSync(sentinelPath(stateDir, 'r_audit_fail')));
});

test('roomId validation rejects traversal and invalid scopes/modes', async (t) => {
  const stateDir = await makeStateDir(t);
  const guard = makeGuard(t, stateDir);
  const parent = path.dirname(stateDir);
  const badIds = ['', '..', '../escape', 'a/b', 'a\\b', '.hidden', 'r.1', 'r 1', 'r'.repeat(65), null, 42];

  for (const badId of badIds) {
    expectCode(() => guard.check(badId), 'INVALID_ROOM_ID');
    expectCode(() => guard.signal(badId), 'INVALID_ROOM_ID');
    expectCode(() => guard.snapshot(badId), 'INVALID_ROOM_ID');
    expectCode(() => guard.registerAttempt({
      roomId: badId,
      attemptId: 'a1',
      seatId: 's1',
      cancel: () => {},
    }), 'INVALID_ROOM_ID');
  }

  await expectRejectsCode(guard.request({
    scope: 'room',
    roomId: '../escape',
    mode: 'halt',
    actor: 'owner',
  }), 'INVALID_ROOM_ID');
  await expectRejectsCode(guard.request({
    scope: 'room',
    roomId: 'r_ok',
    mode: 'explode',
    actor: 'owner',
  }), 'INVALID_MODE');
  await expectRejectsCode(guard.request({
    scope: 'galaxy',
    roomId: 'r_ok',
    mode: 'halt',
    actor: 'owner',
  }), 'INVALID_SCOPE');
  await expectRejectsCode(guard.request({
    scope: 'room',
    roomId: 'r_ok',
    mode: 'halt',
    actor: '',
  }), 'INVALID_ACTOR');
  await expectRejectsCode(guard.request({
    scope: 'room',
    roomId: 'r_ok',
    mode: 'halt',
    actor: 'owner',
    reason: '',
  }), 'INVALID_REASON');

  assert.ok(!existsSync(path.join(parent, 'HALT.escape')));
  assert.ok(!existsSync(path.join(parent, 'escape')));
});

test('default settle timeout and guard construction are validated', async (t) => {
  const stateDir = await makeStateDir(t);
  assert.equal(DEFAULT_SETTLE_TIMEOUT_MS, 5000);
  expectCode(() => createHaltGuard({}), 'INVALID_STATE_DIR');
  expectCode(() => createHaltGuard({ stateDir: '' }), 'INVALID_STATE_DIR');
  expectCode(() => createHaltGuard({ stateDir, settleTimeoutMs: -1 }), 'INVALID_TIMEOUT');
  expectCode(() => createHaltGuard({ stateDir, settleTimeoutMs: Number.NaN }), 'INVALID_TIMEOUT');
  expectCode(() => createHaltGuard({ stateDir, auditFile: 42 }), 'INVALID_AUDIT_FILE');

  const guard = makeGuard(t, stateDir);
  expectCode(() => guard.registerAttempt({
    roomId: 'r_ok',
    attemptId: 'a1',
    seatId: 's1',
  }), 'INVALID_CANCEL');
  expectCode(() => guard.registerAttempt({
    roomId: 'r_ok',
    attemptId: '',
    seatId: 's1',
    cancel: () => {},
  }), 'INVALID_ATTEMPT');

  const unregister = guard.registerAttempt({
    roomId: 'r_ok',
    attemptId: 'a1',
    seatId: 's1',
    cancel: () => {},
  });
  expectCode(() => guard.registerAttempt({
    roomId: 'r_ok',
    attemptId: 'a1',
    seatId: 's2',
    cancel: () => {},
  }), 'DUPLICATE_ATTEMPT');
  unregister();
});
