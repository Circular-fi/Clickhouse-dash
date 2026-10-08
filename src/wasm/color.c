/* color.c: the colour arithmetic of the front end, in batches (docs/wasm.md).
 *
 * The page resolves colours with the browser (CSS tokens, getComputedStyle, canvas) and keeps that part. Here is what it then does
 * with the numbers: parse a resolved colour text, normalise it (app_palette.js normalize), mix two colours (app_graph_kit.js
 * mixColor), choose the readable label colour (app_palette.js luminance, contrast, readableText), format rgba() strings (the chart
 * engine), and the slot arithmetic of the palette (FNV-1a hash slot of a name, sequential steps, categorical slots).
 *
 * Every string is UTF-16 (the code units of the JavaScript string) in one buffer with an offset table. Every item has a status:
 * 0 done; 1 the JavaScript function would return its input unchanged (no match); 2 the kernel does not decide (a number it cannot
 * convert exactly, or a rounding it cannot call): the page runs the JavaScript function for that item. The Math functions of the
 * host are imported, so the numbers are the ones of the reference.
 */
#include "rt.h"

static i32 is_space(u32 c) {
  if (c == 32 || (c >= 9 && c <= 13)) return 1;
  if (c < 160) return 0;
  return c == 160 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}
static i32 is_digit(u32 c) { return c >= '0' && c <= '9'; }

/* ------------------------------------------------------------------ numbers */

static const f64 POW10[23] = { 1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22 };

/* The token [0-9.]+ of s[a, b) as the number of Number(token): exact for a plain decimal of at most 15 digits (digits / 10^k is the
   correctly rounded value). Returns 1 on success, 0 when JavaScript must convert it. */
static i32 plain_number(const u16 *s, i32 a, i32 b, f64 *out) {
  i32 digits = 0, dots = 0, frac = 0;
  u64 value = 0;
  for (i32 i = a; i < b; i++) {
    u32 c = s[i];
    if (c == '.') {
      if (++dots > 1) return 0;
    } else if (is_digit(c)) {
      if (++digits > 15) return 0;
      value = value * 10u + (c - '0');
      if (dots) frac++;
    } else return 0;
  }
  if (!digits) return 0;
  *out = (f64)value / POW10[frac];
  return 1;
}

/* Math.round */
static f64 js_round(f64 x) {
  if (x != x || x == __builtin_inf() || x == -__builtin_inf()) return x;
  f64 f = __builtin_floor(x);
  return x - f >= 0.5 ? f + 1.0 : f;
}

static f64 clamp01(f64 a) { return a < 0 ? 0 : a > 1 ? 1 : a; }

/* ------------------------------------------------------------------ output strings */

static u16 *obuf;
static i32 olen, ocap;
static i32 *ooff;
static u8 *ostatus;
static f64 *onum;

static i32 out_reserve(i32 n, i32 chars_per_item, i32 numbers) {
  olen = 0;
  ocap = n * chars_per_item + 16;
  obuf = NEW(u16, ocap);
  ooff = NEW(i32, n + 1);
  ostatus = NEW(u8, n + 1);
  onum = numbers ? NEW(f64, (usize)n * numbers) : 0;
  return obuf && ooff && ostatus && (!numbers || onum) ? 1 : 0;
}

static void put_char(u32 c) { if (olen < ocap) obuf[olen++] = (u16)c; }
static void put_lit(const char *p) { while (*p) put_char((u8)*p++); }
static void put_int(i32 v) {
  if (v < 0) { put_char('-'); v = -v; }
  char tmp[12];
  i32 n = 0;
  do { tmp[n++] = (char)('0' + v % 10); v /= 10; } while (v);
  while (n) put_char((u8)tmp[--n]);
}

