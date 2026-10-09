# MCP integration page

The **MCP integration** page shows the access keys of ChDash's MCP server and how to connect a client. An AI client (Claude Desktop, Claude Code, an IDE, your own agent) reads your ClickHouse data and the pages of ChDash through the MCP endpoint. Each key limits the host, the tools and the data that its client can use. This file describes the page. The server side (the endpoint, the key store, the tools, the `mcp` configuration block) is in `docs/mcp.md`.

## Open the page

The page is at `/mcp-integration`. It is a page of its own (`mcp.html`), like System. It is not tied to a host, so the host picker is hidden.

## Layout

The page has the same frame as System and Observability (the header, then one scrolling panel). It has no bar, no strip and no visible title. The page switcher in the header names the page. The `h1` ("MCP integration") is for screen readers only (`srOnly`). The panel is the only scroller. Its inset is `--gutter` (12 px, 10 px at 820 px and below).

```
+-------------------------------------------------+------------------------------+
| Access keys  11    [filter]      (refresh) [+ New key] | Connect a client             |
| Name  Secret              Hosts Tools Data Limits    | Endpoint [ https://host/mcp ]|
| name  a1b2c3d4-....-....   one line for each key  [x] | [Code|Desktop|Inspector|JSON] |
| ...                                                   | command / JSON               |
|                                                       |------------------------------|
|                                                       | Hosts                        |
|                                                       | Global limits                |
+-------------------------------------------------+------------------------------+
```

1. **The keys.** The part "Access keys": its heading (title, count, a filter from 10 keys, then **Refresh** and the primary **New key** at the right end), a note, an alert, then the keys table. It takes the left of the page.
2. **The side column.** One bordered box of three blocks, 36% of the window wide (28 to 42 rem), beside the keys from 1366 px. It stays in view while the keys scroll. The panel keeps the room of its scrollbar (`scrollbar-gutter: stable`) whether the content scrolls or not, so opening the details of a key moves nothing sideways. A key is narrow (a name of 32 characters, a UUID), so the column takes the room: the commands and the JSON of the clients read on a few lines.
   - **Connect a client.** The **Endpoint** (a read-only field with its copy button), then the tabs of the clients and one code block. Always open. See below.
   - **Hosts.** The hosts that have an `mcp_uri`: the name, the label (when it is not the name), the ClickHouse user that the tools of a key of this host run as (`chdash_mcp`) and a health badge (`healthy`, `down` or `unknown`). A host whose MCP user cannot connect shows a red **MCP user down** badge instead (its tooltip says why): no key can read it.
   - **Global limits.** A list of the global limits: label at the left, value at the right.

   Under 1366 px the side column goes under the keys and its three blocks stand side by side (from 760 px). On a phone they stack.

The page says nothing of the state of MCP ("MCP enabled", "Storage configured" or "Managed from the UI" told the reader nothing that he could act on). A page that shows keys has MCP on. What stops a change (no storage file, `manage_from_ui = false`) is the note under the title of the keys.

The page uses the shared components only. `ns.badge` draws the badges. `ns.uiState` draws the loading, empty and error states and the notes. `ns.dialog` draws the dialogs. The form kit (`.uiForm`, `.uiField`, `.uiInput`, `.uiCheck`) draws the fields. The part heading, the compact data table and its box are shared too. `mcp.css` keeps only what this page alone needs.

The page switcher shows an **MCP** entry only when `/api/version` reports `features.mcp.enabled = true`. The switcher caches the answer in `chdash.pageNav.v1`, like the other entries.

ChDash has no login. Anyone who can open the page can create a key and show any secret. A key cannot read more than the ClickHouse MCP user can read (the API tools are the exception: see `docs/mcp.md`). To restrict the page, use your reverse proxy or your network. You can also set `manage_from_ui = false`: the page is then read-only.

## States of the page

| State | What the page shows |
| --- | --- |
| Loading | A spinner and a sentence in `#mcpState` for the first load. A spinner and a sentence for the keys. |
| Error | A message and **Retry**, in `#mcpState` and for the keys. |
| MCP off (`{"enabled": false}` from `/api/mcp/meta`) | The part "Turn MCP on", with the badge "MCP is off", the HCL block and a note. No keys, no side column. |
| Storage not configured | **New key** is off. The reason shows in the note under the title of the keys. The keys of the config file still show. |
| `manage_from_ui = false` | A read-only note. **New key** and **Delete** are off. |
| No keys | An empty state with **New key** (when the page can create keys). The side column stays, so the commands to connect are next to it. |

