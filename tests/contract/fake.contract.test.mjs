import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BRIDGE_METHODS,
  CAPABILITIES,
  BridgeError,
  assertBridge,
} from '../../adapters/contract.mjs';
import { FakeBridge, createFakeBridge } from '../../adapters/fake/bridge.mjs';
import { createBridgeEvent } from '../../core/events.mjs';

function makeConfig(overrides = {}) {
  return {
    seatId: 'kimi',
    nativeSessionRef: 'sess_kimi',
    identityRef: 'identity_kimi',
    voiceMode: 'native',
    supportsMute: false,
    ...overrides,
  };
}

function makePacket(overrides = {}) {
  return {
    roomId: 'room_main',
    roomSeq: 1,
    turnId: 'turn_1',
    attemptId: 'attempt_1',
    seatId: 'kimi',
    contextEpoch: 'epoch_1',
    text: '请回应房间里的问题。',
    ...overrides,
  };
}

async function connectedBridge(overrides = {}) {
  const bridge = new FakeBridge(makeConfig(overrides));
  await bridge.connect();
  return bridge;
}

async function take(iterator, count) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const step = await iterator.next();
    assert.equal(step.done, false, `expected event #${index + 1}, stream ended early`);
    events.push(step.value);
  }
  return events;
}

function assertBridgeEventShape(event, expectedSeatId = 'kimi') {
  assert.equal(event.schemaVersion, 1);
  assert.match(event.eventId, /^be_/);
  assert.equal(typeof event.type, 'string');
  assert.equal(event.seatId, expectedSeatId);
  assert.equal(typeof event.occurredAt, 'string');
  assert.ok(event.payload && typeof event.payload === 'object');
  // 事件信封必须能原样交给 createBridgeEvent（Core 的事件入口）。
  assert.doesNotThrow(() => createBridgeEvent({
    type: event.type,
    seatId: event.seatId,
    attemptId: event.attemptId,
    payload: event.payload,
  }));
}

test('implements every Bridge v1 method', () => {
  const bridge = createFakeBridge(makeConfig());
  assert.doesNotThrow(() => assertBridge(bridge));
  for (const method of BRIDGE_METHODS) {
    assert.equal(typeof bridge[method], 'function', `${method} must be callable`);
  }
});

test('probe is free and read-only, and reports normalized capabilities', async () => {
  const bridge = new FakeBridge(makeConfig({
    nativeSessionRef: undefined,
    allowCreateSession: true,
  }));

  const probe = await bridge.probe();

  assert.equal(probe.voiceMode, 'native');
  assert.equal(probe.clientVersion, 'fake-bridge/1.0.0');
  assert.deepEqual(Object.keys(probe.capabilities), [...CAPABILITIES]);
  assert.equal(probe.capabilities.nativeSession, true);
  assert.equal(probe.capabilities.voiceMute, false);
  assert.equal(probe.identity, undefined);
  assert.ok(Array.isArray(probe.warnings));

  const state = bridge.inspect();
  assert.equal(state.connected, false);
  assert.equal(state.sessionCreated, false);
  assert.equal(state.sessionRef, null);
  assert.equal(state.eventCount, 0);

  assert.doesNotThrow(() => bridge.probe());
  assert.equal(bridge.inspect().sessionCreated, false);
});

test('connect creates a session only when explicitly allowed, and identity has no persona body', async () => {
  const denied = new FakeBridge(makeConfig({ nativeSessionRef: undefined }));
  await assert.rejects(denied.connect(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'SESSION_REQUIRED');
    return true;
  });

  const bridge = new FakeBridge(makeConfig({
    nativeSessionRef: undefined,
    allowCreateSession: true,
    identityMetadata: { name: '月白', preset: 'kimi' },
  }));
  await bridge.connect();
  assert.equal(bridge.inspect().sessionCreated, true);
  assert.equal(bridge.inspect().sessionRef, 'fake_session_kimi');

  const identity = await bridge.getIdentity();
  assert.deepEqual(identity, {
    sourceRef: 'identity_kimi',
    revision: '1',
    nativeSessionRef: 'fake_session_kimi',
    metadata: { name: '月白', preset: 'kimi' },
  });
  assert.equal('body' in identity.metadata, false);
  assert.equal('content' in identity.metadata, false);
});

