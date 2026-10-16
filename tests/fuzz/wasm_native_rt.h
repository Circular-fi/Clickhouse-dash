/* wasm_native_rt.h: src/wasm/rt.h for a native build of a WebAssembly kernel (the fuzz targets of tests/fuzz).
 *
 * A fuzz target includes this file, then the kernel source (src/wasm/<name>.c). The guard CHDASH_WASM_RT_H is
 * set here. So the #include "rt.h" of the kernel adds nothing. The kernel gets the same types and functions,
 * with these differences:
 *   - wasm_alloc() takes each block from malloc. AddressSanitizer then sees the end of every block. In the
 *     arena of the browser, an overflow runs into the next block silently.
 *   - wasm_mark() / wasm_release() keep the meaning of rt.h: a release frees every block taken after the mark;
 *   - the Math imports of the host are the functions of libm;
 *   - wasm_alloc() returns 0 past CHDASH_FUZZ_WASM_MEMORY bytes, like a full memory of the instance.
 */
#ifndef CHDASH_WASM_NATIVE_RT_H
#define CHDASH_WASM_NATIVE_RT_H
#define CHDASH_WASM_RT_H

#include <math.h>
#include <stdlib.h>

typedef unsigned char u8;
typedef signed char i8;
typedef unsigned short u16;
typedef short i16;
typedef unsigned int u32;
typedef int i32;
typedef unsigned long long u64;
typedef long long i64;
typedef float f32;
typedef double f64;
typedef __SIZE_TYPE__ usize;

#define EXPORT(name)
#define IMPORT(name)

static inline f64 js_sin(f64 x) { return sin(x); }
static inline f64 js_cos(f64 x) { return cos(x); }
static inline f64 js_atan2(f64 y, f64 x) { return atan2(y, x); }
static inline f64 js_pow(f64 x, f64 y) { return pow(x, y); }
static inline f64 js_exp(f64 x) { return exp(x); }
static inline f64 js_log(f64 x) { return log(x); }
static inline f64 js_cbrt(f64 x) { return cbrt(x); }
static inline f64 js_hypot(f64 x, f64 y) { return hypot(x, y); }

#define WASM_PAGE 65536u
#ifndef CHDASH_FUZZ_WASM_MEMORY
#define CHDASH_FUZZ_WASM_MEMORY (512u * 1024u * 1024u)
#endif

/* Every live block, in the order of allocation. A mark is a count of blocks. */
static void **native_blocks = 0;
static usize *native_sizes = 0;
static usize native_count = 0, native_cap = 0, native_bytes = 0;

static inline void *wasm_alloc(usize n) {
  if (n > CHDASH_FUZZ_WASM_MEMORY || native_bytes + n > CHDASH_FUZZ_WASM_MEMORY) return 0;
  if (native_count == native_cap) {
    usize cap = native_cap ? native_cap * 2 : 1024;
    void **blocks = (void **)realloc(native_blocks, cap * sizeof(void *));
    if (!blocks) return 0;
    native_blocks = blocks;
    usize *sizes = (usize *)realloc(native_sizes, cap * sizeof(usize));
    if (!sizes) return 0;
    native_sizes = sizes;
    native_cap = cap;
  }
  void *p = malloc(n ? n : 1);
  if (!p) return 0;
  native_blocks[native_count] = p;
  native_sizes[native_count] = n;
  native_count++;
  native_bytes += n;
  return p;
}

static inline usize wasm_alloc_bytes(usize n) { return (usize)wasm_alloc(n); }
static inline usize wasm_mark(void) { return native_count; }
static inline void wasm_release(usize mark) {
  while (native_count > mark) {
    native_count--;
    native_bytes -= native_sizes[native_count];
    free(native_blocks[native_count]);
  }
}

#define NEW(type, count) ((type *)wasm_alloc(sizeof(type) * (usize)(count)))

#endif
