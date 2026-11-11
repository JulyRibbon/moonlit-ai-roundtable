import {
  TABLETOP_PLAYER_COUNT,
  TABLETOP_TYPE_LABELS,
  getTabletopEngine,
} from './engine.mjs';

export const AI_COMMENT_MAX_LENGTH = 160;
export const AI_COMMENT_PROMPT_MAX_LENGTH = 80;
export const PROMPT_RECENT_MOVE_LIMIT = 5;

const FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/gi;

export class TabletopPromptError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'TabletopPromptError';
    this.code = code;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function playerLabel(player) {
  return `slot ${player.slot}（${player.name}，${player.kind === 'ai' ? 'AI' : '人类'}）`;
}

function describeAction(action) {
  if (!isPlainObject(action)) return JSON.stringify(action);
  const parts = [];
  if (typeof action.kind === 'string') parts.push(action.kind);
  if (typeof action.from === 'string') parts.push(`${action.from}→${action.to}`);
  if (Number.isInteger(action.x)) parts.push(`(${action.x},${action.y})`);
  return parts.length > 0 ? parts.join(' ') : JSON.stringify(action);
}

function recentMoveLines(moves, players) {
  const list = Array.isArray(moves) ? moves.slice(-PROMPT_RECENT_MOVE_LIMIT) : [];
  if (list.length === 0) return ['最近着法：无（这是本局第一手）。'];
  return [
    `最近着法（最多 ${PROMPT_RECENT_MOVE_LIMIT} 手）：`,
    ...list.map((move) => {
      const player = players[move.player];
      const who = player ? playerLabel(player) : `slot ${move.player}`;
      return `- 第 ${move.seq} 手：${who} ${describeAction(move.action)}`;
    }),
  ];
}

/**
 * 构造一次独立桌面对局回合的完整提示。
 * 只包含棋盘、比分、合法动作与最近着法，不携带人格或聊天上下文。
 */
export function buildTabletopPrompt(options = {}) {
  const {
    gameType,
    position,
    players,
    moves,
    playerSlot,
    retryReason,
  } = options ?? {};

  const engine = getTabletopEngine(gameType);
  if (position === null || typeof position !== 'object') {
    throw new TabletopPromptError('POSITION_INVALID', 'buildTabletopPrompt() 需要 position。');
  }
  if (!Array.isArray(players) || players.length !== TABLETOP_PLAYER_COUNT) {
    throw new TabletopPromptError(
      'PLAYERS_INVALID',
      `players 必须恰好包含 ${TABLETOP_PLAYER_COUNT} 席。`,
    );
  }
  if (!Number.isInteger(playerSlot) || playerSlot < 0 || playerSlot >= TABLETOP_PLAYER_COUNT) {
    throw new TabletopPromptError('PLAYER_INVALID', `无效的 player slot：${String(playerSlot)}。`);
  }
  const player = players[playerSlot];
  if (!player) {
    throw new TabletopPromptError('PLAYER_INVALID', `player slot ${playerSlot} 不存在。`);
  }

  const legalActions = engine.listLegalActions(position);
  const scoreLine = players
    .map((entry) => `${entry.name} ${position.scores?.[entry.slot] ?? 0}`)
    .join('，');

  const lines = [
    `你在进行一局独立的${TABLETOP_TYPE_LABELS[gameType]}（${gameType}）对局。`,
    '这是一个纯游戏回合：不要使用任何工具，不要角色扮演，不要引用或复述任何人设或聊天记录。',
    '',
    engine.positionToText(position).replace(/\s+$/, ''),
    '',
    `当前轮到：${playerLabel(player)}。`,
    `当前比分：${scoreLine}。`,
    '',
    `所有合法动作（JSON 数组，共 ${legalActions.length} 个；必须原样选择其中一个）：`,
    JSON.stringify(legalActions),
    '',
    ...recentMoveLines(moves, players),
    '',
    '要求：',
    '- 只能选择上面列出的合法动作，不能虚构动作或坐标。',
    '- 只输出所选动作与一句公开短理由，不要长篇分析，不要输出隐藏思维链。',
  ];

  if (typeof retryReason === 'string' && retryReason.trim().length > 0) {
    lines.push('', `上一次尝试的问题：${retryReason.trim()}`);
  }

  lines.push(
    '',
    '请只回复一个 JSON 对象，不要 Markdown 代码块，不要长篇解释：',
    '{"action":<上面某一个合法动作对象>,"comment":"一句简短公开理由"}',
    `comment 是给机主看的公开简短说明，不超过 ${AI_COMMENT_PROMPT_MAX_LENGTH} 字，不要写思考过程。`,
  );

  return lines.join('\n');
}

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

function findJsonObjects(text) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"' && depth > 0) {
      inString = true;
    } else if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        objects.push(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return objects;
}

function candidateObject(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const fences = [...trimmed.matchAll(FENCE_PATTERN)];
  if (fences.length > 1) return null;

  if (fences.length === 1) {
    const inner = fences[0][1].trim();
    if (inner.length === 0) return null;
    const parsed = parseJson(inner);
    if (!parsed.ok) return null;
    if (findJsonObjects(trimmed).length > 1) return null;
    return isPlainObject(parsed.value) ? parsed.value : null;
  }

  const whole = parseJson(trimmed);
  if (whole.ok) {
    return isPlainObject(whole.value) ? whole.value : null;
  }

  const objects = findJsonObjects(trimmed);
  if (objects.length !== 1) return null;
  const parsed = parseJson(objects[0]);
  if (!parsed.ok) return null;
  return isPlainObject(parsed.value) ? parsed.value : null;
}

function looksLikeAction(value) {
  return isPlainObject(value)
    && (typeof value.kind === 'string'
      || typeof value.from === 'string'
      || Number.isInteger(value.x));
}

function normalizeComment(value) {
  const raw = typeof value.comment === 'string'
    ? value.comment
    : (typeof value.reason === 'string' ? value.reason : '');
  return raw.trim().slice(0, AI_COMMENT_MAX_LENGTH);
}

/**
 * 从 AI 回复中提取 { action, comment }。
 * 支持纯 JSON、```json 围栏、以及“短说明 + 一个 JSON 对象”；
 * 既接受 {"action":{...},"comment":"..."}，也接受直接把动作对象放在顶层。
 * 动作的合法性最终仍由游戏引擎 normalizeAction()/applyTurn() 验证。
 */
export function parseTabletopResponse(text) {
  const value = candidateObject(text);
  if (value === null) return null;

  let action = null;
  if (isPlainObject(value.action)) {
    action = value.action;
  } else if (looksLikeAction(value)) {
    action = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'comment' || key === 'reason') continue;
      action[key] = entry;
    }
  }
  if (!isPlainObject(action) || Object.keys(action).length === 0) return null;

  return {
    action: structuredClone(action),
    comment: normalizeComment(value),
  };
}
