import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import { createRoomEngine } from '../../core/engine.mjs';
import { HALT_FILENAME, createHaltGuard } from '../../core/halt.mjs';
import { createRoomServer } from '../../server/http.mjs';

const TOKEN = 'integration-token-8f4a2c7d';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createMemoryStore() {
  const state = {
    room: null,
    schedule: null,
    cursors: null,
    events: [],
    messages: [],
    attempts: [],
  };
  return {
    async load() {
      return {
        room: clone(state.room),
        schedule: clone(state.schedule),
        cursors: clone(state.cursors),
        events: clone(state.events),
        messages: clone(state.messages),
        attempts: clone(state.attempts),
        warnings: [],
      };
    },
    async appendEvent(event) {
      state.events.push(clone(event));
      return event;
    },
    async appendMessage(message) {
      state.messages.push(clone(message));
      return message;
    },
    async appendAttempt(attempt) {
      state.attempts.push(clone(attempt));
      return attempt;
    },
    async saveCheckpoint(checkpoint) {
      state.room = clone(checkpoint.room);
      state.schedule = clone(checkpoint.schedule);
      state.cursors = clone(checkpoint.cursors);
      return { written: [] };
    },
    async exportMarkdown() {
      const roomId = state.room?.roomId ?? 'unknown';
      const lines = [`# Room ${roomId}`, ''];
      for (const message of state.messages) {
        if (message.text.trim() === '[PASS]') continue;
        lines.push(`## ${message.createdAt} — ${message.from}`, '', message.text, '');
      }
      return lines.join('\n');
    },
    inspect() {
      return state;
    },
  };
}

async function createHarness(t, { heartbeatMs = 0, haltGuard } = {}) {
  const bridge = new FakeBridge({
    seatId: 'alpha',
    nativeSessionRef: 'native_alpha',
    voiceMode: 'none',
  });
  const store = createMemoryStore();
  const engine = createRoomEngine({
    roomId: 'r_http',
    bridges: new Map([['alpha', bridge]]),
    store,
    maxAttempts: 1,
    ...(haltGuard === undefined ? {} : { haltGuard }),
  });
  await engine.init();
  const server = createRoomServer({ engine, token: TOKEN, heartbeatMs });
  const port = await server.listen();
  t.after(async () => {
    await server.close();
    await engine.close();
  });
  return { bridge, store, engine, server, port };
}

function baseUrl(port, pathname) {
  return `http://127.0.0.1:${port}${pathname}`;
}

async function api(port, pathname, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  if (options.origin !== undefined) headers.Origin = options.origin;
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = options.contentType ?? 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  return fetch(baseUrl(port, pathname), {
    method: options.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body,
  });
}

