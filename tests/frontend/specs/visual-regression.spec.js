import { test, expect } from '@playwright/test';
import { openAnalysis, openApp, openExplorer, runSuccessfulQuery } from '../helpers/app.js';
import { stabilizePage } from '../helpers/review.js';

const enabled = process.env.VISUAL_COMPARE === '1';

test.describe('visual regression baselines', () => {
  test.skip(!enabled, 'Visual baselines are intentionally disabled until the redesign is accepted. Set VISUAL_COMPARE=1 to enable.');

  test('query results baseline', async ({ page }) => {
    await openApp(page);
    await runSuccessfulQuery(page, `SELECT number AS id, concat('row-', toString(number)) AS label, number % 2 = 0 AS even FROM numbers(16) ORDER BY id`);
    await stabilizePage(page);
    await expect(page).toHaveScreenshot('query-results.png', {
      fullPage: true, animations: 'disabled',
      mask: [page.locator('#queryIdentifierText'), page.locator('#elapsedSecondsText'), page.locator('#hostPickerPing')],
    });
  });

  test('analysis baseline', async ({ page }) => {
    await openApp(page);
    await runSuccessfulQuery(page, 'SELECT city, count() FROM chdash_ui.weather_observations GROUP BY city', { profiling: true });
    await openAnalysis(page);
    await stabilizePage(page);
    await expect(page).toHaveScreenshot('analysis.png', {
      fullPage: true, animations: 'disabled',
      mask: [page.locator('#queryIdentifierText'), page.locator('#elapsedSecondsText'), page.locator('#hostPickerPing'), page.locator('#analysisSummary'), page.locator('.analysisKv__value')],
    });
  });

  test('explorer baseline', async ({ page }) => {
    await openApp(page);
    await openExplorer(page);
    await expect(page.locator('#explorerTableList')).toContainText('weather_observations');
    await stabilizePage(page);
    await expect(page).toHaveScreenshot('explorer.png', {
      fullPage: true, animations: 'disabled',
      mask: [page.locator('#hostPickerPing')],
    });
  });
});
