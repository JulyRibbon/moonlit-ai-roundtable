import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BOARD_SIZE,
  allEdges,
  boxEdges,
  boxOwner,
  boxOwnerSlot,
  buildSetupDefaults,
  canHumanMove,
  edgeGeometry,
  edgeOwner,
  extraTurnNotice,
  formatMove,
  moveComment,
  recentMoves,
  seatColor,
  winnerText,
} from '../../web/game.mjs';

function game(overrides = {}) {
  return {
    gameId: 'g_test',
    boardSize: 4,
    status: 'playing',
    players: [
      { slot: 0, kind: 'human', name: '机主', color: '#4f8cff', seatId: null },
      { slot: 1, kind: 'ai', name: 'Kimi', color: '#c084fc', seatId: 'kimi' },
      { slot: 2, kind: 'human', name: '玩家 3', color: '#34d399', seatId: null },
      { slot: 3, kind: 'ai', name: 'GLM', color: '#fbbf24', seatId: 'glm' },
    ],
    edges: {},
    boxes: {},
    currentPlayer: 0,
    scores: [0, 0, 0, 0],
    moves: [],
    winners: [],
    revision: 1,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    game: game(),
    runtime: { phase: 'ready', message: '' },
    seatOptions: [],
    ownerName: '机主',
    ...overrides,
  };
}

/* ── 边几何 ─────────────────────────────────────────────────────────────── */

test('edgeGeometry maps horizontal and vertical edges onto point coordinates', () => {
  assert.deepEqual(edgeGeometry('h:0:0'), {
    id: 'h:0:0',
    orientation: 'h',
    x: 0,
    y: 0,
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 0,
  });
  assert.deepEqual(edgeGeometry('h:3:4'), {
    id: 'h:3:4',
    orientation: 'h',
    x: 3,
    y: 4,
    x1: 3,
    y1: 4,
    x2: 4,
    y2: 4,
  });
  assert.deepEqual(edgeGeometry('v:0:0'), {
    id: 'v:0:0',
    orientation: 'v',
    x: 0,
    y: 0,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 1,
  });
  assert.deepEqual(edgeGeometry('v:4:3'), {
    id: 'v:4:3',
    orientation: 'v',
    x: 4,
    y: 3,
    x1: 4,
    y1: 3,
    x2: 4,
    y2: 4,
  });
});

test('edgeGeometry rejects malformed or out-of-range edges', () => {
  assert.equal(edgeGeometry('h:4:0'), null);
  assert.equal(edgeGeometry('h:0:5'), null);
  assert.equal(edgeGeometry('v:5:0'), null);
  assert.equal(edgeGeometry('v:0:4'), null);
  assert.equal(edgeGeometry('h:1'), null);
  assert.equal(edgeGeometry('H:0:0'), null);
  assert.equal(edgeGeometry('h:-1:0'), null);
  assert.equal(edgeGeometry('h:1.5:0'), null);
  assert.equal(edgeGeometry(''), null);
  assert.equal(edgeGeometry(null), null);
  assert.equal(edgeGeometry(42), null);
});

test('allEdges enumerates exactly 40 unique edges, 20 per orientation', () => {
  const edges = allEdges();
  assert.equal(edges.length, 40);
  assert.equal(new Set(edges).size, 40);
  assert.equal(edges.filter((id) => id.startsWith('h:')).length, 20);
  assert.equal(edges.filter((id) => id.startsWith('v:')).length, 20);
  for (const id of edges) {
    assert.ok(edgeGeometry(id), `${id} should be valid`);
  }
});

test('boxEdges lists the four bounding edges of a box', () => {
  assert.deepEqual(boxEdges(0, 0), ['h:0:0', 'h:0:1', 'v:0:0', 'v:1:0']);
  assert.deepEqual(boxEdges(3, 3), ['h:3:3', 'h:3:4', 'v:3:3', 'v:4:3']);
  assert.deepEqual(boxEdges(-1, 0), []);
  assert.deepEqual(boxEdges(4, 0), []);
});

