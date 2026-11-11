import {
  PLAYER_COUNT,
  GameRuleError,
  listAvailableEdges,
  listEdges,
} from './rules.mjs';

const EDGE_SET = new Set(listEdges());
const FENCE_PATTERN = /```(?:json)?\s*([\s\S]*?)```/gi;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertGame(game) {
  if (!isPlainObject(game) || !Array.isArray(game.players) || game.players.length !== PLAYER_COUNT) {
    throw new GameRuleError('GAME_INVALID', 'game must be a valid dots-and-boxes state');
  }
}

function playerLabel(player) {
  return `slot ${player.slot}（${player.name}，${player.kind === 'ai' ? 'AI' : '人类'}）`;
}

function occupiedEdgeLines(game) {
  const lines = [];
  for (const edge of listEdges()) {
    if (!Object.prototype.hasOwnProperty.call(game.edges ?? {}, edge)) continue;
    const owner = game.edges[edge];
    const player = game.players[owner];
    lines.push(`- ${edge} → ${player ? playerLabel(player) : `slot ${owner}`}`);
  }
  return lines;
}

function recentMoveLine(game) {
  const move = Array.isArray(game.moves) ? game.moves.at(-1) : null;
  if (!move) return '最近着法：无（这是本局第一手）。';
  const player = game.players[move.player];
  const completed = Array.isArray(move.completedBoxes) && move.completedBoxes.length > 0
    ? move.completedBoxes.join(', ')
    : '无';
  return `最近着法：第 ${move.seq} 手，${player ? playerLabel(player) : `slot ${move.player}`} 落在 ${move.edge}，完成格子：${completed}。`;
}

function scoreLines(game) {
  return game.players.map((player) => {
    const score = Array.isArray(game.scores) ? game.scores[player.slot] ?? 0 : 0;
    return `- ${playerLabel(player)}：${score} 格`;
  });
}

/**
 * 构造一次独立游戏回合的完整中文提示。提示只描述棋盘与规则，不携带任何人格副本。
 */
export function buildMovePrompt(game, playerSlot, { retryReason } = {}) {
  assertGame(game);
  if (!Number.isInteger(playerSlot) || playerSlot < 0 || playerSlot >= PLAYER_COUNT) {
    throw new GameRuleError('PLAYER_INVALID', `invalid player slot: ${String(playerSlot)}`);
  }
  const player = game.players[playerSlot];
  if (!player) {
    throw new GameRuleError('PLAYER_INVALID', `player slot ${playerSlot} is missing`);
  }

  const available = listAvailableEdges(game);
  const occupied = occupiedEdgeLines(game);
  const lines = [
    '你在进行一局 4x4 点格棋（Dots and Boxes）。这是一个独立的游戏回合：不要使用任何工具，不要角色扮演，不要引用或复述任何人格设定。',
    '',
    '棋盘：4x4 个格子，共 40 条边（横向 20 条 + 纵向 20 条）。',
    '边编号：',
    '- h:x:y 表示第 x 列、第 y 行横边，其中 x=0..3，y=0..4。',
    '- v:x:y 表示第 x 列、第 y 行竖边，其中 x=0..4，y=0..3。',
    '',
    `当前轮到：${playerLabel(player)}。`,
    '当前比分（每完成一个格子得 1 分）：',
    ...scoreLines(game),
    '',
    `已落边（${occupied.length}/40）：`,
    ...(occupied.length > 0 ? occupied : ['- 无']),
    '',
    recentMoveLine(game),
    '',
    `所有可用边（${available.length} 条，必须从中选择一条）：`,
    ...available.map((edge) => `- ${edge}`),
    '',
    '规则与策略：',
    '- 每次选择一条尚未落下的边。',
    '- 如果这一手完成一个或多个格子，你会得分，并继续落子；否则轮到下一位玩家。',
    '- 优先完成格子得分；在不能得分时，尽量避免把某个格子的第四条边留给对手。',
    '- 只能选择上面列出的可用边，不能重复落边，也不能虚构边编号。',
    '- 只输出落子与一句公开短理由，不要长篇分析，不要输出隐藏思维链。',
  ];

  if (typeof retryReason === 'string' && retryReason.trim().length > 0) {
    lines.push('', `上一次尝试的问题：${retryReason.trim()}`);
  }

  lines.push(
    '',
    '请只回复一个 JSON 对象，不要 Markdown 代码块，不要长篇解释：',
    '{"edge":"h:x:y","comment":"一句简短公开理由"}',
    '把 h:x:y 替换为上面某条可用边的编号（横边用 h，竖边用 v）。',
    'comment 是给机主看的公开简短说明（为什么选这条边），不超过 80 字，不要写思考过程。',
  );
  return lines.join('\n');
}

export const AI_COMMENT_MAX_LENGTH = 160;

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
    // 围栏之外若还出现另一个 JSON 对象，视为“多对象”拒绝。
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

function normalizeComment(value) {
  // reason 只是旧格式的兼容别名；两者都不是字符串时统一为空串。
  const raw = typeof value.comment === 'string'
    ? value.comment
    : (typeof value.reason === 'string' ? value.reason : '');
  return raw.trim().slice(0, AI_COMMENT_MAX_LENGTH);
}

/**
 * 只接受恰好一个 JSON 对象中的合法 edge，并提取给机主看的公开短理由。
 * 纯 JSON、```json 围栏、以及“短说明 + 一个 JSON 对象”都支持；
 * comment 缺失或为空时返回 ''，reason 作为旧格式别名兼容。
 * 其余情况（数组、多个对象、缺 edge、非法边编号等）统一返回 null。
 */
export function parseAiResponse(text) {
  const value = candidateObject(text);
  if (value === null) return null;
  if (typeof value.edge !== 'string' || !EDGE_SET.has(value.edge)) return null;
  return { edge: value.edge, comment: normalizeComment(value) };
}

/**
 * 兼容旧调用点：只取 parseAiResponse() 的 edge。
 */
export function parseAiMove(text) {
  return parseAiResponse(text)?.edge ?? null;
}

/**
 * 找出文本中成对花括号组成的候选 JSON 对象。字符串里的花括号会被忽略。
 */
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

function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}
