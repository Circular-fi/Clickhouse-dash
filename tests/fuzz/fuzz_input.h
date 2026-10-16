/* fuzz_input.h: turns the bytes of a fuzz input into the values that a kernel gets from the page (tests/fuzz).
 *
 * The page gives a kernel UTF-16 code units (a JavaScript string), int32 rows and doubles. These helpers read
 * them from the input in the order that the target asks for them. An input that runs out gives zeros.
 * The helpers work in C and in C++. The WebAssembly kernels are C files.
 */
#ifndef CHDASH_FUZZ_INPUT_H
#define CHDASH_FUZZ_INPUT_H

#include <stddef.h>
#include <stdint.h>
#include <string.h>

typedef struct {
  const uint8_t *data;
  size_t size;
  size_t at;
} FuzzInput;

static inline FuzzInput fuzz_input(const uint8_t *data, size_t size) {
  FuzzInput in = {data, size, 0};
  return in;
}

static inline size_t fuzz_left(const FuzzInput *in) { return in->size - in->at; }

static inline uint8_t fuzz_u8(FuzzInput *in) { return in->at < in->size ? in->data[in->at++] : 0; }

static inline uint32_t fuzz_u32(FuzzInput *in) {
  uint32_t v = 0;
  for (int i = 0; i < 4; i++) v = (v << 8) | fuzz_u8(in);
  return v;
}

/* An integer in [lo, hi]. */
static inline int32_t fuzz_range(FuzzInput *in, int32_t lo, int32_t hi) {
  if (hi <= lo) return lo;
  uint32_t span = (uint32_t)(hi - lo) + 1u;
  uint32_t v = span <= 256u ? fuzz_u8(in) : span <= 65536u ? ((uint32_t)fuzz_u8(in) << 8 | fuzz_u8(in)) : fuzz_u32(in);
  return lo + (int32_t)(v % span);
}

/* A double. It is often a small number or a special value, such as the cases a layout meets. Otherwise it is 8 raw bytes. */
static inline double fuzz_f64(FuzzInput *in) {
  uint8_t kind = fuzz_u8(in);
  switch (kind % 8) {
    case 0: return (double)(int8_t)fuzz_u8(in);
    case 1: return (double)fuzz_range(in, 0, 2000);
    case 2: return (double)fuzz_range(in, 0, 2000) / 7.0;
    case 3: return (double)fuzz_range(in, -1000000, 1000000) / 16.0;
    case 4: {
      static const double special[] = {0.0, -0.0, 1.0, 0.5, 1e-300, 1e300, 1.0 / 0.0, -1.0 / 0.0, 0.0 / 0.0, 9007199254740993.0};
      return special[fuzz_u8(in) % 10];
    }
    default: {
      uint64_t bits = 0;
      for (int i = 0; i < 8; i++) bits = (bits << 8) | fuzz_u8(in);
      double v;
      memcpy(&v, &bits, sizeof v);
      return v;
    }
  }
}

/* Read the rest of the input, or `limit` bytes of it, as UTF-8. Write it as UTF-16 code units, like a JavaScript
 * string. A byte that does not start a valid sequence becomes the lone surrogate 0xDC00 + byte. A JavaScript
 * string can hold such a surrogate too. `out` holds at least `limit` units. Returns the number of units. */
static inline int32_t fuzz_utf16(FuzzInput *in, uint16_t *out, size_t limit) {
  int32_t n = 0;
  size_t end = in->at + (limit < fuzz_left(in) ? limit : fuzz_left(in));
  while (in->at < end && (size_t)n + 2 <= limit) {
    const uint8_t *p = in->data + in->at;
    size_t left = end - in->at;
    uint32_t c = p[0], cp = 0;
    size_t len = 0;
    if (c < 0x80) { cp = c; len = 1; }
    else if (c >= 0xC2 && c <= 0xDF && left >= 2 && (p[1] & 0xC0) == 0x80) { cp = (c & 0x1F) << 6 | (p[1] & 0x3F); len = 2; }
    else if (c >= 0xE0 && c <= 0xEF && left >= 3 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80) {
      cp = (c & 0x0F) << 12 | (uint32_t)(p[1] & 0x3F) << 6 | (p[2] & 0x3F);
      len = cp >= 0x800 ? 3 : 0;
    } else if (c >= 0xF0 && c <= 0xF4 && left >= 4 && (p[1] & 0xC0) == 0x80 && (p[2] & 0xC0) == 0x80 && (p[3] & 0xC0) == 0x80) {
      cp = (c & 0x07) << 18 | (uint32_t)(p[1] & 0x3F) << 12 | (uint32_t)(p[2] & 0x3F) << 6 | (p[3] & 0x3F);
      len = cp >= 0x10000 && cp <= 0x10FFFF ? 4 : 0;
    }
    if (len == 0) { out[n++] = (uint16_t)(0xDC00u + c); in->at += 1; continue; }
    in->at += len;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      out[n++] = (uint16_t)(0xD800u + (cp >> 10));
      out[n++] = (uint16_t)(0xDC00u + (cp & 0x3FF));
    } else {
      out[n++] = (uint16_t)cp;
    }
  }
  return n;
}

#endif
