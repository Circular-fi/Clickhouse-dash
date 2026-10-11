import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { openApp, openExplorer, runSuccessfulQuery } from '../helpers/app.js';
import { writeJson } from '../helpers/review.js';

// axe on the Query page, the analysis modal and the Explorer, in both themes, as a gate: any violation fails
// (the JSON of the findings stays in the design report). The other pages and their states are in
// a11y-contract.spec.js (17 states, both themes, same rule); the analysis modal is only here.

const THEMES = ['dark', 'light'];

async function audit(page, testInfo, name) {
  const result = await new AxeBuilder({ page }).analyze();
  const violations = result.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({ target: n.target, html: n.html.slice(0, 500), failureSummary: n.failureSummary })),
  }));
  await writeJson('accessibility', testInfo, name, { url: result.url, violations });
  expect(violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) })), name).toEqual([]);
}

for (const theme of THEMES) {
  test(`axe (${theme}): the Query page, its results, the analysis modal and the Explorer have no violation`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Accessibility is checked once at the canonical 1440px desktop viewport.');
    await page.addInitScript((value) => localStorage.setItem('chdash.theme', value), theme);
    await openApp(page);
    await audit(page, testInfo, `query-empty-${theme}`);

    await runSuccessfulQuery(page, 'SELECT number AS id, concat(\'row-\', toString(number)) AS label FROM numbers(8)');
    await audit(page, testInfo, `query-results-${theme}`);

    await runSuccessfulQuery(page, 'SELECT city, count() FROM chdash_ui.weather_observations GROUP BY city', { profiling: true });
    await page.locator('#analysisModal').waitFor({ state: 'visible', timeout: 15_000 });
    await audit(page, testInfo, `analysis-trace-${theme}`);
    await page.locator('#analysisCloseButton').click();

    await openExplorer(page);
    await audit(page, testInfo, `explorer-${theme}`);
  });
}