A server that does not have the `/api/mcp/*` routes answers `404` for `/api/mcp/meta`. The page treats this as MCP off.

## Connect a client

One tab for each client, and one block at a time. The blocks use the real endpoint URL and the placeholder `<secret>`. The secret dialog shows the same tabs with the real secret. A line under the block names the protocol versions and says to serve ChDash over HTTPS when a client runs on another machine.

The blocks are **coloured**, with the classes of the SQL highlighter (`.tok-*`), so they follow the colours of the Query editor in both themes: the program, the flags, the URL and the quoted header of a command; the keys, strings and literals of JSON; the labels of the Inspector values; the attributes and blocks of the HCL extract of the MCP-off state. The page cuts the text into text nodes and `<span>` elements (no markup from a value). The copy button copies the plain text.

The header that carries the key is `mcp.auth_header` (`Authorization` by default; `docs/mcp.md`). `/api/mcp/meta` sends it as `auth_header`, and every block uses it. `Authorization` takes `Bearer <secret>`. Another header (for example `X-ChDash-Key`, when a proxy in front of ChDash already uses `Authorization`) takes the secret alone. The line under the blocks names the header.

- **Claude Code.** The `claude mcp add --transport http` command.
- **Desktop** (Claude Desktop). A block for `claude_desktop_config.json`. It starts the `mcp-remote` bridge with `npx`, and the bridge sends the Bearer header. It needs Node.js.
- **Inspector** (MCP Inspector). The `npx @modelcontextprotocol/inspector` command and the values to enter: the transport (Streamable HTTP), the URL and the header.
- **JSON.** The `mcpServers` block of a client that reads a JSON file of servers (`.mcp.json`).

## Keys table

The running text of the page (the notes, the tips of the tools) is justified when it takes several lines.

Each key is one line of the table. The rows keep the order of the API (keys of the config file first). The table uses fixed columns: the name column is narrow (a name has 32 characters at most), the Hosts, Tools and Data columns are narrow so that the secret column can hold a whole UUID, and a cell that is too long ends in an ellipsis. The tooltip of the cell says all of it.

| Column | Content |
| --- | --- |
| Name | The name, a button that opens the details of the key (so does a click on the row outside its buttons). The tooltip also says where the key comes from. |
| Secret | The **eye** and the **copy** button, then the secret: its **first 8 characters** (its hint, which tells the keys apart), **the hyphens in clear**, and a **dot** for every other character (`3f2a9c1e-••••-••••-••••-••••••••••••`). The server sends this mask (`secret_mask`), so a secret that is not a UUID (a key of the config file) keeps its hyphens where they are, and a hidden secret has the length and the shape of the shown one. Every character, letter, hyphen or dot, is drawn in a box of the same width (`1ch`): showing the secret moves nothing. A key known by its hash only (a file written before secrets were kept) shows "Not available". |
| Host | The name of the host, in the code font, cut with an ellipsis. `None` when the key has no host. A key reads one host. In the warning color: a key of an older file that names several hosts ("2 hosts"), a host that has no `mcp_uri` any more, or a host whose MCP user cannot connect; the tooltip says which. |
| Tools | `n/total` (out of the tools of the server), `All` or `None`. The tooltip lists them. |
| Data | How many databases and tables the key reaches: `3 dbs · 142 tables`. It is what the MCP user of the key's host may read (`CHECK GRANT`), cut by the patterns of the key. The table is drawn first (the cell shows an ellipsis), then one request (`GET /api/mcp/access`) counts every key at once, whatever their number: the grants of a host are read once. In the warning colour when the key reaches nothing (`0 dbs · 0 tables`: the patterns match nothing that the user reads); a dash when the host cannot be counted (the MCP user cannot connect, or the request failed). The tooltip says what the number is (and how many tables are read in part) and lists the patterns. Refresh counts again. |
| Limits | The rows and the timeout, as "100 · 5 s". A value that the key sets shows at full strength. A key without its own value shows the global limit in the muted color. A screen reader reads "(default)" after it. |
| Actions | **Delete**, a trash icon with no frame around it (like the gear icons), with a label for screen readers and a tooltip. A key that the page cannot delete (a key of the config file, or `manage_from_ui = false`) has nothing in this cell: no icon, no lock. The tooltip of the name says where the key comes from. |

