import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyMove,
  createGame,
} from '../../games/dots-and-boxes/rules.mjs';
import {
  buildMovePrompt,
  parseAiMove,
  parseAiResponse,
} from '../../games/dots-and-boxes/prompt.mjs';

const COLORS = ['#e9b45f', '#6ea8ff', '#c79bff', '#63d2a4'];

function players() {
  return [
    { slot: 0, kind: 'human', name: '甲', color: COLORS[0], seatId: null, nativeSessionRef: null },
    { slot: 1, kind: 'ai', name: '乙', color: COLORS[1], seatId: 'seat-b', nativeSessionRef: 'sess-b' },
    { slot: 2, kind: 'human', name: '丙', color: COLORS[2], seatId: null, nativeSessionRef: null },
    { slot: 3, kind: 'ai', name: '丁', color: COLORS[3], seatId: 'seat-d', nativeSessionRef: 'sess-d' },
  ];
}

function gameWithMoves(edges) {
  let game = createGame({
    gameId: 'prompt-game',
    players: players(),
    createdAt: '2026-11-11T00:00:00.000Z',
  });
  edges.forEach((edge, index) => {
    game = applyMove(game, {
      player: game.currentPlayer,
      edge,
      at: `2026-11-11T00:00:0${index + 1}.000Z`,
    });
  });
  return game;
}

test('buildMovePrompt describes the board, current player, scores, edges and JSON format', () => {
  const game = gameWithMoves(['h:0:0']);
  const prompt = buildMovePrompt(game, 0);

  assert.match(prompt, /4x4/);
  assert.match(prompt, /40 条边/);
  assert.match(prompt, /当前轮到：slot 0（甲，人类）/);
  assert.match(prompt, /当前比分/);
  assert.match(prompt, /slot 1（乙，AI）：0 格/);
  assert.match(prompt, /已落边（1\/40）/);
  assert.match(prompt, /h:0:0 → slot 0/);
  assert.match(prompt, /最近着法：第 1 手/);
  assert.match(prompt, /所有可用边（39 条/);
  assert.match(prompt, /不使用任何工具|不要使用任何工具/);
  assert.match(prompt, /不要角色扮演/);
  assert.match(prompt, /\{"edge":"h:x:y","comment":"一句简短公开理由"\}/);
  assert.match(prompt, /不超过 80 字/);
  assert.match(prompt, /不要长篇分析/);
  assert.match(prompt, /不要输出隐藏思维链/);

  const availableSection = prompt.split('所有可用边')[1];
  assert.match(availableSection, /- h:0:1/);
  assert.doesNotMatch(availableSection, /- h:0:0\n/);
});

test('buildMovePrompt reports completed boxes and retry reason', () => {
  const game = gameWithMoves(['h:0:0', 'h:0:1', 'v:0:0', 'v:1:0']);
  const prompt = buildMovePrompt(game, 3, { retryReason: '上次回复不是 JSON' });

  assert.match(prompt, /最近着法：第 4 手/);
  assert.match(prompt, /完成格子：b:0:0/);
  assert.match(prompt, /slot 3（丁，AI）：1 格/);
  assert.match(prompt, /上一次尝试的问题：上次回复不是 JSON/);
});

test('parseAiMove accepts plain JSON, fenced JSON and prose with one object', () => {
  assert.equal(parseAiMove('{"edge":"h:0:0"}'), 'h:0:0');
  assert.equal(parseAiMove('  {"edge":"v:3:2"}  '), 'v:3:2');
  assert.equal(parseAiMove('```json\n{"edge":"h:1:2"}\n```'), 'h:1:2');
  assert.equal(parseAiMove('我选择这里：{"edge":"v:0:1"}，请落子。'), 'v:0:1');
  assert.equal(parseAiMove('{"edge":"h:0:0","reason":"完成格子"}'), 'h:0:0');
  assert.equal(parseAiMove('说明文字 {"note":"a\\"b","edge":"h:2:2"} 结束'), 'h:2:2');
  assert.equal(parseAiMove('{"edge":"h:0:0","comment":"守住边"}'), 'h:0:0');
});

