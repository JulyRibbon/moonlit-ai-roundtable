import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_SIZE,
  PLAYER_COUNT,
  GameRuleError,
  applyMove,
  createGame,
  getBoxEdges,
  listAvailableEdges,
  listBoxes,
  listEdges,
} from '../../games/dots-and-boxes/rules.mjs';

const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231'];

function players() {
  return [
    { slot: 0, kind: 'human', name: '甲', color: COLORS[0], seatId: null, nativeSessionRef: null },
    { slot: 1, kind: 'ai', name: '乙', color: COLORS[1], seatId: 'seat-b', nativeSessionRef: 'sess-b' },
    { slot: 2, kind: 'human', name: '丙', color: COLORS[2], seatId: null, nativeSessionRef: null },
    { slot: 3, kind: 'ai', name: '丁', color: COLORS[3], seatId: 'seat-d', nativeSessionRef: 'sess-d' },
  ];
}

function newGame(overrides = {}) {
  return createGame({
    gameId: 'game-test',
    players: players(),
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  });
}

function play(game, edge) {
  return applyMove(game, {
    player: game.currentPlayer,
    edge,
    at: `2026-11-11T00:00:${String(game.revision + 1).padStart(2, '0')}.000Z`,
  });
}

function expectRuleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GameRuleError, `expected GameRuleError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('geometry: 40 edges, 16 boxes, stable ids', () => {
  const edges = listEdges();
  const boxes = listBoxes();
  assert.equal(BOARD_SIZE, 4);
  assert.equal(PLAYER_COUNT, 4);
  assert.equal(edges.length, 40);
  assert.equal(new Set(edges).size, 40);
  assert.equal(boxes.length, 16);
  assert.equal(new Set(boxes).size, 16);

  assert.ok(edges.includes('h:0:0'));
  assert.ok(edges.includes('h:3:4'));
  assert.ok(edges.includes('v:0:0'));
  assert.ok(edges.includes('v:4:3'));
  assert.ok(!edges.includes('h:4:0'));
  assert.ok(!edges.includes('v:0:4'));
  assert.ok(boxes.includes('b:0:0'));
  assert.ok(boxes.includes('b:3:3'));

  assert.deepEqual(getBoxEdges('b:0:0'), ['h:0:0', 'h:0:1', 'v:0:0', 'v:1:0']);
  assert.deepEqual(getBoxEdges('b:3:3'), ['h:3:3', 'h:3:4', 'v:3:3', 'v:4:3']);

  const memberships = new Map(edges.map((edge) => [edge, 0]));
  for (const boxId of boxes) {
    const boxEdges = getBoxEdges(boxId);
    assert.equal(new Set(boxEdges).size, 4);
    for (const edge of boxEdges) {
      assert.ok(memberships.has(edge), `${edge} from ${boxId} must exist`);
      memberships.set(edge, memberships.get(edge) + 1);
    }
  }
  for (const [edge, count] of memberships) {
    assert.ok(count === 1 || count === 2, `${edge} belongs to ${count} boxes`);
  }
  expectRuleError(() => getBoxEdges('b:4:0'), 'BOX_INVALID');
  expectRuleError(() => getBoxEdges('box:0:0'), 'BOX_INVALID');
});

test('createGame produces the documented public state', () => {
  const game = newGame();
  assert.equal(game.schemaVersion, 1);
  assert.equal(game.gameId, 'game-test');
  assert.equal(game.boardSize, 4);
  assert.equal(game.status, 'playing');
  assert.equal(game.currentPlayer, 0);
  assert.deepEqual(game.scores, [0, 0, 0, 0]);
  assert.deepEqual(game.edges, {});
  assert.deepEqual(game.boxes, {});
  assert.deepEqual(game.moves, []);
  assert.deepEqual(game.winners, []);
  assert.equal(game.createdAt, '2026-11-11T00:00:00.000Z');
  assert.equal(game.updatedAt, game.createdAt);
  assert.equal(game.revision, 0);
  assert.deepEqual(game.players, players());
});

test('createGame rejects invalid seating', () => {
  const cases = [
    { players: players().slice(0, 3) },
    { players: [...players(), { ...players()[0], slot: 4 }] },
    { players: players().map((player, index) => (index === 1 ? { ...player, slot: 2 } : player)) },
    {
      players: players().map((player, index) => (
        index === 3 ? { ...player, seatId: 'seat-b' } : player
      )),
    },
    {
      players: players().map((player, index) => (
        index === 1 ? { ...player, seatId: null } : player
      )),
    },
    {
      players: players().map((player, index) => (
        index === 0 ? { ...player, seatId: 'seat-a' } : player
      )),
    },
    {
      players: players().map((player, index) => (
        index === 0 ? { ...player, nativeSessionRef: 'sess-a' } : player
      )),
    },
    {
      players: players().map((player, index) => (
        index === 0 ? { ...player, kind: 'spectator' } : player
      )),
    },
    {
      players: players().map((player, index) => (
        index === 0 ? { ...player, color: 'red' } : player
      )),
    },
    {
      players: players().map((player, index) => (
        index === 0 ? { ...player, name: '' } : player
      )),
    },
  ];
  for (const overrides of cases) {
    expectRuleError(() => newGame(overrides), 'PLAYERS_INVALID');
  }
  expectRuleError(() => createGame({ gameId: '', players: players(), createdAt: 'x' }), 'GAME_ID_INVALID');
  expectRuleError(() => createGame({ gameId: 'g', players: players(), createdAt: '' }), 'TIMESTAMP_INVALID');
});

test('applyMove enforces turn, edge validity, occupancy and game status', () => {
  const game = newGame();
  expectRuleError(
    () => applyMove(game, { player: 1, edge: 'h:0:0', at: 't' }),
    'GAME_NOT_YOUR_TURN',
  );
  expectRuleError(
    () => applyMove(game, { player: 4, edge: 'h:0:0', at: 't' }),
    'PLAYER_INVALID',
  );
  for (const edge of ['h:4:0', 'h:0:5', 'v:0:4', 'v:5:0', 'b:0:0', 'x:0:0', '', 7]) {
    expectRuleError(
      () => applyMove(game, { player: 0, edge, at: 't' }),
      'EDGE_INVALID',
    );
  }

  const moved = applyMove(game, { player: 0, edge: 'h:0:0', at: 't1' });
  expectRuleError(
    () => applyMove(moved, { player: 1, edge: 'h:0:0', at: 't2' }),
    'EDGE_OCCUPIED',
  );

  const finished = {
    ...moved,
    status: 'finished',
    winners: [0],
    edges: Object.fromEntries(listEdges().map((edge) => [edge, 0])),
  };
  expectRuleError(
    () => applyMove(finished, { player: 1, edge: 'v:0:0', at: 't2' }),
    'GAME_FINISHED',
  );
});

test('fourth edge scores and keeps the turn', () => {
  let game = newGame();
  assert.equal(listAvailableEdges(game).length, 40);
  game = play(game, 'h:0:0');
  assert.equal(game.currentPlayer, 1);
  game = play(game, 'h:0:1');
  assert.equal(game.currentPlayer, 2);
  game = play(game, 'v:0:0');
  assert.equal(game.currentPlayer, 3);
  game = play(game, 'v:1:0');

  assert.deepEqual(game.scores, [0, 0, 0, 1]);
  assert.equal(game.boxes['b:0:0'], 3);
  assert.equal(game.currentPlayer, 3);
  assert.deepEqual(game.moves.at(-1).completedBoxes, ['b:0:0']);
  assert.equal(game.moves.length, 4);
  assert.deepEqual(game.moves.map((move) => move.seq), [1, 2, 3, 4]);
  assert.equal(game.revision, 4);
  assert.equal(game.status, 'playing');
  assert.deepEqual(game.winners, []);
  assert.equal(listAvailableEdges(game).length, 36);

  game = play(game, 'h:1:0');
  assert.equal(game.currentPlayer, 0);
  assert.equal(game.revision, 5);
  assert.equal(game.updatedAt, game.moves.at(-1).at);
});

test('one move can complete two boxes', () => {
  let game = newGame();
  for (const edge of ['h:0:0', 'v:0:0', 'v:1:0', 'v:0:1', 'v:1:1', 'h:0:2']) {
    game = play(game, edge);
  }
  assert.equal(game.currentPlayer, 2);
  game = play(game, 'h:0:1');

  assert.deepEqual(game.moves.at(-1).completedBoxes.sort(), ['b:0:0', 'b:0:1']);
  assert.deepEqual(game.scores, [0, 0, 2, 0]);
  assert.equal(game.currentPlayer, 2);
  assert.equal(game.boxes['b:0:0'], 2);
  assert.equal(game.boxes['b:0:1'], 2);
});

test('applyMove is immutable and revision/seq advance', () => {
  const game = newGame();
  const before = structuredClone(game);
  const next = play(game, 'h:0:0');
  assert.deepEqual(game, before);
  assert.notEqual(next, game);
  assert.notEqual(next.edges, game.edges);
  assert.equal(next.revision, 1);
  assert.equal(next.moves[0].seq, 1);
  assert.equal(next.edges['h:0:0'], 0);
  assert.equal(game.edges['h:0:0'], undefined);

  const second = play(next, 'v:0:0');
  assert.equal(second.revision, 2);
  assert.equal(second.moves[1].seq, 2);
  assert.equal(next.moves.length, 1);
  assert.deepEqual(second.moves.map((move) => move.edge), ['h:0:0', 'v:0:0']);
});

test('applyMove records a normalized public comment on every move', () => {
  const game = newGame();
  const withComment = applyMove(game, {
    player: 0,
    edge: 'h:0:0',
    at: 't1',
    comment: '  先手占边，观察对手  ',
  });
  assert.deepEqual(withComment.moves[0], {
    seq: 1,
    player: 0,
    edge: 'h:0:0',
    completedBoxes: [],
    at: 't1',
    comment: '先手占边，观察对手',
  });

  const legacy = play(game, 'h:0:0');
  assert.equal(legacy.moves[0].comment, '');
  assert.equal(Object.hasOwn(legacy.moves[0], 'comment'), true);

  const nonString = applyMove(game, { player: 0, edge: 'h:0:0', at: 't1', comment: 42 });
  assert.equal(nonString.moves[0].comment, '');
  const blank = applyMove(game, { player: 0, edge: 'h:0:0', at: 't1', comment: '   ' });
  assert.equal(blank.moves[0].comment, '');

  const long = '理'.repeat(300);
  const truncated = applyMove(game, { player: 0, edge: 'h:0:0', at: 't1', comment: long });
  assert.equal(truncated.moves[0].comment.length, 160);
  assert.equal(truncated.moves[0].comment, long.slice(0, 160));

  // 附言不改变轮转与计分。
  assert.equal(withComment.currentPlayer, legacy.currentPlayer);
  assert.deepEqual(withComment.scores, legacy.scores);
});

test('state survives a JSON roundtrip', () => {
  let game = newGame();
  for (const edge of ['h:0:0', 'v:0:0', 'v:1:0', 'h:0:1', 'v:0:1']) {
    game = play(game, edge);
  }
  const clone = JSON.parse(JSON.stringify(game));
  assert.deepEqual(clone, game);
  const fromClone = play(clone, 'v:1:1');
  const fromOriginal = play(game, 'v:1:1');
  assert.deepEqual(fromClone, fromOriginal);
  assert.deepEqual(fromClone.scores, [0, 0, 0, 1]);
});

test('a full canonical game finishes with 16 total points', () => {
  let game = newGame();
  for (const edge of listEdges()) {
    assert.equal(game.status, 'playing');
    game = play(game, edge);
  }
  assert.equal(game.status, 'finished');
  assert.equal(game.moves.length, 40);
  assert.equal(Object.keys(game.edges).length, 40);
  assert.equal(Object.keys(game.boxes).length, 16);
  assert.deepEqual(listAvailableEdges(game), []);
  const total = game.scores.reduce((sum, score) => sum + score, 0);
  assert.equal(total, 16);
  assert.ok(game.winners.length >= 1);
  const best = Math.max(...game.scores);
  assert.deepEqual(
    game.winners,
    game.scores.map((score, index) => (score === best ? index : -1)).filter((index) => index >= 0),
  );
  expectRuleError(
    () => applyMove(game, { player: game.currentPlayer, edge: 'h:0:0', at: 't' }),
    'GAME_FINISHED',
  );
});

test('seeded random games always consume 40 edges and 16 points', () => {
  for (let seed = 1; seed <= 20; seed += 1) {
    const random = lcg(seed);
    let game = newGame({ gameId: `random-${seed}` });
    while (game.status === 'playing') {
      const available = listAvailableEdges(game);
      const edge = available[Math.floor(random() * available.length)];
      game = play(game, edge);
    }
    assert.equal(game.moves.length, 40, `seed ${seed}`);
    assert.equal(Object.keys(game.boxes).length, 16, `seed ${seed}`);
    assert.equal(game.scores.reduce((sum, score) => sum + score, 0), 16, `seed ${seed}`);
    assert.ok(game.winners.length >= 1, `seed ${seed}`);
    assert.equal(new Set(game.moves.map((move) => move.seq)).size, 40, `seed ${seed}`);
  }
});

test('winners supports a tie for first place', () => {
  const base = newGame();
  const state = structuredClone(base);
  const allEdges = listEdges();
  for (const edge of allEdges) {
    if (edge !== 'h:3:4') state.edges[edge] = 0;
  }
  const allBoxes = listBoxes();
  allBoxes.forEach((boxId, index) => {
    if (boxId === 'b:3:3') return;
    state.boxes[boxId] = index < 8 ? 0 : 1;
  });
  state.scores = [8, 7, 0, 0];
  state.currentPlayer = 1;
  state.revision = 39;
  state.moves = allEdges.slice(0, 39).map((edge, index) => ({
    seq: index + 1,
    player: 0,
    edge,
    completedBoxes: [],
    at: 't',
  }));
  assert.equal(Object.keys(state.edges).length, 39);
  assert.deepEqual(listAvailableEdges(state), ['h:3:4']);

  const finished = applyMove(state, { player: 1, edge: 'h:3:4', at: 't-final' });
  assert.equal(finished.status, 'finished');
  assert.deepEqual(finished.scores, [8, 8, 0, 0]);
  assert.equal(finished.boxes['b:3:3'], 1);
  assert.deepEqual(finished.winners, [0, 1]);
  assert.equal(finished.currentPlayer, 1);
  assert.equal(finished.revision, 40);
  assert.equal(finished.moves.length, 40);
});
