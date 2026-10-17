// wasm: the loader of the WebAssembly kernels (docs/wasm.md). It runs in a page and in a Worker (a module Worker).
//
//   wasm.supported            true when this browser has WebAssembly
//   wasm.load(name)           Promise<kernel | null>: fetches and instantiates src/static/wasm/<name>.wasm once.
//                                It never rejects: a blocked, failed or refused file gives null, and the page keeps
//                                its JavaScript path.
//   wasm.get(name)            the kernel when it is ready now, else null (a synchronous check for hot paths)
//   wasm.ops[name]            the functions of a kernel's adapter: ops[name].fn(kernel, args) -> result
//   wasm.worker(name) { call(op, args, transfer) -> Promise, close() }: the same kernel in a Worker, with the adapter app_wasm_<name>.js
//   wasm.stats                counters (loads, failures, streaming fallbacks) for the tests
//   wasm.maxInputUnits        the most items that putU16, putBytes, putI32 and putF64 copy into a kernel (a larger input throws a RangeError)
//
// A kernel is { name, exports, view(), mark(), release(m), scope(fn), alloc(bytes), putU16(text), putBytes(u8),
// putI32(a), putF64(a) }. Pointers are byte offsets into the instance memory. view() returns fresh typed views
// of the memory. A call that grows the memory detaches the old views. Take a view after the last call that can grow the memory.
import { assetUrl } from "./app_assets.js";

const supported = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
const stats = { loads: 0, failures: 0, streamingFallbacks: 0 };
const ops = {};
const loads = new Map();
const ready = new Map();
// Absolute addresses of kernels. A Worker sets them, because it has no version map. urls[name] replaces the default address.
const urls = {};

// The host Math functions that a kernel may import (src/wasm/rt.h). The numbers stay the same as the JavaScript reference.
const imports = () => ({
  env: { sin: Math.sin, cos: Math.cos, atan2: Math.atan2, pow: Math.pow, exp: Math.exp, log: Math.log, cbrt: Math.cbrt, hypot: Math.hypot },
});

const urlOf = assetUrl;

// The most items (UTF-16 code units, numbers or bytes) that the page copies into a kernel in one array. The kernels compute sizes in 32 bits (wasm32).
// A kernel multiplies a count by the size of its records without a check: the token array of the highlighter takes 20 bytes for each code unit,
// so a text of 214,748,364 units makes that size wrap, and the kernel then writes past its allocation. The page refuses an input above this limit
// before it copies one item. The caller then keeps its JavaScript path. The limit is far above the inputs of the page (a query is at most 64 MiB).
const MAX_INPUT_UNITS = 1 << 24;
const checkInput = (name, count) => {
  if (count > MAX_INPUT_UNITS) throw new RangeError(`The input of the WebAssembly kernel ${name} is too large (${count} items, the limit is ${MAX_INPUT_UNITS})`);
};

function wrap(name, instance) {
  const exports = instance.exports;
  const memory = exports.memory;
  const view = () => {
    const buffer = memory.buffer;
    return {
      u8: new Uint8Array(buffer),
      u16: new Uint16Array(buffer),
      i32: new Int32Array(buffer),
      u32: new Uint32Array(buffer),
      f32: new Float32Array(buffer),
      f64: new Float64Array(buffer),
    };
  };
  const alloc = (bytes) => {
    const ptr = exports.wasm_alloc_bytes(Math.max(1, bytes) >>> 0) >>> 0;
    if (!ptr) throw new RangeError(`WebAssembly memory exhausted (${name})`);
    return ptr;
  };
  const kernel = {
    name,
    exports,
    memory,
    view,
    alloc,
    mark: () => exports.wasm_mark() >>> 0,
    release: (mark) => exports.wasm_release(mark),
    // fn(kernel) runs with an arena of its own. Everything it allocates is freed when it returns.
    scope(fn) {
      const mark = exports.wasm_mark();
      try {
        return fn(kernel);
      } finally {
        exports.wasm_release(mark);
      }
    },
    // The UTF-16 code units of a string: { ptr, length }. Lone surrogates survive, so offsets stay JavaScript string indexes.
    putU16(text) {
      const s = String(text);
      checkInput(name, s.length);
      const ptr = alloc(s.length * 2);
      const u16 = new Uint16Array(memory.buffer, ptr, s.length);
      for (let i = 0; i < s.length; i += 1) u16[i] = s.charCodeAt(i);
      return { ptr, length: s.length };
    },
    putBytes(bytes) {
      checkInput(name, bytes.byteLength);
      const ptr = alloc(bytes.byteLength);
      new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes);
      return ptr;
    },
    putI32(values) {
      checkInput(name, values.length);
      const ptr = alloc(values.length * 4);
      new Int32Array(memory.buffer, ptr, values.length).set(values);
      return ptr;
    },
    putF64(values) {
      checkInput(name, values.length);
      const ptr = alloc(values.length * 8);
      new Float64Array(memory.buffer, ptr, values.length).set(values);
      return ptr;
    },
    // A copy (not a view) of count items at ptr. The copy stays valid after the memory grows or the arena is released.
    readI32: (ptr, count) => new Int32Array(memory.buffer, ptr, count).slice(),
    readU16: (ptr, count) => new Uint16Array(memory.buffer, ptr, count).slice(),
    readF64: (ptr, count) => new Float64Array(memory.buffer, ptr, count).slice(),
    readU8: (ptr, count) => new Uint8Array(memory.buffer, ptr, count).slice(),
    // A string from count UTF-16 code units at ptr. It reads the units in chunks, because String.fromCharCode.apply has an argument limit.
    readString(ptr, count) {
      const u16 = new Uint16Array(memory.buffer, ptr, count);
      if (count <= 8192) return String.fromCharCode.apply(null, u16);
      const parts = [];
      for (let i = 0; i < count; i += 8192) parts.push(String.fromCharCode.apply(null, u16.subarray(i, Math.min(count, i + 8192))));
      return parts.join("");
    },
  };
  return kernel;
}

