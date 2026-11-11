import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import {
  GAME_COLORS,
  createGameCoordinator,
} from '../../games/dots-and-boxes/coordinator.mjs';
import { createGameStore } from '../../games/dots-and-boxes/store.mjs';
import { createGame } from '../../games/dots-and-boxes/rules.mjs';

function withCleanup(name, fn) {
  test(name, async (t) => {
    const cleanups = [];
    const context = {
      after(cleanup) {
        cleanups.push(cleanup);
      },
    };
    try {
      await fn(context, t);
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

const CONFIG = {
  roomId: 'r_game_test',
  ownerName: '机主',
  seats: [
    { seatId: 's0', displayName: '甲', color: '#111111', clientType: 'fake', enabled: true, client: { token: 'token-0' } },
    { seatId: 's1', displayName: '乙', color: '#222222', clientType: 'fake', enabled: true, client: { token: 'token-1' } },
    { seatId: 's2', displayName: '丙', color: '#333333', clientType: 'fake', enabled: true, client: { token: 'token-2' } },
    { seatId: 's3', displayName: '丁', color: '#444444', clientType: 'fake', enabled: true, client: { token: 'token-3' } },
    { seatId: 's9', displayName: '隐藏', color: '#555555', clientType: 'fake', enabled: false, client: { token: 'secret-token' } },
  ],
};

const HUMANS = [{ kind: 'human' }, { kind: 'human' }, { kind: 'human' }, { kind: 'human' }];
const MIXED = [
  { kind: 'human' },
  { kind: 'ai', seatId: 's1' },
  { kind: 'human' },
  { kind: 'ai', seatId: 's3' },
];
const ALL_AI = [
  { kind: 'ai', seatId: 's0' },
  { kind: 'ai', seatId: 's1' },
  { kind: 'ai', seatId: 's2' },
  { kind: 'ai', seatId: 's3' },
];

function createMemoryStore(initial = null) {
  let game = initial === null ? null : structuredClone(initial);
  return {
    async load() {
      return game === null ? null : structuredClone(game);
    },
    async save(next) {
      game = structuredClone(next);
    },
    current() {
      return game === null ? null : structuredClone(game);
    },
  };
}

function applyAction(bridge, attemptId, action) {
  if (action === undefined || action === null) return;
  if (typeof action === 'string') {
    bridge.completeAttempt(attemptId, { text: action });
    return;
  }
  if (action.type === 'url') return;
  if (action.type === 'fail') {
    bridge.failAttempt(attemptId, {
      error: action.error ?? { code: 'SCRIPTED_FAILURE', message: '脚本指定的失败。' },
    });
    return;
  }
  if (action.type === 'abort') {
    bridge.cancel(attemptId);
    return;
  }
  if (action.type === 'complete') {
    bridge.completeAttempt(attemptId, { text: action.text });
  }
}

function createHarness({
  config = CONFIG,
  responses = [],
  auto = true,
  store = createMemoryStore(),
  createNativeSession,
  now = () => '2026-11-11T00:00:00.000Z',
} = {}) {
  const records = [];
  const sessionCalls = [];
  let responseIndex = 0;
  let idSequence = 0;

  const factories = {
    fake(bridgeConfig) {
      const bridge = new FakeBridge(bridgeConfig);
      const record = {
        bridge,
        config: bridgeConfig,
        packets: [],
      };
      const originalSend = bridge.send.bind(bridge);
      bridge.send = async (packet) => {
        record.packets.push(packet);
        const receipt = await originalSend(packet);
        if (auto) {
          const scripted = responses[responseIndex];
          responseIndex += 1;
          const action = typeof scripted === 'function' ? scripted(packet, record) : scripted;
          queueMicrotask(() => applyAction(bridge, packet.attemptId, action));
        }
        return receipt;
      };
      records.push(record);
      return bridge;
    },
  };

  const coordinator = createGameCoordinator({
    config,
    factories,
    store,
    createNativeSession: createNativeSession ?? (async (seatId) => {
      sessionCalls.push(seatId);
      return { nativeSessionRef: `sess-${seatId}-${sessionCalls.length}` };
    }),
    now,
    id: () => {
      idSequence += 1;
      return `id-${idSequence}`;
    },
  });

  return { coordinator, records, sessionCalls, store };
}

async function waitFor(predicate, { timeout = 2000, interval = 5, label = 'condition' } = {}) {
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

withCleanup('all-human game is immediately ready and four moves advance turns and score', async (t) => {
  const harness = createHarness();
  t.after(() => harness.coordinator.close());
  const events = [];
  harness.coordinator.subscribe((event) => events.push(event));

  let snapshot = await harness.coordinator.newGame(HUMANS);
  assert.equal(snapshot.runtime.phase, 'ready');
  assert.equal(snapshot.runtime.message.includes('机主'), true);
  assert.deepEqual(snapshot.game.players.map((player) => player.name), ['机主', '人类 2', '人类 3', '人类 4']);
  assert.deepEqual(snapshot.game.players.map((player) => player.color), [...GAME_COLORS]);
  assert.equal(harness.records.length, 0);
  assert.equal(harness.sessionCalls.length, 0);
  assert.equal(snapshot.seatOptions.length, 4);
  assert.deepEqual(
    Object.keys(snapshot.seatOptions[0]).sort(),
    ['clientType', 'color', 'displayName', 'seatId'],
  );
  assert.equal(JSON.stringify(snapshot).includes('secret-token'), false);
  assert.equal(JSON.stringify(snapshot).includes('token-0'), false);

  snapshot = await harness.coordinator.move('h:0:0');
  snapshot = await harness.coordinator.move('h:0:1');
  snapshot = await harness.coordinator.move('v:0:0');
  snapshot = await harness.coordinator.move('v:1:0');
  assert.equal(snapshot.game.currentPlayer, 3);
  assert.deepEqual(snapshot.game.scores, [0, 0, 0, 1]);
  assert.equal(snapshot.game.boxes['b:0:0'], 3);
  assert.equal(snapshot.runtime.phase, 'ready');

  snapshot = await harness.coordinator.move('h:1:0');
  assert.equal(snapshot.game.currentPlayer, 0);
  assert.equal(snapshot.game.moves.length, 5);

  assert.ok(events.length >= 6);
  assert.ok(events.every((event) => event.type === 'GameChanged'));
  assert.equal(new Set(events.map((event) => event.eventId)).size, events.length);
});

withCleanup('concurrent clicks on the same edge only apply one move', async (t) => {
  const harness = createHarness();
  t.after(() => harness.coordinator.close());
  await harness.coordinator.newGame(HUMANS);

  const results = await Promise.allSettled([
    harness.coordinator.move('h:0:0'),
    harness.coordinator.move('h:0:0'),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'EDGE_OCCUPIED');
  assert.equal(harness.coordinator.getSnapshot().game.moves.length, 1);

  await assert.rejects(
    harness.coordinator.move('h:9:9'),
    (error) => error?.code === 'EDGE_INVALID',
  );
});

withCleanup('AI moves legally, completes a box and keeps the turn', async (t) => {
  const harness = createHarness({
    responses: [
      '{"edge":"h:0:0","comment":"  先占边，观察对手  "}',
      '{"edge":"h:0:1"}',
      '{"edge":"v:0:0"}',
      '{"edge":"v:1:0"}',
      '{"edge":"h:1:0"}',
    ],
  });
  t.after(() => harness.coordinator.close());

  const created = await harness.coordinator.newGame(ALL_AI);
  assert.equal(created.runtime.phase, 'preparing');

  const snapshot = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.game.moves.length >= 5 ? current : null;
  }, { label: 'five AI moves' });

  assert.equal(snapshot.game.moves[3].player, 3);
  assert.deepEqual(snapshot.game.moves[3].completedBoxes, ['b:0:0']);
  assert.equal(snapshot.game.scores[3], 1);
  assert.equal(snapshot.game.moves[4].player, 3);
  assert.equal(snapshot.game.moves[4].edge, 'h:1:0');
  assert.equal(snapshot.game.moves[0].comment, '先占边，观察对手');
  assert.equal(snapshot.game.moves[1].comment, '');

  assert.equal(harness.records.length, 4);
  assert.equal(harness.sessionCalls.length, 4);
  const first = harness.records[0].packets[0];
  assert.equal(first.roomId, `game:${snapshot.game.gameId}`);
  assert.equal(first.roomSeq, 1);
  assert.equal(first.turnId, snapshot.game.gameId);
  assert.equal(first.contextEpoch, snapshot.game.gameId);
  assert.equal(first.seatId, `game-${snapshot.game.gameId}-0`);
  assert.match(first.text, /4x4/);
  assert.match(first.text, /所有可用边/);
  assert.match(first.text, /"edge":"h:x:y","comment":"一句简短公开理由"/);
  assert.equal(harness.records[3].packets[1].roomSeq, 5);
});

withCleanup('AI comments are saved atomically and survive a reload', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airoom-dots-comment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rooms', 'r_game_test', 'games', 'dots-and-boxes.json');
  const store = createGameStore(file);
  const harness = createHarness({
    store,
    responses: ['{"edge":"h:0:1","comment":"  堵住对手第三个格子  "}'],
  });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(MIXED);
  await waitFor(() => harness.coordinator.getSnapshot().runtime.phase === 'ready', {
    label: 'AI preparation',
  });
  await harness.coordinator.move('h:0:0');
  const snapshot = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.game.moves.length === 2 && current.runtime.phase === 'ready'
      ? current
      : null;
  }, { label: 'AI reply with comment' });

  assert.equal(snapshot.game.moves[1].comment, '堵住对手第三个格子');
  assert.equal(snapshot.game.moves[0].comment, '');
  assert.ok(snapshot.game.moves.every((move) => typeof move.comment === 'string'));

  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.game.moves[1].comment, '堵住对手第三个格子');
  assert.equal(record.game.moves[1].edge, 'h:0:1');

  // 存档里的附言随对局一起恢复，且不进入 AI 请求包。
  await harness.coordinator.close();
  const restoredHarness = createHarness({ store });
  t.after(() => restoredHarness.coordinator.close());
  const restored = await restoredHarness.coordinator.init();
  assert.equal(restored.game.moves[1].comment, '堵住对手第三个格子');
  const packetTexts = restoredHarness.records.flatMap(
    (entry) => entry.packets.map((packet) => packet.text),
  );
  assert.equal(packetTexts.some((text) => text.includes('堵住对手第三个格子')), false);
});

