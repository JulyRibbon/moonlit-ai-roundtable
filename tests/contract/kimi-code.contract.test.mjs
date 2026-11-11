import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_METHODS, CAPABILITIES, BridgeError, assertBridge } from '../../adapters/contract.mjs';
import {
  KimiCodeBridge,
  KIMI_DEFAULT_BASE_URL,
  createKimiCodeBridge,
} from '../../adapters/kimi-code/bridge.mjs';
import {
  KimiApiError,
  KimiCodeClient,
  createKimiCodeClient,
  redact,
  resolveToken,
  wsUrlFor,
} from '../../adapters/kimi-code/client.mjs';
import { createBridgeEvent } from '../../core/events.mjs';

const SEAT = 'kimi';
const SESSION = 'session_test';
const TOKEN = 'test-token-secret';

// ── 离线 fake transport ─────────────────────────────────────────────────────
// 只模拟 kimi web 的 REST 信封、snapshot/transcript/messages 和 WS v2 控制帧。
// 不发起任何网络请求，不读取 token 文件，token 只作为构造参数存在内存里。

function defaultSession(overrides = {}) {
  return {
    id: SESSION,
    title: 'Kimi 专席',
    cwd: 'C:\\KIMIW',
    model: 'kimi-k2',
    updated_at: '2026-11-09T00:00:00.000Z',
    ...overrides,
  };
}

function responseBody(body, status = 200, ok = true) {
  return {
    ok,
    status,
    async text() {
      return JSON.stringify(body);
    },
  };
}

function envelope({ code = 0, msg, data, request_id = 'req_fake' } = {}) {
  return responseBody({ code, msg, data, request_id });
}

function raw(body) {
  return responseBody(body);
}

function createFakeKimi(options = {}) {
  const sessionId = options.sessionId ?? SESSION;
  let session = options.session === undefined ? defaultSession({ id: sessionId }) : options.session;
  let snapshot = options.snapshot ?? { as_of_seq: 0, epoch: 'epoch_1', in_flight_turn: null };
  let transcript = options.transcript ?? { transcript_since: 0, items: [] };
  let messages = options.messages ?? [];
  let queue = options.queue ?? [];
  let promptHandler = options.promptHandler ?? null;
  let abortPromptHandler = options.abortPromptHandler ?? null;
  let abortSessionHandler = options.abortSessionHandler ?? null;
  let messagesHandler = options.messagesHandler ?? null;
  let transcriptHandler = options.transcriptHandler ?? null;
  let snapshotHandler = options.snapshotHandler ?? null;

  const calls = [];
  const sockets = [];
  const sentFrames = [];

  const sessionBase = `/api/v1/sessions/${encodeURIComponent(sessionId)}`;

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, search: parsed.search, body, headers: init.headers, url });

    if (options.fetchError) throw new Error(options.fetchError);
    if (options.networkDelayMs) await sleep(options.networkDelayMs);

    if (method === 'POST' && /shutdown|archive|takeover|fork/.test(path)) {
      throw new Error(`bridge must never call ${method} ${path}`);
    }

    if (path === '/api/v1/meta') {
      return envelope({ data: { server_version: options.serverVersion ?? '2.5.2', capabilities: { websocket: true } } });
    }
    if (path === '/openapi.json') {
      return raw({
        openapi: '3.0.3',
        info: { title: 'Kimi Code' },
        paths: {
          '/api/v1/sessions/{id}': { get: {} },
          '/api/v1/sessions/{id}/prompts': { get: {}, post: {} },
          '/api/v1/sessions/{id}/prompts/{prompt_id}:abort': { post: {} },
          '/api/v1/sessions/{id}:abort': { post: {} },
        },
      });
    }
    if (path === '/asyncapi.json') {
      return raw({
        asyncapi: '3.1.0',
        channels: { ws: { address: '/api/v1/ws' } },
        components: {
          messages: {
            server_hello: {},
            subscribe_v2: {},
            unsubscribe_v2: {},
            ack: {},
            session_event: {},
          },
        },
      });
    }

    if (path === '/api/v1/sessions' && method === 'POST') {
      if (options.createHandler) return options.createHandler({ body, fake });
      return envelope({ data: { session: defaultSession({ id: 'session_created', cwd: body?.cwd }) } });
    }
    const profileMatch = /^\/api\/v1\/sessions\/([^/]+)\/profile$/.exec(path);
    if (profileMatch && method === 'POST' && options.createdSessions?.[profileMatch[1]]) {
      return envelope({ data: { session: options.createdSessions[profileMatch[1]] } });
    }
    const createdMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(path);
    if (createdMatch && method === 'GET' && options.createdSessions?.[createdMatch[1]]) {
      return envelope({ data: { session: options.createdSessions[createdMatch[1]] } });
    }
    if (path === sessionBase && method === 'GET') {
      if (options.sessionErrorCode) {
        return envelope({ code: options.sessionErrorCode, msg: options.sessionErrorMessage ?? 'session error' });
      }
      if (session === null) return envelope({ code: 40401, msg: 'session not found' });
      return envelope({ data: { session } });
    }
    if (path === `${sessionBase}/snapshot` && method === 'GET') {
      if (snapshotHandler) return snapshotHandler({ fake });
      return envelope({ data: { snapshot } });
    }
    if (path === `${sessionBase}/transcript` && method === 'GET') {
      if (transcriptHandler) return transcriptHandler({ fake });
      return envelope({ data: { transcript } });
    }
    if (path === `${sessionBase}/messages` && method === 'GET') {
      if (messagesHandler) return messagesHandler({ fake });
      return envelope({ data: { messages } });
    }
    if (path === `${sessionBase}/prompts` && method === 'GET') {
      return envelope({ data: { prompts: queue } });
    }
    if (path === `${sessionBase}/prompts` && method === 'POST') {
      if (promptHandler) return promptHandler({ body, fake });
      return envelope({ data: { accepted: true, prompt_id: body?.prompt_id } });
    }
    if (path.startsWith(`${sessionBase}/prompts/`) && path.endsWith(':abort') && method === 'POST') {
      const promptId = decodeURIComponent(
        path.slice(`${sessionBase}/prompts/`.length, -':abort'.length),
      );
      if (abortPromptHandler) return abortPromptHandler({ promptId, fake });
      return envelope({ data: { aborted: true, prompt_id: promptId } });
    }
    if (path === `${sessionBase}:abort` && method === 'POST') {
      if (abortSessionHandler) return abortSessionHandler({ fake });
      return envelope({ data: { aborted: true } });
    }

    return envelope({ code: 40400, msg: `unhandled fake path: ${method} ${path}` });
  }

  class FakeWebSocket {
    constructor(url, protocols) {
      this.url = url;
      this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
      this.readyState = 0;
      this._listeners = new Map();
      sockets.push(this);

      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this._emit('open', {});
        this._serverSend({ type: 'server_hello', payload: { protocol_version: 2 } });
      });
    }

    addEventListener(type, handler) {
      const list = this._listeners.get(type) ?? [];
      list.push(handler);
      this._listeners.set(type, list);
    }

    _emit(type, event) {
      for (const handler of this._listeners.get(type) ?? []) handler(event);
    }

    _serverSend(frame) {
      queueMicrotask(() => {
        if (this.readyState !== 1) return;
        this._emit('message', { data: JSON.stringify(frame) });
      });
    }

    send(raw) {
      const frame = JSON.parse(raw);
      sentFrames.push(frame);
      if (frame.type === 'subscribe_v2') {
        const deliver = () => {
          this._serverSend({
            type: 'ack',
            id: frame.id,
            code: options.subscribeErrorCode ?? 0,
            msg: options.subscribeErrorMessage,
          });
        };
        if (options.subscribeDelayMs) setTimeout(deliver, options.subscribeDelayMs);
        else queueMicrotask(deliver);
        return;
      }
      if (frame.type === 'unsubscribe_v2') {
        queueMicrotask(() => this._serverSend({ type: 'ack', id: frame.id, code: 0 }));
      }
    }

    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this._emit('close', { code, reason }));
    }

    _serverClose(code = 1011, reason = 'test disconnect') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      queueMicrotask(() => this._emit('close', { code, reason }));
    }
  }

  const fake = {
    sessionId,
    transport: { fetch: fetchImpl, WebSocket: FakeWebSocket },
    calls,
    sentFrames,
    sockets,
    get session() {
      return session;
    },
    setSession(value) {
      session = value;
    },
    setSnapshot(value) {
      snapshot = value;
    },
    setTranscript(value) {
      transcript = value;
    },
    setMessages(value) {
      messages = value;
    },
    setQueue(value) {
      queue = value;
    },
    setPromptHandler(handler) {
      promptHandler = handler;
    },
    setAbortPromptHandler(handler) {
      abortPromptHandler = handler;
    },
    setAbortSessionHandler(handler) {
      abortSessionHandler = handler;
    },
    setMessagesHandler(handler) {
      messagesHandler = handler;
    },
    setTranscriptHandler(handler) {
      transcriptHandler = handler;
    },
    setSnapshotHandler(handler) {
      snapshotHandler = handler;
    },
    emit(frame) {
      for (const socket of sockets) {
        if (socket.readyState === 1) socket._serverSend(frame);
      }
    },
    disconnect(code = 1011, reason = 'test disconnect') {
      for (const socket of sockets) socket._serverClose(code, reason);
    },
    framesOf(type) {
      return sentFrames.filter((frame) => frame.type === type);
    },
    callsOf(method, pathIncludes = '') {
      return calls.filter((call) => call.method === method && call.path.includes(pathIncludes));
    },
    promptAborts() {
      return calls.filter(
        (call) => call.method === 'POST'
          && call.path.includes('/prompts/')
          && call.path.endsWith(':abort'),
      );
    },
    sessionAborts() {
      return calls.filter(
        (call) => call.method === 'POST'
          && call.path.endsWith(':abort')
          && !call.path.includes('/prompts/'),
      );
    },
    async waitForSockets(count, timeoutMs = 2000) {
      await waitFor(
        () => sockets.length >= count && sockets[count - 1].readyState === 1,
        { timeoutMs, label: `${count} WS connections` },
      );
      return sockets[count - 1];
    },
  };
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