test('send validates context before registering an attempt', async () => {
  const bridge = new FakeBridge(makeConfig());
  await assert.rejects(bridge.send(makePacket()), (error) => {
    assert.equal(error.code, 'BRIDGE_NOT_CONNECTED');
    return true;
  });

  await bridge.connect();

  await assert.rejects(bridge.send({}), (error) => {
    assert.equal(error.code, 'CONTEXT_PACKET_INVALID');
    return true;
  });
  await assert.rejects(bridge.send(makePacket({ seatId: 'other' })), (error) => {
    assert.equal(error.code, 'CONTEXT_SEAT_MISMATCH');
    return true;
  });
  await assert.rejects(bridge.send(makePacket({ roomSeq: 0 })), (error) => {
    assert.equal(error.code, 'CONTEXT_PACKET_INVALID');
    return true;
  });
  await assert.rejects(bridge.send(makePacket({ contextEpoch: '' })), (error) => {
    assert.equal(error.code, 'CONTEXT_PACKET_INVALID');
    return true;
  });

  assert.equal(bridge.inspect().eventCount, 0);
  assert.equal(bridge.inspect().attemptCount, 0);
});

test('send returns only an accepted receipt; completion arrives as AttemptCompleted', async () => {
  const bridge = await connectedBridge();
  const iterator = bridge.subscribe();

  const receipt = await bridge.send(makePacket());
  assert.deepEqual(receipt, {
    attemptId: 'attempt_1',
    accepted: true,
    nativeRequestRef: 'attempt_1:request',
  });

  const result = bridge.completeAttempt('attempt_1', {
    text: '这是最终回复。',
    usage: { inputTokens: 11, outputTokens: 7 },
  });
  assert.equal(result.delivered, true);

  const [started, completed] = await take(iterator, 2);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(started.attemptId, 'attempt_1');
  assert.equal(started.payload.nativeTurnRef, 'attempt_1:turn');
  assert.equal(completed.type, 'AttemptCompleted');
  assert.equal(completed.payload.nativeTurnRef, 'attempt_1:turn');
  assert.equal(completed.payload.nativeMessageRef, 'attempt_1:turn:message');
  assert.equal(completed.payload.text, '这是最终回复。');
  assert.deepEqual(completed.payload.usage, { inputTokens: 11, outputTokens: 7 });
  assertBridgeEventShape(started);
  assertBridgeEventShape(completed);
  assert.equal(bridge.inspect().activeAttemptId, null);

  await iterator.return();
  assert.equal(bridge.inspect().subscriberCount, 0);
});

test('one seat has at most one active attempt', async () => {
  const bridge = await connectedBridge();
  await bridge.send(makePacket());
  await assert.rejects(
    bridge.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' })),
    (error) => {
      assert.equal(error.code, 'BRIDGE_BUSY');
      assert.equal(error.retryable, true);
      return true;
    },
  );
  await bridge.cancel('attempt_1');
});

test('duplicate native final messages deliver exactly one AttemptCompleted, dedupe is by ref not text', async () => {
  const bridge = await connectedBridge();
  await bridge.send(makePacket());

  assert.equal(bridge.completeAttempt('attempt_1', { text: '相同正文', nativeMessageRef: 'msg_1' }).delivered, true);
  assert.equal(bridge.completeAttempt('attempt_1', { text: '相同正文', nativeMessageRef: 'msg_1' }).delivered, false);
  assert.equal(bridge.injectNativeFinalMessage('attempt_1', { text: '相同正文', nativeMessageRef: 'msg_1' }).delivered, false);
  assert.equal(bridge.inspect().eventCount, 2);

  // 同一座位的新 attempt 即使正文相同，只要原生引用不同就必须交付。
  await bridge.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' }));
  assert.equal(bridge.completeAttempt('attempt_2', { text: '相同正文', nativeMessageRef: 'msg_2' }).delivered, true);
  assert.equal(bridge.inspect().eventCount, 4);

  // 另一个 attempt 复用已见过的原生 turn 引用时仍按原生去重。
  await bridge.send(makePacket({ attemptId: 'attempt_3', turnId: 'turn_3' }));
  assert.equal(bridge.completeAttempt('attempt_3', {
    text: '相同正文',
    nativeTurnRef: 'attempt_1:turn',
    nativeMessageRef: 'msg_3',
  }).delivered, false);
  assert.equal(bridge.inspect().eventCount, 5);

  await bridge.cancel('attempt_3');
});

