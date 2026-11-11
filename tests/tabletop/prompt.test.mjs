import test from 'node:test';
import assert from 'node:assert/strict';

import { getTabletopEngine } from '../../games/tabletop/engine.mjs';
import {
  AI_COMMENT_MAX_LENGTH,
  TabletopPromptError,
  buildTabletopPrompt,
  parseTabletopResponse,
} from '../../games/tabletop/prompt.mjs';

const PLAYERS = [
  { slot: 0, kind: 'human', name: '机主' },
  { slot: 1, kind: 'ai', name: 'AI甲' },
];

function gomokuScenario() {
  const engine = getTabletopEngine('gomoku');
  let position = engine.createPosition();
  const first = engine.normalizeAction(engine.listLegalActions(position)[0]);
  position = engine.applyTurn(position, { player: 0, action: first });
  const moves = [
    { seq: 1, player: 0, action: first, at: 't1', comment: '这是内部附言，不应进入提示' },
  ];
  return { engine, position, moves };
}

test('prompt includes the full board text, scores, legal actions JSON and recent moves', () => {
  const { engine, position, moves } = gomokuScenario();
  const legal = engine.listLegalActions(position);
  const prompt = buildTabletopPrompt({
    gameType: 'gomoku',
    position,
    players: PLAYERS,
    moves,
    playerSlot: 1,
  });

  assert.equal(prompt.includes(engine.positionToText(position).replace(/\s+$/, '')), true);
  assert.equal(prompt.includes(`所有合法动作（JSON 数组，共 ${legal.length} 个`), true);
  assert.equal(prompt.includes(JSON.stringify(legal)), true);
  assert.match(prompt, /当前轮到：slot 1（AI甲，AI）/);
  assert.match(prompt, /当前比分：机主 1，AI甲 0/);
  assert.match(prompt, /最近着法/);
  assert.match(prompt, /第 1 手/);
  assert.match(prompt, /"action":<上面某一个合法动作对象>/);
  assert.match(prompt, /"comment":"一句简短公开理由"/);
  assert.match(prompt, /不超过 80 字/);
  assert.match(prompt, /不要使用任何工具/);
  assert.match(prompt, /不要输出隐藏思维链/);
  assert.equal(prompt.includes('这是内部附言，不应进入提示'), false);
});

test('prompt starts with a first-move marker and appends the retry reason', () => {
  const engine = getTabletopEngine('go');
  const position = engine.createPosition();
  const prompt = buildTabletopPrompt({
    gameType: 'go',
    position,
    players: PLAYERS,
    moves: [],
    playerSlot: 0,
    retryReason: '上次回复不是 JSON。',
  });
  assert.match(prompt, /最近着法：无（这是本局第一手）/);
  assert.match(prompt, /上一次尝试的问题：上次回复不是 JSON。/);
});

test('prompt rejects unknown types and malformed player slots', () => {
  const engine = getTabletopEngine('chess');
  assert.throws(
    () => buildTabletopPrompt({
      gameType: 'shogi',
      position: engine.createPosition(),
      players: PLAYERS,
      moves: [],
      playerSlot: 0,
    }),
    (error) => error?.code === 'TABLETOP_TYPE_UNKNOWN',
  );
  assert.throws(
    () => buildTabletopPrompt({
      gameType: 'chess',
      position: engine.createPosition(),
      players: PLAYERS,
      moves: [],
      playerSlot: 5,
    }),
    (error) => error instanceof TabletopPromptError && error.code === 'PLAYER_INVALID',
  );
});

test('parse accepts a plain action wrapper and trims the comment', () => {
  const parsed = parseTabletopResponse(
    '{"action":{"kind":"place","x":1,"y":2},"comment":"  占住中心  "}',
  );
  assert.deepEqual(parsed, {
    action: { kind: 'place', x: 1, y: 2 },
    comment: '占住中心',
  });
});

test('parse accepts fenced JSON and a short leading explanation', () => {
  const fenced = parseTabletopResponse(
    '我选择这里：\n```json\n{"action":{"kind":"move","from":"a2","to":"a3"},"comment":"推进"}\n```\n',
  );
  assert.deepEqual(fenced.action, { kind: 'move', from: 'a2', to: 'a3' });
  assert.equal(fenced.comment, '推进');

  const leading = parseTabletopResponse(
    '理由是控制中线。 {"action":{"kind":"place","x":3,"y":4},"comment":"中线"}',
  );
  assert.deepEqual(leading.action, { kind: 'place', x: 3, y: 4 });
  assert.equal(leading.comment, '中线');
});

test('parse tolerates a missing comment and accepts a direct action object', () => {
  assert.deepEqual(parseTabletopResponse('{"action":{"kind":"pass"}}'), {
    action: { kind: 'pass' },
    comment: '',
  });
  assert.deepEqual(parseTabletopResponse('{"kind":"place","x":0,"y":0,"comment":"角落"}'), {
    action: { kind: 'place', x: 0, y: 0 },
    comment: '角落',
  });
  assert.deepEqual(parseTabletopResponse('{"action":{"kind":"pass"},"reason":"旧格式"}'), {
    action: { kind: 'pass' },
    comment: '旧格式',
  });
});

test('parse trims comments to the hard limit of 160 characters', () => {
  const long = '长'.repeat(400);
  const parsed = parseTabletopResponse(
    JSON.stringify({ action: { kind: 'pass' }, comment: `  ${long}  ` }),
  );
  assert.equal(parsed.comment.length, AI_COMMENT_MAX_LENGTH);
  assert.equal(AI_COMMENT_MAX_LENGTH, 160);
});

test('parse leaves final legality to the engine', () => {
  const parsed = parseTabletopResponse('{"action":{"kind":"place","x":99,"y":99}}');
  assert.deepEqual(parsed.action, { kind: 'place', x: 99, y: 99 });
  const engine = getTabletopEngine('gomoku');
  assert.throws(() => engine.normalizeAction(parsed.action), (error) => error?.code === 'ACTION_INVALID');
});

test('parse rejects replies without exactly one usable action object', () => {
  for (const text of [
    '',
    '   ',
    '没有 JSON 的纯文本。',
    '[]',
    '"action"',
    '{"comment":"只有理由"}',
    '{"action":"place"}',
    '{"action":{}}',
    '{"action":{"kind":"place","x":1,"y":1}} {"action":{"kind":"pass"}}',
    '```json\n[]\n```',
  ]) {
    assert.equal(parseTabletopResponse(text), null, `expected null for: ${text}`);
  }
  assert.equal(parseTabletopResponse(null), null);
});
