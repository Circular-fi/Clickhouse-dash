"use strict";
// The Worker of a WebAssembly kernel (ns.wasm.worker, app_wasm.js). It loads app_wasm.js and the kernel's
// adapter (app_wasm_<name>.js), instantiates src/static/wasm/<name>.wasm, and answers {type: "call", id, op, args}
// with {id, result} or {id, error}. An adapter function may return { result, transfer } to hand buffers back
// without a copy.
(() => {
  let kernel = null;
  let name = "";
  const reply = (message, transfer) => self.postMessage(message, transfer || []);

  self.onmessage = async (event) => {
    const m = event.data || {};
    if (m.type === "init") {
      try {
        importScripts(...m.scripts);
        name = m.name;
        self.ChDash.wasm.urls[name] = m.wasmUrl;
        kernel = await self.ChDash.wasm.load(name);
        reply({ type: "ready", ok: !!kernel });
      } catch (error) {
        reply({ type: "ready", ok: false });
      }
      return;
    }
    if (m.type !== "call") return;
    try {
      const adapter = self.ChDash.wasm.ops[name];
      const fn = adapter && adapter[m.op];
      if (typeof fn !== "function") throw new Error(`No operation ${m.op} in ${name}`);
      const out = fn(kernel, m.args);
      if (out && out.transfer) reply({ id: m.id, result: out.result }, out.transfer);
      else reply({ id: m.id, result: out });
    } catch (error) {
      reply({ id: m.id, error: String(error && error.message ? error.message : error) });
    }
  };
})();
