import { expect } from '@playwright/test';

export async function openApp(page) {
  await page.goto('/');
  await expect(page.locator('#queryWorkspace')).toBeVisible();
  await expect(page.locator('#hostPickerButton')).toBeVisible();
  await expect(page.locator('#versionBadge')).not.toHaveText(/offline/i);
  await expect(page.locator('#hostPickerText')).not.toContainText(/offline/i);
  await expect(page.locator('#runButton')).toBeEnabled();
}

export async function runQuery(page, sql, options = {}) {
  const editor = page.locator('#queryTextArea');
  await editor.fill(sql);
  if (options.profiling) {
    await page.locator('#runMenuButton').click();
    await expect(page.locator('#runMenu')).toBeVisible();
    await page.locator('#runWithProfilingButton').click();
  } else {
    await page.locator('#runButton').click();
  }
  await expect(page.locator('#queryStatusText')).toHaveText(/running|done|finished|limit reached|error|canceled/i, { timeout: 10_000 });
}

export async function waitForTerminal(page) {
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished|limit reached|error|canceled/i, { timeout: 30_000 });
}

export async function runSuccessfulQuery(page, sql, options = {}) {
  await runQuery(page, sql, options);
  await waitForTerminal(page);
  await expect(page.locator('#queryStatusText')).toHaveText(/done|finished|limit reached/i);
  await expect(page.locator('#elapsedSecondsText')).not.toHaveText('-');
}

export async function openExplorer(page) {
  await page.locator('#pageSelectButton').click();
  await page.locator('#navExplorerButton').click();
  await expect(page.locator('#explorerWorkspace')).toBeVisible();
  await expect(page).toHaveURL(/\/explorer(?:\/|$)/);
  await expect(page.locator('#explorerTableList')).toBeVisible({ timeout: 15_000 });
}

export async function openAnalysis(page) {
  await expect(page.locator('#analyzeQueryButton')).toBeVisible({ timeout: 10_000 });
  await page.locator('#analyzeQueryButton').click();
  await expect(page.locator('#analysisModalBackdrop')).toBeVisible();
  await expect(page.locator('#analysisSummary')).toContainText(/Session|ClickHouse|query/i, { timeout: 12_000 });
}
