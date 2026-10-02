(() => {
  "use strict";
  // Data tables, one component for every page (style.css "Components: data
  // table" block): <table class="dataTable [dataTable--compact]">.
  //
  //   Header      11.5 px / 700, --muted on --theadBg, sentence case, sticky
  //               inside the table's scroll container.
  //   Density     --row-regular (32 px, the default) or --row-compact (26 px,
  //               .dataTable--compact).
  //   Cells       .num: right-aligned tabular figures (no mono); .mono only for
  //               ids and hashes; a cut-off value keeps its full text in title.
  //   Selection   tr.is-selected: an accent bar on the left plus --rowHover.
  //   Row numbers td/th.dataTable__rowNum (results and previews only).
  //   Bars        td.cellBar with --cellBar (0-100 %) and --cellBar-color:
  //               barEligible() keeps them off identifier and signed columns.
  //   Copy        one hover copy button per cell (copyCellHtml / copyCell).
  //   Sorting     a button in the th, the state in aria-sort only:
  //               sortHeader(th, ...) for DOM tables, sortHeadHtml(...) plus
  //               bindSort(root, onSort) for string-rendered ones. The glyph
  //               is CSS: up / down when sorted, the idle glyph on hover.
  //   Keyboard    rovingRows(container, ...) (also ns.rovingRows): Up / Down,
  //               Page Up / Down, Home / End move between rows, Enter / Space
  //               open one.
  const ns = window.ChDash;
  if (!ns) return;

  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const ARIA = { asc: "ascending", desc: "descending" };
  const ariaSort = (dir) => ARIA[dir] || "none";
  const dirOf = (th) => ({ ascending: "asc", descending: "desc" })[th?.getAttribute("aria-sort")] || "";

  // ------------------------------------------------------------- sorting

  // Marks a header sorted (dir "asc" | "desc") or not (""); the glyph follows.
  function setSort(th, dir) {
    if (th) th.setAttribute("aria-sort", ariaSort(dir));
  }

  // Turns `th` into a sortable header: its content moves into a
  // .dataTable__sort button; onSort(key, event) runs on click (Enter / Space
  // on the button). Returns the button.
  function sortHeader(th, { key, dir = "", onSort = null, title = "" } = {}) {
    if (!th) return null;
    let button = th.querySelector(":scope > .dataTable__sort");
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "dataTable__sort";
      button.append(...th.childNodes);
      th.appendChild(button);
    }
    th.classList.add("is-sortable");
    if (key != null) th.dataset.sortKey = String(key);
    if (title) button.title = title;
    setSort(th, dir);
    if (onSort && !button.dataset.bound) {
      button.dataset.bound = "1";
      button.addEventListener("click", (event) => onSort(th.dataset.sortKey, event));
    }
    return button;
  }

  // The same header as an HTML string. sort: { key, dir } of the table (the
  // header is sorted when sort.key === key). attrs on the th, escaped.
  function sortHeadHtml({ key, label, title = "", sort = null, className = "", num = false, attrs = {} }) {
    const dir = sort && String(sort.key) === String(key) ? sort.dir : "";
    const extra = Object.entries(attrs).map(([name, value]) => ` ${name}="${esc(value)}"`).join("");
    const cls = ["is-sortable", num ? "num" : "", className].filter(Boolean).join(" ");
    return `<th scope="col" class="${esc(cls)}" data-sort-key="${esc(key)}" aria-sort="${ariaSort(dir)}"${extra}><button type="button" class="dataTable__sort"${title ? ` title="${esc(title)}"` : ""}>${esc(label)}</button></th>`;
  }

  // Delegated sorting for string-rendered tables: onSort(key, nextDir, event),
  // nextDir from the clicked header's state ("" -> first, then it flips).
  function bindSort(root, onSort, { first = "desc" } = {}) {
    if (!root || typeof onSort !== "function") return;
    root.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest(".dataTable__sort") : null;
      const th = button?.closest("th[data-sort-key]");
      if (!th || !root.contains(th)) return;
      const dir = dirOf(th);
      const next = dir === "asc" ? "desc" : dir === "desc" ? "asc" : (th.dataset.sortFirst || first);
      onSort(th.dataset.sortKey, next, event);
    });
  }

  // --------------------------------------------------------------- cells

  // Identifier-like column names: ids, keys, hashes, codes, ports, versions,
  // calendar parts. A bar on them reads as a magnitude that is not one.
  const IDENTIFIER = /(?:^|[_\s.-])(?:id|ids|uuid|guid|hash|key|code|port|pid|tid|version|year|month|day|hour|minute|second|number|num|no|index|idx|rank|seq)$|^#$/i;
  const CAMEL_ID = /[a-z](?:Id|ID|Uuid|Hash|Key)$/;

  // A column gets in-cell bars only when it is a measure: not an identifier
  // and never negative (a signed column has no zero to grow from).
  // barEligible({ name, min }) | barEligible(name, values)
  function barEligible(nameOrSpec, values = null) {
    const spec = typeof nameOrSpec === "object" && nameOrSpec ? nameOrSpec : { name: nameOrSpec };
    const name = String(spec.name ?? "").trim();
    if (spec.identifier || IDENTIFIER.test(name) || CAMEL_ID.test(name)) return false;
    let min = spec.min;
    if (min == null && values) {
      for (const v of values) {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n) && (min == null || n < min)) min = n;
      }
    }
    return !(Number(min) < 0);
  }

  // The cellBar fill of a cell, 0-100: value over the column maximum.
  function barPercent(value, max) {
    const n = Number(value);
    const m = Number(max);
    if (!Number.isFinite(n) || !Number.isFinite(m) || m <= 0 || n <= 0) return 0;
    return Math.max(0, Math.min(100, (n / m) * 100));
  }

  // Gives td its bar (ratio 0-100); color: a CSS colour or var() (the accent
  // by default). A null ratio removes it.
  function cellBar(td, percent, { color = "" } = {}) {
    if (!td) return;
    if (percent == null) {
      td.classList.remove("cellBar");
      td.style.removeProperty("--cellBar");
      return;
    }
    td.classList.add("cellBar");
    td.style.setProperty("--cellBar", `${Math.max(0, Math.min(100, Number(percent) || 0)).toFixed(2)}%`);
    if (color) td.style.setProperty("--cellBar-color", color);
  }

  // The style attribute value of a bar cell, for HTML strings.
  function cellBarStyle(percent, color = "") {
    const fill = `--cellBar:${Math.max(0, Math.min(100, Number(percent) || 0)).toFixed(2)}%`;
    return color ? `${fill};--cellBar-color:${color}` : fill;
  }

  // A cell's text with the full value in title when CSS may cut it.
  function textCell(td, text, { title = null } = {}) {
    if (!td) return;
    const value = String(text ?? "");
    td.textContent = value;
    const full = title == null ? value : String(title);
    if (full) td.title = full;
  }

  // The hover copy button of a cell (shown while the row is hovered or the
  // button focused); the click goes through ui.copyText.
  function copyCellHtml(text, label = "Copy") {
    const html = ns.ui?.copyButtonHtml
      ? ns.ui.copyButtonHtml({ label, className: "dataTable__copy", attrs: { "data-copy-text": text } })
      : "";
    return html;
  }

  function copyCell(td, getText, label = "Copy") {
    if (!td || !ns.ui?.copyButton) return null;
    const button = ns.ui.copyButton(null, getText, { label, className: "dataTable__copy" });
    td.classList.add("has-copy");
    td.appendChild(button);
    return button;
  }

  // Delegated clicks of copyCellHtml buttons under root.
  function bindCopy(root) {
    if (!root || root.dataset.dataTableCopy) return;
    root.dataset.dataTableCopy = "1";
    root.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest(".dataTable__copy[data-copy-text]") : null;
      if (!button || !root.contains(button)) return;
      event.preventDefault();
      event.stopPropagation();
      void ns.ui?.copyText?.(button.getAttribute("data-copy-text") || "", button);
    }, true);
  }

  // ------------------------------------------------------------ keyboard

  const MOVE_KEYS = new Set(["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"]);
  const OPEN_KEYS = new Set(["Enter", " "]);

  // The index a key moves to from `at` among `count` rows (`page` per screen).
  function targetIndex(key, at, count, page) {
    if (!count) return -1;
    const from = at < 0 ? (key === "ArrowUp" || key === "End" || key === "PageUp" ? count : -1) : at;
    const step = Math.max(1, page | 0);
    let next = from;
    if (key === "ArrowDown") next = from + 1;
    else if (key === "ArrowUp") next = from - 1;
    else if (key === "PageDown") next = from + step;
    else if (key === "PageUp") next = from - step;
    else if (key === "Home") next = 0;
    else if (key === "End") next = count - 1;
    return Math.max(0, Math.min(count - 1, next));
  }

  // rovingRows(container, options): row navigation for a table or a list.
  //
  // DOM mode (rows: a selector, default "tbody tr[tabindex]"): one row is in
  // the tab order (tabindex 0, the selected one or the first), the others -1;
  // the keys move focus between rows. Rows rendered later are picked up.
  //   onMove(row, event)  optional, after focus moved
  //   onOpen(row, event)  Enter / Space on a row
  //
  // Index mode (count given: virtual lists whose rows are not all in the DOM;
  // the container keeps focus): the keys call onMove(index, event) and
  // onOpen(index, event); current() is the index the keys move from, page()
  // the rows per screen.
  //
  // Keys with Alt / Ctrl / Meta and keys typed in a form field are left alone.
  // Returns { refresh(), destroy() }.
  function rovingRows(container, {
    rows = "tbody tr[tabindex]", onMove = null, onOpen = null, count = null, current = null, page = null,
    selected = ".is-selected",
  } = {}) {
    if (!container) return { refresh() {}, destroy() {} };
    const indexMode = typeof count === "function";
    const list = () => [...container.querySelectorAll(rows)].filter((row) => !row.hidden);

    function refresh() {
      if (indexMode) return;
      const all = list();
      if (!all.length) return;
      const active = all.find((row) => row === document.activeElement)
        || all.find((row) => row.tabIndex === 0 && row.matches(selected))
        || all.find((row) => row.matches(selected))
        || all.find((row) => row.tabIndex === 0)
        || all[0];
      for (const row of all) {
        const value = row === active ? 0 : -1;
        if (row.tabIndex !== value) row.tabIndex = value;
      }
    }

    function pageSize(all) {
      if (typeof page === "function") return page();
      const first = all[0];
      const height = first ? first.getBoundingClientRect().height : 0;
      const view = container.clientHeight || window.innerHeight;
      return height > 0 ? Math.max(1, Math.floor(view / height) - 1) : 10;
    }

    function onKeydown(event) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target && target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (indexMode) {
        const n = count();
        if (MOVE_KEYS.has(event.key)) {
          const next = targetIndex(event.key, typeof current === "function" ? current() : -1, n, typeof page === "function" ? page() : 10);
          if (next < 0) return;
          event.preventDefault();
          onMove?.(next, event);
        } else if (OPEN_KEYS.has(event.key) && onOpen) {
          if (target && target !== container && target.closest("button, a")) return;
          const at = typeof current === "function" ? current() : -1;
          if (at < 0) return;
          event.preventDefault();
          onOpen(at, event);
        }
        return;
      }
      const row = target?.closest(rows);
      if (!row || !container.contains(row)) return;
      if (MOVE_KEYS.has(event.key)) {
        // Only when the row itself has focus: a button inside keeps its keys.
        if (target !== row) return;
        const all = list();
        const next = all[targetIndex(event.key, all.indexOf(row), all.length, pageSize(all))];
        if (!next) return;
        event.preventDefault();
        row.tabIndex = -1;
        next.tabIndex = 0;
        next.focus({ preventScroll: false });
        next.scrollIntoView?.({ block: "nearest" });
        if (next !== row) onMove?.(next, event);
      } else if (OPEN_KEYS.has(event.key) && onOpen && target === row) {
        event.preventDefault();
        onOpen(row, event);
      }
    }

    function onFocusin(event) {
      if (indexMode) return;
      const row = event.target instanceof Element ? event.target.closest(rows) : null;
      if (!row || !container.contains(row)) return;
      for (const other of list()) {
        const value = other === row ? 0 : -1;
        if (other.tabIndex !== value) other.tabIndex = value;
      }
    }

    container.addEventListener("keydown", onKeydown);
    container.addEventListener("focusin", onFocusin);
    let observer = null;
    if (!indexMode && typeof MutationObserver === "function") {
      let queued = false;
      observer = new MutationObserver(() => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => { queued = false; refresh(); });
      });
      observer.observe(container, { childList: true, subtree: true });
    }
    refresh();
    return {
      refresh,
      destroy() {
        container.removeEventListener("keydown", onKeydown);
        container.removeEventListener("focusin", onFocusin);
        observer?.disconnect();
      },
    };
  }

  ns.table = Object.freeze({
    ariaSort, setSort, sortHeader, sortHeadHtml, bindSort,
    barEligible, barPercent, cellBar, cellBarStyle, textCell, copyCellHtml, copyCell, bindCopy,
    rovingRows, targetIndex,
  });
  ns.rovingRows = rovingRows;
})();
