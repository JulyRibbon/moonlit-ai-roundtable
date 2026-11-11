// scripts/start-all.mjs — one-command startup for the live room.
//
// Boot order:
//   1. probe the Kimi web instance; reuse it when healthy and never stop it;
//   2. otherwise start `kimi.exe web --port <kimiPort> --no-open`, discard its
//      banner (it can contain the bearer token) and wait for health;
//   3. start server/live.mjs, read the `[ai-room] open:` URL from its output;
//   4. open that URL in the browser unless --no-open;
//   5. keep running; on Ctrl+C / SIGTERM close live first, then only the Kimi
//      process this script started.
//
// Every external side effect (spawn, fetch, openUrl, sleep, fileExists) can be
// injected so the integration tests never start a real process.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  QWEN_DEFAULT_PORT,
  buildServeArgs,
  checkQwenHealth,
  resolveQwenRuntime,
} from '../adapters/qwen-code/runtime.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_CONFIG = 'config/members.local.json';
const DEFAULT_PORT = 2961;
const DEFAULT_KIMI_PORT = 58690;
const MAX_PORT = 65535;
/** Kimi web 冷启动可能超过 20s（机器忙时更久），默认给 60s，并打印等待进度。 */
const DEFAULT_HEALTH_TIMEOUT_MS = 60000;
const DEFAULT_PROGRESS_INTERVAL_MS = 5000;
/** live 要连接全部客户端；Qwen 会话恢复实测约 12s，默认放宽到 120s。 */
const DEFAULT_URL_TIMEOUT_MS = 120000;

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  '用法：node scripts/start-all.mjs [--config <path>] [--port N] [--kimi-port N] [--qwen-port N] [--no-open]',
  '',
  `默认配置 ${DEFAULT_CONFIG}，房间端口 ${DEFAULT_PORT}，Kimi 端口 ${DEFAULT_KIMI_PORT}，Qwen 端口 ${QWEN_DEFAULT_PORT}。`,
  '已有健康的 Kimi / Qwen 实例会被复用，退出时不会关闭；只关闭本脚本启动的那些。',
  '只有当配置里存在启用的 qwen-code 席位时，才会去管 Qwen 守护进程。',
].join('\n');

const OPEN_LINE = /^\[ai-room\] open: (\S+)\s*$/;
const SAFE_URL = /^https?:\/\/[A-Za-z0-9.\-:[\]]+\/[^\s"'`&|<>^]*$/;

export class StartAllError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'StartAllError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StartAllError);
    }
  }
}

function normalizePort(value, flag) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT) {
    throw new StartAllError(
      'CLI_PORT_INVALID',
      `${flag} 必须是 0..${MAX_PORT} 的整数，当前值：${JSON.stringify(value)}。${USAGE}`,
    );
  }
  return port;
}

function normalizeKimiPort(value) {
  const port = normalizePort(value, '--kimi-port');
  if (port === 0) {
    throw new StartAllError(
      'CLI_PORT_INVALID',
      `--kimi-port 必须是 1..${MAX_PORT} 的整数。${USAGE}`,
    );
  }
  return port;
}

