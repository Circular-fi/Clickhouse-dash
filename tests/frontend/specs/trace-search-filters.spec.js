import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { SYNTHETIC_TRACES, mockTraceFacets, mockTraceResults, syntheticTrace } from '../helpers/traces.js';

// Trace search filters after HyperDX: filter chips (several tag filters,
// negations, exists / missing), the search state in the URL, click-to-filter
// menus on shown values and the attribute facets sidebar. The OTel fixture
// only carries two span attributes, so search / trace / facet answers are
// mocked and the tests check the requests the page sends.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
  expect(obs.failedRequests).toEqual([]);
});

const FIRST = SYNTHETIC_TRACES[0];

// The first synthetic trace with attributes to click on.
function richTrace() {
  const trace = syntheticTrace(FIRST);
  trace.spans[0].span_attributes = JSON.stringify({ 'http.method': 'GET', 'http.route': '/checkout' });
  trace.spans[0].resource_attributes = JSON.stringify({ 'deployment.environment': 'prod', 'service.name': FIRST.service });
  return trace;
}

// Search requests as URLSearchParams (repeated parameters kept).
async function mockSearches(page) {
  const searches = [];
  await mockTraceResults(page);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.endsWith('/api/traces/search')) searches.push(url.searchParams);
  });
  return searches;
}

const chips = (page) => page.locator('#tracesFilterChips .traceFilterChip');
const lastSearch = (searches) => searches[searches.length - 1];

async function waitResults(page) {
  await expect(page.locator('#tracesResults .traceResultItem, #tracesResults .traceTable__row').first()).toBeVisible({ timeout: 30_000 });
}

test('the whole search lives in the URL: shared links, reload and Back / Forward', async ({ page, context }) => {
  const searches = await mockSearches(page);
  const query = 'from=now-2h&to=now&status=Error&tag=span%3Ahttp.method%3DGET&tag_not=resource%3Adeployment.environment%3Dprod'
    + '&tag_exists=db.system&tag_missing=resource%3Ak8s.pod&service_not=cron&limit=20&sort=longest&results=table';
  await page.goto(`/observability/traces?${query}`);
  await waitResults(page);
  await expect(page.locator('#tracesResults table.traceTable')).toBeVisible();
  const first = lastSearch(searches);
  expect(first.getAll('tag')).toEqual(['span:http.method=GET']);
  expect(first.getAll('tag_not')).toEqual(['resource:deployment.environment=prod']);
  expect(first.getAll('tag_exists')).toEqual(['db.system']);
  expect(first.getAll('tag_missing')).toEqual(['resource:k8s.pod']);
  expect(first.getAll('service_not')).toEqual(['cron']);
  expect(first.get('status')).toBe('Error');
  expect(first.get('limit')).toBe('20');
  expect(Number(first.get('end_ms')) - Number(first.get('start_ms'))).toBe(2 * 3600_000);
  await expect(chips(page)).toHaveCount(5);
  await expect(chips(page).nth(0)).toHaveAttribute('title', 'span:http.method = GET');
  await expect(page.locator('#tracesStatus')).toHaveValue('Error');
  await expect(page.locator('#tracesSort')).toHaveValue('longest');
  await expect(page.locator('#tracesWorkspace .tracePicker--range .tracePicker__button')).toContainText('Last 2 hours');
  // The page-load search keeps its URL (no extra history entry).
  expect(new URL(page.url()).searchParams.getAll('tag')).toEqual(['span:http.method=GET']);

  // A shared link opens the same search in a new page.
  const other = await context.newPage();
  const otherSearches = await mockSearches(other);
  await other.goto(page.url());
  await waitResults(other);
  await expect(chips(other)).toHaveCount(5);
  expect(lastSearch(otherSearches).getAll('tag_not')).toEqual(['resource:deployment.environment=prod']);
  await other.close();

  // Reload keeps it.
  await page.reload();
  await waitResults(page);
  await expect(chips(page)).toHaveCount(5);
  expect(lastSearch(searches).getAll('tag_exists')).toEqual(['db.system']);

  // Removing a chip is a new search with its own history entry.
  const before = searches.length;
  await chips(page).filter({ hasText: 'db.system' }).locator('.traceFilterChip__remove').click();
  await expect.poll(() => searches.length).toBeGreaterThan(before);
  await expect(chips(page)).toHaveCount(4);
  expect(lastSearch(searches).getAll('tag_exists')).toEqual([]);
  await expect.poll(() => new URL(page.url()).searchParams.has('tag_exists')).toBe(false);

  // Back restores the chip and searches it again; Forward removes it again.
  const beforeBack = searches.length;
  await page.goBack();
  await expect(chips(page)).toHaveCount(5);
  await expect.poll(() => searches.length).toBeGreaterThan(beforeBack);
  expect(lastSearch(searches).getAll('tag_exists')).toEqual(['db.system']);
  await page.goForward();
  await expect(chips(page)).toHaveCount(4);
  await expect.poll(() => lastSearch(searches).getAll('tag_exists')).toEqual([]);

  // Toggling a chip's operator: = becomes != (and back on the chip itself).
  await chips(page).filter({ hasText: 'http.method' }).locator('.traceFilterChip__op').click();
  await expect.poll(() => lastSearch(searches).getAll('tag_not')).toEqual(['span:http.method=GET', 'resource:deployment.environment=prod']);
  await expect(chips(page).filter({ hasText: 'http.method' })).toHaveClass(/is-negated/);
});

