/* sqlscan.c: the text scans of the editor diagnostics of src/static/app_autocomplete.js (computeDiagnostics).
 *
 * The JavaScript reference scans the whole script again and again (the depth of a position is recounted from the start for
 * every position). This kernel does every text scan once, in one pass over UTF-16 code units, and answers with rows of
 * numbers: where each SELECT, FROM / JOIN, item, alias, lambda parameter, identifier and function call is. The page keeps
 * everything that needs the host's metadata (tables, columns): it reads the rows and decides.
 *
 * Every function below follows a function of app_autocomplete.js; the comment names it. The tests compare the final
 * diagnostics of both implementations on a large corpus (tests/frontend/specs/wasm-sql.spec.js).
 */
#include "rt.h"

/* ------------------------------------------------------------------ vectors and name sets */

typedef struct { i32 *p; i32 n, cap; } Vec;
static i32 oom;

static void vpush(Vec *v, i32 x) {
  if (v->n == v->cap) {
    i32 nc = v->cap ? v->cap * 2 : 256;
    i32 *np = NEW(i32, nc);
    if (!np) {
      oom = 1;
      return;
    }
    for (i32 i = 0; i < v->n; i++) np[i] = v->p[i];
    v->p = np;
    v->cap = nc;
  }
  v->p[v->n++] = x;
}

typedef struct { u32 cap; u32 *slot; u32 *off; u32 *len; u16 *pool; } Set;
enum { SET_KW = 0, SET_FUNC = 1, SET_TFUNC = 2, SET_DTYPE = 3, SET_COUNT = 4 };
static Set sets[SET_COUNT];

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

