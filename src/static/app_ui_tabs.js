// Tab rows. Every row of sections is one underline row (.contentTabs /
// .contentTabs__tab; .contentTabs--nav in a page's nav row). Examples are the Explorer
// views, the Catalog's Browse | Graph, the Observability views, the Traces
// Search | Services | Service map, the System sections, the Explorer table card, Logs
// Results | Patterns and the log record tabs, the trace detail views, and
// the dialog tabs. A mode is another presentation of the same scope. Use a
// segmented control (ns.segmented) for a mode, never a tab.
// bind() owns role=tablist and role=tab, aria-selected and .is-active. It also owns
// the roving tabindex: Tab reaches only the selected tab. Left, Right, Home and End
// move the selection and select the tab (automatic activation). bind() also handles the click.
// The caller shows the panel in onSelect. render() builds the buttons of a row for rows
// drawn from data. No other module handles tab keys (harness contract
// test_ui_tabs_menus_contract.py).

import { dom, shell } from "./app_dom.js";

const { $$ } = dom;

const KEYS = ["ArrowRight", "ArrowLeft", "Home", "End"];
const TAB_CLASS = "contentTabs__tab";

function tabsOf(list) {
  return [...$$('[role="tab"]', list)];
}

function shownTabs(list) {
  return tabsOf(list).filter((tab) => !tab.hidden && !tab.disabled);
}

const dataKey = (attr) => `data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

function find(list, value, attr = "tab") {
  return tabsOf(list).find((tab) => tab.dataset[attr] === value) || null;
}

// Marks the tab whose value is `value` as selected. The other tabs are not selected. In a row
// that scrolls sideways (a phone), the selected tab scrolls into view.
function select(list, value, attr = "tab") {
  if (!list) return;
  for (const tab of tabsOf(list)) {
    const on = tab.dataset[attr] === value;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
    if (on) reveal(list, tab);
  }
}

// Scrolls a row that scrolls sideways. Only the row scrolls, never the page. The tab
// then shows whole.
function reveal(list, tab) {
  if (!(list.scrollWidth > list.clientWidth + 1) || tab.hidden) return;
  const box = tab.getBoundingClientRect();
  const left = box.left - list.getBoundingClientRect().left - list.clientLeft + list.scrollLeft;
  if (left < list.scrollLeft) list.scrollLeft = left;
  else if (left + box.width > list.scrollLeft + list.clientWidth) list.scrollLeft = left + box.width - list.clientWidth;
}

// render(list, items, { attr = "tab", selected }) makes one
// button per item { value, label, id, controls, hidden, title }. The selected item is marked.
// The row keeps the focused tab focused after the rebuild.
function render(list, items, { attr = "tab", selected = "" } = {}) {
  if (!list) return;
  const focused = list.contains(document.activeElement) ? document.activeElement?.dataset?.[attr] : null;
  list.replaceChildren(...items.map((item) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = TAB_CLASS;
    tab.setAttribute("role", "tab");
    tab.setAttribute(dataKey(attr), item.value);
    if (item.id) tab.id = item.id;
    if (item.controls) tab.setAttribute("aria-controls", item.controls);
    if (item.title) tab.title = item.title;
    if (item.hidden) tab.hidden = true;
    tab.textContent = item.label;
    return tab;
  }));
  select(list, selected, attr);
  if (focused != null) find(list, focused, attr)?.focus({ preventScroll: true });
}

// bind(list, { attr = "tab", onSelect(value, { via: "click" | "key" }) }):
// The value of a tab is its data-<attr>. onSelect may rebuild the row, or
// it may resolve later (a promise). The selected tab keeps the keyboard focus.
// Returns { select(value), render(items, options) }.
function bind(list, { attr = "tab", onSelect = null } = {}) {
  if (!list) return { select: () => {}, render: () => {} };
  list.setAttribute("role", "tablist");
  for (const tab of tabsOf(list)) tab.setAttribute("role", "tab");
  // A row that is too narrow for its tabs scrolls sideways. It fades the side that
  // hides tabs (ns.shell.edgeCues).
  shell?.edgeCues?.(list);
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
    if (next === tabs[at]) return;
    const value = next.dataset[attr];
    const refocus = () => {
      const tab = find(list, value, attr);
      if (tab && !tab.hidden && document.activeElement !== tab && (!document.activeElement || document.activeElement === document.body || list.contains(document.activeElement) || !document.activeElement.isConnected)) {
        tab.focus({ preventScroll: true });
      }
    };
    Promise.resolve(onSelect?.(value, { via: "key" })).then(refocus, refocus);
  });
  const current = tabsOf(list).find((tab) => tab.getAttribute("aria-selected") === "true") || tabsOf(list)[0];
  if (current) select(list, current.dataset[attr], attr);
  return {
    select: (value) => select(list, value, attr),
    render: (items, options = {}) => render(list, items, { ...options, attr }),
  };
}

export const tabs = { bind, select, render };
