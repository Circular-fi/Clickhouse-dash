(() => {
  "use strict";
  // Key / value lists, one component for every page (style.css "Components:
  // key/value" block): span and resource attributes, log record fields, the
  // Query row Details, the Explorer graph panel's columns.
  //
  //   ui.kvListHtml(rows, { actions, className, empty, label }) -> HTML
  //   ui.kvBind(root, { onAction })   delegated action clicks under root
  //   ui.kvList(rows, options)        -> element (kvListHtml + kvBind)
  //
  // rows: [{ key, value, label, keyTitle, mono, muted, actions, attrs }]
  //   value   a scalar or an object / array (a JSON tree); a string holding a
  //           JSON object or array is shown as a tree too (json: false keeps it
  //           text). One set of value colours: --json-string / -number /
  //           -bool / -null, a ClickHouse Map(String, String) value that reads
  //           as a number or a boolean coloured as one.
  //   actions per row (else options.actions): any of
  //           "include"  filter for this value      (onAction)
  //           "exclude"  filter this value out      (onAction)
  //           "only"     search only this value     (onAction)
  //           "copy"     copy the value             (built in)
  //           "json"     copy the value as JSON     (built in)
  //   attrs   extra data-* attributes of the row (handed back to onAction).
  // onAction(action, { key, value, text, row, button, event }): return true
  // to take over a copy action.
  const ns = window.ChDash;
  if (!ns) return;
  const ui = (ns.ui = ns.ui || {});

  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const nullToken = () => (ns.format?.nullToken ? ns.format.nullToken() : '<span class="nullToken">NULL</span>');

  const JSON_LOOKING = /^\s*[[{]/;
  const NUMBER_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

  const ACTIONS = {
    include: { label: "Filter for this value", icon: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5.5v5M5.5 8h5"/></svg>' },
    exclude: { label: "Exclude this value", icon: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M5.5 8h5"/></svg>' },
    only: { label: "Search only this value", icon: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="M10.2 10.2 13.5 13.5"/></svg>' },
    copy: { label: "Copy value", icon: '<span class="uiCopy__icon" aria-hidden="true"></span>' },
    json: { label: "Copy as JSON", icon: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5c-1.5 0-2 .6-2 1.8v1.4c0 .8-.4 1.3-1.3 1.3.9 0 1.3.5 1.3 1.3v1.4c0 1.2.5 1.8 2 1.8M10 3.5c1.5 0 2 .6 2 1.8v1.4c0 .8.4 1.3 1.3 1.3-.9 0-1.3.5-1.3 1.3v1.4c0 1.2-.5 1.8-2 1.8"/></svg>' },
  };

  // A string that holds a JSON object or array, parsed; null otherwise.
  function jsonValue(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string" || !JSON_LOOKING.test(value)) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function scalarKind(value) {
    if (value == null) return "null";
    if (typeof value === "number" || typeof value === "bigint") return "number";
    if (typeof value === "boolean") return "bool";
    const text = String(value);
    if (NUMBER_LITERAL.test(text)) return "number";
    if (text === "true" || text === "false") return "bool";
    return "string";
  }

  function scalarHtml(value) {
    if (value == null) return nullToken();
    return `<span class="kv__v kv__v--${scalarKind(value)}">${esc(String(value))}</span>`;
  }

  // Collapsible tree: the top level open, nested levels too when the value
  // has at most 10 keys.
  function treeHtml(value, expandNested, depth = 0) {
    if (!value || typeof value !== "object") {
      if (typeof value === "string") return `<span class="kv__v kv__v--string">"${esc(value)}"</span>`;
      if (value == null) return '<span class="kv__v kv__v--null">null</span>';
      return `<span class="kv__v kv__v--${scalarKind(value)}">${esc(String(value))}</span>`;
    }
    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((item, index) => [index, item]) : Object.entries(value);
    const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
    if (!entries.length) return `<span class="kvTree__brace">${open}${close}</span>`;
    const noun = isArray ? "item" : "key";
    const count = `${entries.length} ${noun}${entries.length === 1 ? "" : "s"}`;
    const body = entries.map(([key, item]) => `<div class="kvTree__entry">${isArray ? "" : `<span class="kvTree__key">${esc(key)}</span><span class="kvTree__colon">:</span>`}${treeHtml(item, expandNested, depth + 1)}</div>`).join("");
    const isOpen = depth === 0 || expandNested;
    return `<details class="kvTree"${isOpen ? " open" : ""}><summary><span class="kvTree__brace">${open}</span><span class="kvTree__fold">\u2026${close}</span><span class="kvTree__count">${count}</span></summary><div class="kvTree__body">${body}</div><span class="kvTree__brace">${close}</span></details>`;
  }

  function valueText(value) {
    if (value == null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }

  function valueJson(value) {
    try { return JSON.stringify(value === undefined ? null : value); } catch (_) { return JSON.stringify(String(value)); }
  }

  function actionsHtml(list, key) {
    if (!list || !list.length) return "";
    return `<span class="kvList__actions">${list.filter((id) => ACTIONS[id]).map((id) => {
      const { label, icon } = ACTIONS[id];
      const cls = id === "copy" || id === "json" ? "kvList__action uiCopy" : "kvList__action";
      return `<button type="button" class="${cls}" data-kv-action="${id}" title="${esc(label)}" aria-label="${esc(`${label}: ${key}`)}">${icon}</button>`;
    }).join("")}</span>`;
  }

  function rowHtml(row, options) {
    const key = String(row.key ?? "");
    const label = row.label != null ? String(row.label) : key;
    const value = row.value;
    const tree = row.json === false ? null : jsonValue(value);
    const list = row.actions !== undefined ? row.actions : options.actions;
    const attrs = Object.entries(row.attrs || {}).map(([name, v]) => ` ${name}="${esc(v)}"`).join("");
    const text = valueText(value);
    const data = ` data-kv-key="${esc(key)}" data-kv-text="${esc(text)}" data-kv-json="${esc(valueJson(value))}"${attrs}`;
    const keyTitle = row.keyTitle != null ? row.keyTitle : (label !== key ? key : "");
    const keyHtml = `<dt class="kvList__key${row.keyClass ? ` ${esc(row.keyClass)}` : ""}"${keyTitle ? ` title="${esc(keyTitle)}"` : ""}>${esc(label)}</dt>`;
    let body;
    if (row.html != null) body = row.html;
    else if (tree && !row.list) {
      const size = Array.isArray(tree) ? tree.length : Object.keys(tree).length;
      body = `<div class="kvList__tree">${treeHtml(tree, size <= 10)}</div>`;
    } else if (row.list && Array.isArray(tree)) {
      body = tree.map((item) => scalarHtml(item)).join('<span class="kvList__sep">, </span>');
    } else if (row.text) {
      body = `<span class="kv__v">${esc(text)}</span>`;
    } else body = scalarHtml(value);
    const cls = ["kvList__row", tree && !row.list && row.html == null ? "kvList__row--tree" : "", row.mono ? "is-mono" : "", row.muted ? "is-muted" : "", row.className || ""].filter(Boolean).join(" ");
    return `<div class="${esc(cls)}"${data}>${keyHtml}<dd class="kvList__value">${actionsHtml(list, key)}${body}</dd></div>`;
  }

  function kvListHtml(rows, options = {}) {
    const { className = "", empty = "", label = "" } = options;
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return empty ? `<p class="kvList__empty">${esc(empty)}</p>` : "";
    return `<dl class="kvList${className ? ` ${esc(className)}` : ""}"${label ? ` aria-label="${esc(label)}"` : ""}>${list.map((row) => rowHtml(row, options)).join("")}</dl>`;
  }

  // Delegated action clicks; bound once per root.
  const bound = new WeakMap();
  function kvBind(root, { onAction = null } = {}) {
    if (!root) return;
    if (bound.has(root)) {
      bound.get(root).onAction = onAction;
      return;
    }
    const state = { onAction };
    bound.set(root, state);
    root.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("[data-kv-action]") : null;
      const row = button?.closest(".kvList__row");
      if (!button || !row || !root.contains(row)) return;
      event.preventDefault();
      event.stopPropagation();
      const action = button.getAttribute("data-kv-action");
      const key = row.getAttribute("data-kv-key") || "";
      const text = row.getAttribute("data-kv-text") || "";
      const json = row.getAttribute("data-kv-json") || "null";
      let value;
      try { value = JSON.parse(json); } catch (_) { value = text; }
      const handled = state.onAction?.(action, { key, value, text, json, row, button, event }) === true;
      if (handled) return;
      if (action === "copy") void ui.copyText?.(text, button);
      else if (action === "json") void ui.copyText?.(json, button);
    });
  }

  function kvList(rows, options = {}) {
    const holder = document.createElement("div");
    holder.innerHTML = kvListHtml(rows, options);
    const el = holder.firstElementChild || document.createElement("dl");
    if (!holder.firstElementChild) el.className = "kvList";
    kvBind(el, options);
    return el;
  }

  Object.assign(ui, { kvList, kvListHtml, kvBind });
  ns.kv = Object.freeze({ list: kvList, html: kvListHtml, bind: kvBind, treeHtml, scalarHtml, scalarKind, jsonValue, valueText, ACTIONS: Object.keys(ACTIONS) });
})();
