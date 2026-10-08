/* sort.h: the sorting helpers the kernels share (include after rt.h). */
#ifndef CHDASH_WASM_SORT_H
#define CHDASH_WASM_SORT_H

/* A 64-bit key whose unsigned order is the numeric order of x. -0 and 0 get one key: the JavaScript comparison treats them as equal. */
static u64 sort_key(f64 x) {
  if (x == 0.0) x = 0.0;
  union { f64 f; u64 u; } v;
  v.f = x;
  return (v.u >> 63) ? ~v.u : (v.u | 0x8000000000000000ull);
}

/* Stable LSD radix sort of (key, index) pairs by key: 8 passes of 8 bits; a pass is skipped when every key has the same digit.
 * Both pairs of buffers are scratch; the result is in the returned index array (idx or idx2), the keys are not kept. */
static u32 *radix_sort(u64 *keys, u32 *idx, u64 *keys2, u32 *idx2, u32 n) {
  u32 count[256];
  for (u32 pass = 0; pass < 8; pass++) {
    u32 shift = pass * 8;
    for (u32 i = 0; i < 256; i++) count[i] = 0;
    for (u32 i = 0; i < n; i++) count[(keys[i] >> shift) & 255u]++;
    u32 same = 0;
    for (u32 i = 0; i < 256; i++)
      if (count[i] == n) same = 1;
    if (same) continue;
    u32 sum = 0;
    for (u32 i = 0; i < 256; i++) {
      u32 c = count[i];
      count[i] = sum;
      sum += c;
    }
    for (u32 i = 0; i < n; i++) {
      u32 d = (u32)((keys[i] >> shift) & 255u);
      u32 at = count[d]++;
      keys2[at] = keys[i];
      idx2[at] = idx[i];
    }
    u64 *tk = keys; keys = keys2; keys2 = tk;
    u32 *ti = idx; idx = idx2; idx2 = ti;
  }
  return idx;
}

#endif
