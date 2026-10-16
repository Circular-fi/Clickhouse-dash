// Canvas charts (src/static/app_chart_core.js): the engine publishes what it drew on its root (.chartCore).
// The attributes are data-points-drawn, data-series-stats, data-x-ticks and data-y-ticks (labels drawn).
// Also data-plot (plot box), data-y-min and data-y-max, data-cursor-index (snapped x) and data-pick (picked point / cell).

export const chartCore = (scope) => scope.locator('.chartCore').first();

export async function chartJson(root, attribute) {
  const text = await root.getAttribute(attribute);
  return text ? JSON.parse(text) : null;
}

// This function finds the x labels of data-x-ticks that come closer than gap px to the one before.
// Each entry is [label, date line, left, right, date left, date right], in canvas px.
// The overlap is on the label line or on the date line. The result has "a | b" texts.
// The result is [] when none do.
export function xLabelCollisions(ticks, gap = 4) {
  const out = [];
  for (let i = 1; i < ticks.length; i += 1) {
    if (ticks[i][2] < ticks[i - 1][3] + gap) out.push(`${ticks[i - 1][0]} | ${ticks[i][0]}`);
  }
  const dated = ticks.filter((t) => t[1]);
  for (let i = 1; i < dated.length; i += 1) {
    if (dated[i][4] < dated[i - 1][5] + gap) out.push(`${dated[i - 1][1]} | ${dated[i][1]}`);
  }
  return out;
}

// The date lines of data-x-ticks that repeat the year of the one before.
// The year shows on the first date line and where it changes.
export function xRepeatedYears(ticks) {
  const out = [];
  let year = '';
  for (const [, line] of ticks) {
    if (!line) continue;
    const own = (/\b(\d{4})$/.exec(line) || [])[1] || '';
    if (own && own === year) out.push(line);
    if (own) year = own;
  }
  return out;
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
