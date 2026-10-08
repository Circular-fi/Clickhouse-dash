/* highlight.c: the SQL syntax colouring of src/static/app_highlight.js (lexAll, tokenizePlain, wrapHtml).
 *
 * The text is UTF-16 (the code units of the JavaScript string), so every offset is a JavaScript string index.
 * hl_run() lexes the text and writes, for every token, its kind and the HTML of the token (the same bytes
 * wrapHtml() builds). The sets of the host (keywords, function names) are uploaded once with hl_set_names().
 *
 * The code follows the JavaScript line by line: the tests compare both on a large corpus (tests/frontend/specs/wasm-highlight.spec.js).
 */
#include "rt.h"

enum { K_PLAIN = 0, K_KW = 1, K_FN = 2, K_NUM = 3, K_NULL = 4, K_TYPE = 5, K_STR = 6, K_COM = 7 };
enum { SET_KW = 0, SET_CS = 1, SET_CI = 2, SET_AGG_CS = 3, SET_AGG_CI = 4, SET_COUNT = 5 };
/* hl_run() answers with this when the text needs the JavaScript path (a quoted name with a non-ASCII letter that
   is followed by a "(": JavaScript lower-cases it with Unicode rules). */
#define NEEDS_JS (-2)

/* ------------------------------------------------------------------ name sets */

typedef struct {
  u32 cap;     /* slots, a power of two (0: the set is empty) */
  u32 *slot;   /* index + 1 of the entry, 0 for a free slot */
  u32 *off;    /* start of each entry in pool */
  u32 *len;
  u16 *pool;
} Set;

static Set sets[SET_COUNT];
static i32 has_kw = 0, has_fn = 0, has_agg = 0;

static u32 hash16(const u16 *s, u32 n) {
  u32 h = 2166136261u;
  for (u32 i = 0; i < n; i++) h = (h ^ s[i]) * 16777619u;
  return h;
}

static i32 set_has(const Set *set, const u16 *s, u32 n) {
  if (!set->cap) return 0;
  u32 mask = set->cap - 1u;
  u32 h = hash16(s, n) & mask;
  for (;;) {
    u32 e = set->slot[h];
    if (!e) return 0;
    e -= 1u;
    if (set->len[e] == n) {
      const u16 *p = set->pool + set->off[e];
      u32 i = 0;
      while (i < n && p[i] == s[i]) i++;
      if (i == n) return 1;
    }
    h = (h + 1u) & mask;
  }
}

/* data: [length, code units...] for every name, count names, in one UTF-16 buffer. */
EXPORT(hl_set_names) i32 hl_set_names(i32 which, const u16 *data, i32 units, i32 count) {
  if (which < 0 || which >= SET_COUNT) return -1;
  Set *set = &sets[which];
  set->cap = 0;
  if (count <= 0) return 0;
  u32 cap = 16;
  while (cap < (u32)count * 2u) cap <<= 1;
  set->slot = NEW(u32, cap);
  set->off = NEW(u32, count);
  set->len = NEW(u32, count);
  set->pool = NEW(u16, units);
  if (!set->slot || !set->off || !set->len || !set->pool) return -1;
  for (u32 i = 0; i < cap; i++) set->slot[i] = 0;
  u32 at = 0, used = 0;
  for (i32 k = 0; k < count && at < (u32)units; k++) {
    u32 n = data[at++];
    if (at + n > (u32)units) break;
    for (u32 i = 0; i < n; i++) set->pool[used + i] = data[at + i];
    set->off[k] = used;
    set->len[k] = n;
    u32 mask = cap - 1u;
    u32 h = hash16(set->pool + used, n) & mask;
    while (set->slot[h]) h = (h + 1u) & mask;
    set->slot[h] = (u32)k + 1u;
    used += n;
    at += n;
  }
  set->cap = cap;
  return 0;
}

/* has_kw: the keyword set of the host is present; has_fn: the function sets are; has_agg: the aggregate sets are. */
EXPORT(hl_set_flags) void hl_set_flags(i32 kw, i32 fn, i32 agg) {
  has_kw = kw;
  has_fn = fn;
  has_agg = agg;
}

/* ------------------------------------------------------------------ character classes */