/* ── 落子权限 ───────────────────────────────────────────────────────────── */

test('canHumanMove allows humans only while playing, ready and on turn', () => {
  assert.equal(canHumanMove(snapshot()), true);
  assert.equal(canHumanMove(snapshot({ runtime: { phase: 'ready' } })), true);
});

test('canHumanMove blocks AI turns, other phases, finished games and missing games', () => {
  assert.equal(canHumanMove(snapshot({ game: game({ currentPlayer: 1 }) })), false);
  assert.equal(canHumanMove(snapshot({ game: game({ currentPlayer: 3 }) })), false);

  for (const phase of ['idle', 'preparing', 'thinking', 'error']) {
    assert.equal(canHumanMove(snapshot({ runtime: { phase, message: '' } })), false, phase);
  }
  assert.equal(canHumanMove({ game: game() }), false);

  assert.equal(canHumanMove(snapshot({ game: game({ status: 'finished' }) })), false);
  assert.equal(canHumanMove(snapshot({ game: null })), false);
  assert.equal(canHumanMove(null), false);
  assert.equal(canHumanMove(undefined), false);
  assert.equal(canHumanMove(snapshot({ game: game({ players: [] }) })), false);
});

test('canHumanMove tolerates players missing a kind field', () => {
  const snap = snapshot({
    game: game({ players: [{ slot: 0, name: '无名' }] }),
  });
  assert.equal(canHumanMove(snap), false);
});

/* ── 胜者 ───────────────────────────────────────────────────────────────── */

test('winnerText names a single winner', () => {
  assert.equal(winnerText(game({ status: 'finished', winners: [1] })), 'Kimi 获胜');
  assert.equal(winnerText(game({ status: 'finished', winners: [3] })), 'GLM 获胜');
});

test('winnerText reports a tie for shared or missing winners', () => {
  assert.equal(winnerText(game({ status: 'finished', winners: [0, 1] })), '平局');
  assert.equal(winnerText(game({ status: 'finished', winners: [] })), '平局');
  assert.equal(winnerText(game({ status: 'finished' })), '平局');
  assert.equal(winnerText(game({ status: 'finished', winners: [2], scores: [3, 3, 3, 3] })), '玩家 3 获胜');
});

test('winnerText is empty while playing or without a game', () => {
  assert.equal(winnerText(game()), '');
  assert.equal(winnerText(null), '');
  assert.equal(winnerText(undefined), '');
});

test('winnerText falls back to seat label when player metadata is missing', () => {
  assert.equal(winnerText(game({ status: 'finished', winners: [2], players: [] })), '第 3 席 获胜');
});

/* ── 着法文案 ───────────────────────────────────────────────────────────── */

test('formatMove renders seat names for structured moves', () => {
  const players = game().players;
  assert.equal(formatMove({ slot: 1, edge: 'h:2:1' }, players), 'Kimi h:2:1');
  assert.equal(formatMove({ playerSlot: 3, edge: 'v:0:2' }, players), 'GLM v:0:2');
  assert.equal(formatMove({ slot: 1, edge: 'h:0:0', step: 4 }, players), '#4 Kimi h:0:0');
});

test('formatMove handles plain strings, explicit names and unknown seats', () => {
  assert.equal(formatMove('v:4:3', []), 'v:4:3');
  assert.equal(formatMove({ name: '围观的猫', edge: 'h:1:1' }, []), '围观的猫 h:1:1');
  assert.equal(formatMove({ slot: 9, edge: 'h:1:1' }, []), '第 10 席 h:1:1');
  assert.equal(formatMove({}, []), '');
  assert.equal(formatMove(null, []), '');
  assert.equal(formatMove(undefined, []), '');
});

