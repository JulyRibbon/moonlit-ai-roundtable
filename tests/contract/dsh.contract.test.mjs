import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_METHODS, CAPABILITIES, BridgeError, assertBridge } from '../../adapters/contract.mjs';
import { DshBridge, createDshBridge, DSH_DEFAULT_BASE_URL, nativeTurnRefFor } from '../../adapters/dsh/bridge.mjs';
import { createTurnLedger, messageKeyFor, turnKey } from '../../adapters/dsh/dedupe.mjs';
import { createBridgeEvent } from '../../core/events.mjs';

const SEAT = 'dsh';
const SESSION = 'sess_dsh';

// ── 离线 fake DSH API ────────────────────────────────────────────────────────
// 只模拟 dsh-client 的公开门面（sessions.list/prompt、callUnary、events.mux/follow），
// 不发起任何网络请求，也不读取凭据。

let rpcSeq = 0;
const nextRpcId = () => `rpc_${++rpcSeq}`;
const ok = (value, rpcId = nextRpcId()) => ({ rpcId, result: { ok: true, value } });
const fail = (error, rpcId = nextRpcId()) => ({ rpcId, result: { ok: false, error } });

function defaultSummary(overrides = {}) {
  return {
    sessionId: SESSION,
    title: 'DSH 专席',
    running: false,
    blank: false,
    cwd: 'C:\\DSHW',
    agentPreset: 'room',
    projections: {
      values: {
        agentPreset: 'room',
        modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
        tokenUsage: { uncachedInputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: 0 },
      },
    },
    ...overrides,
  };
}

