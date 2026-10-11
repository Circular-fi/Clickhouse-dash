import fs from 'node:fs';
import path from 'node:path';

// Lists the tests that were skipped, with the reason, and fails the run when there are more than CHDASH_MAX_SKIPS (a
// number; unset: only listed). A test that skips because the stack lacks its data or its instance leaves the run green with
// the test not run: the list shows it, and the bound of the official run (tests/test-suite/run-all-tests.py) keeps the
// count from growing without someone raising it on purpose.
export default class SkipReporter {
  constructor() {
    this.skipped = [];
  }

  onTestEnd(test, result) {
    if (result.status !== 'skipped') return;
    const note = test.annotations.find((annotation) => annotation.type === 'skip');
    this.skipped.push({ title: test.titlePath().slice(2).join(' > '), file: path.basename(test.location.file), reason: note?.description || '' });
  }

  async onEnd() {
    const root = process.env.FRONTEND_ARTIFACTS_DIR || '/artifacts/frontend-review';
    try {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, 'skipped.json'), JSON.stringify(this.skipped, null, 2));
    } catch (error) { /* the list is a diagnostic: the run does not fail for it */ }
    const byReason = new Map();
    for (const item of this.skipped) byReason.set(`${item.file}: ${item.reason}`, (byReason.get(`${item.file}: ${item.reason}`) || 0) + 1);
    if (this.skipped.length) {
      console.log(`\n${this.skipped.length} skipped test(s):`);
      for (const [reason, count] of [...byReason].sort()) console.log(`  ${count} x ${reason}`);
    }
    const max = process.env.CHDASH_MAX_SKIPS;
    if (max !== undefined && max !== '' && this.skipped.length > Number(max)) {
      console.log(`\nMore tests skipped (${this.skipped.length}) than CHDASH_MAX_SKIPS (${max}): a stack without its data or its instances runs fewer tests, and this run says so.`);
      return { status: 'failed' };
    }
    return undefined;
  }
}
