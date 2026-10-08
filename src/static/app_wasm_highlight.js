(() => {
  "use strict";
  // The adapter of src/wasm/highlight.c (src/static/wasm/highlight.wasm): the SQL lexer of app_highlight.js.
  // It runs in the page and in a Worker, on a kernel that ns.wasm.load("highlight") or the Worker gives it.
  //
  //   ops.highlight.meta(kernel, { kw, cs, ci, aggCs, aggCi })   upload the host's keyword and function name sets (arrays of
  //                                                              strings; null for a set the host does not have)
  //   ops.highlight.run(kernel, { text })                        { status, count, tokens: Int32Array(count * 5), html }
  //                                                              status 0: done; -2: a name only JavaScript can judge (use the
  //                                                              reference); -1: no memory
  //
  // A token is five numbers: start, end, kind (0 plain, 1 kw, 2 fn, 3 num, 4 null, 5 type, 6 str, 7 com), then the start and the end of
  // the token's HTML inside the one HTML string.
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  // Names the kernel can match are ASCII: a name with another character cannot equal a word of the lexer. (A quoted name
  // can; the kernel answers "use the reference" then.)
  const pack = (names) => {
    const list = [];
    let units = 0;
    for (const name of names) {
      const text = String(name);
      let ascii = true;
      for (let i = 0; i < text.length; i += 1) {
        if (text.charCodeAt(i) >= 128) {
          ascii = false;
          break;
        }
      }
      if (!ascii) continue;
      list.push(text);
      units += text.length + 1;
    }
    const data = new Uint16Array(units);
    let at = 0;
    for (const text of list) {
      data[at++] = text.length;
      for (let i = 0; i < text.length; i += 1) data[at++] = text.charCodeAt(i);
    }
    return { data, count: list.length };
  };

  const SETS = ["kw", "cs", "ci", "aggCs", "aggCi"];

  ns.wasm.ops.highlight = {
    meta(kernel, sets) {
      for (let which = 0; which < SETS.length; which += 1) {
        const names = sets[SETS[which]];
        const packed = pack(names || []);
        // The tables stay in the memory of the instance: allocated outside any scope.
        const ptr = kernel.alloc(packed.data.length * 2);
        new Uint16Array(kernel.memory.buffer, ptr, packed.data.length).set(packed.data);
        kernel.exports.hl_set_names(which, ptr, packed.data.length, packed.count);
      }
      kernel.exports.hl_set_flags(sets.kw ? 1 : 0, sets.cs && sets.ci ? 1 : 0, sets.aggCs && sets.aggCi ? 1 : 0);
      return true;
    },

    run(kernel, { text }) {
      return kernel.scope((k) => {
        const input = k.putU16(text);
        const count = k.exports.hl_run(input.ptr, input.length);
        if (count < 0) return { status: count, count: 0, tokens: new Int32Array(0), html: "" };
        const tokens = count ? k.readI32(k.exports.hl_tokens_ptr(), count * 5) : new Int32Array(0);
        const html = count ? k.readString(k.exports.hl_html_ptr(), k.exports.hl_html_length()) : "";
        return { status: 0, count, tokens, html };
      });
    },
  };
})();
