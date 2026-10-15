# MCP integration page

The **MCP integration** page shows the access keys of ChDash's MCP server and how to connect a client. An AI client (Claude Desktop, Claude Code, an IDE, your own agent) reads your ClickHouse data and the pages of ChDash through the MCP endpoint. Each key limits the host, the tools and the data that its client can use. This file describes the two pages of the section: **Keys** (the access keys and how to connect a client) and **Usage** (what all the keys did: see "The Usage tab"). The server side (the endpoint, the key store, the tools, the `mcp` configuration block) is in `docs/mcp.md`.

## Open the page

The page is at `/mcp-integration`. It is a page of its own (`mcp.html`), like System. It is not tied to a host, so the host picker is hidden.

A row of two links stands under the header, on both pages: **Keys** (`/mcp-integration`) and **Usage** (`/mcp-integration/usage`, `mcpusage.html`). It is the nav row of System: the tab of the current page is underlined and has `aria-current="page"`. The row is in the shell of each page (a script puts the base path of a reverse proxy in its links). It stays when MCP is off: both pages then show "Turn MCP on".

## Layout

The page has the same frame as System and Observability (the header, the nav row of the two links, then one scrolling panel). It has no bar, no strip and no visible title. The page switcher in the header names the page. The `h1` ("MCP integration") is for screen readers only (`srOnly`). The panel is the only scroller. Its inset is `--gutter` (12 px, 10 px at 820 px and below).

```
Keys  Usage                                  the nav row
+-------------------------------------------------+------------------------------+
| Access keys  11    [filter]      (refresh) [+ New key] | Connect a client             |
| Name  Secret     Host Tools Data Limits Used         | Endpoint [ https://host/mcp ]|
| name  a1b2c3d4-..  one line for each key        [x] | [Code|Desktop|Inspector|JSON] |
| Used: ... (a note)    > Deleted keys 2               |                              |
| ...                                                   | command / JSON               |
|                                                       |------------------------------|
|                                                       | Hosts                        |
|                                                       | Global limits                |
+-------------------------------------------------+------------------------------+
```

1. **The keys.** The part "Access keys": its heading (title, count, a filter from 10 keys, then **Refresh** and the primary **New key** at the right end), a note, an alert, then the keys table. It takes the left of the page.
2. **The side column.** One bordered box of three blocks, 36% of the window wide (28 to 42 rem), beside the keys from 1366 px. It stays in view while the keys scroll. The panel keeps the room of its scrollbar (`scrollbar-gutter: stable`) whether the content scrolls or not, so opening the details of a key moves nothing sideways. A key is narrow (a name of 32 characters, the start of its secret), so the column takes the room: the commands and the JSON of the clients read on a few lines.
   - **Connect a client.** The **Endpoint** (a read-only field with its copy button), then the tabs of the clients and one code block. Always open. See below.
   - **Hosts.** The hosts that have an `mcp_uri`: the name, the label (when it is not the name), the ClickHouse user that the tools of a key of this host run as (`chdash_mcp`) and a health badge (`healthy`, `down` or `unknown`). A host whose MCP user cannot connect shows a red **MCP user down** badge instead (its tooltip says why): no key can read it.
   - **Global limits.** A list of the global limits: label at the left, value at the right.

   Under 1366 px the side column goes under the keys and its three blocks stand side by side (from 760 px). On a phone they stack.

The page says nothing of the state of MCP ("MCP enabled", "Storage configured" or "Managed from the UI" told the reader nothing that he could act on). A page that shows keys has MCP on. What stops a change (no storage file, `manage_from_ui = false`) is the note under the title of the keys.

The page uses the shared components only. `badge` draws the badges. `uiState` draws the loading, empty and error states and the notes. `dialog` draws the dialogs. The form kit (`.uiForm`, `.uiField`, `.uiInput`, `.uiCheck`) draws the fields. The part heading, the compact data table and its box are shared too. `mcp.css` keeps only what this page alone needs.

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

A server that does not have the `/api/mcp/*` routes answers `404` for `/api/mcp/meta`. The page treats this as MCP off. The Usage page has its own states (loading, an error with **Try again**, no request): see "The Usage tab".

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

