import { test, expect } from '@playwright/test';

// Shared UI foundations in the browser (docs/ui-foundations.md): ns.format
// and ns.palette load first on every page shell, palette.resolve follows the
// theme, the semantic tokens hold their documented values in every theme
// context, the aliased older tokens keep theirs, and format.time uses the
// browser's zone. The pure unit checks run under Node
// (tests/harness/ui_foundations_unit.js).

const PAGES = ['/query', '/explorer/catalog', '/observability/traces'];

// Documented values (dark, light), as getComputedStyle prints them.
const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};
const TOKENS = {
  '--danger': ['#f87171', '#b91c1c'],
  '--danger-bg': ['rgba(239, 68, 68, 0.12)', 'rgba(239, 68, 68, 0.12)'],
  '--warning': ['#fbbf24', '#9a5b00'],
  '--warning-bg': ['rgba(245, 158, 11, 0.12)', 'rgba(245, 158, 11, 0.12)'],
  '--success': ['#34d399', '#137333'],
  '--success-bg': ['rgba(34, 197, 94, 0.12)', 'rgba(34, 197, 94, 0.12)'],
  '--info': ['#60a5fa', '#1d4ed8'],
  '--info-bg': ['rgba(59, 130, 246, 0.12)', 'rgba(59, 130, 246, 0.12)'],
  '--sev-fatal': ['#ff5f8a', '#b4235a'],
  '--sev-error': ['#f87171', '#dc2626'],
  '--sev-warn': ['#fbbf24', '#b45309'],
  '--sev-info': ['#60a5fa', '#2563eb'],
  '--sev-debug': ['#8b95a5', '#556378'],
  '--sev-trace': ['#7d8590', '#66727f'],
  '--accent-fill': ['#356fe6', '#2558d9'],
  '--accent-tint': ['rgba(53, 111, 230, 0.16)', 'rgba(37, 88, 217, 0.1)'],
  '--danger-fill': ['#dc2626', '#dc2626'],
  '--on-fill': ['#ffffff', '#ffffff'],
  '--accent-text': ['#93b4ff', '#1d4ed8'],
  '--kind-table': ['#5f8ced', '#1f52c9'],
  '--kind-view': ['#44b7eb', '#0e87cd'],
  '--kind-mv': ['#9f7cf5', '#7051db'],
  '--kind-dict': ['#dc913a', '#ad6720'],
  '--kind-buffer': ['#49c5b9', '#13959b'],
  '--kind-distributed': ['#5dd18b', '#1d9766'],
  // Percentiles: one hue, p50 the quietest step.
  '--pct-p50': ['#6575a7', '#7286c6'],
  '--pct-p90': ['#7991df', '#4b63c1'],
  '--pct-p95': ['#97b0ff', '#3448a4'],
  '--pct-p99': ['#c8d6ff', '#1d2a6f'],
  // The one categorical palette (services and series): slots 1, 8 and 18.
  '--qchart-1': ['#4296fb', '#1a73d5'],
  '--qchart-8': ['#49c1ea', '#046480'],
  '--qchart-18': ['#85e2ed', '#03464c'],
  '--on-fill-dark': ['#15181d', '#15181d'],
  '--json-string': ['#bbe0cc', '#183e2b'],
  '--json-number': ['#e9d8ba', '#463519'],
  '--json-bool': ['#d8d4ee', '#35314e'],
  '--json-null': ['#adb2ba', '#464c57'],
  // Graphite surfaces and text (docs/ui-foundations.md).
  '--bg': ['#0d0f12', '#f6f7f9'],
  '--panel': ['#13161a', '#ffffff'],
  '--raised': ['#191d22', '#ffffff'],
  '--text': ['#e6e8eb', '#15181d'],
  '--muted': ['#959ba5', '#5b6270'],
};
const computed = (value) => (value.startsWith('#') ? rgb(value) : value);

// Older tokens that now alias a semantic one: the values they had before.
const ALIASES = {
  '--error-bg': ['rgba(239, 68, 68, 0.12)', 'rgba(239, 68, 68, 0.12)'],
  '--accentText': ['rgb(147, 180, 255)', 'rgb(29, 78, 216)'],
  '--graph-error': ['rgb(248, 113, 113)', 'rgb(185, 28, 28)'],
};

