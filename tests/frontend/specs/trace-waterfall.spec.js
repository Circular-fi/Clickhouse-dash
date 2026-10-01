import { test, expect } from '@playwright/test';
import { nestedTrace, largeTrace, routeTrace, routeSearch } from '../helpers/trace-mocks.js';

// Trace detail page with Jaeger's behaviour (header, overview, waterfall).
// The OTel fixture traces are flat, so these run on mocked traces (see
// helpers/trace-mocks.js for the shape of the nested one).

const spanId = (n) => n.toString(16).padStart(16, '0');
const rows = '#traceWaterfall .traceSpanRow';
const row = (page, n) => page.locator(`${rows}[data-span-id="${spanId(n)}"]`);
const rowIds = (page) => page.locator(rows).evaluateAll((els) => els.map((el) => el.getAttribute('data-span-id')));

// Jaeger UI's --span-color-1..20 (components/common/vars.css), dark theme.
const JAEGER_DARK = [
  '#1192e8', '#ff832b', '#a56eff', '#f1c21b', '#009d9a', '#da1e28', '#24a148', '#ee538b', '#00539c', '#8d8d8d',
  '#0072c3', '#ba4e00', '#8a3ffc', '#b28600', '#005d5d', '#a2191f', '#198038', '#9f1853', '#002d9c', '#6929c4',
];
// ... light theme.
const JAEGER_LIGHT = [
  '#0072c3', '#eb6200', '#8a3ffc', '#b28600', '#005d5d', '#fa4d56', '#198038', '#9f1853', '#002d9c', '#6f6f6f',
  '#00539c', '#8a3800', '#6929c4', '#8e6a00', '#002d2d', '#570408', '#0e6027', '#510224', '#001141', '#491d8b',
];
// Without the two reds (6 and 16): red is for errors.
const withoutReds = (palette) => palette.filter((_, index) => index !== 5 && index !== 15);
const rgb = (hex) => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;

async function openTrace(page, trace) {
  await routeTrace(page, trace);
  await page.goto(`/observability/traces/${trace.trace_id}`);
  await expect(page.locator('#traceDetail')).toBeVisible();
  if (trace.spans.length > 1000) {
    // Virtualised: the body holds every row's place, the DOM a window.
    await expect(page.locator(`#traceWaterfall .traceWaterfallBody[data-virtual-rows="${trace.spans.length}"]`)).toHaveCount(1, { timeout: 30_000 });
  } else {
    await expect(page.locator(rows)).toHaveCount(trace.spans.length, { timeout: 20_000 });
  }
}

// Colour of the service marker of a row, resolved.
const rowColor = (locator) => locator.locator('.traceSpanRow__serviceDot').evaluate((el) => getComputedStyle(el).backgroundColor);

test('trace detail: services take Jaeger\'s palette in first-seen order, the same in the result list and the trace', async ({ page }) => {
  const trace = nestedTrace();
  const services = [...new Set(trace.spans.map((span) => span.service))].sort();
  await routeSearch(page, [trace]);
  await routeTrace(page, trace);
  await page.goto('/observability/traces');
  const result = page.locator(`#tracesResults [data-trace-id="${trace.trace_id}"]`);
  await expect(result).toBeVisible({ timeout: 20_000 });
  const listColors = await result.locator('[style*="--trace-service-color"]').evaluateAll((els) => Object.fromEntries(els.map((el) => [
    el.querySelector('b')?.textContent || el.textContent,
    getComputedStyle(el).getPropertyValue('--trace-service-color').trim(),
  ])));
  const palette = withoutReds(JAEGER_DARK);
  // The search registers its services in name order: the n-th name takes
  // Jaeger's n-th colour (reds skipped).
  expect(Object.keys(listColors).sort()).toEqual(services);
  for (const [index, service] of services.entries()) expect(listColors[service]).toBe(palette[index]);
  expect(Object.values(listColors)).not.toContain('#da1e28');

  await result.click();
  await expect(page.locator(rows)).toHaveCount(trace.spans.length, { timeout: 20_000 });
  for (const span of trace.spans) {
    const serviceIndex = services.indexOf(span.service);
    expect(await rowColor(page.locator(`${rows}[data-span-id="${span.span_id}"]`))).toBe(rgb(palette[serviceIndex]));
  }
  // The assignment lasts for the session: a reload keeps every colour.
  await page.reload();
  await expect(page.locator(rows)).toHaveCount(trace.spans.length, { timeout: 20_000 });
  expect(await rowColor(row(page, 13))).toBe(rgb(palette[services.indexOf('mailer')]));

  // Light theme: Jaeger's light variants of the same slots.
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  expect(await rowColor(row(page, 1))).toBe(rgb(withoutReds(JAEGER_LIGHT)[services.indexOf('frontend')]));
});

