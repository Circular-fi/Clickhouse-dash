// The views of the MCP integration page (docs/mcp-integration-page.md): the keys table with its states
// and, beside it, the side column (how to connect a client, with the endpoint, the hosts, the global
// limits). The heading of the keys holds the page's two actions: Refresh and New key. app_page_mcp.js
// decides what to show and answers the actions; app_mcp_form.js has the dialogs. Every node is built
// with ns.h: no API value reaches markup.
//
//   ns.mcpView.renderSide(el, meta)                  the side column: connect a client, hosts, global limits
//   ns.mcpView.renderDisabled(el)                    the HCL extract that turns MCP on
//   ns.mcpView.renderUsageOff(el)                    "Usage is off": what the usage would show, and the HCL extract that turns it on
//   ns.mcpView.renderKeys(el, view, actions)         the keys part: head (New key), note, table or state
//   ns.mcpView.fillAccess(el, access, failure)       the counts of databases and tables in the Data cells (a Map of getMcpAccessSummary, or null)
//   ns.mcpView.fillUsage(el, usage, failure)         the last use and the tool calls in the Used cells, its note and the warnings about the
//                                                    instances (getMcpUsageSummary, or null). The column is there only while the usage is on.
//   ns.mcpView.renderDeleted(el, usage, view, actions)  the keys that are not in the list but keep usage, under the keys (a line that opens
//                                                    on them): the deleted keys, and the keys that only another instance knows
//   ns.mcpView.heldTools(meta, key)                  the tools of the catalog that a key holds (the Tools cell, the details of a key)
//   ns.mcpView.secretCell(key)                       the secret of a key as the page shows it: its hint and dots
//   ns.mcpView.endpointUrl(meta)                     the full URL of the endpoint (the page's origin)
//   ns.mcpView.commands(url, name, secret, header)   { cli, desktop, inspector, json } to connect a client; header is mcp.auth_header
//   ns.mcpView.codeBlock(text, label, lang)          a code block with its copy button and its colours (json, shell, values, hcl)
//   ns.mcpView.clientTabs(url, name, secret, id, header)  the client snippets as tabs (the side column and the secret panel)
//   ns.mcpView.manageReason(meta)                    why the keys cannot change ("" when they can)

import { api } from "./app_api.js";
import { dom, h } from "./app_dom.js";
import { format } from "./app_format.js";
import { mcpInstances } from "./app_mcp_instances.js";
import { badge as badgeMod } from "./app_ui_badge.js";
import { copy as copyMod } from "./app_ui_copy.js";
import { icon } from "./app_ui_icon.js";
import { segmented } from "./app_ui_segmented.js";
import { table as tableMod } from "./app_ui_table.js";
import { uiState } from "./app_ui_state.js";
import { util } from "./app_util.js";

const { $, $$ } = dom;
const EMPTY = format.EMPTY;

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

// The block that turns the usage on: the directory is the one thing it needs. Several ChDash may write in it.
const HCL_USAGE_EXAMPLE = [
  "mcp {",
  "  usage {",
  "    enabled = true",
  "    dir     = \"/var/lib/chdash/mcp-usage\"",
  "  }",
  "}",
].join("\n");

const SOURCE_TITLE = {
  config: "Defined in the config file (a key block of mcp). It is read-only here.",
  ui: "Created on this page. It is stored in the storage file.",
};

const badge = (text, tone, title = "") => badgeMod.el(text, { tone, size: "md", title });

// --- Endpoint, commands ----------------------------------------------------------------

function endpointUrl(meta) {
  const path = api.resolveUrl(String(meta?.endpointPath || "/mcp").replace(/^\/+/, ""));
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
  const copy = copyMod.button(null, () => text, { label: `Copy ${label}`, className: "mcpCode__copy" });
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
  segmented.render(group, CLIENTS.map((c) => ({ value: c.value, label: c.label })), { attr: "client", value: CLIENTS[0].value, size: "compact", label: "Client" });
  const panels = CLIENTS.map((c) => {
    const panel = h("div", { class: "mcpClients__panel", id: `${idBase}-${c.value}`, dataset: { client: c.value } },
      h("p", { class: "mcpNote" }, c.note), codeBlock(set[c.key], c.copy, c.lang));
    panel.hidden = c.value !== CLIENTS[0].value;
    return panel;
  });
  const wrap = h("div", { class: "mcpClients" }, group, ...panels);
  segmented.bind(group, { attr: "client", onChange: (value) => { for (const panel of panels) panel.hidden = panel.dataset.client !== value; } });
  return wrap;
}

function manageReason(meta) {
  if (!meta || !meta.enabled) return "MCP is off.";
  if (!meta.manageFromUi) return "Keys are read-only: manage_from_ui is false in the config.";
  if (!meta.storageConfigured) return "Keys cannot be created here: mcp.storage_file is not set in the config.";
  return meta.canManage ? "" : "Keys cannot be changed from this page.";
}

// --- Formats ---------------------------------------------------------------------------

