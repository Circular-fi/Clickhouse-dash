import { defineConfig } from '@playwright/test';

const baseURL = process.env.FRONTEND_BASE_URL || 'http://chdash_source:8080';
const artifactsRoot = process.env.FRONTEND_ARTIFACTS_DIR || '/artifacts/frontend-review';

export default defineConfig({
  testDir: './specs',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
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
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    {
      name: 'desktop-1920',
      use: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 },
    },
    {
      name: 'desktop-1440',
      use: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
    },
    {
      name: 'laptop-1280',
      use: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    },
  ],
});
