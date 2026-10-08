(() => {
  "use strict";
  // The adapter of src/wasm/sqlscan.c (src/static/wasm/sqlscan.wasm): the text scans of the editor diagnostics of
  // app_autocomplete.js. It runs in the page, on a kernel that ns.wasm.load("sqlscan") gives it.
  //
  //   ops.sqlscan.names(kernel, { kw, func, tfunc, dtype })   upload the name sets (arrays of lower-case ASCII strings)
  //   ops.sqlscan.run(kernel, { text, flags })                flags: 1 relations, 2 selects, 4 function calls
  //     -> { status, hasFrom, sel, item, lam, ref, aj, rel, fn }   Int32Arrays of rows (the columns are listed in sqlscan.c)
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  const SETS = ["kw", "func", "tfunc", "dtype"];
  const ROWS = ["sel", "item", "lam", "ref", "aj", "rel", "fn"];

  // Each name is [length, code units...]; a name with a character beyond ASCII cannot equal the ASCII names the kernel looks up.
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

  ns.wasm.ops.sqlscan = {
    names(kernel, sets) {
      for (let which = 0; which < SETS.length; which += 1) {
        const packed = pack(sets[SETS[which]] || []);
        const ptr = kernel.alloc(packed.data.length * 2);
        new Uint16Array(kernel.memory.buffer, ptr, packed.data.length).set(packed.data);
        kernel.exports.sq_set_names(which, ptr, packed.data.length, packed.count);
      }
      return true;
    },

    run(kernel, { text, flags }) {
      return kernel.scope((k) => {
        const input = k.putU16(text);
        const status = k.exports.sq_run(input.ptr, input.length, flags);
        const out = { status, hasFrom: false };
        for (const name of ROWS) out[name] = new Int32Array(0);
        if (status !== 0) return out;
        out.hasFrom = k.exports.sq_has_from() !== 0;
        ROWS.forEach((name, id) => {
          const count = k.exports.sq_vec_len(id);
          if (count) out[name] = k.readI32(k.exports.sq_vec_ptr(id), count);
        });
        return out;
      });
    },
  };
})();
