(() => {
  "use strict";
  // The filter bar (docs/ui-foundations.md, "Filter bar"): one row under
  // the tab row(s) of Observability (Traces, Logs, Metrics) and System
  // (Overview, Queries, Disks), the same markup, sizes and phone fold on
  // the six views (.obsFilterBar, css/20-features/observability.css).
  // Left to right: the time range first, the view's filters as
  // "Label · Value" pickers (ns.menu.select), free-text fields and
  // toggle chips, then at the right end the secondary actions (Add panel)
  // and the action: Observability's primary
  // "Search" (its queries run on demand), System's refresh icon button (a
  // change applies at once). The lead holds the range and the pickers, the
  // tail the rest; the wrap rules are the stylesheet's.
  //
  //   filterBar.create({ id, className, dataset, hidden, onSubmit }) -> bar
  //     builds an empty bar (System; Observability ships its markup):
  //     bar.form (a <form>: its submit is the action, bar.onSubmit(event)
  //     runs it), bar.lead, bar.tail, bar.actions, and
  //       bar.range(idPrefix)          the time range slot, first in the
  //                                    lead -> the picker root
  //                                    (ns.timeRange.create mounts on it)
  //       bar.field(select, { narrow, summary, tail, className, pickerClass })
  //                                    a picker over `select` (tail: in
  //                                    the tail, before the chips: the
  //                                    lead keeps one row down to 761 px)
  //                                    (data-field-label names it) in the
  //                                    lead -> its ns.menu handle;
  //                                    summary: false leaves it out of the
  //                                    phone summary's filter count (an
  //                                    order, not a filter)
  //       bar.chip({ id, label, title, pressed, onChange }) a toggle chip
  //                                    (aria-pressed) before the actions;
  //                                    its default state is not a filter
  //       bar.iconAction({ id, label, icon }) the action as an icon button
  //                                    (type submit: onSubmit runs it)
  //     A chip's set(on) changes it quietly; onChange(on) runs on
  //     a click.
  //   filterBar.mountSummary(form)
  //     the phone fold (at --bp-sm, 600 px, and below): one summary line, a
  //     .foldSummary "<time range> · N filters", stands for the folded
  //     bar and unfolds it; the action folds it again; the chips row right
  //     after the bar folds with it. Wider windows show the bar, the
  //     summary hidden (the rules sit in max-width: 600px blocks).
  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
  const { $, $$ } = ns.dom;

  function pressedOf(button) {
    return button.getAttribute("aria-pressed") === "true";
  }

  // A toggle chip: aria-pressed, onChange on a click. Nothing in a bar
  // refreshes on a timer: there is no live / auto-refresh toggle.
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
        // .traceSearchField: the pickers' look of the Observability bars.
        const field = h("div", { class: ["obsFilterBar__field", narrow && "obsFilterBar__field--narrow", "traceSearchField", extra], dataset: summary ? {} : { summary: "off" } }, picker);
        if (inTail) tail.insertBefore(field, $(":scope > .obsFilterBar__chip", tail) || actions);
        else lead.appendChild(field);
        const handle = ns.menu.select(select);
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
        }, ns.icon.el(icon, { size: "sm", className: "refreshGlyph" }));
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

  // The filters a bar applies besides its time range: each picker not on
  // "All" (the lead's, a tail field's; a field with data-summary="off", an
  // order, does not count), each free-text field holding text, each chip
  // out of its default state, each chip of the row under it.
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

  // The range as the bar shows it: the option of the picker's hidden select
  // (Observability), else its button without the "Time range" label.
  function rangeText(form) {
    const select = $(".tracePicker--range select", form);
    const text = select ? select.options[0]?.textContent : $(".tracePicker--range > .tracePicker__button", form)?.textContent;
    return String(text || "").replace(/^Time range · /, "").trim();
  }

  function mountSummary(form) {
    if (!form || $(":scope > .obsFilterSummary", form)) return;
    const range = h("span", { class: "foldSummary__text" });
    const count = h("span", { class: "foldSummary__meta" });
    const summary = h("button", { type: "button", class: "foldSummary obsFilterSummary" }, range, count, ns.icon.el("chevron-down", { className: "foldSummary__chevron" }));
    form.prepend(summary);
    const fold = (folded) => {
      form.classList.toggle("is-folded", folded);
      summary.setAttribute("aria-expanded", folded ? "false" : "true");
      summary.title = folded ? "Show the filters" : "Hide the filters";
    };
    const refresh = () => {
      const text = rangeText(form);
      const n = filterCount(form);
      if (range.textContent !== text) range.textContent = text;
      const label = n ? ` · ${n} filter${n === 1 ? "" : "s"}` : "";
      if (count.textContent !== label) count.textContent = label;
    };
    summary.addEventListener("click", () => fold(!form.classList.contains("is-folded")));
    form.addEventListener("submit", () => { if (ns.shell?.isAtMost("sm")) fold(true); });
    form.addEventListener("input", refresh);
    const watch = new MutationObserver(() => requestAnimationFrame(refresh));
    watch.observe(form, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-pressed", "hidden"] });
    if (form.nextElementSibling?.matches(".chips")) watch.observe(form.nextElementSibling, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
    fold(!!ns.shell?.isAtMost("sm"));
    refresh();
  }

  ns.filterBar = Object.freeze({ create, mountSummary, filterCount });
})();
