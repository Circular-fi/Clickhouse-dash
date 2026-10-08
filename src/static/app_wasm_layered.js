(() => {
  "use strict";
  // The adapter of src/wasm/layered.c (src/static/wasm/layered.wasm): the layered layout of app_graph_kit.js (layered()), as far
  // as the order of the cards and their rows. It runs in the page and in a Worker.
  //
  //   ops.layered.run(kernel, input)   input: { n, ne, from, to, rank, queueRank, weight, flags } (typed arrays, see pack())
  //                                    returns { status, level, order, row, back } (status 0 is done; -2: use the reference)
  //
  // ns.wasm.layered.pack(options) turns the options of kit.layered() into that input (null when the kernel cannot take them: two
  // cards with one id, two edges with one id); ns.wasm.layered.unpack(options, result) gives { columns, levels, level, backEdges,
  // lineageRows } as the reference computes them.
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  ns.wasm.ops.layered = {
    run(kernel, input) {
      return kernel.scope((k) => {
        const from = k.putI32(input.from);
        const to = k.putI32(input.to);
        const rank = k.putI32(input.rank);
        const queueRank = k.putI32(input.queueRank);
        const weight = k.putF64(input.weight);
        const status = k.exports.ly_run(input.n, input.ne, from, to, rank, queueRank, weight, input.flags);
        if (status !== 0) return { status };
        return {
          status: 0,
          level: k.readI32(k.exports.ly_level_ptr(), input.n),
          order: k.readI32(k.exports.ly_order_ptr(), input.n),
          row: k.readI32(k.exports.ly_row_ptr(), input.n),
          back: k.readU8(k.exports.ly_back_ptr(), input.ne),
        };
      });
    },
  };

  // The rank of every item under compare(): equal ranks for items that compare equal.
  function ranks(items, compare) {
    const order = items.map((item, i) => i);
    order.sort((a, b) => compare(items[a], items[b]));
    const out = new Int32Array(items.length);
    let current = 0;
    for (let i = 0; i < order.length; i += 1) {
      if (i > 0 && compare(items[order[i - 1]], items[order[i]]) !== 0) current += 1;
      out[order[i]] = current;
    }
    return out;
  }

  function pack(options) {
    const nodes = options.nodes || [];
    const edges = options.edges || [];
    const index = new Map();
    for (let i = 0; i < nodes.length; i += 1) {
      if (index.has(nodes[i].id)) return null;
      index.set(nodes[i].id, i);
    }
    const edgeIds = new Set();
    for (const edge of edges) edgeIds.add(edge.id);
    if (edgeIds.size !== edges.length) return null;
    const compare = options.compare || ((a, b) => String(a.id).localeCompare(String(b.id)));
    const queueCompare = options.queueCompare || compare;
    const weightOf = options.weight || (() => 1);
    const from = new Int32Array(edges.length);
    const to = new Int32Array(edges.length);
    const weight = new Float64Array(edges.length);
    edges.forEach((edge, i) => {
      from[i] = index.has(edge.from) ? index.get(edge.from) : -1;
      to[i] = index.has(edge.to) ? index.get(edge.to) : -1;
      weight[i] = Number(weightOf(edge));
    });
    return {
      n: nodes.length, ne: edges.length, from, to, rank: ranks(nodes, compare), queueRank: ranks(nodes, queueCompare), weight,
      flags: (options.rowGrid ? 1 : 0) | (options.breakCycles ? 2 : 0),
    };
  }

  function unpack(options, result) {
    const nodes = options.nodes || [];
    const edges = options.edges || [];
    const { level: levelOf, order, row, back } = result;
    const level = new Map();
    nodes.forEach((node, i) => level.set(node.id, levelOf[i]));
    const byLevel = new Map();
    for (let i = 0; i < nodes.length; i += 1) {
      if (!byLevel.has(levelOf[i])) byLevel.set(levelOf[i], []);
      byLevel.get(levelOf[i]).push(i);
    }
    const levels = [...byLevel.keys()].sort((a, b) => a - b);
    const columns = new Map();
    const lineageRows = new Map();
    for (const l of byLevel.keys()) {
      const members = byLevel.get(l);
      const group = new Array(members.length);
      for (const i of members) group[order[i]] = nodes[i];
      columns.set(l, group);
    }
    if (options.rowGrid && levels.length) {
      for (const l of levels) for (const node of columns.get(l)) lineageRows.set(node.id, row[index(nodes, node)]);
    }
    const backEdges = new Set();
    edges.forEach((edge, i) => { if (back[i]) backEdges.add(edge.id); });
    return { columns, levels, level, backEdges, lineageRows };
  }

  // The position of a card in options.nodes, by its place in the column order (a Map built once per unpack).
  let indexCache = null;
  function index(nodes, node) {
    if (!indexCache || indexCache.nodes !== nodes) indexCache = { nodes, map: new Map(nodes.map((item, i) => [item, i])) };
    return indexCache.map.get(node);
  }

  ns.wasm.layered = { pack, unpack };
})();
