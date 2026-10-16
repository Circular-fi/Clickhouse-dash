# MCP integration page

The **MCP integration** page shows the access keys of the ChDash MCP server. It also shows how to connect a client. An AI client reads your ClickHouse data and the pages of ChDash through the MCP endpoint. Examples of AI clients are Claude Desktop, Claude Code, an IDE and your own agent. Each key limits the host, the tools and the data that its client can use.

This file describes the two pages of the section. **Keys** shows the access keys and how to connect a client. **Usage** shows what all the keys did. See "The Usage tab".

The server side is in `docs/mcp.md`. That file covers the endpoint, the key store, the tools and the `mcp` configuration block. ChDash counts the usage only when `mcp.usage.enabled` is true. While it is false, the pages say so and show the rest. See "Usage is off".

Several ChDash instances can share the usage directory. The figures are then the sum of all of them. See "Instances".

## Open the page

The page is at `/mcp-integration`. It is a separate page (`mcp.html`), like System. It is not tied to a host. Therefore, the host picker is hidden.

A row of two links is under the header on both pages. The links are **Keys** (`/mcp-integration`) and **Usage** (`/mcp-integration/usage`, `mcpusage.html`). This row is the nav row of System. The tab of the current page is underlined and has `aria-current="page"`.

The row is in the shell of each page. A script adds the base path of a reverse proxy to its links. The row stays when MCP is off. Both pages then show "Turn MCP on".

## Layout

The page has the same frame as System and Observability. The frame has the header, the nav row of the two links and one panel. The panel scrolls.

The page has no bar, no strip and no visible title. The page switcher in the header names the page. The `h1` ("MCP integration") is for screen readers only (`srOnly`). The panel is the only element that scrolls. Its inset is `--gutter` (12 px, or 10 px at 820 px and below).

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

1. **The keys.** The part "Access keys" has a heading. The heading holds the title, the count and a filter. The filter appears from 10 keys. At the right end, the heading holds **Refresh** and the primary **New key**. Below the heading, the part has a note, an alert and the keys table. The part is at the left of the page.
2. **The side column.** One bordered box holds three blocks. The box is 36% of the window width (28 to 42 rem). It stands beside the keys from 1366 px. It stays in view while the keys scroll.

   The panel keeps the space of its scrollbar (`scrollbar-gutter: stable`), whether the content scrolls or not. Therefore, the details of a key do not move anything sideways. The keys are narrow. A name has 32 characters at most, and the secret shows only its start. Therefore, the column takes the room that is left. The commands and the JSON of the clients fit on a few lines.

   - **Connect a client.** This block has the **Endpoint**. The **Endpoint** is a read-only field with a copy button. Below it are the tabs of the clients and one code block. The block is always open. See below.
   - **Hosts.** This block lists the hosts that have an `mcp_uri`. For each host, it shows the name. It shows the label too, when the label differs from the name. It also shows the ClickHouse user. The tools of a key on this host run as this user (`chdash_mcp`). A health badge shows `healthy`, `down` or `unknown`.

     A host whose MCP user cannot connect shows a red **MCP user down** badge. Its tooltip gives the reason. No key can read such a host.
   - **Global limits.** This block lists the global limits. The label is at the left, and the value is at the right. ChDash counts the request limit for each key on each instance. Each ChDash that shares the usage directory has its own counter. The note under the list says so.

   Below 1366 px, the side column moves under the keys. Its three blocks stand side by side from 760 px. On a phone, the blocks stack.

The page does not show the state of MCP. Labels such as "MCP enabled", "Storage configured" or "Managed from the UI" give the reader no information that the reader can use. A page that shows keys has MCP on. The note under the title of the keys gives the reason when a change is blocked. The reasons are: no storage file, or `keys.mode = "static"`.

The page uses only the shared components. `badge` shows the badges. `uiState` shows the loading, empty and error states, and the notes. `dialog` shows the dialogs. The form kit (`.uiForm`, `.uiField`, `.uiInput`, `.uiCheck`) styles the fields.

The part heading, the compact data table and its box are shared too. `mcp.css` keeps only the styles that this page alone needs.

The page switcher shows an **MCP** entry only when `/api/version` reports `features.mcp.enabled = true`. The switcher stores the answer in `chdash.pageNav.v1`, as it does for the other entries.

ChDash has no login. Anyone who can open the page can create a key and show any secret. A key cannot read more than the ClickHouse MCP user can read. The API tools are the exception.

See `docs/mcp.md`. To restrict the page, use your reverse proxy or your network. You can also set `keys { mode = "static" }`. The page is then read-only.

## States of the page

| State | What the page shows |
| --- | --- |
| Loading | The page shows a spinner and a sentence in `#mcpState` for the first load. It also shows a spinner and a sentence for the keys. |
| Error | The page shows a message and **Retry**, in `#mcpState` and for the keys. |
| MCP off (`{"enabled": false}` from `/api/mcp/meta`) | The page shows the part "Turn MCP on". It has the badge "MCP is off", the HCL block and a note. It has no keys and no side column. |
| Usage off (`usage.enabled` is false in `/api/mcp/meta`) | On the Usage tab, the page shows the state "Usage is off" and no bar (see "Usage is off"). Nothing reads the usage. On the Keys page, the table has no column Used. The page shows no line of keys that keep usage. The details of a key show no usage. The ClickHouse cost of a key stays. |
| Storage not configured | **New key** is off. The note under the title of the keys gives the reason. The page still shows the keys of the config file. |
| `keys.mode = "static"` | The page shows a read-only note. **New key** and **Delete** are off. |
| No keys | The page shows an empty state with **New key** (when the page can create keys). The side column stays. The commands to connect are next to it. |

A server that has no `/api/mcp/*` routes answers `404` for `/api/mcp/meta`. The page treats this answer as MCP off. The Usage page has its own states: loading, an error with **Try again**, and no request. See "The Usage tab".

## Connect a client

The page has one tab for each client. It shows one block at a time. The blocks use the real endpoint URL and the placeholder `<secret>`. The secret dialog shows the same tabs with the real secret. A line under the block names the protocol versions. The line also says to serve ChDash over HTTPS when a client runs on another machine.

The blocks are **coloured**. They use the classes of the SQL highlighter (`.tok-*`). Therefore, they follow the colours of the Query editor in both themes.

The colours apply to these parts: the program, the flags, the URL and the quoted header of a command. They also apply to the keys, strings and literals of JSON. They apply to the labels of the Inspector values. They also apply to the attributes and blocks of the HCL extract of the MCP-off state.

The page splits the text into text nodes and `<span>` elements. No markup comes from a value. The copy button copies the plain text.

The header that carries the key is `mcp.auth_header`. Its default is `Authorization` (see `docs/mcp.md`). `/api/mcp/meta` sends it as `auth_header`. Every block uses this header.

`Authorization` takes `Bearer <secret>`. Another header takes the secret alone. For example, use `X-ChDash-Key` when a proxy in front of ChDash already uses `Authorization`. The line under the blocks names the header.

- **Claude Code.** The `claude mcp add --transport http` command.
- **Desktop** (Claude Desktop). This block is for `claude_desktop_config.json`. It starts the `mcp-remote` bridge with `npx`. The bridge sends the Bearer header. This client needs Node.js.
- **Inspector** (MCP Inspector). This block has the `npx @modelcontextprotocol/inspector` command. It also lists the values to enter: the transport (Streamable HTTP), the URL and the header.
- **JSON.** The `mcpServers` block for a client that reads a JSON file of servers (`.mcp.json`).

## Keys table

The body text of the page is justified when it takes several lines. This text includes the notes and the tips of the tools.

Each key takes one line of the table. The rows keep the order of the API. The keys of the config file come first. The table uses fixed columns.

The name column is narrow, because a name has 32 characters at most. The secret shows only its start. Therefore, the column Used fits beside the others. A cell that is too long ends in an ellipsis. The tooltip of the cell shows all of the text.

| Column | Content |
| --- | --- |
| Name | The name. It is a button that opens the details of the key. A click on the row, outside its buttons, also opens the details. The tooltip also gives the source of the key. |
| Secret | The **first 8 characters** of the secret. This is the hint, which tells the keys apart. Next comes a group of dots and an ellipsis: `3f2a9c1e-••••…`. The tooltip has the whole mask. The mask shows the hint, **the hyphens in clear**, and a **dot** for every other character (`3f2a9c1e-••••-••••-••••-••••••••••••`, the `secret_mask` that the server sends). The tooltip also gives the reason why the secret cannot be shown. The cell has no button. ChDash keeps only a hash of the secret. A key from a file that kept no hint shows dots only. |
| Host | The name of the host, in the code font. It ends in an ellipsis when it is too long. The cell shows `None` when the key has no host. A key reads one host. The text is in the warning color in three cases. These cases are: a key from an older file that names several hosts ("2 hosts"); a host that no longer has an `mcp_uri`; or a host whose MCP user cannot connect. The tooltip says which case applies. |
| Tools | `n/total`, out of the tools of the server. The cell can also show `All` or `None`. The tooltip lists the tools. |
| Data | The number of databases and tables that the key reaches, for example `3 dbs · 142 tables`. The number is what the MCP user of the key's host may read (`CHECK GRANT`), limited by the patterns of the key. The page first shows the table, and the cell shows an ellipsis. Then one request (`GET /api/mcp/access`) counts every key at once. The request counts any number of keys. The grants of a host are read once. The text is in the warning color when the key reaches nothing (`0 dbs · 0 tables`). This happens when the patterns match nothing that the user reads. The cell shows a dash when the host cannot be counted. This happens when the MCP user cannot connect, or when the request fails. The tooltip says what the number is. It also says how many tables are read in part, and it lists the patterns. **Refresh** counts again. |
| Limits | The rows and the timeout, for example "100 · 5 s". A value that the key sets shows at full strength. A key without its own value shows the global limit in the muted color. A screen reader reads "(default)" after the global limit. |
| Used | The time of the last use of the key, and the tool calls of the key in the last 7 days. An example is `2 h ago · 1.2K`. The page uses the `format.ago` short form and the compact count. The page first shows the table, and the cell shows an ellipsis. Then one request (`GET /api/mcp/usage?window=7d`) reads the use of every key. The cell shows **Never** when the key was never used, and the count covers the whole life of the key. This happens when the key is as young as the count (`usage.since`). It also happens when the key comes from the config file, which has no date of creation. The cell shows a dash when the key is older than the count. The key may have been used before the count started. The text is muted when no call exists in the window. The text is in the warning color when 5% of the calls failed, or when the rate limit refused a request. The tooltip shows the time of the last use, the calls among the requests, the errors and the refusals. A note under the table says what the column counts and since when. When the window starts before the count, the note says "Counted since ...". When several instances share the usage, the note says how many it sums, for example "Summed over 3 instances". A warning follows the note when the page skips a file of another instance (see "Instances"). **Refresh** reads the column again. **The column is not there while the usage is off.** |
| Actions | **Delete**. This is a trash icon with no frame, like the gear icons. It has a label for screen readers and a tooltip. A key that the page cannot delete has nothing in this cell. Such a key comes from the config file, or the page runs in `keys.mode = "static"`. The cell has no icon and no lock. The tooltip of the name says where the key comes from. |

