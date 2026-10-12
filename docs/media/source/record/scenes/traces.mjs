// Scene d - Traces: the latency heatmap (drag a box on the slow band), what differs, a trace waterfall, the service map.
import { open, click, glide, moveTo, wait as sleep, range } from "../lib.mjs";

export const cut = { speed: 1.7 };

export default async (env) => {
  const { page, rec } = env;
  const W = range("2026-09-12 13:00:00", "2026-09-12 17:00:00");
  await open(env, `/observability/traces?${W}&duration_view=heatmap`, { settle: 3500 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await glide(env, 700, 330, 1);
  await rec.start();
  rec.mark("start");
  await sleep(500);
  // hover over the heatmap, then drag a box on the slow band
  await glide(env, 1050, 300, 800);
  await sleep(300);
  await glide(env, 1135, 191, 550);
  await sleep(150);
  await page.mouse.down();
  await glide(env, 1415, 224, 900);
  await sleep(200);
  await page.mouse.up();
  rec.mark("boxed");
  await page.getByText("Selection vs baseline").waitFor({ timeout: 20000 });
  rec.mark("deltas");
  await sleep(2500, { keep: true });
  await click(env, page.getByRole("button", { name: "Search traces in this box" }), { ms: 800 });
  await sleep(1100);
  rec.mark("list");
  await click(env, page.getByText("Sort · Most recent"), { ms: 700 });
  await sleep(300);
  await click(env, page.getByText("Longest first", { exact: true }).locator("visible=true").first(), { ms: 400 });
  await sleep(1000);
  await click(env, page.locator("[data-trace-id]").first().locator("a").first(), { ms: 750 });
  await page.getByText("Service & Operation").waitFor({ timeout: 20000 });
  rec.mark("trace");
  await sleep(1400);
  const bar = page.locator("text=fees.compute").first();
  await moveTo(env, bar, { ms: 700 }).catch(() => {});
  await rec.rect("fees", bar, 5).catch(() => {});
  rec.mark("bar");
  await sleep(1100);
  await page.goBack();
  await page.getByText("Service map").first().waitFor();
  await sleep(600);
  await click(env, page.getByRole("tab", { name: "Service map" }), { ms: 700 });
  rec.mark("map");
  await sleep(2400, { keep: true });
  await rec.stop();
};
