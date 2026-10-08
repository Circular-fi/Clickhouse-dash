(() => {
  "use strict";
  // The views of the MCP integration page (docs/mcp-integration-page.md): the strip on top (the
  // endpoint with its Copy button, the state badges, Refresh and New key), the keys table with its
  // states, and the side column (how to connect a client, the hosts, the global limits). app_mcp_page.js decides what to show and answers the actions; app_mcp_form.js
  // has the key form and the secret panel. Every node is built with ns.h: no API value reaches markup.
  //
  //   ns.mcpView.renderHead(el, meta, actions)         the strip: endpoint, status badges, Refresh and New key
  //   ns.mcpView.renderSide(el, meta)                  the side column: connect a client, hosts, global limits
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
  const STATE_BADGE = { active: ["ok", "Active"], disabled: ["neutral", "Disabled"] };

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
    { value: "desktop", label: "Desktop", note: "Add this to claude_desktop_config.json. It needs Node.js: the mcp-remote bridge adds the header.", key: "desktop", copy: "the Claude Desktop settings" },
    { value: "inspector", label: "Inspector", note: "Start the inspector, then enter these values:", key: "inspector", copy: "the Inspector values" },
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

  function limitText(value, unit, zero) {
    if (value === null || value === undefined) return EMPTY;
    if (value === 0 && zero) return zero;
    return unit ? `${count(value)} ${unit}` : count(value);
  }

  // --- The strip -------------------------------------------------------------------------

  // One row: the endpoint (a read-only field with its Copy button), and Refresh and New key at the
  // right end. It says nothing of the state of MCP: a page that shows keys has MCP on, and what stops
  // a change (no storage file, manage_from_ui = false) is the note under the title of the keys.
  function renderHead(container, meta, actions) {
    const url = endpointUrl(meta);
    const reason = manageReason(meta);
    const field = h("div", { class: "mcpStrip__endpoint" },
      h("label", { class: "mcpStrip__label", for: "mcpEndpointUrl" }, "Endpoint"),
      h("input", { id: "mcpEndpointUrl", class: "uiInput uiInput--mono", type: "text", readonly: true, value: url, spellcheck: "false", autocomplete: "off", "aria-describedby": "mcpEndpointHint" }),
      ns.copy.button(null, () => url, { label: "Copy the endpoint URL", className: "mcpEndpoint__copy" }),
      h("span", { class: "srOnly", id: "mcpEndpointHint" }, "A client sends the secret of a key as a Bearer token."));
    const refresh = h("button", { type: "button", class: "refreshButton", id: "mcpRefresh", title: "Refresh", "aria-label": "Refresh" },
      ns.icon.el("refresh", { size: "sm", className: "refreshGlyph" }));
    refresh.addEventListener("click", () => actions.onRefresh(refresh));
    const create = h("button", {
      type: "button",
      class: "button button--primary mcpNewKey",
      id: "mcpNewKey",
      title: reason || "Create a key",
      disabled: reason ? true : null,
      "aria-describedby": reason ? "mcpKeysNote" : null,
    }, ns.icon.el("plus", { size: "sm" }), h("span", null, "New key"));
    if (!reason) create.addEventListener("click", () => actions.onCreate(create));
    container.replaceChildren(h("div", { class: "mcpStrip" }, field, h("div", { class: "mcpStrip__actions" }, refresh, create)));
  }

  // --- The side column ---------------------------------------------------------------------

  // A block of the side column: a small heading (title, count), then its body.
  function sideBlock(id, title, countText, ...body) {
    const titleId = `${id}Title`;
    const section = h("section", { class: "mcpBlock", id });
    section.setAttribute("aria-labelledby", titleId);
    section.append(
      h("h2", { class: "mcpBlock__title", id: titleId }, title, countText == null ? null : h("span", { class: "pagePart__count" }, String(countText))),
      ...body);
    return section;
  }

  function healthBadge(healthy) {
    if (healthy === true) return ns.badge.el("healthy", { tone: "ok" });
    if (healthy === false) return ns.badge.el("down", { tone: "error" });
    return ns.badge.el("unknown", { tone: "neutral" });
  }

  function connectBlock(meta, url) {
    return sideBlock("mcpConnect", "Connect a client", null,
      h("p", { class: "mcpNote" }, "Create a key, show its secret with the eye button in the table, and put it where <secret> stands."),
      clientTabs(url, "name", "<secret>", "mcpHelpClient"),
      h("p", { class: "mcpNote mcpNote--fine" }, `Bearer token. Protocol ${meta.protocolVersions.join(", ") || EMPTY}. Use HTTPS when the client is on another machine.`));
  }

  function hostsBlock(meta) {
    if (!meta.hosts.length) {
      return sideBlock("mcpHosts", "Hosts", 0, h("p", { class: "mcpNote" }, "No host has an mcp_uri in the config. A key cannot read data until one has."));
    }
    const rows = meta.hosts.map((host) => h("li", { class: "mcpHostRow", dataset: { host: host.name } },
      h("span", { class: "mcpHostRow__name" }, host.name),
      host.label && host.label !== host.name ? h("span", { class: "mcpMuted mcpHostRow__label", title: host.label }, host.label) : null,
      healthBadge(host.healthy)));
    return sideBlock("mcpHosts", "Hosts", meta.hosts.length, h("ul", { class: "mcpHostList", "aria-label": "Hosts with an mcp_uri" }, rows));
  }

  function limitsBlock(meta) {
    const l = meta.limits;
    const rows = [
      ["Rows per result", limitText(l.maxRows)],
      ["Timeout", limitText(l.queryTimeoutSeconds, "s")],
      ["Result size", l.maxResultBytes == null ? EMPTY : ns.format.bytes(l.maxResultBytes)],
      ["SQL size", l.maxSqlBytes == null ? EMPTY : ns.format.bytes(l.maxSqlBytes)],
      ["Memory per query", l.maxMemoryBytes == null ? EMPTY : ns.format.bytes(l.maxMemoryBytes)],
      ["Rows read", limitText(l.maxRowsToRead, "", "No limit")],
      ["Requests per minute", limitText(l.rateLimitPerMinute, "", "Unlimited")],
    ];
    const list = h("dl", { class: "mcpLimits", "aria-label": "Global limits" });
    for (const [label, value] of rows) list.append(h("dt", null, label), h("dd", null, value));
    return sideBlock("mcpLimitsBlock", "Global limits", null, list,
      h("p", { class: "mcpNote mcpNote--fine" }, "A key can lower the rows and the timeout. It never raises them. The request limit counts for each key."));
  }

  function renderSide(container, meta) {
    container.replaceChildren(connectBlock(meta, endpointUrl(meta)), hostsBlock(meta), limitsBlock(meta));
    container.hidden = false;
  }

  // MCP off ({ enabled: false }): what to add to the config. The page is still a page of its own.
  function renderDisabled(container) {
    const wrap = h("section", { class: "pagePart mcpOff", id: "mcpOff", "aria-labelledby": "mcpOffTitle" },
      h("div", { class: "pagePart__head" }, h("h2", { class: "pagePart__title", id: "mcpOffTitle" }, "Turn MCP on"), badge("MCP is off", "neutral")),
      h("div", { class: "pagePart__body" },
        h("p", { class: "mcpNote" }, "MCP lets an AI client read your ClickHouse data through ChDash. It is off now. Add this to the config file, then restart ChDash:"),
        codeBlock(HCL_EXAMPLE, "the HCL block"),
        h("p", { class: "mcpNote" }, "Set mcp_uri on each host that MCP can read. It names a separate ClickHouse user with SELECT and SHOW grants only. Without storage_file, keys come from key blocks of the config only.")));
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

  // "All" and "None" are words; names and patterns are code. One line: the title lists everything.
  function listCell(values, many = null, all = "All") {
    if (!values.length) return h("span", { class: "mcpMuted" }, "None");
    if (values.includes("*")) return all === "*" ? h("span", { class: "mcpMono", title: "All the data" }, "*") : h("span", { class: "mcpMuted" }, all);
    return h("span", { class: "mcpMono", title: values.join(", ") }, values.length > 1 && many ? many(values.length) : values.join(", "));
  }

  // A value the key sets itself reads at full strength; the global limit that it inherits reads muted.
  function limitsCell(key, meta) {
    const l = meta.limits || {};
    const part = (own, global, unit) => (own != null
      ? h("span", null, `${count(own)}${unit}`)
      : global != null ? h("span", { class: "mcpMuted" }, `${count(global)}${unit}`, h("span", { class: "srOnly" }, " (default)")) : EMPTY);
    return h("span", { class: "mcpLimitPair", title: "Rows and timeout. A muted value is the global limit: this key sets none of its own." },
      part(key.maxRows, l.maxRows, ""), h("span", { class: "mcpMuted" }, " \u00b7 "), part(key.timeoutSeconds, l.queryTimeoutSeconds, " s"));
  }

  // The secret of a key: its first characters and dots, the eye that shows all of it and the copy
  // button. The secret is asked for each time (GET /api/mcp/keys/<id>/secret) and is kept nowhere: the
  // node holds it while it shows, and it hides again after 30 seconds or at the next redraw.
  const MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";
  const REVEAL_MS = 30000;

  function secretCell(key) {
    const available = key.secretAvailable;
    const why = key.source === "config"
      ? "This key is defined by its hash (secret_sha256) in the config file: only the file has its secret."
      : "This key was made before ChDash kept secrets: rotate it to get a secret that the page can show.";
    const masked = key.secretHint ? `${key.secretHint}${MASK}` : "Not available";
    const text = h("span", { class: "mcpSecret__text", title: available ? "" : why }, masked);
    if (!key.secretHint) text.classList.add("mcpMuted");
    const asked = async () => {
      try {
        return await ns.api.getMcpKeySecret(key.id);
      } catch (error) {
        ns.uiState.announce(`The secret of ${key.name} cannot be shown: ${ns.util.errorText(error)}`);
        return "";
      }
    };
    let timer = 0;
    const eye = h("button", { type: "button", class: "button button--small mcpAction mcpSecret__eye", dataset: { action: "reveal" }, "aria-pressed": "false" });
    const hide = () => {
      clearTimeout(timer);
      text.textContent = masked;
      text.classList.remove("is-shown");
      eye.setAttribute("aria-pressed", "false");
      eye.setAttribute("aria-label", `Show the secret of ${key.name}`);
      eye.title = `Show the secret of ${key.name}`;
      eye.replaceChildren(ns.icon.el("eye", { size: "sm" }));
    };
    eye.addEventListener("click", async () => {
      if (text.classList.contains("is-shown")) {
        hide();
        return;
      }
      ns.uiState.busy(eye, true);
      const secret = await asked();
      ns.uiState.busy(eye, false);
      if (!secret || !eye.isConnected) return;
      text.textContent = secret;
      text.classList.add("is-shown");
      eye.setAttribute("aria-pressed", "true");
      eye.setAttribute("aria-label", `Hide the secret of ${key.name}`);
      eye.title = `Hide the secret of ${key.name}`;
      eye.replaceChildren(ns.icon.el("eye-off", { size: "sm" }));
      timer = setTimeout(hide, REVEAL_MS);
    });
    const copy = ns.copy.button(null, asked, { label: `Copy the secret of ${key.name}`, className: "button button--small mcpAction mcpSecret__copy" });
    copy.dataset.action = "copy-secret";
    hide();
    if (!available) {
      for (const button of [eye, copy]) {
        button.disabled = true;
        button.title = why;
      }
    }
    return h("div", { class: "mcpSecret" }, text, h("span", { class: "mcpSecret__buttons" }, eye, copy));
  }

  function keyRow(key, meta, actions, reason) {
    const readOnly = key.source === "config";
    const lock = readOnly ? "Read-only: this key comes from the config file. Change it there." : reason;
    const [tone, stateLabel] = STATE_BADGE[key.state] || STATE_BADGE.active;
    const cell = (label, cls, ...children) => {
      const td = h("td", { class: cls }, ...children);
      td.setAttribute("role", "cell");
      td.dataset.label = label;
      return td;
    };
    // The name opens the details of the key (a click on the row does the same).
    const open = h("button", { type: "button", class: "mcpKeyOpen", dataset: { action: "open" }, title: `${key.name}\n${SOURCE_TITLE[key.source]}\nShow its permissions`, "aria-label": `Details of key ${key.name}` },
      h("strong", { class: "mcpKeyName" }, key.name));
    open.addEventListener("click", () => actions.onOpen(key, open));
    const nameCell = cell("Name", "mcpCell--name", open);
    // A key that cannot change shows one line of text, not four buttons that do nothing.
    const actionsCell = cell("Actions", "mcpCell--actions", lock
      ? h("span", { class: "mcpLocked", title: lock }, ns.icon.el("lock", { size: "sm" }), h("span", { class: "mcpLocked__text" }, readOnly ? "Config file" : "Read-only"))
      : h("div", { class: "mcpActions" },
        actionButton("edit", key, "", actions.onEdit),
        actionButton("toggle", key, "", actions.onToggle),
        actionButton("rotate", key, "", actions.onRotate),
        actionButton("remove", key, "", actions.onDelete)));
    return h("tr", { role: "row", dataset: { keyId: key.id, state: key.state, source: key.source, find: `${key.name} ${key.state} ${key.source}`.toLowerCase() } },
      nameCell,
      cell("Secret", "mcpCell--secret", secretCell(key)),
      cell("Hosts", "mcpCell--hosts", listCell(key.hosts)),
      cell("Tools", "mcpCell--tools", listCell(key.tools, (n) => `${n} tools`)),
      cell("Data", "mcpCell--data", listCell(key.databases, null, "*")),
      cell("Limits", "mcpCell--limits", limitsCell(key, meta)),
      cell("State", "mcpCell--state", ns.badge.el(stateLabel, { tone })),
      actionsCell);
  }

  const COLUMNS = [["Name", "name"], ["Secret", "secret"], ["Hosts", "hosts"], ["Tools", "tools"], ["Data", "data"], ["Limits", "limits"], ["State", "state"], ["Actions", "actions"]];

  function keysTable(keys, meta, actions) {
    const reason = manageReason(meta);
    const head = h("tr", null, ...COLUMNS.map(([name, kind]) => {
      const th = h("th", { class: `mcpCell--${kind}` }, name === "Actions" ? h("span", { class: "srOnly" }, name) : name);
      th.setAttribute("scope", "col");
      th.setAttribute("role", "columnheader");
      return th;
    }));
    head.setAttribute("role", "row");
    // Roles are written out: a phone draws each row as a card and the browser would drop the table.
    const tbody = h("tbody", { role: "rowgroup" }, ...keys.map((key) => keyRow(key, meta, actions, reason)));
    // A click on the row, outside its buttons and not while text is selected, opens the key.
    tbody.addEventListener("click", (event) => {
      if (event.target.closest("button, a, input, select, textarea")) return;
      if (String(window.getSelection?.() || "")) return;
      const tr = event.target.closest("tr[data-key-id]");
      const key = tr ? keys.find((item) => item.id === tr.dataset.keyId) : null;
      if (key) actions.onOpen(key, $('[data-action="open"]', tr));
    });
    const table = h("table", { class: "dataTable dataTable--compact mcpTable" }, h("thead", { role: "rowgroup" }, head), tbody);
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", "Access keys");
    const wrap = h("div", { class: "dataTableWrap mcpTableWrap" }, table);
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Access keys, scroll sideways when the table is wider than the page");
    wrap.tabIndex = 0;
    return wrap;
  }

  // A long list gets a filter (name, state, source). The text stays between redraws.
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
  // actions: { onCreate, onOpen(key, button), onEdit(key), onToggle(key), onRotate(key), onDelete(key), onRefresh, onRetry }
  function renderKeys(container, view, actions) {
    const { meta, keys = [] } = view;
    const reason = manageReason(meta);
    const filter = keys.length >= FILTER_FROM && view.status === "ready"
      ? h("input", { class: "uiInput mcpKeys__filter", type: "search", id: "mcpKeysFilter", placeholder: "Filter keys", "aria-label": "Filter the keys by name, state or source", autocomplete: "off", spellcheck: "false", value: filterText })
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
        body: reason ? "Keys defined in the config file will show here." : "Create a key to let an AI client read your data through MCP. The commands to connect are next to this list.",
        action: reason ? null : { label: "New key", primary: true, onClick: () => actions.onCreate(ns.dom.byId("mcpNewKey")) },
      });
    } else {
      body.appendChild(keysTable(keys, meta, actions));
      body.appendChild(h("p", { class: "mcpNote mcpKeys__none", hidden: true }, "No key matches this filter."));
      const config = keys.some((key) => key.source === "config");
      body.appendChild(h("p", { class: "mcpNote mcpNote--fine mcpKeys__hint" }, `A muted limit is the global limit: the key sets none of its own.${config ? " A key with the source config comes from the config file: change it there and restart ChDash." : ""}`));
    }
    container.replaceChildren(head, note, alert, body);
    if (filter) {
      filter.addEventListener("input", () => { filterText = filter.value; applyFilter(container); });
      applyFilter(container);
    }
  }

  ns.mcpView = Object.freeze({ renderHead, renderSide, renderDisabled, renderKeys, secretCell, endpointUrl, commands, codeBlock, clientTabs, manageReason, HCL_EXAMPLE });
})();