static inline i32 is_word_char(u32 c) { return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95; }
static inline i32 is_word_start(u32 c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c == 95; }
static inline i32 is_digit(u32 c) { return c >= 48 && c <= 57; }
static inline u32 lower(u32 c) { return (c >= 65 && c <= 90) ? c + 32u : c; }

/* The \s of a JavaScript regular expression. */
static i32 is_space(u32 c) {
  if (c == 32 || (c >= 9 && c <= 13)) return 1;
  if (c < 160) return 0;
  return c == 160 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}

/* ------------------------------------------------------------------ output */

typedef struct { i32 start, end, kind, hs, he; } Tok;

static const u16 *T;        /* the text */
static i32 tlen;
static Tok *toks;
static i32 ntok, ntok_cap;
static i32 overflow;
static i32 needs_js;

static void emit(i32 a, i32 b, i32 kind) {
  if (b <= a) return;
  if (ntok >= ntok_cap) {
    overflow = 1;
    return;
  }
  toks[ntok].start = a;
  toks[ntok].end = b;
  toks[ntok].kind = kind;
  ntok++;
}

/* ------------------------------------------------------------------ keywords and types */

static i32 str_eq_lower(const u16 *s, i32 a, i32 b, const char *lit) {
  i32 n = b - a;
  for (i32 i = 0; i < n; i++) {
    if (!lit[i] || (u32)(u8)lit[i] != lower(s[a + i])) return 0;
  }
  return lit[n] == 0;
}

static const char *const COMMON_KEYWORDS[] = {
  "with", "select", "from", "where", "group", "by", "having", "order", "limit", "join", "on", "as", "and", "or", "not", "in",
  "is", "null", "distinct", "union", "all", "index", "projection", "type", "granularity", "ttl", "codec", "engine", "partition",
  "settings", "materialized", "create", "table", "view", "dictionary", "database", "alter", "drop", "attach", "detach",
  "rename", "to", 0 };

static const char *const TYPE_NAMES[] = {
  "Int8", "Int16", "Int32", "Int64", "Int128", "Int256", "UInt8", "UInt16", "UInt32", "UInt64", "UInt128", "UInt256", "Float32",
  "Float64", "BFloat16", "Decimal", "Decimal32", "Decimal64", "Decimal128", "Decimal256", "Bool", "Boolean", "String", "FixedString",
  "UUID", "Date", "Date32", "DateTime", "DateTime32", "DateTime64", "Time", "Time64", "Enum", "Enum8", "Enum16", "Array", "Tuple",
  "Map", "Nested", "Nullable", "LowCardinality", "IPv4", "IPv6", "JSON", "Object", "Dynamic", "Variant", "AggregateFunction",
  "SimpleAggregateFunction", "Nothing", "Point", "Ring", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "Geometry",
  "IntervalNanosecond", "IntervalMicrosecond", "IntervalMillisecond", "IntervalSecond", "IntervalMinute", "IntervalHour",
  "IntervalDay", "IntervalWeek", "IntervalMonth", "IntervalQuarter", "IntervalYear", "QBit", 0 };

/* Two small open-addressing tables of C strings, built on the first call: a word costs a hash and one comparison. */
#define WORD_SLOTS 256u
static u8 word_tables_ready;
static const char *kw_table[WORD_SLOTS];
static const char *type_table[WORD_SLOTS];

static u32 hash_ascii(const char *p, i32 lowercase) {
  u32 h = 2166136261u;
  for (; *p; p++) h = (h ^ (lowercase ? lower((u32)(u8)*p) : (u32)(u8)*p)) * 16777619u;
  return h;
}

static void table_add(const char **table, const char *word, i32 lowercase) {
  u32 h = hash_ascii(word, lowercase) & (WORD_SLOTS - 1u);
  while (table[h]) h = (h + 1u) & (WORD_SLOTS - 1u);
  table[h] = word;
}

static void init_word_tables(void) {
  for (u32 i = 0; i < WORD_SLOTS; i++) kw_table[i] = type_table[i] = 0;
  for (i32 k = 0; COMMON_KEYWORDS[k]; k++) table_add(kw_table, COMMON_KEYWORDS[k], 0);
  for (i32 k = 0; TYPE_NAMES[k]; k++) table_add(type_table, TYPE_NAMES[k], 0);
  word_tables_ready = 1;
}

