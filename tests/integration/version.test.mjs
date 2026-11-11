import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AI_ROOM_VERSION } from '../../server/version.mjs';
import { startLive } from '../../server/live.mjs';

test('package version, health endpoint and changelog stay aligned', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ai-room-version-'));
  const live = await startLive({
    config: {
      roomId: 'r_version',
      seats: [{ seatId: 'fake', clientType: 'fake', enabled: true, voiceMode: 'none' }],
    },
    stateDir: path.join(dir, 'state'),
    roomDir: path.join(dir, 'room'),
    token: 'version-test',
    port: 0,
  });
  t.after(async () => {
    await live.close();
    await rm(dir, { recursive: true, force: true });
  });

  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(packageJson.version, AI_ROOM_VERSION);
  const health = await (await fetch(`http://127.0.0.1:${live.port}/api/health`)).json();
  assert.deepEqual(health, { ok: true, version: AI_ROOM_VERSION });
  const changelog = await (await fetch(`http://127.0.0.1:${live.port}/changelog.md`)).text();
  assert.match(changelog, new RegExp(`## ${AI_ROOM_VERSION.replace('.', '\\.')}`));
  assert.match(changelog, /重置计数先自动备份/);
});
