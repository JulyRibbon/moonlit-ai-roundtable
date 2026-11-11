// ZCode app-server 的最小生产客户端。
//
// 协议（2026-11-09 在 ZCode 0.17.1 实测）：
//   - 传输：stdin/stdout 各一行 JSON（NDJSON）
//   - 请求：{ "id": <number>, "method": "...", "params": {...} }
//   - 响应：{ "id": <number>, "result": {...} } 或 { "id": <number>, "error": {...} }
//   - 通知：{ "method": "...", "params": {...} }（无 id）
//   - result 就是业务对象，没有 { ok, value } 信封。
//
// 启动约束：
//   - ZCode.exe resources/glm/zcode.cjs app-server --stdio --surface desktop
//   - 必须带 ELECTRON_RUN_AS_NODE=1
//   - 直接启动 zcode.cjs 时只把 provider 配置的「路径」放进子进程环境，
//     不读取配置内容，不读取凭据。
//
// 关闭：先 end(stdin)，等子进程自行退出；超时才只杀本次 spawn 的进程树。
// 所有对外错误文本都过 redact()，不打印 token、请求头或环境变量全集。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ZCODE_PROTOCOL_VERSION = 1;
export const ZCODE_KNOWN_CLI_VERSION = '0.17.1';

// app-server 在 session/resume 期间会主动请求客户端的运行时偏好。
// 这些值是 ZCode bundle 中该请求超时/不支持时的兼容回退值：
// 只影响 ACP 运行时行为，不包含 workspace / model / thoughtLevel / mode。
export const ZCODE_DEFAULT_RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  toolSearchMode: 'off',
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
});

export const DEFAULT_ZCODE_EXE =
  process.env.AIROOM_ZCODE_EXE || 'C:\\Program Files\\ZCode\\ZCode.exe';
export const DEFAULT_ZCODE_CLI =
  process.env.AIROOM_ZCODE_CLI ||
  'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs';

const MAX_CAPTURE = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_CLOSE_GRACE_MS = 5000;
const killed = new WeakSet();

export function redact(input) {
  let s = String(input ?? '');
  s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');
  s = s.replace(/\b(?:sk|pk|ak)-[A-Za-z0-9_-]{8,}\b/g, '***');
  s = s.replace(
    /("(?:api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|token|secret|password)"\s*:\s*)"[^"]*"/gi,
    '$1"***"',
  );
  return s;
}

export function sanitizeMessage(text) {
  return redact(text).replace(/\s+/g, ' ').trim();
}

export function resolveProviderConfigs({ exe = DEFAULT_ZCODE_EXE, cli = DEFAULT_ZCODE_CLI } = {}) {
  const cliDir = path.dirname(cli);
  const candidates = [
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    path.join(cliDir, '..', 'config', 'provider', 'zcode-builtin.json'),
    path.join(cliDir, 'provider', 'zcode-builtin.json'),
  ].filter(Boolean);
  const builtin = candidates.find((candidate) => fs.existsSync(candidate)) || null;
  const personal =
    process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE ||
    path.join(os.homedir(), '.zcode', 'v2', 'provider_config.json');
  return {
    exe,
    cli,
    exeExists: fs.existsSync(exe),
    cliExists: fs.existsSync(cli),
    builtin,
    personal: fs.existsSync(personal) ? personal : null,
  };
}

export function zcodeBaseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  env.ELECTRON_RUN_AS_NODE = '1';
  const configs = resolveProviderConfigs({
    exe: env.AIROOM_ZCODE_EXE || DEFAULT_ZCODE_EXE,
    cli: env.AIROOM_ZCODE_CLI || DEFAULT_ZCODE_CLI,
  });
  if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && configs.builtin) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = configs.builtin;
  }
  if (!env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE && configs.personal) {
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = configs.personal;
  }
  return env;
}

export function killTree(child) {
  if (!child || child.exitCode !== null || killed.has(child)) return false;
  killed.add(child);
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.unref?.();
    } catch {
      try {
        child.kill();
      } catch {
        // 忽略：进程可能已经退出。
      }
    }
    return true;
  }
  try {
    child.kill('SIGKILL');
    return true;
  } catch {
    return false;
  }
}

function capture(chunks, chunk) {
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  if (total < MAX_CAPTURE) chunks.push(chunk);
}

