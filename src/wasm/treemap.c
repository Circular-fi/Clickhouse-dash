/* treemap.c: the squarified layout of src/static/app_explorer_treemap.js (squarifyTreemapNodes, layoutTreemapRow,
 * layoutTreemapNodes and the "Others" strip). The arithmetic follows the JavaScript expression by expression, in double
 * precision, so the rectangles are the same numbers.
 *
 * Input: the nodes of one group, sorted as compareNodes() sorts them (the page does that: it needs the locale), as
 * arrays of bytes (all above zero) and a flag for the "other" kind. Output: for each placed node its index and its
 * rectangle x, y, width, height.
 */
#include "rt.h"

#define EPS 2.220446049250313e-16

static f64 jmax(f64 a, f64 b) {
  if (a != a || b != b) return a != a ? a : b;
  return a > b ? a : b;
}
static f64 jmin(f64 a, f64 b) {
  if (a != a || b != b) return a != a ? a : b;
  return a < b ? a : b;
}

static f64 *out_rect;   /* 4 numbers per placed node */
static i32 *out_index;
static i32 out_count;

static f64 inf(void) { return __builtin_inf(); }

/* treemapWorstAspectRatio of a row given as the running figures of its areas (those above zero). */
static f64 worst_ratio(i32 positive, f64 sum, f64 maximum, f64 minimum, f64 side) {
  if (!positive || !(side > 0)) return inf();
  f64 side_sq = side * side;
  f64 sum_sq = sum * sum;
  return jmax(side_sq * maximum / jmax(EPS, sum_sq), sum_sq / jmax(EPS, side_sq * minimum));
}

typedef struct { f64 x, y, w, h; } Bounds;

/* layoutTreemapRow: the rectangles of nodes[first, first + count) in bounds; returns the remaining bounds. */
static Bounds layout_row(const f64 *area, const i32 *ids, i32 first, i32 count, Bounds b) {
  f64 total = 0;
  for (i32 i = 0; i < count; i++) total += jmax(0, area[first + i]);
  if (!(total > 0) || !(b.w > 0) || !(b.h > 0)) return b;
  if (b.w >= b.h) {
    f64 row_w = jmin(b.w, total / b.h);
    f64 cursor = b.y;
    for (i32 i = 0; i < count; i++) {
      f64 item_h = i == count - 1 ? jmax(0, b.y + b.h - cursor) : jmax(0, area[first + i] / jmax(EPS, row_w));
      out_index[out_count] = ids[first + i];
      out_rect[out_count * 4] = b.x;
      out_rect[out_count * 4 + 1] = cursor;
      out_rect[out_count * 4 + 2] = row_w;
      out_rect[out_count * 4 + 3] = item_h;
      out_count++;
      cursor += item_h;
    }
    Bounds rest = { b.x + row_w, b.y, jmax(0, b.w - row_w), b.h };
    return rest;
  }
  f64 row_h = jmin(b.h, total / b.w);
  f64 cursor = b.x;
  for (i32 i = 0; i < count; i++) {
    f64 item_w = i == count - 1 ? jmax(0, b.x + b.w - cursor) : jmax(0, area[first + i] / jmax(EPS, row_h));
    out_index[out_count] = ids[first + i];
    out_rect[out_count * 4] = cursor;
    out_rect[out_count * 4 + 1] = b.y;
    out_rect[out_count * 4 + 2] = item_w;
    out_rect[out_count * 4 + 3] = row_h;
    out_count++;
    cursor += item_w;
  }
  Bounds rest = { b.x, b.y + row_h, b.w, jmax(0, b.h - row_h) };
  return rest;
}

