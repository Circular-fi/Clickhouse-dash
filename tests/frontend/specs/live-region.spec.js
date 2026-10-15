import { test, expect } from '@playwright/test';

// The page has one polite live region, #uiLiveStatus (ns.uiState.announce): no module or shell marks a region of its own (UI-126).

for (const path of ['/query', '/explorer/catalog', '/observability/traces', '/observability/logs', '/observability/metrics', '/system', '/mcp-integration', '/mcp-integration/usage']) {
  test(`${path}: the only element marked aria-live is the announce region`, async ({ page }) => {
    await page.goto(path);
    await expect.poll(() => page.evaluate(() => !!window.ChDash?.uiState)).toBe(true);
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.ChDash.uiState.announce('A short status sentence.'));
    await expect(page.locator('#uiLiveStatus')).toHaveText('A short status sentence.');
    const live = await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map((el) => el.id || el.className));
    expect(live).toEqual(['uiLiveStatus']);
  });
}
