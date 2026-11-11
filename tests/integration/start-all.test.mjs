import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXIT_FAILED,
  StartAllError,
  isPortFree,
  parseArgs,
  startAll,
} from '../../scripts/start-all.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../..');
const BAT_FILE = path.join(PROJECT_ROOT, 'start-all.bat');
const PACKAGE_FILE = path.join(PROJECT_ROOT, 'package.json');
const KIMI_EXE = 'C:\\fake\\kimi.exe';

function makeChild(name, { killLog } = {}) {
  const child = new EventEmitter();
  child.name = name;
  child.pid = name === 'kimi' ? 9001 : 9002;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal = 'SIGTERM') => {
    killLog?.push({ name, signal });
    if (child.exitCode !== null || child.signalCode !== null) return true;
    child.exitCode = 0;
    child.emit('exit', 0, signal);
    return true;
  };
  child.exit = (code = 0, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  child.say = (line, stream = 'stdout') => {
    child[stream].emit('data', `${line}\n`);
  };
  return child;
}

function response(status = 200) {
  return { status, body: { cancel: () => Promise.resolve() } };
}

async function readLogUntil(file, pattern, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const text = await readFile(file, 'utf8');
      if (pattern.test(text)) return text;
    } catch {
      // 文件还没出现：继续等。
    }
    if (Date.now() >= deadline) return readFile(file, 'utf8').catch(() => '');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeConfig(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airoom-start-all-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = path.join(dir, 'members.local.json');
  await writeFile(configPath, '{"roomId":"test"}\n', 'utf8');
  return configPath;
}

async function makeConfigWithQwenSeat(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airoom-start-all-qwen-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const configPath = path.join(dir, 'members.local.json');
  await writeFile(configPath, JSON.stringify({
    roomId: 'r_main',
    seats: [
      { seatId: 'qwen', clientType: 'qwen-code', nativeSessionRef: 'sess-qwen-1', enabled: true },
    ],
  }), 'utf8');
  return configPath;
}

const QWEN_RUNTIME = Object.freeze({
  node: 'C:\\fake\\qwen-node.exe',
  entry: 'C:\\fake\\qwen\\lib\\cli-entry.js',
  source: 'test',
});

function baseOptions(configPath, overrides = {}) {
  return {
    configPath,
    kimiExe: KIMI_EXE,
    fileExists: () => true,
    isPortFree: async () => true,
    resolveQwenRuntime: () => QWEN_RUNTIME,
    qwenServeLogPath: path.join(path.dirname(configPath), 'qwen-serve.log'),
    log: () => {},
    error: () => {},
    ...overrides,
  };
}

/**
 * Mock spawn factory. Kimi / Qwen / live children are created on demand and
 * exposed for the test to drive their output and exit events.
 */
function createSpawnMock({ liveUrl = 'http://127.0.0.1:2961/#token=secret-token', killLog = [] } = {}) {
  const calls = [];
  const state = { kimi: null, live: null, qwen: null, kimiSpawned: false, liveSpawned: false, qwenSpawned: false };

  const spawn = (command, args = [], options = {}) => {
    calls.push({ command, args, options });
    if (args[0] === 'web') {
      const child = makeChild('kimi', { killLog });
      state.kimi = child;
      state.kimiSpawned = true;
      return child;
    }
    if (args.includes('serve')) {
      const child = makeChild('qwen', { killLog });
      child.pid = 9003;
      state.qwen = child;
      state.qwenSpawned = true;
      return child;
    }
    const child = makeChild('live', { killLog });
    state.live = child;
    state.liveSpawned = true;
    if (liveUrl !== null) {
      setImmediate(() => {
        child.say('[ai-room] live room ready');
        child.say(`[ai-room] open: ${liveUrl}`);
      });
    }
    return child;
  };

  return { spawn, calls, state, killLog };
}

