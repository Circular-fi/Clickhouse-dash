// The documentation of a function: the text that the server sends (a small subset of Markdown) shown without HTML, the code in it
// highlighted like the Query editor.

import { h } from "./app_dom.js";
import { clear, model } from "./app_explorer_store.js";
import { highlight } from "./app_highlight.js";

function safeDocHref(raw) {
  if (model.functionsCatalog?.markdown_links_enabled !== true) return null;
  const value = String(raw || "").trim();
  if (value.startsWith("/") && !value.startsWith("//")) return `https://clickhouse.com/docs${value}`;
  if (value.startsWith("./")) return `https://clickhouse.com/docs/${value.slice(2)}`;
  return null;
}

function renderHighlightedCode(codeEl, source) {
  const text = String(source || "");
  // Reuse the exact SQL lexer/highlighter used by the Query editor. This is
  // important for CREATE statements: identifiers stay identifiers, while
  // functions are highlighted only when they are known functions followed
  // by `(`, using the selected host's function metadata.
  if (highlight && typeof highlight.renderInto === "function") {
    highlight.renderInto(codeEl, text);
    return;
  }
  codeEl.textContent = text;
}

// Inline markdown: [label](href), `code` and **bold**. A link's label is
// inline markdown too ("[`Array(T)`](/sql-reference/data-types/array)"
// reads as code, with or without the link).
function appendMarkdownInline(parent, text) {
  const source = String(text || "");
  const re = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*/g;
  let cursor = 0;
  for (const match of source.matchAll(re)) {
    if (match.index > cursor) parent.appendChild(document.createTextNode(source.slice(cursor, match.index)));
    if (match[1] != null) {
      const href = safeDocHref(match[2]);
      if (href) {
        const a = h("a", { class: "functionDoc__link" });
        appendMarkdownInline(a, match[1]);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.appendChild(a);
      } else {
        appendMarkdownInline(parent, match[1]);
      }
    } else if (match[3] != null) {
      parent.appendChild(h("code", { class: "functionDoc__inlineCode" }, match[3]));
    } else if (match[4] != null) {
      parent.appendChild(h("strong", null, match[4]));
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < source.length) parent.appendChild(document.createTextNode(source.slice(cursor)));
}

function renderSafeMarkdown(container, markdown) {
  clear(container);
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = h("p", { class: "functionDoc__paragraph" });
    appendMarkdownInline(p, paragraph.join(" ").trim());
    container.appendChild(p);
    paragraph = [];
  };
  const closeList = () => { list = null; };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, "");
    if (code) {
      if (/^\s*```/.test(line)) {
        const source = code.lines.join("\n");
        renderHighlightedCode(code.code, source);
        container.appendChild(code.wrap);
        code = null;
      } else {
        code.lines.push(rawLine);
      }
      continue;
    }
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) {
      flushParagraph(); closeList();
      const wrap = h("pre", { class: "functionDoc__code" });
      const codeEl = h("code", { class: fence[1] ? `language-${fence[1]}` : "" });
      wrap.appendChild(codeEl);
      code = { wrap, code: codeEl, lines: [] };
      continue;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      const title = h(heading[1].length <= 2 ? "h3" : "h4", { class: "functionDoc__heading" });
      appendMarkdownInline(title, heading[2]);
      container.appendChild(title);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      if (!list) { list = h("ul", { class: "functionDoc__list" }); container.appendChild(list); }
      const li = document.createElement("li"); appendMarkdownInline(li, bullet[1]); list.appendChild(li);
      continue;
    }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    closeList(); paragraph.push(line.trim());
  }
  if (code) {
    const source = code.lines.join("\n");
    renderHighlightedCode(code.code, source);
    container.appendChild(code.wrap);
  }
  flushParagraph();
}

function splitFunctionDocumentation(markdown) {
  const buckets = { description: [], syntax: [], arguments: [], returns: [], examples: [], seeAlso: [] };
  let current = "description";
  const matchSection = (line) => {
    const cleaned = String(line || "")
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*\*\*/, "").replace(/\*\*\s*:?\s*$/, "")
      .replace(/:\s*$/, "").trim().toLowerCase();
    if (/^syntax$/.test(cleaned)) return "syntax";
    if (/^arguments?$|^parameters?$/.test(cleaned)) return "arguments";
    if (/^returns?$|^returned value$|^return value$/.test(cleaned)) return "returns";
    if (/^examples?$|^usage$/.test(cleaned)) return "examples";
    if (/^see also$|^related$|^references?$/.test(cleaned)) return "seeAlso";
    return null;
  };
  for (const line of String(markdown || "").replace(/\r\n?/g, "\n").split("\n")) {
    const next = matchSection(line);
    if (next) { current = next; continue; }
    buckets[current].push(line);
  }
  return Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.join("\n").trim()]));
}

function appendFunctionDocSection(root, title, content, { code = false } = {}) {
  if (!String(content || "").trim()) return;
  const section = h("section", { class: "functionDoc__section" });
  section.appendChild(h("h3", { class: "functionDoc__sectionTitle" }, title));
  if (code) {
    const pre = h("pre", { class: "functionDoc__code" });
    const codeEl = h("code", { class: "language-sql" });
    renderHighlightedCode(codeEl, String(content || ""));
    pre.appendChild(codeEl);
    section.appendChild(pre);
  } else {
    const body = h("div", { class: "functionDoc__markdown" });
    renderSafeMarkdown(body, content);
    section.appendChild(body);
  }
  root.appendChild(section);
}

export { appendFunctionDocSection, renderHighlightedCode, splitFunctionDocumentation };
