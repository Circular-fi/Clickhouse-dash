(() => {
  "use strict";
  // Stat tiles, one component for every page (style.css "Components: stat
  // tile" block): an eyebrow label, the value and an optional sub line, in
  // sentence case. The map and graph panels, the Services detail strip, the
  // trace header, the Query metric rail, Explorer About, the Keeper tiles and
  // the pipeline columns draw them.
  //
  //   ui.statTileHtml({ label, value, sub, tone, title, inline, tag, className,
  //                     valueHtml, subHtml, attrs }) -> HTML
  //   ui.statTile(options) -> element
  //   ui.statTilesHtml(tiles, { className, label }) -> the tiles in a .statTiles
  // tone: "error" | "warn" | "ok" colours the value.
  const ns = window.ChDash;
  if (!ns) return;
  const ui = (ns.ui = ns.ui || {});

  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const TONES = { error: "is-error", warn: "is-warn", warning: "is-warn", ok: "is-ok" };

  function statTileHtml({
    label = "", value = "", sub = "", tone = "", title = "", inline = false, tag = "div", className = "",
    valueHtml = null, subHtml = null, labelHtml = null, attrs = {},
  } = {}) {
    const cls = ["statTile", inline ? "statTile--inline" : "", TONES[tone] || "", className].filter(Boolean).join(" ");
    const extra = Object.entries(attrs).map(([name, v]) => ` ${name}="${esc(v)}"`).join("");
    const subPart = subHtml != null ? subHtml : sub !== "" && sub != null ? esc(sub) : "";
    return `<${tag} class="${esc(cls)}"${title ? ` title="${esc(title)}"` : ""}${extra}>`
      + `<span class="statTile__label">${labelHtml != null ? labelHtml : esc(label)}</span>`
      + `<span class="statTile__value">${valueHtml != null ? valueHtml : esc(value)}</span>`
      + (subPart ? `<span class="statTile__sub">${subPart}</span>` : "")
      + `</${tag}>`;
  }

  function statTile(options = {}) {
    const holder = document.createElement("div");
    holder.innerHTML = statTileHtml(options);
    return holder.firstElementChild;
  }

  function statTilesHtml(tiles, { className = "", label = "" } = {}) {
    return `<div class="statTiles${className ? ` ${esc(className)}` : ""}"${label ? ` role="group" aria-label="${esc(label)}"` : ""}>${(tiles || []).filter(Boolean).map(statTileHtml).join("")}</div>`;
  }

  Object.assign(ui, { statTile, statTileHtml, statTilesHtml });
})();
