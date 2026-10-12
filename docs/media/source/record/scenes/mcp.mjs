// Scene g - MCP: the access keys, one key opened with its permission cards (Observability - Traces / Logs / Metrics).
import { open, click, glide, moveTo, wait as sleep, smoothScroll } from "../lib.mjs";

export const cut = { start: 0.4, speed: 1.1 };

export default async (env) => {
  const { page, rec } = env;
  await open(env, "/query", { settle: 1200 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await glide(env, 700, 300, 1);
  await rec.start();
  rec.mark("start");
  await sleep(300);
  await click(env, "#navMcpLink", { ms: 750 });
  await page.getByText("Access keys").first().waitFor({ timeout: 20000 });
  rec.mark("keys");
  await sleep(1200);
  await click(env, page.getByText("claude-analyst", { exact: true }).first(), { ms: 750 });
  await page.getByText("Data it reads").waitFor({ timeout: 20000 });
  rec.mark("open");
  await sleep(900);
  await moveTo(env, page.getByText("Observability - Traces", { exact: true }), { ms: 700, dy: 50 });
  await sleep(450);
  await moveTo(env, page.getByText("Observability - Logs", { exact: true }), { ms: 600, dx: -160, dy: 40 });
  await sleep(400);
  await moveTo(env, page.getByText("Observability - Metrics", { exact: true }), { ms: 600, dy: 40 });
  await sleep(1100);
  await rec.stop();
};
