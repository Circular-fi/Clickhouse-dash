(() => {
  "use strict";
  // The key form and the secret panel of the MCP integration page (docs/mcp-integration-page.md).
  //
  //   ns.mcpForm.openKeyForm({ meta, key, submit })   Promise<result | null>
  //       A dialog (ns.dialog) to create a key (key: null) or to edit one. submit(input) sends it
  //       (ns.api.createMcpKey / updateMcpKey) and returns the answer, which resolves the promise. A
  //       validation error of the server (err.mcp.field, err.mcp.reason) shows under its field and the
  //       dialog stays open; any other error shows at the foot of the dialog.
  //   ns.mcpForm.showSecret({ meta, key, secret, rotated })   Promise<void>
  //       The one-time panel after a create or a rotation: the secret and the commands that connect a
  //       client. Nothing of it stays: the dialog and its nodes go when it closes, and the secret is
  //       never written to localStorage, sessionStorage or the address.
  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
  const { $, $$ } = ns.dom;
  const EMPTY = ns.format.EMPTY;

  const GROUPS = [
    { id: "schema", title: "Schema", note: "Names, columns and engines. Never rows." },
    { id: "read", title: "Read", note: "Rows of a table that ChDash selects for the client." },
    { id: "sql", title: "SQL", note: "Free SQL written by the client." },
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

  function checkbox({ id, label, checked, disabled = false, title = "", value = "", note = "" }) {
    const input = h("input", { type: "checkbox", id, value, checked: !!checked, disabled: !!disabled || null });
    input.checked = !!checked;
    input.disabled = !!disabled;
    const text = h("span", { class: "uiCheck__text" }, h("span", { class: "uiCheck__label" }, label), note ? h("span", { class: "uiCheck__note" }, note) : null);
    const wrap = h("label", { class: `uiCheck${disabled ? " is-disabled" : ""}`, for: id, title: title || null }, input, text);
    return { wrap, input };
  }

  // A section of the form, with the heading and the sentence of the GitHub token page.
  function section(title, lead, ...fields) {
    return h("section", { class: "mcpSection" },
      h("div", { class: "mcpSection__head" }, h("h3", { class: "mcpSection__title" }, title), lead ? h("p", { class: "mcpNote" }, lead) : null),
      ...fields);
  }

  // --- The key form ----------------------------------------------------------------------

  // The form follows the page that makes a fine-grained token of GitHub: a name, the access (the
  // repositories there, the hosts and the data here), a list of permissions each with its access
  // level, and an overview that says what the key will be able to do.
  function buildForm(meta, key) {
    const editing = !!key;
    const hostNames = meta.hosts.map((host) => host.name);
    const allHosts = editing ? key.hosts.includes("*") : false;
    const allData = editing ? key.databases.includes("*") : false;  // the pattern * is all of it
    const startTools = editing ? new Set(key.tools.includes("*") ? meta.tools.map((tool) => tool.name) : key.tools) : new Set(meta.tools.filter((tool) => !tool.needsAllData).map((tool) => tool.name));

    const form = h("div", { class: "uiForm mcpKeyForm" });

    // Name.
    const name = h("input", { id: "mcpField-name", class: "uiInput", type: "text", name: "name", dataset: { field: "name" }, autocomplete: "off", spellcheck: "false", maxlength: "64", placeholder: "ci-bot", value: key?.name || "" });
    const identity = section("Key name", "",
      fieldWrap("name", "Name", name, { hint: "Lower-case letters, digits, - and _. The client shows it as the server name." }));

    // Host access: the hosts that have an mcp_uri, at least one ticked. A single host is ticked and
    // cannot be unticked. A key made with every host (hosts = ["*"]) opens with all of them ticked.
    const hostBoxes = [];
    const hostGrid = h("div", { class: "uiChecks mcpHostGrid" });
    const known = new Set(hostNames);
    const hostRows = [...meta.hosts.map((host) => ({ name: host.name, note: host.label && host.label !== host.name ? host.label : "" })),
      ...(editing ? key.hosts.filter((host) => host !== "*" && !known.has(host)).map((host) => ({ name: host, note: "no mcp_uri now" })) : [])];
    const only = hostRows.length === 1;
    hostRows.forEach((host, index) => {
      const box = checkbox({
        id: `mcpHost-${index}`,
        label: host.name,
        checked: only || (editing && (allHosts || key.hosts.includes(host.name))),
        disabled: only,
        title: only ? "The only host that has an mcp_uri: a key needs at least one host." : "",
        value: host.name,
        note: host.note,
      });
      if (index === 0) box.input.dataset.field = "hosts";
      hostBoxes.push(box);
      hostGrid.appendChild(box.wrap);
    });
    const hostsField = fieldWrap("hosts", "Host access", hostGrid,
      { group: true, hint: hostRows.length ? "Select at least one host. A key reads no host that it does not list." : "No host has an mcp_uri in the config: a key cannot read data." });

    // Data access: the patterns, one per line. * alone is every database and table.
    const patterns = h("textarea", { id: "mcpField-databases", class: "uiInput uiInput--area uiInput--mono", name: "databases", dataset: { field: "databases" }, rows: "3", spellcheck: "false", autocomplete: "off", placeholder: "otel\nanalytics.events\nlogs_*.*" });
    patterns.value = editing ? key.databases.join("\n") : "";
    const dataField = fieldWrap("databases", "Data access", patterns,
      { hint: "One pattern per line: db, db.table, or * as a wildcard in either part. * alone is all the data the MCP user can read." });
    const access = section("Access", "What the key can reach.", hostsField, dataField);

    // Permissions: each tool is a row with its access level. Every tool reads: there is no write.
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
      const reason = h("div", { class: "mcpToolGroup__reason" });
      reason.id = `mcpToolReason-${group.id}`;
      reason.hidden = true;
      groupsBox.appendChild(h("div", { class: "mcpToolGroup" }, h("div", { class: "mcpToolGroup__head" }, h("span", { class: "mcpToolGroup__title" }, group.title), h("span", { class: "mcpMuted" }, group.note)), list, reason));
    }
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
    const setAll = (value) => { for (const item of toolRows) if (!item.select.disabled) item.select.value = value; };
    const toolsTools = h("div", { class: "mcpToolsTools" },
      h("button", { type: "button", class: "button button--small", id: "mcpToolsAll", on: { click: () => { setAll("read"); update(); } } }, "Select all"),
      h("button", { type: "button", class: "button button--small", id: "mcpToolsNone", on: { click: () => { setAll("none"); update(); } } }, "Clear"));
    const toolsField = fieldWrap("tools", "Permissions", [toolsTools, groupsBox], { group: true, hint: "Every permission is read-only: a key cannot change your data." });
    const permissions = section("Permissions", "Choose what the client can call.", toolsField);

    // Limits.
    const limits = meta.limits;
    const number = (id, field, value, max, placeholder) => h("input", { id, class: "uiInput", type: "number", name: field, dataset: { field }, min: "1", max: max != null ? String(max) : null, step: "1", inputmode: "numeric", placeholder, value: value != null ? String(value) : "" });
    const rows = number("mcpField-max_rows", "max_rows", key?.maxRows, limits.maxRows, limits.maxRows != null ? `Default ${ns.format.count(limits.maxRows)}` : "Default");
    const timeout = number("mcpField-timeout_seconds", "timeout_seconds", key?.timeoutSeconds, limits.queryTimeoutSeconds, limits.queryTimeoutSeconds != null ? `Default ${limits.queryTimeoutSeconds} s` : "Default");
    const limitsRow = section("Limits", "A key can lower the global limits. It never raises them.", h("div", { class: "mcpFieldRow" },
      fieldWrap("max_rows", "Max rows", rows, { hint: "Empty keeps the global limit." }),
      fieldWrap("timeout_seconds", "Timeout (seconds)", timeout, { hint: "Empty keeps the global limit." }),
    ));

    // The overview: what the key will be, as the fields say it now.
    const overview = h("aside", { class: "mcpOverview", "aria-label": "Overview of the key" });
    const overviewList = h("dl", { class: "mcpOverview__list" });
    overview.append(h("h3", { class: "mcpSection__title" }, "Overview"), overviewList,
      h("p", { class: "mcpNote mcpNote--fine" }, "The secret is shown in the keys table, with the eye button, whenever you need it."));
    const overviewRow = (label, value, tone = "") => {
      overviewList.append(h("dt", null, label), h("dd", tone ? { class: `mcpOverview__${tone}` } : null, value));
    };
    const toNumber = (input) => (input.value.trim() === "" ? null : Number(input.value));
    const patternList = () => [...new Set(patterns.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
    const isEverything = () => { const list = patternList(); return list.length === 1 && list[0] === "*"; };
    const pickedHosts = () => hostBoxes.filter((box) => box.input.checked).map((box) => box.input.value);
    const pickedTools = () => toolRows.filter((item) => item.select.value === "read" && !item.select.disabled).map((item) => item.tool.name);
    function update() {
      overviewList.replaceChildren();
      overviewRow("Name", name.value.trim() || "Not set", name.value.trim() ? "" : "muted");
      const hosts = pickedHosts();
      overviewRow("Hosts", hosts.length ? hosts.join(", ") : "None selected", hosts.length ? "" : "warn");
      const data = patternList();
      overviewRow("Data", isEverything() ? "* (all data)" : data.length ? `${data.length} ${data.length === 1 ? "pattern" : "patterns"}` : "None selected", data.length ? "" : "warn");
      const tools = pickedTools();
      overviewRow("Permissions", `${tools.length} of ${toolRows.length}, read-only`, tools.length ? "" : "warn");
      const rowCap = toNumber(rows);
      const timeCap = toNumber(timeout);
      overviewRow("Max rows", rowCap != null ? ns.format.count(rowCap) : `${limits.maxRows != null ? ns.format.count(limits.maxRows) : EMPTY} (default)`, rowCap != null ? "" : "muted");
      overviewRow("Timeout", timeCap != null ? `${timeCap} s` : `${limits.queryTimeoutSeconds != null ? limits.queryTimeoutSeconds : EMPTY} s (default)`, timeCap != null ? "" : "muted");
    }

    const main = h("div", { class: "mcpKeyForm__main" }, identity, access, permissions, limitsRow);
    form.append(main, overview);
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

  // Every problem the form can see without the server, as [{ field, text }], in the order of the form.
  function checkInput(meta, input) {
    let pattern = null;
    try { pattern = new RegExp(meta.namePattern); } catch { pattern = null; }
    const found = [];
    if (!input.name) found.push({ field: "name", text: "Enter a name." });
    else if (pattern && !pattern.test(input.name)) found.push({ field: "name", text: "Use lower-case letters, digits, - and _, starting with a letter or a digit, 64 characters at most." });
    if (!input.hosts.length) found.push({ field: "hosts", text: "Select at least one host." });
    if (!input.databases.length) found.push({ field: "databases", text: "Enter at least one data pattern (* for all the data)." });
    if (!input.tools.length) found.push({ field: "tools", text: "Give at least one permission read-only access." });
    for (const [field, value] of [["max_rows", input.maxRows], ["timeout_seconds", input.timeoutSeconds]]) {
      if (value !== null && (!Number.isInteger(value) || value < 1)) found.push({ field, text: "Enter a whole number of 1 or more, or leave it empty." });
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
      async onSubmit(_value, frame) {
        clearFieldErrors(frame);
        const input = read();
        const problems = checkInput(meta, input);
        if (problems.length) {
          // All of them show at once; the focus goes to the first.
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

  // --- The one-time secret ---------------------------------------------------------------

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

  ns.mcpForm = Object.freeze({ openKeyForm, showSecret, REASON_TEXT });
})();
