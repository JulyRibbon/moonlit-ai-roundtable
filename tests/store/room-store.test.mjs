import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createRoomStore, StoreError } from '../../store/room-store.mjs';

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ai-room-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRoom(t) {
  const root = await makeRoot(t);
  const dir = path.join(root, 'room');
  await mkdir(dir, { recursive: true });
  return { root, dir, store: createRoomStore(dir) };
}

function linesOf(raw) {
  assert.ok(raw.endsWith('\n'), 'JSONL file must end with a newline');
  return raw.slice(0, -1).split('\n');
}

test('load() on a missing room returns nulls/empty arrays and creates nothing', async (t) => {
  const root = await makeRoot(t);
  const dir = path.join(root, 'missing-room');
  const store = createRoomStore(dir);

  const loaded = await store.load();

  assert.deepEqual(loaded, {
    room: null,
    schedule: null,
    cursors: null,
    events: [],
    messages: [],
    attempts: [],
    warnings: [],
  });
  await assert.rejects(access(dir), (error) => error.code === 'ENOENT');
  assert.deepEqual(await store.readJsonl('events'), { records: [], warnings: [] });
});

test('appendEvent/appendMessage/appendAttempt write one complete JSON line and reload', async (t) => {
  const { dir, store } = await makeRoom(t);
  const event = {
    schemaVersion: 1,
    eventId: 're_1',
    type: 'MessagePosted',
    roomId: 'r_main',
    roomSeq: 1,
    occurredAt: '2026-11-09T00:00:00.000Z',
    actor: 'owner',
    payload: { note: '第一行\n第二行', unicode: '月白 😀', nested: { ok: true } },
  };
  const message = {
    schemaVersion: 1,
    id: 'm_1',
    roomId: 'r_main',
    roomSeq: 2,
    from: 'seat:kimi',
    text: '你好\n世界',
    createdAt: '2026-11-09T00:00:01.000Z',
  };
  const attempt = {
    attemptId: 'a_1',
    roomId: 'r_main',
    seatId: 'kimi',
    outcome: 'completed',
    usage: { inputTokens: 1, outputTokens: 2 },
  };

  assert.equal(await store.appendEvent(event), event);
  await store.appendMessage(message);
  await store.appendAttempt(attempt);

  for (const [fileName, expected] of [
    ['events.jsonl', event],
    ['transcript.jsonl', message],
    ['attempts.jsonl', attempt],
  ]) {
    const raw = await readFile(path.join(dir, fileName), 'utf8');
    const lines = linesOf(raw);
    assert.equal(lines.length, 1, `${fileName} should contain exactly one line`);
    assert.deepEqual(JSON.parse(lines[0]), expected);
  }

  const loaded = await store.load();
  assert.deepEqual(loaded.events, [event]);
  assert.deepEqual(loaded.messages, [message]);
  assert.deepEqual(loaded.attempts, [attempt]);
  assert.equal(loaded.warnings.length, 0);
});

test('concurrent appends to the same file are serialized and never interleave', async (t) => {
  const { dir, store } = await makeRoom(t);
  const eventCount = 40;
  const messageCount = 30;

  const tasks = [];
  for (let index = 0; index < eventCount; index += 1) {
    tasks.push(store.appendEvent({
      eventId: `e_${index}`,
      roomSeq: index + 1,
      payload: { blob: 'x'.repeat(1024), index },
    }));
  }
  for (let index = 0; index < messageCount; index += 1) {
    tasks.push(store.appendMessage({
      id: `m_${index}`,
      roomSeq: index + 1,
      text: `并发消息 ${index}`,
      createdAt: new Date(Date.UTC(2026, 10, 9, 0, 0, index)).toISOString(),
    }));
  }
  await Promise.all(tasks);

  const eventLines = linesOf(await readFile(path.join(dir, 'events.jsonl'), 'utf8'));
  const messageLines = linesOf(await readFile(path.join(dir, 'transcript.jsonl'), 'utf8'));
  assert.equal(eventLines.length, eventCount);
  assert.equal(messageLines.length, messageCount);

  const eventIds = eventLines.map((line) => JSON.parse(line).eventId);
  const messageIds = messageLines.map((line) => JSON.parse(line).id);
  assert.equal(new Set(eventIds).size, eventCount);
  assert.equal(new Set(messageIds).size, messageCount);
  assert.deepEqual(eventIds, Array.from({ length: eventCount }, (_, i) => `e_${i}`));
  assert.deepEqual(messageIds, Array.from({ length: messageCount }, (_, i) => `m_${i}`));

  const loaded = await store.load();
  assert.equal(loaded.events.length, eventCount);
  assert.equal(loaded.messages.length, messageCount);
  assert.equal(loaded.warnings.length, 0);
});

