/* rt.h: the tiny runtime of the ChDash WebAssembly kernels.
 *
 * A kernel is one freestanding C file (no libc, no JavaScript glue file): clang builds it for wasm32 with
 * tools/build_wasm.py. This header gives it fixed-width types, an arena allocator and the Math functions
 * of the host (imported from JavaScript so that the numbers are the ones the JavaScript reference uses).
 *
 * Memory model: the page writes the input into the memory of the instance, calls an export and reads
 * the result back. wasm_alloc() takes bytes from an arena that grows the memory on demand;
 * wasm_mark() / wasm_release() free everything allocated after the mark, so one call of a kernel leaves
 * no trace. Data a kernel keeps between calls (a keyword table) is allocated before the first mark.
 */
#ifndef CHDASH_WASM_RT_H
#define CHDASH_WASM_RT_H

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

#define EXPORT(name) __attribute__((export_name(#name)))
#define IMPORT(name) __attribute__((import_module("env"), import_name(#name)))

/* Math of the host: the same results as Math.sin() and the others in the JavaScript reference. */
IMPORT(sin) f64 js_sin(f64 x);
IMPORT(cos) f64 js_cos(f64 x);
IMPORT(atan2) f64 js_atan2(f64 y, f64 x);
IMPORT(pow) f64 js_pow(f64 x, f64 y);
IMPORT(exp) f64 js_exp(f64 x);
IMPORT(log) f64 js_log(f64 x);
IMPORT(cbrt) f64 js_cbrt(f64 x);
IMPORT(hypot) f64 js_hypot(f64 x, f64 y);

extern u8 __heap_base;

#define WASM_PAGE 65536u
static usize wasm_top = 0;

static inline usize wasm_align(usize n) { return (n + 15u) & ~(usize)15u; }

/* n bytes of zero-or-not memory (the arena is not cleared), 16-byte aligned; 0 when the memory is full. */
static void *wasm_alloc(usize n) {
  if (wasm_top == 0) wasm_top = wasm_align((usize)&__heap_base);
  usize start = wasm_top;
  usize end = start + wasm_align(n ? n : 1);
  if (end < start) return 0;
  usize have = (usize)__builtin_wasm_memory_size(0) * WASM_PAGE;
  if (end > have) {
    usize need = (end - have + WASM_PAGE - 1) / WASM_PAGE;
    if (__builtin_wasm_memory_grow(0, need) == (usize)-1) return 0;
  }
  wasm_top = end;
  return (void *)start;
}

EXPORT(wasm_alloc_bytes) usize wasm_alloc_bytes(usize n) { return (usize)wasm_alloc(n); }
EXPORT(wasm_mark) usize wasm_mark(void) {
  if (wasm_top == 0) wasm_top = wasm_align((usize)&__heap_base);
  return wasm_top;
}
EXPORT(wasm_release) void wasm_release(usize mark) { wasm_top = mark; }

#define NEW(type, count) ((type *)wasm_alloc(sizeof(type) * (usize)(count)))

#endif