test('cancel produces AttemptAborted with partial text and is idempotent', async () => {
  const bridge = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  bridge.appendPartialText('attempt_1', '生成到一半');
  bridge.appendPartialText('attempt_1', '的正文');

  const first = await bridge.cancel('attempt_1');
  assert.deepEqual(first, {
    attemptId: 'attempt_1',
    accepted: true,
    settlement: 'confirmed',
    nativeTurnRef: 'attempt_1:turn',
  });

  const second = await bridge.cancel('attempt_1');
  assert.deepEqual(second, first);
  assert.equal(bridge.inspect().eventCount, 2);
  assert.equal(bridge.inspect().activeAttemptId, null);

  const [started, aborted] = await take(iterator, 2);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(aborted.type, 'AttemptAborted');
  assert.equal(aborted.payload.nativeTurnRef, 'attempt_1:turn');
  assert.equal(aborted.payload.partialText, '生成到一半的正文');
  assert.equal('text' in aborted.payload, false);
  assertBridgeEventShape(aborted);

  await iterator.return();
});

test('cancel on an already-completed attempt reports failure without another event', async () => {
  const bridge = await connectedBridge();
  await bridge.send(makePacket());
  bridge.completeAttempt('attempt_1', { text: '完成' });

  const receipt = await bridge.cancel('attempt_1');
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.settlement, 'failed');
  assert.equal(receipt.error.code, 'ATTEMPT_ALREADY_FINISHED');
  assert.deepEqual(await bridge.cancel('attempt_1'), receipt);
  assert.equal(bridge.inspect().eventCount, 2);
});

test('failAttempt emits AttemptFailed with a contract-shaped error', async () => {
  const bridge = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  const result = bridge.failAttempt('attempt_1', {
    error: { code: 'UPSTREAM_500', message: 'provider failed', retryable: true },
  });
  assert.equal(result.delivered, true);

  const [, failed] = await take(iterator, 2);
  assert.equal(failed.type, 'AttemptFailed');
  assert.deepEqual(failed.payload.error, {
    code: 'UPSTREAM_500',
    message: 'provider failed',
    retryable: true,
  });
  assert.equal(bridge.inspect().activeAttemptId, null);
  await iterator.return();
});

test('foreign turns are recorded as ForeignTurn and never enter the attempt', async () => {
  const bridge = await connectedBridge();
  const iterator = bridge.subscribe();

  const result = bridge.injectForeignTurn({
    nativeTurnRef: 'native_turn_owner_1',
    reason: 'owner-manual-chat',
  });
  assert.equal(result.emitted, true);

  const [foreign] = await take(iterator, 1);
  assert.equal(foreign.type, 'ForeignTurn');
  assert.equal(foreign.attemptId, null);
  assert.deepEqual(foreign.payload, {
    nativeTurnRef: 'native_turn_owner_1',
    reason: 'owner-manual-chat',
  });
  assertBridgeEventShape(foreign);

  await iterator.return();
});

test('voiceMode=none emits no speech events and does not block text completion', async () => {
  const bridge = await connectedBridge({ voiceMode: 'none' });
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  const speech = bridge.injectSpeechStarted({ nativeMessageRef: 'msg_speech' });
  assert.deepEqual(speech, {
    supported: false,
    emitted: false,
    capability: 'voiceStartedFinishedEvents',
  });

  bridge.completeAttempt('attempt_1', { text: '纯文本也能完成', nativeMessageRef: 'msg_text' });
  const events = await take(iterator, 2);
  assert.deepEqual(events.map((event) => event.type), ['AttemptStarted', 'AttemptCompleted']);
  assert.equal(events[1].payload.text, '纯文本也能完成');
  assert.equal(bridge.inspect().eventCount, 2);

  await iterator.return();
});