Each key is one line of the table. The rows keep the order of the API (keys of the config file first). The table uses fixed columns: the name column is narrow (a name has 32 characters at most), the secret shows its start only, so that the column Used fits beside the others, and a cell that is too long ends in an ellipsis. The tooltip of the cell says all of it.

| Column | Content |
| --- | --- |
| Name | The name, a button that opens the details of the key (so does a click on the row outside its buttons). The tooltip also says where the key comes from. |
| Secret | The **first 8 characters** of the secret (its hint, which tells the keys apart), the next group of dots and an ellipsis: `3f2a9c1e-••••…`. The tooltip has the whole mask: the hint, **the hyphens in clear**, and a **dot** for every other character (`3f2a9c1e-••••-••••-••••-••••••••••••`, the `secret_mask` that the server sends), then why the secret cannot be shown. The cell has no button: ChDash keeps only a hash of the secret. A key of a file that kept no hint shows dots only. |
| Host | The name of the host, in the code font, cut with an ellipsis. `None` when the key has no host. A key reads one host. In the warning color: a key of an older file that names several hosts ("2 hosts"), a host that has no `mcp_uri` any more, or a host whose MCP user cannot connect; the tooltip says which. |
| Tools | `n/total` (out of the tools of the server), `All` or `None`. The tooltip lists them. |
| Data | How many databases and tables the key reaches: `3 dbs · 142 tables`. It is what the MCP user of the key's host may read (`CHECK GRANT`), cut by the patterns of the key. The table is drawn first (the cell shows an ellipsis), then one request (`GET /api/mcp/access`) counts every key at once, whatever their number: the grants of a host are read once. In the warning colour when the key reaches nothing (`0 dbs · 0 tables`: the patterns match nothing that the user reads); a dash when the host cannot be counted (the MCP user cannot connect, or the request failed). The tooltip says what the number is (and how many tables are read in part) and lists the patterns. Refresh counts again. |
| Limits | The rows and the timeout, as "100 · 5 s". A value that the key sets shows at full strength. A key without its own value shows the global limit in the muted color. A screen reader reads "(default)" after it. |
| Used | When the key was last used and its tool calls in the last 7 days: `2 h ago · 1.2K` (`format.ago` in its short form, and the compact count). The table is drawn first (the cell shows an ellipsis), then one request (`GET /api/mcp/usage?window=7d`) reads the use of every key. **Never** when the key was never used and the counting covers its life (the usage is kept in `mcp.usage_file`, or the key is younger than the start of ChDash); a dash when the usage is in memory and the key is older than it (it may have been used before the start). Muted without a call in the window, in the warning colour when 5% of the calls failed or the rate limit refused a request. The tooltip has the time of the last use, the calls among the requests, the errors and the refusals. A note under the table says what the column counts and, when the usage is in memory, since when (a restart clears it). Refresh reads it again. |
| Actions | **Delete**, a trash icon with no frame around it (like the gear icons), with a label for screen readers and a tooltip. A key that the page cannot delete (a key of the config file, or `manage_from_ui = false`) has nothing in this cell: no icon, no lock. The tooltip of the name says where the key comes from. |

A key has no description, no expiry and no state. Its use shows in the column **Used** and in the usage of its details. A key is **made or deleted**: there is no edit, no disable and no rotation. To change a key, delete it and make a new one.

From 10 keys, the head of the part shows a filter. It matches the name and the source. The count shows "n of N" while the filter is on. The filter text stays after an action.

The table is a compact data table (`.dataTable--compact`) in a hairline box (`.dataTableWrap`). Under 54 rem the box scrolls sideways. From 820 px down, Tools, Data, Limits and Used leave the table (the details of a key show them). On a phone (600 px and below), each key is a card. The name is the first line, then the secret. The hosts, the tools, the data, the limits and the use follow in two columns. **Delete** closes the card, 40 px high. The label of each cell shows above its value. The table keeps its roles for a screen reader.

### The secret of a key

- The secret shows **once**: in the dialog after the create (see "The secret dialog"). The server keeps the SHA-256 of the secret and its first 8 characters. No route gives the secret again, and the table has no eye and no copy button.
- The tooltip of the secret cell says it: a lost secret cannot be found, so delete the key and make a new one.
- The page keeps the secret nowhere: not in `localStorage`, not in `sessionStorage`, not in the address.
- ChDash has no login: anyone who can open the page can make and delete keys. See `docs/mcp.md`, "Security limits".

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