test('the Tag / Value inputs add chips with =, !=, exists and missing', async ({ page }) => {
  const searches = await mockSearches(page);
  await page.goto('/observability/traces');
  await waitResults(page);
  const key = page.locator('#tracesTagKey');
  const value = page.locator('#tracesTagValue');
  const op = page.locator('#tracesTagOp');
  // The pair is the bar's free-text input: after the pickers, in the UI font.
  for (const input of [key, value]) {
    await expect(input).toHaveClass(/\bobsFilterBar__input\b/);
    expect(await input.evaluate((el) => getComputedStyle(el).fontFamily)).not.toMatch(/mono/i);
  }
  await expect(page.locator('#tracesForm .obsFilterBar__lead #tracesTagKey')).toHaveCount(0);
  await expect(page.locator('#tracesForm .obsFilterBar__tail #tracesTagKey')).toHaveCount(1);
  await key.fill('http.route');
  await value.fill('/checkout');
  await value.press('Enter');
  await expect(chips(page)).toHaveCount(1);
  await expect(key).toHaveValue('');
  await expect.poll(() => lastSearch(searches).getAll('tag')).toEqual(['http.route=/checkout']);

  await key.fill('resource:deployment.environment');
  await op.click();
  await expect(op).toHaveText('!=');
  await value.fill('dev');
  await page.locator('#tracesSearchButton').click();
  await expect(chips(page)).toHaveCount(2);
  await expect(chips(page).nth(1).locator('.traceFilterChip__scope')).toHaveText('resource');
  await expect.poll(() => lastSearch(searches).getAll('tag_not')).toEqual(['resource:deployment.environment=dev']);

  await key.fill('db.system');
  await op.click();
  await op.click();
  await expect(op).toHaveText('exists');
  await expect(value).toBeDisabled();
  await key.press('Enter');
  await key.fill('span:error.type');
  await op.click(); await op.click(); await op.click();
  await expect(op).toHaveText('missing');
  await key.press('Enter');
  await expect(chips(page)).toHaveCount(4);
  await expect.poll(() => lastSearch(searches).getAll('tag_missing')).toEqual(['span:error.type']);
  const params = lastSearch(searches);
  expect(params.getAll('tag_exists')).toEqual(['db.system']);
  expect(params.getAll('tag_missing')).toEqual(['span:error.type']);
  expect(params.getAll('tag')).toEqual(['http.route=/checkout']);
  // A key without a value for = is rejected with the usual message.
  await key.fill('half.filled');
  await key.press('Enter');
  await expect(page.locator('#tracesError')).toContainText('Tag and value must both be provided.');
  await expect(chips(page)).toHaveCount(4);
  // Clear filters drops every chip.
  await key.fill('');
  await page.locator('[data-chips-clear]').click();
  await expect(chips(page)).toHaveCount(0);
  await expect.poll(() => lastSearch(searches).getAll('tag')).toEqual([]);
});