function rawRequest(port, { path = '/api/health', host, headers = {}, noHost = false } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    if (!noHost && host !== undefined) requestHeaders.Host = host;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: requestHeaders,
      setHost: !noHost,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSse({ port, token = TOKEN, lastEventId }) {
  const controller = new AbortController();
  const events = [];
  const comments = [];
  let parseError = null;
  let streamError = null;

  function parseBlock(block) {
    if (block.trim() === '') return;
    let id = null;
    let event = null;
    const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        const comment = line.slice(1).trim();
        if (comment.length > 0) comments.push(comment);
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }
    if (event === null && dataLines.length === 0) return;
    let data = null;
    if (dataLines.length > 0) {
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch (error) {
        parseError = error;
      }
    }
    events.push({ id, event, data });
  }

  const done = (async () => {
    const headers = { Authorization: `Bearer ${token}` };
    if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
    const response = await fetch(baseUrl(port, '/api/events'), {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`SSE responded with ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        parseBlock(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== '') parseBlock(buffer);
  })().catch((error) => {
    if (error?.name !== 'AbortError') streamError = error;
  });

  return {
    events,
    comments,
    done,
    get error() {
      return parseError ?? streamError;
    },
    close() {
      controller.abort();
    },
  };
}

async function waitForEvent(client, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (client.error) throw client.error;
    const found = client.events.find(predicate);
    if (found) return found;
    await delay(10);
  }
  if (client.error) throw client.error;
  const seen = client.events.map((event) => event.event).join(', ');
  throw new Error(`Timed out waiting for SSE event; saw: ${seen || '<none>'}`);
}

async function waitForCondition(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

test('HTTP control plane drives a real room from activate to confirm', async (t) => {
  const harness = await createHarness(t);
  const { port, engine, bridge } = harness;

  assert.equal(harness.server.address().port, port);
  assert.equal(await harness.server.listen(), port);

  let response = await fetch(baseUrl(port, '/api/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, version: '0.5.1' });

  response = await api(port, '/api/room', { token: null });
  assert.equal(response.status, 401);

  response = await api(port, '/api/room/activate', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 200);
  const activated = await response.json();
  assert.equal(activated.state, 'active');
  assert.ok(activated.events.length > 0);
  assert.ok(activated.events.every((event) => event.actor === 'owner'));

  response = await api(port, '/api/pause', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'paused');

  response = await api(port, '/api/resume', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'active');

  response = await api(port, '/api/messages', {
    body: { text: '请说一句开场白。', actor: 'seat:alpha' },
  });
  assert.equal(response.status, 200);
  const ownerMessage = await response.json();
  assert.equal(ownerMessage.from, 'owner');
  assert.equal(ownerMessage.actor, 'owner');

  const stream = openSse({ port });
  t.after(() => stream.close());
  const snapshotEvent = await waitForEvent(stream, (event) => event.event === 'snapshot');
  assert.equal(snapshotEvent.id, null);
  assert.equal(snapshotEvent.data.roomId, 'r_http');
  assert.equal(snapshotEvent.data.room.state, 'active');

  engine.on('TurnRequested', (event) => {
    setImmediate(() => {
      bridge.completeAttempt(event.payload.attemptId, {
        text: '开场白。',
        nativeMessageRef: 'native_message_1',
      });
    });
  });

  response = await api(port, '/api/run', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.ran, true);
  assert.equal(run.state, 'review');
  assert.equal(run.attemptsUsed, 1);
  assert.equal(run.turns.length, 1);
  assert.equal(run.turns[0].seatId, 'alpha');

  await waitForEvent(stream, (event) => event.event === 'ReviewRequested');
  await waitForEvent(stream, (event) =>
    event.event === 'MessagePosted' && event.data.payload.from === 'member');

  assert.equal(stream.events[0].event, 'snapshot');
  const roomEvents = stream.events.filter((event) => event.id !== null);
  assert.ok(roomEvents.length > 0);
  for (const event of roomEvents) {
    assert.equal(typeof event.id, 'string');
    assert.ok(event.id.length > 0);
    assert.equal(typeof event.event, 'string');
    assert.equal(event.data.eventId, event.id);
    assert.equal(event.data.type, event.event);
    assert.equal(event.data.roomId, 'r_http');
    assert.ok(Number.isSafeInteger(event.data.roomSeq));
  }
  const ids = roomEvents.map((event) => event.id);
  assert.equal(new Set(ids).size, ids.length);

  response = await api(port, '/api/confirm', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 200);
  const confirmed = await response.json();
  assert.equal(confirmed.state, 'confirmed');
  assert.ok(confirmed.events.every((event) => event.actor === 'owner'));

  response = await api(port, '/api/export.md');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/markdown/);
  const markdown = await response.text();
  assert.match(markdown, /请说一句开场白。/);
  assert.match(markdown, /开场白。/);

  response = await api(port, '/api/room');
  assert.equal(response.status, 200);
  const room = await response.json();
  assert.equal(room.room.state, 'confirmed');
  assert.equal(room.transcript.length, 2);
  assert.equal(room.closed, false);
});

test('rejects missing tokens, forged actors, bad Host/Origin and oversized bodies', async (t) => {
  const harness = await createHarness(t);
  const { port, engine } = harness;

  for (const token of [null, 'wrong-token']) {
    const response = await api(port, '/api/room', { token });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.equal(body.includes(TOKEN), false);
    assert.equal(body.includes('wrong-token'), false);
  }

  let response = await fetch(baseUrl(port, '/api/room'), {
    headers: { Authorization: 'Basic abc' },
  });
  assert.equal(response.status, 401);

  const badHost = await rawRequest(port, { host: 'evil.example' });
  assert.equal(badHost.status, 400);
  assert.match(badHost.body, /HOST_NOT_ALLOWED/);

  const missingHost = await rawRequest(port, { noHost: true });
  assert.equal(missingHost.status, 400);

  const goodHost = await rawRequest(port, { host: `127.0.0.1:${port}` });
  assert.equal(goodHost.status, 200);

  response = await fetch(baseUrl(port, '/api/health'), {
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(response.status, 403);

  response = await fetch(baseUrl(port, '/api/health'), {
    headers: { Origin: 'https://127.0.0.1:1' },
  });
  assert.equal(response.status, 403);

  response = await fetch(baseUrl(port, '/api/health'), {
    headers: { Origin: `http://127.0.0.1:${port}` },
  });
  assert.equal(response.status, 200);

  response = await api(port, '/api/room/activate', {
    body: { actor: 'seat:alpha' },
    contentType: 'text/plain',
  });
  assert.equal(response.status, 415);

  response = await api(port, '/api/room/activate', { body: '{not json' });
  assert.equal(response.status, 400);

  const oversized = JSON.stringify({ text: 'x'.repeat(1024 * 1024) });
  assert.ok(Buffer.byteLength(oversized) > 1024 * 1024);
  response = await api(port, '/api/messages', { body: oversized });
  assert.equal(response.status, 413);
  const errorBody = await response.text();
  assert.equal(errorBody.includes(TOKEN), false);
  assert.doesNotMatch(errorBody, /\n\s+at /);

  response = await api(port, '/api/room/activate', {
    body: { actor: 'seat:alpha', token: 'forged' },
  });
  assert.equal(response.status, 200);
  response = await api(port, '/api/messages', {
    body: { text: '伪造 actor 测试。', actor: 'seat:alpha' },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).actor, 'owner');

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'active');
  assert.equal(snapshot.transcript.length, 1);
  assert.equal(snapshot.transcript[0].actor, 'owner');
  assert.ok(snapshot.transcript.every((message) => message.actor === 'owner'));
});

