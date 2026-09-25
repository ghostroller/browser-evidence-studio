import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Studio } from '@/main/services/studio';

/**
 * Human input for the LOCAL synthetic fixture only. The Puppeteer connection is
 * used exclusively for geometry/hit-test reads. All scrolling and clicking goes
 * through Electron native input; no scrollIntoView, DOM click, or state mutation.
 */
export async function clickSyntheticHuman(studio: Studio, selector: string): Promise<void> {
  const session = studio.state().session, managed = studio.current(), host = studio.window.window;
  assert.ok(session, 'Synthetic native input requires a live session');
  const assertOwnership = () => {
    const currentSession=studio.state().session;
    assert.equal(currentSession?.sessionId, session.sessionId, 'The native input session must remain unchanged');
    assert.equal(currentSession?.recordingId, session.recordingId, 'The native input recording boundary must remain unchanged');
    assert.equal(studio.current().pageId, managed.pageId, 'The native input target must remain selected');
    assert.equal(currentSession?.controller, 'human', 'Synthetic native input requires explicit human ownership');
    assert.equal(currentSession?.locked, false, 'Synthetic native input cannot bypass an operation lock');
    assert.equal(managed.view.getVisible(), true, 'The business native view must be visible');
    assert.equal(studio.window.mask.getVisible(), false, 'The native input mask must be absent');
  };
  assertOwnership();
  if (host.isMinimized()) host.restore();
  host.show();
  host.focus();
  managed.view.webContents.focus();
  const focusDeadline = Date.now() + 2500;
  while ((!host.isFocused() || !managed.view.webContents.isFocused()) && Date.now() < focusDeadline) {
    await delay(50);
    host.focus();
    managed.view.webContents.focus();
  }
  assert.equal(host.isFocused(), true, 'The BrowserWindow must own focus before sendInputEvent');
  assert.equal(managed.view.webContents.isFocused(), true, 'The business WebContents must own keyboard/mouse focus');

  const geometry = () => managed.page.$eval(selector, element => {
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    const width = window.innerWidth, height = window.innerHeight;
    const inside = x >= 4 && x < width - 4 && y >= 4 && y < height - 4;
    const hit = inside ? document.elementFromPoint(x, y) : null;
    const style = getComputedStyle(element);
    return {
      x, y, viewportWidth: width, viewportHeight: height,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      scrollX: window.scrollX, scrollY: window.scrollY,
      disabled: 'disabled' in element && Boolean((element as HTMLButtonElement).disabled),
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      inside, hit: !!hit && (hit === element || element.contains(hit)),
    };
  });
  let point = await geometry();
  let wheelDirection = -1;
  let directionAdjusted = false;
  for (let attempt = 0; attempt < 16 && !(point.inside && point.hit); attempt++) {
    assertOwnership();
    assert(point.visible, `Synthetic target ${selector} is not rendered: ${JSON.stringify(point)}`);
    assert(!point.disabled, `Synthetic target ${selector} is disabled; expiry cannot count as success`);
    const errorX = point.x - point.viewportWidth / 2;
    const errorY = point.y - point.viewportHeight / 2;
    const deltaX = point.x < 4 || point.x >= point.viewportWidth - 4 ? wheelDirection * Math.sign(errorX) * Math.min(Math.abs(errorX), point.viewportWidth * .7) : 0;
    const deltaY = wheelDirection * Math.sign(errorY || 1) * Math.min(Math.max(Math.abs(errorY), 40), point.viewportHeight * .7);
    const wheelPoint = { x: Math.round(point.viewportWidth / 2), y: Math.round(point.viewportHeight / 2) };
    managed.view.webContents.sendInputEvent({ type: 'mouseMove', ...wheelPoint });
    managed.view.webContents.sendInputEvent({ type: 'mouseWheel', ...wheelPoint, deltaX, deltaY, canScroll: true, hasPreciseScrollingDeltas: true });
    // A native wheel is asynchronous. Observe its actual geometry result before
    // choosing another wheel; only the final validated click is ever submitted.
    await delay(120);
    const next = await geometry();
    const oldDistance = Math.hypot(errorX, errorY);
    const nextDistance = Math.hypot(next.x - next.viewportWidth / 2, next.y - next.viewportHeight / 2);
    if (!directionAdjusted && !(next.inside && next.hit) && nextDistance >= oldDistance - 1) {
      wheelDirection *= -1;
      directionAdjusted = true;
    }
    point = next;
  }
  assertOwnership();
  assert(point.visible && point.inside && point.hit && !point.disabled, `Synthetic target ${selector} is not safely clickable after native scrolling: ${JSON.stringify(point)}`);
  assert(point.x >= 0 && point.x < point.viewportWidth && point.y >= 0 && point.y < point.viewportHeight, 'Final click must lie inside the actual business viewport');
  host.focus();
  managed.view.webContents.focus();
  managed.view.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
  managed.view.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y });
  managed.view.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y });
}
