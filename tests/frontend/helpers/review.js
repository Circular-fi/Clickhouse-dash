import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.env.FRONTEND_ARTIFACTS_DIR || '/artifacts/frontend-review';

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function stabilizePage(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  });
  // Wait until the fonts load, then wait for two frames. After that, the styles above are applied and painted.
  await page.evaluate(async () => {
    if (document.fonts) await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }).catch(() => undefined);
}

// A capture takes one screenshot and one audit of the page as it is. The audit has two kinds of fields.
// - rules: horizontalOverflow and outsideViewport fail the capture below. A control that leaves the viewport is a bug.
// - signals: clippedText, smallControls, overlappingControls and the style token counts are counted per state.
//   The design report (scripts/build-report.mjs) shows them for a person to read. They are heuristics, not rules.
//   A calendar that opens over the facets overlaps by design. A text with an ellipsis is clipped by design.
//   Rules of the same ideas that can fail have their own specs. Touch targets are in ui-foundations.spec.js. Labels and names are in a11y-contract.spec.js.
export async function captureState(page, testInfo, state) {
  await stabilizePage(page);
  const project = safeName(testInfo.project.name);
  const name = safeName(state);
  const screenshots = path.join(root, 'screenshots', project);
  const audits = path.join(root, 'audits', project);
  await ensureDir(screenshots);
  await ensureDir(audits);

  const screenshotPath = path.join(screenshots, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true, animations: 'disabled' });

  const audit = await page.evaluate(() => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const doc = document.documentElement;
    const visible = (el) => {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || '1') > 0 && r.width > 0 && r.height > 0;
    };
    const selectorFor = (el) => {
      if (el.id) return `#${el.id}`;
      const cls = Array.from(el.classList).slice(0, 2).join('.');
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    };
    const inHorizontalScroller = (el) => {
      let p = el.parentElement;
      while (p && p !== document.body) {
        const s = getComputedStyle(p);
        if (['auto', 'scroll'].includes(s.overflowX) && p.scrollWidth > p.clientWidth + 1) return true;
        p = p.parentElement;
      }
      return false;
    };
    const all = Array.from(document.querySelectorAll('body *')).filter(visible);
    const outsideViewport = [];
    const clippedText = [];
    const smallControls = [];
    const controls = [];

    for (const el of all) {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if ((r.right > viewport.width + 1 || r.left < -1) && !inHorizontalScroller(el)) {
        outsideViewport.push({ selector: selectorFor(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) });
      }
      const ht = el;
      if (ht.innerText && ht.innerText.trim() && (ht.scrollWidth > ht.clientWidth + 2 || ht.scrollHeight > ht.clientHeight + 2) && ['hidden', 'clip'].includes(cs.overflow)) {
        clippedText.push({ selector: selectorFor(el), text: ht.innerText.trim().slice(0, 120), client: [ht.clientWidth, ht.clientHeight], scroll: [ht.scrollWidth, ht.scrollHeight], textOverflow: cs.textOverflow });
      }
      if (el.matches('button, [role="button"], input, select, textarea, a')) {
        const item = { selector: selectorFor(el), x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
        controls.push(item);
        if (r.height < 32 || r.width < 32) smallControls.push(item);
      }
    }

    // The list is sorted by left edge. A control is compared only with the controls that start before its right edge.
    const overlapPairs = [];
    const byLeft = controls.slice().sort((a, b) => a.x - b.x);
    for (let i = 0; i < byLeft.length && overlapPairs.length < 80; i += 1) {
      const a = byLeft[i];
      for (let j = i + 1; j < byLeft.length && byLeft[j].x < a.x + a.width && overlapPairs.length < 80; j += 1) {
        const b = byLeft[j];
        const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
        const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
        if (x * y > 16) overlapPairs.push({ a: a.selector, b: b.selector, overlapArea: x * y });
      }
    }

    const styleTargets = Array.from(document.querySelectorAll('body, header, main, .panel, button, input, textarea, select, table, th, td, [role="dialog"]')).filter(visible);
    const uniq = (values) => Array.from(new Set(values.filter(Boolean))).sort();
    const styles = {
      fontSizes: uniq(styleTargets.map((e) => getComputedStyle(e).fontSize)),
      fontWeights: uniq(styleTargets.map((e) => getComputedStyle(e).fontWeight)),
      borderRadii: uniq(styleTargets.map((e) => getComputedStyle(e).borderRadius)),
      backgrounds: uniq(styleTargets.map((e) => getComputedStyle(e).backgroundColor)),
      textColors: uniq(styleTargets.map((e) => getComputedStyle(e).color)),
      gaps: uniq(styleTargets.map((e) => getComputedStyle(e).gap)),
      paddings: uniq(styleTargets.map((e) => {
        const s = getComputedStyle(e);
        return `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`;
      })),
    };

    return {
      url: location.href,
      title: document.title,
      viewport,
      documentSize: { width: doc.scrollWidth, height: doc.scrollHeight },
      horizontalOverflow: doc.scrollWidth > viewport.width + 1,
      outsideViewport: outsideViewport.slice(0, 100),
      clippedText: clippedText.slice(0, 100),
      smallControls: smallControls.slice(0, 100),
      overlappingControls: overlapPairs,
      styleTokenCounts: Object.fromEntries(Object.entries(styles).map(([k, v]) => [k, v.length])),
      styles,
    };
  });

  await fs.writeFile(path.join(audits, `${name}.json`), JSON.stringify(audit, null, 2));
  await testInfo.attach(`design-${name}`, { path: screenshotPath, contentType: 'image/png' });

  // Horizontal layout correctness is a product contract. It is not a heuristic for the report only.
  // Wide tables that are intentional must scroll inside their own container.
  // The page itself and the controls that cannot scroll must never leave the viewport.
  if (audit.horizontalOverflow || audit.outsideViewport.length > 0) {
    throw new Error(
      `Design overflow in ${state}: documentOverflow=${audit.horizontalOverflow}, `
      + `outsideViewport=${JSON.stringify(audit.outsideViewport.slice(0, 12))}`
    );
  }
  return audit;
}

export async function writeJson(kind, testInfo, name, value) {
  const dir = path.join(root, kind, safeName(testInfo.project.name));
  await ensureDir(dir);
  const file = path.join(dir, `${safeName(name)}.json`);
  await fs.writeFile(file, JSON.stringify(value, null, 2));
  return file;
}
