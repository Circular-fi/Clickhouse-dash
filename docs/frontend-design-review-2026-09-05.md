# Frontend design review — 2026-09-05

This review is based on the first real Docker/Playwright review bundle generated on 2026-09-05 at the 1920×1080, 1440×900 and 1280×800 desktop viewports.

## Overall assessment

The frontend is technically stable (no horizontal overflow, no elements outside the viewport, no console/page/network errors and no serious/critical axe findings), but the visual hierarchy is not yet strong enough for a polished production dashboard. The main issue is not a broken theme; it is information architecture and density. Too much space is allocated to low-information surfaces while high-value data is visually noisy or pushed down the page.

## Priority 1 — Query workspace

- The right telemetry rail consumes a large fixed width for six cards that usually show only one or two values. It is visually heavy while the SQL editor and results are the core tasks.
- The editor is very tall even for short queries, which delays access to results and creates a large empty dark area.
- The bottom action row mixes status, a long query-id pill and primary/secondary actions with nearly equal visual weight.
- The result table's blue data bars dominate the table. They are especially noisy for boolean/binary values and make scanning raw values harder. Data bars should be opt-in/per-column or substantially more subtle.
- The Query ID should be secondary metadata (copyable on demand), not one of the largest persistent pills in the workspace.

Recommended direction: move telemetry into a compact horizontal strip, let the editor use the full content width, reduce its default height, simplify the footer/action hierarchy, and make result bars optional.

## Priority 1 — Analyze modal

- The modal is close to full-screen height even when only a small amount of analysis data exists, leaving a very large empty region.
- Summary values are presented as many equal-weight cards, so Session elapsed, ClickHouse duration, attempts and lower-value metadata all compete visually.
- The tab strip is useful, but the modal should size to content with a max-height and internal scrolling rather than reserve an almost full-screen canvas.
- The distinction between `Session elapsed` and `ClickHouse duration` is now semantically correct and should become one of the primary visual comparisons in the header/summary.

Recommended direction: content-driven modal height, a compact top KPI strip, then grouped sections (execution, CPU/memory, distributed/pipeline) instead of a flat card grid.

## Priority 1 — Explorer

- The Explorer top bar exposes too many controls at the same hierarchy level: Tables/Functions, List/Graph, database, search, refresh and status all compete in one line.
- Table detail exposes many tabs at once, increasing cognitive load before the user has established what they need.
- The first review bundle exposed a real visual bug where the `Loading table...` empty state remained visible together with loaded content. This is fixed by enforcing `.explorerEmptyState[hidden] { display: none !important; }`.

Recommended direction: split section navigation from view controls, and group detail tabs into a smaller set such as Overview, Schema, Storage, Ingestion, Dependencies and Operations.

## Priority 2 — Menus and popups

The existing Run menu and Query Library popup are visually coherent with the dark theme, but popup coverage was incomplete in the first bundle. The design suite now explicitly captures open states for:

- Run menu
- static host picker state (or open host menu when multiple hosts exist)
- Editor options menu
- Autocomplete suggestions popup
- Theme menu
- Query Library Saved view
- Query Library History view
- Results Copy menu
- Analysis modal Overview
- Analysis modal Raw
- Profiled Analysis modal

This ensures future reviews include the overlays themselves rather than only the underlying page.

## Priority 2 — Design-system normalization

Automated heuristics on the first bundle found:

- 13 distinct border-radius values
- 17 distinct padding patterns
- 7 font sizes
- 208 controls smaller than 32 px across captured states
- 165 clipped-text candidates
- 111 overlap candidates

The overlap/clipping counts include false positives from intentional editor/table behavior, so they are review signals rather than pass/fail criteria. The token counts are still a useful sign that spacing/radius conventions are too fragmented.

Recommended direction: establish a small spacing scale (4/8/12/16/24), 2–3 radii, explicit control heights and a compact typography scale before doing cosmetic polish.

## Priority 2 — Light theme

The light theme is functional, but panel boundaries and data bars are very pale and the hierarchy is weaker than in dark mode. It should be revisited after the layout hierarchy is simplified, rather than tuned independently now.

## Accessibility / runtime signals

The first review bundle reported:

- 0 critical axe violations
- 0 serious axe violations
- 3 moderate occurrences, all `page-has-heading-one`
- 0 console errors
- 0 page errors
- 0 failed network requests
- 0 horizontal overflow states
- 0 elements outside viewport

The missing `h1` is not a blocker for the redesign but is straightforward to address when the header hierarchy is revised.

## Recommended redesign order

1. Query workspace geometry and telemetry strip.
2. Result-table visual density and optional data bars.
3. Analyze modal hierarchy/height.
4. Explorer navigation and tab grouping.
5. Normalize spacing, radii, control heights and typography.
6. Revisit light theme.
7. Once accepted, generate Playwright visual baselines and make visual regression blocking.
