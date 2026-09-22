/* Import and display path.
 *
 * The defect this suite exists to prevent: a file that parsed perfectly and was
 * stored correctly produced an empty screen, because the forecast required the
 * transaction history before it would show anything at all. A valid report must
 * show what it supports, and an invalid one must say why.
 *
 * Every fixture is built inline, so the suite runs anywhere node does and does
 * not depend on an export sitting in someone's Downloads folder.
 */
const T = require('./harness.js');
const CSV = require('../lib/csv.js');
const Preview = require('../lib/preview.js');
const Forecast = require('../lib/forecast.js');
const Ledger = require('../lib/ledger.js');
const Money = require('../lib/money.js');

const BOM = '﻿';

/* ── fixtures ──────────────────────────────────────────────────────────── */

const PREVIEW_HEADER = [
  'Amazon store', 'Start date', 'End date', 'Parent ASIN', 'ASIN', 'FNSKU', 'MSKU',
  'Currency code', 'Average sales price', 'Units sold', 'Units returned', 'Net units sold',
  'Sales', 'Net sales',
  'Referral fee per unit', 'Referral fee quantity', 'Referral fee total',
  'FBA fulfillment fees per unit', 'FBA fulfillment fees quantity', 'FBA fulfillment fees total',
  'Monthly inventory storage fee per unit', 'Monthly inventory storage fee quantity',
  'Monthly inventory storage fee total',
  'Sponsored Products charge per unit', 'Sponsored Products charge quantity',
  'Sponsored Products charge total',
].join(',');

/* One window, two SKUs. Net sales 1000, referral 150, FBA 200 -> receivable 650. */
function previewCsv(opts) {
  opts = opts || {};
  const start = opts.start || '10/01/2026';
  const end = opts.end || '10/31/2026';
  const line = (msku, netSales, referral, fba, storage, ads) =>
    ['US', start, end, 'BP1', 'B1', 'X1', msku, 'USD', '25.00', '10', '0', '10',
      netSales, netSales, '1.5', '10', referral, '2.0', '10', fba,
      '0.1', '10', storage, '0.5', '10', ads].join(',');
  return (opts.bom === false ? '' : BOM) + PREVIEW_HEADER + '\n'
    + line('MSKU-A', '600.00', '90.00', '120.00', '30.00', '40.00') + '\n'
    + line('MSKU-B', '400.00', '60.00', '80.00', '20.00', '25.00') + '\n';
}

const PAYMENTS_PREAMBLE = [
  '"Includes Amazon Marketplace, Fulfillment by Amazon (FBA), and Amazon Webstore transactions"',
  '"All amounts in USD, unless specified"',
  '"Definitions:"',
  '"date/time: posted date/time of the transaction"',
].join('\n');

/* `withAccountType: false` reproduces the Monthly Transaction export, which
   omits that column entirely. */
function paymentsCsv(opts) {
  opts = opts || {};
  const withAcct = opts.withAccountType !== false;
  const cols = ['date/time', 'settlement id', 'type', 'order id', 'sku', 'description',
    'quantity', 'marketplace'];
  if (withAcct) cols.push('account type');
  cols.push('fulfillment', 'order city', 'order state', 'order postal', 'tax collection model',
    'product sales', 'product sales tax', 'shipping credits', 'shipping credits tax',
    'gift wrap credits', 'giftwrap credits tax', 'Regulatory Fee', 'Tax On Regulatory Fee',
    'promotional rebates', 'promotional rebates tax', 'marketplace withheld tax',
    'selling fees', 'fba fees', 'other transaction fees', 'other', 'total',
    'Transaction Status', 'Transaction Release Date');

  const row = (date, sales, selling, fba, release) => {
    const f = ['"' + date + '"', '"1001"', '"Order"', '"111-1"', '"SKU-1"', '"A widget"',
      '"1"', '"amazon.com"'];
    if (withAcct) f.push('"Standard Orders"');
    f.push('"Amazon"', '"DENVER"', '"CO"', '"80204"', '"MarketplaceFacilitator"',
      '"' + sales + '"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"',
      '"' + selling + '"', '"' + fba + '"', '"0"', '"0"',
      '"' + (Number(sales) + Number(selling) + Number(fba)).toFixed(2) + '"',
      '"Released"', '"' + release + '"');
    return f.join(',');
  };

  return BOM + PAYMENTS_PREAMBLE + '\n'
    + cols.map(c => '"' + c + '"').join(',') + '\n'
    + row('Jul 1, 2026 12:06:05 AM PDT', '100.00', '-15.00', '-20.00', 'Jul 8, 2026 12:00:00 AM PDT') + '\n'
    + row('Jul 2, 2026 3:12:00 PM PDT', '200.00', '-30.00', '-40.00', 'Jul 9, 2026 12:00:00 AM PDT') + '\n';
}