/* +x.toFixed(3) as a string; returns 0 when the rounding is too close to call or the number is out of the safe range. */
static i32 put_fixed3(f64 x) {
  if (!(x > -1e6 && x < 1e6)) return 0;
  f64 t = x * 1000.0;
  f64 f = __builtin_floor(t);
  f64 frac = t - f;
  if (frac > 0.5 - 1e-6 && frac < 0.5 + 1e-6) return 0;
  i32 n = (i32)(frac > 0.5 ? f + 1.0 : f);
  if (n < 0) {
    /* -0.0004 gives "-0.000": the number is -0 and prints as 0 */
    if (n == 0) { put_char('0'); return 1; }
    put_char('-');
    n = -n;
  }
  i32 whole = n / 1000, rest = n % 1000;
  put_int(whole);
  if (rest) {
    put_char('.');
    put_char((u32)('0' + rest / 100));
    if (rest % 100) {
      put_char((u32)('0' + rest / 10 % 10));
      if (rest % 10) put_char((u32)('0' + rest % 10));
    }
  }
  return 1;
}

static i32 channel(f64 v) {
  f64 r = js_round(v);
  return (i32)(r < 0 ? 0 : r > 255 ? 255 : r);
}

EXPORT(col_out_text) i32 col_out_text(void) { return (i32)(usize)obuf; }
EXPORT(col_out_offsets) i32 col_out_offsets(void) { return (i32)(usize)ooff; }
EXPORT(col_out_status) i32 col_out_status(void) { return (i32)(usize)ostatus; }
EXPORT(col_out_numbers) i32 col_out_numbers(void) { return (i32)(usize)onum; }

/* ------------------------------------------------------------------ parsing of an rgb text */

typedef struct { f64 r, g, b, a; i32 kind; } Rgba;
/* kind: 1 an rgb() / rgba() text, 2 a color(srgb) text, 3 a #rrggbb text, 0 no match, -1 the kernel does not decide */

static i32 skip_ws(const u16 *s, i32 i, i32 b) { while (i < b && is_space(s[i])) i++; return i; }
static i32 token_end(const u16 *s, i32 i, i32 b, i32 allow_e_minus) {
  while (i < b && (is_digit(s[i]) || s[i] == '.' || (allow_e_minus && (s[i] == 'e' || s[i] == '-')))) i++;
  return i;
}

/* A number token at i: its end, or -1 when there is none; sets *hard when JavaScript must convert it. */
static i32 number_at(const u16 *s, i32 i, i32 b, f64 *v, i32 *hard, i32 allow_e_minus) {
  i32 e = token_end(s, i, b, allow_e_minus);
  if (e == i) return -1;
  if (!plain_number(s, i, e, v)) *hard = 1;
  return e;
}

static i32 starts(const u16 *s, i32 i, i32 b, const char *lit) {
  for (; *lit; lit++, i++) if (i >= b || s[i] != (u8)*lit) return 0;
  return 1;
}

/* The three regular expressions of normalize() / parseColor(). strict_alpha: the chart engine's color(srgb) has no "%" and no
   "e" or "-" in its numbers. */