async function waitFor(predicate, { timeoutMs = 2000, label = 'condition' } = {}) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
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
  return createKimiCodeBridge({
    seatId: SEAT,
    nativeSessionRef: fake.sessionId,
    transport: fake.transport,
    token: TOKEN,
    connectTimeoutMs: 1000,
    subscribeTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    closeTimeoutMs: 500,
    reconnectDelayMs: 5,
    ...overrides,
  });
}

async function connectedBridge(fakeOptions = {}, bridgeOptions = {}) {
  const fake = createFakeKimi(fakeOptions);
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

const turnStart = (promptId, turnId) => ({
  type: 'turn.started',
  payload: { prompt_id: promptId, turn_id: turnId },
});
const turnEnd = (promptId, turnId, reason = { kind: 'completed' }, extra = {}) => ({
  type: 'turn.ended',
  payload: { prompt_id: promptId, turn_id: turnId, reason, ...extra },
});
const assistantMessage = (promptId, turnId, id, text) => ({
  id,
  role: 'assistant',
  prompt_id: promptId,
  turn_id: turnId,
  content: [{ type: 'text', text }],
});

// ── 契约与方法完整性 ────────────────────────────────────────────────────────

test('the production default Kimi Code base URL is the local web port 58690', async () => {
  assert.equal(KIMI_DEFAULT_BASE_URL, 'http://127.0.0.1:58690');
  assert.equal(wsUrlFor('http://127.0.0.1:58690'), 'ws://127.0.0.1:58690/api/v1/ws');
  const bridge = createKimiCodeBridge({ seatId: SEAT, nativeSessionRef: SESSION });
  const client = await bridge._resolveClient({ token: '' });
  assert.equal(client.baseUrl, 'http://127.0.0.1:58690');
});

test('KimiCodeBridge implements every Bridge v1 method and KimiCodeClient is injectable', () => {
  const bridge = new KimiCodeBridge({ seatId: SEAT, nativeSessionRef: SESSION, token: '' });
  assert.doesNotThrow(() => assertBridge(bridge));
  for (const method of BRIDGE_METHODS) {
    assert.equal(typeof bridge[method], 'function', `${method} must be callable`);
  }
  assert.equal(typeof createKimiCodeBridge, 'function');
  assert.equal(typeof createKimiCodeClient, 'function');
  const client = createKimiCodeClient({ token: '', transport: { fetch: async () => responseBody({ code: 0, data: {} }), WebSocket: class {} } });
  assert.ok(client instanceof KimiCodeClient);
});

test('CAPABILITIES covers the Kimi Code surface and unknown voice stays null/false', async () => {
  const fake = createFakeKimi();
  const bridge = makeBridge(fake);
  const result = await bridge.probe();
  assert.deepEqual(Object.keys(result.capabilities), [...CAPABILITIES]);
  assert.equal(result.capabilities.voiceTrigger, null);
  assert.equal(result.capabilities.voiceStartedFinishedEvents, false);
  assert.equal(result.capabilities.voiceStop, false);
  assert.equal(result.capabilities.voiceMute, false);
  assert.equal(result.voiceMode, 'none');
});

// ── 只读 probe ──────────────────────────────────────────────────────────────

test('probe is read-only, REST-confirms the session first, and reports real metadata', async () => {
  const fake = createFakeKimi({
    session: defaultSession({
      system_prompt: 'DO NOT COPY THIS PERSONA',
      agents_md: 'DO NOT COPY THIS AGENTS.md',
    }),
  });
  const bridge = makeBridge(fake);

  const result = await bridge.probe();

  assert.equal(fake.calls[0].method, 'GET');
  assert.equal(fake.calls[0].path, `/api/v1/sessions/${SESSION}`);
  assert.equal(fake.sockets.length, 0, 'probe must not open WS or subscribe');
  assert.equal(fake.calls.some((call) => call.method === 'POST'), false);
  assert.equal(fake.calls.some((call) => /create|archive|takeover|fork|shutdown/.test(call.path)), false);

  assert.equal(result.clientVersion, '2.5.2');
  assert.equal(result.capabilities.nativeSession, true);
  assert.equal(result.capabilities.sendToExistingSession, true);
  assert.equal(result.capabilities.queueClear, true);
  assert.equal(result.capabilities.requestAbort, true);
  assert.equal(result.capabilities.providerUsage, true);
  assert.equal(result.identity.nativeSessionRef, SESSION);
  assert.equal(result.identity.metadata.cwd, 'C:\\KIMIW');
  assert.equal(result.identity.metadata.model, 'kimi-k2');
  assert.equal(result.identity.metadata.identityLevel, 'session+cwd');

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('DO NOT COPY THIS PERSONA'), false);
  assert.equal(serialized.includes('DO NOT COPY THIS AGENTS.md'), false);
  assert.equal(serialized.includes('AGENTS'), false);
  assert.equal(serialized.includes('SYSTEM'), false);
});

