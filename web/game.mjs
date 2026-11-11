/**
 * 点格棋（Dots and Boxes）Web 模块。
 *
 * 顶部导出均为纯函数，不访问 DOM/fetch，可直接在 node:test 中断言。
 * 所有 DOM 操作都发生在 createGameUI() 内部，仅使用
 * createElement/createElementNS/textContent，不使用 innerHTML。
 *
 * 边编号约定（40 条）：
 *   h:x:y  水平边，x 为左端点列 0..3，y 为行 0..4
 *   v:x:y  垂直边，x 为列 0..4，y 为上端点行 0..3
 * 坐标以“点”为单位（5x5 点）；渲染时再换算成像素。
 */

import {
  createEventDeduper,
  createSseParser,
  retryDelay,
  shouldReconnect,
} from './sse.mjs';

export const BOARD_SIZE = 4;
export const POINT_COUNT = BOARD_SIZE + 1;
export const POINT_TOTAL = POINT_COUNT * POINT_COUNT;

const SVG_NS = 'http://www.w3.org/2000/svg';
const EDGE_PATTERN = /^([hv]):(\d+):(\d+)$/;
const HEX_COLOR_PATTERN = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i;

/* ── 纯几何 ──────────────────────────────────────────────────────────────── */

/**
 * 解析一条边并返回其几何信息（点坐标）。
 * 非法或越界的边返回 null。
 *
 * @param {string} edgeId
 * @returns {{id: string, orientation: 'h'|'v', x: number, y: number,
 *   x1: number, y1: number, x2: number, y2: number}|null}
 */
export function edgeGeometry(edgeId) {
  if (typeof edgeId !== 'string') return null;
  const match = EDGE_PATTERN.exec(edgeId);
  if (!match) return null;
  const orientation = match[1];
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;

  if (orientation === 'h') {
    if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= POINT_COUNT) return null;
    return { id: edgeId, orientation, x, y, x1: x, y1: y, x2: x + 1, y2: y };
  }
  if (x < 0 || x >= POINT_COUNT || y < 0 || y >= BOARD_SIZE) return null;
  return { id: edgeId, orientation, x, y, x1: x, y1: y, x2: x, y2: y + 1 };
}

/** 全部 40 条边的 id，按水平→垂直、行优先排列。 */
export function allEdges() {
  const edges = [];
  for (let y = 0; y < POINT_COUNT; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) edges.push(`h:${x}:${y}`);
  }
  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < POINT_COUNT; x += 1) edges.push(`v:${x}:${y}`);
  }
  return edges;
}

/** 一个格子的四条边：上、下、左、右。 */
export function boxEdges(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return [];
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return [];
  return [`h:${x}:${y}`, `h:${x}:${y + 1}`, `v:${x}:${y}`, `v:${x + 1}:${y}`];
}

/* ── 快照判定 ────────────────────────────────────────────────────────────── */

function findPlayer(players, slot) {
  if (!Array.isArray(players)) return null;
  return players.find((player) => player && player.slot === slot) ?? null;
}

/**
 * 人类是否可以落子：棋局进行中、运行时 ready、当前玩家为人类。
 * 未开局、AI 回合、准备中/思考中/错误时一律 false。
 */
export function canHumanMove(snapshot) {
  const game = snapshot?.game;
  if (!game || game.status !== 'playing') return false;
  if (snapshot?.runtime?.phase !== 'ready') return false;
  const current = findPlayer(game.players, game.currentPlayer);
  return current?.kind === 'human';
}

/** 棋局胜者文案；未结束返回空串，多人并列或无人获胜返回“平局”。 */
export function winnerText(game) {
  if (!game || game.status !== 'finished') return '';
  const winners = Array.isArray(game.winners) ? game.winners : [];
  if (winners.length !== 1) return '平局';
  const winner = findPlayer(game.players, winners[0]);
  const name = winner?.name || `第 ${winners[0] + 1} 席`;
  return `${name} 获胜`;
}

function slotOf(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (value && typeof value === 'object' && Number.isSafeInteger(value.slot)) {
    return value.slot;
  }
  return null;
}

/** 某条边的占有者席位；未占用返回 null。 */
export function edgeOwner(edges, edgeId) {
  if (!edges || typeof edges !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(edges, edgeId)) return null;
  return slotOf(edges[edgeId]);
}

/**
 * 某个格子的归属值；未归属返回 null。
 * 兼容 `x:y`、`x,y` 与行优先序号三种键。
 */
