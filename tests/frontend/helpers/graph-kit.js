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
  const legendBox = await page.locator(legend).boundingBox();
  const statusBox = await page.locator(status).boundingBox();
  // Bottom-left: the legend above the status line, both at the left edge.
  expect(legendBox.x - paneBox.x).toBeLessThan(20);
  expect(paneBox.y + paneBox.height - (legendBox.y + legendBox.height)).toBeLessThan(60);
  expect(legendBox.y + legendBox.height).toBeLessThanOrEqual(statusBox.y + 1);
  expect(statusBox.x - paneBox.x).toBeLessThan(20);
  expect(paneBox.y + paneBox.height - (statusBox.y + statusBox.height)).toBeLessThan(16);
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
  if (window.__graphRafWrapped) return;
  window.__graphRafWrapped = true;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf((t) => { const s = performance.now(); try { cb(t); } finally { window.__graphFrames.push(performance.now() - s); } });
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__graphLong += e.duration; }).observe({ entryTypes: ['longtask'] }); } catch (_) {}
}

// Frame probe from the first script of every page (for budgets that include
// a navigation): call before page.goto().
export async function installFrameProbe(page) {
  await page.addInitScript(frameProbe);
}

// rAF frame costs and long tasks while running `action` (perf budgets).
export async function measureFrames(page, action, { reset = true } = {}) {
  await page.evaluate(frameProbe);
  if (reset) await page.evaluate(() => { window.__graphFrames = []; window.__graphLong = 0; });
  const started = Date.now();
  await action();
  await settle(page);
  return page.evaluate((wallMs) => {
    const frames = window.__graphFrames.slice().sort((a, b) => a - b);
    return { wallMs, frames: frames.length, p95: frames[Math.floor(frames.length * 0.95)] || 0, max: frames[frames.length - 1] || 0, longMs: window.__graphLong };
  }, Date.now() - started);
}
