// ns.queryUi: the Query page's own controls (app_ui.js held them with the shell's header, now app_header.js): the
// editor with its highlighter, autocomplete, draft and height, the Run and settings menus, the Run options, the run
// stats summary of a phone, and the query library dialog with the page's ?sql= / ?saved= address.
//
//   queryUi.init({ onRun })                 binds the page's controls (after header.init()); Ctrl+Enter calls onRun
//   queryUi.closeRunMenu() / applyRunOptionsUi()   the Run split menu, the checked state of the Run options
//   queryUi.setEditorError(loc) / clearEditorError()   the error mark of the editor
//   queryUi.syncQueryUrl(sql)               the address follows the run (a saved query: ?saved=, else ?sql=)
//   queryUi.openQueryLibrary(tab) / closeQueryLibrary()   the library dialog (its module loads on first use)

import { autocomplete } from "./app_autocomplete.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { header } from "./app_header.js";
import { highlight } from "./app_highlight.js";
import { loader } from "./app_loader.js";
import { meta } from "./app_meta.js";
import { router } from "./app_router.js";
import { state, storage } from "./app_state.js";
import { copy } from "./app_ui_copy.js";
import { dialog } from "./app_ui_dialog.js";
import { icon as iconMod } from "./app_ui_icon.js";
import { layers } from "./app_ui_layers.js";
import { menu } from "./app_ui_menu.js";
import { uiState } from "./app_ui_state.js";
import { tabs } from "./app_ui_tabs.js";
import { util } from "./app_util.js";

const { byId, $, $$ } = dom;

// The Run and settings menus are ns.menu menus (app_ui_menu.js): open /
// close motion, keys, focus return and the one outside-click / Escape
// layer. Bound in init(); these keep the names other modules call.
const menus = { runSettings: null, run: null };

function closeRunSettings({ immediate = false } = {}) { menus.runSettings?.close({ immediate }); }

function closeRunMenu({ immediate = false } = {}) { menus.run?.close({ immediate }); }

function applyRunOptionsUi() {
  if (dom.runOptAutoFormat) {
    dom.runOptAutoFormat.setAttribute("aria-checked", String(!!state.runOptAutoFormat));
  }
  if (dom.runOptMultiQuery) {
    dom.runOptMultiQuery.setAttribute("aria-checked", String(!!state.runOptMultiQuery));
  }
  if (dom.runOptExecutionStats) {
    dom.runOptExecutionStats.setAttribute("aria-checked", String(!!state.runOptExecutionStats));
  }
  if (dom.runOptFlattenTuple) {
    dom.runOptFlattenTuple.setAttribute("aria-checked", String(state.runOptFlattenTuple !== false));
  }
}

function toggleRunOption(key) {
  if (key === "autoFormat") state.runOptAutoFormat = !state.runOptAutoFormat;
  if (key === "multiQuery") state.runOptMultiQuery = !state.runOptMultiQuery;
  if (key === "executionStats") {
    state.runOptExecutionStats = !state.runOptExecutionStats;
    if (!state.runOptExecutionStats && dom.clickhouseElapsedWrap) dom.clickhouseElapsedWrap.hidden = true;
  }
  if (key === "flattenTuple") {
    state.runOptFlattenTuple = !state.runOptFlattenTuple;
    window.dispatchEvent(new CustomEvent("chdash:flatten-tuple-change", { detail: { enabled: state.runOptFlattenTuple } }));
  }
  storage.saveRunOptions({
    autoFormat: state.runOptAutoFormat,
    multiQuery: state.runOptMultiQuery,
    executionStats: state.runOptExecutionStats,
    flattenTuple: state.runOptFlattenTuple,
  });
  applyRunOptionsUi();
}