test('trace detail: error bars keep their service colour with a (!) badge, a collapsed branch hiding errors gets a hollow (!)', async ({ page }) => {
  await openTrace(page, nestedTrace());
  // lock rows (span 7) is an error span, deep in the checkout branch.
  const lock = row(page, 7);
  await expect(lock.locator('.traceSpanRow__errorBadge:not(.traceSpanRow__errorBadge--hollow)')).toHaveCount(1);
  const [barColor, serviceColor] = await Promise.all([
    lock.locator('.traceSpanBar').evaluate((el) => getComputedStyle(el).backgroundColor),
    rowColor(lock),
  ]);
  expect(barColor).toBe(serviceColor);
  expect(barColor).not.toBe('rgb(228, 87, 86)');
  // Expanded, ancestors carry no marker.
  await expect(page.locator(`${rows} .traceSpanRow__errorBadge--hollow`)).toHaveCount(0);

  // Collapse "handle checkout" (4): its row hides both error spans (7, 10).
  await row(page, 4).locator('[data-toggle-span]').click();
  await expect(row(page, 7)).toHaveCount(0);
  await expect(row(page, 10)).toHaveCount(0);
  await expect(row(page, 4).locator('.traceSpanRow__errorBadge--hollow')).toHaveCount(1);
  await expect(row(page, 4).locator('.traceSpanRow__errorBadge--hollow')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  // A collapsed branch without errors (the queue publish, 11) gets none.
  await row(page, 11).locator('[data-toggle-span]').click();
  await expect(row(page, 12)).toHaveCount(0);
  await expect(row(page, 11).locator('.traceSpanRow__errorBadge')).toHaveCount(0);
  // Collapsing the root moves the marker up.
  await row(page, 1).locator('[data-toggle-span]').click();
  await expect(page.locator(rows)).toHaveCount(2);
  await expect(row(page, 1).locator('.traceSpanRow__errorBadge--hollow')).toHaveCount(1);
  await row(page, 1).locator('[data-toggle-span]').click();
  await expect(row(page, 4).locator('.traceSpanRow__errorBadge--hollow')).toHaveCount(1);
});

test('trace detail: header items like Jaeger\'s, with Errors and an Incomplete tag, and the tab named after the trace', async ({ page }) => {
  const trace = nestedTrace();
  await openTrace(page, trace);
  const item = (label) => page.locator(`#traceDetailStats [data-trace-header-item="${label}"] > strong`);
  // Then the trace's logs (app_trace_logs.js, when logs are enabled).
  await expect(page.locator('#traceDetailStats [data-trace-header-item] > span')).toHaveText(['Trace Start', 'Duration', 'Services', 'Depth', 'Total Spans', 'Errors', 'Logs']);
  // Browser-local (UTC here), with the year, seconds and muted milliseconds.
  await expect(item('Trace Start')).toHaveText('Sep 20 2026, 01:22:52.000');
  await expect(item('Trace Start').locator('small')).toHaveText('.000');
  await expect(item('Duration')).toHaveText('100 ms');
  await expect(item('Services')).toHaveText('10');
  await expect(item('Depth')).toHaveText('6');
  await expect(item('Total Spans')).toHaveText('13');
  await expect(item('Errors')).toHaveText('2');
  await expect(page.locator('#traceDetailStats [data-trace-header-item="Errors"]')).toHaveClass(/is-error/);
  // One span (the mailer) points at a parent missing from the trace.
  const incomplete = page.locator('#traceDetailStats [data-trace-incomplete]');
  await expect(incomplete).toHaveText('Incomplete');
  await expect(incomplete).toHaveAttribute('title', /1 span references a parent span missing/);
  await expect(page).toHaveTitle('a1b2c3d: frontend GET /checkout');
  // The copy control stays last in the title row, the full id copies.
  const [statsBox, splitBox] = await Promise.all([page.locator('#traceDetailStats').boundingBox(), page.locator('#traceCopySplit').boundingBox()]);
  expect(splitBox.x).toBeGreaterThanOrEqual(statsBox.x + statsBox.width - 1);
  await expect(page.locator('#traceDetailTitle [data-copy-active-trace]')).toHaveAttribute('data-copy-active-trace', trace.trace_id);
  // Without orphans or errors: no tag, a plain 0.
  const flat = nestedTrace('0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f');
  flat.spans = flat.spans.filter((span) => span.service !== 'mailer').map((span) => ({ ...span, error: false }));
  await openTrace(page, flat);
  await expect(page.locator('#traceDetailStats [data-trace-incomplete]')).toHaveCount(0);
  await expect(item('Errors')).toHaveText('0');
  await expect(page.locator('#traceDetailStats [data-trace-header-item="Errors"]')).not.toHaveClass(/is-error/);
  await page.locator('#traceBackButton').click();
  await expect(page).toHaveTitle('ClickHouse Dash · Traces');
});

test('trace detail: the overview draws one row per span in waterfall order, 1..6 px tall, and a canvas for large traces', async ({ page }) => {
  await openTrace(page, nestedTrace());
  const graph = page.locator('[data-trace-overview-graph]');
  await expect(graph).toHaveAttribute('data-overview-mode', 'dom');
  await expect(graph).toHaveAttribute('data-overview-rows', '13');
  const bars = graph.locator('i[data-span-id]');
  expect(await bars.evaluateAll((els) => els.map((el) => el.getAttribute('data-span-id')))).toEqual(await rowIds(page));
  // 13 rows in Jaeger's 60 px minimum: 60 / 13 px apart and tall.
  const geometry = await bars.evaluateAll((els) => els.map((el) => [parseFloat(el.style.top), parseFloat(el.style.height)]));
  geometry.forEach(([top, height], index) => {
    expect(top).toBeCloseTo((index * 60) / 13, 1);
    expect(height).toBeCloseTo(60 / 13, 1);
  });
  expect(await graph.evaluate((el) => el.clientHeight)).toBe(60);
  // The waterfall order ignores collapsing (the overview shows every span).
  await page.keyboard.press(']');
  await expect(page.locator(rows)).toHaveCount(2);
  await expect(bars).toHaveCount(13);
  // Bars use the service colours.
  expect(await bars.first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(await rowColor(row(page, 1)));

  const big = largeTrace(2000);
  await openTrace(page, big);
  await expect(graph).toHaveAttribute('data-overview-mode', 'canvas');
  await expect(graph).toHaveAttribute('data-overview-rows', '2000');
  expect(await graph.evaluate((el) => el.clientHeight)).toBe(200);
  const painted = await graph.locator('canvas').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count += 1;
    return count / (canvas.width * canvas.height);
  });
  expect(painted).toBeGreaterThan(0.05);
});