/* ── detection ─────────────────────────────────────────────────────────── */

T.section('Source detection');
{
  const det = CSV.detect(CSV.parse(previewCsv()));
  T.eq('preview is recognised through a BOM', det.family, 'preview');
  T.eq('preview header is on the first line', det.headerIndex, 0);

  const pdet = CSV.detect(CSV.parse(paymentsCsv()));
  T.eq('payments is recognised behind a preamble', pdet.family, 'payments');
  T.eq('payments header line is found, not assumed', pdet.headerIndex, 4);

  const none = CSV.detect(CSV.parse('name,score\nAda,99\n'));
  T.eq('an unrelated CSV matches no family', none.family, null);
}

/* ── a preview asked for with only SOME options ────────────────────────── */

T.section('A preview export missing whole option groups');
{
  /* Which columns a preview carries depends on the tick boxes chosen on
     Amazon's page. A report asked for with only the fulfilment options has no
     sales columns at all - no "Net sales", no "Units sold".
     Detection used to insist on "Net sales", so such a file was refused as
     "not a Fees & Economics Preview export" and 208 rows of real fulfilment
     fees were discarded because one unrelated box had not been ticked. */
  const head = 'Amazon store,Start date,End date,Parent ASIN,ASIN,FNSKU,MSKU,'
    + 'Base fulfillment fee per unit,Base fulfillment fee quantity,'
    + 'Base fulfillment fee total,Currency code,FBA fulfillment fees per unit,'
    + 'FBA fulfillment fees quantity,FBA fulfillment fees total';
  const row = 'US,09/22/2026,10/05/2026,B09SNYTD55,B09SNQKKDM,X003YEH5NP,'
    + 'SKU-1,5.92,2,11.84,USD,6.13,2,12.26';
  const feesOnly = CSV.detect(CSV.parse(head + '\n' + row + '\n'));
  T.eq('fees without any sales columns is still a preview',
    feesOnly.family, 'preview');

  /* The other way round: sales chosen, no fee options. */
  const salesHead = 'Amazon store,Start date,End date,Parent ASIN,ASIN,FNSKU,'
    + 'MSKU,Currency code,Average sales price,Units sold,Net sales';
  const salesOnly = CSV.detect(CSV.parse(
    salesHead + '\nUS,09/22/2026,10/05/2026,A,B,C,SKU-1,USD,10.00,3,30.00\n'));
  T.eq('sales without any fee columns is still a preview',
    salesOnly.family, 'preview');

  /* But the identifying columns are still required, and so is having
     SOMETHING to read. An empty shell is not a report. */
  const shell = CSV.detect(CSV.parse(
    'Amazon store,Start date,End date,Parent ASIN,ASIN,FNSKU,MSKU,Currency code'
    + '\nUS,09/22/2026,10/05/2026,A,B,C,SKU-1,USD\n'));
  T.eq('identity columns with no data column is not a preview',
    shell.family, null);

  const noIdentity = CSV.detect(CSV.parse(
    'Amazon store,MSKU,Net sales,a,b,c,d,e\nUS,SKU-1,30.00,1,2,3,4,5\n'));
  T.eq('a file without the identifying columns is not a preview',
    noIdentity.family, null);

  /* And it parses, reporting which families it has and which it has not. */
  const parsed = Preview.parse(head + '\n' + row + '\n');
  T.eq('the partial file parses', parsed.rows.length, 1);
  T.eq('and names the fee families it does carry',
    parsed.families.filter(f => f.present).map(f => f.name).join(', '),
    'Base fulfillment fee, FBA fulfillment fees');
  T.eq('while the rest are absent, not zero',
    parsed.families.filter(f => !f.present).length > 0, true);
}

/* ── preview parsing, and what it reports about itself ─────────────────── */

T.section('Preview import reports its own outcome');
{
  const p = Preview.parse(previewCsv(), { name: 'fixture.csv' });
  T.eq('rows accepted', p.rowsAccepted, 2);
  T.eq('rows processed', p.rowsProcessed, 2);
  T.eq('nothing rejected in a clean file', p.rejected.length, 0);
  T.eq('period start', p.period.start, '2026-10-01');
  T.eq('period end', p.period.end, '2026-10-31');
  T.eq('marketplace', p.store, 'US');
  T.eq('currency', p.currency, 'USD');
  T.eq('header line is recorded', p.headerLine, 1);
  T.ok('a BOM does not become part of the first column name',
    p.header[0] === 'Amazon store', 'got ' + JSON.stringify(p.header[0]));
}