const count = (value) => format.count(value);

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
  if (healthy === true) return badgeMod.el("Healthy", { tone: "ok" });
  if (healthy === false) return badgeMod.el("Down", { tone: "error" });
  return badgeMod.el("unknown", { tone: "neutral" });
}

// The endpoint: a read-only field with its Copy button, the first thing a client needs.
function endpointField(url) {
  return h("div", { class: "uiField mcpEndpoint" },
    h("label", { class: "uiField__label", for: "mcpEndpointUrl" }, "Endpoint"),
    h("div", { class: "uiField__row" },
      h("input", { id: "mcpEndpointUrl", class: "uiInput uiInput--mono", type: "text", readonly: true, value: url, spellcheck: "false", autocomplete: "off" }),
      copyMod.button(null, () => url, { label: "Copy the endpoint URL", className: "mcpEndpoint__copy" })));
}

function connectBlock(meta, url) {
  return sideBlock("mcpConnect", "Connect a client", null,
    endpointField(url),
    h("p", { class: "mcpNote" }, "Make a key, copy its secret when ClickHouse Dash shows it (only once), and put it where <secret> stands."),
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
    host.mcp.user ? h("span", { class: "mcpMuted mcpHostRow__user", title: "The ClickHouse user that the tools of a key of this host run as" }, host.mcp.user) : null,
    host.mcp.state === "unavailable"
      ? badgeMod.el("MCP user down", { tone: "error", title: host.mcp.error || "The MCP user cannot connect: no key can read this host." })
      : healthBadge(host.healthy)));
  return sideBlock("mcpHosts", "Hosts", meta.hosts.length, h("ul", { class: "mcpHostList", "aria-label": "Hosts with an mcp_uri" }, rows));
}

function limitsBlock(meta) {
  const l = meta.limits;
  const rows = [
    ["Rows per result", limitText(l.maxRows)],
    ["Timeout", limitText(l.queryTimeoutSeconds, "s")],
    ["Result size", l.maxResultBytes == null ? EMPTY : format.bytes(l.maxResultBytes)],
    ["SQL size", l.maxSqlBytes == null ? EMPTY : format.bytes(l.maxSqlBytes)],
    ["Memory per query", l.maxMemoryBytes == null ? EMPTY : format.bytes(l.maxMemoryBytes)],
    ["Rows read", limitText(l.maxRowsToRead, "", "No limit")],
    ["Requests per minute", limitText(l.rateLimitPerMinute, "", "Unlimited")],
  ];
  const list = h("dl", { class: "mcpLimits", "aria-label": "Global limits" });
  for (const [label, value] of rows) list.append(h("dt", null, label), h("dd", null, value));
  return sideBlock("mcpLimitsBlock", "Global limits", null, list,
    h("p", { class: "mcpNote mcpNote--fine" }, "A key can lower the rows and the timeout. It never raises them. The request limit counts for each key, on each instance."));
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
      h("p", { class: "mcpNote" }, "MCP lets an AI client read your ClickHouse data through ClickHouse Dash. It is off now. Add this to the config file, then restart ClickHouse Dash:"),
      codeBlock(HCL_EXAMPLE, "the HCL block", "hcl"),
      h("p", { class: "mcpNote" }, "Set mcp_uri on each host that MCP can read. It names a separate ClickHouse user with SELECT and SHOW grants only. Without storage_file, keys come from key blocks of the config only.")));
  container.replaceChildren(wrap);
}

// The usage is off (`usage.enabled` is false in the meta): what the Usage tab would show, and what to add to the config. Calm: nothing is wrong,
// and the rest of the page works (the keys, and the ClickHouse cost of a key, which does not depend on the usage).
function renderUsageOff(container) {
  const state = uiState.block("empty", {
    title: "Usage is off",
    body: "ClickHouse Dash does not count what the keys do, so there is nothing to show here. Turned on, this tab shows the requests, the errors, the time of a call and the bytes of every key over time, by key, method, client and instance, and the details of a key say what it did and when it was last used.",
  });
  const config = h("div", { class: "mcpUsageOff__config" },
    h("p", { class: "mcpNote" }, "Add this to the config file, then restart ClickHouse Dash:"),
    codeBlock(HCL_USAGE_EXAMPLE, "the HCL block", "hcl"),
    h("p", { class: "mcpNote" }, "The directory must exist and be writable. ClickHouse Dash saves its counts there once a minute, in a file of its own named for the instance (set instance to choose the name; it is the host name by default). Several instances can share the directory: each saves its own file and reads the others, and every figure is then their sum. retention_days (90 by default) says how long the counts stay."));
  container.replaceChildren(h("section", { class: "mcpOff mcpUsageOff", id: "mcpUsageOff", "aria-label": "Usage is off" }, state, config));
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
  }, icon.el("trash", { size: "sm" }), h("span", { class: "mcpAction__label" }, "Delete"));
  button.addEventListener("click", () => onClick(key, button));
  return button;
}

