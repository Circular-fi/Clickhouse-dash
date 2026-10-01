(() => {
  "use strict";
  // Service map tab of the Traces page, after HyperDX's DBServiceMapPage: the
  // services of the traces matching the search (time range, filters and chips)
  // and the calls between them from /api/traces/service_map, drawn with the
  // shared canvas graph kit (app_graph_kit.js) exactly like the Explorer
  // graph: one card per service (name; spans and error rate; p95; a left strip
  // in its Traces colour; a health dot and a red border on errors),
  // orthogonal edges whose dash pattern is the call kind (solid synchronous,
  // dashed asynchronous messaging, dotted database / cache), whose colour is
  // the error severity and whose width grows mildly with the calls, and an
  // always visible "calls · p95" label on every edge. Hover outlines a service
  // and its calls; a click recentres on it and opens the side panel with the
  // metrics and the hand-off to the Search tab. A List view (the phone
  // default) lists services and calls.
  const ns = window.ChDash;
  if (!ns || !ns.traceTabs || !ns.graphKit) return;
  const kit = ns.graphKit;

  // HyperDX's error-rate buckets (ERROR_RATE_ELEVATED / ERROR_RATE_HIGH).
  const ERROR_ELEVATED = 0.01;
  const ERROR_HIGH = 0.05;
  // Health dot from 0.1 % errors (below that it is noise on a busy service).
  const HEALTH_MIN_RATE = 0.001;
  const CARD_WIDTH = 216;
  const CARD_HEIGHT = 72;
  const X_GAP = 128;
  const Y_GAP = 40;
  const FIT_MAX = 1.35;
  // The smallest card font is 12 px: Fit keeps it at 11 px or more.
  const READABLE_SCALE = 11 / 12;
  const PANEL_EDGES = 6;
  const NAME_CHARS = 22;
  const KIND_DASH = { sync: kit.DASH.solid, async: kit.DASH.message, db: kit.DASH.dotted };
  const KIND_LABELS = { sync: "Synchronous calls", async: "Asynchronous messages", db: "Database / cache calls" };

  let ctx = null;
  let ctl = null;
  const byId = (id) => document.getElementById(id);
  const esc = (value) => ctx.esc(value);

  const map = {
    seq: 0,
    key: null,
    loading: false,
    error: "",
    data: null,
    layout: null,
    // View transform, mutated by the kit controller.
    view: { scale: 1, offsetX: 0, offsetY: 0 },
    fitScale: 1,
    fitted: true,
    // { kind: "node" | "edge", id } | null
    selected: null,
    hovered: null,
    // "canvas" | "list"; null until the user picks one (phones default to list).
    viewMode: null,
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

  function serviceColor(service) {
    return kit.theme.resolveColor(ctx.serviceColor(service));
  }

  function edgeLabelText(edge) {
    return `${compact(edge.calls)} · p95 ${duration(edge.p95_ns)}`;
  }

  // ---------------------------------------------------------------- data

  function callKind(value) {
    const kind = String(value || "").toLowerCase();
    if (kind === "async" || kind === "messaging" || kind === "producer" || kind === "consumer") return "async";
    if (kind === "db" || kind === "database" || kind === "cache") return "db";
    return "sync";
  }

  function normalize(payload) {
    const nodes = Array.isArray(payload?.nodes) ? payload.nodes.map((node) => ({ ...node, service: String(node.service || "") })) : [];
    const edges = Array.isArray(payload?.edges)
      ? payload.edges.map((edge) => ({ ...edge, source: String(edge.source || ""), target: String(edge.target || ""), kind: callKind(edge.kind) }))
      : [];
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

  // The kit's layered layout (longest-path columns after DFS cycle breaking,
  // barycentre sweeps, one global row grid) feeds the kit's orthogonal
  // router: the row grid is what keeps routes straight. Callers sit left of
  // their callees; a call against that order (a cycle) is routed from the
  // callee's left side back into the caller's right side. Services without
  // any call are a grid under the graph.
  function computeLayout(data, measure = null) {
    const nodes = data.nodes.map((node, order) => ({ id: node.service, node, order }));
    const edges = data.edges.map((edge) => ({ id: edgeId(edge), from: edge.source, to: edge.target, edge }));
    const degree = new Map();
    for (const edge of edges) {
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    }
    const connected = nodes.filter((node) => degree.get(node.id));
    const isolated = nodes.filter((node) => !degree.get(node.id));
    const { positions, level } = kit.layered({
      nodes: connected,
      edges,
      size: () => ({ width: CARD_WIDTH, height: CARD_HEIGHT }),
      // Busiest first (the backend sorts by spans).
      compare: (a, b) => a.order - b.order,
      rowGrid: true,
      rowPitch: CARD_HEIGHT + Y_GAP,
      xGap: X_GAP,
      yGap: Y_GAP,
      minColumnWidth: CARD_WIDTH,
      origin: 0,
      breakCycles: true,
    });
    let maxY = -Infinity;
    for (const item of positions.values()) maxY = Math.max(maxY, item.y + item.height);
    const columns = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(isolated.length * 2))));
    isolated.forEach((node, index) => {
      positions.set(node.id, {
        x: (index % columns) * (CARD_WIDTH + 40),
        y: (Number.isFinite(maxY) ? maxY + 80 : 0) + Math.floor(index / columns) * (CARD_HEIGHT + 28),
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        node,
      });
    });

    // Calls against the column order are routed reversed, then flipped back.
    const back = new Set(edges.filter((edge) => (level.get(edge.to) ?? 0) <= (level.get(edge.from) ?? 0)).map((edge) => edge.id));
    const routed = kit.routeEdges(positions, edges.map((edge) => (back.has(edge.id) ? { ...edge, from: edge.to, to: edge.from } : edge)));
    const maxCalls = Math.max(1, ...data.edges.map((edge) => Number(edge.calls) || 0));
    const edgeItems = edges.map((edge) => {
      const route = routed.get(edge.id);
      const points = route ? (back.has(edge.id) ? route.points.slice().reverse() : route.points) : [];
      const calls = Number(edge.edge.calls) || 0;
      return {
        id: edge.id,
        edge: edge.edge,
        from: edge.from,
        to: edge.to,
        back: back.has(edge.id),
        points,
        kind: edge.edge.kind,
        level: severity(Number(edge.edge.error_rate) || 0),
        width: 1.25 + 2.25 * Math.sqrt(calls / maxCalls),
      };
    });

    // Every edge label, busiest calls first (they get the best spots).
    const textWidth = measure || ((text) => text.length * 6.6);
    const ordered = edgeItems.slice().sort((a, b) => (Number(b.edge.calls) || 0) - (Number(a.edge.calls) || 0) || a.id.localeCompare(b.id));
    const requests = ordered.filter((item) => item.points.length >= 2).map((item) => {
      const text = edgeLabelText(item.edge);
      return { key: item.id, text, width: textWidth(text) + 12, height: 18, points: item.points };
    });
    const { placed, dropped } = kit.placeLabels(requests, [...positions.values()]);
    const labels = new Map(requests.filter((request) => placed.has(request.key)).map((request) => [request.key, { text: request.text, rect: placed.get(request.key) }]));

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxBottom = -Infinity;
    const grow = (rect) => {
      minX = Math.min(minX, rect.x); minY = Math.min(minY, rect.y);
      maxX = Math.max(maxX, rect.x + rect.width); maxBottom = Math.max(maxBottom, rect.y + rect.height);
    };
    for (const item of positions.values()) grow(item);
    for (const label of labels.values()) grow(label.rect);
    for (const item of edgeItems) for (const point of item.points) grow({ x: point.x, y: point.y, width: 0, height: 0 });
    const bounds = Number.isFinite(minX)
      ? { x: minX - 40, y: minY - 40, width: maxX - minX + 80, height: maxBottom - minY + 80 }
      : { x: 0, y: 0, width: 1, height: 1 };
    return { items: positions, edges: edgeItems, edgeById: new Map(edgeItems.map((item) => [item.id, item])), labels, dropped, bounds };
  }

  // ---------------------------------------------------------------- render

  function canvas() {
    return byId("traceMapCanvas");
  }

  function shown() {
    const view = byId("traceMapView");
    return !!view && !view.hidden;
  }

  function mobileLayout() {
    return kit.mobileLayout();
  }

  function currentViewMode() {
    if (map.viewMode) return map.viewMode;
    return mobileLayout() ? "list" : "canvas";
  }

  function nodeHighlighted(id) {
    return map.hovered?.type === "node" && map.hovered.id === id;
  }

  function edgeHighlighted(item) {
    if (map.selected?.kind === "edge" && map.selected.id === item.id) return true;
    const hover = map.hovered;
    if (!hover) return false;
    if (hover.type === "edge") return hover.id === item.id;
    return hover.type === "node" && (item.from === hover.id || item.to === hover.id);
  }

  function drawService(context, item, compactCards) {
    const node = item.node.node;
    const rate = Number(node.error_rate) || 0;
    const level = severity(rate);
    const selected = map.selected?.kind === "node" && map.selected.id === item.node.id;
    const hovered = nodeHighlighted(item.node.id);
    const card = {
      radius: 10,
      halo: selected,
      border: selected || hovered ? kit.color("halo") : level === "err" ? kit.color("error") : kit.color("border"),
      borderWidth: selected ? 2.4 : hovered || level === "err" ? 1.8 : 1.2,
      strip: serviceColor(node.service),
      status: rate >= HEALTH_MIN_RATE ? "error" : null,
      statusAlpha: level === "ok" ? 0.62 : 1,
      rows: [],
    };
    if (compactCards) {
      const size = kit.compactTitleSize(map.view.scale);
      if (size) card.rows.push({ text: node.service, size, weight: 600, y: Math.min(item.height - 10, 12 + size), fit: "full" });
    } else {
      card.rows.push(
        { text: node.service, size: 13, weight: 600, y: 22 },
        {
          text: `${compact(node.spans)} spans · ${percent(rate)} errors`,
          y: 41,
          color: level === "err" ? kit.color("error") : level === "warn" ? kit.color("warn") : kit.color("muted"),
        },
        { text: `p95 ${duration(node.p95_ns)}`, y: 59 },
      );
    }
    kit.drawCard(context, item, card);
  }

  function edgeColor(item, highlighted) {
    if (item.level === "err") return kit.color("error");
    if (item.level === "warn") return kit.color("warn");
    return highlighted ? kit.color("halo") : kit.color("edgeMuted");
  }

  function draw(context, frame) {
    const layout = map.layout;
    const minimap = byId("traceMapMinimap");
    if (!layout) {
      if (minimap) minimap.hidden = true;
      return false;
    }
    const view = map.view;
    const compactCards = view.scale < READABLE_SCALE - 1e-6;
    context.save();
    context.translate(view.offsetX, view.offsetY);
    context.scale(view.scale, view.scale);
    for (const item of layout.edges) {
      if (item.points.length < 2) continue;
      const highlighted = edgeHighlighted(item);
      context.save();
      context.globalAlpha = highlighted ? 1 : 0.88;
      context.strokeStyle = edgeColor(item, highlighted);
      context.lineWidth = item.width + (highlighted ? 1.2 : 0);
      context.lineJoin = "round";
      context.setLineDash(KIND_DASH[item.kind] || KIND_DASH.sync);
      kit.strokePolyline(context, item.points);
      kit.drawArrowHead(context, item.points, 7 + item.width);
      context.restore();
    }
    for (const item of layout.items.values()) drawService(context, item, compactCards);
    map.labelHits = [];
    if (!compactCards) {
      context.font = `600 12px ${kit.FONT}`;
      const left = -view.offsetX / view.scale;
      const top = -view.offsetY / view.scale;
      const right = left + frame.width / view.scale;
      const bottom = top + frame.height / view.scale;
      for (const item of layout.edges) {
        const label = layout.labels.get(item.id);
        if (!label) continue;
        const rect = label.rect;
        if (rect.x > right || rect.x + rect.width < left || rect.y > bottom || rect.y + rect.height < top) continue;
        const highlighted = edgeHighlighted(item);
        kit.drawLabel(context, rect, label.text, {
          highlighted,
          textColor: item.level === "err" ? kit.color("error") : item.level === "warn" ? kit.color("warn") : null,
        });
        map.labelHits.push({ id: item.id, ...rect });
      }
    }
    context.restore();

    if (minimap) {
      const visible = kit.anyClipped(layout.items.values(), view, frame.width, frame.height) || view.scale < READABLE_SCALE - 1e-6;
      minimap.hidden = !visible || currentViewMode() === "list";
      if (!minimap.hidden) {
        kit.drawMinimap(minimap, {
          bounds: layout.bounds,
          nodes: [...layout.items.values()].map((item) => ({ ...item, alpha: map.selected?.kind === "node" && map.selected.id === item.node.id ? 1 : 0.62 })),
          edges: layout.edges.map((item) => ({ points: item.points, dash: KIND_DASH[item.kind], width: 1, color: edgeColor(item, false) })),
          view,
          width: frame.width,
          height: frame.height,
        });
      }
    }
    return false;
  }

  // Layout items: { x, y, width, height, node: { id, node: payload row, order } }.
  function layoutItems() {
    return map.layout ? [...map.layout.items.values()] : [];
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
    const kinds = new Set((map.data?.edges || []).map((edge) => edge.kind));
    const row = (marks, text, hidden = false) => `<span class="graphKitLegend__row"${hidden ? " hidden" : ""}>${marks}<span>${text}</span></span>`;
    legend.innerHTML = row('<i class="graphKitLegend__card"></i>', "Service: strip in its Traces colour")
      + row('<i class="graphKitLegend__dot"></i>', `Health dot: error rate \u2265 ${HEALTH_MIN_RATE * 100}%, red border \u2265 ${ERROR_HIGH * 100}%`)
      + row('<i class="graphKitLegend__line graphKitLegend__line--muted"></i>', "synchronous call (HTTP, gRPC, RPC)")
      + row('<i class="graphKitLegend__line graphKitLegend__line--dashed graphKitLegend__line--muted"></i>', "asynchronous message (producer \u2192 consumer)", !kinds.has("async"))
      + row('<i class="graphKitLegend__line graphKitLegend__line--dotted graphKitLegend__line--muted"></i>', "database / cache call", !kinds.has("db"))
      + row('<i class="graphKitLegend__line graphKitLegend__line--thin graphKitLegend__line--muted"></i><i class="graphKitLegend__line graphKitLegend__line--thin graphKitLegend__line--warn"></i><i class="graphKitLegend__line graphKitLegend__line--thin graphKitLegend__line--error"></i>',
        `&lt; ${ERROR_ELEVATED * 100}% · ${ERROR_ELEVATED * 100}\u2013${ERROR_HIGH * 100}% · \u2265 ${ERROR_HIGH * 100}% errors`)
      + row('<i class="graphKitLegend__line graphKitLegend__line--thin graphKitLegend__line--muted"></i><i class="graphKitLegend__line graphKitLegend__line--thick graphKitLegend__line--muted"></i>', "width: calls · label: calls · p95");
  }

  function renderState() {
    const root = byId("traceMapState");
    const pane = byId("traceMapPane");
    if (!root) return;
    const hasGraph = !!map.data && map.data.nodes.length > 0;
    pane?.classList.toggle("is-loading", map.loading);
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

  function measureText() {
    const context = canvas()?.getContext?.("2d");
    if (!context) return null;
    context.font = `600 12px ${kit.FONT}`;
    return (text) => context.measureText(text).width;
  }

  function renderGraph() {
    const data = map.data;
    if (!data || !data.nodes.length) {
      map.layout = null;
      closePanel();
      ctl?.scheduleDraw();
      renderList();
      return;
    }
    map.layout = computeLayout(data, measureText());
    renderList();
  }

  // ---------------------------------------------------------- view / camera

  // The whole map in the part of the canvas its chrome leaves free.
  function overviewScale() {
    const box = kit.safeArea(canvas());
    const bounds = map.layout?.bounds;
    if (!bounds || !box?.width || !box?.height) return 1;
    return Math.max(0.05, Math.min(FIT_MAX, Math.min(box.width / bounds.width, box.height / bounds.height) * 0.92));
  }

  // Fit shows the whole map, never with text below 11 px: a larger map is
  // shown from its top-left (or around the selected service) at the readable
  // scale and the minimap gives the rest.
  function fit() {
    const box = canvas()?.getBoundingClientRect();
    const layout = map.layout;
    if (!layout || !box?.width || !box?.height) return;
    kit.foldLegendToFit(canvas(), layout.bounds, { readableScale: READABLE_SCALE });
    const overview = overviewScale();
    const scale = Math.max(overview, READABLE_SCALE);
    const bounds = layout.bounds;
    const anchor = map.selected?.kind === "node" ? layout.items.get(map.selected.id) : null;
    map.view.scale = scale;
    if (scale > overview + 1e-9 && anchor) {
      map.view.offsetX = box.width / 2 - (anchor.x + anchor.width / 2) * scale;
      map.view.offsetY = box.height / 2 - (anchor.y + anchor.height / 2) * scale;
    } else if (scale > overview + 1e-9) {
      map.view.offsetX = 24 - bounds.x * scale;
      map.view.offsetY = 64 - bounds.y * scale;
    } else {
      // Below the toolbar, above the legend and the status line.
      const area = kit.safeArea(canvas());
      map.view.offsetX = area.x + area.width / 2 - (bounds.x + bounds.width / 2) * scale;
      map.view.offsetY = area.y + area.height / 2 - (bounds.y + bounds.height / 2) * scale;
    }
    kit.clampView(map.view, bounds, box.width, box.height);
    map.fitScale = scale;
    map.fitted = true;
    ctl?.scheduleDraw();
  }

  function minimumScale() {
    return Math.min(map.fitScale || 0.06, overviewScale());
  }

  function hitTest(clientX, clientY) {
    const layout = map.layout;
    const box = canvas()?.getBoundingClientRect();
    if (!layout || !box) return null;
    const point = { x: (clientX - box.left - map.view.offsetX) / map.view.scale, y: (clientY - box.top - map.view.offsetY) / map.view.scale };
    for (const item of layout.items.values()) {
      if (kit.pointInRect(point, item)) return { type: "node", key: `node\u0000${item.node.id}`, id: item.node.id };
    }
    for (const hit of map.labelHits || []) {
      if (kit.pointInRect(point, hit, 2 / map.view.scale)) return { type: "edge", key: `edge\u0000${hit.id}`, id: hit.id };
    }
    const tolerance = 6 / map.view.scale;
    let best = null;
    for (const item of layout.edges) {
      if (item.points.length < 2) continue;
      const distance = kit.distanceToPolyline(point, item.points);
      if (distance <= tolerance && (!best || distance < best.distance)) best = { item, distance };
    }
    return best ? { type: "edge", key: `edge\u0000${best.item.id}`, id: best.item.id } : null;
  }

  function nodeTarget(id) {
    return map.layout?.items.has(id) ? { type: "node", key: `node\u0000${id}`, id } : null;
  }

  function describeNode(id) {
    const node = map.layout?.items.get(id)?.node?.node;
    if (!node) return "";
    return `${node.service}: ${compact(node.spans)} spans, ${percent(node.error_rate)} errors, p95 ${duration(node.p95_ns)}. Enter selects it.`;
  }

  // ------------------------------------------------------- hover / selection

  // A click on a service recentres on it and selects it (side panel); on a
  // call, selects the call; on the background, closes the panel.
  function select(target, { center = true } = {}) {
    map.selected = target;
    renderPanel();
    renderList();
    if (target?.kind === "node" && center) {
      const item = map.layout?.items.get(target.id);
      if (item) ctl?.centerOn(item);
    }
    ctl?.scheduleDraw();
  }

  function closePanel() {
    map.selected = null;
    const panel = byId("traceMapPanel");
    if (panel) { panel.hidden = true; panel.replaceChildren(); }
    byId("traceMapPane")?.classList.remove("graphKitPane--panel");
    renderList();
    ctl?.scheduleDraw();
  }

  function onClick(target) {
    if (target?.type === "node") select({ kind: "node", id: target.id });
    else if (target?.type === "edge") select({ kind: "edge", id: target.id }, { center: false });
    else closePanel();
  }

  function statsHtml(item, countLabel, count) {
    return '<dl class="graphKitPanel__stats">'
      + `<div><dt>${esc(countLabel)}</dt><dd>${esc(compact(count))}<small>${esc(perSecond(count))}</small></dd></div>`
      + `<div><dt>Errors</dt><dd class="is-${severity(item.error_rate)}">${esc(percent(item.error_rate))}<small>${esc(compact(item.errors))}</small></dd></div>`
      + `<div><dt>p50</dt><dd>${esc(duration(item.p50_ns))}</dd></div>`
      + `<div><dt>p95</dt><dd>${esc(duration(item.p95_ns))}</dd></div>`
      + `<div><dt>p99</dt><dd>${esc(duration(item.p99_ns))}</dd></div>`
      + "</dl>";
  }

  function edgeListHtml(title, items, other) {
    if (!items.length) return `<section class="graphKitPanel__section traceMapPanel__list"><h3 class="graphKitPanel__sectionTitle">${esc(title)}</h3><p class="graphKitPanel__note">None</p></section>`;
    const rows = items.slice(0, PANEL_EDGES).map((item) => {
      const service = item.edge[other];
      return `<li><button type="button" class="traceMapPanel__edge" data-map-select-edge="${esc(item.id)}" title="${esc(`${item.edge.source} \u2192 ${item.edge.target}`)}"><span class="traceMap__dot" style="background:${ctx.serviceColor(service)}"></span><span class="traceMapPanel__edgeName">${esc(service)}</span><span>${esc(compact(item.edge.calls))}</span><span class="is-${severity(item.edge.error_rate)}">${esc(percent(item.edge.error_rate))}</span><span>${esc(duration(item.edge.p95_ns))}</span></button></li>`;
    }).join("");
    const more = items.length > PANEL_EDGES ? `<p class="graphKitPanel__note">+${items.length - PANEL_EDGES} more</p>` : "";
    return `<section class="graphKitPanel__section traceMapPanel__list"><h3 class="graphKitPanel__sectionTitle">${esc(title)} <small>calls · errors · p95</small></h3><ul class="traceMapPanel__edges">${rows}</ul>${more}</section>`;
  }

  function fragment(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  function renderPanel() {
    const panel = byId("traceMapPanel");
    if (!panel) return;
    const target = map.selected;
    if (!target || !map.layout || !map.data) { closePanel(); return; }
    const onClose = () => { closePanel(); canvas()?.focus?.({ preventScroll: true }); };
    const body = kit.el("div", "graphKitPanel__body");
    if (target.kind === "node") {
      const item = map.layout.items.get(target.id);
      const node = item?.node?.node;
      if (!node) { closePanel(); return; }
      const byCalls = (a, b) => (Number(b.edge.calls) || 0) - (Number(a.edge.calls) || 0);
      const inbound = map.layout.edges.filter((edge) => edge.to === target.id).sort(byCalls);
      const outbound = map.layout.edges.filter((edge) => edge.from === target.id).sort(byCalls);
      body.append(kit.panelHeader({ eyebrow: "Service", title: node.service, dot: ctx.serviceColor(node.service), subtitle: `${compact(node.spans)} spans · ${perSecond(node.spans)}`, onClose }));
      body.append(fragment(statsHtml(node, "Spans", node.spans)
        + '<div class="graphKitPanel__actions">'
        + `<button type="button" class="button button--primary button--small" data-map-search-service="${esc(node.service)}">Search this service</button>`
        + ((Number(node.errors) || 0) > 0 ? `<button type="button" class="button button--small" data-map-search-errors="${esc(node.service)}">Search errors</button>` : "")
        + `<button type="button" class="button button--small" data-map-focus="${esc(node.service)}" title="Keep the traces with a ${esc(node.service)} span on the map">Focus map</button>`
        + "</div>"
        + edgeListHtml("Called by", inbound, "source")
        + edgeListHtml("Calls", outbound, "target")));
    } else {
      const item = map.layout.edgeById.get(target.id);
      if (!item) { closePanel(); return; }
      const edge = item.edge;
      const title = document.createDocumentFragment();
      title.append(fragment(`<button type="button" class="graphKitPanel__link" data-map-select-node="${esc(edge.source)}">${esc(edge.source)}</button><span class="graphKitPanel__arrow" aria-hidden="true">\u2192</span><button type="button" class="graphKitPanel__link" data-map-select-node="${esc(edge.target)}">${esc(edge.target)}</button>`));
      body.append(kit.panelHeader({ eyebrow: KIND_LABELS[item.kind] || KIND_LABELS.sync, title, subtitle: `${compact(edge.calls)} calls · ${perSecond(edge.calls)}`, onClose }));
      body.append(fragment(statsHtml(edge, "Calls", edge.calls)
        + `<p class="graphKitPanel__note">Durations and errors of the ${esc(edge.target)} spans whose parent span is a ${esc(edge.source)} span.</p>`
        + '<div class="graphKitPanel__actions">'
        + `<button type="button" class="button button--primary button--small" data-map-search-edge="${esc(item.id)}">Search calls ${esc(shortName(edge.source))} \u2192 ${esc(shortName(edge.target))}</button>`
        + ((Number(edge.errors) || 0) > 0 ? `<button type="button" class="button button--small" data-map-search-edge-errors="${esc(item.id)}">Search errors</button>` : "")
        + "</div>"));
    }
    panel.replaceChildren(body);
    panel.hidden = false;
    panel.dataset.panelType = target.kind;
    byId("traceMapPane")?.classList.add("graphKitPane--panel");
  }

  // ------------------------------------------------------------- list view

  function setViewMode(mode) {
    map.viewMode = mode === "list" ? "list" : "canvas";
    renderChrome();
    if (map.viewMode === "canvas") {
      ctl?.size();
      if (map.fitted) fit();
      else ctl?.scheduleDraw();
    }
  }

  function renderChrome() {
    const pane = byId("traceMapPane");
    const list = currentViewMode() === "list";
    pane?.classList.toggle("graphKitPane--list", list);
    map.switch?.set(list ? "list" : "canvas");
    const section = byId("traceMapList");
    if (section) {
      section.hidden = !list;
      if (list) renderList();
    }
  }

  function renderList() {
    const section = byId("traceMapList");
    if (!section || section.hidden) return;
    const data = map.data;
    if (!data || !data.nodes.length) {
      section.innerHTML = '<div class="graphKitList__header"><h3 class="graphKitList__title">Services</h3></div><p class="graphKitList__empty">No services in this time range.</p>';
      return;
    }
    const selectedNode = map.selected?.kind === "node" ? map.selected.id : null;
    const selectedEdge = map.selected?.kind === "edge" ? map.selected.id : null;
    const services = data.nodes.map((node) => `<tr data-service="${esc(node.service)}"${node.service === selectedNode ? ' class="is-selected"' : ""}>`
      + `<td class="graphKitList__name"><button type="button" class="graphKitList__open" data-map-select-node="${esc(node.service)}"><span class="traceMap__dot" style="background:${ctx.serviceColor(node.service)}"></span>${esc(node.service)}</button></td>`
      + `<td class="graphKitList__num">${esc(compact(node.spans))}</td>`
      + `<td class="graphKitList__num is-${severity(node.error_rate)}">${esc(percent(node.error_rate))}</td>`
      + `<td class="graphKitList__num graphKitList__secondary">${esc(duration(node.p95_ns))}</td></tr>`).join("");
    const edges = (map.layout?.edges || []).slice().sort((a, b) => (Number(b.edge.calls) || 0) - (Number(a.edge.calls) || 0));
    const calls = edges.map((item) => `<tr data-edge="${esc(item.id)}"${item.id === selectedEdge ? ' class="is-selected"' : ""}>`
      + `<td class="graphKitList__name"><button type="button" class="graphKitList__open" data-map-select-edge="${esc(item.id)}">${esc(item.edge.source)} \u2192 ${esc(item.edge.target)}</button></td>`
      + `<td class="graphKitList__secondary">${esc(item.kind)}</td>`
      + `<td class="graphKitList__num">${esc(compact(item.edge.calls))}</td>`
      + `<td class="graphKitList__num is-${item.level}">${esc(percent(item.edge.error_rate))}</td>`
      + `<td class="graphKitList__num graphKitList__secondary">${esc(duration(item.edge.p95_ns))}</td></tr>`).join("");
    section.innerHTML = '<div class="graphKitList__wrap">'
      + `<section class="traceMapList__section"><div class="graphKitList__header"><h3 class="graphKitList__title">Services</h3><span class="graphKitList__meta">${data.nodes.length} service${data.nodes.length === 1 ? "" : "s"}, busiest first</span></div>`
      + '<table class="graphKitList__table" data-map-list="services"><thead><tr><th>Service</th><th class="graphKitList__num">Spans</th><th class="graphKitList__num">Errors</th><th class="graphKitList__num graphKitList__secondary">p95</th></tr></thead>'
      + `<tbody>${services}</tbody></table></section>`
      + `<section class="traceMapList__section"><div class="graphKitList__header"><h3 class="graphKitList__title">Calls</h3><span class="graphKitList__meta">${edges.length} call path${edges.length === 1 ? "" : "s"}</span></div>`
      + (edges.length
        ? '<table class="graphKitList__table" data-map-list="calls"><thead><tr><th>Call</th><th class="graphKitList__secondary">Kind</th><th class="graphKitList__num">Calls</th><th class="graphKitList__num">Errors</th><th class="graphKitList__num graphKitList__secondary">p95</th></tr></thead>'
          + `<tbody>${calls}</tbody></table>`
        : '<p class="graphKitList__empty">No calls between services.</p>')
      + "</section></div>";
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

  // Panel and List buttons (event delegation on data attributes).
  function onActionClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const attr = (name) => target.closest(`[${name}]`)?.getAttribute(name);
    const edgeOf = (name) => map.layout?.edgeById.get(attr(name))?.edge;
    const service = attr("data-map-search-service");
    if (service) { searchService(service); return; }
    const errors = attr("data-map-search-errors");
    if (errors) { searchService(errors, { errors: true }); return; }
    const focus = attr("data-map-focus");
    if (focus) { closePanel(); searchService(focus, { stay: true }); return; }
    if (target.closest("[data-map-search-edge]")) { const edge = edgeOf("data-map-search-edge"); if (edge) searchService(edge.target); return; }
    if (target.closest("[data-map-search-edge-errors]")) { const edge = edgeOf("data-map-search-edge-errors"); if (edge) searchService(edge.target, { errors: true }); return; }
    const edgeButton = attr("data-map-select-edge");
    if (edgeButton) { select({ kind: "edge", id: edgeButton }, { center: false }); return; }
    const nodeButton = attr("data-map-select-node");
    if (nodeButton) select({ kind: "node", id: nodeButton });
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
      const previous = map.selected;
      map.data = normalize(payload);
      ctx.registerServiceColors?.(map.data.nodes.map((node) => node.service));
      map.loading = false;
      renderGraph();
      // The legend and the status line first: the fit leaves room for them.
      renderMeta();
      renderLegend();
      // A selection that still exists stays open.
      map.selected = null;
      if (previous && map.layout && (previous.kind === "node" ? map.layout.items.has(previous.id) : map.layout.edgeById.has(previous.id))) {
        map.selected = previous;
      }
      if (map.selected) renderPanel(); else closePanel();
      fit();
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
        renderList();
      }
    }
  }

  // Shown from a click or Back / Forward: the current search refreshes the
  // map unless it already shows it.
  function onShow() {
    const key = ns.traceSearch?.searchKey?.() || "";
    renderChrome();
    if (key !== map.key || (!map.data && !map.loading)) void ctx.runSearch({ url: "none" });
    else if (map.layout && map.fitted) requestAnimationFrame(fit);
    else ctl?.scheduleDraw();
  }

  function install(context) {
    ctx = context;
    const element = canvas();
    if (!element) return;
    map.switch = kit.viewSwitch({ idPrefix: "traceMap", label: "Map view", onChange: setViewMode });
    byId("traceMapBar")?.append(map.switch.element);
    ctl = kit.mount({
      canvas: element,
      view: map.view,
      active: shown,
      draw,
      bounds: () => map.layout?.bounds || null,
      minScale: minimumScale,
      fit,
      hit: hitTest,
      onHover: (target) => { map.hovered = target; },
      onClick,
      nodes: () => layoutItems().map((item) => ({ id: item.node.id, x: item.x, y: item.y, width: item.width, height: item.height })),
      selectedId: () => (map.selected?.kind === "node" ? map.selected.id : null),
      target: nodeTarget,
      describe: describeNode,
      onActivate: (id) => {
        select({ kind: "node", id });
        byId("traceMapPanel")?.querySelector("button")?.focus?.({ preventScroll: true });
      },
      onEscape: () => {
        if (!map.selected) return false;
        closePanel();
        return true;
      },
      onViewChange: () => { map.fitted = false; },
      onResize: () => { if (map.layout && map.fitted) fit(); },
      panelRect: () => {
        const panel = byId("traceMapPanel");
        return panel && !panel.hidden ? panel.getBoundingClientRect() : null;
      },
      toolbar: { zoomIn: byId("traceMapZoomIn"), zoomOut: byId("traceMapZoomOut"), fit: byId("traceMapFit") },
    });
    kit.theme.onChange(() => { if (shown()) ctl.drawNow(); });
    byId("traceMapPanel")?.addEventListener("click", onActionClick);
    byId("traceMapList")?.addEventListener("click", onActionClick);
    // Escape closes the panel even when its focused button was re-rendered away.
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !map.selected || !shown() || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target !== document.body && !event.target.closest(".traceMap")) return;
      event.preventDefault();
      closePanel();
    });
    byId("traceMapState")?.addEventListener("click", (event) => {
      if (event.target instanceof Element && event.target.closest("[data-map-retry]")) void ctx.runSearch({ url: "none" });
    });
    window.matchMedia?.(kit.MOBILE_QUERY)?.addEventListener?.("change", () => renderChrome());
    renderChrome();
    renderLegend();
    renderState();
  }

  // Read-only geometry of the last drawn frame in client (CSS pixel)
  // coordinates: lets browser tests hover and click real services and calls.
  function inspect() {
    const box = canvas()?.getBoundingClientRect();
    const view = map.view;
    const toClient = (rect) => ({
      x: (box?.left || 0) + rect.x * view.scale + view.offsetX,
      y: (box?.top || 0) + rect.y * view.scale + view.offsetY,
      width: rect.width * view.scale,
      height: rect.height * view.scale,
    });
    const layout = map.layout;
    return {
      kit: true,
      scale: view.scale,
      offsetX: view.offsetX,
      offsetY: view.offsetY,
      fitScale: map.fitScale,
      readableScale: READABLE_SCALE,
      gridSpacing: kit.GRID_SPACING,
      fitted: map.fitted,
      viewMode: currentViewMode(),
      selected: map.selected ? { ...map.selected } : null,
      hovered: map.hovered ? { type: map.hovered.type, id: map.hovered.id } : null,
      keyboardId: ctl?.keyboardId() || null,
      animating: !!ctl?.animating(),
      minimapVisible: !!byId("traceMapMinimap") && !byId("traceMapMinimap").hidden,
      nodes: layout ? [...layout.items.values()].map((item) => {
        const node = item.node.node;
        return {
          id: node.service, service: node.service, severity: severity(Number(node.error_rate) || 0),
          health: (Number(node.error_rate) || 0) >= HEALTH_MIN_RATE, strip: serviceColor(node.service), ...toClient(item),
        };
      }) : [],
      edges: layout ? layout.edges.map((item) => ({
        id: item.id, source: item.from, target: item.to, kind: item.kind, severity: item.level, width: item.width,
        dash: (KIND_DASH[item.kind] || []).slice(), back: item.back, bends: Math.max(0, item.points.length - 2),
        orthogonal: item.points.every((point, i) => i === 0 || Math.abs(point.x - item.points[i - 1].x) < 0.01 || Math.abs(point.y - item.points[i - 1].y) < 0.01),
        points: item.points.map((point) => toClient({ x: point.x, y: point.y, width: 0, height: 0 })),
      })) : [],
      edgeLabels: (map.labelHits || []).map((hit) => ({ id: hit.id, text: layout?.labels.get(hit.id)?.text || "", ...toClient(hit) })),
      edgeLabelsPlaced: layout ? layout.labels.size : 0,
      edgeLabelsDropped: layout ? layout.dropped.slice() : [],
    };
  }

  ns.traceTabs.register({
    id: "map",
    label: "Service map",
    order: 20,
    panelId: "traceMapView",
    install,
    onSearch: (filters, options) => load(filters, options),
    onShow,
    onHide: () => { map.hovered = null; },
  });

  // For tests and other modules: the layout of a payload (no DOM), and the
  // drawn geometry.
  ns.traceMap = { computeLayout: (payload) => computeLayout(normalize(payload)), state: () => map, inspect };
})();
