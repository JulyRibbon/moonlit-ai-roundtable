import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import {
  TABLETOP_SLOT_COLORS,
  TabletopManagerError,
  createTabletopManager,
} from '../../games/tabletop/coordinator.mjs';
import { TABLETOP_TYPES, getTabletopEngine } from '../../games/tabletop/engine.mjs';
import {
  createTabletopStore,
  tabletopStorePath,
} from '../../games/tabletop/store.mjs';

const AT = '2026-11-11T00:00:00.000Z';
const ROOM_ID = 'r_tabletop_test';

const CONFIG = {
  roomId: ROOM_ID,
  ownerName: '机主',
  seats: [
    { seatId: 's0', displayName: 'AI甲', clientType: 'fake', enabled: true, client: { token: 'secret-token' } },
    { seatId: 's1', displayName: 'AI乙', clientType: 'fake', enabled: true },
    { seatId: 's9', displayName: '隐藏', clientType: 'fake', enabled: false, client: { token: 'hidden-token' } },
  ],
};

function withCleanup(name, fn) {
  test(name, async (t) => {
    const cleanups = [];
    try {
      await fn({
        after(cleanup) {
          cleanups.push(cleanup);
        },
      }, t);
    } finally {
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        try {
          await cleanups[index]();
        } catch {
          // 清理失败不覆盖测试结果。
        }
      }
    }
  });
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airoom-tabletop-coordinator-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function createHarness({
  storeDir,
  config = CONFIG,
  responses = [],
  autoRespond,
  auto = true,
  createNativeSession,
  wait,
} = {}) {
  const records = [];
  const sessionCalls = [];
  let responseIndex = 0;
  let idSequence = 0;

  const factories = {
    fake(bridgeConfig) {
      const bridge = new FakeBridge(bridgeConfig);
      const record = { bridge, config: bridgeConfig, packets: [] };
      const originalSend = bridge.send.bind(bridge);
      bridge.send = async (packet) => {
        record.packets.push(packet);
        const receipt = await originalSend(packet);
        if (!auto) return receipt;
        let reply;
        if (typeof autoRespond === 'function') {
          reply = autoRespond(packet, record);
        } else {
          const scripted = responses[responseIndex];
          responseIndex += 1;
          reply = typeof scripted === 'function' ? scripted(packet, record) : scripted;
        }
        if (reply !== undefined) {
          queueMicrotask(() => {
            if (reply === null) {
              bridge.failAttempt(packet.attemptId, {
                error: { code: 'NO_SCRIPTED_REPLY', message: '脚本未提供回复。' },
              });
              return;
            }
            bridge.completeAttempt(packet.attemptId, {
              text: typeof reply === 'string' ? reply : JSON.stringify(reply),
            });
          });
        }
        return receipt;
      };
      records.push(record);
      return bridge;
    },
  };

  const manager = createTabletopManager({
    config,
    factories,
    createNativeSession: createNativeSession ?? (async (seatId, meta) => {
      sessionCalls.push({ seatId, meta });
      return {
        nativeSessionRef: `sess-${seatId}-${meta.gameType}-${sessionCalls.length}`,
      };
    }),
    storeDir,
    now: () => AT,
    id: () => {
      idSequence += 1;
      return `id-${idSequence}`;
    },
    wait,
  });

  return { manager, records, sessionCalls, config };
}

