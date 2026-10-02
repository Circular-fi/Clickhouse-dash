import { test, expect } from '@playwright/test';
import { openApp, runSuccessfulQuery } from '../helpers/app.js';

// Shared data display components (app_ui_table.js, app_ui_badge.js,
// app_ui_copy.js, app_ui_sql.js, app_ui_kv.js, app_ui_stat.js,
// app_ui_chart.js), in the browser on every page that uses them.

const dataRows = '#resultTableBody tr[data-row-key]';

// The table chrome every .dataTable shares, read from one header and one cell.
async function tableLook(table) {
  return table.evaluate((el) => {
    const th = el.querySelector('thead th');
    const td = el.querySelector('tbody tr td:not(.dataTable__rowNum)');
    const head = getComputedStyle(th);
    return {
      headSize: head.fontSize,
      headWeight: head.fontWeight,
      headTransform: head.textTransform,
      headPosition: head.position,
      rowHeight: Math.round(td.parentElement.getBoundingClientRect().height),
    };
  });
}

test.describe('data table', () => {
  test('Query results: one header recipe, sort state in aria-sort, glyph idle until hover', async ({ page }) => {
    await openApp(page);
    await runSuccessfulQuery(page, 'SELECT number AS n, toString(number) AS s FROM numbers(5)');
    const table = page.locator('#resultsPanel table.dataTable');
    await expect(table).toBeVisible();
    const look = await tableLook(table);
    expect(look).toMatchObject({ headSize: '11.5px', headWeight: '700', headTransform: 'none', headPosition: 'sticky' });
    expect(look.rowHeight).toBeGreaterThanOrEqual(32);
    expect(look.rowHeight).toBeLessThanOrEqual(34);

    const header = page.locator('#resultTableHead th[data-sort-key="0"]');
    await expect(header).toHaveAttribute('aria-sort', 'none');
    const glyph = () => header.locator('.dataTable__sort').evaluate((b) => getComputedStyle(b, '::after').opacity);
    await page.mouse.move(0, 0);
    expect(await glyph()).toBe('0');
    await header.locator('.dataTable__sort').click();
    await expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(Number(await glyph())).toBeGreaterThan(0.5);
    await expect(page.locator(dataRows).first().locator('td').nth(1)).toHaveText('4');
    // Enter on the header button sorts too (a real button).
    await header.locator('.dataTable__sort').focus();
    await page.keyboard.press('Enter');
    await expect(header).toHaveAttribute('aria-sort', 'ascending');
  });

  test('Query results: rows rove with the keyboard and Shift+F10 / ContextMenu open the row menu', async ({ page }) => {
    await openApp(page);
    await runSuccessfulQuery(page, 'SELECT number AS n, toString(number * 10) AS s FROM numbers(6)');
    const rows = page.locator(dataRows);
    await expect(rows).toHaveCount(6);
    // One row in the tab order.
    expect(await rows.evaluateAll((trs) => trs.filter((tr) => tr.tabIndex === 0).length)).toBe(1);
    await rows.nth(0).focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    expect(await rows.nth(1).getAttribute('tabindex')).toBe('0');
    expect(await rows.nth(0).getAttribute('tabindex')).toBe('-1');

    // The context-menu key on the focused row: the row menu, on that row.
    await page.keyboard.press('Shift+F10');
    const menu = page.locator('.rowDetailsMenu');
    await expect(menu).toBeVisible();
    await expect(rows.nth(1)).toHaveClass(/is-rowMenuTarget/);
    await expect(menu.getByRole('menuitem', { name: 'Copy row' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(rows.nth(1)).toBeFocused();

    // Into the cells: Right steps in, Down keeps the column; the menu acts on
    // the focused cell.
    await page.keyboard.press('ArrowRight');
    const cell = rows.nth(1).locator('td').nth(1);
    await expect(cell).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(2).locator('td').nth(2)).toBeFocused();
    await page.keyboard.press('ContextMenu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy cell' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(rows.nth(2).locator('td').nth(2)).toBeFocused();
    // Enter on a row opens its Details.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(rows.nth(2)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('tr.resultTable__detailRow')).toHaveCount(1);
    await expect(rows.nth(2)).toHaveClass(/is-selected/);
  });

  test('Explorer preview: no bars on identifier or signed columns', async ({ page }) => {
    await page.goto('/explorer/chdash_ui/weather_observations/preview');
    const table = page.locator('.explorerPreviewTable table.dataTable');
    await expect(table.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
    const bars = await table.evaluate((el) => {
      const heads = [...el.querySelectorAll('thead th')].map((th) => th.querySelector('.dataTable__sort')?.textContent.trim() || th.textContent.trim());
      const out = {};
      heads.forEach((name, i) => {
        out[name] = [...el.querySelectorAll('tbody tr')].some((tr) => tr.cells[i]?.classList.contains('cellBar'));
      });
      return out;
    });
    expect(bars.id).toBe(false);
    expect(bars.temperature_c).toBe(false);
    expect(bars.humidity_pct).toBe(true);
  });
});
