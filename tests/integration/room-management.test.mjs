import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startLive } from '../../server/live.mjs';

function rawConfig(roomId) {
  return {
    _comment: '保留这条配置说明',
    roomId,
    ownerName: '机主',
    maxAttempts: 3,
    contextMessages: 8,
    seats: [
      { seatId: 'a', displayName: '小甲', color: '#112233', clientType: 'fake', nativeSessionRef: 'fake_a', enabled: true, voiceMode: 'none' },
      { seatId: 'b', displayName: '小乙', color: '#445566', clientType: 'fake', nativeSessionRef: 'fake_b', enabled: true, voiceMode: 'none' },
    ],
  };
}

function apiFor(live) {
  return async (pathname, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${live.port}${pathname}`, {
      method,
      headers: {
        Authorization: 'Bearer management-test',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${pathname} ${response.status}: ${JSON.stringify(payload)}`);
    return payload;
  };
}

test('settings, aliases, order, native reset and transcript backup work end to end', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-room-management-'));
  const configPath = path.join(dir, 'members.json');
  await writeFile(configPath, JSON.stringify(rawConfig('r_management'), null, 2));
  const live = await startLive({
    configPath,
    stateDir: path.join(dir, 'state'),
    roomDir: path.join(dir, 'room'),
    token: 'management-test',
    port: 0,
  });
  t.after(async () => {
    await live.close();
    await rm(dir, { recursive: true, force: true });
  });
  const api = apiFor(live);

  const saved = await api('/api/settings', {
    method: 'POST',
    body: {
      ownerName: '星主',
      maxAttempts: 1,
      contextMessages: 4,
      seatOrder: ['b', 'a'],
      seats: [
        { seatId: 'a', displayName: '小A', color: '#abcdef' },
        { seatId: 'b', displayName: '小B', color: '#123456' },
      ],
    },
  });
  assert.equal(saved.persisted, true);
  assert.deepEqual(saved.settings.seatOrder, ['b', 'a']);

  const persistedSettings = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(persistedSettings._comment, '保留这条配置说明');
  assert.equal(persistedSettings.ownerName, '星主');
  assert.equal(persistedSettings.maxAttempts, 1);
  assert.equal(persistedSettings.contextMessages, 4);
  assert.deepEqual(persistedSettings.seats.map((seat) => seat.seatId), ['b', 'a']);
  assert.equal(persistedSettings.seats[0].displayName, '小B');

  await api('/api/room/activate', { method: 'POST', body: {} });
  await api('/api/messages', { method: 'POST', body: { text: '测试昵称和顺序', mentions: [], nominations: [] } });
  const packets = [];
  const off = live.engine.on('TurnRequested', (event) => {
    setImmediate(() => {
      const bridge = live.engine.bridges.get(event.payload.seatId);
      packets.push(bridge._attempts.get(event.payload.attemptId).packet.text);
      bridge.completeAttempt(event.payload.attemptId, { text: '小B 回应，@小A 下一位。' });
    });
  });
  const run = await api('/api/run', { method: 'POST', body: {} });
  off();
  assert.equal(run.turns[0].seatId, 'b');
  assert.equal(run.attemptsUsed, 1);
  assert.match(packets[0], /星主/);
  assert.match(packets[0], /小B\(b\)/);
  const afterRun = await api('/api/room');
  assert.deepEqual(afterRun.transcript.at(-1).mentions, ['a']);

  const exported = await api('/api/export.json');
  assert.equal(exported.settings.ownerName, '星主');
  assert.equal(exported.messages.length, 2);

  const counters = await api('/api/counters');
  assert.equal(counters.schedule.stats.completed, 1);
  assert.equal(counters.schedule.seats.find((seat) => seat.seatId === 'b').stats.completed, 1);
  assert.equal(counters.totals.messages, 2);

  const counterReset = await api('/api/counters/reset', { method: 'POST', body: {} });
  assert.equal(counterReset.round, 2);
  assert.equal(counterReset.counters.schedule.attemptsUsed, 0);
  assert.equal(counterReset.counters.schedule.stats.completed, 0);
  assert.equal(counterReset.counters.schedule.seats.every((seat) => seat.stats.completed === 0), true);
  assert.equal(counterReset.counters.totals.messages, 2, '重置计数不得清空字幕');
  assert.equal(counterReset.counters.totals.attemptsInStore, 1, '重置计数不得删除 attempt 审计');
  const counterBackup = JSON.parse(await readFile(counterReset.backupPath, 'utf8'));
  assert.equal(counterBackup.schedule.stats.completed, 1);

  const oldBridge = live.engine.bridges.get('b');
  const reset = await api('/api/seats/b/session', { method: 'POST', body: {} });
  assert.equal(reset.persisted, true);
  assert.equal(reset.nativeSessionRef, 'fake_session_b_1');
  assert.equal(oldBridge.inspect().closed, true);
  const afterReset = await api('/api/room');
  assert.equal(afterReset.transcript.length, 2, '新会话不得清空房间字幕');
  assert.equal(afterReset.bridges.find((bridge) => bridge.seatId === 'b').identity.nativeSessionRef, 'fake_session_b_1');
  const persistedReset = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(persistedReset.seats.find((seat) => seat.seatId === 'b').nativeSessionRef, 'fake_session_b_1');

  const cleared = await api('/api/transcript/clear', { method: 'POST', body: {} });
  assert.equal(cleared.clearedCount, 2);
  const backup = await stat(cleared.backupPath);
  assert.equal(backup.isFile(), true);
  assert.match(await readFile(cleared.backupPath, 'utf8'), /测试昵称和顺序/);
  const afterClear = await api('/api/room');
  assert.equal(afterClear.transcript.length, 0);
  assert.equal(afterClear.attempts.length, 1, '清空字幕不得删除 attempt 审计');
});
