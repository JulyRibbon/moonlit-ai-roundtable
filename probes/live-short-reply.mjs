// probes/live-short-reply.mjs — 真实客户端短回复探针（默认安全：没有 --allow-cost 一律拒绝）
//
// 这个探针会真的向一个已存在的原生会话投递消息，因此会消耗 token / 产生费用：
//   - 普通模式：发一句「只回复 OK，不要调用任何工具。」并等待真实终态；
//   - --abort：先发一个要求较长回答的回合，收到 AttemptStarted 后取消一次。
//
// 只使用 Bridge v1 公开接口（connect / subscribe / send / cancel / close），
// 不创建、不归档、不 fork 原生会话，不读 transcript / 历史消息，也不打印任何凭据。
//
// 用法：
//   node probes/live-short-reply.mjs --client dsh|kimi-code|zcode --session <id> --allow-cost [--abort] [--json]
//
// 测试可通过 options.factories = { dsh, 'kimi-code', zcode } 注入离线 fake，
// 从而不触碰真实网络、子进程或模型。

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { createDshBridge, DSH_DEFAULT_BASE_URL } from '../adapters/dsh/bridge.mjs';
import { createKimiCodeBridge, KIMI_DEFAULT_BASE_URL } from '../adapters/kimi-code/bridge.mjs';
import { createZCodeBridge } from '../adapters/zcode/bridge.mjs';

export const CLIENT_TYPES = Object.freeze(['dsh', 'kimi-code', 'zcode']);
export const SHORT_PROMPT = '只回复 OK，不要调用任何工具。';
export const ABORT_PROMPT = '请从 1 数到 300，每行一个数字，不要省略。只输出数字。';
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 15000;

const CLIENT_BASE_URLS = Object.freeze({
  dsh: DSH_DEFAULT_BASE_URL,
  'kimi-code': KIMI_DEFAULT_BASE_URL,
});

const PLACEHOLDER_PATTERNS = Object.freeze([
  /^<.*>$/,
  /^\{.*\}$/,
  /placeholder/i,
  /^your[_-]?session/i,
  /^example/i,
  /^replace/i,
  /^todo$/i,
  /^session[_-]?x+$/i,
  /^sess[_-]?x+$/i,
  /x{4,}/i,
]);

const VOICE_WARNINGS = Object.freeze({
  dsh: ['DSH 没有原生语音能力：本探针只产生文本，不会发声。'],
  'kimi-code': ['Kimi Code 的 Stop hook 可能在这次真实回合结束时触发，请观察是否有语音副作用。'],
  zcode: ['ZCode 使用默认安装与人格配置；外部 Stop hook 可能朗读回复，本探针不会主动触发，也无法静音。'],
});

const TOKEN_PATTERNS = Object.freeze([
  [/(\bbearer\s+)[^\s,;]+/gi, '$1[redacted]'],
  [/((?:access[._-]?token|refresh[._-]?token|server[._-]?token|api[._-]?key|\btoken|secret|password|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]'],
  [/\b[A-Fa-f0-9]{32,}\b/g, '[redacted]'],
]);

const TIMEOUT = Symbol('timeout');

export class ProbeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ProbeError';
    this.code = code;
    this.retryable = options.retryable === true;
  }
}

export function redact(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  for (const [pattern, replacement] of TOKEN_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function errorInfo(error) {
  const code = typeof error?.code === 'string' && error.code.length > 0
    ? error.code
    : error?.name === 'ProbeError'
      ? 'PROBE_ERROR'
      : 'PROBE_FAILED';
  return {
    code,
    message: redact(error?.message ?? error),
    retryable: error?.retryable === true,
  };
}

function outOf(io, key) {
  const fallback = key === 'err' ? console.error : console.log;
  return typeof io[key] === 'function' ? io[key] : fallback;
}

function writeLine(io, key, line = '') {
  outOf(io, key)(line);
}

function isPlaceholderSession(session) {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(session));
}

export function parseArgs(argv) {
  const parsed = {
    help: false,
    client: null,
    session: null,
    allowCost: false,
    abort: false,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
      continue;
    }
    if (arg === '--client' || arg === '--session' || arg === '--timeout') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ProbeError('E_MISSING_VALUE', `${arg} 缺少参数值。`);
      }
      index += 1;
      if (arg === '--client') parsed.client = value;
      else if (arg === '--session') parsed.session = value;
      else {
        const timeoutMs = Number(value);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
          throw new ProbeError('E_INVALID_TIMEOUT', `--timeout 需要正整数毫秒，收到: ${value}`);
        }
        parsed.timeoutMs = Math.floor(timeoutMs);
      }
      continue;
    }
    if (arg === '--allow-cost') {
      parsed.allowCost = true;
      continue;
    }
    if (arg === '--abort') {
      parsed.abort = true;
      continue;
    }
    if (arg === '--json') {
      parsed.json = true;
      continue;
    }
    throw new ProbeError('E_UNKNOWN_ARG', `未知参数: ${arg}（用 --help 查看用法）`);
  }

  return parsed;
}

