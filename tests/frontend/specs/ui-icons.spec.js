import { test, expect } from '@playwright/test';

// Icons (docs/ui-foundations.md, "Icons"): one sprite, static/icons.svg?v=<hash>,
// drawn through <svg class="icon"><use href="...#i-name"/></svg> (ns.icon), and
// the logo mark before "ClickHouse Dash" in the header of every page.

const PAGES = [
  { name: 'query', path: '/query', ready: '#runButton' },
  { name: 'explorer', path: '/explorer/chdash_ui/weather_observations?mode=graph&graph=lineage&depth=1', ready: '#explorerGraphFitButton' },
  { name: 'traces', path: '/observability/traces', ready: '#tracesForm' },
];

async function open(page, { path, ready }) {
  await page.goto(path);
  await expect(page.locator(ready)).toBeVisible({ timeout: 15_000 });
}

// Every visible sprite icon: its box, the symbol it names, and whether the browser drew it
// (the <use> has a box only once the sprite has loaded and holds the symbol).
async function visibleIcons(page) {
  return page.evaluate(() => [...document.querySelectorAll('svg.icon')].filter((svg) => {
    const box = svg.getBoundingClientRect();
    const style = getComputedStyle(svg);
    return style.display !== 'none' && style.visibility !== 'hidden' && box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth
      && svg.checkVisibility?.() !== false;
  }).map((svg) => {
    const box = svg.getBoundingClientRect();
    const use = svg.querySelector('use');
    let drawn = 0;
    try { const b = use.getBBox(); drawn = b.width + b.height; } catch { drawn = 0; }
    return { href: use?.getAttribute('href') || '', w: box.width, h: box.height, drawn, cls: svg.getAttribute('class') };
  }));
}

test('the icon sprite is served as SVG, cached for good under its hash, and holds every icon a page names', async ({ page, request }) => {
  await open(page, PAGES[0]);
  const url = await page.evaluate(() => window.__chdashIconSprite);
  expect(url).toMatch(/^\/static\/icons\.svg\?v=[0-9a-f]{10}$/);
  const response = await request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toMatch(/^image\/svg\+xml/);
  expect(response.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  const ids = new Set([...(await response.text()).matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  expect(ids.size).toBeGreaterThanOrEqual(40);
  for (const spec of PAGES) {
    if (spec !== PAGES[0]) await open(page, spec);
    const hrefs = await page.evaluate(() => [...document.querySelectorAll('svg.icon use')].map((use) => use.getAttribute('href')));
    expect(hrefs.length, spec.name).toBeGreaterThan(5);
    for (const href of hrefs) {
      expect(href.startsWith(`${url}#`), href).toBe(true);
      expect(ids.has(href.slice(href.indexOf('#') + 1)), href).toBe(true);
    }
  }
});

for (const spec of PAGES) {
  test(`${spec.name}: every visible icon is drawn at its size, and icon-only buttons have a label and a title`, async ({ page }) => {
    await open(page, spec);
    await expect.poll(async () => (await visibleIcons(page)).filter((icon) => icon.drawn === 0).map((icon) => icon.href), { timeout: 10_000 }).toEqual([]);
    const icons = await visibleIcons(page);
    expect(icons.length).toBeGreaterThan(3);
    for (const icon of icons) {
      const size = /icon--sm/.test(icon.cls) ? 14 : /icon--lg/.test(icon.cls) ? 18 : 16;
      expect(icon.w, icon.href).toBeGreaterThan(0);
      expect(icon.h, icon.href).toBeGreaterThan(0);
      if (!/icon--disclosure/.test(icon.cls)) expect(Math.round(icon.h), `${icon.cls} ${icon.href}`).toBe(size);
    }
    const unlabelled = await page.evaluate(() => [...document.querySelectorAll('button')].filter((button) => {
      if (!button.querySelector('svg.icon') || button.textContent.trim() || !button.checkVisibility()) return false;
      return !(button.getAttribute('aria-label') || button.getAttribute('aria-labelledby')) || !button.getAttribute('title');
    }).map((button) => button.id || button.className));
    expect(unlabelled).toEqual([]);
  });
}

for (const width of [1440, 390, 360]) {
  for (const theme of ['dark', 'light']) {
    test.describe(`header logo at ${width} (${theme})`, () => {
      test.use({ viewport: { width, height: width > 1000 ? 900 : 780 }, colorScheme: theme });
      test(`the logo mark is visible before the name, in the accent fill, and the header does not overflow at ${width} ${theme}`, async ({ page }, testInfo) => {
        test.skip(testInfo.project.name !== 'desktop-1440', 'the viewport is set here');
        await open(page, PAGES[0]);
        const logo = page.locator('.appHeader .appBrand__logo');
        await expect(logo).toBeVisible();
        const state = await page.evaluate(() => {
          const mark = document.querySelector('.appBrand__logo');
          const name = document.querySelector('.appBrand__name');
          const header = document.querySelector('.appHeader');
          const box = mark.getBoundingClientRect();
          const probe = document.createElement('i');
          probe.style.color = 'var(--accent-fill)';
          document.body.appendChild(probe);
          const accent = getComputedStyle(probe).color;
          probe.remove();
          return {
            w: box.width, h: box.height, beforeName: box.right <= name.getBoundingClientRect().left,
            centred: Math.abs((box.top + box.bottom) / 2 - (name.getBoundingClientRect().top + name.getBoundingClientRect().bottom) / 2) <= 2,
            fill: getComputedStyle(mark.querySelector('rect')).fill, accent,
            overflow: Math.max(header.scrollWidth - header.clientWidth, document.documentElement.scrollWidth - innerWidth),
            rightEdge: Math.max(...[...header.querySelectorAll('*')].map((el) => el.getBoundingClientRect().right)) - innerWidth,
          };
        });
        expect(state).toMatchObject({ w: 18, h: 18, beforeName: true, centred: true, overflow: 0 });
        expect(state.fill).toBe(state.accent);
        expect(state.rightEdge).toBeLessThanOrEqual(0);
      });
    });
  }
}
