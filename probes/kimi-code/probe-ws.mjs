// probes/kimi-code/probe-ws.mjs — 只读：握手 → subscribe_v2 → unsubscribe_v2（零模型调用）
//
// 用法：
//   node probes/kimi-code/probe-ws.mjs --session session_xxx [--watch 3000] [--json]
//
// 约束：
//   - 必填 --session：只订阅机主指定的原生会话，不新建会话、不投递 prompt、不取消轮次。
//   - transcript 使用 turn 级别（{"*":"turn"}），不订阅 delta / block 细粒度正文。
//   - 只打印 ack/code 与事件元数据（type、count、seq、payload 键名、op 类型）；
//     不打印 assistant 正文、thinking、tool 输出或任何 token。
//   - 明文超时 + 主动 close，正常退出，不悬挂。

import {
  bearerSubprotocol,
  formatError,
  loadToken,
  resolveBase,
  wsUrl,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = {
  session: '',
  watchMs: 3000,
  timeoutMs: null,
  since: null,
  grade: 'turn',
  json: false,
};
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--session') opt.session = String(args[++i] ?? '');
  else if (a === '--watch') opt.watchMs = Number(args[++i]) || opt.watchMs;
  else if (a === '--timeout') opt.timeoutMs = Number(args[++i]) || null;
  else if (a === '--since') opt.since = Number(args[++i]) || null;
  else if (a === '--grade') opt.grade = String(args[++i] ?? 'turn');
  else if (a === '--json') opt.json = true;
  else if (a === '-h' || a === '--help') {
    console.log('用法: probe-ws.mjs --session <id> [--watch ms] [--timeout ms] [--since seq] [--grade turn] [--json]');
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}

if (!opt.session) {
  console.error('必须提供 --session <id>；本探针不会自动挑选或新建会话。');
  process.exit(2);
}
if (!['off', 'turn', 'block', 'delta'].includes(opt.grade)) {
  console.error(`--grade 只支持 off / turn / block / delta（默认 turn）`);
  process.exit(2);
}
if (typeof WebSocket === 'undefined') {
  console.error('当前 Node 没有内置 WebSocket；需要 Node >= 22。');
  process.exit(3);
}

const base = resolveBase();
const url = wsUrl(base);
const hardTimeoutMs = opt.timeoutMs ?? Math.max(10000, opt.watchMs + 10000);

let token;
try {
  token = await loadToken();
} catch (e) {
  console.error(formatError(e, token));
  process.exit(1);
}

const startedAt = Date.now();
const frames = new Map();
let hello = null;
let helloOk = false;
let subAck = null;
let unsubAck = null;
let unsubSent = false;
let subscribed = false;
let fatal = null;
let closing = false;
let emitted = false;
let closeInfo = null;
let parseErrors = 0;

let hardTimer = null;
let watchTimer = null;
let unsubTimer = null;
let closeTimer = null;

function safeMsg(v) {
  return String(v ?? '').replace(/\s+/g, ' ').slice(0, 200);
}

const ENVELOPE_KEYS = new Set([
  'type',
  'seq',
  'epoch',
  'volatile',
  'offset',
  'session_id',
  'timestamp',
  'event_created_at',
  'id',
  'code',
  'msg',
  'request_id',
]);

function recordFrame(msg) {
  const type = typeof msg?.type === 'string' ? msg.type : '(untyped)';
  const rec =
    frames.get(type) ??
    {
      type,
      count: 0,
      seqs: [],
      payloadKeys: new Set(),
      opTypes: new Map(),
      sessionIds: new Set(),
    };
  rec.count += 1;
  if (Number.isFinite(msg?.seq)) {
    rec.seqs.push(msg.seq);
    if (rec.seqs.length > 10) rec.seqs.shift();
  }
  if (typeof msg?.session_id === 'string') rec.sessionIds.add(msg.session_id);

  const payload = msg?.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    for (const k of Object.keys(payload)) rec.payloadKeys.add(k);
  } else {
    // 扁平帧（agent / usage / goal / todo / task / task_list）字段直接挂在顶层。
    for (const k of Object.keys(msg ?? {})) {
      if (!ENVELOPE_KEYS.has(k)) rec.payloadKeys.add(k);
    }
  }

  const ops = Array.isArray(payload?.ops)
    ? payload.ops
    : Array.isArray(payload?.items)
      ? payload.items
      : null;
  if (ops) {
    for (const op of ops) {
      const t = op?.type ?? op?.kind ?? op?.op ?? op?.frame?.type ?? '?';
      rec.opTypes.set(t, (rec.opTypes.get(t) ?? 0) + 1);
    }
  }
  frames.set(type, rec);
}