export function boxOwner(boxes, x, y) {
  if (!boxes || typeof boxes !== 'object') return null;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || x >= BOARD_SIZE || y < 0 || y >= BOARD_SIZE) return null;
  const keys = [`b:${x}:${y}`, `${x}:${y}`, `${x},${y}`, String(y * BOARD_SIZE + x)];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(boxes, key)) return boxes[key];
  }
  return null;
}

/** 归属值 → 席位号。 */
export function boxOwnerSlot(boxes, x, y) {
  return slotOf(boxOwner(boxes, x, y));
}

function colorOf(value, players) {
  if (value === null || value === undefined) return null;
  const slot = slotOf(value);
  const bySlot = slot === null ? null : findPlayer(players, slot);
  if (bySlot?.color) return bySlot.color;
  if (typeof value === 'string' && HEX_COLOR_PATTERN.test(value)) return value;
  if (Array.isArray(players)) {
    const byColor = players.find((player) => player && player.color === value);
    if (byColor?.color) return byColor.color;
  }
  return null;
}

function nameOf(value, players) {
  const slot = slotOf(value);
  const player = slot === null ? null : findPlayer(players, slot);
  if (player?.name) return player.name;
  if (typeof value === 'string' && !HEX_COLOR_PATTERN.test(value)) return value;
  return slot === null ? '' : `第 ${slot + 1} 席`;
}

/* ── 着法展示 ────────────────────────────────────────────────────────────── */

/** 最近至多 limit 步；moves 不是数组时返回空列表。 */
export function recentMoves(moves, limit = 12) {
  if (!Array.isArray(moves)) return [];
  const size = Number.isSafeInteger(limit) && limit > 0 ? limit : 12;
  return moves.slice(-size);
}

/**
 * 单步文案。move 可以是边 id 字符串，或 {edge, slot|playerSlot|player, name?, step?}。
 * players 为快照中的玩家数组，用于把 slot 换成昵称。
 */
export function formatMove(move, players = []) {
  if (move === null || move === undefined) return '';
  let edge = '';
  let label = '';
  let step = null;

  if (typeof move === 'string') {
    edge = move;
  } else if (typeof move === 'object') {
    if (typeof move.edge === 'string') edge = move.edge;
    if (typeof move.name === 'string' && move.name) {
      label = move.name;
    } else {
      const raw = move.slot ?? move.playerSlot ?? move.player;
      if (raw !== undefined && raw !== null) {
        const slot = slotOf(raw);
        if (slot !== null) label = findPlayer(players, slot)?.name || `第 ${slot + 1} 席`;
        else label = String(raw);
      }
    }
    const n = move.step ?? move.index;
    if (Number.isSafeInteger(n) && n >= 0) step = n;
  }

  const parts = [];
  if (step !== null) parts.push(`#${step}`);
  if (label) parts.push(label);
  if (edge) parts.push(edge);
  return parts.join(' ');
}

/**
 * 单步 AI 理由。仅读取 move.comment，trim 后最多保留 160 个字符；
 * 缺失、非字符串或空白时返回空串。该理由只用于着法记录，不进入聊天字幕。
 */
export function moveComment(move, limit = 160) {
  if (!move || typeof move !== 'object') return '';
  const raw = move.comment;
  if (typeof raw !== 'string') return '';
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 160) : 160;
  return raw.trim().slice(0, size);
}

/**
 * 连走（上一手得分、当前玩家不变）提示；无连走返回空串。
 * 优先依据 completedBoxes/extraTurn，缺失时才退化为“当前玩家 == 上一手玩家”。
 */
export function extraTurnNotice(game) {
  if (!game || game.status !== 'playing') return '';
  const moves = Array.isArray(game.moves) ? game.moves : [];
  const last = moves[moves.length - 1];
  if (!last || typeof last !== 'object') return '';
  const slot = slotOf(last.slot ?? last.playerSlot ?? last.player);
  if (slot === null) return '';
  if (Array.isArray(last.completedBoxes)) {
    if (last.completedBoxes.length === 0) return '';
  } else if (last.extraTurn === false) {
    return '';
  }
  if (slot !== game.currentPlayer) return '';
  const name = findPlayer(game.players, slot)?.name || `第 ${slot + 1} 席`;
  return `连走：${name} 再落一子`;
}

/* ── 设置默认值 ──────────────────────────────────────────────────────────── */

/**
 * 四席默认配置：第 0 席人类（ownerName），其余依次取前三个 AI；
 * AI 不足时回退为人类。
 */
