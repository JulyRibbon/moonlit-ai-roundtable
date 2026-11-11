import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDshBridge } from '../adapters/dsh/bridge.mjs';
import { createFakeBridge } from '../adapters/fake/bridge.mjs';
import { createKimiCodeBridge } from '../adapters/kimi-code/bridge.mjs';
import { createQwenCodeBridge } from '../adapters/qwen-code/bridge.mjs';
import { createZCodeBridge } from '../adapters/zcode/bridge.mjs';
import { createRoomEngine } from '../core/engine.mjs';
import { createBudgetGuard } from '../core/budget.mjs';
import { createHaltGuard } from '../core/halt.mjs';
import { createRoomStore } from '../store/room-store.mjs';
import { createGameCoordinator } from '../games/dots-and-boxes/coordinator.mjs';
import { createGameStore } from '../games/dots-and-boxes/store.mjs';
import { createTabletopManager } from '../games/tabletop/coordinator.mjs';
import { ConfigError, loadConfig, updateConfig, validateConfig } from './config.mjs';
import { createRoomServer } from './http.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
// 2960 在本机被 DeepSeek Harness 自己占用（实测 127.0.0.1:2960），
// 所以默认端口对齐 start-all 的 2961；需要时用 --port 或 AIROOM_PORT 覆盖。
const DEFAULT_PORT = 2961;
const DEFAULT_HOST = '127.0.0.1';
const PORT_ENV = 'AIROOM_PORT';
const TOKEN_ENV = 'AIROOM_TOKEN';
const MAX_PORT = 65535;

export const DEFAULT_FACTORIES = Object.freeze({
  dsh: createDshBridge,
  'kimi-code': createKimiCodeBridge,
  zcode: createZCodeBridge,
  'qwen-code': createQwenCodeBridge,
  fake: createFakeBridge,
});

export class LiveError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LiveError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LiveError);
    }
  }
}

export class LiveCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LiveCliError';
    this.code = code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, LiveCliError);
    }
  }
}

function formatHost(host) {
  return typeof host === 'string' && host.includes(':') && !host.startsWith('[')
    ? `[${host}]`
    : host;
}

function normalizePort(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PORT) {
    throw new LiveError(
      'PORT_INVALID',
      `port 必须是 0..${MAX_PORT} 的整数，当前值：${JSON.stringify(value)}。`,
      { port: value },
    );
  }
  return value;
}

function resolvePort(explicit) {
  if (explicit !== undefined) return normalizePort(explicit);
  const raw = process.env[PORT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PORT) {
    throw new LiveError(
      'PORT_INVALID',
      `${PORT_ENV} 必须是 0..${MAX_PORT} 的整数，当前值：${JSON.stringify(raw)}。`,
      { env: PORT_ENV },
    );
  }
  return value;
}

function normalizeToken(value, source) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new LiveError(
      'TOKEN_INVALID',
      `${source} 必须是非空字符串。`,
      { source },
    );
  }
  return value;
}

function resolveToken(explicit) {
  if (explicit !== undefined) return normalizeToken(explicit, 'token');
  const fromEnv = process.env[TOKEN_ENV];
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return normalizeToken(fromEnv, TOKEN_ENV);
  }
  return randomBytes(24).toString('base64url');
}

function resolveFactories(overrides) {
  if (overrides === undefined) return DEFAULT_FACTORIES;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new LiveError('FACTORIES_INVALID', 'factories 必须是按 clientType 索引的对象。');
  }
  const resolved = { ...DEFAULT_FACTORIES };
  for (const [clientType, factory] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_FACTORIES, clientType)) {
      throw new LiveError(
        'FACTORY_UNKNOWN',
        `未知的 factories 键：${clientType}；可选值：${Object.keys(DEFAULT_FACTORIES).join(', ')}。`,
        { clientType },
      );
    }
    if (typeof factory !== 'function') {
      throw new LiveError(
        'FACTORY_INVALID',
        `factories.${clientType} 必须是函数。`,
        { clientType },
      );
    }
    resolved[clientType] = factory;
  }
  return resolved;
}

/**
 * 由已校验配置构造 seatId -> Bridge。保留 seat.client 里的客户端专用配置，
 * 但不记录任何配置内容；enabled:false 的席位不会出现在 Map 里。
 */
