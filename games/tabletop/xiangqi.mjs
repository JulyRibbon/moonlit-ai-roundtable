export const GAME_TYPE = 'xiangqi';
export const ROWS = 10;
export const COLUMNS = 9;

const RED = 0;
const BLACK = 1;
const PLAYERS = [RED, BLACK];

const PIECE_TYPES = [
  'general',
  'advisor',
  'elephant',
  'horse',
  'rook',
  'cannon',
  'pawn',
];

const LABELS = {
  [RED]: {
    general: '帅',
    advisor: '仕',
    elephant: '相',
    horse: '马',
    rook: '车',
    cannon: '炮',
    pawn: '兵',
  },
  [BLACK]: {
    general: '将',
    advisor: '士',
    elephant: '象',
    horse: '马',
    rook: '车',
    cannon: '炮',
    pawn: '卒',
  },
};

const BACK_RANK = [
  'rook',
  'horse',
  'elephant',
  'advisor',
  'general',
  'advisor',
  'elephant',
  'horse',
  'rook',
];

const COORDINATE_PATTERN = /^([a-iA-I])([0-9])$/;
const FILE_LETTERS = 'abcdefghi';

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

function createEmptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLUMNS).fill(null));
}

function coordinateToXY(coordinate) {
  const match = COORDINATE_PATTERN.exec(coordinate);
  if (!match) return null;
  return {
    x: match[1].toLowerCase().charCodeAt(0) - 97,
    y: Number(match[2]),
  };
}

function xyToCoordinate(x, y) {
  return `${FILE_LETTERS[x]}${y}`;
}

function parseCoordinate(value, field) {
  if (typeof value !== 'string') {
    fail('COORDINATE_INVALID', `${field} must be a coordinate string`);
  }
  const point = coordinateToXY(value);
  if (!point) {
    fail('COORDINATE_INVALID', `invalid ${field} coordinate: ${value}`);
  }
  return point;
}

function labelFor(piece) {
  return LABELS[piece.owner][piece.type];
}

function inBoard(x, y) {
  return x >= 0 && x < COLUMNS && y >= 0 && y < ROWS;
}

function pieceAt(board, x, y) {
  return inBoard(x, y) ? board[y][x] : null;
}

function canLand(board, x, y, owner) {
  if (!inBoard(x, y)) return false;
  const target = board[y][x];
  return target === null || target.owner !== owner;
}

function inPalace(owner, x, y) {
  if (x < 3 || x > 5) return false;
  return owner === RED ? y >= 0 && y <= 2 : y >= 7 && y <= 9;
}

function crossedRiver(owner, y) {
  return owner === RED ? y >= 5 : y <= 4;
}

function addMove(moves, board, x, y, owner) {
  if (canLand(board, x, y, owner)) moves.push({ x, y });
}

function rookMoves(board, x, y, owner) {
  const moves = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let cx = x + dx;
    let cy = y + dy;
    while (inBoard(cx, cy)) {
      const target = board[cy][cx];
      if (target === null) {
        moves.push({ x: cx, y: cy });
      } else {
        if (target.owner !== owner) moves.push({ x: cx, y: cy });
        break;
      }
      cx += dx;
      cy += dy;
    }
  }
  return moves;
}

function horseMoves(board, x, y, owner) {
  const moves = [];
  for (const [dx, dy] of [
    [1, 2],
    [2, 1],
    [-1, 2],
    [-2, 1],
    [1, -2],
    [2, -1],
    [-1, -2],
    [-2, -1],
  ]) {
    const legX = x + (Math.abs(dx) === 2 ? Math.sign(dx) : 0);
    const legY = y + (Math.abs(dy) === 2 ? Math.sign(dy) : 0);
    if (!inBoard(legX, legY) || board[legY][legX] !== null) continue;
    addMove(moves, board, x + dx, y + dy, owner);
  }
  return moves;
}

