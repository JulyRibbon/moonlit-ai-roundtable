import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GAME_TYPE,
  GameRuleError,
  applyTurn,
  createPosition,
  getBoardView,
  listLegalActions,
  normalizeAction,
  positionToText,
} from '../../games/tabletop/xiangqi.mjs';

function parse(coord) {
  return {
    x: coord.charCodeAt(0) - 97,
    y: Number(coord.slice(1)),
  };
}

function boardWith(pieces, currentPlayer = 0) {
  const position = createPosition();
  position.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const [coord, type, owner] of pieces) {
    const { x, y } = parse(coord);
    position.board[y][x] = { type, owner };
  }
  position.currentPlayer = currentPlayer;
  return position;
}

function move(from, to) {
  return { kind: 'move', from, to };
}

function actionsFrom(position, from) {
  return listLegalActions(position).filter((action) => action.from === from);
}

function destinations(position, from) {
  return actionsFrom(position, from).map((action) => action.to).sort();
}

function expectRuleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GameRuleError, `expected GameRuleError, got ${error?.name}`);
    if (code !== undefined) assert.equal(error.code, code);
    return true;
  });
}

function cellAt(view, x, y) {
  return view.cells.find((cell) => cell.x === x && cell.y === y);
}

test('createPosition builds the standard 32-piece layout and is JSON-safe', () => {
  const position = createPosition();
  assert.equal(GAME_TYPE, 'xiangqi');
  assert.equal(position.gameType, 'xiangqi');
  assert.equal(position.board.length, 10);
  for (const row of position.board) assert.equal(row.length, 9);

  const pieces = position.board.flat().filter((piece) => piece !== null);
  assert.equal(pieces.length, 32);
  assert.equal(pieces.filter((piece) => piece.owner === 0).length, 16);
  assert.equal(pieces.filter((piece) => piece.owner === 1).length, 16);

  assert.equal(position.currentPlayer, 0);
  assert.equal(position.status, 'playing');
  assert.deepEqual(position.winners, []);
  assert.deepEqual(position.scores, [0, 0]);
  assert.equal(position.revision, 0);
  assert.deepEqual(position.moves, []);

  const clone = JSON.parse(JSON.stringify(position));
  assert.deepEqual(clone, position);

  const view = getBoardView(position);
  assert.equal(view.rows, 10);
  assert.equal(view.columns, 9);
  assert.equal(view.cells.length, 90);
  assert.equal(view.cells.filter((cell) => cell.value !== null).length, 32);

  assert.deepEqual(cellAt(view, 0, 0), { x: 0, y: 0, value: 'rook', owner: 0, label: '车' });
  assert.deepEqual(cellAt(view, 4, 0), { x: 4, y: 0, value: 'general', owner: 0, label: '帅' });
  assert.deepEqual(cellAt(view, 1, 2), { x: 1, y: 2, value: 'cannon', owner: 0, label: '炮' });
  assert.deepEqual(cellAt(view, 0, 3), { x: 0, y: 3, value: 'pawn', owner: 0, label: '兵' });
  assert.deepEqual(cellAt(view, 4, 9), { x: 4, y: 9, value: 'general', owner: 1, label: '将' });
  assert.deepEqual(cellAt(view, 0, 6), { x: 0, y: 6, value: 'pawn', owner: 1, label: '卒' });
  assert.deepEqual(cellAt(view, 0, 4), { x: 0, y: 4, value: null, owner: null, label: '' });
});

test('initial legal actions cover every piece and are canonical', () => {
  const position = createPosition();
  const actions = listLegalActions(position);
  assert.equal(actions.length, 44);
  assert.equal(new Set(actions.map((action) => `${action.from}-${action.to}`)).size, 44);
  for (const action of actions) {
    assert.deepEqual(Object.keys(action).sort(), ['from', 'kind', 'to']);
    assert.equal(action.kind, 'move');
    assert.deepEqual(normalizeAction(action), action);
    const { x, y } = parse(action.from);
    assert.equal(position.board[y][x].owner, 0);
  }

  assert.ok(actions.some((action) => action.from === 'b2' && action.to === 'b9'));
  assert.ok(!actions.some((action) => action.from === 'b2' && action.to === 'b7'));
  assert.deepEqual(destinations(position, 'b0'), ['a2', 'c2']);

  const afterPawn = applyTurn(position, { player: 0, action: move('a3', 'a4') });
  assert.equal(listLegalActions(afterPawn).length, 44);
});