A key has no description, no expiry, no state and no "last used" column. A key is **made or deleted**: there is no edit, no disable and no rotation. To change a key, delete it and make a new one.

From 10 keys, the head of the part shows a filter. It matches the name and the source. The count shows "n of N" while the filter is on. The filter text stays after an action.

The table is a compact data table (`.dataTable--compact`) in a hairline box (`.dataTableWrap`). Under 49 rem the box scrolls sideways. On a phone (600 px and below), each key is a card. The name is the first line, then the secret. The hosts, the tools, the data and the limits follow in two columns. **Delete** closes the card, 40 px high. The label of each cell shows above its value. The table keeps its roles for a screen reader.

### The secret of a key

- The page asks for the secret only when you press the eye or the copy button: `GET /api/mcp/keys/<id>/secret`. The list never carries a secret.
- While the secret is asked for, the eye is off and has no spinner, so no button moves. The text starts at the same place as the dots did.
- The eye shows the secret in the cell and hides it again at the next press, after 30 seconds, or when the table is drawn again. The page keeps it nowhere: not in `localStorage`, not in `sessionStorage`, not in the address.
- The copy button asks for the secret, then copies it. It works without showing it.
- A key whose secret ChDash does not have (`secret_available = false`) shows "Not available", and both buttons are off. Only a page key of a file written before ChDash kept secrets is in this case (a key of the config file always has its secret): delete it and make a new one.
- ChDash has no login: anyone who can open the page can show every secret that it knows. See `docs/mcp.md`, "Security limits".

## Make a key

**New key** opens a dialog. It follows the page that makes a fine-grained token on GitHub (a name, the access, the permissions) and it is dense on purpose. The dialog has **a fixed size** (58 rem wide, 46 rem high, less on a small screen) that does not follow its content: opening a family or showing an error does not resize it. Each column scrolls inside the dialog when it needs to (the permissions column, when families are open). On a screen under 820 px wide, there is one column and the dialog body scrolls. At the left, the name, the host, the data and the limits. At the right, the permissions. The fields that must be filled have a `*`.

- **Name.** 32 characters at most (`a-z`, `0-9`, `-`, `_`). The pattern comes from `/api/mcp/meta` (`name_pattern`).
- **Host.** A key reads one host: one **radio button** for each host that has an `mcp_uri`, **one under the other**. The first host whose MCP user connects is chosen. A host whose MCP user cannot connect is greyed, with the reason ("The MCP user chdash_mcp cannot connect"; the tooltip has the error of ClickHouse). Under the list, a line says which user the tools run as and how many tools it cannot serve. There is no "All hosts" choice: one key for each host.
- **Data.** The patterns, one for each line. A pattern is `db`, `db.table`, or uses `*` as a wildcard. `*` alone is all the data, and it is **the default**: the grants of the MCP user already limit what a key reads, and a pattern narrows it more. There is no "All data" choice: the field holds `*`.
- **Permissions.** One **card for each family** of tools, set apart by a border and a head. The families come from `/api/mcp/meta` (`tool_groups`): the page names none of them, so a family that is added on the server shows without a change here. Today: Data, Explorer, System, Observability, Query and SQL. A family has at least two tools, so no card is a lone check box. Observability has **sections** (Traces, Logs, Metrics: `tool_groups[].sections` and `tools[].section` of `/api/mcp/meta`), drawn as sub-headings of its card, each with its count; the pages' tools and the simple tools of a signal stand together. A card has the check box of the family (all its tools; half ticked when only some are on), what the family is for, how many tools are on ("3/7") and an arrow that opens the tools: one check box each, with what the tool does. **Every permission is read-only, so each one is a check box**: there is no level to choose.
- **Locked tools.** Only the SQL tools need `*`: they are off and locked, with "needs data *" in the head of the family, until the data is `*` alone. If you change the patterns again, the form clears the SQL tools again. All the others need no `*`: the Explorer tools of one table and the catalog are cut by the patterns on top of the grants of the MCP user, and the rest of the Explorer, System, Observability (Traces, Logs, Metrics, with the simple tools too) and Query are read as the pages read them, with the system user (the permission alone gives them).
- **Tools that the host cannot serve.** The tools that need a grant that their user lacks on the chosen host (`system.documentation` for the MCP user; `system.parts` and the `otel` tables for the system user, for every tool of Observability) are off and locked too, with "no grant" in the head of a family that has no other tool. The tooltip of a tool names the grant that is missing and the statement that gives it. When you choose another host, the form locks and clears the tools again for that host. The server refuses such a tool anyway (`not_grantable`, `docs/mcp.md`).
- **Defaults.** The Data family starts on. The others start off.
- **Max rows** and **Timeout.** Optional. An empty field keeps the global limit.

