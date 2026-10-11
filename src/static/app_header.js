// ns.header: what every page shell shares (app_ui.js held it together with the Query page's editor; that part is
// app_query_ui.js now): the host picker and the hosts stream, the version badge and the feature flags
// (/api/version), the page switcher (links), the theme, and the time zone of a host's DateTime text.
//
//   header.init()                  binds the shell: menus, page switcher, theme, hosts stream, /api/version
//   header.setSelectedHostId(id)   the one place a host is selected (the host is state.selectedHostId)
//   header.onHostSelected(fn)      fn(hostId) runs inside setSelectedHostId, before chdash:host-changed, in the order
//                                  the modules asked (the host's metadata, the editor, the Run buttons)
//   header.applyHostPickerUi()     the picker's label, dot, ping and lock
//   header.setPageSelectorValue(page)     the page switcher's label and current link
//   header.serverTimeZone(hostId) / serverTime(value, { hostId, precision })    the zone of a host's DateTime text
//
// The header never calls the modules of a page: it tells them by events. chdash:host-changed (detail.hostId: a host
// was selected), chdash:api-online (detail.online: ns.api answered, or failed to), chdash:hosts (detail.snapshot: the
// hosts stream sent a snapshot) and chdash:theme-applied (the theme changed: canvases draw again).

import { api } from "./app_api.js";
import { dom } from "./app_dom.js";
import { format } from "./app_format.js";
import { router } from "./app_router.js";
import { features, state, storage } from "./app_state.js";
import { menu } from "./app_ui_menu.js";

const { $$ } = dom;

(() => {
  const mode = storage && typeof storage.getSavedThemeMode === "function" ? storage.getSavedThemeMode() : null;
  if (mode === "dark" || mode === "light") dom.root.dataset.theme = mode;
  else if (mode === "system") delete dom.root.dataset.theme;
})();

// What the header shows, kept for the next load (the head script of the shell paints it before any module runs): the version
// text and its title, and the selected host's id, name, ClickHouse version and health. Written only when it changed.
const headerCache = { version: "", title: "", host: null, ...(storage.loadHeader() || {}) };
let headerSaved = JSON.stringify(headerCache);

function rememberHeader() {
  const text = JSON.stringify(headerCache);
  if (text === headerSaved) return;
  headerSaved = text;
  storage.saveHeader(headerCache);
}

function safelyParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// /api/version: the version badge and the feature flags (ns.features; a
// flag the server does not send keeps the defaults table's value).
async function loadMeta() {
  // The features are loaded once /api/version has answered or failed, whatever the page shows of it: a page without
  // the version badge must not leave ns.features.ready waiting.
  const badge = dom.versionBadge;
  let data;
  try {
    data = await api.getVersion();
  } catch (error) {
    if (badge) badge.textContent = error?.code === "network_error" ? "meta: offline" : "meta: error";
    markFeaturesLoaded();
    return;
  }
  try {
    features.set(data && data.features);
    markFeaturesLoaded();
    applyProductFeatures();
    if (!badge) return;
    const verObj = data && data.version ? data.version : null;
    const ver = verObj && typeof verObj === "object" ? String(verObj.semver || "dev") : String(data.version || "dev");
    const sha = verObj && typeof verObj === "object" ? String(verObj.git_sha || "") : String(data.git_sha || "");
    const build = verObj && typeof verObj === "object" ? String(verObj.build_time || "") : String(data.build_time || "");
    const text = sha && sha !== "unknown" ? `${ver} (${sha})` : ver;
    badge.textContent = text;
    // The badge is as wide as the name above it and cuts a longer text: the title has all of it.
    badge.title = `Backend version\n${text}${build ? `\nBuild: ${build}` : ""}`;
    headerCache.version = text;
    headerCache.title = badge.title;
    rememberHeader();
  } catch {
    if (badge) badge.textContent = "meta: offline";
  }
  markFeaturesLoaded();
}

// The library waits for /api/version to pick its storage; without an answer
// it stays in the browser.
function markFeaturesLoaded() {
  features.markLoaded();
}

// A host's ping in ns.format's duration ("12 ms"), whole milliseconds.
function formatPingMsLabel(pingMs) {
  const ms = Number(pingMs);
  if (pingMs == null || !Number.isFinite(ms)) return format.EMPTY;
  const rounded = Math.round(ms);
  return rounded < 1 ? "<1 ms" : format.duration.fromMs(rounded);
}

