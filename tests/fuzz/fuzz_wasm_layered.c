/* libFuzzer target: the layered graph layout kernel (src/wasm/layered.c) built natively, on the input pack() of
 * src/static/app_wasm_layered.js builds: card indexes (-1 for a missing card), dense ranks, edge weights, flags. */
#include "wasm_native_rt.h"
#include "../../src/wasm/layered.c"

#include "fuzz_input.h"

#include <stdlib.h>

/* Dense ranks (0, 1, 2 ... with ties) of n fuzzed keys, like ranks() of the adapter. */
static void dense_ranks(FuzzInput *in, i32 *out, i32 n) {
  u8 key[64];
  for (i32 i = 0; i < n; i++) key[i] = (u8)fuzz_range(in, 0, n > 1 ? n - 1 : 0);
  for (i32 i = 0; i < n; i++) {
    i32 r = 0;
    for (i32 v = 0; v < key[i]; v++) {
      for (i32 j = 0; j < n; j++) {
        if (key[j] == v) { r++; break; }
      }
    }
    out[i] = r;
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  FuzzInput in = fuzz_input(data, size);
  i32 flags = fuzz_u8(&in) & 3;
  i32 n = fuzz_range(&in, 0, 40);
  i32 ne = fuzz_range(&in, 0, 90);
  usize mark = wasm_mark();
  i32 *from = NEW(i32, ne + 1), *to = NEW(i32, ne + 1), *rank = NEW(i32, n + 1), *queue_rank = NEW(i32, n + 1);
  f64 *weight = NEW(f64, ne + 1);
  for (i32 e = 0; e < ne; e++) {
    from[e] = fuzz_range(&in, -1, n - 1);
    to[e] = fuzz_range(&in, -1, n - 1);
    weight[e] = fuzz_u8(&in) < 200 ? 1.0 : fuzz_f64(&in);
  }
  dense_ranks(&in, rank, n);
  if (fuzz_u8(&in) & 1) dense_ranks(&in, queue_rank, n);
  else for (i32 i = 0; i < n; i++) queue_rank[i] = rank[i];

  if (ly_run(n, ne, from, to, rank, queue_rank, weight, flags) == 0) {
    for (i32 i = 0; i < n; i++) {
      if (out_level[i] < 0 || out_level[i] > n) abort();
      if (out_order[i] < 0 || out_order[i] >= n) abort();
    }
    for (i32 e = 0; e < ne; e++) if (out_back[e] > 1) abort();
  }
  wasm_release(mark);
  return 0;
}
