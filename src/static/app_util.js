(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  function setText(el, value) {
    if (!el) return;
    el.textContent = value;
  }

  // A meta line ("5 rows, 4 columns \u00b7 6 ms \u00b7 read 1.9 MB"): one
  // .metaPart (white-space: nowrap) per " \u00b7 " part, so a narrow window
  // wraps the line between parts, never between a value and its unit. At
  // most `max` parts (three: two separators a line) show; the others go to
  // the element's tooltip (title), joined the same way.
  const META_SEP = " \u00b7 ";
  const META_MAX = 3;
  function setMetaLine(el, value, { max = META_MAX } = {}) {
    if (!el) return;
    const all = String(value ?? "").split(META_SEP).filter((part, index, list) => part || list.length === 1);
    const shown = all.slice(0, max);
    const rest = all.slice(max).join(META_SEP);
    const text = shown.join(META_SEP);
    if (rest) {
      el.title = rest;
      el.dataset.metaRest = "1";
    } else if (el.dataset.metaRest) {
      el.removeAttribute("title");
      delete el.dataset.metaRest;
    }
    if (el.textContent === text && (!text || el.firstElementChild)) return;
    const nodes = [];
    shown.forEach((part, index) => {
      if (index) nodes.push(document.createTextNode(META_SEP));
      const span = document.createElement("span");
      span.className = "metaPart";
      span.textContent = part;
      nodes.push(span);
    });
    el.replaceChildren(...(text ? nodes : []));
  }

  // Keep the compact magnitude (K/M/B/T or Ki/Mi/Gi/Ti) at the exact same
  // typographic size as the numeric value. Only the real unit/rate suffix is
  // split out, e.g. 148.9M/s => [148.9M][/s] and ns.format's "1.7 KB/s" =>
  // [1.7][ KB/s]: the space before a unit is kept (a no-break space, which
  // the flex layout does not collapse), so the text reads as ns.format wrote it.
  function setMetricText(el, rawValue) {
    if (!el) return;

    const text = String(rawValue ?? "").trim();
    const match = text.match(/^(-?\d+(?:[.,]\d+)?)(Ki|Mi|Gi|Ti|K|M|B|T)?(\s*)(.*)$/);

    if (!match) {
      if (el.textContent !== text || el.classList.contains("metricCompact__value--split")) {
        el.classList.remove("metricCompact__value--split");
        el.replaceChildren(document.createTextNode(text));
      }
      return;
    }

    const magnitude = `${match[1]}${match[2] || ""}`;
    const unitText = String(match[4] || "").trim();
    const unit = unitText && match[3] ? `\u00a0${unitText}` : unitText;
    if (!unit) {
      if (el.textContent !== magnitude || el.classList.contains("metricCompact__value--split")) {
        el.classList.remove("metricCompact__value--split");
        el.replaceChildren(document.createTextNode(magnitude));
      }
      return;
    }

    let numberEl = el.firstElementChild;
    let unitEl = numberEl ? numberEl.nextElementSibling : null;
    if (!numberEl || !unitEl || !numberEl.classList.contains("metricCompact__number") ||
        !unitEl.classList.contains("metricCompact__unit")) {
      numberEl = document.createElement("span");
      numberEl.className = "metricCompact__number";
      unitEl = document.createElement("span");
      unitEl.className = "metricCompact__unit";
      el.replaceChildren(numberEl, unitEl);
    }

    el.classList.add("metricCompact__value--split");
    unitEl.className = "metricCompact__unit";
    if (numberEl.textContent !== magnitude) numberEl.textContent = magnitude;
    if (unitEl.textContent !== unit) unitEl.textContent = unit;
  }


  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function highlightJsonHtml(jsonText) {
    const s = escapeHtml(jsonText);
    return s.replace(
      /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
      (m, key, str, bool) => {
        if (key) return `<span class="jKey">${m}</span>`;
        if (str) return `<span class="jStr">${m}</span>`;
        if (bool) return `<span class="jBool">${m}</span>`;
        if (m === "null") return `<span class="jNull">${m}</span>`;
        return `<span class="jNum">${m}</span>`;
      }
    );
  }

  function renderPrettyJson(preEl, value) {
    const pretty = JSON.stringify(value, null, 2);
    preEl.className = "jsonPretty";
    preEl.innerHTML = highlightJsonHtml(pretty);
  }

  // Copying is app_ui_copy.js (ns.ui.copyText): one helper and one feedback.

  // formatInt and formatBytes keep their "-" for a missing value and hand
  // the rest to ns.format (app_format.js, loaded first), which owns the
  // number and byte formats. formatSeconds ("1.234s") is not ns.format's
  // duration and stays as it is.
  const format = ns.format;

  function formatInt(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "-";
    return format.count(Math.trunc(n));
  }

  function formatSeconds(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "-";
    if (n < 1) return `${Math.round(n * 1000)}ms`;
    if (n < 10) return `${n.toFixed(3)}s`;
    return `${n.toFixed(2)}s`;
  }

  // One byte format for the whole app: "0 B", "205 B", "1.7 KB", "10.3 MB"
  // (ns.format.bytes: one decimal from KB up, 1024 base).
  function formatBytes(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "-";
    return format.bytes(n);
  }

  function replaceTextAreaValue(textAreaEl, nextValue) {
    if (!textAreaEl) return;
    const v = String(nextValue ?? "");

    const wasActive = document.activeElement === textAreaEl;
    const isMostlyVisible = (() => {
      try {
        const r = textAreaEl.getBoundingClientRect();
        const vh = window.innerHeight || document.documentElement.clientHeight || 0;
        if (!(vh > 0) || !(r.height > 0)) return false;
        if (r.bottom <= 0 || r.top >= vh) return false;
        const visTop = Math.max(0, r.top);
        const visBottom = Math.min(vh, r.bottom);
        const vis = Math.max(0, visBottom - visTop);
        return vis / r.height >= 0.95;
      } catch {
        return false;
      }
    })();

    const allowFocus = wasActive || isMostlyVisible;

    const prevTop = Number.isFinite(textAreaEl.scrollTop) ? textAreaEl.scrollTop : 0;
    const prevLeft = Number.isFinite(textAreaEl.scrollLeft) ? textAreaEl.scrollLeft : 0;

    const restoreView = () => {
      const maxTop = Math.max(0, textAreaEl.scrollHeight - textAreaEl.clientHeight);
      const maxLeft = Math.max(0, textAreaEl.scrollWidth - textAreaEl.clientWidth);
      textAreaEl.scrollTop = Math.min(Math.max(0, prevTop), maxTop);
      textAreaEl.scrollLeft = Math.min(Math.max(0, prevLeft), maxLeft);
      if (document.activeElement === textAreaEl) {
        const end = textAreaEl.value.length;
        try {
          textAreaEl.setSelectionRange(end, end);
        } catch {
          null;
        }
      }
    };

    const dispatchInputEvent = () => {
      try {
        textAreaEl.dispatchEvent(new Event("input", { bubbles: true }));
      } catch {
        try {
          textAreaEl.dispatchEvent(new Event("input"));
        } catch {
          null;
        }
      }
    };

    try {
      const before = String(textAreaEl.value ?? "");
      if (allowFocus) {
        const winX = window.scrollX;
        const winY = window.scrollY;
        try {
          textAreaEl.focus({ preventScroll: true });
        } catch {
          try {
            textAreaEl.focus();
          } catch {
            null;
          }
        }
        try {
          window.scrollTo(winX, winY);
        } catch {
          null;
        }
        textAreaEl.setSelectionRange(0, before.length);
        const ok = document.execCommand && document.execCommand("insertText", false, v);
        if (ok || String(textAreaEl.value ?? "") !== before) {
          restoreView();
          return;
        }
      }
    } catch {
      null;
    }
    try {
      textAreaEl.setRangeText(v, 0, textAreaEl.value.length, "end");
      restoreView();
      dispatchInputEvent();
    } catch {
      textAreaEl.value = v;
      restoreView();
      dispatchInputEvent();
    }
  }

  function normalizeApiErrorPayload(payload, fallback) {
    const fb = fallback && typeof fallback === "object" ? fallback : {};
    const p = payload && typeof payload === "object" ? payload : null;

    const codeRaw = p && p.error_code != null ? p.error_code : fb.error_code;
    const msgRaw = p && p.message != null ? p.message : fb.message;
    const error_code = String(codeRaw != null ? codeRaw : "http_error");
    const message = String(msgRaw != null ? msgRaw : "Request failed.");

    const out = { error_code, message };

    const idxRaw = p && p.index != null ? p.index : fb.index;
    if (idxRaw != null && Number.isFinite(Number(idxRaw))) out.index = Number(idxRaw) | 0;

    const qidRaw = p && p.query_id != null ? p.query_id : fb.query_id;
    if (typeof qidRaw === "string" && qidRaw) out.query_id = qidRaw;

    const chRaw = p && p.clickhouse && typeof p.clickhouse === "object" ? p.clickhouse : (fb.clickhouse && typeof fb.clickhouse === "object" ? fb.clickhouse : null);
    if (chRaw) {
      const ch = {};
      if (chRaw.code != null && Number.isFinite(Number(chRaw.code))) ch.code = Number(chRaw.code) | 0;
      if (chRaw.position != null && Number.isFinite(Number(chRaw.position))) ch.position = Number(chRaw.position);
      if (chRaw.line != null && Number.isFinite(Number(chRaw.line))) ch.line = Number(chRaw.line) | 0;
      if (chRaw.col != null && Number.isFinite(Number(chRaw.col))) ch.col = Number(chRaw.col) | 0;
      if (typeof chRaw.near === "string" && chRaw.near) ch.near = chRaw.near;
      if (Object.keys(ch).length) out.clickhouse = ch;
    }

    return out;
  }

  function buildApiErrorText(payload, fallbackText) {
    const norm = normalizeApiErrorPayload(payload, { error_code: "http_error", message: fallbackText != null ? String(fallbackText) : "Request failed." });
    const code = String(norm.error_code || "").trim();
    const msg = String(norm.message || "").trim();
    if (!code) return msg;
    if (msg.toLowerCase().startsWith(code.toLowerCase() + ":")) return msg;
    return `${code}: ${msg}`;
  }

  function buildApiErrorFromResponse(responseStatus, payload) {
    const st = Number(responseStatus);
    const msg = Number.isFinite(st) ? `Request failed with status ${st}` : "Request failed.";
    return normalizeApiErrorPayload(payload, { error_code: "http_error", message: msg });
  }

  // --- Timing and superseded requests ------------------------------------------

  // The one delay of typed searches (ns.search.bind) and of other input-driven work.
  const SEARCH_DEBOUNCE_MS = 200;

  // fn after `ms` without another call; .cancel() drops the pending call,
  // .flush() runs it now.
  function debounce(fn, ms = SEARCH_DEBOUNCE_MS) {
    let timer = 0;
    let args = null;
    const run = () => {
      timer = 0;
      const pending = args;
      args = null;
      if (pending) fn(...pending);
    };
    const debounced = (...next) => {
      args = next;
      clearTimeout(timer);
      timer = setTimeout(run, ms);
    };
    debounced.cancel = () => { clearTimeout(timer); timer = 0; args = null; };
    debounced.flush = () => { if (timer) { clearTimeout(timer); run(); } };
    return debounced;
  }

  // fn once on the next animation frame however often it is asked for (the
  // last arguments win); .cancel() drops it.
  function rafOnce(fn) {
    let frame = 0;
    let args = [];
    const scheduled = (...next) => {
      args = next;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        fn(...args);
      });
    };
    scheduled.cancel = () => { if (frame) cancelAnimationFrame(frame); frame = 0; };
    scheduled.pending = () => frame !== 0;
    return scheduled;
  }

  // The latest request for `key` (e.g. "logs.search"): a new one aborts the
  // previous one still in flight (its fetch stops, so does the server work it
  // started) and makes it stale.
  //   const req = util.latest("logs.search");
  //   const data = await api.getLogs("search", params, { signal: req.signal });
  //   if (!req.isCurrent()) return;      // superseded: ignore the answer
  // An aborted request rejects with an AbortError (util.isAbort): check
  // isCurrent() before showing an error.
  const latestByKey = new Map();
  function latest(key) {
    latestByKey.get(key)?.controller.abort();
    const controller = new AbortController();
    const token = {
      controller,
      signal: controller.signal,
      isCurrent: () => latestByKey.get(key) === token,
    };
    latestByKey.set(key, token);
    return token;
  }
  // Abort the request in flight for `key` (a view left, a host changed).
  latest.cancel = (key) => {
    const token = latestByKey.get(key);
    if (!token) return;
    latestByKey.delete(key);
    token.controller.abort();
  };

  // The one way to turn an error into a message for the reader: the server's
  // own sentence, without the "error_code: " prefix of app_api.js's Error text
  // (the code stays on error.code); our sentence for a network failure or an
  // answer that is not JSON; `fallback` when the error says nothing. The
  // Query result alone shows a server error verbatim, code included.
  const ERROR_TEXT = {
    network_error: "The server could not be reached. Check the connection and retry.",
    invalid_api_response: "The server sent an unexpected response. Retry, or reload the page.",
  };
  function errorText(error, fallback = "The request failed.") {
    const code = String(error?.code || error?.payload?.error_code || "");
    if (ERROR_TEXT[code]) return ERROR_TEXT[code];
    let text = String(error?.payload?.message ?? (error instanceof Error ? error.message : error ?? "")).trim();
    // An Error from app_api.js reads "code: message"; a plain one may too.
    if (code && text.toLowerCase().startsWith(`${code.toLowerCase()}:`)) text = text.slice(code.length + 1).trim();
    else if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+: /.test(text)) text = text.replace(/^[a-z][a-z0-9_]*: /, "");
    return text || fallback;
  }

  // A ClickHouse error as the Query result shows it: the sentence without our
  // code prefix ("query_failed: ", "format_failed: "), "Code: 62.",
  // "DB::Exception: ", the "(version ...)" tail and the formatter's
  // "In scope SELECT formatQuery(...) AS query" wrapper. A syntax error reads
  // "Syntax error, line 1 col 8 near FROM" (`where` is the server's
  // { line, col, near } when it sent one), and the parser's long
  // "Expected one of: ..." list comes apart as `expected`, for a toggle.
  //   -> { summary, expected, name }   (name: "SYNTAX_ERROR", or "")
  function queryErrorParts(message, where = null) {
    let text = String(message ?? "").trim();
    text = text.replace(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+:\s*/, "");
    text = text.replace(/^Code:\s*\d+\.\s*/, "").replace(/^(?:DB::)?Exception:\s*/, "");
    text = text.replace(/\s*\(version [^()]*\)\.?\s*$/, "");
    text = text.replace(/:?\s*In scope SELECT formatQuery\([\s\S]*\) AS query\.?\s*$/, "");
    let name = "";
    const named = text.match(/\.?\s*\(([A-Z][A-Z0-9_]+)\)\.?\s*$/);
    if (named) {
      name = named[1];
      text = text.slice(0, named.index).trim();
    }
    let expected = "";
    const list = text.match(/\.?\s*Expected one of:\s*([\s\S]*)$/);
    if (list) {
      expected = list[1].replace(/[.:\s]+$/, "").trim();
      text = text.slice(0, list.index).trim();
    }
    const syntax = text.match(/^Syntax error:\s*failed at position (\d+)(?:\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\))?(?:\s*\(line (\d+), col (\d+)\))?/);
    if (syntax) {
      const line = Number(where?.line) || Number(syntax[3]) || 0;
      const col = Number(where?.col) || Number(syntax[4]) || 0;
      const near = String(where?.near ?? syntax[2] ?? "").trim();
      const at = line > 0 && col > 0 ? `line ${line} col ${col}` : `position ${syntax[1]}`;
      const nearText = !near ? "" : /^end of query$/i.test(near) ? " at the end of the query" : ` near ${near}`;
      text = `Syntax error, ${at}${nearText}`;
    }
    return { summary: text.replace(/\s+$/, "") || "The query failed.", expected, name };
  }

  function isAbort(error) {
    return !!error && (error.name === "AbortError" || error.code === "aborted");
  }

  ns.util = {
    SEARCH_DEBOUNCE_MS,
    debounce,
    rafOnce,
    latest,
    isAbort,
    errorText,
    queryErrorParts,
    setText,
    setMetaLine,
    setMetricText,
    escapeHtml,
    highlightJsonHtml,
    renderPrettyJson,
    formatInt,
    formatSeconds,
    formatBytes,
    replaceTextAreaValue,
    normalizeApiErrorPayload,
    buildApiErrorText,
    buildApiErrorFromResponse,
  };
})();