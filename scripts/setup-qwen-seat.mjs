// 一次性建「Qwen 圆桌专席」会话：需要房间的 Qwen 守护进程已经起来。
//
// 用法：
//   node scripts/setup-qwen-seat.mjs [--base-url http://127.0.0.1:58691] [--workspace <dir>]
//        [--session-id <已有 id>] [--out state/qwen-seat.json]
//        [--seed "只回复 OK"] --allow-cost
//
// 说明：
// - 不带 --seed 时只建会话、不产生模型调用；但空会话在守护进程重启后不会持久化，
//   所以正式专席建议带 --seed 跑一次（一次极短回合，花费约几分钱，需要 --allow-cost 明示）。
// - 本脚本不改 ~/.qwen/settings.json，也不改 config/members.local.json；
//   它只打印 sessionId，由机主确认后自己填进成员配置。
// - 模型/强度按客户端全局设置继承（默认 qwen3.8-flash + low）；若读回不一致只告警，不偷偷改。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as nodeSpawn } from 'node:child_process';

import { QwenDaemonClient, QWEN_DEFAULT_BASE_URL } from '../adapters/qwen-code/client.mjs';
import { readPersonaRef } from '../adapters/qwen-code/bridge.mjs';
import { buildServeArgs, checkQwenHealth, resolveQwenRuntime } from '../adapters/qwen-code/runtime.mjs';

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

const args = process.argv.slice(2);
const opt = {
  baseUrl: QWEN_DEFAULT_BASE_URL,
  workspace: path.join(PROJECT_ROOT, 'rooms', 'r_main', 'qwen'),
  sessionId: null,
  out: path.join(PROJECT_ROOT, 'state', 'qwen-seat.json'),
  seed: null,
  allowCost: false,
  spawnIfDown: false,
  waitMs: 120000,
};
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--base-url') opt.baseUrl = args[++i];
  else if (a === '--workspace') opt.workspace = path.resolve(args[++i]);
  else if (a === '--session-id') opt.sessionId = args[++i];
  else if (a === '--out') opt.out = path.resolve(args[++i]);
  else if (a === '--seed') opt.seed = args[++i];
  else if (a === '--allow-cost') opt.allowCost = true;
  else if (a === '--spawn-if-down') opt.spawnIfDown = true;
  else if (a === '--wait-ms') opt.waitMs = Number(args[++i]) || opt.waitMs;
  else if (a === '-h' || a === '--help') {
    console.log('用法: setup-qwen-seat.mjs [--base-url URL] [--workspace DIR] [--session-id ID] [--out FILE] [--seed TEXT] [--spawn-if-down] --allow-cost');
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}

