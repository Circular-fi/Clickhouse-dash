/* libFuzzer target: the chart model kernel (src/wasm/chartprep.c) built natively, with the inputs buildModel() of
 * src/static/app_query_chart.js gives it: x values (or category codes), series columns, group codes and their slots. */
#include "wasm_native_rt.h"
#include "../../src/wasm/chartprep.c"

#include "fuzz_input.h"

#include <stdlib.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  FuzzInput in = fuzz_input(data, size);
  i32 n = fuzz_range(&in, 0, 96);
  i32 series_count = fuzz_range(&in, 1, 3);
  i32 category_u = fuzz_u8(&in) & 1 ? fuzz_range(&in, 1, 9) : 0;
  i32 grouped = fuzz_u8(&in) & 1;
  i32 keys = fuzz_range(&in, 1, 7);

  usize mark = wasm_mark();
  f64 *X = NEW(f64, n + 1), *series = NEW(f64, (usize)(n + 1) * series_count), *codes = 0;
  i32 *group_slot = 0;
  i32 group_count = 0, per_series = 1;
  for (i32 r = 0; r < n; r++) {
    if (category_u) {
      i32 code = fuzz_range(&in, -1, category_u - 1);
      X[r] = code < 0 ? __builtin_nan("") : (f64)code;
    } else {
      X[r] = fuzz_f64(&in);
    }
  }
  for (i32 i = 0; i < n * series_count; i++) series[i] = fuzz_f64(&in);
  if (grouped) {
    /* group codes 0 .. keys - 1; the kept groups get the slots 0 .. kept - 1 in code order, the others go to Other */
    codes = NEW(f64, n + 1);
    group_slot = NEW(i32, keys);
    for (i32 r = 0; r < n; r++) codes[r] = (f64)fuzz_range(&in, 0, keys - 1);
    u8 keep = fuzz_u8(&in);
    for (i32 k = 0; k < keys; k++) group_slot[k] = (keep >> k & 1) || k == 0 ? group_count++ : -1;
    per_series = group_count + (group_count < keys ? 1 : 0);
  }
  i32 u = cp_general(X, n, series, series_count, codes, group_slot, group_count, per_series, category_u);
  if (u >= 0) {
    if (category_u ? u != category_u : u > n) abort();
    if (r_skipped < 0 || r_skipped > n) abort();
    if (!category_u) {
      for (i32 k = 1; k < u; k++) if (!(r_xs[k - 1] < r_xs[k])) abort();
    }
  }
  wasm_release(mark);
  return 0;
}
