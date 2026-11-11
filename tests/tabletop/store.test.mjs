import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  TABLETOP_TYPES,
  getTabletopEngine,
} from '../../games/tabletop/engine.mjs';
import {
  TabletopStoreError,
  createTabletopStore,
  tabletopStorePath,
} from '../../games/tabletop/store.mjs';

const ROOM_ID = 'r_tabletop_store';
const AT = '2026-11-11T00:00:00.000Z';

function playersFor(kinds = ['human', 'human']) {
  return kinds.map((kind, slot) => ({
    slot,
    kind,
    name: kind === 'ai' ? `AI${slot}` : (slot === 0 ? '机主' : '人类2'),
    color: slot === 0 ? '#e9b45f' : '#6ea8ff',
    seatId: kind === 'ai' ? `s${slot}` : null,
    nativeSessionRef: kind === 'ai' ? `sess-${slot}` : null,
  }));
}

function makeRecord(gameType, overrides = {}) {
  return {
    gameId: `game-${gameType}`,
    gameType,
    players: playersFor(),
    moves: [],
    createdAt: AT,
    updatedAt: AT,
    revision: 0,
    ...overrides,
  };
}

function replayMoves(gameType, count) {
  const engine = getTabletopEngine(gameType);
  let position = engine.createPosition();
  const moves = [];
  for (let index = 0; index < count; index += 1) {
    const action = engine.normalizeAction(engine.listLegalActions(position)[0]);
    moves.push({
      seq: index + 1,
      player: position.currentPlayer,
      action,
      at: `${AT}#${index + 1}`,
      comment: index === 0 ? '第一手' : '',
    });
    position = engine.applyTurn(position, { player: position.currentPlayer, action });
  }
  return { moves, position };
}

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

async function tempDir(context) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'airoom-tabletop-store-'));
  context.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

withCleanup('tabletopStorePath puts every type in its own file under rooms/<room>/games/tabletop', async (context) => {
  const dir = await tempDir(context);
  const seen = new Set();
  for (const gameType of TABLETOP_TYPES) {
    const file = tabletopStorePath({ storeDir: dir, roomId: ROOM_ID, gameType });
    assert.equal(path.basename(file), `${gameType}.json`);
    assert.equal(file.includes(path.join(ROOM_ID, 'games', 'tabletop')), true);
    seen.add(file);
  }
  assert.equal(seen.size, TABLETOP_TYPES.length);
  assert.throws(
    () => tabletopStorePath({ storeDir: dir, roomId: ROOM_ID, gameType: 'shogi' }),
    (error) => error instanceof TabletopStoreError && error.code === 'TABLETOP_TYPE_UNKNOWN',
  );
});

withCleanup('empty archives load as null without creating directories', async (context) => {
  const dir = await tempDir(context);
  for (const gameType of TABLETOP_TYPES) {
    const store = createTabletopStore({ storeDir: dir, roomId: ROOM_ID, gameType });
    assert.equal(await store.load(), null);
    assert.equal(await store.load(), null);
  }
  await assert.rejects(stat(path.join(dir, ROOM_ID)), (error) => error?.code === 'ENOENT');
});

for (const gameType of TABLETOP_TYPES) {
  withCleanup(`${gameType}: save/load replays moves instead of persisting a board`, async (context) => {
    const dir = await tempDir(context);
    const store = createTabletopStore({ storeDir: dir, roomId: ROOM_ID, gameType });
    const { moves, position } = replayMoves(gameType, 2);
    const record = makeRecord(gameType, {
      players: playersFor(['human', 'ai']),
      moves,
      revision: 2,
      updatedAt: moves[1].at,
      // 故意塞入运行时字段，不能写入磁盘，也不能影响恢复。
      position,
      board: position.board,
    });

    await store.save(record);
    const loaded = await store.load();
    assert.notEqual(loaded, null);
    assert.equal(loaded.game.gameId, record.gameId);
    assert.equal(loaded.game.gameType, gameType);
    assert.deepEqual(loaded.game.moves, moves);
    assert.deepEqual(loaded.position, position);

    const raw = JSON.parse(await readFile(store.filePath, 'utf8'));
    assert.deepEqual(Object.keys(raw).sort(), ['game', 'schemaVersion']);
    assert.equal(raw.schemaVersion, 1);
    assert.deepEqual(
      Object.keys(raw.game).sort(),
      ['createdAt', 'gameId', 'gameType', 'moves', 'players', 'revision', 'updatedAt'],
    );
    const text = await readFile(store.filePath, 'utf8');
    assert.equal(text.includes('"board"'), false);
    assert.equal(text.includes('"position"'), false);
    assert.equal(text.includes('"view"'), false);
  });
}

