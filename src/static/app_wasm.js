(() => {
  "use strict";
  // ns.wasm: the loader of the WebAssembly kernels (docs/wasm.md). It runs in a page and in a Worker.
  //
  //   ns.wasm.supported            true when this browser has WebAssembly
  //   ns.wasm.load(name)           Promise<kernel | null>: fetches and instantiates src/static/wasm/<name>.wasm once.
  //                                It never rejects: a blocked, failed or refused file gives null, and the page keeps
  //                                its JavaScript path.
  //   ns.wasm.get(name)            the kernel when it is ready now, else null (a synchronous check for hot paths)
  //   ns.wasm.ops[name]            the functions of a kernel's adapter: ops[name].fn(kernel, args) -> result
  //   ns.wasm.worker(name, opsFile) { call(op, args, transfer) -> Promise, close() }: the same kernel in a Worker
  //   ns.wasm.stats                counters (loads, failures, streaming fallbacks) for the tests
  //
  // A kernel is { name, exports, view(), mark(), release(m), scope(fn), alloc(bytes), putU16(text), putBytes(u8),
  // putI32(a), putF64(a) }. Pointers are byte offsets into the instance memory. view() returns fresh typed views
  // of the memory: growing it detaches the old ones, so a caller takes a view after the last call that can grow.
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (ns.wasm) return;

  const supported = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
  const stats = { loads: 0, failures: 0, streamingFallbacks: 0 };
  const ops = {};
  const loads = new Map();
  const ready = new Map();
  // Absolute addresses of kernels, set by a Worker (it has no loader): urls[name] replaces the default address.
  const urls = {};

  // The host Math functions a kernel may import (src/wasm/rt.h): the numbers stay the ones of the JavaScript reference.
  const imports = () => ({
    env: { sin: Math.sin, cos: Math.cos, atan2: Math.atan2, pow: Math.pow, exp: Math.exp, log: Math.log, cbrt: Math.cbrt, hypot: Math.hypot },
  });

  const urlOf = (file) => (ns.loader && ns.loader.url ? ns.loader.url(file) : (root.location ? new URL(file, root.location.href).toString() : file));

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
      // fn(kernel) runs with an arena of its own: what it allocates is freed when it returns.
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
        const ptr = alloc(s.length * 2);
        const u16 = new Uint16Array(memory.buffer, ptr, s.length);
        for (let i = 0; i < s.length; i += 1) u16[i] = s.charCodeAt(i);
        return { ptr, length: s.length };
      },
      putBytes(bytes) {
        const ptr = alloc(bytes.byteLength);
        new Uint8Array(memory.buffer, ptr, bytes.byteLength).set(bytes);
        return ptr;
      },
      putI32(values) {
        const ptr = alloc(values.length * 4);
        new Int32Array(memory.buffer, ptr, values.length).set(values);
        return ptr;
      },
      putF64(values) {
        const ptr = alloc(values.length * 8);
        new Float64Array(memory.buffer, ptr, values.length).set(values);
        return ptr;
      },
      // A copy (not a view) of count items at ptr, safe after the memory grows or the arena is released.
      readI32: (ptr, count) => new Int32Array(memory.buffer, ptr, count).slice(),
      readU16: (ptr, count) => new Uint16Array(memory.buffer, ptr, count).slice(),
      readF64: (ptr, count) => new Float64Array(memory.buffer, ptr, count).slice(),
      readU8: (ptr, count) => new Uint8Array(memory.buffer, ptr, count).slice(),
      // A string from count UTF-16 code units at ptr, in chunks (String.fromCharCode.apply has an argument limit).
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
    // Streaming compiles while the bytes arrive; it needs the application/wasm type. Any failure retries
    // with the bytes (a proxy that renames the type, an old browser).
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
          if (root.console) console.warn(`WebAssembly kernel ${name} is not available: ${error && error.message ? error.message : error}`);
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

  // The kernel runs in a Worker of its own (app_wasm_worker.js), so a long layout never freezes the page.
  // Resolves with the same call() interface; resolves with null when Workers or the kernel are not available.
  function worker(name, opsFile) {
    if (workers.has(name)) return workers.get(name).ready;
    const entry = { ready: null, worker: null, pending: new Map(), next: 1, idle: null };
    const finish = (result) => result;
    entry.ready = new Promise((resolve) => {
      if (!supported || typeof Worker !== "function") return resolve(null);
      let instance = null;
      try {
        instance = new Worker(urlOf("app_wasm_worker.js"));
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
        if (m.type === "ready") return resolve(m.ok ? handle : (stop(), null));
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
        scripts: [urlOf("app_wasm.js"), urlOf(opsFile)],
      });
    }).then(finish);
    workers.set(name, entry);
    return entry.ready;
  }

  ns.wasm = { supported, load, get, ops, worker, stats, urls, instantiate: (bytes) => WebAssembly.instantiate(bytes, imports()).then((r) => wrap("bytes", r.instance)) };
})();