static Rgba parse_rgb_text(const u16 *s, i32 a, i32 b, i32 chart, i32 hex_too) {
  Rgba out = { 0, 0, 0, 1, 0 };
  while (a < b && is_space(s[a])) a++;
  while (b > a && is_space(s[b - 1])) b--;
  i32 hard = 0;
  if (starts(s, a, b, "rgb")) {
    i32 i = a + 3;
    if (i < b && s[i] == 'a') i++;
    if (i < b && s[i] == '(') {
      i = skip_ws(s, i + 1, b);
      f64 v[3];
      i32 ok = 1;
      for (i32 k = 0; k < 3 && ok; k++) {
        i32 e = number_at(s, i, b, &v[k], &hard, 0);
        if (e < 0) { ok = 0; break; }
        i = e;
        if (k < 2) {
          i32 j = i;
          while (j < b && (s[j] == ',' || is_space(s[j]))) j++;
          if (j == i) ok = 0;
          i = j;
        }
      }
      f64 alpha = 1;
      if (ok) {
        i32 j = skip_ws(s, i, b);
        if (j < b && (s[j] == ',' || s[j] == '/')) {
          j = skip_ws(s, j + 1, b);
          f64 av;
          i32 e = number_at(s, j, b, &av, &hard, 0);
          if (e < 0) ok = 0;
          else {
            j = e;
            if (j < b && s[j] == '%') { av = av / 100.0; j++; }
            alpha = av;
            i = j;
          }
        }
      }
      if (ok) {
        i32 j = skip_ws(s, i, b);
        if (j == b - 1 && s[j] == ')') {
          if (hard) { out.kind = -1; return out; }
          out.r = v[0]; out.g = v[1]; out.b = v[2]; out.a = alpha; out.kind = 1;
          return out;
        }
      }
      /* a text of this shape that the grammar above does not take: the regular expression would not take it either */
    }
  }
  if (starts(s, a, b, "color(srgb")) {
    i32 i = a + 10;
    if (i < b && is_space(s[i])) {
      f64 v[3];
      i32 ok = 1;
      for (i32 k = 0; k < 3 && ok; k++) {
        i32 j = skip_ws(s, i, b);
        if (j == i && k < 3) { ok = 0; break; }
        i = j;
        i32 e = number_at(s, i, b, &v[k], &hard, !chart);
        if (e < 0) { ok = 0; break; }
        i = e;
      }
      f64 alpha = 1;
      if (ok) {
        i32 j = skip_ws(s, i, b);
        if (j < b && s[j] == '/') {
          j = skip_ws(s, j + 1, b);
          f64 av;
          i32 e = number_at(s, j, b, &av, &hard, 0);
          if (e < 0) ok = 0;
          else {
            j = e;
            if (!chart && j < b && s[j] == '%') { av = av / 100.0; j++; }
            alpha = av;
            i = j;
          }
        }
      }
      if (ok) {
        i32 j = skip_ws(s, i, b);
        if (j == b - 1 && s[j] == ')') {
          if (hard) { out.kind = -1; return out; }
          out.r = v[0] * 255.0; out.g = v[1] * 255.0; out.b = v[2] * 255.0; out.a = alpha; out.kind = 2;
          return out;
        }
      }
    }
  }
  if (hex_too && b - a == 7 && s[a] == '#') {
    u32 n = 0;
    for (i32 i = a + 1; i < b; i++) {
      u32 c = s[i], d;
      if (c >= '0' && c <= '9') d = c - '0';
      else if (c >= 'a' && c <= 'f') d = c - 'a' + 10;
      else if (c >= 'A' && c <= 'F') d = c - 'A' + 10;
      else return out;
      n = n * 16u + d;
    }
    out.r = (f64)(n >> 16); out.g = (f64)((n >> 8) & 255u); out.b = (f64)(n & 255u); out.a = 1; out.kind = 3;
  }
  return out;
}

/* ------------------------------------------------------------------ normalize (app_palette.js) */

/* texts: n strings (offs has n + 1 entries). For each: the normalised text in the output, or status 1 (unchanged: the page
   returns the trimmed text) or 2. Returns 0, or -1 for no memory. */
EXPORT(col_normalize) i32 col_normalize(const u16 *s, const i32 *offs, i32 n) {
  if (!out_reserve(n, 40, 0)) return -1;
  for (i32 i = 0; i < n; i++) {
    ooff[i] = olen;
    Rgba c = parse_rgb_text(s, offs[i], offs[i + 1], 0, 0);
    if (c.kind < 0) { ostatus[i] = 2; continue; }
    if (c.kind == 0) { ostatus[i] = 1; continue; }
    i32 start = olen;
    f64 alpha = clamp01(c.a);
    /* alpha = +Math.max(0, Math.min(1, a)).toFixed(3) */
    f64 t = alpha * 1000.0;
    f64 f = __builtin_floor(t);
    f64 frac = t - f;
    if (alpha != alpha || (frac > 0.5 - 1e-6 && frac < 0.5 + 1e-6)) { ostatus[i] = 2; continue; }
    i32 an = (i32)(frac > 0.5 ? f + 1.0 : f);
    i32 r = channel(c.r), g = channel(c.g), b = channel(c.b);
    if (c.r != c.r || c.g != c.g || c.b != c.b) { ostatus[i] = 2; continue; }
    if (an >= 1000) {
      put_lit("rgb(");
    } else {
      put_lit("rgba(");
    }
    put_int(r); put_lit(", "); put_int(g); put_lit(", "); put_int(b);
    if (an < 1000) {
      put_lit(", ");
      put_fixed3(alpha);
    }
    put_char(')');
    ostatus[i] = 0;
    (void)start;
  }
  ooff[n] = olen;
  return olen > ocap ? -1 : 0;
}

