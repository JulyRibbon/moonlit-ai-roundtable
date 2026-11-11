import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_METHODS, CAPABILITIES, BridgeError, assertBridge } from '../../adapters/contract.mjs';
import {
  ZCodeBridge,
  createZCodeBridge,
  nativeTurnRefFor,
  normalizeRuntimePreferences,
} from '../../adapters/zcode/bridge.mjs';
import {
  DEFAULT_ZCODE_CLI,
  DEFAULT_ZCODE_EXE,
  ZCODE_DEFAULT_RUNTIME_PREFERENCES,
  ZCODE_KNOWN_CLI_VERSION,
  ZCODE_PROTOCOL_VERSION,
  ZCodeAppServerClient,
  createZCodeClient,
  redact,
  zcodeBaseEnv,
} from '../../adapters/zcode/client.mjs';
import { createBridgeEvent } from '../../core/events.mjs';

const SEAT = 'zcode';
const SESSION = 'sess_test_0001';
const SECRET = 'sk-live-this-must-never-leak';

// ── 离线 fake transport ─────────────────────────────────────────────────────
// 只模拟 ZCode app-server 的 NDJSON 请求/通知与恢复快照。
// 不 spawn 任何进程、不读 provider 配置、不调用模型。

function defaultSession(overrides = {}) {
  return {
    sessionId: SESSION,
    sessionKind: 'session',
    mode: 'build',
    status: 'idle',
    title: 'ZCode 专席',
    workspace: { workspaceKey: 'ws_main', workspacePath: 'C:\\KIMIW' },
    model: 'glm-4.6',
    updatedAt: 1762560000000,
    ...overrides,
  };
}