function createFakeDsh(options = {}) {
  const sessionId = options.sessionId ?? SESSION;
  const summary = options.summary === undefined ? defaultSummary({ sessionId }) : options.summary;
  const calls = [];
  const connections = [];
  let promptHandler = options.promptHandler ?? null;
  let unaryHandler = options.unaryHandler ?? null;
  let pumpExits = 0;
  const autoSnapshot = options.autoSnapshot !== false;
  const api = {
    clientVersion: 'dsh-fake/1.0.0',
    sessions: {
      list: async (payload) => {
        calls.push({ name: 'sessions.list', payload });
        if (options.listHandler) return options.listHandler(payload, fake);
        if (options.listError) return fail(options.listError);
        if (summary === null) return ok({ items: [] });
        return ok({ items: [summary] });
      },
      prompt: async (payload) => {
        calls.push({ name: 'sessions.prompt', payload });
        if (promptHandler) return promptHandler(payload, fake);
        return ok({ accepted: true });
      },
      create: async (payload) => {
        calls.push({ name: 'sessions.create', payload });
        if (options.createHandler) return options.createHandler(payload, fake);
        throw new Error('bridge must never create sessions');
      },
    },
    workspace: {
      archiveSession: async (payload) => {
        calls.push({ name: 'workspace.archiveSession', payload });
        throw new Error('bridge must never archive sessions');
      },
    },
    callUnary: async (method, payload) => {
      calls.push({ name: `callUnary:${method}`, payload });
      if (unaryHandler) return unaryHandler(method, payload, fake);
      if (method === 'session/projections') return ok({ asOfSeq: 0, values: { inbox: { 'next-turn': [], 'next-step': [] } } });
      if (method === 'session/cancel') return ok({ accepted: true });
      if (method === 'session/updateQueue') return ok({ accepted: true });
      return fail({ code: 'unknown-method', message: method });
    },
    events: {
      mux(_payload, signal) {
        return makeConnection(signal);
      },
      follow(id) {
        calls.push({ name: 'events.follow', payload: id });
        // 真实 DSH 在 follow 后会立刻下发开场快照；默认自动补一份空快照。
        if (autoSnapshot) {
          push({ type: 'session/snapshot', sessionId, snapshot: { records: [] } });
        }
      },
      forget(id) {
        calls.push({ name: 'events.forget', payload: id });
      },
    },
  };

  function makeConnection(signal) {
    const queue = [];
    let wake = null;
    let done = false;
    const connection = {
      ended: false,
      push(payload) {
        if (done) return;
        queue.push({ rpcId: nextRpcId(), payload });
        const resume = wake;
        wake = null;
        resume?.();
      },
      end() {
        if (done) return;
        done = true;
        connection.ended = true;
        const resume = wake;
        wake = null;
        resume?.();
      },
    };
    connections.push(connection);
    const onAbort = () => connection.end();
    signal?.addEventListener('abort', onAbort, { once: true });

    return {
      async next() {
        while (queue.length === 0 && !done) {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
        if (queue.length > 0) return { value: queue.shift(), done: false };
        connection.exited = true;
        pumpExits += 1;
        return { value: undefined, done: true };
      },
      async return() {
        signal?.removeEventListener('abort', onAbort);
        connection.end();
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  function push(payload) {
    for (const connection of connections) {
      if (!connection.ended) connection.push(payload);
    }
  }

  const fake = {
    api,
    sessionId,
    summary,
    calls,
    connections,
    pumpExits() {
      return pumpExits;
    },
    setPromptHandler(handler) {
      promptHandler = handler;
    },
    setUnaryHandler(handler) {
      unaryHandler = handler;
    },
    emitEvent(event) {
      push({ type: 'session/event', sessionId, event });
    },
    emitSnapshot(events) {
      push({
        type: 'session/snapshot',
        sessionId,
        snapshot: { records: events.map((event) => ({ type: 'event', event })) },
      });
    },
    disconnect() {
      for (const connection of connections) connection.end();
    },
    async waitForConnections(count, timeoutMs = 1000) {
      const startedAt = Date.now();
      while (connections.length < count) {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`timed out waiting for ${count} DSH connections (have ${connections.length})`);
        }
        await sleep(5);
      }
      return connections[count - 1];
    },
    callNames() {
      return calls.map((call) => call.name);
    },
    callsNamed(name) {
      return calls.filter((call) => call.name === name);
    },
    resetCalls() {
      calls.length = 0;
    },
  };
  return fake;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function withTimeout(promise, ms = 1000, label = 'operation') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function take(iterator, count, ms = 1000) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    const step = await withTimeout(iterator.next(), ms, `event #${index + 1}`);
    assert.equal(step.done, false, `expected event #${index + 1}, stream ended early`);
    events.push(step.value);
  }
  return events;
}

/** 期待在窗口内没有事件；有事件则测试失败。 */
async function expectSilence(iterator, ms = 40) {
  const step = await withTimeout(iterator.next(), ms, 'silence').catch((error) => {
    if (error.message.includes('timed out')) return { done: false, value: null, timedOut: true };
    throw error;
  });
  if (step.timedOut) return;
  assert.fail(`expected no event, got ${JSON.stringify(step.value)}`);
}

function makePacket(overrides = {}) {
  return {
    roomId: 'room_main',
    roomSeq: 1,
    turnId: 'turn_1',
    attemptId: 'attempt_1',
    seatId: SEAT,
    contextEpoch: 'epoch_1',
    text: '请回应房间。',
    ...overrides,
  };
}

function makeBridge(fake, overrides = {}) {
  return createDshBridge({
    seatId: SEAT,
    nativeSessionRef: fake.sessionId,
    api: fake.api,
    reconnectDelayMs: 5,
    snapshotReadyTimeoutMs: 1000,
    closeTimeoutMs: 500,
    ...overrides,
  });
}

async function connectedBridge(options = {}) {
  const fake = createFakeDsh(options.fake ?? {});
  const bridge = makeBridge(fake, options.bridge ?? {});
  await bridge.connect();
  await flush();
  return { bridge, fake };
}

const event = (type, data = {}) => ({ type, data });
const start = (turn) => event('turn/start', { turn });
const end = (turn, reason, extra = {}) => event('turn/end', { turn, reason, ...extra });
const completed = { kind: 'completed' };
const aborted = (why = 'user') => ({ kind: 'aborted', reason: { kind: why } });
const message = (turn, id, blocks) => event('assistant/message', {
  turn,
  message: { id, content: blocks },
});
const textBlock = (text) => ({ type: 'text', text });

function assertBridgeEventShape(bridgeEvent) {
  assert.equal(bridgeEvent.schemaVersion, 1);
  assert.match(bridgeEvent.eventId, /^be_/);
  assert.equal(bridgeEvent.seatId, SEAT);
  assert.equal(typeof bridgeEvent.occurredAt, 'string');
  assert.doesNotThrow(() => createBridgeEvent({
    type: bridgeEvent.type,
    seatId: bridgeEvent.seatId,
    attemptId: bridgeEvent.attemptId,
    payload: bridgeEvent.payload,
  }));
}

// ── 契约与方法完整性 ────────────────────────────────────────────────────────

test('the production default DSH base URL is the local web port 2955', async () => {
  assert.equal(DSH_DEFAULT_BASE_URL, 'http://127.0.0.1:2955');
  const bridge = createDshBridge({ seatId: SEAT, nativeSessionRef: SESSION });
  const api = await bridge._resolveApi({});
  assert.equal(api.baseUrl, 'http://127.0.0.1:2955');
});

test('DshBridge implements every Bridge v1 method', () => {
  const bridge = new DshBridge({ seatId: SEAT, nativeSessionRef: SESSION });
  assert.doesNotThrow(() => assertBridge(bridge));
  for (const method of BRIDGE_METHODS) {
    assert.equal(typeof bridge[method], 'function', `${method} must be callable`);
  }
  assert.equal(typeof createDshBridge, 'function');
});

test('dedupe ledger keys turns by (sessionId, turn), never by text', () => {
  const ledger = createTurnLedger();
  assert.equal(ledger.startTurn(SESSION, 1), true);
  assert.equal(ledger.startTurn(SESSION, 1), false);
  assert.equal(ledger.startTurn(SESSION, 2), true);
  assert.equal(ledger.endTurn(SESSION, 1), true);
  assert.equal(ledger.endTurn(SESSION, 1), false);
  assert.equal(ledger.hasEnded(SESSION, 1), true);
  assert.equal(ledger.isForeign(SESSION, 3), false);
  assert.equal(ledger.markForeign(SESSION, 3), true);
  assert.equal(ledger.markForeign(SESSION, 3), false);
  assert.notEqual(turnKey(SESSION, 1), turnKey(SESSION, 2));
  assert.equal(messageKeyFor({ data: { message: { id: 'm1' } } }), 'id:m1');
  assert.equal(messageKeyFor({ seq: 7, data: {} }), 'seq:7');
  assert.equal(messageKeyFor({ data: {} }), null);
});

// ── probe / connect / identity ─────────────────────────────────────────────

test('probe is read-only, reports DSH capabilities and real metadata, and never creates or archives', async () => {
  const fake = createFakeDsh();
  const bridge = makeBridge(fake);

  const probe = await bridge.probe();

  assert.equal(probe.voiceMode, 'none');
  assert.equal(probe.clientVersion, 'dsh-fake/1.0.0');
  assert.deepEqual(Object.keys(probe.capabilities), [...CAPABILITIES]);
  assert.equal(probe.capabilities.nativeSession, true);
  assert.equal(probe.capabilities.sendToExistingSession, true);
  assert.equal(probe.capabilities.finalMessageEvent, true);
  assert.equal(probe.capabilities.messageDeduplication, true);
  assert.equal(probe.capabilities.snapshotRecovery, true);
  assert.equal(probe.capabilities.foreignTurnDetection, true);
  assert.equal(probe.capabilities.queueClear, true);
  assert.equal(probe.capabilities.requestAbort, true);
  assert.equal(probe.capabilities.voiceTrigger, false);
  assert.equal(probe.capabilities.voiceStartedFinishedEvents, false);
  assert.equal(probe.capabilities.voiceStop, false);
  assert.equal(probe.capabilities.voiceMute, false);

  assert.equal(probe.identity.nativeSessionRef, SESSION);
  assert.equal(probe.identity.metadata.agentPreset, 'room');
  assert.equal(probe.identity.metadata.cwd, 'C:\\DSHW');
  assert.equal(probe.identity.metadata.model, 'deepseek-chat');
  assert.equal('body' in probe.identity.metadata, false);
  assert.equal('content' in probe.identity.metadata, false);

  assert.deepEqual(fake.callNames(), ['sessions.list']);
  const state = bridge.inspect();
  assert.equal(state.connected, false);
  assert.equal(state.attemptCount, 0);
  assert.equal(state.pendingEventCount, 0);
});

test('probe fails explicitly when the native session does not exist or has no reference', async () => {
  const missing = createFakeDsh({ summary: defaultSummary({ sessionId: 'someone_else' }) });
  const bridge = makeBridge(missing);
  await assert.rejects(bridge.probe(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });

  const noRef = createDshBridge({ seatId: SEAT, api: missing.api });
  await assert.rejects(noRef.probe(), (error) => {
    assert.equal(error.code, 'SESSION_REQUIRED');
    return true;
  });

  // connect 同样不能把 subscribe 的 ack 当成会话存在。
  const denied = makeBridge(missing);
  await assert.rejects(denied.connect(), (error) => {
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
  assert.equal(missing.callsNamed('events.follow').length, 0);
  assert.equal(denied.inspect().connected, false);
});

test('apiFactory injection is used once and then reused by connect', async () => {
  const fake = createFakeDsh();
  let factoryCalls = 0;
  const bridge = createDshBridge({
    seatId: SEAT,
    nativeSessionRef: SESSION,
    apiFactory: async () => {
      factoryCalls += 1;
      return fake.api;
    },
    reconnectDelayMs: 5,
  });

  const probe = await bridge.probe();
  assert.equal(probe.identity.nativeSessionRef, SESSION);
  assert.equal(factoryCalls, 1);

  await bridge.connect();
  assert.equal(factoryCalls, 1);
  assert.equal(bridge.inspect().connected, true);
  await bridge.close();
});

function modelSelectionSummary(modelSelection) {
  return defaultSummary({
    projections: {
      values: {
        agentPreset: 'room',
        modelSelection,
        tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0 },
      },
    },
  });
}

async function identityWithModelSelection(modelSelection) {
  const fake = createFakeDsh({ summary: modelSelectionSummary(modelSelection) });
  const bridge = makeBridge(fake);
  return bridge.getIdentity();
}

test('identity reads modelSelection.lastUsed first and keeps reasoningEffort', async () => {
  const identity = await identityWithModelSelection({
    lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    next: { provider: 'other', model: 'other-model', reasoningEffort: 'low' },
  });
  assert.equal(identity.metadata.provider, 'deepseek');
  assert.equal(identity.metadata.model, 'deepseek-chat');
  assert.equal(identity.metadata.reasoningEffort, 'high');
});

test('identity falls back to modelSelection.next when lastUsed is absent', async () => {
  const identity = await identityWithModelSelection({
    lastUsed: null,
    next: { provider: 'next-provider', model: 'next-model', reasoningEffort: 'medium' },
  });
  assert.equal(identity.metadata.provider, 'next-provider');
  assert.equal(identity.metadata.model, 'next-model');
  assert.equal(identity.metadata.reasoningEffort, 'medium');
});

test('identity still accepts the legacy flat modelSelection and omits absent reasoningEffort', async () => {
  const identity = await identityWithModelSelection({ provider: 'flat-provider', model: 'flat-model' });
  assert.equal(identity.metadata.provider, 'flat-provider');
  assert.equal(identity.metadata.model, 'flat-model');
  assert.equal('reasoningEffort' in identity.metadata, false);
});

test('identity revision is stable for equal metadata and changes with reasoningEffort', async () => {
  const shape = {
    lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    next: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
  };
  const first = await identityWithModelSelection(shape);
  const second = await identityWithModelSelection(shape);
  assert.equal(first.revision, second.revision);
  assert.deepEqual(first.metadata, second.metadata);

  const differentEffort = await identityWithModelSelection({
    lastUsed: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
  });
  assert.equal(differentEffort.metadata.model, first.metadata.model);
  assert.notEqual(differentEffort.revision, first.revision);
});

test('getIdentity is stable, hides persona bodies, and does not require send', async () => {
  const { bridge } = await connectedBridge();
  const first = await bridge.getIdentity();
  const second = await bridge.getIdentity();
  assert.deepEqual(first, second);
  assert.equal(first.sourceRef, `${SESSION}#identity`);
  assert.match(first.revision, /^[0-9a-f]{16}$/);
  assert.deepEqual(Object.keys(first.metadata).sort(), ['agentPreset', 'cwd', 'model', 'name', 'provider']);
});

test('explicit native session creation reuses cwd and preset and confirms the new id', async () => {
  const created = defaultSummary({ sessionId: 'sess_created' });
  const fake = createFakeDsh({
    createHandler: async () => ok({ sessionId: 'sess_created' }),
    listHandler: async () => ok({ items: [defaultSummary(), created] }),
  });
  const bridge = createDshBridge({ seatId: SEAT, nativeSessionRef: SESSION, api: fake.api });
  const result = await bridge.createNativeSession();
  assert.equal(result.nativeSessionRef, 'sess_created');
  assert.deepEqual(fake.callsNamed('sessions.create')[0].payload, {
    cwd: 'C:\\DSHW',
    agentPreset: 'room',
  });
  assert.ok(fake.callsNamed('sessions.list').length >= 2);
});

test('connect follows the existing session, does not create/archive, and buffers events before subscribe', async () => {
  const { bridge, fake } = await connectedBridge();
  assert.ok(fake.callsNamed('events.follow').length >= 1);
  assert.equal(fake.callsNamed('sessions.create').length, 0);
  assert.equal(fake.callsNamed('workspace.archiveSession').length, 0);

  fake.emitEvent(start(3));
  await flush();

  assert.equal(bridge.inspect().subscriberCount, 0);
  assert.equal(bridge.inspect().pendingEventCount, 1);

  const iterator = bridge.subscribe();
  const [foreign] = await take(iterator, 1);
  assert.equal(foreign.type, 'ForeignTurn');
  assert.equal(foreign.attemptId, null);
  assert.equal(foreign.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 3));
  assertBridgeEventShape(foreign);

  await iterator.return();
});

// ── send / 完成 ────────────────────────────────────────────────────────────

test('send registers the attempt before prompt; accepted is only a receipt and completion arrives as an event', async () => {
  const fake = createFakeDsh();
  // 模拟实测顺序：turn/start 比 prompt 的 HTTP 响应更早到。
  fake.setPromptHandler(() => {
    fake.emitEvent(start(1));
    return ok({ accepted: true }, 'rpc_prompt');
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();

  const iterator = bridge.subscribe();
  const receipt = await bridge.send(makePacket());

  assert.deepEqual(receipt, {
    attemptId: 'attempt_1',
    accepted: true,
    nativeRequestRef: 'rpc_prompt',
  });
  assert.equal(fake.callsNamed('sessions.prompt').length, 1);
  assert.equal(fake.callsNamed('sessions.prompt')[0].payload.sessionId, SESSION);
  assert.deepEqual(fake.callsNamed('sessions.prompt')[0].payload.content, [{ type: 'text', text: '请回应房间。' }]);

  const [started] = await take(iterator, 1);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(started.attemptId, 'attempt_1');
  assert.equal(started.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));
  assertBridgeEventShape(started);

  fake.emitEvent(message(1, 'm1', [{ type: 'reasoning', text: '思考不应进正文' }, textBlock('最终回复')]));
  // assistant/chunk 是同一内容的流式分块，必须忽略，否则正文会翻倍。
  fake.emitEvent(event('assistant/chunk', { turn: 1, text: '最终回复' }));
  fake.emitEvent(end(1, completed));

  const [finished] = await take(iterator, 1);
  assert.equal(finished.type, 'AttemptCompleted');
  assert.equal(finished.attemptId, 'attempt_1');
  assert.equal(finished.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));
  assert.equal(finished.payload.nativeMessageRef, 'm1');
  assert.equal(finished.payload.text, '最终回复');
  assert.equal('partialText' in finished.payload, false);
  assertBridgeEventShape(finished);
  assert.equal(bridge.inspect().activeAttemptId, null);

  await iterator.return();
});

test('prompt rejection is not a SendReceipt and leaves the seat usable', async () => {
  const rejecting = createFakeDsh();
  rejecting.setPromptHandler(() => fail({ code: 'agent-busy', message: 'session busy', retryable: true }));
  const local = makeBridge(rejecting);
  await local.connect();
  await flush();

  await assert.rejects(local.send(makePacket()), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'agent-busy');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(local.inspect().activeAttemptId, null);
  assert.equal(local.inspect().pendingEventCount, 0);

  // 同一个 attemptId 没有被卡死在 running；换一个 attemptId 可以继续尝试。
  await assert.rejects(local.send(makePacket({ attemptId: 'attempt_2' })), /session busy/);
  await local.close();
});

test('one seat has at most one active attempt and attempt ids cannot be reused', async () => {
  const { bridge, fake } = await connectedBridge();
  await bridge.send(makePacket());
  await assert.rejects(bridge.send(makePacket({ attemptId: 'attempt_2' })), (error) => {
    assert.equal(error.code, 'BRIDGE_BUSY');
    assert.equal(error.retryable, true);
    return true;
  });

  fake.emitEvent(start(1));
  fake.emitEvent(end(1, completed));
  await flush();

  await assert.rejects(bridge.send(makePacket()), (error) => {
    assert.equal(error.code, 'ATTEMPT_ID_REUSED');
    return true;
  });
});

test('first turn/start and text can live only in the opening snapshot', async () => {
  const { bridge, fake } = await connectedBridge();
  await bridge.send(makePacket());

  fake.emitSnapshot([
    start(1),
    message(1, 'm1', [textBlock('来自快照的正文')]),
  ]);
  await flush();
  fake.emitEvent(end(1, completed));

  const iterator = bridge.subscribe();
  const [started, finished] = await take(iterator, 2);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(started.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));
  assert.equal(finished.type, 'AttemptCompleted');
  assert.equal(finished.payload.text, '来自快照的正文');
  assert.equal(finished.payload.nativeMessageRef, 'm1');
  await iterator.return();
});

