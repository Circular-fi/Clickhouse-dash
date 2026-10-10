/* libFuzzer target: the SQL highlighter kernel (src/wasm/highlight.c) built natively, on any text. */
#include "wasm_native_rt.h"
#include "../../src/wasm/highlight.c"

#include "fuzz_input.h"
#include "wasm_names.h"

#include <stdlib.h>

static int set_up = 0;

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  if (!set_up) {
    /* The name sets stay in the memory of the instance (allocated outside any mark), like the page does. */
    wasm_names_upload(hl_set_names);
    set_up = 1;
  }
  FuzzInput in = fuzz_input(data, size);
  uint8_t flags = fuzz_u8(&in);
  hl_set_flags(flags & 1, (flags >> 1) & 1, (flags >> 2) & 1);

  usize mark = wasm_mark();
  u16 *text = NEW(u16, fuzz_left(&in) * 2 + 2);
  i32 len = fuzz_utf16(&in, text, fuzz_left(&in) * 2 + 2);
  i32 count = hl_run(text, len);
  if (count > 0) {
    /* The tokens are in order, inside the text, and their HTML is inside the HTML string. */
    i32 prev = 0;
    for (i32 t = 0; t < count; t++) {
      const Tok *k = &toks[t];
      if (k->start < prev || k->end <= k->start || k->end > len || k->kind < 0 || k->kind > 7) abort();
      if (k->hs < 0 || k->he < k->hs || k->he > result_html_len) abort();
      prev = k->end;
    }
  } else if (count != 0 && count != -1 && count != NEEDS_JS) {
    abort();
  }
  wasm_release(mark);
  return 0;
}
