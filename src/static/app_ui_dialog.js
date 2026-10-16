// Shared modal dialog. One shell serves every modal of the Query page.
// These modals are the profiling dialog, the query library and their form and confirm prompts.
//
// The shell is a native <dialog> that opens with showModal(). The browser traps the focus
// inside the dialog. It makes the rest of the page inert. It stacks a dialog that opens from
// another dialog above it (a confirm over the library).
//
// This module adds what the browser does not give. It adds the shared markup and size classes.
// A click on the backdrop closes the dialog. On open, the focus moves into the dialog.
// On close, the focus returns to the opener, or to a fallback. Floating children (toasts)
// follow the top dialog.
//
// Every open dialog is a modal layer of ns.layers (app_ui_layers.js). Escape closes only the
// top layer. A menu or popover over the dialog closes first. The focus returns through the layer.
//
//   shell({ id, title, size, tabs, ... })   -> the elements of a new shell
//   bind(dialog, { onClose, ... })           -> { open, close, isOpen }
//   open({ title, body, actions, onSubmit }) -> Promise<value | null>
//   confirm({ title, message, ... })         -> Promise<boolean>
//   host()                                   -> the top open dialog, or <body>
//
// Markup. query.html writes the profiling dialog. shell() builds the others:
//   <dialog class="uiDialog uiDialog--lg|--sm">
//     <div|form class="uiDialog__frame">
//       <div class="uiDialog__head"> heading (title, subtitle), actions, close
//       <div class="contentTabs uiDialog__tabs"> (optional) .contentTabs__tab buttons
//       <div class="uiDialog__body">
// A head can hold the tabs in place of the title (the query library):
//       <div class="uiDialog__head uiDialog__head--tabs"> .uiDialog__tabs, actions, close
// The dialog gets its name from aria-label (the label of shell()).

import { dom, h } from "./app_dom.js";
import { icon } from "./app_ui_icon.js";
import { layers } from "./app_ui_layers.js";
import { tabs as tabsMod } from "./app_ui_tabs.js";
import { util } from "./app_util.js";

const { $, $$ } = dom;

// The open dialogs are the ns.layers modals. They are listed bottom first, in the top layer order.
let uid = 0;

const { host } = layers;

// A control that the focus can return to. It is never <body>, which means nothing was focused.
function isFocusable(node) {
  return node instanceof HTMLElement && node !== document.body && node.isConnected && !node.disabled
    && !node.closest("[hidden], [inert]") && node.getClientRects().length > 0;
}

// A tab row (.contentTabs) built by ns.tabs.render. The caller binds the row and selects a tab.
// The row has this shape: { label, items: [{ id, label, controls, value }] }.
function tabBar(tabs) {
  const bar = h("div", { class: "contentTabs uiDialog__tabs" });
  bar.setAttribute("role", "tablist");
  if (tabs.label) bar.setAttribute("aria-label", tabs.label);
  tabsMod?.render(bar, tabs.items.map((item) => ({ value: item.value != null ? String(item.value) : "", label: item.label, id: item.id, controls: item.controls })));
  return { bar, buttons: [...bar.children] };
}

// tabs adds a tab bar under the head. With tabs.inHead, the bar takes the place of the title
// in the head. The label then names the dialog (aria-label). In that case, heading, title and
// subtitle are null.
function shell({ id = "", title = "", label = "", titleId = "", subtitleId = "", closeLabel = "Close", size = "lg", className = "", form = false, tabs = null } = {}) {
  const n = ++uid;
  const dialog = h("dialog", { class: `uiDialog uiDialog--${size}${className ? ` ${className}` : ""}` });
  if (id) dialog.id = id;
  dialog.tabIndex = -1;
  const frame = h(form ? "form" : "div", { class: "uiDialog__frame" });
  if (form) {
    frame.method = "dialog";
    frame.noValidate = true;
  }
  const bar = tabs && Array.isArray(tabs.items) ? tabBar(tabs) : null;
  const tabsInHead = !!bar && tabs.inHead === true;
  const head = h("div", { class: tabsInHead ? "uiDialog__head uiDialog__head--tabs" : "uiDialog__head" });
  let heading = null;
  let titleEl = null;
  let subtitle = null;
  if (!tabsInHead) {
    heading = h("div", { class: "uiDialog__heading" });
    titleEl = h("h2", { class: "uiDialog__title" }, title);
    titleEl.id = titleId || `uiDialogTitle${n}`;
    subtitle = h("div", { class: "uiDialog__subtitle" });
    subtitle.id = subtitleId || `uiDialogSubtitle${n}`;
    subtitle.hidden = true;
    heading.append(titleEl, subtitle);
  }
  const actions = h("div", { class: "uiDialog__actions" });
  const close = h("button", { class: "closeCross uiDialog__close" }, icon.el("x"));
  close.type = "button";
  close.setAttribute("aria-label", closeLabel);
  close.title = `${closeLabel} (Esc)`;
  actions.appendChild(close);
  head.append(tabsInHead ? bar.bar : heading, actions);
  const body = h("div", { class: "uiDialog__body" });
  frame.append(head);
  if (bar && !tabsInHead) frame.appendChild(bar.bar);
  frame.appendChild(body);
  dialog.appendChild(frame);
  if (titleEl) dialog.setAttribute("aria-labelledby", titleEl.id);
  else dialog.setAttribute("aria-label", label || tabs.label || "");
  document.body.appendChild(dialog);
  return { dialog, frame, head, heading, title: titleEl, subtitle, actions, close, tabs: bar ? bar.bar : null, tabButtons: bar ? bar.buttons : [], body };
}