A key has no description, no expiry and no state. Its use shows in the column **Used** and in the usage of its details. A key is **made or deleted**. The page has no edit, no disable and no rotation. To change a key, delete it and make a new one.

When there are 10 keys or more, the head of the part shows a filter. The filter matches the name and the source. The count shows "n of N" while the filter is on. The filter text stays after an action.

The table is a compact data table (`.dataTable--compact`) in a hairline box (`.dataTableWrap`). Below 54 rem, the box scrolls from side to side.

From 820 px, the columns Tools, Data, Limits and Used are removed from the table. The details of a key show them instead. On a phone (600 px and below), each key is a card. The name is the first line, and the secret is the second. The hosts, the tools, the data, the limits and the use follow in two columns.

The **Delete** button ends the card. The button is 40 px high. The label of each cell shows above its value. The table keeps its roles for a screen reader.

### The secret of a key

- The secret shows **once**, in the dialog that opens after the key is made (see "The secret dialog"). The server keeps the SHA-256 hash of the secret and its first 8 characters. No route gives the secret again. The table has no eye button and no copy button.
- The tooltip of the secret cell states this rule: a lost secret cannot be found. Delete the key and make a new one.
- The page does not keep the secret. It does not store the secret in `localStorage`, in `sessionStorage` or in the address.
- ChDash has no login: anyone who can open the page can make and delete keys. See `docs/mcp.md`, "Security limits".

## Make a key

**New key** opens a dialog. The dialog follows the page that makes a fine-grained token on GitHub. It has a name, the access and the permissions. The dialog is dense on purpose.

The dialog has **a fixed size**: 58 rem wide and 46 rem high, or less on a small screen. The size does not change with its content. A family that opens, or an error that appears, does not resize the dialog. Each column scrolls inside the dialog when needed. The permissions column scrolls when families are open.

On a screen under 820 px wide, the dialog has one column, and the dialog body scrolls. The left side has the name, the host, the data and the limits. The right side has the permissions. A field that must be filled has a `*`.

- **Name.** Use 32 characters at most: `a-z`, `0-9`, `-` and `_`. The pattern comes from `/api/mcp/meta` (`name_pattern`).
- **Host.** A key reads one host. The form shows one **radio button** for each host that has an `mcp_uri`. The buttons stand **one under the other**. The form chooses the first host whose MCP user connects.

  A host whose MCP user cannot connect is greyed. The reason shows beside it: "The MCP user chdash_mcp cannot connect". The tooltip has the error of ClickHouse. Under the list, a line names the user of the tools.

The line also says how many tools the user cannot serve. The form has no "All hosts" choice. Make one key for each host.
- **Data.** Enter the patterns, one for each line. A pattern is `db`, `db.table`, or a pattern with `*` as a wildcard. `*` alone means all the data. It is **the default**.

  The grants of the MCP user already limit what a key reads. A pattern narrows the data more. The form has no "All data" choice. The field holds `*` in that case.
- **Permissions.** The form has one **card for each family** of tools. A border and a head separate each card from the others. The families come from `/api/mcp/meta` (`tool_groups`). The page names no family. Therefore, a family that the server adds shows without a change to the page.

  The current families are Data, Explorer, System, Observability, Query, SQL and MCP analysis. A family has at least two tools. Therefore, no card is a lone check box. The analysis family is the exception. Every key has its one tool while the usage is off (see "The analysis tools").

  Observability has **sections**: Traces, Logs and Metrics (`tool_groups[].sections` and `tools[].section` of `/api/mcp/meta`). The sections show as sub-headings of its card. Each sub-heading shows its count. The page tools and the simple tools of a signal are in the same group.

  A card has these parts. It has the check box of the family. It has a text that says what the family is for. It has a count of the tools that are on ("3/7"). It has an arrow.

The check box selects all the tools of the family. It shows a partial tick when only some tools are on. The arrow opens the tools. Each tool has one check box and a text that says what the tool does.

  **Every permission is read-only. Therefore, each permission is a check box.** The form has no level to choose.
- **The analysis tools.** The family **MCP analysis** (`mcp_analysis`) holds the tools. A key uses these tools to read its own limits and usage. The tools also read the usage of all the keys. The catalog of the meta states how each tool is given (`tools[].always`, `explicit_only` and `available`). The page names none of the tools:
  - A tool that **every key has** (`always`: `mcp_analysis_my_limits`, and `mcp_analysis_my_usage` while the usage is on) shows **checked and locked**, with "Every key has it". It is not a choice. The form never sends it. The form sends only the names of the boxes that are on and free.
  - A tool that **"*" does not give** (`explicit_only`: `mcp_analysis_all_usage`) is a special case. It lets a key read the names, hosts, clients and activity of all the keys of all the instances. This tool has its own check box. The check box is off by default.

    The box of the family and any "all" action do not change it. The box says `"*" does not include it`. A key has this tool only when its list names it. The tool is available only while the usage is on and `mcp.usage.all_keys` is true.
  - A tool that is **not available** (`available` is false) is not offered. This happens when the usage is off, or when the option that the tool needs is off. The same rule applies to any tool of any family.

  The family has no box of its own when it has no plain tool to choose. Its head is a title only. Its card is **open**. A family that has a tool to choose, or only tools that every key has, shows them at once. When the usage is off and `all_keys` is off, the family holds one tool: `mcp_analysis_my_limits`. That tool is checked and locked.
- **Locked tools.** Only the SQL tools need `*`. They are off and locked. The head of the family shows "needs data *". They stay locked until the data is `*` alone. If you change the patterns again, the form clears the SQL tools again.

  All other tools need no `*`. The Explorer tools of one table and the catalog are limited by the patterns. The patterns apply on top of the grants of the MCP user. The other Explorer, System, Observability (Traces, Logs and Metrics, with the simple tools too) and Query tools read data as the pages do. They use the system user. The permission alone gives access to them.
- **Tools that the host cannot serve.** Some tools need a grant that their user lacks on the chosen host. Examples are `system.documentation` for the MCP user, and `system.parts` and the `otel` tables for the system user. Every tool of Observability needs these grants. Such tools are off and locked.

  The head of a family shows "no grant" when the family has no other tool. The tooltip of a tool names the missing grant and the statement that gives it. When you choose another host, the form locks and clears the tools again for that host. The server refuses such a tool in any case (`not_grantable`, `docs/mcp.md`).
- **Defaults.** The Data family starts on. The other families start off. A tool that "*" does not give also starts off. The tools that every key has are on and locked.
- **Max rows** and **Timeout.** These fields are optional. An empty field keeps the global limit.

**Create key** stays off until the key is valid. Its title names the first missing item ("Enter a name.", "Choose the host that the key reads.", and so on). You cannot send a key with no name or no host. The form has no summary line and no description.

The server error shows under its field. For example, `error = "validation"` comes with `field` and `reason`. A `409 name_taken` error shows under the name. The dialog stays open. An answer that names no field shows at the foot of the dialog.

## The details of a key

A click on a key opens its details. The click can be on the name of the key, or on its row outside the buttons. The details open **in a row under the key**, in the table. The page has no popup.

Only **one key** is open at a time. Another key closes the first one. A second click on the same key closes it. The name is a button with `aria-expanded` and `aria-controls`. The focus stays on the name.

The open key stays open when the list is shown again, for example after Refresh or an action. When a key is deleted, its details are removed too. The row spans the whole table. It shows:

- the source (this page, or the config file);
- the host. It shows as a chip in the code font, with `as chdash_mcp`, the user that its tools run as. The data shows as chips. `*` means "all the data".

  A key from an older file that names several hosts says so. A host that no longer exists says so. A host whose MCP user cannot connect says so. These messages use the warning color;
- the rows and the timeout, with "(default)" when the key sets none;
- **Permissions**, shown as "n of m". The page shows every family of the server, in **two balanced columns**. The tallest families go first. Each family goes in the shorter column.

  Both columns end at about the same height. Each column keeps the order of the families. No column has an empty row between two families. On a phone, there is one column.

  Each family shows what the key holds in it ("2 of 8"). Under the family, the page lists the tools that the key holds. Each tool has a text that says what it does. A family with no tool is dimmed.

  A key with `tools = ["*"]` holds every tool that it can hold. The tools that need all the data are held only with the data `*` alone. The tools that "*" does not give are not held. For example, `mcp_analysis_all_usage` is held only when the list names it, as in `tools = ["*", "mcp_analysis_all_usage"]`.

  Every key holds the tools that every key has (`mcp_analysis_my_limits` and `mcp_analysis_my_usage`). A note says what such a tool does, and it says "every key has it". The counts ("2 of 26", `5/26` in the table) use the tools that the server offers now. A tool that the key holds, but that the MCP user of its host cannot serve, is struck out.