Under the permissions, **Data it reads** answers the question "which databases and tables can this key reach?". For the host of the key, the page shows the MCP ClickHouse user (`as chdash_mcp`), the number of tables and databases, and a line that says why: the tables that the user reads (`CHECK GRANT`), and what the patterns of the key keep or leave out. Each database opens on its tables, and a table that the user reads only in part says "some columns". A host that cannot be checked says why. **Check again** asks the grants again (the answer is kept for `explorer.acl_cache_ttl_ms`, 60 s by default). The data comes from `GET /api/mcp/keys/<id>/access` (`docs/mcp.md`). What the key reaches is the grants of the MCP user cut by the key: the key never reads more than the user.

Under it, **Usage** says what the key did (`docs/mcp.md`, "Usage of a key"), read when the details open (`GET /api/mcp/keys/<id>/usage`):

- a **window**: the buttons `24 h`, `7 d`, `30 d`, `90 d` (and `365 d`), as far as `mcp.usage_retention_days` keeps them, `7 d` first. The window that the reader picks stays for the visit of the page, so two keys are compared on the same window. The heading says the dates of the window, and **Open in Usage** (a link beside them) leads to the Usage tab, cut by this key, in the same window (`/mcp-integration/usage?key=<id>&window=<window>`);
- six tiles: the tool calls (and the requests), the errors (and their share: in the warning colour, in the danger colour from 5%), the refused requests (and how many by the rate limit), the time of a call (average and longest), the bytes returned (and the rows of the tools that build their SQL), the last use (and the first);
- the calls of each hour (24 h) or day, with the errors in the danger colour (the shared sparkline), and the busiest hour or day;
- three compact tables: the **tools** (calls with a bar of their share, errors, average time, bytes returned; the longest call is in the tooltip of the tool), the **results** (`ok`, the error codes, the refusals, with their share) and the **clients** (the name and the version that the client sent in `initialize`, its User-Agent, its requests, when it was first and last seen);
- when the usage is in memory, a line says since when it is counted (a restart clears it); a key without a request in the window says so.

Then **ClickHouse cost**, closed: what the statements of the key cost ClickHouse, read from `system.query_log` of its host (`GET /api/mcp/keys/<id>/cost`; `docs/mcp.md`, "The ClickHouse cost of a key"). It is read **only when it is opened** (a scan of the log), in the window of the usage (24 h, else 7 d), and kept a minute; **Check again** reads it anew. Six tiles (statements and failed ones, bytes and rows read, CPU, the peak of memory, the time, the bytes and rows returned), then the cost **by tool**, the **tables read** the most (a long table name ends in an ellipsis, and its title has the whole name), and the cost **by user** (the MCP user, the system user, or another user in the warning colour). When the runner of the host may not read `query_log`, the block says so and shows the `GRANT` to give (a code block with its copy button); a window too large suggests 24 h. A line says that only the statements named for the key count. When `system.top_queries` is off, the block cannot open and says why.

Each answer of the usage is kept a minute for its key and window: opening the details again shows it at once. Closing the details stops the reads in flight. Refresh forgets what was kept.

The details only show. **Delete** is the button of the row. On a phone, the details are a block under the card of the key.

## Deleted keys

A deleted key keeps its usage until it is older than `mcp.usage_retention_days`. Under the keys, a line **Deleted keys** with their count, and how long their usage stays (in memory: until ChDash restarts), opens on them: one line each, with its name, its host, when it was deleted and its use (as the column Used). The table is built when the line opens. A deleted key opens its details under its line: its host, when it was deleted, then its **Usage** and its **ClickHouse cost**, as for a key. It has no permissions, no data and no Delete. The line is hidden when no deleted key keeps usage. The filter and the count of the keys do not see the deleted keys.

## The Usage tab

**Usage** (`/mcp-integration/usage`, `mcpusage.html`) is the second page of the section. It shows what **all the keys** did, and cuts it by key, by method, by result and by type. The usage of one key stays in the details of that key, which link here (**Open in Usage**). The page is not tied to a host. The server side is `GET /api/mcp/usage/overview` (`docs/mcp.md`).

