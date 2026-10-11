import { test, expect } from '@playwright/test';

// A column that matters less leaves a table when the window is narrower than its breakpoint (UI-130, docs/ui-foundations.md): .is-low
// from 1279 px down, .is-mid from 820, .is-xs from 600. What stays fits, and a table that still overflows scrolls with its edge cues.

async function overflow(page, selector) {
  return page.evaluate((query) => {
    const wrap = document.querySelector(query).closest('.tableWrap, .dataTableWrap');
    return { over: wrap.scrollWidth - wrap.clientWidth, visible: [...document.querySelectorAll(`${query} thead th`)].filter((th) => th.offsetParent !== null).map((th) => th.textContent.trim()) };
  }, selector);
}

test('the objects of a database lose their low-priority columns as the window narrows, and fit down to 1024 px', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/explorer/catalog/chdash_ui');
  await expect(page.locator('#explorerDatabaseObjects')).toBeVisible({ timeout: 15_000 });
  const full = ['#', 'Name', 'Engine', 'Rows', 'Size', 'Compressed', 'Ratio', '% database', 'Parts', 'Modified'];
  expect((await overflow(page, '#explorerDatabaseObjects')).visible).toEqual(full);
  await page.setViewportSize({ width: 1279, height: 900 });
  let state = await overflow(page, '#explorerDatabaseObjects');
  expect(state.visible).toEqual(['#', 'Name', 'Rows', 'Size', '% database', 'Modified']);
  expect(state.over).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1024, height: 900 });
  state = await overflow(page, '#explorerDatabaseObjects');
  expect(state.over).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 820, height: 900 });
  state = await overflow(page, '#explorerDatabaseObjects');
  expect(state.visible).toEqual(['#', 'Name', 'Rows', 'Size', '% database']);
  expect(state.over).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 390, height: 800 });
  state = await overflow(page, '#explorerDatabaseObjects');
  expect(state.visible).toEqual(['#', 'Name', 'Size', '% database']);
});

test('on a phone the databases overview keeps the database, its size and its share, and the table scrolls for the rest', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/explorer/catalog');
  await expect(page.locator('#explorerDatabasesOverview')).toBeVisible({ timeout: 15_000 });
  const state = await overflow(page, '#explorerDatabasesOverview');
  expect(state.visible).toEqual(['#', 'Database', 'Size', '% server']);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect((await overflow(page, '#explorerDatabasesOverview')).visible).toEqual(['#', 'Database', 'Objects', 'Rows', 'Size', '% server']);
});

test('the columns of a table lose Uncompressed and Codec at 1279 px and the share at 820 px, with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/explorer/catalog/chdash_ui/weather_observations');
  await expect(page.locator('.explorerColumnsTable')).toBeVisible({ timeout: 15_000 });
  const heads = async () => (await overflow(page, '.explorerColumnsTable'));
  expect((await heads()).visible).toContain('Uncompressed');
  await page.setViewportSize({ width: 1024, height: 900 });
  let state = await heads();
  expect(state.visible).not.toContain('Uncompressed');
  expect(state.visible).toContain('Compressed');
  expect(state.over).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 820, height: 900 });
  state = await heads();
  expect(state.visible).not.toContain('% table');
  expect(state.over).toBeLessThanOrEqual(1);
});

test('a table that still overflows says so at the edge, and a hidden column is gone from the grid, not only from the eye', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/explorer/catalog/chdash_ui');
  const table = page.locator('#explorerDatabaseObjects');
  await expect(table).toBeVisible({ timeout: 15_000 });
  // Edge cues (shell.edgeCues) mark the side of the box that hides columns.
  await expect.poll(() => table.evaluate((el) => el.classList.contains('has-edge-end') || el.closest('.tableWrap')?.classList.contains('has-edge-end') || el.parentElement?.classList.contains('has-edge-end'))).toBe(true);
  // A hidden column has no box: its cells are display none too (the row has fewer cells in the layout).
  const hiddenCells = await page.evaluate(() => [...document.querySelectorAll('#explorerDatabaseObjects tbody tr:first-child td')].filter((td) => td.offsetParent === null).length);
  expect(hiddenCells).toBeGreaterThan(0);
});
