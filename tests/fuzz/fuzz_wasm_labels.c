/* libFuzzer target: the edge label placement kernel (src/wasm/labels.c) built natively, on the input pack() of
 * src/static/app_wasm_labels.js builds: label sizes, polyline points per label (start offsets), obstacle rectangles.
 *
 * The numbers stay in the range of a layout (finite, below 1e7 in size): the kernel turns coordinates into grid cells
 * with a double to int conversion, which C leaves undefined past 2^31 and WebAssembly saturates (-mnontrapping-fptoint),
 * so a native report there says nothing about the browser. Sizes stay below 3000: a label or card that spans millions of
 * grid cells takes seconds in the kernel (a layout has text-sized boxes). */
#include "wasm_native_rt.h"
#include "../../src/wasm/labels.c"

#include "fuzz_input.h"

#include <stdlib.h>

/* A coordinate of a layout: often a few thousand pixels, sometimes far out. */
static f64 coord(FuzzInput *in, i32 far) {
  if (far) return (f64)fuzz_range(in, -10000000, 10000000) / 3.0;
  return (f64)fuzz_range(in, -200, 3000) + (f64)fuzz_range(in, 0, 3) / 4.0;
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  FuzzInput in = fuzz_input(data, size);
  i32 far = (fuzz_u8(&in) & 7) == 0;
  i32 count = fuzz_range(&in, 0, 24);
  i32 nobs = fuzz_range(&in, 0, 24);
  usize mark = wasm_mark();
  f64 *widths = NEW(f64, count + 1), *heights = NEW(f64, count + 1);
  i32 *start = NEW(i32, count + 1);
  f64 *pts = NEW(f64, 2 * 24 * 12 + 2);
  f64 *obstacles = NEW(f64, 4 * nobs + 4);
  i32 at = 0;
  for (i32 i = 0; i < count; i++) {
    widths[i] = (f64)fuzz_range(&in, 0, far ? 3000 : 300);
    heights[i] = (f64)fuzz_range(&in, 0, far ? 3000 : 40);
    start[i] = at;
    i32 points = fuzz_range(&in, 0, 12);
    for (i32 k = 0; k < points; k++, at++) {
      pts[at * 2] = coord(&in, far);
      pts[at * 2 + 1] = coord(&in, far);
    }
  }
  start[count] = at;
  for (i32 i = 0; i < nobs * 4; i++) obstacles[i] = (i % 4) < 2 ? coord(&in, far) : (f64)fuzz_range(&in, 0, far ? 3000 : 400);

  if (lb_run(count, widths, heights, start, pts, nobs, obstacles) == 0) {
    for (i32 i = 0; i < count; i++) if (out_placed[i] > 1) abort();
  }
  wasm_release(mark);
  return 0;
}
