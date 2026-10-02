# UI foundations: formats, palette and colour tokens

Every page displays numbers, sizes, durations, instants and data colours
through three shared pieces:

- `ns.format` (`src/static/app_format.js`) turns values into text.
- `ns.palette` (`src/static/app_palette.js`) picks the colour of a series, a
  service, a percentile, a severity, a ramp step or a catalog object kind.
- The semantic colour tokens of `style.css` give every status, severity,
  accent, kind, percentile and JSON colour a name per theme.

**The rule: use these; no local formatters or hex colours.** A module that
needs a format or a colour these do not offer adds it here, with a unit
check, instead of writing its own. Component CSS and scripts name tokens
(`var(--danger)`), never hex, rgb or hsl literals.

Both modules load first, before `app_dom.js`, in every loader: the file list
and `CORE_MODULES` of `app.js` (Query, Explorer) and `COMMON_MODULES` of
`app_observability.js` (Traces, Logs, Metrics). Both are pure apart from
`palette.resolve` (which reads computed styles) and the service store (which
uses `sessionStorage`).

## Decisions they encode

These come from the normalisation decisions of 2026-10-02:

- **One date-time format, 24 h**: `Sep 12 16:29:57`, `.SSS` added where
  milliseconds matter, the year added only when it is not the current year
  (`Sep 12, 2025 16:29:57`).
- **One time zone, the browser's.** Every displayed instant is browser-local
  time. The tooltip (`format.timeTitle`) gives the ISO 8601 value, local time
  with its zone and offset, UTC and, when known, the server's zone.
- **ISO 8601 in exports and copies** (`format.iso`).
- **Query result values stay raw.** The result table, its copies and its
  exports print values as ClickHouse sent them, with no grouping. `ns.format`
  is for the UI around the data: counts, sizes, durations, labels and tooltips.
  Grouped counts in that chrome are fine.
- **en-US numbers on every browser**: `120,064`, never the browser locale's
  `120 064`.
- **One missing-value mark**: `format.EMPTY`, an em dash. NULL inside a value
  is `format.nullToken()`.

## `ns.format`

Each function returns `format.EMPTY` for `null`, `undefined`, `""`, `NaN` and
other non-numbers. A `null` duration is never read as 0.

