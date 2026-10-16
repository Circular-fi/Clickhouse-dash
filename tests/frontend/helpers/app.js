import { expect } from '@playwright/test';

export async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#queryWorkspace')).toBeVisible();
  await expect(page.locator('#hostPickerButton')).toBeVisible();
  await expect(page.locator('#versionBadge')).not.toHaveText(/offline/i);
  await expect(page.locator('#hostPickerText')).not.toContainText(/offline/i);
  await expect(page.locator('#runButton')).toBeEnabled();
}

// Every CSS transition and animation of the page has ended. This includes the colours of a theme switch.
// getAnimations() makes the style recalculation that starts them.
// So no animation begins after this check looks at the page.
export function settleAnimations(page) {
  return page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => null))).then(() => document.getAnimations().length));
}

// Two frames render the state that the page has now.
// This check does not work under page.clock, because its animation frames are fake.
export function nextFrames(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// A round trip to the page makes sure that the test has every report.
// The page issued each request before this call, in the microtasks that already ran.
// The page and the test speak through one ordered channel.
// The check of "nothing was sent" needs this round trip, and it needs no delay.
export function roundTrip(page) {
  return page.evaluate(() => 0);
}

export async function runQuery(page, sql, options = {}) {
  const editor = page.locator('#queryTextArea');
  await editor.fill(sql);
  if (options.profiling) {
    await page.locator('#runMenuButton').click();
    await expect(page.locator('#runMenu')).toBeVisible();
    await page.locator('#runWithProfilingButton').click();
  } else {
    await page.locator('#runButton').click();
  }
  await expect(page.locator('#queryStatusText')).toHaveText(/running|done|finished|limit reached|error|canceled/i, { timeout: 10_000 });
}

export async function waitForTerminal(page) {
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished|limit reached|error|canceled/i, { timeout: 30_000 });
}

// A multiquery batch has ended. It has `count` panels, each with its final stats line.
// The status can read "finished" after the first statement already.
export async function waitForBatch(page, count) {
  const blocks = page.locator('.resultsStack__block');
  await expect(blocks).toHaveCount(count, { timeout: 30_000 });
  for (let i = 0; i < count; i += 1) await expect(blocks.nth(i).locator('.resultsStack__meta')).toHaveText(/\S/, { timeout: 30_000 });
}

export async function runSuccessfulQuery(page, sql, options = {}) {
  await runQuery(page, sql, options);
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished|limit reached/i);
  await expect(page.locator('#elapsedSecondsText')).not.toHaveText('\u2014');
}

export async function openExplorer(page) {
  await page.locator('#navExplorerLink').click();
  await expect(page.locator('#explorerWorkspace')).toBeVisible();
  await expect(page).toHaveURL(/\/explorer(?:\/|$)/);
  await expect(page.locator('#explorerTableList')).toBeVisible({ timeout: 15_000 });
    // The shell is painted before app.js runs. This includes the view tabs.
    // The first rendered row of the tree means the Explorer is initialised and its tabs are bound.
  await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
}

// The Explorer sidebar is lazy.
// The first paint lists database names only.
// Each branch loads its objects when the branch is expanded.
// Tests that need table rows must therefore expand the owning database explicitly.
export async function expandExplorerDatabase(page, database = 'chdash_ui') {
  const toggle = page.locator(
    `#explorerTableList .explorerTreeDatabaseToggle[aria-label="Expand ${database}"], ` +
    `#explorerTableList .explorerTreeDatabaseToggle[aria-label="Collapse ${database}"]`,
  );
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.locator(`#explorerTableList .explorerTreeDatabaseToggle[aria-label="Collapse ${database}"]`))
    .toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#explorerTableList')).not.toContainText(/Loading tables/i, { timeout: 15_000 });
}

export async function openExplorerDatabase(page, database = 'chdash_ui') {
  await openExplorer(page);
  await expandExplorerDatabase(page, database);
}

// ClickHouse-side elapsed time needs an extra /api/query/execution lookup.
// So it is an opt-in option of the Run settings (gear) menu, next to multiquery.
export async function enableExecutionStats(page) {
  await page.locator('#runSettingsButton').click();
  await expect(page.locator('#runSettingsMenu')).toBeVisible();
  const option = page.locator('#runOptExecutionStats');
  if ((await option.getAttribute('aria-checked')) !== 'true') await option.click();
  await expect(option).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
  await expect(page.locator('#runSettingsMenu')).toBeHidden();
}

