(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  const tabSize = 4;
  const escapeHtml = (s) => {
    const u = ns.util;
    if (u && typeof u.escapeHtml === "function") return u.escapeHtml(String(s ?? ""));
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;");
  };

  const wrapHtml = (raw, kind) => {
    const x = escapeHtml(raw);
    if (kind === "str") return `<span class="tok-str">${x}</span>`;
    if (kind === "com") return `<span class="tok-com">${x}</span>`;
    if (kind === "kw") return `<span class="tok-kw">${x}</span>`;
    if (kind === "fn") return `<span class="tok-fn">${x}</span>`;
    if (kind === "num") return `<span class="tok-num">${x}</span>`;
    if (kind === "null") return `<span class="tok-null">${x}</span>`;
    return x;
  };

  const commonKeywords = new Set(
    [
      "with",
      "select",
      "from",
      "where",
      "group",
      "by",
      "having",
      "order",
      "limit",
      "join",
      "on",
      "as",
      "and",
      "or",
      "not",
      "in",
      "is",
      "null",
      "distinct",
      "union",
      "all"
    ].map((x) => x.toLowerCase())
  );

  const ws = String.raw`(?:\s+|/\*[\s\S]*?\*/|--[^\n]*\n|#[^\n]*\n)+`;
  const keywordPatterns = [
    new RegExp(String.raw`\bGROUP${ws}BY\b`, "gi"),
    new RegExp(String.raw`\bORDER${ws}BY\b`, "gi"),
    new RegExp(String.raw`\bUNION${ws}ALL\b`, "gi"),
    new RegExp(String.raw`\bLEFT${ws}JOIN\b`, "gi"),
    new RegExp(String.raw`\bRIGHT${ws}JOIN\b`, "gi"),
    new RegExp(String.raw`\bINNER${ws}JOIN\b`, "gi"),
    new RegExp(String.raw`\bFULL${ws}JOIN\b`, "gi"),
    new RegExp(String.raw`\bCROSS${ws}JOIN\b`, "gi"),
    new RegExp(String.raw`\bARRAY${ws}JOIN\b`, "gi"),
    new RegExp(String.raw`\bLEFT${ws}ARRAY${ws}JOIN\b`, "gi"),
  ].sort((a, b) => b.source.length - a.source.length);

  const isWordChar = (c) => {
    const code = c.charCodeAt(0);
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "_";
  };

  const isWordStart = (c) => {
    const code = c.charCodeAt(0);
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "_";
  };

  const getKeywordSet = () => {
    const st = ns.state;
    if (!st || !st.selectedHostId || !st.meta || !st.meta.hosts) return null;
    const hostMeta = st.meta.hosts[String(st.selectedHostId)] || null;
    const kw = hostMeta && hostMeta.keywords ? hostMeta.keywords : null;
    return kw && kw.set instanceof Set ? kw.set : null;
  };

  const getFunctionMeta = () => {
    const st = ns.state;
    if (!st || !st.selectedHostId || !st.meta || !st.meta.hosts) return null;
    const hostMeta = st.meta.hosts[String(st.selectedHostId)] || null;
    const fn = hostMeta && hostMeta.functions ? hostMeta.functions : null;
    if (!fn || !(fn.ci instanceof Set) || !(fn.cs instanceof Set)) return null;
    return fn;
  };

  const skipWsAndComments = (s, pos) => {
    let i = pos;
    while (i < s.length) {
      const c = s[i];
      const nx = i + 1 < s.length ? s[i + 1] : "";
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i += 1;
        continue;
      }
      if (c === "-" && nx === "-") {
        i += 2;
        while (i < s.length && s[i] !== "\n") i += 1;
        continue;
      }
      if (c === "#") {
        i += 1;
        while (i < s.length && s[i] !== "\n") i += 1;
        continue;
      }
      if (c === "/" && nx === "*") {
        i += 2;
        while (i + 1 < s.length && !(s[i] === "*" && s[i + 1] === "/")) i += 1;
        i = i + 2 <= s.length ? i + 2 : s.length;
        continue;
      }
      break;
    }
    return i;
  };

  const findPatternRanges = (s) => {
    const ranges = [];
    for (const re of keywordPatterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s))) {
        ranges.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex += 1;
      }
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (!last || r.start > last.end) merged.push({ start: r.start, end: r.end });
      else last.end = Math.max(last.end, r.end);
    }
    return merged;
  };

  const tokenizePlain = (text, base) => {
    const s = String(text ?? "");
    const kwSet = getKeywordSet();
    const fnMeta = getFunctionMeta();
    if (!s) return [{ start: base, end: base + s.length, kind: "plain", html: wrapHtml(s, "plain") }];

    const patterns = findPatternRanges(s);
    if (patterns.length) {
      const out = [];
      let cur = 0;
      for (const r of patterns) {
        if (r.start > cur) out.push(...tokenizePlain(s.slice(cur, r.start), base + cur));
        out.push({ start: base + r.start, end: base + r.end, kind: "kw", html: wrapHtml(s.slice(r.start, r.end), "kw") });
        cur = r.end;
      }
      if (cur < s.length) out.push(...tokenizePlain(s.slice(cur), base + cur));
      return out;
    }

    const out = [];
    let i = 0;
    let segStart = 0;

    const push = (a, b, kind) => {
      if (b <= a) return;
      const raw = s.slice(a, b);
      out.push({ start: base + a, end: base + b, kind, html: wrapHtml(raw, kind) });
    };

    while (i < s.length) {
      const c = s[i];

      if (c === "`") {
        let j = i + 1;
        while (j < s.length && s[j] !== "`") j += 1;
        const hasClose = j < s.length;
        if (!hasClose) {
          i += 1;
          continue;
        }
        const end = j + 1;
        const inner = s.slice(i + 1, j);

        let isFn = false;
        if (fnMeta && hasClose) {
          const next = skipWsAndComments(s, end);
          if (next < s.length && s[next] === "(") {
            if (fnMeta.cs.has(inner)) isFn = true;
            else if (fnMeta.ci.has(inner.toLowerCase())) isFn = true;
          }
        }

        if (isFn) {
          push(segStart, i, "plain");
          push(i, i + 1, "plain");
          push(i + 1, j, "fn");
          push(j, j + 1, "plain");
          segStart = end;
        }

        i = end;
        continue;
      }

      if ((c >= "0" && c <= "9") || (c === "-" && i + 1 < s.length && s[i + 1] >= "0" && s[i + 1] <= "9")) {
        if (i === 0 || !isWordChar(s[i - 1])) {
          const m = s.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
          if (m && m[0]) {
            push(segStart, i, "plain");
            push(i, i + m[0].length, "num");
            segStart = i + m[0].length;
            i = segStart;
            continue;
          }
        }
      }

      if (!isWordStart(c)) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < s.length && isWordChar(s[j])) j += 1;
      const word = s.slice(i, j);
      const wLower = word.toLowerCase();
      const isCommon = commonKeywords.has(wLower);
      const isKw = isCommon || (kwSet && kwSet.has(word));
      const isNull = isKw && wLower === "null";

      let isFn = false;
      if (fnMeta) {
        const next = skipWsAndComments(s, j);
        if (next < s.length && s[next] === "(") {
          const w = word;
          if (fnMeta.cs.has(w)) isFn = true;
          else if (fnMeta.ci.has(w.toLowerCase())) isFn = true;
        }
      }

      if (isKw || isFn) {
        push(segStart, i, "plain");
        push(i, j, isFn ? "fn" : isNull ? "null" : "kw");
        segStart = j;
      }
      i = j;
    }
    push(segStart, s.length, "plain");
    return out;
  };

  const lexAll = (text) => {
    const s = String(text ?? "");
    if (!s) return [];

    const out = [];
    let i = 0;
    let mode = "plain";
    let segStart = 0;
    let segKind = "plain";

    const push = (end) => {
      if (end <= segStart) {
        segStart = end;
        return;
      }
      const raw = s.slice(segStart, end);
      if (segKind === "plain") out.push(...tokenizePlain(raw, segStart));
      else out.push({ start: segStart, end, kind: segKind, html: wrapHtml(raw, segKind) });
      segStart = end;
    };

    const open = (nextMode, nextKind, at) => {
      push(at);
      mode = nextMode;
      segKind = nextKind;
      segStart = at;
    };

    const close = (at) => {
      push(at);
      mode = "plain";
      segKind = "plain";
      segStart = at;
    };

    while (i < s.length) {
      const c = s[i];
      const nx = i + 1 < s.length ? s[i + 1] : "";

      if (mode === "lc") {
        i += 1;
        if (c === "\n") close(i);
        continue;
      }

      if (mode === "bc") {
        if (c === "*" && nx === "/") {
          i += 2;
          close(i);
          continue;
        }
        i += 1;
        continue;
      }

      if (mode === "sq") {
        if (c === "\\") {
          i += nx ? 2 : 1;
          continue;
        }
        if (c === "'" && nx === "'") {
          i += 2;
          continue;
        }
        if (c === "'") {
          i += 1;
          close(i);
          continue;
        }
        i += 1;
        continue;
      }

      if (mode === "dq") {
        if (c === "\\") {
          i += nx ? 2 : 1;
          continue;
        }
        if (c === "\"") {
          i += 1;
          close(i);
          continue;
        }
        i += 1;
        continue;
      }

      if (c === "-" && nx === "-") {
        open("lc", "com", i);
        i += 2;
        continue;
      }

      if (c === "#") {
        open("lc", "com", i);
        i += 1;
        continue;
      }

      if (c === "/" && nx === "*") {
        open("bc", "com", i);
        i += 2;
        continue;
      }

      if (c === "'") {
        open("sq", "str", i);
        i += 1;
        continue;
      }

      if (c === "\"") {
        open("dq", "str", i);
        i += 1;
        continue;
      }

      if (c === "`") {
        i += 1;
        while (i < s.length && s[i] !== "`") i += 1;
        if (i < s.length) i += 1;
        continue;
      }

      i += 1;
    }

    push(s.length);
    return out;
  };

  const findTokenIndex = (tokens, pos) => {
    if (!tokens || tokens.length === 0) return -1;
    let lo = 0;
    let hi = tokens.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = tokens[mid];
      if (pos < t.start) {
        hi = mid - 1;
      } else if (pos >= t.end) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    if (pos <= 0) return 0;
    if (pos >= tokens[tokens.length - 1].end) return tokens.length - 1;
    return Math.max(0, Math.min(tokens.length - 1, lo));
  };

  const scanPartial = (prevText, newText, prevTokens, diffStart, syncNewBase, syncPrevBase) => {
    const idx = findTokenIndex(prevTokens, diffStart);
    const rescanStart = idx >= 0 ? prevTokens[idx].start : 0;
    const prefix = idx > 0 ? prevTokens.slice(0, idx) : [];

    const fnMeta = getFunctionMeta();

    const s = String(newText ?? "");
    const old = String(prevText ?? "");
    const delta = s.length - old.length;
    const out = [];

    let i = rescanStart;
    let mode = "plain";
    let segStart = rescanStart;
    let segKind = "plain";

    const push = (end) => {
      if (end <= segStart) {
        segStart = end;
        return;
      }
      const raw = s.slice(segStart, end);
      if (segKind === "plain") out.push(...tokenizePlain(raw, segStart));
      else out.push({ start: segStart, end, kind: segKind, html: wrapHtml(raw, segKind) });
      segStart = end;
    };

    const open = (nextMode, nextKind, at) => {
      push(at);
      mode = nextMode;
      segKind = nextKind;
      segStart = at;
    };

    const close = (at) => {
      push(at);
      mode = "plain";
      segKind = "plain";
      segStart = at;
    };

    const isWordCharAt = (str, pos) => {
      if (pos < 0 || pos >= str.length) return false;
      const c = str[pos];
      return c ? isWordChar(c) : false;
    };

    const isInsideWord = (str, pos) => isWordCharAt(str, pos - 1) && isWordCharAt(str, pos);

    const scanFnNameBefore = (str, pos) => {
      let p = pos;
      while (p > 0) {
        const c = str[p - 1];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
          p -= 1;
          continue;
        }
        break;
      }
      if (p <= 0) return null;
      if (str[p - 1] === "`") {
        let a = p - 2;
        for (let k = 0; k < 512 && a >= 0; k++) {
          if (str[a] === "`") return { word: str.slice(a + 1, p - 1) };
          a -= 1;
        }
        return null;
      }
      if (!isWordCharAt(str, p - 1)) return null;
      let a = p - 1;
      for (let k = 0; k < 512 && a > 0; k++) {
        if (!isWordCharAt(str, a - 1)) break;
        a -= 1;
      }
      const word = str.slice(a, p);
      return { word };
    };

    const isFnCallGap = (str, pos) => {
      if (!fnMeta) return false;
      const next = skipWsAndComments(str, pos);
      if (next >= str.length || str[next] !== "(") return false;
      const w = scanFnNameBefore(str, pos);
      if (!w || !w.word || !isWordStart(w.word[0])) return false;
      const name = w.word;
      if (fnMeta.cs.has(name)) return true;
      return fnMeta.ci.has(name.toLowerCase());
    };

    const isFnBoundary = (str, pos) => {
      if (!fnMeta) return false;
      if (!isWordCharAt(str, pos - 1) || isWordCharAt(str, pos)) return false;
      let a = pos - 1;
      for (let k = 0; k < 256 && a > 0; k++) {
        if (!isWordCharAt(str, a - 1)) break;
        a -= 1;
      }
      const word = str.slice(a, pos);
      if (!word || !isWordStart(word[0])) return false;
      if (!(fnMeta.cs.has(word) || fnMeta.ci.has(word.toLowerCase()))) return false;
      const next = skipWsAndComments(str, pos);
      return next < str.length && str[next] === "(";
    };

    const canSyncAt = (posNew) => {
      if (posNew < syncNewBase) return false;
      if (mode !== "plain") return false;
      const posPrev = syncPrevBase + (posNew - syncNewBase);
      if (posPrev < 0 || posPrev > old.length) return false;
      if (isInsideWord(s, posNew) || isInsideWord(old, posPrev)) return false;
      if (isFnCallGap(s, posNew) || isFnCallGap(old, posPrev)) return false;
      const j = findTokenIndex(prevTokens, posPrev);
      if (j < 0) return false;
      const t = prevTokens[j];
      if (t.start === posPrev) return { posNew, posPrev, tokenIndex: j, splitPlain: false };
      if (t.kind === "plain" && posPrev > t.start && posPrev < t.end) return { posNew, posPrev, tokenIndex: j, splitPlain: true };
      return false;
    };

    let sync = null;

    while (i < s.length) {
      const c = s[i];
      const nx = i + 1 < s.length ? s[i + 1] : "";

      if (mode === "lc") {
        i += 1;
        if (c === "\n") close(i);
        if (!sync) sync = canSyncAt(i) || null;
        if (sync) break;
        continue;
      }

      if (mode === "bc") {
        if (c === "*" && nx === "/") {
          i += 2;
          close(i);
          sync = canSyncAt(i) || sync;
          if (sync) break;
          continue;
        }
        i += 1;
        continue;
      }

      if (mode === "sq") {
        if (c === "\\") {
          i += nx ? 2 : 1;
          continue;
        }
        if (c === "'" && nx === "'") {
          i += 2;
          continue;
        }
        if (c === "'") {
          i += 1;
          close(i);
          sync = canSyncAt(i) || sync;
          if (sync) break;
          continue;
        }
        i += 1;
        continue;
      }

      if (mode === "dq") {
        if (c === "\\") {
          i += nx ? 2 : 1;
          continue;
        }
        if (c === "\"") {
          i += 1;
          close(i);
          sync = canSyncAt(i) || sync;
          if (sync) break;
          continue;
        }
        i += 1;
        continue;
      }

      if (c === "-" && nx === "-") {
        open("lc", "com", i);
        i += 2;
        continue;
      }

      if (c === "#") {
        open("lc", "com", i);
        i += 1;
        continue;
      }

      if (c === "/" && nx === "*") {
        open("bc", "com", i);
        i += 2;
        continue;
      }

      if (c === "'") {
        open("sq", "str", i);
        i += 1;
        continue;
      }

      if (c === "\"") {
        open("dq", "str", i);
        i += 1;
        continue;
      }

      if (c === "`") {
        i += 1;
        while (i < s.length && s[i] !== "`") i += 1;
        if (i < s.length) i += 1;
        continue;
      }

      i += 1;
      sync = canSyncAt(i) || sync;
      if (sync) break;
    }

    const endPos = sync ? sync.posNew : s.length;
    push(endPos);

    if (!sync) return { tokens: prefix.concat(out), endPos };

    const suffix = [];
    const startPrev = sync.posPrev;
    const startNew = sync.posNew;
    const j0 = sync.tokenIndex;
    const t0 = prevTokens[j0];

    if (sync.splitPlain) {
      suffix.push({
        start: startPrev + delta,
        end: t0.end + delta,
        kind: "plain",
        html: wrapHtml(old.slice(startPrev, t0.end), "plain"),
      });
      for (let j = j0 + 1; j < prevTokens.length; j++) {
        const t = prevTokens[j];
        suffix.push({ start: t.start + delta, end: t.end + delta, kind: t.kind, html: t.html });
      }
    } else {
      for (let j = j0; j < prevTokens.length; j++) {
        const t = prevTokens[j];
        if (j === j0 && t.start !== startPrev) continue;
        suffix.push({ start: t.start + delta, end: t.end + delta, kind: t.kind, html: t.html });
      }
    }

    if (suffix.length > 0 && suffix[0].start !== startNew) {
      suffix[0].start = startNew;
    }

    return { tokens: prefix.concat(out).concat(suffix), endPos };
  };

  const createOverlay = (ta) => {
    if (!ta || ta.dataset && ta.dataset.hlAttached === "1") return null;

    const wrap = document.createElement("div");
    wrap.className = "editorWrap";

    const pre = document.createElement("pre");
    pre.className = "editorHighlight";
    pre.setAttribute("aria-hidden", "true");
    pre.style.tabSize = String(tabSize);
    pre.style.MozTabSize = String(tabSize);

    ta.classList.add("editorInput");
    ta.style.tabSize = String(tabSize);
    ta.style.MozTabSize = String(tabSize);

    const parent = ta.parentNode;
    if (!parent) return null;
    parent.insertBefore(wrap, ta);
    const gutter = document.createElement("pre");
    gutter.className = "editorGutter";
    gutter.setAttribute("aria-hidden", "true");
    gutter.style.tabSize = String(tabSize);
    gutter.style.MozTabSize = String(tabSize);

    wrap.appendChild(gutter);
    wrap.appendChild(pre);
    wrap.appendChild(ta);

    if (ta.dataset) ta.dataset.hlAttached = "1";
    return { wrap, pre, gutter };
  };

  const attach = (ta) => {
    if (!ta) return null;

    const overlay = createOverlay(ta);
    const pre = overlay ? overlay.pre : ta.parentNode && ta.parentNode.querySelector(".editorHighlight");
    const gutter = overlay ? overlay.gutter : ta.parentNode && ta.parentNode.querySelector(".editorGutter");
    if (!pre) return null;

    let prevText = String(ta.value || "");
    let tokens = lexAll(prevText);
    let scheduled = false;
    let forceFull = true;
    let lastInputType = "";
    let lastDataLen = 0;
    let prevLineCount = 1;
    let gutterText = "";
    let errorLc = null;

    const computeErrorRange = (text, loc) => {
      if (!loc) return null;
      const line1 = Number(loc.line) | 0;
      const col1 = Number(loc.col) | 0;
      if (line1 <= 0 || col1 <= 0) return null;

      const nearRaw = typeof loc.near === "string" ? loc.near : "";
      const near = (() => {
        const s = String(nearRaw || "");
        if (s.length >= 2) {
          const a = s[0];
          const b = s[s.length - 1];
          if ((a === "`" && b === "`") || (a === "'" && b === "'") || (a === '"' && b === '"')) return s.slice(1, -1);
        }
        return s;
      })();

      let i = 0;
      let line = 1;
      while (line < line1 && i < text.length) {
        if (text.charCodeAt(i) === 10) line += 1;
        i += 1;
      }
      if (line !== line1) return null;

      const lineStart = i;
      while (i < text.length && text.charCodeAt(i) !== 10) i += 1;
      const lineEnd = i;
      const lineLen = lineEnd - lineStart;
      if (lineLen <= 0) return null;

      const col0 = Math.max(0, Math.min(col1 - 1, lineLen));
      let pos = lineStart + col0;
      if (pos === lineEnd) pos = lineEnd - 1;

      if (near) {
        const tryAt = (p) => {
          if (p < lineStart || p >= lineEnd) return null;
          if (p + near.length > lineEnd) return null;
          if (text.slice(p, p + near.length) === near) return { from: p, to: p + near.length };
          return null;
        };

        const direct = tryAt(pos) || tryAt(pos - 1) || tryAt(pos + 1);
        if (direct) return direct;

        let best = null;
        let bestDist = Infinity;
        let k = lineStart;
        while (k < lineEnd) {
          const idx = text.indexOf(near, k);
          if (idx < 0 || idx >= lineEnd) break;
          const dist = Math.abs(idx - pos);
          if (dist < bestDist) {
            bestDist = dist;
            best = { from: idx, to: Math.min(idx + near.length, lineEnd) };
            if (dist === 0) break;
          }
          k = idx + 1;
        }
        if (best) return best;
      }

      const isW = (p) => {
        if (p < lineStart || p >= lineEnd) return false;
        const c = text[p];
        return c ? isWordChar(c) : false;
      };

      let p = pos;
      if (!isW(p)) {
        if (isW(p - 1)) p = p - 1;
        else if (isW(p + 1)) p = p + 1;
      }

      if (isW(p)) {
        let from = p;
        while (from > lineStart && isW(from - 1)) from -= 1;
        let to = p + 1;
        while (to < lineEnd && isW(to)) to += 1;
        if (to > from) return { from, to };
      }

      const from = pos;
      const to = Math.min(from + 1, lineEnd);
      if (to <= from) return null;
      return { from, to };
    };

    const renderWithError = (range) => {
      const msg = errorLc && errorLc.message ? String(errorLc.message) : "";
      const title = msg ? ` title="${escapeHtml(msg)}"` : "";
      const out = [];
      const from = range.from;
      const to = range.to;
      for (const t of tokens) {
        if (to <= t.start || from >= t.end) {
          out.push(t.html);
          continue;
        }
        const raw = prevText.slice(t.start, t.end);
        const a = Math.max(0, from - t.start);
        const b = Math.max(0, Math.min(raw.length, to - t.start));
        if (a > 0) out.push(wrapHtml(raw.slice(0, a), t.kind));
        out.push(`<span class="tok-err"${title}>${wrapHtml(raw.slice(a, b), t.kind)}</span>`);
        if (b < raw.length) out.push(wrapHtml(raw.slice(b), t.kind));
      }
      pre.innerHTML = out.join("");
    };

    const countNewlines = (s) => {
      let n = 0;
      for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n += 1;
      return n;
    };

    const buildLineNumbersText = (lines) => {
      const out = new Array(lines);
      for (let i = 0; i < lines; i++) out[i] = String(i + 1);
      return out.join("\n");
    };

    const setGutterLines = (lines, allowIncremental) => {
      if (!gutter) return;
      const next = Math.max(1, Number(lines) | 0);
      if (next === prevLineCount && gutterText) return;

      if (allowIncremental && gutterText) {
        const delta = next - prevLineCount;
        if (delta > 0 && delta <= 16) {
          let t = gutterText;
          for (let i = prevLineCount + 1; i <= next; i++) t += `\n${i}`;
          gutterText = t;
        } else if (delta < 0 && -delta <= 16) {
          let t = gutterText;
          for (let k = 0; k < -delta; k++) {
            const j = t.lastIndexOf("\n");
            if (j < 0) {
              t = "1";
              break;
            }
            t = t.slice(0, j);
          }
          gutterText = t;
        } else {
          gutterText = buildLineNumbersText(next);
        }
      } else {
        gutterText = buildLineNumbersText(next);
      }

      prevLineCount = next;
      gutter.textContent = gutterText;
    };

    const render = () => {
      if (!errorLc) {
        pre.innerHTML = tokens.map((t) => t.html).join("");
        return;
      }
      const range = computeErrorRange(prevText, errorLc);
      if (!range) {
        pre.innerHTML = tokens.map((t) => t.html).join("");
        return;
      }
      renderWithError(range);
    };

    const syncScroll = () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      if (gutter) gutter.scrollTop = ta.scrollTop;
    };

    const fullUpdate = (nextText) => {
      prevText = String(nextText ?? "");
      tokens = lexAll(prevText);
      setGutterLines(1 + countNewlines(prevText), false);
      render();
      syncScroll();
    };

    const partialUpdate = (nextText) => {
      const old = prevText;
      const s = String(nextText ?? "");

      if (s === old) {
        render();
        syncScroll();
        return;
      }

      let start = 0;
      const minLen = Math.min(old.length, s.length);
      while (start < minLen && old[start] === s[start]) start++;
      let endOld = old.length;
      let endNew = s.length;
      while (endOld > start && endNew > start && old[endOld - 1] === s[endNew - 1]) {
        endOld--;
        endNew--;
      }

      const changeOld = endOld - start;
      const changeNew = endNew - start;
      const changeSpan = Math.max(changeOld, changeNew);
      const sizeDelta = Math.abs(s.length - old.length);

      const shouldFull =
        forceFull ||
        lastInputType === "insertFromPaste" ||
        lastInputType === "insertFromDrop" ||
        lastInputType === "historyUndo" ||
        lastInputType === "historyRedo" ||
        sizeDelta > 2048 ||
        changeSpan > 2048 ||
        lastDataLen > 512;

      if (shouldFull) {
        fullUpdate(s);
        return;
      }

      const nlOld = countNewlines(old.slice(start, endOld));
      const nlNew = countNewlines(s.slice(start, endNew));
      if (nlOld !== nlNew) setGutterLines(prevLineCount + (nlNew - nlOld), true);

      let scanStart = Math.max(0, start - 1);
      for (let k = 0; k < 256 && scanStart > 0; k++) {
        const c = s[scanStart - 1];
        if (!c || !isWordChar(c)) break;
        scanStart -= 1;
      }
      if (scanStart > 0 && s[scanStart - 1] === "`") scanStart -= 1;
      let syncNewBase = endNew;
      let syncOldBase = endOld;
      while (syncNewBase < s.length && syncOldBase < old.length && s[syncNewBase] === old[syncOldBase] && isWordChar(s[syncNewBase])) {
        syncNewBase += 1;
        syncOldBase += 1;
      }
      if (syncNewBase < s.length && syncOldBase < old.length && s[syncNewBase] === "`" && old[syncOldBase] === "`") {
        syncNewBase += 1;
        syncOldBase += 1;
      }
      while (syncNewBase < s.length && syncOldBase < old.length && s[syncNewBase] === old[syncOldBase]) {
        const c = s[syncNewBase];
        if (c === " " || c === "\t" || c === "\n" || c === "\r") {
          syncNewBase += 1;
          syncOldBase += 1;
          continue;
        }
        break;
      }
      if (syncNewBase < s.length && syncOldBase < old.length && s[syncNewBase] === "(" && old[syncOldBase] === "(") {
        syncNewBase += 1;
        syncOldBase += 1;
      }
      const r = scanPartial(old, s, tokens, scanStart, syncNewBase, syncOldBase);
      const nextTokens = r.tokens;
      let sane = nextTokens.length > 0 && nextTokens[0].start === 0;
      if (sane) {
        let cur = 0;
        for (const t of nextTokens) {
          if (t.start !== cur || t.end < t.start) {
            sane = false;
            break;
          }
          cur = t.end;
        }
        if (cur !== s.length) sane = false;
      }
      prevText = s;
      if (!sane) {
        fullUpdate(s);
        return;
      }
      tokens = nextTokens;
      render();
      syncScroll();
    };

    const update = () => {
      scheduled = false;
      partialUpdate(String(ta.value || ""));
      forceFull = false;
      lastInputType = "";
      lastDataLen = 0;
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(update);
    };

    ta.addEventListener("scroll", syncScroll);
    ta.addEventListener("beforeinput", (e) => {
      lastInputType = String(e.inputType || "");
      lastDataLen = typeof e.data === "string" ? e.data.length : 0;
      if (lastInputType === "insertFromPaste" || lastInputType === "insertFromDrop" || lastInputType === "historyUndo" || lastInputType === "historyRedo") {
        forceFull = true;
      }
    });
    ta.addEventListener("paste", () => {
      forceFull = true;
      lastInputType = "insertFromPaste";
    });
    ta.addEventListener("drop", () => {
      forceFull = true;
      lastInputType = "insertFromDrop";
    });
    ta.addEventListener("input", () => {
      if (errorLc) errorLc = null;
      schedule();
    });

    fullUpdate(prevText);

    return {
      refresh: () => fullUpdate(String(ta.value || "")),
      setError: (loc) => {
        if (!loc || typeof loc !== "object") return;
        const line = Number(loc.line) | 0;
        const col = Number(loc.col) | 0;
        if (line <= 0 || col <= 0) return;
        const near = typeof loc.near === "string" ? loc.near : "";
        errorLc = { line, col, near, message: loc.message ? String(loc.message) : "" };
        schedule();
      },
      clearError: () => {
        if (!errorLc) return;
        errorLc = null;
        schedule();
      },
    };
  };

  ns.highlight = { attach };
})();
