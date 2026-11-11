/**
 * 双人 15x15 五子棋基础规则。
 *
 * 接口约定：
 * - position.board 为 15x15 的二维数组，board[y][x]，空点为 null，黑为 0，白为 1。
 * - 黑方（0）先行，双方轮流落子，无禁手。
 * - 任意方向（横、竖、两条斜线）连续五子或以上即胜。
 * - 满盘且无五连为平局。
 * - winners：对局进行中或平局时为 []，获胜时为 [player]。
 * - scores：双方已落子数，scores[0] 为黑，scores[1] 为白。
 * - 所有返回 position 的函数都不修改入参，返回新对象。
 */

export const GAME_TYPE = 'gomoku';
export const BOARD_SIZE = 15;
export const PLAYER_COUNT = 2;
export const WIN_LENGTH = 5;

const CELL_EMPTY = null;
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
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

function isPlayer(value) {
  return Number.isInteger(value) && value >= 0 && value < PLAYER_COUNT;
}

function isCellValue(value) {
  return value === CELL_EMPTY || isPlayer(value);
}

export function createPosition() {
  return {
    schemaVersion: 1,
    gameType: GAME_TYPE,
    board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(CELL_EMPTY)),
    currentPlayer: 0,
    status: 'playing',
    winners: [],
    scores: [0, 0],
  };
}

function assertPosition(position) {
  if (position === null || typeof position !== 'object' || Array.isArray(position)) {
    fail('POSITION_INVALID', 'position must be a state object');
  }
  const { board, currentPlayer, status, winners, scores } = position;
  if (!Array.isArray(board) || board.length !== BOARD_SIZE) {
    fail('POSITION_INVALID', `board must have ${BOARD_SIZE} rows`);
  }
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const row = board[y];
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      fail('POSITION_INVALID', `board row ${y} must have ${BOARD_SIZE} cells`);
    }
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (!isCellValue(row[x])) {
        fail('POSITION_INVALID', `board cell ${x},${y} has an invalid value`);
      }
    }
  }
  if (!isPlayer(currentPlayer)) {
    fail('POSITION_INVALID', `invalid currentPlayer: ${String(currentPlayer)}`);
  }
  if (status !== 'playing' && status !== 'finished') {
    fail('POSITION_INVALID', `unknown status: ${String(status)}`);
  }
  if (!Array.isArray(winners) || winners.length > PLAYER_COUNT || !winners.every(isPlayer)) {
    fail('POSITION_INVALID', 'winners must be an array of player indexes');
  }
  if (
    !Array.isArray(scores)
    || scores.length !== PLAYER_COUNT
    || !scores.every((score) => Number.isInteger(score) && score >= 0)
  ) {
    fail('POSITION_INVALID', 'scores must contain one non-negative integer per player');
  }
}

export function normalizeAction(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('ACTION_INVALID', 'action must be an object');
  }
  const { kind, x, y } = input;
  if (kind !== 'place') {
    fail('ACTION_INVALID', `unsupported action kind: ${String(kind)}`);
  }
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    fail('ACTION_INVALID', 'action coordinates must be integers');
  }
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
    fail('ACTION_INVALID', `action coordinates out of bounds: ${x},${y}`);
  }
  return { kind: 'place', x, y };
}

function countRun(board, x, y, dx, dy, player) {
  let length = 1;
  for (const sign of [1, -1]) {
    let nx = x + dx * sign;
    let ny = y + dy * sign;
    while (
      nx >= 0 && nx < BOARD_SIZE
      && ny >= 0 && ny < BOARD_SIZE
      && board[ny][nx] === player
    ) {
      length += 1;
      nx += dx * sign;
      ny += dy * sign;
    }
  }
  return length;
}

function hasWon(board, x, y, player) {
  return DIRECTIONS.some(([dx, dy]) => countRun(board, x, y, dx, dy, player) >= WIN_LENGTH);
}

function isBoardFull(board) {
  return board.every((row) => row.every((cell) => cell !== CELL_EMPTY));
}

export function applyTurn(position, { player, action } = {}) {
  assertPosition(position);
  if (position.status !== 'playing') {
    fail('GAME_FINISHED', 'game is already finished');
  }
  if (!isPlayer(player)) {
    fail('PLAYER_INVALID', `invalid player index: ${String(player)}`);
  }
  if (player !== position.currentPlayer) {
    fail('GAME_NOT_YOUR_TURN', `player ${player} cannot move; it is player ${position.currentPlayer}'s turn`);
  }
  const normalized = normalizeAction(action);
  const { x, y } = normalized;
  if (position.board[y][x] !== CELL_EMPTY) {
    fail('CELL_OCCUPIED', `cell ${x},${y} is already occupied`);
  }

  const next = structuredClone(position);
  next.board[y][x] = player;
  next.scores[player] += 1;

  if (hasWon(next.board, x, y, player)) {
    next.status = 'finished';
    next.winners = [player];
  } else if (isBoardFull(next.board)) {
    next.status = 'finished';
    next.winners = [];
  } else {
    next.currentPlayer = (player + 1) % PLAYER_COUNT;
  }

  return next;
}

export function listLegalActions(position) {
  assertPosition(position);
  if (position.status !== 'playing') return [];
  const actions = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (position.board[y][x] === CELL_EMPTY) {
        actions.push({ kind: 'place', x, y });
      }
    }
  }
  return actions;
}

export function positionToText(position) {
  assertPosition(position);
  const header = ['   '];
  for (let x = 0; x < BOARD_SIZE; x += 1) {
    header.push(String(x).padStart(3));
  }
  const lines = [header.join('')];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    const cells = [String(y).padStart(2) + ' '];
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const value = position.board[y][x];
      const symbol = value === CELL_EMPTY ? '.' : (value === 0 ? 'X' : 'O');
      cells.push(symbol.padStart(3));
    }
    lines.push(cells.join(''));
  }
  return lines.join('\n');
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
        label: value === CELL_EMPTY ? '' : (value === 0 ? '黑' : '白'),
      });
    }
  }
  return { rows: BOARD_SIZE, columns: BOARD_SIZE, cells };
}
