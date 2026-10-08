# MCP integration page

The **MCP integration** page shows the MCP endpoint of ChDash and the access keys of its clients. An AI client (Claude Desktop, Claude Code, an IDE, your own agent) reads your ClickHouse data through this endpoint. Each key limits the hosts, the tools and the data that its client can use. This file describes the page. The server side (the endpoint, the key store, the `mcp` configuration block) is in `docs/mcp.md`.

## Open the page

The page is at `/mcp-integration`. It is a page of its own (`mcp.html`), like System. It is not tied to a host, so the host picker is hidden.

## Layout

The page has the same frame as System and Observability (the header, then one scrolling panel). It has no bar of its own and no visible title. The page switcher in the header names the page. The `h1` ("MCP integration") is for screen readers only (`srOnly`). The panel is the only scroller. Its inset is `--gutter` (12 px, 10 px at 820 px and below).

Every part sits where it is read first. Nothing stands alone on a row of its own.

```
+--------------------------------------------------------------------------+
| Endpoint [ https://host/mcp ] [copy]                         (refresh) [+ New key] |   the strip
+-------------------------------------------------------+------------------+
| Access keys  11                         [filter]      | Connect a client |
| Name  Secret  Hosts  Tools  Data  Limits  State        | [Code|Desktop|..]|
| one line for each key                                  | command / JSON   |
| ...                                                    |------------------|
|                                                        | Hosts            |
|                                                        | Global limits    |
+-------------------------------------------------------+------------------+
```

1. **The strip.** One bordered row at the top of the panel. It holds the labelled field **Endpoint** with its copy button, and at the right end the **Refresh** icon button and the primary **New key** button. It wraps on a narrow window. On a phone, the field takes the full row and the label is for screen readers only. The strip says nothing of the state of MCP ("MCP enabled", "Storage configured" or "Managed from the UI" told the reader nothing that he could act on): a page that shows keys has MCP on, and what stops a change (no storage file, `manage_from_ui = false`) is the note under the title of the keys.
2. **The keys.** The part "Access keys": its heading (title, count, a filter from 10 keys), a note, an alert, then the keys table. It takes all the width that the side column leaves.
3. **The side column.** One bordered box of three blocks, 30% of the window wide (24 to 29 rem), beside the keys from 1280 px. It stays in view while the keys scroll.
   - **Connect a client.** The tabs of the clients and one code block. Always open. See below.
   - **Hosts.** The hosts that have an `mcp_uri`: the name, the label (when it is not the name) and a health badge (`healthy`, `down` or `unknown`).
   - **Global limits.** A list of the global limits: label at the left, value at the right.

   Under 1280 px the side column goes under the keys and its three blocks stand side by side (from 760 px). On a phone they stack.

The page uses the shared components only. `ns.badge` draws every badge. `ns.uiState` draws the loading, empty and error states and the notes. `ns.dialog` draws the dialogs. The form kit (`.uiForm`, `.uiField`, `.uiInput`, `.uiCheck`) draws the fields. The part heading, the compact data table and its box are shared too. `mcp.css` keeps only what this page alone needs: the hidden host picker, the strip, the two-column layout, the one-line key cells, the card layout of a phone and the code blocks.

The page switcher shows an **MCP** entry only when `/api/version` reports `features.mcp.enabled = true`. The switcher caches the answer in `chdash.pageNav.v1`, like the other entries.

ChDash has no login. Anyone who can open the page can create a key. A key cannot read more than the ClickHouse MCP user can read. To restrict the page, use your reverse proxy or your network. You can also set `manage_from_ui = false`: the page is then read-only.

## States of the page

| State | What the page shows |
| --- | --- |
| Loading | A spinner and a sentence for the first load. A spinner and a sentence for the keys. |
| Error | A message and **Retry**, for the strip and for the keys. |
| MCP off (`{"enabled": false}` from `/api/mcp/meta`) | The part "Turn MCP on", with the badge "MCP is off", the HCL block and a note. No strip, no keys, no side column. |
| Storage not configured | **New key** is off. The reason shows in the note under the title of the keys. The keys of the config file still show. |
| `manage_from_ui = false` | A read-only note. **New key** and every row action are off. |
| No keys | An empty state with **New key** (when the page can create keys). The side column stays, so the commands to connect are next to it. |