// --- Query library dialog ----------------------------------------------------
// The toolbar book button opens the library in the shared modal dialog
// (app_ui_dialog.js: the shell, size, backdrop and focus handling of the
// profiling dialog), with two tabs: Saved (folders and saved queries) and
// History. The dialog is built the first time it opens; app_query_library.js
// renders both views and is loaded then (or when Ctrl+S is used): a page
// that never opens it costs no module and no dialog.
const queryLibraryPrefs = () => storage.pref(storage.KEYS.queryLibraryMenu, {});
// modules.json pages.query.lazy.library.
const QUERY_LIBRARY_GROUP = "library";
let queryLibraryPromise = null;
let queryLibraryTab = "saved";
let queryLibraryDialog = null;
let queryLibraryTabs = null;

function readQueryLibraryPrefs() {
  const value = queryLibraryPrefs().get();
  return value && typeof value === "object" ? value : {};
}

function writeQueryLibraryPrefs(patch) {
  queryLibraryPrefs().set({ ...readQueryLibraryPrefs(), ...patch });
}

// The library (app_query_library.js) is a lazy group of the Query page: null until it first opens.
let queryLibrary = null;

function loadQueryLibrary() {
  if (queryLibrary) return Promise.resolve(queryLibrary);
  if (!queryLibraryPromise) {
    queryLibraryPromise = loader.loadGroup(QUERY_LIBRARY_GROUP).then((group) => {
      if (!group.queryLibrary) throw new Error("The query library did not register");
      queryLibrary = group.queryLibrary;
      return queryLibrary;
    });
    queryLibraryPromise.catch(() => { queryLibraryPromise = null; });
  }
  return queryLibraryPromise;
}

function withQueryLibrary(fn) {
  return loadQueryLibrary().then(fn).catch((err) => {
    console.error(err);
    for (const view of [dom.queryLibraryViewSaved, dom.queryLibraryViewHistory]) {
      if (view && !view.dataset.rendered) uiState.error(view, { body: "The query library could not be loaded.", compact: true, retry: () => withQueryLibrary(fn) });
    }
  });
}

function isQueryLibraryOpen() {
  return !!queryLibraryDialog?.isOpen();
}

function setQueryLibraryTab(tab, { focus = false } = {}) {
  const next = tab === "history" ? "history" : "saved";
  queryLibraryTab = next;
  queryLibraryTabs?.select(next);
  if (dom.queryLibraryViewSaved) dom.queryLibraryViewSaved.hidden = next !== "saved";
  if (dom.queryLibraryViewHistory) dom.queryLibraryViewHistory.hidden = next !== "history";
  writeQueryLibraryPrefs({ tab: next });
  if (!isQueryLibraryOpen()) return;
  withQueryLibrary((lib) => {
    lib.show(next);
    if (focus) lib.focus(next);
  });
}

// The dialog (the Saved / History tabs in its head, where a title would be,
// in the profiling tab style, and the two views) is built the first time it
// opens: an idle page carries none of it.
function buildQueryLibraryDialog() {
  if (queryLibraryDialog || !dialog || !dom.queryLibraryButton) return queryLibraryDialog;
  const parts = dialog.shell({
    id: "queryLibraryMenu",
    label: "Query library",
    closeLabel: "Close the query library",
    size: "lg",
    className: "queryLibraryDialog",
    tabs: {
      label: "Saved queries or History",
      inHead: true,
      items: [
        { id: "queryLibraryTabSaved", label: "Saved", controls: "queryLibraryViewSaved", value: "saved" },
        { id: "queryLibraryTabHistory", label: "History", controls: "queryLibraryViewHistory", value: "history" },
      ],
    },
  });
  parts.close.id = "queryLibraryClose";
  // The two views; app_query_library.js adds the preview pane beside them.
  parts.body.classList.add("queryLibraryDialog__body");
  parts.body.innerHTML = `
      <div id="queryLibraryViewSaved" class="queryLibraryDialog__view" role="tabpanel" aria-labelledby="queryLibraryTabSaved">${uiState.loadingHtml({ label: "Loading the library\u2026", compact: true })}</div>
      <div id="queryLibraryViewHistory" class="queryLibraryDialog__view" role="tabpanel" aria-labelledby="queryLibraryTabHistory" hidden>${uiState.loadingHtml({ label: "Loading the history\u2026", compact: true })}</div>`;
  for (const id of ["queryLibraryMenu", "queryLibraryClose", "queryLibraryTabSaved", "queryLibraryTabHistory", "queryLibraryViewSaved", "queryLibraryViewHistory"]) {
    dom[id] = byId(id);
  }
  dom.queryLibraryButton.setAttribute("aria-controls", "queryLibraryMenu");
  queryLibraryDialog = dialog.bind(parts.dialog, {
    closeButton: parts.close,
    fallbackFocus: () => dom.queryLibraryButton,
    onClose() {
      dom.queryLibrary?.classList.remove("is-open");
      dom.queryLibraryButton?.setAttribute("aria-expanded", "false");
      queryLibrary?.hidden?.();
    },
  });
  // Saved | History: the shared tab behaviour (app_ui_tabs.js: click,
  // arrows, Home / End, roving tabindex) in the dialog's tab style.
  queryLibraryTabs = tabs?.bind(parts.tabs, { onSelect: (tab) => setQueryLibraryTab(tab) }) || null;
  return queryLibraryDialog;
}

