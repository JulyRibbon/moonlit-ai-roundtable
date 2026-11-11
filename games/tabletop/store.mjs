import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  TABLETOP_PLAYER_COUNT,
  getTabletopEngine,
  isTabletopType,
} from './engine.mjs';

export const TABLETOP_STORE_SCHEMA_VERSION = 1;

export class TabletopStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message ?? code);
    this.name = 'TabletopStoreError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TabletopStoreError);
    }
  }
}

const WRITE_QUEUES = new Map();

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TabletopStoreError('STORE_ARGUMENT_INVALID', `${field} 必须是非空字符串。`);
  }
  return value;
}

function enqueueWrite(key, task) {
  const previous = WRITE_QUEUES.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  WRITE_QUEUES.set(key, current);
  current
    .finally(() => {
      if (WRITE_QUEUES.get(key) === current) WRITE_QUEUES.delete(key);
    })
    .catch(() => {});
  return current;
}

export function tabletopStorePath({ storeDir, roomId, gameType } = {}) {
  requireNonEmptyString(storeDir, 'storeDir');
  requireNonEmptyString(roomId, 'roomId');
  if (!isTabletopType(gameType)) {
    throw new TabletopStoreError(
      'TABLETOP_TYPE_UNKNOWN',
      `未知的桌面对局类型：${String(gameType)}。`,
    );
  }
  return path.join(path.resolve(storeDir), roomId, 'games', 'tabletop', `${gameType}.json`);
}

function normalizePlayer(player, index) {
  if (!isPlainObject(player)) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `players[${index}] 必须是对象。`);
  }
  const { slot, kind, name, color, seatId, nativeSessionRef } = player;
  if (!Number.isInteger(slot) || slot < 0 || slot >= TABLETOP_PLAYER_COUNT) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `players[${index}] 的 slot 无效。`);
  }
  if (kind !== 'human' && kind !== 'ai') {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `players[${index}] 的 kind 无效。`);
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `players[${index}] 的 name 无效。`);
  }
  if (typeof color !== 'string' || color.length === 0) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `players[${index}] 的 color 无效。`);
  }
  if (seatId !== null && seatId !== undefined && (typeof seatId !== 'string' || seatId.length === 0)) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `players[${index}] 的 seatId 无效。`);
  }
  if (
    nativeSessionRef !== null
    && nativeSessionRef !== undefined
    && (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0)
  ) {
    throw new TabletopStoreError(
      'STORE_RECORD_INVALID',
      `players[${index}] 的 nativeSessionRef 无效。`,
    );
  }
  return {
    slot,
    kind,
    name,
    color,
    seatId: seatId ?? null,
    nativeSessionRef: nativeSessionRef ?? null,
  };
}

function normalizeMove(move, index) {
  if (!isPlainObject(move)) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `moves[${index}] 必须是对象。`);
  }
  const { seq, player, action, at, comment } = move;
  if (!Number.isInteger(seq) || seq !== index + 1) {
    throw new TabletopStoreError(
      'STORE_RECORD_INVALID',
      `moves[${index}] 的 seq 必须等于 ${index + 1}（实际 ${String(seq)}）。`,
    );
  }
  if (!Number.isInteger(player) || player < 0 || player >= TABLETOP_PLAYER_COUNT) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `moves[${index}] 的 player 无效。`);
  }
  if (!isPlainObject(action)) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `moves[${index}] 的 action 必须是对象。`);
  }
  if (typeof at !== 'string' || at.length === 0) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `moves[${index}] 的 at 无效。`);
  }
  if (comment !== undefined && typeof comment !== 'string') {
    throw new TabletopStoreError('STORE_RECORD_INVALID', `moves[${index}] 的 comment 必须是字符串。`);
  }
  return {
    seq,
    player,
    action: structuredClone(action),
    at,
    comment: comment ?? '',
  };
}

