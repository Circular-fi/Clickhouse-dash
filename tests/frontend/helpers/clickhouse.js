import { expect } from '@playwright/test';

// Reads of the test ClickHouse (the same server the instance under test uses), for specs that choose their window
// or their expected values from the fixture. CLICKHOUSE_URL, CLICKHOUSE_USER and CLICKHOUSE_PASSWORD come from the
// test container's environment (tests/docker-compose.yml); the defaults are the compose ones.
export async function otelRows(request, sql) {
  const base = (process.env.CLICKHOUSE_URL || 'http://clickhouse:8123').replace(/\/$/, '');
  const auth = Buffer.from(`${process.env.CLICKHOUSE_USER || 'test'}:${process.env.CLICKHOUSE_PASSWORD || 'test'}`).toString('base64');
  const response = await request.post(`${base}/`, { data: `${sql} FORMAT TSV`, headers: { Authorization: `Basic ${auth}` }, timeout: 60_000 });
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.text()).split('\n').filter(Boolean).map((line) => line.split('\t'));
}
