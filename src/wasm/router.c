/* router.c: the orthogonal edge router of src/static/app_graph_kit.js (routeEdgesSteps) as a kernel.
 *
 * Same algorithm, same constants, same order of every float operation and of every tie as the JavaScript
 * reference: the routes it returns are the ones routeEdges() returns (tests/frontend/specs/wasm-layout.spec.js
 * compares them point by point). It covers the fan ports, the route order, the A* on the sparse grid, the cheap
 * routes past the step budget, the fallback bodies, and the rip-up and reroute passes that score the route set.
 *
 * The JavaScript sorts ids with localeCompare, which no kernel can do: the caller sends, for every edge, the rank of
 * its id (equal ranks for ids that compare equal). rt_route() answers RT_NEEDS_JS (-2) for what it does not do, the
 * keyed grid used when a fan point is not on the grid and a run that outgrows its tables: the caller then runs the
 * reference.
 */
#include "rt.h"

#define RT_NEEDS_JS (-2)
#define RT_NO_MEMORY (-1)

#define LANE_GAP 12.0
#define NEAR_BASE 30000.0
#define NEAR_PER_PX 200.0
#define CROSSING_COST 28000.0
#define ROUTE_GRID_POINT_BUDGET 40000
#define PORT_TOP_OFFSET 36.0
#define INF (__builtin_inf())

static inline f64 fabs_(f64 x) { return __builtin_fabs(x); }
static inline f64 jmin(f64 a, f64 b) { return a < b ? a : b; }
static inline f64 jmax(f64 a, f64 b) { return a > b ? a : b; }
static inline i32 isnan_(f64 x) { return x != x; }

/* Math.round(): the nearest integer, ties toward +Infinity. */
static f64 jround(f64 x) {
  f64 r = __builtin_floor(x);
  return (x - r >= 0.5) ? r + 1.0 : r;
}

typedef struct { f64 x, y; } Pt;

/* ------------------------------------------------------------------ the run */

static i32 NI, NE;
static const f64 *IT;       /* items: x, y, width, height, lineageRow (NaN: none) */
static const i32 *ED;       /* edges: from item, to item (-1: none), secondary, id rank */
static f64 max_steps, search_steps;
static i32 failed;          /* RT_NEEDS_JS or RT_NO_MEMORY once set */

static inline f64 ix(i32 i) { return IT[i * 5]; }
static inline f64 iy(i32 i) { return IT[i * 5 + 1]; }
static inline f64 iw(i32 i) { return IT[i * 5 + 2]; }
static inline f64 ih(i32 i) { return IT[i * 5 + 3]; }
static inline i32 efrom(i32 e) { return ED[e * 4]; }
static inline i32 eto(i32 e) { return ED[e * 4 + 1]; }
static inline i32 esec(i32 e) { return ED[e * 4 + 2]; }
static inline i32 erank(i32 e) { return ED[e * 4 + 3]; }
static inline i32 edge_ok(i32 e) { return efrom(e) >= 0 && eto(e) >= 0; }

static void fail(i32 code) { if (!failed) failed = code; }

static void *take(usize bytes) {
  void *p = wasm_alloc(bytes);
  if (!p) fail(RT_NO_MEMORY);
  return p;
}
#define TAKE(type, n) ((type *)take(sizeof(type) * (usize)((n) > 0 ? (n) : 1)))

/* V8's order: the port is the same top-based anchor. */
static f64 port_y(i32 item) {
  return iy(item) + jmin(jmax(18.0, PORT_TOP_OFFSET), jmax(18.0, ih(item) - 18.0));
}
static Pt port_pt(i32 item, i32 right) {
  Pt p;
  p.x = right ? ix(item) + iw(item) : ix(item);
  p.y = port_y(item);
  return p;
}

/* ------------------------------------------------------------------ small sorts */

/* Stable merge sort of i32 keys by a comparator (< 0, 0, > 0), like the stable Array.prototype.sort. */
typedef i32 (*Cmp)(i32 a, i32 b, const void *ctx);
static void sort_idx(i32 *a, i32 n, Cmp cmp, const void *ctx) {
  if (n < 2) return;
  i32 *tmp = TAKE(i32, n);
  if (!tmp) return;
  for (i32 width = 1; width < n; width *= 2) {
    for (i32 lo = 0; lo < n; lo += 2 * width) {
      i32 mid = lo + width < n ? lo + width : n;
      i32 hi = lo + 2 * width < n ? lo + 2 * width : n;
      i32 i = lo, j = mid, k = lo;
      while (i < mid && j < hi) tmp[k++] = cmp(a[j], a[i], ctx) < 0 ? a[j++] : a[i++];
      while (i < mid) tmp[k++] = a[i++];
      while (j < hi) tmp[k++] = a[j++];
    }
    for (i32 k = 0; k < n; k++) a[k] = tmp[k];
  }
}

static void sort_f64(f64 *a, i32 n) {
  if (n < 2) return;
  f64 *tmp = TAKE(f64, n);
  if (!tmp) return;
  for (i32 width = 1; width < n; width *= 2) {
    for (i32 lo = 0; lo < n; lo += 2 * width) {
      i32 mid = lo + width < n ? lo + width : n;
      i32 hi = lo + 2 * width < n ? lo + 2 * width : n;
      i32 i = lo, j = mid, k = lo;
      while (i < mid && j < hi) tmp[k++] = a[j] < a[i] ? a[j++] : a[i++];
      while (i < mid) tmp[k++] = a[i++];
      while (j < hi) tmp[k++] = a[j++];
    }
    for (i32 k = 0; k < n; k++) a[k] = tmp[k];
  }
}

static void sort_i32(i32 *a, i32 n) {
  if (n < 2) return;
  if (n <= 16) {
    for (i32 i = 1; i < n; i++) {
      i32 v = a[i], at = i;
      for (; at > 0 && a[at - 1] > v; at--) a[at] = a[at - 1];
      a[at] = v;
    }
    return;
  }
  i32 *tmp = TAKE(i32, n);
  if (!tmp) return;
  for (i32 width = 1; width < n; width *= 2) {
    for (i32 lo = 0; lo < n; lo += 2 * width) {
      i32 mid = lo + width < n ? lo + width : n;
      i32 hi = lo + 2 * width < n ? lo + 2 * width : n;
      i32 i = lo, j = mid, k = lo;
      while (i < mid && j < hi) tmp[k++] = a[j] < a[i] ? a[j++] : a[i++];
      while (i < mid) tmp[k++] = a[i++];
      while (j < hi) tmp[k++] = a[j++];
    }
    for (i32 k = 0; k < n; k++) a[k] = tmp[k];
  }
}

/* ------------------------------------------------------------------ segments and their index */

typedef struct { f64 ax, ay, bx, by; i32 edge, from, to, index, route; } Seg;

static Seg *segs;          /* every routed segment of the run: the routes in order */
static i32 nsegs, segcap;

static inline i32 is_vertical(f64 ax, f64 bx) { return fabs_(ax - bx) < 0.001; }

/* Does the segment s hold a conflict of any size with the step? Zero for a pair that is apart. */
static inline i32 segments_apart(f64 ax, f64 ay, f64 bx, f64 by, f64 cx, f64 cy, f64 dx, f64 dy, f64 margin) {
  return jmax(ax, bx) + margin < jmin(cx, dx) || jmax(cx, dx) + margin < jmin(ax, bx)
      || jmax(ay, by) + margin < jmin(cy, dy) || jmax(cy, dy) + margin < jmin(ay, by);
}

/* sharedPortOverlapAllowed(a, b, currentEdge, segment). */
static i32 shared_port_overlap_allowed(f64 ax, f64 ay, f64 bx, f64 by, i32 cur, const Seg *s) {
  if (cur < 0) return 0;
  i32 horizontal = fabs_(ay - by) < 0.001 && fabs_(s->ay - s->by) < 0.001;
  if (!horizontal) return 0;
  if (s->from == efrom(cur)) {
    i32 item = efrom(cur);
    f64 port_x = ix(item) + iw(item);
    f64 py = port_y(item);
    f64 limit = port_x + 62.0;
    i32 same_y = fabs_(ay - py) < 0.001 && fabs_(s->ay - py) < 0.001;
    i32 inside = jmax(jmax(ax, bx), jmax(s->ax, s->bx)) <= limit + 0.001
              && jmin(jmin(ax, bx), jmin(s->ax, s->bx)) >= port_x - 0.001;
    if (same_y && inside) return 1;
  }
  if (s->to == eto(cur)) {
    i32 item = eto(cur);
    f64 port_x = ix(item);
    f64 py = port_y(item);
    f64 limit = port_x - 62.0;
    i32 same_y = fabs_(ay - py) < 0.001 && fabs_(s->ay - py) < 0.001;
    i32 inside = jmin(jmin(ax, bx), jmin(s->ax, s->bx)) >= limit - 0.001
              && jmax(jmax(ax, bx), jmax(s->ax, s->bx)) <= port_x + 0.001;
    if (same_y && inside) return 1;
  }
  return 0;
}

/* segmentConflictTerm(ax, ay, bx, by, segment, currentEdge). */
static f64 conflict_term(f64 ax, f64 ay, f64 bx, f64 by, const Seg *s, i32 cur) {
  f64 cx = s->ax, cy = s->ay, dx = s->bx, dy = s->by;
  i32 a_vertical = fabs_(ax - bx) < 0.001;
  if (a_vertical != (fabs_(cx - dx) < 0.001)) {
    f64 x = a_vertical ? ax : cx;
    f64 y = a_vertical ? cy : ay;
    f64 hx0 = a_vertical ? cx : ax;
    f64 hx1 = a_vertical ? dx : bx;
    f64 vy0 = a_vertical ? ay : cy;
    f64 vy1 = a_vertical ? by : dy;
    return (x > jmin(hx0, hx1) + 0.001 && x < jmax(hx0, hx1) - 0.001 && y > jmin(vy0, vy1) + 0.001 && y < jmax(vy0, vy1) - 0.001) ? CROSSING_COST : 0.0;
  }
  f64 gap = a_vertical ? fabs_(ax - cx) : fabs_(ay - cy);
  if (gap >= LANE_GAP - 0.001) return 0.0;
  f64 shared = a_vertical
    ? jmax(0.0, jmin(jmax(ay, by), jmax(cy, dy)) - jmax(jmin(ay, by), jmin(cy, dy)))
    : jmax(0.0, jmin(jmax(ax, bx), jmax(cx, dx)) - jmax(jmin(ax, bx), jmin(cx, dx)));
  if (!(shared > 0.5)) return 0.0;
  if (gap > 0.001) return NEAR_BASE + shared * NEAR_PER_PX;
  return shared_port_overlap_allowed(ax, ay, bx, by, cur, s) ? 0.0 : 1000000000.0 + shared * 100000.0;
}