test('parseArgs applies defaults and supports all flags', () => {
  const defaults = parseArgs([], { projectRoot: 'C:\\project' });
  assert.equal(defaults.configPath, path.resolve('C:\\project', 'config/members.local.json'));
  assert.equal(defaults.port, 2961);
  assert.equal(defaults.kimiPort, 58690);
  assert.equal(defaults.open, true);

  const parsed = parseArgs([
    '--config', 'other.json',
    '--port', '3000',
    '--kimi-port=59000',
    '--no-open',
  ], { projectRoot: 'C:\\project' });
  assert.equal(parsed.configPath, path.resolve('C:\\project', 'other.json'));
  assert.equal(parsed.port, 3000);
  assert.equal(parsed.kimiPort, 59000);
  assert.equal(parsed.open, false);
});

test('parseArgs rejects unknown flags, missing values and invalid ports', () => {
  assert.throws(() => parseArgs(['--bogus']), (error) => error.code === 'CLI_UNKNOWN_ARGUMENT');
  assert.throws(() => parseArgs(['--port']), (error) => error.code === 'CLI_VALUE_REQUIRED');
  assert.throws(() => parseArgs(['--config=']), (error) => error.code === 'CLI_VALUE_REQUIRED');
  assert.throws(() => parseArgs(['--port', '70000']), (error) => error.code === 'CLI_PORT_INVALID');
  assert.throws(() => parseArgs(['--port', 'abc']), (error) => error.code === 'CLI_PORT_INVALID');
  assert.throws(() => parseArgs(['--kimi-port', '0']), (error) => error.code === 'CLI_PORT_INVALID');
  assert.equal(parseArgs(['--help']).help, true);
});

test('existing healthy Kimi is reused and never spawned or killed', async (t) => {
  const configPath = await makeConfig(t);
  const fetchCalls = [];
  const opened = [];
  const { spawn, calls, state, killLog } = createSpawnMock();

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch: async (url) => {
      fetchCalls.push(url);
      return response(200);
    },
    openUrl: async (url) => opened.push(url),
  }));

  assert.equal(calls.length, 1, 'only live.mjs is spawned');
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].args[0], path.join(PROJECT_ROOT, 'server/live.mjs'));
  assert.ok(fetchCalls[0].endsWith('/api/v1/meta'));
  assert.equal(handle.reusedKimi, true);
  assert.equal(handle.ownKimi, false);
  assert.equal(state.kimiSpawned, false);
  assert.equal(handle.url, 'http://127.0.0.1:2961/#token=secret-token');
  assert.deepEqual(opened, ['http://127.0.0.1:2961/#token=secret-token']);

  await handle.shutdown('SIGINT');
  assert.deepEqual(killLog.map((entry) => entry.name), ['live'], 'only the live room is stopped');

  const result = await handle.done;
  assert.equal(result.code, 0);
});

test('missing Kimi starts kimi web before live and waits for health', async (t) => {
  const configPath = await makeConfig(t);
  const order = [];
  const sleeps = [];
  let healthAttempts = 0;
  const { spawn, calls, state, killLog } = createSpawnMock();

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch: async () => {
      order.push('fetch');
      healthAttempts += 1;
      return response(healthAttempts >= 3 ? 200 : 503);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    openUrl: async () => {},
  }));

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, KIMI_EXE);
  assert.deepEqual(calls[0].args, ['web', '--port', '58690', '--no-open']);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.equal(calls[1].command, process.execPath);
  assert.deepEqual(calls[1].args.slice(1, 5), ['--config', configPath, '--port', '2961']);
  assert.ok(healthAttempts >= 3);
  assert.ok(sleeps.length >= 1, 'waited between health probes');
  assert.equal(handle.ownKimi, true);
  assert.equal(handle.reusedKimi, false);

  await handle.shutdown('SIGINT');
  assert.deepEqual(killLog.map((entry) => entry.name), ['live', 'kimi']);
  assert.equal(state.kimi.exitCode, 0);
});