test('snapshot history that is already closed is never replayed and never becomes ForeignTurn', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  fake.emitSnapshot([
    start(0),
    message(0, 'm0', [textBlock('多年以前的回复')]),
    end(0, completed),
  ]);
  await flush();

  await expectSilence(iterator, 40);
  assert.equal(bridge.inspect().pendingEventCount, 0);
  await iterator.return();
});

test('reconnect rebuilds only open turns and does not duplicate snapshot text', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  fake.emitEvent(start(1));
  fake.emitEvent(message(1, 'm1', [textBlock('前半')]));
  await flush();

  fake.disconnect();
  const [, disconnected] = await take(iterator, 2);
  assert.equal(disconnected.type, 'BridgeError');
  assert.equal(disconnected.payload.error.code, 'STREAM_DISCONNECTED');
  assert.equal(disconnected.payload.error.retryable, true);

  await fake.waitForConnections(2);
  fake.emitSnapshot([
    start(1),
    message(1, 'm1', [textBlock('前半')]),
    start(0),
    message(0, 'm0', [textBlock('更早的历史')]),
    end(0, completed),
  ]);
  await flush();
  fake.emitEvent(message(1, 'm2', [textBlock('后半')]));
  fake.emitEvent(end(1, completed));

  const [finished] = await take(iterator, 1);
  assert.equal(finished.type, 'AttemptCompleted');
  assert.equal(finished.payload.text, '前半后半');
  assert.equal(finished.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));
  assert.equal(bridge.inspect().openCollectorTurns, 0);
  await iterator.return();
});

