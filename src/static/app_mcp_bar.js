// The filter bar of the Usage tab (app_mcp_overview.js, docs/mcp-integration-page.md, "The Usage tab").
// The bar is the same as the bar of Observability and System (app_ui_filterbar.js), under the row of the two MCP pages.
// From left to right, the bar has these items. Group by (key, method, client or result) sets what the charts group.
// Then comes a picker for each of the five dimensions that have a list of values: Key, Method, Client, Result and Instance.
// At the right end are the window and Refresh. A choice applies at once. The type is also a filter. A link picks it. The bar never picks it.
//
//   mcpBar.create({ groups, labelOf(dimension, value), onGroup(value), onWindow(value), onPick(dimension, value), onClear(dimension),
//                   onRefresh() })  -> bar
//   bar.form                       the <form> of the bar. The caller puts it in the page, under the row, before the chips.
//   bar.windows                    the buttons of the window
//   bar.refresh                    the Refresh button. Its type is submit, so the submit of the form calls onRefresh.
//   bar.setWindows(list, value)    the window buttons that the server keeps. The button of `value` is pressed.
//   bar.sync({ group, window, filters, data, me, offered })   Draw the model state quietly: the group, the window, the button of each picker,
//                                  and its list when it is open. `data` (an answer, or null) gives the values of the lists and their counts.
//                                  The facet of each dimension has every filter but its own. So a list shows what else can be picked. `me` is
//                                  the name of this ChDash instance. The Instance list marks its row. `offered` ({ key, method, client,
//                                  result, instance }: booleans, all true when it is left out) says which lists can be used. A dimension that
//                                  has fewer than two values in the answer, and no filter, has nothing to choose from.
//   bar.mountSummary({ describe })  the phone fold (app_ui_filterbar.js). Call it once. The chips row must be right after the form.
//
// A picker is a multiple choice, like the Service picker of Logs (ns.menu.multi).
// Each value has a check box with its number of requests. An "All ..." action clears the dimension.
// A field narrows a long list. A dimension takes 20 values at most.
// A picker with nothing to choose from is off. This happens with one value or none, and no filter on. It keeps its place.
// Its button shows the value ("Client · claude-code") or "Client · none". Its title gives the reason.
//
// The instances are those of the usage directory. Every ChDash that writes to it is an instance.
// This bar is the one place that speaks of them on the Usage tab.
// With two or more instances, the Instance button shows how many while none is picked: "Instance · All (2)".
// A row shows what its instance did last, as a muted line under its name: "this instance · wrote 1 min ago".
// A row has a badge when its file is not read (skipped or conflict).
// With one instance, nothing speaks of instances. The list is off: "Instance · chdash-0".

import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { mcpInstances } from "./app_mcp_instances.js";
import { badge } from "./app_ui_badge.js";
import { filterBar } from "./app_ui_filterbar.js";
import { menu } from "./app_ui_menu.js";
import { segmented } from "./app_ui_segmented.js";

const { $$ } = dom;

// A dimension takes this many values at most. The server gives a 400 `too_many` error above this count.
const MAX_VALUES = 20;
// A list with more values than this has a field that narrows it.
const SEARCH_FROM = 12;
const WINDOW_LABEL = { "1h": "1 h", "6h": "6 h", "24h": "24 h", "7d": "7 d", "30d": "30 d", "90d": "90 d", "365d": "365 d" };

// The dimensions that have a picker, in the order of the bar. Each entry has the word of its button and the noun of its list.
// It also has the noun of one value, the action that clears it, and `wide`. Set `wide` for a button that says more than the others,
// such as "Instance · All (2)". Such a button has more room (mcp.css).
const PICKERS = [
  { dimension: "key", label: "Key", noun: "keys", one: "key", all: "All keys" },
  { dimension: "method", label: "Method", noun: "methods", one: "method", all: "All methods" },
  { dimension: "client", label: "Client", noun: "clients", one: "client", all: "All clients" },
  { dimension: "result", label: "Result", noun: "results", one: "result", all: "All results" },
  { dimension: "instance", label: "Instance", noun: "instances", one: "instance", all: "All instances", wide: true },
];