function createFakeZCode(options = {}) {
  const state = {
    sessionId: options.sessionId ?? SESSION,
    session: options.session ?? defaultSession(),
    sessions: options.sessions ?? null,
    resumeResult: options.resumeResult ?? { snapshot: { seq: 0, events: [], messages: [] } },
    subscribeResult: options.subscribeResult ?? {},
    eventsResult: options.eventsResult ?? { events: [], lastSeq: 0 },
    messagesResult: options.messagesResult ?? { messages: [] },
    sendHandler: options.sendHandler ?? null,
    stopHandler: options.stopHandler ?? null,
    resumeHandler: options.resumeHandler ?? null,
    subscribeHandler: options.subscribeHandler ?? null,
    listHandler: options.listHandler ?? null,
    failAt: options.failAt ?? null,
    clientVersion: options.clientVersion ?? ZCODE_KNOWN_CLI_VERSION,
    protocolVersion: options.protocolVersion ?? 1,
    envelopeShape: options.envelopeShape ?? 'result',
  };

  let seq = options.startSeq ?? 0;
  let serverRequestId = 0;
  const calls = [];
  const listeners = new Set();

  function emitEvent(event) {
    client.onNotification?.({ method: 'session/event', params: { sessionId: state.sessionId, event } });
  }

  const client = {
    sessionId: state.sessionId,
    started: false,
    dead: false,
    closeCount: 0,
    calls,
    serverReplies: [],
    onNotification: null,
    onServerRequest: null,
    onExit: null,

    get clientVersion() {
      return state.clientVersion;
    },
    set clientVersion(value) {
      state.clientVersion = value;
    },
    get protocolVersion() {
      return state.protocolVersion;
    },
    set protocolVersion(value) {
      state.protocolVersion = value;
    },
    get envelopeShape() {
      return state.envelopeShape;
    },

    async start() {
      this.started = true;
      this.dead = false;
      return this;
    },

    async restart() {
      this.started = true;
      this.dead = false;
      return this;
    },

    async close() {
      this.closeCount += 1;
      this.started = false;
      this.dead = true;
      return { exited: true, killed: false, code: 0, signal: null };
    },

    disconnect() {
      this.started = false;
      this.dead = true;
      this.onExit?.({ code: 1, signal: null });
    },

    async request(method, params = {}) {
      calls.push({ method, params: structuredClone(params) });

      if (state.failAt && state.failAt.method === method) {
        throw Object.assign(new Error(state.failAt.message ?? `${method} failed`), {
          code: state.failAt.code ?? 'RPC_FAILED',
        });
      }

      if (method === 'session/list') {
        if (state.listHandler) return state.listHandler({ params, client: fake });
        const sessions = state.sessions ?? [state.session];
        return { sessions, protocolVersion: state.protocolVersion };
      }

      if (method === 'session/create') {
        if (options.newSessionHandler) return options.newSessionHandler({ params, client: fake });
        return { sessionId: 'sess_created' };
      }

      if (method === 'session/resume') {
        if (state.resumeHandler) return state.resumeHandler({ params, client: fake });
        return structuredClone(state.resumeResult);
      }

      if (method === 'session/subscribe') {
        if (state.subscribeHandler) return state.subscribeHandler({ params, client: fake });
        return structuredClone(state.subscribeResult);
      }

      if (method === 'session/send') {
        if (state.sendHandler) return state.sendHandler({ params, client: fake });
        return { accepted: true, inputId: params.inputId };
      }

      if (method === 'session/stop') {
        if (state.stopHandler) return state.stopHandler({ params, client: fake });
        return { stopped: true };
      }

      if (method === 'session/events') {
        return typeof state.eventsResult === 'function'
          ? state.eventsResult({ params, client: fake })
          : structuredClone(state.eventsResult);
      }

      if (method === 'session/messages') {
        return typeof state.messagesResult === 'function'
          ? state.messagesResult({ params, client: fake })
          : structuredClone(state.messagesResult);
      }

      if (method === 'session/unsubscribe') return { ok: true };

      return {};
    },

    async requestFromServer(method, params = {}) {
      serverRequestId += 1;
      const id = `server-${serverRequestId}`;
      const handled = this.onServerRequest
        ? await this.onServerRequest({ id, method, params })
        : null;
      let reply;
      if (handled && typeof handled === 'object' && ('result' in handled || 'error' in handled)) {
        reply = { id, ...handled };
      } else if (handled !== undefined && handled !== null) {
        reply = { id, result: handled };
      } else {
        reply = { id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
      this.serverReplies.push({ id, method, params, reply });
      return reply;
    },

    emit(type, payload = {}, extra = {}) {
      seq += 1;
      const event = {
        eventId: extra.eventId ?? `evt_${seq}`,
        seq: extra.seq ?? seq,
        type,
        payload,
        ...extra,
      };
      emitEvent(event);
      return event;
    },

    emitEvent(event) {
      emitEvent(event);
    },

    emitSnapshot(snapshot) {
      client.onNotification?.({
        method: 'session/snapshot',
        params: { sessionId: state.sessionId, snapshot },
      });
    },

    callsOf(method) {
      return calls.filter((call) => call.method === method);
    },

    setResumeResult(value) {
      state.resumeResult = value;
    },
    setSubscribeResult(value) {
      state.subscribeResult = value;
    },
    setEventsResult(value) {
      state.eventsResult = value;
    },
    setMessagesResult(value) {
      state.messagesResult = value;
    },
    setSendHandler(value) {
      state.sendHandler = value;
    },
    setStopHandler(value) {
      state.stopHandler = value;
    },
    setResumeHandler(value) {
      state.resumeHandler = value;
    },
  };

  // 让 fake.emitSnapshot / emitEvent 直接复用 Bridge 挂上的 handler。
  const originalAttach = () => {};
  const fake = Object.assign(client, {
    _listeners: listeners,
    _attach: originalAttach,
    get state() {
      return state;
    },
    emitToBridge(message) {
      client.onNotification?.(message);
    },
  });

  return fake;
}

// ── 测试工具 ────────────────────────────────────────────────────────────────

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

async function nextEvent(iterator, ms = 1000) {
  const step = await withTimeout(iterator.next(), ms, 'event');
  assert.equal(step.done, false, 'event stream ended early');
  return step.value;
}

async function takeEvents(iterator, count, ms = 1000) {
  const events = [];
  for (let index = 0; index < count; index += 1) events.push(await nextEvent(iterator, ms));
  return events;
}

async function takeUntil(iterator, predicate, { max = 20, ms = 2000 } = {}) {
  const events = [];
  while (events.length < max) {
    const event = await nextEvent(iterator, ms);
    events.push(event);
    if (predicate(event)) return events;
  }
  assert.fail('event condition was not met');
}

async function expectSilence(iterator, ms = 80) {
  const step = await withTimeout(iterator.next(), ms, 'silence').catch((error) => {
    if (error.message.includes('timed out')) return { timedOut: true };
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
  return createZCodeBridge({
    seatId: SEAT,
    nativeSessionRef: SESSION,
    client: fake,
    autoReconnect: false,
    baselineTimeoutMs: 250,
    requestTimeoutMs: 1000,
    closeTimeoutMs: 300,
    reconcileAttempts: 1,
    reconcileRetryDelayMs: 0,
    ...overrides,
  });
}

async function connectedBridge(fakeOptions = {}, bridgeOptions = {}) {
  const fake = createFakeZCode(fakeOptions);
  const bridge = makeBridge(fake, bridgeOptions);
  await bridge.connect();
  await flush();
  return { bridge, fake };
}

function assertBridgeEventShape(event) {
  assert.equal(event.schemaVersion, 1);
  assert.match(event.eventId, /^be_/);
  assert.equal(event.seatId, SEAT);
  assert.equal(typeof event.occurredAt, 'string');
  assert.doesNotThrow(() => createBridgeEvent({
    type: event.type,
    seatId: event.seatId,
    attemptId: event.attemptId,
    payload: event.payload,
  }));
}

const startedPayload = (inputId, turnId) => ({ inputId, turnId });
const completedPayload = (inputId, turnId, response, extra = {}) => ({
  inputId,
  turnId,
  resultType: 'success',
  response,
  ...extra,
});

// ── 契约与方法完整性 ────────────────────────────────────────────────────────

test('the ZCode client answers server-initiated requests before matching client responses', async () => {
  const client = new ZCodeAppServerClient();
  const written = [];
  client.child = {
    stdin: {
      write(line) {
        written.push(JSON.parse(line));
      },
    },
  };

  const reply = await client._dispatch({
    id: 'server-1',
    method: 'session/requestRuntimePreferences',
    params: { sessionId: SESSION, scope: 'runtime-materialization' },
  });

  assert.deepEqual(reply.result, { ...ZCODE_DEFAULT_RUNTIME_PREFERENCES });
  assert.deepEqual(written[0], {
    id: 'server-1',
    result: { ...ZCODE_DEFAULT_RUNTIME_PREFERENCES },
  });
  assert.equal(client.pending.size, 0, 'a server request is not mistaken for a response');

  const unknown = await client._dispatch({
    id: 'server-2',
    method: 'session/unknownRequest',
    params: {},
  });
  assert.deepEqual(unknown, {
    id: 'server-2',
    error: { code: -32601, message: 'Method not found: session/unknownRequest' },
  });

  // 同名 id 与客户端 pending 响应冲突时，仍按服务端请求处理。
  let pendingResolved = false;
  client.pending.set(7, {
    resolve: () => { pendingResolved = true; },
    reject: () => {},
    timer: setTimeout(() => {}, 10),
    method: 'session/list',
  });
  await client._dispatch({ id: 7, method: 'session/unknownRequest', params: {} });
  assert.equal(pendingResolved, false);
  assert.equal(client.pending.has(7), true);
  clearTimeout(client.pending.get(7).timer);
  client.pending.clear();
});

test('the production ZCode client exposes the real app-server entry without spawning', () => {
  const client = new ZCodeAppServerClient();
  assert.equal(client.exe, DEFAULT_ZCODE_EXE);
  assert.equal(client.cli, DEFAULT_ZCODE_CLI);
  assert.equal(client.surface, 'desktop');
  assert.equal(client.started, false);
  assert.equal(client.dead, false);
  assert.equal(createZCodeClient() instanceof ZCodeAppServerClient, true);

  const env = zcodeBaseEnv({ AIROOM_TEST: 'yes' });
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(env.AIROOM_TEST, 'yes');

  assert.equal(redact(`Bearer ${SECRET}`), 'Bearer ***');
  assert.equal(redact(`token ${SECRET}`).includes(SECRET), false);
});

test('ZCodeBridge implements every Bridge v1 method and accepts an injected client', () => {
  const fake = createFakeZCode();
  const bridge = new ZCodeBridge({ seatId: SEAT, nativeSessionRef: SESSION, client: fake });
  assert.doesNotThrow(() => assertBridge(bridge));
  for (const method of BRIDGE_METHODS) {
    assert.equal(typeof bridge[method], 'function', `${method} must be callable`);
  }
  assert.equal(typeof createZCodeBridge, 'function');
});

test('the ZCode capability surface is normalized and announces external voice', async () => {
  const fake = createFakeZCode();
  const bridge = makeBridge(fake);
  const result = await bridge.probe();

  assert.deepEqual(Object.keys(result.capabilities), [...CAPABILITIES]);
  assert.equal(result.capabilities.nativeSession, true);
  assert.equal(result.capabilities.nativeIdentity, true);
  assert.equal(result.capabilities.sendToExistingSession, true);
  assert.equal(result.capabilities.finalMessageEvent, true);
  assert.equal(result.capabilities.messageDeduplication, true);
  assert.equal(result.capabilities.snapshotRecovery, true);
  assert.equal(result.capabilities.foreignTurnDetection, true);
  assert.equal(result.capabilities.requestAbort, true);
  assert.equal(result.capabilities.providerUsage, true);
  assert.equal(result.capabilities.queueClear, false);
  assert.equal(result.capabilities.voiceTrigger, false);
  assert.equal(result.capabilities.voiceStartedFinishedEvents, false);
  assert.equal(result.capabilities.voiceStop, false);
  assert.equal(result.capabilities.voiceMute, false);
  assert.equal(result.voiceMode, 'external');
  assert.deepEqual(result.warnings, []);
});

// ── 只读 probe ──────────────────────────────────────────────────────────────

test('probe is read-only: only session/list, no resume/send/stop/close, no model call', async () => {
  const fake = createFakeZCode({
    session: defaultSession({
      agentsMd: 'DO NOT COPY THIS PERSONA',
      systemPrompt: 'SYSTEM PERSONA BODY',
      persona: 'persona body',
    }),
  });
  const bridge = makeBridge(fake);

  const result = await bridge.probe();

  assert.deepEqual(fake.calls.map((call) => call.method), ['session/list']);
  assert.equal(fake.calls[0].params.limit > 0, true);
  assert.equal(fake.calls.some((call) => /resume|send|stop|close|create|fork|archive/.test(call.method)), false);
  assert.equal(fake.closeCount, 0, 'injected client is owned by the caller');

  assert.equal(result.clientVersion, ZCODE_KNOWN_CLI_VERSION);
  assert.equal(result.identity.nativeSessionRef, SESSION);
  assert.equal(result.identity.metadata.sessionId, SESSION);
  assert.equal(result.identity.metadata.workspace, 'C:\\KIMIW');
  assert.equal(result.identity.metadata.model, 'glm-4.6');
  assert.equal(result.identity.metadata.mode, 'build');
  assert.equal(result.identity.metadata.status, 'idle');

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('DO NOT COPY THIS PERSONA'), false);
  assert.equal(serialized.includes('SYSTEM PERSONA BODY'), false);
  assert.equal(serialized.includes('persona body'), false);
  assert.equal(serialized.includes('agentsMd'), false);
});

test('probe warns on version, protocol and session-id drift without guessing', async () => {
  const fake = createFakeZCode({
    sessionId: 'session_without_prefix',
    session: defaultSession({ sessionId: 'session_without_prefix' }),
    clientVersion: '0.18.0',
    protocolVersion: 2,
    envelopeShape: 'ok-value',
  });
  const bridge = createZCodeBridge({
    seatId: SEAT,
    nativeSessionRef: 'session_without_prefix',
    client: fake,
  });

  const result = await bridge.probe();
  assert.equal(result.clientVersion, '0.18.0');
  assert.deepEqual(
    result.warnings.sort(),
    [
      'zcode-protocol-envelope-drift',
      'zcode-protocol-version-drift',
      'zcode-session-id-shape-changed',
      'zcode-version-drift',
    ].sort(),
  );
});

test('probe rejects a missing session and never creates one', async () => {
  const fake = createFakeZCode({ sessions: [] });
  const bridge = makeBridge(fake);
  await assert.rejects(bridge.probe(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
  assert.deepEqual(fake.calls.map((call) => call.method), ['session/list']);
});

test('probe without nativeSessionRef is rejected before any RPC', async () => {
  const fake = createFakeZCode();
  const bridge = createZCodeBridge({ seatId: SEAT, client: fake });
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.code, 'SESSION_REQUIRED');
    return true;
  });
  assert.equal(fake.calls.length, 0);
});

// ── 连接与身份 ──────────────────────────────────────────────────────────────

test('connect confirms the session, resumes it read-only, and subscribes with an explicit baseline', async () => {
  const fake = createFakeZCode({
    resumeResult: { snapshot: { seq: 7, events: [], messages: [] } },
  });
  const bridge = makeBridge(fake);

  await bridge.connect();
  await flush();

  const methods = fake.calls.map((call) => call.method);
  assert.deepEqual(methods, ['session/list', 'session/resume', 'session/subscribe']);

  const resume = fake.callsOf('session/resume')[0];
  assert.deepEqual(resume.params, { sessionId: SESSION });

  const subscribe = fake.callsOf('session/subscribe')[0];
  assert.deepEqual(subscribe.params, {
    sessionId: SESSION,
    deliveryKind: 'desktop-continuous',
    afterSeq: 7,
    includeSnapshot: true,
  });

  const forbidden = /create|fork|archive|close|workspace|model|thought|mode/;
  assert.equal(fake.calls.some((call) => forbidden.test(call.method)), false);
  assert.equal(fake.calls.some((call) => call.params.workspace !== undefined), false);
  assert.equal(fake.calls.some((call) => call.params.modelSelection !== undefined), false);
  assert.equal(fake.calls.some((call) => call.params.thoughtLevel !== undefined), false);
  assert.equal(fake.calls.some((call) => call.params.mode !== undefined), false);
});

test('connect buffers events that arrive before subscribe and replays them in order', async () => {
  let fake;
  fake = createFakeZCode({
    resumeHandler: ({ client }) => {
      client.emit('turn.started', startedPayload('foreign_buffered', 'turn_buffered'));
      return { snapshot: { seq: 3, events: [], messages: [] } };
    },
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();

  const [event] = await takeEvents(bridge.subscribe(), 1);
  assert.equal(event.type, 'ForeignTurn');
  assert.equal(event.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 'turn_buffered'));
  assert.equal(event.payload.reason, 'no-pending-attempt');
});

test('connect answers both runtime-preference scopes and never changes workspace/model/thoughtLevel/mode', async () => {
  const seen = [];
  const fake = createFakeZCode({
    resumeHandler: async ({ client }) => {
      for (const scope of ['runtime-materialization', 'user-execution']) {
        seen.push(await client.requestFromServer('session/requestRuntimePreferences', {
          sessionId: SESSION,
          scope,
        }));
      }
      return { snapshot: { seq: 4, events: [], messages: [] } };
    },
  });
  const bridge = makeBridge(fake, {
    runtimePreferences: {
      memoryEnabled: true,
      // 以下字段不属于运行时偏好，必须被忽略。
      workspace: { workspacePath: 'C:\\WRONG' },
      modelSelection: { model: 'wrong-model' },
      thoughtLevel: 'high',
      mode: 'plan',
    },
  });

  await bridge.connect();

  assert.equal(seen.length, 2);
  for (const reply of seen) {
    assert.deepEqual(reply.result, {
      ...ZCODE_DEFAULT_RUNTIME_PREFERENCES,
      memoryEnabled: true,
    });
    assert.deepEqual(Object.keys(reply.result).sort(), [
      'askUserQuestionAutoResolutionEnabled',
      'memoryEnabled',
      'modelContextBudgetStrategy',
      'nativeSearchEnhancementsEnabled',
      'toolSearchMode',
    ]);
  }
  assert.equal(JSON.stringify(seen).includes('WRONG'), false);
  assert.equal(JSON.stringify(seen).includes('wrong-model'), false);
  assert.equal(JSON.stringify(seen).includes('thoughtLevel'), false);
  assert.equal(fake.callsOf('session/resume').length, 1);
});

test('an unknown server request gets JSON-RPC -32601 so the app-server can fall back', async () => {
  let reply = null;
  const fake = createFakeZCode({
    resumeHandler: async ({ client }) => {
      reply = await client.requestFromServer('session/unknownRequest', { sessionId: SESSION });
      return { snapshot: { seq: 2, events: [], messages: [] } };
    },
  });
  const bridge = makeBridge(fake);
  await bridge.connect();

  assert.deepEqual(reply.error, {
    code: -32601,
    message: 'Method not found: session/unknownRequest',
  });
  assert.equal(fake.callsOf('session/resume').length, 1);
});

test('connect understands the real kMe snapshot, runtime.eventSeq, eventSeq and subscribe events', async () => {
  const fake = createFakeZCode({
    resumeResult: {
      protocol: { name: 'zcode', version: '1' },
      session: defaultSession(),
      messages: [
        {
          info: {
            messageId: 'msg_history',
            sessionId: SESSION,
            role: 'assistant',
            parentMessageId: 'msg_parent',
            time: { created: 1 },
            cost: 0,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ partId: 'p1', sessionId: SESSION, messageId: 'msg_history', type: 'text', text: '历史正文' }],
        },
      ],
      runtime: { eventSeq: 42, stateRevision: 3, pendingRequestIds: [] },
    },
    subscribeResult: {
      sessionId: SESSION,
      eventSeq: 50,
      events: [
        {
          eventId: 'evt_history',
          seq: 45,
          type: 'turn.completed',
          payload: { inputId: 'foreign_old', resultType: 'success', response: '历史正文' },
        },
      ],
      snapshot: {
        protocol: { name: 'zcode', version: '1' },
        session: defaultSession(),
        messages: [],
        runtime: { eventSeq: 50, stateRevision: 4, pendingRequestIds: [] },
      },
    },
  });
  const bridge = makeBridge(fake);

  await bridge.connect();

  const subscribe = fake.callsOf('session/subscribe')[0];
  assert.equal(subscribe.params.afterSeq, 42);
  assert.equal(bridge.inspect().highestSeq, 50);
  assert.equal(bridge.inspect().baselineSettled, true);
  assert.equal(bridge.inspect().pendingEventCount, 0, 'historical foreign turn must not replay');
});

test('numeric JSON-RPC handshake errors keep the native code and map to stable bridge codes', async () => {
  const fake = createFakeZCode({
    failAt: {
      method: 'session/resume',
      code: -32022,
      message: 'Client request timed out: session/requestRuntimePreferences',
    },
  });
  const bridge = makeBridge(fake);

  await assert.rejects(bridge.connect(), (error) => {
    assert.equal(error.code, 'REQUEST_TIMEOUT');
    assert.equal(error.details.nativeCode, -32022);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(fake.callsOf('session/resume').length, 1);
  assert.equal(fake.calls.some((call) => call.method === 'session/send'), false);
});

test('getIdentity exposes only whitelisted session metadata and no persona body', async () => {
  const fake = createFakeZCode({
    session: defaultSession({
      agentsMd: 'persona body',
      systemPrompt: 'system body',
      preset: 'secret preset',
    }),
  });
  const bridge = makeBridge(fake);

  const first = await bridge.getIdentity();
  const second = await bridge.getIdentity();

  assert.deepEqual(first, second);
  assert.equal(first.nativeSessionRef, SESSION);
  assert.deepEqual(Object.keys(first.metadata).sort(), [
    'mode',
    'model',
    'name',
    'sessionId',
    'sessionKind',
    'status',
    'updatedAt',
    'workspace',
  ]);
  assert.equal(first.metadata.name, 'ZCode 专席');
  assert.equal('agentsMd' in first.metadata, false);
  assert.equal('systemPrompt' in first.metadata, false);
  assert.equal(JSON.stringify(first).includes('persona body'), false);
  assert.equal(JSON.stringify(first).includes('system body'), false);
  assert.equal(JSON.stringify(first).includes('secret preset'), false);
});

test('identity falls back to the native model carried by resume snapshot messages', async () => {
  const fake = createFakeZCode({
    session: defaultSession({ model: null }),
    resumeResult: {
      snapshot: {
        seq: 0,
        events: [],
        messages: [{
          messageId: 'native-model-1',
          info: { model: { providerId: 'bigmodel-standard-api', modelId: 'GLM-5.3' } },
        }],
      },
    },
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const identity = await bridge.getIdentity();
  assert.equal(identity.metadata.model, 'GLM-5.3');
  assert.equal(identity.metadata.provider, 'bigmodel-standard-api');
  await bridge.close();
});

test('explicit native session creation reuses workspace and confirms the new session', async () => {
  const created = defaultSession({ sessionId: 'sess_created' });
  const fake = createFakeZCode({
    listHandler: () => ({
      sessions: [defaultSession(), created],
      protocolVersion: ZCODE_PROTOCOL_VERSION,
    }),
    newSessionHandler: () => ({ sessionId: 'sess_created' }),
  });
  const bridge = makeBridge(fake);
  const result = await bridge.createNativeSession();
  assert.equal(result.nativeSessionRef, 'sess_created');
  const call = fake.calls.find((entry) => entry.method === 'session/create');
  assert.deepEqual(call.params, {
    workspace: { workspaceKey: 'ws_main', workspacePath: 'C:\\KIMIW' },
    persistence: 'immediate',
  });
  await bridge.close();
});

test('adoptNativeSession resumes and subscribes a new id inside the same client', async () => {
  const created = defaultSession({ sessionId: 'sess_created' });
  const fake = createFakeZCode({ sessions: [defaultSession(), created] });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const identity = await bridge.adoptNativeSession('sess_created');
  assert.equal(identity.nativeSessionRef, 'sess_created');
  assert.equal(bridge.inspect().sessionRef, 'sess_created');
  assert.equal(bridge.inspect().clientStarted, true);
  const subscribe = fake.calls.filter((entry) => entry.method === 'session/subscribe').at(-1);
  assert.deepEqual(subscribe.params, {
    sessionId: 'sess_created',
    deliveryKind: 'desktop-continuous',
    afterSeq: 0,
    includeSnapshot: true,
  });
  await bridge.close();
});

// ── 发送、关联与最终正文 ────────────────────────────────────────────────────

test('send registers the attempt before session/send, uses inputId=attemptId, and adds no toolDenylist', async () => {
  let fake;
  fake = createFakeZCode({
    sendHandler: ({ params, client }) => {
      // 模拟 turn.started 早于 session/send 响应：先登记才不会误判 ForeignTurn。
      client.emit('turn.started', startedPayload(params.inputId, 'turn_1'));
      return { accepted: true, inputId: params.inputId };
    },
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();
  const iterator = bridge.subscribe();

  const packet = makePacket();
  const receipt = await bridge.send(packet);

  assert.deepEqual(receipt, { attemptId: 'attempt_1', accepted: true, nativeRequestRef: 'attempt_1' });
  const send = fake.callsOf('session/send')[0];
  assert.deepEqual(send.params, {
    sessionId: SESSION,
    inputId: 'attempt_1',
    content: packet.text,
  });
  assert.equal('toolDenylist' in send.params, false);
  assert.equal('workspace' in send.params, false);
  assert.equal('modelSelection' in send.params, false);
  assert.equal('thoughtLevel' in send.params, false);
  assert.equal('mode' in send.params, false);

  const [started] = await takeEvents(iterator, 1);
  assertBridgeEventShape(started);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(started.attemptId, 'attempt_1');
  assert.equal(started.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 'turn_1'));
});

test('send before connect and a second active attempt are rejected', async () => {
  const fake = createFakeZCode();
  const bridge = makeBridge(fake);
  await assert.rejects(bridge.send(makePacket()), (error) => {
    assert.equal(error.code, 'BRIDGE_NOT_CONNECTED');
    return true;
  });
  assert.equal(fake.calls.length, 0);

  await bridge.connect();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  await assert.rejects(bridge.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' })), (error) => {
    assert.equal(error.code, 'BRIDGE_BUSY');
    return true;
  });
  assert.equal(fake.callsOf('session/send').length, 1);
});

test('part.delta and message.upserted only accumulate partial; turn.completed.response is the final text', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));

  fake.emit('part.delta', { inputId: 'attempt_1', turnId: 'turn_1', messageId: 'msg_1', offset: 0, delta: '不应该' });
  fake.emit('message.upserted', {
    inputId: 'attempt_1',
    turnId: 'turn_1',
    messageId: 'msg_1',
    role: 'assistant',
    text: '也不应该',
  });
  fake.emit('turn.completed', completedPayload('attempt_1', 'turn_1', '最终正文', { messageId: 'msg_1' }));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '最终正文');
  assert.equal(completed.payload.text.includes('不应该'), false);
  assert.equal(completed.payload.text.includes('也不应该'), false);
  assert.equal(completed.payload.nativeMessageRef, 'msg_1');
  assert.equal(events.filter((event) => event.type === 'AttemptCompleted').length, 1);
});

test('real event envelopes with top-level turnId and message.content accumulate partial text', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', { inputId: 'attempt_1' }, { turnId: 'turn_real' });
  fake.emit(
    'part.delta',
    { messageId: 'msg_real', partId: 'p1', field: 'reasoning', delta: '不应计入' },
    { turnId: 'turn_real' },
  );
  fake.emit('message.upserted', { content: '完整草稿' }, { turnId: 'turn_real' });
  fake.emit(
    'turn.completed',
    { inputId: 'attempt_1', resultType: 'cancelled', response: '' },
    { turnId: 'turn_real' },
  );

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptAborted');
  const started = events.find((event) => event.type === 'AttemptStarted');
  assert.equal(started.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 'turn_real'));
  const aborted = events.find((event) => event.type === 'AttemptAborted');
  assert.equal(aborted.payload.partialText, '完整草稿');
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
});

