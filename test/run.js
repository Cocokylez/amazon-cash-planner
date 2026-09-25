/* Runs every suite in order and reports one verdict.
   Usage: node test/run.js
   Source files are found via FBA_PAYMENTS_CSV and FBA_PREVIEW_DIR, which
   default to the Downloads folder the exports arrived in. */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = ['desktop.test.js', 'ledger.test.js', 'preview.test.js', 'cash.test.js', 'engines.test.js',
  'import.test.js', 'inputs.test.js', 'simple.test.js', 'claude.test.js', 'sync.test.js', 'dataset.test.js', 'selftest.test.js', 'repair.test.js'];
let failed = 0;
const summary = [];

for (const s of SUITES) {
  process.stdout.write('\n\n' + '█'.repeat(72) + '\n  ' + s + '\n' + '█'.repeat(72) + '\n');
  const r = spawnSync(process.execPath, ['--max-old-space-size=6144', path.join(__dirname, s)], {
    stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8',
  });
  process.stdout.write(r.stdout || '');
  const m = /passed (\d+)\s+failed (\d+)\s+not tested (\d+)/.exec(r.stdout || '');
  /* Exit 2 means the suite's source export was never supplied on this machine.
     That is "not tested", not a failure — the distinction the whole report
     rests on, and it must survive running the suite somewhere else. */
  const noSource = r.status === 2 && !m;
  summary.push({
    suite: s,
    passed: m ? +m[1] : 0,
    failed: m ? +m[2] : (r.status === 0 || noSource ? 0 : 1),
    notTested: m ? +m[3] : (noSource ? 1 : 0),
    noSource, status: r.status,
  });
  if (r.status !== 0 && !noSource) failed++;
}

console.log('\n\n' + '='.repeat(72));
console.log('  SUITE TOTALS');
console.log('='.repeat(72));
let p = 0, f = 0, n = 0;
for (const s of summary) {
  console.log('  ' + s.suite.padEnd(22) + String(s.passed).padStart(4) + ' passed  '
    + String(s.failed).padStart(3) + ' failed  ' + String(s.notTested).padStart(3) + ' not tested'
    + (s.noSource ? '   (source export not supplied here)' : ''));
  p += s.passed; f += s.failed; n += s.notTested;
}
console.log('  ' + '-'.repeat(68));
console.log('  ' + 'TOTAL'.padEnd(22) + String(p).padStart(4) + ' passed  '
  + String(f).padStart(3) + ' failed  ' + String(n).padStart(3) + ' not tested');
console.log('='.repeat(72));
console.log(failed ? '\n  FAILED\n' : '\n  All suites green. "Not tested" means the source for that\n'
  + '  control was never supplied — it is not a pass.\n');
process.exit(failed ? 1 : 0);
