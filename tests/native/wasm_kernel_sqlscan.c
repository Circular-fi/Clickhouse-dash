/* The statement scan of the editor kernel (src/wasm/sqlscan.c) built natively for tests/native/sql_test.cpp, which compares
 * the statements that it finds with the ones that the lexer of the backend (src/sql_lexer.hpp) finds. */
#include "../fuzz/wasm_native_rt.h"
#include "../../src/wasm/sqlscan.c"

/* The pieces of text[0, len) between its ";" as [start, end) pairs of code units, at most `max` numbers in out[].
   Returns how many numbers the kernel found (more than `max` when out[] is too short), or -1 when it has no memory. */
int chdash_wasm_split(const unsigned short *text, int len, int *out, int max) {
  usize mark = wasm_mark();
  if (sq_split((const u16 *)text, len) != 0) {
    wasm_release(mark);
    return -1;
  }
  const int n = v_split.n;
  for (int i = 0; i < n && i < max; i++) out[i] = v_split.p[i];
  wasm_release(mark);
  return n;
}

/* The statement around `cursor` in text[0, len): out[0] is its start and out[1] its end, in code units. Returns 0, or -1 when the
   kernel has no memory. */
int chdash_wasm_statement(const unsigned short *text, int len, int cursor, int *out) {
  return sq_statement((const u16 *)text, len, cursor, out);
}
