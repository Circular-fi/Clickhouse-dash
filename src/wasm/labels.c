/* labels.c: the edge label placement of src/static/app_graph_kit.js (placeLabels, visitLabelAnchors, createRectIndex).
 *
 * Every label, in the order of the requests, takes the first position along its route (the middle of the long runs,
 * then the verticals, then every 14 px, then the same beside the line, then the middle of the route) that covers
 * neither a card nor an earlier label. The positions, their order and the float operations are the JavaScript's, so
 * the labels land on the same pixels (tests/frontend/specs/wasm-layout.spec.js).
 */
#include "rt.h"

#define RT_NEEDS_JS (-2)
#define RT_NO_MEMORY (-1)

static i32 failed;
static void *take(usize bytes) {
  void *p = wasm_alloc(bytes);
  if (!p) failed = RT_NO_MEMORY;
  return p;
}
#define TAKE(type, n) ((type *)take(sizeof(type) * (usize)((n) > 0 ? (n) : 1)))

static inline f64 fabs_(f64 x) { return __builtin_fabs(x); }

/* ------------------------------------------------------------------ the rectangle index (160 px cells) */

#define CELL 160.0
typedef struct { f64 x, y, w, h; } Rect;

typedef struct {
  Rect *rects;
  i32 nrects, rectcap;
  u32 tcap;
  i32 *head, *cx, *cy;
  i32 *eid, *enext;
  i32 nent, entcap, ncells;
} Index;

static i32 index_init(Index *ix, i32 max_rects) {
  ix->rectcap = max_rects;
  ix->rects = TAKE(Rect, max_rects);
  ix->nrects = 0;
  ix->entcap = max_rects * 12 + 64;
  u32 cap = 256;
  while (cap < (u32)ix->entcap) cap <<= 1;
  ix->tcap = cap;
  ix->head = TAKE(i32, cap);
  ix->cx = TAKE(i32, cap);
  ix->cy = TAKE(i32, cap);
  ix->eid = TAKE(i32, ix->entcap);
  ix->enext = TAKE(i32, ix->entcap);
  if (failed) return 0;
  for (u32 i = 0; i < cap; i++) ix->head[i] = 0;
  ix->nent = 0;
  ix->ncells = 0;
  return 1;
}

static inline u32 cell_hash(i32 cx, i32 cy) {
  u32 h = (u32)cx * 0x9E3779B1u ^ ((u32)cy + 0x7F4A7C15u) * 0x85EBCA6Bu;
  h ^= h >> 15;
  return h;
}

static i32 *cell_slot(Index *ix, i32 cx, i32 cy, i32 create) {
  u32 mask = ix->tcap - 1u;
  u32 h = cell_hash(cx, cy) & mask;
  for (;;) {
    if (!ix->head[h]) {
      if (!create) return 0;
      ix->cx[h] = cx;
      ix->cy[h] = cy;
      return &ix->head[h];
    }
    if (ix->cx[h] == cx && ix->cy[h] == cy) return &ix->head[h];
    h = (h + 1u) & mask;
  }
}

static void index_add(Index *ix, Rect r) {
  if (ix->nrects >= ix->rectcap) { failed = RT_NEEDS_JS; return; }
  i32 id = ix->nrects++;
  ix->rects[id] = r;
  i32 x0 = (i32)__builtin_floor(r.x / CELL), x1 = (i32)__builtin_floor((r.x + r.w) / CELL);
  i32 y0 = (i32)__builtin_floor(r.y / CELL), y1 = (i32)__builtin_floor((r.y + r.h) / CELL);
  for (i32 x = x0; x <= x1; x++) {
    for (i32 y = y0; y <= y1; y++) {
      if (ix->nent >= ix->entcap || (u32)(ix->ncells + 1) * 2u > ix->tcap) { failed = RT_NEEDS_JS; return; }
      i32 *slot = cell_slot(ix, x, y, 1);
      if (!*slot) ix->ncells++;
      i32 e = ix->nent++;
      ix->eid[e] = id;
      ix->enext[e] = *slot - 1;
      *slot = e + 1;
    }
  }
}

