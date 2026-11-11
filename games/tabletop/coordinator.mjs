import { randomUUID } from 'node:crypto';

import {
  TABLETOP_PLAYER_COUNT,
  TABLETOP_TYPES,
  getTabletopEngine,
  isTabletopType,
} from './engine.mjs';
import { createTabletopStore } from './store.mjs';
import { buildTabletopPrompt, parseTabletopResponse } from './prompt.mjs';

export const TABLETOP_SLOT_COLORS = Object.freeze(['#e9b45f', '#6ea8ff']);

export class TabletopManagerError extends Error {
  constructor(code, message, details = {}) {
    super(message ?? code);
    this.name = 'TabletopManagerError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TabletopManagerError);
    }
  }
}

/** 旧命名兼容：协调器相关错误也使用同一个基类。 */
export class TabletopCoordinatorError extends TabletopManagerError {}

function fail(code, message, details) {
  throw new TabletopManagerError(code, message, details);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function errorDetail(error) {
  const message = error?.message ?? String(error);
  return message.endsWith('。') ? message : `${message}。`;
}

function humanTurnMessage(record, position) {
  const player = record.players[position.currentPlayer];
  return `轮到 ${player.name}（slot ${player.slot}）落子。`;
}

function aiTurnMessage(record, position) {
  const player = record.players[position.currentPlayer];
  return `AI ${player.name} 正在思考…`;
}

function finishedMessage(record, position) {
  const scores = record.players
    .map((player) => `${player.name} ${position.scores[player.slot] ?? 0}`)
    .join('，');
  const winners = Array.isArray(position.winners) ? position.winners : [];
  if (winners.length === 0) return `对局结束：平局（${scores}）。`;
  const names = winners
    .map((slot) => record.players[slot]?.name ?? `slot ${slot}`)
    .join('、');
  return `对局结束：${names} 获胜（${scores}）。`;
}

const RETRY_REASON = '上一次尝试没有成功，请重新只回复一个 JSON 对象 {"action":<合法动作对象>,"comment":"一句简短公开理由"}。';

/**
 * 五种双人棋类的独立后端管理器。
 * 每个类型拥有自己的存档、状态、generation 与 AI Bridge；管理器只共享监听器与配置。
 */
export function createTabletopManager(options = {}) {
  const {
    config,
    factories,
    createNativeSession,
    storeDir,
    now = () => new Date().toISOString(),
    id = () => randomUUID(),
    wait,
  } = options ?? {};

  if (!isPlainObject(config)) {
    fail('CONFIG_INVALID', 'createTabletopManager() 需要 config 对象。');
  }
  const roomId = trimmed(config.roomId);
  if (roomId.length === 0) {
    fail('CONFIG_INVALID', 'config.roomId 必须是非空字符串。');
  }
  const ownerName = trimmed(config.ownerName);
  if (ownerName.length === 0 || ownerName.length > 32) {
    fail('CONFIG_INVALID', 'config.ownerName 必须是 1..32 个字符。');
  }
  if (!Array.isArray(config.seats) || config.seats.length === 0) {
    fail('CONFIG_INVALID', 'config.seats 必须是非空数组。');
  }
  if (!isPlainObject(factories)) {
    fail('CONFIG_INVALID', 'createTabletopManager() 需要按 clientType 索引的 factories。');
  }
  if (typeof createNativeSession !== 'function') {
    fail('CONFIG_INVALID', 'createTabletopManager() 需要 createNativeSession 回调。');
  }
  if (typeof storeDir !== 'string' || storeDir.trim().length === 0) {
    fail('CONFIG_INVALID', 'createTabletopManager() 需要非空 storeDir。');
  }
  if (typeof now !== 'function' || typeof id !== 'function') {
    fail('CONFIG_INVALID', 'now 与 id 必须是函数。');
  }

  const seenSeatIds = new Set();
  const seats = config.seats.map((seat, index) => {
    if (!isPlainObject(seat)) fail('CONFIG_INVALID', `config.seats[${index}] 必须是对象。`);
    const seatId = trimmed(seat.seatId);
    const clientType = trimmed(seat.clientType);
    const displayName = trimmed(seat.displayName) || seatId;
    if (seatId.length === 0) fail('CONFIG_INVALID', `config.seats[${index}].seatId 必须非空。`);
    if (seenSeatIds.has(seatId)) fail('CONFIG_INVALID', `seatId 重复：${seatId}。`);
    seenSeatIds.add(seatId);
    if (clientType.length === 0) {
      fail('CONFIG_INVALID', `config.seats[${index}].clientType 必须非空。`);
    }
    return {
      seatId,
      clientType,
      displayName,
      enabled: seat.enabled !== false,
      client: isPlainObject(seat.client) ? structuredClone(seat.client) : {},
    };
  });
  const enabledSeats = seats.filter((seat) => seat.enabled);
  const seatById = new Map(enabledSeats.map((seat) => [seat.seatId, seat]));
  const seatOptions = enabledSeats.map((seat) => ({
    seatId: seat.seatId,
    displayName: seat.displayName,
    clientType: seat.clientType,
  }));

  let closed = false;
  let closePromise = null;
  let initPromise = null;
  let eventSequence = 0;
  const listeners = new Set();

  function assertOpen() {
    if (closed) fail('MANAGER_CLOSED', '桌面对局管理器已关闭。');
  }

  function nextId() {
    const value = id();
    if (typeof value === 'string' && value.length > 0) return value;
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
    fail('ID_INVALID', 'id() 没有返回有效标识。');
  }

  function emit(rt) {
    if (listeners.size === 0) return;
    eventSequence += 1;
    let suffix = 'event';
    try {
      suffix = nextId();
    } catch {
      // 事件 ID 至少有序号保证唯一。
    }
    const event = {
      eventId: `gte_${eventSequence}_${suffix}`,
      type: 'GameChanged',
      snapshot: rt.snapshot(),
    };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不能影响对局。
      }
    }
  }

  function createRuntime(gameType) {
    const engine = getTabletopEngine(gameType);
    const store = createTabletopStore({ storeDir, roomId, gameType });

    let record = null;
    let position = null;
    let phase = 'idle';
    let message = '尚无对局。';
    let retryReason = null;
    let generation = 0;
    let aiRun = null;
    let pendingWaiter = null;
    let operationQueue = Promise.resolve();
    let closePromiseForType = null;
    let initPromiseForType = null;
    const bridges = new Map();

    function isCurrent(targetGeneration) {
      return !closed && targetGeneration === generation;
    }

    function enqueue(task) {
      const run = operationQueue.then(task, task);
      operationQueue = run.then(() => undefined, () => undefined);
      return run;
    }

    function publicGame() {
      if (record === null) return null;
      const clone = structuredClone(record);
      for (const player of clone.players) {
        if (player && typeof player === 'object') delete player.nativeSessionRef;
      }
      return {
        ...clone,
        currentPlayer: position.currentPlayer,
        status: position.status,
        winners: [...position.winners],
        scores: [...position.scores],
        view: engine.getBoardView(position),
        legalActions: engine.listLegalActions(position),
      };
    }

    function snapshot() {
      return {
        gameType,
        game: publicGame(),
        runtime: { phase, message },
        seatOptions,
        ownerName,
      };
    }

    function setPhase(nextPhase, nextMessage) {
      phase = nextPhase;
      message = typeof nextMessage === 'string' ? nextMessage : '';
      emit(rt);
    }

    function failRuntime(targetGeneration, error, prefix = '对局出错') {
      if (!isCurrent(targetGeneration)) return;
      phase = 'error';
      message = `${prefix}：${errorDetail(error)}点击“继续”可重试。`;
      retryReason = RETRY_REASON;
      emit(rt);
    }

    function defer(targetGeneration, task) {
      const run = () => {
        try {
          task();
        } catch (error) {
          failRuntime(targetGeneration, error, '对局后台任务失败');
        }
      };
      if (typeof wait === 'function') {
        Promise.resolve()
          .then(() => wait(0))
          .then(run, run);
        return;
      }
      queueMicrotask(run);
    }

    function settleWaiter(waiter, outcome) {
      if (!waiter || waiter.settled) return;
      waiter.settled = true;
      if (pendingWaiter === waiter) pendingWaiter = null;
      if (outcome.status === 'completed') {
        waiter.resolve(outcome.text);
      } else {
        waiter.reject(new TabletopManagerError(
          outcome.code ?? 'AI_ATTEMPT_FAILED',
          outcome.message ?? 'AI 请求失败。',
        ));
      }
    }

    function createWaiter(targetGeneration, entry, attemptId) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      promise.catch(() => {});
      const waiter = {
        generation: targetGeneration,
        entry,
        attemptId,
        promise,
        resolve,
        reject,
        settled: false,
      };
      pendingWaiter = waiter;
      const alreadySettled = entry.settlements.get(attemptId);
      if (alreadySettled) {
        queueMicrotask(() => settleWaiter(waiter, alreadySettled));
      }
      return waiter;
    }

    function clearWaiter(waiter) {
      if (!waiter || waiter.settled) return;
      waiter.settled = true;
      if (pendingWaiter === waiter) pendingWaiter = null;
    }

    function retireEntry(entry) {
      if (!entry) return;
      entry.active = false;
      if (bridges.get(entry.slot) === entry) bridges.delete(entry.slot);
    }

    function handleBridgeEvent(entry, event) {
      if (!entry.active || !isCurrent(entry.generation)) return;
      if (event?.type === 'BridgeClosed') {
        retireEntry(entry);
        const waiter = pendingWaiter;
        if (waiter && waiter.entry === entry) {
          settleWaiter(waiter, {
            status: 'failed',
            code: 'BRIDGE_CLOSED',
            message: 'AI 会话已关闭。',
          });
        }
        return;
      }

      const attemptId = event?.attemptId;
      if (typeof attemptId !== 'string' || attemptId.length === 0) return;

      let outcome = null;
      if (event.type === 'AttemptCompleted') {
        outcome = {
          status: 'completed',
          text: typeof event.payload?.text === 'string' ? event.payload.text : '',
        };
      } else if (event.type === 'AttemptAborted') {
        outcome = {
          status: 'failed',
          code: 'AI_ATTEMPT_ABORTED',
          message: 'AI 请求被中止。',
        };
      } else if (event.type === 'AttemptFailed') {
        const detail = event.payload?.error;
        outcome = {
          status: 'failed',
          code: 'AI_ATTEMPT_FAILED',
          message: `AI 请求失败：${detail?.message ?? detail?.code ?? '未知错误'}。`,
        };
      }
      if (outcome === null) return;

      if (!entry.settlements.has(attemptId)) {
        entry.settlements.set(attemptId, outcome);
      }
      const waiter = pendingWaiter;
      if (waiter && waiter.entry === entry && waiter.attemptId === attemptId) {
        settleWaiter(waiter, outcome);
      }
    }

    function startConsumer(entry) {
      entry.iterator = entry.bridge.subscribe();
      entry.consumer = (async () => {
        try {
          for await (const event of entry.iterator) {
            if (!entry.active || !isCurrent(entry.generation)) break;
            handleBridgeEvent(entry, event);
          }
          if (entry.active && isCurrent(entry.generation)) {
            retireEntry(entry);
            const waiter = pendingWaiter;
            if (waiter && waiter.entry === entry) {
              settleWaiter(waiter, {
                status: 'failed',
                code: 'BRIDGE_STREAM_ENDED',
                message: 'AI 会话事件流已结束，未收到落子终态。',
              });
            }
          }
          if (isCurrent(entry.generation)) void closeEntry(entry).catch(() => {});
        } catch (error) {
          if (!entry.active || !isCurrent(entry.generation)) return;
          retireEntry(entry);
          void closeEntry(entry).catch(() => {});
          const waiter = pendingWaiter;
          if (waiter && waiter.entry === entry) {
            settleWaiter(waiter, {
              status: 'failed',
              code: 'BRIDGE_READ_FAILED',
              message: `AI 会话事件流中断：${error?.message ?? error}。`,
            });
          }
        }
      })();
      entry.consumer.catch(() => {});
    }

    async function closeEntry(entry) {
      if (!entry) return;
      entry.active = false;
      try {
        await entry.iterator?.return?.();
      } catch {
        // 迭代器可能已经结束。
      }
      try {
        await entry.bridge?.close?.();
      } catch {
        // 关闭失败不影响管理器。
      }
    }

    function invalidateGeneration() {
      generation += 1;
      const waiter = pendingWaiter;
      pendingWaiter = null;
      if (waiter) {
        settleWaiter(waiter, {
          status: 'failed',
          code: 'GENERATION_INVALIDATED',
          message: '对局已经更换。',
        });
      }
      aiRun = null;
      const entries = [...bridges.values()];
      bridges.clear();
      for (const entry of entries) {
        void closeEntry(entry).catch(() => {});
      }
      return generation;
    }

    function normalizePlayersInput(playersInput) {
      if (!Array.isArray(playersInput) || playersInput.length !== TABLETOP_PLAYER_COUNT) {
        fail('PLAYERS_INVALID', `players 必须恰好包含 ${TABLETOP_PLAYER_COUNT} 席。`);
      }
      const usedSlots = new Set();
      const usedSeatIds = new Set();
      const normalized = new Array(TABLETOP_PLAYER_COUNT);

      playersInput.forEach((entry, index) => {
        if (!isPlainObject(entry)) {
          fail('PLAYERS_INVALID', `players[${index}] 必须是对象。`);
        }
        const slot = entry.slot === undefined ? index : entry.slot;
        if (!Number.isInteger(slot) || slot < 0 || slot >= TABLETOP_PLAYER_COUNT || usedSlots.has(slot)) {
          fail('PLAYERS_INVALID', `players[${index}] 的 slot 无效或重复。`);
        }
        usedSlots.add(slot);
        if (entry.kind !== 'human' && entry.kind !== 'ai') {
          fail('PLAYERS_INVALID', `players[${index}].kind 必须是 human 或 ai。`);
        }

        let seat = null;
        if (entry.kind === 'ai') {
          const seatId = trimmed(entry.seatId);
          if (seatId.length === 0) {
            fail('SEAT_INVALID', `AI 席位 slot ${slot} 必须指定 seatId。`);
          }
          seat = seatById.get(seatId);
          if (!seat) {
            fail('SEAT_INVALID', `AI 席位 ${seatId} 不存在或未启用。`);
          }
          if (usedSeatIds.has(seatId)) {
            fail('SEAT_DUPLICATE', `AI 席位 ${seatId} 不能重复使用。`);
          }
          usedSeatIds.add(seatId);
        }

        let name;
        if (entry.name === undefined) {
          name = entry.kind === 'human'
            ? (slot === 0 ? ownerName : '人类2')
            : seat.displayName;
        } else {
          if (typeof entry.name !== 'string') {
            fail('NAME_INVALID', `players[${index}].name 必须是字符串。`);
          }
          name = entry.name.trim();
        }
        if (name.length < 1 || name.length > 32) {
          fail('NAME_INVALID', `players[${index}].name 必须 trim 后为 1..32 个字符。`);
        }

        normalized[slot] = {
          slot,
          kind: entry.kind,
          name,
          color: TABLETOP_SLOT_COLORS[slot],
          seatId: entry.kind === 'ai' ? seat.seatId : null,
          nativeSessionRef: null,
        };
      });

      if (usedSlots.size !== TABLETOP_PLAYER_COUNT) {
        fail('PLAYERS_INVALID', 'players 的 slot 必须覆盖 0 和 1。');
      }
      return normalized;
    }

    function scheduleAi(targetGeneration, reason) {
      if (!isCurrent(targetGeneration)) return null;
      if (aiRun && aiRun.generation === targetGeneration && !aiRun.done) {
        return aiRun.promise;
      }
      const token = { generation: targetGeneration, done: false, promise: null };
      const promise = (async () => {
        try {
          await runAiTurn(targetGeneration, reason);
        } catch (error) {
          failRuntime(targetGeneration, error, 'AI 行动失败');
        } finally {
          token.done = true;
          if (aiRun === token) aiRun = null;
        }
      })();
      token.promise = promise;
      aiRun = token;
      promise.catch(() => {});
      return promise;
    }

    async function preparePlayer(targetGeneration, slot) {
      if (!isCurrent(targetGeneration)) return false;
      const game = record;
      if (!game || position.status !== 'playing') return false;
      const player = game.players[slot];
      if (!player || player.kind !== 'ai') return false;

      const existing = bridges.get(slot);
      if (existing?.active) return true;
      if (existing) {
        bridges.delete(slot);
        await closeEntry(existing);
      }

      const seat = seatById.get(player.seatId);
      if (!seat) {
        fail('SEAT_INVALID', `AI 席位 ${player.seatId} 不存在或未启用。`);
      }
      const factory = factories[seat.clientType];
      if (typeof factory !== 'function') {
        fail('FACTORY_MISSING', `没有 clientType ${seat.clientType} 的 Bridge 工厂。`);
      }

      let nativeSessionRef = player.nativeSessionRef;
      let preparedBridge = null;
      let preparedConnected = false;
      if (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0) {
        const created = await createNativeSession(player.seatId, {
          gameId: game.gameId,
          slot,
          gameType,
        });
        preparedBridge = created?.bridge ?? null;
        preparedConnected = created?.connected === true;
        if (!isCurrent(targetGeneration)) {
          await preparedBridge?.close?.().catch(() => {});
          return false;
        }
        const ref = created?.nativeSessionRef;
        if (typeof ref !== 'string' || ref.length === 0) {
          await preparedBridge?.close?.().catch(() => {});
          fail('SESSION_CREATE_FAILED', `${seat.clientType} 没有返回新的会话 ID。`);
        }
        const saved = await enqueue(async () => {
          if (!isCurrent(targetGeneration)) return false;
          const current = record;
          if (!current || position.status !== 'playing') return false;
          const currentPlayer = current.players[slot];
          if (!currentPlayer || currentPlayer.kind !== 'ai' || currentPlayer.seatId !== player.seatId) {
            return false;
          }
          currentPlayer.nativeSessionRef = ref;
          await store.save(current);
          return true;
        });
        if (!saved) {
          await preparedBridge?.close?.().catch(() => {});
          return false;
        }
        nativeSessionRef = ref;
      }

      if (!isCurrent(targetGeneration)) {
        await preparedBridge?.close?.().catch(() => {});
        return false;
      }
      const latestGame = record;
      if (!latestGame || position.status !== 'playing') {
        await preparedBridge?.close?.().catch(() => {});
        return false;
      }

      const gameSeatId = `game-${latestGame.gameId}-${slot}`;
      let bridge = preparedBridge;
      try {
        if (!bridge) {
          bridge = factory({
            ...seat.client,
            seatId: gameSeatId,
            nativeSessionRef,
            voiceMode: 'none',
          });
        }
      } catch (error) {
        throw new TabletopManagerError(
          'BRIDGE_CREATE_FAILED',
          `创建 AI Bridge 失败：${error?.message ?? error}`,
        );
      }
      if (!bridge
        || typeof bridge.connect !== 'function'
        || typeof bridge.subscribe !== 'function'
        || typeof bridge.send !== 'function') {
        await preparedBridge?.close?.().catch(() => {});
        throw new TabletopManagerError('BRIDGE_INVALID', 'Bridge 工厂返回了无效实例。');
      }

      const entry = {
        generation: targetGeneration,
        slot,
        seatId: gameSeatId,
        bridge,
        active: true,
        iterator: null,
        consumer: null,
        settlements: new Map(),
      };
      bridges.set(slot, entry);
      if (!preparedConnected) {
        try {
          await bridge.connect();
        } catch (error) {
          bridges.delete(slot);
          entry.active = false;
          await closeEntry(entry);
          throw new TabletopManagerError(
            'BRIDGE_CONNECT_FAILED',
            `连接 AI 会话失败：${error?.message ?? error}`,
          );
        }
      }
      if (!isCurrent(targetGeneration)) {
        bridges.delete(slot);
        await closeEntry(entry);
        return false;
      }
      try {
        startConsumer(entry);
      } catch (error) {
        bridges.delete(slot);
        entry.active = false;
        await closeEntry(entry);
        throw new TabletopManagerError(
          'BRIDGE_SUBSCRIBE_FAILED',
          `订阅 AI 会话事件失败：${error?.message ?? error}`,
        );
      }
      return true;
    }

    async function prepareAll(targetGeneration) {
      for (let slot = 0; slot < TABLETOP_PLAYER_COUNT; slot += 1) {
        if (!isCurrent(targetGeneration)) return false;
        if (!record || position.status !== 'playing') return false;
        const player = record.players[slot];
        if (!player || player.kind !== 'ai') continue;
        await preparePlayer(targetGeneration, slot);
        if (!isCurrent(targetGeneration)) return false;
      }
      return true;
    }

    async function prepareAndSettle(targetGeneration) {
      try {
        await prepareAll(targetGeneration);
        if (!isCurrent(targetGeneration) || !record) return;
        if (position.status === 'finished') {
          setPhase('ready', finishedMessage(record, position));
          return;
        }
        if (record.players[position.currentPlayer].kind === 'human') {
          setPhase('ready', humanTurnMessage(record, position));
          return;
        }
        setPhase('thinking', aiTurnMessage(record, position));
        scheduleAi(targetGeneration);
      } catch (error) {
        failRuntime(targetGeneration, error, '准备 AI 会话失败');
      }
    }

    function kickoff(targetGeneration) {
      if (!isCurrent(targetGeneration) || !record) return;
      if (position.status === 'finished') {
        setPhase('ready', finishedMessage(record, position));
        return;
      }
      if (record.players[position.currentPlayer].kind === 'human') {
        void prepareAndSettle(targetGeneration);
        return;
      }
      scheduleAi(targetGeneration);
    }

    async function requestAiMove(targetGeneration, game, slot, entry, reason) {
      const attemptId = `game-attempt-${nextId()}`;
      const packet = {
        roomId: `game:${game.gameId}`,
        roomSeq: game.moves.length + 1,
        turnId: game.gameId,
        attemptId,
        seatId: entry.seatId,
        contextEpoch: game.gameId,
        text: buildTabletopPrompt({
          gameType,
          position,
          players: game.players,
          moves: game.moves,
          playerSlot: slot,
          retryReason: reason,
        }),
      };
      const waiter = createWaiter(targetGeneration, entry, attemptId);
      let receipt;
      try {
        receipt = await entry.bridge.send(packet);
      } catch (error) {
        clearWaiter(waiter);
        retireEntry(entry);
        void closeEntry(entry).catch(() => {});
        throw new TabletopManagerError(
          'AI_SEND_FAILED',
          `发送 AI 落子请求失败：${error?.message ?? error}`,
        );
      }
      if (!isCurrent(targetGeneration)) {
        clearWaiter(waiter);
        return '';
      }
      if (!receipt || receipt.accepted !== true) {
        clearWaiter(waiter);
        throw new TabletopManagerError('AI_SEND_REJECTED', 'AI 拒绝了落子请求。');
      }
      return waiter.promise;
    }

    async function applyAiReply(targetGeneration, slot, text) {
      const parsed = parseTabletopResponse(text);
      if (parsed === null) {
        throw new TabletopManagerError(
          'AI_ACTION_INVALID',
          'AI 回复不是可用的落子；请只回复 {"action":<合法动作对象>,"comment":"一句简短公开理由"}。',
        );
      }

      let normalized;
      try {
        normalized = engine.normalizeAction(parsed.action);
      } catch (error) {
        throw new TabletopManagerError(
          'AI_ACTION_INVALID',
          `AI 选择的动作不合法：${error?.message ?? error}`,
        );
      }

      return enqueue(async () => {
        if (!isCurrent(targetGeneration)) return { stale: true };
        if (!record || position.status !== 'playing') return { stale: true };
        if (position.currentPlayer !== slot) return { stale: true };

        const at = now();
        let nextPosition;
        try {
          nextPosition = engine.applyTurn(position, { player: slot, action: normalized });
        } catch (error) {
          throw new TabletopManagerError(
            'AI_ACTION_ILLEGAL',
            `AI 选择了不可用的动作：${error?.message ?? error}；这一步没有落子。`,
          );
        }

        const nextRecord = {
          ...record,
          players: record.players,
          moves: [
            ...record.moves,
            {
              seq: record.moves.length + 1,
              player: slot,
              action: normalized,
              at,
              comment: parsed.comment,
            },
          ],
          updatedAt: at,
          revision: record.revision + 1,
        };

        try {
          await store.save(nextRecord);
        } catch (error) {
          failRuntime(targetGeneration, error, '保存 AI 落子失败');
          return { error: true };
        }
        record = nextRecord;
        position = nextPosition;
        retryReason = null;
        return { applied: true };
      });
    }

    async function runAiTurn(targetGeneration, reason) {
      let retry = reason;
      while (isCurrent(targetGeneration)) {
        if (!record) return;
        if (position.status !== 'playing') {
          setPhase('ready', finishedMessage(record, position));
          return;
        }
        const slot = position.currentPlayer;
        const player = record.players[slot];
        if (!player || player.kind !== 'ai') {
          setPhase('ready', humanTurnMessage(record, position));
          return;
        }

        const ready = await prepareAll(targetGeneration);
        if (!ready || !isCurrent(targetGeneration)) return;
        if (!record || position.status !== 'playing') return;
        if (position.currentPlayer !== slot) continue;

        const entry = bridges.get(slot);
        if (!entry?.active) {
          throw new TabletopManagerError('BRIDGE_NOT_READY', 'AI Bridge 尚未准备好。');
        }

        setPhase('thinking', aiTurnMessage(record, position));
        const text = await requestAiMove(targetGeneration, record, slot, entry, retry);
        retry = undefined;
        if (!isCurrent(targetGeneration)) return;

        const result = await applyAiReply(targetGeneration, slot, text);
        if (result.stale || result.error) return;
        if (position.status === 'finished') {
          setPhase('ready', finishedMessage(record, position));
          return;
        }
        if (record.players[position.currentPlayer].kind === 'human') {
          setPhase('ready', humanTurnMessage(record, position));
          return;
        }
        // 同一 AI 连走或轮到下一位 AI：继续串行执行。
      }
    }

    function advance(targetGeneration) {
      if (!record) return;
      if (position.status === 'finished') {
        setPhase('ready', finishedMessage(record, position));
      } else if (record.players[position.currentPlayer].kind === 'human') {
        setPhase('ready', humanTurnMessage(record, position));
      } else {
        setPhase('thinking', aiTurnMessage(record, position));
        scheduleAi(targetGeneration);
      }
    }

    async function newGameOperation(playersInput) {
      assertOpen();
      const players = normalizePlayersInput(playersInput);
      const at = now();
      const game = {
        gameId: nextId(),
        gameType,
        players,
        moves: [],
        createdAt: at,
        updatedAt: at,
        revision: 0,
      };
      const targetGeneration = invalidateGeneration();
      const hasAi = players.some((player) => player.kind === 'ai');
      record = game;
      position = engine.createPosition();
      retryReason = null;
      phase = hasAi ? 'preparing' : 'ready';
      message = hasAi ? '正在准备 AI 会话…' : humanTurnMessage(game, position);

      try {
        await store.save(game);
      } catch (error) {
        failRuntime(targetGeneration, error, '保存新对局失败');
        return snapshot();
      }
      if (!isCurrent(targetGeneration)) return snapshot();
      emit(rt);
      if (hasAi) {
        defer(targetGeneration, () => {
          if (isCurrent(targetGeneration)) kickoff(targetGeneration);
        });
      }
      return snapshot();
    }

    function newGame(playersInput) {
      return enqueue(() => newGameOperation(playersInput));
    }

    function move(action) {
      return enqueue(async () => {
        assertOpen();
        const targetGeneration = generation;
        if (!record || position.status !== 'playing') {
          fail('GAME_NOT_PLAYING', '当前没有进行中的对局。');
        }
        if (phase !== 'ready') {
          fail('GAME_NOT_READY', '对局尚未就绪，请稍候或点击“继续”。');
        }
        const slot = position.currentPlayer;
        const player = record.players[slot];
        if (!player || player.kind !== 'human') {
          fail('NOT_HUMAN_TURN', '当前不是人类回合。');
        }

        const normalized = engine.normalizeAction(action);

        const at = now();
        const nextPosition = engine.applyTurn(position, { player: slot, action: normalized });
        const nextRecord = {
          ...record,
          moves: [
            ...record.moves,
            {
              seq: record.moves.length + 1,
              player: slot,
              action: normalized,
              at,
              comment: '',
            },
          ],
          updatedAt: at,
          revision: record.revision + 1,
        };
        try {
          await store.save(nextRecord);
        } catch (error) {
          failRuntime(targetGeneration, error, '保存落子失败');
          return snapshot();
        }
        if (!isCurrent(targetGeneration)) return snapshot();

        record = nextRecord;
        position = nextPosition;
        retryReason = null;
        advance(targetGeneration);
        return snapshot();
      });
    }

    function resume() {
      return enqueue(async () => {
        assertOpen();
        const targetGeneration = generation;
        if (!record) {
          fail('GAME_NOT_PLAYING', '当前没有进行中的对局。');
        }
        if (position.status === 'finished') {
          setPhase('ready', finishedMessage(record, position));
          return snapshot();
        }
        const slot = position.currentPlayer;
        if (record.players[slot].kind === 'human') {
          if (phase !== 'preparing') {
            retryReason = null;
            setPhase('ready', humanTurnMessage(record, position));
          }
          return snapshot();
        }

        if (phase === 'preparing'
          || (aiRun && aiRun.generation === targetGeneration && !aiRun.done)) {
          return snapshot();
        }

        const reason = retryReason ?? RETRY_REASON;
        retryReason = null;
        setPhase('preparing', '正在恢复 AI 对局…');
        defer(targetGeneration, () => {
          if (isCurrent(targetGeneration)) scheduleAi(targetGeneration, reason);
        });
        return snapshot();
      });
    }

    function init() {
      if (initPromiseForType) return initPromiseForType;
      initPromiseForType = enqueue(async () => {
        assertOpen();
        let loaded;
        try {
          loaded = await store.load();
        } catch (error) {
          record = null;
          position = null;
          phase = 'error';
          message = `读取 ${gameType} 存档失败：${errorDetail(error)}`;
          return snapshot();
        }
        if (loaded === null || loaded === undefined) {
          record = null;
          position = null;
          phase = 'idle';
          message = '尚无对局。';
          return snapshot();
        }
        if (!isPlainObject(loaded)
          || !isPlainObject(loaded.game)
          || !isPlainObject(loaded.position)
          || loaded.game.gameType !== gameType) {
          record = null;
          position = null;
          phase = 'error';
          message = `${gameType} 存档结构无效，无法恢复对局。`;
          return snapshot();
        }

        invalidateGeneration();
        record = loaded.game;
        position = loaded.position;
        retryReason = null;
        if (position.status === 'finished') {
          phase = 'ready';
          message = finishedMessage(record, position);
        } else if (record.players[position.currentPlayer].kind === 'human') {
          phase = 'ready';
          message = humanTurnMessage(record, position);
        } else {
          phase = 'idle';
          message = '轮到 AI，点击“继续”让 AI 落子。';
        }
        return snapshot();
      });
      return initPromiseForType;
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') {
        fail('LISTENER_INVALID', 'subscribe() 需要函数监听器。');
      }
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }

    function closeRuntime() {
      if (closePromiseForType) return closePromiseForType;
      closePromiseForType = (async () => {
        const waiter = pendingWaiter;
        pendingWaiter = null;
        if (waiter) {
          settleWaiter(waiter, {
            status: 'failed',
            code: 'MANAGER_CLOSED',
            message: '桌面对局管理器已关闭。',
          });
        }
        generation += 1;
        aiRun = null;
        const entries = [...bridges.values()];
        bridges.clear();
        await Promise.allSettled(entries.map((entry) => closeEntry(entry)));
      })();
      return closePromiseForType;
    }

    const rt = {
      gameType,
      snapshot,
      enqueue,
      newGame,
      move,
      resume,
      init,
      close: closeRuntime,
      get generation() {
        return generation;
      },
    };
    return rt;
  }

  const runtimes = new Map(TABLETOP_TYPES.map((type) => [type, createRuntime(type)]));

  function runtimeFor(gameType) {
    if (!isTabletopType(gameType)) {
      fail(
        'TABLETOP_TYPE_UNKNOWN',
        `未知的桌面对局类型：${String(gameType)}（可用：${TABLETOP_TYPES.join(', ')}）。`,
      );
    }
    return runtimes.get(gameType);
  }

  function hubSnapshot() {
    return {
      gameType: null,
      game: null,
      runtime: { phase: 'idle', message: '请选择一个桌面对局。' },
      seatOptions,
      ownerName,
    };
  }

  function getSnapshot(gameType) {
    if (gameType === undefined || gameType === null) return hubSnapshot();
    return runtimeFor(gameType).snapshot();
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      assertOpen();
      const entries = await Promise.all(TABLETOP_TYPES.map(async (type) => {
        const rt = runtimes.get(type);
        const snapshot = await rt.init();
        return [type, snapshot];
      }));
      return Object.fromEntries(entries);
    })();
    return initPromise;
  }

  async function newGame(gameType, playersInput) {
    return runtimeFor(gameType).newGame(playersInput);
  }

  async function move(gameType, action) {
    return runtimeFor(gameType).move(action);
  }

  async function resume(gameType) {
    return runtimeFor(gameType).resume();
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      fail('LISTENER_INVALID', 'subscribe() 需要函数监听器。');
    }
    if (closed) return () => {};
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      await Promise.allSettled([...runtimes.values()].map((rt) => rt.close()));
      listeners.clear();
    })();
    return closePromise;
  }

  return {
    init,
    newGame,
    move,
    resume,
    getSnapshot,
    subscribe,
    close,
  };
}
