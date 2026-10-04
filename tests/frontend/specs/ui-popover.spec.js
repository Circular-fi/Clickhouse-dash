import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';

// ns.popover (app_ui_popover.js): one placement (place: flipped, kept 8 px
// inside the viewport), one tooltip (.uiTip, role=tooltip, never a live
// region on hover), one click-opened popover shell (.uiPopover, an
// ns.layers layer) and the "Copied" flash (role=status).

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

async function ready(page, path = '/explorer') {
  await page.goto(path);
  await page.waitForFunction(() => window.ChDash?.popover && window.ChDash?.layers);
}

for (const theme of ['dark', 'light']) {
  for (const width of [0, 390]) {
    test.describe(`ns.popover (${theme}${width ? `, ${width} px` : ''})`, () => {
      test.use({ colorScheme: theme, ...(width ? { viewport: { width, height: 800 } } : {}) });

      test('place() puts the element beside its anchor, flips it and keeps it inside the viewport', async ({ page }) => {
        await ready(page);
        const out = await page.evaluate(() => {
          const make = (style) => { const el = document.createElement('div'); el.style.cssText = `position:fixed;${style}`; document.body.appendChild(el); return el; };
          const box = make('width:200px;height:100px;');
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const P = window.ChDash.popover;
          const below = P.place({ left: 100, top: 100, right: 140, bottom: 120 }, box, { side: 'bottom', align: 'start', offset: 6 });
          const flipped = P.place({ left: 100, top: vh - 30, right: 140, bottom: vh - 10 }, box, { side: 'bottom' });
          const clampedRight = P.place({ x: vw - 4, y: 200 }, box, { side: 'bottom', align: 'start' });
          const clampedLeft = P.place({ x: 2, y: 200 }, box, { side: 'bottom', align: 'end' });
          const right = P.place({ left: 10, top: 300, right: 50, bottom: 320 }, box, { side: 'right', align: 'center', offset: 4 });
          const rect = box.getBoundingClientRect();
          box.remove();
          return { below, flipped, clampedRight, clampedLeft, right, vw, vh, last: { left: rect.left, top: rect.top } };
        });
        expect(out.below).toMatchObject({ left: 100, top: 126, side: 'bottom' });
        expect(out.flipped.side).toBe('top');
        expect(out.flipped.top).toBe(out.vh - 30 - 6 - 100);
        expect(out.clampedRight.left).toBe(out.vw - 200 - 8);
        expect(out.clampedLeft.left).toBe(8);
        expect(out.right).toMatchObject({ left: 54, top: 260, side: 'right' });
        expect(out.last).toEqual({ left: 54, top: 260 });
      });

      test('tip() shows one role=tooltip tip on hover and focus, named by aria-describedby; Escape hides it', async ({ page }) => {
        await ready(page);
        await page.evaluate(() => {
          const wrap = document.createElement('div');
          wrap.id = 'tipHost';
          wrap.style.cssText = 'position:fixed;left:40px;top:300px;z-index:2000;display:flex;gap:20px';
          wrap.innerHTML = '<button id="tipA" data-tip="Alpha">A</button><button id="tipB" data-tip="Beta">B</button>';
          document.body.appendChild(wrap);
          window.ChDash.popover.tip(wrap, (target) => target.dataset.tip, { selector: '[data-tip]' });
        });
        const tip = page.locator('.uiTip#uiTip');
        await page.locator('#tipA').hover();
        await expect(tip).toBeVisible();
        await expect(tip).toHaveText('Alpha');
        await expect(tip).toHaveAttribute('role', 'tooltip');
        await expect(page.locator('#tipA')).toHaveAttribute('aria-describedby', 'uiTip');
        // Above its target, inside the viewport.
        const [tipBox, targetBox] = await Promise.all([tip.boundingBox(), page.locator('#tipA').boundingBox()]);
        expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(targetBox.y);
        await page.locator('#tipB').hover();
        await expect(tip).toHaveText('Beta');
        await expect(page.locator('#tipA')).not.toHaveAttribute('aria-describedby', /uiTip/);
        await page.mouse.move(5, 5);
        await expect(tip).toBeHidden();
        await page.locator('#tipA').focus();
        await expect(tip).toHaveText('Alpha');
        await page.keyboard.press('Escape');
        await expect(tip).toBeHidden();
        // One shared tip (a treemap on the page keeps its own pointer tip, ns.popover.follow).
        expect(await page.locator('.uiTip:not([data-treemap-tooltip])').count()).toBe(1);
      });

      test('open() is a layer: Escape closes it and the focus goes back to its anchor; a press outside or a scroll that moves its anchor closes it', async ({ page }) => {
        await ready(page);
        await page.evaluate(() => {
          const anchor = document.createElement('button');
          anchor.id = 'popAnchor';
          anchor.textContent = 'Open';
          anchor.setAttribute('aria-haspopup', 'dialog');
          anchor.style.cssText = 'position:fixed;left:40px;top:200px;z-index:2000';
          document.body.appendChild(anchor);
          window.__closed = 0;
          anchor.addEventListener('click', () => {
            window.__pop = window.ChDash.popover.open(anchor, '<button id="popInner">Inner</button>', {
              label: 'Scratch', onClose: () => { window.__closed += 1; }, focus: (el) => el.querySelector('#popInner'),
            });
          });
        });
        const anchor = page.locator('#popAnchor');
        await anchor.click();
        const pop = page.locator('.uiPopover[aria-label="Scratch"]');
        await expect(pop).toBeVisible();
        await expect(pop).toHaveAttribute('role', 'dialog');
        await expect(anchor).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#popInner')).toBeFocused();
        const [popBox, anchorBox] = await Promise.all([pop.boundingBox(), anchor.boundingBox()]);
        expect(Math.round(popBox.y)).toBe(Math.round(anchorBox.y + anchorBox.height + 6));
        await page.keyboard.press('Escape');
        await expect(pop).toHaveCount(0);
        await expect(anchor).toBeFocused();
        await expect(anchor).toHaveAttribute('aria-expanded', 'false');
        await anchor.click();
        await expect(pop).toBeVisible();
        await page.mouse.click(5, 600);
        await expect(pop).toHaveCount(0);
        await anchor.click();
        await expect(pop).toBeVisible();
        // A scroll event that leaves the anchor in place (the one of a scroll
        // made before opening) keeps it; one that moves the anchor closes it.
        await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await expect(pop).toBeVisible();
        await page.evaluate(() => { document.getElementById('popAnchor').style.top = '160px'; window.dispatchEvent(new Event('scroll')); });
        await expect(pop).toHaveCount(0);
        expect(await page.evaluate(() => ({ closed: window.__closed, layers: window.ChDash.layers.size() }))).toEqual({ closed: 3, layers: 0 });
      });

      test('flash() confirms beside its button in a status region', async ({ page }) => {
        await ready(page);
        await page.evaluate(() => {
          const button = document.createElement('button');
          button.id = 'flashButton';
          button.textContent = 'Copy';
          button.style.cssText = 'position:fixed;left:200px;top:300px;z-index:2000';
          document.body.appendChild(button);
          window.ChDash.popover.flash(button, 'Copied');
        });
        const flash = page.locator('.uiTip--flash');
        await expect(flash).toHaveText('Copied');
        await expect(flash).toHaveAttribute('role', 'status');
        await expect(flash).toHaveCount(0, { timeout: 3000 });
      });
    });
  }
}
