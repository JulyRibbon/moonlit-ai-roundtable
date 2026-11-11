import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  JSONL_FILENAMES,
  StoreError,
  appendJsonlLine,
  readJsonlFile,
  resolveJsonlName,
} from './jsonl.mjs';

export { JSONL_FILENAMES, StoreError };

const CHECKPOINTS = Object.freeze([
  { key: 'room', fileName: 'room.json' },
  { key: 'schedule', fileName: 'schedule.json' },
  { key: 'cursors', fileName: 'cursors.json' },
]);

function assertRecord(record, file) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new StoreError('INVALID_RECORD', `${file} record must be a plain object.`, {
      file,
      recordType: record === null ? 'null' : typeof record,
    });
  }
}

function serializeRecord(record, file) {
  assertRecord(record, file);
  let json;
  try {
    json = JSON.stringify(record);
  } catch (error) {
    throw new StoreError('SERIALIZE_FAILED', `Cannot serialize ${file} record: ${error.message}`, {
      file,
      cause: error.message,
    });
  }
  if (typeof json !== 'string') {
    throw new StoreError('SERIALIZE_FAILED', `Cannot serialize ${file} record to JSON.`, { file });
  }
  return json;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function formatTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return value;
}

function messageTimestamp(message) {
  return formatTimestamp(message.createdAt)
    ?? formatTimestamp(message.occurredAt)
    ?? formatTimestamp(message.timestamp);
}

function messageSender(message) {
  const candidate = message.from ?? message.sender ?? message.actor ?? message.seatId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : 'unknown';
}

function isVisibleMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    return false;
  }
  if (typeof message.text !== 'string') {
    return false;
  }
  const outcome = message.outcome ?? message.result?.outcome ?? message.status;
  if (outcome === 'pass' || outcome === 'aborted') {
    return false;
  }
  if (message.aborted === true) {
    return false;
  }
  // PASS 只认去除首尾空白后精确等于 [PASS]，与 scheduler.isPass 保持一致。
  return message.text.trim() !== '[PASS]';
}

