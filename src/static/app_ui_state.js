(() => {
  "use strict";
  // ns.uiState: the empty, error and loading states of every page (Query,
  // Explorer, Observability). One look (style.css "Components: state"), one
  // type scale, the roles and live behaviour built in. (ns.state is the app
  // state of app_state.js, hence the name.)
  //
  //   empty(container, { title, body, action, actions, compact })   -> element
  //       A centred message in place of content that is not there, always
  //       with a way out when there is one (zoom out, jump to data, clear the
  //       filters). An action is { label, onClick, primary, icon, attrs }.
  //   error(container, { title, body, retry, compact })              -> element
  //       The same block for content that failed to load: role=alert, and
  //       Retry when `retry` (a function, or an action) is given.
  //   loading(container, { label, compact })                         -> element
  //       An inline spinner and a sentence; the container is aria-busy.
  //   block(kind, options)                                            -> element
  //       The same block detached, for views that build nodes.
  //   emptyHtml / errorHtml / loadingHtml(options)                     -> string
  //       The same markup for views that build HTML strings; actions then
  //       carry `attrs` for the view's delegated click handler (no onClick).
  //   banner(container, { message, retry, verbatim, level, inset })
  //       The error strip above a view or a result: a human message and
  //       Retry; role=alert. An empty message hides it. `verbatim` keeps a
  //       server message as sent (the Query result error); level "info" is a
  //       neutral notice (role=status); `inset` boxes it inside a padded view.
  //   busy(el, on, { label })
  //       The one loading convention: is-loading and aria-busy on the
  //       element; a button is also disabled and shows its spinner.
  //   spinnerHtml(extra)                                                -> string
  //   announce(text)
  //       Says a short status sentence through the page's one polite live
  //       region (pages never mark whole panes live).
  const ns = window.ChDash;
  if (!ns) return;

  const esc = (value) => ns.util.escapeHtml(value == null ? "" : String(value));

  const ICONS = {
    zoomOut: '<svg viewBox="0 0 16 16" aria-hidden="true" class="uiState__icon"><circle cx="7" cy="7" r="4.25"/><path d="M5 7h4M10.2 10.2 13.5 13.5"/></svg>',
  };

  const SPINNER = '<span class="uiSpin" aria-hidden="true"></span>';
  const spinnerHtml = (extra = "") => (extra ? `<span class="uiSpin ${esc(extra)}" aria-hidden="true"></span>` : SPINNER);

  function attrsHtml(attrs) {
    if (!attrs) return "";
    return Object.entries(attrs)
      .filter(([, value]) => value !== false && value != null)
      .map(([name, value]) => (value === true || value === "" ? ` ${esc(name)}` : ` ${esc(name)}="${esc(value)}"`))
      .join("");
  }

  function actionHtml(action) {
    if (!action || !action.label) return "";
    const cls = `button button--small uiState__action${action.primary ? " button--primary" : ""}`;
    const icon = action.icon && ICONS[action.icon] ? ICONS[action.icon] : "";
    return `<button type="button" class="${cls}"${attrsHtml(action.attrs)}>${icon}<span>${esc(action.label)}</span></button>`;
  }

  function actionsOf(options) {
    const list = Array.isArray(options.actions) ? options.actions.slice() : [];
    if (options.action) list.unshift(options.action);
    if (options.retry) list.push(typeof options.retry === "function" ? { label: "Retry", onClick: options.retry } : { label: "Retry", ...options.retry });
    return list.filter((action) => action && action.label);
  }

  function blockHtml(kind, options = {}) {
    const title = options.title ? `<strong class="uiState__title">${esc(options.title)}</strong>` : "";
    const body = options.body ? `<p class="uiState__body">${esc(options.body)}</p>` : "";
    const actions = actionsOf(options);
    const buttons = actions.length ? `<div class="uiState__actions">${actions.map(actionHtml).join("")}</div>` : "";
    const cls = `uiState uiState--${kind}${options.compact ? " uiState--compact" : ""}${options.className ? ` ${esc(options.className)}` : ""}`;
    const role = kind === "error" ? ' role="alert"' : kind === "loading" ? ' role="status" aria-busy="true"' : "";
    const lead = kind === "loading" ? SPINNER : "";
    return `<div class="${cls}"${role}${attrsHtml(options.attrs)}>${lead}${title}${body}${buttons}</div>`;
  }

  const emptyHtml = (options) => blockHtml("empty", options);
  const errorHtml = (options) => blockHtml("error", options);
  const loadingHtml = (options = {}) => blockHtml("loading", { ...options, title: "", body: options.label || "Loading\u2026" });

  // Renders into `container` (its content replaced) and wires onClick actions.
  function render(kind, container, options = {}) {
    if (!container) return null;
    container.innerHTML = blockHtml(kind, options);
    const block = container.lastElementChild;
    const actions = actionsOf(options);
    const buttons = block ? block.querySelectorAll(".uiState__action") : [];
    actions.forEach((action, i) => {
      if (typeof action.onClick === "function" && buttons[i]) buttons[i].addEventListener("click", (event) => action.onClick(event));
    });
    if (kind === "loading") container.setAttribute("aria-busy", "true");
    else container.removeAttribute("aria-busy");
    return block;
  }

  const empty = (container, options) => render("empty", container, options);
  const error = (container, options) => render("error", container, options);
  const loading = (container, options) => render("loading", container, options);

  // A detached block, for views that build nodes ("empty", "error" or "loading").
  function block(kind, options = {}) {
    const host = document.createElement("div");
    const el = render(kind, host, kind === "loading" ? { ...options } : options);
    el?.remove();
    return el;
  }

  // --- Banner ---------------------------------------------------------------

  const retries = new WeakMap();

  function onBannerClick(event) {
    const button = event.target instanceof Element ? event.target.closest("[data-ui-banner-retry]") : null;
    const banner = button?.closest(".uiBanner");
    const retry = banner ? retries.get(banner) : null;
    if (!retry) return;
    banner.hidden = true;
    banner.replaceChildren();
    retries.delete(banner);
    retry();
  }

  function banner(container, { message = "", retry = null, verbatim = false, level = "error", inset = false } = {}) {
    if (!container) return null;
    const text = message instanceof Error ? message.message : String(message || "");
    container.classList.add("uiBanner");
    container.classList.toggle("uiBanner--verbatim", !!verbatim);
    container.classList.toggle("uiBanner--inset", !!inset);
    container.classList.toggle("uiBanner--info", level === "info");
    // An error interrupts (alert); a notice (level "info") waits its turn (status).
    container.setAttribute("role", level === "info" ? "status" : "alert");
    if (!container.dataset.uiBanner) {
      container.dataset.uiBanner = "1";
      container.addEventListener("click", onBannerClick);
    }
    container.hidden = !text;
    if (text && typeof retry === "function") retries.set(container, retry);
    else retries.delete(container);
    container.innerHTML = text
      ? `<span class="uiBanner__text">${esc(text)}</span>${retries.has(container) ? '<button type="button" class="button button--small uiBanner__retry" data-ui-banner-retry>Retry</button>' : ""}`
      : "";
    return container;
  }

  // --- Busy -----------------------------------------------------------------

  function busy(el, on, { label = "" } = {}) {
    if (!el) return;
    const active = !!on;
    el.classList.toggle("is-loading", active);
    if (active) el.setAttribute("aria-busy", "true");
    else el.removeAttribute("aria-busy");
    if (el.tagName === "BUTTON") {
      el.disabled = active;
      if (active && !el.querySelector(":scope > .uiSpin")) el.insertAdjacentHTML("afterbegin", SPINNER);
    }
    if (active && label) announce(label);
  }

  // --- Live region ----------------------------------------------------------

  let live = null;
  let liveTimer = 0;
  function announce(text) {
    const message = String(text || "").trim();
    if (!message || !document.body) return;
    if (!live || !live.isConnected) {
      live = document.createElement("div");
      live.id = "uiLiveStatus";
      live.className = "srOnly";
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      document.body.appendChild(live);
    }
    // A repeated sentence is announced again: clear, then write on the next frame.
    live.textContent = "";
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { if (live) live.textContent = message; }, 60);
  }

  ns.uiState = Object.freeze({ empty, error, loading, block, emptyHtml, errorHtml, loadingHtml, banner, busy, spinnerHtml, announce });
})();
