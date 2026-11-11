import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeEvent } from '../../core/events.mjs';
import {
  ABORT_PROMPT,
  DEFAULT_CLOSE_TIMEOUT_MS,
  SHORT_PROMPT,
  parseArgs,
  runCli,
  runProbe,
  validateOptions,
} from '../../probes/live-short-reply.mjs';

// 全部测试只注入离线 fake bridge：不启动 ZCode 子进程、不连 2955/58690、
// 不读 token 文件、不产生任何模型调用。

const SEAT_PREFIX = 'live-short-reply';

function makeEvent(type, seatId, attemptId, payload = {}) {
  return createBridgeEvent({ type, seatId, attemptId, payload });
}

function createFakeBridge(config, script = {}) {
  const calls = [];
  const seatId = config.seatId;
  let subscriber = null;
  let closed = false;

  function emit(event) {
    if (!subscriber) throw new Error('fake emitted before subscribe');
    subscriber.push(event);
  }

  const bridge = {
    config,
    calls,
    get closed() {
      return closed;
    },
    async connect(connectConfig) {
      calls.push({ name: 'connect', config: connectConfig });
      if (script.connect) await script.connect(connectConfig, { bridge, emit });
    },
    subscribe() {
      calls.push({ name: 'subscribe' });
      let queue = [];
      let wake = null;
      let done = false;
      subscriber = {
        push(event) {
          queue.push(event);
          const resume = wake;
          wake = null;
          resume?.();
        },
        close() {
          done = true;
          const resume = wake;
          wake = null;
          resume?.();
        },
        async next() {
          while (queue.length === 0 && !done) {
            await new Promise((resolve) => {
              wake = resolve;
            });
          }
          if (queue.length > 0) return { value: queue.shift(), done: false };
          return { value: undefined, done: true };
        },
        async return() {
          done = true;
          const resume = wake;
          wake = null;
          resume?.();
          return { value: undefined, done: true };
        },
      };
      return subscriber;
    },
    async send(packet) {
      calls.push({ name: 'send', packet });
      if (!subscriber) throw new Error('send before subscribe');
      if (script.send) await script.send(packet, { bridge, emit, seatId });
      return { attemptId: packet.attemptId, accepted: true, nativeRequestRef: 'fake-request' };
    },
    async cancel(attemptId) {
      calls.push({ name: 'cancel', attemptId });
      if (script.cancel) return script.cancel(attemptId, { bridge, emit, seatId });
      return { attemptId, accepted: true, settlement: 'pending' };
    },
    async close() {
      calls.push({ name: 'close' });
      closed = true;
      subscriber?.close();
    },
  };
  return bridge;
}

function makeFactory(script = {}) {
  const state = { config: null, bridge: null, calls: 0 };
  const factory = (config) => {
    state.calls += 1;
    state.config = config;
    state.bridge = createFakeBridge(config, script);
    return state.bridge;
  };
  return { factory, state };
}

function factoriesWith(client, script) {
  return { [client]: makeFactory(script).factory };
}

async function run(argv, options = {}) {
  let out = '';
  let err = '';
  const code = await runCli(argv, {
    closeTimeoutMs: 1000,
    ...options,
    io: {
      out: (line) => {
        out += `${line}\n`;
      },
      err: (line) => {
        err += `${line}\n`;
      },
    },
  });
  return { code, out, err };
}

function parseJsonOut(result) {
  return JSON.parse(result.out);
}

function baseArgs(client = 'dsh') {
  return ['--client', client, '--session', 'session-real-001', '--allow-cost'];
}

function completedScript(usage = null) {
  return {
    send(packet, { emit, seatId }) {
      emit(makeEvent('AttemptStarted', seatId, packet.attemptId, { nativeTurnRef: 'native#turn:1' }));
      if (usage) emit(makeEvent('UsageReported', seatId, null, { usage }));
      emit(makeEvent('AttemptCompleted', seatId, packet.attemptId, {
        nativeTurnRef: 'native#turn:1',
        nativeMessageRef: 'native#message:1',
        text: 'OK',
      }));
    },
  };
}

test('--help documents cost and per-client voice side effects', async () => {
  const { code, out } = await run(['--help']);
  assert.equal(code, 0);
  assert.match(out, /真实模型调用与费用/);
  assert.match(out, /费用副作用/);
  assert.match(out, /语音副作用/);
  assert.match(out, /zcode:.*外部 Stop hook 可能朗读回复/);
  assert.match(out, /kimi-code:.*Stop hook.*观察/);
  assert.match(out, /dsh:.*无原生语音，仅文本/);
  assert.match(out, /--allow-cost/);
});