test('recentMoves keeps only the latest 12 moves by default', () => {
  const moves = Array.from({ length: 15 }, (_, index) => `h:${index % 4}:0`);
  const recent = recentMoves(moves);
  assert.equal(recent.length, 12);
  assert.equal(recent[0], moves[3]);
  assert.equal(recent.at(-1), moves.at(-1));
  assert.deepEqual(recentMoves(moves, 3), moves.slice(-3));
  assert.deepEqual(recentMoves(moves, 0), recent);
  assert.deepEqual(recentMoves('not-an-array'), []);
  assert.deepEqual(recentMoves(undefined), []);
});

/* ── AI 着法理由 ────────────────────────────────────────────────────────── */

test('moveComment trims the optional AI reason', () => {
  assert.equal(moveComment({ slot: 1, edge: 'h:0:0', comment: '  先占住上边，逼你走中间。  ' }), '先占住上边，逼你走中间。');
  assert.equal(moveComment({ comment: '第一行\n第二行' }), '第一行\n第二行');
});

test('moveComment returns an empty string for missing or non-text comments', () => {
  assert.equal(moveComment({ slot: 1, edge: 'h:0:0' }), '');
  assert.equal(moveComment({ comment: '' }), '');
  assert.equal(moveComment({ comment: '   \n\t ' }), '');
  assert.equal(moveComment({ comment: 42 }), '');
  assert.equal(moveComment({ comment: null }), '');
  assert.equal(moveComment({ comment: { text: '不是字符串' } }), '');
  assert.equal(moveComment('h:0:0'), '');
  assert.equal(moveComment(null), '');
  assert.equal(moveComment(undefined), '');
});

test('moveComment caps the reason at 160 characters after trimming', () => {
  const long = `  ${'理'.repeat(200)}  `;
  const comment = moveComment({ comment: long });
  assert.equal(comment.length, 160);
  assert.equal(comment, '理'.repeat(160));
  assert.equal(moveComment({ comment: ` ${'a'.repeat(159)} ` }), 'a'.repeat(159));
  assert.equal(moveComment({ comment: ` ${'a'.repeat(161)} ` }).length, 160);
});

test('formatMove never folds the AI comment into the move label', () => {
  const players = game().players;
  assert.equal(
    formatMove({ slot: 1, edge: 'h:2:1', comment: '这一步要围格' }, players),
    'Kimi h:2:1',
  );
});

/* ── 连走提示 ───────────────────────────────────────────────────────────── */

test('extraTurnNotice fires when the last mover keeps the turn', () => {
  const snapGame = game({
    currentPlayer: 1,
    moves: [{ slot: 1, edge: 'h:0:0', extraTurn: true }],
  });
  assert.match(extraTurnNotice(snapGame), /Kimi/);
  assert.match(extraTurnNotice(snapGame), /再落一子/);
  const rulesMove = game({
    currentPlayer: 1,
    moves: [{ seq: 3, player: 1, edge: 'h:0:0', completedBoxes: ['b:0:0'] }],
  });
  assert.match(extraTurnNotice(rulesMove), /Kimi/);
});

test('extraTurnNotice stays silent on normal turns, finished games and plain moves', () => {
  assert.equal(extraTurnNotice(game({
    currentPlayer: 0,
    moves: [{ player: 1, edge: 'h:0:0', completedBoxes: [] }],
  })), '');
  assert.equal(extraTurnNotice(game({
    currentPlayer: 0,
    moves: [{ slot: 1, edge: 'h:0:0' }],
  })), '');
  assert.equal(extraTurnNotice(game({
    status: 'finished',
    currentPlayer: 0,
    moves: [{ slot: 0, edge: 'h:0:0' }],
  })), '');
  assert.equal(extraTurnNotice(game({
    currentPlayer: 1,
    moves: [{ slot: 1, edge: 'h:0:0', extraTurn: false }],
  })), '');
  assert.equal(extraTurnNotice(game({ currentPlayer: 1, moves: ['h:0:0'] })), '');
  assert.equal(extraTurnNotice(game({ currentPlayer: 1, moves: [] })), '');
  assert.equal(extraTurnNotice(null), '');
});