test('duplicate eventId and duplicate seq deliver one start and one completion', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  const start = { eventId: 'evt_start', seq: 11, type: 'turn.started', payload: startedPayload('attempt_1', 'turn_1') };
  fake.emitEvent(start);
  fake.emitEvent(start);
  fake.emitEvent({ ...start, eventId: 'evt_start_duplicate' });

  fake.emitEvent({
    eventId: 'evt_delta',
    seq: 12,
    type: 'part.delta',
    payload: { inputId: 'attempt_1', turnId: 'turn_1', offset: 0, delta: 'A' },
  });
  fake.emitEvent({
    eventId: 'evt_delta',
    seq: 12,
    type: 'part.delta',
    payload: { inputId: 'attempt_1', turnId: 'turn_1', offset: 0, delta: 'A' },
  });

  fake.emitEvent({
    eventId: 'evt_done',
    seq: 13,
    type: 'turn.completed',
    payload: completedPayload('attempt_1', 'turn_1', '只交付一次'),
  });
  const duplicateDone = {
    eventId: 'evt_done_other_id',
    seq: 13,
    type: 'turn.completed',
    payload: completedPayload('attempt_1', 'turn_1', '只交付一次'),
  };
  fake.emitEvent(duplicateDone);

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  assert.equal(events.filter((event) => event.type === 'AttemptStarted').length, 1);
  assert.equal(events.filter((event) => event.type === 'AttemptCompleted').length, 1);
  assert.equal(events.find((event) => event.type === 'AttemptCompleted').payload.text, '只交付一次');

  await expectSilence(iterator, 60);
});

