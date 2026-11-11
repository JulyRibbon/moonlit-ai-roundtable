// Qwen Code 运行时的共用小工具：给 start-all 与 probes 共用，避免两处各猜一遍安装路径。
//
// 只负责「找可执行文件 / 拼 serve 参数 / 探活」，不做任何会话操作。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const QWEN_DEFAULT_PORT = 58691;

/** 返回 { node, entry, source }；都找不到时抛错，消息里给出可设置的覆盖变量。 */
export function resolveQwenRuntime({ env = process.env, fileExists = defaultFileExists } = {}) {
  const candidates = [];
  if (env.AIROOM_QWEN_NODE && env.AIROOM_QWEN_ENTRY) {
    candidates.push({ node: env.AIROOM_QWEN_NODE, entry: env.AIROOM_QWEN_ENTRY, source: 'env' });
  }
  const desktopRuntime = path.join(
    env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'Qwen Code Desktop',
    'runtime',
    'qwen-code',
  );
  candidates.push({
    node: path.join(desktopRuntime, 'node', 'node.exe'),
    entry: path.join(desktopRuntime, 'lib', 'cli-entry.js'),
    source: 'desktop-bundle',
  });
  for (const candidate of candidates) {
    if (fileExists(candidate.node) && fileExists(candidate.entry)) return candidate;
  }
  throw new Error(
    '找不到 Qwen Code 运行时：请设置 AIROOM_QWEN_NODE + AIROOM_QWEN_ENTRY，'
    + `或安装 Qwen Code Desktop（预期 ${desktopRuntime}）。`,
  );
}

/**
 * serve 进程的 ACP initialize 默认只有 10s；宿主机忙时恢复会话会先卡在 initialize。
 * 默认给 60s，可按需覆盖（0 或 null 时不追加该参数，回到守护进程默认值）。
 */
export const QWEN_DEFAULT_INITIALIZE_TIMEOUT_MS = 60000;

export function buildServeArgs({ entry, port, workspace, initializeTimeoutMs = QWEN_DEFAULT_INITIALIZE_TIMEOUT_MS }) {
  const args = [
    entry,
    'serve',
    '--port', String(port),
    '--hostname', '127.0.0.1',
    '--workspace', workspace,
    '--no-web',
  ];
  if (initializeTimeoutMs !== undefined && initializeTimeoutMs !== null) {
    args.push('--initialize-timeout-ms', String(initializeTimeoutMs));
  }
  return args;
}

/** 只读探活：/health 返回任意非 5xx 即视为已就绪（回环免 token）。 */
export async function checkQwenHealth(baseUrl, { fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined;
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/health`, {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    const status = Number(response?.status);
    const healthy = Number.isFinite(status) && status < 500;
    response?.body?.cancel?.().catch?.(() => {});
    return healthy;
  } catch {
    return false;
  }
}

function defaultFileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