function normalizeRecord(game, gameType) {
  if (!isPlainObject(game)) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', 'game 必须是对象。');
  }
  if (game.gameType !== gameType) {
    throw new TabletopStoreError(
      'STORE_RECORD_INVALID',
      `存档 gameType 不匹配：期望 ${gameType}，实际 ${String(game.gameType)}。`,
    );
  }
  if (typeof game.gameId !== 'string' || game.gameId.length === 0) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', 'gameId 必须是非空字符串。');
  }
  if (!Array.isArray(game.players) || game.players.length !== TABLETOP_PLAYER_COUNT) {
    throw new TabletopStoreError(
      'STORE_RECORD_INVALID',
      `players 必须恰好包含 ${TABLETOP_PLAYER_COUNT} 席。`,
    );
  }
  const players = game.players.map(normalizePlayer).sort((a, b) => a.slot - b.slot);
  if (players[0].slot !== 0 || players[1].slot !== 1) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', 'players 的 slot 必须覆盖 0 和 1。');
  }
  if (!Array.isArray(game.moves)) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', 'moves 必须是数组。');
  }
  const moves = game.moves.map(normalizeMove);
  if (typeof game.createdAt !== 'string' || game.createdAt.length === 0) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', 'createdAt 必须是非空字符串。');
  }
  if (typeof game.updatedAt !== 'string' || game.updatedAt.length === 0) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', 'updatedAt 必须是非空字符串。');
  }
  if (!Number.isInteger(game.revision) || game.revision < 0) {
    throw new TabletopStoreError('STORE_RECORD_INVALID', 'revision 必须是非负整数。');
  }
  return {
    gameId: game.gameId,
    gameType,
    players,
    moves,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    revision: game.revision,
  };
}

function rebuildPosition(record, engine) {
  let position = engine.createPosition();
  for (let index = 0; index < record.moves.length; index += 1) {
    const move = record.moves[index];
    try {
      position = engine.applyTurn(position, { player: move.player, action: move.action });
    } catch (error) {
      throw new TabletopStoreError(
        'STORE_MOVE_INVALID',
        `第 ${index + 1} 手无法重放：${error?.message ?? error}`,
        {
          moveIndex: index,
          seq: move.seq,
          player: move.player,
          action: move.action,
          cause: error?.code ?? String(error),
        },
      );
    }
  }
  return position;
}

/**
 * 每类型独立的单文件存档。
 * 磁盘只保存精简对局记录（不含棋盘），load() 时从 createPosition() 起逐手重放。
 * load() 返回 { game, position } 或 null；空档不会创建目录。
 */
export function createTabletopStore(options = {}) {
  const { storeDir, roomId, gameType } = options ?? {};
  const filePath = tabletopStorePath({ storeDir, roomId, gameType });
  const engine = getTabletopEngine(gameType);

  async function load() {
    let text;
    try {
      text = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw new TabletopStoreError(
        'STORE_READ_FAILED',
        `无法读取 ${gameType} 桌面对局存档 ${filePath}：${error?.message ?? error}`,
        { file: filePath, cause: String(error?.code ?? error) },
      );
    }

    let payload;
    try {
      payload = JSON.parse(stripBom(text));
    } catch (error) {
      throw new TabletopStoreError(
        'STORE_JSON_INVALID',
        `${gameType} 桌面对局存档不是合法 JSON：${filePath}`,
        { file: filePath, cause: error?.message ?? String(error) },
      );
    }

    if (!isPlainObject(payload) || payload.schemaVersion !== TABLETOP_STORE_SCHEMA_VERSION) {
      throw new TabletopStoreError(
        'STORE_RECORD_INVALID',
        `桌面对局存档结构无效（需要 {schemaVersion:${TABLETOP_STORE_SCHEMA_VERSION},game}）：${filePath}`,
        { file: filePath },
      );
    }

    const game = normalizeRecord(payload.game, gameType);
    const position = rebuildPosition(game, engine);
    return { game, position };
  }

  async function save(input) {
    const game = normalizeRecord(input, gameType);
    let contents;
    try {
      const payload = {
        schemaVersion: TABLETOP_STORE_SCHEMA_VERSION,
        game,
      };
      const json = JSON.stringify(payload, null, 2);
      if (typeof json !== 'string') {
        throw new TypeError('game record is not JSON serializable');
      }
      contents = `${json}\n`;
    } catch (error) {
      throw new TabletopStoreError(
        'STORE_SERIALIZE_FAILED',
        `无法序列化 ${gameType} 桌面对局存档：${error?.message ?? error}`,
        { file: filePath, cause: error?.message ?? String(error) },
      );
    }

    return enqueueWrite(filePath, async () => {
      const directory = path.dirname(filePath);
      await mkdir(directory, { recursive: true });
      const tempPath = path.join(
        directory,
        `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      let handle = null;
      try {
        handle = await open(tempPath, 'w');
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(tempPath, filePath);
      } catch (error) {
        if (handle !== null) await handle.close().catch(() => {});
        await unlink(tempPath).catch(() => {});
        throw new TabletopStoreError(
          'STORE_WRITE_FAILED',
          `无法写入 ${gameType} 桌面对局存档 ${filePath}：${error?.message ?? error}`,
          { file: filePath, cause: String(error?.code ?? error) },
        );
      }
      return game;
    });
  }

  return { gameType, filePath, load, save };
}
