import { test, expect } from '@playwright/test';

// An address that has no page opens the first page that exists and says so once (UI-008, docs/ui-foundations.md "Routes"): the
// server redirects with ?redirected_from=<the path>, boot() takes the mark off the address, and app_route_notice.js shows the notice.

test('an unknown Observability address opens the first view and says so once', async ({ page }) => {
  await page.goto('/observability/nope');
  await expect(page).toHaveURL(/\/observability\/traces$/);
  const notice = page.locator('#routeNotice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'status');
  await expect(notice).toContainText('/observability/nope is not a page of this server');
  await expect(notice).toContainText('Traces is shown instead');
  // The mark is off the address bar, so a reload or a copied link has no notice.
  expect(page.url()).not.toContain('redirected_from');
  await page.reload();
  await expect(page.locator('#tracesWorkspace')).toBeVisible();
  await expect(page.locator('#routeNotice')).toHaveCount(0);
});

test('an unknown System section opens the Overview with the notice, which can be dismissed', async ({ page }) => {
  await page.goto('/system/no-such-section?host_id=local');
  await expect(page).toHaveURL(/\/system\?host_id=local$/);
  const notice = page.locator('#routeNotice');
  await expect(notice).toContainText('/system/no-such-section is not a page of this server');
  await expect(notice).toContainText('The System overview is shown instead');
  await notice.getByRole('button', { name: 'Dismiss' }).click();
  await expect(notice).toBeHidden();
});

test('the bare /observability is a move, not a mistake: no notice', async ({ page }) => {
  await page.goto('/observability');
  await expect(page).toHaveURL(/\/observability\/traces$/);
  await expect(page.locator('#tracesWorkspace')).toBeVisible();
  await expect(page.locator('#routeNotice')).toHaveCount(0);
});

test('the address that was asked for is text in the notice, never markup', async ({ page }) => {
  await page.goto('/observability/%3Cimg%20src=x%20onerror=window.__pwned=1%3E');
  const notice = page.locator('#routeNotice');
  await expect(notice).toContainText('<img src=x onerror=window.__pwned=1>');
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  expect(await notice.locator('img').count()).toBe(0);
});
