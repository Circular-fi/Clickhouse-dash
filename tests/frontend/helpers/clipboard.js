// The page copies text in two ways.
// In a secure context, the app copies through the clipboard API.
// Outside a secure context, it copies through the selection of a hidden textarea.
// captureCopies() records the second copy (the textarea). With { clipboard: true }, it also reads the first copy (the clipboard API).
//
//   const copied = await captureCopies(page);            // before the click that copies
//   await expect.poll(copied).toBe('text');                // the last text copied
//   const copied = await captureCopies(page, { clipboard: true, consume: true });
//                                                          // reads the clipboard when it can; consume: forget the text after a read
//   await copiedText(page)                                 // the last text copied through a textarea, without a reader
export async function captureCopies(page, { clipboard = false, consume = false } = {}) {
  if (clipboard) await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => {
    window.__copies = [];
    document.addEventListener('copy', (event) => {
      const el = event.target instanceof HTMLTextAreaElement ? event.target : document.activeElement;
      if (el && typeof el.value === 'string' && Number.isInteger(el.selectionStart) && Number.isInteger(el.selectionEnd)) {
        window.__copies.push(el.value.slice(el.selectionStart, el.selectionEnd));
      }
    }, true);
  });
  return async () => {
    const text = await page.evaluate(async (useClipboard) => {
      if (useClipboard && window.isSecureContext && navigator.clipboard) {
        try { return await navigator.clipboard.readText(); } catch (_) { /* fall back to the textarea */ }
      }
      return window.__copies[window.__copies.length - 1] || '';
    }, clipboard);
    if (consume) await page.evaluate(() => { window.__copies = []; });
    return text;
  };
}

export const copiedText = (page) => page.evaluate(() => (window.__copies || [])[(window.__copies || []).length - 1] || '');
