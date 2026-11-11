import * as xiangqi from './xiangqi.mjs';
import * as chess from './chess.mjs';
import * as go from './go.mjs';
import * as gomoku from './gomoku.mjs';
import * as reversi from './reversi.mjs';

export const TABLETOP_TYPES = Object.freeze(['xiangqi', 'chess', 'go', 'gomoku', 'reversi']);

export const TABLETOP_PLAYER_COUNT = 2;

export const TABLETOP_TYPE_LABELS = Object.freeze({
  xiangqi: '中国象棋',
  chess: '国际象棋',
  go: '围棋',
  gomoku: '五子棋',
  reversi: '黑白棋',
});

export const TABLETOP_ENGINES = Object.freeze({
  xiangqi,
  chess,
  go,
  gomoku,
  reversi,
});

export class TabletopEngineError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'TabletopEngineError';
    this.code = code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, TabletopEngineError);
    }
  }
}

export function isTabletopType(value) {
  return typeof value === 'string' && TABLETOP_TYPES.includes(value);
}

export function getTabletopEngine(type) {
  if (!isTabletopType(type)) {
    throw new TabletopEngineError(
      'TABLETOP_TYPE_UNKNOWN',
      `未知的桌面对局类型：${String(type)}（可用：${TABLETOP_TYPES.join(', ')}）。`,
    );
  }
  return TABLETOP_ENGINES[type];
}