async function waitFor(predicate, { timeout = 3000, interval = 5, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function playersFor(kinds = ['human', 'human']) {
  return kinds.map((kind, slot) => ({
    slot,
    kind,
    name: kind === 'ai' ? `AI${slot}` : (slot === 0 ? '机主' : '人类2'),
    color: TABLETOP_SLOT_COLORS[slot],
    seatId: kind === 'ai' ? `s${slot}` : null,
    nativeSessionRef: kind === 'ai' ? `saved-session-${slot}` : null,
  }));
}

function makeRecord(gameType, overrides = {}) {
  return {
    gameId: `game-${gameType}-saved`,
    gameType,
    players: playersFor(),
    moves: [],
    createdAt: AT,
    updatedAt: AT,
    revision: 0,
    ...overrides,
  };
}

async function preload(storeDir, gameType, record) {
  const store = createTabletopStore({ storeDir, roomId: ROOM_ID, gameType });
  await store.save(record);
  return store;
}

withCleanup('init loads all five archives without preparing any AI', async (t) => {
  const dir = await tempDir(t);
  const engine = getTabletopEngine('xiangqi');
  let position = engine.createPosition();
  const action = engine.normalizeAction(engine.listLegalActions(position)[0]);
  position = engine.applyTurn(position, { player: 0, action });
  await preload(dir, 'xiangqi', makeRecord('xiangqi', {
    gameId: 'saved-xiangqi',
    players: playersFor(['human', 'ai']),
    moves: [{ seq: 1, player: 0, action, at: AT, comment: '' }],
    revision: 1,
  }));

  const harness = createHarness({ storeDir: dir });
  t.after(() => harness.manager.close());

  const snapshots = await harness.manager.init();
  assert.deepEqual(Object.keys(snapshots).sort(), [...TABLETOP_TYPES].sort());
  assert.equal(snapshots.xiangqi.game.gameId, 'saved-xiangqi');
  assert.equal(snapshots.xiangqi.game.moves.length, 1);
  assert.equal(snapshots.xiangqi.runtime.phase, 'idle');
  assert.match(snapshots.xiangqi.runtime.message, /继续/);
  for (const gameType of TABLETOP_TYPES.filter((type) => type !== 'xiangqi')) {
    assert.equal(snapshots[gameType].game, null);
    assert.equal(snapshots[gameType].runtime.phase, 'idle');
  }
  assert.equal(harness.records.length, 0);
  assert.equal(harness.sessionCalls.length, 0);
  await delay(30);
  assert.equal(harness.manager.getSnapshot('xiangqi').game.moves.length, 1);
});

for (const gameType of TABLETOP_TYPES) {
  withCleanup(`${gameType}: one human move and one AI reply with a public comment`, async (t) => {
    const dir = await tempDir(t);
    let chosen = null;
    const events = [];
    const harness = createHarness({
      storeDir: dir,
      autoRespond: () => {
        const snapshot = harness.manager.getSnapshot(gameType);
        chosen = snapshot.game.legalActions[0];
        return { action: chosen, comment: `  ${gameType} 的公开理由  ` };
      },
    });
    t.after(() => harness.manager.close());
    harness.manager.subscribe((event) => events.push(event));

    const created = await harness.manager.newGame(gameType, [
      { kind: 'human' },
      { kind: 'ai', seatId: 's0' },
    ]);
    assert.equal(created.gameType, gameType);
    assert.equal(created.runtime.phase, 'preparing');
    assert.deepEqual(created.game.players.map((player) => player.name), ['机主', 'AI甲']);
    assert.deepEqual(created.game.players.map((player) => player.color), [...TABLETOP_SLOT_COLORS]);
    assert.equal(created.game.currentPlayer, 0);
    assert.equal(created.game.status, 'playing');

    const ready = await waitFor(() => {
      const snapshot = harness.manager.getSnapshot(gameType);
      return snapshot.runtime.phase === 'ready' ? snapshot : null;
    }, { label: `${gameType} AI preparation` });
    assert.equal(ready.runtime.message.includes('机主'), true);

    const humanAction = ready.game.legalActions[0];
    const afterHuman = await harness.manager.move(gameType, humanAction);
    assert.equal(afterHuman.game.moves.length, 1);
    assert.equal(afterHuman.game.moves[0].player, 0);

    const done = await waitFor(() => {
      const snapshot = harness.manager.getSnapshot(gameType);
      return snapshot.game.moves.length === 2 && snapshot.runtime.phase === 'ready'
        ? snapshot
        : null;
    }, { label: `${gameType} AI reply` });

    assert.notEqual(chosen, null);
    assert.deepEqual(done.game.moves[1].action, chosen);
    assert.equal(done.game.moves[1].player, 1);
    assert.equal(done.game.moves[1].comment, `${gameType} 的公开理由`);
    assert.equal(done.game.moves[0].comment, '');
    assert.equal(JSON.stringify(done).includes('nativeSessionRef'), false);
    assert.equal(JSON.stringify(done).includes('sess-'), false);

    const packet = harness.records[0].packets[0];
    assert.equal(packet.roomId, `game:${created.game.gameId}`);
    assert.equal(packet.roomSeq, 2);
    assert.equal(packet.turnId, created.game.gameId);
    assert.equal(packet.contextEpoch, created.game.gameId);
    assert.equal(packet.attemptId.startsWith('game-attempt-'), true);
    assert.equal(packet.seatId, `game-${created.game.gameId}-1`);
    assert.equal(typeof packet.text, 'string');
    assert.equal(packet.text.includes(JSON.stringify(done.game.moves[1].action)), true);

    assert.deepEqual(harness.sessionCalls, [{
      seatId: 's0',
      meta: { gameId: created.game.gameId, slot: 1, gameType },
    }]);

    const expectedFile = tabletopStorePath({ storeDir: dir, roomId: ROOM_ID, gameType });
    await access(expectedFile);

    assert.ok(events.length >= 3);
    assert.ok(events.every((event) => event.type === 'GameChanged'));
    assert.ok(events.every((event) => event.snapshot.gameType === gameType));
    assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
  });
}

withCleanup('invalid AI JSON enters error, never auto-retries, and resume asks again', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({
    storeDir: dir,
    responses: [
      '我觉得应该下这里，但没有 JSON。',
      () => {
        const snapshot = harness.manager.getSnapshot('gomoku');
        return { action: snapshot.game.legalActions[0], comment: '重试成功' };
      },
    ],
  });
  t.after(() => harness.manager.close());

  await harness.manager.newGame('gomoku', [{ kind: 'human' }, { kind: 'ai', seatId: 's0' }]);
  const ready = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('gomoku');
    return snapshot.runtime.phase === 'ready' ? snapshot : null;
  }, { label: 'AI preparation' });
  assert.equal(ready.runtime.phase, 'ready');
  await harness.manager.move('gomoku', ready.game.legalActions[0]);

  const failed = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('gomoku');
    return snapshot.runtime.phase === 'error' ? snapshot : null;
  }, { label: 'invalid AI reply' });
  assert.equal(failed.game.moves.length, 1);
  assert.match(failed.runtime.message, /不是可用的落子/);
  assert.match(failed.runtime.message, /action/);
  assert.equal(harness.records[0].packets.length, 1);

  await delay(40);
  assert.equal(harness.records[0].packets.length, 1);
  assert.equal(harness.manager.getSnapshot('gomoku').game.moves.length, 1);

  const resumed = await harness.manager.resume('gomoku');
  assert.equal(resumed.runtime.phase, 'preparing');

  const recovered = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('gomoku');
    return snapshot.game.moves.length === 2 && snapshot.runtime.phase === 'ready'
      ? snapshot
      : null;
  }, { label: 'resumed AI reply' });
  assert.equal(recovered.game.moves[1].comment, '重试成功');
  assert.equal(harness.records[0].packets.length, 2);
  assert.match(harness.records[0].packets[1].text, /上一次尝试的问题/);
});

