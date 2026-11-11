// probes/zcode/probe-meta.mjs — 零成本：读取 ZCode app-server 能力与会话元数据
//
// 用法：
//   node probes/zcode/probe-meta.mjs [--limit 5] [--prefix 12] [--title] [--json] [--timeout ms]
//
// 只做两件事：
//   1) runtime/capabilities {}   → 只打印能力布尔值
//   2) session/list {limit:N}    → 只打印会话数量与元数据
//
// 明确不做：resume / send / stop / close 会话，不读取消息正文，不调用模型，
// 不打开 GUI，不常驻 app-server。title 默认不打印；--title 才显示（标题可能含用户输入）。

import { AppServerClient, basenameOf, formatTime, isPlainObject, redact } from './lib.mjs';

const args = process.argv.slice(2);
const opt = {
  limit: 5,
  prefix: 12,
  title: false,
  json: false,
  timeoutMs: 20000,
  surface: 'desktop',
};
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--limit') opt.limit = Math.max(1, Number(args[++i]) || 5);
  else if (a === '--prefix') opt.prefix = Math.max(0, Number(args[++i]) || 0);
  else if (a === '--title') opt.title = true;
  else if (a === '--json') opt.json = true;
  else if (a === '--timeout') opt.timeoutMs = Number(args[++i]) || opt.timeoutMs;
  else if (a === '-h' || a === '--help') {
    console.log(
      '用法: probe-meta.mjs [--limit N] [--prefix N] [--title] [--json] [--timeout ms]',
    );
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  return !!pass;
}

const client = new AppServerClient({ requestTimeoutMs: opt.timeoutMs, surface: opt.surface });
let caps = null;
let capsKeys = [];
let sessions = [];
let fatal = null;
let closeInfo = null;

try {
  client.start();
  const capsReply = await client.request('runtime/capabilities', {});
  if (capsReply.error) {
    check('runtime/capabilities 无 error', false, redact(JSON.stringify(capsReply.error)));
  } else if (!isPlainObject(capsReply.result)) {
    check('runtime/capabilities 返回对象', false, typeof capsReply.result);
  } else {
    caps = capsReply.result;
    capsKeys = Object.keys(caps);
    check('runtime/capabilities 返回对象', true, `${capsKeys.length} 个键`);
    check(
      'capabilities 至少一个布尔能力',
      capsKeys.some((k) => typeof caps[k] === 'boolean'),
    );
    const nonBool = capsKeys.filter((k) => typeof caps[k] !== 'boolean');
    if (nonBool.length) {
      check('capabilities 全部为布尔值', false, `非布尔：${nonBool.join(', ')}`);
    } else {
      check('capabilities 全部为布尔值', true);
    }
  }

  const listReply = await client.request('session/list', { limit: opt.limit });
  if (listReply.error) {
    check('session/list 无 error', false, redact(JSON.stringify(listReply.error)));
  } else {
    const result = listReply.result;
    sessions = Array.isArray(result?.sessions)
      ? result.sessions
      : Array.isArray(result)
        ? result
        : null;
    check('session/list 返回 sessions 数组', Array.isArray(sessions), Array.isArray(sessions) ? `count=${sessions.length}` : typeof result);
    if (Array.isArray(sessions)) {
      const bad = sessions.filter(
        (s) => !isPlainObject(s) || typeof s.sessionId !== 'string' || !s.sessionId,
      );
      check('每项都有 sessionId', bad.length === 0, bad.length ? `${bad.length} 项缺失` : undefined);
      const withMode = sessions.filter((s) => typeof s.mode === 'string').length;
      const withStatus = sessions.filter((s) => typeof s.status === 'string').length;
      check('mode / status 字段存在', withMode === sessions.length && withStatus === sessions.length,
        `mode=${withMode}/${sessions.length}, status=${withStatus}/${sessions.length}`);
      const modelCount = sessions.filter((s) => typeof s.model === 'string').length;
      check('model 字段（实测形状可缺省）', true, `model=${modelCount}/${sessions.length}`);
    }
  }
} catch (err) {
  fatal = redact(err?.message || err);
  check('app-server 请求流程完成', false, fatal);
} finally {
  closeInfo = await client.close();
}

check('子进程已退出', closeInfo?.exited === true,
  `code=${closeInfo?.code ?? '-'}${closeInfo?.killed ? ', 已强制结束进程树' : ''}`);

const pass = checks.every((c) => c.pass) && !fatal;

function shortId(id) {
  const s = String(id ?? '');
  if (!s) return null;
  if (opt.prefix <= 0) return s;
  return s.slice(0, opt.prefix);
}

const rows = sessions.map((s) => ({
  sessionId: shortId(s.sessionId),
  model: typeof s.model === 'string' ? s.model : null,
  mode: s.mode ?? null,
  status: s.status ?? null,
  workspace: basenameOf(s.workspace?.workspacePath),
  updatedAt: formatTime(s.updatedAt),
  ...(opt.title ? { title: s.title ?? null } : {}),
}));

const report = {
  ok: pass,
  capabilities: caps,
  sessionCount: sessions.length,
  sessions: rows,
  notifications: Object.fromEntries(client.notificationCounts),
  malformedLines: client.malformed,
  stderr: client.stderrTail ? redact(client.stderrTail).split(/\r?\n/).slice(0, 5) : [],
  close: closeInfo,
  checks,
  ...(fatal ? { error: fatal } : {}),
};

if (opt.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('ZCode app-server M0 元数据（零模型调用）');
  if (caps) {
    console.log('\n能力（runtime/capabilities）:');
    for (const k of capsKeys.sort()) {
      console.log(`  ${k}: ${typeof caps[k] === 'boolean' ? caps[k] : JSON.stringify(caps[k])}`);
    }
  }
  console.log(`\n会话（session/list limit=${opt.limit}）: 返回 ${sessions.length} 条`);
  if (rows.length) {
    console.log('  #   sessionId       mode   status  model  workspace                 updatedAt');
    rows.forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padEnd(3)} ${String(r.sessionId ?? '-').padEnd(15)} ${String(r.mode ?? '-').padEnd(6)} ${String(r.status ?? '-').padEnd(7)} ${String(r.model ?? '-').padEnd(6)} ${String(r.workspace ?? '-').padEnd(25)} ${r.updatedAt ?? '-'}`,
      );
      if (opt.title) console.log(`      title: ${r.title ?? '(无)'}`);
    });
  }
  const notif = Object.entries(client.notificationCounts);
  if (notif.length) {
    console.log(`\n通知: ${notif.map(([m, n]) => `${m} × ${n}`).join(', ')}`);
  }
  if (client.malformed) console.log(`非 JSON 行: ${client.malformed}`);
  if (report.stderr.length) console.log(`stderr（已脱敏，最多 5 行）:\n  ${report.stderr.join('\n  ')}`);
  console.log(
    `\n关闭: 已退出=${closeInfo?.exited ? '是' : '否'} code=${closeInfo?.code ?? '-'}${closeInfo?.killed ? '（强制结束进程树）' : ''}`,
  );
  console.log('');
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` (${c.detail})` : ''}`);
  }
}

process.exit(pass ? 0 : 1);
