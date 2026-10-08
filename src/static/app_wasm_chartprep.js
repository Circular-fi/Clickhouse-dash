(() => {
  "use strict";
  // The adapter of src/wasm/chartprep.c (src/static/wasm/chartprep.wasm): the general path of the Query chart model
  // (app_query_chart.js, generalPathJs).
  //
  //   ops.chartprep.general(kernel, { X, n, series, codes, groupSlotOf, groupCount, perSeries, categoryCount })
  //     X           Float64Array: the x of every row (category codes for a category axis)
  //     series      array of Float64Array (n values each, NaN for a missing value), one per series column
  //     codes       Float64Array of group codes, or null without groups; groupSlotOf Int32Array: code -> slot or -1 (Other)
  //     categoryCount  the number of categories for a category axis, else 0 (no sorting then)
  //   -> { u, xs: Float64Array(u), values: [Float64Array(u)], nulls: [Uint8Array(u)], skipped, summed } or null (no memory)
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  ns.wasm.ops.chartprep = {
    general(kernel, input) {
      const { X, n, series, codes, groupSlotOf, groupCount, perSeries, categoryCount } = input;
      return kernel.scope((k) => {
        const x = k.putF64(X.subarray(0, n));
        const columns = k.alloc(Math.max(1, series.length) * n * 8);
        for (let j = 0; j < series.length; j += 1) new Float64Array(k.memory.buffer, columns + j * n * 8, n).set(series[j].subarray(0, n));
        const codePtr = codes ? k.putF64(codes.subarray(0, n)) : 0;
        const slotPtr = codes ? k.putI32(groupSlotOf) : 0;
        const u = k.exports.cp_general(x, n, columns, series.length, codePtr, slotPtr, groupCount, perSeries, categoryCount);
        if (u < 0) return null;
        const lines = series.length * perSeries;
        const valuesPtr = k.exports.cp_values();
        const nullsPtr = k.exports.cp_nulls();
        const values = [];
        const nulls = [];
        for (let li = 0; li < lines; li += 1) {
          values.push(k.readF64(valuesPtr + li * u * 8, u));
          nulls.push(k.readU8(nullsPtr + li * u, u));
        }
        return { u, xs: categoryCount ? null : k.readF64(k.exports.cp_xs(), u), values, nulls, skipped: k.exports.cp_skipped(), summed: k.exports.cp_summed() !== 0 };
      });
    },
  };
})();