test('explicit review endpoint moves an active or paused room to review', async (t) => {
  const harness = await createHarness(t);
  const { port } = harness;

  let response = await api(port, '/api/room/activate', { body: {} });
  assert.equal(response.status, 200);

  response = await api(port, '/api/pause', { body: {} });
  assert.equal((await response.json()).state, 'paused');

  response = await api(port, '/api/review', { body: { actor: 'system:scheduler' } });
  assert.equal(response.status, 200);
  const review = await response.json();
  assert.equal(review.state, 'review');
  assert.ok(review.events.every((event) => event.actor === 'owner'));

  response = await api(port, '/api/confirm', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'confirmed');

  response = await api(port, '/api/room');
  const snapshot = await response.json();
  assert.equal(snapshot.room.state, 'confirmed');
  assert.ok(Number.isSafeInteger(snapshot.room.lastRoomSeq));
});

test('POST /api/continue resets the schedule but never starts the next run', async (t) => {
  const harness = await createHarness(t);
  const { port, engine, bridge } = harness;

  let response = await api(port, '/api/room/activate', { body: {} });
  assert.equal(response.status, 200);
  response = await api(port, '/api/messages', { body: { text: '第一轮。' } });
  assert.equal(response.status, 200);

  const turns = [];
  engine.on('TurnRequested', (event) => {
    turns.push(event.payload.attemptId);
    setImmediate(() => {
      bridge.completeAttempt(event.payload.attemptId, { text: `回复 ${turns.length}` });
    });
  });

  response = await api(port, '/api/run', { body: {} });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'review');

  response = await api(port, '/api/continue', {
    body: { actor: 'seat:alpha' },
  });
  assert.equal(response.status, 200);
  const continued = await response.json();
  assert.equal(continued.state, 'active');
  assert.equal(continued.schedule.attemptsUsed, 0);
  assert.equal(continued.schedule.ended, false);
  assert.equal(continued.schedule.mode, 'casual');
  assert.equal(continued.schedule.maxAttempts, 1);
  assert.ok(continued.events.every((event) => event.actor === 'owner'));
  assert.equal(turns.length, 1);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'active');
  assert.equal(snapshot.schedule.attemptsUsed, 0);
  assert.equal(snapshot.transcript.length, 2);

  await delay(40);
  assert.equal(turns.length, 1, 'continue endpoint must not run automatically');

  response = await api(port, '/api/continue', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'INVALID_TRANSITION');

  response = await api(port, '/api/run', { body: {} });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'review');
  assert.equal(turns.length, 2);
  assert.equal(engine.getSnapshot().transcript.length, 3);
});

