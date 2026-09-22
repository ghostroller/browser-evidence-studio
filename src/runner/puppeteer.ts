import puppeteer, { type Browser, type Page, type Target } from 'puppeteer-core';
import type { ProtocolTransport } from './gate';

/** The sole version-pinned Puppeteer CDP target adapter. Never selects by URL. */
export function hasTargetIdentity(target: Target, targetId: string): boolean {
  return (target as Target & { _targetId?: string })._targetId === targetId;
}

export async function connectManagedPage(transport: ProtocolTransport, targetId: string): Promise<{ browser: Browser; page: Page }> {
  if (!targetId) throw new Error('An explicit registered CDP targetId is required');
  const browser = await puppeteer.connect({
    transport, defaultViewport: null, protocolTimeout: 30_000,
    // Chromium 152 exposes page targets below structural tab targets. Rejecting
    // the tab prevents Puppeteer from ever discovering its child page.
    // Only the exact registered page is exposed as a Page; tabs are plumbing.
    targetFilter: target => String(target.type()) === 'tab' || target.type() === 'browser' || hasTargetIdentity(target, targetId),
  });
  try {
    const target = await browser.waitForTarget(candidate => hasTargetIdentity(candidate, targetId), { timeout: 10_000 });
    const page = await target.page();
    if (!page) throw new Error('Registered target is not a Puppeteer page');
    // Recheck using the documented CDP identity, independently of URL/title.
    const session = await page.createCDPSession();
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      if (targetInfo.targetId !== targetId) throw new Error('Managed page target identity mismatch');
    } finally { await session.detach(); }
    return { browser, page };
  } catch (error) {
    await browser.disconnect();
    throw error;
  }
}
