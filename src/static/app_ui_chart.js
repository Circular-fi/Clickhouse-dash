(() => {
  "use strict";
  // Chart chrome, one component for every page (css/10-components/chart.css).
  // The plot itself is the chart engine (app_chart_core.js) and its
  // legend; this module gives every chart the same card and every trend line
  // the same sparkline.
  //
  //   ui.chartCardHtml({ title, meta, actions, body, legend, className, id,
  //                      tag, titleTag, titleId, metaId, bodyClass, bodyId,
  //                      attrs, bodyAttrs })
  //     <article class="chartCard"><header class="chartCard__head">
  //       <h3 class="chartCard__title"/> <span class="chartCard__meta"/>
  //       <span class="chartCard__actions"/></header>
  //       <div class="chartCard__body"/> [<footer class="chartCard__legend"/>]
  //     title / meta are text; actions, body and legend are trusted HTML.
  //   ui.sparkline.html(values, { max, min, area, alt, className, label })
  //     an SVG polyline (and area) in --sparkline-color, viewBox 100 x 24,
  //     stretched to its box; alt: a second series (errors) in --danger.
  //   ui.sparkline.draw(el, values, options) writes it into el.
  const ns = window.ChDash;
  if (!ns) return;
  const ui = (ns.ui = ns.ui || {});

  const esc = (value) => ns.util.escapeHtml(value ?? "");

  function chartCardHtml({
    title = "", meta = "", actions = "", body = "", legend = "", className = "", id = "", tag = "article",
    titleTag = "h3", titleId = "", metaId = "", bodyClass = "", bodyId = "", attrs = {}, bodyAttrs = {},
  } = {}) {
    const extra = Object.entries(attrs).map(([name, v]) => ` ${name}="${esc(v)}"`).join("");
    const bodyExtra = Object.entries(bodyAttrs).map(([name, v]) => ` ${name}="${esc(v)}"`).join("");
    return `<${tag} class="chartCard${className ? ` ${esc(className)}` : ""}"${id ? ` id="${esc(id)}"` : ""}${extra}>`
      + `<header class="chartCard__head"><${titleTag} class="chartCard__title"${titleId ? ` id="${esc(titleId)}"` : ""}>${esc(title)}</${titleTag}>`
      + `<span class="chartCard__meta"${metaId ? ` id="${esc(metaId)}"` : ""}>${esc(meta)}</span>`
      + (actions ? `<span class="chartCard__actions">${actions}</span>` : "")
      + "</header>"
      + `<div class="chartCard__body${bodyClass ? ` ${esc(bodyClass)}` : ""}"${bodyId ? ` id="${esc(bodyId)}"` : ""}${bodyExtra}>${body}</div>`
      + (legend ? `<footer class="chartCard__legend">${legend}</footer>` : "")
      + `</${tag}>`;
  }

  const W = 100;
  const H = 24;

  // values: numbers (null / NaN: a gap is bridged), evenly spaced; or
  // { xs, values } with xs in any unit.
  function points(values, xs, min, max) {
    const n = values.length;
    if (!n) return "";
    const x0 = xs ? xs[0] : 0;
    const x1 = xs ? xs[n - 1] : n - 1;
    const span = x1 - x0 || 1;
    const range = max - min || 1;
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = Number(values[i]);
      if (!Number.isFinite(v)) continue;
      const x = ((xs ? xs[i] : i) - x0) / span * W;
      const y = H - 1.5 - (Math.max(min, Math.min(max, v)) - min) / range * (H - 3);
      out.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    return out.join(" ");
  }

  function finite(values) {
    return values.map(Number).filter(Number.isFinite);
  }

  function sparklineHtml(values, { xs = null, max = null, min = null, area = false, alt = null, className = "", label = "" } = {}) {
    const list = Array.isArray(values) ? values : [];
    const all = finite(alt ? list.concat(alt) : list);
    const lo = min != null ? Number(min) : Math.min(0, ...all);
    const hi = max != null ? Number(max) : Math.max(lo + 1, ...all);
    const aria = label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"';
    const cls = `sparkline${className ? ` ${esc(className)}` : ""}`;
    if (finite(list).length < 2) return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"${aria}></svg>`;
    const line = points(list, xs, lo, hi);
    const fill = area ? `<polygon class="sparkline__area" points="0,${H} ${line} ${W},${H}"/>` : "";
    const second = alt && finite(alt).some((v) => v > 0) ? `<polyline class="sparkline__line sparkline__line--alt" points="${points(alt, xs, lo, hi)}"/>` : "";
    return `<svg class="${cls}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"${aria}>${fill}<polyline class="sparkline__line" points="${line}"/>${second}</svg>`;
  }

  function drawSparkline(el, values, options = {}) {
    if (!el) return;
    const html = sparklineHtml(values, options);
    if (el.__sparkline !== html) {
      el.__sparkline = html;
      el.innerHTML = html;
    }
  }

  ui.chartCardHtml = chartCardHtml;
  ui.sparkline = Object.freeze({ html: sparklineHtml, draw: drawSparkline });
})();