/* ------------------------------------------------------------------ parse for the chart engine */

/* parseColor of app_chart_core.js: numbers r, g, b, a per item (the grey default when nothing matches). */
EXPORT(col_parse_chart) i32 col_parse_chart(const u16 *s, const i32 *offs, i32 n) {
  if (!out_reserve(n, 0, 4)) return -1;
  for (i32 i = 0; i < n; i++) {
    ooff[i] = 0;
    Rgba c = parse_rgb_text(s, offs[i], offs[i + 1], 1, 1);
    if (c.kind < 0) { ostatus[i] = 2; continue; }
    ostatus[i] = 0;
    if (c.kind == 0) { c.r = 128; c.g = 128; c.b = 128; c.a = 1; }
    onum[i * 4] = c.r; onum[i * 4 + 1] = c.g; onum[i * 4 + 2] = c.b; onum[i * 4 + 3] = c.a;
  }
  return 0;
}

/* rgba(c, alpha) of the chart engine for n colours (r, g, b, a as four numbers) and n alphas. */
EXPORT(col_rgba) i32 col_rgba(const f64 *colors, const f64 *alphas, i32 n) {
  if (!out_reserve(n, 40, 0)) return -1;
  for (i32 i = 0; i < n; i++) {
    ooff[i] = olen;
    const f64 *c = colors + i * 4;
    f64 r = js_round(c[0]), g = js_round(c[1]), b = js_round(c[2]);
    if (!(r > -1e9 && r < 1e9 && g > -1e9 && g < 1e9 && b > -1e9 && b < 1e9)) { ostatus[i] = 2; continue; }
    i32 save = olen;
    put_lit("rgba("); put_int((i32)r); put_lit(", "); put_int((i32)g); put_lit(", "); put_int((i32)b); put_lit(", ");
    if (!put_fixed3(c[3] * alphas[i])) { olen = save; ostatus[i] = 2; continue; }
    put_char(')');
    ostatus[i] = 0;
  }
  ooff[n] = olen;
  return olen > ocap ? -1 : 0;
}

/* ------------------------------------------------------------------ mix (app_graph_kit.js) */

/* mixColor of one pair of colours (x and y: r, g, b, a, parsed by the page) for n weights t. */
EXPORT(col_mix) i32 col_mix(const f64 *x, const f64 *y, const f64 *t, i32 n) {
  if (!out_reserve(n, 24, 0)) return -1;
  for (i32 i = 0; i < n; i++) {
    ooff[i] = olen;
    f64 k = t[i] != t[i] ? 0 : (t[i] < 0 ? 0 : t[i] > 1 ? 1 : t[i]);
    i32 v[3];
    i32 ok = 1;
    for (i32 c = 0; c < 3; c++) {
      f64 r = js_round(x[c] + (y[c] - x[c]) * k);
      if (!(r > -1e9 && r < 1e9)) ok = 0;
      else v[c] = (i32)r;
    }
    if (!ok) { ostatus[i] = 2; continue; }
    put_lit("rgb("); put_int(v[0]); put_lit(", "); put_int(v[1]); put_lit(", "); put_int(v[2]); put_char(')');
    ostatus[i] = 0;
  }
  ooff[n] = olen;
  return olen > ocap ? -1 : 0;
}

/* ------------------------------------------------------------------ luminance, contrast, readable text (app_palette.js) */

/* luminance(token) of a resolved text: NaN when the text is not rgb(...) / rgba(...). The regex has no end anchor and wants
   "," after each of the first two numbers. */
