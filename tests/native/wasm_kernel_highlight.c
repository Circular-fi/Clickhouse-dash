/* The highlighter kernel (src/wasm/highlight.c) built natively for tests/native/sql_test.cpp, which compares what it calls a
 * string and a comment with what the lexer of the backend (src/sql_lexer.hpp) calls the same. */
#include "../fuzz/wasm_native_rt.h"
#include "../../src/wasm/highlight.c"

/* Writes the kind of the token of each code unit of text[0, len) in kinds[] (0 plain, 3 number, 6 string, 7 comment, ...).
   Returns the token count, or a negative number when the kernel cannot answer (-2: the page needs its JavaScript path). */
int chdash_wasm_highlight(const unsigned short *text, int len, signed char *kinds) {
  hl_set_flags(0, 0, 0);
  usize mark = wasm_mark();
  i32 count = hl_run((const u16 *)text, len);
  for (i32 i = 0; i < len; i++) kinds[i] = 0;
  for (i32 t = 0; t < count; t++) {
    for (i32 i = toks[t].start; i < toks[t].end; i++) kinds[i] = (signed char)toks[t].kind;
  }
  wasm_release(mark);
  return count;
}