```
Keys  [Usage]                                                                        the nav row
Usage of all keys   Oct 8 00:00 -> Oct 14 10:00                [24 h|7 d|30 d|90 d] (refresh)
[Key = ops-all x] [Method = run_query x]  Clear filters                              with filters only
[Requests] [Tool calls] [Errors] [Refused] [Call time] [Returned] [Active keys]
+--------------------------------------------------------------------------------------+
| Requests by method  by the UTC day                          [Keys|Methods|Results|Type] |
|   the bars, stacked by method, over the window                                        |
|   query_table 754   ping 100   list_hosts 75   ...   2 more 4        the legend       |
+--------------------------------------------------------------------------------------+
| By key                                         | By result                            |
| By method                                      | Clients                              |
+------------------------------------------------+--------------------------------------+
the notes
```

- **The window.** The buttons come from `/api/mcp/meta` (`usage.windows`): `24 h` (by the hour), then `7 d`, `30 d`, `90 d` and `365 d` as far as `mcp.usage_retention_days` keeps them (by the UTC day). The first load uses `usage.default_window` (`7d`). The heading says the dates of the window. A window that starts before the counting started begins at the first start with the file.
- **The filters.** A filter is a value of a dimension: a key, a method, a result or a type. The values of one dimension match any of them (OR). The dimensions combine (AND). Four things add or remove a filter: a **row** of a table (a click, or Enter or Space on it), an entry of the **legend**, the **x** of a chip, and **Clear filters** (a button beside the list of chips; it shows from two chips). A chip reads `Key = ci-bot` (the name of the key, not its id) or `Type = Tool calls`. A dimension takes 20 values at most. Every figure of the page follows the filters. The server cuts each table with **every filter but its own**, so a filtered table still lists what else the reader can pick. A value that is picked is always in its table (at 0 when nothing matches). The **Clients** table takes the key filter only.
- **The tiles.** Seven: **Requests** (the tool calls, the requests of the protocol and the refused ones), **Tool calls**, **Errors** (the tool calls that ended with an error code and the requests of the protocol that failed, with their share of the requests that were read: the line says "2.73% of read requests" and the title has the whole sentence), **Refused** (the 429 and the requests that were refused before their message was read, and how many by the rate limit), **Call time** (the average and the longest time of a tool call), **Returned** (the bytes of the answers and the rows of the tools that build their own SQL: an API tool counts no row) and **Active keys** ("3 of 5 keys · 1 deleted": the keys that exist and have a request in this view, out of the keys that exist). A deleted key keeps its usage, so one that had a request in this view is counted apart, as "· N deleted" (the line has no such part when none did), and is in neither figure: "7 of 7 keys" is seven keys that exist. The server counts a deleted key with the others (`totals.active_keys`), so the page counts from the rows of the keys table of the answer, which have every filter but the key filter (the page applies that one): a row with requests, when the key filter is empty or has its id, is a key that exists or, with `deleted_at`, a deleted key. When the server cut that table (`omitted.keys` above 0) the rows cannot be counted, and the tile shows `totals.active_keys`, the deleted keys included, with the line "keys with requests" (no ratio, no "deleted"). Errors and Refused take the warning colour when they are not 0, and Errors the danger colour from 5% of the requests read. The sub line of a tile is one line, and the longest that come ("12.3% of read requests", "12,345 by the rate limit", "of 12 keys · 3 deleted") fit the narrowest tile, 9 rem wide (seven on a line at 1100 px): the title of a tile says the rest. A count shows its digits up to a million ("1,013"). The server counts whole milliseconds, so a time of 0 reads "<1 ms". The tiles and the chart have every filter, so the bars add up to the tiles.
- **The chart.** The requests over time, as stacked bars, drawn by the shared chart engine: by the hour for 24 h, by the UTC day for the other windows. The switch **Keys | Methods | Results | Type** says what the bars are stacked by (`split`; the default is Methods). **Type** has four values: **Tool calls**, **Protocol** (`initialize`, `tools/list`, `ping`, the notifications...), **Rate limited** (429) and **Rejected** (refused before their message was read: 400, 413, 415). The chart shows the 8 biggest groups and adds up the others as **N more** (grey). When the split dimension has a filter, the groups are the values that are picked. A group keeps its colour: it comes from a hash of its name, not from its rank, so a name has the same colour in every window and under every filter (two groups of one chart never share a colour: the second takes the next free one). The **legend** is the filter of the split dimension. An entry shows the total of its group and is pressed when its value is a filter. A click adds or removes the filter, and the entries that the filter leaves out dim while the page reads. **N more** is not a filter: pick its values in a table. The tooltip names the bucket (the UTC date of a day, the range of an hour), the groups that have requests, and the total. The axis of a chart by the day is labelled by dates ("Oct 9", one line: the option `xDateOnly` of the engine, a tick for each midnight of the browser, one day apart where the days fit, a week or a month apart where they do not) and never by hours, even on a wide screen that has room for a tick every 6 h; the chart by the hour keeps its hours, with the date under the first one and under each midnight. A drag zooms the chart, as on every chart of the engine, and a zoom that is narrower than a day has no label on its axis (a double click resets it).
- **The tables.** Two columns from 1280 px (the keys over the methods at the left, three fifths of the width, the results over the clients at the right), one under the other below. Each is a compact data table in its box. A table of many rows (the server sends 200 at most) scrolls in its box, which is 24 rem high at most, and its head stays over the rows. A click on a header sorts it (a second click reverses it, and the sort stays for the visit; it is not in the address). A row of By key, By method and By result is a row of the keyboard: Up, Down, Home and End move, Enter or Space picks the value, and the picked row is marked (`is-selected`, `aria-selected`).
  - **By key.** The key, with a badge **deleted** for a key that was deleted (its usage stays), Requests, Calls (with a bar of its share of the key that has the most), Errors (and their share), 429, Avg time, Returned and Last used (when the key was last used, in any window).
  - **By method.** The tools in code. The methods of the protocol are muted, with a badge `protocol`. `unread` (a request that was refused before its message was read) has a badge `refused`, and `unread`, `invalid` and `other` say what they stand for in their tooltip. Requests, Errors, Avg time, Max, Returned and Keys.
  - **By result.** `ok`, the error codes of the tools, `rpc_error_<code>` and the refusals (`429_rate_limited`...), in the warning colour when they are not `ok`. Count (with a bar of its share of all) and Keys.
  - **Clients.** The name and the version that the client sent in `initialize`, or its User-Agent when it sent none. Keys, Requests, First seen and Last seen. A client is counted since it was first seen, as far as the retention keeps it: the window and every filter but the key do not apply to it.
  - When the server cut a table (200 rows, or 50 clients), a line under it says "N more methods not shown". A value that is picked is never cut.