test('trace detail: the tree shows guides in ancestor colours, child-count boxes and leaf dots, and hover highlights a subtree', async ({ page }) => {
  const trace = nestedTrace();
  await openTrace(page, trace);
  const box = (n) => row(page, n).locator('.traceTreeOffset__box');
  await expect(box(1)).toHaveText('3');
  await expect(box(4)).toHaveText('2');
  await expect(box(8)).toHaveText('2');
  await expect(row(page, 2).locator('.traceTreeOffset__box')).toHaveCount(0);
  await expect(row(page, 2).locator('.traceTreeOffset__dot')).toHaveCount(1);
  // lock rows (level 5): one guide per ancestor, coloured like it.
  const guides = row(page, 7).locator('.traceTreeOffset__guide');
  await expect(guides).toHaveCount(5);
  expect(await guides.evaluateAll((els) => els.map((el) => el.getAttribute('data-ancestor-id')))).toEqual([1, 3, 4, 5, 6].map(spanId));
  const guideColors = await guides.evaluateAll((els) => els.map((el) => getComputedStyle(el).color));
  const ancestorColors = await Promise.all([1, 3, 4, 5, 6].map((n) => rowColor(row(page, n))));
  expect(guideColors).toEqual(ancestorColors);
  // Only the parent's guide has the elbow; lock rows is its parent's last
  // child, so that guide stops halfway. The root's guide runs on (3 is not
  // its last child), so does 4's (5 is followed by 8), 5's ends (6 is its
  // last child).
  await expect(guides.locator('.traceTreeOffset__elbow')).toHaveCount(1);
  await expect(guides.nth(4)).toHaveClass(/is-last/);
  await expect(guides.nth(0)).not.toHaveClass(/is-terminated/);
  await expect(guides.nth(2)).not.toHaveClass(/is-terminated/);
  await expect(guides.nth(3)).toHaveClass(/is-terminated/);
  const fraudGuides = row(page, 10).locator('.traceTreeOffset__guide');
  // In fraud's row (last child of 8, itself last child of 4): 4's guide ends.
  await expect(fraudGuides.nth(2)).toHaveClass(/is-terminated/);

  // Hovering a guide highlights that span's guides in every row.
  await guides.nth(2).hover();
  const hovered = page.locator('#traceWaterfall .is-guide-hovered');
  expect(await hovered.evaluateAll((els) => [...new Set(els.map((el) => el.getAttribute('data-ancestor-id')))])).toEqual([spanId(4)]);
  // 4's box and a guide in each of its 6 descendants' rows.
  await expect(hovered).toHaveCount(7);
  await page.mouse.move(5, 5);
  await expect(hovered).toHaveCount(0);

  // Collapsed: a tinted box and a bold italic service name.
  const before = await box(4).evaluate((el) => getComputedStyle(el).backgroundColor);
  await box(4).click();
  await expect(box(4)).toHaveClass(/is-collapsed/);
  await expect(box(4)).toHaveAttribute('aria-expanded', 'false');
  expect(await box(4).evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);
  await expect(row(page, 4).locator('.traceSpanRow__service')).toHaveCSS('font-style', 'italic');
  await expect(row(page, 4).locator('.traceSpanRow__service')).toHaveCSS('font-weight', '800');
  await expect(row(page, 3).locator('.traceSpanRow__service')).toHaveCSS('font-style', 'normal');
  // Keyboard on the box folds it too, without opening the span.
  await box(4).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(rows)).toHaveCount(13);
  await expect(page.locator('#traceWaterfall .traceSpanInspectorRow')).toHaveCount(0);
});