async function open(page, path) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(path);
  await page.waitForFunction(() => !!(window.ChDash?.format && window.ChDash?.palette && window.ChDash?.ui));
  return errors;
}

// Every token, resolved through a probe, for one theme context.
function readTokens(page, names, theme) {
  return page.evaluate(({ names, theme }) => {
    const html = document.documentElement;
    if (theme === 'system') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', theme);
    const probe = document.createElement('i');
    html.appendChild(probe);
    const out = {};
    for (const name of names) {
      probe.style.color = '';
      probe.style.color = `var(${name})`;
      out[name] = getComputedStyle(probe).color;
    }
    probe.remove();
    return out;
  }, { names, theme });
}

for (const path of PAGES) {
  test(`ui foundations: ns.format and ns.palette load first on ${path}`, async ({ page }) => {
    const errors = await open(page, path);
    const scripts = await page.evaluate(() => [...document.scripts].map((s) => (s.getAttribute('src') || '').split('/').pop()).filter((name) => /^app_/.test(name) && name !== 'app_observability.js' && name !== 'app_loader.js'));
    expect(scripts.slice(0, 3)).toEqual(['app_format.js', 'app_palette.js', 'app_dom.js']);
    const api = await page.evaluate(() => ({
      format: Object.keys(window.ChDash.format).sort(),
      palette: Object.keys(window.ChDash.palette).sort(),
      bytes: window.ChDash.util.formatBytes(10.3 * 1024 * 1024),
      int: window.ChDash.util.formatInt(120064.9),
      micro: window.ChDash.format.duration(350e3),
    }));
    expect(api.format).toEqual(expect.arrayContaining(['duration', 'count', 'compact', 'bytes', 'bytesRate', 'percent', 'rate', 'time', 'timeTitle', 'range', 'ago', 'EMPTY', 'emptyIfNull', 'nullToken']));
    expect(api.palette).toEqual(expect.arrayContaining(['categorical', 'service', 'quantile', 'severity', 'sequential', 'kind', 'resolve']));
    expect(api.bytes).toBe('10.3 MB');
    expect(api.int).toBe('120,064');
    expect(api.micro).toBe('350 µs');
    // The NULL token is styled on this page's stylesheet.
    const nullStyle = await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.innerHTML = window.ChDash.format.nullToken();
      document.body.appendChild(holder);
      const style = getComputedStyle(holder.firstElementChild);
      const out = { color: style.color, fontStyle: style.fontStyle, token: window.ChDash.palette.resolve('--json-null') };
      holder.remove();
      return out;
    });
    expect(nullStyle.fontStyle).toBe('italic');
    expect(nullStyle.color).toBe(nullStyle.token);
    expect(errors).toEqual([]);
  });
}

