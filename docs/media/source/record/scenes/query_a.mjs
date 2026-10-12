// Scene a1 - Query: type a query by hand, Format it, Run it, watch the live tiles fill and the table arrive.
import { open, click, humanType, glide, wait as sleep } from "../lib.mjs";

export const cut = { start: 0.3, end: -0.55, speed: 1 };

export default async (env) => {
  const { page, rec } = env;
  await open(env, "/query", { settle: 900 });
  await glide(env, 1000, 330, 1);
  await rec.start();
  await sleep(300);
  await click(env, "#queryTextArea", { dx: -200, dy: -60, ms: 750 });
  await sleep(200);
  rec.mark("typeStart");
  const o = { base: 6, jitter: 20, rate: 2.8 };
  await humanType(env, "SELECT toStartOfHour(Timestamp) AS hour, count() AS spans, countIf(SpanKind = 'Client') AS client_spans", { ...o, seed: 11 });
  await page.keyboard.press("Escape"); await sleep(120); await page.keyboard.press("Enter"); await sleep(160);
  await humanType(env, "FROM otel.otel_traces WHERE Timestamp > '2026-09-17' GROUP BY hour ORDER BY hour", { ...o, seed: 5 });
  await page.keyboard.press("Escape");
  rec.mark("typed");
  await sleep(120);
  await click(env, "#formatButton", { ms: 650 });
  rec.mark("formatted");
  await rec.rect("format", page.locator("#formatButton"), 2);
  await sleep(800);
  await click(env, "#runButton", { ms: 600 });
  rec.mark("run");
  await page.locator("#resultTableBody tr").first().waitFor({ timeout: 30000 });
  rec.mark("tilesDone");
  await rec.rect("tiles", page.locator("#runStatsTiles"), 2);
  await rec.rect("summary", page.locator("#resultSummaryText"), 4);
  await sleep(800);
  await glide(env, 900, 800, 700);
  await sleep(500);
  await rec.stop();
};
