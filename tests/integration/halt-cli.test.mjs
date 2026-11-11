import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '../..');
const HALT_CLI = path.join(PROJECT_ROOT, 'scripts/halt.mjs');
const START_BAT = path.join(PROJECT_ROOT, 'start.bat');
const KILL_BAT = path.join(PROJECT_ROOT, 'kill.bat');

function runCli(args, stateDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HALT_CLI, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, AIROOM_STATE_DIR: stateDir },
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

async function makeTempState(t, label = 'airoom-halt-cli-') {
  const root = await mkdtemp(path.join(os.tmpdir(), label));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, stateDir: path.join(root, 'state') };
}

function readJson(text) {
  return JSON.parse(text);
}

async function readAudit(stateDir) {
  const file = path.join(stateDir, 'audit.jsonl');
  const text = await readFile(file, 'utf8');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function sentinelFiles(stateDir) {
  if (!existsSync(stateDir)) return [];
  return (await readdir(stateDir)).filter((name) => name === 'HALT' || name.startsWith('HALT.'));
}

test('halt CLI --all writes the global sentinel and returns a real receipt', async (t) => {
  const { stateDir } = await makeTempState(t);

  const result = await runCli(['--all'], stateDir);
  assert.equal(result.code, 0, result.stderr);
  const receipt = readJson(result.stdout);

  assert.equal(receipt.ok, true);
  assert.equal(receipt.stopped, true);
  assert.equal(receipt.halted, true);
  assert.equal(receipt.sentinelWritten, true);
  assert.equal(receipt.scope, 'all');
  assert.equal(receipt.roomId, null);
  assert.equal(receipt.mode, 'halt');
  assert.equal(receipt.sentinelPath, path.join(stateDir, 'HALT'));
  assert.match(receipt.note, /下一个检查点/);
  assert.match(receipt.note, /不连接引擎/);
  assert.match(receipt.note, /不代表远端调用已经取消/);

  const sentinel = readJson(await readFile(path.join(stateDir, 'HALT'), 'utf8'));
  assert.equal(sentinel.schemaVersion, 1);
  assert.equal(sentinel.type, 'Halt');
  assert.equal(sentinel.scope, 'all');
  assert.equal(sentinel.roomId, null);
  assert.equal(sentinel.actor, 'halt-cli');
  assert.equal(sentinel.mode, 'halt');
  assert.ok(!Number.isNaN(Date.parse(sentinel.at)));

  const audit = await readAudit(stateDir);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event, 'halt.request');
  assert.equal(audit[0].scope, 'all');
  assert.equal(audit[0].actor, 'halt-cli');
  assert.equal(audit[0].sentinelWritten, true);

  // 没有引擎/房间目录等副作用，只留下哨兵与审计。
  assert.deepEqual((await readdir(stateDir)).sort(), ['HALT', 'audit.jsonl']);
});

test('halt CLI defaults to --all when no scope argument is given', async (t) => {
  const { stateDir } = await makeTempState(t);
  const result = await runCli([], stateDir);
  assert.equal(result.code, 0, result.stderr);
  const receipt = readJson(result.stdout);
  assert.equal(receipt.scope, 'all');
  assert.equal(receipt.roomId, null);
  assert.ok(existsSync(path.join(stateDir, 'HALT')));
});

test('halt CLI --room writes only that room sentinel', async (t) => {
  const { stateDir } = await makeTempState(t);

  for (const args of [['--room', 'room-a'], ['--room=room_a-2']]) {
    const result = await runCli(args, stateDir);
    assert.equal(result.code, 0, result.stderr);
    const receipt = readJson(result.stdout);
    assert.equal(receipt.scope, 'room');
    assert.equal(receipt.roomId, args[0] === '--room' ? 'room-a' : 'room_a-2');
    assert.equal(receipt.sentinelWritten, true);
    assert.equal(
      receipt.sentinelPath,
      path.join(stateDir, `HALT.${receipt.roomId}`),
    );
  }

  assert.deepEqual((await sentinelFiles(stateDir)).sort(), ['HALT.room-a', 'HALT.room_a-2']);
  assert.equal(existsSync(path.join(stateDir, 'HALT')), false);

  const audit = await readAudit(stateDir);
  assert.equal(audit.length, 2);
  for (const event of audit) {
    assert.equal(event.event, 'halt.request');
    assert.equal(event.scope, 'room');
    assert.equal(event.sentinelWritten, true);
  }
  assert.deepEqual(audit.map((event) => event.roomId), ['room-a', 'room_a-2']);
});

