(() => {
  "use strict";
  // The adapter of src/wasm/sqlscan.c (src/static/wasm/sqlscan.wasm): the text scans of the editor diagnostics of
  // app_autocomplete.js. It runs in the page, on a kernel that ns.wasm.load("sqlscan") gives it.
  //
  //   ops.sqlscan.names(kernel, { kw, func, tfunc, dtype })   upload the name sets (arrays of lower-case ASCII strings)
  //   ops.sqlscan.run(kernel, { text, flags })                flags: 1 relations, 2 selects, 4 function calls
  //     -> { status, hasFrom, sel, item, lam, ref, aj, rel, fn }   Int32Arrays of rows (the columns are listed in sqlscan.c)
  //   ops.sqlscan.statement(kernel, { text, pos })            { start, end } of the statement around pos (currentStatementAt)
  //   ops.sqlscan.split(kernel, { text })                     Int32Array of [start, end) pieces between the ";" of a script
  //   ops.sqlscan.statementStart(kernel, { text })            where the last statement of text starts (currentStatementBefore)
  //
  // The editor asks for the statement several times for one text (every key stroke): the last text stays in the instance.
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

  // The last text copied into the instance: { text, ptr, length, mark }. A copy lives above everything else the
  // instance keeps, so names() drops it first (the name tables must stay below the arena's top).
  let cached = null;
  const dropCached = (kernel) => {
    if (cached && cached.kernel === kernel) kernel.release(cached.mark);
    cached = null;
  };
  const cachedText = (kernel, text) => {
    if (cached && cached.kernel === kernel && cached.text === text) return cached;
    dropCached(kernel);
    const mark = kernel.mark();
    const input = kernel.putU16(text);
    cached = { kernel, text, ptr: input.ptr, length: input.length, mark };
    return cached;
  };

  ns.wasm.ops.sqlscan = {
    statement(kernel, { text, pos }) {
      const input = cachedText(kernel, text);
      return kernel.scope((k) => {
        const out = k.alloc(8);
        if (k.exports.sq_statement(input.ptr, input.length, pos, out) !== 0) return null;
        const rows = k.readI32(out, 2);
        return { start: rows[0], end: rows[1] };
      });
    },

    split(kernel, { text }) {
      return kernel.scope((k) => {
        const input = k.putU16(text);
        if (k.exports.sq_split(input.ptr, input.length) !== 0) return null;
        const count = k.exports.sq_vec_len(7);
        return count ? k.readI32(k.exports.sq_vec_ptr(7), count) : new Int32Array(0);
      });
    },

    statementStart(kernel, { text }) {
      const input = cachedText(kernel, text);
      return kernel.exports.sq_statement_before(input.ptr, input.length);
    },

    names(kernel, sets) {
      dropCached(kernel);
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
