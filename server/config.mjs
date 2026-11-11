import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { VOICE_MODES } from '../adapters/contract.mjs';

/**
 * 生产配置只描述「哪个原生会话坐哪一席」，不携带人格、提示词或规则正文。
 * 房间负责传话与排程，成员人格始终留在各自客户端里。
 */

export const CLIENT_TYPES = Object.freeze(['dsh', 'kimi-code', 'zcode', 'qwen-code', 'fake']);
export const PRODUCTION_CLIENT_TYPES = Object.freeze(['dsh', 'kimi-code', 'zcode', 'qwen-code']);

export const MIN_MAX_ATTEMPTS = 1;
export const MAX_MAX_ATTEMPTS = 12;
export const DEFAULT_MAX_ATTEMPTS = 3;

export const DEFAULT_VOICE_MODE = VOICE_MODES.NONE;
export const VOICE_MODE_VALUES = Object.freeze(Object.values(VOICE_MODES));

const COMMENT_KEY_PATTERN = /^_/;

// 与 core/halt.mjs 的 assertRoomId 保持一致：roomId 会进入哨兵文件名与 rooms/ 目录名。
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_NATIVE_SESSION_REF_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const CLIENT_TYPE_SET = new Set(CLIENT_TYPES);
const PRODUCTION_CLIENT_TYPE_SET = new Set(PRODUCTION_CLIENT_TYPES);
const VOICE_MODE_SET = new Set(VOICE_MODE_VALUES);

const TOP_LEVEL_KEYS = Object.freeze([
  'roomId',
  'ownerName',
  'maxAttempts',
  'contextMessages',
  'budget',
  'seats',
]);
const BUDGET_KEYS = Object.freeze([
  'maxCostYuan',
  'allowUnknownCost',
  'priceBook',
  'defaultMaxOutputTokens',
]);
const BUDGET_PRICE_KEYS = Object.freeze([
  'input',
  'cacheRead',
  'cacheWrite',
  'output',
  'multiplier',
]);
const BUDGET_REQUIRED_PRICE_KEYS = Object.freeze([
  'input',
  'cacheRead',
  'cacheWrite',
  'output',
]);
const SEAT_KEYS = Object.freeze([
  'seatId',
  'displayName',
  'color',
  'clientType',
  'nativeSessionRef',
  'enabled',
  'voiceMode',
  'client',
]);
const DEFAULT_SEAT_COLORS = Object.freeze([
  '#6ea8ff',
  '#c79bff',
  '#63d2a4',
  '#e9b45f',
  '#f2777a',
  '#79b8ff',
]);

// 这些键一旦出现在配置里就说明在尝试复制人格；统一按规范名匹配，覆盖大小写与分隔符变体。
const FORBIDDEN_KEYS = new Map([
  ['persona', 'persona'],
  ['prompt', 'prompt'],
  ['systemprompt', 'systemPrompt'],
  ['agentsmd', 'agentsMd'],
]);

export class ConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ConfigError);
    }
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function normalizeKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** 递归检查键名，防止人格 / 提示词 / AGENTS.md 正文经由任意层级混入。 */
function scanForbiddenKeys(value, at, seen = new Set(), depth = 0) {
  if (depth > 32 || value === null || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenKeys(entry, `${at}[${index}]`, seen, depth + 1));
    return;
  }
  for (const key of Object.keys(value)) {
    const forbidden = FORBIDDEN_KEYS.get(normalizeKey(key));
    if (forbidden !== undefined) {
      throw new ConfigError(
        'CONFIG_PERSONA_FORBIDDEN',
        `配置不得包含 ${forbidden} 正文（位置：${at}.${key}）；人格与提示词只保留在各客户端原生会话里。`,
        { path: `${at}.${key}`, key: forbidden },
      );
    }
    scanForbiddenKeys(value[key], `${at}.${key}`, seen, depth + 1);
  }
}