export class ZCodeRpcError extends Error {
  constructor(message, { code = 'ZCODE_RPC_ERROR', method = null, details } = {}) {
    super(sanitizeMessage(message));
    this.name = 'ZCodeRpcError';
    this.code = code;
    this.method = method;
    this.retryable = false;
    this.details = details;
  }
}

export class ZCodeAppServerClient {
  constructor({
    exe = DEFAULT_ZCODE_EXE,
    cli = DEFAULT_ZCODE_CLI,
    surface = 'desktop',
    env,
    cwd,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
    clientVersion = null,
    protocolVersion = null,
    canRestart = false,
  } = {}) {
    this.exe = exe;
    this.cli = cli;
    this.surface = surface;
    this.env = env ?? zcodeBaseEnv();
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeGraceMs = closeGraceMs;
    this.clientVersion = clientVersion;
    this.protocolVersion = protocolVersion;
    this.canRestart = canRestart;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationCounts = new Map();
    this.malformed = 0;
    this.stderrChunks = [];
    this.stdoutBuffer = '';
    this.exitInfo = null;
    this.envelopeShape = null;
    this.onNotification = null;
    this.onServerRequest = null;
    this.onExit = null;

    this._closePromise = null;
    this._exitNotified = false;
  }

  get started() {
    return this.child !== null && this.exitInfo === null;
  }

  get dead() {
    return this.exitInfo !== null;
  }

