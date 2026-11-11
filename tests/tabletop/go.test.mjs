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
} from '../../games/tabletop/go.mjs';

function expectRuleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GameRuleError, `expected GameRuleError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

function positionWith(stones, overrides = {}) {
  const position = createPosition();
  for (const [x, y, value] of stones) {
    position.board[y][x] = value;
  }
  return { ...position, ...overrides };
}

function play(position, x, y) {
  return applyTurn(position, {
    player: position.currentPlayer,
    action: { kind: 'place', x, y },
  });
}

function pass(position) {
  return applyTurn(position, {
    player: position.currentPlayer,
    action: { kind: 'pass' },
  });
}

test('createPosition: 9x9 empty board, black to play, no komi scores', () => {
  const position = createPosition();
  assert.equal(GAME_TYPE, 'go');
  assert.equal(BOARD_SIZE, 9);
  assert.equal(position.schemaVersion, 1);
  assert.equal(position.gameType, 'go');
  assert.equal(position.boardSize, 9);
  assert.equal(position.board.length, 9);
  assert.ok(position.board.every((row) => row.length === 9 && row.every((cell) => cell === null)));
  assert.equal(position.currentPlayer, BLACK);
  assert.equal(position.status, 'playing');
  assert.deepEqual(position.winners, []);
  assert.deepEqual(position.scores, [0, 0]);
  assert.equal(position.passCount, 0);
  assert.equal(position.previousBoard, null);
  assert.deepEqual(position.moves, []);
});

test('normalizeAction: accepts place and pass, rejects malformed input', () => {
  assert.deepEqual(normalizeAction({ kind: 'place', x: 0, y: 8 }), { kind: 'place', x: 0, y: 8 });
  assert.deepEqual(normalizeAction({ kind: 'pass', x: 3, y: 3 }), { kind: 'pass' });

  for (const input of [
    null,
    undefined,
    'pass',
    [],
    {},
    { kind: 'move', x: 1, y: 1 },
    { kind: 'place' },
    { kind: 'place', x: 1.5, y: 1 },
    { kind: 'place', x: '1', y: 1 },
    { kind: 'place', x: -1, y: 0 },
    { kind: 'place', x: 9, y: 0 },
    { kind: 'place', x: 0, y: 9 },
  ]) {
    expectRuleError(() => normalizeAction(input), 'ACTION_INVALID');
  }
});

test('placement alternates turns and records moves', () => {
  let position = createPosition();
  position = play(position, 4, 4);
  assert.equal(position.board[4][4], BLACK);
  assert.equal(position.currentPlayer, WHITE);
  assert.equal(position.passCount, 0);
  assert.deepEqual(position.moves[0], {
    seq: 1,
    player: BLACK,
    kind: 'place',
    x: 4,
    y: 4,
    captures: 0,
  });

  position = play(position, 3, 3);
  assert.equal(position.board[3][3], WHITE);
  assert.equal(position.currentPlayer, BLACK);
  assert.equal(position.moves.length, 2);
});

test('occupied points are rejected', () => {
  const position = positionWith([[0, 0, BLACK]]);
  expectRuleError(
    () => applyTurn(position, { player: BLACK, action: { kind: 'place', x: 0, y: 0 } }),
    'POINT_OCCUPIED',
  );
  const actions = listLegalActions(position);
  assert.ok(!actions.some((action) => action.kind === 'place' && action.x === 0 && action.y === 0));
});

test('liberties: a stone survives until its last liberty is filled, then is captured', () => {
  let position = positionWith([[4, 4, BLACK]]);
  assert.equal(position.currentPlayer, BLACK);

  position = pass(position); // black
  position = play(position, 3, 4); // white
  position = pass(position); // black
  position = play(position, 5, 4); // white
  position = pass(position); // black
  position = play(position, 4, 3); // white

  assert.equal(position.board[4][4], BLACK, 'black stone still has one liberty');
  assert.equal(position.moves.at(-1).captures, 0);

  position = pass(position); // black
  position = play(position, 4, 5); // white fills the last liberty

  assert.equal(position.board[4][4], null, 'black stone was captured');
  assert.equal(position.moves.at(-1).captures, 1);
  assert.equal(position.passCount, 0, 'a placement resets the pass count');
});

test('capture removes a multi-stone group', () => {
  let position = positionWith(
    [
      [0, 0, WHITE],
      [1, 0, WHITE],
      [0, 1, BLACK],
      [1, 1, BLACK],
    ],
    { currentPlayer: BLACK },
  );
  position = play(position, 2, 0);

  assert.equal(position.board[0][0], null);
  assert.equal(position.board[0][1], null);
  assert.equal(position.board[0][2], BLACK);
  assert.equal(position.moves.at(-1).captures, 2);
});

test('suicide is forbidden and offered as no legal action', () => {
  const position = positionWith(
    [
      [0, 1, WHITE],
      [1, 0, WHITE],
    ],
    { currentPlayer: BLACK },
  );

  expectRuleError(
    () => applyTurn(position, { player: BLACK, action: { kind: 'place', x: 0, y: 0 } }),
    'SUICIDE',
  );
  const actions = listLegalActions(position);
  assert.ok(!actions.some((action) => action.kind === 'place' && action.x === 0 && action.y === 0));
  assert.deepEqual(actions.at(-1), { kind: 'pass' });
});

test('simple ko: recapturing the previous position is forbidden', () => {
  const original = positionWith(
    [
      [1, 0, BLACK],
      [0, 1, BLACK],
      [2, 0, WHITE],
      [1, 1, WHITE],
    ],
    { currentPlayer: WHITE },
  );

  const captured = play(original, 0, 0);
  assert.equal(captured.board[0][1], null, 'white captured the black stone');
  assert.equal(captured.moves.at(-1).captures, 1);
  assert.equal(captured.previousBoard, original.board.flat().map((v) => (v === null ? '.' : v)).join(''));

  const actions = listLegalActions(captured);
  assert.ok(
    !actions.some((action) => action.kind === 'place' && action.x === 1 && action.y === 0),
    'immediate recapture must not be listed',
  );
  assert.ok(actions.some((action) => action.kind === 'place' && action.x === 2 && action.y === 2));

  expectRuleError(
    () => applyTurn(captured, { player: BLACK, action: { kind: 'place', x: 1, y: 0 } }),
    'KO',
  );

  const afterPass = pass(captured);
  assert.ok(
    listLegalActions(afterPass).some(
      (action) => action.kind === 'place' && action.x === 1 && action.y === 0,
    ),
    'ko is lifted after a pass',
  );
});

test('two consecutive passes finish the game with empty board as a draw', () => {
  let position = createPosition();
  position = pass(position);
  assert.equal(position.status, 'playing');
  assert.equal(position.passCount, 1);
  assert.equal(position.currentPlayer, WHITE);

  position = pass(position);
  assert.equal(position.status, 'finished');
  assert.equal(position.passCount, 2);
  assert.deepEqual(position.scores, [0, 0]);
  assert.deepEqual(position.winners, [BLACK, WHITE]);
  assert.deepEqual(listLegalActions(position), []);
  assert.match(positionToText(position), /draw/);
});

test('scoring counts stones plus territory surrounded by one color', () => {
  const position = positionWith(
    [
      [2, 0, BLACK],
      [2, 1, BLACK],
      [2, 2, BLACK],
      [0, 2, BLACK],
      [1, 2, BLACK],
      [8, 8, WHITE],
    ],
    { currentPlayer: WHITE, passCount: 1 },
  );

  const finished = pass(position);
  assert.equal(finished.status, 'finished');
  assert.deepEqual(finished.scores, [9, 1]); // black: 5 stones + 4 territory; white: 1 stone
  assert.deepEqual(finished.winners, [BLACK]);
  assert.match(positionToText(finished), /Black 9, White 1/);
  assert.match(positionToText(finished), /Black wins/);
});

test('listLegalActions starts with 81 placements plus pass and has no duplicates', () => {
  const position = createPosition();
  const actions = listLegalActions(position);
  assert.equal(actions.length, 82);
  assert.deepEqual(actions[0], { kind: 'place', x: 0, y: 0 });
  assert.deepEqual(actions.at(-1), { kind: 'pass' });

  const keys = new Set(actions.map((action) => `${action.kind}:${action.x}:${action.y}`));
  assert.equal(keys.size, 82);

  for (const action of actions) {
    if (action.kind !== 'place') continue;
    assert.ok(Number.isInteger(action.x) && action.x >= 0 && action.x < 9);
    assert.ok(Number.isInteger(action.y) && action.y >= 0 && action.y < 9);
  }
});

test('turn, player, finished and malformed position errors', () => {
  const position = createPosition();
  expectRuleError(
    () => applyTurn(position, { player: WHITE, action: { kind: 'pass' } }),
    'GAME_NOT_YOUR_TURN',
  );
  expectRuleError(
    () => applyTurn(position, { player: 2, action: { kind: 'pass' } }),
    'PLAYER_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: BLACK, action: { kind: 'place', x: 9, y: 0 } }),
    'ACTION_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: BLACK }),
    'ACTION_INVALID',
  );

  const finished = pass(pass(createPosition()));
  expectRuleError(
    () => applyTurn(finished, { player: BLACK, action: { kind: 'pass' } }),
    'GAME_FINISHED',
  );

  const malformed = createPosition();
  malformed.board[0] = malformed.board[0].slice(0, 8);
  expectRuleError(() => applyTurn(malformed, { player: BLACK, action: { kind: 'pass' } }), 'POSITION_INVALID');
  expectRuleError(() => listLegalActions(null), 'POSITION_INVALID');
});

test('applyTurn is immutable and positions survive JSON round-trips', () => {
  const position = createPosition();
  const snapshot = JSON.stringify(position);

  const first = play(position, 4, 4);
  assert.equal(JSON.stringify(position), snapshot, 'input position must not change');
  assert.notEqual(first.board, position.board);
  assert.notEqual(first.board[4], position.board[4]);
  assert.deepEqual(first.moves, [
    { seq: 1, player: BLACK, kind: 'place', x: 4, y: 4, captures: 0 },
  ]);

  const second = pass(first);
  const restored = JSON.parse(JSON.stringify(second));
  assert.deepEqual(restored, second);
  assert.deepEqual(getBoardView(restored), getBoardView(second));
  assert.deepEqual(listLegalActions(restored), listLegalActions(second));

  const fromMemory = play(second, 3, 3);
  const fromJson = play(restored, 3, 3);
  assert.deepEqual(fromJson, fromMemory);
});

test('getBoardView exposes 81 cells with stones, owners and labels', () => {
  const position = positionWith(
    [
      [2, 0, BLACK],
      [2, 1, BLACK],
      [2, 2, BLACK],
      [0, 2, BLACK],
      [1, 2, BLACK],
      [8, 8, WHITE],
    ],
    { currentPlayer: WHITE, passCount: 1 },
  );
  const finished = pass(position);
  const view = getBoardView(finished);

  assert.equal(view.rows, 9);
  assert.equal(view.columns, 9);
  assert.equal(view.cells.length, 81);
  assert.ok(view.cells.every((cell) => (
    Number.isInteger(cell.x) && Number.isInteger(cell.y)
    && Object.prototype.hasOwnProperty.call(cell, 'value')
    && Object.prototype.hasOwnProperty.call(cell, 'owner')
    && typeof cell.label === 'string'
  )));

  const stoneCell = view.cells.find((cell) => cell.x === 2 && cell.y === 0);
  assert.deepEqual(stoneCell, { x: 2, y: 0, value: BLACK, owner: BLACK, label: 'B' });

  const territoryCell = view.cells.find((cell) => cell.x === 0 && cell.y === 0);
  assert.deepEqual(territoryCell, { x: 0, y: 0, value: null, owner: BLACK, label: 'b' });

  const neutralCell = view.cells.find((cell) => cell.x === 4 && cell.y === 4);
  assert.deepEqual(neutralCell, { x: 4, y: 4, value: null, owner: null, label: '.' });
});

test('positionToText renders a complete coordinate board and status', () => {
  const position = positionWith(
    [
      [0, 0, BLACK],
      [8, 8, WHITE],
    ],
    { currentPlayer: WHITE },
  );
  const text = positionToText(position);
  const lines = text.split('\n');

  assert.equal(lines[0], '   A B C D E F G H J');
  assert.equal(lines.at(-3), '   A B C D E F G H J');
  const boardLines = lines.filter((line) => /^[1-9] /.test(line));
  assert.equal(boardLines.length, 9);
  assert.equal(boardLines[0].split(/\s+/).filter(Boolean).length, 10); // row number + 9 columns
  assert.equal(boardLines.at(-1).slice(0, 1), '1');

  assert.match(text, /White to play/);
  assert.match(text, /no komi/);
  assert.ok(boardLines[0].trimEnd().endsWith('W'), 'row 9 shows the white stone');
  assert.ok(boardLines.at(-1).startsWith('1  B'), 'row 1 shows the black stone');

  assert.ok(lines[0].indexOf('I') === -1, 'column I is skipped in go coordinates');
});