Its text reads "not served: chdash_mcp lacks otel.otel_logs". The tooltip has the `GRANT` statement. The heading says "3 not served".

Under the permissions, the section **Data it reads** answers one question. The question is: "which databases and tables can this key reach?" For the host of the key, the page shows the MCP ClickHouse user (`as chdash_mcp`). It also shows the number of tables and databases. A line explains why.

The line names the tables that the user reads (`CHECK GRANT`). It also says what the patterns of the key keep or exclude. Each database opens on its tables. A table that the user reads only in part says "some columns". A host that cannot be checked shows the reason.

**Check again** asks the grants again. The answer is kept for `explorer.acl_cache_ttl_ms`, which is 60 s by default. The data comes from `GET /api/mcp/keys/<id>/access` (`docs/mcp.md`). What the key reaches is the grants of the MCP user, limited by the key. The key never reads more than the user.

Below that, the section **Usage** shows what the key did (`docs/mcp.md`, "Usage of a key"). The page reads it when the details open (`GET /api/mcp/keys/<id>/usage`). **The section is not there while the usage is off.** It has these parts:

- a **window**. The window buttons are `1 h`, `6 h`, `24 h`, `7 d`, `30 d`, `90 d` and `365 d`. The server keeps the longer windows only as far as `mcp.usage.retention_days` allows. The first three windows always exist. The window `7 d` is the first choice.

  The page keeps the window that the reader selects for the visit. Therefore, two keys are compared on the same window. The heading shows the dates of the window. When several instances share the usage, the heading also shows **Summed over 3 instances**. This text is a button.

It opens the list of the instances (see "Instances"). The heading also has **Open in Usage**, a link. The link opens the Usage tab. The tab is limited to this key and uses the same window (`/mcp-integration/usage?key=<id>&window=<window>`);
- a warning above the tiles. The warning shows when the file of an instance is skipped and is not in the sum. It also shows when another ChDash writes under the name of this instance (see "Instances");
- six tiles. The tiles show these figures:
  - the tool calls and the requests;
  - the errors and their share. The share is in the warning color, and it is in the danger color from 5%;
  - the refused requests, and how many the rate limit refused;
  - the time of a call (average and longest);
  - the bytes returned, and the rows of the tools that build their SQL;
  - the last use and the first use;
- the calls of each step in the window. The errors show in the danger color (the shared sparkline). The section also shows the busiest step. The server sets the step (`series.step`, in seconds). The step is one minute for `1 h`.

  It is 5 minutes for `6 h` and 15 minutes for `24 h`. It is 3 hours for `7 d`, 12 hours for `30 d`, and one day for `90 d` and `365 d`. The sparkline names the step, for example "Tool calls by 3 hours in the last 7 days". The busiest step shows a time of the day. For a step of one day, it shows a date;
- three compact tables. The **tools** table shows the calls with a bar of their share, the errors, the average time and the bytes returned. The tooltip of a tool shows its longest call. The **results** table shows `ok`, the error codes and the refusals, with their share. The **clients** table shows the name and the version that the client sent in `initialize`. It also shows its User-Agent, its requests, and when the page first and last saw it;
- a line says since when the usage is counted. It shows this line when the window starts before the count ("Counted since ..."). A key with no request in the window also says so.

Then comes **ClickHouse cost**. This section is closed by default. It shows what the statements of the key cost ClickHouse. The page reads the data from `system.query_log` of the host (`GET /api/mcp/keys/<id>/cost`; `docs/mcp.md`, "The ClickHouse cost of a key").

The page reads the data **only when the section opens**, because the read scans the log. The read uses the window of the usage when the cost supports it (`1 h`, `6 h`, `24 h` or `7 d`, set by `usage.cost_windows`). Otherwise, it uses `7 d`. The page keeps the answer for one minute. **Check again** reads the cost again.

The section does not depend on the usage. `GET /api/mcp/keys/<id>/cost` answers while the usage is off. In that case, the section is the only one in the details. No usage section has the window buttons. Therefore, this section has its own buttons (`1 h`, `6 h`, `24 h` and `7 d`). The buttons show while the section is open, and `7 d` is the first choice.

The section has six tiles. They show statements and failed statements, bytes and rows read, CPU, the peak of memory, the time, and the bytes and rows returned. Then it shows the cost **by tool**, and the **tables read** the most. A long table name ends in an ellipsis. Its title has the whole name.

Last, it shows the cost **by user**: the MCP user, the system user, or another user. Another user shows in the warning color. When the runner of the host cannot read `query_log`, the block says so. It shows the `GRANT` to give, in a code block with its copy button. A window that is too large makes the block suggest 24 h.

A line says that only the statements named for the key count. When `system.top_queries` is off, the block cannot open. It says why.

The page keeps each answer of the usage for one minute. The minute applies to one key and one window. When the details open again, the page shows the kept answer at once. Closing the details stops the reads in progress. **Refresh** clears the kept answers.

The details only show information. **Delete** is the button of the row. On a phone, the details form a block under the card of the key.

## Keys that keep usage

Two kinds of key keep their usage. These keys are not in the table of the keys. The line is hidden when no such key exists. **The line is not there while the usage is off.**

- A **deleted key** keeps its usage until the usage is older than `mcp.usage.retention_days`.
- A key that **only another instance knows** has `elsewhere: true` in the answer of `GET /api/mcp/usage`. Another ChDash made this key on its own page. That ChDash shares the usage directory. The usage of the key is in the file of that instance. This instance has no key with that name. A key that the page makes is stored by one process (`docs/mcp.md`).

Under the keys, a line opens a list. The line says **Deleted keys**, with their count. It also says how long their usage stays. Some keys are known only to another instance. For these keys, the line says **Keys of other instances**. When both kinds exist, the line says **Deleted keys and keys of other instances**.

The list has one line for each key. Each line shows the name, the host, the state and the use, as in the column Used. The state is the time of the deletion. The column is called **State** when the list shows a key of another instance.

A deleted key then reads "Deleted Oct 12 08:00". A key of another instance has the badge **other instance**. When the list holds deleted keys only, the column is called **Deleted**.

The page builds the table when the line opens. A key in the list opens its details under its line. The details show its host. They show when the key was deleted, or "Known to: Another instance only".

They also show its **Usage** and its **ClickHouse cost**, as for any key. These details have no permissions, no data and no Delete button. The filter and the count of the keys do not include these keys.

## The Usage tab

**Usage** (`/mcp-integration/usage`, `mcpusage.html`) is the second page of the section. It shows what **all the keys** did over time. The page uses six charts. The charts group the data by key, by method, by client or by result. The page also filters the data by key, by method, by client, by instance, by result and by type.

The usage of one key stays in the details of that key. Those details link to this page with **Open in Usage**. The page is not tied to a host. The server side is `GET /api/mcp/usage/overview` (`docs/mcp.md`).

The tab has no heading row. Its name is the page switcher and the row of the two pages. The period that the tab covers shows at the right end of the chips row.

```
Keys  [Usage]                                                                                    the nav row
[Group by . Method] [Key . All] [Method . All] [Client . All] [Result . All] [Instance . All (3)]  [1 h|6 h|24 h|7 d|30 d|90 d] (refresh)   the filter bar
[Key = ops-all x] [Method = run_query x]  Clear filters                      Oct 7 12:00 -> Oct 14 10:00   the chips (a hint without filter) and the period
[! chdash-2: its file was skipped (invalid), so its counts are not in these figures.]            the warnings (none when all is well)
[Requests] [Tool calls] [Errors] [Refused] [Call time] [Returned] [Active keys]
+--------------------------------+--------------------------------+--------------------------------+
| Requests by method  by 3 hours | Errors by method  by 3 hours   | Error rate by method  by 3 h   |
|   the bars, stacked by method  |   the bars, stacked by method  |   the lines, in %, 0 to 100    |
|   (query_table) (ping) ...     |   (query_table) (ping) ...     |   (query_table) (ping) ...     |
|   [Values]                     |   [Values]                     |   [Values]                     |
+--------------------------------+--------------------------------+--------------------------------+
| Refused by method  by 3 hours  | Call time by method  by 3 h    | Returned by method  by 3 h     |
|   the bars of the refusals     |   the lines of the average     |   the bars, on KB, MB...       |
|   (unread)                     |   (query_table) (ping) ...     |   (query_table) (ping) ...     |
|   [Values]                     |   [Values]                     |   [Values]                     |
+--------------------------------+--------------------------------+--------------------------------+
the notes (none unless the window starts before the count)
```

- **The filter bar.** This bar is the same bar as in Observability and System (`filterBar`, `app_ui_filterbar.js`). It is directly under the row of the two pages. It is outside the panel that scrolls. The panel is the only scroller. From left to right:
  - **Group by** (`Group by · Method`): one choice among **Key**, **Method**, **Client** and **Result** (a `menu.select`, as the Order by of System Queries). It sets what the six charts group by (`group`; the default is Method). It sets an order and not a filter. The phone summary does not count it. The instance and the type are not offered. They stay filters.
  - **Key · All**, **Method · All**, **Client · All**, **Result · All** and **Instance · All** are the five lists. Each one is a list of check boxes, in that order (see "The lists"). The Group by is never the instance. The charts group by key, method, client or result. When the usage sums two instances or more, the last list reads **Instance · All (3)** (see "Instances").
  - At the right end, the **window** (`1 h`, `6 h`, `24 h`, `7 d`, `30 d`, `90 d` and `365 d`, as far as the server keeps them). The **Refresh** icon button is also there. It is the action of the bar and submits its form.
  - A change applies at once. The bar has no Search button. The selections of a list wait until the clicks pause for 200 ms (`util.debounce`, as the Service list of Logs does). When you tick three boxes, the page makes one read and one entry in the history. Boxes that cancel each other make no read and no entry.
  - From 1101 px, the bar is one row. The row holds Group by, the five lists, the window and Refresh. Below 1101 px, the bar has two rows. The first row has the lead. The second row has the window and Refresh. This layout matches the bars of System.
  - From 761 px, the six pickers of the lead (Group by and the five lists) share a row. A long value ends in an ellipsis, and its title shows the full value. Below 761 px, the pickers wrap, two to a row.
  - From 761 px, the pickers do not all have the same room. Group by and the Instance list need more room, because their text is longer when nothing is selected. Their text is `Group by · Method` and `Instance · All (2)`. With their padding, these two pickers are 139 and 129 px wide.

    The other four are 86 to 105 px wide. Therefore, Group by and the Instance list take a basis of 140 px. The other four take a basis of 104 px. The room that is left is shared equally.
  - At 1101 px, no word of the bar is shortened. The pickers are then 148 and 112 px wide. The width of a list does not depend on its text. Therefore, a selection moves nothing.
  - At 600 px and below, the bar is reduced to one line: `Last 7 days · by method · 2 filters`. The code uses `filterBar.mountSummary(form, { describe })`. This bar has no time range. The page therefore shows its window and its group instead. The line counts the chips, not the lists. One filter gives one count.
  - Select the line to show the bar and the chips. Refresh shows the line again.
