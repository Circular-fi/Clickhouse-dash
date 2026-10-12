// Scene a2 - Query: the same result as a chart; hover and click it.
import { open, click, glide, wait as sleep } from "../lib.mjs";

const SQL = `SELECT
    toStartOfHour(Timestamp) AS hour,
    count() AS spans,
    countIf(SpanKind = 'Client') AS client_spans
FROM otel.otel_traces
WHERE Timestamp > '2026-09-17'
GROUP BY hour
ORDER BY hour ASC`;

export const cut = { speed: 1.15 };

export default async (env) => {
  const { page, rec } = env;
  await open(env, "/query?sql=" + encodeURIComponent(SQL), { settle: 900 });
  await page.locator("#runButton").click();
  await page.locator("#resultTableBody tr").first().waitFor({ timeout: 30000 });
  await sleep(800);
  await glide(env, 900, 800, 1);
  await rec.start();
  rec.mark("start");
  await sleep(350);
  await click(env, "[aria-label='Chart view']", { ms: 750 });
  rec.mark("chart");
  await rec.rect("chartToggle", page.locator("[aria-label='Chart view']"), 3);
  await sleep(900);
  const canvas = page.locator("#resultsPanel canvas").first();
  await canvas.waitFor({ timeout: 10000 });
  const b = await canvas.boundingBox();
  await glide(env, b.x + b.width * 0.14, b.y + b.height * 0.55, 650);
  for (const f of [0.3, 0.46, 0.62, 0.78]) { await glide(env, b.x + b.width * f, b.y + b.height * 0.5, 430); await sleep(140); }
  await page.mouse.down(); await sleep(60); await page.mouse.up();
  await sleep(900);
  await rec.stop();
};