function openQueryLibrary(tab = queryLibraryTab, { focus = true } = {}) {
  const libraryDialog = buildQueryLibraryDialog();
  if (!libraryDialog) return Promise.resolve(null);
  closeRunMenu({ immediate: true });
  closeRunSettings({ immediate: true });
  // The focus moves into the dialog at once (the views render when the
  // module is in) and comes back to the book button when it closes.
  if (!libraryDialog.isOpen()) libraryDialog.open({ returnFocus: dom.queryLibraryButton });
  dom.queryLibrary?.classList.add("is-open");
  dom.queryLibraryButton.setAttribute("aria-expanded", "true");
  setQueryLibraryTab(tab);
  const panel = dom.queryLibraryMenu;
  return withQueryLibrary(async (lib) => {
    if (!isQueryLibraryOpen()) return lib;
    await lib.show(queryLibraryTab);
    if (focus && isQueryLibraryOpen() && document.activeElement === panel) await lib.focus(queryLibraryTab);
    return lib;
  });
}

// restoreFocus: false when the caller moves the focus (a query opened in
// the editor).
function closeQueryLibrary({ restoreFocus = true } = {}) {
  queryLibraryDialog?.close(null, { restoreFocus });
}

function toggleQueryLibrary() {
  if (isQueryLibraryOpen()) closeQueryLibrary();
  else openQueryLibrary();
}

function saveCurrentQuery() {
  withQueryLibrary((lib) => lib.saveCurrent());
}

// URL state of the Query page: ?saved=<id> while the editor holds a library
// query as saved, else ?sql=<text> of the last run (up to 4,000 characters),
// so the address bar is a link to the query. Read once at startup.
const QUERY_URL_MAX_SQL = 4000;

// The Query page's owner of the address (ns.router): it only writes these
// two parameters, and always replaces.
function syncQueryUrl(sqlText) {
  if (document.body?.dataset.page !== "query") return;
  const text = String(sqlText ?? dom.queryTextArea?.value ?? "").trim();
  const savedId = queryLibrary?.openedId?.(text) || "";
  const sql = !savedId && text.length <= QUERY_URL_MAX_SQL ? text : "";
  router.owner("query", { view: null }).replace({ saved: savedId, sql });
}

// A link fills an empty editor; a reload keeps the tab's own draft.
function applyQueryUrl() {
  if (document.body?.dataset.page !== "query" || !dom.queryTextArea) return;
  if (String(dom.queryTextArea.value || "").trim()) return;
  const params = new URLSearchParams(window.location.search || "");
  const sqlText = params.get("sql");
  const savedId = params.get("saved");
  if (savedId) {
    withQueryLibrary((lib) => lib.openSaved(savedId));
  } else if (sqlText && sqlText.trim()) {
    util.replaceTextAreaValue(dom.queryTextArea, sqlText);
  }
}

