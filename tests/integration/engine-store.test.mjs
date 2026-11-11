import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import { createRoomEngine } from '../../core/engine.mjs';
import { createRoomStore } from '../../store/room-store.mjs';

function bridgeFor(seatId) {
  return new FakeBridge({
    seatId,
    nativeSessionRef: `native_${seatId}`,
    voiceMode: 'none',
  });
}

test('RoomEngine persists and restores a real JSONL room', async (t) => {
  const roomDir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-engine-store-'));
  t.after(async () => {
    await rm(roomDir, { recursive: true, force: true });
  });

  const seatId = 'deepseek';
  const firstBridge = bridgeFor(seatId);
  const first = createRoomEngine({
    roomId: 'r_disk',
    bridges: new Map([[seatId, firstBridge]]),
    store: createRoomStore(roomDir),
    maxAttempts: 1,
  });

  await first.init();
  await first.activate({ actor: 'owner' });
  await first.postOwnerMessage({ actor: 'owner', text: '说一句开场白。' });
  first.on('TurnRequested', (event) => {
    setImmediate(() => {
      firstBridge.completeAttempt(event.payload.attemptId, {
        text: '开场白。',
        nativeMessageRef: 'native_message_1',
        usage: { outputTokens: 3 },
      });
    });
  });

  const run = await first.run();
  assert.equal(run.state, 'review');
  assert.equal(run.attemptsUsed, 1);
  await first.close();

  const store = createRoomStore(roomDir);
  const loaded = await store.load();
  assert.equal(loaded.room.state, 'review');
  assert.equal(loaded.schedule.ended, true);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.attempts.length, 2);
  assert.deepEqual(loaded.warnings, []);

  const sequences = loaded.events.map((event) => event.roomSeq);
  assert.deepEqual(sequences, Array.from({ length: sequences.length }, (_, index) => index + 1));
  for (const message of loaded.messages) {
    assert.equal(message.roomId, 'r_disk');
    assert.ok(Number.isSafeInteger(message.roomSeq));
    assert.equal(typeof message.createdAt, 'string');
    const posted = loaded.events.find((event) =>
      event.type === 'MessagePosted' && event.payload.messageId === message.id);
    assert.equal(message.roomSeq, posted.roomSeq);
  }

  const reviewEvents = loaded.events.filter((event) =>
    event.type === 'ReviewRequested' || event.payload?.action === 'request-review');
  assert.ok(reviewEvents.length >= 2);
  assert.ok(reviewEvents.every((event) => event.actor === 'system:scheduler'));

  const markdown = await store.exportMarkdown();
  assert.match(markdown, /说一句开场白。/);
  assert.match(markdown, /开场白。/);

  const secondBridge = bridgeFor(seatId);
  const second = createRoomEngine({
    roomId: 'r_disk',
    bridges: new Map([[seatId, secondBridge]]),
    store: createRoomStore(roomDir),
    maxAttempts: 1,
  });
  await second.init();
  const restored = second.getSnapshot();
  assert.equal(restored.room.state, 'review');
  assert.equal(restored.schedule.ended, true);
  assert.equal(restored.transcript.length, 2);
  assert.equal(restored.running, false);

  const noAutoRun = await second.run();
  assert.equal(noAutoRun.ran, false);
  assert.equal(noAutoRun.reason, 'room-not-active');
  await second.confirm({ actor: 'owner' });
  assert.equal(second.getSnapshot().room.state, 'confirmed');
  await second.close();

  const finalLoad = await createRoomStore(roomDir).load();
  assert.equal(finalLoad.room.state, 'confirmed');
  assert.equal(finalLoad.events.at(-1).type, 'ResultConfirmed');
});