test('trace detail: Expand +1 / Collapse +1 / Expand all / Collapse all buttons and the [ ] o p keys', async ({ page }) => {
  await openTrace(page, nestedTrace());
  const head = page.locator('#traceWaterfall .traceWaterfallHead__controls');
  await expect(head.locator('button:visible')).toHaveCount(5);
  await expect(head.locator('[data-trace-expand-one]')).toHaveAttribute('title', 'Expand +1 (o)');
  await expect(head.locator('[data-trace-collapse-one]')).toHaveAttribute('title', 'Collapse +1 (p)');
  await expect(head.locator('[data-trace-expand-all]')).toHaveAttribute('title', 'Expand all ([)');
  await expect(head.locator('[data-trace-collapse-all]')).toHaveAttribute('title', 'Collapse all (])');

  // Collapse +1 (Jaeger): the deepest open parent of each branch.
  await page.keyboard.press('p');
  expect(await rowIds(page)).toEqual([1, 2, 3, 4, 5, 6, 8, 11, 13].map(spanId));
  await page.keyboard.press('p');
  expect(await rowIds(page)).toEqual([1, 2, 3, 4, 5, 8, 11, 13].map(spanId));
  await page.keyboard.press(']');
  expect(await rowIds(page)).toEqual([1, 13].map(spanId));
  // Expand +1: the shallowest collapsed span of each branch.
  await page.keyboard.press('o');
  expect(await rowIds(page)).toEqual([1, 2, 3, 11, 13].map(spanId));
  await page.keyboard.press('o');
  expect(await rowIds(page)).toEqual([1, 2, 3, 4, 11, 12, 13].map(spanId));
  await page.keyboard.press('[');
  await expect(page.locator(rows)).toHaveCount(13);
  // The same through the buttons.
  await head.locator('[data-trace-collapse-all]').click();
  await expect(page.locator(rows)).toHaveCount(2);
  await head.locator('[data-trace-expand-one]').click();
  await expect(page.locator(rows)).toHaveCount(5);
  await head.locator('[data-trace-expand-all]').click();
  await expect(page.locator(rows)).toHaveCount(13);
  await head.locator('[data-trace-collapse-one]').click();
  await expect(page.locator(rows)).toHaveCount(9);
});