test('click-to-filter from the span inspector and the trace header returns to the search with the filter', async ({ page }) => {
  const searches = await mockSearches(page);
  const trace = richTrace();
  await page.route((url) => url.pathname.endsWith('/api/traces/trace') && url.searchParams.get('trace_id') === FIRST.trace_id, (route) => route.fulfill({ json: trace }));
  await page.goto('/observability/traces?tag_exists=db.system');
  await waitResults(page);
  await page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"] .traceResult__wideTitle`).click();
  await expect(page.locator('#traceDetail')).toBeVisible();
  // The trace URL carries the search context.
  await expect.poll(() => new URL(page.url()).searchParams.getAll('tag_exists')).toEqual(['db.system']);

  const root = page.locator('#traceWaterfall .traceSpanRow').first();
  await root.locator('.traceSpanRow__name').click();
  const card = page.locator('#traceWaterfall .traceInspector--inline').first();
  await card.locator('[data-span-section="tags"] > summary').click();
  const method = card.locator('[data-span-section="tags"] .traceKv__row[data-kv-key="http.method"]');
  await method.locator('.traceKv__v').click();
  const menu = page.locator('#traceFilterMenu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.traceFilterMenu__title')).toContainText('span:http.method');
  await expect(menu.getByRole('menuitem')).toHaveText(['Filter for this value', 'Exclude this value', 'Search only this', 'Copy']);
  const before = searches.length;
  await menu.getByRole('menuitem', { name: 'Filter for this value' }).click();
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  await expect.poll(() => searches.length).toBeGreaterThan(before);
  let params = lastSearch(searches);
  expect(params.getAll('tag')).toEqual(['span:http.method=GET']);
  expect(params.getAll('tag_exists')).toEqual(['db.system']);
  await expect(chips(page)).toHaveCount(2);
  expect(new URL(page.url()).pathname).toMatch(/\/traces$/);

  // Resource attribute, excluded, through the row's Filter button.
  await page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"] .traceResult__wideTitle`).click();
  await page.locator('#traceWaterfall .traceSpanRow').first().locator('.traceSpanRow__name').click();
  const process = page.locator('#traceWaterfall .traceInspector--inline').first().locator('[data-span-section="process"]');
  await process.locator(':scope > summary').click();
  // The row's actions show on hover.
  const envRow = process.locator('.traceKv__row[data-kv-key="deployment.environment"]');
  await envRow.hover();
  await envRow.locator('[data-kv-filter]').click();
  await menu.getByRole('menuitem', { name: 'Exclude this value' }).click();
  await expect.poll(() => lastSearch(searches).getAll('tag_not')).toEqual(['resource:deployment.environment=prod']);

  // The service in the trace header, "Search only this": every other filter goes.
  await page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"] .traceResult__wideTitle`).click();
  await page.locator('#traceDetailTitle [data-filter-field="service"]').click();
  await expect(menu.locator('.traceFilterMenu__title')).toContainText(FIRST.service);
  await menu.getByRole('menuitem', { name: 'Search only this' }).click();
  await expect.poll(() => lastSearch(searches).getAll('service')).toEqual([FIRST.service]);
  params = lastSearch(searches);
  expect(params.getAll('tag')).toEqual([]);
  expect(params.getAll('tag_not')).toEqual([]);
  expect(params.getAll('tag_exists')).toEqual([]);
  await expect(chips(page)).toHaveCount(0);
  await expect(page.locator('#tracesService')).toHaveValue(FIRST.service);

  // The inspector's operation: exclude it.
  await page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"] .traceResult__wideTitle`).click();
  await page.locator('#traceWaterfall .traceSpanRow').first().locator('.traceSpanRow__name').click();
  await page.locator('#traceWaterfall .traceInspectorHead [data-filter-field="operation"]').click();
  await menu.getByRole('menuitem', { name: 'Exclude this value' }).click();
  await expect.poll(() => lastSearch(searches).getAll('operation_not')).toEqual([FIRST.operation]);
  await expect(chips(page).filter({ hasText: 'operation' })).toHaveCount(1);
});

