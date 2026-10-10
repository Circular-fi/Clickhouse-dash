/* libFuzzer target: the colour kernel (src/wasm/color.c) built natively: every export, on any text and any number. */
#include "wasm_native_rt.h"
#include "../../src/wasm/color.c"

#include "fuzz_input.h"

#include <stdlib.h>

#define MAX_ITEMS 24

/* The text outputs: inside the buffer, in order, and a finished item ends with ")". */
static void check_texts(i32 n) {
  if (ooff[0] < 0) abort();
  for (i32 i = 0; i < n; i++) {
    if (ooff[i + 1] < ooff[i] || ooff[i + 1] > olen) abort();
    if (ostatus[i] == 0 && (ooff[i + 1] == ooff[i] || obuf[ooff[i + 1] - 1] != ')')) abort();
  }
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  FuzzInput in = fuzz_input(data, size);
  i32 op = fuzz_u8(&in) % 8;
  i32 n = fuzz_range(&in, 0, MAX_ITEMS);
  i32 slots = fuzz_range(&in, 1, 40);
  u8 cuts[MAX_ITEMS + 1];
  for (i32 i = 0; i <= MAX_ITEMS; i++) cuts[i] = fuzz_u8(&in);

  usize mark = wasm_mark();
  if (op >= 2 && op <= 4) {
    /* numbers: rgba (4 per colour and an alpha), mix (two colours, n weights), steps / categorical (n values) */
    f64 *a = NEW(f64, MAX_ITEMS * 4), *b = NEW(f64, MAX_ITEMS * 4), *t = NEW(f64, MAX_ITEMS);
    for (i32 i = 0; i < MAX_ITEMS * 4; i++) a[i] = fuzz_f64(&in);
    for (i32 i = 0; i < MAX_ITEMS * 4; i++) b[i] = fuzz_f64(&in);
    for (i32 i = 0; i < MAX_ITEMS; i++) t[i] = fuzz_f64(&in);
    if (op == 2 && col_rgba(a, t, n) == 0) check_texts(n);
    if (op == 3 && col_mix(a, b, t, n) == 0) check_texts(n);
    if (op == 4) {
      col_steps(t, n, slots);
      col_categorical(t, n, slots);
    }
  } else {
    /* texts: n strings cut from one UTF-16 buffer at sorted offsets */
    u16 *text = NEW(u16, fuzz_left(&in) * 2 + 2);
    i32 len = fuzz_utf16(&in, text, fuzz_left(&in) * 2 + 2);
    i32 *offs = NEW(i32, MAX_ITEMS + 1);
    offs[0] = 0;
    for (i32 i = 1; i < n; i++) {
      i32 at = (i32)((i64)cuts[i] * len / 255);
      offs[i] = at < offs[i - 1] ? offs[i - 1] : at;
    }
    offs[n] = len;
    if (n > 0 && offs[n - 1] > len) abort();
    switch (op) {
      case 0: if (col_normalize(text, offs, n) == 0) check_texts(n); break;
      case 1: col_parse_chart(text, offs, n); break;
      case 5: col_readable(text, offs, n); break;
      case 6: col_hash_slots(text, offs, n, slots); break;
      case 7: col_type_families(text, offs, n); break;
      default: break;
    }
  }
  wasm_release(mark);
  return 0;
}