test('probe fails on a missing session before trusting subscribe ack (ACK trap)', async () => {
  const fake = createFakeKimi({ session: null });
  const bridge = makeBridge(fake);

  await assert.rejects(bridge.probe(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
  assert.equal(fake.sockets.length, 0, 'REST failure must prevent WS/subscribe');
  assert.equal(fake.sentFrames.length, 0);
  assert.equal(fake.calls.some((call) => call.path === '/openapi.json'), false);
});

test('connect also REST-confirms the session and never trusts subscribe_v2 ack=0', async () => {
  const fake = createFakeKimi({ session: null, subscribeErrorCode: 0 });
  const bridge = makeBridge(fake);

  await assert.rejects(bridge.connect(), (error) => {
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
  assert.equal(fake.sockets.length, 0);
  assert.equal(fake.sentFrames.length, 0);
});

test('probe without nativeSessionRef is rejected instead of creating a session', async () => {
  const fake = createFakeKimi();
  const bridge = createKimiCodeBridge({ seatId: SEAT, transport: fake.transport, token: TOKEN });
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.code, 'SESSION_REQUIRED');
    return true;
  });
  assert.equal(fake.calls.length, 0);
});

test('40931 and 40932 map to BRIDGE_BUSY / BRIDGE_CONFLICT without takeover', async () => {
  for (const [nativeCode, expected] of [[40931, 'BRIDGE_BUSY'], [40932, 'BRIDGE_CONFLICT']]) {
    const fake = createFakeKimi({ sessionErrorCode: nativeCode });
    const bridge = makeBridge(fake);
    await assert.rejects(bridge.probe(), (error) => {
      assert.equal(error.code, expected);
      assert.equal(error.retryable, true);
      assert.equal(error.details.nativeCode, nativeCode);
      return true;
    });
    assert.equal(fake.calls.some((call) => call.method === 'POST'), false);
    assert.equal(fake.sockets.length, 0);
  }

  for (const [ackCode, expected] of [[40931, 'BRIDGE_BUSY'], [40932, 'BRIDGE_CONFLICT']]) {
    const fake = createFakeKimi({ subscribeErrorCode: ackCode });
    const bridge = makeBridge(fake);
    await assert.rejects(bridge.connect(), (error) => {
      assert.equal(error.code, expected);
      return true;
    });
    assert.equal(fake.sockets[0].readyState, 3, 'failed subscribe must close WS');
  }
});

// ── 身份 ────────────────────────────────────────────────────────────────────

test('getIdentity is stable and exposes only session + cwd + model metadata', async () => {
  const fake = createFakeKimi({
    session: defaultSession({ system_prompt: 'persona body', agents_md: 'agents body' }),
  });
  const bridge = makeBridge(fake);

  const first = await bridge.getIdentity();
  const second = await bridge.getIdentity();

  assert.deepEqual(first, second);
  assert.equal(first.nativeSessionRef, SESSION);
  assert.equal(first.metadata.identityLevel, 'session+cwd');
  assert.equal(first.metadata.cwd, 'C:\\KIMIW');
  assert.equal(first.metadata.model, 'kimi-k2');
  assert.equal(first.metadata.name, 'Kimi 专席');
  assert.equal('agentPreset' in first.metadata, false);
  assert.equal('persona' in first.metadata, false);
  assert.equal(JSON.stringify(first).includes('persona body'), false);
  assert.equal(JSON.stringify(first).includes('agents body'), false);
  assert.equal(fake.sockets.length, 0);
});

test('explicit native session creation reuses cwd and confirms the new session', async () => {
  const created = defaultSession({ id: 'session_created' });
  const fake = createFakeKimi({ createdSessions: { session_created: created } });
  const bridge = makeBridge(fake);
  const result = await bridge.createNativeSession();
  assert.equal(result.nativeSessionRef, 'session_created');
  const creation = fake.calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.deepEqual(creation.body, {
    metadata: { cwd: 'C:\\KIMIW' },
    agent_config: { model: 'kimi-k2' },
  });
  assert.equal(fake.sockets.length, 0);
});

test('native session creation refreshes stale cached metadata before inheriting the model', async () => {
  const created = defaultSession({ id: 'session_created' });
  const fake = createFakeKimi({ createdSessions: { session_created: created } });
  const bridge = makeBridge(fake);
  bridge._session = defaultSession({ model: null });
  const result = await bridge.createNativeSession();
  assert.equal(result.nativeSessionRef, 'session_created');
  const creation = fake.calls.find((call) => call.method === 'POST' && call.path === '/api/v1/sessions');
  assert.equal(creation.body.agent_config.model, 'kimi-k2');
});

test('native session creation refuses to create an unusable session without a model', async () => {
  const fake = createFakeKimi({ session: defaultSession({ model: null }) });
  const bridge = makeBridge(fake);
  await assert.rejects(
    () => bridge.createNativeSession(),
    (error) => error.code === 'SESSION_MODEL_REQUIRED',
  );
  assert.equal(fake.calls.some((call) => call.method === 'POST' && call.path === '/api/v1/sessions'), false);
});

// ── 连接与缓冲 ──────────────────────────────────────────────────────────────

test('connect follows an existing session, opens WS v2, subscribes after a baseline, and buffers pre-subscribe events', async () => {
  const fake = createFakeKimi({
    snapshot: {
      as_of_seq: 7,
      epoch: 'epoch_7',
      in_flight_turn: { turn_id: 'foreign_turn', current_prompt_id: 'foreign_prompt' },
    },
  });
  const bridge = makeBridge(fake);

  await bridge.connect();
  await flush();

  assert.equal(fake.calls.some((call) => call.method === 'POST'), false, 'connect must not create/abort anything');
  assert.equal(fake.sockets.length, 1);
  const subscribe = fake.framesOf('subscribe_v2');
  assert.equal(subscribe.length, 1);
  assert.equal(subscribe[0].payload.session_id, SESSION);
  assert.deepEqual(subscribe[0].payload.transcript, { '*': 'turn' });
  assert.deepEqual(subscribe[0].payload.transcript_since, { '*': 7 });

  // 事件发生在 subscribe() 被调用之前，仍必须由 Bridge 缓冲。
  const iterator = bridge.subscribe();
  const events = await takeEvents(iterator, 1);
  assert.equal(events[0].type, 'ForeignTurn');
  assert.equal(events[0].payload.nativeTurnRef, `${SESSION}#turn:foreign_turn`);

  // connect 之后、subscribe() 之前发生的 live 事件同样缓冲。
  fake.emit(turnStart('live_foreign', 'live_turn'));
  await flush();
  const live = await takeEvents(iterator, 1);
  assert.equal(live[0].type, 'ForeignTurn');
  assert.equal(live[0].payload.nativeTurnRef, `${SESSION}#turn:live_turn`);
});

// ── snapshot 404 兼容基线 ──────────────────────────────────────────────────

test('the real 2.5.2 snapshot 404 body (no code/msg) is recognized as route-missing', async () => {
  const fake = createFakeKimi({
    snapshotHandler: () => responseBody({
      message: `Route GET:/api/v1/sessions/${SESSION}/snapshot not found`,
      error: 'Not Found',
      statusCode: 404,
    }, 404, false),
  });
  const bridge = makeBridge(fake);
  const client = await bridge._resolveClient({});

  await assert.rejects(client.getSnapshot(SESSION), (error) => {
    assert.equal(error.name, 'KimiApiError');
    assert.equal(error.code, null);
    assert.equal(error.httpStatus, 404);
    assert.match(error.message, /failed with code=\?: unknown error/);
    return true;
  });

  await bridge.connect();
  assert.equal(bridge.inspect().baseline.source, 'session-profile');
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/messages')).length, 1);
  const subscribe = fake.framesOf('subscribe_v2')[0];
  assert.equal('transcript_since' in subscribe.payload, false, 'zero transcript cursor must be omitted');
  await bridge.close();
});

test('real transcript.ops turn/prompt upserts drive AttemptStarted and AttemptFailed (model.not_configured)', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.emit({
    type: 'transcript.ops',
    session_id: SESSION,
    payload: {
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 12,
      ops: [
        {
          op: 'prompt.upsert',
          prompt: { promptId: 'live-server-prompt', status: 'running', createdAt: '2026-11-08T19:34:55.336Z' },
        },
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: 't0',
            triggerPromptId: 'live-server-prompt',
            ordinal: 0,
            state: 'running',
            prompt: '只回复 OK，不要调用任何工具。',
            startedAt: '2026-11-08T19:34:55.371Z',
          },
        },
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: 't0',
            triggerPromptId: 'live-server-prompt',
            ordinal: 0,
            state: 'failed',
            error: 'Model not set',
            startedAt: '2026-11-08T19:34:55.371Z',
            endedAt: '2026-11-08T19:34:55.484Z',
          },
        },
        {
          op: 'step.upsert',
          turnId: 't0',
          step: {
            kind: 'step',
            stepId: 't0.1',
            turnId: 't0',
            ordinal: 1,
            state: 'interrupted',
            endReason: 'error',
            endMessage: '[model.not_configured] Model not set',
          },
        },
        {
          op: 'prompt.upsert',
          prompt: { promptId: 'live-server-prompt', status: 'failed', finishedAt: '2026-11-08T19:34:55.490Z' },
        },
      ],
    },
  });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const started = events.find((event) => event.type === 'AttemptStarted');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(started.payload.nativeTurnRef, `${SESSION}#turn:t0`);
  assert.equal(failed.payload.error.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(failed.payload.error.message, 'Model not set');
  assert.equal(failed.payload.error.retryable, false);
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  assert.equal(bridge.inspect().activeAttemptId, null);
  assert.equal(bridge.inspect().turnMapSize, 0);
  assert.equal(bridge.inspect().turnRecordCount, 0);
  assert.equal(fake.callsOf('POST', '/prompts').length, 1, 'no re-prompt');
  await bridge.close();
});

