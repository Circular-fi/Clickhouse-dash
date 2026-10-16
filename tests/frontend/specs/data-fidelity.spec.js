import { test, expect } from '@playwright/test';
import { installObservers } from '../helpers/observability.js';
import { openApp, runSuccessfulQuery } from '../helpers/app.js';
import { captureCopies } from '../helpers/clipboard.js';

// The screen, the copies and the downloads show exactly the values that ClickHouse stores (docs/telemetry.md, "Result values").
// The 2.17 page had these faults. It rounded every integer above 2^53 (cityHash64(1) read 10577349846663553000).
// It reparsed a String that looked like JSON. It copied the String '007' as 7. It unescaped 'C:\new' into a line break.
// It showed NaN as NULL. It showed Float32 0.1 as 0.10000000149011612. It swapped the bytes of a UUID.
// It wrote four different JSON / CSV texts for the same result.

const observers = new WeakMap();
test.beforeEach(async ({ page }) => { observers.set(page, installObservers(page)); });
test.afterEach(async ({ page }, testInfo) => {
  const obs = observers.get(page);
  if (!obs) return;
  await obs.flush(testInfo, testInfo.title);
  expect(obs.pageErrors).toEqual([]);
});

const rows = (n) => `SELECT
  cityHash64(1) AS hash,
  toUInt64(18446744073709551615) AS u64max,
  toInt64(-9223372036854775808) AS i64min,
  toDecimal128('12345678901234567890.123456789', 9) AS dec,
  toDecimal64(1.5, 3) AS dec_scale,
  toUUID('00000000-0000-0000-0000-000000000001') AS uuid,
  '007' AS code,
  '{"id": 12345678901234567890, "a": 1.0}' AS json_text,
  '"x"' AS quoted,
  nan AS f_nan,
  inf AS f_inf,
  -inf AS f_ninf,
  toFloat32(0.1) AS f32,
  'C:\\\\new' AS path,
  toIPv4('1.2.3.4') AS ip,
  map('10', 1, '2', 2) AS m,
  CAST(NULL AS Nullable(String)) AS z,
  '\\\\N' AS backslash_n,
  number AS n
FROM numbers(${n})`;

const COLUMNS = ['hash', 'u64max', 'i64min', 'dec', 'dec_scale', 'uuid', 'code', 'json_text', 'quoted', 'f_nan', 'f_inf', 'f_ninf', 'f32', 'path', 'ip', 'm', 'z', 'backslash_n', 'n'];
// Each cell shows the text of its value, as ClickHouse prints it (z is NULL).
const SHOWN = {
  hash: '10577349846663553072',
  u64max: '18446744073709551615',
  i64min: '-9223372036854775808',
  dec: '12345678901234567890.123456789',
  dec_scale: '1.500',
  uuid: '00000000-0000-0000-0000-000000000001',
  code: '007',
  json_text: '{"id": 12345678901234567890, "a": 1.0}',
  quoted: '"x"',
  f_nan: 'nan',
  f_inf: 'inf',
  f_ninf: '-inf',
  f32: '0.1',
  path: 'C:\\new',
  ip: '1.2.3.4',
  m: '{"10":1,"2":2}',
  backslash_n: '\\N',
  n: '0',
};
// This is the first row of Copy JSON and Download JSON, as text.
// The digits of a number type are an exact JSON number. JSON.parse in a test can round them.
// NaN and the infinities stay strings. A Map is an object in its stored order. A String is never reparsed.
const FIRST_ROW_JSON_TEXT = `{
    "hash": 10577349846663553072,
    "u64max": 18446744073709551615,
    "i64min": -9223372036854775808,
    "dec": 12345678901234567890.123456789,
    "dec_scale": 1.500,
    "uuid": "00000000-0000-0000-0000-000000000001",
    "code": "007",
    "json_text": "{\\"id\\": 12345678901234567890, \\"a\\": 1.0}",
    "quoted": "\\"x\\"",
    "f_nan": "nan",
    "f_inf": "inf",
    "f_ninf": "-inf",
    "f32": 0.1,
    "path": "C:\\\\new",
    "ip": "1.2.3.4",
    "m": {
      "10": 1,
      "2": 2
    },
    "z": null,
    "backslash_n": "\\\\N",
    "n": 0
  }`;
const CSV_HEADER = COLUMNS.join(',');
const CSV_FIRST_ROW = '10577349846663553072,18446744073709551615,-9223372036854775808,12345678901234567890.123456789,1.500,'
  + '00000000-0000-0000-0000-000000000001,007,"{""id"": 12345678901234567890, ""a"": 1.0}","""x""",nan,inf,-inf,0.1,'
  + 'C:\\new,1.2.3.4,"{""10"":1,""2"":2}",\\N,"\\N",0';

