// The Worker of a WebAssembly kernel (wasm.worker, app_wasm.js), a module Worker. It imports app_wasm.js, loads the
// kernel's adapter (app_wasm_<name>.js, which registers its operations in wasm.ops), instantiates
// src/static/wasm/<name>.wasm, and answers {type: "call", id, op, args} with {id, result} or {id, error}. An adapter
// function may return { result, transfer } to hand buffers back without a copy.
import { wasm } from "./app_wasm.js";

let kernel = null;
let name = "";
const reply = (message, transfer) => self.postMessage(message, transfer || []);

self.onmessage = async (event) => {
  const m = event.data || {};
  if (m.type === "init") {
    try {
      name = m.name;
      wasm.urls[name] = m.wasmUrl;
      await import(m.adapter);
      kernel = await wasm.load(name);
      reply({ type: "ready", ok: !!kernel });
    } catch (error) {
      reply({ type: "ready", ok: false });
    }
    return;
  }
  if (m.type !== "call") return;
  try {
    const adapter = wasm.ops[name];
    const fn = adapter && adapter[m.op];
    if (typeof fn !== "function") throw new Error(`No operation ${m.op} in ${name}`);
    const out = fn(kernel, m.args);
    if (out && out.transfer) reply({ id: m.id, result: out.result }, out.transfer);
    else reply({ id: m.id, result: out });
  } catch (error) {
    reply({ id: m.id, error: String(error && error.message ? error.message : error) });
  }
};
