(() => {
  "use strict";
  // The adapter of src/wasm/router.c (src/static/wasm/router.wasm): the orthogonal edge router of app_graph_kit.js.
  // It runs in the page and in a Worker (ns.wasm.worker).
  //
  //   ops.router.route(kernel, { items, edges, maxSteps, searchSteps })
  //     items: Float64Array, five numbers per card: x, y, width, height, lineageRow (NaN: none)
  //     edges: Int32Array, four numbers per edge: from card index, to card index (-1: no such card), secondary (0 / 1), rank of the id
  //     returns { status, routes: Float64Array, stats: [steps, cheap, exhausted] }; status 0 is done,
  //     -2 means "the JavaScript router must answer", -1 no memory. routes holds, for each route in order, its edge index,
  //     its point count and its points (x, y).
  //
  // ns.wasm.router.pack(items, edges, options) turns the arguments of kit.routeEdges() into that input (null when the kernel
  // cannot take them: two edges with one id); ns.wasm.router.unpack(result, items, edges) gives back the Map of kit.routeEdges().
  const root = typeof window !== "undefined" ? window : self;
  const ns = (root.ChDash = root.ChDash || {});
  if (!ns.wasm) return;

  const LINEAGE_NODE_PORT_TOP_OFFSET = 36;

  ns.wasm.ops.router = {
    route(kernel, input) {
      return kernel.scope((k) => {
        const itemsPtr = k.putF64(input.items);
        const edgesPtr = k.putI32(input.edges);
        const status = k.exports.rt_route(itemsPtr, input.items.length / 5, edgesPtr, input.edges.length / 4, input.maxSteps, input.searchSteps);
        if (status !== 0) return { status, routes: new Float64Array(0), stats: [0, 0, 0] };
        const routes = k.readF64(k.exports.rt_out_ptr(), k.exports.rt_out_len());
        const stats = Array.from(k.readF64(k.exports.rt_stats_ptr(), 3));
        return { status: 0, routes, stats };
      });
    },
  };

  // Dense ranks of the ids under localeCompare (the order the JavaScript router sorts them in); equal ids rank equal.
  function idRanks(edges) {
    const order = edges.map((edge, i) => i);
    order.sort((a, b) => String(edges[a].id).localeCompare(String(edges[b].id)));
    const rank = new Int32Array(edges.length);
    let current = 0;
    for (let i = 0; i < order.length; i += 1) {
      if (i > 0 && String(edges[order[i - 1]].id).localeCompare(String(edges[order[i]].id)) !== 0) current += 1;
      rank[order[i]] = current;
    }
    return rank;
  }

  function pack(items, edges, options = {}) {
    const ids = new Set();
    for (const edge of edges) ids.add(edge.id);
    if (ids.size !== edges.length) return null;
    const index = new Map();
    const flat = new Float64Array(items.size * 5);
    let at = 0;
    for (const [id, item] of items) {
      index.set(id, at / 5);
      flat[at++] = item.x;
      flat[at++] = item.y;
      flat[at++] = item.width;
      flat[at++] = item.height;
      flat[at++] = Number.isFinite(item.lineageRow) ? item.lineageRow : NaN;
    }
    const isSecondary = options.isSecondary || (() => false);
    const rank = idRanks(edges);
    const list = new Int32Array(edges.length * 4);
    edges.forEach((edge, i) => {
      list[i * 4] = index.has(edge.from) ? index.get(edge.from) : -1;
      list[i * 4 + 1] = index.has(edge.to) ? index.get(edge.to) : -1;
      list[i * 4 + 2] = isSecondary(edge) ? 1 : 0;
      list[i * 4 + 3] = rank[i];
    });
    return { items: flat, edges: list, maxSteps: options.maxSteps ?? Infinity, searchSteps: options.searchSteps ?? Infinity };
  }

  const nodePort = (item, side) => {
    const y = item.y + Math.min(Math.max(18, LINEAGE_NODE_PORT_TOP_OFFSET), Math.max(18, item.height - 18));
    return { x: side === "left" ? item.x : item.x + item.width, y };
  };

  function unpack(result, items, edges) {
    const map = new Map();
    const flat = result.routes;
    let at = 0;
    while (at < flat.length) {
      const edge = edges[flat[at]];
      const count = flat[at + 1];
      const points = new Array(count);
      for (let i = 0; i < count; i += 1) points[i] = { x: flat[at + 2 + i * 2], y: flat[at + 3 + i * 2] };
      at += 2 + count * 2;
      map.set(edge.id, { points, a: nodePort(items.get(edge.from), "right"), b: nodePort(items.get(edge.to), "left") });
    }
    map.stats = { steps: result.stats[0], cheap: result.stats[1], exhausted: result.stats[2] === 1 };
    return map;
  }

  ns.wasm.router = { pack, unpack };
})();