const dataRows = 'tr:not(.resultTable__spacerRow):not(.resultTable__detailRow)';

async function downloadText(page, click) {
  const pending = page.waitForEvent('download');
  await click();
  const download = await pending;
  let text = '';
  for await (const chunk of await download.createReadStream()) text += chunk.toString('utf8');
  return { name: download.suggestedFilename(), text };
}

test('the table shows every value as ClickHouse stores it: 64-bit and wider integers, decimals, UUID, NaN, Float32, strings', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, rows(2));
  const first = page.locator(`#resultTableBody ${dataRows}`).first();
  const cells = first.locator('td');
  await expect(cells).toHaveCount(COLUMNS.length + 1);
  for (const [index, column] of COLUMNS.entries()) {
    if (column === 'z') {
      await expect(cells.nth(index + 1).locator('.nullToken')).toHaveText('NULL');
      continue;
    }
    await expect(cells.nth(index + 1), column).toHaveText(SHOWN[column]);
  }
});

test('Copy cell, Copy row and the row details keep the value: no number from a string, no second unescape', async ({ page }) => {
  await openApp(page);
  const copied = await captureCopies(page, { clipboard: true, consume: true });
  await runSuccessfulQuery(page, rows(2));
  const first = page.locator(`#resultTableBody ${dataRows}`).first();
  const cells = first.locator('td');
  const copyCell = async (column) => {
    // The menu closes on scroll. Wait until the scroll into view settles, before the click.
    const cell = cells.nth(COLUMNS.indexOf(column) + 1);
    await cell.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await cell.click({ button: 'right' });
    await page.locator('.rowDetailsMenu').getByRole('menuitem', { name: 'Copy cell' }).click();
    return expect.poll(copied);
  };
  for (const column of ['hash', 'dec', 'code', 'json_text', 'quoted', 'f_nan', 'path', 'uuid', 'backslash_n']) {
    await (await copyCell(column)).toBe(SHOWN[column]);
  }
  await (await copyCell('m')).toBe('{\n  "10": 1,\n  "2": 2\n}');

  await cells.nth(1).scrollIntoViewIfNeeded();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await cells.nth(1).click({ button: 'right' });
  await page.locator('.rowDetailsMenu').getByRole('menuitem', { name: 'Copy row' }).click();
  // Copy row gives the object of the row at the top level. Its indent is two spaces less than inside the array of Copy JSON.
  await expect.poll(copied).toBe(FIRST_ROW_JSON_TEXT.replace(/\n {2}/g, '\n'));

  // The details show the same raw texts. 'C:\new' keeps its backslash. The String that looks like JSON is not reformatted.
  await cells.nth(1).click({ button: 'right' });
  await page.locator('.rowDetailsMenu').getByRole('menuitem', { name: 'Details' }).click();
  const values = page.locator('tr.resultTable__detailRow .rowDetails__value');
  await expect(values).toHaveCount(COLUMNS.length);
  for (const column of ['hash', 'json_text', 'quoted', 'path', 'f_nan', 'code']) {
    await expect(values.nth(COLUMNS.indexOf(column)).locator('.rowDetails__valueContent'), column).toHaveText(SHOWN[column]);
  }
});

test('one row: the vertical view shows the same values', async ({ page }) => {
  await openApp(page);
  await runSuccessfulQuery(page, rows(1));
  const valueOf = (column) => page.locator('#resultTableBody tr').nth(COLUMNS.indexOf(column)).locator('td').last();
  for (const column of ['hash', 'u64max', 'dec', 'dec_scale', 'uuid', 'code', 'json_text', 'quoted', 'f_nan', 'f32', 'path', 'ip']) {
    await expect(valueOf(column), column).toHaveText(SHOWN[column]);
  }
  await expect(valueOf('z').locator('.nullToken')).toHaveText('NULL');
});

