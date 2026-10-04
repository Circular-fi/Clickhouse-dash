import { test, expect } from '@playwright/test';

// Shared UI infrastructure in the browser: the module manifest and its one
// loader (ns.loader), the state component (ns.uiState), feature flags
// (ns.features), superseded requests (util.latest + api {signal}), browser
// storage (storage.pref), search fields (ns.search) and the live-region
// conventions. Source contracts: tests/harness/test_ui_infrastructure_contract.py
// and test_page_manifest_contract.py.

const PAGES = [
  { path: '/query', name: 'query' },
  { path: '/explorer', name: 'explorer' },
  { path: '/observability/traces', name: 'observability' },
];

async function open(page, path) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(path);
  await page.waitForFunction(() => !!(window.ChDash?.uiState && window.ChDash?.features && window.ChDash?.search && window.ChDash?.api));
  return errors;
}

for (const { path, name } of PAGES) {
  test(`ui infrastructure: one manifest, each script once, the shared helpers on ${path}`, async ({ page }) => {
    const errors = await open(page, path);
    const state = await page.evaluate(() => {
      const ns = window.ChDash;
      const scripts = [...document.scripts].map((s) => (s.getAttribute('src') || '').split('/').pop()).filter(Boolean);
      return {
        page: ns.loader.page.name,
        common: ns.loader.page.common,
        scripts,
        header: document.querySelectorAll('header.appHeader').length,
        // The theme button shows one of its three sprite icons: the head script's mode.
        themeIcon: [...document.querySelectorAll('#themeSelectText > .themeIcon')]
          .filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.getAttribute('class')).join(' | '),
      };
    });
    expect(state.page).toBe(name);
    expect(state.common.slice(0, 3)).toEqual(['app_format.js', 'app_palette.js', 'app_dom.js']);
    expect(state.common).toEqual(expect.arrayContaining(['app_ui_state.js', 'app_ui_search.js']));
    expect(new Set(state.scripts).size).toBe(state.scripts.length);
    // The shell starts the loader, then the controller (the modules the loader inserts may sit before them).
    const controller = name === 'observability' ? 'app_observability.js' : 'app.js';
    expect(state.scripts.filter((file) => file === 'app_loader.js' || file === controller)).toEqual(['app_loader.js', controller]);
    expect(state.header).toBe(1);
    expect(state.themeIcon).toMatch(/^icon icon--lg themeIcon themeIcon--(system|dark|light)$/);
    expect(errors).toEqual([]);
  });
}

