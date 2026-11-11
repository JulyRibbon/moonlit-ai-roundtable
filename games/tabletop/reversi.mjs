export const GAME_TYPE = 'reversi';
export const BOARD_SIZE = 8;
export const BLACK = 0;
export const WHITE = 1;

const EMPTY = null;
const DIRECTIONS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

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
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
}

function inBounds(x, y) {
  return Number.isInteger(x) && Number.isInteger(y)
    && x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;
}

function countScores(board) {
  const scores = [0, 0];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const value = board[y][x];
      if (value === BLACK || value === WHITE) scores[value] += 1;
    }
  }
  return scores;
}

function winnersFrom(scores) {
  if (scores[BLACK] === scores[WHITE]) return [BLACK, WHITE];
  return [scores[BLACK] > scores[WHITE] ? BLACK : WHITE];
}

function boardIsFull(board) {
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] === EMPTY) return false;
    }
  }
  return true;
}

function collectFlips(board, x, y, player) {
  if (board[y][x] !== EMPTY) return [];
  const opponent = player === BLACK ? WHITE : BLACK;
  const flips = [];
  for (const [dx, dy] of DIRECTIONS) {
    const line = [];
    let cx = x + dx;
    let cy = y + dy;
    while (inBounds(cx, cy) && board[cy][cx] === opponent) {
      line.push({ x: cx, y: cy });
      cx += dx;
      cy += dy;
    }
    if (line.length > 0 && inBounds(cx, cy) && board[cy][cx] === player) {
      flips.push(...line);
    }
  }
  return flips;
}

function hasLegalMove(board, player) {
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] === EMPTY && collectFlips(board, x, y, player).length > 0) {
        return true;
      }
    }
  }
  return false;
}

function assertBoard(board) {
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    fail('POSITION_INVALID', 'board must be an 8x8 array');
  }
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      fail('POSITION_INVALID', 'board must be an 8x8 array');
    }
    for (const value of row) {
      if (value !== EMPTY && value !== BLACK && value !== WHITE) {
        fail('POSITION_INVALID', `invalid board value: ${String(value)}`);
      }
    }
  }
}

function assertPosition(position) {
  if (position === null || typeof position !== 'object' || Array.isArray(position)) {
    fail('POSITION_INVALID', 'position must be a state object');
  }
  if (position.gameType !== undefined && position.gameType !== GAME_TYPE) {
    fail('POSITION_INVALID', `unexpected game type: ${String(position.gameType)}`);
  }
  assertBoard(position.board);
  if (position.currentPlayer !== BLACK && position.currentPlayer !== WHITE) {
    fail('POSITION_INVALID', 'currentPlayer must be 0 or 1');
  }
  if (position.status !== 'playing' && position.status !== 'finished') {
    fail('POSITION_INVALID', `unknown status: ${String(position.status)}`);
  }
  if (!Array.isArray(position.winners)) {
    fail('POSITION_INVALID', 'winners must be an array');
  }
  if (
    !Array.isArray(position.scores)
    || position.scores.length !== 2
    || position.scores.some((score) => !Number.isInteger(score) || score < 0)
  ) {
    fail('POSITION_INVALID', 'scores must be two non-negative integers');
  }
  if (position.moves !== undefined && !Array.isArray(position.moves)) {
    fail('POSITION_INVALID', 'moves must be an array');
  }
}

export function createPosition() {
  const board = createEmptyBoard();
  board[3][3] = BLACK;
  board[3][4] = WHITE;
  board[4][3] = WHITE;
  board[4][4] = BLACK;
  return {
    gameType: GAME_TYPE,
    board,
    currentPlayer: BLACK,
    status: 'playing',
    winners: [],
    scores: countScores(board),
    revision: 0,
    moves: [],
  };
}

export function normalizeAction(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('ACTION_INVALID', 'action must be an object');
  }
  if (input.kind !== 'place') {
    fail('ACTION_INVALID', 'only place actions are accepted; passing is automatic');
  }
  const { x, y } = input;
  if (!inBounds(x, y)) {
    fail('COORDINATE_INVALID', `invalid coordinate: ${String(x)},${String(y)}`);
  }
  return { kind: 'place', x, y };
}

export function listLegalActions(position) {
  assertPosition(position);
  if (position.status === 'finished') return [];
  const actions = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (
        position.board[y][x] === EMPTY
        && collectFlips(position.board, x, y, position.currentPlayer).length > 0
      ) {
        actions.push({ kind: 'place', x, y });
      }
    }
  }
  return actions;
}

export function applyTurn(position, { player, action } = {}) {
  assertPosition(position);
  if (position.status === 'finished') {
    fail('GAME_FINISHED', 'game is already finished');
  }
  if (player !== BLACK && player !== WHITE) {
    fail('PLAYER_INVALID', `invalid player index: ${String(player)}`);
  }
  if (player !== position.currentPlayer) {
    fail(
      'GAME_NOT_YOUR_TURN',
      `player ${player} cannot move; it is player ${position.currentPlayer}'s turn`,
    );
  }
  const normalized = normalizeAction(action);
  const { x, y } = normalized;
  if (position.board[y][x] !== EMPTY) {
    fail('POSITION_OCCUPIED', `position ${x},${y} is already occupied`);
  }
  const flips = collectFlips(position.board, x, y, player);
  if (flips.length === 0) {
    fail('ILLEGAL_MOVE', `placing at ${x},${y} does not flip any disc`);
  }

  const next = structuredClone(position);
  next.gameType = GAME_TYPE;
  next.board[y][x] = player;
  for (const flip of flips) {
    next.board[flip.y][flip.x] = player;
  }
  next.scores = countScores(next.board);
  next.revision = (position.revision ?? 0) + 1;
  next.moves = Array.isArray(position.moves) ? [...position.moves] : [];

  const opponent = player === BLACK ? WHITE : BLACK;
  const passed = [];
  if (boardIsFull(next.board)) {
    next.status = 'finished';
    next.currentPlayer = opponent;
    next.winners = winnersFrom(next.scores);
  } else if (hasLegalMove(next.board, opponent)) {
    next.status = 'playing';
    next.currentPlayer = opponent;
    next.winners = [];
  } else if (hasLegalMove(next.board, player)) {
    next.status = 'playing';
    next.currentPlayer = player;
    next.winners = [];
    passed.push(opponent);
  } else {
    next.status = 'finished';
    next.currentPlayer = opponent;
    next.winners = winnersFrom(next.scores);
  }

  next.moves.push({
    seq: next.moves.length + 1,
    player,
    action: normalized,
    flips,
    passed,
  });
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
        owner: value,
        label: value === BLACK ? '●' : (value === WHITE ? '○' : '.'),
      });
    }
  }
  return { rows: BOARD_SIZE, columns: BOARD_SIZE, cells };
}

export function positionToText(position) {
  assertPosition(position);
  const columnLabels = Array.from(
    { length: BOARD_SIZE },
    (_, x) => String.fromCharCode(97 + x),
  );
  const lines = [`  ${columnLabels.join(' ')}`];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const glyphs = position.board[y].map(
      (value) => (value === BLACK ? '●' : (value === WHITE ? '○' : '.')),
    );
    lines.push(`${BOARD_SIZE - y} ${glyphs.join(' ')}`);
  }
  lines.push(`  ${columnLabels.join(' ')}`);
  return lines.join('\n');
}
