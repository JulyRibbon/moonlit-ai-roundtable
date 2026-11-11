import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GAME_TYPE,
  GAME_TYPES,
  buildBoardCells,
  canHumanMove,
  coordFor,
  findLegalAction,
  formatAction,
  gameLabel,
  gameOf,
  isMoveGame,
  isPlaceGame,
  legalActionsOf,
  moveAction,
  moveComment,
  normalizeGameType,
  winnerText,
} from '../../web/tabletop.mjs';

function players(names = ['机主', 'Kimi']) {
  return [
    { slot: 0, kind: 'human', name: names[0] },
    { slot: 1, kind: 'ai', name: names[1], seatId: 'kimi' },
  ];
}

function game(overrides = {}) {
  return {
    gameType: 'gomoku',
    players: players(),
    moves: [],
    currentPlayer: 0,
    status: 'playing',
    winners: [],
    scores: [0, 0],
    view: {
      rows: 2,
      columns: 2,
      cells: [
        { x: 0, y: 0, value: 0, owner: 0, label: '黑' },
        { x: 1, y: 0, value: 1, owner: 1, label: '白' },
        { x: 0, y: 1, value: null, owner: null, label: '' },
        { x: 1, y: 1, value: null, owner: null, label: '' },
      ],
    },
    legalActions: [
      { kind: 'place', x: 0, y: 1 },
      { kind: 'place', x: 1, y: 1 },
    ],
    ...overrides,
  };
}

function managerSnapshot(overrides = {}) {
  return {
    game: game(),
    runtime: { phase: 'ready', message: '' },
    ...overrides,
  };
}

/* ── 棋种 ───────────────────────────────────────────────────────────────── */

test('GAME_TYPES covers the five supported games and defaults to gomoku', () => {
  assert.deepEqual(GAME_TYPES, ['xiangqi', 'chess', 'go', 'gomoku', 'reversi']);
  assert.equal(DEFAULT_GAME_TYPE, 'gomoku');
  assert.equal(normalizeGameType('chess'), 'chess');
  assert.equal(normalizeGameType('nope'), 'gomoku');
  assert.equal(normalizeGameType(undefined), 'gomoku');
});

test('gameLabel returns Chinese labels and passes unknown types through', () => {
  assert.equal(gameLabel('xiangqi'), '中国象棋');
  assert.equal(gameLabel('chess'), '国际象棋');
  assert.equal(gameLabel('go'), '围棋');
  assert.equal(gameLabel('gomoku'), '五子棋');
  assert.equal(gameLabel('reversi'), '黑白棋');
  assert.equal(gameLabel('draughts'), 'draughts');
  assert.equal(gameLabel(''), '');
  assert.equal(gameLabel(null), '');
});

test('isMoveGame distinguishes move-pair games from place games', () => {
  assert.equal(isMoveGame('chess'), true);
  assert.equal(isMoveGame('xiangqi'), true);
  assert.equal(isMoveGame('go'), false);
  assert.equal(isPlaceGame('go'), true);
  assert.equal(isPlaceGame('gomoku'), true);
  assert.equal(isPlaceGame('reversi'), true);
  assert.equal(isPlaceGame('chess'), false);
});

/* ── 坐标 ───────────────────────────────────────────────────────────────── */

test('coordFor converts per game type', () => {
  assert.equal(coordFor('chess', 0, 0), 'a8');
  assert.equal(coordFor('chess', 4, 0), 'e8');
  assert.equal(coordFor('chess', 4, 6), 'e2');
  assert.equal(coordFor('chess', 7, 7), 'h1');
  assert.equal(coordFor('xiangqi', 0, 0), 'a0');
  assert.equal(coordFor('xiangqi', 4, 2), 'e2');
  assert.equal(coordFor('xiangqi', 8, 9), 'i9');
  assert.equal(coordFor('go', 3, 4), '3,4');
  assert.equal(coordFor('gomoku', 0, 0), '0,0');
  assert.equal(coordFor('reversi', 7, 7), '7,7');
});

test('coordFor rejects out-of-range and unknown input', () => {
  assert.equal(coordFor('chess', 8, 0), '');
  assert.equal(coordFor('chess', 0, 8), '');
  assert.equal(coordFor('xiangqi', 9, 0), '');
  assert.equal(coordFor('xiangqi', 0, 10), '');
  assert.equal(coordFor('chess', -1, 0), '');
  assert.equal(coordFor('chess', 1.5, 0), '');
  assert.equal(coordFor('draughts', 0, 0), '');
  assert.equal(coordFor('chess', 0, '1'), '');
});

/* ── 可下判定 ───────────────────────────────────────────────────────────── */

test('canHumanMove requires a playing game, human turn and ready runtime', () => {
  assert.equal(canHumanMove(managerSnapshot()), true);
  assert.equal(canHumanMove(game()), true);
  assert.equal(canHumanMove(managerSnapshot({ runtime: { phase: 'thinking' } })), false);
  assert.equal(canHumanMove(managerSnapshot({ runtime: { phase: 'preparing' } })), false);
  assert.equal(canHumanMove(managerSnapshot({ runtime: { phase: 'error' } })), false);
  assert.equal(canHumanMove(managerSnapshot({ runtime: { phase: 'idle' } })), false);
  assert.equal(canHumanMove(managerSnapshot({ runtime: { phase: 'ready' } })), true);
  assert.equal(canHumanMove(game({ currentPlayer: 1 })), false);
  assert.equal(canHumanMove(game({ status: 'finished' })), false);
  assert.equal(canHumanMove(null), false);
});

