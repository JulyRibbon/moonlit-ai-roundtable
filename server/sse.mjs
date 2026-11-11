const DEFAULT_HEARTBEAT_MS = 15000;
const DEFAULT_BUFFER_SIZE = 500;

function frame({ id = null, event = null, data }) {
  let out = '';
  if (id !== null && id !== undefined) out += `id: ${id}\n`;
  if (event !== null && event !== undefined) out += `event: ${event}\n`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of payload.split('\n')) out += `data: ${line}\n`;
  return `${out}\n`;
}

function frameForEvent(event) {
  return frame({ id: event.eventId, event: event.type, data: event });
}

/**
 * 有界房间事件缓冲 + SSE 客户端池。
 *
 * eventId 即 SSE id。Last-Event-ID 命中缓冲时只补发其后的房间事件；
 * 未命中（过旧或未知）时不补发，避免把客户端已经确认的事件重复送出。
 */
export function createSseHub({
  engine,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  bufferSize = DEFAULT_BUFFER_SIZE,
} = {}) {
  if (!engine || typeof engine.subscribe !== 'function' || typeof engine.getSnapshot !== 'function') {
    throw new TypeError('createSseHub() requires an engine with subscribe() and getSnapshot().');
  }
  if (typeof heartbeatMs !== 'number' || !Number.isFinite(heartbeatMs) || heartbeatMs < 0) {
    throw new TypeError('heartbeatMs must be a finite number >= 0.');
  }
  if (!Number.isSafeInteger(bufferSize) || bufferSize < 1) {
    throw new TypeError('bufferSize must be a positive integer.');
  }

  const clients = new Set();
  const buffered = [];
  const bufferedById = new Map();
  let closed = false;

  const unsubscribe = engine.subscribe((event) => {
    if (closed || !event || typeof event.eventId !== 'string') return;
    if (bufferedById.has(event.eventId)) return;
    buffered.push(event);
    bufferedById.set(event.eventId, event);
    while (buffered.length > bufferSize) {
      const evicted = buffered.shift();
      bufferedById.delete(evicted.eventId);
    }
    for (const client of clients) writeToClient(client, frameForEvent(event));
  });

  function eventsAfter(lastEventId) {
    const index = buffered.findIndex((event) => event.eventId === lastEventId);
    if (index === -1) return [];
    return buffered.slice(index + 1);
  }

  function writeRaw(res, text) {
    if (res.destroyed || res.writableEnded) return false;
    try {
      res.write(text);
      return true;
    } catch {
      return false;
    }
  }

  function writeToClient(client, text) {
    if (!writeRaw(client.res, text)) detach(client);
  }

  function detach(client) {
    if (!clients.delete(client)) return;
    if (client.timer !== null) {
      clearInterval(client.timer);
      client.timer = null;
    }
    client.req.off('close', client.cleanup);
    client.res.off('close', client.cleanup);
    client.res.off('error', client.cleanup);
  }

  function attach(req, res, { lastEventId = null } = {}) {
    if (closed) {
      res.writeHead(503, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({ error: { code: 'STREAM_CLOSED', message: 'Server is closing.' } }));
      return false;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.flushHeaders?.();

    // 先快照当前房间，再补发/订阅；快照本身不带 id，避免污染 Last-Event-ID。
    writeRaw(res, frame({ event: 'snapshot', data: engine.getSnapshot() }));
    if (typeof lastEventId === 'string' && lastEventId.length > 0) {
      for (const event of eventsAfter(lastEventId)) writeRaw(res, frameForEvent(event));
    }

    const client = { req, res, timer: null, cleanup: null };
    client.cleanup = () => detach(client);
    clients.add(client);
    if (heartbeatMs > 0) {
      client.timer = setInterval(() => {
        if (res.destroyed || res.writableEnded) {
          detach(client);
          return;
        }
        try {
          res.write(': heartbeat\n\n');
        } catch {
          detach(client);
        }
      }, heartbeatMs);
      client.timer.unref?.();
    }
    req.once('close', client.cleanup);
    res.once('close', client.cleanup);
    res.once('error', client.cleanup);
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const client of [...clients]) {
      if (client.timer !== null) {
        clearInterval(client.timer);
        client.timer = null;
      }
      detach(client);
      try {
        client.res.end();
      } catch {
        // 客户端可能已经断开。
      }
    }
    clients.clear();
    buffered.length = 0;
    bufferedById.clear();
  }

  return {
    attach,
    close,
    get clientCount() {
      return clients.size;
    },
    get bufferedCount() {
      return buffered.length;
    },
  };
}