test('two different turns with identical text both complete: dedupe never uses text', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1', turnId: 'turn_1' }));
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.emit('turn.completed', completedPayload('attempt_1', 'turn_1', '同一句话', { messageId: 'msg_1' }));
  await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');

  await bridge.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' }));
  fake.emit('turn.started', startedPayload('attempt_2', 'turn_2'));
  fake.emit('turn.completed', completedPayload('attempt_2', 'turn_2', '同一句话', { messageId: 'msg_2' }));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.attemptId, 'attempt_2');
  assert.equal(completed.payload.text, '同一句话');
  assert.equal(bridge.inspect().settledAttemptCount, 2);
});

test('a turn without a pending attempt becomes ForeignTurn, while historical foreign turns never replay', async () => {
  const { bridge, fake } = await connectedBridge({
    resumeResult: {
      snapshot: {
        seq: 10,
        events: [
          {
            eventId: 'evt_history',
            seq: 9,
            type: 'turn.completed',
            payload: completedPayload('foreign_old', 'turn_old', '历史正文'),
          },
        ],
        messages: [],
      },
    },
  });
  const iterator = bridge.subscribe();

  fake.emit('turn.started', startedPayload('foreign_new', 'turn_new'));
  const [foreign] = await takeEvents(iterator, 1);
  assert.equal(foreign.type, 'ForeignTurn');
  assert.equal(foreign.attemptId, null);
  assert.equal(foreign.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 'turn_new'));
  assert.equal(foreign.payload.reason, 'no-pending-attempt');

  fake.emit('turn.completed', completedPayload('foreign_new', 'turn_new', '不属于房间'));
  await expectSilence(iterator, 60);
});

