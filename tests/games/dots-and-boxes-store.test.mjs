import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  StoreError,
  createGameStore,
} from '../../games/dots-and-boxes/store.mjs';
import { createGame } from '../../games/dots-and-boxes/rules.mjs';

function withCleanup(name, fn) {
  test(name, async (t) => {
    const cleanups = [];
    const context = {
      after(cleanup) {
        cleanups.push(cleanup);
      },
    };
    try {
      await fn(context, t);
    } finally {
      for (let index = cleanups.length - 1; index >= 0; index -= 1) {
        try {
          await cleanups[index]();
        } catch {
          // 清理失败不覆盖测试结果。
        }
      }
    }
  });
}

const COLORS = ['#e9b45f', '#6ea8ff', '#c79bff', '#63d2a4'];

function players() {
  return [
    { slot: 0, kind: 'human', name: '甲', color: COLORS[0], seatId: null, nativeSessionRef: null },
    { slot: 1, kind: 'ai', name: '乙', color: COLORS[1], seatId: 'seat-b', nativeSessionRef: 'sess-b' },
    { slot: 2, kind: 'human', name: '丙', color: COLORS[2], seatId: null, nativeSessionRef: null },
    { slot: 3, kind: 'ai', name: '丁', color: COLORS[3], seatId: 'seat-d', nativeSessionRef: 'sess-d' },
  ];
}

function newGame(overrides = {}) {
  return createGame({
    gameId: 'store-game',
    players: players(),
    createdAt: '2026-11-11T00:00:00.000Z',
    ...overrides,
  });
}

async function tempFile(t, name = 'game.json') {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airoom-dots-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'nested', name) };
}

withCleanup('load returns null for an empty store and does not create directories', async (t) => {
  const { dir, file } = await tempFile(t);
  const store = createGameStore(file);
  assert.equal(await store.load(), null);
  await assert.rejects(readFile(path.join(dir, 'nested')), (error) => error?.code === 'ENOENT');
});

withCleanup('save writes only {schemaVersion:1,game} and load roundtrips it', async (t) => {
  const { file } = await tempFile(t);
  const store = createGameStore(file);
  const game = newGame();
  const returned = await store.save(game);
  assert.deepEqual(returned, game);

  const text = await readFile(file, 'utf8');
  const record = JSON.parse(text);
  assert.deepEqual(Object.keys(record).sort(), ['game', 'schemaVersion']);
  assert.equal(record.schemaVersion, 1);
  assert.deepEqual(record.game, game);
  assert.ok(record.game.players.some((player) => player.nativeSessionRef === 'sess-b'));

  assert.deepEqual(await store.load(), game);
});

withCleanup('load reports corrupt JSON and invalid records with explicit StoreError codes', async (t) => {
  const { dir, file } = await tempFile(t);
  await mkdir(path.dirname(file), { recursive: true });
  const store = createGameStore(file);

  await writeFile(file, '{not json', 'utf8');
  await assert.rejects(store.load(), (error) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, 'STORE_JSON_INVALID');
    return true;
  });

  await writeFile(file, JSON.stringify({ schemaVersion: 2, game: {} }), 'utf8');
  await assert.rejects(store.load(), (error) => {
    assert.ok(error instanceof StoreError);
    assert.equal(error.code, 'STORE_RECORD_INVALID');
    return true;
  });

  await writeFile(file, JSON.stringify({ schemaVersion: 1, game: null }), 'utf8');
  await assert.rejects(store.load(), (error) => error?.code === 'STORE_RECORD_INVALID');
});

withCleanup('concurrent saves are serialized and never leave a torn file', async (t) => {
  const { file } = await tempFile(t);
  const store = createGameStore(file);
  const otherStore = createGameStore(file);
  const base = newGame();

  const writes = [];
  for (let revision = 0; revision < 30; revision += 1) {
    writes.push((revision % 2 === 0 ? store : otherStore).save({
      ...base,
      gameId: `store-game-${revision}`,
      revision,
    }));
  }
  await Promise.all(writes);

  const raw = await readFile(file, 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.schemaVersion, 1);
  assert.match(record.game.gameId, /^store-game-\d+$/);
  assert.equal(record.game.gameId, `store-game-${record.game.revision}`);

  const loaded = await store.load();
  assert.equal(loaded.gameId, `store-game-${loaded.revision}`);
  assert.equal(loaded.moves.length, 0);
});
