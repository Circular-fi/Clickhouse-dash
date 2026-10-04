import { expect } from '@playwright/test';

// Shared checks of the canvas graph kit (app_graph_kit.js), used by the
// Explorer graph and the Traces service map specs: both graphs expose an
// inspect() hook with the last drawn frame in client coordinates.

// Waits until the kit camera animation (recentring, eased over 220 ms) is over.
export async function cameraIdle(page, hook) {
  await expect.poll(() => page.evaluate((name) => name.split('.').reduce((o, k) => o[k], window).inspect().animating, hook), { timeout: 5000 }).toBe(false);
}

export const settle = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

export function overlaps(a, b, padding = 0) {
  return !(a.x + a.width + padding <= b.x || b.x + b.width + padding <= a.x
    || a.y + a.height + padding <= b.y || b.y + b.height + padding <= a.y);
}

function luminance([r, g, b]) {
  const [x, y, z] = [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * x + 0.7152 * y + 0.0722 * z;
}

export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// Resolved colours of CSS custom properties, as [r, g, b, alpha].
export async function tokenColors(page, names) {
  return page.evaluate((list) => {
    const probe = document.createElement('div');
    document.body.append(probe);
    const out = {};
    for (const name of list) {
      probe.style.color = `var(${name})`;
      const parts = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
      // [r, g, b, alpha] (alpha 1 when opaque).
      out[name] = [...parts.slice(0, 3), parts.length > 3 ? parts[3] : 1];
    }
    probe.remove();
    return out;
  }, names);
}

// RGBA of a canvas pixel at client coordinates.
export async function pixel(page, canvasSelector, x, y) {
  return page.evaluate(({ selector, x, y }) => {
    const canvas = document.querySelector(selector);
    const box = canvas.getBoundingClientRect();
    const dpr = canvas.width / box.width;
    return [...canvas.getContext('2d').getImageData(Math.round((x - box.left) * dpr), Math.round((y - box.top) * dpr), 1, 1).data];
  }, { selector: canvasSelector, x, y });
}

export const colorDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// The dot grid: in an empty square of the canvas the background is
// --graph-bg and the dots repeat every gridSpacing pixels.
export async function expectDotGrid(page, canvasSelector, state, bgColor) {
  const canvas = await page.locator(canvasSelector).boundingBox();
  const spacing = state.gridSpacing;
  const busy = [...state.nodes, ...(state.edgeLabels || [])].map((r) => ({ x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 }));
  for (const edge of state.edges || []) {
    for (let i = 1; i < (edge.points || []).length; i += 1) {
      const a = edge.points[i - 1];
      const b = edge.points[i];
      busy.push({ x: Math.min(a.x, b.x) - 8, y: Math.min(a.y, b.y) - 8, width: Math.abs(a.x - b.x) + 16, height: Math.abs(a.y - b.y) + 16 });
    }
  }
  let square = null;
  for (let y = canvas.y + 70; y + spacing * 2 < canvas.y + canvas.height && !square; y += spacing) {
    for (let x = canvas.x + 10; x + spacing * 2 < canvas.x + canvas.width; x += spacing) {
      const candidate = { x, y, width: spacing * 2, height: spacing * 2 };
      if (!busy.some((rect) => overlaps(candidate, rect))) { square = candidate; break; }
    }
  }
  expect(square, 'an empty square of the canvas').toBeTruthy();
  const samples = await page.evaluate(({ selector, square }) => {
    const canvas = document.querySelector(selector);
    const box = canvas.getBoundingClientRect();
    const dpr = canvas.width / box.width;
    const data = canvas.getContext('2d').getImageData(Math.round((square.x - box.left) * dpr), Math.round((square.y - box.top) * dpr), Math.round(square.width * dpr), Math.round(square.height * dpr));
    return { width: data.width, height: data.height, data: [...data.data], dpr };
  }, { selector: canvasSelector, square });
  const at = (x, y) => samples.data.slice((y * samples.width + x) * 4, (y * samples.width + x) * 4 + 3);
  let background = 0;
  const dots = [];
  for (let y = 0; y < samples.height; y += 1) {
    for (let x = 0; x < samples.width; x += 1) {
      if (colorDistance(at(x, y), bgColor) < 3) background += 1;
      else dots.push({ x, y });
    }
  }
  expect(background / (samples.width * samples.height), 'background colour is --graph-bg').toBeGreaterThan(0.9);
  expect(dots.length, 'grid dots are drawn').toBeGreaterThan(0);
  // Every dot pixel has a twin one grid step away (the pattern repeats).
  const step = Math.round(spacing * samples.dpr);
  const repeated = dots.filter((d) => d.x + step < samples.width && dots.some((e) => e.x === d.x + step && e.y === d.y));
  expect(repeated.length, `dots repeat every ${spacing} px`).toBeGreaterThan(0);
}

// The shared chrome: icon toolbar (- fit +), legend and status line
// bottom-left, the minimap bottom-right.
export async function expectKitChrome(page, { pane, zoomOut, fit, zoomIn, legend, status }) {
  const paneBox = await page.locator(pane).boundingBox();
  for (const [selector, label] of [[zoomOut, /zoom out/i], [fit, /fit/i], [zoomIn, /zoom in/i]]) {
    const button = page.locator(selector);
    await expect(button).toBeVisible();
    await expect(button).toHaveClass(/graphKitTool/);
    await expect(button).toHaveAttribute('aria-label', label);
  }
  await expect(page.locator(fit).locator('svg')).toHaveCount(1);
  const order = await Promise.all([zoomOut, fit, zoomIn].map(async (s) => (await page.locator(s).boundingBox()).x));
  expect(order[0]).toBeLessThan(order[1]);
  expect(order[1]).toBeLessThan(order[2]);
  const statusBox = await page.locator(status).boundingBox();
  // The legend folds from a button at the start of the status line (a fit
  // folds it when the graph is only readable without it).
  const toggle = page.locator(`${status} .graphKitLegendToggle`);
  await expect(toggle).toBeVisible();
  const folded = (await toggle.getAttribute('aria-expanded')) === 'false';
  await expect(toggle).toHaveAttribute('aria-label', folded ? /show the legend/i : /hide the legend/i);
  if (folded) {
    await expect(page.locator(legend)).toBeHidden();
  } else {
    const legendBox = await page.locator(legend).boundingBox();
    // Bottom-left: the legend above the status line, both at the left edge.
    expect(legendBox.x - paneBox.x).toBeLessThan(20);
    expect(paneBox.y + paneBox.height - (legendBox.y + legendBox.height)).toBeLessThan(60);
    expect(legendBox.y + legendBox.height).toBeLessThanOrEqual(statusBox.y + 1);
  }
  expect(statusBox.x - paneBox.x).toBeLessThan(20);
  expect(paneBox.y + paneBox.height - (statusBox.y + statusBox.height)).toBeLessThan(16);
}

// The kit's safe area of a graph canvas (graphKit.safeArea: below the
// toolbar, above the legend / status dock, beside an open panel) in client
// coordinates.
export async function freeArea(page, canvasSelector, panelSelector = null) {
  return page.evaluate(({ canvasSelector, panelSelector }) => {
    const canvas = document.querySelector(canvasSelector);
    const panel = panelSelector ? document.querySelector(panelSelector) : null;
    const rect = canvas.getBoundingClientRect();
    const area = window.ChDash.graphKit.safeArea(canvas, { panel: panel && !panel.hidden ? panel.getBoundingClientRect() : null });
    return { x: rect.left + area.x, y: rect.top + area.y, width: area.width, height: area.height };
  }, { canvasSelector, panelSelector });
}

// Fit shows the whole graph (kit.fitScale): every card inside the free area
// (below the toolbar, above the legend / status dock, beside an open panel),
// none clipped, so no minimap; a minimap shown anyway covers no card.
export async function expectFullFit(page, { canvas, minimap, panel = null }, state) {
  const free = await freeArea(page, canvas, panel);
  expect(state.nodes.length, 'cards drawn').toBeGreaterThan(0);
  for (const node of state.nodes) {
    const id = node.id || node.label || node.service || node.name;
    expect(node.x, `${id} left`).toBeGreaterThanOrEqual(free.x - 0.5);
    expect(node.y, `${id} top`).toBeGreaterThanOrEqual(free.y - 0.5);
    expect(node.x + node.width, `${id} right`).toBeLessThanOrEqual(free.x + free.width + 0.5);
    expect(node.y + node.height, `${id} bottom`).toBeLessThanOrEqual(free.y + free.height + 0.5);
  }
  expect(state.minimapVisible, 'no minimap at Fit').toBe(false);
  const box = await page.locator(minimap).boundingBox();
  if (box) for (const node of state.nodes) expect(overlaps(node, box), 'the minimap covers a card').toBe(false);
}

// The constants of the kit's fit and level of detail (app_graph_kit.js).
export async function kitRules(page) {
  return page.evaluate(() => {
    const k = window.ChDash.graphKit;
    return {
      share: k.FIT_READABLE_SHARE, floor: k.FIT_FLOOR, phoneMin: k.PHONE_MIN_SCALE, phone: k.mobileLayout(),
      cardPx: k.COMPACT_CARD_PX, minTextPx: k.MIN_TEXT_PX,
    };
  });
}

// What a Fit opens at (kit.fitView): a graph readable as a whole opens
// whole; one slightly too large (overview >= FIT_READABLE_SHARE of the
// readable scale) at the readable scale with its anchor (root / focus) in
// the free area and the minimap; a much larger one whole with compact
// cards. A phone opens whole when that keeps PHONE_MIN_SCALE, else on the
// anchor at PHONE_MIN_SCALE or more. Never compact cards at a readable
// open. Returns "whole", "compact" or "anchored".
export async function expectFit(page, { canvas, minimap, panel = null }, state, anchorId) {
  const rules = await kitRules(page);
  const { scale, readableScale: readable, overviewScale: overview } = state;
  const whole = async () => {
    expect(scale, 'opens on the whole graph').toBeCloseTo(overview, 6);
    await expectFullFit(page, { canvas, minimap, panel }, state);
  };
  if (overview >= readable - 1e-6) {
    await whole();
    expect(state.compact, 'readable as a whole: full cards').toBe(false);
    return 'whole';
  }
  if (rules.phone) {
    expect(scale, 'a phone never opens under PHONE_MIN_SCALE').toBeGreaterThanOrEqual(Math.min(readable, rules.phoneMin) - 1e-6);
    expect(state.compact, 'a phone opens on full cards').toBe(false);
    if (overview >= rules.phoneMin - 1e-6) { await whole(); return 'whole'; }
  } else if (overview >= readable * rules.share - 1e-6 || overview < rules.floor - 1e-6) {
    expect(scale, 'slightly too large: the readable scale').toBeCloseTo(readable, 6);
    expect(state.compact, 'the readable scale shows full cards').toBe(false);
  } else {
    await whole();
    return 'compact';
  }
  // The anchor is wholly in the free area; once a card is clipped the minimap
  // gives the rest (a graph only a few pixels too large may still show whole
  // at the readable scale, inside Fit's margin: then no card is clipped).
  if (!state.minimapVisible) await expectFullFit(page, { canvas, minimap, panel }, state);
  const free = await freeArea(page, canvas, panel);
  const node = state.nodes.find((n) => (n.id || n.service) === anchorId);
  expect(node, `${anchorId} is drawn`).toBeTruthy();
  expect(node.x, `${anchorId} left`).toBeGreaterThanOrEqual(free.x - 0.5);
  expect(node.y, `${anchorId} top`).toBeGreaterThanOrEqual(free.y - 0.5);
  expect(node.x + node.width, `${anchorId} right`).toBeLessThanOrEqual(free.x + free.width + 0.5);
  expect(node.y + node.height, `${anchorId} bottom`).toBeLessThanOrEqual(free.y + free.height + 0.5);
  return 'anchored';
}

// Level of detail from the card on screen (kit.isCompact): full cards while
// the ordinary card (cardHeight, world px) is COMPACT_CARD_PX tall or more on
// screen and its smallest text (minFont) MIN_TEXT_PX or more; compact
// cards shrink to their title row, never an empty frame.
export async function expectLevelOfDetail(page, state, { cardHeight, minFont = 12 }) {
  const rules = await kitRules(page);
  const onScreen = cardHeight * state.scale;
  const compact = onScreen < rules.cardPx - 1e-6 || minFont * state.scale < rules.minTextPx - 1e-6;
  expect(state.compact, `compact at ${state.scale.toFixed(3)} (a ${onScreen.toFixed(1)} px card)`).toBe(compact);
  const cards = state.nodes.filter((n) => !['storage_tier', 'ttl_expired'].includes(n.kind));
  for (const node of cards) {
    if (compact) {
      // The title row: 1.3 x the title (8 to 12 px on screen) and 14 px.
      expect(node.height, `${node.id || node.service} shrinks to its title`).toBeLessThan(Math.max(onScreen, 30));
      expect(node.height, `${node.id || node.service} title row`).toBeLessThanOrEqual(12 * 1.3 + 14 + 0.5);
    } else {
      expect(node.height, `${node.id || node.service} full card`).toBeGreaterThanOrEqual(onScreen - 0.5);
    }
  }
  return compact;
}

// Every route owns its lane: no two edges run side by side closer than
// `gap` client px (the kit's LANE_GAP at the current scale) over more than
// a pixel. Lines on the very same coordinate are the shared fan at a port.
export function expectOwnLanes(state, gap) {
  const segments = [];
  for (const edge of state.edges) {
    const points = edge.points || [];
    for (let i = 1; i < points.length; i += 1) segments.push({ id: edge.id, a: points[i - 1], b: points[i] });
  }
  const near = [];
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const s = segments[i];
      const t = segments[j];
      if (s.id === t.id) continue;
      const sv = Math.abs(s.a.x - s.b.x) < 0.01;
      const tv = Math.abs(t.a.x - t.b.x) < 0.01;
      const sh = Math.abs(s.a.y - s.b.y) < 0.01;
      const th = Math.abs(t.a.y - t.b.y) < 0.01;
      let distance;
      let shared;
      if (sv && tv && !(sh || th)) {
        distance = Math.abs(s.a.x - t.a.x);
        shared = Math.min(Math.max(s.a.y, s.b.y), Math.max(t.a.y, t.b.y)) - Math.max(Math.min(s.a.y, s.b.y), Math.min(t.a.y, t.b.y));
      } else if (sh && th && !(sv || tv)) {
        distance = Math.abs(s.a.y - t.a.y);
        shared = Math.min(Math.max(s.a.x, s.b.x), Math.max(t.a.x, t.b.x)) - Math.max(Math.min(s.a.x, s.b.x), Math.min(t.a.x, t.b.x));
      } else continue;
      if (distance > 0.5 && distance < gap - 0.5 && shared > 1) near.push(`${s.id} / ${t.id}: ${distance.toFixed(1)} px apart over ${shared.toFixed(0)} px`);
    }
  }
  expect(near, 'parallel routes in their own lanes').toEqual([]);
}

