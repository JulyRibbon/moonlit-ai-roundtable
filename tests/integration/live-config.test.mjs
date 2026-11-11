import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  CLIENT_TYPES,
  ConfigError,
  DEFAULT_MAX_ATTEMPTS,
  loadConfig,
  validateConfig,
} from '../../server/config.mjs';
import {
  LiveCliError,
  createBridges,
  isConnectionFailure,
  parseArgs,
  startLive,
  startupHint,
} from '../../server/live.mjs';

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../..');
const EXAMPLE_CONFIG = path.join(PROJECT_ROOT, 'config/members.example.json');
const LIVE_CLI = path.join(PROJECT_ROOT, 'server/live.mjs');

function baseConfig(overrides = {}) {
  return {
    roomId: 'live-room',
    maxAttempts: 2,
    seats: [
      { seatId: 'alpha', clientType: 'fake', nativeSessionRef: 'fake_alpha' },
      { seatId: 'beta', clientType: 'fake', nativeSessionRef: 'fake_beta' },
    ],
    ...overrides,
  };
}

async function makeTempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'airoom-live-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

function assertConfigError(target, code) {
  const fn = typeof target === 'function' ? target : () => validateConfig(target);
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
    assert.equal(error.code, code, `unexpected code: ${error.code} (${error.message})`);
    return true;
  });
}

function captureConsole() {
  const lines = [];
  const original = console.log;
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };
  return {
    lines,
    restore() {
      console.log = original;
    },
  };
}

// ── 配置加载与校验矩阵 ────────────────────────────────────────────────────────

test('example config is valid JSON and loads with placeholder session ids', async () => {
  const config = await loadConfig(EXAMPLE_CONFIG);
  assert.equal(config.roomId, 'example-room');
  assert.equal(config.maxAttempts, 3);
  assert.deepEqual(config.seats.map((seat) => seat.clientType), ['dsh', 'kimi-code', 'zcode', 'qwen-code', 'fake']);
  assert.deepEqual(config.seats.map((seat) => seat.seatId), ['deepseek', 'kimi', 'glm', 'qwen', 'fake']);
  for (const seat of config.seats.slice(0, 4)) {
    assert.match(seat.nativeSessionRef, /^REPLACE_WITH_/);
  }
  assert.equal(config.seats[3].enabled, false);
  assert.equal(config.seats[4].nativeSessionRef, null);
  assert.equal(config.seats[4].enabled, false);
});

test('validateConfig applies defaults and keeps client-only config', () => {
  const config = validateConfig({
    roomId: 'room-1',
    seats: [{
      seatId: 'seat_1',
      clientType: 'fake',
      client: { supportsMute: true },
    }],
  });
  assert.equal(config.maxAttempts, DEFAULT_MAX_ATTEMPTS);
  assert.equal(config.seats.length, 1);
  assert.equal(config.seats[0].enabled, true);
  assert.equal(config.seats[0].voiceMode, 'none');
  assert.equal(config.seats[0].nativeSessionRef, null);
  assert.deepEqual(config.seats[0].client, { supportsMute: true });
});

test('validateConfig accepts every known client type and maxAttempts boundaries', () => {
  for (const clientType of CLIENT_TYPES) {
    const seat = { seatId: `seat_${clientType}`, clientType };
    if (clientType !== 'fake') seat.nativeSessionRef = `session_${clientType}`;
    assert.equal(validateConfig(baseConfig({ seats: [seat] })).seats[0].clientType, clientType);
  }
  for (const maxAttempts of [1, 12]) {
    assert.equal(
      validateConfig(baseConfig({ maxAttempts })).maxAttempts,
      maxAttempts,
    );
  }
  for (const maxAttempts of [0, 13, -1, 1.5, '3', null, true]) {
    assertConfigError(baseConfig({ maxAttempts }), 'MAX_ATTEMPTS_INVALID');
  }
});