withCleanup('an illegal AI action fails without changing the game or retrying', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({
    storeDir: dir,
    responses: [JSON.stringify({ action: { kind: 'place', x: 0, y: 0 }, comment: '重复落子' })],
  });
  t.after(() => harness.manager.close());

  await harness.manager.newGame('gomoku', [{ kind: 'human' }, { kind: 'ai', seatId: 's0' }]);
  const ready = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('gomoku');
    return snapshot.runtime.phase === 'ready' ? snapshot : null;
  }, { label: 'AI preparation' });
  assert.deepEqual(ready.game.legalActions[0], { kind: 'place', x: 0, y: 0 });
  await harness.manager.move('gomoku', { kind: 'place', x: 0, y: 0 });

  const failed = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('gomoku');
    return snapshot.runtime.phase === 'error' ? snapshot : null;
  }, { label: 'illegal AI action' });
  assert.equal(failed.game.moves.length, 1);
  assert.match(failed.runtime.message, /不可用的动作/);

  await delay(40);
  assert.equal(harness.manager.getSnapshot('gomoku').game.moves.length, 1);
  assert.equal(harness.records[0].packets.length, 1);
});

withCleanup('restore never sends; resume reuses the saved session and sends once', async (t) => {
  const dir = await tempDir(t);
  const engine = getTabletopEngine('gomoku');
  let position = engine.createPosition();
  const action = engine.normalizeAction(engine.listLegalActions(position)[0]);
  position = engine.applyTurn(position, { player: 0, action });
  await preload(dir, 'gomoku', makeRecord('gomoku', {
    gameId: 'restored-gomoku',
    players: playersFor(['human', 'ai']),
    moves: [{ seq: 1, player: 0, action, at: AT, comment: '' }],
    revision: 1,
  }));

  const harness = createHarness({
    storeDir: dir,
    autoRespond: () => {
      const snapshot = harness.manager.getSnapshot('gomoku');
      return { action: snapshot.game.legalActions[0], comment: '恢复后落子' };
    },
  });
  t.after(() => harness.manager.close());

  const restored = await harness.manager.init();
  assert.equal(restored.gomoku.game.gameId, 'restored-gomoku');
  assert.equal(restored.gomoku.runtime.phase, 'idle');
  assert.equal(harness.records.length, 0);
  assert.equal(harness.sessionCalls.length, 0);

  await delay(40);
  assert.equal(harness.manager.getSnapshot('gomoku').game.moves.length, 1);

  const resumed = await harness.manager.resume('gomoku');
  assert.equal(resumed.runtime.phase, 'preparing');

  const done = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('gomoku');
    return snapshot.game.moves.length === 2 && snapshot.runtime.phase === 'ready'
      ? snapshot
      : null;
  }, { label: 'restored AI reply' });

  assert.equal(done.game.moves[1].comment, '恢复后落子');
  assert.equal(harness.sessionCalls.length, 0);
  assert.equal(harness.records.length, 1);
  assert.equal(harness.records[0].config.nativeSessionRef, 'saved-session-1');
  assert.equal(harness.records[0].packets.length, 1);
  assert.equal(harness.records[0].packets[0].roomSeq, 2);
});

