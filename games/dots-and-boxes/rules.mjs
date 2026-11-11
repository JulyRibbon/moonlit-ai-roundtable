export const BOARD_SIZE = 4;
export const PLAYER_COUNT = 4;

const EDGE_COUNT = 2 * BOARD_SIZE * (BOARD_SIZE + 1);

const EDGE_PATTERN = /^([hv]):(\d+):(\d+)$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

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

function parseEdge(edge) {
  if (typeof edge !== 'string') return null;
  const match = EDGE_PATTERN.exec(edge);
  if (!match) return null;
  const [, orientation, xs, ys] = match;
  const x = Number(xs);
  const y = Number(ys);
  if (orientation === 'h') {
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y > BOARD_SIZE) return null;
  } else if (x < 0 || x > BOARD_SIZE || y < 0 || y >= BOARD_SIZE) {
    return null;
  }
  return { orientation, x, y };
}

function parseBox(boxId) {
  if (typeof boxId !== 'string') return null;
  const match = /^b:(\d+):(\d+)$/.exec(boxId);
  if (!match) return null;
  const x = Number(match[1]);
  const y = Number(match[2]);
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return null;
  return { x, y };
}

export function listEdges() {
  const edges = [];
  for (let y = 0; y <= BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      edges.push(`h:${x}:${y}`);
    }
  }
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x <= BOARD_SIZE; x += 1) {
      edges.push(`v:${x}:${y}`);
    }
  }
  return edges;
}

export function listBoxes() {
  const boxes = [];
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      boxes.push(`b:${x}:${y}`);
    }
  }
  return boxes;
}

export function getBoxEdges(boxId) {
  const box = parseBox(boxId);
  if (!box) fail('BOX_INVALID', `invalid box id: ${String(boxId)}`);
  const { x, y } = box;
  return [
    `h:${x}:${y}`,
    `h:${x}:${y + 1}`,
    `v:${x}:${y}`,
    `v:${x + 1}:${y}`,
  ];
}

function validatePlayers(players) {
  if (!Array.isArray(players) || players.length !== PLAYER_COUNT) {
    fail('PLAYERS_INVALID', `players must contain exactly ${PLAYER_COUNT} entries`);
  }
  const seenSlots = new Set();
  const seenSeatIds = new Set();
  const normalized = players.map((player) => {
    if (player === null || typeof player !== 'object') {
      fail('PLAYERS_INVALID', 'each player must be an object');
    }
    const { slot, kind, name, color, seatId = null, nativeSessionRef = null } = player;
    if (!Number.isInteger(slot) || slot < 0 || slot >= PLAYER_COUNT) {
      fail('PLAYERS_INVALID', `invalid player slot: ${String(slot)}`);
    }
    if (seenSlots.has(slot)) {
      fail('PLAYERS_INVALID', `duplicate player slot: ${slot}`);
    }
    seenSlots.add(slot);
    if (kind !== 'human' && kind !== 'ai') {
      fail('PLAYERS_INVALID', `invalid player kind for slot ${slot}`);
    }
    if (typeof name !== 'string' || name.length === 0) {
      fail('PLAYERS_INVALID', `player ${slot} must have a non-empty name`);
    }
    if (typeof color !== 'string' || !COLOR_PATTERN.test(color)) {
      fail('PLAYERS_INVALID', `player ${slot} must have a #RRGGBB color`);
    }
    if (seatId !== null && (typeof seatId !== 'string' || seatId.length === 0)) {
      fail('PLAYERS_INVALID', `player ${slot} has an invalid seatId`);
    }
    if (
      nativeSessionRef !== null
      && (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0)
    ) {
      fail('PLAYERS_INVALID', `player ${slot} has an invalid nativeSessionRef`);
    }
    if (kind === 'human') {
      if (seatId !== null || nativeSessionRef !== null) {
        fail('PLAYERS_INVALID', `human player ${slot} cannot own a seat or session`);
      }
    } else {
      if (seatId === null) {
        fail('PLAYERS_INVALID', `ai player ${slot} requires a seatId`);
      }
      if (seenSeatIds.has(seatId)) {
        fail('PLAYERS_INVALID', `duplicate ai seatId: ${seatId}`);
      }
      seenSeatIds.add(seatId);
    }
    return { slot, kind, name, color, seatId, nativeSessionRef };
  });
  if (seenSlots.size !== PLAYER_COUNT) {
    fail('PLAYERS_INVALID', 'duplicate player slots');
  }
  return normalized.sort((a, b) => a.slot - b.slot);
}

