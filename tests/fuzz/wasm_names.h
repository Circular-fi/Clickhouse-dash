/* wasm_names.h: the keyword and function name sets that the page uploads to the highlight and sqlscan kernels, a small
 * fixed sample of them (tests/fuzz). Packed like pack() of the adapters: [length, code units...] per name. */
#ifndef CHDASH_FUZZ_WASM_NAMES_H
#define CHDASH_FUZZ_WASM_NAMES_H

#include <string.h>

static const char *const WASM_NAME_SETS[][24] = {
  /* keywords */
  {"SELECT", "FROM", "WHERE", "GROUP", "BY", "ORDER", "LIMIT", "AS", "AND", "OR", "NOT", "NULL", "IN", "JOIN", "ON",
   "WITH", "UNION", "ALL", "INSERT", "INTO", "VALUES", "CREATE", "TABLE", 0},
  /* functions, case-sensitive / table functions */
  {"count", "sum", "toDate", "toString", "if", "arrayMap", "plus", "numbers", "remote", "file", 0},
  /* functions, case-insensitive (lower case) / data types */
  {"count", "sum", "avg", "min", "max", "uint8", "string", "datetime64", 0},
  /* aggregate functions, case-sensitive */
  {"count", "sum", "uniqExact", "avg", 0},
  /* aggregate functions, case-insensitive (lower case) */
  {"count", "sum", "avg", 0},
};

/* Uploads the first `sets` sets with set_names(which, data, units, count). */
static inline void wasm_names_upload_n(i32 (*set_names)(i32, const u16 *, i32, i32), i32 sets) {
  for (i32 which = 0; which < sets; which++) {
    i32 units = 0, count = 0;
    for (const char *const *p = WASM_NAME_SETS[which]; *p; p++, count++) units += (i32)strlen(*p) + 1;
    u16 *data = NEW(u16, units);
    i32 at = 0;
    for (const char *const *p = WASM_NAME_SETS[which]; *p; p++) {
      data[at++] = (u16)strlen(*p);
      for (const char *c = *p; *c; c++) data[at++] = (u8)*c;
    }
    set_names(which, data, units, count);
  }
}

static inline void wasm_names_upload(i32 (*set_names)(i32, const u16 *, i32, i32)) { wasm_names_upload_n(set_names, 5); }

#endif