test('speech events can interleave with and lag behind text without blocking it', async () => {
  const bridge = await connectedBridge({ voiceMode: 'native' });
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  assert.equal(bridge.injectSpeechStarted({ nativeMessageRef: 'msg_speech' }).emitted, true);
  assert.equal(bridge.injectSpeechFailed({
    nativeMessageRef: 'msg_speech',
    error: { code: 'TTS_FAILED', message: 'no audio device', retryable: false },
  }).emitted, true);
  bridge.completeAttempt('attempt_1', { text: '文本不受语音影响', nativeMessageRef: 'msg_text' });
  assert.equal(bridge.injectSpeechFinished({ nativeMessageRef: 'msg_speech' }).emitted, true);

  const events = await take(iterator, 5);
  assert.deepEqual(events.map((event) => event.type), [
    'AttemptStarted',
    'SpeechStarted',
    'SpeechFailed',
    'AttemptCompleted',
    'SpeechFinished',
  ]);
  assert.deepEqual(events[2].payload.error, {
    code: 'TTS_FAILED',
    message: 'no audio device',
    retryable: false,
  });
  assert.equal(events[3].payload.text, '文本不受语音影响');
  assert.equal(events[0].attemptId, 'attempt_1');
  assert.equal(events[1].attemptId, 'attempt_1');
  for (const event of events) assertBridgeEventShape(event);

  await iterator.return();
});

test('setMuted reports unsupported when voiceMute is absent and toggles when present', async () => {
  const withoutMute = new FakeBridge(makeConfig({ supportsMute: false }));
  const unsupported = await withoutMute.setMuted(true);
  assert.deepEqual(unsupported, { supported: false, capability: 'voiceMute' });
  assert.equal((await withoutMute.probe()).capabilities.voiceMute, false);

  const withMute = new FakeBridge(makeConfig({ supportsMute: true }));
  assert.equal((await withMute.probe()).capabilities.voiceMute, true);
  assert.deepEqual(await withMute.setMuted(true), {
    supported: true,
    muted: true,
    capability: 'voiceMute',
  });
  assert.equal(withMute.inspect().muted, true);
  assert.deepEqual(await withMute.setMuted(false), {
    supported: true,
    muted: false,
    capability: 'voiceMute',
  });
});

test('close is idempotent, ends iterators, and keeps the native session', async () => {
  const bridge = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  bridge.completeAttempt('attempt_1', { text: '再见' });
  await take(iterator, 2);

  const pending = iterator.next();
  await bridge.close();
  await bridge.close();

  const closedStep = await pending;
  assert.equal(closedStep.done, false);
  assert.equal(closedStep.value.type, 'BridgeClosed');
  assert.deepEqual(closedStep.value.payload, { reason: 'closed' });
  assertBridgeEventShape(closedStep.value);

  assert.deepEqual(await iterator.next(), { value: undefined, done: true });

  const state = bridge.inspect();
  assert.equal(state.closed, true);
  assert.equal(state.connected, false);
  assert.equal(state.sessionRef, 'sess_kimi');
  assert.equal(state.attemptCount, 1);
  assert.equal(state.eventCount, 3);

  await assert.rejects(bridge.send(makePacket({ attemptId: 'attempt_2' })), (error) => {
    assert.equal(error.code, 'BRIDGE_CLOSED');
    return true;
  });
});

test('return() on a waiting subscriber settles it without timers', async () => {
  const bridge = await connectedBridge();
  const iterator = bridge.subscribe();
  const pending = iterator.next();

  assert.deepEqual(await iterator.return(), { value: undefined, done: true });
  assert.deepEqual(await pending, { value: undefined, done: true });
  assert.equal(bridge.inspect().subscriberCount, 0);
});

test('events emitted before subscribe are buffered and replayed in order', async () => {
  const bridge = await connectedBridge();
  await bridge.send(makePacket());
  bridge.completeAttempt('attempt_1', { text: '缓冲中的回复' });
  bridge.injectForeignTurn({ nativeTurnRef: 'native_owner_1', reason: 'foreign' });

  assert.equal(bridge.inspect().subscriberCount, 0);
  assert.equal(bridge.inspect().pendingEventCount, 3);

  const iterator = bridge.subscribe();
  const events = await take(iterator, 3);
  assert.deepEqual(events.map((event) => event.type), [
    'AttemptStarted',
    'AttemptCompleted',
    'ForeignTurn',
  ]);
  assert.equal(events[1].payload.text, '缓冲中的回复');
  assert.equal(bridge.inspect().pendingEventCount, 0);

  await iterator.return();
  assert.equal(bridge.inspect().subscriberCount, 0);
});