/* The uniform grid (48 px cells) the router asks for the segments near a step. A segment is listed in every cell its box
   grown by 12.02 touches, so a pair that can have a conflict shares a cell. */
#define CELL 48.0
typedef struct {
  u32 tcap;
  i32 *head;          /* per slot: first entry + 1 (0: free) */
  i32 *cellx, *celly;
  i32 *eseg, *enext;
  i32 nent, entcap, ncells;
  i32 *stamp;
  i32 query;
  i32 indexed;
} Grid;

static Grid grid;

static i32 grid_init(i32 max_segs, i32 max_entries) {
  u32 cap = 1024;
  while (cap < (u32)max_entries) cap <<= 1;
  grid.tcap = cap;
  grid.head = TAKE(i32, cap);
  grid.cellx = TAKE(i32, cap);
  grid.celly = TAKE(i32, cap);
  grid.eseg = TAKE(i32, max_entries);
  grid.enext = TAKE(i32, max_entries);
  grid.stamp = TAKE(i32, max_segs);
  if (failed) return 0;
  grid.entcap = max_entries;
  for (u32 i = 0; i < cap; i++) grid.head[i] = 0;
  for (i32 i = 0; i < max_segs; i++) grid.stamp[i] = 0;
  grid.nent = 0;
  grid.ncells = 0;
  grid.query = 0;
  grid.indexed = 0;
  return 1;
}

static void grid_clear(void) {
  for (u32 i = 0; i < grid.tcap; i++) grid.head[i] = 0;
  grid.nent = 0;
  grid.ncells = 0;
  grid.indexed = 0;
}

static inline u32 cell_hash(i32 cx, i32 cy) {
  u32 h = (u32)cx * 0x9E3779B1u ^ ((u32)cy + 0x7F4A7C15u) * 0x85EBCA6Bu;
  h ^= h >> 15;
  return h;
}

static i32 *cell_slot(i32 cx, i32 cy, i32 create) {
  u32 mask = grid.tcap - 1u;
  u32 h = cell_hash(cx, cy) & mask;
  for (;;) {
    if (!grid.head[h]) {
      if (!create) return 0;
      grid.cellx[h] = cx;
      grid.celly[h] = cy;
      return &grid.head[h];
    }
    if (grid.cellx[h] == cx && grid.celly[h] == cy) return &grid.head[h];
    h = (h + 1u) & mask;
  }
}

static void grid_add(i32 id) {
  const Seg *s = &segs[id];
  f64 m = LANE_GAP + 0.02;
  i32 x0 = (i32)__builtin_floor((jmin(s->ax, s->bx) - m) / CELL);
  i32 x1 = (i32)__builtin_floor((jmax(s->ax, s->bx) + m) / CELL);
  i32 y0 = (i32)__builtin_floor((jmin(s->ay, s->by) - m) / CELL);
  i32 y1 = (i32)__builtin_floor((jmax(s->ay, s->by) + m) / CELL);
  for (i32 cx = x0; cx <= x1; cx++) {
    for (i32 cy = y0; cy <= y1; cy++) {
      if (grid.nent >= grid.entcap || (u32)(grid.ncells + 1) * 2u > grid.tcap) { fail(RT_NEEDS_JS); return; }
      i32 *slot = cell_slot(cx, cy, 1);
      if (!*slot) grid.ncells++;
      i32 e = grid.nent++;
      grid.eseg[e] = id;
      grid.enext[e] = *slot - 1;
      *slot = e + 1;
    }
  }
}

/* Index the segments added since the last call. */
static void grid_sync(void) {
  for (; grid.indexed < nsegs; grid.indexed++) grid_add(grid.indexed);
}

static i32 *found_buf;
static i32 found_cap;

/* The ids of the segments in the cells the step touches, each once (unsorted), in found_buf: returns the count. */
static i32 grid_gather(f64 ax, f64 ay, f64 bx, f64 by) {
  i32 x0 = (i32)__builtin_floor(jmin(ax, bx) / CELL);
  i32 x1 = (i32)__builtin_floor(jmax(ax, bx) / CELL);
  i32 y0 = (i32)__builtin_floor(jmin(ay, by) / CELL);
  i32 y1 = (i32)__builtin_floor(jmax(ay, by) / CELL);
  i32 count = 0;
  grid.query++;
  for (i32 cx = x0; cx <= x1; cx++) {
    for (i32 cy = y0; cy <= y1; cy++) {
      i32 *slot = cell_slot(cx, cy, 0);
      if (!slot) continue;
      for (i32 e = *slot - 1; e >= 0; e = grid.enext[e]) {
        i32 id = grid.eseg[e];
        if (grid.stamp[id] == grid.query) continue;
        grid.stamp[id] = grid.query;
        if (count >= found_cap) { fail(RT_NEEDS_JS); return count; }
        found_buf[count++] = id;
      }
    }
  }
  return count;
}

/* lineKey(): the line of a segment rounded to 0.01. */
static inline f64 line_key(f64 v) { return jround(v * 100.0); }

static f64 *term_buf;

/* penalty(): the sum, in segment order, of the non-zero terms of the step against the indexed segments, skipping the
   segments of route `skip` (-1: none). near_runs false: only the lines within 0.0011 of the step's own are parallel
   candidates (the cheap routes' index). `limit`: once the terms found exceed it clearly, the partial sum is returned. */
static f64 grid_penalty(f64 ax, f64 ay, f64 bx, f64 by, i32 edge, i32 near_runs, f64 limit, i32 skip) {
  i32 count = grid_gather(ax, ay, bx, by);
  f64 stop = limit + fabs_(limit) * 1e-9 + 1.0;
  i32 vertical = is_vertical(ax, bx);
  f64 along = vertical ? ax : ay;
  f64 lanes = near_runs ? LANE_GAP : 0.0011;
  f64 klo = line_key(along - lanes);
  f64 khi = line_key(along + lanes);
  /* the non-zero terms, by segment id */
  i32 terms = 0;
  f64 partial = 0.0;
  i32 integral = 1;
  for (i32 i = 0; i < count; i++) {
    i32 id = found_buf[i];
    const Seg *s = &segs[id];
    if (s->route == skip) continue;
    i32 s_vertical = is_vertical(s->ax, s->bx);
    if (s_vertical == vertical && !near_runs) {
      f64 k = line_key(vertical ? s->ax : s->ay);
      if (k < klo || k > khi) continue;
    }
    f64 value = conflict_term(ax, ay, bx, by, s, edge);
    if (value == 0.0) continue;
    found_buf[terms] = id;
    term_buf[terms] = value;
    terms++;
    partial += value;
    if (partial > stop) return partial;
    if (integral && value != __builtin_floor(value)) integral = 0;
  }
  if (integral && partial < 9007199254740992.0) return partial;
  /* the sum is made in segment order */
  for (i32 i = 1; i < terms; i++) {
    i32 id = found_buf[i];
    f64 v = term_buf[i];
    i32 at = i;
    for (; at > 0 && found_buf[at - 1] > id; at--) { found_buf[at] = found_buf[at - 1]; term_buf[at] = term_buf[at - 1]; }
    found_buf[at] = id;
    term_buf[at] = v;
  }
  f64 sum = 0.0;
  for (i32 i = 0; i < terms; i++) sum += term_buf[i];
  return sum;
}

/* ------------------------------------------------------------------ routes */

typedef struct { Pt *p; i32 n; } Route;

static f64 hypot_(f64 dx, f64 dy) { return js_hypot(dx, dy); }

