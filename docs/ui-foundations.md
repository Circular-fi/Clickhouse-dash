# UI foundations: formats, palette and color tokens

Every page shows numbers, sizes, durations, instants and data colors through three shared pieces:

- `format` (`src/static/app_format.js`) turns values into text.
- `palette` (`src/static/app_palette.js`) picks the color of a series, a service, a percentile, a severity, a ramp step or a catalog object kind.
- The semantic color tokens of `src/static/css/00-tokens.css` give a name for each theme to every status, severity, accent, kind, percentile and JSON color.

**The rule: use these; no local formatters or hex colors.** A module can need a format or a color that these pieces do not offer. In this case, add it here, with a unit check. Do not write your own. Component CSS and scripts name tokens (`var(--danger)`). They never use hex, rgb or hsl literals.

Both modules are imported first, before `app_dom.js`, by `app_common.js`, the module that every page entry imports (see "Page infrastructure", Modules). Both modules are pure, with two exceptions: `palette.resolve` (which reads computed styles) and the service store (which uses `sessionStorage`).

## Decisions they encode

These come from the normalization decisions of 2026-10-02:

- **One date-time format, 24 h**: `Sep 12 16:29:57`. `.SSS` is added where milliseconds matter. The year is added only when it is not the current year (`Sep 12, 2025 16:29:57`).
- **One time zone, the browser's.** Every instant that the UI shows is browser-local time. The tooltip (`format.timeTitle`) gives these values: the ISO 8601 value, the local time with its zone and offset, and UTC. When the zone is known, it also gives the zone of the server.
- **ISO 8601 in exports and copies** (`format.iso`).
- **Query result values stay raw.** The result table, its copies and its exports print the values as ClickHouse sent them, with no grouping. `format` is for the UI around the data: counts, sizes, durations, labels and tooltips. Grouped counts in that UI are correct.
- **en-US numbers on every browser**: `120,064`, never `120 064` of the browser locale.
- **One missing-value mark**: `format.EMPTY`, an em dash. NULL inside a value is `format.nullToken()`.

## `format`

Each function returns `format.EMPTY` for `null`, `undefined`, `""`, `NaN` and other non-numbers. The functions never read a `null` duration as 0.

| Function | Input | Output |
| --- | --- | --- |
| `format.duration(ns)` | nanoseconds | `12 ns`, `350 µs`, `1.82 ms`, `2.5 s`, `8 min 30 s`, `2 h 5 min`, `3 d 4 h`. Up to three significant digits below a minute, then two whole units, never `8.5 min`. A value that rounds to `1000 ms` reads `1 s`. |
| `format.duration.fromMs(ms)` | milliseconds | `format.duration(ms * 1e6)` |
| `format.duration.fromSeconds(s)` | seconds | `format.duration(s * 1e9)` |
| `format.duration.fromUs(us)` | microseconds | `format.duration(us * 1e3)` |
| `format.count(n)` | integer | `120,064`. Rounds to an integer. Integer strings of 16 digits or more, and BigInts, keep every digit (UInt64). |
| `format.countLabel(n, singular, plural)` | integer | `1 row`, `120,064 rows`: `format.count` and the word that agrees with it (`plural` defaults to `singular + "s"`). |
| `format.compact(n)` | number | `120.1K`, `3.4M`, `1.2B`, `1.5T`. Uppercase suffix, one decimal with `.0` dropped. A value that rounds to 1000 of a unit moves up (`999,960` gives `1M`). Below 1000: whole numbers, and a fraction under 100 keeps one decimal (`42.4`). |
| `format.number(n)` | measured value | `1,235`, `3.142`, `0.5`, `25K`, `4.2e-5`: four significant digits, en-US grouping, `format.compact` from 10,000, an exponent below 0.0001. Use it for gauges, ratios and metric values, where `compact` would drop the fraction. |
| `format.bytes(n)` | bytes | `0 B`, `205 B`, `1.7 KB`, `10.3 MB`. 1024 base, one decimal from KB up. `util.formatBytes` delegates here. |
| `format.bytesRate(n)` | bytes per second | `1.7 KB/s` |
| `format.percent(ratio)` | ratio, 1 = 100 % | `50%`, `12.3%`, `1.23%`, `100%`: up to three significant digits. `<0.1%` for a value too small to show, and `0%` only for exactly 0. |
| `format.rate(n, unit)` | per-second rate | `1.2K rows/s` from 1000 up. Otherwise three significant digits (`3.46 spans/s`), and `<0.01` for a tiny rate. A unit that already names its period (`"rows/min"`) is kept as written. |
| `format.time(ms, options)` | epoch milliseconds | `Sep 12 16:29:57`, browser-local, 24 h. `precision`: `"s"` (default), `"min"` (`16:29`), `"ms"` (`.123`), `"us"` (`.123456`) or `"ns"` (`.123456789`, taken from `options.ns`, an epoch-nanosecond string or BigInt, when given). `date`: `"auto"` (the default: the year only when it is not the current year), `"always"` (with the year) or `"never"` (time of day only). `now` overrides the clock for tests. |
| `format.timeTitle(ms, {serverTz})` | epoch milliseconds | The tooltip text of a displayed instant, one line each: ISO 8601 (UTC), local time with zone and offset, UTC and, when `serverTz` names a known IANA zone, the server's time. Milliseconds by default (`precision`). |
| `format.iso(ms)` | epoch milliseconds | `2026-09-12T14:29:57.123Z`, for exports and copies. |
| `format.parseTime(text, {zone})` | ClickHouse DateTime text | Epoch ms of `2026-09-12 16:29:57[.123456]`. A zone-less value is wall-clock time in `zone`: an IANA name, `"UTC"` (the default) or `"local"`. A value with `Z` or an offset is absolute. `NaN` for other text, an unknown zone and the epoch-0 time that ClickHouse prints for an unset value. |
| `format.serverTime(text, {serverTz, precision})` | DateTime text of a server's system tables | `{ ms, text, title, iso }`: `format.time` in the browser zone, the `format.timeTitle` tooltip with the server line, and `format.iso` for copies. An unset (epoch 0) time is `EMPTY`. Text that does not parse, or an unknown `serverTz`, is shown as sent. `ui.serverTime(text)` passes the zone of the selected host (`clickhouse_timezone` in `api/hosts`, from `timezone()`). |
| `format.range(from, to, {precision})` | epoch ms, or raw relative sides | The label of a time range: every range button (Observability, System), the range of the Query chart, a chart bucket. Absolute: `Sep 12 16:00 → 17:00`, read as `format.time` (browser-local, 24 h, the year only when it is not the current year). The date is repeated only when it changes (`Sep 11 23:00 → Sep 12 01:00`). `precision`: `"auto"` (default: minutes, seconds for a range under 10 minutes), `"s"`, `"ms"`, `"us"`, `"ns"` or `"day"` (`Sep 12 → Sep 14`). Relative `now-N<unit>` to `now`: `Last 1 hour`, `Last 7 days`. Other relative ranges use the names of the picker (`timeRange.describeRange`, which the picker gives to `format.setRangeNamer(fn)` when it loads). ISO text is for the range inputs, the tooltips and the copies only. |
| `format.ago(ms)` | epoch milliseconds | `5 minutes ago`, `1 hour ago`: the largest whole unit, never negative. With `{ short: true }`, the units of `format.duration` for a narrow cell: `45 s ago`, `12 min ago`, `2 h ago`, `6 d ago`, then `1 y ago`. |
| `format.EMPTY` | | `—` (U+2014), for every absent value. |
| `format.emptyIfNull(value, formatter)` | anything | `EMPTY` for null, undefined, `""` and NaN. Otherwise `formatter(value)` or the value as text. |
| `format.nullToken()` | | `<span class="nullToken">NULL</span>`, the SQL NULL inside a value cell. It is italic, in `--json-null`. |

Output characters above Latin-1 (`—`, `→`) and the micro sign `µ` (U+00B5, not the Greek mu) come from `\u` escapes in the source. Static sources stay Latin-1 (CONTRIBUTING.md).

`app_util.js` keeps its helpers. `util.formatInt` and `util.formatBytes` still return `-` for a missing value. They hand everything else to `format.count` and `format.bytes`, so their output is unchanged. `util.formatSeconds` (`1.234s`) is a different format and stays as it is. It stays until its callers move to `format.duration.fromSeconds`.

## `palette`

Every picker returns a `var()` reference. For this reason, DOM colors follow the theme by themselves. Canvas code passes the reference to `palette.resolve`.

| Function | Returns |
| --- | --- |
| `palette.categorical(i)` | `var(--qchart-1)` … `var(--qchart-18)` for series slot `i` (0-based, wrapping), and `var(--qchart-other)` for a negative index (the neutral "Other" group). |
| `palette.CATEGORICAL_SLOTS` | `18` |
| `palette.service(name, {assign})` | `var(--trace-span-color-N)`, one of 18 slots: the Traces and Jaeger assignment. `--trace-span-color-N` is `var(--qchart-N)`: services and series share one palette. A service takes the next slot the first time that the page sees it. It keeps the slot for the browser session, in the same `sessionStorage` key that Traces uses (`chdash.traces.serviceColors`). With `assign: false`, a name that the page did not see yet gets a stable hash slot (FNV-1a). The first-seen order of the view does not change. Logs and Metrics use it whenever the group key is a service. |
| `palette.serviceSlot(name, {assign})` | The 0-based slot behind `service`. |
| `palette.registerServices(names)` | Assigns the services of a view in name order before the view renders. In this way, a list and its charts agree, in whatever order they draw. |
| `palette.SERVICE_SLOTS` | `18` |
| `palette.quantile(p)` | `var(--pct-p50)`, `p90`, `p95` or `p99`, for `"p95"`, `"P95"`, `95` or `0.95`. Any other quantile takes the nearest of the four. |
| `palette.severity(level)` | `var(--sev-…)` for an OpenTelemetry SeverityNumber (1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal) or a SeverityText (`ERROR`, `warning`, `Critical`…). Unknown text reads as debug. |
| `palette.severityLevel(level)` | The level name behind `severity`: `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |
| `palette.sequential(t)` | `var(--trace-heat-1)` … `var(--trace-heat-8)` for `t` in [0, 1], clamped. Low values recede into the surface. |
| `palette.kind(kind)` | `var(--kind-…)` for a catalog object kind or engine name: `view`, `MaterializedView`/`mv`, `Dictionary`/`dict`, `Buffer`, `Distributed`. Every other engine is a table. |
| `palette.errorLevel(ratio)` | `"neutral"`, `"warn"` or `"danger"` for an error ratio (errors / requests, 1 = 100 %). Below 1 % is neutral. From 1 % up to 5 % is a warning. 5 % and more is danger (`palette.ERROR_RATE`, `{ warn: 0.01, danger: 0.05 }`). Every colored error rate uses it: the health dot of the service map (amber, red), its red border and edges and its legend, and the Services table, panel and sparklines. |
| `palette.errorColor(ratio)` | `null`, `var(--warning)` or `var(--danger)` for that level. |
| `palette.contrast(a, b)` | The WCAG contrast ratio of two colors (tokens or CSS colors, `color-mix()` included). |
| `palette.readableText(fill)` | `var(--on-fill)` (white) or `var(--on-fill-dark)` (ink), whichever contrasts more with `fill`: the label of a flamegraph frame on its service color. |
| `palette.resolve(token)` | The color that a token computes to in the current theme, as `rgb(r, g, b)` or `rgba(r, g, b, a)`, for canvas. It accepts `"--sev-error"`, `"var(--sev-error)"` or any CSS color. It reads the value once for each theme and caches it. It drops the cache when the forced theme (`html[data-theme]`) changes. In System mode, it also drops the cache when the OS color scheme changes. |

## Semantic color tokens

`src/static/css/00-tokens.css` defines them (see "Stylesheets"), in each theme context: `:root` (dark), `@media (prefers-color-scheme: light) :root` (System on a light OS), `html[data-theme="dark"]` and `html[data-theme="light"]`. A forced theme is always identical to the matching OS theme (`tests/harness/test_css_tokens_contract.py`).

**Surfaces** are graphite, with no blue cast in either theme:

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--bg` | `#0d0f12` | `#f6f7f9` | the page |
| `--panel` | `#13161a` | `#ffffff` | panels, menus, dialogs |
| `--raised` | `#191d22` | `#ffffff` | buttons, graph cards |
| `--border` | `rgba(255, 255, 255, 0.08)` | `rgba(15, 18, 25, 0.1)` | hairlines |
| `--control-border` | `rgba(255, 255, 255, 0.4)` | `rgba(15, 18, 25, 0.54)` | the edge of a field: 3.46 / 3.74 on the surface it sits on (WCAG 1.4.11) |
| `--control-border-hover` | `rgba(255, 255, 255, 0.58)` | `rgba(15, 18, 25, 0.72)` | the edge of a field under the pointer: 6.09 / 7.07 |
| `--text` | `#e6e8eb` | `#15181d` | body text: 14.78 / 16.60 |
| `--muted` | `#959ba5` | `#5b6270` | secondary text: 6.49 / 5.72 (6.06 / 6.13 on `--raised`) |

`--border` and `--button-border` stay for rules and for buttons, whose label names them. A field (a text input, a search box, a picker, the editor frame) draws its edge with `--control-border`: a field with the edge of a button is a white box on a white panel in the light theme.

The contrast column gives the lowest ratio on `--panel` and `--bg`. For status text, it also covers the own `-bg` tint of the token over those surfaces. Text tokens need 4.5:1. Fills (marks, icons, swatches, lines) need 3:1.