export function validateOptions(parsed) {
  if (parsed.help) return parsed;
  if (!parsed.client) {
    throw new ProbeError('E_MISSING_CLIENT', '缺少 --client；可选 dsh、kimi-code、zcode。');
  }
  if (!CLIENT_TYPES.includes(parsed.client)) {
    throw new ProbeError(
      'E_UNKNOWN_CLIENT',
      `未知 --client: ${parsed.client}；可选 ${CLIENT_TYPES.join('、')}。`,
    );
  }
  if (!parsed.session) {
    throw new ProbeError('E_MISSING_SESSION', '缺少 --session <原生会话 id>。');
  }
  if (typeof parsed.session !== 'string' || parsed.session.trim() !== parsed.session || parsed.session.length === 0) {
    throw new ProbeError('E_INVALID_SESSION', '--session 必须是非空、无首尾空白的会话 id。');
  }
  if (/\s/.test(parsed.session) || parsed.session.length > 512) {
    throw new ProbeError('E_INVALID_SESSION', '--session 不是合法的会话 id。');
  }
  if (isPlaceholderSession(parsed.session)) {
    throw new ProbeError(
      'E_PLACEHOLDER_SESSION',
      `拒绝占位会话 id: ${parsed.session}；请换成真实存在的原生会话。`,
    );
  }
  if (!parsed.allowCost) {
    throw new ProbeError(
      'E_ALLOW_COST_REQUIRED',
      '拒绝执行：这个探针会产生真实模型调用与费用。确认后加 --allow-cost。',
    );
  }
  return parsed;
}

export function helpText() {
  return [
    '真实客户端短回复探针（会产生真实模型调用与费用）',
    '',
    '用法:',
    '  node probes/live-short-reply.mjs --client dsh|kimi-code|zcode --session <id> --allow-cost [--abort] [--json] [--timeout ms]',
    '',
    '参数:',
    '  --client <name>   必填；dsh / kimi-code / zcode',
    '  --session <id>    必填；已存在的原生会话 id，占位值会被拒绝',
    '  --allow-cost      必填安全闸；没有它一律拒绝并退出非 0',
    '  --abort           发一条要求较长回答的提示，收到 AttemptStarted 后取消一次',
    '  --json            输出机器可读 JSON（错误已脱敏）',
    '  --timeout <ms>    单阶段超时，默认 60000',
    '  -h, --help        显示本帮助',
    '',
    '费用副作用:',
    '  普通模式会真实投递一条短提示，至少产生一次模型调用与 token 费用。',
    '  --abort 也会先产生一个真实回合，再取消；取消前已生成的 token 仍计费。',
    '  探针不创建、不归档会话，也不读历史正文；用法以各客户端实际账单为准。',
    '',
    '语音副作用:',
    '  zcode: 使用默认安装与人格配置，外部 Stop hook 可能朗读回复，探针无法静音。',
    '  kimi-code: 回合结束时 Stop hook 可能触发，请观察是否出声。',
    '  dsh: 无原生语音，仅文本。',
    '',
    '默认地址:',
    `  dsh       ${CLIENT_BASE_URLS.dsh}`,
    `  kimi-code ${CLIENT_BASE_URLS['kimi-code']}`,
    '  zcode     使用客户端默认 exe / cli / 人格配置（不额外指定）',
  ].join('\n');
}