| Function | Input | Output |
| --- | --- | --- |
| `format.duration(ns)` | nanoseconds | `12 ns`, `350 µs`, `1.82 ms`, `2.5 s`, `8 min 30 s`, `2 h 5 min`, `3 d 4 h`. Up to three significant digits below a minute, then two whole units, never `8.5 min`. A value that would round to `1000 ms` reads `1 s`. |
| `format.duration.fromMs(ms)` | milliseconds | `format.duration(ms * 1e6)` |
| `format.duration.fromSeconds(s)` | seconds | `format.duration(s * 1e9)` |
| `format.duration.fromUs(us)` | microseconds | `format.duration(us * 1e3)` |
| `format.count(n)` | integer | `120,064`. Rounds to an integer. Integer strings of 16 digits or more, and BigInts, keep every digit (UInt64). |
| `format.countLabel(n, singular, plural)` | integer | `1 row`, `120,064 rows`: `format.count` and the word that agrees with it (`plural` defaults to `singular + "s"`). |
| `format.compact(n)` | number | `120.1K`, `3.4M`, `1.2B`, `1.5T`. Uppercase suffix, one decimal with `.0` dropped. A value that rounds to 1000 of a unit moves up (`999,960` gives `1M`). Below 1000: whole numbers, and a fraction under 100 keeps one decimal (`42.4`). |
| `format.number(n)` | measured value | `1,235`, `3.142`, `0.5`, `25K`, `4.2e-5`: four significant digits, en-US grouping, `format.compact` from 10,000, an exponent below 0.0001. For gauges, ratios and metric values, where `compact` would drop the fraction. |
| `format.bytes(n)` | bytes | `0 B`, `205 B`, `1.7 KB`, `10.3 MB`. 1024 base, one decimal from KB up. `util.formatBytes` delegates here. |
| `format.bytesRate(n)` | bytes per second | `1.7 KB/s` |
| `format.percent(ratio)` | ratio, 1 = 100 % | `50%`, `12.3%`, `1.23%`, `100%`: up to three significant digits. `<0.1%` for a value too small to show, and `0%` only for exactly 0. |
| `format.rate(n, unit)` | per-second rate | `1.2K rows/s` from 1000 up, otherwise three significant digits (`3.46 spans/s`), and `<0.01` for a tiny rate. A unit that already names its period (`"rows/min"`) is kept as written. |
| `format.time(ms, options)` | epoch milliseconds | `Sep 12 16:29:57`, browser-local, 24 h. `precision`: `"s"` (default), `"ms"` (`.123`) or `"ns"` (`.123456789`, taken from `options.ns`, an epoch-nanosecond string or BigInt, when given). `date`: `"auto"` (the default: the year only when it is not the current year), `"always"` (with the year) or `"never"` (time of day only). `now` overrides the clock for tests. |
| `format.timeTitle(ms, {serverTz})` | epoch milliseconds | The tooltip text of a displayed instant, one line each: ISO 8601 (UTC), local time with zone and offset, UTC and, when `serverTz` names a known IANA zone, the server's time. Milliseconds by default (`precision`). |
| `format.iso(ms)` | epoch milliseconds | `2026-09-12T14:29:57.123Z`, for exports and copies. |
| `format.parseTime(text, {zone})` | ClickHouse DateTime text | Epoch ms of `2026-09-12 16:29:57[.123456]`. A zone-less value is wall-clock time in `zone`: an IANA name, `"UTC"` (the default) or `"local"`; a value with `Z` or an offset is absolute. `NaN` for other text, an unknown zone and the epoch-0 time ClickHouse prints for an unset value. |
| `format.serverTime(text, {serverTz, precision})` | DateTime text of a server's system tables | `{ ms, text, title, iso }`: `format.time` in the browser zone, the `format.timeTitle` tooltip with the server line, and `format.iso` for copies. An unset (epoch 0) time is `EMPTY`; text that does not parse, or an unknown `serverTz`, is shown as sent. `ui.serverTime(text)` passes the selected host's zone (`clickhouse_timezone` in `api/hosts`, from `timezone()`). |
| `format.range(from, to)` | epoch ms, or raw relative sides | The label of a time-range button. Absolute: `2026-09-12 16:00 → 17:00`, the date repeated only when it changes, seconds only for a range under 10 minutes. Relative `now-N<unit>` to `now`: `Last 1 hour`, `Last 7 days`. Other relative ranges use the picker's names (`ns.timeRange.describeRange`) when it is loaded. |
| `format.ago(ms)` | epoch milliseconds | `5 minutes ago`, `1 hour ago`: the largest whole unit, never negative. |
| `format.EMPTY` | | `—` (U+2014), for every absent value. |
| `format.emptyIfNull(value, formatter)` | anything | `EMPTY` for null, undefined, `""` and NaN, otherwise `formatter(value)` or the value as text. |
| `format.nullToken()` | | `<span class="nullToken">NULL</span>`, the SQL NULL inside a value cell. It is italic, in `--json-null`. |

Output characters above Latin-1 (`—`, `→`) and the micro sign `µ` (U+00B5,
not the Greek mu) come from `\u` escapes in the source. Static sources stay
Latin-1 (CONTRIBUTING.md).

`app_util.js` keeps its helpers. `util.formatInt` and `util.formatBytes`
still return `-` for a missing value and hand everything else to
`format.count` and `format.bytes`, so their output is unchanged.
`util.formatSeconds` (`1.234s`) is a different format and stays as it is,
until its callers move to `format.duration.fromSeconds`.

## `ns.palette`

Every picker returns a `var()` reference, so DOM colours follow the theme by
themselves. Canvas code passes the reference to `palette.resolve`.

