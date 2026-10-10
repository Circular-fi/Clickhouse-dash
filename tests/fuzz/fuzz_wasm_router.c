/* libFuzzer target: the orthogonal edge router kernel (src/wasm/router.c) built natively, on the input pack() of
 * src/static/app_wasm_router.js builds: cards (x, y, width, height, lineage row or NaN) and edges (from, to, secondary,
 * id rank). The step budgets are bounded so that one input stays short. The numbers stay in the range of a layout
 * (finite, below 1e7): past 2^31 the double to int conversions of the kernel are undefined in C and saturate in
 * WebAssembly (-mnontrapping-fptoint). */
#include "wasm_native_rt.h"
#include "../../src/wasm/router.c"

#include "fuzz_input.h"

#include <stdlib.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  FuzzInput in = fuzz_input(data, size);
  i32 far = (fuzz_u8(&in) & 7) == 0;
  i32 ni = fuzz_range(&in, 0, 14);
  i32 ne = fuzz_range(&in, 0, 20);
  f64 max_steps = (f64)fuzz_range(&in, 0, 20000);
  f64 search_steps = (f64)fuzz_range(&in, 0, 5000);
  usize mark = wasm_mark();
  f64 *items = NEW(f64, ni * 5 + 5);
  i32 *edges = NEW(i32, ne * 4 + 4);
  for (i32 i = 0; i < ni; i++) {
    if (far) {
      for (i32 k = 0; k < 4; k++) items[i * 5 + k] = (f64)fuzz_range(&in, k < 2 ? -10000000 : 0, 10000000) / 3.0;
      items[i * 5 + 4] = (f64)fuzz_range(&in, 0, 1000);
    } else {
      items[i * 5] = (f64)fuzz_range(&in, 0, 60) * 40.0;
      items[i * 5 + 1] = (f64)fuzz_range(&in, 0, 60) * 30.0;
      items[i * 5 + 2] = (f64)fuzz_range(&in, 20, 320);
      items[i * 5 + 3] = (f64)fuzz_range(&in, 18, 200);
      i32 row = fuzz_range(&in, -1, 6);
      items[i * 5 + 4] = row < 0 ? __builtin_nan("") : (f64)row;
    }
  }
  /* the edge ids are distinct (pack() refuses two edges with one id): their ranks are a permutation */
  for (i32 e = 0; e < ne; e++) {
    edges[e * 4] = fuzz_range(&in, -1, ni - 1);
    edges[e * 4 + 1] = fuzz_range(&in, -1, ni - 1);
    edges[e * 4 + 2] = fuzz_u8(&in) & 1;
    edges[e * 4 + 3] = e;
  }
  for (i32 e = ne - 1; e > 0; e--) {
    i32 j = fuzz_range(&in, 0, e);
    i32 r = edges[e * 4 + 3];
    edges[e * 4 + 3] = edges[j * 4 + 3];
    edges[j * 4 + 3] = r;
  }

  if (rt_route(items, ni, edges, ne, max_steps, search_steps) == 0) {
    /* routes: edge index, point count, points */
    i32 at = 0;
    while (at < out_len) {
      if (at + 2 > out_len) abort();
      f64 edge = out[at], points = out[at + 1];
      if (!(edge >= 0 && edge < ne) || !(points >= 0) || at + 2 + 2 * (i32)points > out_len) abort();
      at += 2 + 2 * (i32)points;
    }
  }
  wasm_release(mark);
  return 0;
}