test('turn.failed and unexpected resultType map to AttemptFailed with structured errors', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1', turnId: 'turn_1' }));
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.emit('turn.failed', {
    inputId: 'attempt_1',
    turnId: 'turn_1',
    error: { code: 'MODEL_ERROR', message: 'upstream failed', retryable: true },
  });

  const failedEvents = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = failedEvents.find((event) => event.type === 'AttemptFailed');
  assert.deepEqual(failed.payload.error, {
    code: 'MODEL_ERROR',
    message: 'upstream failed',
    retryable: true,
  });

  await bridge.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' }));
  fake.emit('turn.started', startedPayload('attempt_2', 'turn_2'));
  fake.emit('turn.completed', {
    inputId: 'attempt_2',
    turnId: 'turn_2',
    resultType: 'error',
    response: null,
  });

  const unexpectedEvents = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const unexpected = unexpectedEvents.find((event) => event.type === 'AttemptFailed');
  assert.equal(unexpected.payload.error.code, 'TURN_RESULT_UNEXPECTED');
});

// ── 取消 ────────────────────────────────────────────────────────────────────

test('cancelled turns carry partialText only and never produce AttemptCompleted', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.emit('part.delta', { inputId: 'attempt_1', turnId: 'turn_1', offset: 0, delta: '部分' });
  fake.emit('part.delta', { inputId: 'attempt_1', turnId: 'turn_1', offset: 1, delta: '正文' });
  fake.emit('turn.completed', {
    inputId: 'attempt_1',
    turnId: 'turn_1',
    resultType: 'cancelled',
    response: '',
  });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptAborted');
  const aborted = events.find((event) => event.type === 'AttemptAborted');
  assert.equal(aborted.payload.partialText, '部分正文');
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  assert.equal('text' in aborted.payload, false);
});

