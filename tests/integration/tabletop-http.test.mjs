import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import { TABLETOP_TYPES } from '../../games/tabletop/engine.mjs';
import { startLive } from '../../server/live.mjs';

const TOKEN = 'tabletop-http-test';

function config() {
  return {
    roomId: 'r_tabletop_http',
    ownerName: '机主',
    maxAttempts: 3,
    contextMessages: 8,
    seats: ['a', 'b'].map((seatId) => ({
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

async function api(live, pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`http://127.0.0.1:${live.port}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload;
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
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-room-tabletop-http-'));
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

test('all five tabletop HTTP routes preserve independent games and leave chat untouched', async (t) => {
  const { dir, live } = await fixture(t);
  for (const gameType of TABLETOP_TYPES) {
    const created = await api(live, '/api/tabletop/new', {
      method: 'POST',
      body: {
        gameType,
        players: [{ kind: 'human', name: '甲' }, { kind: 'human', name: '乙' }],
      },
    });
    assert.equal(created.gameType, gameType);
    assert.equal(created.runtime.phase, 'ready');
    assert.ok(created.game.legalActions.length > 0);
    const action = created.game.legalActions[0];
    const moved = await api(live, '/api/tabletop/move', {
      method: 'POST',
      body: { gameType, action },
    });
    assert.equal(moved.game.moves.length, 1, gameType);
    assert.equal(JSON.stringify(moved).includes('nativeSessionRef'), false);

    const saved = JSON.parse(await readFile(path.join(dir, 'r_tabletop_http', 'games', 'tabletop', `${gameType}.json`), 'utf8'));
    assert.equal(saved.game.moves.length, 1);
    assert.equal('board' in saved.game, false);
  }

  for (const gameType of TABLETOP_TYPES) {
    const restored = await api(live, `/api/tabletop?gameType=${gameType}`);
    assert.equal(restored.game.moves.length, 1, gameType);
  }
  const room = await api(live, '/api/room');
  assert.equal(room.transcript.length, 0);
  assert.equal(room.attempts.length, 0);
});

test('tabletop AI move and public comment use independent native sessions', async (t) => {
  const factories = {
    fake(bridgeConfig) {
      const bridge = new FakeBridge(bridgeConfig);
      const send = bridge.send.bind(bridge);
      bridge.send = async (packet) => {
        const receipt = await send(packet);
        queueMicrotask(() => bridge.completeAttempt(packet.attemptId, {
          text: JSON.stringify({
            action: { kind: 'place', x: 0, y: 0 },
            comment: '从角落开始，棋盘看得清楚。',
          }),
        }));
        return receipt;
      };
      return bridge;
    },
  };
  const { live } = await fixture(t, { factories });
  await api(live, '/api/tabletop/new', {
    method: 'POST',
    body: {
      gameType: 'gomoku',
      players: [{ kind: 'human' }, { kind: 'ai', seatId: 'b' }],
    },
  });
  await waitFor(async () => (await api(live, '/api/tabletop?gameType=gomoku')).runtime.phase === 'ready', 'preparation');
  await api(live, '/api/tabletop/move', {
    method: 'POST',
    body: { gameType: 'gomoku', action: { kind: 'place', x: 1, y: 0 } },
  });
  const moved = await waitFor(async () => {
    const snapshot = await api(live, '/api/tabletop?gameType=gomoku');
    return snapshot.game.moves.length === 2 && snapshot.runtime.phase === 'ready' ? snapshot : null;
  }, 'AI move');
  assert.equal(moved.game.moves[1].comment, '从角落开始，棋盘看得清楚。');
  assert.equal(moved.game.moves[1].action.kind, 'place');
  assert.equal((await api(live, '/api/room')).attempts.length, 0);
});