function initQueryLibrary() {
  const mod = util.modifierKeyLabel();
  if (mod !== "Ctrl") {
    for (const kbd of $$(".queryKbd--mod")) kbd.textContent = mod;
  }
  // The shortcut is told by the Run button's tooltip (no hint beside it).
  if (dom.runButton) dom.runButton.title = `Run (${mod}+Enter)`;
  if (!dom.queryLibraryButton) return;
  queryLibraryTab = readQueryLibraryPrefs().tab === "history" ? "history" : "saved";

  dom.queryLibraryButton.addEventListener("click", toggleQueryLibrary);

  // Escape and a click on the backdrop close the dialog (app_ui_dialog.js).
  document.addEventListener("keydown", (ev) => {
    if (ev.defaultPrevented || ev.isComposing) return;
    const key = String(ev.key || "").toLowerCase();
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && !ev.shiftKey && key === "s") {
      // Never the browser's "Save page". The library opens (or stays) on Saved
      // with the save form in its pane; over another dialog (a prompt,
      // profiling) it waits.
      ev.preventDefault();
      const top = layers.host();
      if (top && top !== document.body && top !== dom.queryLibraryMenu) return;
      saveCurrentQuery();
    }
  });
  // A finished run is a new History entry.
  window.addEventListener("chdash:query-history", () => {
    if (queryLibrary) queryLibrary.historyChanged();
  });
}

// The editor's copy button: the shared copy.button (icon, tooltip and
// the one "Copied" feedback).
function initEditorCopyButton() {
  if (!dom.editorCopyButton || !dom.queryTextArea) return;

  const sync = () => {
    dom.editorCopyButton.disabled = !String(dom.queryTextArea.value || "").trim();
  };

  copy.button(dom.editorCopyButton, () => {
    const text = String(dom.queryTextArea.value || "");
    return text.trim() ? text : "";
  }, { label: "Copy query" });

  sync();
  dom.queryTextArea.addEventListener("input", sync);
}

// Ctrl+Enter runs the query: the page's controller says what runs it (init({ onRun })).
let runHandler = null;