| Function | Returns |
| --- | --- |
| `palette.categorical(i)` | `var(--qchart-1)` … `var(--qchart-8)` for series slot `i` (0-based, wrapping), and `var(--qchart-other)` for a negative index (the neutral "Other" group). |
| `palette.service(name, {assign})` | `var(--trace-span-color-N)`, one of 18 slots: the Traces and Jaeger assignment. A service takes the next slot the first time it is seen and keeps it for the browser session, in the same `sessionStorage` key Traces uses (`chdash.traces.serviceColors`). With `assign: false`, a name not seen yet gets a stable hash slot (FNV-1a), and the view's first-seen order is not changed. Logs and Metrics use it whenever the group key is a service. |
| `palette.serviceSlot(name, {assign})` | The 0-based slot behind `service`. |
| `palette.registerServices(names)` | Assigns a view's services in name order before the view renders, so a list and its charts agree whatever order they draw in. |
| `palette.SERVICE_SLOTS` | `18` |
| `palette.quantile(p)` | `var(--pct-p50)`, `p90`, `p95` or `p99`, for `"p95"`, `"P95"`, `95` or `0.95`. Any other quantile takes the nearest of the four. |
| `palette.severity(level)` | `var(--sev-…)` for an OpenTelemetry SeverityNumber (1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal) or a SeverityText (`ERROR`, `warning`, `Critical`…). Unknown text reads as debug. |
| `palette.severityLevel(level)` | The level name behind `severity`: `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |
| `palette.sequential(t)` | `var(--trace-heat-1)` … `var(--trace-heat-8)` for `t` in [0, 1], clamped. Low values recede into the surface. |
| `palette.kind(kind)` | `var(--kind-…)` for a catalog object kind or engine name: `view`, `MaterializedView`/`mv`, `Dictionary`/`dict`, `Buffer`, `Distributed`. Every other engine is a table. |
| `palette.resolve(token)` | The colour a token computes to in the current theme, as `rgb(r, g, b)` or `rgba(r, g, b, a)`, for canvas. It accepts `"--sev-error"`, `"var(--sev-error)"` or any CSS colour. The value is read once per theme and cached. The cache is dropped when the forced theme (`html[data-theme]`) or, in System mode, the OS colour scheme changes. |

## Semantic colour tokens

They are defined in the semantic block at the top of `style.css`, in each
theme context: `:root` (dark), `@media (prefers-color-scheme: light) :root`
(System on a light OS), `html[data-theme="dark"]` and
`html[data-theme="light"]`. A forced theme is always identical to the
matching OS theme (`tests/harness/test_css_tokens_contract.py`).

The contrast column gives the lowest ratio on `--panel` and `--bg`. For
status text it also covers the token's own `-bg` tint over those surfaces.
Text tokens need 4.5:1 and fills (marks, icons, swatches, lines) need 3:1.

| Token | Dark | Light | Contrast dark / light | Role |
| --- | --- | --- | --- | --- |
| `--danger` | `#f87171` | `#b91c1c` | 6.55 / 6.09 (on tint 5.89 / 5.22) | error text and icons |
| `--danger-bg` | `rgba(239, 68, 68, 0.12)` | same | surface | error banner, cell |
| `--warning` | `#fbbf24` | `#9a5b00` | 10.85 / 5.10 (on tint 8.96 / 4.68) | warning text and icons |
| `--warning-bg` | `rgba(245, 158, 11, 0.12)` | same | surface | |
| `--success` | `#34d399` | `#137333` | 9.42 / 5.60 (on tint 7.78 / 5.08) | ok / healthy |
| `--success-bg` | `rgba(34, 197, 94, 0.12)` | same | surface | |
| `--info` | `#60a5fa` | `#1d4ed8` | 7.12 / 6.30 (on tint 6.18 / 5.52) | neutral notices |
| `--info-bg` | `rgba(59, 130, 246, 0.12)` | same | surface | |
| `--sev-fatal` | `#ff5f8a` | `#b4235a` | 6.26 / 5.93 | log/span severity |
| `--sev-error` | `#f87171` | `#dc2626` | 6.55 / 4.54 | |
| `--sev-warn` | `#fbbf24` | `#b45309` | 10.85 / 4.72 | |
| `--sev-info` | `#60a5fa` | `#2563eb` | 7.12 / 4.86 | blue |
| `--sev-debug` | `#8b95a5` | `#556378` | 5.99 / 5.74 | grey |
| `--sev-trace` | `#7d8590` | `#66727f` | 4.86 / 4.62 | dimmer grey |
| `--accent-fill` | `#2563eb` | `#2563eb` | 3.50 / 4.86 (white text on it 5.17) | solid accent: primary buttons, selected marks |
| `--accent-tint` | `rgba(37, 99, 235, 0.14)` | same | surface | selected / active backgrounds |
| `--accent-text` | `#93b4ff` | `#1d4ed8` | 8.81 / 6.30 (on tint 7.78 / 5.21) | links, active facets |
| `--kind-table` | `#5f8ced` | `#1f52c9` | 5.57 / 6.35 | object kind icons and marks |
| `--kind-view` | `#44b7eb` | `#0e87cd` | 7.95 / 3.68 | |
| `--kind-mv` | `#9f7cf5` | `#7051db` | 5.76 / 5.08 | |
| `--kind-dict` | `#dc913a` | `#ad6720` | 7.03 / 4.17 | |
| `--kind-buffer` | `#49c5b9` | `#13959b` | 8.60 / 3.41 | |
| `--kind-distributed` | `#5dd18b` | `#1d9766` | 9.45 / 3.48 | |
| `--pct-p50` | `#54a24b` | `#3f8a37` | 5.73 / 4.03 | latency percentiles |
| `--pct-p90` | `#4c78a8` | `#4c78a8` | 3.93 / 4.33 | |
| `--pct-p95` | `#f58518` | `#c8650a` | 7.12 / 3.71 | |
| `--pct-p99` | `#b279a2` | `#b279a2` | 5.30 / 3.21 | |
| `--json-string` | `#bbe4d2` | `#144e74` | 13.06 / 8.33 | JSON values |
| `--json-number` | `#e9dcc0` | `#424562` | 13.34 / 8.74 | |
| `--json-bool` | `#d8d7f5` | `#314196` | 12.90 / 8.49 | |
| `--json-null` | `#b1bac6` | `rgba(7, 42, 131, 0.733)` | 9.24 / 5.65 | JSON null, `format.nullToken()` |