/* ── setup 默认值 ───────────────────────────────────────────────────────── */

test('buildSetupDefaults seats the owner as human and fills the next three AI seats', () => {
  const defaults = buildSetupDefaults({
    ownerName: '机主',
    seatOptions: [
      { seatId: 'kimi', displayName: 'Kimi', color: '#c084fc' },
      { seatId: 'glm', displayName: 'GLM', color: '#fbbf24' },
      { seatId: 'deepseek', displayName: 'DeepSeek', color: '#4f8cff' },
    ],
  });
  assert.deepEqual(defaults, [
    { kind: 'human', seatId: null, name: '机主' },
    { kind: 'ai', seatId: 'kimi', name: 'Kimi' },
    { kind: 'ai', seatId: 'glm', name: 'GLM' },
    { kind: 'ai', seatId: 'deepseek', name: 'DeepSeek' },
  ]);
});

test('buildSetupDefaults falls back to humans when AI seats are missing', () => {
  const defaults = buildSetupDefaults({
    ownerName: '房主',
    seatOptions: [{ seatId: 'kimi', displayName: 'Kimi' }],
  });
  assert.equal(defaults.length, 4);
  assert.deepEqual(defaults[0], { kind: 'human', seatId: null, name: '房主' });
  assert.deepEqual(defaults[1], { kind: 'ai', seatId: 'kimi', name: 'Kimi' });
  assert.deepEqual(defaults[2], { kind: 'human', seatId: null, name: '玩家 3' });
  assert.deepEqual(defaults[3], { kind: 'human', seatId: null, name: '玩家 4' });

  const empty = buildSetupDefaults({});
  assert.equal(empty.length, 4);
  assert.ok(empty.every((player) => player.kind === 'human'));
  assert.equal(empty[0].name, '机主');
});

/* ── 归属解析 ───────────────────────────────────────────────────────────── */

test('edgeOwner reads slot numbers, numeric strings and {slot} values', () => {
  assert.equal(edgeOwner({ 'h:0:0': 2 }, 'h:0:0'), 2);
  assert.equal(edgeOwner({ 'h:0:0': '3' }, 'h:0:0'), 3);
  assert.equal(edgeOwner({ 'h:0:0': { slot: 1 } }, 'h:0:0'), 1);
  assert.equal(edgeOwner({ 'h:0:0': '#fff' }, 'h:0:0'), null);
  assert.equal(edgeOwner({}, 'h:0:0'), null);
  assert.equal(edgeOwner(null, 'h:0:0'), null);
});

test('boxOwner supports key variants used by backends', () => {
  assert.equal(boxOwner({ 'b:1:2': 2 }, 1, 2), 2);
  assert.equal(boxOwner({ '1:2': 2 }, 1, 2), 2);
  assert.equal(boxOwner({ '1,2': 1 }, 1, 2), 1);
  assert.equal(boxOwner({ 6: 3 }, 2, 1), 3);
  assert.equal(boxOwner({ 6: 3 }, 1, 2), null);
  assert.equal(boxOwner({ '1:2': 2 }, 4, 2), null);
  assert.equal(boxOwner({ '1:2': 2 }, -1, 2), null);
  assert.equal(boxOwner(null, 1, 2), null);
  assert.equal(boxOwnerSlot({ '2:3': { slot: 1 } }, 2, 3), 1);
});

test('seatColor resolves palette colors by slot or raw color', () => {
  const players = game().players;
  assert.equal(seatColor(1, players), '#c084fc');
  assert.equal(seatColor('2', players), '#34d399');
  assert.equal(seatColor('#123456', players), '#123456');
  assert.equal(seatColor({ slot: 0 }, players), '#4f8cff');
  assert.equal(seatColor(7, players), null);
  assert.equal(seatColor(undefined, players), null);
});

test('BOARD_SIZE matches the 4x4 board contract', () => {
  assert.equal(BOARD_SIZE, 4);
});
