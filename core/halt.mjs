import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';

import { OWNER_ACTOR, assertOwner } from './room-state.mjs';

export const HALT_SCHEMA_VERSION = 1;
export const HALT_FILENAME = 'HALT';
export const DEFAULT_SETTLE_TIMEOUT_MS = 5000;

export const HALT_MODES = Object.freeze({
  PAUSE: 'pause',
  HALT: 'halt',
});

export const HALT_SCOPES = Object.freeze({
  ROOM: 'room',
  ALL: 'all',
});

const ROOM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export class HaltGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'HaltGuardError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, HaltGuardError);
    }
  }
}

/** roomId 会进入哨兵文件名，必须是裸标识符，不能含路径分隔符或点。 */
export function assertRoomId(roomId) {
  if (typeof roomId !== 'string' || !ROOM_ID_PATTERN.test(roomId)) {
    throw new HaltGuardError(
      'INVALID_ROOM_ID',
      `Invalid roomId for halt guard: ${String(roomId)}`,
      { roomId, pattern: ROOM_ID_PATTERN.source },
    );
  }
  return roomId;
}

function assertAttemptId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new HaltGuardError(
      'INVALID_ATTEMPT',
      `${field} must be a non-empty string of at most 256 characters.`,
      { field },
    );
  }
  return value;
}

function assertScope(scope) {
  if (scope !== HALT_SCOPES.ROOM && scope !== HALT_SCOPES.ALL) {
    throw new HaltGuardError(
      'INVALID_SCOPE',
      `Unknown halt scope: ${String(scope)}`,
      { scope, known: Object.values(HALT_SCOPES) },
    );
  }
  return scope;
}

function assertMode(mode) {
  if (mode !== HALT_MODES.PAUSE && mode !== HALT_MODES.HALT) {
    throw new HaltGuardError(
      'INVALID_MODE',
      `Unknown halt mode: ${String(mode)}`,
      { mode, known: Object.values(HALT_MODES) },
    );
  }
  return mode;
}

function assertActor(actor) {
  if (typeof actor !== 'string' || actor.length === 0 || actor.trim() !== actor) {
    throw new HaltGuardError(
      'INVALID_ACTOR',
      'Actor must be a non-empty string without surrounding whitespace.',
      { actor },
    );
  }
  return actor;
}

function assertReason(reason) {
  if (reason !== undefined && (typeof reason !== 'string' || reason.length === 0)) {
    throw new HaltGuardError('INVALID_REASON', 'reason must be a non-empty string.', { reason });
  }
  return reason;
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_SETTLE_TIMEOUT_MS;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new HaltGuardError(
      'INVALID_TIMEOUT',
      'settleTimeoutMs must be a finite number >= 0.',
      { settleTimeoutMs: value },
    );
  }
  return value;
}

function errorCode(error) {
  if (error && typeof error.code === 'string' && error.code.length > 0) return error.code;
  if (error && typeof error.name === 'string' && error.name.length > 0) return error.name;
  return 'CANCEL_FAILED';
}

function classifyError(error) {
  if (error?.code === 'CANCEL_TIMEOUT') {
    return { status: 'pending', settlement: 'timeout', errorCode: 'CANCEL_TIMEOUT' };
  }
  return { status: 'failed', settlement: 'failed', errorCode: errorCode(error) };
}

/**
 * 解释 cancel 的返回值。适配器标准回执是 {settlement}，但同步/异步的
 * undefined、true、false 也接受，方便测试和较简单的 Bridge。
 */
