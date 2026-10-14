// Read-only SQL, one component for every page (css/10-components/sql.css),
// highlighted by the editor's highlighter (ns.highlight,
// ns.highlight.toHtml). A page that has not loaded it (Observability) gets
// the plain text at once and the colours when the highlighter has loaded.
//
//   sqlBlock({ sql, gutter, copy, maxLines, expand, inline, label })
//     gutter    line numbers
//     copy      a copy button (copy.button) at the top right
//     maxLines  the lines shown before "Show all N lines" (expand: true,
//               the default when maxLines is set) or a scroll
//     inline    one line cut with an ellipsis inside a table cell: a click
//               (Enter / Space) shows it all, wrapped, and back
//     wrap      long lines wrap instead of scrolling
//   Returns the element (.sqlBlock).
//   sqlBlock.html({ sql, inline, label }) is the same block as an HTML
//   string, for modules that render strings; sqlBlock.bind(root) once on their
//   container gives its inline blocks the toggle.

import { dom } from "./app_dom.js";
import { loader } from "./app_loader.js";
import { copy as copyMod } from "./app_ui_copy.js";
import { util } from "./app_util.js";

const { $$ } = dom;

// The highlighter (app_highlight.js) gives itself to the block when its module loads: with the modules of the Query and
// Explorer pages, as the lazy group "highlight" (src/static/modules.json, loader.loadGroup) on the others. A page
// without either (MCP) shows the plain text.
const HIGHLIGHT_GROUP = "highlight";
let highlight = null;
function useHighlighter(engine) {
  highlight = engine;
}

let loading = null;
const pending = new Set();

function loadHighlighter() {
  if (highlight?.toHtml) return Promise.resolve();
  if (!loading) {
    loading = (loader ? loader.loadGroup(HIGHLIGHT_GROUP) : Promise.reject(new Error("no loader"))).then(() => {
      if (!highlight?.toHtml) throw new Error("no highlighter on this page");
      for (const paint of pending) paint();
      pending.clear();
      // Blocks written as HTML strings before the highlighter loaded.
      for (const code of $$(".sqlBlock__code[data-sql-plain]")) {
        code.removeAttribute("data-sql-plain");
        code.innerHTML = highlight.toHtml(code.textContent || "");
      }
    }).catch(() => { pending.clear(); });
  }
  return loading;
}

const esc = (value) => util.escapeHtml(value ?? "");

function paintInto(code, sql) {
  const paint = () => {
    if (highlight?.toHtml) code.innerHTML = highlight.toHtml(sql);
    else code.innerHTML = esc(sql);
  };
  paint();
  if (!highlight?.toHtml) {
    pending.add(paint);
    void loadHighlighter();
  }
}

// Inline (table cell) block: one line, a click shows the statement whole.
// A DOM block listens itself; string-built ones need sqlBind(root) once on
// their container (one delegated listener).
function toggleInline(block) {
  const open = block.getAttribute("aria-expanded") !== "true";
  block.setAttribute("aria-expanded", open ? "true" : "false");
  block.classList.toggle("is-expanded", open);
}

function inlineBlock(sql, label) {
  const holder = document.createElement("div");
  holder.innerHTML = sqlBlockHtml({ sql, inline: true, label });
  const block = holder.firstElementChild;
  block.addEventListener("click", (event) => { event.stopPropagation(); toggleInline(block); });
  return block;
}

