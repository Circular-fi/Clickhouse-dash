// Segmented controls: a short row of mutually exclusive choices. Each choice switches
// a view in place. Examples: Traces | Spans, List | Table, Percentiles | Heatmap,
// Table | Chart, the chart types, Lineage | Storage, and the context window presets.
//
// All segmented controls have one look: .segmented and .segmented__option. The pressed
// option uses --selected-bg. There are two sizes: 28 px (the default) and 24 px
// (.segmented--compact). All controls use one ARIA pattern. The group has role=group and
// an aria-label. Each option is a toggle button with aria-pressed. Each option keeps its
// value in a data attribute. The caller names the attribute (data-<attr>, "value" by
// default). Selectors and URLs keep their meaning.
//
//   html(options, { attr, value, size, label, className })  markup string
//   render(group, options, { attr, value, size, label })    builds the row
//   bind(group, { attr, onChange(value, { via }) })        -> { set(value), value() }
//   set(group, value, attr)                                  marks the pressed option
//
// options: [{ value, label, title, disabled, hidden, html, iconOnly }]
// html: trusted inner markup, for example an icon before the label.
// iconOnly: the html is an icon only. The label is then the aria-label of the option.
// The title is the tooltip of the option.

import { dom } from "./app_dom.js";
import { util } from "./app_util.js";

const { $$ } = dom;

const dataKey = (attr) => `data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
// util.escapeHtml: app_util.js loads after this module, but before any markup is built.
const esc = (value) => util.escapeHtml(String(value ?? ""));

function groupClass(size, className) {
  return ["segmented", size === "compact" ? "segmented--compact" : "", className || ""].filter(Boolean).join(" ");
}

function optionsOf(group, attr) {
  return group ? [...$$(`[${dataKey(attr)}]`, group)] : [];
}

function set(group, value, attr = "value") {
  for (const option of optionsOf(group, attr)) {
    option.setAttribute("aria-pressed", String(option.dataset[attr] === String(value)));
  }
}

function html(options, { attr = "value", value = "", size = "", label = "", className = "" } = {}) {
  const key = dataKey(attr);
  const items = options.map((option) => {
    const pressed = String(option.value) === String(value);
    const title = option.title ? ` title="${esc(option.title)}"` : "";
    const extra = `${option.disabled ? " disabled" : ""}${option.hidden ? " hidden" : ""}`;
    const inner = option.html != null ? option.html : esc(option.label);
    const named = option.iconOnly && option.label ? ` aria-label="${esc(option.label)}"` : "";
    const cls = option.iconOnly ? "segmented__option segmented__option--icon" : "segmented__option";
    return `<button type="button" class="${cls}" ${key}="${esc(option.value)}" aria-pressed="${pressed}"${named}${title}${extra}>${inner}</button>`;
  }).join("");
  return `<div class="${esc(groupClass(size, className))}" role="group"${label ? ` aria-label="${esc(label)}"` : ""}>${items}</div>`;
}

// Fill `group` with the options. The own classes of `group` stay.
function render(group, options, { attr = "value", value = "", size = "", label = "" } = {}) {
  if (!group) return;
  group.classList.add("segmented");
  group.classList.toggle("segmented--compact", size === "compact");
  group.setAttribute("role", "group");
  if (label) group.setAttribute("aria-label", label);
  const box = document.createElement("div");
  box.innerHTML = html(options, { attr, value });
  group.replaceChildren(...box.firstElementChild.childNodes);
}

// A click on an option that is not pressed calls onChange. If onChange returns anything
// but false, set runs here. The caller can also call set itself.
function bind(group, { attr = "value", onChange = null } = {}) {
  if (!group) return { set: () => {}, value: () => "" };
  group.setAttribute("role", "group");
  group.addEventListener("click", (event) => {
    const option = event.target instanceof Element ? event.target.closest(`[${dataKey(attr)}]`) : null;
    if (!option || !group.contains(option) || option.disabled) return;
    const value = option.dataset[attr];
    if (option.getAttribute("aria-pressed") === "true") return;
    if (onChange?.(value, { via: "click" }) !== false) set(group, value, attr);
  });
  return {
    set: (value) => set(group, value, attr),
    value: () => optionsOf(group, attr).find((option) => option.getAttribute("aria-pressed") === "true")?.dataset[attr] ?? "",
  };
}

export const segmented = { html, render, bind, set };