function elephantMoves(board, x, y, owner) {
  const moves = [];
  for (const [dx, dy] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
    const targetX = x + dx;
    const targetY = y + dy;
    if (!inBoard(targetX, targetY)) continue;
    if (owner === RED ? targetY > 4 : targetY < 5) continue;
    if (board[y + dy / 2][x + dx / 2] !== null) continue;
    addMove(moves, board, targetX, targetY, owner);
  }
  return moves;
}

function advisorMoves(board, x, y, owner) {
  const moves = [];
  for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const targetX = x + dx;
    const targetY = y + dy;
    if (!inPalace(owner, targetX, targetY)) continue;
    addMove(moves, board, targetX, targetY, owner);
  }
  return moves;
}

function generalMoves(board, x, y, owner) {
  const moves = [];
  const seen = new Set();
  const push = (targetX, targetY) => {
    const key = `${targetX}:${targetY}`;
    if (seen.has(key)) return;
    if (!canLand(board, targetX, targetY, owner)) return;
    seen.add(key);
    moves.push({ x: targetX, y: targetY });
  };

  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const targetX = x + dx;
    const targetY = y + dy;
    if (inPalace(owner, targetX, targetY)) push(targetX, targetY);
  }

  // 飞将：同列无子相隔时，可将对方将帅直接吃掉。
  for (const dy of [1, -1]) {
    let targetY = y + dy;
    while (inBoard(x, targetY) && board[targetY][x] === null) targetY += dy;
    if (!inBoard(x, targetY)) continue;
    const target = board[targetY][x];
    if (target.type === 'general' && target.owner !== owner) push(x, targetY);
  }

  return moves;
}

function cannonMoves(board, x, y, owner) {
  const moves = [];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let cx = x + dx;
    let cy = y + dy;
    while (inBoard(cx, cy) && board[cy][cx] === null) {
      moves.push({ x: cx, y: cy });
      cx += dx;
      cy += dy;
    }
    if (!inBoard(cx, cy)) continue;

    // 越过炮架后，第一个遇到的棋子若是敌方即可吃。
    let screenX = cx + dx;
    let screenY = cy + dy;
    while (inBoard(screenX, screenY) && board[screenY][screenX] === null) {
      screenX += dx;
      screenY += dy;
    }
    if (!inBoard(screenX, screenY)) continue;
    const target = board[screenY][screenX];
    if (target.owner !== owner) moves.push({ x: screenX, y: screenY });
  }
  return moves;
}

function pawnMoves(board, x, y, owner) {
  const moves = [];
  const forward = owner === RED ? 1 : -1;
  addMove(moves, board, x, y + forward, owner);
  if (crossedRiver(owner, y)) {
    addMove(moves, board, x - 1, y, owner);
    addMove(moves, board, x + 1, y, owner);
  }
  return moves;
}

function pieceMoves(board, x, y) {
  const piece = board[y][x];
  if (piece === null) return [];
  switch (piece.type) {
    case 'rook':
      return rookMoves(board, x, y, piece.owner);
    case 'horse':
      return horseMoves(board, x, y, piece.owner);
    case 'elephant':
      return elephantMoves(board, x, y, piece.owner);
    case 'advisor':
      return advisorMoves(board, x, y, piece.owner);
    case 'general':
      return generalMoves(board, x, y, piece.owner);
    case 'cannon':
      return cannonMoves(board, x, y, piece.owner);
    case 'pawn':
      return pawnMoves(board, x, y, piece.owner);
    default:
      return [];
  }
}

function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== ROWS) {
    fail('POSITION_INVALID', `board must have ${ROWS} rows`);
  }
  for (let y = 0; y < ROWS; y += 1) {
    const row = board[y];
    if (!Array.isArray(row) || row.length !== COLUMNS) {
      fail('POSITION_INVALID', `board row ${y} must have ${COLUMNS} columns`);
    }
    for (let x = 0; x < COLUMNS; x += 1) {
      const piece = row[x];
      if (piece === null) continue;
      if (
        typeof piece !== 'object'
        || !PIECE_TYPES.includes(piece.type)
        || !PLAYERS.includes(piece.owner)
      ) {
        fail('POSITION_INVALID', `invalid piece at ${xyToCoordinate(x, y)}`);
      }
    }
  }
}

