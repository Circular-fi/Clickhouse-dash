(() => {
  "use strict";
  // Icons: one sprite (static/icons.svg, Tabler outline drawings), one helper
  // (css/10-components/icon.css, docs/ui-foundations.md "Icons").
  //
  //   ns.icon(name, { size, label, className })   -> markup
  //   ns.icon.el(name, { size, label, className }) -> an <svg> element
  //   ns.icon.href(name)                           -> the symbol's address
  //
  //   <svg class="icon [icon--sm|icon--lg] [className]" aria-hidden="true">
  //     <use href="<sprite>#i-<name>"/></svg>
  //   size   "sm" 14 px, "md" 16 px (the default), "lg" 18 px
  //   label  an icon that says something on its own (no text beside it, not
  //          inside a labelled button) gets role="img" and aria-label
  //          instead of aria-hidden. An icon-only button keeps its own
  //          aria-label and title and its icon stays aria-hidden.
  //
  // The sprite address comes from the page shell (window.__chdashIconSprite,
  // static/icons.svg?v=<content hash>, under the page's base path).
  const ns = (window.ChDash = window.ChDash || {});

  const SVG_NS = "http://www.w3.org/2000/svg";
  const SIZES = { sm: " icon--sm", md: "", lg: " icon--lg" };
  const esc = (value) => ns.util.escapeHtml(String(value));

  function sprite() {
    if (window.__chdashIconSprite) return window.__chdashIconSprite;
    return window.__chdashUrl ? window.__chdashUrl("static/icons.svg") : "/static/icons.svg";
  }

  const href = (name) => `${sprite()}#i-${name}`;
  const classOf = (opts) => `icon${SIZES[opts.size] || ""}${opts.className ? ` ${opts.className}` : ""}`;

  function icon(name, opts = {}) {
    const a11y = opts.label ? ` role="img" aria-label="${esc(opts.label)}"` : ' aria-hidden="true"';
    return `<svg class="${esc(classOf(opts))}"${a11y}><use href="${esc(href(name))}"/></svg>`;
  }

  icon.el = (name, opts = {}) => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", classOf(opts));
    if (opts.label) {
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", opts.label);
    } else {
      svg.setAttribute("aria-hidden", "true");
    }
    const use = document.createElementNS(SVG_NS, "use");
    use.setAttribute("href", href(name));
    svg.appendChild(use);
    return svg;
  };

  icon.href = href;
  ns.icon = Object.freeze(icon);
})();