test('real completed turn.upsert reconciles final text from transcript text frames with server triggerPromptId', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.setTranscript({
    agent_id: 'main',
    seq: 13,
    prompts: [{ promptId: 'server_prompt_2', status: 'completed' }],
    items: [
      {
        kind: 'turn',
        turnId: 't0',
        triggerPromptId: 'server_prompt_2',
        ordinal: 0,
        state: 'completed',
        steps: [
          {
            kind: 'step',
            stepId: 't0.1',
            turnId: 't0',
            ordinal: 1,
            state: 'completed',
            frames: [
              { kind: 'text', role: 'assistant', frameId: 'frame_final', text: '真正的最终回复' },
            ],
          },
        ],
      },
    ],
  });
  fake.emit({
    type: 'transcript.ops',
    session_id: SESSION,
    payload: {
      type: 'transcript.ops',
      agent_id: 'main',
      seq: 13,
      ops: [
        { op: 'prompt.upsert', prompt: { promptId: 'server_prompt_2', status: 'running' } },
        {
          op: 'turn.upsert',
          turn: {
            kind: 'turn',
            turnId: 't0',
            triggerPromptId: 'server_prompt_2',
            ordinal: 0,
            state: 'completed',
            startedAt: '2026-11-08T19:40:00.000Z',
            endedAt: '2026-11-08T19:40:01.000Z',
          },
        },
      ],
    },
  });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const started = events.find((event) => event.type === 'AttemptStarted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(started.payload.nativeTurnRef, `${SESSION}#turn:t0`);
  assert.equal(completed.payload.text, '真正的最终回复');
  assert.equal(completed.payload.nativeMessageRef, 'frame_final');
  assert.equal(events.some((event) => event.type === 'AttemptFailed'), false);
  assert.equal(bridge.inspect().activeAttemptId, null);
  await bridge.close();
});

test('transcript.reset historical turns never bind the active attempt', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.emit({
    type: 'transcript.reset',
    session_id: SESSION,
    payload: {
      type: 'transcript.reset',
      agent_id: 'main',
      seq: 12,
      snapshot: {
        items: [
          {
            kind: 'turn',
            turnId: 'old_turn',
            triggerPromptId: 'old_prompt',
            ordinal: 0,
            state: 'completed',
            steps: [
              {
                kind: 'step',
                stepId: 's1',
                turnId: 'old_turn',
                ordinal: 1,
                state: 'completed',
                frames: [{ kind: 'text', role: 'assistant', frameId: 'old_frame', text: '旧正文' }],
              },
            ],
          },
        ],
        prompts: [{ promptId: 'old_prompt', status: 'completed' }],
      },
      has_more_older: false,
    },
  });

  await expectSilence(iterator, 80);
  assert.equal(bridge.inspect().activeAttemptId, 'attempt_1');
  assert.equal(bridge.inspect().turnMapSize, 0);
  await bridge.close();
});

test('WS ping is answered with pong using the same nonce', async () => {
  const { bridge, fake } = await connectedBridge();
  fake.emit({ type: 'ping', payload: { nonce: 'nonce_1' } });
  await flush();
  const pong = fake.sentFrames.find((frame) => frame.type === 'pong');
  assert.ok(pong);
  assert.deepEqual(pong.payload, { nonce: 'nonce_1' });
  await bridge.close();
});

test('snapshot 404 route-not-found falls back to session profile + transcript + messages and probe/connect still succeed', async () => {
  const profile = defaultSession({
    busy: false,
    main_turn_active: false,
    pending_interaction: null,
    last_turn_reason: 'completed',
    current_prompt_id: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    agent_config: { model: 'kimi-k2-fallback' },
    metadata: { cwd: 'C:\\KIMIW\\fallback' },
  });
  const fake = createFakeKimi({
    session: profile,
    messages: [assistantMessage('old_prompt', 'old_turn', 'old_msg', '历史正文')],
    snapshotHandler: () => responseBody({
      message: `Route GET:/api/v1/sessions/${SESSION}/snapshot not found`,
      error: 'Not Found',
      statusCode: 404,
    }, 404, false),
  });
  const bridge = makeBridge(fake);

  const probe = await bridge.probe();
  assert.equal(probe.capabilities.snapshotRecovery, true);
  assert.equal(fake.sockets.length, 0, 'probe must remain read-only');

  await bridge.connect();
  await flush();

  const transcriptCalls = fake.calls.filter((call) => call.path.endsWith('/transcript'));
  assert.equal(transcriptCalls.length, 1);
  assert.equal(new URLSearchParams(transcriptCalls[0].search).get('agent_id'), 'main');
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/messages')).length, 1);
  assert.equal(fake.calls.filter((call) => call.path.endsWith('/snapshot')).length, 1);
  assert.ok(
    fake.calls.filter((call) => call.path === `/api/v1/sessions/${SESSION}`).length >= 2,
    'fallback must read the session profile',
  );

  const baseline = bridge.inspect().baseline;
  assert.equal(baseline.source, 'session-profile');
  assert.equal(baseline.busy, false);
  assert.equal(baseline.mainTurnActive, false);
  assert.equal(baseline.pendingInteraction, null);
  assert.equal(baseline.lastTurnReason, 'completed');
  assert.equal(baseline.inFlightPromptId, null);
  assert.equal(baseline.inFlightKnown, true);
  assert.equal(baseline.model, 'kimi-k2-fallback');
  assert.equal(baseline.cwd, 'C:\\KIMIW');

  const [usageEvent] = await takeEvents(bridge.subscribe(), 1);
  assert.equal(usageEvent.type, 'UsageReported');
  assert.equal(usageEvent.payload.usageQuality, 'unknown');
  assert.equal(usageEvent.payload.usageKnown, false);
  assert.equal(usageEvent.payload.usageSource, 'session-profile');
  assert.deepEqual(usageEvent.payload.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: null,
  });
  await bridge.close();

  // 真实实例也可能是非 JSON 的 404 Route not found。
  const plainFake = createFakeKimi({
    snapshotHandler: () => ({
      ok: false,
      status: 404,
      async text() {
        return 'Route not found';
      },
    }),
  });
  const plainBridge = makeBridge(plainFake);
  await plainBridge.connect();
  assert.equal(plainBridge.inspect().baseline.source, 'session-profile');
  await plainBridge.close();
});

