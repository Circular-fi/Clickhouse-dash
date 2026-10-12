// A small syntax highlighter for the code blocks of the site (shell, HCL, SQL, JSON, HTTP, YAML). No library: one sticky regular
// expression per token kind, tried in order at each position. The text of the block is never changed, only wrapped in spans, so
// copying still gives the original text. Colours are in docs/assets/site.css (.tk-*).
(() => {
  "use strict";
  const SQL_WORDS = "select|from|where|group|by|order|limit|offset|having|join|left|right|inner|outer|cross|full|on|using|as|and|or|not|in|is|null|like|ilike|between|case|when|then|else|end|distinct|union|all|with|insert|into|values|create|table|view|materialized|database|engine|alter|add|drop|delete|update|set|show|describe|explain|ast|format|settings|final|prewhere|array|desc|asc|if|exists|default|primary|key|partition|ttl|to|interval|over|window|true|false";
  const RULES = {
    sh: [
      ["m", /#[^\n]*/y],
      ["s", /"(?:\\.|[^"\\\n])*"|'[^'\n]*'/y],
      ["u", /https?:\/\/[^\s"'<>)]+/y],
      ["f", /--?[A-Za-z][\w-]*/y, (st, text, i) => i === 0 || /[\s=]/.test(text[i - 1])],
      ["c", /[A-Za-z_.\/][\w.\/+-]*/y, (st) => st.cmd],
      ["p", /&&|\|\||[|;>&<]/y],
    ],
    hcl: [
      ["m", /(?:#|\/\/)[^\n]*|\/\*[\s\S]*?\*\//y],
      ["s", /"(?:\\.|[^"\\\n])*"/y],
      ["n", /\b\d+(?:\.\d+)?\b/y],
      ["k", /\b(?:true|false|null)\b/y],
      ["f", /[A-Za-z_][\w.-]*(?=\s*[={])/y],
      ["p", /[{}\[\]=,]/y],
    ],
    sql: [
      ["m", /--[^\n]*|\/\*[\s\S]*?\*\//y],
      ["s", /'(?:\\.|''|[^'\\])*'/y],
      ["f", /`[^`\n]*`|"[^"\n]*"/y],
      ["n", /\b\d+(?:\.\d+)?\b/y],
      ["k", new RegExp(`\\b(?:${SQL_WORDS})\\b`, "iy")],
      ["c", /[A-Za-z_][\w]*(?=\()/y],
      ["p", /[(),;=<>*+\-\/%]/y],
    ],
    json: [
      ["f", /"(?:\\.|[^"\\\n])*"(?=\s*:)/y],
      ["s", /"(?:\\.|[^"\\\n])*"/y],
      ["n", /-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/y],
      ["k", /\b(?:true|false|null)\b/y],
      ["p", /[{}\[\],:]/y],
    ],
    http: [
      ["c", /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b|^HTTP\/\d(?:\.\d)?/y],
      ["u", /\S+/y, (st) => st.afterMethod],
      ["f", /^[A-Za-z][\w-]*(?=:)/my],
      ["s", /"(?:\\.|[^"\\\n])*"/y],
      ["n", /\b\d+\b/y],
    ],
    yaml: [
      ["m", /#[^\n]*/y],
      ["s", /"(?:\\.|[^"\\\n])*"|'[^'\n]*'/y],
      ["f", /[A-Za-z_][\w.-]*(?=\s*:)/y],
      ["n", /\b\d+(?:\.\d+)?\b/y],
      ["k", /\b(?:true|false|null)\b/y],
    ],
  };
  const ALIAS = { bash: "sh", shell: "sh", console: "sh", sh: "sh", hcl: "hcl", terraform: "hcl", sql: "sql", clickhouse: "sql", json: "json", http: "http", yaml: "yaml", yml: "yaml" };
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function render(text, rules) {
    let out = "", plain = "", i = 0;
    // st.cmd: the next word is a command (start of a line, after | && ; or a "$ " prompt); st.afterMethod: the word after an HTTP method
    const st = { cmd: true, afterMethod: false };
    const flush = () => { if (plain) { out += esc(plain); plain = ""; } };
    while (i < text.length) {
      let hit = null;
      for (const [kind, re, cond] of rules) {
        if (cond && !cond(st, text, i)) continue;
        re.lastIndex = i;
        const m = re.exec(text);
        if (m && m.index === i && m[0].length) { hit = [kind, m[0]]; break; }
      }
      if (hit) {
        flush(); out += `<span class="tk-${hit[0]}">${esc(hit[1])}</span>`; i += hit[1].length;
        st.afterMethod = hit[0] === "c" && /^[A-Z]+$/.test(hit[1]);
        st.cmd = hit[0] === "p" && /^(?:\||&&|\|\||;)$/.test(hit[1]);
      } else {
        const ch = text[i];
        plain += ch; i++;
        if (ch === "\n") { st.cmd = true; st.afterMethod = false; }
        else if (ch === "$" && text[i] === " ") { st.cmd = true; }
        else if (!/\s/.test(ch)) { st.cmd = false; st.afterMethod = false; }
        else if (ch === " " && st.afterMethod) { /* keep */ }
      }
    }
    flush();
    return out;
  }

  // Highlight one <code>: the language comes from data-lang or from a "language-xxx" class (what marked writes for a fenced block)
  function highlight(code, lang) {
    const name = ALIAS[(lang || code.dataset.lang || (code.className.match(/language-([\w-]+)/) || [])[1] || "").toLowerCase()];
    if (!name) return;
    const text = code.textContent;
    if (text.length > 60000) return; // a huge block stays plain
    code.innerHTML = render(text, RULES[name]);
  }
  window.chdashHighlight = highlight;
  document.querySelectorAll("pre code[data-lang]").forEach((code) => highlight(code));
})();