static f64 polyline_total(const Pt *p, i32 n) {
  f64 total = 0.0;
  for (i32 i = 0; i + 1 < n; i++) total += hypot_(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
  return jmax(total, 0.0001);
}

static i32 bend_count(const Pt *p, i32 n) {
  i32 bends = 0;
  for (i32 i = 1; i + 1 < n; i++) {
    i32 fv = fabs_(p[i - 1].x - p[i].x) < 0.001;
    i32 sv = fabs_(p[i].x - p[i + 1].x) < 0.001;
    if (fv != sv) bends++;
  }
  return bends;
}

/* compressOrthogonalRoute() in place into out (which may be the input array's copy); returns the new length. */
static i32 compress_into(const Pt *in, i32 n, Pt *out) {
  if (n <= 2) {
    for (i32 i = 0; i < n; i++) out[i] = in[i];
    return n;
  }
  i32 m = 0;
  out[m++] = in[0];
  for (i32 i = 1; i + 1 < n; i++) {
    Pt a = out[m - 1], b = in[i], c = in[i + 1];
    i32 vertical = fabs_(a.x - b.x) < 0.001 && fabs_(b.x - c.x) < 0.001;
    i32 horizontal = fabs_(a.y - b.y) < 0.001 && fabs_(b.y - c.y) < 0.001;
    if (!vertical && !horizontal) out[m++] = b;
  }
  out[m++] = in[n - 1];
  return m;
}

static inline i32 near_pt(Pt a, Pt b) { return !(fabs_(a.x - b.x) > 0.001 || fabs_(a.y - b.y) > 0.001); }

/* assembleOrthogonalRoute(): the ports, the fans and the inner points of the body. */
static Route assemble(Pt source_port, Pt source_fan, const Pt *body, i32 nbody, Pt target_fan, Pt target_port) {
  Route r;
  r.p = TAKE(Pt, nbody + 4);
  r.n = 0;
  if (!r.p) return r;
  r.p[r.n++] = source_port;
  r.p[r.n++] = source_fan;
  for (i32 i = 1; i + 1 < nbody; i++) {
    if (!near_pt(r.p[r.n - 1], body[i])) r.p[r.n++] = body[i];
  }
  if (!near_pt(r.p[r.n - 1], target_fan)) r.p[r.n++] = target_fan;
  r.p[r.n++] = target_port;
  return r;
}

/* ------------------------------------------------------------------ the run state */

typedef struct { Pt a, a_fan, b, b_fan; } PortSet;

static PortSet *ports;       /* per edge */
static f64 *row_ys;          /* the sorted row lanes */
static i32 n_rows;
static f64 *between_ys;
static i32 n_between;
static f64 *rows_sorted, *between_sorted;   /* the lanes sorted by y, for the lane penalty */

static f64 bud_used, bud_max, bud_search;
static i32 bud_cheap, bud_exhausted;


/* The row lanes of the run (rowYs, betweenRowYs). */
static void build_rows(void) {
  i32 *rows_item = TAKE(i32, NI);
  f64 *row_no = TAKE(f64, NI);
  if (failed) return;
  i32 n = 0;
  for (i32 i = 0; i < NI; i++) {
    f64 row = IT[i * 5 + 4];
    if (isnan_(row) || row == INF || row == -INF) continue;
    i32 seen = 0;
    for (i32 k = 0; k < n; k++) if (row_no[k] == row) { seen = 1; break; }
    if (seen) continue;
    row_no[n] = row;
    rows_item[n] = i;
    n++;
  }
  /* sorted by row number */
  for (i32 i = 1; i < n; i++) {
    f64 r = row_no[i];
    i32 it = rows_item[i];
    i32 at = i;
    for (; at > 0 && row_no[at - 1] > r; at--) { row_no[at] = row_no[at - 1]; rows_item[at] = rows_item[at - 1]; }
    row_no[at] = r;
    rows_item[at] = it;
  }
  row_ys = TAKE(f64, n);
  between_ys = TAKE(f64, n);
  if (failed) return;
  n_rows = n;
  for (i32 i = 0; i < n; i++) row_ys[i] = port_y(rows_item[i]);
  n_between = n > 0 ? n - 1 : 0;
  for (i32 i = 0; i + 1 < n; i++) between_ys[i] = (row_ys[i] + row_ys[i + 1]) / 2.0;
  rows_sorted = TAKE(f64, n);
  between_sorted = TAKE(f64, n);
  if (failed) return;
  for (i32 i = 0; i < n; i++) rows_sorted[i] = row_ys[i];
  for (i32 i = 0; i < n_between; i++) between_sorted[i] = between_ys[i];
  sort_f64(rows_sorted, n);
  sort_f64(between_sorted, n_between);
}

/* ---- the fan ports (routePortMaps) */

typedef struct { f64 distance; i32 edge; } FanEntry;

static i32 fan_cmp_dist(i32 a, i32 b, const void *ctx) {
  const FanEntry *e = (const FanEntry *)ctx;
  f64 d = e[b].distance - e[a].distance;
  if (d != 0.0 && !isnan_(d)) return d < 0 ? -1 : 1;
  return erank(e[a].edge) - erank(e[b].edge);
}
static i32 fan_cmp_id(i32 a, i32 b, const void *ctx) {
  const FanEntry *e = (const FanEntry *)ctx;
  return erank(e[a].edge) - erank(e[b].edge);
}

/* Ranks of the edges of one group: out: rank per edge index (written for the group's edges). `outgoing`: the group leaves a
   card (its ports are on the right side, the other end on the left). */
static void fan_ranks(const i32 *group, i32 n, f64 anchor_y, i32 outgoing, i32 *rank_out) {
  FanEntry *entries = TAKE(FanEntry, n);
  i32 *up = TAKE(i32, n), *down = TAKE(i32, n), *flat = TAKE(i32, n);
  if (failed) return;
  i32 nu = 0, nd = 0, nf = 0;
  for (i32 k = 0; k < n; k++) {
    i32 e = group[k];
    i32 other = outgoing ? eto(e) : efrom(e);
    f64 delta = port_y(other) - anchor_y;
    entries[k].edge = e;
    entries[k].distance = fabs_(delta);
    if (delta < -1.0) up[nu++] = k;
    else if (delta > 1.0) down[nd++] = k;
    else flat[nf++] = k;
  }
  sort_idx(up, nu, fan_cmp_dist, entries);
  sort_idx(down, nd, fan_cmp_dist, entries);
  sort_idx(flat, nf, fan_cmp_id, entries);
  for (i32 i = 0; i < nu; i++) rank_out[entries[up[i]].edge] = i;
  for (i32 i = 0; i < nd; i++) rank_out[entries[down[i]].edge] = i;
  i32 non_flat_max = nu > nd ? nu : nd;
  for (i32 i = 0; i < nf; i++) rank_out[entries[flat[i]].edge] = non_flat_max + i;
}

static void build_ports(void) {
  ports = TAKE(PortSet, NE);
  i32 *rank = TAKE(i32, NE);
  i32 *group = TAKE(i32, NE);
  u8 *done = TAKE(u8, NI);
  if (failed) return;
  const f64 FAN_BASE = 18.0, FAN_STEP = LANE_GAP, FAN_MAX = 58.0;
  /* outgoing groups: by source card, edges in list order */
  for (i32 pass = 0; pass < 2; pass++) {
    for (i32 i = 0; i < NI; i++) done[i] = 0;
    for (i32 k = 0; k < NE; k++) {
      if (!edge_ok(k)) continue;
      i32 item = pass == 0 ? efrom(k) : eto(k);
      if (done[item]) continue;
      done[item] = 1;
      i32 n = 0;
      for (i32 e = k; e < NE; e++) if (edge_ok(e) && (pass == 0 ? efrom(e) : eto(e)) == item) group[n++] = e;
      Pt port = port_pt(item, pass == 0);
      i32 mark_n = n;
      for (i32 g = 0; g < mark_n; g++) rank[group[g]] = 0;
      fan_ranks(group, n, port.y, pass == 0, rank);
      for (i32 g = 0; g < n; g++) {
        i32 e = group[g];
        f64 offset = jmin(FAN_MAX, FAN_BASE + (f64)rank[e] * FAN_STEP);
        if (pass == 0) {
          ports[e].a = port;
          ports[e].a_fan.x = port.x + offset;
          ports[e].a_fan.y = port.y;
        } else {
          ports[e].b = port;
          ports[e].b_fan.x = port.x - offset;
          ports[e].b_fan.y = port.y;
        }
      }
    }
  }
}

/* ---- edge orders */

static i32 base_cmp(i32 a, i32 b, const void *ctx) {
  (void)ctx;
  i32 asec = esec(a) ? 1 : 0, bsec = esec(b) ? 1 : 0;
  if (asec != bsec) return asec - bsec;
  i32 af = efrom(a), bf = efrom(b), at = eto(a), bt = eto(b);
  f64 d = (af >= 0 ? ix(af) : 0.0) - (bf >= 0 ? ix(bf) : 0.0);
  if (d != 0.0 && !isnan_(d)) return d < 0 ? -1 : 1;
  d = (af >= 0 ? iy(af) : 0.0) - (bf >= 0 ? iy(bf) : 0.0);
  if (d != 0.0 && !isnan_(d)) return d < 0 ? -1 : 1;
  f64 ca = (at >= 0 ? iy(at) : 0.0) + (at >= 0 ? ih(at) : 0.0) / 2.0;
  f64 cb = (bt >= 0 ? iy(bt) : 0.0) + (bt >= 0 ? ih(bt) : 0.0) / 2.0;
  d = ca - cb;
  if (d != 0.0 && !isnan_(d)) return d < 0 ? -1 : 1;
  return erank(a) - erank(b);
}

static i32 vertical_first_cmp(i32 a, i32 b, const void *ctx) {
  i32 af = efrom(a), at = eto(a), bf = efrom(b), bt = eto(b);
  f64 aspan = fabs_(((at >= 0 ? iy(at) : 0.0) + (at >= 0 ? ih(at) : 0.0) / 2.0) - ((af >= 0 ? iy(af) : 0.0) + (af >= 0 ? ih(af) : 0.0) / 2.0));
  f64 bspan = fabs_(((bt >= 0 ? iy(bt) : 0.0) + (bt >= 0 ? ih(bt) : 0.0) / 2.0) - ((bf >= 0 ? iy(bf) : 0.0) + (bf >= 0 ? ih(bf) : 0.0) / 2.0));
  f64 d = bspan - aspan;
  if (d != 0.0 && !isnan_(d)) return d < 0 ? -1 : 1;
  return base_cmp(a, b, ctx);
}

/* ------------------------------------------------------------------ the cheap route */

typedef struct { f64 b[3]; i32 n; f64 base; } Cand;


/* The points of candidate c (bends: none, a lane x, or x1, a channel y and x2) into pts; returns the count. */
static i32 cand_points(const Cand *c, Pt source_fan, Pt target_fan, Pt *pts) {
  if (c->n == 0) {
    pts[0] = source_fan;
    pts[1] = target_fan;
    return 2;
  }
  if (c->n == 1) {
    pts[0] = source_fan;
    pts[1].x = c->b[0]; pts[1].y = source_fan.y;
    pts[2].x = c->b[0]; pts[2].y = target_fan.y;
    pts[3] = target_fan;
    return 4;
  }
  pts[0] = source_fan;
  pts[1].x = c->b[0]; pts[1].y = source_fan.y;
  pts[2].x = c->b[0]; pts[2].y = c->b[1];
  pts[3].x = c->b[2]; pts[3].y = c->b[1];
  pts[4].x = c->b[2]; pts[4].y = target_fan.y;
  pts[5] = target_fan;
  return 6;
}

static i32 cand_before(const Cand *c, i32 i, i32 j) { return c[i].base < c[j].base || (c[i].base == c[j].base && i < j); }

static void cand_sift(const Cand *c, i32 *heap, i32 at, i32 size) {
  i32 value = heap[at];
  for (;;) {
    i32 left = 2 * at + 1;
    if (left >= size) break;
    i32 child = (left + 1 < size && cand_before(c, heap[left + 1], heap[left])) ? left + 1 : left;
    if (!cand_before(c, heap[child], value)) break;
    heap[at] = heap[child];
    at = child;
  }
  heap[at] = value;
}

static i32 segment_hits_item_pt(Pt a, Pt b, i32 item, f64 padding) {
  f64 left = ix(item) - padding;
  f64 right = ix(item) + iw(item) + padding;
  f64 top = iy(item) - padding;
  f64 bottom = iy(item) + ih(item) + padding;
  if (fabs_(a.x - b.x) < 0.001) {
    if (a.x <= left || a.x >= right) return 0;
    f64 lo = jmin(a.y, b.y), hi = jmax(a.y, b.y);
    return hi > top && lo < bottom;
  }
  if (fabs_(a.y - b.y) < 0.001) {
    if (a.y <= top || a.y >= bottom) return 0;
    f64 lo = jmin(a.x, b.x), hi = jmax(a.x, b.x);
    return hi > left && lo < right;
  }
  return 0;
}

/* cheapRouteBody(): the cheapest clear one of a few candidates. The route is returned as a body (source fan to target fan). */
static i32 cheap_body(i32 edge, Pt source_fan, Pt target_fan, i32 direction, Pt *out, i32 skip) {
  const f64 padding = 14.0;
  f64 left = jmin(source_fan.x, target_fan.x);
  f64 right = jmax(source_fan.x, target_fan.x);
  i32 *obst = TAKE(i32, NI);
  if (failed) return 0;
  i32 no = 0;
  for (i32 i = 0; i < NI; i++) {
    if (i == efrom(edge) || i == eto(edge)) continue;
    if (ix(i) + iw(i) + padding > left - 30.0 && ix(i) - padding < right + 30.0) obst[no++] = i;
  }
  f64 source_y = source_fan.y, target_y = target_fan.y;
  f64 low_y = jmin(source_y, target_y), high_y = jmax(source_y, target_y);
  i32 cap = 1 + (no * 2 + 2) * 5 + (n_between + 12) * 4;
  Cand *cands = TAKE(Cand, cap);
  if (failed) return 0;
  i32 nc = 0;
  Pt kept[6], pts[6];
#define ADD_CAND(n_, b0_, b1_, b2_) do { \
    Cand *c_ = &cands[nc]; c_->n = (n_); c_->b[0] = (b0_); c_->b[1] = (b1_); c_->b[2] = (b2_); \
    i32 np_ = cand_points(c_, source_fan, target_fan, pts); \
    i32 m_ = compress_into(pts, np_, kept); \
    f64 length_ = 0.0; \
    for (i32 q_ = 0; q_ + 1 < m_; q_++) length_ += hypot_(kept[q_ + 1].x - kept[q_].x, kept[q_ + 1].y - kept[q_].y); \
    i32 turns_ = 0; \
    for (i32 q_ = 1; q_ + 1 < m_; q_++) if ((fabs_(kept[q_ - 1].x - kept[q_].x) < 0.001) != (fabs_(kept[q_].x - kept[q_ + 1].x) < 0.001)) turns_++; \
    c_->base = jmax(length_, 0.0001) + (f64)turns_ * 220.0; \
    nc++; \
  } while (0)
  if (fabs_(source_y - target_y) < 0.001) ADD_CAND(0, 0.0, 0.0, 0.0);
  f64 *lane_xs = TAKE(f64, 2 + no * 2);
  if (failed) return 0;
  i32 nl = 0;
  lane_xs[nl++] = source_fan.x + (f64)direction * 18.0;
  lane_xs[nl++] = target_fan.x - (f64)direction * 18.0;
  for (i32 k = 0; k < no; k++) {
    lane_xs[nl++] = ix(obst[k]) - padding - 6.0;
    lane_xs[nl++] = ix(obst[k]) + iw(obst[k]) + padding + 6.0;
  }
  static const f64 SHIFTS[5] = { 0.0, 8.0, -8.0, 16.0, -16.0 };
  for (i32 b = 0; b < nl; b++) {
    for (i32 s = 0; s < 5; s++) {
      f64 x = lane_xs[b] + SHIFTS[s];
      if (x < left - 0.001 || x > right + 0.001) continue;
      ADD_CAND(1, x, 0.0, 0.0);
    }
  }
  f64 top = low_y, bottom = high_y;
  for (i32 k = 0; k < no; k++) {
    i32 it = obst[k];
    if (iy(it) - padding >= high_y || iy(it) + ih(it) + padding <= low_y) continue;
    top = jmin(top, iy(it));
    bottom = jmax(bottom, iy(it) + ih(it));
  }
  i32 nch = n_between + 12;
  f64 *channels = TAKE(f64, nch);
  if (failed) return 0;
  for (i32 k = 0; k < n_between; k++) channels[k] = between_ys[k];
  i32 at = n_between;
  for (i32 k = 0; k < 6; k++) {
    channels[at++] = top - padding - 10.0 - (f64)k * 8.0;
    channels[at++] = bottom + padding + 10.0 + (f64)k * 8.0;
  }
  for (i32 c = 0; c < nch; c++) {
    for (i32 k = 0; k < 4; k++) {
      f64 x1 = source_fan.x + (f64)direction * (f64)k * 8.0;
      f64 x2 = target_fan.x - (f64)direction * (f64)k * 8.0;
      if ((f64)direction * (x2 - x1) < 0) continue;
      ADD_CAND(3, x1, channels[c], x2);
    }
  }
#undef ADD_CAND
  i32 *heap = TAKE(i32, nc);
  if (failed) return 0;
  for (i32 i = 0; i < nc; i++) heap[i] = i;
  i32 size = nc;
  for (i32 i = (size >> 1) - 1; i >= 0; i--) cand_sift(cands, heap, i, size);
  Pt best[6], route[6];
  i32 nbest = 0;
  f64 best_cost = INF;
  i32 scored = 0;
  grid_sync();
  while (size > 0) {
    i32 next = heap[0];
    size -= 1;
    heap[0] = heap[size];
    cand_sift(cands, heap, 0, size);
    f64 base = cands[next].base;
    if (base >= best_cost || scored >= 24) break;
    i32 np = cand_points(&cands[next], source_fan, target_fan, pts);
    i32 nr = compress_into(pts, np, route);
    i32 clear = 1;
    for (i32 i = 0; i + 1 < nr && clear; i++)
      for (i32 k = 0; k < no; k++) if (segment_hits_item_pt(route[i], route[i + 1], obst[k], padding)) { clear = 0; break; }
    if (!clear) continue;
    scored += 1;
    f64 cost = base;
    for (i32 i = 0; i + 1 < nr && cost < best_cost; i++)
      cost += grid_penalty(route[i].x, route[i].y, route[i + 1].x, route[i + 1].y, edge, 0, best_cost - cost, skip);
    if (cost < best_cost) {
      best_cost = cost;
      nbest = nr;
      for (i32 i = 0; i < nr; i++) best[i] = route[i];
    }
  }
  if (nbest) {
    for (i32 i = 0; i < nbest; i++) out[i] = best[i];
    return nbest;
  }
  Pt fb[4];
  fb[0] = source_fan;
  fb[1].x = source_fan.x + (f64)direction * 18.0; fb[1].y = source_y;
  fb[2].x = source_fan.x + (f64)direction * 18.0; fb[2].y = target_y;
  fb[3] = target_fan;
  return compress_into(fb, 4, out);
}