test('Kimi spawn failure is reported without leaking configuration', async (t) => {
  const configPath = await makeConfig(t);
  let kimiKilled = false;
  const spawn = (command, args = []) => {
    if (args[0] === 'web') {
      kimiKilled = true;
      throw new Error('spawn ENOENT');
    }
    return makeChild('live');
  };

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      fetch: async () => response(503),
      openUrl: async () => {},
    })),
    (error) => {
      assert.ok(error instanceof StartAllError);
      assert.equal(error.code, 'KIMI_SPAWN_FAILED');
      assert.doesNotMatch(error.message, /members|nativeSessionRef|token/i);
      return true;
    },
  );
  assert.equal(kimiKilled, true);
});

test('health timeout fails clearly and stops the Kimi it started', async (t) => {
  const configPath = await makeConfig(t);
  let clock = 0;
  const { spawn, state, killLog } = createSpawnMock();

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      fetch: async () => response(503),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      healthTimeoutMs: 1000,
      healthIntervalMs: 250,
      openUrl: async () => {},
    })),
    (error) => error.code === 'KIMI_HEALTH_TIMEOUT',
  );

  assert.deepEqual(killLog.map((entry) => entry.name), ['kimi']);
  assert.equal(state.kimi.exitCode, 0);
});

test('live room boot failure rejects and cleans up the Kimi it started', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, state, killLog } = createSpawnMock({ liveUrl: null });

  const startPromise = startAll(baseOptions(configPath, {
    spawn,
    fetch: async () => (state.kimiSpawned ? response(200) : response(503)),
    openUrl: async () => {},
  }));

  await new Promise((resolve) => setImmediate(resolve));
  state.live.say('[ai-room] live failed to start: bad config', 'stderr');
  state.live.exit(1);

  await assert.rejects(startPromise, (error) => {
    assert.equal(error.code, 'LIVE_EXITED');
    assert.match(error.message, /live room 在就绪前退出/);
    assert.match(error.message, /bad config/);
    return true;
  });
  assert.deepEqual(killLog.map((entry) => entry.name), ['kimi']);
  assert.equal(state.kimi.exitCode, 0);
});

test('--no-open suppresses the browser and does not print the token URL', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn } = createSpawnMock();
  const opened = [];
  const logs = [];

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch: async () => response(200),
    openUrl: async (url) => opened.push(url),
    open: false,
    log: (line) => logs.push(String(line)),
  }));

  assert.deepEqual(opened, []);
  assert.ok(
    logs.some((line) => line.includes('--no-open') && line.includes('http://127.0.0.1:2961/')),
    'reports the room location without the token',
  );
  assert.ok(logs.every((line) => !line.includes('secret-token')));

  await handle.shutdown('SIGINT');
});

test('URL comes only from live output and is opened unchanged', async (t) => {
  const configPath = await makeConfig(t);
  const liveUrl = 'http://127.0.0.1:4020/#token=abc_DEF-123';
  const { spawn } = createSpawnMock({ liveUrl });
  const opened = [];

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch: async () => response(200),
    openUrl: async (url) => opened.push(url),
  }));

  assert.deepEqual(opened, [liveUrl]);
  assert.equal(handle.url, liveUrl);
  await handle.shutdown('SIGINT');
});

test('an unsafe URL from live output is rejected without opening', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn } = createSpawnMock({ liveUrl: 'http://127.0.0.1:2961/&calc&' });
  const opened = [];

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      fetch: async () => response(200),
      openUrl: async (url) => opened.push(url),
    })),
    (error) => error.code === 'URL_INVALID',
  );
  assert.deepEqual(opened, []);
});

test('URL timeout fails clearly and cleans up both children', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, state, killLog } = createSpawnMock({ liveUrl: null });

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      fetch: async () => (state.kimiSpawned ? response(200) : response(503)),
      openUrl: async () => {},
      urlTimeoutMs: 20,
    })),
    (error) => error.code === 'LIVE_URL_TIMEOUT',
  );

  assert.deepEqual(killLog.map((entry) => entry.name), ['live', 'kimi']);
  assert.equal(state.kimi.exitCode, 0);
});

