// probes/dsh/probe-run.mjs — M0 端到端探针：投递 → 最终回复 → 去重 → 取消
//
// 会真的产生模型调用（一次约 ¥0.01~0.02）。两种模式：
//
//   1) 默认（安全）：新建一次性会话 → 跑两条极短 prompt → 取消第二条 → 归档会话。
//      $node probes\dsh\probe-run.mjs
//
//   2) 指定原生会话（慎用：会真的往那个会话投一条消息，且不会归档）：
//      $node probes\dsh\probe-run.mjs --session session-xxxxxxxx [--cancel]
//      --cancel 才会跑「投长任务再取消」那一步；不加只跑一条「只回一句：收到。」
//
// 判定结果会打印 PASS/FAIL 表并写一份 JSON 报告到 %TEMP%\airoom-dsh-probe-<ts>.json
//
// 运行 Node 必须 >= 22.13（见 docs/dsh-m0-probe-2026-11-08.md §七）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeApiClient, unwrap, createTurnCollector } from '../../adapters/dsh/dsh-client.mjs';

const BASE = process.env.AIROOM_DSH_BASE || 'http://127.0.0.1:2955';
const args = process.argv.slice(2);
const opt = { session: '', cancel: false, keep: false, timeoutMs: 120000 };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--session') opt.session = String(args[++i] ?? '');
  else if (a === '--cancel') opt.cancel = true;
  else if (a === '--keep') opt.keep = true;
  else if (a === '--timeout') opt.timeoutMs = Number(args[++i]) || opt.timeoutMs;
  else if (a === '-h' || a === '--help') {
    console.log('用法: probe-run.mjs [--session <id>] [--cancel] [--keep] [--timeout ms]');
    process.exit(0);
  }
}

const api = new NodeApiClient(BASE, 20000, {});
const startedAt = Date.now();
const log = [];
const note = (tag, payload) => {
  log.push({ at: Date.now() - startedAt, tag, payload });
  const at = String(Date.now() - startedAt).padStart(6);
  console.log(`${at}ms  ${tag}${payload === undefined ? '' : '  ' + safeJson(payload)}`);
};
function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 400 ? s.slice(0, 400) + '…' : s;
  } catch { return String(v); }
}

// 每个会话一个 collector：只累加 assistant/message 的 text 块（reasoning/chunk 丢弃）
const collectors = new Map();
const seenEvents = [];
let lastError = null;

async function pump() {
  try {
    for await (const envelope of api.events.mux({})) {
      const frame = envelope?.payload ?? envelope;
      if (frame?.type === 'session/snapshot') {
        // 快照 = 历史；**不重放成 live 回复**，只做两件事：
        //   1) 记录（账本基线用）；
        //   2) 重建「有 turn/start 但没有 turn/end」的未结束回合的 collector。
        //      ——实测：follow 之后立刻投递，第一条 turn/start 可能落在开场快照里，
        //      不重建的话这一轮回复会被静默丢弃（正文丢失、token 照付）。
        const records = frame.snapshot?.records ?? [];
        note('snapshot', { sessionId: frame.sessionId, records: records.length });
        const evs = records.map((r) => (r?.type === 'event' ? r.event : r)).filter(Boolean);
        const open = new Set();
        for (const ev of evs) {
          if (ev.type === 'turn/start') open.add(ev.data?.turn);
          else if (ev.type === 'turn/end') open.delete(ev.data?.turn);
        }
        if (open.size) {
          const col = collectors.get(frame.sessionId) ?? createTurnCollector();
          collectors.set(frame.sessionId, col);
          for (const ev of evs) {
            if (ev.type !== 'turn/start' && ev.type !== 'assistant/message') continue;
            if (!open.has(ev.data?.turn)) continue;
            col.push(ev);
          }
          note('snapshot-open-turns', { sid: short(frame.sessionId), turns: [...open] });
        }
        continue;
      }
      if (frame?.type !== 'session/event') continue;
      const ev = frame.event;
      const sid = frame.sessionId;
      const d = ev?.data ?? {};
      seenEvents.push({ sid, type: ev?.type, turn: d.turn ?? null, reason: d.reason?.kind ?? null });
      if (!collectors.has(sid)) collectors.set(sid, createTurnCollector());
      const ended = collectors.get(sid).push(ev);
      if (ev?.type === 'turn/start') note('turn/start', { sid: short(sid), turn: d.turn });
      if (ev?.type === 'assistant/message') {
        const kinds = (d.message?.content ?? []).map((b) => b?.type);
        note('assistant/message', { sid: short(sid), turn: d.turn, blocks: kinds });
      }
      if (ended) {
        note('turn/end', { sid: short(sid), turn: ended.turn, reason: ended.reason, text: ended.text.slice(0, 200), textLen: ended.text.length });
      }
    }
  } catch (e) {
    note('mux-error', String(e?.message ?? e));
    lastError = e;
  }
}
const short = (s) => String(s).slice(-8);

const waitFor = async (pred, ms, label) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = pred();
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 100));
  }
  note('timeout', { label, ms });
  return null;
};
const waitTurnEnd = (sid, ms) => waitFor(
  () => seenEvents.find((e) => e.sid === sid && e.type === 'turn/end'),
  ms, 'turn/end',
);
const waitAborted = (sid, ms) => waitFor(
  () => seenEvents.find((e) => e.sid === sid && e.type === 'turn/end' && e.reason === 'aborted'),
  ms, 'turn/end(aborted)',
);