test('trace detail: zoomed ticks read offsets from the trace start with the wall-clock time below', async ({ page }) => {
  await openTrace(page, nestedTrace());
  const labels = page.locator('#traceWaterfall [data-trace-tick] b');
  const clocks = page.locator('#traceWaterfall [data-trace-tick] small');
  await expect(labels).toHaveText(['0 ns', '25 ms', '50 ms', '75 ms', '100 ms']);
  await expect(clocks).toHaveText(['01:22:52.000', '01:22:52.025', '01:22:52.050', '01:22:52.075', '01:22:52.100']);
  // Shift+Up zooms in by 5 % a side (Jaeger's large zoom step), Shift+D pans.
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowUp');
  await expect(labels).toHaveText(['25 ms', '37.5 ms', '50 ms', '62.5 ms', '75 ms']);
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+D');
  await expect(labels).toHaveText(['50 ms', '62.5 ms', '75 ms', '87.5 ms', '100 ms']);
  await expect(clocks).toHaveText(['01:22:52.050', '01:22:52.062', '01:22:52.075', '01:22:52.087', '01:22:52.100']);
  await expect(page.locator('#traceWaterfall [data-trace-tick]').first()).toHaveAttribute('title', '50 ms after the trace start · 01:22:52.050');
  // Labels keep Jaeger's 130 px minimum spacing.
  const lefts = await page.locator('#traceWaterfall [data-trace-tick]').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
  for (let i = 1; i < lefts.length; i += 1) expect(lefts[i] - lefts[i - 1]).toBeGreaterThanOrEqual(130);
  // a / Left pan left by 0.5 % (5 % with Shift), keeping the width.
  await page.keyboard.press('a');
  await expect(labels).toHaveText(['49.5 ms', '62 ms', '74.5 ms', '87 ms', '99.5 ms']);
  await page.keyboard.press('Shift+ArrowLeft');
  await expect(labels.first()).toHaveText('44.5 ms');
  // A deep zoom (to Jaeger's 1 % minimum) adds decimals instead of repeating labels.
  for (let i = 0; i < 9; i += 1) await page.keyboard.press('Shift+ArrowUp');
  await expect(labels).toHaveText(['69.00 ms', '69.25 ms', '69.50 ms', '69.75 ms', '70.00 ms']);
  await expect(clocks).toHaveText(['01:22:52.069000', '01:22:52.069250', '01:22:52.069500', '01:22:52.069750', '01:22:52.070000']);
  // Down zooms back out.
  for (let i = 0; i < 30; i += 1) await page.keyboard.press('Shift+ArrowDown');
  await expect(labels.first()).toHaveText('0 ns');
  await expect(page.locator('#traceWaterfall [data-trace-reset-zoom]')).toBeHidden();
});

test('trace detail: dragging across the timeline header zooms in, the reset control and the overview follow', async ({ page }) => {
  await openTrace(page, nestedTrace());
  const header = page.locator('#traceWaterfall [data-trace-timeline-header]');
  const reset = page.locator('#traceWaterfall [data-trace-reset-zoom]');
  await expect(reset).toBeHidden();
  const box = await header.boundingBox();
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * 0.25, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, y, { steps: 4 });
  await expect(header.locator('[data-trace-timeline-drag]')).toBeVisible();
  await page.mouse.move(box.x + box.width * 0.75, y, { steps: 4 });
  await page.mouse.up();
  await expect(header.locator('[data-trace-timeline-drag]')).toBeHidden();
  const first = page.locator('#traceWaterfall [data-trace-tick] b').first();
  await expect(first).toHaveText(/^2[45](\.\d+)? ms$/);
  await expect(page.locator('#traceWaterfall [data-trace-tick] b').last()).toHaveText(/^7[45](\.\d+)? ms$/);
  const selection = page.locator('[data-trace-overview-selection]');
  expect(parseFloat(await selection.evaluate((el) => el.style.left))).toBeCloseTo(25, 0);
  expect(parseFloat(await selection.evaluate((el) => el.style.width))).toBeCloseTo(50, 0);
  // render (2..12 ms) is outside the view now.
  await expect(row(page, 2)).toHaveCount(0);
  await expect(reset).toBeVisible();
  await reset.click();
  await expect(first).toHaveText('0 ns');
  await expect(reset).toBeHidden();
  await expect(page.locator(rows)).toHaveCount(13);
  // A click without a drag does not zoom.
  await header.click({ position: { x: box.width * 0.4, y: box.height / 2 } });
  await expect(first).toHaveText('0 ns');
});

