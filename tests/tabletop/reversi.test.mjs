import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BLACK,
  BOARD_SIZE,
  GAME_TYPE,
  GameRuleError,
  WHITE,
  applyTurn,
  createPosition,
  getBoardView,
  listLegalActions,
  normalizeAction,
  positionToText,
} from '../../games/tabletop/reversi.mjs';

function expectRuleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GameRuleError, `expected GameRuleError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function positionFrom({ black = [], white = [], currentPlayer = BLACK } = {}) {
  const position = createPosition();
  position.board = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  for (const [x, y] of black) position.board[y][x] = BLACK;
  for (const [x, y] of white) position.board[y][x] = WHITE;
  position.currentPlayer = currentPlayer;
  position.status = 'playing';
  position.winners = [];
  position.scores = [black.length, white.length];
  position.revision = 0;
  position.moves = [];
  return position;
}

function actionName({ x, y }) {
  return `${String.fromCharCode(97 + x)}${BOARD_SIZE - y}`;
}

function action(x, y, player = BLACK) {
  return { player, action: { kind: 'place', x, y } };
}

test('GAME_TYPE and createPosition produce the standard opening', () => {
  const position = createPosition();
  assert.equal(GAME_TYPE, 'reversi');
  assert.equal(position.gameType, GAME_TYPE);
  assert.equal(position.board.length, 8);
  assert.ok(position.board.every((row) => row.length === 8));
  assert.equal(position.board[3][3], BLACK);
  assert.equal(position.board[4][4], BLACK);
  assert.equal(position.board[3][4], WHITE);
  assert.equal(position.board[4][3], WHITE);
  assert.equal(position.currentPlayer, BLACK);
  assert.equal(position.status, 'playing');
  assert.deepEqual(position.scores, [2, 2]);
  assert.deepEqual(position.winners, []);
  assert.equal(position.revision, 0);
  assert.equal(position.board.flat().filter((value) => value === null).length, 60);
});

test('standard opening has exactly the four black legal placements', () => {
  const position = createPosition();
  const legal = listLegalActions(position);
  assert.deepEqual(legal, [
    { kind: 'place', x: 4, y: 2 },
    { kind: 'place', x: 5, y: 3 },
    { kind: 'place', x: 2, y: 4 },
    { kind: 'place', x: 3, y: 5 },
  ]);
  assert.deepEqual(legal.map(actionName).sort(), ['c4', 'd3', 'e6', 'f5']);
});

test('normalizeAction accepts integer placements and rejects everything else', () => {
  assert.deepEqual(normalizeAction({ kind: 'place', x: 0, y: 0 }), { kind: 'place', x: 0, y: 0 });
  assert.deepEqual(normalizeAction({ kind: 'place', x: 7, y: 7 }), { kind: 'place', x: 7, y: 7 });

  const invalid = [
    [null, 'ACTION_INVALID'],
    [undefined, 'ACTION_INVALID'],
    ['d3', 'ACTION_INVALID'],
    [[3, 2], 'ACTION_INVALID'],
    [{ kind: 'pass' }, 'ACTION_INVALID'],
    [{ kind: 'place', x: -1, y: 0 }, 'COORDINATE_INVALID'],
    [{ kind: 'place', x: 8, y: 0 }, 'COORDINATE_INVALID'],
    [{ kind: 'place', x: 0, y: 8 }, 'COORDINATE_INVALID'],
    [{ kind: 'place', x: 1.5, y: 0 }, 'COORDINATE_INVALID'],
    [{ kind: 'place', x: '1', y: 0 }, 'COORDINATE_INVALID'],
    [{ kind: 'place', x: 1, y: null }, 'COORDINATE_INVALID'],
  ];
  for (const [input, code] of invalid) {
    expectRuleError(() => normalizeAction(input), code);
  }
});

test('applyTurn places a disc, flips a line and hands the turn over', () => {
  const position = createPosition();
  const before = structuredClone(position);
  const next = applyTurn(position, action(3, 5));

  assert.deepEqual(position, before);
  assert.notEqual(next, position);
  assert.notEqual(next.board, position.board);
  assert.equal(next.board[5][3], BLACK);
  assert.equal(next.board[4][3], BLACK);
  assert.equal(next.board[3][4], WHITE);
  assert.deepEqual(next.scores, [4, 1]);
  assert.equal(next.currentPlayer, WHITE);
  assert.equal(next.status, 'playing');
  assert.equal(next.revision, 1);
  assert.deepEqual(next.moves[0], {
    seq: 1,
    player: BLACK,
    action: { kind: 'place', x: 3, y: 5 },
    flips: [{ x: 3, y: 4 }],
    passed: [],
  });
  assert.deepEqual(listLegalActions(next), [
    { kind: 'place', x: 2, y: 3 },
    { kind: 'place', x: 2, y: 5 },
    { kind: 'place', x: 4, y: 5 },
  ]);
});

test('one placement flips in all eight directions', () => {
  const black = [[5, 3], [1, 3], [3, 5], [3, 1], [5, 5], [5, 1], [1, 1], [1, 5]];
  const white = [[4, 3], [2, 3], [3, 4], [3, 2], [4, 4], [4, 2], [2, 2], [2, 4]];
  const position = positionFrom({ black, white });
  const next = applyTurn(position, action(3, 3));

  assert.equal(next.moves[0].flips.length, 8);
  assert.deepEqual(
    next.moves[0].flips.map(({ x, y }) => `${x},${y}`).sort(),
    white.map(([x, y]) => `${x},${y}`).sort(),
  );
  assert.deepEqual(next.scores, [17, 0]);
  assert.equal(next.board.flat().filter((value) => value === WHITE).length, 0);
  assert.equal(next.status, 'finished');
  assert.deepEqual(next.winners, [BLACK]);
});

test('a player with no legal placement is skipped automatically', () => {
  const position = positionFrom({
    black: [[0, 0], [0, 7]],
    white: [[1, 0], [2, 0], [1, 7], [2, 7]],
  });
  assert.deepEqual(listLegalActions(position), [
    { kind: 'place', x: 3, y: 0 },
    { kind: 'place', x: 3, y: 7 },
  ]);

  const next = applyTurn(position, action(3, 0));
  assert.equal(next.board[0][1], BLACK);
  assert.equal(next.board[0][2], BLACK);
  assert.deepEqual(next.scores, [5, 2]);
  assert.equal(next.currentPlayer, BLACK);
  assert.equal(next.status, 'playing');
  assert.deepEqual(next.moves[0].passed, [WHITE]);
  assert.deepEqual(listLegalActions(next), [{ kind: 'place', x: 3, y: 7 }]);
});

test('a full board finishes the game and counts the discs', () => {
  const black = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if ((x === 6 || x === 7) && y === 7) continue;
      black.push([x, y]);
    }
  }
  const position = positionFrom({ black, white: [[6, 7]] });
  const next = applyTurn(position, action(7, 7));

  assert.equal(next.board.flat().every((value) => value === BLACK), true);
  assert.deepEqual(next.scores, [64, 0]);
  assert.equal(next.status, 'finished');
  assert.deepEqual(next.winners, [BLACK]);
  assert.deepEqual(listLegalActions(next), []);
  expectRuleError(() => applyTurn(next, action(0, 0)), 'GAME_FINISHED');
});

test('when both players are stuck the game ends without filling the board', () => {
  const position = positionFrom({
    black: [[0, 0]],
    white: [[1, 0], [2, 0]],
  });
  const next = applyTurn(position, action(3, 0));

  assert.deepEqual(next.moves[0].flips, [{ x: 2, y: 0 }, { x: 1, y: 0 }]);
  assert.deepEqual(next.scores, [4, 0]);
  assert.equal(next.status, 'finished');
  assert.deepEqual(next.winners, [BLACK]);
  assert.equal(next.board.flat().filter((value) => value === null).length, 60);
});

test('a 32-32 finish is a draw for both players', () => {
  const black = [[2, 0], [0, 1], [1, 1]];
  const white = [[1, 0]];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (x === 0 && y === 0) continue;
      if (black.some(([bx, by]) => bx === x && by === y)) continue;
      if (white.some(([wx, wy]) => wx === x && wy === y)) continue;
      if (white.length < 33) white.push([x, y]);
      else black.push([x, y]);
    }
  }
  assert.equal(black.length, 30);
  assert.equal(white.length, 33);

  const next = applyTurn(positionFrom({ black, white }), action(0, 0));
  assert.deepEqual(next.moves[0].flips, [{ x: 1, y: 0 }]);
  assert.deepEqual(next.scores, [32, 32]);
  assert.equal(next.status, 'finished');
  assert.deepEqual(next.winners, [BLACK, WHITE]);
  assert.deepEqual(listLegalActions(next), []);
});

test('applyTurn rejects malformed states, wrong turns and illegal placements', () => {
  const position = createPosition();
  expectRuleError(() => applyTurn(position, action(3, 5, WHITE)), 'GAME_NOT_YOUR_TURN');
  expectRuleError(() => applyTurn(position, action(3, 5, 2)), 'PLAYER_INVALID');
  expectRuleError(() => applyTurn(position, { player: BLACK }), 'ACTION_INVALID');
  expectRuleError(() => applyTurn(position, action(3, 3)), 'POSITION_OCCUPIED');
  expectRuleError(() => applyTurn(position, action(0, 0)), 'ILLEGAL_MOVE');
  expectRuleError(() => applyTurn(null, action(3, 5)), 'POSITION_INVALID');
  expectRuleError(() => applyTurn([], action(3, 5)), 'POSITION_INVALID');
  expectRuleError(
    () => applyTurn({ ...position, board: position.board.slice(0, 7) }, action(3, 5)),
    'POSITION_INVALID',
  );
  expectRuleError(
    () => applyTurn({ ...position, currentPlayer: 2 }, action(3, 5)),
    'POSITION_INVALID',
  );
  expectRuleError(
    () => applyTurn({ ...position, status: 'paused' }, action(3, 5)),
    'POSITION_INVALID',
  );
  expectRuleError(
    () => applyTurn({ ...position, scores: [2] }, action(3, 5)),
    'POSITION_INVALID',
  );
  expectRuleError(
    () => applyTurn({ ...position, moves: 'nope' }, action(3, 5)),
    'POSITION_INVALID',
  );
});

test('legal actions always belong to the current player only', () => {
  let position = createPosition();
  position = applyTurn(position, action(3, 5));
  assert.equal(position.currentPlayer, WHITE);

  const whiteActions = listLegalActions(position);
  assert.ok(whiteActions.length > 0);
  for (const candidate of whiteActions) {
    const next = applyTurn(position, { player: WHITE, action: candidate });
    assert.ok(next.moves[0].flips.length > 0);
  }
  expectRuleError(
    () => applyTurn(position, { player: BLACK, action: whiteActions[0] }),
    'GAME_NOT_YOUR_TURN',
  );
});

test('positions are immutable and survive a JSON roundtrip', () => {
  let position = createPosition();
  const snapshot = structuredClone(position);
  for (let turn = 0; turn < 5; turn += 1) {
    const legal = listLegalActions(position);
    assert.ok(legal.length > 0);
    position = applyTurn(position, {
      player: position.currentPlayer,
      action: legal[0],
    });
    assert.deepEqual(snapshot, createPosition());
  }

  const clone = JSON.parse(JSON.stringify(position));
  assert.deepEqual(clone, position);
  const nextAction = listLegalActions(clone)[0];
  const fromClone = applyTurn(clone, { player: clone.currentPlayer, action: nextAction });
  const fromOriginal = applyTurn(position, { player: position.currentPlayer, action: nextAction });
  assert.deepEqual(fromClone, fromOriginal);
  assert.deepEqual(position, clone);
});

test('getBoardView exposes 64 labelled cells', () => {
  const view = getBoardView(createPosition());
  assert.equal(view.rows, 8);
  assert.equal(view.columns, 8);
  assert.equal(view.cells.length, 64);

  const at = (x, y) => view.cells.find((cell) => cell.x === x && cell.y === y);
  assert.deepEqual(at(4, 4), { x: 4, y: 4, value: BLACK, owner: BLACK, label: '●' });
  assert.deepEqual(at(3, 4), { x: 3, y: 4, value: WHITE, owner: WHITE, label: '○' });
  assert.deepEqual(at(0, 0), { x: 0, y: 0, value: null, owner: null, label: '.' });
  assert.equal(new Set(view.cells.map((cell) => `${cell.x},${cell.y}`)).size, 64);
  assert.equal(view.cells.filter((cell) => cell.value !== null).length, 4);
});

test('positionToText prints the complete coordinate board', () => {
  const text = positionToText(createPosition());
  const lines = text.split('\n');
  assert.equal(lines.length, 10);
  assert.equal(lines[0], '  a b c d e f g h');
  assert.equal(lines[9], '  a b c d e f g h');
  assert.equal(lines[1], '8 . . . . . . . .');
  assert.equal(lines[4], '5 . . . ● ○ . . .');
  assert.equal(lines[5], '4 . . . ○ ● . . .');
  assert.equal(lines[8], '1 . . . . . . . .');
  assert.ok(text.includes('5 . . . ● ○'));
});
