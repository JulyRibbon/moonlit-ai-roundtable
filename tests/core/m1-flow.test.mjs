import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import {
  ACTIONS,
  createRoomState,
  restore,
  transition,
} from '../../core/room-state.mjs';
import {
  createSchedule,
  recordResult,
  selectNext,
} from '../../core/scheduler.mjs';

function packetFor(decision, attemptId) {
  return {
    roomId: 'r_main',
    roomSeq: decision.selectionSeq,
    turnId: `turn_${decision.selectionSeq}`,
    attemptId,
    seatId: decision.seatId,
    contextEpoch: 'epoch_1',
    text: '继续当前话题。',
  };
}

async function take(iterator, count) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const step = await iterator.next();
    assert.equal(step.done, false);
    events.push(step.value);
  }
  return events;
}

test('fake bridges, casual scheduler and room state complete an owner-reviewed round', async () => {
  const seatIds = ['deepseek', 'kimi', 'glm'];
  const bridges = new Map(seatIds.map((seatId) => [seatId, new FakeBridge({
    seatId,
    nativeSessionRef: `native_${seatId}`,
    voiceMode: seatId === 'deepseek' ? 'none' : 'native',
  })]));
  const iterators = new Map();

  try {
    for (const [seatId, bridge] of bridges) {
      await bridge.connect();
      iterators.set(seatId, bridge.subscribe());
    }

    let room = createRoomState({ roomId: 'r_main' });
    room = transition(room, ACTIONS.ACTIVATE, { actor: 'owner' }).snapshot;
    let schedule = createSchedule({
      mode: 'casual',
      seats: seatIds,
      maxAttempts: 3,
    });
    const speakers = [];

    for (let index = 0; index < 3; index += 1) {
      const selected = selectNext(schedule);
      schedule = selected.state;
      const { decision } = selected;
      assert.equal(decision.selected, true);
      speakers.push(decision.seatId);

      const bridge = bridges.get(decision.seatId);
      const attemptId = `attempt_${index + 1}`;
      const receipt = await bridge.send(packetFor(decision, attemptId));
      assert.equal(receipt.accepted, true);

      if (decision.seatId !== 'deepseek') {
        bridge.injectSpeechStarted({ nativeMessageRef: `voice_${index}` });
      }
      const text = decision.seatId === 'glm' ? '[PASS]' : `回复 ${index + 1}`;
      bridge.completeAttempt(attemptId, {
        text,
        nativeMessageRef: `message_${index + 1}`,
      });

      const expectedEventCount = decision.seatId === 'deepseek' ? 2 : 3;
      const events = await take(iterators.get(decision.seatId), expectedEventCount);
      const completed = events.at(-1);
      assert.equal(completed.type, 'AttemptCompleted');
      assert.equal(completed.attemptId, attemptId);

      const recorded = recordResult(schedule, {
        attemptId,
        seatId: decision.seatId,
        outcome: 'completed',
        text: completed.payload.text,
      });
      assert.equal(recorded.applied, true);
      schedule = recorded.state;
    }

    assert.deepEqual(speakers, seatIds);
    assert.equal(schedule.attemptsUsed, 3);
    assert.equal(schedule.stats.completed, 2);
    assert.equal(schedule.stats.pass, 1);
    assert.equal(schedule.ended, true);
    assert.equal(selectNext(schedule).decision.reason, 'round-complete');

    const reviewed = transition(room, ACTIONS.REQUEST_REVIEW, { actor: 'owner' });
    room = reviewed.snapshot;
    const confirmed = transition(room, ACTIONS.CONFIRM, { actor: 'owner' });
    room = confirmed.snapshot;
    assert.equal(room.state, 'confirmed');
    assert.deepEqual(confirmed.events.map((event) => event.type), [
      'RoomStateChanged',
      'ResultConfirmed',
    ]);

    const restored = restore(createRoomState({ roomId: 'r_restart', state: 'active' }));
    assert.equal(restored.snapshot.state, 'paused');
    assert.equal(restored.autoResumed, false);
  } finally {
    for (const iterator of iterators.values()) await iterator.return();
    for (const bridge of bridges.values()) await bridge.close();
  }
});
