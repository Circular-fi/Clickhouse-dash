/* layered.c: the layered (Sugiyama-style) layout of src/static/app_graph_kit.js (layered()) as a kernel: the columns,
 * the order of the cards in them and the global row grid. It gives the order and the rows; the page builds the positions
 * from the sizes, as the JavaScript does.
 *
 * The same steps in the same order: back edges of a depth-first search, longest-path levels, barycentre sweeps, adjacent
 * transpositions, then the minimum-cost monotone row assignment. The comparators of the page (localeCompare on names) stay
 * in JavaScript: the page sends, for every card, the rank it gets under them (equal ranks for cards that compare equal).
 */
#include "rt.h"

#define RT_NEEDS_JS (-2)
#define RT_NO_MEMORY (-1)

static i32 failed;
static void *take(usize bytes) {
  void *p = wasm_alloc(bytes);
  if (!p) failed = RT_NO_MEMORY;
  return p;
}
#define TAKE(type, n) ((type *)take(sizeof(type) * (usize)((n) > 0 ? (n) : 1)))

static f64 jround(f64 x) {
  f64 r = __builtin_floor(x);
  return (x - r >= 0.5) ? r + 1.0 : r;
}

static i32 N, E;
static const i32 *EF, *ET;      /* edge ends: card index, -1 for a card that is not there */
static const i32 *RANK;         /* rank under compare() */
static const i32 *QRANK;        /* rank under queueCompare() */
static const f64 *WEIGHT;

/* adjacency lists of ints: list i is items[start[i], start[i + 1]) */
typedef struct { i32 *start, *items; } Lists;

/* Lists from (owner, value) pairs given in order. */
static Lists build_lists(i32 n, i32 count, const i32 *owner, const i32 *value) {
  Lists l;
  l.start = TAKE(i32, n + 1);
  l.items = TAKE(i32, count);
  i32 *fill = TAKE(i32, n);
  if (failed) return l;
  for (i32 i = 0; i <= n; i++) l.start[i] = 0;
  for (i32 k = 0; k < count; k++) l.start[owner[k] + 1]++;
  for (i32 i = 0; i < n; i++) l.start[i + 1] += l.start[i];
  for (i32 i = 0; i < n; i++) fill[i] = l.start[i];
  for (i32 k = 0; k < count; k++) l.items[fill[owner[k]]++] = value[k];
  return l;
}

/* ---- the back edges of a depth-first search (cycleBackEdges) */

static void back_edges(u8 *back) {
  i32 *out_count = TAKE(i32, N + 1);
  u8 *has_in = TAKE(u8, N);
  u8 *state = TAKE(u8, N);
  if (failed) return;
  for (i32 i = 0; i <= N; i++) out_count[i] = 0;
  for (i32 i = 0; i < N; i++) { has_in[i] = 0; state[i] = 0; }
  i32 *own = TAKE(i32, E), *tgt = TAKE(i32, E), *eid = TAKE(i32, E);
  if (failed) return;
  i32 m = 0;
  for (i32 e = 0; e < E; e++) {
    i32 s = EF[e], t = ET[e];
    if (s < 0 || t < 0 || s == t) continue;
    own[m] = s; tgt[m] = t; eid[m] = e; m++;
    has_in[t] = 1;
  }
  Lists out = build_lists(N, m, own, tgt);
  Lists ids = build_lists(N, m, own, eid);
  i32 *stack_v = TAKE(i32, N + 1), *stack_at = TAKE(i32, N + 1);
  if (failed) return;
  for (i32 pass = 0; pass < 2; pass++) {
    for (i32 root = 0; root < N; root++) {
      if (state[root]) continue;
      if (pass == 0 && has_in[root]) continue;
      i32 top = 0;
      stack_v[0] = root; stack_at[0] = 0;
      state[root] = 1;
      top = 1;
      while (top) {
        i32 v = stack_v[top - 1];
        i32 at = stack_at[top - 1];
        if (at < out.start[v + 1] - out.start[v]) {
          stack_at[top - 1] += 1;
          i32 t = out.items[out.start[v] + at];
          i32 id = ids.items[ids.start[v] + at];
          if (state[t] == 1) { back[id] = 1; continue; }
          if (state[t] == 0) { state[t] = 1; stack_v[top] = t; stack_at[top] = 0; top++; }
        } else {
          state[v] = 2;
          top--;
        }
      }
    }
  }
}

