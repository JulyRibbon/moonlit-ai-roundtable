// probes/zcode/lib.mjs — ZCode app-server 的最小零成本 NDJSON 客户端
//
// 只做 M0 探测，不属于 Room Core，也不被 Core 导入。
//
// 协议（2026-11-09 在 ZCode 0.17.1 实测）：
//   - 传输：stdin/stdout 各一行一个 JSON（NDJSON）
//   - 请求：{ "id": <number>, "method": "...", "params": {...} }
//   - 响应：{ "id": <number>, "result": {...} } 或 { "id": <number>, "error": {...} }
//   - 通知：{ "method": "...", "params": {...} }（无 id，如 startup/storageState）
//   - result 直接就是业务对象，没有 { ok, value } 信封。
//
// 约束：
//   - 子进程用 spawn(shell:false) 启动，必须带 ELECTRON_RUN_AS_NODE=1。
//   - 直接启动安装目录里的 zcode.cjs 时，还需给出内置 / 个人 provider 配置路径
//     （见 resolveProviderConfigs）；本模块只传路径，不读取配置内容。
//   - 所有对外文本都过 redact()；不打印请求头、token、凭据或环境变量全集。
//   - 关闭：先 end(stdin)，等子进程自行退出；超时才只杀本次 spawn 的进程树。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_EXE =
  process.env.AIROOM_ZCODE_EXE || 'C:\\Program Files\\ZCode\\ZCode.exe';
export const DEFAULT_CLI =
  process.env.AIROOM_ZCODE_CLI ||
  'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs';

const MAX_CAPTURE = 1024 * 1024;
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

export function sanitizePathInMessage(text) {
  return redact(text).replace(/\s+/g, ' ').trim();
}

export function resolveProviderConfigs({ exe = DEFAULT_EXE, cli = DEFAULT_CLI } = {}) {
  const cliDir = path.dirname(cli);
  const candidates = [
    process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
    path.join(cliDir, '..', 'config', 'provider', 'zcode-builtin.json'),
    path.join(cliDir, 'provider', 'zcode-builtin.json'),
  ].filter(Boolean);
  const builtin = candidates.find((p) => fs.existsSync(p)) || null;
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

export function baseEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  env.ELECTRON_RUN_AS_NODE = '1';
  const cfg = resolveProviderConfigs({
    exe: env.AIROOM_ZCODE_EXE || DEFAULT_EXE,
    cli: env.AIROOM_ZCODE_CLI || DEFAULT_CLI,
  });
  if (!env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE && cfg.builtin) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = cfg.builtin;
  }
  if (!env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE && cfg.personal) {
    env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = cfg.personal;
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
      } catch {}
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
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total < MAX_CAPTURE) chunks.push(chunk);
}

// 一次性 CLI 调用：--version / --help 等。stdin 立即关闭，不产生模型调用。
export function spawnFile(file, argv, { timeoutMs = 20000, env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, argv, {
        shell: false,
        windowsHide: true,
        env: env ?? baseEnv(),
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: sanitizePathInMessage(err?.message || err), stdout: '', stderr: '' });
      return;
    }

    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({
        ...payload,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        timedOut,
      });
    };

    let hardTimer = null;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
          hardTimer = setTimeout(() => {
            finish({ ok: false, error: `超时 ${timeoutMs}ms 且进程未退出`, code: null, signal: null });
          }, 3000);
          hardTimer.unref?.();
        }, timeoutMs)
      : null;

    child.stdout.on('data', (c) => capture(out, c));
    child.stderr.on('data', (c) => capture(err, c));
    child.on('error', (e) =>
      finish({ ok: false, error: sanitizePathInMessage(e?.code || e?.message || e) }),
    );
    child.on('exit', (code, signal) =>
      finish({ ok: !timedOut && code === 0, code, signal: signal ?? null }),
    );
    try {
      child.stdin.end();
    } catch {}
  });
}

