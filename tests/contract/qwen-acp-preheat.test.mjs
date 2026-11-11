import test from 'node:test';
import assert from 'node:assert/strict';

import { buildServeArgs, QWEN_DEFAULT_INITIALIZE_TIMEOUT_MS } from '../../adapters/qwen-code/runtime.mjs';
import { QwenDaemonClient, QwenDaemonError } from '../../adapters/qwen-code/client.mjs';

function fetchRecorder(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const result = handler({ url: String(url), init });
    if (result instanceof Error) throw result;
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      text: async () => (result.body === undefined ? '' : JSON.stringify(result.body)),
    };
  };
  return { calls, fetchImpl };
}

test('buildServeArgs adds a 60s initialize timeout by default', () => {
  assert.equal(QWEN_DEFAULT_INITIALIZE_TIMEOUT_MS, 60000);
  const args = buildServeArgs({ entry: 'cli-entry.js', port: 58691, workspace: 'C:\\ws' });
  assert.deepEqual(args, [
    'cli-entry.js',
    'serve',
    '--port', '58691',
    '--hostname', '127.0.0.1',
    '--workspace', 'C:\\ws',
    '--no-web',
    '--initialize-timeout-ms', '60000',
  ]);
});

test('buildServeArgs accepts an explicit initialize timeout and can omit it', () => {
  const custom = buildServeArgs({
    entry: 'cli-entry.js',
    port: 58691,
    workspace: 'C:\\ws',
    initializeTimeoutMs: 120000,
  });
  assert.equal(custom[custom.indexOf('--initialize-timeout-ms') + 1], '120000');

  const omitted = buildServeArgs({
    entry: 'cli-entry.js',
    port: 58691,
    workspace: 'C:\\ws',
    initializeTimeoutMs: null,
  });
  assert.equal(omitted.includes('--initialize-timeout-ms'), false);
});

test('workspaceAcpPreheat POSTs the budget as a query and returns the body', async () => {
  const { calls, fetchImpl } = fetchRecorder(() => ({
    status: 200,
    body: { ready: true, channelLive: true, durationMs: 12 },
  }));
  const client = new QwenDaemonClient({ baseUrl: 'http://127.0.0.1:58691', fetchImpl });
  const body = await client.workspaceAcpPreheat({ timeoutMs: 60000 });
  assert.deepEqual(body, { ready: true, channelLive: true, durationMs: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].url, 'http://127.0.0.1:58691/workspace/acp/preheat?timeoutMs=60000');
});

test('workspaceAcpPreheat defaults to the 60s server budget', async () => {
  const { calls, fetchImpl } = fetchRecorder(() => ({
    status: 200,
    body: { ready: true, channelLive: true },
  }));
  const client = new QwenDaemonClient({ baseUrl: 'http://127.0.0.1:58691', fetchImpl });
  await client.workspaceAcpPreheat();
  assert.equal(calls[0].url, 'http://127.0.0.1:58691/workspace/acp/preheat?timeoutMs=60000');
});

test('workspaceAcpPreheat throws QwenDaemonError when the channel is not live', async () => {
  for (const body of [
    { ready: false, channelLive: false, reason: 'timeout', error: 'ACP preheat did not complete before the timeout' },
    { ready: true, channelLive: false },
    { ready: false, channelLive: true, error: 'ACP preheat failed' },
  ]) {
    const { fetchImpl } = fetchRecorder(() => ({ status: 200, body }));
    const client = new QwenDaemonClient({ baseUrl: 'http://127.0.0.1:58691', fetchImpl });
    await assert.rejects(
      () => client.workspaceAcpPreheat({ timeoutMs: 5000 }),
      (error) => {
        assert.ok(error instanceof QwenDaemonError);
        assert.equal(error.code, 'QWEN_ACP_PREHEAT_FAILED');
        return true;
      },
    );
  }
});

test('resumeSession keeps the 90s HTTP budget and never sends timeoutMs in the body', async () => {
  const { calls, fetchImpl } = fetchRecorder(() => ({
    status: 200,
    body: { sessionId: 'sess-1', clientId: 'c-1' },
  }));
  const client = new QwenDaemonClient({ baseUrl: 'http://127.0.0.1:58691', fetchImpl });
  await client.resumeSession('sess-1', { cwd: 'C:\\ws' });
  assert.equal(calls[0].url, 'http://127.0.0.1:58691/session/sess-1/resume');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body, { cwd: 'C:\\ws' });
  assert.equal('timeoutMs' in body, false);
});

test('workspaceAcpPreheat rejects an invalid budget before any request', async () => {
  const { calls, fetchImpl } = fetchRecorder(() => ({ status: 200, body: { ready: true, channelLive: true } }));
  const client = new QwenDaemonClient({ baseUrl: 'http://127.0.0.1:58691', fetchImpl });
  await assert.rejects(
    () => client.workspaceAcpPreheat({ timeoutMs: 0 }),
    (error) => error.code === 'PREHEAT_TIMEOUT_INVALID',
  );
  assert.equal(calls.length, 0);
});
