import { test, expect } from '@playwright/test';
import { openApp } from '../helpers/app.js';

// The keys of the editor completion menu (app_autocomplete.js). A menu that opens by itself while a person types must never take the Enter of a newline.
// Enter accepts a choice only after the person moves to it with the arrows or Ctrl+Space. Tab always accepts a choice.
// An earlier version of this test grepped the names of two variables. This spec drives the editor as a person drives it.

async function typeUntilMenu(page, text) {
  const editor = page.locator('#queryTextArea');
  await editor.fill('');
  await editor.click();
  await page.keyboard.type(text, { delay: 20 });
  const menu = page.locator('#autocompleteMenu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.autocompleteItem').first()).toBeVisible();
  return { editor, menu };
}

test('Enter in a menu that opened by itself is a newline and closes the menu', async ({ page }) => {
  await openApp(page);
  const { editor, menu } = await typeUntilMenu(page, 'SELEC');
  await expect(menu.locator('.autocompleteItem[aria-selected="true"]')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await expect(editor).toHaveValue('SELEC\n');
});

test('Enter after the arrows accepts the choice that the person moved to', async ({ page }) => {
  await openApp(page);
  const { editor, menu } = await typeUntilMenu(page, 'SELECT toStartOfD');
  await page.keyboard.press('ArrowDown');
  const chosen = (await menu.locator('.autocompleteItem[aria-selected="true"] .autocompleteItem__labelName').first().textContent()).trim();
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  const value = await editor.inputValue();
  // The choice is written whole. A function call is laid out by the editor, so the text may span lines. Enter must not leave the
  // half-typed word with a newline after it.
  expect(value.startsWith('SELECT ')).toBe(true);
  expect(value.toLowerCase()).toContain(chosen.toLowerCase());
  expect(value).not.toBe('SELECT toStartOfD\n');
});

test('Tab accepts the current choice without any arrow, and Escape closes the menu and keeps the text', async ({ page }) => {
  await openApp(page);
  let { editor, menu } = await typeUntilMenu(page, 'SELECT toStartOfD');
  const first = (await menu.locator('.autocompleteItem').first().locator('.autocompleteItem__labelName').textContent()).trim();
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  const value = await editor.inputValue();
  expect(value.toLowerCase()).toContain(first.toLowerCase());
  expect(value).not.toBe('SELECT toStartOfD');
  ({ editor, menu } = await typeUntilMenu(page, 'SELECT toStartOfD'));
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(editor).toHaveValue('SELECT toStartOfD');
});