test('opening recovery snapshot with old completed history and the new attempt only settles the new turn', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  // 发送前的历史：turn 1 已 completed，属于机主/更早的会话历史。
  fake.emitSnapshot([
    start(1),
    message(1, 'old_m', [textBlock('旧历史正文')]),
    end(1, completed),
  ]);
  await flush();
  assert.equal(bridge.inspect().latestTurn, 1);

  await bridge.send(makePacket());
  fake.disconnect();
  await fake.waitForConnections(2);

  // 重连的开场快照同时含旧历史与本次 attempt 的新 turn。
  fake.emitSnapshot([
    start(1),
    message(1, 'old_m', [textBlock('旧历史正文')]),
    end(1, completed),
    start(2),
    message(2, 'new_m', [textBlock('本次回复')]),
    end(2, completed),
  ]);
  await flush();

  const events = await take(iterator, 3);
  assert.deepEqual(events.map((item) => item.type), [
    'BridgeError',
    'AttemptStarted',
    'AttemptCompleted',
  ]);
  assert.equal(events[1].payload.nativeTurnRef, nativeTurnRefFor(SESSION, 2));
  assert.equal(events[2].payload.text, '本次回复');
  assert.equal(events[2].payload.nativeMessageRef, 'new_m');
  assert.equal(events.some((item) => item.type === 'ForeignTurn'), false);
  await expectSilence(iterator, 40);
  await iterator.return();
});