function send(frame) {
  try {
    ws.send(JSON.stringify(frame));
    return true;
  } catch (e) {
    fatal = `发送 ${frame.type} 失败：${safeMsg(e?.message)}`;
    conclude();
    return false;
  }
}

function cleanupTimers() {
  clearTimeout(hardTimer);
  clearTimeout(watchTimer);
  clearTimeout(unsubTimer);
  clearTimeout(closeTimer);
}

function emit() {
  if (emitted) return;
  emitted = true;
  cleanupTimers();

  const frameRows = [...frames.values()]
    .map((r) => ({
      type: r.type,
      count: r.count,
      seqs: r.seqs,
      payloadKeys: [...r.payloadKeys].sort(),
      opTypes: Object.fromEntries([...r.opTypes.entries()].sort()),
      sessionIds: [...r.sessionIds],
    }))
    .sort((a, b) => a.type.localeCompare(b.type));

  // 本机实测：对不存在的 session id，subscribe_v2 仍回 ack code=0 且不报错。
  // 用一个正向信号兜底：观察窗口内至少要收到会话帧（agent / usage / transcript.reset 等）。
  const sawSessionFrames = frameRows.length > 0;

  const pass =
    helloOk &&
    hello?.protocolVersion === 2 &&
    subAck?.code === 0 &&
    unsubSent &&
    unsubAck?.code === 0 &&
    (opt.watchMs === 0 || sawSessionFrames) &&
    !fatal;

  const report = {
    url,
    session: opt.session,
    grade: opt.grade,
    watchMs: opt.watchMs,
    elapsedMs: Date.now() - startedAt,
    hello: hello
      ? {
          protocolVersion: hello.protocolVersion,
          maxEventBufferSize: hello.maxEventBufferSize,
          capabilities: hello.capabilities,
        }
      : null,
    subscribeAck: subAck,
    unsubscribeAck: unsubAck,
    frames: frameRows,
    sawSessionFrames,
    parseErrors,
    close: closeInfo,
    fatal,
    pass,
  };

  if (opt.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Kimi Code WS 探针 · ${url}`);
    console.log(`session: ${opt.session} · transcript grade: ${opt.grade} · 观察 ${opt.watchMs}ms\n`);

    console.log(
      `server_hello: ${
        hello ? `protocol_version=${hello.protocolVersion}` : '(未收到)'
      } ${helloOk ? 'OK' : 'FAIL'}`,
    );
    if (hello?.capabilities) {
      console.log(
        `  capabilities: ${Object.entries(hello.capabilities)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')}`,
      );
    }

    console.log(
      `subscribe_v2: ${subAck ? `ack code=${subAck.code}${subAck.msg ? ` msg=${safeMsg(subAck.msg)}` : ''}` : '(无 ack)'}`,
    );

    console.log(`\n观察到的帧（仅元数据，不含正文）：${frameRows.length ? '' : '(无)'}`);
    for (const r of frameRows) {
      const opText = Object.keys(r.opTypes).length
        ? ` ops=${Object.entries(r.opTypes).map(([k, v]) => `${k}:${v}`).join(',')}`
        : '';
      const seqText = r.seqs.length ? ` seq=${r.seqs.join(',')}` : '';
      console.log(
        `  ${r.type} x${r.count}${seqText}${opText}  keys=[${r.payloadKeys.join(',')}]`,
      );
    }
    if (parseErrors) console.log(`  非 JSON 帧：${parseErrors}`);

    console.log(
      `\nunsubscribe_v2: ${unsubSent ? '已发送' : '未发送'} · ${
        unsubAck ? `ack code=${unsubAck.code}${unsubAck.msg ? ` msg=${safeMsg(unsubAck.msg)}` : ''}` : '(无 ack)'
      }`,
    );
    console.log(`close: ${closeInfo ? `code=${closeInfo.code}${closeInfo.reason ? ` reason=${safeMsg(closeInfo.reason)}` : ''}` : '(客户端主动关闭)'}`);
    if (fatal) console.log(`fatal: ${fatal}`);
    if (!sawSessionFrames && opt.watchMs > 0) {
      console.log('注意：观察窗口内没有任何会话帧；本机对不存在的 session id 也会回 ack code=0，请核对 --session。');
    }
    console.log(`\n判定：${pass ? 'PASS' : 'FAIL'} · 耗时 ${report.elapsedMs}ms`);
    if (!pass) {
      console.log('提示：若 code=40101 检查 token；40401 检查 --session；40931/40932 表示会话被占用或更新。');
    }
  }

  console.log('\n（本探针零模型调用：未投递 prompt、未新建/归档会话、未读取正文。）');
  setTimeout(() => process.exit(pass ? 0 : 1), 150);
}

