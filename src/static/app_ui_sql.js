(() => {
  "use strict";
  // Read-only SQL, one component for every page (style.css "Components: SQL
  // block" block), highlighted by the editor's highlighter (app_highlight.js,
  // ns.highlight.toHtml). A page that has not loaded it (Observability) gets
  // the plain text at once and the colours when the highlighter has loaded.
  //
  //   ui.sqlBlock({ sql, gutter, copy, maxLines, expand, inline, label })
  //     gutter    line numbers
  //     copy      a copy button (ui.copyButton) at the top right
  //     maxLines  the lines shown before "Show all N lines" (expand: true,
  //               the default when maxLines is set) or a scroll
  //     inline    one line cut with an ellipsis inside a table cell: a click
  //               (Enter / Space) shows it all, wrapped, and back
  //     wrap      long lines wrap instead of scrolling
  //   Returns the element (.sqlBlock).
  //   ui.sqlBlockHtml({ sql, inline, label }) is the same block as an HTML
  //   string, for modules that render strings; ui.sqlBind(root) once on their
  //   container gives its inline blocks the toggle.
  const ns = window.ChDash;
  if (!ns) return;
  const ui = (ns.ui = ns.ui || {});

  const HIGHLIGHTER = "app_highlight.js";
  const base = (() => {
    const src = document.currentScript?.src || "";
    return src ? src.replace(/[^/]*$/, "") : "";
  })();

  let loading = null;
  const pending = new Set();

  function loadHighlighter() {
    if (ns.highlight?.toHtml) return Promise.resolve();
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        if (!base) { reject(new Error("no base URL")); return; }
        const script = document.createElement("script");
        script.src = base + HIGHLIGHTER;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Failed to load ${HIGHLIGHTER}`));
        document.head.appendChild(script);
      }).then(() => {
        for (const paint of pending) paint();
        pending.clear();
        // Blocks written as HTML strings before the highlighter loaded.
        for (const code of document.querySelectorAll(".sqlBlock__code[data-sql-plain]")) {
          code.removeAttribute("data-sql-plain");
          code.innerHTML = ns.highlight.toHtml(code.textContent || "");
        }
      }, () => { pending.clear(); });
    }
    return loading;
  }

  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function paintInto(code, sql) {
    const paint = () => {
      if (ns.highlight?.toHtml) code.innerHTML = ns.highlight.toHtml(sql);
      else code.innerHTML = esc(sql);
    };
    paint();
    if (!ns.highlight?.toHtml) {
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
    const ready = !!ns.highlight?.toHtml;
    if (!ready) void loadHighlighter();
    const code = ready ? ns.highlight.toHtml(text) : esc(text);
    const attrs = ready ? "" : " data-sql-plain";
    if (inline) {
      const title = `${label}: click to show it all`;
      return `<button type="button" class="sqlBlock sqlBlock--inline" aria-expanded="false" title="${esc(title).replace(/"/g, "&quot;")}"><code class="sqlBlock__code"${attrs}>${code}</code></button>`;
    }
    return `<div class="sqlBlock"><div class="sqlBlock__body"><pre class="sqlBlock__pre" aria-label="${esc(label).replace(/"/g, "&quot;")}"><code class="sqlBlock__code"${attrs}>${code}</code></pre></div></div>`;
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
    paintInto(code, text);

    if (copy && ui.copyButton) {
      const button = ui.copyButton(null, () => text, { label: `Copy ${label}`, className: "sqlBlock__copy" });
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

  ui.sqlBlock = sqlBlock;
  ui.sqlBlockHtml = sqlBlockHtml;
  ui.sqlBind = sqlBind;
  ns.sqlBlock = sqlBlock;
})();