function classifyCancelResult(result) {
  if (result === false) {
    return { status: 'failed', settlement: 'failed', errorCode: 'CANCEL_REJECTED' };
  }
  if (result !== null && typeof result === 'object') {
    const settlement = result.settlement;
    if (settlement === 'confirmed') return { status: 'aborted', settlement: 'confirmed' };
    if (settlement === 'pending') return { status: 'pending', settlement: 'pending' };
    if (settlement === 'failed' || settlement === 'unsupported') {
      return { status: 'failed', settlement, errorCode: errorCode(result.error) };
    }
    if (settlement !== undefined) {
      // 未知 settlement 不能当成已确认停止。
      return { status: 'pending', settlement: 'unsupported', errorCode: 'UNKNOWN_SETTLEMENT' };
    }
    if (result.accepted === true) return { status: 'aborted', settlement: 'confirmed' };
    if (result.accepted === false) {
      return { status: 'failed', settlement: 'failed', errorCode: 'CANCEL_REJECTED' };
    }
    return { status: 'pending', settlement: 'unsupported', errorCode: 'SETTLEMENT_MISSING' };
  }
  if (result === true || result === undefined || result === null) {
    return { status: 'aborted', settlement: 'confirmed' };
  }
  return { status: 'pending', settlement: 'unsupported', errorCode: 'UNKNOWN_RESULT' };
}

function withTimeout(promise, timeoutMs, label) {
  if (!(timeoutMs > 0)) {
    return Promise.reject(Object.assign(
      new Error(`${label} timed out.`),
      { code: 'CANCEL_TIMEOUT' },
    ));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(
        new Error(`${label} timed out after ${timeoutMs}ms.`),
        { code: 'CANCEL_TIMEOUT' },
      ));
    }, timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 独立停止守卫。
 *
 * 磁盘事实：stateDir/HALT 为全局停止，stateDir/HALT.<roomId> 为单房停止。
 * 内存事实：每房的 AbortController、暂停标记和在飞 attempt。
 * check() 同时读取两者；外部手工创建哨兵会在下一个检查点触发内存 abort。
 * close() 只清内存，不删除哨兵，也不恢复任何房间。
 */
