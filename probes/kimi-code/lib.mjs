// probes/kimi-code/lib.mjs — Kimi Code 本地 Server API 的最小零成本客户端
//
// 只做 M0 探测，不属于 Room Core，也不被 Core 导入。
// 约定：
//   - REST 一律检查业务信封的 code，code !== 0 视为失败。
//   - token 只从 AIROOM_KIMI_TOKEN 或 ~/.kimi-code/server.token 读取，绝不打印、
//     不写入 argv、不进入错误文本；所有出口文本都过 redact()。
//   - 不发起任何模型调用；本模块只封装 HTTP / WS 连接。
//
// Node 必须 >= 22（内置 WebSocket 与 fetch）；本机 PATH 上的 node 可能是 v18。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE = 'http://127.0.0.1:58690';
export const TOKEN_FILE = path.join(os.homedir(), '.kimi-code', 'server.token');
export const BEARER_SUBPROTOCOL_PREFIX = 'kimi-code.bearer.';

export function resolveBase(raw = process.env.AIROOM_KIMI_BASE) {
  const s = String(raw || DEFAULT_BASE).trim().replace(/\/+$/, '');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`AIROOM_KIMI_BASE 不是合法 URL：${s}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`AIROOM_KIMI_BASE 只支持 http/https：${u.protocol}`);
  }
  return s;
}

export function redact(text, token = '') {
  let s = String(text ?? '');
  if (token) s = s.split(token).join('***');
  return s
    .replace(/kimi-code\.bearer\.[^\s"',;]+/g, 'kimi-code.bearer.***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}

export async function loadToken() {
  const fromEnv = process.env.AIROOM_KIMI_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  try {
    const raw = await fs.readFile(TOKEN_FILE, 'utf8');
    const token = raw.trim();
    if (!token) throw Object.assign(new Error('empty token file'), { code: 'EMPTY' });
    return token;
  } catch (err) {
    const code = err?.code || 'read failed';
    throw new Error(
      `未找到可用 token：请设置 AIROOM_KIMI_TOKEN，或确认 ${TOKEN_FILE} 可读（${code}）`,
    );
  }
}

export class KimiApiError extends Error {
  constructor(message, { code = null, httpStatus = null, requestId = null } = {}) {
    super(message);
    this.name = 'KimiApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
}

export class KimiApi {
  constructor({ base = resolveBase(), token = '', timeoutMs = 15000 } = {}) {
    this.base = String(base).replace(/\/+$/, '');
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  async request(method, pathname, { body, timeoutMs = this.timeoutMs, envelope = true } = {}) {
    const url = this.base + (pathname.startsWith('/') ? pathname : `/${pathname}`);
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let payload;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const detail =
        err?.name === 'TimeoutError'
          ? `超时 ${timeoutMs}ms`
          : err?.cause?.code || err?.message || 'network error';
      throw new KimiApiError(`请求 ${method} ${pathname} 失败：${redact(detail, this.token)}`);
    }

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (json === null) {
      throw new KimiApiError(
        `请求 ${method} ${pathname} 返回非 JSON（HTTP ${res.status}）：${redact(text.slice(0, 200), this.token)}`,
        { httpStatus: res.status },
      );
    }

    if (!envelope) {
      if (!res.ok) {
        throw new KimiApiError(`请求 ${method} ${pathname} 失败（HTTP ${res.status}）`, {
          httpStatus: res.status,
        });
      }
      return json;
    }

    if (json.code !== 0) {
      throw new KimiApiError(
        `${method} ${pathname} 业务错误 code=${json.code ?? '?'}：${redact(json.msg ?? 'unknown', this.token)}`,
        { code: json.code ?? null, httpStatus: res.status, requestId: json.request_id ?? null },
      );
    }
    return json.data;
  }

  get(pathname, opts) {
    return this.request('GET', pathname, opts);
  }

  meta() {
    return this.get('/api/v1/meta');
  }

  openapi() {
    return this.get('/openapi.json', { envelope: false });
  }

  asyncapi() {
    return this.get('/asyncapi.json', { envelope: false });
  }
}

export function wsUrl(base = resolveBase()) {
  const u = new URL(base);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/v1/ws';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export function bearerSubprotocol(token) {
  if (!token) throw new Error('缺少 token，无法构造 WebSocket 子协议');
  return `${BEARER_SUBPROTOCOL_PREFIX}${token}`;
}

export function wsUrlForDisplay(base = resolveBase()) {
  return wsUrl(base);
}

export function formatError(err, token = '') {
  if (err instanceof KimiApiError) {
    const bits = [err.message];
    if (err.requestId) bits.push(`request_id=${err.requestId}`);
    return redact(bits.join(' · '), token);
  }
  return redact(err?.message || String(err), token);
}
