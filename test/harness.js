/* Tiny assertion harness. No dependencies, so the suite runs anywhere node does. */
let passed = 0, failed = 0, skipped = 0;
const failures = [];
let group = '';

const Money = require('../lib/money.js');

function section(name) { group = name; console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 66 - name.length))); }

function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  PASS  ' + label); }
  else {
    failed++; failures.push({ group, label, detail });
    console.log('  FAIL  ' + label + (detail == null ? '' : '\n          ' + detail));
  }
  return !!cond;
}
function eq(label, got, want) {
  const good = String(got) === String(want);
  return ok(label, good, good ? null : 'got ' + got + '   want ' + want);
}
/* Money assertions read in dollars, compare in cents. */
function eqMoney(label, gotCents, wantString) {
  const got = Money.fmt(gotCents, { bare: true });
  return ok(label, got === wantString, got === wantString ? null : 'got ' + got + '   want ' + wantString);
}
function notTested(label, why) {
  skipped++;
  console.log('  NOT TESTED  ' + label + '\n          ' + why);
}
function report() {
  console.log('\n' + '='.repeat(72));
  console.log('passed ' + passed + '   failed ' + failed + '   not tested ' + skipped);
  if (failures.length) {
    console.log('\nFAILURES');
    for (const f of failures) console.log('  [' + f.group + '] ' + f.label + (f.detail ? ' — ' + f.detail : ''));
  }
  console.log('='.repeat(72));
  return failed === 0;
}

module.exports = { section, ok, eq, eqMoney, notTested, report, counts: () => ({ passed, failed, skipped }) };
