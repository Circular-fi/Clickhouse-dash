(() => {
  "use strict";
  // The adapter of src/wasm/color.c (src/static/wasm/color.wasm): the colour arithmetic of the page, in batches.
  // Every op answers { status: Uint8Array, ... }: per item 0 done, 1 "the JavaScript function returns its input unchanged",
  // 2 "the kernel does not decide" (the caller runs the JavaScript function for that item).
  //
  //   normalize(kernel, { texts })              texts: string[]                   -> { status, texts }   (app_palette.js normalize)
  //   parseChart(kernel, { texts })             texts: string[]                   -> { status, nums }    (r, g, b, a per item: chart parseColor)
  //   rgba(kernel, { colors, alphas })          Float64Array(4n), Float64Array(n) -> { status, texts }   (chart rgba)
  //   mix(kernel, { x, y, t })                  x, y: [r, g, b, a], t: Float64Array(n) -> { status, texts }  (graph kit mixColor)
  //   readable(kernel, { texts })               resolved fills, then the light and the dark label -> { status, dark } (readableText)
  //   hashSlots(kernel, { texts, slots })       names                              -> { status, nums }    (FNV-1a slot)
  //   steps(kernel, { t, steps })               Float64Array                       -> { status, nums }    (sequential step, 1 based)
  //   categorical(kernel, { v, slots })         Float64Array                       -> { status, nums }    (slot 1 based, 0 neutral)
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  // The strings in one UTF-16 buffer and the table of their offsets.
  function putTexts(k, texts) {
    let total = 0;
    for (const text of texts) total += text.length;
    const ptr = k.alloc(total * 2);
    const u16 = new Uint16Array(k.memory.buffer, ptr, total);
    const offsets = new Int32Array(texts.length + 1);
    let at = 0;
    for (let i = 0; i < texts.length; i += 1) {
      const text = texts[i];
      offsets[i] = at;
      for (let j = 0; j < text.length; j += 1) u16[at++] = text.charCodeAt(j);
    }
    offsets[texts.length] = at;
    return { ptr, offsetsPtr: k.putI32(offsets) };
  }

  // The output of the last call: statuses and, per kind, the strings or the numbers.
  function collect(k, n, kind, width) {
    const e = k.exports;
    const status = k.readU8(e.col_out_status(), n);
    if (kind === "numbers") return { status, nums: k.readF64(e.col_out_numbers(), n * width) };
    const offsets = k.readI32(e.col_out_offsets(), n + 1);
    const text = k.readString(e.col_out_text(), offsets[n]);
    const texts = new Array(n);
    for (let i = 0; i < n; i += 1) texts[i] = status[i] === 0 ? text.slice(offsets[i], offsets[i + 1]) : null;
    return { status, texts };
  }

  const stringsOf = (k, name, texts) => {
    const n = texts.length;
    const input = putTexts(k, texts);
    return { n, input, code: k.exports[name](input.ptr, input.offsetsPtr, n) };
  };

  ns.wasm.ops.color = {
    normalize: (kernel, { texts }) => kernel.scope((k) => {
      const r = stringsOf(k, "col_normalize", texts);
      return r.code < 0 ? null : collect(k, r.n, "strings");
    }),
    parseChart: (kernel, { texts }) => kernel.scope((k) => {
      const r = stringsOf(k, "col_parse_chart", texts);
      return r.code < 0 ? null : collect(k, r.n, "numbers", 4);
    }),
    rgba: (kernel, { colors, alphas }) => kernel.scope((k) => {
      const n = alphas.length;
      const code = k.exports.col_rgba(k.putF64(colors), k.putF64(alphas), n);
      return code < 0 ? null : collect(k, n, "strings");
    }),
    mix: (kernel, { x, y, t }) => kernel.scope((k) => {
      const n = t.length;
      const code = k.exports.col_mix(k.putF64(x), k.putF64(y), k.putF64(t), n);
      return code < 0 ? null : collect(k, n, "strings");
    }),
    readable: (kernel, { texts }) => kernel.scope((k) => {
      const r = stringsOf(k, "col_readable", texts);
      if (r.code < 0) return null;
      const out = collect(k, r.n - 2, "numbers", 1);
      return { status: out.status, dark: out.nums };
    }),
    hashSlots: (kernel, { texts, slots }) => kernel.scope((k) => {
      const n = texts.length;
      const input = putTexts(k, texts);
      const code = k.exports.col_hash_slots(input.ptr, input.offsetsPtr, n, slots);
      return code < 0 ? null : collect(k, n, "numbers", 1);
    }),
    steps: (kernel, { t, steps }) => kernel.scope((k) => {
      const code = k.exports.col_steps(k.putF64(t), t.length, steps);
      return code < 0 ? null : collect(k, t.length, "numbers", 1);
    }),
    categorical: (kernel, { v, slots }) => kernel.scope((k) => {
      const code = k.exports.col_categorical(k.putF64(v), v.length, slots);
      return code < 0 ? null : collect(k, v.length, "numbers", 1);
    }),
  };
})();
