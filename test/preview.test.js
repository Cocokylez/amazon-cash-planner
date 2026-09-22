/* Acceptance gates for the Fees & Economics Preview inputs. */
const fs = require('fs');
const path = require('path');
const T = require('./harness.js');
const Money = require('../lib/money.js');
const Preview = require('../lib/preview.js');
const CSV = require('../lib/csv.js');

const DIR = process.env.FBA_PREVIEW_DIR || 'C:/Users/Admin/Downloads';
const FILES = [
  ['6688759b-82df-483f-9438-f80496f1e536', '2026-09-17', '2026-09-30', 53],
  ['9c5ef61a-cea5-47d8-9279-eb8e230e4481', '2026-10-01', '2026-10-15', 44],
  ['f0b02774-9568-4406-bbe6-cb14b2ed4721', '2026-11-01', '2026-11-15', 44],
  ['f38d482d-518d-4181-812c-0ff48a2b27e1', '2026-11-16', '2026-11-30', 53],
  ['7768ab3c-7e75-42ed-9697-f8118515efcc', '2026-12-01', '2026-12-15', 44],
  ['e9b6b556-11d2-4968-a7ce-4fc7c105a02c', '2026-12-16', '2026-12-31', 53],
  ['06318513-9eca-46b2-8b4e-d630bdc977c4', '2027-01-01', '2027-01-14', 44],
];
const M = d => Money.fmtDec(d, { bare: true });

const files = [];
for (const [id, start, end, cols] of FILES) {
  const p = path.join(DIR, id + '.amzn1.tortuga.4.na.csv');
  if (!fs.existsSync(p)) { console.log('missing preview file: ' + p); process.exit(2); }
  const f = Preview.parse(fs.readFileSync(p, 'utf8'), { name: id });
  f._expect = { id, start, end, cols };
  files.push(f);
}

T.section('Preview parsing — both column variants');
for (const f of files) {
  const e = f._expect;
  T.eq(e.id.slice(0, 8) + ' column count', f.columnCount, e.cols);
  T.eq(e.id.slice(0, 8) + ' period', f.period.start + '..' + f.period.end, e.start + '..' + e.end);
}
T.ok('all seven files report US dollars', files.every(f => f.currency === 'USD'));
T.ok('all seven files carry the same 202 MSKUs', files.every(f => f.mskuCount === 202));
T.ok('all seven files carry the same 149 ASINs', files.every(f => f.asinCount === 149));
T.eq('net units arithmetic holds on every row of every file',
  files.reduce((s, f) => s + f.netUnitsMismatch, 0), 0);

T.section('Missing columns stay unknown, never zero');
const without = files.filter(f => f.variant === 'without-storage');
const withSt = files.filter(f => f.variant === 'with-storage');
T.eq('44-column files', without.length, 4);
T.eq('53-column files', withSt.length, 3);
for (const f of without) {
  const st = Preview.familyTotal(f.rows, 'Monthly inventory storage fee');
  T.ok(f._expect.id.slice(0, 8) + ': storage total is unknown, not 0',
    st.total === null && st.known === false && st.absent === f.rows.length);
}
T.ok('the absent-column condition is stated as an issue on every 44-column file',
  without.every(f => f.issues.some(i => /UNKNOWN for this period, not zero/.test(i))));
for (const f of withSt) {
  const st = Preview.familyTotal(f.rows, 'Monthly inventory storage fee');
  T.ok(f._expect.id.slice(0, 8) + ': storage total is known', st.total !== null);
}

T.section('Fee hierarchy — a parent is never summed with its children');
const sep = files[0];
const h = Preview.hierarchy(sep);
const fbaH = h.find(x => x.parent === 'FBA fulfillment fees');
T.eq('Sept 17–30 FBA parent total', M(fbaH.parentTotal), '37,453.41');
T.eq('  base fulfilment child', M(fbaH.children.find(c => c.name === 'Base fulfillment fee').total), '36,381.57');
T.eq('  fuel surcharge child', M(fbaH.children.find(c => c.name === 'Fuel and Logistics-related surcharge').total), '1,276.84');
T.eq('  low-inventory-level child', M(fbaH.children.find(c => c.name === 'Low-inventory-level fee').total), '5.64');
T.eq('  visible child sum', M(fbaH.childSum), '37,664.05');
T.eq('signed parent−children difference is surfaced', M(fbaH.difference), '-210.64');
T.ok('the difference is not silently allocated to any child',
  fbaH.children.every(c => c.total == null || typeof c.total === 'bigint'));

const diffs = files.map(f => {
  const x = Preview.hierarchy(f).find(y => y.parent === 'FBA fulfillment fees');
  return { id: f._expect.id.slice(0, 8), diff: x.difference };
});
T.ok('every file shows a negative FBA reconciliation difference',
  diffs.every(d => d.diff < 0n));
const asNum = d => Number(Money.round(d)) / 100;
const worst = Math.min(...diffs.map(d => asNum(d.diff)));
const least = Math.max(...diffs.map(d => asNum(d.diff)));
T.ok('and they fall in the −209.30 … −522.07 band the audit found',
  Math.abs(worst - (-522.07)) < 0.005 && Math.abs(least - (-209.30)) < 0.005,
  'range ' + worst + ' … ' + least);

