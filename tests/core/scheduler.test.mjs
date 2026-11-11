import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCKING_SEAT_STATUSES,
  DEFAULT_CASUAL_MAX_ATTEMPTS,
  MAX_CASUAL_ATTEMPTS,
  applyMessage,
  createSchedule,
  isPass,
  isSpeakableStatus,
  migrateSchedule,
  recordResult,
  selectNext,
  setSeatStatus,
} from '../../core/scheduler.mjs';

function pick(state) {
  const result = selectNext(state);
  assert.equal(
    result.decision.selected,
    true,
    `expected a selection, got reason=${result.decision.reason}`,
  );
  return result;
}

function record(state, { attemptId, seatId, outcome = 'completed', text = 'reply', error }) {
  return recordResult(state, {
    attemptId,
    seatId,
    outcome,
    ...(text === undefined ? {} : { text }),
    ...(error === undefined ? {} : { error }),
  });
}

function complete(state, seatId, attemptId, text = 'reply') {
  const result = record(state, { attemptId, seatId, outcome: 'completed', text });
  assert.equal(result.applied, true);
  return result.state;
}

function casual(seats, maxAttempts) {
  return createSchedule({
    mode: 'casual',
    seats,
    ...(maxAttempts === undefined ? {} : { maxAttempts }),
  });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function roundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

describe('createSchedule', () => {
  it('creates serializable manual / addressed / casual states', () => {
    const manual = createSchedule({ mode: 'manual', seats: ['a', 'b'] });
    const addressed = createSchedule({ mode: 'addressed', seats: ['a', 'b'] });
    const casualState = casual(['a', 'b']);

    for (const state of [manual, addressed, casualState]) {
      assert.equal(state.schemaVersion, 1);
      assert.equal(state.round, 1);
      assert.equal(state.attemptsUsed, 0);
      assert.equal(state.selectionSeq, 0);
      assert.equal(state.started, true);
      assert.equal(state.ended, false);
      assert.equal(state.awaiting, null);
      assert.equal(state.lastSelected, null);
      assert.deepEqual(state.ownerPriority, []);
      assert.deepEqual(state.directQueue, []);
      assert.deepEqual(state.manualQueue, []);
      assert.deepEqual(state.terminalAttempts, []);
      assert.deepEqual(roundTrip(state), state);
    }

    assert.equal(manual.maxAttempts, null);
    assert.equal(addressed.maxAttempts, null);
    assert.equal(casualState.maxAttempts, DEFAULT_CASUAL_MAX_ATTEMPTS);
  });

  it('migrates legacy per-seat counters from terminal attempts', () => {
    const state = casual(['a', 'b']);
    for (const seat of state.seats) delete seat.stats;
    state.terminalAttempts.push(
      { attemptId: 'a1', seatId: 'a', outcome: 'completed', attemptSeq: 1, round: 1 },
      { attemptId: 'a2', seatId: 'a', outcome: 'failed', attemptSeq: 2, round: 1 },
      { attemptId: 'b1', seatId: 'b', outcome: 'pass', attemptSeq: 3, round: 1 },
    );
    const migrated = migrateSchedule(state);
    assert.deepEqual(migrated.seats[0].stats, { completed: 1, pass: 0, failed: 1, aborted: 0 });
    assert.deepEqual(migrated.seats[1].stats, { completed: 0, pass: 1, failed: 0, aborted: 0 });
    assert.equal(state.seats[0].stats, undefined, '迁移不得修改旧状态');
  });

  it('defaults casual to 8, accepts up to 12, rejects invalid limits', () => {
    assert.equal(casual(['a', 'b']).maxAttempts, 8);
    assert.equal(casual(['a', 'b'], 1).maxAttempts, 1);
    assert.equal(casual(['a', 'b'], MAX_CASUAL_ATTEMPTS).maxAttempts, 12);

    for (const value of [0, -1, 1.5, '8', null, 13, MAX_CASUAL_ATTEMPTS + 1]) {
      assert.throws(
        () => casual(['a', 'b'], value),
        /maxAttempts must be an integer between 1 and 12/,
        `expected maxAttempts=${String(value)} to be rejected`,
      );
    }
    assert.throws(
      () => createSchedule({ mode: 'manual', seats: ['a'], maxAttempts: 4 }),
      /only valid for casual/,
    );
  });

  it('rejects unknown modes and invalid or duplicate seats', () => {
    assert.throws(() => createSchedule({ mode: 'open', seats: ['a'] }), /Unknown scheduler mode/);
    assert.throws(() => createSchedule({ mode: 'casual', seats: [] }), /non-empty seats/);
    assert.throws(() => createSchedule({ mode: 'casual', seats: ['a', 'a'] }), /Duplicate seatId/);
    assert.throws(() => createSchedule({ mode: 'casual', seats: [''] }), /non-empty seatId/);
    assert.throws(() => createSchedule({ mode: 'casual', seats: [{}] }), /non-empty seatId/);
    assert.throws(
      () => createSchedule({ mode: 'casual', seats: [{ seatId: 'a', status: '' }] }),
      /non-empty status/,
    );
  });

  it('ignores voice fields and does not mutate frozen inputs', () => {
    const config = deepFreeze({
      mode: 'casual',
      seats: [
        { seatId: 'a', status: 'idle', voiceState: 'speaking', voice: { muted: true } },
        { seatId: 'b', status: 'muted', voiceState: 'finished' },
      ],
      maxAttempts: 4,
    });
    const state = createSchedule(config);
    assert.equal(state.seats[0].voiceState, undefined);
    assert.equal(state.seats[0].voice, undefined);
    assert.equal(JSON.stringify(state).includes('voice'), false);
    assert.equal(state.seats[1].status, 'muted');
  });
});

describe('manual mode', () => {
  it('does not invent a speaker without an owner nomination', () => {
    const state = createSchedule({ mode: 'manual', seats: ['a', 'b'] });
    const result = selectNext(state);
    assert.equal(result.decision.selected, false);
    assert.equal(result.decision.reason, 'no-nomination');
    assert.deepEqual(result.state, state);
  });

  it('only serves the explicit owner nomination queue', () => {
    let state = createSchedule({ mode: 'manual', seats: ['a', 'b', 'c'] });
    state = applyMessage(state, { from: 'owner', mentions: ['a', 'c'] });

    const first = pick(state);
    assert.equal(first.decision.seatId, 'a');
    assert.equal(first.decision.reason, 'owner-mention');
    state = complete(first.state, 'a', 'm1');
    assert.equal(selectNext(state).decision.seatId, 'c');

    const second = pick(state);
    assert.equal(second.decision.seatId, 'c');
  });

  it('ignores member mentions in manual mode', () => {
    let state = createSchedule({ mode: 'manual', seats: ['a', 'b'] });
    state = applyMessage(state, { from: 'member', seatId: 'b', mentions: ['a'] });
    assert.deepEqual(state.manualQueue, []);
    assert.equal(selectNext(state).decision.reason, 'no-nomination');
  });

  it('skips nominations that cannot speak and moves to the next name', () => {
    let state = createSchedule({
      mode: 'manual',
      seats: [{ seatId: 'a', status: 'error' }, 'b'],
    });
    state = applyMessage(state, { from: 'owner', nominations: ['a', 'b'] });
    const result = pick(state);
    assert.equal(result.decision.seatId, 'b');
    assert.deepEqual(result.state.manualQueue, []);
  });

  it('allows the same seat twice when the owner nominates it twice', () => {
    let state = createSchedule({ mode: 'manual', seats: ['a', 'b'] });
    state = applyMessage(state, { from: 'owner', nominations: ['a'] });
    const first = pick(state);
    state = complete(first.state, 'a', 'm1');

    state = applyMessage(state, { from: 'owner', nominations: ['a'] });
    const second = pick(state);
    assert.equal(second.decision.seatId, 'a');
    assert.equal(second.decision.reason, 'owner-nomination');
  });

  it('filters unknown mentions and reply targets', () => {
    let state = createSchedule({ mode: 'manual', seats: ['a'] });
    state = applyMessage(state, {
      from: 'owner',
      mentions: ['missing'],
      replyTo: 'also-missing',
      nominations: ['a'],
    });
    assert.deepEqual(state.manualQueue.map((item) => item.seatId), ['a']);
  });
});

describe('addressed mode', () => {
  it('does not invent a next turn when nobody is addressed', () => {
    const state = createSchedule({ mode: 'addressed', seats: ['a', 'b'] });
    const result = selectNext(state);
    assert.equal(result.decision.selected, false);
    assert.equal(result.decision.reason, 'no-addressed-target');

    const completed = complete(pick(applyMessage(state, {
      from: 'member',
      mentions: ['a'],
    })).state, 'a', 'a1');
    const after = selectNext(completed);
    assert.equal(after.decision.selected, false);
    assert.equal(after.decision.reason, 'no-addressed-target');
  });

  it('selects a member mention and a replyTo target', () => {
    let state = createSchedule({ mode: 'addressed', seats: ['a', 'b', 'c'] });
    state = applyMessage(state, { from: 'member', mentions: ['c'] });
    let result = pick(state);
    assert.equal(result.decision.seatId, 'c');
    assert.equal(result.decision.reason, 'mention');

    state = complete(result.state, 'c', 'a1');
    state = applyMessage(state, { from: 'member', replyTo: 'b' });
    result = pick(state);
    assert.equal(result.decision.seatId, 'b');
    assert.equal(result.decision.reason, 'replyTo');
  });

  it('lets a directly replied-to seat speak consecutively', () => {
    let state = createSchedule({ mode: 'addressed', seats: ['a', 'b'] });
    state = applyMessage(state, { from: 'member', mentions: ['a'] });
    state = complete(pick(state).state, 'a', 'a1');

    state = applyMessage(state, { from: 'member', replyTo: 'a' });
    const result = pick(state);
    assert.equal(result.decision.seatId, 'a');
    assert.equal(result.decision.reason, 'replyTo');
  });

  it('puts owner interjections ahead of older automatic direct targets', () => {
    let state = createSchedule({ mode: 'addressed', seats: ['a', 'b', 'c'] });
    state = applyMessage(state, { from: 'member', mentions: ['a'] });
    state = applyMessage(state, { from: 'owner', mentions: ['b'] });

    let result = pick(state);
    assert.equal(result.decision.seatId, 'b');
    assert.equal(result.decision.reason, 'owner-mention');

    state = complete(result.state, 'b', 'a1');
    result = pick(state);
    assert.equal(result.decision.seatId, 'a');
    assert.equal(result.decision.reason, 'mention');
  });

  it('does not substitute another seat when the addressed seat cannot speak', () => {
    let state = createSchedule({
      mode: 'addressed',
      seats: [{ seatId: 'a', status: 'error' }, 'b'],
    });
    state = applyMessage(state, { from: 'member', mentions: ['a'] });
    const result = selectNext(state);
    assert.equal(result.decision.selected, false);
    assert.equal(result.decision.reason, 'no-addressed-target');
    assert.deepEqual(result.state.directQueue, []);
  });
});

describe('casual selection order', () => {
  it('uses longest silence with stable seat order as the tie breaker', () => {
    let state = casual(['a', 'b', 'c']);
    let result = pick(state);
    assert.equal(result.decision.seatId, 'a');
    assert.equal(result.decision.reason, 'longest-silence');

    state = complete(result.state, 'a', 'c1');
    result = pick(state);
    assert.equal(result.decision.seatId, 'b');

    state = complete(result.state, 'b', 'c2');
    result = pick(state);
    assert.equal(result.decision.seatId, 'c');

    state = complete(result.state, 'c', 'c3');
    result = pick(state);
    assert.equal(result.decision.seatId, 'a');
  });

  it('keeps the same seat from speaking twice by default', () => {
    let state = casual(['a', 'b']);
    state = complete(pick(state).state, 'a', 'c1');
    const result = pick(state);
    assert.equal(result.decision.seatId, 'b');
  });

  it('reports consecutive-blocked when only the previous seat is available', () => {
    let state = casual(['a', 'b']);
    state = complete(pick(state).state, 'a', 'c1');
    state = setSeatStatus(state, 'b', 'error');
    const result = selectNext(state);
    assert.equal(result.decision.selected, false);
    assert.equal(result.decision.reason, 'consecutive-blocked');
  });

  it('prefers direct mentions and replyTo before fair ordering', () => {
    let state = casual(['a', 'b', 'c']);
    state = applyMessage(state, { from: 'member', mentions: ['c'] });
    let result = pick(state);
    assert.equal(result.decision.seatId, 'c');
    assert.equal(result.decision.reason, 'mention');

    state = complete(result.state, 'c', 'c1');
    state = applyMessage(state, { from: 'member', replyTo: 'b' });
    result = pick(state);
    assert.equal(result.decision.seatId, 'b');
    assert.equal(result.decision.reason, 'replyTo');
  });

  it('allows a directly mentioned seat to speak consecutively', () => {
    let state = casual(['a', 'b']);
    state = complete(pick(state).state, 'a', 'c1');
    state = applyMessage(state, { from: 'member', mentions: ['a'] });
    const result = pick(state);
    assert.equal(result.decision.seatId, 'a');
    assert.equal(result.decision.reason, 'mention');
  });

  it('falls back to fair order when a mentioned seat cannot speak', () => {
    let state = casual([{ seatId: 'a', status: 'error' }, 'b', 'c']);
    state = applyMessage(state, { from: 'member', mentions: ['a'] });
    const result = pick(state);
    assert.equal(result.decision.seatId, 'b');
    assert.equal(result.decision.reason, 'longest-silence');
    assert.deepEqual(result.state.directQueue, []);
  });

  it('puts owner interjections ahead of old unstarted automatic turns', () => {
    let state = casual(['a', 'b', 'c']);
    state = applyMessage(state, { from: 'member', mentions: ['a'] });
    state = applyMessage(state, { from: 'owner', mentions: ['b'] });

    let result = pick(state);
    assert.equal(result.decision.seatId, 'b');
    assert.equal(result.decision.reason, 'owner-mention');

    state = complete(result.state, 'b', 'c1');
    result = pick(state);
    assert.equal(result.decision.seatId, 'a');
    assert.equal(result.decision.reason, 'mention');
  });

  it('an owner message without a target still starts casual and selects fairly', () => {
    let state = casual(['a', 'b']);
    state = applyMessage(state, { from: 'owner', text: '聊聊今天' });
    const result = pick(state);
    assert.equal(result.decision.seatId, 'a');
    assert.deepEqual(result.state.ownerPriority, []);
    assert.deepEqual(result.state.directQueue, []);
  });

  it('ignores unknown mentions', () => {
    let state = casual(['a', 'b']);
    state = applyMessage(state, { from: 'member', mentions: ['missing'] });
    assert.deepEqual(state.directQueue, []);
    const result = pick(state);
    assert.equal(result.decision.seatId, 'a');
  });
});

describe('seat status filtering', () => {
  for (const status of BLOCKING_SEAT_STATUSES) {
    it(`skips ${status} seats`, () => {
      const state = casual([{ seatId: 'a', status }, 'b']);
      const result = pick(state);
      assert.equal(result.decision.seatId, 'b');
    });
  }

  it('reports no-eligible-seat when every seat is blocked', () => {
    const state = casual([
      { seatId: 'a', status: 'error' },
      { seatId: 'b', status: 'halted' },
    ]);
    const result = selectNext(state);
    assert.equal(result.decision.selected, false);
    assert.equal(result.decision.reason, 'no-eligible-seat');
  });

  it('never blocks text for muted or speaking seats', () => {
    for (const status of ['muted', 'speaking', 'passed', 'idle']) {
      const state = casual([{ seatId: 'a', status }, 'b']);
      const result = pick(state);
      assert.equal(result.decision.seatId, 'a');
      assert.equal(isSpeakableStatus(status), true);
    }
    assert.equal(isSpeakableStatus('muted'), true);
    assert.equal(isSpeakableStatus('speaking'), true);
    assert.equal(isSpeakableStatus('error'), false);
  });

  it('is unaffected by voice state or voice events', () => {
    const plain = casual(['a', 'b']);
    const voiced = casual([
      { seatId: 'a', status: 'idle', voice: 'speaking', voiceState: 'started' },
      { seatId: 'b', status: 'idle', voice: 'failed', voiceState: 'finished' },
    ]);
    assert.deepEqual(selectNext(plain).decision, selectNext(voiced).decision);
    assert.equal(JSON.stringify(voiced).includes('voice'), false);
  });

  it('setSeatStatus is pure and only changes the status snapshot', () => {
    const state = casual(['a', 'b']);
    const next = setSeatStatus(state, 'b', 'error');
    assert.equal(state.seats[1].status, 'idle');
    assert.equal(next.seats[1].status, 'error');
    assert.equal(next.attemptsUsed, state.attemptsUsed);
    assert.equal(next.lastSelected, state.lastSelected);
    assert.throws(() => setSeatStatus(state, 'missing', 'idle'), /Unknown seatId/);
  });
});

describe('attempts, terminal results and PASS', () => {
  it('selecting a seat does not consume an attempt', () => {
    const result = pick(casual(['a', 'b'], 3));
    assert.equal(result.state.attemptsUsed, 0);
    assert.equal(result.decision.attemptsUsed, 0);
    assert.equal(result.state.awaiting.seatId, 'a');
  });

  it('prevents a second selection while an attempt is in flight', () => {
    const first = pick(casual(['a', 'b']));
    const second = selectNext(first.state);
    assert.equal(second.decision.selected, false);
    assert.equal(second.decision.reason, 'attempt-in-flight');
    assert.equal(second.state, first.state);
  });

  it('computes PASS only for the exact trimmed token', () => {
    assert.equal(isPass('[PASS]'), true);
    assert.equal(isPass('  \n[PASS]\t '), true);
    assert.equal(isPass('[PASS] extra'), false);
    assert.equal(isPass('[pass]'), false);
    assert.equal(isPass('[PASS'), false);
    assert.equal(isPass('PASS'), false);
    assert.equal(isPass(''), false);
    assert.equal(isPass(undefined), false);
  });

  it('turns a completed [PASS] into pass without marking a completed speech', () => {
    let state = casual(['a', 'b']);
    state = pick(state).state;
    const result = record(state, {
      attemptId: 'p1',
      seatId: 'a',
      outcome: 'completed',
      text: '  \n[PASS]\t ',
    });
    assert.equal(result.applied, true);
    assert.equal(result.outcome, 'pass');
    const seat = result.state.seats[0];
    assert.equal(seat.lastAttempt.outcome, 'pass');
    assert.equal(seat.lastCompleted, null);
    assert.equal(seat.lastSpokeSeq, 0);
    assert.equal(result.state.stats.pass, 1);
    assert.equal(result.state.stats.completed, 0);
  });

  it('does not treat a longer or differently cased [PASS] as pass', () => {
    let state = casual(['a', 'b']);
    state = pick(state).state;
    let result = record(state, {
      attemptId: 'n1',
      seatId: 'a',
      outcome: 'completed',
      text: '[PASS] but first...',
    });
    assert.equal(result.outcome, 'completed');
    assert.notEqual(result.state.seats[0].lastCompleted, null);

    state = casual(['a', 'b']);
    state = pick(state).state;
    result = record(state, {
      attemptId: 'n2',
      seatId: 'a',
      outcome: 'completed',
      text: '[pass]',
    });
    assert.equal(result.outcome, 'completed');
  });

  it('requires exact PASS text and completed text', () => {
    const state = pick(casual(['a', 'b'])).state;
    assert.throws(
      () => record(state, { attemptId: 'p1', seatId: 'a', outcome: 'pass', text: 'PASS' }),
      /\[PASS\]/,
    );
    assert.throws(
      () => recordResult(state, { attemptId: 'p2', seatId: 'a', outcome: 'pass' }),
      /\[PASS\]/,
    );
    assert.throws(
      () => recordResult(state, { attemptId: 'p3', seatId: 'a', outcome: 'completed' }),
      /completed result requires a text/,
    );
    assert.throws(
      () => recordResult(state, {
        attemptId: 'p4',
        seatId: 'a',
        outcome: 'done',
        text: 'x',
      }),
      /Unknown terminal outcome/,
    );
    assert.equal(state.attemptsUsed, 0);
  });

  it('does not count PASS as speech in silence fairness', () => {
    let state = casual(['a', 'b', 'c']);
    state = complete(pick(state).state, 'a', 'fair-1');

    let selected = pick(state);
    assert.equal(selected.decision.seatId, 'b');
    state = record(selected.state, {
      attemptId: 'fair-2',
      seatId: 'b',
      outcome: 'pass',
      text: '[PASS]',
    }).state;
    assert.equal(state.seats[1].lastSpokeSeq, 0);

    selected = pick(state);
    assert.equal(selected.decision.seatId, 'c');
    state = complete(selected.state, 'c', 'fair-3');

    selected = pick(state);
    assert.equal(selected.decision.seatId, 'b');
  });

  it('writes fairness metadata for completed, pass, failed and aborted', () => {
    let state = casual(['a', 'b']);
    state = pick(state).state;
    let result = record(state, { attemptId: 't1', seatId: 'a', outcome: 'completed', text: 'hi' });
    assert.deepEqual(result.state.seats[0].lastAttempt, {
      attemptId: 't1',
      outcome: 'completed',
      attemptSeq: 1,
      round: 1,
    });
    assert.deepEqual(result.state.seats[0].lastCompleted, {
      attemptId: 't1',
      attemptSeq: 1,
      round: 1,
    });
    assert.equal(result.state.seats[0].lastSpokeSeq, 1);

    state = pick(result.state).state;
    result = record(state, { attemptId: 't2', seatId: 'b', outcome: 'failed', error: { code: 'E_TEST' } });
    assert.equal(result.state.seats[1].lastAttempt.outcome, 'failed');
    assert.equal(result.state.seats[1].lastAttempt.errorCode, 'E_TEST');
    assert.equal(result.state.seats[1].lastCompleted, null);
    assert.equal(result.state.stats.failed, 1);

    state = pick(result.state).state;
    result = record(state, { attemptId: 't3', seatId: 'a', outcome: 'aborted' });
    assert.equal(result.state.seats[0].lastAttempt.outcome, 'aborted');
    assert.equal(result.state.seats[0].lastCompleted.attemptId, 't1');
    assert.equal(result.state.stats.aborted, 1);
  });

  it('counts a duplicate terminal result only once', () => {
    let state = casual(['a', 'b']);
    state = pick(state).state;
    const first = record(state, { attemptId: 'dup-1', seatId: 'a', outcome: 'completed', text: 'hi' });
    const duplicate = record(first.state, {
      attemptId: 'dup-1',
      seatId: 'a',
      outcome: 'completed',
      text: 'different text',
    });
    assert.equal(duplicate.applied, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.state, first.state);
    assert.equal(duplicate.attemptSeq, 1);
    assert.equal(duplicate.state.attemptsUsed, 1);
    assert.equal(duplicate.state.stats.completed, 1);
    assert.equal(duplicate.state.terminalAttempts.length, 1);
  });

  it('rejects a result whose seat does not match the in-flight attempt', () => {
    const state = pick(casual(['a', 'b'])).state;
    assert.throws(
      () => record(state, { attemptId: 'bad-1', seatId: 'b', outcome: 'completed', text: 'x' }),
      /in-flight seat a/,
    );
    assert.equal(state.attemptsUsed, 0);
  });

  it('rejects unknown seats and malformed results', () => {
    const state = pick(casual(['a', 'b'])).state;
    assert.throws(
      () => record(state, { attemptId: 'x', seatId: 'missing', outcome: 'completed', text: 'x' }),
      /Unknown seatId/,
    );
    assert.throws(
      () => record(state, { attemptId: '', seatId: 'a', outcome: 'completed', text: 'x' }),
      /attemptId/,
    );
    assert.throws(
      () => record(state, { attemptId: 'x', seatId: 'a', outcome: 'completed', text: 42 }),
      /text must be a string/,
    );
  });
});

describe('casual round limits and no auto continuation', () => {
  it('ends after the default 8 terminal attempts and never auto-starts round 2', () => {
    let state = casual(['a', 'b']);
    let lastSeatId = null;

    for (let turn = 1; turn <= DEFAULT_CASUAL_MAX_ATTEMPTS; turn += 1) {
      const selected = pick(state);
      state = selected.state;
      lastSeatId = selected.decision.seatId;
      const applied = record(state, {
        attemptId: `turn-${turn}`,
        seatId: lastSeatId,
        outcome: 'completed',
        text: `message ${turn}`,
      });
      assert.equal(applied.applied, true);
      state = applied.state;
    }

    assert.equal(state.attemptsUsed, 8);
    assert.equal(state.ended, true);
    assert.equal(state.stats.completed, 8);
    assert.equal(state.round, 1);

    const stopped = selectNext(state);
    assert.equal(stopped.decision.selected, false);
    assert.equal(stopped.decision.reason, 'round-complete');
    assert.equal(stopped.state.round, 1);

    const duplicate = record(state, {
      attemptId: 'turn-8',
      seatId: lastSeatId,
      outcome: 'completed',
      text: 'ignored',
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.state.attemptsUsed, 8);

    const interjected = applyMessage(state, { from: 'owner', mentions: ['a'] });
    const stillStopped = selectNext(interjected);
    assert.equal(stillStopped.decision.selected, false);
    assert.equal(stillStopped.decision.reason, 'round-complete');
    assert.equal(stillStopped.state.round, 1);
  });

  it('counts completed, pass, failed and aborted against a configured limit', () => {
    let state = casual(['a', 'b'], 4);

    state = record(pick(state).state, {
      attemptId: 'r1',
      seatId: 'a',
      outcome: 'completed',
      text: 'hello',
    }).state;
    state = record(pick(state).state, {
      attemptId: 'r2',
      seatId: 'b',
      outcome: 'failed',
      error: { code: 'E_BRIDGE' },
    }).state;
    state = record(pick(state).state, {
      attemptId: 'r3',
      seatId: 'a',
      outcome: 'aborted',
    }).state;

    assert.equal(state.ended, false);
    const fourth = pick(state);
    state = record(fourth.state, {
      attemptId: 'r4',
      seatId: fourth.decision.seatId,
      outcome: 'pass',
      text: ' [PASS] ',
    }).state;

    assert.equal(state.attemptsUsed, 4);
    assert.equal(state.ended, true);
    assert.deepEqual(state.stats, {
      completed: 1,
      pass: 1,
      failed: 1,
      aborted: 1,
    });
  });

  it('refuses new terminal results after the round ended', () => {
    let state = casual(['a', 'b'], 1);
    state = pick(state).state;
    state = record(state, {
      attemptId: 'only',
      seatId: 'a',
      outcome: 'completed',
      text: 'hi',
    }).state;
    assert.equal(state.ended, true);

    const later = record(state, {
      attemptId: 'late',
      seatId: 'b',
      outcome: 'completed',
      text: 'late reply',
    });
    assert.equal(later.applied, false);
    assert.equal(later.reason, 'round-ended');
    assert.equal(later.state.attemptsUsed, 1);
    assert.equal(later.state.terminalAttempts.length, 1);
  });

  it('ends a casual round after every eligible seat passes', () => {
    let state = casual(['a', 'b'], 3);
    for (let turn = 1; turn <= 2; turn += 1) {
      const selected = pick(state);
      state = selected.state;
      state = record(state, {
        attemptId: `pass-${turn}`,
        seatId: selected.decision.seatId,
        outcome: 'pass',
        text: ' \n[PASS]\t ',
      }).state;
    }
    assert.equal(state.attemptsUsed, 2);
    assert.deepEqual(state.passSeatIds, ['a', 'b']);
    assert.equal(state.ended, true);
    assert.equal(state.stats.pass, 2);
    assert.equal(state.awaiting, null);
    assert.equal(state.lastSelected.seatId, 'b');
    assert.equal(selectNext(state).decision.reason, 'round-complete');
  });

  it('resets the pass cycle for new member speech and a new owner topic', () => {
    let state = casual(['a', 'b', 'c'], 8);
    state = record(pick(state).state, {
      attemptId: 'visible-a', seatId: 'a', outcome: 'completed', text: 'A speaks',
    }).state;
    state = record(pick(state).state, {
      attemptId: 'pass-b', seatId: 'b', outcome: 'pass', text: '[PASS]',
    }).state;
    assert.deepEqual(state.passSeatIds, ['b']);

    state = record(pick(state).state, {
      attemptId: 'visible-c', seatId: 'c', outcome: 'completed', text: 'C speaks',
    }).state;
    assert.equal(state.lastSpeakerSeatId, 'c');
    assert.deepEqual(state.passSeatIds, []);

    state = applyMessage(state, { from: 'owner', text: 'new topic' });
    assert.equal(state.lastSpeakerSeatId, null);
    assert.deepEqual(state.passSeatIds, []);
    const selected = pick(state);
    state = record(selected.state, {
      attemptId: 'pass-after-owner', seatId: selected.decision.seatId, outcome: 'pass', text: '[PASS]',
    }).state;
    assert.equal(state.ended, false);
  });

  it('does not apply casual attempt limits to manual or addressed modes', () => {
    let manual = createSchedule({ mode: 'manual', seats: ['a', 'b'] });
    for (let turn = 0; turn < 13; turn += 1) {
      manual = applyMessage(manual, { from: 'owner', nominations: ['a'] });
      const selected = pick(manual);
      manual = record(selected.state, {
        attemptId: `manual-${turn}`,
        seatId: 'a',
        outcome: 'completed',
        text: 'ok',
      }).state;
    }
    assert.equal(manual.maxAttempts, null);
    assert.equal(manual.ended, false);
    assert.equal(manual.attemptsUsed, 13);
  });
});

describe('purity, immutability and serialization', () => {
  it('does not mutate frozen states, messages or results', () => {
    const state = deepFreeze(casual(['a', 'b'], 4));
    const message = deepFreeze({ from: 'owner', mentions: ['a'], text: 'question' });
    const withMessage = applyMessage(state, message);
    const selected = pick(withMessage);
    const result = deepFreeze({
      attemptId: 'frozen-1',
      seatId: 'a',
      outcome: 'completed',
      text: 'answer',
    });
    const recorded = recordResult(selected.state, result);

    assert.equal(recorded.applied, true);
    assert.deepEqual(state.ownerPriority, []);
    assert.deepEqual(state.terminalAttempts, []);
    assert.equal(state.attemptsUsed, 0);
    assert.equal(withMessage.ownerPriority.length, 1);
  });

  it('produces the same decisions after JSON round-trip', () => {
    const state = casual(['a', 'b', 'c'], 5);
    const restored = roundTrip(state);
    const first = selectNext(state);
    const second = selectNext(restored);
    assert.deepEqual(first.decision, second.decision);
    assert.deepEqual(first.state, second.state);

    const firstResult = record(first.state, {
      attemptId: 's1',
      seatId: first.decision.seatId,
      outcome: 'completed',
      text: 'hello',
    });
    const secondResult = record(second.state, {
      attemptId: 's1',
      seatId: second.decision.seatId,
      outcome: 'completed',
      text: 'hello',
    });
    assert.deepEqual(firstResult, secondResult);
    assert.deepEqual(roundTrip(firstResult.state), firstResult.state);
  });

  it('is deterministic for repeated runs with the same inputs', () => {
    const make = () => casual(['c', 'a', 'b']);
    const first = pick(make());
    const second = pick(make());
    assert.deepEqual(first.decision, second.decision);
    assert.deepEqual(first.state, second.state);
  });
});
