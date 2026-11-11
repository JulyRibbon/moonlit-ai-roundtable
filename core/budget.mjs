/**
 * 预派发预算闸门。
 *
 * 重要语义（务必保持与实现一致）：
 * - 本模块只负责“派发前”的估算与预占，以及“终态后”的实际结算。
 * - 它无法阻止已经发出去、正在飞行的请求继续产生费用；真正的超支
 *   只能靠停止后续派发来限制。文档、测试和 UI 都不得声称它能追回在途花费。
 * - 缺价格的座位绝不套用任何内置（例如 DeepSeek）价目；在启用预算上限
 *   且 allowUnknownCost=false 时，未知价格座位会被拒绝派发。
 * - unknown 成本不是 0：settle() 会把 cost 记为 null，并单独计数。
 */

export const BUDGET_SCHEMA_VERSION = 1;

export const COST_QUALITIES = Object.freeze(['exact', 'estimated', 'unknown']);

const COST_QUALITY_SET = new Set(COST_QUALITIES);

const PRICE_FIELDS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output', 'multiplier']);
const REQUIRED_PRICE_FIELDS = Object.freeze(['input', 'cacheRead', 'cacheWrite', 'output']);
const PRICE_COMMENT_PATTERN = /^_/;

const TOKEN_FIELDS = Object.freeze([
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
]);

const TOKEN_ALIASES = Object.freeze({
  inputTokens: Object.freeze([
    'inputTokens',
    'input_tokens',
    'prompt_tokens',
    'promptTokens',
    'uncached_input_tokens',
    'uncachedInputTokens',
  ]),
  cacheReadTokens: Object.freeze([
    'cacheReadTokens',
    'cache_read_tokens',
    'cache_read',
    'cacheRead',
  ]),
  cacheWriteTokens: Object.freeze([
    'cacheWriteTokens',
    'cache_write_tokens',
    'cache_write',
    'cacheWrite',
    'cache_creation_tokens',
    'cacheCreationTokens',
  ]),
  outputTokens: Object.freeze([
    'outputTokens',
    'output_tokens',
    'completion_tokens',
    'completionTokens',
  ]),
});

const MAX_ATTEMPT_ID_LENGTH = 256;
const MAX_SEAT_ID_LENGTH = 256;
const COST_EPSILON = 1e-9;

export class BudgetGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BudgetGuardError';
    this.code = code;
    this.details = details;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, BudgetGuardError);
    }
  }
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function assertAttemptId(value, field = 'attemptId') {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ATTEMPT_ID_LENGTH) {
    throw new BudgetGuardError(
      'BUDGET_ATTEMPT_INVALID',
      `${field} must be a non-empty string of at most ${MAX_ATTEMPT_ID_LENGTH} characters.`,
      { field, value },
    );
  }
  return value;
}

function assertSeatId(value, field = 'seatId') {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SEAT_ID_LENGTH) {
    throw new BudgetGuardError(
      'BUDGET_SEAT_INVALID',
      `${field} must be a non-empty string of at most ${MAX_SEAT_ID_LENGTH} characters.`,
      { field, value },
    );
  }
  return value;
}

function normalizeAmount(value, field, { allowUndefined = false } = {}) {
  if (value === undefined && allowUndefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BudgetGuardError(
      'BUDGET_AMOUNT_INVALID',
      `${field} must be a finite number >= 0.`,
      { field, value, type: typeName(value) },
    );
  }
  return value;
}

function normalizeTokens(value, field, fallback = 0) {
  if (value === undefined) return fallback;
  return normalizeAmount(value, field);
}

function normalizeMaxOutputTokens(value) {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BudgetGuardError(
      'BUDGET_MAX_OUTPUT_TOKENS_INVALID',
      'defaultMaxOutputTokens must be a safe integer >= 0.',
      { defaultMaxOutputTokens: value },
    );
  }
  return value;
}

function roundCost(value) {
  // 保持 1e-12 元精度，既避免浮点噪声，又不会把小额请求抹成 0。
  return Math.round(value * 1e12) / 1e12;
}