// The values of a list come from the facet of the answer. Each value has a check box and its count.
// A value can have a muted text that makes its row different.
// A value can have a badge: { text, title } for a deleted key, or for an instance whose file is not read.
// A value can have a muted line under its name: { text, title } for the time when an instance wrote last.
// `me` is the name of this ChDash instance.
const FACETS = {
  key: (data) => data.keys.map((row) => ({ value: row.id, label: row.name, count: row.requests, title: row.name === row.id ? row.name : `${row.name}\n${row.id}`,
    badge: row.deletedAt != null ? { text: "deleted", title: "The key was deleted: its usage stays until the retention ends" } : null })),
  method: (data) => data.methods.map((row) => ({ value: row.method, label: row.method, count: row.requests, muted: row.kind !== "call", title: row.method })),
  client: (data) => data.clients.map((row) => ({ value: row.client, label: row.client, count: row.requests, title: row.client })),
  result: (data) => data.results.map((row) => ({ value: row.result, label: row.result, count: row.count, title: row.result })),
  instance: (data, me) => data.instances.map((row) => {
    const last = mcpInstances.wrote(row, data.to);
    return { value: row.instance, label: row.instance, count: row.requests, title: row.instance,
      badge: row.status === "ok" ? null : { text: row.status === "conflict" ? "conflict" : "skipped", title: mcpInstances.problem(row) },
      meta: { text: row.instance === me ? `this instance · ${last.text}` : last.text, title: last.title } };
  }),
};

// Only the instances show a count of values while none is picked, and only from two values: "Instance · All (2)".
// The usage is the sum of the instances, and nothing else on the tab says so.
// The server cuts a facet at 200 rows and sets `omitted`. The instances that the server left out count too.
const COUNTED = { instance: (data) => data.instances.length + data.omitted.instances };

// A count of a list shows all its digits up to a million ("1,013"). A larger count is compact.
const figure = (n) => (n < 1e6 ? format.count(n) : format.compact(n));

function create({ groups, labelOf, onGroup, onWindow, onPick, onClear, onRefresh }) {
  const bar = filterBar.create({ id: "mcpBar", className: "mcpFilterBar", hidden: true });

  // Group by: one choice among few, like the Order by of System Queries. It is an order, not a filter. The phone summary does not count it.
  const groupSelect = h("select", { id: "mcpGroup", aria: { label: "Group by" }, dataset: { fieldLabel: "Group by" } },
    groups.map((group) => h("option", { value: group.value }, group.label)));
  const groupMenu = bar.field(groupSelect, { summary: false, pickerClass: "mcpBar__groupPicker", className: "mcpBar__field--wide" });
  groupMenu.button.id = "mcpGroupButton";
  groupSelect.addEventListener("change", () => onGroup(groupSelect.value));

  const pickers = PICKERS.map((spec) => picker(bar, spec, { labelOf, onPick, onClear }));

  // The window and Refresh are at the right end.
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
    sync({ group, window, filters, data, me = "", offered = {} }) {
      if (groupSelect.value !== group) groupMenu.set(group);
      segmented.set(windows, window, "window");
      for (const item of pickers) item.sync(filters[item.dimension], data, offered[item.dimension] !== false, me);
    },
    mountSummary(options) {
      filterBar.mountSummary(bar.form, options);
    },
  };
}