test('missing --allow-cost refuses before any bridge factory is called', async () => {
  const state = { calls: 0 };
  const { code, err } = await run(
    ['--client', 'dsh', '--session', 'session-real-001'],
    { factories: { dsh: () => { state.calls += 1; throw new Error('must not run'); } } },
  );
  assert.equal(code, 2);
  assert.equal(state.calls, 0);
  assert.match(err, /--allow-cost/);
});

test('parameter matrix rejects missing/unknown/placeholder input with exit 2', async (t) => {
  const cases = [
    {
      name: 'unknown client',
      argv: ['--client', 'bogus', '--session', 'session-real-001', '--allow-cost'],
      match: /未知 --client/,
    },
    {
      name: 'missing client',
      argv: ['--session', 'session-real-001', '--allow-cost'],
      match: /缺少 --client/,
    },
    {
      name: 'missing session',
      argv: ['--client', 'dsh', '--allow-cost'],
      match: /缺少 --session/,
    },
    {
      name: 'placeholder session',
      argv: ['--client', 'dsh', '--session', 'session-xxxxxxxx', '--allow-cost'],
      match: /占位会话/,
    },
    {
      name: 'angle-bracket placeholder',
      argv: ['--client', 'kimi-code', '--session', '<id>', '--allow-cost'],
      match: /占位会话/,
    },
    {
      name: 'missing option value',
      argv: ['--client', 'dsh', '--session', '--allow-cost'],
      match: /缺少参数值/,
    },
    {
      name: 'unknown argument',
      argv: [...baseArgs(), '--wat'],
      match: /未知参数/,
    },
    {
      name: 'invalid timeout',
      argv: [...baseArgs(), '--timeout', '0'],
      match: /--timeout 需要正整数/,
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const { code, err } = await run(entry.argv);
      assert.equal(code, 2, entry.name);
      assert.match(err, entry.match, entry.name);
    });
  }
});

test('normal mode connects and subscribes before send, then reports OK and usage', async () => {
  const usage = { inputTokens: 12, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 14 };
  const { factory, state } = makeFactory(completedScript(usage));

  const result = await run(baseArgs('dsh'), { factories: { dsh: factory } });

  assert.equal(result.code, 0, result.err);
  assert.ok(state.bridge);
  assert.equal(state.config.seatId, `${SEAT_PREFIX}-dsh`);
  assert.equal(state.config.nativeSessionRef, 'session-real-001');
  assert.equal(state.config.baseUrl, 'http://127.0.0.1:2955');

  const names = state.bridge.calls.map((call) => call.name);
  assert.deepEqual(names.slice(0, 3), ['connect', 'subscribe', 'send']);
  assert.ok(names.includes('close'));

  const send = state.bridge.calls.find((call) => call.name === 'send');
  assert.equal(send.packet.text, SHORT_PROMPT);
  assert.equal(send.packet.seatId, `${SEAT_PREFIX}-dsh`);
  assert.equal(send.packet.roomId, 'live-short-reply-probe');
  assert.equal(send.packet.roomSeq, 1);

  assert.match(result.out, /usage: input=12 output=2/);
  assert.match(result.out, /回复: OK/);

  const jsonFactory = makeFactory(completedScript(usage));
  const jsonResult = await run([...baseArgs('dsh'), '--json'], { factories: { dsh: jsonFactory.factory } });
  assert.equal(jsonResult.code, 0, jsonResult.err);
  const data = parseJsonOut(jsonResult);
  assert.equal(data.ok, true);
  assert.equal(data.outcome.status, 'completed');
  assert.equal(data.outcome.text, 'OK');
  assert.deepEqual(data.usage, usage);
  assert.deepEqual(
    data.events.map((event) => event.type),
    ['AttemptStarted', 'UsageReported', 'AttemptCompleted'],
  );
  assert.equal(data.close.ok, true);
});

