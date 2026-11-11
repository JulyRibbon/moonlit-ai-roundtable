import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GAME_LABEL,
  GAME_TYPE,
  GameRuleError,
  applyTurn,
  coordsToSquare,
  createPosition,
  getBoardView,
  listLegalActions,
  normalizeAction,
  positionToText,
  squareToCoords,
} from '../../games/tabletop/chess.mjs';

function emptyBoard() {
  return Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
}

function buildPosition(placements, currentPlayer = 0, extra = {}) {
  const board = emptyBoard();
  for (const [square, piece] of Object.entries(placements)) {
    const coords = squareToCoords(square);
    assert.ok(coords, `bad test square ${square}`);
    board[coords.y][coords.x] = piece;
  }
  return {
    schemaVersion: 1,
    board,
    currentPlayer,
    status: 'playing',
    winners: [],
    scores: [0, 0],
    moves: [],
    ...extra,
  };
}

function pieceAt(position, square) {
  const { x, y } = squareToCoords(square);
  return position.board[y][x];
}

function targets(position, from) {
  return listLegalActions(position)
    .filter((action) => action.from === from)
    .map((action) => action.to)
    .sort();
}

function expectRuleError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof GameRuleError, `expected GameRuleError, got ${error?.name}`);
    assert.equal(error.code, code);
    return true;
  });
}

test('meta: game type and simplified label', () => {
  assert.equal(GAME_TYPE, 'chess');
  assert.match(GAME_LABEL, /简化/);
});

test('createPosition: standard 32-piece opening layout', () => {
  const position = createPosition();
  assert.equal(position.currentPlayer, 0);
  assert.equal(position.status, 'playing');
  assert.deepEqual(position.winners, []);
  assert.deepEqual(position.scores, [0, 0]);
  assert.equal(position.board.length, 8);
  assert.ok(position.board.every((row) => row.length === 8));

  const pieces = position.board.flat().filter((cell) => cell !== null);
  assert.equal(pieces.length, 32);
  assert.equal(pieces.filter((piece) => piece[0] === 'w').length, 16);
  assert.equal(pieces.filter((piece) => piece[0] === 'b').length, 16);

  assert.equal(pieceAt(position, 'a1'), 'wR');
  assert.equal(pieceAt(position, 'b1'), 'wN');
  assert.equal(pieceAt(position, 'c1'), 'wB');
  assert.equal(pieceAt(position, 'd1'), 'wQ');
  assert.equal(pieceAt(position, 'e1'), 'wK');
  assert.equal(pieceAt(position, 'a2'), 'wP');
  assert.equal(pieceAt(position, 'h7'), 'bP');
  assert.equal(pieceAt(position, 'a8'), 'bR');
  assert.equal(pieceAt(position, 'd8'), 'bQ');
  assert.equal(pieceAt(position, 'e8'), 'bK');
  assert.equal(pieceAt(position, 'd4'), null);
});

test('getBoardView: 8x8 cells with coordinates, owner and unicode labels', () => {
  const view = getBoardView(createPosition());
  assert.equal(view.rows, 8);
  assert.equal(view.columns, 8);
  assert.equal(view.cells.length, 64);

  const a1 = view.cells.find((cell) => cell.x === 0 && cell.y === 7);
  assert.deepEqual(a1, { x: 0, y: 7, value: 'wR', owner: 0, label: '♖' });
  const e8 = view.cells.find((cell) => cell.x === 4 && cell.y === 0);
  assert.deepEqual(e8, { x: 4, y: 0, value: 'bK', owner: 1, label: '♚' });
  const e4 = view.cells.find((cell) => cell.x === 4 && cell.y === 4);
  assert.deepEqual(e4, { x: 4, y: 4, value: null, owner: null, label: '' });

  assert.equal(view.cells.filter((cell) => cell.value !== null).length, 32);
  assert.equal(view.cells[0].x, 0);
  assert.equal(view.cells[0].y, 0);
  assert.equal(view.cells[63].x, 7);
  assert.equal(view.cells[63].y, 7);
});

