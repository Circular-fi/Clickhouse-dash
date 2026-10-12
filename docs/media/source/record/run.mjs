// node run.mjs <scene> [<scene> ...]   (scenes live in scenes/<name>.mjs and export default async (env) => ...)
import { launch, Recorder, OUT, setRecorder } from "./lib.mjs";
import { mkdirSync } from "node:fs";
import { prep } from "./prep.mjs";
mkdirSync(OUT, { recursive: true });
const prepOnly = process.argv.includes("--prep-only");
for (const name of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const mod = await import(`./scenes/${name}.mjs`);
  if (prepOnly) { prep(name, mod.cut); continue; }
  const env = await launch(mod.storage ? { storage: mod.storage } : {});
  env.rec = new Recorder(env.page, name);
  setRecorder(env.rec);
  try { await mod.default(env); } catch (e) { await env.page.screenshot({ path: `${OUT}/err_${name}.png` }).catch(() => {}); console.error(e.message.split('\n')[0]); process.exitCode = 1; } finally { await env.browser.close(); }
  if (!process.exitCode) prep(name, mod.cut);
}