withCleanup('a new game invalidates old AI work without touching other game types', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({ storeDir: dir, auto: false });
  t.after(() => harness.manager.close());

  await harness.manager.newGame('xiangqi', [
    { kind: 'ai', seatId: 's0' },
    { kind: 'ai', seatId: 's1' },
  ]);
  const inFlight = await waitFor(
    () => harness.records.find((record) => record.packets.length > 0),
    { label: 'old xiangqi AI request' },
  );
  const oldAttemptId = inFlight.packets[0].attemptId;

  const gomoku = await harness.manager.newGame('gomoku', [{ kind: 'human' }, { kind: 'human' }]);
  const gomokuAction = gomoku.game.legalActions[0];
  const gomokuAfterMove = await harness.manager.move('gomoku', gomokuAction);
  assert.equal(gomokuAfterMove.game.moves.length, 1);

  const replacement = await harness.manager.newGame('xiangqi', [
    { kind: 'human' },
    { kind: 'human' },
  ]);
  assert.equal(replacement.runtime.phase, 'ready');
  assert.equal(replacement.game.moves.length, 0);

  inFlight.bridge.completeAttempt(oldAttemptId, {
    text: JSON.stringify({ action: { kind: 'move', from: 'a0', to: 'a1' }, comment: '旧结果' }),
  });
  await delay(60);

  const xiangqi = harness.manager.getSnapshot('xiangqi');
  assert.equal(xiangqi.game.gameId, replacement.game.gameId);
  assert.equal(xiangqi.game.moves.length, 0);
  assert.equal(xiangqi.runtime.phase, 'ready');

  const other = harness.manager.getSnapshot('gomoku');
  assert.equal(other.game.moves.length, 1);
  assert.equal(other.game.gameId, gomoku.game.gameId);
});

withCleanup('two game types keep independent sessions, bridges and snapshots', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({
    storeDir: dir,
    autoRespond: (packet) => {
      for (const gameType of TABLETOP_TYPES) {
        const snapshot = harness.manager.getSnapshot(gameType);
        if (snapshot.game && `game:${snapshot.game.gameId}` === packet.roomId) {
          return { action: snapshot.game.legalActions[0], comment: `${gameType} 独立理由` };
        }
      }
      throw new Error(`unknown roomId: ${packet.roomId}`);
    },
  });
  t.after(() => harness.manager.close());

  const xiangqi = await harness.manager.newGame('xiangqi', [{ kind: 'human' }, { kind: 'ai', seatId: 's0' }]);
  const gomoku = await harness.manager.newGame('gomoku', [{ kind: 'human' }, { kind: 'ai', seatId: 's1' }]);
  assert.notEqual(xiangqi.game.gameId, gomoku.game.gameId);

  const ready = await waitFor(() => {
    const left = harness.manager.getSnapshot('xiangqi');
    const right = harness.manager.getSnapshot('gomoku');
    return left.runtime.phase === 'ready' && right.runtime.phase === 'ready'
      ? { left, right }
      : null;
  }, { label: 'both AI preparations' });

  assert.deepEqual(
    harness.sessionCalls.map((call) => call.meta.gameType).sort(),
    ['gomoku', 'xiangqi'],
  );
  assert.equal(harness.records.length, 2);
  assert.equal(
    new Set(harness.records.map((record) => record.config.nativeSessionRef)).size,
    2,
  );

  await harness.manager.move('xiangqi', ready.left.game.legalActions[0]);
  await harness.manager.move('gomoku', ready.right.game.legalActions[0]);

  const done = await waitFor(() => {
    const left = harness.manager.getSnapshot('xiangqi');
    const right = harness.manager.getSnapshot('gomoku');
    return left.game.moves.length === 2 && right.game.moves.length === 2
      ? { left, right }
      : null;
  }, { label: 'both AI replies' });

  assert.equal(done.left.game.moves[1].comment, 'xiangqi 独立理由');
  assert.equal(done.right.game.moves[1].comment, 'gomoku 独立理由');
  assert.equal(done.left.game.gameId, xiangqi.game.gameId);
  assert.equal(done.right.game.gameId, gomoku.game.gameId);
});

