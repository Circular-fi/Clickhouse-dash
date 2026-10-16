// The filter bar (docs/ui-foundations.md, "Filter bar"). It is one row under
// the tab row(s) of Observability (Traces, Logs, Metrics) and System
// (Overview, Queries, Disks). It has the same markup, sizes and phone fold on
// the six views (.obsFilterBar, css/20-features/observability.css).
// The order runs from left to right. The time range comes first. Then come the
// view's filters as "Label · Value" pickers (ns.menu.select), free-text fields and
// toggle chips. The secondary actions (Add panel) and the main action are at the right end.
// Observability's main action is "Search", and its queries run on demand.
// System's main action is a refresh icon button. A change in System applies at once.
// The lead holds the range and the pickers. The tail holds the rest.
// The stylesheet sets the wrap rules.
//
//   filterBar.create({ id, className, dataset, hidden, onSubmit }) -> bar
//     builds an empty bar (System; Observability ships its markup):
//     bar.form (a <form>: its submit is the action, bar.onSubmit(event)
//     runs it), bar.lead, bar.tail, bar.actions, and
//       bar.range(idPrefix)          the time range slot, first in the lead. It is
//                                    the picker root. ns.timeRange.create mounts on it.
//       bar.field(select, { narrow, summary, tail, className, pickerClass })
//                                    a picker over `select`. The data-field-label attribute
//                                    names it. The picker goes in the lead, and the call returns
//                                    its ns.menu handle. tail: the picker goes in the tail,
//                                    before the chips. The lead keeps one row down to 761 px.
//                                    summary: false leaves the picker out of the phone summary's
//                                    filter count. Use it for an order, which is not a filter.
//       bar.chip({ id, label, title, pressed, onChange }) a toggle chip
//                                    (aria-pressed). It goes before the actions.
//                                    Its default state is not a filter.
//       bar.iconAction({ id, label, icon }) the action as an icon button
//                                    (type submit: onSubmit runs it)
// A chip's set(on) changes the chip. It does not run onChange.
// onChange(on) runs on a click.
//   filterBar.mountSummary(form, { describe })
//     the phone fold (at --bp-sm, 600 px, and below). It shows one summary line, a
//     .foldSummary "<time range> · N filters". The summary stands for the folded
//     bar and unfolds it. The action folds the bar again. The chips row folds with
//     the bar, right after it.
//     Wider windows show the bar and hide the summary. The rules are in max-width: 600px
//     blocks. A bar with no time range (the MCP Usage bar: a window and a group) gives
//     describe(). describe() returns the text that stands for the bar on the folded line.

import { dom, h, shell } from "./app_dom.js";
import { icon as iconMod } from "./app_ui_icon.js";
import { menu } from "./app_ui_menu.js";

const { $, $$ } = dom;

function pressedOf(button) {
  return button.getAttribute("aria-pressed") === "true";
}

// A toggle chip has aria-pressed. onChange runs on a click. No element in a bar
// refreshes on a timer. There is no live / auto-refresh toggle.
function toggleButton(className, { id = "", label = "", title = "", pressed = false, onChange = null } = {}) {
  const button = h("button", {
    type: "button",
    class: ["button", "obsFilterBar__toggle", className],
    id: id || null,
    title: title || null,
    aria: { pressed: pressed ? "true" : "false" },
    dataset: { default: pressed ? "true" : "false" },
  }, h("span", null, label));
  const set = (on) => button.setAttribute("aria-pressed", on ? "true" : "false");
  button.addEventListener("click", () => {
    const on = !pressedOf(button);
    set(on);
    onChange?.(on);
  });
  return Object.assign(button, { set, pressed: () => pressedOf(button) });
}