test('saveCheckpoint writes room/schedule/cursors atomically and treats null as skip', async (t) => {
  const { dir, store } = await makeRoom(t);
  const room = { roomId: 'r_main', state: 'active', lastRoomSeq: 3 };
  const schedule = { mode: 'casual', attemptsUsed: 1, seats: [{ seatId: 'kimi' }] };
  const cursors = { kimi: { lastAcknowledgedRoomSeq: 2 } };

  const result = await store.saveCheckpoint({ room, schedule, cursors });
  assert.deepEqual(result.written, ['room.json', 'schedule.json', 'cursors.json']);

  for (const [fileName, expected] of [
    ['room.json', room],
    ['schedule.json', schedule],
    ['cursors.json', cursors],
  ]) {
    const raw = await readFile(path.join(dir, fileName), 'utf8');
    assert.ok(raw.endsWith('\n'));
    assert.deepEqual(JSON.parse(raw), expected);
  }
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp')), []);

  await store.saveCheckpoint({ room: null, schedule: { mode: 'manual' }, cursors: null });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'room.json'), 'utf8')), room);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(dir, 'schedule.json'), 'utf8')),
    { mode: 'manual' },
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'cursors.json'), 'utf8')), cursors);

  const otherDir = path.join(path.dirname(dir), 'empty-room');
  const otherStore = createRoomStore(otherDir);
  assert.deepEqual(await otherStore.saveCheckpoint({ room: null, schedule: null, cursors: null }), {
    written: [],
  });
  await assert.rejects(access(otherDir), (error) => error.code === 'ENOENT');
});

test('concurrent checkpoint snapshots each leave a complete, parseable file', async (t) => {
  const { dir, store } = await makeRoom(t);

  await Promise.all(Array.from({ length: 20 }, (_, revision) => store.saveCheckpoint({
    room: { roomId: 'r_main', revision, blob: 'y'.repeat(10_000) },
  })));

  const raw = await readFile(path.join(dir, 'room.json'), 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.roomId, 'r_main');
  assert.ok(Number.isSafeInteger(parsed.revision));
  assert.equal(parsed.blob.length, 10_000);
  assert.deepEqual((await readdir(dir)).filter((name) => name.includes('.tmp')), []);
});

test('unserializable records fail before writing and do not poison later appends', async (t) => {
  const { dir, store } = await makeRoom(t);
  const circular = { name: 'loop' };
  circular.self = circular;

  await assert.rejects(
    store.appendEvent(circular),
    (error) => error instanceof StoreError && error.code === 'SERIALIZE_FAILED',
  );
  await assert.rejects(
    store.appendMessage({ id: 'm_big', value: 1n }),
    (error) => error instanceof StoreError && error.code === 'SERIALIZE_FAILED',
  );
  await assert.rejects(
    store.appendAttempt(null),
    (error) => error instanceof StoreError && error.code === 'INVALID_RECORD',
  );
  await assert.rejects(
    store.appendAttempt([]),
    (error) => error instanceof StoreError && error.code === 'INVALID_RECORD',
  );
  await assert.rejects(
    store.saveCheckpoint({ room: circular }),
    (error) => error instanceof StoreError && error.code === 'SERIALIZE_FAILED',
  );
  await assert.rejects(
    store.saveCheckpoint({ schedule: () => {} }),
    (error) => error instanceof StoreError && error.code === 'SERIALIZE_FAILED',
  );

  await assert.rejects(access(path.join(dir, 'events.jsonl')), (error) => error.code === 'ENOENT');
  await assert.rejects(access(path.join(dir, 'room.json')), (error) => error.code === 'ENOENT');

  const payload = { text: 'emoji 😀 and a newline\n', zero: 0, empty: '', list: [1, null] };
  await store.appendEvent({ eventId: 'e_after_failure', payload });
  const loaded = await store.load();
  assert.deepEqual(loaded.events, [{ eventId: 'e_after_failure', payload }]);
});

