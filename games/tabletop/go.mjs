export const GAME_TYPE = 'go';
export const BOARD_SIZE = 9;
export const BLACK = 0;
export const WHITE = 1;

const STATUS_PLAYING = 'playing';
const STATUS_FINISHED = 'finished';
const COLUMN_LABELS = 'ABCDEFGHJ';
const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
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

function other(player) {
  return player === BLACK ? WHITE : BLACK;
}

function createBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function boardKey(board) {
  let key = '';
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const value = board[y][x];
      key += value === null ? '.' : String(value);
    }
  }
  return key;
}

function neighbors(x, y) {
  const result = [];
  for (const [dx, dy] of DIRECTIONS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < BOARD_SIZE && ny >= 0 && ny < BOARD_SIZE) {
      result.push([nx, ny]);
    }
  }
  return result;
}

export function createPosition() {
  return {
    schemaVersion: 1,
    gameType: GAME_TYPE,
    boardSize: BOARD_SIZE,
    board: createBoard(),
    currentPlayer: BLACK,
    status: STATUS_PLAYING,
    winners: [],
    scores: [0, 0],
    passCount: 0,
    previousBoard: null,
    moves: [],
  };
}

function assertPosition(position) {
  if (position === null || typeof position !== 'object' || Array.isArray(position)) {
    fail('POSITION_INVALID', 'position must be a state object');
  }
  if (position.gameType !== GAME_TYPE) {
    fail('POSITION_INVALID', `unsupported game type: ${String(position.gameType)}`);
  }
  if (position.boardSize !== BOARD_SIZE) {
    fail('POSITION_INVALID', `unsupported board size: ${String(position.boardSize)}`);
  }
  if (!Array.isArray(position.board) || position.board.length !== BOARD_SIZE) {
    fail('POSITION_INVALID', `board must contain exactly ${BOARD_SIZE} rows`);
  }
  for (const row of position.board) {
    if (!Array.isArray(row) || row.length !== BOARD_SIZE) {
      fail('POSITION_INVALID', `each board row must contain exactly ${BOARD_SIZE} cells`);
    }
    for (const value of row) {
      if (value !== null && value !== BLACK && value !== WHITE) {
        fail('POSITION_INVALID', 'board cells must be null, 0 or 1');
      }
    }
  }
  if (position.currentPlayer !== BLACK && position.currentPlayer !== WHITE) {
    fail('POSITION_INVALID', `invalid current player: ${String(position.currentPlayer)}`);
  }
  if (position.status !== STATUS_PLAYING && position.status !== STATUS_FINISHED) {
    fail('POSITION_INVALID', `unknown status: ${String(position.status)}`);
  }
  if (
    !Array.isArray(position.scores) || position.scores.length !== 2
    || !position.scores.every((score) => Number.isInteger(score) && score >= 0)
  ) {
    fail('POSITION_INVALID', 'scores must be two non-negative integers');
  }
  if (!Array.isArray(position.winners)) {
    fail('POSITION_INVALID', 'winners must be an array');
  }
  if (!Number.isInteger(position.passCount) || position.passCount < 0) {
    fail('POSITION_INVALID', 'passCount must be a non-negative integer');
  }
  if (position.previousBoard !== null && typeof position.previousBoard !== 'string') {
    fail('POSITION_INVALID', 'previousBoard must be null or a board signature');
  }
  if (!Array.isArray(position.moves)) {
    fail('POSITION_INVALID', 'moves must be an array');
  }
}

export function normalizeAction(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('ACTION_INVALID', 'action must be an object');
  }
  if (input.kind === 'pass') {
    return { kind: 'pass' };
  }
  if (input.kind !== 'place') {
    fail('ACTION_INVALID', `unknown action kind: ${String(input.kind)}`);
  }
  if (!Number.isInteger(input.x) || !Number.isInteger(input.y)) {
    fail('ACTION_INVALID', 'place action requires integer x and y');
  }
  if (input.x < 0 || input.x >= BOARD_SIZE || input.y < 0 || input.y >= BOARD_SIZE) {
    fail('ACTION_INVALID', `point out of bounds: (${input.x}, ${input.y})`);
  }
  return { kind: 'place', x: input.x, y: input.y };
}

function getGroup(board, startX, startY) {
  const color = board[startY][startX];
  const stones = [];
  const liberties = new Set();
  const visited = new Set();
  const stack = [[startX, startY]];
  visited.add(startY * BOARD_SIZE + startX);
  while (stack.length > 0) {
    const [x, y] = stack.pop();
    stones.push([x, y]);
    for (const [nx, ny] of neighbors(x, y)) {
      const value = board[ny][nx];
      if (value === null) {
        liberties.add(ny * BOARD_SIZE + nx);
      } else if (value === color && !visited.has(ny * BOARD_SIZE + nx)) {
        visited.add(ny * BOARD_SIZE + nx);
        stack.push([nx, ny]);
      }
    }
  }
  return { stones, liberties: liberties.size };
}

function placeStone(board, x, y, player) {
  if (board[y][x] !== null) {
    return { error: 'occupied' };
  }
  const next = cloneBoard(board);
  next[y][x] = player;

  let captures = 0;
  for (const [nx, ny] of neighbors(x, y)) {
    if (next[ny][nx] !== other(player)) continue;
    const group = getGroup(next, nx, ny);
    if (group.liberties === 0) {
      for (const [gx, gy] of group.stones) {
        next[gy][gx] = null;
      }
      captures += group.stones.length;
    }
  }

  if (getGroup(next, x, y).liberties === 0) {
    return { error: 'suicide' };
  }
  return { board: next, captures };
}

