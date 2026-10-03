(() => {
  "use strict";
  // Copy to clipboard, one component for every page (css/10-components/copy.css):
  //
  //   ui.copyText(text, control)      copies, then gives `control` the feedback
  //   ui.copyButton(button, getText)  an icon button (.uiCopy): the copy icon,
  //                                   a tooltip (title / aria-label) and the
  //                                   feedback; getText() may return a promise
  //   ui.copyButtonHtml({ label, attrs, className })
  //                                   the same button as an HTML string, for the
  //                                   modules that render strings and delegate
  //                                   clicks to ui.copyText
  //   ui.copySplit(options)           the "Copy JSON" split button and its menu
  //   ui.downloadText(name, text)     its "Download JSON": the text as a file
  //
  // One feedback, held FEEDBACK_MS: the control gets .is-copied (.is-copyFailed
  // when the clipboard refused) and reads "Copied" ("Copy failed"): a text
  // button swaps its label, an icon button shows the check icon and an
  // announced "Copied" tip (ns.popover.flash; data-copied holds the state).
  const ns = window.ChDash;
  if (!ns) return;
  const { $ } = ns.dom;
  const ui = (ns.ui = ns.ui || {});

  const FEEDBACK_MS = 1200;
  const COPIED = "Copied";
  const FAILED = "Copy failed";

  async function writeText(text) {
    const value = String(text ?? "");
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    // http:// origins have no async clipboard: a selected, off-screen textarea,
    // in the top modal dialog when one is open (the page under it is inert, so
    // a textarea there could not take the selection), e.g. the query library.
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.left = "-1000px";
    (ns.dialog?.host?.() || document.body).appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (ok === false) throw new Error("The browser refused to copy.");
  }

  const timers = new WeakMap();

  // The text a text button shows: its .uiCopy__label, or its own text when it
  // has no element children (an icon button keeps its icon and gets a bubble).
  function labelOf(control) {
    const label = $(":scope > .uiCopy__label", control);
    if (label) return label;
    return control.children.length === 0 && control.textContent.trim() ? control : null;
  }

  function restore(control) {
    control.classList.remove("is-copied", "is-copyFailed");
    control.removeAttribute("data-copied");
    const label = labelOf(control);
    if (label && control.dataset.copyIdle != null) label.textContent = control.dataset.copyIdle;
    delete control.dataset.copyIdle;
  }

  function feedback(control, ok = true) {
    if (!(control instanceof Element)) return;
    clearTimeout(timers.get(control));
    if (control.dataset.copyIdle != null) restore(control);
    control.classList.add(ok ? "is-copied" : "is-copyFailed");
    const label = labelOf(control);
    if (label) {
      control.dataset.copyIdle = label.textContent;
      label.textContent = ok ? COPIED : FAILED;
    } else {
      control.setAttribute("data-copied", ok ? COPIED : FAILED);
      ns.popover?.flash(control, ok ? COPIED : FAILED, { duration: FEEDBACK_MS });
    }
    timers.set(control, setTimeout(() => restore(control), ok ? FEEDBACK_MS : FEEDBACK_MS + 300));
  }

  async function copyText(text, control = null) {
    try {
      await writeText(text);
      feedback(control, true);
      return true;
    } catch {
      feedback(control, false);
      return false;
    }
  }

  const esc = (value) => ns.util.escapeHtml(value ?? "");

  const ICON = '<span class="uiCopy__icon" aria-hidden="true"></span>';

  // attrs: { "data-copy-trace": id, ... } (values are escaped).
  function copyButtonHtml({ label = "Copy", attrs = {}, className = "", disabled = false } = {}) {
    const extra = Object.entries(attrs).map(([name, value]) => ` ${name}="${esc(value)}"`).join("");
    return `<button type="button" class="uiCopy${className ? ` ${esc(className)}` : ""}" title="${esc(label)}" aria-label="${esc(label)}"${extra}${disabled ? " disabled" : ""}>${ICON}</button>`;
  }

  // button: an existing <button> (kept, and filled with the icon when empty) or
  // null for a new one. Returns the button.
  function copyButton(button, getText, { label = "Copy", className = "" } = {}) {
    const el = button || document.createElement("button");
    if (!button) el.type = "button";
    el.classList.add("uiCopy");
    if (className) el.classList.add(...className.split(/\s+/).filter(Boolean));
    if (!el.title) el.title = label;
    if (!el.getAttribute("aria-label")) el.setAttribute("aria-label", label);
    if (!$(".uiCopy__icon", el)) el.insertAdjacentHTML("afterbegin", ICON);
    el.addEventListener("click", async (event) => {
      event.stopPropagation();
      const text = await getText?.(event);
      if (text == null || text === "") return;
      await copyText(text, el);
    });
    return el;
  }

  // ------------------------------------------------------------ split button

  // The menu of a split button is an ns.menu split (app_ui_menu.js): keys,
  // focus, placement and dismissal (ns.layers) are ns.menu's.
  function menuDriver(root, main, toggle, menu) {
    const handle = ns.menu.split(main, toggle, menu, { root });
    return {
      open: () => handle.open(),
      close: ({ immediate = false, focus = false } = {}) => handle.close({ immediate, focus }),
      isOpen: () => handle.isOpen(),
    };
  }

  function menuItem({ id = "", label }) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "runMenu__opt";
    item.setAttribute("role", "menuitem");
    if (id) item.id = id;
    const text = document.createElement("span");
    text.className = "runMenu__optText";
    text.textContent = label;
    item.appendChild(text);
    return item;
  }

  // copySplit({ root, label = "Copy JSON", title, getText, items, className })
  //   root:  existing markup (.runSplit.copySplit > .runSplit__buttons >
  //          .runSplit__main + .runSplit__toggle, then .runMenu), or none for a
  //          new control (append the returned .el).
  //   getText(): the main button's text (may return a promise); "" copies nothing.
  //   items: [{ el | id, label, copy(): text, onSelect(event) }]: an item with
  //          copy() copies its text (feedback on the main button); onSelect runs
  //          otherwise. Every item closes the menu.
  // Returns { el, main, toggle, menu, items, setDisabled(on), open(), close(), isOpen() }.
  function copySplit({ root = null, label = "Copy JSON", title = "", getText = null, items = [], className = "" } = {}) {
    let el = root;
    let main, toggle, menu;
    if (el) {
      main = $(".runSplit__main", el);
      toggle = $(".runSplit__toggle", el);
      menu = $(".runMenu", el);
    } else {
      el = document.createElement("div");
      el.className = `runSplit copySplit${className ? ` ${className}` : ""}`;
      const buttons = document.createElement("div");
      buttons.className = "runSplit__buttons";
      main = document.createElement("button");
      main.type = "button";
      main.className = "button button--small resultsStack__copy runSplit__main";
      main.textContent = label;
      if (title) main.title = title;
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "button button--small runSplit__toggle";
      toggle.title = "Copy options";
      toggle.setAttribute("aria-haspopup", "menu");
      toggle.setAttribute("aria-expanded", "false");
      menu = document.createElement("div");
      menu.className = "runMenu copyMenu";
      menu.setAttribute("role", "menu");
      menu.tabIndex = -1;
      menu.hidden = true;
      buttons.append(main, toggle);
      el.append(buttons, menu);
    }
    if (!toggle.getAttribute("aria-label")) toggle.setAttribute("aria-label", toggle.title || "Copy options");
    const driver = menuDriver(el, main, toggle, menu);
    const byKey = {};
    for (const spec of items) {
      const item = spec.el || (spec.id && $(`#${CSS.escape(spec.id)}`, el)) || menu.appendChild(menuItem(spec));
      byKey[spec.key || spec.id || spec.label] = item;
      item.addEventListener("click", async (event) => {
        driver.close({ immediate: true });
        if (typeof spec.copy === "function") {
          const text = await spec.copy(event);
          if (text != null && text !== "") await copyText(text, main);
        } else spec.onSelect?.(event);
      });
    }
    if (typeof getText === "function") {
      main.addEventListener("click", async (event) => {
        const text = await getText(event);
        if (text == null || text === "") return;
        await copyText(text, main);
      });
    }
    const setDisabled = (on) => {
      main.disabled = !!on;
      toggle.disabled = !!on;
      if (on) driver.close({ immediate: true });
    };
    return { el, main, toggle, menu, items: byKey, setDisabled, open: driver.open, close: driver.close, isOpen: driver.isOpen };
  }

  // The "Download JSON" of a copy split: text saved as a file.
  function downloadText(name, text, type = "application/json") {
    const blob = new Blob([String(text ?? "")], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  Object.assign(ui, { copyText, copyFeedback: feedback, copyButton, copyButtonHtml, copySplit, downloadText });
  ns.copy = Object.freeze({ text: copyText, feedback, button: copyButton, buttonHtml: copyButtonHtml, split: copySplit, download: downloadText, FEEDBACK_MS });
})();
