import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HALT_FILENAME,
  HALT_MODES,
  HALT_SCOPES,
  createHaltGuard,
} from '../core/halt.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_STATE_DIR = path.join(PROJECT_ROOT, 'state');
const ACTOR = 'halt-cli';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = [
  '用法：node scripts/halt.mjs [--all | --room <safeRoomId>]',
  '',
  '默认 --all：写入全局停止哨兵；--room 只停止指定房间。',
  '状态目录默认 <项目>/state，可用 AIROOM_STATE_DIR 覆盖。',
  '本命令只写哨兵并在下一个检查点生效，不连接引擎、不调用模型，',
  '也不代表远端或客户端中的调用已经被取消。',
].join('\n');

export class HaltCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HaltCliError';
    this.code = code;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, HaltCliError);
    }
  }
}

export function parseHaltArgs(argv = process.argv.slice(2)) {
  const result = { scope: HALT_SCOPES.ALL, roomId: null, help: false };
  let allRequested = false;
  let roomRequested = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--all') {
      allRequested = true;
      result.scope = HALT_SCOPES.ALL;
      result.roomId = null;
      continue;
    }

    let roomId;
    if (arg === '--room') {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('-')) {
        throw new HaltCliError('CLI_VALUE_REQUIRED', '--room 需要一个房间 id。');
      }
      roomId = next;
      index += 1;
    } else if (arg.startsWith('--room=')) {
      roomId = arg.slice('--room='.length);
      if (roomId.length === 0) {
        throw new HaltCliError('CLI_VALUE_REQUIRED', '--room 需要一个房间 id。');
      }
    } else {
      throw new HaltCliError('CLI_UNKNOWN_ARGUMENT', `未知参数：${arg}。`);
    }

    roomRequested = true;
    result.scope = HALT_SCOPES.ROOM;
    result.roomId = roomId;
  }

  if (allRequested && roomRequested) {
    throw new HaltCliError('CLI_CONFLICT', '--all 与 --room 不能同时使用。');
  }
  return result;
}

export function resolveStateDir(env = process.env) {
  const raw = env.AIROOM_STATE_DIR;
  if (typeof raw === 'string' && raw.length > 0) {
    return path.resolve(raw);
  }
  return path.resolve(DEFAULT_STATE_DIR);
}

/**
 * 只写哨兵并返回回执，不创建 Bridge、不连引擎、不发起任何模型调用。
 * 回执里的 stopped/fullySettled 只描述哨兵与本地在飞 attempt 的结算，
 * 不表示远端客户端或模型调用已经停止。
 */
export async function runHaltCli(argv = process.argv.slice(2), options = {}) {
  const args = parseHaltArgs(argv);
  if (args.help) {
    return { exitCode: EXIT_OK, stdout: USAGE, stderr: '' };
  }

  const stateDir = resolveStateDir(options.env ?? process.env);
  const guard = createHaltGuard({ stateDir });
  try {
    const receipt = await guard.request({
      scope: args.scope,
      roomId: args.roomId,
      mode: HALT_MODES.HALT,
      actor: ACTOR,
    });
    const sentinelName = args.scope === HALT_SCOPES.ALL
      ? HALT_FILENAME
      : `${HALT_FILENAME}.${args.roomId}`;
    const ok = receipt.sentinelWritten === true;
    const payload = {
      ...receipt,
      ok,
      stateDir,
      sentinelPath: path.join(stateDir, sentinelName),
      note: ok
        ? '哨兵已写入，它会在下一个检查点阻止派发与继续。本命令不连接引擎、不调用模型，也不代表远端调用已经取消。'
        : '哨兵未能写入，停止请求未生效。本命令不连接引擎、不调用模型。',
    };
    return {
      exitCode: ok ? EXIT_OK : EXIT_FAILED,
      stdout: JSON.stringify(payload, null, 2),
      stderr: ok ? '' : `[ai-room] 停止哨兵写入失败：${receipt.sentinelErrorCode ?? 'UNKNOWN'}`,
    };
  } finally {
    await guard.close();
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;

  try {
    const result = await runHaltCli(argv, { env });
    if (result.stdout) stdout.write(`${result.stdout}\n`);
    if (result.stderr) stderr.write(`${result.stderr}\n`);
    return result.exitCode;
  } catch (error) {
    const code = typeof error?.code === 'string' && error.code.length > 0
      ? error.code
      : 'HALT_FAILED';
    stderr.write(`${JSON.stringify({
      ok: false,
      code,
      message: error?.message ?? String(error),
    })}\n`);
    if (code.startsWith('CLI_') || code === 'INVALID_ROOM_ID') {
      stderr.write(`${USAGE}\n`);
      return EXIT_USAGE;
    }
    return EXIT_FAILED;
  }
}

const isMain = typeof process.argv[1] === 'string'
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  process.exitCode = await main();
}