| Token | Dark | Light | Contrast dark / light | Role |
| --- | --- | --- | --- | --- |
| `--danger` | `#f87171` | `#b91c1c` | 6.56 / 6.04 (on tint 5.86 / 5.18) | error text and icons |
| `--danger-bg` | `rgba(239, 68, 68, 0.12)` | same | surface | error banner, cell |
| `--warning` | `#fbbf24` | `#9a5b00` | 10.87 / 5.06 (on tint 8.91 / 4.65) | warning text and icons |
| `--warning-bg` | `rgba(245, 158, 11, 0.12)` | same | surface | |
| `--success` | `#34d399` | `#137333` | 9.44 / 5.55 (on tint 7.80 / 5.04) | ok / healthy |
| `--success-bg` | `rgba(34, 197, 94, 0.12)` | same | surface | |
| `--info` | `#60a5fa` | `#1d4ed8` | 7.14 / 6.25 (on tint 6.22 / 5.48) | neutral notices |
| `--info-bg` | `rgba(59, 130, 246, 0.12)` | same | surface | |
| `--sev-fatal` | `#ff5f8a` | `#b4235a` | 6.27 / 5.89 | log/span severity |
| `--sev-error` | `#f87171` | `#dc2626` | 6.56 / 4.51 | |
| `--sev-warn` | `#fbbf24` | `#b45309` | 10.87 / 4.68 | |
| `--sev-info` | `#60a5fa` | `#2563eb` | 7.14 / 4.82 | blue |
| `--sev-debug` | `#8b95a5` | `#556378` | 6.00 / 5.69 | gray |
| `--sev-trace` | `#7d8590` | `#66727f` | 4.86 / 4.58 | dimmer gray |
| `--accent-fill` | `#356fe6` | `#2558d9` | 3.95 / 5.64 (`--on-fill` text on it 4.60 / 6.04) | solid accent: primary buttons, selected marks, the editor's focus border |
| `--accent-fill-hover` | `#2c62d4` | `#1e49bd` | `--on-fill` text 5.52 / 7.66 | a hovered primary button |
| `--selected-bg` | `rgba(53, 111, 230, 0.22)` | `rgba(37, 88, 217, 0.12)` | surface | the fill of every selected, pressed or chosen state (with a `--selected-edge` border: `--accent-fill`) |
| `--accent-text` | `#93b4ff` | `#1d4ed8` | 8.82 / 6.25 (on tint 7.52 / 5.42) | links, active facets |
| `--danger-fill` | `#dc2626` | same | 3.76 / 4.51 (`--on-fill` text 4.83) | a destructive primary action |
| `--danger-fill-hover` | `#c21f1f` | same | `--on-fill` text 5.98 | |
| `--on-fill` | `#ffffff` | same | | text and glyphs on a solid fill |
| `--kind-table` | `#5f8ced` | `#1f52c9` | 5.58 / 6.30 | object kind icons and marks |
| `--kind-view` | `#44b7eb` | `#0e87cd` | 7.97 / 3.65 | |
| `--kind-mv` | `#9f7cf5` | `#7051db` | 5.77 / 5.04 | |
| `--kind-dict` | `#dc913a` | `#ad6720` | 7.05 / 4.13 | |
| `--kind-buffer` | `#49c5b9` | `#13959b` | 8.61 / 3.38 | |
| `--kind-distributed` | `#5dd18b` | `#1d9766` | 9.47 / 3.45 | |
| `--pct-p50` | `#6575a7` | `#7286c6` | 4.02 / 3.53 | latency percentiles: one hue (OKLCH 270), p50 the quietest step, p99 the strongest |
| `--pct-p90` | `#7991df` | `#4b63c1` | 5.99 / 5.45 | |
| `--pct-p95` | `#97b0ff` | `#3448a4` | 8.61 / 8.05 | |
| `--pct-p99` | `#c8d6ff` | `#1d2a6f` | 12.54 / 13.02 | |
| `--on-fill-dark` | `#15181d` | same | | ink on a light fill (`palette.readableText`) |
| `--json-string` | `#bbe0cc` | `#183e2b` | 12.66 / 11.11 | JSON values |
| `--json-number` | `#e9d8ba` | `#463519` | 12.96 / 10.98 | |
| `--json-bool` | `#d8d4ee` | `#35314e` | 12.59 / 11.52 | |
| `--json-null` | `#adb2ba` | `#464c57` | 8.51 / 8.06 | JSON null, `format.nullToken()` |
| `--graph-muted` | `#a4aab3` | `#4b515c` | 7.76 / 7.45 (4.62 on the hottest dark trace-graph heat) | canvas secondary text |
| `--graph-edge-muted` | `#8d939c` | `#6b717c` | 5.86 / 4.58 | canvas edges |

The categorical slots follow, with their lowest contrast on `--bg`, `--panel` and `--raised`. `--qchart-other` is the neutral "Other" group: `#898781` in dark and `#6f6d68` in light (about 5:1 on `--bg`; the dark gray was 3.35:1 there):

| Slot | Dark | Light | Contrast dark / light | Hue |
| --- | --- | --- | --- | --- |
| `--qchart-1` | `#4296fb` | `#1a73d5` | 5.63 / 4.40 | blue |
| `--qchart-2` | `#e86a34` | `#c14802` | 5.28 / 4.67 | vermilion |
| `--qchart-3` | `#29ae81` | `#088963` | 6.02 / 4.11 | bluish green |
| `--qchart-4` | `#d28f09` | `#9c6900` | 6.19 / 4.42 | orange |
| `--qchart-5` | `#de669a` | `#b84379` | 5.22 / 4.76 | reddish purple |
| `--qchart-6` | `#4ba435` | `#227702` | 5.37 / 5.28 | green |
| `--qchart-7` | `#9e8cf4` | `#644fb1` | 6.06 / 5.95 | violet |
| `--qchart-8` | `#49c1ea` | `#046480` | 8.14 / 6.24 | sky |
| `--qchart-9` | `#febad9` | `#700048` | 10.68 / 10.99 | pink / wine |
| `--qchart-10` | `#ddd674` | `#433f01` | 11.24 / 10.05 | sand / olive |
| `--qchart-11` | `#7572ae` | `#39346a` | 3.85 / 10.46 | dusk indigo |
| `--qchart-12` | `#a86751` | `#7c3f2a` | 3.81 / 7.53 | brown |
| `--qchart-13` | `#9fb83c` | `#768c02` | 7.58 / 3.55 | lime |
| `--qchart-14` | `#0695b5` | `#078ead` | 4.82 / 3.57 | teal |
| `--qchart-15` | `#cf95c1` | `#7c4972` | 7.03 / 6.42 | mauve |
| `--qchart-16` | `#bdbcfd` | `#7b78b4` | 9.49 / 3.78 | lavender |
| `--qchart-17` | `#8e8945` | `#656019` | 4.69 / 6.05 | khaki |
| `--qchart-18` | `#85e2ed` | `#03464c` | 11.37 / 9.87 | aqua / deep teal |

The keyboard ring (`--focus-ring-color`) is `#3b82f6` / `#2563eb`: 4.60 on the lightest dark surface, 4.82 on the light page (`--bg`). On a solid fill (the primary and danger buttons, the first and last day of a range) the ring sits 2 px off the control (`outline-offset: 2px`). Drawn on the edge, it would be 1.25:1 against the blue fill. The graph accent (`--graph-halo`, the border of a focused or hovered card) is `#7c9cff` / `#2558d9`: 6.50 on a dark card, 6.04 on white.

Kind tokens are graphics (icons, swatches, card accents), so 3:1 applies. Text in a kind color mixes it with `--text`.

These are the origins of the tokens:

- **Status and severity** replace the former Logs `--log-sev-*` and the copies of the status colours of the Explorer and the graphs (`--exd-*`, `--graph-warn`, `--graph-error`). The light values are darker where those failed 4.5:1, on the surface or on their own tint. These values are `--sev-warn`, `--sev-debug` and `--sev-trace` in light, `--sev-trace` in dark, and `--danger`, `--warning`, `--success` and `--info` in light.
- **Accent**: one solid fill for each theme, with `--on-fill` text, for the primary button in both themes (no light override for each button). The design pass asked for `#3d7cf5` in dark. White text on it is 3.89:1. For this reason, the fill is `#356fe6`, the lightest step of that hue that keeps 4.5:1. Light is `#2558d9`. `--accent-fill` names the fill. The former `--accent` (a solid fill in dark, a tint in light) is gone. Its callers name `--accent-fill` or `--selected-bg`.
- **Kinds** are the Explorer lineage icon colors: a base hue mixed into `--text`, resolved for each theme. The Explorer tree swaps dictionary (teal) and buffer (amber). The tokens settle on dictionary amber and buffer teal.
- **Percentiles** are one blue-violet ramp: p50 recedes, p99 stands out. Each step keeps 3:1 on `--panel` (the table) and on `--bg`. The charts show P50 and P99 by default. P90 and P95 are one legend click away.
- **Categorical** (`--qchart-1` … `--qchart-18`): one palette for chart series and services.
  - Slots 1-8 keep the Okabe-Ito order (blue, vermilion, bluish green, orange, reddish purple, green, violet, sky).
  - Slots 9-18 add hues and lightness steps that stay apart. The OKLab distance between any two slots is 0.08 or more in dark and 0.095 in light.
  - No slot is red, because a red service or series would read as an error.
  - Every slot keeps 3:1 on `--bg`, `--panel` and `--raised`: 3.81 at worst in dark, 3.55 in light (the table above).
- **JSON** values use the `--json-*` colors (the key / value tree, `kv`). They are 22 % of a hue (`#22c55e`, `#f59e0b`, `#a78bfa`) mixed into `--text`. Null is 70 % `--muted` into `--text`. They are recomputed for the graphite `--text`.
- **SQL** (`--sql-string`, `--sql-keyword`, `--sql-function`, `--sql-number`, `--sql-null`, `--sql-type`; `--sql-comment` is `--muted`). In dark they mix a bright hue into `--text` (7.4:1 and more on every surface). In light the same mixes were 3.0 to 3.5:1 on white, so light has its own values, 4.5:1 and more on the white editor, `--bg` and the Graph group fill:

  | Token | Light | Contrast |
  | --- | --- | --- |
  | `--sql-string` | `#9a3412` | 6.82 |
  | `--sql-keyword` | the blue mixed 60 % into `--text` | 4.97 |
  | `--sql-function` | `#6d28d9` | 6.63 |
  | `--sql-number` | `#047857` | 5.12 |
  | `--sql-null` | `#b91c1c` | 6.04 |
  | `--sql-type` | `#0f766e` | 5.11 |

There is one name for one value: no token only repeats another (`--panel`, not `--panelBg`; `--accent-fill`, not `--accentBorder`). Every custom property is kebab-case (`--button-bg`, `--border-strong`, `--row-hover`). `--graph-heat` differs between the themes on purpose: it is the colour that the heat of a card mixes into the card fill (up to 45 %), chosen so that the text on it keeps 4.5:1 in each theme.

The literal colors that rules used to write inline (the 33 `--c-*` tokens) are gone. Each use now names a semantic token (`--on-fill`, `--success`, `--warning`, `--danger`, `--shadow-overlay`, `--backdrop`). Or it names one of the few component colors that `00-tokens.css` names: `--dot-ring` (the hairline inside a status dot) and `--hatch` (the Others of the size bands, the text color at 14 %).

## Type, shape, motion and stacking

`tests/harness/test_type_scale_contract.py` fails in these cases:

- A font size, weight or family, a radius, a blurred shadow, a transition duration or a z-index is written as a literal outside `00-tokens.css`.
- A canvas font leaves the families, weights or sizes below.

**Families.** Text is `--font-sans`. Code and identifiers are `--font-mono`. `01-base.css` makes form controls (`button`, `input`, `select`, `textarea`) inherit the font and color of the page. In this way, no control falls back to the own font of the browser (Arial on Linux). It also gives `code`, `pre`, `kbd` and `samp` the mono token at the size around them. The default monospace of the browser would shrink them to 13 px. A component sets its own size over either. `ui-guards.spec.js` fails when an element computes Arial, or when a code element computes another family.

**Fonts.** The fonts are IBM Plex Sans (400, 500, 600) and IBM Plex Mono (400, 500). They are the IBM Latin-1 subsets of the official release (npm `@ibm/plex-sans` 1.1.0 and `@ibm/plex-mono` 2.5.0, `fonts/split/woff2/*-Latin1.woff2`, unmodified). The UI also uses the IBM "Pi" subset of Sans 400 and 500 for the arrows and comparison signs that it prints. The `unicode-range` makes only a page that shows one fetch it.

- The files are in `src/static/fonts/` with the SIL Open Font License 1.1 (`src/static/fonts/LICENSE.txt`, the text of IBM). Plex is a Reserved Font Name. For this reason, the files ship as IBM released them.
- The seven files are 116 KB. A page fetches Sans 400 / 500 / 600 and Mono 400 (82 KB). It fetches Mono 500 and the Pi faces on first use.
- Every face is `font-display: swap`.
- The server serves them as `font/woff2` with `Cache-Control: public, max-age=604800`. A face never changes under its file name. Every other asset revalidates.
- The shells preload Sans 400 and 500 and Mono 400. The generated `<!-- shell:fonts -->` region (`FONT_PRELOADS` in `tools/page_shells.py`) writes the links next to the stylesheet with the base path of the page.
- The page measures again the canvas text that it measured before a face arrived. This happens on `loadingdone` of `document.fonts`. The text is in graph cards, chart axes and the character width of the editor.

| Token | Value |
| --- | --- |
| `--font-sans` | `"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif` |
| `--font-mono` | `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace` |
| `--fs-xs` / `--fs-sm` / `--fs-md` / `--fs-lg` / `--fs-xl` / `--fs-2xl` | 11 / 12 / 13 / 14 / 16 / 20 px; nothing is smaller than 11 px |
| `--fs-display` | 32 px, the value of a single-number Query chart |
| `--fw-regular` / `--fw-medium` / `--fw-semibold` | 400 / 500 / 600, the faces shipped |

The canvas modules use the same families, weights and sizes. `kit.FONT` in `app_graph_kit.js` repeats `--font-sans`, because a canvas cannot read it as `var()`. Component size tokens alias the scale: `--dt-font` is `--fs-md`, `--dt-head-font` is `--fs-sm`, `--dt-head-weight` is `--fw-semibold`.

**Mono or sans.** Use mono for what the user reads character by character: identifiers (database, table, column and function names), ids (trace, span, query), SQL, types, log bodies, and attribute keys and values. Use sans with `tabular-nums` for every measure: durations, counts, sizes, times, axis ticks, bar labels and percentages.

**Shape.**

| Token | Value | For |
| --- | --- | --- |
| `--r-sm` | 4 px | badges, chips' parts, marks, small bars |
| `--r-md` | 6 px | controls: buttons, inputs, pickers, segmented options |
| `--r-lg` | 8 px | cards, panels, menus, dialogs, the editor; canvas cards (`kit.CARD_RADIUS`) |
| `--r-pill` | 999 px | status badges, filter chips and scrollbar thumbs only |
| `50%` | | a dot |
| `--control-h` / `--control-h-sm` | 28 / 24 px | `.button` (13 px, 500) and `.button--small` (12 px) |

Surfaces are flat: no top sheen, no gradient on buttons. Only what opens over the page casts a shadow, `--shadow-overlay` (menus, popovers, tooltips, dialogs, side drawers and sheets, toasts). Inset rules, rings and spread-only outlines draw marks, not elevation. The backdrop of a modal is `--backdrop`, `rgba(0, 0, 0, 0.5)`, without a blur. A focused graph card has a border of 2 px `--graph-halo` and no ring around it. The frame of the Query editor takes an `--accent-fill` border while the caret is inside (`.editorWrap:focus-within`). Its textarea is left out of the global `:focus-visible` ring.

**Motion.** `--dur-quick` (120 ms) is for hover and color changes. `--dur-base` (160 ms) is for menus, panels and dialogs. There is one easing, `--ease` (`cubic-bezier(0.2, 0, 0, 1)`). The `CLOSE_MS` of `menu` is `--dur-base`. A loop or a long one-shot names its own token (the test refuses a literal duration in `animation`): `--dur-spin` (800 ms, the spinner), `--dur-pulse` (1 s, the running pulse), `--dur-band` (1.1 s, the running band), `--dur-sweep` (1.2 s, an indeterminate bar), `--dur-flash` (1.4 s, a deep link) and `--dur-settle` (1.8 s, the ring of a healthy dot). Under `prefers-reduced-motion: reduce`, every infinite animation stops. These are the indeterminate progress band, the host and Explorer health pulses, and the running query pulse and bar. The spinner stands still.

