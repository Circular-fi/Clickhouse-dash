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

  const TAG_OPS = ["=", "!=", "exists", "missing"];
  const TAG_PARAMS = { "=": "tag", "!=": "tag_not", exists: "tag_exists", missing: "tag_missing" };
  const COLUMN_NOT_PARAMS = { service: "service_not", operation: "operation_not", status: "status_not" };
  const OP_LABELS = { "=": "=", "!=": "!=", exists: "exists", missing: "missing" };
  const OP_NAMES = { "=": "equals", "!=": "differs from", exists: "exists", missing: "is missing" };
  // Every URL parameter of the search page (the detail page keeps them as
  // its "back to search" context; span / view are the detail's own).
  const SEARCH_PARAMS = ["from", "to", "status", "service", "operation", "limit", "sort", "results",
    "tag", "tag_not", "tag_exists", "tag_missing", "service_not", "operation_not", "status_not"];
  const PIN_STORE_KEY = "chdash.traceFacetPins.v1";
  const COLLAPSED_STORE_KEY = "chdash.traceFacetsCollapsed.v1";
  const KEYS_PAGE = 20;
  const VALUE_LIMITS = [10, 50, 200, 500];

  let ctx = null;
  const byId = (id) => document.getElementById(id);
  const esc = (value) => ctx.esc(value);

  const search = {
    chips: [],
    // Tag params of the last prefill, so a chip change refreshes the pickers.
    prefillTagKey: "",
  };

  const facets = {
    seq: 0,
    filterKey: "",
    filters: null,
    keys: [],
    supported: true,
    estimated: false,
    timedOut: false,
    sampled: 0,
    loading: false,
    error: "",
    shown: KEYS_PAGE,
    query: "",
    // "scope\x1fkey" -> { limit, values, loading, error, estimated, hasMore, seq }
    expanded: new Map(),
    pins: readPins(),
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
    root.hidden = !search.chips.length;
    root.innerHTML = search.chips.map((chip, index) => {
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
    }).join("") + (search.chips.length > 1 ? '<button type="button" class="traceFilterChips__clear" data-chips-clear>Clear filters</button>' : "");
  }

  function onChipsClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const remove = target.closest("[data-chip-remove]");
    const toggle = target.closest("[data-chip-op]");
    if (target.closest("[data-chips-clear]")) {
      search.chips = [];
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
    return params;
  }

  // The search context carried by trace detail URLs.
  function contextQuery() {
    return ctx ? currentParams().toString() : "";
  }

  function searchKey() {
    const params = currentParams();
    params.delete("sort");
    params.delete("results");
    return params.toString();
  }

  function searchUrl() {
    const query = currentParams().toString();
    return `${ctx.route("traces")}${query ? `?${query}` : ""}`;
  }

  // mode: "push" (a new search), "replace" (same entry, e.g. the page-load
  // search or a view toggle) or "none" (restored from history).
  function writeUrl(mode = "push") {
    if (mode === "none" || !ctx) return;
    const next = searchUrl();
    const current = `${window.location.pathname}${window.location.search}`;
    if (next === current) return;
    if (mode === "push") window.history.pushState({ workspace: "traces" }, "", next);
    else window.history.replaceState({ ...(window.history.state || {}), workspace: "traces" }, "", next);
  }

  function hasSearchParams(params) {
    return SEARCH_PARAMS.some((name) => params.has(name));
  }

  // Controls, range and chips from URL parameters (the search page or a
  // trace detail URL carrying its search context).
  function applyParams(params, { initial = false } = {}) {
    const { dom, model } = ctx;
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
    const limit = params.get("limit") || "50";
    if (selectHas(dom.tracesLimit, limit)) setSelect(dom.tracesLimit, limit);
    const sort = params.get("sort") || "recent";
    setSelect(dom.tracesSort, selectHas(dom.tracesSort, sort) ? sort : "recent");
    const results = params.get("results");
    if (results === "table" || results === "list") ctx.setResultsView(results, { persist: false });
    else if (!initial || hasSearchParams(params)) ctx.setResultsView("list", { persist: false });
    search.chips = chipsFromParams(params);
    renderChips();
  }

  function applyLocation({ initial = false } = {}) {
    if (!ctx) return;
    applyParams(new URLSearchParams(window.location.search), { initial });
  }

  // --------------------------------------------------- click-to-filter menu

  let menu = null;
  let menuTarget = null;

  function closeMenu() {
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    menuTarget?.setAttribute?.("aria-expanded", "false");
    menuTarget = null;
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
      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); const back = menuTarget; closeMenu(); back?.focus?.({ preventScroll: true }); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...menu.querySelectorAll("[role=menuitem]")];
          const at = items.indexOf(document.activeElement);
          items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      });
      document.body.appendChild(menu);
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
    menu.hidden = false;
    menuTarget = anchor;
    anchor?.setAttribute?.("aria-expanded", "true");
    const box = anchor.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - size.width - 8, box.left));
    const below = box.bottom + 4;
    const top = below + size.height > window.innerHeight - 8 ? Math.max(8, box.top - size.height - 4) : below;
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.querySelector("[role=menuitem]")?.focus({ preventScroll: true });
  }

  // Applies one filter action and searches (from the detail page too: the
  // search view comes back with the filter applied).
  function applyFilter(field, value, action) {
    const { dom } = ctx;
    if (action === "only") {
      search.chips = [];
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
      return;
    }
    closeMenu();
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

  function readPins() {
    try {
      const saved = JSON.parse(localStorage.getItem(PIN_STORE_KEY) || "[]");
      return Array.isArray(saved) ? saved.filter((item) => Array.isArray(item) && item.length === 2).map(([scope, key]) => `${scope}\x1f${key}`) : [];
    } catch (_) {
      return [];
    }
  }

  function savePins() {
    try { localStorage.setItem(PIN_STORE_KEY, JSON.stringify(facets.pins.map((id) => id.split("\x1f")))); } catch (_) { /* optional */ }
  }

  const facetId = (scope, key) => `${scope}\x1f${key}`;

  function collapsed() {
    return document.documentElement.classList.contains("chdash-trace-facets-collapsed");
  }

  function setCollapsed(value) {
    document.documentElement.classList.toggle("chdash-trace-facets-collapsed", value);
    try { localStorage.setItem(COLLAPSED_STORE_KEY, value ? "1" : "0"); } catch (_) { /* optional */ }
    syncToggle();
    if (!value && facets.filters && facets.filterKey !== facetFilterKey(facets.filters)) void loadFacets(facets.filters);
    else if (!value) renderFacets();
  }

  function syncToggle() {
    const button = byId("traceFacetsToggle");
    if (!button) return;
    const open = !collapsed();
    button.setAttribute("aria-expanded", open ? "true" : "false");
    button.title = open ? "Hide attributes" : "Show attributes";
  }

  function compactCount(value) {
    const n = Number(value || 0);
    if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, "")}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
    return String(n);
  }

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

  function facetsEnabled() {
    return ctx?.model?.meta?.tag_search_supported !== false;
  }

  // After every search: the keys for the new filters, then the values of the
  // expanded keys. Skipped while the sidebar is hidden.
  async function loadFacets(filters) {
    facets.filters = filters;
    const panel = byId("traceFacets");
    if (panel) panel.hidden = !facetsEnabled();
    if (!facetsEnabled() || collapsed()) return;
    const key = facetFilterKey(filters);
    facets.filterKey = key;
    const seq = ++facets.seq;
    facets.loading = true;
    facets.error = "";
    renderFacets();
    try {
      const payload = await ctx.api.getTraceFacets(ctx.currentHost(), facetFilterParams(filters));
      if (seq !== facets.seq) return;
      facets.supported = payload?.supported !== false;
      facets.keys = (Array.isArray(payload?.keys) ? payload.keys : []).map((row) => ({ scope: String(row?.[0] || ""), key: String(row?.[1] || ""), count: Number(row?.[2] || 0) }));
      facets.estimated = payload?.estimated === true;
      facets.timedOut = payload?.timed_out === true;
      facets.sampled = Number(payload?.sampled_spans || 0);
    } catch (error) {
      if (seq !== facets.seq) return;
      facets.keys = [];
      facets.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (seq === facets.seq) {
        facets.loading = false;
        renderFacets();
      }
    }
    if (seq !== facets.seq) return;
    for (const id of facets.expanded.keys()) {
      const [scope, facetKey] = id.split("\x1f");
      void loadValues(scope, facetKey);
    }
  }

  async function loadValues(scope, key) {
    const id = facetId(scope, key);
    const entry = facets.expanded.get(id);
    if (!entry || !facets.filters) return;
    const seq = (entry.seq || 0) + 1;
    entry.seq = seq;
    entry.loading = true;
    entry.error = "";
    renderFacets();
    try {
      const payload = await ctx.api.getTraceFacetValues(ctx.currentHost(), { ...facetFilterParams(facets.filters), scope, key, limit: String(entry.limit) });
      if (facets.expanded.get(id) !== entry || entry.seq !== seq) return;
      entry.values = (Array.isArray(payload?.values) ? payload.values : []).map((row) => ({ value: String(row?.[0] ?? ""), count: Number(row?.[1] || 0) }));
      entry.estimated = payload?.estimated === true;
      entry.hasMore = payload?.has_more === true;
      entry.distinct = Number(payload?.distinct_values || 0);
    } catch (error) {
      if (facets.expanded.get(id) !== entry || entry.seq !== seq) return;
      entry.values = [];
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (facets.expanded.get(id) === entry && entry.seq === seq) {
        entry.loading = false;
        renderFacets();
      }
    }
  }

  function chipMatches(chip, scope, key, value, op) {
    return chip.kind === "tag" && chip.op === op && chip.key === key && (chip.scope === scope || chip.scope === "any") && chip.value === value;
  }

  function facetValuesHtml(scope, key, entry, estimated) {
    if (entry.loading && !entry.values) return '<div class="traceFacet__status">Loading values…</div>';
    if (entry.error) return `<div class="traceFacet__status is-error" role="alert">${esc(entry.error)}</div>`;
    const values = [...(entry.values || [])];
    // Values filtered on stay listed (checked) even outside the top values.
    for (const chip of search.chips) {
      if (chip.kind !== "tag" || (chip.op !== "=" && chip.op !== "!=") || chip.key !== key || (chip.scope !== scope && chip.scope !== "any")) continue;
      if (!values.some((item) => item.value === chip.value)) values.push({ value: chip.value, count: null });
    }
    if (!values.length) return '<div class="traceFacet__status">No values in the sampled spans.</div>';
    const rows = values.map((item) => {
      const included = search.chips.some((chip) => chipMatches(chip, scope, key, item.value, "="));
      const excluded = search.chips.some((chip) => chipMatches(chip, scope, key, item.value, "!="));
      const shown = item.value === "" ? '""' : item.value;
      const count = item.count == null ? "—" : `${estimated || entry.estimated ? "≈" : ""}${compactCount(item.count)}`;
      return `<div class="traceFacetValue${excluded ? " is-excluded" : ""}" data-facet-value="${esc(item.value)}"><label class="traceFacetValue__label" title="${esc(item.value)}"><input type="checkbox" data-facet-include${included ? " checked" : ""}><span class="traceFacetValue__text">${esc(shown)}</span></label><span class="traceFacetValue__count" title="${item.count == null ? "Not in the sampled top values" : `${Number(item.count).toLocaleString()} span${item.count === 1 ? "" : "s"}${estimated || entry.estimated ? " (estimated from a sample)" : ""}`}">${esc(count)}</span><button type="button" class="traceFacetValue__exclude" data-facet-exclude aria-pressed="${excluded ? "true" : "false"}" title="${excluded ? "Stop excluding this value" : "Exclude this value"}" aria-label="${excluded ? "Stop excluding" : "Exclude"} ${esc(shown)}"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><path d="M4.4 11.6 11.6 4.4"/></svg></button></div>`;
    }).join("");
    const next = VALUE_LIMITS.find((limit) => limit > entry.limit);
    const more = entry.hasMore && next ? `<button type="button" class="traceFacet__more" data-facet-more-values>Load more values</button>` : "";
    return `<div class="traceFacet__valueList">${rows}</div>${entry.loading ? '<div class="traceFacet__status">Loading values…</div>' : more}`;
  }

  function facetHtml(item, pinned) {
    const id = facetId(item.scope, item.key);
    const entry = facets.expanded.get(id);
    const open = !!entry;
    const active = search.chips.some((chip) => chip.kind === "tag" && chip.key === item.key && (chip.scope === item.scope || chip.scope === "any"));
    const count = item.count == null ? "" : `${facets.estimated ? "≈" : ""}${compactCount(item.count)}`;
    const title = item.count == null ? item.key : `${item.key}: ${Number(item.count).toLocaleString()} span${item.count === 1 ? "" : "s"}${facets.estimated ? " in the sample" : ""}`;
    return `<section class="traceFacet${open ? " is-open" : ""}${active ? " is-active" : ""}" data-facet-scope="${esc(item.scope)}" data-facet-key="${esc(item.key)}">
      <div class="traceFacet__head"><button type="button" class="traceFacet__expand" data-facet-expand aria-expanded="${open ? "true" : "false"}" title="${esc(title)}"><svg class="traceFacet__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg><span class="traceFacet__scope traceFacet__scope--${esc(item.scope)}" title="${item.scope === "resource" ? "Resource attribute" : "Span attribute"}">${item.scope === "resource" ? "R" : "S"}</span><span class="traceFacet__key">${esc(item.key)}</span><span class="traceFacet__count">${esc(count)}</span></button><button type="button" class="traceFacet__pin" data-facet-pin aria-pressed="${pinned ? "true" : "false"}" title="${pinned ? "Unpin" : "Pin to the top"}" aria-label="${pinned ? "Unpin" : "Pin"} ${esc(item.key)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5h4l-.6 4 2.6 2.2v1H4v-1l2.6-2.2zM8 9.7V14"/></svg></button></div>
      ${open ? `<div class="traceFacet__values">${facetValuesHtml(item.scope, item.key, entry, facets.estimated)}</div>` : ""}
    </section>`;
  }

  function renderFacets() {
    const list = byId("traceFacetsList");
    const meta = byId("traceFacetsMeta");
    syncToggle();
    if (!list) return;
    if (meta) {
      meta.textContent = facets.loading ? "Loading…" : facets.keys.length ? `${facets.estimated ? "≈" : ""}${compactCount(facets.sampled)} spans` : "";
      meta.title = facets.estimated
        ? `Estimated: counted over a sample of ${facets.sampled.toLocaleString()} matching spans${facets.timedOut ? " (the time budget stopped the scan)" : ""}.`
        : facets.keys.length ? `Counted over all ${facets.sampled.toLocaleString()} matching spans of the range.` : "";
      meta.classList.toggle("is-estimated", facets.estimated);
    }
    if (!facets.supported) { list.innerHTML = '<div class="traceFacets__empty">Attributes are not stored as Map columns.</div>'; return; }
    if (facets.error) { list.innerHTML = `<div class="traceFacets__empty is-error" role="alert">${esc(facets.error)}</div>`; return; }
    if (!facets.filters) { list.innerHTML = '<div class="traceFacets__empty">Search to discover attributes.</div>'; return; }
    const query = facets.query.trim().toLowerCase();
    const matches = (item) => !query || item.key.toLowerCase().includes(query);
    const byId_ = new Map(facets.keys.map((item) => [facetId(item.scope, item.key), item]));
    const pinned = facets.pins.map((id) => byId_.get(id) || { scope: id.split("\x1f")[0], key: id.split("\x1f").slice(1).join("\x1f"), count: null }).filter(matches);
    const rest = facets.keys.filter((item) => !facets.pins.includes(facetId(item.scope, item.key)) && matches(item));
    const shown = rest.slice(0, facets.shown);
    if (!pinned.length && !rest.length) {
      list.innerHTML = `<div class="traceFacets__empty">${facets.loading ? "Loading attributes…" : query ? "No attribute key matches." : "No attributes in the matching spans."}</div>`;
      return;
    }
    const more = rest.length > shown.length
      ? `<button type="button" class="traceFacets__more" data-facet-more-keys>Load more (${rest.length - shown.length})</button>`
      : "";
    list.innerHTML = `${pinned.length ? `<div class="traceFacets__group traceFacets__group--pinned">${pinned.map((item) => facetHtml(item, true)).join("")}</div>` : ""}<div class="traceFacets__group">${shown.map((item) => facetHtml(item, false)).join("")}</div>${more}`;
  }

  function facetOf(element) {
    const section = element.closest("[data-facet-key]");
    return section ? { scope: section.getAttribute("data-facet-scope") || "span", key: section.getAttribute("data-facet-key") || "" } : null;
  }

  function onFacetsClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest("[data-facet-more-keys]")) { facets.shown += KEYS_PAGE; renderFacets(); return; }
    const facet = facetOf(target);
    if (!facet) return;
    const id = facetId(facet.scope, facet.key);
    if (target.closest("[data-facet-expand]")) {
      if (facets.expanded.has(id)) facets.expanded.delete(id);
      else {
        facets.expanded.set(id, { limit: VALUE_LIMITS[0], values: null, loading: false, error: "", estimated: false, hasMore: false, seq: 0 });
        void loadValues(facet.scope, facet.key);
      }
      renderFacets();
      byId("traceFacetsList")?.querySelector(`[data-facet-key="${CSS.escape(facet.key)}"][data-facet-scope="${facet.scope}"] [data-facet-expand]`)?.focus({ preventScroll: true });
      return;
    }
    if (target.closest("[data-facet-pin]")) {
      facets.pins = facets.pins.includes(id) ? facets.pins.filter((pin) => pin !== id) : [...facets.pins, id];
      savePins();
      renderFacets();
      return;
    }
    if (target.closest("[data-facet-more-values]")) {
      const entry = facets.expanded.get(id);
      if (!entry) return;
      entry.limit = VALUE_LIMITS.find((limit) => limit > entry.limit) || entry.limit;
      void loadValues(facet.scope, facet.key);
      return;
    }
    const exclude = target.closest("[data-facet-exclude]");
    if (exclude) {
      const value = exclude.closest("[data-facet-value]")?.getAttribute("data-facet-value") ?? "";
      const chip = { kind: "tag", op: "!=", scope: facet.scope, key: facet.key, value };
      const existing = search.chips.find((other) => chipMatches(other, facet.scope, facet.key, value, "!="));
      if (existing) removeChip(existing); else addChip(chip);
      void ctx.runSearch({ url: "push" });
    }
  }

  function onFacetsChange(event) {
    const box = event.target instanceof HTMLInputElement && event.target.matches("[data-facet-include]") ? event.target : null;
    if (!box) return;
    const facet = facetOf(box);
    if (!facet) return;
    const value = box.closest("[data-facet-value]")?.getAttribute("data-facet-value") ?? "";
    const existing = search.chips.find((other) => chipMatches(other, facet.scope, facet.key, value, "="));
    if (box.checked && !existing) addChip({ kind: "tag", op: "=", scope: facet.scope, key: facet.key, value });
    if (!box.checked && existing) removeChip(existing);
    void ctx.runSearch({ url: "push" });
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
    document.addEventListener("click", onDocumentClick, true);
    document.addEventListener("keydown", onDocumentKeydown, true);
    window.addEventListener("scroll", closeMenu, { passive: true, capture: true });
    window.addEventListener("resize", closeMenu, { passive: true });
    byId("traceFacetsToggle")?.addEventListener("click", () => setCollapsed(!collapsed()));
    byId("traceFacetsList")?.addEventListener("click", onFacetsClick);
    byId("traceFacetsList")?.addEventListener("change", onFacetsChange);
    byId("traceFacetsSearch")?.addEventListener("input", (event) => { facets.query = String(event.target.value || ""); facets.shown = KEYS_PAGE; renderFacets(); });
    // A user's own service / operation choice replaces an applied one.
    for (const select of [ctx.dom.tracesService, ctx.dom.tracesOperation]) {
      select?.addEventListener("change", () => wantSelect(select, ""));
    }
    syncToggle();
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

  function resetFacets() {
    ++facets.seq;
    facets.filters = null;
    facets.filterKey = "";
    facets.keys = [];
    facets.error = "";
    facets.loading = false;
    facets.expanded.clear();
    renderFacets();
  }

  ns.traceSearch = {
    install,
    chipParams,
    commitPendingTag,
    contextQuery,
    searchKey,
    writeUrl,
    applyLocation,
    hasSearchParams: () => hasSearchParams(new URLSearchParams(window.location.search)),
    onSearched: (filters) => { void loadFacets(filters); },
    resetFacets,
    prefillTagParams,
    prefillTagsChanged,
    notePrefillTags,
    closeMenu,
  };
})();