function computeTerritory(board) {
  const owners = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
  const visited = Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(false));

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (board[y][x] !== null || visited[y][x]) continue;
      const region = [];
      const borderColors = new Set();
      const stack = [[x, y]];
      visited[y][x] = true;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        region.push([cx, cy]);
        for (const [nx, ny] of neighbors(cx, cy)) {
          const value = board[ny][nx];
          if (value === null) {
            if (!visited[ny][nx]) {
              visited[ny][nx] = true;
              stack.push([nx, ny]);
            }
          } else {
            borderColors.add(value);
          }
        }
      }
      if (borderColors.size === 1) {
        const [owner] = borderColors;
        for (const [rx, ry] of region) owners[ry][rx] = owner;
      }
    }
  }
  return owners;
}

function computeScores(board) {
  const owners = computeTerritory(board);
  const scores = [0, 0];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const value = board[y][x];
      if (value !== null) {
        scores[value] += 1;
      } else if (owners[y][x] !== null) {
        scores[owners[y][x]] += 1;
      }
    }
  }
  return scores;
}

function finishPosition(position) {
  const scores = computeScores(position.board);
  position.status = STATUS_FINISHED;
  position.scores = scores;
  const best = Math.max(...scores);
  position.winners = [BLACK, WHITE].filter((player) => scores[player] === best);
}

export function applyTurn(position, { player, action } = {}) {
  assertPosition(position);
  if (position.status === STATUS_FINISHED) {
    fail('GAME_FINISHED', 'game is already finished');
  }
  if (!Number.isInteger(player) || (player !== BLACK && player !== WHITE)) {
    fail('PLAYER_INVALID', `invalid player: ${String(player)}`);
  }
  if (player !== position.currentPlayer) {
    fail(
      'GAME_NOT_YOUR_TURN',
      `player ${player} cannot act; it is player ${position.currentPlayer}'s turn`,
    );
  }
  const normalized = normalizeAction(action);

  const next = {
    ...position,
    board: cloneBoard(position.board),
    scores: [...position.scores],
    winners: [...position.winners],
    moves: [...position.moves],
  };
  const seq = next.moves.length + 1;

  if (normalized.kind === 'pass') {
    next.moves.push({ seq, player, kind: 'pass' });
    next.passCount = position.passCount + 1;
    next.previousBoard = null;
    next.currentPlayer = other(player);
    if (next.passCount >= 2) finishPosition(next);
    return next;
  }

  const result = placeStone(position.board, normalized.x, normalized.y, player);
  if (result.error === 'occupied') {
    fail('POINT_OCCUPIED', `point (${normalized.x}, ${normalized.y}) is already occupied`);
  }
  if (result.error === 'suicide') {
    fail('SUICIDE', `placing at (${normalized.x}, ${normalized.y}) would leave no liberties`);
  }
  if (boardKey(result.board) === position.previousBoard) {
    fail('KO', 'move would repeat the position before the previous move');
  }

  next.board = result.board;
  next.passCount = 0;
  next.previousBoard = boardKey(position.board);
  next.currentPlayer = other(player);
  next.moves.push({
    seq,
    player,
    kind: 'place',
    x: normalized.x,
    y: normalized.y,
    captures: result.captures,
  });
  return next;
}

export function listLegalActions(position) {
  assertPosition(position);
  if (position.status === STATUS_FINISHED) return [];

  const actions = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      if (position.board[y][x] !== null) continue;
      const result = placeStone(position.board, x, y, position.currentPlayer);
      if (result.error) continue;
      if (boardKey(result.board) === position.previousBoard) continue;
      actions.push({ kind: 'place', x, y });
    }
  }
  actions.push({ kind: 'pass' });
  return actions;
}

function cellLabel(value, owner) {
  if (value !== null) return value === BLACK ? 'B' : 'W';
  if (owner === BLACK) return 'b';
  if (owner === WHITE) return 'w';
  return '.';
}

export function getBoardView(position) {
  assertPosition(position);
  const owners = computeTerritory(position.board);
  const cells = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const value = position.board[y][x];
      const owner = value === null ? owners[y][x] : value;
      cells.push({ x, y, value, owner, label: cellLabel(value, owner) });
    }
  }
  return { rows: BOARD_SIZE, columns: BOARD_SIZE, cells };
}

export function positionToText(position) {
  assertPosition(position);
  const view = getBoardView(position);
  const header = `   ${COLUMN_LABELS.split('').join(' ')}`;
  const lines = [header];
  for (let y = BOARD_SIZE - 1; y >= 0; y -= 1) {
    const labels = [];
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      labels.push(view.cells[y * BOARD_SIZE + x].label);
    }
    lines.push(`${y + 1}  ${labels.join(' ')}`);
  }
  lines.push(header);

  if (position.status === STATUS_FINISHED) {
    const outcome = position.winners.length === 2
      ? 'draw'
      : position.winners[0] === BLACK ? 'Black wins' : 'White wins';
    lines.push(
      `Finished - Black ${position.scores[BLACK]}, White ${position.scores[WHITE]} (${outcome})`,
    );
  } else {
    lines.push(`${position.currentPlayer === BLACK ? 'Black' : 'White'} to play`);
  }
  lines.push('B/W stones, b/w territory, . neutral (no komi, simplified rules)');
  return lines.join('\n');
}