// 常驻 app-server：NDJSON 请求 / 通知，按 id 匹配，逐请求超时。
export class AppServerClient {
  constructor({
    exe = process.env.AIROOM_ZCODE_EXE || DEFAULT_EXE,
    cli = process.env.AIROOM_ZCODE_CLI || DEFAULT_CLI,
    surface = 'desktop',
    env = baseEnv(),
    cwd,
    requestTimeoutMs = 20000,
    closeGraceMs = 5000,
  } = {}) {
    this.exe = exe;
    this.cli = cli;
    this.surface = surface;
    this.env = env;
    this.cwd = cwd;
    this.requestTimeoutMs = requestTimeoutMs;
    this.closeGraceMs = closeGraceMs;

    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.notificationCounts = new Map();
    this.malformed = 0;
    this.stderrChunks = [];
    this.stdoutBuffer = '';
    this.exitInfo = null;
    this.closed = false;
    this.onNotification = null;
    this.onServerRequest = null;
  }

  start() {
    if (this.child) throw new Error('app-server 已启动');
    const argv = [this.cli, 'app-server', '--stdio', '--surface', this.surface];
    this.child = spawn(this.exe, argv, {
      shell: false,
      windowsHide: true,
      env: this.env,
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.on('error', (e) => this.#failAll(e));
    this.child.on('exit', (code, signal) => {
      this.exitInfo = { code, signal: signal ?? null };
      this.closed = true;
      this.#failAll(new Error(`app-server 已退出（code=${code ?? '-'}, signal=${signal ?? '-'}）`));
    });
    this.child.stderr.on('data', (c) => capture(this.stderrChunks, c));
    this.child.stdout.on('data', (c) => this.#onStdout(c));
    return this;
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.malformed += 1;
        continue;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
      return;
    }
    if (msg.id !== undefined && typeof msg.method === 'string') {
      // 服务端主动请求：本探针不支持任何会改变会话状态的方法。
      const reply = {
        id: msg.id,
        error: { code: 'unsupported_by_probe', message: `probe 不处理 ${msg.method}` },
      };
      this.onServerRequest?.(msg);
      try {
        this.child.stdin.write(`${JSON.stringify(reply)}\n`);
      } catch {}
      return;
    }
    if (typeof msg.method === 'string') {
      this.notifications.push(msg);
      this.notificationCounts.set(
        msg.method,
        (this.notificationCounts.get(msg.method) || 0) + 1,
      );
      this.onNotification?.(msg);
    }
  }

  #failAll(err) {
    const message = sanitizePathInMessage(err?.message || err);
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
    }
    this.pending.clear();
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child) throw new Error('app-server 尚未启动');
    if (this.closed) throw new Error('app-server 已退出，无法发送请求');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求 ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`写入 ${method} 失败：${sanitizePathInMessage(err?.message || err)}`));
      }
    });
  }

  get stderrTail() {
    return Buffer.concat(this.stderrChunks).toString('utf8').trim();
  }

  async close() {
    if (!this.child) return { exited: true, killed: false, ...this.exitInfo };
    if (this.exitInfo) return { exited: true, killed: false, ...this.exitInfo };

    const exited = new Promise((resolve) => {
      if (this.exitInfo) return resolve(true);
      const onExit = () => resolve(true);
      this.child.once('exit', onExit);
      setTimeout(() => resolve(false), this.closeGraceMs).unref?.();
    });

    try {
      this.child.stdin.end();
    } catch {}

    let ok = await exited;
    let killedNow = false;
    if (!ok) {
      killedNow = killTree(this.child);
      ok = await new Promise((resolve) => {
        if (this.exitInfo) return resolve(true);
        const onExit = () => resolve(true);
        this.child.once('exit', onExit);
        setTimeout(() => resolve(false), 3000).unref?.();
      });
    }
    return {
      exited: ok,
      killed: killedNow,
      code: this.exitInfo?.code ?? null,
      signal: this.exitInfo?.signal ?? null,
    };
  }
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function formatTime(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function basenameOf(p) {
  if (typeof p !== 'string' || !p) return null;
  return path.basename(p.replace(/[\\/]+$/, '')) || null;
}
