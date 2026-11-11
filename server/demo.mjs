import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FakeBridge } from '../adapters/fake/bridge.mjs';
import { createRoomEngine } from '../core/engine.mjs';
import { createHaltGuard } from '../core/halt.mjs';
import { createRoomStore } from '../store/room-store.mjs';
import { createRoomServer } from './http.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));
// 与 server/live.mjs 保持一致：2960 在本机被 DeepSeek Harness 占用，默认用 2961。
const DEFAULT_PORT = 2961;
const DEFAULT_MAX_ATTEMPTS = 3;
const MIN_MAX_ATTEMPTS = 1;
const MAX_MAX_ATTEMPTS = 12;
const ROOM_ID = 'demo-room';
const SEAT_IDS = Object.freeze(['deepseek', 'kimi', 'glm']);

const REPLIES = Object.freeze({
  deepseek: Object.freeze([
    '从实现角度看，关键是把原生会话与房间事件解耦，排程只负责决定谁开口。',
    '我倾向于先把边界定清楚：桥接器只翻译事件，房间核心不介入客户端人格。',
    '这里最值得验证的是恢复路径——检查点对不齐，重放就会出现重复消息。',
  ]),
  kimi: Object.freeze([
    '我接着刚才的话题补一点：先保证每条消息都能回到对应的原生会话。',
    '可以把它拆成两步：先把事件流跑通，再考虑语音和字幕的同步。',
    '我同意大方向，不过还想确认一下暂停之后新发言是否立即停止派发。',
  ]),
  glm: Object.freeze([
    '我先旁听一下，这个节奏挺顺的。',
    '补一句：如果出现断线，应该让席位显示为不可用，而不是继续派发。',
    '这块我暂时没有新观点，交给你们继续。',
  ]),
});

function parsePort(raw) {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) {
    throw new TypeError(`AIROOM_PORT must be an integer between 0 and 65535; got ${raw}.`);
  }
  return value;
}

function parseMaxAttempts(raw) {
  if (raw === undefined || raw === '') return DEFAULT_MAX_ATTEMPTS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < MIN_MAX_ATTEMPTS || value > MAX_MAX_ATTEMPTS) {
    throw new TypeError(
      `AIROOM_MAX_ATTEMPTS must be an integer between ${MIN_MAX_ATTEMPTS} and ${MAX_MAX_ATTEMPTS}; got ${raw}.`,
    );
  }
  return value;
}

function parseReplyDelay(raw) {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`AIROOM_REPLY_DELAY_MS must be a finite number >= 0; got ${raw}.`);
  }
  return value;
}

function normalizeReplyDelay(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('replyDelayMs must be a finite number >= 0.');
  }
  return value;
}

/**
 * 本机 fake 演示入口：三席 FakeBridge 不调用真实模型，
 * 只在每次 TurnRequested 后异步补一条有人格差异的短回复。
 * HaltGuard 使用 stateDir 下的真实 HALT 哨兵，供浏览器急停验收。
 */