test('validateConfig rejects unsafe and duplicate seat identifiers', () => {
  const unsafeRoomIds = [
    '', '.', '..', '../escape', 'rooms/escape', 'rooms\\escape', '.hidden',
    'a b', '-leading', '_leading', 'x'.repeat(65), null, 42,
  ];
  for (const roomId of unsafeRoomIds) {
    assertConfigError(baseConfig({ roomId }), 'ROOM_ID_INVALID');
  }

  for (const seatId of ['', '..', '../seat', 'a/b', 'a\\b', '.hidden', 'seat id', 'x'.repeat(65)]) {
    assertConfigError(
      baseConfig({ seats: [{ seatId, clientType: 'fake' }] }),
      'SEAT_ID_INVALID',
    );
  }

  assertConfigError(
    baseConfig({
      seats: [
        { seatId: 'same', clientType: 'fake' },
        { seatId: 'same', clientType: 'fake' },
      ],
    }),
    'SEAT_ID_DUPLICATE',
  );
});

test('validateConfig reports unknown or missing clientType with the known list', () => {
  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a', clientType: 'claude' }] }),
    'CLIENT_TYPE_UNKNOWN',
  );
  assert.match(
    (() => {
      try {
        validateConfig(baseConfig({ seats: [{ seatId: 'a', clientType: 'claude' }] }));
      } catch (error) {
        return error.message;
      }
      return '';
    })(),
    /dsh, kimi-code, zcode, qwen-code, fake/,
  );
  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a' }] }),
    'CLIENT_TYPE_REQUIRED',
  );
});

test('production seats require nativeSessionRef while fake may omit it', () => {
  for (const clientType of ['dsh', 'kimi-code', 'zcode']) {
    assertConfigError(
      baseConfig({ seats: [{ seatId: 'a', clientType }] }),
      'SESSION_REF_REQUIRED',
    );
  }
  const fake = validateConfig(baseConfig({ seats: [{ seatId: 'a', clientType: 'fake' }] }));
  assert.equal(fake.seats[0].nativeSessionRef, null);

  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a', clientType: 'fake', nativeSessionRef: 7 }] }),
    'SESSION_REF_INVALID',
  );
});

test('persona / prompt / systemPrompt / agentsMd bodies are refused at every level', () => {
  const payloads = [
    { persona: '你是……' },
    { prompt: '请扮演……' },
    { systemPrompt: '规则正文' },
    { agentsMd: '# 规则' },
  ];
  for (const payload of payloads) {
    assertConfigError({ ...baseConfig(), ...payload }, 'CONFIG_PERSONA_FORBIDDEN');
    assertConfigError({
      ...baseConfig(),
      seats: [{ seatId: 'a', clientType: 'fake', ...payload }],
    }, 'CONFIG_PERSONA_FORBIDDEN');
    assertConfigError({
      ...baseConfig(),
      seats: [{ seatId: 'a', clientType: 'fake', client: payload }],
    }, 'CONFIG_PERSONA_FORBIDDEN');
  }
  // 分隔符与大小写变体同样拒绝。
  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a', clientType: 'fake', system_prompt: 'x' }] }),
    'CONFIG_PERSONA_FORBIDDEN',
  );
});

test('unknown fields, empty seats and all-disabled rooms are rejected', () => {
  assertConfigError({ ...baseConfig(), temperature: 1 }, 'CONFIG_UNKNOWN_FIELD');
  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a', clientType: 'fake', temperature: 1 }] }),
    'CONFIG_UNKNOWN_FIELD',
  );
  assertConfigError(baseConfig({ seats: [] }), 'SEATS_EMPTY');
  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a', clientType: 'fake', enabled: false }] }),
    'NO_ENABLED_SEATS',
  );
  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a', clientType: 'fake', enabled: 'yes' }] }),
    'SEAT_ENABLED_INVALID',
  );
  assertConfigError(
    baseConfig({ seats: [{ seatId: 'a', clientType: 'fake', voiceMode: 'loud' }] }),
    'VOICE_MODE_INVALID',
  );
});