// 脚本自己拉起的临时 daemon（仅在 --spawn-if-down 且端口没起时出现），退出时一定收掉。
let ownDaemon = null;
function stopOwnDaemon() {
  if (!ownDaemon) return;
  try {
    ownDaemon.child.kill('SIGTERM');
  } catch {
    // ignore
  }
  setTimeout(() => {
    try {
      if (ownDaemon?.child && ownDaemon.child.exitCode == null) ownDaemon.child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, 500).unref?.();
  ownDaemon = null;
}
process.on('exit', () => {
  try {
    ownDaemon?.child?.kill('SIGTERM');
  } catch {
    // ignore
  }
});

async function ensureDaemon() {
  try {
    await client.health();
    return false;
  } catch {
    if (!opt.spawnIfDown) {
      throw new Error(
        `连不上 Qwen 守护进程 ${opt.baseUrl}。`
        + '先运行 start-all.bat（按配置里的 qwen-code 席位拉起守护进程），或加 --spawn-if-down 让本脚本临时拉一个。',
      );
    }
    const runtime = resolveQwenRuntime();
    fs.mkdirSync(opt.workspace, { recursive: true });
    const logDir = path.join(PROJECT_ROOT, 'state');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'qwen-setup-daemon.log');
    const logStream = fs.createWriteStream(logPath, { flags: 'a' });
    const port = Number(new URL(opt.baseUrl).port);
    const child = nodeSpawn(
      runtime.node,
      buildServeArgs({ entry: runtime.entry, port, workspace: opt.workspace }),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on?.('data', (chunk) => {
        try {
          logStream.write(chunk);
        } catch {
          // ignore
        }
      });
    }
    child.once('exit', () => {
      try {
        logStream.end();
      } catch {
        // ignore
      }
    });
    ownDaemon = { child, logPath };
    const deadline = Date.now() + 45000;
    for (;;) {
      if (child.exitCode != null) throw new Error(`临时 qwen serve 提前退出（code=${child.exitCode}），日志：${logPath}`);
      if (await checkQwenHealth(opt.baseUrl)) return true;
      if (Date.now() >= deadline) throw new Error(`临时 qwen serve 45s 内没有就绪，日志：${logPath}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

function readExpectation() {
  const file = path.join(os.homedir(), '.qwen', 'settings.json');
  try {
    const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      file,
      model: settings?.model?.name ?? null,
      reasoningEffort: settings?.model?.reasoningEffort ?? null,
    };
  } catch {
    return { file, model: null, reasoningEffort: null, error: '无法读取 settings.json' };
  }
}

function modelStateOf(contextBody) {
  const state = contextBody?.state ?? {};
  const modelId = state?.models?.currentModelId ?? null;
  const options = Array.isArray(state.configOptions) ? state.configOptions : [];
  const effort = options.find((item) => item?.id === 'reasoning_effort');
  const mode = options.find((item) => item?.id === 'mode');
  return {
    modelId,
    reasoningEffort: effort?.currentValue ?? null,
    permissionMode: mode?.currentValue ?? null,
  };
}

/** 等这一轮 prompt 的 turn_complete；返回 {text, stopReason}。 */
async function waitForTurn(client, sessionId, { promptId, lastEventId, eventEpoch, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let text = '';
  try {
    for await (const event of client.subscribeEvents(sessionId, {
      clientId: client.clientId,
      lastEventId,
      epoch: eventEpoch,
      signal: controller.signal,
    })) {
      if (event.type === 'session_update') {
        const update = event.data?.update;
        if (update?.sessionUpdate === 'agent_message_chunk') {
          const content = update.content;
          if (typeof content?.text === 'string') text += content.text;
        }
        continue;
      }
      if (event.type === 'turn_complete' && event.data?.promptId === promptId) {
        return { text, stopReason: event.data?.stopReason ?? 'end_turn' };
      }
      if (event.type === 'turn_error' && event.data?.promptId === promptId) {
        throw new Error(`turn_error: ${event.data?.code ?? '?'} ${event.data?.message ?? ''}`.trim());
      }
    }
    throw new Error('事件流在回合完成前结束');
  } finally {
    clearTimeout(timer);
  }
}

const client = new QwenDaemonClient({ baseUrl: opt.baseUrl, timeoutMs: 20000 });
const report = {
  baseUrl: opt.baseUrl,
  workspace: opt.workspace,
  sessionId: null,
  created: false,
  model: null,
  expectation: readExpectation(),
  persona: readPersonaRef(),
  seed: null,
  warnings: [],
};

let spawnedDaemon = false;
try {
  spawnedDaemon = await ensureDaemon();
} catch (error) {
  stopOwnDaemon();
  console.error(String(error?.message ?? error));
  process.exit(1);
}
if (spawnedDaemon) {
  report.warnings.push(`端口 ${opt.baseUrl} 原本没起，脚本临时拉起了一个 qwen serve（退出时会关掉）。`);
}

if (!fs.existsSync(opt.workspace)) {
  fs.mkdirSync(opt.workspace, { recursive: true });
  report.warnings.push(`workspace 不存在，已创建：${opt.workspace}`);
}

let sessionId = opt.sessionId;
let live = false;
if (sessionId) {
  try {
    await client.sessionStatus(sessionId);
    live = true;
  } catch (error) {
    if (!(error?.status === 404)) throw error;
  }
}

if (!sessionId) {
  const created = await client.createOrAttachSession({ cwd: opt.workspace });
  sessionId = created?.body?.sessionId ?? null;
  report.created = true;
} else if (!live) {
  const resumed = await client.resumeSession(sessionId, { cwd: opt.workspace });
  if (resumed?.body?.sessionId !== sessionId) {
    throw new Error(`恢复会话失败：期望 ${sessionId}，实际 ${resumed?.body?.sessionId}`);
  }
} else {
  // 已 live：按 workspace 挂成本客户端（会返回新的 clientId）
  const attached = await client.createOrAttachSession({ cwd: opt.workspace });
  if (attached?.body?.sessionId !== sessionId) {
    throw new Error(`挂接 live 会话失败：期望 ${sessionId}，实际 ${attached?.body?.sessionId}`);
  }
}
if (!sessionId) throw new Error('没有拿到 sessionId');
report.sessionId = sessionId;

const context = await client.sessionContext(sessionId);
report.model = modelStateOf(context?.body);
if (report.expectation.model && report.model.modelId
  && !String(report.model.modelId).startsWith(String(report.expectation.model))) {
  report.warnings.push(
    `会话模型 ${report.model.modelId} 与全局设置 ${report.expectation.model} 不一致；请先在客户端确认，本脚本不替你改。`,
  );
}
if (report.expectation.reasoningEffort && report.model.reasoningEffort
  && report.model.reasoningEffort !== report.expectation.reasoningEffort) {
  report.warnings.push(
    `会话思考强度 ${report.model.reasoningEffort} 与全局设置 ${report.expectation.reasoningEffort} 不一致；本脚本不替你改。`,
  );
}

if (opt.seed !== null) {
  if (!opt.allowCost) {
    console.error('--seed 会产生一次真实模型调用（花费几分钱）：确认后请加 --allow-cost 重跑。');
    process.exit(2);
  }
  const startedAt = Date.now();
  const response = await client.prompt(sessionId, {
    text: opt.seed,
    idempotencyKey: `setup-qwen-seat-${Date.now()}`,
    clientId: client.clientId,
  });
  if (response.status !== 202 || !response.body?.promptId) {
    throw new Error(`prompt 未被接受：HTTP ${response.status}`);
  }
  const result = await waitForTurn(client, sessionId, {
    promptId: response.body.promptId,
    lastEventId: response.body.lastEventId,
    eventEpoch: response.body.eventEpoch,
    timeoutMs: opt.waitMs,
  });
  report.seed = {
    prompt: opt.seed,
    text: result.text,
    stopReason: result.stopReason,
    elapsedMs: Date.now() - startedAt,
  };
}

fs.mkdirSync(path.dirname(opt.out), { recursive: true });
fs.writeFileSync(opt.out, JSON.stringify(report, null, 2) + '\n', 'utf8');

console.log('\n=== Qwen 专席 ===');
console.log(JSON.stringify({
  sessionId: report.sessionId,
  created: report.created,
  model: report.model,
  expectation: report.expectation,
  seed: report.seed,
  warnings: report.warnings,
  writtenTo: opt.out,
}, null, 2));
console.log('\n把这一行填进 config/members.local.json 的 qwen 席位（nativeSessionRef）：');
console.log(`  ${report.sessionId}`);
if (spawnedDaemon) {
  console.log('（临时 qwen serve 会在本脚本退出时关掉；填好配置后由 start-all.bat 重新拉起。）');
}
stopOwnDaemon();
process.exit(0);
