import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_SIZE,
  GAME_TYPE,
  GameRuleError,
  applyTurn,
  createPosition,
  getBoardView,
  listLegalActions,
  normalizeAction,
  positionToText,
} from '../../games/tabletop/gomoku.mjs';

function place(position, x, y) {
  return applyTurn(position, {
    player: position.currentPlayer,
    action: { kind: 'place', x, y },
  });
}

function playAll(moves) {
  let position = createPosition();
  for (const [x, y] of moves) {
    position = place(position, x, y);
  }
  return position;
}

function expectRuleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GameRuleError, `expected GameRuleError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function drawPosition() {
  const board = Array.from({ length: BOARD_SIZE }, (_, y) => (
    Array.from({ length: BOARD_SIZE }, (_, x) => (x + Math.floor(y / 2)) % 2)
  ));
  board[14][1] = null;
  return {
    schemaVersion: 1,
    gameType: GAME_TYPE,
    board,
    currentPlayer: 0,
    status: 'playing',
    winners: [],
    scores: [112, 112],
  };
}

test('createPosition: empty 15x15 board, black to move', () => {
  const position = createPosition();
  assert.equal(GAME_TYPE, 'gomoku');
  assert.equal(position.gameType, GAME_TYPE);
  assert.equal(position.board.length, 15);
  assert.ok(position.board.every((row) => row.length === 15 && row.every((cell) => cell === null)));
  assert.equal(position.currentPlayer, 0);
  assert.equal(position.status, 'playing');
  assert.deepEqual(position.winners, []);
  assert.deepEqual(position.scores, [0, 0]);
});

test('horizontal five wins', () => {
  const position = playAll([
    [0, 0], [0, 2],
    [1, 0], [1, 2],
    [2, 0], [2, 2],
    [3, 0], [3, 2],
    [4, 0],
  ]);
  assert.equal(position.status, 'finished');
  assert.deepEqual(position.winners, [0]);
  assert.deepEqual(position.scores, [5, 4]);
});

test('vertical five wins', () => {
  const position = playAll([
    [0, 0], [2, 0],
    [0, 1], [2, 1],
    [0, 2], [2, 2],
    [0, 3], [2, 3],
    [0, 4],
  ]);
  assert.equal(position.status, 'finished');
  assert.deepEqual(position.winners, [0]);
});

test('diagonal five wins', () => {
  const position = playAll([
    [0, 0], [0, 2],
    [1, 1], [0, 3],
    [2, 2], [0, 4],
    [3, 3], [0, 5],
    [4, 4],
  ]);
  assert.equal(position.status, 'finished');
  assert.deepEqual(position.winners, [0]);
});

test('anti-diagonal five wins', () => {
  const position = playAll([
    [4, 0], [0, 0],
    [3, 1], [0, 1],
    [2, 2], [0, 2],
    [1, 3], [0, 3],
    [0, 4],
  ]);
  assert.equal(position.status, 'finished');
  assert.deepEqual(position.winners, [0]);
});

test('overline (six in a row) also wins', () => {
  let position = playAll([
    [0, 0], [0, 14],
    [1, 0], [2, 14],
    [2, 0], [4, 14],
    [4, 0], [6, 14],
    [5, 0], [8, 14],
  ]);
  assert.equal(position.status, 'playing');
  assert.equal(position.currentPlayer, 0);

  position = place(position, 3, 0);
  assert.equal(position.status, 'finished');
  assert.deepEqual(position.winners, [0]);
  assert.deepEqual(position.scores, [6, 5]);
  for (let x = 0; x <= 5; x += 1) {
    assert.equal(position.board[0][x], 0);
  }
});

test('boundary: corner and last row/column are playable and can win', () => {
  let position = createPosition();
  position = place(position, 0, 0);
  assert.equal(position.board[0][0], 0);

  const finished = playAll([
    [0, 14], [0, 11],
    [1, 14], [1, 11],
    [2, 14], [2, 11],
    [3, 14], [3, 11],
    [4, 14],
  ]);
  assert.equal(finished.status, 'finished');
  assert.deepEqual(finished.winners, [0]);

  const rightEdge = playAll([
    [14, 0], [12, 0],
    [14, 1], [12, 1],
    [14, 2], [12, 2],
    [14, 3], [12, 3],
    [14, 4],
  ]);
  assert.equal(rightEdge.status, 'finished');
  assert.deepEqual(rightEdge.winners, [0]);

  expectRuleError(() => normalizeAction({ kind: 'place', x: 15, y: 0 }), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'place', x: 0, y: 15 }), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'place', x: -1, y: 0 }), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'place', x: 0, y: -1 }), 'ACTION_INVALID');
});

test('full board with no five is a draw', () => {
  const position = drawPosition();
  const legal = listLegalActions(position);
  assert.equal(legal.length, 1);
  assert.deepEqual(legal[0], { kind: 'place', x: 1, y: 14 });

  const finished = place(position, 1, 14);
  assert.equal(finished.status, 'finished');
  assert.deepEqual(finished.winners, []);
  assert.deepEqual(finished.scores, [113, 112]);
  assert.equal(finished.board.flat().filter((cell) => cell === null).length, 0);
  assert.deepEqual(listLegalActions(finished), []);
});

test('listLegalActions: all empty points, row-major, none after finish', () => {
  const position = createPosition();
  const legal = listLegalActions(position);
  assert.equal(legal.length, 225);
  assert.deepEqual(legal[0], { kind: 'place', x: 0, y: 0 });
  assert.deepEqual(legal[224], { kind: 'place', x: 14, y: 14 });

  const next = place(position, 7, 8);
  const remaining = listLegalActions(next);
  assert.equal(remaining.length, 224);
  assert.ok(!remaining.some((action) => action.x === 7 && action.y === 8));
  assert.ok(remaining.every((action) => action.kind === 'place'));
});

test('illegal input is rejected with rule errors', () => {
  expectRuleError(() => normalizeAction(null), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction([]), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({}), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'move', x: 0, y: 0 }), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'place', x: '0', y: 0 }), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'place', x: 0.5, y: 0 }), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'place', x: 0 }), 'ACTION_INVALID');

  const position = createPosition();
  expectRuleError(() => applyTurn(position, { player: 1, action: { kind: 'place', x: 0, y: 0 } }), 'GAME_NOT_YOUR_TURN');
  expectRuleError(() => applyTurn(position, { player: 2, action: { kind: 'place', x: 0, y: 0 } }), 'PLAYER_INVALID');
  expectRuleError(() => applyTurn(position, { player: '0', action: { kind: 'place', x: 0, y: 0 } }), 'PLAYER_INVALID');
  expectRuleError(() => applyTurn(position, { player: 0 }), 'ACTION_INVALID');
  expectRuleError(() => applyTurn(null, { player: 0, action: { kind: 'place', x: 0, y: 0 } }), 'POSITION_INVALID');
  expectRuleError(
    () => applyTurn({ ...position, board: position.board.slice(0, 14) }, { player: 0, action: { kind: 'place', x: 0, y: 0 } }),
    'POSITION_INVALID',
  );

  const occupied = place(position, 3, 3);
  const blackAgain = { ...occupied, currentPlayer: 0 };
  expectRuleError(
    () => applyTurn(blackAgain, { player: 0, action: { kind: 'place', x: 3, y: 3 } }),
    'CELL_OCCUPIED',
  );

  const finished = playAll([
    [0, 0], [0, 2],
    [1, 0], [1, 2],
    [2, 0], [2, 2],
    [3, 0], [3, 2],
    [4, 0],
  ]);
  expectRuleError(
    () => applyTurn(finished, { player: 1, action: { kind: 'place', x: 7, y: 7 } }),
    'GAME_FINISHED',
  );
});

test('applyTurn does not mutate the input position', () => {
  const position = createPosition();
  const snapshot = JSON.stringify(position);
  const next = place(position, 6, 7);

  assert.equal(JSON.stringify(position), snapshot);
  assert.notEqual(next.board, position.board);
  assert.notEqual(next.board[7], position.board[7]);
  assert.equal(position.board[7][6], null);
  assert.equal(next.board[7][6], 0);
  assert.equal(next.currentPlayer, 1);
  assert.deepEqual(next.scores, [1, 0]);
  assert.equal(position.scores[0], 0);
});

test('position survives JSON round-trip and continues identically', () => {
  let position = playAll([
    [7, 7], [8, 8],
    [7, 8], [8, 7],
    [6, 7],
  ]);
  const restored = JSON.parse(JSON.stringify(position));
  assert.deepEqual(restored, position);

  const action = { kind: 'place', x: 9, y: 7 };
  const fromOriginal = applyTurn(position, { player: position.currentPlayer, action });
  const fromRestored = applyTurn(restored, { player: restored.currentPlayer, action });
  assert.deepEqual(fromRestored, fromOriginal);

  const view = getBoardView(fromRestored);
  assert.equal(view.rows, 15);
  assert.equal(view.columns, 15);
  assert.equal(view.cells.length, 225);
  assert.deepEqual(
    view.cells.find((cell) => cell.x === 9 && cell.y === 7),
    { x: 9, y: 7, value: 1, owner: 1, label: '白' },
  );
  assert.deepEqual(
    view.cells.find((cell) => cell.x === 0 && cell.y === 0),
    { x: 0, y: 0, value: null, owner: null, label: '' },
  );
});

test('positionToText renders full coordinates and stones', () => {
  const initial = positionToText(createPosition());
  const lines = initial.split('\n');
  assert.equal(lines.length, 16);
  for (let x = 0; x < 15; x += 1) {
    assert.ok(lines[0].includes(String(x).padStart(3)), `header should contain column ${x}`);
  }
  for (let y = 0; y < 15; y += 1) {
    assert.ok(lines[y + 1].startsWith(String(y).padStart(2) + ' '), `row ${y} should start with its index`);
  }
  assert.equal((initial.match(/\./g) ?? []).length, 225);

  const position = playAll([[0, 0], [14, 14]]);
  const text = positionToText(position);
  const rows = text.split('\n');
  assert.equal(rows.length, 16);
  assert.ok(rows[1].slice(3).trimStart().startsWith('X'));
  assert.ok(rows[15].trimEnd().endsWith('O'));
});
