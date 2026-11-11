import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HALT_FILENAME } from '../../core/halt.mjs';
import { startDemo } from '../../server/demo.mjs';

const OWNER_TEXT = '请三位做一个简短的自我介绍。';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function api(port, token, pathname, { method = 'GET', body } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: payload,
  });
}

async function makeTempDirs(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'airoom-demo-halt-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    stateDir: path.join(root, 'state'),
    roomDir: path.join(root, 'room'),
  };
}

test('browser halt aborts the in-flight fake reply and the demo never dispatches another seat', async (t) => {
  const { root, stateDir, roomDir } = await makeTempDirs(t);
  let demo = null;
  let closed = false;
  t.after(async () => {
    if (demo && !closed) await demo.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  demo = await startDemo({ port: 0, replyDelayMs: 2000, stateDir, roomDir });
  const { engine, port, token } = demo;

  const turnPayloads = [];
  const bridgeEvents = [];
  engine.on('TurnRequested', (event) => turnPayloads.push(event.payload));
  engine.on('bridge-event', (event) => bridgeEvents.push(event));

  let response = await api(port, token, '/api/room/activate', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).state, 'active');

  response = await api(port, token, '/api/messages', {
    method: 'POST',
    body: { text: OWNER_TEXT },
  });
  assert.equal(response.status, 200);

  const runResponsePromise = api(port, token, '/api/run', { method: 'POST', body: {} });
  await waitFor(
    () => engine.getSnapshot().attempts.some((attempt) => attempt.status === 'running'),
    5000,
    'the fake bridge to accept a turn',
  );

  const running = engine.getSnapshot().attempts.find((attempt) => attempt.status === 'running');
  assert.ok(running?.attemptId);
  assert.equal(turnPayloads.length, 1);

  response = await api(port, token, '/api/halt', {
    method: 'POST',
    body: { scope: 'room', mode: 'halt', reason: 'browser-emergency-stop' },
  });
  assert.equal(response.status, 200);
  const halted = await response.json();
  assert.equal(halted.halted, true);
  assert.equal(halted.sentinelWritten, true);
  assert.equal(halted.aborted, 1);
  assert.equal(halted.degraded, 0);
  assert.equal(halted.pending, 0);
  assert.equal(halted.fullySettled, true);
  assert.equal(halted.attempts.length, 1);
  assert.equal(halted.attempts[0].attemptId, running.attemptId);
  assert.equal(halted.attempts[0].status, 'aborted');
  assert.equal(halted.attempts[0].settlement, 'confirmed');

  const runResponse = await runResponsePromise;
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.ran, true);
  assert.equal(run.state, 'halted');
  assert.equal(run.reason, 'halted');
  assert.equal(run.turns.length, 1);
  assert.equal(run.turns[0].attemptId, running.attemptId);

  assert.ok(bridgeEvents.some((event) => (
    event.type === 'AttemptAborted' && event.attemptId === running.attemptId
  )), 'the real FakeBridge should emit AttemptAborted');

  const sentinel = path.join(stateDir, `${HALT_FILENAME}.${engine.roomId}`);
  assert.equal(existsSync(sentinel), true);

  let snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'halted');
  assert.equal(snapshot.attempts.length, 1);
  assert.equal(snapshot.attempts[0].status, 'aborted');
  assert.ok(snapshot.attempts.every((attempt) => attempt.terminal));
  assert.equal(snapshot.transcript.filter((message) => message.from === 'member').length, 0);
  assert.equal(snapshot.halt.inFlight, 0);
  assert.equal(snapshot.halt.dispatchable, false);

  // 2 秒回复计时器必须已被停止清理；等待一段时间也不会有迟到消息或新回合。
  await delay(250);
  assert.equal(turnPayloads.length, 1);
  snapshot = engine.getSnapshot();
  assert.equal(snapshot.attempts.length, 1);
  assert.equal(snapshot.transcript.filter((message) => message.from === 'member').length, 0);

  response = await api(port, token, '/api/halt/resume', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  const resumed = await response.json();
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.halted, false);
  assert.equal(resumed.roomState, 'paused');
  assert.equal(existsSync(sentinel), false);

  snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'paused');
  assert.equal(snapshot.halt.dispatchable, true);

  response = await api(port, token, '/api/run', { method: 'POST', body: {} });
  const afterResumeRun = await response.json();
  assert.equal(afterResumeRun.ran, false);
  assert.equal(afterResumeRun.reason, 'room-not-active');
  assert.equal(turnPayloads.length, 1);
  assert.equal(engine.getSnapshot().attempts.length, 1);

  // 再落一次哨兵：close() 只清 guard 内存，不能删除停止事实文件。
  response = await api(port, token, '/api/halt', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).roomState, 'halted');
  assert.equal(existsSync(sentinel), true);

  const closeStartedAt = Date.now();
  await demo.close();
  closed = true;
  assert.ok(Date.now() - closeStartedAt < 2000, 'demo.close() should not hang');
  assert.equal(demo.server.address(), null);
  await demo.close();
  assert.equal(existsSync(sentinel), true);

  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false);
});

test('AIROOM_REPLY_DELAY_MS controls fake reply timing and the round still completes', async (t) => {
  const { stateDir, roomDir } = await makeTempDirs(t);
  const previous = process.env.AIROOM_REPLY_DELAY_MS;
  process.env.AIROOM_REPLY_DELAY_MS = '10';

  let demo = null;
  try {
    demo = await startDemo({ port: 0, stateDir, roomDir, maxAttempts: 3 });
  } finally {
    if (previous === undefined) delete process.env.AIROOM_REPLY_DELAY_MS;
    else process.env.AIROOM_REPLY_DELAY_MS = previous;
  }

  t.after(async () => {
    await demo.close().catch(() => {});
  });

  const { engine, port, token } = demo;
  let response = await api(port, token, '/api/room/activate', { method: 'POST', body: {} });
  assert.equal(response.status, 200);

  response = await api(port, token, '/api/messages', {
    method: 'POST',
    body: { text: OWNER_TEXT },
  });
  assert.equal(response.status, 200);

  response = await api(port, token, '/api/run', { method: 'POST', body: {} });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(run.ran, true);
  assert.equal(run.state, 'review');
  assert.equal(run.turns.length, 3);
  assert.equal(run.attemptsUsed, 3);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'review');
  const members = snapshot.transcript.filter((message) => message.from === 'member');
  assert.equal(members.length, 3);
  assert.ok(members.every((message) => message.text !== '[PASS]'));
  assert.equal(snapshot.attempts.filter((attempt) => attempt.status === 'completed').length, 3);
  assert.equal(snapshot.halt.inFlight, 0);
  assert.equal(existsSync(path.join(stateDir, `${HALT_FILENAME}.${engine.roomId}`)), false);

  await demo.close();
  assert.equal(demo.server.address(), null);
});
