// Shared pieces of the layout equivalence and profile specs (docs/wasm.md).

// The Explorer catalog of the fixture plus a 2k-object database "chdash_scale" (852 cards visible, 550 edges).
export function scaleCatalog(base) {
  const template = base.nodes.find((node) => node.layer === 'logical');
  const nodes = [];
  const edges = [];
  const node = (name, kind, engine, extra = {}) => nodes.push({ ...template, id: `table:chdash_scale.${name}`, database: 'chdash_scale', name, label: name, kind, engine, rows: 1000, logical_bytes: 24000, ...extra });
  const edge = (from, to, kind) => edges.push({ id: `edge:s${edges.length}`, from: `table:chdash_scale.${from}`, to: `table:chdash_scale.${to}`, kind, label: kind, can_animate: kind !== 'view' });
  const t = (i) => `t${String(i).padStart(4, '0')}`;
  for (let i = 0; i < 1500; i += 1) node(t(i), 'mergetree', 'MergeTree');
  for (let i = 0; i < 300; i += 1) { node(`v${i}`, 'view', 'View', { rows: null }); edge(t(i), `v${i}`, 'view'); }
  for (let i = 0; i < 100; i += 1) {
    node(`agg${i}`, 'mergetree', 'SummingMergeTree');
    node(`mv${i}`, 'materialized_view', 'MaterializedView', { rows: null });
    edge(t(i), `mv${i}`, 'materialized_view');
    edge(`mv${i}`, `agg${i}`, 'materialized_view_output');
  }
  for (let i = 0; i < 50; i += 1) { node(`buf${i}`, 'buffer', 'Buffer'); edge(`buf${i}`, t(i), 'buffer'); }
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