async function instantiate(url) {
  // Streaming compiles the module while the bytes arrive. It needs the application/wasm type. After any failure, the loader retries with the bytes
  // (a proxy that renames the type, an old browser).
  if (typeof WebAssembly.instantiateStreaming === "function" && typeof fetch === "function") {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await WebAssembly.instantiateStreaming(response, imports())).instance;
    } catch (error) {
      stats.streamingFallbacks += 1;
    }
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await WebAssembly.instantiate(await response.arrayBuffer(), imports())).instance;
}

function load(name) {
  let pending = loads.get(name);
  if (pending) return pending;
  if (!supported) {
    pending = Promise.resolve(null);
  } else {
    stats.loads += 1;
    pending = instantiate(urls[name] || urlOf(`wasm/${name}.wasm`)).then(
      (instance) => {
        const kernel = wrap(name, instance);
        ready.set(name, kernel);
        return kernel;
      },
      (error) => {
        stats.failures += 1;
        if (typeof console !== "undefined") console.warn(`WebAssembly kernel ${name} is not available: ${error && error.message ? error.message : error}`);
        return null;
      }
    );
  }
  loads.set(name, pending);
  return pending;
}

const get = (name) => ready.get(name) || null;

// ------------------------------------------------------------------ Worker

const IDLE_MS = 20000;
const workers = new Map();

// The kernel runs in a Worker of its own (app_wasm_worker.js). A long layout does not freeze the page.
// It resolves with the same call() interface. It resolves with null when Workers or the kernel are not available.
function worker(name, opsFile = `app_wasm_${name}.js`) {
  if (workers.has(name)) return workers.get(name).ready;
  const entry = { ready: null, worker: null, pending: new Map(), next: 1, idle: null };
  const finish = (result) => result;
  entry.ready = new Promise((resolve) => {
    if (!supported || typeof Worker !== "function") return resolve(null);
    let instance = null;
    try {
      instance = new Worker(urlOf("app_wasm_worker.js"), { type: "module" });
    } catch (error) {
      return resolve(null);
    }
    entry.worker = instance;
    const stop = () => {
      entry.worker = null;
      workers.delete(name);
      for (const { reject } of entry.pending.values()) reject(new Error("The WebAssembly Worker stopped"));
      entry.pending.clear();
      try {
        instance.terminate();
      } catch (error) {
        // already gone
      }
    };
    const handle = {
      call(op, args, transfer) {
        return new Promise((done, fail) => {
          if (!entry.worker) return fail(new Error("The WebAssembly Worker stopped"));
          const id = entry.next++;
          entry.pending.set(id, { resolve: done, reject: fail });
          if (entry.idle) clearTimeout(entry.idle);
          entry.idle = setTimeout(stop, IDLE_MS);
          instance.postMessage({ type: "call", id, op, args }, transfer || []);
        });
      },
      close: stop,
    };
    instance.onmessage = (event) => {
      const m = event.data || {};
      if (m.type === "ready") {
        if (m.ok) entry.idle = setTimeout(stop, IDLE_MS);
        return resolve(m.ok ? handle : (stop(), null));
      }
      const waiting = entry.pending.get(m.id);
      if (!waiting) return;
      entry.pending.delete(m.id);
      if (m.error) waiting.reject(new Error(m.error));
      else waiting.resolve(m.result);
    };
    instance.onerror = () => {
      stop();
      resolve(null);
    };
    instance.postMessage({
      type: "init",
      name,
      wasmUrl: urlOf(`wasm/${name}.wasm`),
      adapter: urlOf(opsFile),
    });
  }).then(finish);
  workers.set(name, entry);
  return entry.ready;
}

export const wasm = { supported, load, get, ops, worker, stats, urls, maxInputUnits: MAX_INPUT_UNITS, instantiate: (bytes) => WebAssembly.instantiate(bytes, imports()).then((r) => wrap("bytes", r.instance)) };
