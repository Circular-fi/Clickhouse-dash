(() => {
  "use strict";
  // Service map tab of the Traces page, after HyperDX's DBServiceMapPage: the
  // services of the traces matching the search (time range, filters and chips)
  // and the calls between them from /api/traces/service_map. A layered
  // directed graph drawn in SVG: nodes take the service colour and grow with
  // their span count, a red ring grows with their error rate; edges thicken
  // with their call count and turn amber / red with their error rate. Hover
  // highlights the neighbours; a click opens the side panel with the metrics
  // and the hand-off to the Search tab. Wheel / drag / buttons zoom and pan.
  const ns = window.ChDash;
  if (!ns || !ns.traceTabs) return;

  // HyperDX's error-rate buckets (ERROR_RATE_ELEVATED / ERROR_RATE_HIGH).
  const ERROR_ELEVATED = 0.01;
  const ERROR_HIGH = 0.05;
  const RING_MIN_RATE = 0.001;
  const MIN_RADIUS = 15;
  const MAX_RADIUS = 32;
  // Layer / sibling spacing of the two orientations (left-right, top-down).
  const LR_RANK_GAP = 250;
  const LR_ROW_GAP = 96;
  const TB_RANK_GAP = 150;
  const TB_COL_GAP = 142;
  const LABEL_SPACE = 40;
  const ZOOM_MIN = 0.15;
  const ZOOM_MAX = 3;
  const FIT_MAX = 1.35;
  const PANEL_EDGES = 6;
  const NAME_CHARS = 22;

  const SVG_NS = "http://www.w3.org/2000/svg";
  let ctx = null;
  const byId = (id) => document.getElementById(id);
  const esc = (value) => ctx.esc(value);

  const map = {
    seq: 0,
    key: null,
    loading: false,
    error: "",
    data: null,
    layout: null,
    view: { scale: 1, x: 0, y: 0 },
    fitted: true,
    selected: null,
    hovered: null,
    drag: null,
  };

  // ---------------------------------------------------------------- format

  const compactFormat = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  function compact(value) {
    const n = Number(value) || 0;
    return n < 1000 ? String(Math.round(n)) : compactFormat.format(n);
  }

  function percent(rate) {
    const p = (Number(rate) || 0) * 100;
    if (p === 0) return "0%";
    if (p < 0.01) return "<0.01%";
    if (p < 10) return `${p.toFixed(2).replace(/\.?0+$/, "")}%`;
    return `${Math.round(p)}%`;
  }

  function perSecond(count) {
    const range = map.data?.range || [0, 0];
    const seconds = Math.max(1, (Number(range[1]) - Number(range[0])) / 1000);
    const rate = (Number(count) || 0) / seconds;
    if (rate >= 100) return `${compact(rate)}/s`;
    if (rate >= 1) return `${rate.toFixed(1).replace(/\.0$/, "")}/s`;
    return `${(rate * 60).toFixed(1).replace(/\.0$/, "")}/min`;
  }

  const duration = (ns) => ctx.formatDuration(ns);

  function severity(rate) {
    if (rate >= ERROR_HIGH) return "err";
    if (rate >= ERROR_ELEVATED) return "warn";
    return "ok";
  }

  function shortName(name) {
    const text = String(name || "unknown");
    return text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS - 1)}\u2026` : text;
  }

  function factorText(value) {
    const n = Number(value) || 1;
    return n >= 100 ? compact(n) : n >= 10 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "");
  }

  // ---------------------------------------------------------------- data

  function normalize(payload) {
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes.map((node) => ({ ...node, service: String(node.service || "") })) : [];
    const edges = Array.isArray(payload?.edges) ? payload.edges.map((edge) => ({ ...edge, source: String(edge.source || ""), target: String(edge.target || "") })) : [];
    const known = new Set(nodes.map((node) => node.service));
    // An edge always has its two services (defensive: a truncated node list).
    for (const edge of edges) {
      for (const service of [edge.source, edge.target]) {
        if (known.has(service)) continue;
        known.add(service);
        nodes.push({ service, spans: 0, errors: 0, error_rate: 0, sampled_count: 0, p50_ns: 0, p95_ns: 0, p99_ns: 0 });
      }
    }
    return { ...payload, nodes, edges: edges.filter((edge) => edge.source !== edge.target) };
  }

  const edgeId = (edge) => `${edge.source}\x1f${edge.target}`;

  // ---------------------------------------------------------------- layout

  // Layered (Sugiyama-style) layout: back edges of a DFS are ignored for the
  // ranking (cycles), ranks are longest paths from the sources, siblings are
  // ordered by barycentre sweeps. Services without any edge are laid out in a
  // grid after the graph. Returns rank / order per node index.
  function layers(nodes, edges) {
    const count = nodes.length;
    const index = new Map(nodes.map((node, i) => [node.service, i]));
    const out = nodes.map(() => []);
    const into = nodes.map(() => []);
    for (const edge of edges) {
      const s = index.get(edge.source);
      const t = index.get(edge.target);
      if (s == null || t == null || s === t) continue;
      out[s].push(t);
      into[t].push(s);
    }
    const connected = nodes.map((_, i) => out[i].length > 0 || into[i].length > 0);
    const state = new Uint8Array(count);
    const dag = nodes.map(() => []);
    const visit = (root) => {
      // Iterative DFS (no recursion limit on deep chains).
      const stack = [[root, 0]];
      state[root] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, at] = top;
        if (at < out[v].length) {
          top[1] += 1;
          const w = out[v][at];
          if (state[w] === 1) continue; // back edge: a cycle
          dag[v].push(w);
          if (state[w] === 0) { state[w] = 1; stack.push([w, 0]); }
        } else {
          state[v] = 2;
          stack.pop();
        }
      }
    };
    // Sources first (busiest first: nodes arrive sorted by spans).
    for (let i = 0; i < count; i += 1) if (connected[i] && !into[i].length && !state[i]) visit(i);
    for (let i = 0; i < count; i += 1) if (connected[i] && !state[i]) visit(i);

    const rank = new Array(count).fill(0);
    const indegree = new Array(count).fill(0);
    for (let v = 0; v < count; v += 1) for (const w of dag[v]) indegree[w] += 1;
    const queue = [];
    for (let v = 0; v < count; v += 1) if (connected[v] && !indegree[v]) queue.push(v);
    for (let head = 0; head < queue.length; head += 1) {
      const v = queue[head];
      for (const w of dag[v]) {
        rank[w] = Math.max(rank[w], rank[v] + 1);
        indegree[w] -= 1;
        if (!indegree[w]) queue.push(w);
      }
    }
    const maxRank = connected.some(Boolean) ? Math.max(...rank.filter((_, i) => connected[i])) : -1;
    const rows = Array.from({ length: maxRank + 1 }, () => []);
    for (let v = 0; v < count; v += 1) if (connected[v]) rows[rank[v]].push(v);

    // Barycentre ordering over the undirected neighbours in adjacent ranks.
    const neighbours = nodes.map((_, i) => [...new Set([...out[i], ...into[i]])]);
    const position = new Array(count).fill(0);
    const place = () => rows.forEach((row) => row.forEach((v, i) => { position[v] = i - (row.length - 1) / 2; }));
    place();
    for (let pass = 0; pass < 8; pass += 1) {
      const order = pass % 2 === 0 ? rows.map((_, r) => r) : rows.map((_, r) => rows.length - 1 - r);
      for (const r of order) {
        const adjacent = pass % 2 === 0 ? r - 1 : r + 1;
        if (adjacent < 0 || adjacent >= rows.length) continue;
        const score = new Map();
        for (const v of rows[r]) {
          const near = neighbours[v].filter((w) => rank[w] === adjacent);
          score.set(v, near.length ? near.reduce((sum, w) => sum + position[w], 0) / near.length : position[v]);
        }
        rows[r].sort((a, b) => score.get(a) - score.get(b) || a - b);
        place();
      }
    }
    const isolated = [];
    for (let v = 0; v < count; v += 1) if (!connected[v]) isolated.push(v);
    return { rows, isolated, rank };
  }

  function radiusOf(node, maxSpans) {
    const share = maxSpans > 0 ? Math.sqrt(Math.max(0, Number(node.spans) || 0) / maxSpans) : 0;
    return MIN_RADIUS + (MAX_RADIUS - MIN_RADIUS) * share;
  }

  // Positions for one orientation ("lr" or "tb") and their bounds.
  function place(nodes, structure, orientation) {
    const maxSpans = Math.max(0, ...nodes.map((node) => Number(node.spans) || 0));
    const points = nodes.map((node) => ({ x: 0, y: 0, r: radiusOf(node, maxSpans) }));
    const lr = orientation === "lr";
    structure.rows.forEach((row, r) => {
      row.forEach((v, i) => {
        const offset = i - (row.length - 1) / 2;
        points[v].x = lr ? r * LR_RANK_GAP : offset * TB_COL_GAP;
        points[v].y = lr ? offset * LR_ROW_GAP : r * TB_RANK_GAP;
      });
    });
    // Isolated services: a grid after the graph (below it top-down, right of it left-right).
    if (structure.isolated.length) {
      const columns = Math.max(1, Math.ceil(Math.sqrt(structure.isolated.length * (lr ? 0.6 : 2))));
      let minX = Infinity; let maxX = -Infinity; let maxY = -Infinity;
      for (const row of structure.rows) for (const v of row) { minX = Math.min(minX, points[v].x); maxX = Math.max(maxX, points[v].x); maxY = Math.max(maxY, points[v].y); }
      const hasGraph = Number.isFinite(minX);
      structure.isolated.forEach((v, i) => {
        const col = i % columns;
        const line = Math.floor(i / columns);
        if (lr) {
          points[v].x = (hasGraph ? maxX + LR_RANK_GAP : 0) + col * TB_COL_GAP;
          points[v].y = line * LR_ROW_GAP;
        } else {
          points[v].x = (hasGraph ? minX : 0) + col * TB_COL_GAP;
          points[v].y = (hasGraph ? maxY + TB_RANK_GAP : 0) + line * TB_RANK_GAP;
        }
      });
    }
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const p of points) {
      bounds.minX = Math.min(bounds.minX, p.x - Math.max(p.r, TB_COL_GAP / 2 - 6));
      bounds.maxX = Math.max(bounds.maxX, p.x + Math.max(p.r, TB_COL_GAP / 2 - 6));
      bounds.minY = Math.min(bounds.minY, p.y - p.r - 6);
      bounds.maxY = Math.max(bounds.maxY, p.y + p.r + LABEL_SPACE);
    }
    return { points, bounds, orientation };
  }

  function fitScale(bounds, width, height) {
    const w = Math.max(1, bounds.maxX - bounds.minX);
    const h = Math.max(1, bounds.maxY - bounds.minY);
    return Math.min(FIT_MAX, (width - 48) / w, (height - 48) / h);
  }

  // The orientation whose drawing fits the canvas at the larger scale.
  function computeLayout(data, width, height) {
    const structure = layers(data.nodes, data.edges);
    const lr = place(data.nodes, structure, "lr");
    const tb = place(data.nodes, structure, "tb");
    const best = fitScale(tb.bounds, width, height) > fitScale(lr.bounds, width, height) * 1.02 ? tb : lr;
    const index = new Map(data.nodes.map((node, i) => [node.service, i]));
    const edges = data.edges.map((edge) => ({ edge, s: index.get(edge.source), t: index.get(edge.target) }))
      .filter((item) => item.s != null && item.t != null);
    return { ...best, rank: structure.rank, edges, index };
  }

  // Cubic path from the source's boundary to the target's, along the layout
  // axis; edges against it (cycles, same rank) bend out as an arc.
  function edgePath(layout, item) {
    const a = layout.points[item.s];
    const b = layout.points[item.t];
    const lr = layout.orientation === "lr";
    const forward = lr ? b.x - a.x > a.r + b.r : b.y - a.y > a.r + b.r + LABEL_SPACE;
    if (forward) {
      if (lr) {
        const x1 = a.x + a.r; const x2 = b.x - b.r - 3; const mid = (x1 + x2) / 2;
        return { d: `M${x1.toFixed(1)},${a.y.toFixed(1)} C${mid.toFixed(1)},${a.y.toFixed(1)} ${mid.toFixed(1)},${b.y.toFixed(1)} ${x2.toFixed(1)},${b.y.toFixed(1)}`, mx: (x1 + x2) / 2, my: (a.y + b.y) / 2 };
      }
      // Top-down edges leave under the source's label.
      const y1 = a.y + a.r + LABEL_SPACE - 4; const y2 = b.y - b.r - 3; const mid = (y1 + y2) / 2;
      return { d: `M${a.x.toFixed(1)},${y1.toFixed(1)} C${a.x.toFixed(1)},${mid.toFixed(1)} ${b.x.toFixed(1)},${mid.toFixed(1)} ${b.x.toFixed(1)},${y2.toFixed(1)}`, mx: (a.x + b.x) / 2, my: (y1 + y2) / 2 };
    }
    // Arc: control point pushed sideways from the chord.
    const dx = b.x - a.x; const dy = b.y - a.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / length; const ny = dx / length;
    const bend = Math.min(140, 40 + length * 0.25);
    const cx = (a.x + b.x) / 2 + nx * bend; const cy = (a.y + b.y) / 2 + ny * bend;
    const start = towards(a, cx, cy, a.r);
    const end = towards(b, cx, cy, b.r + 3);
    return { d: `M${start.x.toFixed(1)},${start.y.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${end.x.toFixed(1)},${end.y.toFixed(1)}`, mx: (start.x + 2 * cx + end.x) / 4, my: (start.y + 2 * cy + end.y) / 4 };
  }

  function towards(point, x, y, distance) {
    const dx = x - point.x; const dy = y - point.y;
    const length = Math.max(1, Math.hypot(dx, dy));
    return { x: point.x + (dx / length) * distance, y: point.y + (dy / length) * distance };
  }

  // ---------------------------------------------------------------- render

  function canvasSize() {
    const box = byId("traceMapCanvas")?.getBoundingClientRect();
    return { width: Math.max(200, box?.width || 800), height: Math.max(200, box?.height || 500) };
  }

  function renderMeta() {
    const meta = byId("traceMapMeta");
    const badge = byId("traceMapSampled");
    const data = map.data;
    if (meta) {
      if (!data) meta.textContent = "";
      else {
        const parts = [`${data.nodes.length} service${data.nodes.length === 1 ? "" : "s"}`, `${data.edges.length} call path${data.edges.length === 1 ? "" : "s"}`];
        if (Number.isFinite(Number(data.timing_ms?.total))) parts.push(`${Math.round(Number(data.timing_ms.total))} ms`);
        if (data.truncated) parts.push("busiest shown");
        meta.textContent = parts.join(" · ");
      }
    }
    if (badge) {
      const sampling = data?.sampling || {};
      badge.hidden = !data?.sampled;
      if (data?.sampled) {
        const factor = factorText(data.sample_factor);
        badge.textContent = `sampled ×${factor}`;
        const slices = Number(sampling.slices) || 0;
        const coverage = Number(sampling.time_coverage) || 1;
        const traceFactor = Number(sampling.trace_factor) || 1;
        const parts = [];
        if (traceFactor > 1) parts.push(`1 trace in ${traceFactor}`);
        if (slices > 0) parts.push(`${slices} time slices covering ${percent(coverage)} of the range`);
        badge.title = `Estimated from ${parts.join(" and ")}: counts are scaled ×${factor}. Error rates and durations come from the sampled spans.`;
      } else {
        badge.removeAttribute("title");
      }
    }
  }

  function renderLegend() {
    const legend = byId("traceMapLegend");
    if (!legend) return;
    legend.hidden = !map.data || !map.data.nodes.length;
    legend.innerHTML = '<div class="traceMap__legendRow"><svg viewBox="0 0 38 18" aria-hidden="true"><circle cx="6" cy="9" r="4"/><circle cx="25" cy="9" r="8"/></svg><span>Node size: spans</span></div>'
      + '<div class="traceMap__legendRow"><svg viewBox="0 0 38 18" aria-hidden="true"><circle class="is-ring" cx="19" cy="9" r="7"/></svg><span>Red ring: error rate \u2265 0.1%</span></div>'
      + '<div class="traceMap__legendRow"><svg viewBox="0 0 38 18" aria-hidden="true"><path d="M2 5h34" stroke-width="1.5"/><path d="M2 13h34" stroke-width="5"/></svg><span>Edge width: calls</span></div>'
      + `<div class="traceMap__legendRow traceMap__legendRow--errors"><span class="traceMap__swatch is-ok"></span><span>&lt; ${ERROR_ELEVATED * 100}%</span><span class="traceMap__swatch is-warn"></span><span>${ERROR_ELEVATED * 100}\u2013${ERROR_HIGH * 100}%</span><span class="traceMap__swatch is-err"></span><span>\u2265 ${ERROR_HIGH * 100}% errors</span></div>`;
  }

  function renderState() {
    const root = byId("traceMapState");
    const canvas = byId("traceMapCanvas");
    if (!root) return;
    const hasGraph = !!map.data && map.data.nodes.length > 0;
    canvas?.classList.toggle("is-loading", map.loading);
    byId("traceMapView")?.setAttribute("aria-busy", map.loading ? "true" : "false");
    let html = "";
    if (map.loading) {
      html = `<div class="traceMap__message${hasGraph ? " traceMap__message--over" : ""}" role="status"><span class="traceButtonSpinner traceMap__spinner" aria-hidden="true"></span>Loading service map\u2026</div>`;
    } else if (map.error) {
      html = `<div class="traceMap__message traceMap__message--error" role="alert"><strong>Service map failed</strong><span>${esc(map.error)}</span><button type="button" class="button button--small" data-map-retry>Retry</button></div>`;
    } else if (!map.data) {
      html = '<div class="tracesEmpty">Search to load the service map.</div>';
    } else if (!map.data.nodes.length) {
      html = '<div class="traceMap__message" role="status"><strong>No services in this time range</strong><span>No visible span matches the search. Widen the time range or remove filters.</span></div>';
    } else if (!map.data.edges.length) {
      html = '<div class="traceMap__notice" role="status">No calls between services: an edge links a span to its parent span in another service.</div>';
    }
    root.innerHTML = html;
    root.hidden = !html;
  }

  function renderGraph() {
    const svg = byId("traceMapSvg");
    if (!svg) return;
    const data = map.data;
    if (!data || !data.nodes.length) {
      svg.innerHTML = "";
      map.layout = null;
      closePanel();
      return;
    }
    const { width, height } = canvasSize();
    const layout = computeLayout(data, width, height);
    map.layout = layout;
    const maxCalls = Math.max(1, ...data.edges.map((edge) => Number(edge.calls) || 0));
    const edgesHtml = layout.edges.map((item, i) => {
      const { d } = edgePath(layout, item);
      item.path = edgePath(layout, item);
      const calls = Number(item.edge.calls) || 0;
      const widthPx = 1.25 + 6.25 * Math.sqrt(calls / maxCalls);
      const level = severity(Number(item.edge.error_rate) || 0);
      const label = `${item.edge.source} calls ${item.edge.target}: ${compact(calls)} calls, ${percent(item.edge.error_rate)} errors, p95 ${duration(item.edge.p95_ns)}`;
      return `<g class="traceMapEdge is-${level}" data-map-edge="${i}" role="button" tabindex="-1" aria-label="${esc(label)}"><path class="traceMapEdge__hit" d="${d}"/><path class="traceMapEdge__line" d="${d}" style="stroke-width:${widthPx.toFixed(2)}px" marker-end="url(#traceMapArrow-${level})"/></g>`;
    }).join("");
    const nodesHtml = data.nodes.map((node, i) => {
      const p = layout.points[i];
      const rate = Number(node.error_rate) || 0;
      // No ring below 0.1 % errors (noise on a busy service).
      const ring = rate >= RING_MIN_RATE
        ? `<circle class="traceMapNode__ring is-${severity(rate)}" r="${(p.r + 4.5).toFixed(1)}" style="stroke-width:${(1.5 + Math.min(1, rate / ERROR_HIGH) * 4).toFixed(2)}px"/>`
        : "";
      const label = `${node.service}: ${compact(node.spans)} spans, ${percent(rate)} errors, p95 ${duration(node.p95_ns)}`;
      return `<g class="traceMapNode" data-map-node="${i}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" role="button" tabindex="0" aria-label="${esc(label)}">`
        + `${ring}<circle class="traceMapNode__dot" r="${p.r.toFixed(1)}" style="fill:${ctx.serviceColor(node.service)}"/>`
        + `<text class="traceMapNode__name" y="${(p.r + 17).toFixed(1)}">${esc(shortName(node.service))}</text>`
        + `<text class="traceMapNode__stat" y="${(p.r + 31).toFixed(1)}">${esc(`${compact(node.spans)} · ${percent(rate)}`)}</text>`
        + `<title>${esc(node.service)}</title></g>`;
    }).join("");
    const marker = (level) => `<marker id="traceMapArrow-${level}" class="traceMap__arrow is-${level}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>`;
    svg.innerHTML = `<defs>${marker("ok")}${marker("warn")}${marker("err")}</defs>`
      + `<g class="traceMap__viewport"><g class="traceMap__edges">${edgesHtml}</g><g class="traceMap__nodes">${nodesHtml}</g><g class="traceMap__labels"></g></g>`;
    applyView();
    applyHighlight();
  }

  function applyView() {
    const viewport = byId("traceMapSvg")?.querySelector(".traceMap__viewport");
    if (!viewport) return;
    const { scale, x, y } = map.view;
    viewport.setAttribute("transform", `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${scale.toFixed(4)})`);
  }

  function fit() {
    if (!map.layout) return;
    const { width, height } = canvasSize();
    const b = map.layout.bounds;
    const scale = Math.max(ZOOM_MIN, fitScale(b, width, height));
    map.view = {
      scale,
      x: width / 2 - ((b.minX + b.maxX) / 2) * scale,
      y: height / 2 - ((b.minY + b.maxY) / 2) * scale,
    };
    map.fitted = true;
    applyView();
  }

  function zoomAt(factor, px, py) {
    const { scale, x, y } = map.view;
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, scale * factor));
    const k = next / scale;
    map.view = { scale: next, x: px - (px - x) * k, y: py - (py - y) * k };
    map.fitted = false;
    applyView();
  }

  function zoomCentre(factor) {
    const { width, height } = canvasSize();
    zoomAt(factor, width / 2, height / 2);
  }

  // ------------------------------------------------------- hover / selection

  // Node indexes and edge indexes around the hovered (or selected) item.
  function focusSet(target) {
    if (!target || !map.layout) return null;
    const nodes = new Set();
    const edges = new Set();
    if (target.kind === "node") {
      nodes.add(target.index);
      map.layout.edges.forEach((item, i) => {
        if (item.s === target.index || item.t === target.index) { edges.add(i); nodes.add(item.s); nodes.add(item.t); }
      });
    } else {
      const item = map.layout.edges[target.index];
      if (!item) return null;
      edges.add(target.index); nodes.add(item.s); nodes.add(item.t);
    }
    return { nodes, edges };
  }

  function applyHighlight() {
    const svg = byId("traceMapSvg");
    if (!svg || !map.layout) return;
    const focus = focusSet(map.hovered);
    svg.classList.toggle("is-focus", !!focus);
    for (const el of svg.querySelectorAll("[data-map-node]")) {
      const i = Number(el.getAttribute("data-map-node"));
      el.classList.toggle("is-hl", !!focus && focus.nodes.has(i));
      el.classList.toggle("is-selected", map.selected?.kind === "node" && map.selected.index === i);
    }
    for (const el of svg.querySelectorAll("[data-map-edge]")) {
      const i = Number(el.getAttribute("data-map-edge"));
      el.classList.toggle("is-hl", !!focus && focus.edges.has(i));
      el.classList.toggle("is-selected", map.selected?.kind === "edge" && map.selected.index === i);
    }
    // p95 / calls labels of the highlighted edges (hovered or selected).
    const labels = svg.querySelector(".traceMap__labels");
    if (!labels) return;
    const shown = new Set(focus ? focus.edges : []);
    if (map.selected?.kind === "edge") shown.add(map.selected.index);
    if (focus && focus.edges.size > 12 && map.hovered?.kind === "node") shown.clear();
    labels.innerHTML = [...shown].map((i) => {
      const item = map.layout.edges[i];
      if (!item?.path) return "";
      const text = `p95 ${duration(item.edge.p95_ns)} · ${compact(item.edge.calls)}`;
      const w = text.length * 6.3 + 14;
      return `<g class="traceMapEdgeLabel" transform="translate(${item.path.mx.toFixed(1)},${item.path.my.toFixed(1)})"><rect x="${(-w / 2).toFixed(1)}" y="-10" width="${w.toFixed(1)}" height="20" rx="5"/><text y="4">${esc(text)}</text></g>`;
    }).join("");
  }

  function targetOf(element) {
    const node = element?.closest?.("[data-map-node]");
    if (node) return { kind: "node", index: Number(node.getAttribute("data-map-node")) };
    const edge = element?.closest?.("[data-map-edge]");
    if (edge) return { kind: "edge", index: Number(edge.getAttribute("data-map-edge")) };
    return null;
  }

  const sameTarget = (a, b) => (!a && !b) || (!!a && !!b && a.kind === b.kind && a.index === b.index);

  function showTip(target, clientX, clientY) {
    const tip = byId("traceMapTip");
    const canvas = byId("traceMapCanvas");
    if (!tip || !canvas) return;
    if (!target || !map.layout || map.drag) { tip.hidden = true; return; }
    let html = "";
    if (target.kind === "node") {
      const node = map.data.nodes[target.index];
      if (!node) { tip.hidden = true; return; }
      html = `<strong><span class="traceMap__dot" style="background:${ctx.serviceColor(node.service)}"></span>${esc(node.service)}</strong>`
        + `<span>${esc(compact(node.spans))} spans · ${esc(perSecond(node.spans))}</span>`
        + `<span class="is-${severity(node.error_rate)}">${esc(percent(node.error_rate))} errors</span>`
        + `<span>p50 ${esc(duration(node.p50_ns))} · p95 ${esc(duration(node.p95_ns))}</span>`;
    } else {
      const edge = map.layout.edges[target.index]?.edge;
      if (!edge) { tip.hidden = true; return; }
      html = `<strong>${esc(edge.source)} \u2192 ${esc(edge.target)}</strong>`
        + `<span>${esc(compact(edge.calls))} calls · ${esc(perSecond(edge.calls))}</span>`
        + `<span class="is-${severity(edge.error_rate)}">${esc(percent(edge.error_rate))} errors</span>`
        + `<span>p50 ${esc(duration(edge.p50_ns))} · p95 ${esc(duration(edge.p95_ns))}</span>`;
    }
    tip.innerHTML = html;
    tip.hidden = false;
    const box = canvas.getBoundingClientRect();
    const size = tip.getBoundingClientRect();
    let left = clientX - box.left + 14;
    let top = clientY - box.top + 14;
    if (left + size.width > box.width - 8) left = Math.max(8, clientX - box.left - size.width - 14);
    if (top + size.height > box.height - 8) top = Math.max(8, clientY - box.top - size.height - 14);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hideTip() {
    const tip = byId("traceMapTip");
    if (tip) tip.hidden = true;
  }

  function select(target) {
    map.selected = target;
    applyHighlight();
    renderPanel();
    ensureVisible(target);
  }

  function closePanel() {
    map.selected = null;
    const panel = byId("traceMapPanel");
    if (panel) { panel.hidden = true; panel.innerHTML = ""; }
    byId("traceMapCanvas")?.classList.remove("has-panel");
    applyHighlight();
  }

  // Pans a selected node out from under the side panel.
  function ensureVisible(target) {
    if (!target || target.kind !== "node" || !map.layout) return;
    const panel = byId("traceMapPanel");
    const p = map.layout.points[target.index];
    if (!p || !panel || panel.hidden) return;
    const { width } = canvasSize();
    const limit = width - panel.getBoundingClientRect().width - 32;
    const screenX = map.view.x + p.x * map.view.scale;
    if (screenX + p.r * map.view.scale > limit) {
      map.view.x -= screenX + p.r * map.view.scale - limit;
      map.fitted = false;
      applyView();
    }
  }

  function statsHtml(item, countLabel, count) {
    return '<dl class="traceMapPanel__stats">'
      + `<div><dt>${esc(countLabel)}</dt><dd>${esc(compact(count))}<small>${esc(perSecond(count))}</small></dd></div>`
      + `<div><dt>Errors</dt><dd class="is-${severity(item.error_rate)}">${esc(percent(item.error_rate))}<small>${esc(compact(item.errors))}</small></dd></div>`
      + `<div><dt>p50</dt><dd>${esc(duration(item.p50_ns))}</dd></div>`
      + `<div><dt>p95</dt><dd>${esc(duration(item.p95_ns))}</dd></div>`
      + `<div><dt>p99</dt><dd>${esc(duration(item.p99_ns))}</dd></div>`
      + "</dl>";
  }

  function edgeListHtml(title, items, other) {
    if (!items.length) return `<section class="traceMapPanel__list"><h3>${esc(title)}</h3><p class="traceMapPanel__none">None</p></section>`;
    const rows = items.slice(0, PANEL_EDGES).map(({ item, i }) => {
      const service = item.edge[other];
      return `<li><button type="button" class="traceMapPanel__edge" data-map-select-edge="${i}" title="${esc(`${item.edge.source} \u2192 ${item.edge.target}`)}"><span class="traceMap__dot" style="background:${ctx.serviceColor(service)}"></span><span class="traceMapPanel__edgeName">${esc(service)}</span><span>${esc(compact(item.edge.calls))}</span><span class="is-${severity(item.edge.error_rate)}">${esc(percent(item.edge.error_rate))}</span><span>${esc(duration(item.edge.p95_ns))}</span></button></li>`;
    }).join("");
    const more = items.length > PANEL_EDGES ? `<p class="traceMapPanel__none">+${items.length - PANEL_EDGES} more</p>` : "";
    return `<section class="traceMapPanel__list"><h3>${esc(title)} <small>calls · errors · p95</small></h3><ul>${rows}</ul>${more}</section>`;
  }

  function renderPanel() {
    const panel = byId("traceMapPanel");
    if (!panel) return;
    const target = map.selected;
    if (!target || !map.layout || !map.data) { closePanel(); return; }
    let html = "";
    if (target.kind === "node") {
      const node = map.data.nodes[target.index];
      if (!node) { closePanel(); return; }
      const byCalls = (a, b) => (Number(b.item.edge.calls) || 0) - (Number(a.item.edge.calls) || 0);
      const inbound = map.layout.edges.map((item, i) => ({ item, i })).filter(({ item }) => item.t === target.index).sort(byCalls);
      const outbound = map.layout.edges.map((item, i) => ({ item, i })).filter(({ item }) => item.s === target.index).sort(byCalls);
      html = `<header class="traceMapPanel__head"><span class="traceMap__dot" style="background:${ctx.serviceColor(node.service)}"></span><h3 title="${esc(node.service)}">${esc(node.service)}</h3><button type="button" class="traceMapPanel__close" data-map-close aria-label="Close" title="Close">×</button></header>`
        + statsHtml(node, "Spans", node.spans)
        + '<div class="traceMapPanel__actions">'
        + `<button type="button" class="button button--primary button--small" data-map-search-service="${esc(node.service)}">Search this service</button>`
        + ((Number(node.errors) || 0) > 0 ? `<button type="button" class="button button--small" data-map-search-errors="${esc(node.service)}">Search errors</button>` : "")
        + `<button type="button" class="button button--small" data-map-focus="${esc(node.service)}" title="Keep the traces with a ${esc(node.service)} span on the map">Focus map</button>`
        + "</div>"
        + edgeListHtml("Called by", inbound, "source")
        + edgeListHtml("Calls", outbound, "target");
    } else {
      const item = map.layout.edges[target.index];
      if (!item) { closePanel(); return; }
      const edge = item.edge;
      html = `<header class="traceMapPanel__head"><h3 title="${esc(`${edge.source} \u2192 ${edge.target}`)}"><button type="button" class="traceMapPanel__link" data-map-select-node="${item.s}">${esc(edge.source)}</button><span aria-hidden="true">\u2192</span><button type="button" class="traceMapPanel__link" data-map-select-node="${item.t}">${esc(edge.target)}</button></h3><button type="button" class="traceMapPanel__close" data-map-close aria-label="Close" title="Close">×</button></header>`
        + statsHtml(edge, "Calls", edge.calls)
        + `<p class="traceMapPanel__note">Durations and errors of the ${esc(edge.target)} spans whose parent span is a ${esc(edge.source)} span.</p>`
        + '<div class="traceMapPanel__actions">'
        + `<button type="button" class="button button--primary button--small" data-map-search-edge="${target.index}">Search calls ${esc(shortName(edge.source))} \u2192 ${esc(shortName(edge.target))}</button>`
        + ((Number(edge.errors) || 0) > 0 ? `<button type="button" class="button button--small" data-map-search-edge-errors="${target.index}">Search errors</button>` : "")
        + "</div>";
    }
    panel.innerHTML = html;
    panel.hidden = false;
    byId("traceMapCanvas")?.classList.add("has-panel");
  }

  // ---------------------------------------------------------------- hand-off

  // Search tab with the service filter (and status=Error): the search module
  // applies it and runs the search, which writes the URL (tab=search).
  function searchService(service, { errors = false, stay = false } = {}) {
    if (!service || !ns.traceSearch?.applyFilter) return;
    if (!stay) ns.traceTabs.select("search", { url: "none", activate: false });
    const status = ctx.dom.tracesStatus;
    if (status && errors) {
      status.value = "Error";
      status.dispatchEvent(new Event("tracepicker-refresh"));
    }
    ns.traceSearch.applyFilter({ kind: "service" }, service, "include");
  }

  // ---------------------------------------------------------------- events

  function onPanelClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const edgeOf = (attr) => map.layout?.edges[Number(target.closest(`[${attr}]`)?.getAttribute(attr))]?.edge;
    if (target.closest("[data-map-close]")) { closePanel(); byId("traceMapCanvas")?.focus?.({ preventScroll: true }); return; }
    const service = target.closest("[data-map-search-service]")?.getAttribute("data-map-search-service");
    if (service) { searchService(service); return; }
    const errors = target.closest("[data-map-search-errors]")?.getAttribute("data-map-search-errors");
    if (errors) { searchService(errors, { errors: true }); return; }
    const focus = target.closest("[data-map-focus]")?.getAttribute("data-map-focus");
    if (focus) { closePanel(); searchService(focus, { stay: true }); return; }
    if (target.closest("[data-map-search-edge]")) { const edge = edgeOf("data-map-search-edge"); if (edge) searchService(edge.target); return; }
    if (target.closest("[data-map-search-edge-errors]")) { const edge = edgeOf("data-map-search-edge-errors"); if (edge) searchService(edge.target, { errors: true }); return; }
    const edgeButton = target.closest("[data-map-select-edge]");
    if (edgeButton) { select({ kind: "edge", index: Number(edgeButton.getAttribute("data-map-select-edge")) }); return; }
    const nodeButton = target.closest("[data-map-select-node]");
    if (nodeButton) select({ kind: "node", index: Number(nodeButton.getAttribute("data-map-select-node")) });
  }

  function onPointerDown(event) {
    if (event.button !== 0 || !map.layout) return;
    // Buttons over the canvas (Retry) keep their click: no pointer capture.
    if (event.target instanceof Element && event.target.closest("button")) return;
    const canvas = byId("traceMapCanvas");
    map.drag = { x: event.clientX, y: event.clientY, vx: map.view.x, vy: map.view.y, moved: false, id: event.pointerId };
    canvas?.setPointerCapture?.(event.pointerId);
  }

  function onPointerMove(event) {
    if (map.drag) {
      const dx = event.clientX - map.drag.x;
      const dy = event.clientY - map.drag.y;
      if (!map.drag.moved && Math.hypot(dx, dy) < 4) return;
      map.drag.moved = true;
      byId("traceMapCanvas")?.classList.add("is-panning");
      hideTip();
      map.view.x = map.drag.vx + dx;
      map.view.y = map.drag.vy + dy;
      map.fitted = false;
      applyView();
      return;
    }
    const target = targetOf(event.target instanceof Element ? event.target : null);
    if (!sameTarget(target, map.hovered)) {
      map.hovered = target;
      applyHighlight();
    }
    showTip(target, event.clientX, event.clientY);
  }

  function onPointerUp(event) {
    const drag = map.drag;
    map.drag = null;
    byId("traceMapCanvas")?.classList.remove("is-panning");
    byId("traceMapCanvas")?.releasePointerCapture?.(event.pointerId);
    if (!drag || drag.moved) return;
    // A click: pointer capture retargets the event, so find what is under it.
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const target = targetOf(under);
    if (target) select(sameTarget(target, map.selected) ? null : target);
    else if (under?.closest?.("#traceMapSvg")) closePanel();
    if (!map.selected) closePanel();
  }

  function onPointerLeave() {
    if (map.drag) return;
    map.hovered = null;
    applyHighlight();
    hideTip();
  }

  function onWheel(event) {
    if (!map.layout) return;
    event.preventDefault();
    const box = byId("traceMapCanvas").getBoundingClientRect();
    const factor = Math.exp(-Math.max(-60, Math.min(60, event.deltaY)) * 0.0045);
    zoomAt(factor, event.clientX - box.left, event.clientY - box.top);
  }

  function onKeydown(event) {
    const target = targetOf(event.target instanceof Element ? event.target : null);
    if ((event.key === "Enter" || event.key === " ") && target) {
      event.preventDefault();
      select(target);
      byId("traceMapPanel")?.querySelector("button")?.focus?.({ preventScroll: true });
      return;
    }
    if (event.key === "Escape" && map.selected) { event.preventDefault(); closePanel(); return; }
    if (event.target instanceof Element && event.target.closest("#traceMapPanel")) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomCentre(1.25); }
    else if (event.key === "-") { event.preventDefault(); zoomCentre(0.8); }
    else if (event.key === "0") { event.preventDefault(); fit(); }
  }

  function onFocusIn(event) {
    const target = targetOf(event.target instanceof Element ? event.target : null);
    if (target?.kind !== "node") return;
    map.hovered = target;
    applyHighlight();
  }

  // ---------------------------------------------------------------- loading

  async function load(filters, { force = false } = {}) {
    const key = ns.traceSearch?.searchKey?.() || "";
    if (!force && key === map.key && (map.loading || map.data)) return;
    const seq = ++map.seq;
    map.key = key;
    map.loading = true;
    map.error = "";
    renderState();
    try {
      const payload = await ctx.api.getTraceServiceMap(ctx.currentHost(), filters);
      if (seq !== map.seq) return;
      const previous = map.selected && map.data ? { kind: map.selected.kind, id: map.selected.kind === "node" ? map.data.nodes[map.selected.index]?.service : edgeId(map.layout?.edges[map.selected.index]?.edge || {}) } : null;
      map.data = normalize(payload);
      ctx.registerServiceColors?.(map.data.nodes.map((node) => node.service));
      map.loading = false;
      renderGraph();
      fit();
      // A selection that still exists stays open.
      map.selected = null;
      if (previous && map.layout) {
        const index = previous.kind === "node"
          ? map.data.nodes.findIndex((node) => node.service === previous.id)
          : map.layout.edges.findIndex((item) => edgeId(item.edge) === previous.id);
        if (index >= 0) map.selected = { kind: previous.kind, index };
      }
      if (map.selected) renderPanel(); else closePanel();
      applyHighlight();
    } catch (error) {
      if (seq !== map.seq) return;
      map.error = error instanceof Error ? error.message : String(error);
      // Not the key of any search (the default search's key is ""): Retry reloads.
      map.key = null;
    } finally {
      if (seq === map.seq) {
        map.loading = false;
        renderMeta();
        renderLegend();
        renderState();
      }
    }
  }

  // Shown from a click or Back / Forward: the current search refreshes the
  // map unless it already shows it.
  function onShow() {
    const key = ns.traceSearch?.searchKey?.() || "";
    if (key !== map.key || (!map.data && !map.loading)) void ctx.runSearch({ url: "none" });
    else if (map.layout && map.fitted) requestAnimationFrame(fit);
  }

  function install(context) {
    ctx = context;
    const canvas = byId("traceMapCanvas");
    if (!canvas) return;
    canvas.tabIndex = -1;
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", () => { map.drag = null; canvas.classList.remove("is-panning"); });
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Keys from the canvas and from the side panel (Escape closes it).
    canvas.parentElement?.addEventListener("keydown", onKeydown);
    canvas.addEventListener("focusin", onFocusIn);
    canvas.addEventListener("focusout", () => { map.hovered = null; applyHighlight(); });
    byId("traceMapPanel")?.addEventListener("click", onPanelClick);
    // Escape closes the panel even when its focused button was re-rendered away.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !map.selected || byId("traceMapView")?.hidden || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target !== document.body && !event.target.closest(".traceMap")) return;
      event.preventDefault();
      closePanel();
    });
    byId("traceMapState")?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-map-retry]")) void ctx.runSearch({ url: "none" });
    });
    // The panel sits inside the canvas: its clicks are not map clicks.
    byId("traceMapPanel")?.addEventListener("pointerdown", (event) => event.stopPropagation());
    byId("traceMapZoomIn")?.addEventListener("click", () => zoomCentre(1.25));
    byId("traceMapZoomOut")?.addEventListener("click", () => zoomCentre(0.8));
    byId("traceMapFit")?.addEventListener("click", () => fit());
    if (typeof ResizeObserver === "function") {
      let last = "";
      new ResizeObserver(() => {
        const { width, height } = canvasSize();
        const size = `${Math.round(width)}x${Math.round(height)}`;
        if (size === last) return;
        last = size;
        if (map.layout && map.fitted) fit();
      }).observe(canvas);
    }
    renderLegend();
    renderState();
  }

  ns.traceTabs.register({
    id: "map",
    label: "Service map",
    order: 20,
    panelId: "traceMapView",
    install,
    onSearch: (filters, options) => load(filters, options),
    onShow,
    onHide: () => { hideTip(); map.hovered = null; },
  });

  // For tests and other modules: the layout of a payload (no DOM).
  ns.traceMap = { computeLayout: (payload, width = 1200, height = 700) => computeLayout(normalize(payload), width, height), state: () => map };
})();
