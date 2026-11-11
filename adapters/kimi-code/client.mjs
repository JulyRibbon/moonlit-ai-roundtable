// Kimi Code local Server API 客户端。
//
// 只封装本机 `kimi web` 的 REST 与 WebSocket：
//   - REST 统一信封 { code, msg, data, request_id }，code !== 0 一律视为失败；
//   - /openapi.json、/asyncapi.json 是裸 JSON，不走信封；
//   - WS 使用本机实测的 subscribe_v2 / unsubscribe_v2 控制帧与 bearer 子协议；
//   - token 只存在内存里，绝不打印、不进入 URL 或错误文本，所有出口文本都过 redact()。
//
// 生产 transport 使用 Node ≥ 22 的全局 fetch / WebSocket；测试可整体注入
// { fetch, WebSocket }，注入 transport 时不会去读 token 文件。

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { BridgeError } from '../contract.mjs';

export const KIMI_DEFAULT_BASE_URL = 'http://127.0.0.1:58690';
export const DEFAULT_BASE_URL = KIMI_DEFAULT_BASE_URL;
export const KIMI_TOKEN_FILE = path.join(os.homedir(), '.kimi-code', 'server.token');
export const KIMI_BEARER_SUBPROTOCOL_PREFIX = 'kimi-code.bearer.';

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_WS_TIMEOUT_MS = 10000;
const BEARER_PREFIX = KIMI_BEARER_SUBPROTOCOL_PREFIX;

