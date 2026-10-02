import { defineConfig } from '@playwright/test';

const baseURL = process.env.FRONTEND_BASE_URL || 'http://chdash_source:8080';
const artifactsRoot = process.env.FRONTEND_ARTIFACTS_DIR || '/artifacts/frontend-review';

// Run modes (tests/README.md, "Running tests quickly"):
// - default: layout specs run on the three desktop viewports, behavioural specs
//   on desktop-1440 only, plus their viewport-sensitive tests (LAYOUT_TITLES) on
//   the other two; timing-budget tests run last, one at a time.
// - PW_ALL_PROJECTS=1: every test on every viewport (the pre-release run).
// - PW_SHARED_HOST=1: leaves the timing-budget tests out (they measure the host,
//   not the code, when other runs share it) and defaults to one worker.
// - PW_WORKERS=<n>: worker count. PW_ARTIFACTS=full: video and trace of every
//   failure, as before, instead of only on the first retry.
const env = process.env;
const ALL_PROJECTS = env.PW_ALL_PROJECTS === '1';
const SHARED_HOST = env.PW_SHARED_HOST === '1';
const FULL_ARTIFACTS = env.PW_ARTIFACTS === 'full';
const WORKERS = Number(env.PW_WORKERS) || (SHARED_HOST ? 1 : 2);

// Specs about layout and look: every viewport.
const LAYOUT_SPECS = [
  'accessibility', 'design', 'explorer-nav', 'obs-filterbar', 'page-chrome', 'ui-*', 'visual-regression',
].map((name) => `**/${name}.spec.js`);
// Tests of behavioural specs that measure the page against the viewport.
const LAYOUT_TITLES = /overflow|fits the viewport|\bcaptures?\b|full-bleed|edge to edge|wraps the same way/i;
// Tests asserting wall-clock budgets: alone at the end of the run.
const PERF_TITLES = new RegExp([
  'performance budgets?',
  'within budget',
  'handles hundreds of tables',
  'chart independently, share the time crosshair',
  'charts incrementally, downsampled',
  'stay virtualized and reach the last row',
  '10,000-span trace is virtualised',
].join('|'), 'i');

const VIEWPORTS = [
  { name: 'desktop-1920', viewport: { width: 1920, height: 1080 } },
  { name: 'desktop-1440', viewport: { width: 1440, height: 900 } },
  { name: 'laptop-1280', viewport: { width: 1280, height: 800 } },
];
const CANONICAL = 'desktop-1440';

// Projects sharing a name are one viewport: --project=<name> selects all of them,
// reports and snapshots keep the viewport name.
const mainProjects = [];
const perfProjects = [];
for (const { name, viewport } of VIEWPORTS) {
  const use = { viewport, deviceScaleFactor: 1 };
  const everything = ALL_PROJECTS || name === CANONICAL;
  if (everything) {
    mainProjects.push({ name, use, grepInvert: PERF_TITLES });
  } else {
    mainProjects.push({ name, use, testMatch: LAYOUT_SPECS, grepInvert: PERF_TITLES });
    mainProjects.push({ name, use, testIgnore: LAYOUT_SPECS, grep: LAYOUT_TITLES, grepInvert: PERF_TITLES });
  }
  if (!SHARED_HOST && everything) perfProjects.push({ name, use, grep: PERF_TITLES, workers: 1 });
}

export default defineConfig({
  testDir: './specs',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  // Tests are isolated (own context: localStorage, query library, history), so
  // the tests of one file spread over the workers.
  fullyParallel: true,
  workers: WORKERS,
  retries: process.env.CI ? 1 : 0,
  // A failed test is retried at the end, alone, away from the load of the others.
  retryStrategy: 'isolated',
  outputDir: `${artifactsRoot}/test-output`,
  snapshotPathTemplate: `${process.cwd()}/snapshots/{projectName}/{testFilePath}/{arg}{ext}`,
  reporter: [
    ['line'],
    ['json', { outputFile: `${artifactsRoot}/playwright-results.json` }],
    ['html', { outputFolder: `${artifactsRoot}/playwright-report`, open: 'never' }],
  ],
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: false,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    // Recording every test (a screencast through ffmpeg, a trace of every
    // action) costs CPU on the passing majority: record the retry instead.
    trace: FULL_ARTIFACTS ? 'retain-on-failure' : 'on-first-retry',
    screenshot: 'only-on-failure',
    video: FULL_ARTIFACTS ? 'retain-on-failure' : 'on-first-retry',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [...mainProjects, ...perfProjects],
});