/* ---- stable sort of indexes by (key, then position) */
static const i32 *sort_key;
static void sort_by_key(i32 *a, i32 n) {
  /* a is already in input order: a stable merge sort on the key */
  if (n < 2) return;
  i32 *tmp = TAKE(i32, n);
  if (failed) return;
  for (i32 width = 1; width < n; width *= 2) {
    for (i32 lo = 0; lo < n; lo += 2 * width) {
      i32 mid = lo + width < n ? lo + width : n;
      i32 hi = lo + 2 * width < n ? lo + 2 * width : n;
      i32 i = lo, j = mid, k = lo;
      while (i < mid && j < hi) tmp[k++] = sort_key[a[j]] < sort_key[a[i]] ? a[j++] : a[i++];
      while (i < mid) tmp[k++] = a[i++];
      while (j < hi) tmp[k++] = a[j++];
    }
    for (i32 k = 0; k < n; k++) a[k] = tmp[k];
  }
}

/* ---- the columns */

static i32 *level;       /* per card */
static i32 *colpos;      /* per card: its index in its column */
static i32 n_levels;
static i32 *level_ids;   /* the distinct levels, ascending */
static i32 *col_start;   /* column c holds col_items[col_start[c], col_start[c + 1]) */
static i32 *col_items;
static i32 *col_of;      /* per card: index of its level among the levels */

typedef struct { f64 bary; i32 has; i32 index; i32 node; } Deco;

static i32 deco_less(const Deco *a, const Deco *b) {
  if (a->has && b->has && a->bary != b->bary) return a->bary < b->bary;
  if (a->has && !b->has) return 1;
  if (!a->has && b->has) return 0;
  if (RANK[a->node] != RANK[b->node]) return RANK[a->node] < RANK[b->node];
  return a->index < b->index;
}

static void sort_deco(Deco *d, i32 n) {
  if (n < 2) return;
  Deco *tmp = TAKE(Deco, n);
  if (failed) return;
  for (i32 width = 1; width < n; width *= 2) {
    for (i32 lo = 0; lo < n; lo += 2 * width) {
      i32 mid = lo + width < n ? lo + width : n;
      i32 hi = lo + 2 * width < n ? lo + 2 * width : n;
      i32 i = lo, j = mid, k = lo;
      while (i < mid && j < hi) tmp[k++] = deco_less(&d[j], &d[i]) ? d[j++] : d[i++];
      while (i < mid) tmp[k++] = d[i++];
      while (j < hi) tmp[k++] = d[j++];
    }
    for (i32 k = 0; k < n; k++) d[k] = tmp[k];
  }
}

static void refresh_positions(i32 c) {
  for (i32 i = col_start[c]; i < col_start[c + 1]; i++) colpos[col_items[i]] = i - col_start[c];
}

/* barySort(group, neighbors, order of the adjacent column). */
static void bary_sort(i32 c, const Lists *nb, i32 adj) {
  i32 n = col_start[c + 1] - col_start[c];
  Deco *d = TAKE(Deco, n);
  if (failed) return;
  for (i32 k = 0; k < n; k++) {
    i32 node = col_items[col_start[c] + k];
    f64 sum = 0.0;
    i32 count = 0;
    for (i32 q = nb->start[node]; q < nb->start[node + 1]; q++) {
      i32 other = nb->items[q];
      if (col_of[other] != adj) continue;
      sum += (f64)colpos[other];
      count++;
    }
    d[k].node = node;
    d[k].index = k;
    d[k].has = count > 0;
    d[k].bary = count ? sum / (f64)count : 0.0;
  }
  sort_deco(d, n);
  for (i32 k = 0; k < n; k++) col_items[col_start[c] + k] = d[k].node;
  refresh_positions(c);
}

/* ---- the row grid */

static f64 *lrows;       /* per card: its row (as a number: the ideals are fractional) */
static i32 row_count;

typedef struct { Lists inc; } Incident;

static f64 weighted_ideal(i32 node, const Lists *inc_edge) {
  f64 weighted = 0.0, total = 0.0;
  for (i32 q = inc_edge->start[node]; q < inc_edge->start[node + 1]; q++) {
    i32 e = inc_edge->items[q];
    i32 other = EF[e] == node ? ET[e] : EF[e];
    if (other < 0) continue;
    f64 w = WEIGHT[e];
    weighted += lrows[other] * w;
    total += w;
  }
  return total > 0.0 ? weighted / total : lrows[node];
}