test('canHumanMove honours the optional expected game type', () => {
  assert.equal(canHumanMove(managerSnapshot(), 'gomoku'), true);
  assert.equal(canHumanMove(managerSnapshot(), 'chess'), false);
  assert.equal(canHumanMove(game({ gameType: 'chess' }), 'chess'), true);
});

test('canHumanMove resolves players by slot even when unordered', () => {
  const snapshot = managerSnapshot({
    game: game({
      players: [players()[1], players()[0]],
      currentPlayer: 0,
    }),
  });
  assert.equal(canHumanMove(snapshot), true);
});

/* ── 着法 ───────────────────────────────────────────────────────────────── */

test('formatAction renders moves, placements and passes', () => {
  assert.equal(formatAction('chess', { kind: 'move', from: 'e2', to: 'e4' }), 'e2→e4');
  assert.equal(formatAction('xiangqi', { kind: 'move', from: 'a0', to: 'a1' }), 'a0→a1');
  assert.equal(formatAction('go', { kind: 'place', x: 3, y: 4 }), '3,4');
  assert.equal(formatAction('gomoku', { kind: 'place', x: 0, y: 14 }), '0,14');
  assert.equal(formatAction('go', { kind: 'pass' }), '停一手');
  assert.equal(formatAction('chess', { kind: 'place', x: 1, y: 2 }), '1,2');
});

test('formatAction accepts raw move records and rejects malformed actions', () => {
  assert.equal(formatAction('chess', { from: 'd1', to: 'h5' }), 'd1→h5');
  assert.equal(formatAction('reversi', { action: { kind: 'place', x: 2, y: 3 } }), '2,3');
  assert.equal(formatAction('go', { kind: 'place', x: '3', y: 4 }), '');
  assert.equal(formatAction('chess', { kind: 'move', from: 'e2' }), '');
  assert.equal(formatAction('chess', null), '');
});

test('moveAction derives actions from persisted move records', () => {
  assert.deepEqual(moveAction({ action: { kind: 'place', x: 1, y: 2 } }), {
    kind: 'place', x: 1, y: 2,
  });
  assert.deepEqual(moveAction({ kind: 'place', x: 1, y: 2 }), {
    kind: 'place', x: 1, y: 2,
  });
  assert.deepEqual(moveAction({ kind: 'pass' }), { kind: 'pass' });
  assert.deepEqual(moveAction({ from: 'e2', to: 'e4' }), {
    kind: 'move', from: 'e2', to: 'e4',
  });
  assert.deepEqual(moveAction({ player: 0, x: 5, y: 6 }), {
    kind: 'place', x: 5, y: 6,
  });
  assert.equal(moveAction(null), null);
  assert.equal(moveAction({ player: 0 }), null);
});

test('moveComment trims, truncates and ignores non-string comments', () => {
  assert.equal(moveComment({ comment: '  抢占中路  ' }), '抢占中路');
  assert.equal(moveComment({ comment: 'x'.repeat(200) }).length, 160);
  assert.equal(moveComment({ comment: 'abcdef' }, 3), 'abc');
  assert.equal(moveComment({}), '');
  assert.equal(moveComment({ comment: 42 }), '');
  assert.equal(moveComment(null), '');
});

/* ── 胜负 ───────────────────────────────────────────────────────────────── */

test('winnerText reports the winner by name', () => {
  assert.equal(winnerText(game({ status: 'finished', winners: [1] })), 'Kimi 获胜');
  assert.equal(winnerText(game({ status: 'finished', winners: [0] })), '机主 获胜');
});

test('winnerText treats ties and empty winners as a draw', () => {
  assert.equal(winnerText(game({ status: 'finished', winners: [] })), '平局');
  assert.equal(winnerText(game({ status: 'finished', winners: [0, 1] })), '平局');
  assert.equal(winnerText(game({ status: 'playing', winners: [0] })), '');
  assert.equal(winnerText(null), '');
});

test('winnerText falls back to a seat label when the player has no name', () => {
  const unnamed = [
    { slot: 0, kind: 'human' },
    { slot: 1, kind: 'ai', seatId: 'kimi' },
  ];
  assert.equal(
    winnerText(game({ status: 'finished', winners: [1], players: unnamed })),
    '第 2 席 获胜',
  );
});

/* ── 棋盘格 ─────────────────────────────────────────────────────────────── */

