// Qwen Code 零成本协议探测：只读 + 建会话/挂接，不发 prompt、不产生模型调用。
//
// 用法：
//   node probes/qwen-code/probe-meta.mjs [--port N] [--keep] [--json]
//
// 做的事：
//   1. 拉起一次性 `qwen serve`（回环、免 token、临时 workspace）
//   2. 读 /health、/capabilities、模型与 workspace 会话列表
//   3. POST /session 建一条 scratch 会话，读 status/transcript/pending-prompts/turn-index
//   4. 验证「用 sessionId 挂接已有会话」以及「守护进程重启后再挂接」
//   5. 读回该会话的模型/强度字段；收尾杀掉自己拉起的进程
//
// 产物：控制台摘要 + 可选 --json；日志在临时目录（qa-run.log）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compact,
  httpJson,
  pickFreePort,
  readQwenModelExpectation,
  resolveQwenRuntime,
  startQwenDaemon,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = { port: null, keep: false, json: false };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--port') opt.port = Number(args[++i]) || null;
  else if (a === '--keep') opt.keep = true;
  else if (a === '--json') opt.json = true;
  else if (a === '-h' || a === '--help') {
    console.log('用法: probe-meta.mjs [--port N] [--keep] [--json]');
    process.exit(0);
  }
}

const report = {
  at: new Date().toISOString(),
  runtime: null,
  modelExpectation: null,
  daemon: null,
  steps: [],
  sessionId: null,
  attach: null,
  restartAttach: null,
  port: null,
};

const log = (label, value) => {
  report.steps.push({ label, value: compact(value) });
  if (!opt.json) {
    console.log(`\n### ${label}`);
    const shown = compact(value);
    console.log(typeof shown === 'string' ? shown : JSON.stringify(shown, null, 1));
  }
};

const probeWorkspace = path.join(os.tmpdir(), 'airoom-qwen-probe', 'workspace');
const logPath = path.join(os.tmpdir(), 'airoom-qwen-probe', 'qwen-serve.log');

let daemon = null;
const stopQuietly = async () => {
  if (!daemon) return;
  try {
    await daemon.stop();
  } catch {
    // ignore
  }
  daemon = null;
};

try {
  report.runtime = resolveQwenRuntime();
  report.modelExpectation = readQwenModelExpectation();
  log('runtime', report.runtime);
  log('model-expectation（~/.qwen/settings.json）', report.modelExpectation);

  const port = opt.port ?? await pickFreePort(58691);
  report.port = port;
  daemon = await startQwenDaemon({ port, workspace: probeWorkspace, logPath });
  log('daemon', { baseUrl: daemon.baseUrl, port: daemon.port, logPath });
  const base = daemon.baseUrl;
  const clientId = 'airoom-probe-qwen';

  const health = await httpJson(base, 'GET', '/health');
  log('GET /health', health);

  const caps = await httpJson(base, 'GET', '/capabilities');
  log('GET /capabilities', caps);

  const models = await httpJson(base, 'GET', '/workspace/models');
  log('GET /workspace/models', models);

  const standalone = await httpJson(base, 'GET', '/standalone/sessions');
  log('GET /standalone/sessions', standalone);

  // 建一条 scratch 会话（不投递 prompt，不产生模型调用）
  const created = await httpJson(base, 'POST', '/session', {
    body: { cwd: probeWorkspace },
    clientId,
  });
  log('POST /session（建 scratch 会话）', created);
  const sessionId = created?.body?.sessionId ?? created?.body?.session?.sessionId ?? null;
  report.sessionId = sessionId;
  if (!sessionId) throw new Error('没拿到 sessionId，后续探测无法继续');

  for (const route of [
    `/session/${encodeURIComponent(sessionId)}/status`,
    `/session/${encodeURIComponent(sessionId)}/transcript`,
    `/session/${encodeURIComponent(sessionId)}/pending-prompts`,
    `/session/${encodeURIComponent(sessionId)}/turn-index`,
    `/session/${encodeURIComponent(sessionId)}/context-usage`,
    `/session/${encodeURIComponent(sessionId)}/context`,
  ]) {
    const res = await httpJson(base, 'GET', route, { clientId });
    log(`GET ${route.replace(sessionId, '<sessionId>')}`, res);
  }

  const encodedWorkspace = encodeURIComponent(probeWorkspace);
  for (const route of [
    `/workspace/${encodedWorkspace}/sessions`,
    `/workspaces/${encodedWorkspace}/sessions`,
  ]) {
    const res = await httpJson(base, 'GET', route, { clientId });
    log(`GET ${route.replace(encodedWorkspace, '<ws>')}`, res);
  }

  // 用 sessionId 挂接已有会话
  const attach = await httpJson(base, 'POST', '/session', {
    body: { cwd: probeWorkspace, sessionId },
    clientId,
  });
  report.attach = attach;
  log('POST /session（带 sessionId 挂接）', attach);

  // 重启守护进程后再次挂接
  await stopQuietly();
  daemon = await startQwenDaemon({ port, workspace: probeWorkspace, logPath });
  const restartAttach = await httpJson(daemon.baseUrl, 'POST', '/session', {
    body: { cwd: probeWorkspace, sessionId },
    clientId,
  });
  report.restartAttach = restartAttach;
  log('重启后 POST /session（再挂接）', restartAttach);

  const statusAfter = await httpJson(daemon.baseUrl, 'GET', `/session/${encodeURIComponent(sessionId)}/status`, { clientId });
  log('重启后 GET /session/<id>/status', statusAfter);

  // 从各响应里挑出模型/强度相关字段，方便核对 qwen3.8-flash / low
  const haystack = JSON.stringify([caps, models, statusAfter, restartAttach]);
  const modelHits = [...haystack.matchAll(/"(modelId|model|reasoningEffort|reasoning_effort|thinking|effort|thoughtLevel)"\s*:\s*("[^"]*"|\d+|true|false)/gi)]
    .map((m) => m[0])
    .slice(0, 20);
  log('模型/强度相关字段', modelHits);
} catch (error) {
  report.error = String(error?.message ?? error);
  if (!opt.json) console.error('\n[probe-meta] 失败：', report.error);
} finally {
  await stopQuietly();
  if (!opt.keep) {
    try {
      fs.rmSync(path.join(os.tmpdir(), 'airoom-qwen-probe', 'workspace'), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

if (opt.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`\n=== 摘要 ===`);
  console.log(JSON.stringify({
    port: report.port,
    sessionId: report.sessionId,
    attachStatus: report.attach?.status ?? null,
    restartAttachStatus: report.restartAttach?.status ?? null,
    error: report.error ?? null,
    log: logPath,
  }, null, 2));
}
process.exit(report.error ? 1 : 0);