/** Parse CLI args without touching the environment or spawning anything. */
export function parseArgs(argv = process.argv.slice(2), { projectRoot = PROJECT_ROOT } = {}) {
  const result = {
    configPath: path.resolve(projectRoot, DEFAULT_CONFIG),
    port: DEFAULT_PORT,
    kimiPort: DEFAULT_KIMI_PORT,
    qwenPort: QWEN_DEFAULT_PORT,
    open: true,
    help: false,
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      index += 1;
      continue;
    }
    if (arg === '--no-open') {
      result.open = false;
      index += 1;
      continue;
    }

    const match = /^(--config|--port|--kimi-port|--qwen-port)(?:=(.*))?$/.exec(arg);
    if (!match) {
      throw new StartAllError('CLI_UNKNOWN_ARGUMENT', `未知参数：${arg}。${USAGE}`);
    }
    const [, name, inline] = match;
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new StartAllError('CLI_VALUE_REQUIRED', `${name} 需要一个值。${USAGE}`);
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) {
      throw new StartAllError('CLI_VALUE_REQUIRED', `${name} 不能为空。${USAGE}`);
    }

    if (name === '--config') {
      result.configPath = path.resolve(projectRoot, value);
    } else if (name === '--port') {
      result.port = normalizePort(value, '--port');
    } else if (name === '--qwen-port') {
      result.qwenPort = normalizeKimiPort(value);
    } else {
      result.kimiPort = normalizeKimiPort(value);
    }
    index += 1;
  }
  return result;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultFileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 只做一次试探监听，判断端口能不能用。
 * 失败（EADDRINUSE/EACCES/超时）一律返回 false —— 宁可提前拦下并给清楚的话，
 * 也不要等子进程起不来时只留一行 EADDRINUSE。
 */
export function isPortFree(port, { host = '127.0.0.1', timeoutMs = 1000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let server = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        server?.close();
      } catch {
        // 已经关掉或从未打开。
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      server = net.createServer();
      server.once('error', () => finish(false));
      server.listen({ port, host, exclusive: true }, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

/**
 * 只读一眼配置文件，用来决定「要不要管某个客户端守护进程」。
 * 读不动/不是 JSON 时返回 null —— 后面的 live 子进程会给出真正的配置错误。
 */
export function readSeatPlan(configPath) {
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.seats)) return null;
    return {
      roomId: typeof parsed.roomId === 'string' ? parsed.roomId : null,
      seats: parsed.seats,
    };
  } catch {
    return null;
  }
}

export function planNeedsQwen(plan) {
  if (!plan) return false;
  return plan.seats.some((seat) => (
    seat
    && seat.clientType === 'qwen-code'
    && seat.enabled !== false
  ));
}

function defaultKimiExeCandidates(env = process.env) {
  const candidates = [];
  if (env.AIROOM_KIMI_EXE) candidates.push(env.AIROOM_KIMI_EXE);
  candidates.push(path.join(os.homedir(), '.kimi-code', 'bin', 'kimi.exe'));
  if (env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'Programs', 'Kimi Code', 'kimi.exe'));
  }
  return candidates;
}

function resolveKimiExe(options) {
  const exists = options.fileExists ?? defaultFileExists;
  if (options.kimiExe) {
    if (!exists(options.kimiExe)) {
      throw new StartAllError('KIMI_EXE_MISSING', `指定的 kimi.exe 不存在：${options.kimiExe}`);
    }
    return options.kimiExe;
  }
  for (const candidate of defaultKimiExeCandidates(options.env)) {
    if (exists(candidate)) return candidate;
  }
  throw new StartAllError(
    'KIMI_EXE_MISSING',
    '找不到本机 kimi.exe：请设置 AIROOM_KIMI_EXE，或先安装 Kimi Code（默认 ~/.kimi-code/bin/kimi.exe）。',
  );
}

