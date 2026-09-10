import { test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, openExplorer, runSuccessfulQuery } from '../helpers/app.js';
import { writeJson } from '../helpers/review.js';

async function audit(page, testInfo, name) {
  const result = await new AxeBuilder({ page }).analyze();
  await writeJson('accessibility', testInfo, name, {
    url: result.url,
    violations: result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 500), failureSummary: n.failureSummary })),
    })),
  });

  if (process.env.A11Y_STRICT === '1') {
    const blocking = result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    if (blocking.length) throw new Error(`Accessibility strict mode: ${blocking.length} serious/critical violations in ${name}`);
  }
}

test('collects accessibility findings for key states', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Accessibility is collected once at the canonical 1440px desktop viewport.');
  await openApp(page);
  await audit(page, testInfo, 'query-empty');

  await runSuccessfulQuery(page, 'SELECT number AS id, concat(\'row-\', toString(number)) AS label FROM numbers(8)');
  await audit(page, testInfo, 'query-results');

  await runSuccessfulQuery(page, 'SELECT city, count() FROM chdash_ui.weather_observations GROUP BY city', { profiling: true });
  await page.locator('#analysisModalBackdrop').waitFor({ state: 'visible', timeout: 15_000 });
  await audit(page, testInfo, 'analysis-trace');
  await page.locator('#analysisCloseButton').click();

  await openExplorer(page);
  await audit(page, testInfo, 'explorer');
});
