// loader: the modules a page loads when it needs them, and the page's own description.
//
// A page's modules are the ES modules its entry (app_page_<page>.js) imports: the browser loads them, in dependency
// order. The shell (tools/page_shells.py) adds the entry as a module script and inlines the page's description as
// <script type="application/json" id="chdashModules"> (src/static/modules.json, tools/build_page_css.py):
//
//   { name, entry, files, lazy }   files: every module the entry imports (the shell preloads them);
//                                  lazy: the groups of modules that load on first use
//
//   loader.page                    that description
//   loader.url(file)               the address of a static file (assetUrl)
//   loader.loadGroup(name)         Promise of the exports of the group's modules, one object ({} for a group the page
//                                  does not have): import() of each file, once. A page that has no highlighter, no
//                                  library or no kernel gets {}, and its code keeps the path without them.
//   loader.exposeAll()             hands the exports of every module of the page to window.ChDash (below)
//
// window.ChDash is the handle of the browser tests and of the console: every export of every module of the page, by
// name (ChDash.format, ChDash.header, ...). It is written here and read by no module.
import { assetUrl } from "./app_assets.js";

const page = (() => {
  try {
    const raw = document.getElementById("chdashModules")?.textContent || "";
    const entry = raw ? JSON.parse(raw) : null;
    if (entry && typeof entry === "object") return Object.freeze({ name: "", entry: "", files: [], lazy: {}, ...entry });
  } catch (error) {
    console.error(error);
  }
  return Object.freeze({ name: document.body?.dataset.page || "", entry: "", files: [], lazy: {} });
})();

function expose(exports) {
  const handle = (window.ChDash = window.ChDash || {});
  for (const [name, value] of Object.entries(exports)) handle[name] = value;
}

// A lazy module loads once. The browser keeps a module that failed to load as failed for the life of the page, whatever
// the file does later, so a new try asks for the file under another address (?retry=<n>): the next use, when the person
// presses Retry, gets the module the first one could not.
const modules = new Map(); // file -> { loading, failures }

function importFile(file) {
  let entry = modules.get(file);
  if (entry?.loading) return entry.loading;
  const failures = entry ? entry.failures : 0;
  const address = new URL(assetUrl(file));
  if (failures) address.searchParams.set("retry", String(failures));
  entry = { failures, loading: import(address.toString()) };
  entry.loading.catch(() => {
    modules.set(file, { failures: failures + 1, loading: null });
  });
  modules.set(file, entry);
  return entry.loading;
}

function loadGroup(name) {
  const files = page.lazy?.[name] || [];
  if (!files.length) return Promise.resolve({});
  return Promise.all(files.map(importFile)).then((loaded) => {
    const exports = Object.assign({}, ...loaded);
    expose(exports);
    return exports;
  });
}

async function exposeAll() {
  const loaded = await Promise.all(page.files.filter((file) => file !== page.entry).map((file) => import(assetUrl(file))));
  for (const exports of loaded) expose(exports);
}

export const loader = Object.freeze({ page, url: assetUrl, loadGroup, exposeAll });