// timeZone() of a host (default: the selected one), from the health
// snapshot (api/hosts): the zone of the DateTime text its system tables
// print, for ns.format.serverTime. "" until the first version check.
function serverTimeZone(hostId = state.selectedHostId) {
  const hosts = state.hostsSnapshot && Array.isArray(state.hostsSnapshot.hosts) ? state.hostsSnapshot.hosts : [];
  const host = hostId ? hosts.find((h) => h && String(h.id) === String(hostId)) : null;
  return host && host.clickhouse_timezone ? String(host.clickhouse_timezone) : "";
}

// A DateTime text of a host's system tables, for display: browser-local
// text, the tooltip with the server's zone, ISO for copies.
function serverTime(value, { hostId, precision } = {}) {
  return format.serverTime(value, { serverTz: serverTimeZone(hostId), precision });
}

function pickDefaultHostId(snapshot) {
  const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
  const ids = hosts.map((h) => String(h.id));
  const stored = storage.getStoredHostId();
  if (stored && ids.includes(String(stored))) return String(stored);
  return ids.length ? ids[0] : null;
}

// The modules that follow a host selection (onHostSelected), in the order they asked.
const hostHooks = [];
const onHostSelected = (fn) => { hostHooks.push(fn); };

function setSelectedHostId(hostId) {
  state.selectedHostId = hostId ? String(hostId) : null;
  if (state.selectedHostId) storage.setStoredHostId(state.selectedHostId);
  applyHostPickerUi();

  // Host selection is the authoritative point where the host's metadata, the editor and the Run buttons follow.
  for (const fn of hostHooks) fn(state.selectedHostId);
  try {
    window.dispatchEvent(new CustomEvent("chdash:host-changed", { detail: { hostId: state.selectedHostId } }));
  } catch (_) {}
}

// The hosts stream answers every second with what is mostly the same: writing a text that is
// already there still replaces its text node, which restyles and lays the page out again, once a
// second on every page. Only a changed text is written.
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

function applyHostPickerUi() {
  const snap = state.hostsSnapshot;
  const apiOnline = state.apiOnline !== false;

  const hosts = snap && Array.isArray(snap.hosts) ? snap.hosts : [];
  const selected = state.selectedHostId ? hosts.find((h) => h && String(h.id) === String(state.selectedHostId)) : null;

  const healthy = !!(selected && selected.healthy);
  const pingMs = selected && selected.ping_ms != null ? Number(selected.ping_ms) : null;
  const label = selected ? String(selected.label || selected.id) : (state.selectedHostId || "Host");
  const hostVersion = selected && selected.clickhouse_version != null ? String(selected.clickhouse_version) : "";

  setText(dom.hostPickerText, apiOnline ? label : `${label} (API offline)`);
  setText(dom.hostPickerVersion, hostVersion || "");
  if (selected && apiOnline) {
    headerCache.host = { id: String(selected.id), label, version: hostVersion, good: healthy };
    rememberHeader();
  }

  if (dom.hostPickerDot) {
    const good = apiOnline && healthy;
    dom.hostPickerDot.classList.toggle("hostDot--good", good);
    dom.hostPickerDot.classList.toggle("hostDot--bad", !good);
  }

  if (dom.hostPickerPing) {
    if (!apiOnline) {
      setText(dom.hostPickerPing, format.EMPTY);
    } else if (healthy && pingMs != null && Number.isFinite(pingMs)) {
      setText(dom.hostPickerPing, formatPingMsLabel(pingMs));
    } else {
      setText(dom.hostPickerPing, healthy ? format.EMPTY : "down");
    }
  }

  if (dom.hostPickerButton) {
    // A run keeps the host it started on: every statement of a batch, its
    // history entry and its diagnostics go to that host (app_run.js).
    const locked = !!state.isRunning;
    dom.hostPickerButton.disabled = !apiOnline || locked;
    const base = hostVersion ? `${label}\nClickHouse ${hostVersion}` : label;
    const title = locked ? `${base}\nThe host is locked while the query runs.` : base;
    if (dom.hostPickerButton.title !== title) dom.hostPickerButton.title = title;
    if (!apiOnline || locked) closeHostMenu();
  }
}

// The header menus are ns.menu menus (app_ui_menu.js): open /
// close motion, keys, focus return and the one outside-click / Escape
// layer. Bound in init(); these keep the names other modules call.
const menus = { host: null, page: null, theme: null };