**Create key** is off until the key is valid. Its title says the first thing that is missing ("Enter a name.", "Choose the host that the key reads.", ...). So you cannot send a key with no name or no host. There is no summary line and no description.

An error of the server shows under its field (`error = "validation"`, with `field` and `reason`; `409 name_taken` under the name). The dialog stays open. An answer that names no field shows at the foot of the dialog.

## The details of a key

A click on a key (its name, or its row outside the buttons) opens its details **in a row under the key**, in the table. There is no popup. **One key at a time**: another key closes the first. A second click on the same key closes it. The name is a button with `aria-expanded` and `aria-controls`, and the focus stays on it. The open key stays open when the list is drawn again (Refresh, an action). Deleting a key takes its details with it. The row spans the whole table. It shows:

- the source (this page, or the config file);
- the host (a chip in the code font, and `as chdash_mcp`: the user that its tools run as) and the data (chips; `*` is "all the data"). A key of an older file that names several hosts, a host that is gone and a host whose MCP user cannot connect say so in the warning color;
- the rows and the timeout, with "(default)" when the key sets none;
- **Permissions**, "n of m": every family of the server, in **two balanced columns**: the tallest families go first, each in the shorter column, so both columns end at about the same height; each column keeps the order of the families and has no empty row between two families; on a phone there is one column. Each family has what the key holds in it ("2 of 8") and, under it, the tools it holds with what each one does. A family with no tool is dimmed. A key with `tools = ["*"]` holds every tool it can hold: the tools that need all the data only with the data `*` alone. A tool that the key holds and that the MCP user of its host cannot serve is struck out, with "not served: chdash_mcp lacks otel.otel_logs" (the tooltip has the `GRANT` statement), and the heading says "3 not served".

Under the permissions, **Data it reads** answers the question "which databases and tables can this key reach?". For the host of the key, the page shows the MCP ClickHouse user (`as chdash_mcp`), the number of tables and databases, and a line that says why: the tables that the user reads (`CHECK GRANT`), and what the patterns of the key keep or leave out. Each database opens on its tables, and a table that the user reads only in part says how many columns. A host that cannot be checked says why. **Check again** asks the grants again (the answer is kept 60 s). The data comes from `GET /api/mcp/keys/<id>/access` (`docs/mcp.md`). What the key reaches is the grants of the MCP user cut by the key: the key never reads more than the user.

The details only show. **Delete** is the button of the row. On a phone, the details are a block under the card of the key.

## The secret dialog

After a create, the page shows the secret in a dialog. You can also show it later, with the eye of the key. The dialog has these parts:

- the secret (a UUID), with a copy button;
- the tabs of the clients (Claude Code, Desktop, Inspector and JSON), with a copy button for each block. The Claude Code tab has the command `claude mcp add --transport http chdash-<name> <endpoint> --header "Authorization: Bearer <secret>"`.

The page builds all blocks from the real endpoint URL. The page does not store the secret. It is not in `localStorage`, in `sessionStorage` or in the address. When the dialog closes, ChDash removes the dialog and its nodes from the page. The keys table shows only dots (with the hyphens) until you press the eye.

## Delete

| Action | Confirmation | Result |
| --- | --- | --- |
| Delete | Yes (the focus starts on Cancel) | The key is removed. Its clients get `401` at once. This cannot be undone. |

