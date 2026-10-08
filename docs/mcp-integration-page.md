# MCP integration page

The **MCP integration** page shows the MCP endpoint of ChDash and the access keys of its clients. An AI client (Claude Desktop, Claude Code, an IDE, your own agent) reads your ClickHouse data through this endpoint. Each key limits the hosts, the tools and the data that its client can use. This file describes the page. The server side (the endpoint, the key store, the `mcp` configuration block) is in `docs/mcp.md`.

## Open the page

The page is at `/mcp-integration`. It is a page of its own (`mcp.html`), like System. It is not tied to a host, so the host picker is hidden.

## Layout

The page has the same chrome as System and Observability. It has no visible title. The page switcher in the header names the page. The `h1` ("MCP integration") is for screen readers only (`srOnly`).

From top to bottom, the page has these regions:

1. **The bar.** One row under the header. It is the filter bar of Observability and System (`ns.filterBar`, `.obsFilterBar`), without filters. It is edge to edge, with the standard `--gutter`.
   - At the right end, the **Refresh** icon button and the primary **New key** button. This is the place of Refresh and Search on the other pages.
   - The bar stays on one row at every width.
   - The bar is hidden while MCP is off and while the page loads the state.
2. **The panel.** It is the only scroller of the page. It is full width. Its inset is `--gutter` (12 px, 10 px at 820 px and below). The parts follow each other with a gap of 28 px. Each part has the heading of System (`.pagePart`: title, count).

The parts are these:

| Part | Content |
| --- | --- |
| Endpoint | The status badges beside the title: "MCP enabled", "Storage configured" or "No storage file", and "Managed from the UI" or "Read-only". Then the labelled field **Endpoint URL** with its copy button, and the help **Connect a client**. |
| Hosts | A compact data table of the hosts that have an `mcp_uri`. It shows the host, the label and a health badge. It sits beside Endpoint above 820 px. |
| Limits | One row of boxed stat tiles (`.statTiles--boxed`), one tile for each global limit. |
| Access keys | A note, an alert, then the keys table (a compact data table). |

The page uses the shared components only. `ns.badge` draws every badge. `ns.uiState` draws the loading, empty and error states and the notes. `ns.dialog` draws the dialogs. The form kit (`.uiForm`, `.uiField`, `.uiInput`, `.uiCheck`) draws the fields. The Query library uses the same kit. `mcp.css` keeps only what this page alone needs. These are the hidden host picker, the one-row bar, the multi-line key cells, the card layout of a phone and the code blocks.

The page switcher shows an **MCP** entry only when `/api/version` reports `features.mcp.enabled = true`. The switcher caches the answer in `chdash.pageNav.v1`, like the other entries.

ChDash has no login. Anyone who can open the page can create a key. A key cannot read more than the ClickHouse MCP user can read. To restrict the page, use your reverse proxy or your network. You can also set `manage_from_ui = false`: the page is then read-only.

## States of the page

| State | What the page shows |
| --- | --- |
| Loading | A spinner and a sentence for the first parts. A spinner and a sentence for the keys. |
| Error | A message and **Retry**, for the first parts and for the keys. |
| MCP off (`{"enabled": false}` from `/api/mcp/meta`) | The part "Turn MCP on", with the badge "MCP is off", the HCL block and a note. No bar. No keys part. |
| Storage not configured | **New key** is off. The reason shows in the note under the title of the keys. The keys of the config file still show. |
| `manage_from_ui = false` | A read-only note. **New key** and every row action are off. |
| No keys | An empty state with **New key** (when the page can create keys). The help "Connect a client" opens by itself. |

A server that does not have the `/api/mcp/*` routes answers `404` for `/api/mcp/meta`. The page treats this as MCP off.

## Endpoint, hosts and limits

- **Endpoint URL.** The page builds the full URL from its own origin and the `endpoint_path` of the server. A reverse-proxy prefix stays in the URL. A copy button copies it.
- **Connect a client.** A help that opens and closes. It shows the `claude mcp add` command and the JSON block of a client. It uses the real endpoint URL and the placeholder `<secret>`.
- **Hosts.** The hosts that have an `mcp_uri`, with a health badge (`healthy`, `down` or `unknown`).
- **Limits.** The global limits of the `mcp` block. The tiles show the rows, the timeout, the result size, the SQL size, the memory, the rows read and the requests per minute. A key can lower the rows and the timeout. It never raises them. The request limit counts for each key.

## Keys table

Each row is one key. The rows keep the order of the API (keys of the config file first).

| Column | Content |
| --- | --- |
| Name | The name, the first characters of the secret (`secret_hint`) and the description. |
| Source | A badge: `config` (read-only) or `ui`. |
| Scope | The hosts, the tools and the data. `*` shows as "All hosts", "All tools" and "All data". |
| Limits | The rows and the timeout of the key. A key without its own value shows the global limit and "(default)". |
| Expires | The expiration instant, or "Never". |
| Last used | The last use of the key since ChDash started, or "Never". |
| State | A badge: `Active`, `Disabled` or `Expired`. |
| Actions | Edit, Disable or Enable, Rotate, Delete. |

A key of the config file is read-only. Its action buttons are off. Their tooltip says to change the key in the config file.