function assertPosition(position) {
  if (position === null || typeof position !== 'object' || Array.isArray(position)) {
    fail('POSITION_INVALID', 'position must be an object');
  }
  validateBoard(position.board);
  if (!PLAYERS.includes(position.currentPlayer)) {
    fail('POSITION_INVALID', 'currentPlayer must be 0 or 1');
  }
  if (position.status !== 'playing' && position.status !== 'finished') {
    fail('POSITION_INVALID', `unknown status: ${String(position.status)}`);
  }
  if (!Array.isArray(position.scores) || position.scores.length !== PLAYERS.length) {
    fail('POSITION_INVALID', 'scores must have one entry per player');
  }
}

function cloneBoard(board) {
  return board.map((row) => row.map((piece) => (
    piece === null ? null : { type: piece.type, owner: piece.owner }
  )));
}

export function createPosition() {
  const board = createEmptyBoard();

  BACK_RANK.forEach((type, x) => {
    board[0][x] = { type, owner: RED };
    board[9][x] = { type, owner: BLACK };
  });
  board[2][1] = { type: 'cannon', owner: RED };
  board[2][7] = { type: 'cannon', owner: RED };
  board[7][1] = { type: 'cannon', owner: BLACK };
  board[7][7] = { type: 'cannon', owner: BLACK };
  for (let x = 0; x < COLUMNS; x += 2) {
    board[3][x] = { type: 'pawn', owner: RED };
    board[6][x] = { type: 'pawn', owner: BLACK };
  }

  return {
    schemaVersion: 1,
    gameType: GAME_TYPE,
    board,
    currentPlayer: RED,
    status: 'playing',
    winners: [],
    scores: [0, 0],
    revision: 0,
    moves: [],
  };
}

export function normalizeAction(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('ACTION_INVALID', 'action must be an object');
  }
  const kind = input.kind ?? 'move';
  if (kind !== 'move') {
    fail('ACTION_INVALID', `unsupported action kind: ${String(kind)}`);
  }
  const from = parseCoordinate(input.from, 'from');
  const to = parseCoordinate(input.to, 'to');
  return {
    kind: 'move',
    from: xyToCoordinate(from.x, from.y),
    to: xyToCoordinate(to.x, to.y),
  };
}

export function applyTurn(position, options = {}) {
  assertPosition(position);
  if (position.status === 'finished') {
    fail('GAME_FINISHED', 'game is already finished');
  }

  const { player, action } = options ?? {};
  if (!PLAYERS.includes(player)) {
    fail('PLAYER_INVALID', `invalid player: ${String(player)}`);
  }
  if (player !== position.currentPlayer) {
    fail('NOT_YOUR_TURN', `player ${player} cannot move; it is player ${position.currentPlayer}'s turn`);
  }

  const normalized = normalizeAction(action);
  const from = coordinateToXY(normalized.from);
  const to = coordinateToXY(normalized.to);
  const piece = position.board[from.y][from.x];
  if (piece === null) {
    fail('NO_PIECE', `no piece at ${normalized.from}`);
  }
  if (piece.owner !== player) {
    fail('NOT_YOUR_PIECE', `piece at ${normalized.from} belongs to player ${piece.owner}`);
  }

  const legal = pieceMoves(position.board, from.x, from.y)
    .some((target) => target.x === to.x && target.y === to.y);
  if (!legal) {
    fail('ILLEGAL_MOVE', `${normalized.from} -> ${normalized.to} is not a legal move`);
  }

  const nextBoard = cloneBoard(position.board);
  const captured = nextBoard[to.y][to.x];
  nextBoard[to.y][to.x] = { type: piece.type, owner: piece.owner };
  nextBoard[from.y][from.x] = null;

  const next = {
    ...position,
    board: nextBoard,
    scores: [...position.scores],
    winners: [...position.winners],
    moves: [
      ...position.moves,
      {
        seq: position.moves.length + 1,
        player,
        piece: piece.type,
        from: normalized.from,
        to: normalized.to,
        captured: captured === null ? null : captured.type,
      },
    ],
    revision: position.revision + 1,
  };

  if (captured !== null && captured.type === 'general') {
    next.status = 'finished';
    next.winners = [player];
    next.scores[player] += 1;
    next.currentPlayer = player;
  } else {
    next.currentPlayer = player === RED ? BLACK : RED;
  }

  return next;
}

