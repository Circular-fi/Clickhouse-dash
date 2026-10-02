(() => {
  "use strict";
  // In-content tab rows (tier 2: inside a view, under the page's own tabs):
  // the Logs Results / Patterns tabs and the trace detail views (Timeline |
  // Graph | Statistics | Spans | Flamegraph), drawn by .contentTabs /
  // .contentTabs__tab. bind() owns role=tablist / tab, aria-selected and
  // .is-active, the roving tabindex (Tab reaches the selected tab only),
  // Left / Right / Home / End (which move and select, automatic activation)
  // and the click; the caller shows the panel in onSelect.
  const ns = window.ChDash;
  if (!ns) return;

  const KEYS = ["ArrowRight", "ArrowLeft", "Home", "End"];

  function tabsOf(list) {
    return [...list.querySelectorAll('[role="tab"]')];
  }

  function shownTabs(list) {
    return tabsOf(list).filter((tab) => !tab.hidden && !tab.disabled);
  }

  // Marks the tab whose value is `value` selected (the others not).
  function select(list, value, attr = "tab") {
    if (!list) return;
    for (const tab of tabsOf(list)) {
      const on = tab.dataset[attr] === value;
      tab.classList.toggle("is-active", on);
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    }
  }

  // bind(list, { attr = "tab", onSelect(value, { via: "click" | "key" }) }):
  // the tab's value is its data-<attr>. Returns { select(value) }.
  function bind(list, { attr = "tab", onSelect = null } = {}) {
    if (!list) return { select: () => {} };
    list.setAttribute("role", "tablist");
    for (const tab of tabsOf(list)) tab.setAttribute("role", "tab");
    list.addEventListener("click", (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (!tab || !list.contains(tab) || tab.disabled) return;
      onSelect?.(tab.dataset[attr], { via: "click" });
    });
    list.addEventListener("keydown", (event) => {
      if (!KEYS.includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      const tabs = shownTabs(list);
      const at = tabs.indexOf(event.target instanceof Element ? event.target.closest('[role="tab"]') : null);
      if (at < 0 || !tabs.length) return;
      event.preventDefault();
      const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[tabs.length - 1]
        : tabs[(at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      next.focus({ preventScroll: true });
      if (next !== tabs[at]) onSelect?.(next.dataset[attr], { via: "key" });
    });
    const current = tabsOf(list).find((tab) => tab.getAttribute("aria-selected") === "true") || tabsOf(list)[0];
    if (current) select(list, current.dataset[attr], attr);
    return { select: (value) => select(list, value, attr) };
  }

  ns.tabs = { bind, select };
})();
