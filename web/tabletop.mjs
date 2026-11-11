/**
 * 双人棋右侧栏 Web 模块（象棋 / 国际象棋 / 围棋 / 五子棋 / 黑白棋）。
 *
 * 顶部导出均为纯函数，不访问 DOM/fetch，可直接在 node:test 中断言。
 * 所有 DOM 操作都发生在 createTabletopUI() 内部，仅使用
 * createElement/textContent，不使用 innerHTML。
 *
 * 快照约定（服务端管理器）：
 *   { game, runtime, seatOptions? }
 * game = {
 *   gameType, players[2], moves, currentPlayer, status, winners, scores,
 *   view: { rows, columns, cells: [{ x, y, value, owner, label }] },
 *   legalActions: [{ kind: 'move', from, to } | { kind: 'place', x, y }
 *                  | { kind: 'pass' }],
 * }
 */

import {
  createEventDeduper,
  createSseParser,
  retryDelay,
  shouldReconnect,
} from './sse.mjs';

export const GAME_TYPES = ['xiangqi', 'chess', 'go', 'gomoku', 'reversi'];
export const DEFAULT_GAME_TYPE = 'gomoku';
export const PLAYER_COUNT = 2;
export const RECENT_MOVE_LIMIT = 12;

export const GAME_LABELS = {
  xiangqi: '中国象棋',
  chess: '国际象棋',
  go: '围棋',
  gomoku: '五子棋',
  reversi: '黑白棋',
};

const MOVE_TYPES = new Set(['chess', 'xiangqi']);
const PLACE_TYPES = new Set(['go', 'gomoku', 'reversi']);
const CHESS_FILES = 'abcdefgh';
const XIANGQI_FILES = 'abcdefghi';

/* ── 纯函数 ──────────────────────────────────────────────────────────────── */

/** 是否为已知棋种；未知值回落到默认类型。 */
export function normalizeGameType(value) {
  return GAME_TYPES.includes(value) ? value : DEFAULT_GAME_TYPE;
}

/** 棋种中文名；未知棋种原样返回字符串。 */
export function gameLabel(gameType) {
  if (typeof gameType !== 'string' || !gameType) return '';
  return GAME_LABELS[gameType] ?? gameType;
}

/** 落子用坐标棋种（一步两点的棋）。 */
export function isMoveGame(gameType) {
  return MOVE_TYPES.has(gameType);
}

/** 单点落子棋种。 */
export function isPlaceGame(gameType) {
  return PLACE_TYPES.has(gameType);
}

/**
 * 棋盘格 → 协议坐标。
 *   chess   ：文件 a-h + 行号 8-y（y=0 在最上、rank 8）
 *   xiangqi ：文件 a-i + 行号 y（y=0 在最上）
 *   place   ：直接 "x,y"
 * 越界或未知棋种返回空串。
 */
export function coordFor(gameType, x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) return '';
  if (gameType === 'chess') {
    if (x > 7 || y > 7) return '';
    return `${CHESS_FILES[x]}${8 - y}`;
  }
  if (gameType === 'xiangqi') {
    if (x > 8 || y > 9) return '';
    return `${XIANGQI_FILES[x]}${y}`;
  }
  if (PLACE_TYPES.has(gameType)) return `${x},${y}`;
  return '';
}

function playerIndex(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (value && typeof value === 'object' && Number.isSafeInteger(value.slot)) {
    return value.slot;
  }
  return null;
}

function playerAt(players, value) {
  const slot = playerIndex(value);
  if (slot === null || !Array.isArray(players)) return null;
  const bySlot = players.find((player) => player && playerIndex(player.slot) === slot);
  if (bySlot) return bySlot;
  return players[slot] ?? null;
}

function playerNameOf(players, value) {
  const slot = playerIndex(value);
  const player = playerAt(players, value);
  if (player?.name) return player.name;
  return slot === null ? '' : `第 ${slot + 1} 席`;
}

/** 从管理器快照或裸 game 中取出 game。 */
export function gameOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if ('game' in payload) {
    return payload.game && typeof payload.game === 'object' ? payload.game : null;
  }
  if (typeof payload.gameType === 'string') return payload;
  return null;
}

/** game.mjs 风格的归一化，同时兼容 { game } 与裸 game。 */
function normalizeSnapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidate = payload.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : payload;
  if (!candidate || typeof candidate !== 'object') return null;
  if ('game' in candidate) {
    const game = candidate.game && typeof candidate.game === 'object' ? candidate.game : null;
    return { ...candidate, game };
  }
  if (typeof candidate.gameType === 'string') {
    return { game: candidate, runtime: candidate.runtime ?? null };
  }
  return null;
}