// No card and no edge label on screen under the toolbar groups or the
// legend / status dock (the fit and the recentring aim at the safe area).
export async function expectClearOfChrome(page, pane, state) {
  const chrome = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    return [...root.querySelectorAll(':scope > .graphKitBar > *, :scope > .graphKitDock > *')]
      .filter((el) => !el.hidden && el.getClientRects().length)
      .map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height, name: el.className || el.id }; });
  }, pane);
  expect(chrome.length, 'toolbar and dock boxes').toBeGreaterThan(1);
  for (const rect of [...state.nodes, ...(state.edgeLabels || [])]) {
    for (const box of chrome) expect(overlaps(rect, box), `${rect.id} ${rect.text || ''} under ${box.name}`).toBe(false);
  }
}

// Real touch input (Chromium's Input.dispatchTouchEvent; the context needs
// hasTouch): a one-finger drag and a two-finger pinch around `centre` whose
// finger gap goes from `fromGap` to `toGap` CSS pixels.
async function touchSequence(page, frames) {
  const cdp = await page.context().newCDPSession(page);
  const points = (list) => list.map((p, id) => ({ x: p.x, y: p.y, id }));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(frames[0]) });
  for (const frame of frames.slice(1)) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(frame) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
  await settle(page);
}

export async function touchDrag(page, from, to, steps = 8) {
  const frames = [];
  for (let i = 0; i <= steps; i += 1) frames.push([{ x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps }]);
  await touchSequence(page, frames);
}

