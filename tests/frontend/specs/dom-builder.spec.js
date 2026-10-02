import { test, expect } from '@playwright/test';

// ns.h, the one element builder, and the dom.byId / dom.$ / dom.$$ lookups
// (src/static/app_dom.js, docs/ui-foundations.md "Building elements"): unit
// checks in a real page. Strings are always text, props cover class, dataset,
// style, aria, events with a lifecycle signal and attributes, h.html is the
// only markup path, and the lookups stay inside their root.

const PAGES = ['/query', '/explorer', '/observability/traces'];

async function open(page, path) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto(path);
  await page.waitForFunction(() => !!(window.ChDash?.h && window.ChDash?.dom?.byId));
  return errors;
}

for (const path of PAGES) {
  test(`dom builder: ns.h and the lookups load on ${path}`, async ({ page }) => {
    const errors = await open(page, path);
    const api = await page.evaluate(() => ({
      h: typeof window.ChDash.h,
      parts: ['svg', 'frag', 'html', 'replace'].map((name) => typeof window.ChDash.h[name]),
      lookups: ['byId', '$', '$$'].map((name) => typeof window.ChDash.dom[name]),
      frozen: Object.isFrozen(window.ChDash.h),
    }));
    expect(api).toEqual({ h: 'function', parts: ['function', 'function', 'function', 'function'], lookups: ['function', 'function', 'function'], frozen: true });
    expect(errors).toEqual([]);
  });
}

test('dom builder: children are text, never markup', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(() => {
    const { h } = window.ChDash;
    const hostile = '<img src=x onerror="window.__pwned=1">"\'&';
    const el = h('div', { title: hostile, 'data-x': hostile }, hostile, 42, 0, 10n, null, undefined, false, true, '', ['a', ['b', null]]);
    document.body.appendChild(el);
    const res = {
      html: el.innerHTML,
      text: el.textContent,
      title: el.getAttribute('title'),
      data: el.dataset.x,
      images: el.querySelectorAll('img').length,
      childNodes: el.childNodes.length,
    };
    el.remove();
    return res;
  });
  expect(out.text).toBe('<img src=x onerror="window.__pwned=1">"\'&42010ab');
  expect(out.html).toBe('&lt;img src=x onerror="window.__pwned=1"&gt;"\'&amp;42010ab');
  expect(out.title).toBe('<img src=x onerror="window.__pwned=1">"\'&');
  expect(out.data).toBe(out.title);
  expect(out.images).toBe(0);
  // null, undefined, false, true and "" add nothing; arrays flatten.
  expect(out.childNodes).toBe(6);
  await page.waitForTimeout(50);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('dom builder: class, dataset, style, aria and attributes', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(() => {
    const { h } = window.ChDash;
    const a = h('span', { class: 'one two' });
    const b = h('span', { class: ['one', null, false, ['two', '', 'three']] });
    const c = h('span', { class: { one: true, two: false, three: 1 } });
    const none = h('span', { class: ['', null] });
    const d = h('button', {
      type: 'button',
      dataset: { spanId: 'abc', flag: true, off: false, gone: null },
      style: { left: '10px', '--trace-service-color': 'red', width: null },
      aria: { label: 'Close', pressed: false },
      'aria-expanded': false,
      hidden: true,
      disabled: false,
      title: null,
      tabIndex: -1,
      htmlFor: 'x',
    });
    const s = h('div', { style: 'color: red; top: 1px' });
    const input = h('input', { type: 'checkbox', checked: true, value: 'v' });
    const select = h('select', { value: 'b' }, h('option', { value: 'a' }, 'A'), h('option', { value: 'b' }, 'B'));
    const link = h('a', { href: ' javascript:alert(1)' }, 'x');
    const safe = h('a', { href: '/observability/traces/abc?span=1' }, 'y');
    return {
      a: a.className, b: b.className, c: c.className, none: none.hasAttribute('class'),
      data: { ...d.dataset },
      left: d.style.left, color: d.style.getPropertyValue('--trace-service-color'), width: d.style.width,
      label: d.getAttribute('aria-label'), pressed: d.getAttribute('aria-pressed'), expanded: d.getAttribute('aria-expanded'),
      hidden: d.hidden, disabledAttr: d.hasAttribute('disabled'), titleAttr: d.hasAttribute('title'),
      tabindex: d.getAttribute('tabindex'), forAttr: d.getAttribute('for'), type: d.type,
      style: s.getAttribute('style'),
      checked: input.checked, value: input.value,
      selected: select.value,
      link: link.getAttribute('href'), safe: safe.getAttribute('href'),
    };
  });
  expect(out).toEqual({
    a: 'one two', b: 'one two three', c: 'one three', none: false,
    data: { spanId: 'abc', flag: '' },
    left: '10px', color: 'red', width: '',
    label: 'Close', pressed: 'false', expanded: 'false',
    hidden: true, disabledAttr: false, titleAttr: false,
    tabindex: '-1', forAttr: 'x', type: 'button',
    style: 'color: red; top: 1px',
    checked: true, value: 'v',
    selected: 'b',
    link: 'about:blank', safe: '/observability/traces/abc?span=1',
  });
});