function assertKnownKeys(value, allowed, at) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    if (COMMENT_KEY_PATTERN.test(key)) continue;
    throw new ConfigError(
      'CONFIG_UNKNOWN_FIELD',
      `未知配置字段 ${at}.${key}；允许的字段：${allowed.join(', ')}（_ 开头的字段视为注释）。`,
      { path: `${at}.${key}`, allowed: [...allowed] },
    );
  }
}

function assertIdentifier(value, field, at) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ConfigError(
      `${field === 'roomId' ? 'ROOM_ID_INVALID' : 'SEAT_ID_INVALID'}`,
      `${field} 必须是安全的裸标识符（字母或数字开头，仅含字母、数字、_、-，最长 64 字符），当前值：${JSON.stringify(value)}（位置：${at}）。`,
      { field, value, pattern: IDENTIFIER_PATTERN.source },
    );
  }
  return value;
}

function normalizeMaxAttempts(value) {
  if (value === undefined) return DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(value) || value < MIN_MAX_ATTEMPTS || value > MAX_MAX_ATTEMPTS) {
    throw new ConfigError(
      'MAX_ATTEMPTS_INVALID',
      `maxAttempts 必须是 ${MIN_MAX_ATTEMPTS}..${MAX_MAX_ATTEMPTS} 的整数，当前值：${JSON.stringify(value)}。`,
      { maxAttempts: value, min: MIN_MAX_ATTEMPTS, max: MAX_MAX_ATTEMPTS },
    );
  }
  return value;
}

function normalizeDisplayName(value, fallback, at) {
  const name = value === undefined ? fallback : value;
  if (typeof name !== 'string') {
    throw new ConfigError('DISPLAY_NAME_INVALID', `${at} 必须是字符串。`, { path: at });
  }
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 32 || CONTROL_CHARACTERS.test(trimmed)) {
    throw new ConfigError(
      'DISPLAY_NAME_INVALID',
      `${at} 必须是 1..32 个可见字符，且不得包含控制字符。`,
      { path: at },
    );
  }
  return trimmed;
}

function normalizeColor(value, fallback, at) {
  const color = value === undefined ? fallback : value;
  if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
    throw new ConfigError('SEAT_COLOR_INVALID', `${at} 必须是 #RRGGBB 颜色。`, { path: at });
  }
  return color.toLowerCase();
}

function normalizeContextMessages(value) {
  if (value === undefined) return 8;
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) {
    throw new ConfigError(
      'CONTEXT_MESSAGES_INVALID',
      `contextMessages 必须是 1..20 的整数，当前值：${JSON.stringify(value)}。`,
      { contextMessages: value },
    );
  }
  return value;
}

function normalizeClientType(value, at) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError(
      'CLIENT_TYPE_REQUIRED',
      `seat.clientType 必填，可选值：${CLIENT_TYPES.join(', ')}（位置：${at}）。`,
      { path: at, known: [...CLIENT_TYPES] },
    );
  }
  if (!CLIENT_TYPE_SET.has(value)) {
    throw new ConfigError(
      'CLIENT_TYPE_UNKNOWN',
      `未知 clientType：${JSON.stringify(value)}；可选值：${CLIENT_TYPES.join(', ')}（位置：${at}）。`,
      { path: at, clientType: value, known: [...CLIENT_TYPES] },
    );
  }
  return value;
}

function normalizeNativeSessionRef(value, clientType, at) {
  if (value === undefined || value === null || value === '') {
    if (PRODUCTION_CLIENT_TYPE_SET.has(clientType)) {
      throw new ConfigError(
        'SESSION_REF_REQUIRED',
        `clientType ${clientType} 必须提供 nativeSessionRef（位置：${at}）；房间不会自动创建会话。`,
        { path: at, clientType },
      );
    }
    return null;
  }
  if (typeof value !== 'string') {
    throw new ConfigError(
      'SESSION_REF_INVALID',
      `nativeSessionRef 必须是字符串（位置：${at}）。`,
      { path: at, type: typeName(value) },
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_NATIVE_SESSION_REF_LENGTH) {
    throw new ConfigError(
      'SESSION_REF_INVALID',
      `nativeSessionRef 必须是非空字符串且不超过 ${MAX_NATIVE_SESSION_REF_LENGTH} 字符（位置：${at}）。`,
      { path: at },
    );
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new ConfigError(
      'SESSION_REF_INVALID',
      `nativeSessionRef 不得包含控制字符（位置：${at}）。`,
      { path: at },
    );
  }
  return trimmed;
}

function normalizeEnabled(value, at) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new ConfigError(
      'SEAT_ENABLED_INVALID',
      `enabled 必须是布尔值（位置：${at}）。`,
      { path: at, type: typeName(value) },
    );
  }
  return value;
}