Kind tokens are graphics (icons, swatches, card accents), so 3:1 applies.
Text in a kind colour mixes it with `--text`.

Where they come from:

- **Status and severity** reuse the former Logs `--log-sev-*`, `--exd-*` and `--graph-error`.
  The light values are darker where those failed 4.5:1, either on the
  surface or on their own tint: `--sev-warn`, `--sev-debug` and `--sev-trace`
  in light, `--sev-trace` in dark, and `--danger`, `--warning`, `--success`
  and `--info` in light.
- **Accent** splits today's `--accent`, which is solid `#1d4ed8` in dark and
  a 14 % tint in light. `--accent-tint` is the tint that both themes already
  draw with `color-mix(--accentBorder 14%)`. `--accent-fill` is `#2563eb`
  (`--accentBorder`), because `#1d4ed8` is only 2.70:1 on the dark panel.
- **Kinds** are the Explorer lineage icon colours: a base hue mixed into
  `--text`, resolved per theme. The Explorer tree swaps dictionary (teal) and
  buffer (amber). The tokens settle on dictionary amber and buffer teal.
- **Percentiles** are the Vega hues Traces draws today (`QUANTILE_COLORS`).
  p50 and p95 are darkened in light, where they were under 3:1 on white.
- **JSON** values are the `.jsonPretty` colours (`util.highlightJsonHtml`).
  Like the `--sql*` tokens, each is a hue mixed into `--text`. The trace
  attribute table (`--traceKv*`) mixes the same hues at slightly different
  ratios.

Aliases: `--error-bg`, `--accentText`, the light `--accent` and
`--graph-error` are now `var()` references to the token with the same value
in both themes. Families whose values differ (`--exd-*`, the dark `--accent`)
keep their values until their callers move to the semantic tokens.

## Observability

Traces (`app_traces.js`, `app_trace_*.js`), Logs (`app_logs.js`), Metrics
(`app_metrics.js`) and the page controller (`app_observability.js`) use the
foundations only. `tests/harness/test_observability_foundations_contract.py`
fails on a local formatter (`toLocaleString()`, an `Intl` formatter, a
`toFixed()` that is not a CSS length or an SVG coordinate, `pad2`,
`"\u2014"`), a hex, `rgb()` or `hsl()` colour, a palette copy in those
modules, and on a raw colour in a style rule that only Observability can
match. Its allow-lists name the two justified `toFixed()` texts: waterfall
ticks of a deep zoom and metric axis ticks, which share one decimal count.

- **Times**: lists and headers print `fmt.time` (`.SSS` for spans and logs),
  the log detail every nanosecond (`fmt.time(ms, { precision: "ns", ns })`),
  and every shown instant carries `fmt.timeTitle` as its `title`. A chart
  bucket reads `fmt.range(start, end)`; a relative start reads `fmt.ago`.
  Range picker values and URLs keep `ns.timeRange.formatDateTime`.