The table is a compact data table (`.dataTable--compact`) in a hairline box (`.dataTableWrap`). A cell can hold several lines, so a row can be taller than a row of System. Below 62 rem the box scrolls sideways. On a phone (600 px and below), each key is a card. The label of each cell shows above its value. The table keeps its roles for a screen reader.

## Create and edit a key

**New key** and **Edit** open one form in a dialog.

- **Name.** The pattern comes from `/api/mcp/meta` (`name_pattern`). The form checks it before it sends the request.
- **Description.** Optional.
- **Hosts.** One check box for each host that has an `mcp_uri`, and **All hosts**. The page writes `["*"]` for **All hosts**.
- **Data.** **All data** (`["*"]`) or **Selected data**: patterns, one for each line. A pattern is `db`, `db.table`, or uses `*` as a wildcard.
- **Tools.** Three groups: Schema, Read and SQL. Each tool shows its description. **Select all** and **Clear** change every tool that is on.
- **SQL tools.** `run_query` and `explain_query` stay off while the data is not **All data**. The reason shows in the group ("Needs All data"). If you choose **Selected data**, the form clears them.
- **Max rows** and **Timeout.** Optional. An empty field keeps the global limit.
- **Expires.** A date. The key works until the end of that day (UTC). An empty field means never.

New keys start with the Schema and Read tools on. No host and no pattern is on.

### Errors

The form checks the name, the hosts, the data, the tools and the numbers. The server decides the rest. An error of the server (`error = "validation"`, with `field` and `reason`) shows under its field. An answer `409 name_taken` shows under the name. The focus moves to that field. The dialog stays open. If the answer names no field, the message shows at the foot of the dialog.

## One-time secret

After a create or a rotation, the page shows the secret in a dialog. It has these parts:

- the secret, with a copy button;
- the command `claude mcp add --transport http chdash-<name> <endpoint> --header "Authorization: Bearer <secret>"`;
- the JSON block (`mcpServers`) of a client, with a copy button.

The page builds both from the real endpoint URL. The server never shows the secret again.

The page does not store the secret. It is not in `localStorage`, in `sessionStorage` or in the address. When the dialog closes, ChDash removes the dialog and its nodes from the page. The keys table shows only the `secret_hint`.

## Actions

| Action | Confirmation | Result |
| --- | --- | --- |
| Disable | Yes | The key answers `401` until you enable it again. |
| Enable | No | The key works again. |
| Rotate | Yes | The old secret stops working at once. The page shows the new secret once. |
| Delete | Yes (the focus starts on Cancel) | The key is removed. This cannot be undone. |

After an action, the page loads the keys again. A failure shows in a banner above the table. A key that is gone, or MCP turned off, loads the page again.

## Keyboard and accessibility

- Every control is a button, a link or a form field. The dialogs trap the focus and give it back when they close.
- Each field has a label. Each group (hosts, data, tools) has a legend. An error is a live region, and its field has `aria-invalid`.
- Row action buttons have a label that names the key ("Disable ci-bot").
- The page works at 390 px without a horizontal scroll. Code blocks scroll inside themselves.
- The page uses the design tokens only. It follows the dark and light themes.
- The document does not scroll. The panel scrolls and the header stays.

## Files

| File | Role |
| --- | --- |
| `src/static/mcp.html` | The shell: `<body data-page="mcp">`, one `h1` (`srOnly`), the panel. |
| `src/static/app_mcp_page.js` | The controller: builds the bar, loads the state, runs the actions. |
| `src/static/app_mcp_view.js` | The bar, the parts, the keys table and the states. |
| `src/static/app_mcp_form.js` | The key form and the secret dialog. |
| `src/static/app_api.js` | `getMcpMeta`, `getMcpKeys`, `createMcpKey`, `updateMcpKey`, `rotateMcpKey`, `deleteMcpKey`. They hold every `/api/mcp/*` shape. |
| `src/static/app_ui_filterbar.js` | `ns.filterBar`: the bar under the header. |
| `src/static/css/10-components/form.css`, `part.css` | The form kit and the part heading that the page shares with other pages. |
| `src/static/css/20-features/mcp.css` | The styles of this page only (`style.mcp.css` is generated from it). |
| `tests/frontend/specs/mcp-page.spec.js` | The Playwright spec, with a mocked API. |
| `tests/harness/test_mcp_page_contract.py` | The source contract. |

## Decisions

- The page has no visible title. The page switcher names the page, as on System. The `h1` stays for screen readers.
- The bar holds the two actions only. It stays on one row on a phone. The status badges sit beside the title of the Endpoint part.
- Refresh and New key sit at the right end, where the other pages have Refresh and Search.
- A page opened with MCP off shows the HCL block and does not redirect. This helps an operator who follows a link.
- The expiration date ends at 23:59:59 UTC of that day. The form keeps the stored instant when you do not change the day.
- The client-side server name is `chdash-<key name>`, so two keys do not collide in a client.
- Disable, Rotate and Delete ask for confirmation. Enable does not: it is not destructive.
- The HCL block of the "MCP disabled" state shows `mcp_uri` with the password inside the URI. The MCP user has no separate password setting (see `docs/mcp.md`).