/* data: [length, code units...] for each name. The tables stay in the instance: call before the first mark. */
EXPORT(sq_set_names) i32 sq_set_names(i32 which, const u16 *data, i32 units, i32 count) {
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

/* ------------------------------------------------------------------ characters */

static inline i32 is_digit(u32 c) { return c >= 48 && c <= 57; }
static inline i32 is_letter(u32 c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
/* \w of a JavaScript regular expression */
static inline i32 is_word(u32 c) { return is_digit(c) || is_letter(c) || c == 95; }
/* [A-Za-z0-9_$]: a character of an identifier */
static inline i32 is_idch(u32 c) { return is_word(c) || c == 36; }
static inline i32 is_idstart(u32 c) { return is_letter(c) || c == 95; }
static inline u32 lower(u32 c) { return (c >= 65 && c <= 90) ? c + 32u : c; }

/* \s of a JavaScript regular expression, and what String.prototype.trim removes. */
static i32 is_space(u32 c) {
  if (c == 32 || (c >= 9 && c <= 13)) return 1;
  if (c < 160) return 0;
  return c == 160 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}

/* Case-insensitive match of the lower-case ASCII literal at s[p, end). */
static i32 ci_at(const u16 *s, i32 p, i32 end, const char *lit) {
  i32 i = 0;
  for (; lit[i]; i++) {
    if (p + i >= end || lower(s[p + i]) != (u32)(u8)lit[i]) return 0;
  }
  return 1;
}

static i32 skip_ws(const u16 *s, i32 p, i32 end) {
  while (p < end && is_space(s[p])) p++;
  return p;
}

/* ------------------------------------------------------------------ the document */

static const u16 *V;   /* the text */
static i32 N;
static u16 *M;         /* maskSql(V) */
static i32 *D;         /* D[i]: the parenthesis depth before character i (topLevelDepthAt), N + 1 entries */
static u16 *scratch;   /* a masked item, N entries */

/* maskSql(): comments and the text of 'strings' become spaces (a newline stays); the length stays. */
static void mask_into(const u16 *src, i32 len, u16 *dst) {
  i32 line = 0, block = 0, quote = 0, escaped = 0;
  i32 o = 0;
  for (i32 i = 0; i < len; i++) {
    u32 ch = src[i];
    u32 next = i + 1 < len ? src[i + 1] : 0xffffffffu;
    if (line) {
      if (ch == '\n') {
        line = 0;
        dst[o++] = '\n';
      } else dst[o++] = ' ';
      continue;
    }
    if (block) {
      if (ch == '*' && next == '/') {
        dst[o++] = ' ';
        dst[o++] = ' ';
        block = 0;
        i += 1;
      } else dst[o++] = ch == '\n' ? '\n' : ' ';
      continue;
    }
    if (quote) {
      if (ch == '\\' && !escaped) {
        escaped = 1;
        dst[o++] = ' ';
        continue;
      }
      if (ch == '\'' && !escaped) quote = 0;
      escaped = 0;
      dst[o++] = ch == '\n' ? '\n' : ' ';
      continue;
    }
    if (ch == '-' && next == '-') {
      line = 1;
      dst[o++] = ' ';
      dst[o++] = ' ';
      i += 1;
      continue;
    }
    if (ch == '#') {
      line = 1;
      dst[o++] = ' ';
      continue;
    }
    if (ch == '/' && next == '*') {
      block = 1;
      dst[o++] = ' ';
      dst[o++] = ' ';
      i += 1;
      continue;
    }
    if (ch == '\'') {
      quote = 1;
      escaped = 0;
      dst[o++] = ' ';
      continue;
    }
    dst[o++] = (u16)ch;
  }
}

/* previousWordBefore(masked, index): the word before index (spaces skipped) as [*a, *b), empty when none. */
static void prev_word(i32 index, i32 *a, i32 *b) {
  i32 e = index;
  while (e > 0 && is_space(M[e - 1])) e--;
  i32 s0 = e;
  while (s0 > 0 && is_idch(M[s0 - 1])) s0--;
  i32 w = s0;
  while (w < e && !is_idstart(M[w])) w++;
  if (w >= e) {
    *a = *b = 0;
    return;
  }
  *a = w;
  *b = e;
}

static i32 prev_word_is(i32 index, const char *lit) {
  i32 a, b;
  prev_word(index, &a, &b);
  if (b <= a) return 0;
  i32 n = 0;
  while (lit[n]) n++;
  return (b - a == n) && ci_at(M, a, b, lit);
}

/* ------------------------------------------------------------------ identifiers (identReSource) */

/* One identifier at s[p, end): `quoted`, "quoted", (with alias: 'quoted',) or a bare word. Returns its end or -1. */
static i32 read_ident(const u16 *s, i32 p, i32 end, i32 alias_mode) {
  if (p >= end) return -1;
  u32 c = s[p];
  if (c == '`' || c == '"' || (alias_mode && c == '\'')) {
    i32 q = p + 1;
    if (q >= end || s[q] == c) return -1;
    while (q < end && s[q] != c) q++;
    return q < end ? q + 1 : -1;
  }
  if (is_idstart(c)) {
    i32 q = p + 1;
    while (q < end && is_idch(s[q])) q++;
    return q;
  }
  return -1;
}

/* qualifiedIdentReSource: ident (\s* . \s* ident)*. Returns the end or -1. */
static i32 read_qualified(const u16 *s, i32 p, i32 end) {
  i32 e = read_ident(s, p, end, 0);
  if (e < 0) return -1;
  for (;;) {
    i32 q = skip_ws(s, e, end);
    if (q < end && s[q] == '.') {
      i32 r = skip_ws(s, q + 1, end);
      i32 ie = read_ident(s, r, end, 0);
      if (ie >= 0) {
        e = ie;
        continue;
      }
    }
    break;
  }
  return e;
}

/* ------------------------------------------------------------------ select items and aliases */

/* The tail of an item: an identifier (alias mode) at the end, behind whitespace. Sets the identifier [k0, k1) and the start
   of the whitespace run before it. Returns 0 when the item does not end that way. */
static i32 parse_tail(const u16 *s, i32 a, i32 b, i32 *k0, i32 *k1, i32 *run0) {
  i32 e = b;
  while (e > a && is_space(s[e - 1])) e--;
  if (e <= a) return 0;
  u32 c = s[e - 1];
  i32 start;
  if (c == '`' || c == '"' || c == '\'') {
    i32 k = e - 2;
    while (k >= a && s[k] != c) k--;
    if (k < a) return 0;
    if (e - 1 - k - 1 < 1) return 0;
    start = k;
  } else if (is_idch(c)) {
    i32 k = e - 1;
    while (k >= a && is_idch(s[k])) k--;
    start = k + 1;
    if (!is_idstart(s[start])) return 0;
  } else return 0;
  if (start <= a || !is_space(s[start - 1])) return 0;
  i32 r = start - 1;
  while (r > a && is_space(s[r - 1])) r--;
  *k0 = start;
  *k1 = e;
  *run0 = r;
  return 1;
}

/* findSelectAliasRange(): the alias of s[a, b) as [*k0, *k1); *as_run is where the whitespace before AS starts (-1: no AS). */
static i32 find_alias_range(const u16 *s, i32 a, i32 b, i32 *k0, i32 *k1, i32 *as_run) {
  i32 t0, t1, run0;
  *as_run = -1;
  if (!parse_tail(s, a, b, &t0, &t1, &run0)) return 0;
  /* \s+AS\s+ident: AS ends where the whitespace before the identifier starts, behind whitespace of its own */
  if (run0 - 2 > a && ci_at(s, run0 - 2, run0, "as") && is_space(s[run0 - 3])) {
    i32 r = run0 - 3;
    while (r > a && is_space(s[r - 1])) r--;
    *k0 = t0;
    *k1 = t1;
    *as_run = r;
    return 1;
  }
  /* \s+ident with an operator, a parenthesis or a space before it */
  for (i32 i = a; i < run0; i++) {
    u32 c = s[i];
    if (c == '(' || c == ')' || c == '+' || c == '-' || c == '*' || c == '/' || c == '%' || is_space(c)) {
      *k0 = t0;
      *k1 = t1;
      return 1;
    }
  }
  return 0;
}

/* The start of the whitespace before an unfinished "AS `abc" at the end of s[a, b), or -1 (expressionSpanBeforeAlias). */
static i32 unfinished_alias(const u16 *s, i32 a, i32 b) {
  i32 i = a;
  while (i < b) {
    if (!is_space(s[i])) {
      i++;
      continue;
    }
    i32 r0 = i;
    while (i < b && is_space(s[i])) i++;
    if (i + 2 <= b && ci_at(s, i, b, "as") && i + 2 < b && is_space(s[i + 2])) {
      i32 q = skip_ws(s, i + 2, b);
      if (q < b && (s[q] == '`' || s[q] == '"' || s[q] == '\'')) {
        u32 c = s[q];
        i32 later = 0;
        for (i32 k = q + 1; k < b; k++)
          if (s[k] == c) {
            later = 1;
            break;
          }
        if (!later) return r0;
      }
    }
  }
  return -1;
}

/* splitTopLevelWithSpans(): the top-level comma separated pieces of s[a, b), trimmed; calls emit(start, end). */
typedef void (*Emit2)(i32, i32, void *);
static void split_top(const u16 *s, i32 a, i32 b, Emit2 emit, void *ctx) {
  i32 start = a, depth = 0, escaped = 0;
  u32 quote = 0;
#define PIECE(endpos) do { i32 x_ = start, y_ = (endpos); while (x_ < y_ && is_space(s[x_])) x_++; while (y_ > x_ && is_space(s[y_ - 1])) y_--; if (y_ > x_) emit(x_, y_, ctx); } while (0)
  for (i32 i = a; i < b; i++) {
    u32 ch = s[i];
    if (quote) {
      if (quote == '\'' && ch == '\\' && !escaped) {
        escaped = 1;
        continue;
      }
      if (ch == quote && !escaped) quote = 0;
      escaped = 0;
      continue;
    }
    if (ch == '\'' || ch == '`' || ch == '"') {
      quote = ch;
      escaped = 0;
      continue;
    }
    if (ch == '(') depth += 1;
    else if (ch == ')') depth = depth > 0 ? depth - 1 : 0;
    else if (ch == ',' && depth == 0) {
      PIECE(i);
      start = i + 1;
    }
  }
  PIECE(b);
#undef PIECE
}

/* ------------------------------------------------------------------ lambda parameters and identifier references */

static Vec v_lam, v_ref, v_item, v_aj, v_sel, v_rel, v_fn;

/* collectLambdaParams(): the parameter names of s[a, b), as ranges into the text. Returns how many. */
static i32 lambda_params(const u16 *s, i32 a, i32 b) {
  i32 count = 0;
  /* \b([A-Za-z_][A-Za-z0-9_$]*)\s*-> */
  i32 p = a;
  while (p < b) {
    u32 c = s[p];
    if (is_idstart(c) && (p == a || !is_word(s[p - 1]))) {
      i32 e = p + 1;
      while (e < b && is_idch(s[e])) e++;
      i32 q = skip_ws(s, e, b);
      if (q + 1 < b && s[q] == '-' && s[q + 1] == '>') {
        vpush(&v_lam, p);
        vpush(&v_lam, e);
        count++;
        p = q + 2;
        continue;
      }
    }
    p++;
  }
  /* \(([^)]{1,160})\)\s*-> then the comma separated names */
  p = a;
  while (p < b) {
    if (s[p] == '(') {
      i32 j = p + 1;
      while (j < b && s[j] != ')') j++;
      if (j < b && j - (p + 1) >= 1 && j - (p + 1) <= 160) {
        i32 q = skip_ws(s, j + 1, b);
        if (q + 1 < b && s[q] == '-' && s[q + 1] == '>') {
          i32 start = p + 1;
          for (i32 i = p + 1; i <= j; i++) {
            if (i == j || s[i] == ',') {
              i32 x = start, y = i;
              while (x < y && is_space(s[x])) x++;
              while (y > x && is_space(s[y - 1])) y--;
              if (y > x && is_idstart(s[x])) {
                i32 k = x + 1;
                while (k < y && is_idch(s[k])) k++;
                if (k == y) {
                  vpush(&v_lam, x);
                  vpush(&v_lam, y);
                  count++;
                }
              }
              start = i + 1;
            }
          }
          p = q + 2;
          continue;
        }
      }
    }
    p++;
  }
  return count;
}

/* collectIdentifierRefs(): the qualified identifiers of the expression s[a, b) that can be a column (the host's keywords
   and the digits are filtered by the page). Returns how many. */
static i32 identifier_refs(const u16 *s, i32 a, i32 b) {
  i32 len = b - a;
  mask_into(s + a, len, scratch);
  const u16 *m = scratch;
  i32 count = 0;
  i32 p = 0;
  while (p < len) {
    u32 c = m[p];
    if (!(is_idstart(c) || c == '`' || c == '"')) {
      p++;
      continue;
    }
    i32 e = read_qualified(m, p, len);
    if (e < 0) {
      p++;
      continue;
    }
    u32 before = p > 0 ? m[p - 1] : 0;
    i32 q = skip_ws(m, e, len);
    i32 call = (q < len && m[q] == '(');
    i32 keep = !(before == '.') && !is_digit(before) && !call;
    if (keep) {
      vpush(&v_ref, a + p);
      vpush(&v_ref, a + e);
      count++;
    }
    p = e;
  }
  return count;
}

static i32 g_item_count;

static void emit_item(i32 a, i32 b, void *ctx) {
  (void)ctx;
  i32 k0 = -1, k1 = -1, as_run = -1;
  i32 have = find_alias_range(V, a, b, &k0, &k1, &as_run);
  /* expressionSpanBeforeAlias() */
  i32 cut = b;
  i32 unf = unfinished_alias(V, a, b);
  if (unf >= 0) cut = unf;
  else if (have) {
    cut = k0;
    /* beforeAlias.match(/\s+AS\s*$/i) */
    i32 e = k0;
    while (e > a && is_space(V[e - 1])) e--;
    if (e - 2 > a && ci_at(V, e - 2, e, "as") && is_space(V[e - 3])) {
      i32 r = e - 3;
      while (r > a && is_space(V[r - 1])) r--;
      cut = r;
    }
  }
  i32 x = a, y = cut;
  while (x < y && is_space(V[x])) x++;
  while (y > x && is_space(V[y - 1])) y--;
  i32 lam0 = v_lam.n / 2, ref0 = v_ref.n / 2;
  i32 lams = 0, refs = 0;
  if (y > x) {
    lams = lambda_params(V, x, y);
    refs = identifier_refs(V, x, y);
  }
  vpush(&v_item, a);
  vpush(&v_item, b);
  vpush(&v_item, x);
  vpush(&v_item, y);
  vpush(&v_item, have ? k0 : -1);
  vpush(&v_item, have ? k1 : -1);
  vpush(&v_item, lam0);
  vpush(&v_item, lams);
  vpush(&v_item, ref0);
  vpush(&v_item, refs);
  g_item_count++;
}

static void emit_aj_alias(i32 a, i32 b, void *ctx) {
  (void)ctx;
  i32 k0, k1, as_run;
  if (find_alias_range(V, a, b, &k0, &k1, &as_run)) {
    vpush(&v_aj, k0);
    vpush(&v_aj, k1);
    g_item_count++;
  }
}

/* ------------------------------------------------------------------ clauses (collectArrayJoinAliases) */

typedef struct { i32 words; const char *w[3]; } Clause;
static const Clause CLAUSES[] = {
  { 3, { "global", "array", "join" } }, { 2, { "array", "join", 0 } }, { 1, { "prewhere", 0, 0 } }, { 1, { "where", 0, 0 } },
  { 2, { "group", "by", 0 } }, { 1, { "having", 0, 0 } }, { 2, { "order", "by", 0 } }, { 2, { "limit", "by", 0 } },
  { 1, { "limit", 0, 0 } }, { 1, { "offset", 0, 0 } }, { 1, { "settings", 0, 0 } }, { 1, { "format", 0, 0 } },
  { 1, { "qualify", 0, 0 } }, { 1, { "window", 0, 0 } }, { 1, { "sample", 0, 0 } },
};
#define NCLAUSES 15

/* clauseRe.exec(masked) from `from`: the leftmost match [*idx, *end) and the number of its alternative, or -1. */
static i32 clause_match(i32 from, i32 *idx, i32 *end) {
  for (i32 p = from; p < N; p++) {
    u32 c = M[p];
    if (!is_letter(c)) continue;
    if (p > 0 && is_word(M[p - 1])) continue;
    for (i32 k = 0; k < NCLAUSES; k++) {
      const Clause *cl = &CLAUSES[k];
      i32 pos = p, ok = 1;
      for (i32 w = 0; w < cl->words && ok; w++) {
        if (w > 0) {
          i32 q = skip_ws(M, pos, N);
          if (q == pos) {
            ok = 0;
            break;
          }
          pos = q;
        }
        if (!ci_at(M, pos, N, cl->w[w])) {
          ok = 0;
          break;
        }
        i32 n = 0;
        while (cl->w[w][n]) n++;
        pos += n;
      }
      if (!ok) continue;
      if (pos < N && is_word(M[pos])) continue;
      *idx = p;
      *end = pos;
      return k;
    }
  }
  return -1;
}

/* The array join aliases of one SELECT, as ranges. */
static i32 array_join_aliases(i32 select_pos, i32 scope_end, i32 depth) {
  i32 before = v_aj.n / 2;
  g_item_count = 0;
  i32 last = select_pos + 6 > 0 ? select_pos + 6 : 0;
  for (;;) {
    i32 idx, end;
    i32 k = clause_match(last, &idx, &end);
    if (k < 0) break;
    if (idx >= scope_end) break;
    last = end;
    if (D[idx] != depth) continue;
    if (k != 0 && k != 1) continue;
    i32 body_start = end, body_end = scope_end;
    i32 pos = body_start;
    for (;;) {
      i32 nidx, nend;
      i32 nk = clause_match(pos, &nidx, &nend);
      if (nk < 0) break;
      if (nidx >= scope_end) break;
      pos = nend;
      if (D[nidx] != depth) continue;
      if (prev_word_is(nidx, "as")) continue;
      body_end = nidx;
      break;
    }
    if (body_start < body_end) split_top(V, body_start, body_end, emit_aj_alias, 0);
    last = body_end;
  }
  return v_aj.n / 2 - before;
}

/* ------------------------------------------------------------------ the statement of a position (currentStatementAt) */

static const char *const RELATION_STARTERS[] = { "from", "join", "into", "update", "describe", "desc", "table", 0 };
static const char *const ALIAS_STOP[] = {
  "array", "global", "final", "sample", "prewhere", "where", "group", "having", "order", "limit", "offset", "settings", "format", "join",
  "inner", "left", "right", "full", "cross", "any", "all", "asof", "semi", "anti", "on", "using", 0 };

static i32 in_list(const u16 *s, i32 a, i32 b, const char *const *list) {
  i32 n = b - a;
  for (i32 k = 0; list[k]; k++) {
    const char *lit = list[k];
    i32 i = 0;
    while (i < n && lit[i] && lower(s[a + i]) == (u32)(u8)lit[i]) i++;
    if (i == n && !lit[i]) return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ names (normalizeQualifiedName) */

/* normalizeQualifiedName(s[a, b)) into out (capacity b - a); returns the length. Ranges of ASCII text only. */
static i32 normalize_qualified(const u16 *s, i32 a, i32 b, u16 *out) {
  i32 o = 0, pa = a;
  for (i32 i = a; i <= b; i++) {
    if (i == b || s[i] == '.') {
      i32 x = pa, y = i;
      while (x < y && is_space(s[x])) x++;
      while (y > x && is_space(s[y - 1])) y--;
      /* stripQuotes() */
      i32 start = o;
      if (o > 0) out[o++] = '.';
      i32 cn = 0;
      if (y - x >= 2 && (s[x] == '`' || s[x] == '"' || s[x] == '\'') && s[y - 1] == s[x]) {
        u32 q = s[x];
        for (i32 k = x + 1; k < y - 1; k++) {
          if (q != '"' && s[k] == q && k + 1 < y - 1 && s[k + 1] == q) {
            out[o++] = (u16)q;
            cn++;
            k++;
          } else {
            out[o++] = s[k];
            cn++;
          }
        }
      } else {
        for (i32 k = x; k < y; k++) {
          out[o++] = s[k];
          cn++;
        }
      }
      if (cn == 0) o = start;
      pa = i + 1;
    }
  }
  return o;
}

static i32 starts_with_digit(const u16 *s, i32 n) { return n > 0 && is_digit(s[0]); }

static i32 lower_has(Set *set, const u16 *s, i32 n, u16 *tmp) {
  for (i32 i = 0; i < n; i++) tmp[i] = (u16)lower(s[i]);
  return set_has(set, tmp, (u32)n);
}

/* ------------------------------------------------------------------ the main scan */

EXPORT(sq_vec_ptr) i32 sq_vec_ptr(i32 id) {
  Vec *v = id == 0 ? &v_sel : id == 1 ? &v_item : id == 2 ? &v_lam : id == 3 ? &v_ref : id == 4 ? &v_aj : id == 5 ? &v_rel : &v_fn;
  return (i32)(usize)v->p;
}
EXPORT(sq_vec_len) i32 sq_vec_len(i32 id) {
  Vec *v = id == 0 ? &v_sel : id == 1 ? &v_item : id == 2 ? &v_lam : id == 3 ? &v_ref : id == 4 ? &v_aj : id == 5 ? &v_rel : &v_fn;
  return v->n;
}

static i32 g_has_from;
EXPORT(sq_has_from) i32 sq_has_from(void) { return g_has_from; }

/* Rows:
     v_sel: selectPos, depth, scopeEnd, fromPos, firstItem, itemCount, firstAliasRange, aliasRangeCount     (SELECTs that have a FROM)
     v_item: start, end, exprStart, exprEnd, aliasStart, aliasEnd, firstLambda, lambdaCount, firstRef, refCount
     v_lam, v_ref, v_aj: start, end
     v_rel: matchIndex, refStart, refEnd, flags (1: "." follows, 2: "(" follows), statementStart, statementEnd
     v_fn: start, end, status (1: an unknown function; 2: the page must decide)
   flags: 1 relations, 2 selects, 4 functions. */
EXPORT(sq_run) i32 sq_run(const u16 *text, i32 len, i32 flags) {
  V = text;
  N = len;
  oom = 0;
  v_sel = v_item = v_lam = v_ref = v_aj = v_rel = v_fn = (Vec){0, 0, 0};
  g_has_from = 0;
  if (len <= 0) return 0;
  M = NEW(u16, len + 1);
  scratch = NEW(u16, len + 1);
  D = NEW(i32, len + 1);
  if (!M || !scratch || !D) return -1;
  mask_into(text, len, M);
  D[0] = 0;
  i32 max_depth = 0;
  for (i32 i = 0; i < len; i++) {
    i32 d = D[i];
    if (M[i] == '(') d += 1;
    else if (M[i] == ')') d = d > 0 ? d - 1 : 0;
    D[i + 1] = d;
    if (d > max_depth) max_depth = d;
  }

  /* ---- FROM and JOIN: the relations (collectRelationDiagnostics) and the FROM test of computeDiagnostics */
  {
    i32 *nxt = 0, *match = 0;
    Vec found = {0, 0, 0};
    for (i32 p = 0; p + 4 <= len; p++) {
      u32 c = lower(M[p]);
      if (c != 'f' && c != 'j') continue;
      i32 is_from = ci_at(M, p, len, "from"), is_join = ci_at(M, p, len, "join");
      if (!is_from && !is_join) continue;
      if (p > 0 && is_word(M[p - 1])) continue;
      if (p + 4 < len && is_word(M[p + 4])) continue;
      if (is_from) g_has_from = 1;
      if (!(flags & 1)) continue;
      vpush(&found, p);
    }
    if ((flags & 1) && found.n > 0) {
      nxt = NEW(i32, len + 2);
      match = NEW(i32, len + 1);
      i32 *stack = NEW(i32, len + 1);
      if (!nxt || !match || !stack) return -1;
      i32 sp = 0;
      for (i32 i = 0; i < len; i++) {
        match[i] = -1;
        if (M[i] == '(') stack[sp++] = i;
        else if (M[i] == ')' && sp > 0) match[stack[--sp]] = i;
      }
      nxt[len] = len;
      nxt[len + 1] = len;
      for (i32 i = len - 1; i >= 0; i--) {
        u32 c = M[i];
        if (c == ';') nxt[i] = i;
        else if (c == '(') nxt[i] = match[i] >= 0 ? nxt[match[i] + 1] : len;
        else nxt[i] = nxt[i + 1];
      }
      /* the start of the statement: a forward pass of currentStatementBefore() */
      i32 pos = 0, start = 0, depth = 0, escaped = 0, line = 0, block = 0;
      u32 quote = 0;
      for (i32 f = 0; f < found.n; f++) {
        i32 p = found.p[f];
        for (; pos < p; pos++) {
          u32 ch = V[pos];
          u32 next = pos + 1 < len ? V[pos + 1] : 0xffffffffu;
          if (line) {
            if (ch == '\n') line = 0;
            continue;
          }
          if (block) {
            if (ch == '*' && next == '/') {
              block = 0;
              pos += 1;
            }
            continue;
          }
          if (quote) {
            if (quote == '\'' && ch == '\\' && !escaped) {
              escaped = 1;
              continue;
            }
            if (ch == quote && !escaped) quote = 0;
            escaped = 0;
            continue;
          }
          if (ch == '-' && next == '-') {
            line = 1;
            pos += 1;
            continue;
          }
          if (ch == '#') {
            line = 1;
            continue;
          }
          if (ch == '/' && next == '*') {
            block = 1;
            pos += 1;
            continue;
          }
          if (ch == '\'' || ch == '`' || ch == '"') {
            quote = ch;
            escaped = 0;
            continue;
          }
          if (ch == '(') depth += 1;
          else if (ch == ')') depth = depth > 0 ? depth - 1 : 0;
          else if (ch == ';' && depth == 0) start = pos + 1;
        }
        if (M[p] == 'j' || M[p] == 'J') {
          if (prev_word_is(p, "array")) continue;
        }
        i32 i = skip_ws(V, p + 4, len);
        if (i < len && V[i] == '(') continue;
        i32 e = i < len ? read_qualified(V, i, len) : -1;
        if (e < 0) continue;
        i32 j = skip_ws(V, e, len);
        i32 fl = 0;
        if (j < len && V[j] == '.') fl |= 1;
        if (j < len && V[j] == '(') fl |= 2;
        vpush(&v_rel, p);
        vpush(&v_rel, i);
        vpush(&v_rel, e);
        vpush(&v_rel, fl);
        vpush(&v_rel, start);
        vpush(&v_rel, nxt[p]);
      }
    }
  }

  /* ---- SELECT: the scopes, the items, the references (collectSelectReferenceDiagnostics) */
  if (flags & 2) {
    Vec sels = {0, 0, 0};
    for (i32 p = 0; p + 6 <= len; p++) {
      if (lower(M[p]) != 's') continue;
      if (!ci_at(M, p, len, "select")) continue;
      if (p > 0 && is_word(M[p - 1])) continue;
      if (p + 6 < len && is_word(M[p + 6])) continue;
      vpush(&sels, p);
    }
    if (sels.n > 0) {
      i32 *scope = NEW(i32, sels.n);
      i32 *from = NEW(i32, sels.n);
      i32 *nscope = NEW(i32, max_depth + 2);
      i32 *nfrom = NEW(i32, max_depth + 2);
      if (!scope || !from || !nscope || !nfrom) return -1;
      for (i32 d = 0; d <= max_depth; d++) nscope[d] = nfrom[d] = -1;
      i32 i = len - 1;
      for (i32 k = sels.n - 1; k >= 0; k--) {
        i32 a = sels.p[k] + 6;
        i32 depth = D[sels.p[k]];
        if (a >= len) {
          scope[k] = len;
          from[k] = -1;
          continue;
        }
        for (; i >= a; i--) {
          u32 c = M[i];
          if (c == ';' || c == ')') nscope[D[i]] = i;
          if (lower(c) == 'f' && ci_at(M, i, len, "from")) {
            i32 prev_ok = i == 0 || !is_idch(M[i - 1]);
            i32 next_ok = i + 4 >= len || !is_idch(M[i + 4]);
            if (prev_ok && next_ok && !prev_word_is(i, "as")) nfrom[D[i]] = i;
          }
        }
        scope[k] = nscope[depth] >= 0 ? nscope[depth] : len;
        from[k] = (nfrom[depth] >= 0 && nfrom[depth] < scope[k]) ? nfrom[depth] : -1;
      }
      for (i32 k = 0; k < sels.n; k++) {
        if (from[k] < 0) continue;
        i32 pos = sels.p[k];
        i32 item0 = v_item.n / 10;
        g_item_count = 0;
        split_top(V, pos + 6, from[k], emit_item, 0);
        i32 items = g_item_count;
        i32 aj0 = v_aj.n / 2;
        i32 ajs = array_join_aliases(pos, scope[k], D[pos]);
        vpush(&v_sel, pos);
        vpush(&v_sel, D[pos]);
        vpush(&v_sel, scope[k]);
        vpush(&v_sel, from[k]);
        vpush(&v_sel, item0);
        vpush(&v_sel, items);
        vpush(&v_sel, aj0);
        vpush(&v_sel, ajs);
      }
    }
  }

  /* ---- function calls (collectFunctionDiagnostics) */
  if (flags & 4) {
    u16 *nb = NEW(u16, len + 2);
    u16 *nb2 = NEW(u16, len + 2);
    u16 *tmp = NEW(u16, len + 2);
    if (!nb || !nb2 || !tmp) return -1;
    i32 p = 0;
    while (p < len) {
      u32 c = M[p];
      if (!(is_idstart(c) || c == '`' || c == '"')) {
        p++;
        continue;
      }
      i32 e = read_qualified(M, p, len);
      if (e >= 0) {
        i32 q = skip_ws(M, e, len);
        if (q < len && M[q] == '(') {
          i32 mend = q + 1;
          /* raw: the text of the match without the final whitespace and "(" */
          i32 raw_end = q;
          while (raw_end > p && is_space(V[raw_end - 1])) raw_end--;
          i32 simple = 1;
          for (i32 i = p; i < mend; i++)
            if (V[i] >= 128 || V[i] != M[i]) {
              simple = 0;
              break;
            }
          if (!simple) {
            vpush(&v_fn, p);
            vpush(&v_fn, raw_end);
            vpush(&v_fn, 2);
          } else {
            i32 nl = normalize_qualified(V, p, raw_end, nb);
            i32 known = 0;
            if (nl == 0 || starts_with_digit(nb, nl)) known = 1;
            else if (lower_has(&sets[SET_KW], nb, nl, tmp)) known = 1;
            else if (in_list(nb, 0, nl, ALIAS_STOP)) known = 1;
            else {
              i32 pa, pb;
              prev_word(p, &pa, &pb);
              if (pb > pa && (in_list(M, pa, pb, RELATION_STARTERS) || (pb - pa == 2 && ci_at(M, pa, pb, "as")))) known = 1;
              else if (lower_has(&sets[SET_TFUNC], nb, nl, tmp)) known = 1;
              else {
                i32 nl2 = normalize_qualified(nb, 0, nl, nb2);
                if (nl2 > 0 && (lower_has(&sets[SET_FUNC], nb2, nl2, tmp) || lower_has(&sets[SET_DTYPE], nb2, nl2, tmp))) known = 1;
              }
            }
            if (!known) {
              vpush(&v_fn, p);
              vpush(&v_fn, raw_end);
              vpush(&v_fn, 1);
            }
          }
          p = mend;
          continue;
        }
      }
      if (is_idstart(c)) {
        p++;
        while (p < len && is_idch(M[p])) p++;
      } else p++;
    }
  }
  if (oom) return -1;
  return 0;
}