test('ui infrastructure: ns.uiState renders empty, error, loading, banner and busy with their roles', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(async () => {
    const ui = window.ChDash.uiState;
    const box = document.createElement('div');
    document.body.appendChild(box);
    let clicked = 0;
    const empty = ui.empty(box, { title: 'Nothing here', body: 'Widen the range.', action: { label: 'Zoom out', onClick: () => { clicked += 1; } } });
    empty.querySelector('.uiState__action').click();
    const emptyState = { role: empty.getAttribute('role'), title: empty.querySelector('.uiState__title').textContent, clicked };
    const error = ui.error(box, { body: 'It broke.', retry: () => { clicked += 10; } });
    const errorState = { role: error.getAttribute('role'), retry: error.querySelector('.uiState__action')?.textContent };
    error.querySelector('.uiState__action').click();
    // Every way to build a loading block says its label; "Loading…" without one.
    const sentence = (el) => [el.getAttribute('role'), el.querySelector('.uiState__title'), el.querySelector('.uiState__body')?.textContent];
    const host = document.createElement('div');
    host.innerHTML = ui.loadingHtml({ label: 'Loading the history…', compact: true });
    const labels = {
      loading: sentence(ui.loading(box, { label: 'Loading the chart…' })),
      block: sentence(ui.block('loading', { label: 'Loading the preview…' })),
      html: sentence(host.firstElementChild),
      unlabelled: sentence(ui.block('loading', { title: 'Ignored' })),
    };
    ui.loading(box, { label: 'Loading…' });
    const loadingState = { role: box.firstElementChild.getAttribute('role'), busy: box.getAttribute('aria-busy'), spinner: !!box.querySelector('.uiSpin'), labels };
    const strip = document.createElement('div');
    document.body.appendChild(strip);
    let retried = 0;
    ui.banner(strip, { message: 'The server could not be reached.', retry: () => { retried += 1; } });
    const bannerState = { role: strip.getAttribute('role'), hidden: strip.hidden, text: strip.querySelector('.uiBanner__text').textContent };
    strip.querySelector('.uiBanner__retry').click();
    const afterRetry = { hidden: strip.hidden, retried };
    const button = document.createElement('button');
    button.textContent = 'Search';
    document.body.appendChild(button);
    ui.busy(button, true);
    const busy = { disabled: button.disabled, aria: button.getAttribute('aria-busy'), cls: button.classList.contains('is-loading'), spin: getComputedStyle(button.querySelector('.uiSpin')).display };
    ui.busy(button, false);
    const idle = { disabled: button.disabled, aria: button.getAttribute('aria-busy'), spin: getComputedStyle(button.querySelector('.uiSpin')).display };
    const html = ui.emptyHtml({ body: '<b>x</b>', action: { label: 'Go', attrs: { 'data-go': '' } } });
    return { emptyState, errorState, clicked, loadingState, bannerState, afterRetry, busy, idle, html };
  });
  expect(out.emptyState).toEqual({ role: null, title: 'Nothing here', clicked: 1 });
  expect(out.errorState).toEqual({ role: 'alert', retry: 'Retry' });
  expect(out.clicked).toBe(11);
  expect(out.loadingState).toEqual({
    role: 'status', busy: 'true', spinner: true,
    labels: {
      loading: ['status', null, 'Loading the chart…'],
      block: ['status', null, 'Loading the preview…'],
      html: ['status', null, 'Loading the history…'],
      unlabelled: ['status', null, 'Loading…'],
    },
  });
  expect(out.bannerState).toEqual({ role: 'alert', hidden: false, text: 'The server could not be reached.' });
  expect(out.afterRetry).toEqual({ hidden: true, retried: 1 });
  expect(out.busy).toEqual({ disabled: true, aria: 'true', cls: true, spin: 'inline-block' });
  expect(out.idle).toEqual({ disabled: false, aria: null, spin: 'none' });
  expect(out.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  expect(out.html).toContain('data-go');
});

test('ui infrastructure: ns.features follows /api/version over the defaults table', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(async () => {
    const features = window.ChDash.features;
    await features.ready;
    const version = await window.ChDash.api.getVersion();
    return {
      known: features.known(),
      explorer: features.get('explorer.enabled') === (version.features?.explorer?.enabled ?? features.DEFAULTS.explorer.enabled),
      traces: features.get('traces.enabled') === (version.features?.traces?.enabled ?? false),
      system: features.get('system.enabled') === (version.features?.system?.enabled ?? features.DEFAULTS.system.enabled),
      keeper: typeof features.get('system.keeper'),
      missing: features.get('no.such.flag', 'fallback'),
      defaults: { enabled: features.DEFAULTS.system.enabled, activity: features.DEFAULTS.system.activity, keeper: features.DEFAULTS.system.keeper },
    };
  });
  expect(out).toEqual({ known: true, explorer: true, traces: true, system: true, keeper: 'boolean', missing: 'fallback', defaults: { enabled: true, activity: true, keeper: true } });
});