test('bound turn recovered from a reconnect snapshot is rebuilt from snapshot text and settles exactly once', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  fake.emitEvent(start(1));
  fake.emitEvent(message(1, 'm1', [textBlock('断线前的半句')]));
  await flush();

  fake.disconnect();
  await fake.waitForConnections(2);

  const recovery = [
    start(1),
    message(1, 'm1', [textBlock('快照里的完整正文')]),
    end(1, completed),
  ];
  fake.emitSnapshot(recovery);

  const events = await take(iterator, 3);
  assert.deepEqual(events.map((item) => item.type), [
    'AttemptStarted',
    'BridgeError',
    'AttemptCompleted',
  ]);
  assert.equal(events[2].payload.text, '快照里的完整正文');
  assert.equal(events[2].payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));

  // 重复快照、重复 live 消息、重复 turn/end 都不得重复正文或终态。
  fake.emitSnapshot(recovery);
  fake.emitEvent(message(1, 'm1', [textBlock('快照里的完整正文')]));
  fake.emitEvent(end(1, completed));
  await flush();
  await expectSilence(iterator, 40);
  await iterator.return();
});

test('pending attempt that completed while disconnected is recovered from the reconnect snapshot', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  fake.disconnect();
  await fake.waitForConnections(2);

  fake.emitSnapshot([
    start(1),
    message(1, 'm1', [textBlock('断线期间完成的回复')]),
    end(1, completed),
  ]);

  const events = await take(iterator, 3);
  assert.deepEqual(events.map((item) => item.type), [
    'BridgeError',
    'AttemptStarted',
    'AttemptCompleted',
  ]);
  assert.equal(events[1].payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));
  assert.equal(events[2].payload.text, '断线期间完成的回复');
  await iterator.return();
});