function create({ id = "", className = "", dataset = {}, hidden = false, onSubmit = null } = {}) {
  const lead = h("div", { class: "obsFilterBar__lead" });
  const actions = h("div", { class: "obsFilterBar__actions" });
  const tail = h("div", { class: "obsFilterBar__tail" }, actions);
  const form = h("form", { class: ["obsFilterBar", "traceSearchBar", className], id: id || null, autocomplete: "off", dataset, hidden }, lead, tail);
  const bar = {
    form,
    onSubmit,
    lead,
    tail,
    actions,
    range(idPrefix) {
      const root = h("div", { class: "themeSelect tracePicker tracePicker--range" },
        h("button", { type: "button", class: "button themeSelect__button tracePicker__button", id: `${idPrefix}RangeButton`, aria: { haspopup: "dialog", expanded: "false" } }, "Time range"));
      lead.prepend(h("div", { class: "obsFilterBar__range traceSearchBar__range" }, root));
      return root;
    },
    field(select, { narrow = false, summary = true, tail: inTail = false, className: extra = "", pickerClass = "" } = {}) {
      const picker = h("div", { class: ["themeSelect tracePicker", pickerClass] }, select);
      // .traceSearchField gives the pickers the look of the Observability bars.
      const field = h("div", { class: ["obsFilterBar__field", narrow && "obsFilterBar__field--narrow", "traceSearchField", extra], dataset: summary ? {} : { summary: "off" } }, picker);
      if (inTail) tail.insertBefore(field, $(":scope > .obsFilterBar__chip", tail) || actions);
      else lead.appendChild(field);
      const handle = menu.select(select);
      handle.field = field;
      return handle;
    },
    chip(options) {
      const button = toggleButton("obsFilterBar__option obsFilterBar__chip", options);
      tail.insertBefore(button, actions);
      return button;
    },
    iconAction({ id: actionId = "", label = "", icon = "refresh" } = {}) {
      const button = h("button", {
        type: "submit",
        class: "refreshButton obsFilterBar__submit obsFilterBar__submit--icon",
        id: actionId || null,
        title: label || null,
        aria: { label: label || null },
      }, iconMod.el(icon, { size: "sm", className: "refreshGlyph" }));
      actions.appendChild(button);
      return button;
    },
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    bar.onSubmit?.(event);
  });
  return bar;
}

// ------------------------------------------------------------- phones

// The filters that a bar applies, besides its time range, are these. Each picker
// that is not on "All" counts. This includes the lead picker and the tail pickers.
// A field with data-summary="off" does not count, because it is an order and not a filter.
// Each free-text field that holds text counts, and so does each chip that is not in
// its default state, and each chip of the row under the bar.
function filterCount(form) {
  let count = 0;
  for (const button of $$(".obsFilterBar__lead .tracePicker:not(.tracePicker--range) .tracePicker__button, .obsFilterBar__tail .obsFilterBar__field .tracePicker__button", form)) {
    if (button.closest('[data-summary="off"], [hidden]')) continue;
    const value = String(button.textContent || "").split(" · ").slice(1).join(" · ").trim();
    if (value && value !== "All") count += 1;
  }
  for (const field of $$(".obsFilterBar__text", form)) {
    if ($$("input", field).some((input) => input.value.trim())) count += 1;
  }
  for (const chip of $$(".obsFilterBar__chip[aria-pressed]", form)) {
    if (!chip.hidden && chip.getAttribute("aria-pressed") !== chip.dataset.default) count += 1;
  }
  const chips = form.nextElementSibling;
  if (chips?.matches(".chips") && !chips.hidden) count += $$(".chip", chips).length;
  return count;
}

// The function returns the range as the bar shows it. The range is the option of the
// picker's hidden select (Observability). Otherwise, it is the picker button without the "Time range" label.
function rangeText(form) {
  const select = $(".tracePicker--range select", form);
  const text = select ? select.options[0]?.textContent : $(".tracePicker--range > .tracePicker__button", form)?.textContent;
  return String(text || "").replace(/^Time range · /, "").trim();
}

function mountSummary(form, { describe = null } = {}) {
  if (!form || $(":scope > .obsFilterSummary", form)) return;
  const range = h("span", { class: "foldSummary__text" });
  const count = h("span", { class: "foldSummary__meta" });
  const summary = h("button", { type: "button", class: "foldSummary obsFilterSummary" }, range, count, iconMod.el("chevron-down", { className: "foldSummary__chevron" }));
  form.prepend(summary);
  // When folded, the line says which filters apply ("<range> · 2 filters"). When open,
  // the filters are there to read. The line then says what a click does.
  // A range shown twice, once in the line and once in the picker, is one too many.
  const refresh = () => {
    const open = !form.classList.contains("is-folded");
    const text = open ? "Hide the filters" : describe ? describe() : rangeText(form);
    const n = open ? 0 : filterCount(form);
    if (range.textContent !== text) range.textContent = text;
    const label = n ? ` · ${n} filter${n === 1 ? "" : "s"}` : "";
    if (count.textContent !== label) count.textContent = label;
  };
  const fold = (folded) => {
    form.classList.toggle("is-folded", folded);
    summary.setAttribute("aria-expanded", folded ? "false" : "true");
    summary.title = folded ? "Show the filters" : "Hide the filters";
    refresh();
  };
  summary.addEventListener("click", () => fold(!form.classList.contains("is-folded")));
  form.addEventListener("submit", () => { if (shell?.isAtMost("sm")) fold(true); });
  form.addEventListener("input", refresh);
  const watch = new MutationObserver(() => requestAnimationFrame(refresh));
  watch.observe(form, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
  if (form.nextElementSibling?.matches(".chips")) watch.observe(form.nextElementSibling, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  fold(!!shell?.isAtMost("sm"));
  refresh();
}

export const filterBar = Object.freeze({ create, mountSummary, filterCount });
