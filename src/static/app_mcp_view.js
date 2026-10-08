(() => {
  "use strict";
  // The views of the MCP integration page (docs/mcp-integration-page.md): the bar under the header
  // (Refresh and New key: the filter bar of Observability and System), the parts of the panel (the
  // endpoint with the state badges, the hosts, the limits, the "Connect a client" help) and the keys table
  // with its states. app_mcp_page.js decides what to show and answers the actions; app_mcp_form.js
  // has the key form and the secret panel. Every node is built with ns.h: no API value reaches markup.
  //
  //   ns.mcpView.renderBar(bar, meta, actions)         the bar's two actions: Refresh and New key
  //   ns.mcpView.renderHead(el, meta, { open })        the parts of an enabled MCP above the keys
  //   ns.mcpView.renderLimits(el, meta)                 the global limits, under the keys
  //   ns.mcpView.renderDisabled(el)                    the HCL extract that turns MCP on
  //   ns.mcpView.renderKeys(el, view, actions)         the keys part: head, note, table or state
  //   ns.mcpView.endpointUrl(meta)                     the full URL of the endpoint (the page's origin)
  //   ns.mcpView.commands(url, name, secret)           { cli, json } to connect a client
  //   ns.mcpView.codeBlock(text, label)                a code block with its copy button
  //   ns.mcpView.clientTabs(url, name, secret, id)     the client snippets as tabs (the help and the secret panel)
  //   ns.mcpView.manageReason(meta)                    why the keys cannot change ("" when they can)
  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
  const { $, $$ } = ns.dom;
  const EMPTY = ns.format.EMPTY;

  // The block that turns MCP on: the one place that names the keys of the config file for the reader.
  const HCL_EXAMPLE = [
    "mcp {",
    "  enabled        = true",
    "  storage_file   = \"/var/lib/chdash/mcp-keys.json\"",
    "  manage_from_ui = true",
    "}",
    "",
    "clickhouse {",
    "  host {",
    "    name    = \"prod\"",
    "    mcp_uri = \"clickhouse://chdash_mcp:<password>@clickhouse:9000\"",
    "  }",
    "}",
  ].join("\n");

  const SOURCE_TITLE = {
    config: "Defined in the config file (a key block of mcp). It is read-only here.",
    ui: "Created on this page. It is stored in the storage file.",
  };
  const STATE_BADGE = { active: ["ok", "Active"], disabled: ["neutral", "Disabled"], expired: ["warn", "Expired"] };

  const badge = (text, tone, title = "") => ns.badge.el(text, { tone, size: "md", title });

  // --- Endpoint, commands ----------------------------------------------------------------

  function endpointUrl(meta) {
    const path = ns.api.resolveUrl(String(meta?.endpointPath || "/mcp").replace(/^\/+/, ""));
    return new URL(path, window.location.origin).href;
  }

  // The commands that connect a client, from the real URL of the endpoint.
  //   cli       Claude Code (a command)
  //   desktop   Claude Desktop (claude_desktop_config.json: the mcp-remote bridge adds the header)
  //   inspector MCP Inspector (the values to enter)
  //   json      a client that reads a JSON file of servers (.mcp.json)
  function commands(url, name, secret) {
    const server = `chdash-${String(name || "key").replace(/[^a-z0-9_-]/gi, "-")}`;
    const cli = `claude mcp add --transport http ${server} ${url} --header "Authorization: Bearer ${secret}"`;
    const json = JSON.stringify({ mcpServers: { [server]: { type: "http", url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
    const desktop = JSON.stringify({ mcpServers: { [server]: { command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"], env: { AUTH_HEADER: `Bearer ${secret}` } } } }, null, 2);
    const inspector = ["npx @modelcontextprotocol/inspector", "", "Transport Type   Streamable HTTP", `URL              ${url}`, "Header name      Authorization", `Header value     Bearer ${secret}`].join("\n");
    return { cli, json, desktop, inspector };
  }

  function codeBlock(text, label) {
    const copy = ns.copy.button(null, () => text, { label: `Copy ${label}`, className: "mcpCode__copy" });
    return h("div", { class: "mcpCode" }, h("pre", { class: "mcpCode__pre" }, h("code", null, text)), copy);
  }

  // The client snippets as tabs (one block at a time keeps the dialog and the help short). It
  // serves the help of the page and the one-time secret panel.
  const CLIENTS = [
    { value: "code", label: "Claude Code", note: "Run this command in a terminal:", key: "cli", copy: "the command" },
    { value: "desktop", label: "Claude Desktop", note: "Add this to claude_desktop_config.json. It needs Node.js: the mcp-remote bridge adds the header.", key: "desktop", copy: "the Claude Desktop settings" },
    { value: "inspector", label: "MCP Inspector", note: "Start the inspector, then enter these values:", key: "inspector", copy: "the Inspector values" },
    { value: "json", label: "JSON", note: "In a client that reads a JSON file of servers (.mcp.json), add this block:", key: "json", copy: "the JSON block" },
  ];

  function clientTabs(url, name, secret, idBase) {
    const set = commands(url, name, secret);
    const group = h("div", { class: "mcpClients__tabs" });
    ns.segmented.render(group, CLIENTS.map((c) => ({ value: c.value, label: c.label })), { attr: "client", value: CLIENTS[0].value, size: "compact", label: "Client" });
    const panels = CLIENTS.map((c) => {
      const panel = h("div", { class: "mcpClients__panel", id: `${idBase}-${c.value}`, dataset: { client: c.value } },
        h("p", { class: "mcpNote" }, c.note), codeBlock(set[c.key], c.copy));
      panel.hidden = c.value !== CLIENTS[0].value;
      return panel;
    });
    const wrap = h("div", { class: "mcpClients" }, group, ...panels);
    ns.segmented.bind(group, { attr: "client", onChange: (value) => { for (const panel of panels) panel.hidden = panel.dataset.client !== value; } });
    return wrap;
  }

  function manageReason(meta) {
    if (!meta || !meta.enabled) return "MCP is off.";
    if (!meta.manageFromUi) return "Keys are read-only: manage_from_ui is false in the config.";
    if (!meta.storageConfigured) return "Keys cannot be created here: mcp.storage_file is not set in the config.";
    return meta.canManage ? "" : "Keys cannot be changed from this page.";
  }

  // --- Formats ---------------------------------------------------------------------------

  const count = (value) => ns.format.count(value);

  function instant(iso, emptyText = EMPTY) {
    const ms = Date.parse(iso || "");
    if (!Number.isFinite(ms)) return h("span", { class: "mcpMuted" }, emptyText);
    return h("time", { datetime: new Date(ms).toISOString(), title: ns.format.timeTitle(ms) }, ns.format.time(ms));
  }

  function limitText(value, unit, zero) {
    if (value === null || value === undefined) return EMPTY;
    if (value === 0 && zero) return zero;
    return unit ? `${count(value)} ${unit}` : count(value);
  }

  // --- Parts -----------------------------------------------------------------------------

  // A part of the panel, the heading pattern of the System page (css/10-components/part.css).
  function part(id, title, { count = null, extra = null, className = "" } = {}, ...body) {
    const titleId = `${id}Title`;
    const section = h("section", { class: `pagePart${className ? ` ${className}` : ""}`, id });
    section.setAttribute("aria-labelledby", titleId);
    section.append(
      h("div", { class: "pagePart__head" }, h("h2", { class: "pagePart__title", id: titleId }, title), count == null ? null : h("span", { class: "pagePart__count" }, String(count)), extra),
      h("div", { class: "pagePart__body" }, ...body),
    );
    return section;
  }

  function healthBadge(healthy) {
    if (healthy === true) return ns.badge.el("healthy", { tone: "ok" });
    if (healthy === false) return ns.badge.el("down", { tone: "error" });
    return ns.badge.el("unknown", { tone: "neutral" });
  }

  function hostsBlock(meta) {
    if (!meta.hosts.length) {
      return part("mcpHosts", "Hosts", { count: 0 }, h("p", { class: "mcpNote" }, "No host has an mcp_uri in the config. A key cannot read data until one has."));
    }
    // The label column shows only when a host has a label of its own.
    const labelled = meta.hosts.some((host) => host.label && host.label !== host.name);
    const head = h("tr", null, (labelled ? ["Host", "Label", "Health"] : ["Host", "Health"]).map((name) => h("th", { scope: "col" }, name)));
    const rows = meta.hosts.map((host) => h("tr", { dataset: { host: host.name } },
      h("td", { class: "mcpHosts__name" }, host.name),
      labelled ? h("td", { class: "mcpHosts__label" }, host.label && host.label !== host.name ? host.label : EMPTY) : null,
      h("td", null, healthBadge(host.healthy))));
    const table = h("table", { class: "dataTable dataTable--compact mcpHosts", "aria-label": "Hosts with an mcp_uri" }, h("thead", null, head), h("tbody", null, rows));
    return part("mcpHosts", "Hosts", { count: meta.hosts.length }, h("div", { class: "dataTableWrap" }, table));
  }

  function limitsBlock(meta) {
    const l = meta.limits;
    const tiles = [
      { label: "Rows per result", value: limitText(l.maxRows) },
      { label: "Timeout", value: limitText(l.queryTimeoutSeconds, "s") },
      { label: "Result size", value: l.maxResultBytes == null ? EMPTY : ns.format.bytes(l.maxResultBytes) },
      { label: "SQL size", value: l.maxSqlBytes == null ? EMPTY : ns.format.bytes(l.maxSqlBytes) },
      { label: "Memory per query", value: l.maxMemoryBytes == null ? EMPTY : ns.format.bytes(l.maxMemoryBytes) },
      { label: "Rows read", value: limitText(l.maxRowsToRead, "", "No limit") },
      { label: "Requests per minute", value: limitText(l.rateLimitPerMinute, "", "Unlimited") },
    ];
    return part("mcpLimits", "Global limits", {},
      h.html(ns.ui.statTilesHtml(tiles, { className: "statTiles--boxed mcpTiles", label: "Global limits" })),
      h("p", { class: "mcpNote" }, "A key can lower the rows and the timeout. It never raises them. The request limit counts for each key."));
  }

  // The status of MCP: three badges beside the title of the endpoint part.
  function statusBadges(meta) {
    const badges = h("div", { class: "mcpBadges" });
    badges.setAttribute("role", "list");
    const add = (node) => { node.setAttribute("role", "listitem"); badges.appendChild(node); };
    add(badge("MCP enabled", "ok"));
    add(meta.storageConfigured ? badge("Storage configured", "ok", "mcp.storage_file is set: keys created here survive a restart.") : badge("No storage file", "warn", "mcp.storage_file is not set: keys cannot be created here."));
    add(meta.manageFromUi ? badge("Managed from the UI", "accent", "manage_from_ui is true: this page can change the keys.") : badge("Read-only", "neutral", "manage_from_ui is false: this page cannot change the keys."));
    return badges;
  }

  function endpointBlock(meta, url, ...more) {
    const field = h("div", { class: "uiField mcpEndpoint" },
      h("label", { class: "uiField__label", for: "mcpEndpointUrl" }, "Endpoint URL"),
      h("div", { class: "uiField__row" },
        h("input", { id: "mcpEndpointUrl", class: "uiInput uiInput--mono", type: "text", readonly: true, value: url, spellcheck: "false", autocomplete: "off" }),
        ns.copy.button(null, () => url, { label: "Copy the endpoint URL", className: "mcpEndpoint__copy" })),
      h("div", { class: "uiField__hint" }, "A client sends the secret of a key as a Bearer token."));
    return part("mcpEndpoint", "Endpoint", { extra: statusBadges(meta) }, field, ...more);
  }

  function helpBlock(meta, url, open) {
    const details = h("details", { class: "mcpHelp", id: "mcpHelp", open: open || null });
    details.appendChild(h("summary", { class: "mcpHelp__summary" }, "Connect a client"));
    const body = h("div", { class: "mcpHelp__body" });
    body.append(
      h("p", { class: "mcpNote" }, "Create a key with New key. ChDash shows its secret once. Then pick your client and replace <secret> with that secret."),
      clientTabs(url, "name", "<secret>", "mcpHelpClient"),
      h("p", { class: "mcpNote" }, `The client sends the secret as a Bearer token. ChDash speaks the protocol versions ${meta.protocolVersions.join(", ") || EMPTY}. Serve ChDash over HTTPS when a client runs on another machine.`),
    );
    details.appendChild(body);
    return details;
  }

  // The parts above the keys: the endpoint (and how to connect a client) beside the hosts.
  function renderHead(container, meta, { open = false } = {}) {
    const url = endpointUrl(meta);
    const endpoint = endpointBlock(meta, url, helpBlock(meta, url, open));
    container.replaceChildren(h("div", { class: "mcpFacts" }, endpoint, hostsBlock(meta)));
  }

  // The global limits stand under the keys: the keys are the work of the page, the limits are its reference.
  function renderLimits(container, meta) {
    container.replaceChildren(limitsBlock(meta));
    container.hidden = false;
  }

  // The bar under the header: Refresh and New key at the right end, as the other pages end their
  // bar with Refresh or Search. The bar comes from ns.filterBar.create (the page builds it once);
  // its submit is Refresh.
  function renderBar(bar, meta, actions) {
    const reason = manageReason(meta);
    bar.actions.replaceChildren();
    const refresh = bar.iconAction({ id: "mcpRefresh", label: "Refresh" });
    const create = h("button", {
      type: "button",
      class: "button button--primary obsFilterBar__submit traceSearchSubmit",
      id: "mcpNewKey",
      title: reason || "Create a key",
      disabled: reason ? true : null,
      "aria-describedby": reason ? "mcpKeysNote" : null,
    }, ns.icon.el("plus", { size: "sm" }), h("span", null, "New key"));
    if (!reason) create.addEventListener("click", () => actions.onCreate(create));
    bar.actions.appendChild(create);
    bar.onSubmit = () => actions.onRefresh(refresh);
    bar.form.hidden = false;
  }

  // MCP off ({ enabled: false }): what to add to the config. The page is still a page of its own.
  function renderDisabled(container) {
    const wrap = part("mcpOff", "Turn MCP on", { extra: badge("MCP is off", "neutral"), className: "mcpOff" },
      h("p", { class: "mcpNote" }, "MCP lets an AI client read your ClickHouse data through ChDash. It is off now. Add this to the config file, then restart ChDash:"),
      codeBlock(HCL_EXAMPLE, "the HCL block"),
      h("p", { class: "mcpNote" }, "Set mcp_uri on each host that MCP can read. It names a separate ClickHouse user with SELECT and SHOW grants only. Without storage_file, keys come from key blocks of the config only."),
    );
    container.replaceChildren(wrap);
  }

  // --- Keys ------------------------------------------------------------------------------

  const ICON_BUTTONS = {
    edit: { icon: "pencil", label: "Edit" },
    toggle: { icon: "ban", label: "Disable" },
    rotate: { icon: "arrows-exchange", label: "Rotate" },
    remove: { icon: "trash", label: "Delete" },
  };

  function actionButton(kind, key, disabledTitle, onClick) {
    const spec = ICON_BUTTONS[kind];
    const label = kind === "toggle" ? (key.enabled ? "Disable" : "Enable") : spec.label;
    const icon = kind === "toggle" && !key.enabled ? "check" : spec.icon;
    const title = disabledTitle || `${label} ${key.name}`;
    const button = h("button", {
      type: "button",
      class: `button button--small mcpAction${kind === "remove" ? " mcpAction--danger" : ""}`,
      dataset: { action: kind },
      title,
      "aria-label": `${label} ${key.name}`,
      disabled: !!disabledTitle || null,
    }, ns.icon.el(icon, { size: "sm" }), h("span", { class: "mcpAction__label" }, label));
    // A disabled button keeps its reason in its title, which a screen reader reads as its description.
    if (!disabledTitle) button.addEventListener("click", () => onClick(key, button));
    return button;
  }

  function listText(values, allText, noneText) {
    if (!values.length) return noneText;
    return values.includes("*") ? allText : values.join(", ");
  }

  // "All hosts" and "None" are words; names and patterns are code.
  function scopeCell(key, meta) {
    const dl = h("dl", { class: "mcpScope" });
    const line = (label, values, allText, noneText) => {
      const words = !values.length || values.includes("*");
      dl.append(h("dt", null, label), h("dd", words ? null : { class: "mcpScope__mono" }, listText(values, allText, noneText)));
    };
    line("Hosts", key.hosts, "All hosts", "None");
    const tools = key.tools.includes("*") ? "All tools" : key.tools.length ? `${key.tools.length} ${key.tools.length === 1 ? "tool" : "tools"}: ${key.tools.join(", ")}` : "None";
    dl.append(h("dt", null, "Tools"), h("dd", key.tools.length && !key.tools.includes("*") ? { class: "mcpScope__tools", title: key.tools.join(", ") } : null, tools));
    line("Data", key.databases, "All data", "None");
    return dl;
  }

  // A value the key sets itself reads at full strength; the global limit that it inherits reads muted.
  function limitsCell(key, meta) {
    const l = meta.limits || {};
    const fmt = (own, global, unit) => (own != null
      ? h("span", null, `${count(own)}${unit}`)
      : global != null ? h("span", { class: "mcpMuted", title: "The global limit: this key sets none of its own." }, `${count(global)}${unit}`, h("span", { class: "srOnly" }, " (default)")) : EMPTY);
    const dl = h("dl", { class: "mcpScope" });
    dl.append(h("dt", null, "Rows"), h("dd", null, fmt(key.maxRows, l.maxRows, "")), h("dt", null, "Timeout"), h("dd", null, fmt(key.timeoutSeconds, l.queryTimeoutSeconds, " s")));
    return dl;
  }

  // An expiry is a day (the form ends it at 23:59:59 UTC): the table shows the UTC date, the tooltip the instant.
  function expiry(iso) {
    const ms = Date.parse(iso || "");
    if (!Number.isFinite(ms)) return h("span", { class: "mcpMuted" }, "Never");
    return h("time", { class: "mcpDate", datetime: new Date(ms).toISOString(), title: `${ns.format.timeTitle(ms)} (UTC end of day for a key made here)` }, new Date(ms).toISOString().slice(0, 10));
  }

  function keyRow(key, meta, actions, reason) {
    const readOnly = key.source === "config";
    const lock = readOnly ? "Read-only: this key comes from the config file. Change it there." : reason;
    const [tone, stateLabel] = STATE_BADGE[key.state] || STATE_BADGE.active;
    const nameCell = h("td", { class: "mcpCell--name" });
    nameCell.setAttribute("role", "cell");
    nameCell.dataset.label = "Name";
    nameCell.append(h("strong", { class: "mcpKeyName" }, key.name));
    if (key.secretHint) nameCell.appendChild(h("span", { class: "mcpMuted mcpHint" }, `${key.secretHint}\u2026`));
    if (key.description) nameCell.appendChild(h("span", { class: "mcpMuted mcpDesc" }, key.description));
    const cell = (label, cls, ...children) => {
      const td = h("td", cls ? { class: cls } : null, ...children);
      td.setAttribute("role", "cell");
      td.dataset.label = label;
      return td;
    };
    // A key that cannot change shows one line of text, not four buttons that do nothing.
    const actionsCell = cell("Actions", "mcpCell--actions", lock
      ? h("span", { class: "mcpLocked", title: lock }, ns.icon.el("lock", { size: "sm" }), h("span", null, readOnly ? "Config file" : "Read-only"))
      : h("div", { class: "mcpActions" },
        actionButton("edit", key, "", actions.onEdit),
        actionButton("toggle", key, "", actions.onToggle),
        actionButton("rotate", key, "", actions.onRotate),
        actionButton("remove", key, "", actions.onDelete)));
    const row = h("tr", { role: "row", dataset: { keyId: key.id, state: key.state, source: key.source, find: `${key.name} ${key.description || ""} ${key.state} ${key.source}`.toLowerCase() } },
      nameCell,
      cell("Source", "mcpCell--source", ns.badge.el(readOnly ? "config" : "ui", { tone: readOnly ? "neutral" : "accent", title: SOURCE_TITLE[key.source] })),
      cell("Scope", "mcpCell--wrap mcpCell--scope", scopeCell(key, meta)),
      cell("Limits", "mcpCell--wrap mcpCell--limits", limitsCell(key, meta)),
      cell("Expires", "mcpCell--when", expiry(key.expiresAt)),
      cell("Last used", "mcpCell--when", instant(key.lastUsedAt, "Never")),
      cell("State", "mcpCell--state", ns.badge.el(stateLabel, { tone })),
      actionsCell);
    return row;
  }

  function keysTable(keys, meta, actions) {
    const reason = manageReason(meta);
    const head = h("tr", null, ...["Name", "Source", "Scope", "Limits", "Expires", "Last used", "State", "Actions"].map((name) => {
      const th = h("th", name === "Actions" ? { class: "mcpCell--actions" } : null, name === "Actions" ? h("span", { class: "srOnly" }, name) : name);
      th.setAttribute("scope", "col");
      th.setAttribute("role", "columnheader");
      return th;
    }));
    head.setAttribute("role", "row");
    // Roles are written out: a phone draws each row as a card and the browser would drop the table.
    const table = h("table", { class: "dataTable dataTable--compact mcpTable" }, h("thead", { role: "rowgroup" }, head), h("tbody", { role: "rowgroup" }, ...keys.map((key) => keyRow(key, meta, actions, reason))));
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", "Access keys");
    const wrap = h("div", { class: "dataTableWrap mcpTableWrap" }, table);
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Access keys, scroll sideways when the table is wider than the page");
    wrap.tabIndex = 0;
    return wrap;
  }

  // A long list gets a filter (name, description, state, source). The text stays between redraws.
  const FILTER_FROM = 10;
  let filterText = "";

  function applyFilter(container) {
    const rows = [...$$("tr[data-key-id]", container)];
    const needle = filterText.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const match = !needle || row.dataset.find.includes(needle);
      row.hidden = !match;
      if (match) shown += 1;
    }
    const countEl = $(".pagePart__count", container);
    if (countEl) countEl.textContent = needle ? `${shown} of ${rows.length}` : String(rows.length);
    const none = $(".mcpKeys__none", container);
    if (none) none.hidden = shown > 0 || !rows.length;
  }

  // view: { status: "loading" | "error" | "ready", keys, meta, error }
  // actions: { onCreate, onEdit(key), onToggle(key), onRotate(key), onDelete(key), onRefresh, onRetry }
  function renderKeys(container, view, actions) {
    const { meta, keys = [] } = view;
    const reason = manageReason(meta);
    const filter = keys.length >= FILTER_FROM && view.status === "ready"
      ? h("input", { class: "uiInput mcpKeys__filter", type: "search", id: "mcpKeysFilter", placeholder: "Filter keys", "aria-label": "Filter the keys by name, description, state or source", autocomplete: "off", spellcheck: "false", value: filterText })
      : null;
    const head = h("div", { class: "pagePart__head" },
      h("h2", { class: "pagePart__title", id: "mcpKeysTitle" }, "Access keys"),
      view.status === "ready" ? h("span", { class: "pagePart__count" }, String(keys.length)) : null,
      filter);
    // The note under the head says why the keys cannot change (New key points to it).
    const note = h("div", { class: "mcpKeys__note" });
    note.id = "mcpKeysNote";
    if (reason) ns.uiState.banner(note, { message: reason, level: "info", inset: true });
    else note.hidden = true;
    // The error of an action (the controller fills it).
    const alert = h("div", { class: "mcpKeys__alert" });
    alert.id = "mcpAlert";
    alert.hidden = true;
    const body = h("div", { class: "pagePart__body mcpKeys__body" });
    body.id = "mcpKeysBody";
    if (view.status === "loading") ns.uiState.loading(body, { label: "Loading the keys\u2026" });
    else if (view.status === "error") ns.uiState.error(body, { title: "Could not load the keys", body: ns.util.errorText(view.error), retry: actions.onRetry });
    else if (!keys.length) {
      ns.uiState.empty(body, {
        title: "No access keys yet",
        body: reason ? "Keys defined in the config file will show here." : "Create a key to let an AI client read your data through MCP. Open Connect a client above for the commands.",
        action: reason ? null : { label: "New key", primary: true, onClick: () => actions.onCreate(ns.dom.byId("mcpNewKey")) },
      });
    } else {
      body.appendChild(keysTable(keys, meta, actions));
      body.appendChild(h("p", { class: "mcpNote mcpKeys__none", hidden: true }, "No key matches this filter."));
      const config = keys.some((key) => key.source === "config");
      body.appendChild(h("p", { class: "mcpNote mcpKeys__hint" }, `A muted limit is the global limit: the key sets none of its own.${config ? " A key with the source config comes from the config file. It is read-only here: change it in the file and restart ChDash." : ""}`));
    }
    container.replaceChildren(head, note, alert, body);
    if (filter) {
      filter.addEventListener("input", () => { filterText = filter.value; applyFilter(container); });
      applyFilter(container);
    }
  }

  ns.mcpView = Object.freeze({ renderBar, renderHead, renderLimits, renderDisabled, renderKeys, endpointUrl, commands, codeBlock, clientTabs, manageReason, HCL_EXAMPLE });
})();