static void assign_rows(i32 c, const Lists *inc_edge) {
  i32 n = col_start[c + 1] - col_start[c];
  if (!n) return;
  i32 slots = row_count > n ? row_count : n;
  f64 *ideals = TAKE(f64, n);
  if (failed) return;
  for (i32 i = 0; i < n; i++) ideals[i] = weighted_ideal(col_items[col_start[c] + i], inc_edge);
  const f64 inf = 1e18;
  f64 *dp = TAKE(f64, (usize)n * (usize)slots);
  i32 *prev = TAKE(i32, (usize)n * (usize)slots);
  i32 *assigned = TAKE(i32, n);
  if (failed) return;
  for (usize i = 0; i < (usize)n * (usize)slots; i++) { dp[i] = inf; prev[i] = -1; }
  for (i32 row = 0; row < slots; row++) {
    if (slots - row < n) break;
    f64 d = (f64)row - ideals[0];
    dp[row] = d * d;
  }
  for (i32 i = 1; i < n; i++) {
    f64 best_cost = inf;
    i32 best_prev = -1;
    f64 *cur = dp + (usize)i * (usize)slots;
    f64 *old = dp + (usize)(i - 1) * (usize)slots;
    for (i32 row = i; row < slots; row++) {
      i32 pr = row - 1;
      if (old[pr] < best_cost) { best_cost = old[pr]; best_prev = pr; }
      if (slots - row < n - i) continue;
      if (best_prev < 0) continue;
      f64 d = (f64)row - ideals[i];
      cur[row] = best_cost + d * d;
      prev[(usize)i * (usize)slots + (usize)row] = best_prev;
    }
  }
  i32 end_row = 0;
  f64 end_cost = inf;
  f64 *last = dp + (usize)(n - 1) * (usize)slots;
  for (i32 row = n - 1; row < slots; row++) {
    if (last[row] < end_cost) { end_cost = last[row]; end_row = row; }
  }
  i32 row = end_row;
  for (i32 i = n - 1; i >= 0; i--) {
    assigned[i] = row;
    row = i > 0 ? prev[(usize)i * (usize)slots + (usize)row] : -1;
  }
  for (i32 i = 0; i < n; i++) lrows[col_items[col_start[c] + i]] = (f64)assigned[i];
}

/* ---- the entry */

static i32 *out_level, *out_order, *out_row;
static u8 *out_back;
EXPORT(ly_level_ptr) i32 ly_level_ptr(void) { return (i32)(usize)out_level; }
EXPORT(ly_order_ptr) i32 ly_order_ptr(void) { return (i32)(usize)out_order; }
EXPORT(ly_row_ptr) i32 ly_row_ptr(void) { return (i32)(usize)out_row; }
EXPORT(ly_back_ptr) i32 ly_back_ptr(void) { return (i32)(usize)out_back; }

/* n cards, ne edges (ends as card indexes, -1 when the card is not in the list); rank / queue rank per card; weight per edge;
   flags: 1 rowGrid, 2 breakCycles. Returns 0, or RT_NEEDS_JS / RT_NO_MEMORY. */
