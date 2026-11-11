import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BudgetGuardError,
  createBudgetGuard,
  estimateInputTokens,
  normalizeUsage,
} from '../../core/budget.mjs';
import { createRoomEngine } from '../../core/engine.mjs';
import { FakeBridge } from '../../adapters/fake/bridge.mjs';
import {
  ConfigError,
  loadConfig,
  validateConfig,
} from '../../server/config.mjs';
import { startLive } from '../../server/live.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../..');

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`,
  );
}

function price(overrides = {}) {
  return {
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 2,
    output: 4,
    ...overrides,
  };
}

function memoryStore(seed = {}) {
  const state = {
    room: seed.room ? structuredClone(seed.room) : null,
    schedule: seed.schedule ? structuredClone(seed.schedule) : null,
    events: [],
    messages: [],
    attempts: [],
    checkpoints: [],
  };
  return {
    state,
    async load() {
      if (!state.room) return null;
      return {
        room: structuredClone(state.room),
        schedule: state.schedule ? structuredClone(state.schedule) : null,
        transcript: state.messages.map((message) => structuredClone(message)),
        attempts: state.attempts.map((attempt) => structuredClone(attempt)),
      };
    },
    async appendEvent(event) {
      state.events.push(structuredClone(event));
    },
    async appendMessage(message) {
      state.messages.push(structuredClone(message));
    },
    async appendAttempt(attempt) {
      state.attempts.push(structuredClone(attempt));
    },
    async saveCheckpoint(checkpoint) {
      state.checkpoints.push(structuredClone(checkpoint));
      state.room = structuredClone(checkpoint.room);
      state.schedule = checkpoint.schedule === null ? null : structuredClone(checkpoint.schedule);
    },
    async exportMarkdown() {
      return '# room\n';
    },
  };
}

function makeBridges(seats) {
  return new Map(seats.map((seatId) => [seatId, new FakeBridge({
    seatId,
    nativeSessionRef: `native_${seatId}`,
  })]));
}

function driveTurns(engine, steps) {
  const pending = [];
  const off = engine.on('TurnRequested', (event) => {
    const step = steps.shift();
    pending.push(new Promise((resolve) => {
      setImmediate(async () => {
        try {
          await step(event);
        } finally {
          resolve();
        }
      });
    }));
  });
  return {
    async done() {
      off();
      await Promise.all(pending);
    },
  };
}

async function waitFor(predicate, label, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function assertBudgetError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof BudgetGuardError, `expected BudgetGuardError, got ${error?.name}`);
    assert.equal(error.code, code, `unexpected code: ${error.code} (${error.message})`);
    return true;
  });
}

function assertConfigError(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
    assert.equal(error.code, code, `unexpected code: ${error.code} (${error.message})`);
    return true;
  });
}

function baseConfig(overrides = {}) {
  return {
    roomId: 'budget-room',
    maxAttempts: 1,
    seats: [
      { seatId: 'paid', clientType: 'fake', nativeSessionRef: 'fake_paid' },
      { seatId: 'free', clientType: 'fake', nativeSessionRef: 'fake_free' },
    ],
    ...overrides,
  };
}

// ── 纯预算层 ──────────────────────────────────────────────────────────────────

test('validates options, price entries and missing prices strictly', () => {
  assertBudgetError(() => createBudgetGuard({ maxCostYuan: -1 }), 'BUDGET_AMOUNT_INVALID');
  assertBudgetError(() => createBudgetGuard({ defaultMaxOutputTokens: 1.5 }), 'BUDGET_MAX_OUTPUT_TOKENS_INVALID');
  assertBudgetError(() => createBudgetGuard({ allowUnknownCost: 'yes' }), 'BUDGET_ALLOW_UNKNOWN_INVALID');
  assertBudgetError(() => createBudgetGuard({ priceBook: [] }), 'BUDGET_PRICE_BOOK_INVALID');
  assertBudgetError(
    () => createBudgetGuard({ priceBook: { paid: { input: 1, output: 1 } } }),
    'BUDGET_PRICE_INVALID',
  );
  assertBudgetError(
    () => createBudgetGuard({ priceBook: { paid: price({ cacheRead: -0.1 }) } }),
    'BUDGET_AMOUNT_INVALID',
  );
  assertBudgetError(
    () => createBudgetGuard({ priceBook: { paid: { ...price(), unknown: 1 } } }),
    'BUDGET_PRICE_INVALID',
  );

  const guard = createBudgetGuard({ priceBook: { paid: price() } });
  assert.deepEqual(guard.getPrice('paid'), price({ multiplier: 1 }));
  assert.equal(guard.getPrice('missing'), null, 'missing price must never fall back');
});

test('prices input, cache read, cache write and output separately with a multiplier', () => {
  const guard = createBudgetGuard({
    maxCostYuan: 10,
    priceBook: {
      paid: price({ input: 1, cacheRead: 0.1, cacheWrite: 2, output: 4, multiplier: 2 }),
    },
  });

  const reservation = guard.beforeAttempt({
    attemptId: 'a_estimate',
    seatId: 'paid',
    estimatedInputTokens: 1_000_000,
    maxOutputTokens: 500_000,
  });
  assert.equal(reservation.allowed, true);
  // (1M * 1 + 0.5M * 4) / 1M * 2 = 6
  closeTo(reservation.snapshot.reserved, 6);

  const settlement = guard.settle({
    attemptId: 'a_estimate',
    usage: {
      inputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 500_000,
      outputTokens: 500_000,
    },
  });
  // (1*1 + 2*0.1 + 0.5*2 + 0.5*4) * 2 = 8.4
  assert.equal(settlement.quality, 'exact');
  closeTo(settlement.cost, 8.4);

  const snapshot = guard.snapshot();
  assert.equal(snapshot.reserved, 0);
  closeTo(snapshot.actual, 8.4);
  assert.equal(snapshot.estimated, 0);
  assert.equal(snapshot.unknown, 0);
  closeTo(snapshot.remaining, 1.6);
  assert.equal(snapshot.reservations.length, 0);
  assert.equal(snapshot.settlements.length, 1);
});

test('usage aliases and estimated usage quality are normalized without inventing tokens', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 3, output_tokens: 4 }), {
    inputTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 4,
  });
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);

  const guard = createBudgetGuard({
    priceBook: { paid: price({ input: 0, cacheRead: 0, cacheWrite: 0, output: 100 }) },
  });
  const before = guard.beforeAttempt({ attemptId: 'a_alias', seatId: 'paid', maxOutputTokens: 0 });
  assert.equal(before.allowed, true);
  const settlement = guard.settle({
    attemptId: 'a_alias',
    usage: { completion_tokens: 10_000, estimated: true },
  });
  assert.equal(settlement.quality, 'estimated');
  closeTo(settlement.cost, 1);
  closeTo(guard.snapshot().estimated, 1);
  closeTo(guard.snapshot().actual, 1);
});

test('price 0 is treated as a known free local model, including maxCostYuan 0', () => {
  const guard = createBudgetGuard({
    maxCostYuan: 0,
    priceBook: {
      local: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    },
  });
  const before = guard.beforeAttempt({
    attemptId: 'a_free',
    seatId: 'local',
    estimatedInputTokens: 100_000,
    maxOutputTokens: 10_000,
  });
  assert.equal(before.allowed, true);
  assert.equal(before.reservation.cost, 0);
  assert.equal(before.reservation.quality, 'estimated');

  const settlement = guard.settle({
    attemptId: 'a_free',
    usage: { inputTokens: 10_000, outputTokens: 1_000 },
  });
  assert.equal(settlement.quality, 'exact');
  assert.equal(settlement.cost, 0);
  assert.equal(guard.snapshot().unknown, 0, 'free is known, not unknown');
  closeTo(guard.snapshot().actual, 0);
  closeTo(guard.snapshot().remaining, 0);
});

test('unknown price is rejected when a cap is active unless allowUnknownCost is explicit', () => {
  const strict = createBudgetGuard({ maxCostYuan: 1 });
  const rejected = strict.beforeAttempt({ attemptId: 'a_unknown', seatId: 'noprice', estimatedInputTokens: 10 });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.code, 'BUDGET_UNKNOWN_PRICE');
  assert.equal(strict.snapshot().reserved, 0);

  // 重复 attempt 幂等：不会重复累计拒绝记录。
  const repeated = strict.beforeAttempt({ attemptId: 'a_unknown', seatId: 'noprice', estimatedInputTokens: 10 });
  assert.equal(repeated.allowed, false);
  assert.equal(repeated.duplicate, true);
  assert.equal(strict.snapshot().rejected.length, 1);

  // 未启用上限时不需要预算，未知价格可以派发，但仍标记 unknown。
  const unlimited = createBudgetGuard({ allowUnknownCost: false });
  const allowed = unlimited.beforeAttempt({ attemptId: 'a_unknown_2', seatId: 'noprice' });
  assert.equal(allowed.allowed, true);
  const settlement = unlimited.settle({
    attemptId: 'a_unknown_2',
    usage: { inputTokens: 100 },
  });
  assert.equal(settlement.quality, 'unknown');
  assert.equal(settlement.cost, null, 'unknown must not be recorded as 0');
  assert.equal(unlimited.snapshot().unknown, 1);
  assert.equal(unlimited.snapshot().actual, 0);

  // 显式降级：允许派发，但快照仍然标 unknown。
  const relaxed = createBudgetGuard({ maxCostYuan: 1, allowUnknownCost: true });
  const relaxedBefore = relaxed.beforeAttempt({ attemptId: 'a_unknown_3', seatId: 'noprice' });
  assert.equal(relaxedBefore.allowed, true);
  assert.equal(relaxedBefore.reservation.cost, null);
  assert.equal(relaxedBefore.reservation.quality, 'unknown');
  const relaxedSettlement = relaxed.settle({ attemptId: 'a_unknown_3', usage: { outputTokens: 1 } });
  assert.equal(relaxedSettlement.cost, null);
  assert.equal(relaxed.snapshot().unknown, 1);
  closeTo(relaxed.snapshot().remaining, 1);
});

test('reservations are idempotent and over-budget attempts are rejected without reserving', async () => {
  const guard = createBudgetGuard({
    maxCostYuan: 0.0015,
    priceBook: { paid: price({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }) },
  });

  const first = guard.beforeAttempt({
    attemptId: 'a_one',
    seatId: 'paid',
    estimatedInputTokens: 1000,
    maxOutputTokens: 0,
  });
  const firstAgain = guard.beforeAttempt({
    attemptId: 'a_one',
    seatId: 'paid',
    estimatedInputTokens: 1000,
    maxOutputTokens: 0,
  });
  assert.equal(first.allowed, true);
  assert.equal(firstAgain.duplicate, true);
  closeTo(guard.snapshot().reserved, 0.001, 1e-12);

  const second = guard.beforeAttempt({
    attemptId: 'a_two',
    seatId: 'paid',
    estimatedInputTokens: 1000,
    maxOutputTokens: 0,
  });
  assert.equal(second.allowed, false);
  assert.equal(second.code, 'BUDGET_EXCEEDED');
  closeTo(guard.snapshot().reserved, 0.001, 1e-12);
  assert.equal(guard.snapshot().reservations.length, 1);

  // 结算第一笔后释放预占，新的 attempt 变得可派发；旧 attempt 仍保持幂等拒绝。
  guard.settle({ attemptId: 'a_one', usage: { inputTokens: 500 } });
  closeTo(guard.snapshot().actual, 0.0005, 1e-12);
  closeTo(guard.snapshot().remaining, 0.001, 1e-12);
  const retried = guard.beforeAttempt({
    attemptId: 'a_two_retry',
    seatId: 'paid',
    estimatedInputTokens: 1000,
    maxOutputTokens: 0,
  });
  assert.equal(retried.allowed, true);

  // 同步并发提交同样受总预算约束：已结算 + 已预占不会重复计算。
  const concurrent = [];
  for (let index = 0; index < 4; index += 1) {
    concurrent.push(Promise.resolve().then(() => guard.beforeAttempt({
      attemptId: `a_concurrent_${index}`,
      seatId: 'paid',
      estimatedInputTokens: 1000,
      maxOutputTokens: 0,
    })));
  }
  const results = await Promise.all(concurrent);
  assert.equal(results.filter((result) => result.allowed).length, 0);
  assert.ok(results.every((result) => result.code === 'BUDGET_EXCEEDED'));
});

test('settle is idempotent and a second settle never double-counts', () => {
  const guard = createBudgetGuard({
    maxCostYuan: 1,
    priceBook: { paid: price() },
  });
  guard.beforeAttempt({ attemptId: 'a_dup', seatId: 'paid', estimatedInputTokens: 100, maxOutputTokens: 10 });
  const first = guard.settle({
    attemptId: 'a_dup',
    usage: { inputTokens: 1000, outputTokens: 1000 },
    outcome: 'completed',
  });
  const second = guard.settle({
    attemptId: 'a_dup',
    usage: { inputTokens: 999_999, outputTokens: 999_999 },
    outcome: 'completed',
  });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  closeTo(second.cost, first.cost);
  closeTo(guard.snapshot().actual, first.cost);
  assert.equal(guard.snapshot().settlements.length, 1);
});

test('fail and abort outcomes settle actual usage when present, otherwise release as unknown', () => {
  const guard = createBudgetGuard({
    maxCostYuan: 5,
    priceBook: { paid: price({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }) },
  });

  guard.beforeAttempt({ attemptId: 'a_failed', seatId: 'paid', estimatedInputTokens: 1000, maxOutputTokens: 10 });
  const failed = guard.settle({ attemptId: 'a_failed', usage: null, outcome: 'failed' });
  assert.equal(failed.quality, 'unknown');
  assert.equal(failed.cost, null);
  assert.equal(guard.snapshot().unknown, 1);
  closeTo(guard.snapshot().reserved, 0);

  guard.beforeAttempt({ attemptId: 'a_aborted', seatId: 'paid', estimatedInputTokens: 1000, maxOutputTokens: 10 });
  const aborted = guard.settle({
    attemptId: 'a_aborted',
    usage: { inputTokens: 1000, outputTokens: 200 },
    outcome: 'aborted',
  });
  assert.equal(aborted.quality, 'exact');
  closeTo(aborted.cost, 0.0012);
  closeTo(guard.snapshot().actual, 0.0012);

  assertBudgetError(
    () => guard.settle({ attemptId: 'a_missing', usage: null }),
    'BUDGET_RESERVATION_MISSING',
  );
});

test('estimated input tokens are deterministic and conservative for CJK/ASCII', () => {
  assert.equal(estimateInputTokens(''), 0);
  assert.equal(estimateInputTokens('abcd'), 1);
  assert.equal(estimateInputTokens('中文'), 2);
  assert.equal(estimateInputTokens('ab中文'), 3);
});

// ── Engine 集成 ───────────────────────────────────────────────────────────────

async function createBudgetHarness(t, { seats = ['paid'], budget, maxAttempts = 1 } = {}) {
  const bridges = makeBridges(seats);
  const store = memoryStore();
  const engine = createRoomEngine({
    roomId: 'r_budget',
    bridges,
    store,
    maxAttempts,
    ...(budget === undefined ? {} : { budgetGuard: budget }),
  });
  t.after(() => engine.close());
  await engine.init();
  await engine.activate();
  return { engine, bridges, store };
}

test('a budget rejection happens before TurnRequested and bridge.send', async (t) => {
  const budgetGuard = createBudgetGuard({
    maxCostYuan: 0,
    priceBook: { paid: price({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }) },
    defaultMaxOutputTokens: 100,
  });
  const { engine, bridges, store } = await createBudgetHarness(t, { budget: budgetGuard });
  await engine.postOwnerMessage({ text: '这条消息不应被派发。' });

  const rejectedEvents = [];
  engine.on('budget-rejected', (event) => rejectedEvents.push(event));

  const result = await engine.run();

  assert.equal(result.ran, true);
  assert.deepEqual(result.turns, []);
  assert.equal(result.reason, 'budget-exceeded');
  assert.equal(result.budgetStopped, true);
  assert.equal(result.budgetError.code, 'BUDGET_EXCEEDED');
  assert.equal(rejectedEvents.length, 1);
  assert.equal(rejectedEvents[0].seatId, 'paid');

  assert.equal(bridges.get('paid').inspect().activeAttemptId, null);
  assert.equal(bridges.get('paid')._attempts.size, 0, 'bridge.send must not be called');
  assert.equal(store.state.events.filter((event) => event.type === 'TurnRequested').length, 0);

  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.room.state, 'active');
  assert.equal(snapshot.schedule.attemptsUsed, 0);
  assert.equal(snapshot.schedule.awaiting, null);
  assert.equal(snapshot.schedule.selectionSeq, 0, 'rejected selection must not be committed');
  assert.equal(snapshot.lastBudgetError.code, 'BUDGET_EXCEEDED');
  assert.equal(snapshot.budget.rejected.length, 1);
  assert.equal(snapshot.budget.reserved, 0);

  // 再次 run 仍然不会漏派发。
  const again = await engine.run();
  assert.equal(again.reason, 'budget-exceeded');
  assert.equal(bridges.get('paid')._attempts.size, 0);
});

test('engine settles exact usage for completed and failed attempts', async (t) => {
  const budgetGuard = createBudgetGuard({
    maxCostYuan: 1,
    priceBook: { paid: price({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }) },
    defaultMaxOutputTokens: 10,
  });
  const { engine, bridges } = await createBudgetHarness(t, { budget: budgetGuard });
  await engine.postOwnerMessage({ text: '完成一次。' });

  const driver = driveTurns(engine, [(event) => {
    bridges.get('paid').completeAttempt(event.payload.attemptId, {
      text: '完成。',
      usage: { inputTokens: 1000, outputTokens: 500 },
    });
  }]);
  const result = await engine.run();
  await driver.done();

  assert.equal(result.state, 'review');
  const snapshot = engine.getSnapshot();
  closeTo(snapshot.budget.actual, 0.0015);
  assert.equal(snapshot.budget.unknown, 0);
  assert.equal(snapshot.budget.reserved, 0);
  assert.equal(snapshot.budget.settlements[0].outcome, 'completed');
  assert.equal(snapshot.budget.settlements[0].quality, 'exact');
});

test('a failed bridge.send releases the reservation as unknown, not zero', async (t) => {
  const budgetGuard = createBudgetGuard({
    maxCostYuan: 1,
    priceBook: { paid: price() },
    defaultMaxOutputTokens: 10,
  });
  const { engine, bridges } = await createBudgetHarness(t, { budget: budgetGuard });
  await engine.postOwnerMessage({ text: '发送会失败。' });

  bridges.get('paid').send = async () => {
    const error = new Error('offline transport down');
    error.code = 'TRANSPORT_DOWN';
    throw error;
  };

  const result = await engine.run();

  assert.equal(result.state, 'review');
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.budget.reserved, 0);
  assert.equal(snapshot.budget.unknown, 1);
  assert.equal(snapshot.budget.settlements[0].cost, null);
  assert.equal(snapshot.budget.settlements[0].outcome, 'failed');
  assert.equal(snapshot.attempts.at(-1).status, 'failed');
});

test('closing during an in-flight attempt settles the reservation as aborted/unknown', async (t) => {
  const budgetGuard = createBudgetGuard({
    maxCostYuan: 1,
    priceBook: { paid: price() },
    defaultMaxOutputTokens: 10,
  });
  const { engine, bridges } = await createBudgetHarness(t, { budget: budgetGuard });
  await engine.postOwnerMessage({ text: '还没结束就关闭。' });

  let turn = null;
  engine.on('TurnRequested', (event) => {
    turn = event;
  });
  const runPromise = engine.run();
  await waitFor(() => turn !== null, 'TurnRequested');
  assert.equal(engine.getSnapshot().budget.reserved > 0, true);

  await engine.close();
  const result = await runPromise;

  assert.equal(result.closed, true);
  const snapshot = engine.getSnapshot();
  assert.equal(snapshot.budget.reserved, 0);
  assert.equal(snapshot.budget.unknown, 1);
  assert.equal(snapshot.budget.settlements[0].outcome, 'aborted');
  assert.equal(snapshot.budget.settlements[0].cost, null);
  assert.equal(bridges.get('paid').inspect().closed, true);
});

// ── 配置与 live 映射 ─────────────────────────────────────────────────────────

test('validateConfig accepts and normalizes budget, and rejects invalid budget fields', () => {
  const config = validateConfig(baseConfig({
    budget: {
      maxCostYuan: 2.5,
      allowUnknownCost: true,
      defaultMaxOutputTokens: 256,
      priceBook: {
        paid: { input: 1, cacheRead: 0.1, cacheWrite: 2, output: 4, multiplier: 1.5 },
        free: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      },
    },
  }));
  assert.equal(config.budget.maxCostYuan, 2.5);
  assert.equal(config.budget.allowUnknownCost, true);
  assert.equal(config.budget.defaultMaxOutputTokens, 256);
  assert.equal(config.budget.priceBook.paid.multiplier, 1.5);
  assert.equal(config.budget.priceBook.free.output, 0);

  const withoutBudget = validateConfig(baseConfig());
  assert.equal(withoutBudget.budget, undefined);

  assertConfigError(
    () => validateConfig(baseConfig({ budget: { maxCostYuan: -1 } })),
    'BUDGET_AMOUNT_INVALID',
  );
  assertConfigError(
    () => validateConfig(baseConfig({ budget: { allowUnknownCost: 'yes' } })),
    'BUDGET_ALLOW_UNKNOWN_INVALID',
  );
  assertConfigError(
    () => validateConfig(baseConfig({ budget: { defaultMaxOutputTokens: 1.5 } })),
    'BUDGET_DEFAULT_MAX_OUTPUT_TOKENS_INVALID',
  );
  assertConfigError(
    () => validateConfig(baseConfig({ budget: { unknownField: 1 } })),
    'CONFIG_UNKNOWN_FIELD',
  );
  assertConfigError(
    () => validateConfig(baseConfig({ budget: { priceBook: { ghost: price() } } })),
    'BUDGET_SEAT_UNKNOWN',
  );
  assertConfigError(
    () => validateConfig(baseConfig({ budget: { priceBook: { paid: { input: 1 } } } })),
    'BUDGET_PRICE_INVALID',
  );
  assertConfigError(
    () => validateConfig(baseConfig({ budget: { priceBook: { paid: price({ output: -1 }) } } })),
    'BUDGET_AMOUNT_INVALID',
  );
});

test('example config stays price-free and parses its budget placeholder', async () => {
  const config = await loadConfig(path.join(PROJECT_ROOT, 'config/members.example.json'));
  assert.equal(config.budget.maxCostYuan, undefined);
  assert.equal(config.budget.allowUnknownCost, false);
  assert.equal(config.budget.defaultMaxOutputTokens, 512);
  assert.equal(config.budget.priceBook, undefined, 'example must not ship real prices');
});

test('startLive maps config.budget into a budgetGuard on the engine', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-room-budget-live-'));
  const originalLog = console.log;
  console.log = () => {};
  let live = null;
  t.after(async () => {
    console.log = originalLog;
    if (live) await live.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  live = await startLive({
    config: baseConfig({
      budget: {
        maxCostYuan: 1.25,
        allowUnknownCost: true,
        defaultMaxOutputTokens: 64,
        priceBook: {
          paid: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      },
    }),
    host: '127.0.0.1',
    port: 0,
    token: 'budget-live-token',
    stateDir: path.join(root, 'state'),
    roomDir: path.join(root, 'room'),
  });

  assert.ok(live.budgetGuard, 'startLive should expose the created budget guard');
  const snapshot = live.engine.getSnapshot();
  assert.equal(snapshot.budget.maxCostYuan, 1.25);
  assert.equal(snapshot.budget.allowUnknownCost, true);
  assert.equal(snapshot.budget.defaultMaxOutputTokens, 64);
  closeTo(snapshot.budget.remaining, 1.25);
  assert.equal(snapshot.budget.unlimited, false);

  // 无预算配置时不注入 budgetGuard。
  assert.equal(live.engine.budgetGuard, live.budgetGuard);
});
