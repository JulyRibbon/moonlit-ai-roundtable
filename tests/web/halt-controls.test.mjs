import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyHaltReceipt,
  classifyResumeReceipt,
  createHaltRequestLock,
  createSingleFlightLock,
  haltBannerView,
  haltControlView,
  haltEventOverlay,
  performReviewContinue,
  reviewContinueView,
  runBlockedByHalt,
} from '../../web/app.mjs';

function haltReceipt(overrides = {}) {
  return {
    stopped: true,
    halted: true,
    paused: false,
    scope: 'room',
    mode: 'halt',
    at: '2026-11-09T10:00:00.000Z',
    roomId: 'room-demo',
    aborted: 0,
    degraded: 0,
    pending: 0,
    fullySettled: true,
    sentinelWritten: true,
    attempts: [],
    ...overrides,
  };
}

function guardedSnapshot(state = 'active', haltOverrides = {}) {
  return {
    room: { state },
    halt: {
      schemaVersion: 1,
      roomId: 'room-demo',
      halted: state === 'halted',
      paused: state === 'paused',
      globalHalted: false,
      roomHalted: state === 'halted',
      aborted: state === 'halted',
      dispatchable: state === 'active',
      mode: state === 'halted' ? 'halt' : null,
      attempts: [],
      inFlight: 0,
      ...haltOverrides,
    },
    lastHalt: null,
  };
}

test('clean halt receipt is ok and exposes all four counters', () => {
  const result = classifyHaltReceipt(haltReceipt({ aborted: 2, sentinelWritten: true }));
  assert.equal(result.level, 'ok');
  assert.equal(result.counts.aborted, 2);
  assert.equal(result.counts.degraded, 0);
  assert.equal(result.counts.pending, 0);
  assert.equal(result.counts.fullySettled, true);
  assert.match(result.headline, /全部已停/);
  for (const label of ['aborted', 'degraded', 'pending', 'fullySettled']) {
    assert.match(result.detail, new RegExp(label));
  }
});

test('degraded receipt is danger and never claims everything stopped', () => {
  const result = classifyHaltReceipt(haltReceipt({
    aborted: 0,
    degraded: 1,
    pending: 0,
    fullySettled: false,
  }));
  assert.equal(result.level, 'danger');
  assert.equal(result.tone, 'danger');
  assert.equal(result.counts.degraded, 1);
  assert.doesNotMatch(result.headline, /全部已停/);
  assert.doesNotMatch(result.headline, /已停/);
  assert.match(result.headline, /降级/);
});

test('pending receipt is danger and clearly states unfinished settlement', () => {
  const result = classifyHaltReceipt(haltReceipt({
    aborted: 1,
    degraded: 0,
    pending: 1,
    fullySettled: false,
  }));
  assert.equal(result.level, 'danger');
  assert.doesNotMatch(result.headline, /全部已停/);
  assert.match(result.headline, /未完全结算/);
  assert.equal(result.counts.pending, 1);
});

test('receipt without fullySettled still requires a danger level', () => {
  const result = classifyHaltReceipt(haltReceipt({
    aborted: 1,
    fullySettled: false,
  }));
  assert.equal(result.level, 'danger');
  assert.notEqual(result.headline, '全部已停');
});

test('sentinel write failure is danger even with zero attempts', () => {
  const result = classifyHaltReceipt(haltReceipt({
    stopped: false,
    fullySettled: false,
    sentinelWritten: false,
    sentinelErrorCode: 'EACCES',
  }));
  assert.equal(result.level, 'danger');
  assert.match(result.headline, /未落盘/);
});

test('resume receipt is not mistaken for a halt receipt', () => {
  assert.equal(classifyHaltReceipt({
    resumed: true,
    halted: false,
    cleared: true,
    fullySettled: true,
  }), null);
});

test('resume receipt reports paused-without-auto-run, unresolved resume is danger', () => {
  const ok = classifyResumeReceipt({ resumed: true, halted: false, cleared: true });
  assert.equal(ok.level, 'ok');
  assert.match(ok.headline, /解除停止/);
  assert.match(ok.detail, /paused/);
  assert.match(ok.detail, /不会自动运行/);

  const bad = classifyResumeReceipt({ resumed: false, halted: true, cleared: false });
  assert.equal(bad.level, 'danger');
  assert.match(bad.headline, /未完成/);
});

test('halt button is enabled as 全部停止 on an active guarded room', () => {
  const view = haltControlView({ snapshot: guardedSnapshot('active') });
  assert.equal(view.mode, 'halt');
  assert.equal(view.label, '全部停止');
  assert.equal(view.disabled, false);
  assert.equal(view.unavailable, false);
});

