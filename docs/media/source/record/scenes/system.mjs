// Scene f - System: the overview and its performance charts, the top query shapes, one shape drilled into.
import { open, click, glide, wait as sleep, smoothScroll } from "../lib.mjs";

export const cut = { start: 0.4, speed: 1.5 };

export default async (env) => {
  const { page, rec } = env;
  await open(env, "/query", { settle: 1200 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await glide(env, 700, 300, 1);
  await rec.start();
  rec.mark("start");
  await sleep(300);
  await click(env, "#navSystemLink", { ms: 750 });
  await page.getByText("Performance").first().waitFor({ timeout: 20000 });
  rec.mark("overview");
  await sleep(1500);
  rec.mark("scrollStart");
  await smoothScroll(page, ".systemPage__panel", 1100, 1200);
  rec.mark("perf");
  await sleep(500);
  const canvas = page.locator("canvas:visible").first();
  const b = await canvas.boundingBox();
  await glide(env, b.x + b.width * 0.35, b.y + b.height * 0.5, 700);
  for (const f of [0.5, 0.66]) { await glide(env, b.x + b.width * f, b.y + b.height * 0.5, 420); await sleep(160); }
  await sleep(300);
  // The Queries link carries the user filter (the address that the app itself builds for that filter), so that the list
  // shows the workload of the demo and not the traffic of the test stack that shares this ClickHouse.
  await page.evaluate(() => { const a = [...document.querySelectorAll("a")].find((x) => x.textContent.trim() === "Queries" && x.getAttribute("href") === "/system/queries"); if (a) a.setAttribute("href", "/system/queries?user=dash_runner"); });
  await click(env, page.getByText("Queries", { exact: true }).first(), { ms: 800 });
  await page.locator("tbody tr").nth(2).waitFor({ timeout: 20000 });
  await sleep(1400);
  rec.mark("queries");
  rec.mark("filtered");
  await click(env, page.locator("tbody tr").filter({ hasText: "ServiceName, count()" }).first(), { ms: 800, dx: -200 });
  await page.waitForURL(/\/system\/queries\/[0-9a-f]+/, { timeout: 20000 });
  await sleep(2600);
  rec.mark("shape");
  await rec.stop();
};