// Open and close behaviour of a shell. onClose runs once per close. This is true for every
// way of closing: the close button, Escape, the backdrop and close(). The focus returns to
// the element that had focus at open. If there is none, the focus goes to the first usable
// element of fallbackFocus. fallbackFocus is an element, a list, or a function that returns either.
//
// canClose() returns false to keep the dialog open. Escape, the close button, the backdrop and
// close() all wait for it. A dialog that sends a change uses this. Such a dialog cannot close
// before it knows the result.
function bind(dialog, { onClose = null, closeButton = null, fallbackFocus = null, canClose = null } = {}) {
  if (!dialog) return null;
  let returnTo = null;
  let restore = true;
  let pressedBackdrop = false;
  let value = null;
  let layer = null;

  const finish = () => {
    if (!layers.modalClosed(dialog)) return;
    // Toasts and other floating children move to the dialog that is now on top.
    for (const node of $$(":scope > [data-dialog-float]", dialog)) host().appendChild(node);
    // The layer returns the focus to the opener. If there is no opener, the focus goes to the
    // first usable element of fallbackFocus.
    layer?.close({ restoreFocus: restore, force: true });
    layer = null;
    returnTo = null;
    const result = value;
    value = null;
    restore = true;
    if (typeof onClose === "function") onClose(result);
  };

  // Escape: this code closes the dialog at once. The focus returns before the next key press.
  // The browser's own "close" event comes one task later.
  dialog.addEventListener("cancel", (ev) => {
    if (ev.target !== dialog) return;
    ev.preventDefault();
    close();
  });
  // The browser or a dialog.close() call elsewhere closes the dialog. The event comes one
  // task after the close. A dialog that is reopened in the meantime stays open.
  dialog.addEventListener("close", () => {
    if (!dialog.open) finish();
  });
  // A click that starts and ends on the backdrop closes the dialog. The frame covers the
  // dialog box itself. A drag out of a field does not close the dialog.
  dialog.addEventListener("pointerdown", (ev) => {
    pressedBackdrop = ev.target === dialog;
  });
  dialog.addEventListener("click", (ev) => {
    const backdrop = pressedBackdrop && ev.target === dialog;
    pressedBackdrop = false;
    if (backdrop) close();
  });
  (closeButton || $(":scope > .uiDialog__frame > .uiDialog__head .uiDialog__close", dialog))?.addEventListener("click", () => close());

  function isOpen() {
    return dialog.open;
  }

  // focus: the element to focus, or a function that returns it. The default is the
  // dialog itself, so Tab starts at its first control.
  function open({ focus = null, returnFocus = null } = {}) {
    if (dialog.open) return;
    returnTo = returnFocus || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    value = null;
    restore = true;
    dialog.showModal();
    layers.modalOpened(dialog);
    layer = layers.push({
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
    if (typeof canClose === "function" && !canClose()) return;
    value = result;
    restore = restoreFocus;
    dialog.close();
    finish();
  }

  return { dialog, open, close, isOpen };
}

// A transient dialog is built, shown and removed when it closes. actions are its footer buttons:
// [{ label, value, kind: "primary" | "danger", submit }]. The submit button also answers Enter.
//
// onSubmit(value, form) can return false to stay open. It can return a value to resolve with that
// value. It can also throw. The message then shows in the dialog, and err.field names the
// [data-field] control to mark and focus.
//
// validate(form) returns "" when the form can be sent. Otherwise, it returns the reason. While a
// reason exists, the submit button is off, and its title gives the reason. The check runs on every
// input and change. The promise resolves with null when the user dismisses the dialog.
function open({ title, body = null, actions = null, size = "sm", className = "", onSubmit = null, validate = null, focus = null, closeLabel = "Close" } = {}) {
  return new Promise((resolve) => {
    const parts = shell({ title, size, className, closeLabel, form: true });
    const { dialog, frame } = parts;
    if (body) parts.body.appendChild(body);
    const error = h("div", { class: "uiDialog__error" });
    error.setAttribute("role", "alert");
    error.hidden = true;
    const foot = h("div", { class: "uiDialog__foot" });
    const list = actions || [{ label: "Cancel", value: null }, { label: "OK", value: "submit", kind: "primary", submit: true }];
    const buttons = list.map((action) => {
      const kind = action.kind === "danger" ? " button--danger" : action.kind === "primary" ? " button--primary" : "";
      const button = h("button", { class: `button${kind}${action.submit ? " uiDialog__submit" : ""}` }, action.label);
      button.type = action.submit ? "submit" : "button";
      foot.appendChild(button);
      return { action, button };
    });
    frame.append(error, foot);
    const submit = buttons.find((b) => b.action.submit) || null;
    const reasonNot = () => (validate && submit ? String(validate(frame) || "") : "");
    const refresh = () => {
      if (!validate || !submit) return;
      const why = reasonNot();
      submit.button.disabled = !!why;
      submit.button.title = why;
    };
    if (validate) {
      frame.addEventListener("input", refresh);
      frame.addEventListener("change", refresh);
      refresh();
    }

    let settled = false;
    // True while onSubmit runs. The dialog stays open until the change has an answer.
    // Otherwise, a key made after dismissal exists on the server but not in the list.
    let busy = false;
    const controller = bind(dialog, {
      canClose: () => !busy,
      onClose(value) {
        settled = true;
        dialog.remove();
        resolve(value);
      },
    });
    const showError = (err) => {
      error.textContent = util.errorText(err, "The change failed.");
      error.hidden = false;
      for (const input of $$("[aria-invalid]", frame)) input.removeAttribute("aria-invalid");
      const field = err && err.field ? $(`[data-field="${String(err.field).replace(/["\\]/g, "")}"]`, frame) : null;
      if (field) {
        field.setAttribute("aria-invalid", "true");
        field.focus();
      }
    };
    const run = async (value) => {
      if (busy || settled) return;
      busy = true;
      frame.setAttribute("aria-busy", "true");
      for (const b of buttons) b.button.disabled = true;
      let result;
      try {
        result = onSubmit ? await onSubmit(value, frame) : value;
      } catch (err) {
        showError(err);
        result = false;
      } finally {
        busy = false;
        frame.removeAttribute("aria-busy");
      }
      if (result !== false && !settled) controller.close(result === undefined ? value : result);
      if (!settled) {
        for (const b of buttons) b.button.disabled = false;
        refresh();
      }
    };
    frame.addEventListener("submit", (ev) => {
      ev.preventDefault();
      if (submit && !reasonNot()) run(submit.action.value);
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
        || $("[autofocus]", frame)
        || $(".uiDialog__body input, .uiDialog__body textarea, .uiDialog__body select", frame)
        || submit?.button,
    });
    const first = document.activeElement;
    if (first instanceof HTMLInputElement && dialog.contains(first) && typeof first.select === "function") first.select();
  });
}

// Yes or no. The focus starts on Cancel when the action destroys something.
async function confirm({ title, message, confirmLabel = "OK", cancelLabel = "Cancel", danger = false, className = "" } = {}) {
  const body = h("p", { class: "uiDialog__message" }, message);
  const answer = await open({
    title,
    body,
    className,
    actions: [
      { label: cancelLabel, value: null },
      { label: confirmLabel, value: "confirm", kind: danger ? "danger" : "primary", submit: true },
    ],
    focus: danger ? (frame) => $(".uiDialog__foot .button:not(.uiDialog__submit)", frame) : null,
  });
  return answer !== null;
}

export const dialog = { shell, bind, open, confirm, host };