test('square helpers: coords mapping', () => {
  assert.deepEqual(squareToCoords('a8'), { x: 0, y: 0 });
  assert.deepEqual(squareToCoords('h1'), { x: 7, y: 7 });
  assert.equal(squareToCoords('a9'), null);
  assert.equal(coordsToSquare(0, 0), 'a8');
  assert.equal(coordsToSquare(7, 7), 'h1');
  assert.equal(coordsToSquare(8, 0), null);
});

test('positionToText: complete board, coordinates and simplified notice', () => {
  const text = positionToText(createPosition());
  assert.ok(text.includes(GAME_LABEL));
  assert.ok(text.includes('♜'));
  assert.ok(text.includes('♙'));
  assert.ok(text.includes('a b c d e f g h'));
  for (const rank of '12345678') {
    assert.match(text, new RegExp(`^${rank} `, 'm'));
  }
  assert.ok(text.includes('轮到：白方'));
  assert.ok(text.includes('简化'));
  assert.ok(text.split('\n').length >= 10);
});

test('normalizeAction: accepts trimmed mixed-case squares, rejects bad input', () => {
  assert.deepEqual(normalizeAction({ kind: 'move', from: ' E2 ', to: 'E4 ' }), {
    kind: 'move',
    from: 'e2',
    to: 'e4',
  });
  expectRuleError(() => normalizeAction(null), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction('e2e4'), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'pass', from: 'e2', to: 'e4' }), 'ACTION_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'move', from: 'e9', to: 'e4' }), 'SQUARE_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'move', from: 'e2', to: 'z4' }), 'SQUARE_INVALID');
  expectRuleError(() => normalizeAction({ kind: 'move', from: 2, to: 'e4' }), 'SQUARE_INVALID');
});

test('listLegalActions: 20 opening moves', () => {
  const actions = listLegalActions(createPosition());
  assert.equal(actions.length, 20);
  assert.ok(actions.every((action) => action.kind === 'move'));
  const froms = new Set(actions.map((action) => action.from));
  assert.deepEqual([...froms].sort(), ['a2', 'b1', 'b2', 'c2', 'd2', 'e2', 'f2', 'g1', 'g2', 'h2']);
  assert.ok(actions.some((action) => action.from === 'e2' && action.to === 'e4'));
  assert.ok(actions.some((action) => action.from === 'e2' && action.to === 'e3'));
  assert.ok(actions.some((action) => action.from === 'g1' && action.to === 'f3'));
  assert.ok(!actions.some((action) => action.from === 'a1'), 'rook is blocked');
});

test('rook: slides until blocked and captures the first enemy', () => {
  const open = buildPosition({ a1: 'wR', e1: 'wK', e8: 'bK' });
  assert.deepEqual(targets(open, 'a1'), [
    'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8',
    'b1', 'c1', 'd1',
  ].sort());

  const blocked = buildPosition({ a1: 'wR', a4: 'bP', b1: 'wN', c1: 'bN' }, 0);
  assert.deepEqual(targets(blocked, 'a1'), ['a2', 'a3', 'a4'].sort());
});

test('bishop: diagonal sliding with blockers', () => {
  const open = buildPosition({ d4: 'wB' });
  assert.equal(targets(open, 'd4').length, 13);
  assert.ok(targets(open, 'd4').includes('h8'));
  assert.ok(targets(open, 'd4').includes('a1'));

  const blocked = buildPosition({ d4: 'wB', f6: 'wP', b2: 'bP' });
  const blockedTargets = targets(blocked, 'd4');
  assert.ok(blockedTargets.includes('e5'));
  assert.ok(!blockedTargets.includes('f6'), 'own piece blocks');
  assert.ok(blockedTargets.includes('b2'), 'enemy is capturable');
  assert.ok(!blockedTargets.includes('a1'), 'cannot jump over enemy');
});

test('queen: combines rook and bishop lines', () => {
  const position = buildPosition({ d4: 'wQ' });
  const moves = targets(position, 'd4');
  assert.equal(moves.length, 27);
  for (const square of ['d8', 'a4', 'h4', 'd1', 'a7', 'g1', 'h8', 'a1']) {
    assert.ok(moves.includes(square), `queen should reach ${square}`);
  }
});

