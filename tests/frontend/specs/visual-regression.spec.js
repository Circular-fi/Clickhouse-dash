import { test, expect } from '@playwright/test';
import { openApp, openExplorerDatabase, runSuccessfulQuery } from '../helpers/app.js';
import { stabilizePage } from '../helpers/review.js';

// Baselines of two full pages, one set per viewport (snapshots/<viewport>/visual-regression.spec.js/), taken in the
// pinned Playwright image (tests/Dockerfile.tests): the same fonts and the same rasteriser on every machine. A change of
// the look on purpose updates them: `npm run snapshots:update` in tests/frontend (or VISUAL_COMPARE=1 and
// --update-snapshots in the test container), then the new PNGs are committed. VISUAL_COMPARE=0 skips the comparison.
// The analysis modal has no baseline: its figures are timings of the run, and axe and the design captures cover it.
const enabled = process.env.VISUAL_COMPARE !== '0';

// What changes from one run to the next: the timings, the rates, the identifier and the ping. A mask would still
// change its width with the text under it, so the text itself is replaced by a fixed one.
async function freezeVolatile(page) {
  await page.evaluate(() => {
    const selectors = ['#queryIdentifierText', '#elapsedSecondsText', '#hostPickerPing', '#runStatsTiles .statTile__value', '#runStatsTiles .statTile__sub', '#resultSummaryText'];
    for (const el of document.querySelectorAll(selectors.join(','))) el.textContent = '0';
  });
}

test.describe('visual regression baselines', () => {
  test.skip(!enabled, 'VISUAL_COMPARE=0: the comparison with the baselines is off.');

  test('query results baseline', async ({ page }) => {
    await openApp(page);
    await runSuccessfulQuery(page, `SELECT number AS id, concat('row-', toString(number)) AS label, number % 2 = 0 AS even FROM numbers(16) ORDER BY id`);
    await freezeVolatile(page);
    await stabilizePage(page);
    await expect(page).toHaveScreenshot('query-results.png', { fullPage: true, animations: 'disabled', mask: [page.locator('#hostPickerPing')] });
  });

  test('explorer baseline', async ({ page }) => {
    await openApp(page);
    await openExplorerDatabase(page);
    await expect(page.locator('#explorerTableList')).toContainText('weather_observations');
    await stabilizePage(page);
    await expect(page).toHaveScreenshot('explorer.png', {
      fullPage: true, animations: 'disabled',
      mask: [page.locator('#hostPickerPing')],
    });
  });
});