function conclude() {
  if (closing) return;
  closing = true;
  cleanupTimers();
  try {
    ws.close(1000, 'probe done');
  } catch {
    /* ignore */
  }
  closeTimer = setTimeout(emit, 800);
}

function startUnsubscribe() {
  if (!subscribed || unsubSent) return;
  unsubSent = true;
  send({
    type: 'unsubscribe_v2',
    id: 'unsub-1',
    payload: { session_id: opt.session },
  });
  unsubTimer = setTimeout(() => {
    if (!unsubAck && !fatal) fatal = `unsubscribe_v2 未在 2500ms 内收到 ack`;
    conclude();
  }, 2500);
}

const ws = new WebSocket(url, [bearerSubprotocol(token)]);

ws.addEventListener('open', () => {
  const payload = {
    session_id: opt.session,
    transcript: { '*': opt.grade },
  };
  if (Number.isFinite(opt.since)) payload.transcript_since = opt.since;
  send({ type: 'subscribe_v2', id: 'sub-1', payload });
});

ws.addEventListener('message', (event) => {
  let msg;
  try {
    msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
  } catch {
    parseErrors += 1;
    return;
  }

  if (msg?.type === 'server_hello') {
    const p = msg.payload ?? {};
    hello = {
      protocolVersion: p.protocol_version ?? null,
      maxEventBufferSize: p.max_event_buffer_size ?? null,
      capabilities: p.capabilities ?? null,
    };
    helloOk = hello.protocolVersion === 2;
    if (!helloOk) {
      fatal = `server_hello protocol_version=${hello.protocolVersion ?? '?'}，期望 2`;
      conclude();
    }
    return;
  }

  if (msg?.type === 'ack') {
    const ack = {
      id: msg.id ?? null,
      code: msg.code ?? null,
      msg: msg.msg ?? null,
    };
    if (msg.id === 'sub-1') {
      subAck = ack;
      if (ack.code === 0) {
        subscribed = true;
        watchTimer = setTimeout(startUnsubscribe, opt.watchMs);
      } else {
        fatal = `subscribe_v2 被拒绝（code=${ack.code}）`;
        conclude();
      }
      return;
    }
    if (msg.id === 'unsub-1') {
      unsubAck = ack;
      conclude();
      return;
    }
    return;
  }

  recordFrame(msg);
});

ws.addEventListener('error', (event) => {
  const detail = event?.message || event?.error?.message || 'WebSocket error';
  fatal = `连接错误：${safeMsg(detail)}`;
  conclude();
});

ws.addEventListener('close', (event) => {
  closeInfo = { code: event?.code ?? null, reason: event?.reason ?? null };
  if (closing) {
    emit();
    return;
  }
  if (!fatal) fatal = `连接在探针完成前关闭（code=${closeInfo.code ?? '?'}）`;
  closing = true;
  cleanupTimers();
  emit();
});

hardTimer = setTimeout(() => {
  if (!fatal) fatal = `总超时 ${hardTimeoutMs}ms`;
  conclude();
}, hardTimeoutMs);

if (!hello) {
  // server_hello 在 open 后立即到达；这里不阻塞，硬超时会兜底。
}