function closeHostMenu() {
  menus.host?.close({ immediate: true, focus: false });
}

function hostPickerSignature(snapshot) {
  const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];
  return JSON.stringify({
    selected: state.selectedHostId || "",
    apiOnline: state.apiOnline !== false,
    hosts: hosts
      .filter((h) => h && h.id)
      .map((h) => ({
        id: String(h.id),
        label: String(h.label || h.id),
        healthy: !!h.healthy,
        ping_ms: h.ping_ms == null ? null : Number(h.ping_ms),
        clickhouse_version: h.clickhouse_version == null ? "" : String(h.clickhouse_version),
      })),
  });
}

function renderHostPicker(snapshot) {
  if (!dom.hostPickerMenu) return;
  const hosts = snapshot && Array.isArray(snapshot.hosts) ? snapshot.hosts : [];

  if (!state.selectedHostId) {
    setSelectedHostId(pickDefaultHostId(snapshot));
  } else {
    const ids = hosts.map((x) => String(x.id));
    if (!ids.includes(String(state.selectedHostId))) setSelectedHostId(ids.length ? ids[0] : null);
  }

  const signature = hostPickerSignature(snapshot);
  if (state.hostPickerRenderSignature === signature) {
    applyHostPickerUi();
    return;
  }
  state.hostPickerRenderSignature = signature;

  const staticPicker = hosts.length <= 1;

  if (dom.hostPicker) dom.hostPicker.classList.toggle("is-static", staticPicker);

  if (dom.hostPickerButton) {
    dom.hostPickerButton.disabled = !!state.isRunning;
    dom.hostPickerButton.setAttribute("aria-disabled", String(staticPicker));
    if (staticPicker) closeHostMenu();
  }

  dom.hostPickerMenu.replaceChildren();

  for (const h of hosts) {
    if (!h || !h.id) continue;
    const id = String(h.id);
    const isSelected = state.selectedHostId && id === String(state.selectedHostId);

    const label = String(h.label || h.id);
    const healthy = !!h.healthy;
    const pingMs = h.ping_ms != null ? Number(h.ping_ms) : null;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pickerOption";
    btn.setAttribute("role", "option");
    btn.setAttribute("data-id", id);
    btn.setAttribute("aria-selected", String(!!isSelected));

    const dot = document.createElement("span");
    dot.className = `hostDot ${healthy ? "hostDot--good" : "hostDot--bad"}`;
    dot.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "pickerOption__label";
    text.textContent = label;

    const version = document.createElement("span");
    version.className = "pickerOption__version";
    version.textContent = h.clickhouse_version != null ? String(h.clickhouse_version) : "";

    const meta = document.createElement("span");
    meta.className = "pickerOption__meta";
    meta.textContent = healthy && pingMs != null && Number.isFinite(pingMs) ? formatPingMsLabel(pingMs) : (healthy ? format.EMPTY : "down");

    btn.appendChild(dot);
    btn.appendChild(text);
    btn.appendChild(version);
    btn.appendChild(meta);

    btn.addEventListener("click", () => {
      if (!isSelected && !state.isRunning) setSelectedHostId(id);
      menus.host?.close({ focus: true });
      renderHostPicker(state.hostsSnapshot || snapshot);
    });

    dom.hostPickerMenu.appendChild(btn);
  }

  applyHostPickerUi();
}