/**
 * 当前是否允许人类落子。
 * 接受管理器快照 { game, runtime } 或裸 game；runtime 缺省视为 ready，
 * 存在时必须是 ready。可选 expectedType 用于校验棋种。
 */
export function canHumanMove(snapshot, expectedType = null) {
  const game = gameOf(snapshot);
  if (!game || game.status !== 'playing') return false;
  if (expectedType && game.gameType !== expectedType) return false;
  const phase = snapshot?.runtime?.phase;
  if (phase !== undefined && phase !== null && phase !== 'ready') return false;
  const current = playerAt(game.players, game.currentPlayer);
  return current?.kind === 'human';
}

/** 棋局结束文案；未结束返回空串，并列或无人获胜返回“平局”。 */
export function winnerText(game) {
  if (!game || game.status !== 'finished') return '';
  const winners = Array.isArray(game.winners) ? game.winners : [];
  if (winners.length !== 1) return '平局';
  const name = playerNameOf(game.players, winners[0]);
  return `${name || '未知席位'} 获胜`;
}

/**
 * 单步文案。move 可以是着法对象或棋子记录：
 *   { kind:'move', from, to } / { kind:'place', x, y } / { kind:'pass' }
 *   也接受 { action: {...} }、{ from, to }、{ x, y } 形式。
 */
export function formatAction(gameType, action) {
  if (!action || typeof action !== 'object') return '';
  const normalized = typeof action.kind === 'string' ? action : moveAction(action);
  if (!normalized) return '';
  if (normalized.kind === 'pass') return '停一手';
  if (normalized.kind === 'move') {
    if (typeof normalized.from !== 'string' || typeof normalized.to !== 'string') return '';
    return `${normalized.from}→${normalized.to}`;
  }
  if (normalized.kind === 'place') {
    if (!Number.isInteger(normalized.x) || !Number.isInteger(normalized.y)) return '';
    return coordFor(PLACE_TYPES.has(gameType) ? gameType : 'gomoku', normalized.x, normalized.y);
  }
  return '';
}

/** 棋子记录 → 着法对象；无法识别时返回 null。 */
export function moveAction(move) {
  if (!move || typeof move !== 'object') return null;
  if (move.action && typeof move.action === 'object') return move.action;
  if (move.kind === 'pass') return { kind: 'pass' };
  if (move.kind === 'place' || (Number.isInteger(move.x) && Number.isInteger(move.y))) {
    if (Number.isInteger(move.x) && Number.isInteger(move.y)) {
      return { kind: 'place', x: move.x, y: move.y };
    }
  }
  if (typeof move.from === 'string' && typeof move.to === 'string') {
    return { kind: 'move', from: move.from, to: move.to };
  }
  return null;
}

/** 单步 AI 理由：trim 后最多保留 160 个字符；缺失返回空串。 */
export function moveComment(move, limit = 160) {
  if (!move || typeof move !== 'object') return '';
  const raw = move.comment;
  if (typeof raw !== 'string') return '';
  const size = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 160) : 160;
  return raw.trim().slice(0, size);
}

/** 合法着法列表；缺失或非数组时返回空数组。 */
export function legalActionsOf(game) {
  if (!game || !Array.isArray(game.legalActions)) return [];
  return game.legalActions.filter((action) => action && typeof action === 'object');
}

/** 在合法着法里查找与 action 等价的一项。 */
export function findLegalAction(actions, action) {
  const target = action && typeof action === 'object' ? action : null;
  if (!target || !Array.isArray(actions)) return null;
  for (const candidate of actions) {
    if (!candidate || candidate.kind !== target.kind) continue;
    if (target.kind === 'move') {
      if (candidate.from === target.from && candidate.to === target.to) return candidate;
    } else if (target.kind === 'place') {
      if (candidate.x === target.x && candidate.y === target.y) return candidate;
    } else if (target.kind === 'pass') {
      return candidate;
    }
  }
  return null;
}

function cellSymbol(gameType, cell) {
  if (gameType === 'chess' || gameType === 'xiangqi') {
    return typeof cell.label === 'string' ? cell.label : '';
  }
  if (PLACE_TYPES.has(gameType)) {
    if (cell.value === 0) return '●';
    if (cell.value === 1) return '○';
    return '';
  }
  return typeof cell.label === 'string' ? cell.label : '';
}