export function buildSetupDefaults({ seatOptions = [], ownerName = '机主' } = {}) {
  const ais = Array.isArray(seatOptions) ? seatOptions.filter((seat) => seat?.seatId) : [];
  const defaults = [{ kind: 'human', seatId: null, name: ownerName }];
  for (let index = 1; index < BOARD_SIZE; index += 1) {
    const seat = ais[index - 1];
    if (seat) {
      defaults.push({
        kind: 'ai',
        seatId: seat.seatId,
        name: seat.displayName || seat.seatId,
      });
    } else {
      defaults.push({ kind: 'human', seatId: null, name: `玩家 ${index + 1}` });
    }
  }
  return defaults;
}

/** 某个归属/座位对应的颜色，供渲染复用。 */
export function seatColor(value, players = []) {
  return colorOf(value, players);
}

/* ── 仅浏览器可用的 UI ──────────────────────────────────────────────────── */

class GameError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'GameError';
    this.status = status;
    this.code = code;
  }
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return '操作失败，请稍后再试。';
}

function normalizeSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : payload;
  if (!('game' in candidate) && !('runtime' in candidate) && !('seatOptions' in candidate)) {
    return null;
  }
  return candidate;
}

/**
 * 创建点格棋界面控制器。
 * @param {{getToken: () => (string|null), fetchImpl?: typeof fetch}} options
 */