function normalizeVoiceMode(value, at) {
  if (value === undefined) return DEFAULT_VOICE_MODE;
  if (typeof value !== 'string' || !VOICE_MODE_SET.has(value)) {
    throw new ConfigError(
      'VOICE_MODE_INVALID',
      `voiceMode 必须是 ${VOICE_MODE_VALUES.join(', ')} 之一（位置：${at}）。`,
      { path: at, voiceMode: value, known: [...VOICE_MODE_VALUES] },
    );
  }
  return value;
}

function normalizeClientConfig(value, at) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new ConfigError(
      'CLIENT_CONFIG_INVALID',
      `client 必须是对象，用于保留客户端专用配置（位置：${at}）。`,
      { path: at, type: typeName(value) },
    );
  }
  return structuredClone(value);
}

function normalizeBudgetAmount(value, field, at) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ConfigError(
      'BUDGET_AMOUNT_INVALID',
      `${field} 必须是大于等于 0 的有限数字（位置：${at}）。`,
      { path: at, field, value },
    );
  }
  return value;
}

function normalizeBudgetPrice(raw, seatId, at) {
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      'BUDGET_PRICE_INVALID',
      `${at} 必须是对象，包含 input / cacheRead / cacheWrite / output（元/百万 token）与可选 multiplier。`,
      { path: at, type: typeName(raw) },
    );
  }
  assertKnownKeys(raw, BUDGET_PRICE_KEYS, at);
  const price = {};
  for (const field of BUDGET_REQUIRED_PRICE_KEYS) {
    if (raw[field] === undefined) {
      throw new ConfigError(
        'BUDGET_PRICE_INVALID',
        `${at}.${field} 必填；缺价格不会被替换成任何内置价格。`,
        { path: `${at}.${field}`, seatId, field },
      );
    }
    price[field] = normalizeBudgetAmount(raw[field], `${at}.${field}`, `${at}.${field}`);
  }
  price.multiplier = raw.multiplier === undefined
    ? 1
    : normalizeBudgetAmount(raw.multiplier, `${at}.multiplier`, `${at}.multiplier`);
  return price;
}

function normalizeBudgetPriceBook(raw, at, seatIds) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      'BUDGET_PRICE_BOOK_INVALID',
      `budget.priceBook 必须是按 seatId 索引的对象（位置：${at}）。`,
      { path: at, type: typeName(raw) },
    );
  }
  const priceBook = {};
  for (const [seatId, price] of Object.entries(raw)) {
    if (COMMENT_KEY_PATTERN.test(seatId)) continue;
    if (!seatIds.has(seatId)) {
      throw new ConfigError(
        'BUDGET_SEAT_UNKNOWN',
        `budget.priceBook 引用了不存在的 seatId：${seatId}（位置：${at}）。`,
        { path: `${at}.${seatId}`, seatId, known: [...seatIds] },
      );
    }
    priceBook[seatId] = normalizeBudgetPrice(price, seatId, `${at}.${seatId}`);
  }
  return priceBook;
}