test('unexpected live exit cleans up only what start-all started', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, state, killLog } = createSpawnMock();

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch: async () => response(200),
    openUrl: async () => {},
  }));

  state.live.exit(3);
  const result = await handle.done;
  assert.equal(result.code, 3);
  assert.deepEqual(killLog, [], 'reused Kimi and already-exited live are untouched');
});

test('unexpected own Kimi exit stops the live room and reports failure', async (t) => {
  const configPath = await makeConfig(t);
  let healthDone = false;
  const { spawn, state, killLog } = createSpawnMock();

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch: async () => {
      if (!state.kimiSpawned) return response(503);
      healthDone = true;
      return response(200);
    },
    openUrl: async () => {},
  }));
  assert.equal(healthDone, true);

  state.kimi.exit(2);
  const result = await handle.done;
  assert.equal(result.code, EXIT_FAILED);
  assert.deepEqual(killLog.map((entry) => entry.name), ['live']);
  assert.equal(state.live.exitCode, 0);
});

test('shutdown closes live before the Kimi it started, and is idempotent', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, state, killLog } = createSpawnMock();

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch: async () => (state.kimiSpawned ? response(200) : response(503)),
    openUrl: async () => {},
  }));
  assert.equal(handle.ownKimi, true);

  const [first, second] = await Promise.all([
    handle.shutdown('SIGTERM'),
    handle.shutdown('SIGTERM'),
  ]);
  assert.deepEqual(first, second);
  assert.equal(first.code, 0);
  assert.deepEqual(killLog.map((entry) => entry.name), ['live', 'kimi'], 'live stops first, Kimi second');
});

test('config is required before any spawn or health probe', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, calls } = createSpawnMock();
  let fetched = false;

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      fileExists: () => false,
      fetch: async () => {
        fetched = true;
        return response(200);
      },
    })),
    (error) => error.code === 'CONFIG_MISSING',
  );
  assert.equal(calls.length, 0);
  assert.equal(fetched, false);
});

test('room port already in use fails before spawning or probing Kimi', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, calls } = createSpawnMock();
  let fetched = false;

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      isPortFree: async (port) => port !== 2961,
      fetch: async () => {
        fetched = true;
        return response(503);
      },
      openUrl: async () => {},
    })),
    (error) => {
      assert.ok(error instanceof StartAllError);
      assert.equal(error.code, 'ROOM_PORT_IN_USE');
      assert.match(error.message, /2961/);
      assert.match(error.message, /kill\.bat/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
  assert.equal(fetched, false);
});

test('occupied but unhealthy Kimi port fails clearly instead of waiting', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, calls } = createSpawnMock();

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      isPortFree: async (port) => port === 2961,
      fetch: async () => response(503),
      openUrl: async () => {},
    })),
    (error) => {
      assert.ok(error instanceof StartAllError);
      assert.equal(error.code, 'KIMI_PORT_IN_USE');
      assert.match(error.message, /58690/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('waiting for Kimi prints progress instead of looking hung', async (t) => {
  const configPath = await makeConfig(t);
  let clock = 0;
  const logs = [];
  const { spawn } = createSpawnMock();

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      fetch: async () => response(503),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      healthTimeoutMs: 2000,
      healthIntervalMs: 250,
      progressIntervalMs: 500,
      log: (line) => logs.push(line),
      openUrl: async () => {},
    })),
    (error) => error.code === 'KIMI_HEALTH_TIMEOUT',
  );
  assert.ok(logs.some((line) => /仍在等待 Kimi 就绪/.test(line)), 'progress line is logged');
});

test('isPortFree reports a real listener as occupied and a closed port as free', async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, resolve);
  });
  const { port } = server.address();
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
  assert.equal(await isPortFree(port), true);
});

