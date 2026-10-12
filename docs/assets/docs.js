// The documentation page: it fetches the Markdown files of docs/ (the same files that GitHub shows) and renders them in the browser with
// marked. Nothing is generated or copied: edit a .md file and the page changes with it. tests/harness/test_docs_site.py checks that
// every docs/*.md file is listed below, and that every listed file exists.
(() => {
  "use strict";
  const REPO = "https://github.com/Circular-fi/Clickhouse-dash";
  // [file without .md, title in the menu]
  const DOCS = [
    ["Get started", [
      ["configuration", "Configuration"],
      ["configuration-reference", "Configuration keys"],
      ["operations", "Operations"],
    ]],
    ["Query", [
      ["query-analysis", "Profiling and analysis"],
      ["query-library", "Query library and history"],
      ["formatter", "SQL formatter"],
      ["massive-export", "Massive exports"],
      ["post-run-download", "Downloads and debug bundle"],
    ]],
    ["Explore and monitor", [
      ["explorer", "Explorer"],
      ["system", "System"],
      ["traces", "Traces"],
      ["logs", "Logs"],
      ["metrics", "Metrics"],
    ]],
    ["AI assistants", [
      ["mcp", "MCP integration"],
      ["mcp-integration-page", "MCP keys page"],
    ]],
    ["Reference", [
      ["telemetry", "Native TCP telemetry"],
      ["wasm", "WebAssembly kernels"],
      ["ui-foundations", "UI foundations"],
    ]],
  ];
  const FLAT = DOCS.flatMap(([, items]) => items);
  const NAMES = new Set(FLAT.map(([name]) => name));
  const TITLE = Object.fromEntries(FLAT);

  const $ = (s, r = document) => r.querySelector(s);
  const article = $("#article");
  const sidebar = $("#sidebar");
  const toc = $("#toc");
  const pager = $("#pager");
  const cache = new Map();
  let current = "";
  let spy = null;

  const slug = (text) => text.toLowerCase().trim().replace(/[^\wÀ-￿\s-]/g, "").replace(/\s+/g, "-");

  // Sidebar
  const buildSidebar = (query = "") => {
    const q = query.trim().toLowerCase();
    sidebar.textContent = "";
    for (const [group, items] of DOCS) {
      const shown = items.filter(([name, title]) => !q || title.toLowerCase().includes(q) || name.includes(q));
      if (!shown.length) continue;
      const h = document.createElement("h2");
      h.textContent = group;
      const ul = document.createElement("ul");
      for (const [name, title] of shown) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = `#/${name}`;
        a.textContent = title;
        if (name === current) a.setAttribute("aria-current", "page");
        li.appendChild(a);
        ul.appendChild(li);
      }
      sidebar.append(h, ul);
    }
    if (!sidebar.children.length) { const p = document.createElement("p"); p.className = "none"; p.textContent = "No page matches."; sidebar.appendChild(p); }
  };
  $("#filter").addEventListener("input", (e) => buildSidebar(e.target.value));

  const parseRoute = () => {
    const m = location.hash.match(/^#\/([a-z0-9-]+)(?:\/(.+))?$/);
    return m && NAMES.has(m[1]) ? { name: m[1], anchor: decodeURIComponent(m[2] || "") } : { name: "", anchor: "" };
  };

  const load = async (name) => {
    if (cache.has(name)) return cache.get(name);
    const response = await fetch(`${name}.md`);
    if (!response.ok) throw new Error(`${name}.md: ${response.status}`);
    const text = await response.text();
    cache.set(name, text);
    return text;
  };

  // Links and images of a Markdown file written for GitHub, rewritten for this page
  const fixLinks = (root, name) => {
    for (const a of root.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (/^(https?:|mailto:)/i.test(href)) { a.rel = "noopener"; continue; }
      if (href.startsWith("#")) { a.setAttribute("href", `#/${name}/${encodeURIComponent(href.slice(1))}`); continue; }
      const [path, hash] = href.split("#");
      const file = path.replace(/^\.\//, "");
      const base = file.replace(/\.md$/, "");
      if (/^[a-z0-9-]+\.md$/.test(file) && NAMES.has(base)) { a.setAttribute("href", `#/${base}${hash ? "/" + encodeURIComponent(hash) : ""}`); continue; }
      // Anything else lives in the repository: the page of the file on GitHub
      const repoPath = path.startsWith("../") ? path.slice(3) : `docs/${file}`;
      a.setAttribute("href", `${REPO}/blob/main/${repoPath}${hash ? "#" + hash : ""}`);
      a.rel = "noopener";
    }
    for (const img of root.querySelectorAll("img[src]")) {
      const src = img.getAttribute("src");
      if (/^(https?:|data:)/i.test(src)) continue;
      img.setAttribute("src", src.startsWith("../") ? `https://raw.githubusercontent.com/Circular-fi/Clickhouse-dash/main/${src.slice(3)}` : src);
      img.loading = "lazy";
    }
  };

  const decorate = (root) => {
    const used = new Set();
    for (const h of root.querySelectorAll("h1, h2, h3, h4")) {
      let id = slug(h.textContent);
      while (used.has(id)) id += "-1";
      used.add(id);
      h.id = id;
      if (h.tagName !== "H1") {
        const a = document.createElement("a");
        a.className = "anchor";
        a.href = `#/${current}/${encodeURIComponent(id)}`;
        a.setAttribute("aria-label", `Link to ${h.textContent}`);
        a.textContent = "#";
        h.appendChild(a);
      }
    }
    for (const th of root.querySelectorAll("th")) { if (!th.textContent.trim()) { const s = document.createElement("span"); s.className = "srOnly"; s.textContent = "Details"; th.appendChild(s); } }
    let tableNumber = 0;
    for (const table of root.querySelectorAll("table")) {
      const wrap = document.createElement("div");
      wrap.className = "tableWrap";
      wrap.tabIndex = 0;
      wrap.setAttribute("role", "region");
      wrap.setAttribute("aria-label", `Table ${++tableNumber}`);
      table.replaceWith(wrap);
      wrap.appendChild(table);
    }
    root.querySelectorAll("pre code").forEach((code) => { if (window.chdashHighlight) window.chdashHighlight(code); });
    for (const pre of root.querySelectorAll("pre")) {
      pre.tabIndex = 0;
      pre.setAttribute("aria-label", "Code");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "copyCode";
      button.textContent = "Copy";
      button.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? pre.textContent); button.textContent = "Copied"; } catch (e) { button.textContent = "Press Ctrl+C"; }
        setTimeout(() => { button.textContent = "Copy"; }, 1600);
      });
      pre.appendChild(button);
    }
  };

  const buildToc = (root) => {
    toc.textContent = "";
    if (spy) spy.disconnect();
    const heads = [...root.querySelectorAll("h2, h3")];
    if (!heads.length) return;
    const links = new Map();
    for (const h of heads) {
      const a = document.createElement("a");
      a.href = `#/${current}/${encodeURIComponent(h.id)}`;
      a.className = h.tagName === "H3" ? "sub" : "";
      a.textContent = h.firstChild.textContent;
      toc.appendChild(a);
      links.set(h, a);
    }
    spy = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { links.forEach((a) => a.removeAttribute("aria-current")); links.get(e.target).setAttribute("aria-current", "true"); }
    }, { rootMargin: "-80px 0px -70% 0px" });
    heads.forEach((h) => spy.observe(h));
  };

  const buildPager = () => {
    pager.textContent = "";
    const i = FLAT.findIndex(([name]) => name === current);
    const link = (item, label, cls) => {
      const a = document.createElement("a");
      a.className = cls;
      a.href = `#/${item[0]}`;
      const small = document.createElement("small"); small.textContent = label;
      const strong = document.createElement("strong"); strong.textContent = item[1];
      a.append(small, strong);
      pager.appendChild(a);
    };
    if (i > 0) link(FLAT[i - 1], "Previous", "prev");
    if (i >= 0 && i < FLAT.length - 1) link(FLAT[i + 1], "Next", "next");
  };

  const home = () => {
    current = "";
    document.title = "Documentation - ClickHouse Dash";
    article.textContent = "";
    const h1 = document.createElement("h1"); h1.textContent = "Documentation";
    const p = document.createElement("p"); p.className = "lead";
    p.textContent = "These pages are the Markdown files of the repository, rendered here as they are. Pick one to start.";
    article.append(h1, p);
    for (const [group, items] of DOCS) {
      const h = document.createElement("h2"); h.textContent = group;
      const ul = document.createElement("ul"); ul.className = "index";
      for (const [name, title] of items) { const li = document.createElement("li"); const a = document.createElement("a"); a.href = `#/${name}`; a.textContent = title; li.appendChild(a); ul.appendChild(li); }
      article.append(h, ul);
    }
    toc.textContent = ""; pager.textContent = "";
    $("#source").href = `${REPO}/tree/main/docs`;
    buildSidebar($("#filter").value);
  };

  const show = async () => {
    const { name, anchor } = parseRoute();
    if (!name) { home(); window.scrollTo(0, 0); return; }
    if (name !== current) {
      current = name;
      article.innerHTML = '<div class="loading" aria-hidden="true"><i></i><i></i><i></i><i></i></div>';
      buildSidebar($("#filter").value);
      try {
        const text = await load(name);
        if (current !== name) return;
        article.innerHTML = window.marked.parse(text, { gfm: true });
        fixLinks(article, name);
        decorate(article);
        const h1 = article.querySelector("h1");
        document.title = `${h1 ? h1.textContent : TITLE[name]} - ClickHouse Dash`;
        buildToc(article);
        buildPager();
        $("#source").href = `${REPO}/blob/main/docs/${name}.md`;
      } catch (error) {
        article.innerHTML = "";
        const h = document.createElement("h1"); h.textContent = TITLE[name];
        const p = document.createElement("p");
        p.append("This page could not be loaded. ");
        const a = document.createElement("a"); a.href = `${REPO}/blob/main/docs/${name}.md`; a.textContent = "Read it on GitHub";
        p.append(a, ".");
        article.append(h, p);
      }
      if (!anchor) window.scrollTo(0, 0);
    }
    if (anchor) {
      const target = document.getElementById(anchor);
      if (target) target.scrollIntoView({ block: "start" });
    }
  };
  if (window.matchMedia("(max-width: 640px)").matches) $("#menu").removeAttribute("open");
  window.addEventListener("hashchange", show);
  buildSidebar();
  show();
})();