test('readJsonl rejects a complete bad line with its line number and line content is not logged', async (t) => {
  const { dir, store } = await makeRoom(t);
  await writeFile(
    path.join(dir, 'events.jsonl'),
    '{"eventId":"e1"}\n{"eventId":"e2"}\n{"eventId": broken}\n',
    'utf8',
  );

  let captured;
  await assert.rejects(store.readJsonl('events'), (error) => {
    captured = error;
    return error instanceof StoreError
      && error.code === 'JSONL_PARSE_ERROR'
      && error.details.file === 'events.jsonl'
      && error.details.line === 3;
  });
  assert.match(captured.message, /events\.jsonl:3/);
  assert.doesNotMatch(captured.message, /broken/);

  await assert.rejects(store.load(), (error) => error.code === 'JSONL_PARSE_ERROR');
});

test('an incomplete final line yields prior records plus a warning; complete tail without newline is accepted', async (t) => {
  const { dir, store } = await makeRoom(t);

  await writeFile(
    path.join(dir, 'transcript.jsonl'),
    '{"id":"m1"}\n{"id":"m2"}\n{"id":"m3"',
    'utf8',
  );
  const partial = await store.readJsonl('transcript');
  assert.deepEqual(partial.records, [{ id: 'm1' }, { id: 'm2' }]);
  assert.equal(partial.warnings.length, 1);
  assert.equal(partial.warnings[0].code, 'PARTIAL_TAIL');
  assert.equal(partial.warnings[0].file, 'transcript.jsonl');
  assert.equal(partial.warnings[0].line, 3);

  const loaded = await store.load();
  assert.deepEqual(loaded.messages, [{ id: 'm1' }, { id: 'm2' }]);
  assert.equal(loaded.warnings.length, 1);
  assert.equal(loaded.warnings[0].code, 'PARTIAL_TAIL');

  await writeFile(path.join(dir, 'attempts.jsonl'), '{"attemptId":"a1"}\n{"attemptId":"a2"}', 'utf8');
  const completeTail = await store.readJsonl('attempts');
  assert.deepEqual(completeTail.records, [{ attemptId: 'a1' }, { attemptId: 'a2' }]);
  assert.equal(completeTail.warnings.length, 0);

  await writeFile(path.join(dir, 'events.jsonl'), '', 'utf8');
  assert.deepEqual(await store.readJsonl('events'), { records: [], warnings: [] });
});

test('readJsonl only accepts whitelisted names and rejects path traversal', async (t) => {
  const { store } = await makeRoom(t);

  for (const name of [
    'room',
    'room.json',
    'members',
    '../events',
    'events/../transcript',
    'events.jsonl/..',
    '..\\events',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'TRANSCRIPT',
    '',
  ]) {
    await assert.rejects(
      store.readJsonl(name),
      (error) => error instanceof StoreError && error.code === 'INVALID_JSONL_NAME',
      `name should be rejected: ${JSON.stringify(name)}`,
    );
  }

  for (const name of ['events', 'events.jsonl', 'transcript', 'attempts']) {
    assert.deepEqual(await store.readJsonl(name), { records: [], warnings: [] });
  }
});

