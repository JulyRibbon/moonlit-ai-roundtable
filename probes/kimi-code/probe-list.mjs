// probes/kimi-code/probe-list.mjs — 只读：列 Kimi Code 原生会话（不建会话、不发消息、零模型调用）
//
// 用法：
//   node probes/kimi-code/probe-list.mjs [--limit 20] [--grep 关键词] [--archived] [--json]
//
// 说明：
//   - 通过 child_process.spawn（shell:false）调用官方 CLI：
//       kimi.exe session list --all --json
//   - 只读取会话摘要元数据，不读取 transcript / messages / wire 正文。
//   - busy 只有 REST snapshot 才知道；本探针不连服务，统一输出 null（unknown）。

import { spawn } from 'node:child_process';

const DEFAULT_BIN = 'C:\\Users\\YL2018\\.kimi-code\\bin\\kimi.exe';
const BIN = process.env.AIROOM_KIMI_BIN || DEFAULT_BIN;

const args = process.argv.slice(2);
const opt = { limit: 20, grep: '', archived: false, json: false, timeoutMs: 30000 };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--limit') opt.limit = Number(args[++i]) || 20;
  else if (a === '--grep') opt.grep = String(args[++i] ?? '');
  else if (a === '--archived') opt.archived = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--timeout') opt.timeoutMs = Number(args[++i]) || opt.timeoutMs;
  else if (a === '-h' || a === '--help') {
    console.log('用法: probe-list.mjs [--limit N] [--grep 关键词] [--archived] [--json]');
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}

function spawnFile(file, argv, { timeoutMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(file, argv, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: e.code || e.message, stdout: '', stderr: '' });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        signal,
        timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function parseSessionJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) throw new Error('CLI 输出为空');
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) throw new Error('顶层不是数组');
    return v;
  } catch (first) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) {
      const v = JSON.parse(text.slice(start, end + 1));
      if (!Array.isArray(v)) throw new Error('顶层不是数组');
      return v;
    }
    throw first;
  }
}

function oneLine(v, max = 60) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function iso(ms) {
  if (!Number.isFinite(ms)) return '?';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

const argv = ['session', 'list', '--all', '--json'];
if (opt.archived) argv.push('--archived');

const res = await spawnFile(BIN, argv, { timeoutMs: opt.timeoutMs });

if (!res.ok) {
  const reason = res.error
    ? `启动失败 ${res.error}`
    : res.timedOut
      ? `超时 ${opt.timeoutMs}ms`
      : `退出码 ${res.code}${res.signal ? ` signal=${res.signal}` : ''}`;
  console.error(`kimi session list 失败：${reason}`);
  const tail = String(res.stderr ?? '').trim();
  if (tail) console.error(tail.slice(0, 400));
  process.exit(1);
}

let sessions;
try {
  sessions = parseSessionJson(res.stdout);
} catch (e) {
  console.error(`无法解析 CLI JSON：${e.message}`);
  process.exit(1);
}

const rows = sessions
  .map((s) => ({
    id: s.id,
    title: s.title ?? '(无标题)',
    workDir: s.workDir ?? null,
    busy: null,
    archived: s.archived === true,
    lastTurnReason: s.lastTurnReason ?? null,
    createdAt: Number.isFinite(s.createdAt) ? s.createdAt : null,
    updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : null,
    metadataKeys: s.metadata && typeof s.metadata === 'object' ? Object.keys(s.metadata) : [],
  }))
  .filter((r) => {
    if (!opt.grep) return true;
    return (
      String(r.title).includes(opt.grep) ||
      String(r.id).includes(opt.grep) ||
      String(r.workDir).includes(opt.grep)
    );
  })
  .slice(0, Math.max(0, opt.limit));

if (opt.json) {
  console.log(
    JSON.stringify(
      {
        bin: BIN,
        total: sessions.length,
        shown: rows.length,
        busyKnown: false,
        rows,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Kimi Code 会话总数 ${sessions.length} · 显示 ${rows.length} 条 · bin=${BIN}\n`);
  for (const r of rows) {
    const flags = [
      r.archived ? 'ARCHIVED' : 'active',
      r.lastTurnReason ? `last=${r.lastTurnReason}` : '',
      'busy=?',
    ]
      .filter(Boolean)
      .join(' ');
    console.log(`${r.id}  ${flags.padEnd(28)} ${iso(r.updatedAt)}  ${oneLine(r.workDir, 28)}  ${oneLine(r.title, 56)}`);
  }
  console.log('\nbusy 只有 REST snapshot 才知道；本探针不连服务，故为 null（?）。');
  console.log('选专席候选时优先看 workDir / 最近更新时间；房间席位必须专席专用，勿占用机主正在用的会话。');
}
