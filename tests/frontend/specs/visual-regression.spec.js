import { test, expect } from '@playwright/test';
import { openApp, runSuccessfulQuery } from '../helpers/app.js';
import { stabilizePage } from '../helpers/review.js';

// The baseline of the Query page with a result, one per viewport. Each one is in
// snapshots/<viewport>/visual-regression.spec.js/. The pinned Playwright image
// (tests/Dockerfile.tests) takes the baseline. The image has the same fonts and
// the same rasteriser on every machine. A change of the look on purpose updates
// the baselines. Run `npm run snapshots:update` in tests/frontend, or set
// VISUAL_COMPARE=1 and --update-snapshots in the test container. Then commit the
// new PNGs. VISUAL_COMPARE=0 skips the comparison.
// The analysis modal and the Explorer have no baseline. Their figures come from
// the server: timings, the sizes and the row counts of the tables, and the
// databases that other tests made. A run on another ClickHouse state would
// differ. A first try with the Explorer did. axe and the design captures cover them.
const enabled = process.env.VISUAL_COMPARE !== '0';

// These values change from one run to the next: the timings, the rates, the identifier and the ping.
// A mask would still change its width with the text under it. So the text itself is replaced by a fixed text.
// The version badge names the build of the instance under test ("source-tests (local)" in the compose stack).
// So the badge is fixed to the text of the baselines.
async function freezeVolatile(page) {
  await page.evaluate(() => {
    const selectors = ['#queryIdentifierText', '#elapsedSecondsText', '#hostPickerPing', '#runStatsTiles .statTile__value', '#runStatsTiles .statTile__sub', '#resultSummaryText'];
    for (const el of document.querySelectorAll(selectors.join(','))) el.textContent = '0';
    const badge = document.getElementById('versionBadge');
    if (badge) badge.textContent = 'source (local)';
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
});
