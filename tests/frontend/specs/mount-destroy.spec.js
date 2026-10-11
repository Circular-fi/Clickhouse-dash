import { test, expect } from '@playwright/test';
import { appReady } from '../helpers/modules.js';

// What a component installs when it mounts goes with its destroy() (ARCH-F-109): the graph kit (canvas listeners, toolbar,
// observers, live region) and the Explorer treemap (map listeners, tooltip, observers). A consumer that mounts again
// (a view that opens twice) does not leave the first mount behind.

test('graphKit.mount().destroy() removes the listeners, the observers and the live region of the mount', async ({ page }) => {
  await page.goto('/explorer/catalog');
  await appReady(page);
  const out = await page.evaluate(() => {
    const kit = window.ChDash.graphKit;
    const pane = document.createElement('div');
    pane.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px';
    const canvas = document.createElement('canvas');
    const zoomIn = document.createElement('button');
    pane.append(canvas, zoomIn);
    document.body.append(pane);
    const calls = { wheel: 0, key: 0, zoomIn: 0, draws: 0 };
    const view = { scale: 1, offsetX: 0, offsetY: 0 };
    const ctl = kit.mount({
      canvas,
      view,
      draw: () => { calls.draws += 1; return false; },
      bounds: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      fit: () => {},
      hit: () => null,
      nodes: () => [],
      toolbar: { zoomIn },
      onViewChange: () => { calls.wheel += 1; },
    });
    const liveBefore = pane.querySelectorAll('p[aria-live]').length;
    const press = () => {
      zoomIn.click();
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: 10, clientY: 10, cancelable: true }));
    };
    const scaleBefore = view.scale;
    press();
    const scaleAfterFirst = view.scale;
    ctl.destroy();
    const scale = view.scale;
    press();
    const result = {
      liveBefore,
      liveAfter: pane.querySelectorAll('p[aria-live]').length,
      zoomedBefore: scaleAfterFirst !== scaleBefore,
      zoomedAfterDestroy: view.scale !== scale,
      canvasClass: canvas.classList.contains('graphKit__canvas'),
    };
    pane.remove();
    return result;
  });
  // The kit makes no live region of its own: what the keyboard reaches is said through uiState.announce.
  expect(out.liveBefore).toBe(0);
  expect(out.liveAfter).toBe(0);
  expect(out.zoomedBefore).toBe(true);
  expect(out.zoomedAfterDestroy).toBe(false);
  expect(out.canvasClass).toBe(false);
});

test('explorerTreemap.mount().destroy() removes the tooltip and the listeners of the map', async ({ page }) => {
  await page.goto('/explorer/catalog');
  await appReady(page);
  const out = await page.evaluate(async () => {
    await window.ChDash.loader.loadGroup('wasm-treemap').catch(() => {});
    const treemap = window.ChDash.explorerTreemap;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:200px';
    document.body.append(host);
    const opened = [];
    const ctl = treemap.mount(host, { onOpen: (target) => opened.push(target.name) });
    ctl.setTree({ kind: 'server', name: 'all', bytes: 300, children: [
      { kind: 'database', name: 'a', path: 'a', database: 'a', bytes: 200, count: 1 },
      { kind: 'database', name: 'b', path: 'b', database: 'b', bytes: 100, count: 1 },
    ] }, { name: 'all' });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const node = host.querySelector('.explorerTreemap__node[data-path]');
    const tipBefore = host.querySelectorAll('.explorerTreemap__tooltip').length;
    node.click();
    const clicksBefore = opened.length;
    ctl.destroy();
    node.click();
    const out = { tipBefore, tipAfter: host.querySelectorAll('.explorerTreemap__tooltip').length, clicksBefore, clicksAfter: opened.length };
    host.remove();
    return out;
  });
  expect(out.tipBefore).toBe(1);
  expect(out.tipAfter).toBe(0);
  expect(out.clicksBefore).toBe(1);
  expect(out.clicksAfter).toBe(1);
});
