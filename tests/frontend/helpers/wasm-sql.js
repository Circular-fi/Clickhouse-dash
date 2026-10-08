import { rng } from './wasm.js';

// Generators and metadata for the editor diagnostics equivalence specs (wasm-sql.spec.js, docs/wasm.md).

const TABLES = [
  { database: 'shop', name: 'orders', columns: ['id', 'user_id', 'amount', 'ts', 'tags', 'items', 'items.price', 'items.qty', 'note'] },
  { database: 'shop', name: 'users', columns: ['id', 'name', 'email', 'created', 'meta'] },
  { database: 'logs', name: 'events', columns: ['ts', 'level', 'message', 'attrs', 'trace_id', 'quoted col'] },
  { database: 'logs', name: 'orders', columns: ['id', 'ref', 'ts'] },
  { database: 'default', name: 'numbers_t', columns: ['n', 'm'] },
  { database: 'anon', name: 'entity_metrics', columns: ['entity_key', 'metric_value', 'metric_name', 'ts', 'temperature_band'] },
];
const FUNCTIONS = ['count', 'sum', 'avg', 'min', 'max', 'uniq', 'now', 'today', 'toDate', 'toString', 'toStartOfHour', 'arrayMap', 'arrayFilter', 'arrayJoin',
  'if', 'multiIf', 'length', 'lower', 'upper', 'concat', 'substring', 'round', 'quantile', 'sumIf', 'countIf', 'groupArray', 'has', 'JSONExtractString'];
const KEYWORDS = ['select', 'from', 'where', 'prewhere', 'group', 'by', 'order', 'limit', 'having', 'join', 'on', 'as', 'and', 'or', 'not', 'in', 'is', 'null',
  'distinct', 'union', 'all', 'with', 'array', 'left', 'inner', 'format', 'settings', 'case', 'when', 'then', 'else', 'end', 'interval', 'day', 'true', 'false'];
const TABLE_FUNCTIONS = ['numbers', 'url', 'file', 's3', 'remote'];
const DATA_TYPES = ['UInt64', 'String', 'DateTime', 'Nullable', 'Array', 'LowCardinality', 'Decimal', 'Float64'];

// The metadata a page holds for the host: variants cover a page before its catalog arrives and a partial one.
export function metaSpec(variant) {
  return { variant, tables: TABLES, functions: FUNCTIONS, keywords: KEYWORDS, tableFunctions: TABLE_FUNCTIONS, dataTypes: DATA_TYPES };
}

// Names (and columns) of the repository's SQL files, so the corpus finds its tables: every table after FROM / JOIN, with
// a few of the identifiers of the corpus as columns.
export function corpusMeta(corpus) {
  const tables = new Map();
  const idents = new Set();
  for (const sql of corpus) {
    for (const m of sql.matchAll(/\b(?:FROM|JOIN)\s+(?:`?(\w+)`?\.)?`?(\w+)`?/gi)) {
      if (!m[2] || /^(select|numbers|values)$/i.test(m[2])) continue;
      tables.set(`${m[1] || ''}.${m[2]}`, { database: m[1] || 'default', name: m[2] });
    }
    for (const m of sql.matchAll(/\b[A-Za-z_]\w{2,}\b/g)) idents.add(m[0]);
  }
  const all = [...idents].sort();
  const r = rng(99);
  const out = [];
  for (const table of tables.values()) {
    const columns = [];
    for (let i = 0; i < 14; i += 1) columns.push(all[r.int(all.length)]);
    out.push({ ...table, columns: [...new Set(columns)] });
  }
  return { ...metaSpec('corpus'), tables: [...TABLES, ...out] };
}

const COLS = ['id', 'user_id', 'amount', 'ts', 'tags', 'items', 'name', 'email', 'level', 'message', 'attrs', 'n', 'm', 'unknown_col', 'x1', 'cnt', '`quoted col`', '"id"', 'tags.k', 'items.price'];
const ALIASES = ['a', 'b', 'total', 'cnt', '`my alias`', '"dq alias"', "'sq alias'", 'x', 'AS_', 'sum_'];
const EXPRS = ['{c}', '{c}', '{c}', 't.{c}', 'u.{c}', 'count()', 'sum({c})', 'sum({c}) AS s', '{c} + {c}', '{c} * 2 {a}', 'if({c} > 0, {c}, 0) {a}', 'toDate({c}) AS d',
  'arrayMap(x -> x + {c}, tags)', 'arrayMap((x, y) -> x + y + {c}, tags, tags)', 'arrayFilter(x -> x > 1 AND x < {c}, items)', "'string {c}'", '1e6', '1.5e-3', '0x1F',
  '"{c}"', '`{c}`', '{c} AS {a2}', '{c} {a2}', '{c} AS `{a2}`', 'CASE WHEN {c} THEN {c} ELSE 0 END AS r', '(SELECT max({c}) FROM shop.users) AS m',
  'unknownFn({c})', 'UNKNOWNFN({c})', 'db.fn({c})', 'CAST({c} AS Nullable(UInt64))', 'CAST({c}, \'Array(String)\')', '{c} -- note\n', '/* c */ {c}', '*', 't.*',
  '{c} AS', '{c} AS `unfinished', "{c} AS 'unfinished", 'x -> ', '{c}.{c}', '{c} . {c}', '`a.b`', 'f(a)(b)'];