function normalizeBudget(raw, at, seatIds) {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      'BUDGET_INVALID',
      `budget 必须是对象（位置：${at}），当前类型：${typeName(raw)}。`,
      { path: at, type: typeName(raw) },
    );
  }
  assertKnownKeys(raw, BUDGET_KEYS, at);

  const maxCostYuan = normalizeBudgetAmount(
    raw.maxCostYuan,
    'budget.maxCostYuan',
    `${at}.maxCostYuan`,
  );
  if (raw.allowUnknownCost !== undefined && typeof raw.allowUnknownCost !== 'boolean') {
    throw new ConfigError(
      'BUDGET_ALLOW_UNKNOWN_INVALID',
      `budget.allowUnknownCost 必须是布尔值（位置：${at}.allowUnknownCost）。`,
      { path: `${at}.allowUnknownCost`, value: raw.allowUnknownCost },
    );
  }
  let defaultMaxOutputTokens;
  if (raw.defaultMaxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(raw.defaultMaxOutputTokens) || raw.defaultMaxOutputTokens < 0) {
      throw new ConfigError(
        'BUDGET_DEFAULT_MAX_OUTPUT_TOKENS_INVALID',
        `budget.defaultMaxOutputTokens 必须是大于等于 0 的安全整数（位置：${at}.defaultMaxOutputTokens）。`,
        { path: `${at}.defaultMaxOutputTokens`, value: raw.defaultMaxOutputTokens },
      );
    }
    defaultMaxOutputTokens = raw.defaultMaxOutputTokens;
  }

  const priceBook = normalizeBudgetPriceBook(raw.priceBook, `${at}.priceBook`, seatIds);

  return {
    ...(maxCostYuan === undefined ? {} : { maxCostYuan }),
    allowUnknownCost: raw.allowUnknownCost ?? false,
    ...(priceBook === undefined ? {} : { priceBook }),
    ...(defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens }),
  };
}

function normalizeSeat(raw, index, seenSeatIds) {
  const at = `seats[${index}]`;
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      'SEAT_INVALID',
      `${at} 必须是对象。`,
      { path: at, type: typeName(raw) },
    );
  }
  assertKnownKeys(raw, SEAT_KEYS, at);

  const seatId = assertIdentifier(raw.seatId, 'seatId', `${at}.seatId`);
  if (seenSeatIds.has(seatId)) {
    throw new ConfigError(
      'SEAT_ID_DUPLICATE',
      `seatId 重复：${seatId}；每席必须唯一。`,
      { path: `${at}.seatId`, seatId },
    );
  }
  seenSeatIds.add(seatId);

  const clientType = normalizeClientType(raw.clientType, `${at}.clientType`);
  const nativeSessionRef = normalizeNativeSessionRef(
    raw.nativeSessionRef,
    clientType,
    `${at}.nativeSessionRef`,
  );

  return {
    seatId,
    displayName: normalizeDisplayName(raw.displayName, seatId, `${at}.displayName`),
    color: normalizeColor(raw.color, DEFAULT_SEAT_COLORS[index % DEFAULT_SEAT_COLORS.length], `${at}.color`),
    clientType,
    nativeSessionRef,
    enabled: normalizeEnabled(raw.enabled, `${at}.enabled`),
    voiceMode: normalizeVoiceMode(raw.voiceMode, `${at}.voiceMode`),
    client: normalizeClientConfig(raw.client, `${at}.client`),
  };
}

/**
 * 校验并规范化原始配置。返回值只包含座位编排所需字段：
 * {roomId, maxAttempts, seats:[{seatId, clientType, nativeSessionRef, enabled, voiceMode, client}]}
 */
