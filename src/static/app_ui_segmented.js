(() => {
  "use strict";
  // Segmented controls: a short row of mutually exclusive choices that
  // switch a view in place (Traces | Spans, List | Table, Percentiles |
  // Heatmap, Table | Chart, the chart types, Lineage | Storage, the context
  // window presets...). One look (.segmented / .segmented__option, the
  // pressed option on --seg-active-bg), two sizes (default 28 px, compact
  // 24 px: .segmented--compact) and one ARIA pattern: role=group (named by
  // aria-label) of toggle buttons carrying aria-pressed. Each option keeps
  // its value in a data attribute the caller names (data-<attr>, "value" by
  // default), so its selectors and URLs keep their meaning.
  //
  //   html(options, { attr, value, size, label, className })  markup string
  //   render(group, options, { attr, value, size, label })    builds the row
  //   bind(group, { attr, onChange(value, { via }) })        -> { set(value), value() }
  //   set(group, value, attr)                                  marks the pressed option
  //
  // options: [{ value, label, title, disabled, hidden, html }] (html: a
  // trusted inner markup, e.g. an icon before the label).
  const ns = window.ChDash;
  if (!ns) return;

  const dataKey = (attr) => `data-${attr.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  function groupClass(size, className) {
    return ["segmented", size === "compact" ? "segmented--compact" : "", className || ""].filter(Boolean).join(" ");
  }

  function optionsOf(group, attr) {
    return group ? [...group.querySelectorAll(`[${dataKey(attr)}]`)] : [];
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
      return `<button type="button" class="segmented__option" ${key}="${esc(option.value)}" aria-pressed="${pressed}"${title}${extra}>${inner}</button>`;
    }).join("");
    return `<div class="${esc(groupClass(size, className))}" role="group"${label ? ` aria-label="${esc(label)}"` : ""}>${items}</div>`;
  }

  // Fills `group` (its own classes kept) with the options.
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

  // The click on an option that is not pressed yet calls onChange; the
  // caller decides (and calls set) or set happens here when it returns
  // anything but false.
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

  ns.segmented = { html, render, bind, set };
})();