test('dom builder: events, with a lifecycle signal that removes them', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(() => {
    const { h, lifecycle } = window.ChDash;
    const calls = [];
    const plain = h('button', { on: { click: (event) => calls.push(`plain:${event.type}`), focus: () => calls.push('focus') } });
    const scope = lifecycle.scope();
    const scoped = h('button', { on: { click: () => calls.push('scoped') }, signal: scope });
    const controller = new AbortController();
    const bySignal = h('button', { on: { click: () => calls.push('signal') }, signal: controller.signal });
    plain.click(); scoped.click(); bySignal.click();
    scope.dispose();
    controller.abort();
    plain.click(); scoped.click(); bySignal.click();
    return { calls, onAttr: plain.hasAttribute('on'), signalAttr: scoped.hasAttribute('signal') };
  });
  expect(out.calls).toEqual(['plain:click', 'scoped', 'signal', 'plain:click']);
  expect(out.onAttr).toBe(false);
  expect(out.signalAttr).toBe(false);
});

test('dom builder: frag, svg, html and replace', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(() => {
    const { h } = window.ChDash;
    const frag = h.frag('a', h('b', null, 'b'), null, ['c']);
    const box = h('div', null, frag);
    const svg = h.svg('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h.svg('path', { d: 'M0 0h4' }));
    const trusted = h('div', null, h.html('<b class="x">bold</b><i>it</i>'));
    const target = h('ul', null, h('li', null, 'old'));
    const returned = h.replace(target, h('li', null, 'one'), ['two', null], h('li', null, 'three'));
    const cleared = h.replace(h('div', null, 'x'));
    const row = h('tbody', null, h.html('<tr><td>1</td></tr>'));
    return {
      frag: box.innerHTML,
      svgNs: svg.namespaceURI, pathNs: svg.firstChild.namespaceURI, viewBox: svg.getAttribute('viewBox'),
      trusted: trusted.innerHTML,
      replaced: target.innerHTML, same: returned === target,
      cleared: cleared.childNodes.length,
      row: row.innerHTML,
      nullReplace: h.replace(null, 'x'),
    };
  });
  expect(out).toEqual({
    frag: 'a<b>b</b>c',
    svgNs: 'http://www.w3.org/2000/svg', pathNs: 'http://www.w3.org/2000/svg', viewBox: '0 0 16 16',
    trusted: '<b class="x">bold</b><i>it</i>',
    replaced: '<li>one</li>two<li>three</li>', same: true,
    cleared: 0,
    row: '<tr><td>1</td></tr>',
    nullReplace: null,
  });
});

test('dom builder: lookups are root-scoped', async ({ page }) => {
  await open(page, '/query');
  const out = await page.evaluate(() => {
    const { h, dom } = window.ChDash;
    const root = h('section', { id: 'pwLookupRoot' }, h('i', { class: 'pwItem' }, '1'), h('i', { class: 'pwItem' }, '2'));
    const other = h('section', null, h('i', { class: 'pwItem' }, 'outside'));
    document.body.append(root, other);
    const res = {
      byId: dom.byId('pwLookupRoot') === root,
      first: dom.$('.pwItem', root).textContent,
      all: dom.$$('.pwItem', root).map((el) => el.textContent),
      isArray: Array.isArray(dom.$$('.pwItem', root)),
      page: dom.$$('.pwItem').length,
      pageFirst: dom.$('.pwItem').textContent,
      nullRoot: dom.$('.pwItem', null),
      undefinedRoot: dom.$('.pwItem', undefined),
      nullAll: dom.$$('.pwItem', null),
      missing: dom.byId('pwNoSuchId'),
    };
    root.remove(); other.remove();
    return res;
  });
  expect(out).toEqual({
    byId: true, first: '1', all: ['1', '2'], isArray: true, page: 3, pageFirst: '1',
    nullRoot: null, undefinedRoot: null, nullAll: [], missing: null,
  });
});