test('click-to-filter from the result list service pills; Escape closes the menu', async ({ page }) => {
  const searches = await mockSearches(page);
  await page.goto('/observability/traces');
  await waitResults(page);
  const item = page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"]`);
  await item.locator('.traceSvcPill[data-service="checkout"]').click();
  const menu = page.locator('#traceFilterMenu');
  await expect(menu).toBeVisible();
  // The pill did not open the trace.
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await item.locator('.traceSvcPill[data-service="checkout"]').click();
  await menu.getByRole('menuitem', { name: 'Exclude this value' }).click();
  await expect.poll(() => lastSearch(searches).getAll('service_not')).toEqual(['checkout']);
  await expect(chips(page)).toHaveCount(1);
  await expect(chips(page).first()).toHaveAttribute('title', 'service != checkout');
  // Filter for it instead: the chip goes, the service picker takes it.
  await item.locator('.traceSvcPill[data-service="checkout"]').click();
  await menu.getByRole('menuitem', { name: 'Filter for this value' }).click();
  await expect.poll(() => lastSearch(searches).getAll('service')).toEqual(['checkout']);
  expect(lastSearch(searches).getAll('service_not')).toEqual([]);
  await expect(chips(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('service')).toBe('checkout');
});

test('a trace detail URL keeps its search context for back to search, even on a fresh page', async ({ page }) => {
  const searches = await mockSearches(page);
  await page.goto(`/observability/traces/${FIRST.trace_id}?from=now-3h&to=now&tag=http.method%3DPOST&status=Error`);
  await expect(page.locator('#traceDetail')).toBeVisible();
  await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });
  await page.locator('#traceBackButton').click();
  await waitResults(page);
  const params = lastSearch(searches);
  expect(params.getAll('tag')).toEqual(['http.method=POST']);
  expect(params.get('status')).toBe('Error');
  expect(Number(params.get('end_ms')) - Number(params.get('start_ms'))).toBe(3 * 3600_000);
  await expect(chips(page)).toHaveCount(1);
  const url = new URL(page.url());
  expect(url.pathname).toMatch(/\/traces$/);
  expect(url.searchParams.getAll('tag')).toEqual(['http.method=POST']);
  // Browser Back returns to the trace, Forward to the search.
  await page.goBack();
  await expect(page.locator('#traceDetail')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  await expect(chips(page)).toHaveCount(1);
});

test('the back arrow returns to the very search entry a trace was opened from: no new entry, Back / Forward stay coherent', async ({ page }) => {
  const searches = await mockSearches(page);
  const query = 'from=now-2h&to=now&status=Error';
  await page.goto(`/observability/traces?${query}`);
  await waitResults(page);
  const searchUrl = page.url();
  const length = () => page.evaluate(() => window.history.length);
  const start = await length();
  // Open a trace from the results, then pick a span in its spans table (a
  // second entry of the trace).
  await page.locator(`#tracesResults [data-trace-id="${FIRST.trace_id}"]`).first().click();
  await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(length).toBe(start + 1);
  await page.evaluate(() => { const select = document.getElementById('traceViewSelect'); select.value = 'spans'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.locator('#traceAltView [data-table-span]').nth(1).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('span')).not.toBeNull();
  await expect.poll(length).toBe(start + 2);
  // The arrow goes back two entries, to the search itself.
  const before = searches.length;
  await page.locator('#traceBackButton').click();
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  await expect.poll(() => page.url()).toBe(searchUrl);
  expect(await length()).toBe(start + 2);
  await expect(chips(page)).toHaveCount(0);
  expect(searches.length).toBe(before);
  // Forward walks the trace's entries again, Back returns to the search.
  await page.goForward();
  await expect(page.locator('#traceDetail')).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('span')).toBeNull();
  await page.goForward();
  await expect.poll(() => new URL(page.url()).searchParams.get('span')).not.toBeNull();
  await page.goBack();
  await page.goBack();
  await expect(page.locator('#tracesSearchView')).toBeVisible();
  await expect.poll(() => page.url()).toBe(searchUrl);
  // A trace opened on its own (a link, a new tab) has no search entry
  // behind it: the arrow adds one, and Back returns to the trace.
  await page.goto(`/observability/traces/${FIRST.trace_id}?${query}`);
  await expect(page.locator('#traceCopyJsonButton')).toBeEnabled({ timeout: 30_000 });
  const direct = await length();
  await page.locator('#traceBackButton').click();
  await waitResults(page);
  await expect.poll(length).toBe(direct + 1);
  expect(new URL(page.url()).pathname).toMatch(/\/traces$/);
  expect(new URL(page.url()).searchParams.get('status')).toBe('Error');
  await page.goBack();
  await expect(page.locator('#traceDetail')).toBeVisible();
});

