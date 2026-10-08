// Shared pieces of the layout equivalence and profile specs (docs/wasm.md).

// The Explorer catalog of the fixture plus a 2k-object database "chdash_scale" (852 cards visible, 550 edges).
export function scaleCatalog(base, { tables = 1500, views = 300, aggregates = 100, buffers = 50 } = {}) {
  const template = base.nodes.find((node) => node.layer === 'logical');
  const nodes = [];
  const edges = [];
  const node = (name, kind, engine, extra = {}) => nodes.push({ ...template, id: `table:chdash_scale.${name}`, database: 'chdash_scale', name, label: name, kind, engine, rows: 1000, logical_bytes: 24000, ...extra });
  const edge = (from, to, kind) => edges.push({ id: `edge:s${edges.length}`, from: `table:chdash_scale.${from}`, to: `table:chdash_scale.${to}`, kind, label: kind, can_animate: kind !== 'view' });
  const t = (i) => `t${String(i).padStart(4, '0')}`;
  for (let i = 0; i < tables; i += 1) node(t(i), 'mergetree', 'MergeTree');
  for (let i = 0; i < views; i += 1) { node(`v${i}`, 'view', 'View', { rows: null }); edge(t(i), `v${i}`, 'view'); }
  for (let i = 0; i < aggregates; i += 1) {
    node(`agg${i}`, 'mergetree', 'SummingMergeTree');
    node(`mv${i}`, 'materialized_view', 'MaterializedView', { rows: null });
    edge(t(i), `mv${i}`, 'materialized_view');
    edge(`mv${i}`, `agg${i}`, 'materialized_view_output');
  }
  for (let i = 0; i < buffers; i += 1) { node(`buf${i}`, 'buffer', 'Buffer'); edge(`buf${i}`, t(i), 'buffer'); }
  return { ...base, nodes: [...base.nodes, ...nodes], edges: [...base.edges, ...edges] };
}

// A seeded random graph laid out like the Explorer and the service map lay theirs out (kit.layered), run in the page:
// returns { items: Map, edges, options } for kit.routeEdges(). `shape` tunes it (nodes, edges, rows, secondary share,
// budget, cycles, odd edges); `seed` fixes it.
export function buildRoutingCase() {
  return function build({ seed, nodes, edges, secondary = 0, budget = null, cycles = false, odd = false, rowGrid = true, wide = false }) {
    const kit = window.ChDash.graphKit;
    let state = seed >>> 0;
    const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const ids = Array.from({ length: nodes }, (_, i) => ({ id: `n${String(i).padStart(3, '0')}`, order: i }));
    const list = [];
    for (let i = 0; i < edges; i += 1) {
      let a = Math.floor(rand() * nodes);
      let b = Math.floor(rand() * nodes);
      if (!cycles && a > b) [a, b] = [b, a];
      if (!odd && a === b) b = (a + 1) % nodes;
      list.push({ id: `e${String(i).padStart(4, '0')}`, from: ids[a].id, to: ids[b].id, kind: rand() < secondary ? 'view' : 'materialized_view' });
    }
    if (odd && list.length) {
      list.push({ id: 'dup', from: list[0].from, to: list[0].to, kind: 'view' });
      list.push({ id: 'ghost-from', from: 'missing', to: ids[0].id, kind: 'view' });
      list.push({ id: 'ghost-to', from: ids[0].id, to: 'missing', kind: 'view' });
      list.push({ id: 'self', from: ids[0].id, to: ids[0].id, kind: 'view' });
    }
    const { positions, level } = kit.layered({
      nodes: ids, edges: list, size: (node) => ({ width: wide ? 216 : 190, height: 56 + (node.order % 3) * 6 }), compare: (p, q) => p.order - q.order,
      rowGrid, rowPitch: 100, xGap: 128, yGap: 40, minColumnWidth: 190, origin: 0, breakCycles: cycles,
    });
    const back = new Set(list.filter((e) => (level.get(e.to) ?? 0) <= (level.get(e.from) ?? 0)).map((e) => e.id));
    const routed = cycles ? list.map((e) => (back.has(e.id) ? { ...e, from: e.to, to: e.from } : e)) : list;
    return { items: positions, edges: routed, options: { isSecondary: (e) => e.kind === 'view', ...(budget || {}) } };
  };
}