test('aborted and failed turns are recovered across disconnects', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.disconnect();
  await fake.waitForConnections(2);
  fake.emitSnapshot([
    start(1),
    message(1, 'm1', [textBlock('取消前已生成的部分')]),
    end(1, aborted('user')),
  ]);

  const first = await take(iterator, 3);
  assert.deepEqual(first.map((item) => item.type), [
    'BridgeError',
    'AttemptStarted',
    'AttemptAborted',
  ]);
  assert.equal(first[2].payload.partialText, '取消前已生成的部分');

  await bridge.send(makePacket({ attemptId: 'attempt_2' }));
  fake.disconnect();
  await fake.waitForConnections(3);
  fake.emitSnapshot([
    start(2),
    end(2, { kind: 'error' }, {
      error: { code: 'UPSTREAM_500', message: 'provider failed', retryable: true },
    }),
  ]);

  const second = await take(iterator, 3);
  assert.deepEqual(second.map((item) => item.type), [
    'BridgeError',
    'AttemptStarted',
    'AttemptFailed',
  ]);
  assert.equal(second[2].payload.error.code, 'UPSTREAM_500');
  assert.equal(second[2].payload.nativeTurnRef, nativeTurnRefFor(SESSION, 2));
  await iterator.return();
});

test('send waits for the opening snapshot baseline and never prompts early', async () => {
  const fake = createFakeDsh({ autoSnapshot: false });
  const bridge = makeBridge(fake);

  const connectPromise = bridge.connect();
  await fake.waitForConnections(1);

  const sendPromise = bridge.send(makePacket());
  await flush();
  assert.equal(fake.callsNamed('sessions.prompt').length, 0, 'prompt must wait for the baseline');

  fake.emitSnapshot([]);
  await connectPromise;
  const receipt = await sendPromise;

  assert.equal(receipt.accepted, true);
  assert.equal(fake.callsNamed('sessions.prompt').length, 1);
  assert.equal(bridge.inspect().baselineSettled, true);
  await bridge.close();
});

test('close awaits the event pump exit and leaves no background work', async () => {
  const { bridge, fake } = await connectedBridge();
  assert.equal(fake.pumpExits(), 0);
  assert.equal(bridge.inspect().pumpRunning, true);

  await bridge.close();
  await bridge.close();

  assert.ok(fake.pumpExits() >= 1, 'fake pump must report that it exited');
  assert.equal(bridge.inspect().pumpRunning, false);
  assert.ok(fake.connections[0].ended, 'event stream must be aborted');
});