export function createGameUI({ getToken, fetchImpl } = {}) {
  const state = {
    snapshot: null,
    view: 'setup',
    setupOpen: false,
    setupPopulated: false,
    setupDirty: false,
    movePending: null,
    starting: false,
    resuming: false,
    startingLock: false,
    generation: 0,
    retryAttempt: 0,
    reconnectTimer: null,
    streamAbort: null,
    bound: false,
  };

  const deduper = createEventDeduper({ limit: 2000 });
  const els = {};
  const domAbort = typeof AbortController === 'function' ? new AbortController() : null;

  function $(id) {
    if (typeof document === 'undefined') return null;
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function token() {
    try {
      const value = typeof getToken === 'function' ? getToken() : null;
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  function fetchFn() {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    return null;
  }

  async function request(path, { method = 'GET', body, signal } = {}) {
    const bearer = token();
    if (!bearer) throw new GameError('缺少访问令牌，请重新连接。', 401, 'UNAUTHORIZED');
    const fetchImplFn = fetchFn();
    if (!fetchImplFn) throw new GameError('当前环境不支持网络请求。', 0, 'NO_FETCH');

    const headers = {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/json',
      'Cache-Control': 'no-store',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetchImplFn(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new GameError('网络错误：无法连接本机服务。', 0, 'NETWORK_ERROR');
    }

    if (!response.ok) {
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      const message = typeof payload?.error?.message === 'string'
        ? payload.error.message
        : `请求失败（HTTP ${response.status}）。`;
      const code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
      throw new GameError(message, response.status, code);
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /* ── 元素与事件绑定 ─────────────────────────────────────────────────── */

  function collectEls() {
    els.dialog = $('game-dialog');
    els.setup = $('game-setup');
    els.setupForm = els.setup && typeof els.setup.elements === 'object' ? els.setup : null;
    els.start = $('game-start-submit');
    els.play = $('game-play');
    els.board = $('game-board');
    els.scores = $('game-scores');
    els.turn = $('game-turn');
    els.status = $('game-status');
    els.error = $('game-error');
    els.moves = $('game-moves');
    els.newButton = $('game-new');
    els.resume = $('game-resume');
  }

  function on(target, type, handler, options = undefined) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, domAbort
      ? { ...(options ?? {}), signal: domAbort.signal }
      : options);
  }

  function bind() {
    if (state.bound) return state.bound;
    collectEls();
    if (!els.dialog) return false;
    state.bound = true;

    on(els.dialog, 'close', () => {
      stopStream();
      document.body.classList.remove('game-open');
    });
    on(els.dialog, 'cancel', stopStream);

    if (els.setupForm) on(els.setupForm, 'submit', (event) => {
      event.preventDefault();
      startGame();
    });
    if (els.start) on(els.start, 'click', (event) => {
      event.preventDefault();
      startGame();
    });

    if (els.newButton) on(els.newButton, 'click', (event) => {
      event.preventDefault();
      openSetup();
    });
    if (els.resume) on(els.resume, 'click', (event) => {
      event.preventDefault();
      resumeGame();
    });

    for (let slot = 0; slot < BOARD_SIZE; slot += 1) {
      const select = formField(`player-${slot}`);
      if (!select) continue;
      on(select, 'change', () => {
        state.setupDirty = true;
        syncName(slot);
      });
      const nameInput = formField(`name-${slot}`);
      if (nameInput) on(nameInput, 'input', () => {
        nameInput.dataset.auto = '0';
        state.setupDirty = true;
      });
    }

    if (els.status) els.status.setAttribute('aria-live', 'polite');
    if (els.error) els.error.setAttribute('role', 'alert');
    return true;
  }

  function formField(name) {
    if (!els.setupForm || !els.setupForm.elements) return null;
    const field = els.setupForm.elements.namedItem(name);
    return field && typeof field === 'object' && 'value' in field ? field : null;
  }

  function cleanup() {
    stopStream();
    if (domAbort) domAbort.abort();
    state.bound = false;
  }

  /* ── 视图切换 ────────────────────────────────────────────────────────── */

  function setView(view) {
    state.view = view;
    if (els.setup) els.setup.hidden = view !== 'setup';
    if (els.play) els.play.hidden = view !== 'play';
  }

  function setError(message) {
    if (els.error) els.error.textContent = message ? String(message) : '';
  }

  function setStatus(message) {
    if (els.status) els.status.textContent = message ? String(message) : '';
  }

  function ownerName() {
    const value = state.snapshot?.ownerName;
    return typeof value === 'string' && value ? value : '机主';
  }

  function seatOptions() {
    const value = state.snapshot?.seatOptions;
    return Array.isArray(value) ? value.filter((seat) => seat?.seatId) : [];
  }

  /* ── setup ───────────────────────────────────────────────────────────── */

  function playerChoices() {
    const choices = [{ value: 'human', label: '人类' }];
    for (const seat of seatOptions()) {
      choices.push({
        value: `ai:${seat.seatId}`,
        label: `AI · ${seat.displayName || seat.seatId}`,
      });
    }
    return choices;
  }

  function selectionName(value, slot) {
    if (value === 'human') return slot === 0 ? ownerName() : `人类 ${slot + 1}`;
    const seatId = typeof value === 'string' && value.startsWith('ai:') ? value.slice(3) : '';
    const seat = seatOptions().find((option) => option.seatId === seatId);
    return seat ? (seat.displayName || seat.seatId) : '';
  }

  function fillSelect(select, choices, selected) {
    select.replaceChildren();
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      select.append(option);
    }
    if (selected !== undefined && [...select.options].some((option) => option.value === selected)) {
      select.value = selected;
    }
  }

  function syncName(slot, { force = false } = {}) {
    const select = formField(`player-${slot}`);
    const nameInput = formField(`name-${slot}`);
    if (!select || !nameInput) return;
    if (!force && nameInput.dataset.auto === '0') return;
    nameInput.value = selectionName(select.value, slot);
    nameInput.dataset.auto = '1';
  }

  function populateSetup() {
    const defaults = buildSetupDefaults({ seatOptions: seatOptions(), ownerName: ownerName() });
    const choices = playerChoices();
    for (let slot = 0; slot < BOARD_SIZE; slot += 1) {
      const select = formField(`player-${slot}`);
      if (select) {
        const preset = defaults[slot];
        const selected = preset.kind === 'ai' && preset.seatId
          ? `ai:${preset.seatId}`
          : 'human';
        fillSelect(select, choices, selected);
      }
      const nameInput = formField(`name-${slot}`);
      if (nameInput) {
        nameInput.value = defaults[slot]?.name ?? '';
        nameInput.dataset.auto = '1';
      }
    }
    state.setupPopulated = true;
  }

  function openSetup() {
    state.setupOpen = true;
    state.setupDirty = false;
    setError('');
    populateSetup();
    setView('setup');
    setStatus('选择四位玩家后点击“开始棋局”。');
  }

  function collectPlayers() {
    const players = [];
    for (let slot = 0; slot < BOARD_SIZE; slot += 1) {
      const select = formField(`player-${slot}`);
      const nameInput = formField(`name-${slot}`);
      const value = select ? select.value : 'human';
      const name = nameInput && typeof nameInput.value === 'string' ? nameInput.value.trim() : '';
      if (value === 'human') {
        players.push(name ? { kind: 'human', name } : { kind: 'human' });
        continue;
      }
      const seatId = value.startsWith('ai:') ? value.slice(3) : '';
      if (!seatId) return null;
      players.push(name ? { kind: 'ai', seatId, name } : { kind: 'ai', seatId });
    }
    return players;
  }

  /* ── 渲染 ────────────────────────────────────────────────────────────── */

  function playerBySlot(slot) {
    return findPlayer(state.snapshot?.game?.players, slot);
  }

  function renderScores(game) {
    if (!els.scores) return;
    els.scores.replaceChildren();
    const players = Array.isArray(game?.players) ? game.players : [];
    for (const player of players) {
      const row = el('div', 'game-score');
      row.dataset.slot = String(player.slot);
      if (player.slot === game?.currentPlayer && game?.status === 'playing') {
        row.classList.add('is-current');
      }
      const swatch = el('span', 'game-score-color');
      if (player.color) swatch.style.background = player.color;
      const name = el('span', 'game-score-name', player.name || `第 ${player.slot + 1} 席`);
      const score = el('span', 'game-score-value', String(game?.scores?.[player.slot] ?? 0));
      row.append(swatch, name, score);
      els.scores.append(row);
    }
  }

  function renderTurn(game, runtime) {
    if (!els.turn) return;
    if (!game) {
      els.turn.textContent = '尚未开局';
      return;
    }
    if (game.status === 'finished') {
      els.turn.textContent = winnerText(game);
      return;
    }
    const current = findPlayer(game.players, game.currentPlayer);
    const name = current?.name || `第 ${Number(game.currentPlayer) + 1} 席`;
    if (runtime?.phase === 'thinking') els.turn.textContent = `${name} 正在思考…`;
    else if (runtime?.phase === 'preparing') els.turn.textContent = '正在准备棋局…';
    else if (runtime?.phase === 'error') els.turn.textContent = `${name} 出错了`;
    else els.turn.textContent = `轮到 ${name}`;
  }

  function statusLine(game, runtime) {
    if (!game) return '尚未开局。';
    if (game.status === 'finished') {
      const tie = winnerText(game) === '平局';
      return tie ? '平局：各席位格数相同。' : `棋局结束：${winnerText(game)}。`;
    }
    if (runtime?.phase === 'error') return runtime.message || 'AI 出错，可点击“继续棋局”重试。';
    if (runtime?.phase === 'preparing') return '正在准备棋局…';
    if (runtime?.phase === 'thinking') return runtime.message || 'AI 正在思考…';
    if (runtime?.phase === 'idle') return '等待服务端进入可落子状态。';
    const combo = extraTurnNotice(game);
    if (combo) return combo;
    return '点击一条空边落子。';
  }

  function renderStatus(game, runtime) {
    setStatus(statusLine(game, runtime));
  }

  function renderMoves(game) {
    if (!els.moves) return;
    els.moves.replaceChildren();
    const moves = game?.moves;
    if (!Array.isArray(moves) || moves.length === 0) {
      const empty = el('li', 'game-move-empty', '暂无着法');
      els.moves.append(empty);
      return;
    }
    const shown = recentMoves(moves, 12);
    const offset = moves.length - shown.length;
    shown.forEach((move, index) => {
      const item = el('li', 'game-move');
      const step = offset + index + 1;
      const text = formatMove(move, game?.players);
      item.textContent = text ? `第 ${step} 步 · ${text}` : `第 ${step} 步`;
      const comment = moveComment(move);
      if (comment) item.append(el('div', 'game-move-comment', comment));
      els.moves.append(item);
    });
  }

  function renderResume(runtime) {
    if (els.resume) {
      const game = state.snapshot?.game;
      const current = game?.players?.find((player) => player.slot === game.currentPlayer);
      const needsResume = game?.status === 'playing'
        && current?.kind === 'ai'
        && (runtime?.phase === 'error' || runtime?.phase === 'idle');
      els.resume.hidden = !needsResume;
      els.resume.disabled = state.resuming;
      els.resume.textContent = state.resuming ? '继续中…' : '继续棋局';
    }
    if (els.newButton) {
      els.newButton.textContent = state.snapshot?.game?.status === 'finished' ? '再来一局' : '新棋局';
    }
  }

  function edgeOwnerInfo(edges, edgeId) {
    if (!edges || typeof edges !== 'object') return { owned: false, color: null, text: '' };
    if (!Object.prototype.hasOwnProperty.call(edges, edgeId)) {
      return { owned: false, color: null, text: '' };
    }
    const value = edges[edgeId];
    return {
      owned: true,
      color: colorOf(value, state.snapshot?.game?.players),
      text: nameOf(value, state.snapshot?.game?.players),
    };
  }

  function boxOwnerInfo(boxes, x, y) {
    const value = boxOwner(boxes, x, y);
    if (value === null || value === undefined) return { owned: false, color: null, text: '' };
    const players = state.snapshot?.game?.players;
    return {
      owned: true,
      color: colorOf(value, players),
      text: nameOf(value, players),
    };
  }

  function renderBoard(game, snapshot) {
    if (!els.board) return;
    const boardEl = els.board;
    let svg;
    if (boardEl.namespaceURI === SVG_NS && String(boardEl.tagName).toLowerCase() === 'svg') {
      svg = boardEl;
      svg.replaceChildren();
    } else {
      svg = document.createElementNS(SVG_NS, 'svg');
      boardEl.replaceChildren(svg);
    }
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', '点格棋棋盘');

    const padding = 7;
    const step = (100 - padding * 2) / BOARD_SIZE;
    const point = (index) => padding + index * step;
    const nodes = [];
    const owners = game?.edges ?? {};
    const boxes = game?.boxes ?? {};
    const interactive = canHumanMove(snapshot) && !state.movePending;

    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const info = boxOwnerInfo(boxes, x, y);
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(point(x) + 0.7));
        rect.setAttribute('y', String(point(y) + 0.7));
        rect.setAttribute('width', String(step - 1.4));
        rect.setAttribute('height', String(step - 1.4));
        rect.setAttribute('rx', '1.4');
        rect.setAttribute('fill', info.owned && info.color ? info.color : 'none');
        rect.setAttribute('fill-opacity', info.owned ? '0.28' : '0');
        rect.setAttribute('stroke', '#8b949e');
        rect.setAttribute('stroke-opacity', '0.35');
        rect.setAttribute('stroke-width', '0.3');
        rect.dataset.box = `${x}:${y}`;
        nodes.push(rect);

        if (info.owned) {
          const label = document.createElementNS(SVG_NS, 'text');
          label.setAttribute('x', String(point(x) + step / 2));
          label.setAttribute('y', String(point(y) + step / 2));
          label.setAttribute('text-anchor', 'middle');
          label.setAttribute('dominant-baseline', 'central');
          label.setAttribute('font-size', '4.6');
          label.setAttribute('font-weight', '600');
          label.setAttribute('fill', info.color || '#8b949e');
          label.setAttribute('pointer-events', 'none');
          label.textContent = (info.text || '').slice(0, 2);
          nodes.push(label);
        }
      }
    }

    for (let index = 0; index < POINT_COUNT; index += 1) {
      for (let other = 0; other < POINT_COUNT; other += 1) {
        const dot = document.createElementNS(SVG_NS, 'circle');
        dot.setAttribute('cx', String(point(index)));
        dot.setAttribute('cy', String(point(other)));
        dot.setAttribute('r', '0.85');
        dot.setAttribute('fill', '#8b949e');
        dot.setAttribute('fill-opacity', '0.7');
        dot.setAttribute('pointer-events', 'none');
        nodes.push(dot);
      }
    }

    for (const edgeId of allEdges()) {
      const geometry = edgeGeometry(edgeId);
      if (!geometry) continue;
      const info = edgeOwnerInfo(owners, edgeId);
      const group = document.createElementNS(SVG_NS, 'g');
      group.dataset.edge = edgeId;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(point(geometry.x1)));
      line.setAttribute('y1', String(point(geometry.y1)));
      line.setAttribute('x2', String(point(geometry.x2)));
      line.setAttribute('y2', String(point(geometry.y2)));
      line.setAttribute('stroke', info.color || '#6e7681');
      line.setAttribute('stroke-width', info.owned ? '2.2' : '1.6');
      line.setAttribute('stroke-linecap', 'round');
      line.setAttribute('stroke-opacity', info.owned ? '1' : '0.85');
      line.setAttribute('class', info.owned ? 'game-edge is-owned' : 'game-edge is-empty');
      line.setAttribute('pointer-events', 'none');

      const hitSize = 5;
      const hit = document.createElementNS(SVG_NS, 'rect');
      hit.setAttribute('x', String(point(geometry.x1) - (geometry.orientation === 'v' ? hitSize / 2 : 0)));
      hit.setAttribute('y', String(point(geometry.y1) - (geometry.orientation === 'h' ? hitSize / 2 : 0)));
      hit.setAttribute('width', String(geometry.orientation === 'h' ? point(geometry.x2) - point(geometry.x1) : hitSize));
      hit.setAttribute('height', String(geometry.orientation === 'v' ? point(geometry.y2) - point(geometry.y1) : hitSize));
      hit.setAttribute('fill', 'transparent');

      const playable = interactive && !info.owned;
      if (state.movePending === edgeId) {
        line.setAttribute('stroke', '#f0b429');
        line.setAttribute('stroke-dasharray', '2 1.4');
      }
      if (playable) {
        line.setAttribute('class', 'game-edge is-playable');
        group.style.cursor = 'pointer';
        hit.setAttribute('pointer-events', 'all');
        group.setAttribute('tabindex', '0');
        group.setAttribute('role', 'button');
        group.setAttribute('aria-label', `落子 ${edgeId}`);
        group.addEventListener('click', () => playEdge(edgeId));
        group.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            playEdge(edgeId);
          }
        });
      } else {
        hit.setAttribute('pointer-events', 'none');
        group.setAttribute('aria-disabled', 'true');
      }

      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = info.owned
        ? `${edgeId} · ${info.text || '已占用'}`
        : `${edgeId}${playable ? ' · 可落子' : ''}`;
      group.append(line, hit, title);
      nodes.push(group);
    }

    if (typeof svg.replaceChildren === 'function') {
      svg.replaceChildren(...nodes);
    } else {
      nodes.forEach((node) => svg.append(node));
    }
  }

  function renderPlay(snapshot) {
    const game = snapshot?.game ?? null;
    const runtime = snapshot?.runtime ?? { phase: 'idle', message: '' };
    renderScores(game);
    renderTurn(game, runtime);
    renderStatus(game, runtime);
    renderMoves(game);
    renderResume(runtime);
    renderBoard(game, snapshot);
  }

  function showSetup(snapshot) {
    state.snapshot = snapshot ?? state.snapshot;
    if (els.setup) setView('setup');
    populateSetup();
    setError('');
    setStatus('选择四位玩家后点击“开始棋局”。');
    if (els.scores) els.scores.replaceChildren();
    if (els.moves) els.moves.replaceChildren();
    if (els.turn) els.turn.textContent = '尚未开局';
  }

  function applySnapshot(snapshot, { forceView = false } = {}) {
    if (!snapshot) return;
    state.snapshot = snapshot;
    const game = snapshot.game;
    if (!game) {
      state.setupOpen = true;
      if (state.view !== 'setup' || !state.setupPopulated) {
        showSetup(snapshot);
      } else if (!state.setupDirty) {
        populateSetup();
      }
      return;
    }
    if (state.setupOpen && !forceView) return;
    state.setupOpen = false;
    setView('play');
    renderPlay(snapshot);
  }

  /* ── 动作 ────────────────────────────────────────────────────────────── */

  async function refresh() {
    const payload = await request('/api/game');
    const snapshot = normalizeSnapshot(payload);
    if (snapshot) applySnapshot(snapshot);
    return snapshot;
  }

  async function startGame() {
    if (state.startingLock) return;
    collectEls();
    const game = state.snapshot?.game;
    if (game && game.status === 'playing') {
      const confirmFn = typeof globalThis.confirm === 'function'
        ? globalThis.confirm.bind(globalThis)
        : null;
      if (confirmFn && !confirmFn('当前棋局尚未结束，开始新局将覆盖它。继续吗？')) return;
    }
    const players = collectPlayers();
    if (!players) {
      setError('AI 座位缺少有效席位，请重新选择。');
      return;
    }

    state.startingLock = true;
    state.starting = true;
    setError('');
    try {
      const payload = await request('/api/game/new', { method: 'POST', body: { players } });
      const snapshot = normalizeSnapshot(payload);
      state.setupOpen = false;
      if (snapshot) {
        applySnapshot(snapshot, { forceView: true });
      } else {
        await refresh();
        setView('play');
      }
      if (state.snapshot?.game) setView('play');
    } catch (error) {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    } finally {
      state.starting = false;
      state.startingLock = false;
    }
  }

  async function resumeGame() {
    if (state.resuming) return;
    state.resuming = true;
    setError('');
    renderResume(state.snapshot?.runtime);
    try {
      const payload = await request('/api/game/resume', { method: 'POST', body: {} });
      const snapshot = normalizeSnapshot(payload);
      if (snapshot) applySnapshot(snapshot);
      else await refresh();
    } catch (error) {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    } finally {
      state.resuming = false;
      renderResume(state.snapshot?.runtime);
    }
  }

  async function playEdge(edgeId) {
    if (state.movePending || state.starting) return;
    if (!canHumanMove(state.snapshot)) return;
    if (!edgeGeometry(edgeId)) return;

    state.movePending = edgeId;
    setError('');
    renderPlay(state.snapshot);
    try {
      const payload = await request('/api/game/move', {
        method: 'POST',
        body: { edge: edgeId },
      });
      const snapshot = normalizeSnapshot(payload);
      if (snapshot) applySnapshot(snapshot);
      else await refresh();
    } catch (error) {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    } finally {
      state.movePending = null;
      if (state.snapshot) renderPlay(state.snapshot);
    }
  }

  /* ── 独立 SSE 流 ─────────────────────────────────────────────────────── */

  function stopStream() {
    state.generation += 1;
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.streamAbort) {
      try {
        state.streamAbort.abort();
      } catch {
        // 忽略 abort 失败。
      }
      state.streamAbort = null;
    }
    state.retryAttempt = 0;
  }

  function handleEnvelope(envelope) {
    if (!envelope || typeof envelope.data !== 'string') return;
    let data;
    try {
      data = JSON.parse(envelope.data);
    } catch {
      return;
    }

    if (envelope.event === 'snapshot') {
      const snapshot = normalizeSnapshot(data);
      if (snapshot) applySnapshot(snapshot);
      return;
    }

    if (envelope.event === 'GameChanged') {
      const eventId = envelope.id ?? data?.eventId ?? null;
      if (!deduper.accept(eventId)) return;
      const snapshot = normalizeSnapshot(data?.snapshot ?? data);
      if (snapshot) applySnapshot(snapshot);
    }
  }

  async function startStream() {
    stopStream();
    const generation = state.generation;
    const fetchImplFn = fetchFn();
    const bearer = token();
    if (!fetchImplFn) {
      setError('当前环境不支持事件流。');
      return;
    }
    if (!bearer) {
      setError('缺少访问令牌，请重新连接。');
      return;
    }

    const controller = new AbortController();
    state.streamAbort = controller;
    let opened = false;
    let status = 0;
    let failure = null;

    try {
      const response = await fetchImplFn('/api/game/events', {
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'text/event-stream',
          'Cache-Control': 'no-store',
        },
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal,
      });
      status = response.status;

      if (status === 401) {
        if (generation === state.generation) {
          setError('访问令牌无效或已失效。');
          state.streamAbort = null;
        }
        return;
      }
      if (!response.ok) {
        failure = `棋局事件流请求失败（HTTP ${status}）。`;
      } else if (!response.body) {
        failure = '当前浏览器不支持读取事件流。';
      } else {
        opened = true;
        state.retryAttempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser({
          onEvent: (envelope) => {
            if (generation !== state.generation) return;
            handleEnvelope(envelope);
          },
        });

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode());
        parser.end();
        if (generation !== state.generation) return;
        failure = '棋局事件流已断开。';
      }
    } catch (error) {
      if (generation !== state.generation) return;
      if (error?.name === 'AbortError') return;
      failure = '棋局事件流网络错误。';
    }

    if (generation !== state.generation) return;
    state.streamAbort = null;

    if (!opened && !shouldReconnect(status)) {
      setError(failure ?? '棋局事件流无法连接。');
      return;
    }

    if (!opened) state.retryAttempt += 1;
    const delay = retryDelay(opened ? 0 : state.retryAttempt, {
      baseMs: 800,
      maxMs: 15000,
      jitter: 0.25,
    });
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (generation !== state.generation) return;
      startStream();
    }, delay);
  }

  /* ── 开合 ────────────────────────────────────────────────────────────── */

  function open() {
    if (!bind()) return;
    collectEls();
    setError('');
    if (els.dialog && !els.dialog.open) {
      document.body.classList.add('game-open');
      if (typeof els.dialog.show === 'function') els.dialog.show();
      else els.dialog.setAttribute('open', '');
    }
    if (!state.snapshot) {
      setView('setup');
      if (!state.setupPopulated) populateSetup();
    }
    startStream();
    refresh().catch((error) => {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    });
  }

  function close() {
    stopStream();
    if (els.dialog?.open && typeof els.dialog.close === 'function') els.dialog.close();
  }

  function destroy() {
    cleanup();
    if (els.board) els.board.replaceChildren();
  }

  return {
    bind,
    open,
    close,
    destroy,
    refresh,
    getSnapshot: () => state.snapshot,
    playEdge,
  };
}