function initEditor() {
  if (!dom.queryTextArea) return;

  // The session draft, also written by the Explorer's "Open in Query".
  const draftPref = storage.pref(storage.KEYS.editorDraft, null, { session: true });
  const loadEditorDraft = () => draftPref.get();
  const saveEditorDraft = (text) => draftPref.set(String(text || ""));

  const dispatchInputEvent = (el) => {
    if (!el || typeof el.dispatchEvent !== "function") return;
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch {
      try {
        el.dispatchEvent(new Event("input"));
      } catch {
        null;
      }
    }
  };

  const current = String(dom.queryTextArea.value || "");
  if (!current.trim()) {
    const saved = String(loadEditorDraft() || "");
    if (saved.trim()) {
      if (util && typeof util.replaceTextAreaValue === "function") {
        util.replaceTextAreaValue(dom.queryTextArea, saved);
      } else {
        dom.queryTextArea.value = saved;
      }
      requestAnimationFrame(() => {
        const ctrl = state && state.highlightCtrl;
        if (ctrl && typeof ctrl.refresh === "function") ctrl.refresh();
      });
    }
  }

  const saveDraftSoon = util.debounce(() => saveEditorDraft(dom.queryTextArea.value), 200);
  dom.queryTextArea.addEventListener("input", () => saveDraftSoon());

  const replaceSelectionText = (ta, nextText) => {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    try {
      const before = String(ta.value || "");
      ta.focus();
      ta.setSelectionRange(start, end);
      const ok = document.execCommand && document.execCommand("insertText", false, nextText);
      if (ok || String(ta.value || "") !== before) return { start, end };
    } catch {
      null;
    }
    try {
      ta.setRangeText(nextText, start, end, "end");
      dispatchInputEvent(ta);
      return { start, end };
    } catch {
      null;
    }
    const value = String(ta.value || "");
    ta.value = value.slice(0, start) + nextText + value.slice(end);
    const pos = start + nextText.length;
    ta.selectionStart = pos;
    ta.selectionEnd = pos;
    dispatchInputEvent(ta);
    return { start, end };
  };

  // Tab indents inside the editor; Escape then Tab leaves it (keyboard users
  // are never trapped). Escape that closed the autocomplete does not count.
  let tabReleased = false;
  dom.queryTextArea.addEventListener("keydown", (e) => {
    const key = e.key;
    if (e.isComposing) return;
    if (key === "Escape") {
      tabReleased = !e.defaultPrevented;
      return;
    }
    if (key === "Tab" && tabReleased && !e.defaultPrevented) {
      tabReleased = false;
      return;
    }
    if (key !== "Shift") tabReleased = false;
    if ((e.ctrlKey || e.metaKey) && key === "Enter") {
      e.preventDefault();
      if (runHandler) runHandler();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (key === "`" || key === "\"" || key === "'") {
      const ta = dom.queryTextArea;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      if (start == null || end == null || start === end) return;
      e.preventDefault();
      const value = String(ta.value || "");
      const selected = value.slice(start, end);
      replaceSelectionText(ta, key + selected + key);
      ta.selectionStart = start + 1;
      ta.selectionEnd = end + 1;
      return;
    }

    if (key === "Enter") {
      const ta = dom.queryTextArea;
      const start = ta.selectionStart;
      if (start == null) return;
      const value = String(ta.value || "");
      const lineStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
      let i = lineStart;
      while (i < value.length) {
        const c = value[i];
        if (c !== " " && c !== "\t") break;
        i++;
      }
      const indent = value.slice(lineStart, i);
      e.preventDefault();
      const inserted = "\n" + indent;
      const prev = replaceSelectionText(ta, inserted);
      const pos = prev.start + inserted.length;
      ta.selectionStart = pos;
      ta.selectionEnd = pos;
      return;
    }

    if (key !== "Tab") return;

    const ta = dom.queryTextArea;
    const value = String(ta.value || "");
    const start = ta.selectionStart;
    const end = ta.selectionEnd;

    e.preventDefault();

    const lineStartIndex = (text, idx) => {
      const i = text.lastIndexOf("\n", idx - 1);
      return i === -1 ? 0 : i + 1;
    };

    const lineEndIndex = (text, idx) => {
      const i = text.indexOf("\n", idx);
      return i === -1 ? text.length : i;
    };

    const outdentLine = (line) => {
      if (line.startsWith("\t")) return { line: line.slice(1), removed: 1 };
      if (line.startsWith("    ")) return { line: line.slice(4), removed: 4 };
      if (line.startsWith("  ")) return { line: line.slice(2), removed: 2 };
      if (line.startsWith(" ")) return { line: line.slice(1), removed: 1 };
      return { line, removed: 0 };
    };

    if (start === end) {
      if (!e.shiftKey) {
        replaceSelectionText(ta, "\t");
        return;
      }

      const ls = lineStartIndex(value, start);
      const le = lineEndIndex(value, start);
      const line = value.slice(ls, le);
      const rel = start - ls;
      const prefix = line.slice(0, rel);
      if (!/^[\t ]*$/.test(prefix)) return;

      const od = outdentLine(line);
      if (od.removed === 0) return;
      ta.selectionStart = ls;
      ta.selectionEnd = le;
      replaceSelectionText(ta, od.line);
      const nextPos = Math.max(ls, start - od.removed);
      ta.selectionStart = nextPos;
      ta.selectionEnd = nextPos;
      return;
    }

    let endAdj = end;
    if (endAdj > start && value[endAdj - 1] === "\n") endAdj -= 1;

    const blockStart = lineStartIndex(value, start);
    const blockEnd = lineEndIndex(value, endAdj);
    const block = value.slice(blockStart, blockEnd);
    const oldLines = block.split("\n");

    const deltas = [];
    const newLines = [];

    for (const ln of oldLines) {
      if (e.shiftKey) {
        const od = outdentLine(ln);
        newLines.push(od.line);
        deltas.push(-od.removed);
      } else {
        newLines.push("\t" + ln);
        deltas.push(1);
      }
    }

    const newBlock = newLines.join("\n");

    const lineStarts = [];
    let acc = 0;
    for (let i = 0; i < oldLines.length; i++) {
      lineStarts.push(acc);
      acc += oldLines[i].length + 1;
    }

    const shiftFor = (posRel, includeEquals) => {
      let shift = 0;
      for (let i = 0; i < lineStarts.length; i++) {
        const ls = lineStarts[i];
        if (includeEquals ? posRel >= ls : posRel > ls) shift += deltas[i];
      }
      return shift;
    };

    const startRel = start - blockStart;
    const endRel = end - blockStart;
    const includeEquals = !e.shiftKey;
    const newStart = start + shiftFor(startRel, includeEquals);
    const newEnd = end + shiftFor(endRel, includeEquals);

    ta.selectionStart = blockStart;
    ta.selectionEnd = blockEnd;
    replaceSelectionText(ta, newBlock);
    ta.selectionStart = Math.max(blockStart, newStart);
    ta.selectionEnd = Math.max(blockStart, newEnd);
  });

  // Convert 4 leading spaces into a tab while typing (indentation only).
  dom.queryTextArea.addEventListener("beforeinput", (e) => {
    if (e.inputType !== "insertText" || e.data !== " ") return;

    const ta = dom.queryTextArea;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start == null || end == null || start !== end) return;

    const value = String(ta.value || "");
    const lineStart = value.lastIndexOf("\n", start - 1) + 1; // 0 if not found
    const prefix = value.slice(lineStart, start);

    // Only within indentation region (tabs/spaces only before cursor)
    if (!/^[\t ]*$/.test(prefix)) return;

    // Count consecutive spaces immediately before cursor in indentation prefix
    let run = 0;
    for (let i = prefix.length - 1; i >= 0; i--) {
      if (prefix[i] === " ") run++;
      else break;
      if (run >= 4) break;
    }

    // If this keystroke would complete 4 spaces, replace them with a tab
    if (run === 3) {
      e.preventDefault();
      const deleteFrom = start - 3;
      try {
        ta.focus();
        ta.setSelectionRange(deleteFrom, start);
        const ok = document.execCommand && document.execCommand("insertText", false, "\t");
        if (ok) return;
      } catch {
        null;
      }
      // Fallback if execCommand isn't available
      ta.setRangeText("\t", deleteFrom, start, "end");
      dispatchInputEvent(ta);
    }
  });

  // Copy: convert tabs to 4 spaces in clipboard to keep alignment when pasting elsewhere.
  dom.queryTextArea.addEventListener("copy", (e) => {
    const ta = dom.queryTextArea;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start == null || end == null || start === end) return;
    const selected = String(ta.value || "").slice(start, end);
    if (!selected.includes("\t")) return;

    const text = selected.replace(/\t/g, "    ");
    if (e.clipboardData) {
      e.preventDefault();
      e.clipboardData.setData("text/plain", text);
    }
  });

  if (highlight && typeof highlight.attach === "function") {
    const ctrl = highlight.attach(dom.queryTextArea);
    if (state) state.highlightCtrl = ctrl || null;
  }

  if (autocomplete && typeof autocomplete.attach === "function") {
    const ctrl = autocomplete.attach(dom.queryTextArea);
    if (state) state.autocompleteCtrl = ctrl || null;
  }

  if (storage && typeof storage.loadEditorHeight === "function" && typeof storage.saveEditorHeight === "function") {
    const getTarget = () => {
      const ta = dom.queryTextArea;
      if (!ta) return null;
      if (ta.closest) return ta.closest(".editorWrap") || ta;
      const p = ta.parentNode;
      if (p && p.classList && p.classList.contains("editorWrap")) return p;
      return ta;
    };

    let lastSaved = null;
    let scheduled = 0;

    const releasePrepaintHeight = () => {
      const root = document.documentElement;
      if (!root) return;
      root.classList.remove("chdash-has-initial-editor-height");
      root.style.removeProperty("--initialEditorHeight");
    };

    const apply = () => {
      const target = getTarget();
      if (!target) return;
      const h = storage.loadEditorHeight();
      if (h && Number.isFinite(h)) {
        const v = Math.round(h);
        target.style.height = `${v}px`;
        lastSaved = v;
      }
      // The page head script uses an !important pre-paint rule to avoid a startup jump.
      // Once the persisted height has been copied to the real element, release
      // that rule so the centered drag handle can change the used height.
      releasePrepaintHeight();
    };

    const save = () => {
      scheduled = 0;
      const target = getTarget();
      if (!target || !target.style || !target.style.height) return;
      const v = Math.round(target.getBoundingClientRect().height);
      if (!Number.isFinite(v) || v <= 0) return;
      if (lastSaved === v) return;
      lastSaved = v;
      storage.saveEditorHeight(v);
    };

    apply();

    if (typeof ResizeObserver === "function") {
      try {
        const ro = new ResizeObserver(() => {
          if (scheduled) return;
          scheduled = requestAnimationFrame(save);
        });
        const t = getTarget();
        if (t) ro.observe(t);
      } catch {
        null;
      }
    }

    const handle = $(".editorResizeHandle");
    const target = getTarget();
    if (handle && target) {
      let drag = null;
      const finishDrag = (event) => {
        if (!drag) return;
        try { handle.releasePointerCapture(event.pointerId); } catch (_) {}
        drag = null;
        handle.classList.remove("is-dragging");
        save();
      };
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        drag = { y: event.clientY, height: target.getBoundingClientRect().height };
        try { handle.setPointerCapture(event.pointerId); } catch (_) {}
        handle.classList.add("is-dragging");
        event.preventDefault();
      });
      handle.addEventListener("pointermove", (event) => {
        if (!drag) return;
        // Match the production resize semantics: only enforce the editor's
        // minimum usable height. The containing query panel grows/shrinks
        // naturally instead of forcing the whole workspace to viewport height.
        const next = Math.round(Math.max(180, drag.height + event.clientY - drag.y));
        target.style.height = `${next}px`;
        event.preventDefault();
      });
      handle.addEventListener("pointerup", finishDrag);
      handle.addEventListener("pointercancel", finishDrag);
    }

    state.editorSizeCtrl = { apply };
  }

  dom.queryTextArea.addEventListener("focus", () => {
    if (meta && typeof meta.maybeRefreshOnUserAction === "function") {
      meta.maybeRefreshOnUserAction();
    }
  });
}