export async function pinch(page, centre, fromGap, toGap, steps = 8) {
  const frames = [];
  for (let i = 0; i <= steps; i += 1) {
    const gap = fromGap + (toGap - fromGap) * i / steps;
    frames.push([{ x: centre.x - gap / 2, y: centre.y }, { x: centre.x + gap / 2, y: centre.y }]);
  }
  await touchSequence(page, frames);
}

// A phone shows the canvas (no Graph / List switch, no list), its icon
// toolbar inside the pane, and the canvas follows one-finger pans and
// two-finger pinches. `inspect` returns the graph's inspect() state.
export async function expectTouchCanvas(page, { pane, canvas, zoomIn, inspect }) {
  await expect(page.locator(canvas)).toBeVisible();
  await expect(page.locator(canvas)).toHaveCSS('visibility', 'visible');
  await expect(page.locator(`${pane} [role="tablist"], ${pane} .graphKitList`)).toHaveCount(0);
  await expect(page.locator(zoomIn)).toBeVisible();
  const paneBox = await page.locator(pane).boundingBox();
  for (const group of await page.locator(`${pane} > .graphKitBar > *:visible`).all()) {
    const box = await group.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(paneBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(paneBox.x + paneBox.width + 1);
  }
  const box = await page.locator(canvas).boundingBox();
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const before = await inspect();
  await touchDrag(page, centre, { x: centre.x - 70, y: centre.y - 50 });
  const panned = await inspect();
  expect(panned.offsetX, 'a one-finger drag pans').toBeLessThan(before.offsetX - 30);
  expect(panned.scale).toBeCloseTo(before.scale, 6);
  await pinch(page, centre, 60, 180);
  const zoomed = await inspect();
  expect(zoomed.scale, 'a pinch out zooms in').toBeGreaterThan(panned.scale * 1.5);
  await pinch(page, centre, 180, 60);
  expect((await inspect()).scale, 'a pinch in zooms out').toBeLessThan(zoomed.scale / 1.5);
}

// Labels of every edge, none on top of another label or a card.
export function expectLabelsClear(state) {
  expect(state.edgeLabelsDropped, 'every edge label is placed').toEqual([]);
  const labels = state.edgeLabels;
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      expect(overlaps(labels[i], labels[j]), `${labels[i].text} / ${labels[j].text}`).toBe(false);
    }
    for (const node of state.nodes) expect(overlaps(labels[i], node), `${labels[i].text} over ${node.id}`).toBe(false);
  }
}