test('duplicate native events deliver exactly one start and one completion, and never double text', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  fake.emitEvent(start(1));
  fake.emitEvent(start(1));
  fake.emitEvent(message(1, 'm1', [textBlock('只说一次')]));
  fake.emitEvent(message(1, 'm1', [textBlock('只说一次')]));
  fake.emitEvent(end(1, completed));
  fake.emitEvent(end(1, completed));
  await flush();

  const [started, finished] = await take(iterator, 2);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(finished.type, 'AttemptCompleted');
  assert.equal(finished.payload.text, '只说一次');
  await expectSilence(iterator, 40);
  await iterator.return();
});

test('same text on different turns is delivered twice; dedupe is by (sessionId, turn)', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1', turnId: 'turn_1' }));
  fake.emitEvent(start(1));
  fake.emitEvent(message(1, 'm1', [textBlock('同样的话')]));
  fake.emitEvent(end(1, completed));
  await flush();

  await bridge.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' }));
  fake.emitEvent(start(2));
  fake.emitEvent(message(2, 'm2', [textBlock('同样的话')]));
  fake.emitEvent(end(2, completed));

  const events = await take(iterator, 4);
  assert.deepEqual(events.map((item) => item.type), [
    'AttemptStarted',
    'AttemptCompleted',
    'AttemptStarted',
    'AttemptCompleted',
  ]);
  assert.equal(events[1].payload.text, '同样的话');
  assert.equal(events[3].payload.text, '同样的话');
  assert.notEqual(events[1].payload.nativeTurnRef, events[3].payload.nativeTurnRef);
  await iterator.return();
});

test('a turn without a pending attempt is ForeignTurn only, never subtitles', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  fake.emitEvent(start(9));
  fake.emitEvent(message(9, 'owner_m1', [textBlock('机主在 GUI 里的手工聊天')]));
  fake.emitEvent(end(9, completed));
  await flush();

  const [foreign] = await take(iterator, 1);
  assert.equal(foreign.type, 'ForeignTurn');
  assert.equal(foreign.attemptId, null);
  assert.deepEqual(foreign.payload, {
    nativeTurnRef: nativeTurnRefFor(SESSION, 9),
    reason: 'foreign-turn',
  });
  await expectSilence(iterator, 40);
  assert.equal(bridge.inspect().attemptCount, 0);
  await iterator.return();
});

test('aborted turn yields AttemptAborted with partialText and no subtitle text', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emitEvent(start(1));
  fake.emitEvent(message(1, 'm1', [textBlock('生成到一半的正文')]));
  fake.emitEvent(end(1, aborted('user')));

  const [started, stopped] = await take(iterator, 2);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(stopped.type, 'AttemptAborted');
  assert.equal(stopped.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));
  assert.equal(stopped.payload.partialText, '生成到一半的正文');
  assert.equal('text' in stopped.payload, false);
  assertBridgeEventShape(stopped);
  assert.equal(bridge.inspect().activeAttemptId, null);
  await iterator.return();
});

test('turn/end without a completed or aborted reason yields AttemptFailed', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emitEvent(start(1));
  fake.emitEvent(end(1, { kind: 'error' }, {
    error: { code: 'UPSTREAM_500', message: 'provider failed', retryable: true },
  }));

  const [, failed] = await take(iterator, 2);
  assert.equal(failed.type, 'AttemptFailed');
  assert.deepEqual(failed.payload.error, {
    code: 'UPSTREAM_500',
    message: 'provider failed',
    retryable: true,
  });
  assert.equal(failed.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 1));
  assert.equal(bridge.inspect().activeAttemptId, null);
  await iterator.return();
});

// ── 取消 ────────────────────────────────────────────────────────────────────

function inboxResponse(items) {
  return ok({
    asOfSeq: 3,
    values: {
      inbox: {
        'next-turn': items.filter((item) => item.boundary === 'turn').map((item) => ({ id: item.id })),
        'next-step': items.filter((item) => item.boundary === 'step').map((item) => ({ id: item.id })),
      },
    },
  });
}

