(() => {
  "use strict";

  // Shared modal dialog: one shell for every modal of the Query page (the
  // profiling dialog, the query library and their form / confirm prompts).
  //
  // The shell is a native <dialog> opened with showModal(): the browser traps
  // the focus inside it, makes the rest of the page inert and stacks a dialog
  // opened from another one above it (a confirm over the library). This module
  // adds what the browser does not: the shared markup and size classes,
  // a click on the backdrop closes, the focus moves in on open and goes back
  // to the opener (or a fallback) on close, and floating children (toasts)
  // follow the top dialog. Every open dialog is a modal layer of ns.layers
  // (app_ui_layers.js): Escape closes the top layer only (a menu or popover
  // over the dialog first), and the focus goes back through the layer.
  //
  //   shell({ id, title, size, tabs, ... })   -> the elements of a new shell
  //   bind(dialog, { onClose, ... })           -> { open, close, isOpen }
  //   open({ title, body, actions, onSubmit }) -> Promise<value | null>
  //   confirm({ title, message, ... })         -> Promise<boolean>
  //   host()                                   -> the top open dialog, or <body>
  //
  // Markup (query.html writes the profiling one; shell() builds the others):
  //   <dialog class="uiDialog uiDialog--lg|--sm">
  //     <div|form class="uiDialog__frame">
  //       <div class="uiDialog__head"> heading (title, subtitle), actions, close
  //       <div class="uiDialog__tabs"> (optional) .uiDialog__tab buttons
  //       <div class="uiDialog__body">
  // A head that holds the tabs in place of the title (the query library):
  //       <div class="uiDialog__head uiDialog__head--tabs"> .uiDialog__tabs, actions, close
  // and the dialog is named by aria-label (the label of shell()).

  window.ChDash = window.ChDash || {};
  const ns = window.ChDash;
  if (ns.dialog) return;

  // Open dialogs, bottom first (the top layer order).
  const stack = [];
  let uid = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function host() {
    return stack[stack.length - 1] || document.body;
  }

  // A control the focus can go back to (not <body>: nothing was focused).
  function isFocusable(node) {
    return node instanceof HTMLElement && node !== document.body && node.isConnected && !node.disabled
      && !node.closest("[hidden], [inert]") && node.getClientRects().length > 0;
  }

  // A tab bar in the profiling dialog's tab style (the caller selects):
  // { label, items: [{ id, label, controls, value }] }.
  function tabBar(tabs) {
    const bar = el("div", "uiDialog__tabs");
    bar.setAttribute("role", "tablist");
    if (tabs.label) bar.setAttribute("aria-label", tabs.label);
    const buttons = tabs.items.map((item) => {
      const tab = el("button", "uiDialog__tab", item.label);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", "false");
      tab.tabIndex = -1;
      if (item.id) tab.id = item.id;
      if (item.controls) tab.setAttribute("aria-controls", item.controls);
      if (item.value != null) tab.dataset.tab = String(item.value);
      bar.appendChild(tab);
      return tab;
    });
    return { bar, buttons };
  }

  // tabs adds a tab bar under the head. With tabs.inHead the bar takes the
  // place of the title in the head, and label names the dialog (aria-label):
  // heading, title and subtitle are then null.
  function shell({ id = "", title = "", label = "", titleId = "", subtitleId = "", closeLabel = "Close", size = "lg", className = "", form = false, tabs = null } = {}) {
    const n = ++uid;
    const dialog = el("dialog", `uiDialog uiDialog--${size}${className ? ` ${className}` : ""}`);
    if (id) dialog.id = id;
    dialog.tabIndex = -1;
    const frame = el(form ? "form" : "div", "uiDialog__frame");
    if (form) {
      frame.method = "dialog";
      frame.noValidate = true;
    }
    const bar = tabs && Array.isArray(tabs.items) ? tabBar(tabs) : null;
    const tabsInHead = !!bar && tabs.inHead === true;
    const head = el("div", tabsInHead ? "uiDialog__head uiDialog__head--tabs" : "uiDialog__head");
    let heading = null;
    let titleEl = null;
    let subtitle = null;
    if (!tabsInHead) {
      heading = el("div", "uiDialog__heading");
      titleEl = el("h2", "uiDialog__title", title);
      titleEl.id = titleId || `uiDialogTitle${n}`;
      subtitle = el("div", "uiDialog__subtitle");
      subtitle.id = subtitleId || `uiDialogSubtitle${n}`;
      subtitle.hidden = true;
      heading.append(titleEl, subtitle);
    }
    const actions = el("div", "uiDialog__actions");
    const close = el("button", "closeCross uiDialog__close", "\u00d7");
    close.type = "button";
    close.setAttribute("aria-label", closeLabel);
    close.title = `${closeLabel} (Esc)`;
    actions.appendChild(close);
    head.append(tabsInHead ? bar.bar : heading, actions);
    const body = el("div", "uiDialog__body");
    frame.append(head);
    if (bar && !tabsInHead) frame.appendChild(bar.bar);
    frame.appendChild(body);
    dialog.appendChild(frame);
    if (titleEl) dialog.setAttribute("aria-labelledby", titleEl.id);
    else dialog.setAttribute("aria-label", label || tabs.label || "");
    document.body.appendChild(dialog);
    return { dialog, frame, head, heading, title: titleEl, subtitle, actions, close, tabs: bar ? bar.bar : null, tabButtons: bar ? bar.buttons : [], body };
  }

  // Open / close behaviour of a shell. onClose runs once per close, however
  // the dialog closed (close button, Escape, backdrop, close()). The focus
  // goes back to the element focused at open, else to the first usable one
  // of fallbackFocus (an element, a list, or a function returning either).
  function bind(dialog, { onClose = null, closeButton = null, fallbackFocus = null } = {}) {
    if (!dialog) return null;
    let returnTo = null;
    let restore = true;
    let pressedBackdrop = false;
    let value = null;
    let layer = null;

    const finish = () => {
      const index = stack.indexOf(dialog);
      if (index < 0) return;
      stack.splice(index, 1);
      // Toasts and other floating children move to the dialog now on top.
      for (const node of dialog.querySelectorAll(":scope > [data-dialog-float]")) host().appendChild(node);
      // The layer gives the focus back: to the opener, else to the first
      // usable element of fallbackFocus.
      layer?.close({ restoreFocus: restore, force: true });
      layer = null;
      returnTo = null;
      const result = value;
      value = null;
      restore = true;
      if (typeof onClose === "function") onClose(result);
    };

    // Escape: closed here at once, so the focus is back before the next key
    // (the browser's own "close" event comes a task later).
    dialog.addEventListener("cancel", (ev) => {
      if (ev.target !== dialog) return;
      ev.preventDefault();
      close();
    });
    // Closed by the browser or by dialog.close() elsewhere. The event comes a
    // task after the close: a dialog reopened meanwhile stays open.
    dialog.addEventListener("close", () => {
      if (!dialog.open) finish();
    });
    // A click that both starts and ends on the backdrop (the dialog box
    // itself is covered by its frame) closes; a drag out of a field does not.
    dialog.addEventListener("pointerdown", (ev) => {
      pressedBackdrop = ev.target === dialog;
    });
    dialog.addEventListener("click", (ev) => {
      const backdrop = pressedBackdrop && ev.target === dialog;
      pressedBackdrop = false;
      if (backdrop) close();
    });
    (closeButton || dialog.querySelector(":scope > .uiDialog__frame > .uiDialog__head .uiDialog__close"))?.addEventListener("click", () => close());

    function isOpen() {
      return dialog.open;
    }

    // focus: the element to focus, or a function returning it (default: the
    // dialog itself, so Tab starts at its first control).
    function open({ focus = null, returnFocus = null } = {}) {
      if (dialog.open) return;
      returnTo = returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
      value = null;
      restore = true;
      dialog.showModal();
      stack.push(dialog);
      layer = ns.layers.push({
        el: dialog,
        modal: true,
        name: dialog.id || "dialog",
        opener: returnTo,
        fallbackFocus: () => {
          const fallback = typeof fallbackFocus === "function" ? fallbackFocus() : fallbackFocus;
          return Array.isArray(fallback) ? fallback : [fallback];
        },
        onDismiss: () => close(),
      });
      const target = typeof focus === "function" ? focus() : focus;
      (isFocusable(target) ? target : dialog).focus({ preventScroll: true });
    }

    // restoreFocus: false when the caller moves the focus itself.
    function close(result = null, { restoreFocus = true } = {}) {
      if (!dialog.open) return;
      value = result;
      restore = restoreFocus;
      dialog.close();
      finish();
    }

    return { dialog, open, close, isOpen };
  }

  // A transient dialog: built, shown, removed when it closes. actions are its
  // footer buttons, [{ label, value, kind: "primary" | "danger", submit }]; the
  // submit one also answers Enter. onSubmit(value, form) may return false
  // (stay open), a value (resolve with it) or throw (the message shows in the
  // dialog, and err.field names the [data-field] control to mark and focus).
  // Resolves with null when dismissed.
  function open({ title, body = null, actions = null, size = "sm", className = "", onSubmit = null, focus = null, closeLabel = "Close" } = {}) {
    return new Promise((resolve) => {
      const parts = shell({ title, size, className, closeLabel, form: true });
      const { dialog, frame } = parts;
      if (body) parts.body.appendChild(body);
      const error = el("div", "uiDialog__error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const foot = el("div", "uiDialog__foot");
      const list = actions || [{ label: "Cancel", value: null }, { label: "OK", value: "submit", kind: "primary", submit: true }];
      const buttons = list.map((action) => {
        const kind = action.kind === "danger" ? " button--danger" : action.kind === "primary" ? " button--primary" : "";
        const button = el("button", `button${kind}${action.submit ? " uiDialog__submit" : ""}`, action.label);
        button.type = action.submit ? "submit" : "button";
        foot.appendChild(button);
        return { action, button };
      });
      frame.append(error, foot);
      const submit = buttons.find((b) => b.action.submit) || null;

      let settled = false;
      const controller = bind(dialog, {
        onClose(value) {
          settled = true;
          dialog.remove();
          resolve(value);
        },
      });
      const showError = (err) => {
        error.textContent = err instanceof Error ? err.message : String(err || "The change failed.");
        error.hidden = false;
        for (const input of frame.querySelectorAll("[aria-invalid]")) input.removeAttribute("aria-invalid");
        const field = err && err.field ? frame.querySelector(`[data-field="${String(err.field).replace(/["\\]/g, "")}"]`) : null;
        if (field) {
          field.setAttribute("aria-invalid", "true");
          field.focus();
        }
      };
      let busy = false;
      const run = async (value) => {
        if (busy || settled) return;
        busy = true;
        for (const b of buttons) b.button.disabled = true;
        try {
          const result = onSubmit ? await onSubmit(value, frame) : value;
          if (result === false || settled) return;
          controller.close(result === undefined ? value : result);
        } catch (err) {
          showError(err);
        } finally {
          busy = false;
          if (!settled) for (const b of buttons) b.button.disabled = false;
        }
      };
      frame.addEventListener("submit", (ev) => {
        ev.preventDefault();
        if (submit) run(submit.action.value);
      });
      for (const { action, button } of buttons) {
        if (action.submit) continue;
        button.addEventListener("click", () => {
          if (action.value == null) controller.close(null);
          else run(action.value);
        });
      }
      controller.open({
        focus: () => (typeof focus === "function" ? focus(frame) : focus)
          || frame.querySelector("[autofocus]")
          || frame.querySelector(".uiDialog__body input, .uiDialog__body textarea, .uiDialog__body select")
          || submit?.button,
      });
      const first = document.activeElement;
      if (first instanceof HTMLInputElement && dialog.contains(first) && typeof first.select === "function") first.select();
    });
  }

  // Yes / no. The focus starts on Cancel when the action destroys something.
  async function confirm({ title, message, confirmLabel = "OK", cancelLabel = "Cancel", danger = false, className = "" } = {}) {
    const body = el("p", "uiDialog__message", message);
    const answer = await open({
      title,
      body,
      className,
      actions: [
        { label: cancelLabel, value: null },
        { label: confirmLabel, value: "confirm", kind: danger ? "danger" : "primary", submit: true },
      ],
      focus: danger ? (frame) => frame.querySelector(".uiDialog__foot .button:not(.uiDialog__submit)") : null,
    });
    return answer !== null;
  }

  ns.dialog = { shell, bind, open, confirm, host };
})();
