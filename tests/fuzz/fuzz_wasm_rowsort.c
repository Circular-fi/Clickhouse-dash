/* libFuzzer target: the numeric row order kernel (src/wasm/rowsort.c) built natively. The order is a permutation of
 * the rows, present values before NULLs (after them when descending), in value order. */
#include "wasm_native_rt.h"
#include "../../src/wasm/rowsort.c"

#include "fuzz_input.h"

#include <stdlib.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  FuzzInput in = fuzz_input(data, size);
  i32 desc = fuzz_u8(&in) & 1;
  i32 n = fuzz_range(&in, 0, 300);
  usize mark = wasm_mark();
  f64 *vals = NEW(f64, n + 1), *rank = NEW(f64, n + 1);
  u8 *nulls = NEW(u8, n + 1), *seen = NEW(u8, n + 1);
  i32 ranks_in_order = fuzz_u8(&in) & 1;
  for (i32 i = 0; i < n; i++) {
    vals[i] = fuzz_f64(&in);
    nulls[i] = fuzz_u8(&in) < 32;
    rank[i] = ranks_in_order ? (f64)i : fuzz_f64(&in);
    seen[i] = 0;
  }
  if (rs_numeric(vals, nulls, rank, n, desc) == 0 && n > 0) {
    /* ascending: values, then NULLs; descending: NULLs, then values */
    i32 switched = 0;
    for (i32 i = 0; i < n; i++) {
      u32 row = rs_order[i];
      if (row >= (u32)n || seen[row]) abort();
      seen[row] = 1;
      if (i == 0) continue;
      u32 before = rs_order[i - 1];
      if ((nulls[before] != 0) != (nulls[row] != 0)) {
        if (switched || (desc ? !nulls[before] : nulls[before])) abort();
        switched = 1;
      } else if (!nulls[row]) {
        f64 a = vals[before], b = vals[row];
        if (a == a && b == b && (desc ? a < b : a > b)) abort();
      }
    }
  }
  wasm_release(mark);
  return 0;
}
