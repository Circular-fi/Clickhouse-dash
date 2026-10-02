(() => {
  "use strict";
  // ns.palette: every data colour as a themed CSS token (docs/ui-foundations.md).
  // Each picker returns a var() reference, so DOM colours follow the theme by
  // themselves; resolve() turns one into the colour the current theme
  // computes, for canvas drawing.
  //
  //   categorical(i)  --qchart-1..8: series slots of charts
  //   service(name)   --trace-span-color-1..18: one colour per service for the
  //                   browser session, shared by Traces, Logs and Metrics
  //   quantile(p)     --pct-p50/p90/p95/p99
  //   severity(level) --sev-fatal/error/warn/info/debug/trace
  //   sequential(t)   --trace-heat-1..8, t in [0, 1]
  //   kind(kind)      --kind-table/view/mv/dict/buffer/distributed
  const ns = (window.ChDash = window.ChDash || {});

  const CATEGORICAL_SLOTS = 8;
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

  ns.palette = Object.freeze({
    SERVICE_SLOTS,
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
  });
})();