- **The chips.** The chips form one line under the bar. The line is always there. Therefore, a filter that is added or removed moves nothing under it. This rule was decided on 2026-10-15. Before that date, a row that appeared and disappeared moved the whole panel up and down.

  Without a filter, the line shows a muted hint: "No filters. Pick a value in a list or in a legend." With filters, the line shows one chip for each value. The kinds are key, method, client, instance, result and type. From two chips, the line also shows **Clear filters**. A chip reads, for example, `Key = ci-bot` (the name of the key, not its id), `Client = claude-code`, `Instance = chdash-1` or `Type = Tool calls`.

  The chips form a list (`role="list"`). The button stands beside the list. The row is 35 px high. On a touch screen, it is 45 px high, because the chips need room for their bands. The chips never wrap.

When they do not fit, the list scrolls sideways inside itself. It fades where it hides some chips (`shell.edgeCues`, as the other rows that scroll sideways). **Clear filters** stays in view beside the list. On a phone, the row goes into the summary line with the bar.
- **The period.** The dates that the figures cover are at **the right end of the chips row**. An example is "Oct 9 02:00 → Oct 16 01:15". The page uses `format.range` and the local time of the browser. The text is muted (`--muted`, `--fs-sm`). Its title is "The period that the figures cover".

  The period is the span of the answer on screen. It starts at the start of the window. If the count started later, it starts when the count started. Under the charts, "Counted since ..." then says so. The period ends at the time of the answer. Before the first answer, the period is empty.

  The text stays on one line and does not shrink. The hint and the list of chips are reduced instead. The list scrolls, so **Clear filters** and the period stay in view. On a phone (600 px and below), the hint is only "No filters.".

The period hides the second sentence. On a phone, the period is part of the summary line with the bar and the chips. The summary line shows the window and the group, for example "Last 7 days · by method".

  The tab has no heading row of its own. The page has an `h1` ("MCP usage"), for screen readers only (`srOnly`). The part has an `h2` for screen readers only ("Usage of all keys", `srOnly`). The `h2` names the region. The titles of the six charts are `h3`. Therefore, the heading levels never skip one.
- **The window.** The window buttons come from `/api/mcp/meta` (`usage.windows`). The buttons `1 h`, `6 h` and `24 h` always show. The buttons `7 d`, `30 d`, `90 d` and `365 d` show as far as `mcp.usage.retention_days` keeps them. Each window has steps of its own.

  The steps are aligned to UTC. The server reads each window from its own storage. Therefore, the page never adds steps up:

  | Window | Step | Points |
  | --- | --- | --- |
  | `1 h` | 1 minute | 60 |
  | `6 h` | 5 minutes | 72 |
  | `24 h` | 15 minutes | 96 |
  | `7 d` | 3 hours | 56 |
  | `30 d` | 12 hours | 60 |
  | `90 d`, `365 d` | 1 UTC day | 90, 365 |

  The first load uses `usage.default_window` (`7d`). The period (see "The period") shows the dates of the window. A window that starts before the count began starts at the first start in the file. The steps use UTC. The page shows them in the local time of the browser. A tooltip gives the range of each step.
- **The filters.** A filter is one value of a dimension. The dimensions are a key, a method, a client, an instance, a result and a type. A value of one dimension matches any of its values (OR). Different dimensions combine (AND).

  Four actions add or remove a filter. Use a **check box** in a list of the bar. Use an entry of a **legend**, in its list or in its table. Use the **x** of a chip. Use **Clear filters**. A dimension takes 20 values at most.

  Every figure of the page follows the filters. The server limits the list of each dimension with **every filter but its own**. Therefore, a filtered list still shows what else the reader can select. A value that is selected always stays in the list, at 0 when nothing matches. A facet keeps 200 rows at most.

  The reader selects a key, a method, a client and a result in their list of the bar. The reader can also select them in the legend of the charts, when the charts group by that dimension. The reader selects an instance in its list only, because an instance has no legend. The type comes from a link (`?type=call`). The type has no list and no switch. A chip removes it.
- **A dimension with nothing to choose is not offered.** This rule was decided on 2026-10-15. The answer may list fewer than two values for a dimension. The facets are `keys`, `methods`, `clients`, `instances` and `results`. When this happens, and no filter of that dimension is on, the page does not offer a filter for that dimension.

  The list in the bar stays off and keeps its place. Its button shows the one value, for example `Client · claude-code`. When the facet is empty, the button shows `Client · none`. Its title says "Only one client in this view".

With one instance, the button reads `Instance · chdash-0`, and the title says "Only one instance in this view". When the charts group by that dimension, its legend entries cannot be pressed. Their title says "Only one client in this view".

  When a filter of the dimension is on, the page offers everything again. The reader can then remove the filter. A dimension with two values or more is always offered. A list that is open when its dimension falls to one value stays open until it closes. The Group by is not a filter, and it does not change.

  The type has no list or legend for a selection. Therefore, this rule does not apply to it. The result is a list like the others. It reads `Result · ok`, with the title "Only one result in this view".

Its legend entries cannot be pressed while the answer lists one result. Before the first answer, the page knows nothing. It offers everything.
- **The lists.** A list is a dialog of check boxes (`menu.multi`, based on the Service list of Logs). It has `role="dialog"`, not a listbox, because it holds controls other than options. Its button reads `Key · All`, `Key · ops-all` or `Key · 3 selected`. The title of the button shows the whole list.

  The Instance list shows how many instances exist while none is selected. For example, it reads `Instance · All (3)`. This applies as soon as the usage sums two instances or more (see "Instances"). The list holds these items:
  - an action: **All keys**, **All methods**, **All clients**, **All results** or **All instances**. The action clears its dimension;
  - a field that narrows the list when it has more than 12 values. Down moves to the first value. Enter does not submit the bar;
  - one check box for each value, with its requests. The list shows the facet of the answer, the biggest first. It also shows the values that are selected, even when the answer lacks them. The name of the check box has its count, for example "query_table 754". A deleted key has the badge `deleted`. The methods of the protocol are muted.

    A result is its code, for example `ok`, `query_failed`, `rpc_error_32601` or `429_rate_limited`. A result counts the requests that ended with that code. The successful requests count too (the `count` of the `results` facet). The count is always in the last column. Therefore, the counts align, whether a row has a badge or not.

    An instance is a row of two lines. The first line has its name, its badge and its requests. The badge is `skipped` or `conflict` when the page does not read its file. The title says why. The second line is muted.

It says when the instance wrote last, for example `wrote 1 min ago`. The exact time is in the title. The text reads `no write yet` when the instance has not written. For the instance that this page is, the line reads **`this instance`**, for example `this instance · wrote 1 min ago`.

    The list shows every instance that the server knows (`instances` of the answer). An instance with no request in the view shows zeros. The order follows the other lists, with the most requests first;
  - at 20 values, the check boxes that are not ticked are off. A line says why.

  A list with nothing to choose is `disabled` (see "A dimension with nothing to choose is not offered"). It has no arrow, and its button is dimmed. A picker with one option works the same way (`menu.select`).

  A selection changes the box, the button and the chips at once. The keyboard focus stays where it is. The list stays open for the next selection. Escape or a press outside the list closes it. The focus then returns to the button.
- **The tiles.** The page shows seven tiles.

  **Requests** counts the tool calls, the requests of the protocol and the refused requests. **Tool calls** counts the tool calls. **Errors** counts the tool calls that ended with an error code, and the requests of the protocol that failed. The tile also shows their share of the requests that were read. The line says "2.73% of read requests". The title has the whole sentence.

  **Refused** counts the 429 requests, and the requests that were refused before their message was read. The line shows how many the rate limit refused. **Call time** shows the average and the longest time of a tool call. **Returned** shows the bytes of the answers. It also shows the rows of the tools that build their own SQL. An API tool counts no row.

  **Active keys** shows a line such as "3 of 5 keys · 1 deleted". It counts the keys that exist and have a request in this view. It compares them with the keys that exist. A deleted key keeps its usage. When a deleted key had a request in this view, the tile counts it apart, as "· N deleted".

The line has no such part when no deleted key had a request. A deleted key is in neither figure. "7 of 7 keys" means seven keys that exist. A key that only another instance knows also exists. It is in both figures.

  The server counts `totals.keys`, so the tile reads the same on every instance. The server counts a deleted key with the others (`totals.active_keys`). Therefore, the page counts the rows of the `keys` list of the answer. This list is the facet. It has every filter but the key filter, which the page applies itself.

  A row with requests is a key that exists. When the key filter is empty or has its id, a row with `deleted_at` is a deleted key. When the server limits that list (`omitted.keys` above 0), the rows cannot be counted. The tile then shows `totals.active_keys`, with the deleted keys included. Its line reads "keys with requests". It has no ratio and no "deleted".

  Errors and Refused take the warning color when they are not 0. Errors takes the danger color from 5% of the requests read. The sub line of a tile is one line. A tile keeps the room of its sub line when it has none. Examples are a time with no call, or a count of rows of 0. Therefore, a row of tiles never changes its height with the filters.

  The longest sub lines fit the narrowest tile, which is 9 rem wide. Seven tiles fit on one line at 1100 px. Examples of long sub lines are "12.3% of read requests", "12,345 by the rate limit" and "of 12 keys · 3 deleted". The title of a tile says the rest. A count shows its digits up to a million, for example "1,013".