test('a trace that does not exist: a not-found state with Back to search and a wider search, no raw error code', async ({ page }) => {
  const searches = await mockSearches(page);
  const missing = 'deadbeefdeadbeefdeadbeefdeadbeef';
  await page.route(`**/api/traces/trace?**trace_id=${missing}**`, (route) => route.fulfill({ status: 404, json: { error_code: 'trace_not_found', message: 'Trace was not found in the configured time scope.' } }));
  await page.goto(`/observability/traces/${missing}?from=now-2h&to=now`);
  const state = page.locator('#traceWaterfall [data-trace-unavailable-state="trace_not_found"]');
  await expect(state).toBeVisible({ timeout: 30_000 });
  await expect(state.locator('strong')).toHaveText('Trace not found');
  await expect(page.locator('#tracesError')).toBeHidden();
  await expect(page.locator('#traceDetail')).not.toContainText('trace_not_found');
  await expect(page.locator('#traceDetail')).not.toContainText('Select a trace');
  await expect(page.locator('#traceDetail')).not.toContainText('No spans.');
  await expect(page.locator('#traceDetailTitle')).toContainText(missing);
  await expect(page.locator('#traceViewBar')).toBeHidden();
  // A wider search: the same filters over twice the range.
  await state.getByRole('button', { name: 'Search a wider time range' }).click();
  await waitResults(page);
  await expect.poll(() => Number(lastSearch(searches).get('end_ms')) - Number(lastSearch(searches).get('start_ms'))).toBe(4 * 3600_000);
  // Back: the not-found trace again; Back to search: the trace's own search.
  await page.goBack();
  await expect(state).toBeVisible();
  await state.getByRole('button', { name: 'Back to search' }).click();
  await waitResults(page);
  // The results of the wider search may still be on screen when the restored
  // search goes out: wait for the request itself.
  await expect.poll(() => Number(lastSearch(searches).get('end_ms')) - Number(lastSearch(searches).get('start_ms'))).toBe(2 * 3600_000);
});

test('a trace that fails to load and a failed search say so in a sentence, without the error code, with Retry', async ({ page }) => {
  await mockSearches(page);
  let failTrace = true;
  await page.route('**/api/traces/trace?**', (route) => (failTrace
    ? route.fulfill({ status: 503, json: { error_code: 'trace_source_unavailable', message: 'ClickHouse did not answer in time.' } })
    : route.fallback()));
  await page.goto(`/observability/traces/${FIRST.trace_id}?from=now-2h&to=now`);
  const state = page.locator('#traceWaterfall [data-trace-unavailable-state="trace_source_unavailable"]');
  await expect(state).toContainText('ClickHouse did not answer in time.', { timeout: 30_000 });
  await expect(state).not.toContainText('trace_source_unavailable');
  failTrace = false;
  await state.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#traceWaterfall .traceSpanRow').first()).toBeVisible({ timeout: 30_000 });

  let failSearch = true;
  await page.route('**/api/traces/search?**', (route) => (failSearch
    ? route.fulfill({ status: 503, json: { error_code: 'trace_search_failed', message: 'Too many simultaneous queries.' } })
    : route.fallback()));
  await page.locator('#traceBackButton').click();
  const strip = page.locator('#tracesError');
  await expect(strip).toHaveText(/Too many simultaneous queries\./, { timeout: 30_000 });
  await expect(strip).not.toContainText('trace_search_failed');
  failSearch = false;
  await strip.getByRole('button', { name: 'Retry' }).click();
  await waitResults(page);
  await expect(strip).toBeHidden();
});