test('snapshot errors other than route-not-found are not downgraded to profile fallback', async () => {
  const cases = [
    {
      label: 'auth',
      expected: 'AUTH_FAILED',
      handler: () => envelope({ code: 40101, msg: 'unauthorized' }),
    },
    {
      label: 'server',
      expected: 'BASELINE_FAILED',
      handler: () => envelope({ code: 50001, msg: 'internal error' }),
    },
    {
      label: 'http-401',
      expected: 'AUTH_FAILED',
      handler: () => responseBody({ message: 'unauthorized' }, 401, false),
    },
    {
      label: 'http-403',
      expected: 'AUTH_FAILED',
      handler: () => responseBody({ message: 'forbidden' }, 403, false),
    },
    {
      label: 'http-500',
      expected: 'BASELINE_FAILED',
      handler: () => responseBody({ message: 'server error' }, 500, false),
    },
    {
      label: 'network',
      expected: 'BASELINE_FAILED',
      handler: () => {
        throw new Error('network down');
      },
    },
  ];

  for (const item of cases) {
    const fake = createFakeKimi({ snapshotHandler: item.handler });
    const bridge = makeBridge(fake);
    await assert.rejects(bridge.connect(), (error) => {
      assert.equal(error.code, item.expected, item.label);
      return true;
    });
    assert.equal(fake.calls.filter((call) => call.path.endsWith('/transcript')).length, 0, item.label);
    assert.equal(fake.calls.filter((call) => call.path.endsWith('/messages')).length, 0, item.label);
    assert.equal(
      fake.calls.filter((call) => call.path === `/api/v1/sessions/${SESSION}`).length,
      1,
      `${item.label}: no profile fallback`,
    );
    assert.equal(fake.sockets[0].readyState, 3, `${item.label}: failed connect closes WS`);
  }
});