withCleanup('human move wakes the AI and returns to the next human when it finishes', async (t) => {
  const harness = createHarness({ responses: ['```json\n{"edge":"h:0:1"}\n```'] });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(MIXED);
  await waitFor(() => harness.coordinator.getSnapshot().runtime.phase === 'ready', {
    label: 'AI preparation',
  });

  const afterHuman = await harness.coordinator.move('h:0:0');
  assert.equal(afterHuman.runtime.phase, 'thinking');

  const snapshot = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.game.moves.length === 2 && current.runtime.phase === 'ready'
      ? current
      : null;
  }, { label: 'AI reply' });

  assert.equal(snapshot.game.moves[1].player, 1);
  assert.equal(snapshot.game.moves[1].edge, 'h:0:1');
  assert.equal(snapshot.game.currentPlayer, 2);
  assert.equal(harness.records[0].packets.length, 1);
  assert.equal(harness.records[0].packets[0].text.includes('当前轮到：slot 1（乙，AI）'), true);
});

withCleanup('invalid AI JSON enters error without a move, and resume asks again', async (t) => {
  const harness = createHarness({
    responses: [
      '我觉得应该走这里，但没有 JSON。',
      '{"edge":"h:0:1","comment":"补一条边"}',
    ],
  });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(MIXED);
  await waitFor(() => harness.coordinator.getSnapshot().runtime.phase === 'ready');
  await harness.coordinator.move('h:0:0');

  const failed = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.runtime.phase === 'error' ? current : null;
  }, { label: 'invalid AI reply error' });

  assert.equal(failed.game.moves.length, 1);
  assert.match(failed.runtime.message, /不是可用的落子/);
  assert.match(failed.runtime.message, /edge.*comment/);
  assert.equal(harness.records[0].packets.length, 1);

  const resumed = await harness.coordinator.resume();
  assert.equal(resumed.runtime.phase, 'preparing');

  const recovered = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.game.moves.length === 2 && current.runtime.phase === 'ready'
      ? current
      : null;
  }, { label: 'resume AI reply' });

  assert.equal(recovered.game.moves[1].edge, 'h:0:1');
  assert.equal(harness.records[0].packets.length, 2);
  assert.match(harness.records[0].packets[1].text, /上一次尝试的问题/);
  assert.match(harness.records[0].packets[1].text, /JSON/);
});

