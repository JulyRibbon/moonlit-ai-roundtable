import test from 'node:test';
import assert from 'node:assert/strict';

import { QwenCodeBridge, isTransientAttachError, readModelState, readPersonaRef, textOfContent } from '../../adapters/qwen-code/bridge.mjs';
import { QwenDaemonError } from '../../adapters/qwen-code/client.mjs';

const SESSION = 'sess-qwen-1';
const CWD = 'C:\\KIMIW\\ai-room\\rooms\\r_main\\qwen';

function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, { timeoutMs = 1000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${label}`);
    await tick(2);
  }
}

function makeFakeClient(options = {}) {
  const calls = [];
  const queue = [];
  let wake = null;
  let closed = false;
  let streamInfo = { streamId: 'stream-1', epoch: 'epoch-1' };
  const client = {
    clientId: null,
    async health() {
      calls.push(['health']);
      if (options.healthError) throw new QwenDaemonError('daemon down', { code: 'QWEN_DAEMON_UNREACHABLE' });
      return { status: 200, body: { status: 'ok' } };
    },
    async capabilities() {
      calls.push(['capabilities']);
      return {
        status: 200,
        body: { v: 1, qwenCodeVersion: '0.27.1', features: ['session_id_override'] },
      };
    },
    async sessionStatus(sessionId) {
      calls.push(['status', sessionId]);
      if (options.status) return options.status(sessionId);
      return { status: 200, body: { sessionId, hasActivePrompt: false } };
    },
    async sessionContext(sessionId) {
      calls.push(['context', sessionId]);
      return {
        status: 200,
        body: {
          state: {
            models: { currentModelId: 'qwen3.8-flash(openai)' },
            configOptions: [
              { id: 'reasoning_effort', currentValue: 'low' },
              { id: 'mode', currentValue: 'auto' },
            ],
          },
        },
      };
    },
    async createOrAttachSession({ cwd, sessionId } = {}) {
      calls.push(['createOrAttach', { cwd, sessionId: sessionId ?? null }]);
      const returnedId = sessionId ?? SESSION;
      if (options.attachSessionId !== undefined) {
        client.clientId = 'client-assigned';
        return { status: 200, body: { sessionId: options.attachSessionId, attached: true, clientId: 'client-assigned' } };
      }
      client.clientId = 'client-assigned';
      return {
        status: 200,
        body: {
          sessionId: returnedId,
          attached: sessionId === undefined,
          clientId: 'client-assigned',
        },
      };
    },
    async resumeSession(sessionId, { cwd } = {}) {
      calls.push(['resume', sessionId, cwd ?? null]);
      const failure = options.resumeErrors?.length
        ? options.resumeErrors.shift()
        : options.resumeError;
      if (failure) throw failure;
      client.clientId = 'client-resumed';
      return {
        status: 200,
        body: {
          sessionId: options.resumeSessionId ?? sessionId,
          workspaceCwd: cwd,
          attached: options.resumeAttached ?? false,
          clientId: 'client-resumed',
        },
      };
    },
    async workspaceAcpPreheat({ timeoutMs } = {}) {
      calls.push(['preheat', timeoutMs ?? null]);
      if (options.preheatError) throw options.preheatError;
      return { status: 200, body: { ready: true, channelLive: true, durationMs: 5 } };
    },
    async prompt(sessionId, { text, idempotencyKey } = {}) {
      calls.push(['prompt', sessionId, text, idempotencyKey]);
      const failure = options.promptErrors?.length
        ? options.promptErrors.shift()
        : options.promptError;
      if (failure) throw failure;
      return options.promptResult ?? {
        status: 202,
        body: { promptId: 'prompt-1', lastEventId: 5, eventEpoch: 'epoch-1' },
      };
    },
    async cancel(sessionId) {
      calls.push(['cancel', sessionId]);
      if (options.cancelError) throw options.cancelError;
      return { status: 204, body: null };
    },
    async *subscribeEvents(sessionId, { signal, lastEventId, onStreamInfo } = {}) {
      calls.push(['subscribe', sessionId, lastEventId ?? null]);
      const failure = options.subscribeErrors?.length
        ? options.subscribeErrors.shift()
        : options.subscribeError;
      if (failure) throw failure;
      onStreamInfo?.(streamInfo);
      for (;;) {
        if (closed || signal?.aborted) return;
        if (queue.length > 0) {
          const event = queue.shift();
          yield event;
          if (event.type === 'session_died' || event.type === 'session_closed') return;
          continue;
        }
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  if (options.noResume) delete client.resumeSession;
  const push = (event) => {
    queue.push(event);
    const w = wake;
    wake = null;
    w?.();
  };
  const shutdown = () => {
    closed = true;
    const w = wake;
    wake = null;
    w?.();
  };
  const setStreamInfo = (info) => {
    streamInfo = info;
  };
  return { client, calls, push, shutdown, setStreamInfo };
}

function makeBridge(fake, overrides = {}) {
  return new QwenCodeBridge({
    seatId: 'qwen',
    nativeSessionRef: SESSION,
    baseUrl: 'http://127.0.0.1:1',
    cwd: CWD,
    clientFactory: () => fake.client,
    sleep: async () => {},
    connectTimeoutMs: 50,
    reconnectDelayMs: 1,
    ...overrides,
  });
}

const PACKET = {
  roomId: 'r_main',
  roomSeq: 1,
  turnId: 'turn-1',
  attemptId: 'a_1',
  seatId: 'qwen',
  contextEpoch: 'epoch-1',
  text: '你好',
};

async function collectEvents(bridge, count, { timeoutMs = 1000 } = {}) {
  const subscription = bridge.subscribe();
  const events = [];
  const iterator = subscription[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  while (events.length < count) {
    if (Date.now() >= deadline) throw new Error(`timeout collecting events (${events.length}/${count})`);
    const next = await Promise.race([
      iterator.next(),
      tick(20).then(() => ({ timeout: true })),
    ]);
    if (next?.timeout) continue;
    if (next.done) break;
    events.push(next.value);
  }
  await subscription.return?.();
  return events;
}

test('QwenCodeBridge implements every Bridge v1 method', () => {
  const bridge = makeBridge(makeFakeClient());
  for (const method of ['probe', 'connect', 'getIdentity', 'send', 'subscribe', 'cancel', 'setMuted', 'close']) {
    assert.equal(typeof bridge[method], 'function', `missing ${method}`);
  }
});

test('probe is read-only, reports real capabilities, and never creates or prompts', async () => {
  const fake = makeFakeClient({ status: () => { throw new QwenDaemonError('not found', { status: 404, code: 'session_not_found' }); } });
  const bridge = makeBridge(fake);
  const result = await bridge.probe();
  assert.equal(result.capabilities.nativeSession, true);
  assert.equal(result.capabilities.sendToExistingSession, true);
  assert.equal(result.capabilities.finalMessageEvent, true);
  assert.equal(result.capabilities.queueClear, false);
  assert.equal(result.capabilities.providerUsage, null);
  assert.equal(result.capabilities.voiceTrigger, false);
  assert.equal(result.voiceMode, 'external');
  assert.equal(result.clientVersion, '0.27.1');
  assert.ok(result.warnings.some((w) => /不在守护进程内存/.test(w)));
  assert.equal(fake.calls.some(([name]) => name === 'createOrAttach' || name === 'prompt'), false);
});

test('probe exposes native model, reasoning effort and persona reference when the session is live', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  const result = await bridge.probe();
  assert.equal(result.identity.metadata.sessionId, SESSION);
  assert.equal(result.identity.metadata.model, 'qwen3.8-flash(openai)');
  assert.equal(result.identity.metadata.reasoningEffort, 'low');
  assert.match(result.identity.sourceRef, /\.qwen[\\/]QWEN\.md$/);
  assert.ok(!JSON.stringify(result.identity).includes('本小姐'), 'identity 不得复制人格正文');
});

test('connect requires nativeSessionRef and never invents a session', async () => {
  const bridge = new QwenCodeBridge({
    seatId: 'qwen',
    baseUrl: 'http://127.0.0.1:1',
    clientFactory: () => makeFakeClient().client,
    sleep: async () => {},
  });
  await assert.rejects(() => bridge.connect({ cwd: CWD }), (error) => error.code === 'SESSION_REQUIRED');
});

test('connect restores a persisted session by id (resume, never create)', async () => {
  const fake = makeFakeClient({ status: () => { throw new QwenDaemonError('not found', { status: 404 }); } });
  const bridge = makeBridge(fake);
  await bridge.connect({ cwd: CWD });
  const resume = fake.calls.find(([name]) => name === 'resume');
  assert.deepEqual(resume, ['resume', SESSION, CWD]);
  assert.equal(fake.calls.some(([name]) => name === 'createOrAttach'), false);
  const identity = await bridge.getIdentity();
  assert.equal(identity.nativeSessionRef, SESSION);
  await bridge.close();
});

test('connect reports a clear error when resume cannot restore the session', async () => {
  const fake = makeFakeClient({
    status: () => { throw new QwenDaemonError('not found', { status: 404 }); },
    resumeError: new QwenDaemonError('session gone', { status: 404, code: 'session_not_found' }),
  });
  const bridge = makeBridge(fake);
  await assert.rejects(
    () => bridge.connect({ cwd: CWD }),
    (error) => {
      assert.equal(error.code, 'SESSION_NOT_FOUND');
      assert.match(error.message, /session gone/);
      return true;
    },
  );
});

test('transient initialize timeout preheats ACP once and resumes once', async () => {
  const fake = makeFakeClient({
    status: () => { throw new QwenDaemonError('not found', { status: 404 }); },
    resumeErrors: [
      new QwenDaemonError('ACP initialize timed out', { status: 504, code: 'session_initialization_timeout' }),
    ],
  });
  const bridge = makeBridge(fake, { preheatTimeoutMs: 45000 });
  await bridge.connect({ cwd: CWD });
  const names = fake.calls.map(([name]) => name).filter((name) => name !== 'subscribe');
  assert.deepEqual(names, ['health', 'status', 'resume', 'preheat', 'resume', 'context']);
  assert.deepEqual(fake.calls.find(([name]) => name === 'preheat'), ['preheat', 45000]);
  await bridge.close();
});

test('transient failure that survives the retry becomes SESSION_RESUME_FAILED (retryable)', async () => {
  const timeout = () => new QwenDaemonError(
    'initialize timeout',
    { status: 504, code: 'session_initialization_timeout' },
  );
  const fake = makeFakeClient({
    status: () => { throw new QwenDaemonError('not found', { status: 404 }); },
    resumeErrors: [timeout(), timeout()],
  });
  const bridge = makeBridge(fake);
  await assert.rejects(
    () => bridge.connect({ cwd: CWD }),
    (error) => {
      assert.equal(error.code, 'SESSION_RESUME_FAILED');
      assert.equal(error.retryable, true);
      assert.equal(error.details.phase, 'resume');
      assert.doesNotMatch(error.message, /SESSION_NOT_FOUND/);
      return true;
    },
  );
  assert.equal(fake.calls.filter(([name]) => name === 'resume').length, 2);
  assert.equal(fake.calls.filter(([name]) => name === 'preheat').length, 1);
});

test('preheat failure is reported as SESSION_RESUME_FAILED without a second resume', async () => {
  const fake = makeFakeClient({
    status: () => { throw new QwenDaemonError('not found', { status: 404 }); },
    resumeErrors: [
      new QwenDaemonError('ACP initialize timed out', { status: 504, code: 'session_initialization_timeout' }),
    ],
    preheatError: new QwenDaemonError('ACP preheat failed', { code: 'QWEN_ACP_PREHEAT_FAILED' }),
  });
  const bridge = makeBridge(fake);
  await assert.rejects(
    () => bridge.connect({ cwd: CWD }),
    (error) => {
      assert.equal(error.code, 'SESSION_RESUME_FAILED');
      assert.equal(error.retryable, true);
      assert.equal(error.details.phase, 'preheat');
      return true;
    },
  );
  assert.equal(fake.calls.filter(([name]) => name === 'resume').length, 1);
});

test('non-transient resume failures keep SESSION_NOT_FOUND and are not retried', async () => {
  const fake = makeFakeClient({
    status: () => { throw new QwenDaemonError('not found', { status: 404 }); },
    resumeError: new QwenDaemonError('invalid request', { status: 400, code: 'invalid_request' }),
  });
  const bridge = makeBridge(fake);
  await assert.rejects(
    () => bridge.connect({ cwd: CWD }),
    (error) => {
      assert.equal(error.code, 'SESSION_NOT_FOUND');
      assert.equal(error.retryable, false);
      return true;
    },
  );
  assert.equal(fake.calls.filter(([name]) => name === 'resume').length, 1);
  assert.equal(fake.calls.filter(([name]) => name === 'preheat').length, 0);
});

test('isTransientAttachError classifies timeouts/network errors but not 4xx', () => {
  assert.equal(isTransientAttachError(Object.assign(new Error('init'), { name: 'BridgeTimeoutError' })), true);
  assert.equal(isTransientAttachError(new QwenDaemonError('x', { code: 'session_initialization_timeout' })), true);
  assert.equal(isTransientAttachError(new QwenDaemonError('initialize timeout', { status: 504 })), true);
  assert.equal(isTransientAttachError(new QwenDaemonError('x', { code: 'QWEN_DAEMON_UNREACHABLE' })), true);
  assert.equal(isTransientAttachError(new QwenDaemonError('x', { status: 404, code: 'session_not_found' })), false);
  assert.equal(isTransientAttachError(new QwenDaemonError('x', { status: 400, code: 'invalid_request' })), false);
  assert.equal(isTransientAttachError(null), false);
});

test('connect attaches a live session by id via resume, never createOrAttach without an id', async () => {
  const fake = makeFakeClient({ resumeAttached: true });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const resume = fake.calls.find(([name]) => name === 'resume');
  assert.deepEqual(resume, ['resume', SESSION, CWD]);
  assert.equal(fake.calls.some(([name]) => name === 'createOrAttach'), false);
  const snapshot = bridge.snapshot();
  assert.equal(snapshot.nativeSessionRef, SESSION);
  assert.equal(snapshot.connected, true);
  await bridge.close();
});

test('live resume that returns another id is rejected as SESSION_MISMATCH', async () => {
  const fake = makeFakeClient({ resumeSessionId: 'sess-other' });
  const bridge = makeBridge(fake);
  await assert.rejects(
    () => bridge.connect(),
    (error) => {
      assert.equal(error.code, 'SESSION_MISMATCH');
      assert.match(error.message, /sess-other/);
      return true;
    },
  );
  assert.equal(fake.calls.some(([name]) => name === 'createOrAttach'), false);
});

test('live attach retries once through ACP preheat on a transient resume failure', async () => {
  const fake = makeFakeClient({
    resumeAttached: true,
    resumeErrors: [
      new QwenDaemonError('ACP initialize timed out', { status: 504, code: 'session_initialization_timeout' }),
    ],
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const names = fake.calls.map(([name]) => name).filter((name) => name !== 'subscribe');
  assert.deepEqual(names, ['health', 'status', 'resume', 'preheat', 'resume', 'context']);
  await bridge.close();
});

test('live fallback without a resume method still never invents a session id', async () => {
  const fake = makeFakeClient({ noResume: true });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const attach = fake.calls.find(([name]) => name === 'createOrAttach');
  assert.deepEqual(attach[1], { cwd: CWD, sessionId: null });
  await bridge.close();
});

test('connect reports an unreachable daemon clearly', async () => {
  const fake = makeFakeClient({ healthError: true });
  const bridge = makeBridge(fake);
  await assert.rejects(() => bridge.connect(), (error) => error.code === 'QWEN_DAEMON_UNREACHABLE');
});

test('explicit native session creation keeps cwd and confirms the new session', async () => {
  const fake = makeFakeClient({ attachSessionId: 'sess_created' });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const result = await bridge.createNativeSession();
  assert.equal(result.nativeSessionRef, 'sess_created');
  const created = fake.calls.find(([name]) => name === 'createOrAttach');
  assert.deepEqual(created[1], { cwd: CWD, sessionId: null });
  assert.equal(fake.calls.some(([name]) => name === 'prompt'), false);
  await bridge.close();
});

test('send before connect fails and send after connect registers the attempt before prompt', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  await assert.rejects(() => bridge.send(PACKET), (error) => error.code === 'BRIDGE_NOT_CONNECTED');
  await bridge.connect();
  const receipt = await bridge.send(PACKET);
  assert.equal(receipt.accepted, true);
  const prompt = fake.calls.find(([name]) => name === 'prompt');
  assert.equal(prompt[3], 'a_1', 'idempotencyKey 必须是 attemptId');
  await bridge.close();
});

test('a rejected session_not_found prompt recovers the same session and retries once', async () => {
  const missing = new QwenDaemonError('No session with id "sess-qwen-1"', {
    status: 404,
    code: 'session_not_found',
  });
  let statusCalls = 0;
  const fake = makeFakeClient({
    promptErrors: [missing],
    status: (sessionId) => {
      statusCalls += 1;
      if (statusCalls > 1) throw missing;
      return { status: 200, body: { sessionId, hasActivePrompt: false } };
    },
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 1, { timeoutMs: 2000 });
  const receipt = await bridge.send(PACKET);
  const events = await eventsPromise;

  assert.equal(receipt.accepted, true);
  assert.equal(events[0].type, 'AttemptStarted');
  const prompts = fake.calls.filter(([name]) => name === 'prompt');
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts.map((call) => call[3]), ['a_1', 'a_1']);
  assert.equal(fake.calls.filter(([name]) => name === 'resume').length, 2);
  const subscriptions = fake.calls.filter(([name]) => name === 'subscribe');
  assert.equal(subscriptions.length, 2);
  assert.equal(subscriptions[1][2], null, '恢复后使用新事件基线，不续用死亡通道游标');
  await bridge.close();
});

test('session_died restores the event stream without replaying an accepted prompt', async () => {
  const missing = new QwenDaemonError('No session with id "sess-qwen-1"', {
    status: 404,
    code: 'session_not_found',
  });
  let statusCalls = 0;
  const fake = makeFakeClient({
    subscribeErrors: [undefined, missing],
    status: (sessionId) => {
      statusCalls += 1;
      if (statusCalls > 1) throw missing;
      return { status: 200, body: { sessionId, hasActivePrompt: false } };
    },
  });
  const bridge = makeBridge(fake);
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 3, { timeoutMs: 2000 });
  const receipt = await bridge.send(PACKET);
  assert.equal(receipt.accepted, true);
  fake.push({ v: 1, id: 6, type: 'session_died', data: {} });

  await waitFor(() => fake.calls.filter(([name]) => name === 'subscribe').length === 3, {
    timeoutMs: 2000,
    label: 'same-id event stream recovery',
  });
  const events = await eventsPromise;
  assert.deepEqual(events.map((event) => event.type), [
    'AttemptStarted',
    'BridgeError',
    'AttemptFailed',
  ]);
  assert.equal(events[2].payload.error.code, 'QWEN_SESSION_GONE');
  assert.equal(fake.calls.filter(([name]) => name === 'prompt').length, 1, '202 已接受的请求不得重放');
  assert.equal(fake.calls.filter(([name]) => name === 'resume').length, 2);
  assert.equal(bridge.snapshot().connected, true);
  await bridge.close();
});

test('assistant text chunks accumulate and turn_complete settles AttemptCompleted exactly once', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 2, { timeoutMs: 2000 });
  await bridge.send(PACKET);
  await tick(10);
  fake.push({
    v: 1,
    id: 6,
    type: 'session_update',
    data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你好' } } },
  });
  fake.push({
    v: 1,
    id: 7,
    type: 'session_update',
    data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '呀' } } },
  });
  fake.push({ v: 1, id: 8, type: 'turn_complete', data: { promptId: 'prompt-1', stopReason: 'end_turn' } });
  // 重复终态不应再发一次完成
  fake.push({ v: 1, id: 9, type: 'turn_complete', data: { promptId: 'prompt-1', stopReason: 'end_turn' } });
  const events = await eventsPromise;
  const started = events.filter((event) => event.type === 'AttemptStarted');
  const completed = events.filter((event) => event.type === 'AttemptCompleted');
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].payload.text, '你好呀');
  assert.match(completed[0].payload.nativeTurnRef, /#prompt:prompt-1$/);
  await bridge.close();
});

test('unknown promptId becomes ForeignTurn and is deduplicated', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 1, { timeoutMs: 2000 });
  fake.push({ v: 1, id: 1, type: 'turn_complete', data: { promptId: 'foreign-1', stopReason: 'end_turn' } });
  fake.push({ v: 1, id: 2, type: 'turn_complete', data: { promptId: 'foreign-1', stopReason: 'end_turn' } });
  const events = await eventsPromise;
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ForeignTurn');
  await bridge.close();
});

test('turn_error maps to AttemptFailed with the daemon error', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 2, { timeoutMs: 2000 });
  await bridge.send(PACKET);
  await tick(10);
  fake.push({
    v: 1,
    id: 2,
    type: 'turn_error',
    data: { promptId: 'prompt-1', code: 'MODEL_OVERLOADED', message: 'busy', retryable: true },
  });
  const events = await eventsPromise;
  const failed = events.find((event) => event.type === 'AttemptFailed');
  assert.ok(failed);
  assert.equal(failed.payload.error.code, 'MODEL_OVERLOADED');
  assert.equal(failed.payload.error.retryable, true);
  await bridge.close();
});

test('interrupted turn maps to AttemptAborted with partial text', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 2, { timeoutMs: 2000 });
  await bridge.send(PACKET);
  await tick(10);
  fake.push({
    v: 1,
    id: 2,
    type: 'session_update',
    data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '说到一半' } } },
  });
  fake.push({ v: 1, id: 3, type: 'turn_complete', data: { promptId: 'prompt-1', stopReason: 'interrupted' } });
  const events = await eventsPromise;
  const aborted = events.find((event) => event.type === 'AttemptAborted');
  assert.ok(aborted);
  assert.equal(aborted.payload.partialText, '说到一半');
  await bridge.close();
});

test('cancel is idempotent: accepted marks pending, then the event confirms settlement', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 2, { timeoutMs: 2000 });
  await bridge.send(PACKET);
  await tick(10);
  const receipt = await bridge.cancel('a_1');
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.settlement, 'pending');
  assert.ok(fake.calls.some(([name]) => name === 'cancel'));
  fake.push({ v: 1, id: 4, type: 'turn_complete', data: { promptId: 'prompt-1', stopReason: 'interrupted' } });
  const events = await eventsPromise;
  assert.ok(events.some((event) => event.type === 'AttemptAborted'));
  const again = await bridge.cancel('a_1');
  assert.equal(again.settlement, 'confirmed');
  await bridge.close();
});

test('cancel of an unknown attempt is a clear failure, not a throw', async () => {
  const bridge = makeBridge(makeFakeClient());
  const receipt = await bridge.cancel('missing');
  assert.equal(receipt.accepted, false);
  assert.equal(receipt.settlement, 'failed');
  assert.equal(receipt.error.code, 'ATTEMPT_NOT_RUNNING');
  await bridge.close();
});

test('setMuted is explicitly unsupported and close blocks later sends', async () => {
  const fake = makeFakeClient();
  const bridge = makeBridge(fake);
  const muted = await bridge.setMuted(true);
  assert.equal(muted.supported, false);
  assert.equal(muted.capability, 'voiceMute');
  await bridge.connect();
  const eventsPromise = collectEvents(bridge, 1, { timeoutMs: 2000 });
  await bridge.close();
  const events = await eventsPromise;
  assert.equal(events[0].type, 'BridgeClosed');
  await assert.rejects(() => bridge.send(PACKET), (error) => error.code === 'BRIDGE_CLOSED');
});

test('helpers: textOfContent, readModelState and readPersonaRef are pure', () => {
  assert.equal(textOfContent([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(textOfContent({ text: 'x' }), 'x');
  const model = readModelState({
    state: {
      models: { currentModelId: 'qwen3.8-flash(openai)' },
      configOptions: [
        { id: 'reasoning_effort', currentValue: 'low' },
        { id: 'mode', currentValue: 'auto' },
      ],
    },
  });
  assert.deepEqual(model, {
    modelId: 'qwen3.8-flash(openai)',
    reasoningEffort: 'low',
    permissionMode: 'auto',
  });
  const persona = readPersonaRef();
  assert.match(persona.sourceRef, /QWEN\.md$/);
  assert.ok(['missing'].includes(persona.revision) || /^[0-9a-f]{64}$/.test(persona.revision));
});
