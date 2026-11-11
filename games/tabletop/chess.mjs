export const GAME_TYPE = 'chess';
export const GAME_LABEL = '国际象棋（简化版）';
export const BOARD_SIZE = 8;
export const PLAYER_COUNT = 2;

export const FILES = 'abcdefgh';
export const RANKS = '12345678';

const PIECE_TYPES = new Set(['K', 'Q', 'R', 'B', 'N', 'P']);
const PIECE_PATTERN = /^([wb])([KQRBNP])$/;

export const PIECE_LABELS = {
  wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
  bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

const START_BOARD = [
  ['bR', 'bN', 'bB', 'bQ', 'bK', 'bB', 'bN', 'bR'],
  ['bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP', 'bP'],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null],
  ['wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP', 'wP'],
  ['wR', 'wN', 'wB', 'wQ', 'wK', 'wB', 'wN', 'wR'],
];

const KNIGHT_OFFSETS = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];

const KING_OFFSETS = [
  [1, 0], [1, 1], [0, 1], [-1, 1],
  [-1, 0], [-1, -1], [0, -1], [1, -1],
];

const ROOK_DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRECTIONS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

export class GameRuleError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'GameRuleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GameRuleError(code, message);
}

export function squareToCoords(square) {
  if (typeof square !== 'string') return null;
  const match = /^([a-h])([1-8])$/.exec(square);
  if (!match) return null;
  const x = FILES.indexOf(match[1]);
  const y = BOARD_SIZE - Number(match[2]);
  return { x, y };
}

export function coordsToSquare(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return null;
  return `${FILES[x]}${BOARD_SIZE - y}`;
}

function inside(x, y) {
  return x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function colorOf(piece) {
  return piece === null ? null : piece[0] === 'w' ? 0 : 1;
}

function typeOf(piece) {
  return piece === null ? null : piece[1];
}

export function createPosition() {
  return {
    schemaVersion: 1,
    board: START_BOARD.map((row) => row.slice()),
    currentPlayer: 0,
    status: 'playing',
    winners: [],
    scores: [0, 0],
    moves: [],
  };
}

export function normalizeSquare(input) {
  if (typeof input !== 'string') return null;
  const square = input.trim().toLowerCase();
  return squareToCoords(square) ? square : null;
}

export function normalizeAction(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('ACTION_INVALID', 'action must be an object');
  }
  if (input.kind !== 'move') {
    fail('ACTION_INVALID', `unsupported action kind: ${String(input.kind)}`);
  }
  const from = normalizeSquare(input.from);
  const to = normalizeSquare(input.to);
  if (from === null) {
    fail('SQUARE_INVALID', `invalid from square: ${String(input.from)}`);
  }
  if (to === null) {
    fail('SQUARE_INVALID', `invalid to square: ${String(input.to)}`);
  }
  return { kind: 'move', from, to };
}

function assertBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    fail('POSITION_INVALID', 'board must have 8 rows');
  }
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      fail('POSITION_INVALID', 'each board row must have 8 cells');
    }
    for (const cell of row) {
      if (cell === null) continue;
      if (typeof cell !== 'string' || !PIECE_PATTERN.test(cell) || !PIECE_TYPES.has(cell[1])) {
        fail('POSITION_INVALID', `invalid board cell: ${String(cell)}`);
      }
    }
  }
}

export function assertPosition(position, { requirePlaying = false } = {}) {
  if (position === null || typeof position !== 'object' || Array.isArray(position)) {
    fail('POSITION_INVALID', 'position must be an object');
  }
  if (position.schemaVersion !== 1) {
    fail('POSITION_INVALID', `unsupported schemaVersion: ${String(position.schemaVersion)}`);
  }
  assertBoard(position.board);
  if (position.currentPlayer !== 0 && position.currentPlayer !== 1) {
    fail('POSITION_INVALID', `invalid currentPlayer: ${String(position.currentPlayer)}`);
  }
  if (position.status !== 'playing' && position.status !== 'finished') {
    fail('POSITION_INVALID', `unknown status: ${String(position.status)}`);
  }
  if (!Array.isArray(position.winners)) {
    fail('POSITION_INVALID', 'winners must be an array');
  }
  if (
    !Array.isArray(position.scores)
    || position.scores.length !== PLAYER_COUNT
    || !position.scores.every((score) => Number.isInteger(score) && score >= 0)
  ) {
    fail('POSITION_INVALID', 'scores must be two non-negative integers');
  }
  if (!Array.isArray(position.moves)) {
    fail('POSITION_INVALID', 'moves must be an array');
  }
  if (requirePlaying && position.status !== 'playing') {
    fail('GAME_FINISHED', 'position is already finished');
  }
  return position;
}

function pushTarget(board, moves, x, y, owner) {
  if (!inside(x, y)) return;
  const target = board[y][x];
  if (target !== null && colorOf(target) === owner) return;
  moves.push({ x, y });
}

function slidingMoves(board, x, y, directions, owner) {
  const moves = [];
  for (const [dx, dy] of directions) {
    let cx = x + dx;
    let cy = y + dy;
    while (inside(cx, cy)) {
      const target = board[cy][cx];
      if (target === null) {
        moves.push({ x: cx, y: cy });
      } else {
        if (colorOf(target) !== owner) moves.push({ x: cx, y: cy });
        break;
      }
      cx += dx;
      cy += dy;
    }
  }
  return moves;
}