// The dense service map of tests/frontend/specs/trace-service-map.spec.js (every service calling most others), laid out
// like app_trace_map.js lays it out; run in the page. Returns { items, edges, options } for kit.routeEdges*().
export function buildDenseCase() {
  return function build({ services, paths, seed = 1 }) {
    const kit = window.ChDash.graphKit;
    let state = seed;
    const random = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
    const nodes = Array.from({ length: services }, (_, i) => ({ id: `svc-${String(i).padStart(2, '0')}`, order: i }));
    const pairs = [];
    for (let a = 0; a < services; a += 1) for (let b = 0; b < services; b += 1) if (a !== b) pairs.push([a, b]);
    for (let i = pairs.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
    const edges = pairs.slice(0, paths).map(([a, b], i) => ({ id: `${nodes[a].id}>${nodes[b].id}`, from: nodes[a].id, to: nodes[b].id, index: i }));
    const { positions, level } = kit.layered({
      nodes, edges, size: () => ({ width: 216, height: 72 }), compare: (a, b) => a.order - b.order, rowGrid: true, rowPitch: 72 + 40,
      xGap: 128, yGap: 40, minColumnWidth: 216, origin: 0, breakCycles: true,
    });
    const back = new Set(edges.filter((e) => (level.get(e.to) ?? 0) <= (level.get(e.from) ?? 0)).map((e) => e.id));
    const routed = edges.map((e) => (back.has(e.id) ? { ...e, from: e.to, to: e.from } : e));
    return { items: positions, edges: routed, options: { maxSteps: 160_000, searchSteps: 40_000 } };
  };
}

// Options for kit.layered() on a seeded random graph (cycles, self loops, edges to missing cards, repeated edges), run in the page.
export function buildLayeredCase() {
  return function build({ seed, nodes, edges, rowGrid = true, breakCycles = false, names = false, odd = false, weighted = false }) {
    let state = seed >>> 0;
    const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    const list = Array.from({ length: nodes }, (_, i) => ({ id: `n${i}`, order: i, name: names ? `${['Beta', 'alpha', 'Gamma', 'delta', 'éclair', 'zeta'][i % 6]}${(i * 7) % 11}` : `n${i}` }));
    const links = [];
    for (let i = 0; i < edges; i += 1) {
      let a = Math.floor(rand() * nodes);
      let b = Math.floor(rand() * nodes);
      if (!breakCycles && !odd && a > b) [a, b] = [b, a];
      if (!odd && a === b) b = (a + 1) % nodes;
      links.push({ id: `e${i}`, from: list[a].id, to: list[b].id, kind: rand() < 0.3 ? 'view' : 'mv' });
    }
    if (odd) {
      links.push({ id: 'ghostA', from: 'nope', to: list[0].id, kind: 'mv' }, { id: 'ghostB', from: list[0].id, to: 'nope', kind: 'mv' }, { id: 'selfie', from: list[1].id, to: list[1].id, kind: 'mv' });
      if (links.length > 3) links.push({ id: 'again', from: links[0].from, to: links[0].to, kind: 'view' });
    }
    return {
      nodes: list, edges: links, rowGrid, rowPitch: 100, breakCycles, xGap: 100, yGap: 30, minColumnWidth: 100, origin: 10,
      size: (node) => ({ width: 100 + (node.order % 4) * 20, height: 50 + (node.order % 3) * 10 }),
      compare: names ? (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : (a, b) => a.order - b.order,
      queueCompare: names ? (a, b) => a.name.localeCompare(b.name) : undefined,
      weight: weighted ? (edge) => (edge.kind === 'view' ? 0.62 : 1) : undefined,
    };
  };
}