test('loadConfig distinguishes missing files and malformed JSON', async (t) => {
  const root = await makeTempRoot(t);
  const broken = path.join(root, 'broken.json');
  await writeFile(broken, '{"roomId":', 'utf8');

  await assert.rejects(loadConfig(broken), (error) => (
    error instanceof ConfigError && error.code === 'CONFIG_INVALID_JSON'
  ));
  await assert.rejects(loadConfig(path.join(root, 'missing.json')), (error) => (
    error instanceof ConfigError && error.code === 'CONFIG_NOT_FOUND'
  ));
  await assert.rejects(loadConfig(''), (error) => (
    error instanceof ConfigError && error.code === 'CONFIG_PATH_REQUIRED'
  ));
});

// ── Bridge 工厂映射 ──────────────────────────────────────────────────────────

test('createBridges maps client types, skips disabled seats and never logs config', () => {
  const calls = [];
  const factoryFor = (clientType) => (args) => {
    calls.push({ clientType, args });
    return { clientType, seatId: args.seatId, close: async () => {} };
  };
  const factories = {
    dsh: factoryFor('dsh'),
    'kimi-code': factoryFor('kimi-code'),
    zcode: factoryFor('zcode'),
    fake: factoryFor('fake'),
  };
  const config = validateConfig({
    roomId: 'mapping-room',
    maxAttempts: 2,
    seats: [
      {
        seatId: 'deepseek',
        clientType: 'dsh',
        nativeSessionRef: 'dsh-session-1',
        client: { baseUrl: 'http://127.0.0.1:9', timeoutMs: 123, seatId: 'hijack' },
      },
      {
        seatId: 'kimi',
        clientType: 'kimi-code',
        nativeSessionRef: 'kimi-session-1',
        client: { agentId: 'reviewer' },
      },
      {
        seatId: 'glm',
        clientType: 'zcode',
        nativeSessionRef: 'zcode-session-1',
        client: { exe: 'C:/ZCode/ZCode.exe' },
      },
      { seatId: 'offline', clientType: 'fake', enabled: false },
      { seatId: 'fake', clientType: 'fake', voiceMode: 'external' },
    ],
  });

  const capture = captureConsole();
  let bridges;
  try {
    bridges = createBridges(config, { factories });
  } finally {
    capture.restore();
  }

  assert.deepEqual([...bridges.keys()], ['deepseek', 'kimi', 'glm', 'fake']);
  assert.equal(capture.lines.length, 0, 'bridge creation must not log');
  assert.deepEqual(calls.map((call) => call.clientType), ['dsh', 'kimi-code', 'zcode', 'fake']);

  const bySeat = new Map(calls.map((call) => [call.args.seatId, call.args]));
  assert.equal(bySeat.get('deepseek').baseUrl, 'http://127.0.0.1:9');
  assert.equal(bySeat.get('deepseek').timeoutMs, 123);
  assert.equal(bySeat.get('deepseek').nativeSessionRef, 'dsh-session-1');
  assert.equal(bySeat.get('deepseek').voiceMode, 'none');
  assert.equal(bySeat.get('kimi').agentId, 'reviewer');
  assert.equal(bySeat.get('glm').exe, 'C:/ZCode/ZCode.exe');
  assert.equal(bySeat.get('fake').nativeSessionRef, 'fake_session_fake');
  assert.equal(bySeat.get('fake').voiceMode, 'external');
});

test('createBridges rejects invalid factories and unvalidated config', () => {
  assert.throws(
    () => createBridges(baseConfig(), { factories: { nope: () => ({}) } }),
    (error) => error instanceof Error && error.code === 'FACTORY_UNKNOWN',
  );
  assert.throws(
    () => createBridges(baseConfig(), { factories: { dsh: 'not-a-function' } }),
    (error) => error instanceof Error && error.code === 'FACTORY_INVALID',
  );
  assertConfigError({ roomId: '../escape', seats: [] }, 'ROOM_ID_INVALID');
});

// ── startLive 端到端 ─────────────────────────────────────────────────────────