/* ------------------------------------------------------------------ the A* route of one edge */

/* The sparse grid and its search, for the edge `edge`, against the segments segs[0, nsegs) minus route `skip`.
   Returns the route (ports, fans, body) or an empty route (n == 0) after a failure (failed set). */

typedef struct {
  f64 *f, *cost;
  i32 *state, *heap;
  i32 cap, size, serial;
} Queue;

static void queue_init(Queue *q) {
  q->cap = 1024;
  q->f = TAKE(f64, q->cap);
  q->cost = TAKE(f64, q->cap);
  q->state = TAKE(i32, q->cap);
  q->heap = TAKE(i32, q->cap);
  q->size = 0;
  q->serial = 0;
}

static void queue_grow(Queue *q) {
  i32 cap = q->cap * 2;
  f64 *f = TAKE(f64, cap), *cost = TAKE(f64, cap);
  i32 *state = TAKE(i32, cap), *heap = TAKE(i32, cap);
  if (failed) return;
  for (i32 i = 0; i < q->cap; i++) { f[i] = q->f[i]; cost[i] = q->cost[i]; state[i] = q->state[i]; heap[i] = q->heap[i]; }
  q->f = f; q->cost = cost; q->state = state; q->heap = heap; q->cap = cap;
}

static void queue_push(Queue *q, i32 s, f64 c, f64 value) {
  if (q->serial == q->cap) { queue_grow(q); if (failed) return; }
  i32 n = q->serial++;
  q->f[n] = value;
  q->state[n] = s;
  q->cost[n] = c;
  i32 i = q->size++;
  while (i > 0) {
    i32 parent = (i - 1) >> 1;
    i32 p = q->heap[parent];
    if (!(value < q->f[p] || (value == q->f[p] && n < p))) break;
    q->heap[i] = p;
    i = parent;
  }
  q->heap[i] = n;
}

static i32 queue_pop(Queue *q) {
  i32 top = q->heap[0];
  i32 last = q->heap[--q->size];
  if (q->size) {
    f64 last_f = q->f[last];
    i32 i = 0;
    for (;;) {
      i32 left = 2 * i + 1;
      if (left >= q->size) break;
      i32 child = left;
      i32 c = q->heap[left];
      if (left + 1 < q->size) {
        i32 r = q->heap[left + 1];
        if (q->f[r] < q->f[c] || (q->f[r] == q->f[c] && r < c)) { child = left + 1; c = r; }
      }
      if (!(q->f[c] < last_f || (q->f[c] == last_f && c < last))) break;
      q->heap[i] = c;
      i = child;
    }
    q->heap[i] = last;
  }
  return top;
}

/* uniqueSorted(): the finite values sorted, then each kept when more than 0.01 above the one before it. */
static i32 unique_sorted(f64 *v, i32 n) {
  i32 m = 0;
  for (i32 i = 0; i < n; i++) if (v[i] == v[i] && v[i] != INF && v[i] != -INF) v[m++] = v[i];
  sort_f64(v, m);
  i32 out = 0;
  for (i32 i = 0; i < m; i++) {
    if (i == 0 || fabs_(v[i] - v[i - 1]) > 0.01) v[out++] = v[i];
  }
  return out;
}

