(() => {
  "use strict";
  // The views of the MCP integration page (docs/mcp-integration-page.md): the header block (the
  // endpoint, the state badges, the hosts, the limits and the "Connect a client" help), the keys
  // table and its states. app_mcp_page.js decides what to show and answers the actions; app_mcp_form.js
  // has the key form and the secret panel. Every node is built with ns.h: no API value reaches markup.
  //
  //   ns.mcpView.renderHead(el, meta, { open })        the header block of an enabled MCP
  //   ns.mcpView.renderDisabled(el)                    the HCL extract that turns MCP on
  //   ns.mcpView.renderKeys(el, view, actions)         the keys section: head, note, table or state
  //   ns.mcpView.endpointUrl(meta)                     the full URL of the endpoint (the page's origin)
  //   ns.mcpView.commands(url, name, secret)           { cli, json } to connect a client
  //   ns.mcpView.codeBlock(text, label)                a code block with its copy button
  //   ns.mcpView.manageReason(meta)                    why the keys cannot change ("" when they can)
  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
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
    "    mcp_uri = \"clickhouse://chdash_mcp@clickhouse:9000\"",
    "    mcp_password_file = \"/run/secrets/chdash_mcp_password\"",
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
  function commands(url, name, secret) {
    const server = `chdash-${String(name || "key").replace(/[^a-z0-9_-]/gi, "-")}`;
    const cli = `claude mcp add --transport http ${server} ${url} --header "Authorization: Bearer ${secret}"`;
    const json = JSON.stringify({ mcpServers: { [server]: { type: "http", url, headers: { Authorization: `Bearer ${secret}` } } } }, null, 2);
    return { cli, json };
  }

  function codeBlock(text, label) {
    const copy = ns.copy.button(null, () => text, { label: `Copy ${label}`, className: "mcpCode__copy" });
    return h("div", { class: "mcpCode" }, h("pre", { class: "mcpCode__pre" }, h("code", null, text)), copy);
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

  // --- Header block ----------------------------------------------------------------------

  function healthBadge(healthy) {
    if (healthy === true) return badge("healthy", "ok");
    if (healthy === false) return badge("down", "error");
    return badge("unknown", "neutral");
  }

  function hostsBlock(meta) {
    const section = h("section", { class: "mcpPart" });
    section.setAttribute("aria-labelledby", "mcpHostsTitle");
    section.appendChild(h("h2", { class: "mcpPart__title", id: "mcpHostsTitle" }, "Hosts", h("span", { class: "mcpPart__count" }, String(meta.hosts.length))));
    if (!meta.hosts.length) {
      section.appendChild(h("p", { class: "mcpNote" }, "No host has an mcp_uri in the config. A key cannot read data until one has."));
      return section;
    }
    const list = h("ul", { class: "mcpHosts" });
    for (const host of meta.hosts) {
      const item = h("li", { class: "mcpHosts__item" }, h("span", { class: "mcpHosts__name" }, host.name));
      if (host.label && host.label !== host.name) item.appendChild(h("span", { class: "mcpMuted mcpHosts__label" }, host.label));
      item.appendChild(healthBadge(host.healthy));
      list.appendChild(item);
    }
    section.appendChild(list);
    return section;
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
      { label: "Requests per minute", value: limitText(l.rateLimitPerMinute, "", "Unlimited"), sub: "per key" },
    ];
    const section = h("section", { class: "mcpPart" });
    section.setAttribute("aria-labelledby", "mcpLimitsTitle");
    section.appendChild(h("h2", { class: "mcpPart__title", id: "mcpLimitsTitle" }, "Limits"));
    section.appendChild(h.html(ns.ui.statTilesHtml(tiles, { className: "mcpTiles", label: "Global limits" })));
    section.appendChild(h("p", { class: "mcpNote" }, "A key can lower the rows and the timeout. It never raises them."));
    return section;
  }

  function helpBlock(meta, url, open) {
    const generic = commands(url, "name", "<secret>");
    const details = h("details", { class: "mcpHelp", id: "mcpHelp", open: open || null });
    details.appendChild(h("summary", { class: "mcpHelp__summary" }, "Connect a client"));
    const body = h("div", { class: "mcpHelp__body" });
    body.append(
      h("ol", { class: "mcpHelp__steps" },
        h("li", null, "Create a key with New key. ChDash shows its secret once: copy it then."),
        h("li", null, "Add the endpoint to the client. In Claude Code, run this command:"),
      ),
      codeBlock(generic.cli, "the command"),
      h("p", { class: "mcpNote" }, "In a client that reads a JSON file of servers, add this block:"),
      codeBlock(generic.json, "the JSON block"),
      h("p", { class: "mcpNote" }, `Replace <secret> with the secret of the key. The client sends it as a Bearer token. ChDash speaks the protocol versions ${meta.protocolVersions.join(", ") || EMPTY}.`),
      h("p", { class: "mcpNote" }, "Serve ChDash over HTTPS when a client runs on another machine."),
    );
    details.appendChild(body);
    return details;
  }

  function renderHead(container, meta, { open = false } = {}) {
    const url = endpointUrl(meta);
    const badges = h("div", { class: "mcpBadges" });
    badges.setAttribute("role", "list");
    const add = (node) => { node.setAttribute("role", "listitem"); badges.appendChild(node); };
    add(badge("MCP enabled", "ok"));
    add(meta.storageConfigured ? badge("Storage configured", "ok", "mcp.storage_file is set: keys created here survive a restart.") : badge("No storage file", "warn", "mcp.storage_file is not set: keys cannot be created here."));
    add(meta.manageFromUi ? badge("Managed from the UI", "accent", "manage_from_ui is true: this page can change the keys.") : badge("Read-only", "neutral", "manage_from_ui is false: this page cannot change the keys."));

    const endpoint = h("div", { class: "mcpEndpoint" });
    endpoint.append(
      h("label", { class: "mcpLabel", for: "mcpEndpointUrl" }, "Endpoint URL"),
      h("div", { class: "mcpEndpoint__row" },
        h("input", { id: "mcpEndpointUrl", class: "mcpInput mcpInput--mono", type: "text", readonly: true, value: url, spellcheck: "false", autocomplete: "off" }),
        ns.copy.button(null, () => url, { label: "Copy the endpoint URL", className: "mcpEndpoint__copy" })),
    );
    container.replaceChildren(badges, endpoint, h("div", { class: "mcpFacts" }, hostsBlock(meta), limitsBlock(meta)), helpBlock(meta, url, open));
  }

  // MCP off ({ enabled: false }): what to add to the config. The page is still a page of its own.
  function renderDisabled(container) {
    const wrap = h("section", { class: "mcpOff" });
    wrap.setAttribute("aria-labelledby", "mcpOffTitle");
    wrap.append(
      h("div", { class: "mcpBadges" }, badge("MCP is off", "neutral")),
      h("h2", { class: "mcpPart__title", id: "mcpOffTitle" }, "Turn MCP on"),
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
    rotate: { icon: "refresh", label: "Rotate" },
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

  function scopeCell(key, meta) {
    const dl = h("dl", { class: "mcpScope" });
    const line = (label, value, mono) => dl.append(h("dt", null, label), h("dd", mono ? { class: "mcpScope__mono" } : null, value));
    line("Hosts", listText(key.hosts, "All hosts", "None"), false);
    const tools = key.tools.includes("*") ? "All tools" : key.tools.length ? `${key.tools.length} ${key.tools.length === 1 ? "tool" : "tools"}: ${key.tools.join(", ")}` : "None";
    line("Tools", tools, false);
    line("Data", listText(key.databases, "All data", "None"), true);
    return dl;
  }

  function limitsCell(key, meta) {
    const l = meta.limits || {};
    const fmt = (own, global, unit) => (own != null ? `${count(own)}${unit}` : global != null ? `${count(global)}${unit} (default)` : EMPTY);
    const dl = h("dl", { class: "mcpScope" });
    dl.append(h("dt", null, "Rows"), h("dd", null, fmt(key.maxRows, l.maxRows, "")), h("dt", null, "Timeout"), h("dd", null, fmt(key.timeoutSeconds, l.queryTimeoutSeconds, " s")));
    return dl;
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
    const actionsCell = cell("Actions", "mcpCell--actions",
      h("div", { class: "mcpActions" },
        actionButton("edit", key, lock, actions.onEdit),
        actionButton("toggle", key, lock, actions.onToggle),
        actionButton("rotate", key, lock, actions.onRotate),
        actionButton("remove", key, lock, actions.onDelete)));
    const row = h("tr", { role: "row", dataset: { keyId: key.id, state: key.state, source: key.source } },
      nameCell,
      cell("Source", null, ns.badge.el(readOnly ? "config" : "ui", { tone: readOnly ? "neutral" : "accent", title: SOURCE_TITLE[key.source] })),
      cell("Scope", "mcpCell--wrap", scopeCell(key, meta)),
      cell("Limits", "mcpCell--wrap", limitsCell(key, meta)),
      cell("Expires", null, instant(key.expiresAt, "Never")),
      cell("Last used", null, instant(key.lastUsedAt, "Never")),
      cell("State", null, badge(stateLabel, tone)),
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
    const table = h("table", { class: "dataTable mcpTable" }, h("thead", { role: "rowgroup" }, head), h("tbody", { role: "rowgroup" }, ...keys.map((key) => keyRow(key, meta, actions, reason))));
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", "Access keys");
    const wrap = h("div", { class: "mcpTableWrap" }, table);
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Access keys, scroll sideways when the table is wider than the page");
    wrap.tabIndex = 0;
    return wrap;
  }

  function skeleton() {
    const box = h("div", { class: "mcpSkeleton" });
    box.setAttribute("role", "status");
    box.setAttribute("aria-busy", "true");
    box.appendChild(h("span", { class: "srOnly" }, "Loading the keys\u2026"));
    for (let i = 0; i < 3; i += 1) box.appendChild(h("i", { class: "mcpSkeleton__row", "aria-hidden": "true" }));
    return box;
  }

  // view: { status: "loading" | "error" | "ready", keys, meta, error }
  // actions: { onCreate, onEdit(key), onToggle(key), onRotate(key), onDelete(key), onRefresh, onRetry }
  function renderKeys(container, view, actions) {
    const { meta, keys = [] } = view;
    const reason = manageReason(meta);
    const create = h("button", { type: "button", class: "button button--primary", id: "mcpNewKey", title: reason || "Create a key", disabled: reason ? true : null, "aria-describedby": reason ? "mcpKeysNote" : null },
      ns.icon.el("plus", { size: "sm" }), h("span", null, "New key"));
    if (!reason) create.addEventListener("click", () => actions.onCreate(create));
    const refresh = h("button", { type: "button", class: "button", id: "mcpRefresh", title: "Reload the keys", "aria-label": "Reload the keys" }, ns.icon.el("refresh", { size: "sm" }), h("span", null, "Refresh"));
    refresh.addEventListener("click", () => actions.onRefresh(refresh));
    const title = h("h2", { class: "mcpPart__title", id: "mcpKeysTitle" }, "Access keys", view.status === "ready" ? h("span", { class: "mcpPart__count" }, String(keys.length)) : null);
    const head = h("div", { class: "mcpKeys__head" }, title, h("div", { class: "mcpKeys__tools" }, refresh, create));
    // The note under the head says why the keys cannot change (the buttons point to it).
    const note = h("div", { class: "mcpKeys__note" });
    note.id = "mcpKeysNote";
    if (reason) ns.uiState.banner(note, { message: reason, level: "info" });
    else note.hidden = true;
    // The error of an action (the controller fills it).
    const alert = h("div", { class: "mcpKeys__alert" });
    alert.id = "mcpAlert";
    alert.hidden = true;
    const body = h("div", { class: "mcpKeys__body" });
    body.id = "mcpKeysBody";
    if (view.status === "loading") body.appendChild(skeleton());
    else if (view.status === "error") ns.uiState.error(body, { title: "Could not load the keys", body: ns.util.errorText(view.error), retry: actions.onRetry });
    else if (!keys.length) {
      ns.uiState.empty(body, {
        title: "No access keys yet",
        body: reason ? "Keys defined in the config file will show here." : "Create a key to let an AI client read your data through MCP.",
        action: reason ? null : { label: "New key", primary: true, onClick: () => actions.onCreate(create) },
      });
    } else {
      body.appendChild(keysTable(keys, meta, actions));
      if (keys.some((key) => key.source === "config")) {
        body.appendChild(h("p", { class: "mcpNote mcpKeys__hint" }, "A key with the source config comes from the config file. It is read-only here: change it in the file and restart ChDash."));
      }
    }
    container.replaceChildren(head, note, alert, body);
  }

  ns.mcpView = Object.freeze({ renderHead, renderDisabled, renderKeys, endpointUrl, commands, codeBlock, manageReason, HCL_EXAMPLE });
})();
