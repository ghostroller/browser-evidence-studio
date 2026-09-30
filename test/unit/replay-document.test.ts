import { expect, test } from 'vitest';
import { ReplayDocumentServer } from '@/main/workbench/replay-document';
import { request } from 'node:http';
test('dedicated replay origin serves only fixed nonce-protected content and never business routes', async () => {
  const server = new ReplayDocumentServer(), origin = await server.start('http://127.0.0.1:9090', 'instance');
  try {
    const result = await fetch(`${origin}/replay.html`), html = await result.text(), csp = result.headers.get('content-security-policy')!;
    expect(result.status).toBe(200); expect(csp).toContain("frame-src 'none'"); expect(csp).toContain("connect-src 'none'"); expect(csp).toContain('frame-ancestors http://127.0.0.1:9090');
    expect(csp).not.toMatch(/unsafe-eval|script-src 'unsafe-inline'/); expect(html).toContain('installReplayController'); expect(html).toContain('installReplayFrameBridge');
    expect(result.headers.get('set-cookie')).toBeNull(); expect(result.headers.get('access-control-allow-origin')).toBeNull(); expect(result.headers.get('cache-control')).toBe('no-store');
    for (const route of ['/workbench/rpc', '/resource/id', '/replay.html?token=x', '/', '/../../private']) expect((await fetch(`${origin}${route}`)).status).toBe(404);
    expect((await fetch(`${origin}/replay.html`, { method: 'POST', body: '{}' })).status).toBe(404);
    const code = await new Promise<number>(resolve => { const req = request(`${origin}/replay.html`, { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode!); }); req.end(); });
    expect(code).toBe(403);
  } finally { await server.dispose(); }
});
