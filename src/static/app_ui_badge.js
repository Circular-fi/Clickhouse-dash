(() => {
  "use strict";
  // Badges, chips and service swatches, one component for every page
  // (style.css "Components: badge" block).
  //
  //   <span class="badge badge--<tone> [badge--md] [badge--pill]">
  //     sizes   sm (18 px, the default) and md (22 px)
  //     shapes  r4 (the default) and pill
  //     tones   neutral, accent, ok, warn, error, category (--badge-color set
  //             by the caller: a kind, a severity, a series), estimate (an
  //             approximate answer: "sampled x4", "Estimated", "Partial") and
  //             key (ORDER BY, PARTITION, SAMPLE, MATERIALIZED)
  //     solid   .badge--solid: the tone as a fill, the glyph in --panel (error
  //             counts)
  //   Filter chips: .chips holding .chip badges (key, operator, value and a
  //   remove button) and an optional "Clear filters" link.
  //   Service colour: .serviceSwatch, a dot beside inline text, or
  //   .serviceSwatch--bar, a left bar in rows and chips; the colour comes from
  //   --trace-service-color (palette.service) or --swatch.
  //
  // Span status reads one way everywhere: statusLabel() gives "OK", "Error"
  // or "Unset" for StatusCode values, STATUS_CODE_* spellings and the OTLP
  // numbers (0 unset, 1 ok, 2 error).
  const ns = window.ChDash;
  if (!ns) return;

  const esc = (value) => ns.util.escapeHtml(value ?? "");
  const attrsHtml = (attrs) => Object.entries(attrs || {})
    .filter(([, value]) => value != null && value !== false)
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${esc(value)}"`)).join("");

  const TONES = new Set(["neutral", "accent", "ok", "warn", "error", "category", "estimate", "key"]);

  function classes({ tone = "neutral", size = "sm", shape = "r4", solid = false, className = "" } = {}) {
    const t = TONES.has(tone) ? tone : "neutral";
    return ["badge", `badge--${t}`, size === "md" ? "badge--md" : "", shape === "pill" ? "badge--pill" : "", solid ? "badge--solid" : "", className]
      .filter(Boolean).join(" ");
  }

  function styleOf(color, style) {
    const parts = [];
    if (color) parts.push(`--badge-color:${color}`);
    if (style) parts.push(style);
    return parts.join(";");
  }

  // badge.html(text, { tone, size, shape, solid, color, title, className,
  // attrs, tag, swatch }) -> HTML. text is escaped; options.html, when given,
  // is trusted markup used instead. swatch: a service name (palette.service)
  // drawing a left bar.
  function html(text, options = {}) {
    const { color = "", title = "", attrs = {}, tag = "span", swatch = null, style = "" } = options;
    let css = styleOf(color, style);
    let lead = "";
    if (swatch != null && swatch !== "") {
      const swatchColor = ns.palette?.service ? ns.palette.service(String(swatch)) : "";
      if (swatchColor) css = css ? `${css};--trace-service-color:${swatchColor}` : `--trace-service-color:${swatchColor}`;
      lead = '<i class="serviceSwatch serviceSwatch--bar" aria-hidden="true"></i>';
    }
    const body = options.html != null ? options.html : esc(text);
    const type = tag === "button" && !("type" in attrs) ? ' type="button"' : "";
    return `<${tag}${type} class="${esc(classes(options))}"${css ? ` style="${esc(css)}"` : ""}${title ? ` title="${esc(title)}"` : ""}${attrsHtml(attrs)}>${lead}${body}</${tag}>`;
  }

  // The same badge as an element.
  function el(text, options = {}) {
    const holder = document.createElement("div");
    holder.innerHTML = html(text, options);
    return holder.firstElementChild;
  }

  // -------------------------------------------------------------- status

  function statusKey(code) {
    if (code == null || code === "") return "unset";
    if (typeof code === "number") return code === 2 ? "error" : code === 1 ? "ok" : "unset";
    const text = String(code).trim().toLowerCase().replace(/^status_code_/, "");
    if (text === "2" || text === "error" || text === "err") return "error";
    if (text === "1" || text === "ok") return "ok";
    return "unset";
  }

  const STATUS_LABEL = { ok: "OK", error: "Error", unset: "Unset" };
  const STATUS_TONE = { ok: "ok", error: "error", unset: "neutral" };

  const statusLabel = (code) => STATUS_LABEL[statusKey(code)];
  const statusTone = (code) => STATUS_TONE[statusKey(code)];
  const statusHtml = (code, options = {}) => html(statusLabel(code), {
    tone: statusTone(code), ...options, className: `badge--status ${options.className || ""}`.trim(),
    attrs: { "data-status": statusKey(code), ...(options.attrs || {}) },
  });

  // ------------------------------------------------------------ severity

  // A log severity: the palette level (fatal, error, warn, info, debug,
  // trace) colours it through [data-sev] (--sev-color); the text is what the
  // record says (SeverityText), the level name otherwise, in capitals on
  // every page (Logs, trace logs, patterns).
  function severityHtml(level, text = "", options = {}) {
    const name = String(level || "trace");
    return html(String(text || name).toUpperCase(), {
      ...options,
      tone: "category",
      className: `badge--sev ${options.className || ""}`.trim(),
      attrs: { "data-sev": name, ...(options.attrs || {}) },
    });
  }

  // ------------------------------------------------------------ service

  // swatchHtml(name, { bar }) -> the swatch of a service (palette.service).
  function swatchHtml(name, { bar = false, color = "" } = {}) {
    const value = color || (ns.palette?.service ? ns.palette.service(String(name ?? "")) : "");
    return `<i class="serviceSwatch${bar ? " serviceSwatch--bar" : ""}" style="--swatch:${esc(value)}" aria-hidden="true"></i>`;
  }

  // --------------------------------------------------------------- chips

  // chipHtml({ key, op, value, negated, title, remove: { label, attrs },
  //   opAttrs (op is then a toggle button), scope, attrs, html })
  function chipHtml({ key = "", op = "", value = "", negated = false, title = "", remove = null, opAttrs = null, scope = "", attrs = {}, html: inner = null, className = "" } = {}) {
    const parts = [];
    if (inner != null) parts.push(inner);
    else {
      if (scope) parts.push(`<span class="chip__scope">${esc(scope)}</span>`);
      if (key !== "") parts.push(`<span class="chip__key">${esc(key)}</span>`);
      if (op !== "") {
        parts.push(opAttrs
          ? `<button type="button" class="chip__op"${attrsHtml(opAttrs)}>${esc(op)}</button>`
          : `<span class="chip__op">${esc(op)}</span>`);
      }
      if (value !== "") parts.push(`<span class="chip__value">${esc(value)}</span>`);
    }
    if (remove) {
      const label = remove.label || "Remove filter";
      parts.push(`<button type="button" class="chip__remove" aria-label="${esc(label)}" title="${esc(label)}"${attrsHtml(remove.attrs)}>\u00d7</button>`);
    }
    const cls = ["badge", "badge--md", "badge--pill", "badge--accent", "chip", negated ? "is-negated" : "", className].filter(Boolean).join(" ");
    return `<span class="${esc(cls)}" role="listitem"${title ? ` title="${esc(title)}"` : ""}${attrsHtml(attrs)}>${parts.join("")}</span>`;
  }

  function clearHtml(label = "Clear filters", attrs = {}, className = "") {
    return `<button type="button" class="chips__clear${className ? ` ${esc(className)}` : ""}"${attrsHtml(attrs)}>${esc(label)}</button>`;
  }

  ns.badge = Object.freeze({
    html, el, classes, statusKey, statusLabel, statusTone, statusHtml, severityHtml, swatchHtml, chipHtml, clearHtml, TONES: [...TONES],
  });
})();