static f64 luminance_of(const u16 *s, i32 a, i32 b, i32 *status) {
  f64 nan = __builtin_nan("");
  while (a < b && is_space(s[a])) a++;
  while (b > a && is_space(s[b - 1])) b--;
  /* resolve() trims and normalises: the text is "rgb(r, g, b)" or "rgba(r, g, b, a)" or something else */
  if (!starts(s, a, b, "rgb")) return nan;
  i32 i = a + 3, hard = 0;
  if (i < b && s[i] == 'a') i++;
  if (i >= b || s[i] != '(') return nan;
  i = skip_ws(s, i + 1, b);
  f64 v[3];
  for (i32 k = 0; k < 3; k++) {
    i32 e = number_at(s, i, b, &v[k], &hard, 0);
    if (e < 0) return nan;
    i = e;
    if (k < 2) {
      if (i >= b || s[i] != ',') return nan;
      i = skip_ws(s, i + 1, b);
    }
  }
  if (hard) { *status = 2; return nan; }
  f64 ch[3];
  for (i32 k = 0; k < 3; k++) {
    f64 c = v[k] / 255.0;
    ch[k] = c <= 0.04045 ? c / 12.92 : js_pow((c + 0.055) / 1.055, 2.4);
  }
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

static f64 contrast_of(f64 la, f64 lb) {
  if (!(la - la == 0) || !(lb - lb == 0)) return __builtin_nan("");
  f64 hi = la > lb ? la : lb, lo = la < lb ? la : lb;
  return (hi + 0.05) / (lo + 0.05);
}

/* The label colour of each of n - 2 fills: texts 0 .. n - 3 are the resolved fills, the last two the light and the dark label.
   Output: onum[i] = 1 when the dark label reads better, 0 for the light one (also when a contrast is not a number). */
EXPORT(col_readable) i32 col_readable(const u16 *s, const i32 *offs, i32 n) {
  if (n < 2 || !out_reserve(n, 0, 1)) return -1;
  i32 label_status = 0;
  f64 light_l = luminance_of(s, offs[n - 2], offs[n - 1], &label_status);
  f64 dark_l = luminance_of(s, offs[n - 1], offs[n], &label_status);
  for (i32 i = 0; i < n - 2; i++) {
    ooff[i] = 0;
    i32 st = label_status;
    f64 fl = luminance_of(s, offs[i], offs[i + 1], &st);
    if (st) { ostatus[i] = 2; continue; }
    ostatus[i] = 0;
    f64 light = contrast_of(fl, light_l);
    f64 dark = contrast_of(fl, dark_l);
    onum[i] = dark > light ? 1 : 0;
  }
  return 0;
}

/* ------------------------------------------------------------------ slots (app_palette.js) */

/* hashSlot of n names: FNV-1a over the code units, modulo `slots`. The page applies serviceKey() first. Output numbers. */
EXPORT(col_hash_slots) i32 col_hash_slots(const u16 *s, const i32 *offs, i32 n, i32 slots) {
  if (!out_reserve(n, 0, 1)) return -1;
  for (i32 i = 0; i < n; i++) {
    u32 h = 0x811c9dc5u;
    for (i32 k = offs[i]; k < offs[i + 1]; k++) h = (h ^ s[k]) * 0x01000193u;
    ooff[i] = 0;
    ostatus[i] = 0;
    onum[i] = (f64)(h % (u32)slots);
  }
  return 0;
}

/* sequential(t): step 1 + Math.round(clamp(t) * (steps - 1)), t is a number (NaN and the infinities count as 0). */
EXPORT(col_steps) i32 col_steps(const f64 *t, i32 n, i32 steps) {
  if (!out_reserve(n, 0, 1)) return -1;
  for (i32 i = 0; i < n; i++) {
    f64 v = t[i];
    f64 c = !(v - v == 0) ? 0 : (v < 0 ? 0 : v > 1 ? 1 : v);
    ooff[i] = 0;
    ostatus[i] = 0;
    onum[i] = 1.0 + js_round(c * (f64)(steps - 1));
  }
  return 0;
}

/* categorical(i): slot (trunc(i) % slots) + 1, or 0 for the neutral slot (not a finite number, or negative). */
EXPORT(col_categorical) i32 col_categorical(const f64 *v, i32 n, i32 slots) {
  if (!out_reserve(n, 0, 1)) return -1;
  for (i32 i = 0; i < n; i++) {
    f64 x = v[i];
    ooff[i] = 0;
    ostatus[i] = 0;
    if (!(x - x == 0)) { onum[i] = 0; continue; }
    f64 tr = __builtin_trunc(x);
    if (tr < 0) { onum[i] = 0; continue; }
    if (tr > 9007199254740991.0) { ostatus[i] = 2; continue; }
    u64 whole = (u64)tr;
    onum[i] = (f64)(whole % (u64)slots) + 1.0;
  }
  return 0;
}

/* ------------------------------------------------------------------ type families (app_explorer_treemap.js) */

static i32 eq_ci(const u16 *s, i32 a, i32 b, const char *lit) {
  for (; *lit; lit++, a++) {
    if (a >= b) return 0;
    u32 c = s[a];
    if (c >= 'A' && c <= 'Z') c += 32;
    if (c != (u8)*lit) return 0;
  }
  return a == b;
}

/* head is a whole lower-case word: one of the list, or the prefix and digits. */
static i32 head_is(const u16 *s, i32 a, i32 b, const char *const *words) {
  for (; *words; words++) if (eq_ci(s, a, b, *words)) return 1;
  return 0;
}
static i32 head_is_digits_after(const u16 *s, i32 a, i32 b, const char *prefix) {
  i32 i = a;
  for (; *prefix; prefix++, i++) {
    if (i >= b) return 0;
    u32 c = s[i];
    if (c >= 'A' && c <= 'Z') c += 32;
    if (c != (u8)*prefix) return 0;
  }
  for (; i < b; i++) if (!is_digit(s[i])) return 0;
  return 1;
}

/* columnFamily(type) of n type names: the index 0 numbers, 1 dates and times, 2 strings, 3 arrays and maps, 4 other. */
EXPORT(col_type_families) i32 col_type_families(const u16 *s, const i32 *offs, i32 n) {
  static const char *const NUMBER[] = { "bfloat16", "bool", "boolean", 0 };
  static const char *const TIME[] = { "date", "date32", "datetime", "datetime64", "time", "time64", 0 };
  static const char *const TEXT[] = { "string", "fixedstring", "uuid", "ipv4", "ipv6", 0 };
  static const char *const NESTED[] = { "array", "map", "tuple", "nested", "json", "object", "variant", "dynamic", 0 };
  if (!out_reserve(n, 0, 1)) return -1;
  for (i32 i = 0; i < n; i++) {
    ooff[i] = 0;
    ostatus[i] = 0;
    i32 a = offs[i], b = offs[i + 1];
    while (a < b && is_space(s[a])) a++;
    while (b > a && is_space(s[b - 1])) b--;
    /* Nullable(...) and LowCardinality(...) wrap the type that is stored */
    for (;;) {
      i32 k = a;
      i32 len = b - a >= 8 && eq_ci(s, a, a + 8, "nullable") ? 8 : (b - a >= 14 && eq_ci(s, a, a + 14, "lowcardinality") ? 14 : 0);
      if (!len) break;
      k = a + len;
      while (k < b && is_space(s[k])) k++;
      if (!(k < b && s[k] == '(' && s[b - 1] == ')' && k < b - 1)) break;
      a = k + 1;
      b = b - 1;
      while (a < b && is_space(s[a])) a++;
      while (b > a && is_space(s[b - 1])) b--;
    }
    /* the head: cut at the first "(", trim, lower-case (ASCII only: a letter beyond ASCII matches no family) */
    i32 end = a;
    while (end < b && s[end] != '(') end++;
    i32 he = end;
    while (he > a && is_space(s[he - 1])) he--;
    i32 ha = a;
    while (ha < he && is_space(s[ha])) ha++;
    i32 family = 4;
    if (head_is_digits_after(s, ha, he, "int") || head_is_digits_after(s, ha, he, "uint") || head_is_digits_after(s, ha, he, "float") ||
        head_is_digits_after(s, ha, he, "decimal") || head_is(s, ha, he, NUMBER)) family = 0;
    else if (head_is(s, ha, he, TIME)) family = 1;
    else if (head_is_digits_after(s, ha, he, "enum") || head_is(s, ha, he, TEXT)) family = 2;
    else if (head_is(s, ha, he, NESTED)) family = 3;
    onum[i] = (f64)family;
  }
  return 0;
}