test('profile fallback maps busy/main_turn_active/current_prompt_id to an explicit in-flight turn', async () => {
  const fake = createFakeKimi({
    session: defaultSession({
      busy: true,
      main_turn_active: true,
      current_prompt_id: 'foreign_prompt',
      pending_interaction: { id: 'interaction_1' },
      last_turn_reason: { kind: 'running' },
    }),
    snapshotHandler: () => responseBody({ code: 404, msg: 'Route not found' }, 404, false),
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();

  const baseline = bridge.inspect().baseline;
  assert.equal(baseline.busy, true);
  assert.equal(baseline.mainTurnActive, true);
  assert.equal(baseline.inFlightPromptId, 'foreign_prompt');
  assert.equal(baseline.inFlightTurnRef, null, 'profile fallback must not invent a turn id');
  assert.equal(baseline.inFlightKnown, true);
  assert.deepEqual(baseline.pendingInteraction, { id: 'interaction_1' });

  const [foreign] = await takeEvents(bridge.subscribe(), 1);
  assert.equal(foreign.type, 'ForeignTurn');
  assert.equal(foreign.payload.nativeTurnRef, `${SESSION}#turn:foreign_prompt`);
  await bridge.close();
});

test('profile fallback with busy but no current_prompt_id leaves in-flight explicitly empty', async () => {
  const fake = createFakeKimi({
    session: defaultSession({
      busy: true,
      main_turn_active: true,
      current_prompt_id: null,
    }),
    snapshotHandler: () => responseBody({ code: 404, msg: 'Route not found' }, 404, false),
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();

  const baseline = bridge.inspect().baseline;
  assert.equal(baseline.busy, true);
  assert.equal(baseline.mainTurnActive, true);
  assert.equal(baseline.inFlightPromptId, null);
  assert.equal(baseline.inFlightKnown, true);
  await expectSilence(bridge.subscribe(), 60);
  await bridge.close();
});

test('recovery also uses the profile fallback when snapshot is route-missing', async () => {
  const fake = createFakeKimi({
    session: defaultSession({ busy: false, main_turn_active: false, current_prompt_id: null }),
    snapshotHandler: () => responseBody({ code: 404, msg: 'Route not found' }, 404, false),
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  await nextEvent(iterator);

  fake.disconnect();
  fake.setSession(defaultSession({
    busy: false,
    main_turn_active: false,
    current_prompt_id: null,
    last_turn_reason: 'completed',
  }));
  fake.setTranscript({ transcript_since: 20, items: [] });
  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_profile_recovery', 'profile 恢复正文')]);

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, 'profile 恢复正文');
  assert.equal(completed.payload.nativeMessageRef, 'msg_profile_recovery');

  await fake.waitForSockets(2);
  await waitFor(() => bridge.inspect().connected === true, { label: 'profile fallback reconnect' });
  assert.equal(bridge.inspect().baseline.source, 'session-profile');
  assert.deepEqual(fake.framesOf('subscribe_v2')[1].payload.transcript_since, { '*': 20 });
  const transcriptCalls = fake.calls.filter((call) => call.path.endsWith('/transcript'));
  assert.ok(transcriptCalls.every((call) => new URLSearchParams(call.search).get('agent_id') === 'main'));
  await bridge.close();
});

// ── 发送与完成 ──────────────────────────────────────────────────────────────

test('send registers the attempt before POST, prompt_id = attemptId, and accepted is only a receipt', async () => {
  let fake;
  fake = createFakeKimi({
    promptHandler: ({ body }) => {
      // 模拟 turn.started 早于 HTTP 响应：若未先登记 attempt，会被误判 ForeignTurn。
      fake.emit(turnStart(body.prompt_id, 'turn_1'));
      return envelope({ data: { accepted: true, prompt_id: body.prompt_id } });
    },
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  await flush();
  const iterator = bridge.subscribe();

  const packet = makePacket({ attemptId: 'attempt_1' });
  const receipt = await bridge.send(packet);

  assert.deepEqual(receipt, { attemptId: 'attempt_1', accepted: true });
  const post = fake.calls.find((call) => call.method === 'POST' && call.path.endsWith('/prompts'));
  assert.equal(post.body.prompt_id, 'attempt_1');
  assert.equal(post.body.content[0].type, 'text');
  assert.equal(post.body.content[0].text, packet.text);

  const started = await nextEvent(iterator);
  assert.equal(started.type, 'AttemptStarted');
  assert.equal(started.attemptId, 'attempt_1');
  assert.equal(started.payload.nativeTurnRef, `${SESSION}#turn:turn_1`);

  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_1', '最终正文')]);
  fake.emit({
    type: 'assistant.delta',
    payload: { prompt_id: 'attempt_1', message_id: 'msg_1', offset: 0, delta: 'volatile-delta' },
  });
  fake.emit(turnEnd('attempt_1', 'turn_1'));

  const completed = await nextEvent(iterator);
  assert.equal(completed.type, 'AttemptCompleted');
  assert.equal(completed.attemptId, 'attempt_1');
  assert.equal(completed.payload.text, '最终正文');
  assert.equal(completed.payload.nativeMessageRef, 'msg_1');
  assert.equal(completed.payload.text.includes('volatile-delta'), false);
});

test('sending without connect and sending a second active attempt are rejected', async () => {
  const fake = createFakeKimi();
  const bridge = makeBridge(fake);
  await assert.rejects(bridge.send(makePacket()), (error) => {
    assert.equal(error.code, 'BRIDGE_NOT_CONNECTED');
    return true;
  });
  assert.equal(fake.calls.length, 0);

  const { bridge: connected, fake: fake2 } = await connectedBridge();
  await connected.send(makePacket({ attemptId: 'attempt_1' }));
  await assert.rejects(connected.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' })), (error) => {
    assert.equal(error.code, 'BRIDGE_BUSY');
    return true;
  });
  assert.equal(fake2.callsOf('POST', '/prompts').length, 1);
});

test('prompt_id is idempotent: the same attemptId never POSTs twice', async () => {
  const { bridge, fake } = await connectedBridge();
  const packet = makePacket({ attemptId: 'attempt_1' });

  await bridge.send(packet);
  await assert.rejects(bridge.send(packet), (error) => {
    assert.equal(error.code, 'ATTEMPT_ID_REUSED');
    return true;
  });
  assert.equal(fake.callsOf('POST', '/prompts').length, 1);
});

test('duplicate start/delta/end frames and duplicate message ids deliver one start and one completion', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.setMessages([
    assistantMessage('attempt_1', 'turn_1', 'msg_1', '只交付一次'),
    assistantMessage('attempt_1', 'turn_1', 'msg_1', '只交付一次'),
  ]);

  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit({
    type: 'assistant.delta',
    payload: { prompt_id: 'attempt_1', message_id: 'msg_1', offset: 2, delta: 'B' },
  });
  fake.emit({
    type: 'assistant.delta',
    payload: { prompt_id: 'attempt_1', message_id: 'msg_1', offset: 1, delta: 'A' },
  });
  fake.emit({
    type: 'assistant.delta',
    payload: { prompt_id: 'attempt_1', message_id: 'msg_1', offset: 1, delta: 'DUPLICATE' },
  });
  fake.emit(turnEnd('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));
  fake.emit(turnStart('attempt_1', 'turn_1'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  assert.equal(events.filter((event) => event.type === 'AttemptStarted').length, 1);
  assert.equal(events.filter((event) => event.type === 'AttemptCompleted').length, 1);
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '只交付一次');

  await expectSilence(iterator, 60);
});

test('every transcript request carries agent_id=main by default and honors config.agentId', async () => {
  const { bridge, fake } = await connectedBridge({}, { reconcileAttempts: 1, reconcileRetryDelayMs: 0 });
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_agent', '正文')]);
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));
  await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');

  const transcripts = fake.calls.filter(
    (call) => call.method === 'GET' && call.path.endsWith('/transcript'),
  );
  assert.ok(transcripts.length >= 2, 'baseline and reconciliation both call transcript');
  for (const call of transcripts) {
    assert.equal(new URLSearchParams(call.search).get('agent_id'), 'main');
  }

  const customFake = createFakeKimi();
  const customBridge = makeBridge(customFake, { agentId: 'seat-agent' });
  await customBridge.connect();
  const customTranscripts = customFake.calls.filter((call) => call.path.endsWith('/transcript'));
  assert.equal(new URLSearchParams(customTranscripts[0].search).get('agent_id'), 'seat-agent');

  await customBridge.close();
  await bridge.close();
});

test('reconciliation retries an empty/failed first read and completes with the second response', async () => {
  let messagesReads = 0;
  const fake = createFakeKimi({
    messagesHandler: () => {
      messagesReads += 1;
      return envelope({
        data: {
          messages: messagesReads === 1
            ? []
            : [assistantMessage('attempt_1', 'turn_1', 'msg_retry', '第二次读到的正文')],
        },
      });
    },
  });
  const bridge = makeBridge(fake, { reconcileAttempts: 3, reconcileRetryDelayMs: 0 });
  await bridge.connect();
  await flush();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '第二次读到的正文');
  assert.equal(completed.payload.nativeMessageRef, 'msg_retry');
  assert.equal(messagesReads, 2);
  assert.equal(events.some((event) => event.type === 'AttemptFailed'), false);
  await bridge.close();
});

test('reconciliation retries after a transient read failure and completes with the next response', async () => {
  let messagesReads = 0;
  const fake = createFakeKimi({
    messagesHandler: () => {
      messagesReads += 1;
      if (messagesReads === 1) throw new Error('temporary messages failure');
      return envelope({
        data: {
          messages: [assistantMessage('attempt_1', 'turn_1', 'msg_retry_error', '重试后的正文')],
        },
      });
    },
  });
  const bridge = makeBridge(fake, { reconcileAttempts: 3, reconcileRetryDelayMs: 0 });
  await bridge.connect();
  await flush();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '重试后的正文');
  assert.equal(completed.payload.nativeMessageRef, 'msg_retry_error');
  assert.equal(messagesReads, 2);
  assert.equal(events.some((event) => event.type === 'AttemptFailed'), false);
  await bridge.close();
});

test('completed without any confirmable final text fails with FINAL_TEXT_UNAVAILABLE instead of blank text', async () => {
  const { bridge, fake } = await connectedBridge({}, {
    reconcileAttempts: 3,
    reconcileRetryDelayMs: 0,
  });
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(failed.payload.error.code, 'FINAL_TEXT_UNAVAILABLE');
  assert.equal(failed.payload.error.retryable, true);
  assert.equal(failed.payload.error.details.attempts, 3);
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  assert.equal(bridge.inspect().activeAttemptId, null);
  assert.equal(bridge.inspect().turnMapSize, 0);
  assert.equal(
    fake.calls.filter((call) => call.path.endsWith('/messages')).length,
    3,
  );
  await expectSilence(iterator, 60);
  await bridge.close();
});

test('reconciliation read errors are redacted and preserved in FINAL_TEXT_UNAVAILABLE details', async () => {
  const fake = createFakeKimi();
  const bridge = makeBridge(fake, { reconcileAttempts: 2, reconcileRetryDelayMs: 0 });
  await bridge.connect();
  await flush();
  fake.setMessagesHandler(() => {
    throw new Error(`messages read failed with Bearer ${TOKEN}`);
  });
  fake.setTranscriptHandler(() => {
    throw new Error(`transcript read failed with Bearer ${TOKEN}`);
  });
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(failed.payload.error.code, 'FINAL_TEXT_UNAVAILABLE');
  assert.equal(failed.payload.error.retryable, true);
  assert.equal(failed.payload.error.details.attempts, 2);
  assert.equal(failed.payload.error.details.readErrors.length, 4);
  assert.deepEqual(
    [...new Set(failed.payload.error.details.readErrors.map((detail) => detail.source))].sort(),
    ['messages', 'transcript'],
  );
  assert.equal(JSON.stringify(failed.payload).includes(TOKEN), false);
  assert.equal(bridge.inspect().activeAttemptId, null);
  await bridge.close();
});

test('trusted turn.ended text is used when messages/transcript cannot be read', async () => {
  const fake = createFakeKimi();
  const bridge = makeBridge(fake, { reconcileAttempts: 2, reconcileRetryDelayMs: 0 });
  await bridge.connect();
  await flush();
  fake.setMessagesHandler(() => {
    throw new Error('messages unavailable');
  });
  fake.setTranscriptHandler(() => {
    throw new Error('transcript unavailable');
  });
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1', { kind: 'completed' }, { text: 'turn.ended 的可信正文' }));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, 'turn.ended 的可信正文');
  assert.equal(events.some((event) => event.type === 'AttemptFailed'), false);
  await bridge.close();
});

test('finishing an attempt clears boundKey and turnRef aliases from the turn map', async () => {
  const { bridge, fake } = await connectedBridge({}, {
    reconcileAttempts: 1,
    reconcileRetryDelayMs: 0,
  });
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_map', '映射清理')]);
  fake.emit(turnStart('attempt_1', 'turn_1'));
  await nextEvent(iterator);
  assert.equal(bridge.inspect().turnMapSize, 2, 'prompt and turn aliases are both registered');

  fake.emit(turnEnd('attempt_1', 'turn_1'));
  await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  assert.equal(bridge.inspect().turnMapSize, 0);
  assert.equal(bridge.inspect().activeAttemptId, null);

  // 清理后迟到的重复帧不得重新建映射或变成 ForeignTurn。
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));
  await expectSilence(iterator, 60);
  assert.equal(bridge.inspect().turnMapSize, 0);
  await bridge.close();
});

test('a turn without a pending attempt becomes ForeignTurn only, never subtitles', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  fake.emit(turnStart('someone_else', 'foreign_turn'));
  const events = await takeEvents(iterator, 1);

  assert.equal(events[0].type, 'ForeignTurn');
  assert.equal(events[0].attemptId, null);
  assert.equal(events[0].payload.nativeTurnRef, `${SESSION}#turn:foreign_turn`);
  assert.equal(events[0].payload.reason, 'no-pending-attempt');

  fake.emit(turnEnd('someone_else', 'foreign_turn'));
  await expectSilence(iterator, 60);
});

// ── 断线恢复 ────────────────────────────────────────────────────────────────

test('a prompt that completes while disconnected settles exactly once from messages/snapshot and never replays history', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  const started = await nextEvent(iterator);
  assert.equal(started.type, 'AttemptStarted');

  fake.disconnect();
  fake.setSnapshot({ as_of_seq: 20, epoch: 'epoch_1', in_flight_turn: null });
  fake.setTranscript({ transcript_since: 20, items: [] });
  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_after_reconnect', '断线期间的回复')]);

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '断线期间的回复');
  assert.equal(completed.payload.nativeMessageRef, 'msg_after_reconnect');
  assert.ok(events.some((event) => event.type === 'BridgeError' && event.payload.error.code === 'STREAM_DISCONNECTED'));

  await fake.waitForSockets(2);
  await waitFor(() => bridge.inspect().connected === true, { label: 'first reconnect to finish' });
  const subscribes = fake.framesOf('subscribe_v2');
  assert.equal(subscribes.length, 2);
  assert.deepEqual(subscribes[1].payload.transcript_since, { '*': 20 });

  // 第二次断线：历史已经结算过，不得再发 Completed，也不得把历史当 ForeignTurn 重放。
  fake.setSnapshot({ as_of_seq: 30, epoch: 'epoch_1', in_flight_turn: null });
  fake.setTranscript({ transcript_since: 30, items: [] });
  fake.disconnect();
  await takeUntil(iterator, (event) => event.type === 'BridgeError' && event.payload.error.code === 'STREAM_DISCONNECTED');
  await fake.waitForSockets(3);
  await sleep(30);
  await expectSilence(iterator, 80);
});