test('cancel uses only session/stop, is idempotent, and confirms from turn.completed(cancelled)', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.emit('part.delta', { inputId: 'attempt_1', turnId: 'turn_1', offset: 0, delta: '截断' });

  const [first, second] = await Promise.all([bridge.cancel('attempt_1'), bridge.cancel('attempt_1')]);
  assert.deepEqual(first, second);
  assert.equal(first.accepted, true);
  assert.equal(first.settlement, 'pending');
  assert.equal(fake.callsOf('session/stop').length, 1);
  assert.equal(fake.calls.some((call) => /queue|updateQueue|clear/.test(call.method)), false);
  assert.equal(fake.calls.some((call) => call.method === 'session/close'), false);

  fake.emit('turn.completed', {
    inputId: 'attempt_1',
    turnId: 'turn_1',
    resultType: 'cancelled',
    response: '',
  });
  await takeUntil(iterator, (event) => event.type === 'AttemptAborted');

  const callsBefore = fake.calls.length;
  const confirmed = await bridge.cancel('attempt_1');
  assert.equal(confirmed.settlement, 'confirmed');
  assert.equal(confirmed.accepted, true);
  assert.equal(fake.calls.length, callsBefore, 'idempotent cancel must not issue more RPCs');
});

test('cancel reports unknown and already-finished attempts without emitting events', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  const unknown = await bridge.cancel('missing');
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.settlement, 'failed');
  assert.equal(unknown.error.code, 'ATTEMPT_NOT_FOUND');

  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.emit('turn.completed', completedPayload('attempt_1', 'turn_1', '完成'));
  await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');

  const finished = await bridge.cancel('attempt_1');
  assert.equal(finished.accepted, false);
  assert.equal(finished.settlement, 'failed');
  assert.equal(finished.error.code, 'ATTEMPT_ALREADY_FINISHED');
  await expectSilence(iterator, 60);
});

