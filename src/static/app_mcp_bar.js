// The filter bar of the Usage tab (app_mcp_overview.js, docs/mcp-integration-page.md, "The Usage tab"): the bar of Observability and System
// (app_ui_filterbar.js), under the row of the two MCP pages. Left to right: Group by (key, method or client: what the four charts are
// grouped by), then a picker for each of the four dimensions that have a list of values to choose from (Key, Method, Client, Instance), and at
// the right end the window and Refresh. A choice applies at once. The result and the type are filters too, but they are picked in the tables
// and in the legends, never here.
//
//   mcpBar.create({ groups, labelOf(dimension, value), onGroup(value), onWindow(value), onPick(dimension, value), onClear(dimension),
//                   onRefresh() })  -> bar
//   bar.form                       the <form> of the bar: the caller puts it in the page (under the row, before the chips)
//   bar.windows                    the buttons of the window
//   bar.refresh                    the Refresh button (type submit: the submit of the form is onRefresh)
//   bar.setWindows(list, value)    the buttons of the windows that the server keeps, `value` pressed
//   bar.sync({ group, window, filters, data, offered })   what the model says, quietly: the group, the window, the button of each picker,
//                                  and its list when it is open. `data` (an answer, or null) gives the values of the lists and their counts:
//                                  the facet of each dimension has every filter but its own, so a list shows what else can be picked.
//                                  `offered` ({ key, method, client, instance }: booleans, all true when it is left out) says which lists can
//                                  be used: a dimension that has fewer than two values in the answer, and no filter, has nothing to choose from.
//   bar.mountSummary({ describe })  the phone fold (app_ui_filterbar.js): call it once the chips row is right after the form
//
// A picker is a multiple choice like the Service picker of Logs (ns.menu.multi): a check box for each value with its number of requests, an
// "All ..." action that clears the dimension, and a field that narrows a long list. A dimension takes 20 values at most. A picker that has
// nothing to choose from (one value or none, and no filter on) is off and keeps its place: its button says the value ("Client · claude-code")
// or "Client · none", and its title why. The instances are those of the usage directory (every ChDash that writes to it, this one first): with
// one instance, the list is off ("Instance · chdash-0"); a file that is not read is badged in its row.

import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { mcpInstances } from "./app_mcp_instances.js";
import { badge } from "./app_ui_badge.js";
import { filterBar } from "./app_ui_filterbar.js";
import { menu } from "./app_ui_menu.js";
import { segmented } from "./app_ui_segmented.js";

const { $$ } = dom;

// A dimension takes this many values at most (a 400 `too_many` of the server above).
const MAX_VALUES = 20;
// A list of more values than this has a field that narrows it.
const SEARCH_FROM = 12;
const WINDOW_LABEL = { "1h": "1 h", "6h": "6 h", "24h": "24 h", "7d": "7 d", "30d": "30 d", "90d": "90 d", "365d": "365 d" };

// The dimensions that have a picker: the word of its button, the noun of its list (and of one value), the action that clears it.
const PICKERS = [
  { dimension: "key", label: "Key", noun: "keys", one: "key", all: "All keys" },
  { dimension: "method", label: "Method", noun: "methods", one: "method", all: "All methods" },
  { dimension: "client", label: "Client", noun: "clients", one: "client", all: "All clients" },
  { dimension: "instance", label: "Instance", noun: "instances", one: "instance", all: "All instances" },
];

// The values of a list, from the facet of the answer: what the check box says, its count, what makes the row different (muted), and a
// badge when the row needs one ({ text, title }: a deleted key, an instance whose file is not read).
const FACETS = {
  key: (data) => data.keys.map((row) => ({ value: row.id, label: row.name, count: row.requests, title: row.name === row.id ? row.name : `${row.name}\n${row.id}`,
    badge: row.deletedAt != null ? { text: "deleted", title: "The key was deleted: its usage stays until the retention ends" } : null })),
  method: (data) => data.methods.map((row) => ({ value: row.method, label: row.method, count: row.requests, muted: row.kind !== "call", title: row.method })),
  client: (data) => data.clients.map((row) => ({ value: row.client, label: row.client, count: row.requests, title: row.client })),
  instance: (data) => data.instances.map((row) => ({ value: row.instance, label: row.instance, count: row.requests, title: row.instance,
    badge: row.status === "ok" ? null : { text: row.status === "conflict" ? "conflict" : "skipped", title: mcpInstances.problem(row) } })),
};