withCleanup('AI choosing an occupied edge is rejected without changing the game', async (t) => {
  const harness = createHarness({ responses: ['{"edge":"h:0:0"}'] });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(MIXED);
  await waitFor(() => harness.coordinator.getSnapshot().runtime.phase === 'ready');
  await harness.coordinator.move('h:0:0');

  const failed = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.runtime.phase === 'error' ? current : null;
  }, { label: 'occupied edge error' });

  assert.equal(failed.game.moves.length, 1);
  assert.equal(failed.game.edges['h:0:0'], 0);
  assert.match(failed.runtime.message, /不可用的边/);

  await delay(30);
  assert.equal(harness.coordinator.getSnapshot().game.moves.length, 1);
  assert.equal(harness.records[0].packets.length, 1);
});

withCleanup('init restores without sending; resume is what sends to the AI', async (t) => {
  const players = ALL_AI.map((entry, slot) => ({
    slot,
    kind: 'ai',
    name: `AI${slot}`,
    color: GAME_COLORS[slot],
    seatId: `s${slot}`,
    nativeSessionRef: `saved-session-${slot}`,
  }));
  const stored = createGame({
    gameId: 'preloaded-game',
    players,
    createdAt: '2026-11-11T00:00:00.000Z',
  });
  const harness = createHarness({
    store: createMemoryStore(stored),
    responses: ['{"edge":"h:0:0"}'],
  });
  t.after(() => harness.coordinator.close());

  const restored = await harness.coordinator.init();
  assert.equal(restored.runtime.phase, 'idle');
  assert.match(restored.runtime.message, /继续/);
  assert.equal(restored.game.gameId, 'preloaded-game');
  assert.equal(harness.records.length, 0);
  assert.equal(harness.sessionCalls.length, 0);

  await delay(30);
  assert.equal(harness.coordinator.getSnapshot().game.moves.length, 0);

  const resumed = await harness.coordinator.resume();
  assert.equal(resumed.runtime.phase, 'preparing');

  const snapshot = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.game.moves.length === 1 ? current : null;
  }, { label: 'resumed AI move' });

  assert.equal(snapshot.game.moves[0].edge, 'h:0:0');
  assert.equal(harness.records.length, 4);
  assert.equal(harness.sessionCalls.length, 0);
  assert.equal(harness.records[0].packets.length, 1);
  assert.equal(harness.records[0].packets[0].roomId, 'game:preloaded-game');
});