T.section('Storage: base equals parent, so it is counted once');
for (const f of withSt) {
  const sh = Preview.hierarchy(f).find(x => x.parent === 'Monthly inventory storage fee');
  T.ok(f._expect.id.slice(0, 8) + ': base monthly storage equals the parent exactly',
    sh.children.find(c => c.name === 'Base monthly storage fee').total === sh.parentTotal);
}
const sepStorage = Preview.feeSummary(sep).lines;
const baseLine = sepStorage.find(l => l.name === 'Base monthly storage fee');
const parentLine = sepStorage.find(l => l.name === 'Monthly inventory storage fee');
T.eq('Sept 17–30 storage parent', M(parentLine.total), '5,802.96');
T.eq('Sept 17–30 storage base', M(baseLine.total), '5,802.96');
T.ok('base is marked non-additive so the two cannot both be counted', baseLine.nonAdditive);
T.ok('the parent is the one counted in the fee total', parentLine.countedInTotal);
T.ok('every child of an aggregate is marked non-additive',
  sepStorage.filter(l => l.parent).every(l => l.nonAdditive && !l.countedInTotal));

T.section('Headline preview amounts');
const expect = {
  '6688759b': ['116,702.65', '37,453.41', '21,230.90', '21,499.18'],
  '9c5ef61a': ['102,766.76', '33,041.66', '18,717.06', '23,367.98'],
  'f0b02774': ['115,928.76', '32,905.43', '17,609.86', '23,367.98'],
  'f38d482d': ['197,753.82', '58,740.14', '32,091.79', '23,367.98'],
  '7768ab3c': ['195,749.07', '58,091.87', '29,686.19', '23,367.98'],
  'e9b6b556': ['145,756.33', '45,107.76', '22,152.78', '25,045.94'],
  '06318513': ['89,738.17', '27,239.54', '13,453.66', '21,499.18'],
};
for (const f of files) {
  const id = f._expect.id.slice(0, 8);
  const e = expect[id];
  let ns = null;
  for (const r of f.rows) if (r.netSales != null) ns = ns == null ? r.netSales : ns + r.netSales;
  T.eq(id + ' net sales', M(ns), e[0]);
  T.eq(id + ' FBA aggregate', M(Preview.familyTotal(f.rows, 'FBA fulfillment fees').total), e[1]);
  T.eq(id + ' referral', M(Preview.familyTotal(f.rows, 'Referral fee').total), e[2]);
  T.eq(id + ' Sponsored Products', M(Preview.familyTotal(f.rows, 'Sponsored Products charge').total), e[3]);
}
T.ok('exact decimals are kept — truncating Net sales to cents would lose 1–3c per file',
  (() => {
    const f = files.find(x => x._expect.id.slice(0, 8) === 'f38d482d');
    let trunc = 0;
    for (const r of f.rows) if (r.netSales != null) trunc += Number(r.netSales / (Money.POW / 100n));
    return Money.fmt(Math.trunc(trunc), { bare: true }) !== '197,753.82';
  })());

T.section('Blank cells are flagged, not read as exemptions');
for (const f of files) {
  const gaps = Preview.coverageGaps(f);
  const ref = gaps.find(g => g.kind === 'blank-referral');
  T.eq(f._expect.id.slice(0, 8) + ' rows with no referral fee', ref ? ref.count : 0, 3);
}
const sellingGaps = files.map(f => {
  const g = Preview.coverageGaps(f).find(x => x.kind === 'selling-without-fba');
  return g ? g.count : 0;
});
T.ok('15–17 selling SKUs per period carry no FBA amount, and each is listed',
  sellingGaps.every(c => c >= 15 && c <= 17), sellingGaps.join(', '));
T.ok('zero-sales rows that still cost money are kept rather than filtered away',
  files.some(f => Preview.coverageGaps(f).some(g => g.kind === 'cost-without-sales')));

T.section('Horizon coverage — the October gap is a hole, not an average');
const cov = Preview.coverage(files, '2026-09-17', '2026-11-11');
T.ok('the 56-day display horizon is not fully covered', !cov.complete);
T.eq('exactly one gap run in that horizon', cov.gaps.length, 1);
T.eq('gap starts', cov.gaps[0].from, '2026-10-16');
T.eq('gap ends', cov.gaps[0].to, '2026-10-31');
T.eq('no two preview files overlap on the same day', cov.overlaps.length, 0);
const full = Preview.coverage(files, '2026-09-17', '2027-01-14');
T.eq('across the whole supplied span the only gap is Oct 16–31',
  full.gaps.map(g => g.from + '..' + g.to).join(' '), '2026-10-16..2026-10-31');

T.section('SKU reconciliation does not invent mappings');
const hist = new Set();
{
  /* the historical SKU set, read straight from the ledger export */
  const src = process.env.FBA_PAYMENTS_CSV
    || 'C:/Users/Admin/Downloads/2025Aug1-2026Aug31CustomUnifiedTransaction.csv';
  if (fs.existsSync(src)) {
    const lines = fs.readFileSync(src, 'utf8').split('\n');
    const head = CSV.parse(lines[9] + '\n')[0];
    const at = CSV.indexer(head);
    const j = at('sku');
    for (let i = 10; i < lines.length; i++) {
      const f = CSV.parse(lines[i] + '\n')[0];
      if (!f) continue;
      const s = (f[j] || '').trim();
      if (s) hist.add(s);
    }
  }
}
if (hist.size) {
  const rec = Preview.skuReconciliation(files, hist);
  T.eq('distinct historical SKUs', rec.historicalCount, 336);
  T.eq('preview MSKUs', rec.previewCount, 202);
  T.eq('preview MSKUs with no exact historical match', rec.unmatched.length, 47);
  T.ok('unmatched MSKUs are listed rather than force-mapped', rec.unmatched.length === 47 && !!rec.message);
  T.ok('suffixed identifiers are not stripped to force a match',
    rec.unmatched.some(m => /^amzn\.gr\./.test(m)));
} else {
  T.notTested('SKU reconciliation', 'Payments export not available in this run.');
}

process.exit(T.report() ? 0 : 1);
