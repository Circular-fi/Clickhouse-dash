(() => {
  "use strict";
  // ns.palette: every data colour as a themed CSS token (docs/ui-foundations.md).
  // Each picker returns a var() reference, so DOM colours follow the theme by
  // themselves; resolve() turns one into the colour the current theme
  // computes, for canvas drawing.
  //
  //   categorical(i)  --qchart-1..18: series slots of charts
  //   service(name)   --trace-span-color-1..18 (the same 18 slots): one colour
  //                   per service for the browser session, shared by Traces,
  //                   Logs and Metrics
  //   quantile(p)     --pct-p50/p90/p95/p99
  //   severity(level) --sev-fatal/error/warn/info/debug/trace
  //   sequential(t)   --trace-heat-1..8, t in [0, 1]
  //   kind(kind)      --kind-table/view/mv/dict/buffer/distributed
  //   errorLevel(r)   "neutral" / "warn" / "danger" for an error ratio r
  //   readableText(c) the text token that reads best on a fill c
  const ns = (window.ChDash = window.ChDash || {});

  const CATEGORICAL_SLOTS = 18;
  const SERVICE_SLOTS = 18;
  const SEQUENTIAL_STEPS = 8;
  // The Traces store: the result list, its charts, every opened trace and the
  // Logs view read the same assignment.

  const tokenRef = (name) => `var(${name})`;

  // ----------------------------------------------------------- categorical

  // Series slot i (0-based) of a chart; a negative or non-numeric index is the
  // neutral "Other" slot.
  function categorical(i) {
    const n = Math.trunc(Number(i));
    if (!Number.isFinite(n) || n < 0) return tokenRef("--qchart-other");
    return tokenRef(`--qchart-${(n % CATEGORICAL_SLOTS) + 1}`);
  }

  // -------------------------------------------------------------- services

  // Like Jaeger's ColorGenerator: a service takes the next slot the first
  // time it is seen and keeps it for the browser session (sessionStorage);
  // registerServices(names) assigns a view's services in name order first, so
  // a list and its charts agree whatever order they render in.
  let serviceSlots = null;

  function slots() {
    if (serviceSlots) return serviceSlots;
    serviceSlots = new Map();
    // ns.storage (app_state.js) loads after this module: read it when used.
    // Without session storage the colours last for this page.
    const saved = slotsPref()?.get();
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      for (const [service, slot] of Object.entries(saved)) {
        if (Number.isInteger(slot) && slot >= 0 && slot < SERVICE_SLOTS) serviceSlots.set(service, slot);
      }
    }
    return serviceSlots;
  }

  // ns.storage.KEYS.serviceColors: the Traces assignment, kept for the session.
  const slotsPref = () => {
    const storage = window.ChDash.storage;
    return storage ? storage.pref(storage.KEYS.serviceColors, null, { json: true, session: true }) : null;
  };

  function saveSlots() {
    slotsPref()?.set(Object.fromEntries(slots()));
  }

  const serviceKey = (name) => String(name || "unknown");

  // FNV-1a: the same slot for a name on every page load and browser.
  function hashSlot(name) {
    const text = serviceKey(name);
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash % SERVICE_SLOTS;
  }

  // The 0-based slot of `name`. assign: false looks without assigning: a name
  // not seen yet gets its stable hash slot, and the first-seen order of the
  // view is left as it is.
  function serviceSlot(name, { assign = true } = {}) {
    const key = serviceKey(name);
    const map = slots();
    let slot = map.get(key);
    if (slot != null) return slot;
    if (!assign) return hashSlot(key);
    slot = map.size % SERVICE_SLOTS;
    map.set(key, slot);
    saveSlots();
    return slot;
  }

  function registerServices(names) {
    const sorted = [...new Set([...(names || [])].map(serviceKey))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const map = slots();
    const before = map.size;
    for (const name of sorted) if (!map.has(name)) map.set(name, map.size % SERVICE_SLOTS);
    if (map.size !== before) saveSlots();
  }

  function service(name, options) {
    return tokenRef(`--trace-span-color-${serviceSlot(name, options) + 1}`);
  }

  // -------------------------------------------------------------- quantiles

  const QUANTILES = [50, 90, 95, 99];

  // p50 / p90 / p95 / p99, written "p95", "P95", 95 or 0.95; any other
  // quantile takes the nearest of the four.
  function quantile(p) {
    let value = typeof p === "string" ? Number(p.trim().replace(/^p/i, "")) : Number(p);
    if (!Number.isFinite(value)) return tokenRef("--pct-p50");
    if (value > 0 && value <= 1 && !(typeof p === "string" && /^p/i.test(p.trim()))) value *= 100;
    let best = QUANTILES[0];
    for (const q of QUANTILES) if (Math.abs(q - value) < Math.abs(best - value)) best = q;
    return tokenRef(`--pct-p${best}`);
  }

  // -------------------------------------------------------------- severity

  const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"];

  // The level of an OpenTelemetry SeverityNumber (1-4 trace, 5-8 debug, 9-12
  // info, 13-16 warn, 17-20 error, 21-24 fatal) or SeverityText ("ERROR",
  // "warning", "Critical"...). Unknown text reads as debug.
  function severityLevel(level) {
    const n = typeof level === "number" ? level : /^\s*\d+\s*$/.test(String(level ?? "")) ? Number(level) : 0;
    if (n > 0) return n >= 21 ? "fatal" : n >= 17 ? "error" : n >= 13 ? "warn" : n >= 9 ? "info" : n >= 5 ? "debug" : "trace";
    const text = String(level ?? "").trim().toLowerCase();
    if (!text) return "debug";
    if (/^(fatal|crit|emerg|alert|panic)/.test(text)) return "fatal";
    if (/^err/.test(text)) return "error";
    if (/^warn/.test(text)) return "warn";
    if (/^(info|notice)/.test(text)) return "info";
    if (/^trace/.test(text)) return "trace";
    return "debug";
  }

  function severity(level) {
    return tokenRef(`--sev-${severityLevel(level)}`);
  }

  // ------------------------------------------------------------ sequential

  // Step of the one-hue ramp for t in [0, 1] (low values recede into the surface).
  function sequential(t) {
    const n = Number(t);
    const clamped = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
    return tokenRef(`--trace-heat-${1 + Math.round(clamped * (SEQUENTIAL_STEPS - 1))}`);
  }

  // ------------------------------------------------------------ error rate

  // One set of error-rate thresholds for every view (service map cards,
  // dots and edges, the Services table, panels and sparklines): below 1 % is
  // neutral, 1 % up to 5 % a warning, 5 % and more danger.
  const ERROR_RATE = Object.freeze({ warn: 0.01, danger: 0.05 });

  // The level of an error ratio (errors / requests, 1 = 100 %).
  function errorLevel(ratio) {
    const r = Number(ratio);
    if (!(r >= ERROR_RATE.warn)) return "neutral";
    return r >= ERROR_RATE.danger ? "danger" : "warn";
  }

  // The colour of that level: null (neutral), var(--warning) or var(--danger).
  function errorColor(ratio) {
    const level = errorLevel(ratio);
    return level === "neutral" ? null : tokenRef(level === "danger" ? "--danger" : "--warning");
  }

  // ------------------------------------------------------------------ kind

  // Catalog object kinds, by kind or engine name: "view", "MaterializedView",
  // "dictionary", "Buffer", "Distributed"... Every other engine is a table.
  const KIND_ALIASES = {
    table: "table", view: "view", mv: "mv", materializedview: "mv", materialized_view: "mv",
    dict: "dict", dictionary: "dict", buffer: "buffer", distributed: "distributed",
  };

  function kindName(kind) {
    const key = String(kind || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
    return KIND_ALIASES[key] || KIND_ALIASES[key.replace(/_/g, "")] || "table";
  }

  function kind(value) {
    return tokenRef(`--kind-${kindName(value)}`);
  }

  // ---------------------------------------------------------------- resolve

  // The colour a token computes to in the current theme, as "rgb(r, g, b)" or
  // "rgba(r, g, b, a)" (canvas cannot read var()). Accepts "--qchart-1", "var(--qchart-1)"
  // or any CSS colour. Values are cached until the theme changes: the forced
  // theme (html[data-theme]) or, in System mode, the OS colour scheme.
  const cache = new Map();
  let cacheTheme = "";
  let probe = null;
  let lightQuery = null;

  function themeKey() {
    const html = document.documentElement;
    if (!lightQuery && typeof window.matchMedia === "function") lightQuery = window.matchMedia("(prefers-color-scheme: light)");
    return `${html.getAttribute("data-theme") || "system"}:${lightQuery && lightQuery.matches ? "light" : "dark"}`;
  }

  function normalize(text) {
    const value = String(text || "").trim();
    let m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(value);
    let c = null;
    if (m) {
      const a = m[4] == null ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      c = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
    } else if ((m = /^color\(srgb\s+([\d.e-]+)\s+([\d.e-]+)\s+([\d.e-]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(value))) {
      const a = m[4] == null ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
      c = { r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255, a };
    }
    if (!c) return value;
    const ch = (v) => Math.max(0, Math.min(255, Math.round(v)));
    const alpha = +Math.max(0, Math.min(1, c.a)).toFixed(3);
    return alpha >= 1 ? `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})` : `rgba(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)}, ${alpha})`;
  }

  function resolve(token) {
    const raw = String(token || "").trim();
    if (!raw) return "";
    const expr = raw.startsWith("--") ? `var(${raw})` : raw;
    const key = themeKey();
    if (key !== cacheTheme) {
      cache.clear();
      cacheTheme = key;
    }
    if (cache.has(expr)) return cache.get(expr);
    if (!probe || !probe.isConnected) {
      probe = document.createElement("i");
      probe.setAttribute("aria-hidden", "true");
      probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
      document.documentElement.appendChild(probe);
    }
    probe.style.color = "";
    probe.style.color = expr;
    const value = probe.style.color ? normalize(getComputedStyle(probe).color) : "";
    cache.set(expr, value);
    return value;
  }

  // ------------------------------------------------------------- contrast

  // WCAG 2 relative luminance of a resolved colour (alpha ignored: pass a
  // colour that is opaque on its surface, a color-mix() with it for one).
  function luminance(token) {
    const m = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(resolve(token));
    if (!m) return NaN;
    const channel = (v) => {
      const c = Number(v) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(m[1]) + 0.7152 * channel(m[2]) + 0.0722 * channel(m[3]);
  }

  // The WCAG contrast ratio of two colours (tokens or CSS colours).
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    if (!Number.isFinite(la) || !Number.isFinite(lb)) return NaN;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // The label colour for text on `fill`: white (--on-fill) or ink
  // (--on-fill-dark), whichever contrasts more, so a label on any service
  // colour passes WCAG in both themes.
  const LABELS = ["--on-fill", "--on-fill-dark"];
  function readableText(fill) {
    const [light, dark] = LABELS.map((name) => contrast(fill, name));
    return tokenRef(dark > light ? LABELS[1] : LABELS[0]);
  }

  // ------------------------------------------------- WebAssembly batches
  // The arithmetic of the pickers above, for many items at once, on src/wasm/color.c (docs/wasm.md). Each *Batch gives what the
  // matching single function gives for each item, byte for byte (tests/frontend/specs/wasm-color.spec.js). A short batch, a
  // missing kernel (it loads on the first long batch) and the items the kernel hands back are answered by the single function.
  // The resolving of a token stays here: the browser does it.
  // The fewest items of a batch that go to the kernel, per op: about where the kernel stops costing more than the single function
  // (the measures are in docs/wasm.md); a shorter batch runs the single function.
  const COLOR_MIN_ITEMS = Object.freeze({ normalize: 200, readable: 500, hashSlots: 2000, steps: 4000, categorical: 4000, parseChart: 2000, rgba: 4000, mix: 2000 });
  let colorAsked = false;

  function requestColorKernel() {
    if (colorAsked || !ns.wasm || !ns.wasm.supported) return;
    colorAsked = true;
    const group = ns.loader && ns.loader.loadGroup ? ns.loader.loadGroup("wasm-color") : Promise.resolve();
    group.then(() => (ns.wasm && ns.wasm.ops.color ? ns.wasm.load("color") : null)).catch(() => {});
  }

  // The result of kernel op `op`, or null (a short batch, no kernel yet, or a failure): the caller then runs the single function.
  // force: use the kernel whatever the size (the tests).
  function colorKernel(op, input, count, force) {
    if (!force && count < (COLOR_MIN_ITEMS[op] || Infinity)) return null;
    const kernel = ns.wasm && ns.wasm.get("color");
    if (!kernel || !ns.wasm.ops.color) {
      requestColorKernel();
      return null;
    }
    try {
      return ns.wasm.ops.color[op](kernel, input);
    } catch (error) {
      return null;
    }
  }

  function normalizeBatch(texts, force) {
    const list = Array.from(texts, (text) => String(text || "").trim());
    const out = colorKernel("normalize", { texts: list }, list.length, force);
    if (!out) return list.map(normalize);
    return list.map((text, i) => (out.status[i] === 0 ? out.texts[i] : out.status[i] === 1 ? text : normalize(text)));
  }

  // readableText of many fills: the label token of each.
  function readableTextBatch(fills, force) {
    const list = Array.from(fills);
    const resolved = [...list.map(resolve), resolve(LABELS[0]), resolve(LABELS[1])];
    const out = colorKernel("readable", { texts: resolved }, list.length, force);
    if (!out) return list.map(readableText);
    return list.map((fill, i) => (out.status[i] === 0 ? tokenRef(out.dark[i] === 1 ? LABELS[1] : LABELS[0]) : readableText(fill)));
  }

  // The hash slot of many service names (the slot a name has before it is assigned one).
  function hashSlotBatch(names, force) {
    const keys = Array.from(names, serviceKey);
    const out = colorKernel("hashSlots", { texts: keys, slots: SERVICE_SLOTS }, keys.length, force);
    if (!out) return keys.map(hashSlot);
    return keys.map((key, i) => (out.status[i] === 0 ? out.nums[i] : hashSlot(key)));
  }

  function sequentialBatch(values, force) {
    const list = Array.from(values, (t) => Number(t));
    const out = colorKernel("steps", { t: Float64Array.from(list), steps: SEQUENTIAL_STEPS }, list.length, force);
    if (!out) return Array.from(values, sequential);
    return list.map((t, i) => (out.status[i] === 0 ? tokenRef(`--trace-heat-${out.nums[i]}`) : sequential(t)));
  }

  function categoricalBatch(indexes, force) {
    const list = Array.from(indexes);
    const out = colorKernel("categorical", { v: Float64Array.from(list, (i) => Math.trunc(Number(i))), slots: CATEGORICAL_SLOTS }, list.length, force);
    if (!out) return list.map(categorical);
    return list.map((i, k) => (out.status[k] === 0 ? tokenRef(out.nums[k] === 0 ? "--qchart-other" : `--qchart-${out.nums[k]}`) : categorical(i)));
  }

  ns.palette = Object.freeze({
    SERVICE_SLOTS,
    CATEGORICAL_SLOTS,
    ERROR_RATE,
    errorLevel,
    errorColor,
    contrast,
    readableText,
    categorical,
    service,
    serviceSlot,
    registerServices,
    quantile,
    severity,
    severityLevel,
    sequential,
    kind,
    resolve,
    // The batches on WebAssembly and their references (see the block above): not part of the picker list.
    batch: Object.freeze({ normalize, normalizeBatch, readableTextBatch, hashSlotBatch, sequentialBatch, categoricalBatch, colorKernel, minItems: COLOR_MIN_ITEMS }),
  });
})();
