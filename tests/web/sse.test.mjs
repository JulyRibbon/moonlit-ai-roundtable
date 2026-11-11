import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createEventDeduper,
  createSseParser,
  retryDelay,
  shouldReconnect,
} from '../../web/sse.mjs';

function collect({ onRetry } = {}) {
  const events = [];
  const parser = createSseParser({
    onEvent: (event) => events.push(event),
    ...(onRetry === undefined ? {} : { onRetry }),
  });
  return { events, parser };
}

test('parses a complete id/event/data frame', () => {
  const { events, parser } = collect();
  parser.feed('id: 7\nevent: RoomStateChanged\ndata: {"to":"active"}\n\n');
  assert.deepEqual(events, [
    { event: 'RoomStateChanged', data: '{"to":"active"}', id: '7', retry: null },
  ]);
});

test('reassembles fields and line endings split across chunks', () => {
  const { events, parser } = collect();
  const frame = 'id: re_1\nevent: MessagePosted\ndata: hello\n\n';
  for (const char of frame) parser.feed(char);
  assert.deepEqual(events, [
    { event: 'MessagePosted', data: 'hello', id: 're_1', retry: null },
  ]);
});

test('handles a CRLF pair split between two chunks', () => {
  const { events, parser } = collect();
  parser.feed('data: first\r');
  parser.feed('\ndata: second\r\n\r\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'first\nsecond');
});

test('joins multi-line data with newlines', () => {
  const { events, parser } = collect();
  parser.feed('data: line 1\ndata: line 2\ndata: line 3\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'line 1\nline 2\nline 3');
  assert.equal(events[0].event, 'message');
});

test('accepts lone CR as a terminator', () => {
  const { events, parser } = collect();
  parser.feed('event: SpeechStarted\rdata: one\rdata: two\r\r');
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'SpeechStarted');
  assert.equal(events[0].data, 'one\ntwo');
});

test('ignores comment heartbeats and blank frames without data', () => {
  const { events, parser } = collect();
  parser.feed(': heartbeat\n\n');
  parser.feed('event: Snapshot\n\n');
  parser.feed(': ping\nid: 9\n\n');
  parser.feed('data: real\n\n');
  assert.deepEqual(events, [
    { event: 'message', data: 'real', id: '9', retry: null },
  ]);
});

test('keeps last event id and picks up retry hints', () => {
  const retries = [];
  const { events, parser } = collect({ onRetry: (value) => retries.push(value) });
  parser.feed('id: 1\ndata: a\n\n');
  parser.feed('data: b\n\n');
  parser.feed('retry: 2500\n\n');
  assert.equal(events[0].id, '1');
  assert.equal(events[1].id, '1');
  assert.equal(parser.retryMs, 2500);
  assert.deepEqual(retries, [2500]);
  assert.equal(events.length, 2);
});

test('strips a leading BOM and ignores unknown fields', () => {
  const { events, parser } = collect();
  parser.feed('\uFEFFfoo: bar\ndata: ok\n\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].data, 'ok');
});

test('discards an incomplete event when the stream ends', () => {
  const { events, parser } = collect();
  parser.feed('event: MessagePosted\ndata: unfinished\n');
  parser.feed('data: still-open\r');
  parser.end();
  assert.equal(events.length, 0);
  assert.equal(parser.ended, true);
});

test('deduper accepts an id once and passes empty ids through', () => {
  const deduper = createEventDeduper({ limit: 10 });
  assert.equal(deduper.accept('re_1'), true);
  assert.equal(deduper.accept('re_1'), false);
  assert.equal(deduper.accept('re_1'), false);
  assert.equal(deduper.accept('re_2'), true);
  assert.equal(deduper.accept(null), true);
  assert.equal(deduper.accept(null), true);
  assert.equal(deduper.accept(undefined), true);
  assert.equal(deduper.size, 2);
  assert.equal(deduper.has('re_1'), true);
});

test('deduper evicts the oldest id when the limit is reached', () => {
  const deduper = createEventDeduper({ limit: 2 });
  assert.equal(deduper.accept('a'), true);
  assert.equal(deduper.accept('b'), true);
  assert.equal(deduper.accept('c'), true);
  assert.equal(deduper.has('a'), false);
  assert.equal(deduper.has('b'), true);
  assert.equal(deduper.accept('a'), true);
  deduper.reset();
  assert.equal(deduper.size, 0);
});

test('retryDelay grows exponentially and caps at maxMs', () => {
  assert.equal(retryDelay(0, { baseMs: 500, maxMs: 5000, jitter: 0 }), 500);
  assert.equal(retryDelay(1, { baseMs: 500, maxMs: 5000, jitter: 0 }), 1000);
  assert.equal(retryDelay(3, { baseMs: 500, maxMs: 5000, jitter: 0 }), 4000);
  assert.equal(retryDelay(10, { baseMs: 500, maxMs: 5000, jitter: 0 }), 5000);
  assert.equal(retryDelay(-2, { baseMs: 500, maxMs: 5000, jitter: 0 }), 500);
});

test('retryDelay stays deterministic with jitter disabled and bounded with jitter', () => {
  assert.equal(retryDelay(2, { baseMs: 1000, maxMs: 20000, jitter: 0 }), 4000);
  const low = retryDelay(2, {
    baseMs: 1000,
    maxMs: 20000,
    jitter: 0.5,
    random: () => 0,
  });
  const mid = retryDelay(2, {
    baseMs: 1000,
    maxMs: 20000,
    jitter: 0.5,
    random: () => 0.5,
  });
  const high = retryDelay(2, {
    baseMs: 1000,
    maxMs: 20000,
    jitter: 0.5,
    random: () => 1,
  });
  assert.equal(low, 2000);
  assert.equal(mid, 4000);
  assert.equal(high, 6000);
});

test('retryDelay rejects invalid options', () => {
  assert.throws(() => retryDelay(0, { baseMs: 0 }), TypeError);
  assert.throws(() => retryDelay(0, { maxMs: -1 }), TypeError);
  assert.throws(() => retryDelay(0, { jitter: 1.5 }), TypeError);
});

test('shouldReconnect only retries transient or network failures', () => {
  assert.equal(shouldReconnect(0), true);
  assert.equal(shouldReconnect(undefined), true);
  assert.equal(shouldReconnect(401), false);
  assert.equal(shouldReconnect(403), false);
  assert.equal(shouldReconnect(404), false);
  assert.equal(shouldReconnect(408), true);
  assert.equal(shouldReconnect(429), true);
  assert.equal(shouldReconnect(500), true);
  assert.equal(shouldReconnect(503), true);
  assert.equal(shouldReconnect(200), false);
});