function buildBridges(config, factories = DEFAULT_FACTORIES) {
  const bridges = new Map();
  for (const seat of config.seats) {
    if (!seat.enabled) continue;
    const factory = factories[seat.clientType];
    if (typeof factory !== 'function') {
      throw new LiveError(
        'FACTORY_MISSING',
        `没有 clientType ${seat.clientType} 的 Bridge 工厂。`,
        { clientType: seat.clientType },
      );
    }
    const nativeSessionRef = seat.nativeSessionRef
      ?? (seat.clientType === 'fake' ? `fake_session_${seat.seatId}` : undefined);
    const bridge = factory({
      ...seat.client,
      seatId: seat.seatId,
      nativeSessionRef,
      voiceMode: seat.voiceMode,
    });
    bridges.set(seat.seatId, bridge);
  }
  if (bridges.size === 0) {
    throw new LiveError('BRIDGES_EMPTY', '没有启用的席位，无法创建 Bridge。');
  }
  return bridges;
}

/** 公开入口：先校验配置，再按 clientType 调用真实（或注入的）Bridge 工厂。 */
export function createBridges(config, options = {}) {
  const normalized = validateConfig(config);
  return buildBridges(normalized, resolveFactories(options.factories));
}

/**
 * 启动真实房间：读配置 → HaltGuard → RoomEngine（只 init，不 activate/run）→ HTTP。
 * token 只在启动 URL 里出现一次；日志不包含会话引用或客户端凭据。
 */