A server that does not have the `/api/mcp/*` routes answers `404` for `/api/mcp/meta`. The page treats this as MCP off.

## Endpoint, connect, hosts and limits

- **Endpoint.** The page builds the full URL from its own origin and the `endpoint_path` of the server. A reverse-proxy prefix stays in the URL. A copy button copies it.
- **Connect a client.** One tab for each client, and one block at a time. The blocks use the real endpoint URL and the placeholder `<secret>`. The secret dialog shows the same tabs with the real secret. A line under the block names the protocol versions and says to serve ChDash over HTTPS when a client runs on another machine.
  - **Claude Code.** The `claude mcp add --transport http` command.
  - **Desktop** (Claude Desktop). A block for `claude_desktop_config.json`. It starts the `mcp-remote` bridge with `npx`, and the bridge sends the Bearer header. It needs Node.js.
  - **Inspector** (MCP Inspector). The `npx @modelcontextprotocol/inspector` command and the values to enter: the transport (Streamable HTTP), the URL and the header.
  - **JSON.** The `mcpServers` block of a client that reads a JSON file of servers (`.mcp.json`).
- **Hosts.** The hosts that have an `mcp_uri`, with a health badge.
- **Global limits.** The rows, the timeout, the result size, the SQL size, the memory, the rows read and the requests per minute. A key can lower the rows and the timeout. It never raises them. The request limit counts for each key.

## Keys table

Each key is one line of the table. The rows keep the order of the API (keys of the config file first). The table uses fixed columns: the name takes the rest of the width, and a cell that is too long ends in an ellipsis. The tooltip of the cell says all of it.

| Column | Content |
| --- | --- |
| Name | The name, a button that opens the details of the key (so does a click on the row outside its buttons). The tooltip also says where the key comes from. |
| Secret | The first 8 characters of the secret (a UUID) and dots. At the right, the **eye** shows the whole secret in the cell (on two lines) and the **copy** button copies it. See below. |
| Hosts | `All` (the key lists `*`, as a key of the config file can), `None`, or the names in the code font. |
| Tools | `All`, `None`, one name, or a count ("5 tools"). The tooltip lists the tools. |
| Data | The patterns in the code font. `*` is all the data. `None` for an empty list. |
| Limits | The rows and the timeout, as "100 · 5 s". A value that the key sets shows at full strength. A key without its own value shows the global limit in the muted color. A screen reader reads "(default)" after it. |
| State | A badge: `Active` or `Disabled`. |
| Actions | Four icon buttons: Edit, Disable or Enable, Rotate, Delete. Each has a label for screen readers and a tooltip. |

A key has no description, no expiry and no "last used" column: they are not part of the page. (The server still counts the last use in memory, and `GET /api/mcp/keys` still sends `last_used_at`.)

A key that the page cannot change shows a lock in place of the four buttons. The tooltip says why ("Read-only: this key comes from the config file. Change it there.", or the reason of the page). The source of a key (`config` or `ui`) is in the row (`data-source`), in the tooltip of the name and in the note under the table.

### The secret of a key

- The page asks for the secret only when you press the eye or the copy button: `GET /api/mcp/keys/<id>/secret`. The list never carries a secret.
- The eye shows the secret in the cell and hides it again at the next press, after 30 seconds, or when the table is drawn again. The page keeps it nowhere: not in `localStorage`, not in `sessionStorage`, not in the address.
- The copy button asks for the secret, then copies it. It works without showing it.
- A key whose secret ChDash does not have (`secret_available = false`) shows "Not available", and both buttons are off. Their tooltip says why: a config key made with `secret_sha256` has only its hash in the file; a page key made before ChDash kept secrets must be rotated once.
- ChDash has no login: anyone who can open the page can show every secret that it knows. See `docs/mcp.md`, "Security limits".

From 10 keys, the head of the part shows a filter. It matches the name, the state and the source. The count shows "n of N" while the filter is on. The filter text stays after an action.