export async function startDemo(options = {}) {
  const port = options.port ?? parsePort(process.env.AIROOM_PORT);
  const maxAttempts = options.maxAttempts ?? parseMaxAttempts(process.env.AIROOM_MAX_ATTEMPTS);
  const stateDir = path.resolve(options.stateDir ?? path.join(PROJECT_ROOT, 'state'));
  const roomDir = path.resolve(options.roomDir ?? path.join(stateDir, ROOM_ID));
  const replyDelayMs = options.replyDelayMs === undefined
    ? parseReplyDelay(process.env.AIROOM_REPLY_DELAY_MS)
    : normalizeReplyDelay(options.replyDelayMs);
  const token = randomBytes(24).toString('base64url');

  const haltGuard = createHaltGuard({ stateDir });
  const bridges = new Map();
  for (const seatId of SEAT_IDS) {
    bridges.set(seatId, new FakeBridge({
      seatId,
      nativeSessionRef: `demo_session_${seatId}`,
    }));
  }

  const engine = createRoomEngine({
    roomId: ROOM_ID,
    bridges,
    store: createRoomStore(roomDir),
    maxAttempts,
    haltGuard,
  });

  try {
    await engine.init();
  } catch (error) {
    await engine.close().catch(() => {});
    throw error;
  }

  const counters = new Map(SEAT_IDS.map((seatId) => [seatId, 0]));
  const pendingReplies = new Map();

  function clearReply(attemptId) {
    const timer = pendingReplies.get(attemptId);
    if (timer === undefined) return;
    clearTimeout(timer);
    pendingReplies.delete(attemptId);
  }

  const unsubscribers = [
    engine.on('TurnRequested', (event) => {
      const { seatId, attemptId } = event?.payload ?? {};
      const bridge = bridges.get(seatId);
      if (!bridge || typeof attemptId !== 'string') return;

      const replyIndex = counters.get(seatId) ?? 0;
      counters.set(seatId, replyIndex + 1);

      const lines = REPLIES[seatId] ?? REPLIES.glm;
      const pass = seatId === 'glm' && (replyIndex + 1) % 3 === 0;
      const text = pass ? '[PASS]' : lines[replyIndex % lines.length];
      const delayMs = replyDelayMs ?? (pass ? 160 : 180 + Math.floor(Math.random() * 320));

      const timer = setTimeout(() => {
        pendingReplies.delete(attemptId);
        // 急停哨兵已经落盘时不再补发；暂停仍允许在途 attempt 自然完成。
        if (haltGuard.check(ROOM_ID).halted) return;
        bridge.completeAttempt(attemptId, {
          text,
          nativeMessageRef: `demo_${attemptId}_message`,
        });
      }, delayMs);
      pendingReplies.set(attemptId, timer);
    }),
    // guard 已经取消在途 attempt；这里同步清掉演示定时器，避免停止后仍补发回复。
    engine.on('HaltRequested', () => {
      for (const attemptId of [...pendingReplies.keys()]) clearReply(attemptId);
    }),
    engine.on('bridge-event', (event) => {
      const type = event?.type;
      if ((type === 'AttemptAborted' || type === 'AttemptFailed' || type === 'AttemptCompleted')
        && typeof event.attemptId === 'string') {
        clearReply(event.attemptId);
      }
    }),
  ];

  function unsubscribeAll() {
    for (const off of unsubscribers) off();
  }

  const server = createRoomServer({ engine, token, port, webDir: options.webDir });
  let actualPort;
  try {
    actualPort = await server.listen();
  } catch (error) {
    unsubscribeAll();
    for (const timer of pendingReplies.values()) clearTimeout(timer);
    pendingReplies.clear();
    await engine.close();
    throw error;
  }

  let closePromise = null;
  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      unsubscribeAll();
      for (const timer of pendingReplies.values()) clearTimeout(timer);
      pendingReplies.clear();
      // 顺序：先释放 guard 内存，再关 HTTP，最后关 engine 与 Bridge。
      // guard.close() 不删除 HALT 哨兵，机主可在重启后继续看到停止事实。
      await haltGuard.close();
      await server.close();
      await engine.close();
    })();
    return closePromise;
  }

  const url = `http://127.0.0.1:${actualPort}/#token=${token}`;
  console.log('[ai-room] fake demo ready');
  console.log(`[ai-room] seats: ${SEAT_IDS.join(', ')} (FakeBridge, no live model calls)`);
  console.log(`[ai-room] state dir: ${stateDir}`);
  console.log(`[ai-room] room dir: ${roomDir}`);
  console.log(`[ai-room] open: ${url}`);
  console.log('[ai-room] press Ctrl+C to stop; native sessions are kept.');

  return {
    engine,
    server,
    haltGuard,
    port: actualPort,
    token,
    url,
    stateDir,
    roomDir,
    close,
  };
}

const isMain = typeof process.argv[1] === 'string'
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  let demo;
  try {
    demo = await startDemo();
  } catch (error) {
    console.error(`[ai-room] demo failed to start: ${error?.message ?? error}`);
    process.exitCode = 1;
  }

  if (demo) {
    let shuttingDown = false;
    const shutdown = (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(`\n[ai-room] ${signal} received, shutting down...`);
      demo.close().then(
        () => process.exit(0),
        (error) => {
          console.error(`[ai-room] shutdown failed: ${error?.message ?? error}`);
          process.exit(1);
        },
      );
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  }
}
