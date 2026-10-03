# UI foundations: formats, palette and colour tokens

Every page displays numbers, sizes, durations, instants and data colours
through three shared pieces:

- `ns.format` (`src/static/app_format.js`) turns values into text.
- `ns.palette` (`src/static/app_palette.js`) picks the colour of a series, a
  service, a percentile, a severity, a ramp step or a catalog object kind.
- The semantic colour tokens of `src/static/css/00-tokens.css` give every status, severity,
  accent, kind, percentile and JSON colour a name per theme.

**The rule: use these; no local formatters or hex colours.** A module that
needs a format or a colour these do not offer adds it here, with a unit
check, instead of writing its own. Component CSS and scripts name tokens
(`var(--danger)`), never hex, rgb or hsl literals.

Both modules load first, before `app_dom.js`, on every page: they lead the
`common` list of `src/static/modules.json`, the one module manifest that
`app_loader.js` (`ns.loader`), `app.js`, `app_observability.js` and
`tools/build_page_css.py` read. Both are pure apart from
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
| `palette.categorical(i)` | `var(--qchart-1)` … `var(--qchart-18)` for series slot `i` (0-based, wrapping), and `var(--qchart-other)` for a negative index (the neutral "Other" group). |
| `palette.CATEGORICAL_SLOTS` | `18` |
| `palette.service(name, {assign})` | `var(--trace-span-color-N)`, one of 18 slots: the Traces and Jaeger assignment. `--trace-span-color-N` is `var(--qchart-N)`: services and series share one palette. A service takes the next slot the first time it is seen and keeps it for the browser session, in the same `sessionStorage` key Traces uses (`chdash.traces.serviceColors`). With `assign: false`, a name not seen yet gets a stable hash slot (FNV-1a), and the view's first-seen order is not changed. Logs and Metrics use it whenever the group key is a service. |
| `palette.serviceSlot(name, {assign})` | The 0-based slot behind `service`. |
| `palette.registerServices(names)` | Assigns a view's services in name order before the view renders, so a list and its charts agree whatever order they draw in. |
| `palette.SERVICE_SLOTS` | `18` |
| `palette.quantile(p)` | `var(--pct-p50)`, `p90`, `p95` or `p99`, for `"p95"`, `"P95"`, `95` or `0.95`. Any other quantile takes the nearest of the four. |
| `palette.severity(level)` | `var(--sev-…)` for an OpenTelemetry SeverityNumber (1-4 trace, 5-8 debug, 9-12 info, 13-16 warn, 17-20 error, 21-24 fatal) or a SeverityText (`ERROR`, `warning`, `Critical`…). Unknown text reads as debug. |
| `palette.severityLevel(level)` | The level name behind `severity`: `fatal`, `error`, `warn`, `info`, `debug` or `trace`. |
| `palette.sequential(t)` | `var(--trace-heat-1)` … `var(--trace-heat-8)` for `t` in [0, 1], clamped. Low values recede into the surface. |
| `palette.kind(kind)` | `var(--kind-…)` for a catalog object kind or engine name: `view`, `MaterializedView`/`mv`, `Dictionary`/`dict`, `Buffer`, `Distributed`. Every other engine is a table. |
| `palette.errorLevel(ratio)` | `"neutral"`, `"warn"` or `"danger"` for an error ratio (errors / requests, 1 = 100 %): below 1 % neutral, 1 % up to 5 % a warning, 5 % and more danger (`palette.ERROR_RATE`, `{ warn: 0.01, danger: 0.05 }`). Every coloured error rate uses it: the service map's health dot (amber, red), red border and edges and its legend, the Services table, panel and sparklines. |
| `palette.errorColor(ratio)` | `null`, `var(--warning)` or `var(--danger)` for that level. |
| `palette.contrast(a, b)` | The WCAG contrast ratio of two colours (tokens or CSS colours, `color-mix()` included). |
| `palette.readableText(fill)` | `var(--on-fill)` (white) or `var(--on-fill-dark)` (ink), whichever contrasts more with `fill`: the label of a flamegraph frame on its service colour. |
| `palette.resolve(token)` | The colour a token computes to in the current theme, as `rgb(r, g, b)` or `rgba(r, g, b, a)`, for canvas. It accepts `"--sev-error"`, `"var(--sev-error)"` or any CSS colour. The value is read once per theme and cached. The cache is dropped when the forced theme (`html[data-theme]`) or, in System mode, the OS colour scheme changes. |

## Semantic colour tokens

They are defined in `src/static/css/00-tokens.css` (see "Stylesheets"), in each
theme context: `:root` (dark), `@media (prefers-color-scheme: light) :root`
(System on a light OS), `html[data-theme="dark"]` and
`html[data-theme="light"]`. A forced theme is always identical to the
matching OS theme (`tests/harness/test_css_tokens_contract.py`).

**Surfaces** are graphite, with no blue cast in either theme:

| Token | Dark | Light | Role |
| --- | --- | --- | --- |
| `--bg` | `#0d0f12` | `#f6f7f9` | the page |
| `--panel` | `#13161a` | `#ffffff` | panels, menus, dialogs |
| `--raised` | `#191d22` | `#ffffff` | buttons, graph cards |
| `--border` | `rgba(255, 255, 255, 0.08)` | `rgba(15, 18, 25, 0.1)` | hairlines |
| `--text` | `#e6e8eb` | `#15181d` | body text: 14.78 / 16.60 |
| `--muted` | `#959ba5` | `#5b6270` | secondary text: 6.49 / 5.72 (6.06 / 6.13 on `--raised`) |

The contrast column gives the lowest ratio on `--panel` and `--bg`. For
status text it also covers the token's own `-bg` tint over those surfaces.
Text tokens need 4.5:1 and fills (marks, icons, swatches, lines) need 3:1.

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
| `--sev-debug` | `#8b95a5` | `#556378` | 6.00 / 5.69 | grey |
| `--sev-trace` | `#7d8590` | `#66727f` | 4.86 / 4.58 | dimmer grey |
| `--accent-fill` | `#356fe6` | `#2558d9` | 3.95 / 5.64 (`--on-fill` text on it 4.60 / 6.04) | solid accent: primary buttons, selected marks, the editor's focus border |
| `--accent-fill-hover` | `#2c62d4` | `#1e49bd` | `--on-fill` text 5.52 / 7.66 | a hovered primary button |
| `--accent-tint` | `rgba(53, 111, 230, 0.16)` | `rgba(37, 88, 217, 0.1)` | surface | selected / active backgrounds |
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

The categorical slots, with their lowest contrast on `--bg`, `--panel` and
`--raised` (`--qchart-other` stays `#898781`, the neutral "Other" group):

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