T.section('Rejected rows are counted and explained');
{
  const csv = previewCsv()
    + 'US,10/01/2026,10/31/2026,BP1,B1,X1,,USD,1,1,0,1,5,5,0,0,0,0,0,0,0,0,0,0,0,0\n'
    + 'US,short,row\n';
  const p = Preview.parse(csv, { name: 'fixture.csv' });
  T.eq('accepted excludes the bad rows', p.rowsAccepted, 2);
  T.eq('processed counts every row that was looked at', p.rowsProcessed, 4);
  T.eq('two rows rejected', p.rejected.length, 2);
  T.eq('a blank MSKU is reported as such', p.rejected[0].reason, 'No MSKU');
  T.eq('its source line is kept', p.rejected[0].line, 4);
  T.eq('a truncated row is reported as such', p.rejected[1].reason, 'Too few columns');
  T.ok('the rejection appears in the file issues',
    p.issues.some(i => i.indexOf('not imported') >= 0), p.issues.join(' | '));
}

T.section('An unusable file explains itself rather than throwing a bare error');
{
  let msg = null, rejected = null;
  try {
    Preview.parse(BOM + PREVIEW_HEADER + '\n', { name: 'header-only.csv' });
  } catch (e) { msg = e.message; rejected = e.rejected; }
  T.ok('a header with no rows is refused', msg != null);
  T.ok('and the message says what was wrong',
    msg && msg.indexOf('no row carried an MSKU') >= 0, msg);
  T.ok('the rejection list travels with the error', Array.isArray(rejected), String(rejected));
}

/* ── the defect itself ─────────────────────────────────────────────────── */

T.section('A preview alone produces a forecast');
{
  const p = Preview.parse(previewCsv(), { name: 'fixture.csv' });
  const from = '2026-09-17', to = CSV.addDays(from, 55);
  const fc = Forecast.build({
    previewFiles: [p], from, to,
    accountMix: null, releaseLags: new Map(), weekdayWeights: null,
    scenario: 'base', cutoff: from, knownAt: '2026-09-17T00:00:00.000Z',
  });

  T.ok('a forecast is returned without any transaction history', !!fc);
  T.eq('it is flagged as economics-only', fc.economicsOnly, true);
  T.eq('every covered day carries an estimate', fc.dailyEconomics.length, 31);
  T.eq('coverage counts only the days a preview backs', fc.coverage.coveredDays, 31);

  /* net sales 1000.00 − referral 150.00 − FBA 200.00 = 650.00 */
  const net = fc.dailyEconomics.reduce((s, d) => s + (d.netReceivable || 0), 0);
  T.eqMoney('net receivable uses fee parents only', net, '650.00');

  T.ok('and it says the payout schedule is what is missing',
    fc.limitations.some(l => l.kind === 'no-cash-timing'),
    fc.limitations.map(l => l.kind).join(', '));
  T.eq('no release events are invented without a measured lag',
    fc.events.filter(e => e.kind === 'new_available').length, 0);
}

T.section('The daily split sums exactly to the window total');
{
  const p = Preview.parse(previewCsv(), { name: 'fixture.csv' });
  const from = '2026-10-01', to = '2026-10-31';
  const fc = Forecast.build({
    previewFiles: [p], from, to, accountMix: null, releaseLags: new Map(),
    weekdayWeights: null, scenario: 'base', cutoff: from, knownAt: '2026-10-01T00:00:00.000Z',
  });
  const net = fc.dailyEconomics.reduce((s, d) => s + (d.netReceivable || 0), 0);
  T.eqMoney('no cent is created or lost across 31 days', net, '650.00');
}

T.section('A window outside the horizon is covered by nothing, not by a guess');
{
  const p = Preview.parse(previewCsv({ start: '01/01/2028', end: '01/31/2028' }),
    { name: 'far-future.csv' });
  const from = '2026-09-17', to = CSV.addDays(from, 55);
  const fc = Forecast.build({
    previewFiles: [p], from, to, accountMix: null, releaseLags: new Map(),
    weekdayWeights: null, scenario: 'base', cutoff: from, knownAt: '2026-09-17T00:00:00.000Z',
  });
  T.eq('no days are produced', fc.dailyEconomics.length, 0);
  T.eq('the whole horizon is reported as a gap', fc.coverage.coveredDays, 0);
  T.ok('the gap is stated', fc.limitations.some(l => l.kind === 'coverage-gap'),
    fc.limitations.map(l => l.kind).join(', '));
}

