// Scene e - Logs and Metrics: a log line opened, then the Metrics view jumps to the last data and charts a metric.
import { open, click, glide, moveTo, wait as sleep, range } from "../lib.mjs";

export const cut = { speed: 1.7 };

export default async (env) => {
  const { page, rec } = env;
  await open(env, `/observability/logs?${range("2026-09-12 15:20:00", "2026-09-12 16:00:00")}`, { settle: 3500 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await glide(env, 700, 330, 1);
  await rec.start();
  rec.mark("start");
  await sleep(350);
  const canvas = page.locator("canvas:visible").first();
  const b = await canvas.boundingBox();
  await glide(env, b.x + b.width * 0.3, b.y + b.height * 0.5, 700);
  for (const f of [0.45, 0.62]) { await glide(env, b.x + b.width * f, b.y + b.height * 0.5, 380); await sleep(120); }
  rec.mark("hist");
  await click(env, page.locator("#logsTableRows .logsRow[data-row-id]").nth(2), { ms: 700, dx: 200 });
  rec.mark("row");
  await sleep(1400);
  await page.keyboard.press("Escape");
  await sleep(200);
  await click(env, page.getByText("Metrics", { exact: true }).first(), { ms: 700 });
  rec.mark("metrics");
  await sleep(900);
  await click(env, page.getByRole("button", { name: /Jump to last data/ }), { ms: 700 });
  await sleep(1000);
  await click(env, page.getByText("process.cpu.utilization").first(), { ms: 700 });
  await sleep(800);
  await click(env, page.getByRole("button", { name: "edge_gateway", exact: true }).first(), { ms: 700 });
  rec.mark("chart");
  await sleep(1600);
  const c2 = page.locator("canvas:visible").first();
  const b2 = await c2.boundingBox();
  await glide(env, b2.x + b2.width * 0.3, b2.y + b2.height * 0.5, 650);
  for (const f of [0.5, 0.7]) { await glide(env, b2.x + b2.width * f, b2.y + b2.height * 0.5, 420); await sleep(180); }
  await sleep(300);
  await rec.stop();
};