test('knight: jumps over pieces', () => {
  const position = buildPosition({
    d4: 'wN',
    c3: 'wP', c4: 'wP', c5: 'wP', d3: 'wP', d5: 'wP', e3: 'wP', e4: 'wP', e5: 'wP',
  });
  const moves = targets(position, 'd4');
  assert.equal(moves.length, 8, 'surrounding pieces do not block a knight');
  for (const square of ['c2', 'b3', 'b5', 'c6', 'e6', 'f5', 'f3', 'e2']) {
    assert.ok(moves.includes(square), `knight should reach ${square}`);
  }
});

test('king: one square in every direction, no castling', () => {
  const open = buildPosition({ e4: 'wK' });
  assert.equal(targets(open, 'e4').length, 8);

  const corner = buildPosition({ e1: 'wK', h1: 'wR' });
  const moves = targets(corner, 'e1');
  assert.ok(moves.includes('e2'));
  assert.ok(moves.includes('f1'));
  assert.ok(!moves.includes('g1'), 'castling is omitted in the simplified rules');
});

test('pawn: single step, initial double step and blocked paths', () => {
  const start = buildPosition({ e2: 'wP', e8: 'bK', a1: 'wK' });
  assert.deepEqual(targets(start, 'e2'), ['e3', 'e4']);

  const moved = buildPosition({ e3: 'wP', e8: 'bK', a1: 'wK' });
  assert.deepEqual(targets(moved, 'e3'), ['e4']);

  const blocked = buildPosition({ e2: 'wP', e3: 'bN', e8: 'bK', a1: 'wK' });
  assert.deepEqual(targets(blocked, 'e2'), []);

  const blockedDouble = buildPosition({ e2: 'wP', e4: 'bN', e8: 'bK', a1: 'wK' });
  assert.deepEqual(targets(blockedDouble, 'e2'), ['e3']);

  const blackStart = buildPosition({ e7: 'bP', e1: 'wK', a8: 'bK' }, 1);
  assert.deepEqual(targets(blackStart, 'e7'), ['e5', 'e6']);
});

test('pawn: captures diagonally only, forward capture is illegal', () => {
  const position = buildPosition({ d4: 'wP', e5: 'bP', d5: 'bP', c5: 'wN' });
  const moves = targets(position, 'd4');
  assert.ok(moves.includes('e5'), 'enemy diagonal is capturable');
  assert.ok(!moves.includes('c5'), 'own diagonal is not capturable');
  assert.ok(!moves.includes('d5'), 'cannot capture straight ahead');

  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'move', from: 'd4', to: 'd5' } }),
    'MOVE_INVALID',
  );
});

test('pawn: promotion to queen on the last rank, both colors', () => {
  const white = buildPosition({ a7: 'wP', a8: null, e8: 'bK', e1: 'wK' });
  const promotedWhite = applyTurn(white, { player: 0, action: { kind: 'move', from: 'a7', to: 'a8' } });
  assert.equal(pieceAt(promotedWhite, 'a8'), 'wQ');
  assert.equal(promotedWhite.moves[0].promotion, 'wQ');

  const black = buildPosition({ h2: 'bP', e1: 'wK', e8: 'bK' }, 1);
  const promotedBlack = applyTurn(black, { player: 1, action: { kind: 'move', from: 'h2', to: 'h1' } });
  assert.equal(pieceAt(promotedBlack, 'h1'), 'bQ');
  assert.equal(promotedBlack.moves[0].promotion, 'bQ');

  const promotesWithCapture = buildPosition({ a7: 'wP', b8: 'bR', e1: 'wK', e8: 'bK' });
  const captured = applyTurn(promotesWithCapture, {
    player: 0,
    action: { kind: 'move', from: 'a7', to: 'b8' },
  });
  assert.equal(pieceAt(captured, 'b8'), 'wQ');
  assert.equal(captured.moves[0].captured, 'bR');
});

test('capture the king: game ends with a winner and a score', () => {
  const position = buildPosition({ e1: 'wQ', e8: 'bK', a1: 'wK', h8: 'bR' });
  assert.ok(targets(position, 'e1').includes('e8'));

  const finished = applyTurn(position, { player: 0, action: { kind: 'move', from: 'e1', to: 'e8' } });
  assert.equal(finished.status, 'finished');
  assert.deepEqual(finished.winners, [0]);
  assert.deepEqual(finished.scores, [1, 0]);
  assert.equal(pieceAt(finished, 'e8'), 'wQ');
  assert.equal(finished.currentPlayer, 0);
  assert.deepEqual(listLegalActions(finished), []);

  expectRuleError(
    () => applyTurn(finished, { player: 0, action: { kind: 'move', from: 'e8', to: 'e7' } }),
    'GAME_FINISHED',
  );
});