test('trace detail: zoomed spans cut by the view edge show a clipping shade on that edge', async ({ page }) => {
  await openTrace(page, nestedTrace());
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Shift+ArrowUp');
  // View 25..75 ms: checkout (10..90) is cut on both sides, render (2..12)
  // is gone, the queue publish (91..93) too, reserve items (14..40) left only.
  await expect(row(page, 3)).toHaveClass(/clipping-left/);
  await expect(row(page, 3)).toHaveClass(/clipping-right/);
  await expect(row(page, 5)).toHaveClass(/clipping-left/);
  await expect(row(page, 5)).not.toHaveClass(/clipping-right/);
  await expect(row(page, 9)).not.toHaveClass(/clipping-left|clipping-right/);
  const shade = (n, pseudo) => row(page, n).locator('.traceSpanRow__timeline').evaluate((el, p) => {
    const cs = getComputedStyle(el, p);
    return { image: cs.backgroundImage, width: cs.width };
  }, pseudo);
  expect(await shade(3, '::before')).toEqual({ image: expect.stringContaining('linear-gradient'), width: '6px' });
  expect(await shade(3, '::after')).toEqual({ image: expect.stringContaining('linear-gradient'), width: '6px' });
  expect((await shade(9, '::before')).image).toBe('none');
});

test('trace detail: the critical path marks the blocking chain of the mocked trace and can be hidden', async ({ page }) => {
  await openTrace(page, nestedTrace());
  const marked = async () => (await page.locator(`${rows}:has(.traceSpanBar__critical)`).evaluateAll((els) => els.map((el) => el.getAttribute('data-span-id')))).sort();
  // Jaeger's algorithm: the root's last finishing child, back to earlier
  // children; the consumer of a producer does not block it, the render span
  // finishes before checkout's work, the orphan mailer has no path.
  expect(await marked()).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(spanId).sort());
  const segments = async (n) => (await row(page, n).locator('.traceSpanBar__critical').evaluateAll((els) => els.map((el) => [parseFloat(el.style.left), parseFloat(el.style.width)]))).sort((a, b) => a[0] - b[0]);
  const close = (actual, expected) => {
    expect(actual).toHaveLength(expected.length);
    actual.forEach(([left, width], index) => {
      expect(left).toBeCloseTo(expected[index][0], 2);
      expect(width).toBeCloseTo(expected[index][1], 2);
    });
  };
  // Root: 0..10, 90..91, 93..100 ms of the 100 ms trace.
  close(await segments(1), [[0, 10], [90, 1], [93, 7]]);
  close(await segments(8), [[42, 2], [50, 2], [84, 2]]);
  close(await segments(10), [[52, 32]]);
  // A collapsed span shows its hidden subtree's segments, merged.
  await row(page, 8).locator('[data-toggle-span]').click();
  close(await segments(8), [[42, 44]]);
  // The toggle hides and shows the strips.
  const toggle = page.locator('#traceWaterfall [data-trace-critical-path]');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(row(page, 1).locator('.traceSpanBar__critical').first()).toBeVisible();
  await toggle.click();
  await expect(page.locator('#traceWaterfall [data-trace-critical-path]')).toHaveAttribute('aria-pressed', 'false');
  await expect(row(page, 1).locator('.traceSpanBar__critical').first()).toBeHidden();
  await page.locator('#traceWaterfall [data-trace-critical-path]').click();
  await expect(row(page, 1).locator('.traceSpanBar__critical').first()).toBeVisible();
});

