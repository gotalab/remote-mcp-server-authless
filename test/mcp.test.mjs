import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Exercise the installed bundler and local Workers runtime, including Durable Objects.
test('calculator works over both MCP transports', { timeout: 60_000 }, async (t) => {
  const server = spawn(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'dev', '--local',
    '--ip', '127.0.0.1', '--port', '8788', '--inspector-port', '0',
  ], { env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' } });
  let output = '';
  server.stdout.on('data', (chunk) => { output += chunk; });
  server.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      await exited;
    }
  });

  const base = 'http://127.0.0.1:8788';
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, output);
    try {
      const response = await fetch(base, { signal: AbortSignal.timeout(500) });
      if (response.status === 404) { ready = true; break; }
    } catch { /* Wait for the local runtime to bind its port. */ }
    await setTimeout(200);
  }
  assert.ok(ready, output);

  for (const [path, Transport] of [
    ['/mcp', StreamableHTTPClientTransport], ['/sse', SSEClientTransport],
  ]) {
    await t.test(path, async () => {
      const client = new Client({ name: 'tooling-smoke-test', version: '1.0.0' });
      try {
        await client.connect(new Transport(new URL(path, base)));
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map(({ name }) => name).sort(), ['add', 'calculate']);
        const cases = [
          ['add', { a: 2, b: 3 }, '5'],
          ['calculate', { operation: 'add', a: 2, b: 3 }, '5'],
          ['calculate', { operation: 'subtract', a: 9, b: 4 }, '5'],
          ['calculate', { operation: 'multiply', a: 3, b: 4 }, '12'],
          ['calculate', { operation: 'divide', a: 9, b: 3 }, '3'],
          ['calculate', { operation: 'divide', a: 9, b: 0 }, 'Error: Cannot divide by zero'],
        ];
        for (const [name, args, expected] of cases) {
          const result = await client.callTool({ name, arguments: args });
          assert.equal(result.content[0].text, expected);
        }
      } finally {
        await client.close();
      }
    });
  }
});
