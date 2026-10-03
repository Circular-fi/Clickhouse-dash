(() => {
  "use strict";
  // The facets sidebar (after HyperDX's DBSearchPageFilters) shared by the
  // Traces search (Attributes, app_trace_search.js) and Logs (Fields,
  // app_logs.js): a key search, the top keys of the matching rows with their
  // sampled counts and a scope badge, top values per key with include
  // (checkbox) and exclude, pinned keys, load more, in the ns.sidePanel shell
  // (a collapsed 32 px rail on wide windows, a drawer on phones). The page owns the filters: it hands the panel its
  // current filters after every search and answers which values are
  // filtered; the panel calls back on include / exclude.
  const ns = window.ChDash;
  if (!ns) return;
  const { $ } = ns.dom;

  const KEYS_PAGE = 20;
  const VALUE_LIMITS = [10, 50, 200, 500];
  const SEP = "\x1f";
  const PIN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 2.5h4l-.6 4 2.6 2.2v1H4v-1l2.6-2.2zM8 9.7V14"/></svg>';
  const EXCLUDE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.2"/><path d="M4.4 11.6 11.6 4.4"/></svg>';
  const CHEVRON_ICON = '<svg class="traceFacet__chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

  const esc = (value) => ns.util.escapeHtml(String(value == null ? "" : value));
  const compact = (value) => ns.format.compact(value);
  const grouped = (value) => ns.format.count(value);
  const facetId = (scope, key) => `${scope}${SEP}${key}`;
  const splitId = (id) => {
    const at = id.indexOf(SEP);
    return at < 0 ? { scope: "", key: id } : { scope: id.slice(0, at), key: id.slice(at + 1) };
  };

  // options:
  //   ids: { panel, toggle, meta, search, list } element ids (the panel is an
  //     ns.sidePanel shell: .uiSide markup, observability.html)
  //   drawerHost: the main column whose top holds the phone drawer toggle
  //   collapsedClass: the <html> class of the folded rail; collapsedStoreKey, pinStoreKey
  //   label: "attributes" / "fields" (toggle titles, empty states)
  //   noun: ["span", "spans"] / ["log", "logs"]
  //   scopes: { <scope>: { badge, title } }
  //   enabled(): false hides the panel
  //   filterKey(filters): equal keys need no refetch
  //   fetchKeys(filters) -> { supported, keys: [{ scope, key, count }], estimated, timedOut, sampled, unsupportedText }
  //   fetchValues(filters, scope, key, limit) -> { values: [{ value, count }], estimated, hasMore }
  //   filtered(scope, key) -> { include: [values], exclude: [values], active (default: any of them) }
  //   onInclude(scope, key, value, checked), onExclude(scope, key, value)
  function create(options) {
    const o = options;
    const part = (name) => ns.dom.byId(o.ids[name]);
    const [one, many] = o.noun;
    // util.latest keys: this panel's keys request, and one per expanded key.
    const latestKey = `facets.${o.ids.panel}`;
    const state = {
      filterKey: "",
      filters: null,
      keys: [],
      supported: true,
      unsupportedText: "",
      estimated: false,
      timedOut: false,
      sampled: 0,
      loading: false,
      error: "",
      shown: KEYS_PAGE,
      query: "",
      // "scope\x1fkey" -> { limit, values, loading, error, estimated, hasMore }
      expanded: new Map(),
      pins: readPins(),
    };

    function readPins() {
      const saved = ns.storage.pref(o.pinStoreKey, []).get();
      return Array.isArray(saved) ? saved.filter((item) => Array.isArray(item) && item.length === 2).map(([scope, key]) => facetId(scope, key)) : [];
    }

    function savePins() {
      ns.storage.pref(o.pinStoreKey, []).set(state.pins.map((id) => { const { scope, key } = splitId(id); return [scope, key]; }));
    }

    // The panel shell (ns.sidePanel): the 32 px rail on wide windows (the
    // <html> class the head script sets before the first paint), a drawer
    // opened from the main column's toggle on narrow ones.
    const unfolded = () => {
      if (state.filters && state.filterKey !== o.filterKey(state.filters)) void load(state.filters);
      else render();
    };
    const side = ns.sidePanel.mount(part("panel"), {
      label: o.label.charAt(0).toUpperCase() + o.label.slice(1),
      collapse: { button: part("toggle"), storeKey: o.collapsedStoreKey, rootClass: o.collapsedClass, onChange: (value) => { if (!value) unfolded(); } },
      drawer: o.drawerHost ? { host: o.drawerHost, onChange: (open) => { if (open) unfolded(); } } : null,
    });

    // Folded to the rail (a drawer on a phone is never folded).
    function collapsed() {
      return side.collapsed() && !ns.shell?.isAtMost?.("md");
    }

    function setCollapsed(value) {
      side.setCollapsed(value);
    }

    // After every search: the keys for the new filters, then the values of
    // the expanded keys. Skipped while the sidebar is folded.
    async function load(filters) {
      state.filters = filters;
      const panel = part("panel");
      const enabled = o.enabled ? o.enabled() !== false : true;
      if (panel) panel.hidden = !enabled;
      if (!enabled || collapsed()) return;
      state.filterKey = o.filterKey(filters);
      const req = ns.util.latest(latestKey);
      state.loading = true;
      state.error = "";
      render();
      try {
        const payload = await o.fetchKeys(filters, { signal: req.signal });
        if (!req.isCurrent()) return;
        state.supported = payload?.supported !== false;
        state.unsupportedText = payload?.unsupportedText || "";
        state.keys = Array.isArray(payload?.keys) ? payload.keys : [];
        state.estimated = payload?.estimated === true;
        state.timedOut = payload?.timedOut === true;
        state.sampled = Number(payload?.sampled || 0);
      } catch (error) {
        if (!req.isCurrent()) return;
        state.keys = [];
        state.error = ns.util.errorText(error);
      } finally {
        if (req.isCurrent()) {
          state.loading = false;
          render();
        }
      }
      if (!req.isCurrent()) return;
      for (const id of state.expanded.keys()) {
        const { scope, key } = splitId(id);
        void loadValues(scope, key);
      }
    }

    async function loadValues(scope, key) {
      const id = facetId(scope, key);
      const entry = state.expanded.get(id);
      if (!entry || !state.filters) return;
      // The entry check stays: a key folded and opened again is a new entry.
      const req = ns.util.latest(`${latestKey}.values.${id}`);
      const current = () => req.isCurrent() && state.expanded.get(id) === entry;
      entry.loading = true;
      entry.error = "";
      render();
      try {
        const payload = await o.fetchValues(state.filters, scope, key, entry.limit, { signal: req.signal });
        if (!current()) return;
        entry.values = Array.isArray(payload?.values) ? payload.values : [];
        entry.estimated = payload?.estimated === true;
        entry.hasMore = payload?.hasMore === true;
      } catch (error) {
        if (!current()) return;
        entry.values = [];
        entry.error = ns.util.errorText(error);
      } finally {
        if (current()) {
          entry.loading = false;
          render();
        }
      }
    }

    function filteredOf(scope, key) {
      const out = o.filtered(scope, key) || {};
      const include = out.include || [];
      const exclude = out.exclude || [];
      return { include, exclude, active: out.active ?? (include.length > 0 || exclude.length > 0) };
    }

    function scopeInfo(scope) {
      return o.scopes[scope] || { badge: "?", title: scope };
    }

    function valuesHtml(scope, key, entry) {
      if (entry.loading && !entry.values) return '<div class="traceFacet__status">Loading values\u2026</div>';
      if (entry.error) return `<div class="traceFacet__status is-error" role="alert">${esc(entry.error)} <button type="button" class="traceMiniButton" data-facet-retry>Retry</button></div>`;
      const { include, exclude } = filteredOf(scope, key);
      const values = [...(entry.values || [])];
      // Values filtered on stay listed (checked / excluded) even outside the top values.
      for (const value of [...include, ...exclude]) {
        if (!values.some((item) => item.value === value)) values.push({ value, count: null });
      }
      if (!values.length) return `<div class="traceFacet__status">No values in the sampled ${esc(many)}.</div>`;
      const estimated = state.estimated || entry.estimated;
      const rows = values.map((item) => {
        const included = include.includes(item.value);
        const excluded = exclude.includes(item.value);
        const shown = item.value === "" ? '""' : item.value;
        const count = item.count == null ? ns.format.EMPTY : `${estimated ? "\u2248" : ""}${compact(item.count)}`;
        const countTitle = item.count == null ? "Not in the sampled top values" : `${grouped(item.count)} ${item.count === 1 ? one : many}${estimated ? " (estimated from a sample)" : ""}`;
        return `<div class="traceFacetValue${excluded ? " is-excluded" : ""}" data-facet-value="${esc(item.value)}"><label class="traceFacetValue__label" title="${esc(item.value)}"><input type="checkbox" data-facet-include${included ? " checked" : ""}><span class="traceFacetValue__text">${esc(shown)}</span></label><span class="traceFacetValue__count" title="${esc(countTitle)}">${esc(count)}</span><button type="button" class="traceFacetValue__exclude" data-facet-exclude aria-pressed="${excluded ? "true" : "false"}" title="${excluded ? "Stop excluding this value" : "Exclude this value"}" aria-label="${excluded ? "Stop excluding" : "Exclude"} ${esc(shown)}">${EXCLUDE_ICON}</button></div>`;
      }).join("");
      const next = VALUE_LIMITS.find((limit) => limit > entry.limit);
      const more = entry.hasMore && next ? '<button type="button" class="traceFacet__more" data-facet-more-values>Load more values</button>' : "";
      return `<div class="traceFacet__valueList">${rows}</div>${entry.loading ? '<div class="traceFacet__status">Loading values\u2026</div>' : more}`;
    }

    function facetHtml(item, pinned) {
      const entry = state.expanded.get(facetId(item.scope, item.key));
      const open = !!entry;
      const { active } = filteredOf(item.scope, item.key);
      const info = scopeInfo(item.scope);
      const count = item.count == null ? "" : `${state.estimated ? "\u2248" : ""}${compact(item.count)}`;
      const title = item.count == null ? item.key : `${item.key}: ${grouped(item.count)} ${item.count === 1 ? one : many}${state.estimated ? " in the sample" : ""}`;
      return `<section class="traceFacet${open ? " is-open" : ""}${active ? " is-active" : ""}" data-facet-scope="${esc(item.scope)}" data-facet-key="${esc(item.key)}">
      <div class="traceFacet__head"><button type="button" class="traceFacet__expand" data-facet-expand aria-expanded="${open ? "true" : "false"}" title="${esc(title)}">${CHEVRON_ICON}<span class="traceFacet__scope traceFacet__scope--${esc(item.scope)}" title="${esc(info.title)}">${esc(info.badge)}</span><span class="traceFacet__key">${esc(item.key)}</span><span class="traceFacet__count">${esc(count)}</span></button><button type="button" class="traceFacet__pin" data-facet-pin aria-pressed="${pinned ? "true" : "false"}" title="${pinned ? "Unpin" : "Pin to the top"}" aria-label="${pinned ? "Unpin" : "Pin"} ${esc(item.key)}">${PIN_ICON}</button></div>
      ${open ? `<div class="traceFacet__values">${valuesHtml(item.scope, item.key, entry)}</div>` : ""}
    </section>`;
    }

    function render() {
      const list = part("list");
      const meta = part("meta");
      if (!list) return;
      if (meta) {
        meta.textContent = state.loading ? "Loading\u2026" : state.keys.length ? `${state.estimated ? "\u2248" : ""}${compact(state.sampled)} ${state.sampled === 1 ? one : many}` : "";
        meta.title = state.estimated
          ? `Estimated: counted over a sample of ${grouped(state.sampled)} matching ${many}${state.timedOut ? " (the time budget stopped the scan)" : ""}.`
          : state.keys.length ? `Counted over all ${grouped(state.sampled)} matching ${many} of the range.` : "";
        meta.classList.toggle("is-estimated", state.estimated);
      }
      const ui = ns.uiState;
      if (!state.supported) { list.innerHTML = ui.emptyHtml({ body: state.unsupportedText || `No ${o.label} to list.`, compact: true }); return; }
      if (state.error) { list.innerHTML = ui.errorHtml({ body: state.error, compact: true, retry: { attrs: { "data-facets-retry": "" } } }); return; }
      if (!state.filters) { list.innerHTML = ui.emptyHtml({ body: `Search to discover ${o.label}.`, compact: true }); return; }
      const query = state.query.trim().toLowerCase();
      const matches = (item) => !query || item.key.toLowerCase().includes(query);
      const known = new Map(state.keys.map((item) => [facetId(item.scope, item.key), item]));
      const pinned = state.pins.map((id) => known.get(id) || { ...splitId(id), count: null }).filter((item) => o.scopes[item.scope] && matches(item));
      const rest = state.keys.filter((item) => !state.pins.includes(facetId(item.scope, item.key)) && matches(item));
      const shown = rest.slice(0, state.shown);
      if (!pinned.length && !rest.length) {
        list.innerHTML = state.loading
          ? ui.loadingHtml({ label: `Loading ${o.label}\u2026`, compact: true })
          : query
            ? ui.emptyHtml({ body: "No key matches.", compact: true, action: { label: "Clear the filter", attrs: { "data-facets-clear-query": "" } } })
            : ui.emptyHtml({ body: `No ${o.label} in the matching ${many}.`, compact: true });
        return;
      }
      const moreHtml = rest.length > shown.length
        ? `<button type="button" class="traceFacets__more" data-facet-more-keys>Load more (${rest.length - shown.length})</button>`
        : "";
      list.innerHTML = `${pinned.length ? `<div class="traceFacets__group traceFacets__group--pinned">${pinned.map((item) => facetHtml(item, true)).join("")}</div>` : ""}<div class="traceFacets__group">${shown.map((item) => facetHtml(item, false)).join("")}</div>${moreHtml}`;
    }

    function facetOf(element) {
      const section = element.closest("[data-facet-key]");
      return section ? { scope: section.getAttribute("data-facet-scope") || "", key: section.getAttribute("data-facet-key") || "" } : null;
    }

    let searchField = null;

    function onClick(event) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (target.closest("[data-facet-more-keys]")) { state.shown += KEYS_PAGE; render(); return; }
      if (target.closest("[data-facets-retry]")) { if (state.filters) void load(state.filters); return; }
      if (target.closest("[data-facets-clear-query]")) { searchField?.clear(); part("search")?.focus(); return; }
      const facet = facetOf(target);
      if (!facet) return;
      const id = facetId(facet.scope, facet.key);
      if (target.closest("[data-facet-expand]")) {
        if (state.expanded.has(id)) state.expanded.delete(id);
        else {
          state.expanded.set(id, { limit: VALUE_LIMITS[0], values: null, loading: false, error: "", estimated: false, hasMore: false });
          void loadValues(facet.scope, facet.key);
        }
        render();
        $(`[data-facet-key="${CSS.escape(facet.key)}"][data-facet-scope="${CSS.escape(facet.scope)}"] [data-facet-expand]`, part("list"))?.focus({ preventScroll: true });
        return;
      }
      if (target.closest("[data-facet-pin]")) {
        state.pins = state.pins.includes(id) ? state.pins.filter((pin) => pin !== id) : [...state.pins, id];
        savePins();
        render();
        return;
      }
      if (target.closest("[data-facet-retry]")) { void loadValues(facet.scope, facet.key); return; }
      if (target.closest("[data-facet-more-values]")) {
        const entry = state.expanded.get(id);
        if (!entry) return;
        entry.limit = VALUE_LIMITS.find((limit) => limit > entry.limit) || entry.limit;
        void loadValues(facet.scope, facet.key);
        return;
      }
      const exclude = target.closest("[data-facet-exclude]");
      if (exclude) o.onExclude(facet.scope, facet.key, exclude.closest("[data-facet-value]")?.getAttribute("data-facet-value") ?? "");
    }

    function onChange(event) {
      const box = event.target instanceof HTMLInputElement && event.target.matches("[data-facet-include]") ? event.target : null;
      if (!box) return;
      const facet = facetOf(box);
      if (!facet) return;
      o.onInclude(facet.scope, facet.key, box.closest("[data-facet-value]")?.getAttribute("data-facet-value") ?? "", box.checked);
    }

    function reset() {
      ns.util.latest.cancel(latestKey);
      state.filters = null;
      state.filterKey = "";
      state.keys = [];
      state.error = "";
      state.loading = false;
      state.expanded.clear();
      render();
    }

    part("list")?.addEventListener("click", onClick);
    part("list")?.addEventListener("change", onChange);
    searchField = ns.search.bind(part("search"), (value) => { state.query = String(value || ""); state.shown = KEYS_PAGE; render(); });

    return {
      load,
      reset,
      render,
      collapsed,
      setCollapsed,
      // Discovered keys (the trace span table's column picker suggests them).
      keys: () => state.keys.map(({ scope, key }) => ({ scope, key })),
    };
  }

  ns.facetPanel = { create, VALUE_LIMITS, KEYS_PAGE };
})();
