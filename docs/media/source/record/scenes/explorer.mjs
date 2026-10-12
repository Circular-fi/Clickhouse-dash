// Scene c - Explorer: the catalog, a database, a table (columns, parts, DDL), then the lineage graph.
import { open, click, glide, moveTo, wait as sleep } from "../lib.mjs";

export const cut = { start: 0.4, speed: 1.3 };

export default async (env) => {
  const { page, rec } = env;
  await open(env, "/query", { settle: 1200 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await glide(env, 700, 300, 1);
  await rec.start();
  rec.mark("start");
  await sleep(350);
  await click(env, "#navExplorerLink", { ms: 750 });
  await page.getByText("All databases").first().waitFor();
  rec.mark("catalog");
  await sleep(1000);
  await click(env, page.locator("#explorerTree, nav, aside").getByText("chdash_ui", { exact: true }).first(), { ms: 700 });
  rec.mark("db");
  await sleep(1100);
  await click(env, page.locator("tbody").getByText("weather_observations", { exact: true }).first(), { ms: 800 });
  rec.mark("table");
  await sleep(1300);
  await click(env, page.getByRole("tab", { name: "Storage" }), { ms: 600 });
  rec.mark("storage");
  await sleep(1000);
  await click(env, page.getByRole("tab", { name: "DDL" }), { ms: 450 });
  rec.mark("ddl");
  await sleep(1000);
  await click(env, page.getByRole("tab", { name: "Graph" }).first(), { ms: 700 });
  rec.mark("graph");
  await sleep(2000, { keep: true });
  await rec.stop();
};