const SOURCES = ['shop.orders', 'shop.orders AS t', 'shop.orders t', 'shop.users u', 'logs.events', 'logs.orders', 'orders', 'users', 'events', 'numbers(10)', 'numbers(5) AS n',
  'unknown_db.t', 'shop.nothing', 'a.b.c', '`shop`.`orders`', 'shop.', 'shop. ', 'anon.entity_metrics', '(SELECT id, name AS nm FROM shop.users) AS sub', '(SELECT * FROM logs.events) e',
  '(SELECT 1 AS one)', 'cte1', 'cte2 AS c', 'url(\'http://x\', CSV)', 'system.tables', 'été.table', '`odd name`'];
const CLAUSES = ['', '', '', ' WHERE {c} > 1', ' WHERE {c} IN (SELECT {c} FROM shop.users)', ' PREWHERE {c} = 1', ' GROUP BY {c}', ' ORDER BY {c} DESC', ' LIMIT 10', ' LIMIT 5 BY {c}',
  ' ARRAY JOIN tags AS tag', ' LEFT ARRAY JOIN items AS it, tags AS tg', ' GLOBAL ARRAY JOIN items i', ' JOIN shop.users u2 ON u2.id = {c}', ' LEFT JOIN logs.events e ON e.ts = {c}',
  ' HAVING count() > 1', ' SETTINGS max_threads = 1', ' FORMAT JSON', ' UNION ALL SELECT 1', ' WINDOW w AS (PARTITION BY {c})'];
const NOISE = ['-- comment from\n', '/* block select */', "'string with ; and FROM x'", '"dq ; from"', '`bt from; (`', '\n', '  ', '\t', ';', ')', '(', "'", '`', '-- unterminated', '/* unterminated',
  ' ', ' ', '😀', '\ud800', '$', 'x$y', '1abc', '.'];

function fill(template, r) {
  return template
    .replace(/\{c\}/g, () => r.pick(COLS))
    .replace(/\{a\}/g, () => (r.next() < 0.5 ? ` ${r.pick(ALIASES)}` : ''))
    .replace(/\{a2\}/g, () => r.pick(ALIASES));
}

// One statement of a realistic script: CTEs and scalars, a projection, sources, clauses, a subquery now and then.
function statement(r, depth = 0) {
  let sql = '';
  if (r.next() < 0.22) {
    const parts = [];
    for (let i = 0, n = 1 + r.int(3); i < n; i += 1) {
      const roll = r.next();
      if (roll < 0.5) parts.push(`cte${1 + r.int(2)} AS (${statement(r, depth + 1)})`);
      else if (roll < 0.7) parts.push(`(${statement(r, depth + 1)}) AS cte${1 + r.int(2)}`);
      else parts.push(`${r.int(100)} AS k${r.int(3)}`);
    }
    sql += `WITH ${parts.join(', ')}\n`;
  }
  const items = [];
  for (let i = 0, n = 1 + r.int(6); i < n; i += 1) items.push(fill(r.pick(EXPRS), r));
  sql += `SELECT${r.next() < 0.1 ? ' DISTINCT' : ''} ${items.join(r.next() < 0.1 ? ',\n  ' : ', ')}`;
  if (r.next() < 0.93) {
    sql += `\nFROM ${r.pick(SOURCES)}`;
    if (depth < 2 && r.next() < 0.15) sql += ` JOIN (${statement(r, depth + 1)}) AS j ON 1`;
  }
  for (let i = 0, n = r.int(3); i < n; i += 1) sql += fill(r.pick(CLAUSES), r);
  if (depth === 0 && r.next() < 0.12) sql += `\n${r.pick(NOISE)}`;
  return sql;
}

// `count` scripts: realistic statements joined by ";", some mutated (characters dropped or inserted).
export function fuzzScripts(seed, count, statements = 4, mutate = 0.35) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const parts = [];
    for (let k = 0, n = 1 + r.int(statements); k < n; k += 1) parts.push(statement(r));
    let text = parts.join(r.next() < 0.8 ? ';\n' : '; ');
    if (r.next() < mutate) {
      const chars = text.split('');
      for (let m = 0, n = 1 + r.int(4); m < n; m += 1) {
        const at = r.int(chars.length);
        if (r.next() < 0.5) chars.splice(at, 1 + r.int(3));
        else chars.splice(at, 0, r.pick(NOISE));
      }
      text = chars.join('');
    }
    out.push(text);
  }
  return out;
}
