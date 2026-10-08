(() => {
  "use strict";
  // The dialogs of the MCP integration page (docs/mcp-integration-page.md).
  //
  //   ns.mcpForm.openKeyForm({ meta, key, submit })   Promise<result | null>
  //       A dialog (ns.dialog) to create a key (key: null) or to edit one. The form fits the dialog
  //       without a scroll: the name, the hosts, the data and the limits on the left, the permissions
  //       on the right, one line of summary under both. The submit button stays off, and says why in
  //       its title, until the key is valid. submit(input) sends it (ns.api.createMcpKey /
  //       updateMcpKey) and returns the answer, which resolves the promise. A validation error of
  //       the server (err.mcp.field, err.mcp.reason) shows under its field and the dialog stays
  //       open; any other error shows at the foot of the dialog.
  //   ns.mcpForm.showKey({ meta, key, canManage })     Promise<"edit" | "toggle" | "rotate" | "remove" | null>
  //       The details of a key: its state, its secret (eye and copy), its hosts, its data, its limits
  //       and every permission it holds, with what each one does. The buttons at the foot are the
  //       actions of the key (none when the page cannot change it); the answer names the one pressed.
  //   ns.mcpForm.showSecret({ meta, key, secret, rotated })   Promise<void>
  //       The panel after a create or a rotation: the secret and the commands that connect a
  //       client. Nothing of it stays: the dialog and its nodes go when it closes, and the secret is
  //       never written to localStorage, sessionStorage or the address.
  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
  const { $, $$ } = ns.dom;
  const EMPTY = ns.format.EMPTY;

  const GROUPS = [
    { id: "schema", title: "Schema", note: "names, columns and engines" },
    { id: "read", title: "Read", note: "rows of a table that ChDash selects" },
    { id: "observability", title: "Observability", note: "traces, logs and metrics: the data must include the otel database" },
    { id: "sql", title: "SQL", note: "free SQL written by the client" },
  ];
  const NEEDS_EVERYTHING = "Needs the data pattern * alone: ChDash cannot limit free SQL to some tables.";

  // What the server's reason says when it sends no sentence of its own.
  const REASON_TEXT = {
    required: "This field is required.",
    type: "This value has the wrong type.",
    invalid: "This value is not valid.",
    too_long: "This value is too long.",
    unknown_host: "This host has no mcp_uri in the config.",
    unknown_tool: "ChDash does not know this tool.",
    needs_all_data: NEEDS_EVERYTHING,
    duplicate: "This value is listed twice.",
    range: "This number is outside the allowed range.",
    invalid_json: "The request was not valid JSON.",
  };

  // The description of a tool is written for the model that calls it. The form shows its first
  // sentence without the code quotes; the title keeps the whole text.
  const plainText = (text) => String(text || "").replace(/`/g, "");
  const firstSentence = (text) => plainText(text).split(/(?<=\.)\s/)[0];

  // --- Fields ----------------------------------------------------------------------------

  // A field: its label, the control(s), a hint and the place where its error shows.
  function fieldWrap(name, label, content, { hint = "", group = false } = {}) {
    const wrap = h(group ? "fieldset" : "div", { class: "uiField", dataset: { wrap: name } });
    const error = h("div", { class: "uiField__error", id: `mcpFieldError-${name}`, role: "alert", hidden: true });
    if (group) wrap.appendChild(h("legend", { class: "uiField__label" }, label));
    else wrap.appendChild(h("label", { class: "uiField__label", for: `mcpField-${name}` }, label));
    wrap.append(...[].concat(content));
    if (hint) wrap.appendChild(h("div", { class: "uiField__hint" }, hint));
    wrap.appendChild(error);
    return wrap;
  }

  function checkbox({ id, label, checked, disabled = false, title = "", value = "" }) {
    const input = h("input", { type: "checkbox", id, value, checked: !!checked, disabled: !!disabled || null });
    input.checked = !!checked;
    input.disabled = !!disabled;
    const wrap = h("label", { class: `uiCheck${disabled ? " is-disabled" : ""}`, for: id, title: title || null }, input, h("span", { class: "uiCheck__text" }, h("span", { class: "uiCheck__label" }, label)));
    return { wrap, input };
  }

  // --- The key form ----------------------------------------------------------------------

  // The form follows the page that makes a fine-grained token on GitHub: a name, the access (the
  // repositories there, the hosts and the data here) and a list of permissions with a level each.
  // It is dense on purpose: it has to fit the dialog without a scroll.
  function buildForm(meta, key) {
    const editing = !!key;
    const hostNames = meta.hosts.map((host) => host.name);
    const allHosts = editing ? key.hosts.includes("*") : false;
    const allData = editing ? key.databases.includes("*") : false;  // the pattern * is all of it
    const startTools = editing ? new Set(key.tools.includes("*") ? meta.tools.map((tool) => tool.name) : key.tools) : new Set(meta.tools.filter((tool) => !tool.needsAllData && tool.group !== "observability").map((tool) => tool.name));

    const form = h("div", { class: "uiForm mcpKeyForm" });

    // Name.
    const name = h("input", { id: "mcpField-name", class: "uiInput", type: "text", name: "name", dataset: { field: "name" }, autocomplete: "off", spellcheck: "false", maxlength: "32", placeholder: "ci-bot", value: key?.name || "" });
    const nameField = fieldWrap("name", "Name", name, { hint: "a-z, 0-9, - and _, 32 characters at most. The client shows it as the server name." });

    // Hosts: the hosts that have an mcp_uri, at least one ticked. A single host is ticked and
    // cannot be unticked. A key made with every host (hosts = ["*"]) opens with all of them ticked.
    const hostBoxes = [];
    const hostGrid = h("div", { class: "uiChecks mcpHostGrid" });
    const known = new Set(hostNames);
    const hostRows = [...meta.hosts.map((host) => ({ name: host.name, label: host.label && host.label !== host.name ? host.label : "" })),
      ...(editing ? key.hosts.filter((host) => host !== "*" && !known.has(host)).map((host) => ({ name: host, label: "no mcp_uri now" })) : [])];
    const only = hostRows.length === 1;
    hostRows.forEach((host, index) => {
      const box = checkbox({
        id: `mcpHost-${index}`,
        label: host.name,
        checked: only || (editing && (allHosts || key.hosts.includes(host.name))),
        disabled: only,
        title: only ? "The only host that has an mcp_uri: a key needs at least one host." : host.label,
        value: host.name,
      });
      if (index === 0) box.input.dataset.field = "hosts";
      hostBoxes.push(box);
      hostGrid.appendChild(box.wrap);
    });
    const hostsField = fieldWrap("hosts", "Hosts", hostGrid, { group: true });

    // Data: the patterns, one per line. * alone is every database and table.
    const patterns = h("textarea", { id: "mcpField-databases", class: "uiInput uiInput--area uiInput--mono", name: "databases", dataset: { field: "databases" }, rows: "3", spellcheck: "false", autocomplete: "off", placeholder: "otel\nanalytics.events\nlogs_*.*" });
    patterns.value = editing ? key.databases.join("\n") : "";
    const dataField = fieldWrap("databases", "Data", patterns, { hint: "One pattern per line: db, db.table, * as a wildcard. * alone is everything." });

    // Limits.
    const limits = meta.limits;
    const number = (id, field, value, max, placeholder) => h("input", { id, class: "uiInput", type: "number", name: field, dataset: { field }, min: "1", max: max != null ? String(max) : null, step: "1", inputmode: "numeric", placeholder, value: value != null ? String(value) : "" });
    const rows = number("mcpField-max_rows", "max_rows", key?.maxRows, limits.maxRows, limits.maxRows != null ? `Default ${ns.format.count(limits.maxRows)}` : "Default");
    const timeout = number("mcpField-timeout_seconds", "timeout_seconds", key?.timeoutSeconds, limits.queryTimeoutSeconds, limits.queryTimeoutSeconds != null ? `Default ${limits.queryTimeoutSeconds} s` : "Default");
    const limitsRow = h("div", { class: "mcpFieldRow" },
      fieldWrap("max_rows", "Max rows", rows),
      fieldWrap("timeout_seconds", "Timeout (s)", timeout));

    // Permissions: each tool is a line with its access level. Every tool reads: there is no write.
    const toolRows = [];
    const groupsBox = h("div", { class: "mcpToolGroups" });
    for (const group of GROUPS) {
      const tools = meta.tools.filter((tool) => tool.group === group.id);
      if (!tools.length) continue;
      const list = h("div", { class: "mcpPerms" });
      for (const tool of tools) {
        const select = h("select", { id: `mcpTool-${tool.name}`, class: "uiInput mcpPerm__access", name: `tool-${tool.name}`, dataset: toolRows.length ? null : { field: "tools" }, "aria-label": `Access to ${tool.name}` },
          h("option", { value: "none" }, "No access"), h("option", { value: "read" }, "Read-only"));
        select.value = startTools.has(tool.name) && (!tool.needsAllData || allData) ? "read" : "none";
        const row = h("div", { class: "mcpPerm", title: plainText(tool.description) },
          h("label", { class: "mcpPerm__text", for: select.id }, h("span", { class: "mcpPerm__name" }, tool.name), h("span", { class: "mcpPerm__note" }, firstSentence(tool.description))),
          select);
        toolRows.push({ tool, row, select });
        list.appendChild(row);
      }
      const reason = h("span", { class: "mcpToolGroup__reason" });
      reason.id = `mcpToolReason-${group.id}`;
      reason.hidden = true;
      groupsBox.appendChild(h("div", { class: "mcpToolGroup" },
        h("div", { class: "mcpToolGroup__head" }, h("span", { class: "mcpToolGroup__title" }, group.title), h("span", { class: "mcpMuted" }, group.note), reason), list));
    }
    const patternList = () => [...new Set(patterns.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
    const isEverything = () => { const list = patternList(); return list.length === 1 && list[0] === "*"; };
    const syncTools = () => {
      const everything = isEverything();
      for (const item of toolRows) {
        const locked = item.tool.needsAllData && !everything;
        if (locked) item.select.value = "none";
        item.select.disabled = locked;
        item.row.classList.toggle("is-disabled", locked);
        item.row.title = locked ? NEEDS_EVERYTHING : plainText(item.tool.description);
        if (locked) item.select.setAttribute("aria-describedby", "mcpToolReason-sql");
        else item.select.removeAttribute("aria-describedby");
      }
      const sql = $("#mcpToolReason-sql", form);
      if (sql) {
        sql.hidden = everything;
        sql.textContent = everything ? "" : NEEDS_EVERYTHING;
      }
    };
    // A change that no control reports (the two buttons below): the form says it, so the summary and the
    // submit button of the dialog follow.
    const changed = () => form.dispatchEvent(new Event("change", { bubbles: true }));
    const setAll = (value) => { for (const item of toolRows) if (!item.select.disabled) item.select.value = value; };
    const toolsField = fieldWrap("tools", "Permissions", [
      h("div", { class: "mcpToolsTools" },
        h("button", { type: "button", class: "button button--small", id: "mcpToolsAll", on: { click: () => { setAll("read"); changed(); } } }, "Select all"),
        h("button", { type: "button", class: "button button--small", id: "mcpToolsNone", on: { click: () => { setAll("none"); changed(); } } }, "Clear")),
      groupsBox], { group: true });

    // The summary: what the key will be, or the first thing that is missing. One line.
    const summary = h("p", { class: "mcpSummary", id: "mcpSummary", "aria-live": "polite" });
    const toNumber = (input) => (input.value.trim() === "" ? null : Number(input.value));
    const pickedHosts = () => hostBoxes.filter((box) => box.input.checked).map((box) => box.input.value);
    const pickedTools = () => toolRows.filter((item) => item.select.value === "read" && !item.select.disabled).map((item) => item.tool.name);
    // What the form holds, in the shape of ns.api.createMcpKey / updateMcpKey.
    function read() {
      return {
        name: name.value.trim(),
        hosts: pickedHosts(),
        databases: patternList(),
        tools: pickedTools(),
        maxRows: toNumber(rows),
        timeoutSeconds: toNumber(timeout),
      };
    }
    function update() {
      const input = read();
      const problems = checkInput(meta, input);
      summary.replaceChildren();
      summary.classList.toggle("is-warn", problems.length > 0);
      if (problems.length) {
        summary.append(h("span", { class: "mcpSummary__label" }, "To do"), h("span", null, problems.map((problem) => problem.short).join(" · ")));
        return;
      }
      const bits = [
        input.name,
        input.hosts.length === 1 ? input.hosts[0] : `${input.hosts.length} hosts`,
        isEverything() ? "all the data" : `${input.databases.length} ${input.databases.length === 1 ? "pattern" : "patterns"}`,
        `${input.tools.length} of ${toolRows.length} permissions, read-only`,
        `${input.maxRows != null ? ns.format.count(input.maxRows) : limits.maxRows != null ? ns.format.count(limits.maxRows) : EMPTY} rows`,
        `${input.timeoutSeconds != null ? input.timeoutSeconds : limits.queryTimeoutSeconds != null ? limits.queryTimeoutSeconds : EMPTY} s`,
      ];
      summary.append(h("span", { class: "mcpSummary__label" }, "Key"), h("span", null, bits.join(" · ")));
    }

    const side = h("div", { class: "mcpKeyForm__side" }, nameField, hostsField, dataField, limitsRow);
    const perms = h("div", { class: "mcpKeyForm__perms" }, toolsField);
    form.append(side, perms, summary);
    // A hint is the description of its field: a screen reader reads it with the label.
    for (const wrap of $$("[data-wrap]", form)) {
      const hint = $(".uiField__hint", wrap);
      const control = $("[data-field]", wrap);
      if (!hint || !control) continue;
      hint.id = `mcpFieldHint-${wrap.dataset.wrap}`;
      control.setAttribute("aria-describedby", hint.id);
    }
    form.addEventListener("input", update);
    form.addEventListener("change", update);
    patterns.addEventListener("input", syncTools);

    syncTools();
    update();
    return { form, read, focusName: name };
  }

  // The error of one field (name: the server's field): its text, aria-invalid and the focus.
  function showFieldError(frame, field, text, { focus = true } = {}) {
    const wrap = $(`[data-wrap="${CSS.escape(field)}"]`, frame);
    if (!wrap) return false;
    const error = $(".uiField__error", wrap);
    error.textContent = text;
    error.hidden = false;
    const control = $("[data-field]", wrap);
    if (control) {
      control.setAttribute("aria-invalid", "true");
      const hint = $(".uiField__hint", wrap);
      control.setAttribute("aria-describedby", hint ? `${error.id} ${hint.id}` : error.id);
      if (focus) control.focus();
    }
    return true;
  }

  function clearFieldErrors(frame) {
    for (const error of $$(".uiField__error", frame)) {
      error.hidden = true;
      error.textContent = "";
    }
    for (const control of $$("[aria-invalid]", frame)) {
      control.removeAttribute("aria-invalid");
      const hint = $(".uiField__hint", control.closest("[data-wrap]"));
      if (hint) control.setAttribute("aria-describedby", hint.id);
      else control.removeAttribute("aria-describedby");
    }
  }

  // Every problem the form can see without the server, as [{ field, text, short }], in the order of the
  // form. `short` is the few words of the summary line.
  function checkInput(meta, input) {
    let pattern = null;
    try { pattern = new RegExp(meta.namePattern); } catch { pattern = null; }
    const found = [];
    if (!input.name) found.push({ field: "name", text: "Enter a name.", short: "a name" });
    else if (pattern && !pattern.test(input.name)) found.push({ field: "name", text: "Use lower-case letters, digits, - and _, starting with a letter or a digit, 32 characters at most.", short: "a valid name" });
    if (!input.hosts.length) found.push({ field: "hosts", text: "Select at least one host.", short: "a host" });
    if (!input.databases.length) found.push({ field: "databases", text: "Enter at least one data pattern (* for all the data).", short: "data (a pattern, or *)" });
    if (!input.tools.length) found.push({ field: "tools", text: "Give at least one permission read-only access.", short: "a permission" });
    for (const [field, value] of [["max_rows", input.maxRows], ["timeout_seconds", input.timeoutSeconds]]) {
      if (value !== null && (!Number.isInteger(value) || value < 1)) found.push({ field, text: "Enter a whole number of 1 or more, or leave it empty.", short: field === "max_rows" ? "a valid row limit" : "a valid timeout" });
    }
    return found;
  }

  function openKeyForm({ meta, key = null, submit }) {
    const { form, read, focusName } = buildForm(meta, key);
    const editing = !!key;
    return ns.dialog.open({
      title: editing ? `Edit key ${key.name}` : "New key",
      body: form,
      size: "sm",
      className: "mcpDialog mcpDialog--key",
      closeLabel: "Close",
      focus: focusName,
      actions: [
        { label: "Cancel", value: null },
        { label: editing ? "Save changes" : "Create key", value: "submit", kind: "primary", submit: true },
      ],
      // The button is off while the key cannot be valid: its title names the first thing that is missing.
      validate: () => checkInput(meta, read())[0]?.text || "",
      async onSubmit(_value, frame) {
        clearFieldErrors(frame);
        const input = read();
        const problems = checkInput(meta, input);
        if (problems.length) {
          problems.forEach((problem, index) => showFieldError(frame, problem.field, problem.text, { focus: index === 0 }));
          return false;
        }
        try {
          return await submit(input);
        } catch (error) {
          const info = error?.mcp;
          const field = info?.field || (info?.code === "name_taken" ? "name" : "");
          if (info && field && (info.code === "validation" || info.code === "name_taken")) {
            const text = info.message || REASON_TEXT[info.reason] || "This value is not accepted.";
            if (showFieldError(frame, field, text)) return false;
          }
          throw error;
        }
      },
    });
  }

  // --- The details of a key --------------------------------------------------------------

  // The tools a key holds: the names it lists, or every tool it can hold when it lists "*" (the SQL tools
  // only when its data is "*" alone).
  function grantedTools(meta, key) {
    const everything = key.databases.length === 1 && key.databases[0] === "*";
    const all = key.tools.includes("*");
    return meta.tools.filter((tool) => (all ? !tool.needsAllData || everything : key.tools.includes(tool.name)));
  }

  function showKey({ meta, key, canManage = false }) {
    const granted = grantedTools(meta, key);
    const held = new Set(granted.map((tool) => tool.name));
    const [tone, stateLabel] = key.state === "disabled" ? ["neutral", "Disabled"] : ["ok", "Active"];
    const list = (values, allText) => {
      if (!values.length) return h("span", { class: "mcpMuted" }, "None");
      if (values.includes("*")) return h("span", null, allText);
      return h("span", { class: "mcpChips" }, values.map((value) => h("code", { class: "mcpChip" }, value)));
    };
    const limitOf = (own, global, unit) => (own != null ? `${ns.format.count(own)}${unit}` : global != null ? `${ns.format.count(global)}${unit} (default)` : EMPTY);
    const everything = key.databases.length === 1 && key.databases[0] === "*";
    const facts = h("dl", { class: "mcpAbout" },
      h("dt", null, "State"), h("dd", null, ns.badge.el(stateLabel, { tone }), " ", ns.badge.el(key.source === "config" ? "config file" : "page", { tone: "neutral", title: key.source === "config" ? "Defined in the config file: read-only here." : "Made on this page." })),
      h("dt", null, "Secret"), h("dd", null, ns.mcpView.secretCell(key)),
      h("dt", null, "Hosts"), h("dd", null, list(key.hosts, "Every host that has an mcp_uri")),
      h("dt", null, "Data"), h("dd", null, everything ? h("span", null, h("code", { class: "mcpChip" }, "*"), " all the data") : list(key.databases, "All the data")),
      h("dt", null, "Limits"), h("dd", null, `${limitOf(key.maxRows, meta.limits.maxRows, " rows")} · ${limitOf(key.timeoutSeconds, meta.limits.queryTimeoutSeconds, " s")}`));

    // Permissions: every tool of the server, grouped; the ones the key holds, then the ones it does not.
    const perms = h("div", { class: "mcpGranted" });
    for (const group of GROUPS) {
      const tools = meta.tools.filter((tool) => tool.group === group.id);
      if (!tools.length) continue;
      perms.appendChild(h("div", { class: "mcpToolGroup" },
        h("div", { class: "mcpToolGroup__head" }, h("span", { class: "mcpToolGroup__title" }, group.title), h("span", { class: "mcpMuted" }, group.note)),
        h("ul", { class: "mcpGrants" }, tools.map((tool) => {
          const yes = held.has(tool.name);
          return h("li", { class: `mcpGrant${yes ? "" : " is-off"}`, dataset: { tool: tool.name, held: yes ? "yes" : "no" }, title: plainText(tool.description) },
            h("span", { class: "mcpGrant__name" }, tool.name),
            h("span", { class: "mcpGrant__note" }, firstSentence(tool.description)),
            h("span", { class: "mcpGrant__level" }, yes ? "Read-only" : "No access"));
        }))));
    }
    const body = h("div", { class: "mcpDetails" }, facts,
      h("div", { class: "mcpDetails__perms" }, h("h3", { class: "mcpDetails__title" }, "Permissions", h("span", { class: "pagePart__count" }, `${granted.length} of ${meta.tools.length}`)), perms));

    const actions = [{ label: "Close", value: null }];
    if (canManage) {
      actions.push(
        { label: "Delete", value: "remove", kind: "danger" },
        { label: "Rotate secret", value: "rotate" },
        { label: key.enabled ? "Disable" : "Enable", value: "toggle" },
        { label: "Edit", value: "edit", kind: "primary", submit: true });
    }
    return ns.dialog.open({ title: `Key ${key.name}`, body, size: "sm", className: "mcpDialog mcpDialog--details", closeLabel: "Close", actions });
  }

  // --- The secret ------------------------------------------------------------------------

  function showSecret({ meta, key, secret, rotated = false }) {
    const url = ns.mcpView.endpointUrl(meta);
    const body = h("div", { class: "mcpReveal" });
    body.append(
      h("p", { class: "mcpReveal__lead" }, rotated
        ? `The secret of key ${key.name} changed. The old secret stopped working at once. Update every client that uses it.`
        : `Key ${key.name} is ready.`),
      h("p", { class: "mcpReveal__warn", role: "note" }, "Put the secret in your client now. You can show it again later: use the eye button of the key in the table."),
      h("div", { class: "uiField" },
        h("label", { class: "uiField__label", for: "mcpSecret" }, "Secret"),
        h("div", { class: "uiField__row" },
          h("input", { id: "mcpSecret", class: "uiInput uiInput--mono", type: "text", readonly: true, value: secret, spellcheck: "false", autocomplete: "off" }),
          ns.copy.button(null, () => secret, { label: "Copy the secret", className: "mcpEndpoint__copy" }))),
      h("div", { class: "uiField" },
        h("div", { class: "uiField__label", id: "mcpConnectLabel" }, "Connect a client"),
        ns.mcpView.clientTabs(url, key.name, secret, "mcpRevealClient")),
    );
    return ns.dialog.open({
      title: rotated ? "New secret" : "Key created",
      body,
      size: "sm",
      className: "mcpDialog mcpDialog--secret",
      actions: [{ label: "Done", value: "done", kind: "primary", submit: true }],
    }).then(() => {
      // The dialog is gone; the nodes that held the secret go with it.
      body.replaceChildren();
    });
  }

  ns.mcpForm = Object.freeze({ openKeyForm, showKey, showSecret, REASON_TEXT });
})();