The table is a compact data table (`.dataTable--compact`) in a hairline box (`.dataTableWrap`). Under 52 rem the box scrolls sideways. On a phone (600 px and below), each key is a card. The name and the state share the first line. The secret has a line of its own. The hosts, the tools, the data and the limits follow in two columns. The four actions close the card, in two columns, and each one is 40 px high. The label of each cell shows above its value. The table keeps its roles for a screen reader.

## Create and edit a key

**New key** and **Edit** open one form in a dialog. It follows the page that makes a fine-grained token on GitHub (a name, the access, a list of permissions with the level of each) and it is dense on purpose: it fits the dialog without a scroll, at 1280 x 720. At the left, the name, the hosts, the data and the limits. At the right, the permissions. One line of summary under both says what the key will be, or what is still missing.

- **Name.** 32 characters at most (`a-z`, `0-9`, `-`, `_`). The pattern comes from `/api/mcp/meta` (`name_pattern`).
- **Hosts.** One check box for each host that has an `mcp_uri`. You must tick at least one. When only one host has an `mcp_uri`, its box is ticked and cannot be unticked. There is no "All hosts" choice. When you edit a key that lists `*` (a key of the API), the form ticks every host: a save writes the list.
- **Data.** The patterns, one for each line. A pattern is `db`, `db.table`, or uses `*` as a wildcard. `*` alone is all the data. There is no "All data" choice: write `*`.
- **Permissions.** Four groups: Schema, Read, Observability and SQL. Each tool is one line: its name in the code font, the first words of what it does (the tooltip has the whole description), and its access level: **No access** or **Read-only**. Every tool only reads, so there is no other level. **Select all** and **Clear** change every tool that is not locked.
- **Observability.** `list_services`, `search_traces`, `get_trace`, `search_logs`, `list_metrics` and `query_metric`: the simple tools on the OpenTelemetry tables. They start on **No access**, because they read the `otel` data: give the key that data (`otel`, or `*`) and choose them.
- **SQL tools.** `run_query` and `explain_query` stay on **No access**, locked, until the data is `*` alone. The reason shows in the group. If you change the patterns again, the form clears them.
- **Max rows** and **Timeout.** Optional. An empty field keeps the global limit.

**Create key** (or **Save changes**) is off until the key is valid: its title says the first thing that is missing, and the summary line lists them all ("To do: a name · a host · data"). So you cannot send a key with no name or no host. There is no description and no expiry.

### Errors

The form checks the name, the hosts, the data, the permissions and the numbers before it lets you send the key (the button is off). The server decides the rest. An error of the server (`error = "validation"`, with `field` and `reason`) shows under its field. An answer `409 name_taken` shows under the name. The focus moves to that field. The dialog stays open. If the answer names no field, the message shows at the foot of the dialog.

## The details of a key

A click on a key (its name, or its row outside the buttons) opens a dialog with everything about it:

- the state (Active or Disabled) and the source (the page, or the config file);
- the secret, with the eye and the copy button, as in the table;
- the hosts and the data, as chips in the code font (`*` is "all the data");
- the limits: the rows and the timeout, with "(default)" when the key sets none;
- **Permissions**, "n of 13": every tool of the server in its group, with what it does and what the key may do with it (**Read-only** or **No access**). A key with `tools = ["*"]` holds every tool it can hold: the SQL tools only with the data `*` alone.

At the foot, **Close**, and for a key that the page can change: **Delete**, **Rotate secret**, **Disable** (or **Enable**) and **Edit**. Each runs the same action as the buttons of the table, with the same confirmations. A key of the config file, or a page that cannot change keys, has **Close** only. The focus goes back to the name of the key when the dialog closes.

## The secret dialog

After a create or a rotation, the page shows the secret in a dialog. You can also show it later, with the eye of the key. The dialog has these parts:

- the secret (a UUID), with a copy button;
- the tabs of the clients (Claude Code, Desktop, Inspector and JSON), with a copy button for each block. The Claude Code tab has the command `claude mcp add --transport http chdash-<name> <endpoint> --header "Authorization: Bearer <secret>"`.

After a rotation, the dialog also says that you must update every client. The page builds all blocks from the real endpoint URL.

The page does not store the secret. It is not in `localStorage`, in `sessionStorage` or in the address. When the dialog closes, ChDash removes the dialog and its nodes from the page. The keys table shows only the `secret_hint` and dots until you press the eye.

