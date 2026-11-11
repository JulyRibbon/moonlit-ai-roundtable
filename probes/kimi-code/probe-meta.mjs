// probes/kimi-code/probe-meta.mjs — 只读：读取本机实例的 meta / OpenAPI / AsyncAPI（零模型调用）
//
// 用法：
//   node probes/kimi-code/probe-meta.mjs [--json]
//
// 输出约束：
//   - 只打印 server_version、capabilities、REST method+path 清单、WS 控制帧/事件名清单。
//   - 不打印完整 OpenAPI / AsyncAPI，不打印任何 token 或请求头。
//   - 规范以本机实例为准；版本升级后先跑本探针，再改 Bridge。

import {
  KimiApi,
  formatError,
  loadToken,
  resolveBase,
} from './lib.mjs';

const args = process.argv.slice(2);
const opt = { json: false, timeoutMs: 15000 };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--json') opt.json = true;
  else if (a === '--timeout') opt.timeoutMs = Number(args[++i]) || opt.timeoutMs;
  else if (a === '-h' || a === '--help') {
    console.log('用法: probe-meta.mjs [--json] [--timeout ms]');
    process.exit(0);
  } else {
    console.error(`未知参数：${a}`);
    process.exit(2);
  }
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function refName(ref) {
  if (typeof ref !== 'string') return null;
  const tail = ref.split('/').pop();
  return tail || null;
}

function collectRest(openapi) {
  const paths = openapi?.paths && typeof openapi.paths === 'object' ? openapi.paths : {};
  const endpoints = [];
  for (const [p, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const m of METHODS) {
      if (item[m] && typeof item[m] === 'object') {
        endpoints.push({ method: m.toUpperCase(), path: p });
      }
    }
  }
  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
  return {
    title: openapi?.info?.title ?? null,
    specVersion: openapi?.openapi ?? openapi?.swagger ?? null,
    pathCount: Object.keys(paths).length,
    endpoints,
  };
}

function collectAsync(asyncapi) {
  const channels = Object.keys(asyncapi?.channels ?? {});
  const messageNames = new Set(Object.keys(asyncapi?.components?.messages ?? {}));
  const operations = [];

  for (const [name, op] of Object.entries(asyncapi?.operations ?? {})) {
    const action = op?.action ?? null;
    const channel = refName(op?.channel?.$ref) ?? (typeof op?.channel === 'string' ? op.channel : null);
    operations.push({ name, action, channel });
    for (const msg of Object.values(op?.messages ?? {})) {
      const n = refName(msg?.$ref) ?? msg?.name ?? null;
      if (n) messageNames.add(n);
    }
  }

  // AsyncAPI 2 的 publish/subscribe 写法
  for (const [chName, ch] of Object.entries(asyncapi?.channels ?? {})) {
    for (const dir of ['publish', 'subscribe']) {
      const op = ch?.[dir];
      if (!op) continue;
      const msg = op.message;
      const n = refName(msg?.$ref) ?? msg?.name ?? null;
      if (n) messageNames.add(n);
      operations.push({ name: `${chName}:${dir}`, action: dir, channel: chName });
    }
  }

  const controlFrames = [...messageNames].filter((n) =>
    /^(subscribe|unsubscribe|client_hello|ping|pong|ack|response)/i.test(n),
  );

  return {
    title: asyncapi?.info?.title ?? null,
    specVersion: asyncapi?.asyncapi ?? null,
    channels,
    operations,
    events: [...messageNames].sort(),
    controlFrames: controlFrames.sort(),
  };
}

let token;
try {
  token = await loadToken();
} catch (e) {
  console.error(formatError(e, token));
  process.exit(1);
}

const base = resolveBase();
const api = new KimiApi({ base, token, timeoutMs: opt.timeoutMs });

try {
  const [meta, openapi, asyncapi] = await Promise.all([
    api.meta(),
    api.openapi(),
    api.asyncapi(),
  ]);

  const rest = collectRest(openapi);
  const ws = collectAsync(asyncapi);
  const payload = {
    base,
    server: {
      server_version: meta?.server_version ?? null,
      capabilities: meta?.capabilities ?? null,
    },
    rest,
    ws,
  };

  if (opt.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(`Kimi Code meta · ${base}`);
    console.log(`server_version: ${payload.server.server_version ?? '?'}`);
    const caps = payload.server.capabilities;
    console.log(
      `capabilities: ${caps ? Object.entries(caps).map(([k, v]) => `${k}=${v}`).join(' ') : '?'}`,
    );
    console.log(
      `\nREST（${rest.specVersion ?? '?'} · ${rest.pathCount} 个 path · ${rest.endpoints.length} 个操作）`,
    );
    for (const e of rest.endpoints) console.log(`  ${e.method.padEnd(6)} ${e.path}`);

    console.log(`\nWS（AsyncAPI ${ws.specVersion ?? '?'}）`);
    console.log(`  channels: ${ws.channels.length ? ws.channels.join(', ') : '(无)'}`);
    if (ws.operations.length) {
      console.log(
        `  operations: ${ws.operations
          .map((o) => `${o.name}${o.action ? `[${o.action}]` : ''}`)
          .join(', ')}`,
      );
    }
    console.log(`  events: ${ws.events.length ? ws.events.join(', ') : '(本机 AsyncAPI 未列出可识别的事件名)'}`);
    console.log(
      `  controlFrames: ${
        ws.controlFrames.length ? ws.controlFrames.join(', ') : '(未声明；probe-ws 使用 subscribe_v2 / unsubscribe_v2)'
      }`,
    );
  }
} catch (e) {
  console.error(formatError(e, token));
  process.exit(1);
}