// ── 目标会话：指定 or 新建 ──
let sessionId = opt.session;
let created = false;
if (!sessionId) {
  try {
    const wsDir = path.join(os.tmpdir(), 'airoom-dsh-probe-ws');
    fs.mkdirSync(wsDir, { recursive: true }); // workspace.create 要求目录已存在（realpath）
    let workspaceId;
    try {
      const ws = unwrap(await api.workspace.create({ path: wsDir }), 'workspace.create');
      workspaceId = ws?.workspace?.workspaceId ?? ws?.workspaceId;
    } catch (e) {
      note('workspace-create-skip', String(e?.message ?? e)); // 建不了工作区也能建会话
    }
    const v = unwrap(await api.sessions.create(workspaceId ? { workspaceId, agentPreset: 'minimal' } : { agentPreset: 'minimal' }), 'session.create');
    sessionId = v.sessionId;
    created = true;
    note('session-created', { sessionId });
  } catch (e) {
    console.error('建会话失败:', String(e?.message ?? e));
    process.exit(1);
  }
} else {
  note('target-session', { sessionId });
}

pump(); // 先起事件泵，再 follow（turn/start 可能早于 prompt 响应）
api.events.follow(sessionId);
await waitFor(() => true, 800, 'follow-settle');

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── 1. 投递 + 最终回复 ──
const promptOk = await (async () => {
  const r = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '只回一句：收到。' }] });
  note('prompt-1', { ok: r?.result?.ok, value: r?.result?.value, error: r?.result?.error });
  return r?.result?.ok === true && r?.result?.value?.accepted === true;
})();
record('发送被接受（prompt → result.ok && value.accepted）', promptOk);

const end1 = await waitTurnEnd(sessionId, opt.timeoutMs);
record('收到最终回复（turn/end.completed）', end1?.reason === 'completed', end1 ? `turn=${end1.turn} reason=${end1.reason}` : '超时');
const text1 = end1 ? (collectors.get(sessionId) ? '' : '') : ''; // 正文在 turn/end 的 note 里
record('正文非空', (log.find((l) => l.tag === 'turn/end' && l.payload?.textLen > 0)?.payload?.textLen ?? 0) > 0);

// ── 2. 去重：同一 turn 只应有一条 turn/end ──
const ends = seenEvents.filter((e) => e.sid === sessionId && e.type === 'turn/end');
const turns = new Set(ends.map((e) => e.turn));
record('去重（(sessionId,turn) 唯一）', ends.length === turns.size, `turn/end=${ends.length} 唯一 turn=${turns.size}`);

// ── 3. 取消 ──
if (opt.cancel || created) {
  const r2 = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: '从 1 数到 200，每行一个数字，不要省略。' }] });
  note('prompt-2', { ok: r2?.result?.ok });
  await new Promise((r) => setTimeout(r, 1200));
  const bus = await api.callUnary('session/projections', { sessionId });
  note('inbox-before-cancel', { nextTurn: bus?.result?.value?.values?.inbox?.['next-turn']?.length ?? 'n/a' });
  const t0 = Date.now();
  const c = await api.callUnary('session/cancel', { sessionId });
  note('cancel', { ok: c?.result?.ok, ms: Date.now() - t0 });
  record('取消被接受（session/cancel ok）', c?.result?.ok === true);
  const ab = await waitAborted(sessionId, 30000);
  record('取消落地（turn/end.aborted）', !!ab, ab ? `turn=${ab.turn}` : '未收到 aborted');
  const bus2 = await api.callUnary('session/projections', { sessionId });
  const left = bus2?.result?.value?.values?.inbox?.['next-turn']?.length ?? 0;
  record('队列已清（inbox.next-turn 为空）', left === 0, `剩余 ${left}`);
}

// ── 4. 语音能力：事件流是否出现语音帧（这是能力结论，不是失败）──
const voiceFrames = seenEvents.filter((e) => /speech|voice|audio|tts/i.test(e.type));
console.log(`${voiceFrames.length ? 'HAS-VOICE' : 'NO-VOICE'}  DSH 原生语音帧：${voiceFrames.length} 个${voiceFrames.length ? ' — ' + JSON.stringify(voiceFrames) : '（预期为 0：DSH 无原生 TTS/朗读）'}`);

// ── 5. 归档（仅新建模式，--keep 可保留）──
if (created && !opt.keep) {
  try {
    await api.workspace.archiveSession({ sessionId });
    note('archived', { sessionId });
  } catch (e) {
    note('archive-error', String(e?.message ?? e));
  }
}

const report = {
  base: BASE, sessionId, created, startedAt: new Date(startedAt).toISOString(),
  results, eventTypes: [...new Set(seenEvents.map((e) => e.type))],
};
const out = path.join(os.tmpdir(), `airoom-dsh-probe-${Date.now()}.json`);
fs.writeFileSync(out, JSON.stringify({ report, log }, null, 2));
console.log(`\n报告: ${out}`);
const failed = results.filter((r) => !r.ok);
console.log(`结论: ${results.length - failed.length}/${results.length} 通过${failed.length ? '；未通过: ' + failed.map((f) => f.name).join('、') : ''}`);
process.exit(0);
