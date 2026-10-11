// A spec that needs an instance of its own (a server with MCP on, a writable query library) names it by an
// environment variable. Without it the spec skips, which would make the run green with the spec not run: in CI
// (CHDASH_REQUIRE_FIXTURES=1, set by tests/docker-compose.yml) a missing instance is a failure.
export function requireInstance(test, variable, value) {
  if (value) return;
  if (process.env.CHDASH_REQUIRE_FIXTURES === '1') throw new Error(`${variable} is not set: the test stack must start the instance this spec runs against (tests/docker-compose.yml)`);
  test.skip(true, `${variable} names the instance this spec runs against (tests/README.md)`);
}