export function redact(text, token = '') {
  let value = String(text ?? '');
  if (token) value = value.split(token).join('***');
  return value
    .replace(/kimi-code\.bearer\.[^\s"',;]+/g, 'kimi-code.bearer.***')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}

export function normalizeBaseUrl(raw = KIMI_DEFAULT_BASE_URL) {
  const value = String(raw || KIMI_DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BridgeError('CONFIG_INVALID', `Invalid Kimi Code base URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BridgeError('CONFIG_INVALID', `Kimi Code base URL must be http(s): ${url.protocol}`);
  }
  return value;
}

export function wsUrlFor(baseUrl = KIMI_DEFAULT_BASE_URL) {
  const url = new URL(normalizeBaseUrl(baseUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/v1/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function bearerSubprotocol(token) {
  if (!token) throw new BridgeError('KIMI_TOKEN_MISSING', 'A token is required to build the WebSocket subprotocol.');
  return `${BEARER_PREFIX}${token}`;
}

export async function resolveToken({ token, env = process.env, tokenFile = KIMI_TOKEN_FILE } = {}) {
  if (typeof token === 'string') return token.trim();

  const fromEnv = env?.AIROOM_KIMI_TOKEN;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();

  try {
    const raw = await fs.readFile(tokenFile, 'utf8');
    const value = raw.trim();
    if (!value) throw Object.assign(new Error('empty token file'), { code: 'EMPTY' });
    return value;
  } catch (error) {
    throw new BridgeError(
      'KIMI_TOKEN_MISSING',
      'No Kimi Code token available; set AIROOM_KIMI_TOKEN or provide config.token.',
      { details: { reason: String(error?.code ?? 'read failed') } },
    );
  }
}

export class KimiApiError extends Error {
  constructor(message, { code = null, httpStatus = null, requestId = null, retryable = false } = {}) {
    super(message);
    this.name = 'KimiApiError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    this.retryable = retryable;
  }
}

function buildPath(pathname, query) {
  if (!query) return pathname;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}

function numericCode(code) {
  if (typeof code === 'number' && Number.isFinite(code)) return code;
  if (typeof code === 'string' && /^\d+$/.test(code)) return Number(code);
  return null;
}

function codeIsRetryable(code) {
  return code === 40931 || code === 40932;
}

function parseBody(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class KimiCodeClient {
  constructor({
    baseUrl = KIMI_DEFAULT_BASE_URL,
    token = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    transport = null,
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = typeof token === 'string' ? token : '';
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

    const fetchImpl = transport?.fetch ?? globalThis.fetch;
    const WebSocketImpl = transport?.WebSocket ?? globalThis.WebSocket;
    if (typeof fetchImpl !== 'function') {
      throw new BridgeError('RUNTIME_UNSUPPORTED', 'Kimi Code client requires fetch (Node >= 22).');
    }
    this._fetch = fetchImpl;
    // probe 只需要 REST；WebSocket 在 openStream() 时再要求。
    this._WebSocket = typeof WebSocketImpl === 'function' ? WebSocketImpl : null;
  }

  redact(text) {
    return redact(text, this.token);
  }

  async request(method, pathname, { body, query, envelope = true, timeoutMs = this.timeoutMs } = {}) {
    const url = this.baseUrl + buildPath(pathname, query);
    const headers = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const init = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(Math.max(1, timeoutMs));
    }

    let response;
    try {
      response = await this._fetch(url, init);
    } catch (error) {
      const detail = error?.name === 'TimeoutError'
        ? `timeout ${timeoutMs}ms`
        : error?.cause?.code || error?.message || 'network error';
      throw new KimiApiError(
        `Request ${method} ${pathname} failed: ${this.redact(detail)}`,
        { code: 'NETWORK_ERROR', retryable: true },
      );
    }

    let text = '';
    try {
      text = await response.text();
    } catch (error) {
      throw new KimiApiError(
        `Request ${method} ${pathname} failed while reading the response: ${this.redact(error?.message ?? error)}`,
        { code: 'NETWORK_ERROR', retryable: true, httpStatus: response?.status ?? null },
      );
    }

    const json = parseBody(text);
    if (json === null) {
      throw new KimiApiError(
        `Request ${method} ${pathname} returned non-JSON (HTTP ${response?.status ?? '?'}): ${this.redact(text.slice(0, 200))}`,
        { code: 'INVALID_RESPONSE', httpStatus: response?.status ?? null },
      );
    }

    if (!envelope) {
      if (response?.ok === false) {
        throw new KimiApiError(
          `Request ${method} ${pathname} failed (HTTP ${response.status}): ${this.redact(text.slice(0, 200))}`,
          { code: 'HTTP_ERROR', httpStatus: response.status, retryable: response.status >= 500 },
        );
      }
      return json;
    }

    if (json.code !== 0) {
      const code = numericCode(json.code);
      throw new KimiApiError(
        `${method} ${pathname} failed with code=${json.code ?? '?'}: ${this.redact(json.msg ?? 'unknown error')}`,
        {
          code: code ?? json.code ?? null,
          httpStatus: response?.status ?? null,
          requestId: json.request_id ?? null,
          retryable: codeIsRetryable(code),
        },
      );
    }
    return json.data;
  }

  get(pathname, options) {
    return this.request('GET', pathname, options);
  }

  post(pathname, options) {
    return this.request('POST', pathname, options);
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

  getSession(sessionId) {
    return this.get(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  createSession({ cwd, model }) {
    return this.post('/api/v1/sessions', {
      body: {
        metadata: { cwd },
        ...(model === undefined ? {} : { agent_config: { model } }),
      },
    });
  }

  updateSessionModel(sessionId, { model }) {
    return this.post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/profile`, {
      body: { agent_config: { model } },
    });
  }

  getSnapshot(sessionId) {
    return this.get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/snapshot`);
  }

  getMessages(sessionId, { since, limit, promptId } = {}) {
    return this.get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      query: { since, limit, prompt_id: promptId },
    });
  }

  getTranscript(sessionId, { since, limit, promptId, agentId = 'main' } = {}) {
    return this.get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/transcript`, {
      query: { since, limit, prompt_id: promptId, agent_id: agentId },
    });
  }

  getPrompts(sessionId) {
    return this.get(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`);
  }

  postPrompt(sessionId, { promptId, text }) {
    return this.post(`/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts`, {
      body: {
        prompt_id: promptId,
        content: [{ type: 'text', text }],
      },
    });
  }

  abortPrompt(sessionId, promptId) {
    return this.post(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompts/${encodeURIComponent(promptId)}:abort`,
      { body: {} },
    );
  }

  abortSession(sessionId) {
    return this.post(`/api/v1/sessions/${encodeURIComponent(sessionId)}:abort`, { body: {} });
  }

  openStream({
    sessionId,
    onFrame,
    onAck,
    onClose,
    onError,
    timeoutMs = DEFAULT_WS_TIMEOUT_MS,
  } = {}) {
    if (!this._WebSocket) {
      throw new BridgeError('RUNTIME_UNSUPPORTED', 'Kimi Code client requires a WebSocket implementation (Node >= 22).');
    }
    return new KimiStream({
      url: wsUrlFor(this.baseUrl),
      token: this.token,
      sessionId,
      WebSocketImpl: this._WebSocket,
      timeoutMs,
      onFrame,
      onAck,
      onClose,
      onError,
    });
  }
}

export class KimiStream {
  constructor({
    url,
    token,
    sessionId,
    WebSocketImpl,
    timeoutMs = DEFAULT_WS_TIMEOUT_MS,
    onFrame,
    onAck,
    onClose,
    onError,
  }) {
    this.url = url;
    this.sessionId = sessionId;
    this.onFrame = onFrame;
    this.onAck = onAck;
    this.onClose = onClose;
    this.onError = onError;
    this.timeoutMs = timeoutMs;
    this._redact = (text) => redact(text, token ?? '');

    this._isOpen = false;
    this._isClosed = false;
    this._closeNotified = false;
    this._unsubscribed = false;
    this._frameSeq = 0;
    this._pendingAcks = new Map();

    let resolveReady;
    let rejectReady;
    this._ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    this._resolveReady = resolveReady;
    this._rejectReady = rejectReady;
    this._ready.catch(() => {});

    let resolveClosed;
    this._closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this._resolveClosed = resolveClosed;

    this._helloReceived = false;
    this._hello = null;

    const readyTimer = setTimeout(() => {
      this._rejectReady(new BridgeError(
        'WS_HELLO_TIMEOUT',
        `Kimi Code WebSocket did not send server_hello within ${timeoutMs}ms.`,
        { retryable: true },
      ));
      this._forceClose(1001, 'hello timeout');
    }, timeoutMs);
    readyTimer.unref?.();

    try {
      this._ws = token
        ? new WebSocketImpl(url, [bearerSubprotocol(token)])
        : new WebSocketImpl(url);
    } catch (error) {
      clearTimeout(readyTimer);
      this._rejectReady(new BridgeError(
        'WS_CONNECT_FAILED',
        `Unable to open Kimi Code WebSocket: ${error?.message ?? error}`,
        { retryable: true },
      ));
      this._isClosed = true;
      this._resolveClosed({ code: null, reason: 'connect failed' });
      return;
    }

    this._readyTimer = readyTimer;
    this._attach();
  }

  get ready() {
    return this._ready;
  }

  get closed() {
    return this._closed;
  }

  _attach() {
    this._ws.addEventListener('open', () => {
      this._isOpen = true;
    });
    this._ws.addEventListener('message', (event) => {
      this._handleMessage(event);
    });
    this._ws.addEventListener('error', (event) => {
      const detail = event?.message || event?.error?.message || 'WebSocket error';
      this.onError?.(new BridgeError('WS_ERROR', this._redact(String(detail)), { retryable: true }));
    });
    this._ws.addEventListener('close', (event) => {
      this._handleClose(event ?? {});
    });
  }

  _handleMessage(event) {
    let raw = event?.data;
    if (typeof raw !== 'string') {
      if (typeof Buffer !== 'undefined' && Buffer.isBuffer(raw)) raw = raw.toString('utf8');
      else if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8');
      else if (ArrayBuffer.isView(raw)) raw = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
      else return;
    }

    const frame = parseBody(raw);
    if (!frame || typeof frame.type !== 'string') return;

    if (frame.type === 'server_hello') {
      this._handleHello(frame);
      return;
    }
    if (frame.type === 'ack') {
      this._handleAck(frame);
      this.onAck?.(frame);
      return;
    }
    if (frame.type === 'ping') {
      const nonce = frame.payload?.nonce;
      this._send({ type: 'pong', payload: nonce === undefined ? {} : { nonce } }).catch(() => {});
      return;
    }
    this.onFrame?.(frame);
  }

  _handleHello(frame) {
    const protocolVersion = frame?.payload?.protocol_version ?? frame?.payload?.protocolVersion ?? null;
    this._hello = {
      protocolVersion,
      maxEventBufferSize: frame?.payload?.max_event_buffer_size ?? null,
      capabilities: frame?.payload?.capabilities ?? null,
    };
    if (protocolVersion !== 2) {
      clearTimeout(this._readyTimer);
      this._rejectReady(new BridgeError(
        'WS_PROTOCOL_MISMATCH',
        `Kimi Code server_hello protocol_version=${protocolVersion ?? '?'}; expected 2.`,
        { retryable: false },
      ));
      this._forceClose(1002, 'protocol mismatch');
      return;
    }
    this._helloReceived = true;
    clearTimeout(this._readyTimer);
    this._resolveReady(this._hello);
  }

  _handleAck(frame) {
    const id = frame?.id;
    if (typeof id !== 'string') return;
    const pending = this._pendingAcks.get(id);
    if (!pending) return;
    this._pendingAcks.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  }

  async _send(frame) {
    if (!this._isOpen || this._isClosed) {
      throw new BridgeError('WS_NOT_OPEN', 'Kimi Code WebSocket is not open.', { retryable: true });
    }
    this._ws.send(JSON.stringify(frame));
  }

  async subscribe({ transcriptSince, grade = 'turn', id } = {}) {
    await this._ready;
    if (this._unsubscribed) {
      throw new BridgeError('WS_CLOSED', 'Kimi Code WebSocket has been unsubscribed.');
    }
    const ackId = id ?? `sub-${++this._frameSeq}`;
    const payload = {
      session_id: this.sessionId,
      transcript: { '*': grade },
    };
    if (transcriptSince && typeof transcriptSince === 'object') {
      payload.transcript_since = transcriptSince;
    } else if (Number.isFinite(transcriptSince) && transcriptSince > 0) {
      // 本机 v2 的 transcript_since 是 agent_id -> seq 映射，不是裸数字。
      payload.transcript_since = { '*': transcriptSince };
    }

    const ack = await this._requestAck(ackId, {
      type: 'subscribe_v2',
      id: ackId,
      payload,
    });
    if (ack?.code !== 0) {
      throw new KimiApiError(
        `subscribe_v2 was rejected with code=${ack?.code ?? '?'}${ack?.msg ? `: ${this._redact(ack.msg)}` : ''}`,
        {
          code: ack?.code ?? null,
          retryable: ack?.code === 40931 || ack?.code === 40932,
        },
      );
    }
    return ack;
  }

  async unsubscribe({ id } = {}) {
    if (this._unsubscribed || this._isClosed || !this._isOpen) return null;
    this._unsubscribed = true;
    const ackId = id ?? `unsub-${++this._frameSeq}`;
    try {
      return await this._requestAck(ackId, {
        type: 'unsubscribe_v2',
        id: ackId,
        payload: { session_id: this.sessionId },
      }, Math.min(this.timeoutMs, 2000));
    } catch {
      return null;
    }
  }

  _requestAck(id, frame, timeoutMs = this.timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingAcks.delete(id);
        reject(new BridgeError('WS_ACK_TIMEOUT', `Timed out waiting for ack ${id}.`, { retryable: true }));
      }, Math.max(1, timeoutMs));
      timer.unref?.();
      this._pendingAcks.set(id, { resolve, reject, timer });

      this._send(frame).catch((error) => {
        this._pendingAcks.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async close(code = 1000, reason = 'bridge close') {
    if (this._isClosed) return this._closed;
    this._isClosed = true;
    this._forceClose(code, reason);
    return this._closed;
  }

  _forceClose(code, reason) {
    try {
      this._ws.close(code, reason);
    } catch {
      // 已经关闭或底层拒绝关闭时不需要再抛。
    }
    const timer = setTimeout(() => {
      this._handleClose({ code, reason, forced: true });
    }, Math.min(this.timeoutMs, 500));
    timer.unref?.();
  }

  _handleClose(event) {
    if (this._closeNotified) return;
    this._closeNotified = true;
    this._isClosed = true;
    this._isOpen = false;
    clearTimeout(this._readyTimer);
    if (!this._helloReceived) {
      this._rejectReady(new BridgeError('WS_CLOSED', 'Kimi Code WebSocket closed before server_hello.', {
        retryable: true,
      }));
    }
    for (const [id, pending] of this._pendingAcks) {
      clearTimeout(pending.timer);
      pending.reject(new BridgeError('WS_CLOSED', `WebSocket closed before ack ${id}.`, { retryable: true }));
    }
    this._pendingAcks.clear();

    const info = {
      code: event?.code ?? null,
      reason: event?.reason ?? null,
    };
    this._resolveClosed(info);
    this.onClose?.(info);
  }
}

export function createKimiCodeClient(config) {
  return new KimiCodeClient(config);
}
