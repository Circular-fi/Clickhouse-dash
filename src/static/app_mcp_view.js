(() => {
  "use strict";
  // The views of the MCP integration page (docs/mcp-integration-page.md): the keys table with its states
  // and, beside it, the side column (how to connect a client, with the endpoint, the hosts, the global
  // limits). The heading of the keys holds the page's two actions: Refresh and New key. app_mcp_page.js
  // decides what to show and answers the actions; app_mcp_form.js has the dialogs. Every node is built
  // with ns.h: no API value reaches markup.
  //
  //   ns.mcpView.renderSide(el, meta)                  the side column: connect a client, hosts, global limits
  //   ns.mcpView.renderDisabled(el)                    the HCL extract that turns MCP on
  //   ns.mcpView.renderKeys(el, view, actions)         the keys part: head (New key), note, table or state
  //   ns.mcpView.secretCell(key)                       the secret of a key: dots, the eye, the copy button
  //   ns.mcpView.endpointUrl(meta)                     the full URL of the endpoint (the page's origin)
  //   ns.mcpView.commands(url, name, secret, header)   { cli, desktop, inspector, json } to connect a client; header is mcp.auth_header
  //   ns.mcpView.codeBlock(text, label, lang)          a code block with its copy button and its colours (json, shell, values, hcl)
  //   ns.mcpView.clientTabs(url, name, secret, id, header)  the client snippets as tabs (the side column and the secret panel)
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

  const badge = (text, tone, title = "") => ns.badge.el(text, { tone, size: "md", title });

  // --- Endpoint, commands ----------------------------------------------------------------

  function endpointUrl(meta) {
    const path = ns.api.resolveUrl(String(meta?.endpointPath || "/mcp").replace(/^\/+/, ""));
    return new URL(path, window.location.origin).href;
  }

  // The header that carries the key (mcp.auth_header: Authorization by default) and the value that it takes:
  // Authorization takes "Bearer <key>", another header the key alone.
  const authHeader = (meta) => String(meta?.authHeader || "Authorization");
  const authValue = (header, secret) => (header.toLowerCase() === "authorization" ? `Bearer ${secret}` : secret);

  // The commands that connect a client, from the real URL of the endpoint.
  //   cli       Claude Code (a command)
  //   desktop   Claude Desktop (claude_desktop_config.json: the mcp-remote bridge adds the header)
  //   inspector MCP Inspector (the values to enter)
  //   json      a client that reads a JSON file of servers (.mcp.json)
  function commands(url, name, secret, header = "Authorization") {
    const server = `chdash-${String(name || "key").replace(/[^a-z0-9_-]/gi, "-")}`;
    const value = authValue(header, secret);
    const cli = `claude mcp add --transport http ${server} ${url} --header "${header}: ${value}"`;
    const json = JSON.stringify({ mcpServers: { [server]: { type: "http", url, headers: { [header]: value } } } }, null, 2);
    const desktop = JSON.stringify({ mcpServers: { [server]: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `${header}:\${AUTH_HEADER}`], env: { AUTH_HEADER: value } } } }, null, 2);
    const inspector = ["npx @modelcontextprotocol/inspector", "", "Transport Type   Streamable HTTP", `URL              ${url}`, `Header name      ${header}`, `Header value     ${value}`].join("\n");
    return { cli, json, desktop, inspector };
  }

  // --- Colours for the code blocks ---------------------------------------------------------
  // A block is cut into tokens with the classes of the SQL highlighter (.tok-*, css/10-components/sql.css),
  // so the page has the colours of the Query editor and of both themes. The nodes are text nodes and spans:
  // no value reaches markup. Each rule is sticky: it matches at the position being read.
  const rule = (cls, re) => [cls, new RegExp(re, "y")];
  const GRAMMARS = {
    json: [
      rule("tok-fn", '"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)'),
      rule("tok-str", '"(?:[^"\\\\]|\\\\.)*"'),
      rule("tok-num", "-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?"),
      rule("tok-null", "\\b(?:true|false|null)\\b"),
    ],
    shell: [
      rule("tok-str", '"(?:[^"\\\\]|\\\\.)*"|\'[^\']*\''),
      rule("tok-kw", "(?<![^\\n])(?:claude|npx)(?=\\s)"),
      rule("tok-type", "(?<![\\w-])--?[A-Za-z][\\w-]*"),
      rule("tok-fn", "https?://[^\\s\"']+"),
      rule("tok-null", "<[a-z][\\w-]*>"),
    ],
    values: [
      rule("tok-kw", "(?<![^\\n])npx(?=\\s)"),
      rule("tok-fn", "(?<![^\\n])(?:Transport Type|URL|Header name|Header value)(?= {2})"),
      rule("tok-null", "<[a-z][\\w-]*>"),
    ],
    hcl: [
      rule("tok-com", "#[^\\n]*"),
      rule("tok-str", '"(?:[^"\\\\]|\\\\.)*"'),
      rule("tok-null", "\\b(?:true|false)\\b"),
      rule("tok-num", "\\b\\d+\\b"),
      rule("tok-fn", "(?<=(?:^|\\n)[ \\t]*)[A-Za-z_]\\w*(?=\\s*=)"),
      rule("tok-kw", "(?<=(?:^|\\n)[ \\t]*)[A-Za-z_]\\w*(?=\\s*\\{)"),
    ],
  };

  function colored(text, lang) {
    const rules = GRAMMARS[lang];
    if (!rules) return [text];
    const out = [];
    let plain = "";
    let at = 0;
    while (at < text.length) {
      let hit = null;
      for (const [cls, re] of rules) {
        re.lastIndex = at;
        const found = re.exec(text);
        if (found && found[0]) { hit = [cls, found[0]]; break; }
      }
      if (hit) {
        if (plain) out.push(plain);
        plain = "";
        out.push(h("span", { class: hit[0] }, hit[1]));
        at += hit[1].length;
      } else {
        plain += text[at];
        at += 1;
      }
    }
    if (plain) out.push(plain);
    return out;
  }

  function codeBlock(text, label, lang = "") {
    const copy = ns.copy.button(null, () => text, { label: `Copy ${label}`, className: "mcpCode__copy" });
    return h("div", { class: "mcpCode" }, h("pre", { class: "mcpCode__pre" }, h("code", null, ...colored(text, lang))), copy);
  }

  // The client snippets as tabs (one block at a time keeps the dialog and the help short). It
  // serves the help of the page and the one-time secret panel.
  const CLIENTS = [
    { value: "code", label: "Claude Code", note: "Run this command in a terminal:", key: "cli", lang: "shell", copy: "the command" },
    { value: "desktop", label: "Desktop", note: "Add this to claude_desktop_config.json. It needs Node.js: the mcp-remote bridge adds the header.", key: "desktop", lang: "json", copy: "the Claude Desktop settings" },
    { value: "inspector", label: "Inspector", note: "Start the inspector, then enter these values:", key: "inspector", lang: "values", copy: "the Inspector values" },
    { value: "json", label: "JSON", note: "In a client that reads a JSON file of servers (.mcp.json), add this block:", key: "json", lang: "json", copy: "the JSON block" },
  ];

  function clientTabs(url, name, secret, idBase, header = "Authorization") {
    const set = commands(url, name, secret, header);
    const group = h("div", { class: "mcpClients__tabs" });
    ns.segmented.render(group, CLIENTS.map((c) => ({ value: c.value, label: c.label })), { attr: "client", value: CLIENTS[0].value, size: "compact", label: "Client" });
    const panels = CLIENTS.map((c) => {
      const panel = h("div", { class: "mcpClients__panel", id: `${idBase}-${c.value}`, dataset: { client: c.value } },
        h("p", { class: "mcpNote" }, c.note), codeBlock(set[c.key], c.copy, c.lang));
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

  // The endpoint: a read-only field with its Copy button, the first thing a client needs.
  function endpointField(url) {
    return h("div", { class: "uiField mcpEndpoint" },
      h("label", { class: "uiField__label", for: "mcpEndpointUrl" }, "Endpoint"),
      h("div", { class: "uiField__row" },
        h("input", { id: "mcpEndpointUrl", class: "uiInput uiInput--mono", type: "text", readonly: true, value: url, spellcheck: "false", autocomplete: "off" }),
        ns.copy.button(null, () => url, { label: "Copy the endpoint URL", className: "mcpEndpoint__copy" })));
  }

  function connectBlock(meta, url) {
    return sideBlock("mcpConnect", "Connect a client", null,
      endpointField(url),
      h("p", { class: "mcpNote" }, "Make a key, show its secret with the eye in the table, and put it where <secret> stands."),
      clientTabs(url, "name", "<secret>", "mcpHelpClient", authHeader(meta)),
      h("p", { class: "mcpNote mcpNote--fine" }, `${authHeader(meta) === "Authorization" ? "Bearer token in Authorization" : `The key in the ${authHeader(meta)} header`}. Protocol ${meta.protocolVersions.join(", ") || EMPTY}. Use HTTPS when the client is on another machine.`));
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
        codeBlock(HCL_EXAMPLE, "the HCL block", "hcl"),
        h("p", { class: "mcpNote" }, "Set mcp_uri on each host that MCP can read. It names a separate ClickHouse user with SELECT and SHOW grants only. Without storage_file, keys come from key blocks of the config only.")));
    container.replaceChildren(wrap);
  }

  // --- Keys ------------------------------------------------------------------------------

  // The one action on a key: Delete (a key is made or deleted, never changed).
  function deleteButton(key, onClick) {
    const button = h("button", {
      type: "button",
      class: "button button--small mcpAction mcpAction--danger",
      dataset: { action: "remove" },
      title: `Delete ${key.name}`,
      "aria-label": `Delete ${key.name}`,
    }, ns.icon.el("trash", { size: "sm" }), h("span", { class: "mcpAction__label" }, "Delete"));
    button.addEventListener("click", () => onClick(key, button));
    return button;
  }

  // "All" and "None" are words, a part is "n/total" (code): the hosts and the tools of the key out of
  // the ones that exist. The title lists them. Data has no total (patterns), so it is a count.
  function listCell(values, total = 0, noun = "") {
    if (!values.length) return h("span", { class: "mcpMuted" }, "None");
    if (values.includes("*")) return h("span", { class: "mcpMuted", title: `All ${noun || "the data"}` }, "All");
    if (total && values.length >= total) return h("span", { class: "mcpMuted", title: values.join(", ") }, "All");
    const text = total ? `${values.length}/${total}` : `${values.length} ${values.length === 1 ? "pattern" : "patterns"}`;
    return h("span", { class: "mcpMono", title: values.join(", ") }, text);
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
    return h("div", { class: "mcpSecret" }, h("span", { class: "mcpSecret__buttons" }, eye, copy), text);
  }

  function keyRow(key, meta, actions, reason) {
    const readOnly = key.source === "config";
    const lock = readOnly ? "Read-only: this key comes from the config file. Change it there." : reason;
    const cell = (label, cls, ...children) => {
      const td = h("td", { class: cls }, ...children);
      td.setAttribute("role", "cell");
      td.dataset.label = label;
      return td;
    };
    // The name opens the details of the key (a click on the row does the same).
    const open = h("button", { type: "button", class: "mcpKeyOpen", dataset: { action: "open" }, title: `${key.name}\n${SOURCE_TITLE[key.source]}\nShow its permissions`, "aria-label": `Details of key ${key.name}`, "aria-expanded": "false", "aria-controls": `mcpDetail-${key.id}` },
      h("strong", { class: "mcpKeyName" }, key.name));
    open.addEventListener("click", () => actions.onOpen(key, open));
    const nameCell = cell("Name", "mcpCell--name", open);
    // A key that cannot be deleted shows a lock, not a button that does nothing.
    const actionsCell = cell("Actions", "mcpCell--actions", lock
      ? h("span", { class: "mcpLocked", title: lock }, ns.icon.el("lock", { size: "sm" }), h("span", { class: "mcpLocked__text" }, readOnly ? "Config file" : "Read-only"))
      : deleteButton(key, actions.onDelete));
    return h("tr", { role: "row", dataset: { keyId: key.id, source: key.source, find: `${key.name} ${key.source}`.toLowerCase() } },
      nameCell,
      cell("Secret", "mcpCell--secret", secretCell(key)),
      cell("Hosts", "mcpCell--hosts", listCell(key.hosts, meta.hosts.length, "hosts")),
      cell("Tools", "mcpCell--tools", listCell(key.tools, meta.tools.length, "tools")),
      cell("Data", "mcpCell--data", listCell(key.databases)),
      cell("Limits", "mcpCell--limits", limitsCell(key, meta)),
      actionsCell);
  }

  const COLUMNS = [["Name", "name"], ["Secret", "secret"], ["Hosts", "hosts"], ["Tools", "tools"], ["Data", "data"], ["Limits", "limits"], ["Actions", "actions"]];

  // The key that shows its details ("" for none).
  let openKeyId = "";

  function closeDetails(tbody) {
    for (const row of $$(".mcpDetailRow", tbody)) row.remove();
    for (const row of $$("tr.is-open", tbody)) {
      row.classList.remove("is-open");
      $('[data-action="open"]', row)?.setAttribute("aria-expanded", "false");
    }
  }

  function showDetails(tbody, key, meta) {
    const row = $(`tr[data-key-id="${CSS.escape(key.id)}"]`, tbody);
    if (!row) return;
    const cell = h("td", { class: "mcpDetailCell", colspan: String(COLUMNS.length) }, ns.mcpForm.keyDetails({ meta, key }));
    cell.setAttribute("role", "cell");
    const detail = h("tr", { class: "mcpDetailRow", id: `mcpDetail-${key.id}`, role: "row", dataset: { detailFor: key.id } }, cell);
    detail.hidden = row.hidden;
    row.after(detail);
    row.classList.add("is-open");
    $('[data-action="open"]', row)?.setAttribute("aria-expanded", "true");
  }

  function keysTable(keys, meta, actions) {
    const reason = manageReason(meta);
    const head = h("tr", null, ...COLUMNS.map(([name, kind]) => {
      const th = h("th", { class: `mcpCell--${kind}` }, name === "Actions" ? h("span", { class: "srOnly" }, name) : name);
      th.setAttribute("scope", "col");
      th.setAttribute("role", "columnheader");
      return th;
    }));
    head.setAttribute("role", "row");
    // The details of a key open under its row, one key at a time: opening another closes this one. The
    // open key stays open when the list is drawn again.
    const toggle = (key, opener) => {
      const wasOpen = openKeyId === key.id;
      closeDetails(tbody);
      openKeyId = wasOpen ? "" : key.id;
      if (!wasOpen) showDetails(tbody, key, meta);
      (opener || $(`tr[data-key-id="${CSS.escape(key.id)}"] [data-action="open"]`, tbody))?.focus();
    };
    // Roles are written out: a phone draws each row as a card and the browser would drop the table.
    const tbody = h("tbody", { role: "rowgroup" }, ...keys.map((key) => keyRow(key, meta, { ...actions, onOpen: toggle }, reason)));
    // A click on the row, outside its buttons and not while text is selected, opens the key.
    tbody.addEventListener("click", (event) => {
      if (event.target.closest("button, a, input, select, textarea, .mcpDetailRow")) return;
      if (String(window.getSelection?.() || "")) return;
      const tr = event.target.closest("tr[data-key-id]");
      const key = tr ? keys.find((item) => item.id === tr.dataset.keyId) : null;
      if (key) toggle(key, $('[data-action="open"]', tr));
    });
    const held = keys.find((key) => key.id === openKeyId);
    if (held) showDetails(tbody, held, meta);
    else openKeyId = "";
    const table = h("table", { class: "dataTable dataTable--compact mcpTable" }, h("thead", { role: "rowgroup" }, head), tbody);
    table.setAttribute("role", "table");
    table.setAttribute("aria-label", "Access keys");
    const wrap = h("div", { class: "dataTableWrap mcpTableWrap" }, table);
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Access keys, scroll sideways when the table is wider than the page");
    wrap.tabIndex = 0;
    return wrap;
  }

  // A long list gets a filter (name, source). The text stays between redraws.
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
    for (const detail of $$(".mcpDetailRow", container)) detail.hidden = !!detail.previousElementSibling?.hidden;
    const countEl = $(".pagePart__count", container);
    if (countEl) countEl.textContent = needle ? `${shown} of ${rows.length}` : String(rows.length);
    const none = $(".mcpKeys__none", container);
    if (none) none.hidden = shown > 0 || !rows.length;
  }

  // view: { status: "loading" | "error" | "ready", keys, meta, error }
  // actions: { onCreate, onOpen(key, button), onDelete(key), onRefresh, onRetry }
  function renderKeys(container, view, actions) {
    const { meta, keys = [] } = view;
    const reason = manageReason(meta);
    const filter = keys.length >= FILTER_FROM && view.status === "ready"
      ? h("input", { class: "uiInput mcpKeys__filter", type: "search", id: "mcpKeysFilter", placeholder: "Filter keys", "aria-label": "Filter the keys by name or source", autocomplete: "off", spellcheck: "false", value: filterText })
      : null;
    // Refresh and New key at the right end of the heading.
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
    const head = h("div", { class: "pagePart__head mcpKeys__head" },
      h("h2", { class: "pagePart__title", id: "mcpKeysTitle" }, "Access keys"),
      view.status === "ready" ? h("span", { class: "pagePart__count" }, String(keys.length)) : null,
      filter,
      h("div", { class: "mcpKeys__actions" }, refresh, create));
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
    }
    container.replaceChildren(head, note, alert, body);
    if (filter) {
      filter.addEventListener("input", () => { filterText = filter.value; applyFilter(container); });
      applyFilter(container);
    }
  }

  ns.mcpView = Object.freeze({ renderSide, renderDisabled, renderKeys, secretCell, endpointUrl, authHeader, commands, codeBlock, clientTabs, manageReason, HCL_EXAMPLE });
})();