// ── 断线恢复 ────────────────────────────────────────────────────────────────

test('a completed attempt that lands while disconnected settles exactly once and history foreign does not replay', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  const [started] = await takeEvents(iterator, 1);
  assert.equal(started.type, 'AttemptStarted');

  fake.disconnect();
  await takeUntil(iterator, (event) => event.type === 'BridgeError' && event.payload.error.code === 'STREAM_DISCONNECTED');

  fake.setResumeResult({
    snapshot: {
      seq: 20,
      events: [
        {
          eventId: 'evt_foreign_history',
          seq: 18,
          type: 'turn.completed',
          payload: completedPayload('foreign_old', 'turn_old', '历史不应重放'),
        },
      ],
      messages: [],
    },
  });
  fake.setEventsResult({
    events: [
      {
        eventId: 'evt_done_offline',
        seq: 21,
        type: 'turn.completed',
        payload: completedPayload('attempt_1', 'turn_1', '断线期间的回复', { messageId: 'msg_offline' }),
      },
    ],
    lastSeq: 21,
  });
  fake.setMessagesResult({
    messages: [
      { messageId: 'msg_offline', inputId: 'attempt_1', turnId: 'turn_1', role: 'assistant', text: '断线期间的回复', seq: 21 },
    ],
  });

  await bridge.connect();
  await flush();

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.attemptId, 'attempt_1');
  assert.equal(completed.payload.text, '断线期间的回复');
  assert.equal(completed.payload.nativeMessageRef, 'msg_offline');
  assert.equal(events.filter((event) => event.type === 'AttemptCompleted').length, 1);
  assert.equal(events.some((event) => event.type === 'ForeignTurn'), false);

  const subscribes = fake.callsOf('session/subscribe');
  assert.equal(subscribes.length, 2);
  assert.equal(subscribes[1].params.afterSeq, 20);
  assert.equal(fake.callsOf('session/events').length >= 1, true);
  assert.equal(fake.callsOf('session/messages').length >= 1, true);

  // 恢复后重复的旧终态不得再次结算。
  fake.emitEvent({
    eventId: 'evt_done_offline',
    seq: 21,
    type: 'turn.completed',
    payload: completedPayload('attempt_1', 'turn_1', '断线期间的回复'),
  });
  await expectSilence(iterator, 60);
});

test('a cancellation that landed while disconnected recovers as AttemptAborted with partial text', async () => {
  const fake = createFakeZCode({
    resumeResult: {
      snapshot: {
        seq: 0,
        events: [
          { eventId: 'evt_start', seq: 1, type: 'turn.started', payload: startedPayload('attempt_1', 'turn_1') },
        ],
        messages: [],
      },
    },
  });
  const bridge = makeBridge(fake, { autoReconnect: true, reconnectDelayMs: 5 });
  await bridge.connect();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());

  fake.disconnect();
  await takeUntil(iterator, (event) => event.type === 'BridgeError' && event.payload.error.code === 'STREAM_DISCONNECTED');

  fake.setResumeResult({
    snapshot: {
      seq: 20,
      events: [
        {
          eventId: 'evt_part',
          seq: 18,
          type: 'part.delta',
          payload: { inputId: 'attempt_1', turnId: 'turn_1', offset: 0, delta: '断线前部分' },
        },
        {
          eventId: 'evt_cancel',
          seq: 19,
          type: 'turn.completed',
          payload: { inputId: 'attempt_1', turnId: 'turn_1', resultType: 'cancelled', response: '' },
        },
      ],
      messages: [],
    },
  });
  fake.setEventsResult({ events: [], lastSeq: 20 });
  fake.setMessagesResult({ messages: [] });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptAborted', { ms: 3000 });
  const aborted = events.find((event) => event.type === 'AttemptAborted');
  assert.equal(aborted.payload.partialText, '断线前部分');
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  await bridge.close();
});

test('a failure that landed while disconnected recovers as AttemptFailed', async () => {
  const fake = createFakeZCode();
  const bridge = makeBridge(fake);
  await bridge.connect();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  await takeEvents(iterator, 1);

  fake.disconnect();
  await takeUntil(iterator, (event) => event.type === 'BridgeError' && event.payload.error.code === 'STREAM_DISCONNECTED');

  fake.setResumeResult({
    snapshot: {
      seq: 20,
      events: [
        {
          eventId: 'evt_failed_offline',
          seq: 19,
          type: 'turn.failed',
          payload: {
            inputId: 'attempt_1',
            turnId: 'turn_1',
            error: { code: 'MODEL_ERROR', message: 'offline failure', retryable: false },
          },
        },
      ],
      messages: [],
    },
  });
  fake.setEventsResult({ events: [], lastSeq: 20 });
  fake.setMessagesResult({ messages: [] });

  await bridge.connect();
  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(failed.payload.error.code, 'MODEL_ERROR');
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
});

test('completed without a confirmable response fails with FINAL_TEXT_UNAVAILABLE instead of blank text', async () => {
  const fake = createFakeZCode();
  const bridge = makeBridge(fake, { reconcileAttempts: 1 });
  await bridge.connect();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.setEventsResult({ events: [], lastSeq: 5 });
  fake.setMessagesResult({ messages: [] });

  fake.emit('turn.completed', {
    inputId: 'attempt_1',
    turnId: 'turn_1',
    resultType: 'success',
    response: '',
  });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(failed.payload.error.code, 'FINAL_TEXT_UNAVAILABLE');
  assert.equal(failed.payload.error.retryable, true);
  assert.equal(failed.payload.error.details.attempts, 1);
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  assert.equal(bridge.inspect().activeAttemptId, null);

  const messageCalls = fake.callsOf('session/messages');
  assert.ok(messageCalls.length >= 1);
  for (const call of messageCalls) {
    assert.deepEqual(Object.keys(call.params).sort(), ['limit', 'sessionId']);
    assert.equal('afterSeq' in call.params, false);
    assert.equal('inputId' in call.params, false);
  }
  const eventCalls = fake.callsOf('session/events');
  for (const call of eventCalls) {
    assert.equal('inputId' in call.params, false);
  }
});