export async function startLive(options = {}) {
  let config = options.config !== undefined
    ? validateConfig(options.config)
    : (options.configPath !== undefined
      ? await loadConfig(options.configPath)
      : null);
  if (config === null) {
    throw new ConfigError(
      'CONFIG_REQUIRED',
      'startLive() 需要 config 对象或 configPath；CLI 请使用 --config <path>。',
    );
  }

  const host = options.host ?? DEFAULT_HOST;
  const port = resolvePort(options.port);
  const token = resolveToken(options.token);
  const stateDir = path.resolve(options.stateDir ?? path.join(PROJECT_ROOT, 'state'));
  const roomDir = path.resolve(
    options.roomDir ?? path.join(PROJECT_ROOT, 'rooms', config.roomId),
  );

  const haltGuard = createHaltGuard({ stateDir });
  const factories = resolveFactories(options.factories);
  let engine;
  let gameCoordinator;
  let tabletopManager;
  let budgetGuard = null;
  try {
    const bridges = buildBridges(config, factories);
    budgetGuard = config.budget === undefined ? null : createBudgetGuard(config.budget);
    engine = createRoomEngine({
      roomId: config.roomId,
      bridges,
      store: createRoomStore(roomDir),
      maxAttempts: config.maxAttempts,
      haltGuard,
      settings: {
        ownerName: config.ownerName,
        contextMessages: config.contextMessages,
        seats: config.seats
          .filter((seat) => seat.enabled)
          .map((seat) => ({
            seatId: seat.seatId,
            displayName: seat.displayName,
            color: seat.color,
            clientType: seat.clientType,
          })),
      },
      ...(budgetGuard === null ? {} : { budgetGuard }),
    });
    await engine.init();
    async function createGameNativeSession(seatId, { gameId = randomUUID(), slot = 0 } = {}) {
      const seat = config.seats.find((entry) => entry.seatId === seatId && entry.enabled);
      const sourceBridge = engine.bridges.get(seatId);
      if (!seat || typeof sourceBridge?.createNativeSession !== 'function') {
        throw new LiveError('SESSION_CREATE_UNSUPPORTED', `${seatId} 暂不支持创建游戏专席。`);
      }
      if (seat.clientType !== 'zcode') return sourceBridge.createNativeSession();

      const gameBridge = factories.zcode({
        ...seat.client,
        seatId: `game-${gameId}-${slot}`,
        nativeSessionRef: seat.nativeSessionRef,
        voiceMode: 'none',
      });
      try {
        const created = await gameBridge.createNativeSession();
        await gameBridge.adoptNativeSession(created.nativeSessionRef);
        return { ...created, bridge: gameBridge, connected: true };
      } catch (error) {
        await gameBridge.close().catch(() => {});
        throw error;
      }
    }
    gameCoordinator = createGameCoordinator({
      config,
      factories,
      store: createGameStore(path.join(roomDir, 'games', 'dots-and-boxes.json')),
      createNativeSession: createGameNativeSession,
    });
    await gameCoordinator.init();
    tabletopManager = createTabletopManager({
      config,
      factories,
      createNativeSession: createGameNativeSession,
      storeDir: path.dirname(roomDir),
    });
    await tabletopManager.init();
  } catch (error) {
    if (tabletopManager) await tabletopManager.close().catch(() => {});
    if (gameCoordinator) await gameCoordinator.close().catch(() => {});
    if (engine) await engine.close().catch(() => {});
    else await haltGuard.close().catch(() => {});
    throw error;
  }

  async function applySettings(normalized) {
    return engine.updateSettings({
      actor: 'owner',
      ownerName: normalized.ownerName,
      maxAttempts: normalized.maxAttempts,
      contextMessages: normalized.contextMessages,
      seatOrder: normalized.seats.filter((seat) => seat.enabled).map((seat) => seat.seatId),
      seats: normalized.seats.filter((seat) => seat.enabled).map((seat) => ({
        seatId: seat.seatId,
        displayName: seat.displayName,
        color: seat.color,
        clientType: seat.clientType,
      })),
    });
  }

  async function onUpdateSettings(input) {
    const previous = config;
    const profiles = new Map((input.seats ?? []).map((seat) => [seat.seatId, seat]));
    const enabledIds = input.seatOrder ?? previous.seats.filter((seat) => seat.enabled).map((seat) => seat.seatId);
    const orderedIds = [
      ...enabledIds,
      ...previous.seats.filter((seat) => !enabledIds.includes(seat.seatId)).map((seat) => seat.seatId),
    ];
    const next = validateConfig({
      ...previous,
      ownerName: input.ownerName ?? previous.ownerName,
      maxAttempts: input.maxAttempts ?? previous.maxAttempts,
      contextMessages: input.contextMessages ?? previous.contextMessages,
      seats: orderedIds.map((seatId) => {
        const seat = previous.seats.find((entry) => entry.seatId === seatId);
        const profile = profiles.get(seatId) ?? {};
        return { ...seat, ...profile };
      }),
    });
    const result = await applySettings(next);
    if (options.configPath) {
      try {
        config = await updateConfig(options.configPath, (raw) => ({
          ...raw,
          ownerName: next.ownerName,
          maxAttempts: next.maxAttempts,
          contextMessages: next.contextMessages,
          seats: next.seats.map((seat) => ({
            ...raw.seats.find((entry) => entry.seatId === seat.seatId),
            ...seat,
          })),
        }));
      } catch (error) {
        await applySettings(previous).catch(() => {});
        throw error;
      }
    } else {
      config = next;
    }
    return { ...result, persisted: Boolean(options.configPath) };
  }

  async function onResetSeat(seatId) {
    engine.assertManagementIdle();
    const seat = config.seats.find((entry) => entry.seatId === seatId && entry.enabled);
    if (!seat) throw new LiveError('SEAT_NOT_FOUND', `找不到启用的席位 ${seatId}。`);
    const oldBridge = engine.bridges.get(seatId);
    if (typeof oldBridge?.createNativeSession !== 'function') {
      throw new LiveError('SESSION_CREATE_UNSUPPORTED', `${seat.clientType} 暂不支持一键新会话。`);
    }
    const created = await oldBridge.createNativeSession();
    const nativeSessionRef = created?.nativeSessionRef;
    if (typeof nativeSessionRef !== 'string' || nativeSessionRef.length === 0) {
      throw new LiveError('SESSION_CREATE_FAILED', `${seat.clientType} 没有返回新的会话 ID。`);
    }
    const bridge = typeof oldBridge.adoptNativeSession === 'function'
      ? null
      : factories[seat.clientType]({
        ...seat.client,
        seatId,
        nativeSessionRef,
        voiceMode: seat.voiceMode,
      });
    const result = await engine.replaceSeatBridge({
      actor: 'owner',
      seatId,
      bridge,
      nativeSessionRef,
    });
    const next = validateConfig({
      ...config,
      seats: config.seats.map((entry) => entry.seatId === seatId
        ? { ...entry, nativeSessionRef }
        : entry),
    });
    let persisted = false;
    let persistenceError = null;
    if (options.configPath) {
      try {
        config = await updateConfig(options.configPath, (raw) => ({
          ...raw,
          seats: raw.seats.map((entry) => entry.seatId === seatId
            ? { ...entry, nativeSessionRef }
            : entry),
        }));
        persisted = true;
      } catch (error) {
        persistenceError = String(error?.message ?? error);
      }
    } else {
      config = next;
      persisted = true;
    }
    return { ...result, persisted, persistenceError };
  }

  let server;
  try {
    server = createRoomServer({
      engine,
      gameCoordinator,
      tabletopManager,
      token,
      host,
      port,
      webDir: options.webDir,
      onUpdateSettings,
      onResetSeat,
      onClearTranscript: () => engine.clearTranscript({ actor: 'owner' }),
      onResetCounters: () => engine.resetCounters({ actor: 'owner' }),
    });
    await server.listen();
  } catch (error) {
    await tabletopManager.close().catch(() => {});
    await gameCoordinator.close().catch(() => {});
    await engine.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    throw error;
  }

  const actualPort = server.address()?.port ?? port;
  const url = `http://${formatHost(host)}:${actualPort}/#token=${token}`;

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // 先停对外连接，再分别关闭游戏和聊天；二者都不删除原生会话。
      await haltGuard.close().catch(() => {});
      await server.close().catch(() => {});
      await tabletopManager.close().catch(() => {});
      await gameCoordinator.close().catch(() => {});
      await engine.close().catch(() => {});
    })();
    return closePromise;
  }

  console.log('[ai-room] live room ready');
  console.log(`[ai-room] room: ${config.roomId} (maxAttempts ${config.maxAttempts})`);
  console.log(`[ai-room] seats: ${config.seats
    .filter((seat) => seat.enabled)
    .map((seat) => `${seat.seatId}(${seat.clientType})`)
    .join(', ')}`);
  console.log(`[ai-room] room dir: ${roomDir}`);
  console.log(`[ai-room] open: ${url}`);
  console.log('[ai-room] press Ctrl+C to stop; native sessions are kept.');

  return {
    engine,
    gameCoordinator,
    tabletopManager,
    server,
    haltGuard,
    budgetGuard,
    get config() {
      return config;
    },
    updateSettings: onUpdateSettings,
    url,
    port: actualPort,
    close,
  };
}