  start() {
    if (this.child && this.exitInfo === null) return this;
    if (this.exitInfo !== null) {
      throw new ZCodeRpcError('app-server 已退出，无法重新启动此客户端。', {
        code: 'CLIENT_EXITED',
      });
    }

    const argv = [this.cli, 'app-server', '--stdio', '--surface', this.surface];
    const child = spawn(this.exe, argv, {
      shell: false,
      windowsHide: true,
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    child.on('error', (error) => {
      this._failAll(error);
      this._recordExit({ code: null, signal: null, error: sanitizeMessage(error?.message ?? error) });
    });
    child.on('exit', (code, signal) => {
      this._failAll(new Error(`app-server 已退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`));
      this._recordExit({ code, signal: signal ?? null });
    });
    child.stderr?.on('data', (chunk) => capture(this.stderrChunks, chunk));
    child.stdout?.on('data', (chunk) => this._onStdout(chunk));
    return this;
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child) {
      return Promise.reject(new ZCodeRpcError('app-server 尚未启动。', { code: 'CLIENT_NOT_STARTED', method }));
    }
    if (this.exitInfo !== null) {
      return Promise.reject(new ZCodeRpcError('app-server 已退出，无法发送请求。', { code: 'CLIENT_EXITED', method }));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZCodeRpcError(`请求 ${method} 超时（${timeoutMs}ms）。`, {
          code: 'REQUEST_TIMEOUT',
          method,
        }));
      }, Math.max(1, timeoutMs));
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ZCodeRpcError(`写入 ${method} 失败：${sanitizeMessage(error?.message ?? error)}`, {
          code: 'REQUEST_WRITE_FAILED',
          method,
        }));
      }
    });
  }

  get stderrTail() {
    return Buffer.concat(this.stderrChunks).toString('utf8').trim();
  }

  async close() {
    if (this._closePromise) return this._closePromise;
    this._closePromise = this._close();
    return this._closePromise;
  }

  async _close() {
    if (!this.child) return { exited: true, killed: false, code: null, signal: null };
    if (this.exitInfo) {
      return { exited: true, killed: false, code: this.exitInfo.code ?? null, signal: this.exitInfo.signal ?? null };
    }

    const waitExit = () => new Promise((resolve) => {
      if (this.exitInfo) return resolve(true);
      const onExit = () => resolve(true);
      this.child.once('exit', onExit);
      const detector = setInterval(() => {
        if (this.exitInfo) {
          clearInterval(detector);
          this.child.removeListener('exit', onExit);
          resolve(true);
        }
      }, 20);
      detector.unref?.();
      setTimeout(() => {
        clearInterval(detector);
        this.child.removeListener('exit', onExit);
        resolve(false);
      }, this.closeGraceMs).unref?.();
    });

    const exited = waitExit();
    try {
      this.child.stdin?.end();
    } catch {
      // 忽略：stdin 可能已经关闭。
    }

    let ok = await exited;
    let killedNow = false;
    if (!ok) {
      killedNow = killTree(this.child);
      ok = await new Promise((resolve) => {
        if (this.exitInfo) return resolve(true);
        const timer = setTimeout(() => resolve(false), 3000);
        timer.unref?.();
        this.child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    }

    return {
      exited: ok,
      killed: killedNow,
      code: this.exitInfo?.code ?? null,
      signal: this.exitInfo?.signal ?? null,
    };
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    let index;
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.malformed += 1;
        continue;
      }
      this._dispatch(message);
    }
  }

  _dispatch(message) {
    if (!message || typeof message !== 'object') return;

    // 服务端主动请求（有 id + method）必须先于响应匹配处理：两者共享 id 空间。
    if (message.id !== undefined && typeof message.method === 'string') {
      return this._handleServerRequest(message);
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);

      if (message.error) {
        const raw = message.error;
        entry.reject(new ZCodeRpcError(
          raw.message ?? `请求 ${entry.method} 失败。`,
          {
            code: raw.code ?? 'RPC_ERROR',
            method: entry.method,
            details: raw.data ?? raw.details,
          },
        ));
        return;
      }
      if (Object.prototype.hasOwnProperty.call(message, 'result')) {
        this.envelopeShape = 'result';
        entry.resolve(message.result ?? {});
        return;
      }
      if (Object.prototype.hasOwnProperty.call(message, 'value') || message.ok === true) {
        this.envelopeShape = 'ok-value';
        if (message.ok === false) {
          const raw = message.error ?? {};
          entry.reject(new ZCodeRpcError(
            raw.message ?? `请求 ${entry.method} 失败。`,
            {
              code: raw.code ?? 'RPC_ERROR',
              method: entry.method,
              details: raw.data ?? raw.details,
            },
          ));
          return;
        }
        entry.resolve(message.value ?? {});
        return;
      }
      this.envelopeShape = 'unknown';
      entry.resolve({});
      return;
    }

    if (typeof message.method === 'string') {
      this.notificationCounts.set(
        message.method,
        (this.notificationCounts.get(message.method) ?? 0) + 1,
      );
      try {
        this.onNotification?.(message);
      } catch (error) {
        this.stderrChunks.push(Buffer.from(`notification handler failed: ${sanitizeMessage(error?.message ?? error)}\n`));
      }
    }
  }

  async _handleServerRequest(message) {
    let reply;
    try {
      const handled = this.onServerRequest
        ? await this.onServerRequest(message)
        : null;
      if (handled && typeof handled === 'object' && ('result' in handled || 'error' in handled)) {
        reply = { id: message.id, ...handled };
      } else if (handled !== undefined && handled !== null) {
        reply = { id: message.id, result: handled };
      } else if (message.method === 'session/requestRuntimePreferences') {
        reply = { id: message.id, result: { ...ZCODE_DEFAULT_RUNTIME_PREFERENCES } };
      } else {
        reply = {
          id: message.id,
          error: { code: -32601, message: `Method not found: ${message.method}` },
        };
      }
    } catch (error) {
      reply = {
        id: message.id,
        error: { code: -32603, message: sanitizeMessage(error?.message ?? error) },
      };
    }

    try {
      this.child?.stdin?.write(`${JSON.stringify(reply)}\n`);
    } catch {
      // 忽略：stdin 可能已经关闭。
    }
    return reply;
  }

  _failAll(error) {
    const message = sanitizeMessage(error?.message ?? error);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new ZCodeRpcError(message, {
        code: error?.code ?? 'CLIENT_EXITED',
        method: entry.method,
      }));
    }
    this.pending.clear();
  }

  _recordExit(info) {
    if (this.exitInfo !== null) return;
    this.exitInfo = {
      code: info.code ?? null,
      signal: info.signal ?? null,
      error: info.error ?? null,
      at: new Date().toISOString(),
    };
    if (this._exitNotified) return;
    this._exitNotified = true;
    try {
      this.onExit?.(this.exitInfo);
    } catch {
      // 退出回调不得影响进程回收。
    }
  }
}

export function createZCodeClient(config) {
  return new ZCodeAppServerClient(config);
}