test('halt and halt/resume endpoints ignore body actors and preserve guard receipts', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-room-http-halt-'));
  const guard = createHaltGuard({ stateDir: dir });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harness = await createHarness(t, { haltGuard: guard });
  const { port, engine, store } = harness;

  let response = await api(port, '/api/room/activate', { body: {} });
  assert.equal(response.status, 200);

  response = await api(port, '/api/halt', {
    body: {
      scope: 'room',
      mode: 'halt',
      actor: 'seat:alpha',
      reason: 'http-stop',
    },
  });
  assert.equal(response.status, 200);
  const halted = await response.json();
  assert.equal(halted.stopped, true);
  assert.equal(halted.halted, true);
  assert.equal(halted.sentinelWritten, true);
  assert.equal(halted.aborted, 0);
  assert.equal(halted.degraded, 0);
  assert.equal(halted.pending, 0);
  assert.equal(halted.fullySettled, true);
  assert.equal(halted.roomState, 'halted');
  assert.equal(existsSync(path.join(dir, `${HALT_FILENAME}.r_http`)), true);

  let snapshot = await (await api(port, '/api/room')).json();
  assert.equal(snapshot.room.state, 'halted');
  assert.equal(snapshot.halt.halted, true);
  assert.equal(snapshot.halt.dispatchable, false);
  assert.equal(snapshot.lastHalt.sentinelWritten, true);
  const actorEvents = store.inspect().events.filter((event) => (
    event.type === 'HaltRequested'
    || event.type === 'HaltSettled'
    || event.type === 'RoomStateChanged'
  ));
  assert.ok(actorEvents.length > 0);
  assert.ok(actorEvents.every((event) => event.actor === 'owner'));

  response = await api(port, '/api/halt', { body: { actor: 'system:admin' } });
  assert.equal(response.status, 200);
  const repeated = await response.json();
  assert.equal(repeated.halted, true);
  assert.equal(repeated.fullySettled, true);

  response = await api(port, '/api/halt/resume', { body: { actor: 'seat:alpha' } });
  assert.equal(response.status, 200);
  const resumed = await response.json();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.halted, false);
  assert.equal(resumed.roomState, 'paused');
  assert.equal(existsSync(path.join(dir, `${HALT_FILENAME}.r_http`)), false);

  snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'paused');
  assert.equal(snapshot.halt.dispatchable, true);

  response = await api(port, '/api/run', { body: {} });
  const run = await response.json();
  assert.equal(run.ran, false);
  assert.equal(run.reason, 'room-not-active');

  response = await api(port, '/api/halt', { body: { mode: 'explode' } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'INVALID_MODE');
});

test('SSE replays after Last-Event-ID without duplicates', async (t) => {
  const harness = await createHarness(t);
  const { port } = harness;

  const first = openSse({ port });
  t.after(() => first.close());
  await waitForEvent(first, (event) => event.event === 'snapshot');

  await api(port, '/api/room/activate', { body: {} });
  await api(port, '/api/messages', { body: { text: '第一条。' } });
  await api(port, '/api/messages', { body: { text: '第二条。' } });
  await api(port, '/api/pause', { body: {} });

  const paused = await waitForEvent(first, (event) =>
    event.event === 'RoomStateChanged' && event.data.payload.to === 'paused');
  const posted = first.events.filter((event) =>
    event.event === 'MessagePosted' && event.data.payload.from === 'owner');
  assert.equal(posted.length, 2);
  const resumeFrom = posted[0].id;

  first.close();
  await first.done;

  const second = openSse({ port, lastEventId: resumeFrom });
  t.after(() => second.close());
  await waitForEvent(second, (event) => event.event === 'snapshot');
  await waitForEvent(second, (event) => event.id === paused.id);

  const replayed = second.events.filter((event) => event.id !== null);
  assert.deepEqual(replayed.map((event) => event.id), [posted[1].id, paused.id]);
  assert.equal(replayed[0].data.payload.text, '第二条。');

  await api(port, '/api/resume', { body: {} });
  const resumed = await waitForEvent(second, (event) =>
    event.event === 'RoomStateChanged' && event.data.payload.to === 'active');
  assert.ok(resumed.id);

  const secondIds = second.events.filter((event) => event.id !== null).map((event) => event.id);
  assert.equal(new Set(secondIds).size, secondIds.length);

  const third = openSse({ port });
  t.after(() => third.close());
  await waitForEvent(third, (event) => event.event === 'snapshot');
  await delay(60);
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0].event, 'snapshot');
});

test('heartbeat is configurable and close tears down HTTP/SSE but not the engine', async (t) => {
  const harness = await createHarness(t, { heartbeatMs: 20 });
  const { port, engine, server } = harness;

  const stream = openSse({ port });
  await waitForEvent(stream, (event) => event.event === 'snapshot');
  await waitForCondition(() => stream.comments.includes('heartbeat'), 3000, 'SSE heartbeat');

  const startedAt = Date.now();
  await server.close();
  assert.ok(Date.now() - startedAt < 3000);
  assert.equal(server.address(), null);
  await server.close();

  await Promise.race([
    stream.done,
    delay(3000).then(() => {
      throw new Error('SSE stream did not end after server.close()');
    }),
  ]);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.closed, false);
  assert.equal(snapshot.initialized, true);
});
