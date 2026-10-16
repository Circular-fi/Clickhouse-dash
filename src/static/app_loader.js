// loader: the modules a page loads when it needs them, and the page's own description.
//
// The modules of a page are the ES modules that its entry (app_page_<page>.js) imports.
// The browser loads them in dependency order.
// The shell (tools/page_shells.py) adds the entry as a module script. It inlines the page description as
// <script type="application/json" id="chdashModules"> (src/static/modules.json, tools/build_page_css.py):
//
//   { name, entry, files, lazy }   files: every module that the entry imports. The shell preloads them.
//                                  lazy: the groups of modules. Each group loads at first use.
//
//   loader.page                    the page description
//   loader.url(file)               the address of a static file (assetUrl)
//   loader.loadGroup(name)         Promise of the exports of the modules of the group, in one object.
//                                  The object is {} for a group that the page does not have.
//                                  The function calls import() for each file, once.
//                                  A page without a highlighter, a library or a kernel gets {}. Its code keeps the path without them.
//   loader.expose(namespaces)      gives the exports of the modules to window.ChDash (below).
//                                  The generated region of each entry calls it with every module of the page.
//
// window.ChDash is the handle for the browser tests and for the console. It holds every export of every module of the page,
// by name (ChDash.format, ChDash.header, ...). This file writes it. No module reads it.
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

// A lazy module loads only once. The browser keeps a module that failed to load as failed for the life of the page.
// This is true even when the file changes later. So a new try asks for the file under another address (?retry=<n>).
// The next use, when the person presses Retry, gets the module that the first try could not load.
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

// Gives the namespaces of the modules of a page to window.ChDash. The entry calls this function with the namespace of every module that it imports.
// The generated region of the entry makes this call while the entry runs. So the handle is complete before the load event of the page.
function exposeNamespaces(namespaces) {
  for (const exports of namespaces) expose(exports);
}

export const loader = Object.freeze({ page, url: assetUrl, loadGroup, expose: exposeNamespaces });