/** A healthy Kimi answers HTTP at its meta endpoint; any non-5xx reply means the port is live. */
export async function checkKimiHealth({ port, fetch: fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const signal = typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/v1/meta`, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    const status = Number(response?.status);
    const healthy = Number.isFinite(status) && status < 500;
    response?.body?.cancel?.().catch?.(() => {});
    return healthy;
  } catch {
    return false;
  }
}

function attachLineReader(stream, onLine) {
  if (!stream || typeof stream.on !== 'function') return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += String(chunk);
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      onLine(line);
      newline = buffer.indexOf('\n');
    }
  });
}

function discardOutput(child) {
  for (const stream of [child?.stdout, child?.stderr]) {
    if (!stream) continue;
    if (typeof stream.on === 'function') stream.on('data', () => {});
    if (typeof stream.resume === 'function') stream.resume();
  }
}

/**
 * Qwen 守护进程的 stdout/stderr 落盘：启动失败、ACP 恢复失败的原因只写在它自己的输出里，
 * 直接 discard 会丢掉唯一线索。目录创建或写入失败不影响启动。
 */
function createChildLog(filePath) {
  let stream = null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
  const write = (chunk) => {
    const target = stream;
    if (!target) return;
    try {
      target.write(chunk);
    } catch {
      stream = null;
    }
  };
  return {
    filePath,
    pipe(child) {
      for (const source of [child?.stdout, child?.stderr]) {
        if (!source) continue;
        if (typeof source.on === 'function') source.on('data', write);
        if (typeof source.resume === 'function') source.resume();
      }
    },
    close() {
      const target = stream;
      stream = null;
      try {
        target?.end();
      } catch {
        // 已经关了。
      }
    },
  };
}

function childExited(child) {
  return !child || child.exitCode != null || child.signalCode != null;
}

function waitForExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (typeof child.removeListener === 'function') child.removeListener('exit', onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('exit', onExit);
  });
}

async function stopChild(child, { timeoutMs, log, label }) {
  if (!child || childExited(child)) return;
  log(`[ai-room] stopping ${label}...`);
  try {
    child.kill('SIGTERM');
  } catch {
    // Already gone or not killable; the exit wait below settles either way.
  }
  const exited = await waitForExit(child, timeoutMs);
  if (!exited && !childExited(child)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Best effort only.
    }
    await waitForExit(child, 1000);
  }
}

function validateRoomUrl(raw) {
  if (typeof raw !== 'string' || !SAFE_URL.test(raw)) {
    throw new StartAllError('URL_INVALID', '房间输出的启动 URL 不可用。');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new StartAllError('URL_INVALID', '房间输出的启动 URL 不可用。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new StartAllError('URL_INVALID', '房间输出的启动 URL 协议不受支持。');
  }
  return raw;
}

/** Open a URL through Windows cmd /c start; the URL is passed as one argv item. */
export function openUrlWithCmd(url) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = nodeSpawn('cmd.exe', ['/d', '/c', 'start', '', url], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`cmd /c start exited with ${code}`));
    });
  });
}

export async function startAll(options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const openUrl = options.openUrl ?? openUrlWithCmd;
  const log = options.log ?? console.log;
  const logError = options.error ?? console.error;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const fileExists = options.fileExists ?? defaultFileExists;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const cwd = options.cwd ?? projectRoot;
  const env = options.env ?? process.env;
  const isPortFreeImpl = options.isPortFree ?? isPortFree;
  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const healthIntervalMs = options.healthIntervalMs ?? 250;
  const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const urlTimeoutMs = options.urlTimeoutMs ?? DEFAULT_URL_TIMEOUT_MS;
  const killTimeoutMs = options.killTimeoutMs ?? 5000;

  const configPath = path.resolve(options.configPath ?? path.join(projectRoot, DEFAULT_CONFIG));
  const port = options.port === undefined ? DEFAULT_PORT : normalizePort(options.port, 'port');
  const kimiPort = options.kimiPort === undefined
    ? DEFAULT_KIMI_PORT
    : normalizeKimiPort(options.kimiPort);
  const qwenPort = options.qwenPort === undefined
    ? QWEN_DEFAULT_PORT
    : normalizeKimiPort(options.qwenPort);
  const shouldOpen = options.open !== false;
  const seatPlan = options.seatPlan ?? readSeatPlan(configPath);
  const needsQwen = options.needsQwen ?? planNeedsQwen(seatPlan);
  const roomId = seatPlan?.roomId ?? 'r_main';
  const qwenWorkspace = path.resolve(
    options.qwenWorkspace ?? path.join(projectRoot, 'rooms', roomId, 'qwen'),
  );
  const qwenBaseUrl = `http://127.0.0.1:${qwenPort}`;

  if (!fileExists(configPath)) {
    throw new StartAllError(
      'CONFIG_MISSING',
      `找不到配置文件 ${configPath}。请复制 config/members.example.json 为 ${DEFAULT_CONFIG} 并填写成员会话，或用 --config 指定。`,
    );
  }

  // 端口预检：最常见的「点了没反应/闪一下就没了」就是上一次的 ai-room 还占着 2961。
  // 提前拦下来，比等 live 子进程报 EADDRINUSE 再打印一行英文强得多。
  if (port !== 0 && !(await isPortFreeImpl(port))) {
    throw new StartAllError(
      'ROOM_PORT_IN_USE',
      `房间端口 ${port} 已被占用（很可能上一次的 ai-room 还开着）。`
        + '先运行 kill.bat --all 关掉它，或用 --port 换一个端口。',
      { port },
    );
  }

  let kimiChild = null;
  let liveChild = null;
  let qwenChild = null;
  let ownKimi = false;
  let ownQwen = false;
  let kimiExit = null;
  let qwenExit = null;
  let qwenLog = null;
  let shuttingDown = false;
  let ready = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const shutdown = async (reason, code = EXIT_OK) => {
    if (shuttingDown) return done;
    shuttingDown = true;
    log(`[ai-room] ${reason}: shutting down...`);
    await stopChild(liveChild, { timeoutMs: killTimeoutMs, log, label: 'live room' });
    if (ownKimi) {
      await stopChild(kimiChild, { timeoutMs: killTimeoutMs, log, label: 'Kimi instance started by start-all' });
    } else if (kimiChild) {
      log('[ai-room] reused Kimi instance left running.');
    }
    if (ownQwen) {
      await stopChild(qwenChild, { timeoutMs: killTimeoutMs, log, label: 'Qwen daemon started by start-all' });
    } else if (qwenChild) {
      log('[ai-room] reused Qwen daemon left running.');
    }
    qwenLog?.close();
    qwenLog = null;
    resolveDone({ code, reason });
    return done;
  };

  const cleanupAfterBootFailure = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stopChild(liveChild, { timeoutMs: killTimeoutMs, log, label: 'live room' });
    if (ownKimi) {
      await stopChild(kimiChild, { timeoutMs: killTimeoutMs, log, label: 'Kimi instance started by start-all' });
    }
    if (ownQwen) {
      await stopChild(qwenChild, { timeoutMs: killTimeoutMs, log, label: 'Qwen daemon started by start-all' });
    }
    qwenLog?.close();
    qwenLog = null;
    resolveDone({ code: EXIT_FAILED, reason: 'boot-failed' });
  };

  try {
    log(`[ai-room] config: ${configPath}`);
    log(`[ai-room] room port: ${port}, Kimi port: ${kimiPort}${needsQwen ? `, Qwen port: ${qwenPort}` : ''}`);

    const healthy = await checkKimiHealth({ port: kimiPort, fetch: fetchImpl });
    if (healthy) {
      log(`[ai-room] reusing healthy Kimi instance on port ${kimiPort} (will not stop it).`);
    } else {
      if (!(await isPortFreeImpl(kimiPort))) {
        throw new StartAllError(
          'KIMI_PORT_IN_USE',
          `Kimi 端口 ${kimiPort} 已被占用，但健康检查没有通过（可能是一个卡住的 kimi web）。`
            + '先结束那个进程，或用 --kimi-port 换一个端口。',
          { kimiPort },
        );
      }
      const kimiExe = resolveKimiExe({ ...options, env, fileExists });
      log(`[ai-room] starting Kimi: ${kimiExe} web --port ${kimiPort} --no-open`);
      try {
        kimiChild = spawn(kimiExe, ['web', '--port', String(kimiPort), '--no-open'], {
          cwd,
          env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        throw new StartAllError('KIMI_SPAWN_FAILED', `启动 Kimi 失败：${error?.message ?? error}`);
      }
      ownKimi = true;
      discardOutput(kimiChild);
      kimiChild.once?.('error', (error) => {
        kimiExit = { error };
        if (ready && !shuttingDown) {
          logError(`[ai-room] Kimi failed: ${error?.message ?? error}; stopping the live room.`);
          void shutdown('Kimi failed', EXIT_FAILED);
        }
      });
      kimiChild.once?.('exit', (code, signal) => {
        kimiExit = { code, signal };
        if (ready && !shuttingDown) {
          logError('[ai-room] Kimi exited unexpectedly; stopping the live room.');
          void shutdown('Kimi exited', EXIT_FAILED);
        }
      });

      const deadline = now() + healthTimeoutMs;
      const startedAt = now();
      let lastProgressAt = now();
      let kimiHealthy = false;
      for (;;) {
        if (kimiExit) {
          const detail = kimiExit.error?.message
            ?? `exit code ${kimiExit.code ?? '?'}${kimiExit.signal ? `, signal ${kimiExit.signal}` : ''}`;
          throw new StartAllError('KIMI_EXITED', `Kimi 在健康检查前退出（${detail}）。`);
        }
        kimiHealthy = await checkKimiHealth({ port: kimiPort, fetch: fetchImpl });
        if (kimiHealthy) break;
        if (now() >= deadline) {
          throw new StartAllError(
            'KIMI_HEALTH_TIMEOUT',
            `Kimi 在 ${healthTimeoutMs}ms 内没有在端口 ${kimiPort} 上就绪。`,
          );
        }
        if (progressIntervalMs > 0 && now() - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = now();
          log(
            `[ai-room] 仍在等待 Kimi 就绪（端口 ${kimiPort}，已等 ${Math.round((now() - startedAt) / 1000)}s`
            + ` / ${Math.round(healthTimeoutMs / 1000)}s）...`,
          );
        }
        await sleep(healthIntervalMs);
      }
      log(`[ai-room] Kimi is healthy on port ${kimiPort}.`);
    }

    if (needsQwen) {
      const qwenHealthy = await checkQwenHealth(qwenBaseUrl, { fetchImpl });
      if (qwenHealthy) {
        log(`[ai-room] reusing healthy Qwen daemon on port ${qwenPort} (will not stop it).`);
      } else {
        if (!(await isPortFreeImpl(qwenPort))) {
          throw new StartAllError(
            'QWEN_PORT_IN_USE',
            `Qwen 端口 ${qwenPort} 已被占用，但 /health 没有响应（可能是一个卡住的 qwen serve）。`
              + '先结束那个进程，或用 --qwen-port 换一个端口。',
            { qwenPort },
          );
        }
        let qwenRuntime;
        try {
          qwenRuntime = (options.resolveQwenRuntime ?? resolveQwenRuntime)({ env, fileExists });
        } catch (error) {
          throw new StartAllError('QWEN_RUNTIME_MISSING', String(error?.message ?? error));
        }
        const qwenServeLogPath = options.qwenServeLogPath
          ?? path.join(projectRoot, 'state', 'qwen-serve.log');
        qwenLog = createChildLog(qwenServeLogPath);
        log(
          `[ai-room] starting Qwen daemon: ${qwenRuntime.node} ${path.basename(qwenRuntime.entry)}`
          + ` serve --port ${qwenPort} --workspace ${qwenWorkspace} (log: ${qwenServeLogPath})`,
        );
        try {
          qwenChild = spawn(
            qwenRuntime.node,
            buildServeArgs({ entry: qwenRuntime.entry, port: qwenPort, workspace: qwenWorkspace }),
            { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
          );
        } catch (error) {
          qwenLog.close();
          qwenLog = null;
          throw new StartAllError('QWEN_SPAWN_FAILED', `启动 Qwen 守护进程失败：${error?.message ?? error}`);
        }
        ownQwen = true;
        qwenLog.pipe(qwenChild);
        qwenChild.once?.('error', (error) => {
          qwenExit = { error };
          if (ready && !shuttingDown) {
            logError(`[ai-room] Qwen daemon failed: ${error?.message ?? error}; stopping the live room.`);
            void shutdown('Qwen failed', EXIT_FAILED);
          }
        });
        qwenChild.once?.('exit', (code, signal) => {
          qwenExit = { code, signal };
          if (ready && !shuttingDown) {
            logError('[ai-room] Qwen daemon exited unexpectedly; stopping the live room.');
            void shutdown('Qwen exited', EXIT_FAILED);
          }
        });

        const deadline = now() + healthTimeoutMs;
        const startedAt = now();
        let lastProgressAt = now();
        for (;;) {
          if (qwenExit) {
            const detail = qwenExit.error?.message
              ?? `exit code ${qwenExit.code ?? '?'}${qwenExit.signal ? `, signal ${qwenExit.signal}` : ''}`;
            throw new StartAllError('QWEN_EXITED', `Qwen 守护进程在健康检查前退出（${detail}）。`);
          }
          if (await checkQwenHealth(qwenBaseUrl, { fetchImpl })) break;
          if (now() >= deadline) {
            throw new StartAllError(
              'QWEN_HEALTH_TIMEOUT',
              `Qwen 守护进程在 ${healthTimeoutMs}ms 内没有在端口 ${qwenPort} 上就绪。`,
            );
          }
          if (progressIntervalMs > 0 && now() - lastProgressAt >= progressIntervalMs) {
            lastProgressAt = now();
            log(
              `[ai-room] 仍在等待 Qwen 就绪（端口 ${qwenPort}，已等 ${Math.round((now() - startedAt) / 1000)}s`
              + ` / ${Math.round(healthTimeoutMs / 1000)}s）...`,
            );
          }
          await sleep(healthIntervalMs);
        }
        log(`[ai-room] Qwen daemon is healthy on port ${qwenPort}.`);
      }
    } else {
      log('[ai-room] no enabled qwen-code seat in config; skipping Qwen daemon.');
    }

    liveChild = spawn(process.execPath, [
      path.join(projectRoot, 'server/live.mjs'),
      '--config', configPath,
      '--port', String(port),
    ], {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!liveChild) {
      throw new StartAllError('LIVE_SPAWN_FAILED', '启动 live room 失败：spawn 没有返回子进程。');
    }

    let resolveUrl;
    let rejectUrl;
    const urlPromise = new Promise((resolve, reject) => {
      resolveUrl = resolve;
      rejectUrl = reject;
    });
    const stderrTail = [];
    attachLineReader(liveChild.stdout, (line) => {
      const match = OPEN_LINE.exec(line);
      if (match) {
        resolveUrl(match[1]);
        return;
      }
      log(line);
    });
    attachLineReader(liveChild.stderr, (line) => {
      if (line.length === 0) return;
      stderrTail.push(line);
      if (stderrTail.length > 5) stderrTail.shift();
      logError(line);
    });

    liveChild.once('error', (error) => {
      if (!ready) {
        rejectUrl(new StartAllError('LIVE_SPAWN_FAILED', `启动 live room 失败：${error?.message ?? error}`));
        return;
      }
      if (!shuttingDown) {
        logError(`[ai-room] live room failed: ${error?.message ?? error}`);
        void shutdown('live room failed', EXIT_FAILED);
      }
    });
    liveChild.once('exit', (code, signal) => {
      if (!ready) {
        const detail = stderrTail.length > 0 ? ` ${stderrTail[stderrTail.length - 1]}` : '';
        rejectUrl(new StartAllError(
          'LIVE_EXITED',
          `live room 在就绪前退出（exit code ${code ?? '?'}${signal ? `, signal ${signal}` : ''}）。${detail}`.trim(),
        ));
        return;
      }
      if (!shuttingDown) {
        logError(`[ai-room] live room exited unexpectedly (code ${code ?? '?'}); stopping what start-all started.`);
        void shutdown('live room exited', code ?? EXIT_FAILED);
      }
    });

    let urlTimer;
    const timedOut = new Promise((_, reject) => {
      urlTimer = setTimeout(() => {
        reject(new StartAllError(
          'LIVE_URL_TIMEOUT',
          `live room 在 ${urlTimeoutMs}ms 内没有输出启动 URL。`
          + (stderrTail.length ? ` 最近 stderr：${stderrTail.slice(-2).join(' | ')}` : ''),
        ));
      }, urlTimeoutMs);
      if (typeof urlTimer.unref === 'function') urlTimer.unref();
    });

    let url;
    try {
      url = validateRoomUrl(await Promise.race([urlPromise, timedOut]));
    } finally {
      clearTimeout(urlTimer);
    }

    ready = true;

    if (shouldOpen) {
      log('[ai-room] opening the room in the default browser...');
      try {
        await openUrl(url);
      } catch (error) {
        logError(`[ai-room] could not open the browser automatically: ${error?.message ?? error}`);
      }
    } else {
      const published = new URL(url);
      published.hash = '';
      log(`[ai-room] --no-open: browser launch skipped; room is at ${published.toString()}`);
    }

    log('[ai-room] start-all ready. Press Ctrl+C to stop the room.');
    return {
      url,
      port,
      kimiPort,
      qwenPort,
      qwenWorkspace,
      needsQwen,
      configPath,
      ownKimi,
      reusedKimi: !ownKimi,
      kimiChild,
      ownQwen,
      reusedQwen: needsQwen ? !ownQwen : null,
      qwenChild,
      liveChild,
      done,
      shutdown,
    };
  } catch (error) {
    await cleanupAfterBootFailure();
    throw error;
  }
}

/**
 * 本次运行的日志文件：`state/start-all.log`。
 * 双击 .bat 失败时窗口会关掉，唯一能事后看的就是这个文件；
 * 超过 1MB 就先转存成 `.1`，避免无限增长。写入失败不影响启动。
 */
function createRunLogger(filePath) {
  let stream = null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      if (fs.statSync(filePath).size > 1024 * 1024) fs.renameSync(filePath, `${filePath}.1`);
    } catch {
      // 文件不存在或转存失败都继续。
    }
    stream = fs.createWriteStream(filePath, { flags: 'a' });
    stream.write(`\n===== start-all ${new Date().toISOString()} =====\n`);
    stream.on('error', () => {
      stream = null;
    });
  } catch {
    stream = null;
  }
  const write = (level, args) => {
    if (!stream) return;
    const line = args.map((value) => String(value)).join(' ');
    try {
      stream.write(`[${level}] ${line}\n`);
    } catch {
      stream = null;
    }
  };
  return {
    log: (...args) => write('out', args),
    error: (...args) => write('err', args),
    close: () => {
      try {
        stream?.end();
      } catch {
        // 已经关了。
      }
    },
  };
}

const isMain = typeof process.argv[1] === 'string'
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  let args;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(`[ai-room] ${error?.message ?? error}`);
    process.exitCode = error?.code?.startsWith('CLI_') ? EXIT_USAGE : EXIT_FAILED;
    args = null;
  }

  if (args?.help) {
    console.log(USAGE);
    process.exitCode = EXIT_OK;
  } else if (args) {
    const runLog = createRunLogger(path.join(PROJECT_ROOT, 'state', 'start-all.log'));
    let handle = null;
    try {
      handle = await startAll({
        ...args,
        log: (line) => {
          console.log(line);
          runLog.log(line);
        },
        error: (line) => {
          console.error(line);
          runLog.error(line);
        },
      });
    } catch (error) {
      const message = `[ai-room] start-all failed: ${error?.message ?? error}`;
      console.error(message);
      runLog.error(message);
      console.error('[ai-room] 详细日志已写入 state\\start-all.log');
      process.exitCode = EXIT_FAILED;
    }

    if (handle) {
      let signalled = false;
      const onSignal = (signal) => {
        if (signalled) return;
        signalled = true;
        console.log(`\n[ai-room] ${signal} received.`);
        void handle.shutdown(signal);
      };
      process.on('SIGINT', () => onSignal('SIGINT'));
      process.on('SIGTERM', () => onSignal('SIGTERM'));

      const result = await handle.done;
      process.exitCode = result.code;
    }
    runLog.close();
  }
}