The keyboard ring (`--focusRingColor`) is `#3b82f6` / `#2563eb`: 4.93 on the
dark panel, 5.17 on white. The graph accent (`--graph-halo`, a focused or
hovered card's border) is `#7c9cff` / `#2558d9`: 6.50 on a dark card, 6.04
on white.

Kind tokens are graphics (icons, swatches, card accents), so 3:1 applies.
Text in a kind colour mixes it with `--text`.

Where they come from:

- **Status and severity** reuse the former Logs `--log-sev-*`, `--exd-*` and `--graph-error`.
  The light values are darker where those failed 4.5:1, either on the
  surface or on their own tint: `--sev-warn`, `--sev-debug` and `--sev-trace`
  in light, `--sev-trace` in dark, and `--danger`, `--warning`, `--success`
  and `--info` in light.
- **Accent**: one solid fill per theme, with `--on-fill` text, for the
  primary button in both themes (no per-button light override). The design
  pass asked for `#3d7cf5` in dark; white text on it is 3.89:1, so the fill is
  `#356fe6`, the lightest step of that hue that keeps 4.5:1. Light is
  `#2558d9`. `--accentBorder` names the fill. The former `--accent` (a solid
  fill in dark, a tint in light) is gone: its callers name `--accent-fill` or
  `--accent-tint`.
- **Kinds** are the Explorer lineage icon colours: a base hue mixed into
  `--text`, resolved per theme. The Explorer tree swaps dictionary (teal) and
  buffer (amber). The tokens settle on dictionary amber and buffer teal.
- **Percentiles** are one blue-violet ramp: p50 recedes, p99 stands out.
  Each step keeps 3:1 on `--panel` (the table) and on `--bg`. The charts show
  P50 and P99 by default; P90 and P95 are one legend click away.
- **Categorical** (`--qchart-1` … `--qchart-18`): one palette for chart
  series and services. Slots 1-8 keep the Okabe-Ito order (blue, vermilion,
  bluish green, orange, reddish purple, green, violet, sky); slots 9-18 add
  hues and lightness steps chosen to stay apart (OKLab distance 0.08 or more
  between any two slots in dark, 0.095 in light). No slot is red: a red
  service or series would read as an error. Every slot keeps 3:1 on `--bg`,
  `--panel` and `--raised`: 3.81 at worst in dark, 3.55 in light (the
  table above).
- **JSON** values are the `.jsonPretty` colours (`util.highlightJsonHtml`):
  22 % of a hue (`#22c55e`, `#f59e0b`, `#a78bfa`) mixed into `--text`, and
  null 70 % `--muted` into `--text`, recomputed for the graphite `--text`.
  The `--sql*` tokens mix into `--text` at run time, so they follow it.

Aliases: `--error-bg`, `--accentText` and `--graph-error` are `var()`
references to the token with the same value in both themes. `--exd-*` keeps
its values until its callers move to the semantic tokens.

The literal colours rules used to write inline (the 33 `--c-*` tokens) are
gone: each use names a semantic token (`--on-fill`, `--success`,
`--warning`, `--danger`, `--shadow-overlay`, `--backdrop`) or one of the
few component colours `00-tokens.css` names: `--dot-ring` (the hairline
inside a status dot), `--hatch-strong` / `--hatch-weak` (the treemap's
unsized space), `--tile-outline`, `--tile-outline-strong` and
`--tile-label-shadow` (treemap tiles).

## Type, shape, motion and stacking

`tests/harness/test_type_scale_contract.py` fails on a font size, weight or
family, a radius, a blurred shadow, a transition duration or a z-index
written as a literal outside `00-tokens.css`, and on a canvas font that
leaves the families, weights or sizes below.

**Fonts.** IBM Plex Sans (400, 500, 600) and IBM Plex Mono (400, 500), the
IBM Latin-1 subsets of the official release (npm `@ibm/plex-sans` 1.1.0 and
`@ibm/plex-mono` 2.5.0, `fonts/split/woff2/*-Latin1.woff2`, unmodified), plus
the IBM "Pi" subset of Sans 400 and 500 for the arrows and comparison signs
the UI prints (`unicode-range`: fetched only by a page that shows one). They
live in `src/static/fonts/` with the SIL Open Font License 1.1
(`src/static/fonts/LICENSE.txt`, IBM's text: Plex is a Reserved Font Name,
which is why the files ship as IBM released them). 116 KB for the seven
files; a page fetches Sans 400 / 500 / 600 and Mono 400 (82 KB), Mono 500 and
the Pi faces on first use. Every face is `font-display: swap`. The server
serves them as `font/woff2` with `Cache-Control: public, max-age=604800` (a
face never changes under its file name; every other asset revalidates).
The shells preload Sans 400 and 500 and Mono 400: the generated
`<!-- shell:fonts -->` region (`FONT_PRELOADS` in `tools/page_shells.py`)
writes the links next to the stylesheet with the page's base path. Canvas
text that was measured before a face arrived (graph cards, chart axes, the
editor's character width) is measured again on `document.fonts`'
`loadingdone`.

| Token | Value |
| --- | --- |
| `--font-sans` | `"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif` |
| `--font-mono` | `"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace` |
| `--fs-xs` / `--fs-sm` / `--fs-md` / `--fs-lg` / `--fs-xl` / `--fs-2xl` | 11 / 12 / 13 / 14 / 16 / 20 px; nothing is smaller than 11 px |
| `--fs-display` | 32 px, the value of a single-number Query chart |
| `--fw-regular` / `--fw-medium` / `--fw-semibold` | 400 / 500 / 600, the faces shipped |

The canvas modules use the same families (`kit.FONT` in `app_graph_kit.js`
repeats `--font-sans`, which a canvas cannot read as `var()`), weights and
sizes. Component size tokens alias the scale: `--dt-font` is `--fs-md`,
`--dt-head-font` `--fs-sm`, `--dt-head-weight` `--fw-semibold`.

**Mono or sans.** Mono for what is read character by character: identifiers
(database, table, column and function names), ids (trace, span, query),
SQL, types, log bodies, attribute keys and values. Sans with `tabular-nums`
for every measure: durations, counts, sizes, times, axis ticks, bar labels
and percentages.

**Shape.**

| Token | Value | For |
| --- | --- | --- |
| `--r-sm` | 4 px | badges, chips' parts, marks, small bars |
| `--r-md` | 6 px | controls: buttons, inputs, pickers, segmented options |
| `--r-lg` | 8 px | cards, panels, menus, dialogs, the editor; canvas cards (`kit.CARD_RADIUS`) |
| `--r-pill` | 999 px | status badges, filter chips and scrollbar thumbs only |
| `50%` | | a dot |
| `--control-h` / `--control-h-sm` | 28 / 24 px | `.button` (13 px, 500) and `.button--small` (12 px) |

Surfaces are flat: no top sheen, no gradient on buttons. Only what opens
over the page casts a shadow, `--shadow-overlay` (menus, popovers,
tooltips, dialogs, side drawers and sheets, toasts). Inset rules, rings and
spread-only outlines draw marks, not elevation. A modal's backdrop is
`--backdrop`, `rgba(0, 0, 0, 0.5)`, without a blur. A focused graph card has a
2 px `--graph-halo` border and no ring around it. The Query editor's frame
takes an `--accent-fill` border while the caret is inside
(`.editorWrap:focus-within`), as its textarea is left out of the global
`:focus-visible` ring.

**Motion.** `--dur-quick` (120 ms) for hover and colour changes,
`--dur-base` (160 ms) for menus, panels and dialogs, one easing `--ease`
(`cubic-bezier(0.2, 0, 0, 1)`). `ns.menu`'s `CLOSE_MS` is `--dur-base`. Under
`prefers-reduced-motion: reduce` every infinite animation stops: the
autocomplete label marquee, the indeterminate progress band, the filter
bar's live dot, the host and Explorer health pulses, the running query
pulse and bar; the spinner stands still.

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
- **Signal, not decoration**: colour and chips mark what needs attention.
  - Error rates: `palette.errorLevel` (neutral below 1 %, amber 1-5 %, red
    from 5 %) on the service map (health dot, red border from 5 %, edges,
    legend), the Services table, panel and sparklines.
  - Log severities (`ns.badge.severityHtml`): ERROR is a red chip, FATAL a
    solid one; WARN is amber text (the row keeps its left bar), INFO muted
    text, DEBUG and TRACE dimmed text. A severity filter button stays a chip.
    The histogram legend reads at full strength; a severity filter dims the
    severities it leaves out.
  - Span status (`ns.badge.statusHtml`): Error is a red chip, OK muted text,
    Unset nothing (a key / value fact shows `format.EMPTY`).
  - Waterfall rows: the child count is plain text (`+N` once collapsed); the
    http method, status and db / rpc / messaging system are muted mono text;
    an http status of 400 or more is a chip (amber 4xx, red 5xx); a span's log
    count is a chip only with an ERROR or FATAL log.
  - Metric kinds and units, Explorer keys (ORDER BY, PARTITION...) are muted
    text, without a coloured fill. Engines read as ClickHouse names them
    (`MergeTree`, `ReplicatedMergeTree`, `MaterializedView`).
  - Charts: bars 78 % opaque with a 1 px gap, errors stacked in red; lines
    1.25-1.5 px; P50 and P99 by default; past one exemplar per 40 px, each
    column keeps its highest. The Services sparklines are a neutral line and
    light area bound to the data, with their peak printed beside them; only
    anomalies are coloured, three per row at most (a bucket at the error
    thresholds with two errors or more, a P95 above twice the row's
    median).
  - The flamegraph fills a frame with its service colour mixed 40 % into the
    surface, under a 2 px full-colour top edge; its label is
    `palette.readableText` of that fill (4.5:1 or more).
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
  accent fill is one token per theme (`#356fe6` / `#2558d9`).
- Observability times are 24 h everywhere (`Sep 12 16:29:57`, never
  `04:29:57 PM` or `9/12/2026, 1:30:00 PM`), and grouped counts read `1,234`
  on every browser locale.
- Solid error badges are `--danger` with a `--panel` glyph: light red with a
  dark glyph in dark mode.

## Stylesheets

The styles live in `src/static/css/`, one file per role, each imported into a
cascade layer by `src/static/css/index.css`:

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
| `01-base.css` | base | the box model, page typography, scrollbars, the focus ring offset |
| `10-components/<name>.css` | components | one file per shared component: `buttons`, `inputs`, `tabs`, `segmented`, `menu`, `popover`, `panels`, `state`, `search`, `table`, `badge`, `stat`, `chart`, `graph-kit`, `copy`, `sql`, `kv`, `dialog`. A rule that styles a component's element, in any context (the trace search bar's pickers, the editor's copy button), lives with the component. |
| `20-features/<name>.css` | features | `shell` (the page shell), `query`, `query-library`, `analysis`, `explorer`, `observability` (the view row, filter bar and time range shared by the three views), `traces`, `logs`, `metrics` |
| `30-overrides.css` | overrides | declarations that must win over every component and feature rule: the former `!important` ones, grouped by the file they belong with |

A later layer wins over an earlier one whatever the specificity, so a feature
restyles a component without a specificity fight, and nothing needs
`!important` to beat a component. Inside a layer, specificity and source order
decide as usual (the files of a layer in `index.css` order).

Rules of thumb, enforced by `tests/harness/test_css_layers_contract.py`:

- **One rule per selector list.** A selector list is written once per layer
  and `@media` context: add a declaration to its rule, never a second rule.
- **No dead rule.** Every selector can match something a page creates
  (`python3 tools/build_page_css.py --report-dead` lists those that cannot).
- **`!important`** only on the contract's allow-list, each with its reason:
  `[hidden]` (in the overrides layer: the weakest `!important`, so a rule that
  shows a hidden element on purpose still does), the rules that show an element
  despite `[hidden]`, and a background that must win over an animation.
- **Colours are tokens.** A colour literal (hex, `rgb()`, `hsl()`, a named
  colour) appears in `00-tokens.css` only, named for its role.
- **Sizes, weights, families, radii, shadows, durations and stacking are
  tokens** too ("Type, shape, motion and stacking").
- A feature declaration that must not apply to a component's own state
  (`:hover`, `.is-selected`) excludes it with `:not(:where(...))`, which keeps
  its specificity.

**Page sheets.** Each page loads one generated sheet: `style.query.css`,
`style.explorer.css`, `style.observability.<view>.css` (and
`style.observability.css`, every view, once a second view is shown).
`tools/build_page_css.py` writes them: one `@layer` block per layer, the
files in `index.css` order, the rules that can match on the page (a selector
is dropped when a class or id it needs appears in no string literal of the
page's scripts and no attribute of its shell; comments and identifiers do not
count). The sheets are build outputs: CMake stages `src/static` without the
sources and generates them into the stage it embeds, the Docker images run
the script, and git ignores them. To serve `src/static` from the file system,
run the script once.

## Page shell

Query, Explorer and Observability share one full-bleed page chrome, written
once in `src/static/css/20-features/shell.css` (its tokens in `00-tokens.css`):

- The header, then the page's nav row (`#obsNav`, `#explorerTopBar`: one row,
  the Explorer's Catalog modes on its right), then the page's regions
  edge to edge on the flat `--bg`. There is no page card, rounded inset or
  outer shadow.
- `--gutter` (12 px, 10 px at 820 px and below) insets every region's
  content and the header. `--nav-row-h` (48 px) is the height of a nav row.
  `--shell-border` (1 px `--border`) separates regions and rows.
- The `--z-*` scale names every stacking level ("Type, shape, motion and
  stacking"): `--z-nav`, `--z-drawer`, `--z-header`, `--z-dropdown`,
  `--z-modal`, `--z-tooltip` for the shell and what opens over it.
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

## Touch and phones

**Touch (`@media (pointer: coarse)`)**: every control takes `--hit` (40 px)
or more on both axes; a mouse sees none of it.

- `00-tokens.css` sets `--control-h`, `--control-h-sm`, `--row-compact`,
  `--row-regular` and `--trace-row-h` to `--hit` (the span bar stays
  `--trace-bar-h`, 14 px, centred). Virtual lists read their row height
  through `ns.table.rowHeight`, so they follow.
- The components that do not read a token grow in the "Touch" block of
  `30-overrides.css`: tabs, menu items, pickers, fields, icon buttons, tree
  rows, the waterfall head and labels. A small glyph inside text, a chip or a
  dense row (copy, chip remove, a collapse box, an exemplar mark, the overview
  handles, segmented options, badge buttons) keeps its look and reaches
  `--hit` through a transparent `::after` band centred on it. Chips that wrap
  are 32 px tall and 8 px apart, so the bands of two rows meet.
- Per-row actions fold into a menu: a key / value row with two or more
  actions shows one "..." button (`.kvList__more`) that opens them as an
  `ns.menu` context menu. On a phone the span list's click-to-filter values
  are no targets of their own: a tap opens the span, whose panel filters.
- `tests/frontend/helpers/app.js` `smallTouchTargets(page)` probes every
  visible control with `elementFromPoint` along its centre lines (bands count,
  a neighbour drawn over it does not); `page-chrome.spec.js` runs it on every
  page at 390, 360 and 768 px with touch.

**Phones (600 px, `--bp-sm`, and below)**: content first.

- A `.foldSummary` (one line, a chevron that turns while the region is open)
  stands for a folded region: each Observability filter bar ("2026-09-12
  12:30 -> 13:30 . 2 filters"; a search folds it again; its chips fold with
  it, `app_observability.js`) and the Query run stats ("7 ms . 120,064 rows .
  1.9 MB read . CPU 87.7% . 1.8 MB memory", `app_ui.js`). The overview charts
  (`[data-phone-fold]`: Matching traces, Trace duration, the Logs histogram)
  start folded to their head (`.chartCard__fold`). The folds only bite at
  that width: their rules sit in `max-width: 600px` blocks.
- Logs records are two-line cards, `--row-card` (52 px) tall: Time, Level
  and Service, then the Body. The trace detail keeps its title on the first
  line and its stats on the second; stats, highlights and service filters
  are single rows that scroll sideways; span names drop their method / status
  chips and log counts.
- A row that scrolls sideways (every `ns.tabs` row, `#obsNav`, the trace
  header rows) fades the side it hides content on: `ns.shell.edgeCues(el)`
  sets `.has-edge-start` / `.has-edge-end`, `shell.css` masks that edge over
  `--edge-fade`. A selected tab scrolls into view in its own row.
- Meta lines (`ns.util.setMetaLine`) put each " . " part in a nowrap
  `.metaPart`: a line wraps between parts, never between a value and its
  unit. The header keeps the host's ClickHouse version whole (the ping is in
  the host menu).

## Icons

One drawing style: the outline icons of [Tabler Icons](https://tabler.io/icons)
(MIT, `src/static/icons.LICENSE.txt`), a 1.5 stroke on a 24-unit grid, round
caps and joins, no fill, in `currentColor`. Phosphor is the fallback for a
drawing Tabler lacks.

- **The sprite**: `src/static/icons.svg`, one `<symbol id="i-<name>"
  viewBox="0 0 24 24">` per icon, geometry only (no paint attributes), ASCII.
  A comment after each symbol names its Tabler icon. To add one, copy the
  Tabler outline file's paths (without the transparent `M0 0h24v24H0z`
  frame) into a new symbol, then run `python3 tools/build_page_css.py`.
  Pages ask for `static/icons.svg?v=<content hash>` (`tools/icons.py`): the
  address changes with the drawings, so the server lets browsers keep it for
  a year (`immutable`); the bare address revalidates like other assets.
- **The helper**: `ns.icon(name, { size, label, className })`
  (`app_ui_icon.js`, a common module) returns
  `<svg class="icon" aria-hidden="true"><use href=".../icons.svg?v=...#i-name"/></svg>`;
  `ns.icon.el(...)` returns the element. Static markup in the shells and
  `src/shell/header.html` writes the same `<svg class="icon">` with
  `href="/static/icons.svg#i-name"`: `tools/build_page_css.py` stamps the
  current hash into it, and the shell rewrites it under a reverse-proxy
  prefix before the first paint.
- **Sizes** (`css/10-components/icon.css`): 16 px (`--icon-md`) by default,
  `size: "sm"` 14 px (`--icon-sm`: in chips, badges, dense rows, beside 11-12
  px text) and `size: "lg"` 18 px (`--icon-lg`: the theme button, the trace
  Back). The `.icon` rule is the only one that paints an icon: a component
  sets its colour, never its stroke. `vertical-align: middle` and
  `flex-shrink: 0` keep it on the text's centre line in inline and flex rows.
- **Buttons**: an icon-only button has an `aria-label` and a `title` (the
  `title` names its shortcut, "Zoom in (+)"); its icon stays `aria-hidden`.
  `label` gives an icon `role="img"` only when it speaks on its own, outside
  a labelled control. The button keeps its size tokens (`--control-h`, the
  `--hit` band on touch): the icon never sizes the button.
- **Disclosure**: a tree or row toggle holds `chevron-right` with
  `className: "icon--disclosure"`; it turns down while its button is
  `aria-expanded="true"`. A fold summary or a select turns `chevron-down`.
- **Pseudo-elements** (select and picker chevrons, `<details>` arrows, the
  sort arrows of a `.dataTable` header, 1em of the header text, the library twisty) cannot hold an
  `<svg>`. They paint a mask, `mask: var(--icon-<name>) center / 100%
  no-repeat` on `background-color: currentColor` (or `--muted`). The
  `--icon-*` tokens in `00-tokens.css` are generated from the sprite's
  symbols (`MASK_ICONS` in `tools/icons.py`) with the `.icon` paint, so a mask
  and a sprite icon are one drawing. A `mask-image: url(icons.svg#...)` would
  not do: a fragment that names a `<symbol>` is no CSS image in any engine,
  and `<view>` fragments are unreliable as masks in WebKit.
- **The logo**: an 18 px mark before "ClickHouse Dash" (four bars of a column
  chart in `--accent-fill`, `.appBrand__logo`), inline in
  `src/shell/header.html` so it paints with the header. The favicon is the
  same drawing: `src/static/images/logo.svg` (light and dark tab chrome) and
  `favicon.ico` (16, 32, 48 px) as the fallback.
- **Text stays text**: the " . " separator, "≈" estimates, "×" multipliers
  ("×691", "1 shard × 2 replicas"), arrows in ranges and prose ("12:30 →
  13:30", "MOVE → disk"), "⌘" and arrow keys in shortcut hints, and labels
  a canvas draws with `fillText` (the Explorer graph's "▸ db" group labels and
  its "−" / "+1" expansion controls). Any other glyph that stands for an
  action or an object (a close cross, a chevron, an arrow on a button, an
  object kind) is a sprite icon. `tests/harness/test_icons_contract.py` holds
  these rules; `tests/frontend/specs/ui-icons.spec.js` checks that every
  visible icon is drawn and every icon-only button is labelled.

## Building elements

`app_dom.js` (in `common`, right after the format and palette modules) gives
every page one way to build and find elements.

- **`ns.h(tag, props, ...children)`** returns an element. `props` is `null`
  or an object: `class` (a string, an array with falsy entries skipped, or
  `{ name: on }`), `dataset` (`{ spanId: id }` gives `data-span-id`), `style`
  (a string or `{ left: "4px", "--trace-service-color": c }`), `aria`
  (`{ label, pressed: false }`: aria values print `"false"`), `on`
  (`{ click: fn }`, removed by `signal`: an `AbortSignal` or an
  `ns.lifecycle` scope), `value` (the attribute, as in markup; the property
  of a `<select>` or `<textarea>`, set after the children so a select finds
  its option), `indeterminate` (the property), and any other key as an
  attribute (`true` present, `false` or `null` absent: `checked`,
  `disabled`, `hidden`). A URL attribute never takes a `javascript:` URL.
  Children are strings and numbers (always text, never markup), nodes and
  arrays of children; `null`, `undefined`, `false`, `true` and `""` add
  nothing. `h.svg(tag, props, ...children)` builds in the SVG namespace.
- **`h.frag(...children)`** returns a `DocumentFragment`;
  **`h.replace(container, ...children)`** replaces a container's children
  (none clears it).
- **`h.html(trusted)`** returns a fragment parsed from markup: the one,
  greppable way to insert markup next to `h()`, for trusted strings only
  (the SQL highlighter output, icons, the escaped string renderers below).
- **Lookups**: `dom.byId(id)`, `dom.$(selector, root)` (the first match) and
  `dom.$$(selector, root)` (every match, an array). `root` defaults to the
  document only when it is left out; an explicit `null` root finds nothing,
  so a component never searches the whole page by mistake. Modules take them
  with `const { byId, $, $$ } = ns.dom;` and never call `getElementById` or
  `querySelector*` themselves; the loader and the Observability bootstrap,
  which run before `app_dom.js`, are the exceptions. The `dom.*` registry
  keeps the page shell's ids.

**String renderers.** Lists drawn thousands of times (the trace waterfall,
the span list, the Logs grid, the treemap) and the panels built from the
data components' `*Html` functions stay HTML strings: every value goes
through `util.escapeHtml` (a module's `esc` alias) or a component that
escapes, and a variable or function holding such markup is named `*Html`.
Each module that still writes `innerHTML` / `outerHTML` or calls
`insertAdjacentHTML` is on the allow-list of
`tests/harness/test_dom_builder_contract.py`, with its reason and its
count; a template literal written straight into one of them interpolates
only escaped values, `*Html` markup, numbers, constants and literals.
Everything else, from a count label to a menu, uses `h()`; clearing a
container is `replaceChildren()` (or `h.replace(el)`), never
`innerHTML = ""`.

## Layers, popovers and panels

Three modules load right after `app_dom.js` on every page (the `common`
list of `src/static/modules.json`):

- `ns.layers` (`app_ui_layers.js`): the one stack of what is open over the
  page. `ns.layers.push({ el, onDismiss, modal, docked, trapFocus, opener })`
  returns a handle with `close()`. Escape closes the top layer only (a key a
  component consumed with `preventDefault()`, or typed in a page field, is
  left alone); one capture pointerdown dismisses the floating layers a press
  lands outside of (docked panels and modal layers stay); the focus goes
  back to the opener. Every `ns.dialog` is a modal layer. Do not add a
  document Escape or click-outside listener: push a layer.
- `ns.lifecycle` (same module): `scope()` gives an `AbortController` signal
  for `addEventListener(..., { signal })`; `bind(view, (scope) => ...)` runs
  each time a view shows and its listeners go when it is hidden. Views:
  `traces`, `logs`, `metrics` and `explorer:<mode>`.
- `ns.popover` (`app_ui_popover.js`): `place(anchor, el, { side, align,
  offset })` (flip and an 8 px viewport margin), `tip(el, content)` (hover /
  focus tooltips, `role=tooltip`, never a live region), `follow()` (pointer
  tips over canvases), `open(anchor, content)` (a popover layer) and
  `flash(anchor, "Copied")`.
- `ns.sidePanel` and `ns.detailPanel` (`app_ui_panel.js`): the left list
  (`.uiSide`, `--side-w` 288 px, a 32 px rail when folded, a drawer on
  phones) and the right entity panel (`.uiDetail`, `--detail-w`, docked or
  floating, one head and the `.closeCross` close button, a bottom sheet at
  `--bp-md`). A detail panel showing one entity writes one URL parameter
  (`span=`, `log=`, `node=`, `svc=`) through `ns.router.panel(name)` (see
  "Routes"): pushed when it opens, replaced when it moves, and Back closes
  it. Below `ns.sidePanel.FOLD_BELOW` (1600 px, and above `--bp-md`) a
  docked detail panel that opens folds the page's shown side panels to
  their rails and unfolds them when it closes (a rail the viewer opened
  meanwhile stays open; neither change is remembered). A side panel's head
  takes `.is-scrolled` (a soft edge, `--shadow-sticky`) while its list
  scrolls under it.

## Components: tabs, segmented controls and menus

Every navigation or choice control is one of three components. Each loads
on every page (the `common` list of `src/static/modules.json`, after
`app_dom.js` and before `app_ui.js`) and keeps
its CSS in its own file, `src/static/css/10-components/<name>.css`.
`tests/harness/test_ui_tabs_menus_contract.py` fails when a local copy of a
family comes back.

### Tabs: `ns.tabs` (`app_ui_tabs.js`)

Two tiers with one behaviour:

- **Tier 1, page and view tabs**: `.viewTabs` / `.viewTab`, a pill row in a
  nav row. The Explorer views, the Observability views and the Traces Search,
  Services and Service map tabs use it.
- **Tier 2, in-content tabs**: `.contentTabs` / `.contentTabs__tab`, an
  underline row inside a view. The Explorer table card, Logs Results and
  Patterns, the log record tabs, the trace detail views and the dialog tab
  rows use it.

`ns.tabs.bind(list, { attr, onSelect })` owns `role=tablist` / `tab`,
`aria-selected` and `.is-active`, the roving tabindex (Tab reaches the
selected tab only), Left / Right / Home / End with automatic activation, and
the click. The tab's value is its `data-<attr>` (`data-tab` by default).
`onSelect` shows the panel. It may rebuild the row or return a promise; the
selected tab keeps the focus either way. `ns.tabs.render(list, items, {
tier, selected })` builds a row from data, and `ns.tabs.select(list, value)`
marks one tab selected. No other module handles tab keys.

### Segmented controls: `ns.segmented` (`app_ui_segmented.js`)

A segmented control is a short row of exclusive choices that switch a view
in place. Examples: the Explorer's Browse | Graph | Storage, Traces | Spans,
List | Table, Percentiles | Heatmap, Table | Chart, the chart types,
Lineage | Tiers, the Metrics catalog's By metric | By service, the context
window presets and the metrics `=` / `!=`.

**Segmented = modes, underline = sections.** A segmented control shows the
same scope another way (a mode); underlined tabs (tier 2) are the sections of
one thing (a card's Columns, Preview, Storage; a trace's views).

- **ARIA pattern**: `role=group`, named by `aria-label`, holding toggle
  buttons that carry `aria-pressed`.
- **Look**: `.segmented` / `.segmented__option`. The pressed option sits on
  `--seg-active-bg`, which every theme block defines, with an
  `--accentBorder` edge.
- **Sizes**: 28 px by default, 24 px with `.segmented--compact` (in card
  headers and dense toolbars).

The API:

- `html(options, { attr, value, size, label, className })` returns the
  markup as a string.
- `render(group, options, ...)` builds the options into an element.
- `bind(group, { attr, onChange })` handles the clicks.
- `set(group, value, attr)` marks the pressed option.

Each option keeps its value in a data attribute the caller names
(`data-results-view`, `data-duration-view`...).

An option of `{ html, iconOnly: true }` is an icon alone
(`.segmented__option--icon`): its `label` becomes its `aria-label` and its
`title` the tooltip. The Query results Table | Chart switch (main panel and
every multiquery panel) is such a pair: a table icon and a chart icon, inline
16 px SVGs stroked in `currentColor`.

### Menus, pickers and dropdowns: `ns.menu` (`app_ui_menu.js`)

Every popup list is an `ns.menu` menu: the header host, page and theme
menus, the Run and Copy split menus, the run settings, the Observability
pickers, the time range panel, the chart and editor menus, the
click-to-filter and row context menus. Each family keeps its look
(`themeSelect`, `tracePicker`, `runMenu`...). The module owns:

- **Open and close**: `aria-expanded` on the button and the root's
  `themeSelect--open` / `--closing` (or `is-open`) classes, with the 160 ms
  (`--dur-base`) close motion. One menu is open at a time; a submenu keeps its parents
  open.
- **Placement**: a list stays in the viewport (shifted, flipped above its
  button, or capped in height). A floating menu (a portal, a context menu, a
  submenu) mounts in the open `<dialog>` that holds its anchor, because the
  page outside a modal dialog is inert.
- **Keys**: Down / Up / Home / End move between items, a typed prefix jumps
  to the next matching item, and Enter / Space activate. Escape closes and
  gives the focus back to the button; Tab closes. Down / Up on the button
  open the list.
- **Focus**: opened from the keyboard, the selected item (or the first)
  takes the focus; opened with a pointer, the list does.
- **Dismissal**: every open menu is an `ns.layers` layer (Escape, a press
  outside), pushed by `layer()`, the one place in the module that knows the
  stack. `ns.menu` moves the focus itself (`returnFocus: false`).

The entry points:

| Call | For |
|---|---|
| `bind(button, menu, options)` | an action or settings menu (`root`, `focus`, `closeOnSelect`, `canOpen`, `onOpen`, `portal`, `keys: false` for a panel with its own keys) |
| `select(selectEl, options)` | a single-choice picker over a hidden native `<select>` (the data source: `tabindex=-1`, `aria-hidden`); the button reads `<label> · <option>` from `data-field-label` |
| `multi(button, menu, options)` | a multi-select list that stays open on each pick |
| `split(main, toggle, menu)` | a split button's menu (Copy JSON / Download) |
| `context(menu, { x, y, anchor, returnFocus })` | a menu at a point or under a value |
| `submenu(item, list, { parent, onOpen })` | a nested menu: Right / Enter / click / hover open it, Left / Escape close it back on its item |

Every label sits inside the control, for example `Status · All`,
`Sort · Most Recent`, `Aggregation · Rate` and `X axis · Auto`. The graph
depth stepper reads `- Depth 1 +`. There is no outside label.

## Page infrastructure

One way to do each of these; `tests/harness/test_ui_infrastructure_contract.py`
and `test_page_manifest_contract.py` fail on a local copy.

- **Modules**: `src/static/modules.json` lists every page's modules
  (`common` first: shared helpers and `app_ui_*` components, then the page's
  `modules`, its `lazy` groups and the Observability `views`).
  `app_loader.js` (`ns.loader`: `load`, `loadGroup`, `url`) loads them; no
  module names a script or inserts one. After editing it or the header
  partial `src/shell/header.html`, run `python3 tools/build_page_css.py`: it
  writes the shells' `shell:header` and `shell:scripts` regions, then the
  page stylesheets.
- **States** (`ns.uiState`, `app_ui_state.js`): `empty`, `error` and
  `loading` blocks (and `emptyHtml` / `errorHtml` / `loadingHtml`, `block`)
  with a title, a sentence and actions (a way out: Zoom out, Clear filters,
  jump to data; Retry on an error); a loading block is a spinner and its
  `label` ("Loading…" without one), whichever function builds it; `banner` (the error strip, role alert,
  Retry; `verbatim` for a server message); `busy(el, on)` (`is-loading`,
  `aria-busy`, a button's spinner); `announce(text)` (the one polite live
  region). No pane is `aria-live`; hover readouts are `role="tooltip"`.
  Lists and trees (the Explorer tree, the query library) use `compact`
  blocks; a search that finds nothing offers "Clear the search"; a refresh
  button is `busy` while it reloads.
- **Feature flags** (`ns.features`, `app_state.js`): `get(path, fallback)`,
  `known()`, `ready`, `on(fn)`. `FEATURE_DEFAULTS` is the server's defaults
  table (`server.hpp`); `fallback` applies only before `/api/version`
  answers.
- **Requests** (`app_api.js`): every route is a named endpoint there
  (`api.searchTraceSpans`, `api.getMetricsSeries`...); no module builds an
  `api/...` URL (the hosts `EventSource` and the query library's REST
  adapter excepted). Every call goes through `request()` and takes a last
  `{ signal }`; `request(path, { method, body, headers, signal })` adds
  request headers (the query library's `If-Match`), and an HTTP error
  carries `.status` and `.body` (the answer as sent). `util.latest(key)`
  aborts the previous request for `key`: check `isCurrent()` before using an
  answer or showing an error.
- **Error messages**: `util.errorText(error, fallback)` is the one way to
  turn an error into the reader's sentence: the server's message without
  its `error_code: ` prefix (the code stays on `error.code`), a sentence for
  a network failure or an answer that is not JSON, `fallback` otherwise. An
  `ns.uiState.banner` given an Error shows it. The Query result's
  ClickHouse errors go through `util.queryErrorParts(message, where)`: no
  code prefix, no `DB::Exception` / `(version …)` / formatQuery wrapper, a
  syntax error as "Syntax error, line L col C near X", and the parser's
  "Expected one of" list behind a closed toggle (`banner({ details,
  detailsLabel })`); `getErrorText()` keeps the message as sent for the
  history and the downloads.
- **Storage** (`storage.pref(key, fallback, options)`, `storage.KEYS`):
  never throws; the fallback's type keeps the stored format of the key.
- **Search fields** (`ns.search.bind`, `ns.search.within`): the one delay
  `util.SEARCH_DEBOUNCE_MS` (200 ms), Enter and Escape apply at once, one
  look `.uiSearch` (`--compact` in dense bars; 30 px and full width as a
  side panel's `.uiSide__search`).
- **Timing helpers**: `util.debounce(fn, ms)` (`.cancel`, `.flush`),
  `util.rafOnce(fn)`. **Escaping**: `util.escapeHtml` only.

## Routes

`ns.router` (`src/static/app_router.js`, in the `common` list right after
`app_dom.js`) owns the address bar and the session history. No other script
calls `history.pushState`, `replaceState`, `back` or `go`, or listens to
`popstate`: `tests/harness/test_ui_router_contract.py` fails on a copy.

- **Reading**: `router.current()` gives `{ path, params, hash, state }` (`path`
  without the base path, `params` a copy); `router.url(path)` adds the base
  path, `router.path(pathname)` removes it, `router.href()` is the current
  address.
- **Writing**: `router.push(update, opts)` and `router.replace(update, opts)`.
  An object update merges into the params and drops a parameter set to
  `null`, `""` or `[]`; a `URLSearchParams` or a string is the whole query; a
  function mutates a copy. `opts.path` / `opts.href` change the address,
  `opts.state` adds the owner's entry state. A push of the current address
  replaces it; a write that changes nothing is a no-op. The one option name of
  page navigation functions is `history: "push" | "replace" | "none"`.
- **History state**: one shape, `{ chdash: 1, view, ...owner state }`
  (`view`: `query`, `explorer`, `traces`, `logs` or `metrics`; owner state: a
  panel's `detail` / `detailOf`, a trace's `searchBack`).
- **Owners**: `router.owner(name, { view, path, params })` is the handle a
  view writes with. It writes only while its `ns.lifecycle` scope shows (the
  Observability views; `view: null` always, a function decides otherwise), so
  a hidden view never writes the URL. `path` and `params()` are the owner's
  address and its whole state, the base of every write. The Observability
  page opens a view's scope before its module's `init()`.
- **Panels**: `router.panel(name)` (or `owner.panel(name)`) is a detail
  panel's parameter: `open(value)` pushes an entry (replaces when another
  value is open), `move(value)` replaces (next / previous), `close()` goes
  Back when the entry is the panel's own (pushed by `open` over the same
  address) and replaces without the parameter otherwise.
- **Back / Forward**: `router.on(prefix | RegExp | fn, handler)` runs the
  handlers that match the new entry, in order, from the page's one popstate
  listener (`router.debug().popstateListeners` is 1). Handlers: the
  Observability controller (`/observability`), the Explorer (`/explorer`) and
  the Query result's row details (every path).

**Vocabulary.** The path names where you are: the page, the view and the
entity (`/explorer/<db>/<object>`, `/explorer/_functions/<name>`,
`/observability/traces/<traceId>`); reserved Explorer segments start with
`_`. `?tab=` names the sub-view of what the path shows (one per address, the
default tab has none). `?mode=` is another presentation of the same scope
(Explorer Graph / Storage, the Traces Spans results). A detail panel has one
parameter. Values are the labels the UI shows, lower case (`graph=lineage`,
`tab=flamegraph`). A former name is a read-only alias: the page reads it and
rewrites the address with replace on load.

| Route | Parameters |
| --- | --- |
| `/query` (and `/`) | `?saved=<id>` the library query in the editor, else `?sql=<text>` of the last run (up to 4,000 characters); replaced, never pushed |
| `/explorer` | the Catalog root (the databases overview); `?mode=graph` as below |
| `/explorer/<db>` | Browse: the database card, `?tab=storage` (none for Objects) |
| `/explorer/<db>/<object>` | Browse: `?tab=columns\|preview\|storage\|operations\|lineage\|ddl` (none for Columns) |
| `/explorer[/<db>[/<object>]]?mode=graph` | `?graph=lineage\|storage`, `?depth=0..8` (lineage) |
| `/explorer/_functions[/<name>]` | Functions, the selected function |
| `/explorer/_monitoring[/<section>]` | Monitoring: Overview (no section), `performance` (`?from=&to=`, the Observability range format), `activity`; a section the server or configuration does not offer falls back to Overview (replaced) |
| `/observability` | the first enabled view, its parameters kept |
| `/observability/traces` | the search: `from`, `to`, `status`, `service`, `operation`, `tag`, `tag_not`, `tag_exists`, `tag_missing`, `service_not`, `operation_not`, `status_not`, `min_duration_ms`, `max_duration_ms`, `limit`, `sort`, `results=table`, `duration_view=heatmap`; `?mode=spans` with `kind`, `span_min_duration_ms`, `span_max_duration_ms` and the panel's `span=`; `?tab=services` with `svc=` (panel) and `svc_sort`; `?tab=map` with `node=` (panel) |
| `/observability/traces/<traceId>` | `span=` the focused span, `?tab=graph\|statistics\|spans\|flamegraph` (none for the timeline), then the search context it was opened from (the filters, not the search page's tab) |
| `/observability/logs` | `from`, `to`, `service`, `level`, `sev`, `q`, `attr`, `trace_id`, `cols`, `denoise=1`, `?tab=patterns`, `log=` (panel) |
| `/observability/metrics` | `from`, `to`, the first panel's `service`, `metric`, `kind`, `agg`, `group_by`, `filter`, `filter_not`, `exemplars=0`, one `panel=` per other panel (its own parameters, encoded) and `active` |

`from` and `to` are named once: `ns.timeRange.url.read(params)` (the current
address by default, through `ns.router`) gives `{ from, to }` or `null`,
`url.write(params, range)` sets both or clears both, `url.has(params)` tells
whether either is set. Traces, Logs, Metrics and the Observability page
controller use it.

Pushed: a new search or selection, a view or tab switch, an opened panel, a
trace or span opened. Replaced: the page-load write, a panel moving, a sort,
column or display toggle, an alias rewrite. Back from a trace returns to the
search it came from (`returnToSearch`, `state.searchBack` steps).

| Alias (read, rewritten on load) | Canonical |
| --- | --- |
| `/explorer/<db>/<object>/<tab>`, the slugs `overview` / `schema` (Columns) and `data` (Preview) | `/explorer/<db>/<object>?tab=<tab>` |
| `/explorer…?view=browse\|graph` | `/explorer…` / `?mode=graph&graph=lineage&depth=1` |
| `/explorer/_system[?database=<db>[&table=<t>]]`, `/explorer[/<db>[/<t>]]?mode=storage` (the former Storage view and mode) | `/explorer/<db>[/<t>]?tab=storage`, `/explorer` at the root |
| `/explorer/functions[/<name>]`, `/explorer/databases` (no database of that name) | `/explorer/_functions[/<name>]`, `/explorer` |
| `/explorer/_operations` (the former Server operations view) | `/explorer/_monitoring/activity` |
| `/observability/traces/<traceId>?view=<tab>` (and a search `tab=` there) | `?tab=<tab>` |
| `/observability/traces?results=spans` | `?mode=spans` |

## Data display components

Seven modules, loaded on every page (the `common` list of `src/static/modules.json`, after `app_util.js`), each with one
file in `src/static/css/10-components/` (`table`, `badge`, `copy`, `sql`, `kv`, `stat`, `chart`).
`tests/harness/test_ui_data_components_contract.py` fails when a local copy
comes back.

| Module | API | What it draws |
| --- | --- | --- |
| `app_ui_table.js` | `ns.table.sortHeader(th, {key, dir, onSort})`, `sortHeadHtml`, `bindSort`, `setSort`, `cellBar(td, percent)`, `cellBarStyle`, `shareBar(el, percent, text)` / `shareBarHtml` (a share's figure beside a bar on its own track, never under the text: Logs patterns, Explorer Storage list), `barEligible({name, min})`, `copyCellHtml` / `copyCell`, `rowHeight(density)`, `ns.rovingRows(container, options)` | `<table class="dataTable">`: 12 px / 600 muted sentence-case headers on `--theadBg`, sticky; rows `--row-regular` (32 px) or `.dataTable--compact` (`--row-compact`, 26 px); `.num` (right, tabular, not mono), `.mono` for ids only; `tr.is-selected` (accent bar and `--rowHover`); `.dataTable__rowNum` (results, previews); one sort glyph from `aria-sort`, idle on hover only. `.dataList` gives virtual div grids (spans, Logs) the same tokens. `.cellBar` is the one in-cell bar, never on identifier or signed columns. A table that can be narrower than its columns (the span table beside the docked span panel) drops its lowest-priority columns rather than clipping them. |
| `app_ui_badge.js` | `ns.badge.html(text, {tone, size, shape, solid, color, swatch})`, `el`, `statusLabel` (`OK`, `Error`, `Unset`) / `statusHtml` (an Error chip, OK text, Unset nothing), `severityHtml` (ERROR / FATAL chips, other levels text), `chipHtml`, `clearHtml`, `swatchHtml` | `.badge`: `sm` 18 px / `md` 22 px, r4 or `pill`; tones neutral, accent, ok, warn, error, category (`--badge-color`), estimate, key; `.badge--solid` counts. `.chips` / `.chip` filter chips. `.serviceSwatch` (dot) and `.serviceSwatch--bar` (rows, chips). |
| `app_ui_copy.js` | `ui.copyText(text, control)`, `copyButton(button, getText)`, `copyButtonHtml`, `copySplit({root, getText, items})`, `downloadText(name, text)` | One clipboard path and one feedback: `.is-copied` for 1.2 s; a text button reads "Copied", an icon button shows the check and an announced `ns.popover.flash` tip. The Query, trace and Logs "Copy JSON" splits; the split menu is an `ns.menu.split`. |
| `app_ui_sql.js` | `ui.sqlBlock({sql, gutter, copy, maxLines, expand, inline, wrap})`, `sqlBlockHtml` + `sqlBind(root)` (the inline toggle of string-built blocks) | Read-only SQL on the editor's highlighter (loaded on demand where the page lacks it): DDL, graph panel SELECT, Services statements (inline, click to expand), mutation commands, library preview. |
| `app_ui_kv.js` | `ui.kvList(rows, {actions})`, `kvListHtml`, `kvBind(root, {onAction})` | Key / value lists with one value palette (`--json-*`), JSON trees, and include / exclude / only / copy / json actions: span, resource, link and log attributes, Logs fields, Query row Details, graph panel columns. |
| `app_ui_stat.js` | `ui.statTileHtml({label, value, sub, tone, dl})`, `statTile`, `statTilesHtml` | `.statTile` (eyebrow, value, sub), sentence case; `.statTiles--boxed`, `.statTile--sm`. |
| `app_ui_chart.js` | `ui.chartCardHtml({title, meta, actions, body})`, `ui.sparkline.html(values, opts)` / `draw(el, values, opts)` | `.chartCard` (head: title, meta, actions; body), `.sparkline` (`--sparkline-color`). |

The chart engine (`app_chart_core.js`) draws at most once per animation
frame: `setData` / `update` schedule the draw (several calls in a frame cost
one), a zoom gesture or a legend click draws at once, and `layout()`,
`stats()`, `points()`, `toClient()` and `flush()` draw a pending change
first. `setData({ append: true, ... })` says the arrays only grew at their
end (streamed rows): the block summaries of a long series (min, max, sum and
count per 64 points, from 16,384 points) then grow instead of being computed
again, so extents, the legend values and decimation read whole blocks. Past
two points per pixel, a line is drawn per device-pixel column: a column whose
values span more than 2 px is one pixel-aligned rect from its highest to its
lowest value, runs of flatter columns one stroked line (a stroke through
every column's first, low, high and last value cost 100 ms and more of
rasterisation per frame). `ns.chartCore.counters()` and
`ns.queryChart.counters()` count the work done since `resetCounters()`
(draws, layout reads, decimations, legend rebuilds, model builds, rows
parsed, bytes allocated) for the budget tests. The Query chart works only
while it can be seen (the Chart view, an expanded panel, a visible tab),
parses at most 240,000 new values per frame and resumes its x scan where the
previous build stopped.

The chart engine shows its legend when a chart has more
than one series (`legend: "always"` for one, `false` for none), has a
`legend: "totals"` mode (each series' total; `onLegendClick`,
`legendPressed`) and reads a bucketed time axis through `bucketMs`
(`bucketAlign: "center"` for bucket middles) as `ns.format.range`.
