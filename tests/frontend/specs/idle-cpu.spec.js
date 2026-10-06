import { test, expect } from '@playwright/test';

// A page at rest does no work. Two things used to keep every page busy with no one touching it
// (7 to 20 % of a core in Chrome's Performance Monitor, against about 1 % for a static page):
//  - the healthy host dot's endless box-shadow animation, repainted on the main thread 60 times a
//    second (now a ring moved by the compositor, three times, then still);
//  - the hosts stream, once a second, rewriting the host picker's and the Run button's text with
//    the very same text (a new text node each time: style and layout again, every second).
// The counts below are Blink's own (CDP Performance.getMetrics) over a window with no input.

const PAGES = [
  '/query',
  '/explorer',
  '/observability/traces',
  '/observability/logs',
  '/observability/metrics',
  '/system',
  '/system/queries',
];

for (const path of PAGES) {
  test(`${path} at rest: no running animation, no layout, no style recalculation`, async ({ page }) => {
    await page.goto(path);
    // The dot's three pulses (5.4 s) end; then nothing is animated.
    await expect.poll(() => page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length), { timeout: 20_000 }).toBe(0);
    // The page has loaded what it shows (a second of the hosts stream at least has arrived).
    await expect(page.locator('#versionBadge')).not.toHaveText('--', { timeout: 20_000 });
    await page.waitForTimeout(2500);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const read = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const before = await read();
    await page.waitForTimeout(5000);
    const after = await read();
    const layouts = after.LayoutCount - before.LayoutCount;
    const recalcs = after.RecalcStyleCount - before.RecalcStyleCount;
    // Five seconds: the hosts stream ticks five times. A tick that changes nothing changes nothing.
    expect(layouts, `layouts in 5 s at rest on ${path}`).toBeLessThanOrEqual(2);
    expect(recalcs, `style recalculations in 5 s at rest on ${path}`).toBeLessThanOrEqual(2);
  });
}
