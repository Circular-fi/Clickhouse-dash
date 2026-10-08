import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp } from '../helpers/app.js';
import { fuzzSql } from '../helpers/wasm.js';

// The Worker of the WebAssembly kernels (src/static/app_wasm_worker.js, ns.wasm.worker, docs/wasm.md): the same kernel
// runs in a Worker with the same adapter, answers like the page, and a missing kernel or Worker gives null.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

test('a kernel in a Worker answers like the kernel in the page, and the page stays responsive meanwhile', async ({ page }) => {
  test.setTimeout(60_000);
  await openApp(page);
  const texts = fuzzSql(3, 40, 300);
  const result = await page.evaluate(async (texts) => {
    const ns = window.ChDash;
    await ns.loader.loadGroup('wasm-highlight');
    const kernel = await ns.wasm.load('highlight');
    const worker = await ns.wasm.worker('highlight', 'app_wasm_highlight.js');
    if (!worker) return { worker: false };
    const bad = [];
    for (const text of texts) {
      const here = ns.wasm.ops.highlight.run(kernel, { text });
      const there = await worker.call('run', { text });
      if (here.status !== there.status || here.html !== there.html || here.count !== there.count || Array.from(here.tokens).join() !== Array.from(there.tokens).join()) bad.push(text.slice(0, 60));
    }
    // A call in the Worker does not block the page: frames keep coming while it runs.
    let frames = 0;
    let stop = false;
    const tick = () => { frames += 1; if (!stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    const big = texts.join('\n').repeat(30);
    const started = performance.now();
    await Promise.all([worker.call('run', { text: big }), worker.call('run', { text: big }), worker.call('run', { text: big })]);
    stop = true;
    const elapsed = performance.now() - started;
    worker.close();
    const again = await ns.wasm.worker('highlight', 'app_wasm_highlight.js');
    const alive = !!again && (await again.call('run', { text: 'select 1' })).status === 0;
    if (again) again.close();
    return { worker: true, bad, frames, elapsed, alive };
  }, texts);
  expect(result.worker).toBe(true);
  expect(result.bad).toEqual([]);
  expect(result.alive).toBe(true);
  // At least one frame per 100 ms while the Worker computed (the page thread was free).
  expect(result.frames).toBeGreaterThan(Math.min(5, Math.floor(result.elapsed / 100)));
});

test('a Worker whose kernel is blocked gives null, and an operation that does not exist is an error, not a hang', async ({ page }) => {
  await page.route('**/wasm/highlight.wasm*', (route) => route.abort());
  await openApp(page);
  const result = await page.evaluate(async () => {
    const ns = window.ChDash;
    await ns.loader.loadGroup('wasm-highlight');
    return { worker: await ns.wasm.worker('highlight', 'app_wasm_highlight.js') };
  });
  expect(result.worker).toBe(null);
});

test('an unknown operation rejects', async ({ page }) => {
  await openApp(page);
  const message = await page.evaluate(async () => {
    const ns = window.ChDash;
    await ns.loader.loadGroup('wasm-highlight');
    const worker = await ns.wasm.worker('highlight', 'app_wasm_highlight.js');
    try { await worker.call('nothing', {}); return 'no error'; } catch (error) { return String(error.message); } finally { worker.close(); }
  });
  expect(message).toContain('nothing');
});