**Stacking.** Every `z-index` names a step:

| Token | Value | For |
| --- | --- | --- |
| `--z-below` / `--z-base` | -1 / 0 | behind a cell's content; a new stacking context |
| `--z-raised` / `--z-sticky` / `--z-sticky-top` | 1 / 2 / 3 | layers inside a component: a sticky head over its rows |
| `--z-overlay` / `--z-control` | 4 / 5 | a mark over a chart; a control over a canvas |
| `--z-panel` | 8 | a floating panel, the editor's resize handle |
| `--z-nav` / `--z-float` | 12 / 20 | the nav row; a tooltip inside a view |
| `--z-drawer` / `--z-header` | 30 / 50 | phone drawers; the page header |
| `--z-dropdown` / `--z-popover` | 70 / 90 | menus and pickers; a popover over them |
| `--z-modal` / `--z-menu` | 120 / 500 | dialogs; a menu that must cover a dialog (autocomplete, row menu, portals) |
| `--z-tooltip` / `--z-toast` | 1000 / 1300 | tooltips; toasts |

## Observability

Traces (`app_traces.js` for the search page, `app_trace_detail.js` for the trace page, and the `app_trace_*.js` modules under them; `docs/traces.md` lists them), Logs (`app_logs.js`), Metrics (`app_metrics.js`) and the page controller (`app_obs_page.js`) use only the foundations. The three views share two more modules. `app_obs_view.js` has the selected host, `hostCycle()` and `read(slot)`. `hostCycle()` is the cycle of a view with its host: a change of host empties the model, stops the `util.latest` slots of the old host and loads for the new one. The host change and the feature flags that arrive together make one reload. `read(slot)` is the one guard of a stale answer: a `util.latest` read that is also stale when the selected host is not the host it began with. Every read of the three views and of the trace page uses it (`const req = obsView.read("logs.search")`, then `req.signal` and `req.isCurrent()`). `app_timerange.js` has `checkRange()` and `resolveBounded()`, which check a range against the widest range of the server and give the same two sentences on every page, `sameRange()`, `localMidnight()` and `minuteKey()`. The last one is the key of a range in minutes: a search in the same minute has the same key, so the facets, the Services view and the Logs fields reuse the answer. `tests/harness/test_frontend_format_colour_rules.py` fails in these cases:

- A local formatter: `toLocaleString()`, an `Intl` formatter, a `toFixed()` that is not a CSS length or an SVG coordinate, `pad2`, `"\u2014"`.
- A hex, `rgb()` or `hsl()` color.
- A copy of the palette in those modules.
- A raw color in a style rule that only Observability can match.

Its allow-lists name the two justified `toFixed()` texts. They are the waterfall ticks of a deep zoom and the metric axis ticks. They share one decimal count.

- **Times**:
  - Lists and headers print `fmt.time` (`.SSS` for spans and logs).
  - The log detail prints every nanosecond (`fmt.time(ms, { precision: "ns", ns })`).
  - Every instant that the page shows carries `fmt.timeTitle` as its `title`.
  - A chart bucket reads `fmt.range(start, end)`. A relative start reads `fmt.ago`.
  - Range picker values and URLs keep `timeRange.formatDateTime`.
- **Counts and units**: `fmt.count`, `fmt.compact`, `fmt.duration` (and `.fromMs` / `.fromSeconds`), `fmt.percent` and `fmt.bytes`. Metrics values without a unit read `fmt.number`.
- **Colors**:
  - A service is `palette.service` everywhere (a Metrics series that is grouped by `service.name` too).
  - Latency percentiles use `palette.quantile`, the heatmap uses `palette.sequential`, and canvases use `palette.resolve`.
  - Logs and trace logs use `[data-sev]` for color. It sets `--sev-color` from the `--sev-*` tokens (`unset` reads as trace).
  - Status is `--danger` / `--warning` / `--success`. A solid status badge prints its glyph in `--panel`.
  - The `--obs-*` tokens hold what no semantic token names: text on an accent fill (`--obs-on-fill`) and the shadows of menus, popovers, drawers and sheets.
- **Signal, not decoration**: color and chips mark what needs attention.
  - Error rates: `palette.errorLevel` (neutral below 1 %, amber 1-5 %, red from 5 %). It is used on the service map (health dot, red border from 5 %, edges, legend) and on the Services table, panel and sparklines.
  - Log severities (`badge.severityHtml`): ERROR is a red chip, and FATAL is a solid chip. WARN is amber text (the row keeps its left bar). INFO is muted text. DEBUG and TRACE are dimmed text. A severity filter button stays a chip. The histogram legend reads at full strength. A severity filter dims the severities that it leaves out.
  - Span status (`badge.statusHtml`): Error is a red chip, OK is muted text, and Unset shows nothing (a key / value fact shows `format.EMPTY`).
  - Waterfall rows:
    - The child count is plain text (`+N` once collapsed).
    - The http method, the status and the db / rpc / messaging system are muted mono text.
    - An http status of 400 or more is a chip (amber 4xx, red 5xx).
    - The log count of a span is a chip only with an ERROR or FATAL log.
  - Metric kinds and units, and Explorer keys (ORDER BY, PARTITION...), are muted text, without a colored fill. Engines read as ClickHouse names them (`MergeTree`, `ReplicatedMergeTree`, `MaterializedView`).
  - Charts: bars are 78 % opaque with a gap of 1 px, and errors are stacked in red. Lines are 1.25-1.5 px. P50 and P99 show by default. Past one exemplar for each 40 px, each column keeps its highest exemplar.
  - The Services sparklines are a neutral line and a light area that are bound to the data, with their peak printed beside them. Only anomalies are colored, three for each row at most: a bucket at the error thresholds with two errors or more, and a P95 above twice the median of the row.
  - The flamegraph fills a frame with its service color mixed 40 % into the surface. The frame has a top edge of 2 px in full color. Its label is `palette.readableText` of that fill (4.5:1 or more).
- **Gone**: `--log-sev-*`, `--trace-log-*`, `--trace-error`, `--trace-warning`, `--traceError`, `--traceWarn` and `--traceKv*`. Attribute values are `--json-*`. A NULL attribute is `format.nullToken()`.

## Migrating a module

When you move a module onto the foundations, do these steps:

1. Replace each local formatter (`fmtInt`, `compact`, `formatDuration`, `pad2`, `toLocaleString()`…) with the `format` function. The outputs that change are listed below. In the same change, update the specs that pin the old strings.
2. Replace hex palettes and `getComputedStyle(...).getPropertyValue("--x")` color reads with `palette` and `palette.resolve`.
3. Replace status colors and kind colors in its CSS with the semantic tokens. Then drop the own family of the module when nothing reads it.

Expect these visible changes. All are intended:

- Compact counts use an uppercase `K`, so `1.2k` becomes `1.2K`.
- Logs times show the year when it differs, and `Sep 02` becomes `Sep 2`.
- Durations keep the Traces rules everywhere, so `8.5 min` becomes `8 min 30 s` and `1.23ms` becomes `1.23 ms`.
- Percentages floor at `<0.1%` (Traces showed `<0.01%`).
- Logs severities 21-24 turn fatal pink, and severities 1-4 turn the trace gray.
- The light status and severity colors listed above get darker. The accent fill is one token for each theme (`#356fe6` / `#2558d9`).
- Observability times are 24 h everywhere (`Sep 12 16:29:57`, never `04:29:57 PM` or `9/12/2026, 1:30:00 PM`). Grouped counts read `1,234` on every browser locale.
- Solid error badges are `--danger` with a `--panel` glyph: light red with a dark glyph in dark mode.

## Stylesheets

The styles are in `src/static/css/`, one file for each role. `src/static/css/index.css` imports each file into a cascade layer:

```css
@layer tokens, base, components, features, overrides;
@import url("00-tokens.css") layer(tokens);
@import url("01-base.css") layer(base);
@import url("10-components/tabs.css") layer(components);
...
@import url("20-features/traces.css") layer(features);
@import url("30-overrides.css") layer(overrides);
```

| File | Layer | Holds |
| --- | --- | --- |
| `00-tokens.css` | tokens | every custom property the pages share, in its theme contexts (dark `:root`, System light, forced dark / light), the type, radius, motion, `--bp-*` and `--z-*` scales, component sizes, and the web fonts' `@font-face` rules |
| `01-base.css` | base | the box model, page typography, the placeholder colour, scrollbars, the focus ring offset |
| `10-components/<name>.css` | components | one file per shared component: `buttons`, `inputs`, `form`, `tabs`, `segmented`, `menu`, `popover`, `panels`, `state`, `search`, `table`, `part`, `badge`, `stat`, `chart`, `graph-kit`, `copy`, `sql`, `kv`, `dialog`, `icon`, `page-back`. A rule that styles an element of a component, in any context (the pickers of the trace search bar, the copy button of the editor), lives with the component. |
| `20-features/<name>.css` | features | `shell` (the page shell), `query`, `query-library`, `analysis`, `explorer`, `system` (the System page), `observability` (the view row, filter bar and time range shared by the three views), `traces`, `logs`, `metrics`, `mcp` (the MCP integration page) |
| `30-overrides.css` | overrides | declarations that must win over every component and feature rule: the touch block, `[hidden]`, the focus ring, the forced-colors block ("Accessibility"), and the former `!important` ones that still compete with a stronger rule, grouped by the file they belong with. A former override of a feature that wins in its own file sits there (merged into its rule, or at the end of the file). The computed styles of every page and state check a fold. |

A later layer wins over an earlier one, whatever the specificity. For this reason, a feature restyles a component without a fight about specificity, and nothing needs `!important` to beat a component. Inside a layer, specificity and source order decide as usual (the files of a layer in `index.css` order).

Rules of thumb, which `tests/harness/test_css_rules.py` enforces:

- **One rule per selector list.** Write a selector list once for each layer and `@media` context. Add a declaration to its rule. Do not add a second rule.
- **No dead rule.** Every selector can match something that a page creates (`python3 tools/build_page_css.py --report-dead` lists those that cannot).
- **`!important`** only on the allow-list of the contract, each with its reason:
  - `[hidden]` (in the overrides layer: the weakest `!important`, so that a rule that shows a hidden element on purpose still does).
  - The rules that show an element despite `[hidden]` (the first paint of a view, the timeline of the unavailable trace).
  - Two displays that beat the display of another component.
  - A background that must win over an animation.
- **Colors are tokens.** A color literal (hex, `rgb()`, `hsl()`, a named color) appears only in `00-tokens.css`, named for its role.
- **Sizes, weights, families, radii, shadows, durations and stacking are tokens** too ("Type, shape, motion and stacking").
- A declaration of a feature that must not apply to a state of a component (`:hover`, `.is-selected`) excludes it with `:not(:where(...))`. This keeps its specificity.

**Page sheets.** Each page loads one generated sheet, named for the page: `style.query.css`, `style.explorer.css`, `style.functions.css`, `style.traces.css`, `style.trace.css`, `style.logs.css`, `style.metrics.css`, `style.system.css`, `style.queries.css`, `style.disks.css`, `style.shape.css`, `style.mcp.css` and `style.mcpusage.css`. `tools/build_page_css.py` writes them. Each sheet has one `@layer` block for each layer, with the files in `index.css` order. It has the rules that can match on the page. The script drops a selector when a class or id that it needs is not in the page. This means that the class or id is in no string literal of the scripts of the page and in no attribute of its shell. Comments and identifiers do not count.

The sheets are build outputs. CMake stages `src/static` without the sources and generates the sheets into the stage that it embeds. The Docker images run the script. Git ignores the sheets. To serve `src/static` from the file system, run the script once.

## Spacing, labels and selected states

`tests/harness/test_css_rules.py` and `tests/harness/test_type_scale_contract.py` fail in these cases:

- A `padding`, `margin` or `gap` has a length that is not a step of the spacing scale.
- A media query has a width that is not a breakpoint (see "Page shell").
- A custom property is not written in kebab-case.

**Spacing.** There is one scale, in `00-tokens.css`, named by the pixels it is:

| Token | Value | For |
| --- | --- | --- |
| `--space-2` / `--space-4` | 2 / 4 px | the gap inside a control, between an icon and its label |
| `--space-6` / `--space-8` | 6 / 8 px | the padding of a chip, a row, a small card; the gap of a toolbar |
| `--space-10` / `--space-12` | 10 / 12 px | the padding of a control and a panel; `--gutter` is 12 px |
| `--space-16` / `--space-20` | 16 / 20 px | the gap between two parts of a card |
| `--space-24` / `--space-32` | 24 / 32 px | the gap between sections |
| `--space-40` / `--space-48` / `--space-64` / `--space-80` | 40 to 80 px | an empty state, the room of an icon inside a control |

Every positive length of a `padding`, `margin` or `gap` is `var(--space-N)`. The only literals are `0`, `auto`, a hairline of `1px`, and a negative margin on the scale (`-2px`, `-4px`: the overlap of two borders, an icon pulled into its control). A value that a function computes (`calc()`, `min()`, a percentage, an `em`) is not a step. There is no 3, 5, 7 or 9 px, and no half pixel: the rhythm of a page comes from the scale and not from the habit of its author. The values of the former pages that were not on the scale went to the nearest step (3 to 4, 5 to 6, 7 to 8, 9 to 10, 14 to 16, 18 to 20, and a value in `rem` to the step of its pixels).

**Labels.** There are two kinds of text over a value. Their looks are not mixed.

- A label of a field or a pill (`.uiField__label`, the Status and Query ID pills of the Query page, `.timeRangeField__label`, the label of a `.statTile`) is sentence case, 12 px (`--fs-sm`), `--fw-medium`, `--muted`. It is the name of one value ("Name", "Query ID", "Elapsed").
- An eyebrow is the small heading of a group of things (`.timeRangePanel__title`, `.timeRangeList__heading`, `.qhDay`, the group titles of the editor menu, the weekdays of the calendar). It is upper case, 11 px (`--fs-xs`), `--fw-semibold`, `--muted`, with `letter-spacing: var(--ls-eyebrow)` (0.04em). A new `text-transform: uppercase` is an eyebrow, with these values.

**Case.** Every label, title and button is in sentence case ("Trace start", "Total spans", "Download debug", "Query analysis", "Sort · Most recent"). A product name, a ClickHouse name (`MergeTree`, `MaterializedView`), an acronym (ID, SQL) and a value of the data keep their case. The product is "ClickHouse Dash" in every text of the interface. A status is a word of the interface: it starts with a capital ("Idle", "Finished", "Healthy", "Connected", "Down"). `ns.badge.statusLabel` gives "OK", "Error" and "Unset" for a span. A log level is upper case, as OpenTelemetry writes it (`ERROR`, `WARN`).

