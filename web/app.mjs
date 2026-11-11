import {
  createEventDeduper,
  createSseParser,
  retryDelay,
  shouldReconnect,
} from './sse.mjs';
import {
  createManagementUI,
  modelLabel,
  shortSessionRef,
} from './management.mjs';
import { createGameUI } from './game.mjs';
import { createTabletopUI } from './tabletop.mjs?v=0_5_0r2';

const TOKEN_KEY = 'ai-room.token';
const MAX_ACTIVITY = 40;
const SEAT_ORDER = ['deepseek', 'kimi', 'glm'];
const SEAT_LABELS = Object.freeze({ deepseek: 'DeepSeek', kimi: 'Kimi', glm: 'GLM' });
const ROOM_STATE_LABELS = Object.freeze({
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  review: '待确认',
  confirmed: '已确认',
  archived: '已归档',
  halted: '已停止',
});
const SENDABLE_STATES = new Set(['draft', 'active', 'paused', 'review']);
const SEAT_STATUS_LABELS = Object.freeze({
  idle: '待命',
  thinking: '思考中',
  speaking: '语音中',
  paused: '已暂停',
  disabled: '已停用',
  error: '错误',
  halted: '已停止',
  muted: '语音静音',
});

/* ── 停止（纯函数，可在 Node 中直接测试） ────────────────────────────────── */

function haltCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function hasHaltReceiptShape(receipt) {
  return Boolean(receipt)
    && typeof receipt === 'object'
    && ('aborted' in receipt || 'degraded' in receipt || 'pending' in receipt);
}

/**
 * 解释 haltGuard 的停止回执。degraded/pending/未完全结算一律红级，
 * 且 headline 不得出现“全部已停”这类成功措辞。
 */
export function classifyHaltReceipt(receipt) {
  if (!hasHaltReceiptShape(receipt)) return null;
  const aborted = haltCount(receipt.aborted);
  const degraded = haltCount(receipt.degraded);
  const pending = haltCount(receipt.pending);
  const fullySettled = receipt.fullySettled === true;
  const stopped = receipt.stopped === true;
  const halted = receipt.halted === true;
  const sentinelFailed = typeof receipt.sentinelErrorCode === 'string'
    || (receipt.sentinelWritten === false);

  const counts = { aborted, degraded, pending, fullySettled };
  const detail = `aborted ${aborted} · degraded ${degraded} · pending ${pending} · fullySettled ${fullySettled ? '是' : '否'}`;

  if (pending > 0 || degraded > 0) {
    const level = 'danger';
    const headline = pending > 0
      ? `停止未完全结算：${pending} 个仍在等待`
      : `停止已降级：${degraded} 个未确认`;
    return { level, tone: level, headline, detail, counts, aborted, degraded, pending, fullySettled, stopped, halted };
  }
  if (sentinelFailed || !stopped) {
    return {
      level: 'danger',
      tone: 'danger',
      headline: '停止未落盘：哨兵写入失败',
      detail,
      counts,
      aborted,
      degraded,
      pending,
      fullySettled,
      stopped,
      halted,
    };
  }
  if (!fullySettled) {
    return {
      level: 'danger',
      tone: 'danger',
      headline: '停止未完全结算',
      detail,
      counts,
      aborted,
      degraded,
      pending,
      fullySettled,
      stopped,
      halted,
    };
  }
  return {
    level: 'ok',
    tone: 'ok',
    headline: aborted > 0 ? `全部已停（${aborted} 个已中止）` : '全部已停',
    detail,
    counts,
    aborted,
    degraded,
    pending,
    fullySettled,
    stopped,
    halted,
  };
}

/** 解释 haltGuard.resume 回执；resumed 不为 true 时仍是红级。 */
export function classifyResumeReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object') return null;
  if (!('resumed' in receipt) && !('cleared' in receipt)) return null;
  const resumed = receipt.resumed === true;
  const halted = receipt.halted === true;
  if (!resumed || halted) {
    return {
      level: 'danger',
      tone: 'danger',
      headline: '解除停止未完成',
      detail: halted ? '停止哨兵仍然存在，房间仍是 halted。' : '停止哨兵清除失败。',
    };
  }
  return {
    level: 'ok',
    tone: 'ok',
    headline: '已解除停止',
    detail: '房间恢复为 paused，需要机主另行点击“继续”，不会自动运行。',
  };
}

/** 顶栏停止按钮的状态：halt / resume / 不可用；重复请求时禁用。 */
export function haltControlView({ snapshot = null, busy = null } = {}) {
  const roomState = snapshot?.room?.state ?? null;
  const haltInfo = snapshot && snapshot.halt && typeof snapshot.halt === 'object'
    ? snapshot.halt
    : null;
  const hasGuard = Boolean(haltInfo);
  const halted = roomState === 'halted' || haltInfo?.halted === true;
  const mode = halted ? 'resume' : 'halt';
  const label = halted ? '解除停止' : '全部停止';

  if (!snapshot) {
    return { mode, label, disabled: true, unavailable: true, halted, hasGuard, reason: '等待房间快照' };
  }
  if (!hasGuard) {
    return {
      mode,
      label,
      disabled: true,
      unavailable: true,
      halted,
      hasGuard,
      reason: '当前引擎未启用停止守卫（haltGuard），无法停止',
    };
  }
  if (busy === 'halt') {
    return { mode: 'halt', label: '停止中…', disabled: true, unavailable: false, halted, hasGuard, reason: '正在请求停止' };
  }
  if (busy === 'resume') {
    return {
      mode: 'resume',
      label: '恢复中…',
      disabled: true,
      unavailable: false,
      halted,
      hasGuard,
      reason: '正在解除停止',
    };
  }
  if (!halted && roomState === 'archived') {
    return { mode, label, disabled: true, unavailable: false, halted, hasGuard, reason: '已归档房间不可停止' };
  }
  return {
    mode,
    label,
    disabled: false,
    unavailable: false,
    halted,
    hasGuard,
    reason: halted ? '解除后房间为 paused，需要另行继续' : '立即停止本房在途成员，不等待语音',
  };
}

/** 停止请求期间及停止生效后立即拦截 run，避免连点。 */
export function runBlockedByHalt({
  roomState = null,
  haltBusy = null,
  haltPending = false,
  haltInEffect = false,
} = {}) {
  return Boolean(haltBusy || haltPending || haltInEffect) || roomState !== 'active';
}

/** 通用单飞锁：同一时刻只允许一个请求，防止重复点击。 */
export function createSingleFlightLock() {
  let pending = null;
  return {
    get pending() {
      return pending;
    },
    begin(kind) {
      if (pending !== null) return false;
      pending = kind;
      return true;
    },
    end(kind) {
      if (pending === null) return false;
      if (kind !== undefined && pending !== kind) return false;
      pending = null;
      return true;
    },
  };
}

/** 保留旧名字；halt/resume 与新按钮共用同一把单飞锁实现。 */
export const createHaltRequestLock = createSingleFlightLock;

/** review 专属的“再聊一轮”按钮；paused 仍使用原“继续”。 */
export function reviewContinueView({ snapshot = null, busy = null } = {}) {
  const state = snapshot?.room?.state ?? null;
  if (state !== 'review') {
    return {
      visible: false,
      disabled: true,
      label: '再聊一轮',
      reason: '仅 review 状态可再聊一轮',
    };
  }
  if (busy === 'run') {
    return {
      visible: true,
      disabled: true,
      label: '开始闲聊中…',
      reason: 'continue 已成功，正在调用 /api/run',
    };
  }
  if (busy) {
    return {
      visible: true,
      disabled: true,
      label: '再聊中…',
      reason: '正在请求再聊一轮，按钮已锁定',
    };
  }
  return {
    visible: true,
    disabled: false,
    label: '再聊一轮',
    reason: '成功后由本次点击显式调用 run；不会自动开始',
  };
}