withCleanup('AI nativeSessionRef is persisted privately and restored', async (context) => {
  const dir = await tempDir(context);
  const store = createTabletopStore({ storeDir: dir, roomId: ROOM_ID, gameType: 'gomoku' });
  await store.save(makeRecord('gomoku', { players: playersFor(['human', 'ai']) }));

  const raw = JSON.parse(await readFile(store.filePath, 'utf8'));
  assert.equal(raw.game.players[1].nativeSessionRef, 'sess-1');
  const loaded = await store.load();
  assert.equal(loaded.game.players[1].nativeSessionRef, 'sess-1');
});

withCleanup('bad moves in an archive fail loudly during replay', async (context) => {
  const dir = await tempDir(context);
  const store = createTabletopStore({ storeDir: dir, roomId: ROOM_ID, gameType: 'gomoku' });
  const record = makeRecord('gomoku', {
    moves: [
      { seq: 1, player: 0, action: { kind: 'place', x: 0, y: 0 }, at: AT, comment: '' },
      { seq: 2, player: 1, action: { kind: 'place', x: 0, y: 0 }, at: AT, comment: '' },
    ],
    revision: 2,
  });
  await store.save(record);

  await assert.rejects(
    () => store.load(),
    (error) => {
      assert.ok(error instanceof TabletopStoreError);
      assert.equal(error.code, 'STORE_MOVE_INVALID');
      assert.match(error.message, /第 2 手无法重放/);
      assert.equal(error.details.seq, 2);
      assert.equal(error.details.cause, 'CELL_OCCUPIED');
      return true;
    },
  );
});

withCleanup('structurally invalid records are rejected on save and load', async (context) => {
  const dir = await tempDir(context);
  const store = createTabletopStore({ storeDir: dir, roomId: ROOM_ID, gameType: 'chess' });

  await assert.rejects(
    () => store.save(makeRecord('go')),
    (error) => error instanceof TabletopStoreError && error.code === 'STORE_RECORD_INVALID',
  );
  await assert.rejects(
    () => store.save(makeRecord('chess', {
      moves: [{ seq: 2, player: 0, action: { kind: 'move', from: 'a2', to: 'a3' }, at: AT }],
    })),
    (error) => error instanceof TabletopStoreError && error.code === 'STORE_RECORD_INVALID',
  );

  const chessFile = path.join(dir, ROOM_ID, 'games', 'tabletop', 'chess.json');
  await store.save(makeRecord('chess'));
  await writeFile(
    chessFile,
    JSON.stringify({ schemaVersion: 2, game: makeRecord('chess') }),
    'utf8',
  );
  await assert.rejects(
    () => store.load(),
    (error) => error instanceof TabletopStoreError && error.code === 'STORE_RECORD_INVALID',
  );

  await writeFile(chessFile, '{not json', 'utf8');
  await assert.rejects(
    () => store.load(),
    (error) => error instanceof TabletopStoreError && error.code === 'STORE_JSON_INVALID',
  );
});

withCleanup('writes are atomic and leave no temporary files behind', async (context) => {
  const dir = await tempDir(context);
  const store = createTabletopStore({ storeDir: dir, roomId: ROOM_ID, gameType: 'reversi' });
  await store.save(makeRecord('reversi'));
  await store.save(makeRecord('reversi', { revision: 1, updatedAt: `${AT}#1` }));

  const directory = path.dirname(store.filePath);
  const files = await readdir(directory);
  assert.deepEqual(files, ['reversi.json']);
});
