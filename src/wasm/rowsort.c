/* rowsort.c: the row order of a numeric result column (src/static/app_results.js, orderByKeysJs).
 *
 * vals: the value of every row, nulls: 1 for a missing one, rank: the row's own number (__chdashRowIndex, the tie break).
 * The order is the one of a stable sort by (null last, value, rank) ascending, or by the three reversed for desc: so equal
 * rows keep their position, as Array.prototype.sort does.
 */
#include "rt.h"
#include "sort.h"

static u32 *rs_order;

EXPORT(rs_order_ptr) u32 *rs_order_ptr(void) { return rs_order; }

/* Returns 0, or -1 for no memory. The order (row positions, best first) is at rs_order_ptr(). */
EXPORT(rs_numeric) i32 rs_numeric(const f64 *vals, const u8 *nulls, const f64 *rank, i32 n, i32 desc) {
  if (n <= 0) {
    rs_order = 0;
    return 0;
  }
  u32 count = (u32)n;
  u32 *a = NEW(u32, count), *b = NEW(u32, count);
  u64 *k1 = NEW(u64, count), *k2 = NEW(u64, count);
  if (!a || !b || !k1 || !k2) return -1;
  for (u32 i = 0; i < count; i++) a[i] = i;
  u32 *r;

  /* least significant key first: the rank, unless it already ascends (then the position is the rank order) */
  u32 rank_sorted = 1;
  for (u32 i = 1; i < count; i++)
    if (rank[i] < rank[i - 1]) { rank_sorted = 0; break; }
  if (!rank_sorted || desc) {
    for (u32 i = 0; i < count; i++) {
      u64 k = sort_key(rank[a[i]]);
      k1[i] = desc ? ~k : k;
    }
    r = radix_sort(k1, a, k2, b, count);
    b = (r == a) ? b : a;
    a = r;
  }
  /* then the value (a missing value has key 0: the class decides) */
  for (u32 i = 0; i < count; i++) {
    u32 row = a[i];
    u64 k = nulls[row] ? 0 : sort_key(vals[row]);
    k1[i] = desc ? ~k : k;
  }
  r = radix_sort(k1, a, k2, b, count);
  b = (r == a) ? b : a;
  a = r;
  /* then the class: present values first (last when desc) */
  for (u32 i = 0; i < count; i++) {
    u64 k = nulls[a[i]] ? 1u : 0u;
    k1[i] = desc ? (1u - k) : k;
  }
  r = radix_sort(k1, a, k2, b, count);
  rs_order = r;
  return 0;
}