test('ui infrastructure: util.errorText says what failed in a sentence, without the error code', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(async () => {
    const { util, api } = window.ChDash;
    const missing = await api.getTrace('local', '0123').then(() => null, (error) => ({ raw: error.message, text: util.errorText(error) }));
    const network = Object.assign(new Error('network_error: Failed to fetch'), { code: 'network_error' });
    return {
      missing,
      network: util.errorText(network),
      plain: util.errorText(new Error('The query is empty.')),
      prefixed: util.errorText('invalid_trace_charts: Unknown chart list.'),
      empty: util.errorText(new Error(''), 'Cannot load the metric.'),
      none: util.errorText(null),
    };
  });
  // app_api.js errors read "code: message"; the sentence drops the code.
  expect(out.missing.raw).toMatch(/^[a-z_]+: /);
  expect(out.missing.text).toBe(out.missing.raw.replace(/^[a-z_]+: /, ''));
  expect(out.network).toBe('The server could not be reached. Check the connection and retry.');
  expect(out.plain).toBe('The query is empty.');
  expect(out.prefixed).toBe('Unknown chart list.');
  expect(out.empty).toBe('Cannot load the metric.');
  expect(out.none).toBe('The request failed.');
});

test('ui infrastructure: util.latest aborts the superseded request and keeps the last answer', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(async () => {
    const { util, api } = window.ChDash;
    const first = util.latest('spec.version');
    const one = api.getVersion({ signal: first.signal }).then(() => 'answered', (error) => (util.isAbort(error) ? 'aborted' : `error ${error.message}`));
    const second = util.latest('spec.version');
    const two = api.getVersion({ signal: second.signal }).then(() => 'answered', (error) => `error ${error.message}`);
    const results = await Promise.all([one, two]);
    return { results, firstCurrent: first.isCurrent(), secondCurrent: second.isCurrent(), online: window.ChDash.state.apiOnline };
  });
  expect(out).toEqual({ results: ['aborted', 'answered'], firstCurrent: false, secondCurrent: true, online: true });
});

test('ui infrastructure: storage.pref keeps each format, migrates legacy keys and survives blocked storage', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(() => {
    const { storage } = window.ChDash;
    const flag = storage.pref('chdash.spec.flag', false);
    flag.set(true);
    const raw01 = localStorage.getItem('chdash.spec.flag');
    const text = storage.pref('chdash.spec.text', true, { text: true });
    text.set(false);
    const rawText = localStorage.getItem('chdash.spec.text');
    localStorage.setItem('chdash.spec.old', 'false');
    const migrated = storage.pref('chdash.spec.new', true, { text: true, legacy: ['chdash.spec.old'] }).get();
    const movedTo = localStorage.getItem('chdash.spec.new');
    const choice = storage.pref('chdash.spec.choice', 'list', { allowed: ['list', 'table'] });
    localStorage.setItem('chdash.spec.choice', 'bogus');
    const invalid = choice.get();
    const json = storage.pref('chdash.spec.json', []);
    json.set([1, 2]);
    const parsed = json.get();
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => { throw new Error('blocked'); };
    Storage.prototype.setItem = () => { throw new Error('blocked'); };
    const blocked = { get: flag.get(), set: flag.set(false) };
    Storage.prototype.getItem = getItem;
    Storage.prototype.setItem = setItem;
    for (const key of ['flag', 'text', 'old', 'new', 'choice', 'json']) localStorage.removeItem(`chdash.spec.${key}`);
    return { raw01, read: flag.get, rawText, migrated, movedTo, invalid, parsed, blocked, keys: Object.keys(storage.KEYS).length > 30 };
  });
  expect(out.raw01).toBe('1');
  expect(out.rawText).toBe('false');
  expect(out.migrated).toBe(false);
  expect(out.movedTo).toBe('false');
  expect(out.invalid).toBe('list');
  expect(out.parsed).toEqual([1, 2]);
  expect(out.blocked).toEqual({ get: false, set: false });
  expect(out.keys).toBe(true);
});

