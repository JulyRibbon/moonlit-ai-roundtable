import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export const GAME_STORE_SCHEMA_VERSION = 1;

export class StoreError extends Error {
  constructor(code, message, details = {}) {
    super(message ?? code);
    this.name = 'StoreError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StoreError);
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

/**
 * 单文件游戏存档：磁盘上只保存 {schemaVersion:1, game}。
 * load() 返回 game 或 null；空档不创建目录，save() 才按需建目录并原子写入。
 */
export function createGameStore(filePath) {
  if (typeof filePath !== 'string' || filePath.trim().length === 0) {
    throw new StoreError('STORE_PATH_INVALID', 'createGameStore() requires a non-empty filePath.');
  }
  const resolved = path.resolve(filePath);

  async function load() {
    let text;
    try {
      text = await readFile(resolved, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
      throw new StoreError('STORE_READ_FAILED', `无法读取游戏存档 ${resolved}：${error?.message ?? error}`, {
        file: resolved,
        cause: String(error?.code ?? error),
      });
    }

    let record;
    try {
      record = JSON.parse(stripBom(text));
    } catch (error) {
      throw new StoreError('STORE_JSON_INVALID', `游戏存档不是合法 JSON：${resolved}`, {
        file: resolved,
        cause: error?.message ?? String(error),
      });
    }

    if (!isPlainObject(record)
      || record.schemaVersion !== GAME_STORE_SCHEMA_VERSION
      || !isPlainObject(record.game)) {
      throw new StoreError('STORE_RECORD_INVALID', `游戏存档结构无效（需要 {schemaVersion:1,game}）：${resolved}`, {
        file: resolved,
      });
    }
    return record.game;
  }

  async function save(game) {
    if (!isPlainObject(game)) {
      throw new StoreError('STORE_GAME_INVALID', 'save() requires a plain game state object.');
    }

    let contents;
    try {
      const record = {
        schemaVersion: GAME_STORE_SCHEMA_VERSION,
        game,
      };
      const json = JSON.stringify(record, null, 2);
      if (typeof json !== 'string') {
        throw new TypeError('game state is not JSON serializable');
      }
      contents = `${json}\n`;
    } catch (error) {
      throw new StoreError('STORE_SERIALIZE_FAILED', `无法序列化游戏存档：${error?.message ?? error}`, {
        file: resolved,
        cause: error?.message ?? String(error),
      });
    }

    return enqueueWrite(resolved, async () => {
      const directory = path.dirname(resolved);
      await mkdir(directory, { recursive: true });
      const tempPath = path.join(
        directory,
        `.${path.basename(resolved)}.${process.pid}.${randomUUID()}.tmp`,
      );
      let handle = null;
      try {
        handle = await open(tempPath, 'w');
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(tempPath, resolved);
      } catch (error) {
        if (handle !== null) await handle.close().catch(() => {});
        await unlink(tempPath).catch(() => {});
        throw new StoreError('STORE_WRITE_FAILED', `无法写入游戏存档 ${resolved}：${error?.message ?? error}`, {
          file: resolved,
          cause: String(error?.code ?? error),
        });
      }
      return game;
    });
  }

  return { load, save };
}
