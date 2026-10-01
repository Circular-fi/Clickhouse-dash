// Canvas charts (src/static/app_chart_core.js): the engine publishes what it
// drew on its root (.chartCore): data-points-drawn, data-series-stats,
// data-x-ticks / data-y-ticks (labels drawn), data-plot (plot box), data-y-min /
// data-y-max, data-cursor-index (snapped x), data-pick (picked point / cell).

export const chartCore = (scope) => scope.locator('.chartCore').first();

export async function chartJson(root, attribute) {
  const text = await root.getAttribute(attribute);
  return text ? JSON.parse(text) : null;
}

// The plot area in client coordinates.
export async function plotBox(root) {
  const overlay = await root.locator('.chartCore__overlay').boundingBox();
  const [left, top, width, height] = String(await root.getAttribute('data-plot')).split(' ').map(Number);
  return { x: overlay.x + left, y: overlay.y + top, width, height };
}

// The plot canvas pixel [r, g, b, a] under a client point.
export function canvasPixel(root, x, y) {
  return root.evaluate((el, [cx, cy]) => {
    const canvas = el.querySelector('canvas.chartCore__canvas');
    const box = canvas.getBoundingClientRect();
    const scale = canvas.width / box.width;
    const data = canvas.getContext('2d').getImageData(Math.round((cx - box.left) * scale), Math.round((cy - box.top) * scale), 1, 1).data;
    return [data[0], data[1], data[2], data[3]];
  }, [x, y]);
}