- **The notes.** Under the tables: since when the counting runs ("Counted since ..." when the window starts before it, "Counted in memory since ..., when ClickHouse Dash started: a restart clears it" without `usage_file`), and that an API tool counts no row.
- **The address.** The whole state is in the address: `?window=7d&split=key&key=ops-all&key=ci-bot&method=run_query&result=ok&type=call`. `key`, `method`, `result` and `type` repeat once for each value. A default stays out of it (the default window, the split by method). A change of the window, of the split or of a filter pushes an entry: Back and Forward walk through the filters. A link to the page says what it shows (the details of a key link to `/mcp-integration/usage?key=<id>&window=<window>`). The page fixes an address that it cannot use when it loads (a window that the retention does not keep, a split that is not one, a value that the server would refuse, more than 20 values of a kind) with a replace, not a push.
- **Reading.** One read of `GET /api/mcp/usage/overview` when the page opens, and one for each change. A newer read cancels the one in flight. The figures on screen stay, dimmed, until the answer comes. **Refresh** reads again. There is no timer. A page restored from the back/forward cache reads again.
- **States.** Loading: a spinner and a sentence. An error: its message and **Try again** (the heading, with the window, stays, so the reader can pick another window). A window with no request: the tiles say 0, and the chart says "No request in the last 7 days"; with filters it says "No request has all these filters", with a **Clear filters** button. MCP off: "Turn MCP on", as on the Keys page.

## The secret dialog

After a create, the page shows the secret in a dialog. This is the only time. The dialog says so. It has these parts:

- the secret (a UUID), with a copy button;
- the tabs of the clients (Claude Code, Desktop, Inspector and JSON), with a copy button for each block. The Claude Code tab has the command `claude mcp add --transport http chdash-<name> <endpoint> --header "Authorization: Bearer <secret>"`.