/**
 * review 专用动作序列：先 POST /api/continue，成功后才调用 /api/run。
 * continue 失败时绝不调用 run；锁在整个序列期间保持，避免连点。
 */
export async function performReviewContinue({
  lock = null,
  postContinue,
  postRun,
  onPhase,
} = {}) {
  if (typeof postContinue !== 'function' || typeof postRun !== 'function') {
    throw new TypeError('performReviewContinue() requires postContinue and postRun functions.');
  }
  if (lock && !lock.begin('continue-review')) {
    return { started: false, locked: true, phase: 'locked', ran: false, error: null };
  }

  let phase = 'continue';
  try {
    onPhase?.('continue');
    const continueResult = await postContinue();
    phase = 'run';
    onPhase?.('run');
    const runResult = await postRun();
    return {
      started: true,
      locked: false,
      phase: 'done',
      ran: true,
      continueResult,
      runResult,
      error: null,
    };
  } catch (error) {
    return {
      started: true,
      locked: false,
      phase,
      ran: phase === 'run',
      continueResult: null,
      runResult: null,
      error,
    };
  } finally {
    lock?.end('continue-review');
  }
}

/** 把 HaltRequested / HaltSettled 事件折叠成 UI 可合并的覆盖层。 */
export function haltEventOverlay(event) {
  if (!event || typeof event !== 'object') return null;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  if (event.type === 'HaltRequested') {
    return { pending: true, receipt: null, halted: null };
  }
  if (event.type === 'HaltSettled') {
    return {
      pending: false,
      receipt: {
        ...payload,
        at: typeof event.occurredAt === 'string' ? event.occurredAt : null,
      },
      halted: payload.halted === true,
    };
  }
  return null;
}

/**
 * 停止状态条。receipt 可来自 POST 回执、lastHalt 快照或 HaltSettled 事件；
 * 没有 guard 时明确显示不可用，不伪造成功。
 */
export function haltBannerView({ snapshot = null, receipt = null, pending = false } = {}) {
  if (pending) {
    return {
      tone: 'warn',
      headline: '停止请求已发出，正在结算在途成员',
      detail: '不等待语音；degraded/pending 会在回执中醒目显示。',
      counts: null,
    };
  }
  const haltInfo = snapshot && snapshot.halt && typeof snapshot.halt === 'object'
    ? snapshot.halt
    : null;
  if (snapshot && !haltInfo) {
    return {
      tone: 'warn',
      headline: '停止不可用',
      detail: '当前引擎未启用停止守卫（haltGuard），不会伪造停止成功。',
      counts: null,
    };
  }
  const halt = classifyHaltReceipt(receipt);
  if (halt) {
    return { tone: halt.level, headline: halt.headline, detail: halt.detail, counts: halt.counts };
  }
  const resume = classifyResumeReceipt(receipt);
  if (resume) {
    return { tone: resume.level, headline: resume.headline, detail: resume.detail, counts: null };
  }
  if (haltInfo?.halted) {
    return {
      tone: 'warn',
      headline: '房间处于停止状态',
      detail: '没有可用的停止回执；解除后房间为 paused。',
      counts: null,
    };
  }
  return null;
}

class ApiError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const model = {
  token: null,
  snapshot: null,
  roomId: null,
  version: null,
  messages: new Map(),
  messageEls: new Map(),
  messagesDirty: true,
  thinking: new Map(),
  speaking: new Map(),
  activeTurn: null,
  activity: [],
  notices: [],
  connection: 'idle',
  reconnectAttempt: 0,
  nextRetryAt: 0,
  lastEventId: null,
  busy: new Set(),
  localRun: false,
  sending: false,
  haltBusy: null,
  haltPending: false,
  haltInEffect: false,
  haltReceipt: null,
  continueBusy: null,
  streamGeneration: 0,
  started: false,
  unauthorizedShown: false,
  mentions: new Set(),
  nominations: new Set(),
  targetSignature: '',
  memberQuery: '',
  compactMembers: false,
};

const deduper = createEventDeduper({ limit: 4000 });
const haltLock = createHaltRequestLock();
const continueLock = createSingleFlightLock();
let streamAbort = null;
let reconnectTimer = null;
let retryTicker = null;
let noticeSeq = 0;

const els = {};
let management = null;

function $(id) {
  return document.getElementById(id);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/* ── token：URL fragment → replaceState → sessionStorage ─────────────────── */

function extractHashToken() {
  const hash = window.location.hash;
  if (!hash || hash.length < 2) return null;
  const params = new URLSearchParams(hash.slice(1));
  if (!params.has('token')) return null;
  const token = params.get('token');
  return token && token.length > 0 ? token : null;
}

function bootstrapToken() {
  const fromHash = extractHashToken();
  const hadHash = window.location.hash.length > 0;
  if (hadHash) {
    // 先清除 fragment，再保存令牌，避免令牌停留在地址栏或历史记录里。
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  if (fromHash !== null) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromHash);
    } catch {
      // 隐私模式下 sessionStorage 可能不可用；本次会话仍可使用内存中的令牌。
    }
    return fromHash;
  }
  try {
    const stored = sessionStorage.getItem(TOKEN_KEY);
    return stored && stored.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

/* ── API ──────────────────────────────────────────────────────────────────── */

async function api(path, { method = 'GET', body, raw = false } = {}) {
  if (!model.token) {
    throw new ApiError('缺少访问令牌。', { status: 401, code: 'UNAUTHORIZED' });
  }
  const headers = {
    Authorization: `Bearer ${model.token}`,
    Accept: raw ? 'text/markdown, text/plain' : 'application/json',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    throw new ApiError('网络错误：无法连接本机服务。', { status: 0, code: 'NETWORK_ERROR' });
  }

  if (response.status === 401) {
    handleUnauthorized();
    throw new ApiError('令牌无效或已失效。', { status: 401, code: 'UNAUTHORIZED' });
  }

  if (!response.ok) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
    const message = typeof payload?.error?.message === 'string'
      ? payload.error.message
      : `请求失败（HTTP ${response.status}）。`;
    throw new ApiError(message, { status: response.status, code });
  }

  if (raw) return response;

  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('服务器返回了无法解析的数据。', { status: response.status, code: 'INVALID_JSON' });
  }
}

/* ── 快照与事件合并 ───────────────────────────────────────────────────────── */

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function applySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
  model.snapshot = snapshot;
  model.roomId = asString(snapshot.roomId) || model.roomId;

  const incomingIds = new Set();
  for (const message of asArray(snapshot.transcript)) {
    if (message && typeof message === 'object') {
      upsertMessage(message);
      incomingIds.add(asString(message.messageId) || asString(message.id));
    }
  }
  for (const messageId of model.messages.keys()) {
    if (!incomingIds.has(messageId)) model.messages.delete(messageId);
  }
  model.messagesDirty = true;

  model.thinking.clear();
  for (const attempt of asArray(snapshot.attempts)) {
    if (attempt && attempt.status === 'running' && typeof attempt.seatId === 'string') {
      model.thinking.set(attempt.seatId, attempt.attemptId ?? true);
    }
  }

  // 快照不含实时语音状态，重连后清除语音标记，避免显示过期字幕状态。
  model.speaking.clear();

  if (snapshot.room && typeof snapshot.room === 'object') {
    model.snapshot.room = snapshot.room;
  }

  model.haltInEffect = snapshot.halt?.halted === true;
  if (snapshot.lastHalt && typeof snapshot.lastHalt === 'object') {
    model.haltReceipt = snapshot.lastHalt;
  }
}

function sortedMessages() {
  return [...model.messages.values()].sort((left, right) => {
    const leftSeq = Number.isFinite(left.roomSeq) ? left.roomSeq : 0;
    const rightSeq = Number.isFinite(right.roomSeq) ? right.roomSeq : 0;
    if (leftSeq !== rightSeq) return leftSeq - rightSeq;
    return String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? ''));
  });
}