test('completion with a missing response reconciles read-only messages by inputId', async () => {
  const fake = createFakeZCode();
  const bridge = makeBridge(fake);
  await bridge.connect();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.setEventsResult({ events: [], lastSeq: 5 });
  fake.setMessagesResult({
    messages: [
      { messageId: 'msg_reconciled', inputId: 'attempt_1', turnId: 'turn_1', role: 'assistant', text: '读回来的正文' },
    ],
  });

  fake.emit('turn.completed', {
    inputId: 'attempt_1',
    turnId: 'turn_1',
    resultType: 'success',
    response: null,
  });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '读回来的正文');
  assert.equal(completed.payload.nativeMessageRef, 'msg_reconciled');
  assert.equal(events.some((event) => event.type === 'AttemptFailed'), false);
});

// ── 用量与语音 ──────────────────────────────────────────────────────────────

test('usage from snapshot and turn.completed maps to UsageReported', async () => {
  const { bridge, fake } = await connectedBridge({
    resumeResult: {
      snapshot: {
        seq: 1,
        events: [],
        messages: [],
        usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 3 },
      },
    },
  });
  const iterator = bridge.subscribe();

  const [snapshotUsage] = await takeEvents(iterator, 1);
  assert.equal(snapshotUsage.type, 'UsageReported');
  assert.equal(snapshotUsage.attemptId, null);
  assert.deepEqual(snapshotUsage.payload.usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: null,
    totalTokens: null,
  });

  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.emit('turn.completed', completedPayload('attempt_1', 'turn_1', '带用量的回复', {
    usage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
  }));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const turnUsage = events.find((event) => event.type === 'UsageReported');
  assert.ok(turnUsage, 'turn usage must be reported');
  assert.equal(turnUsage.payload.nativeTurnRef, nativeTurnRefFor(SESSION, 'turn_1'));
  assert.equal(turnUsage.payload.usage.inputTokens, 5);
  assert.equal(turnUsage.payload.usage.outputTokens, 1);
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '带用量的回复');
});

test('voice is external only: no Speech events, setMuted unsupported', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  assert.deepEqual(await bridge.setMuted(true), { supported: false, capability: 'voiceMute' });

  await bridge.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.emit('turn.completed', completedPayload('attempt_1', 'turn_1', '仅文本'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  assert.equal(events.some((event) => event.type.startsWith('Speech')), false);
  await expectSilence(iterator, 60);
});

// ── 错误脱敏与关闭 ──────────────────────────────────────────────────────────

test('RPC and reconciliation errors are redacted and never expose the credential', async () => {
  const failingList = createFakeZCode({
    listHandler: () => {
      throw new Error(`list failed with Bearer ${SECRET}`);
    },
  });
  const bridge = makeBridge(failingList);
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.message.includes(SECRET), false);
    assert.match(error.message, /Bearer \*\*\*/);
    return true;
  });

  const fake = createFakeZCode();
  const bridge2 = makeBridge(fake, { reconcileAttempts: 1 });
  await bridge2.connect();
  const iterator = bridge2.subscribe();
  await bridge2.send(makePacket());
  fake.emit('turn.started', startedPayload('attempt_1', 'turn_1'));
  fake.setEventsResult(() => {
    throw new Error(`events failed with Bearer ${SECRET}`);
  });
  fake.setMessagesResult(() => {
    throw new Error(`messages failed with Bearer ${SECRET}`);
  });
  fake.emit('turn.completed', {
    inputId: 'attempt_1',
    turnId: 'turn_1',
    resultType: 'success',
    response: '',
  });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(failed.payload.error.code, 'FINAL_TEXT_UNAVAILABLE');
  assert.equal(failed.payload.error.details.readErrors.length, 2);
  assert.equal(JSON.stringify(failed.payload).includes(SECRET), false);
  assert.match(JSON.stringify(failed.payload), /Bearer \*\*\*/);
});

test('close unsubscribes, ends this app-server only, is idempotent, and leaves no dangling work', async () => {
  const { bridge, fake } = await connectedBridge({}, { autoReconnect: true, reconnectDelayMs: 5 });
  const iterator = bridge.subscribe();

  const firstClose = bridge.close();
  const closed = await nextEvent(iterator);
  assert.equal(closed.type, 'BridgeClosed');
  assert.equal(closed.payload.reason, 'closed');
  await withTimeout(firstClose, 1000, 'close');

  assert.equal(fake.callsOf('session/unsubscribe').length, 0, 'ZCode has no unsubscribe RPC');
  assert.equal(fake.closeCount, 1);
  assert.equal(fake.calls.some((call) => /session\/(close|archive|delete)/.test(call.method)), false);
  assert.equal(fake.calls.some((call) => call.method === 'workspace/create'), false);
  assert.equal(bridge.inspect().connected, false);
  assert.equal(bridge.inspect().closed, true);

  const callsBefore = fake.calls.length;
  const secondClose = bridge.close();
  assert.equal(await secondClose, await firstClose);
  await sleep(40);
  assert.equal(fake.calls.length, callsBefore);
  assert.equal(fake.closeCount, 1);
  assert.equal(bridge.inspect().reconnectRunning, false);
});

test('close never waits forever on a disconnected bridge with a reconnect loop', async () => {
  const fake = createFakeZCode();
  const bridge = makeBridge(fake, { autoReconnect: false });
  await bridge.connect();
  fake.disconnect();
  await flush();
  const startedAt = Date.now();
  await withTimeout(bridge.close(), 1000, 'close after disconnect');
  assert.ok(Date.now() - startedAt < 500);
  assert.equal(bridge.inspect().reconnectRunning, false);
});
