(() => {
  "use strict";
  const ns = window.ChDash;
  if (!ns) return;
  const { dom, state, api, util, ui } = ns;

  const SERVICE_COLORS = [
    "#4c78a8", "#f58518", "#54a24b", "#e45756", "#72b7b2", "#b279a2",
    "#ff9da6", "#9d755d", "#bab0ac", "#59a14f", "#edc949", "#af7aa1",
  ];

  const model = {
    meta: null,
    traces: [],
    analytics: null,
    prefillPairs: [],
    tagKeys: [],
    activeTrace: null,
    activeSpanId: null,
    openSpanIds: new Set(),
    waterfallLabelPct: 34,
    traceViewRange: [0, 1],
    disabledServices: new Set(),
    collapsed: new Set(),
    searchSeq: 0,
    prefillSeq: 0,
    tagSeq: 0,
    detailSeq: 0,
  };

  const esc = (value) => util.escapeHtml(String(value == null ? "" : value));
  const route = (path) => api.resolveUrl(String(path || "").replace(/^\/+/, ""));

  function formatDuration(nsValue) {
    const n = Number(nsValue);
    if (!Number.isFinite(n) || n < 0) return "—";
    if (n < 1e3) return `${Math.round(n)} ns`;
    if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e5 ? 1 : 0)} µs`;
    if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e8 ? 2 : 1)} ms`;
    return `${(n / 1e9).toFixed(n < 1e10 ? 2 : 1)} s`;
  }

  function durationScale(maxNsValue) {
    const maxNs = Math.max(0, Number(maxNsValue || 0));
    if (maxNs < 1e3) return { factor: 1, unit: "ns" };
    if (maxNs < 1e6) return { factor: 1e3, unit: "µs" };
    if (maxNs < 1e9) return { factor: 1e6, unit: "ms" };
    if (maxNs < 60e9) return { factor: 1e9, unit: "s" };
    if (maxNs < 3600e9) return { factor: 60e9, unit: "min" };
    return { factor: 3600e9, unit: "h" };
  }

  function formatDurationScaled(nsValue, scale) {
    const value = Number(nsValue || 0) / Math.max(1, Number(scale?.factor || 1));
    const abs = Math.abs(value);
    const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
    const fixed = value.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/g, "").replace(/\.$/, "");
    return `${fixed}${scale?.unit || "ns"}`;
  }

  function niceStep(maxValue, targetIntervals = 6, integerOnly = false) {
    const max = Math.max(0, Number(maxValue || 0));
    if (!max) return integerOnly ? 1 : 1;
    const raw = max / Math.max(1, Number(targetIntervals || 6));
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    let nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
    let step = nice * magnitude;
    if (integerOnly) step = Math.max(1, Math.ceil(step));
    return step;
  }

  function countAxis(maxValue, targetIntervals = 7) {
    const max = Math.max(0, Number(maxValue || 0));
    const step = niceStep(max, targetIntervals, true);
    const axisMax = Math.max(step, Math.ceil(max / step) * step);
    const values = [];
    for (let value = 0; value <= axisMax + step * .001; value += step) values.push(Math.round(value));
    return { axisMax, values };
  }

  function durationAxis(maxNsValue, targetIntervals = 7) {
    const maxNs = Math.max(0, Number(maxNsValue || 0));
    const scale = durationScale(maxNs);
    const maxScaled = maxNs / Math.max(1, scale.factor);
    const stepScaled = niceStep(maxScaled, targetIntervals, false);
    const axisMaxScaled = Math.max(stepScaled, Math.ceil(maxScaled / stepScaled) * stepScaled);
    const axisMax = axisMaxScaled * scale.factor;
    const values = [];
    for (let value = 0; value <= axisMaxScaled + stepScaled * .001; value += stepScaled) {
      const rounded = Math.abs(value) < 1e-12 ? 0 : value;
      const digits = stepScaled >= 1 ? 0 : stepScaled >= .1 ? 1 : 2;
      values.push({ value: rounded * scale.factor, label: `${rounded.toFixed(digits).replace(/\.0+$|(?<=\.[0-9])0+$/g, "").replace(/\.$/, "")}${scale.unit}` });
    }
    return { axisMax, scale, values };
  }

  function durationTicks(durationNs, count = 5) {
    const duration = Math.max(1, Number(durationNs || 0));
    const scale = durationScale(duration);
    const n = Math.max(2, Number(count || 5));
    return Array.from({ length: n }, (_, index) => {
      const ratio = index / (n - 1);
      return { ratio, label: formatDurationScaled(duration * ratio, scale) };
    });
  }

  function timeTickRatios(count = 7) {
    const n = Math.max(3, Number(count || 7));
    return Array.from({ length: n }, (_, index) => index / (n - 1));
  }

  function timestampToNs(value) {
    if (value == null || value === "") return NaN;
    const direct = Number(value);
    if (Number.isFinite(direct)) {
      const abs = Math.abs(direct);
      if (abs >= 1e17) return direct;
      if (abs >= 1e14) return direct * 1e3;
      if (abs >= 1e11) return direct * 1e6;
      if (abs >= 1e9) return direct * 1e9;
    }
    const raw = String(value).trim();
    if (!raw) return NaN;
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d\d(?::?\d\d)?)?$/);
    if (match) {
      const millis = (match[3] || "").slice(0, 3).padEnd(3, "0");
      const parsed = Date.parse(`${match[1]}T${match[2]}.${millis}Z`);
      if (Number.isFinite(parsed)) return parsed * 1e6;
    }
    const parsed = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
    return Number.isFinite(parsed) ? parsed * 1e6 : NaN;
  }

  function serviceEnabled(service) {
    return !model.disabledServices.has(String(service || "unknown"));
  }

  function shortId(value, size = 7) {
    const s = String(value || "");
    return s.length <= size * 2 + 1 ? s : `${s.slice(0, size)}…${s.slice(-size)}`;
  }

  function parseStartMs(value) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 10000000000) return direct;
    const raw = String(value || "").trim();
    if (!raw) return NaN;
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
    const withZone = /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(normalized) ? normalized : `${normalized}Z`;
    const ms = Date.parse(withZone);
    return Number.isFinite(ms) ? ms : NaN;
  }

  function formatStart(value) {
    const ms = parseStartMs(value);
    if (!Number.isFinite(ms)) return String(value || "");
    const d = new Date(ms);
    return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatAgo(value) {
    const ms = parseStartMs(value);
    if (!Number.isFinite(ms)) return "";
    const delta = Math.max(0, Date.now() - ms);
    const units = [[31536000000, "year"], [2592000000, "month"], [604800000, "week"], [86400000, "day"], [3600000, "hour"], [60000, "minute"], [1000, "second"]];
    for (const [size, label] of units) {
      if (delta >= size || label === "second") {
        const count = Math.max(0, Math.floor(delta / size));
        return `${count} ${label}${count === 1 ? "" : "s"} ago`;
      }
    }
    return "now";
  }

  function currentHost() { return state.selectedHostId || ""; }

  function showError(message) {
    if (!dom.tracesError) return;
    dom.tracesError.hidden = !message;
    dom.tracesError.textContent = message || "";
  }

  function traceIdFromPath() {
    const pathname = decodeURIComponent(String(window.location.pathname || ""));
    const match = pathname.match(/\/traces\/([^/]+)\/?$/);
    return match ? match[1] : "";
  }

  function setView(detail) {
    if (dom.tracesSearchView) dom.tracesSearchView.hidden = !!detail;
    if (dom.traceDetail) dom.traceDetail.hidden = !detail;
    document.body.classList.toggle("is-trace-detail", !!detail);
  }

  function serviceColor(service) {
    const s = String(service || "unknown");
    let hash = 2166136261;
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return SERVICE_COLORS[Math.abs(hash) % SERVICE_COLORS.length];
  }

  function setButtonLoading(button, loading) {
    if (!button) return;
    button.classList.toggle("is-loading", !!loading);
    button.disabled = !!loading;
  }

  const tracePickers = new Set();

  function closeTracePickers(except = null) {
    for (const root of tracePickers) {
      if (root === except) continue;
      root.classList.remove("themeSelect--open", "themeSelect--closing");
      root.querySelector(".tracePicker__button")?.setAttribute("aria-expanded", "false");
      root.querySelector(".tracePicker__menu")?.blur?.();
    }
  }

  function enhanceTraceSelect(select) {
    if (!select || select.dataset.tracePickerReady === "1") return;
    select.dataset.tracePickerReady = "1";
    const root = document.createElement("div");
    root.className = "themeSelect tracePicker";
    select.parentNode.insertBefore(root, select);
    root.appendChild(select);
    select.classList.add("tracePicker__native");

    const button = document.createElement("button");
    button.type = "button";
    button.className = "button themeSelect__button tracePicker__button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "themeSelect__menu tracePicker__menu";
    menu.setAttribute("role", "listbox");
    menu.tabIndex = -1;
    root.append(button, menu);
    tracePickers.add(root);

    const refresh = () => {
      const selected = select.options[select.selectedIndex] || select.options[0] || null;
      const fieldLabel = String(select.dataset.fieldLabel || "").trim();
      const selectedText = selected?.textContent || "Select";
      button.textContent = fieldLabel ? `${fieldLabel} · ${selectedText}` : selectedText;
      button.disabled = !!select.disabled;
      root.classList.toggle("is-disabled", !!select.disabled);
      menu.innerHTML = "";
      Array.from(select.options).forEach((option) => {
        if (option.hidden) return;
        const item = document.createElement("button");
        item.type = "button";
        item.className = "themeSelect__option tracePicker__option";
        item.setAttribute("role", "option");
        item.dataset.value = option.value;
        item.textContent = option.textContent || option.value || "—";
        item.disabled = !!option.disabled;
        item.setAttribute("aria-selected", option.value === select.value ? "true" : "false");
        item.addEventListener("click", () => {
          if (item.disabled) return;
          select.value = option.value;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          refresh();
          closeTracePickers();
        });
        menu.appendChild(item);
      });
    };

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (select.disabled) return;
      const opening = !root.classList.contains("themeSelect--open");
      closeTracePickers(root);
      root.classList.toggle("themeSelect--open", opening);
      button.setAttribute("aria-expanded", opening ? "true" : "false");
      if (opening) menu.focus({ preventScroll: true });
    });
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeTracePickers();
        button.focus();
      }
    });
    select.addEventListener("change", refresh);
    select.addEventListener("tracepicker-refresh", refresh);
    new MutationObserver(refresh).observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
    refresh();
  }

  const traceCombos = new Set();

  function closeTraceCombos(except = null) {
    for (const root of traceCombos) {
      if (root === except) continue;
      root.classList.remove("is-open");
      root.querySelector(".traceCombo__toggle")?.setAttribute("aria-expanded", "false");
      const menu = root.querySelector(".traceCombo__menu");
      if (menu) menu.hidden = true;
    }
  }

  function enhanceTraceCombo(input) {
    if (!input || input.dataset.traceComboReady === "1") return;
    const listId = input.getAttribute("list");
    const datalist = listId ? document.getElementById(listId) : null;
    if (!datalist) return;
    input.dataset.traceComboReady = "1";
    input.removeAttribute("list");
    const root = document.createElement("div");
    root.className = "traceCombo";
    input.parentNode.insertBefore(root, input);
    root.appendChild(input);
    input.classList.add("traceCombo__input");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "traceCombo__toggle";
    toggle.setAttribute("aria-label", "Show available values");
    toggle.setAttribute("aria-haspopup", "listbox");
    toggle.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "traceCombo__menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    root.append(toggle, menu);
    traceCombos.add(root);

    const options = () => Array.from(datalist.options).map((option) => String(option.value || "")).filter(Boolean);
    const render = () => {
      const query = String(input.value || "").trim().toLowerCase();
      const values = options().filter((value) => !query || value.toLowerCase().includes(query)).slice(0, 300);
      menu.innerHTML = values.length ? values.map((value) => `<button type="button" class="traceCombo__option" role="option" data-value="${esc(value)}">${esc(value)}</button>`).join("") : '<div class="traceCombo__empty">No prefetched values</div>';
      for (const item of menu.querySelectorAll("[data-value]")) {
        item.addEventListener("click", () => {
          input.value = item.getAttribute("data-value") || "";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          closeTraceCombos();
          input.focus({ preventScroll: true });
        });
      }
    };
    const open = () => {
      closeTraceCombos(root);
      render();
      root.classList.add("is-open");
      menu.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
    };
    const close = () => {
      root.classList.remove("is-open");
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    };
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (root.classList.contains("is-open")) close(); else open();
    });
    input.addEventListener("input", () => { if (root.classList.contains("is-open")) render(); });
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" && !root.classList.contains("is-open")) { event.preventDefault(); open(); }
      if (event.key === "Escape") close();
    });
    new MutationObserver(() => { if (root.classList.contains("is-open")) render(); }).observe(datalist, { childList: true, subtree: true });
  }

  function initTracePickers() {
    document.querySelectorAll(".traceSearchBar select, .traceResultsSort select").forEach(enhanceTraceSelect);
    enhanceTraceCombo(dom.tracesService);
    enhanceTraceCombo(dom.tracesOperation);
    document.addEventListener("click", (event) => {
      if (![...tracePickers].some((root) => root.contains(event.target))) closeTracePickers();
      if (![...traceCombos].some((root) => root.contains(event.target))) closeTraceCombos();
    });
  }

  function maxRangeMinutes() { return Math.max(1, Number(model.meta?.max_lookback_minutes || 10080)); }

  function toLocalDateTime(ms) {
    const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
    return d.toISOString().slice(0, 19);
  }

  function syncRangeControls() {
    const value = String(dom.tracesRangeUnit?.value || "60");
    const custom = value === "custom";
    if (!custom && dom.tracesCustomRange) dom.tracesCustomRange.hidden = true;
    const max = maxRangeMinutes();
    if (dom.tracesRangeUnit) {
      let selectedVisible = false;
      for (const option of dom.tracesRangeUnit.options) {
        if (option.value === "custom") { option.hidden = false; option.disabled = false; continue; }
        const minutes = Number(option.dataset.minutes || option.value || 0);
        option.hidden = minutes > max;
        option.disabled = option.hidden;
        if (option.value === dom.tracesRangeUnit.value && !option.hidden) selectedVisible = true;
      }
      if (!custom && !selectedVisible) {
        const allowed = Array.from(dom.tracesRangeUnit.options).filter((option) => option.value !== "custom" && !option.hidden);
        const fallback = allowed[allowed.length - 1];
        if (fallback) dom.tracesRangeUnit.value = fallback.value;
      }
      dom.tracesRangeUnit.dispatchEvent(new Event("tracepicker-refresh"));
    }
    const now = Date.now();
    if (dom.tracesRangeStart) { dom.tracesRangeStart.removeAttribute("min"); dom.tracesRangeStart.max = toLocalDateTime(now); }
    if (dom.tracesRangeEnd) { dom.tracesRangeEnd.removeAttribute("min"); dom.tracesRangeEnd.max = toLocalDateTime(now); }
    if (custom && dom.tracesRangeStart && dom.tracesRangeEnd && (!dom.tracesRangeStart.value || !dom.tracesRangeEnd.value)) {
      dom.tracesRangeStart.value = toLocalDateTime(now - Math.min(max, 60) * 60000);
      dom.tracesRangeEnd.value = toLocalDateTime(now);
    }
  }

  function selectedRange() {
    const value = String(dom.tracesRangeUnit?.value || "60");
    const maxMs = maxRangeMinutes() * 60000;
    let startMs = 0, endMs = 0;
    if (value === "custom") {
      startMs = Date.parse(String(dom.tracesRangeStart?.value || ""));
      endMs = Date.parse(String(dom.tracesRangeEnd?.value || ""));
    } else {
      const minutes = Math.max(1, Number(value || 60));
      endMs = Date.now();
      startMs = endMs - minutes * 60000;
    }
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new Error("Select a valid time range.");
    if (endMs - startMs > maxMs + 1000) throw new Error(`Time range exceeds the configured maximum of ${maxRangeMinutes()} minutes.`);
    return { start_ms: Math.round(startMs), end_ms: Math.round(endMs), align_buckets: value === "custom" ? "0" : "1" };
  }

  function clearTagSelection() {
    model.tagKeys = [];
    const keyList = document.getElementById("tracesTagKeyOptions");
    const valueList = document.getElementById("tracesTagValueOptions");
    if (keyList) keyList.innerHTML = "";
    if (valueList) valueList.innerHTML = "";
  }

  function updateTagButton() {
    if (!dom.tracesTagsButton) return;
    const allowed = model.meta?.tag_search_supported !== false && String(dom.tracesService?.value || "").trim() && String(dom.tracesOperation?.value || "").trim();
    dom.tracesTagsButton.disabled = !allowed;
  }

  function updateOperationOptions() {
    if (!dom.tracesOperationOptions) return;
    const service = String(dom.tracesService?.value || "").trim();
    const values = new Set();
    for (const pair of model.prefillPairs) {
      if (!service || pair[0] === service) values.add(pair[1]);
    }
    dom.tracesOperationOptions.innerHTML = [...values].sort().map((value) => `<option value="${esc(value)}"></option>`).join("");
    updateTagButton();
  }

  function matchMode(kind, value) {
    const text = String(value || "").trim();
    if (!text || !model.prefillPairs.length) return "ilike";
    if (kind === "service") return model.prefillPairs.some((pair) => pair[0] === text) ? "exact" : "ilike";
    const service = String(dom.tracesService?.value || "").trim();
    return model.prefillPairs.some((pair) => pair[1] === text && (!service || pair[0] === service)) ? "exact" : "ilike";
  }

  function syncFilterFeatures() {
    const f = model.meta?.features || {};
    const bindings = [[dom.tracesService, f.service_filter !== false], [dom.tracesOperation, f.operation_filter !== false], [dom.tracesStatus, f.status_filter !== false]];
    for (const [input, enabled] of bindings) {
      const field = input?.closest?.(".traceSearchField") || input?.closest?.("label");
      if (field) field.hidden = !enabled;
      if (input) input.disabled = !enabled;
    }
    syncRangeControls();
    if (dom.tracesLimit && model.meta) {
      const max = Math.max(1, Number(model.meta.search_limit || 100));
      for (const option of dom.tracesLimit.options) option.disabled = Number(option.value) > max;
      const enabled = Array.from(dom.tracesLimit.options).filter((o) => !o.disabled);
      if (!enabled.some((o) => o.value === dom.tracesLimit.value) && enabled.length) dom.tracesLimit.value = enabled[enabled.length - 1].value;
    }
    if (model.meta?.tag_search_supported === false) clearTagSelection();
    updateTagButton();
  }

  function renderSource() {
    if (!dom.tracesSourceMeta) return;
    if (!model.meta) { dom.tracesSourceMeta.textContent = "Loading source…"; return; }
    const index = model.meta.trace_index_available ? "trace-id index" : "exact TraceId fallback";
    dom.tracesSourceMeta.textContent = `${model.meta.source_host_id} · ${model.meta.database}.${model.meta.table} · ${index}`;
    dom.tracesSourceMeta.title = "Uses the selected host system connection.";
  }

  function sortedResults() {
    const rows = [...(model.traces || [])];
    const mode = String(dom.tracesSort?.value || "recent");
    if (mode === "longest") rows.sort((a, b) => Number(b.duration_ns || 0) - Number(a.duration_ns || 0));
    else if (mode === "shortest") rows.sort((a, b) => Number(a.duration_ns || 0) - Number(b.duration_ns || 0));
    else if (mode === "spans") rows.sort((a, b) => Number(b.span_count || 0) - Number(a.span_count || 0));
    else rows.sort((a, b) => Number(b.start_ms || 0) - Number(a.start_ms || 0));
    return rows;
  }

  function unpackSearch(payload) {
    const services = Array.isArray(payload?.services) ? payload.services : [];
    const rows = Array.isArray(payload?.rows) ? payload.rows : [];
    model.traces = rows.map((row) => ({
      trace_id: String(row?.[0] || ""),
      start_ms: Number(row?.[1] || 0),
      root_operation: String(row?.[2] || ""),
      root_service: services[Number(row?.[3] || 0)] || "unknown",
      duration_ns: Number(row?.[4] || 0),
      span_count: Number(row?.[5] || 0),
      error_count: Number(row?.[6] || 0),
      service_stats: (Array.isArray(row?.[7]) ? row[7] : []).map((stat) => ({ service: services[Number(stat?.[0] || 0)] || "unknown", spans: Number(stat?.[1] || 0), errors: Number(stat?.[2] || 0) })),
    }));
    model.analytics = {
      range: Array.isArray(payload?.range) ? payload.range.map(Number) : [0, 1],
      bucket_ms: Number(payload?.bucket_ms || 60000),
      quantile_bucket_ms: Number(payload?.quantile_bucket_ms || payload?.bucket_ms || 60000),
      services,
      trace_count_chart: Array.isArray(payload?.trace_count_chart) ? payload.trace_count_chart : [],
      duration_quantiles: Array.isArray(payload?.duration_quantiles) ? payload.duration_quantiles : [],
    };
  }

  function chartTime(ms) {
    return new Date(Number(ms || 0)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function attachChartTooltips(container, selector, htmlFor, onHover = null) {
    if (!container) return;
    let tooltip = container.querySelector(".traceChartTooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "traceChartTooltip";
      tooltip.hidden = true;
      container.appendChild(tooltip);
    }
    const hide = (target = null) => {
      tooltip.hidden = true;
      onHover?.(target, false);
    };
    const move = (event, target) => {
      const html = htmlFor(target);
      if (!html) return hide(target);
      onHover?.(target, true);
      tooltip.innerHTML = html;
      tooltip.hidden = false;
      const rect = container.getBoundingClientRect();
      const tip = tooltip.getBoundingClientRect();
      let x = event.clientX - rect.left + 12;
      let y = event.clientY - rect.top + 12;
      if (x + tip.width > rect.width - 4) x = event.clientX - rect.left - tip.width - 12;
      if (y + tip.height > rect.height - 4) y = event.clientY - rect.top - tip.height - 12;
      tooltip.style.left = `${Math.max(4, x)}px`;
      tooltip.style.top = `${Math.max(4, y)}px`;
    };
    for (const target of container.querySelectorAll(selector)) {
      target.addEventListener("pointerenter", (event) => move(event, target));
      target.addEventListener("pointermove", (event) => move(event, target));
      target.addEventListener("pointerleave", () => hide(target));
    }
  }

  function renderServiceChart() {
    if (!dom.traceServiceChart) return;
    const a = model.analytics;
    const points = a?.trace_count_chart || [];
    const range = a?.range || [0, 1];
    const bucketMs = Math.max(60000, Number(a?.bucket_ms || 60000));
    const start = Number(range[0] || 0), end = Math.max(start + bucketMs, Number(range[1] || start + bucketMs));
    const byBucket = new Map(points.map((point) => [Number(point?.[0] || 0), Number(point?.[1] || 0)]));
    const buckets = [];
    for (let bucket = start; bucket < end; bucket += bucketMs) buckets.push([bucket, byBucket.get(bucket) || 0]);
    if (!buckets.length) { dom.traceServiceChart.innerHTML = '<div class="tracesEmpty">No matching traces in this range.</div>'; return; }
    const W = 1000, H = 220, left = 48, right = 12, top = 12, bottom = 34;
    const plotW = W - left - right, plotH = H - top - bottom;
    const maxTotal = Math.max(1, ...buckets.map((bucket) => Number(bucket[1] || 0)));
    const countScale = countAxis(maxTotal, 7);
    const slotW = plotW / Math.max(1, buckets.length);
    const barW = Math.max(2, slotW * 0.72);
    const bars = buckets.map((bucket, i) => {
      const count = Number(bucket[1] || 0);
      const h = count / countScale.axisMax * plotH;
      const x = left + i * slotW + (slotW - barW) / 2;
      const y = top + plotH - h;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(0.8, h).toFixed(2)}" rx="1" class="traceCountBar" data-count-bar="${i}"/><rect x="${(left + i * slotW).toFixed(2)}" y="${top}" width="${slotW.toFixed(2)}" height="${plotH}" class="traceChartHit" data-count-index="${i}" data-count-ts="${bucket[0]}" data-count="${count}"/>`;
    }).join("");
    const yTicks = countScale.values.map((value) => { const r = value / countScale.axisMax; const y = top + plotH - r * plotH; return `<line x1="${left}" y1="${y}" x2="${W-right}" y2="${y}" class="traceChart__grid"/><text x="${left-7}" y="${y+4}" text-anchor="end" class="traceChart__tick">${value}</text>`; }).join("");
    const xLabels = timeTickRatios(7).map((r) => { const x = left + r * plotW; return `<text x="${x}" y="${H-10}" text-anchor="${r === 0 ? "start" : r === 1 ? "end" : "middle"}" class="traceChart__tick">${esc(chartTime(start + (end-start)*r))}</text>`; }).join("");
    dom.traceServiceChart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="traceChart__svg">${yTicks}${bars}${xLabels}</svg>`;
    attachChartTooltips(dom.traceServiceChart, "[data-count-ts]", (target) => {
      const ts = Number(target.dataset.countTs || 0), count = Number(target.dataset.count || 0);
      return `<strong>${count} matching trace${count === 1 ? "" : "s"}</strong><span>${esc(formatStart(ts))} → ${esc(formatStart(ts + bucketMs))}</span>`;
    }, (target, active) => {
      const index = target?.dataset?.countIndex;
      if (index == null) return;
      dom.traceServiceChart.querySelector(`[data-count-bar="${index}"]`)?.classList.toggle("is-hovered", active);
    });
    if (dom.traceServiceChartMeta) dom.traceServiceChartMeta.textContent = `matching traces · bucket ${formatDuration(bucketMs * 1e6)}`;
  }

  function renderDurationChart() {
    if (!dom.traceDurationChart) return;
    const a = model.analytics;
    const qs = a?.duration_quantiles || [];
    if (!qs.length) { dom.traceDurationChart.innerHTML = '<div class="tracesEmpty">No trace durations in this range.</div>'; return; }
    const range = a?.range || [Number(qs[0]?.[0] || 0), Number(qs[qs.length - 1]?.[0] || 1)];
    const xMin = Number(range[0] || 0), xMax = Math.max(xMin + 1, Number(range[1] || xMin + 1));
    const allY = [];
    for (const q of qs) allY.push(...q.slice(1).map(Number));
    const yMax = Math.max(1, ...allY);
    const durationScaleAxis = durationAxis(yMax, 7);
    const W = 1000, H = 220, left = 64, right = 14, top = 12, bottom = 34;
    const plotW = W - left - right, plotH = H - top - bottom;
    const xOf = (ms) => left + ((Number(ms) - xMin) / (xMax - xMin)) * plotW;
    const yOf = (ns) => top + plotH - (Number(ns || 0) / durationScaleAxis.axisMax) * plotH;
    const yScale = durationScaleAxis.scale;
    const yTicks = durationScaleAxis.values.map((tick) => { const y = top + plotH - (tick.value / durationScaleAxis.axisMax) * plotH; return `<line x1="${left}" y1="${y}" x2="${W-right}" y2="${y}" class="traceChart__grid"/><text x="${left-8}" y="${y+4}" text-anchor="end" class="traceChart__tick">${esc(tick.label)}</text>`; }).join("");
    const xTicks = timeTickRatios(7).map((r) => { const x = left + r * plotW; return `<text x="${x}" y="${H-10}" text-anchor="${r === 0 ? "start" : r === 1 ? "end" : "middle"}" class="traceChart__tick">${esc(chartTime(xMin + (xMax-xMin)*r))}</text>`; }).join("");
    const qDefs = [[1,"p50"],[2,"p90"],[3,"p95"],[4,"p99"]];
    const qBucketMs = Math.max(60000, Number(a.quantile_bucket_ms || a.bucket_ms || 60000));
    const lines = qDefs.map(([col, cls]) => {
      const pts = qs.map((q) => `${xOf(Number(q[0]) + qBucketMs/2).toFixed(2)},${yOf(q[col]).toFixed(2)}`).join(" ");
      return pts ? `<polyline points="${pts}" class="traceDurationLine traceDurationLine--${cls}" fill="none"/>` : "";
    }).join("");
    const hoverPoints = qs.map((q) => {
      const bucketStart = Number(q[0] || 0);
      const x = xOf(bucketStart + qBucketMs/2).toFixed(2);
      return `<g class="traceQuantileHover" data-q-hover="${bucketStart}"><line x1="${x}" x2="${x}" y1="${top}" y2="${top+plotH}"/><circle class="p50" cx="${x}" cy="${yOf(q[1]).toFixed(2)}" r="4"/><circle class="p90" cx="${x}" cy="${yOf(q[2]).toFixed(2)}" r="4"/><circle class="p95" cx="${x}" cy="${yOf(q[3]).toFixed(2)}" r="4"/><circle class="p99" cx="${x}" cy="${yOf(q[4]).toFixed(2)}" r="4"/></g>`;
    }).join("");
    const hits = qs.map((q) => {
      const bucketStart = Number(q[0] || 0);
      const x1 = Math.max(left, xOf(bucketStart));
      const x2 = Math.min(W - right, xOf(bucketStart + qBucketMs));
      return `<rect x="${x1.toFixed(2)}" y="${top}" width="${Math.max(2, x2-x1).toFixed(2)}" height="${plotH}" class="traceChartHit" data-q-ts="${bucketStart}" data-p50="${Number(q[1]||0)}" data-p90="${Number(q[2]||0)}" data-p95="${Number(q[3]||0)}" data-p99="${Number(q[4]||0)}"/>`;
    }).join("");
    dom.traceDurationChart.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="traceChart__svg">${yTicks}${xTicks}${lines}${hoverPoints}${hits}</svg><div class="traceChartLegend traceChartLegend--quantiles"><span class="p50">P50</span><span class="p90">P90</span><span class="p95">P95</span><span class="p99">P99</span></div>`;
    attachChartTooltips(dom.traceDurationChart, "[data-q-ts]", (target) => {
      const ts = Number(target.dataset.qTs || 0);
      return `<strong>${esc(formatStart(ts))}</strong><span>P50 <b>${esc(formatDurationScaled(Number(target.dataset.p50 || 0), yScale))}</b></span><span>P90 <b>${esc(formatDurationScaled(Number(target.dataset.p90 || 0), yScale))}</b></span><span>P95 <b>${esc(formatDurationScaled(Number(target.dataset.p95 || 0), yScale))}</b></span><span>P99 <b>${esc(formatDurationScaled(Number(target.dataset.p99 || 0), yScale))}</b></span>`;
    }, (target, active) => {
      const ts = target?.dataset?.qTs;
      if (!ts) return;
      dom.traceDurationChart.querySelector(`[data-q-hover="${ts}"]`)?.classList.toggle("is-active", active);
    });
    if (dom.traceDurationChartMeta) dom.traceDurationChartMeta.textContent = `percentiles · bucket ${formatDuration(qBucketMs * 1e6)}`;
  }

  function renderAnalytics() { renderServiceChart(); renderDurationChart(); }

  function copyText(text, button) {
    navigator.clipboard?.writeText?.(text).then(() => {
      if (!button) return;
      button.classList.add("is-copied");
      setTimeout(() => { button.classList.remove("is-copied"); }, 900);
    }).catch(() => {});
  }

  function renderResults() {
    if (!dom.tracesResults) return;
    const rows = sortedResults();
    const count = document.getElementById("tracesResultCount");
    if (count) count.textContent = `${rows.length} Trace${rows.length === 1 ? "" : "s"}`;
    renderAnalytics();
    if (!rows.length) {
      dom.tracesResults.innerHTML = '<div class="tracesEmpty">No traces match these filters.</div>';
      return;
    }
    dom.tracesResults.innerHTML = rows.map((trace) => {
      const errors = Number(trace.error_count || 0);
      const title = trace.root_operation || "trace";
      const services = Array.isArray(trace.service_stats) ? trace.service_stats : [];
      const stats = services.map((stat) => `<span class="traceServiceStat${stat.errors ? " is-error" : ""}" style="--trace-service-color:${serviceColor(stat.service)}"><i></i><b>${esc(stat.service)}</b><span>${stat.spans}</span>${stat.errors ? `<em class="traceErrorCount" title="${stat.errors} error span${stat.errors === 1 ? "" : "s"}">${stat.errors}</em>` : ""}</span>`).join("");
      return `<div class="traceResult traceResult--wide" data-trace-id="${esc(trace.trace_id)}" role="button" tabindex="0">
        <div class="traceResult__line traceResult__line--main">
          <strong class="traceResult__wideTitle">${esc(title)}</strong>
          <code class="traceResult__fullId">${esc(trace.trace_id)}</code>
          <button type="button" class="traceCopyButton" data-copy-trace="${esc(trace.trace_id)}" title="Copy Trace ID" aria-label="Copy Trace ID"><span class="editorCopyButton__icon" aria-hidden="true"></span></button>
          <span class="traceResult__right"><span class="traceResult__when"><time>${esc(formatStart(trace.start_ms))}</time><small>${esc(formatAgo(trace.start_ms))}</small></span><b>${esc(formatDuration(trace.duration_ns))}</b></span>
        </div>
        <div class="traceResult__line traceResult__line--stats">
          <span class="traceResult__count">${trace.span_count}</span>${errors ? `<span class="traceErrorCount traceErrorCount--total" title="${errors} error span${errors === 1 ? "" : "s"}">${errors}</span>` : ""}
          <div class="traceServiceStats">${stats}</div>
        </div>
      </div>`;
    }).join("");
    for (const row of dom.tracesResults.querySelectorAll("[data-trace-id]")) {
      const open = () => loadTrace(row.getAttribute("data-trace-id"), { push: true });
      row.addEventListener("click", (event) => { if (!event.target.closest("[data-copy-trace]")) open(); });
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
    }
    for (const button of dom.tracesResults.querySelectorAll("[data-copy-trace]")) {
      button.addEventListener("click", (event) => { event.stopPropagation(); copyText(button.getAttribute("data-copy-trace") || "", button); });
    }
  }

  function buildTree(spans) {
    const nodes = (Array.isArray(spans) ? spans : []).map((span) => ({ span, children: [], depth: 0 }));
    const byId = new Map(nodes.map((node) => [String(node.span.span_id || ""), node]));
    const roots = [];
    for (const node of nodes) {
      const parentId = String(node.span.parent_span_id || "");
      const parent = parentId ? byId.get(parentId) : null;
      if (parent && parent !== node) parent.children.push(node);
      else roots.push(node);
    }
    const cmp = (a, b) => Number(a.span.start_ns || 0) - Number(b.span.start_ns || 0) || String(a.span.span_id || "").localeCompare(String(b.span.span_id || ""));
    const setDepth = (node, depth) => {
      node.depth = Math.min(32, depth);
      node.children.sort(cmp);
      for (const child of node.children) setDepth(child, depth + 1);
    };
    roots.sort(cmp);
    for (const root of roots) setDepth(root, 0);
    return { nodes, roots };
  }

  function visibleNodes(tree) {
    const rows = [];
    const visit = (node) => {
      rows.push(node);
      if (model.collapsed.has(String(node.span.span_id || ""))) return;
      for (const child of node.children) visit(child);
    };
    for (const root of tree.roots) visit(root);
    return rows;
  }

  function traceBounds(spans) {
    const starts = spans.map((s) => Number(s.start_ns || 0)).filter(Number.isFinite);
    if (!starts.length) return { start: 0, end: 1, duration: 1 };
    const start = Math.min(...starts);
    const end = Math.max(...spans.map((s) => Number(s.start_ns || 0) + Number(s.duration_ns || 0)));
    return { start, end, duration: Math.max(1, end - start) };
  }

  function renderTraceOverview(spans, bounds) {
    if (!dom.traceOverview) return;
    if (!spans.length) { dom.traceOverview.innerHTML = ""; return; }
    const range = Array.isArray(model.traceViewRange) ? model.traceViewRange : [0, 1];
    const lo = Math.max(0, Math.min(1, Number(range[0] || 0)));
    const hi = Math.max(lo + 0.005, Math.min(1, Number(range[1] == null ? 1 : range[1])));
    const ticks = durationTicks(bounds.duration, 5).map((tick) => `<span style="left:${tick.ratio * 100}%">${esc(tick.label)}</span>`).join("");
    const ordered = spans.filter((span) => serviceEnabled(span.service_name)).slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0));
    const bars = ordered.map((span, index) => {
      const left = Math.max(0, Math.min(100, ((Number(span.start_ns || 0) - bounds.start) / bounds.duration) * 100));
      const width = Math.max(.08, Math.min(100 - left, (Number(span.duration_ns || 0) / bounds.duration) * 100));
      const lane = index % 9;
      const isError = String(span.status_code || "").toLowerCase() === "error";
      return `<i class="${isError ? "is-error" : ""}" title="${esc(`${span.service_name || "unknown"}: ${span.span_name || "span"} · ${formatDuration(span.duration_ns)}${isError ? " · ERROR" : ""}`)}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;top:${6 + lane * 4}px;--trace-service-color:${serviceColor(span.service_name)}"></i>`;
    }).join("");
    dom.traceOverview.innerHTML = `<div class="traceOverview__ticks">${ticks}</div><div class="traceOverview__graph" data-trace-overview-graph>${bars}<div class="traceOverview__selection" data-trace-overview-selection style="left:${(lo * 100).toFixed(3)}%;width:${((hi-lo)*100).toFixed(3)}%"><button type="button" class="traceOverview__handle traceOverview__handle--start" data-overview-handle="start" aria-label="Resize trace range start"></button><button type="button" class="traceOverview__handle traceOverview__handle--end" data-overview-handle="end" aria-label="Resize trace range end"></button></div></div>`;

    const graph = dom.traceOverview.querySelector("[data-trace-overview-graph]");
    const selection = dom.traceOverview.querySelector("[data-trace-overview-selection]");
    if (!graph || !selection) return;
    const updateSelection = (next) => {
      const a = Math.max(0, Math.min(.995, Number(next[0] || 0)));
      const b = Math.max(a + .005, Math.min(1, Number(next[1] == null ? 1 : next[1])));
      selection.style.left = `${(a*100).toFixed(3)}%`;
      selection.style.width = `${((b-a)*100).toFixed(3)}%`;
      return [a, b];
    };
    graph.addEventListener("dblclick", (event) => {
      event.preventDefault();
      model.traceViewRange = [0, 1];
      renderTraceOverview(spans, bounds);
      renderWaterfall();
    });
    graph.addEventListener("pointerdown", (event) => {
      if (event.button != null && event.button !== 0) return;
      const rect = graph.getBoundingClientRect();
      if (!rect.width) return;
      const pos = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const handle = event.target.closest?.("[data-overview-handle]")?.dataset?.overviewHandle || "range";
      const initial = [...model.traceViewRange];
      let next = initial;
      let moved = false;
      graph.setPointerCapture?.(event.pointerId);
      const apply = (clientX) => {
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        moved = true;
        if (handle === "start") next = updateSelection([Math.min(x, initial[1] - .005), initial[1]]);
        else if (handle === "end") next = updateSelection([initial[0], Math.max(x, initial[0] + .005)]);
        else next = updateSelection([Math.min(pos, x), Math.max(pos + .005, x)]);
      };
      const move = (moveEvent) => { if (graph.hasPointerCapture?.(event.pointerId)) apply(moveEvent.clientX); };
      const up = (upEvent) => {
        graph.removeEventListener("pointermove", move);
        graph.removeEventListener("pointerup", up);
        graph.removeEventListener("pointercancel", up);
        graph.releasePointerCapture?.(event.pointerId);
        if (!moved && handle === "range") {
          const half = Math.max(.025, (initial[1] - initial[0]) / 4);
          next = updateSelection([Math.max(0, pos-half), Math.min(1, pos+half)]);
        }
        model.traceViewRange = next;
        renderTraceOverview(spans, bounds);
        renderWaterfall();
      };
      graph.addEventListener("pointermove", move);
      graph.addEventListener("pointerup", up);
      graph.addEventListener("pointercancel", up);
      event.preventDefault();
    });
  }

  function renderTraceServiceFilters(spans) {
    if (!dom.traceServiceFilters) return;
    const stats = new Map();
    for (const span of spans || []) {
      const service = String(span.service_name || "unknown");
      const row = stats.get(service) || { spans: 0, errors: 0 };
      row.spans += 1;
      if (String(span.status_code || "").toLowerCase() === "error") row.errors += 1;
      stats.set(service, row);
    }
    const services = [...stats.keys()].sort((a, b) => a.localeCompare(b));
    const allSelected = services.every((service) => !model.disabledServices.has(service));
    const toggleLabel = allSelected ? "Deselect all" : "Select all";
    dom.traceServiceFilters.innerHTML = `<button type="button" class="traceServiceFilterReset" data-trace-toggle-all title="${toggleLabel} services">${toggleLabel}</button>` + services.map((service) => {
      const row = stats.get(service);
      const disabled = model.disabledServices.has(service);
      return `<button type="button" class="traceServiceStat traceServiceFilter${disabled ? " is-disabled" : ""}${row.errors ? " has-errors" : ""}" data-trace-service-filter="${esc(service)}" aria-pressed="${disabled ? "false" : "true"}" title="${esc(`${service} · ${row.spans} spans${row.errors ? ` · ${row.errors} errors` : ""}`)}"><i style="--trace-service-color:${serviceColor(service)}"></i><b>${esc(service)}</b><span>${row.spans}</span>${row.errors ? `<em title="${row.errors} error${row.errors === 1 ? "" : "s"}">${row.errors}</em>` : ""}</button>`;
    }).join("");
    dom.traceServiceFilters.querySelector("[data-trace-toggle-all]")?.addEventListener("click", () => {
      model.disabledServices = allSelected ? new Set(services) : new Set();
      renderTraceServiceFilters(spans);
      renderTraceOverview(spans, traceBounds(spans));
      renderWaterfall();
    });
    for (const button of dom.traceServiceFilters.querySelectorAll("[data-trace-service-filter]")) {
      button.addEventListener("click", () => {
        const service = String(button.getAttribute("data-trace-service-filter") || "");
        if (model.disabledServices.has(service)) model.disabledServices.delete(service);
        else model.disabledServices.add(service);
        renderTraceServiceFilters(spans);
        renderTraceOverview(spans, traceBounds(spans));
        renderWaterfall();
      });
    }
  }

  function renderTraceHeader() {
    const trace = model.activeTrace;
    const spans = trace?.spans || [];
    if (!spans.length) {
      if (dom.traceDetailTitle) dom.traceDetailTitle.innerHTML = '<strong>Trace</strong><span>Select a trace to inspect its spans.</span>';
      if (dom.traceDetailStats) dom.traceDetailStats.innerHTML = "";
      if (dom.traceServiceFilters) dom.traceServiceFilters.innerHTML = "";
      if (dom.traceOverview) dom.traceOverview.innerHTML = "";
      return;
    }
    const bounds = traceBounds(spans);
    const root = spans.find((s) => !s.parent_span_id) || spans.slice().sort((a, b) => Number(a.start_ns || 0) - Number(b.start_ns || 0))[0];
    if (dom.traceDetailTitle) {
      dom.traceDetailTitle.innerHTML = `<strong><span>${esc(root?.service_name || "trace")}:</span> ${esc(root?.span_name || "trace")}</strong><span class="tracePageHeader__traceId"><code title="${esc(trace.trace_id)}">${esc(shortId(trace.trace_id, 10))}</code><button type="button" class="traceCopyButton traceCopyButton--header" data-copy-active-trace="${esc(trace.trace_id)}" aria-label="Copy Trace ID" title="Copy full Trace ID"><span class="editorCopyButton__icon" aria-hidden="true"></span></button></span>`;
      dom.traceDetailTitle.querySelector("[data-copy-active-trace]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        copyText(trace.trace_id, event.currentTarget);
      });
    }
    if (dom.traceDetailStats) {
      const items = [
        ["Trace Start", formatStart(Number(bounds.start) / 1e6)],
        ["Duration", formatDuration(bounds.duration)],
      ];
      dom.traceDetailStats.innerHTML = items.map(([label, value, cls]) => `<div class="tracePageOverviewItem${cls ? ` ${cls}` : ""}"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('<i class="tracePageOverviewDivider" aria-hidden="true"></i>');
    }
    renderTraceServiceFilters(spans);
    renderTraceOverview(spans, bounds);
  }

  function renderWaterfall() {
    if (!dom.traceWaterfall) return;
    const spans = model.activeTrace?.spans || [];
    if (!spans.length) { dom.traceWaterfall.innerHTML = '<div class="tracesEmpty">No spans.</div>'; return; }
    const tree = buildTree(spans);
    const allRows = visibleNodes(tree);
    const fullStart = Math.min(...spans.map((s) => Number(s.start_ns || 0)));
    const fullEnd = Math.max(...spans.map((s) => Number(s.start_ns || 0) + Number(s.duration_ns || 0)));
    const fullTotal = Math.max(1, fullEnd - fullStart);
    const viewRange = Array.isArray(model.traceViewRange) ? model.traceViewRange : [0, 1];
    const viewLo = Math.max(0, Math.min(1, Number(viewRange[0] || 0)));
    const viewHi = Math.max(viewLo + .005, Math.min(1, Number(viewRange[1] == null ? 1 : viewRange[1])));
    const start = fullStart + fullTotal * viewLo;
    const end = fullStart + fullTotal * viewHi;
    const total = Math.max(1, end - start);
    const rows = allRows.filter((node) => {
      const spanStart = Number(node.span.start_ns || 0);
      const spanEnd = spanStart + Number(node.span.duration_ns || 0);
      return serviceEnabled(node.span.service_name) && spanEnd > start && spanStart < end;
    });
    const search = String(dom.traceSpanSearch?.value || "").trim().toLowerCase();
    const matching = search ? rows.filter((node) => `${node.span.service_name || ""} ${node.span.span_name || ""} ${node.span.span_id || ""}`.toLowerCase().includes(search)) : [];
    if (dom.traceSpanSearchCount) dom.traceSpanSearchCount.textContent = search ? `${matching.length} match${matching.length === 1 ? "" : "es"}` : "";
    dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
    const tickLabels = durationTicks(total, 5).map((tick) => `<span style="left:${tick.ratio * 100}%"><i></i><b>${esc(tick.label)}</b></span>`).join("");
    const head = `<div class="traceWaterfallHead"><div class="traceWaterfallHead__operation"><span>Service &amp; Operation</span><span class="traceWaterfallHead__controls"><button type="button" data-trace-collapse-all title="Collapse all">‹‹</button><button type="button" data-trace-expand-all title="Expand all">››</button></span></div><div class="traceWaterfallHead__timeline">${tickLabels}</div><div class="traceWaterfallResizer" data-trace-waterfall-resizer role="separator" aria-orientation="vertical" aria-label="Resize Service & Operation column" tabindex="0"></div></div>`;
    const body = rows.map((node) => {
      const span = node.span;
      const id = String(span.span_id || "");
      const spanStart = Number(span.start_ns || 0);
      const spanEnd = spanStart + Number(span.duration_ns || 0);
      const clippedStart = Math.max(start, spanStart);
      const clippedEnd = Math.min(end, spanEnd);
      const inView = clippedEnd > clippedStart;
      const left = inView ? Math.max(0, Math.min(100, ((clippedStart - start) / total) * 100)) : 0;
      const width = inView ? Math.max(0.24, Math.min(100 - left, ((clippedEnd - clippedStart) / total) * 100)) : 0;
      const error = String(span.status_code || "").toLowerCase() === "error";
      const active = model.openSpanIds.has(id);
      const searchMatch = !!search && `${span.service_name || ""} ${span.span_name || ""} ${span.span_id || ""}`.toLowerCase().includes(search);
      const color = serviceColor(span.service_name);
      const toggle = node.children.length ? `<button type="button" class="traceSpanRow__toggle" data-toggle-span="${esc(id)}" aria-label="${model.collapsed.has(id) ? "Expand" : "Collapse"} children">${model.collapsed.has(id) ? "›" : "⌄"}</button>` : '<span class="traceSpanRow__toggle traceSpanRow__toggle--blank"></span>';
      const labelLeft = left + (width / 2) >= 62;
      const depth = Math.min(node.depth, 20);
      const guides = Array.from({ length: depth }, (_, index) => `<i style="left:${18 + index * 12}px"></i>`).join("");
      const serviceLineX = 27 + depth * 12;
      const spanRef = `${span.service_name || "unknown"}::${span.span_name || "span"}`;
      const durationText = formatDuration(span.duration_ns);
      const barLabel = labelLeft
        ? `<span class="traceSpanBar__label"><i class="traceSpanBar__ref">${esc(spanRef)}</i><span class="traceSpanBar__sep">|</span><b>${esc(durationText)}</b></span>`
        : `<span class="traceSpanBar__label"><b>${esc(durationText)}</b><span class="traceSpanBar__sep">|</span><i class="traceSpanBar__ref">${esc(spanRef)}</i></span>`;
      const eventTimes = parseStructuredValue(span.events_timestamp);
      const eventNames = parseStructuredValue(span.events_name);
      const events = Array.isArray(eventTimes) ? eventTimes : [];
      const eventMarkers = events.map((value, index) => {
        const eventNs = timestampToNs(value);
        if (!Number.isFinite(eventNs) || eventNs < clippedStart || eventNs > clippedEnd) return "";
        const eventLeft = Math.max(0, Math.min(100, ((eventNs - start) / total) * 100));
        const eventName = Array.isArray(eventNames) && eventNames[index] != null ? String(eventNames[index]) : `Event ${index + 1}`;
        return `<i class="traceSpanEventMarker" style="left:${eventLeft.toFixed(4)}%" title="${esc(eventName)}"></i>`;
      }).join("");
      const bar = inView ? `<i class="traceSpanBar${error ? " traceSpanBar--error" : ""}${labelLeft ? " traceSpanBar--labelLeft" : ""}" style="left:${left.toFixed(4)}%;width:${width.toFixed(4)}%;--trace-service-color:${color}">${barLabel}</i>` : "";
      const rowHtml = `<div class="traceSpanRow${active ? " is-active" : ""}${searchMatch ? " is-search-match" : ""}${error ? " is-error" : ""}" data-span-id="${esc(id)}" role="button" tabindex="0">
        <div class="traceSpanRow__label" style="--trace-service-color:${color}"><span class="traceSpanRow__guides" aria-hidden="true">${guides}</span><div class="traceSpanRow__labelContent" style="padding-left:${8 + depth * 12}px">${toggle}<span class="traceSpanRow__serviceDot"></span><span class="traceSpanRow__service">${esc(span.service_name || "unknown")}</span><span class="traceSpanRow__name">${esc(span.span_name || "span")}</span>${error ? '<span class="traceSpanRow__errorBadge" title="Span status: Error">!</span>' : ""}</div></div>
        <div class="traceSpanRow__timeline">${bar}${eventMarkers}</div>
      </div>`;
      const inspectorHtml = active ? `<div class="traceSpanInspectorRow" style="--trace-service-color:${color};--trace-depth-x:${serviceLineX}px"><div class="traceSpanInspectorRow__spacer"><span class="traceSpanRow__guides" aria-hidden="true">${guides}</span></div><div class="traceSpanInspectorRow__panel">${renderSpanInspectorCard(span, spans)}</div></div>` : "";
      return rowHtml + inspectorHtml;
    }).join("");
    dom.traceWaterfall.innerHTML = `${head}<div class="traceWaterfallBody">${body}</div>`;

    dom.traceWaterfall.querySelector("[data-trace-collapse-all]")?.addEventListener("click", () => {
      model.collapsed = new Set(tree.nodes.filter((node) => node.children.length).map((node) => String(node.span.span_id || "")));
      renderWaterfall();
    });
    dom.traceWaterfall.querySelector("[data-trace-expand-all]")?.addEventListener("click", () => { model.collapsed.clear(); renderWaterfall(); });

    const resizer = dom.traceWaterfall.querySelector("[data-trace-waterfall-resizer]");
    const setWidthFromClient = (clientX) => {
      const rect = dom.traceWaterfall.getBoundingClientRect();
      if (!rect.width) return;
      model.waterfallLabelPct = Math.max(18, Math.min(60, ((clientX - rect.left) / rect.width) * 100));
      dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
    };
    resizer?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      resizer.setPointerCapture?.(event.pointerId);
      resizer.classList.add("is-dragging");
      setWidthFromClient(event.clientX);
    });
    resizer?.addEventListener("pointermove", (event) => {
      if (!resizer.hasPointerCapture?.(event.pointerId)) return;
      setWidthFromClient(event.clientX);
    });
    const stopResize = (event) => {
      if (resizer?.hasPointerCapture?.(event.pointerId)) resizer.releasePointerCapture?.(event.pointerId);
      resizer?.classList.remove("is-dragging");
    };
    resizer?.addEventListener("pointerup", stopResize);
    resizer?.addEventListener("pointercancel", stopResize);
    resizer?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      model.waterfallLabelPct = Math.max(18, Math.min(60, model.waterfallLabelPct + (event.key === "ArrowRight" ? 2 : -2)));
      dom.traceWaterfall.style.setProperty("--trace-label-width", `${model.waterfallLabelPct}%`);
    });

    for (const toggle of dom.traceWaterfall.querySelectorAll("[data-toggle-span]")) {
      toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const id = String(toggle.getAttribute("data-toggle-span") || "");
        if (model.collapsed.has(id)) model.collapsed.delete(id); else model.collapsed.add(id);
        renderWaterfall();
      });
    }
    for (const row of dom.traceWaterfall.querySelectorAll("[data-span-id]")) {
      const select = () => {
        const id = String(row.getAttribute("data-span-id") || "");
        model.activeSpanId = id;
        if (model.openSpanIds.has(id)) model.openSpanIds.delete(id); else model.openSpanIds.add(id);
        renderWaterfall();
      };
      row.addEventListener("click", select);
      row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
    }
    for (const link of dom.traceWaterfall.querySelectorAll("[data-linked-trace]")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const traceId = String(link.getAttribute("data-linked-trace") || "");
        if (traceId) loadTrace(traceId, { push: true });
      });
    }
  }

  function parseStructuredValue(raw) {
    if (raw == null) return null;
    if (typeof raw !== "string") return raw;
    const text = raw.trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) {}
    return null;
  }

  function attributeEntries(raw) {
    const value = parseStructuredValue(raw);
    if (!value || Array.isArray(value) || typeof value !== "object") return [];
    return Object.entries(value).sort(([a], [b]) => String(a).localeCompare(String(b)));
  }

  function renderJaegerAttributes(raw, emptyText = "No attributes") {
    const entries = attributeEntries(raw);
    if (!entries.length) {
      const fallback = String(raw || "").trim();
      return fallback && fallback !== "{}"
        ? `<pre class="traceJaegerRaw">${esc(fallback)}</pre>`
        : `<span class="traceJaegerEmpty">${esc(emptyText)}</span>`;
    }
    return `<div class="traceJaegerTags">${entries.map(([key, value]) => `<span class="traceJaegerTag"><b>${esc(key)}</b><i>=</i><code title="${esc(value)}">${esc(value)}</code></span>`).join('<i class="traceJaegerTagSep" aria-hidden="true"></i>')}</div>`;
  }

  function attributeValueText(value) {
    if (value == null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function renderAttributePreview(raw, emptyText = "none") {
    const entries = attributeEntries(raw);
    if (!entries.length) return `<span class="traceJaegerSummaryPreview is-empty">${esc(emptyText)}</span>`;
    return `<span class="traceJaegerSummaryPreview">${entries.map(([key, value]) => `<span><b>${esc(key)}</b>=${esc(attributeValueText(value))}</span>`).join(" ")}</span>`;
  }

  function renderAttributeTable(raw, emptyText = "No attributes") {
    const entries = attributeEntries(raw);
    if (!entries.length) return `<span class="traceJaegerEmpty">${esc(emptyText)}</span>`;
    return `<div class="traceAttributeTable">${entries.map(([key, value]) => `<div class="traceAttributeTable__row"><span>${esc(key)}</span><code>${esc(attributeValueText(value))}</code></div>`).join("")}</div>`;
  }

  function renderJaegerEvents(span) {
    const timestamps = parseStructuredValue(span.events_timestamp);
    const names = parseStructuredValue(span.events_name);
    const attributes = parseStructuredValue(span.events_attributes);
    const ts = Array.isArray(timestamps) ? timestamps : [];
    const ns = Array.isArray(names) ? names : [];
    const attrs = Array.isArray(attributes) ? attributes : [];
    const count = Math.max(ts.length, ns.length, attrs.length);
    if (!count) return "";
    const rows = Array.from({ length: count }, (_, index) => {
      const name = ns[index] == null ? `Event ${index + 1}` : String(ns[index]);
      const time = ts[index] == null ? "" : String(ts[index]);
      const body = attrs[index] == null ? null : attrs[index];
      const bodyText = body && typeof body === "object" && !Array.isArray(body)
        ? `<div class="traceJaegerLogAttrs">${Object.entries(body).map(([key, value]) => `<div><b>${esc(key)}</b><code>${esc(value)}</code></div>`).join("")}</div>`
        : (body == null ? "" : `<pre class="traceJaegerRaw">${esc(typeof body === "string" ? body : JSON.stringify(body, null, 2))}</pre>`);
      return `<article class="traceJaegerLog"><header><strong>${esc(name)}</strong>${time ? `<time>${esc(time)}</time>` : ""}</header>${bodyText}</article>`;
    }).join("");
    return `<details class="traceJaegerGroup"><summary>Logs / Events <span>${count}</span></summary><div class="traceJaegerLogs">${rows}</div></details>`;
  }

  function renderJaegerLinks(span) {
    const traceIds = parseStructuredValue(span.links_trace_id);
    const spanIds = parseStructuredValue(span.links_span_id);
    const attrs = parseStructuredValue(span.links_attributes);
    const tids = Array.isArray(traceIds) ? traceIds : [];
    const sids = Array.isArray(spanIds) ? spanIds : [];
    const aa = Array.isArray(attrs) ? attrs : [];
    const count = Math.max(tids.length, sids.length, aa.length);
    if (!count) return "";
    const rows = Array.from({ length: count }, (_, index) => {
      const traceId = String(tids[index] || "");
      const traceCell = traceId ? `<a class="traceJaegerLink__trace" href="${esc(route(`traces/${encodeURIComponent(traceId)}`))}" data-linked-trace="${esc(traceId)}" title="Open linked trace">${esc(traceId)}</a>` : `<code></code>`;
      return `<div class="traceJaegerLink">${traceCell}<code>${esc(sids[index] || "")}</code>${aa[index] ? renderJaegerAttributes(JSON.stringify(aa[index]), "") : ""}</div>`;
    }).join("");
    return `<details class="traceJaegerGroup"><summary>Links <span>${count}</span></summary><div class="traceJaegerLinks">${rows}</div></details>`;
  }

  function renderSpanInspectorCard(span, spans) {
    const status = span.status_code || "Unset";
    const bounds = traceBounds(spans || []);
    const startOffset = Math.max(0, Number(span.start_ns || 0) - bounds.start);
    const statusClass = esc(String(status).toLowerCase());
    const statusBadge = String(status).toLowerCase() === "unset" ? "" : `<span class="traceStatus traceStatus--${statusClass}">${esc(status)}</span>`;
    const statusMessage = String(span.status_message || "").trim();
    const color = serviceColor(span.service_name);
    return `<section class="traceInspector traceInspector--jaeger traceInspector--inline" style="--trace-service-color:${color}">
      <div class="traceInspectorHead traceInspectorHead--jaeger">
        <strong title="${esc(span.span_name || "span")}">${esc(span.span_name || "span")}</strong>
        <div class="traceInspectorHead__meta"><span>Service: <b>${esc(span.service_name || "unknown")}</b></span><i></i><span>Duration: <b>${esc(formatDuration(span.duration_ns))}</b></span><i></i><span>Start Time: <b>${esc(formatDuration(startOffset))}</b></span>${statusBadge}</div>
      </div>
      ${statusMessage ? `<div class="traceInspectorStatusMessage"><b>Status message</b><span>${esc(statusMessage)}</span></div>` : ""}
      <details class="traceJaegerGroup traceJaegerGroup--summary"><summary><b>Tags:</b>${renderAttributePreview(span.span_attributes)}</summary><div class="traceJaegerGroup__body">${renderAttributeTable(span.span_attributes)}</div></details>
      <details class="traceJaegerGroup traceJaegerGroup--summary"><summary><b>Process:</b>${renderAttributePreview(span.resource_attributes)}</summary><div class="traceJaegerGroup__body">${renderAttributeTable(span.resource_attributes)}</div></details>
      ${renderJaegerEvents(span)}
      ${renderJaegerLinks(span)}
      <div class="traceInspectorIdentity"><span>SpanID: <code>${esc(span.span_id)}</code></span><span>Parent: <code>${esc(span.parent_span_id || "root")}</code></span><span>Kind: <code>${esc(span.span_kind || "—")}</code></span></div>
    </section>`;
  }

  function renderInspector() {
    if (!dom.traceInspector) return;
    dom.traceInspector.hidden = true;
    dom.traceInspector.innerHTML = "";
  }

  function renderTrace() {
    renderTraceHeader();
    renderWaterfall();
    renderInspector();
  }

  async function loadMeta() {
    try {
      const meta = await api.getTracesMeta(currentHost());
      model.meta = meta;
      if (meta && meta.schema_ok === false) showError(`Trace table ${meta.database}.${meta.table} is missing one or more required OpenTelemetry columns.`);
      else showError("");
      renderSource();
      syncFilterFeatures();
      return meta;
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
      renderSource();
      throw error;
    }
  }

  function currentTag() {
    const key = String(dom.tracesTagKey?.value || "").trim();
    const value = String(dom.tracesTagValue?.value || "");
    if (!key) return { scope: "", key: "", value };
    const scoped = key.match(/^(span|resource):(.*)$/i);
    if (scoped) return { scope: scoped[1].toLowerCase(), key: String(scoped[2] || "").trim(), value };
    return { scope: "any", key, value };
  }

  function searchFilters({ includeTag = true } = {}) {
    const range = selectedRange();
    const service = String(dom.tracesService?.value || "").trim();
    const operation = String(dom.tracesOperation?.value || "").trim();
    const filters = {
      ...range,
      service,
      service_match: matchMode("service", service),
      operation,
      operation_match: matchMode("operation", operation),
      status: String(dom.tracesStatus?.value || ""),
      limit: String(dom.tracesLimit?.value || Math.min(50, Number(model.meta?.search_limit || 50))),
    };
    if (includeTag) {
      const tag = currentTag();
      if (tag.scope && tag.key && tag.value !== "") Object.assign(filters, { tag_scope: tag.scope, tag_key: tag.key, tag_value: tag.value });
    }
    return filters;
  }

  function invalidateDiscovery({ pairs = true, tags = true } = {}) {
    if (pairs) {
      model.prefillPairs = [];
      if (dom.tracesServiceOptions) dom.tracesServiceOptions.innerHTML = "";
      if (dom.tracesOperationOptions) dom.tracesOperationOptions.innerHTML = "";
    }
    if (tags) clearTagSelection();
    updateTagButton();
  }

  async function prefill() {
    if (!model.meta) await loadMeta().catch(() => null);
    const seq = ++model.prefillSeq;
    setButtonLoading(dom.tracesPrefillButton, true);
    showError("");
    try {
      const range = selectedRange();
      const payload = await api.prefillTraces(currentHost(), range);
      if (seq !== model.prefillSeq) return;
      model.prefillPairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
      const services = [...new Set(model.prefillPairs.map((pair) => String(pair?.[0] || "")).filter(Boolean))].sort();
      if (dom.tracesServiceOptions) dom.tracesServiceOptions.innerHTML = services.map((value) => `<option value="${esc(value)}"></option>`).join("");
      updateOperationOptions();
      if (payload?.truncated) showError("Service / operation prefill reached its 20,000-combination safety limit. Manual ILIKE search is still available.");
    } catch (error) {
      if (seq === model.prefillSeq) showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === model.prefillSeq) setButtonLoading(dom.tracesPrefillButton, false);
    }
  }

  async function loadTagKeys() {
    if (!String(dom.tracesService?.value || "").trim() || !String(dom.tracesOperation?.value || "").trim()) return;
    const seq = ++model.tagSeq;
    setButtonLoading(dom.tracesTagsButton, true);
    showError("");
    try {
      const filters = searchFilters({ includeTag: false });
      delete filters.status;
      delete filters.limit;
      const payload = await api.getTraceTags(currentHost(), filters);
      if (seq !== model.tagSeq) return;
      model.tagKeys = Array.isArray(payload?.keys) ? payload.keys : [];
      const keyList = document.getElementById("tracesTagKeyOptions");
      if (keyList) {
        const seen = new Set();
        keyList.innerHTML = model.tagKeys.map((row) => {
          const scope = String(row?.[0] || "span"), key = String(row?.[1] || "");
          if (!key) return "";
          const plainKey = key;
          const value = seen.has(plainKey) ? `${scope}:${key}` : plainKey;
          seen.add(plainKey);
          return `<option value="${esc(value)}"></option>`;
        }).join("");
      }
      await loadTagValues();
    } catch (error) {
      if (seq === model.tagSeq) showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === model.tagSeq) { setButtonLoading(dom.tracesTagsButton, false); updateTagButton(); }
    }
  }

  async function loadTagValues() {
    const tag = currentTag();
    const valueList = document.getElementById("tracesTagValueOptions");
    if (!tag.key) { if (valueList) valueList.innerHTML = ""; return; }
    const seq = ++model.tagSeq;
    setButtonLoading(dom.tracesTagsButton, true);
    try {
      const filters = searchFilters({ includeTag: false });
      delete filters.status;
      delete filters.limit;
      filters.tag_scope = tag.scope || "any";
      filters.tag_key = tag.key;
      const payload = await api.getTraceTags(currentHost(), filters);
      if (seq !== model.tagSeq) return;
      if (valueList) {
        const values = Array.isArray(payload?.values) ? payload.values : [];
        valueList.innerHTML = values.map((row) => `<option value="${esc(row?.[0] || "")}"></option>`).join("");
      }
    } catch (error) {
      if (seq === model.tagSeq) showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === model.tagSeq) { setButtonLoading(dom.tracesTagsButton, false); updateTagButton(); }
    }
  }

  function formatCustomRangeLabel() {
    const start = Date.parse(String(dom.tracesRangeStart?.value || ""));
    const end = Date.parse(String(dom.tracesRangeEnd?.value || ""));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return "Custom range…";
    const fmt = (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return `${fmt(start)} → ${fmt(end)}`;
  }

  function commitCustomRange() {
    if (String(dom.tracesRangeUnit?.value || "") !== "custom") return;
    const option = Array.from(dom.tracesRangeUnit?.options || []).find((item) => item.value === "custom");
    if (option) option.textContent = formatCustomRangeLabel();
    dom.tracesRangeUnit?.dispatchEvent(new Event("tracepicker-refresh"));
    try { selectedRange(); } catch (_) { return; }
    if (dom.tracesCustomRange) dom.tracesCustomRange.hidden = true;
  }

  async function search() {
    if (!model.meta) await loadMeta().catch(() => null);
    const seq = ++model.searchSeq;
    if (/\/traces\/[^/]+\/?$/.test(String(window.location.pathname || ""))) window.history.pushState({ workspace: "traces" }, "", route("traces"));
    setView(false);
    setButtonLoading(dom.tracesSearchButton, true);
    showError("");
    try {
      const payload = await api.searchTraces(currentHost(), searchFilters());
      if (seq !== model.searchSeq) return;
      unpackSearch(payload);
      renderResults();
    } catch (error) {
      if (seq !== model.searchSeq) return;
      model.traces = [];
      model.analytics = null;
      renderResults();
      showError(error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === model.searchSeq) setButtonLoading(dom.tracesSearchButton, false);
    }
  }

  async function loadTrace(traceId, { push = false } = {}) {
    const id = String(traceId || "").trim();
    if (!id) return;
    const seq = ++model.detailSeq;
    showError("");
    setView(true);
    if (dom.traceIdLookupInput) dom.traceIdLookupInput.value = id;
    if (dom.traceWaterfall) dom.traceWaterfall.innerHTML = '<div class="tracesEmpty">Loading trace…</div>';
    if (dom.traceInspector) { dom.traceInspector.hidden = true; dom.traceInspector.innerHTML = ""; }
    try {
      const trace = await api.getTrace(currentHost(), id);
      if (seq !== model.detailSeq) return;
      model.activeTrace = trace;
      model.activeSpanId = null;
      model.openSpanIds.clear();
      model.traceViewRange = [0, 1];
      model.disabledServices.clear();
      model.collapsed.clear();
      if (dom.traceSpanSearch) dom.traceSpanSearch.value = "";
      if (dom.traceSpanSearchCount) dom.traceSpanSearchCount.textContent = "";
      if (push) window.history.pushState({ traceId: id }, "", route(`traces/${encodeURIComponent(id)}`));
      renderTrace();
    } catch (error) {
      if (seq !== model.detailSeq) return;
      model.activeTrace = null;
      model.activeSpanId = null;
      model.openSpanIds.clear();
      model.traceViewRange = [0, 1];
      model.disabledServices.clear();
      model.collapsed.clear();
      renderTrace();
      showError(error instanceof Error ? error.message : String(error));
    }
  }

  function backToSearch({ push = true } = {}) {
    model.activeTrace = null;
    model.activeSpanId = null;
    model.openSpanIds.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    if (push) window.history.pushState({ workspace: "traces" }, "", route("traces"));
    if (dom.traceIdLookupInput) dom.traceIdLookupInput.value = "";
    setView(false);
    if (!model.traces.length) search();
  }

  async function reloadForHost() {
    model.meta = null;
    model.traces = [];
    model.analytics = null;
    model.prefillPairs = [];
    model.tagKeys = [];
    model.activeTrace = null;
    model.activeSpanId = null;
    model.openSpanIds.clear();
    model.traceViewRange = [0, 1];
    model.disabledServices.clear();
    model.collapsed.clear();
    renderResults();
    renderSource();
    try {
      await loadMeta();
      const id = traceIdFromPath();
      if (id) await loadTrace(id, { push: false });
      else await search();
    } catch (_) {}
  }

  function init() {
    ui?.setPageSelectorValue?.("traces");
    initTracePickers();
    dom.navQueryButton?.addEventListener("click", () => window.location.assign(route("query")));
    dom.navExplorerButton?.addEventListener("click", () => window.location.assign(route("explorer")));
    dom.navTracesButton?.addEventListener("click", () => ui?.closePageMenu?.());
    dom.tracesForm?.addEventListener("submit", (event) => { event.preventDefault(); search(); });
    dom.tracesSort?.addEventListener("change", renderResults);
    dom.tracesPrefillButton?.addEventListener("click", prefill);
    dom.tracesTagsButton?.addEventListener("click", loadTagKeys);
    dom.tracesTagKey?.addEventListener("change", () => {
      if (String(dom.tracesService?.value || "").trim() && String(dom.tracesOperation?.value || "").trim()) loadTagValues();
    });
    dom.tracesRangeUnit?.addEventListener("change", () => { syncRangeControls(); invalidateDiscovery(); });
    dom.tracesRangeStart?.addEventListener("change", () => invalidateDiscovery());
    dom.tracesRangeEnd?.addEventListener("change", () => invalidateDiscovery());
    dom.tracesService?.addEventListener("input", () => { clearTagSelection(); updateOperationOptions(); });
    dom.tracesOperation?.addEventListener("input", () => { clearTagSelection(); updateTagButton(); });
    dom.traceBackButton?.addEventListener("click", () => backToSearch({ push: true }));
    dom.traceSpanSearch?.addEventListener("input", renderWaterfall);
    dom.traceSpanSearch?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      const first = dom.traceWaterfall?.querySelector?.(".traceSpanRow.is-search-match");
      first?.scrollIntoView?.({ block: "center" });
      first?.focus?.({ preventScroll: true });
    });
    dom.traceSpanSearchClear?.addEventListener("click", () => {
      if (dom.traceSpanSearch) dom.traceSpanSearch.value = "";
      renderWaterfall();
      dom.traceSpanSearch?.focus?.();
    });
    dom.traceIdLookupForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      const id = String(dom.traceIdLookupInput?.value || "").trim();
      if (id) loadTrace(id, { push: true });
    });
    window.addEventListener("popstate", () => {
      const id = traceIdFromPath();
      if (id) loadTrace(id, { push: false });
      else backToSearch({ push: false });
    });
    window.addEventListener("chdash:host-changed", () => { reloadForHost(); });
    window.addEventListener("chdash:features-changed", (event) => {
      if (event?.detail?.traces?.enabled === false) return;
      if (!model.meta && currentHost()) reloadForHost();
    });
    const id = traceIdFromPath();
    if (id && dom.traceIdLookupInput) dom.traceIdLookupInput.value = id;
    setView(!!id);
    if (currentHost()) reloadForHost();
  }

  ns.traces = { init, search, loadTrace };
})();