test('live and demo servers default to the same port as start-all, clear of DSH', async () => {
  for (const file of ['server/live.mjs', 'server/demo.mjs']) {
    const text = await readFile(path.join(PROJECT_ROOT, file), 'utf8');
    assert.match(text, /const DEFAULT_PORT = 2961;/, `${file} should default to 2961`);
    assert.doesNotMatch(text, /const DEFAULT_PORT = 2960;/, `${file} must not use DSH's 2960`);
  }
});

test('qwen daemon is reused when healthy and never spawned or stopped', async (t) => {
  const configPath = await makeConfigWithQwenSeat(t);
  const { spawn, calls, state, killLog } = createSpawnMock();
  const seen = [];
  const fetch = async (url) => {
    seen.push(String(url));
    return response(200);
  };

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch,
    sleep: async () => {},
    openUrl: async () => {},
  }));
  assert.equal(handle.needsQwen, true);
  assert.equal(handle.reusedQwen, true);
  assert.equal(state.qwenSpawned, false);
  assert.equal(calls.some((call) => call.args?.includes('serve')), false);
  assert.ok(seen.some((url) => url.includes('58691/health')));
  await handle.shutdown('test');
  assert.equal(killLog.some((entry) => entry.name === 'qwen'), false);
});

test('unhealthy qwen daemon is spawned, waited for, and stopped on shutdown', async (t) => {
  const configPath = await makeConfigWithQwenSeat(t);
  const { spawn, calls, state, killLog } = createSpawnMock();
  const fetch = async (url) => {
    const text = String(url);
    if (text.includes('58691/health')) return state.qwenSpawned ? response(200) : response(503);
    return response(200);
  };

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch,
    sleep: async () => {},
    openUrl: async () => {},
  }));
  assert.equal(handle.needsQwen, true);
  assert.equal(handle.reusedQwen, false);
  assert.equal(state.qwenSpawned, true);
  const qwenCall = calls.find((call) => call.args?.includes('serve'));
  assert.ok(qwenCall, 'qwen serve should be spawned');
  assert.equal(qwenCall.command, QWEN_RUNTIME.node);
  assert.ok(qwenCall.args.includes('--no-web'));
  assert.ok(qwenCall.args.includes('--workspace'));
  assert.equal(qwenCall.args[qwenCall.args.indexOf('--initialize-timeout-ms') + 1], '60000');

  await handle.shutdown('test');
  assert.ok(killLog.some((entry) => entry.name === 'qwen'), 'started qwen daemon must be stopped');
});

test('qwen stdout/stderr is appended to state/qwen-serve.log and closed on shutdown', async (t) => {
  const configPath = await makeConfigWithQwenSeat(t);
  const logPath = path.join(path.dirname(configPath), 'state', 'qwen-serve.log');
  const { spawn, state } = createSpawnMock();
  const fetch = async (url) => {
    const text = String(url);
    if (text.includes('58690/health')) return state.kimiSpawned ? response(200) : response(503);
    if (text.includes('58691/health')) return state.qwenSpawned ? response(200) : response(503);
    return response(200);
  };

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch,
    qwenServeLogPath: logPath,
    sleep: async () => {},
    openUrl: async () => {},
  }));
  state.qwen.say('qwen serve listening');
  state.qwen.say('ACP initialize timeout', 'stderr');
  state.kimi?.say('kimi banner with token');

  await handle.shutdown('test');
  const text = await readLogUntil(logPath, /ACP initialize timeout/);
  assert.match(text, /qwen serve listening/);
  assert.match(text, /ACP initialize timeout/);
  assert.doesNotMatch(text, /kimi banner/);
});