test('exportMarkdown renders visible messages in time order and hides PASS/aborted attempts', async (t) => {
  const { dir, store } = await makeRoom(t);
  await store.saveCheckpoint({
    room: { roomId: 'r_main', state: 'confirmed' },
  });

  const messages = [
    {
      id: 'm3', roomId: 'r_main', roomSeq: 4, from: 'seat:glm', text: '第三条',
      createdAt: '2026-11-09T10:02:00.000Z',
    },
    {
      id: 'm_pass', roomId: 'r_main', roomSeq: 5, from: 'seat:deepseek', text: '  [PASS]  ',
      createdAt: '2026-11-09T10:03:00.000Z',
    },
    {
      id: 'm2', roomId: 'r_main', roomSeq: 3, from: 'seat:kimi', text: '第二条',
      createdAt: '2026-11-09T10:01:00.000Z',
    },
    {
      id: 'm_aborted', roomId: 'r_main', roomSeq: 6, from: 'seat:kimi', text: '中止的部分正文',
      outcome: 'aborted', createdAt: '2026-11-09T10:04:00.000Z',
    },
    {
      id: 'm1', roomId: 'r_main', roomSeq: 2, from: 'owner', text: '第一条\n第二行',
      createdAt: '2026-11-09T10:00:00.000Z',
    },
  ];
  for (const message of messages) {
    await store.appendMessage(message);
  }
  await store.appendAttempt({
    attemptId: 'a_pass', seatId: 'deepseek', outcome: 'pass', text: '[PASS]',
  });
  await store.appendAttempt({
    attemptId: 'a_aborted', seatId: 'kimi', outcome: 'aborted', partialText: '仅保留在 attempts',
  });

  const markdown = await store.exportMarkdown();

  assert.match(markdown, /^# Room r_main/m);
  const first = markdown.indexOf('第一条');
  const second = markdown.indexOf('第二条');
  const third = markdown.indexOf('第三条');
  assert.ok(first !== -1 && first < second && second < third, 'messages must be time ordered');
  assert.match(markdown, /— owner/);
  assert.match(markdown, /— seat:kimi/);
  assert.match(markdown, /— seat:glm/);
  assert.ok(markdown.includes('第一条\n第二行'));
  assert.ok(!markdown.includes('[PASS]'));
  assert.ok(!markdown.includes('中止的部分正文'));
  assert.ok(!markdown.includes('仅保留在 attempts'));
  assert.ok(!markdown.includes('a_aborted'));

  const before = (await readdir(dir)).sort();
  await store.exportMarkdown();
  assert.deepEqual((await readdir(dir)).sort(), before);
});

test('checkpoints never receive transcript or persona text', async (t) => {
  const { dir, store } = await makeRoom(t);
  const personaText = '# 月白人格\n你是月白，必须逐字保持这个设定。';
  const room = {
    roomId: 'r_main',
    state: 'active',
    members: [{ seatId: 'kimi', identitySourceRef: 'kimi-code/existing-agent' }],
  };

  await store.appendMessage({
    id: 'm_persona', from: 'seat:kimi', text: personaText, createdAt: '2026-11-09T00:00:00.000Z',
  });
  await store.saveCheckpoint({
    room,
    schedule: null,
    cursors: null,
    // 白名单之外的键即使被传入，也不会写入任何检查点文件。
    messages: [{ text: personaText }],
    transcript: [{ text: personaText }],
  });

  const raw = await readFile(path.join(dir, 'room.json'), 'utf8');
  assert.ok(!raw.includes(personaText));
  assert.ok(!raw.includes('月白人格'));
  assert.deepEqual(JSON.parse(raw), room);
  assert.equal((await readdir(dir)).some((name) => name === 'schedule.json'), false);
  assert.equal((await readdir(dir)).some((name) => name === 'cursors.json'), false);

  const loaded = await store.load();
  assert.deepEqual(loaded.room, room);
  assert.deepEqual(loaded.messages.map((message) => message.text), [personaText]);
  assert.deepEqual(loaded.attempts, []);
});
