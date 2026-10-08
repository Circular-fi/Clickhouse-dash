(() => {
  "use strict";
  // Shared canvas graph kit (ns.graphKit): one look and one interaction model
  // for every node / edge graph (Explorer lineage and storage graph, Traces
  // service map, trace detail Trace Graph). It owns the view transform (pan,
  // zoom, fit into the area the chrome leaves free, one wheel factor
  // and zoom range), the DPR-correct canvas and its rAF-coalesced redraws, the
  // dot-grid background, card / halo / edge / label drawing, the orthogonal
  // edge router and the layered layout it routes, collision-free edge labels,
  // the minimap, keyboard access (focusable canvas, arrows between nodes,
  // Enter, + - 0, Escape, a live region naming the focused node), touch pan
  // and pinch zoom, and the DOM helpers of the shared chrome (foldable
  // legend, side-panel shell). The canvas is the only view of every graph,
  // on phones too. Colours come from the --graph-* tokens of
  // css/00-tokens.css, never from literals.
  const ns = window.ChDash;
  if (!ns) return;
  const { $ } = ns.dom;
  const { h } = ns;

  // The canvas font: the --font-sans stack of 00-tokens.css, which a canvas cannot read as var()
  // (tests/harness/test_type_scale_contract.py keeps the two equal). Canvas weights are 400 / 500 /
  // 600, the faces the page ships.
  const FONT = '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  // Card corners: --r-lg.
  const CARD_RADIUS = 8;
  const ZOOM_STEP = 1.22;
  const WHEEL_SPEED = 0.0012;
  const MAX_SCALE = 3.2;
  const MIN_SCALE = 0.02;
  const GRID_SPACING = 22;
  const MOBILE_QUERY = "(max-width: 720px)";

  // ------------------------------------------------------------------ theme

  // Canvas colours are resolved from CSS custom properties. getComputedStyle()
  // per node / edge made every frame pay hundreds of style lookups, so values
  // are cached until the theme can have changed: any attribute change on the
  // root element (data-theme, class) or an OS colour-scheme switch.
  const themeCache = { colors: new Map(), light: null, signature: "" };
  const themeListeners = new Set();
  const colorSchemeQuery = window.matchMedia?.("(prefers-color-scheme: light)") || null;

  function invalidateTheme() {
    themeCache.colors.clear();
    themeCache.light = null;
    gridPatternCache.key = "";
  }

  function themeChanged() {
    invalidateTheme();
    const signature = `${document.documentElement?.dataset?.theme || ""}\u0000${isLight() ? 1 : 0}`;
    if (signature === themeCache.signature) return;
    themeCache.signature = signature;
    for (const listener of themeListeners) {
      try { listener(); } catch (error) { console.error(error); }
    }
  }

  colorSchemeQuery?.addEventListener?.("change", themeChanged);
  // Text measured before a web font arrived used the fallback face: drop the cached truncations
  // and redraw every view, as a theme change does.
  // A view that measured text for its layout or its fit (card widths, the legend's box) measures
  // again through fonts.onLoad.
  const fontListeners = new Set();
  document.fonts?.addEventListener?.("loadingdone", () => {
    ellipsisCache.clear();
    for (const listener of [...themeListeners, ...fontListeners]) {
      try { listener(); } catch (error) { console.error(error); }
    }
  });
  if (typeof MutationObserver === "function" && document.documentElement) {
    new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true });
  }

  function cssVar(name) {
    let value = themeCache.colors.get(name);
    if (value === undefined) {
      value = typeof getComputedStyle === "function" && document.documentElement
        ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
        : "";
      themeCache.colors.set(name, value);
    }
    return value;
  }

  function isLight() {
    if (themeCache.light !== null) return themeCache.light;
    const explicit = String(document.documentElement?.dataset?.theme || "");
    let light;
    if (explicit === "light") light = true;
    else if (explicit === "dark") light = false;
    else light = !!colorSchemeQuery?.matches;
    themeCache.light = light;
    return light;
  }

  // Roles read by the renderers; the tokens are defined for both themes in
  // the --graph-* tokens of css/00-tokens.css.
  const ROLE_TOKENS = {
    bg: "--graph-bg",
    grid: "--graph-grid",
    text: "--graph-text",
    muted: "--graph-muted",
    accentText: "--graph-accent-text",
    halo: "--graph-halo",
    edge: "--graph-edge",
    edgeMuted: "--graph-edge-muted",
    border: "--graph-node-border",
    nodeBg: "--graph-node-bg",
    disabledBg: "--graph-disabled-bg",
    groupBg: "--graph-group-bg",
    bandBg: "--graph-band-bg",
    labelBg: "--graph-label-bg",
    warn: "--graph-warn",
    error: "--graph-error",
    minimapBg: "--graph-minimap-bg",
    minimapView: "--graph-minimap-view",
    minimapViewFill: "--graph-minimap-view-fill",
  };

  function color(role) {
    return cssVar(ROLE_TOKENS[role] || ROLE_TOKENS.text);
  }

  // A CSS var() reference to a custom property (the Traces service colours),
  // resolved for canvas.
  function resolveColor(value) {
    const text = String(value || "");
    const match = /^var\((--[A-Za-z0-9_-]+)\)$/.exec(text);
    return match ? cssVar(match[1]) : text;
  }

  // Any CSS colour as [r, g, b, a] (0..255, alpha 0..1): a 1x1 canvas
  // normalises the syntax ("#abc", "rgba(...)", names) to "#rrggbb" or
  // "rgba(r, g, b, a)". Cached per text.
  const parsedColors = new Map();
  let colorProbe = null;
  function parseColor(value) {
    const text = String(value || "").trim();
    let rgba = parsedColors.get(text);
    if (rgba) return rgba;
    if (!colorProbe && typeof document.createElement === "function") colorProbe = document.createElement("canvas").getContext?.("2d") || null;
    let normal = text;
    if (colorProbe) {
      colorProbe.fillStyle = "#000000";
      colorProbe.fillStyle = text;
      normal = String(colorProbe.fillStyle);
    }
    const hex = /^#([0-9a-f]{6})$/i.exec(normal);
    if (hex) {
      const n = parseInt(hex[1], 16);
      rgba = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    } else {
      const parts = (normal.match(/[\d.]+/g) || []).map(Number);
      rgba = parts.length >= 3 ? [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1] : [0, 0, 0, 1];
    }
    if (parsedColors.size > 500) parsedColors.clear();
    parsedColors.set(text, rgba);
    return rgba;
  }

  // Canvas twin of color-mix(in srgb, b t, a): `t` of colour `b` over `a`.
  function mixColor(a, b, t) {
    const x = parseColor(a);
    const y = parseColor(b);
    const k = Math.max(0, Math.min(1, Number(t) || 0));
    const channel = (i) => Math.round(x[i] + (y[i] - x[i]) * k);
    return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
  }

  // Alpha of objects outside the focused neighbourhood: faint but legible.
  function dimAlpha() {
    return isLight() ? 0.34 : 0.26;
  }

  // Media queries are created once: matchMedia() per call (per edge and per
  // frame for the reduced-motion check) showed up in frame profiles.
  const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
  const mobileQuery = window.matchMedia?.(MOBILE_QUERY) || null;

  function reducedMotion() {
    return !!reducedMotionQuery?.matches;
  }

  function mobileLayout() {
    return !!mobileQuery?.matches;
  }

  // ----------------------------------------------------------------- canvas

  function canvasSize(canvas) {
    if (!canvas) return { width: 0, height: 0, dpr: 1 };
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width: rect.width, height: rect.height, dpr };
  }

  function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, width, height, radius);
    else ctx.rect(x, y, width, height);
  }

  // Truncated texts per font, text and width: cards redraw on every hover and
  // pan frame, and the binary search measures the text up to log2(n) times.
  // Callers that set the font pass it (reading ctx.font back serializes it).
  const ellipsisCache = new Map();
  function ellipsis(ctx, value, maxWidth, font = ctx.font) {
    const text = String(value || "");
    if (!text) return text;
    let byText = ellipsisCache.get(font);
    if (!byText) { byText = new Map(); ellipsisCache.set(font, byText); }
    const cached = byText.get(text);
    if (cached && cached.width === maxWidth) return cached.result;
    let result = text;
    if (ctx.measureText(text).width > maxWidth) {
      let low = 0;
      let high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (ctx.measureText(`${text.slice(0, mid)}\u2026`).width <= maxWidth) low = mid;
        else high = mid - 1;
      }
      result = `${text.slice(0, low)}\u2026`;
    }
    if (byText.size > 6000) byText.clear();
    byText.set(text, { width: maxWidth, result });
    return result;
  }

  // The dot grid of the graph background: one dot per GRID_SPACING CSS pixels,
  // a pattern tile in device pixels moved with the pan offset.
  const gridPatternCache = { key: "", pattern: null };
  function gridPattern(ctx, dpr) {
    const key = `${dpr}\u0000${color("grid")}`;
    if (gridPatternCache.key === key) return gridPatternCache.pattern;
    gridPatternCache.key = key;
    gridPatternCache.pattern = null;
    if (typeof document.createElement !== "function") return null;
    const tile = document.createElement("canvas");
    const size = Math.round(GRID_SPACING * dpr);
    tile.width = size;
    tile.height = size;
    const tileCtx = tile.getContext?.("2d");
    if (!tileCtx || typeof ctx.createPattern !== "function") return null;
    tileCtx.fillStyle = color("grid");
    tileCtx.beginPath();
    tileCtx.arc(size / 2, size / 2, Math.max(1, dpr), 0, Math.PI * 2);
    tileCtx.fill();
    gridPatternCache.pattern = ctx.createPattern(tile, "repeat");
    return gridPatternCache.pattern;
  }

  function drawBackground(ctx, view, width, height, dpr) {
    ctx.fillStyle = color("bg");
    ctx.fillRect(0, 0, width, height);
    const pattern = gridPattern(ctx, dpr);
    if (!pattern) return;
    const shift = (value) => ((value % GRID_SPACING) + GRID_SPACING) % GRID_SPACING - GRID_SPACING / 2;
    if (typeof pattern.setTransform === "function" && typeof DOMMatrix === "function") {
      pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, shift(view.offsetX || 0), shift(view.offsetY || 0)]));
    }
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
  }

  // ------------------------------------------------------------------ cards

  const fontCache = new Map();
  function fontOf(weight, size) {
    const key = weight * 1000 + size;
    let font = fontCache.get(key);
    if (!font) { font = `${weight} ${size}px ${FONT}`; fontCache.set(key, font); }
    return font;
  }

  // One card: rounded rectangle, optional left colour strip, status dot and
  // right-aligned badge on the title row, then text rows at fixed offsets.
  //   card = { radius, fill, border, borderWidth, dashed, alpha, focused,
  //            strip, status: "warn" | "error", statusAlpha, badge,
  //            badgeSize, badgeY, statusY, rows: [{ text, size, weight, color, y, fit }] }
  // A focused card has a 2 px --graph-halo (accent) border and no ring around it.
  // The first row is the title: it stops before the status dot and badge.
  function drawCard(ctx, item, card) {
    const radius = card.radius ?? CARD_RADIUS;
    ctx.save();
    if (card.alpha != null) ctx.globalAlpha = card.alpha;
    roundRect(ctx, item.x, item.y, item.width, item.height, radius);
    ctx.fillStyle = card.fill || color("nodeBg");
    ctx.fill();
    if (card.strip) {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = card.strip;
      ctx.fillRect(item.x, item.y, 5, item.height);
      ctx.restore();
      roundRect(ctx, item.x, item.y, item.width, item.height, radius);
    }
    ctx.strokeStyle = card.focused ? color("halo") : card.border || color("border");
    ctx.lineWidth = card.focused ? 2 : card.borderWidth ?? 1.2;
    if (card.dashed) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    const pad = card.pad ?? (card.strip ? 15 : 12);
    let rightEdge = item.x + item.width - 12;
    if (card.status) {
      ctx.save();
      ctx.globalAlpha *= card.statusAlpha ?? 1;
      ctx.fillStyle = card.status === "error" ? color("error") : color("warn");
      ctx.beginPath();
      ctx.arc(rightEdge - 4, item.y + (card.statusY ?? 17), 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      rightEdge -= 14;
    }
    if (card.badge) {
      ctx.font = fontOf(600, card.badgeSize || 12);
      ctx.fillStyle = color("muted");
      ctx.textAlign = "right";
      ctx.fillText(card.badge, rightEdge, item.y + (card.badgeY ?? 22));
      ctx.textAlign = "left";
      rightEdge -= ctx.measureText(card.badge).width + 8;
    }
    const rows = card.rows || [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (!row || !row.text) continue;
      ctx.fillStyle = row.color || (index === 0 ? color("text") : color("muted"));
      const font = fontOf(row.weight || (index === 0 ? 600 : 400), row.size || 12);
      ctx.font = font;
      const limit = index === 0 && row.fit !== "full" ? rightEdge - item.x - pad : item.width - pad - 12;
      ctx.fillText(ellipsis(ctx, row.text, limit, font), item.x + pad, item.y + row.y);
    }
    ctx.restore();
  }

  // A compact card keeps only its title, drawn larger so it stays legible
  // while zooming out (8 px on screen at FIT_FLOOR, the smallest scale a Fit
  // opens at); below that, cards are plain blocks.
  function compactTitleSize(scale) {
    const value = Math.max(0.01, Number(scale) || 1);
    const size = Math.min(32, Math.max(14, 12 / value));
    return size * value >= 8 - 1e-9 ? size : 0;
  }

  // Level of detail, from what the card is on screen, not from the zoom: a
  // card draws all its rows while it is at least COMPACT_CARD_PX tall on
  // screen and its smallest text (minFont, world px) at least MIN_TEXT_PX;
  // below either it is compact. A graph decides once per frame, from the
  // height of its ordinary card, so every card shows the same detail.
  const COMPACT_CARD_PX = 40;
  const MIN_TEXT_PX = 7.5;
  function isCompact(cardHeight, scale, minFont = 12) {
    const value = Number(scale) || 0;
    return cardHeight * value < COMPACT_CARD_PX - 1e-6 || minFont * value < MIN_TEXT_PX - 1e-6;
  }

  // The box a compact card draws in: the card shrunk to the height of its
  // title row (7 px above and below it on screen), centred on its edge ports
  // so the edges still meet its sides, and never taller than the card. No
  // compact card is an empty frame around a title. Returns { x, y, width,
  // height, titleSize, baseline } (baseline: from the box's top).
  function compactBox(item, scale) {
    const value = Math.max(0.01, Number(scale) || 1);
    const titleSize = compactTitleSize(value);
    const height = Math.min(item.height, (titleSize || 12 / value) * 1.3 + 14 / value);
    const port = nodePort(item, "right").y;
    const y = Math.max(item.y, Math.min(item.y + item.height - height, port - height / 2));
    return { x: item.x, y, width: item.width, height, titleSize, baseline: height / 2 + titleSize * 0.36 };
  }

  // ------------------------------------------------------------------ edges

  // Dash patterns by edge kind (world units, scaled with the zoom).
  const DASH = {
    solid: [],
    dashed: [7, 7],
    message: [7, 5],
    dotted: [2, 4],
    dashdot: [2, 4, 7, 4],
    route: [3, 5],
    lifecycle: [6, 4],
    refresh: [12, 5, 2, 5],
  };

  function polylineMetric(points) {
    const segments = [];
    let total = 0;
    for (let i = 0; i + 1 < points.length; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      segments.push({ a, b, length, start: total });
      total += length;
    }
    return { segments, total: Math.max(total, 0.0001) };
  }

  // Point (and direction) at fraction t of a polyline's length.
  function routePoint(points, t) {
    const metric = polylineMetric(points);
    const distance = Math.max(0, Math.min(1, t)) * metric.total;
    let segment = metric.segments[metric.segments.length - 1];
    for (const candidate of metric.segments) {
      if (distance <= candidate.start + candidate.length) { segment = candidate; break; }
    }
    if (!segment) return { x: 0, y: 0, angle: 0 };
    const local = segment.length > 0 ? Math.max(0, Math.min(1, (distance - segment.start) / segment.length)) : 0;
    return {
      x: segment.a.x + (segment.b.x - segment.a.x) * local,
      y: segment.a.y + (segment.b.y - segment.a.y) * local,
      angle: Math.atan2(segment.b.y - segment.a.y, segment.b.x - segment.a.x),
    };
  }

  function tracePolyline(ctx, points) {
    if (!points.length) return;
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
  }

  function strokePolyline(ctx, points) {
    ctx.beginPath();
    tracePolyline(ctx, points);
    ctx.stroke();
  }

  // Filled arrow head at the end of a polyline, along its last segment.
  function drawArrowHead(ctx, points, size = 8) {
    if (!Array.isArray(points) || points.length < 2) return;
    const tip = points[points.length - 1];
    const near = routePoint(points, 0.985);
    const angle = near.angle;
    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y);
    ctx.lineTo(tip.x - size * Math.cos(angle - 0.5), tip.y - size * Math.sin(angle - 0.5));
    ctx.lineTo(tip.x - size * Math.cos(angle + 0.5), tip.y - size * Math.sin(angle + 0.5));
    ctx.closePath();
    ctx.fill();
  }

  function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function distanceToPolyline(point, points) {
    let best = Infinity;
    for (let i = 1; i < points.length; i += 1) best = Math.min(best, distanceToSegment(point, points[i - 1], points[i]));
    return best;
  }

  function pointInRect(point, rect, padding = 0) {
    return point.x >= rect.x - padding && point.x <= rect.x + rect.width + padding
      && point.y >= rect.y - padding && point.y <= rect.y + rect.height + padding;
  }

  function rectsOverlap(a, b, padding = 14) {
    return !(
      a.x + a.width + padding <= b.x ||
      b.x + b.width + padding <= a.x ||
      a.y + a.height + padding <= b.y ||
      b.y + b.height + padding <= a.y
    );
  }

  // --------------------------------------------------------- layered layout

  // Layered (Sugiyama-style) left-to-right layout: longest-path levels from
  // the sources, barycentre sweeps and adjacent transpositions against edge
  // crossings, then (rowGrid) one global row grid: a node can stay on the
  // exact row of its parent / child even when another column has a different
  // number of nodes, which keeps orthogonal routes straight.
  //   options = { nodes, edges, size(node) -> { width, height }, compare(a, b),
  //               queueCompare(a, b), weight(edge), rowGrid, rowPitch, xGap,
  //               yGap, minColumnWidth, origin, breakCycles }
  // Returns { positions: Map(id -> { x, y, width, height, node, lineageRow }),
  // level: Map(id -> column), backEdges: Set(edge id) }.
  const WASM_LAYERED_MIN_NODES = 24;
  let layeredAsked = false;
  function requestLayeredWasm() {
    if (layeredAsked || typeof WebAssembly !== "object" || !ns.loader) return;
    layeredAsked = true;
    ns.loader.loadGroup("wasm-layered").then(() => (ns.wasm && ns.wasm.ops.layered ? ns.wasm.load("layered") : null)).catch(() => {});
  }

  // { columns, levels, level, backEdges, lineageRows } like layeredOrderJs(), or null.
  function layeredOrderWasm(options) {
    if ((options.nodes || []).length < WASM_LAYERED_MIN_NODES) return null;
    const kernel = ns.wasm && ns.wasm.get("layered");
    if (!kernel || !ns.wasm.ops.layered || !ns.wasm.layered) {
      requestLayeredWasm();
      return null;
    }
    try {
      const input = ns.wasm.layered.pack(options);
      if (!input) return null;
      const result = ns.wasm.ops.layered.run(kernel, input);
      return result.status === 0 ? ns.wasm.layered.unpack(options, result) : null;
    } catch (error) {
      return null;
    }
  }

  function layered(options) {
    // The WebAssembly layout (src/wasm/layered.c) gives the order and the rows of the reference below, step for step; it hands
    // the run back (null) when it is not loaded or cannot take it.
    const order = layeredOrderWasm(options) || layeredOrderJs(options);
    return layeredPositions(options, order);
  }

  // The reference: the columns, their order and the rows, as plain JavaScript.
  function layeredOrderJs(options) {
    const nodes = options.nodes || [];
    const compare = options.compare || ((a, b) => String(a.id).localeCompare(String(b.id)));
    const queueCompare = options.queueCompare || compare;
    const weightOf = options.weight || (() => 1);
    const itemById = new Map(nodes.map((node) => [node.id, node]));
    const backEdges = options.breakCycles ? cycleBackEdges(nodes, options.edges || []) : new Set();
    const edges = backEdges.size ? (options.edges || []).filter((edge) => !backEdges.has(edge.id)) : (options.edges || []);
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const next = new Map(nodes.map((node) => [node.id, []]));

    for (const edge of edges) {
      if (!itemById.has(edge.from) || !itemById.has(edge.to) || edge.from === edge.to) continue;
      indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
      next.get(edge.from)?.push(edge.to);
    }

    const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).sort(queueCompare).map((node) => node.id);
    const level = new Map(nodes.map((node) => [node.id, 0]));
    const processed = new Set();
    for (let qi = 0; qi < queue.length; qi += 1) {
      const id = queue[qi];
      processed.add(id);
      const base = level.get(id) || 0;
      for (const target of next.get(id) || []) {
        level.set(target, Math.max(level.get(target) || 0, base + 1));
        indegree.set(target, (indegree.get(target) || 0) - 1);
        if ((indegree.get(target) || 0) === 0) queue.push(target);
      }
    }

    // Cycles are valid for some view/topology combinations. Keep them visible
    // by placing remaining nodes after their strongest known predecessor.
    for (const node of nodes) {
      if (processed.has(node.id)) continue;
      let best = 0;
      for (const edge of edges) {
        if (edge.to === node.id) best = Math.max(best, (level.get(edge.from) || 0) + 1);
      }
      level.set(node.id, best);
    }

    const columns = new Map();
    for (const node of nodes) {
      const l = level.get(node.id) || 0;
      if (!columns.has(l)) columns.set(l, []);
      columns.get(l).push(node);
    }
    for (const group of columns.values()) group.sort(compare);

    // Crossing minimization: perform a few Sugiyama-style barycentric sweeps
    // after topological layering. This keeps the deterministic layout while
    // placing nodes close to their connected neighbours instead of purely
    // alphabetically, which dramatically reduces crossing edges.
    const levels = [...columns.keys()].sort((a, b) => a - b);
    const predecessors = new Map(nodes.map((node) => [node.id, []]));
    const successors = new Map(nodes.map((node) => [node.id, []]));
    for (const edge of edges) {
      if (!itemById.has(edge.from) || !itemById.has(edge.to)) continue;
      predecessors.get(edge.to)?.push(edge.from);
      successors.get(edge.from)?.push(edge.to);
    }
    const orderForLevel = (levelNumber) => {
      const map = new Map();
      (columns.get(levelNumber) || []).forEach((node, index) => map.set(node.id, index));
      return map;
    };
    const barySort = (group, neighborIds, neighborOrder) => {
      const decorated = group.map((node, index) => {
        const values = (neighborIds.get(node.id) || []).map((id) => neighborOrder.get(id)).filter((value) => Number.isFinite(value));
        const bary = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
        return { node, index, bary };
      });
      decorated.sort((a, b) => {
        if (a.bary != null && b.bary != null && a.bary !== b.bary) return a.bary - b.bary;
        if (a.bary != null && b.bary == null) return -1;
        if (a.bary == null && b.bary != null) return 1;
        const stable = compare(a.node, b.node);
        return stable || a.index - b.index;
      });
      group.splice(0, group.length, ...decorated.map((item) => item.node));
    };
    for (let sweep = 0; sweep < 4; sweep += 1) {
      for (let i = 1; i < levels.length; i += 1) {
        barySort(columns.get(levels[i]) || [], predecessors, orderForLevel(levels[i - 1]));
      }
      for (let i = levels.length - 2; i >= 0; i -= 1) {
        barySort(columns.get(levels[i]) || [], successors, orderForLevel(levels[i + 1]));
      }
    }

    // Adjacent transposition after barycentric sweeps. Re-scoring every
    // crossing twice per adjacent swap is O(swaps x E^2) and froze the tab for
    // a minute on a 2k-node catalog. Swapping neighbours u,v of one layer only
    // flips the crossing state of edge pairs (u-edge, v-edge) that share the
    // same adjacent layer, so after - before is exactly
    //   #(p_u < p_v) - #(p_u > p_v)
    // over those pairs (p = far endpoint position).
    const swapLevelById = new Map();
    for (const [l, group] of columns.entries()) for (const node of group) swapLevelById.set(node.id, l);
    const swapPosById = new Map();
    for (const group of columns.values()) group.forEach((node, index) => swapPosById.set(node.id, index));
    const swapNeighbors = new Map();
    for (const edge of edges) {
      const fromLevel = swapLevelById.get(edge.from);
      const toLevel = swapLevelById.get(edge.to);
      if (!Number.isFinite(fromLevel) || !Number.isFinite(toLevel) || Math.abs(fromLevel - toLevel) !== 1) continue;
      if (!swapNeighbors.has(edge.from)) swapNeighbors.set(edge.from, []);
      if (!swapNeighbors.has(edge.to)) swapNeighbors.set(edge.to, []);
      swapNeighbors.get(edge.from).push({ id: edge.to, level: toLevel });
      swapNeighbors.get(edge.to).push({ id: edge.from, level: fromLevel });
    }
    const swapDelta = (leftId, rightId) => {
      const left = swapNeighbors.get(leftId);
      const right = swapNeighbors.get(rightId);
      if (!left || !right) return 0;
      let delta = 0;
      for (const a of left) {
        const pa = swapPosById.get(a.id);
        for (const b of right) {
          if (a.level !== b.level) continue;
          const pb = swapPosById.get(b.id);
          if (pa < pb) delta += 1;
          else if (pa > pb) delta -= 1;
        }
      }
      return delta;
    };
    for (let pass = 0; pass < 4; pass += 1) {
      let improved = false;
      for (const l of levels) {
        const group = columns.get(l) || [];
        for (let i = 0; i + 1 < group.length; i += 1) {
          if (swapDelta(group[i].id, group[i + 1].id) < 0) {
            improved = true;
            [group[i], group[i + 1]] = [group[i + 1], group[i]];
            swapPosById.set(group[i].id, i);
            swapPosById.set(group[i + 1].id, i + 1);
          }
        }
      }
      if (!improved) break;
    }

    const rowGrid = !!options.rowGrid;
    const lineageRows = new Map();
    if (rowGrid && levels.length) {
      const maxColumnSize = Math.max(1, ...levels.map((l) => (columns.get(l) || []).length));
      // One spare lane gives fan-in/fan-out branches room to remain separated
      // without making small graphs excessively tall.
      const rowCount = Math.max(1, maxColumnSize + (maxColumnSize >= 3 ? 1 : 0));
      for (const l of levels) {
        const group = columns.get(l) || [];
        if (!group.length) continue;
        group.forEach((node, index) => {
          const row = group.length === 1 ? Math.floor((rowCount - 1) / 2)
            : Math.round(index * (rowCount - 1) / Math.max(1, group.length - 1));
          lineageRows.set(node.id, row);
        });
      }

      const weightedIdeal = (nodeId) => {
        let weighted = 0;
        let total = 0;
        for (const edge of edges) {
          let other = null;
          if (edge.from === nodeId) other = edge.to;
          else if (edge.to === nodeId) other = edge.from;
          if (!other || !lineageRows.has(other)) continue;
          const weight = weightOf(edge);
          weighted += lineageRows.get(other) * weight;
          total += weight;
        }
        return total > 0 ? weighted / total : lineageRows.get(nodeId) ?? 0;
      };

      // Minimum-cost monotone assignment of a column to unique row slots. The
      // group order is preserved, so row optimization cannot re-introduce the
      // crossings already removed by the Sugiyama ordering pass.
      const assignRows = (group) => {
        const n = group.length;
        if (!n) return;
        const slots = Math.max(rowCount, n);
        const ideals = group.map((node) => weightedIdeal(node.id));
        const inf = 1e18;
        // Typed rows: a 2k-node column allocates n x slots cells per sweep.
        const dp = Array.from({ length: n }, () => new Float64Array(slots).fill(inf));
        const prev = Array.from({ length: n }, () => new Int32Array(slots).fill(-1));
        for (let row = 0; row < slots; row += 1) {
          if (slots - row < n) break;
          dp[0][row] = (row - ideals[0]) ** 2;
        }
        for (let i = 1; i < n; i += 1) {
          // Running prefix minimum of dp[i - 1][i - 1 .. row - 1]: a strict <
          // keeps the lowest predecessor on ties.
          let bestCost = inf;
          let bestPrev = -1;
          for (let row = i; row < slots; row += 1) {
            const pr = row - 1;
            if (dp[i - 1][pr] < bestCost) { bestCost = dp[i - 1][pr]; bestPrev = pr; }
            if (slots - row < n - i) continue;
            if (bestPrev < 0) continue;
            dp[i][row] = bestCost + (row - ideals[i]) ** 2;
            prev[i][row] = bestPrev;
          }
        }
        let endRow = 0;
        let endCost = inf;
        for (let row = n - 1; row < slots; row += 1) {
          if (dp[n - 1][row] < endCost) { endCost = dp[n - 1][row]; endRow = row; }
        }
        const assigned = Array(n).fill(0);
        for (let i = n - 1, row = endRow; i >= 0; i -= 1) {
          assigned[i] = row;
          row = i > 0 ? prev[i][row] : -1;
        }
        group.forEach((node, index) => lineageRows.set(node.id, assigned[index]));
      };

      for (let sweep = 0; sweep < 6; sweep += 1) {
        for (const l of levels) assignRows(columns.get(l) || []);
        for (let i = levels.length - 1; i >= 0; i -= 1) assignRows(columns.get(levels[i]) || []);
      }
    }

    return { columns, levels, level, backEdges, lineageRows };
  }

  // The cards of the columns, in the order the layout chose, as positions (x by the widest card of a column, y by the global
  // row grid or packed).
  function layeredPositions(options, { columns, levels, level, backEdges, lineageRows }) {
    const size = options.size;
    const xGap = options.xGap ?? 92;
    const yGap = options.yGap ?? 34;
    const origin = options.origin ?? 70;
    const minColumnWidth = options.minColumnWidth ?? 0;
    const positions = new Map();
    const rowGrid = !!options.rowGrid;
    const lineageRowPitch = rowGrid ? options.rowPitch : null;
    let x = origin;
    for (const l of levels) {
      const group = columns.get(l) || [];
      let maxWidth = minColumnWidth;
      for (let row = 0; row < group.length; row += 1) {
        const node = group[row];
        const box = size(node);
        maxWidth = Math.max(maxWidth, box.width);
        const gridRow = rowGrid ? (lineageRows.get(node.id) ?? row) : row;
        const y = rowGrid ? origin + gridRow * lineageRowPitch : (() => {
          let packed = origin;
          for (let i = 0; i < row; i += 1) packed += size(group[i]).height + yGap;
          return packed;
        })();
        positions.set(node.id, { x, y, width: box.width, height: box.height, node, lineageRow: gridRow });
      }
      x += maxWidth + xGap;
    }
    return { positions, level, backEdges };
  }

  // Back edges of an iterative DFS from the sources (input order): removing
  // them leaves a DAG whose longest paths give the columns.
  function cycleBackEdges(nodes, edges) {
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const out = nodes.map(() => []);
    const hasIn = new Uint8Array(nodes.length);
    for (const edge of edges) {
      const s = index.get(edge.from);
      const t = index.get(edge.to);
      if (s == null || t == null || s === t) continue;
      out[s].push({ t, id: edge.id });
      hasIn[t] = 1;
    }
    const state = new Uint8Array(nodes.length);
    const back = new Set();
    const visit = (root) => {
      const stack = [[root, 0]];
      state[root] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [v, at] = top;
        if (at < out[v].length) {
          top[1] += 1;
          const { t, id } = out[v][at];
          if (state[t] === 1) { back.add(id); continue; }
          if (state[t] === 0) { state[t] = 1; stack.push([t, 0]); }
        } else {
          state[v] = 2;
          stack.pop();
        }
      }
    };
    for (let i = 0; i < nodes.length; i += 1) if (!hasIn[i] && !state[i]) visit(i);
    for (let i = 0; i < nodes.length; i += 1) if (!state[i]) visit(i);
    return back;
  }

  // ------------------------------------------------------ orthogonal router

  // Every node exposes one output port (right edge, at a stable offset from
  // the top of the card) and one input port (left edge, same offset). Using a
  // top-based anchor keeps sibling rows literally horizontal when the cards
  // share a row. A very small fan zone is allowed immediately outside those
  // ports because several orthogonal edges cannot leave one point without
  // sharing a few pixels. After that fan zone, every route owns its lane:
  // overlaps are forbidden and crossings are expensive.
  const LINEAGE_NODE_PORT_TOP_OFFSET = 36;
  // Every route owns its lane: two parallel segments of two routes closer
  // than LANE_GAP (and side by side over more than half a pixel) read as one
  // doubled line, or with the dashes as a closed frame, so the router pays
  // NEAR_BASE + NEAR_PER_PX per pixel they run along each other: more than a
  // couple of crossings, far less than an overlap. Fans step by LANE_GAP.
  const LANE_GAP = 12;
  const NEAR_BASE = 30_000;
  const NEAR_PER_PX = 200;
  // A crossing in the middle of two routes (not at a fan).
  const CROSSING_COST = 28_000;
  const ROUTE_GRID_POINT_BUDGET = 40000;

  function nodePort(item, side = "right") {
    const y = item.y + Math.min(Math.max(18, LINEAGE_NODE_PORT_TOP_OFFSET), Math.max(18, item.height - 18));
    return { x: side === "left" ? item.x : item.x + item.width, y };
  }

  function pointInsideItem(point, item, padding = 8) {
    return point.x > item.x - padding && point.x < item.x + item.width + padding
      && point.y > item.y - padding && point.y < item.y + item.height + padding;
  }

  function segmentHitsItem(a, b, item, padding = 12) {
    const left = item.x - padding;
    const right = item.x + item.width + padding;
    const top = item.y - padding;
    const bottom = item.y + item.height + padding;
    if (Math.abs(a.x - b.x) < 0.001) {
      if (a.x <= left || a.x >= right) return false;
      const lo = Math.min(a.y, b.y);
      const hi = Math.max(a.y, b.y);
      return hi > top && lo < bottom;
    }
    if (Math.abs(a.y - b.y) < 0.001) {
      if (a.y <= top || a.y >= bottom) return false;
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      return hi > left && lo < right;
    }
    return false;
  }

  function compressOrthogonalRoute(points) {
    if (!Array.isArray(points) || points.length <= 2) return points || [];
    const out = [points[0]];
    for (let i = 1; i + 1 < points.length; i += 1) {
      const a = out[out.length - 1];
      const b = points[i];
      const c = points[i + 1];
      const vertical = Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - c.x) < 0.001;
      const horizontal = Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - c.y) < 0.001;
      if (!vertical && !horizontal) out.push(b);
    }
    out.push(points[points.length - 1]);
    return out;
  }

  function orthogonalSegmentConflict(a, b, c, d) {
    const aVertical = Math.abs(a.x - b.x) < 0.001;
    const cVertical = Math.abs(c.x - d.x) < 0.001;
    const between = (value, x, y, strict = false) => strict
      ? value > Math.min(x, y) + 0.001 && value < Math.max(x, y) - 0.001
      : value >= Math.min(x, y) - 0.001 && value <= Math.max(x, y) + 0.001;

    if (aVertical !== cVertical) {
      const verticalA = aVertical ? a : c;
      const verticalB = aVertical ? b : d;
      const horizontalA = aVertical ? c : a;
      const horizontalB = aVertical ? d : b;
      const x = verticalA.x;
      const y = horizontalA.y;
      // Crossings at a route endpoint are normal fan-in/fan-out, not a visual
      // crossing in the middle of the graph.
      if (between(x, horizontalA.x, horizontalB.x, true) && between(y, verticalA.y, verticalB.y, true)) {
        return { crossings: 1, overlap: 0 };
      }
      return { crossings: 0, overlap: 0 };
    }

    // Parallel: the length they share along their axis is an overlap on the
    // same line, a near run (`near`) on a line closer than LANE_GAP.
    const gap = aVertical ? Math.abs(a.x - c.x) : Math.abs(a.y - c.y);
    if (gap >= LANE_GAP - 0.001) return { crossings: 0, overlap: 0 };
    const shared = aVertical
      ? Math.max(0, Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)))
      : Math.max(0, Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)));
    return gap > 0.001 ? { crossings: 0, overlap: 0, near: shared } : { crossings: 0, overlap: shared };
  }

  function routeSegmentMeta(points, edge) {
    const segments = [];
    const count = Math.max(0, points.length - 1);
    for (let i = 0; i < count; i += 1) {
      segments.push({
        a: points[i],
        b: points[i + 1],
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        index: i,
        count,
        // Only the first/last segment belongs to the unavoidable shared port
        // fan, so long pieces of unrelated routes can never lie on top of
        // each other.
        sourceFan: i === 0,
        targetFan: i === count - 1,
      });
    }
    return segments;
  }

  // Scratch arrays of the indexed router grid, reused across edges (a grid
  // has at most ROUTE_GRID_POINT_BUDGET points) and reset over the used part.
  const gridScratch = { size: 0 };
  function gridBuffers(total) {
    if (gridScratch.size < total) {
      const size = Math.max(total, Math.min(ROUTE_GRID_POINT_BUDGET, gridScratch.size * 2));
      gridScratch.size = size;
      gridScratch.blocked = new Uint8Array(size);
      gridScratch.left = new Int32Array(size);
      gridScratch.right = new Int32Array(size);
      gridScratch.up = new Int32Array(size);
      gridScratch.down = new Int32Array(size);
      gridScratch.best = new Float64Array(size * 3);
      gridScratch.previous = new Int32Array(size * 3);
      gridScratch.conflict = new Float64Array(size * 4);
    }
    gridScratch.blocked.fill(0, 0, total);
    gridScratch.left.fill(-1, 0, total);
    gridScratch.right.fill(-1, 0, total);
    gridScratch.up.fill(-1, 0, total);
    gridScratch.down.fill(-1, 0, total);
    gridScratch.best.fill(Infinity, 0, total * 3);
    gridScratch.previous.fill(-1, 0, total * 3);
    gridScratch.conflict.fill(NaN, 0, total * 4);
    return gridScratch;
  }

  function routeBendCount(points) {
    let bends = 0;
    for (let i = 1; i + 1 < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const c = points[i + 1];
      const firstVertical = Math.abs(a.x - b.x) < 0.001;
      const secondVertical = Math.abs(b.x - c.x) < 0.001;
      if (firstVertical !== secondVertical) bends += 1;
    }
    return bends;
  }

  // Spatial index of routed segments for the conflict scoring of
  // orthogonalSegmentConflict(): a step can only overlap a parallel segment
  // on its own line (the x of a vertical segment, the y of any other, within
  // 0.001) and only cross a perpendicular one strictly inside both. Segments
  // are kept per line (the coordinate rounded to 0.01) and, along it, per
  // cell of SEGMENT_CELL px; each cell also lists the segments covering it
  // sorted by line. near(a, b) reads the parallel lines within LANE_GAP of
  // the step's own (near runs) over the cells it covers, and the
  // perpendicular lines strictly inside the step at the step's cell (one
  // binary search in that cell's list, not a lookup per line: a long cheap
  // route crosses hundreds of lines), keeping the parallel segments that
  // share more than a quarter pixel of the step and the perpendicular ones
  // reaching past its line on both sides. It returns a superset of the
  // segments with a non-zero conflict, in their original order, so a sum
  // over it adds the same non-zero terms in the same order as over every
  // segment (a y-band index made a dense 12-service map examine thousands
  // of segments per A* step). penalty(ax, ay, bx, by, edge, term) is that
  // sum of term(ax, ay, bx, by, segment, edge) without building the list:
  // its non-zero terms (most steps have none, few more than two) are put in
  // segment order before they are added, so it equals the sum over near()
  // to the last bit.
  // { dynamic: true }: segments may be appended to `segments` later; sync()
  // indexes the new ones.
  const SEGMENT_CELL = 48;
  function createSegmentIndex(segments, { dynamic = false, nearRuns = true } = {}) {
    if (!dynamic && segments.length <= 24) {
      return {
        near: () => segments,
        sync() {},
        penalty(ax, ay, bx, by, edge, term) {
          let sum = 0;
          for (let i = 0; i < segments.length; i += 1) {
            const value = term(ax, ay, bx, by, segments[i], edge);
            if (value !== 0) sum += value;
          }
          return sum;
        },
      };
    }
    // The parallel lines a query reads: those within LANE_GAP (near runs),
    // or only its own (nearRuns false: the overlaps alone).
    const lanes = nearRuns ? LANE_GAP : 0.0011;
    const lineKey = (value) => Math.round(value * 100);
    const cellOf = (value) => Math.floor(value / SEGMENT_CELL);
    // Side 0: vertical segments by x; side 1: the others by a.y (as
    // orthogonalSegmentConflict() reads them). lineKeys[side]: the sorted
    // keys of the lines; lines[side]: their lines in the same order, each a
    // Map(cell -> indexes) plus .all (every index of the line, scanned
    // instead of the cells while the line holds few segments).
    // across[side]: Map(cell -> { keys, indexes }), the segments of that side
    // covering the cell, sorted by line key: the perpendicular reads.
    const lines = [[], []];
    const lineKeys = [[], []];
    const across = [new Map(), new Map()];
    const firstKeyAtLeast = (keys, value) => {
      let lo = 0;
      let hi = keys.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (keys[mid] < value) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    let indexed = 0;
    // Per segment: its extent along its line (spanLo, spanHi), a query stamp
    // (no segment twice in one answer), and the term penalty() found for it;
    // found[0, count): a query's answer (each segment at most once).
    let capacity = Math.max(16, segments.length);
    let found = new Int32Array(capacity);
    let count = 0;
    let stamp = new Int32Array(capacity);
    let spanLo = new Float64Array(capacity);
    let spanHi = new Float64Array(capacity);
    let lineAt = new Float64Array(capacity);
    let termOf = new Float64Array(capacity);
    let hits = new Int32Array(capacity);
    // The lines within `lanes` of the last query of each side (A* steps
    // come in pairs on one line): [first, last] positions in lineKeys.
    const lastAlong = [NaN, NaN];
    const lastRange = [[0, -1], [0, -1]];
    const sync = () => {
      if (capacity < segments.length) {
        capacity = segments.length * 2;
        const grow = (old, Type) => { const next = new Type(capacity); next.set(old); return next; };
        found = new Int32Array(capacity);
        stamp = grow(stamp, Int32Array);
        spanLo = grow(spanLo, Float64Array);
        spanHi = grow(spanHi, Float64Array);
        lineAt = grow(lineAt, Float64Array);
        termOf = new Float64Array(capacity);
        hits = new Int32Array(capacity);
      }
      if (indexed < segments.length) lastAlong[0] = lastAlong[1] = NaN;
      for (; indexed < segments.length; indexed += 1) {
        const { a, b } = segments[indexed];
        const vertical = Math.abs(a.x - b.x) < 0.001;
        const side = vertical ? 0 : 1;
        const key = lineKey(vertical ? a.x : a.y);
        const lo = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
        const hi = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
        spanLo[indexed] = lo;
        spanHi[indexed] = hi;
        lineAt[indexed] = vertical ? a.x : a.y;
        const keys = lineKeys[side];
        let position = firstKeyAtLeast(keys, key);
        let cells = keys[position] === key ? lines[side][position] : null;
        if (!cells) {
          cells = new Map();
          cells.all = [];
          keys.splice(position, 0, key);
          lines[side].splice(position, 0, cells);
        }
        cells.all.push(indexed);
        for (let cell = cellOf(lo - 0.01), last = cellOf(hi + 0.01); cell <= last; cell += 1) {
          const list = cells.get(cell);
          if (list) list.push(indexed); else cells.set(cell, [indexed]);
          let crossing = across[side].get(cell);
          if (!crossing) {
            crossing = { keys: [], indexes: [] };
            across[side].set(cell, crossing);
          }
          position = firstKeyAtLeast(crossing.keys, key + 1);
          crossing.keys.splice(position, 0, key);
          crossing.indexes.splice(position, 0, indexed);
        }
      }
    };
    sync();
    let query = 0;
    // A parallel segment conflicts only where it shares more than 0.5 px of
    // the step's extent [lo, hi]; the bounds leave a margin. found[0, split):
    // the parallel segments, found[split, count) the perpendicular ones.
    let lo = 0;
    let hi = 0;
    let along = 0;
    let split = 0;
    // found[split, count) are all crossings (a cached line), not candidates.
    let crossings = false;
    const collect = (list) => {
      if (!list) return;
      for (let i = 0; i < list.length; i += 1) {
        const index = list[i];
        if (stamp[index] === query) continue;
        stamp[index] = query;
        if (spanHi[index] > lo + 0.25 && spanLo[index] < hi - 0.25) found[count++] = index;
      }
    };
    // A static index answers the steps of one query line (the caller's
    // `line` number: an A* grid row or column, many steps each) from what it
    // keeps of that line at its first query: the segments of the lines
    // within `lanes` (while they are at most LINE_CACHE_SEGMENTS) by start,
    // and those of the other side whose extent strictly contains the line
    // (by more than 0.001, as the crossing test) by their own line: a step
    // crosses exactly those whose line is strictly inside it.
    const LINE_CACHE_SEGMENTS = 32;
    const lineCache = dynamic ? null : [];
    const cacheLine = (side, along) => {
      const keys = lineKeys[side];
      const lastKey = lineKey(along + lanes);
      const parallel = [];
      for (let k = firstKeyAtLeast(keys, lineKey(along - lanes)); k < keys.length && keys[k] <= lastKey && parallel.length <= LINE_CACHE_SEGMENTS; k += 1) {
        const all = lines[side][k].all;
        for (let i = 0; i < all.length; i += 1) parallel.push(all[i]);
      }
      const cross = [];
      const crossing = across[1 - side].get(cellOf(along));
      if (crossing) {
        for (let i = 0; i < crossing.indexes.length; i += 1) {
          const index = crossing.indexes[i];
          if (along > spanLo[index] + 0.001 && along < spanHi[index] - 0.001) cross.push(index);
        }
        if (cross.length > 1) cross.sort((x, y) => lineAt[x] - lineAt[y] || x - y);
      }
      const crossAt = [];
      for (let i = 0; i < cross.length; i += 1) crossAt.push(lineAt[cross[i]]);
      if (parallel.length > LINE_CACHE_SEGMENTS) return { parallel: null, crossAt, crossIndexes: cross };
      // By start along the line: the scan of a step stops at the first one
      // starting past it.
      if (parallel.length > 1) parallel.sort((x, y) => spanLo[x] - spanLo[y] || x - y);
      const starts = [];
      const ends = [];
      for (let i = 0; i < parallel.length; i += 1) {
        starts.push(spanLo[parallel[i]]);
        ends.push(spanHi[parallel[i]]);
      }
      return { parallel, starts, ends, crossAt, crossIndexes: cross };
    };
    // The indexes near() returns, unsorted, into `found`.
    const gather = (ax, ay, bx, by, line = -1) => {
      query += 1;
      count = 0;
      const vertical = Math.abs(ax - bx) < 0.001;
      const side = vertical ? 0 : 1;
      along = vertical ? ax : ay;
      lo = vertical ? Math.min(ay, by) : Math.min(ax, bx);
      hi = vertical ? Math.max(ay, by) : Math.max(ax, bx);
      let cached = null;
      if (lineCache && line >= 0) {
        cached = lineCache[line];
        if (cached === undefined) cached = lineCache[line] = cacheLine(side, along);
      }
      if (cached && cached.parallel) {
        // The lines' segments, each once.
        const { parallel, starts, ends } = cached;
        const before = hi - 0.25;
        const after = lo + 0.25;
        for (let i = 0; i < parallel.length && starts[i] < before; i += 1) {
          if (ends[i] > after) found[count++] = parallel[i];
        }
      } else {
        parallelLines(side, along);
      }
      split = count;
      crossings = cached !== null;
      if (hi - lo > 0.002) {
        if (cached) {
          // The crossings: the lines strictly inside (lo, hi), by 0.001.
          const { crossAt, crossIndexes } = cached;
          const from = lo + 0.001;
          const to = hi - 0.001;
          let first = 0;
          let last = crossAt.length;
          while (first < last) {
            const mid = (first + last) >> 1;
            if (crossAt[mid] <= from) first = mid + 1;
            else last = mid;
          }
          for (let i = first; i < crossAt.length && crossAt[i] < to; i += 1) found[count++] = crossIndexes[i];
        } else {
          perpendicularLines(side, along);
        }
      }
    };
    const parallelLines = (side, along) => {
      // Parallel segments on the step's line and the lines closer than
      // LANE_GAP (near runs).
      const keys = lineKeys[side];
      const range = lastRange[side];
      if (along !== lastAlong[side]) {
        lastAlong[side] = along;
        const lastKey = lineKey(along + lanes);
        let k = firstKeyAtLeast(keys, lineKey(along - lanes));
        range[0] = k;
        while (k < keys.length && keys[k] <= lastKey) k += 1;
        range[1] = k - 1;
      }
      const first = cellOf(lo - 0.01);
      const last = cellOf(hi + 0.01);
      const sameLines = lines[side];
      for (let k = range[0]; k <= range[1]; k += 1) {
        const cells = sameLines[k];
        if (cells.all.length <= 8 || last - first >= cells.all.length) collect(cells.all);
        else for (let cell = first; cell <= last; cell += 1) collect(cells.get(cell));
      }
    };
    // Perpendicular lines strictly inside the step, at its cell: a slice of
    // the cell's list, the segments reaching past the step's line on both
    // sides (a crossing is strictly inside both).
    const perpendicularLines = (side, along) => {
      const crossing = across[1 - side].get(cellOf(along));
      if (!crossing) return;
      const { keys, indexes } = crossing;
      const lastKey = lineKey(hi - 0.0009);
      for (let i = firstKeyAtLeast(keys, lineKey(lo + 0.0009)); i < keys.length && keys[i] <= lastKey; i += 1) {
        const index = indexes[i];
        if (spanLo[index] < along - 0.0005 && spanHi[index] > along + 0.0005) found[count++] = index;
      }
    };
    return {
      sync,
      near(a, b) {
        gather(a.x, a.y, b.x, b.y);
        const order = found.slice(0, count).sort();
        const out = new Array(count);
        for (let i = 0; i < count; i += 1) out[i] = segments[order[i]];
        return out;
      },
      // The term of a perpendicular segment is segmentConflictTerm()'s
      // crossing test, made here on the indexed extents: CROSSING_COST when
      // each is strictly inside the other (the other line within the step,
      // the step's line within the segment). Integral terms (crossings) add
      // up exactly in any order: their sum is returned as it is.
      // `limit` (cheap routes): once the terms found so far exceed it
      // clearly, their partial sum is returned instead (the caller only
      // learns that the step costs more than it can afford).
      penalty(ax, ay, bx, by, edge, term, limit = Infinity, line = -1) {
        gather(ax, ay, bx, by, line);
        const stop = limit + Math.abs(limit) * 1e-9 + 1;
        let terms = 0;
        let partial = 0;
        let integral = true;
        for (let i = 0; i < split; i += 1) {
          const index = found[i];
          const value = term(ax, ay, bx, by, segments[index], edge);
          if (value === 0) continue;
          termOf[index] = value;
          hits[terms] = index;
          terms += 1;
          partial += value;
          if (partial > stop) return partial;
          if (integral && !Number.isInteger(value)) integral = false;
        }
        for (let i = split; i < count; i += 1) {
          const index = found[i];
          const other = lineAt[index];
          if (!crossings && !(other > lo + 0.001 && other < hi - 0.001 && along > spanLo[index] + 0.001 && along < spanHi[index] - 0.001)) continue;
          termOf[index] = CROSSING_COST;
          hits[terms] = index;
          terms += 1;
          partial += CROSSING_COST;
          if (partial > stop) return partial;
        }
        if (integral && partial < 2 ** 53) return partial;
        if (terms > 16) hits.subarray(0, terms).sort();
        else {
          for (let i = 1; i < terms; i += 1) {
            const index = hits[i];
            let at = i;
            for (; at > 0 && hits[at - 1] > index; at -= 1) hits[at] = hits[at - 1];
            hits[at] = index;
          }
        }
        let sum = 0;
        for (let i = 0; i < terms; i += 1) sum += termOf[hits[i]];
        return sum;
      },
    };
  }

  // Min-heap on (f = cost + heuristic, insertion order): pops exactly the
  // element a stable sort of the whole queue would put first, in O(log n).
  function createRouteQueue() {
    const heap = [];
    let serial = 0;
    const less = (a, b) => a.f < b.f || (a.f === b.f && a.seq < b.seq);
    return {
      size: () => heap.length,
      push(value, f) {
        heap.push({ value, f, seq: serial++ });
        let i = heap.length - 1;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          if (!less(heap[i], heap[parent])) break;
          [heap[i], heap[parent]] = [heap[parent], heap[i]];
          i = parent;
        }
      },
      pop() {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
          heap[0] = last;
          let i = 0;
          for (;;) {
            const left = 2 * i + 1;
            const right = left + 1;
            let smallest = i;
            if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
            if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
            if (smallest === i) break;
            [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
            i = smallest;
          }
        }
        return top.value;
      },
    };
  }

  // createRouteQueue() for the indexed A*, without an object per entry:
  // entry n (the n-th push) is its f, state and cost in typed arrays
  // shared by every search, the heap holds entry numbers, and (f, n) orders
  // them as (f, seq) orders createRouteQueue()'s, so both pop the same
  // states in the same order.
  const stateQueue = { f: new Float64Array(1024), state: new Int32Array(1024), cost: new Float64Array(1024), heap: new Int32Array(1024) };
  function createStateQueue() {
    const q = stateQueue;
    let { f, state, cost, heap } = q;
    let size = 0;
    let serial = 0;
    // a before b: (f, entry number) order, written out in the loops.
    return {
      size: () => size,
      push(s, c, value) {
        if (serial === f.length) {
          const grow = (old, Type) => { const next = new Type(old.length * 2); next.set(old); return next; };
          q.f = f = grow(f, Float64Array);
          q.state = state = grow(state, Int32Array);
          q.cost = cost = grow(cost, Float64Array);
          q.heap = heap = grow(heap, Int32Array);
        }
        const n = serial++;
        f[n] = value;
        state[n] = s;
        cost[n] = c;
        let i = size++;
        while (i > 0) {
          const parent = (i - 1) >> 1;
          const p = heap[parent];
          if (!(value < f[p] || (value === f[p] && n < p))) break;
          heap[i] = p;
          i = parent;
        }
        heap[i] = n;
      },
      // Pops the first entry: returns its number (state[n], cost[n]).
      pop() {
        const top = heap[0];
        const last = heap[--size];
        if (size) {
          const lastF = f[last];
          let i = 0;
          for (;;) {
            const left = 2 * i + 1;
            if (left >= size) break;
            let child = left;
            let c = heap[left];
            if (left + 1 < size) {
              const r = heap[left + 1];
              if (f[r] < f[c] || (f[r] === f[c] && r < c)) { child = left + 1; c = r; }
            }
            if (!(f[c] < lastF || (f[c] === lastF && c < last))) break;
            heap[i] = c;
            i = child;
          }
          heap[i] = last;
        }
        return top;
      },
      stateOf: (n) => state[n],
      costOf: (n) => cost[n],
    };
  }

  function assembleOrthogonalRoute(sourcePort, sourceFan, body, targetFan, targetPort) {
    // Preserve sourceFan/targetFan as explicit anchors even when collinear.
    // Conflict detection can then exempt only the tiny shared port fan instead
    // of accidentally exempting a long merged segment.
    const route = [sourcePort, sourceFan];
    for (const point of body.slice(1, -1)) {
      const previousPoint = route[route.length - 1];
      if (!previousPoint || Math.abs(previousPoint.x - point.x) > 0.001 || Math.abs(previousPoint.y - point.y) > 0.001) route.push(point);
    }
    const previousPoint = route[route.length - 1];
    if (!previousPoint || Math.abs(previousPoint.x - targetFan.x) > 0.001 || Math.abs(previousPoint.y - targetFan.y) > 0.001) route.push(targetFan);
    route.push(targetPort);
    return route;
  }

  // Bounding boxes of routed polylines, keyed by the (immutable) points array.
  // orthogonalSegmentConflict() can only report a crossing or an overlap when
  // two segments touch within its 0.001 tolerance, so pairs of routes whose
  // boxes are further apart contribute exactly 0 and can be skipped.
  const routeBoxCache = new WeakMap();
  function routeBox(points) {
    let box = routeBoxCache.get(points);
    if (box) return box;
    box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const point of points) {
      if (point.x < box.minX) box.minX = point.x;
      if (point.x > box.maxX) box.maxX = point.x;
      if (point.y < box.minY) box.minY = point.y;
      if (point.y > box.maxY) box.maxY = point.y;
    }
    routeBoxCache.set(points, box);
    return box;
  }

  function routeBoxesApart(a, b) {
    const margin = 0.01;
    return a.maxX + margin < b.minX || b.maxX + margin < a.minX || a.maxY + margin < b.minY || b.maxY + margin < a.minY;
  }

  // Further apart than `margin` on either axis: no crossing, overlap or (with
  // margin LANE_GAP) near run is possible.
  function segmentsApart(a, b, c, d, margin = 0.01) {
    return Math.max(a.x, b.x) + margin < Math.min(c.x, d.x) || Math.max(c.x, d.x) + margin < Math.min(a.x, b.x)
      || Math.max(a.y, b.y) + margin < Math.min(c.y, d.y) || Math.max(c.y, d.y) + margin < Math.min(a.y, b.y);
  }

  // A search stopped by the step budget (searchIndexedGrid()).
  const SEARCH_STOPPED = { stopped: true };

  // routeEdges() as a generator that yields after each routed edge (and each
  // rerouting attempt), so a caller can spread a large run over several
  // frames (runSliced()); its return value is routeEdges()'s.
  function* routeEdgesSteps(items, edges, options = {}) {
    const isSecondary = options.isSecondary || (() => false);
    const itemList = [...items.entries()];
    const budget = {
      maxSteps: options.maxSteps ?? Infinity,
      searchSteps: options.searchSteps ?? Infinity,
      used: 0,
      cheap: 0,
      exhausted: false,
    };

    // Global row lanes, shared by every edge of this run.
    const rowYByIndex = new Map();
    for (const [, item] of itemList) {
      if (!Number.isFinite(item.lineageRow)) continue;
      if (!rowYByIndex.has(item.lineageRow)) rowYByIndex.set(item.lineageRow, nodePort(item, "right").y);
    }
    const rowYs = [...rowYByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y);
    const betweenRowYs = [];
    for (let i = 0; i + 1 < rowYs.length; i += 1) betweenRowYs.push((rowYs[i] + rowYs[i + 1]) / 2);

    function routePortMaps(list) {
      const outgoing = new Map();
      const incoming = new Map();
      for (const edge of list) {
        if (!items.has(edge.from) || !items.has(edge.to)) continue;
        if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
        if (!incoming.has(edge.to)) incoming.set(edge.to, []);
        outgoing.get(edge.from).push(edge);
        incoming.get(edge.to).push(edge);
      }

      const ports = new Map();
      const FAN_BASE = 18;
      const FAN_STEP = LANE_GAP;
      const FAN_MAX = 58;
      const edgePortY = (id, side) => {
        const item = items.get(id);
        return item ? nodePort(item, side).y : 0;
      };

      // Farthest destinations on the same vertical side turn first (closest to
      // the source). Their vertical lane therefore sits inside shorter routes
      // instead of cutting across them. Above/below branches may reuse the same
      // rank because they immediately travel in opposite directions.
      const fanRanks = (group, anchorY, otherId, otherSide) => {
        const buckets = { up: [], flat: [], down: [] };
        for (const edge of group) {
          const delta = edgePortY(otherId(edge), otherSide) - anchorY;
          const side = delta < -1 ? "up" : (delta > 1 ? "down" : "flat");
          buckets[side].push({ edge, distance: Math.abs(delta) });
        }
        buckets.up.sort((a, b) => b.distance - a.distance || String(a.edge.id).localeCompare(String(b.edge.id)));
        buckets.down.sort((a, b) => b.distance - a.distance || String(a.edge.id).localeCompare(String(b.edge.id)));
        buckets.flat.sort((a, b) => String(a.edge.id).localeCompare(String(b.edge.id)));
        const rank = new Map();
        for (const bucket of [buckets.up, buckets.down]) bucket.forEach((entry, index) => rank.set(entry.edge.id, index));
        const nonFlatMax = Math.max(buckets.up.length, buckets.down.length);
        buckets.flat.forEach((entry, index) => rank.set(entry.edge.id, nonFlatMax + index));
        return rank;
      };

      for (const [id, group] of outgoing) {
        const item = items.get(id);
        if (!item) continue;
        const port = nodePort(item, "right");
        const ranks = fanRanks(group, port.y, (edge) => edge.to, "left");
        for (const edge of group) {
          const current = ports.get(edge.id) || {};
          const rank = ranks.get(edge.id) || 0;
          const offset = Math.min(FAN_MAX, FAN_BASE + rank * FAN_STEP);
          current.a = port;
          current.aFan = { x: port.x + offset, y: port.y };
          current.aFanLimit = port.x + FAN_MAX + 2;
          ports.set(edge.id, current);
        }
      }

      for (const [id, group] of incoming) {
        const item = items.get(id);
        if (!item) continue;
        const port = nodePort(item, "left");
        const ranks = fanRanks(group, port.y, (edge) => edge.from, "right");
        for (const edge of group) {
          const current = ports.get(edge.id) || {};
          const rank = ranks.get(edge.id) || 0;
          const offset = Math.min(FAN_MAX, FAN_BASE + rank * FAN_STEP);
          current.b = port;
          current.bFan = { x: port.x - offset, y: port.y };
          current.bFanLimit = port.x - FAN_MAX - 2;
          ports.set(edge.id, current);
        }
      }
      return ports;
    }

    function sharedPortOverlapAllowed(a, b, currentEdge, segment) {
      if (!currentEdge || !segment) return false;
      const horizontal = Math.abs(a.y - b.y) < 0.001 && Math.abs(segment.a.y - segment.b.y) < 0.001;
      if (!horizontal) return false;

      if (segment.from === currentEdge.from) {
        const item = items.get(currentEdge.from);
        if (item) {
          const portX = item.x + item.width;
          const portY = nodePort(item, "right").y;
          const limit = portX + 62;
          const sameY = Math.abs(a.y - portY) < 0.001 && Math.abs(segment.a.y - portY) < 0.001;
          const inside = Math.max(a.x, b.x, segment.a.x, segment.b.x) <= limit + 0.001
            && Math.min(a.x, b.x, segment.a.x, segment.b.x) >= portX - 0.001;
          if (sameY && inside) return true;
        }
      }

      if (segment.to === currentEdge.to) {
        const item = items.get(currentEdge.to);
        if (item) {
          const portX = item.x;
          const portY = nodePort(item, "left").y;
          const limit = portX - 62;
          const sameY = Math.abs(a.y - portY) < 0.001 && Math.abs(segment.a.y - portY) < 0.001;
          const inside = Math.min(a.x, b.x, segment.a.x, segment.b.x) >= limit - 0.001
            && Math.max(a.x, b.x, segment.a.x, segment.b.x) <= portX + 0.001;
          if (sameY && inside) return true;
        }
      }
      return false;
    }

    // The penalty of a step (ax, ay)-(bx, by) of `currentEdge` against one
    // routed segment: orthogonalSegmentConflict() and its scoring, without
    // result objects (it runs for the candidates of every A* step). A near
    // run, an overlap or a crossing, at most one of them; each implies that
    // the two are not segmentsApart(..., LANE_GAP), so that test is left to
    // the callers that scan every segment.
    function segmentConflictTerm(ax, ay, bx, by, segment, currentEdge) {
      const c = segment.a;
      const d = segment.b;
      const aVertical = Math.abs(ax - bx) < 0.001;
      if (aVertical !== (Math.abs(c.x - d.x) < 0.001)) {
        // A crossing strictly inside both (not at a route's end: fans).
        const x = aVertical ? ax : c.x;
        const y = aVertical ? c.y : ay;
        const hx0 = aVertical ? c.x : ax;
        const hx1 = aVertical ? d.x : bx;
        const vy0 = aVertical ? ay : c.y;
        const vy1 = aVertical ? by : d.y;
        return x > Math.min(hx0, hx1) + 0.001 && x < Math.max(hx0, hx1) - 0.001
          && y > Math.min(vy0, vy1) + 0.001 && y < Math.max(vy0, vy1) - 0.001 ? CROSSING_COST : 0;
      }
      const gap = aVertical ? Math.abs(ax - c.x) : Math.abs(ay - c.y);
      if (gap >= LANE_GAP - 0.001) return 0;
      const shared = aVertical
        ? Math.max(0, Math.min(Math.max(ay, by), Math.max(c.y, d.y)) - Math.max(Math.min(ay, by), Math.min(c.y, d.y)))
        : Math.max(0, Math.min(Math.max(ax, bx), Math.max(c.x, d.x)) - Math.max(Math.min(ax, bx), Math.min(c.x, d.x)));
      if (!(shared > 0.5)) return 0;
      if (gap > 0.001) return NEAR_BASE + shared * NEAR_PER_PX;
      // Outside the tiny source/target fan, two routes must never share a
      // visible segment. Make overlap several orders of magnitude more
      // expensive than either a crossing or one extra bend.
      return sharedPortOverlapAllowed({ x: ax, y: ay }, { x: bx, y: by }, currentEdge, segment) ? 0 : 1_000_000_000 + shared * 100_000;
    }

    function routeConflictPenalty(a, b, usedSegments, currentEdge = null) {
      let penalty = 0;
      for (const segment of usedSegments) {
        // Disjoint segments cannot cross, overlap or run near (see routeBox()).
        if (segmentsApart(a, b, segment.a, segment.b, LANE_GAP)) continue;
        const value = segmentConflictTerm(a.x, a.y, b.x, b.y, segment, currentEdge);
        if (value !== 0) penalty += value;
      }
      return penalty;
    }

    function orthogonalRouteForEdge(edge, start, end, usedSegments, port = {}) {
      const sourcePort = port.a || start;
      const targetPort = port.b || end;
      const sourceFan = port.aFan || { x: sourcePort.x + 18, y: sourcePort.y };
      const targetFan = port.bFan || { x: targetPort.x - 18, y: targetPort.y };
      const direction = targetFan.x >= sourceFan.x ? 1 : -1;

      // Keep routing local to the two endpoints: only obstacles intersecting
      // this edge's corridor participate in its sparse grid, so a route never
      // takes a giant detour around unrelated rows.
      const horizontalPad = 48;
      const verticalPad = Math.max(78, Math.min(138, 72 + Math.abs(targetFan.y - sourceFan.y) * 0.12));
      const localLeft = Math.min(sourceFan.x, targetFan.x) - horizontalPad;
      const localRight = Math.max(sourceFan.x, targetFan.x) + horizontalPad;
      const localTop = Math.min(sourceFan.y, targetFan.y) - verticalPad;
      const localBottom = Math.max(sourceFan.y, targetFan.y) + verticalPad;
      const obstacles = [];
      for (let i = 0; i < itemList.length; i += 1) {
        const id = itemList[i][0];
        const item = itemList[i][1];
        if (id === edge.from || id === edge.to) continue;
        const right = item.x + item.width;
        const bottom = item.y + item.height;
        if (right >= localLeft && item.x <= localRight && bottom >= localTop && item.y <= localBottom) obstacles.push(item);
      }

      const padding = 14;
      // Past the step budget (options.maxSteps) every remaining edge gets a
      // cheap route: a few candidate lanes, no grid search.
      if (budget.exhausted) {
        budget.cheap += 1;
        return assembleOrthogonalRoute(sourcePort, sourceFan, cheapRouteBody(edge, sourceFan, targetFan, direction, usedSegments), targetFan, targetPort);
      }
      const xs = [sourceFan.x, targetFan.x, sourceFan.x + direction * 18, targetFan.x - direction * 18, localLeft, localRight];
      const ys = [sourceFan.y, targetFan.y, localTop, localBottom];

      // Route on the same global row grid used by the node layout. Horizontal
      // segments may occupy a node-row lane or a dedicated lane exactly between
      // rows. Secondary (dependency) edges prefer inter-row lanes so their
      // dashed paths do not weave through the data-flow corridors.
      for (const y of [...rowYs, ...betweenRowYs]) {
        if (y >= localTop - 0.001 && y <= localBottom + 0.001) ys.push(y);
      }
      const secondary = isSecondary(edge);
      const preferredHorizontalYs = secondary && betweenRowYs.length ? betweenRowYs : rowYs;
      // Distance to the nearest preferred lane, by binary search over the sorted
      // lanes and memoized per y. It is evaluated on every horizontal A* step.
      const sortedLaneYs = preferredHorizontalYs.slice().sort((a, b) => a - b);
      const lanePenaltyFactor = secondary ? 1.35 : 0.55;
      const lanePenaltyByY = new Map();
      const horizontalLanePenalty = (y) => {
        if (!sortedLaneYs.length) return 0;
        const cached = lanePenaltyByY.get(y);
        if (cached !== undefined) return cached;
        let lo = 0;
        let hi = sortedLaneYs.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sortedLaneYs[mid] < y) lo = mid + 1;
          else hi = mid;
        }
        let nearest = Infinity;
        if (lo < sortedLaneYs.length) nearest = Math.abs(sortedLaneYs[lo] - y);
        if (lo > 0) nearest = Math.min(nearest, Math.abs(sortedLaneYs[lo - 1] - y));
        const penalty = nearest * lanePenaltyFactor;
        lanePenaltyByY.set(y, penalty);
        return penalty;
      };

      for (const item of obstacles) {
        xs.push(item.x - padding, item.x + item.width + padding);
        ys.push(item.y - padding, item.y + item.height + padding);
      }
      // Existing routes expose neighbouring lanes only when they intersect this
      // local corridor. This prevents far-away edges from distorting the path.
      for (const segment of usedSegments) {
        const minSegX = Math.min(segment.a.x, segment.b.x);
        const maxSegX = Math.max(segment.a.x, segment.b.x);
        const minSegY = Math.min(segment.a.y, segment.b.y);
        const maxSegY = Math.max(segment.a.y, segment.b.y);
        if (maxSegX < localLeft || minSegX > localRight || maxSegY < localTop || minSegY > localBottom) continue;
        if (Math.abs(segment.a.x - segment.b.x) < 0.001) xs.push(segment.a.x - LANE_GAP, segment.a.x + LANE_GAP);
        if (Math.abs(segment.a.y - segment.b.y) < 0.001) ys.push(segment.a.y - LANE_GAP, segment.a.y + LANE_GAP);
      }

      const uniqueSorted = (values) => values.map(Number).filter(Number.isFinite).sort((a, b) => a - b)
        .filter((value, index, arr) => index === 0 || Math.abs(value - arr[index - 1]) > 0.01);
      const gridX = uniqueSorted(xs);
      const gridY = uniqueSorted(ys);
      // The sparse grid is |xs| x |ys| points. On very large lineage graphs a
      // single corridor can span thousands of rows (millions of points) and
      // freeze the tab for minutes. Past this budget the edge gets a plain
      // orthogonal H-V-H route; ordinary graphs stay far below it.
      if (gridX.length * gridY.length > ROUTE_GRID_POINT_BUDGET) {
        const midX = sourceFan.x + (targetFan.x - sourceFan.x) / 2;
        return assembleOrthogonalRoute(sourcePort, sourceFan, compressOrthogonalRoute([
          sourceFan,
          { x: midX, y: sourceFan.y },
          { x: midX, y: targetFan.y },
          targetFan,
        ]), targetFan, targetPort);
      }
      // Every grid point lies inside [gridX] x [gridY], so a routed segment whose
      // box is apart from that rectangle is apart from every candidate step and
      // contributes exactly 0 in routeConflictPenalty(). Filter once per edge.
      const gridCornerA = { x: gridX[0], y: gridY[0] };
      const gridCornerB = { x: gridX[gridX.length - 1], y: gridY[gridY.length - 1] };
      const corridorSegments = usedSegments.filter((segment) => !segmentsApart(gridCornerA, gridCornerB, segment.a, segment.b, LANE_GAP));
      const corridorSegmentIndex = createSegmentIndex(corridorSegments);

      const clearSegment = (a, b) => !obstacles.some((item) => segmentHitsItem(a, b, item, padding));
      const verticalDelta = targetFan.y - sourceFan.y;
      const verticalDirection = verticalDelta < -0.001 ? -1 : (verticalDelta > 0.001 ? 1 : 0);
      // Same-row links are the only case allowed to move away from the target row
      // and then come back: that detour is necessary when a card blocks the
      // straight horizontal channel. For up/down links the vertical coordinate
      // is strictly monotone from source row to destination row.
      const sameRowNeedsDetour = verticalDirection === 0 && !clearSegment(sourceFan, targetFan);

      // One A* relaxation: the cost of moving from `currentPoint` to
      // `nextPoint` in direction `dir` ("H" / "V"), or null when the move is
      // not allowed.
      // `memo` (optional): a Float64Array slot per grid link holding its
      // conflict penalty, which depends only on the link and this edge; the
      // A* relaxes one link from up to three states.
      const stepCost = (currentCost, currentDir, currentPoint, nextPoint, dir, length, memo = null, slot = 0) => {
        const dx = nextPoint.x - currentPoint.x;
        const dy = nextPoint.y - currentPoint.y;
        // Left-to-right DAG links never backtrack horizontally. Backward graph
        // edges use the mirrored rule. This removes rectangular loops that can
        // only make a route longer and harder to read.
        if (direction > 0 && dx < -0.001) return null;
        if (direction < 0 && dx > 0.001) return null;
        if (dir === "V") {
          if (verticalDirection < 0) {
            if (dy > 0.001 || nextPoint.y < targetFan.y - 0.001) return null;
          } else if (verticalDirection > 0) {
            if (dy < -0.001 || nextPoint.y > targetFan.y + 0.001) return null;
          } else if (!sameRowNeedsDetour && Math.abs(dy) > 0.001) {
            return null;
          }
        }
        // Angles are deliberately expensive: for a clean DAG a short route
        // with 2 bends is preferable to a maze of small detours.
        const bend = currentDir !== "N" && currentDir !== dir ? 220 : 0;
        let conflict = memo ? memo[slot] : NaN;
        if (conflict !== conflict) {
          conflict = corridorSegmentIndex.penalty(currentPoint.x, currentPoint.y, nextPoint.x, nextPoint.y, edge, segmentConflictTerm);
          if (memo) memo[slot] = conflict;
        }
        const reverse = dir === "H" && direction * (nextPoint.x - currentPoint.x) < -0.001 ? 1400 : 0;
        const boundary = nextPoint.x < localLeft - 0.01 || nextPoint.x > localRight + 0.01
          || nextPoint.y < localTop - 0.01 || nextPoint.y > localBottom + 0.01 ? 20_000 : 0;
        const lane = dir === "H" ? horizontalLanePenalty(nextPoint.y) : 0;
        return currentCost + length + bend + conflict + reverse + boundary + lane;
      };
      const heuristic = (point) => Math.abs(point.x - targetFan.x) + Math.abs(point.y - targetFan.y);

      const ixStart = gridX.indexOf(sourceFan.x);
      const iyStart = gridY.indexOf(sourceFan.y);
      const ixEnd = gridX.indexOf(targetFan.x);
      const iyEnd = gridY.indexOf(targetFan.y);
      let found;
      if (ixStart >= 0 && iyStart >= 0 && ixEnd >= 0 && iyEnd >= 0) {
        found = searchIndexedGrid();
      } else {
        found = searchKeyedGrid();
      }
      // A search stopped by the step budget: the cheap route instead.
      if (found === SEARCH_STOPPED) {
        budget.cheap += 1;
        return assembleOrthogonalRoute(sourcePort, sourceFan, cheapRouteBody(edge, sourceFan, targetFan, direction, usedSegments), targetFan, targetPort);
      }

      // The sparse grid as typed arrays: point id = ix * |gridY| + iy, the
      // obstacles marked per covered cell, each lane's consecutive free points
      // linked when no card cuts the segment between them. Same points, the
      // same neighbour order (left, right, up, down) and the same A* as
      // searchKeyedGrid(), without string keys, per-point obstacle scans or
      // per-lane sorts (they made the router take seconds on 500-edge graphs).
      function searchIndexedGrid() {
        const NX = gridX.length;
        const NY = gridY.length;
        const total = NX * NY;
        const buffers = gridBuffers(total);
        const blocked = buffers.blocked;
        const inner = padding - 0.5;
        const firstAbove = (values, limit) => {
          let lo = 0;
          let hi = values.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] <= limit) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        const firstAtLeast = (values, limit) => {
          let lo = 0;
          let hi = values.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (values[mid] < limit) lo = mid + 1;
            else hi = mid;
          }
          return lo;
        };
        for (const item of obstacles) {
          // pointInsideItem(point, item, padding - 0.5): strict inequalities.
          const x0 = firstAbove(gridX, item.x - inner);
          const x1 = firstAtLeast(gridX, item.x + item.width + inner) - 1;
          const y0 = firstAbove(gridY, item.y - inner);
          const y1 = firstAtLeast(gridY, item.y + item.height + inner) - 1;
          for (let ix = x0; ix <= x1; ix += 1) {
            const base = ix * NY;
            for (let iy = y0; iy <= y1; iy += 1) blocked[base + iy] = 1;
          }
        }
        const start = ixStart * NY + iyStart;
        const end = ixEnd * NY + iyEnd;
        blocked[start] = 0;
        blocked[end] = 0;

        const { left, right, up, down } = buffers;
        // segmentHitsItem(a, b, item, padding) for a horizontal segment.
        for (let iy = 0; iy < NY; iy += 1) {
          const y = gridY[iy];
          const cutting = obstacles.filter((item) => !(y <= item.y - padding || y >= item.y + item.height + padding));
          let previousIx = -1;
          for (let ix = 0; ix < NX; ix += 1) {
            const id = ix * NY + iy;
            if (blocked[id]) continue;
            if (previousIx >= 0) {
              const lo = gridX[previousIx];
              const hi = gridX[ix];
              let clear = true;
              for (let c = 0; c < cutting.length; c += 1) {
                const item = cutting[c];
                if (hi > item.x - padding && lo < item.x + item.width + padding) { clear = false; break; }
              }
              if (clear) {
                const previousId = previousIx * NY + iy;
                right[previousId] = id;
                left[id] = previousId;
              }
            }
            previousIx = ix;
          }
        }
        // ... and for a vertical one.
        for (let ix = 0; ix < NX; ix += 1) {
          const x = gridX[ix];
          const cutting = obstacles.filter((item) => !(x <= item.x - padding || x >= item.x + item.width + padding));
          const base = ix * NY;
          let previousIy = -1;
          for (let iy = 0; iy < NY; iy += 1) {
            const id = base + iy;
            if (blocked[id]) continue;
            if (previousIy >= 0) {
              const lo = gridY[previousIy];
              const hi = gridY[iy];
              let clear = true;
              for (let c = 0; c < cutting.length; c += 1) {
                const item = cutting[c];
                if (hi > item.y - padding && lo < item.y + item.height + padding) { clear = false; break; }
              }
              if (clear) {
                down[base + previousIy] = id;
                up[id] = base + previousIy;
              }
            }
            previousIy = iy;
          }
        }

        const pointOf = (id) => ({ x: gridX[(id / NY) | 0], y: gridY[id % NY] });
        // States: id * 3 + direction (0 = none yet, 1 = H, 2 = V).
        const { best, previous, conflict: conflictMemo } = buffers;
        best[start * 3] = 0;
        const queue = createStateQueue();
        queue.push(start * 3, 0, 0 + heuristic(pointOf(start)));
        let finalState = -1;
        // Relaxations of this search, against the run's step budget: a search
        // past options.searchSteps, or past what is left of options.maxSteps,
        // stops (and the edge gets the cheap route).
        let relaxations = 0;
        const stepCap = Math.min(budget.searchSteps, budget.maxSteps - budget.used);
        // stepCost() inlined on grid indexes, term for term and in the same
        // order (the same costs to the last bit), without a point object per
        // step: horizontalLanePenalty() per grid row, the conflict through
        // the link's memo slot.
        const laneAt = new Float64Array(NY).fill(NaN);
        const targetX = targetFan.x;
        const targetY = targetFan.y;
        while (queue.size()) {
          const entry = queue.pop();
          const currentState = queue.stateOf(entry);
          const currentCost = queue.costOf(entry);
          if (currentCost !== best[currentState]) continue;
          const id = (currentState / 3) | 0;
          if (id === end) { finalState = currentState; break; }
          if (relaxations > stepCap) {
            budget.used += relaxations;
            if (budget.used >= budget.maxSteps) budget.exhausted = true;
            return SEARCH_STOPPED;
          }
          const currentDir = currentState % 3;
          const cx = gridX[(id / NY) | 0];
          const cy = gridY[id % NY];
          for (let k = 0; k < 4; k += 1) {
            const nextId = k === 0 ? left[id] : k === 1 ? right[id] : k === 2 ? up[id] : down[id];
            if (nextId < 0) continue;
            relaxations += 1;
            const dir = k < 2 ? 1 : 2;
            const nIy = nextId % NY;
            const nx = gridX[(nextId / NY) | 0];
            const ny = gridY[nIy];
            const length = Math.abs(cx - nx) + Math.abs(cy - ny);
            const dx = nx - cx;
            const dy = ny - cy;
            if (direction > 0 && dx < -0.001) continue;
            if (direction < 0 && dx > 0.001) continue;
            if (dir === 2) {
              if (verticalDirection < 0) {
                if (dy > 0.001 || ny < targetY - 0.001) continue;
              } else if (verticalDirection > 0) {
                if (dy < -0.001 || ny > targetY + 0.001) continue;
              } else if (!sameRowNeedsDetour && Math.abs(dy) > 0.001) {
                continue;
              }
            }
            const bend = currentDir !== 0 && currentDir !== dir ? 220 : 0;
            const reverse = dir === 1 && direction * (nx - cx) < -0.001 ? 1400 : 0;
            const boundary = nx < localLeft - 0.01 || nx > localRight + 0.01
              || ny < localTop - 0.01 || ny > localBottom + 0.01 ? 20_000 : 0;
            let lane = 0;
            if (dir === 1) {
              lane = laneAt[nIy];
              if (lane !== lane) {
                lane = horizontalLanePenalty(ny);
                laneAt[nIy] = lane;
              }
            }
            const nextState = nextId * 3 + dir;
            const slot = id * 4 + k;
            let conflict = conflictMemo[slot];
            if (conflict !== conflict) {
              // The conflict is >= 0 and a float sum never decreases when a
              // term grows: a move that cannot improve the next state without
              // its conflict cannot with it, which is then not needed.
              if (currentCost + length + bend + reverse + boundary + lane + 0.001 >= best[nextState]) continue;
              // The link's grid row (H) or column (V): its query line.
              conflict = corridorSegmentIndex.penalty(cx, cy, nx, ny, edge, segmentConflictTerm, Infinity, dir === 1 ? id % NY : NY + ((id / NY) | 0));
              conflictMemo[slot] = conflict;
            }
            const cost = currentCost + length + bend + conflict + reverse + boundary + lane;
            if (cost + 0.001 >= best[nextState]) continue;
            best[nextState] = cost;
            previous[nextState] = currentState;
            queue.push(nextState, cost, cost + (Math.abs(nx - targetX) + Math.abs(ny - targetY)));
          }
        }
        budget.used += relaxations;
        if (budget.used >= budget.maxSteps) budget.exhausted = true;
        if (finalState < 0) return null;
        const body = [];
        for (let s = finalState; s >= 0; s = previous[s]) body.push(pointOf((s / 3) | 0));
        body.reverse();
        return compressOrthogonalRoute(body);
      }

      // The reference implementation (string-keyed points), used when a fan
      // point is not exactly on the deduplicated grid.
      function searchKeyedGrid() {
      const pointKey = (x, y) => `${x}\u0000${y}`;
      const points = new Map();
      for (const x of gridX) {
        for (const y of gridY) {
          const point = { x, y };
          if (obstacles.some((item) => pointInsideItem(point, item, padding - 0.5))) continue;
          points.set(pointKey(x, y), point);
        }
      }
      points.set(pointKey(sourceFan.x, sourceFan.y), sourceFan);
      points.set(pointKey(targetFan.x, targetFan.y), targetFan);
      const adjacency = new Map([...points.keys()].map((key) => [key, []]));
      const connectLine = (keys, horizontal) => {
        keys.sort((ka, kb) => {
          const a = points.get(ka);
          const b = points.get(kb);
          return horizontal ? a.x - b.x : a.y - b.y;
        });
        for (let i = 0; i + 1 < keys.length; i += 1) {
          const aKey = keys[i];
          const bKey = keys[i + 1];
          const a = points.get(aKey);
          const b = points.get(bKey);
          if (!clearSegment(a, b)) continue;
          const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
          const dir = horizontal ? "H" : "V";
          adjacency.get(aKey).push({ key: bKey, length, dir });
          adjacency.get(bKey).push({ key: aKey, length, dir });
        }
      };
      // Bucket the grid once per axis; connectLine() sorts each lane by
      // coordinate, so bucket order cannot change the result.
      const keysByY = new Map();
      const keysByX = new Map();
      for (const [key, point] of points) {
        if (!keysByY.has(point.y)) keysByY.set(point.y, []);
        keysByY.get(point.y).push(key);
        if (!keysByX.has(point.x)) keysByX.set(point.x, []);
        keysByX.get(point.x).push(key);
      }
      for (const y of gridY) connectLine((keysByY.get(y) || []).slice(), true);
      for (const x of gridX) connectLine((keysByX.get(x) || []).slice(), false);

      const startKey = pointKey(sourceFan.x, sourceFan.y);
      const endKey = pointKey(targetFan.x, targetFan.y);
      const best = new Map([[`${startKey}\u0000N`, 0]]);
      const previous = new Map();
      let finalState = null;
      const queue = createRouteQueue();
      const pushState = (state) => queue.push(state, state.cost + heuristic(points.get(state.key)));
      pushState({ key: startKey, dir: "N", cost: 0 });

      while (queue.size()) {
        const current = queue.pop();
        const stateKey = `${current.key}\u0000${current.dir}`;
        if (current.cost !== best.get(stateKey)) continue;
        if (current.key === endKey) { finalState = current; break; }
        const currentPoint = points.get(current.key);
        for (const next of adjacency.get(current.key) || []) {
          const nextPoint = points.get(next.key);
          const cost = stepCost(current.cost, current.dir, currentPoint, nextPoint, next.dir, next.length);
          if (cost === null) continue;
          const nextStateKey = `${next.key}\u0000${next.dir}`;
          if (cost + 0.001 >= (best.get(nextStateKey) ?? Infinity)) continue;
          best.set(nextStateKey, cost);
          previous.set(nextStateKey, stateKey);
          pushState({ key: next.key, dir: next.dir, cost });
        }
      }
      if (!finalState) return null;
      const body = [];
      let stateKey = `${finalState.key}\u0000${finalState.dir}`;
      while (stateKey) {
        const split = stateKey.lastIndexOf("\u0000");
        const key = stateKey.slice(0, split);
        body.push(points.get(key));
        stateKey = previous.get(stateKey) || null;
      }
      body.reverse();
      return compressOrthogonalRoute(body);
      }

      let body = found;
      if (!body) {
        const score = (route) => polylineMetric(route).total
          + routeBendCount(route) * 220
          + route.slice(0, -1).reduce((sum, point, index) => sum + routeConflictPenalty(point, route[index + 1], usedSegments, edge), 0);
        if (verticalDirection !== 0) {
          // Preserve the source->destination vertical direction even in the
          // fallback. Try simple H-V-H lanes on the existing sparse grid; a link
          // going upward can therefore never dip down and vice versa.
          const minX = Math.min(sourceFan.x, targetFan.x) - 0.001;
          const maxX = Math.max(sourceFan.x, targetFan.x) + 0.001;
          const candidateXs = gridX.filter((x) => x >= minX && x <= maxX)
            .sort((a, b) => Math.abs(a - (sourceFan.x + targetFan.x) / 2) - Math.abs(b - (sourceFan.x + targetFan.x) / 2));
          const candidates = candidateXs.map((laneX) => compressOrthogonalRoute([
            sourceFan,
            { x: laneX, y: sourceFan.y },
            { x: laneX, y: targetFan.y },
            targetFan,
          ])).filter((route) => route.slice(0, -1).every((point, index) => clearSegment(point, route[index + 1])));
          candidates.sort((a, b) => score(a) - score(b));
          body = candidates[0] || compressOrthogonalRoute([
            sourceFan,
            { x: sourceFan.x + direction * 18, y: sourceFan.y },
            { x: sourceFan.x + direction * 18, y: targetFan.y },
            targetFan,
          ]);
        } else {
          // Same-row obstacle exception: a short top/bottom detour is allowed,
          // because remaining on the row would pass through another node.
          const fallbackTop = Math.min(localTop, ...obstacles.map((item) => item.y - padding - 24));
          const fallbackBottom = Math.max(localBottom, ...obstacles.map((item) => item.y + item.height + padding + 24));
          const candidates = [fallbackTop, fallbackBottom].map((channelY) => compressOrthogonalRoute([
            sourceFan,
            { x: sourceFan.x + direction * 18, y: sourceFan.y },
            { x: sourceFan.x + direction * 18, y: channelY },
            { x: targetFan.x - direction * 18, y: channelY },
            { x: targetFan.x - direction * 18, y: targetFan.y },
            targetFan,
          ])).filter((route) => route.slice(0, -1).every((point, index) => clearSegment(point, route[index + 1])));
          candidates.sort((a, b) => score(a) - score(b));
          body = candidates[0] || compressOrthogonalRoute([
            sourceFan,
            { x: sourceFan.x + direction * 18, y: sourceFan.y },
            { x: sourceFan.x + direction * 18, y: fallbackTop },
            { x: targetFan.x - direction * 18, y: fallbackTop },
            { x: targetFan.x - direction * 18, y: targetFan.y },
            targetFan,
          ]);
        }
      }

      return assembleOrthogonalRoute(sourcePort, sourceFan, body, targetFan, targetPort);
    }

    // ------------------------------------------------ cheap (budget) routes

    // The route of an edge past the step budget: the cheapest clear one of a
    // few candidates, scored like A* steps (length, 220 per bend, the
    // conflict penalties against the routes already placed): one vertical
    // lane between the two fans (H-V-H), or a horizontal channel between card
    // rows or just above / below the cards in the way, reached in the gaps
    // next to the two cards (H-V-H-V-H). Every candidate is checked against
    // the cards of the columns it passes, in any row. A few hundred segment
    // tests instead of a grid search per edge.
    const cheapIndexes = new WeakMap();
    function cheapRouteBody(edge, sourceFan, targetFan, direction, usedSegments) {
      const padding = 14;
      let index = cheapIndexes.get(usedSegments);
      if (!index) {
        // Past the step budget speed comes first: cheap routes avoid overlaps
        // and crossings, not near runs (the dense maps' 40 / 600 budget).
        index = createSegmentIndex(usedSegments, { dynamic: true, nearRuns: false });
        cheapIndexes.set(usedSegments, index);
      }
      index.sync();
      const left = Math.min(sourceFan.x, targetFan.x);
      const right = Math.max(sourceFan.x, targetFan.x);
      const obstacles = [];
      for (let i = 0; i < itemList.length; i += 1) {
        const id = itemList[i][0];
        const item = itemList[i][1];
        if (id === edge.from || id === edge.to) continue;
        if (item.x + item.width + padding > left - 30 && item.x - padding < right + 30) obstacles.push(item);
      }
      const clearRoute = (route) => {
        for (let i = 0; i + 1 < route.length; i += 1) {
          for (const item of obstacles) if (segmentHitsItem(route[i], route[i + 1], item, padding)) return false;
        }
        return true;
      };
      const sourceY = sourceFan.y;
      const targetY = targetFan.y;
      const lowY = Math.min(sourceY, targetY);
      const highY = Math.max(sourceY, targetY);
      // Candidates: a dense map has hundreds per call, of which the loop
      // below takes a few, so each is kept as numbers (its bends: none, a
      // lane x, or x1, a channel y and x2) with its base, the length of its
      // compressOrthogonalRoute() as polylineMetric() sums it + 220 per bend,
      // computed on reused points; routeOf() builds the route of one taken.
      const lanes = [];
      const bases = [];
      const direct = [sourceFan, targetFan];
      const lane = [sourceFan, { x: 0, y: sourceY }, { x: 0, y: targetY }, targetFan];
      const channel = [sourceFan, { x: 0, y: sourceY }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: targetY }, targetFan];
      const pointsOf = (k) => {
        const bends = lanes[k];
        if (bends.length === 0) return direct;
        if (bends.length === 1) {
          lane[1].x = bends[0];
          lane[2].x = bends[0];
          return lane;
        }
        channel[1].x = bends[0];
        channel[2].x = bends[0];
        channel[2].y = bends[1];
        channel[3].x = bends[2];
        channel[3].y = bends[1];
        channel[4].x = bends[2];
        return channel;
      };
      const kept = [];
      const add = (...bends) => {
        lanes.push(bends);
        // compressOrthogonalRoute() into `kept`, then the base.
        const points = pointsOf(lanes.length - 1);
        let n = 0;
        kept[n++] = points[0];
        for (let i = 1; i + 1 < points.length; i += 1) {
          const a = kept[n - 1];
          const b = points[i];
          const c = points[i + 1];
          const vertical = Math.abs(a.x - b.x) < 0.001 && Math.abs(b.x - c.x) < 0.001;
          const horizontal = Math.abs(a.y - b.y) < 0.001 && Math.abs(b.y - c.y) < 0.001;
          if (!vertical && !horizontal) kept[n++] = b;
        }
        kept[n++] = points[points.length - 1];
        let length = 0;
        for (let i = 0; i + 1 < n; i += 1) length += Math.hypot(kept[i + 1].x - kept[i].x, kept[i + 1].y - kept[i].y);
        let turns = 0;
        for (let i = 1; i + 1 < n; i += 1) {
          if ((Math.abs(kept[i - 1].x - kept[i].x) < 0.001) !== (Math.abs(kept[i].x - kept[i + 1].x) < 0.001)) turns += 1;
        }
        bases.push(Math.max(length, 0.0001) + turns * 220);
      };
      const routeOf = (k) => compressOrthogonalRoute(pointsOf(k).map((point) => (point === sourceFan || point === targetFan ? point : { x: point.x, y: point.y })));
      if (Math.abs(sourceY - targetY) < 0.001) add();
      const laneXs = [sourceFan.x + direction * 18, targetFan.x - direction * 18];
      for (const item of obstacles) laneXs.push(item.x - padding - 6, item.x + item.width + padding + 6);
      for (const base of laneXs) {
        for (const shift of [0, 8, -8, 16, -16]) {
          const x = base + shift;
          if (x < left - 0.001 || x > right + 0.001) continue;
          add(x);
        }
      }
      let top = lowY;
      let bottom = highY;
      for (const item of obstacles) {
        if (item.y - padding >= highY || item.y + item.height + padding <= lowY) continue;
        top = Math.min(top, item.y);
        bottom = Math.max(bottom, item.y + item.height);
      }
      const channels = betweenRowYs.slice();
      for (let k = 0; k < 6; k += 1) channels.push(top - padding - 10 - k * 8, bottom + padding + 10 + k * 8);
      for (const channelY of channels) {
        for (let k = 0; k < 4; k += 1) {
          const x1 = sourceFan.x + direction * k * 8;
          const x2 = targetFan.x - direction * k * 8;
          if (direction * (x2 - x1) < 0) continue;
          add(x1, channelY, x2);
        }
      }
      // In the order of a stable sort by base (base, then position), taken
      // from a heap as needed: the loop stops after a few of the hundreds of
      // candidates of a dense map.
      const heap = new Int32Array(bases.length);
      for (let i = 0; i < heap.length; i += 1) heap[i] = i;
      const before = (i, j) => bases[i] < bases[j] || (bases[i] === bases[j] && i < j);
      const siftDown = (at, size) => {
        const value = heap[at];
        for (;;) {
          const left = 2 * at + 1;
          if (left >= size) break;
          const child = left + 1 < size && before(heap[left + 1], heap[left]) ? left + 1 : left;
          if (!before(heap[child], value)) break;
          heap[at] = heap[child];
          at = child;
        }
        heap[at] = value;
      };
      let size = heap.length;
      for (let i = (size >> 1) - 1; i >= 0; i -= 1) siftDown(i, size);
      let best = null;
      let bestCost = Infinity;
      let scored = 0;
      while (size > 0) {
        const next = heap[0];
        size -= 1;
        heap[0] = heap[size];
        siftDown(0, size);
        const base = bases[next];
        if (base >= bestCost || scored >= 24) break;
        const route = routeOf(next);
        if (!clearRoute(route)) continue;
        scored += 1;
        let cost = base;
        for (let i = 0; i + 1 < route.length && cost < bestCost; i += 1) {
          const a = route[i];
          const b = route[i + 1];
          // Past bestCost - cost the candidate loses whatever the rest adds.
          cost += index.penalty(a.x, a.y, b.x, b.y, edge, segmentConflictTerm, bestCost - cost);
        }
        if (cost < bestCost) { bestCost = cost; best = route; }
      }
      return best || compressOrthogonalRoute([
        sourceFan,
        { x: sourceFan.x + direction * 18, y: sourceY },
        { x: sourceFan.x + direction * 18, y: targetY },
        targetFan,
      ]);
    }

    // --------------------------------------------------- route set scoring

    // score(routes) adds, over the routes in order, length * 0.02 and
    // 180 per bend, then the pair conflict (crossings and overlaps of their
    // segments) with every later route. Only conflicting pairs add anything:
    // they are found through the segment index (O(segments x neighbours))
    // instead of comparing every pair of routes (O(E^2): 14.6 s over 1,100
    // edges), and every sum is made in the order of the pairwise loops, so
    // scores, and the routes they choose, are the same to the last bit.
    const ownScoreCache = new WeakMap();
    function ownScore(points) {
      let own = ownScoreCache.get(points);
      if (!own) {
        own = [polylineMetric(points).total * 0.02, routeBendCount(points) * 180];
        ownScoreCache.set(points, own);
      }
      return own;
    }

    // The conflict of two segments of two routes (routePairConflictScore's
    // inner loop), 0 for most.
    function segmentPairConflict(a, edgeA, b, edgeB) {
      if (segmentsApart(a.a, a.b, b.a, b.b, LANE_GAP)) return 0;
      const conflict = orthogonalSegmentConflict(a.a, a.b, b.a, b.b);
      if (conflict.crossings) return conflict.crossings * 28_000;
      if (conflict.near > 0.5) return NEAR_BASE + conflict.near * NEAR_PER_PX;
      if (conflict.overlap > 0.5 && !(sharedPortOverlapAllowed(a.a, a.b, edgeA, b) || sharedPortOverlapAllowed(b.a, b.b, edgeB, a))) {
        return 1_000_000_000 + conflict.overlap * 100_000;
      }
      return 0;
    }

    // A scored route set: list[i] = { id, edge, points, a, b, segments },
    // pairs[i] = Map(j > i -> conflict of routes i and j), non-zero only.
    function scoredRouteSet(routes, edgesById) {
      const list = [];
      for (const [id, route] of routes) {
        const edge = edgesById.get(id);
        if (!edge) continue;
        list.push({ id, edge, ...route, segments: routeSegmentMeta(route.points, edge) });
      }
      const all = [];
      const owner = [];
      list.forEach((entry, i) => { for (const segment of entry.segments) { all.push(segment); owner.push(i); } });
      const position = new Map(all.map((segment, i) => [segment, i]));
      const index = createSegmentIndex(all);
      const pairs = list.map(() => new Map());
      list.forEach((entry, i) => {
        for (const segment of entry.segments) {
          for (const other of index.near(segment.a, segment.b)) {
            const j = owner[position.get(other)];
            if (j <= i) continue;
            const term = segmentPairConflict(segment, entry.edge, other, list[j].edge);
            if (term) pairs[i].set(j, (pairs[i].get(j) || 0) + term);
          }
        }
      });
      return { list, pairs };
    }

    function sortedPairKeys(row) {
      return row.size > 1 ? [...row.keys()].sort((x, y) => x - y) : [...row.keys()];
    }

    // routeSetScore() of the set, with route `swap.at` replaced by
    // swap.points and its pair conflicts by swap.pairs (Map(other -> value)).
    function setScore(set, swap = null) {
      let score = 0;
      for (let i = 0; i < set.list.length; i += 1) {
        const own = ownScore(swap && swap.at === i ? swap.points : set.list[i].points);
        score += own[0];
        score += own[1];
        if (swap && swap.at === i) {
          for (const j of sortedPairKeys(swap.pairs)) if (j > i) score += swap.pairs.get(j);
          continue;
        }
        if (swap && i < swap.at) {
          const row = new Map(set.pairs[i]);
          row.delete(swap.at);
          if (swap.pairs.has(i)) row.set(swap.at, swap.pairs.get(i));
          for (const j of sortedPairKeys(row)) score += row.get(j);
          continue;
        }
        const row = set.pairs[i];
        for (const j of sortedPairKeys(row)) score += row.get(j);
      }
      return score;
    }

    // Pair conflicts of a new route for entry `at` with every other route
    // (indexed by `index` over `segments`, the other routes' segments in
    // order, `owner` their route), each summed in the order the pairwise
    // loop would (the earlier route's segments outer).
    function swapPairs(set, at, points, segments, owner, index) {
      const edge = set.list[at].edge;
      const mine = routeSegmentMeta(points, edge);
      const position = new Map(segments.map((segment, i) => [segment, i]));
      const terms = new Map();
      mine.forEach((segment, k) => {
        for (const other of index.near(segment.a, segment.b)) {
          const p = position.get(other);
          const j = owner[p];
          const term = segmentPairConflict(segment, edge, other, set.list[j].edge);
          if (!term) continue;
          if (!terms.has(j)) terms.set(j, []);
          terms.get(j).push(j < at ? [other.index, k, term] : [k, other.index, term]);
        }
      });
      const out = new Map();
      for (const [j, list] of terms) {
        list.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        let sum = 0;
        for (const [, , term] of list) sum += term;
        out.set(j, sum);
      }
      return out;
    }

    // --------------------------------------------------------- the run

    function* buildRouteCandidate(ordered, ports) {
      const usedSegments = [];
      const routes = new Map();
      for (const edge of ordered) {
        const from = items.get(edge.from);
        const to = items.get(edge.to);
        if (!from || !to) continue;
        const port = ports.get(edge.id) || {};
        const a = port.a || nodePort(from, "right");
        const b = port.b || nodePort(to, "left");
        const points = orthogonalRouteForEdge(edge, a, b, usedSegments, port);
        routes.set(edge.id, { points, a, b });
        usedSegments.push(...routeSegmentMeta(points, edge));
        yield;
      }
      return routes;
    }

    function* improveRouteCandidate(initialRoutes, list, ports, edgesById) {
      const set = scoredRouteSet(initialRoutes, edgesById);
      let score = setScore(set);
      const positionById = new Map(set.list.map((entry, i) => [entry.id, i]));
      // Rip-up/reroute the most conflicted edge against the rest of the already
      // accepted graph. Four bounded passes are enough to resolve most local
      // order artefacts while keeping graphs deterministic and cheap.
      for (let pass = 0; pass < 4 && !budget.exhausted; pass += 1) {
        const conflictByEdge = new Map(list.map((edge) => [edge.id, 0]));
        for (let i = 0; i < set.list.length; i += 1) {
          const row = set.pairs[i];
          for (const j of sortedPairKeys(row)) {
            const conflict = row.get(j);
            conflictByEdge.set(set.list[i].id, (conflictByEdge.get(set.list[i].id) || 0) + conflict);
            conflictByEdge.set(set.list[j].id, (conflictByEdge.get(set.list[j].id) || 0) + conflict);
          }
        }
        const conflicted = list.slice().sort((a, b) => (conflictByEdge.get(b.id) || 0) - (conflictByEdge.get(a.id) || 0) || String(a.id).localeCompare(String(b.id)));
        let improved = false;
        for (const edge of conflicted.slice(0, 8)) {
          if (!(conflictByEdge.get(edge.id) > 0)) break;
          if (budget.exhausted) break;
          const from = items.get(edge.from);
          const to = items.get(edge.to);
          if (!from || !to) continue;
          const at = positionById.get(edge.id);
          if (at == null) continue;
          const usedSegments = [];
          const owner = [];
          set.list.forEach((entry, i) => {
            if (i === at) return;
            for (const segment of entry.segments) { usedSegments.push(segment); owner.push(i); }
          });
          const port = ports.get(edge.id) || {};
          const a = port.a || nodePort(from, "right");
          const b = port.b || nodePort(to, "left");
          const points = orthogonalRouteForEdge(edge, a, b, usedSegments, port);
          const pairs = swapPairs(set, at, points, usedSegments, owner, createSegmentIndex(usedSegments));
          const candidateScore = setScore(set, { at, points, pairs });
          yield;
          if (candidateScore + 0.001 < score) {
            set.list[at] = { ...set.list[at], points, a, b, segments: routeSegmentMeta(points, edge) };
            for (let i = 0; i < at; i += 1) {
              set.pairs[i].delete(at);
              if (pairs.has(i)) set.pairs[i].set(at, pairs.get(i));
            }
            set.pairs[at] = new Map([...pairs].filter(([j]) => j > at));
            score = candidateScore;
            improved = true;
            break;
          }
        }
        if (!improved) break;
      }
      return new Map(set.list.map((entry) => [entry.id, { points: entry.points, a: entry.a, b: entry.b }]));
    }

    const ports = routePortMaps(edges);
    const edgesById = new Map(edges.map((edge) => [edge.id, edge]));
    const baseCompare = (a, b) => {
      const aSecondary = isSecondary(a) ? 1 : 0;
      const bSecondary = isSecondary(b) ? 1 : 0;
      if (aSecondary !== bSecondary) return aSecondary - bSecondary;
      const af = items.get(a.from);
      const bf = items.get(b.from);
      const at = items.get(a.to);
      const bt = items.get(b.to);
      return (af?.x ?? 0) - (bf?.x ?? 0)
        || (af?.y ?? 0) - (bf?.y ?? 0)
        // Fan-out follows target vertical order: low destinations are routed
        // after high destinations and leave through the lower fan lane.
        || ((at?.y ?? 0) + (at?.height ?? 0) / 2) - ((bt?.y ?? 0) + (bt?.height ?? 0) / 2)
        || String(a.id).localeCompare(String(b.id));
    };
    const base = edges.slice().sort(baseCompare);
    const verticalFirst = edges.slice().sort((a, b) => {
      const af = items.get(a.from);
      const at = items.get(a.to);
      const bf = items.get(b.from);
      const bt = items.get(b.to);
      const aSpan = Math.abs(((at?.y ?? 0) + (at?.height ?? 0) / 2) - ((af?.y ?? 0) + (af?.height ?? 0) / 2));
      const bSpan = Math.abs(((bt?.y ?? 0) + (bt?.height ?? 0) / 2) - ((bf?.y ?? 0) + (bf?.height ?? 0) / 2));
      return bSpan - aSpan || baseCompare(a, b);
    });

    // Routing is path-dependent because every accepted edge reserves channels.
    // Evaluate two deterministic orders (normal fan order and long-span first)
    // and keep the globally cleaner result, then rip up and reroute.
    let bestRoutes = yield* buildRouteCandidate(base, ports);
    if (edges.length > 1 && edges.length <= 90 && !budget.exhausted) {
      const other = yield* buildRouteCandidate(verticalFirst, ports);
      if (setScore(scoredRouteSet(other, edgesById)) < setScore(scoredRouteSet(bestRoutes, edgesById))) bestRoutes = other;
    }
    const routes = budget.exhausted ? bestRoutes : yield* improveRouteCandidate(bestRoutes, edges, ports, edgesById);
    routes.stats = { steps: budget.used, cheap: budget.cheap, exhausted: budget.exhausted };
    return routes;
  }

  // Orthogonal routes for `edges` between the cards of `items`
  // (Map id -> { x, y, width, height, lineageRow }), each from the source's
  // right port to the target's left port. options.isSecondary(edge) marks
  // dependency-like edges: routed after the data-flow edges and preferring the
  // lanes between card rows. options.maxSteps bounds the A* relaxations of
  // the whole run and options.searchSteps those of one edge: past them the
  // remaining edges get cheap routes (routes.stats says how many). Returns
  // Map(edge id -> { points, a, b }) with `stats` { steps, cheap, exhausted }.
  function routeEdgesJs(items, edges, options = {}) {
    const steps = routeEdgesSteps(items, edges, options);
    for (;;) {
      const step = steps.next();
      if (step.done) return step.value;
    }
  }

  // routeEdgesJs() is the reference. When the WebAssembly router (src/wasm/router.c) is loaded it answers instead, with the
  // same routes point for point; it hands the run back (null) when it cannot take it, and the reference runs.
  const WASM_ROUTER_MIN_EDGES = 8;
  let routerAsked = false;
  function requestRouterWasm() {
    if (routerAsked || typeof WebAssembly !== "object" || !ns.loader) return;
    routerAsked = true;
    ns.loader.loadGroup("wasm-router").then(() => (ns.wasm && ns.wasm.ops.router ? ns.wasm.load("router") : null)).catch(() => {});
  }

  // Map like routeEdgesJs()'s, or null.
  function routeEdgesWasm(items, edges, options = {}) {
    const kernel = ns.wasm && ns.wasm.get("router");
    if (!kernel || !ns.wasm.ops.router || !ns.wasm.router) return null;
    try {
      const input = ns.wasm.router.pack(items, edges, options);
      if (!input) return null;
      const result = ns.wasm.ops.router.route(kernel, input);
      return result.status === 0 ? ns.wasm.router.unpack(result, items, edges) : null;
    } catch (error) {
      return null;
    }
  }

  function routeEdges(items, edges, options = {}) {
    if (edges.length >= WASM_ROUTER_MIN_EDGES) {
      const routed = routeEdgesWasm(items, edges, options);
      if (routed) return routed;
      requestRouterWasm();
    }
    return routeEdgesJs(items, edges, options);
  }

  // The same router in a Worker, for a run that would hold the page for more than a few frames. Returns { promise, cancel }
  // (the promise resolves with routeEdgesJs()'s Map, or null when the Worker or the kernel is not there or cannot take
  // the run: the caller then runs the reference), or null when the run is too small for the round trip. cancel() drops
  // the answer and stops the Worker.
  const WORKER_ROUTER_MIN_EDGES = 24;
  const routeEdgesJobWanted = (count) => count >= WORKER_ROUTER_MIN_EDGES && typeof WebAssembly === "object" && typeof Worker === "function" && !!ns.loader;
  function routeEdgesJob(items, edges, options = {}) {
    if (!routeEdgesJobWanted(edges.length)) return null;
    let cancelled = false;
    let finished = false;
    let handle = null;
    const promise = (async () => {
      await ns.loader.loadGroup("wasm-router");
      if (cancelled || !ns.wasm || !ns.wasm.supported || !ns.wasm.ops.router || !ns.wasm.router) return null;
      const input = ns.wasm.router.pack(items, edges, options);
      if (!input) return null;
      handle = await ns.wasm.worker("router");
      if (!handle || cancelled) return null;
      const result = await handle.call("route", input, [input.items.buffer, input.edges.buffer]);
      if (cancelled || result.status !== 0) return null;
      return ns.wasm.router.unpack(result, items, edges);
    })().catch(() => null).then((routes) => { finished = true; return routes; });
    return {
      promise,
      cancel() {
        cancelled = true;
        if (handle && !finished) handle.close();
      },
    };
  }

  // The Worker and the kernels get ready while the page idles after a graph mounts, so the first large layout does not wait for
  // them (the Worker stops by itself after a while without work).
  let routerWarm = false;
  function prewarmRouter() {
    if (routerWarm || typeof WebAssembly !== "object" || typeof Worker !== "function" || !ns.loader) return;
    routerWarm = true;
    const start = () => {
      ns.loader.loadGroup("wasm-router").then(() => (ns.wasm && ns.wasm.ops.router ? ns.wasm.worker("router") : null)).catch(() => {});
      requestLayeredWasm();
      requestLabelsWasm();
    };
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(start, { timeout: 1500 });
    else setTimeout(start, 200);
  }

  // routeEdgesSteps() for a generator driven by runSliced(): the Worker answers when it can (the generator waits for it), else
  // the reference runs in slices.
  function* routeEdgesAuto(items, edges, options = {}) {
    const job = routeEdgesJob(items, edges, options);
    if (job) {
      try {
        const routes = yield job.promise;
        if (routes) return routes;
      } finally {
        job.cancel();
      }
    }
    return yield* routeEdgesSteps(items, edges, options);
  }

  // Runs a generator (such as routeEdgesSteps()) in slices of about
  // `sliceMs` of the main thread, the first one at once: returns
  // { done, value } when it finished inside that slice, else
  // { done: false, promise, cancel } (the promise resolves with its value,
  // or with undefined once cancelled).
  function runSliced(steps, { sliceMs = 12 } = {}) {
    // A step may be a promise (a Worker's answer): the run waits for it and hands its value back to the generator.
    let resume;
    const slice = () => {
      const until = performance.now() + sliceMs;
      for (;;) {
        const step = steps.next(resume);
        resume = undefined;
        if (step.done) return step;
        if (step.value && typeof step.value.then === "function") return { waiting: step.value };
        if (performance.now() >= until) return null;
      }
    };
    const first = slice();
    if (first && first.done) return { done: true, value: first.value };
    let cancelled = false;
    let settle = null;
    const promise = new Promise((resolve, reject) => {
      settle = resolve;
      const next = () => {
        if (cancelled) return;
        try {
          advance(slice());
        } catch (error) {
          reject(error);
        }
      };
      const advance = (step) => {
        if (cancelled) return;
        if (step && step.waiting) {
          step.waiting.then((value) => { resume = value; next(); }, () => { next(); });
        } else if (step) resolve(step.value);
        else setTimeout(next, 0);
      };
      if (first && first.waiting) advance(first);
      else setTimeout(next, 0);
    });
    return {
      done: false,
      promise,
      cancel: () => {
        cancelled = true;
        try { steps.return?.(); } catch (error) { /* a generator that is running cannot be closed */ }
        settle(undefined);
      },
    };
  }

  // ------------------------------------------------------------ edge labels

  // Label positions to try, best first:
  //   1. on the line: the middle of each horizontal run (the gaps between
  //      columns), longest first, with its thirds on long runs; then the
  //      middle (and thirds) of each vertical run;
  //   2. on the line, densely: every 14 px along every segment;
  //   3. beside the line: those points shifted just above / below a
  //      horizontal segment, or left / right of a vertical one;
  //   4. the middle of the route.
  // Dense layouts (sub-columns 28 px apart) still find a free spot for most
  // labels without covering a card or another label.
  // visitLabelAnchors() calls visit(x, y) on each position in that order
  // until it returns true (then returns true): most labels fit on one of the
  // first, the dropped ones of a dense map try hundreds, so they are made one
  // at a time, without a list or a box per position.
  function visitLabelAnchors(points, labelHeight, labelWidth, visit) {
    if (!Array.isArray(points) || points.length < 2) return false;
    const runs = [];
    const verticals = [];
    const dense = [];
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      const horizontal = Math.abs(a.y - b.y) <= 0.5;
      const vertical = Math.abs(a.x - b.x) <= 0.5;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (horizontal && length >= 36) {
        runs.push({ length, x: (a.x + b.x) / 2, y: a.y });
        // Long runs also offer their thirds, so siblings sharing the first
        // part of a fan do not all compete for the same middle.
        if (length >= 150) {
          runs.push({ length: length - 1, x: a.x + (b.x - a.x) * 0.72, y: a.y });
          runs.push({ length: length - 2, x: a.x + (b.x - a.x) * 0.28, y: a.y });
        }
      } else if (vertical && length >= labelHeight + 16) {
        verticals.push({ length, x: a.x, y: (a.y + b.y) / 2 });
        if (length >= 120) {
          verticals.push({ length: length - 1, x: a.x, y: a.y + (b.y - a.y) * 0.3 });
          verticals.push({ length: length - 2, x: a.x, y: a.y + (b.y - a.y) * 0.7 });
        }
      }
      if ((horizontal || vertical) && length >= 12) {
        for (let at = 6; at <= length - 6; at += 14) {
          const t = at / length;
          dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, horizontal });
        }
      }
    }
    runs.sort((p, q) => q.length - p.length);
    verticals.sort((p, q) => q.length - p.length);
    for (const run of runs) if (visit(run.x, run.y)) return true;
    for (const run of verticals) if (visit(run.x, run.y)) return true;
    for (const point of dense) if (visit(point.x, point.y)) return true;
    const dy = labelHeight / 2 + 3;
    const dx = labelWidth / 2 + 3;
    for (const run of runs) if (visit(run.x, run.y - dy) || visit(run.x, run.y + dy)) return true;
    for (const run of verticals) if (visit(run.x + dx, run.y) || visit(run.x - dx, run.y)) return true;
    for (const point of dense) {
      if (point.horizontal ? visit(point.x, point.y - dy) || visit(point.x, point.y + dy) : visit(point.x + dx, point.y) || visit(point.x - dx, point.y)) return true;
    }
    const middle = routePoint(points, 0.5);
    return visit(middle.x, middle.y);
  }

  // The positions of visitLabelAnchors() as a list of { x, y }.
  function labelAnchors(points, labelHeight = 18, labelWidth = 40) {
    const anchors = [];
    visitLabelAnchors(points, labelHeight, labelWidth, (x, y) => { anchors.push({ x, y }); return false; });
    return anchors;
  }

  // Cells are keyed by a number (column * 2^21 + row, distinct while rows
  // stay within 2^20 cells; two cells sharing a key would only be tested
  // together), not a string per probe: a dense map tries thousands of
  // anchors.
  function createRectIndex(cell = 160) {
    const cells = new Map();
    const ROW = 2 ** 21;
    // rectsOverlap({ x, y, width, height }, other, padding) for each rectangle
    // of the cell.
    const hitsCell = (key, x, y, width, height, padding) => {
      const list = cells.get(key);
      if (!list) return false;
      for (let i = 0; i < list.length; i += 1) {
        const b = list[i];
        if (!(x + width + padding <= b.x || b.x + b.width + padding <= x || y + height + padding <= b.y || b.y + b.height + padding <= y)) return true;
      }
      return false;
    };
    return {
      add(rect) {
        const x0 = Math.floor(rect.x / cell);
        const x1 = Math.floor((rect.x + rect.width) / cell);
        const y0 = Math.floor(rect.y / cell);
        const y1 = Math.floor((rect.y + rect.height) / cell);
        for (let x = x0; x <= x1; x += 1) {
          for (let y = y0; y <= y1; y += 1) {
            const key = x * ROW + y;
            const list = cells.get(key);
            if (list) list.push(rect); else cells.set(key, [rect]);
          }
        }
      },
      // Whether the rectangle (x, y, width, height) comes closer than
      // `padding` to one of the index (rectsOverlap()).
      hits(x, y, width, height, padding) {
        // The cells of the rectangle grown by `padding`.
        const x0 = Math.floor((x - padding) / cell);
        const x1 = Math.floor((x - padding + (width + padding * 2)) / cell);
        const y0 = Math.floor((y - padding) / cell);
        const y1 = Math.floor((y - padding + (height + padding * 2)) / cell);
        for (let column = x0; column <= x1; column += 1) {
          for (let row = y0; row <= y1; row += 1) if (hitsCell(column * ROW + row, x, y, width, height, padding)) return true;
        }
        return false;
      },
    };
  }

  // Places every label once per layout, in priority order, at the first
  // anchor that covers neither a card nor another label. The placement never
  // depends on hover or selection (a highlighted label is only drawn in its
  // highlight style where it was placed), so labels never jump nor overlap.
  //   requests = [{ key, text, width, height = 18, points }]
  // Returns { placed: Map(key -> rect), dropped: [key] }.
  const WASM_LABELS_MIN_REQUESTS = 30;
  let labelsAsked = false;
  function requestLabelsWasm() {
    if (labelsAsked || typeof WebAssembly !== "object" || !ns.loader) return;
    labelsAsked = true;
    ns.loader.loadGroup("wasm-labels").then(() => (ns.wasm && ns.wasm.ops.labels ? ns.wasm.load("labels") : null)).catch(() => {});
  }

  // placeLabelsJs() is the reference; a long list goes to the WebAssembly placement (src/wasm/labels.c) once it is loaded: the
  // same rectangles, the same dropped labels.
  function placeLabels(requests, obstacles) {
    if (requests.length >= WASM_LABELS_MIN_REQUESTS) {
      const kernel = ns.wasm && ns.wasm.get("labels");
      if (!kernel || !ns.wasm.ops.labels || !ns.wasm.labels) requestLabelsWasm();
      else {
        try {
          const result = ns.wasm.ops.labels.run(kernel, ns.wasm.labels.pack(requests, obstacles));
          if (result.status === 0) return ns.wasm.labels.unpack(requests, result);
        } catch (error) {
          // the reference answers
        }
      }
    }
    return placeLabelsJs(requests, obstacles);
  }

  function placeLabelsJs(requests, obstacles) {
    const cards = createRectIndex();
    for (const rect of obstacles) cards.add(rect);
    const labels = createRectIndex();
    const placed = new Map();
    const dropped = [];
    for (const request of requests) {
      const width = request.width;
      const height = request.height || 18;
      let rect = null;
      visitLabelAnchors(request.points, height, width, (ax, ay) => {
        const x = ax - width / 2;
        const y = ay - height / 2;
        if (cards.hits(x, y, width, height, 2) || labels.hits(x, y, width, height, 3)) return false;
        rect = { x, y, width, height };
        return true;
      });
      if (!rect) { dropped.push(request.key); continue; }
      labels.add(rect);
      placed.set(request.key, rect);
    }
    return { placed, dropped };
  }

  function drawLabel(ctx, rect, text, { highlighted = false, alpha = 1, textColor = null } = {}) {
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(ctx, rect.x, rect.y, rect.width, rect.height, rect.height / 2);
    ctx.fillStyle = color("labelBg");
    ctx.fill();
    ctx.strokeStyle = highlighted ? color("halo") : color("border");
    ctx.lineWidth = highlighted ? 1.4 : 0.9;
    ctx.stroke();
    ctx.fillStyle = textColor || (highlighted ? color("accentText") : color("muted"));
    ctx.textAlign = "center";
    ctx.fillText(text, rect.x + rect.width / 2, rect.y + rect.height / 2 + 4.5);
    ctx.textAlign = "left";
    ctx.restore();
  }

  // ---------------------------------------------------------------- minimap

  // Is any part of a card outside the viewport? One pixel is enough to make
  // the minimap useful.
  function anyClipped(rects, view, width, height) {
    if (!width || !height || !(view.scale > 0)) return false;
    const epsilon = 0.5;
    for (const item of rects) {
      const left = item.x * view.scale + view.offsetX;
      const top = item.y * view.scale + view.offsetY;
      const right = (item.x + item.width) * view.scale + view.offsetX;
      const bottom = (item.y + item.height) * view.scale + view.offsetY;
      if (left < -epsilon || top < -epsilon || right > width + epsilon || bottom > height + epsilon) return true;
    }
    return false;
  }

  // The whole graph in the corner: routed edges with their dash pattern,
  // cards, and the viewport rectangle.
  //   options = { bounds, nodes: [{ x, y, width, height, alpha }],
  //               edges: [{ points, dash, width, color }], view, width, height }
  function drawMinimap(canvas, options) {
    const ctx = canvas?.getContext?.("2d");
    const bounds = options.bounds;
    if (!ctx || !bounds) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color("minimapBg");
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min((width - 12) / bounds.width, (height - 12) / bounds.height);
    const ox = 6 - bounds.x * scale;
    const oy = 6 - bounds.y * scale;
    ctx.save();
    ctx.globalAlpha = 0.48;
    for (const edge of options.edges || []) {
      const points = edge.points;
      if (!Array.isArray(points) || points.length < 2) continue;
      const mapped = points.map((point) => ({ x: ox + point.x * scale, y: oy + point.y * scale }));
      ctx.strokeStyle = edge.color || color("edge");
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = Math.max(0.7, Math.min(1.4, edge.width || 1));
      ctx.setLineDash((edge.dash || []).map((value) => Math.max(1, value * Math.max(0.25, scale))));
      strokePolyline(ctx, mapped);
      ctx.setLineDash([]);
      const tip = mapped[mapped.length - 1];
      const near = mapped[mapped.length - 2];
      const angle = Math.atan2(tip.y - near.y, tip.x - near.x);
      const arrow = 3;
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x - arrow * Math.cos(angle - 0.55), tip.y - arrow * Math.sin(angle - 0.55));
      ctx.lineTo(tip.x - arrow * Math.cos(angle + 0.55), tip.y - arrow * Math.sin(angle + 0.55));
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = color("muted");
    for (const item of options.nodes || []) {
      ctx.globalAlpha = item.alpha ?? 0.62;
      ctx.fillRect(ox + item.x * scale, oy + item.y * scale, Math.max(2, item.width * scale), Math.max(2, item.height * scale));
    }
    ctx.globalAlpha = 1;
    const view = options.view;
    if (view && view.scale > 0) {
      const x = ox + (-view.offsetX / view.scale) * scale;
      const y = oy + (-view.offsetY / view.scale) * scale;
      const w = (options.width / view.scale) * scale;
      const h = (options.height / view.scale) * scale;
      ctx.fillStyle = color("minimapViewFill");
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = color("minimapView");
      ctx.lineWidth = isLight() ? 1.6 : 1;
      ctx.strokeRect(x, y, w, h);
    }
  }

  // ------------------------------------------------------------- the view

  // The part of a graph canvas its own chrome leaves free, in CSS pixels from
  // the canvas' top-left corner: below the toolbar groups, above the legend /
  // status dock, and beside an open side panel (left of it on desktop, above
  // the bottom sheet on phones). Fit and recentring aim at this area, so
  // cards and edge labels do not land under the chrome. The bands span the
  // whole width: the dock sits in a corner, where a centred graph would
  // otherwise reach it, and its band also clears the minimap's corner (the
  // minimap only shows once the graph is clipped, so a fit never needs it).
  const SAFE_GAP = 8;
  function safeArea(canvas, { panel = null } = {}) {
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect || !rect.width || !rect.height) return { x: 0, y: 0, width: rect?.width || 0, height: rect?.height || 0 };
    const pane = canvas.parentElement;
    const shown = (node) => !!node && !node.hidden && node.getClientRects().length > 0;
    let top = 0;
    let bottom = rect.height;
    let right = rect.width;
    const bar = $(":scope > .graphKitBar", pane);
    for (const group of bar?.children || []) {
      if (shown(group)) top = Math.max(top, group.getBoundingClientRect().bottom - rect.top + SAFE_GAP);
    }
    const dock = $(":scope > .graphKitDock", pane);
    if (shown(dock)) {
      const box = dock.getBoundingClientRect();
      if (box.height > 0) bottom = Math.min(bottom, box.top - rect.top - SAFE_GAP);
    }
    if (panel && panel.width && panel.height) {
      if (mobileLayout()) bottom = Math.min(bottom, panel.top - rect.top);
      else right = Math.min(right, panel.left - rect.left);
    }
    // A tiny canvas keeps a usable area (the chrome then overlaps).
    top = Math.min(Math.max(0, top), rect.height * 0.4);
    bottom = Math.max(bottom, top + Math.min(80, rect.height - top));
    right = Math.max(right, Math.min(rect.width, 120));
    return { x: 0, y: top, width: right, height: bottom - top };
  }

  // The visible canvas a recentring aims at: the safe area, also clear of
  // the minimap when it shows (bottom-right, left of an open panel). Its
  // band spans the width, like the dock's. A fit keeps safeArea(): the
  // minimap only shows once the graph is clipped.
  function visibleArea(canvas, { panel = null } = {}) {
    const area = safeArea(canvas, { panel });
    const minimap = $(":scope > .graphKitMinimap", canvas?.parentElement);
    if (!minimap || minimap.hidden || !minimap.getClientRects().length) return area;
    const rect = canvas.getBoundingClientRect();
    const box = minimap.getBoundingClientRect();
    if (!(box.height > 0) || box.left - rect.left >= area.x + area.width) return area;
    const bottom = Math.max(area.y + Math.min(80, area.height), Math.min(area.y + area.height, box.top - rect.top - SAFE_GAP));
    return { ...area, height: bottom - area.y };
  }

  // The scale a Fit opens at. `overview` is the scale of the whole graph in
  // the free area (the bounds into safeArea()), `readable` the one keeping
  // the card text at 11 px.
  // - A graph readable as a whole opens whole: nothing clipped, no minimap.
  // - One that would need a little less (overview >= FIT_READABLE_SHARE of
  //   readable) opens at the readable scale on its root or focus, the
  //   minimap giving the rest: shrinking it would only turn its cards
  //   compact for a few clipped pixels.
  // - A much larger one opens whole with compact cards (a map of titles),
  //   down to FIT_FLOOR; past it, at the readable scale on its anchor.
  // - On a phone (`phone`): the whole graph when it stays at PHONE_MIN_SCALE
  //   or more, else the anchor and its neighbours (`local`, their own fit
  //   scale) between PHONE_MIN_SCALE and the readable scale; the rest pans.
  const FIT_FLOOR = 0.25;
  const FIT_READABLE_SHARE = 0.6;
  const PHONE_MIN_SCALE = 0.7;
  function fitScale(overview, readable, { phone = false, local = null } = {}) {
    if (!(overview > 0)) return readable;
    if (overview >= readable - 1e-9) return overview;
    if (phone) {
      const floor = Math.min(readable, PHONE_MIN_SCALE);
      if (overview >= floor - 1e-9) return overview;
      return Math.max(floor, Math.min(readable, local > 0 ? local : floor));
    }
    if (overview >= readable * FIT_READABLE_SHARE - 1e-9) return readable;
    return overview >= FIT_FLOOR - 1e-9 ? overview : readable;
  }

  // The view a Fit opens at, in the free area of `canvas` (safeArea()):
  //   bounds: the world box of the whole graph; overview: its scale there
  //   (the caller's cap applied); readable: see fitScale();
  //   anchor: the world box of the root / focus card, or null (the graph's
  //   top-left corner); corner: put the anchor's top-left corner at the top-
  //   left of the free area instead of centring it;
  //   neighbourhood: the world box of the anchor and its neighbours (what a
  //   phone fits).
  // Returns { scale, offsetX, offsetY, overview, whole } (whole: the whole
  // graph is in view).
  function fitView(canvas, { bounds, overview, readable, anchor = null, corner = false, neighbourhood = null, maxScale = 1.35, margin = 0.92 } = {}) {
    const area = safeArea(canvas);
    if (!bounds || !(area.width > 0) || !(area.height > 0)) return null;
    const phone = mobileLayout();
    const focus = phone && neighbourhood ? neighbourhood : anchor;
    const local = focus
      ? Math.min(maxScale, Math.min(area.width / Math.max(1, focus.width), area.height / Math.max(1, focus.height)) * margin)
      : null;
    const scale = fitScale(overview, readable, { phone, local });
    const whole = scale <= overview + 1e-9;
    // Per axis: a graph smaller than the free area is centred. A larger one
    // is centred too, then moved just enough to keep the first box of
    // `keep` that fits wholly in view (a phone's neighbourhood, else the
    // anchor; the anchor centred when neither fits), and its own edges never
    // come inside the area (no empty canvas past the graph). Without an
    // anchor (or with `corner`) it starts at the area's top-left corner.
    const keep = [phone ? neighbourhood : null, anchor].filter(Boolean);
    const axis = (start, length, from, size, pick) => {
      const centred = start + length / 2 - (from + size / 2) * scale;
      if (size * scale <= length) return centred;
      let offset = centred;
      if (!keep.length) {
        offset = start - from * scale;
      } else if (corner) {
        const [boxFrom] = pick(keep[0]);
        offset = start + 16 - boxFrom * scale;
      } else {
        const fitting = keep.find((box) => pick(box)[1] * scale <= length);
        if (fitting) {
          const [boxFrom, boxSize] = pick(fitting);
          const pad = Math.min(16, (length - boxSize * scale) / 2);
          offset = Math.min(start + length - pad - (boxFrom + boxSize) * scale, Math.max(start + pad - boxFrom * scale, offset));
        } else {
          const [boxFrom, boxSize] = pick(keep[keep.length - 1]);
          offset = start + length / 2 - (boxFrom + boxSize / 2) * scale;
        }
      }
      return Math.max(start + length - (from + size) * scale, Math.min(start - from * scale, offset));
    };
    const offsetX = axis(area.x, area.width, bounds.x, bounds.width, (box) => [box.x, box.width]);
    const offsetY = axis(area.y, area.height, bounds.y, bounds.height, (box) => [box.y, box.height]);
    return { scale, offsetX, offsetY, overview, whole };
  }

  // Fit transform of a world box into a width x height viewport, or into
  // `area` (a safeArea() rectangle) when given.
  function fitTransform(bounds, width, height, { maxScale = 1.35, minScale = MIN_SCALE, margin = 0.92, area = null } = {}) {
    if (!bounds || !width || !height) return null;
    const box = area && area.width > 0 && area.height > 0 ? area : { x: 0, y: 0, width, height };
    const scale = Math.max(minScale, Math.min(maxScale, Math.min(box.width / bounds.width, box.height / bounds.height) * margin));
    return {
      scale,
      offsetX: box.x + box.width / 2 - (bounds.x + bounds.width / 2) * scale,
      offsetY: box.y + box.height / 2 - (bounds.y + bounds.height / 2) * scale,
    };
  }

  // Keeps at least a margin of the graph inside the viewport.
  function clampView(view, bounds, width, height) {
    if (!bounds || !width || !height || !(view.scale > 0)) return;
    const marginX = Math.min(72, Math.max(24, width * 0.18));
    const marginY = Math.min(72, Math.max(24, height * 0.18));
    const minX = marginX - (bounds.x + bounds.width) * view.scale;
    const maxX = width - marginX - bounds.x * view.scale;
    const minY = marginY - (bounds.y + bounds.height) * view.scale;
    const maxY = height - marginY - bounds.y * view.scale;
    view.offsetX = Math.max(Math.min(minX, maxX), Math.min(Math.max(minX, maxX), view.offsetX));
    view.offsetY = Math.max(Math.min(minY, maxY), Math.min(Math.max(minY, maxY), view.offsetY));
  }

  const KEY_DIRECTIONS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

  // Pan / zoom / keyboard / hover / click controller of one graph canvas.
  //   options = {
  //     canvas, view: { scale, offsetX, offsetY } (mutated in place),
  //     active() -> bool, draw(ctx, frame) -> keep animating?,
  //     bounds() -> world box, minScale() -> number, fit(),
  //     hit(clientX, clientY) -> target { key, type, disabled } | null,
  //     onHover(target), onClick(target, event),
  //     nodes() -> [{ id, x, y, width, height }] (keyboard order),
  //     target(id) -> the hover target of a node, describe(id) -> text,
  //     onActivate(id), onEscape() -> handled?, onViewChange(kind),
  //     panelRect() -> DOMRect of an open side panel or null,
  //     panel() -> the side panel element (follow() watches its size),
  //     toolbar: { zoomIn, zoomOut, fit }, onResize(), clamp: bool }
  //
  // follow(id) centres node `id` in the visible canvas (visibleArea: clear
  // of the toolbar, the legend / status dock, the minimap and an open
  // panel) once the panel's size has settled, and again each time that
  // area changes: the panel opening, growing as its content arrives or
  // closing, the canvas resizing. "Settled" is event driven: a
  // ResizeObserver on the canvas and the panel, and the end of the panel's
  // running transitions or animations (getAnimations().finished), never a
  // timer. A pan, a zoom, a fit, a keyboard move or unfollow() ends it.
  function mount(options) {
    prewarmRouter();
    const canvas = options.canvas;
    const view = options.view;
    const control = { frame: 0, drag: null, pinch: null, hovered: null, keyboardId: null, animation: 0, follow: null, settleFrame: 0, watched: null };
    const live = document.createElement("p");
    live.className = "srOnly";
    live.setAttribute("aria-live", "polite");
    canvas.parentElement?.append(live);
    canvas.classList.add("graphKit__canvas");

    const active = () => (options.active ? options.active() : true);
    const size = () => canvasSize(canvas);
    const minScale = () => Math.max(MIN_SCALE * 0.5, Number(options.minScale?.()) || MIN_SCALE);
    const clamp = () => {
      if (options.clamp === false) return;
      const { width, height } = canvas.getBoundingClientRect();
      clampView(view, options.bounds?.(), width, height);
    };

    function draw(now = performance.now()) {
      control.frame = 0;
      if (!active()) return;
      const { width, height, dpr } = size();
      if (!width || !height) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      drawBackground(ctx, view, width, height, dpr);
      const animate = options.draw(ctx, { width, height, dpr, now, keyboardId: control.keyboardId });
      if (animate && active() && !control.frame) control.frame = requestAnimationFrame(draw);
    }

    function scheduleDraw() {
      if (!active() || control.frame) return;
      control.frame = requestAnimationFrame(draw);
    }

    function cancel() {
      if (control.frame) cancelAnimationFrame(control.frame);
      control.frame = 0;
      stopAnimation();
    }

    function drawNow() {
      if (control.frame) cancelAnimationFrame(control.frame);
      control.frame = 0;
      draw(performance.now());
    }

    function changed(kind) {
      // The viewer moved the camera: the followed node stays where it is.
      if (kind === "pan" || kind === "zoom") unfollow();
      options.onViewChange?.(kind);
      scheduleDraw();
    }

    function zoomAt(factor, px, py) {
      stopAnimation();
      const before = { x: (px - view.offsetX) / view.scale, y: (py - view.offsetY) / view.scale };
      view.scale = Math.max(minScale(), Math.min(MAX_SCALE, view.scale * factor));
      view.offsetX = px - before.x * view.scale;
      view.offsetY = py - before.y * view.scale;
      clamp();
      changed("zoom");
    }

    function zoomBy(factor) {
      const rect = canvas.getBoundingClientRect();
      zoomAt(factor, rect.width / 2, rect.height / 2);
    }

    function stopAnimation() {
      if (control.animation) cancelAnimationFrame(control.animation);
      control.animation = 0;
    }

    const panelRect = () => {
      if (options.panelRect) return options.panelRect() || null;
      const panel = options.panel?.();
      return panel && !panel.hidden ? panel.getBoundingClientRect() : null;
    };

    // Pans so that a world box sits in the middle of the visible canvas: the
    // canvas minus its chrome (toolbar, legend / status dock, minimap; see
    // visibleArea) and an open side panel (on the right on desktop, a bottom
    // sheet on phones). Eased over 220 ms unless reduced motion is preferred.
    function centerOn(box, { animate = true } = {}) {
      if (!box) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const free = visibleArea(canvas, { panel: panelRect() });
      const target = {
        offsetX: free.x + free.width / 2 - (box.x + box.width / 2) * view.scale,
        offsetY: free.y + free.height / 2 - (box.y + box.height / 2) * view.scale,
      };
      const saved = { offsetX: view.offsetX, offsetY: view.offsetY };
      view.offsetX = target.offsetX;
      view.offsetY = target.offsetY;
      clamp();
      target.offsetX = view.offsetX;
      target.offsetY = view.offsetY;
      stopAnimation();
      if (!animate || reducedMotion() || Math.hypot(target.offsetX - saved.offsetX, target.offsetY - saved.offsetY) < 2) {
        changed("center");
        return;
      }
      view.offsetX = saved.offsetX;
      view.offsetY = saved.offsetY;
      const started = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - started) / 220);
        const eased = 1 - (1 - t) ** 3;
        view.offsetX = saved.offsetX + (target.offsetX - saved.offsetX) * eased;
        view.offsetY = saved.offsetY + (target.offsetY - saved.offsetY) * eased;
        control.animation = t < 1 ? requestAnimationFrame(step) : 0;
        changed("center");
        // The camera came to rest: a follow checks its area again (the
        // minimap may have shown or hidden on the way).
        if (!control.animation) requestSettle();
      };
      control.animation = requestAnimationFrame(step);
    }

    // ---- follow: the selected node centred once the panel has settled.
    const settleObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => requestSettle()) : null;
    settleObserver?.observe(canvas);

    function follow(id) {
      if (id == null || id === "") { unfollow(); return; }
      control.follow = { id, key: "", safeKey: "", flips: 0 };
      watchPanel();
      requestSettle();
    }

    function unfollow() {
      control.follow = null;
      if (control.settleFrame) cancelAnimationFrame(control.settleFrame);
      control.settleFrame = 0;
    }

    // The panel element can be created after mount (or replaced): observe
    // the current one. The toolbar and the legend / status dock bound the
    // visible area too (a legend folding or unfolding moves its centre), and
    // so does the minimap, which shows or hides with the camera itself: a
    // follow re-centres for it at most twice (settle), so the two cannot
    // chase each other.
    const chrome = new Set();
    const minimapObserver = typeof MutationObserver === "function" ? new MutationObserver(() => requestSettle()) : null;
    function watchPanel() {
      if (!settleObserver) return;
      const pane = canvas.parentElement;
      for (const part of [$(":scope > .graphKitBar", pane), $(":scope > .graphKitDock", pane)]) {
        if (part && !chrome.has(part)) { chrome.add(part); settleObserver.observe(part); }
      }
      const minimap = $(":scope > .graphKitMinimap", pane);
      if (minimap && minimapObserver && !chrome.has(minimap)) {
        chrome.add(minimap);
        minimapObserver.observe(minimap, { attributes: true, attributeFilter: ["hidden"] });
      }
      const panel = options.panel?.() || null;
      if (panel === control.watched) return;
      if (control.watched) settleObserver.unobserve(control.watched);
      control.watched = panel;
      if (panel) settleObserver.observe(panel);
    }

    // A frame after a change (the panel's layout is then known), unless the
    // panel is still moving: then once its transitions / animations end.
    function requestSettle() {
      if (!control.follow || control.settleFrame) return;
      control.settleFrame = requestAnimationFrame(settle);
    }

    function settle() {
      control.settleFrame = 0;
      const follow = control.follow;
      // The camera is easing: the end of its move asks again.
      if (!follow || !active() || control.animation) return;
      const panel = options.panel?.() || null;
      const moving = panel && !panel.hidden && typeof panel.getAnimations === "function"
        ? panel.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running" || animation.playState === "pending")
        : [];
      if (moving.length) {
        Promise.all(moving.map((animation) => animation.finished.catch(() => null))).then(() => {
          if (control.follow === follow) requestSettle();
        });
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const panelBox = panelRect();
      const keyOf = (area) => [rect.width, rect.height, area.x, area.y, area.width, area.height].map((value) => Math.round(value)).join(",");
      const key = keyOf(visibleArea(canvas, { panel: panelBox }));
      if (key === follow.key) return;
      const safeKey = keyOf(safeArea(canvas, { panel: panelBox }));
      // Only the minimap changed (it follows the camera): twice at most.
      if (follow.key && safeKey === follow.safeKey) {
        follow.flips += 1;
        if (follow.flips > 2) return;
      }
      const node = (options.nodes?.() || []).find((candidate) => candidate.id === follow.id);
      if (!node) return;
      follow.key = key;
      follow.safeKey = safeKey;
      centerOn(node);
    }

    function boxOnScreen(box, padding = 18) {
      const rect = canvas.getBoundingClientRect();
      const left = box.x * view.scale + view.offsetX;
      const top = box.y * view.scale + view.offsetY;
      return left >= padding && top >= padding
        && left + box.width * view.scale <= rect.width - padding
        && top + box.height * view.scale <= rect.height - padding;
    }

    function setCursor(target) {
      canvas.classList.toggle("is-clickable", !control.drag && !!target && !target.disabled);
      canvas.classList.toggle("is-disabled", !control.drag && !!target && !!target.disabled);
    }

    function setHover(target) {
      const key = target?.key ?? null;
      const previous = control.hovered?.key ?? null;
      control.hovered = target || null;
      setCursor(target);
      if (key === previous) return;
      options.onHover?.(target || null);
      scheduleDraw();
    }

    // Arrow keys: the nearest node in that direction (angle-weighted), or the
    // node nearest to the viewport centre when none has the keyboard yet.
    function moveKeyboard(dx, dy) {
      const nodes = options.nodes?.() || [];
      if (!nodes.length) return;
      const centre = (node) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 });
      const current = nodes.find((node) => node.id === control.keyboardId) || null;
      // The first arrow lands on the selected node (or the one nearest to the
      // viewport centre); the next ones move.
      let next = current ? null : nodes.find((node) => node.id === options.selectedId?.()) || null;
      if (next) {
        focusNode(next.id);
        return;
      }
      if (!current) {
        const rect = canvas.getBoundingClientRect();
        const world = { x: (rect.width / 2 - view.offsetX) / view.scale, y: (rect.height / 2 - view.offsetY) / view.scale };
        let best = Infinity;
        for (const node of nodes) {
          const c = centre(node);
          const distance = Math.hypot(c.x - world.x, c.y - world.y);
          if (distance < best) { best = distance; next = node; }
        }
      } else {
        const from = centre(current);
        let best = Infinity;
        for (const node of nodes) {
          if (node === current) continue;
          const c = centre(node);
          const along = (c.x - from.x) * dx + (c.y - from.y) * dy;
          if (along <= 1) continue;
          const across = Math.abs((c.x - from.x) * dy - (c.y - from.y) * dx);
          const score = along + across * 2.5;
          if (score < best) { best = score; next = node; }
        }
        if (!next) return;
      }
      if (!next) return;
      focusNode(next.id);
    }

    function focusNode(id) {
      const node = (options.nodes?.() || []).find((candidate) => candidate.id === id);
      if (!node) return;
      control.keyboardId = id;
      if (control.follow && control.follow.id !== id) unfollow();
      setHover(options.target?.(id) || null);
      if (!boxOnScreen(node)) centerOn(node);
      live.textContent = options.describe?.(id) || "";
      scheduleDraw();
    }

    canvas.tabIndex = 0;
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * WHEEL_SPEED), event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    // One pointer pans (a mouse drag or a finger), two fingers pinch-zoom
    // around their midpoint and pan with it; a tap or click that did not move
    // selects. A finger may wander a few pixels during a tap.
    const pointers = new Map();
    const pinchOf = () => {
      const [a, b] = [...pointers.values()];
      const rect = canvas.getBoundingClientRect();
      return { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
    };
    canvas.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      stopAnimation();
      try { canvas.setPointerCapture?.(event.pointerId); } catch (_) { /* a pointer the browser no longer tracks */ }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2) {
        control.pinch = pinchOf();
        if (control.drag) control.drag.moved = true;
        return;
      }
      if (pointers.size > 2) return;
      control.drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, moved: false, slop: event.pointerType === "touch" ? 8 : 2 };
      canvas.classList.remove("is-clickable", "is-disabled");
      canvas.classList.add("is-dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (control.pinch && pointers.size >= 2) {
        const next = pinchOf();
        view.offsetX += next.x - control.pinch.x;
        view.offsetY += next.y - control.pinch.y;
        zoomAt(next.distance / control.pinch.distance, next.x, next.y);
        control.pinch = next;
        return;
      }
      if (control.drag) {
        const dx = event.clientX - control.drag.x;
        const dy = event.clientY - control.drag.y;
        if (Math.hypot(event.clientX - control.drag.startX, event.clientY - control.drag.startY) > control.drag.slop) control.drag.moved = true;
        if (!control.drag.moved) return;
        view.offsetX += dx;
        view.offsetY += dy;
        clamp();
        control.drag.x = event.clientX;
        control.drag.y = event.clientY;
        changed("pan");
        return;
      }
      setHover(options.hit?.(event.clientX, event.clientY) || null);
    });
    const endDrag = (event) => {
      pointers.delete(event.pointerId);
      try { canvas.releasePointerCapture?.(event.pointerId); } catch (_) { /* already released */ }
      if (control.pinch) {
        if (pointers.size >= 2) { control.pinch = pinchOf(); return; }
        control.pinch = null;
        // The finger left on the canvas goes on panning from where it is.
        const [rest] = [...pointers.values()];
        if (rest && control.drag) { control.drag.x = rest.x; control.drag.y = rest.y; }
        if (rest) return;
      }
      const drag = control.drag;
      if (!drag || pointers.size) return;
      control.drag = null;
      canvas.classList.remove("is-dragging");
      const target = options.hit?.(event.clientX, event.clientY) || null;
      setCursor(target);
      if (drag.moved || event.type === "pointercancel") return;
      control.keyboardId = null;
      options.onClick?.(target, event);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => {
      if (!control.drag && !control.keyboardId) setHover(null);
    });
    canvas.addEventListener("keydown", (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const direction = KEY_DIRECTIONS[event.key];
      if (direction) moveKeyboard(direction[0], direction[1]);
      else if (event.key === "+" || event.key === "=") zoomBy(ZOOM_STEP);
      else if (event.key === "-" || event.key === "_") zoomBy(1 / ZOOM_STEP);
      else if (event.key === "0") { unfollow(); options.fit?.(); }
      else if ((event.key === "Enter" || event.key === " ") && control.keyboardId) options.onActivate?.(control.keyboardId);
      else if (event.key === "Escape") {
        // Escape closes the panel first, then leaves the keyboard focus.
        if (options.onEscape?.()) {
          // handled
        } else if (control.keyboardId) {
          control.keyboardId = null;
          setHover(null);
        } else return;
      } else return;
      event.preventDefault();
    });
    canvas.addEventListener("blur", () => {
      if (!control.keyboardId) return;
      control.keyboardId = null;
      setHover(null);
    });

    // The legend folds away from its button in the status line: the fit and
    // the recentring then reclaim its corner.
    legendToggle(canvas.parentElement, () => {
      options.onResize?.();
      scheduleDraw();
    });

    const toolbar = options.toolbar || {};
    toolbar.zoomIn?.addEventListener("click", () => zoomBy(ZOOM_STEP));
    toolbar.zoomOut?.addEventListener("click", () => zoomBy(1 / ZOOM_STEP));
    toolbar.fit?.addEventListener("click", () => { unfollow(); options.fit?.(); });

    if (typeof ResizeObserver === "function") {
      // ResizeObserver already runs once per frame; the redraw itself waits for
      // the next animation frame so resizes coalesce with other changes.
      new ResizeObserver(() => {
        if (!active()) return;
        size();
        options.onResize?.();
        scheduleDraw();
      }).observe(canvas);
    }

    return {
      scheduleDraw,
      drawNow,
      cancel,
      zoomBy,
      zoomAt,
      centerOn,
      follow,
      unfollow,
      following: () => control.follow?.id ?? null,
      focusNode,
      boxOnScreen,
      clamp,
      hovered: () => control.hovered,
      animating: () => !!control.animation,
      keyboardId: () => control.keyboardId,
      clearKeyboard() { control.keyboardId = null; },
      size,
    };
  }

  // ------------------------------------------------------------ DOM chrome


  // Show / hide button of a pane's legend, at the start of its status line.
  // One preference for every graph, kept per viewer (storage is optional):
  // "hidden" folds every legend, "shown" keeps them open; without one, a fit
  // folds the legend when the graph does not fit beside it (see
  // foldLegendToFit) and opens it again once the room is back.
  // "hidden" / "shown" once the user chose; "" until then.
  const legendPref = () => ns.storage.pref(ns.storage.KEYS.graphLegend, "", { allowed: ["hidden", "shown"] });
  let legendSerial = 0;
  const legendControls = new WeakMap();
  function legendPreference() {
    return legendPref().get();
  }
  function legendToggle(pane, onToggle) {
    const dock = $(":scope > .graphKitDock", pane);
    const legend = $(".graphKitLegend", dock);
    const status = $(".graphKitStatus", dock);
    if (!legend || !status || $(".graphKitLegendToggle", status)) return null;
    if (!legend.id) legend.id = `graphKitLegend${(legendSerial += 1)}`;
    const button = h("button", { class: "graphKitLegendToggle" });
    button.type = "button";
    button.setAttribute("aria-controls", legend.id);
    h.replace(button, ns.icon.el("list", { size: "sm" }));
    const preference = legendPreference();
    const control = {
      // The viewer chose (this session or a stored preference): no auto fold.
      chosen: !!preference,
      auto: false,
      collapsed: () => dock.classList.contains("is-legend-collapsed"),
      apply(collapsed) {
        dock.classList.toggle("is-legend-collapsed", collapsed);
        button.setAttribute("aria-expanded", String(!collapsed));
        const label = collapsed ? "Show the legend" : "Hide the legend";
        button.setAttribute("aria-label", label);
        button.title = label;
      },
    };
    control.apply(preference === "hidden");
    button.addEventListener("click", () => {
      const collapsed = !control.collapsed();
      control.apply(collapsed);
      control.chosen = true;
      control.auto = false;
      legendPref().set(collapsed ? "hidden" : "shown");
      onToggle?.();
    });
    status.prepend(button);
    legendControls.set(dock, control);
    return button;
  }

  // Called by a fit before it measures safeArea(): without a viewer's
  // choice, the legend stays open while the whole graph fits the free area
  // at `readableScale` with it, and folds otherwise (the graph needs the
  // room, or is larger than the view and the minimap takes over); it opens
  // again once the graph fits with it. Returns whether the legend is folded.
  function foldLegendToFit(canvas, bounds, { readableScale = 1, margin = 0.92 } = {}) {
    const dock = $(":scope > .graphKitDock", canvas?.parentElement);
    const control = dock ? legendControls.get(dock) : null;
    if (!control || !bounds || control.chosen) return !!control?.collapsed();
    const fits = () => {
      const area = safeArea(canvas);
      return area.width > 0 && area.height > 0
        && Math.min(area.width / bounds.width, area.height / bounds.height) * margin >= readableScale - 1e-9;
    };
    control.apply(false);
    control.auto = !fits();
    control.apply(control.auto);
    return control.auto;
  }

  // Side-panel header: the detail panel shell's head (ns.detailPanel.head:
  // eyebrow, title, subtitle, the one close button), with the graphKitPanel__*
  // names the panel content styles use.
  function panelHeader({ eyebrow, title, subtitle, dot, onClose, closeLabel = "Close details" }) {
    return ns.detailPanel.head({ eyebrow, title, subtitle, dot, onClose, closeLabel, graphKit: true });
  }

  // The floating detail panel over a canvas (ns.detailPanel, layout
  // "floating"): show(body) puts the body's head above it (the head stays
  // while the body scrolls) and opens the panel as an ns.layers layer
  // (Escape closes it, the focus goes back to the canvas); hide() closes it.
  // onClose(reason) runs however it closed.
  function panelShell(panel, { onClose = null, opener = null } = {}) {
    const shell = ns.detailPanel.create({ el: panel, layout: "floating", onClose, returnFocus: opener });
    return {
      shell,
      show(body) {
        const head = $(":scope > .uiDetail__head", body);
        if (head) panel.replaceChildren(head, body);
        else panel.replaceChildren(body);
        shell.open({ opener: typeof opener === "function" ? opener() : opener });
      },
      hide() {
        shell.close("closed", { restoreFocus: false });
        panel.replaceChildren();
      },
      isOpen: () => shell.isOpen(),
    };
  }

  function panelSection(title) {
    const section = h("section", { class: "graphKitPanel__section" });
    if (title) section.append(h("h3", { class: "graphKitPanel__sectionTitle" }, title));
    return section;
  }

  function panelFacts(pairs) {
    const list = h("dl", { class: "graphKitPanel__facts" });
    for (const [label, value] of pairs) {
      if (value == null || value === "") continue;
      list.append(h("dt", null, label), h("dd", null, value));
    }
    return list;
  }

  ns.graphKit = {
    FONT,
    ZOOM_STEP,
    WHEEL_SPEED,
    MAX_SCALE,
    MIN_SCALE,
    GRID_SPACING,
    MOBILE_QUERY,
    DASH,
    LINEAGE_NODE_PORT_TOP_OFFSET,
    ROUTE_GRID_POINT_BUDGET,
    theme: { cssVar, color, resolveColor, isLight, invalidate: invalidateTheme, onChange: (fn) => themeListeners.add(fn) },
    fonts: { onLoad: (fn) => fontListeners.add(fn) },
    color,
    parseColor,
    mixColor,
    dimAlpha,
    reducedMotion,
    mobileLayout,
    canvasSize,
    roundRect,
    ellipsis,
    drawBackground,
    CARD_RADIUS,
    drawCard,
    compactTitleSize,
    COMPACT_CARD_PX,
    MIN_TEXT_PX,
    isCompact,
    compactBox,
    polylineMetric,
    routePoint,
    tracePolyline,
    strokePolyline,
    drawArrowHead,
    distanceToSegment,
    distanceToPolyline,
    pointInRect,
    rectsOverlap,
    layered,
    layeredOrderJs,
    layeredOrderWasm,
    nodePort,
    routeEdges,
    routeEdgesJs,
    routeEdgesWasm,
    routeEdgesJob,
    routeEdgesJobWanted,
    routeEdgesAuto,
    routeEdgesSteps,
    runSliced,
    labelAnchors,
    placeLabels,
    placeLabelsJs,
    drawLabel,
    anyClipped,
    drawMinimap,
    safeArea,
    visibleArea,
    fitTransform,
    fitScale,
    fitView,
    FIT_FLOOR,
    FIT_READABLE_SHARE,
    PHONE_MIN_SCALE,
    clampView,
    mount,
    legendToggle,
    foldLegendToFit,
    panelHeader,
    panelShell,
    panelSection,
    panelFacts,
  };
})();