The server counts whole milliseconds. A time of 0 reads "<1 ms". The tiles and the charts have every filter. Therefore, the bars add up to the tiles.
- **The charts.** The tab has six charts from the shared engine. They are in three columns from 1280 px, in two columns from 761 px, and in one column below that. The filters limit all the charts in the same way. Therefore, they have **the same x axis**, which is the steps of the window. All six charts group by the Group by dimension: key, method, client or result.

  **Each chart shows the 8 groups that rank first for its own metric.** The other groups add up as **N more** (grey). Each chart uses its own metric. The requests use their requests. The errors and the error rate use their errors.

The refused requests use their refusals. The time of a call uses the tool calls. The bytes returned use their bytes.

  Therefore, the groups of two charts are not always the same. For example, a method that is busy and never fails is in Requests and not in Errors. A client that is never refused is not in Refused. A group that has none of the metric of a chart is folded, even when there are fewer than 8 groups. **N more** does not appear when no folded group has data to show in that chart.

  When the group dimension has a filter, the groups are the values that are selected, in their order. They are the same six in every chart. A group keeps its colour in all the charts. The colour comes from a hash of its name, not from its rank. Therefore, a name has the same colour in every chart, window and filter.

  The slots are given to all the groups that the page shows at once. Two groups never share a colour while there are 18 groups or fewer. A group that has the colour of another group takes the next free colour. Each chart names its step under its title ("Requests by method"). The step is "by the minute", "by 5 minutes", "by 15 minutes", "by 3 hours", "by 12 hours" or "by the UTC day".

  | Chart | Mark | What it shows | Its 8 groups (the Group by) | When it has nothing |
  | --- | --- | --- | --- | --- |
  | **Requests** | stacked bars | the requests of each group at each step | the most requests | |
  | **Errors** | stacked bars | the errors: the tool calls that ended with an error code, and the requests of the protocol that failed | the most errors | "No errors in this window" |
  | **Error rate** | lines | the errors over the requests of each group at each step, in percent. The requests are all those of the step, and the refused ones too. A step with no request is a gap, not a zero. The y axis is in % (1, 2, 2.5, 5 x 10^n). It ends on the step above the data and never goes past 100% | the most errors | "No errors in this window" |
  | **Refused** | stacked bars | the requests that were refused: by the rate limit (429) and before their message was read (400, 413, 415) | the most refused requests | "No refused request in this window" |
  | **Call time** | lines | the average time of a tool call. It is the time of the calls divided by their number at each step, in ms (then s). A step with no call is a gap, not a zero | the most tool calls | "No tool calls in this window" |
  | **Returned** | stacked bars | the bytes of the answers | the most bytes returned | "Nothing was returned in this window" |

  **One read.** The tab reads `GET /api/mcp/usage/overview` once for one window and one set of filters. The tiles, the lists of the bar and the six charts all come from this read. The request is `?window=7d&group=method&order=requests&orders=errors&orders=refused&orders=calls&orders=bytes`, followed by the filters.

  A group of the answer has a series of six figures. The figures are the requests, the errors, the refused requests, the tool calls, the time of the tool calls and the bytes. The parameter `order` says which figure selects the biggest groups of `series.groups`. Its values are `requests` (the default), `errors`, `refused`, `calls` or `bytes`.

  The parameter `orders` asks for the same groups, ranked by more figures, in the same read. `series.rankings` has one member for each figure (`errors`, `refused`, `calls` and `bytes`). Each member is a `{ groups, rest }` object. It uses the same steps as the first ranking.

The chart of that metric shows it. Requests shows `series.groups`. Errors and Error rate show the ranking by errors.

  The server counts the cells once. A ranking only sorts them again. A group whose figure for the ranking is 0 is in `rest`. When the Group by dimension is filtered, every ranking shows the values that are selected, in their order.

Therefore, the page sends no `orders`. The answer is then much smaller. The page shows the six charts from `series.groups` and `series.rest`.

  **The legend** is the legend of the Query chart (the shared engine, `docs/ui-foundations.md`). It is a **list** of the groups. Each group has a swatch and a name. A button **Values** turns the list into a **table**.

The table has the columns **Total**, **Min**, **Max**, **Mean** and **Last** for each group. The figures cover the window, or the zoom when there is one. The button **List** returns the table to the list. The list is the default.

  The mode is a preference of the browser (`chdash.chart.legendMode`, the same preference as the Query chart). **The six charts have the same mode.** When Values is selected on one chart, it is selected on all of them. The figures use the steps, and zeros count too. For example, a group that has a request every third step has a Min of 0. The Mean of a count has up to three significant digits ("13.5", "0.0893").

  **Call time** is an average, and an average does not add up. Its table has **no Total**. Its Mean is **weighted by the calls of each step**. Therefore, the Mean is the time of the calls of the group divided by their number.

It is never the mean of the averages. A dash shows for a group with no call. Its Min, Max and Last come from the steps that had a call.

  **Error rate** works the same way. It has **no Total**. Its Mean is **weighted by the requests of each step**. Therefore, the Mean is the errors of the group divided by its requests.

It is never the mean of the rates. A dash shows for a group with no request. Its Min, Max and Last come from the steps that had a request. They are in percent, with three significant digits (`12.3%`, `1.23%`, `<0.1%`).

  A legend is the filter of the dimension of its groups. The Group by sets that dimension: key, method, client or result. The legend works in the list and in the table. It is the same in the six charts.

An entry is pressed when its value is a filter. A click adds or removes the filter. The entries that the filter excludes are dimmed in the six charts while the page reads.

  **N more** is not a filter. The lists of the bar have the keys, methods, clients and results that a chart folds. The title of the chart says what the chart keeps, for example "it keeps the 8 that have the most errors".

  While a filter of the Group by dimension is on, the charts list the selected values only. The server answers only the values that are selected when a dimension is filtered. Remove the filter to see them all. When the dimension has one value and no filter, no entry is a filter. The entries are disabled, with no pointer and no `aria-pressed`.

  The title of an entry says what the method, the client or the result is. This applies when the entry stands for a group of messages. It also applies to a code that the server makes (`unread`, `invalid`, `other`, `unknown`, `ok`, `rpc_error_32601`, `429_rate_limited`...).

  **The six charts are aligned.** The engine option is `alignKey` ("Alignment groups" in `docs/ui-foundations.md`). The y axes of the charts have the same number of intervals. The number is four, from the 156 px of the plot. Each axis ends on a step, from 0 to four steps. Therefore, **the horizontal grid lines are at the same heights**. Only the numbers on them differ.

  The charts share **one left gutter**. The gutter is as wide as the widest y label. Therefore, **the vertical grid lines are at the same x**. The steps are 1, 2, 3, 5, 10, 20, 25, 50... for a count, in whole numbers. For the bytes, the steps are 1, 2, 2.5 and 5 x 10^n, in KB, MB or GB.

For a time under one second, the steps are 1, 2, 2.5 and 5 x 10^n ms. Above one second, the steps are 1, 2, 5, 10, 15 and 30 s. The same steps apply in minutes. For the time of a call, the steps also include 1, 2, 3, 6 and 12 h.

  For the rate of the errors, the steps are 1, 2, 2.5 and 5 x 10^n %. The rate uses the `percent` kind of the engine. A rate does not pass 100%. Therefore, its axis never passes 100% either.

The axis ends on the step above the data, for example 0 to 4% for a rate of 3%. It ends at 100% when that step goes past 100%. For example, a rate of 99% has four intervals of 25%: 0, 25%, 50%, 75% and 100%. The same holds when every error code is shown, because the page is grouped by result.

  The domain ends on a step. Therefore, the highest bar of a chart may stop at half of the plot. The grid lines are worth more than the room.

  **The cards keep one height**, whatever they hold. Therefore, a filter or an answer never moves the content under the cards. This rule was decided on 2026-10-15, on the owner's request. The head is one line. The plot is 200 px high.

  The legend has the room of **three lines**. Under 601 px, it has the room of four lines. Each line is 20 px high, or 32 px on a touch screen. This applies in the list mode. In the Values mode, the legend has the room of **a table of six rows under its head**. On a touch screen, it has four rows.

  The legend **scrolls inside** its room when its content is longer. The entries stay buttons. The keyboard reaches them and scrolls the legend to them. A card with nothing to show says so in a box of the same height.

A legend that has fewer lines leaves its room empty. Only the button **Values** or **List** changes the height of the cards. It changes the six cards together.

  The rest is not folded into "N more" in the legend. Then the page must add the groups itself. A bar whose colour is in no legend cannot be read.

  The tooltip names the step. It gives the range of the step, from its start to its end, or the UTC date of a day. It also names the groups that have a value. For a stack, it gives the total.

The cursor and a zoom go from one chart to the others. A drag makes a zoom. A double click resets the zoom.

  The axis of a chart by the day has date labels, such as "Oct 9", on one line. The engine option `xDateOnly` sets this. The axis never shows hours for a chart by the day. A chart by 3 or 12 hours has ticks of days. The charts by 15 minutes, 5 minutes and one minute keep their hours. The date shows under the first tick and under each midnight.

  When the whole window has no request, **the six cards stay**. The page does not shrink. The Requests card says "No request in the last 7 days". With filters, it says "No request has all these filters" and "Nothing in the last 7 days matches them." It also shows a **Clear filters** button. The five other cards say what they count, as they do for a figure that is 0.