/* The hashes of s[a, b): as written and lower-cased. */
static void word_hashes(const u16 *s, i32 a, i32 b, u32 *exact, u32 *folded) {
  u32 he = 2166136261u, hf = 2166136261u;
  for (i32 i = a; i < b; i++) {
    u32 c = s[i];
    he = (he ^ c) * 16777619u;
    hf = (hf ^ lower(c)) * 16777619u;
  }
  *exact = he;
  *folded = hf;
}

static i32 table_has(const char *const *table, const u16 *s, i32 a, i32 b, u32 hash, i32 fold) {
  u32 h = hash & (WORD_SLOTS - 1u);
  while (table[h]) {
    const char *lit = table[h];
    i32 i = 0, n = b - a;
    if (fold) {
      while (i < n && lit[i] && (u32)(u8)lit[i] == lower(s[a + i])) i++;
    } else {
      while (i < n && lit[i] && (u32)(u8)lit[i] == s[a + i]) i++;
    }
    if (i == n && !lit[i]) return 1;
    h = (h + 1u) & (WORD_SLOTS - 1u);
  }
  return 0;
}

/* ------------------------------------------------------------------ function names */

/* name = s[a, b) with every unit below 128. Mirrors isFnName(). */
static i32 is_fn_name(const u16 *s, i32 a, i32 b) {
  i32 n = b - a;
  if (n <= 0) return 0;
  if (set_has(&sets[SET_CS], s + a, (u32)n)) return 1;
  u16 buf[128];
  u16 *low = n <= 128 ? buf : NEW(u16, n);
  if (!low) return 0;
  for (i32 i = 0; i < n; i++) low[i] = (u16)lower(s[a + i]);
  if (set_has(&sets[SET_CI], low, (u32)n)) return 1;
  if (n > 5 && has_agg && s[b - 5] == 'S' && s[b - 4] == 't' && s[b - 3] == 'a' && s[b - 2] == 't' && s[b - 1] == 'e') {
    if (set_has(&sets[SET_AGG_CS], s + a, (u32)(n - 5))) return 1;
    if (set_has(&sets[SET_AGG_CI], low, (u32)(n - 5))) return 1;
  }
  return 0;
}

/* skipWsAndComments(s, pos) of the string s[lo, hi). */
static i32 skip_ws_comments(const u16 *s, i32 pos, i32 hi) {
  i32 i = pos;
  while (i < hi) {
    u32 c = s[i];
    u32 nx = i + 1 < hi ? s[i + 1] : 0xffffffffu;
    if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
      i += 1;
      continue;
    }
    if (c == '-' && nx == '-') {
      i += 2;
      while (i < hi && s[i] != '\n') i += 1;
      continue;
    }
    if (c == '#') {
      i += 1;
      while (i < hi && s[i] != '\n') i += 1;
      continue;
    }
    if (c == '/' && nx == '*') {
      i += 2;
      while (i + 1 < hi && !(s[i] == '*' && s[i + 1] == '/')) i += 1;
      i = i + 2 <= hi ? i + 2 : hi;
      continue;
    }
    break;
  }
  return i;
}

/* Is the name s[a, b) a function called here (a "(" follows)? Sets needs_js for a non-ASCII quoted name. */
static i32 fn_called(i32 a, i32 b, i32 after, i32 hi, i32 quoted) {
  i32 next = skip_ws_comments(T, after, hi);
  if (!(next < hi && T[next] == '(')) return 0;
  if (quoted) {
    for (i32 i = a; i < b; i++)
      if (T[i] >= 128) {
        needs_js = 1;
        return 0;
      }
  }
  return is_fn_name(T, a, b);
}

/* ------------------------------------------------------------------ the multi-word keywords */

typedef struct { i32 words; const char *w[3]; } Pattern;
static const Pattern PATTERNS[] = {
  { 2, { "GROUP", "BY", 0 } },
  { 2, { "ORDER", "BY", 0 } },
  { 2, { "UNION", "ALL", 0 } },
  { 2, { "LEFT", "JOIN", 0 } },
  { 2, { "RIGHT", "JOIN", 0 } },
  { 2, { "INNER", "JOIN", 0 } },
  { 2, { "FULL", "JOIN", 0 } },
  { 2, { "CROSS", "JOIN", 0 } },
  { 2, { "ARRAY", "JOIN", 0 } },
  { 3, { "LEFT", "ARRAY", "JOIN" } },
};
#define NPATTERNS 10