export function createGame({ gameId, players, createdAt } = {}) {
  if (typeof gameId !== 'string' || gameId.length === 0) {
    fail('GAME_ID_INVALID', 'gameId must be a non-empty string');
  }
  if (typeof createdAt !== 'string' || createdAt.length === 0) {
    fail('TIMESTAMP_INVALID', 'createdAt must be a non-empty string');
  }
  const normalizedPlayers = validatePlayers(players);
  return {
    schemaVersion: 1,
    gameId,
    boardSize: BOARD_SIZE,
    status: 'playing',
    players: normalizedPlayers,
    edges: {},
    boxes: {},
    currentPlayer: 0,
    scores: Array.from({ length: PLAYER_COUNT }, () => 0),
    moves: [],
    winners: [],
    createdAt,
    updatedAt: createdAt,
    revision: 0,
  };
}

function assertPlayable(game) {
  if (game === null || typeof game !== 'object' || Array.isArray(game)) {
    fail('GAME_INVALID', 'game must be a state object');
  }
  if (game.schemaVersion !== 1) {
    fail('GAME_INVALID', `unsupported schemaVersion: ${String(game.schemaVersion)}`);
  }
  if (game.status === 'finished') {
    fail('GAME_FINISHED', 'game is already finished');
  }
  if (game.status !== 'playing') {
    fail('GAME_INVALID', `unknown game status: ${String(game.status)}`);
  }
  if (
    game.edges === null || typeof game.edges !== 'object'
    || game.boxes === null || typeof game.boxes !== 'object'
    || !Array.isArray(game.moves)
    || !Array.isArray(game.scores)
  ) {
    fail('GAME_INVALID', 'game state is malformed');
  }
}

function owns(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function winnersFrom(scores) {
  const best = Math.max(...scores);
  const winners = [];
  for (let index = 0; index < scores.length; index += 1) {
    if (scores[index] === best) winners.push(index);
  }
  return winners;
}

export const MOVE_COMMENT_MAX_LENGTH = 160;

function normalizeComment(comment) {
  if (typeof comment !== 'string') return '';
  return comment.trim().slice(0, MOVE_COMMENT_MAX_LENGTH);
}

export function applyMove(game, { player, edge, at, comment } = {}) {
  assertPlayable(game);
  if (!Number.isInteger(player) || player < 0 || player >= PLAYER_COUNT) {
    fail('PLAYER_INVALID', `invalid player index: ${String(player)}`);
  }
  if (player !== game.currentPlayer) {
    fail('GAME_NOT_YOUR_TURN', `player ${player} cannot move; it is player ${game.currentPlayer}'s turn`);
  }
  if (!parseEdge(edge)) {
    fail('EDGE_INVALID', `invalid edge id: ${String(edge)}`);
  }
  if (owns(game.edges, edge)) {
    fail('EDGE_OCCUPIED', `edge ${edge} is already occupied`);
  }
  if (typeof at !== 'string' || at.length === 0) {
    fail('TIMESTAMP_INVALID', 'at must be a non-empty string');
  }

  const next = structuredClone(game);
  next.edges[edge] = player;

  const completedBoxes = [];
  for (const boxId of listBoxes()) {
    if (owns(next.boxes, boxId)) continue;
    const boxEdges = getBoxEdges(boxId);
    if (boxEdges.every((boxEdge) => owns(next.edges, boxEdge))) {
      next.boxes[boxId] = player;
      next.scores[player] += 1;
      completedBoxes.push(boxId);
    }
  }

  next.moves.push({
    seq: next.moves.length + 1,
    player,
    edge,
    completedBoxes,
    at,
    comment: normalizeComment(comment),
  });
  next.currentPlayer = completedBoxes.length > 0
    ? player
    : (player + 1) % PLAYER_COUNT;
  next.revision += 1;
  next.updatedAt = at;

  if (Object.keys(next.edges).length === EDGE_COUNT) {
    next.status = 'finished';
    next.winners = winnersFrom(next.scores);
  }

  return next;
}

export function listAvailableEdges(game) {
  if (game === null || typeof game !== 'object' || game.edges === null || typeof game.edges !== 'object') {
    fail('GAME_INVALID', 'game state is malformed');
  }
  return listEdges().filter((edge) => !owns(game.edges, edge));
}