// The host of a key: a key reads one host, so its name. A key of an older file can name several (or "*"): it
// reads "n hosts" in the warning colour, and its details say what to do.
function hostCell(key, meta) {
  if (!key.hosts.length) return h("span", { class: "mcpMuted" }, "None");
  if (key.hosts.length > 1 || key.hosts.includes("*")) {
    return h("span", { class: "mcpWarn", title: `${key.hosts.join(", ")}\nA key reads one host now: make one key for each host.` }, `${key.hosts.length} hosts`);
  }
  const name = key.hosts[0];
  const known = meta.hosts.find((host) => host.name === name);
  const down = known && known.mcp.state === "unavailable";
  return h("span", { class: `mcpHostCell${known && !down ? "" : " mcpWarn"}`, title: !known ? `${name}: no mcp_uri any more, the key reads nothing` : down ? `${name}: the MCP user cannot connect` : name }, name);
}

// The tools that the server offers now: a tool that is not available (the usage is off, or the setting that it needs) is not shown and not held.
const offeredTools = (meta) => meta.tools.filter((tool) => tool.available);

// The tools that a key holds: those that every key has (the analysis of its own limits and usage), the names that its list holds, and, when it
// lists "*", every tool but those that "*" does not give (the tools that a key must name) and, unless its data is "*" alone, those that need
// all the data.
function heldTools(meta, key) {
  const everything = key.databases.length === 1 && key.databases[0] === "*";
  const all = key.tools.includes("*");
  return offeredTools(meta).filter((tool) => tool.always || key.tools.includes(tool.name) || (all && !tool.explicitOnly && (!tool.needsAllData || everything)));
}

// "All" and "None" are words, a part is "n/total" (code): the tools of the key out of the ones that exist.
// The title lists them. Data has no total (patterns), so it is a count. `all`: the key lists "*" (its title says what "*" leaves out: `left`).
function listCell(values, total = 0, noun = "", { all = false, left = [] } = {}) {
  if (!values.length) return h("span", { class: "mcpMuted" }, "None");
  if (all) {
    const but = `All ${noun || "the data"} but ${left.join(", ")}: a key has ${left.length === 1 ? "it" : "them"} only when its list names ${left.length === 1 ? "it" : "them"}`;
    return h("span", { class: "mcpMuted", title: left.length ? but : `All ${noun || "the data"}` }, "All");
  }
  if (total && values.length >= total) return h("span", { class: "mcpMuted", title: values.join(", ") }, "All");
  const text = total ? `${values.length}/${total}` : `${values.length} ${values.length === 1 ? "pattern" : "patterns"}`;
  return h("span", { class: "mcpMono", title: values.join(", ") }, text);
}

// The tools of a key: what it holds (heldTools, the tools that every key has among them) out of what the server offers now.
function toolsCell(key, meta) {
  const held = heldTools(meta, key).map((tool) => tool.name);
  const left = offeredTools(meta).filter((tool) => tool.explicitOnly && !held.includes(tool.name)).map((tool) => tool.name);
  return listCell(held, offeredTools(meta).length, "tools", { all: key.tools.includes("*"), left });
}

// The data of a key: how many databases and tables it reaches. The count comes after the table is drawn (the page asks for
// it once, for all the keys: fillAccess), so the cell starts as an ellipsis. The patterns of the key are in its title.
const plural = (n, one, many) => `${format.count(n)} ${n === 1 ? one : many}`;
function dataCell(key) {
  return h("span", { class: "mcpMono mcpDataCell mcpMuted", dataset: { keyId: key.id, patterns: key.databases.join(", ") }, title: patternsTitle(key, "Counting the databases and tables\u2026") }, "\u2026");
}
const patternsTitle = (key, first) => `${first}\nData patterns: ${key.databases.length ? key.databases.join(", ") : "none"}`;