const boundRoots = new WeakSet();
function sqlBind(root) {
  if (!(root instanceof Element) || boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener("click", (event) => {
    const block = event.target instanceof Element ? event.target.closest(".sqlBlock--inline") : null;
    if (!block || !root.contains(block)) return;
    event.stopPropagation();
    toggleInline(block);
  }, true);
}

function sqlBlockHtml({ sql = "", inline = true, label = "SQL" } = {}) {
  const text = String(sql ?? "").replace(/\s+$/, "");
  const ready = !!highlight?.toHtml;
  if (!ready) void loadHighlighter();
  const code = ready ? highlight.toHtml(text) : esc(text);
  const attrs = ready ? "" : " data-sql-plain";
  if (inline) {
    const title = `${label}: click to show it all`;
    return `<button type="button" class="sqlBlock sqlBlock--inline" aria-expanded="false" title="${esc(title)}"><code class="sqlBlock__code"${attrs}>${code}</code></button>`;
  }
  return `<div class="sqlBlock"><div class="sqlBlock__body"><pre class="sqlBlock__pre" aria-label="${esc(label)}"><code class="sqlBlock__code"${attrs}>${code}</code></pre></div></div>`;
}

function sqlBlock({ sql = "", gutter = false, copy = false, maxLines = 0, expand = null, inline = false, wrap = false, label = "SQL", className = "" } = {}) {
  const text = String(sql ?? "").replace(/\s+$/, "");
  if (inline) {
    const block = inlineBlock(text, label);
    if (className) block.classList.add(...className.split(/\s+/).filter(Boolean));
    return block;
  }
  const lines = text ? text.split("\n").length : 1;
  const block = document.createElement("div");
  block.className = `sqlBlock${gutter ? " sqlBlock--gutter" : ""}${copy ? " sqlBlock--copy" : ""}${wrap ? " sqlBlock--wrap" : ""}${className ? ` ${className}` : ""}`;
  block.style.setProperty("--sql-gutter", `${String(lines).length + 1}ch`);
  const body = document.createElement("div");
  body.className = "sqlBlock__body";
  if (gutter) {
    const numbers = document.createElement("pre");
    numbers.className = "sqlBlock__gutter";
    numbers.setAttribute("aria-hidden", "true");
    numbers.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join("\n");
    body.appendChild(numbers);
  }
  const pre = document.createElement("pre");
  pre.className = "sqlBlock__pre";
  pre.setAttribute("aria-label", label);
  const code = document.createElement("code");
  code.className = "sqlBlock__code";
  pre.appendChild(code);
  body.appendChild(pre);
  block.appendChild(body);
  util.scrollFocus(body, { label });
  paintInto(code, text);

  if (copy && copyMod?.button) {
    const button = copyMod.button(null, () => block._sqlText ?? text, { label: `Copy ${label}`, className: "sqlBlock__copy" });
    block.appendChild(button);
  }

  const clamp = Number(maxLines) > 0 && lines > Number(maxLines);
  if (clamp) {
    block.style.setProperty("--sql-lines", String(Number(maxLines)));
    block.classList.add("is-clamped");
    if (expand !== false) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "sqlBlock__expand";
      more.setAttribute("aria-expanded", "false");
      const showAll = `Show all ${lines} lines`;
      more.textContent = showAll;
      more.addEventListener("click", () => {
        const open = block.classList.toggle("is-expanded");
        more.setAttribute("aria-expanded", open ? "true" : "false");
        more.textContent = open ? "Show less" : showAll;
      });
      block.appendChild(more);
    } else {
      block.classList.add("is-scroll");
    }
  }
  return block;
}

// The block shows another text (a formatted statement, then the one as returned): repainted and, from then on, what its copy button copies.
sqlBlock.setText = (block, sql) => {
  const code = block?.querySelector?.(".sqlBlock__code");
  if (!code) return;
  const text = String(sql ?? "").replace(/\s+$/, "");
  block._sqlText = text;
  paintInto(code, text);
};
// The Formatted switch, one for every place that offers a statement formatted or as it was: a pressed button reading "Formatted".
// Pressed, the statement is shown (and saved) as the formatter lays it out; released, as it was (`rawName`: "as typed", "as
// ClickHouse returned it"). onChange(pressed) runs after a click.
sqlBlock.formatSwitch = ({ pressed = true, rawName = "as typed", disabled = false, onChange = null } = {}) => {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sqlMode";
  button.textContent = "Formatted";
  const paint = (on) => {
    button.setAttribute("aria-pressed", String(on));
    button.title = on ? `Formatted by the formatter: press for the text ${rawName}` : `The text ${rawName}: press to format it`;
  };
  paint(pressed);
  button.disabled = disabled;
  button.addEventListener("click", () => {
    const next = button.getAttribute("aria-pressed") !== "true";
    paint(next);
    if (typeof onChange === "function") onChange(next);
  });
  return button;
};
sqlBlock.html = sqlBlockHtml;
sqlBlock.bind = sqlBind;
sqlBlock.useHighlighter = useHighlighter;
sqlBlock.highlighter = () => highlight;
export { sqlBlock };
