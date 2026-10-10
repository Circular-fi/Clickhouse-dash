/* libFuzzer target: the treemap layout kernel (src/wasm/treemap.c) built natively. The page sorts the nodes by size
 * and sums total_bytes / other_bytes itself; the rectangles name nodes of the input. */
#include "wasm_native_rt.h"
#include "../../src/wasm/treemap.c"

#include "fuzz_input.h"

#include <stdlib.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  FuzzInput in = fuzz_input(data, size);
  i32 n = fuzz_range(&in, 0, 80);
  usize mark = wasm_mark();
  f64 *bytes = NEW(f64, n + 1);
  u8 *other = NEW(u8, n + 1);
  f64 total = 0, other_total = 0;
  for (i32 i = 0; i < n; i++) {
    f64 b = fuzz_f64(&in);
    bytes[i] = b == b && b >= 0 ? b : 0;
    other[i] = fuzz_u8(&in) < 40;
  }
  /* sorted, the largest first */
  for (i32 i = 1; i < n; i++) {
    f64 b = bytes[i];
    u8 o = other[i];
    i32 j = i;
    while (j > 0 && bytes[j - 1] < b) { bytes[j] = bytes[j - 1]; other[j] = other[j - 1]; j--; }
    bytes[j] = b;
    other[j] = o;
  }
  for (i32 i = 0; i < n; i++) {
    total += bytes[i];
    if (other[i]) other_total += bytes[i];
  }
  f64 x = fuzz_f64(&in), y = fuzz_f64(&in), w = fuzz_f64(&in), h = fuzz_f64(&in);
  f64 c0 = fuzz_f64(&in), c1 = fuzz_f64(&in), c2 = fuzz_f64(&in), c3 = fuzz_f64(&in);
  i32 count = tm_layout(bytes, other, n, x, y, w, h, total, other_total, c0, c1, c2, c3);
  if (count > n) abort();
  for (i32 i = 0; i < count; i++) {
    if (out_index[i] < 0 || out_index[i] >= n) abort();
  }
  wasm_release(mark);
  return 0;
}