T.section('With history, the same preview gains dated release events');
{
  const p = Preview.parse(previewCsv(), { name: 'fixture.csv' });
  const from = '2026-09-17', to = CSV.addDays(from, 55);
  const lags = new Map([['Standard Orders', { median: 7, p10: 5, p90: 9 }]]);
  const fc = Forecast.build({
    previewFiles: [p], from, to,
    accountMix: { shares: { 'Standard Orders': 1 }, basis: 'test', origin: 'MODEL FORECAST' },
    releaseLags: lags, weekdayWeights: null,
    scenario: 'base', cutoff: from, knownAt: '2026-09-17T00:00:00.000Z',
  });
  T.eq('it is no longer economics-only', fc.economicsOnly, false);
  T.ok('release events are produced',
    fc.events.filter(e => e.kind === 'new_available').length === 31,
    'got ' + fc.events.filter(e => e.kind === 'new_available').length);
  const released = fc.events.filter(e => e.kind === 'new_available')
    .reduce((s, e) => s + e.amount, 0);
  T.eqMoney('and they carry the whole receivable, unchanged', released, '650.00');
}

/* ── the transaction export ────────────────────────────────────────────── */

T.section('Payments import: preamble, optional columns, and controls');
{
  const led = Ledger.create(100);
  const rec = Ledger.importText(led, paymentsCsv(), { name: 'unified.csv' });
  T.eq('rows imported', rec.rowCount, 2);
  T.eq('the preamble is kept as evidence', rec.preamble.length, 4);
  T.eq('the header line is recorded', rec.headerLine, 5);
  T.eq('every row balances to its total', led.control.componentSumMismatch, 0);
  T.eq('date range comes from the rows', led.dateRange().from, '2026-07-01');

  const mix = Forecast.accountMix(led, {});
  T.ok('the account split is measured when the column is there',
    mix && Math.abs(mix.shares['Standard Orders'] - 1) < 1e-9,
    JSON.stringify(mix && mix.shares));
}

T.section('A transaction export with no "account type" column still imports');
{
  const led = Ledger.create(100);
  const rec = Ledger.importText(led, paymentsCsv({ withAccountType: false }),
    { name: 'monthly.csv' });
  T.eq('rows still import', rec.rowCount, 2);
  T.eq('every row still balances', led.control.componentSumMismatch, 0);
  T.ok('the absent column is reported rather than silently mapped',
    rec.schema.missing.indexOf('account type') >= 0,
    JSON.stringify(rec.schema.missing));
}

T.section('A file with a header and nothing under it imports nothing');
{
  const led = Ledger.create(100);
  const cols = CSV.PAYMENTS_COLUMNS.map(c => '"' + c + '"').join(',');
  const rec = Ledger.importText(led, BOM + PAYMENTS_PREAMBLE + '\n' + cols + '\n',
    { name: 'empty.csv' });
  T.eq('no rows are claimed', rec.rowCount, 0);
  T.eq('and the ledger stays empty', led.rowCount, 0);
}

T.section('A half-built forecast is never applied to a balance');
{
  const p = Preview.parse(previewCsv(), { name: 'fixture.csv' });
  const from = '2026-09-17', to = CSV.addDays(from, 55);
  const fc = Forecast.build({
    previewFiles: [p], from, to, accountMix: null, releaseLags: new Map(),
    weekdayWeights: null, scenario: 'base', cutoff: from, knownAt: '2026-09-17T00:00:00.000Z',
  });

  /* The preview DOES yield a storage charge; that is the trap. Applying it
     without the matching receipts walks a recorded balance down for costs
     while no sales ever land. */
  const charges = fc.events.filter(e => e.kind === 'charge');
  T.ok('the preview still produces its period charge', charges.length === 1,
    'got ' + charges.length);
  T.eq('and no receipts to set against it',
    fc.events.filter(e => e.kind === 'new_available').length, 0);
  T.eq('so the run is marked economics-only for the caller to refuse',
    fc.economicsOnly, true);

  const Cash = require('../lib/cash.js');
  const build = apply => {
    const engine = Cash.createEngine({
      account: 'Standard Orders', currency: 'USD', cutoff: '2026-09-17',
      policy: Cash.emptyPolicy(),
    });
    engine.setOpening({
      available: 3000000, deferred: 200000, reserve: 0,
      asOf: '2026-09-17', includesActivityThrough: '2026-09-17', source: 'test',
    });
    if (apply) for (const ev of fc.events) engine.add(ev);
    return engine.run({ requests: [{ date: '2026-11-01', mode: 'all_eligible' }] });
  };

  /* The fixture's storage is 30.00 + 20.00 = 50.00, and that is the whole of
     the movement: costs, with no sales behind them. */
  T.eqMoney('applying one side alone walks the balance down by the charge',
    build(true).bridges[0].eligible, '29,950.00');
  T.eqMoney('so the balance is carried forward untouched instead',
    build(false).bridges[0].eligible, '30,000.00');
}

process.exit(T.report() ? 0 : 1);