export async function setFlattenTuple(page, enabled) {
  await page.locator('#runSettingsButton').click();
  await expect(page.locator('#runSettingsMenu')).toBeVisible();
  const option = page.locator('#runOptFlattenTuple');
  if ((await option.getAttribute('aria-checked')) !== String(enabled)) await option.click();
  await expect(option).toHaveAttribute('aria-checked', String(enabled));
  await page.locator('#runSettingsButton').click();
  await expect(page.locator('#runSettingsMenu')).toBeHidden();
}

export async function openAnalysis(page) {
  await expect(page.locator('#analyzeQueryButton')).toBeVisible({ timeout: 10_000 });
  await page.locator('#analyzeQueryButton').click();
  await expect(page.locator('#analysisModal')).toBeVisible();
  await expect(page.locator('#analysisSummary')).toContainText(/Session|ClickHouse|query/i, { timeout: 12_000 });
}

// Touch targets (docs/ui-foundations.md, "Touch and phones"): the check tests every visible control.
// The check probes the hit area of a control with elementFromPoint along its two centre lines.
// Pseudo-element bands count. A neighbour drawn over the control does not.
// The check reports a control whose hit area is under `min` px on either axis.
//
// A control whose centre another element covers (under a sheet) is not a target now. The check skips it.
// The check also skips the selectors in `skip`.
// `only` (a selector) measures those controls alone.
// 38.5 px: a 40 px box at a half-pixel position probes a quarter pixel short at each edge.
export async function smallTouchTargets(page, { min = 38.5, skip = [], only = '' } = {}) {
  return page.evaluate(({ min, skip, only }) => {
    const SEL = only || 'button, a[href], [role=tab], [role=button], input:not([type=hidden]), select, textarea, summary, [role=menuitem], [role=option], [role=checkbox], [role=switch], [tabindex="0"]';
    const owns = (el, hit) => !!hit && (el === hit || el.contains(hit) || (el.labels && [...el.labels].some((l) => l.contains(hit))));
    const small = [];
    for (const el of document.querySelectorAll(SEL)) {
      if (el.disabled || el.closest('[aria-hidden=true], [inert]') || skip.some((s) => el.matches(s))) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1 || r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) continue;
      let scroller = el.parentElement;
      while (scroller && scroller !== document.body && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
      const scrolls = scroller && scroller !== document.body;
            // A control a few pixels from the top or the bottom of the window has its hit area cut by the window.
            // This measure reads the cut area as a small one.
            // So the code brings a control of a scroller to its middle.
            // The window's edge is no part of the control.
      if (scrolls && (r.top < 24 || r.bottom > innerHeight - 24)) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        r = el.getBoundingClientRect();
        if (r.top < 0 || r.bottom > innerHeight) continue;
      }
            // The control is partly scrolled out of its scroller (a long page's content region).
            // This case is the same as a control partly out of the viewport. The check cannot measure it there.
      if (scrolls) {
        const box = scroller.getBoundingClientRect();
        if (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5) continue;
      }
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (!owns(el, document.elementFromPoint(cx, cy))) continue;
      const inside = (dx, dy, t) => {
        const x = cx + dx * t;
        const y = cy + dy * t;
        return x >= 0 && y >= 0 && x < innerWidth && y < innerHeight && owns(el, document.elementFromPoint(x, y));
      };
      const extent = (dx, dy) => {
        let n = 0;
        for (let t = 1; t <= 40 && inside(dx, dy, t); t += 1) n = t;
        const base = n;
        for (let f = 0.25; f < 1 && base < 40 && inside(dx, dy, base + f); f += 0.25) n = base + f;
        return n;
      };
      const w = extent(-1, 0) + extent(1, 0);
      const h = extent(0, -1) + extent(0, 1);
      if (w < min || h < min) small.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${w}x${h}`);
    }
    return small;
  }, { min, skip, only });
}

// How far the document scrolls sideways (0: it does not).
export async function horizontalOverflow(page) {
  return page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
}