function frameProbe() {
  window.__graphFrames = window.__graphFrames || [];
  window.__graphLong = window.__graphLong || 0;
  window.__graphLongMax = window.__graphLongMax || 0;
  if (window.__graphRafWrapped) return;
  window.__graphRafWrapped = true;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { const s = performance.now(); try { cb(t); } finally { window.__graphFrames.push(performance.now() - s); } });
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) { window.__graphLong += e.duration; window.__graphLongMax = Math.max(window.__graphLongMax, e.duration); } }).observe({ entryTypes: ['longtask'] }); } catch (_) {}
}

// Frame probe from the first script of every page (for budgets that include
// a navigation): call before page.goto().
export async function installFrameProbe(page) {
  await page.addInitScript(frameProbe);
}

// rAF frame costs and long tasks while running `action` (perf budgets).
export async function measureFrames(page, action, { reset = true } = {}) {
  await page.evaluate(frameProbe);
  if (reset) await page.evaluate(() => { window.__graphFrames = []; window.__graphLong = 0; window.__graphLongMax = 0; });
  const started = Date.now();
  await action();
  await settle(page);
  return page.evaluate((wallMs) => {
    const frames = window.__graphFrames.slice().sort((a, b) => a - b);
    return { wallMs, frames: frames.length, p95: frames[Math.floor(frames.length * 0.95)] || 0, max: frames[frames.length - 1] || 0, longMs: window.__graphLong, longMaxMs: window.__graphLongMax };
  }, Date.now() - started);
}