test('factory routing uses 2955 for dsh, 58690 for kimi-code and defaults for zcode', async (t) => {
  await t.test('dsh', async () => {
    const { factory, state } = makeFactory(completedScript());
    const result = await run(baseArgs('dsh'), { factories: { dsh: factory } });
    assert.equal(result.code, 0);
    assert.equal(state.config.baseUrl, 'http://127.0.0.1:2955');
  });

  await t.test('kimi-code', async () => {
    const { factory, state } = makeFactory(completedScript());
    const result = await run([...baseArgs('kimi-code'), '--json'], { factories: { 'kimi-code': factory } });
    assert.equal(result.code, 0);
    assert.equal(state.config.baseUrl, 'http://127.0.0.1:58690');
    const data = parseJsonOut(result);
    assert.match(data.warnings.join('\n'), /Stop hook/);
  });

  await t.test('zcode', async () => {
    const { factory, state } = makeFactory(completedScript());
    const result = await run([...baseArgs('zcode'), '--json'], { factories: { zcode: factory } });
    assert.equal(result.code, 0);
    assert.deepEqual(state.config, {
      seatId: `${SEAT_PREFIX}-zcode`,
      nativeSessionRef: 'session-real-001',
    });
    const data = parseJsonOut(result);
    assert.match(data.warnings.join('\n'), /外部 Stop hook 可能朗读/);
  });
});

test('--abort sends the long prompt, cancels exactly once and reports the real aborted event', async () => {
  const { factory, state } = makeFactory({
    send(packet, { emit, seatId }) {
      emit(makeEvent('AttemptStarted', seatId, packet.attemptId, { nativeTurnRef: 'native#turn:9' }));
    },
    cancel(attemptId, { emit, seatId }) {
      emit(makeEvent('AttemptAborted', seatId, attemptId, {
        nativeTurnRef: 'native#turn:9',
        partialText: '1\n2\n3',
      }));
      return { attemptId, accepted: true, settlement: 'pending', nativeTurnRef: 'native#turn:9' };
    },
  });

  const result = await run([...baseArgs('dsh'), '--abort', '--json'], { factories: { dsh: factory } });

  assert.equal(result.code, 0, result.err);
  const calls = state.bridge.calls;
  const send = calls.find((call) => call.name === 'send');
  assert.equal(send.packet.text, ABORT_PROMPT);
  assert.notEqual(send.packet.text, SHORT_PROMPT);
  assert.equal(calls.filter((call) => call.name === 'cancel').length, 1);
  assert.ok(calls.some((call) => call.name === 'close'));

  const data = parseJsonOut(result);
  assert.equal(data.ok, true);
  assert.equal(data.mode, 'abort');
  assert.equal(data.outcome.status, 'aborted');
  assert.equal(data.outcome.partialText, '1\n2\n3');
  assert.equal(data.cancelReceipt.accepted, true);
  assert.equal(data.cancelReceipt.settlement, 'pending');
  assert.deepEqual(
    data.events.map((event) => event.type),
    ['AttemptStarted', 'AttemptAborted'],
  );
});

test('--abort failure is real, cancel is not repeated and close still runs', async () => {
  const { factory, state } = makeFactory({
    send(packet, { emit, seatId }) {
      emit(makeEvent('AttemptStarted', seatId, packet.attemptId));
    },
    cancel(attemptId, { emit, seatId }) {
      emit(makeEvent('AttemptFailed', seatId, attemptId, {
        error: { code: 'CANCEL_FAILED', message: 'session/cancel rejected token=topsecret', retryable: true },
      }));
      return { attemptId, accepted: false, settlement: 'failed', error: { code: 'CANCEL_FAILED', message: 'rejected' } };
    },
  });

  const result = await run([...baseArgs('zcode'), '--abort', '--json'], { factories: { zcode: factory } });

  assert.equal(result.code, 1);
  const data = parseJsonOut(result);
  assert.equal(data.ok, false);
  assert.equal(data.outcome.status, 'failed');
  assert.equal(data.outcome.error.code, 'CANCEL_FAILED');
  assert.match(data.outcome.error.message, /\[redacted\]/);
  assert.equal(data.cancelReceipt.accepted, false);
  assert.equal(data.cancelReceipt.settlement, 'failed');
  assert.equal(state.bridge.calls.filter((call) => call.name === 'cancel').length, 1);
  assert.ok(state.bridge.calls.some((call) => call.name === 'close'));
});

test('AttemptFailed is surfaced as failure, close executes and tokens are redacted in JSON', async () => {
  const { factory, state } = makeFactory({
    send(packet, { emit, seatId }) {
      emit(makeEvent('AttemptStarted', seatId, packet.attemptId));
      emit(makeEvent('AttemptFailed', seatId, packet.attemptId, {
        error: {
          code: 'TURN_FAILED',
          message: 'upstream rejected Authorization: Bearer abcdef123456 token=supersecret',
          retryable: false,
        },
      }));
    },
  });

  const result = await run([...baseArgs('kimi-code'), '--json'], { factories: { 'kimi-code': factory } });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.out, /supersecret/);
  assert.doesNotMatch(result.out, /abcdef123456/);
  assert.match(result.out, /\[redacted\]/);
  const data = parseJsonOut(result);
  assert.equal(data.ok, false);
  assert.equal(data.outcome.status, 'failed');
  assert.equal(data.outcome.error.code, 'TURN_FAILED');
  assert.ok(state.bridge.calls.some((call) => call.name === 'close'));
});