/**
 * 把快照 view 展开成按行优先排序的格列表。
 * cells 缺失时按 rows×columns 生成空格；非法坐标被丢弃。
 */
export function buildBoardCells(game) {
  if (!game || typeof game !== 'object') return [];
  const view = game.view && typeof game.view === 'object' ? game.view : {};
  const gameType = game.gameType;
  const rows = Number.isSafeInteger(view.rows) && view.rows > 0 ? view.rows : 0;
  const columns = Number.isSafeInteger(view.columns) && view.columns > 0 ? view.columns : 0;
  let raw = Array.isArray(view.cells) ? view.cells : [];
  if (raw.length === 0 && rows > 0 && columns > 0) {
    raw = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        raw.push({ x, y, value: null, owner: null, label: '' });
      }
    }
  }
  const cells = [];
  for (const cell of raw) {
    if (!cell || typeof cell !== 'object') continue;
    const { x, y } = cell;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) continue;
    if (rows > 0 && y >= rows) continue;
    if (columns > 0 && x >= columns) continue;
    const value = cell.value === 0 || cell.value === 1 ? cell.value : null;
    const owner = cell.owner === 0 || cell.owner === 1 ? cell.owner : value;
    cells.push({
      x,
      y,
      coord: coordFor(gameType, x, y),
      value,
      owner,
      label: typeof cell.label === 'string' ? cell.label : '',
      symbol: cellSymbol(gameType, { ...cell, value }),
      empty: value === null,
    });
  }
  cells.sort((a, b) => (a.y - b.y) || (a.x - b.x));
  return cells;
}

/* ── UI ──────────────────────────────────────────────────────────────────── */

class TabletopError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.name = 'TabletopError';
    this.status = status;
    this.code = code;
  }
}

function errorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message;
  return '操作失败，请稍后再试。';
}

function ownOptionValue(select, value) {
  if (!select || !select.options) return false;
  return [...select.options].some((option) => option.value === value);
}

/**
 * 创建双人棋右侧栏控制器。
 * @param {{getToken: () => (string|null), fetchImpl?: typeof fetch}} options
 */