const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const CONNECTION_MESSAGE = /ECONNREFUSED|connection refused|fetch failed|socket hang up|websocket|econnreset/i;

/** 判断启动失败是否属于「客户端实例没起来」，用于追加人工启动提示。 */
export function isConnectionFailure(error) {
  let current = error;
  const seen = new Set();
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (typeof current.code === 'string' && CONNECTION_CODES.has(current.code)) return true;
    if (typeof current.message === 'string' && CONNECTION_MESSAGE.test(current.message)) return true;
    current = current.cause ?? current.details?.cause ?? null;
  }
  return false;
}

/** 连接失败时的操作提示；非连接错误返回 null。 */
export function startupHint(error) {
  if (!isConnectionFailure(error)) return null;
  return [
    '连接客户端失败：请先在独立终端启动对应客户端（kimi-code 席位需要 `kimi web`），',
    '并确认配置里的 nativeSessionRef 指向已经存在的原生会话。',
    '本程序不会自动启动、重启或结束任何客户端进程。',
  ].join('');
}

const USAGE = '用法：node server/live.mjs --config <path> [--port N]';

/**
 * 只解析 CLI 参数，不启动房间，便于离线测试。
 * 支持 --config path / --config=path 两种写法，--port 同理。
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const result = { configPath: undefined, port: undefined, help: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      index += 1;
      continue;
    }
    const match = /^(--config|--port)(?:=(.*))?$/.exec(arg);
    if (!match) {
      throw new LiveCliError(
        'CLI_UNKNOWN_ARGUMENT',
        `未知参数：${arg}。${USAGE}`,
      );
    }
    const [, name, inline] = match;
    let value = inline;
    if (value === undefined) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new LiveCliError('CLI_VALUE_REQUIRED', `${name} 需要一个值。${USAGE}`);
      }
      value = next;
      index += 1;
    }
    if (value.length === 0) {
      throw new LiveCliError('CLI_VALUE_REQUIRED', `${name} 不能为空。${USAGE}`);
    }
    if (name === '--config') {
      result.configPath = value;
    } else {
      const port = Number(value);
      if (!Number.isSafeInteger(port) || port < 0 || port > MAX_PORT) {
        throw new LiveCliError(
          'CLI_PORT_INVALID',
          `--port 必须是 0..${MAX_PORT} 的整数，当前值：${JSON.stringify(value)}。${USAGE}`,
        );
      }
      result.port = port;
    }
    index += 1;
  }

  if (!result.help && result.configPath === undefined) {
    throw new LiveCliError(
      'CLI_CONFIG_REQUIRED',
      `缺少 --config <path>：请复制 config/members.example.json 填写成员会话后重试。${USAGE}`,
    );
  }
  return result;
}

const isMain = typeof process.argv[1] === 'string'
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  let live = null;
  try {
    const args = parseArgs();
    if (args.help) {
      console.log(USAGE);
    } else {
      live = await startLive({ configPath: args.configPath, port: args.port });
    }
  } catch (error) {
    console.error(`[ai-room] live failed to start: ${error?.message ?? error}`);
    const hint = startupHint(error);
    if (hint !== null) console.error(`[ai-room] ${hint}`);
    process.exitCode = 1;
  }

  if (live) {
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[ai-room] ${signal} received, shutting down...`);
      live.close().then(
        () => process.exit(0),
        (error) => {
          console.error(`[ai-room] shutdown failed: ${error?.message ?? error}`);
          process.exit(1);
        },
      );
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}