test('a send rejection is reported, redacted and still closes the bridge', async () => {
  const { factory, state } = makeFactory({
    send() {
      throw new Error('prompt rejected: token=sendsecret Bearer zzzzzzzz');
    },
  });

  const result = await run([...baseArgs('dsh'), '--json'], { factories: { dsh: factory } });

  assert.equal(result.code, 1);
  assert.doesNotMatch(result.out, /sendsecret/);
  assert.doesNotMatch(result.out, /zzzzzzzz/);
  const data = parseJsonOut(result);
  assert.equal(data.ok, false);
  assert.equal(data.outcome.status, 'failed');
  assert.match(data.outcome.error.message, /\[redacted\]/);
  assert.ok(state.bridge.calls.some((call) => call.name === 'close'));
});

test('timeout is an explicit failure and close still executes exactly once', async () => {
  const { factory, state } = makeFactory({
    send(packet, { emit, seatId }) {
      emit(makeEvent('AttemptStarted', seatId, packet.attemptId));
    },
  });

  const result = await run([...baseArgs('dsh'), '--timeout', '100', '--json'], { factories: { dsh: factory } });

  assert.equal(result.code, 1);
  const data = parseJsonOut(result);
  assert.equal(data.ok, false);
  assert.equal(data.outcome.status, 'timeout');
  assert.equal(data.outcome.error.code, 'TERMINAL_TIMEOUT');
  assert.equal(state.bridge.calls.filter((call) => call.name === 'close').length, 1);
});

test('connect failure still closes the bridge and exits non-zero', async () => {
  const { factory, state } = makeFactory({
    connect() {
      throw new Error('connect failed: server.token=connectsecret');
    },
  });

  const result = await run([...baseArgs('kimi-code'), '--json'], { factories: { 'kimi-code': factory } });

  assert.equal(result.code, 1);
  const data = parseJsonOut(result);
  assert.equal(data.ok, false);
  assert.equal(data.outcome.status, 'failed');
  assert.doesNotMatch(result.out, /connectsecret/);
  assert.ok(state.bridge.calls.some((call) => call.name === 'close'));
});

test('--json emits only one machine-readable object with no token fields', async () => {
  const { factory } = makeFactory(completedScript({
    inputTokens: 4,
    outputTokens: 1,
    totalTokens: 5,
  }));

  const result = await run([...baseArgs('dsh'), '--json'], { factories: { dsh: factory } });

  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  const data = JSON.parse(result.out);
  assert.equal(data.ok, true);
  assert.equal(data.usage.inputTokens, 4);
  assert.equal(Object.hasOwn(data, 'token'), false);
  assert.doesNotMatch(result.out, /Bearer|authorization|server[_-]?token/i);
});

test('parseArgs and validateOptions expose the safety gate without side effects', () => {
  const parsed = parseArgs([...baseArgs('dsh'), '--json', '--abort', '--timeout', '1234']);
  assert.equal(parsed.client, 'dsh');
  assert.equal(parsed.allowCost, true);
  assert.equal(parsed.abort, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.timeoutMs, 1234);

  assert.throws(
    () => validateOptions(parseArgs(['--client', 'dsh', '--session', 'session-real-001'])),
    (error) => error.code === 'E_ALLOW_COST_REQUIRED',
  );
  assert.throws(
    () => validateOptions(parseArgs(['--client', 'nope', '--session', 'session-real-001', '--allow-cost'])),
    (error) => error.code === 'E_UNKNOWN_CLIENT',
  );
});

test('runProbe can be driven directly with an injected factory', async () => {
  const { factory, state } = makeFactory(completedScript());
  const parsed = parseArgs(baseArgs('dsh'));

  const result = await runProbe(parsed, {
    factories: { dsh: factory },
    closeTimeoutMs: DEFAULT_CLOSE_TIMEOUT_MS,
    attemptId: 'fixed-attempt-id',
  });

  assert.equal(result.ok, true);
  assert.equal(result.attemptId, 'fixed-attempt-id');
  assert.equal(result.outcome.status, 'completed');
  assert.equal(state.bridge.calls.some((call) => call.name === 'close'), true);
});
