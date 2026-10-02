(() => {
  "use strict";
  // Trace search state after HyperDX's search page: the filter chips (several
  // tag filters with =, !=, exists and missing on span or resource attributes,
  // plus excluded services / operations / statuses), the whole search in the
  // URL (shareable, Back / Forward, reload), click-to-filter menus on shown
  // values and the attribute facets sidebar (DBSearchPageFilters).
  // app_traces.js calls install(ctx) with its model and helpers at init.
  const ns = window.ChDash;
  if (!ns) return;
  const fmt = ns.format;

  const TAG_OPS = ["=", "!=", "exists", "missing"];
  const TAG_PARAMS = { "=": "tag", "!=": "tag_not", exists: "tag_exists", missing: "tag_missing" };
  const COLUMN_NOT_PARAMS = { service: "service_not", operation: "operation_not", status: "status_not" };
  const OP_LABELS = { "=": "=", "!=": "!=", exists: "exists", missing: "missing" };
  const OP_NAMES = { "=": "equals", "!=": "differs from", exists: "exists", missing: "is missing" };
  // Every URL parameter of the search page (the detail page keeps them as
  // its "back to search" context; span / view are the detail's own).
  const SEARCH_PARAMS = ["from", "to", "status", "service", "operation", "limit", "sort", "results",
    "tag", "tag_not", "tag_exists", "tag_missing", "service_not", "operation_not", "status_not", "tab",
    "min_duration_ms", "max_duration_ms", "duration_view",
    "mode", "kind", "span_min_duration_ms", "span_max_duration_ms"];
  const PIN_STORE_KEY = ns.storage.KEYS.traceFacetPins;
  const COLLAPSED_STORE_KEY = ns.storage.KEYS.traceFacetsCollapsed;

  let ctx = null;
  const byId = (id) => document.getElementById(id);
  const esc = (value) => ctx.esc(value);

  const search = {
    chips: [],
    // Tag params of the last prefill, so a chip change refreshes the pickers.
    prefillTagKey: "",
    // Trace duration range in ms ({ min, max }, 0 = open side) or null: set
    // by the heatmap's "Search traces in this box", shown as a chip.
    duration: null,
  };

  // ------------------------------------------------------------------ chips

  // "[span:|resource:]rest" -> { scope, rest }.
  function splitScope(text) {
    const raw = String(text || "");
    for (const scope of ["span", "resource"]) {
      if (raw.length > scope.length + 1 && raw.startsWith(`${scope}:`)) return { scope, rest: raw.slice(scope.length + 1) };
    }
    return { scope: "any", rest: raw };
  }

  function scopePrefix(scope) {
    return scope === "span" || scope === "resource" ? `${scope}:` : "";
  }

  function sameChip(a, b) {
    return a.kind === b.kind && a.op === b.op && (a.scope || "any") === (b.scope || "any") && (a.key || "") === (b.key || "") && (a.value || "") === (b.value || "");
  }

  function chipParam(chip) {
    if (chip.kind === "tag") {
      const key = `${scopePrefix(chip.scope)}${chip.key}`;
      return [TAG_PARAMS[chip.op], chip.op === "=" || chip.op === "!=" ? `${key}=${chip.value}` : key];
    }
    return [COLUMN_NOT_PARAMS[chip.kind], chip.value];
  }

  // API / URL parameters of the chips.
  function chipParams({ tagsOnly = false } = {}) {
    const out = {};
    if (!tagsOnly && search.duration) {
      if (search.duration.min > 0) out.min_duration_ms = [String(search.duration.min)];
      if (search.duration.max > 0) out.max_duration_ms = [String(search.duration.max)];
    }
    for (const chip of search.chips) {
      if (tagsOnly && chip.kind !== "tag") continue;
      const [name, value] = chipParam(chip);
      (out[name] = out[name] || []).push(value);
    }
    return out;
  }

  function chipsFromParams(params) {
    const chips = [];
    for (const op of TAG_OPS) {
      for (const raw of params.getAll(TAG_PARAMS[op])) {
        const { scope, rest } = splitScope(raw);
        if (op === "=" || op === "!=") {
          const eq = rest.indexOf("=");
          if (eq <= 0) continue;
          chips.push({ kind: "tag", op, scope, key: rest.slice(0, eq), value: rest.slice(eq + 1) });
        } else if (rest) {
          chips.push({ kind: "tag", op, scope, key: rest, value: "" });
        }
      }
    }
    for (const [kind, name] of Object.entries(COLUMN_NOT_PARAMS)) {
      for (const value of params.getAll(name)) if (value) chips.push({ kind, op: "!=", scope: "any", key: kind, value });
    }
    const unique = [];
    for (const chip of chips) if (!unique.some((other) => sameChip(other, chip))) unique.push(chip);
    return unique;
  }

  function durationFromParams(params) {
    const read = (name) => { const n = Number(params.get(name) || 0); return Number.isFinite(n) && n > 0 ? n : 0; };
    const min = read("min_duration_ms"), max = read("max_duration_ms");
    return min || max ? { min, max: max && max < min ? 0 : max } : null;
  }

  function durationText(ms) {
    return fmt.duration.fromMs(ms);
  }

  function durationLabel(duration) {
    if (duration.min && duration.max) return `${durationText(duration.min)} \u2013 ${durationText(duration.max)}`;
    return duration.min ? `\u2265 ${durationText(duration.min)}` : `\u2264 ${durationText(duration.max)}`;
  }

  // Sets (or clears, with null) the trace duration filter; the caller searches.
  function setDuration(duration) {
    const min = Math.max(0, Number(duration?.min || 0));
    const max = Math.max(0, Number(duration?.max || 0));
    search.duration = min || max ? { min, max } : null;
    renderChips();
  }

  function addChip(chip) {
    // A value is either included or excluded, never both.
    const opposite = chip.op === "=" ? "!=" : chip.op === "!=" ? "=" : chip.op === "exists" ? "missing" : "exists";
    search.chips = search.chips.filter((other) => !sameChip(other, { ...chip, op: opposite }));
    if (!search.chips.some((other) => sameChip(other, chip))) search.chips.push({ scope: "any", key: "", value: "", ...chip });
    renderChips();
  }

  function removeChip(chip) {
    search.chips = search.chips.filter((other) => !sameChip(other, chip));
    renderChips();
  }

  function chipLabel(chip) {
    const key = chip.kind === "tag" ? chip.key : chip.kind;
    const value = chip.op === "=" || chip.op === "!=" ? ` ${chip.value}` : "";
    return `${chip.kind === "tag" ? scopePrefix(chip.scope) : ""}${key} ${OP_LABELS[chip.op]}${value}`;
  }

  function renderChips() {
    const root = byId("tracesFilterChips");
    if (!root) return;
    const count = search.chips.length + (search.duration ? 1 : 0);
    root.hidden = !count;
    const durationChip = search.duration
      ? `<span class="traceFilterChip traceFilterChip--duration" role="listitem" data-chip-kind="duration" title="${esc(`trace duration ${durationLabel(search.duration)}`)}"><span class="traceFilterChip__key">duration</span><span class="traceFilterChip__value">${esc(durationLabel(search.duration))}</span><button type="button" class="traceFilterChip__remove" data-chip-duration-remove aria-label="Remove filter trace duration ${esc(durationLabel(search.duration))}" title="Remove filter">×</button></span>`
      : "";
    root.innerHTML = durationChip + search.chips.map((chip, index) => {
      const negated = chip.op === "!=" || chip.op === "missing";
      const scope = chip.kind === "tag" && chip.scope !== "any" ? `<span class="traceFilterChip__scope">${esc(chip.scope)}</span>` : "";
      const key = chip.kind === "tag" ? chip.key : chip.kind;
      const valued = chip.op === "=" || chip.op === "!=";
      const toggle = chip.kind === "tag";
      const next = { "=": "!=", "!=": "=", exists: "missing", missing: "exists" }[chip.op];
      const op = toggle
        ? `<button type="button" class="traceFilterChip__op" data-chip-op="${index}" title="Switch to ${esc(OP_LABELS[next])}" aria-label="Switch ${esc(key)} to ${esc(OP_NAMES[next])}">${esc(OP_LABELS[chip.op])}</button>`
        : `<span class="traceFilterChip__op">${esc(OP_LABELS[chip.op])}</span>`;
      return `<span class="traceFilterChip${negated ? " is-negated" : ""}" role="listitem" data-chip-index="${index}" data-chip-kind="${esc(chip.kind)}" data-chip-op-value="${esc(chip.op)}" title="${esc(chipLabel(chip))}">${scope}<span class="traceFilterChip__key">${esc(key)}</span>${op}${valued ? `<span class="traceFilterChip__value">${esc(chip.value === "" ? '""' : chip.value)}</span>` : ""}<button type="button" class="traceFilterChip__remove" data-chip-remove="${index}" aria-label="Remove filter ${esc(chipLabel(chip))}" title="Remove filter">×</button></span>`;
    }).join("") + (count > 1 ? '<button type="button" class="traceFilterChips__clear" data-chips-clear>Clear filters</button>' : "");
  }

  function onChipsClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const remove = target.closest("[data-chip-remove]");
    const toggle = target.closest("[data-chip-op]");
    if (target.closest("[data-chips-clear]")) {
      search.chips = [];
      search.duration = null;
      renderChips();
    } else if (target.closest("[data-chip-duration-remove]")) {
      search.duration = null;
      renderChips();
    } else if (remove) {
      const chip = search.chips[Number(remove.getAttribute("data-chip-remove"))];
      if (!chip) return;
      removeChip(chip);
    } else if (toggle) {
      const chip = search.chips[Number(toggle.getAttribute("data-chip-op"))];
      if (!chip) return;
      chip.op = { "=": "!=", "!=": "=", exists: "missing", missing: "exists" }[chip.op];
      renderChips();
    } else {
      return;
    }
    void ctx.runSearch({ url: "push" });
  }

  // --------------------------------------------------------- tag input row

  function tagOpButton() { return byId("tracesTagOp"); }

  function setTagOp(op) {
    const button = tagOpButton();
    const value = TAG_OPS.includes(op) ? op : "=";
    if (button) {
      button.dataset.op = value;
      button.textContent = OP_LABELS[value];
      button.setAttribute("aria-label", `Tag operator: ${OP_NAMES[value]}`);
    }
    const input = byId("tracesTagValue");
    if (input) {
      const valueless = value === "exists" || value === "missing";
      input.disabled = valueless || !!byId("tracesTagKey")?.disabled;
      input.placeholder = valueless ? "(any value)" : "Value";
      if (valueless) input.value = "";
    }
  }

  function tagOp() { return tagOpButton()?.dataset.op || "="; }

  // The Tag / Value inputs add a chip (on Search or Enter). Throws on a half
  // filled pair.
  function commitPendingTag() {
    const pending = ctx.currentTag();
    const op = tagOp();
    const valued = op === "=" || op === "!=";
    if (!pending.key && pending.value === "") return false;
    if (!pending.key || (valued && pending.value === "")) throw new Error("Tag and value must both be provided.");
    const { scope, rest } = splitScope(pending.key);
    addChip({ kind: "tag", op, scope, key: rest, value: valued ? pending.value : "" });
    const keyInput = byId("tracesTagKey");
    const valueInput = byId("tracesTagValue");
    if (keyInput) keyInput.value = "";
    if (valueInput) valueInput.value = "";
    setTagOp("=");
    return true;
  }

  // ------------------------------------------------------------- URL state

  function selectHas(select, value) {
    return !!select && Array.from(select.options).some((option) => option.value === value && !option.disabled);
  }

  function setSelect(select, value) {
    if (!select) return;
    select.value = value;
    select.dispatchEvent(new Event("tracepicker-refresh"));
  }

  // A service / operation applied from a URL or a filter action stays
  // selected even when the discovered pairs do not list it (yet).
  function wantSelect(select, value) {
    if (!select) return;
    if (value) select.dataset.wanted = value;
    else delete select.dataset.wanted;
  }

  function currentParams() {
    const { dom, model } = ctx;
    const params = new URLSearchParams();
    if (model.timeRangeTouched && model.timeRange?.from && model.timeRange?.to) {
      params.set("from", model.timeRange.from);
      params.set("to", model.timeRange.to);
    }
    const status = String(dom.tracesStatus?.value || "");
    if (status) params.set("status", status);
    const service = String(dom.tracesService?.value || "");
    if (service) params.set("service", service);
    const operation = String(dom.tracesOperation?.value || "");
    if (operation) params.set("operation", operation);
    for (const [name, values] of Object.entries(chipParams())) for (const value of values) params.append(name, value);
    const limit = String(dom.tracesLimit?.value || "");
    if (limit && limit !== "50") params.set("limit", limit);
    const sort = String(dom.tracesSort?.value || "recent");
    if (sort !== "recent") params.set("sort", sort);
    if (model.resultsView === "table") params.set("results", "table");
    // The selected tab (app_trace_tabs.js), e.g. tab=map.
    ns.traceTabs?.writeParams?.(params);
    ns.traceHeatmap?.writeParams?.(params);
    // Spans mode (app_trace_spans.js): mode=spans and its span filters.
    ns.traceSpans?.urlParams?.(params);
    return params;
  }

  // The search context carried by trace detail URLs.
  // The search a trace URL carries: not the span of the Spans side panel
  // (span= names the trace's own span there).
  function contextQuery() {
    if (!ctx) return "";
    const params = currentParams();
    params.delete("span");
    return params.toString();
  }

  function searchKey() {
    const params = currentParams();
    params.delete("span");
    params.delete("sort");
    params.delete("results");
    params.delete("tab");
    params.delete("duration_view");
    for (const name of ns.traceTabs?.viewParams?.() || []) params.delete(name);
    return params.toString();
  }

  function searchUrl() {
    const query = currentParams().toString();
    return `${ctx.route("observability/traces")}${query ? `?${query}` : ""}`;
  }

  // mode: "push" (a new search), "replace" (same entry, e.g. the page-load
  // search or a view toggle) or "none" (restored from history).
  // state: more history state for a pushed entry ({ detail }: the entry a
  // detail panel opened, which its close takes Back).
  function writeUrl(mode = "push", state = null) {
    if (mode === "none" || !ctx) return;
    // Another Observability view owns the location (app_observability.js).
    if (ns.observability && !ns.observability.isActive("traces")) return;
    const next = searchUrl();
    const current = `${window.location.pathname}${window.location.search}`;
    if (next === current) return;
    if (mode === "push") window.history.pushState({ ...(state || {}), workspace: "traces" }, "", next);
    else window.history.replaceState({ ...(window.history.state || {}), workspace: "traces" }, "", next);
  }

  function hasSearchParams(params) {
    return SEARCH_PARAMS.some((name) => params.has(name)) || !!ns.traceTabs?.hasParams?.(params);
  }

  // Controls, range and chips from URL parameters (the search page or a
  // trace detail URL carrying its search context).
  function applyParams(params, { initial = false } = {}) {
    const { dom, model } = ctx;
    ns.traceTabs?.applyParams?.(params, { initial });
    const tr = ns.timeRange;
    const from = params.get("from") || "";
    const to = params.get("to") || "";
    const validRange = from && to && tr && Number.isFinite(tr.resolveRange({ from, to }, Date.now()).startMs);
    if (validRange) {
      model.timeRange = { from, to };
      model.timeRangeTouched = true;
    } else if (!initial) {
      model.timeRangeTouched = false;
    }
    ctx.syncRange();
    const status = params.get("status") || "";
    setSelect(dom.tracesStatus, selectHas(dom.tracesStatus, status) ? status : "");
    const service = params.get("service") || "";
    const operation = params.get("operation") || "";
    wantSelect(dom.tracesService, service);
    wantSelect(dom.tracesOperation, operation);
    ctx.refreshServiceOperationOptions();
    // Back / Forward restore the entry's own choice (none included).
    setSelect(dom.tracesService, service);
    setSelect(dom.tracesOperation, operation);
    const limit = params.get("limit") || "50";
    if (selectHas(dom.tracesLimit, limit)) setSelect(dom.tracesLimit, limit);
    const sort = params.get("sort") || "recent";
    setSelect(dom.tracesSort, selectHas(dom.tracesSort, sort) ? sort : "recent");
    const results = params.get("results");
    if (results === "table" || results === "list") ctx.setResultsView(results, { persist: false });
    else if (!initial || hasSearchParams(params)) ctx.setResultsView("list", { persist: false });
    ns.traceSpans?.applyParams?.(params);
    search.chips = chipsFromParams(params);
    search.duration = durationFromParams(params);
    renderChips();
    ns.traceHeatmap?.applyParams?.(params, { initial });
  }

  function applyLocation({ initial = false } = {}) {
    if (!ctx) return;
    applyParams(new URLSearchParams(window.location.search), { initial });
  }

  // --------------------------------------------------- click-to-filter menu

  // An ns.menu context menu under the clicked value (app_ui_menu.js: keys,
  // focus back on the value, outside click, Escape, scroll and resize).
  let menu = null;
  let menuTarget = null;
  let menuHandle = null;

  function closeMenu() {
    menuHandle?.close({ focus: false });
  }

  function fieldLabel(field) {
    if (field.kind === "tag") return `${scopePrefix(field.scope)}${field.key}`;
    return field.kind;
  }

  function openMenu(anchor, field, value) {
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "traceFilterMenu";
      menu.id = "traceFilterMenu";
      menu.setAttribute("role", "menu");
      menu.hidden = true;
      menu.addEventListener("click", onMenuClick);
    }
    closeMenu();
    menu.dataset.field = JSON.stringify(field);
    menu.dataset.value = value;
    const text = value === "" ? '""' : value;
    menu.innerHTML = `<div class="traceFilterMenu__title" title="${esc(`${fieldLabel(field)} = ${value}`)}"><span>${esc(fieldLabel(field))}</span><b>${esc(text)}</b></div>`
      + '<button type="button" class="traceFilterMenu__item" role="menuitem" data-filter-action="include">Filter for this value</button>'
      + '<button type="button" class="traceFilterMenu__item" role="menuitem" data-filter-action="exclude">Exclude this value</button>'
      + '<button type="button" class="traceFilterMenu__item" role="menuitem" data-filter-action="only">Search only this</button>'
      + '<button type="button" class="traceFilterMenu__item" role="menuitem" data-filter-action="copy">Copy</button>';
    menuTarget = anchor;
    menuHandle = ns.menu?.context(menu, { anchor, returnFocus: anchor, expanded: anchor, remove: false, onClose: () => { menuTarget = null; menuHandle = null; } }) || null;
  }

  // Applies one filter action and searches (from the detail page too: the
  // search view comes back with the filter applied).
  function applyFilter(field, value, action) {
    const { dom } = ctx;
    if (action === "only") {
      search.chips = [];
      search.duration = null;
      setSelect(dom.tracesStatus, "");
      wantSelect(dom.tracesService, "");
      wantSelect(dom.tracesOperation, "");
      setSelect(dom.tracesService, "");
      setSelect(dom.tracesOperation, "");
    }
    const include = action !== "exclude";
    if (field.kind === "tag") {
      addChip({ kind: "tag", op: include ? "=" : "!=", scope: field.scope || "any", key: field.key, value });
    } else if (include) {
      search.chips = search.chips.filter((chip) => !(chip.kind === field.kind && chip.value === value));
      if (field.kind === "status") {
        setSelect(dom.tracesStatus, selectHas(dom.tracesStatus, value) ? value : "");
      } else {
        const select = field.kind === "service" ? dom.tracesService : dom.tracesOperation;
        wantSelect(select, value);
        ctx.refreshServiceOperationOptions();
        setSelect(select, value);
        ctx.syncServiceOperationPair(field.kind);
      }
      renderChips();
    } else {
      const select = field.kind === "service" ? dom.tracesService : field.kind === "operation" ? dom.tracesOperation : dom.tracesStatus;
      if (String(select?.value || "") === value) {
        wantSelect(select, "");
        setSelect(select, "");
      }
      addChip({ kind: field.kind, op: "!=", scope: "any", key: field.kind, value });
    }
    void ctx.runSearch({ url: "push" });
  }

  function onMenuClick(event) {
    const item = event.target instanceof Element ? event.target.closest("[data-filter-action]") : null;
    if (!item || !menu) return;
    let field = null;
    try { field = JSON.parse(menu.dataset.field || "null"); } catch (_) { field = null; }
    const value = String(menu.dataset.value || "");
    const action = item.getAttribute("data-filter-action");
    const anchor = menuTarget;
    closeMenu();
    if (!field) return;
    if (action === "copy") { ctx.copyText(value, anchor); return; }
    applyFilter(field, value, action);
  }

  // What a click landed on: a value that can become a filter.
  function filterTrigger(target) {
    const kvButton = target.closest("[data-kv-filter]");
    const kvValue = kvButton ? null : target.closest(".traceKv__row[data-filter-scope] .traceKv__v, .traceKv__row[data-filter-scope] .traceKv__tree > .traceJson > summary");
    const kv = kvButton || kvValue;
    if (kv) {
      const row = kv.closest(".traceKv__row[data-filter-scope]");
      if (!row) return null;
      let value = null;
      try { value = JSON.parse(row.getAttribute("data-kv-json") || "null"); } catch (_) { value = null; }
      const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
      return { anchor: kv, field: { kind: "tag", scope: row.getAttribute("data-filter-scope"), key: row.getAttribute("data-kv-key") || "" }, value: text };
    }
    const direct = target.closest("[data-filter-field]");
    if (direct) {
      const kind = direct.getAttribute("data-filter-field");
      const field = kind === "tag"
        ? { kind, scope: direct.getAttribute("data-filter-scope") || "any", key: direct.getAttribute("data-filter-key") || "" }
        : { kind };
      return { anchor: direct, field, value: direct.getAttribute("data-filter-value") || "" };
    }
    const pill = target.closest("#tracesResults .traceSvcPill[data-service]");
    if (pill) return { anchor: pill, field: { kind: "service" }, value: pill.getAttribute("data-service") || "" };
    return null;
  }

  function onDocumentClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (menu && !menu.hidden && menu.contains(target)) return;
    // Text being selected in a value is not a click on it.
    const selection = window.getSelection?.();
    const trigger = filterTrigger(target);
    if (trigger && !(selection && !selection.isCollapsed && trigger.anchor.contains(selection.anchorNode))) {
      if (trigger.field.kind === "tag" && !trigger.field.key) return;
      event.preventDefault();
      event.stopPropagation();
      if (menuTarget === trigger.anchor && menu && !menu.hidden) { closeMenu(); return; }
      openMenu(trigger.anchor, trigger.field, trigger.value);
    }
  }

  function onDocumentKeydown(event) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target instanceof Element ? event.target : null;
    const direct = target?.closest?.("[data-filter-field]");
    if (!direct || direct !== target) return;
    event.preventDefault();
    event.stopPropagation();
    const trigger = filterTrigger(direct);
    if (trigger) openMenu(trigger.anchor, trigger.field, trigger.value);
  }

  // ---------------------------------------------------------------- facets

  // The Attributes sidebar: the facets panel shared with the Logs Fields
  // panel (app_facet_panel.js) over /api/traces/facets and facet_values, the
  // chips as its filters.
  let facets = null;

  function facetFilterParams(filters) {
    const out = { ...(filters || {}) };
    for (const name of ["limit", "min_duration_ms", "max_duration_ms", "align_buckets", "bucket_origin_ms", "charts", "tag_scope", "tag_key", "tag_value"]) delete out[name];
    return out;
  }

  function facetFilterKey(filters) {
    const params = facetFilterParams(filters);
    // Minute-aligned like the server's cache: a re-search within the minute
    // does not refetch.
    return JSON.stringify({ ...params, start_ms: Math.floor(Number(params.start_ms) / 60000), end_ms: Math.ceil(Number(params.end_ms) / 60000) });
  }

  function chipMatches(chip, scope, key, value, op) {
    return chip.kind === "tag" && chip.op === op && chip.key === key && (chip.scope === scope || chip.scope === "any") && chip.value === value;
  }

  function createFacets() {
    return ns.facetPanel.create({
      ids: { panel: "traceFacets", toggle: "traceFacetsToggle", meta: "traceFacetsMeta", search: "traceFacetsSearch", list: "traceFacetsList" },
      collapsedClass: "chdash-trace-facets-collapsed",
      // A phone: the panel is a drawer, toggled from the top of the results.
      drawerHost: document.querySelector(".traceSearchMain"),
      collapsedStoreKey: COLLAPSED_STORE_KEY,
      pinStoreKey: PIN_STORE_KEY,
      label: "attributes",
      noun: ["span", "spans"],
      scopes: { span: { badge: "S", title: "Span attribute" }, resource: { badge: "R", title: "Resource attribute" } },
      enabled: () => ctx?.model?.meta?.tag_search_supported !== false,
      filterKey: facetFilterKey,
      fetchKeys: async (filters, { signal } = {}) => {
        const payload = await ctx.api.getTraceFacets(ctx.currentHost(), facetFilterParams(filters), { signal });
        return {
          supported: payload?.supported !== false,
          unsupportedText: "This trace table does not keep span attributes.",
          keys: (Array.isArray(payload?.keys) ? payload.keys : []).map((row) => ({ scope: String(row?.[0] || ""), key: String(row?.[1] || ""), count: Number(row?.[2] || 0) })),
          estimated: payload?.estimated === true,
          timedOut: payload?.timed_out === true,
          sampled: Number(payload?.sampled_spans || 0),
        };
      },
      fetchValues: async (filters, scope, key, limit, { signal } = {}) => {
        const payload = await ctx.api.getTraceFacetValues(ctx.currentHost(), { ...facetFilterParams(filters), scope, key, limit: String(limit) }, { signal });
        return {
          values: (Array.isArray(payload?.values) ? payload.values : []).map((row) => ({ value: String(row?.[0] ?? ""), count: Number(row?.[1] || 0) })),
          estimated: payload?.estimated === true,
          hasMore: payload?.has_more === true,
        };
      },
      // The chips on the key: = values checked, != values excluded; an
      // exists / missing chip marks the key active.
      filtered: (scope, key) => {
        const out = { include: [], exclude: [], active: false };
        for (const chip of search.chips) {
          if (chip.kind !== "tag" || chip.key !== key || (chip.scope !== scope && chip.scope !== "any")) continue;
          out.active = true;
          if (chip.op === "=") out.include.push(chip.value);
          else if (chip.op === "!=") out.exclude.push(chip.value);
        }
        return out;
      },
      onInclude: (scope, key, value, checked) => {
        const existing = search.chips.find((other) => chipMatches(other, scope, key, value, "="));
        if (checked && !existing) addChip({ kind: "tag", op: "=", scope, key, value });
        if (!checked && existing) removeChip(existing);
        void ctx.runSearch({ url: "push" });
      },
      onExclude: (scope, key, value) => {
        const existing = search.chips.find((other) => chipMatches(other, scope, key, value, "!="));
        if (existing) removeChip(existing); else addChip({ kind: "tag", op: "!=", scope, key, value });
        void ctx.runSearch({ url: "push" });
      },
    });
  }

  // ---------------------------------------------------------------- wiring

  function install(context) {
    ctx = context;
    renderChips();
    setTagOp("=");
    byId("tracesFilterChips")?.addEventListener("click", onChipsClick);
    tagOpButton()?.addEventListener("click", () => {
      const next = TAG_OPS[(TAG_OPS.indexOf(tagOp()) + 1) % TAG_OPS.length];
      setTagOp(next);
    });
    // Values anywhere in the Traces view open the menu (ns.menu closes it on
    // a scroll or a resize). Bound while the view shows (ns.lifecycle).
    ns.lifecycle.bind("traces", (scope) => {
      scope.listen(document, "click", onDocumentClick, true);
      scope.listen(document, "keydown", onDocumentKeydown, true);
      scope.add(() => closeMenu());
    });
    facets = createFacets();
    // A user's own service / operation choice replaces an applied one.
    for (const select of [ctx.dom.tracesService, ctx.dom.tracesOperation]) {
      select?.addEventListener("change", () => wantSelect(select, ""));
    }
  }

  // Tag params of the chips for the service / operation prefill; true when
  // they changed since the last prefill.
  function prefillTagParams() {
    return chipParams({ tagsOnly: true });
  }

  function prefillTagsChanged() {
    return JSON.stringify(prefillTagParams()) !== search.prefillTagKey;
  }

  function notePrefillTags(params) {
    search.prefillTagKey = JSON.stringify(params || {});
  }

  // A search for one service / operation (and optionally traces lasting at
  // least minDurationMs: the duration chip, min_duration_ms), e.g. from the
  // Services view; other filters stay.
  function applySearch({ service = "", operation = "", minDurationMs = 0 } = {}) {
    const { dom } = ctx;
    wantSelect(dom.tracesService, service);
    wantSelect(dom.tracesOperation, operation);
    ctx.refreshServiceOperationOptions();
    setSelect(dom.tracesService, service);
    setSelect(dom.tracesOperation, operation);
    search.chips = search.chips.filter((chip) => !(chip.kind === "service" && chip.value === service) && !(chip.kind === "operation" && chip.value === operation));
    const ms = Number(minDurationMs);
    setDuration(ms > 0 ? { min: Math.round(ms * 1000) / 1000, max: 0 } : null);
  }

  function resetFacets() {
    facets?.reset();
  }

  // Filters beyond the time range: status, service, operation, chips, duration.
  function hasFilters() {
    if (!ctx) return false;
    const { dom } = ctx;
    return !!(dom.tracesStatus?.value || dom.tracesService?.value || dom.tracesOperation?.value || search.chips.length || search.duration);
  }

  // "Clear filters" of an empty result: the range, limit and sort stay.
  function clearFilters() {
    if (!ctx) return;
    const { dom } = ctx;
    setSelect(dom.tracesStatus, "");
    wantSelect(dom.tracesService, "");
    wantSelect(dom.tracesOperation, "");
    ctx.refreshServiceOperationOptions();
    setSelect(dom.tracesService, "");
    setSelect(dom.tracesOperation, "");
    search.chips = [];
    search.duration = null;
    renderChips();
  }

  ns.traceSearch = {
    install,
    chipParams,
    applyFilter,
    commitPendingTag,
    contextQuery,
    searchKey,
    writeUrl,
    applyLocation,
    hasSearchParams: () => hasSearchParams(new URLSearchParams(window.location.search)),
    onSearched: (filters) => { void facets?.load(filters); },
    resetFacets,
    hasFilters,
    clearFilters,
    applySearch,
    prefillTagParams,
    prefillTagsChanged,
    notePrefillTags,
    closeMenu,
    // Click-to-filter from other modules (the heatmap comparison panel):
    // field is { kind: "tag", scope, key } or { kind: "service" | "operation" | "status" }.
    filter: (field, value) => applyFilter(field, value, "include"),
    exclude: (field, value) => applyFilter(field, value, "exclude"),
    setDuration,
    // Discovered attribute keys (the span table's column picker suggests them).
    facetKeys: () => facets?.keys() || [],
  };
})();