function upsertMessage(raw) {
  const messageId = asString(raw.messageId) || asString(raw.id);
  if (!messageId) return false;
  const existing = model.messages.get(messageId);
  const message = {
    messageId,
    roomId: asString(raw.roomId) || model.roomId,
    roomSeq: Number.isFinite(raw.roomSeq) ? raw.roomSeq : (existing?.roomSeq ?? 0),
    from: raw.from === 'owner' ? 'owner' : 'member',
    seatId: typeof raw.seatId === 'string' ? raw.seatId : (existing?.seatId ?? null),
    text: typeof raw.text === 'string' ? raw.text : (existing?.text ?? ''),
    mentions: asArray(raw.mentions).filter((entry) => typeof entry === 'string'),
    nominations: asArray(raw.nominations).filter((entry) => typeof entry === 'string'),
    replyTo: typeof raw.replyTo === 'string' ? raw.replyTo : null,
    attemptId: typeof raw.attemptId === 'string' ? raw.attemptId : (existing?.attemptId ?? null),
    createdAt: asString(raw.createdAt) || asString(raw.occurredAt) || existing?.createdAt || null,
  };
  model.messages.set(messageId, message);
  return existing === undefined;
}

function applyRoomEvent(event) {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const type = asString(event.type);
  const occurredAt = asString(event.occurredAt) || new Date().toISOString();

  if (model.snapshot?.room && Number.isFinite(event.roomSeq)) {
    model.snapshot.room = { ...model.snapshot.room, lastRoomSeq: event.roomSeq };
  }

  switch (type) {
    case 'MessagePosted': {
      const wasNew = upsertMessage({
        messageId: payload.messageId,
        roomId: event.roomId,
        roomSeq: payload.roomSeq ?? event.roomSeq,
        from: payload.from,
        seatId: payload.seatId ?? null,
        text: payload.text,
        mentions: payload.mentions,
        nominations: payload.nominations,
        replyTo: payload.replyTo,
        attemptId: payload.attemptId ?? null,
        occurredAt,
      });
      if (wasNew && payload.from === 'member' && typeof payload.seatId === 'string') {
        model.thinking.delete(payload.seatId);
      }
      if (wasNew && model.messagesDirty === false) {
        const latestSeq = [...model.messages.values()].reduce(
          (max, message) => Math.max(max, Number.isFinite(message.roomSeq) ? message.roomSeq : 0),
          0,
        );
        if (!Number.isFinite(payload.roomSeq) || payload.roomSeq < latestSeq) model.messagesDirty = true;
      }
      break;
    }
    case 'TurnRequested': {
      if (typeof payload.seatId === 'string') {
        model.activeTurn = {
          seatId: payload.seatId,
          attemptId: asString(payload.attemptId),
          reason: asString(payload.reason),
          mode: asString(payload.mode),
        };
      }
      break;
    }
    case 'MemberThinking': {
      if (typeof payload.seatId === 'string') {
        model.thinking.set(payload.seatId, payload.attemptId ?? true);
      }
      break;
    }
    case 'MemberResponded':
    case 'MemberPassed':
    case 'MemberFailed': {
      if (typeof payload.seatId === 'string') model.thinking.delete(payload.seatId);
      if (model.activeTurn && (!payload.attemptId || model.activeTurn.attemptId === payload.attemptId)) {
        model.activeTurn = null;
      }
      if (type === 'MemberFailed') {
        const code = asString(payload.error?.code) || 'MEMBER_FAILED';
        pushNotice(`${seatName(payload.seatId)} 失败：${code}`, 'error');
      }
      break;
    }
    case 'SpeechStarted': {
      if (typeof payload.seatId === 'string') {
        model.speaking.set(payload.seatId, payload.attemptId ?? true);
      }
      break;
    }
    case 'SpeechFinished':
    case 'SpeechFailed': {
      if (typeof payload.seatId === 'string') model.speaking.delete(payload.seatId);
      break;
    }
    case 'RoomStateChanged': {
      const to = asString(payload.to);
      const from = asString(payload.from);
      if (to && model.snapshot?.room) {
        model.snapshot.room = { ...model.snapshot.room, state: to, lastRoomSeq: event.roomSeq };
      }
      if (to === 'halted') model.haltInEffect = true;
      if (from === 'halted' && to === 'paused') {
        model.haltInEffect = false;
        model.haltPending = false;
        // 外部恢复不会自动 run；补一次快照以取得 guard 的 resume 回执。
        refreshSnapshot().catch((error) => reportError('同步停止状态失败', error));
      }
      if (to && to !== 'active') {
        model.activeTurn = null;
        model.thinking.clear();
        model.speaking.clear();
        if (model.snapshot) model.snapshot.running = false;
      }
      break;
    }
    case 'ReviewRequested': {
      model.activeTurn = null;
      model.thinking.clear();
      break;
    }
    case 'ResultConfirmed':
      model.activeTurn = null;
      break;
    case 'SettingsChanged':
    case 'SeatSessionChanged':
      model.targetSignature = '';
      model.messagesDirty = true;
      refreshSnapshot().catch((error) => reportError('同步房间设置失败', error));
      break;
    case 'CountersReset':
      refreshSnapshot().catch((error) => reportError('同步计数状态失败', error));
      break;
    case 'TranscriptCleared':
      model.messages.clear();
      model.messageEls.clear();
      model.messagesDirty = true;
      refreshSnapshot().catch((error) => reportError('同步清空后的记录失败', error));
      break;
    case 'HaltRequested': {
      const overlay = haltEventOverlay(event);
      if (overlay) model.haltPending = true;
      model.activeTurn = null;
      model.thinking.clear();
      model.speaking.clear();
      if (model.snapshot) model.snapshot.running = false;
      break;
    }
    case 'HaltSettled': {
      const overlay = haltEventOverlay(event);
      if (overlay) {
        model.haltPending = false;
        model.haltReceipt = overlay.receipt;
        model.haltInEffect = overlay.halted === true;
        if (model.snapshot) {
          model.snapshot.lastHalt = {
            ...(model.snapshot.lastHalt && typeof model.snapshot.lastHalt === 'object'
              ? model.snapshot.lastHalt
              : {}),
            ...overlay.receipt,
          };
          if (model.snapshot.halt && typeof model.snapshot.halt === 'object') {
            // halt.snapshot 的 aborted 是布尔信号，回执里的 aborted 是计数，不能混写。
            model.snapshot.halt = {
              ...model.snapshot.halt,
              halted: overlay.halted === true,
              mode: 'halt',
            };
          }
        }
        refreshSnapshot().catch((error) => reportError('同步停止状态失败', error));
      }
      model.activeTurn = null;
      model.thinking.clear();
      model.speaking.clear();
      if (model.snapshot) model.snapshot.running = false;
      break;
    }
    default:
      break;
  }

  pushActivity(event, type);
}