test('trace detail: well-known attributes show as pills and icons in the name column, a 5xx status in red', async ({ page }) => {
  await openTrace(page, nestedTrace());
  const pills = (n) => row(page, n).locator('.traceSpanPill');
  await expect(pills(1)).toHaveText(['200', 'GET']);
  await expect(pills(1).first()).not.toHaveClass(/is-error/);
  await expect(pills(3)).toHaveText(['502', 'POST']);
  await expect(pills(3).first()).toHaveClass(/is-error/);
  await expect(pills(3).first()).toHaveAttribute('title', 'http.status_code: 502');
  await expect(pills(10)).toHaveText(['503', 'POST']);
  await expect(pills(10).first()).toHaveClass(/is-error/);
  await expect(pills(6)).toHaveText(['postgresql']);
  await expect(pills(6)).toHaveAttribute('title', 'db.system: postgresql');
  await expect(pills(9)).toHaveText(['mysql']);
  await expect(pills(5)).toHaveText(['grpc']);
  await expect(pills(8)).toHaveAttribute('title', 'rpc.system: grpc');
  await expect(pills(11)).toHaveText(['kafka']);
  await expect(pills(11)).toHaveAttribute('title', 'messaging.system: kafka');
  await expect(pills(2)).toHaveCount(0);
  const icon = (n) => row(page, n).locator('[data-span-decoration]');
  await expect(icon(1)).toHaveAttribute('data-span-decoration', 'http');
  await expect(icon(6)).toHaveAttribute('data-span-decoration', 'db');
  await expect(icon(5)).toHaveAttribute('data-span-decoration', 'rpc');
  await expect(icon(11)).toHaveAttribute('data-span-decoration', 'messaging');
  await expect(icon(2)).toHaveCount(0);
  // Red is the error colour, shared with the (!) badge.
  const [pillColor, badgeColor] = await Promise.all([
    pills(10).first().evaluate((el) => getComputedStyle(el).color),
    row(page, 10).locator('.traceSpanRow__errorBadge').evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  expect(pillColor).toBe(badgeColor);
});

test('trace detail: the in-trace span search and trace id lookup are gone', async ({ page, request }) => {
  await openTrace(page, nestedTrace());
  for (const selector of ['#traceSpanSearch', '#traceSpanSearchCount', '#traceSpanSearchClear', '#traceIdLookupForm', '#traceIdLookupInput', '.tracePageFind', '.is-search-match']) {
    await expect(page.locator(selector)).toHaveCount(0);
  }
  for (const path of ['/static/app_traces.js', '/static/app_dom.js', '/static/style.css']) {
    const text = await (await request.get(path)).text();
    for (const dead of ['traceSpanSearch', 'traceIdLookup', 'spanSearchText', 'is-search-match', 'tracePageFind']) expect(text).not.toContain(dead);
  }
});

test('trace detail: a 10,000-span trace is virtualised: a window of rows, scrolled in, folded and opened in place', async ({ page }) => {
  test.setTimeout(90_000);
  const big = largeTrace(10_000, 'bead0000000000000000000000010000', 8);
  const started = Date.now();
  await openTrace(page, big);
  expect(Date.now() - started).toBeLessThan(15_000);
  const waterfall = page.locator('#traceWaterfall');
  const rendered = await page.locator(rows).count();
  expect(rendered).toBeGreaterThan(20);
  expect(rendered).toBeLessThan(400);
  // The body keeps the height of every row (24 px each).
  expect(await waterfall.locator('.traceWaterfallBody').evaluate((el) => el.offsetHeight)).toBe(10_000 * 24);
  await expect(page.locator(rows).first().locator('.traceTreeOffset__box')).toHaveText(String(big.spans.filter((span) => span.parent_span_id === spanId(1)).length));
  // Scrolled to the end: the last rows are drawn, the first ones are gone.
  await waterfall.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(row(page, 1)).toHaveCount(0);
  await expect.poll(() => waterfall.locator('[data-virtual-after]').evaluate((el) => el.offsetHeight)).toBe(0);
  const lastRow = page.locator(rows).last();
  await expect(lastRow).toBeVisible();
  // Opening a span there keeps the place and draws its inspector.
  const scrolled = await waterfall.evaluate((el) => el.scrollTop);
  await lastRow.click();
  await expect(waterfall.locator('.traceSpanInspectorRow')).toHaveCount(1);
  expect(Math.abs(await waterfall.evaluate((el) => el.scrollTop) - scrolled)).toBeLessThan(2);
  // Folding everything leaves the virtual mode, unfolding goes back.
  const folded = Date.now();
  await page.keyboard.press(']');
  await expect(page.locator(rows)).toHaveCount(1);
  await expect(waterfall.locator('[data-virtual-rows]')).toHaveCount(0);
  await page.keyboard.press('[');
  await expect(waterfall.locator('[data-virtual-rows="10000"]')).toHaveCount(1);
  expect(Date.now() - folded).toBeLessThan(5_000);
});
