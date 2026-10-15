// The dialogs of the MCP integration page (docs/mcp-integration-page.md).
//
//   ns.mcpForm.openKeyForm({ meta, submit })        Promise<result | null>
//       The dialog (ns.dialog) that makes a key. A key is made or deleted, never changed, so there is no
//       edit form. The name, the host, the data and the limits are at the left; at the right the
//       permissions, one card for each family of tools (a group of the server's table), with one check
//       box for the family and, behind the arrow, one for each tool. A key reads one host (a radio
//       button for each host that has an mcp_uri): the tools that the MCP user of that host cannot
//       serve are greyed and say which grant is missing, and a host whose MCP user cannot connect
//       cannot be chosen. The submit button stays off, and says why in its title, until the key is valid.
//       Two kinds of tool are not a plain choice (the catalog of the meta says which): a tool that every key has
//       (`always`: the analysis of the key's own limits and usage) shows checked and locked, "Every key has it",
//       and is never sent; a tool that "*" does not give (`explicitOnly`: the usage of all the keys) is a check
//       box of its own, off by default, that no "all" box of the family ticks, and it says so. A tool that the
//       server does not offer now (`available`: the usage is off, or the setting that the tool needs) is not shown.
//       submit(input) sends it (ns.api.createMcpKey) and returns the answer, which resolves the promise.
//       A validation error of the server (err.mcp.field, err.mcp.reason) shows under its field and the
//       dialog stays open; any other error shows at the foot of the dialog.
//   ns.mcpForm.keyDetails({ meta, key, deleted })    the details of a key (a node): its facts and its permissions by family
//       The details of a key: its source, its hosts, its data, its limits and every permission it
//       holds, by family, with what each one does, the data it reads, then what it did (its usage, while the
//       usage is on) and what its statements cost ClickHouse (app_mcp_usage.js). It is read-only. A key that
//       is not in the list but keeps usage (deleted: true: deleted, or known to another instance only) shows
//       its host, when it was deleted (or where it comes from), its usage and its cost only.
//   ns.mcpForm.forgetDetails() / cancelDetails()     the next details read again (Refresh) / the reads in flight stop (they close)
//   ns.mcpForm.showSecret({ meta, key, secret })   Promise<void>
//       The panel after a create: the secret and the commands that connect a client. It is the only time
//       the secret shows: the server keeps its hash, and no call gives it again. Nothing of it stays:
//       the dialog and its nodes go when it closes, and the secret is never written to localStorage,
//       sessionStorage or the address.

import { api } from "./app_api.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { mcpUsage } from "./app_mcp_usage.js";
import { mcpView } from "./app_mcp_view.js";
import { copy } from "./app_ui_copy.js";
import { dialog } from "./app_ui_dialog.js";
import { icon } from "./app_ui_icon.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { $, $$ } = dom;
const EMPTY = format.EMPTY;

// The tools that a new key holds: the data tools (hosts, databases, tables, rows). The other families are chosen.
const DEFAULT_GROUPS = new Set(["data"]);
const NEEDS_EVERYTHING = "Needs the data pattern * alone: ClickHouse Dash cannot limit this tool to some tables.";
// What a tool that is not a plain choice says in the form.
const ALWAYS_NOTE = "Every key has it";
const EXPLICIT_NOTE = "\"*\" does not include it";

// What the server's reason says when it sends no sentence of its own.
const REASON_TEXT = {
  required: "This field is required.",
  type: "This value has the wrong type.",
  invalid: "This value is not valid.",
  too_long: "This value is too long.",
  unknown_host: "This host has no mcp_uri in the config.",
  too_many: "A key reads one host at most: make one key for each host.",
  mcp_user_unavailable: "The MCP user of this host cannot connect.",
  not_grantable: "The MCP user of this host cannot serve this tool.",
  unknown_tool: "ClickHouse Dash does not know this tool.",
  needs_all_data: NEEDS_EVERYTHING,
  duplicate: "This value is listed twice.",
  range: "This number is outside the allowed range.",
  invalid_json: "The request was not valid JSON.",
};

