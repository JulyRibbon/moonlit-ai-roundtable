import test from 'node:test';
import assert from 'node:assert/strict';

import { filterTranscript, modelLabel, shortSessionRef } from '../../web/management.mjs';

test('modelLabel reads native metadata from each client shape', () => {
  assert.equal(modelLabel({ identity: { metadata: { provider: 'deepseek', model: 'deepseek-flash' } } }), 'deepseek-flash');
  assert.equal(modelLabel({ identity: { metadata: { model: 'kimi-k3.1-pro' } } }), 'kimi-k3.1-pro');
  assert.equal(modelLabel({ identity: { metadata: { modelSelection: { lastUsed: { provider: 'glm', model: 'GLM-5.3' } } } } }), 'glm/GLM-5.3');
  assert.equal(modelLabel({ identity: { metadata: { model: { providerId: 'bigmodel-standard-api', modelId: 'GLM-5.3' } } } }), 'bigmodel-standard-api/GLM-5.3');
  assert.equal(modelLabel({}), '模型未知');
});

test('filterTranscript searches text and aliases and filters owner or member', () => {
  const messages = [
    { from: 'owner', seatId: null, text: '今晚喝奶茶', roomSeq: 1 },
    { from: 'member', seatId: 'qwen', text: '账房收到', roomSeq: 2 },
    { from: 'member', seatId: 'kimi', text: '月亮也会记账', roomSeq: 3 },
  ];
  const names = (id) => ({ qwen: '账房小姐', kimi: '月白' })[id] ?? id;
  assert.deepEqual(filterTranscript(messages, { query: '账房', nameFor: names }).map((m) => m.roomSeq), [2]);
  assert.deepEqual(filterTranscript(messages, { query: '月亮', nameFor: names }).map((m) => m.roomSeq), [3]);
  assert.deepEqual(filterTranscript(messages, { seatId: 'owner', nameFor: names }).map((m) => m.roomSeq), [1]);
  assert.deepEqual(filterTranscript(messages, { seatId: 'qwen', nameFor: names }).map((m) => m.roomSeq), [2]);
});

test('shortSessionRef keeps short ids and abbreviates long ids', () => {
  assert.equal(shortSessionRef('sess_123'), 'sess_123');
  assert.equal(shortSessionRef('session_abcdefghijklmnopqrstuvwxyz'), 'session_ab…stuvwxyz');
  assert.equal(shortSessionRef(null), '会话未知');
});