test('parseAiResponse returns edge plus a trimmed short comment', () => {
  assert.deepEqual(
    parseAiResponse('{"edge":"h:0:0","comment":"  先占角边，避免送格  "}'),
    { edge: 'h:0:0', comment: '先占角边，避免送格' },
  );
  assert.deepEqual(
    parseAiResponse('```json\n{"edge":"v:3:2","comment":"补第四条边得分"}\n```'),
    { edge: 'v:3:2', comment: '补第四条边得分' },
  );
  assert.deepEqual(
    parseAiResponse('我选这里 {"edge":"h:1:2","comment":"堵住对手的第三个格子"} 请落子。'),
    { edge: 'h:1:2', comment: '堵住对手的第三个格子' },
  );
});

test('parseAiResponse keeps legacy comment-less and reason replies compatible', () => {
  assert.deepEqual(parseAiResponse('{"edge":"h:0:0"}'), { edge: 'h:0:0', comment: '' });
  assert.deepEqual(
    parseAiResponse('{"edge":"h:0:0","reason":"完成格子"}'),
    { edge: 'h:0:0', comment: '完成格子' },
  );
  assert.deepEqual(
    parseAiResponse('{"edge":"h:0:0","comment":"   "}'),
    { edge: 'h:0:0', comment: '' },
  );
  assert.deepEqual(
    parseAiResponse('{"edge":"h:0:0","comment":5}'),
    { edge: 'h:0:0', comment: '' },
  );
  // comment 是字符串时优先于 reason。
  assert.deepEqual(
    parseAiResponse('{"edge":"h:0:0","comment":"新字段","reason":"旧字段"}'),
    { edge: 'h:0:0', comment: '新字段' },
  );
});

test('parseAiResponse truncates an overlong comment to 160 characters', () => {
  const long = '理'.repeat(300);
  const parsed = parseAiResponse(JSON.stringify({ edge: 'v:0:0', comment: long }));
  assert.equal(parsed.edge, 'v:0:0');
  assert.equal(parsed.comment.length, 160);
  assert.equal(parsed.comment, long.slice(0, 160));

  const padded = `  ${'x'.repeat(200)}  `;
  const trimmed = parseAiResponse(JSON.stringify({ edge: 'v:0:0', comment: padded }));
  assert.equal(trimmed.comment, 'x'.repeat(160));
});

test('parseAiResponse returns null for illegal replies', () => {
  const invalid = [
    '',
    '   ',
    '我还没想好',
    '{"comment":"没有边"}',
    '{"edge":5,"comment":"x"}',
    '{"edge":"h:9:9","comment":"x"}',
    '{"edge":"h:0","comment":"x"}',
    '{"edge":"","comment":"x"}',
    '{"foo":"bar","comment":"x"}',
    '"h:0:0"',
    '[]',
    '[{"edge":"h:0:0","comment":"x"}]',
    '```json\n[{"edge":"h:0:0"}]\n```',
    '{"edge":"h:0:0","comment":"x"}{"edge":"h:0:1","comment":"y"}',
    '```json\n{"edge":"h:0:0"}\n```\n```json\n{"edge":"h:0:1"}\n```',
    '```json\n{"edge":"h:0:0"}\n```\n另一个对象 {"edge":"h:0:1"}',
    '{"edge":"h:0:0","comment":"x"',
    null,
    42,
  ];
  for (const text of invalid) {
    assert.equal(parseAiResponse(text), null, `expected null for ${JSON.stringify(text)}`);
  }
});

test('parseAiMove returns null for non-JSON, multiple objects, arrays and invalid edges', () => {
  const invalid = [
    '',
    '   ',
    '我还没想好',
    '{"edge":5}',
    '{"edge":"h:9:9"}',
    '{"edge":"h:0"}',
    '{"edge":""}',
    '{"foo":"bar"}',
    '"h:0:0"',
    '[]',
    '[{"edge":"h:0:0"}]',
    '```json\n[{"edge":"h:0:0"}]\n```',
    '{"edge":"h:0:0"}{"edge":"h:0:1"}',
    '```json\n{"edge":"h:0:0"}\n```\n```json\n{"edge":"h:0:1"}\n```',
    '```json\n{"edge":"h:0:0"}\n```\n另一个对象 {"edge":"h:0:1"}',
    '{"edge":"h:0:0"',
    null,
    42,
  ];
  for (const text of invalid) {
    assert.equal(parseAiMove(text), null, `expected null for ${JSON.stringify(text)}`);
  }
});
