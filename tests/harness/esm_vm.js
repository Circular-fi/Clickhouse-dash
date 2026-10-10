// Loads the ES modules of src/static in a bare vm context, for the Node unit checks of the harness and the model tests.
//
//   const { load } = require("./esm_vm");
//   const run = await load({ root, globals: { Intl, Date, ... }, stubs: { "app_dom.js": { dom: {...} } }, real: [...] });
//   const { format, palette } = await run.import("app_palette.js") ...
//
// Every call of load() is a fresh context with fresh module instances: a check that needs another window.sessionStorage
// loads again. A stub replaces a module by name; the names that its importers ask for and the stub does not give are
// deep stubs (callable, any property is one too), so the module under test links without the page behind it. Run it
// with `node --experimental-vm-modules`.
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function memoryStorage(data = new Map()) {
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), removeItem: (key) => data.delete(key) };
}

// Callable, and every property is one more such function.
function deepStub() {
  const target = function () {};
  return new Proxy(target, {
    get: (_, key) => (key === Symbol.toPrimitive ? () => "" : key === "then" ? undefined : deepStub()),
    apply: () => deepStub(),
    construct: () => deepStub(),
  });
}

// The names any module of src/static imports from `file`: a stub gives all of them.
function namesImported(staticDir, file) {
  const names = new Set();
  const pattern = /^import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];/gm;
  for (const entry of fs.readdirSync(staticDir)) {
    if (!/^app_.*\.js$/.test(entry)) continue;
    const source = fs.readFileSync(path.join(staticDir, entry), "utf8");
    for (const match of source.matchAll(pattern)) {
      if (match[2].replace(/\?.*$/, "") !== `./${file}`) continue;
      for (const part of match[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

async function load({ root, globals = {}, stubs = {}, window = null } = {}) {
  const staticDir = path.join(root, "src", "static");
  const sandbox = {
    Intl, Date, Math, JSON, Number, String, Object, Map, Set, Array, RegExp, WeakMap, BigInt, Promise, Symbol, Error, TypeError, console,
    Uint8Array, Uint16Array, Int32Array, Float64Array, ArrayBuffer, URL, URLSearchParams, setTimeout, clearTimeout,
    window: window || { sessionStorage: memoryStorage(), localStorage: memoryStorage() },
    document: { getElementById: () => null, body: null, readyState: "complete", addEventListener() {}, documentElement: {} },
    ...globals,
  };
  const context = vm.createContext(sandbox);
  const modules = new Map();

  async function get(file) {
    if (modules.has(file)) return modules.get(file);
    let module;
    if (stubs[file]) {
      const wanted = new Set([...Object.keys(stubs[file]), ...namesImported(staticDir, file)]);
      const values = Object.fromEntries([...wanted].map((name) => [name, name in stubs[file] ? stubs[file][name] : deepStub()]));
      module = new vm.SyntheticModule([...wanted], function () { for (const [name, value] of Object.entries(values)) this.setExport(name, value); }, { context, identifier: file });
      modules.set(file, module);
      return module;
    }
    const code = fs.readFileSync(path.join(staticDir, file), "utf8");
    module = new vm.SourceTextModule(code, {
      context,
      identifier: file,
      initializeImportMeta(meta) { meta.url = `file://${path.join(staticDir, file)}`; },
    });
    modules.set(file, module);
    return module;
  }

  return {
    context,
    window: sandbox.window,
    // The namespace of a module (its exports), evaluated with everything it imports.
    async import(file) {
      const module = await get(file);
      // Node links the dependencies the linker hands back, recursively, and evaluates them before the module.
      if (module.status === "unlinked") await module.link(async (specifier) => get(specifier.replace(/^\.\//, "").replace(/\?.*$/, "")));
      if (module.status === "linked") await module.evaluate();
      return module.namespace;
    },
  };
}

module.exports = { load, memoryStorage, deepStub };