// Puts the counts in the cells of the table (without drawing it again, so the details that are open stay open).
// `access` is the Map of ns.api.getMcpAccessSummary(), or null when it could not be read (the cells then say so).
function fillAccess(container, access, failure = "") {
  for (const node of $$(".mcpDataCell", container)) {
    const patterns = node.dataset.patterns || "";
    const withPatterns = (first) => `${first}\nData patterns: ${patterns || "none"}`;
    const item = access && access.get(node.dataset.keyId);
    node.classList.remove("mcpMuted", "mcpWarn");
    if (!item) {
      node.textContent = EMPTY;
      node.classList.add("mcpMuted");
      node.title = withPatterns(failure || "The data of this key could not be counted.");
    } else if (item.status === "ok") {
      node.textContent = `${plural(item.databases, "db", "dbs")} \u00b7 ${plural(item.tables, "table", "tables")}`;
      if (!item.tables) node.classList.add("mcpWarn");
      node.title = withPatterns(`${plural(item.databases, "database", "databases")} and ${plural(item.tables, "table", "tables")} on ${item.host}, as the MCP user ${item.user || "of the host"}.` +
        (item.partialTables ? `\n${plural(item.partialTables, "table is", "tables are")} read in part (some columns).` : "") +
        (item.tables ? "" : "\nThe patterns of the key match nothing that the MCP user may read."));
    } else {
      node.textContent = EMPTY;
      node.classList.add(item.status === "no_host" ? "mcpWarn" : "mcpMuted");
      node.title = withPatterns(item.status === "no_host" ? "This key names no host that has an mcp_uri: it reads nothing." : `Not counted: ${item.error || "the MCP user cannot connect"}.`);
    }
  }
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

// The secret of a key as the page shows it: its first characters (the hint, to tell the keys apart), then dots with the
// hyphens in clear. That is all the page has: ChDash keeps the hash of a secret, and shows the secret once, when it makes
// the key (app_mcp_form.js, showSecret). The server sends the mask (`secret_mask`); without it the shape of a UUID stands in.
const DOTS = (n) => "\u2022".repeat(n);
const MASK = [8, 4, 4, 4, 12].map(DOTS).join("-");
const maskOf = (key) => {
  if (key.secretMask) return key.secretMask;
  const hint = key.secretHint || "";
  return /^[0-9a-f]{8}$/i.test(hint) ? `${hint}${MASK.slice(8)}` : MASK;
};

// The cell is short: the hint, the next group of the UUID and an ellipsis (the whole mask is in its title), so the column Used fits beside
// the others.
function secretCell(key) {
  const mask = maskOf(key);
  const why = `The secret of ${key.name} is not kept: ClickHouse Dash showed it once, when it made the key. A lost secret cannot be found again: delete the key and make a new one.`;
  return h("div", { class: "mcpSecret" }, h("span", { class: "mcpSecret__text", title: `${mask}\n${why}` }, `${mask.slice(0, 13)}\u2026`));
}

// --- Usage ------------------------------------------------------------------------------

// When a key was last used and its tool calls in a window (the column Used, a deleted key): asked once for all the keys after the
// table is drawn (fillUsage), so the cell starts as an ellipsis.
function usedCell(key) {
  return h("span", { class: "mcpUsedCell mcpMuted", dataset: { keyId: key.id, createdAt: key.createdAt || "" }, title: "Reading the use of the key\u2026" }, "\u2026");
}

const WINDOW_TEXT = {
  "1h": "the last hour", "6h": "the last 6 hours", "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days", "90d": "the last 90 days", "365d": "the last 365 days",
};
const windowText = (name) => WINDOW_TEXT[name] || "the window";
const minuteTime = (ms) => format.time(ms, { precision: "min" });

// Is the counting as old as the key? Then a key without a use was never used. The counting began when the usage was turned on (`since`): a key
// that is older than that may have been used before. A key of the config file has no date of creation: only its use tells.
function countedWholeLife(usage, createdAt) {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  return !Number.isFinite(created) || usage.since == null || usage.since <= created;
}

// The text, the colour and the title of the use of a key: "2 h ago · 1.2K" (its last use, its tool calls in the window).
function usedView(line, usage, createdAt = "") {
  const now = usage.to ?? Date.now();
  const lines = [];
  let text = EMPTY;
  if (line.lastUsedAt != null) {
    text = `${format.ago(line.lastUsedAt, { now, short: true })} \u00b7 ${format.compact(line.calls)}`;
    lines.push(`Last used ${minuteTime(line.lastUsedAt)} (${format.ago(line.lastUsedAt, { now })}).`);
  } else if (countedWholeLife(usage, createdAt)) {
    text = "Never";
    lines.push(usage.since == null ? "Never used." : `Never used. Counted since ${minuteTime(usage.since)}.`);
  } else {
    lines.push(`Not used since ${minuteTime(usage.since)}, when the counting began. The key is older: it may have been used before.`);
  }
  lines.push(`${format.count(line.calls)} tool ${line.calls === 1 ? "call" : "calls"} in ${format.count(line.requests)} ${line.requests === 1 ? "request" : "requests"} in ${windowText(usage.window)}.`);
  const trouble = [
    line.errors ? `${format.count(line.errors)} ${line.errors === 1 ? "error" : "errors"}` : "",
    line.rateLimited ? `${format.count(line.rateLimited)} refused by the rate limit` : "",
    line.rejected ? `${format.count(line.rejected)} other ${line.rejected === 1 ? "refusal" : "refusals"}` : "",
  ].filter(Boolean);
  if (trouble.length) lines.push(`${trouble.join(", ")}.`);
  const warn = line.rateLimited > 0 || (line.calls > 0 && line.errors / line.calls >= 0.05);
  return { text, title: lines.join("\n"), muted: !line.calls, warn };
}

// Puts the use of each key in its cell (without drawing the table again, so the details that are open stay open), and says under the
// table what the column counts. `usage` is the answer of ns.api.getMcpUsageSummary(), or null when it could not be read.
function fillUsage(container, usage, failure = "") {
  for (const node of $$(".mcpUsedCell", container)) {
    const line = usage && usage.keys.get(node.dataset.keyId);
    node.classList.remove("mcpMuted", "mcpWarn");
    if (!line) {
      node.textContent = EMPTY;
      node.classList.add("mcpMuted");
      node.title = failure || "The use of this key could not be read.";
      continue;
    }
    const view = usedView(line, usage, node.dataset.createdAt);
    node.textContent = view.text;
    node.title = view.title;
    if (view.warn) node.classList.add("mcpWarn");
    else if (view.muted) node.classList.add("mcpMuted");
  }
  const head = $("th.mcpCell--used", container);
  if (head && usage) head.title = `When the key was last used, and its tool calls in ${windowText(usage.window)}`;
  const note = $(".mcpUsedNote", container);
  if (note) {
    // What the column counts; since when, when the window starts before the counting; and over how many instances it is summed.
    const counted = usage && usage.since != null && usage.from != null && usage.since > usage.from ? ` Counted since ${minuteTime(usage.since)}.` : "";
    const summed = usage && usage.instances.length > 1 ? ` Summed over ${format.count(usage.instances.length)} instances.` : "";
    note.textContent = !usage ? "" : `Used: when each key was last used, and its tool calls in ${windowText(usage.window)}.${counted}${summed}`;
    note.hidden = !usage;
  }
  // A file that is left out of the sum, or a name that two ChDash write under: said under the note.
  const warn = $(".mcpUsedWarn", container);
  if (warn) mcpInstances.warn(warn, usage ? usage.instances : []);
}

// The keys that are not in the list of keys but keep usage: the deleted ones (until the retention ends), and those that only another instance
// knows (`elsewhere`: a key made on the page of another ChDash that shares the usage directory). A line under the keys opens on them, each with
// what it did. view.deletedOpen says whether the list is open and view.openDeletedId which key shows its details (the page keeps both).
function renderDeleted(container, usage, view, actions) {
  const block = $(".mcpDeleted", container);
  if (!block) return;
  const others = usage ? usage.others : [];
  block.hidden = !others.length;
  if (!others.length) {
    block.replaceChildren();
    return;
  }
  const gone = others.filter((line) => line.deletedAt != null).length;
  const apart = others.length - gone;
  const listId = "mcpDeletedList";
  const title = !apart ? "Deleted keys" : !gone ? "Keys of other instances" : "Deleted keys and keys of other instances";
  const toggle = h("button", { type: "button", class: "mcpDeletedToggle", "aria-expanded": view.deletedOpen ? "true" : "false", "aria-controls": listId },
    icon.el("chevron-right", { size: "sm", className: "icon--disclosure mcpKeyChevron" }), h("span", null, title),
    h("span", { class: "mcpDeleted__count" }, String(others.length)));
  const days = usage.retentionDays;
  const stays = `Their usage stays ${format.count(days)} ${days === 1 ? "day" : "days"}.`;
  const head = h("h3", { class: "mcpDeleted__head" }, toggle,
    h("span", { class: "mcpMuted" }, !apart ? stays : !gone ? "Only another instance knows them: this instance has no key of their name." : `${stays} A key that only another instance knows is listed too.`));
  const list = h("div", { class: "mcpDeleted__list", id: listId });
  list.hidden = !view.deletedOpen;
  // The table is built when the list opens: until then the page has one table, the one of the keys.
  const fill = () => { if (!list.childElementCount) list.appendChild(deletedTable(others, usage, view, actions, title)); };
  toggle.addEventListener("click", () => {
    view.deletedOpen = !view.deletedOpen;
    toggle.setAttribute("aria-expanded", view.deletedOpen ? "true" : "false");
    list.hidden = !view.deletedOpen;
    if (view.deletedOpen) fill();
  });
  if (view.deletedOpen) fill();
  block.replaceChildren(head, list);
}

// The keys that keep usage, one line each: the name (it opens what the key did), its host, when it was deleted (or the badge "other
// instance": the column then says "State"), and its use. `title` is the title of the line that opens the table: it is the name of the table.
function deletedTable(others, usage, view, actions, title) {
  const mixed = others.some((line) => line.deletedAt == null);
  const kinds = [["Name", "name"], ["Host", "hosts"], [mixed ? "State" : "Deleted", "deleted"], ["Used", "used"]];
  const headRow = h("tr", { role: "row" }, ...kinds.map(([name, kind]) => {
    const th = h("th", { class: `mcpCell--${kind}`, scope: "col" }, name);
    th.setAttribute("role", "columnheader");
    return th;
  }));
  const tbody = h("tbody", { role: "rowgroup" });
  const asKey = (line) => ({ id: line.id, name: line.name, source: line.source, hosts: line.host ? [line.host] : [], tools: [], databases: [], deletedAt: line.deletedAt, elsewhere: line.elsewhere });
  const close = () => {
    actions.onDetailsClose?.();
    for (const row of $$(".mcpDetailRow", tbody)) row.remove();
    for (const row of $$("tr.is-open", tbody)) {
      row.classList.remove("is-open");
      $('[data-action="open"]', row)?.setAttribute("aria-expanded", "false");
    }
  };
  const open = (line, row) => {
    const cell = h("td", { class: "mcpDetailCell", colspan: String(kinds.length) }, actions.keyDetails({ meta: view.meta, key: asKey(line), deleted: true }));
    cell.setAttribute("role", "cell");
    row.after(h("tr", { class: "mcpDetailRow", id: `mcpDeletedDetail-${line.id}`, role: "row" }, cell));
    row.classList.add("is-open");
    $('[data-action="open"]', row)?.setAttribute("aria-expanded", "true");
  };
  for (const line of others) {
    const deleted = line.deletedAt != null;
    const cell = (label, kind, ...children) => {
      const td = h("td", { class: `mcpCell--${kind}` }, ...children);
      td.setAttribute("role", "cell");
      td.dataset.label = label;
      return td;
    };
    const what = deleted ? "Deleted: show what it did" : "Known to another instance only: show what it did";
    const opener = h("button", { type: "button", class: "mcpKeyOpen", dataset: { action: "open" }, title: `${line.name}\n${what}`, "aria-label": deleted ? `Usage of the deleted key ${line.name}` : `Usage of ${line.name}, a key of another instance`, "aria-expanded": "false", "aria-controls": `mcpDeletedDetail-${line.id}` },
      icon.el("chevron-right", { size: "sm", className: "icon--disclosure mcpKeyChevron" }), h("strong", { class: "mcpKeyName" }, line.name));
    const used = usedView(line, usage);
    // A deleted key says when (and "Deleted" when the column holds both kinds); a key of another instance has a badge.
    const state = deleted
      ? h("span", { title: format.timeTitle(line.deletedAt) }, mixed ? `Deleted ${minuteTime(line.deletedAt)}` : minuteTime(line.deletedAt))
      : badgeMod.el("other instance", { tone: "neutral", size: "sm", title: "Only another instance knows this key: its usage comes from the file of that instance" });
    const row = h("tr", { role: "row", dataset: { deletedId: line.id, state: deleted ? "deleted" : "elsewhere" } },
      cell("Name", "name", opener),
      cell("Host", "hosts", line.host ? h("span", { class: "mcpHostCell" }, line.host) : h("span", { class: "mcpMuted" }, "None")),
      cell(mixed ? "State" : "Deleted", "deleted", state),
      cell("Used", "used", h("span", { class: used.warn ? "mcpWarn" : used.muted ? "mcpMuted" : null, title: used.title }, used.text)));
    opener.addEventListener("click", () => {
      const wasOpen = view.openDeletedId === line.id;
      close();
      view.openDeletedId = wasOpen ? "" : line.id;
      if (!wasOpen) open(line, row);
    });
    tbody.appendChild(row);
    if (view.openDeletedId === line.id) open(line, row);
  }
  if (view.openDeletedId && !others.some((line) => line.id === view.openDeletedId)) view.openDeletedId = "";
  const table = h("table", { class: "dataTable dataTable--compact mcpTable mcpDeletedTable", "aria-label": title }, h("thead", { role: "rowgroup" }, headRow), tbody);
  table.setAttribute("role", "table");
  return h("div", { class: "dataTableWrap mcpTableWrap" }, table);
}

// [label, kind, tier]: a column that matters less leaves the table when the window is narrower than its tier's breakpoint ("mid": 820 px;
// table.css, "Priority columns", UI-130). A key opens its details under its row, and a phone draws the card with every field.
const COLUMNS = [["Name", "name"], ["Secret", "secret"], ["Host", "hosts"], ["Tools", "tools", "mid"], ["Data", "data", "mid"], ["Limits", "limits", "mid"], ["Used", "used", "mid"], ["Actions", "actions"]];
const COLUMN_TITLES = { Used: "When the key was last used, and its tool calls in the last 7 days" };
// The usage is counted only when it is on: the column Used is not there while it is off (the key details have no usage either).
const columnsOf = (meta) => (meta?.usage?.enabled ? COLUMNS : COLUMNS.filter(([, kind]) => kind !== "used"));

// The classes of a column's header and cells: its kind, and its tier when it has one.
const columnClass = (kind) => {
  const tier = COLUMNS.find((column) => column[1] === kind)?.[2];
  return `mcpCell--${kind}${tier ? ` is-${tier}` : ""}`;
};

function keyRow(key, meta, actions, reason) {
  const readOnly = key.source === "config";
  // A key that cannot be deleted (it comes from the config file, or the page is read-only) has no Delete icon: a lock stands
  // where it would be, and says why.
  const locked = readOnly || reason;
  const cell = (label, cls, ...children) => {
    const td = h("td", { class: cls }, ...children);
    td.setAttribute("role", "cell");
    td.dataset.label = label;
    return td;
  };
  // The name opens the details of the key (a click on the row does the same).
  const open = h("button", { type: "button", class: "mcpKeyOpen", dataset: { action: "open" }, title: `${key.name}\n${SOURCE_TITLE[key.source]}\nShow its permissions`, "aria-label": `Details of key ${key.name}`, "aria-expanded": "false", "aria-controls": `mcpDetail-${key.id}` },
    icon.el("chevron-right", { size: "sm", className: "icon--disclosure mcpKeyChevron" }), h("strong", { class: "mcpKeyName" }, key.name));
  open.addEventListener("click", () => actions.onOpen(key, open));
  const nameCell = cell("Name", columnClass("name"), open);
  const lockTitle = readOnly ? SOURCE_TITLE.config : reason;
  const lock = locked ? h("span", { class: "mcpLock", title: lockTitle, role: "img", "aria-label": lockTitle }, icon.el("lock", { size: "sm" })) : null;
  const actionsCell = cell("Actions", columnClass("actions"), locked ? lock : deleteButton(key, actions.onDelete));
  return h("tr", { role: "row", dataset: { keyId: key.id, source: key.source, find: `${key.name} ${key.source}`.toLowerCase() } },
    nameCell,
    cell("Secret", columnClass("secret"), secretCell(key)),
    cell("Host", columnClass("hosts"), hostCell(key, meta)),
    cell("Tools", columnClass("tools"), toolsCell(key, meta)),
    cell("Data", columnClass("data"), dataCell(key)),
    cell("Limits", columnClass("limits"), limitsCell(key, meta)),
    meta.usage.enabled ? cell("Used", columnClass("used"), usedCell(key)) : null,
    actionsCell);
}

// The page gives the details of a key (actions.keyDetails: app_mcp_form.js) and is told when they close
// (actions.onDetailsClose: the "Data it reads" read of the key that closes stops with it).
function closeDetails(tbody, actions) {
  actions.onDetailsClose?.();
  for (const row of $$(".mcpDetailRow", tbody)) row.remove();
  for (const row of $$("tr.is-open", tbody)) {
    row.classList.remove("is-open");
    $('[data-action="open"]', row)?.setAttribute("aria-expanded", "false");
  }
}

function showDetails(tbody, key, meta, actions) {
  const row = $(`tr[data-key-id="${CSS.escape(key.id)}"]`, tbody);
  if (!row) return;
  const cell = h("td", { class: "mcpDetailCell", colspan: String(columnsOf(meta).length) }, actions.keyDetails({ meta, key }));
  cell.setAttribute("role", "cell");
  const detail = h("tr", { class: "mcpDetailRow", id: `mcpDetail-${key.id}`, role: "row", dataset: { detailFor: key.id } }, cell);
  detail.hidden = row.hidden;
  row.after(detail);
  row.classList.add("is-open");
  $('[data-action="open"]', row)?.setAttribute("aria-expanded", "true");
}

// view.openKeyId is the key that shows its details ("" for none); the page owns it and is told of a change
// (actions.onOpenChange), so the next drawing of the list keeps it open. view.meta and view.keys are read when a row opens:
// the page passes its live state (getters), so a row that outlives a redraw never shows the meta of an older one.
function keysTable(keys, meta, actions, view) {
  const reason = manageReason(meta);
  const head = h("tr", null, ...columnsOf(meta).map(([name, kind]) => {
    const th = h("th", { class: columnClass(kind), title: COLUMN_TITLES[name] || null }, name === "Actions" ? h("span", { class: "srOnly" }, name) : name);
    th.setAttribute("scope", "col");
    th.setAttribute("role", "columnheader");
    return th;
  }));
  head.setAttribute("role", "row");
  // The details of a key open under its row, one key at a time: opening another closes this one. The
  // open key stays open when the list is drawn again.
  const toggle = (key, opener) => {
    const wasOpen = view.openKeyId === key.id;
    closeDetails(tbody, actions);
    view.openKeyId = wasOpen ? "" : key.id;
    actions.onOpenChange?.(view.openKeyId);
    // The controller's meta of now, not the one of the render that built this row (ARCH-F-193).
    if (!wasOpen) showDetails(tbody, key, view.meta, actions);
    (opener || $(`tr[data-key-id="${CSS.escape(key.id)}"] [data-action="open"]`, tbody))?.focus();
  };
  // Roles are written out: a phone draws each row as a card and the browser would drop the table.
  const tbody = h("tbody", { role: "rowgroup" }, ...keys.map((key) => keyRow(key, meta, { ...actions, onOpen: toggle }, reason)));
  // A click on the row, outside its buttons and not while text is selected, opens the key.
  tbody.addEventListener("click", (event) => {
    if (event.target.closest("button, a, input, select, textarea, .mcpDetailRow")) return;
    if (String(window.getSelection?.() || "")) return;
    const tr = event.target.closest("tr[data-key-id]");
    const key = tr ? (view.keys || keys).find((item) => item.id === tr.dataset.keyId) : null;
    if (key) toggle(key, $('[data-action="open"]', tr));
  });
  const held = keys.find((key) => key.id === view.openKeyId);
  if (held) showDetails(tbody, held, meta, actions);
  else if (view.openKeyId) {
    view.openKeyId = "";
    actions.onOpenChange?.("");
  }
  const table = h("table", { class: "dataTable dataTable--compact mcpTable" }, h("thead", { role: "rowgroup" }, head), tbody);
  table.setAttribute("role", "table");
  table.setAttribute("aria-label", "Access keys");
  const wrap = tableMod.scrollCues(h("div", { class: "dataTableWrap mcpTableWrap" }, table));
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Access keys, scroll sideways when the table is wider than the page");
  wrap.tabIndex = 0;
  return wrap;
}

// A long list gets a filter (name, source). The text stays between redraws (view.filterText, owned by the page).
const FILTER_FROM = 10;

function applyFilter(container, filterText) {
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

// view: { status: "loading" | "error" | "ready", keys, meta, error, openKeyId, filterText }
// actions: { onCreate, onDelete(key), onRefresh, onRetry, onOpenChange(id), onFilter(text) }
function renderKeys(container, view, actions) {
  const { meta, keys = [] } = view;
  const reason = manageReason(meta);
  const filter = keys.length >= FILTER_FROM && view.status === "ready"
    ? h("input", { class: "uiInput mcpKeys__filter", type: "search", id: "mcpKeysFilter", placeholder: "Filter keys", "aria-label": "Filter the keys by name or source", autocomplete: "off", spellcheck: "false", value: view.filterText || "" })
    : null;
  // Refresh and New key at the right end of the heading.
  const refresh = h("button", { type: "button", class: "refreshButton", id: "mcpRefresh", title: "Refresh", "aria-label": "Refresh" },
    icon.el("refresh", { size: "sm", className: "refreshGlyph" }));
  refresh.addEventListener("click", () => actions.onRefresh(refresh));
  const create = h("button", {
    type: "button",
    class: "button button--primary mcpNewKey",
    id: "mcpNewKey",
    title: reason || "Create a key",
    disabled: reason ? true : null,
    "aria-describedby": reason ? "mcpKeysNote" : null,
  }, icon.el("plus", { size: "sm" }), h("span", null, "New key"));
  if (!reason) create.addEventListener("click", () => actions.onCreate(create));
  const head = h("div", { class: "pagePart__head mcpKeys__head" },
    h("h2", { class: "pagePart__title", id: "mcpKeysTitle" }, "Access keys"),
    view.status === "ready" ? h("span", { class: "pagePart__count" }, String(keys.length)) : null,
    filter,
    h("div", { class: "mcpKeys__actions" }, refresh, create));
  // The note under the head says why the keys cannot change (New key points to it).
  const note = h("div", { class: "mcpKeys__note" });
  note.id = "mcpKeysNote";
  if (reason) uiState.banner(note, { message: reason, level: "info", inset: true });
  else note.hidden = true;
  // The error of an action (the controller fills it).
  const alert = h("div", { class: "mcpKeys__alert" });
  alert.id = "mcpAlert";
  alert.hidden = true;
  const body = h("div", { class: "pagePart__body mcpKeys__body" });
  body.id = "mcpKeysBody";
  if (view.status === "loading") uiState.loading(body, { label: "Loading the keys\u2026" });
  else if (view.status === "error") uiState.error(body, { title: "Could not load the keys", body: util.errorText(view.error), retry: actions.onRetry });
  else if (!keys.length) {
    uiState.empty(body, {
      title: "No access keys yet",
      body: reason ? "Keys defined in the config file will show here." : "Create a key to let an AI client read your data through MCP. The commands to connect are next to this list.",
      action: reason ? null : { label: "New key", primary: true, onClick: () => actions.onCreate(dom.byId("mcpNewKey")) },
    });
  } else {
    body.appendChild(keysTable(keys, meta, actions, view));
    body.appendChild(h("p", { class: "mcpNote mcpKeys__none", hidden: true }, "No key matches this filter."));
    // What the column Used counts, and the warnings about the instances (fillUsage writes them): nothing of it while the usage is off.
    if (meta.usage.enabled) {
      body.appendChild(h("p", { class: "mcpNote mcpNote--fine mcpUsedNote", hidden: true }));
      body.appendChild(h("div", { class: "mcpUsedWarn", hidden: true }));
    }
  }
  // The keys that keep usage without being in the list (renderDeleted fills it once the usage is read).
  if (view.status === "ready" && meta.usage.enabled) body.appendChild(h("div", { class: "mcpDeleted", hidden: true }));
  container.replaceChildren(head, note, alert, body);
  if (filter) {
    filter.addEventListener("input", () => { actions.onFilter?.(filter.value); applyFilter(container, filter.value); });
    applyFilter(container, filter.value);
  }
}

export const mcpView = Object.freeze({ renderSide, renderDisabled, renderUsageOff, renderKeys, fillAccess, fillUsage, renderDeleted, heldTools, secretCell, endpointUrl, authHeader, commands, codeBlock, clientTabs, manageReason, HCL_EXAMPLE, HCL_USAGE_EXAMPLE });