- **Counts and units**: `fmt.count`, `fmt.compact`, `fmt.duration` (and
  `.fromMs` / `.fromSeconds`), `fmt.percent` and `fmt.bytes`; Metrics values
  without a unit read `fmt.number`.
- **Colours**: a service is `palette.service` everywhere (a Metrics series
  grouped by `service.name` too), latency percentiles `palette.quantile`, the
  heatmap `palette.sequential`, canvases `palette.resolve`. Logs and trace
  logs colour by `[data-sev]`, which sets `--sev-color` from the `--sev-*`
  tokens (`unset` reads as trace). Status is `--danger` / `--warning` /
  `--success`; a solid status badge prints its glyph in `--panel`. The
  `--obs-*` tokens hold what no semantic token names: text on an accent fill
  (`--obs-on-fill`) and the menu, popover, drawer and sheet shadows.
- **Gone**: `--log-sev-*`, `--trace-log-*`, `--trace-error`,
  `--trace-warning`, `--traceError`, `--traceWarn` and `--traceKv*` (attribute
  values are `--json-*`; a NULL attribute is `format.nullToken()`).

## Migrating a module

When you move a module onto the foundations:

1. Replace each local formatter (`fmtInt`, `compact`, `formatDuration`,
   `pad2`, `toLocaleString()`…) with the `ns.format` function. The outputs
   that change are listed below. Update the specs that pin the old strings in
   the same change.
2. Replace hex palettes and `getComputedStyle(...).getPropertyValue("--x")`
   colour reads with `ns.palette` and `palette.resolve`.
3. Replace status and kind colours in its CSS with the semantic tokens. Then
   drop the module's own family once nothing reads it.

Visible changes to expect, all intended:

- Compact counts use an uppercase `K`, so `1.2k` becomes `1.2K`.
- Logs times show the year when it differs, and `Sep 02` becomes `Sep 2`.
- Durations keep the Traces rules everywhere, so `8.5 min` becomes
  `8 min 30 s` and `1.23ms` becomes `1.23 ms`.
- Percentages floor at `<0.1%` (Traces showed `<0.01%`).
- Logs severities 21-24 turn fatal pink, and severities 1-4 turn the trace
  grey.
- The light status and severity colours listed above get darker, and the
  dark `--accent` fill becomes `#2563eb`.
- Observability times are 24 h everywhere (`Sep 12 16:29:57`, never
  `04:29:57 PM` or `9/12/2026, 1:30:00 PM`), and grouped counts read `1,234`
  on every browser locale.
- Solid error badges are `--danger` with a `--panel` glyph: light red with a
  dark glyph in dark mode.

## Page shell

Query, Explorer and Observability share one full-bleed page chrome, written
once in the "Page shell" block of `style.css`:

- The header, then the page's nav row (`#obsNav`, `#explorerTopBar`; the
  Catalog mode bar `#explorerModeBar` is one too), then the page's regions
  edge to edge on the flat `--bg`. There is no page card, rounded inset or
  outer shadow.
- `--gutter` (12 px, 10 px at 820 px and below) insets every region's
  content and the header. `--nav-row-h` (46 px) is the height of a nav row.
  `--shell-border` (1 px `--border`) separates regions and rows.
- The `--z-*` scale names the stacking levels: `--z-nav`, `--z-drawer`,
  `--z-header`, `--z-dropdown`, `--z-modal` and `--z-tooltip`.
- `--bp-sm` (600 px), `--bp-md` (820 px) and `--bp-lg` (1100 px) are the
  shell breakpoints. Media queries cannot read custom properties, so they
  repeat the numbers. Scripts use `ns.shell.BREAKPOINTS`,
  `ns.shell.isAtMost("md")` and `ns.shell.mediaQuery("md")` from
  `app_dom.js`.
- Scroll model: html and body never scroll. Each page's content region is
  its only scroller: `#queryWorkspace`, the Explorer detail, graph and
  storage panes, and each Observability view's own pane. Side panels and
  detail panels scroll on their own.
- Anything placed under the chrome uses `--shell-top`. `app_dom.js` sets it
  on every page to the bottom of the header and the nav row. Do not use a
  literal header height.