function bridgeConfigFor(client, parsed, options) {
  const seatId = options.seatId ?? `live-short-reply-${client}`;
  const config = {
    seatId,
    nativeSessionRef: parsed.session,
  };
  if (client !== 'zcode') {
    config.baseUrl = options.baseUrl ?? CLIENT_BASE_URLS[client];
  }
  return config;
}

const DEFAULT_FACTORIES = Object.freeze({
  dsh: (config) => createDshBridge(config),
  'kimi-code': (config) => createKimiCodeBridge(config),
  zcode: (config) => createZCodeBridge(config),
});

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new ProbeError('TIMEOUT', `${label} 超时（${ms}ms）。`, { retryable: true }));
    }, Math.max(1, ms));
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function nextWithin(subscription, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(1, ms));
  });
  try {
    const result = await Promise.race([subscription.next(), timeout]);
    return result === TIMEOUT ? TIMEOUT : result;
  } finally {
    clearTimeout(timer);
  }
}

function isTerminalType(type) {
  return type === 'AttemptCompleted' || type === 'AttemptAborted' || type === 'AttemptFailed';
}

function payloadOf(event) {
  return event?.payload && typeof event.payload === 'object' ? event.payload : {};
}

function outcomeFromEvent(event) {
  const payload = payloadOf(event);
  if (event.type === 'AttemptCompleted') {
    return {
      status: 'completed',
      text: typeof payload.text === 'string' ? payload.text : '',
      nativeTurnRef: payload.nativeTurnRef ?? null,
      nativeMessageRef: payload.nativeMessageRef ?? null,
    };
  }
  if (event.type === 'AttemptAborted') {
    return {
      status: 'aborted',
      partialText: truncate(typeof payload.partialText === 'string' ? payload.partialText : '', 1000),
      nativeTurnRef: payload.nativeTurnRef ?? null,
    };
  }
  return {
    status: 'failed',
    error: {
      code: typeof payload.error?.code === 'string' ? payload.error.code : 'ATTEMPT_FAILED',
      message: redact(payload.error?.message ?? 'Attempt failed without an error message.'),
      retryable: payload.error?.retryable === true,
    },
    nativeTurnRef: payload.nativeTurnRef ?? null,
  };
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export async function runProbe(parsed, options = {}) {
  validateOptions(parsed);

  const client = parsed.client;
  const seatId = options.seatId ?? `live-short-reply-${client}`;
  const attemptId = options.attemptId ?? `live-${client}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const prompt = parsed.abort ? ABORT_PROMPT : SHORT_PROMPT;
  const timeoutMs = parsed.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const startedAt = Date.now();

  const events = [];
  const warnings = [...(VOICE_WARNINGS[client] ?? [])];
  let subscription = null;
  let bridge = null;
  let closeError = null;
  let usage = null;
  let outcome = null;
  let sendReceipt = null;
  let cancelReceipt = null;
  let startedSeen = false;

  const record = (event) => {
    if (!event || typeof event.type !== 'string') return;
    const entry = { type: event.type, atMs: Date.now() - startedAt };
    if (typeof event.attemptId === 'string') entry.attemptId = event.attemptId;
    events.push(entry);

    const payload = payloadOf(event);
    if (event.type === 'AttemptStarted' && event.attemptId === attemptId) startedSeen = true;
    if (!usage && payload.usage && typeof payload.usage === 'object') {
      if (startedSeen || isTerminalType(event.type)) usage = { ...payload.usage };
    }
  };

  const waitFor = async (predicate, deadline) => {
    while (Date.now() <= deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await nextWithin(subscription, remaining);
      if (result === TIMEOUT) return { timedOut: true };
      if (!result || result.done) return { ended: true };
      const event = result.value;
      record(event);
      if (predicate(event)) return { event };
    }
    return { timedOut: true };
  };

  try {
    const factory = options.factories?.[client]
      ?? options.createBridge
      ?? DEFAULT_FACTORIES[client];
    const config = bridgeConfigFor(client, parsed, options);
    bridge = await factory(config);
    if (!bridge || typeof bridge.connect !== 'function' || typeof bridge.subscribe !== 'function'
      || typeof bridge.send !== 'function' || typeof bridge.close !== 'function') {
      throw new ProbeError('BRIDGE_INVALID', `${client} 工厂没有返回 Bridge v1 兼容对象。`);
    }

    await withTimeout(bridge.connect(config), timeoutMs, 'connect');
    subscription = bridge.subscribe();
    if (!subscription || typeof subscription.next !== 'function') {
      throw new ProbeError('BRIDGE_INVALID', `${client} subscribe() 没有返回 AsyncIterable。`);
    }

    const packet = {
      roomId: 'live-short-reply-probe',
      roomSeq: 1,
      turnId: attemptId,
      attemptId,
      seatId,
      contextEpoch: `probe-${startedAt}`,
      text: prompt,
    };
    sendReceipt = await withTimeout(bridge.send(packet), timeoutMs, 'send');

    if (parsed.abort) {
      const startDeadline = Date.now() + timeoutMs;
      const started = await waitFor(
        (event) => event.type === 'AttemptStarted' && event.attemptId === attemptId,
        startDeadline,
      );
      if (started.timedOut) {
        outcome = {
          status: 'timeout',
          error: { code: 'START_TIMEOUT', message: `等待 AttemptStarted 超时（${timeoutMs}ms）。`, retryable: true },
        };
      } else if (started.ended) {
        outcome = {
          status: 'failed',
          error: { code: 'STREAM_ENDED', message: '事件流在 AttemptStarted 前结束。', retryable: true },
        };
      } else {
        try {
          cancelReceipt = await withTimeout(bridge.cancel(attemptId), timeoutMs, 'cancel');
        } catch (error) {
          cancelReceipt = { attemptId, accepted: false, settlement: 'failed', error: errorInfo(error) };
        }

        const terminalDeadline = Date.now() + timeoutMs;
        const terminal = await waitFor(
          (event) => event.attemptId === attemptId && isTerminalType(event.type),
          terminalDeadline,
        );
        if (terminal.timedOut) {
          outcome = {
            status: 'timeout',
            error: {
              code: 'TERMINAL_TIMEOUT',
              message: `取消后等待 AttemptAborted/AttemptFailed 超时（${timeoutMs}ms）。`,
              retryable: true,
            },
          };
        } else if (terminal.ended) {
          outcome = {
            status: 'failed',
            error: { code: 'STREAM_ENDED', message: '事件流在取消终结前结束。', retryable: true },
          };
        } else {
          outcome = outcomeFromEvent(terminal.event);
        }
      }
    } else {
      const deadline = Date.now() + timeoutMs;
      const terminal = await waitFor(
        (event) => event.attemptId === attemptId && isTerminalType(event.type),
        deadline,
      );
      if (terminal.timedOut) {
        outcome = {
          status: 'timeout',
          error: {
            code: 'TERMINAL_TIMEOUT',
            message: `等待 AttemptCompleted/Failed 超时（${timeoutMs}ms）。`,
            retryable: true,
          },
        };
      } else if (terminal.ended) {
        outcome = {
          status: 'failed',
          error: { code: 'STREAM_ENDED', message: '事件流在终态前结束。', retryable: true },
        };
      } else {
        outcome = outcomeFromEvent(terminal.event);
      }
    }
  } catch (error) {
    outcome = { status: 'failed', error: errorInfo(error) };
  } finally {
    try {
      await subscription?.return?.();
    } catch {
      // 订阅已经结束时 return 是空操作。
    }
    if (bridge && typeof bridge.close === 'function') {
      try {
        await withTimeout(bridge.close(), closeTimeoutMs, 'close');
      } catch (error) {
        closeError = errorInfo(error);
      }
    }
  }

  const expected = parsed.abort ? 'aborted' : 'completed';
  const ok = outcome?.status === expected && !closeError;

  return {
    ok,
    client,
    mode: parsed.abort ? 'abort' : 'short-reply',
    sessionRef: parsed.session,
    seatId,
    attemptId,
    prompt,
    warnings,
    events,
    sendReceipt,
    cancelReceipt,
    usage: usage ?? null,
    outcome: outcome ?? {
      status: 'failed',
      error: { code: 'NO_OUTCOME', message: '探针没有产生结果。', retryable: false },
    },
    close: closeError ? { ok: false, error: closeError } : { ok: true },
    elapsedMs: Date.now() - startedAt,
  };
}

function formatUsage(usage) {
  if (!usage || typeof usage !== 'object') return '未报告';
  const fields = [
    ['inputTokens', 'input'],
    ['outputTokens', 'output'],
    ['cacheReadTokens', 'cacheRead'],
    ['cacheWriteTokens', 'cacheWrite'],
    ['totalTokens', 'total'],
  ];
  const parts = [];
  for (const [key, label] of fields) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) parts.push(`${label}=${usage[key]}`);
  }
  return parts.length > 0 ? parts.join(' ') : '未报告';
}

function formatHuman(result) {
  const lines = [];
  lines.push(`[probe] client=${result.client} mode=${result.mode} session=${result.sessionRef}`);
  lines.push(`[probe] attempt=${result.attemptId}`);
  for (const warning of result.warnings) lines.push(`[probe] 语音提示: ${warning}`);
  lines.push(`[probe] 发送: ${result.prompt}`);
  lines.push(`[probe] 事件: ${result.events.map((event) => `${event.type}@${event.atMs}ms`).join(', ') || '无'}`);
  if (result.sendReceipt) {
    const accepted = result.sendReceipt.accepted === true ? 'accepted' : 'not-accepted';
    lines.push(`[probe] 投递回执: ${accepted}`);
  }
  if (result.cancelReceipt) {
    const settlement = result.cancelReceipt.settlement ?? 'unknown';
    lines.push(
      `[probe] 取消回执: accepted=${result.cancelReceipt.accepted === true} settlement=${settlement}`,
    );
  }
  const outcome = result.outcome;
  lines.push(`[probe] 结果: ${String(outcome.status).toUpperCase()}`);
  if (outcome.status === 'completed') {
    lines.push(`[probe] 回复: ${truncate(outcome.text, 1000)}`);
  } else if (outcome.status === 'aborted') {
    lines.push(`[probe] 已中止，partial 长度=${outcome.partialText?.length ?? 0}`);
    if (outcome.partialText) lines.push(`[probe] partial: ${truncate(outcome.partialText, 200)}`);
  } else if (outcome.error) {
    lines.push(`[probe] 错误: ${outcome.error.code}: ${redact(outcome.error.message)}`);
  }
  lines.push(`[probe] usage: ${formatUsage(result.usage)}`);
  lines.push(`[probe] 关闭: ${result.close.ok ? 'ok' : `失败 ${result.close.error.code}: ${result.close.error.message}`}`);
  lines.push(`[probe] 耗时: ${result.elapsedMs}ms`);
  return lines.join('\n');
}

function writeJson(io, value) {
  outOf(io, 'out')(JSON.stringify(value, null, 2));
}

/**
 * CLI 入口：返回进程退出码，不调用 process.exit（方便离线测试）。
 * options.factories 可注入 { dsh, 'kimi-code', zcode } fake 工厂。
 */
export async function runCli(argv, options = {}) {
  const io = options.io ?? {};
  const jsonRequested = argv.includes('--json');

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    const info = errorInfo(error);
    if (jsonRequested) writeJson(io, { ok: false, error: info });
    else writeLine(io, 'err', `[probe] 拒绝: ${info.message}`);
    return 2;
  }

  if (parsed.help) {
    writeLine(io, 'out', helpText());
    return 0;
  }

  try {
    validateOptions(parsed);
  } catch (error) {
    const info = errorInfo(error);
    if (jsonRequested || parsed.json) writeJson(io, { ok: false, error: info });
    else writeLine(io, 'err', `[probe] 拒绝: ${info.message}`);
    return 2;
  }

  let result;
  try {
    result = await runProbe(parsed, options);
  } catch (error) {
    const info = errorInfo(error);
    if (parsed.json) writeJson(io, { ok: false, error: info });
    else writeLine(io, 'err', `[probe] 失败: ${info.code}: ${info.message}`);
    return 1;
  }

  if (parsed.json) writeJson(io, result);
  else writeLine(io, 'out', formatHuman(result));
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath && invokedPath === import.meta.url) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(`[probe] 未处理错误: ${redact(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
