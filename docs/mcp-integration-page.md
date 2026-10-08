# MCP integration page

The **MCP integration** page shows the MCP endpoint of ChDash and the access keys of its clients. An AI client (Claude Desktop, Claude Code, an IDE, your own agent) reads your ClickHouse data through this endpoint. Each key limits the hosts, the tools and the data that its client can use. This file describes the page. The server side (the endpoint, the key store, the `mcp` configuration block) is in `docs/mcp.md`.

## Open the page

The page is at `/mcp-integration`. It is a page of its own (`mcp.html`), like System. It is not tied to a host, so the host picker is hidden.

## Layout

The page has the same frame as System and Observability (the header, then one scrolling panel). It has no bar of its own and no visible title. The page switcher in the header names the page. The `h1` ("MCP integration") is for screen readers only (`srOnly`). The panel is the only scroller. Its inset is `--gutter` (12 px, 10 px at 820 px and below).

Every part sits where it is read first. Nothing stands alone on a row of its own.

```
+--------------------------------------------------------------------------+
| Endpoint [ https://host/mcp ] [copy]  (badges)              (refresh) [+ New key] |   the strip
+-------------------------------------------------------+------------------+
| Access keys  11                         [filter]      | Connect a client |
| Name  Hosts  Tools  Data  Limits  Expires  Used  State | [Code|Desktop|..]|
| one line for each key                                  | command / JSON   |
| ...                                                    |------------------|
|                                                        | Hosts            |
|                                                        | Global limits    |
+-------------------------------------------------------+------------------+
```

1. **The strip.** One bordered row at the top of the panel. It holds the labelled field **Endpoint** with its copy button, the three status badges ("MCP enabled", "Storage configured" or "No storage file", "Managed from the UI" or "Read-only"), and at the right end the **Refresh** icon button and the primary **New key** button. It wraps on a narrow window. On a phone, the field takes the full row and the label is for screen readers only.
2. **The keys.** The part "Access keys": its heading (title, count, a filter from 10 keys), a note, an alert, then the keys table. It takes all the width that the side column leaves.
3. **The side column.** One bordered box of three blocks, 21 rem wide, beside the keys from 1180 px. It stays in view while the keys scroll.
   - **Connect a client.** The tabs of the clients and one code block. Always open. See below.
   - **Hosts.** The hosts that have an `mcp_uri`: the name, the label (when it is not the name) and a health badge (`healthy`, `down` or `unknown`).
   - **Global limits.** A list of the global limits: label at the left, value at the right.

   Under 1180 px the side column goes under the keys and its three blocks stand side by side (from 760 px). On a phone they stack.

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
| Name | The name, then the description in the muted color. A key without a description shows the first characters of its secret (`secret_hint`) instead. The tooltip of the cell shows the name, the description, the hint and where the key comes from. |
| Hosts | `All`, `None`, or the names in the code font. |
| Tools | `All`, `None`, one name, or a count ("5 tools"). The tooltip lists the tools. |
| Data | `All`, `None`, or the patterns in the code font. |
| Limits | The rows and the timeout, as "100 · 5 s". A value that the key sets shows at full strength. A key without its own value shows the global limit in the muted color. A screen reader reads "(default)" after it. |
| Expires | The expiration day in UTC (`YYYY-MM-DD`), or "Never". The tooltip shows the instant. |
| Last used | The last use of the key since ChDash started, or "Never". |
| State | A badge: `Active`, `Disabled` or `Expired`. |
| Actions | Four icon buttons: Edit, Disable or Enable, Rotate, Delete. Each has a label for screen readers and a tooltip. |

A key that the page cannot change shows a lock in place of the four buttons. The tooltip says why ("Read-only: this key comes from the config file. Change it there.", or the reason of the page). The source of a key (`config` or `ui`) is in the row (`data-source`), in the tooltip of the name and in the note under the table.

From 10 keys, the head of the part shows a filter. It matches the name, the description, the state and the source. The count shows "n of N" while the filter is on. The filter text stays after an action.

The table is a compact data table (`.dataTable--compact`) in a hairline box (`.dataTableWrap`). Under 66 rem the box scrolls sideways. On a phone (600 px and below), each key is a card. The name and the state share the first line. The hosts, the tools, the data, the limits and the two dates follow in two columns. The four actions close the card, in two columns, and each one is 40 px high. The label of each cell shows above its value. The table keeps its roles for a screen reader.

## Create and edit a key

**New key** and **Edit** open one form in a dialog.

- **Name.** The pattern comes from `/api/mcp/meta` (`name_pattern`). The form checks it before it sends the request.
- **Description.** Optional.
- **Hosts.** One check box for each host that has an `mcp_uri`, and **All hosts**. The page writes `["*"]` for **All hosts**.
- **Data.** **All data** (`["*"]`) or **Selected data**: patterns, one for each line. A pattern is `db`, `db.table`, or uses `*` as a wildcard.
- **Tools.** Three groups: Schema, Read and SQL. Each tool shows its name in the code font and the first sentence of its description. The tooltip shows the whole description. **Select all** and **Clear** change every tool that is on.
- **SQL tools.** `run_query` and `explain_query` stay off while the data is not **All data**. The reason shows in the group ("Needs All data"). If you choose **Selected data**, the form clears them.
- **Max rows** and **Timeout.** Optional. An empty field keeps the global limit.
- **Expires.** A date. The key works until the end of that day (UTC). An empty field means never.

New keys start with the Schema and Read tools on. No host and no pattern is on.

### Errors

The form checks the name, the hosts, the data, the tools and the numbers. All the problems show at once, each one under its field. The focus goes to the first one. The hint of a field stays in the description of its control, after the error. The server decides the rest. An error of the server (`error = "validation"`, with `field` and `reason`) shows under its field. An answer `409 name_taken` shows under the name. The focus moves to that field. The dialog stays open. If the answer names no field, the message shows at the foot of the dialog.

## One-time secret

After a create or a rotation, the page shows the secret in a dialog. It has these parts:

- the secret, with a copy button;
- the tabs of the clients (Claude Code, Desktop, Inspector and JSON), with a copy button for each block. The Claude Code tab has the command `claude mcp add --transport http chdash-<name> <endpoint> --header "Authorization: Bearer <secret>"`.

After a rotation, the dialog also says that you must update every client. The page builds all blocks from the real endpoint URL. The server never shows the secret again.

The page does not store the secret. It is not in `localStorage`, in `sessionStorage` or in the address. When the dialog closes, ChDash removes the dialog and its nodes from the page. The keys table shows only the `secret_hint`.

## Actions

| Action | Confirmation | Result |
| --- | --- | --- |
| Disable | Yes | The key answers `401` until you enable it again. |
| Enable | No | The key works again. |
| Rotate | Yes | The old secret stops working at once. The page shows the new secret once. |
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
| `src/static/app_mcp_form.js` | The key form and the secret dialog. |
| `src/static/app_api.js` | `getMcpMeta`, `getMcpKeys`, `createMcpKey`, `updateMcpKey`, `rotateMcpKey`, `deleteMcpKey`. They hold every `/api/mcp/*` shape. |
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
- The expiration date ends at 23:59:59 UTC of that day. The form keeps the stored instant when you do not change the day.
- The client-side server name is `chdash-<key name>`, so two keys do not collide in a client.
- Disable, Rotate and Delete ask for confirmation. Enable does not: it is not destructive.
- The HCL block of the "MCP disabled" state shows `mcp_uri` with the password inside the URI. The MCP user has no separate password setting (see `docs/mcp.md`).
