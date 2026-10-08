/* chartprep.c: the general path of buildModel() in src/static/app_query_chart.js.
 *
 * Rows that are not one per x in ascending order are sorted by x (stable: equal x keep their row order), equal x
 * are merged (values summed in row order) and every series column (per kept group) gets one value and one NULL flag per
 * x. The arithmetic and the order of the sums are the ones of the JavaScript, so the doubles are identical.
 *
 * Input is typed arrays copied into the memory of the instance; the output stays there until the caller reads it.
 */
#include "rt.h"
#include "sort.h"

/* Results of the last call. */
static i32 r_skipped, r_summed;
static f64 *r_xs, *r_values;
static u8 *r_nulls;

EXPORT(cp_xs) f64 *cp_xs(void) { return r_xs; }
EXPORT(cp_values) f64 *cp_values(void) { return r_values; }
EXPORT(cp_nulls) u8 *cp_nulls(void) { return r_nulls; }
EXPORT(cp_skipped) i32 cp_skipped(void) { return r_skipped; }
EXPORT(cp_summed) i32 cp_summed(void) { return r_summed; }

/* X: n doubles. series: series_count arrays of n doubles, one after the other. codes: n group codes (doubles), or 0 without groups.
 * group_slot: per group code the slot (>= 0) or -1 (Other). category_u: the number of categories when the x axis is a
 * category (X holds the category codes, no sorting), else 0. lines = series_count * per_series.
 * Returns u, the number of x positions, or -1 for no memory. */
EXPORT(cp_general) i32 cp_general(const f64 *X, i32 n, const f64 *series, i32 series_count, const f64 *codes, const i32 *group_slot,
                                  i32 group_count, i32 per_series, i32 category_u) {
  r_skipped = 0;
  r_summed = 0;
  u32 valid = 0;
  u32 *order = NEW(u32, n);
  if (!order) return -1;
  for (i32 r = 0; r < n; r++) {
    if (X[r] == X[r]) order[valid++] = (u32)r;
    else r_skipped++;
  }
  i32 u;
  u32 *pos = 0;
  f64 *xs = 0;
  if (!category_u) {
    u64 *k1 = NEW(u64, valid ? valid : 1), *k2 = NEW(u64, valid ? valid : 1);
    u32 *i2 = NEW(u32, valid ? valid : 1);
    if (!k1 || !k2 || !i2) return -1;
    /* already ascending (equal x allowed)? then no sort */
    u32 sorted = 1;
    for (u32 k = 1; k < valid; k++)
      if (X[order[k]] < X[order[k - 1]]) { sorted = 0; break; }
    if (!sorted) {
      for (u32 k = 0; k < valid; k++) k1[k] = sort_key(X[order[k]]);
      order = radix_sort(k1, order, k2, i2, valid);
    }
    pos = NEW(u32, n ? n : 1);
    xs = NEW(f64, valid ? valid : 1);
    if (!pos || !xs) return -1;
    u = 0;
    for (u32 k = 0; k < valid; k++) {
      u32 r = order[k];
      if (u == 0 || X[r] != xs[u - 1]) xs[u++] = X[r];
      pos[r] = (u32)(u - 1);
    }
  } else {
    u = category_u;
  }
  i32 lines = series_count * per_series;
  r_values = NEW(f64, (usize)lines * (usize)(u ? u : 1));
  r_nulls = NEW(u8, (usize)lines * (usize)(u ? u : 1));
  if (!r_values || !r_nulls) return -1;
  for (usize i = 0; i < (usize)lines * (usize)u; i++) {
    r_values[i] = __builtin_nan("");
    r_nulls[i] = 0;
  }
  for (u32 k = 0; k < valid; k++) {
    u32 r = order[k];
    u32 idx = category_u ? (u32)X[r] : pos[r];
    i32 offset = 0;
    if (codes) {
      i32 slot = group_slot[(u32)codes[r]];
      offset = slot < 0 ? group_count : slot;
    }
    for (i32 j = 0; j < series_count; j++) {
      f64 v = series[(usize)j * (usize)n + r];
      usize li = (usize)(j * per_series + offset);
      f64 *cell = &r_values[li * (usize)u + idx];
      f64 current = *cell;
      if (!(v == v)) {
        if (!(current == current)) r_nulls[li * (usize)u + idx] = 1;
        continue;
      }
      if (current == current) {
        *cell = current + v;
        r_summed = 1;
      } else {
        *cell = v;
        r_nulls[li * (usize)u + idx] = 0;
      }
    }
  }
  r_xs = xs;
  return u;
}
