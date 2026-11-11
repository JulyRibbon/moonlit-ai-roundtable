import { randomUUID } from 'node:crypto';

import {
  PLAYER_COUNT,
  applyMove,
  createGame,
  listAvailableEdges,
} from './rules.mjs';
import { buildMovePrompt, parseAiResponse } from './prompt.mjs';

export const GAME_COLORS = Object.freeze([
  '#e9b45f',
  '#6ea8ff',
  '#c79bff',
  '#63d2a4',
]);

export class GameCoordinatorError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'GameCoordinatorError';
    this.code = code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GameCoordinatorError);
    }
  }
}

function fail(code, message) {
  throw new GameCoordinatorError(code, message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function trimmedName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function publicGame(game) {
  if (game === null || game === undefined) return null;
  const clone = structuredClone(game);
  if (Array.isArray(clone.players)) {
    for (const player of clone.players) {
      if (player && typeof player === 'object') delete player.nativeSessionRef;
    }
  }
  return clone;
}

function humanTurnMessage(game) {
  const player = game.players[game.currentPlayer];
  return `轮到 ${player.name}（slot ${player.slot}）落子。`;
}

function aiTurnMessage(game) {
  const player = game.players[game.currentPlayer];
  return `AI ${player.name} 正在思考…`;
}

function finishedMessage(game) {
  const winners = Array.isArray(game.winners) ? game.winners : [];
  const names = winners
    .map((slot) => game.players[slot]?.name ?? `slot ${slot}`)
    .join('、');
  const scores = game.players
    .map((player) => `${player.name} ${game.scores[player.slot] ?? 0}`)
    .join('，');
  return `对局结束：${names || '无'} 获胜（${scores}）。`;
}

function errorDetail(error) {
  const message = error?.message ?? String(error);
  return message.endsWith('。') ? message : `${message}。`;
}

/**
 * 独立于聊天房间引擎的点格棋协调器。
 * 它只使用游戏自己的 Bridge 实例与原生会话，不写聊天 transcript / attempt / events。
 */
export function createGameCoordinator(options = {}) {
  const {
    config,
    factories,
    createNativeSession,
    store,
    now = () => new Date().toISOString(),
    id = () => randomUUID(),
    wait,
  } = options ?? {};

  if (!isPlainObject(config)) {
    fail('CONFIG_INVALID', 'createGameCoordinator() 需要 config 对象。');
  }
  if (typeof config.roomId !== 'string' || config.roomId.trim().length === 0) {
    fail('CONFIG_INVALID', 'config.roomId 必须是非空字符串。');
  }
  const ownerName = trimmedName(config.ownerName);
  if (ownerName.length === 0 || ownerName.length > 32) {
    fail('CONFIG_INVALID', 'config.ownerName 必须是 1..32 个字符。');
  }
  if (!Array.isArray(config.seats) || config.seats.length === 0) {
    fail('CONFIG_INVALID', 'config.seats 必须是非空数组。');
  }
  if (!isPlainObject(factories)) {
    fail('CONFIG_INVALID', 'createGameCoordinator() 需要按 clientType 索引的 factories。');
  }
  if (typeof createNativeSession !== 'function') {
    fail('CONFIG_INVALID', 'createGameCoordinator() 需要 createNativeSession 回调。');
  }
  if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
    fail('CONFIG_INVALID', 'createGameCoordinator() 需要带 load()/save() 的 store。');
  }
  if (typeof now !== 'function' || typeof id !== 'function') {
    fail('CONFIG_INVALID', 'now 与 id 必须是函数。');
  }

  const seenSeatIds = new Set();
  const seats = config.seats.map((seat, index) => {
    if (!isPlainObject(seat)) fail('CONFIG_INVALID', `config.seats[${index}] 必须是对象。`);
    const seatId = trimmedName(seat.seatId);
    const clientType = trimmedName(seat.clientType);
    const displayName = trimmedName(seat.displayName) || seatId;
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
      color: typeof seat.color === 'string' ? seat.color : GAME_COLORS[index % PLAYER_COUNT],
      enabled: seat.enabled !== false,
      client: isPlainObject(seat.client) ? structuredClone(seat.client) : {},
    };
  });
  const enabledSeats = seats.filter((seat) => seat.enabled);
  const seatById = new Map(enabledSeats.map((seat) => [seat.seatId, seat]));

  let state = {
    game: null,
    phase: 'idle',
    message: '',
    retryReason: null,
  };
  let generation = 0;
  let closed = false;
  let initPromise = null;
  let closePromise = null;
  let operationQueue = Promise.resolve();
  let pendingTurn = null;
  let aiRun = null;
  let eventSequence = 0;
  const bridges = new Map();
  const listeners = new Set();

  function assertOpen() {
    if (closed) fail('COORDINATOR_CLOSED', '对局协调器已关闭。');
  }

  function nextId() {
    const value = id();
    if (typeof value === 'string' && value.length > 0) return value;
    if (value !== undefined && value !== null && String(value).length > 0) return String(value);
    fail('ID_INVALID', 'id() 没有返回有效标识。');
  }

  function enqueue(task) {
    const run = operationQueue.then(task, task);
    operationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  function isCurrent(targetGeneration) {
    return !closed && targetGeneration === generation;
  }

  function getSnapshot() {
    return {
      game: state.game === null ? null : publicGame(state.game),
      runtime: {
        phase: state.phase,
        message: state.message,
      },
      seatOptions: enabledSeats.map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        color: seat.color,
        clientType: seat.clientType,
      })),
      ownerName,
    };
  }

  function emit() {
    if (listeners.size === 0) return;
    eventSequence += 1;
    let suffix = 'event';
    try {
      suffix = nextId();
    } catch {
      // 事件 ID 至少保持序号唯一；不让事件发送失败拖垮对局。
    }
    const event = {
      eventId: `ge_${eventSequence}_${suffix}`,
      type: 'GameChanged',
      snapshot: getSnapshot(),
    };
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // 订阅者异常不能影响游戏状态。
      }
    }
  }

  function setPhase(phase, message) {
    state.phase = phase;
    state.message = typeof message === 'string' ? message : '';
    emit();
  }

  function failRuntime(targetGeneration, error, prefix = '对局出错') {
    if (!isCurrent(targetGeneration)) return;
    state.phase = 'error';
    state.message = `${prefix}：${errorDetail(error)}点击“继续”可重试。`;
    state.retryReason = '上一次尝试没有成功，请重新只回复一个 JSON 对象 {"edge":"h:x:y","comment":"一句简短公开理由"}。';
    emit();
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
    if (pendingTurn === waiter) pendingTurn = null;
    if (outcome.status === 'completed') {
      waiter.resolve(outcome.text);
    } else {
      waiter.reject(new GameCoordinatorError(
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
    pendingTurn = waiter;
    const alreadySettled = entry.settlements.get(attemptId);
    if (alreadySettled) {
      queueMicrotask(() => settleWaiter(waiter, alreadySettled));
    }
    return waiter;
  }

  function clearWaiter(waiter) {
    if (!waiter || waiter.settled) return;
    waiter.settled = true;
    if (pendingTurn === waiter) pendingTurn = null;
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
      const waiter = pendingTurn;
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
    const waiter = pendingTurn;
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
          const waiter = pendingTurn;
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
        const waiter = pendingTurn;
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
      // 关闭失败不影响协调器。
    }
  }

  function invalidateGeneration() {
    generation += 1;
    const waiter = pendingTurn;
    pendingTurn = null;
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
    if (!Array.isArray(playersInput) || playersInput.length !== PLAYER_COUNT) {
      fail('PLAYERS_INVALID', `players 必须恰好包含 ${PLAYER_COUNT} 席。`);
    }
    const usedSlots = new Set();
    const usedSeatIds = new Set();
    const normalized = new Array(PLAYER_COUNT);

    playersInput.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        fail('PLAYERS_INVALID', `players[${index}] 必须是对象。`);
      }
      const slot = entry.slot === undefined ? index : entry.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= PLAYER_COUNT || usedSlots.has(slot)) {
        fail('PLAYERS_INVALID', `players[${index}] 的 slot 无效或重复。`);
      }
      usedSlots.add(slot);
      if (entry.kind !== 'human' && entry.kind !== 'ai') {
        fail('PLAYERS_INVALID', `players[${index}].kind 必须是 human 或 ai。`);
      }

      let seat = null;
      if (entry.kind === 'ai') {
        const seatId = trimmedName(entry.seatId);
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
          ? (slot === 0 ? ownerName : `人类 ${slot + 1}`)
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
        color: GAME_COLORS[slot],
        seatId: entry.kind === 'ai' ? seat.seatId : null,
        nativeSessionRef: null,
      };
    });

    if (usedSlots.size !== PLAYER_COUNT) {
      fail('PLAYERS_INVALID', 'players 的 slot 必须覆盖 0..3。');
    }
    return normalized;
  }

  function scheduleAi(targetGeneration, retryReason) {
    if (!isCurrent(targetGeneration)) return null;
    if (aiRun && aiRun.generation === targetGeneration && !aiRun.done) {
      return aiRun.promise;
    }
    const token = { generation: targetGeneration, done: false, promise: null };
    const promise = (async () => {
      try {
        await runAiTurn(targetGeneration, { retryReason });
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

  async function prepareAll(targetGeneration) {
    for (let slot = 0; slot < PLAYER_COUNT; slot += 1) {
      if (!isCurrent(targetGeneration)) return;
      const game = state.game;
      if (!game || game.status !== 'playing') return;
      const player = game.players[slot];
      if (!player || player.kind !== 'ai') continue;

      const existing = bridges.get(slot);
      if (existing?.active) continue;
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
        const created = await createNativeSession(player.seatId, { gameId: game.gameId, slot });
        preparedBridge = created?.bridge ?? null;
        preparedConnected = created?.connected === true;
        if (!isCurrent(targetGeneration)) {
          await preparedBridge?.close?.().catch(() => {});
          return;
        }
        const ref = created?.nativeSessionRef;
        if (typeof ref !== 'string' || ref.length === 0) {
          await preparedBridge?.close?.().catch(() => {});
          fail('SESSION_CREATE_FAILED', `${seat.clientType} 没有返回新的会话 ID。`);
        }
        const saved = await enqueue(async () => {
          if (!isCurrent(targetGeneration)) return false;
          const currentGame = state.game;
          if (!currentGame || currentGame.status !== 'playing') return false;
          const currentPlayer = currentGame.players[slot];
          if (!currentPlayer || currentPlayer.kind !== 'ai' || currentPlayer.seatId !== player.seatId) {
            return false;
          }
          currentPlayer.nativeSessionRef = ref;
          await store.save(currentGame);
          return true;
        });
        if (!saved) {
          await preparedBridge?.close?.().catch(() => {});
          return;
        }
        nativeSessionRef = ref;
      }

      if (!isCurrent(targetGeneration)) {
        await preparedBridge?.close?.().catch(() => {});
        return;
      }
      const latestGame = state.game;
      if (!latestGame || latestGame.status !== 'playing') {
        await preparedBridge?.close?.().catch(() => {});
        return;
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
        throw new GameCoordinatorError(
          'BRIDGE_CREATE_FAILED',
          `创建 AI Bridge 失败：${error?.message ?? error}`,
        );
      }
      if (!bridge
        || typeof bridge.connect !== 'function'
        || typeof bridge.subscribe !== 'function'
        || typeof bridge.send !== 'function') {
        await preparedBridge?.close?.().catch(() => {});
        throw new GameCoordinatorError('BRIDGE_INVALID', 'Bridge 工厂返回了无效实例。');
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
          throw new GameCoordinatorError(
            'BRIDGE_CONNECT_FAILED',
            `连接 AI 会话失败：${error?.message ?? error}`,
          );
        }
      }
      if (!isCurrent(targetGeneration)) {
        bridges.delete(slot);
        await closeEntry(entry);
        return;
      }
      try {
        startConsumer(entry);
      } catch (error) {
        bridges.delete(slot);
        entry.active = false;
        await closeEntry(entry);
        throw new GameCoordinatorError(
          'BRIDGE_SUBSCRIBE_FAILED',
          `订阅 AI 会话事件失败：${error?.message ?? error}`,
        );
      }
    }
  }

  async function prepareAndSettle(targetGeneration) {
    try {
      await prepareAll(targetGeneration);
      if (!isCurrent(targetGeneration)) return;
      const game = state.game;
      if (!game) return;
      if (game.status === 'finished') {
        setPhase('ready', finishedMessage(game));
        return;
      }
      if (game.players[game.currentPlayer].kind === 'human') {
        setPhase('ready', humanTurnMessage(game));
        return;
      }
      setPhase('thinking', aiTurnMessage(game));
      scheduleAi(targetGeneration);
    } catch (error) {
      failRuntime(targetGeneration, error, '准备 AI 会话失败');
    }
  }

  function kickoff(targetGeneration) {
    if (!isCurrent(targetGeneration)) return;
    const game = state.game;
    if (!game) return;
    if (game.status === 'finished') {
      setPhase('ready', finishedMessage(game));
      return;
    }
    if (game.players[game.currentPlayer].kind === 'human') {
      void prepareAndSettle(targetGeneration);
      return;
    }
    scheduleAi(targetGeneration);
  }

  async function requestAiMove(targetGeneration, game, slot, entry, retryReason) {
    const attemptId = `game-attempt-${nextId()}`;
    const packet = {
      roomId: `game:${game.gameId}`,
      roomSeq: game.moves.length + 1,
      turnId: game.gameId,
      attemptId,
      seatId: entry.seatId,
      contextEpoch: game.gameId,
      text: buildMovePrompt(game, slot, retryReason === undefined ? undefined : { retryReason }),
    };
    const waiter = createWaiter(targetGeneration, entry, attemptId);
    let receipt;
    try {
      receipt = await entry.bridge.send(packet);
    } catch (error) {
      clearWaiter(waiter);
      retireEntry(entry);
      void closeEntry(entry).catch(() => {});
      throw new GameCoordinatorError(
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
      throw new GameCoordinatorError('AI_SEND_REJECTED', 'AI 拒绝了落子请求。');
    }
    return waiter.promise;
  }

  async function runAiTurn(targetGeneration, { retryReason } = {}) {
    let reason = retryReason;
    while (isCurrent(targetGeneration)) {
      const game = state.game;
      if (!game) return;
      if (game.status !== 'playing') {
        setPhase('ready', finishedMessage(game));
        return;
      }
      const slot = game.currentPlayer;
      const player = game.players[slot];
      if (!player || player.kind !== 'ai') {
        setPhase('ready', humanTurnMessage(game));
        return;
      }

      await prepareAll(targetGeneration);
      if (!isCurrent(targetGeneration)) return;
      const preparedGame = state.game;
      if (!preparedGame || preparedGame.status !== 'playing') return;
      if (preparedGame.currentPlayer !== slot) continue;

      const entry = bridges.get(slot);
      if (!entry?.active) {
        throw new GameCoordinatorError('BRIDGE_NOT_READY', 'AI Bridge 尚未准备好。');
      }

      setPhase('thinking', aiTurnMessage(preparedGame));
      const text = await requestAiMove(targetGeneration, preparedGame, slot, entry, reason);
      reason = undefined;
      if (!isCurrent(targetGeneration)) return;

      const parsedReply = parseAiResponse(text);
      if (parsedReply === null) {
        throw new GameCoordinatorError(
          'AI_MOVE_INVALID',
          'AI 回复不是可用的落子；请只回复 {"edge":"h:x:y","comment":"一句简短公开理由"}。',
        );
      }
      const { edge, comment } = parsedReply;

      const result = await enqueue(async () => {
        if (!isCurrent(targetGeneration)) return { stale: true };
        const currentGame = state.game;
        if (!currentGame || currentGame.status !== 'playing') return { stale: true };
        if (currentGame.currentPlayer !== slot) return { stale: true };
        const available = listAvailableEdges(currentGame);
        if (!available.includes(edge)) {
          throw new GameCoordinatorError(
            'AI_EDGE_OCCUPIED',
            `AI 选择了不可用的边 ${edge}；这一步没有落子。`,
          );
        }
        const next = applyMove(currentGame, {
          player: slot,
          edge,
          at: now(),
          comment,
        });
        try {
          await store.save(next);
        } catch (error) {
          failRuntime(targetGeneration, error, '保存 AI 落子失败');
          return { error: true };
        }
        state.game = next;
        state.retryReason = null;
        if (next.status === 'finished') {
          setPhase('ready', finishedMessage(next));
        } else if (next.players[next.currentPlayer].kind === 'human') {
          setPhase('ready', humanTurnMessage(next));
        } else {
          setPhase('thinking', aiTurnMessage(next));
        }
        return { applied: true, next };
      });

      if (result.stale || result.error) return;
      const next = result.next;
      if (next.status === 'finished') return;
      if (next.players[next.currentPlayer].kind === 'human') return;
      // 同一 AI 围格连走，或轮到下一位 AI：继续串行执行。
    }
  }

  async function newGameOperation(playersInput) {
    assertOpen();
    const players = normalizePlayersInput(playersInput);
    const game = createGame({
      gameId: nextId(),
      players,
      createdAt: now(),
    });
    const targetGeneration = invalidateGeneration();
    const hasAi = game.players.some((player) => player.kind === 'ai');
    state.game = game;
    state.retryReason = null;
    state.phase = hasAi ? 'preparing' : 'ready';
    state.message = hasAi ? '正在准备 AI 会话…' : humanTurnMessage(game);

    try {
      await store.save(game);
    } catch (error) {
      failRuntime(targetGeneration, error, '保存新对局失败');
      return getSnapshot();
    }
    if (!isCurrent(targetGeneration)) return getSnapshot();
    emit();
    if (hasAi) {
      defer(targetGeneration, () => {
        if (isCurrent(targetGeneration)) kickoff(targetGeneration);
      });
    }
    return getSnapshot();
  }

  function newGame(playersInput) {
    return enqueue(() => newGameOperation(playersInput));
  }

  function move(edge) {
    return enqueue(async () => {
      assertOpen();
      const targetGeneration = generation;
      const game = state.game;
      if (!game || game.status !== 'playing') {
        fail('GAME_NOT_PLAYING', '当前没有进行中的对局。');
      }
      if (state.phase !== 'ready') {
        fail('GAME_NOT_READY', '对局尚未就绪，请稍候或点击“继续”。');
      }
      const player = game.players[game.currentPlayer];
      if (player.kind !== 'human') {
        fail('NOT_HUMAN_TURN', '当前不是人类回合。');
      }

      // 规则错误（非法边、已占用、非当前玩家）原样向上抛出。
      const next = applyMove(game, {
        player: game.currentPlayer,
        edge,
        at: now(),
      });
      try {
        await store.save(next);
      } catch (error) {
        failRuntime(targetGeneration, error, '保存落子失败');
        return getSnapshot();
      }
      if (!isCurrent(targetGeneration)) return getSnapshot();

      state.game = next;
      state.retryReason = null;
      if (next.status === 'finished') {
        setPhase('ready', finishedMessage(next));
      } else if (next.players[next.currentPlayer].kind === 'human') {
        setPhase('ready', humanTurnMessage(next));
      } else {
        setPhase('thinking', aiTurnMessage(next));
        scheduleAi(targetGeneration);
      }
      return getSnapshot();
    });
  }

  function resume() {
    return enqueue(async () => {
      assertOpen();
      const targetGeneration = generation;
      const game = state.game;
      if (!game || game.status !== 'playing') {
        fail('GAME_NOT_PLAYING', '当前没有进行中的对局。');
      }
      const player = game.players[game.currentPlayer];
      if (player.kind === 'human') {
        if (state.phase !== 'preparing') {
          state.retryReason = null;
          setPhase('ready', humanTurnMessage(game));
        }
        return getSnapshot();
      }

      if (state.phase === 'preparing'
        || (aiRun && aiRun.generation === targetGeneration && !aiRun.done)) {
        return getSnapshot();
      }

      const retryReason = state.retryReason
        ?? '上一次尝试没有完成，请重新只回复一个 JSON 对象 {"edge":"h:x:y","comment":"一句简短公开理由"}。';
      state.retryReason = null;
      setPhase('preparing', '正在恢复 AI 对局…');
      defer(targetGeneration, () => {
        if (isCurrent(targetGeneration)) scheduleAi(targetGeneration, retryReason);
      });
      return getSnapshot();
    });
  }

  function init() {
    if (initPromise) return initPromise;
    initPromise = enqueue(async () => {
      assertOpen();
      let loaded;
      try {
        loaded = await store.load();
      } catch (error) {
        state.phase = 'error';
        state.message = `读取对局存档失败：${errorDetail(error)}`;
        return getSnapshot();
      }
      if (loaded === null || loaded === undefined) {
        state.game = null;
        state.phase = 'idle';
        state.message = '尚无对局。';
        return getSnapshot();
      }
      if (!isPlainObject(loaded)
        || loaded.schemaVersion !== 1
        || !Array.isArray(loaded.players)
        || loaded.players.length !== PLAYER_COUNT
        || !Number.isInteger(loaded.currentPlayer)
        || loaded.currentPlayer < 0
        || loaded.currentPlayer >= PLAYER_COUNT
        || !Array.isArray(loaded.scores)
        || loaded.scores.length !== PLAYER_COUNT) {
        state.game = null;
        state.phase = 'error';
        state.message = '游戏存档结构无效，无法恢复对局。';
        return getSnapshot();
      }

      invalidateGeneration();
      state.game = loaded;
      state.retryReason = null;
      if (loaded.status === 'finished') {
        state.phase = 'ready';
        state.message = finishedMessage(loaded);
      } else if (loaded.players[loaded.currentPlayer].kind === 'human') {
        state.phase = 'ready';
        state.message = humanTurnMessage(loaded);
      } else {
        state.phase = 'idle';
        state.message = '轮到 AI，点击“继续”让 AI 落子。';
      }
      return getSnapshot();
    });
    return initPromise;
  }

  function getSnapshotValue() {
    return getSnapshot();
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
      const waiter = pendingTurn;
      pendingTurn = null;
      if (waiter) {
        settleWaiter(waiter, {
          status: 'failed',
          code: 'COORDINATOR_CLOSED',
          message: '对局协调器已关闭。',
        });
      }
      generation += 1;
      aiRun = null;
      const entries = [...bridges.values()];
      bridges.clear();
      listeners.clear();
      await Promise.allSettled(entries.map((entry) => closeEntry(entry)));
    })();
    return closePromise;
  }

  return {
    init,
    newGame,
    move,
    resume,
    getSnapshot: getSnapshotValue,
    subscribe,
    close,
  };
}