export function validateConfig(raw) {
  if (!isPlainObject(raw)) {
    throw new ConfigError(
      'CONFIG_INVALID',
      `配置顶层必须是 JSON 对象，当前类型：${typeName(raw)}。`,
      { type: typeName(raw) },
    );
  }
  scanForbiddenKeys(raw, '$');
  assertKnownKeys(raw, TOP_LEVEL_KEYS, '$');

  const roomId = assertIdentifier(raw.roomId, 'roomId', '$.roomId');
  const maxAttempts = normalizeMaxAttempts(raw.maxAttempts);

  if (!Array.isArray(raw.seats)) {
    throw new ConfigError(
      'SEATS_INVALID',
      `seats 必须是数组，当前类型：${typeName(raw.seats)}。`,
      { type: typeName(raw.seats) },
    );
  }
  if (raw.seats.length === 0) {
    throw new ConfigError('SEATS_EMPTY', 'seats 不能为空，至少需要一个成员席位。');
  }

  const seenSeatIds = new Set();
  const seats = raw.seats.map((seat, index) => normalizeSeat(seat, index, seenSeatIds));
  const seenMentionNames = new Set();
  for (const seat of seats) {
    const aliases = new Set([seat.seatId.toLowerCase(), seat.displayName.toLowerCase()]);
    for (const key of aliases) {
      if (seenMentionNames.has(key)) {
        throw new ConfigError(
          'DISPLAY_NAME_DUPLICATE',
          `席位 ID 与昵称必须互不重复（忽略大小写）：${key}。`,
          { seatId: seat.seatId, displayName: seat.displayName },
        );
      }
      seenMentionNames.add(key);
    }
  }

  const budget = normalizeBudget(raw.budget, '$.budget', seenSeatIds);

  if (!seats.some((seat) => seat.enabled)) {
    throw new ConfigError(
      'NO_ENABLED_SEATS',
      '至少需要一个 enabled:true 的席位，否则房间无法运行。',
      { seats: seats.map((seat) => seat.seatId) },
    );
  }

  return {
    roomId,
    ownerName: normalizeDisplayName(raw.ownerName, '机主', '$.ownerName'),
    maxAttempts,
    contextMessages: normalizeContextMessages(raw.contextMessages),
    ...(budget === undefined ? {} : { budget }),
    seats,
  };
}

/**
 * 读取并校验配置文件。文件缺失、JSON 损坏与字段非法分别给出可区分的错误码。
 */
export async function loadConfig(configPath) {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    throw new ConfigError(
      'CONFIG_PATH_REQUIRED',
      'loadConfig() 需要非空的配置文件路径。',
      { configPath },
    );
  }
  const resolved = path.resolve(configPath);
  let text;
  try {
    text = await readFile(resolved, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new ConfigError(
        'CONFIG_NOT_FOUND',
        `找不到配置文件：${resolved}。可先复制 config/members.example.json 再填写。`,
        { configPath: resolved },
      );
    }
    throw new ConfigError(
      'CONFIG_READ_FAILED',
      `无法读取配置文件 ${resolved}：${error?.message ?? error}`,
      { configPath: resolved, cause: String(error?.code ?? error) },
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new ConfigError(
      'CONFIG_INVALID_JSON',
      `配置文件不是合法 JSON：${resolved}（${error?.message ?? error}）。`,
      { configPath: resolved },
    );
  }

  return validateConfig(parsed);
}

const CONFIG_QUEUES = new Map();

/** 串行修改并原子写回原始 JSON，保留 `_comment` 等说明字段；返回值仍为规范化配置。 */
export async function updateConfig(configPath, mutator) {
  if (typeof configPath !== 'string' || configPath.trim().length === 0) {
    throw new ConfigError('CONFIG_PATH_REQUIRED', 'updateConfig() 需要非空的配置文件路径。');
  }
  if (typeof mutator !== 'function') {
    throw new ConfigError('CONFIG_MUTATOR_INVALID', 'updateConfig() 需要 mutator 函数。');
  }
  const resolved = path.resolve(configPath);
  const previous = CONFIG_QUEUES.get(resolved) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    let raw;
    try {
      const text = await readFile(resolved, 'utf8');
      raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch (error) {
      throw new ConfigError('CONFIG_READ_FAILED', `无法读取配置文件 ${resolved}：${error?.message ?? error}`);
    }
    const next = await mutator(structuredClone(raw));
    const normalized = validateConfig(next);
    const directory = path.dirname(resolved);
    await mkdir(directory, { recursive: true });
    const tempPath = path.join(directory, `.members.${process.pid}.${randomUUID()}.tmp`);
    let handle = null;
    try {
      handle = await open(tempPath, 'w');
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, resolved);
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw new ConfigError('CONFIG_WRITE_FAILED', `无法写回配置文件 ${resolved}：${error?.message ?? error}`);
    }
    return normalized;
  });
  CONFIG_QUEUES.set(resolved, current);
  current.finally(() => {
    if (CONFIG_QUEUES.get(resolved) === current) CONFIG_QUEUES.delete(resolved);
  }).catch(() => {});
  return current;
}
