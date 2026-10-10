/* libFuzzer target: the editor diagnostics scan kernel (src/wasm/sqlscan.c) built natively, on any text. */
#include "wasm_native_rt.h"
#include "../../src/wasm/sqlscan.c"

#include "fuzz_input.h"
#include "wasm_names.h"

#include <stdlib.h>

static int set_up = 0;

/* Every row of `v` has `width` numbers; the columns in `positions` are offsets of the text (or -1 when absent). */
static void check_rows(const Vec *v, i32 width, u32 positions, i32 len) {
  if (v->n % width != 0) abort();
  for (i32 r = 0; r < v->n; r += width) {
    for (i32 c = 0; c < width; c++) {
      if (!(positions >> c & 1u)) continue;
      i32 x = v->p[r + c];
      if (x < -1 || x > len) abort();
    }
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (!set_up) {
    wasm_names_upload_n(sq_set_names, 4);
    set_up = 1;
  }
  FuzzInput in = fuzz_input(data, size);
  i32 flags = fuzz_u8(&in) & 7;
  i32 cursor = (i32)fuzz_u8(&in) << 8 | fuzz_u8(&in);

  usize mark = wasm_mark();
  u16 *text = NEW(u16, fuzz_left(&in) * 2 + 2);
  i32 len = fuzz_utf16(&in, text, fuzz_left(&in) * 2 + 2);

  if (sq_run(text, len, flags) == 0) {
    check_rows(&v_lam, 2, 3u, len);
    check_rows(&v_ref, 2, 3u, len);
    check_rows(&v_aj, 2, 3u, len);
    check_rows(&v_fn, 3, 3u, len);
    check_rows(&v_rel, 6, 6u | 48u, len);
  }

  if (sq_split(text, len) == 0) {
    /* [start, end) pieces, in order, that cover the text with one ";" between two pieces. */
    if (v_split.n % 2 != 0 || v_split.n < 2) abort();
    i32 prev = 0;
    for (i32 r = 0; r < v_split.n; r += 2) {
      i32 a = v_split.p[r], b = v_split.p[r + 1];
      if (a != prev || b < a || b > len) abort();
      prev = b + 1;
    }
    if (v_split.p[v_split.n - 1] != len) abort();
  }

  i32 out[2] = {-7, -7};
  if (sq_statement(text, len, cursor % (len + 2), out) == 0) {
    if (out[0] < 0 || out[0] > len || out[1] < 0 || out[1] > len) abort();
  }
  i32 before = sq_statement_before(text, len);
  if (before < 0 || before > len) abort();

  wasm_release(mark);
  return 0;
}
