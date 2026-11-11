// probes/dsh/probe-list.mjs — 只读：列 DSH 原生会话（不建会话、不发消息、不花钱）
//
// 用法：
//   $node probes\dsh\probe-list.mjs [--limit 20] [--grep 关键词] [--json]
//
// 说明：
//   - 走 qq-bridge 已验证的 DSH 协议客户端（离线铸造 Cookie，不依赖启动 token）
//   - 运行 Node 必须 >= 22.13；本机 PATH 上的 node 是 v18.12.1，会报 crypto is not defined
//     正确路径见 docs/dsh-m0-probe-2026-11-08.md §七

import { NodeApiClient } from '../../adapters/dsh/dsh-client.mjs';

const BASE = process.env.AIROOM_DSH_BASE || 'http://127.0.0.1:2955';

const args = process.argv.slice(2);
const opt = { limit: 20, grep: '', json: false };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--limit') opt.limit = Number(args[++i]) || 20;
  else if (a === '--grep') opt.grep = String(args[++i] ?? '');
  else if (a === '--json') opt.json = true;
  else if (a === '-h' || a === '--help') {
    console.log('用法: probe-list.mjs [--limit N] [--grep 关键词] [--json]');
    process.exit(0);
  }
}

const api = new NodeApiClient(BASE, 20000, {});
const res = await api.sessions.list({});
if (!res?.result?.ok) {
  console.error('sessions.list 失败:', JSON.stringify(res?.result?.error ?? res));
  process.exit(1);
}

const items = res.result.value?.items ?? [];
const rows = items
  .map((s) => {
    const v = s.projections?.values ?? {};
    return {
      sessionId: s.sessionId,
      title: v.title ?? '(无标题)',
      running: !!s.running,
      blank: !!s.blank,
      cwd: s.cwd,
      preset: v.agentPreset ?? null,
      model: v.modelSelection?.next ?? null,
      inbox: {
        nextTurn: v.inbox?.['next-turn']?.length ?? 0,
        nextStep: v.inbox?.['next-step']?.length ?? 0,
      },
      tokens: v.tokenUsage ?? null,
      updatedAt: s.updatedAt ?? null,
    };
  })
  .filter((r) => (opt.grep ? String(r.title).includes(opt.grep) || String(r.sessionId).includes(opt.grep) : true))
  .slice(0, opt.limit);

if (opt.json) {
  console.log(JSON.stringify({ base: BASE, total: items.length, rows }, null, 2));
} else {
  console.log(`DSH ${BASE} · 会话总数 ${items.length} · 显示 ${rows.length} 条\n`);
  for (const r of rows) {
    const t = r.updatedAt ? new Date(r.updatedAt).toISOString().slice(0, 16).replace('T', ' ') : '?';
    const flags = [r.running ? 'RUNNING' : 'idle', r.blank ? 'blank' : '', r.inbox.nextTurn ? `队列${r.inbox.nextTurn}` : '']
      .filter(Boolean).join(' ');
    console.log(`${r.sessionId}  ${flags.padEnd(14)} preset=${String(r.preset).padEnd(11)} ${t}  ${r.title}`);
  }
  console.log('\n提示：选席位会话时优先看 preset / cwd / 是否 running；房间席位必须专席专用。');
}
