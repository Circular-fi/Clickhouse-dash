import { test, expect } from '@playwright/test';
import { installLeakTracker, leakDiff, leakStats } from '../helpers/leaks.js';

// The leak tracker (helpers/leaks.js) is what ui-layers.spec.js trusts: a view that leaves a listener, an
// observer, a timer or a channel behind is seen only if the tracker sees each kind. This file tests the
// tracker itself: it adds one of each, expects the exact difference, releases them and expects none.

test.beforeEach(async ({ page }) => {
  await installLeakTracker(page);
  await page.goto('/query');
  await expect(page.locator('#runButton')).toBeEnabled();
});

const acquire = (page) => page.evaluate(() => {
  const box = document.createElement('div');
  box.id = 'leakProbe';
  document.body.append(box);
  const fn = () => {};
  const mine = { box, fn, controller: new AbortController() };
  box.addEventListener('click', fn);
  document.addEventListener('keydown', fn);
  window.addEventListener('resize', fn);
  box.addEventListener('mouseenter', fn, { signal: mine.controller.signal });
  mine.media = matchMedia('(min-width: 1px)');
  mine.media.addEventListener('change', fn);
  mine.ro = new ResizeObserver(fn);
  mine.ro.observe(box);
  mine.io = new IntersectionObserver(fn);
  mine.io.observe(box);
  mine.mo = new MutationObserver(fn);
  mine.mo.observe(box, { childList: true });
  mine.timer = setInterval(function probeTick() {}, 1_000_000);
  mine.worker = new Worker('/static/app_wasm_worker.js', { type: 'module' });
  mine.source = new EventSource('/api/hosts/stream');
  mine.channel = new BroadcastChannel('leak-probe');
  window.__probe = mine;
});

const release = (page) => page.evaluate(() => {
  const { box, fn, controller, media, ro, io, mo, timer, worker, source, channel } = window.__probe;
  box.removeEventListener('click', fn);
  document.removeEventListener('keydown', fn);
  window.removeEventListener('resize', fn);
  controller.abort();
  media.removeEventListener('change', fn);
  ro.disconnect();
  io.unobserve(box);
  mo.disconnect();
  clearInterval(timer);
  worker.terminate();
  source.close();
  channel.close();
});

test('the tracker sees a listener, an observer, a timer and a channel, and forgets each one that is released', async ({ page }) => {
  const before = await leakStats(page, true);
  await acquire(page);
  const held = leakDiff(before, await leakStats(page, true));
  expect(held).toEqual({
    'node:DIV#leakProbe:click': 1,
    'node:DIV#leakProbe:mouseenter': 1,
    'global:document:keydown': 1,
    'global:window:resize': 1,
    'global:media:change': 1,
    'observer:ResizeObserver': 1,
    'observer:IntersectionObserver': 1,
    'observer:MutationObserver': 1,
    'interval:probeTick': 1,
    'channel:Worker': 1,
    'channel:EventSource': 1,
    'channel:BroadcastChannel': 1,
  });
  await release(page);
  expect(leakDiff(before, await leakStats(page, true))).toEqual({});
});

test('a { once } listener that fired and a node that left the document are not leaks', async ({ page }) => {
  const before = await leakStats(page, true);
  await page.evaluate(() => {
    const box = document.createElement('div');
    box.id = 'leakOnce';
    document.body.append(box);
    box.addEventListener('click', () => {}, { once: true });
    const gone = document.createElement('div');
    document.body.append(gone);
    gone.addEventListener('click', () => {});
    new ResizeObserver(() => {}).observe(gone);
    gone.remove();
    box.click();
  });
  expect(leakDiff(before, await leakStats(page, true))).toEqual({});
});

test('a duplicate add is one listener, as in the DOM', async ({ page }) => {
  const before = await leakStats(page, true);
  await page.evaluate(() => {
    const fn = () => {};
    for (let i = 0; i < 5; i += 1) document.addEventListener('keyup', fn);
    window.__fn = fn;
  });
  expect(leakDiff(before, await leakStats(page, true))).toEqual({ 'global:document:keyup': 1 });
  await page.evaluate(() => document.removeEventListener('keyup', window.__fn));
  expect(leakDiff(before, await leakStats(page, true))).toEqual({});
});