// One picker has its button in the lead of the bar. Its list is under the button.
// The list is drawn when it opens. It is drawn again when an answer changes it while it is open.
// A pick changes the check boxes in place. So the keyboard stays where it is.
function picker(bar, spec, { labelOf, onPick, onClear }) {
  const { dimension, noun } = spec;
  let chosen = [];
  let data = null;
  // The name of this ChDash instance. The Instance list marks its row.
  let me = "";
  // Whether there is anything to choose from. See the header. A list that is off cannot open.
  let usable = true;
  // The values on screen. The list is drawn again only when they change.
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
  // An item of the bar lead, like the others. The phone summary counts the chips under the bar, not these items. One filter has one count.
  bar.lead.appendChild(h("div", { class: ["obsFilterBar__field", "traceSearchField", "mcpBar__field", spec.wide && "mcpBar__field--wide"], dataset: { summary: "off" } }, root));

  // A list that was open when it became off stays as it is until it closes.
  // This happens after a pick that emptied the filter of a dimension of one value.
  // Otherwise the list closes under the pointer. The next pick puts the value back.
  const handle = menu.multi(button, panel, { root, onOpen: () => { search.value = ""; draw(); }, onClose: () => paint() });

  // The values of the list come from the facet, sorted by their requests.
  // Then come the picked values that the facet does not have. The answer may not be there yet.
  // Or it is the answer of the older filters.
  function options() {
    const rows = (data ? FACETS[dimension](data, me) : []).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    const known = new Set(rows.map((row) => row.value));
    return [...rows, ...chosen.filter((value) => !known.has(value)).map((value) => ({ value, label: labelOf(dimension, value), count: null, title: value }))];
  }

  function option(row) {
    return h("label", { class: ["mcpPicker__option", row.muted && "is-muted", row.meta && "has-meta"], title: row.title || null, dataset: { text: `${row.label} ${row.value}`.toLowerCase() } },
      h("input", { type: "checkbox", value: row.value }),
      h("span", { class: "mcpPicker__name" }, row.label),
      row.badge ? badge.el(row.badge.text, { tone: "warn", size: "sm", title: row.badge.title }) : null,
      h("span", { class: "mcpPicker__count" }, row.count == null ? "" : figure(row.count)),
      // A muted line under the name and the count shows when an instance wrote last. Its width matches the name and the badge.
      row.meta ? h("span", { class: "mcpPicker__meta", title: row.meta.title || null }, row.meta.text) : null);
  }

  function draw() {
    const rows = options();
    const signature = JSON.stringify(rows);
    if (signature !== drawn) {
      drawn = signature;
      // A list that is drawn again keeps its scroll position and the check box that has the keyboard.
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

  // The model state sets the check boxes, the button and its title. Twenty check boxes are enough.
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
    // The number of values. It shows on the button of a dimension in COUNTED, when there are two or more.
    const total = data && COUNTED[dimension] ? COUNTED[dimension](data) : 0;
    let text;
    let title;
    if (off) {
      // Nothing to choose from. The button shows what there is.
      const only = data ? FACETS[dimension](data, me)[0] : null;
      text = `${spec.label} · ${only ? only.label : "none"}`;
      title = only ? `Only one ${spec.one} in this view` : `No ${spec.one} in this view`;
    } else {
      text = names.length === 0 ? `${spec.label} · All${total > 1 ? ` (${format.count(total)})` : ""}` : names.length === 1 ? `${spec.label} · ${names[0]}` : `${spec.label} · ${names.length} selected`;
      title = names.length ? names.join(", ") : total > 1 ? `The usage is summed over ${format.count(total)} ${noun}. Pick some to see only theirs.` : spec.all;
    }
    // The button text changes only when its words change. Every answer paints the lists.
    if (button.textContent !== text) button.replaceChildren(h("span", { class: "tracePicker__label" }, text));
    if (button.title !== title) button.title = title;
    // The button is off, as a picker with nothing to pick is off (menu.select). It has no arrow and it is dimmed. It is not in the tab order.
    button.disabled = off;
    button.setAttribute("aria-disabled", off ? "true" : "false");
    root.classList.toggle("is-disabled", off);
    root.classList.toggle("is-empty", off);
  }

  // The field narrows the list. Only the values that contain its text stay.
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
    // Enter in the field does not submit the bar. It starts a read of its own. Down moves to the values.
    if (event.key === "Enter") event.preventDefault();
    else if (event.key === "ArrowDown") {
      event.preventDefault();
      $$(".mcpPicker__option:not([hidden]) input:not(:disabled)", list)[0]?.focus();
    }
  });

  return {
    dimension,
    sync(values, answer, offered = true, name = "") {
      chosen = values;
      data = answer;
      me = name;
      usable = offered;
      if (handle.isOpen()) draw();
      else paint();
    },
  };
}

export const mcpBar = Object.freeze({ create, MAX_VALUES });