static i32 word_at(const u16 *s, i32 pos, i32 hi, const char *lit) {
  i32 n = 0;
  while (lit[n]) n++;
  if (pos + n > hi) return -1;
  for (i32 i = 0; i < n; i++)
    if (lower(s[pos + i]) != lower((u32)(u8)lit[i])) return -1;
  return pos + n;
}

typedef struct { const u16 *s; i32 lo, hi; const Pattern *pat; u8 *fail; } Ctx;
/* ws_loop and match_from_word share one failure memo per match attempt: fail[(position - lo) * 3 + word number]. */

/* After the unit run at e (one or more ws units), the word number w, then the rest of the pattern. Returns the end of the match or -1. */
static i32 match_from_word(Ctx *c, i32 pos, i32 w);

static i32 ws_loop(Ctx *c, i32 q, i32 w) {
  const u16 *s = c->s;
  i32 hi = c->hi;
  if (q >= hi) return -1;
  if (c->fail && c->fail[(q - c->lo) * 3 + w]) return -1;
  i32 result = -1;
  u32 ch = s[q];
  if (is_space(ch)) {
    i32 e = q;
    while (e < hi && is_space(s[e])) e++;
    result = ws_loop(c, e, w);
    if (result < 0) result = match_from_word(c, e, w);
  } else if (ch == '/' && q + 1 < hi && s[q + 1] == '*') {
    /* the lazy comment: every "*" "/" at or after q + 2, nearest first */
    if (!c->fail) {
      i32 size = ((hi - c->lo) + 1) * 3;
      c->fail = NEW(u8, size);
      if (c->fail)
        for (i32 k = 0; k < size; k++) c->fail[k] = 0;
    }
    for (i32 e = q + 2; e + 1 < hi && result < 0; e++) {
      if (s[e] == '*' && s[e + 1] == '/') {
        i32 after = e + 2;
        result = ws_loop(c, after, w);
        if (result < 0) result = match_from_word(c, after, w);
      }
    }
  } else if ((ch == '-' && q + 1 < hi && s[q + 1] == '-') || ch == '#') {
    i32 e = q + (ch == '#' ? 1 : 2);
    while (e < hi && s[e] != '\n') e++;
    if (e < hi) {
      result = ws_loop(c, e + 1, w);
      if (result < 0) result = match_from_word(c, e + 1, w);
    }
  }
  if (result < 0 && c->fail) c->fail[(q - c->lo) * 3 + w] = 1;
  return result;
}

static i32 match_from_word(Ctx *c, i32 pos, i32 w) {
  i32 end = word_at(c->s, pos, c->hi, c->pat->w[w]);
  if (end < 0) return -1;
  if (w == c->pat->words - 1) {
    if (end < c->hi && is_word_char(c->s[end])) return -1;
    return end;
  }
  /* ws+ then the next word */
  return ws_loop(c, end, w + 1);
}

/* The failure memo is allocated at the first block comment: it is the only way to more than one path. */
static i32 match_pattern(const u16 *s, i32 lo, i32 hi, i32 p, const Pattern *pat) {
  Ctx c;
  c.s = s;
  c.lo = lo;
  c.hi = hi;
  c.pat = pat;
  c.fail = 0;
  usize mark = wasm_mark();
  i32 end = match_from_word(&c, p, 0);
  wasm_release(mark);
  return end;
}

typedef struct { i32 start, end; } Range;

