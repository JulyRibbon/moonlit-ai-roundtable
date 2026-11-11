import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRoomServer } from '../../server/http.mjs';

const TOKEN = 'static-ui-token-6c1f0e2a';

const WEB_FILES = Object.freeze({
  'index.html': '<!doctype html><title>ai-room fixture</title>\n',
  'app.mjs': "export const app = 'ai-room fixture';\n",
  'management.mjs': "export const management = 'ai-room fixture';\n",
  'game.mjs': "export const game = 'ai-room fixture';\n",
  'tabletop.mjs': "export const tabletop = 'ai-room fixture';\n",
  'sse.mjs': "export const sse = 'ai-room fixture';\n",
  'styles.css': 'body { color: #eee; }\n',
});

const STATIC_CASES = Object.freeze([
  { pathname: '/', file: 'index.html', contentType: 'text/html; charset=utf-8' },
  { pathname: '/app.mjs', file: 'app.mjs', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/management.mjs', file: 'management.mjs', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/game.mjs', file: 'game.mjs', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/tabletop.mjs', file: 'tabletop.mjs', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/sse.mjs', file: 'sse.mjs', contentType: 'text/javascript; charset=utf-8' },
  { pathname: '/styles.css', file: 'styles.css', contentType: 'text/css; charset=utf-8' },
]);

const PROJECT_WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url));

function createStubEngine() {
  return {
    activate: async () => ({ ok: true }),
    postOwnerMessage: async () => ({ ok: true }),
    run: async () => ({ ran: true }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    requestReview: async () => ({ ok: true }),
    confirm: async () => ({ ok: true }),
    getSnapshot: () => ({ roomId: 'r_static', room: { state: 'draft' } }),
    exportMarkdown: async () => '# Room r_static\n',
    subscribe: () => () => {},
  };
}

async function createWebFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'airoom-ui-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const webDir = path.join(root, 'web');
  await mkdir(webDir, { recursive: true });
  await writeFile(path.join(root, 'secret.txt'), 'TOP_SECRET_FIXTURE\n');
  await Promise.all(Object.entries(WEB_FILES).map(([name, body]) => (
    writeFile(path.join(webDir, name), body)
  )));
  return { root, webDir };
}

async function startServer(t, webDir) {
  const server = createRoomServer({
    engine: createStubEngine(),
    token: TOKEN,
    port: 0,
    webDir,
  });
  const port = await server.listen();
  t.after(async () => {
    await server.close();
  });
  return { server, port };
}

function baseUrl(port, pathname) {
  return `http://127.0.0.1:${port}${pathname}`;
}

function rawRequest(port, requestPath, {
  method = 'GET',
  headers = {},
  agent = undefined,
} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers,
      agent,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the whitelisted UI files without a token', async (t) => {
  const { webDir } = await createWebFixture(t);
  const { port } = await startServer(t, webDir);

  for (const { pathname, file, contentType } of STATIC_CASES) {
    const response = await fetch(baseUrl(port, pathname));
    assert.equal(response.status, 200, `${pathname} should be public`);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), WEB_FILES[file]);
  }

  let response = await fetch(baseUrl(port, '/favicon.ico'));
  assert.equal(response.status, 204);

  response = await fetch(baseUrl(port, '/favicon.ico'), { method: 'HEAD' });
  assert.equal(response.status, 204);

  response = await fetch(baseUrl(port, '/'), { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});

test('keeps API auth semantics and refuses traversal or sensitive paths', async (t) => {
  const { root, webDir } = await createWebFixture(t);
  const { port } = await startServer(t, webDir);

  let response = await fetch(baseUrl(port, '/api/room'));
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');

  response = await fetch(baseUrl(port, '/api/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: '0.5.1' });

  response = await fetch(baseUrl(port, '/api/room'), {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).roomId, 'r_static');

  for (const pathname of ['/api/room', '/package.json', '/../package.json', '/%2e%2e/secret.txt']) {
    const withoutToken = await rawRequest(port, pathname);
    assert.ok(
      withoutToken.status === 401 || withoutToken.status === 404,
      `${pathname} without token should not be public (got ${withoutToken.status})`,
    );
  }

  const sensitivePaths = [
    '/../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/web/../../secret.txt',
    '/package.json',
    '/server/http.mjs',
    '/rooms/demo-room/room.json',
    '/state/demo-room/room.json',
    '/probes/dsh/probe-list.mjs',
    '/api/../../package.json',
  ];

  for (const pathname of sensitivePaths) {
    const result = await rawRequest(port, pathname, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.ok(
      result.status === 404 || result.status === 400,
      `${pathname} should be rejected (got ${result.status})`,
    );
    assert.equal(result.body.includes('TOP_SECRET_FIXTURE'), false, pathname);
    assert.equal(result.body.includes('createRoomServer'), false, pathname);
    assert.equal(result.body.includes('"dependencies"'), false, pathname);
  }

  // 未知路径在带 token 时仍返回 API 404，而不是静态文件。
  const unknown = await rawRequest(port, '/not-a-route', {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(unknown.status, 404);
  assert.equal(JSON.parse(unknown.body).error.code, 'NOT_FOUND');

  assert.ok(existsSync(path.join(root, 'secret.txt')));
});

test('Host and Origin checks run before static serving', async (t) => {
  const { webDir } = await createWebFixture(t);
  const { port } = await startServer(t, webDir);

  const badHost = await rawRequest(port, '/', {
    headers: { Host: 'evil.example' },
  });
  assert.equal(badHost.status, 400);
  assert.match(badHost.body, /HOST_NOT_ALLOWED/);

  let response = await fetch(baseUrl(port, '/'), {
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(response.status, 403);

  response = await fetch(baseUrl(port, '/'), {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(response.status, 200);
});

test('close settles promptly without dangling keep-alive connections', async () => {
  const server = createRoomServer({
    engine: createStubEngine(),
    token: TOKEN,
    port: 0,
    webDir: PROJECT_WEB_DIR,
  });
  const port = await server.listen();
  const agent = new http.Agent({ keepAlive: true });

  try {
    const result = await rawRequest(port, '/api/health', { agent });
    assert.equal(result.status, 200);

    const startedAt = Date.now();
    await server.close();
    assert.ok(Date.now() - startedAt < 2000, 'server.close() should not hang');
    assert.equal(server.address(), null);
    await server.close();
  } finally {
    agent.destroy();
  }
});

test('serves the repository web/ assets when present', async (t) => {
  if (!STATIC_CASES.every(({ file }) => existsSync(path.join(PROJECT_WEB_DIR, file)))) {
    t.skip('project web/ assets are not present in this checkout');
    return;
  }

  const { port } = await startServer(t, PROJECT_WEB_DIR);
  for (const { pathname, file, contentType } of STATIC_CASES) {
    const response = await fetch(baseUrl(port, pathname));
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('content-type'), contentType);
    assert.equal(await response.text(), await readFile(path.join(PROJECT_WEB_DIR, file), 'utf8'));
  }
});
