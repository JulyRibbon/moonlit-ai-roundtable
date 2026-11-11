/**
 * 浏览器端增量 SSE 解析器与重连辅助。
 *
 * 该模块不访问 DOM、fetch 或存储，可直接在 Node 中单测。
 * 解析行为遵循 EventSource 的换行规则：CRLF、LF、CR 均视为行结束，
 * 且可能被拆在两个 chunk 之间。注释行（以冒号开头）整行忽略。
 */

const FIELD_SEPARATOR = ':';
const COMMENT_PREFIX = ':';
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const BYTE_ORDER_MARK = '\uFEFF';

/**
 * 创建增量解析器。
 *
 * @param {Object} options
 * @param {(event: {event: string, data: string, id: string|null, retry: number|null}) => void} options.onEvent
 * @param {(retryMs: number) => void} [options.onRetry]
 */
export function createSseParser({ onEvent, onRetry } = {}) {
  if (typeof onEvent !== 'function') {
    throw new TypeError('createSseParser() requires an onEvent callback.');
  }
  if (onRetry !== undefined && typeof onRetry !== 'function') {
    throw new TypeError('onRetry must be a function when provided.');
  }

  let buffer = '';
  let eventName = '';
  let dataLines = [];
  let lastEventId = '';
  let retryMs = null;
  let ended = false;
  let firstChunk = true;
  let skipLeadingLf = false;

  function dispatch() {
    const event = eventName || 'message';
    const data = dataLines.join('\n');
    const hasData = dataLines.length > 0;
    eventName = '';
    dataLines = [];
    if (!hasData) return;
    onEvent({
      event,
      data,
      id: lastEventId.length > 0 ? lastEventId : null,
      retry: retryMs,
    });
  }

  function processLine(line) {
    if (line.length === 0) {
      dispatch();
      return;
    }
    if (line.charCodeAt(0) === COMMENT_PREFIX.charCodeAt(0)) return;

    const separator = line.indexOf(FIELD_SEPARATOR);
    let field;
    let value;
    if (separator === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, separator);
      value = line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
    }

    switch (field) {
      case 'event':
        eventName = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        if (!value.includes('\0')) lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) {
          retryMs = Number(value);
          onRetry?.(retryMs);
        }
        break;
      default:
        // 未知字段按规范忽略。
        break;
    }
  }

  function feed(chunk) {
    if (ended) return;
    if (typeof chunk !== 'string') {
      throw new TypeError('feed() expects a string chunk.');
    }
    if (chunk.length === 0) return;

    if (firstChunk) {
      firstChunk = false;
      if (chunk.startsWith(BYTE_ORDER_MARK)) chunk = chunk.slice(BYTE_ORDER_MARK.length);
    }

    if (skipLeadingLf) {
      skipLeadingLf = false;
      if (chunk.charCodeAt(0) === LINE_FEED) chunk = chunk.slice(1);
    }

    buffer += chunk;
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const code = buffer.charCodeAt(index);
      if (code === LINE_FEED) {
        processLine(buffer.slice(start, index));
        start = index + 1;
      } else if (code === CARRIAGE_RETURN) {
        processLine(buffer.slice(start, index));
        if (buffer.charCodeAt(index + 1) === LINE_FEED) {
          index += 1;
          start = index + 1;
        } else {
          start = index + 1;
          // CR 已作为行结束；若它正好位于 chunk 末尾，下一 chunk 开头的 LF
          // 属于同一个 CRLF，需要吞掉。
          if (index === buffer.length - 1) skipLeadingLf = true;
        }
      }
    }
    buffer = buffer.slice(start);
  }

  /** 流结束时丢弃未以空行收尾的半截事件，符合 SSE 语义。 */
  function end() {
    ended = true;
    buffer = '';
    eventName = '';
    dataLines = [];
  }

  return {
    feed,
    end,
    get ended() {
      return ended;
    },
    get retryMs() {
      return retryMs;
    },
  };
}

/**
 * 有界的 eventId 去重器。id 为空（如 snapshot 帧）时始终放行且不记录。
 * 超出容量时按插入顺序淘汰最旧的 id。
 */
export function createEventDeduper({ limit = 2000 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('limit must be a positive integer.');
  }
  const seen = new Set();
  const order = [];

  return {
    accept(id) {
      if (id === null || id === undefined || id === '') return true;
      const key = String(id);
      if (seen.has(key)) return false;
      seen.add(key);
      order.push(key);
      if (order.length > limit) {
        const evicted = order.shift();
        seen.delete(evicted);
      }
      return true;
    },
    has(id) {
      return seen.has(String(id));
    },
    reset() {
      seen.clear();
      order.length = 0;
    },
    get size() {
      return seen.size;
    },
  };
}

/**
 * 指数退避毫秒数。attempt 从 0 开始；jitter 为 0 时结果完全确定。
 */
export function retryDelay(attempt, {
  baseMs = 800,
  maxMs = 15000,
  jitter = 0.25,
  random = Math.random,
} = {}) {
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    throw new TypeError('baseMs must be a positive number.');
  }
  if (!Number.isFinite(maxMs) || maxMs <= 0) {
    throw new TypeError('maxMs must be a positive number.');
  }
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) {
    throw new TypeError('jitter must be between 0 and 1.');
  }
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 0;
  const raw = Math.min(maxMs, baseMs * 2 ** safeAttempt);
  if (jitter === 0) return Math.round(raw);
  const spread = raw * jitter;
  const value = raw - spread + random() * spread * 2;
  return Math.max(1, Math.round(Math.min(maxMs, value)));
}

/**
 * 是否值得自动重连。0 表示 fetch 抛错（网络/连接被拒），
 * 401/403 等鉴权或路由错误不重连。
 */
export function shouldReconnect(status) {
  if (status === 0 || status === null || status === undefined) return true;
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
