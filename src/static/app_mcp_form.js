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

  const GROUPS = [
    { id: "schema", title: "Schema", note: "Names, columns and engines. Never rows." },
    { id: "read", title: "Read", note: "Rows of a table that ChDash selects for the client." },
    { id: "sql", title: "SQL", note: "Free SQL written by the client." },
  ];
  const NEEDS_ALL_DATA = "Needs All data: ChDash cannot limit free SQL to some tables.";

  // What the server's reason says when it sends no sentence of its own.
  const REASON_TEXT = {
    required: "This field is required.",
    type: "This value has the wrong type.",
    invalid: "This value is not valid.",
    too_long: "This value is too long.",
    unknown_host: "This host has no mcp_uri in the config.",
    unknown_tool: "ChDash does not know this tool.",
    needs_all_data: NEEDS_ALL_DATA,
    duplicate: "This value is listed twice.",
    range: "This number is outside the allowed range.",
    invalid_json: "The request was not valid JSON.",
  };

  const dayOf = (iso) => {
    const ms = Date.parse(iso || "");
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
  };

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

  function checkbox({ id, label, checked, disabled = false, title = "", value = "", note = "", dataField = "" }) {
    const input = h("input", { type: "checkbox", id, value, checked: !!checked, disabled: !!disabled || null, dataset: dataField ? { field: dataField } : null });
    input.checked = !!checked;
    input.disabled = !!disabled;
    const text = h("span", { class: "uiCheck__text" }, h("span", { class: "uiCheck__label" }, label), note ? h("span", { class: "uiCheck__note" }, note) : null);
    const wrap = h("label", { class: `uiCheck${disabled ? " is-disabled" : ""}`, for: id, title: title || null }, input, text);
    return { wrap, input };
  }

  // --- The key form ----------------------------------------------------------------------

  function buildForm(meta, key) {
    const editing = !!key;
    const hostNames = meta.hosts.map((host) => host.name);
    const allHosts = editing ? key.hosts.includes("*") : false;
    const allData = editing ? key.databases.includes("*") : false;
    const startTools = editing ? new Set(key.tools.includes("*") ? meta.tools.map((tool) => tool.name) : key.tools) : new Set(meta.tools.filter((tool) => !tool.needsAllData).map((tool) => tool.name));

    const form = h("div", { class: "uiForm" });

    // Name and description.
    const name = h("input", { id: "mcpField-name", class: "uiInput", type: "text", name: "name", dataset: { field: "name" }, autocomplete: "off", spellcheck: "false", maxlength: "64", placeholder: "ci-bot", value: key?.name || "" });
    const description = h("textarea", { id: "mcpField-description", class: "uiInput uiInput--area", name: "description", dataset: { field: "description" }, rows: "2", placeholder: "What this key is for (optional)" });
    description.value = key?.description || "";
    form.append(
      fieldWrap("name", "Name", name, { hint: "Lower-case letters, digits, - and _. The client shows it as the server name." }),
      fieldWrap("description", "Description", description),
    );

    // Hosts: "All hosts" and one box per host that has an mcp_uri.
    const hostBoxes = [];
    const all = checkbox({ id: "mcpHost-all", label: "All hosts", checked: allHosts, value: "*", note: "Every host that has an mcp_uri, now and later", dataField: "hosts" });
    const hostsBox = h("div", { class: "uiChecks" }, all.wrap);
    const known = new Set(hostNames);
    const hostRows = [...meta.hosts.map((host) => ({ name: host.name, note: host.label && host.label !== host.name ? host.label : "", stale: false })),
      ...(editing ? key.hosts.filter((host) => host !== "*" && !known.has(host)).map((host) => ({ name: host, note: "no mcp_uri now", stale: true })) : [])];
    hostRows.forEach((host, index) => {
      const box = checkbox({ id: `mcpHost-${index}`, label: host.name, checked: allHosts || (editing && key.hosts.includes(host.name)), disabled: allHosts, value: host.name, note: host.note });
      hostBoxes.push(box);
      hostsBox.appendChild(box.wrap);
    });
    const syncHosts = () => {
      for (const box of hostBoxes) {
        if (all.input.checked) box.input.checked = true;
        box.input.disabled = all.input.checked;
        box.wrap.classList.toggle("is-disabled", all.input.checked);
      }
    };
    all.input.addEventListener("change", syncHosts);
    form.appendChild(fieldWrap("hosts", "Hosts", hostsBox, { group: true, hint: "A key reads no host that it does not list." }));

    // Data: All data, or patterns, one per line.
    const radio = (id, value, label, note, checked) => {
      const input = h("input", { type: "radio", name: "mcpData", id, value });
      input.checked = checked;
      return { input, wrap: h("label", { class: "uiCheck", for: id }, input, h("span", { class: "uiCheck__text" }, h("span", { class: "uiCheck__label" }, label), h("span", { class: "uiCheck__note" }, note))) };
    };
    const dataAll = radio("mcpData-all", "all", "All data", "Every database and table the MCP user can read", allData);
    const dataList = radio("mcpData-list", "list", "Selected data", "Only the patterns below", !allData);
    const patterns = h("textarea", { id: "mcpField-databases", class: "uiInput uiInput--area uiInput--mono", name: "databases", dataset: { field: "databases" }, rows: "4", spellcheck: "false", autocomplete: "off", placeholder: "otel\nanalytics.events\nlogs_*.*", "aria-label": "Patterns, one per line" });
    patterns.value = editing && !allData ? key.databases.join("\n") : "";
    form.appendChild(fieldWrap("databases", "Data", [
      h("div", { class: "uiChecks" }, dataAll.wrap, dataList.wrap), patterns,
    ], { group: true, hint: "One pattern per line: db, db.table, or * as a wildcard in either part." }));

    // Tools, grouped, the SQL ones only with All data.
    const toolBoxes = [];
    const toolsBox = h("div", { class: "mcpToolGroups" });
    for (const group of GROUPS) {
      const tools = meta.tools.filter((tool) => tool.group === group.id);
      if (!tools.length) continue;
      const list = h("div", { class: "uiChecks" });
      for (const tool of tools) {
        const box = checkbox({
          id: `mcpTool-${tool.name}`,
          label: tool.name,
          checked: startTools.has(tool.name) && (!tool.needsAllData || allData),
          value: tool.name,
          note: tool.description,
          dataField: toolBoxes.length ? "" : "tools",
        });
        toolBoxes.push({ tool, ...box });
        list.appendChild(box.wrap);
      }
      const reason = h("div", { class: "mcpToolGroup__reason" });
      reason.id = `mcpToolReason-${group.id}`;
      reason.hidden = true;
      toolsBox.appendChild(h("div", { class: "mcpToolGroup" }, h("div", { class: "mcpToolGroup__head" }, h("span", { class: "mcpToolGroup__title" }, group.title), h("span", { class: "mcpMuted" }, group.note)), list, reason));
    }
    const syncTools = () => {
      const everything = dataAll.input.checked;
      for (const box of toolBoxes) {
        const locked = box.tool.needsAllData && !everything;
        if (locked) box.input.checked = false;
        box.input.disabled = locked;
        box.wrap.classList.toggle("is-disabled", locked);
        box.wrap.title = locked ? NEEDS_ALL_DATA : "";
        if (locked) box.input.setAttribute("aria-describedby", "mcpToolReason-sql");
        else box.input.removeAttribute("aria-describedby");
      }
      const sql = $("#mcpToolReason-sql", form);
      if (sql) {
        sql.hidden = everything;
        sql.textContent = everything ? "" : NEEDS_ALL_DATA;
      }
    };
    const syncData = () => {
      patterns.disabled = dataAll.input.checked;
      syncTools();
    };
    dataAll.input.addEventListener("change", syncData);
    dataList.input.addEventListener("change", syncData);
    const toolsTools = h("div", { class: "mcpToolsTools" });
    const setAll = (on) => { for (const box of toolBoxes) if (!box.input.disabled) box.input.checked = on; };
    toolsTools.append(
      h("button", { type: "button", class: "button button--small", id: "mcpToolsAll", on: { click: () => setAll(true) } }, "Select all"),
      h("button", { type: "button", class: "button button--small", id: "mcpToolsNone", on: { click: () => setAll(false) } }, "Clear"),
    );
    form.appendChild(fieldWrap("tools", "Tools", [toolsTools, toolsBox], { group: true }));

    // Limits and expiry.
    const limits = meta.limits;
    const number = (id, field, value, max, placeholder) => h("input", { id, class: "uiInput", type: "number", name: field, dataset: { field }, min: "1", max: max != null ? String(max) : null, step: "1", inputmode: "numeric", placeholder, value: value != null ? String(value) : "" });
    const rows = number("mcpField-max_rows", "max_rows", key?.maxRows, limits.maxRows, limits.maxRows != null ? `Default ${ns.format.count(limits.maxRows)}` : "Default");
    const timeout = number("mcpField-timeout_seconds", "timeout_seconds", key?.timeoutSeconds, limits.queryTimeoutSeconds, limits.queryTimeoutSeconds != null ? `Default ${limits.queryTimeoutSeconds} s` : "Default");
    const expires = h("input", { id: "mcpField-expires_at", class: "uiInput", type: "date", name: "expires_at", dataset: { field: "expires_at" }, value: dayOf(key?.expiresAt) });
    form.appendChild(h("div", { class: "mcpFieldRow" },
      fieldWrap("max_rows", "Max rows", rows, { hint: "Lowers the global limit. Empty keeps it." }),
      fieldWrap("timeout_seconds", "Timeout (seconds)", timeout, { hint: "Lowers the global limit. Empty keeps it." }),
      fieldWrap("expires_at", "Expires", expires, { hint: "The key works until the end of that day (UTC). Empty: never." }),
    ));

    syncHosts();
    syncData();

    // What the form holds, in the shape of ns.api.createMcpKey / updateMcpKey.
    function read() {
      const toNumber = (input) => (input.value.trim() === "" ? null : Number(input.value));
      const list = patterns.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      const day = expires.value;
      return {
        name: name.value.trim(),
        description: description.value.trim(),
        hosts: all.input.checked ? ["*"] : hostBoxes.filter((box) => box.input.checked).map((box) => box.input.value),
        databases: dataAll.input.checked ? ["*"] : [...new Set(list)],
        tools: toolBoxes.filter((box) => box.input.checked && !box.input.disabled).map((box) => box.input.value),
        maxRows: toNumber(rows),
        timeoutSeconds: toNumber(timeout),
        // The same day as before keeps the stored instant; a new day ends that day, in UTC.
        expiresAt: !day ? null : key && dayOf(key.expiresAt) === day ? key.expiresAt : `${day}T23:59:59Z`,
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
      control.setAttribute("aria-describedby", error.id);
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
      control.removeAttribute("aria-describedby");
    }
  }

  // The first problem the form can see without the server, as { field, text } (or null).
  function checkInput(meta, input) {
    let pattern = null;
    try { pattern = new RegExp(meta.namePattern); } catch { pattern = null; }
    if (!input.name) return { field: "name", text: "Enter a name." };
    if (pattern && !pattern.test(input.name)) return { field: "name", text: "Use lower-case letters, digits, - and _, starting with a letter or a digit, 64 characters at most." };
    if (!input.hosts.length) return { field: "hosts", text: "Select at least one host." };
    if (!input.databases.length) return { field: "databases", text: "Choose All data, or enter at least one pattern." };
    if (!input.tools.length) return { field: "tools", text: "Select at least one tool." };
    for (const [field, value] of [["max_rows", input.maxRows], ["timeout_seconds", input.timeoutSeconds]]) {
      if (value !== null && (!Number.isInteger(value) || value < 1)) return { field, text: "Enter a whole number of 1 or more, or leave it empty." };
    }
    return null;
  }

  function openKeyForm({ meta, key = null, submit }) {
    const { form, read, focusName } = buildForm(meta, key);
    const editing = !!key;
    return ns.dialog.open({
      title: editing ? `Edit key ${key.name}` : "New key",
      body: form,
      size: "sm",
      className: "mcpDialog",
      closeLabel: "Close",
      focus: focusName,
      actions: [
        { label: "Cancel", value: null },
        { label: editing ? "Save changes" : "Create key", value: "submit", kind: "primary", submit: true },
      ],
      async onSubmit(_value, frame) {
        clearFieldErrors(frame);
        const input = read();
        const problem = checkInput(meta, input);
        if (problem) {
          showFieldError(frame, problem.field, problem.text);
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
    const { cli, json } = ns.mcpView.commands(url, key.name, secret);
    const body = h("div", { class: "mcpReveal" });
    body.append(
      h("p", { class: "mcpReveal__lead" }, rotated
        ? `The secret of key ${key.name} changed. The old secret stopped working at once.`
        : `Key ${key.name} is ready.`),
      h("p", { class: "mcpReveal__warn" }, "Copy the secret now. ChDash shows it once and cannot show it again."),
      h("label", { class: "uiField__label", for: "mcpSecret" }, "Secret"),
      h("div", { class: "uiField__row" },
        h("input", { id: "mcpSecret", class: "uiInput uiInput--mono", type: "text", readonly: true, value: secret, spellcheck: "false", autocomplete: "off" }),
        ns.copy.button(null, () => secret, { label: "Copy the secret", className: "mcpEndpoint__copy" })),
      h("div", { class: "uiField__label" }, "Claude Code"),
      ns.mcpView.codeBlock(cli, "the command"),
      h("div", { class: "uiField__label" }, "JSON settings of a client"),
      ns.mcpView.codeBlock(json, "the JSON block"),
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