test('ui foundations: semantic tokens hold their values; forced themes equal the OS themes; aliases keep theirs', async ({ page }) => {
  await open(page, '/observability/traces');
  const names = [...Object.keys(TOKENS), ...Object.keys(ALIASES)];
  await page.emulateMedia({ colorScheme: 'dark' });
  const dark = await readTokens(page, names, 'dark');
  const systemDark = await readTokens(page, names, 'system');
  await page.emulateMedia({ colorScheme: 'light' });
  const light = await readTokens(page, names, 'light');
  const systemLight = await readTokens(page, names, 'system');
  // Forced Dark on a light OS, forced Light on a dark OS.
  const darkOnLight = await readTokens(page, names, 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  const lightOnDark = await readTokens(page, names, 'light');
  for (const [name, [d, l]] of Object.entries(TOKENS)) {
    expect.soft(dark[name], name).toBe(computed(d));
    expect.soft(light[name], name).toBe(computed(l));
  }
  for (const [name, [d, l]] of Object.entries(ALIASES)) {
    expect.soft(dark[name], name).toBe(d);
    expect.soft(light[name], name).toBe(l);
  }
  expect(systemDark).toEqual(dark);
  expect(systemLight).toEqual(light);
  expect(darkOnLight).toEqual(dark);
  expect(lightOnDark).toEqual(light);
});

test('ui foundations: palette.resolve reads each theme once and follows theme changes', async ({ page }) => {
  await open(page, '/query');
  await page.emulateMedia({ colorScheme: 'dark' });
  const step = (theme) => page.evaluate((theme) => {
    const html = document.documentElement;
    if (theme === 'system') html.removeAttribute('data-theme');
    else html.setAttribute('data-theme', theme);
    const { palette } = window.ChDash;
    return {
      sev: palette.resolve('--sev-error'),
      ref: palette.resolve(palette.severity('ERROR')),
      json: palette.resolve('var(--json-null)'),
      service: palette.resolve(palette.service('checkout', { assign: false })),
      literal: palette.resolve('#123456'),
      empty: palette.resolve(''),
    };
  }, theme);
  const forcedDark = await step('dark');
  expect(forcedDark.sev).toBe('rgb(248, 113, 113)');
  expect(forcedDark.ref).toBe('rgb(248, 113, 113)');
  expect(forcedDark.json).toBe('rgb(173, 178, 186)');
  expect(forcedDark.service).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
  expect(forcedDark.literal).toBe('rgb(18, 52, 86)');
  expect(forcedDark.empty).toBe('');
  const forcedLight = await step('light');
  expect(forcedLight.sev).toBe('rgb(220, 38, 38)');
  expect(forcedLight.json).toBe('rgb(70, 76, 87)');
  expect(forcedLight.service).not.toBe(forcedDark.service);
  // System mode follows the OS scheme, also when it changes under the page.
  expect((await step('system')).sev).toBe('rgb(248, 113, 113)');
  await page.emulateMedia({ colorScheme: 'light' });
  expect((await step('system')).sev).toBe('rgb(220, 38, 38)');
  // One probe element, however many colours are resolved.
  expect(await page.evaluate(() => document.querySelectorAll('html > i[aria-hidden="true"]').length)).toBe(1);
});

test.describe('ui foundations: browser-local time', () => {
  test.use({ timezoneId: 'Europe/Paris' });

  test('format.time, timeTitle and range use the browser zone, across DST', async ({ page }) => {
    await open(page, '/query');
    const out = await page.evaluate(() => {
      const { format } = window.ChDash;
      const now = Date.UTC(2026, 9, 2, 12);
      const t = Date.UTC(2026, 8, 12, 14, 29, 57, 123);
      return {
        time: format.time(t, { now }),
        ms: format.time(t, { now, precision: 'ms' }),
        lastYear: format.time(Date.UTC(2025, 0, 5, 3, 4, 5), { now }),
        title: format.timeTitle(t, { serverTz: 'America/New_York' }).split('\n'),
        firstHalf: format.timeTitle(Date.UTC(2026, 9, 25, 0, 30)).split('\n')[1],
        secondHalf: format.timeTitle(Date.UTC(2026, 9, 25, 1, 30)).split('\n')[1],
        spring: format.range(Date.UTC(2026, 2, 29, 0, 30), Date.UTC(2026, 2, 29, 1, 30)),
        short: format.range(t, t + 300000),
        preset: format.range('now-1h', 'now'),
      };
    });
    expect(out.time).toBe('Sep 12 16:29:57');
    expect(out.ms).toBe('Sep 12 16:29:57.123');
    expect(out.lastYear).toBe('Jan 5, 2025 04:04:05');
    expect(out.title).toEqual([
      '2026-09-12T14:29:57.123Z',
      'Sep 12, 2026 16:29:57.123 local (Europe/Paris, UTC+02:00)',
      'Sep 12, 2026 14:29:57.123 UTC',
      'Sep 12, 2026 10:29:57.123 server (America/New_York, UTC-04:00)',
    ]);
    // The repeated autumn hour reads the same; the tooltip tells the offsets apart.
    expect(out.firstHalf).toBe('Oct 25, 2026 02:30:00.000 local (Europe/Paris, UTC+02:00)');
    expect(out.secondHalf).toBe('Oct 25, 2026 02:30:00.000 local (Europe/Paris, UTC+01:00)');
    expect(out.spring).toBe('Mar 29 01:30 → 03:30');
    expect(out.short).toBe('Sep 12 16:29:57 → 16:34:57');
    expect(out.preset).toBe('Last 1 hour');
  });
});