// The description of a tool is written for the model that calls it. The form shows its first
// sentence without the code quotes; the title keeps the whole text.
const plainText = (text) => String(text || "").replace(/`/g, "");
const firstSentence = (text) => plainText(text).split(/(?<=\.)\s/)[0];

// The MCP user of a host, as a phrase: "The MCP user chdash_mcp".
const mcpUser = (host) => (host.mcp.user ? `The MCP user ${host.mcp.user}` : "The MCP user");
// Who lacks the grants of a tool (the MCP user, or the system user for the OpenTelemetry pages).
const lacking = (gap) => `The ${gap.role}${gap.user ? ` ${gap.user}` : ""}`;

// The tools that the server offers now: the form and the details draw these (a tool that is not available is not shown).
const offered = (meta) => meta.tools.filter((tool) => tool.available);

// The groups that have tools, in the order of the server, then any group that the server forgot to list. A family with
// sections (Observability: Traces, Logs, Metrics) is one group for each section ("Observability - Traces"), so that no card
// holds the three signals; a tool of such a family without a known section stays in a group of the family's own title.
// Every group says which tools it owns.
function groupsOf(meta) {
  const catalog = offered(meta);
  const known = meta.toolGroups.filter((group) => catalog.some((tool) => tool.group === group.id));
  const ids = new Set(known.map((group) => group.id));
  const extra = [...new Set(catalog.map((tool) => tool.group))].filter((id) => !ids.has(id)).map((id) => ({ id, title: id, note: "" }));
  const groups = [];
  for (const group of [...known, ...extra]) {
    const sections = (group.sections || []).filter((section) => catalog.some((tool) => tool.group === group.id && tool.section === section.id));
    const sectionIds = new Set(sections.map((section) => section.id));
    if (!sections.length) {
      groups.push({ id: group.id, parent: group.id, title: group.title, note: group.note, owns: (tool) => tool.group === group.id });
      continue;
    }
    if (catalog.some((tool) => tool.group === group.id && !sectionIds.has(tool.section))) {
      groups.push({ id: group.id, parent: group.id, title: group.title, note: group.note, owns: (tool) => tool.group === group.id && !sectionIds.has(tool.section) });
    }
    for (const section of sections) {
      groups.push({ id: `${group.id}-${section.id}`, parent: group.id, title: `${group.title} - ${section.title}`, note: "", owns: (tool) => tool.group === group.id && tool.section === section.id });
    }
  }
  return groups;
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

function checkbox({ id, label, checked, disabled = false, title = "", value = "", mono = false, note = "" }) {
  const input = h("input", { type: "checkbox", id, value, checked: !!checked, disabled: !!disabled || null });
  input.checked = !!checked;
  input.disabled = !!disabled;
  const text = h("span", { class: "uiCheck__text" }, h("span", { class: mono ? "uiCheck__label mcpMono" : "uiCheck__label" }, label),
    note ? h("span", { class: "uiCheck__note" }, note) : null);
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

  // Host: a key reads one host. One radio button for each host that has an mcp_uri, one under the other.
  // A host whose MCP user cannot connect is greyed with the reason. The first usable host is chosen.
  const hostBoxes = [];
  const hostList = h("div", { class: "uiChecks mcpHostChecks", role: "radiogroup", "aria-label": "Host" });
  const usable = (host) => host.mcp.state !== "unavailable";
  const firstUsable = meta.hosts.findIndex(usable);
  // One host only: there is nothing to choose, so it is shown as a fact (and not as a control that does nothing).
  const onlyHost = meta.hosts.length === 1;
  meta.hosts.forEach((host, index) => {
    const down = !usable(host);
    const id = `mcpHost-${index}`;
    const input = h("input", { type: "radio", id, name: "host", value: host.name, disabled: down || null });
    input.checked = index === firstUsable;
    input.disabled = down;
    if (onlyHost) {
      // The radio stays, hidden, as the holder of the choice (the form reads the chosen host from it).
      input.hidden = true;
      input.dataset.field = "hosts";
      const status = down ? "error" : host.healthy === false ? "warn" : host.healthy === true ? "ok" : "idle";
      const dot = h("span", { class: `mcpHostOnly__dot mcpHostOnly__dot--${status}`, "aria-hidden": "true" });
      const detail = down
        ? h("span", { class: "mcpHostOnly__note mcpHostDown", title: host.mcp.error }, `${mcpUser(host)} cannot connect`)
        : host.mcp.user ? h("span", { class: "mcpHostOnly__note" }, `as ${host.mcp.user}`) : null;
      const fact = h("div", { class: "mcpHostOnly", title: down ? `${host.name}: ${host.mcp.error || "the MCP user cannot connect"}` : host.label || host.name },
        input, dot, icon.el("database", { size: "sm", className: "mcpHostOnly__icon" }),
        h("span", { class: "mcpHostOnly__name mcpMono" }, host.name),
        host.label && host.label !== host.name ? h("span", { class: "mcpHostOnly__label" }, host.label) : null,
        detail);
      hostBoxes.push({ wrap: fact, input, host });
      hostList.appendChild(fact);
      return;
    }
    const note = down
      ? h("span", { class: "uiCheck__note mcpHostDown", title: host.mcp.error }, `${mcpUser(host)} cannot connect`)
      : host.label && host.label !== host.name ? h("span", { class: "uiCheck__note" }, host.label) : null;
    const label = h("label", { class: `uiCheck${down ? " is-disabled" : ""}`, for: id, title: down ? `${host.name}: ${host.mcp.error || "the MCP user cannot connect"}` : host.label || host.name },
      input, h("span", { class: "uiCheck__text" }, h("span", { class: "uiCheck__label mcpMono" }, host.name), note));
    if (index === 0) input.dataset.field = "hosts";
    hostBoxes.push({ wrap: label, input, host });
    hostList.appendChild(label);
  });
  if (!meta.hosts.length) hostList.appendChild(h("p", { class: "mcpNote" }, "No host has an mcp_uri in the config: a key cannot read data."));
  // What the MCP user of the chosen host cannot do: said once, under the choice; the tools say it each.
  const hostNote = h("p", { class: "mcpNote mcpHostNote" });
  const hostsField = fieldWrap("hosts", "Host", [hostList, hostNote], { group: true });

  // Data: the patterns, one per line. * alone is every database and table.
  const patterns = h("textarea", { id: "mcpField-databases", class: "uiInput uiInput--area uiInput--mono", name: "databases", dataset: { field: "databases" }, rows: "3", spellcheck: "false", autocomplete: "off", placeholder: "otel\nanalytics.events\nlogs_*.*" });
  // Everything by default: the MCP user already limits what a key reads, a pattern narrows it more.
  patterns.value = "*";
  const dataField = fieldWrap("databases", "Data", patterns, { hint: "One pattern per line: db, db.table, * as a wildcard. * alone is everything (the default): the MCP user's grants still apply." });

  // Limits.
  const limits = meta.limits;
  const number = (id, field, max, placeholder) => h("input", { id, class: "uiInput", type: "number", name: field, dataset: { field }, min: "1", max: max != null ? String(max) : null, step: "1", inputmode: "numeric", placeholder });
  const rows = number("mcpField-max_rows", "max_rows", limits.maxRows, limits.maxRows != null ? `Default ${format.count(limits.maxRows)}` : "Default");
  const timeout = number("mcpField-timeout_seconds", "timeout_seconds", limits.queryTimeoutSeconds, limits.queryTimeoutSeconds != null ? `Default ${limits.queryTimeoutSeconds} s` : "Default");
  const rowsField = fieldWrap("max_rows", "Max rows", rows, { required: false, hint: " " });
  const timeoutField = fieldWrap("timeout_seconds", "Timeout (s)", timeout, { required: false, hint: " " });
  const limitsRow = h("div", { class: "mcpFieldRow" }, rowsField, timeoutField);
  // The largest value of a limit is the smaller of the configuration of MCP and the profile of the ClickHouse user of the host: the
  // input stops at it as the number is typed, and the line under it says which of the two it is.
  const limitInputs = [
    { input: rows, wrap: rowsField, key: "maxRows", fallback: () => limits.maxRows, unit: "", config: "mcp.max_rows", profile: "max_result_rows", noun: "rows" },
    { input: timeout, wrap: timeoutField, key: "timeoutSeconds", fallback: () => limits.queryTimeoutSeconds, unit: " s", config: "mcp.query_timeout_seconds", profile: "max_execution_time", noun: "seconds" },
  ];
  const limitNote = (item, host) => {
    const cap = host?.mcp.limits[item.key];
    const max = cap ? cap.value : item.fallback();
    if (max == null) return { max: null, text: "" };
    const amount = `${format.count(max)}${item.unit}`;
    const user = host?.mcp.user ? ` ${host.mcp.user}` : "";
    const by = !cap || cap.source === "mcp" ? `limited by the MCP server (${item.config})`
      : cap.source === "clickhouse" ? `limited by the ClickHouse user${user} (its settings profile, ${item.profile})`
      : `set by the MCP server (${item.config}) and by the ClickHouse user${user} (${item.profile})`;
    // A profile with readonly = 1 refuses every limit that ChDash sends: the time is the profile's alone.
    const refused = item.key === "timeoutSeconds" && host?.mcp.profile.readonly === 1 ? " This user's profile is readonly = 1: ClickHouse refuses the limits of ChDash, so only the profile bounds the time." : "";
    return { max, text: `At most ${amount}: ${by}.${refused}` };
  };
  const syncLimits = (host) => {
    for (const item of limitInputs) {
      const { max, text } = limitNote(item, host);
      item.input.max = max != null ? String(max) : "";
      item.input.placeholder = max != null ? `Default ${format.count(max)}${item.unit}` : "Default";
      const hint = $(".uiField__hint", item.wrap);
      if (hint) hint.textContent = text;
      // A value that a new choice of host makes too large is brought back at once.
      if (max != null && item.input.value !== "" && Number(item.input.value) > max) item.input.value = String(max);
    }
  };
  // As soon as the number is above the largest one, it becomes the largest one (no waiting for the form to be sent).
  const capInput = (item) => {
    const max = Number(item.input.max);
    const hint = $(".uiField__hint", item.wrap);
    const capped = item.input.value !== "" && Number.isFinite(max) && item.input.max !== "" && Number(item.input.value) > max;
    if (capped) item.input.value = String(max);
    hint?.classList.toggle("is-capped", capped);
    if (capped && hint?.textContent) uiState.announce(hint.textContent);
  };
  for (const item of limitInputs) item.input.addEventListener("input", () => capInput(item));

  // Permissions: one card for each family. The check box of a card is all its tools; the arrow opens
  // the tools, one check box each. A tool that every key has (always) is checked and locked, and one that "*" does not give (explicitOnly)
  // is not ticked by the box of its family: the box chooses the plain tools only, and a family that has none has no box.
  const toolBoxes = [];
  const cards = [];
  const groupsBox = h("div", { class: "mcpGroups" });
  for (const group of groupsOf(meta)) {
    const tools = offered(meta).filter(group.owns);
    const plain = tools.filter((tool) => !tool.always && !tool.explicitOnly);
    const body = h("div", { class: "mcpGroup__body", id: `mcpGroupBody-${group.id}`, hidden: true });
    // A family of one tool has nothing to open: its check box is the tool itself, no arrow.
    const single = tools.length === 1;
    const members = tools.map((tool) => {
      const box = checkbox({
        id: `mcpTool-${tool.name}`,
        label: tool.name,
        checked: tool.always || (DEFAULT_GROUPS.has(group.parent) && !tool.needsAllData && !tool.explicitOnly),
        title: plainText(tool.description),
        value: tool.name,
        mono: true,
        note: tool.always ? ALWAYS_NOTE : tool.explicitOnly ? EXPLICIT_NOTE : "",
      });
      if (tool.always) box.wrap.classList.add("is-always");
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
        h("div", { class: "mcpGroup__head" }, only.wrap, h("span", { class: "mcpGroup__note", title: group.note }, group.note), reason));
      groupsBox.appendChild(card);
      cards.push({ group, card, single: true, box: true, all: only, members, reason, count: null });
      continue;
    }
    // The box of the family. A family with no plain tool (the analysis of a key's own usage: one tool that every key has, one to name) has a
    // title and no box: the input is only the holder of the state that sync() writes, and it is never in the page.
    const box = plain.length > 0;
    const all = box
      ? checkbox({ id: `mcpGroup-${group.id}`, label: group.title, checked: false, title: group.note })
      : { wrap: h("span", { class: "mcpGroup__title", title: group.note }, group.title), input: h("input", { type: "checkbox" }) };
    const count = h("span", { class: "mcpGroup__count" });
    const toggle = h("button", { type: "button", class: "button button--small mcpGroup__toggle", "aria-expanded": "false", "aria-controls": body.id, title: `Choose the tools of ${group.title}`, "aria-label": `Choose the tools of ${group.title}` },
      icon.el("chevron-down", { size: "sm" }));
    const reason = h("span", { class: "mcpGroup__reason" });
    reason.hidden = true;
    const card = h("div", { class: "mcpGroup", dataset: { group: group.id } },
      h("div", { class: "mcpGroup__head" }, all.wrap, h("span", { class: "mcpGroup__note", title: group.note }, group.note), reason, count, toggle), body);
    // A family that holds a tool to name, or only tools that every key has, shows them at once: nothing hides what the key will hold.
    const startsOpen = !box || tools.some((tool) => tool.explicitOnly);
    if (startsOpen) {
      body.hidden = false;
      toggle.setAttribute("aria-expanded", "true");
      card.classList.add("is-open");
    }
    toggle.addEventListener("click", () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      card.classList.toggle("is-open", open);
    });
    // On "input", not "change": the form's own "input" listener (the summary of the state) runs after this
    // one, whereas it would run first and undo the click.
    all.input.addEventListener("input", () => {
      for (const member of members) if (!member.input.disabled && !member.tool.explicitOnly) member.input.checked = all.input.checked;
    });
    groupsBox.appendChild(card);
    cards.push({ group, card, box, all, members, count, reason });
  }
  // The field "tools" is the first box that is in the page (the error of the field takes the focus there).
  const first = cards.find((item) => item.box);
  if (first) first.all.input.dataset.field = "tools";
  else if (cards.length) cards[0].members[0].input.dataset.field = "tools";

  const patternList = () => [...new Set(patterns.value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
  const isEverything = () => { const list = patternList(); return list.length === 1 && list[0] === "*"; };
  // The tools that need all the data are locked, and cleared, until the data is *.
  const chosenHost = () => hostBoxes.find((box) => box.input.checked)?.host || null;
  // The tools that the MCP user of the chosen host cannot serve: name -> { grants, statement }.
  const gapsOf = (host) => new Map((host?.mcp.unavailableTools || []).map((item) => [item.tool, item]));
  const sync = () => {
    const everything = isEverything();
    const host = chosenHost();
    syncLimits(host);
    const gaps = gapsOf(host);
    for (const box of toolBoxes) {
      if (box.tool.always) {
        // Every key has it: checked and locked, nothing to choose and nothing to send (the form sends the boxes that are on and free).
        box.input.checked = true;
        box.input.disabled = true;
        box.lock = "";
        continue;
      }
      const gap = gaps.get(box.tool.name);
      const needsData = box.tool.needsAllData && !everything;
      const locked = !!gap || needsData;
      if (locked) box.input.checked = false;
      box.input.disabled = locked;
      // Why it is locked, in the order of what the person fixes first: the data, then the grant of the host.
      box.lock = needsData ? "all" : gap ? "grant" : "";
      box.wrap.classList.toggle("is-disabled", locked);
      box.wrap.title = needsData ? NEEDS_EVERYTHING
        : gap ? `${lacking(gap)} cannot serve this tool: it lacks ${gap.grants.join(", ")}.\n${gap.statement}`
        : plainText(box.tool.description);
    }
    // Said once under the choice of the host: how many tools are greyed, and by what.
    hostNote.hidden = !host;
    if (host) {
      const lost = gaps.size;
      const note = host.mcp.state === "ok"
        ? `Tools run as ${host.mcp.user || "the MCP user"}.${lost ? ` ${lost} ${lost === 1 ? "tool needs" : "tools need"} a grant that this user lacks: ${lost === 1 ? "it is" : "they are"} greyed.` : ""}`
        : "The MCP user of this host is not checked yet.";
      // A note that changes after the choice of another host is said (the first one is read with the form).
      if (hostNote.textContent && hostNote.textContent !== note) uiState.announce(note);
      hostNote.textContent = note;
    }
    const lockText = (members) => {
      const locked = members.filter((box) => box.input.disabled);
      if (!locked.length) return "";
      if (locked.every((box) => box.lock === "grant")) return "no grant";
      if (locked.every((box) => box.lock === "all")) return "needs data *";
      return "unavailable";
    };
    for (const item of cards) {
      // What the person chose: the tools that every key has are on, and are not a choice.
      const chosen = item.members.filter((box) => box.input.checked && !box.tool.always).length;
      // The tools that the person can lock out of a family: those that every key has are not among them, so a family is "all locked" without them.
      const choosable = item.members.filter((box) => !box.tool.always);
      if (item.single) {
        const only = item.members[0];
        const locked = only.input.disabled && !only.tool.always;
        item.card.classList.toggle("has-tools", chosen > 0);
        item.reason.hidden = !locked;
        item.reason.textContent = locked ? lockText(item.members) : "";
        item.reason.title = only.wrap.title;
        continue;
      }
      // The box of the family is its plain tools: not the ones that every key has, nor the ones that "*" does not give.
      const free = item.members.filter((box) => !box.input.disabled && !box.tool.explicitOnly);
      const on = free.filter((box) => box.input.checked).length;
      item.all.input.disabled = !free.length;
      item.all.input.checked = free.length > 0 && on === free.length;
      item.all.input.indeterminate = on > 0 && on < free.length;
      if (item.box) item.all.wrap.classList.toggle("is-disabled", !free.length);
      item.count.textContent = `${item.members.filter((box) => box.input.checked).length}/${item.members.length}`;
      item.card.classList.toggle("has-tools", chosen > 0);
      // A family that is all locked says why in its head.
      const stuck = choosable.length > 0 && choosable.every((box) => box.input.disabled);
      item.reason.hidden = !stuck;
      item.reason.textContent = stuck ? lockText(choosable) : "";
      item.reason.title = item.members[0].wrap.title;
    }
  };
  const toolsField = fieldWrap("tools", "Permissions", groupsBox, { group: true });

  const toNumber = (input) => (input.value.trim() === "" ? null : Number(input.value));
  const pickedHosts = () => hostBoxes.filter((box) => box.input.checked && !box.input.disabled).map((box) => box.input.value);
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
  if (!input.hosts.length) found.push({ field: "hosts", text: "Choose the host that the key reads." });
  if (!input.databases.length) found.push({ field: "databases", text: "Enter at least one data pattern (* for all the data)." });
  if (!input.tools.length) found.push({ field: "tools", text: "Give the key at least one permission." });
  for (const [field, value] of [["max_rows", input.maxRows], ["timeout_seconds", input.timeoutSeconds]]) {
    if (value !== null && (!Number.isInteger(value) || value < 1)) found.push({ field, text: "Enter a whole number of 1 or more, or leave it empty." });
  }
  return found;
}

function openKeyForm({ meta, submit }) {
  const { form, read, focusName } = buildForm(meta);
  return dialog.open({
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
// need all the data only when its data is "*" alone, and not the ones that "*" does not give), and the ones that
// every key has (mcpView.heldTools: the same rule as the Tools cell of the table).
function grantedTools(meta, key) {
  return mcpView.heldTools(meta, key);
}

// --- The data that a key reaches ---------------------------------------------------------

// The reads of "Data it reads", by key id, and the slot of the read in flight (the page cancels the slots with this
// prefix when it closes the details of a key).
const REACH_SLOT = "mcp.reach.";
const REACH_TTL_MS = 60000;
const reachCache = new Map();

// What the MCP ClickHouse user of each host may read, cut by the patterns of the key, as databases that open on
// their tables. A table that the user reads only in part says "some columns".
function reachSection(key) {
  const body = h("div", { class: "mcpReach__body" });
  const refresh = h("button", { type: "button", class: "button button--small mcpReach__refresh", title: "Check the grants of the MCP user again" }, "Check again");
  const section = h("section", { class: "mcpReach", dataset: { reach: key.id }, "aria-label": `Data that ${key.name} reads` },
    h("h3", { class: "mcpDetails__title" }, "Data it reads", refresh), body);
  // One read for each key: opening the details again within a minute shows what was read (the server keeps the grants
  // of a host 60 s as well), "Check again" reads anew, and closing the details aborts a read in flight.
  const slot = `${REACH_SLOT}${key.id}`;
  const load = async (again) => {
    const cached = reachCache.get(key.id);
    if (!again && cached && Date.now() - cached.at < REACH_TTL_MS) {
      body.replaceChildren(reachBody(cached.access));
      return;
    }
    const req = util.latest(slot);
    refresh.disabled = true;
    uiState.loading(body, { label: "Checking the grants of the MCP user\u2026", compact: true });
    try {
      const access = await api.getMcpKeyAccess(key.id, { refresh: again, signal: req.signal });
      if (!req.isCurrent()) return;
      reachCache.set(key.id, { at: Date.now(), access });
      body.replaceChildren(reachBody(access));
      uiState.announce(`The data that ${key.name} reads is listed.`);
    } catch (error) {
      if (req.isCurrent() && !util.isAbort(error)) uiState.error(body, { title: "The data of this key cannot be listed", body: util.errorText(error), compact: true });
    } finally {
      if (req.isCurrent()) refresh.disabled = false;
    }
  };
  refresh.addEventListener("click", () => load(true));
  void load(false);
  return section;
}

function reachBody(access) {
  const count = format.count;
  const wrap = h("div", { class: "mcpReachHosts" });
  if (!access.hosts.length) {
    wrap.appendChild(h("p", { class: "mcpNote" }, "This key names no host that has an mcp_uri: it reads nothing."));
    return wrap;
  }
  for (const host of access.hosts) {
    const head = h("div", { class: "mcpReachHost__head" },
      h("strong", { class: "mcpReachHost__name" }, host.host),
      host.user ? h("span", { class: "mcpMuted" }, `as ${host.user}`) : null);
    const block = h("div", { class: "mcpReachHost", dataset: { host: host.host, status: host.status } }, head);
    if (host.status !== "ok") {
      block.appendChild(h("p", { class: "mcpNote mcpReachHost__error" }, `Not checked: ${host.error || "the MCP user cannot connect"}`));
      wrap.appendChild(block);
      continue;
    }
    const total = host.databases.reduce((sum, database) => sum + database.tableCount, 0);
    head.appendChild(h("span", { class: "mcpMuted" }, `${count(total)} ${total === 1 ? "table" : "tables"} in ${count(host.databases.length)} ${host.databases.length === 1 ? "database" : "databases"}`));
    const why = [];
    why.push(`The ClickHouse grants of the MCP user let it read ${count(host.readableByUser)} ${host.readableByUser === 1 ? "table" : "tables"}.`);
    if (access.allData) why.push("This key's data is *: all of them.");
    else why.push(`The key keeps those that match ${access.patterns.join(", ")}${host.excludedByKey ? `, and leaves out ${count(host.excludedByKey)}` : ""}.`);
    block.appendChild(h("p", { class: "mcpNote mcpReachHost__why" }, why.join(" ")));
    if (!host.databases.length) block.appendChild(h("p", { class: "mcpNote" }, "No table: the key reads no data on this host."));
    const list = h("div", { class: "mcpReachDbs" });
    for (const database of host.databases) {
      const tables = h("ul", { class: "mcpReachTables" }, database.tables.map((table) => h("li", { class: "mcpReachTable" },
        h("code", null, table.name),
        table.columns === "all" ? null : h("span", { class: "mcpMuted", title: "The MCP user reads only some columns of this table" }, `${table.columns} columns`))));
      if (database.truncated) tables.appendChild(h("li", { class: "mcpReachTable mcpMuted" }, `\u2026 ${count(database.tableCount - database.tables.length)} more`));
      list.appendChild(h("details", { class: "mcpReachDb", dataset: { database: database.name } },
        h("summary", { class: "mcpReachDb__summary" }, h("code", null, database.name), h("span", { class: "mcpMuted" }, `${count(database.tableCount)} ${database.tableCount === 1 ? "table" : "tables"}`)),
        tables));
    }
    block.appendChild(list);
    wrap.appendChild(block);
  }
  return wrap;
}

// A key that is not in the list but keeps usage: its host and when it was deleted (or where it comes from: only another instance knows
// it), then what it did and what it cost (its usage stays for the retention of the usage).
function deletedDetails(meta, key) {
  const deleted = key.deletedAt != null;
  const about = h("dl", { class: "mcpAbout" },
    h("dt", null, "Host"), h("dd", null, key.hosts.length ? h("code", { class: "mcpChip" }, key.hosts[0]) : h("span", { class: "mcpMuted" }, "None")),
    h("dt", null, deleted ? "Deleted" : "Known to"),
    deleted ? h("dd", { title: format.timeTitle(key.deletedAt) }, format.time(key.deletedAt, { precision: "min" }))
      : h("dd", { title: "This instance has no key of this name: its usage comes from the file of the other instance." }, "Another instance only"));
  return h("div", { class: "mcpDetails mcpDetails--deleted" }, about, ...mcpUsage.sections(key, { meta }));
}

function keyDetails({ meta, key, deleted = false }) {
  if (deleted) return deletedDetails(meta, key);
  const granted = grantedTools(meta, key);
  const held = new Set(granted.map((tool) => tool.name));
  const list = (values, allText) => {
    if (!values.length) return h("span", { class: "mcpMuted" }, "None");
    if (values.includes("*")) return h("span", null, allText);
    return h("span", { class: "mcpChips" }, values.map((value) => h("code", { class: "mcpChip" }, value)));
  };
  const limitOf = (own, global, unit) => (own != null ? `${format.count(own)}${unit}` : global != null ? `${format.count(global)}${unit} (default)` : EMPTY);
  const everything = key.databases.length === 1 && key.databases[0] === "*";
  // The host of the key, and what its MCP user can serve. A key reads one host: a key of an older file that names
  // several keeps working, and says so.
  const host = key.hosts.length === 1 ? meta.hosts.find((item) => item.name === key.hosts[0]) || null : null;
  const gaps = new Map((host?.mcp.unavailableTools || []).map((item) => [item.tool, item]));
  const hostText = () => {
    if (!key.hosts.length) return h("span", { class: "mcpMuted" }, "None");
    const chips = h("span", { class: "mcpChips" }, key.hosts.map((value) => h("code", { class: "mcpChip" }, value)));
    if (key.hosts.length > 1 || key.hosts.includes("*")) {
      return h("span", null, chips, h("span", { class: "mcpWarn mcpHostWarn" }, " A key reads one host now. Make one key for each host."));
    }
    if (!host) return h("span", null, chips, h("span", { class: "mcpWarn mcpHostWarn" }, " This host has no mcp_uri any more: the key reads nothing."));
    if (host.mcp.state === "unavailable") {
      return h("span", null, chips, h("span", { class: "mcpWarn mcpHostWarn", title: host.mcp.error }, ` ${mcpUser(host)} cannot connect.`));
    }
    return h("span", null, chips, host.mcp.user ? h("span", { class: "mcpMuted" }, ` as ${host.mcp.user}`) : null);
  };
  const about = h("dl", { class: "mcpAbout" },
    h("dt", null, "Source"), h("dd", null, key.source === "config" ? "The config file (read-only)" : "This page"),
    h("dt", null, "Host"), h("dd", null, hostText()),
    h("dt", null, "Data"), h("dd", null, everything ? h("span", null, h("code", { class: "mcpChip" }, "*"), " all the data") : list(key.databases, "All the data")),
    h("dt", null, "Rows"), h("dd", null, limitOf(key.maxRows, meta.limits.maxRows, "")),
    h("dt", null, "Timeout"), h("dd", null, limitOf(key.timeoutSeconds, meta.limits.queryTimeoutSeconds, " s")));

  // Permissions: the families, each with what the key holds in it (n of m) and the tools it holds.
  // Two columns of the same height. A family weighs its head plus a row for each tool that the key holds in
  // it; the tallest families go first, each into the shorter column, then every column is put back in the
  // order of the families.
  const cards = groupsOf(meta).map((group, index) => {
    const tools = offered(meta).filter(group.owns);
    const mine = tools.filter((tool) => held.has(tool.name));
    const node = h("div", { class: `mcpGrantGroup${mine.length ? "" : " is-empty"}`, dataset: { group: group.id } },
      h("div", { class: "mcpGrantGroup__head" }, h("span", { class: "mcpGrantGroup__title" }, group.title), h("span", { class: "mcpGrantGroup__count" }, `${mine.length} of ${tools.length}`)),
      mine.length ? h("ul", { class: "mcpGrants" }, mine.map((tool) => {
        // A tool that the MCP user of the host cannot serve says which grant is missing (the key keeps it).
        const gap = gaps.get(tool.name);
        const lost = !!gap;
        const note = gap ? `not served: ${gap.user || "the " + gap.role} lacks ${gap.grants[0].replace(/^SELECT ON /, "")}${gap.grants.length > 1 ? " and more" : ""}`
          : tool.always ? ALWAYS_NOTE.toLowerCase() : firstSentence(tool.description);
        return h("li", { class: `mcpGrant${lost ? " is-lost" : ""}`, dataset: { tool: tool.name }, title: gap ? `${gap.grants.join(", ")} is missing.\n${gap.statement}` : plainText(tool.description) },
          h("span", { class: "mcpGrant__name" }, tool.name),
          h("span", { class: "mcpGrant__note" }, note));
      })) : null);
    return { node, index, weight: mine.length ? 1.5 + 1.4 * mine.length : 1.6 };
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
  // The data that the key reaches: asked when the details open (the server checks the grants of the MCP user).
  const reach = reachSection(key);
  const lostCount = granted.filter((tool) => gaps.has(tool.name)).length;
  const body = h("div", { class: "mcpDetails" }, about,
    h("div", { class: "mcpDetails__perms" }, h("h3", { class: "mcpDetails__title" }, "Permissions", h("span", { class: "pagePart__count" }, `${granted.length} of ${offered(meta).length}`),
      lostCount ? h("span", { class: "mcpWarn mcpLostCount", title: "The user that runs these tools on this host lacks a grant. The key keeps them; they answer with an error." }, `${lostCount} not served`) : null), perms),
    // What the key may read, then what it did and what that cost.
    reach, ...mcpUsage.sections(key, { meta }));

  return body;
}

// --- The secret ------------------------------------------------------------------------

function showSecret({ meta, key, secret }) {
  const url = mcpView.endpointUrl(meta);
  const body = h("div", { class: "mcpReveal" });
  body.append(
    h("p", { class: "mcpReveal__lead" }, `Key ${key.name} is ready.`),
    h("p", { class: "mcpReveal__warn", role: "note" }, "Copy the secret now: ClickHouse Dash shows it only this time. It keeps a hash of the secret, so a lost secret cannot be found again: delete the key and make a new one."),
    h("div", { class: "uiField" },
      h("label", { class: "uiField__label", for: "mcpSecret" }, "Secret"),
      h("div", { class: "uiField__row" },
        h("input", { id: "mcpSecret", class: "uiInput uiInput--mono", type: "text", readonly: true, value: secret, spellcheck: "false", autocomplete: "off" }),
        copy.button(null, () => secret, { label: "Copy the secret", className: "mcpEndpoint__copy" }))),
    h("div", { class: "uiField" },
      h("div", { class: "uiField__label", id: "mcpConnectLabel" }, "Connect a client"),
      mcpView.clientTabs(url, key.name, secret, "mcpRevealClient", mcpView.authHeader(meta))),
  );
  return dialog.open({
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

function forgetDetails() {
  reachCache.clear();
  mcpUsage.forget();
}

function cancelDetails() {
  util.latest.cancelPrefix(REACH_SLOT);
  mcpUsage.cancel();
}

export const mcpForm = Object.freeze({ openKeyForm, keyDetails, showSecret, REASON_TEXT, REACH_SLOT, forgetDetails, cancelDetails });