static i32 index_of(const f64 *v, i32 n, f64 x) {
  i32 lo = 0, hi = n;
  while (lo < hi) {
    i32 mid = (lo + hi) >> 1;
    if (v[mid] < x) lo = mid + 1; else hi = mid;
  }
  return (lo < n && v[lo] == x) ? lo : -1;
}

static i32 first_above(const f64 *v, i32 n, f64 limit) {
  i32 lo = 0, hi = n;
  while (lo < hi) {
    i32 mid = (lo + hi) >> 1;
    if (v[mid] <= limit) lo = mid + 1; else hi = mid;
  }
  return lo;
}
static i32 first_at_least(const f64 *v, i32 n, f64 limit) {
  i32 lo = 0, hi = n;
  while (lo < hi) {
    i32 mid = (lo + hi) >> 1;
    if (v[mid] < limit) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* routeConflictPenalty(a, b, usedSegments, currentEdge): the plain scan of the fallbacks. */
static f64 scan_penalty(Pt a, Pt b, i32 edge, i32 skip) {
  f64 penalty = 0.0;
  for (i32 i = 0; i < nsegs; i++) {
    const Seg *s = &segs[i];
    if (s->route == skip) continue;
    if (segments_apart(a.x, a.y, b.x, b.y, s->ax, s->ay, s->bx, s->by, LANE_GAP)) continue;
    f64 value = conflict_term(a.x, a.y, b.x, b.y, s, edge);
    if (value != 0.0) penalty += value;
  }
  return penalty;
}


static Route route_edge(i32 edge, i32 skip) {
  Route result;
  result.p = 0;
  result.n = 0;
  const PortSet *port = &ports[edge];
  Pt source_port = port->a, target_port = port->b;
  Pt source_fan = port->a_fan, target_fan = port->b_fan;
  i32 direction = target_fan.x >= source_fan.x ? 1 : -1;
  const f64 horizontal_pad = 48.0;
  f64 vertical_pad = jmax(78.0, jmin(138.0, 72.0 + fabs_(target_fan.y - source_fan.y) * 0.12));
  f64 local_left = jmin(source_fan.x, target_fan.x) - horizontal_pad;
  f64 local_right = jmax(source_fan.x, target_fan.x) + horizontal_pad;
  f64 local_top = jmin(source_fan.y, target_fan.y) - vertical_pad;
  f64 local_bottom = jmax(source_fan.y, target_fan.y) + vertical_pad;
  const f64 padding = 14.0;

  if (bud_exhausted) {
    bud_cheap += 1;
    Pt *body = TAKE(Pt, 8);
    if (failed) return result;
    i32 nb = cheap_body(edge, source_fan, target_fan, direction, body, skip);
    return assemble(source_port, source_fan, body, nb, target_fan, target_port);
  }

  /* the obstacles of the corridor */
  i32 *obst = TAKE(i32, NI);
  if (failed) return result;
  i32 no = 0;
  for (i32 i = 0; i < NI; i++) {
    if (i == efrom(edge) || i == eto(edge)) continue;
    f64 r = ix(i) + iw(i);
    f64 b = iy(i) + ih(i);
    if (r >= local_left && ix(i) <= local_right && b >= local_top && iy(i) <= local_bottom) obst[no++] = i;
  }

  /* the grid lines */
  i32 xcap = 6 + no * 2 + nsegs * 2 + 8;
  i32 ycap = 4 + n_rows + n_between + no * 2 + nsegs * 2 + 8;
  f64 *gx = TAKE(f64, xcap);
  f64 *gy = TAKE(f64, ycap);
  if (failed) return result;
  i32 nx = 0, ny = 0;
  gx[nx++] = source_fan.x;
  gx[nx++] = target_fan.x;
  gx[nx++] = source_fan.x + (f64)direction * 18.0;
  gx[nx++] = target_fan.x - (f64)direction * 18.0;
  gx[nx++] = local_left;
  gx[nx++] = local_right;
  gy[ny++] = source_fan.y;
  gy[ny++] = target_fan.y;
  gy[ny++] = local_top;
  gy[ny++] = local_bottom;
  for (i32 i = 0; i < n_rows; i++) if (row_ys[i] >= local_top - 0.001 && row_ys[i] <= local_bottom + 0.001) gy[ny++] = row_ys[i];
  for (i32 i = 0; i < n_between; i++) if (between_ys[i] >= local_top - 0.001 && between_ys[i] <= local_bottom + 0.001) gy[ny++] = between_ys[i];
  i32 secondary = esec(edge);
  const f64 *lane_src = (secondary && n_between) ? between_sorted : rows_sorted;
  i32 n_lane = (secondary && n_between) ? n_between : n_rows;
  f64 lane_factor = secondary ? 1.35 : 0.55;
  for (i32 k = 0; k < no; k++) {
    i32 it = obst[k];
    gx[nx++] = ix(it) - padding;
    gx[nx++] = ix(it) + iw(it) + padding;
    gy[ny++] = iy(it) - padding;
    gy[ny++] = iy(it) + ih(it) + padding;
  }
  for (i32 i = 0; i < nsegs; i++) {
    const Seg *s = &segs[i];
    if (s->route == skip) continue;
    f64 min_x = jmin(s->ax, s->bx), max_x = jmax(s->ax, s->bx), min_y = jmin(s->ay, s->by), max_y = jmax(s->ay, s->by);
    if (max_x < local_left || min_x > local_right || max_y < local_top || min_y > local_bottom) continue;
    if (fabs_(s->ax - s->bx) < 0.001) { gx[nx++] = s->ax - LANE_GAP; gx[nx++] = s->ax + LANE_GAP; }
    if (fabs_(s->ay - s->by) < 0.001) { gy[ny++] = s->ay - LANE_GAP; gy[ny++] = s->ay + LANE_GAP; }
  }
  nx = unique_sorted(gx, nx);
  ny = unique_sorted(gy, ny);
  /* a corridor of thousands of rows: a plain H-V-H route */
  if ((double)nx * (double)ny > (double)ROUTE_GRID_POINT_BUDGET) {
    f64 mid_x = source_fan.x + (target_fan.x - source_fan.x) / 2.0;
    Pt raw[4], body[4];
    raw[0] = source_fan;
    raw[1].x = mid_x; raw[1].y = source_fan.y;
    raw[2].x = mid_x; raw[2].y = target_fan.y;
    raw[3] = target_fan;
    i32 nb = compress_into(raw, 4, body);
    return assemble(source_port, source_fan, body, nb, target_fan, target_port);
  }
  f64 vertical_delta = target_fan.y - source_fan.y;
  i32 vertical_direction = vertical_delta < -0.001 ? -1 : (vertical_delta > 0.001 ? 1 : 0);
  /* sameRowNeedsDetour: clearSegment(sourceFan, targetFan) is false */
  i32 same_row_detour = 0;
  if (vertical_direction == 0) {
    for (i32 k = 0; k < no; k++) if (segment_hits_item_pt(source_fan, target_fan, obst[k], padding)) { same_row_detour = 1; break; }
  }

  i32 ix_start = index_of(gx, nx, source_fan.x), iy_start = index_of(gy, ny, source_fan.y);
  i32 ix_end = index_of(gx, nx, target_fan.x), iy_end = index_of(gy, ny, target_fan.y);
  if (!(ix_start >= 0 && iy_start >= 0 && ix_end >= 0 && iy_end >= 0)) { fail(RT_NEEDS_JS); return result; }

  /* ---- searchIndexedGrid */
  i32 NX = nx, NY = ny;
  i32 total = NX * NY;
  u8 *blocked = TAKE(u8, total);
  i32 *lnk[4];
  for (i32 k = 0; k < 4; k++) lnk[k] = TAKE(i32, total);
  f64 *best = TAKE(f64, total * 3);
  i32 *previous = TAKE(i32, total * 3);
  f64 *conflict_memo = TAKE(f64, total * 4);
  f64 *lane_at = TAKE(f64, NY);
  if (failed) return result;
  for (i32 i = 0; i < total; i++) blocked[i] = 0;
  for (i32 k = 0; k < 4; k++) for (i32 i = 0; i < total; i++) lnk[k][i] = -1;
  for (i32 i = 0; i < total * 3; i++) { best[i] = INF; previous[i] = -1; }
  for (i32 i = 0; i < total * 4; i++) conflict_memo[i] = __builtin_nan("");
  for (i32 i = 0; i < NY; i++) lane_at[i] = __builtin_nan("");
  f64 inner = padding - 0.5;
  for (i32 k = 0; k < no; k++) {
    i32 it = obst[k];
    i32 x0 = first_above(gx, NX, ix(it) - inner);
    i32 x1 = first_at_least(gx, NX, ix(it) + iw(it) + inner) - 1;
    i32 y0 = first_above(gy, NY, iy(it) - inner);
    i32 y1 = first_at_least(gy, NY, iy(it) + ih(it) + inner) - 1;
    for (i32 a = x0; a <= x1; a++) {
      i32 base = a * NY;
      for (i32 b = y0; b <= y1; b++) blocked[base + b] = 1;
    }
  }
  i32 start = ix_start * NY + iy_start;
  i32 end = ix_end * NY + iy_end;
  blocked[start] = 0;
  blocked[end] = 0;
  i32 *cutting = TAKE(i32, no);
  if (failed) return result;
  for (i32 b = 0; b < NY; b++) {
    f64 y = gy[b];
    i32 nc = 0;
    for (i32 k = 0; k < no; k++) {
      i32 it = obst[k];
      if (!(y <= iy(it) - padding || y >= iy(it) + ih(it) + padding)) cutting[nc++] = it;
    }
    i32 prev_ix = -1;
    for (i32 a = 0; a < NX; a++) {
      i32 id = a * NY + b;
      if (blocked[id]) continue;
      if (prev_ix >= 0) {
        f64 lo = gx[prev_ix], hi = gx[a];
        i32 clear = 1;
        for (i32 c = 0; c < nc; c++) {
          i32 it = cutting[c];
          if (hi > ix(it) - padding && lo < ix(it) + iw(it) + padding) { clear = 0; break; }
        }
        if (clear) {
          i32 prev_id = prev_ix * NY + b;
          lnk[1][prev_id] = id;
          lnk[0][id] = prev_id;
        }
      }
      prev_ix = a;
    }
  }
  for (i32 a = 0; a < NX; a++) {
    f64 x = gx[a];
    i32 nc = 0;
    for (i32 k = 0; k < no; k++) {
      i32 it = obst[k];
      if (!(x <= ix(it) - padding || x >= ix(it) + iw(it) + padding)) cutting[nc++] = it;
    }
    i32 base = a * NY;
    i32 prev_iy = -1;
    for (i32 b = 0; b < NY; b++) {
      i32 id = base + b;
      if (blocked[id]) continue;
      if (prev_iy >= 0) {
        f64 lo = gy[prev_iy], hi = gy[b];
        i32 clear = 1;
        for (i32 c = 0; c < nc; c++) {
          i32 it = cutting[c];
          if (hi > iy(it) - padding && lo < iy(it) + ih(it) + padding) { clear = 0; break; }
        }
        if (clear) {
          lnk[3][base + prev_iy] = id;
          lnk[2][id] = base + prev_iy;
        }
      }
      prev_iy = b;
    }
  }

  Queue q;
  queue_init(&q);
  if (failed) return result;
  best[start * 3] = 0.0;
  f64 target_x = target_fan.x, target_y = target_fan.y;
  queue_push(&q, start * 3, 0.0, 0.0 + (fabs_(gx[start / NY] - target_x) + fabs_(gy[start % NY] - target_y)));
  i32 final_state = -1;
  f64 relaxations = 0.0;
  f64 step_cap = jmin(bud_search, bud_max - bud_used);
  i32 stopped = 0;
  /* the sorted lane lanes for the horizontal lane penalty */
  while (q.size) {
    i32 entry = queue_pop(&q);
    i32 current_state = q.state[entry];
    f64 current_cost = q.cost[entry];
    if (current_cost != best[current_state]) continue;
    i32 id = current_state / 3;
    if (id == end) { final_state = current_state; break; }
    if (relaxations > step_cap) {
      bud_used += relaxations;
      if (bud_used >= bud_max) bud_exhausted = 1;
      stopped = 1;
      break;
    }
    i32 current_dir = current_state % 3;
    f64 cx = gx[id / NY];
    f64 cy = gy[id % NY];
    for (i32 k = 0; k < 4; k++) {
      i32 next_id = lnk[k][id];
      if (next_id < 0) continue;
      relaxations += 1.0;
      i32 dir = k < 2 ? 1 : 2;
      i32 n_iy = next_id % NY;
      f64 nxv = gx[next_id / NY];
      f64 nyv = gy[n_iy];
      f64 length = fabs_(cx - nxv) + fabs_(cy - nyv);
      f64 dx = nxv - cx;
      f64 dy = nyv - cy;
      if (direction > 0 && dx < -0.001) continue;
      if (direction < 0 && dx > 0.001) continue;
      if (dir == 2) {
        if (vertical_direction < 0) {
          if (dy > 0.001 || nyv < target_y - 0.001) continue;
        } else if (vertical_direction > 0) {
          if (dy < -0.001 || nyv > target_y + 0.001) continue;
        } else if (!same_row_detour && fabs_(dy) > 0.001) {
          continue;
        }
      }
      f64 bend = (current_dir != 0 && current_dir != dir) ? 220.0 : 0.0;
      f64 reverse = (dir == 1 && (f64)direction * (nxv - cx) < -0.001) ? 1400.0 : 0.0;
      f64 boundary = (nxv < local_left - 0.01 || nxv > local_right + 0.01 || nyv < local_top - 0.01 || nyv > local_bottom + 0.01) ? 20000.0 : 0.0;
      f64 lane = 0.0;
      if (dir == 1) {
        lane = lane_at[n_iy];
        if (lane != lane) {
          /* horizontalLanePenalty(y): the distance to the nearest preferred lane */
          if (n_lane == 0) lane = 0.0;
          else {
            i32 lo = 0, hi = n_lane;
            while (lo < hi) {
              i32 mid = (lo + hi) >> 1;
              if (lane_src[mid] < nyv) lo = mid + 1; else hi = mid;
            }
            f64 nearest = INF;
            if (lo < n_lane) nearest = fabs_(lane_src[lo] - nyv);
            if (lo > 0) nearest = jmin(nearest, fabs_(lane_src[lo - 1] - nyv));
            lane = nearest * lane_factor;
          }
          lane_at[n_iy] = lane;
        }
      }
      i32 next_state = next_id * 3 + dir;
      i32 slot = id * 4 + k;
      f64 conflict = conflict_memo[slot];
      if (conflict != conflict) {
        if (current_cost + length + bend + reverse + boundary + lane + 0.001 >= best[next_state]) continue;
        conflict = grid_penalty(cx, cy, nxv, nyv, edge, 1, INF, skip);
        conflict_memo[slot] = conflict;
      }
      f64 cost = current_cost + length + bend + conflict + reverse + boundary + lane;
      if (cost + 0.001 >= best[next_state]) continue;
      best[next_state] = cost;
      previous[next_state] = current_state;
      queue_push(&q, next_state, cost, cost + (fabs_(nxv - target_x) + fabs_(nyv - target_y)));
      if (failed) return result;
    }
  }
  if (stopped) {
    bud_cheap += 1;
    Pt *body = TAKE(Pt, 8);
    if (failed) return result;
    i32 nb = cheap_body(edge, source_fan, target_fan, direction, body, skip);
    return assemble(source_port, source_fan, body, nb, target_fan, target_port);
  }
  bud_used += relaxations;
  if (bud_used >= bud_max) bud_exhausted = 1;

  Pt *body = 0;
  i32 nbody = 0;
  if (final_state >= 0) {
    i32 count = 0;
    for (i32 s = final_state; s >= 0; s = previous[s]) count++;
    Pt *raw = TAKE(Pt, count);
    body = TAKE(Pt, count);
    if (failed) return result;
    i32 at = count;
    for (i32 s = final_state; s >= 0; s = previous[s]) {
      i32 pid = s / 3;
      raw[--at].x = gx[pid / NY];
      raw[at].y = gy[pid % NY];
    }
    nbody = compress_into(raw, count, body);
  } else {
    /* no path: the fallback bodies */
    body = TAKE(Pt, 8);
    if (failed) return result;
    if (vertical_direction != 0) {
      f64 min_x = jmin(source_fan.x, target_fan.x) - 0.001;
      f64 max_x = jmax(source_fan.x, target_fan.x) + 0.001;
      f64 mid = (source_fan.x + target_fan.x) / 2.0;
      i32 *cand_x = TAKE(i32, NX);
      if (failed) return result;
      i32 ncx = 0;
      for (i32 i = 0; i < NX; i++) if (gx[i] >= min_x && gx[i] <= max_x) cand_x[ncx++] = i;
      /* stable sort by distance to the middle */
      for (i32 i = 1; i < ncx; i++) {
        i32 v = cand_x[i];
        f64 dv = fabs_(gx[v] - mid);
        i32 at = i;
        for (; at > 0 && fabs_(gx[cand_x[at - 1]] - mid) - dv > 0.0; at--) cand_x[at] = cand_x[at - 1];
        cand_x[at] = v;
      }
      Route best_route;
      best_route.p = 0;
      best_route.n = 0;
      f64 best_score = INF;
      Pt raw[4], comp[4];
      for (i32 c = 0; c < ncx; c++) {
        f64 lane_x = gx[cand_x[c]];
        raw[0] = source_fan;
        raw[1].x = lane_x; raw[1].y = source_fan.y;
        raw[2].x = lane_x; raw[2].y = target_fan.y;
        raw[3] = target_fan;
        i32 m = compress_into(raw, 4, comp);
        i32 ok = 1;
        for (i32 i = 0; i + 1 < m && ok; i++)
          for (i32 k = 0; k < no; k++) if (segment_hits_item_pt(comp[i], comp[i + 1], obst[k], padding)) { ok = 0; break; }
        if (!ok) continue;
        f64 sc = polyline_total(comp, m) + (f64)bend_count(comp, m) * 220.0;
        f64 sum = 0.0;
        for (i32 i = 0; i + 1 < m; i++) sum += scan_penalty(comp[i], comp[i + 1], edge, skip);
        sc = sc + sum;
        /* candidates.sort((a, b) => score(a) - score(b)): the stable first of the lowest */
        if (sc < best_score) {
          best_score = sc;
          best_route.p = body;
          best_route.n = m;
          for (i32 i = 0; i < m; i++) body[i] = comp[i];
        }
      }
      if (best_route.n) nbody = best_route.n;
      else {
        raw[0] = source_fan;
        raw[1].x = source_fan.x + (f64)direction * 18.0; raw[1].y = source_fan.y;
        raw[2].x = source_fan.x + (f64)direction * 18.0; raw[2].y = target_fan.y;
        raw[3] = target_fan;
        nbody = compress_into(raw, 4, body);
      }
    } else {
      f64 fallback_top = jmin(local_top, INF);
      f64 fallback_bottom = jmax(local_bottom, -INF);
      for (i32 k = 0; k < no; k++) {
        fallback_top = jmin(fallback_top, iy(obst[k]) - padding - 24.0);
        fallback_bottom = jmax(fallback_bottom, iy(obst[k]) + ih(obst[k]) + padding + 24.0);
      }
      f64 channels[2];
      channels[0] = fallback_top;
      channels[1] = fallback_bottom;
      Route best_route;
      best_route.n = 0;
      f64 best_score = INF;
      Pt raw[6], comp[6];
      for (i32 c = 0; c < 2; c++) {
        f64 channel_y = channels[c];
        raw[0] = source_fan;
        raw[1].x = source_fan.x + (f64)direction * 18.0; raw[1].y = source_fan.y;
        raw[2].x = source_fan.x + (f64)direction * 18.0; raw[2].y = channel_y;
        raw[3].x = target_fan.x - (f64)direction * 18.0; raw[3].y = channel_y;
        raw[4].x = target_fan.x - (f64)direction * 18.0; raw[4].y = target_fan.y;
        raw[5] = target_fan;
        i32 m = compress_into(raw, 6, comp);
        i32 ok = 1;
        for (i32 i = 0; i + 1 < m && ok; i++)
          for (i32 k = 0; k < no; k++) if (segment_hits_item_pt(comp[i], comp[i + 1], obst[k], padding)) { ok = 0; break; }
        if (!ok) continue;
        f64 sc = polyline_total(comp, m) + (f64)bend_count(comp, m) * 220.0;
        f64 sum = 0.0;
        for (i32 i = 0; i + 1 < m; i++) sum += scan_penalty(comp[i], comp[i + 1], edge, skip);
        sc = sc + sum;
        if (sc < best_score) {
          best_score = sc;
          best_route.n = m;
          for (i32 i = 0; i < m; i++) body[i] = comp[i];
        }
      }
      if (best_route.n) nbody = best_route.n;
      else {
        raw[0] = source_fan;
        raw[1].x = source_fan.x + (f64)direction * 18.0; raw[1].y = source_fan.y;
        raw[2].x = source_fan.x + (f64)direction * 18.0; raw[2].y = fallback_top;
        raw[3].x = target_fan.x - (f64)direction * 18.0; raw[3].y = fallback_top;
        raw[4].x = target_fan.x - (f64)direction * 18.0; raw[4].y = target_fan.y;
        raw[5] = target_fan;
        nbody = compress_into(raw, 6, body);
      }
    }
  }
  return assemble(source_port, source_fan, body, nbody, target_fan, target_port);
}

/* ------------------------------------------------------------------ the route set and its score */

typedef struct {
  i32 edge;
  Route route;
  i32 seg0, nseg;        /* its segments in segs */
  i32 *pj;               /* pairs with later routes: route positions (sorted) */
  f64 *pv;
  i32 np;
  f64 own0, own1;        /* length * 0.02, bends * 180 */
} Entry;

static Entry *set;
static i32 nset;

static void add_segments(i32 entry_at, i32 edge, const Route *r, i32 route_pos) {
  Entry *en = &set[entry_at];
  en->seg0 = nsegs;
  i32 count = r->n > 0 ? r->n - 1 : 0;
  for (i32 i = 0; i < count; i++) {
    if (nsegs >= segcap) { fail(RT_NEEDS_JS); return; }
    Seg *s = &segs[nsegs++];
    s->ax = r->p[i].x; s->ay = r->p[i].y; s->bx = r->p[i + 1].x; s->by = r->p[i + 1].y;
    s->edge = edge; s->from = efrom(edge); s->to = eto(edge); s->index = i; s->route = route_pos;
  }
  en->nseg = count;
}

/* segmentPairConflict(a, edgeA, b, edgeB) with orthogonalSegmentConflict(). */
static f64 pair_conflict(const Seg *a, const Seg *b) {
  if (segments_apart(a->ax, a->ay, a->bx, a->by, b->ax, b->ay, b->bx, b->by, LANE_GAP)) return 0.0;
  f64 crossings = 0.0, overlap = 0.0, near = 0.0;
  i32 a_vertical = fabs_(a->ax - a->bx) < 0.001;
  i32 c_vertical = fabs_(b->ax - b->bx) < 0.001;
  if (a_vertical != c_vertical) {
    f64 vax = a_vertical ? a->ax : b->ax;
    f64 vay = a_vertical ? a->ay : b->ay;
    f64 vby = a_vertical ? a->by : b->by;
    f64 hax = a_vertical ? b->ax : a->ax;
    f64 hay = a_vertical ? b->ay : a->ay;
    f64 hbx = a_vertical ? b->bx : a->bx;
    f64 x = vax, y = hay;
    if ((x > jmin(hax, hbx) + 0.001 && x < jmax(hax, hbx) - 0.001) && (y > jmin(vay, vby) + 0.001 && y < jmax(vay, vby) - 0.001)) crossings = 1.0;
  } else {
    f64 gap = a_vertical ? fabs_(a->ax - b->ax) : fabs_(a->ay - b->ay);
    if (gap >= LANE_GAP - 0.001) return 0.0;
    f64 shared = a_vertical
      ? jmax(0.0, jmin(jmax(a->ay, a->by), jmax(b->ay, b->by)) - jmax(jmin(a->ay, a->by), jmin(b->ay, b->by)))
      : jmax(0.0, jmin(jmax(a->ax, a->bx), jmax(b->ax, b->bx)) - jmax(jmin(a->ax, a->bx), jmin(b->ax, b->bx)));
    if (gap > 0.001) near = shared; else overlap = shared;
  }
  if (crossings) return crossings * 28000.0;
  if (near > 0.5) return NEAR_BASE + near * NEAR_PER_PX;
  if (overlap > 0.5 && !(shared_port_overlap_allowed(a->ax, a->ay, a->bx, a->by, a->edge, b) || shared_port_overlap_allowed(b->ax, b->ay, b->bx, b->by, b->edge, a))) {
    return 1000000000.0 + overlap * 100000.0;
  }
  return 0.0;
}

typedef struct { i32 j, k, other; f64 term; } PairTerm;

/* Builds, for set entry i, its pair conflicts with later routes (scoredRouteSet). Terms of one pair are added in the
   order of the pairwise loops: the earlier route's segments first, then the other's, ascending. */
static void build_pairs(void) {
  for (i32 i = 0; i < nset; i++) {
    Entry *en = &set[i];
    en->np = 0;
    en->pj = 0;
    en->pv = 0;
    /* collect (j, k, other index, term) */
    i32 cap = 64, n = 0;
    PairTerm *terms = TAKE(PairTerm, cap);
    if (failed) return;
    for (i32 k = 0; k < en->nseg; k++) {
      i32 sid = en->seg0 + k;
      const Seg *s = &segs[sid];
      i32 count = grid_gather(s->ax, s->ay, s->bx, s->by);
      /* ascending segment ids */
      sort_i32(found_buf, count);
      for (i32 c = 0; c < count; c++) {
        i32 oid = found_buf[c];
        const Seg *o = &segs[oid];
        i32 j = o->route;
        if (j <= i) continue;
        f64 term = pair_conflict(s, o);
        if (term == 0.0) continue;
        if (n == cap) {
          PairTerm *bigger = TAKE(PairTerm, cap * 2);
          if (failed) return;
          for (i32 t = 0; t < n; t++) bigger[t] = terms[t];
          terms = bigger;
          cap *= 2;
        }
        terms[n].j = j; terms[n].k = k; terms[n].other = oid; terms[n].term = term;
        n++;
      }
    }
    if (!n) continue;
    /* group by j in ascending order, the terms of one j in the order found */
    i32 *js = TAKE(i32, n);
    f64 *vs = TAKE(f64, n);
    if (failed) return;
    i32 m = 0;
    for (i32 t = 0; t < n; t++) {
      i32 j = terms[t].j;
      i32 at = -1;
      for (i32 q = 0; q < m; q++) if (js[q] == j) { at = q; break; }
      if (at < 0) {
        /* insert keeping js sorted */
        at = m;
        while (at > 0 && js[at - 1] > j) { js[at] = js[at - 1]; vs[at] = vs[at - 1]; at--; }
        js[at] = j;
        vs[at] = 0.0;
        m++;
      }
      vs[at] = vs[at] + terms[t].term;
    }
    en->pj = js;
    en->pv = vs;
    en->np = m;
  }
}


static f64 own0_of(const Route *r) { return polyline_total(r->p, r->n) * 0.02; }
static f64 own1_of(const Route *r) { return (f64)bend_count(r->p, r->n) * 180.0; }

/* setScore(set) or, with a swap, setScore(set, { at, points, pairs }): swap_pj / swap_pv: the pairs of the new route
   `swap_at` with every other route (ascending). */
static f64 set_score(i32 swap_at, const Route *swap_route, const i32 *swap_pj, const f64 *swap_pv, i32 swap_np, f64 swap_own0, f64 swap_own1) {
  f64 score = 0.0;
  for (i32 i = 0; i < nset; i++) {
    const Entry *en = &set[i];
    if (swap_at >= 0 && swap_at == i) {
      score += swap_own0;
      score += swap_own1;
      for (i32 q = 0; q < swap_np; q++) if (swap_pj[q] > i) score += swap_pv[q];
      continue;
    }
    score += en->own0;
    score += en->own1;
    if (swap_at >= 0 && i < swap_at) {
      /* the row without swap_at, plus the swap's pair with i, in route order */
      i32 inserted = 0;
      f64 swap_value = 0.0;
      for (i32 q = 0; q < swap_np; q++) if (swap_pj[q] == i) { inserted = 1; swap_value = swap_pv[q]; break; }
      i32 used = 0;
      for (i32 q = 0; q < en->np; q++) {
        i32 j = en->pj[q];
        if (j == swap_at) continue;
        if (inserted && !used && swap_at < j) { score += swap_value; used = 1; }
        score += en->pv[q];
      }
      if (inserted && !used) score += swap_value;
      continue;
    }
    for (i32 q = 0; q < en->np; q++) score += en->pv[q];
  }
  (void)swap_route;
  return score;
}

/* Rebuilds segs, the grid and the pairs from the entries (the routes in order). */
static void rebuild_set(void) {
  nsegs = 0;
  grid_clear();
  for (i32 i = 0; i < nset; i++) {
    add_segments(i, set[i].edge, &set[i].route, i);
    if (failed) return;
  }
  grid_sync();
  build_pairs();
  for (i32 i = 0; i < nset; i++) {
    set[i].own0 = own0_of(&set[i].route);
    set[i].own1 = own1_of(&set[i].route);
  }
}

/* ------------------------------------------------------------------ the run */


#define MAX_ROUTE_POINTS 512
static Pt route_save[MAX_ROUTE_POINTS];

/* The route of a search outlives the arena scope of that search: copy it past the mark. */
static Route keep_route(Route r, i32 mark) {
  if (r.n > MAX_ROUTE_POINTS) { fail(RT_NEEDS_JS); r.n = 0; return r; }
  for (i32 i = 0; i < r.n; i++) route_save[i] = r.p[i];
  wasm_release((usize)mark);
  Pt *keep = TAKE(Pt, r.n);
  if (failed) { r.n = 0; return r; }
  for (i32 i = 0; i < r.n; i++) keep[i] = route_save[i];
  r.p = keep;
  return r;
}

/* buildRouteCandidate(): routes the edges in `ordered`; the routes go to entries of the set. */
static void build_candidate(const i32 *ordered, i32 n) {
  nsegs = 0;
  grid_clear();
  nset = 0;
  for (i32 k = 0; k < n; k++) {
    i32 e = ordered[k];
    if (!edge_ok(e)) continue;
    i32 mark = (i32)wasm_mark();
    Route r = route_edge(e, -1);
    if (failed) return;
    r = keep_route(r, mark);
    if (failed) return;
    Entry *en = &set[nset];
    en->edge = e;
    en->route = r;
    en->pj = 0; en->pv = 0; en->np = 0;
    add_segments(nset, e, &r, nset);
    if (failed) return;
    nset++;
    grid_sync();
  }
}


/* ------------------------------------------------------------------ the improvement passes */

static i32 *pos_of_edge;
static f64 *conflict_by_edge;

static i32 conflicted_cmp(i32 a, i32 b, const void *ctx) {
  (void)ctx;
  f64 d = conflict_by_edge[b] - conflict_by_edge[a];
  if (d != 0.0 && !isnan_(d)) return d < 0 ? -1 : 1;
  return erank(a) - erank(b);
}

typedef struct { i32 key0, key1, j; f64 term; } SwapTerm;

/* Entry by position -> route positions of the edges of the set. */
static void improve(void) {
  rebuild_set();
  if (failed) return;
  f64 score = set_score(-1, 0, 0, 0, 0, 0.0, 0.0);
  for (i32 e = 0; e < NE; e++) pos_of_edge[e] = -1;
  for (i32 i = 0; i < nset; i++) pos_of_edge[set[i].edge] = i;
  i32 *conflicted = TAKE(i32, NE);
  if (failed) return;
  for (i32 pass = 0; pass < 4 && !bud_exhausted; pass++) {
    for (i32 e = 0; e < NE; e++) conflict_by_edge[e] = 0.0;
    for (i32 i = 0; i < nset; i++) {
      const Entry *en = &set[i];
      for (i32 q = 0; q < en->np; q++) {
        f64 conflict = en->pv[q];
        conflict_by_edge[en->edge] = conflict_by_edge[en->edge] + conflict;
        conflict_by_edge[set[en->pj[q]].edge] = conflict_by_edge[set[en->pj[q]].edge] + conflict;
      }
    }
    for (i32 e = 0; e < NE; e++) conflicted[e] = e;
    sort_idx(conflicted, NE, conflicted_cmp, 0);
    i32 improved = 0;
    for (i32 c = 0; c < 8 && c < NE; c++) {
      i32 edge = conflicted[c];
      if (!(conflict_by_edge[edge] > 0.0)) break;
      if (bud_exhausted) break;
      if (!edge_ok(edge)) continue;
      i32 at = pos_of_edge[edge];
      if (at < 0) continue;
      i32 mark = (i32)wasm_mark();
      Route r = route_edge(edge, at);
      if (failed) return;
      /* swapPairs(): the pair conflicts of the new route with every other route */
      i32 nmine = r.n > 0 ? r.n - 1 : 0;
      i32 tcap = 64, tn = 0;
      SwapTerm *terms = TAKE(SwapTerm, tcap);
      if (failed) return;
      for (i32 k = 0; k < nmine; k++) {
        Seg mine;
        mine.ax = r.p[k].x; mine.ay = r.p[k].y; mine.bx = r.p[k + 1].x; mine.by = r.p[k + 1].y;
        mine.edge = edge; mine.from = efrom(edge); mine.to = eto(edge); mine.index = k; mine.route = at;
        i32 count = grid_gather(mine.ax, mine.ay, mine.bx, mine.by);
        sort_i32(found_buf, count);
        for (i32 q = 0; q < count; q++) {
          const Seg *o = &segs[found_buf[q]];
          if (o->route == at) continue;
          f64 term = pair_conflict(&mine, o);
          if (term == 0.0) continue;
          if (tn == tcap) {
            SwapTerm *bigger = TAKE(SwapTerm, tcap * 2);
            if (failed) return;
            for (i32 t = 0; t < tn; t++) bigger[t] = terms[t];
            terms = bigger;
            tcap *= 2;
          }
          terms[tn].j = o->route;
          terms[tn].key0 = o->route < at ? o->index : k;
          terms[tn].key1 = o->route < at ? k : o->index;
          terms[tn].term = term;
          tn++;
        }
      }
      /* per j: the terms in (key0, key1) order, summed; the js ascending */
      i32 *sj = TAKE(i32, tn + 1);
      f64 *sv = TAKE(f64, tn + 1);
      if (failed) return;
      i32 sn = 0;
      for (i32 t = 0; t < tn; t++) {
        i32 j = terms[t].j;
        i32 seen = 0;
        for (i32 q = 0; q < sn; q++) if (sj[q] == j) { seen = 1; break; }
        if (seen) continue;
        /* the terms of j, sorted by (key0, key1) */
        i32 m = 0;
        i32 *idx = TAKE(i32, tn);
        if (failed) return;
        for (i32 u = t; u < tn; u++) if (terms[u].j == j) idx[m++] = u;
        for (i32 a = 1; a < m; a++) {
          i32 v = idx[a], pos = a;
          for (; pos > 0 && (terms[idx[pos - 1]].key0 > terms[v].key0 || (terms[idx[pos - 1]].key0 == terms[v].key0 && terms[idx[pos - 1]].key1 > terms[v].key1)); pos--) idx[pos] = idx[pos - 1];
          idx[pos] = v;
        }
        f64 sum = 0.0;
        for (i32 a = 0; a < m; a++) sum += terms[idx[a]].term;
        i32 place = sn;
        while (place > 0 && sj[place - 1] > j) { sj[place] = sj[place - 1]; sv[place] = sv[place - 1]; place--; }
        sj[place] = j;
        sv[place] = sum;
        sn++;
      }
      f64 own0 = own0_of(&r), own1 = own1_of(&r);
      f64 candidate = set_score(at, &r, sj, sv, sn, own0, own1);
      if (candidate + 0.001 < score) {
        r = keep_route(r, mark);
        if (failed) return;
        set[at].route = r;
        rebuild_set();
        if (failed) return;
        score = candidate;
        improved = 1;
        break;
      }
      wasm_release((usize)mark);
    }
    if (!improved) break;
  }
}

/* ------------------------------------------------------------------ entry */

static f64 *out;
static i32 out_len;
static f64 stats[4];

EXPORT(rt_out_ptr) i32 rt_out_ptr(void) { return (i32)(usize)out; }
EXPORT(rt_out_len) i32 rt_out_len(void) { return out_len; }
EXPORT(rt_stats_ptr) i32 rt_stats_ptr(void) { return (i32)(usize)stats; }

/* items: NI x 5 doubles (x, y, width, height, lineageRow or NaN); edges: NE x 4 ints (from, to, secondary, id rank);
   max / search steps of the run. Returns 0, or RT_NEEDS_JS / RT_NO_MEMORY. The routes are in the output array:
   per route in order its edge index, its point count and the points (x, y). */
EXPORT(rt_route) i32 rt_route(const f64 *items, i32 ni, const i32 *edges, i32 ne, f64 max_s, f64 search_s) {
  IT = items; NI = ni; ED = edges; NE = ne;
  max_steps = max_s; search_steps = search_s;
  failed = 0;
  out_len = 0;
  bud_used = 0.0; bud_max = max_s; bud_search = search_s; bud_cheap = 0; bud_exhausted = 0;
  nsegs = 0;
  segcap = ne * 16 + 64;
  segs = TAKE(Seg, segcap);
  found_cap = segcap;
  found_buf = TAKE(i32, found_cap);
  term_buf = TAKE(f64, found_cap);
  set = TAKE(Entry, ne + 1);
  pos_of_edge = TAKE(i32, ne + 1);
  conflict_by_edge = TAKE(f64, ne + 1);
  if (failed) return failed;
  if (!grid_init(segcap, segcap * 24)) return failed ? failed : RT_NO_MEMORY;
  build_rows();
  if (failed) return failed;
  build_ports();
  if (failed) return failed;

  i32 *base = TAKE(i32, ne + 1);
  if (failed) return failed;
  for (i32 e = 0; e < ne; e++) base[e] = e;
  sort_idx(base, ne, base_cmp, 0);
  if (failed) return failed;

  build_candidate(base, ne);
  if (failed) return failed;
  /* keep the first candidate's entries */
  Entry *best_set = TAKE(Entry, ne + 1);
  if (failed) return failed;
  i32 best_n = nset;
  for (i32 i = 0; i < nset; i++) best_set[i] = set[i];
  if (ne > 1 && ne <= 90 && !bud_exhausted) {
    i32 *vf = TAKE(i32, ne + 1);
    if (failed) return failed;
    for (i32 e = 0; e < ne; e++) vf[e] = e;
    sort_idx(vf, ne, vertical_first_cmp, 0);
    build_candidate(vf, ne);
    if (failed) return failed;
    /* score both: the other must be lower to win */
    rebuild_set();
    if (failed) return failed;
    f64 other_score = set_score(-1, 0, 0, 0, 0, 0.0, 0.0);
    Entry *other_set = TAKE(Entry, ne + 1);
    if (failed) return failed;
    i32 other_n = nset;
    for (i32 i = 0; i < nset; i++) other_set[i] = set[i];
    for (i32 i = 0; i < best_n; i++) set[i] = best_set[i];
    nset = best_n;
    rebuild_set();
    if (failed) return failed;
    f64 best_score = set_score(-1, 0, 0, 0, 0, 0.0, 0.0);
    if (other_score < best_score) {
      for (i32 i = 0; i < other_n; i++) set[i] = other_set[i];
      nset = other_n;
    }
  } else {
    /* the first candidate stays in `set` */
  }
  if (!bud_exhausted) improve();
  if (failed) return failed;

  /* the answer */
  i32 total = 0;
  for (i32 i = 0; i < nset; i++) total += 2 + 2 * set[i].route.n;
  out = TAKE(f64, total);
  if (failed) return failed;
  i32 at = 0;
  for (i32 i = 0; i < nset; i++) {
    out[at++] = (f64)set[i].edge;
    out[at++] = (f64)set[i].route.n;
    for (i32 k = 0; k < set[i].route.n; k++) { out[at++] = set[i].route.p[k].x; out[at++] = set[i].route.p[k].y; }
  }
  out_len = total;
  stats[0] = bud_used;
  stats[1] = (f64)bud_cheap;
  stats[2] = bud_exhausted ? 1.0 : 0.0;
  stats[3] = (f64)nset;
  return 0;
}