The page builds all blocks from the real endpoint URL. The page does not store the secret. It is not in `localStorage`, in `sessionStorage` or in the address. When the dialog closes, ChDash removes the dialog and its nodes from the page. The keys table shows only the hint and dots (with the hyphens).

## Delete

| Action | Confirmation | Result |
| --- | --- | --- |
| Delete | Yes (the focus starts on Cancel) | The key is removed. Its clients get `401` at once. This cannot be undone. |

The confirmation names what the action touches: the hosts of the key. After the action, the page loads the keys again. A failure shows in a banner above the table. A key that is gone, or MCP turned off, loads the page again.

## Keyboard and accessibility

- Every control is a button, a link or a form field. The dialogs trap the focus and give it back when they close.
- Each field has a label. Each group (hosts, permissions) has a legend. An error is a live region, and its field has `aria-invalid`. The arrow of a family is a button with `aria-expanded` and `aria-controls`.
- Row action buttons have a label that names the key ("Delete ci-bot"). The Delete button wears the danger color at rest, so touch users see it too.
- The Usage tab: a row of a table is a row of the keyboard (Up, Down, Home, End, then Enter or Space). A chip has a remove button with a label ("Remove filter Key = ci-bot"), and the keyboard moves on to the next chip when one goes. A legend entry is a button with `aria-pressed`. Every table has a label, a scope on each header and a header on each row. A change says what it found, once, in the live region of the page ("1,012 requests in the last 7 days with these filters.").
- The page works at 390 px without a horizontal scroll. Code blocks scroll inside themselves. A table of the Usage tab that is wider than its box scrolls in it.
- The page uses the design tokens only. It follows the dark and light themes.
- The document does not scroll. The panel scrolls and the header stays.

## Files

| File | Role |
| --- | --- |
| `src/static/mcp.html` | The shell of Keys: `<body data-page="mcp">`, one `h1` (`srOnly`), the row of the two pages (`#mcpTabs`), the panel (`#mcpState`, `#mcpLayout` with `#mcpKeys` and `#mcpSide`). |
| `src/static/mcpusage.html` | The shell of Usage: the same body and row, the panel (`#mcpState`, `#mcpOverview`). |
| `src/static/app_page_mcp.js` | The controller of Keys: loads the state, draws the containers again, runs create and delete. |
| `src/static/app_page_mcpusage.js` | The controller of Usage: loads the meta, shows "Turn MCP on" or hands the panel to the view. |
| `src/static/app_mcp_overview.js` | The Usage tab: the window, the filters (chips, legend, rows), the tiles, the chart, the four tables, the notes, the address. |
| `src/static/app_mcp_view.js` | The keys part (heading, table), the side column and the states. |
| `src/static/app_mcp_form.js` | The make-a-key dialog, the details of a key (a node that the table puts in a row) and the secret dialog. |
| `src/static/app_mcp_usage.js` | The usage of a key and the ClickHouse cost of its statements, the two sections at the end of its details. |
| `src/static/app_ui_dialog.js` | `dialog.open`, with `validate` (the submit button is off while it answers a reason). |
| `src/static/app_api.js` | `getMcpMeta`, `getMcpKeys`, `createMcpKey`, `deleteMcpKey`, `getMcpUsageSummary`, `getMcpKeyUsage`, `getMcpUsageOverview`, `getMcpKeyCost`. They hold every `/api/mcp/*` shape. |
| `src/static/css/10-components/form.css`, `part.css` | The form kit and the part heading that the page shares with other pages. |
| `src/static/css/20-features/mcp.css` | The styles of the two MCP pages (`style.mcp.css` and `style.mcpusage.css` are generated from it). The nav row is in `shell.css`, shared with System. |
| `tests/frontend/specs/mcp-page.spec.js` | The Playwright spec of Keys, with a mocked API. |
| `tests/frontend/specs/mcp-usage.spec.js` | The Playwright spec of Usage. The mocked API (`tests/frontend/helpers/mcp-fake.js`) computes its answers from a list of cells by the rules of the contract. |
| `tests/frontend/specs/mcp-contract.spec.js` | Compares the answers of the mocked API with those of a real instance, the overview included. |

## Decisions