static i32 find_ranges(const u16 *s, i32 lo, i32 hi, Range *out, i32 cap) {
  i32 n = 0;
  i32 from[NPATTERNS];
  for (i32 k = 0; k < NPATTERNS; k++) from[k] = lo;
  for (i32 p = lo; p < hi; p++) {
    u32 c = s[p];
    if (!is_word_start(c)) continue;
    if (p > lo && is_word_char(s[p - 1])) continue;
    u32 first = lower(c);
    if (first != 'g' && first != 'o' && first != 'u' && first != 'l' && first != 'r' && first != 'i' && first != 'f' && first != 'c' && first != 'a') continue;
    for (i32 k = 0; k < NPATTERNS; k++) {
      if (p < from[k] || first != lower((u32)(u8)PATTERNS[k].w[0][0])) continue;
      i32 end = match_pattern(s, lo, hi, p, &PATTERNS[k]);
      if (end < 0) continue;
      if (n < cap) {
        out[n].start = p;
        out[n].end = end;
        n++;
      }
      from[k] = end > p ? end : p + 1;
    }
  }
  /* sort by start, then end (heap sort: no recursion, no extra memory) */
  for (i32 i = n / 2 - 1; i >= 0; i--) {
    i32 root = i;
    for (;;) {
      i32 child = root * 2 + 1;
      if (child >= n) break;
      if (child + 1 < n && (out[child].start < out[child + 1].start || (out[child].start == out[child + 1].start && out[child].end < out[child + 1].end))) child++;
      if (out[root].start < out[child].start || (out[root].start == out[child].start && out[root].end < out[child].end)) {
        Range t = out[root]; out[root] = out[child]; out[child] = t;
        root = child;
      } else break;
    }
  }
  for (i32 last = n - 1; last > 0; last--) {
    Range t = out[0]; out[0] = out[last]; out[last] = t;
    i32 root = 0;
    for (;;) {
      i32 child = root * 2 + 1;
      if (child >= last) break;
      if (child + 1 < last && (out[child].start < out[child + 1].start || (out[child].start == out[child + 1].start && out[child].end < out[child + 1].end))) child++;
      if (out[root].start < out[child].start || (out[root].start == out[child].start && out[root].end < out[child].end)) {
        Range r = out[root]; out[root] = out[child]; out[child] = r;
        root = child;
      } else break;
    }
  }
  /* merge touching or overlapping ranges */
  i32 m = 0;
  for (i32 i = 0; i < n; i++) {
    if (m == 0 || out[i].start > out[m - 1].end) out[m++] = out[i];
    else if (out[i].end > out[m - 1].end) out[m - 1].end = out[i].end;
  }
  return m;
}

/* ------------------------------------------------------------------ tokenizePlain */

/* The regex /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/ on s[i, hi): the length of the match, 0 for none. */
static i32 number_length(const u16 *s, i32 i, i32 hi) {
  i32 j = i;
  if (j < hi && s[j] == '-') j++;
  i32 d = j;
  while (j < hi && is_digit(s[j])) j++;
  if (j == d) return 0;
  if (j + 1 < hi && s[j] == '.' && is_digit(s[j + 1])) {
    j++;
    while (j < hi && is_digit(s[j])) j++;
  }
  if (j < hi && (s[j] == 'e' || s[j] == 'E')) {
    i32 k = j + 1;
    if (k < hi && (s[k] == '+' || s[k] == '-')) k++;
    if (k < hi && is_digit(s[k])) {
      while (k < hi && is_digit(s[k])) k++;
      j = k;
    }
  }
  return j - i;
}