EXPORT(ly_run) i32 ly_run(i32 n, i32 ne, const i32 *edge_from, const i32 *edge_to, const i32 *rank, const i32 *queue_rank, const f64 *weight, i32 flags) {
  N = n; E = ne; EF = edge_from; ET = edge_to; RANK = rank; QRANK = queue_rank; WEIGHT = weight;
  failed = 0;
  out_level = TAKE(i32, n);
  out_order = TAKE(i32, n);
  out_row = TAKE(i32, n);
  out_back = TAKE(u8, ne);
  if (failed) return failed;
  for (i32 e = 0; e < ne; e++) out_back[e] = 0;
  if (flags & 2) back_edges(out_back);
  if (failed) return failed;

  /* the edges kept */
  i32 *kf = TAKE(i32, ne), *kt = TAKE(i32, ne), *kid = TAKE(i32, ne);
  if (failed) return failed;
  i32 kept = 0;
  for (i32 e = 0; e < ne; e++) {
    if (out_back[e]) continue;
    kf[kept] = edge_from[e]; kt[kept] = edge_to[e]; kid[kept] = e; kept++;
  }
  /* re-index every use of the edges to the kept list */
  EF = kf; ET = kt;
  E = kept;
  f64 *kw = TAKE(f64, kept);
  if (failed) return failed;
  for (i32 k = 0; k < kept; k++) kw[k] = weight[kid[k]];
  WEIGHT = kw;

  i32 *indeg = TAKE(i32, n);
  i32 *nown = TAKE(i32, kept), *nval = TAKE(i32, kept);
  if (failed) return failed;
  for (i32 i = 0; i < n; i++) indeg[i] = 0;
  i32 nn = 0;
  for (i32 k = 0; k < kept; k++) {
    if (kf[k] < 0 || kt[k] < 0 || kf[k] == kt[k]) continue;
    indeg[kt[k]]++;
    nown[nn] = kf[k]; nval[nn] = kt[k]; nn++;
  }
  Lists next = build_lists(n, nn, nown, nval);
  if (failed) return failed;
  i32 *queue = TAKE(i32, n);
  u8 *processed = TAKE(u8, n);
  level = out_level;
  if (failed) return failed;
  i32 qn = 0;
  for (i32 i = 0; i < n; i++) { level[i] = 0; processed[i] = 0; if (indeg[i] == 0) queue[qn++] = i; }
  sort_key = QRANK;
  sort_by_key(queue, qn);
  for (i32 qi = 0; qi < qn; qi++) {
    i32 id = queue[qi];
    processed[id] = 1;
    i32 base = level[id];
    for (i32 q = next.start[id]; q < next.start[id + 1]; q++) {
      i32 t = next.items[q];
      if (base + 1 > level[t]) level[t] = base + 1;
      indeg[t]--;
      if (indeg[t] == 0) queue[qn++] = t;
    }
  }
  /* the nodes of a cycle: after their strongest known predecessor */
  {
    i32 *iown = TAKE(i32, kept), *ival = TAKE(i32, kept);
    if (failed) return failed;
    i32 ni = 0;
    for (i32 k = 0; k < kept; k++) {
      if (kt[k] < 0) continue;
      iown[ni] = kt[k]; ival[ni] = kf[k]; ni++;
    }
    Lists in_edges = build_lists(n, ni, iown, ival);
    if (failed) return failed;
    for (i32 i = 0; i < n; i++) {
      if (processed[i]) continue;
      i32 best = 0;
      for (i32 q = in_edges.start[i]; q < in_edges.start[i + 1]; q++) {
        i32 from = in_edges.items[q];
        i32 lv = from >= 0 ? level[from] : 0;
        if (lv + 1 > best) best = lv + 1;
      }
      level[i] = best;
    }
  }

  /* the columns: the levels ascending, the cards of a level by compare() */
  i32 max_level = 0;
  for (i32 i = 0; i < n; i++) if (level[i] > max_level) max_level = level[i];
  i32 *level_count = TAKE(i32, max_level + 2);
  if (failed) return failed;
  for (i32 i = 0; i <= max_level + 1; i++) level_count[i] = 0;
  for (i32 i = 0; i < n; i++) level_count[level[i] + 1]++;
  n_levels = 0;
  for (i32 l = 0; l <= max_level; l++) if (level_count[l + 1]) n_levels++;
  level_ids = TAKE(i32, n_levels);
  col_start = TAKE(i32, n_levels + 1);
  col_items = TAKE(i32, n);
  col_of = TAKE(i32, n);
  colpos = TAKE(i32, n);
  i32 *level_col = TAKE(i32, max_level + 1);
  if (failed) return failed;
  {
    i32 c = 0;
    col_start[0] = 0;
    for (i32 l = 0; l <= max_level; l++) {
      if (!level_count[l + 1]) { level_col[l] = -1; continue; }
      level_ids[c] = l;
      level_col[l] = c;
      col_start[c + 1] = col_start[c] + level_count[l + 1];
      c++;
    }
    i32 *fill = TAKE(i32, n_levels);
    if (failed) return failed;
    for (i32 c2 = 0; c2 < n_levels; c2++) fill[c2] = col_start[c2];
    for (i32 i = 0; i < n; i++) { i32 cc = level_col[level[i]]; col_items[fill[cc]++] = i; col_of[i] = cc; }
  }
  sort_key = RANK;
  for (i32 c = 0; c < n_levels; c++) {
    sort_by_key(col_items + col_start[c], col_start[c + 1] - col_start[c]);
    if (failed) return failed;
    refresh_positions(c);
  }

  /* predecessors / successors (edges whose two cards exist, self loops included) */
  i32 *pown = TAKE(i32, kept), *pval = TAKE(i32, kept), *sown = TAKE(i32, kept), *sval = TAKE(i32, kept);
  if (failed) return failed;
  i32 np = 0;
  for (i32 k = 0; k < kept; k++) {
    if (kf[k] < 0 || kt[k] < 0) continue;
    pown[np] = kt[k]; pval[np] = kf[k];
    sown[np] = kf[k]; sval[np] = kt[k];
    np++;
  }
  Lists preds = build_lists(n, np, pown, pval);
  Lists succs = build_lists(n, np, sown, sval);
  if (failed) return failed;
  for (i32 sweep = 0; sweep < 4; sweep++) {
    for (i32 c = 1; c < n_levels; c++) bary_sort(c, &preds, c - 1);
    for (i32 c = n_levels - 2; c >= 0; c--) bary_sort(c, &succs, c + 1);
    if (failed) return failed;
  }

  /* adjacent transpositions */
  {
    i32 *wown = TAKE(i32, kept * 2), *wval = TAKE(i32, kept * 2);
    if (failed) return failed;
    i32 nw = 0;
    for (i32 k = 0; k < kept; k++) {
      if (kf[k] < 0 || kt[k] < 0) continue;
      i32 fl = level[kf[k]], tl = level[kt[k]];
      i32 d = fl > tl ? fl - tl : tl - fl;
      if (d != 1) continue;
      wown[nw] = kf[k]; wval[nw] = kt[k]; nw++;
      wown[nw] = kt[k]; wval[nw] = kf[k]; nw++;
    }
    Lists nbrs = build_lists(n, nw, wown, wval);
    if (failed) return failed;
    for (i32 pass = 0; pass < 4; pass++) {
      i32 improved = 0;
      for (i32 c = 0; c < n_levels; c++) {
        i32 *group = col_items + col_start[c];
        i32 size = col_start[c + 1] - col_start[c];
        for (i32 i = 0; i + 1 < size; i++) {
          i32 l = group[i], r = group[i + 1];
          i32 delta = 0;
          for (i32 a = nbrs.start[l]; a < nbrs.start[l + 1]; a++) {
            i32 na = nbrs.items[a];
            for (i32 b = nbrs.start[r]; b < nbrs.start[r + 1]; b++) {
              i32 nb = nbrs.items[b];
              if (level[na] != level[nb]) continue;
              if (colpos[na] < colpos[nb]) delta += 1;
              else if (colpos[na] > colpos[nb]) delta -= 1;
            }
          }
          if (delta < 0) {
            improved = 1;
            group[i] = r; group[i + 1] = l;
            colpos[r] = i;
            colpos[l] = i + 1;
          }
        }
      }
      if (!improved) break;
    }
  }

  /* the row grid */
  for (i32 i = 0; i < n; i++) out_row[i] = -1;
  if ((flags & 1) && n_levels) {
    lrows = TAKE(f64, n);
    i32 *inc_own = TAKE(i32, kept * 2), *inc_val = TAKE(i32, kept * 2);
    if (failed) return failed;
    i32 ni = 0;
    for (i32 k = 0; k < kept; k++) {
      if (kf[k] >= 0) { inc_own[ni] = kf[k]; inc_val[ni] = k; ni++; }
      if (kt[k] >= 0 && kt[k] != kf[k]) { inc_own[ni] = kt[k]; inc_val[ni] = k; ni++; }
    }
    Lists inc_edge = build_lists(n, ni, inc_own, inc_val);
    if (failed) return failed;
    i32 max_col = 1;
    for (i32 c = 0; c < n_levels; c++) { i32 s = col_start[c + 1] - col_start[c]; if (s > max_col) max_col = s; }
    row_count = max_col + (max_col >= 3 ? 1 : 0);
    if (row_count < 1) row_count = 1;
    for (i32 c = 0; c < n_levels; c++) {
      i32 size = col_start[c + 1] - col_start[c];
      for (i32 k = 0; k < size; k++) {
        i32 node = col_items[col_start[c] + k];
        f64 row;
        if (size == 1) row = __builtin_floor((f64)(row_count - 1) / 2.0);
        else row = jround((f64)k * (f64)(row_count - 1) / (f64)(size - 1 > 1 ? size - 1 : 1));
        lrows[node] = row;
      }
    }
    for (i32 sweep = 0; sweep < 6; sweep++) {
      for (i32 c = 0; c < n_levels; c++) { assign_rows(c, &inc_edge); if (failed) return failed; }
      for (i32 c = n_levels - 1; c >= 0; c--) { assign_rows(c, &inc_edge); if (failed) return failed; }
    }
    for (i32 i = 0; i < n; i++) out_row[i] = (i32)lrows[i];
  }
  for (i32 c = 0; c < n_levels; c++) for (i32 k = 0; k < col_start[c + 1] - col_start[c]; k++) out_order[col_items[col_start[c] + k]] = k;
  return failed;
}