test('startLive drives a FakeBridge room from draft to review, then closes idempotently', { timeout: 20_000 }, async (t) => {
  const root = await makeTempRoot(t);
  const liveRef = { current: null };
  t.after(async () => {
    if (liveRef.current) await liveRef.current.close().catch(() => {});
  });

  const capture = captureConsole();
  try {
    liveRef.current = await startLive({
      config: {
        roomId: 'live-room',
        maxAttempts: 2,
        seats: [
          {
            seatId: 'alpha',
            clientType: 'fake',
            nativeSessionRef: 'fake-secret-alpha',
            voiceMode: 'none',
          },
          {
            seatId: 'beta',
            clientType: 'fake',
            nativeSessionRef: 'fake-secret-beta',
          },
        ],
      },
      host: '127.0.0.1',
      port: 0,
      token: 'live-token-for-test',
      stateDir: path.join(root, 'state'),
      roomDir: path.join(root, 'room'),
    });
  } finally {
    capture.restore();
  }

  const live = liveRef.current;
  assert.match(live.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=live-token-for-test$/);
  assert.equal(live.port > 0, true);
  assert.equal(live.config.roomId, 'live-room');
  assert.equal(live.config.seats[1].enabled, true);

  // 启动后只完成 init：未激活、未运行。
  const initial = live.engine.getSnapshot();
  assert.equal(initial.initialized, true);
  assert.equal(initial.room.state, 'draft');
  assert.equal(initial.running, false);

  const early = await live.engine.run();
  assert.equal(early.ran, false);
  assert.equal(early.reason, 'room-not-active');

  const health = await fetch(`http://127.0.0.1:${live.port}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, version: '0.5.1' });

  await live.engine.activate();
  await live.engine.postOwnerMessage({ text: '请两位各说一句。' });

  const requested = [];
  // FakeBridge 在 send() 时才登记 attempt，因此必须等 AttemptStarted 再补终态；
  // 收到 TurnRequested 时立刻 complete 会因为 attempt 尚未登记而被忽略。
  live.engine.on('bridge-event', (event) => {
    if (event?.type !== 'AttemptStarted') return;
    const { seatId, attemptId } = event;
    requested.push(seatId);
    const bridge = live.engine.bridges.get(seatId);
    bridge.completeAttempt(attemptId, { text: `reply-from-${seatId}` });
  });

  const result = await live.engine.run();
  assert.equal(result.ran, true);
  assert.deepEqual(requested, ['alpha', 'beta']);
  assert.equal(result.turns.length, 2);
  assert.equal(result.state, 'review');

  const final = live.engine.getSnapshot();
  assert.equal(final.room.state, 'review');
  assert.equal(final.running, false);
  assert.equal(final.transcript.length, 3);
  assert.deepEqual(
    final.transcript.filter((message) => message.from === 'member').map((message) => message.seatId),
    ['alpha', 'beta'],
  );

  // 日志只允许 URL 行出现 token；会话引用与配置内容不得出现。
  const tokenLines = capture.lines.filter((line) => line.includes('live-token-for-test'));
  assert.equal(tokenLines.length, 1);
  assert.match(tokenLines[0], /open: .*#token=/);
  for (const line of capture.lines) {
    assert.equal(line.includes('fake-secret'), false, `session ref leaked: ${line}`);
    assert.equal(line.includes('nativeSessionRef'), false, `config field leaked: ${line}`);
  }

  const firstClose = live.close();
  const secondClose = live.close();
  assert.equal(firstClose, secondClose, 'close must be idempotent');
  await firstClose;

  assert.equal(live.server.address(), null);
  assert.equal(live.engine.getSnapshot().closed, true);
  assert.equal(live.haltGuard.check('live-room').halted, false);
  liveRef.current = null;
});

test('startLive requires a config source and surfaces config-path errors', async () => {
  await assert.rejects(startLive({}), (error) => (
    error instanceof ConfigError && error.code === 'CONFIG_REQUIRED'
  ));
  await assert.rejects(
    startLive({ configPath: path.join(os.tmpdir(), 'airoom-does-not-exist.json') }),
    (error) => error instanceof ConfigError && error.code === 'CONFIG_NOT_FOUND',
  );
});

test('startLive prefers explicit token, then AIROOM_TOKEN, then a random token', async (t) => {
  const root = await makeTempRoot(t);
  const previous = process.env.AIROOM_TOKEN;
  const started = [];
  t.after(async () => {
    for (const live of started) await live.close().catch(() => {});
    if (previous === undefined) delete process.env.AIROOM_TOKEN;
    else process.env.AIROOM_TOKEN = previous;
  });

  const config = baseConfig({ roomId: 'token-room' });
  const capture = captureConsole();
  try {
    process.env.AIROOM_TOKEN = 'env-token-value';
    const fromEnv = await startLive({
      config,
      port: 0,
      stateDir: path.join(root, 'state-env'),
      roomDir: path.join(root, 'room-env'),
    });
    started.push(fromEnv);
    assert.match(fromEnv.url, /#token=env-token-value$/);

    delete process.env.AIROOM_TOKEN;
    const random = await startLive({
      config,
      port: 0,
      stateDir: path.join(root, 'state-random'),
      roomDir: path.join(root, 'room-random'),
    });
    started.push(random);
    const match = /#token=(.+)$/.exec(random.url);
    assert.ok(match, 'random token must be present in the URL');
    assert.ok(match[1].length >= 16);
    assert.notEqual(match[1], 'env-token-value');
  } finally {
    for (const live of started) await live.close().catch(() => {});
    started.length = 0;
    capture.restore();
  }
});

// ── CLI 参数与连接错误提示 ──────────────────────────────────────────────────

test('CLI argument parsing accepts both forms and reports clear usage errors', () => {
  assert.deepEqual(parseArgs(['--config', 'members.json', '--port', '3000']), {
    configPath: 'members.json',
    port: 3000,
    help: false,
  });
  assert.deepEqual(parseArgs(['--config=members.json', '--port=0']), {
    configPath: 'members.json',
    port: 0,
    help: false,
  });
  assert.equal(parseArgs(['--help']).help, true);

  assert.throws(
    () => parseArgs([]),
    (error) => error instanceof LiveCliError
      && error.code === 'CLI_CONFIG_REQUIRED'
      && error.message.includes('--config'),
  );
  assert.throws(
    () => parseArgs(['--config']),
    (error) => error instanceof LiveCliError && error.code === 'CLI_VALUE_REQUIRED',
  );
  assert.throws(
    () => parseArgs(['--config', 'x.json', '--port', '70000']),
    (error) => error instanceof LiveCliError && error.code === 'CLI_PORT_INVALID',
  );
  assert.throws(
    () => parseArgs(['--watch']),
    (error) => error instanceof LiveCliError && error.code === 'CLI_UNKNOWN_ARGUMENT',
  );
});

test('CLI exits non-zero with a clear message when --config is missing', async () => {
  const failure = await execFileAsync(process.execPath, [LIVE_CLI]).then(
    () => null,
    (error) => error,
  );
  assert.ok(failure, 'CLI must fail without --config');
  assert.equal(failure.code, 1);
  assert.match(String(failure.stderr), /--config/);
  assert.match(String(failure.stderr), /members\.example\.json/);
});

test('connection failures get a hint to start the independent client, without killing processes', () => {
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2961'), {
      code: 'ECONNREFUSED',
    }),
  });
  assert.equal(isConnectionFailure(refused), true);
  const hint = startupHint(refused);
  assert.match(hint, /kimi web/);
  assert.match(hint, /不会自动启动/);
  assert.match(hint, /不会自动启动、重启或结束任何客户端进程/);

  assert.equal(isConnectionFailure(new ConfigError('X', '配置错误')), false);
  assert.equal(startupHint(new ConfigError('X', '配置错误')), null);
});
