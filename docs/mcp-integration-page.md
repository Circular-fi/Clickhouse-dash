# MCP integration page

The **MCP integration** page shows the MCP endpoint of ChDash and the access keys of its clients. An AI client (Claude Desktop, Claude Code, an IDE, your own agent) reads your ClickHouse data through this endpoint. Each key limits the hosts, the tools and the data that its client can use. This file describes the page. The server side (the endpoint, the key store, the `mcp` configuration block) is in `docs/mcp.md`.

## Open the page

The page is at `/mcp-integration`. It is a page of its own (`mcp.html`), like System. It is not tied to a host, so the host picker is hidden.

The page switcher shows an **MCP** entry only when `/api/version` reports `features.mcp.enabled = true`. The switcher caches the answer in `chdash.pageNav.v1`, like the other entries.

ChDash has no login. Anyone who can open the page can create a key. A key cannot read more than the ClickHouse MCP user can read. To restrict the page, use your reverse proxy or your network. You can also set `manage_from_ui = false`: the page is then read-only.

## States of the page

| State | What the page shows |
| --- | --- |
| Loading | A spinner for the header block. Three grey rows for the keys. |
| Error | A message and **Retry**, for the header block and for the keys. |
| MCP off (`{"enabled": false}` from `/api/mcp/meta`) | The HCL block that turns MCP on, and a note. No keys section. |
| Storage not configured | **New key** is off. The reason shows in the note under the keys title. The keys of the config file still show. |
| `manage_from_ui = false` | A read-only note. **New key** and every row action are off. |
| No keys | An empty state with **New key** (when the page can create keys). The help "Connect a client" opens by itself. |

A server that does not have the `/api/mcp/*` routes answers `404` for `/api/mcp/meta`. The page treats this as MCP off.

## Header block

- **Badges.** "MCP enabled", "Storage configured" or "No storage file", and "Managed from the UI" or "Read-only".
- **Endpoint URL.** The page builds the full URL from its own origin and the `endpoint_path` of the server. A reverse-proxy prefix stays in the URL. A copy button copies it.
- **Hosts.** The hosts that have an `mcp_uri`, with a health badge (`healthy`, `down` or `unknown`).
- **Limits.** The global limits of the `mcp` block. A key can lower the rows and the timeout. It never raises them.
- **Connect a client.** A help that shows the `claude mcp add` command and the JSON block of a client. It uses the real endpoint URL and the placeholder `<secret>`.

## Keys table

Each row is one key. The rows keep the order of the API (keys of the config file first).

| Column | Content |
| --- | --- |
| Name | The name, the first characters of the secret (`secret_hint`) and the description. |
| Source | `config` (read-only) or `ui`. |
| Scope | The hosts, the tools and the data. `*` shows as "All hosts", "All tools" and "All data". |
| Limits | The rows and the timeout of the key. A key without its own value shows the global limit and "(default)". |
| Expires | The expiration instant, or "Never". |
| Last used | The last use of the key since ChDash started, or "Never". |
| State | `Active`, `Disabled` or `Expired`. |
| Actions | Edit, Disable or Enable, Rotate, Delete. |

A key of the config file is read-only. Its action buttons are off. Their tooltip says to change the key in the config file.

On a phone (600 px and below), each key is a card. The label of each cell shows above its value. The table keeps its roles for a screen reader.

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

## Files

| File | Role |
| --- | --- |
| `src/static/mcp.html` | The shell: `<body data-page="mcp">`, one `h1`. |
| `src/static/app_mcp_page.js` | The controller: loads the state, runs the actions. |
| `src/static/app_mcp_view.js` | The header block, the keys table and the states. |
| `src/static/app_mcp_form.js` | The key form and the secret dialog. |
| `src/static/app_api.js` | `getMcpMeta`, `getMcpKeys`, `createMcpKey`, `updateMcpKey`, `rotateMcpKey`, `deleteMcpKey`. They hold every `/api/mcp/*` shape. |
| `src/static/css/20-features/mcp.css` | The styles (`style.mcp.css` is generated from it). |
| `tests/frontend/specs/mcp-page.spec.js` | The Playwright spec, with a mocked API. |
| `tests/harness/test_mcp_page_contract.py` | The source contract. |

## Decisions

- The page keeps its own visible `h1`. It has no tab row, so the title names the page.
- A page opened with MCP off shows the HCL block and does not redirect. This helps an operator who follows a link.
- The expiration date ends at 23:59:59 UTC of that day. The form keeps the stored instant when you do not change the day.
- The client-side server name is `chdash-<key name>`, so two keys do not collide in a client.
- Disable, Rotate and Delete ask for confirmation. Enable does not: it is not destructive.
- The HCL block of the "MCP disabled" state shows `mcp_uri` with the password inside the URI. The MCP user has no separate password setting (see `docs/mcp.md`).
