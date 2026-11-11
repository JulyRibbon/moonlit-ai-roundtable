// Qwen Code 本地守护进程（`qwen serve`）的最小工具：解析运行时、拉起一次性实例、HTTP 探测。
//
// 只给 probes 用：房间自己的 Bridge 在 adapters/qwen-code/ 里，不依赖这个文件。
// Node 必须 >= 22（用全局 fetch）；本机请用 DSH 自带运行时：
//   C:\Users\YL2018\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  buildServeArgs,
  checkQwenHealth,
  resolveQwenRuntime,
} from '../../adapters/qwen-code/runtime.mjs';

export { resolveQwenRuntime };

const QWEN_HOME = path.join(os.homedir(), '.qwen');

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
        // ignore
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      server = net.createServer();
      server.once('error', () => finish(false));
      server.listen({ port, host, exclusive: true }, () => finish(true));
    } catch {
      finish(false);
    }
  });
}

export async function pickFreePort(preferred = 58691, { host = '127.0.0.1' } = {}) {
  for (let offset = 0; offset < 60; offset += 1) {
    const port = preferred + offset;
    if (await isPortFree(port, { host })) return port;
  }
  throw new Error(`在 ${preferred} 附近找不到空闲端口`);
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 拉起一次性 `qwen serve`（回环、免 token、只给一个临时 workspace）。
 * 返回 { child, baseUrl, port, logPath, stop() }；调用方必须在 finally 里 stop()。
 */
export async function startQwenDaemon({
  port,
  workspace,
  logPath,
  env = process.env,
  spawn = nodeSpawn,
  timeoutMs = 45000,
  intervalMs = 250,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  const runtime = resolveQwenRuntime(env);
  const actualPort = port ?? await pickFreePort(58691);
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  logStream.write(`\n===== qwen serve probe ${new Date().toISOString()} port=${actualPort} =====\n`);
  const args = buildServeArgs({ entry: runtime.entry, port: actualPort, workspace });
  const child = spawn(runtime.node, args, {
    cwd: workspace,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on?.('data', (chunk) => {
      try {
        logStream.write(chunk);
      } catch {
        // ignore
      }
    });
  }
  let exited = null;
  child.once?.('exit', (code, signal) => {
    exited = { code, signal };
  });
  const baseUrl = `http://127.0.0.1:${actualPort}`;
  const stop = async () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    await sleep(300);
    try {
      if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
    } catch {
      // ignore
    }
    try {
      logStream.end();
    } catch {
      // ignore
    }
  };

  const deadline = now() + timeoutMs;
  for (;;) {
    if (exited) {
      await stop();
      throw new Error(`qwen serve 在健康检查前退出（code=${exited.code} signal=${exited.signal}），日志：${logPath}`);
    }
    if (await checkQwenHealth(baseUrl)) {
      return { child, baseUrl, port: actualPort, logPath, runtime, stop };
    }
    if (now() >= deadline) {
      await stop();
      throw new Error(`qwen serve 在 ${timeoutMs}ms 内没有就绪，日志：${logPath}`);
    }
    await sleep(intervalMs);
  }
}

/**
 * 极简 HTTP 助手。回环免鉴权，所以默认不带 Authorization。
 * 返回 { status, headers, body }，body 若像 JSON 就解析。
 */
export async function httpJson(baseUrl, method, route, { body, timeoutMs = 15000, clientId } = {}) {
  const headers = { Accept: 'application/json' };
  if (clientId) headers['X-Qwen-Client-Id'] = clientId;
  const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, init);
  const text = await res.text();
  let parsed = text;
  try {
    parsed = text.length ? JSON.parse(text) : null;
  } catch {
    // 保留原文
  }
  return { status: res.status, headers: Object.fromEntries(res.headers), body: parsed };
}

/** 把对象里可疑的长数组/超长字符串压短，便于写进报告。 */
export function compact(value, { maxString = 400, maxArray = 8 } = {}) {
  if (typeof value === 'string') return value.length > maxString ? `${value.slice(0, maxString)}…(len=${value.length})` : value;
  if (Array.isArray(value)) return value.slice(0, maxArray).map((item) => compact(item, { maxString, maxArray }));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compact(v, { maxString, maxArray })]));
  }
  return value;
}

/** 读 ~/.qwen/settings.json 里「模型/强度」这一小块（不打印 env 里的密钥）。 */
export function readQwenModelExpectation(home = QWEN_HOME) {
  const file = path.join(home, 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const model = settings.model ?? {};
    return {
      file,
      modelName: model.name ?? null,
      reasoningEffort: model.reasoningEffort ?? null,
      baseUrl: model.baseUrl ?? null,
      stopHook: Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop.length : 0,
    };
  } catch (error) {
    return { file, error: String(error?.message ?? error) };
  }
}
