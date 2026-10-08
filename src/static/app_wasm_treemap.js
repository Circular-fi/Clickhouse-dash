(() => {
  "use strict";
  // The adapter of src/wasm/treemap.c (src/static/wasm/treemap.wasm): the squarified layout of app_explorer_treemap.js.
  //
  //   ops.treemap.layout(kernel, { bytes, other, x, y, width, height, totalBytes, otherBytes, constants })
  //     bytes: Float64Array of the group's nodes, sorted as compareNodes() sorts them, all above zero
  //     other: Uint8Array, 1 for the kind "other"
  //     constants: [minimum regular height, Others inline height, Others stacked height, Others inline width]
  //     -> { count, index: Int32Array(count), rects: Float64Array(count * 4) }  (x, y, width, height per placed node, in layout order)
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  ns.wasm.ops.treemap = {
    layout(kernel, input) {
      return kernel.scope((k) => {
        const n = input.bytes.length;
        const bytes = k.putF64(input.bytes);
        const other = k.putBytes(input.other);
        const c = input.constants;
        const count = k.exports.tm_layout(bytes, other, n, input.x, input.y, input.width, input.height, input.totalBytes, input.otherBytes, c[0], c[1], c[2], c[3]);
        if (count < 0) return null;
        return {
          count,
          index: count ? k.readI32(k.exports.tm_index_ptr(), count) : new Int32Array(0),
          rects: count ? k.readF64(k.exports.tm_rect_ptr(), count * 4) : new Float64Array(0),
        };
      });
    },
  };
})();
