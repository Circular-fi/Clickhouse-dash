import { defineConfig } from '@playwright/test';

const baseURL = process.env.FRONTEND_BASE_URL || 'http://chdash_source:8080';
const artifactsRoot = process.env.FRONTEND_ARTIFACTS_DIR || '/artifacts/frontend-review';

// Run modes. See tests/README.md, section "Running tests quickly".
// - default: layout specs run on the three desktop viewports. Behavioural specs run on desktop-1440 only.
//   Their viewport-sensitive tests (LAYOUT_TITLES) also run on the other two viewports.
//   Timing-budget tests are queued last, one at a time. A worker of the other tests may still run at that time.
//   PW_PERF=only runs them alone, after the others have ended, as run-all-tests.py does.
// - PW_ALL_PROJECTS=1: every test runs on every viewport. This is the pre-release run.
// - PW_SHARED_HOST=1: omits the timing-budget tests. They measure the host, not the code, when other runs share it. This mode defaults to one worker.
// - PW_PERF=skip|only|with: the timing-budget tests are omitted (skip), run alone with no other test and one worker (only), or queued last (with). with is the default. Use skip with PW_SHARED_HOST=1. The official run is a "skip" run, then an "only" run.
// - PW_WORKERS=<n>: sets the worker count. PW_ARTIFACTS=full records a video and a trace of every failure, as before. The default records them only on the first retry.
const env = process.env;
const ALL_PROJECTS = env.PW_ALL_PROJECTS === '1';
const SHARED_HOST = env.PW_SHARED_HOST === '1';
const PERF = ['skip', 'only', 'with'].includes(env.PW_PERF) ? env.PW_PERF : (SHARED_HOST ? 'skip' : 'with');
const FULL_ARTIFACTS = env.PW_ARTIFACTS === 'full';
const WORKERS = Number(env.PW_WORKERS) || (SHARED_HOST ? 1 : 2);

// These specs check layout and look. They run on every viewport.
const LAYOUT_SPECS = [
  'accessibility', 'design', 'explorer-nav', 'obs-filterbar', 'page-chrome', 'ui-*', 'visual-regression',
].map((name) => `**/${name}.spec.js`);
// These tests of behavioural specs measure the page against the viewport.
const LAYOUT_TITLES = /overflow|fits the viewport|\bcaptures?\b|full-bleed|edge to edge|wraps the same way/i;
// These tests assert wall-clock budgets. They run alone at the end of the run.
const PERF_TITLES = new RegExp([
  'performance budgets?',
  'within budget',
  'handles hundreds of tables',
  'chart independently, share the time crosshair',
  'charts once, downsampled',
  'stay virtualized and reach the last row',
  '10,000-span trace is virtualised',
].join('|'), 'i');

const VIEWPORTS = [
  { name: 'desktop-1920', viewport: { width: 1920, height: 1080 } },
  { name: 'desktop-1440', viewport: { width: 1440, height: 900 } },
  { name: 'laptop-1280', viewport: { width: 1280, height: 800 } },
];
const CANONICAL = 'desktop-1440';

// Projects that share a name are one viewport. --project=<name> selects all of them.
// Reports and snapshots keep the viewport name.
const mainProjects = [];
const perfProjects = [];
for (const { name, viewport } of VIEWPORTS) {
  const use = { viewport, deviceScaleFactor: 1 };
  const everything = ALL_PROJECTS || name === CANONICAL;
  if (PERF === 'only') {
    // This project has only the timing-budget tests. It has no main project.
  } else if (everything) {
    mainProjects.push({ name, use, grepInvert: PERF_TITLES });
  } else {
    mainProjects.push({ name, use, testMatch: LAYOUT_SPECS, grepInvert: PERF_TITLES });
    mainProjects.push({ name, use, testIgnore: LAYOUT_SPECS, grep: LAYOUT_TITLES, grepInvert: PERF_TITLES });
  }
  if (PERF !== 'skip' && everything) perfProjects.push({ name, use, grep: PERF_TITLES, workers: 1 });
}

export default defineConfig({
  testDir: './specs',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  // Each test is isolated. It has its own context, with its own localStorage, query library and history.
  // The workers share the tests of one file.
  fullyParallel: true,
  workers: WORKERS,
  retries: process.env.CI ? 1 : 0,
  // A failed test is retried at the end, alone. The retry runs with no load from the other tests.
  retryStrategy: 'isolated',
  outputDir: `${artifactsRoot}/test-output`,
  snapshotPathTemplate: `${process.cwd()}/snapshots/{projectName}/{testFilePath}/{arg}{ext}`,
  reporter: [
    ['line'],
    ['./helpers/skip-reporter.js'],
    ['json', { outputFile: `${artifactsRoot}/playwright-results.json` }],
    ['html', { outputFolder: `${artifactsRoot}/playwright-report`, open: 'never' }],
  ],
  use: {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: false,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
    // A recording of every test costs CPU on the passing majority. This includes a screencast through ffmpeg and a trace of every action.
    // Record the retry instead.
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
