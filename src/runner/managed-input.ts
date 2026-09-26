import type { Page } from 'puppeteer-core';
import { ensure } from '@/shared/errors';

/** Target-scoped Puppeteer input, with no foreground selection or DOM click. */
export async function clickManagedElement(page: Page, selector: string, check: () => void): Promise<void> {
  check();const element=await page.$(selector);check();ensure(element,'Click target was not found',404);
  try {
    await element.scrollIntoView();check();
    const point=await element.clickablePoint();check();
    // Keep the handle bound to the same document through the last geometry read.
    const usable=await element.evaluate(element=>{const style=getComputedStyle(element),rect=element.getBoundingClientRect();return element.isConnected&&rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none'&&!(('disabled' in element)&&element.disabled);});
    check();ensure(usable,'Click target is detached, hidden or disabled',409);
    await page.mouse.click(point.x,point.y);check();
  } finally { await element.dispose(); }
}