export function createHaltGuard(options = {}) {
  const { stateDir, settleTimeoutMs, auditFile } = options ?? {};
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    throw new HaltGuardError('INVALID_STATE_DIR', 'stateDir is required.', { stateDir });
  }
  const root = path.resolve(stateDir);
  const timeoutMs = normalizeTimeout(settleTimeoutMs);
  if (auditFile !== undefined && (typeof auditFile !== 'string' || auditFile.length === 0)) {
    throw new HaltGuardError('INVALID_AUDIT_FILE', 'auditFile must be a non-empty string.', { auditFile });
  }
  const auditPath = auditFile === undefined
    ? path.join(root, 'audit.jsonl')
    : (path.isAbsolute(auditFile) ? auditFile : path.resolve(root, auditFile));

  const rooms = new Map();
  const globalState = { paused: false };
  let auditQueue = Promise.resolve();

  function ensureRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        controller: new AbortController(),
        paused: false,
        attempts: new Map(),
      };
      rooms.set(roomId, room);
    }
    return room;
  }

  function globalSentinelPath() {
    return path.join(root, HALT_FILENAME);
  }

  function roomSentinelPath(roomId) {
    assertRoomId(roomId);
    return path.join(root, `${HALT_FILENAME}.${roomId}`);
  }

  function sentinelState(roomId) {
    const roomHalted = existsSync(roomSentinelPath(roomId));
    const globalHalted = existsSync(globalSentinelPath());
    return { globalHalted, roomHalted };
  }

  function haltReason({ scope, roomId, source }) {
    return Object.freeze({
      code: 'HALT',
      scope,
      roomId: roomId ?? null,
      source,
    });
  }

  function abortRoom(roomId, reason) {
    const room = ensureRoom(roomId);
    if (!room.controller.signal.aborted) {
      room.controller.abort(reason);
    }
    return room.controller.signal;
  }

  function abortAll(reason) {
    for (const [roomId, room] of rooms) {
      if (!room.controller.signal.aborted) {
        room.controller.abort({ ...reason, roomId });
      }
    }
  }

  async function appendAudit(event) {
    let record;
    try {
      record = JSON.stringify({ schemaVersion: HALT_SCHEMA_VERSION, ...event });
    } catch {
      return;
    }
    if (!record) return;
    const write = async () => {
      try {
        await mkdir(path.dirname(auditPath), { recursive: true });
        await appendFile(auditPath, `${record}\n`, 'utf8');
      } catch {
        // 审计不可用不能阻断停止或恢复。
      }
    };
    auditQueue = auditQueue.then(write, write);
    await auditQueue;
  }

  async function writeSentinel(file, payload) {
    await mkdir(root, { recursive: true });
    const handle = await open(file, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function cancelAttempt(roomId, room, record) {
    if (record.status === 'aborted') {
      return record.lastOutcome;
    }
    if (record.cancelPromise) {
      return record.cancelPromise;
    }
    record.status = 'cancelling';
    record.cancelPromise = (async () => {
      const input = {
        signal: room.controller.signal,
        attemptId: record.attemptId,
        seatId: record.seatId,
        roomId,
      };
      let outcome;
      try {
        const result = await withTimeout(
          Promise.resolve().then(() => record.cancel(input)),
          timeoutMs,
          `cancel(${record.attemptId})`,
        );
        outcome = classifyCancelResult(result);
      } catch (error) {
        outcome = classifyError(error);
      }

      record.status = outcome.status;
      record.settlement = outcome.settlement;
      record.lastOutcome = { ...outcome, roomId };

      if (outcome.status === 'aborted') {
        if (room.attempts.get(record.attemptId) === record) {
          room.attempts.delete(record.attemptId);
        }
      }
      return record.lastOutcome;
    })().finally(() => {
      record.cancelPromise = null;
    });
    return record.cancelPromise;
  }

  function signal(roomId) {
    assertRoomId(roomId);
    const room = ensureRoom(roomId);
    const { globalHalted, roomHalted } = sentinelState(roomId);
    if ((globalHalted || roomHalted) && !room.controller.signal.aborted) {
      room.controller.abort(haltReason({
        scope: globalHalted ? HALT_SCOPES.ALL : HALT_SCOPES.ROOM,
        roomId,
        source: 'sentinel',
      }));
    }
    return room.controller.signal;
  }

  function check(roomId) {
    assertRoomId(roomId);
    const room = ensureRoom(roomId);
    const { globalHalted, roomHalted } = sentinelState(roomId);
    if ((globalHalted || roomHalted) && !room.controller.signal.aborted) {
      room.controller.abort(haltReason({
        scope: globalHalted ? HALT_SCOPES.ALL : HALT_SCOPES.ROOM,
        roomId,
        source: 'sentinel',
      }));
    }
    const halted = globalHalted || roomHalted;
    const paused = globalState.paused || room.paused;
    return {
      roomId,
      halted,
      globalHalted,
      roomHalted,
      paused,
      aborted: room.controller.signal.aborted,
      dispatchable: !halted && !paused && !room.controller.signal.aborted,
      mode: halted ? HALT_MODES.HALT : (paused ? HALT_MODES.PAUSE : null),
    };
  }

  function snapshot(roomId) {
    assertRoomId(roomId);
    const status = check(roomId);
    const room = ensureRoom(roomId);
    const attempts = [...room.attempts.values()].map((record) => ({
      attemptId: record.attemptId,
      seatId: record.seatId,
      status: record.status,
      registeredAt: record.registeredAt,
    }));
    return {
      schemaVersion: HALT_SCHEMA_VERSION,
      ...status,
      attempts,
      inFlight: attempts.length,
    };
  }

  function registerAttempt({ roomId, attemptId, seatId, cancel } = {}) {
    assertRoomId(roomId);
    assertAttemptId(attemptId, 'attemptId');
    assertAttemptId(seatId, 'seatId');
    if (typeof cancel !== 'function') {
      throw new HaltGuardError('INVALID_CANCEL', 'cancel must be a function.', { attemptId });
    }
    const room = ensureRoom(roomId);
    if (room.attempts.has(attemptId)) {
      throw new HaltGuardError(
        'DUPLICATE_ATTEMPT',
        `Attempt already registered: ${attemptId}`,
        { roomId, attemptId },
      );
    }
    const record = {
      attemptId,
      seatId,
      cancel,
      status: 'active',
      settlement: null,
      registeredAt: new Date().toISOString(),
      cancelPromise: null,
      lastOutcome: null,
    };
    room.attempts.set(attemptId, record);

    let unregistered = false;
    return function unregister() {
      if (unregistered) return false;
      unregistered = true;
      if (room.attempts.get(attemptId) === record) {
        room.attempts.delete(attemptId);
      }
      if (record.status === 'active' || record.status === 'failed' || record.status === 'pending') {
        record.status = 'completed';
      }
      return true;
    };
  }

  async function request({ scope, roomId, mode, actor, reason } = {}) {
    assertScope(scope);
    assertMode(mode);
    assertActor(actor);
    assertReason(reason);

    const at = new Date().toISOString();
    const targetRoomId = scope === HALT_SCOPES.ROOM ? assertRoomId(roomId) : null;

    if (mode === HALT_MODES.PAUSE) {
      if (scope === HALT_SCOPES.ALL) {
        globalState.paused = true;
      } else {
        ensureRoom(targetRoomId).paused = true;
      }
      const halted = scope === HALT_SCOPES.ALL
        ? existsSync(globalSentinelPath())
        : (existsSync(globalSentinelPath()) || existsSync(roomSentinelPath(targetRoomId)));
      const receipt = {
        stopped: true,
        halted,
        paused: true,
        scope,
        mode,
        at,
        roomId: targetRoomId,
        aborted: 0,
        degraded: 0,
        pending: 0,
        fullySettled: true,
        attempts: [],
        sentinelWritten: null,
      };
      await appendAudit({
        at,
        event: 'halt.request',
        scope,
        mode,
        roomId: targetRoomId,
        actor,
        stopped: receipt.stopped,
        aborted: 0,
        degraded: 0,
        pending: 0,
      });
      return receipt;
    }

    const sentinelFile = scope === HALT_SCOPES.ALL
      ? globalSentinelPath()
      : roomSentinelPath(targetRoomId);
    let sentinelWritten = false;
    let sentinelErrorCode = null;
    if (existsSync(sentinelFile)) {
      // 幂等重放保留第一次落盘的 at/actor，不重复写哨兵。
      sentinelWritten = true;
    } else {
      try {
        await writeSentinel(sentinelFile, {
          schemaVersion: HALT_SCHEMA_VERSION,
          type: 'Halt',
          scope,
          roomId: targetRoomId,
          actor,
          mode: HALT_MODES.HALT,
          at,
        });
        sentinelWritten = true;
      } catch (error) {
        sentinelErrorCode = errorCode(error);
      }
    }

    if (scope === HALT_SCOPES.ALL) {
      abortAll(haltReason({ scope, roomId: null, source: 'request' }));
    } else {
      abortRoom(targetRoomId, haltReason({ scope, roomId: targetRoomId, source: 'request' }));
    }

    const targets = [];
    const roomEntries = scope === HALT_SCOPES.ALL
      ? [...rooms.entries()]
      : [[targetRoomId, ensureRoom(targetRoomId)]];
    for (const [entryRoomId, room] of roomEntries) {
      for (const record of room.attempts.values()) {
        targets.push({ roomId: entryRoomId, room, record });
      }
    }

    const outcomes = await Promise.all(
      targets.map(({ roomId: entryRoomId, room, record }) => cancelAttempt(entryRoomId, room, record)),
    );
    const attempts = outcomes.map((outcome, index) => ({
      roomId: outcome.roomId,
      attemptId: targets[index].record.attemptId,
      seatId: targets[index].record.seatId,
      status: outcome.status,
      settlement: outcome.settlement,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    }));

    const aborted = outcomes.filter((outcome) => outcome.status === 'aborted').length;
    const pending = outcomes.filter((outcome) => outcome.status === 'pending').length;
    const degraded = outcomes.filter((outcome) => (
      outcome.settlement === 'failed'
      || outcome.settlement === 'unsupported'
      || outcome.settlement === 'timeout'
    )).length;
    const fullySettled = sentinelWritten
      && pending === 0
      && degraded === 0
      && aborted === outcomes.length;
    const halted = scope === HALT_SCOPES.ALL
      ? existsSync(globalSentinelPath())
      : (existsSync(globalSentinelPath()) || existsSync(roomSentinelPath(targetRoomId)));

    const receipt = {
      stopped: sentinelWritten,
      halted,
      paused: false,
      scope,
      mode,
      at,
      roomId: targetRoomId,
      aborted,
      degraded,
      pending,
      fullySettled,
      sentinelWritten,
      ...(sentinelErrorCode ? { sentinelErrorCode } : {}),
      attempts,
    };

    await appendAudit({
      at,
      event: 'halt.request',
      scope,
      mode,
      roomId: targetRoomId,
      actor,
      stopped: receipt.stopped,
      sentinelWritten,
      ...(sentinelErrorCode ? { sentinelErrorCode } : {}),
      aborted,
      degraded,
      pending,
      attemptIds: attempts.map((attempt) => attempt.attemptId),
    });
    if (sentinelErrorCode) {
      await appendAudit({
        at,
        event: 'halt.degraded',
        scope,
        roomId: targetRoomId,
        errorCode: `SENTINEL_${sentinelErrorCode}`,
      });
    }
    for (const attempt of attempts) {
      if (attempt.settlement === 'failed'
        || attempt.settlement === 'unsupported'
        || attempt.settlement === 'timeout') {
        await appendAudit({
          at,
          event: 'halt.degraded',
          roomId: attempt.roomId,
          attemptId: attempt.attemptId,
          seatId: attempt.seatId,
          settlement: attempt.settlement,
          errorCode: attempt.errorCode ?? null,
        });
      }
    }
    return receipt;
  }

  async function resume({ scope = HALT_SCOPES.ROOM, roomId, actor } = {}) {
    assertScope(scope);
    // 只有机主能解除停止；未知 actor 由 assertOwner 抛 RoomStateError。
    assertOwner(actor);
    const at = new Date().toISOString();
    const targetRoomId = scope === HALT_SCOPES.ROOM ? assertRoomId(roomId) : null;

    if (scope === HALT_SCOPES.ROOM) {
      const room = ensureRoom(targetRoomId);
      let cleared = false;
      try {
        await unlink(roomSentinelPath(targetRoomId));
        cleared = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          throw new HaltGuardError(
            'RESUME_FAILED',
            `Cannot remove halt sentinel for room ${targetRoomId}.`,
            { roomId: targetRoomId, cause: errorCode(error) },
          );
        }
      }
      room.paused = false;
      const globalHalted = existsSync(globalSentinelPath());
      if (!globalHalted && room.controller.signal.aborted) {
        room.controller = new AbortController();
      }
      const halted = globalHalted || existsSync(roomSentinelPath(targetRoomId));
      const receipt = {
        resumed: !halted,
        stopped: false,
        scope,
        roomId: targetRoomId,
        actor: OWNER_ACTOR,
        at,
        cleared,
        halted,
        globalHalted,
        paused: globalState.paused || room.paused,
        fullySettled: true,
      };
      await appendAudit({
        at,
        event: 'halt.resume',
        scope,
        roomId: targetRoomId,
        actor: OWNER_ACTOR,
        cleared,
        halted,
      });
      return receipt;
    }

    let cleared = false;
    try {
      await unlink(globalSentinelPath());
      cleared = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new HaltGuardError(
          'RESUME_FAILED',
          'Cannot remove global halt sentinel.',
          { cause: errorCode(error) },
        );
      }
    }
    globalState.paused = false;
    const haltedRooms = [];
    for (const [entryRoomId, room] of rooms) {
      if (existsSync(roomSentinelPath(entryRoomId))) {
        haltedRooms.push(entryRoomId);
        continue;
      }
      if (room.controller.signal.aborted) {
        room.controller = new AbortController();
      }
    }
    const globalHalted = existsSync(globalSentinelPath());
    const receipt = {
      resumed: !globalHalted,
      stopped: false,
      scope,
      roomId: null,
      actor: OWNER_ACTOR,
      at,
      cleared,
      halted: globalHalted,
      globalHalted,
      haltedRooms,
      paused: globalState.paused,
      fullySettled: true,
    };
    await appendAudit({
      at,
      event: 'halt.resume',
      scope,
      roomId: null,
      actor: OWNER_ACTOR,
      cleared,
      halted: globalHalted,
      haltedRooms,
    });
    return receipt;
  }

  async function close() {
    await auditQueue.catch(() => {});
    rooms.clear();
    globalState.paused = false;
  }

  return {
    snapshot,
    signal,
    registerAttempt,
    request,
    resume,
    check,
    close,
  };
}