withCleanup('chat seats only create native sessions and never receive chat sends', async (t) => {
  const dir = await tempDir(t);
  let chatSends = 0;
  const createdSeatIds = [];
  const chatBridge = {
    async send() {
      chatSends += 1;
      return { accepted: true };
    },
    async createNativeSession(seatId) {
      createdSeatIds.push(seatId);
      return { nativeSessionRef: `chat-session-${seatId}` };
    },
  };

  const harness = createHarness({
    storeDir: dir,
    createNativeSession: (seatId) => chatBridge.createNativeSession(seatId),
  });
  t.after(() => harness.manager.close());

  await harness.manager.newGame('chess', [{ kind: 'human' }, { kind: 'ai', seatId: 's0' }]);
  const snapshot = await waitFor(() => {
    const current = harness.manager.getSnapshot('chess');
    return current.runtime.phase === 'ready' ? current : null;
  }, { label: 'AI preparation' });

  assert.deepEqual(createdSeatIds, ['s0']);
  assert.equal(chatSends, 0);
  assert.equal(harness.records.length, 1);
  assert.equal(harness.records[0].config.nativeSessionRef, 'chat-session-s0');
  const json = JSON.stringify(snapshot);
  assert.equal(json.includes('nativeSessionRef'), false);
  assert.equal(json.includes('chat-session-s0'), false);
  assert.equal(json.includes('secret-token'), false);
  assert.equal(json.includes('hidden-token'), false);
  assert.equal(harness.manager.getSnapshot('chess').seatOptions.length, 2);
});

withCleanup('a bridge returned already connected is used without another connect()', async (t) => {
  const dir = await tempDir(t);
  const bridges = [];
  let connectCalls = 0;

  const harness = createHarness({
    storeDir: dir,
    createNativeSession: async (seatId, meta) => {
      const nativeSessionRef = `connected-${meta.gameId}`;
      const bridge = new FakeBridge({
        seatId: `game-${meta.gameId}-${meta.slot}`,
        nativeSessionRef,
      });
      const originalConnect = bridge.connect.bind(bridge);
      bridge.connect = async (...args) => {
        connectCalls += 1;
        return originalConnect(...args);
      };
      await originalConnect();

      const originalSend = bridge.send.bind(bridge);
      bridge.send = async (packet) => {
        const receipt = await originalSend(packet);
        queueMicrotask(() => {
          const action = harness.manager.getSnapshot('go').game.legalActions[0];
          bridge.completeAttempt(packet.attemptId, {
            text: JSON.stringify({ action, comment: '已连接路径' }),
          });
        });
        return receipt;
      };
      bridges.push(bridge);
      return { nativeSessionRef, bridge, connected: true };
    },
  });
  t.after(() => harness.manager.close());

  await harness.manager.newGame('go', [{ kind: 'human' }, { kind: 'ai', seatId: 's0' }]);
  const ready = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('go');
    return snapshot.runtime.phase === 'ready' ? snapshot : null;
  }, { label: 'connected AI preparation' });
  await harness.manager.move('go', ready.game.legalActions[0]);

  const done = await waitFor(() => {
    const snapshot = harness.manager.getSnapshot('go');
    return snapshot.game.moves.length === 2 && snapshot.runtime.phase === 'ready'
      ? snapshot
      : null;
  }, { label: 'connected AI reply' });

  assert.equal(done.game.moves[1].comment, '已连接路径');
  assert.equal(bridges.length, 1);
  assert.equal(connectCalls, 0);
  assert.equal(harness.records.length, 0);
});

