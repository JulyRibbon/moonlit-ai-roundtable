import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import { startLive } from '../../server/live.mjs';

const TOKEN = 'game-http-test';

function config(roomId = 'r_game_http') {
  return {
    roomId,
    ownerName: '机主',
    maxAttempts: 3,
    contextMessages: 8,
    seats: ['a', 'b', 'c', 'd'].map((seatId) => ({
      seatId,
      displayName: seatId.toUpperCase(),
      color: '#112233',
      clientType: 'fake',
      nativeSessionRef: `fake_${seatId}`,
      enabled: true,
      voiceMode: 'none',
    })),
  };
}

async function api(live, pathname, { method = 'GET', body, authorized = true } = {}) {
  const response = await fetch(`http://127.0.0.1:${live.port}${pathname}`, {
    method,
    headers: {
      ...(authorized ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${label}`);
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-game-http-'));
  const live = await startLive({
    config: config(),
    stateDir: path.join(dir, 'state'),
    roomDir: path.join(dir, 'room'),
    token: TOKEN,
    port: 0,
    ...options,
  });
  t.after(async () => {
    await live.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, live };
}

test('human game HTTP, independent SSE and persistence leave chat untouched', async (t) => {
  const { dir, live } = await fixture(t);
  assert.equal((await api(live, '/api/game', { authorized: false })).response.status, 401);

  const created = await api(live, '/api/game/new', {
    method: 'POST',
    body: {
      players: [
        { kind: 'human', name: '机主甲' },
        { kind: 'human', name: '手动乙' },
        { kind: 'human', name: '手动丙' },
        { kind: 'human', name: '手动丁' },
      ],
    },
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.payload.runtime.phase, 'ready');
  assert.deepEqual(created.payload.game.players.map((player) => player.name), ['机主甲', '手动乙', '手动丙', '手动丁']);
  assert.equal(JSON.stringify(created.payload).includes('nativeSessionRef'), false);

  const stream = await fetch(`http://127.0.0.1:${live.port}/api/game/events`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.match(new TextDecoder().decode(first.value), /event: snapshot/);

  for (const edge of ['h:0:0', 'h:0:1', 'v:0:0', 'v:1:0']) {
    const moved = await api(live, '/api/game/move', { method: 'POST', body: { edge } });
    assert.equal(moved.response.status, 200);
  }
  const current = await api(live, '/api/game');
  assert.deepEqual(current.payload.game.scores, [0, 0, 0, 1]);
  assert.equal(current.payload.game.currentPlayer, 3);
  assert.equal(current.payload.game.moves.length, 4);

  const room = await api(live, '/api/room');
  assert.equal(room.payload.transcript.length, 0);
  assert.equal(room.payload.attempts.length, 0);
  assert.equal(room.payload.room.lastRoomSeq, 1, '只有初始化时的 RoomCreated，不应出现游戏聊天事件');

  const saved = JSON.parse(await readFile(path.join(dir, 'room', 'games', 'dots-and-boxes.json'), 'utf8'));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.game.moves.length, 4);
  assert.deepEqual(saved.game.scores, [0, 0, 0, 1]);
});

test('live AI game uses separate native sessions and never enters chat attempts', async (t) => {
  const bridges = [];
  const factories = {
    fake(bridgeConfig) {
      const bridge = new FakeBridge(bridgeConfig);
      bridges.push(bridge);
      const send = bridge.send.bind(bridge);
      bridge.send = async (packet) => {
        const receipt = await send(packet);
        if (packet.roomId.startsWith('game:')) {
          const available = [...packet.text.matchAll(/^- ([hv]:\d+:\d+)$/gm)].map((match) => match[1]);
          queueMicrotask(() => bridge.completeAttempt(packet.attemptId, {
            text: JSON.stringify({ edge: available.at(-1) }),
          }));
        }
        return receipt;
      };
      return bridge;
    },
  };
  const { live } = await fixture(t, { factories });
  const originalRefs = live.config.seats.map((seat) => seat.nativeSessionRef);
  const players = [
    { kind: 'human' },
    { kind: 'ai', seatId: 'b' },
    { kind: 'human' },
    { kind: 'human' },
  ];
  await api(live, '/api/game/new', { method: 'POST', body: { players } });
  await waitFor(async () => (await api(live, '/api/game')).payload.runtime.phase === 'ready', 'AI preparation');
  await api(live, '/api/game/move', { method: 'POST', body: { edge: 'h:0:0' } });

  const snapshot = await waitFor(async () => {
    const current = (await api(live, '/api/game')).payload;
    return current.game.moves.length === 2 && current.runtime.phase === 'ready' ? current : null;
  }, 'AI move');
  assert.equal(snapshot.game.moves[1].player, 1);
  assert.equal(snapshot.game.currentPlayer, 2);

  const room = await api(live, '/api/room');
  assert.equal(room.payload.transcript.length, 0);
  assert.equal(room.payload.attempts.length, 0);
  assert.deepEqual(live.config.seats.map((seat) => seat.nativeSessionRef), originalRefs);
  assert.equal(bridges.some((bridge) => bridge._sessionRef.startsWith('fake_session_b_')), true);
  assert.equal(live.engine.bridges.get('b')._attempts.size, 0);
});

test('ZCode game session is created and adopted inside its own preconnected bridge', async (t) => {
  const records = [];
  const factories = {
    zcode(bridgeConfig) {
      const bridge = new FakeBridge(bridgeConfig);
      const record = { bridge, config: bridgeConfig, connectCalls: 0, createCalls: 0, packets: [] };
      records.push(record);
      const connect = bridge.connect.bind(bridge);
      bridge.connect = async (...args) => {
        record.connectCalls += 1;
        return connect(...args);
      };
      const create = bridge.createNativeSession.bind(bridge);
      bridge.createNativeSession = async (...args) => {
        record.createCalls += 1;
        return create(...args);
      };
      bridge.adoptNativeSession = async (nativeSessionRef) => {
        bridge._sessionRef = nativeSessionRef;
        bridge._connected = true;
        return bridge.getIdentity();
      };
      const send = bridge.send.bind(bridge);
      bridge.send = async (packet) => {
        record.packets.push(packet);
        const receipt = await send(packet);
        const available = [...packet.text.matchAll(/^- ([hv]:\d+:\d+)$/gm)].map((match) => match[1]);
        queueMicrotask(() => bridge.completeAttempt(packet.attemptId, {
          text: JSON.stringify({ edge: available[0] }),
        }));
        return receipt;
      };
      return bridge;
    },
  };
  const overridden = config();
  overridden.seats[1].clientType = 'zcode';
  const { live } = await fixture(t, { config: overridden, factories });
  await api(live, '/api/game/new', {
    method: 'POST',
    body: {
      players: [
        { kind: 'human' },
        { kind: 'ai', seatId: 'b' },
        { kind: 'human' },
        { kind: 'human' },
      ],
    },
  });
  await waitFor(async () => (await api(live, '/api/game')).payload.runtime.phase === 'ready', 'ZCode preparation');
  await api(live, '/api/game/move', { method: 'POST', body: { edge: 'h:0:0' } });
  const snapshot = await waitFor(async () => {
    const current = (await api(live, '/api/game')).payload;
    return current.game.moves.length === 2 ? current : null;
  }, 'ZCode AI move');

  const gameRecord = records.find((record) => record.config.seatId.startsWith('game-'));
  assert.ok(gameRecord);
  assert.equal(gameRecord.createCalls, 1);
  assert.equal(gameRecord.connectCalls, 0, 'adopt 已连接的实例不得再次 connect');
  assert.equal(gameRecord.packets[0].seatId, gameRecord.config.seatId);
  assert.equal(snapshot.game.moves[1].player, 1);
  assert.equal((await api(live, '/api/room')).payload.attempts.length, 0);
});