- **The instances.** See "Instances". The Instance list of the bar says how many instances exist and what each one did last. The warnings show above the tiles. No other part of the tab mentions instances.
- **The notes.** The notes show under the charts. They say since when the count runs ("Counted since ..." when the window starts before it). The line is not there when the count covers the whole window. The row is hidden, not empty. Therefore, the page has no blank room under the charts.
- **The address.** The whole state is in the address: `?window=7d&group=client&key=ops-all&key=ci-bot&method=run_query&client=claude-code&instance=chdash-1&result=ok&type=call` (`group` is `key`, `method`, `client` or `result`). The parameters `key`, `method`, `client`, `instance`, `result` and `type` repeat once for each value. A default stays out of the address. The defaults are the default window and the group by method.

  A change of the window, of the group or of a filter adds an entry to the history. Back and Forward move through the filters. A link to the page says what it shows. For example, the details of a key link to `/mcp-integration/usage?key=<id>&window=<window>`.

  When the page loads, it fixes an address that it cannot use. The page uses a replace, not a push, for these fixes. The page fixes these cases:
  - a window that the retention does not keep;
  - a group that the bar does not offer;
  - the old `split` parameter;
  - a value that the server refuses;
  - a client with a space at either end;
  - more than 20 values of one kind.

  An instance is valid when its name has 1 to 64 characters of letters, digits, `.`, `-` and `_`. An address that has nothing to fix stays as it was written.
- **Data reads.** The page reads `GET /api/mcp/usage/overview` (see "The charts") when it opens. It reads again for each change. A newer read cancels the reads in flight. The figures on screen stay dimmed until the answers come. Nothing moves while the reads run, because the chips row, the tiles and the cards have a fixed place and height.

  **Refresh** reads again. The page has no timer. A page at rest does no layout and runs no script. A page restored from the back or forward cache reads again.
- **States.** The page shows a spinner and a sentence while it loads. An error shows its message and **Try again**. The bar, with the window, stays. The reader can then select another window. A window with no request shows 0 in the tiles. The cards of the charts say so (see "The charts").

  With MCP off, the page shows "Turn MCP on", as the Keys page does. It has no bar. With the usage off, the page shows "Usage is off" (see below). A read that answers `404 not_enabled` ends in the same state. This happens when the usage was turned off after the page read the meta.

### Usage is off

While `mcp.usage.enabled` is false (`usage.enabled` in `/api/mcp/meta`), nothing is counted. The three usage routes answer `404 not_enabled`. The page does not ask these routes. The Usage tab shows the shared state (`uiState.empty`) **Usage is off**. Under it, the page says what to do:

- what the tab shows: the requests, errors, time of a call and bytes of every key over time, by key, method, client and instance. It also says what the details of a key show;
- the HCL block that turns the usage on. The block is `mcp { usage { enabled = true  dir = "/var/lib/chdash/mcp-usage" } }`. It is in a code block with its copy button. A note follows the block.

  The directory must exist and be writable. ChDash saves its counts there once a minute, in a file named for the instance. Several ChDash instances can share the directory, and the figures are then their sum. `retention_days` sets how long the counts stay.

The filter bar and the chips are not there. The row of the two pages stays. The keys page has no column **Used**. It has no line of keys that keep usage.

The details of a key have no usage and no **Open in Usage** link. They keep the **ClickHouse cost**, because it reads `system.query_log`, not the usage. The key form does not offer the analysis tools of the usage (see "Make a key").

### Instances

ChDash instances that share the directory of the usage (`mcp.usage.dir`) each write the file of their own. Each instance also reads the files of the others. Therefore, every answer of the usage is the **sum** of all of them (`docs/mcp.md`). Every answer says which instances it sums.

The field is `instances`. This instance comes first. Each entry has the time of the last write of its file and its state. The state is `ok`, `skipped` or `conflict`. The state `skipped` means that the file is not in the sum.

The file may be invalid, of another version or too large. The entry then has a `reason`. The state `conflict` means that another ChDash writes under the name of this instance. Therefore, this instance does not save its counts.

- **The note** (the keys page and the usage of a key). With two instances or more, the heading of the usage of a key says "Summed over 3 instances". The note under the table of the keys says it too. In the heading, the words are a button (`aria-haspopup="dialog"`).

  The button opens a **popover** (`ns.popover.open`). Escape and a press outside close the popover. The focus returns to the button. The popover lists the instances. This instance comes first, and the others follow by name.

Each instance has its name. A badge shows when its file is not read: `skipped`, with the reason in one word, or `conflict`. The popover also shows when the instance wrote last, for example "wrote 30 s ago". The exact time is in the title.

  With one instance, there is nothing to sum. The note is not there. **The Usage tab has no such note** (decided 2026-10-16). The tab says that the usage is a sum in its Instance list (see "The Instance list").
- **The warnings.** A file that is not in the sum is a **visible warning**. The warning uses `uiState.banner` with level `warn`. It is amber, with `role="status"`, in a box. An example is "chdash-2: its file was skipped (invalid), so its counts are not in these figures."

  Several skipped files make one sentence. The sentence names the first three files. For example: "3 instance files were skipped, so their counts are not in these figures: chdash-2 (invalid), chdash-3 (too large), chdash-4 (invalid)". A rolling upgrade of a cluster can skip dozens of files. The lists of the instances have each warning. These lists are the popover of a key and the Instance list of the Usage tab.

  A conflict is its own warning. For example: "Another ChDash writes as chdash-0: this instance does not save its counts. Give each instance its own name (mcp.usage.instance)". The server gives the reason behind a **Why** toggle.

The warnings show above the tiles of the Usage tab. They also show above the figures of the usage of a key, and under the table of the keys. They show even with a single instance, because a conflict concerns this instance.

  The warnings come from the `instances` of the answer. No filter changes this list, except the instance filter. Therefore, the warnings do not move while the filters change.
- **The Instance list.** The list **Instance** of the bar limits the usage to one instance, or to several. The chip `Instance = chdash-1` and the parameter `?instance=chdash-1` do the same. The list follows the rule of the other lists, and the rule "a dimension with nothing to choose is not offered". With one instance, the list is off. It says `Instance · chdash-0`. No other part of the tab mentions instances.

  With **two instances or more**, the list also tells the reader that the usage is a sum. This change was decided on 2026-10-16. It replaces the "3 instances" note of the heading, which the tab no longer has.
  - While no instance is selected, the button reads **`Instance · All (3)`**. The number 3 is the number of instances in the answer (`instances`). No filter changes this number. The title says "The usage is summed over 3 instances. Select some to see only theirs." With a selection, the button reads like the other lists, for example `Instance · chdash-1` or `Instance · 2 selected`. The names appear in its title;
  - each row shows what the popover of the note shows. The row shows the name. For the instance that this page is, the row shows **`this instance`**. This value comes from `usage.instance` of `/api/mcp/meta`.

    The row shows the badge `skipped` or `conflict`, and its title says why. The row shows when the instance wrote last. It also shows its requests in the view. These requests are the count of the row.

    The last write is a muted line under the name, for example `this instance · wrote 1 min ago`. The exact time is in the title. The text reads `no write yet` for a file that has none. The page counts the time from the time of the answer (`format.ago`, as the popover does). The rows follow the order of the other lists, with the most requests first. The order is not "this one first".
- **Keys of other instances.** See "Keys that keep usage".

## The secret dialog

After a key is made, the page shows the secret in a dialog. This is the only time that the page shows it. The dialog says so. The dialog has these parts:

- the token (`mcp_` and 43 base64url characters), with a copy button;
- the tabs of the clients (Claude Code, Desktop, Inspector and JSON), with a copy button for each block. The Claude Code tab has the command `claude mcp add --transport http chdash-<name> <endpoint> --header "Authorization: Bearer <secret>"`.

The page builds all blocks from the real endpoint URL. The page does not store the secret. The secret is not in `localStorage`, in `sessionStorage` or in the address. When the dialog closes, ChDash removes the dialog and its nodes from the page.

The keys table shows only the hint and dots. The hint has 12 characters. A key of an older version shows the shape of a UUID.

## Delete

| Action | Confirmation | Result |
| --- | --- | --- |
| Delete | Yes. The focus starts on Cancel. | The key is removed. Its clients get `401` at once. This action cannot be undone. |

The confirmation names the hosts of the key. After the action, the page loads the keys again. A failure shows in a banner above the table. When the key is gone, or MCP is turned off, the page loads again.

## Keyboard and accessibility

- Every control is a button, a link or a form field. The dialogs trap the focus. They return it when they close.
- Each field has a label. Each group (hosts, permissions) has a legend. An error is a live region. Its field has `aria-invalid`. The arrow of a family is a button with `aria-expanded` and `aria-controls`.
- Each row action button has a label that names the key ("Delete ci-bot"). The Delete button uses the danger color at rest. Therefore, touch users see it too.
- The Usage tab: a chip has a remove button with a label ("Remove filter Key = ci-bot"). When a chip is removed, the keyboard moves to the next chip.
- A legend entry, in the list and in the table, is a button with `aria-pressed`. An entry that is not a filter is disabled, and it has no `aria-pressed`. Examples are "N more", and any entry when the dimension has one value.
- The table of a legend has a label. Each header has a scope, and each row has a header. The button **Values** or **List** has `aria-pressed`.
- The six charts are sections. Their headings are `h3`. They are under the `h2` of the part and the `h1` of the page. These two headings are for screen readers only. Each chart is a group. Its name says what it shows, for example "Requests by method over time".
- A change says what it found, once, in the live region of the page. For example: "1,012 requests in the last 7 days with these filters."
- The lists of the filter bar: the button has `aria-haspopup="dialog"`, `aria-expanded` and `aria-controls`. Down or Up on the button opens the list on its first control. Down and Up move between the controls: first the action, then the check boxes. Space ticks a box. Escape closes the list and returns the focus to the button.
- The name of a check box is its value and its count. For an instance, the name also has its badge and when it wrote last.

  The field that narrows a long list has its own label. A list with nothing to choose is `disabled` (and `aria-disabled`). Its title says why. Group by is a list of one choice (a listbox), with its name. axe finds nothing on the bar, with a list open, in both themes.