function startHostsSse() {
  if (!dom.hostPicker) return;

  const pollMs = 5000;
  let es = null;
  let pollTimer = 0;
  let reconnectTimer = 0;
  let hasSnapshot = false;
  let booting = false;

  const useSnapshot = (snap) => {
    if (!snap || !Array.isArray(snap.hosts)) return;
    hasSnapshot = true;
    state.hostsSnapshot = snap;
    renderHostPicker(snap);
    api.setApiOnline(true);
    window.dispatchEvent(new CustomEvent("chdash:hosts", { detail: { snapshot: snap } }));
  };

  const closeStream = () => {
    if (!es) return;
    try {
      es.close();
    } catch {
      return;
    } finally {
      es = null;
    }
  };

  const stopPoll = () => {
    if (!pollTimer) return;
    clearTimeout(pollTimer);
    pollTimer = 0;
  };

  const stopReconnect = () => {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
  };

  const fetchHostsOnce = async () => {
    try {
      useSnapshot(await api.getHosts());
      return true;
    } catch {
      return false;
    }
  };

  const schedulePoll = () => {
    if (document.hidden || pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = 0;
      const ok = await fetchHostsOnce();
      if (!ok) api.setApiOnline(false);
      if (ok) ensureStream();
      if (!es) schedulePoll();
    }, pollMs);
  };

  const scheduleReconnect = () => {
    if (document.hidden || reconnectTimer || !hasSnapshot || es) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = 0;
      ensureStream();
    }, pollMs);
  };

  const ensureStream = () => {
    if (document.hidden || es || !hasSnapshot) return;
    stopReconnect();

    let next = null;
    try {
      next = new EventSource(api.resolveUrl("api/hosts/stream"));
    } catch {
      schedulePoll();
      scheduleReconnect();
      return;
    }

    es = next;

    es.addEventListener("hosts", (ev) => {
      const data = safelyParseJson(ev.data);
      if (!data) return;
      useSnapshot(data);
    });

    es.onopen = () => {
      api.setApiOnline(true);
      stopPoll();
    };

    es.onerror = () => {
      closeStream();
      schedulePoll();
      scheduleReconnect();
    };
  };

  const boot = async () => {
    if (document.hidden || booting) return;
    booting = true;
    try {
      const ok = await fetchHostsOnce();
      if (!ok) {
        api.setApiOnline(false);
        schedulePoll();
        return;
      }
      ensureStream();
    } finally {
      booting = false;
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      closeStream();
      stopPoll();
      stopReconnect();
      return;
    }
    boot();
  });

  boot();
}