test('Copy JSON equals Download JSON, Copy CSV equals Download CSV, and both keep every value', async ({ page }) => {
  await openApp(page);
  const copied = await captureCopies(page, { clipboard: true, consume: true });
  await runSuccessfulQuery(page, rows(2));

  await page.locator('#copyJsonButton').click();
  let jsonText = '';
  await expect.poll(async () => { jsonText = await copied(); return jsonText; }).not.toBe('');
  expect(jsonText.startsWith(`[\n  ${FIRST_ROW_JSON_TEXT},\n  {\n    "hash": 10577349846663553072,`)).toBe(true);
  const json = JSON.parse(jsonText);
  expect(json).toHaveLength(2);
  expect(json[1].n).toBe(1);

  await page.locator('#copyMenuButton').click();
  const downloadedJson = await downloadText(page, () => page.locator('#downloadReceivedJsonButton').click());
  expect(downloadedJson.name).toBe('results.json');
  expect(downloadedJson.text).toBe(jsonText);

  await page.locator('#copyMenuButton').click();
  await page.locator('#copyCsvButton').click();
  let csvText = '';
  await expect.poll(async () => { csvText = await copied(); return csvText; }).not.toBe('');
  const lines = csvText.split('\n');
  expect(lines[0]).toBe(CSV_HEADER);
  expect(lines[1]).toBe(CSV_FIRST_ROW);
  expect(lines).toHaveLength(3);

  await page.locator('#runMenuButton').click();
  const downloadedCsv = await downloadText(page, () => page.locator('#downloadCsvButton').click());
  expect(downloadedCsv.name).toBe('results.csv');
  expect(downloadedCsv.text).toBe(csvText);
});

test('a multiquery panel copies its rows with the same serializer, column names included', async ({ page }) => {
  await openApp(page);
  const copied = await captureCopies(page, { clipboard: true, consume: true });
  await page.locator('#runSettingsButton').click();
  await page.locator('#runOptMultiQuery').click();
  await expect(page.locator('#runOptMultiQuery')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#runSettingsButton').click();
  await page.locator('#queryTextArea').fill(`${rows(2)};\nSELECT 1 AS one;`);
  await page.locator('#runButton').click();
  const blocks = page.locator('.resultsStack__block');
  await expect(blocks).toHaveCount(2, { timeout: 30_000 });
  await expect(page.locator('#queryStatusText')).toHaveText(/finished|done/i, { timeout: 30_000 });
  await blocks.first().locator('.resultsStack__right button').filter({ hasText: /^Copy JSON$/ }).click();
  let text = '';
  await expect.poll(async () => { text = await copied(); return text; }).not.toBe('');
  expect(text.startsWith(`[\n  ${FIRST_ROW_JSON_TEXT},`)).toBe(true);

  // Copy all writes every statement, and its rows are written the same way.
  await page.locator('#copyJsonButton').click();
  await expect.poll(async () => { text = await copied(); return text; }).not.toBe('');
  const all = JSON.parse(text);
  expect(all.queries).toHaveLength(2);
  expect(all.queries[0].columns).toEqual(COLUMNS);
  expect(all.queries[1].data).toEqual([{ one: 1 }]);
  // Copy JSON writes the rows of a statement the same way. The rows are two levels deeper.
  expect(text).toContain(FIRST_ROW_JSON_TEXT.replace(/\n/g, '\n      '));
});

test('a JSON column keeps its big integers and the order of its keys', async ({ page }) => {
  await openApp(page);
  const copied = await captureCopies(page, { clipboard: true, consume: true });
  await runSuccessfulQuery(page, `SELECT CAST('{"id": 12345678901234567890, "b": {"10": 1, "2": 2}, "x": 0.5}' AS JSON) AS doc, toUInt256('115792089237316195423570985008687907853269984665640564039457584007913129639935') AS u256, [toDecimal256('1.5', 3)] AS d256, number AS n FROM numbers(2)`);
  const cells = page.locator(`#resultTableBody ${dataRows}`).first().locator('td');
  await expect(cells.nth(1)).toContainText('"id":12345678901234567890');
  await expect(cells.nth(2)).toHaveText('115792089237316195423570985008687907853269984665640564039457584007913129639935');
  await cells.nth(1).click({ button: 'right' });
  await page.locator('.rowDetailsMenu').getByRole('menuitem', { name: 'Copy cell' }).click();
  let text = '';
  await expect.poll(async () => { text = await copied(); return text; }).not.toBe('');
  expect(text).toContain('"id": 12345678901234567890');
  expect(text.indexOf('"10"')).toBeLessThan(text.indexOf('"2"'));
});

test('a numeric sort compares the digits of a UInt64 and of a long Decimal exactly; inf sorts as a number, nan with the NULLs', async ({ page }) => {
  await openApp(page);
  const order = await page.evaluate(() => {
    // The sort paths are exports of app_results_sort.js. The page gives them to window.ChDash.
    const t = window.ChDash;
    const values = [
      '12345678901234567890.123456789', '12345678901234567890.123456788', '-12345678901234567890.123456789',
      '18446744073709551615', '18446744073709551614', 'inf', '-inf', 'nan', null, '0.000000001', '-0.000000001', '0',
    ];
    const rows = values.map((value, index) => { const row = [value]; row.__chdashRowIndex = index + 1; return row; });
    const asc = t.sortNumericRows(rows, 0, 'asc').map((row) => row[0]);
    const reference = t.sortNumericRowsByComparator(rows.slice(), 0, false).map((row) => row[0]);
    return { asc, same: JSON.stringify(asc) === JSON.stringify(reference) };
  });
  expect(order.asc).toEqual([
    '-inf', '-12345678901234567890.123456789', '-0.000000001', '0', '0.000000001',
    '12345678901234567890.123456788', '12345678901234567890.123456789', '18446744073709551614', '18446744073709551615', 'inf',
    'nan', null,
  ]);
  expect(order.same).toBe(true);
});

test('JSON text is parsed without loss: numbers a double cannot keep stay their text, keys keep their order', async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(() => {
    const t = window.ChDash;
    const round = (text) => t.jsonText(t.parseJsonText(text), t.parseChType(''), 0);
    return {
      big: round('{"id":12345678901234567890,"a":1.0,"b":0.5}'),
      keys: round('{"10":1,"2":2,"x":[1e100,-0.25]}'),
      plain: round('{"a":[1,2,{"b":null}],"c":"t\\u00e9xt"}'),
      broken: t.parseJsonText('{"a":'),
      pretty: t.jsonText(t.parseJsonText('{"10":1,"2":[3]}'), t.parseChType(''), 2),
    };
  });
  expect(out.big).toBe('{"id":12345678901234567890,"a":1.0,"b":0.5}');
  expect(out.keys).toBe('{"10":1,"2":2,"x":[1e100,-0.25]}');
  expect(out.plain).toBe('{"a":[1,2,{"b":null}],"c":"téxt"}');
  expect(out.broken).toBeUndefined();
  expect(out.pretty).toBe('{\n  "10": 1,\n  "2": [\n    3\n  ]\n}');
});