- The instances: the note of the usage of a key ("Summed over 3 instances") is a button with `aria-haspopup="dialog"` and `aria-expanded`. Its popover is a dialog with a name (`Instances of the usage`). The popover takes the focus. Escape closes it and returns the focus to the button.
- On the Usage tab, the instances are the rows of the Instance list. The list is a dialog of check boxes, like the other lists. The name of a check box is the instance, its requests and its last write. For example: "chdash-1 2,701 wrote 1 min ago". Its badge (`skipped`, `conflict`) is read with it.
- A warning about an instance is a notice (`role="status"`), not an alert. A notice does not interrupt. The state "Usage is off" has a name (`aria-label`). Its code block has its copy button.
- The key form: a tool that every key has is a check box. It is checked and `disabled`. The text "Every key has it" is part of its label. A tool that "*" does not give is a check box. Its label has `"*" does not include it`. axe finds nothing on the form, the note with its popover open, the warnings or "Usage is off", in both themes.
- The page works at 390 px without a horizontal scroll. Code blocks scroll inside themselves. A legend table that is wider than its box scrolls inside the box.
- The page uses the design tokens only. It follows the dark and light themes.
- The document does not scroll. The panel scrolls and the header stays.

## Files

| File | Role |
| --- | --- |
| `src/static/mcp.html` | The shell of Keys. It has `<body data-page="mcp">`, one `h1` (`srOnly`), the row of the two pages (`#mcpTabs`), and the panel (`#mcpState`, `#mcpLayout` with `#mcpKeys` and `#mcpSide`). |
| `src/static/mcpusage.html` | The shell of Usage. It has the same body and row, and the panel (`#mcpState`, `#mcpOverview`). |
| `src/static/app_page_mcp.js` | The controller of Keys. It loads the state, shows the containers again, and runs create and delete. |
| `src/static/app_page_mcpusage.js` | The controller of Usage. It loads the meta. It shows "Turn MCP on" or hands the panel to the view. |
| `src/static/app_mcp_overview.js` | The Usage tab. It holds the state, the address, the read (one read, with a ranking for each chart), the chips, the tiles and the notes. The period is at the right end of the chips. It puts the bar and the charts together. The tab has no heading row. It has an `h2` for screen readers only. |
| `src/static/app_mcp_bar.js` | The filter bar of the Usage tab (on `filterBar`). It holds Group by (key, method, client or result), the five lists of check boxes (key, method, client, result and instance), the window, and Refresh. The Instance list says how many instances the usage sums (`Instance · All (3)`). Each row shows when the instance wrote last, which instance is this one, and whether its file is read. |
| `src/static/app_mcp_instances.js` | The instances that the usage sums. It holds the note ("Summed over 3 instances", in the usage of a key) with its popover. It also holds the warnings about a file that is not in the sum, or about a name that two ChDash write under. These warnings show on the Usage tab, in the usage of a key, and on the keys page. It also holds the words for when an instance wrote last. The Instance list of the bar uses these words too. |
| `src/static/app_mcp_charts.js` | The six charts of the Usage tab (Requests, Errors, Error rate, Refused, Call time and Returned) on the shared engine. The charts have one x axis. Each chart shows the 8 groups that rank first for its metric (`series.rankings`). A group has one colour in all the charts. The charts form an alignment group. The legend of the engine (the list or the Values table) works as the filter. The cards have one height. Their legends scroll inside. A legend locks when there is nothing to filter. |
| `src/static/app_mcp_view.js` | The keys part (heading and table), the side column, and the states ("Turn MCP on", "Usage is off"). It also holds the tools that a key holds (`heldTools`). |
| `src/static/app_mcp_form.js` | The make-a-key dialog, the details of a key (a node that the table puts in a row), and the secret dialog. |
| `src/static/app_mcp_usage.js` | The usage of a key, and the ClickHouse cost of its statements. These are the two sections at the end of the details. |
| `src/static/app_ui_dialog.js` | `dialog.open`, with `validate`. The submit button stays off while the validation gives a reason. |
| `src/static/app_api.js` | `getMcpMeta`, `getMcpKeys`, `createMcpKey`, `deleteMcpKey`, `getMcpUsageSummary`, `getMcpKeyUsage`, `getMcpUsageOverview`, `getMcpKeyCost`. These functions hold every `/api/mcp/*` shape. The shapes include the `usage` block and the tool flags of the meta. They also include the `instances` of the usage answers, the instance filter and facet, the `order` and `orders` parameters, the `refused` series, and the `rankings` of the overview. |
| `src/static/css/10-components/form.css`, `part.css` | The form kit and the part heading. The page shares them with other pages. |
| `src/static/css/20-features/mcp.css` | The styles of the two MCP pages. The files `style.mcp.css` and `style.mcpusage.css` are generated from it. The nav row is in `shell.css`, which System shares. The filter bar is in `observability.css`. |
| `tests/frontend/specs/mcp-page.spec.js` | The Playwright spec of Keys, with a mocked API. It tests the table and its columns, and the form. The form test includes the card of the MCP analysis. It tests the details of a key: its usage, its ClickHouse cost, and the link that opens it in Usage. It also tests the usage that is off, the keys of other instances, and the note of the instances with its list and its warnings. |
| `tests/frontend/specs/mcp-usage.spec.js` | The Playwright spec of Usage. It tests the page and its row of two links. It tests the filter bar: Group by with its four choices, the lists Key, Method, Client, Result and Instance, the window, and Refresh. It tests the chips row with its period, the seven tiles, and each window with its step. It tests one read of the six charts (`order` and `orders`, and none when the Group by dimension is filtered). It tests the six charts: the groups that rank first for their own metric, "N more", one colour for a group, the alignment of their axes, the percent axis of Error rate. It also tests their cards of one height in both modes of the legend. It tests that the legend scrolls. It tests the legends: the list, the Values table with its Total, Min, Max, Mean and Last. It also tests the weighted mean of Call time and Error rate, the filter, and the keyboard. It tests the address, the lists (their counts, their field, 20 values, and the keyboard), and the lists that are off. It tests the instances: the Instance list with its rows and badges, and the warnings. It tests the state "Usage is off", and that the layout does not move when a filter changes. It tests the phone fold, the widths, and axe in both themes. The mocked API (`tests/frontend/helpers/mcp-fake.js`) computes its answers from a list of cells (with a client, to the minute). It follows the rules of the contract: the windows and their steps, the facets, the series with six figures and their rankings, and the refusals. |
| `tests/frontend/specs/mcp-contract.spec.js` | Compares the answers of the mocked API with those of a real instance. It covers the overview. This includes `order`, the `rankings` of `orders`, the groups by result, and the refusals of `order` and `orders`. It also covers the instances and the catalog of the tools (`always`, `explicit_only`, `available`). It also compares the answers of an instance whose usage is off (404 `not_enabled`). |

## Decisions

- The page has no visible title and no strip. The page switcher names the page, as System does. The endpoint is in the side column, where a client needs it. **New key** is in the heading of the keys, where the keys are.
- A key takes one line, and its name column is narrow. A name has 32 characters at most. Therefore, the room goes to the side column, which holds the commands of the clients.
- The secret shows only its start (`3f2a9c1e-••••…`). This was decided on 2026-10-14. The hint tells the keys apart. The whole mask is in the tooltip. The column Used fits beside the others. No column leaves at some widths.
- The use of a key shows in the table and in its details. This was decided on 2026-10-14. The column says which keys are used, and how much. The details say how.

  The column uses one request for every key, for a fixed window of 7 days. The details select their own window. The last use comes from the usage of the key. The usage is kept in files and survives a restart. A key that the count does not cover since its creation shows a dash, not "Never".
- The usage of all the keys is a page of its own, **Usage**. This was decided on 2026-10-15. On 2026-10-14, the owner had set a global view aside. On the next day, he asked for one. The model was the usage page of Helius. It has tiles, bars over time that one dimension stacks, filters that are chips, and a window.

  It answers "how is MCP used?": by which keys, which methods, with which results, over time. It is a second page of the section. A row of two links leads to it, as System has its sections. The keys page is full, and the charts need the room.
- Every dimension of the Usage tab filters every other dimension. This was decided on 2026-10-15. The questions are crossings, for example "which method fails for this key?" or "which key is refused?". Therefore, the server keeps the cells (type, client, method, result) of each key for each step.

  Every filter combines with the others. A list of the bar has every filter but its own. Therefore, it lists what else can be selected.
- The clients are a dimension of the window, like the others. This was decided on 2026-10-15, the same day as the tab. The first version kept them for life, with the key filter only. The owner asked for them to be grouped and filtered.

  A client is named by what it says: its `clientInfo` name, or else the product of its User-Agent. Therefore, the cells can count by name, and an update of a client does not break a series. Its versions and its last sight still come from the clients that each key keeps for life.
- The tab has charts over time. It has a Group by and a filter bar at the top. This was decided on 2026-10-15, on the owner's request. The tab started with four charts. Two more came on 2026-10-16, as described below.

  The requests alone did not show how the keys fail (errors). They did not show how long the keys wait (call time). They did not show what the keys cost the network (bytes returned). The charts share their axis, their groups and their colours. Therefore, the reader follows one group across them.

  Group by was Key, Method or Client at first. The result and the type are things that happen to a request. They are not who asks, or what is asked. Therefore, they stayed filters. The result became a Group by on 2026-10-16, as described below.

A link sets a type. The bar is the same bar as in Observability and System. It uses the lists of check boxes of the Service list of Logs. Therefore, a filter is made in one place, on any page.
- A filter never moves the page. This was decided on 2026-10-15, on the owner's request. The chips row appeared with the first filter, and it went with the last one. The legends gained and lost lines. Therefore, the tiles, the charts and the tables jumped under the pointer at each click.

  The row is always there, and a hint says so. The row is one line high. The cards have one height. A legend of three lines scrolls past that height.