function getResolvedTheme(mode) {
  if (mode === "dark" || mode === "light") return mode;
  try {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    return mql && mql.matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

// The page switcher (Query, Explorer, Observability, System, MCP) ships visible
// in every page shell. Only a server with neither Explorer, System, any
// Observability view (Traces, Logs, Metrics) nor MCP hides it; the head script of
// each page applies the last known availability (chdash-page-select-hidden)
// before first paint.
function applyPageNavigation(nav) {
  const explorerEnabled = nav.explorer !== false;
  const systemEnabled = nav.system !== false;
  const observabilityEnabled = nav.traces === true || nav.logs === true || nav.metrics === true;
  const mcpEnabled = nav.mcp === true;
  const hidden = !explorerEnabled && !systemEnabled && !observabilityEnabled && !mcpEnabled;
  dom.root?.classList.toggle("chdash-page-select-hidden", hidden);
  if (dom.pageSelect) dom.pageSelect.hidden = hidden;
  if (dom.navExplorerLink) dom.navExplorerLink.hidden = !explorerEnabled;
  if (dom.navObservabilityLink) dom.navObservabilityLink.hidden = !observabilityEnabled;
  if (dom.navSystemLink) dom.navSystemLink.hidden = !systemEnabled;
  if (dom.navMcpLink) dom.navMcpLink.hidden = !mcpEnabled;
}

function applyProductFeatures() {
  const f = features.get("explorer");
  const explorerEnabled = f.enabled;
  const tracesEnabled = features.get("traces.enabled");
  const logsEnabled = features.get("logs.enabled");
  const metricsEnabled = features.get("metrics.enabled");
  const systemEnabled = features.get("system.enabled");
  const mcpEnabled = features.get("mcp.enabled");
  applyPageNavigation({ explorer: explorerEnabled, system: systemEnabled, traces: tracesEnabled, logs: logsEnabled, metrics: metricsEnabled, mcp: mcpEnabled });
  storage?.savePageNav?.({ explorer: explorerEnabled, system: systemEnabled, traces: tracesEnabled, logs: logsEnabled, metrics: metricsEnabled, mcp: mcpEnabled });
  if (!explorerEnabled && /\/explorer(?:\/|$)/.test(window.location.pathname)) {
    router.replace("", { path: "/query", view: "query" });
  }
  // A turned-off view falls back to another (app_obs_page.js); with no
  // view left the page itself is gone.
  if (!tracesEnabled && !logsEnabled && !metricsEnabled && document.body?.dataset?.page === "observability") {
    window.location.replace(api.resolveUrl("query"));
    return;
  }
  // A trace is Traces': the page is gone with it; Observability's first
  // remaining view, else Query.
  if (!tracesEnabled && document.body?.dataset?.page === "trace") {
    window.location.replace(api.resolveUrl(logsEnabled ? "observability/logs" : metricsEnabled ? "observability/metrics" : "query"));
    return;
  }
  // The System page turned off (system.enabled = false): its routes are gone,
  // a query shape's page (shape.html) with them.
  if (!systemEnabled && ["system", "shape"].includes(document.body?.dataset?.page)) {
    window.location.replace(api.resolveUrl("query"));
    return;
  }
}

function setPageSelectorValue(value) {
  const labels = { query: "Query", explorer: "Explorer", observability: "Observability", system: "System", mcp: "MCP" };
  const page = Object.prototype.hasOwnProperty.call(labels, value) ? value : "query";
  if (dom.pageSelectButton) dom.pageSelectButton.textContent = labels[page];
  const links = { query: dom.navQueryLink, explorer: dom.navExplorerLink, observability: dom.navObservabilityLink, system: dom.navSystemLink, mcp: dom.navMcpLink };
  for (const [name, link] of Object.entries(links)) {
    if (name === page) link?.setAttribute("aria-current", "page");
    else link?.removeAttribute("aria-current");
  }
}

function applyTheme(mode) {
  const resolved = getResolvedTheme(mode);
  if (mode === "system") delete dom.root.dataset.theme;
  else dom.root.dataset.theme = resolved;
  // Drives the theme button icon from CSS (css/20-features/shell.css), like the head
  // script does before the first paint.
  dom.root.dataset.themeMode = mode;

  if (dom.themeSelectButton) dom.themeSelectButton.setAttribute("aria-label", `Theme: ${mode}`);

  if (dom.themeSelectMenu) {
    const btns = $$(".themeSelect__option[data-value]", dom.themeSelectMenu);
    for (const b of btns) {
      const m = b.getAttribute("data-value");
      b.setAttribute("aria-selected", String(m === mode));
    }
  }

  // Canvas pixels are not CSS-reactive. The Explorer's graph draws again in the same
  // visual transaction as the DOM theme switch instead of waiting for its
  // next animation/activity frame.
  window.dispatchEvent(new CustomEvent("chdash:theme-applied", { detail: { mode } }));
}

function init() {
  // Menu entries follow the last known availability until /api/version answers.
  const cachedPageNav = storage?.loadPageNav?.();
  if (cachedPageNav) applyPageNavigation(cachedPageNav);
  loadMeta();
  // The API answered, or did not: the picker shows it (the Run buttons follow on their own).
  window.addEventListener("chdash:api-online", applyHostPickerUi);

  menus.host = menu?.bind(dom.hostPickerButton, dom.hostPickerMenu, {
    root: dom.hostPicker,
    openClass: "",
    canOpen: () => !dom.hostPicker?.classList.contains("is-static"),
  }) || null;

  // The page switcher is a nav of links (header.html): every page is a document of its own, so a link is all it needs
  // (a new tab, a copied address). Under 820 px the links fold into a menu under the current page's name.
  menus.page = menu?.bind(dom.pageSelectButton, dom.pageSelectMenu, { items: "a[href]:not([hidden])", closeOnSelect: true, canOpen: () => !dom.pageSelect?.hidden }) || null;
  menus.theme = menu?.bind(dom.themeSelectButton, dom.themeSelectMenu) || null;
  if (dom.themeSelectMenu) {
    const buttons = $$(".themeSelect__option[data-value]", dom.themeSelectMenu);
    for (const b of buttons) {
      b.addEventListener("click", () => {
        const mode = b.getAttribute("data-value");
        if (mode !== "system" && mode !== "dark" && mode !== "light") return;
        storage.setSavedThemeMode(mode);
        applyTheme(mode);
      });
    }
  }

  const themeMode = storage.getSavedThemeMode();
  applyTheme(themeMode);

  try {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    if (mql && mql.addEventListener) {
      mql.addEventListener("change", () => {
        if (storage.getSavedThemeMode() === "system") applyTheme("system");
      });
    }
  } catch {
    // No OS theme change events: System keeps the theme resolved above.
    // Startup still has to finish (ready class, hosts stream).
  }

  if (dom.root && dom.root.classList) dom.root.classList.add("is-ready");

  startHostsSse();
}

export const header = Object.freeze({ init, setSelectedHostId, onHostSelected, applyHostPickerUi, setPageSelectorValue, serverTimeZone, serverTime });