function messageTimeValue(message) {
  const raw = messageTimestamp(message);
  if (raw === null) {
    return null;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareMessages(left, right) {
  const leftTime = messageTimeValue(left.message);
  const rightTime = messageTimeValue(right.message);
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  if (leftTime === null && rightTime !== null) {
    return 1;
  }
  if (leftTime !== null && rightTime === null) {
    return -1;
  }
  const leftSeq = Number.isSafeInteger(left.message.roomSeq) ? left.message.roomSeq : Infinity;
  const rightSeq = Number.isSafeInteger(right.message.roomSeq) ? right.message.roomSeq : Infinity;
  if (leftSeq !== rightSeq) {
    return leftSeq - rightSeq;
  }
  return left.index - right.index;
}

function renderMarkdown(room, messages) {
  const roomId = typeof room?.roomId === 'string' && room.roomId.length > 0
    ? room.roomId
    : 'unknown';
  const lines = [`# Room ${roomId}`, ''];

  const visible = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => isVisibleMessage(entry.message))
    .sort(compareMessages);

  if (visible.length === 0) {
    lines.push('_No visible messages._', '');
    return lines.join('\n');
  }

  for (const { message } of visible) {
    const timestamp = messageTimestamp(message) ?? 'unknown time';
    lines.push(`## ${timestamp} — ${messageSender(message)}`, '', message.text, '');
  }
  return lines.join('\n');
}

/**
 * 真实持久化层。所有路径都限定在传入的 roomDir 内；
 * load() 只读，不会创建目录或启动房间。写入时才按需创建目录。
 */
export function createRoomStore(roomDir) {
  if (typeof roomDir !== 'string' || roomDir.length === 0) {
    throw new StoreError('INVALID_ROOM_DIR', 'createRoomStore() requires a non-empty roomDir string.', {
      roomDir,
    });
  }
  const baseDir = path.resolve(roomDir);
  const queues = new Map();

  /**
   * 同一文件串行、不同文件并行。前一次失败不会污染后续写入。
   */
  function enqueue(fileName, task) {
    const previous = queues.get(fileName) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    queues.set(fileName, current);
    current
      .finally(() => {
        if (queues.get(fileName) === current) {
          queues.delete(fileName);
        }
      })
      .catch(() => {});
    return current;
  }

  async function readJsonFile(fileName) {
    const target = path.join(baseDir, fileName);
    let text;
    try {
      text = await readFile(target, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    try {
      return JSON.parse(stripBom(text));
    } catch {
      throw new StoreError('JSON_PARSE_ERROR', `Invalid JSON in ${fileName}`, {
        file: fileName,
      });
    }
  }

  async function writeAtomic(fileName, contents) {
    return enqueue(fileName, async () => {
      await mkdir(baseDir, { recursive: true });
      const target = path.join(baseDir, fileName);
      const tempName = `.${fileName}.${process.pid}.${randomUUID()}.tmp`;
      const tempPath = path.join(baseDir, tempName);
      let handle = null;
      try {
        handle = await open(tempPath, 'w');
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(tempPath, target);
      } catch (error) {
        if (handle !== null) {
          await handle.close().catch(() => {});
        }
        await unlink(tempPath).catch(() => {});
        throw error;
      }
    });
  }

  async function appendRecord(name, record) {
    const bare = resolveJsonlName(name);
    const fileName = JSONL_FILENAMES[bare];
    // 先序列化再排队：循环引用/BigInt 在写盘前就以 SERIALIZE_FAILED 失败。
    const line = `${serializeRecord(record, fileName)}\n`;
    await enqueue(fileName, () => appendJsonlLine(baseDir, bare, line));
    return record;
  }

  async function load() {
    const [room, schedule, cursors] = await Promise.all([
      readJsonFile('room.json'),
      readJsonFile('schedule.json'),
      readJsonFile('cursors.json'),
    ]);
    const [events, messages, attempts] = await Promise.all([
      readJsonlFile(baseDir, 'events'),
      readJsonlFile(baseDir, 'transcript'),
      readJsonlFile(baseDir, 'attempts'),
    ]);
    return {
      room,
      schedule,
      cursors,
      events: events.records,
      messages: messages.records,
      attempts: attempts.records,
      warnings: [...events.warnings, ...messages.warnings, ...attempts.warnings],
    };
  }

  async function readJsonl(name) {
    resolveJsonlName(name);
    return readJsonlFile(baseDir, name);
  }

  async function saveCheckpoint(input = {}) {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      throw new StoreError('INVALID_CHECKPOINT', 'saveCheckpoint() requires an object.');
    }
    // 只取三个白名单字段；调用方多传的内容不会进入任何检查点文件。
    const { room = null, schedule = null, cursors = null } = input;
    const inputs = { room, schedule, cursors };
    const writes = [];
    const written = [];
    for (const { key, fileName } of CHECKPOINTS) {
      const value = inputs[key];
      if (value === null || value === undefined) {
        continue;
      }
      let contents;
      try {
        const json = JSON.stringify(value, null, 2);
        if (typeof json !== 'string') {
          throw new TypeError('value is not JSON serializable');
        }
        contents = `${json}\n`;
      } catch (error) {
        throw new StoreError(
          'SERIALIZE_FAILED',
          `Cannot serialize ${fileName}: ${error.message}`,
          { file: fileName, cause: error.message },
        );
      }
      written.push(fileName);
      writes.push(writeAtomic(fileName, contents));
    }
    // 不同检查点文件互不依赖，可以并行；各自内部仍是 temp→rename。
    await Promise.all(writes);
    return { written };
  }

  async function backupCounters(snapshot) {
    const backupDir = path.join(baseDir, 'backups');
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `counters-${stamp}-${randomUUID()}.json`);
    let handle = null;
    try {
      handle = await open(backupPath, 'wx');
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      throw new StoreError('COUNTER_BACKUP_FAILED', `无法备份计数：${error?.message ?? error}`);
    }
    return backupPath;
  }

  async function clearTranscript() {
    const transcript = await readJsonlFile(baseDir, 'transcript');
    const backupDir = path.join(baseDir, 'backups');
    await mkdir(backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `transcript-${stamp}-${randomUUID()}.jsonl`);
    const contents = transcript.records.map((record) => `${serializeRecord(record, 'transcript.jsonl')}\n`).join('');
    let handle = null;
    try {
      handle = await open(backupPath, 'wx');
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      throw new StoreError('TRANSCRIPT_BACKUP_FAILED', `无法备份聊天记录：${error?.message ?? error}`);
    }
    await writeAtomic('transcript.jsonl', '');
    return { clearedCount: transcript.records.length, backupPath };
  }

  async function exportMarkdown() {
    const [room, transcript] = await Promise.all([
      readJsonFile('room.json'),
      readJsonlFile(baseDir, 'transcript'),
    ]);
    return renderMarkdown(room, transcript.records);
  }

  return {
    load,
    appendEvent: (event) => appendRecord('events', event),
    appendMessage: (message) => appendRecord('transcript', message),
    appendAttempt: (attempt) => appendRecord('attempts', attempt),
    saveCheckpoint,
    readJsonl,
    backupCounters,
    clearTranscript,
    exportMarkdown,
  };
}
