import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OWNER_ACTOR } from '../core/room-state.mjs';
import { createSseHub } from './sse.mjs';
import { AI_ROOM_VERSION } from './version.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;.*)?$/i;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

const PROJECT_WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const CHANGELOG_PATH = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

/**
 * 静态 UI 只暴露白名单中的固定文件；请求路径只用于精确查表，
 * 不参与文件系统拼接，因此不存在目录穿越，也不会公开 rooms/、state/ 或 probes/。
 */
const STATIC_ROUTES = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.mjs', { file: 'app.mjs', contentType: 'text/javascript; charset=utf-8' }],
  ['/management.mjs', { file: 'management.mjs', contentType: 'text/javascript; charset=utf-8' }],
  ['/game.mjs', { file: 'game.mjs', contentType: 'text/javascript; charset=utf-8' }],
  ['/tabletop.mjs', { file: 'tabletop.mjs', contentType: 'text/javascript; charset=utf-8' }],
  ['/sse.mjs', { file: 'sse.mjs', contentType: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

function formatHostPort(hostname, port) {
  const bare = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const formatted = bare.includes(':') ? `[${bare}]` : bare;
  return `${formatted}:${port}`.toLowerCase();
}

function buildAllowedHosts(info, configuredHost) {
  const hosts = new Set();
  for (const hostname of [info.address, configuredHost]) {
    if (typeof hostname === 'string' && hostname.length > 0) {
      hosts.add(formatHostPort(hostname, info.port));
    }
  }
  return hosts;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function sendText(res, status, text, contentType) {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

async function serveStaticFile(res, webDir, route) {
  let body;
  try {
    body = await readFile(path.join(webDir, route.file));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') {
      throw new HttpError(404, 'STATIC_NOT_FOUND', 'Static asset not found.');
    }
    throw error;
  }
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(200, {
    'Content-Type': route.contentType,
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function methodNotAllowed(res, allowed) {
  sendJson(res, 405, {
    error: { code: 'METHOD_NOT_ALLOWED', message: `Allowed methods: ${allowed.join(', ')}.` },
  }, { Allow: allowed.join(', ') });
}

function hasRequestBody(req) {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = Number(req.headers['content-length']);
  return Number.isFinite(length) && length > 0;
}

/**
 * 读取并解析 JSON 请求体，始终最多缓冲 1MiB；超限后继续排空但不保留任何字节。
 * 空请求体视为 {}，此时不要求 Content-Type。
 */
function readJsonBody(req) {
  if (!hasRequestBody(req)) return Promise.resolve({});

  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !JSON_CONTENT_TYPE.test(contentType)) {
    req.resume();
    return Promise.reject(new HttpError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Content-Type must be application/json.',
    ));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    function onData(chunk) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    }

    function onEnd() {
      if (settled) return;
      settled = true;
      cleanup();
      if (exceeded) {
        reject(new HttpError(
          413,
          'PAYLOAD_TOO_LARGE',
          `JSON body must not exceed ${MAX_BODY_BYTES} bytes.`,
        ));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.'));
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new HttpError(400, 'INVALID_BODY', 'Request body must be a JSON object.'));
        return;
      }
      resolve(parsed);
    }

    function onError() {
      fail(new HttpError(400, 'REQUEST_BODY_ERROR', 'Could not read request body.'));
    }

    function onAborted() {
      fail(new HttpError(400, 'REQUEST_ABORTED', 'Request was aborted.'));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

function errorStatus(error) {
  if (error instanceof HttpError) return error.status;
  const code = error?.code;
  if (code === 'ACTOR_NOT_OWNER' || code === 'UNKNOWN_ACTOR') return 403;
  if (code === 'INVALID_TRANSITION'
    || code === 'ENGINE_NOT_INITIALIZED'
    || code === 'ENGINE_CLOSED'
    || code === 'HALT_GUARD_MISSING'
    || code === 'ROOM_BUSY'
    || code === 'DUPLICATE_ATTEMPT'
    || code === 'GAME_NOT_PLAYING'
    || code === 'GAME_NOT_READY'
    || code === 'NOT_HUMAN_TURN'
    || code === 'COORDINATOR_CLOSED') {
    return 409;
  }
  if (code === 'SEAT_NOT_FOUND') return 404;
  if (typeof code === 'string' && (
    code.startsWith('MESSAGE_')
    || code.startsWith('INVALID_')
    || code.endsWith('_INVALID')
    || code === 'DISPLAY_NAME_DUPLICATE'
    || code === 'SESSION_CREATE_UNSUPPORTED'
    || code === 'MAX_ATTEMPTS_INVALID'
  )) {
    return 400;
  }
  if (error instanceof TypeError || error instanceof RangeError) return 400;
  return 500;
}

function handleError(req, res, error) {
  if (req.readable && !req.readableEnded) req.resume();
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const status = errorStatus(error);
  const internal = status >= 500;
  const code = internal
    ? 'INTERNAL_ERROR'
    : (typeof error?.code === 'string' ? error.code : 'BAD_REQUEST');
  const message = internal ? 'Internal server error.' : String(error?.message ?? 'Request failed.');
  const extraHeaders = status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {};
  sendJson(res, status, { error: { code, message } }, extraHeaders);
}

export function createRoomServer({
  engine,
  gameCoordinator = null,
  tabletopManager = null,
  host = '127.0.0.1',
  port = 0,
  token,
  heartbeatMs,
  webDir = PROJECT_WEB_DIR,
  onUpdateSettings,
  onResetSeat,
  onClearTranscript,
  onResetCounters,
} = {}) {
  if (!engine || typeof engine !== 'object') {
    throw new TypeError('createRoomServer() requires an engine.');
  }
  for (const method of [
    'activate',
    'postOwnerMessage',
    'run',
    'pause',
    'resume',
    'requestReview',
    'confirm',
    'getSnapshot',
    'exportMarkdown',
    'subscribe',
  ]) {
    if (typeof engine[method] !== 'function') {
      throw new TypeError(`engine.${method}() is required.`);
    }
  }
  if (gameCoordinator !== null && (
    typeof gameCoordinator.getSnapshot !== 'function'
    || typeof gameCoordinator.subscribe !== 'function'
  )) {
    throw new TypeError('gameCoordinator must provide getSnapshot() and subscribe().');
  }
  if (tabletopManager !== null && (
    typeof tabletopManager.getSnapshot !== 'function'
    || typeof tabletopManager.subscribe !== 'function'
  )) {
    throw new TypeError('tabletopManager must provide getSnapshot() and subscribe().');
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new TypeError('token must be a non-empty string.');
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new TypeError('host must be a loopback address (127.0.0.1, ::1, or localhost).');
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new TypeError('port must be an integer between 0 and 65535.');
  }
  if (typeof webDir !== 'string' || webDir.length === 0) {
    throw new TypeError('webDir must be a non-empty string.');
  }

  const staticRoot = path.resolve(webDir);
  const tokenDigest = createHash('sha256').update(token, 'utf8').digest();
  const hub = createSseHub({ engine, heartbeatMs });
  const gameHub = gameCoordinator === null ? null : createSseHub({ engine: gameCoordinator, heartbeatMs });
  const tabletopHub = tabletopManager === null ? null : createSseHub({ engine: tabletopManager, heartbeatMs });
  let allowedHosts = new Set();
  let listenPromise = null;
  let closePromise = null;
  let closed = false;

  function assertHost(req) {
    const header = req.headers.host;
    if (typeof header !== 'string' || header.length === 0) {
      throw new HttpError(400, 'HOST_REQUIRED', 'Host header is required.');
    }
    if (!allowedHosts.has(header.toLowerCase())) {
      throw new HttpError(400, 'HOST_NOT_ALLOWED', 'Host is not the bound loopback address.');
    }
  }

  function assertOrigin(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return;
    if (typeof origin !== 'string' || origin.length === 0 || origin === 'null') {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
    }
    if (parsed.protocol !== 'http:' || !allowedHosts.has(parsed.host.toLowerCase())) {
      throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'Origin is not allowed.');
    }
  }

  function assertAuthorized(req) {
    const header = req.headers.authorization;
    let candidate = null;
    if (typeof header === 'string') {
      const match = /^bearer[ \t]+(.+)$/i.exec(header);
      if (match) candidate = match[1];
    }
    if (candidate === null) {
      throw new HttpError(401, 'UNAUTHORIZED', 'A bearer token is required.');
    }
    const digest = createHash('sha256').update(candidate, 'utf8').digest();
    if (!timingSafeEqual(digest, tokenDigest)) {
      throw new HttpError(401, 'UNAUTHORIZED', 'A bearer token is required.');
    }
  }

  const postRoutes = new Map([
    ['/api/room/activate', () => engine.activate({ actor: OWNER_ACTOR })],
    ['/api/messages', (body) => engine.postOwnerMessage({
      actor: OWNER_ACTOR,
      text: body.text,
      mentions: body.mentions,
      nominations: body.nominations,
      replyTo: body.replyTo,
    })],
    ['/api/run', () => engine.run()],
    ['/api/pause', () => engine.pause({ actor: OWNER_ACTOR })],
    ['/api/resume', () => engine.resume({ actor: OWNER_ACTOR })],
    ['/api/review', () => engine.requestReview({ actor: OWNER_ACTOR })],
    ['/api/confirm', () => engine.confirm({ actor: OWNER_ACTOR })],
    ['/api/settings', (body) => {
      if (typeof onUpdateSettings !== 'function') {
        throw new HttpError(501, 'SETTINGS_UNAVAILABLE', 'This server has no settings store.');
      }
      return onUpdateSettings(body);
    }],
    ['/api/transcript/clear', () => {
      if (typeof onClearTranscript !== 'function') {
        throw new HttpError(501, 'TRANSCRIPT_CLEAR_UNAVAILABLE', 'This server cannot clear transcripts.');
      }
      return onClearTranscript();
    }],
    ['/api/counters/reset', () => {
      if (typeof onResetCounters !== 'function') {
        throw new HttpError(501, 'COUNTERS_RESET_UNAVAILABLE', 'This server cannot reset counters.');
      }
      return onResetCounters();
    }],
    ['/api/continue', () => {
      if (typeof engine.continueRound !== 'function') {
        throw new HttpError(501, 'CONTINUE_UNAVAILABLE', 'This engine has no continueRound support.');
      }
      return engine.continueRound({ actor: OWNER_ACTOR });
    }],
    ['/api/halt', (body) => {
      if (typeof engine.halt !== 'function') {
        throw new HttpError(501, 'HALT_UNAVAILABLE', 'This engine has no halt support.');
      }
      return engine.halt({
        scope: body.scope ?? 'room',
        mode: body.mode ?? 'halt',
        actor: OWNER_ACTOR,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      });
    }],
    ['/api/halt/resume', (body) => {
      if (typeof engine.resumeHalt !== 'function') {
        throw new HttpError(501, 'HALT_UNAVAILABLE', 'This engine has no halt support.');
      }
      return engine.resumeHalt({
        scope: body.scope ?? 'room',
        actor: OWNER_ACTOR,
      });
    }],
    ['/api/game/new', (body) => {
      if (!gameCoordinator) throw new HttpError(501, 'GAME_UNAVAILABLE', 'This server has no game coordinator.');
      return gameCoordinator.newGame(body.players);
    }],
    ['/api/game/move', (body) => {
      if (!gameCoordinator) throw new HttpError(501, 'GAME_UNAVAILABLE', 'This server has no game coordinator.');
      return gameCoordinator.move(body.edge);
    }],
    ['/api/game/resume', () => {
      if (!gameCoordinator) throw new HttpError(501, 'GAME_UNAVAILABLE', 'This server has no game coordinator.');
      return gameCoordinator.resume();
    }],
    ['/api/tabletop/new', (body) => {
      if (!tabletopManager) throw new HttpError(501, 'TABLETOP_UNAVAILABLE', 'This server has no tabletop manager.');
      return tabletopManager.newGame(body.gameType, body.players);
    }],
    ['/api/tabletop/move', (body) => {
      if (!tabletopManager) throw new HttpError(501, 'TABLETOP_UNAVAILABLE', 'This server has no tabletop manager.');
      return tabletopManager.move(body.gameType, body.action);
    }],
    ['/api/tabletop/resume', (body) => {
      if (!tabletopManager) throw new HttpError(501, 'TABLETOP_UNAVAILABLE', 'This server has no tabletop manager.');
      return tabletopManager.resume(body.gameType);
    }],
  ]);

  async function handle(req, res) {
    try {
      assertHost(req);
      assertOrigin(req);

      const method = (req.method ?? 'GET').toUpperCase();
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;

      // 静态 UI 在 Host/Origin 校验之后、Bearer 校验之前，仅限精确白名单。
      const staticRoute = STATIC_ROUTES.get(pathname);
      if (staticRoute) {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        await serveStaticFile(res, staticRoot, staticRoute);
        return;
      }

      if (pathname === '/favicon.ico') {
        if (method !== 'GET' && method !== 'HEAD') {
          methodNotAllowed(res, ['GET', 'HEAD']);
          return;
        }
        res.writeHead(204, {
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end();
        return;
      }

      if (pathname === '/api/health') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        sendJson(res, 200, { ok: true, version: AI_ROOM_VERSION });
        return;
      }

      if (pathname === '/changelog.md') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        const contents = await readFile(CHANGELOG_PATH, 'utf8');
        sendText(res, 200, contents, 'text/markdown; charset=utf-8');
        return;
      }

      assertAuthorized(req);

      if (pathname === '/api/events') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        const rawLastEventId = req.headers['last-event-id'];
        const lastEventId = typeof rawLastEventId === 'string' && rawLastEventId.length > 0
          ? rawLastEventId
          : null;
        hub.attach(req, res, { lastEventId });
        return;
      }

      if (pathname === '/api/game/events') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        if (!gameHub) throw new HttpError(501, 'GAME_UNAVAILABLE', 'This server has no game coordinator.');
        const rawLastEventId = req.headers['last-event-id'];
        const lastEventId = typeof rawLastEventId === 'string' && rawLastEventId.length > 0
          ? rawLastEventId
          : null;
        gameHub.attach(req, res, { lastEventId });
        return;
      }

      if (pathname === '/api/game') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        if (!gameCoordinator) throw new HttpError(501, 'GAME_UNAVAILABLE', 'This server has no game coordinator.');
        sendJson(res, 200, gameCoordinator.getSnapshot());
        return;
      }

      if (pathname === '/api/tabletop/events') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        if (!tabletopHub) throw new HttpError(501, 'TABLETOP_UNAVAILABLE', 'This server has no tabletop manager.');
        const rawLastEventId = req.headers['last-event-id'];
        const lastEventId = typeof rawLastEventId === 'string' && rawLastEventId.length > 0
          ? rawLastEventId
          : null;
        tabletopHub.attach(req, res, { lastEventId });
        return;
      }

      if (pathname === '/api/tabletop') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        if (!tabletopManager) throw new HttpError(501, 'TABLETOP_UNAVAILABLE', 'This server has no tabletop manager.');
        sendJson(res, 200, tabletopManager.getSnapshot(requestUrl.searchParams.get('gameType') ?? 'gomoku'));
        return;
      }

      if (pathname === '/api/room') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        sendJson(res, 200, engine.getSnapshot());
        return;
      }

      if (pathname === '/api/export.md') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        const markdown = await engine.exportMarkdown();
        sendText(res, 200, String(markdown ?? ''), 'text/markdown; charset=utf-8');
        return;
      }

      if (pathname === '/api/export.json') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        const snapshot = engine.getSnapshot();
        sendJson(res, 200, {
          schemaVersion: 1,
          roomId: snapshot.roomId,
          exportedAt: new Date().toISOString(),
          settings: snapshot.settings ?? null,
          messages: snapshot.transcript ?? [],
        });
        return;
      }

      if (pathname === '/api/counters') {
        if (method !== 'GET') {
          methodNotAllowed(res, ['GET']);
          return;
        }
        if (typeof engine.getCounters !== 'function') {
          throw new HttpError(501, 'COUNTERS_UNAVAILABLE', 'This engine has no counters support.');
        }
        sendJson(res, 200, engine.getCounters());
        return;
      }

      const resetMatch = /^\/api\/seats\/([^/]+)\/session$/.exec(pathname);
      if (resetMatch) {
        if (method !== 'POST') {
          methodNotAllowed(res, ['POST']);
          return;
        }
        if (typeof onResetSeat !== 'function') {
          throw new HttpError(501, 'SESSION_CREATE_UNAVAILABLE', 'This server cannot create native sessions.');
        }
        await readJsonBody(req);
        const result = await onResetSeat(decodeURIComponent(resetMatch[1]));
        sendJson(res, 200, result);
        return;
      }

      const action = postRoutes.get(pathname);
      if (action) {
        if (method !== 'POST') {
          methodNotAllowed(res, ['POST']);
          return;
        }
        const body = await readJsonBody(req);
        const result = await action(body);
        sendJson(res, 200, result ?? { ok: true });
        return;
      }

      throw new HttpError(404, 'NOT_FOUND', 'Unknown API route.');
    } catch (error) {
      handleError(req, res, error);
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });
  server.on('error', () => {
    // listen() 失败通过 listenPromise 暴露；运行期错误不能让进程崩溃。
  });

  function listen() {
    if (closed || closePromise) {
      return Promise.reject(new Error('Server is closed.'));
    }
    if (listenPromise) return listenPromise;
    listenPromise = new Promise((resolve, reject) => {
      const onListening = () => {
        server.off('error', onError);
        const info = server.address();
        allowedHosts = buildAllowedHosts(info, host);
        resolve(info.port);
      };
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      server.once('listening', onListening);
      server.once('error', onError);
      server.listen(port, host);
    }).catch((error) => {
      listenPromise = null;
      throw error;
    });
    return listenPromise;
  }

  function address() {
    return server.address() ?? null;
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      hub.close();
      gameHub?.close();
      tabletopHub?.close();
      if (!server.listening) return;
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        server.closeAllConnections?.();
      });
    })();
    return closePromise;
  }

  return { listen, close, address };
}