// A count of a list: all its digits up to a million ("1,013"), then compact.
const figure = (n) => (n < 1e6 ? format.count(n) : format.compact(n));

function create({ groups, labelOf, onGroup, onWindow, onPick, onClear, onRefresh }) {
  const bar = filterBar.create({ id: "mcpBar", className: "mcpFilterBar", hidden: true });

  // Group by: one choice among few, like the Order by of System Queries. It is an order, not a filter: the phone summary does not count it.
  const groupSelect = h("select", { id: "mcpGroup", aria: { label: "Group by" }, dataset: { fieldLabel: "Group by" } },
    groups.map((group) => h("option", { value: group.value }, group.label)));
  const groupMenu = bar.field(groupSelect, { summary: false, pickerClass: "mcpBar__groupPicker" });
  groupMenu.button.id = "mcpGroupButton";
  groupSelect.addEventListener("change", () => onGroup(groupSelect.value));

  const pickers = PICKERS.map((spec) => picker(bar, spec, { labelOf, onPick, onClear }));

  // The window and Refresh at the right end.
  const windows = h("div", { class: "mcpBar__windows" });
  segmented.bind(windows, { attr: "window", onChange: (value) => { onWindow(value); } });
  bar.tail.insertBefore(windows, bar.actions);
  const refresh = bar.iconAction({ id: "mcpRefresh", label: "Refresh the usage" });
  bar.onSubmit = () => onRefresh();

  return {
    form: bar.form,
    windows,
    refresh,
    setWindows(list, value) {
      segmented.render(windows, list.map((item) => ({ value: item, label: WINDOW_LABEL[item] || item })), { attr: "window", value, size: "compact", label: "Window" });
    },
    sync({ group, window, filters, data, offered = {} }) {
      if (groupSelect.value !== group) groupMenu.set(group);
      segmented.set(windows, window, "window");
      for (const item of pickers) item.sync(filters[item.dimension], data, offered[item.dimension] !== false);
    },
    mountSummary(options) {
      filterBar.mountSummary(bar.form, options);
    },
  };
}