function normalizePriceEntry(entry, seatId) {
  if (!isPlainObject(entry)) {
    throw new BudgetGuardError(
      'BUDGET_PRICE_INVALID',
      `priceBook.${seatId} must be an object.`,
      { seatId, type: typeName(entry) },
    );
  }
  for (const key of Object.keys(entry)) {
    if (PRICE_COMMENT_PATTERN.test(key)) continue;
    if (!PRICE_FIELDS.includes(key)) {
      throw new BudgetGuardError(
        'BUDGET_PRICE_INVALID',
        `Unknown price field priceBook.${seatId}.${key}; allowed: ${PRICE_FIELDS.join(', ')}.`,
        { seatId, key, allowed: [...PRICE_FIELDS] },
      );
    }
  }
  const price = {};
  for (const field of REQUIRED_PRICE_FIELDS) {
    if (entry[field] === undefined) {
      throw new BudgetGuardError(
        'BUDGET_PRICE_INVALID',
        `priceBook.${seatId}.${field} is required; a missing price must not fall back to any built-in price.`,
        { seatId, field },
      );
    }
    price[field] = normalizeAmount(entry[field], `priceBook.${seatId}.${field}`);
  }
  price.multiplier = entry.multiplier === undefined
    ? 1
    : normalizeAmount(entry.multiplier, `priceBook.${seatId}.multiplier`);
  return price;
}

function normalizePriceBook(priceBook) {
  if (priceBook === undefined || priceBook === null) return new Map();
  let entries;
  if (priceBook instanceof Map) {
    entries = [...priceBook.entries()];
  } else if (isPlainObject(priceBook)) {
    entries = Object.entries(priceBook);
  } else {
    throw new BudgetGuardError(
      'BUDGET_PRICE_BOOK_INVALID',
      'priceBook must be an object or Map keyed by seatId.',
      { type: typeName(priceBook) },
    );
  }
  const result = new Map();
  for (const [rawSeatId, entry] of entries) {
    if (PRICE_COMMENT_PATTERN.test(rawSeatId)) continue;
    const seatId = assertSeatId(rawSeatId, 'priceBook seatId');
    result.set(seatId, normalizePriceEntry(entry, seatId));
  }
  return result;
}