test('halted room offers 解除停止 and explains the paused result', () => {
  const view = haltControlView({ snapshot: guardedSnapshot('halted') });
  assert.equal(view.mode, 'resume');
  assert.equal(view.label, '解除停止');
  assert.equal(view.disabled, false);
  assert.match(view.reason, /paused/);
});

test('halt/resume requests disable the button while in flight', () => {
  const halt = haltControlView({ snapshot: guardedSnapshot('active'), busy: 'halt' });
  assert.equal(halt.disabled, true);
  assert.equal(halt.label, '停止中…');
  const resume = haltControlView({ snapshot: guardedSnapshot('halted'), busy: 'resume' });
  assert.equal(resume.disabled, true);
  assert.equal(resume.label, '恢复中…');
});

test('missing haltGuard yields an explicit unavailable state, not fake success', () => {
  const view = haltControlView({ snapshot: { room: { state: 'active' } } });
  assert.equal(view.disabled, true);
  assert.equal(view.unavailable, true);
  assert.match(view.reason, /haltGuard/);

  const banner = haltBannerView({
    snapshot: { room: { state: 'active' } },
    receipt: haltReceipt({ aborted: 3 }),
  });
  assert.equal(banner.tone, 'warn');
  assert.match(banner.headline, /停止不可用/);
  assert.match(banner.detail, /haltGuard/);
  assert.equal(banner.counts, null);
});

test('no snapshot yet and archived rooms keep the button disabled', () => {
  assert.equal(haltControlView({ snapshot: null }).disabled, true);
  const archived = haltControlView({ snapshot: guardedSnapshot('archived') });
  assert.equal(archived.disabled, true);
  assert.match(archived.reason, /归档/);
});

test('request lock prevents duplicate halt/resume clicks until released', () => {
  const lock = createHaltRequestLock();
  assert.equal(lock.pending, null);
  assert.equal(lock.begin('halt'), true);
  assert.equal(lock.begin('halt'), false);
  assert.equal(lock.begin('resume'), false);
  assert.equal(lock.pending, 'halt');
  assert.equal(lock.end('resume'), false);
  assert.equal(lock.pending, 'halt');
  assert.equal(lock.end('halt'), true);
  assert.equal(lock.pending, null);
  assert.equal(lock.begin('resume'), true);
  assert.equal(lock.end(), true);
});

test('halt immediately blocks run, including before the room state updates', () => {
  assert.equal(runBlockedByHalt({ roomState: 'active' }), false);
  assert.equal(runBlockedByHalt({ roomState: 'active', haltBusy: 'halt' }), true);
  assert.equal(runBlockedByHalt({ roomState: 'active', haltPending: true }), true);
  assert.equal(runBlockedByHalt({ roomState: 'active', haltInEffect: true }), true);
  assert.equal(runBlockedByHalt({ roomState: 'halted' }), true);
  assert.equal(runBlockedByHalt({ roomState: 'paused' }), true);
});

test('degraded and pending banners are red-level and suppress success wording', () => {
  const degraded = haltBannerView({ receipt: haltReceipt({ degraded: 1, fullySettled: false }) });
  assert.equal(degraded.tone, 'danger');
  assert.equal(degraded.counts.degraded, 1);
  assert.doesNotMatch(degraded.headline, /全部已停/);

  const pending = haltBannerView({ receipt: haltReceipt({ pending: 2, fullySettled: false }) });
  assert.equal(pending.tone, 'danger');
  assert.equal(pending.counts.pending, 2);
  assert.doesNotMatch(pending.headline, /全部已停/);
});

test('pending halt request shows a warning strip before the receipt arrives', () => {
  const view = haltBannerView({
    snapshot: guardedSnapshot('active'),
    pending: true,
  });
  assert.equal(view.tone, 'warn');
  assert.match(view.headline, /停止请求/);
  assert.equal(view.counts, null);
});

test('HaltSettled event folds into a receipt, HaltRequested marks pending', () => {
  const requested = haltEventOverlay({
    type: 'HaltRequested',
    occurredAt: '2026-11-09T10:00:00.000Z',
    payload: { stopped: true, sentinelWritten: true },
  });
  assert.equal(requested.pending, true);
  assert.equal(requested.receipt, null);

  const settled = haltEventOverlay({
    type: 'HaltSettled',
    occurredAt: '2026-11-09T10:00:01.000Z',
    payload: {
      scope: 'room',
      mode: 'halt',
      stopped: true,
      halted: true,
      aborted: 1,
      degraded: 1,
      pending: 0,
      fullySettled: false,
      sentinelWritten: true,
      attempts: [],
    },
  });
  assert.equal(settled.pending, false);
  assert.equal(settled.halted, true);
  assert.equal(settled.receipt.aborted, 1);
  assert.equal(settled.receipt.at, '2026-11-09T10:00:01.000Z');
  const banner = haltBannerView({ snapshot: guardedSnapshot('halted'), receipt: settled.receipt });
  assert.equal(banner.tone, 'danger');
  assert.doesNotMatch(banner.headline, /全部已停/);
});