**Selected and pressed.** A chosen option, a pressed toggle, a selected row and the current item of a menu look the same everywhere:

| Part | Look |
| --- | --- |
| Fill | `--selected-bg` |
| Edge | 1 px `--selected-edge` (`--accent-fill`). A box has it as its border. A row that cannot have a border has it as an inset ring (`box-shadow: inset 0 0 0 1px`). A table row has it above and below. |
| Mark | A check (`--icon-check`, 14 px) on a menu option, a pressed filter chip (`button.badge`) and a finished Progress tile. The state is then not told by colour alone. |

The focus ring (`--ring`) is not a state of the item. It stays on top of it. A bar at the left of a row is the channel of its severity (a log level, a span error): a selection never uses it. Segmented controls, filter chips, the tree and the lists of the Explorer, the time ranges, the query library, the trace results and the rows of every table use these two tokens. Tabs are not options: a tab that is current has an underline (`aria-current` or `.is-active`).

## Page shell

Query, Explorer, Observability and System share one full-bleed page chrome. It is written once in `src/static/css/20-features/shell.css` (its tokens in `00-tokens.css`):

- The header is the partial `src/shell/header.html`. It has the brand, the page switcher, the version badge, the host picker and the theme.
  - The version and the selected host (name, ClickHouse version, health dot) are painted at first paint from the last page's values (`chdash.header.v1`, written by `app_header.js`, read by the head script of the header): a reload does not show "--" and "Host" until `/api/version` and the hosts stream answer. The real values replace them as soon as they arrive.
  - The page switcher is a nav of links (`nav#pageSelect`, `aria-label="Pages"`): Query, Explorer, Observability, System, and MCP when the server has it on. Every page is a document of its own, so each entry is an `a href`: a click opens the page, and a middle click or Ctrl+click opens it in a new tab. The current page has `aria-current="page"` (the partial writes `{{current.<page>}}`) and an underline of 2 px on the bottom border of the header. From 821 px the links are in the header. At 820 px and below they fold into a menu under a button that names the current page (`#pageSelectButton`). That menu keeps the current page in its list, with a check. The header script writes the base path in the links (`window.__chdashUrl`). It also shows or hides each link from the last answer of `/api/version` (`chdash.pageNav.v1`), so the links do not move when the API answers.
  - The host picker shows the name of the host in full, up to 28 rem. Under 1280 px the version and the ping leave the button: they stay in the menu. The menu lists every host and marks the current one (`aria-selected`, a check).
  - The version (the source of the page) is small muted text under the brand name, so a longer version text moves nothing beside it. At 820 px and below, the header is two rows: the brand and the version, then the host, the page menu and the theme.
  - The nav row of the page follows (`#obsNav`, `#explorerTopBar`, `.systemPage__nav`, `.mcpPage__nav`). It is one row. It has the Catalog modes of the Explorer and the controls of the System section on its right. The two MCP pages (Keys and Usage) have a nav row of two links and no bar and no strip. The first row under it is the heading of the keys (title, filter, Refresh, New key). On Usage it is the filter bar (Group by, four lists, the window, Refresh; see "Filter bar"), then its chips (one line that is always there, with a hint when no filter is on, so that adding a filter moves nothing under it), and the heading of the usage (title, dates) opens the panel under them. The nav row of System and the one of MCP are one rule (`shell.css`).
  - The regions of the page follow, edge to edge, on the flat `--bg`.
  - There is no page card, no rounded inset and no outer shadow.
  - The switcher hides an entry whose page `/api/version` turns off. The MCP entry ships hidden and shows when `features.mcp.enabled` is true. The switcher hides itself when only Query remains.
- A page of stacked parts (System, MCP) uses one frame. `.systemWorkspace` and `.mcpWorkspace` fill the window. `.systemPage` and `.mcpPage` are a column of a nav row, bar rows (System) and one panel. `.systemPage__panel` and `.mcpPage__panel` are the scroller. The rules are in `shell.css`.
- A part of such a page is `.pagePart` (`10-components/part.css`): a head with the title (`.pagePart__title`, an `h2`) and a count (`.pagePart__count`), then the body (`.pagePart__body`). Parts follow each other with a gap of 28 px.
- A table in a part sits in `.dataTableWrap`: a hairline box that scrolls sideways when the columns are wider than the box. A box that scrolls on one axis scrolls on the other, so the head of a table inside the scroller of the page never sticks. A table that has many rows (System > Queries) therefore gives its box the height that the panel leaves it (`.systemQueries__wrap`): the box is the one scroller under the tiles, and the head stays over the rows.
- `--gutter` (12 px, 10 px at 820 px and below) insets the content of every region and the header. `--nav-row-h` (40 px) is the height of a nav row. On a phone (760 px and below) or a touch screen it is 41 px: the tabs of the row stand on its 1 px border and keep the 40 px hit area (`--hit`). `--shell-border` (1 px `--border`) separates regions and rows.
- The `--z-*` scale names every stacking level ("Type, shape, motion and stacking"). The shell and what opens over it use `--z-nav`, `--z-drawer`, `--z-header`, `--z-dropdown`, `--z-modal` and `--z-tooltip`.
- `--bp-sm` (600 px), `--bp-tab` (760 px), `--bp-md` (820 px), `--bp-lg` (1100 px) and `--bp-xl` (1279 px: from 1280 px a window is wide) are the only widths at which a layout changes. A `max-width` query names one of them. A `min-width` query names the pixel above one (601, 761, 821, 1101, 1280). `tests/harness/test_css_rules.py` refuses any other width. Media queries cannot read custom properties, so they repeat the numbers. Scripts use `shell.BREAKPOINTS`, `shell.isAtMost("md")` and `shell.mediaQuery("md")` from `app_dom.js`.
- Scroll model: html and body never scroll. The content region of each page is its only scroller. These are the scrollers:
  - `#queryWorkspace`.
  - The detail, graph and storage panes of the Explorer.
  - The own pane of each Observability view.
  - The panel of each System section (`.systemPage__panel`).
  - The workspace of the MCP integration page (`.mcpWorkspace`).

  Side panels and detail panels scroll on their own.
- Use `--shell-top` for anything that you place under the chrome. `app_dom.js` sets it on every page to the bottom of the header and the nav row. Do not use a literal header height.
- The first element of the page is the skip link (`a.skipLink`, in `src/shell/header.html`): the first stop of the Tab order, out of sight until it has the focus. It goes to the `main` of the page. `pages.<page>.main` of `src/static/modules.json` gives each shell the id of its `main`.
- Headings: one `h1` for each page, the name of the page (`srOnly`: the page switcher shows it). It is the first child of the `main`, so that no text of the page is outside a landmark. Use one `h2` for each Observability view (`srOnly`, after the `h1`). Use one `h2` for the title of the Explorer card (`#explorerDetailName`, `#explorerFunctionDetailName`). The sections under it are `h3`.
- The version of the header is small muted text (`--fs-xs`, `--muted`) under the brand name, 4.5:1 in both themes.

## Touch and phones

**Touch (`@media (pointer: coarse)`)**: every control takes `--hit` (40 px) or more on both axes. A mouse sees none of it.

- `00-tokens.css` sets `--control-h`, `--control-h-sm`, `--row-compact`, `--row-regular` and `--trace-row-h` to `--hit` (the span bar stays `--trace-bar-h`, 14 px, centered). Virtual lists read their row height through `table.rowHeight`, so they follow.
- The components that do not read a token grow in the "Touch" block of `30-overrides.css`. These components are tabs, menu items, pickers, fields, icon buttons and tree rows. They also are summaries, the "Show all" toggles, the waterfall head and labels, and the pipeline controls of the profiling dialog.
- Some elements keep their look and reach `--hit` through a transparent `::after` band on them. These are a small glyph inside text, a chip, and a dense row. Examples are:
  - Copy, chip remove and "Deselect all".
  - A collapse box.
  - The toggles of the profiling tree.
  - The focus magnifier of the pipeline.
  - An exemplar mark.
  - The overview handles.
  - Segmented options.
  - Badge buttons.
- A link that cuts its text with an ellipsis (the names in the databases and objects tables) is a `--hit` line instead. Its own overflow would clip a band.
- A checkbox is reached through its label, a `--hit` row.
- Chips that wrap are 32 px tall and 8 px apart, so that the bands of two rows meet.
- Per-row actions fold into a menu. A key / value row with two or more actions shows one "..." button (`.kvList__more`) that opens them as an `menu` context menu. On a phone, the click-to-filter values of the span list are no targets of their own. A tap opens the span, and the panel of the span filters.
- The test helper `smallTouchTargets(page)` in `tests/frontend/helpers/app.js` probes every visible control with `elementFromPoint` along its center lines. Bands count. A neighbor that is drawn over the control does not count. A control of a scroller that stands within 24 px of the top or the bottom of the window is scrolled to the middle first: the window's edge cuts its band, and is no part of the control.
- `page-chrome.spec.js` runs the helper on every page at 390, 360 and 768 px with touch. It also runs it on the states that hold the small controls: All databases, a database page, an open span, and the Pipeline and Tracing tabs of the profiling dialog.
- The test does not measure the cells of a size band (treemap rectangles, strip segments). They are as large as their share.

**Phones (600 px, `--bp-sm`, and below)**: content first.

- A `.foldSummary` (one line, with a chevron that turns while the region is open) stands for a folded region. It is used in these places:
  - Each filter bar of Observability, System and MCP Usage ("2026-09-12 12:30 -> 13:30 . 2 filters"). The action (Search or refresh) folds it again. Its chips fold with it (`filterBar.mountSummary`, `app_ui_filterbar.js`).

  The overview charts (`[data-phone-fold]`: Matching traces, Trace duration, the Logs histogram) start folded to their head (`.chartCard__fold`). The folds work only at that width: their rules are in `max-width: 600px` blocks.
- Logs records are two-line cards, `--row-card` (52 px) tall: Time, Level and Service, then the Body.
- The trace detail keeps its title on the first line and its stats on the second. Stats, highlights and service filters are single rows that scroll sideways. Span names drop their method / status chips and log counts.
- A row that scrolls sideways (every `tabs` row, `#obsNav`, the trace header rows) fades the side where it hides content. `shell.edgeCues(el)` sets `.has-edge-start` / `.has-edge-end`. `shell.css` masks that edge over `--edge-fade`. A selected tab scrolls into view in its own row.
- Use at most two " · " separators on a line. A meta line (`util.setMetaLine`) shows three parts and moves the others to its tooltip. The status lines join related figures with commas. Examples are "5 rows, 4 columns · 6 ms · read 1.9 MB" and "9 nodes, 9 edges · chdash_ui.weather_observations, neighborhood depth 2".
- Meta lines (`util.setMetaLine`) put each " . " part in a nowrap `.metaPart`. A line wraps between parts. It never wraps between a value and its unit. The header keeps the ClickHouse version of the host whole (the ping is in the host menu).

## Accessibility

The pages meet WCAG 2.2 AA in both themes. `tests/frontend/specs/a11y-contract.spec.js` keeps this: it runs axe-core on 17 states of the pages in each theme and expects no violation. The rules below say how.

**Colour.**

- Text is 4.5:1 and more on every surface it can sit on. The tokens are measured on `--bg`, `--panel`, `--raised` and the editor surface, never on one of them only. Muted text is `--muted`, whole. Do not dim text with `opacity` or with a `color-mix()` into `transparent`: the ratio then depends on the surface behind it. `opacity` is for disabled controls and for loading states. A state that needs a quieter text uses `--muted`; a state that needs more says it with a border, an icon or a line style.
- A placeholder is `--muted` at full opacity (`01-base.css`, `::placeholder`). Guidance that a user needs while typing (the syntax of the Logs search) also goes in `aria-describedby` text, because a placeholder disappears.
- A field draws its edge with `--control-border` (3:1). This covers `.uiInput`, `.uiSearch`, `.obsFilterBar__input`, the time range fields, `.tracePicker__button`, the Metrics filter fields and the editor frame.
- A selected or pressed state is not told by a tint alone: it has a border, a weight or an outline too.

**Focus.** The ring is the global `:focus-visible` outline ("Semantic color tokens"). A scrolling region that has no focusable content takes the keyboard through `util.scrollFocus(el, { label })` (`app_util.js`). While its content overflows, the element is a region with `tabindex="0"` and a name. When it fits, it is neither. The SQL blocks and the Explorer detail pane use it.

**Landmarks and headings.**

- The skip link is the first stop. One `main` holds the one `h1` and every view.
- Headings go down one level at a time. The cards of a page are `h3` under an `h2` for the section. When a section has no visible title, its `h2` is `srOnly` (the Disks and the query shape pages).
- A dialog or a popover is named by a `p` or a `strong`, not by a heading that would break the outline.

**ARIA of the data views.** A role is a promise of a keyboard model and of required children. These are the choices:

| View | Markup |
| --- | --- |
| Logs records (`#logsTable`) | `role="grid"` of `role="row"` rows with `role="gridcell"` cells. The rows in the DOM are a window of the list, so the grid says `aria-rowcount` (`-1` while older logs may follow) and each row its `aria-rowindex`. The scrolling `rowgroup` is the one Tab stop. A message (loading, an error, nothing found) lies over the grid, outside it. |
| Logs patterns | a `ul` of `li` that hold a `button`. A heading row, hidden from assistive technology, names the columns. |
| Trace results | a `ul` of `li`. The title is a link to the trace page. The card is not a control: its buttons (Copy, the "+N" chip) are separate tab stops. |
| Trace waterfall | the rows are `role="group"` named by what they show ("service: operation, duration, children"). A button role would nest the fold box and the badges. The arrow keys pan the timeline, so there is no tree or grid role: it would promise arrow keys for rows. |
| Separators (the waterfall and the profiling Tracing tab) | `role="separator"` with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`, and the arrow keys. |
| Charts | the keyboard cursor of a chart is `role="application"` with `aria-roledescription="chart"` and a name that lists its keys. |
| Metrics catalog | `role="tree"` while it lists metrics. A state (loading, an error, nothing found) is a plain group, because its button is no tree item. |
| Size strips | `role="group"`. A segment that opens its database or table is a button. |

**Forced colors** (Windows high contrast). The block `@media (forced-colors: active)` at the end of `30-overrides.css` says again what the browser would lose. The browser replaces colours by the system palette, drops the box shadows and the background images, and draws every background in Canvas.

- An icon drawn by a mask (the chevrons, the sort arrows) is a background colour: it takes `CanvasText`. A rule test (`tests/harness/test_accessibility_rules.py`) fails when a rule that draws a mask is not in this list.
- A selected or pressed state is an outline in `Highlight`. A focused element keeps the focus ring.
- A mark that encodes data (a status dot, a service swatch, a span bar, a cell bar, a legend swatch) opts out of the forcing (`forced-color-adjust: none`), or says its colour in system colours (a cell bar is `Highlight` on `Canvas`). Without this, all series, statuses and sizes would be one colour.
- The colour probes (`palette.resolve` and the chart engine's) opt out too: a canvas chart keeps its series colours. Its axes, labels and grid take `CanvasText` and `GrayText`.

**Tests.** `a11y-contract.spec.js` measures the token contrasts in both themes, the edge and the placeholder of every field on seven pages, the focus ring of a primary button, axe on the states, the skip link, the landmarks of the twelve page shells, the ARIA of the views above and the forced-colors rules. `state-truth.spec.js` keeps the findings about states and data. `tests/harness/test_accessibility_rules.py` keeps what a browser cannot see in the sources: the colour rules (the tokens, the fields, no opacity on text, the placeholder), the skip link, the landmarks, the forced-colors block and the one focus ring.

## Icons

There is one drawing style: the outline icons of [Tabler Icons](https://tabler.io/icons) (MIT, `src/static/icons.LICENSE.txt`). They have a 1.5 stroke on a grid of 24 units, round caps and joins, no fill, and `currentColor`. Phosphor is the fallback for a drawing that Tabler does not have.

- **The sprite**: `src/static/icons.svg` has one `<symbol id="i-<name>" viewBox="0 0 24 24">` for each icon. It has geometry only (no paint attributes), in ASCII. A comment after each symbol names its Tabler icon. To add an icon, do these steps:
  1. Copy the paths of the Tabler outline file into a new symbol. Do not copy the transparent `M0 0h24v24H0z` frame.
  2. Run `python3 tools/build_page_css.py`.

  Pages ask for `static/icons.svg?v=<content hash>` (`tools/icons.py`). The address changes with the drawings. For this reason, the server lets browsers keep it for a year (`immutable`). The bare address revalidates like other assets.
- **The helper**: `icon(name, { size, label, className })` (`app_ui_icon.js`, a common module) returns `<svg class="icon" aria-hidden="true"><use href=".../icons.svg?v=...#i-name"/></svg>`. `icon.el(...)` returns the element. The static markup in the shells and in `src/shell/header.html` writes the same `<svg class="icon">` with `href="/static/icons.svg#i-name"`. `tools/build_page_css.py` stamps the current hash into it. The shell rewrites it under a reverse-proxy prefix before the first paint.
- **Sizes** (`css/10-components/icon.css`): 16 px (`--icon-md`) by default. `size: "sm"` is 14 px (`--icon-sm`: in chips, badges, dense rows, beside text of 11-12 px). `size: "lg"` is 18 px (`--icon-lg`: the theme button, the trace Back). The `.icon` rule is the only rule that paints an icon. A component sets its color. It never sets its stroke. `vertical-align: middle` and `flex-shrink: 0` keep the icon on the center line of the text in inline rows and flex rows.
- **Buttons**: an icon-only button has an `aria-label` and a `title`. The `title` names its shortcut, "Zoom in (+)". Its icon stays `aria-hidden`. `label` gives an icon `role="img"` only when it speaks on its own, outside a labeled control. The button keeps its size tokens (`--control-h`, the `--hit` band on touch). The icon never sizes the button.
- **Disclosure**: a tree toggle or a row toggle holds `chevron-right` with `className: "icon--disclosure"`. It turns down while its button is `aria-expanded="true"`. A fold summary or a select turns `chevron-down`.
- **Pseudo-elements** cannot hold an `<svg>`. These are the chevrons of selects and pickers, the arrows of `<details>`, and the library twisty. They also are the sort arrows of a `.dataTable` header (1em of the header text). They paint a mask, `mask: var(--icon-<name>) center / 100% no-repeat` on `background-color: currentColor` (or `--muted`). The `--icon-*` tokens in `00-tokens.css` are generated from the symbols of the sprite (`MASK_ICONS` in `tools/icons.py`) with the `.icon` paint. For this reason, a mask and a sprite icon are one drawing. A `mask-image: url(icons.svg#...)` would not work. A fragment that names a `<symbol>` is no CSS image in any engine, and `<view>` fragments are not reliable as masks in WebKit.
- **The logo**: a 26 px mark before "ClickHouse Dash" (four bars of a column chart in `--accent-fill`, `.appBrand__logo`). It is inline in `src/shell/header.html`, so that it paints with the header. The favicon is the same drawing: `src/static/images/logo.svg` (light and dark tab chrome) and `favicon.ico` (16, 32, 48 px) as the fallback.
- **Text stays text**:
  - The " . " separator.
  - "≈" estimates.
  - "×" multipliers ("×691", "1 shard × 2 replicas").
  - Arrows in ranges and prose ("12:30 → 13:30", "MOVE → disk").
  - "⌘" and arrow keys in shortcut hints.
  - Labels that a canvas draws with `fillText` (the "▸ db" group labels of the Explorer graph and its "−" / "+1" expansion controls).

  Any other glyph that stands for an action or an object is a sprite icon. These glyphs are a close cross, a chevron, an arrow on a button, and an object kind. `tests/harness/test_icons_contract.py` holds these rules. `tests/frontend/specs/ui-icons.spec.js` checks that every visible icon is drawn and every icon-only button is labeled.

## Building elements

`app_dom.js` (in `app_common.js`, right after the format and palette modules) gives every page one way to build and find elements.

- **`h(tag, props, ...children)`** returns an element. `props` is `null` or an object. These keys have a special meaning:
  - `class`: a string, an array (falsy entries are skipped), or `{ name: on }`.
  - `dataset`: `{ spanId: id }` gives `data-span-id`.
  - `style`: a string or `{ left: "4px", "--trace-service-color": c }`.
  - `aria`: `{ label, pressed: false }`. Aria values print `"false"`.
  - `on`: `{ click: fn }`. `signal` removes the listeners (`signal` is an `AbortSignal` or an `lifecycle` scope).
  - `value`: the attribute, as in markup. For a `<select>` or `<textarea>`, it is the property, set after the children so that a select finds its option.
  - `indeterminate`: the property.
  - Any other key is an attribute (`true` present, `false` or `null` absent: `checked`, `disabled`, `hidden`). A URL attribute never takes a `javascript:` URL.

  Children are strings and numbers (always text, never markup), nodes, and arrays of children. `null`, `undefined`, `false`, `true` and `""` add nothing. `h.svg(tag, props, ...children)` builds in the SVG namespace.
- **`h.frag(...children)`** returns a `DocumentFragment`. **`h.replace(container, ...children)`** replaces the children of a container (no children clears it).
- **`h.html(trusted)`** returns a fragment that the function parses from markup. It is the one greppable way to insert markup next to `h()`. Use it for trusted strings only (the SQL highlighter output, icons, the escaped string renderers below).
- **Lookups**: `dom.byId(id)`, `dom.$(selector, root)` (the first match) and `dom.$$(selector, root)` (every match, an array). `root` defaults to the document only when it is left out. An explicit `null` root finds nothing. In this way, a component never searches the whole page by mistake. Modules take them with `const { byId, $, $$ } = dom;`. They never call `getElementById` or `querySelector*` themselves. The loader and the Observability bootstrap run before `app_dom.js`, so they are the exceptions. The `dom.*` registry keeps the ids of the page shell.

**String renderers.** Some lists are drawn thousands of times: the trace waterfall, the span list, the Logs grid, the treemap. The panels that the `*Html` functions of the data components build are also in this group. These stay HTML strings:

- Every value goes through `util.escapeHtml` (the `esc` alias of a module) or through a component that escapes.
- A variable or function that holds such markup is named `*Html`.
- Each module that still writes `innerHTML` / `outerHTML` or calls `insertAdjacentHTML` is on the allow-list of `tests/harness/test_dom_builder_contract.py`, with its reason and its count.
- A template literal that is written straight into one of them interpolates only escaped values, `*Html` markup, numbers, constants and literals.

Everything else uses `h()`, from a count label to a menu. To clear a container, use `replaceChildren()` (or `h.replace(el)`). Never use `innerHTML = ""`.

## Layers, popovers and panels

Three modules load right after `app_dom.js` on every page (they are imported by `app_common.js`):

- `layers` (`app_ui_layers.js`): the one stack of what is open over the page. `layers.push({ el, onDismiss, modal, docked, trapFocus, opener })` returns a handle with `close()`.
  - Escape closes the top layer only. It leaves alone a key that a component consumed with `preventDefault()`, and a key that the user typed in a page field.
  - One capture pointerdown dismisses the floating layers when a press lands outside of them. Docked panels and modal layers stay.
  - The focus goes back to the opener.
  - Every `dialog` is a modal layer.
  - Do not add a document Escape or click-outside listener. Push a layer.
- `lifecycle` (same module): `scope()` gives an `AbortController` signal for `addEventListener(..., { signal })`. `bind(view, (scope) => ...)` runs each time a view shows. Its listeners go when the view is hidden. An Observability page shows one view for as long as it lives (`traces`, `logs` or `metrics`): the scope of the view is the scope of the page and it is never left. The Explorer shows one mode at a time (`explorer:<mode>`). The scope of a mode ends when another mode shows.
- `popover` (`app_ui_popover.js`):
  - `place(anchor, el, { side, align, offset })` (flip and a viewport margin of 8 px).
  - `tip(el, content)` (hover / focus tooltips, `role=tooltip`, never a live region).
  - `follow()` (pointer tips over canvases).
  - `open(anchor, content)` (a popover layer).
  - `flash(anchor, "Copied")`.
- `sidePanel` and `detailPanel` (`app_ui_panel.js`):
  - The left list is `sidePanel` (`.uiSide`, `--side-w` 288 px, a rail of 32 px when folded, a drawer on phones). The Explorer tree and the Functions list take no `collapse`: no head bar, no rail, and the search and its refresh button on one `.uiSide__searchRow`.
  - The right entity panel is `detailPanel` (`.uiDetail`, `--detail-w`, docked or floating, one head and the `.closeCross` close button, a bottom sheet at `--bp-md`).
  - A detail panel that shows one entity writes one URL parameter (`span=`, `log=`, `node=`, `svc=`) through `router.panel(name)` (see "Routes"). It pushes the parameter when the panel opens and replaces it when the panel moves. Back closes the panel.
  - Below `sidePanel.FOLD_BELOW` (1600 px, and above `--bp-md`), a docked detail panel that opens folds the side panels that the page shows to their rails. It unfolds them when it closes. A rail that the viewer opened in the meantime stays open. The page remembers neither change.
  - The head of a side panel takes `.is-scrolled` (a soft edge, `--shadow-sticky`) while its list scrolls under it.

## Components: tabs, segmented controls and menus

Every navigation control or choice control is one of three components. Each loads on every page (`app_common.js` imports them after `app_dom.js`). Each keeps its CSS in its own file, `src/static/css/10-components/<name>.css`. `tests/harness/test_frontend_code_rules.py` fails when a local copy of a family comes back (a tab row, a menu motion, a modal of its own).

### Tabs: `tabs` (`app_ui_tabs.js`)

**Sections are underline tabs; modes are segmented controls.** Every row of sections has one look, `.contentTabs` / `.contentTabs__tab`. The labels are muted, 13 px, semibold. The selected label is in the text color over an underline of 2 px `--accent-fill`. There is no fill, no frame and no radius (the pill tier, `.viewTabs`, is gone).

In the nav row of a page, the row is `.contentTabs--nav`. It is as tall as the row, and its underline stands on the bottom border of the row. On a narrow window, it shrinks and scrolls sideways (`shell.edgeCues`). These are the users:

- Nav rows (`.contentTabs--nav`):
  - Catalog | Functions of the Explorer.
  - Browse | Graph of the Catalog.
  - The Observability views.
  - Search | Services | Service map of Traces.
  - The System sections.
- In-content rows: the Explorer table card, Logs Results | Patterns, the log record tabs, the trace detail views and the dialog tab rows.

**Second-level sections** share the nav row of the page. The selected view can have sections of its own. These sections follow the view tabs on the same row, after a divider (`.contentTabs__sep`, `tabs.css`: 1 px by 22 px of `--border`). They have the same underline look. These are the cases:

- Observability: Traces | Logs | Metrics, then, on Traces, Search | Services | Service map (`#obsNav`).
- The Explorer: Catalog | Functions, then, on the Catalog, Browse | Graph (`.explorerTopBar__tabs`).

These rules apply to the levels:

- Each level is its own `tabs` row. It has its own tablist and label, Left / Right within it, and its own address parameter: `?tab=` on Traces, `?mode=graph` on the Catalog.
- The second row and its divider are hidden on a view without sections (Logs, Metrics, Functions). They are never left empty.
- On a narrow window, the two rows scroll sideways as one, with the edge cues of `shell.edgeCues`. The selected tab is kept in view (`shell.revealInRow`).
- On a touch screen, each tab is `--hit` tall.

`tabs.bind(list, { attr, onSelect })` owns these items:

- `role=tablist` / `tab`, `aria-selected` and `.is-active`.
- The roving tabindex (Tab reaches the selected tab only).
- Left / Right / Home / End with automatic activation.
- The click.

The value of a tab is its `data-<attr>` (`data-tab` by default). `onSelect` shows the panel. It can rebuild the row or return a promise. In both cases, the selected tab keeps the focus. `tabs.render(list, items, { selected })` builds a row from data. `tabs.select(list, value)` marks one tab selected. No other module handles tab keys. On a touch screen, every tab is `--hit` tall. `ui-guards.spec.js` checks the look of every visible tab row on each page.

### Segmented controls: `segmented` (`app_ui_segmented.js`)

A segmented control is a short row of exclusive choices that switch a view in place. These are examples:

- Traces | Spans.
- List | Table.
- Percentiles | Heatmap.
- Table | Chart.
- The chart types.
- Lineage | Tiers.
- By metric | By service of the Metrics catalog.
- The presets of the context window.
- The metrics `=` / `!=`.

**Segmented = modes, underline = sections.** A segmented control shows the same scope in another way (a mode). Underlined tabs are the sections of one thing. Examples are the views of a page, the Columns, Preview and Storage of a card, and the views of a trace.

- **ARIA pattern**: `role=group`, named by `aria-label`, that holds toggle buttons with `aria-pressed`.
- **Look**: `.segmented` / `.segmented__option`. The pressed option sits on `--selected-bg`, which every theme block defines, with an `--accent-fill` edge.
- **Sizes**: 28 px by default. 24 px with `.segmented--compact` (in card headers and dense toolbars).

The API:

- `html(options, { attr, value, size, label, className })` returns the markup as a string.
- `render(group, options, ...)` builds the options into an element.
- `bind(group, { attr, onChange })` handles the clicks.
- `set(group, value, attr)` marks the pressed option.

Each option keeps its value in a data attribute that the caller names (`data-results-view`, `data-duration-view`...).

An option of `{ html, iconOnly: true }` is an icon alone (`.segmented__option--icon`). Its `label` becomes its `aria-label`, and its `title` is the tooltip. The Table | Chart switch of the Query results (main panel and every multiquery panel) is such a pair: a table icon and a chart icon. They are inline SVGs of 16 px, stroked in `currentColor`.

### Menus, pickers and dropdowns: `menu` (`app_ui_menu.js`)

Every popup list is an `menu` menu. These are the menus:

- The host, page and theme menus of the header.
- The Run and Copy split menus.
- The run settings.
- The Observability pickers.
- The time range panel.
- The chart and editor menus.
- The click-to-filter menus and the row context menus.

Each family keeps its look (`themeSelect`, `tracePicker`, `runMenu`...). The module owns these items:

- **Open and close**: `aria-expanded` on the button and the `themeSelect--open` / `--closing` (or `is-open`) classes of the root, with the close motion of 160 ms (`--dur-base`). One menu is open at a time. A submenu keeps its parents open.
- **Placement**: a list stays in the viewport (shifted, flipped above its button, or capped in height). A floating menu (a portal, a context menu, a submenu) mounts in the open `<dialog>` that holds its anchor. This is necessary, because the page outside a modal dialog is inert.
- **Keys**: Down / Up / Home / End move between items. A typed prefix jumps to the next matching item. Enter / Space activate. Escape closes the menu and gives the focus back to the button. Tab closes. Down / Up on the button open the list.
- **Focus**: when the user opens the list from the keyboard, the selected item (or the first) takes the focus. When the user opens it with a pointer, the list takes the focus.
- **Dismissal**: every open menu is an `layers` layer (Escape, a press outside). `layer()` pushes it. It is the one place in the module that knows the stack. `menu` moves the focus itself (`returnFocus: false`).

The entry points:

| Call | For |
|---|---|
| `bind(button, menu, options)` | an action or settings menu (`root`, `focus`, `closeOnSelect`, `canOpen`, `onOpen`, `portal`, `keys: false` for a panel with its own keys) |
| `select(selectEl, options)` | a single-choice picker over a hidden native `<select>` (the data source: `tabindex=-1`, `aria-hidden`); the button reads `<label> · <option>` from `data-field-label` |
| `multi(button, menu, options)` | a multi-select list that stays open on each pick. A `role="listbox"` menu is marked `aria-multiselectable`; a popup of check boxes and other controls is a `role="dialog"` (the MCP Usage lists), which has no such state |
| `split(main, toggle, menu)` | a split button's menu (Copy JSON / Download) |
| `context(menu, { x, y, anchor, returnFocus })` | a menu at a point or under a value |
| `submenu(item, list, { parent, onOpen })` | a nested menu: Right / Enter / click / hover open it, Left / Escape close it back on its item |

Every label sits inside the control. For example, `Status · All`, `Sort · Most recent`, `Aggregation · Rate` and `X axis · Auto`. The depth stepper of the graph reads `- Depth 1 +`. There is no outside label.

A select menu is a list of all its options. The option that is the current value stays in the list: it has `aria-selected="true"`, the selected look and a check, and the list opens on it. A menu that leaves out its current value breaks the convention of a native select (the value to go back to is not there) and no option is announced as selected. This holds for the header menus (host, page, theme) and for every picker.

### Filter bar: `filterBar` (`app_ui_filterbar.js`)

There is one filter bar for Observability (Traces, Logs, Metrics), System (Overview, Queries, Disks) and the MCP Usage page. It is a row under the tab row(s) of the page. The seven views use the same markup (`.obsFilterBar`, its rules in `20-features/observability.css`). They have the same height, the same padding (8 px 12 px) and the same gaps (8 px). They have the same controls of 31 px (`--hit` on touch screens). The parts, from left to right, are:

1. The **time range** first. It is the same picker (`timeRange` on the `.tracePicker--range` slot), 264 px. The MCP Usage bar has none: its window is a `segmented` at the right end, and its first control is **Group by**.
2. The **filters** of the view as `menu.select` pickers that read `Label · Value`. These are Status, Service, Operation and Level, and the Kind, Errors, User, Database, Table and Order by of System Queries, and the Group by of MCP Usage (an order). A **multi-select list** (`menu.multi`: `Service · All`, `Key · 3 selected`) takes the same place, with check boxes and an "All ..." action: the Service of Logs, and the Key, Method, Client, Result and Instance of MCP Usage (a dialog of check boxes, with a field that narrows a long list; a list that has fewer than two values to choose from and no pick is `disabled` with no arrow, keeps its place and says the value, `Client · claude-code`, `Instance · chdash-0`). The six pickers of the MCP Usage lead (Group by and the five lists) share a row down to 761 px (from 761 px up, its Group by and Instance list, which say the most, have a basis of 140 px and the four other lists 104 px: `mcp.css`). Then the free-text fields and options follow (the Traces Tag and Results, the Logs and Metrics searches). Then the **toggle chips** follow (`.obsFilterBar__chip`, `aria-pressed`: Hide ChDash of System Queries).
3. At the **right end**:
   - The secondary actions (`.obsFilterBar__secondary`: Add panel of Metrics). No bar has a live or auto-refresh toggle, because nothing refreshes on a timer.
   - Then **the action** (`.obsFilterBar__submit`, the submit of the form). In Observability, it is the primary **Search** (its queries run on demand). In System and MCP Usage, it is the refresh icon button (`--icon`, a square of the height of the bar). A System filter applies on change, and so does an MCP Usage one (the picks of a multi-select list wait for the clicks to pause).

The lead (range and pickers) and the tail (the rest; on MCP Usage, the window and Refresh) share one row above 1100 px. They take one row each down to 761 px. In this way, System Queries keeps Database, Table and Order by in its tail. With six pickers and a chip, its bar (`.obsFilterBar--wide`) takes the two rows from 1279 px down. The MCP Usage bar has six pickers too, and keeps one row down to 1101 px: no word of it is cut there, since its Group by and Instance list have more room than its four other lists. Below 761 px, they wrap: the range alone on its row, the pickers two in a row.

At 600 px and below, the bar folds into its summary line (`.foldSummary`, "<range> · N filters"; a bar with no time range gives its own text with `filterBar.mountSummary(form, { describe })`: "Last 7 days · by method · 2 filters" on MCP Usage). The summary line unfolds it. The action folds it again (Touch and phones). The count N includes these items:

- The pickers that are not on "All".
- The filled fields.
- The chips that are out of their default state, and the chips row under the bar.

An order is not a filter.

Observability ships its bars in `observability.html` and mounts the summary (`filterBar.mountSummary(form)`). `filterBar.create({ id, className, dataset, hidden, onSubmit })` builds a bar. In System, `app_system_view.js` gives each section its bar between the tab row and the panel. The `sectionBar` of the kit fills it. These calls add its parts, in that order: `range(idPrefix)`, `field(select, { narrow, summary, tail })`, `chip({ id, label, pressed, onChange })`, `toggle(...)` and `iconAction({ id, label, icon })`. In MCP Usage, `app_mcp_bar.js` builds the bar, puts its own parts in the lead and the tail (`bar.lead`, `bar.tail`, `bar.actions`) and `app_mcp_overview.js` places it under the nav row, with its chips right after it (`filterBar.mountSummary(form, { describe })` counts them). The module is listed only on the pages that build a bar, so its rules ship there.

### Form kit: `.uiForm` (`css/10-components/form.css`)

A dialog form, a settings block or a form in a pane uses one kit. The Query library (its Save and Edit form in the preview pane, and its Move prompt) and the MCP key form use it.

- `.uiForm` is a grid of fields.
- `.uiField` is one field. It can be a `<label>`, a `<div>` or a `<fieldset>`. Its parts are `.uiField__label` (a `<label>` or a `<legend>`), the controls, `.uiField__hint` and `.uiField__error`. A field that is a group of controls (check boxes, a radio set) is a `<fieldset>`.
- `.uiField__row` holds a control and a button on one line (a read-only value and its Copy button).
- `.uiInput` is the text control: an `input`, a `textarea` (`.uiInput--area`) or a `select`. `.uiInput--mono` sets the mono font. `aria-invalid="true"` draws the error border.
- `.uiChecks` holds `.uiCheck` rows. A `.uiCheck` is a `<label>` with a check box or a radio, then `.uiCheck__text` (`.uiCheck__label` and `.uiCheck__note`).

## Page infrastructure

There is one way to do each of these. `tests/harness/test_frontend_code_rules.py` fails on a local copy.

- **Modules**: every script of `src/static/app_*.js` is an ES module. It imports what it needs (`import { format } from "./app_format.js";`) and exports its API by name (`export const format = ...`). The import names the sibling file exactly. There is no bundler. A page is its entry module, `app_page_<page>.js`: it imports `app_common.js` (the foundations and the components that every page uses, in the order they need), the modules of the page, and `app_boot.js`. The browser loads the modules that the entry imports in dependency order. Nothing else lists them. `src/static/modules.json` holds the entry of each page and its lazy groups (see below).
  - **Rules** (`python3 tools/module_graph.py`, run by `tools/build_page_css.py --check` and the harness): an import has the exact name `./app_x.js`. The imports have no cycle. Every script is on a page. A lazy module is not imported by the page that loads it lazily. No module but `app_loader.js` calls `import()` (the Worker script does too), and no module but `app_loader.js` reads or writes `window.ChDash`.
  - **Lazy groups**: a group is a list of modules that load on first use: the query library, the chart engine, the highlighter, a WebAssembly adapter. `loader.loadGroup(name)` (`app_loader.js`) returns a promise of the exports of the modules of the group, or `{}` for a group that the page does not have. A page keeps its path without the group in that case. A group that failed to load is tried again at the next use, under another address.
  - **A collaborator that only some pages have** is handed over by the entry of the page to the module that needs it: `explorer.use({ graph, storage, detail, results })`, `results.use({ queryChart })`, `traceSearch.use({ facetPanel, traceHeatmap, traceSpans, traceTabs })`. The module does not import it. In this way the Functions page does not carry the graph, and the trace page does not carry the search page.
  - **The shell** (`tools/page_shells.py` writes it, `tools/build_page_css.py` runs that) adds the entry as a module script (so that the `load` event of the page waits for the page's modules), preloads its modules with `modulepreload`, and puts the page description (`{ name, entry, files, lazy }`) into the `chdashModules` JSON block. The inline start script has a hash in the CSP of the shell. When the entry fails to load or to start, the page shows an error banner (`window.__chdashFatal`).
  - **The handle**: `window.ChDash` holds every export of every module of the page by name (`ChDash.format`). The browser tests and the console read it. No module reads it. Each entry has a generated region (`// handle:start` to `// handle:end`, written by `tools/build_page_css.py`) with `import * as` of every module of the page and one `loader.expose([...])` call. It runs when the entry runs, so the handle is complete before the `load` event. Do not edit the region. `tools/module_graph.py` fails when it is stale. A lazy group adds its exports when it loads.
  - **Files that are not imports** (a WebAssembly file, the Worker, a lazy module) get their address from `assetUrl` (`app_assets.js`, `loader.url`). The embedded build gives each address a `?v=<hash>` and writes the hash of the imported module into each import (`tools/stage_static.py`, see CONTRIBUTING.md).
  - **Tests**: the Node unit tests of the harness load the real modules with `tests/harness/esm_vm.js` (a `vm` context; `node --experimental-vm-modules`). It stubs the imports that a test does not need.
  - After you edit `modules.json`, an import or the header partial `src/shell/header.html`, run `python3 tools/build_page_css.py`. It writes the `shell:header` and `shell:scripts` regions of the shells. Then it writes the page stylesheets.
- **States** (`uiState`, `app_ui_state.js`): `empty`, `error` and `loading` blocks (and `emptyHtml` / `errorHtml` / `loadingHtml`, `block`). A block has a title, a sentence and actions. The actions are a way out: Zoom out, Clear filters, jump to data. An error has Retry. A loading block is a spinner and its `label` ("Loading…" without one), whichever function builds it. The module also has these items:
  - `banner`: the error strip, role alert, Retry. `verbatim` is for a server message. `level: "info"` is a neutral notice and `level: "warn"` a warning (the warning tint, the text colour): both are role status and wait their turn. A warning says that something is wrong and the view still works: the MCP Usage instance whose file is left out of the sum. `inset` boxes either of them inside a padded view.
  - `busy(el, on)`: `is-loading`, `aria-busy`, the spinner of a button.
  - `announce(text)`: the one polite live region.

  No pane is `aria-live`, and no module or shell marks a region of its own: `#uiLiveStatus` is the only element with `aria-live` (`test_only_the_announce_region_is_live_and_hover_tooltips_are_not_status` in `test_frontend_code_rules.py` and `live-region.spec.js` check it). A widget says its event through `announce`: the node that the keyboard reached on a graph, the cell or box on the trace heatmap, the range of the pipeline viewer after a control moved it, the month and the step of the time range calendar, the result of a Logs search or of a Metrics catalog load, the note of the MCP host choice and the list of the data that a key reads. A status that changes with every key typed or every row loaded (the Logs status line, the Metrics summary) is not announced each time. Hover readouts are `role="tooltip"`. Lists and trees (the Explorer tree, the query library) use `compact` blocks. A search that finds nothing offers "Clear the search". A refresh button is `busy` while it reloads.
- **Feature flags** (`features`, `app_state.js`): `get(path, fallback)`, `known()`, `ready`, `on(fn)`. `FEATURE_DEFAULTS` is the table of defaults of the server (`server.hpp`). `fallback` applies only before `/api/version` answers.
- **Requests** (`app_api.js`): every route is a named endpoint there (`api.searchTraceSpans`, `api.getMetricsSeries`...). No module builds an `api/...` URL. The exceptions are the hosts `EventSource` and the REST adapter of the query library.
  - Every call goes through `request()` and takes a last `{ signal }`.
  - `request(path, { method, body, headers, signal, timeoutMs })` adds request headers (the `If-Match` of the query library). **Every request ends**: after `timeoutMs` (30 s; the analysis and the export handshake take 120 s) it fails with `code: "timeout"`. A timeout is not an abort (`util.isAbort` is false), and it does not turn the online flag off.
  - An HTTP error carries `.status` and `.body` (the answer as sent). The status is read before the body: an HTML page of a proxy (404, 413, 502, 504) is an error with its status and `.body.text`, never `invalid_api_response`. The online flag follows what answered: a 5xx with no JSON of its own (a proxy in front of a stopped server) is offline.
  - `util.latest(key)` aborts the previous request for `key`. Check `isCurrent()` before you use an answer or show an error. `util.latest.cancel(key)` and `util.latest.cancelPrefix(prefix)` stop what a view that left, a changed host or an invalid range makes useless. The Explorer (`explorer.*`), System (`system.*`), MCP (`mcp.*`), Traces (`traces.*`), Logs (`logs.*`) and Metrics (`metrics.*`) pages use them: a host change aborts every read of the old host at once, a forced Refresh replaces the read in flight, and a superseded answer never touches the shared flags (loading, busy) of the newer one.
- **Error messages**: `util.errorText(error, fallback)` is the one way to turn an error into the sentence for the reader. It returns the message of the server without its `error_code: ` prefix (the code stays on `error.code`). For a network failure or an answer that is not JSON, it returns a sentence. Otherwise, it returns `fallback`. An `uiState.banner` that gets an Error shows it.
  - The ClickHouse errors of the Query result go through `util.queryErrorParts(message, where)`. They have no code prefix and no `DB::Exception` / `(version …)` / formatQuery wrapper.
  - A syntax error reads "Syntax error, line L col C near X".
  - The "Expected one of" list of the parser is behind a closed toggle (`banner({ details, detailsLabel })`).
  - `getErrorText()` keeps the message as sent for the history and the downloads.
- **Storage** (`storage.pref(key, fallback, options)`, `storage.KEYS`): it never throws. The type of the fallback keeps the stored format of the key.
  - The query History is in IndexedDB (`history`, `app_history.js`, see [Query library](query-library.md)). localStorage keeps the preferences, the browser library and a cache.
  - The metadata catalogue of localStorage keeps two hosts at most (`storage.touchMetaHost`), is stored compact, and is dropped first when the browser refuses a write of user data (`storage.freeMetaSpace`).
  - `features.set()` sends `chdash:features-changed` itself (the flags are its detail). `features.get()` returns a copy. `features.ready` resolves once `/api/version` has answered or failed.
- **Search fields** (`search.bind`, `search.within`): there is one delay, `util.SEARCH_DEBOUNCE_MS` (200 ms). Enter and Escape apply at once. There is one look, `.uiSearch` (`--compact` in dense bars; 30 px and full width as the `.uiSide__search` of a side panel).
- **Timing helpers**: `util.debounce(fn, ms)` (`.cancel`, `.flush`), `util.rafOnce(fn)`. **Escaping**: `util.escapeHtml` only.

## Routes

`router` (`src/static/app_router.js`, imported by `app_common.js` right after `app_dom.js`) owns the address bar and the session history. No other script calls `history.pushState`, `replaceState`, `back` or `go`, or listens to `popstate`. `tests/harness/test_frontend_code_rules.py` fails on a copy.

- **Reading**: `router.current()` gives `{ path, params, hash, state }` (`path` without the base path, `params` a copy). `router.url(path)` adds the base path. `router.path(pathname)` removes it. `router.href()` is the current address.
- **Writing**: `router.push(update, opts)` and `router.replace(update, opts)`.
  - An object update merges into the params. It drops a parameter that is set to `null`, `""` or `[]`.
  - A `URLSearchParams` or a string is the whole query.
  - A function mutates a copy.
  - `opts.path` / `opts.href` change the address. `opts.state` adds the entry state of the owner.
  - A push of the current address replaces it. A write that changes nothing is a no-op.
  - The one option name of page navigation functions is `history: "push" | "replace" | "none"`.
- **History state**: one shape, `{ chdash: 1, view, ...owner state }`. `view` is `query`, `explorer`, `system`, `traces`, `logs`, `metrics` or `mcpusage`. The MCP Keys page has no address state and writes no entry. The MCP Usage tab writes its window, its group and its filters (`?window=&group=&key=&method=&client=&instance=&result=&type=`, repeated once for each value). The owner state is the `detail` / `detailOf` of a panel, or the `searchBack` of a trace.
- **Owners**: `router.owner(name, { view, path, params })` is the handle that a view writes with. It writes only while its `lifecycle` scope shows (`view: null` always, a function decides otherwise). For this reason, a hidden Explorer mode never writes the URL. The Observability pages never hide their view, so their owners always write. `path` and `params()` are the address and the whole state of the owner. They are the base of every write. The Observability page opens the scope of a view before the `init()` of its module.
- **Panels**: `router.panel(name)` (or `owner.panel(name)`) is the parameter of a detail panel:
  - `open(value)` pushes an entry (it replaces when another value is open).
  - `move(value)` replaces (next / previous).
  - `close()` goes Back when the entry is the own entry of the panel (pushed by `open` over the same address). Otherwise, it replaces without the parameter.
- **Back / Forward**: `router.on(prefix | RegExp | fn, handler)` runs the handlers that match the new entry, in order. They run from the one popstate listener of the page (`router.debug().popstateListeners` is 1). These are the handlers:
  - The Observability controller (`/observability`).
  - The trace page controller (`/observability/traces/<traceId>`, a page of its own).
  - The Explorer (`/explorer/catalog`, `/explorer/functions`).
  - The System page controller (`/system`).
  - The query shape page controller (`/system/queries/<hash>`, a page of its own).
  - The MCP Usage tab (`/mcp-integration/usage`).
  - The row details of the Query result (every path).

**Vocabulary.** The path names where you are: the page, the view and the entity (`/explorer/catalog/<db>/<object>`, `/explorer/functions/<name>`, `/observability/traces/<traceId>`). The two Explorer prefixes, `catalog` and `functions`, are fixed. For this reason, no database name hides a page. `?tab=` names the sub-view of what the path shows (one for each address, the default tab has none). `?mode=` is another presentation of the same scope (Explorer Graph / Storage, the Traces Spans results). A detail panel has one parameter. The values are the labels that the UI shows, in lower case (`graph=lineage`, `tab=flamegraph`). A former name is a read-only alias: the page reads it and rewrites the address with replace on load.

| Route | Parameters |
| --- | --- |
| `/query` (and `/`) | `?saved=<id>` the library query in the editor, else `?sql=<text>` of the last run (up to 4,000 characters); replaced, never pushed |
| `/explorer/catalog` | the Catalog root (a treemap of the databases, the databases overview); `?mode=graph` as below |
| `/explorer/catalog/<db>` | Browse: the database page (its objects, then its storage; no tabs) |
| `/explorer/catalog/<db>/<object>` | Browse: `?tab=columns\|preview\|storage\|operations\|lineage\|ddl` (none for Columns) |
| `/explorer/catalog[/<db>[/<object>]]?mode=graph` | `?graph=lineage\|storage`, `?depth=0..8` (lineage) |
| `/explorer/functions[/<name>]` | Functions, the selected function |
| `/system[/<section>]` | System (`docs/system.md`): Overview without a section (`?from=&to=`, the performance range in the Observability range format), `queries` (`?from=&to=&sort=&kind=&errors=&user=&database=&table=&hide=0`), `disks` (`?from=&to=`, the growth window); an unknown section, or one the configuration does not offer, falls back to Overview (replaced) |
| `/system/queries/<hash>` | One query shape, its own page (`shape.html`, no section tabs): `?from=&to=`, `runs=latest\|memory` and the list's parameters it was opened from (`/system/queries?q=<hash>` is a `302` to it) |
| `/mcp-integration` | The MCP integration page, Keys (`mcp.html`, `docs/mcp-integration-page.md`): the endpoint and the access keys. No parameters. It is in the page switcher only when `features.mcp.enabled` is true |
| `/mcp-integration/usage` | The MCP Usage page (`mcpusage.html`, "The Usage tab" of `docs/mcp-integration-page.md`): what all the keys did. `?window=1h\|6h\|24h\|7d\|30d\|90d\|365d` (the windows that the server keeps; the default one has none), `?group=key\|method\|client\|result` (`method` has none), and the filters `key`, `method`, `client`, `instance`, `result` and `type`, each repeated once for each value (20 at most). An address that has a value that cannot be used is replaced with the fixed one on load |
| `/observability` | the first enabled view, its parameters kept |
| `/observability/<anything else>` | An address that has no page (a name that is not a view, a view that is turned off) is a `302` to the first enabled view with the query string kept and `?redirected_from=<the path asked for>` added. `boot()` takes the parameter off the address (`router.replace`) before the page reads it, and shows the notice of `app_route_notice.js` once the page started: an info strip (`#routeNotice`, `role="status"`, Dismiss) above the page, "/observability/nope is not a page of this server. Traces is shown instead." `/system/<unknown section>` does the same to the Overview. The bare `/observability` and the former `/explorer` addresses are moves and carry no mark |
| `/observability/traces` | the search: `from`, `to`, `status`, `service`, `operation`, `tag`, `tag_not`, `tag_exists`, `tag_missing`, `service_not`, `operation_not`, `status_not`, `min_duration_ms`, `max_duration_ms`, `limit`, `sort`, `results=table`, `duration_view=heatmap`; `?mode=spans` with `kind`, `span_min_duration_ms`, `span_max_duration_ms` and the panel's `span=`; `?tab=services` with `svc=` (panel) and `svc_sort`; `?tab=map` with `node=` (panel) |
| `/observability/traces/<traceId>` | One trace, its own page (`trace.html`, no Observability tabs): `span=` the focused span, `?tab=graph\|statistics\|spans\|flamegraph` (none for the timeline), then the search context it was opened from (the filters, not the search page's tab) |
| `/observability/logs` | `from`, `to`, `service`, `level`, `sev`, `q`, `attr`, `trace_id`, `cols`, `denoise=1`, `?tab=patterns`, `log=` (panel) |
| `/observability/metrics` | `from`, `to`, the first panel's `service`, `metric`, `kind`, `agg`, `group_by`, `filter`, `filter_not`, `exemplars=0`, one `panel=` per other panel (its own parameters, encoded) and `active` |

`from` and `to` are named once. `timeRange.url.read(params)` gives `{ from, to }` or `null` (the current address by default, through `router`). `url.write(params, range)` sets both or clears both. `url.has(params)` tells whether either is set. Traces, Logs, Metrics and the Observability page controller use it.

The router pushes an entry for these events: a new search or selection, a view or tab switch, an opened panel, and a trace or span opened. It replaces the entry for these events: the page-load write, a panel that moves, a sort, a column or display toggle, and an alias rewrite. Back from a trace returns to the search where the user opened it (`returnToSearch`, `state.searchBack` steps).

| Alias (read, rewritten on load) | Canonical |
| --- | --- |
| `/explorer/catalog/<db>/<object>/<tab>`, the slugs `overview` / `schema` (Columns) and `data` (Preview) | `/explorer/catalog/<db>/<object>?tab=<tab>` |
| `/explorer/catalog…?view=browse\|graph` | `/explorer/catalog…` / `?mode=graph&graph=lineage&depth=1` |
| `/explorer/_system[?database=<db>[&table=<t>]]`, `/explorer/catalog[/<db>[/<t>]]?mode=storage` (the former Storage view and mode) | `/explorer/catalog/<db>/<t>?tab=storage`, `/explorer/catalog/<db>` (its storage scrolled into view), `/explorer/catalog` at the root |
| `/explorer/catalog/<db>?tab=storage\|objects` (the former database card tabs) | `/explorer/catalog/<db>` (the storage scrolled into view for the first) |
| `/observability/traces/<traceId>?view=<tab>` (and a search `tab=` there) | `?tab=<tab>` |
| `/observability/traces?results=spans` | `?mode=spans` |

The server answers the former Explorer addresses with a `302` (a relative `Location`, the query string kept). It is not an alias that the page rewrites:

- `/explorer` and `/explorer/databases` go to `/explorer/catalog`.
- `/explorer/<db>[/<object>[/<tab>]]` goes to `/explorer/catalog/<db>[/<object>[/<tab>]]`.
- `/explorer/_functions[/<name>]` goes to `/explorer/functions[/<name>]`.

The former Monitoring tab and the former Server operations view of the Explorer moved to the System page. The server answers them with a `302` (not an alias that the page rewrites), and it keeps the query string:

- `/explorer/_monitoring` to `/system`.
- `/explorer/_monitoring/queries` and `/explorer/_monitoring/disks` to `/system/queries` and `/system/disks`.
- `/explorer/_monitoring/performance` to `/system#performance`.
- `/explorer/_monitoring/activity` and `/explorer/_operations` to `/system#activity` (the hash scrolls the Overview to that part once).

With `system.enabled = false`, they open the Explorer Catalog (`/explorer/catalog`).

## Data display components

There are seven modules. They load on every page (`app_common.js` imports them after `app_util.js`). Each has one file in `src/static/css/10-components/` (`table`, `badge`, `copy`, `sql`, `kv`, `stat`, `chart`). `tests/harness/test_frontend_code_rules.py` fails when a local copy comes back.

| Module | API | What it draws |
| --- | --- | --- |
| `app_ui_table.js` | `table.sortHeader(th, {key, dir, onSort})`, `sortHeadHtml`, `bindSort`, `setSort`, `cellBar(td, percent)`, `cellBarStyle`, `shareBar(el, percent, text)` / `shareBarHtml` (a share's figure beside a bar on its own track, never under the text: Logs patterns, Explorer Storage list), `barEligible({name, min})`, `copyCellHtml` / `copyCell`, `rowHeight(density)`, `ns.rovingRows(container, options)` | `<table class="dataTable">`: 12 px / 600 muted sentence-case headers on `--thead-bg`, sticky. Rows are `--row-regular` (32 px) or `.dataTable--compact` (`--row-compact`, 26 px). `.num` (right, tabular, not mono). `.mono` for ids only. `tr.is-selected` (accent bar and `--row-hover`). `.dataTable__rowNum` (results, previews). One sort glyph from `aria-sort`, idle on hover only. `.dataList` gives virtual div grids (spans, Logs) the same tokens. `.cellBar` is the one in-cell bar. It is never on identifier or signed columns, except in Query results. There, every numeric value has one, from the lowest value of the column (`(v - min) / (max - min)`), drawn once the stream has ended. A table that can be narrower than its columns (the span table beside the docked span panel) drops its columns of lowest priority. It does not clip them. A table with columns that matter less names them: a header and its cells carry `.is-low` (hidden from 1279 px down), `.is-mid` (from 820 px) or `.is-xs` (from 600 px), and `createStaticResultTable({ priorities: [...] })` and a `priority` of a spec of the Explorer tables set them. The Explorer databases overview, the objects of a database and the Columns, Storage, partitions, indexes and projections tables use it. System Queries and Disks use the same classes. So do the Activity tables of the System Overview (a header takes a `priority`), the Services table of Traces (the two trends from 1279 px, P50 from 820 px) and the keys table of the MCP page (Tools, Data and Limits from 820 px: the details of a key show them, and the phone card keeps every field). What stays fits, and the box scrolls sideways for the rest with its edge cues (UI-130). |
| `app_ui_badge.js` | `badge.html(text, {tone, size, shape, solid, color, swatch})`, `el`, `statusLabel` (`OK`, `Error`, `Unset`) / `statusHtml` (an Error chip, OK text, Unset nothing), `severityHtml` (ERROR / FATAL chips, other levels text), `chipHtml`, `clearHtml`, `swatchHtml` | `.badge`: `sm` 18 px / `md` 22 px, r4 or `pill`. Tones: neutral, accent, ok, warn, error, category (`--badge-color`), estimate, key. `.badge--solid` counts. `.chips` / `.chip` filter chips (a `role="list"`: the "Clear filters" button, `clearHtml`, stands beside the list, not in it). `.serviceSwatch` (dot) and `.serviceSwatch--bar` (rows, chips). |
| `app_ui_copy.js` | `copy.text(text, control)`, `copyButton(button, getText)`, `copyButtonHtml`, `copySplit({root, getText, items})`, `downloadText(name, text)` | One clipboard path and one feedback: `.is-copied` for 1.2 s. A text button reads "Copied". An icon button shows the check and an announced `popover.flash` tip. The Query, trace and Logs "Copy JSON" splits. The split menu is an `menu.split`. |
| `app_ui_sql.js` | `sqlBlock({sql, gutter, copy, maxLines, expand, inline, wrap})`, `sqlBlockHtml` + `sqlBind(root)` (the inline toggle of string-built blocks) | Read-only SQL on the highlighter of the editor (loaded on demand where the page lacks it): DDL, graph panel SELECT, Services statements (inline, click to expand), mutation commands, library preview. |
| `app_ui_kv.js` | `kv.list(rows, {actions})`, `kvListHtml`, `kvBind(root, {onAction})` | Key / value lists with one value palette (`--json-*`), JSON trees, and include / exclude / only / copy / json actions: span, resource, link and log attributes, Logs fields, Query row Details, graph panel columns. |
| `app_ui_stat.js` | `stat.html({label, value, sub, tone, dl})`, `statTile`, `statTilesHtml` | `.statTile` (eyebrow, value, sub), sentence case; `.statTiles--boxed`, `.statTile--sm`. |
| `app_ui_chart.js` | `chartUi.cardHtml({title, meta, actions, body})`, `chartUi.sparkline.html(values, opts)` / `draw(el, values, opts)` | `.chartCard` (head: title, meta, actions; body), `.sparkline` (`--sparkline-color`). |

The chart engine (`app_chart_core.js`) draws at most once for each animation frame:

- `setData` / `update` schedule the draw (several calls in a frame cost one).
- A zoom gesture or a legend click draws at once.
- `layout()`, `stats()`, `points()`, `toClient()` and `flush()` draw a pending change first.
- `setData({ append: true, ... })` says that the arrays only grew at their end (streamed rows). The block summaries of a long series (min, max, sum and count for each 64 points, from 16,384 points) then grow. They are not computed again. For this reason, extents, the legend values and decimation read whole blocks.
- Past two points for each pixel, a line is drawn for each device-pixel column. A column whose values span more than 2 px is one pixel-aligned rect from its highest value to its lowest value. Runs of flatter columns are one stroked line. A stroke through the first, low, high and last value of every column cost 100 ms and more of rasterization for each frame.
- `chartCore.counters()` and `queryChart.counters()` count the work done since `resetCounters()`, for the budget tests. They count draws, layout reads, decimations, legend rebuilds, model builds, rows parsed and bytes allocated.

**Chart details.** The Query chart's settings sit in a panel on the left of the chart, exactly as tall as the plot and its legend (it scrolls inside if it is longer), folded to a rail by its button (`chdash.chart.details`). It has the chart type (Line, Area, Bars, Points, Number); the columns (X axis, Y values, Split by); the graph styles, as in Grafana (interpolation: Linear, Smooth, Step before, Step after; missing values: Gap, Connect, Zero; line width; fill opacity; show points; point size; stack: Normal, Off, 100%); and Y min and Y max. A row that does not apply to the chart type is hidden (`data-for`), and a Number has only the type. Each choice is a key of the chart's `cfg` (kept with the columns for the next result of the same shape) and an option of the engine (`interpolation`, `lineWidth`, `fillOpacity`, `showPoints`, `pointSize`, `stackMode`, `yBounds`). The labels sit inside the controls, like every picker.

The Query chart works only while the user can see it (the Chart view, an expanded panel, a visible tab). It is drawn once, when the stream has ended (finished, canceled or failed: the rows received). While rows stream in, its area only reads "Streaming… n rows". It then parses 240,000 values for each model build. It builds for 40 ms for each frame. It resumes its x scan where the previous build stopped. It draws once every row is parsed. Its types (Line, Area, Bars, Number) are icon options. They are named by aria-label and described by their title, like the Table | Chart switch.

The chart engine shows its legend when a chart has more than one series (`legend: "always"` for one, `false` for none). It has a `legend: "totals"` mode (each total of a series; `onLegendClick`, `legendPressed`). It reads a bucketed time axis through `bucketMs` (`bucketAlign: "center"` for bucket middles) as `format.range`.

**The legend** is one component for every chart (the Query result chart, System, Metrics, the MCP Usage charts). It is a compact list of the series, a swatch and a name, and its button **Values** turns it into a table with the columns **Total**, **Min**, **Max**, **Mean** and **Last** of each series over the range that the plot shows (a zoom changes them); **List** turns it back. The mode is a preference (`chdash.chart.legendMode`, `list` by default), which every chart starts with. A click on an entry shows only this series (again: shows all), and Ctrl / Cmd+click shows or hides it (`legendClick: "toggle"`: a click shows or hides it, Alt / Ctrl / Cmd+click shows only it). These options shape it:

- `legendColumns: ["min", "max", "mean", "last"]` keeps some of the columns, in the order of the table. A chart whose values do not add up (an average, a rate) leaves the Total out.
- `series[].weights` is one number for each point. The Mean of the series is then the mean of its values weighted by them: the legend of an average of call times weights each step by its calls, so the Mean is the average of all the calls and not the average of the averages (a rate of errors weights each step by its requests). The Min, the Max and the Last stay those of the points.
- `series[].stats` are the values that the table reads when the plot does not draw all of them. A stack of counts leaves its zeros out (a zero is no bar, and no tooltip row), but the Min and the Mean of its series count them.
- `legendFormat(value, column, series)` writes a cell of the table. The default is `formatValue` of the chart (a mean of counts needs decimals that a count does not have).
- `legendClick: "filter"` makes the click the host's. `onLegendClick(series, event)` is called (a filter, say) and nothing is hidden. `legendPressed(series)` says which entries are on (`aria-pressed`; the others dim, `is-off`, while some are on), `legendDisabled(series)` locks an entry that is no filter (a disabled button, no `aria-pressed`) and `legendTitle(series, pressed)` writes its title. The MCP Usage charts use it, and the click works the same in the list and in the table.
- `onLegendMode(mode)` is called when the legend goes to `list` or `table` (by its button, or with the other charts of its alignment group). `chart.legendMode()` and `chart.setLegendMode(mode)` read and set it, and `chartCore.legendMode()` is the preference.

**Alignment groups.** Charts that are read together (the cards of a grid, or one under the other) read better when their grid lines are on the same lines. A chart that is made with `alignKey: "<group>"` joins the group of that name, and the charts of a group:

- have **the same number of intervals** on the y axis, which the height of the plot gives (`floor(plotH / 34)`: at least 2, at most 10; four for the 156 px plots of the MCP Usage charts), and a domain of **[0 or the minimum, that many steps]**. The step is the first of the sequence of the kind of the axis (`yKind`) that reaches the largest value, so charts whose plots are as high have their horizontal grid lines at the same heights and only the scale differs. `"number"` (the default) steps by 1, 2, 2.5, 5 x 10^n, with the units K, M, B and T (or the `yUnit` of the chart); `yInteger: true` keeps the steps whole (1, 2, 3, 5, 10, 20, 25, 50...: a count). `"bytes"` steps the same in the largest unit of 1024 that the data reaches (0.5 MB, 1 MB, 1.5 MB...; B steps are whole). `"duration"` is for values in milliseconds: 1, 2, 2.5, 5 x 10^n ms up to a second, then the clock (1, 2, 5, 10, 15, 30 s; the same in minutes; 1, 2, 3, 6, 12 h), then whole days, and the unit of the ticks is the one of the step. `"percent"` is for values in percent: 1, 2, 2.5, 5 x 10^n with a % suffix (0.25%, 1%, 25%), and when the data does not pass 100 the domain stops at 100: the intervals are then 100 / their number (25 each for four), and a step that is not a nice one (33.3 for three) is written with one decimal. The pure function is `chartCore.alignedAxis(kind, lo, hi, intervals, { whole, unitOf })`. A chart that has `yBounds`, `yScale: "log"` or a `yAxis` function keeps its own axis (it still shares the gutter).
- share **one gutter** at the left of the plot with the charts of the group that have the same x scale (the same x kind, the same domain and the same plot width): it is the widest of their y labels, so their vertical grid lines are at the same x.
- share **the legend mode**: List / Values on one chart switches the group.

It is worked out in one pass and never fed back: the steps come from the data of the visible range and the number of intervals, the labels from the steps, the gutter from the labels, and the x ticks from the plot that is left. The layout is read only when the chart is resized and when its data change, never on a frame. A chart that changes (data, zoom, hidden series, theme, size) tells the others of its group, and one whose gutter is not the one it drew with draws again, once. The first draw of a chart of a group waits for the next frame, so that charts made one after the other are drawn with the gutter of all of them; `flush()` (and `layout()`, `stats()`) draws it at once. `alignKey` is set when the chart is made, like `syncKey` (which moves the cursor and the zoom together and can have the same name). `data-align` and `data-y-step` on the chart root say the group and the step. A page opts in with `alignKey` and, where the axis is not a plain number, `yKind`; the MCP Usage charts do (`app_mcp_charts.js`), the System and Metrics charts do not yet.

A line breaks where data is missing. A NULL breaks it (`nulls`). A time axis whose points sit on one regular step (most spacings are equal) also breaks it where a spacing is wider than 1.5 steps: a stop of the data (an hour with no row) does not read as a trend. An irregular axis (event times, months) never breaks. `connectGaps: true` joins the points again, and `chart.gaps()` counts the gaps. In the Query chart, Chart details has Missing values: Gap (the default), Connect (`connectGaps`) and Zero, which reads the rows a series misses and its NULLs as 0 and adds the steps of a regular time axis that have no row at all (up to 500,000). `chart.gaps()` is also published as `data-gaps`.

A time axis reads browser-local 24 h time on calendar-aligned ticks (`timeTicks`). It uses the smallest step whose labels keep apart. A date line is under them (`layoutXLabels`), as Grafana does. These rules apply:

- The date is under clock times. The year is under days and months. They are on the first label and where it changes.
- The year is only on the first date and where the year changes ("Oct 2 2026", then "Oct 3" under 00:00).
- The chart measures labels and date lines at the fonts that it draws them in. The caches are dropped with the theme (the `textMeasures` counter counts the texts measured).
- Labels never touch. A label that is too close to the one before is skipped. A date that is too close to the one before skips its label and waits for the next one. The exception is the date of the first label. It gives way to the change itself ("Oct 3 2026" under 00:00).
- `data-x-ticks` on the chart root lists each label drawn as `[label, date, left, right, date left, date right]`.

The chart canvas takes its colors from the theme tokens: the panel (`--panel`), the text and its hairline grid of 9 %, and the muted axis and labels. It has no color literal of its own.

### Query result tables: `app_results*.js`

The result of a query is made of modules that each do one thing:

| Module | Holds |
| --- | --- |
| `app_results_values.js` | The values, with no page behind them: the lossless JSON parse, the text of a value, the serializer (`serialize`), the column types, the flattening of a tuple and the figures of a numeric column |
| `app_results_cells.js` | A value as a table cell (text, the NULL token, coloured JSON) and the bar of a numeric cell |
| `app_results_sort.js` | The numeric and the text sort of the rows, and the `rowsort` kernel |
| `app_results_rowdetails.js` | The row menu, the row details under a row, the keyboard rows and the links to traces |
| `app_results_table.js` | `createLiveTable({ wrap, host })`: the one live table |
| `app_results_static.js` | The table of an answer that is complete (the Explorer previews) |
| `app_results.js` | The panel of the Query result: its status, its error, its Copy buttons, and the blocks of a batch |

There is one table implementation. The result of a query and each statement of a batch call `createLiveTable`. The panel gives the table four hooks (`visible`, `metaChanged`, `rowsChanged`, `rendered`) and nothing else. A change of the table (the sort, the virtual window, the layout of one row) applies to both. The Node tests of the value and sort modules are in `tests/frontend/model/results-values.test.cjs`.

### Size bands: `explorerTreemap.band` (`app_explorer_treemap.js`)

One component draws where the bytes are. It draws these items:

- The databases of All databases of the Explorer and of the System Overview.
- The tables of a database page.
- The databases of a disk (System Disks).
- The partitions and the columns of a table.

- **Shape**: the band is the squarified treemap at one height, `--sizemap-h` (180 px, 160 px at `--bp-md`), when its cells spread. The band is the share strip in these cases:
  - One top-level cell holds more than `DOMINANT_SHARE` (85 %) of the bytes. The strip is one bar of 24 px (`--hit` tall on touch), split by cell. The larger cells are labeled with their share.
  - Fewer than `minItems` cells of 1 % or more would show. The database page asks for three. The partition and column maps then draw nothing (`fallback: "none"`).
  - The Disks rows always use it (`strip: "always"`).

  The databases of All databases and of the System Overview are always the treemap (`strip: "never"`), for any distribution. One dominant database is a large cell beside the others. Others is a hatched strip.
- **One color rule**: a cell is the accent tint (`--accent-fill` at 22 % over the panel, an edge of 55 %), with the text color on it. An expanded database is a paler frame. No color comes from a name. Only the Columns map gives its cells a hue. It is the hue of their type family (`--qchart-N`), and its legend names them. Others (the cells under 1 %) is the panel hatched in `--hatch` (the text at 14 %). Its label is on a solid chip. It is an item of the legend with its member count and size.
- **Legend and footnote** are under the band. The legend shows the families and Others. In strip mode, it shows each segment with its size and share. It is `legend: false` when a table under the band names them (Disks). The footnote says what the band measures.
- Labels keep 4.5:1 in both themes. `ui-guards.spec.js` measures them, and the version badge of the header, over what they are drawn on.
- A database or table cell opens its card (`onOpen`). On a touch screen, the cells are as large as their share, and the table under the band holds the links.

## WebAssembly kernels

A few computations of the front end run as WebAssembly kernels (docs/wasm.md). The page code does not change its API. Each kernel has a JavaScript reference, and the page uses the reference when the kernel is not loaded.

| Module | What the kernel does | Lazy group in `modules.json` |
| --- | --- | --- |
| `app_wasm.js` (`wasm`), `app_wasm_worker.js` | Loads a kernel, and runs it in a Worker | Every `wasm-*` group |
| `app_highlight.js` | Lexes SQL texts of 2,000 characters or more | `wasm-highlight` |
| `app_autocomplete.js`, `app_sql.js`, `app_run.js` | Scans a script for the diagnostics, the cursor statement and the statement split | `wasm-sqlscan` |
| `app_query_chart.js`, `app_results_sort.js` | The chart model with x out of order, and the numeric sort of the result table | `wasm-chartprep`, `wasm-rowsort` |
| `app_palette.js` (`palette.batch`), `app_graph_kit.js` (`kit.mixColorBatch`), `app_chart_core.js` (`chartCore.colors`) | Colour arithmetic on batches of colours | `wasm-color` |
| `app_explorer_treemap.js` | Places the nodes of a treemap group | `wasm-treemap` |
| `app_graph_kit.js` | The edge router, the layered layout and the label placement | `wasm-router`, `wasm-layered`, `wasm-labels` |

`palette.batch` is not a picker. Each of its functions gives, for a list, what the matching single function gives for each item. A short list runs the single function.