withCleanup('a new game invalidates in-flight AI results from the old generation', async (t) => {
  const harness = createHarness({ auto: false });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(ALL_AI);
  await waitFor(() => harness.records.length === 4 && harness.records[0].packets.length === 1, {
    label: 'old AI request',
  });
  const oldRecord = harness.records[0];
  const oldAttemptId = oldRecord.packets[0].attemptId;

  const replacement = await harness.coordinator.newGame(HUMANS);
  assert.equal(replacement.runtime.phase, 'ready');
  assert.equal(replacement.game.moves.length, 0);
  assert.equal(replacement.game.players.every((player) => player.kind === 'human'), true);

  // 旧请求在换局之后才产生终态；它不能落入新局。
  oldRecord.bridge.completeAttempt(oldAttemptId, { text: '{"edge":"h:0:0"}' });
  await delay(50);

  const current = harness.coordinator.getSnapshot();
  assert.equal(current.game.moves.length, 0);
  assert.equal(current.game.gameId, replacement.game.gameId);
  assert.equal(current.runtime.phase, 'ready');
});

withCleanup('store write failure enters error instead of crashing', async (t) => {
  const failingStore = {
    async load() {
      return null;
    },
    async save() {
      throw new Error('disk full');
    },
  };
  const harness = createHarness({ store: failingStore });
  t.after(() => harness.coordinator.close());

  const created = await harness.coordinator.newGame(HUMANS);
  assert.equal(created.runtime.phase, 'error');
  assert.match(created.runtime.message, /disk full/);

  let failWrites = false;
  const store = {
    game: null,
    async load() {
      return this.game === null ? null : structuredClone(this.game);
    },
    async save(next) {
      if (failWrites) throw new Error('write blocked');
      this.game = structuredClone(next);
    },
  };
  const moveHarness = createHarness({ store });
  t.after(() => moveHarness.coordinator.close());
  await moveHarness.coordinator.newGame(HUMANS);
  failWrites = true;
  const failedMove = await moveHarness.coordinator.move('h:0:0');
  assert.equal(failedMove.runtime.phase, 'error');
  assert.match(failedMove.runtime.message, /write blocked/);
  assert.equal(failedMove.game.moves.length, 0);
});