test('repeating the same halt request is idempotent and keeps the first sentinel', async (t) => {
  const { stateDir } = await makeTempState(t);

  const first = await runCli(['--all'], stateDir);
  assert.equal(first.code, 0, first.stderr);
  const sentinelPath = path.join(stateDir, 'HALT');
  const firstSentinel = await readFile(sentinelPath, 'utf8');

  const second = await runCli(['--all'], stateDir);
  assert.equal(second.code, 0, second.stderr);
  const secondReceipt = readJson(second.stdout);
  assert.equal(secondReceipt.sentinelWritten, true);
  assert.equal(secondReceipt.stopped, true);

  assert.equal(await readFile(sentinelPath, 'utf8'), firstSentinel);

  const audit = await readAudit(stateDir);
  assert.equal(audit.length, 2);
  assert.deepEqual(audit.map((event) => event.event), ['halt.request', 'halt.request']);
});

test('invalid room ids and malformed arguments exit 2 without writing a sentinel', async (t) => {
  const { root, stateDir } = await makeTempState(t);

  for (const [args, code] of [
    [['--room', '../escape'], 'INVALID_ROOM_ID'],
    [['--room', 'bad room'], 'INVALID_ROOM_ID'],
    [['--room', 'a/b'], 'INVALID_ROOM_ID'],
    [['--room='], 'CLI_VALUE_REQUIRED'],
    [['--room'], 'CLI_VALUE_REQUIRED'],
    [['--bogus'], 'CLI_UNKNOWN_ARGUMENT'],
    [['--all', '--room', 'room-a'], 'CLI_CONFLICT'],
  ]) {
    const result = await runCli(args, stateDir);
    assert.equal(result.code, 2, `args ${JSON.stringify(args)} should exit 2: ${result.stderr}`);
    const error = readJson(result.stderr.split('\n')[0]);
    assert.equal(error.ok, false);
    assert.equal(error.code, code, `args ${JSON.stringify(args)}: ${result.stderr}`);
    assert.match(result.stderr, /用法：/);
  }

  assert.equal(existsSync(stateDir), false, 'invalid input must not create the state directory');
  assert.deepEqual(await readdir(root), []);
});

test('halt CLI never connects to engines, bridges, servers, network or child processes', async () => {
  const source = await readFile(HALT_CLI, 'utf8');
  const imports = source.match(/^import[\s\S]*?from '[^']+';/gm) ?? [];
  const specifiers = imports.map((statement) => /from '([^']+)'/.exec(statement)?.[1]);

  assert.deepEqual(
    specifiers.sort(),
    ['../core/halt.mjs', 'node:path', 'node:url'].sort(),
  );
  assert.doesNotMatch(source, /from\s+'[^']*(adapters|engine|server)[^']*'/);
  assert.doesNotMatch(source, /\bfetch\s*\(|\bchild_process\b|node:http|node:net|WebSocket/);
});

test('start.bat statically selects Node, guards version, and passes config/port through', async () => {
  const source = await readFile(START_BAT, 'utf8');

  assert.match(source, /\r\n/, 'batch file should keep CRLF line endings');
  assert.match(source, /AIROOM_NODE/);
  assert.match(source, /DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node\.exe/);
  assert.match(source, /process\.versions\.node/);
  assert.match(source, /22/);
  assert.match(source, /13/);
  assert.match(source, /process\.exit\(1\)/);
  assert.match(source, /config\\members\.local\.json/);
  assert.match(source, /members\.example\.json/);
  assert.match(source, /server\\live\.mjs/);
  assert.match(source, /--config/);
  assert.match(source, /--port/);
  assert.match(source, /exit \/b 1/);
  assert.doesNotMatch(source, /AIROOM_TOKEN|echo.*token/i);
});

test('kill.bat statically calls the halt CLI with --all/--room and the same Node guard', async () => {
  const source = await readFile(KILL_BAT, 'utf8');

  assert.match(source, /\r\n/, 'batch file should keep CRLF line endings');
  assert.match(source, /AIROOM_NODE/);
  assert.match(source, /DeepSeek Harness\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node\.exe/);
  assert.match(source, /process\.versions\.node/);
  assert.match(source, /22/);
  assert.match(source, /13/);
  assert.match(source, /process\.exit\(1\)/);
  assert.match(source, /scripts\\halt\.mjs/);
  assert.match(source, /--all/);
  assert.match(source, /--room/);
  assert.match(source, /exit \/b %HALT_EXIT%/);
  assert.match(source, /goto :done/);
  assert.doesNotMatch(source, /AIROOM_TOKEN|Bearer|token/i);
  assert.doesNotMatch(source, /\/api\//);
});
