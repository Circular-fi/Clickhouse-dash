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
      "inner",
      "left",
      "right",
      "full",
      "cross",
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

  const getKeywordSet = () => {
    const st = ns.state;
    if (!st || !st.selectedHostId || !st.meta || !st.meta.hosts) return null;
    const hostMeta = st.meta.hosts[String(st.selectedHostId)] || null;
    const kw = hostMeta && hostMeta.keywords ? hostMeta.keywords : null;
    return kw && kw.set instanceof Set ? kw.set : null;
  };

  const tokenizePlain = (text, base) => {
    const s = String(text ?? "");
    const kwSet = getKeywordSet();
    if (!s) return [{ start: base, end: base + s.length, kind: "plain", html: wrapHtml(s, "plain") }];

    const out = [];
    let i = 0;
    let segStart = 0;
    const isWordChar = (c) => {
      const code = c.charCodeAt(0);
      return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "_";
    };
    const isWordStart = (c) => {
      const code = c.charCodeAt(0);
      return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "_";
    };

    const push = (a, b, kind) => {
      if (b <= a) return;
      const raw = s.slice(a, b);
      out.push({ start: base + a, end: base + b, kind, html: wrapHtml(raw, kind) });
    };

    while (i < s.length) {
      const c = s[i];
      if (!isWordStart(c)) {
        i += 1;
        continue;
      }
      let j = i + 1;
      while (j < s.length && isWordChar(s[j])) j += 1;
      const word = s.slice(i, j);
      const isCommon = commonKeywords.has(word.toLowerCase());
      const isKw = isCommon || (kwSet && kwSet.has(word));
      if (isKw) {
        push(segStart, i, "plain");
        push(i, j, "kw");
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

      if (mode === "bq") {
        if (c === "`") {
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
        open("bq", "str", i);
        i += 1;
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

    const canSyncAt = (posNew) => {
      if (posNew < syncNewBase) return false;
      if (mode !== "plain") return false;
      const posPrev = syncPrevBase + (posNew - syncNewBase);
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

      if (mode === "bq") {
        if (c === "`") {
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
        open("bq", "str", i);
        i += 1;
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

    const render = () => {
      pre.innerHTML = tokens.map((t) => t.html).join("");
      if (gutter) {
        const s = prevText;
        let lines = 1;
        for (let i = 0; i < s.length; i++) if (s[i] === "\n") lines += 1;
        let out = "";
        for (let i = 1; i <= lines; i++) out += String(i) + (i === lines ? "" : "\n");
        gutter.textContent = out;
      }
    };

    const syncScroll = () => {
      pre.scrollTop = ta.scrollTop;
      pre.scrollLeft = ta.scrollLeft;
      if (gutter) gutter.scrollTop = ta.scrollTop;
    };

    const fullUpdate = (nextText) => {
      prevText = String(nextText ?? "");
      tokens = lexAll(prevText);
      render();
      syncScroll();
    };

    const partialUpdate = (nextText) => {
      const old = prevText;
      const s = String(nextText ?? "");

      if (s === old) return;

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

      const scanStart = Math.max(0, start - 1);
      const r = scanPartial(old, s, tokens, scanStart, endNew, endOld);
      prevText = s;
      tokens = r.tokens;
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
    ta.addEventListener("input", schedule);

    fullUpdate(prevText);

    return { refresh: () => fullUpdate(String(ta.value || "")) };
  };

  ns.highlight = { attach };
})();