export function createTabletopUI({ getToken, fetchImpl } = {}) {
  const state = {
    snapshot: null,
    games: new Map(),
    seatOptions: [],
    currentType: DEFAULT_GAME_TYPE,
    view: 'setup',
    setupOpen: true,
    setupPopulated: false,
    setupDirty: false,
    selected: null,
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
    if (!bearer) throw new TabletopError('缺少访问令牌，请重新连接。', 401, 'UNAUTHORIZED');
    const fetchImplFn = fetchFn();
    if (!fetchImplFn) throw new TabletopError('当前环境不支持网络请求。', 0, 'NO_FETCH');

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
      throw new TabletopError('网络错误：无法连接本机服务。', 0, 'NETWORK_ERROR');
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
      throw new TabletopError(message, response.status, code);
    }

    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /* ── 元素与事件绑定 ─────────────────────────────────────────────────── */

  function collectEls() {
    els.dialog = $('tabletop-dialog');
    els.setup = $('tabletop-setup');
    els.setupForm = els.setup && typeof els.setup.elements === 'object' ? els.setup : null;
    els.gameType = formField('game-type');
    els.start = $('tabletop-start');
    els.play = $('tabletop-play');
    els.board = $('tabletop-board');
    els.scores = $('tabletop-scores');
    els.turn = $('tabletop-turn');
    els.status = $('tabletop-status');
    els.error = $('tabletop-error');
    els.moves = $('tabletop-moves');
    els.newButton = $('tabletop-new');
    els.resume = $('tabletop-resume');
    els.pass = $('tabletop-pass');
    els.closeButton = $('tabletop-close');
  }

  function formField(name) {
    if (!els.setupForm || !els.setupForm.elements) return null;
    const field = els.setupForm.elements.namedItem(name);
    return field && typeof field === 'object' && 'value' in field ? field : null;
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
      state.selected = null;
      removeBodyClass();
    });
    on(els.dialog, 'cancel', () => {
      stopStream();
    });

    if (els.setupForm) on(els.setupForm, 'submit', (event) => {
      event.preventDefault();
      startGame();
    });

    if (els.closeButton) on(els.closeButton, 'click', (event) => {
      event.preventDefault();
      close();
    });
    if (els.newButton) on(els.newButton, 'click', (event) => {
      event.preventDefault();
      openSetup();
    });
    if (els.resume) on(els.resume, 'click', (event) => {
      event.preventDefault();
      resumeGame();
    });
    if (els.pass) on(els.pass, 'click', (event) => {
      event.preventDefault();
      submitAction({ kind: 'pass' });
    });

    if (els.gameType) on(els.gameType, 'change', () => {
      handleTypeChange();
    });

    for (let slot = 0; slot < PLAYER_COUNT; slot += 1) {
      const select = formField(`player-${slot}`);
      if (select) on(select, 'change', () => {
        select.dataset.user = '1';
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

  function cleanup() {
    stopStream();
    if (domAbort) domAbort.abort();
    state.bound = false;
  }

  function removeBodyClass() {
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.remove('tabletop-open');
    }
  }

  /* ── 视图 ───────────────────────────────────────────────────────────── */

  function selectedType() {
    const value = els.gameType?.value;
    return GAME_TYPES.includes(value) ? value : state.currentType;
  }

  function currentGame() {
    return gameOf(state.snapshot);
  }

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

  /* ── 设置 ───────────────────────────────────────────────────────────── */

  function playerChoices() {
    const choices = [{ value: 'human', label: '人类' }];
    for (const seat of state.seatOptions) {
      if (!seat?.seatId) continue;
      choices.push({
        value: `ai:${seat.seatId}`,
        label: `AI · ${seat.displayName || seat.seatId}`,
      });
    }
    return choices;
  }

  function fillSelect(select, choices, selected) {
    select.replaceChildren();
    for (const choice of choices) {
      const option = document.createElement('option');
      option.value = choice.value;
      option.textContent = choice.label;
      select.append(option);
    }
    if (selected !== undefined && ownOptionValue(select, selected)) {
      select.value = selected;
    }
  }

  function ensureChoices(select) {
    if (!select) return;
    const hasOption = select.options && select.options.length > 0;
    const hasAi = hasOption && [...select.options].some((option) => option.value.startsWith('ai:'));
    if (!hasAi && state.seatOptions.length > 0) {
      const current = hasOption ? select.value : '';
      fillSelect(select, playerChoices(), current || undefined);
      return;
    }
    if (!hasOption) fillSelect(select, playerChoices(), 'human');
  }

  function selectionName(value, slot) {
    if (value === 'human' || !value) {
      return slot === 0 ? '机主' : `玩家 ${slot + 1}`;
    }
    const seatId = value.startsWith('ai:') ? value.slice(3) : '';
    const seat = state.seatOptions.find((option) => option?.seatId === seatId);
    if (seat) return seat.displayName || seat.seatId;
    const select = formField(`player-${slot}`);
    const option = select?.options ? [...select.options].find((item) => item.value === value) : null;
    if (option?.textContent) {
      return option.textContent.replace(/^AI\s*[·:：-]?\s*/, '').trim() || seatId;
    }
    return seatId;
  }

  function syncName(slot, { force = false } = {}) {
    const select = formField(`player-${slot}`);
    const nameInput = formField(`name-${slot}`);
    if (!select || !nameInput) return;
    if (!force && nameInput.dataset.auto === '0') return;
    nameInput.value = selectionName(select.value, slot);
    nameInput.dataset.auto = '1';
  }

  function defaultSelection(slot) {
    const select = formField(`player-${slot}`);
    if (!select || !select.options || select.options.length === 0) return 'human';
    if (slot === 0) {
      return ownOptionValue(select, 'human') ? 'human' : select.options[0].value;
    }
    const firstAi = [...select.options].find((option) => option.value.startsWith('ai:'));
    if (firstAi) return firstAi.value;
    if (ownOptionValue(select, 'human')) return 'human';
    return select.options[select.options.length - 1].value;
  }

  function populateSetup({ reset = false } = {}) {
    if (els.gameType) {
      if (!GAME_TYPES.includes(els.gameType.value)) els.gameType.value = DEFAULT_GAME_TYPE;
      if (!state.setupPopulated && ownOptionValue(els.gameType, DEFAULT_GAME_TYPE)) {
        els.gameType.value = DEFAULT_GAME_TYPE;
      }
      state.currentType = normalizeGameType(els.gameType.value);
    }

    for (let slot = 0; slot < PLAYER_COUNT; slot += 1) {
      const select = formField(`player-${slot}`);
      const nameInput = formField(`name-${slot}`);
      if (select) {
        ensureChoices(select);
        if (reset || !state.setupPopulated || !select.value) {
          const preset = defaultSelection(slot);
          if (ownOptionValue(select, preset)) select.value = preset;
        } else if (
          slot > 0
          && !state.setupDirty
          && select.dataset.user !== '1'
          && select.value === 'human'
        ) {
          const preset = defaultSelection(slot);
          if (preset.startsWith('ai:') && ownOptionValue(select, preset)) select.value = preset;
        }
      }
      if (nameInput && (reset || !state.setupPopulated || nameInput.dataset.auto !== '0')) {
        syncName(slot, { force: true });
      }
    }
    state.setupPopulated = true;
  }

  function openSetup() {
    state.setupOpen = true;
    state.selected = null;
    setError('');
    populateSetup();
    setView('setup');
    setStatus('选择棋种与两位玩家后点击“开始棋局”。');
    if (els.turn) els.turn.textContent = '尚未开局';
  }

  function collectPlayers() {
    const players = [];
    for (let slot = 0; slot < PLAYER_COUNT; slot += 1) {
      const select = formField(`player-${slot}`);
      const nameInput = formField(`name-${slot}`);
      if (!select) return null;
      const value = select.value;
      const name = nameInput && typeof nameInput.value === 'string'
        ? nameInput.value.trim()
        : '';
      if (value === 'human' || !value) {
        players.push(name ? { kind: 'human', name } : { kind: 'human' });
        continue;
      }
      const seatId = value.startsWith('ai:') ? value.slice(3) : '';
      if (!seatId) return null;
      players.push(name ? { kind: 'ai', seatId, name } : { kind: 'ai', seatId });
    }
    return players;
  }

  /* ── 渲染 ───────────────────────────────────────────────────────────── */

  function renderScores(game) {
    if (!els.scores) return;
    els.scores.replaceChildren();
    const players = Array.isArray(game?.players) ? game.players : [];
    for (let slot = 0; slot < PLAYER_COUNT; slot += 1) {
      const player = playerAt(players, slot);
      const row = el('div', 'tabletop-score');
      row.dataset.slot = String(slot);
      if (game?.status === 'playing' && playerIndex(game.currentPlayer) === slot) {
        row.classList.add('is-current');
      }
      const swatch = el('span', 'tabletop-score-color');
      if (player?.color) swatch.style.background = player.color;
      const name = el('span', 'tabletop-score-name', player?.name || `第 ${slot + 1} 席`);
      const score = el('span', 'tabletop-score-value', String(game?.scores?.[slot] ?? 0));
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
    const name = playerNameOf(game.players, game.currentPlayer);
    if (runtime?.phase === 'thinking') els.turn.textContent = `${name} 正在思考…`;
    else if (runtime?.phase === 'preparing') els.turn.textContent = '正在准备棋局…';
    else if (runtime?.phase === 'error') els.turn.textContent = `${name} 出错了`;
    else els.turn.textContent = `轮到 ${name}`;
  }

  function statusLine(snapshot) {
    const game = gameOf(snapshot);
    const runtime = snapshot?.runtime;
    if (!game) return '尚未开局。';
    if (state.movePending) return '正在提交着法…';
    if (game.status === 'finished') {
      return winnerText(game) === '平局' ? '平局：双方不分胜负。' : `棋局结束：${winnerText(game)}。`;
    }
    if (runtime?.phase === 'error') return runtime.message || 'AI 出错，可点击“继续棋局”重试。';
    if (runtime?.phase === 'preparing') return '正在准备棋局…';
    if (runtime?.phase === 'thinking') return runtime.message || 'AI 正在思考…';
    if (!canHumanMove(snapshot)) {
      if (runtime?.phase === 'idle') return '等待服务端进入可落子状态。';
      return '等待对方行动…';
    }
    if (isMoveGame(game.gameType)) {
      return state.selected
        ? `已选中 ${state.selected}，请点击目标格。`
        : '请选择己方棋子。';
    }
    return game.gameType === 'go'
      ? '请点击一个空点落子，或点击“停一手”。'
      : '请点击一个空点落子。';
  }

  function renderStatus(snapshot) {
    setStatus(statusLine(snapshot));
  }

  function renderMoves(game) {
    if (!els.moves) return;
    els.moves.replaceChildren();
    const moves = Array.isArray(game?.moves) ? game.moves : [];
    if (moves.length === 0) {
      els.moves.append(el('li', 'tabletop-move-empty', '暂无着法'));
      return;
    }
    const shown = moves.slice(-RECENT_MOVE_LIMIT);
    const offset = moves.length - shown.length;
    shown.forEach((move, index) => {
      const step = offset + index + 1;
      const name = move && typeof move === 'object'
        ? playerNameOf(game.players, move.player ?? move.slot ?? move.playerSlot)
        : '';
      const action = formatAction(game.gameType, moveAction(move));
      const parts = [`第 ${move?.seq ?? step} 手`];
      if (name) parts.push(name);
      if (action) parts.push(action);
      const item = el('li', 'tabletop-move', parts.join(' · '));
      const comment = moveComment(move);
      if (comment) item.append(el('div', 'tabletop-move-comment', comment));
      els.moves.append(item);
    });
  }

  function renderResume(snapshot) {
    if (!els.resume) return;
    const game = gameOf(snapshot);
    const runtime = snapshot?.runtime;
    const current = playerAt(game?.players, game?.currentPlayer);
    const phase = runtime?.phase;
    const needsResume = game?.status === 'playing'
      && current?.kind === 'ai'
      && (phase === 'error' || phase === 'idle' || phase === undefined || phase === null);
    els.resume.hidden = !needsResume;
    els.resume.disabled = state.resuming;
    els.resume.textContent = state.resuming ? '继续中…' : '继续棋局';
  }

  function renderPass(snapshot) {
    if (!els.pass) return;
    const game = gameOf(snapshot);
    const show = game?.gameType === 'go' && game?.status === 'playing';
    els.pass.hidden = !show;
    const hasPass = legalActionsOf(game).some((action) => action.kind === 'pass');
    els.pass.disabled = !(show && hasPass && canHumanMove(snapshot) && !state.movePending);
  }

  function cellAriaLabel(cell) {
    const base = cell.coord || `${cell.x},${cell.y}`;
    return cell.symbol ? `${base} ${cell.symbol}` : base;
  }

  function renderBoard(snapshot) {
    if (!els.board) return;
    const game = gameOf(snapshot);
    const board = els.board;
    board.replaceChildren();
    if (!game) return;

    const type = game.gameType;
    const view = game.view && typeof game.view === 'object' ? game.view : {};
    const rows = Number.isSafeInteger(view.rows) && view.rows > 0 ? view.rows : 0;
    const columns = Number.isSafeInteger(view.columns) && view.columns > 0 ? view.columns : 0;
    const cells = buildBoardCells(game);
    board.dataset.gameType = type;
    board.dataset.rows = String(rows);
    board.dataset.columns = String(columns);
    board.setAttribute('role', 'grid');
    board.setAttribute('aria-label', `${gameLabel(type)}棋盘`);
    board.style.display = 'grid';
    if (columns > 0) board.style.gridTemplateColumns = `repeat(${columns}, minmax(0, 1fr))`;

    const interactive = canHumanMove(snapshot) && !state.movePending && !state.starting;
    const legal = legalActionsOf(game);
    const moveGame = isMoveGame(type);

    for (const cell of cells) {
      const button = el('button', 'tabletop-cell');
      button.type = 'button';
      button.dataset.x = String(cell.x);
      button.dataset.y = String(cell.y);
      button.dataset.coord = cell.coord;
      button.style.gridRow = String(cell.y + 1);
      button.style.gridColumn = String(cell.x + 1);
      button.style.aspectRatio = '1';
      button.textContent = cell.symbol;
      if (cell.owner === 0 || cell.owner === 1) {
        button.classList.add(`is-owner-${cell.owner}`);
        button.dataset.owner = String(cell.owner);
      }
      if (cell.empty) button.classList.add('is-empty');
      if (type !== 'go' && (cell.x + cell.y) % 2 === 1) button.classList.add('is-dark');
      if (cell.empty && cell.owner !== null && type === 'go') button.classList.add('is-territory');

      let enabled = false;
      if (interactive && moveGame) {
        const selectable = legal.some((action) => (
          action.kind === 'move' && action.from === cell.coord
        ));
        const target = state.selected !== null && legal.some((action) => (
          action.kind === 'move'
          && action.from === state.selected
          && action.to === cell.coord
        ));
        if (target) {
          button.classList.add('is-target');
          enabled = true;
        } else if (selectable) {
          button.classList.add('is-selectable');
          enabled = true;
        }
      } else if (interactive && !moveGame) {
        const action = findLegalAction(legal, { kind: 'place', x: cell.x, y: cell.y });
        if (action) {
          button.classList.add('is-playable');
          enabled = true;
        }
      }

      if (state.selected === cell.coord) {
        button.classList.add('is-selected');
        button.setAttribute('aria-pressed', 'true');
      }
      if (!enabled) {
        button.disabled = true;
      } else {
        button.addEventListener('click', () => handleCell(cell));
      }
      button.setAttribute('aria-label', cellAriaLabel(cell));
      board.append(button);
    }
  }

  function renderPlay(snapshot) {
    state.snapshot = snapshot;
    const game = gameOf(snapshot);
    if (!game) {
      openSetup();
      return;
    }
    renderScores(game);
    renderTurn(game, snapshot.runtime);
    renderStatus(snapshot);
    renderMoves(game);
    renderResume(snapshot);
    renderPass(snapshot);
    renderBoard(snapshot);
    if (els.newButton) {
      els.newButton.textContent = game.status === 'finished' ? '再来一局' : '新棋局';
    }
  }

  function showSetup(snapshot) {
    if (snapshot) state.snapshot = snapshot;
    state.selected = null;
    setError('');
    if (els.scores) els.scores.replaceChildren();
    if (els.moves) els.moves.replaceChildren();
    if (els.turn) els.turn.textContent = '尚未开局';
    if (els.board) els.board.replaceChildren();
    populateSetup();
    setView('setup');
    setStatus('选择棋种与两位玩家后点击“开始棋局”。');
  }

  function applySnapshot(snapshot, { forceView = false } = {}) {
    if (!snapshot) return false;
    const game = gameOf(snapshot);
    if (!game) {
      if (!state.setupOpen && forceView) showSetup(snapshot);
      return false;
    }
    state.games.set(game.gameType, snapshot);
    if (game.gameType !== selectedType()) return false;
    if (state.setupOpen && !forceView) return false;
    state.setupOpen = false;
    setView('play');
    renderPlay(snapshot);
    return true;
  }

  /* ── 动作 ───────────────────────────────────────────────────────────── */

  async function loadType(type, { auto = false } = {}) {
    const payload = await request(`/api/tabletop?gameType=${encodeURIComponent(type)}`);
    const snapshot = normalizeSnapshot(payload);
    if (!snapshot) return null;
    if (Array.isArray(snapshot.seatOptions) && snapshot.seatOptions.length > 0) {
      state.seatOptions = snapshot.seatOptions.filter((seat) => seat?.seatId);
      if (!state.setupDirty) populateSetup();
    }
    const game = gameOf(snapshot);
    if (!game) {
      if (auto && type === selectedType()) showSetup(snapshot);
      return snapshot;
    }
    state.games.set(game.gameType, snapshot);
    if (auto && game.gameType === selectedType()) {
      state.setupOpen = false;
      setView('play');
      renderPlay(snapshot);
    } else if (!state.setupOpen && game.gameType === selectedType()) {
      setView('play');
      renderPlay(snapshot);
    }
    return snapshot;
  }

  function refresh() {
    return loadType(selectedType(), { auto: !state.setupOpen });
  }

  async function startGame() {
    if (state.startingLock) return;
    collectEls();
    state.currentType = selectedType();
    const type = state.currentType;

    const existing = state.games.get(type);
    if (existing && gameOf(existing)) {
      const confirmFn = typeof globalThis.confirm === 'function'
        ? globalThis.confirm.bind(globalThis)
        : null;
      if (confirmFn && !confirmFn(`当前「${gameLabel(type)}」已有棋局，开始新局会覆盖它，继续吗？`)) {
        return;
      }
    }

    const players = collectPlayers();
    if (!players) {
      setError('玩家配置不完整，请检查两个席位。');
      return;
    }

    state.startingLock = true;
    state.starting = true;
    setError('');
    if (els.start) els.start.disabled = true;
    try {
      const payload = await request('/api/tabletop/new', {
        method: 'POST',
        body: { gameType: type, players },
      });
      const snapshot = normalizeSnapshot(payload);
      state.setupOpen = false;
      state.setupDirty = false;
      state.selected = null;
      if (snapshot && applySnapshot(snapshot, { forceView: true })) return;
      await loadType(type, { auto: true });
    } catch (error) {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    } finally {
      state.starting = false;
      state.startingLock = false;
      if (els.start) els.start.disabled = false;
      if (state.snapshot && !state.setupOpen) renderPlay(state.snapshot);
    }
  }

  async function resumeGame() {
    if (state.resuming) return;
    const game = currentGame();
    if (!game) return;
    const type = game.gameType;
    state.resuming = true;
    setError('');
    renderResume(state.snapshot);
    try {
      const payload = await request('/api/tabletop/resume', {
        method: 'POST',
        body: { gameType: type },
      });
      const snapshot = normalizeSnapshot(payload);
      if (!snapshot || !applySnapshot(snapshot, { forceView: true })) {
        await loadType(type, { auto: true });
      }
    } catch (error) {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    } finally {
      state.resuming = false;
      renderResume(state.snapshot);
    }
  }

  async function submitAction(action) {
    if (state.movePending || state.starting) return;
    const snapshot = state.snapshot;
    const game = gameOf(snapshot);
    if (!game || !canHumanMove(snapshot)) return;
    const type = game.gameType;
    state.movePending = action;
    state.selected = null;
    setError('');
    renderPlay(snapshot);
    try {
      const payload = await request('/api/tabletop/move', {
        method: 'POST',
        body: { gameType: type, action },
      });
      const next = normalizeSnapshot(payload);
      if (!next || !applySnapshot(next, { forceView: true })) {
        await loadType(type, { auto: true });
      }
    } catch (error) {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    } finally {
      state.movePending = null;
      if (state.snapshot) renderPlay(state.snapshot);
    }
  }

  function handleCell(cell) {
    if (state.movePending || state.starting) return;
    const snapshot = state.snapshot;
    const game = gameOf(snapshot);
    if (!game || !canHumanMove(snapshot)) return;
    const legal = legalActionsOf(game);

    if (isMoveGame(game.gameType)) {
      if (state.selected !== null) {
        const action = findLegalAction(legal, {
          kind: 'move',
          from: state.selected,
          to: cell.coord,
        });
        if (action) {
          submitAction({ kind: 'move', from: state.selected, to: cell.coord });
          return;
        }
      }
      const selectable = legal.some((action) => (
        action.kind === 'move' && action.from === cell.coord
      ));
      state.selected = selectable
        ? (state.selected === cell.coord ? null : cell.coord)
        : null;
      renderPlay(snapshot);
      return;
    }

    const action = findLegalAction(legal, { kind: 'place', x: cell.x, y: cell.y });
    if (action) submitAction({ kind: 'place', x: cell.x, y: cell.y });
  }

  function handleTypeChange() {
    const type = selectedType();
    state.currentType = type;
    state.selected = null;
    setError('');
    if (!state.setupOpen) {
      const cached = state.games.get(type);
      if (cached && gameOf(cached)) {
        state.snapshot = cached;
        setView('play');
        renderPlay(cached);
      } else {
        state.snapshot = null;
        setView('setup');
      }
    } else {
      setStatus('选择棋种与两位玩家后点击“开始棋局”。');
    }
    loadType(type, { auto: !state.setupOpen }).catch((error) => {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    });
  }

  /* ── 独立 SSE 流 ────────────────────────────────────────────────────── */

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
    if (envelope.event !== 'GameChanged') return;
    let data;
    try {
      data = JSON.parse(envelope.data);
    } catch {
      return;
    }
    const eventId = envelope.id ?? data?.eventId ?? null;
    if (!deduper.accept(eventId)) return;
    const snapshot = normalizeSnapshot(data?.snapshot ?? data);
    if (!snapshot) return;
    const game = gameOf(snapshot);
    if (!game || game.gameType !== selectedType()) return;
    state.games.set(game.gameType, snapshot);
    applySnapshot(snapshot);
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
      const response = await fetchImplFn('/api/tabletop/events', {
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

  /* ── 开合 ───────────────────────────────────────────────────────────── */

  function open() {
    if (!bind()) return;
    collectEls();
    setError('');
    state.currentType = selectedType();
    populateSetup();
    if (els.dialog && !els.dialog.open) {
      if (typeof document !== 'undefined' && document.body) {
        document.body.classList.add('tabletop-open');
      }
      if (typeof els.dialog.show === 'function') els.dialog.show();
      else els.dialog.setAttribute('open', '');
    }

    const cached = state.games.get(state.currentType);
    if (cached && gameOf(cached)) {
      state.setupOpen = false;
      state.snapshot = cached;
      setView('play');
      renderPlay(cached);
    } else {
      state.setupOpen = true;
      state.snapshot = null;
      state.selected = null;
      setView('setup');
      setStatus('正在读取棋局…');
    }

    startStream();
    loadType(state.currentType, { auto: true }).catch((error) => {
      if (error?.name !== 'AbortError') setError(errorMessage(error));
    });
  }

  function close() {
    stopStream();
    state.selected = null;
    removeBodyClass();
    if (els.dialog?.open && typeof els.dialog.close === 'function') {
      els.dialog.close();
    } else if (els.dialog) {
      els.dialog.removeAttribute('open');
    }
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
    playAction: submitAction,
    getSnapshot: () => state.snapshot,
  };
}