withCleanup('chat seats are only used to create native sessions, never sent to', async (t) => {
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
    createNativeSession: (seatId) => chatBridge.createNativeSession(seatId),
  });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(MIXED);
  await waitFor(() => harness.coordinator.getSnapshot().runtime.phase === 'ready', {
    label: 'AI bridge preparation',
  });

  assert.deepEqual(createdSeatIds, ['s1', 's3']);
  assert.equal(chatSends, 0);
  assert.equal(harness.records.length, 2);
  assert.deepEqual(
    harness.records.map((record) => record.config.nativeSessionRef),
    ['chat-session-s1', 'chat-session-s3'],
  );
});

withCleanup('nativeSessionRef is persisted privately but stripped from snapshots', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airoom-dots-coordinator-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rooms', 'r_game_test', 'games', 'dots-and-boxes.json');
  const store = createGameStore(file);
  const harness = createHarness({ store });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(MIXED);
  const snapshot = await waitFor(() => {
    const current = harness.coordinator.getSnapshot();
    return current.runtime.phase === 'ready' ? current : null;
  }, { label: 'prepared mixed game' });

  assert.equal(
    Object.prototype.hasOwnProperty.call(snapshot.game.players[1], 'nativeSessionRef'),
    false,
  );
  assert.equal(JSON.stringify(snapshot).includes('nativeSessionRef'), false);

  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.game.players[1].nativeSessionRef, 'sess-s1-1');
  assert.equal(record.game.players[3].nativeSessionRef, 'sess-s3-2');
  assert.equal(record.game.players[0].nativeSessionRef, null);
});

withCleanup('close is idempotent and invalidates pending AI work', async (t) => {
  const harness = createHarness({ auto: false });
  t.after(() => harness.coordinator.close());

  await harness.coordinator.newGame(ALL_AI);
  await waitFor(() => harness.records[0]?.packets.length === 1, { label: 'pending AI request' });

  const first = harness.coordinator.close();
  const second = harness.coordinator.close();
  assert.equal(first, second);
  await first;

  await waitFor(() => harness.records[0].bridge.inspect().closed === true, {
    label: 'old game bridge closed',
  });
  assert.equal(harness.coordinator.getSnapshot().game.moves.length, 0);
  await assert.rejects(
    harness.coordinator.newGame(HUMANS),
    (error) => error?.code === 'COORDINATOR_CLOSED',
  );
  const unsubscribe = harness.coordinator.subscribe(() => {});
  assert.equal(typeof unsubscribe, 'function');
  unsubscribe();
});