The confirmation names what the action touches: the hosts of the key. After the action, the page loads the keys again. A failure shows in a banner above the table. A key that is gone, or MCP turned off, loads the page again.

## Keyboard and accessibility

- Every control is a button, a link or a form field. The dialogs trap the focus and give it back when they close.
- Each field has a label. Each group (hosts, permissions) has a legend. An error is a live region, and its field has `aria-invalid`. The arrow of a family is a button with `aria-expanded` and `aria-controls`.
- Row action buttons have a label that names the key ("Delete ci-bot"). The Delete button wears the danger color at rest, so touch users see it too.
- The page works at 390 px without a horizontal scroll. Code blocks scroll inside themselves.
- The page uses the design tokens only. It follows the dark and light themes.
- The document does not scroll. The panel scrolls and the header stays.

## Files

| File | Role |
| --- | --- |
| `src/static/mcp.html` | The shell: `<body data-page="mcp">`, one `h1` (`srOnly`), the panel (`#mcpState`, `#mcpLayout` with `#mcpKeys` and `#mcpSide`). |
| `src/static/app_mcp_page.js` | The controller: loads the state, draws the containers again, runs create and delete. |
| `src/static/app_mcp_view.js` | The keys part (heading, table), the side column and the states. |
| `src/static/app_mcp_form.js` | The make-a-key dialog, the details of a key (a node that the table puts in a row) and the secret dialog. |
| `src/static/app_ui_dialog.js` | `ns.dialog.open`, with `validate` (the submit button is off while it answers a reason). |
| `src/static/app_api.js` | `getMcpMeta`, `getMcpKeys`, `createMcpKey`, `getMcpKeySecret`, `deleteMcpKey`. They hold every `/api/mcp/*` shape. |
| `src/static/css/10-components/form.css`, `part.css` | The form kit and the part heading that the page shares with other pages. |
| `src/static/css/20-features/mcp.css` | The styles of this page only (`style.mcp.css` is generated from it). |
| `tests/frontend/specs/mcp-page.spec.js` | The Playwright spec, with a mocked API. |
| `tests/harness/test_mcp_page_contract.py` | The source contract. |

## Decisions

- The page has no visible title and no strip. The page switcher names the page, as on System. The endpoint is in the side column, where a client needs it, and New key is in the heading of the keys, where the keys are.
- A key is one line, and its name column is narrow. A name has 32 characters at most and a secret is a UUID, so the room goes to the side column, which holds the commands of the clients.
- A key is made or deleted, never changed. An edit form, a switch and a rotation were three more things to build, explain and test for a key that costs one click to make again. To change a key, delete it and make a new one.
- A key has no description and no expiry. A description was text that nobody read, and an expiry was a state that the page had to explain. Delete a key that you do not use any more.
- A key can show its secret whenever you ask. The old rule (the secret is shown once, ChDash keeps only a hash) was safer, and it forced the loss of a key each time a client config was lost. ChDash keeps the secret next to the hash (`docs/mcp.md`, "Secrets and the key file").
- A key reads one host. A key with several hosts made a client guess which MCP user answers, and a tool call had to name its host. One key for each host: the name of the key says which, and every tool call uses it. There is no "All hosts" and no "All data" choice: the data is a list of patterns where `*` is everything. One way to say a thing.
- A tool that the MCP user of the host cannot serve cannot be given. A key that promised it would fail on every call, and the person who made the key would learn it from a client.
- A permission has two states, so it is a check box. A select with "No access" and "Read-only" asked for a click to open and a click to choose, for the same information.
- The families are not known by the page. With more than 60 tools, a flat list would not fit a dialog and would need a change of the page for each new tool. A family is a row of the server's table; a tool is a row of the API tool table. The page draws what `/api/mcp/meta` sends.
- The source of a key shows as a lock on the keys that the page cannot delete. A `config` badge on every row repeated the same word.
- A page opened with MCP off shows the HCL block and does not redirect. This helps an operator who follows a link.
- The client-side server name is `chdash-<key name>`, so two keys do not collide in a client.
- Delete asks for confirmation: it is destructive.
- The HCL block of the "MCP disabled" state shows `mcp_uri` with the password inside the URI. The MCP user has no separate password setting (see `docs/mcp.md`).
