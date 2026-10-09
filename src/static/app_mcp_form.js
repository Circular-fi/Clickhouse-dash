(() => {
  "use strict";
  // The dialogs of the MCP integration page (docs/mcp-integration-page.md).
  //
  //   ns.mcpForm.openKeyForm({ meta, submit })        Promise<result | null>
  //       The dialog (ns.dialog) that makes a key. A key is made or deleted, never changed, so there is no
  //       edit form. The name, the hosts, the data and the limits are at the left; at the right the
  //       permissions, one card for each family of tools (a group of the server's table), with one check
  //       box for the family and, behind the arrow, one for each tool. The form fits the dialog without a
  //       scroll. The submit button stays off, and says why in its title, until the key is valid.
  //       submit(input) sends it (ns.api.createMcpKey) and returns the answer, which resolves the promise.
  //       A validation error of the server (err.mcp.field, err.mcp.reason) shows under its field and the
  //       dialog stays open; any other error shows at the foot of the dialog.
  //   ns.mcpForm.keyDetails({ meta, key })             the details of a key (a node): its facts and its permissions by family
  //       The details of a key: its source, its hosts, its data, its limits and every permission it
  //       holds, by family, with what each one does. It is read-only.
  //   ns.mcpForm.showSecret({ meta, key, secret })   Promise<void>
  //       The panel after a create: the secret and the commands that connect a client. Nothing of it stays:
  //       the dialog and its nodes go when it closes, and the secret is never written to localStorage,
  //       sessionStorage or the address.
  const ns = window.ChDash;
  if (!ns) return;
  const { h } = ns;
  const { $, $$ } = ns.dom;
  const EMPTY = ns.format.EMPTY;

  // The tools that a new key holds: the schema and the read tools. The other families are chosen.
  const DEFAULT_GROUPS = new Set(["schema", "read"]);
  const NEEDS_EVERYTHING = "Needs the data pattern * alone: ChDash cannot limit this tool to some tables.";

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

  // The groups that have tools, in the order of the server, then any group that the server forgot to list.
  function groupsOf(meta) {
    const known = meta.toolGroups.filter((group) => meta.tools.some((tool) => tool.group === group.id));
    const ids = new Set(known.map((group) => group.id));
    const extra = [...new Set(meta.tools.map((tool) => tool.group))].filter((id) => !ids.has(id)).map((id) => ({ id, title: id, note: "" }));
    return [...known, ...extra];
  }

  // --- Fields ----------------------------------------------------------------------------

  // A field: its label, the control(s), a hint and the place where its error shows.
  function fieldWrap(name, label, content, { hint = "", group = false, required = true } = {}) {
    const wrap = h(group ? "fieldset" : "div", { class: "uiField", dataset: { wrap: name } });
    const error = h("div", { class: "uiField__error", id: `mcpFieldError-${name}`, role: "alert", hidden: true });
    const text = [label, required ? h("span", { class: "mcpRequired", title: "Required", "aria-hidden": "true" }, " *") : null];
    if (group) wrap.appendChild(h("legend", { class: "uiField__label" }, ...text));
    else wrap.appendChild(h("label", { class: "uiField__label", for: `mcpField-${name}` }, ...text));
    wrap.append(...[].concat(content));
    if (hint) wrap.appendChild(h("div", { class: "uiField__hint" }, hint));
    wrap.appendChild(error);
    return wrap;
  }

  function checkbox({ id, label, checked, disabled = false, title = "", value = "", mono = false }) {
    const input = h("input", { type: "checkbox", id, value, checked: !!checked, disabled: !!disabled || null });
    input.checked = !!checked;
    input.disabled = !!disabled;
    const text = h("span", { class: "uiCheck__text" }, h("span", { class: mono ? "uiCheck__label mcpMono" : "uiCheck__label" }, label));
    const wrap = h("label", { class: `uiCheck${disabled ? " is-disabled" : ""}`, for: id, title: title || null }, input, text);
    return { wrap, input };
  }

  // --- The key form ----------------------------------------------------------------------

  // The form follows the page that makes a fine-grained token on GitHub: a name, the access (the
  // repositories there, the hosts and the data here) and the permissions. Every permission is read-only,
  // so each one is a check box: there is no level to choose.
  function buildForm(meta) {
    const form = h("div", { class: "uiForm mcpKeyForm" });

    // Name.
    const name = h("input", { id: "mcpField-name", class: "uiInput", type: "text", name: "name", dataset: { field: "name" }, autocomplete: "off", spellcheck: "false", maxlength: "32", placeholder: "ci-bot" });
    const nameField = fieldWrap("name", "Name", name, { hint: "a-z, 0-9, - and _, 32 characters at most." });

    // Hosts: the hosts that have an mcp_uri, one under the other, at least one ticked. A single host is
    // ticked and cannot be unticked.
    const hostBoxes = [];
    const hostList = h("div", { class: "uiChecks mcpHostChecks" });
    const only = meta.hosts.length === 1;
    meta.hosts.forEach((host, index) => {
      const box = checkbox({
        id: `mcpHost-${index}`,
        label: host.name,
        checked: only,
        disabled: only,
        title: only ? "The only host that has an mcp_uri: a key needs at least one host." : host.label,
        value: host.name,
      });
      if (host.label && host.label !== host.name) $(".uiCheck__text", box.wrap).appendChild(h("span", { class: "uiCheck__note" }, host.label));
      if (index === 0) box.input.dataset.field = "hosts";
      hostBoxes.push(box);
      hostList.appendChild(box.wrap);
    });
    if (!meta.hosts.length) hostList.appendChild(h("p", { class: "mcpNote" }, "No host has an mcp_uri in the config: a key cannot read data."));
    const hostsField = fieldWrap("hosts", "Hosts", hostList, { group: true });

    // Data: the patterns, one per line. * alone is every database and table.
    const patterns = h("textarea", { id: "mcpField-databases", class: "uiInput uiInput--area uiInput--mono", name: "databases", dataset: { field: "databases" }, rows: "3", spellcheck: "false", autocomplete: "off", placeholder: "otel\nanalytics.events\nlogs_*.*" });
    const dataField = fieldWrap("databases", "Data", patterns, { hint: "One pattern per line: db, db.table, * as a wildcard. * alone is everything." });

    // Limits.
    const limits = meta.limits;
    const number = (id, field, max, placeholder) => h("input", { id, class: "uiInput", type: "number", name: field, dataset: { field }, min: "1", max: max != null ? String(max) : null, step: "1", inputmode: "numeric", placeholder });
    const rows = number("mcpField-max_rows", "max_rows", limits.maxRows, limits.maxRows != null ? `Default ${ns.format.count(limits.maxRows)}` : "Default");
    const timeout = number("mcpField-timeout_seconds", "timeout_seconds", limits.queryTimeoutSeconds, limits.queryTimeoutSeconds != null ? `Default ${limits.queryTimeoutSeconds} s` : "Default");
    const limitsRow = h("div", { class: "mcpFieldRow" },
      fieldWrap("max_rows", "Max rows", rows, { required: false }),
      fieldWrap("timeout_seconds", "Timeout (s)", timeout, { required: false }));

    // Permissions: one card for each family. The check box of a card is all its tools; the arrow opens
    // the tools, one check box each.
    const toolBoxes = [];
    const cards = [];
    const groupsBox = h("div", { class: "mcpGroups" });
    for (const group of groupsOf(meta)) {
      const tools = meta.tools.filter((tool) => tool.group === group.id);
      const body = h("div", { class: "mcpGroup__body", id: `mcpGroupBody-${group.id}`, hidden: true });
      // A family of one tool has nothing to open: its check box is the tool itself, no arrow.
      const single = tools.length === 1;
      const members = tools.map((tool) => {
        const box = checkbox({
          id: `mcpTool-${tool.name}`,
          label: tool.name,
          checked: DEFAULT_GROUPS.has(group.id) && !tool.needsAllData,
          title: plainText(tool.description),
          value: tool.name,
          mono: true,
        });
        if (!single) box.wrap.appendChild(h("span", { class: "mcpGroup__tip" }, firstSentence(tool.description)));
        box.tool = tool;
        if (!single) body.appendChild(box.wrap);
        toolBoxes.push(box);
        return box;
      });
      if (single) {
        const only = members[0];
        const reason = h("span", { class: "mcpGroup__reason" });
        reason.hidden = true;
        only.wrap.classList.add("mcpGroup__only");
        const card = h("div", { class: "mcpGroup mcpGroup--single", dataset: { group: group.id } },
          h("div", { class: "mcpGroup__head" }, only.wrap, h("span", { class: "mcpGroup__note" }, group.note), reason));
        groupsBox.appendChild(card);
        cards.push({ group, card, single: true, all: only, members, reason, count: null });
        continue;
      }
      const all = checkbox({ id: `mcpGroup-${group.id}`, label: group.title, checked: false, title: group.note });
      const count = h("span", { class: "mcpGroup__count" });
      const toggle = h("button", { type: "button", class: "button button--small mcpGroup__toggle", "aria-expanded": "false", "aria-controls": body.id, title: `Choose the tools of ${group.title}`, "aria-label": `Choose the tools of ${group.title}` },
        ns.icon.el("chevron-down", { size: "sm" }));
      const reason = h("span", { class: "mcpGroup__reason" });
      reason.hidden = true;
      const card = h("div", { class: "mcpGroup", dataset: { group: group.id } },
        h("div", { class: "mcpGroup__head" }, all.wrap, h("span", { class: "mcpGroup__note" }, group.note), reason, count, toggle), body);
      toggle.addEventListener("click", () => {
        const open = body.hidden;
        body.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        card.classList.toggle("is-open", open);
      });
      // On "input", not "change": the form's own "input" listener (the summary of the state) runs after this
      // one, whereas it would run first and undo the click.
      all.input.addEventListener("input", () => {
        for (const box of members) if (!box.input.disabled) box.input.checked = all.input.checked;
      });
      groupsBox.appendChild(card);
      cards.push({ group, card, all, members, count, reason });
    }
    if (cards.length) cards[0].all.input.dataset.field = "tools";

    const patternList = () => [...new Set(patterns.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
    const isEverything = () => { const list = patternList(); return list.length === 1 && list[0] === "*"; };
    // The tools that need all the data are locked, and cleared, until the data is *.
    const sync = () => {
      const everything = isEverything();
      for (const box of toolBoxes) {
        const locked = box.tool.needsAllData && !everything;
        if (locked) box.input.checked = false;
        box.input.disabled = locked;
        box.wrap.classList.toggle("is-disabled", locked);
        box.wrap.title = locked ? NEEDS_EVERYTHING : plainText(box.tool.description);
      }
      for (const item of cards) {
        if (item.single) {
          const locked = item.members[0].input.disabled;
          item.card.classList.toggle("has-tools", item.members[0].input.checked);
          item.reason.hidden = !locked;
          item.reason.textContent = locked ? "needs data *" : "";
          item.reason.title = NEEDS_EVERYTHING;
          continue;
        }
        const free = item.members.filter((box) => !box.input.disabled);
        const on = free.filter((box) => box.input.checked).length;
        item.all.input.disabled = !free.length;
        item.all.input.checked = free.length > 0 && on === free.length;
        item.all.input.indeterminate = on > 0 && on < free.length;
        item.all.wrap.classList.toggle("is-disabled", !free.length);
        item.count.textContent = `${on}/${item.members.length}`;
        item.card.classList.toggle("has-tools", on > 0);
        // A family that is all locked says why in its head.
        item.reason.hidden = !!free.length;
        item.reason.textContent = free.length ? "" : "needs data *";
        item.reason.title = NEEDS_EVERYTHING;
      }
    };
    const toolsField = fieldWrap("tools", "Permissions", groupsBox, { group: true });

    const toNumber = (input) => (input.value.trim() === "" ? null : Number(input.value));
    const pickedHosts = () => hostBoxes.filter((box) => box.input.checked).map((box) => box.input.value);
    const pickedTools = () => toolBoxes.filter((box) => box.input.checked && !box.input.disabled).map((box) => box.input.value);
    // What the form holds, in the shape of ns.api.createMcpKey.
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

    form.append(h("div", { class: "mcpKeyForm__side" }, nameField, hostsField, dataField, limitsRow), h("div", { class: "mcpKeyForm__perms" }, toolsField));
    // A hint is the description of its field: a screen reader reads it with the label.
    for (const wrap of $$("[data-wrap]", form)) {
      const hint = $(".uiField__hint", wrap);
      const control = $("[data-field]", wrap);
      if (!hint || !control) continue;
      hint.id = `mcpFieldHint-${wrap.dataset.wrap}`;
      control.setAttribute("aria-describedby", hint.id);
    }
    form.addEventListener("input", sync);
    form.addEventListener("change", sync);
    sync();
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
    else if (pattern && !pattern.test(input.name)) found.push({ field: "name", text: "Use lower-case letters, digits, - and _, starting with a letter or a digit, 32 characters at most." });
    if (!input.hosts.length) found.push({ field: "hosts", text: "Select at least one host." });
    if (!input.databases.length) found.push({ field: "databases", text: "Enter at least one data pattern (* for all the data)." });
    if (!input.tools.length) found.push({ field: "tools", text: "Give the key at least one permission." });
    for (const [field, value] of [["max_rows", input.maxRows], ["timeout_seconds", input.timeoutSeconds]]) {
      if (value !== null && (!Number.isInteger(value) || value < 1)) found.push({ field, text: "Enter a whole number of 1 or more, or leave it empty." });
    }
    return found;
  }

  function openKeyForm({ meta, submit }) {
    const { form, read, focusName } = buildForm(meta);
    return ns.dialog.open({
      title: "New key",
      body: form,
      size: "sm",
      className: "mcpDialog mcpDialog--key",
      closeLabel: "Close",
      focus: focusName,
      actions: [
        { label: "Cancel", value: null },
        { label: "Create key", value: "submit", kind: "primary", submit: true },
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
  // They show under the key in the table (app_mcp_view.js), one key at a time.

  // The tools a key holds: the names it lists, or every tool it can hold when it lists "*" (the tools that
  // need all the data only when its data is "*" alone).
  function grantedTools(meta, key) {
    const everything = key.databases.length === 1 && key.databases[0] === "*";
    const all = key.tools.includes("*");
    return meta.tools.filter((tool) => (all ? !tool.needsAllData || everything : key.tools.includes(tool.name)));
  }

  function keyDetails({ meta, key }) {
    const granted = grantedTools(meta, key);
    const held = new Set(granted.map((tool) => tool.name));
    const list = (values, allText) => {
      if (!values.length) return h("span", { class: "mcpMuted" }, "None");
      if (values.includes("*")) return h("span", null, allText);
      return h("span", { class: "mcpChips" }, values.map((value) => h("code", { class: "mcpChip" }, value)));
    };
    const limitOf = (own, global, unit) => (own != null ? `${ns.format.count(own)}${unit}` : global != null ? `${ns.format.count(global)}${unit} (default)` : EMPTY);
    const everything = key.databases.length === 1 && key.databases[0] === "*";
    const about = h("dl", { class: "mcpAbout" },
      h("dt", null, "Source"), h("dd", null, key.source === "config" ? "The config file (read-only)" : "This page"),
      h("dt", null, "Hosts"), h("dd", null, list(key.hosts, "Every host that has an mcp_uri")),
      h("dt", null, "Data"), h("dd", null, everything ? h("span", null, h("code", { class: "mcpChip" }, "*"), " all the data") : list(key.databases, "All the data")),
      h("dt", null, "Rows"), h("dd", null, limitOf(key.maxRows, meta.limits.maxRows, "")),
      h("dt", null, "Timeout"), h("dd", null, limitOf(key.timeoutSeconds, meta.limits.queryTimeoutSeconds, " s")));

    // Permissions: the families, each with what the key holds in it (n of m) and the tools it holds.
    // Two columns of the same height. A family weighs its head plus a row for each tool that the key holds in
    // it; the tallest families go first, each into the shorter column, then every column is put back in the
    // order of the families.
    const cards = groupsOf(meta).map((group, index) => {
      const tools = meta.tools.filter((tool) => tool.group === group.id);
      const mine = tools.filter((tool) => held.has(tool.name));
      const node = h("div", { class: `mcpGrantGroup${mine.length ? "" : " is-empty"}`, dataset: { group: group.id } },
        h("div", { class: "mcpGrantGroup__head" }, h("span", { class: "mcpGrantGroup__title" }, group.title), h("span", { class: "mcpGrantGroup__count" }, `${mine.length} of ${tools.length}`)),
        mine.length ? h("ul", { class: "mcpGrants" }, mine.map((tool) => h("li", { class: "mcpGrant", dataset: { tool: tool.name }, title: plainText(tool.description) },
          h("span", { class: "mcpGrant__name" }, tool.name),
          h("span", { class: "mcpGrant__note" }, firstSentence(tool.description))))) : null);
      return { node, index, weight: mine.length ? 1.2 + mine.length : 1.6 };
    });
    const columns = [{ total: 0, cards: [] }, { total: 0, cards: [] }];
    for (const card of [...cards].sort((x, y) => y.weight - x.weight || x.index - y.index)) {
      const column = columns[0].total <= columns[1].total ? columns[0] : columns[1];
      column.cards.push(card);
      column.total += card.weight;
    }
    // The column that holds the first family comes first.
    columns.sort((x, y) => Math.min(...x.cards.map((c) => c.index)) - Math.min(...y.cards.map((c) => c.index)));
    const perms = h("div", { class: "mcpGranted" }, columns.map((column) =>
      h("div", { class: "mcpGrantCol" }, column.cards.sort((x, y) => x.index - y.index).map((card) => card.node))));
    const body = h("div", { class: "mcpDetails" }, about,
      h("div", { class: "mcpDetails__perms" }, h("h3", { class: "mcpDetails__title" }, "Permissions", h("span", { class: "pagePart__count" }, `${granted.length} of ${meta.tools.length}`)), perms));

    return body;
  }

  // --- The secret ------------------------------------------------------------------------

  function showSecret({ meta, key, secret }) {
    const url = ns.mcpView.endpointUrl(meta);
    const body = h("div", { class: "mcpReveal" });
    body.append(
      h("p", { class: "mcpReveal__lead" }, `Key ${key.name} is ready.`),
      h("p", { class: "mcpReveal__warn", role: "note" }, "Put the secret in your client now. You can show it again later: use the eye button of the key in the table."),
      h("div", { class: "uiField" },
        h("label", { class: "uiField__label", for: "mcpSecret" }, "Secret"),
        h("div", { class: "uiField__row" },
          h("input", { id: "mcpSecret", class: "uiInput uiInput--mono", type: "text", readonly: true, value: secret, spellcheck: "false", autocomplete: "off" }),
          ns.copy.button(null, () => secret, { label: "Copy the secret", className: "mcpEndpoint__copy" }))),
      h("div", { class: "uiField" },
        h("div", { class: "uiField__label", id: "mcpConnectLabel" }, "Connect a client"),
        ns.mcpView.clientTabs(url, key.name, secret, "mcpRevealClient", ns.mcpView.authHeader(meta))),
    );
    return ns.dialog.open({
      title: "Key created",
      body,
      size: "sm",
      className: "mcpDialog mcpDialog--secret",
      actions: [{ label: "Done", value: "done", kind: "primary", submit: true }],
    }).then(() => {
      // The dialog is gone; the nodes that held the secret go with it.
      body.replaceChildren();
    });
  }

  ns.mcpForm = Object.freeze({ openKeyForm, keyDetails, showSecret, REASON_TEXT });
})();