An empty chart has the height of a chart. A tile keeps the room of its sub line. The cost is some blank room under a short legend, and a hint line when there is no filter. The gain is that the next click is where the last one was.

  The chips never wrap, because a second line of chips is a second height. A sideways row with a fade is how the shell shows a row that does not fit. The tab rows and the trace highlights do the same.
- A dimension with nothing to choose is not offered. This was decided on 2026-10-15, on the owner's request. A list with one value does not reduce the data. A row that selects the only client does not reduce the data either. A legend entry that filters by the only key does not reduce it. Such a click changes the address and reads the usage again, for the same figures.

  The page says what the one value is, for example `Client · claude-code`. It keeps the place of the control. Therefore, the bar does not change its shape. A filter that is on keeps the dimension offered, so that the filter can be taken off.

The facet decides. It has every filter but its own. Therefore, it lists what can be selected.
- Each window has a step of its own, from a minute to a day. This was decided on 2026-10-15. The owner wanted to watch the last hour minute by minute. The owner also wanted to watch the last 90 days by the day.

  The server keeps one tier for each step. The page never adds steps up. Therefore, a figure of the page is a figure of the server.

  The call time is an average, and an average does not add up. The legend gives the time of the calls over their number. A step with no call is a gap.
- The "methods" are the tools and the methods of the MCP protocol. This was decided on 2026-10-15. The vocabulary is fixed. Therefore, a client cannot fill the memory with names.

  A method that is not in the vocabulary counts as `other`. A method that cannot be read counts as `invalid`. A request that was refused before its message was read counts as `unread`.
- The chart colours a group by a hash of its name, not by its rank. A rank changes with every window and every filter. A person who follows "ping" from 7 days to 24 hours loses it. The groups that the page shows never share a colour, up to 18 of them.

  The charts do not show the same groups. Therefore, the slots are given to all of them at once. A group has one colour in the six charts.
- A legend entry, a list of the bar and a chip are three ways to make one filter. The charts are the first thing that the reader sees. Therefore, their legends must filter. The lists of the bar are where a reader selects a value from the top, without a search.

  The groups that the charts fold into "N more" are also found there. The Values table of a legend lists the figures of each group. The chips show what is on, and they remove it.
- Six charts and no tables. This was decided on 2026-10-16, on the owner's request. The four tables (by key, method, result and client) said again what the lists of the bar and the legends said. They also took the room of the page. Their figures are now the Values table of the legend of each chart.

  Only a table let the reader select the result. The result was then selected in the legend of a new chart, **Errors by code**. That chart showed what the errors are (the code), not only how many there are. The chart was replaced on 2026-10-16, as described below. **Refused** is a chart of its own. A refusal (429, 413...) shows a client that is too busy or too large.

It does not show the failure of a tool. The errors do not count it. The server gained the series `refused`, and the parameter `order` (the biggest groups by a metric), for these charts. The cost is that no table shows the figures of the 200 values of a facet. The lists of the bar show the counts instead.
- The result is a Group by and a list of the bar. Each chart ranks by its own metric. This was decided on 2026-10-16, on the owner's request. **Errors by code** needed a second read, because the page grouped by result. It also needed a legend that filtered another dimension than the five others. No other place let the reader select the result.

  The owner chose to make the result a dimension like the key, the method and the client. The result is the fourth entry of the **Group by** (`group=result`). It is also a list of the bar, **Result · All**, between Client and Instance. Every chart follows the Group by. Therefore, the error codes show in Requests, Errors and the others when the page is grouped by result.

  The place of the chart is now **Error rate**. It shows how bad the errors are, where Errors shows how many there are. Its axis is in percent, and the engine gained the `percent` kind for it. Each chart shows the 8 groups that rank first for **its own** metric.

Otherwise, Errors shows the busiest methods, and most of them never fail. The server ranks the groups once for each metric in the read of the page (`orders`, `series.rankings`). The cells are counted once. Therefore, one read was enough.

  The cost is these points. The bar has six pickers. The Group by and the Instance list have more room than the other four, so that no word is shortened at 1101 px. The charts do not show the same groups.

Therefore, the colours are given to all of them at once, and a legend says what its chart keeps. When the page is grouped by result, the rate is 100% for every error code, because all the requests of an error code are errors. The rate is 0% for the other codes.
- The legend is the legend of the Query chart. This was decided on 2026-10-16. The page has one component for every chart. The list costs one or two lines. A table of the figures is there for the reader who wants them. The Total column was added for every chart, the Query chart included.

  The list is the default, because the reader looks at the shapes first. The mode is one preference. Therefore, the six charts that the reader sees side by side use the same mode. A chart of an average has no Total, because a sum of averages has no meaning.

Its Mean is weighted by the calls of each step. Therefore, the figure is the same as the tile's figure. The rate of the errors works the same way. Its Mean is weighted by the requests.

  The figures use the steps with their zeros. Therefore, a minimum of 0 means that the group had quiet steps.
- The charts are aligned. This was decided on 2026-10-16, on the owner's request. Six charts that the reader reads across and down must align. Their grid lines are on the same lines.

  Therefore, a peak is compared with a line, not with a number. The option is the engine's `alignKey`. It is not a layout of this page. Therefore, any page can opt in with one option.

  The cost is these points. A step is a "nice" number, and the domain ends on it. Therefore, the highest bar of a chart may reach only half of the plot. The gutter of every chart is as wide as the widest label.
- The ClickHouse cost of a key is read only when its block opens. The read scans `system.query_log` of the host. The usage, which ChDash counts, is read when the details open.
- A deleted key keeps its usage. Its line opens under the keys. Therefore, a key that leaked and was deleted can still be checked. A deleted key is not a row of the keys table. Its secret, tools, data and limits mean nothing now. The filter and the count stay about the keys that exist.
- A key is made or deleted. It is never changed. An edit form, a switch and a rotation are three more things to build, explain and test. A key costs one click to make again. To change a key, delete it and make a new one.
- A key has no description and no expiry. A description was text that nobody read. An expiry was a state that the page had to explain. Delete a key that you do not use any more.
- A secret shows once. ChDash keeps only its hash. A page that showed every secret again gave all the durable credentials to anyone who reached the page. It also gave them to a site that tricked a browser into calling it. The cost is that a lost secret means a new key. A new key costs one click (`docs/mcp.md`, "Secrets and the key file").
- A key reads one host. A key with several hosts made a client guess which MCP user answers. A tool call then had to name its host. The design uses one key for each host. The name of the key says which host it reads.

  Every tool call uses that host. There is no "All hosts" choice and no "All data" choice. The data is a list of patterns, where `*` means everything. The design says each thing in one way.
- A tool that the MCP user of the host cannot serve cannot be given. A key that held such a tool fails on every call. The person who made the key learns this from a client.
- A permission has two states, so it is a check box. A select with "No access" and "Read-only" needs two clicks, one to open and one to choose. It gives the same information.
- The page does not know the families. With more than 60 tools, a flat list does not fit a dialog. Each new tool also needs a change to the page. A family is a row of the server's table. A tool is a row of the API tool table. The page shows what `/api/mcp/meta` sends.
- The source of a key shows as a lock on the keys that the page cannot delete. A `config` badge on every row repeats the same word.
- A page opened with MCP off shows the HCL block. It does not redirect. This helps an operator who follows a link.
- The client-side server name is `chdash-<key name>`. Therefore, two keys do not collide in a client.
- Delete asks for confirmation. The action is destructive.
- The HCL block of the "MCP disabled" state shows `mcp_uri` without a password. It shows `mcp_password_file` for the password of the MCP user (see `docs/mcp.md`). A URI never holds a password.
- Usage is a state, not an error. This was decided on 2026-10-15, with the switch of `mcp.usage.enabled`. With the usage off, nothing is counted. Therefore, the Usage tab has nothing to show. It says how to turn the usage on.

  The keys page loses what only the usage gave it: the column Used, the keys that keep usage, and the usage of a key. The ClickHouse cost of a key stays. It reads `system.query_log`, not the usage. It also gets the window buttons, which the usage held before. The page does not ask a route that is off, because the route answers 404 `not_enabled`.
- Instances are a filter, not a grouping. This was decided on 2026-10-15, on the owner's request. The usage then became one file for each instance. A reader with several ChDash instances behind a balancer asks "is it one node?" That question is one way to split the figures.

  Therefore, the instance is a list of the bar and a chip. The charts keep to key, method, client and result. The same rule applies as for the others. A list with nothing to choose is off, and it shows the one value.
- A figure that is a sum says so. A file that is not in the sum says why. This was decided on 2026-10-15. The sum of several files is silently wrong when one of them is missing.

  Therefore, two places name the instances that they sum. They are the Instance list of the Usage tab (`Instance · All (3)`) and the heading of the usage of a key ("Summed over 3 instances"). A skipped file or a conflict shows as a warning above the figures, with its reason. The page does not show a number that is a little low.
- The tools of the analysis are taken from the catalog, by their flags and not by their names. This was decided on 2026-10-15. The tools that every key has are checked and locked. Therefore, the form shows what a key holds, and it never sends them. The tool that gives the usage of all the keys is named by hand.

  It is off by default. "*" does not include it. The tool shows the names, hosts and clients of the other keys to the client's model. A tool that the server does not offer now is not shown.
- The Usage tab has no heading row. This was decided on 2026-10-16, on the owner's request. The row said "Usage of all keys". The page already has that name, in the page switcher and the row of the two pages. The row also said the dates of the window and "3 instances". It took a line of room above the figures.

  The dates are the period that the figures cover. They belong with the filters that limit the figures. Therefore, they moved to the right end of the chips row. That row is always there, so the page does not move.

The instances are also a way to filter the figures. The Instance list is where they are selected. It says how many there are (`Instance · All (3)`) and what each one did last. Therefore, the tab needs no note and no popover of its own.

  With one instance, the tab says nothing of instances. The note about the rows (an API tool counts no row) also went. The tile of the bytes explains it in its title. The heading stays for screen readers, as an `h2` with `srOnly`. The titles of the charts are `h3`. A heading level must not be skipped.
