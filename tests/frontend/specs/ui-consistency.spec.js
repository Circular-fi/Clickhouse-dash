import { test, expect } from '@playwright/test';

// Cross-page invariants: forced themes match the OS themes token for token,
// one keyboard focus ring, hidden native selects take no Tab stop, and
// startup completes without matchMedia.

// Every custom property on <html>, resolved.
async function rootTokens(page) {
  return page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const out = {};
    for (let i = 0; i < style.length; i += 1) {
      const name = style[i];
      if (name.startsWith('--')) out[name] = style.getPropertyValue(name).replace(/\s+/g, ' ').trim();
    }
    return out;
  });
}

async function tokensFor(page, path, os, mode) {
  await page.emulateMedia({ colorScheme: os });
  await page.addInitScript((m) => { try { localStorage.setItem('chdash.theme', m); } catch (_) {} }, mode);
  await page.goto(path);
  await expect(page.locator('html')).toHaveClass(/is-ready/, { timeout: 15_000 });
  return rootTokens(page);
}

for (const path of ['/explorer/catalog', '/observability/traces']) {
  for (const theme of ['dark', 'light']) {
    test(`forced ${theme} on a ${theme === 'dark' ? 'light' : 'dark'} OS matches System on a ${theme} OS (${path})`, async ({ browser }) => {
      const other = theme === 'dark' ? 'light' : 'dark';
      const systemPage = await browser.newPage();
      const forcedPage = await browser.newPage();
      try {
        const system = await tokensFor(systemPage, path, theme, 'system');
        const forced = await tokensFor(forcedPage, path, other, theme);
        // Run-time values (editor height, widths set by scripts) are not palette tokens.
        const names = Object.keys(system).filter((name) => !/Height|Width|-width|-top|--p$/.test(name));
        expect(names.length).toBeGreaterThan(100);
        const differ = names.filter((name) => system[name] !== forced[name]).map((name) => `${name}: ${system[name]} vs ${forced[name]}`);
        expect(differ).toEqual([]);
        for (const name of ['--accent-fill', '--accentBorder', '--accentText', '--ring', '--shadow-overlay', '--focusRingColor', '--danger', '--sev-error', '--font-mono', '--font-sans']) {
          expect(forced[name], name).toBeTruthy();
        }
      } finally {
        await systemPage.close();
        await forcedPage.close();
      }
    });
  }
}

async function focusRing(locator) {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
      ring: getComputedStyle(document.documentElement).getPropertyValue('--focusRingColor').trim(),
    };
  });
}

function expectRing(ring) {
  expect(ring.style).toBe('solid');
  expect(ring.width).toBe('2px');
}

test.describe('one focus ring', () => {
  test('logs search, trace tag key and the Explorer tree show the ring', async ({ page }) => {
    await page.goto('/observability/logs');
    const query = page.locator('#logsQuery');
    await expect(query).toBeVisible({ timeout: 15_000 });
    await query.focus();
    expectRing(await focusRing(query));

    await page.goto('/observability/traces');
    const tag = page.locator('#tracesTagKey');
    await expect(tag).toBeVisible({ timeout: 15_000 });
    await tag.focus();
    expectRing(await focusRing(tag));

    // Keyboard focus on tree rows and toolbar buttons.
    await page.goto('/explorer/catalog');
    await expect(page.locator('#explorerTableList > *').first()).toBeAttached({ timeout: 15_000 });
    // The side panel head: the search, then the refresh button on its line.
    await page.locator('#explorerSearchInput').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#explorerRefreshButton')).toBeFocused();
    expectRing(await focusRing(page.locator('#explorerRefreshButton')));
    let treeRow = null;
    for (let i = 0; i < 12 && !treeRow; i += 1) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => !!document.activeElement?.closest?.('#explorerTableList'))) treeRow = page.locator(':focus');
    }
    expect(treeRow).not.toBeNull();
    expectRing(await focusRing(treeRow));
  });
});

test.describe('hidden native selects', () => {
  for (const view of ['traces', 'logs']) {
    test(`take no Tab stop on ${view}`, async ({ page }) => {
      await page.goto(`/observability/${view}`);
      const bar = page.locator(view === 'traces' ? '#tracesWorkspace .traceSearchBar' : '#logsWorkspace');
      await expect(bar.locator('.tracePicker__button').first()).toBeVisible({ timeout: 15_000 });
      const natives = page.locator('select.tracePicker__native');
      expect(await natives.count()).toBeGreaterThan(0);
      for (const select of await natives.all()) {
        await expect(select).toHaveAttribute('tabindex', '-1');
        await expect(select).toHaveAttribute('aria-hidden', 'true');
      }
      // Walk the page with Tab: never a native select, and the picker buttons are reached.
      await page.locator('body').click({ position: { x: 1, y: 1 } });
      const visited = [];
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press('Tab');
        visited.push(await page.evaluate(() => {
          const el = document.activeElement;
          return { tag: el?.tagName || '', cls: String(el?.className || ''), id: el?.id || '' };
        }));
      }
      expect(visited.filter((item) => item.tag === 'SELECT')).toEqual([]);
      expect(visited.some((item) => item.cls.includes('tracePicker__button'))).toBe(true);
    });
  }
});

test('startup completes when matchMedia throws', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (query === '(prefers-color-scheme: dark)') throw new Error('matchMedia unavailable');
      return original(query);
    };
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/explorer/catalog');
  await expect(page.locator('html')).toHaveClass(/is-ready/, { timeout: 15_000 });
  // The hosts stream started: the host picker reports the host, not offline.
  await expect(page.locator('#hostPickerText')).not.toHaveText(/^\s*$|offline|loading/i, { timeout: 15_000 });
  expect(errors).toEqual([]);
});