test('qwen log keeps the failing output when the daemon exits before health', async (t) => {
  const configPath = await makeConfigWithQwenSeat(t);
  const logPath = path.join(path.dirname(configPath), 'qwen-serve.log');
  const { spawn, state } = createSpawnMock();
  const fetch = async (url) => (String(url).includes('58691/health') ? response(503) : response(200));

  const spawned = [];
  const originalSpawn = spawn;
  const spawnWithExit = (command, args, options) => {
    const child = originalSpawn(command, args, options);
    if (args?.includes('serve')) {
      spawned.push(child);
      setTimeout(() => {
        child.say('fatal: initialize failed', 'stderr');
        child.exit(1);
      }, 0);
    }
    return child;
  };

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn: spawnWithExit,
      fetch,
      qwenServeLogPath: logPath,
      healthTimeoutMs: 1000,
      sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 1)); },
      openUrl: async () => {},
    })),
    (error) => {
      assert.equal(error.code, 'QWEN_EXITED');
      return true;
    },
  );
  assert.equal(state.qwenSpawned, true);
  const text = await readLogUntil(logPath, /fatal: initialize failed/);
  assert.match(text, /fatal: initialize failed/);
});

test('occupied qwen port that is not healthy fails clearly without spawning', async (t) => {
  const configPath = await makeConfigWithQwenSeat(t);
  const { spawn, calls } = createSpawnMock();
  const fetch = async (url) => (String(url).includes('58691/health') ? response(503) : response(200));

  await assert.rejects(
    startAll(baseOptions(configPath, {
      spawn,
      fetch,
      sleep: async () => {},
      isPortFree: async (port) => port !== 58691,
      openUrl: async () => {},
    })),
    (error) => {
      assert.equal(error.code, 'QWEN_PORT_IN_USE');
      assert.match(error.message, /58691/);
      return true;
    },
  );
  assert.equal(calls.some((call) => call.args?.includes('serve')), false);
});

test('config without a qwen-code seat never touches the qwen daemon', async (t) => {
  const configPath = await makeConfig(t);
  const { spawn, calls } = createSpawnMock();
  const seen = [];
  const fetch = async (url) => {
    seen.push(String(url));
    return response(200);
  };

  const handle = await startAll(baseOptions(configPath, {
    spawn,
    fetch,
    sleep: async () => {},
    openUrl: async () => {},
  }));
  assert.equal(handle.needsQwen, false);
  assert.equal(handle.reusedQwen, null);
  assert.equal(seen.some((url) => url.includes('58691')), false);
  assert.equal(calls.some((call) => call.args?.includes('serve')), false);
  await handle.shutdown('test');
});

test('bat launchers keep CRLF line endings (cmd.exe needs them)', async () => {
  for (const name of ['start-all.bat', 'start.bat', 'kill.bat']) {
    const text = await readFile(path.join(PROJECT_ROOT, name), 'utf8');
    assert.ok(text.includes('\r\n'), `${name} must contain CRLF`);
    assert.doesNotMatch(text, /(?<!\r)\n/, `${name} must not contain bare LF`);
  }
});

test('start-all.bat reuses the Node >= 22.13 selection and forwards arguments', async () => {
  const bat = await readFile(BAT_FILE, 'utf8');
  const startBat = await readFile(path.join(PROJECT_ROOT, 'start.bat'), 'utf8');

  assert.match(bat, /AIROOM_NODE/);
  assert.match(bat, /DeepSeek Harness/);
  assert.match(bat, /process\.versions\.node/);
  assert.match(bat, /22\.13/);
  assert.match(bat, /scripts\\start-all\.mjs/);
  assert.match(bat, /%\*/);
  assert.match(bat, /exit \/b %AIROOM_RC%/);
  assert.match(bat, /pause/);
  assert.match(bat, /state\\start-all\.log/);

  const versionCheck = /"([^"]*)" -e "const v=process\.versions\.node[^"]+"/.exec(startBat);
  assert.ok(versionCheck, 'start.bat contains a Node version check');
  assert.ok(bat.includes(versionCheck[0]), 'start-all.bat uses the same version check');
});

test('package.json exposes start:all', async () => {
  const pkg = JSON.parse(await readFile(PACKAGE_FILE, 'utf8'));
  assert.equal(pkg.scripts['start:all'], 'node scripts/start-all.mjs');
});