test('facets: keys and values, include / exclude, pins, load more and key search', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (!sessionStorage.getItem('__facetsInit')) {
        localStorage.removeItem('chdash.traceFacetPins.v1');
        localStorage.removeItem('chdash.traceFacetsCollapsed.v1');
        sessionStorage.setItem('__facetsInit', '1');
      }
    } catch (_) {}
  });
  const searches = await mockSearches(page);
  const seen = await mockTraceFacets(page);
  await page.goto('/observability/traces');
  await waitResults(page);
  const panel = page.locator('#traceFacets');
  await expect(panel).toBeVisible();
  const facets = panel.locator('.traceFacet');
  await expect(facets).toHaveCount(20);
  await expect(panel.locator('#traceFacetsMeta')).toHaveText('≈3M spans');
  await expect(facets.first().locator('.traceFacet__key')).toHaveText('http.method');
  await expect(facets.first().locator('.traceFacet__count')).toHaveText('≈1.2K');
  await expect(facets.nth(1).locator('.traceFacet__scope')).toHaveText('R');
  // Load more keys.
  await panel.locator('[data-facet-more-keys]').click();
  await expect(facets).toHaveCount(25);
  // Key search.
  await panel.locator('#traceFacetsSearch').fill('environment');
  await expect(facets).toHaveCount(1);
  await panel.locator('#traceFacetsSearch').fill('');

  // Expand a key: its values (limit 10), then load more (limit 50).
  const method = panel.locator('.traceFacet[data-facet-key="http.method"]');
  await method.locator('[data-facet-expand]').click();
  await expect(method.locator('.traceFacetValue')).toHaveCount(10);
  expect(seen.values[seen.values.length - 1].get('limit')).toBe('10');
  expect(seen.values[seen.values.length - 1].get('scope')).toBe('span');
  await method.locator('[data-facet-more-values]').click();
  await expect(method.locator('.traceFacetValue')).toHaveCount(11);
  expect(seen.values[seen.values.length - 1].get('limit')).toBe('50');
  await expect(method.locator('[data-facet-more-values]')).toHaveCount(0);

  // Include GET: a chip and a search; the facets follow the new filters.
  const keysBefore = seen.keys.length;
  await method.locator('.traceFacetValue[data-facet-value="GET"] [data-facet-include]').check();
  await expect.poll(() => lastSearch(searches).getAll('tag')).toEqual(['span:http.method=GET']);
  await expect(chips(page)).toHaveCount(1);
  await expect.poll(() => seen.keys.length).toBeGreaterThan(keysBefore);
  expect(seen.keys[seen.keys.length - 1].getAll('tag')).toEqual(['span:http.method=GET']);
  // Its own values ignore nothing server-side, but stay listed and checked.
  await expect(method.locator('.traceFacetValue[data-facet-value="GET"] [data-facet-include]')).toBeChecked();
  // A second value of the same key: both chips (the server ORs one key's values).
  await method.locator('.traceFacetValue[data-facet-value="POST"] [data-facet-include]').check();
  await expect.poll(() => lastSearch(searches).getAll('tag')).toEqual(['span:http.method=GET', 'span:http.method=POST']);

  // Exclude on a resource value.
  const env = panel.locator('.traceFacet[data-facet-key="deployment.environment"]');
  await env.locator('[data-facet-expand]').click();
  await env.locator('.traceFacetValue[data-facet-value="staging"] [data-facet-exclude]').click();
  await expect.poll(() => lastSearch(searches).getAll('tag_not')).toEqual(['resource:deployment.environment=staging']);
  await expect(env.locator('.traceFacetValue[data-facet-value="staging"]')).toHaveClass(/is-excluded/);
  // Unchecking removes the include chip.
  await method.locator('.traceFacetValue[data-facet-value="GET"] [data-facet-include]').uncheck();
  await expect.poll(() => lastSearch(searches).getAll('tag')).toEqual(['span:http.method=POST']);

  // Pin a key: it moves to the pinned group, and stays pinned after a reload.
  const last = panel.locator('.traceFacet[data-facet-key="app.key05"]');
  await last.locator('[data-facet-pin]').click();
  await expect(panel.locator('.traceFacets__group--pinned .traceFacet')).toHaveCount(1);
  await expect(panel.locator('.traceFacets__group--pinned .traceFacet__key')).toHaveText('app.key05');
  await page.reload();
  await waitResults(page);
  await expect(panel.locator('.traceFacets__group--pinned .traceFacet__key')).toHaveText('app.key05');
  await expect(chips(page)).toHaveCount(2);

  // The sidebar folds into a rail, remembered across reloads.
  await page.locator('#traceFacetsToggle').click();
  await expect(page.locator('#traceFacetsToggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('#traceFacetsList')).toBeHidden();
  await page.reload();
  await waitResults(page);
  await expect(page.locator('#traceFacetsToggle')).toHaveAttribute('aria-expanded', 'false');
  const keysSeen = seen.keys.length;
  await page.locator('#traceFacetsToggle').click();
  await expect(panel.locator('.traceFacet').first()).toBeVisible();
  expect(seen.keys.length).toBeGreaterThan(keysSeen);
});