test('a chart time without a zone is the wall clock of the server, not of the browser', async ({ page }) => {
  await openApp(page);
  const out = await page.evaluate(async () => {
    const toTimeMs = window.ChDash.queryChart.toTimeMs;
    return {
      tokyo: toTimeMs('2026-09-12 16:29:57', 'time', 'Asia/Tokyo'),
      tokyoFraction: toTimeMs('2026-09-12 16:29:57.250', 'time', 'Asia/Tokyo'),
      utc: toTimeMs('2026-09-12T16:29:57Z', 'time', 'Asia/Tokyo'),
      date: toTimeMs('2026-09-12', 'date', 'Asia/Tokyo'),
      localDate: new Date(2026, 8, 12).getTime(),
    };
  });
  expect(out.tokyo).toBe(Date.UTC(2026, 8, 12, 7, 29, 57));
  expect(out.tokyoFraction).toBe(Date.UTC(2026, 8, 12, 7, 29, 57, 250));
  expect(out.utc).toBe(Date.UTC(2026, 8, 12, 16, 29, 57));
  // A bare date stays a calendar day.
  expect(out.date).toBe(out.localDate);
});

// Copy JSON adds no wrapper that says nothing. One row is its object. One column is its values. One value is itself.
test('Copy JSON: one row is an object, one column is a list of values, one value is the value', async ({ page }) => {
  await openApp(page);
  const copied = await captureCopies(page, { clipboard: true, consume: true });
  const copy = async (sql) => {
    await runSuccessfulQuery(page, sql);
    await page.locator('#copyJsonButton').click();
    let text = '';
    await expect.poll(async () => { text = await copied(); return text; }).not.toBe('');
    return text;
  };
  // Several rows and several columns give a list of objects, as before.
  expect(JSON.parse(await copy('SELECT number AS n, toString(number) AS s FROM numbers(2)'))).toEqual([{ n: 0, s: '0' }, { n: 1, s: '1' }]);
  // One row gives its object, not a list of one.
  expect(JSON.parse(await copy("SELECT 7 AS n, 'a' AS s"))).toEqual({ n: 7, s: 'a' });
  // One column gives the values, not objects of one key.
  expect(JSON.parse(await copy('SELECT number FROM numbers(3)'))).toEqual([0, 1, 2]);
  // One row of one column gives the value itself. A string stays a JSON string, and a structure stays a structure.
  expect(JSON.parse(await copy("SELECT 'x' AS s"))).toBe('x');
  expect(JSON.parse(await copy('SELECT [1, 2] AS a'))).toEqual([1, 2]);
  // No row still gives a list.
  expect(JSON.parse(await copy('SELECT number FROM numbers(3) WHERE number > 5'))).toEqual([]);
});