function handleEnvelope(envelope) {
  let payload;
  try {
    payload = JSON.parse(envelope.data);
  } catch {
    pushNotice('收到无法解析的事件数据，已忽略。', 'warn');
    return false;
  }

  if (envelope.event === 'snapshot') {
    applySnapshot(payload);
    render();
    return true;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const eventId = asString(payload.eventId) || asString(envelope.id);
  if (!eventId) return false;
  if (!deduper.accept(eventId)) return false;
  model.lastEventId = eventId;

  try {
    applyRoomEvent(payload);
  } catch {
    pushNotice('应用房间事件时出错，界面可能暂时不同步。', 'warn');
    return false;
  }
  render();
  return true;
}

/* ── SSE 连接与退避重连 ───────────────────────────────────────────────────── */

function stopStream() {
  model.streamGeneration += 1;
  if (streamAbort) {
    streamAbort.abort();
    streamAbort = null;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (retryTicker !== null) {
    clearInterval(retryTicker);
    retryTicker = null;
  }
}

function startRetryTicker() {
  if (retryTicker !== null) return;
  retryTicker = setInterval(() => {
    if (model.connection !== 'retrying') {
      clearInterval(retryTicker);
      retryTicker = null;
      return;
    }
    renderConnection();
  }, 1000);
}

async function connectEvents() {
  if (!model.token) return;
  const generation = ++model.streamGeneration;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const controller = new AbortController();
  streamAbort = controller;
  model.connection = model.reconnectAttempt > 0 ? 'retrying' : 'connecting';
  renderConnection();

  const headers = {
    Authorization: `Bearer ${model.token}`,
    Accept: 'text/event-stream',
    'Cache-Control': 'no-store',
  };
  if (model.lastEventId) headers['Last-Event-ID'] = model.lastEventId;

  let opened = false;
  let status = 0;
  let failure = null;

  try {
    const response = await fetch('/api/events', {
      headers,
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    });
    status = response.status;

    if (status === 401) {
      handleUnauthorized();
      return;
    }
    if (!response.ok) {
      failure = `事件流请求失败（HTTP ${status}）。`;
    } else if (!response.body) {
      failure = '当前浏览器不支持读取事件流。';
    } else {
      opened = true;
      model.connection = 'live';
      model.reconnectAttempt = 0;
      clearNotice('stream');
      renderConnection();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser({
        onEvent: (envelope) => {
          if (generation !== model.streamGeneration) return;
          if (handleEnvelope(envelope)) model.reconnectAttempt = 0;
        },
      });

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.end();
      if (generation !== model.streamGeneration) return;
      failure = '事件流已断开。';
    }
  } catch (error) {
    if (generation !== model.streamGeneration) return;
    if (error?.name === 'AbortError') return;
    failure = '事件流网络错误。';
  }

  if (generation !== model.streamGeneration) return;
  streamAbort = null;

  const reconnecting = opened || shouldReconnect(status);
  if (!reconnecting) {
    model.connection = 'error';
    setNotice('stream', `${failure ?? '事件流无法连接。'} 不会自动重连。`, 'error');
    render();
    return;
  }

  model.connection = 'retrying';
  if (!opened) model.reconnectAttempt += 1;
  const delay = retryDelay(opened ? 0 : model.reconnectAttempt - 1, {
    baseMs: 800,
    maxMs: 15000,
    jitter: 0.25,
  });
  model.nextRetryAt = Date.now() + delay;
  setNotice(
    'stream',
    `${failure ?? '事件流已断开。'} ${Math.round(delay / 1000)} 秒后重连（第 ${model.reconnectAttempt || 1} 次）。`,
    'warn',
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectEvents();
  }, delay);
  startRetryTicker();
  render();
}

function handleUnauthorized() {
  if (model.unauthorizedShown) return;
  model.unauthorizedShown = true;
  try {
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // 忽略存储不可用。
  }
  model.token = null;
  stopStream();
  model.connection = 'idle';
  showGate('令牌无效或已失效，请重新输入。');
}

/* ── 提示与活动 ───────────────────────────────────────────────────────────── */

function setNotice(key, message, tone = 'warn') {
  const existing = model.notices.find((notice) => notice.key === key);
  if (existing) {
    existing.message = message;
    existing.tone = tone;
  } else {
    model.notices.push({ id: ++noticeSeq, key, message, tone });
  }
  if (model.notices.length > 4) model.notices.shift();
  renderNotices();
}

function clearNotice(key) {
  const next = model.notices.filter((notice) => notice.key !== key);
  if (next.length === model.notices.length) return;
  model.notices = next;
  renderNotices();
}

function pushNotice(message, tone = 'error') {
  model.notices.push({ id: ++noticeSeq, key: null, message, tone });
  while (model.notices.length > 4) model.notices.shift();
  renderNotices();
}

function reportError(prefix, error) {
  if (error instanceof ApiError && error.status === 401) return;
  const detail = error instanceof Error ? error.message : String(error);
  pushNotice(`${prefix}：${detail}`, 'error');
}

function renderNotices() {
  if (!els.notices) return;
  els.notices.hidden = model.notices.length === 0;
  els.notices.replaceChildren();
  for (const notice of model.notices) {
    const row = el('div', 'notice');
    row.dataset.tone = notice.tone;
    row.append(el('span', 'notice-text', notice.message));
    const dismiss = el('button', 'notice-close', '关闭');
    dismiss.type = 'button';
    dismiss.setAttribute('aria-label', '关闭提示');
    dismiss.addEventListener('click', () => {
      model.notices = model.notices.filter((entry) => entry.id !== notice.id);
      renderNotices();
    });
    row.append(dismiss);
    els.notices.append(row);
  }
}

function pushActivity(event, type) {
  const seatId = asString(event.payload?.seatId);
  const payload = event.payload ?? {};
  let description;
  switch (type) {
    case 'RoomStateChanged':
      description = `房间 ${ROOM_STATE_LABELS[payload.from] ?? payload.from ?? '?'} → ${ROOM_STATE_LABELS[payload.to] ?? payload.to ?? '?'}`;
      break;
    case 'MessagePosted':
      description = `${payload.from === 'owner' ? '机主' : seatName(payload.seatId)} 发言`;
      break;
    case 'TurnRequested':
      description = `调度 ${seatName(seatId)}（${asString(payload.reason) || '—'}）`;
      break;
    case 'MemberThinking':
      description = `${seatName(seatId)} 开始思考`;
      break;
    case 'MemberResponded':
      description = `${seatName(seatId)} 回答`;
      break;
    case 'MemberPassed':
      description = `${seatName(seatId)} PASS`;
      break;
    case 'MemberFailed':
      description = `${seatName(seatId)} 失败：${asString(payload.error?.code) || '—'}`;
      break;
    case 'SpeechStarted':
      description = `${seatName(seatId)} 开始语音`;
      break;
    case 'SpeechFinished':
      description = `${seatName(seatId)} 语音结束`;
      break;
    case 'SpeechFailed':
      description = `${seatName(seatId)} 语音失败`;
      break;
    case 'ReviewRequested':
      description = `请求 review（${asString(payload.reason) || '—'}）`;
      break;
    case 'ResultConfirmed':
      description = '结果已确认';
      break;
    case 'HaltRequested':
      description = '请求停止';
      break;
    case 'HaltSettled':
      description = '停止完成';
      break;
    default:
      description = type || '事件';
      break;
  }
  model.activity.push({
    id: asString(event.eventId),
    at: asString(event.occurredAt),
    description,
    actor: asString(event.actor),
  });
  while (model.activity.length > MAX_ACTIVITY) model.activity.shift();
}

/* ── 渲染：顶部状态与按钮 ─────────────────────────────────────────────────── */

function roomState() {
  const state = model.snapshot?.room?.state;
  return typeof state === 'string' ? state : null;
}

function seatProfile(seatId) {
  return asArray(model.snapshot?.settings?.seats).find((seat) => seat?.seatId === seatId) ?? null;
}

function seatName(seatId) {
  if (!seatId) return '成员';
  return seatProfile(seatId)?.displayName ?? SEAT_LABELS[seatId] ?? seatId;
}

function ownerName() {
  return model.snapshot?.settings?.ownerName ?? '机主';
}

function seatColor(seatId) {
  return seatProfile(seatId)?.color ?? '#8c9aab';
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function renderHeader() {
  const state = roomState();
  els.roomState.textContent = ROOM_STATE_LABELS[state] ?? state ?? '未就绪';
  els.roomState.dataset.state = state ?? 'unknown';
  els.roomId.textContent = model.roomId ?? '—';
  els.changelogLink.textContent = model.version ? `v${model.version}` : 'v…';

  const seq = model.snapshot?.room?.lastRoomSeq;
  const running = model.snapshot?.running === true || model.localRun;
  const parts = [`seq ${Number.isFinite(seq) ? seq : '—'}`];
  if (model.snapshot?.initialized === false) parts.push('引擎未初始化');
  if (running) parts.push('运行中');
  els.roomMeta.textContent = parts.join(' · ');
}

function renderConnection() {
  if (!els.conn) return;
  const text = {
    idle: '未连接',
    connecting: '连接中…',
    live: '实时连接',
    error: '连接失败',
    retrying: '重连中',
  }[model.connection] ?? '未连接';

  let detail = text;
  if (model.connection === 'retrying') {
    const seconds = Math.max(0, Math.ceil((model.nextRetryAt - Date.now()) / 1000));
    detail = `${text} · ${seconds}s`;
  }
  els.conn.dataset.tone = model.connection;
  els.connText.textContent = detail;
  els.conn.title = model.connection === 'live' ? 'SSE 已连接' : detail;
}

function actionAllowed(action) {
  const state = roomState();
  if (!model.snapshot) return false;
  if (action === 'activate') return state === 'draft' && !model.busy.has('activate');
  if (action === 'pause') return state === 'active' && !model.busy.has('pause');
  if (action === 'resume') return state === 'paused' && !model.busy.has('resume');
  if (action === 'review') {
    return (state === 'active' || state === 'paused') && !model.busy.has('review') && !model.localRun;
  }
  if (action === 'confirm') return state === 'review' && !model.busy.has('confirm');
  if (action === 'run') {
    if (runBlockedByHalt({
      roomState: state,
      haltBusy: model.haltBusy,
      haltPending: model.haltPending,
      haltInEffect: model.haltInEffect,
    })) return false;
    if (model.localRun || model.busy.has('run')) return false;
    if (model.snapshot.running) return false;
    if (model.snapshot.schedule?.awaiting) return false;
    if (model.activeTurn) return false;
    return true;
  }
  if (action === 'send') {
    if (model.sending) return false;
    if (!SENDABLE_STATES.has(state)) return false;
    return Boolean(els.input.value.trim());
  }
  return false;
}

function renderControls() {
  const reasons = {
    activate: '仅 draft 状态可激活',
    run: '仅 active 且没有进行中的回合可开始闲聊',
    pause: '仅 active 状态可暂停',
    resume: '仅 paused 状态可继续',
    review: '仅 active/paused 状态可请求 review',
    confirm: '仅 review 状态可确认结果',
    send: '当前状态或输入不允许发送',
  };
  for (const button of els.app.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    if (!(action in reasons)) continue;
    const allowed = actionAllowed(action);
    button.disabled = !allowed;
    if (allowed) button.removeAttribute('title');
    else if (action === 'run' && model.haltBusy) button.title = '正在停止，禁止开始 run';
    else if (action === 'run' && (model.haltPending || model.haltInEffect)) button.title = '房间已停止，禁止开始 run';
    else if (action === 'run' && model.snapshot?.running) button.title = '引擎正在运行';
    else if (action === 'run' && model.activeTurn) button.title = `${seatName(model.activeTurn.seatId)} 回合进行中`;
    else button.title = reasons[action];
  }

  if (els.haltButton) {
    const haltView = haltControlView({ snapshot: model.snapshot, busy: model.haltBusy });
    els.haltButton.textContent = haltView.label;
    els.haltButton.disabled = haltView.disabled;
    els.haltButton.dataset.mode = haltView.mode;
    els.haltButton.title = haltView.reason;
  }

  if (els.continueReviewButton) {
    const continueView = reviewContinueView({
      snapshot: model.snapshot,
      busy: model.continueBusy,
    });
    els.continueReviewButton.hidden = !continueView.visible;
    els.continueReviewButton.disabled = continueView.disabled;
    els.continueReviewButton.textContent = continueView.label;
    els.continueReviewButton.title = continueView.reason;
  }

  const canType = Boolean(model.snapshot) && SENDABLE_STATES.has(roomState()) && !model.snapshot?.closed;
  els.input.disabled = !canType;
  els.input.placeholder = `以${ownerName()}身份发言…`;
  els.composer.querySelectorAll('input[type="checkbox"]').forEach((box) => {
    box.disabled = !canType;
  });
}

/* ── 渲染：成员 ───────────────────────────────────────────────────────────── */

function bridgeFor(seatId) {
  return asArray(model.snapshot?.bridges).find((bridge) => bridge?.seatId === seatId) ?? null;
}

function scheduleSeat(seatId) {
  return asArray(model.snapshot?.schedule?.seats).find((seat) => seat?.seatId === seatId) ?? null;
}

function memberState(seatId) {
  const bridge = bridgeFor(seatId);
  if (bridge?.closed) return { label: '已关闭', tone: 'bad' };
  if (bridge?.lastError && !bridge.connected) return { label: '连接错误', tone: 'bad' };
  if (bridge && bridge.connected === false) return { label: '未连接', tone: 'warn' };
  if (roomState() === 'halted') return { label: '已停止', tone: 'bad' };
  if (model.speaking.has(seatId)) return { label: '语音中', tone: 'live' };
  if (model.thinking.has(seatId)) return { label: '思考中', tone: 'busy' };
  if (model.activeTurn?.seatId === seatId) return { label: '思考中', tone: 'busy' };
  if (model.snapshot?.schedule?.awaiting?.seatId === seatId) return { label: '等待回应', tone: 'busy' };
  const status = scheduleSeat(seatId)?.status;
  if (typeof status === 'string' && status !== 'idle') {
    return { label: SEAT_STATUS_LABELS[status] ?? status, tone: status === 'error' ? 'bad' : 'warn' };
  }
  return { label: '待命', tone: 'idle' };
}

function seatCounts(seatId) {
  const stats = scheduleSeat(seatId)?.stats ?? {};
  return {
    attempts: (stats.completed ?? 0) + (stats.pass ?? 0) + (stats.failed ?? 0) + (stats.aborted ?? 0),
    completed: stats.completed ?? 0,
    failed: stats.failed ?? 0,
  };
}

function renderMembers() {
  const allSeats = [...new Set([
    ...asArray(model.snapshot?.settings?.seatOrder),
    ...asArray(model.snapshot?.schedule?.seats).map((seat) => seat?.seatId).filter(Boolean),
    ...asArray(model.snapshot?.bridges).map((bridge) => bridge?.seatId).filter(Boolean),
    ...SEAT_ORDER,
  ])];
  const query = model.memberQuery.trim().toLowerCase();
  const seats = allSeats.filter((seatId) => {
    if (!query) return true;
    const bridge = bridgeFor(seatId);
    return `${seatName(seatId)} ${seatId} ${modelLabel(bridge)}`.toLowerCase().includes(query);
  });
  els.memberCount.textContent = String(allSeats.length);
  els.memberFilterCount.textContent = query ? `${seats.length}/${allSeats.length}` : '';
  els.memberCompact.textContent = model.compactMembers ? '完整视图' : '紧凑视图';
  const compact = model.compactMembers || allSeats.length > 6;

  const fragment = document.createDocumentFragment();
  for (const seatId of seats) {
    const card = el('article', `member-card seat-${seatId}`);
    if (compact) card.classList.add('compact');
    card.style.setProperty('--seat-color', seatColor(seatId));
    const bridge = bridgeFor(seatId);
    const state = memberState(seatId);
    const counts = seatCounts(seatId);

    const head = el('div', 'member-head');
    head.append(el('span', 'seat-name', seatName(seatId)));
    head.append(el('span', 'seat-id', seatId));
    card.append(head);

    const statusRow = el('div', `member-state tone-${state.tone}`);
    const dot = el('span', 'dot');
    dot.setAttribute('aria-hidden', 'true');
    statusRow.append(dot, el('span', 'state-label', state.label));
    card.append(statusRow);

    const meta = el('div', 'member-meta');
    const connected = bridge ? (bridge.connected ? '已连接' : '未连接') : '未知';
    meta.append(el('span', 'chip', connected));
    meta.append(el('span', 'chip', `已发言 ${counts.completed}`));
    meta.append(el('span', 'chip', `尝试 ${counts.attempts}`));
    if (counts.failed > 0) meta.append(el('span', 'chip chip-bad', `失败 ${counts.failed}`));
    card.append(meta);

    const modelName = el('div', 'member-model', modelLabel(bridge));
    modelName.title = bridge?.identityError || modelLabel(bridge);
    card.append(modelName);
    const sessionActions = el('div', 'member-session-actions');
    const sessionRef = bridge?.identity?.nativeSessionRef;
    const sessionLabel = el('span', 'member-session-ref', shortSessionRef(sessionRef));
    if (sessionRef) sessionLabel.title = sessionRef;
    const newSession = el('button', 'compact-button', '新会话');
    newSession.type = 'button';
    newSession.dataset.newSession = seatId;
    newSession.disabled = Boolean(model.snapshot?.running || model.snapshot?.schedule?.awaiting);
    newSession.title = '创建并切换到新的原生会话；旧会话保留，不自动开始聊天';
    sessionActions.append(sessionLabel, newSession);
    card.append(sessionActions);

    if (model.snapshot?.schedule?.awaiting?.seatId === seatId && roomState() !== 'halted') {
      card.append(el('div', 'member-note', '本轮轮到该成员'));
    }
    if (bridge?.lastError) {
      const error = bridge.lastError;
      const text = typeof error === 'string'
        ? error
        : asString(error.message) || asString(error.code) || '未知错误';
      const note = el('div', 'member-error', text);
      note.title = text;
      card.append(note);
    }
    fragment.append(card);
  }
  els.memberList.replaceChildren(fragment);
}

/* ── 渲染：消息流 ─────────────────────────────────────────────────────────── */

function isNearBottom() {
  const node = els.messages;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function scrollToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function buildMessageNode(message) {
  const article = el('article', 'message');
  article.dataset.from = message.from;
  if (message.seatId) {
    article.dataset.seat = message.seatId;
    article.style.setProperty('--seat-color', seatColor(message.seatId));
  }

  const header = el('header', 'message-head');
  const author = el('span', 'message-author', message.from === 'owner' ? ownerName() : seatName(message.seatId));
  if (message.from === 'member' && message.seatId) {
    author.append(el('span', 'message-seat', message.seatId));
  }
  header.append(author);

  const time = el('time', 'message-time', formatTime(message.createdAt));
  if (message.createdAt) time.dateTime = message.createdAt;
  header.append(time);

  if (Number.isFinite(message.roomSeq)) header.append(el('span', 'message-seq', `#${message.roomSeq}`));
  article.append(header);

  article.append(el('div', 'message-body', message.text));

  const tags = el('div', 'message-tags');
  for (const mention of message.mentions) {
    tags.append(el('span', 'tag tag-mention', `@${seatName(mention)}`));
  }
  for (const nomination of message.nominations) {
    tags.append(el('span', 'tag tag-nomination', `提名 ${seatName(nomination)}`));
  }
  if (tags.childElementCount > 0) article.append(tags);
  return article;
}

function updateMessageNode(node, message) {
  const body = node.querySelector('.message-body');
  if (body && body.textContent !== message.text) body.textContent = message.text;
  const author = node.querySelector('.message-author');
  if (author) {
    const label = message.from === 'owner' ? ownerName() : seatName(message.seatId);
    if (author.firstChild) author.firstChild.textContent = label;
  }
  if (message.seatId) node.style.setProperty('--seat-color', seatColor(message.seatId));
  const time = node.querySelector('.message-time');
  if (time) {
    const label = formatTime(message.createdAt);
    if (time.textContent !== label) time.textContent = label;
  }
}

function syncMessages() {
  const list = sortedMessages();
  const atBottom = isNearBottom();
  const stale = [...model.messageEls.keys()].some((id) => !model.messages.has(id));
  if (model.messagesDirty || stale) {
    els.messages.replaceChildren();
    model.messageEls.clear();
    model.messagesDirty = false;
  }

  let lastSeq = 0;
  for (const message of list) {
    let node = model.messageEls.get(message.messageId);
    if (!node) {
      const seq = Number.isFinite(message.roomSeq) ? message.roomSeq : 0;
      if (seq > 0 && seq < lastSeq) {
        // 收到乱序补发的消息时整体重建，保证时间线顺序。
        els.messages.replaceChildren();
        model.messageEls.clear();
        model.messagesDirty = false;
        rebuildAllMessages(list);
        els.messageCount.textContent = `${list.length} 条`;
        if (atBottom) scrollToBottom();
        return;
      }
      node = buildMessageNode(message);
      model.messageEls.set(message.messageId, node);
      els.messages.append(node);
    } else {
      updateMessageNode(node, message);
    }
    if (Number.isFinite(message.roomSeq)) lastSeq = Math.max(lastSeq, message.roomSeq);
  }

  els.messageCount.textContent = `${list.length} 条`;
  if (atBottom) scrollToBottom();
}

function rebuildAllMessages(list) {
  for (const message of list) {
    const node = buildMessageNode(message);
    model.messageEls.set(message.messageId, node);
    els.messages.append(node);
  }
}

/* ── 渲染：输入目标 ───────────────────────────────────────────────────────── */

function targetSeats() {
  return [...new Set([
    ...asArray(model.snapshot?.settings?.seatOrder),
    ...asArray(model.snapshot?.schedule?.seats).map((seat) => seat?.seatId).filter(Boolean),
    ...asArray(model.snapshot?.bridges).map((bridge) => bridge?.seatId).filter(Boolean),
    ...SEAT_ORDER,
  ])];
}

function buildTargetOptions(container, set) {
  const fragment = document.createDocumentFragment();
  for (const seatId of targetSeats()) {
    const label = el('label', 'target-chip');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = seatId;
    box.checked = set.has(seatId);
    box.addEventListener('change', () => {
      if (box.checked) set.add(seatId);
      else set.delete(seatId);
      renderControls();
    });
    label.append(box, el('span', '', seatName(seatId)));
    fragment.append(label);
  }
  container.replaceChildren(fragment);
}

function renderTargets() {
  const seats = targetSeats();
  const signature = seats.map((seatId) => `${seatId}:${seatName(seatId)}`).join('|');
  if (signature === model.targetSignature) return;
  model.targetSignature = signature;
  buildTargetOptions(els.mentionOptions, model.mentions);
  buildTargetOptions(els.nominationOptions, model.nominations);
}

/* ── 渲染：排程与活动 ─────────────────────────────────────────────────────── */

function factRow(term, value) {
  const dt = el('dt', '', term);
  const dd = el('dd', '', value);
  return [dt, dd];
}

function renderSchedule() {
  const schedule = model.snapshot?.schedule ?? null;
  els.scheduleMode.textContent = schedule
    ? ({ casual: '闲聊', addressed: '点名', manual: '手动' }[schedule.mode] ?? schedule.mode)
    : '—';

  const facts = [];
  if (!schedule) {
    facts.push(factRow('状态', '排程尚未创建'));
  } else {
    const waiting = schedule.awaiting?.seatId;
    const running = model.snapshot?.running === true || model.localRun;
    let status = '就绪';
    if (schedule.ended) status = '本轮已结束';
    else if (waiting) status = `等待 ${seatName(waiting)}`;
    else if (running) status = '运行中';
    facts.push(factRow('状态', status));
    facts.push(factRow('轮次', String(schedule.round ?? '—')));
    facts.push(factRow(
      '尝试',
      schedule.maxAttempts === null || schedule.maxAttempts === undefined
        ? String(schedule.attemptsUsed ?? 0)
        : `${schedule.attemptsUsed ?? 0} / ${schedule.maxAttempts}`,
    ));
    const stats = schedule.stats ?? {};
    facts.push(factRow(
      '结果',
      `完成 ${stats.completed ?? 0} · PASS ${stats.pass ?? 0} · 失败 ${stats.failed ?? 0} · 中止 ${stats.aborted ?? 0}`,
    ));
    facts.push(factRow('selectionSeq', String(schedule.selectionSeq ?? 0)));
  }
  const frag = document.createDocumentFragment();
  for (const [dt, dd] of facts) frag.append(dt, dd);
  els.scheduleFacts.replaceChildren(frag);

  if (schedule) {
    const queue = el('div', 'queue-list');
    queue.append(el('span', 'queue-item', `机主点名 ${schedule.ownerPriority?.length ?? 0}`));
    queue.append(el('span', 'queue-item', `直达队列 ${schedule.directQueue?.length ?? 0}`));
    queue.append(el('span', 'queue-item', `手动队列 ${schedule.manualQueue?.length ?? 0}`));
    els.queueFacts.replaceChildren(queue);
  } else {
    els.queueFacts.replaceChildren();
  }
}

function renderActivity() {
  const items = [...model.activity].reverse();
  if (items.length === 0) {
    els.activity.replaceChildren(el('li', 'activity-empty', '暂无实时事件'));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of items) {
    const row = el('li', 'activity-item');
    row.append(el('time', 'activity-time', formatTime(entry.at)));
    row.append(el('span', 'activity-text', entry.description));
    fragment.append(row);
  }
  els.activity.replaceChildren(fragment);
}

function renderHaltStatus() {
  if (!els.haltStatus) return;
  const fallback = model.snapshot?.lastHalt && typeof model.snapshot.lastHalt === 'object'
    ? model.snapshot.lastHalt
    : null;
  const view = haltBannerView({
    snapshot: model.snapshot,
    receipt: model.haltReceipt ?? fallback,
    pending: model.haltPending,
  });
  if (!view) {
    els.haltStatus.hidden = true;
    els.haltStatus.replaceChildren();
    return;
  }

  els.haltStatus.hidden = false;
  els.haltStatus.dataset.tone = view.tone;
  const fragment = document.createDocumentFragment();
  fragment.append(el('span', 'halt-status-headline', view.headline));

  if (view.counts) {
    const counts = el('span', 'halt-counts');
    const entries = [
      ['aborted', view.counts.aborted],
      ['degraded', view.counts.degraded],
      ['pending', view.counts.pending],
      ['fullySettled', view.counts.fullySettled ? '是' : '否'],
    ];
    for (const [label, value] of entries) {
      const chip = el('span', 'halt-count');
      chip.append(document.createTextNode(`${label} `));
      chip.append(el('strong', '', String(value)));
      counts.append(chip);
    }
    fragment.append(counts);
  } else if (view.detail) {
    fragment.append(el('span', 'halt-status-detail', view.detail));
  }

  els.haltStatus.replaceChildren(fragment);
}

function renderHaltGuard() {
  if (!els.haltFacts) return;
  const halt = model.snapshot?.halt && typeof model.snapshot.halt === 'object'
    ? model.snapshot.halt
    : null;
  els.haltMode.textContent = !model.snapshot ? '—' : (halt ? (halt.mode ?? 'idle') : '未启用');

  const facts = [];
  if (!model.snapshot) {
    facts.push(factRow('状态', '等待快照'));
  } else if (!halt) {
    facts.push(factRow('守卫', '未启用'));
    facts.push(factRow('说明', 'haltGuard 缺失，不能停止'));
  } else {
    let status = '可派发';
    if (halt.halted) status = '已停止';
    else if (halt.paused) status = '已暂停';
    else if (halt.dispatchable === false) status = '不可派发';
    facts.push(factRow('守卫', '已启用'));
    facts.push(factRow('房间', ROOM_STATE_LABELS[model.snapshot.room?.state] ?? model.snapshot.room?.state ?? '—'));
    facts.push(factRow('guard 状态', status));
    facts.push(factRow('halted', halt.halted ? '是' : '否'));
    facts.push(factRow('paused', halt.paused ? '是' : '否'));
    facts.push(factRow('global / room', `${halt.globalHalted ? '已停止' : '正常'} / ${halt.roomHalted ? '已停止' : '正常'}`));
    facts.push(factRow('在途', String(halt.inFlight ?? 0)));
  }
  const frag = document.createDocumentFragment();
  for (const [dt, dd] of facts) frag.append(dt, dd);
  els.haltFacts.replaceChildren(frag);

  if (halt) {
    const list = el('div', 'queue-list');
    const attempts = Array.isArray(halt.attempts) ? halt.attempts : [];
    if (attempts.length === 0) {
      list.append(el('span', 'queue-item', '无在途 attempt'));
    } else {
      for (const attempt of attempts) {
        const seatId = typeof attempt.seatId === 'string' ? attempt.seatId : '?';
        const status = typeof attempt.status === 'string' ? attempt.status : '?';
        list.append(el('span', 'queue-item', `${seatName(seatId)} · ${status}`));
      }
    }
    els.haltAttempts.replaceChildren(list);
  } else {
    els.haltAttempts.replaceChildren();
  }
}

/* ── 总渲染 ───────────────────────────────────────────────────────────────── */

function render() {
  if (!model.started) return;
  renderHeader();
  renderConnection();
  renderMembers();
  renderTargets();
  renderSchedule();
  renderHaltStatus();
  renderHaltGuard();
  renderActivity();
  syncMessages();
  renderControls();
}

/* ── 机主操作 ─────────────────────────────────────────────────────────────── */

async function refreshSnapshot() {
  const snapshot = await api('/api/room');
  applySnapshot(snapshot);
  render();
}

async function loadVersion() {
  try {
    const health = await api('/api/health');
    if (typeof health?.version === 'string') model.version = health.version;
    renderHeader();
  } catch {
    // 版本展示失败不阻断聊天室。
  }
}

async function performTransition(action, path, label) {
  if (!actionAllowed(action)) return;
  model.busy.add(action);
  renderControls();
  try {
    const result = await api(path, { method: 'POST' });
    if (result && result.changed === false) pushNotice(`${label}：状态未变化。`, 'info');
    await refreshSnapshot();
  } catch (error) {
    reportError(`${label}失败`, error);
  } finally {
    model.busy.delete(action);
    renderControls();
  }
}

async function performRun() {
  if (!actionAllowed('run')) return;
  model.busy.add('run');
  model.localRun = true;
  renderControls();
  try {
    const result = await api('/api/run', { method: 'POST' });
    if (result && result.ran === false) {
      const reason = result.reason === 'room-not-active' ? '房间不在 active 状态' : asString(result.reason) || '未开始';
      pushNotice(`开始闲聊：${reason}。`, 'info');
    }
    await refreshSnapshot();
  } catch (error) {
    reportError('开始闲聊失败', error);
  } finally {
    model.localRun = false;
    model.activeTurn = null;
    model.busy.delete('run');
    renderControls();
  }
}

async function requestHaltToggle() {
  if (model.haltBusy !== null) return;
  const view = haltControlView({ snapshot: model.snapshot, busy: model.haltBusy });
  if (view.unavailable) {
    if (model.snapshot) {
      pushNotice('停止不可用：当前引擎未启用停止守卫（haltGuard）。', 'error');
    }
    return;
  }
  if (view.disabled) return;

  const kind = view.mode;
  if (!haltLock.begin(kind)) return;
  model.haltBusy = kind;
  model.haltPending = true;
  render();

  try {
    const path = kind === 'halt' ? '/api/halt' : '/api/halt/resume';
    const body = kind === 'halt' ? { scope: 'room', mode: 'halt' } : { scope: 'room' };
    const receipt = await api(path, { method: 'POST', body });
    if (receipt && typeof receipt === 'object') {
      model.haltReceipt = receipt;
      model.haltInEffect = receipt.halted === true;
      if (typeof receipt.roomState === 'string' && model.snapshot?.room) {
        model.snapshot.room = { ...model.snapshot.room, state: receipt.roomState };
      }
    }
    model.haltPending = false;
    try {
      await refreshSnapshot();
    } catch (error) {
      reportError('同步停止状态失败', error);
    }
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'HALT_UNAVAILABLE' || error.status === 501)) {
      pushNotice('停止不可用：当前引擎未启用停止守卫（haltGuard），未执行任何停止动作。', 'error');
    } else {
      reportError(kind === 'halt' ? '停止失败' : '解除停止失败', error);
    }
  } finally {
    model.haltBusy = null;
    model.haltPending = false;
    haltLock.end(kind);
    render();
  }
}

async function continueReviewThenRun() {
  if (model.continueBusy !== null) return;
  const view = reviewContinueView({ snapshot: model.snapshot, busy: model.continueBusy });
  if (!view.visible || view.disabled) return;

  model.continueBusy = 'continue';
  render();

  try {
    const result = await performReviewContinue({
      lock: continueLock,
      postContinue: () => api('/api/continue', { method: 'POST' }),
      postRun: () => api('/api/run', { method: 'POST' }),
      onPhase: (phase) => {
        model.continueBusy = phase;
        if (phase === 'run') model.localRun = true;
        render();
      },
    });
    if (!result.started) return;

    if (result.error) {
      if (result.phase === 'run') {
        reportError('开始闲聊失败', result.error);
        // continue 已成功并重置了排程；即使 run 失败，也要把新快照同步回来。
        try {
          await refreshSnapshot();
        } catch (error) {
          reportError('同步房间状态失败', error);
        }
      } else if (result.error instanceof ApiError
        && (result.error.code === 'CONTINUE_UNAVAILABLE' || result.error.status === 501)) {
        pushNotice('再聊一轮不可用：当前引擎未提供 continueRound。', 'error');
      } else {
        reportError('再聊一轮失败', result.error);
      }
      return;
    }

    if (result.runResult && result.runResult.ran === false) {
      const reason = result.runResult.reason === 'room-not-active'
        ? '房间不在 active 状态'
        : asString(result.runResult.reason) || '未开始';
      pushNotice(`开始闲聊：${reason}。`, 'info');
    }
    try {
      await refreshSnapshot();
    } catch (error) {
      reportError('同步房间状态失败', error);
    }
  } finally {
    model.continueBusy = null;
    model.localRun = false;
    render();
  }
}

async function sendOwnerMessage() {
  if (model.sending) return;
  const text = els.input.value.trim();
  if (text.length === 0) {
    pushNotice('消息不能为空。', 'warn');
    els.input.focus();
    return;
  }
  if (!SENDABLE_STATES.has(roomState())) return;

  const mentions = [...model.mentions].filter((seatId) => targetSeats().includes(seatId));
  const nominations = [...model.nominations].filter((seatId) => targetSeats().includes(seatId));

  model.sending = true;
  renderControls();
  try {
    await api('/api/messages', { method: 'POST', body: { text, mentions, nominations } });
    els.input.value = '';
    model.mentions.clear();
    model.nominations.clear();
    model.targetSignature = '';
    renderTargets();
    await refreshSnapshot();
    els.input.focus();
  } catch (error) {
    reportError('发送失败', error);
  } finally {
    model.sending = false;
    renderControls();
  }
}

async function exportMarkdown(event) {
  event.preventDefault();
  try {
    const response = await api('/api/export.md', { raw: true });
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    link.href = url;
    link.download = `ai-room-${model.roomId ?? 'room'}-${stamp}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (error) {
    reportError('导出失败', error);
  }
}

/* ── 令牌界面 ─────────────────────────────────────────────────────────────── */

function showGate(message) {
  model.started = false;
  els.gate.hidden = false;
  els.app.hidden = true;
  if (message) {
    els.tokenError.textContent = message;
    els.tokenError.hidden = false;
  } else {
    els.tokenError.hidden = true;
  }
  els.tokenInput.focus();
}

function hideGate() {
  els.gate.hidden = true;
  els.app.hidden = false;
}

function start() {
  hideGate();
  model.started = true;
  render();
  loadVersion();
  connectEvents();
  refreshSnapshot().catch((error) => reportError('读取房间快照失败', error));
}

/* ── 绑定与启动 ───────────────────────────────────────────────────────────── */

function bind() {
  els.tokenForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const token = els.tokenInput.value.trim();
    if (token.length === 0) {
      els.tokenError.textContent = '请输入本机令牌。';
      els.tokenError.hidden = false;
      return;
    }
    try {
      sessionStorage.setItem(TOKEN_KEY, token);
    } catch {
      // sessionStorage 不可用时仅在本次页面生命周期内使用。
    }
    model.token = token;
    model.unauthorizedShown = false;
    els.tokenInput.value = '';
    els.tokenError.hidden = true;
    start();
  });

  const actions = {
    halt: requestHaltToggle,
    activate: () => performTransition('activate', '/api/room/activate', '激活'),
    run: performRun,
    pause: () => performTransition('pause', '/api/pause', '暂停'),
    resume: () => performTransition('resume', '/api/resume', '继续'),
    review: () => performTransition('review', '/api/review', '请求 review'),
    'continue-review': continueReviewThenRun,
    confirm: () => performTransition('confirm', '/api/confirm', '确认结果'),
  };
  for (const button of els.app.querySelectorAll('button[data-action]')) {
    const action = button.dataset.action;
    if (!Object.hasOwn(actions, action)) continue;
    button.addEventListener('click', () => {
      actions[action]();
    });
  }

  els.composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendOwnerMessage();
  });

  els.input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    els.composer.requestSubmit();
  });

  els.input.addEventListener('input', renderControls);

  els.exportLink.addEventListener('click', exportMarkdown);

  management = createManagementUI({
    model,
    api,
    refreshSnapshot,
    pushNotice,
    reportError,
    seatName,
    seatColor,
    sortedMessages,
  });
  management.bind();
  const game = createGameUI({ getToken: () => model.token });
  game.bind();
  const tabletop = createTabletopUI({ getToken: () => model.token });
  tabletop.bind();
  const panels = {
    settings: () => management.openSettings(),
    records: () => management.openRecords(),
    help: () => management.openHelp(),
    game: () => game.open(),
    tabletop: () => tabletop.open(),
  };
  for (const button of els.app.querySelectorAll('button[data-panel]')) {
    button.addEventListener('click', () => panels[button.dataset.panel]?.());
  }
  els.memberList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-new-session]');
    if (button) management.resetSeat(button.dataset.newSession);
  });
  els.memberSearch.addEventListener('input', () => {
    model.memberQuery = els.memberSearch.value;
    renderMembers();
  });
  els.memberCompact.addEventListener('click', () => {
    model.compactMembers = !model.compactMembers;
    renderMembers();
  });
}

function init() {
  els.gate = $('token-gate');
  els.tokenForm = $('token-form');
  els.tokenInput = $('token-input');
  els.tokenError = $('token-error');
  els.app = $('app');
  els.roomId = $('room-id');
  els.roomState = $('room-state');
  els.conn = $('conn');
  els.connText = $('conn-text');
  els.roomMeta = $('room-meta');
  els.haltButton = els.app.querySelector('button[data-action="halt"]');
  els.haltStatus = $('halt-status');
  els.haltMode = $('halt-mode');
  els.haltFacts = $('halt-facts');
  els.haltAttempts = $('halt-attempts');
  els.continueReviewButton = els.app.querySelector('button[data-action="continue-review"]');
  els.notices = $('notices');
  els.memberList = $('member-list');
  els.memberCount = $('member-count');
  els.memberSearch = $('member-search');
  els.memberCompact = $('member-compact');
  els.memberFilterCount = $('member-filter-count');
  els.messages = $('messages');
  els.messageCount = $('message-count');
  els.composer = $('composer');
  els.input = $('input');
  els.mentionOptions = $('mention-options');
  els.nominationOptions = $('nomination-options');
  els.scheduleMode = $('schedule-mode');
  els.scheduleFacts = $('schedule-facts');
  els.queueFacts = $('queue-facts');
  els.activity = $('activity');
  els.exportLink = $('export-link');
  els.changelogLink = $('changelog-link');

  bind();

  const token = bootstrapToken();
  if (!token) {
    showGate(null);
    return;
  }
  model.token = token;
  start();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  init();
}
