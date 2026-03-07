(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  function setText(el, value) {
    if (!el) return;
    el.textContent = value;
  }

  // Set a metric value with a stable unit area (prevents jitter when unit switches, e.g. M <-> B).
  // Renders: <span class="metricCompact__number">123.4</span><span class="metricCompact__unit">MiB/s</span>
  function setMetricText(el, rawValue) {
  if (!el) return;

  const text = String(rawValue ?? "").trim();

  // Sépare nombre + unité (ex: 123.4MB/s, 10k, 1.2B, 15 ms)
  const match = text.match(/^(-?\d+(?:[.,]\d+)?)(.*)$/);

  if (!match) {
    el.textContent = text;
    el.classList.remove("metricCompact__value--split");
    return;
  }

  const number = match[1];
  const unit = (match[2] || "").trim();

  if (!unit) {
    el.textContent = number;
    el.classList.remove("metricCompact__value--split");
    return;
  }

  el.classList.add("metricCompact__value--split");

  // Nettoyage classes précédentes
  const unitClassList = [
    "metricCompact__unit_1",
    "metricCompact__unit_3",
    "metricCompact__unit_4"
  ];

  // Détermine largeur adaptée
  let unitClass = "metricCompact__unit_4";
  if (unit.length <= 1) unitClass = "metricCompact__unit_1";
  else if (unit.length <= 3) unitClass = "metricCompact__unit_3";

  el.innerHTML = `
    <span class="metricCompact__number">${number}</span>
    <span class="metricCompact__unit ${unitClass}">${unit}</span>
  `;
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

  async function copyTextToClipboard(text) {
    const value = String(text ?? "");
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = value;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.left = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }

  function flashButtonText(buttonEl, { copiedText = "Copied", durationMs = 1200 } = {}) {
    if (!buttonEl) return;
    const prev = buttonEl.textContent;
    buttonEl.textContent = copiedText;
    setTimeout(() => {
      buttonEl.textContent = prev;
    }, durationMs);
  }

  function formatInt(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "-";
    return Math.trunc(n).toLocaleString("en-US");
  }

  function formatSeconds(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "-";
    if (n < 1) return `${Math.round(n * 1000)}ms`;
    if (n < 10) return `${n.toFixed(3)}s`;
    return `${n.toFixed(2)}s`;
  }

  function formatBytes(value) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "-";
    const abs = Math.abs(n);
    if (abs < 1024) return `${formatInt(n)}B`;
    const units = ["KB", "MB", "GB", "TB"];
    let v = abs;
    let u = -1;
    while (v >= 1024 && u < units.length - 1) {
      v /= 1024;
      u++;
    }
    const sign = n < 0 ? "-" : "";
    const num = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
    return `${sign}${num}${units[u]}`;
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

  ns.util = {
    setText,
    setMetricText,
    escapeHtml,
    highlightJsonHtml,
    renderPrettyJson,
    copyTextToClipboard,
    flashButtonText,
    formatInt,
    formatSeconds,
    formatBytes,
    replaceTextAreaValue,
    normalizeApiErrorPayload,
    buildApiErrorText,
    buildApiErrorFromResponse,
  };
})();