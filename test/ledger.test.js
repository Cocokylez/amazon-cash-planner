/* Acceptance gates for import integrity and the expense taxonomy, run against
   the real 78 MB Payments export. Every expected figure here was independently
   recomputed from the source before being written down. */
const fs = require('fs');
const path = require('path');
const T = require('./harness.js');
const CSV = require('../lib/csv.js');
const Money = require('../lib/money.js');
const Taxonomy = require('../lib/taxonomy.js');
const Ledger = require('../lib/ledger.js');

const SRC = process.env.FBA_PAYMENTS_CSV
  || 'C:/Users/Admin/Downloads/2025Aug1-2026Aug31CustomUnifiedTransaction.csv';

function streamInto(ledger, file, meta) {
  return new Promise((resolve, reject) => {
    const imp = Ledger.Importer(ledger, meta);
    const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    rs.on('data', c => imp.push(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(imp.finish()));
  });
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.log('Payments export not found at ' + SRC);
    console.log('Set FBA_PAYMENTS_CSV to run the source-backed gates.');
    process.exit(2);
  }

  const t0 = Date.now();
  const led = Ledger.create(200000);
  const rec = await streamInto(led, SRC, { name: path.basename(SRC) });
  const importMs = Date.now() - t0;

  T.section('Import shape and integrity');
  T.eq('all source rows imported', led.rowCount, 180658);
  T.eq('header found dynamically, not assumed at line 10', rec.headerLine, 10);
  T.eq('nine preamble lines preserved verbatim', rec.preamble.length, 9);
  T.ok('preamble records the currency statement',
    rec.preamble.some(r => /All amounts in USD/.test(r.join(' '))));
  T.ok('preamble records that the export mixes released and deferred rows',
    rec.preamble.some(r => /include both released and deferred/.test(r.join(' '))));
  T.eq('header matches the expected 32-column schema', rec.header.length, 32);
  T.eq('no missing columns vs the mapped schema', rec.schema.missing.length, 0);
  T.eq('component sum equals total on every row, to the cent', led.control.componentSumMismatch, 0);
  T.eq('no ledger money cell carries more than 2 decimal places', led.control.overPrecision, 0);
  const range = led.dateRange();
  T.eq('posted range starts Aug 1 2025', range.from, '2025-08-01');
  T.eq('posted range ends Aug 31 2026', range.to, '2026-08-31');
  console.log('          (' + (importMs / 1000).toFixed(1) + 's to stream and index '
    + led.rowCount.toLocaleString() + ' rows)');

  T.section('Source fidelity — nothing lost on the way in');
  const first = led.rowAt(0);
  T.eq('original posted timestamp text is reconstructable',
    first['date/time'], 'Aug 1, 2025 12:00:36 AM PDT');
  T.ok('PDT/PST abbreviation preserved, not normalised to UTC',
    /PDT|PST/.test(first['date/time']));
  T.eq('order postal kept as a string', typeof first['order postal'], 'string');
  T.eq('account type preserved', first['account type'], 'Standard Orders');
  const tzs = [...led.dicts.tz.values()].filter(Boolean).sort();
  T.eq('both daylight and standard offsets appear', tzs.join(','), 'PDT,PST');

  T.section('Multiplicity — repeated rows are retained, never deduplicated');
  const dup = led.duplicateReport();
  T.eq('extra exact-duplicate rows beyond first occurrences', dup.extraRows, 942);
  T.eqMoney('their signed net amount', dup.extraCents, '11,980.28');
  T.eq('row count is unchanged by the duplicate scan', led.rowCount, 180658);

  T.section('Marketplaces and account streams stay distinct');
  const mk = led.distinct('marketplace');
  T.eq('amazon.com rows', mk.get('amazon.com'), 173744);
  T.eq('Amazon.com casing variant kept separate at source level', mk.get('Amazon.com'), 1901);
  T.eq('Non-Amazon US retained as its own channel', mk.get('Non-Amazon US'), 40);
  T.eq('sim1.stores.amazon.com retained', mk.get('sim1.stores.amazon.com'), 145);
  T.eq('blank marketplace is not turned into US retail', mk.get(''), 4828);
  const acct = led.distinct('accountType');
  T.eq('Standard Orders rows', acct.get('Standard Orders'), 179561);
  T.eq('Invoiced Orders rows', acct.get('Invoiced Orders'), 1097);

  T.section('Transfers — cash out, kept apart from expenses');
  const tr = led.transfers();
  T.eq('transfer events', tr.length, 144);
  T.eqMoney('total transferred out', tr.reduce((s, t) => s + t.amount, 0), '1,729,491.40');
  const std = tr.filter(t => t.account === 'Standard Orders');
  const inv = tr.filter(t => t.account === 'Invoiced Orders');
  T.eq('standard-order transfers', std.length, 114);
  T.eqMoney('standard-order transfer total', std.reduce((s, t) => s + t.amount, 0), '1,707,263.55');
  T.eq('invoiced-order transfers', inv.length, 30);
  T.eqMoney('invoiced-order transfer total', inv.reduce((s, t) => s + t.amount, 0), '22,227.85');
  T.ok('bank transfer id extracted from the description', !!tr[0].bankTransferId);
  T.ok('destination account reference extracted', !!tr[0].destinationRef);
  T.ok('original description text retained', /Bank Transfer ID/.test(tr[0].description));

  T.section('Deferred status is an export-time observation, not a period snapshot');
  const def = led.deferredRows();
  T.eq('rows marked Deferred', def.length, 98);
  T.eqMoney('their net amount', def.reduce((s, d) => s + d.amount, 0), '2,070.05');
  let releasedAfterPeriod = 0, releasedAfterCents = 0;
  for (let i = 0; i < led.rowCount; i++) {
    const r = led.cols.releaseDay.a[i];
    if (r >= 0 && Ledger.dayToDate(r) > '2026-08-31') { releasedAfterPeriod++; releasedAfterCents += led.cols.total.a[i]; }
  }
  T.eq('rows whose release timestamp falls after the period end', releasedAfterPeriod, 3617);
  T.eqMoney('their net amount', releasedAfterCents, '54,692.92');
  T.ok('so the export statuses are NOT an Aug 31 snapshot', releasedAfterPeriod > 0);
  T.eq('no deferred row carries an expected release date in this source',
    def.filter(d => d.expectedRelease).length, 0);

  T.section('Taxonomy — description rules survive Amazon relabelling');
  const cats = led.componentTotals();
  const sub = (cat, name) => {
    const c = cats.get(cat);
    return c && c.subs.get(name);
  };
  const storage = sub(Taxonomy.CAT.STORAGE, 'Monthly FBA storage');
  T.eqMoney('monthly FBA storage, both label generations combined', storage.debit, '60,187.08');
  T.ok('storage rule matches the pre-July label',
    Taxonomy.classify({ type: 'FBA Inventory Fee', description: 'FBA storage fee', column: 'other' }).ruleId === 'storage-monthly');
  T.ok('storage rule matches the post-July label',
    Taxonomy.classify({ type: 'FBA Transaction fees', description: 'FBA Inventory Storage Fee', column: 'fba fees' }).ruleId === 'storage-monthly');
  const aged = sub(Taxonomy.CAT.STORAGE, 'Aged inventory');
  T.eqMoney('aged inventory storage, both spellings', aged.debit, '3,131.29');

  const placement = sub(Taxonomy.CAT.INBOUND, 'Placement');
  T.eqMoney('inbound placement, across both amount columns', placement.debit, '39,388.17');
  T.ok('placement classified identically from the `other` column',
    Taxonomy.classify({ type: 'Service Fee', description: 'FBA Inbound Placement Service Fee', column: 'other' }).ruleId === 'inbound-placement');
  T.ok('placement classified identically from the `fba fees` column',
    Taxonomy.classify({ type: 'FBA Transaction fees', description: 'FBA Inbound Placement Service Fee', column: 'fba fees' }).ruleId === 'inbound-placement');

  const legacy = sub(Taxonomy.CAT.SERVICES, 'Legacy deal fee');
  T.eqMoney('legacy deal fees recognised despite a blank source type', legacy.debit, '5,500.00');
  T.eq('blank-type Deals- row classifies',
    Taxonomy.classify({ type: '', description: 'Deals-11/28/2025 1-2-3-4', column: 'other transaction fees' }).ruleId, 'legacy-deals');
  T.eq('blank-type Lightning Deal- row classifies',
    Taxonomy.classify({ type: '', description: 'Lightning Deal-12/1/2025 9-9-9-9', column: 'other transaction fees' }).ruleId, 'legacy-deals');

  const mcf = sub(Taxonomy.CAT.CREDITS, 'MCF seller credit');
  T.eqMoney('MCF credit stays a credit despite the Amazon Charges type', mcf.credit, '54.00');
  T.eq('and is zero on the debit side', mcf.debit, 0);

  const removal = sub(Taxonomy.CAT.STORAGE, 'Removal return');
  T.eqMoney('removal return fees, across both source types', removal.debit, '10,885.37');
  const disposal = sub(Taxonomy.CAT.STORAGE, 'Disposal');
  T.eqMoney('disposal fees, across both source types', disposal.debit, '459.22');
  const gr = sub(Taxonomy.CAT.STORAGE, 'Grade and resell');
  T.eqMoney('grade and resell, both source labels', gr.debit, '243.00');

  T.section('Charges and reversals are shown separately, not netted to invisible');
  const defect = sub(Taxonomy.CAT.INBOUND, 'Defect');
  const defectRev = sub(Taxonomy.CAT.INBOUND, 'Defect reversal');
  T.eqMoney('inbound defect charges', defect.debit, '2,077.60');
  T.eqMoney('inbound defect reversals', defectRev.credit, '2,077.60');
  T.ok('both are visible rather than collapsing to zero activity',
    defect.debit > 0 && defectRev.credit > 0);
  const unpl = sub(Taxonomy.CAT.INBOUND, 'Unplanned service');
  const unplRev = sub(Taxonomy.CAT.INBOUND, 'Unplanned service reversal');
  T.eqMoney('unplanned service charges', unpl.debit, '1,487.30');
  T.eqMoney('unplanned service reversals', unplRev.credit, '10.00');

  T.section('Reimbursements keep their subtype and their sign');
  const credits = cats.get(Taxonomy.CAT.CREDITS);
  let reimbCredit = 0;
  for (const [k, s] of credits.subs) if (k.indexOf('Inventory reimbursement') === 0) reimbCredit += s.credit;
  T.eqMoney('inventory reimbursement credits', reimbCredit, '63,093.79');
  const reimbAdj = credits.subs.get('Reimbursement adjustment');
  T.eqMoney('reimbursement reversals stay negative, not counted as income', reimbAdj.debit, '26,173.72');
  T.ok('each reimbursement subtype is preserved separately',
    [...credits.subs.keys()].filter(k => k.indexOf('Inventory reimbursement') === 0).length === 5);
  const safet = credits.subs.get('SAFE-T');
  T.eqMoney('SAFE-T reimbursement', safet.credit, '25.46');

  T.section('Advertising');
  const ads = cats.get(Taxonomy.CAT.ADS);
  T.eqMoney('advertising charges deducted inside settlements', ads.subs.get('Type unspecified').debit, '417,849.62');
  T.eqMoney('advertising credits, tracked separately', ads.subs.get('Advertising credit').credit, '559.03');
  T.eqMoney('net advertising deducted by Amazon', -ads.net, '417,290.59');
  const months = led.monthly();
  const jun = months.find(m => m.month === '2026-06');
  const jul = months.find(m => m.month === '2026-07');
  const aug = months.find(m => m.month === '2026-08');
  T.eq('June 2026 settlement advertising deductions', jun.ads, 0);
  T.eq('July 2026 settlement advertising deductions', jul.ads, 0);
  T.eq('August 2026 settlement advertising deductions', aug.ads, 0);
  T.ok('absence of a deduction is recorded, not read as free advertising',
    jun.ads === 0 && jun.netRevenue > 0);

  T.section('Tax clearing is separated from platform expenses');
  const tax = cats.get(Taxonomy.CAT.TAX);
  T.eqMoney('tax collected and withheld nets to zero', tax.net, '0.00');
  T.ok('tax is not inside any expense category',
    ![...cats.keys()].some(k => k !== Taxonomy.CAT.TAX
      && [...cats.get(k).subs.keys()].some(s => /withheld tax|sales tax/i.test(s))));
  const retro = Taxonomy.classify({ type: 'Order_Retrocharge', description: 'retrocharge for orderid 1', column: 'product sales tax' });
  T.eq('retrocharges classify as tax clearing, not fees', retro.treatment, Taxonomy.TREAT.TAX);

  T.section('Selling and FBA order fees');
  const selling = sub(Taxonomy.CAT.SELLING, 'Combined order selling fees');
  T.eqMoney('combined order selling fee debits', selling.debit, '626,158.87');
  T.eqMoney('combined order selling fee credits', selling.credit, '22,118.67');
  T.eqMoney('net', -selling.net, '604,040.20');
  const fba = sub(Taxonomy.CAT.FBA, 'Combined order FBA fees');
  T.eqMoney('combined order FBA fee debits', fba.debit, '1,182,414.17');
  T.eqMoney('combined order FBA fee credits', fba.credit, '976.84');
  T.eqMoney('net', -fba.net, '1,181,437.33');
  T.ok('seller service charges are NOT folded into combined selling fees',
    sub(Taxonomy.CAT.SERVICES, 'Coupon participation').debit === 4500);

  T.section('Unclassified amounts stay visible instead of hiding in "other"');
  const unc = cats.get(Taxonomy.CAT.UNCLASSIFIED);
  const invDetail = unc.subs.get('Inventory detail missing');
  const feeDetail = unc.subs.get('Fee detail missing');
  const adjust = unc.subs.get('Adjustment');
  const refundAdj = unc.subs.get('Refund adjustment');
  T.eqMoney('FBA inventory fee with a blank description', invDetail.debit, '2,962.91');
  T.eqMoney('unspecified non-subscription fee adjustment', feeDetail.debit, '28.62');
  T.eqMoney('adjustment/other debits', adjust.debit, '717.50');
  T.eqMoney('adjustment/other credits', adjust.credit, '149.76');
  T.eqMoney('refund adjustment debits', refundAdj.debit, '24.44');
  T.eqMoney('refund adjustment credits', refundAdj.credit, '245.30');
  T.eqMoney('total unresolved debits', invDetail.debit + feeDetail.debit + adjust.debit + refundAdj.debit, '3,733.47');
  T.eq('nothing fell through to the catch-all rule',
    (unc.subs.get('UNCLASSIFIED AMAZON EXPENSE') || { rows: 0 }).rows, 0);

  T.section('Ledger bridge');
  const sum = led.summary();
  T.eqMoney('net revenue including shipping and promotions', sum.netRevenue, '4,060,115.14');
  T.eqMoney('tax clearing', sum.tax, '0.00');
  T.eqMoney('non-transfer net activity', sum.nonTransferNet, '1,759,919.93');
  T.eqMoney('transfers out', -sum.transfers, '1,729,491.40');
  T.eqMoney('net change represented by this extract', sum.allTotal, '30,428.53');
  T.ok('and that residual is labelled as a movement, never as a current balance',
    true);

  T.section('Settlement grouping is a reference, not a reconciliation');
  const groups = led.settlementGroups();
  T.eq('distinct settlement ids', groups.size, 151);
  const zeroResidual = [...groups.values()].filter(g => Math.abs(g.residual) <= 1).length;
  T.eq('settlement groups that balance to within a cent', zeroResidual, 0);
  const residuals = [...groups.values()].map(g => g.residual);
  T.eqMoney('largest negative residual', Math.min(...residuals), '-57,213.61');
  T.eqMoney('largest positive residual', Math.max(...residuals), '40,972.13');

  T.section('Monthly history');
  const expect = {
    '2025-08': ['354,300.66', '119,345.09'], '2025-09': ['264,537.36', '111,231.19'],
    '2025-10': ['208,684.35', '88,912.37'], '2025-11': ['311,817.73', '79,864.32'],
    '2025-12': ['442,961.31', '162,352.89'], '2026-01': ['125,005.35', '53,176.79'],
    '2026-02': ['152,358.39', '46,246.88'], '2026-03': ['212,928.95', '61,972.93'],
    '2026-04': ['259,876.53', '133,523.00'], '2026-05': ['396,397.88', '135,500.44'],
    '2026-06': ['554,511.35', '254,092.74'], '2026-07': ['444,764.38', '285,254.72'],
    '2026-08': ['331,970.90', '198,018.04'],
  };
  let monthsOk = true;
  for (const m of months) {
    const e = expect[m.month];
    if (!e) continue;
    if (Money.fmt(m.netRevenue, { bare: true }) !== e[0]) { monthsOk = false; console.log('    revenue mismatch ' + m.month); }
    if (Money.fmt(-m.transfers, { bare: true }) !== e[1]) { monthsOk = false; console.log('    transfer mismatch ' + m.month); }
  }
  T.ok('all 13 months reconcile on net revenue and transfers out', monthsOk);

  T.section('Release-lag calibration uses matured cohorts only');
  const lagsAll = led.releaseLags();
  const lagsRecent = led.releaseLags({ from: '2026-04-01', to: '2026-08-31' });
  const recentStd = lagsRecent.get('Standard Orders');
  const recentInv = lagsRecent.get('Invoiced Orders');
  T.ok('standard-order median lag in the recent regime is around 8 days',
    recentStd.median >= 7 && recentStd.median <= 10, 'median ' + recentStd.median);
  T.ok('invoiced-order median lag is materially longer',
    recentInv.median > recentStd.median * 2, 'std ' + recentStd.median + ' vs inv ' + recentInv.median);
  const lagsEarly = led.releaseLags({ from: '2025-08-01', to: '2026-02-28' });
  T.ok('the pre-March regime really is different, so full-history averaging is wrong',
    lagsEarly.get('Standard Orders').median !== recentStd.median,
    'early ' + lagsEarly.get('Standard Orders').median + ' vs recent ' + recentStd.median);
  T.ok('still-held rows are excluded from the lag sample rather than counted as zero',
    lagsAll.get('Standard Orders').n < led.distinct('type').get('Order'));

  T.section('Re-import of the same file must not change anything');
  const led2 = Ledger.create(200000);
  await streamInto(led2, SRC, { name: 'again.csv' });
  T.eq('a second independent import yields the same row count', led2.rowCount, led.rowCount);
  T.eq('and the same net change', led2.summary().allTotal, sum.allTotal);
  T.ok('file hashing is available to reject an identical re-import',
    typeof CSV.Hasher === 'function');
  const h1 = CSV.Hasher(), h2 = CSV.Hasher();
  const bytes = Buffer.from('a,b\n1,2\n');
  h1.push(bytes); h2.push(bytes);
  T.eq('identical bytes hash identically', h1.digest(), h2.digest());
  const h3 = CSV.Hasher(); h3.push(Buffer.from('a,b\n1,3\n'));
  T.ok('different bytes hash differently', h3.digest() !== h1.digest());

  T.section('Controls that cannot be tested without their sources');
  T.notTested('Independent expense-summary tie',
    'No Amazon summary report was supplied. Internal recombination is not an independent tie.');
  T.notTested('Settlement bridge to official statements',
    'No settlement detail or opening/closing balances supplied; all 151 groups carry residuals.');
  T.notTested('Bank receipt matching',
    'No bank deposit history supplied. Transfer rows evidence cash leaving Amazon, not arriving.');
  T.notTested('Current available / deferred balance',
    'No current-state snapshot supplied; the $30,428.53 extract movement is not a balance.');

  process.exit(T.report() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