test('cancel clears inbox item-by-item before session/cancel, and final aborted comes from events', async () => {
  const fake = createFakeDsh();
  fake.setUnaryHandler((method) => {
    if (method === 'session/projections') {
      return inboxResponse([
        { id: 'q1', boundary: 'turn' },
        { id: 'q2', boundary: 'turn' },
        { id: 'q2', boundary: 'step' },
      ]);
    }
    if (method === 'session/updateQueue') return ok({ accepted: true });
    if (method === 'session/cancel') return ok({ accepted: true });
    return fail({ code: 'unknown-method', message: method });
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();

  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emitEvent(start(1));
  await flush();

  fake.resetCalls();
  const receipt = await bridge.cancel('attempt_1');
  assert.deepEqual(receipt, {
    attemptId: 'attempt_1',
    accepted: true,
    settlement: 'pending',
    nativeTurnRef: nativeTurnRefFor(SESSION, 1),
  });

  assert.deepEqual(fake.callNames(), [
    'callUnary:session/projections',
    'callUnary:session/updateQueue',
    'callUnary:session/updateQueue',
    'callUnary:session/cancel',
  ]);
  const removals = fake.callsNamed('callUnary:session/updateQueue');
  assert.deepEqual(removals.map((call) => call.payload.itemId), ['q1', 'q2']);
  assert.ok(removals.every((call) => call.payload.action.kind === 'remove'));

  // RPC 被接受不等于 attempt 已终结；最终状态必须由 turn/end 确认。
  fake.emitEvent(end(1, aborted('user')));
  const [, stopped] = await take(iterator, 2);
  assert.equal(stopped.type, 'AttemptAborted');

  const afterEvent = await bridge.cancel('attempt_1');
  assert.deepEqual(afterEvent, {
    attemptId: 'attempt_1',
    accepted: true,
    settlement: 'confirmed',
    nativeTurnRef: nativeTurnRefFor(SESSION, 1),
  });
  await iterator.return();
});

test('cancel is idempotent while running and reuses the same receipt without extra RPCs', async () => {
  const fake = createFakeDsh();
  const local = makeBridge(fake);
  await local.connect();
  await flush();
  await local.send(makePacket());
  fake.emitEvent(start(1));
  await flush();

  fake.resetCalls();
  const first = await local.cancel('attempt_1');
  const second = await local.cancel('attempt_1');
  assert.deepEqual(second, first);
  assert.equal(first.settlement, 'pending');
  assert.equal(fake.callsNamed('callUnary:session/cancel').length, 1);
  assert.equal(fake.callsNamed('callUnary:session/projections').length, 1);

  fake.emitEvent(end(1, aborted('user')));
  await flush();
  const third = await local.cancel('attempt_1');
  assert.equal(third.settlement, 'confirmed');
  assert.equal(fake.callsNamed('callUnary:session/cancel').length, 1);
  await local.close();
});

test('cancel reports unknown and already-finished attempts without emitting events', async () => {
  const { bridge, fake } = await connectedBridge();
  const unknown = await bridge.cancel('missing_attempt');
  assert.deepEqual(unknown, {
    attemptId: 'missing_attempt',
    accepted: false,
    settlement: 'failed',
    error: { code: 'ATTEMPT_NOT_FOUND', message: 'Unknown attempt: missing_attempt', retryable: false },
  });

  await bridge.send(makePacket());
  fake.emitEvent(start(1));
  fake.emitEvent(end(1, completed));
  await flush();

  const finished = await bridge.cancel('attempt_1');
  assert.equal(finished.accepted, false);
  assert.equal(finished.settlement, 'failed');
  assert.equal(finished.error.code, 'ATTEMPT_ALREADY_FINISHED');
});

// ── 语音 / close ───────────────────────────────────────────────────────────

test('DSH bridge has no voice: setMuted is unsupported and no Speech events are ever emitted', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  const muted = await bridge.setMuted(true);
  assert.deepEqual(muted, { supported: false, capability: 'voiceMute' });
  assert.deepEqual(await bridge.setMuted(false), { supported: false, capability: 'voiceMute' });

  const probe = await bridge.probe();
  assert.equal(probe.voiceMode, 'none');
  for (const key of ['voiceTrigger', 'voiceStartedFinishedEvents', 'voiceStop', 'voiceMute']) {
    assert.equal(probe.capabilities[key], false);
  }

  await bridge.send(makePacket());
  fake.emitEvent(start(1));
  fake.emitEvent(message(1, 'm1', [textBlock('纯文本')]));
  fake.emitEvent(end(1, completed));

  const events = await take(iterator, 2);
  assert.deepEqual(events.map((item) => item.type), ['AttemptStarted', 'AttemptCompleted']);
  await expectSilence(iterator, 40);
  assert.ok(events.every((item) => !/^Speech/.test(item.type)));
  assert.equal(bridge.inspect().activeAttemptId, null);
  await iterator.return();
  await bridge.close();
});

test('close is idempotent, settles waiting subscribers, stops the pump, and never archives', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  const pending = iterator.next();

  await bridge.close();
  await bridge.close();

  const closed = await withTimeout(pending, 500, 'BridgeClosed');
  assert.equal(closed.done, false);
  assert.equal(closed.value.type, 'BridgeClosed');
  assert.deepEqual(closed.value.payload, { reason: 'closed' });
  assertBridgeEventShape(closed.value);

  assert.deepEqual(await withTimeout(iterator.next(), 500, 'iterator end'), { value: undefined, done: true });
  assert.equal(bridge.inspect().closed, true);
  assert.equal(bridge.inspect().connected, false);
  assert.equal(bridge.inspect().sessionRef, SESSION);
  assert.equal(fake.callsNamed('workspace.archiveSession').length, 0);
  assert.equal(fake.callsNamed('sessions.create').length, 0);
  assert.ok(fake.connections[0].ended, 'event stream should be aborted on close');

  await assert.rejects(bridge.send(makePacket({ attemptId: 'attempt_after_close' })), (error) => {
    assert.equal(error.code, 'BRIDGE_CLOSED');
    return true;
  });
});