// One picker: its button in the lead of the bar, its list under it. The list is drawn when it opens, and again when an answer changes it
// while it is open; a pick changes the check boxes in place, so the keyboard stays where it is.
function picker(bar, spec, { labelOf, onPick, onClear }) {
  const { dimension, noun } = spec;
  let chosen = [];
  let data = null;
  // Whether there is anything to choose from (see the header): a list that is off cannot be opened.
  let usable = true;
  // The values on screen (to draw the list again only when they change).
  let drawn = "";

  const button = h("button", { type: "button", class: "button themeSelect__button tracePicker__button", id: `mcpPickerButton-${dimension}`, aria: { haspopup: "dialog", expanded: "false" } });
  const search = h("input", { type: "search", class: "mcpPicker__search", placeholder: `Filter ${noun}`, autocomplete: "off", spellcheck: "false", hidden: true,
    aria: { label: `Filter the list of ${noun}` } });
  const all = h("button", { type: "button", class: "mcpPicker__all" }, spec.all);
  const list = h("div", { class: "mcpPicker__list", role: "group", aria: { label: spec.label } });
  const none = h("p", { class: "mcpPicker__none", hidden: true });
  const note = h("p", { class: "mcpPicker__note", hidden: true }, `A filter takes ${MAX_VALUES} values at most.`);
  const panel = h("div", { class: "themeSelect__menu tracePicker__menu mcpPicker__menu", id: `mcpPickerMenu-${dimension}`, role: "dialog", aria: { label: `${spec.label} filter` }, hidden: true },
    h("div", { class: "mcpPicker__head" }, search, all), list, none, note);
  const root = h("div", { class: "themeSelect tracePicker mcpPicker", dataset: { picker: dimension } }, button, panel);
  // An item of the bar's lead, as the others, but the phone summary counts the chips under the bar and not these (one filter, one count).
  bar.lead.appendChild(h("div", { class: "obsFilterBar__field traceSearchField mcpBar__field", dataset: { summary: "off" } }, root));

  // A list that was open while it became off (the pick that emptied the filter of a dimension of one value) stays as it is until it closes:
  // it would shut under the pointer, and the next pick is the one that put the value back.
  const handle = menu.multi(button, panel, { root, onOpen: () => { search.value = ""; draw(); }, onClose: () => paint() });

  // The values of the list: those of the facet by their requests, then the picked ones that the facet does not have (the answer is not
  // there yet, or it is the one of the older filters).
  function options() {
    const rows = (data ? FACETS[dimension](data) : []).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const known = new Set(rows.map((row) => row.value));
    return [...rows, ...chosen.filter((value) => !known.has(value)).map((value) => ({ value, label: labelOf(dimension, value), count: null, title: value }))];
  }

  function option(row) {
    return h("label", { class: ["mcpPicker__option", row.muted && "is-muted"], title: row.title || null, dataset: { text: `${row.label} ${row.value}`.toLowerCase() } },
      h("input", { type: "checkbox", value: row.value }),
      h("span", { class: "mcpPicker__name" }, row.label),
      row.badge ? badge.el(row.badge.text, { tone: "warn", size: "sm", title: row.badge.title }) : null,
      h("span", { class: "mcpPicker__count" }, row.count == null ? "" : figure(row.count)));
  }

  function draw() {
    const rows = options();
    const signature = JSON.stringify(rows);
    if (signature !== drawn) {
      drawn = signature;
      // A list that is drawn again keeps its scroll and the check box that has the keyboard.
      const top = list.scrollTop;
      const focused = list.contains(document.activeElement) ? document.activeElement.value : null;
      h.replace(list, rows.map(option));
      list.scrollTop = top;
      if (focused != null) $$("input", list).find((input) => input.value === focused)?.focus({ preventScroll: true });
    }
    search.hidden = rows.length <= SEARCH_FROM;
    paint();
    narrow();
  }

  // What the model says: the check boxes (and the 20 that are enough), the button and its title.
  function paint() {
    const full = chosen.length >= MAX_VALUES;
    const picked = new Set(chosen);
    for (const input of $$('input[type="checkbox"]', list)) {
      input.checked = picked.has(input.value);
      input.disabled = full && !input.checked;
    }
    note.hidden = !full;
    const names = chosen.map((value) => labelOf(dimension, value));
    const off = !usable && !handle.isOpen();
    let text;
    let title;
    if (off) {
      // Nothing to choose from: the button says what there is.
      const only = data ? FACETS[dimension](data)[0] : null;
      text = `${spec.label} · ${only ? only.label : "none"}`;
      title = only ? `Only one ${spec.one} in this view` : `No ${spec.one} in this view`;
    } else {
      text = names.length === 0 ? `${spec.label} · All` : names.length === 1 ? `${spec.label} · ${names[0]}` : `${spec.label} · ${names.length} selected`;
      title = names.length ? names.join(", ") : spec.all;
    }
    // The button is written again only when its words change (every answer paints the lists).
    if (button.textContent !== text) button.replaceChildren(h("span", { class: "tracePicker__label" }, text));
    if (button.title !== title) button.title = title;
    // Off as a picker with nothing to pick is (menu.select): no arrow, dimmed, not in the tab order.
    button.disabled = off;
    button.setAttribute("aria-disabled", off ? "true" : "false");
    root.classList.toggle("is-disabled", off);
    root.classList.toggle("is-empty", off);
  }

  // The field narrows the list to the values that hold its text.
  function narrow() {
    const needle = search.hidden ? "" : search.value.trim().toLowerCase();
    let shown = 0;
    for (const item of $$(".mcpPicker__option", list)) {
      item.hidden = !!needle && !item.dataset.text.includes(needle);
      if (!item.hidden) shown += 1;
    }
    none.hidden = shown > 0;
    none.textContent = list.childElementCount ? `Nothing matches "${search.value.trim()}".` : `No ${noun} in this view.`;
  }

  panel.addEventListener("change", (event) => {
    const input = event.target instanceof Element ? event.target.closest('input[type="checkbox"]') : null;
    if (input) onPick(dimension, input.value);
  });
  all.addEventListener("click", () => onClear(dimension));
  search.addEventListener("input", narrow);
  search.addEventListener("keydown", (event) => {
    // Enter in the field is not the submit of the bar (a read of its own); Down goes on to the values.
    if (event.key === "Enter") event.preventDefault();
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      $$(".mcpPicker__option:not([hidden]) input:not(:disabled)", list)[0]?.focus();
    }
  });

  return {
    dimension,
    sync(values, answer, offered = true) {
      chosen = values;
      data = answer;
      usable = offered;
      if (handle.isOpen()) draw();
      else paint();
    },
  };
}

export const mcpBar = Object.freeze({ create, MAX_VALUES });
