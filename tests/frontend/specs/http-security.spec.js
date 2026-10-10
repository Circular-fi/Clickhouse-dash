import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';

// The security headers (docs/operations.md, "HTTP security"): every page carries a Content-Security-Policy whose
// script-src lists the hash of each inline script of its shell, cannot be framed, and never sniffs a type. Each page
// opens, starts its controller and runs its WebAssembly kernels without one violation of that policy.

const PAGES = [
  '/', '/explorer/catalog', '/explorer/functions', '/system', '/system/queries', '/system/disks',
  '/observability/traces', '/observability/logs', '/observability/metrics', '/mcp-integration',
];

async function watchViolations(page) {
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push(`${event.violatedDirective} ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`);
    });
  });
}

for (const path of PAGES) {
  test(`${path} runs under its Content-Security-Policy`, async ({ page }) => {
    await watchViolations(page);
    const observers = installObservers(page);
    const response = await page.goto(path);
    expect(response.status()).toBe(200);
    const headers = response.headers();
    const policy = headers['content-security-policy'] || '';
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toMatch(/script-src 'self' 'wasm-unsafe-eval'( 'sha256-[A-Za-z0-9+/=]+')+;/);
    expect(policy).not.toContain("'unsafe-eval'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('same-origin');
    await page.waitForFunction(() => !!(window.ChDash?.features && window.ChDash?.api && window.ChDash?.header));
    await page.waitForLoadState('networkidle');
    const violations = await page.evaluate(() => window.__cspViolations);
    expect(violations).toEqual([]);
    const blocked = observers.consoleErrors.filter((entry) => /Content Security Policy|Refused to/i.test(entry.text));
    expect(blocked).toEqual([]);
    expect(observers.pageErrors).toEqual([]);
  });
}

test('the WebAssembly kernels compile and run in a Worker under the policy', async ({ page }) => {
  await watchViolations(page);
  await page.goto('/');
  await page.waitForFunction(() => !!(window.ChDash?.wasm && window.ChDash?.loader));
  const outcome = await page.evaluate(async () => {
    const ns = window.ChDash;
    await ns.loader.loadGroup('wasm-highlight');
    const kernel = await ns.wasm.load('highlight');
    const worker = await ns.wasm.worker('highlight', 'app_wasm_highlight.js');
    const here = kernel ? ns.wasm.ops.highlight.run(kernel, { text: 'SELECT 1' }) : null;
    const there = worker ? await worker.call('run', { text: 'SELECT 1' }) : null;
    return { kernel: !!(here && here.html), worker: !!(there && there.html === here.html) };
  });
  expect(outcome).toEqual({ kernel: true, worker: true });
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
});

test('an inline script that the shell does not carry is refused', async ({ page }) => {
  await watchViolations(page);
  await page.goto('/');
  await page.waitForFunction(() => !!window.ChDash?.header);
  const ran = await page.evaluate(() => {
    window.__injected = false;
    const script = document.createElement('script');
    script.textContent = 'window.__injected = true;';
    document.body.appendChild(script);
    return window.__injected;
  });
  expect(ran).toBe(false);
  expect((await page.evaluate(() => window.__cspViolations)).some((line) => line.startsWith('script-src'))).toBe(true);
});
