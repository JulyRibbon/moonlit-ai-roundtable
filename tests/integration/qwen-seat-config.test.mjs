import test from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_TYPES, PRODUCTION_CLIENT_TYPES, validateConfig } from '../../server/config.mjs';

const BASE = {
  roomId: 'r_main',
  seats: [
    {
      seatId: 'qwen',
      clientType: 'qwen-code',
      nativeSessionRef: 'sess-qwen-1',
      enabled: true,
      voiceMode: 'external',
      client: { baseUrl: 'http://127.0.0.1:58691' },
    },
  ],
};

test('qwen-code is a production client type', () => {
  assert.ok(CLIENT_TYPES.includes('qwen-code'));
  assert.ok(PRODUCTION_CLIENT_TYPES.includes('qwen-code'));
});

test('config accepts a qwen-code seat with a native session reference', () => {
  const config = validateConfig(BASE);
  assert.equal(config.seats.length, 1);
  assert.equal(config.seats[0].clientType, 'qwen-code');
  assert.equal(config.seats[0].nativeSessionRef, 'sess-qwen-1');
  assert.equal(config.seats[0].client.baseUrl, 'http://127.0.0.1:58691');
  assert.equal(config.seats[0].voiceMode, 'external');
});

test('config rejects a qwen-code seat without nativeSessionRef', () => {
  const raw = {
    ...BASE,
    seats: [{ seatId: 'qwen', clientType: 'qwen-code', enabled: true }],
  };
  assert.throws(
    () => validateConfig(raw),
    (error) => error.code === 'SESSION_REF_REQUIRED' || /nativeSessionRef/.test(error.message),
  );
});