function pawnMoves(board, x, y, owner) {
  const moves = [];
  const forward = owner === 0 ? -1 : 1;
  const startRow = owner === 0 ? 6 : 1;

  const oneY = y + forward;
  if (inside(x, oneY) && board[oneY][x] === null) {
    moves.push({ x, y: oneY });
    const twoY = y + forward * 2;
    if (y === startRow && inside(x, twoY) && board[twoY][x] === null) {
      moves.push({ x, y: twoY });
    }
  }
  for (const dx of [-1, 1]) {
    const cx = x + dx;
    const cy = y + forward;
    if (!inside(cx, cy)) continue;
    const target = board[cy][cx];
    if (target !== null && colorOf(target) !== owner) {
      moves.push({ x: cx, y: cy });
    }
  }
  return moves;
}

function pieceMoves(board, x, y) {
  const piece = board[y][x];
  if (piece === null) return [];
  const owner = colorOf(piece);
  switch (typeOf(piece)) {
    case 'P':
      return pawnMoves(board, x, y, owner);
    case 'N': {
      const moves = [];
      for (const [dx, dy] of KNIGHT_OFFSETS) pushTarget(board, moves, x + dx, y + dy, owner);
      return moves;
    }
    case 'K': {
      const moves = [];
      for (const [dx, dy] of KING_OFFSETS) pushTarget(board, moves, x + dx, y + dy, owner);
      return moves;
    }
    case 'R':
      return slidingMoves(board, x, y, ROOK_DIRECTIONS, owner);
    case 'B':
      return slidingMoves(board, x, y, BISHOP_DIRECTIONS, owner);
    case 'Q':
      return slidingMoves(board, x, y, [...ROOK_DIRECTIONS, ...BISHOP_DIRECTIONS], owner);
    default:
      return [];
  }
}

export function listLegalActions(position) {
  assertPosition(position);
  if (position.status !== 'playing') return [];
  const { board, currentPlayer } = position;
  const actions = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const piece = board[y][x];
      if (piece === null || colorOf(piece) !== currentPlayer) continue;
      const from = coordsToSquare(x, y);
      for (const target of pieceMoves(board, x, y)) {
        actions.push({ kind: 'move', from, to: coordsToSquare(target.x, target.y) });
      }
    }
  }
  return actions;
}

export function applyTurn(position, { player, action } = {}) {
  assertPosition(position, { requirePlaying: true });
  if (!Number.isInteger(player) || player < 0 || player >= PLAYER_COUNT) {
    fail('PLAYER_INVALID', `invalid player index: ${String(player)}`);
  }
  if (player !== position.currentPlayer) {
    fail('GAME_NOT_YOUR_TURN', `player ${player} cannot move; it is player ${position.currentPlayer}'s turn`);
  }
  const normalized = normalizeAction(action);
  const fromCoords = squareToCoords(normalized.from);
  const toCoords = squareToCoords(normalized.to);
  const board = position.board;
  const piece = board[fromCoords.y][fromCoords.x];
  if (piece === null) {
    fail('MOVE_INVALID', `no piece on ${normalized.from}`);
  }
  if (colorOf(piece) !== player) {
    fail('NOT_YOUR_PIECE', `piece on ${normalized.from} does not belong to player ${player}`);
  }
  const legal = pieceMoves(board, fromCoords.x, fromCoords.y)
    .some((target) => target.x === toCoords.x && target.y === toCoords.y);
  if (!legal) {
    fail('MOVE_INVALID', `${normalized.from}-${normalized.to} is not a legal move for ${piece}`);
  }

  const next = structuredClone(position);
  const captured = next.board[toCoords.y][toCoords.x];
  next.board[toCoords.y][toCoords.x] = piece;
  next.board[fromCoords.y][fromCoords.x] = null;

  let promoted = null;
  const promotionRow = player === 0 ? 0 : 7;
  if (typeOf(piece) === 'P' && toCoords.y === promotionRow) {
    promoted = `${piece[0]}Q`;
    next.board[toCoords.y][toCoords.x] = promoted;
  }

  next.moves.push({
    seq: next.moves.length + 1,
    player,
    from: normalized.from,
    to: normalized.to,
    piece,
    captured,
    promotion: promoted,
  });

  if (captured !== null && typeOf(captured) === 'K') {
    next.status = 'finished';
    next.winners = [player];
    next.scores[player] += 1;
  } else {
    next.currentPlayer = (player + 1) % PLAYER_COUNT;
  }

  return next;
}

export function getBoardView(position) {
  assertPosition(position);
  const cells = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const value = position.board[y][x];
      cells.push({
        x,
        y,
        value,
        owner: colorOf(value),
        label: value === null ? '' : PIECE_LABELS[value],
      });
    }
  }
  return { rows: BOARD_SIZE, columns: BOARD_SIZE, cells };
}

export function positionToText(position) {
  assertPosition(position);
  const lines = [`${GAME_LABEL}　规则：无王车易位、无吃过路兵、无将军/应将/逼和判定`];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const row = position.board[y].map((piece) => PIECE_LABELS[piece] ?? '·');
    lines.push(`${BOARD_SIZE - y} ${row.join(' ')}`);
  }
  lines.push(`  ${FILES.split('').join(' ')}`);
  const side = position.currentPlayer === 0 ? '白方' : '黑方';
  if (position.status === 'finished') {
    const winner = position.winners.map((index) => (index === 0 ? '白方' : '黑方')).join('、');
    lines.push(`状态：已结束　胜者：${winner}`);
  } else {
    lines.push(`状态：进行中　轮到：${side}`);
  }
  lines.push('说明：吃王即获胜，兵到底线自动升后。');
  return lines.join('\n');
}
