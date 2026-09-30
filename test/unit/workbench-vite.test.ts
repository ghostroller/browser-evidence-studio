import { createServer as createTcpServer } from 'node:net';
import path from 'node:path';
import { createServer } from 'vite';
import { expect, test } from 'vitest';

test('real Vite HTML transform has one nonsecret instance identity and explicit browser host', async () => {
  const portProbe = createTcpServer(); await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const address = portProbe.address(); if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const keys = ['BES_WORKBENCH_BROWSER_PORT', 'BES_WORKBENCH_TARGET_PORT', 'BES_WORKBENCH_INSTANCE_ID', 'BES_WORKBENCH_REPLAY_ORIGIN'] as const;
  const before = keys.map(key => process.env[key]);
  process.env.BES_WORKBENCH_BROWSER_PORT = String(address.port);
  process.env.BES_WORKBENCH_TARGET_PORT = '9';
  process.env.BES_WORKBENCH_INSTANCE_ID = 'vite-fixture-instance';
  process.env.BES_WORKBENCH_REPLAY_ORIGIN = 'http://127.0.0.1:9876';
  let server: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    // HTML/proxy fixture: do not launch the asynchronous whole-app dependency
    // optimizer, whose complete module graph is exercised by real browser QA.
    server = await createServer({ configFile: path.resolve('vite.browser.config.ts'), logLevel: 'silent', optimizeDeps: { noDiscovery: true, include: [] } }); await server.listen();
    const response = await fetch(`http://127.0.0.1:${address.port}/browser.html`);
    expect(response.status).toBe(200); const html = await response.text();
    expect(html.match(/name="workbench-instance"/g)).toHaveLength(1);
    expect(html).toContain('content="vite-fixture-instance"');
    expect(html).toContain('data-workbench-host="browser"');
    expect(html).toContain("frame-src 'self' about: http://127.0.0.1:9876");
    expect(html).toContain('name="workbench-replay-origin"');
    expect(html).not.toMatch(/Bearer |ticket=|token=/);
    const module = await fetch(`http://127.0.0.1:${address.port}/index.tsx`);
    expect(module.status).toBe(200);
    const denied = await fetch(`http://127.0.0.1:${address.port}/workbench/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(403); expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  } finally {
    await server?.close();
    keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
  }
});