- The page has no visible title and no strip. The page switcher names the page, as on System. The endpoint is in the side column, where a client needs it, and New key is in the heading of the keys, where the keys are.
- A key is one line, and its name column is narrow. A name has 32 characters at most, so the room goes to the side column, which holds the commands of the clients.
- The secret shows its start only (`3f2a9c1e-••••…`, decided 2026-10-14): the hint tells the keys apart, the whole mask is in the tooltip, and the column Used fits beside the others without a column that leaves at some widths.
- The use of a key shows in the table and in its details (decided 2026-10-14): the column says which keys are used and how much, the details say how. The column is one request for every key, for a fixed window (7 days); the details pick their window. The last use comes from the usage of the key: it survives a restart when `mcp.usage_file` is set. A key that the counting does not cover since its creation is a dash, not "Never".
- The usage of all the keys is a page of its own, **Usage** (decided 2026-10-15). On 2026-10-14 the owner had set a global view aside; the next day he asked for one, on the model of the usage page of Helius: tiles, bars over time that one dimension stacks, filters that are chips, a window. It answers "how is MCP used?": by which keys, which methods, with which results, over time. It is a second page of the section, with a row of two links as System has its sections, because the keys page is full and a chart with four tables needs the room.
- Every dimension of the Usage tab filters every other (decided 2026-10-15). The questions are crossings ("which method fails for this key?", "which key is refused?"), so the server keeps the cells (type, method, result) of each key for each hour or day, and every filter combines with the others. A table has every filter but its own, so that it lists what else can be picked. The clients are the exception: they stay counted over the life of the keys, with the key filter only, and no new storage keeps them by window.
- The "methods" are the tools and the methods of the MCP protocol (decided 2026-10-15): a fixed vocabulary, so that a client cannot fill the memory with names (a method that is not in it counts as `other`, one that cannot be read as `invalid`, a request that was refused before its message was read as `unread`).
- The chart colours a group by a hash of its name, not by its rank. A rank changes with every window and every filter, and a person who follows "ping" from 7 days to 24 hours would lose it. The groups of one chart never share a colour.
- A legend entry, a row and a chip are three ways to one filter. The chart is the first thing that the reader sees, so its legend has to filter; the tables are where the values are listed (and where the groups that the chart folds into "N more" are found); the chips say what is on, and remove it.
- The ClickHouse cost of a key is read only when its block is opened: it scans `system.query_log` of the host. The usage, counted by ChDash, is read when the details open.
- A deleted key keeps its usage, and its line opens on it under the keys, so a key that leaked and was deleted can still be looked at. It is not a row of the keys table: its secret, tools, data and limits mean nothing, and the filter and the count stay about the keys that exist.
- A key is made or deleted, never changed. An edit form, a switch and a rotation were three more things to build, explain and test for a key that costs one click to make again. To change a key, delete it and make a new one.
- A key has no description and no expiry. A description was text that nobody read, and an expiry was a state that the page had to explain. Delete a key that you do not use any more.
- A secret shows once, and ChDash keeps only its hash. A page that could show every secret again gave all the durable credentials to anyone who could reach the page (or to a site that tricked a browser into calling it). The cost is that a lost secret means a new key, which is one click (`docs/mcp.md`, "Secrets and the key file").
- A key reads one host. A key with several hosts made a client guess which MCP user answers, and a tool call had to name its host. One key for each host: the name of the key says which, and every tool call uses it. There is no "All hosts" and no "All data" choice: the data is a list of patterns where `*` is everything. One way to say a thing.
- A tool that the MCP user of the host cannot serve cannot be given. A key that promised it would fail on every call, and the person who made the key would learn it from a client.
- A permission has two states, so it is a check box. A select with "No access" and "Read-only" asked for a click to open and a click to choose, for the same information.
- The families are not known by the page. With more than 60 tools, a flat list would not fit a dialog and would need a change of the page for each new tool. A family is a row of the server's table; a tool is a row of the API tool table. The page draws what `/api/mcp/meta` sends.
- The source of a key shows as a lock on the keys that the page cannot delete. A `config` badge on every row repeated the same word.
- A page opened with MCP off shows the HCL block and does not redirect. This helps an operator who follows a link.
- The client-side server name is `chdash-<key name>`, so two keys do not collide in a client.
- Delete asks for confirmation: it is destructive.
- The HCL block of the "MCP disabled" state shows `mcp_uri` with the password inside the URI. The MCP user has no separate password setting (see `docs/mcp.md`).
