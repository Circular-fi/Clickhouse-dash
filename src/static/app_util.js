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

    const prevTop = Number.isFinite(textAreaEl.scrollTop) ? textAreaEl.scrollTop : 0;
    const prevLeft = Number.isFinite(textAreaEl.scrollLeft) ? textAreaEl.scrollLeft : 0;

    const restoreView = () => {
      const maxTop = Math.max(0, textAreaEl.scrollHeight - textAreaEl.clientHeight);
      const maxLeft = Math.max(0, textAreaEl.scrollWidth - textAreaEl.clientWidth);
      textAreaEl.scrollTop = Math.min(Math.max(0, prevTop), maxTop);
      textAreaEl.scrollLeft = Math.min(Math.max(0, prevLeft), maxLeft);
      const end = textAreaEl.value.length;
      try {
        textAreaEl.setSelectionRange(end, end);
      } catch {
        null;
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
      textAreaEl.focus();
      textAreaEl.setSelectionRange(0, before.length);
      const ok = document.execCommand && document.execCommand("insertText", false, v);
      if (ok || String(textAreaEl.value ?? "") !== before) {
        restoreView();
        return;
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
  };
})();