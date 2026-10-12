// Scene b - Save: the query library, the Save query form (Name, Description, Folder), the saved query in its folder.
import { open, click, humanType, glide, moveTo, wait as sleep } from "../lib.mjs";

const SQL = `SELECT
    toStartOfHour(Timestamp) AS hour,
    count() AS spans,
    countIf(SpanKind = 'Client') AS client_spans
FROM otel.otel_traces
WHERE Timestamp > '2026-09-17'
GROUP BY hour
ORDER BY hour ASC`;

export const cut = { speed: 1.5 };

// The query that this scene saves is removed first, so that a second recording starts from the same library.
async function resetLibrary() {
  const api = process.env.API_URL || "http://127.0.0.1:18290";
  const lib = await (await fetch(`${api}/api/query-library?host_id=prod-eu-1`)).json();
  for (const q of lib.queries.filter((q) => q.name === "Spans per hour")) {
    await fetch(`${api}/api/query-library/queries/${q.id}`, { method: "DELETE", headers: { Origin: api } });
  }
}

export default async (env) => {
  const { page, rec } = env;
  await resetLibrary();
  await open(env, "/query?sql=" + encodeURIComponent(SQL), { settle: 1200 });
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await glide(env, 1000, 330, 1);
  await rec.start();
  rec.mark("start");
  await sleep(400);
  await click(env, "#queryLibraryButton", { ms: 750 });
  await page.getByRole("button", { name: "Save query" }).first().waitFor();
  rec.mark("libOpen");
  await rec.rect("lib", page.locator("#queryLibraryButton"), 4);
  await sleep(700);
  await click(env, page.getByRole("button", { name: "Save query" }).first(), { ms: 800 });
  rec.mark("form");
  await rec.rect("ghost", page.locator(".qlRow--ghost"), 2);
  await rec.rect("name", page.getByPlaceholder("e.g. Largest tables"), 3);
  await rec.rect("folderSel", page.locator("#qlForm-folder_id"), 3);
  await sleep(500);
  await click(env, page.getByPlaceholder("e.g. Largest tables"), { ms: 550 });
  rec.mark("typeStart");
  await humanType(env, "Spans per hour", { base: 20, jitter: 40, seed: 3 });
  await sleep(200);
  await click(env, page.getByPlaceholder(/What it answers/), { ms: 450 });
  await humanType(env, "Trace volume by hour, with the client calls", { base: 14, jitter: 26, seed: 9 });
  rec.mark("typed");
  await sleep(250);
  const folder = page.locator("#qlForm-folder_id");
  await moveTo(env, folder, { ms: 600 });
  await sleep(150);
  await folder.selectOption({ label: "/Observability" }).catch(async () => { await folder.selectOption({ index: 1 }); });
  rec.mark("folder");
  await rec.rect("ghost2", page.locator(".qlRow--ghost"), 2);
  await sleep(1100);
  await click(env, page.getByRole("button", { name: "Save", exact: true }), { ms: 700 });
  rec.mark("saved");
  await rec.rect("saved2", page.locator(".qlRow__name", { hasText: "Spans per hour" }).first(), 10);
  await rec.rect("saved", page.locator(".qlRow__name", { hasText: "Spans per hour" }).first(), 10);
  await sleep(1200, { keep: true });
  await glide(env, 600, 560, 600);
  await sleep(900, { keep: true });
  await rec.stop();
};