test('applyTurn: alternating turns and move log', () => {
  const afterWhite = applyTurn(createPosition(), {
    player: 0,
    action: { kind: 'move', from: 'e2', to: 'e4' },
  });
  assert.equal(afterWhite.currentPlayer, 1);
  assert.equal(pieceAt(afterWhite, 'e4'), 'wP');
  assert.equal(pieceAt(afterWhite, 'e2'), null);
  assert.deepEqual(afterWhite.moves[0], {
    seq: 1,
    player: 0,
    from: 'e2',
    to: 'e4',
    piece: 'wP',
    captured: null,
    promotion: null,
  });

  const afterBlack = applyTurn(afterWhite, {
    player: 1,
    action: { kind: 'move', from: 'e7', to: 'e5' },
  });
  assert.equal(afterBlack.currentPlayer, 0);
  assert.equal(afterBlack.moves.length, 2);
  assert.equal(afterBlack.moves[1].seq, 2);
});

test('applyTurn: rejects wrong turn, empty squares, wrong pieces and illegal moves', () => {
  const position = createPosition();
  expectRuleError(
    () => applyTurn(position, { player: 1, action: { kind: 'move', from: 'e7', to: 'e5' } }),
    'GAME_NOT_YOUR_TURN',
  );
  expectRuleError(
    () => applyTurn(position, { player: 2, action: { kind: 'move', from: 'e2', to: 'e4' } }),
    'PLAYER_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'move', from: 'e4', to: 'e5' } }),
    'MOVE_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'move', from: 'e7', to: 'e5' } }),
    'NOT_YOUR_PIECE',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'move', from: 'e2', to: 'e5' } }),
    'MOVE_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'move', from: 'a1', to: 'a3' } }),
    'MOVE_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'move', from: 'e2', to: 'e9' } }),
    'SQUARE_INVALID',
  );
  expectRuleError(
    () => applyTurn(position, { player: 0, action: { kind: 'jump', from: 'e2', to: 'e4' } }),
    'ACTION_INVALID',
  );
});

test('applyTurn: rejects malformed positions', () => {
  expectRuleError(() => applyTurn(null, { player: 0, action: { kind: 'move', from: 'e2', to: 'e4' } }), 'POSITION_INVALID');
  expectRuleError(() => listLegalActions({}), 'POSITION_INVALID');
  expectRuleError(
    () => listLegalActions({ ...createPosition(), board: [] }),
    'POSITION_INVALID',
  );
  expectRuleError(
    () => listLegalActions({ ...createPosition(), scores: [0] }),
    'POSITION_INVALID',
  );
});

test('applyTurn: positions are immutable and survive JSON round trips', () => {
  const position = createPosition();
  const snapshot = structuredClone(position);
  const next = applyTurn(position, { player: 0, action: { kind: 'move', from: 'g1', to: 'f3' } });

  assert.deepEqual(position, snapshot, 'source position must not change');
  assert.notEqual(next.board, position.board);
  assert.notEqual(next.board[0], position.board[0]);

  next.board[0][0] = 'wQ';
  assert.equal(snapshot.board[0][0], 'bR');
  assert.equal(pieceAt(position, 'g1'), 'wN');
  assert.equal(pieceAt(position, 'f3'), null);
  assert.equal(pieceAt(next, 'f3'), 'wN');

  const restored = JSON.parse(JSON.stringify(next));
  assert.deepEqual(restored, next);
  const continued = applyTurn(restored, { player: 1, action: { kind: 'move', from: 'e7', to: 'e5' } });
  assert.equal(continued.moves.length, 2);
  assert.equal(continued.currentPlayer, 0);

  const deepView = getBoardView(continued);
  assert.equal(deepView.cells.find((cell) => cell.x === 4 && cell.y === 3).value, 'bP');
});