test('an abort that landed while disconnected settles as AttemptAborted with partial text', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  await nextEvent(iterator);

  fake.disconnect();
  fake.setSnapshot({
    as_of_seq: 20,
    epoch: 'epoch_1',
    in_flight_turn: null,
    last_turn_reason: 'aborted',
  });
  fake.setTranscript({ transcript_since: 20, items: [] });
  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_partial', '断线前的部分正文')]);

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptAborted');
  const aborted = events.find((event) => event.type === 'AttemptAborted');
  assert.equal(aborted.payload.partialText, '断线前的部分正文');
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  await bridge.close();
});

test('a failed turn recorded in the recovery snapshot settles as AttemptFailed', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  await nextEvent(iterator);

  fake.disconnect();
  fake.setSnapshot({
    as_of_seq: 21,
    epoch: 'epoch_1',
    in_flight_turn: null,
    turns: [{ prompt_id: 'attempt_1', turn_id: 'turn_1', status: 'failed' }],
  });
  fake.setTranscript({ transcript_since: 21, items: [] });

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(failed.payload.error.code, 'TURN_FAILED');
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  await bridge.close();
});

test('recovery associates a real failed transcript turn that used a server triggerPromptId', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 't0'));
  await nextEvent(iterator);

  fake.disconnect();
  const startedAt = new Date(Date.now() + 1000).toISOString();
  const endedAt = new Date(Date.now() + 1100).toISOString();
  fake.setSession(defaultSession({
    busy: false,
    main_turn_active: false,
    current_prompt_id: null,
    last_turn_reason: 'failed',
  }));
  fake.setTranscript({
    agent_id: 'main',
    seq: 20,
    prompts: [{ promptId: 'server_prompt_recovery', status: 'failed' }],
    items: [
      {
        kind: 'turn',
        turnId: 't0',
        triggerPromptId: 'server_prompt_recovery',
        ordinal: 0,
        state: 'failed',
        error: 'Model not set',
        startedAt,
        endedAt,
        steps: [
          {
            kind: 'step',
            stepId: 't0.1',
            turnId: 't0',
            ordinal: 1,
            state: 'interrupted',
            endReason: 'error',
            endMessage: '[model.not_configured] Model not set',
          },
        ],
      },
    ],
  });
  fake.setMessages([]);

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.equal(failed.payload.error.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(bridge.inspect().activeAttemptId, null);
  await bridge.close();
});

test('aborted turns carry partialText only and never produce AttemptCompleted', async () => {  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit({
    type: 'assistant.delta',
    payload: { prompt_id: 'attempt_1', message_id: 'msg_partial', offset: 0, delta: '部分' },
  });
  fake.emit({
    type: 'assistant.delta',
    payload: { prompt_id: 'attempt_1', message_id: 'msg_partial', offset: 1, delta: '正文' },
  });
  fake.emit(turnEnd('attempt_1', 'turn_1', { kind: 'aborted', reason: { kind: 'user' } }));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptAborted');
  const aborted = events.find((event) => event.type === 'AttemptAborted');
  assert.equal(aborted.payload.partialText, '部分正文');
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
  assert.equal('text' in aborted.payload, false);

  await expectSilence(iterator, 60);
});

test('failed turns map to AttemptFailed with a structured error', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1', { kind: 'failed' }, {
    error: { code: 'MODEL_ERROR', message: 'upstream failed', retryable: true },
  }));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptFailed');
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.deepEqual(failed.payload.error, {
    code: 'MODEL_ERROR',
    message: 'upstream failed',
    retryable: true,
  });
  assert.equal(events.some((event) => event.type === 'AttemptCompleted'), false);
});

// ── 取消 ────────────────────────────────────────────────────────────────────

test('cancel clears queued prompts in order before session :abort, then waits for real settlement', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  await bridge.send(makePacket({ attemptId: 'attempt_1', turnId: 'turn_1' }));
  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_1', '第一轮')]);
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));
  await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');

  await bridge.send(makePacket({ attemptId: 'attempt_2', turnId: 'turn_2' }));
  fake.setQueue([
    { prompt_id: 'attempt_1', status: 'queued' },
    { prompt_id: 'attempt_2', status: 'queued' },
    { prompt_id: 'foreign_prompt', status: 'queued' },
  ]);

  const receipt = await bridge.cancel('attempt_2');
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.settlement, 'pending');

  const promptAborts = fake.promptAborts();
  assert.deepEqual(
    promptAborts.map((call) => call.path),
    [
      `/api/v1/sessions/${SESSION}/prompts/attempt_1:abort`,
      `/api/v1/sessions/${SESSION}/prompts/attempt_2:abort`,
    ],
  );
  assert.equal(fake.sessionAborts().length, 1);
  const lastPromptAbortIndex = fake.calls.indexOf(promptAborts.at(-1));
  const sessionAbortIndex = fake.calls.indexOf(fake.sessionAborts()[0]);
  assert.ok(sessionAbortIndex > lastPromptAbortIndex, 'session :abort must run after queued prompt aborts');
  assert.equal(promptAborts.some((call) => call.path.includes('foreign_prompt')), false);

  fake.emit(turnEnd('attempt_2', 'turn_2', { kind: 'aborted', reason: { kind: 'user' } }));
  await takeUntil(iterator, (event) => event.type === 'AttemptAborted');

  const callsBefore = fake.calls.length;
  const confirmed = await bridge.cancel('attempt_2');
  assert.equal(confirmed.settlement, 'confirmed');
  assert.equal(fake.calls.length, callsBefore, 'idempotent cancel must not issue more RPCs');
});