static void tokenize_plain(i32 lo, i32 hi) {
  if (hi <= lo) return;
  if (!word_tables_ready) init_word_tables();
  const u16 *s = T;
  /* the patterns of two or three words */
  i32 mark = (i32)wasm_mark();
  i32 cap = (hi - lo) / 3 + 4;
  Range *ranges = NEW(Range, cap);
  i32 nr = 0;
  if (ranges) nr = find_ranges(s, lo, hi, ranges, cap);
  if (nr > 0) {
    i32 cur = lo;
    for (i32 r = 0; r < nr; r++) {
      if (ranges[r].start > cur) tokenize_plain(cur, ranges[r].start);
      emit(ranges[r].start, ranges[r].end, K_KW);
      cur = ranges[r].end;
    }
    if (cur < hi) tokenize_plain(cur, hi);
    wasm_release((usize)mark);
    return;
  }
  wasm_release((usize)mark);

  i32 i = lo, seg = lo;
  while (i < hi) {
    u32 c = s[i];

    if (c == '`') {
      i32 j = i + 1;
      while (j < hi && s[j] != '`') j++;
      if (j >= hi) {
        i += 1;
        continue;
      }
      i32 end = j + 1;
      i32 is_fn = 0;
      if (has_fn) is_fn = fn_called(i + 1, j, end, hi, 1);
      if (is_fn) {
        emit(seg, i, K_PLAIN);
        emit(i, i + 1, K_PLAIN);
        emit(i + 1, j, K_FN);
        emit(j, j + 1, K_PLAIN);
        seg = end;
      }
      i = end;
      continue;
    }

    if (is_digit(c) || (c == '-' && i + 1 < hi && is_digit(s[i + 1]))) {
      if (i == lo || !is_word_char(s[i - 1])) {
        i32 len = number_length(s, i, hi);
        if (len > 0) {
          emit(seg, i, K_PLAIN);
          emit(i, i + len, K_NUM);
          seg = i + len;
          i = seg;
          continue;
        }
      }
    }

    if (!is_word_start(c)) {
      i += 1;
      continue;
    }
    i32 j = i + 1;
    while (j < hi && is_word_char(s[j])) j++;
    u32 hash_exact, hash_folded;
    word_hashes(s, i, j, &hash_exact, &hash_folded);
    if (table_has(type_table, s, i, j, hash_exact, 0)) {
      emit(seg, i, K_PLAIN);
      emit(i, j, K_TYPE);
      seg = j;
      i = j;
      continue;
    }
    i32 is_common = table_has(kw_table, s, i, j, hash_folded, 1);
    i32 is_kw = is_common;
    if (!is_kw && has_kw) {
      u16 buf[64];
      i32 n = j - i;
      u16 *low = n <= 64 ? buf : NEW(u16, n);
      if (low) {
        for (i32 k = 0; k < n; k++) low[k] = (u16)lower(s[i + k]);
        is_kw = set_has(&sets[SET_KW], low, (u32)n);
      }
    }
    i32 is_null = is_kw && str_eq_lower(s, i, j, "null");
    i32 is_fn = 0;
    if (has_fn) is_fn = fn_called(i, j, j, hi, 0);
    if (is_kw || is_fn) {
      emit(seg, i, K_PLAIN);
      emit(i, j, is_fn ? K_FN : is_null ? K_NULL : K_KW);
      seg = j;
    }
    i = j;
  }
  emit(seg, hi, K_PLAIN);
}

/* ------------------------------------------------------------------ lexAll */

static void lex_all(void) {
  const u16 *s = T;
  i32 n = tlen;
  i32 i = 0;
  enum { M_PLAIN, M_LC, M_BC, M_SQ, M_DQ } mode = M_PLAIN;
  i32 seg = 0;
  i32 kind = K_PLAIN;

#define FLUSH(end_) do { i32 e_ = (end_); if (e_ <= seg) { seg = e_; } else { if (kind == K_PLAIN) tokenize_plain(seg, e_); else emit(seg, e_, kind); seg = e_; } } while (0)
#define OPEN(m_, k_, at_) do { FLUSH(at_); mode = (m_); kind = (k_); seg = (at_); } while (0)
#define CLOSE(at_) do { FLUSH(at_); mode = M_PLAIN; kind = K_PLAIN; seg = (at_); } while (0)

  while (i < n) {
    u32 c = s[i];
    i32 has_next = i + 1 < n;
    u32 nx = has_next ? s[i + 1] : 0xffffffffu;

    if (mode == M_LC) {
      i += 1;
      if (c == '\n') CLOSE(i);
      continue;
    }
    if (mode == M_BC) {
      if (c == '*' && nx == '/') {
        i += 2;
        CLOSE(i);
        continue;
      }
      i += 1;
      continue;
    }
    if (mode == M_SQ) {
      if (c == '\\') {
        i += has_next ? 2 : 1;
        continue;
      }
      if (c == '\'' && nx == '\'') {
        i += 2;
        continue;
      }
      if (c == '\'') {
        i += 1;
        CLOSE(i);
        continue;
      }
      i += 1;
      continue;
    }
    if (mode == M_DQ) {
      if (c == '\\') {
        i += has_next ? 2 : 1;
        continue;
      }
      if (c == '"') {
        i += 1;
        CLOSE(i);
        continue;
      }
      i += 1;
      continue;
    }

    if (c == '-' && nx == '-') {
      OPEN(M_LC, K_COM, i);
      i += 2;
      continue;
    }
    if (c == '#') {
      OPEN(M_LC, K_COM, i);
      i += 1;
      continue;
    }
    if (c == '/' && nx == '*') {
      OPEN(M_BC, K_COM, i);
      i += 2;
      continue;
    }
    if (c == '\'') {
      OPEN(M_SQ, K_STR, i);
      i += 1;
      continue;
    }
    if (c == '"') {
      OPEN(M_DQ, K_STR, i);
      i += 1;
      continue;
    }
    if (c == '`') {
      i += 1;
      while (i < n && s[i] != '`') i += 1;
      if (i < n) i += 1;
      continue;
    }
    i += 1;
  }
  FLUSH(n);
#undef FLUSH
#undef OPEN
#undef CLOSE
}