test('snapshot lastHalt with a clean receipt renders an ok strip', () => {
  const snapshot = guardedSnapshot('halted');
  snapshot.lastHalt = haltReceipt({ aborted: 1 });
  const banner = haltBannerView({ snapshot, receipt: snapshot.lastHalt });
  assert.equal(banner.tone, 'ok');
  assert.equal(banner.counts.aborted, 1);
  assert.equal(banner.counts.fullySettled, true);
});

test('review shows an enabled 再聊一轮 button; other states hide it', () => {
  const review = reviewContinueView({ snapshot: guardedSnapshot('review') });
  assert.equal(review.visible, true);
  assert.equal(review.disabled, false);
  assert.equal(review.label, '再聊一轮');

  for (const state of ['active', 'paused', 'halted', 'draft', 'confirmed', 'archived']) {
    const view = reviewContinueView({ snapshot: guardedSnapshot(state) });
    assert.equal(view.visible, false, state);
  }
});

test('review button is locked during continue and run phases', () => {
  const inContinue = reviewContinueView({ snapshot: guardedSnapshot('review'), busy: 'continue' });
  assert.equal(inContinue.visible, true);
  assert.equal(inContinue.disabled, true);
  assert.equal(inContinue.label, '再聊中…');

  const inRun = reviewContinueView({ snapshot: guardedSnapshot('review'), busy: 'run' });
  assert.equal(inRun.visible, true);
  assert.equal(inRun.disabled, true);
  assert.equal(inRun.label, '开始闲聊中…');
});

test('continue success runs exactly once and strictly after continue', async () => {
  const calls = [];
  const lock = createSingleFlightLock();
  const result = await performReviewContinue({
    lock,
    postContinue: async () => { calls.push('continue'); return { state: 'active' }; },
    postRun: async () => { calls.push('run'); return { ran: true }; },
  });
  assert.deepEqual(calls, ['continue', 'run']);
  assert.equal(result.started, true);
  assert.equal(result.ran, true);
  assert.equal(result.phase, 'done');
  assert.equal(result.error, null);
  assert.equal(lock.pending, null);
});

test('continue failure never calls run and releases the lock', async () => {
  const calls = [];
  const lock = createSingleFlightLock();
  const result = await performReviewContinue({
    lock,
    postContinue: async () => {
      calls.push('continue');
      throw new Error('409 invalid transition');
    },
    postRun: async () => { calls.push('run'); return { ran: true }; },
  });
  assert.deepEqual(calls, ['continue']);
  assert.equal(result.started, true);
  assert.equal(result.ran, false);
  assert.equal(result.phase, 'continue');
  assert.match(result.error.message, /409/);
  assert.equal(lock.pending, null);
});

test('duplicate clicks share one continue-run flow', async () => {
  let releaseContinue;
  const gate = new Promise((resolve) => { releaseContinue = resolve; });
  let continueCalls = 0;
  let runCalls = 0;
  const lock = createSingleFlightLock();
  const options = {
    lock,
    postContinue: async () => {
      continueCalls += 1;
      await gate;
      return { state: 'active' };
    },
    postRun: async () => {
      runCalls += 1;
      return { ran: true };
    },
  };

  const first = performReviewContinue(options);
  const second = await performReviewContinue(options);
  assert.equal(second.started, false);
  assert.equal(second.locked, true);
  assert.equal(continueCalls, 1);
  assert.equal(runCalls, 0);
  assert.equal(lock.pending, 'continue-review');

  releaseContinue();
  const firstResult = await first;
  assert.equal(firstResult.started, true);
  assert.equal(continueCalls, 1);
  assert.equal(runCalls, 1);
  assert.equal(lock.pending, null);
});

test('run failure is reported as run phase after continue succeeded', async () => {
  const result = await performReviewContinue({
    lock: createSingleFlightLock(),
    postContinue: async () => ({ state: 'active' }),
    postRun: async () => { throw new Error('run failed'); },
  });
  assert.equal(result.phase, 'run');
  assert.equal(result.ran, true);
  assert.equal(result.continueResult, null);
  assert.match(result.error.message, /run failed/);
});

test('failed continue can be retried after the lock is released', async () => {
  const lock = createSingleFlightLock();
  const failed = await performReviewContinue({
    lock,
    postContinue: async () => { throw new Error('first failure'); },
    postRun: async () => ({ ran: true }),
  });
  assert.equal(failed.ran, false);
  assert.equal(lock.pending, null);

  const retried = await performReviewContinue({
    lock,
    postContinue: async () => ({ state: 'active' }),
    postRun: async () => ({ ran: true }),
  });
  assert.equal(retried.ran, true);
  assert.deepEqual(retried.runResult, { ran: true });
});
