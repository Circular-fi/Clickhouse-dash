(() => {
  "use strict";
  // The adapter of src/wasm/rowsort.c (src/static/wasm/rowsort.wasm): the row order of a numeric result column
  // (app_results.js, orderByKeysJs).
  //
  //   ops.rowsort.numeric(kernel, { vals, nulls, rank, desc }) -> Uint32Array: the row positions in sorted order
  //     vals Float64Array, nulls Uint8Array (1: missing, last when ascending), rank Float64Array (tie break), desc boolean
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  ns.wasm.ops.rowsort = {
    numeric(kernel, { vals, nulls, rank, desc }) {
      const n = vals.length;
      return kernel.scope((k) => {
        const v = k.putF64(vals);
        const z = k.putBytes(nulls);
        const r = k.putF64(rank);
        if (k.exports.rs_numeric(v, z, r, n, desc ? 1 : 0) !== 0) return null;
        return n ? new Uint32Array(k.readI32(k.exports.rs_order_ptr(), n).buffer) : new Uint32Array(0);
      });
    },
  };
})();