/* ------------------------------------------------------------------ HTML */

static const char *const SPAN_OPEN[] = { 0, "<span class=\"tok-kw\">", "<span class=\"tok-fn\">", "<span class=\"tok-num\">",
  "<span class=\"tok-null\">", "<span class=\"tok-type\">", "<span class=\"tok-str\">", "<span class=\"tok-com\">" };
static i32 span_open_len[8];
#define SPAN_CLOSE_LEN 7

static inline i32 escaped_len(u32 c) {
  switch (c) {
    case '&': return 5;
    case '<': return 4;
    case '>': return 4;
    case '"': return 6;
    case '\'': return 6;
    default: return 1;
  }
}

static u16 *out_html;
static i32 out_len;

static void put_ascii(const char *p, i32 n) {
  for (i32 i = 0; i < n; i++) out_html[out_len++] = (u16)(u8)p[i];
}

static void put_escaped(i32 a, i32 b) {
  for (i32 i = a; i < b; i++) {
    u32 c = T[i];
    switch (c) {
      case '&': put_ascii("&amp;", 5); break;
      case '<': put_ascii("&lt;", 4); break;
      case '>': put_ascii("&gt;", 4); break;
      case '"': put_ascii("&quot;", 6); break;
      case '\'': put_ascii("&#039;", 6); break;
      default: out_html[out_len++] = (u16)c;
    }
  }
}

/* Results of the last hl_run(). */
static i32 result_tokens_ptr, result_count, result_html_ptr, result_html_len;

EXPORT(hl_tokens_ptr) i32 hl_tokens_ptr(void) { return result_tokens_ptr; }
EXPORT(hl_html_ptr) i32 hl_html_ptr(void) { return result_html_ptr; }

/* Lexes text[0, len). Returns the token count (>= 0, may be 0 for an empty text), -1 for no memory, NEEDS_JS (-2) when the
   JavaScript path must answer. The tokens (five i32 each: start, end, kind, html start, html end) and the HTML are left in the
   arena: read them, then release the mark taken before the call. hl_html_length() is the length of the HTML in code units. */
EXPORT(hl_run) i32 hl_run(const u16 *text, i32 len) {
  T = text;
  tlen = len;
  ntok = 0;
  overflow = 0;
  needs_js = 0;
  result_html_len = 0;
  if (len <= 0) return 0;
  for (i32 k = 1; k < 8; k++) {
    i32 n = 0;
    while (SPAN_OPEN[k][n]) n++;
    span_open_len[k] = n;
  }
  ntok_cap = len + 1;
  toks = NEW(Tok, ntok_cap);
  if (!toks) return -1;
  lex_all();
  if (overflow) return -1;
  if (needs_js) return NEEDS_JS;
  i32 total = 0;
  for (i32 t = 0; t < ntok; t++) {
    i32 n = 0;
    for (i32 i = toks[t].start; i < toks[t].end; i++) n += escaped_len(T[i]);
    if (toks[t].kind != K_PLAIN) n += span_open_len[toks[t].kind] + SPAN_CLOSE_LEN;
    total += n;
  }
  out_html = NEW(u16, total + 1);
  if (!out_html) return -1;
  out_len = 0;
  for (i32 t = 0; t < ntok; t++) {
    toks[t].hs = out_len;
    if (toks[t].kind != K_PLAIN) put_ascii(SPAN_OPEN[toks[t].kind], span_open_len[toks[t].kind]);
    put_escaped(toks[t].start, toks[t].end);
    if (toks[t].kind != K_PLAIN) put_ascii("</span>", SPAN_CLOSE_LEN);
    toks[t].he = out_len;
  }
  result_tokens_ptr = (i32)(usize)toks;
  result_html_ptr = (i32)(usize)out_html;
  result_html_len = out_len;
  result_count = ntok;
  return ntok;
}

EXPORT(hl_html_length) i32 hl_html_length(void) { return result_html_len; }
