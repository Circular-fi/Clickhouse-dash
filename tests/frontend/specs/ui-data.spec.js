import { test, expect } from '@playwright/test';
import { openApp, runSuccessfulQuery } from '../helpers/app.js';
import { mockTraceResults, mockTraceServices } from '../helpers/traces.js';

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
    expect(look).toMatchObject({ headSize: '12px', headWeight: '600', headTransform: 'none', headPosition: 'sticky' });
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

// --- Logs, Traces windows -------------------------------------------------------

const isoSecond = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
async function logsUrl(request, minutes = 30) {
  const meta = await (await request.get('/api/logs/meta')).json();
  test.skip(!meta.enabled || !meta.time_bounds, 'logs are disabled or empty');
  const end = Number(meta.time_bounds.max_ms);
  return `/observability/logs?from=${encodeURIComponent(isoSecond(end - minutes * 60000))}&to=${encodeURIComponent(isoSecond(end + 1000))}`;
}

// Each look in both themes and at phone width, with nothing overflowing.
const LOOKS = [
  { theme: 'dark', width: 1440 },
  { theme: 'light', width: 1440 },
  { theme: 'dark', width: 390 },
];

async function look(page, { theme, width }) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.addInitScript((mode) => { try { localStorage.setItem('chdash.theme', mode); } catch (_) {} }, theme);
}

const noPageOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe('badge', () => {
  for (const view of LOOKS) {
    test(`Logs severities and filter chips are the shared badge (${view.theme} ${view.width})`, async ({ page, request }) => {
      await look(page, view);
      await page.goto(await logsUrl(request));
      const badge = page.locator('#logsTableRows .badge--sev').first();
      await expect(badge).toBeVisible({ timeout: 30_000 });
      // The virtual rows re-render while the page settles: retrying matchers
      // (a detached row has no computed style).
      await expect(badge).toHaveCSS('height', '18px');
      await expect(badge).toHaveCSS('text-transform', 'none');
      // Its level's colour: ERROR the danger chip, FATAL solid, WARN amber
      // text, INFO muted, DEBUG and TRACE dimmed.
      await expect.poll(() => badge.evaluate((el) => {
        const token = { error: '--danger', fatal: '--panel', warn: '--sev-color', info: '--muted', debug: '--sev-trace', trace: '--sev-trace', unset: '--sev-trace' }[el.dataset.sev];
        const probe = document.createElement('i');
        probe.style.color = `var(${token})`;
        el.appendChild(probe);
        const same = el.isConnected && !!getComputedStyle(el).color && getComputedStyle(el).color === getComputedStyle(probe).color;
        probe.remove();
        return same && el.textContent === el.textContent.toUpperCase();
      })).toBe(true);
      // The histogram's totals legend filters; the filter is a .chip (a phone
      // folds the histogram and the bar with its chips: unfold them).
      if (view.width < 600) {
        await page.locator('#logsHistogramCard .chartCard__fold').click();
        await page.locator('#logsForm .obsFilterSummary').click();
      }
      await page.locator('#logsHistogram .chartCore__legendItem[data-series="warn"]').click();
      const chip = page.locator('#logsChips .chip');
      await expect(chip).toContainText('Level: Warn');
      await expect(page.locator('#logsHistogram .chartCore__legendItem[data-series="warn"]')).toHaveAttribute('aria-pressed', 'true');
      await chip.locator('.chip__remove').click();
      await expect(page.locator('#logsChips .chip')).toHaveCount(0);
      expect(await noPageOverflow(page)).toBe(true);
    });
  }

  test('status reads OK / Error / Unset and a metric kind is muted mono text', async ({ page }) => {
    await openApp(page);
    const labels = await page.evaluate(() => ['Ok', 'STATUS_CODE_ERROR', 'Unset', 2, 'ok'].map((code) => window.ChDash.badge.statusLabel(code)));
    expect(labels).toEqual(['OK', 'Error', 'Unset', 'Error', 'OK']);
    // Unset draws nothing (or the caller's mark), OK discreet muted text, Error a red chip.
    const drawn = await page.evaluate(() => {
      const { badge } = window.ChDash;
      const host = document.createElement('div');
      document.body.appendChild(host);
      const probe = document.createElement('i');
      host.appendChild(probe);
      const resolve = (token) => { probe.style.color = `var(${token})`; return getComputedStyle(probe).color; };
      const look = (html) => {
        const holder = document.createElement('span');
        holder.innerHTML = html;
        host.appendChild(holder);
        const el = holder.firstElementChild;
        const cs = getComputedStyle(el);
        return {
          text: el.textContent,
          chip: el.classList.contains('badge'),
          border: cs.borderTopStyle !== 'none' && parseFloat(cs.borderTopWidth) > 0,
          fill: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
          color: cs.color === resolve('--danger') ? 'danger' : cs.color === resolve('--muted') ? 'muted' : cs.color,
        };
      };
      const out = {
        unset: badge.statusHtml('Unset'),
        unsetCode: badge.statusHtml(0),
        unsetMark: badge.statusHtml('STATUS_CODE_UNSET', { empty: '—' }),
        ok: look(badge.statusHtml('Ok')),
        error: look(badge.statusHtml('STATUS_CODE_ERROR')),
      };
      host.remove();
      return out;
    });
    expect(drawn).toEqual({
      unset: '',
      unsetCode: '',
      unsetMark: '—',
      ok: { text: 'OK', chip: false, border: false, fill: false, color: 'muted' },
      error: { text: 'Error', chip: true, border: true, fill: true, color: 'danger' },
    });
    const meta = await (await page.request.get('/api/metrics/meta')).json();
    test.skip(!meta.enabled || !meta.kinds?.histogram?.time_bounds, 'metrics are disabled');
    const end = Math.floor(Number(meta.kinds.histogram.time_bounds.max_ms) / 60000) * 60000;
    await page.goto(`/observability/metrics?from=${encodeURIComponent(isoSecond(end - 6 * 3600000))}&to=${encodeURIComponent(isoSecond(end))}`);
    const hist = page.locator('.metricsCatalog .metricsBadge--histogram').first();
    await expect(hist).toBeVisible({ timeout: 30_000 });
    // Kind and unit: muted mono text, no fill and no border.
    for (const meta of [hist, page.locator('.metricsCatalog .metricsBadge--unit').first()]) {
      const look = await meta.evaluate((el) => {
        const probe = document.createElement('i');
        probe.style.color = 'var(--muted)';
        document.body.appendChild(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        const cs = getComputedStyle(el);
        return { muted: cs.color === muted, mono: /Plex Mono|monospace/i.test(cs.fontFamily), fill: cs.backgroundColor, border: cs.borderTopWidth };
      });
      expect(look).toEqual({ muted: true, mono: true, fill: 'rgba(0, 0, 0, 0)', border: '0px' });
    }
  });
});

test.describe('copy', () => {
  test('one feedback: the Query editor icon and the Copy JSON split read Copied', async ({ page }) => {
    await openApp(page);
    await runSuccessfulQuery(page, 'SELECT 1 AS one');
    const editorCopy = page.locator('#editorCopyButton');
    await editorCopy.click();
    await expect(editorCopy).toHaveClass(/is-copied/);
    await expect(editorCopy).toHaveAttribute('data-copied', 'Copied');
    await expect(editorCopy).not.toHaveClass(/is-copied/, { timeout: 3000 });
    const main = page.locator('#copyJsonButton');
    await main.click();
    await expect(main).toHaveText('Copied');
    await expect(main).toHaveText('Copy JSON', { timeout: 3000 });
    // The menu is an ns.menu split: a click opens it with the list focused,
    // Down on the toggle with its first item focused; Escape gives the focus
    // back to the toggle.
    await page.locator('#copyMenuButton').click();
    await expect(page.locator('#copyMenu')).toBeVisible();
    await expect(page.locator('#copyMenu')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#copyMenu')).toBeHidden();
    await expect(page.locator('#copyMenuButton')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#copyCsvButton')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#copyMenu')).toBeHidden();
    await expect(page.locator('#copyMenuButton')).toBeFocused();
    expect(await page.evaluate(() => !!document.getElementById('copyJsonToast'))).toBe(false);
  });

  test('Logs uses the same Copy JSON split', async ({ page, request }) => {
    await page.goto(await logsUrl(request));
    await page.locator('#logsTableRows .logsRow[data-row-id]').first().click({ timeout: 30_000 });
    const split = page.locator('#logsCopySplit');
    await expect(split).toBeVisible();
    await split.locator('.runSplit__toggle').click();
    await expect(page.locator('#logsCopyMenu').getByRole('menuitem')).toHaveText(['Copy body', 'Download JSON']);
    await page.keyboard.press('Escape');
    await split.locator('.runSplit__main').click();
    await expect(split.locator('.runSplit__main')).toHaveText('Copied');
  });
});

test.describe('SQL block and key/value', () => {
  for (const view of LOOKS) {
    test(`Explorer DDL: highlighted with a gutter and a copy button (${view.theme} ${view.width})`, async ({ page }) => {
      await look(page, view);
      await page.goto('/explorer/chdash_ui/weather_observations/ddl');
      const block = page.locator('.explorerDdlWrap.sqlBlock');
      await expect(block).toBeVisible({ timeout: 30_000 });
      await expect(block.locator('.sqlBlock__gutter')).toContainText('1');
      await expect(block.locator('.sqlBlock__code .tok-kw').first()).toBeVisible();
      await block.locator('.sqlBlock__copy').click();
      await expect(block.locator('.sqlBlock__copy')).toHaveClass(/is-copied/);
      expect(await noPageOverflow(page)).toBe(true);
    });
  }

  test('Services database statements: inline SQL that a click shows whole', async ({ page }) => {
    await mockTraceServices(page);
    await mockTraceResults(page);
    await page.goto('/observability/traces?tab=services');
    const row = page.locator('.traceSvcTable tbody tr.traceSvcRow').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const statement = page.locator('#traceSvcDetail .traceSvcDb .sqlBlock--inline').first();
    await expect(statement).toBeVisible({ timeout: 30_000 });
    await expect(statement).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => statement.locator('.tok-kw').count()).toBeGreaterThan(0);
    await statement.click();
    await expect(statement).toHaveAttribute('aria-expanded', 'true');
    expect(await statement.locator('.sqlBlock__code').evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    // The detail's Requests chart has two series: the engine legend shows.
    await expect(page.locator('#traceSvcDetail [data-svc-chart="rate"] .chartCore__legendItem')).toHaveCount(2);
  });

  test('Logs record fields: one key / value list with include / exclude / only / copy', async ({ page, request }) => {
    await page.goto(await logsUrl(request));
    await page.locator('#logsTableRows .logsRow[data-row-id]').first().click({ timeout: 30_000 });
    const list = page.locator('#logsSideDetails .kvList').first();
    await expect(list).toBeVisible();
    const row = list.locator('.kvList__row', { has: page.locator('.kvList__key', { hasText: /^ServiceName$/ }) });
    await row.hover();
    await expect(row.locator('[data-kv-action]')).toHaveCount(4);
    expect(await row.locator('.kvList__actions').evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await row.locator('[data-kv-action="copy"]').click();
    await expect(row.locator('[data-kv-action="copy"]')).toHaveClass(/is-copied/);
  });
});

test.describe('stat tile', () => {
  for (const view of LOOKS) {
    test(`sentence-case eyebrows on the Query rail and Explorer About (${view.theme} ${view.width})`, async ({ page }) => {
      await look(page, view);
      await openApp(page);
      const rail = page.locator('.metricCompact__label.statTile__label').first();
      await expect(rail).toHaveText('Elapsed');
      await expect(rail).toHaveCSS('text-transform', 'none');
      await page.goto('/explorer/chdash_ui/weather_observations/columns');
      const about = page.locator('.explorerAboutTile .statTile__label').first();
      await expect(about).toBeAttached({ timeout: 30_000 });
      await expect(about).toHaveCSS('text-transform', 'none');
      expect(await noPageOverflow(page)).toBe(true);
    });
  }
});
