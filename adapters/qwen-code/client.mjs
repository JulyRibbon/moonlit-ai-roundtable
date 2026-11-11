// Qwen Code 本地守护进程 HTTP 客户端（Bridge v1 用）。
//
// 协议来自 Qwen Code 0.27.1 的 `serve`（http-bridge，官方标注 Stage 1 experimental）：
//   - 回环 + 未开 --require-auth 时免 token；开了鉴权才需要 Bearer（本 Bridge 默认要求回环免鉴权）
//   - 建/挂会话：POST /session  { cwd, sessionId?, clientId? }
//   - 投递：    POST /session/:id/prompt  { prompt: [{type:'text',text}], idempotencyKey? }
//                → 202 { promptId, lastEventId, eventEpoch }
//   - 事件：    GET  /session/:id/events  (SSE；Last-Event-ID + X-Qwen-Event-Epoch 可续传)
//                帧形如 data: {"v":1,"id":<n>,"type":"session_update"|"turn_complete"|...,"data":{...}}
//   - 取消：    POST /session/:id/cancel
//   - 只读：    GET /health /capabilities /session/:id/status /context /transcript /pending-prompts
//
// 本文件不做任何决定，只负责「把 HTTP/SSE 变成普通对象」。

export const QWEN_DEFAULT_BASE_URL = 'http://127.0.0.1:58691';
export const QWEN_PROTOCOL_VERSION = 'v1';