/* Does the rectangle come closer than `padding` to one of the index? */
static i32 index_hits(Index *ix, f64 x, f64 y, f64 w, f64 h, f64 padding) {
  i32 x0 = (i32)__builtin_floor((x - padding) / CELL);
  i32 x1 = (i32)__builtin_floor((x - padding + (w + padding * 2.0)) / CELL);
  i32 y0 = (i32)__builtin_floor((y - padding) / CELL);
  i32 y1 = (i32)__builtin_floor((y - padding + (h + padding * 2.0)) / CELL);
  for (i32 c = x0; c <= x1; c++) {
    for (i32 r = y0; r <= y1; r++) {
      i32 *slot = cell_slot(ix, c, r, 0);
      if (!slot) continue;
      for (i32 e = *slot - 1; e >= 0; e = ix->enext[e]) {
        const Rect *b = &ix->rects[ix->eid[e]];
        if (!(x + w + padding <= b->x || b->x + b->w + padding <= x || y + h + padding <= b->y || b->y + b->h + padding <= y)) return 1;
      }
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ the anchors of a route */

typedef struct { f64 length, x, y; } Run;
typedef struct { f64 x, y; i32 horizontal; } Dense;

static f64 hypot_(f64 dx, f64 dy) { return js_hypot(dx, dy); }

/* A stable sort of runs by length, longest first (the JavaScript's sort((p, q) => q.length - p.length)). */
static void sort_runs(Run *a, i32 n) {
  for (i32 i = 1; i < n; i++) {
    Run v = a[i];
    i32 at = i;
    for (; at > 0 && v.length - a[at - 1].length > 0.0; at--) a[at] = a[at - 1];
    a[at] = v;
  }
}

static Index cards, labels;

/* The first anchor whose label rectangle is free: returns 1 and its rectangle. */
static i32 place_one(const f64 *pts, i32 n, f64 width, f64 height, Rect *out) {
  /* collect the runs of the route */
  i32 cap_runs = n * 3 + 3;
  Run *runs = TAKE(Run, cap_runs);
  Run *verticals = TAKE(Run, cap_runs);
  i32 nr = 0, nv = 0;
  i32 dense_cap = 0;
  for (i32 i = 1; i < n; i++) {
    f64 ax = pts[(i - 1) * 2], ay = pts[(i - 1) * 2 + 1], bx = pts[i * 2], by = pts[i * 2 + 1];
    f64 length = hypot_(bx - ax, by - ay);
    if (length >= 12.0) dense_cap += (i32)(length / 14.0) + 2;
  }
  Dense *dense = TAKE(Dense, dense_cap);
  if (failed) return 0;
  i32 nd = 0;
  for (i32 i = 1; i < n; i++) {
    f64 ax = pts[(i - 1) * 2], ay = pts[(i - 1) * 2 + 1], bx = pts[i * 2], by = pts[i * 2 + 1];
    i32 horizontal = fabs_(ay - by) <= 0.5;
    i32 vertical = fabs_(ax - bx) <= 0.5;
    f64 length = hypot_(bx - ax, by - ay);
    if (horizontal && length >= 36.0) {
      runs[nr].length = length; runs[nr].x = (ax + bx) / 2.0; runs[nr].y = ay; nr++;
      if (length >= 150.0) {
        runs[nr].length = length - 1.0; runs[nr].x = ax + (bx - ax) * 0.72; runs[nr].y = ay; nr++;
        runs[nr].length = length - 2.0; runs[nr].x = ax + (bx - ax) * 0.28; runs[nr].y = ay; nr++;
      }
    } else if (vertical && length >= height + 16.0) {
      verticals[nv].length = length; verticals[nv].x = ax; verticals[nv].y = (ay + by) / 2.0; nv++;
      if (length >= 120.0) {
        verticals[nv].length = length - 1.0; verticals[nv].x = ax; verticals[nv].y = ay + (by - ay) * 0.3; nv++;
        verticals[nv].length = length - 2.0; verticals[nv].x = ax; verticals[nv].y = ay + (by - ay) * 0.7; nv++;
      }
    }
    if ((horizontal || vertical) && length >= 12.0) {
      for (f64 at = 6.0; at <= length - 6.0; at += 14.0) {
        f64 t = at / length;
        dense[nd].x = ax + (bx - ax) * t;
        dense[nd].y = ay + (by - ay) * t;
        dense[nd].horizontal = horizontal;
        nd++;
      }
    }
  }
  sort_runs(runs, nr);
  sort_runs(verticals, nv);

#define TRY(ax_, ay_) do { \
    f64 rx_ = (ax_) - width / 2.0, ry_ = (ay_) - height / 2.0; \
    if (!index_hits(&cards, rx_, ry_, width, height, 2.0) && !index_hits(&labels, rx_, ry_, width, height, 3.0)) { \
      out->x = rx_; out->y = ry_; out->w = width; out->h = height; return 1; } \
  } while (0)

  for (i32 i = 0; i < nr; i++) TRY(runs[i].x, runs[i].y);
  for (i32 i = 0; i < nv; i++) TRY(verticals[i].x, verticals[i].y);
  for (i32 i = 0; i < nd; i++) TRY(dense[i].x, dense[i].y);
  f64 dy = height / 2.0 + 3.0;
  f64 dx = width / 2.0 + 3.0;
  for (i32 i = 0; i < nr; i++) { TRY(runs[i].x, runs[i].y - dy); TRY(runs[i].x, runs[i].y + dy); }
  for (i32 i = 0; i < nv; i++) { TRY(verticals[i].x + dx, verticals[i].y); TRY(verticals[i].x - dx, verticals[i].y); }
  for (i32 i = 0; i < nd; i++) {
    if (dense[i].horizontal) { TRY(dense[i].x, dense[i].y - dy); TRY(dense[i].x, dense[i].y + dy); }
    else { TRY(dense[i].x + dx, dense[i].y); TRY(dense[i].x - dx, dense[i].y); }
  }
  /* the middle of the route (routePoint(points, 0.5)) */
  f64 total = 0.0;
  for (i32 i = 0; i + 1 < n; i++) total += hypot_(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
  total = total > 0.0001 ? total : 0.0001;
  f64 distance = 0.5 * total;
  f64 start = 0.0;
  i32 chosen = -1;
  f64 chosen_start = 0.0, chosen_length = 0.0;
  f64 cur = 0.0;
  for (i32 i = 0; i + 1 < n; i++) {
    f64 length = hypot_(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
    start = cur;
    if (i == n - 2) { chosen = i; chosen_start = start; chosen_length = length; }
    cur += length;
  }
  /* the first segment whose end passes the distance, else the last */
  cur = 0.0;
  for (i32 i = 0; i + 1 < n; i++) {
    f64 length = hypot_(pts[(i + 1) * 2] - pts[i * 2], pts[(i + 1) * 2 + 1] - pts[i * 2 + 1]);
    if (distance <= cur + length) { chosen = i; chosen_start = cur; chosen_length = length; break; }
    cur += length;
  }
  if (chosen < 0) return 0;
  f64 local = 0.0;
  if (chosen_length > 0.0) {
    f64 q = (distance - chosen_start) / chosen_length;
    local = q < 0.0 ? 0.0 : (q > 1.0 ? 1.0 : q);
  }
  f64 mx = pts[chosen * 2] + (pts[(chosen + 1) * 2] - pts[chosen * 2]) * local;
  f64 my = pts[chosen * 2 + 1] + (pts[(chosen + 1) * 2 + 1] - pts[chosen * 2 + 1]) * local;
  TRY(mx, my);
#undef TRY
  return 0;
}

static f64 *out_xy;
static u8 *out_placed;
EXPORT(lb_xy_ptr) i32 lb_xy_ptr(void) { return (i32)(usize)out_xy; }
EXPORT(lb_placed_ptr) i32 lb_placed_ptr(void) { return (i32)(usize)out_placed; }

/* Requests: widths, heights, start[count + 1] into pts (x, y pairs); obstacles: x, y, width, height each. Returns 0 or an error.
   For each request: placed (0 / 1) and the top left corner of its rectangle. */
EXPORT(lb_run) i32 lb_run(i32 count, const f64 *widths, const f64 *heights, const i32 *start, const f64 *pts, i32 nobs, const f64 *obstacles) {
  failed = 0;
  out_xy = TAKE(f64, count * 2);
  out_placed = TAKE(u8, count);
  if (failed) return failed;
  if (!index_init(&cards, nobs)) return failed ? failed : RT_NO_MEMORY;
  if (!index_init(&labels, count)) return failed ? failed : RT_NO_MEMORY;
  for (i32 i = 0; i < nobs; i++) {
    Rect r;
    r.x = obstacles[i * 4]; r.y = obstacles[i * 4 + 1]; r.w = obstacles[i * 4 + 2]; r.h = obstacles[i * 4 + 3];
    index_add(&cards, r);
    if (failed) return failed;
  }
  for (i32 i = 0; i < count; i++) {
    i32 mark = (i32)wasm_mark();
    i32 n = start[i + 1] - start[i];
    Rect r;
    i32 ok = n >= 2 ? place_one(pts + start[i] * 2, n, widths[i], heights[i], &r) : 0;
    if (failed) return failed;
    wasm_release((usize)mark);
    out_placed[i] = (u8)ok;
    out_xy[i * 2] = ok ? r.x : 0.0;
    out_xy[i * 2 + 1] = ok ? r.y : 0.0;
    if (ok) {
      index_add(&labels, r);
      if (failed) return failed;
    }
  }
  return 0;
}
