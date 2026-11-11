// Qwen Code 协议细节探测（零成本）：clientId 注册、模型/强度读回、SSE 形状、挂接语义。
// 不发 prompt、不产生任何模型调用。
//
// 用法：node probes/qwen-code/probe-api.mjs [--json]
// 产物：临时目录 qwen-probe-api.json（完整 context 等）+ 控制台摘要。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compact, httpJson, pickFreePort, startQwenDaemon } from './lib.mjs';

const opt = { json: process.argv.includes('--json') };
const report = { at: new Date().toISOString(), steps: [], notes: [], error: null };
const log = (label, value) => {
  report.steps.push({ label, value: compact(value) });
  if (!opt.json) {
    console.log(`\n### ${label}`);
    const shown = compact(value);
    console.log(typeof shown === 'string' ? shown : JSON.stringify(shown, null, 1));
  }
};

const workspace = path.join(os.tmpdir(), 'airoom-qwen-probe', 'workspace-api');
const logPath = path.join(os.tmpdir(), 'airoom-qwen-probe', 'qwen-serve-api.log');
const outFile = path.join(os.tmpdir(), 'airoom-qwen-probe', 'qwen-probe-api.json');

/** 打开 SSE 抓 2 秒，只记录响应头与前几条原始事件行。 */
async function sniffSse(baseUrl, sessionId, { timeoutMs = 2000, clientId } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'text/event-stream' };
  if (clientId) headers['X-Qwen-Client-Id'] = clientId;
  try {
    const res = await fetch(`${baseUrl}/session/${encodeURIComponent(sessionId)}/events`, {
      headers,
      signal: controller.signal,
    });
    const reader = res.body.getReader();
    let text = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (text.length > 4000) break;
      }
    } catch {
      // abort 正常
    }
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      firstBytes: text.slice(0, 1200),
    };
  } catch (error) {
    return { error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/** 递归找模型/强度相关字段。 */
function findModelFields(value, prefix = '', out = []) {
  if (!value || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (/model|reason|effort|think|config.?option/i.test(k) && (typeof v !== 'object' || v === null)) {
      out.push([key, v]);
    } else if (typeof v === 'object') {
      findModelFields(v, key, out);
    }
    if (out.length > 60) return out;
  }
  return out;
}

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
  const port = await pickFreePort(58691);
  daemon = await startQwenDaemon({ port, workspace, logPath });
  const base = daemon.baseUrl;
  log('daemon', { baseUrl: base, workspace, logPath });
  const clientHeader = 'airoom-probe-client';

  // A：只带 header clientId；B：header + body clientId
  const createdA = await httpJson(base, 'POST', '/session', { body: { cwd: workspace }, clientId: clientHeader });
  log('A POST /session（只带 X-Qwen-Client-Id）', createdA);
  const sessionA = createdA?.body?.sessionId ?? null;
  const assignedA = createdA?.body?.clientId ?? null;

  const createdB = await httpJson(base, 'POST', '/session', {
    body: { cwd: workspace, clientId: clientHeader },
    clientId: clientHeader,
  });
  log('B POST /session（header + body.clientId）', createdB);
  const sessionB = createdB?.body?.sessionId ?? null;
  const assignedB = createdB?.body?.clientId ?? null;

  for (const [label, sessionId, clientId] of [
    ['A', sessionA, assignedA],
    ['B', sessionB, assignedB],
  ]) {
    if (!sessionId) continue;
    const pending = await httpJson(base, 'GET', `/session/${encodeURIComponent(sessionId)}/pending-prompts`, { clientId });
    log(`${label} GET pending-prompts（用服务端返回的 clientId）`, pending);
    const context = await httpJson(base, 'GET', `/session/${encodeURIComponent(sessionId)}/context`, { clientId });
    log(`${label} GET context（模型字段）`, findModelFields(context.body));
    if (label === 'A') {
      report.fullContextA = context.body;
      report.sseA = await sniffSse(base, sessionId, { clientId });
      log('A GET events（SSE 嗅探 2s）', {
        status: report.sseA.status,
        contentType: report.sseA.contentType,
        firstBytes: report.sseA.firstBytes?.slice(0, 500),
      });
    }
  }

  // 未知会话
  const unknownId = '00000000-0000-4000-8000-000000000000';
  const unknownStatus = await httpJson(base, 'GET', `/session/${encodeURIComponent(unknownId)}/status`);
  log('未知会话 GET status', unknownStatus);

  // 重启后：先不 POST 直接问状态；再看 workspace 列表；再挂接
  await stopQuietly();
  daemon = await startQwenDaemon({ port, workspace, logPath });
  log('重启后 GET status（未挂接）', await httpJson(daemon.baseUrl, 'GET', `/session/${encodeURIComponent(sessionA)}/status`));
  log('重启后 GET workspace sessions', await httpJson(
    daemon.baseUrl,
    'GET',
    `/workspace/${encodeURIComponent(workspace)}/sessions`,
  ));
  const reattach = await httpJson(daemon.baseUrl, 'POST', '/session', {
    body: { cwd: workspace, sessionId: sessionA },
    clientId: clientHeader,
  });
  log('重启后 POST /session（sessionId 挂接）', reattach);
  log('重启后 GET context（模型字段）', findModelFields(
    (await httpJson(daemon.baseUrl, 'GET', `/session/${encodeURIComponent(sessionA)}/context`)).body,
  ));
} catch (error) {
  report.error = String(error?.message ?? error);
  if (!opt.json) console.error('\n[probe-api] 失败：', report.error);
} finally {
  await stopQuietly();
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
}

if (opt.json) console.log(JSON.stringify(compact(report), null, 2));
else {
  console.log('\n=== 摘要 ===');
  console.log(JSON.stringify({
    error: report.error,
    fullReport: outFile,
    sse: report.sseA?.status ?? null,
    modelFields: report.fullContextA ? findModelFields(report.fullContextA).slice(0, 20) : null,
  }, null, 2));
}
process.exit(report.error ? 1 : 0);