test('concurrent cancel is idempotent and issues one queue clear plus one session abort', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.setQueue([{ prompt_id: 'attempt_1', status: 'queued' }]);

  const [first, second] = await Promise.all([bridge.cancel('attempt_1'), bridge.cancel('attempt_1')]);
  assert.deepEqual(first, second);
  assert.equal(fake.promptAborts().length, 1);
  assert.equal(fake.sessionAborts().length, 1);

  fake.emit(turnEnd('attempt_1', 'turn_1', { kind: 'aborted' }));
  await takeUntil(iterator, (event) => event.type === 'AttemptAborted');
  assert.equal((await bridge.cancel('attempt_1')).settlement, 'confirmed');
});

test('cancel reports unknown and already-finished attempts without emitting events', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  const unknown = await bridge.cancel('missing');
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.settlement, 'failed');
  assert.equal(unknown.error.code, 'ATTEMPT_NOT_FOUND');

  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_1', 'done')]);
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));
  await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');

  const callsBefore = fake.calls.length;
  const finished = await bridge.cancel('attempt_1');
  assert.equal(finished.accepted, false);
  assert.equal(finished.settlement, 'failed');
  assert.equal(finished.error.code, 'ATTEMPT_ALREADY_FINISHED');
  assert.equal(fake.calls.length, callsBefore);
  await expectSilence(iterator, 60);
});

// ── 用量、扁平帧与 transcript.reset ────────────────────────────────────────

test('UsageReported maps real snapshot usage and is emitted before subscribe consumption', async () => {
  const { bridge } = await connectedBridge({
    snapshot: {
      as_of_seq: 3,
      epoch: 'epoch_1',
      in_flight_turn: null,
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_write_tokens: 4,
        total_tokens: 19,
      },
    },
  });

  const [event] = await takeEvents(bridge.subscribe(), 1);
  assert.equal(event.type, 'UsageReported');
  assert.deepEqual(event.payload.usage, {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 19,
  });
  assert.equal(event.payload.usageQuality, 'exact');
  assert.equal(event.payload.usageKnown, true);
  assert.equal(event.payload.usageSource, 'snapshot');
  assert.equal(event.attemptId, null);
});

test('flat agent/usage frames and payload transcript.reset are handled without breaking the text turn', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));

  fake.emit({ type: 'agent', busy: true, current_prompt_id: 'attempt_1', turn_id: 'turn_1' });
  const started = await nextEvent(iterator);
  assert.equal(started.type, 'AttemptStarted');

  fake.emit({ type: 'usage', prompt_id: 'attempt_1', input_tokens: 5, output_tokens: 1 });
  fake.emit({ type: 'transcript.reset', payload: { transcript_since: 12, messages: [] } });
  await flush();
  assert.equal(bridge.inspect().baseline.transcriptSince, 12);

  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_flat', '扁平帧之后的正文')]);
  fake.emit(turnEnd('attempt_1', 'turn_1'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  const completed = events.find((event) => event.type === 'AttemptCompleted');
  assert.equal(completed.payload.text, '扁平帧之后的正文');
  assert.deepEqual(completed.payload.usage, {
    inputTokens: 5,
    outputTokens: 1,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
  });
});

// ── 语音与关闭 ──────────────────────────────────────────────────────────────

test('Kimi Code bridge has no voice: setMuted is unsupported and no Speech events are ever emitted', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  assert.deepEqual(await bridge.setMuted(true), { supported: false, capability: 'voiceMute' });
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.setMessages([assistantMessage('attempt_1', 'turn_1', 'msg_1', '仅文本')]);
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));

  const events = await takeUntil(iterator, (event) => event.type === 'AttemptCompleted');
  assert.equal(events.some((event) => event.type.startsWith('Speech')), false);
  await expectSilence(iterator, 60);
});

test('close interrupts reconciliation retry backoff and leaves no dangling work', async () => {
  const { bridge, fake } = await connectedBridge({}, {
    reconcileAttempts: 5,
    reconcileRetryDelayMs: 1000,
  });
  bridge.subscribe();
  await bridge.send(makePacket({ attemptId: 'attempt_1' }));
  fake.emit(turnStart('attempt_1', 'turn_1'));
  fake.emit(turnEnd('attempt_1', 'turn_1'));
  await sleep(30);

  const startedAt = Date.now();
  await bridge.close();
  assert.ok(Date.now() - startedAt < 400, 'close must not wait for the 1s reconcile backoff');
  assert.equal(fake.sockets[0].readyState, 3);
  assert.equal(bridge.inspect().closed, true);
});

test('close is idempotent, unsubscribes, closes WS 1000, waits for exit, and never shuts down or archives', async () => {
  const { bridge, fake } = await connectedBridge();
  const iterator = bridge.subscribe();

  const closePromise = bridge.close();
  const closed = await nextEvent(iterator);
  assert.equal(closed.type, 'BridgeClosed');
  assert.equal(closed.payload.reason, 'closed');
  await closePromise;

  assert.equal(fake.framesOf('unsubscribe_v2').length, 1);
  assert.equal(fake.sockets.length, 1);
  assert.equal(fake.sockets[0].readyState, 3);
  assert.equal(fake.calls.some((call) => /shutdown|archive/.test(call.path)), false);
  assert.equal(bridge.inspect().reconnectRunning, false);
  assert.equal(bridge.inspect().streamOpen, false);

  const socketsBefore = fake.sockets.length;
  assert.equal(await bridge.close(), await closePromise);
  await sleep(40);
  assert.equal(fake.sockets.length, socketsBefore, 'close must not leave a reconnect loop running');
});

// ── 错误脱敏 ────────────────────────────────────────────────────────────────

test('transport and envelope errors are redacted and never expose the bearer token', async () => {
  const transportError = createFakeKimi({ fetchError: `network failed with Bearer ${TOKEN}` });
  const bridge = makeBridge(transportError);
  await assert.rejects(bridge.probe(), (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.message.includes(TOKEN), false);
    assert.match(error.message, /Bearer \*\*\*/);
    return true;
  });

  const envelopeError = createFakeKimi({
    sessionErrorCode: 40101,
    sessionErrorMessage: `bad token Bearer ${TOKEN}`,
  });
  const bridge2 = makeBridge(envelopeError);
  await assert.rejects(bridge2.probe(), (error) => {
    assert.equal(error.code, 'AUTH_FAILED');
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });

  assert.equal(redact(`Bearer ${TOKEN}`, TOKEN), 'Bearer ***');
  assert.equal(redact(`kimi-code.bearer.${TOKEN}`, TOKEN).includes(TOKEN), false);
});

test('token resolution accepts an explicit token and never requires the token file when transport is injected', async () => {
  assert.equal(await resolveToken({ token: 'inline', env: {} }), 'inline');
  const fake = createFakeKimi();
  const bridge = createKimiCodeBridge({
    seatId: SEAT,
    nativeSessionRef: SESSION,
    transport: fake.transport,
    token: '',
  });
  const client = await bridge._resolveClient({ transport: fake.transport });
  assert.equal(client.token, '');
  assert.ok(client instanceof KimiCodeClient);
  assert.ok(new KimiApiError('x', { code: 40931 }).retryable === false);
});