// 1100 px and below (query.css), where the rail is no longer beside the editor: the run stats tiles fold into one
// summary line ("7 ms \u00b7 120,064 rows \u00b7 1.9 MB read \u00b7 CPU 87.7%
// \u00b7 1.8 MB memory"), a .foldSummary that unfolds them, so the results
// start above the fold. The fold only bites at that width.
function initRunStatsSummary() {
  const tiles = byId("runStatsTiles");
  const panel = tiles?.closest(".panel--metrics");
  if (!tiles || !panel) return;
  const text = h("span", { class: "foldSummary__text" });
  const icon = iconMod.el("chevron-down", { className: "foldSummary__chevron" });
  const summary = h("button", { type: "button", id: "runStatsSummary", class: "foldSummary runStatsSummary", "aria-controls": tiles.id }, text, icon);
  panel.prepend(summary);
  const value = (el) => {
    const v = String(el?.textContent || "").replace(/\s+/g, " ").trim();
    return v && v !== format.EMPTY ? v : "";
  };
  const shown = (el) => !!el && !el.closest(".metricCompact.is-hidden");
  const refresh = () => {
    // Before the first run the rail is one line that says where the stats will be: the summary says what it is.
    if (dom.runStatsTiles?.classList.contains("is-idle")) {
      util.setMetaLine(text, "Run stats");
      return;
    }
    const parts = [];
    const add = (el, label) => {
      const v = shown(el) ? value(el) : "";
      if (v) parts.push(label.replace("#", v));
    };
    add(dom.elapsedSecondsText, "#");
    add(dom.readRowsTotalText, "# rows");
    add(dom.readBytesTotalText, "# read");
    add(dom.writtenRowsTotalText, "# rows written");
    add(dom.writtenBytesTotalText, "# written");
    add(dom.cpuMaxText, "CPU #");
    add(dom.memoryMaxText, "# memory");
    util.setMetaLine(text, parts.length ? parts.join(" \u00b7 ") : "Run stats");
  };
  const fold = (folded) => {
    panel.classList.toggle("is-folded", folded);
    summary.setAttribute("aria-expanded", folded ? "false" : "true");
    summary.title = folded ? "Show the run stats" : "Hide the run stats";
  };
  summary.addEventListener("click", () => fold(!panel.classList.contains("is-folded")));
  new MutationObserver(util.rafOnce(refresh)).observe(tiles, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class"] });
  fold(true);
  refresh();
}

function init({ onRun } = {}) {
  runHandler = typeof onRun === "function" ? onRun : null;
  applyRunOptionsUi();
  initRunStatsSummary();
  initEditor();
  initEditorCopyButton();

  menus.run = menu?.split(dom.runButton, dom.runMenuButton, dom.runMenu) || null;

  if (dom.runOptAutoFormat) dom.runOptAutoFormat.addEventListener("click", () => toggleRunOption("autoFormat"));
  if (dom.runOptMultiQuery) dom.runOptMultiQuery.addEventListener("click", () => toggleRunOption("multiQuery"));
  if (dom.runOptExecutionStats) dom.runOptExecutionStats.addEventListener("click", () => toggleRunOption("executionStats"));
  if (dom.runOptFlattenTuple) dom.runOptFlattenTuple.addEventListener("click", () => toggleRunOption("flattenTuple"));

  initQueryLibrary();
  applyQueryUrl();

  menus.runSettings = menu?.bind(dom.runSettingsButton, dom.runSettingsMenu) || null;

  // The root address is the Query page: it takes the page's own address, so a reload and Back agree with it.
  if (window.location.pathname === router.url("/")) router.replace(null, { path: "/query", view: "query" });

  // The editor's marks and the completion list repaint when the host's keywords, functions or tables arrive.
  window.addEventListener("chdash:meta-changed", () => {
    if (state.highlightCtrl && typeof state.highlightCtrl.refresh === "function") state.highlightCtrl.refresh();
    if (autocomplete && typeof autocomplete.refresh === "function") autocomplete.refresh();
  });
  // The editor follows the host selection: its marks (the host's keywords and functions) and its remembered height.
  header.onHostSelected(() => {
    if (state.highlightCtrl && typeof state.highlightCtrl.refresh === "function") state.highlightCtrl.refresh();
    if (state.editorSizeCtrl && typeof state.editorSizeCtrl.apply === "function") state.editorSizeCtrl.apply();
  });
}

function setEditorError(loc) {
  const ctrl = state && state.highlightCtrl;
  if (!ctrl || typeof ctrl.setError !== "function") return;
  ctrl.setError(loc);
}

function clearEditorError() {
  const ctrl = state && state.highlightCtrl;
  if (!ctrl || typeof ctrl.clearError !== "function") return;
  ctrl.clearError();
}

export const queryUi = Object.freeze({ init, closeRunMenu, applyRunOptionsUi, setEditorError, clearEditorError, syncQueryUrl, openQueryLibrary, closeQueryLibrary });
