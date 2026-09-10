import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.env.FRONTEND_ARTIFACTS_DIR || '/artifacts/frontend-review';

async function walk(dir, suffix = '.json') {
  const out = [];
  try {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...await walk(p, suffix));
      else if (entry.name.endsWith(suffix)) out.push(p);
    }
  } catch {}
  return out;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

const audits = (await walk(path.join(root, 'audits'))).map(async (f) => [f, await readJson(f)]);
const auditRows = await Promise.all(audits);
const a11yRows = await Promise.all((await walk(path.join(root, 'accessibility'))).map(async (f) => [f, await readJson(f)]));
const runtimeRows = await Promise.all((await walk(path.join(root, 'runtime'))).map(async (f) => [f, await readJson(f)]));
const pw = await readJson(path.join(root, 'playwright-results.json'));

let tests = { expected: 0, unexpected: 0, skipped: 0, flaky: 0 };
if (pw?.stats) tests = { ...tests, ...pw.stats };

const design = {
  states: auditRows.length,
  horizontalOverflow: 0,
  outsideViewport: 0,
  clippedText: 0,
  smallControls: 0,
  overlappingControls: 0,
  maxStyleTokens: {},
};
for (const [, a] of auditRows) {
  if (!a) continue;
  if (a.horizontalOverflow) design.horizontalOverflow += 1;
  design.outsideViewport += a.outsideViewport?.length || 0;
  design.clippedText += a.clippedText?.length || 0;
  design.smallControls += a.smallControls?.length || 0;
  design.overlappingControls += a.overlappingControls?.length || 0;
  for (const [k, v] of Object.entries(a.styleTokenCounts || {})) {
    design.maxStyleTokens[k] = Math.max(design.maxStyleTokens[k] || 0, Number(v) || 0);
  }
}

const a11y = { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 };
for (const [, a] of a11yRows) {
  for (const v of a?.violations || []) {
    a11y.total += 1;
    if (v.impact in a11y) a11y[v.impact] += 1;
  }
}

const runtime = { consoleErrors: 0, pageErrors: 0, failedRequests: 0 };
for (const [, r] of runtimeRows) {
  runtime.consoleErrors += r?.consoleErrors?.length || 0;
  runtime.pageErrors += r?.pageErrors?.length || 0;
  runtime.failedRequests += r?.failedRequests?.length || 0;
}

const summary = { generated_at: new Date().toISOString(), tests, design, accessibility: a11y, runtime };
await fs.writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2));

const md = `# ChDash design review\n\nGenerated: ${summary.generated_at}\n\n## Capture execution\n\n- Expected/passed: ${tests.expected}\n- Unexpected/failed: ${tests.unexpected}\n- Flaky: ${tests.flaky}\n- Skipped: ${tests.skipped}\n\n## Runtime signals\n\n- Console errors: ${runtime.consoleErrors}\n- Page errors: ${runtime.pageErrors}\n- Failed network requests: ${runtime.failedRequests}\n\n## Automated design signals\n\nThese are review heuristics, not aesthetic pass/fail rules.\n\n- Captured states: ${design.states}\n- States with horizontal overflow: ${design.horizontalOverflow}\n- Elements outside viewport: ${design.outsideViewport}\n- Clipped text candidates: ${design.clippedText}\n- Controls smaller than 32px: ${design.smallControls}\n- Overlapping control candidates: ${design.overlappingControls}\n- Maximum unique style-token counts: ${JSON.stringify(design.maxStyleTokens)}\n\n## Accessibility findings\n\nAccessibility is report-only by default. Set \`A11Y_STRICT=1\` to fail on serious/critical findings.\n\n- Critical: ${a11y.critical}\n- Serious: ${a11y.serious}\n- Moderate: ${a11y.moderate}\n- Minor: ${a11y.minor}\n- Total rules with violations across states: ${a11y.total}\n\n## Review artifact\n\nUpload \`tests/artifacts/chdash-test-review.zip\`. The \`design/\` directory contains screenshots for every viewport/state, Playwright traces/videos for failed captures, layout heuristics, accessibility findings and runtime diagnostics.\n\n## Visual baselines\n\nVisual regression remains disabled until the current design is accepted. Once approved, set \`VISUAL_COMPARE=1\` when running the normal \`test\` profile and commit the generated snapshots.\n`
await fs.writeFile(path.join(root, 'report.md'), md);
console.log(JSON.stringify(summary, null, 2));