function readNumber(bag, aliases) {
  for (const key of aliases) {
    const value = bag[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/**
 * 归一化 usage。只认 token 数，不认识就返回 null；不会把缺失 usage 当成 0。
 * 输入 inputTokens 被视作“未命中缓存的输入”，缓存读写分别计价。
 */
export function normalizeUsage(usage) {
  if (!isPlainObject(usage)) return null;
  const tokens = {};
  let recognized = false;
  for (const field of TOKEN_FIELDS) {
    const value = readNumber(usage, TOKEN_ALIASES[field]);
    if (value === undefined) {
      tokens[field] = 0;
    } else {
      tokens[field] = value;
      recognized = true;
    }
  }
  return recognized ? tokens : null;
}

export function tokenCost(price, usage) {
  if (!price || !usage) return null;
  const base = (
    usage.inputTokens * price.input
    + usage.cacheReadTokens * price.cacheRead
    + usage.cacheWriteTokens * price.cacheWrite
    + usage.outputTokens * price.output
  ) / 1_000_000;
  return roundCost(base * price.multiplier);
}

/**
 * 粗略估算一段文本的输入 token，用于派发前预占，不用于最终结算。
 * ASCII 约 4 字符/token，非 ASCII 约 1 字符/token；空文本为 0。
 */
export function estimateInputTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (const char of text) {
    if (char.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.max(0, Math.ceil(ascii / 4) + nonAscii);
}

function qualityFromSettlement(input, usage) {
  if (input.costQuality !== undefined) {
    if (!COST_QUALITY_SET.has(input.costQuality)) {
      throw new BudgetGuardError(
        'BUDGET_COST_QUALITY_INVALID',
        `Unknown cost quality: ${String(input.costQuality)}.`,
        { costQuality: input.costQuality, known: [...COST_QUALITIES] },
      );
    }
    return input.costQuality;
  }
  if (isPlainObject(usage) && usage.estimated === true) return 'estimated';
  if (isPlainObject(usage) && COST_QUALITY_SET.has(usage.quality)) return usage.quality;
  return 'exact';
}

/**
 * createBudgetGuard({maxCostYuan?, priceBook?, defaultMaxOutputTokens?, allowUnknownCost?})
 *
 * priceBook[seatId] = {input, cacheRead, cacheWrite, output, multiplier?}
 * 单位：元/百万 token。multiplier 默认 1。
 *
 * maxCostYuan 未设置时不做上限检查，但仍会记录实际/估算/未知成本。
 * 设置上限且 allowUnknownCost=false（默认）时，未知价格座位拒绝派发。
 * allowUnknownCost=true 是显式降级：仍然无法估算金额，只会在快照里标 unknown。
 */
export function createBudgetGuard(options = {}) {
  if (!isPlainObject(options)) {
    throw new BudgetGuardError(
      'BUDGET_OPTIONS_INVALID',
      'createBudgetGuard() requires an options object.',
      { type: typeName(options) },
    );
  }
  const maxCostYuan = options.maxCostYuan === undefined || options.maxCostYuan === null
    ? null
    : normalizeAmount(options.maxCostYuan, 'maxCostYuan');
  const defaultMaxOutputTokens = normalizeMaxOutputTokens(options.defaultMaxOutputTokens);
  if (options.allowUnknownCost !== undefined && typeof options.allowUnknownCost !== 'boolean') {
    throw new BudgetGuardError(
      'BUDGET_ALLOW_UNKNOWN_INVALID',
      'allowUnknownCost must be a boolean.',
      { allowUnknownCost: options.allowUnknownCost },
    );
  }
  const allowUnknownCost = options.allowUnknownCost === true;
  const priceBook = normalizePriceBook(options.priceBook);

  const reservations = new Map();
  const settlements = new Map();
  const decisions = new Map();
  const rejections = [];
  let seq = 0;

  function totals() {
    let reserved = 0;
    let reservedUnknown = 0;
    for (const reservation of reservations.values()) {
      if (reservation.cost === null) reservedUnknown += 1;
      else reserved += reservation.cost;
    }
    let actual = 0;
    let estimated = 0;
    let unknown = 0;
    for (const settlement of settlements.values()) {
      if (settlement.quality === 'unknown') {
        unknown += 1;
        continue;
      }
      actual += settlement.cost;
      if (settlement.quality === 'estimated') estimated += settlement.cost;
    }
    const remaining = maxCostYuan === null
      ? null
      : Math.max(0, maxCostYuan - actual - reserved);
    return {
      reserved: roundCost(reserved),
      actual: roundCost(actual),
      estimated: roundCost(estimated),
      unknown,
      reservedUnknown,
      remaining: remaining === null ? null : roundCost(remaining),
    };
  }

  function priceFor(seatId) {
    assertSeatId(seatId);
    return priceBook.get(seatId) ?? null;
  }

  function makeRejection(input, code, message, extra = {}) {
    seq += 1;
    const rejection = {
      seq,
      attemptId: input.attemptId,
      seatId: input.seatId,
      code,
      message,
      at: new Date().toISOString(),
      ...extra,
    };
    rejections.push(rejection);
    const result = {
      allowed: false,
      duplicate: false,
      code,
      message,
      rejection: clone(rejection),
      snapshot: snapshot(),
    };
    decisions.set(input.attemptId, { kind: 'rejected', result: clone(result) });
    return result;
  }

  /**
   * 预占估算费用。同一 attemptId 重复调用幂等；被拒绝的 attempt 也保持
   * 同一个拒绝结果，不会重复累计拒绝记录。
   */
  function beforeAttempt(input = {}) {
    if (!isPlainObject(input)) {
      throw new BudgetGuardError('BUDGET_ATTEMPT_INVALID', 'beforeAttempt() requires an object.');
    }
    const attemptId = assertAttemptId(input.attemptId);
    const seatId = assertSeatId(input.seatId);

    const settled = settlements.get(attemptId);
    if (settled) {
      if (settled.seatId !== seatId) {
        throw new BudgetGuardError(
          'BUDGET_ATTEMPT_CONFLICT',
          `Attempt ${attemptId} was settled for seat ${settled.seatId}, not ${seatId}.`,
          { attemptId, seatId, settledSeatId: settled.seatId },
        );
      }
      return {
        allowed: false,
        duplicate: true,
        code: 'BUDGET_ATTEMPT_SETTLED',
        message: `Attempt ${attemptId} is already settled.`,
        settlement: clone(settled),
        snapshot: snapshot(),
      };
    }

    const existingReservation = reservations.get(attemptId);
    if (existingReservation) {
      if (existingReservation.seatId !== seatId) {
        throw new BudgetGuardError(
          'BUDGET_ATTEMPT_CONFLICT',
          `Attempt ${attemptId} was reserved for seat ${existingReservation.seatId}, not ${seatId}.`,
          { attemptId, seatId, reservedSeatId: existingReservation.seatId },
        );
      }
      return {
        allowed: true,
        duplicate: true,
        reservation: clone(existingReservation),
        snapshot: snapshot(),
      };
    }

    const existingDecision = decisions.get(attemptId);
    if (existingDecision?.kind === 'rejected') {
      return { ...clone(existingDecision.result), duplicate: true, snapshot: snapshot() };
    }

    const estimatedInputTokens = normalizeTokens(
      input.estimatedInputTokens,
      'estimatedInputTokens',
      0,
    );
    const maxOutputTokens = input.maxOutputTokens === undefined
      ? defaultMaxOutputTokens
      : normalizeTokens(input.maxOutputTokens, 'maxOutputTokens');

    const price = priceFor(seatId);
    const estimateUsage = {
      inputTokens: estimatedInputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: maxOutputTokens,
    };
    const estimatedCost = price ? tokenCost(price, estimateUsage) : null;

    if (price === null && maxCostYuan !== null && !allowUnknownCost) {
      return makeRejection(
        { attemptId, seatId },
        'BUDGET_UNKNOWN_PRICE',
        `Seat ${seatId} has no price configured; paid dispatch is refused while a budget cap is active.`,
        { budgetActive: true, allowUnknownCost },
      );
    }

    if (estimatedCost !== null && maxCostYuan !== null) {
      const current = totals();
      const projected = current.actual + current.reserved + estimatedCost;
      if (projected > maxCostYuan + COST_EPSILON) {
        return makeRejection(
          { attemptId, seatId },
          'BUDGET_EXCEEDED',
          `Estimated cost ${estimatedCost} CNY would exceed maxCostYuan ${maxCostYuan} CNY.`,
          {
            maxCostYuan,
            estimatedCost,
            actual: current.actual,
            reserved: current.reserved,
            projected: roundCost(projected),
          },
        );
      }
    }

    seq += 1;
    const reservation = {
      seq,
      attemptId,
      seatId,
      cost: estimatedCost,
      quality: estimatedCost === null ? 'unknown' : 'estimated',
      estimatedInputTokens,
      maxOutputTokens,
      priceKnown: price !== null,
      createdAt: new Date().toISOString(),
    };
    reservations.set(attemptId, reservation);
    decisions.set(attemptId, { kind: 'reserved' });
    return {
      allowed: true,
      duplicate: false,
      reservation: clone(reservation),
      snapshot: snapshot(),
    };
  }

  /**
   * 结算并释放预占。重复 settle 返回第一次的结果（duplicate:true），不重复计入。
   *
   * - cost 显式提供：按 costQuality（默认 exact）记账。
   * - 只提供 usage：有价格才计算；没有 usage 或没有价格 => unknown，cost=null。
   * - 显式 costQuality='unknown' 时即使 cost=0 也记为 null。
   */
  function settle(input = {}) {
    if (!isPlainObject(input)) {
      throw new BudgetGuardError('BUDGET_SETTLE_INVALID', 'settle() requires an object.');
    }
    const attemptId = assertAttemptId(input.attemptId);
    const duplicate = settlements.get(attemptId);
    if (duplicate) {
      const result = { ...clone(duplicate), duplicate: true, snapshot: snapshot() };
      if (input.seatId !== undefined && input.seatId !== duplicate.seatId) {
        throw new BudgetGuardError(
          'BUDGET_ATTEMPT_CONFLICT',
          `Attempt ${attemptId} was settled for seat ${duplicate.seatId}, not ${input.seatId}.`,
          { attemptId, seatId: input.seatId, settledSeatId: duplicate.seatId },
        );
      }
      return result;
    }

    const reservation = reservations.get(attemptId);
    if (!reservation) {
      throw new BudgetGuardError(
        'BUDGET_RESERVATION_MISSING',
        `Cannot settle attempt ${attemptId}: no reservation exists.`,
        { attemptId },
      );
    }
    const seatId = input.seatId === undefined ? reservation.seatId : assertSeatId(input.seatId);
    if (seatId !== reservation.seatId) {
      throw new BudgetGuardError(
        'BUDGET_ATTEMPT_CONFLICT',
        `Attempt ${attemptId} was reserved for seat ${reservation.seatId}, not ${seatId}.`,
        { attemptId, seatId, reservedSeatId: reservation.seatId },
      );
    }

    const usage = input.usage ?? null;
    let cost = null;
    let quality = 'unknown';
    if (input.cost !== undefined && input.cost !== null) {
      const explicitCost = normalizeAmount(input.cost, 'cost');
      quality = qualityFromSettlement(input, usage);
      cost = quality === 'unknown' ? null : explicitCost;
    } else if (isPlainObject(usage)) {
      quality = qualityFromSettlement(input, usage);
      if (quality !== 'unknown') {
        const price = priceFor(seatId);
        const tokens = normalizeUsage(usage);
        if (price !== null && tokens !== null) {
          cost = tokenCost(price, tokens);
        } else {
          // 没有价格或没有可识别的 token 数：这是 unknown，不是 0。
          cost = null;
          quality = 'unknown';
        }
      }
    }

    seq += 1;
    const settlement = {
      seq,
      attemptId,
      seatId,
      outcome: typeof input.outcome === 'string' ? input.outcome : null,
      cost,
      quality,
      usage: clone(usage),
      reservedCost: reservation.cost,
      reservedQuality: reservation.quality,
      settledAt: new Date().toISOString(),
      duplicate: false,
    };
    settlements.set(attemptId, settlement);
    reservations.delete(attemptId);
    decisions.delete(attemptId);

    const result = { ...clone(settlement), snapshot: snapshot() };
    decisions.set(attemptId, { kind: 'settled' });
    return result;
  }

  /**
   * 快照口径：
   * - reserved：当前仍在预占中的已知金额（未知金额预占只计入 reservedUnknown）。
   * - actual：已结算的已知金额，包含 estimated 部分。
   * - estimated：已结算金额中口径为 estimated 的金额。
   * - unknown：已结算但成本未知的 attempt 数量；未知成本不会按 0 计入 actual。
   * - remaining：maxCostYuan - actual - reserved，未设上限时为 null。
   */
  function snapshot() {
    const totalsNow = totals();
    return {
      schemaVersion: BUDGET_SCHEMA_VERSION,
      currency: 'CNY',
      maxCostYuan,
      allowUnknownCost,
      defaultMaxOutputTokens,
      unlimited: maxCostYuan === null,
      ...totalsNow,
      reservations: [...reservations.values()].map(clone),
      settlements: [...settlements.values()].map(clone),
      rejected: rejections.map(clone),
    };
  }

  function getPrice(seatId) {
    const price = priceFor(seatId);
    return price === null ? null : clone(price);
  }

  return {
    beforeAttempt,
    settle,
    snapshot,
    getPrice,
  };
}