test('rook moves on straight lines and cannot jump pieces', () => {
  const blocked = boardWith([
    ['a0', 'rook', 0],
    ['a2', 'pawn', 0],
    ['b0', 'pawn', 0],
    ['a5', 'pawn', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.deepEqual(destinations(blocked, 'a0'), ['a1']);
  expectRuleError(
    () => applyTurn(blocked, { player: 0, action: move('a0', 'a5') }),
    'ILLEGAL_MOVE',
  );

  const open = boardWith([
    ['d4', 'rook', 0],
    ['a4', 'pawn', 1],
    ['g4', 'pawn', 0],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  const targets = destinations(open, 'd4');
  for (const target of ['a4', 'b4', 'c4', 'e4', 'f4', 'd1', 'd5', 'd9']) {
    assert.ok(targets.includes(target), `${target} should be reachable`);
  }
  assert.ok(!targets.includes('g4'));
  assert.ok(!targets.includes('h4'));
});

test('horse is blocked by its leg', () => {
  const initial = createPosition();
  assert.ok(destinations(initial, 'b0').includes('a2'));
  assert.ok(destinations(initial, 'b0').includes('c2'));
  assert.ok(!destinations(initial, 'b0').includes('d1'));

  const blocked = boardWith([
    ['e4', 'horse', 0],
    ['e5', 'pawn', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  const targets = destinations(blocked, 'e4');
  assert.ok(!targets.includes('d6'));
  assert.ok(!targets.includes('f6'));
  assert.ok(targets.includes('c5'));
  assert.ok(targets.includes('g5'));
  assert.ok(targets.includes('d2'));
  assert.ok(targets.includes('f2'));
});

test('elephant is blocked at its eye and cannot cross the river', () => {
  const initial = createPosition();
  assert.deepEqual(destinations(initial, 'c0'), ['a2', 'e2']);

  const blocked = boardWith([
    ['c0', 'elephant', 0],
    ['b1', 'pawn', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.deepEqual(destinations(blocked, 'c0'), ['e2']);

  const redSide = boardWith([
    ['e4', 'elephant', 0],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  const redTargets = destinations(redSide, 'e4');
  assert.ok(redTargets.includes('c2'));
  assert.ok(redTargets.includes('g2'));
  assert.ok(!redTargets.includes('c6'));
  assert.ok(!redTargets.includes('g6'));

  const blackSide = boardWith([
    ['e5', 'elephant', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ], 1);
  const blackTargets = destinations(blackSide, 'e5');
  assert.ok(blackTargets.includes('c7'));
  assert.ok(blackTargets.includes('g7'));
  assert.ok(!blackTargets.includes('c3'));
  assert.ok(!blackTargets.includes('g3'));
});

test('advisor and general stay inside the palace', () => {
  const position = boardWith([
    ['d0', 'advisor', 0],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
    ['d9', 'advisor', 1],
  ]);
  assert.deepEqual(destinations(position, 'd0'), ['e1']);
  assert.ok(!destinations(position, 'd0').includes('c1'));

  const redPalace = boardWith([
    ['e1', 'general', 0],
    ['e9', 'general', 1],
  ]);
  const redGeneral = destinations(redPalace, 'e1');
  for (const target of ['d1', 'f1', 'e0', 'e2']) {
    assert.ok(redGeneral.includes(target), `${target} should be inside the red palace`);
  }
  assert.ok(!redGeneral.includes('e3'));

  const edgeGeneral = boardWith([
    ['e2', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.ok(!destinations(edgeGeneral, 'e2').includes('e3'));
  expectRuleError(
    () => applyTurn(edgeGeneral, { player: 0, action: move('e2', 'e3') }),
    'ILLEGAL_MOVE',
  );

  const blackPosition = boardWith([
    ['e0', 'general', 0],
    ['e9', 'general', 1],
    ['d9', 'advisor', 1],
  ], 1);
  assert.deepEqual(destinations(blackPosition, 'd9'), ['e8']);

  const blackPalace = boardWith([
    ['e0', 'general', 0],
    ['e8', 'general', 1],
  ], 1);
  const blackGeneral = destinations(blackPalace, 'e8');
  for (const target of ['d8', 'f8', 'e7', 'e9']) {
    assert.ok(blackGeneral.includes(target), `${target} should be inside the black palace`);
  }
  assert.ok(!blackGeneral.includes('e6'));
});

test('cannon moves like a rook but captures over exactly one screen', () => {
  const initial = createPosition();
  const cannonTargets = destinations(initial, 'b2');
  for (const target of ['a2', 'c2', 'd2', 'e2', 'f2', 'g2', 'b1', 'b3', 'b4', 'b5', 'b6']) {
    assert.ok(cannonTargets.includes(target), `${target} should be a quiet cannon move`);
  }
  assert.ok(cannonTargets.includes('b9'));
  assert.ok(!cannonTargets.includes('b7'));
  assert.ok(!cannonTargets.includes('b8'));

  const oneScreen = boardWith([
    ['a0', 'cannon', 0],
    ['a3', 'pawn', 0],
    ['a6', 'rook', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  const withScreen = destinations(oneScreen, 'a0');
  assert.ok(withScreen.includes('a6'));
  assert.ok(withScreen.includes('a1'));
  assert.ok(withScreen.includes('a2'));
  assert.ok(!withScreen.includes('a4'));

  const twoScreens = boardWith([
    ['a0', 'cannon', 0],
    ['a3', 'pawn', 0],
    ['a4', 'pawn', 0],
    ['a6', 'rook', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.ok(!destinations(twoScreens, 'a0').includes('a6'));

  const noScreen = boardWith([
    ['a0', 'cannon', 0],
    ['a6', 'rook', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  const noScreenTargets = destinations(noScreen, 'a0');
  assert.ok(!noScreenTargets.includes('a6'));
  assert.ok(noScreenTargets.includes('a5'));
});

test('pawn moves forward before the river and sideways after it', () => {
  const redBefore = boardWith([
    ['a3', 'pawn', 0],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.deepEqual(destinations(redBefore, 'a3'), ['a4']);

  const redAfter = boardWith([
    ['a5', 'pawn', 0],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.deepEqual(destinations(redAfter, 'a5'), ['a6', 'b5']);

  const redLastRank = boardWith([
    ['a9', 'pawn', 0],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.deepEqual(destinations(redLastRank, 'a9'), ['b9']);

  const blackBefore = boardWith([
    ['a6', 'pawn', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ], 1);
  assert.deepEqual(destinations(blackBefore, 'a6'), ['a5']);

  const blackAfter = boardWith([
    ['a4', 'pawn', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ], 1);
  assert.deepEqual(destinations(blackAfter, 'a4'), ['a3', 'b4']);
});

test('flying general captures the opposing general and wins', () => {
  const facing = boardWith([
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  assert.ok(destinations(facing, 'e0').includes('e9'));

  const blocked = boardWith([
    ['e0', 'general', 0],
    ['e5', 'pawn', 0],
    ['e9', 'general', 1],
  ]);
  assert.ok(!destinations(blocked, 'e0').includes('e9'));

  const finished = applyTurn(facing, { player: 0, action: move('e0', 'e9') });
  assert.equal(finished.status, 'finished');
  assert.deepEqual(finished.winners, [0]);
  assert.deepEqual(finished.scores, [1, 0]);
  assert.equal(finished.currentPlayer, 0);
  assert.equal(finished.board[0][4], null);
  assert.deepEqual(finished.board[9][4], { type: 'general', owner: 0 });
  assert.deepEqual(finished.moves[0], {
    seq: 1,
    player: 0,
    piece: 'general',
    from: 'e0',
    to: 'e9',
    captured: 'general',
  });
  assert.deepEqual(listLegalActions(finished), []);
  expectRuleError(
    () => applyTurn(finished, { player: 0, action: move('e9', 'e8') }),
    'GAME_FINISHED',
  );
});

test('simplified rules allow exposing the generals to each other', () => {
  const position = boardWith([
    ['e0', 'general', 0],
    ['e5', 'pawn', 0],
    ['e9', 'general', 1],
  ]);
  const next = applyTurn(position, { player: 0, action: move('e5', 'd5') });
  assert.equal(next.status, 'playing');
  assert.equal(next.currentPlayer, 1);
  assert.ok(destinations(next, 'e9').includes('e0'));
});

test('capturing a non-general piece continues the game', () => {
  const position = boardWith([
    ['a0', 'rook', 0],
    ['a5', 'pawn', 1],
    ['e0', 'general', 0],
    ['e9', 'general', 1],
  ]);
  const next = applyTurn(position, { player: 0, action: move('a0', 'a5') });
  assert.equal(next.status, 'playing');
  assert.equal(next.currentPlayer, 1);
  assert.deepEqual(next.winners, []);
  assert.deepEqual(next.scores, [0, 0]);
  assert.equal(next.moves[0].captured, 'pawn');
  assert.equal(next.board[5][0].owner, 0);
});

test('any piece that captures the general wins the game', () => {
  const position = boardWith([
    ['a0', 'rook', 0],
    ['a9', 'general', 1],
    ['e0', 'general', 0],
  ]);
  assert.ok(destinations(position, 'a0').includes('a9'));
  const next = applyTurn(position, { player: 0, action: move('a0', 'a9') });
  assert.equal(next.status, 'finished');
  assert.deepEqual(next.winners, [0]);
  assert.deepEqual(next.scores, [1, 0]);
  assert.deepEqual(next.board[9][0], { type: 'rook', owner: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
});

test('normalizeAction validates and canonicalizes coordinates', () => {
  assert.deepEqual(normalizeAction({ kind: 'move', from: 'A0', to: 'I9' }), move('a0', 'i9'));
  assert.deepEqual(normalizeAction({ from: 'a0', to: 'a1' }), move('a0', 'a1'));

  for (const input of [null, undefined, 'a0-a1', [], 42]) {
    expectRuleError(() => normalizeAction(input), 'ACTION_INVALID');
  }
  expectRuleError(() => normalizeAction({ kind: 'drop', from: 'a0', to: 'a1' }), 'ACTION_INVALID');
  for (const input of [
    { kind: 'move', from: 'j0', to: 'a1' },
    { kind: 'move', from: 'a0', to: 'a10' },
    { kind: 'move', from: 'a-1', to: 'a1' },
    { kind: 'move', from: '', to: 'a1' },
    { kind: 'move', from: 'a0', to: 5 },
  ]) {
    expectRuleError(() => normalizeAction(input), 'COORDINATE_INVALID');
  }
});

test('applyTurn enforces turn, ownership, piece presence and legality', () => {
  const position = createPosition();
  expectRuleError(
    () => applyTurn(position, { player: 1, action: move('a6', 'a5') }),
    'NOT_YOUR_TURN',
  );
  expectRuleError(
    () => applyTurn(position, { player: 2, action: move('a3', 'a4') }),
    'PLAYER_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: move('a5', 'a4') }),
    'NO_PIECE',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: move('a6', 'a5') }),
    'NOT_YOUR_PIECE',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: move('a3', 'a3') }),
    'ILLEGAL_MOVE',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: move('a3', 'a2') }),
    'ILLEGAL_MOVE',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'move', from: 'j0', to: 'a1' } }),
    'COORDINATE_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: null }),
    'ACTION_INVALID',
  );
  expectRuleError(
    () => applyTurn({ ...position, board: [] }, { player: 0, action: move('a3', 'a4') }),
    'POSITION_INVALID',
  );
  expectRuleError(
    () => applyTurn({ ...position, currentPlayer: 3 }, { player: 0, action: move('a3', 'a4') }),
    'POSITION_INVALID',
  );
});

test('applyTurn returns a new position without mutating the input', () => {
  const position = createPosition();
  const before = structuredClone(position);
  const action = move('a3', 'a4');

  const next = applyTurn(position, { player: 0, action });
  assert.deepEqual(position, before);
  assert.notEqual(next, position);
  assert.notEqual(next.board, position.board);
  assert.notEqual(next.scores, position.scores);
  assert.notEqual(next.moves, position.moves);
  assert.notEqual(next.board[3], position.board[3]);
  assert.deepEqual(action, move('a3', 'a4'));

  assert.equal(next.board[3][0], null);
  assert.deepEqual(next.board[4][0], { type: 'pawn', owner: 0 });
  assert.equal(next.currentPlayer, 1);
  assert.deepEqual(next.scores, [0, 0]);
  assert.deepEqual(next.winners, []);
  assert.equal(next.revision, 1);
  assert.deepEqual(next.moves[0], {
    seq: 1,
    player: 0,
    piece: 'pawn',
    from: 'a3',
    to: 'a4',
    captured: null,
  });

  const clone = JSON.parse(JSON.stringify(next));
  assert.deepEqual(clone, next);
  const fromClone = applyTurn(clone, { player: 1, action: move('a6', 'a5') });
  const fromOriginal = applyTurn(next, { player: 1, action: move('a6', 'a5') });
  assert.deepEqual(fromClone, fromOriginal);
  assert.equal(fromOriginal.revision, 2);
  assert.equal(fromOriginal.currentPlayer, 0);
});

test('positionToText renders a complete coordinate board and pieces', () => {
  const position = createPosition();
  const text = positionToText(position);
  assert.equal(typeof text, 'string');
  assert.ok(text.includes('中国象棋'));
  assert.ok(text.includes('状态: playing'));
  assert.ok(text.includes('当前行棋: 0'));
  assert.ok(text.includes('列 a-i，行 0-9'));

  const lines = text.split('\n').filter((line) => line.length > 0);
  assert.ok(lines.some((line) => line.startsWith('    a b c d e f g h i')));
  assert.ok(lines.some((line) => line.startsWith(' 0  车 马 相 仕 帅 仕 相 马 车')));
  assert.ok(lines.some((line) => line.startsWith(' 9  车 马 象 士 将 士 象 马 车')));

  assert.ok(text.includes('帅e0'));
  assert.ok(text.includes('将e9'));
  assert.ok(text.includes('兵a3'));
  assert.ok(text.includes('卒a6'));
  assert.equal(text.match(/^红方:/m).length, 1);
  assert.equal(text.match(/^黑方:/m).length, 1);

  const afterMove = applyTurn(position, { player: 0, action: move('a3', 'a4') });
  const movedText = positionToText(afterMove);
  assert.ok(movedText.includes('当前行棋: 1'));
  assert.ok(movedText.includes('兵a4'));
  assert.ok(!movedText.includes('兵a3'));
});