test('ui infrastructure: ns.search waits for the one delay, Enter and Escape apply at once', async ({ page }) => {
  await open(page, '/query');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'specSearch';
    document.body.appendChild(input);
    window.__searchCalls = [];
    window.ChDash.search.bind(input, (value) => window.__searchCalls.push([value, performance.now()]));
  });
  const field = page.locator('#specSearch');
  const typedAt = await page.evaluate(() => performance.now());
  await field.pressSequentially('abc', { delay: 20 });
  await expect.poll(() => page.evaluate(() => window.__searchCalls.length)).toBe(1);
  const [value, at] = (await page.evaluate(() => window.__searchCalls))[0];
  expect(value).toBe('abc');
  expect(at - typedAt).toBeGreaterThanOrEqual(200);
  await field.press('Escape');
  expect((await page.evaluate(() => window.__searchCalls)).map((c) => c[0])).toEqual(['abc', '']);
  await field.fill('x');
  await field.press('Enter');
  expect((await page.evaluate(() => window.__searchCalls)).map((c) => c[0])).toEqual(['abc', '', 'x']);
  const look = await field.evaluate((el) => ({ cls: el.className, radius: getComputedStyle(el).borderTopLeftRadius, height: getComputedStyle(el).height }));
  expect(look).toEqual({ cls: 'uiSearch', radius: '6px', height: '28px' });
});

for (const theme of ['dark', 'light']) {
  test(`ui infrastructure: every search field has the one look (${theme})`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem('chdash.theme', mode), theme);
    // A side panel's search (the Metrics catalog's search is the filter
    // bar's since audit 2: the Traces attributes' stands for Observability).
    await open(page, '/observability/traces');
    const metrics = await page.locator('#traceFacetsSearch').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: cs.borderTopLeftRadius, border: cs.borderTopColor, bg: cs.backgroundColor, size: cs.fontSize };
    });
    await page.goto('/explorer');
    await page.waitForFunction(() => !!window.ChDash?.search);
    const explorer = await page.locator('#explorerSearchInput').evaluate((el) => {
      const cs = getComputedStyle(el);
      return { radius: cs.borderTopLeftRadius, border: cs.borderTopColor, bg: cs.backgroundColor, size: cs.fontSize };
    });
    expect(explorer).toEqual(metrics);
    expect(metrics.radius).toBe('6px');
  });
}

test('ui infrastructure: no pane is live, hover readouts are tooltips, the Explorer starts on the databases overview', async ({ page }) => {
  await open(page, '/explorer');
  await expect(page.locator('#explorerDatabasesOverview')).toBeVisible({ timeout: 15_000 });
  const explorer = await page.evaluate(() => ({
    livePanes: [...document.querySelectorAll('.explorerDetailPane[aria-live]')].length,
    emptyState: !document.getElementById('explorerEmptyState')?.hidden,
    title: document.getElementById('explorerDetailName')?.textContent || '',
    banner: document.getElementById('explorerError')?.getAttribute('role'),
  }));
  expect(explorer).toEqual({ livePanes: 0, emptyState: false, title: 'All databases', banner: 'alert' });
  await page.goto('/observability/traces');
  await page.waitForFunction(() => !!window.ChDash?.uiState);
  expect(await page.locator('#traceDetail').getAttribute('aria-live')).toBeNull();
  expect(await page.locator('#tracesError').getAttribute('role')).toBe('alert');
  expect(await page.locator('#tracesSearchButton .uiSpin').count()).toBe(1);
});

for (const theme of ['dark', 'light']) {
  test(`ui infrastructure: an empty Logs range offers a way out and fits a phone (${theme})`, async ({ page }) => {
    await page.addInitScript((mode) => localStorage.setItem('chdash.theme', mode), theme);
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, '/observability/logs?from=2001-01-01%2000:00:00&to=2001-01-01%2001:00:00');
    const state = page.locator('#logsTableMessage .uiState--empty');
    await expect(state).toBeVisible({ timeout: 30_000 });
    await expect(state.locator('.uiState__title')).toHaveText('No logs match in this time range');
    await expect(state.getByRole('button', { name: 'Show the last hour of data' })).toBeVisible();
    const box = await state.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    const colors = await state.evaluate((el) => ({ title: getComputedStyle(el.querySelector('.uiState__title')).color, body: getComputedStyle(el).color }));
    expect(colors.title).not.toBe(colors.body);
  });
}