/* squarifyTreemapNodes of the nodes ids[0, n) (their bytes in bytes[id]), already sorted. */
static i32 squarify(const f64 *bytes, const i32 *ids, i32 n, f64 x, f64 y, f64 width, f64 height) {
  if (n <= 0) return 0;
  f64 total_bytes = 0;
  for (i32 i = 0; i < n; i++) total_bytes += bytes[ids[i]];
  f64 total_area = jmax(0, width) * jmax(0, height);
  if (!(total_bytes > 0) || !(total_area > 0)) return 0;
  f64 *area = NEW(f64, n);
  if (!area) return -1;
  for (i32 i = 0; i < n; i++) area[i] = bytes[ids[i]] / total_bytes * total_area;

  Bounds b = { x, y, width, height };
  i32 next = 0, row_first = 0, row_count = 0;
  /* the running figures of the areas above zero of the row, summed in order like the reduce of the reference */
  i32 positive = 0;
  f64 sum = 0, maximum = 0, minimum = 0;
  while (next < n && b.w > 0 && b.h > 0) {
    f64 candidate = area[next];
    f64 side = jmin(b.w, b.h);
    i32 take = 0;
    if (!row_count) {
      take = 1;
    } else {
      i32 p2 = positive;
      f64 s2 = sum, mx2 = maximum, mn2 = minimum;
      if (candidate > 0) {
        if (!p2) { s2 = candidate; mx2 = mn2 = candidate; } else { s2 = sum + candidate; mx2 = jmax(maximum, candidate); mn2 = jmin(minimum, candidate); }
        p2 = 1;
      }
      f64 with = worst_ratio(p2, s2, mx2, mn2, side);
      f64 without = worst_ratio(positive, sum, maximum, minimum, side);
      take = with <= without;
    }
    if (take) {
      if (area[next] > 0) {
        if (!positive) { sum = area[next]; maximum = minimum = area[next]; } else { sum += area[next]; maximum = jmax(maximum, area[next]); minimum = jmin(minimum, area[next]); }
        positive = 1;
      }
      if (!row_count) row_first = next;
      row_count++;
      next++;
      continue;
    }
    b = layout_row(area, ids, row_first, row_count, b);
    row_count = 0;
    positive = 0;
    sum = maximum = minimum = 0;
  }
  if (row_count && b.w > 0 && b.h > 0) layout_row(area, ids, row_first, row_count, b);
  return 0;
}

/* layoutTreemapNodes. nodes sorted; other[i] != 0 for the kind "other". total_bytes and other_bytes are summed by the page in
   the order of the nodes it was given (the sum order only matters for fractional bytes). params: the five constants of the
   reference (minimum regular height, Others inline and stacked minimum heights, Others inline minimum width).
   Returns the number of rectangles, -1 for no memory. Read them with tm_index_ptr() and tm_rect_ptr(). */
EXPORT(tm_layout) i32 tm_layout(const f64 *bytes, const u8 *other, i32 n, f64 x, f64 y, f64 width, f64 height,
                                f64 total_bytes, f64 other_bytes, f64 min_regular, f64 inline_h, f64 stacked_h, f64 inline_w) {
  out_count = 0;
  if (n <= 0 || !(width > 0) || !(height > 0)) return 0;
  out_rect = NEW(f64, (usize)n * 4);
  out_index = NEW(i32, n);
  i32 *regular = NEW(i32, n);
  i32 *others = NEW(i32, n);
  i32 *all = NEW(i32, n);
  if (!out_rect || !out_index || !regular || !others || !all) return -1;
  i32 nr = 0, no = 0;
  for (i32 i = 0; i < n; i++) {
    all[i] = i;
    if (other[i]) others[no++] = i; else regular[nr++] = i;
  }
  if (!no || !nr) return squarify(bytes, all, n, x, y, width, height) < 0 ? -1 : out_count;

  f64 share = other_bytes / jmax(EPS, total_bytes);
  f64 natural = height * share;
  f64 maximum = jmax(0, height - jmin(min_regular, height));
  if (!(maximum > 0)) return squarify(bytes, all, n, x, y, width, height) < 0 ? -1 : out_count;
  f64 readable = jmin(width >= inline_w ? inline_h : stacked_h, maximum);
  f64 strip = jmin(maximum, jmax(natural, readable));
  f64 regular_h = jmax(0, height - strip);
  if (squarify(bytes, regular, nr, x, y, width, regular_h) < 0) return -1;
  if (squarify(bytes, others, no, x, y + regular_h, width, strip) < 0) return -1;
  return out_count;
}

EXPORT(tm_index_ptr) i32 tm_index_ptr(void) { return (i32)(usize)out_index; }
EXPORT(tm_rect_ptr) i32 tm_rect_ptr(void) { return (i32)(usize)out_rect; }