## Actions

| Action | Confirmation | Result |
| --- | --- | --- |
| Disable | Yes | The key answers `401` until you enable it again. |
| Enable | No | The key works again. |
| Rotate | Yes | The old secret stops working at once. The page shows the new secret in the dialog. |
| Delete | Yes (the focus starts on Cancel) | The key is removed. This cannot be undone. |

Each confirmation names what the action touches: the hosts of the key and its last use since ChDash started. The page uses the Rotate icon of two arrows, so it does not look like the Refresh button.

After an action, the page loads the keys again. A failure shows in a banner above the table. A key that is gone, or MCP turned off, loads the page again.

## Keyboard and accessibility

- Every control is a button, a link or a form field. The dialogs trap the focus and give it back when they close.
- Each field has a label. Each group (hosts, data, tools) has a legend. An error is a live region, and its field has `aria-invalid`.
- Row action buttons have a label that names the key ("Disable ci-bot"). The Delete button wears the danger color at rest, so touch users see it too.
- The page works at 390 px without a horizontal scroll. Code blocks scroll inside themselves.
- The page uses the design tokens only. It follows the dark and light themes.
- The document does not scroll. The panel scrolls and the header stays.

## Files

| File | Role |
| --- | --- |
| `src/static/mcp.html` | The shell: `<body data-page="mcp">`, one `h1` (`srOnly`), the panel. |
| `src/static/app_mcp_page.js` | The controller: loads the state, draws the three containers again, runs the actions. |
| `src/static/app_mcp_view.js` | The strip, the side column, the keys table and the states. |
| `src/static/app_mcp_form.js` | The key form (with its overview) and the secret dialog. |
| `src/static/app_api.js` | `getMcpMeta`, `getMcpKeys`, `createMcpKey`, `updateMcpKey`, `rotateMcpKey`, `getMcpKeySecret`, `deleteMcpKey`. They hold every `/api/mcp/*` shape. |
| `src/static/css/10-components/form.css`, `part.css` | The form kit and the part heading that the page shares with other pages. |
| `src/static/css/20-features/mcp.css` | The styles of this page only (`style.mcp.css` is generated from it). |
| `tests/frontend/specs/mcp-page.spec.js` | The Playwright spec, with a mocked API. |
| `tests/harness/test_mcp_page_contract.py` | The source contract. |

## Decisions

- The page has no visible title. The page switcher names the page, as on System. The `h1` stays for screen readers.
- The page has no bar. A bar that holds two buttons costs a full row. The strip holds the endpoint, the status and the two actions in one row, so the keys start high.
- A key is one line. The scope shows as three short columns (hosts, tools, data), not as a block of three lines. This puts a dozen keys in one window.
- The commands to connect a client, the hosts and the global limits are reference. They stand in a side column, always in view, and take no row from the keys. "Connect a client" is not a closed help: a user who has no key yet needs it first.
- The source of a key shows as a lock on the keys that the page cannot change. A `config` badge on every row repeated the same word.
- A page opened with MCP off shows the HCL block and does not redirect. This helps an operator who follows a link.
- A key has no description and no expiry. A description was text that nobody read, and an expiry was a state ("Expired") that the page had to explain. Delete a key that you do not use any more.
- A secret is a UUID version 4 (36 characters). A name is 32 characters at most. Both are short enough for a table cell: the Secret column is 12 rem and the name takes what is left.
- A key can show its secret whenever you ask. The old rule (the secret is shown once, ChDash keeps only a hash) was safer, and it forced a rotation each time a client config was lost. The new rule trades that for convenience: ChDash keeps the secret next to the hash (`docs/mcp.md`, "Secrets and the key file").
- There is no "All hosts" and no "All data" choice. A key lists its hosts, and its data is a list of patterns where `*` is everything. One way to say a thing.
- The client-side server name is `chdash-<key name>`, so two keys do not collide in a client.
- Disable, Rotate and Delete ask for confirmation. Enable does not: it is not destructive.
- The HCL block of the "MCP disabled" state shows `mcp_uri` with the password inside the URI. The MCP user has no separate password setting (see `docs/mcp.md`).
