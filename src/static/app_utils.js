(() => {
  "use strict";

  const ns = window.ChDash;
  if (!ns) return;

  function setText(el, value) {
    if (!el) return;
    el.textContent = value;
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

  ns.util = { setText, escapeHtml, highlightJsonHtml, renderPrettyJson, copyTextToClipboard, flashButtonText };
})();