/** 稳定、可读的错误类型；消息里绝不带 Authorization / token。 */
export class QwenDaemonError extends Error {
  constructor(message, { status = null, code = null, body = null } = {}) {
    super(message);
    this.name = 'QwenDaemonError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function safeMessage(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 500);
}

/** SSE 行解析：空白行分隔帧，只认 `data:` 行，载荷必须是 {v:1,type:string} 的 JSON 对象。 */
function parseFrames(buffer) {
  const frames = [];
  let cursor = 0;
  for (;;) {
    const lf = buffer.indexOf('\n\n', cursor);
    if (lf === -1) break;
    frames.push(buffer.slice(cursor, lf));
    cursor = lf + 2;
  }
  return { frames, tail: buffer.slice(cursor) };
}

function parseSseFrame(raw) {
  const dataLines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const rest = line.slice(5);
    dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest);
  }
  if (dataLines.length === 0) return null;
  try {
    const parsed = JSON.parse(dataLines.join('\n'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.v !== 1 || typeof parsed.type !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export class QwenDaemonClient {
  constructor({
    baseUrl = QWEN_DEFAULT_BASE_URL,
    timeoutMs = 20000,
    fetchImpl = globalThis.fetch,
    clientId = null,
  } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.clientId = clientId;
    this.token = null;
  }

  _headers({ clientId = this.clientId, accept = 'application/json' } = {}) {
    const headers = { Accept: accept };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (clientId) headers['X-Qwen-Client-Id'] = clientId;
    return headers;
  }

  async _request(method, route, { body, timeoutMs = this.timeoutMs, clientId, signal, accept } = {}) {
    const init = { method, headers: this._headers({ clientId, accept }), signal };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (!signal) init.signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, init);
    } catch (error) {
      throw new QwenDaemonError(`Qwen daemon 不可达：${safeMessage(error?.message ?? error)}`, {
        code: 'QWEN_DAEMON_UNREACHABLE',
      });
    }
    const text = await response.text();
    let parsed = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 400) };
      }
    }
    if (!response.ok) {
      const code = parsed && typeof parsed.code === 'string' ? parsed.code : `HTTP_${response.status}`;
      const detail = parsed && typeof parsed.error === 'string' ? parsed.error : `HTTP ${response.status}`;
      throw new QwenDaemonError(safeMessage(detail), {
        status: response.status,
        code,
        body: parsed,
      });
    }
    return { status: response.status, body: parsed };
  }

  async health({ timeoutMs = 1500 } = {}) {
    return this._request('GET', '/health', { timeoutMs });
  }

  async capabilities() {
    return this._request('GET', '/capabilities');
  }

  async workspaceModels() {
    return this._request('GET', '/workspace/models');
  }

  async workspaceSessions(workspace) {
    return this._request('GET', `/workspace/${encodeURIComponent(workspace)}/sessions`);
  }

  /**
   * 预热 workspace 的 ACP 子进程。服务端预算是 `timeoutMs`（默认 5s），
   * 会等满预算才返回；HTTP 超时因此要比服务端预算宽一点。
   * query 只校验/透传预算，不能扩大 `--initialize-timeout-ms` 之外的守护进程预算。
   * 返回 { ready, channelLive, durationMs, reason?, error? }；未就绪时抛 QwenDaemonError。
   */
  async workspaceAcpPreheat({ timeoutMs = 60000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new QwenDaemonError('preheat timeoutMs 必须是正整数', { code: 'PREHEAT_TIMEOUT_INVALID' });
    }
    const suffix = `?timeoutMs=${encodeURIComponent(timeoutMs)}`;
    const result = await this._request('POST', `/workspace/acp/preheat${suffix}`, {
      timeoutMs: timeoutMs + 2000,
    });
    const body = result.body ?? {};
    const failed = body.ready !== true
      || body.channelLive !== true
      || (typeof body.error === 'string' && body.error.length > 0);
    if (failed) {
      const detail = body.error ?? body.reason ?? 'ACP preheat 未就绪';
      throw new QwenDaemonError(`ACP 预热失败：${safeMessage(detail)}`, {
        status: result.status,
        code: 'QWEN_ACP_PREHEAT_FAILED',
        body,
      });
    }
    return body;
  }

  async sessionStatus(sessionId) {
    return this._request('GET', `/session/${encodeURIComponent(sessionId)}/status`);
  }

  async sessionContext(sessionId) {
    return this._request('GET', `/session/${encodeURIComponent(sessionId)}/context`);
  }

  async pendingPrompts(sessionId) {
    return this._request('GET', `/session/${encodeURIComponent(sessionId)}/pending-prompts`, {
      clientId: this.clientId,
    });
  }

  async sessionTranscript(sessionId, { limit } = {}) {
    const query = limit === undefined ? '' : `?limit=${encodeURIComponent(limit)}`;
    return this._request('GET', `/session/${encodeURIComponent(sessionId)}/transcript${query}`);
  }

  /**
   * 建会话或挂接已有会话。带 sessionId 时服务端会尝试恢复/重建该 id；
   * 若该会话已经 live，则返回 409 session_id_conflict（调用方应先查 status）。
   */
  async createOrAttachSession({ cwd, sessionId, clientId = this.clientId } = {}) {
    const body = { cwd };
    if (sessionId !== undefined && sessionId !== null) body.sessionId = sessionId;
    const result = await this._request('POST', '/session', { body, clientId });
    const assigned = result.body?.clientId;
    if (typeof assigned === 'string' && assigned.length > 0) this.clientId = assigned;
    return result;
  }

  /**
   * 按 id 恢复一个持久化会话（守护进程重启后 status 会是 404，但 transcript 还在）。
   * 服务端实测要十几秒，默认给 90s；返回体里带新的 clientId。
   */
  async resumeSession(sessionId, { cwd, clientId = this.clientId, timeoutMs = 90000 } = {}) {
    const body = {};
    if (cwd !== undefined && cwd !== null) body.cwd = cwd;
    const result = await this._request('POST', `/session/${encodeURIComponent(sessionId)}/resume`, {
      body,
      clientId,
      timeoutMs,
    });
    const assigned = result.body?.clientId;
    if (typeof assigned === 'string' && assigned.length > 0) this.clientId = assigned;
    return result;
  }

  /** 投递 prompt；返回 202 的 {promptId,lastEventId,eventEpoch}。 */
  async prompt(sessionId, { text, idempotencyKey, clientId = this.clientId, signal } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new QwenDaemonError('prompt 文本不能为空', { code: 'PROMPT_INVALID' });
    }
    const body = { prompt: [{ type: 'text', text }] };
    if (idempotencyKey !== undefined) body.idempotencyKey = idempotencyKey;
    return this._request('POST', `/session/${encodeURIComponent(sessionId)}/prompt`, {
      body,
      clientId,
      signal,
    });
  }

  async cancel(sessionId, { clientId = this.clientId, cancelReason } = {}) {
    const body = cancelReason ? { _meta: { 'qwen.cancelReason': cancelReason } } : {};
    return this._request('POST', `/session/${encodeURIComponent(sessionId)}/cancel`, { body, clientId });
  }

  /**
   * 订阅会话事件流。返回 async generator：yield {id, v, type, data}。
   * onStreamInfo 会收到 {streamId, epoch}（来自响应头，用于断线续传）。
   */
  async *subscribeEvents(sessionId, {
    lastEventId,
    epoch,
    signal,
    clientId = this.clientId,
    onStreamInfo,
  } = {}) {
    const headers = this._headers({ clientId, accept: 'text/event-stream' });
    if (lastEventId !== undefined && lastEventId !== null) {
      headers['Last-Event-ID'] = String(lastEventId);
      if (epoch !== undefined && epoch !== null) headers['X-Qwen-Event-Epoch'] = String(epoch);
    }
    const init = { headers, signal: signal ?? AbortSignal.timeout(this.timeoutMs * 6) };
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`, init);
    } catch (error) {
      throw new QwenDaemonError(`订阅事件流失败：${safeMessage(error?.message ?? error)}`, {
        code: 'QWEN_EVENTS_CONNECT_FAILED',
      });
    }
    if (!response.ok) {
      let body = null;
      try {
        const text = await response.text();
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      throw new QwenDaemonError(
        `订阅事件流被拒绝（HTTP ${response.status}${body?.code ? `, ${body.code}` : ''}）`,
        { status: response.status, code: body?.code ?? `HTTP_${response.status}`, body },
      );
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      throw new QwenDaemonError('事件流不是 text/event-stream', { code: 'QWEN_EVENTS_BAD_CONTENT_TYPE' });
    }
    onStreamInfo?.({
      streamId: response.headers.get('x-qwen-sse-stream-id') ?? null,
      epoch: response.headers.get('x-qwen-event-epoch') ?? null,
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          for (const raw of parseFrames(buffer).frames) {
            const frame = parseSseFrame(raw);
            if (frame) yield frame;
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const { frames, tail } = parseFrames(buffer);
        buffer = tail;
        for (const raw of frames) {
          const frame = parseSseFrame(raw);
          if (frame) yield frame;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }
}