withCleanup('go pass is accepted and two passes finish the game', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({ storeDir: dir });
  t.after(() => harness.manager.close());

  const created = await harness.manager.newGame('go', [{ kind: 'human' }, { kind: 'human' }]);
  assert.equal(created.runtime.phase, 'ready');

  const first = await harness.manager.move('go', { kind: 'pass' });
  assert.equal(first.game.moves.length, 1);
  assert.deepEqual(first.game.moves[0].action, { kind: 'pass' });
  assert.equal(first.game.currentPlayer, 1);

  const second = await harness.manager.move('go', { kind: 'pass' });
  assert.equal(second.game.moves.length, 2);
  assert.equal(second.game.status, 'finished');
  assert.equal(second.runtime.phase, 'ready');
  assert.match(second.runtime.message, /对局结束/);
});

withCleanup('human moves are validated and invalid input is rejected', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({ storeDir: dir });
  t.after(() => harness.manager.close());

  await harness.manager.newGame('gomoku', [{ kind: 'human' }, { kind: 'human' }]);
  await harness.manager.move('gomoku', { kind: 'place', x: 0, y: 0 });
  await assert.rejects(
    () => harness.manager.move('gomoku', { kind: 'place', x: 0, y: 0 }),
    (error) => error?.name === 'GameRuleError' && error.code === 'CELL_OCCUPIED',
  );
  await assert.rejects(
    () => harness.manager.move('gomoku', { kind: 'place', x: 99, y: 99 }),
    (error) => error?.code === 'ACTION_INVALID',
  );

  await assert.rejects(
    () => harness.manager.newGame('shogi', [{ kind: 'human' }, { kind: 'human' }]),
    (error) => error instanceof TabletopManagerError && error.code === 'TABLETOP_TYPE_UNKNOWN',
  );
  assert.throws(
    () => harness.manager.getSnapshot('shogi'),
    (error) => error.code === 'TABLETOP_TYPE_UNKNOWN',
  );

  const hub = harness.manager.getSnapshot();
  assert.deepEqual(Object.keys(hub).sort(), ['game', 'gameType', 'ownerName', 'runtime', 'seatOptions']);
  assert.equal(hub.gameType, null);
  assert.equal(hub.game, null);
});

withCleanup('AI seat selection requires an enabled, unique seat', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({ storeDir: dir });
  t.after(() => harness.manager.close());

  await assert.rejects(
    () => harness.manager.newGame('chess', [
      { kind: 'ai', seatId: 's0' },
      { kind: 'ai', seatId: 's0' },
    ]),
    (error) => error?.code === 'SEAT_DUPLICATE',
  );
  await assert.rejects(
    () => harness.manager.newGame('chess', [
      { kind: 'human' },
      { kind: 'ai', seatId: 's9' },
    ]),
    (error) => error?.code === 'SEAT_INVALID',
  );
  await assert.rejects(
    () => harness.manager.newGame('chess', [{ kind: 'human' }]),
    (error) => error?.code === 'PLAYERS_INVALID',
  );
});

withCleanup('close is idempotent, closes bridges and rejects further games', async (t) => {
  const dir = await tempDir(t);
  const harness = createHarness({ storeDir: dir, auto: false });
  t.after(() => harness.manager.close());

  const created = await harness.manager.newGame('reversi', [
    { kind: 'ai', seatId: 's0' },
    { kind: 'ai', seatId: 's1' },
  ]);
  await waitFor(
    () => harness.records.some((record) => record.packets.length > 0),
    { label: 'pending AI request' },
  );

  const first = harness.manager.close();
  const second = harness.manager.close();
  assert.equal(first, second);
  await first;

  await waitFor(
    () => harness.records.every((record) => record.bridge.inspect().closed === true),
    { label: 'bridges closed' },
  );
  assert.equal(harness.manager.getSnapshot('reversi').game.moves.length, 0);
  await assert.rejects(
    () => harness.manager.newGame('reversi', [{ kind: 'human' }, { kind: 'human' }]),
    (error) => error?.code === 'MANAGER_CLOSED',
  );
  const unsubscribe = harness.manager.subscribe(() => {});
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();

  // 关闭不等于删除：存档仍然保留。
  await access(tabletopStorePath({ storeDir: dir, roomId: ROOM_ID, gameType: 'reversi' }));
  assert.equal(created.game.gameId.length > 0, true);
});