// Regression: the tree and the database page loaded a failed database again
// on every render, a request loop against a failing server that also kept the
// error from ever showing.
test('ui infrastructure: a database whose objects fail to load says so in the tree and Retry loads them', async ({ page }) => {
  let failures = 1;
  let requests = 0;
  await page.route(/\/api\/explorer\/catalog\?.*database=chdash_ui(?:&|$)/, async (route) => {
    requests += 1;
    if (failures > 0) {
      failures -= 1;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'catalog unavailable' }) });
      return;
    }
    await route.continue();
  });
  // The page's own count of the database's requests, made as it asks (the
  // route above only sees a request once it reaches the network).
  await page.addInitScript(() => {
    const native = window.fetch;
    window.__databaseFetches = 0;
    window.fetch = function (input, init) {
      if (/\/api\/explorer\/catalog\?.*database=chdash_ui(?:&|$)/.test(String(input?.url || input))) window.__databaseFetches += 1;
      return native.call(this, input, init);
    };
  });
  await open(page, '/explorer');
  const toggle = page.locator('#explorerTableList .explorerTreeDatabaseToggle[aria-label="Expand chdash_ui"]');
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  await toggle.click();
  const failed = page.locator('#explorerTableList .explorerTreeChildren .uiState--error');
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await expect(failed).toHaveAttribute('role', 'alert');
  await expect(failed.locator('.uiState__body')).toHaveText('Unable to load tables');
  // A render loop asks again as it renders: two frames after the error shows,
  // the page has still asked once.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => window.__databaseFetches)).toBe(1);
  expect(requests).toBe(1);
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#explorerTableList .explorerTreeChildren .uiState')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#explorerTableList .explorerTreeChildren').first()).toContainText('weather_observations');
});

test('ui infrastructure: the Explorer refresh button is busy while the catalog reloads', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await open(page, '/explorer');
  await expect(page.locator('#explorerTableList .explorerTreeDatabaseToggle').first()).toBeVisible({ timeout: 15_000 });
  await page.route(/\/api\/explorer\/catalog\?/, async (route) => { await held; await route.continue(); });
  const button = page.locator('#explorerRefreshButton');
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button).toBeDisabled();
  expect(await button.evaluate((el) => ({
    spin: getComputedStyle(el.querySelector('.uiSpin')).display,
    glyph: getComputedStyle(el.querySelector('.refreshGlyph')).display,
  }))).toEqual({ spin: expect.not.stringMatching(/^none$/), glyph: 'none' });
  release();
  await expect(button).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(button).toBeEnabled();
});

test('ui infrastructure: a query library that fails to load offers Retry, which opens it', async ({ page }) => {
  let blocked = true;
  await page.route(/\/static\/app_query_library\.js(?:\?|$)/, async (route) => {
    if (blocked) { await route.abort(); return; }
    await route.continue();
  });
  await open(page, '/query');
  await page.locator('#queryLibraryButton').click();
  const failed = page.locator('#queryLibraryViewSaved .uiState--error');
  await expect(failed).toBeVisible({ timeout: 15_000 });
  await expect(failed).toHaveAttribute('role', 'alert');
  await expect(failed.locator('.uiState__body')).toHaveText('The query library could not be loaded.');
  blocked = false;
  await failed.getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('#queryLibraryViewSaved [role=tree]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#queryLibraryViewSaved .uiState--error')).toHaveCount(0);
});

test('ui infrastructure: an Explorer search that finds nothing offers to clear it', async ({ page }) => {
  await open(page, '/explorer/_functions');
  const list = page.locator('#explorerFunctionList');
  await expect(list.locator('button').first()).toBeVisible({ timeout: 15_000 });
  const input = page.locator('#explorerFunctionSearchInput');
  await input.fill('zz_no_such_function_zz');
  const empty = list.locator(':scope > .uiState--empty');
  await expect(empty.locator('.uiState__body')).toHaveText('No functions found');
  await empty.getByRole('button', { name: 'Clear the search' }).click();
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
  await expect(list.locator('button').first()).toBeVisible();
  await expect(list.locator(':scope > .uiState')).toHaveCount(0);
});