export function listLegalActions(position) {
  assertPosition(position);
  if (position.status === 'finished') return [];

  const player = position.currentPlayer;
  const actions = [];
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLUMNS; x += 1) {
      const piece = position.board[y][x];
      if (piece === null || piece.owner !== player) continue;
      const from = xyToCoordinate(x, y);
      for (const target of pieceMoves(position.board, x, y)) {
        actions.push({
          kind: 'move',
          from,
          to: xyToCoordinate(target.x, target.y),
        });
      }
    }
  }

  return actions.sort((a, b) => {
    const [aFrom, bFrom] = [coordinateToXY(a.from), coordinateToXY(b.from)];
    const [aTo, bTo] = [coordinateToXY(a.to), coordinateToXY(b.to)];
    return (aFrom.y - bFrom.y)
      || (aFrom.x - bFrom.x)
      || (aTo.y - bTo.y)
      || (aTo.x - bTo.x);
  });
}

export function getBoardView(position) {
  assertPosition(position);
  const cells = [];
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLUMNS; x += 1) {
      const piece = position.board[y][x];
      cells.push({
        x,
        y,
        value: piece === null ? null : piece.type,
        owner: piece === null ? null : piece.owner,
        label: piece === null ? '' : labelFor(piece),
      });
    }
  }
  return { rows: ROWS, columns: COLUMNS, cells };
}

export function positionToText(position) {
  assertPosition(position);
  const lines = [];
  const scoreLine = `红 ${position.scores[RED]} - 黑 ${position.scores[BLACK]}`;
  const winnerLine = position.winners.length === 0
    ? '无'
    : position.winners.map((player) => (player === RED ? '红方' : '黑方')).join('、');

  lines.push('中国象棋（简化规则）');
  lines.push(`状态: ${position.status} | 当前行棋: ${position.currentPlayer}（${position.currentPlayer === RED ? '红' : '黑'}） | 比分: ${scoreLine} | 胜者: ${winnerLine}`);
  lines.push('坐标: 列 a-i，行 0-9；每个格子坐标为“列字母+行号”。红方(0)在下，黑方(1)在上。');
  lines.push(`    ${FILE_LETTERS.split('').join(' ')}`);
  for (let y = 0; y < ROWS; y += 1) {
    const cells = position.board[y].map((piece) => (piece === null ? '·' : labelFor(piece)));
    lines.push(`${String(y).padStart(2, ' ')}  ${cells.join(' ')}`);
  }

  const occupied = [];
  for (let y = 0; y < ROWS; y += 1) {
    for (let x = 0; x < COLUMNS; x += 1) {
      const piece = position.board[y][x];
      if (piece !== null) {
        occupied.push({
          owner: piece.owner,
          text: `${labelFor(piece)}${xyToCoordinate(x, y)}`,
        });
      }
    }
  }
  for (const owner of PLAYERS) {
    const name = owner === RED ? '红方' : '黑方';
    const pieces = occupied
      .filter((item) => item.owner === owner)
      .map((item) => item.text)
      .join(' ');
    lines.push(`${name}: ${pieces}`);
  }

  return `${lines.join('\n')}\n`;
}