test('buildBoardCells sorts cells and derives coordinates and symbols', () => {
  const cells = buildBoardCells(game());
  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map((cell) => [cell.x, cell.y]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  assert.deepEqual(cells.map((cell) => cell.coord), ['0,0', '1,0', '0,1', '1,1']);
  assert.deepEqual(cells.map((cell) => cell.symbol), ['●', '○', '', '']);
  assert.deepEqual(cells.map((cell) => cell.owner), [0, 1, null, null]);
  assert.deepEqual(cells.map((cell) => cell.empty), [false, false, true, true]);
});

test('buildBoardCells keeps Unicode chess labels and move coordinates', () => {
  const cells = buildBoardCells(game({
    gameType: 'chess',
    view: {
      rows: 1,
      columns: 2,
      cells: [
        { x: 0, y: 0, value: 'wK', owner: 0, label: '♔' },
        { x: 1, y: 0, value: 'bK', owner: 1, label: '♚' },
      ],
    },
  }));
  assert.deepEqual(cells.map((cell) => cell.coord), ['a8', 'b8']);
  assert.deepEqual(cells.map((cell) => cell.symbol), ['♔', '♚']);
});

test('buildBoardCells keeps Chinese xiangqi labels and owner colours', () => {
  const cells = buildBoardCells(game({
    gameType: 'xiangqi',
    view: {
      rows: 2,
      columns: 1,
      cells: [
        { x: 0, y: 0, value: 'rook', owner: 0, label: '车' },
        { x: 0, y: 1, value: null, owner: null, label: '' },
      ],
    },
  }));
  assert.deepEqual(cells.map((cell) => cell.coord), ['a0', 'a1']);
  assert.deepEqual(cells.map((cell) => cell.symbol), ['车', '']);
});

test('buildBoardCells shows territory owners without inventing stones in go', () => {
  const cells = buildBoardCells(game({
    gameType: 'go',
    view: {
      rows: 1,
      columns: 2,
      cells: [
        { x: 0, y: 0, value: 1, owner: 1, label: 'W' },
        { x: 1, y: 0, value: null, owner: 0, label: 'b' },
      ],
    },
  }));
  assert.deepEqual(cells.map((cell) => cell.symbol), ['○', '']);
  assert.deepEqual(cells.map((cell) => cell.owner), [1, 0]);
  assert.deepEqual(cells.map((cell) => cell.empty), [false, true]);
});

test('buildBoardCells expands an empty grid when cells are missing', () => {
  const cells = buildBoardCells(game({
    view: { rows: 2, columns: 3, cells: [] },
    legalActions: [],
  }));
  assert.equal(cells.length, 6);
  assert.deepEqual(cells.map((cell) => cell.coord), [
    '0,0', '1,0', '2,0', '0,1', '1,1', '2,1',
  ]);
  assert.ok(cells.every((cell) => cell.empty && cell.symbol === ''));
});

test('buildBoardCells drops invalid coordinates and tolerates missing views', () => {
  const cells = buildBoardCells(game({
    view: {
      rows: 2,
      columns: 2,
      cells: [
        { x: 0, y: 0, value: 0, owner: 0, label: '' },
        { x: 2, y: 0, value: 0, owner: 0, label: '' },
        { x: -1, y: 1, value: 0, owner: 0, label: '' },
        { x: 1, y: 1, value: null, owner: null, label: '' },
      ],
    },
  }));
  assert.deepEqual(cells.map((cell) => cell.coord), ['0,0', '1,1']);
  assert.deepEqual(buildBoardCells(null), []);
  assert.deepEqual(buildBoardCells({ gameType: 'chess' }), []);
});

/* ── 合法性辅助 ─────────────────────────────────────────────────────────── */

test('legalActionsOf returns only object actions', () => {
  const actions = legalActionsOf(game());
  assert.equal(actions.length, 2);
  assert.deepEqual(legalActionsOf(null), []);
  assert.deepEqual(legalActionsOf({ legalActions: null }), []);
  assert.deepEqual(legalActionsOf({ legalActions: [null, 1, { kind: 'pass' }] }), [
    { kind: 'pass' },
  ]);
});

test('findLegalAction matches moves, placements and passes', () => {
  const actions = [
    { kind: 'move', from: 'e2', to: 'e4' },
    { kind: 'place', x: 3, y: 4 },
    { kind: 'pass' },
  ];
  assert.deepEqual(findLegalAction(actions, { kind: 'move', from: 'e2', to: 'e4' }), actions[0]);
  assert.deepEqual(findLegalAction(actions, { kind: 'place', x: 3, y: 4 }), actions[1]);
  assert.deepEqual(findLegalAction(actions, { kind: 'pass' }), actions[2]);
  assert.equal(findLegalAction(actions, { kind: 'move', from: 'e2', to: 'e5' }), null);
  assert.equal(findLegalAction(actions, { kind: 'place', x: 4, y: 3 }), null);
  assert.equal(findLegalAction([], { kind: 'pass' }), null);
  assert.equal(findLegalAction(actions, null), null);
});

test('gameOf never mistakes an empty manager snapshot for an existing game', () => {
  assert.equal(gameOf({ gameType: 'chess', game: null, runtime: { phase: 'idle' } }), null);
  assert.equal(gameOf({ gameType: 'chess', game: undefined }), null);
  const bare = game();
  assert.equal(gameOf(bare), bare);
  assert.equal(gameOf({ game: bare }), bare);
});
