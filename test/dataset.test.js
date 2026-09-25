/* The shared dataset.
 *
 * The defect: `state.previews` reached only the forecast screen, while
 * Expenses, Profitability and Reconciliation each opened with
 * `if (!state.ledger) return needLedger(...)`. An imported preview was parsed,
 * stored and listed, and every one of those screens rendered nothing from it.
 *
 * These tests hold the two branches apart and assert that a screen can read
 * whichever one exists, without either borrowing from the other.
 */
const T = require('./harness.js');
const Dataset = require('../lib/dataset.js');
const Preview = require('../lib/preview.js');
const Ledger = require('../lib/ledger.js');
const CSV = require('../lib/csv.js');

/* ── fixture: the fee hierarchy is the part that is easy to get wrong ────── */

const HEADER = [
  'Amazon store', 'Start date', 'End date', 'Parent ASIN', 'ASIN', 'FNSKU', 'MSKU',
  'Currency code', 'Average sales price', 'Units sold', 'Units returned', 'Net units sold',
  'Sales', 'Net sales',
  'Referral fee per unit', 'Referral fee quantity', 'Referral fee total',
  'FBA fulfillment fees per unit', 'FBA fulfillment fees quantity', 'FBA fulfillment fees total',
  'Base fulfillment fee per unit', 'Base fulfillment fee quantity', 'Base fulfillment fee total',
  'Low-inventory-level fee per unit', 'Low-inventory-level fee quantity',
  'Low-inventory-level fee total',
  'Monthly inventory storage fee per unit', 'Monthly inventory storage fee quantity',
  'Monthly inventory storage fee total',
  'Sponsored Products charge per unit', 'Sponsored Products charge quantity',
  'Sponsored Products charge total',
].join(',');

/* Two SKUs. Net sales 1000; referral 150; FBA PARENT 200 with parts 180 + 30
   (which overshoot the parent by 10, exactly as the real files do); storage 40;
   advertising 60. */
function previewCsv(start, end, scale) {
  const k = scale == null ? 1 : scale;
  const n = v => (v * k).toFixed(2);
  const line = (msku, netSales, ref, fba, base, low, stor, ads) =>
    ['US', start, end, 'BP', 'B' + msku, 'X' + msku, msku, 'USD', '25.00', '10', '0', '10',
      n(netSales), n(netSales), '1.5', '10', n(ref), '2.0', '10', n(fba),
      '1.8', '10', n(base), '0.3', '10', n(low), '0.4', '10', n(stor), '0.6', '10', n(ads)].join(',');
  return '﻿' + HEADER + '\n'
    + line('SKU-A', 600, 90, 120, 108, 18, 24, 36) + '\n'
    + line('SKU-B', 400, 60, 80, 72, 12, 16, 24) + '\n';
}

const parse = (start, end, scale) =>
  Preview.parse(previewCsv(start || '09/17/2026', end || '09/30/2026', scale), { name: 'f.csv' });

/* ── the forecast branch ─────────────────────────────────────────────────── */

T.section('A preview alone produces a complete forecast branch');
{
  const ds = Dataset.build({ previews: [parse()], ledger: null, inputs: {} });
  const f = ds.forecast;

  T.ok('the branch is present', f.present);
  T.eq('period comes from the rows', f.period.from + '..' + f.period.to, '2026-09-17..2026-09-30');
  T.eq('units are summed', f.units.sold, 20);
  T.eqMoney('net sales', f.netSales, '1,000.00');
  T.eq('products are counted', f.skuCount, 2);
  T.eq('currency is carried', f.currency, 'USD');
  T.eq('marketplace is carried', f.store, 'US');
}

T.section('Fee parents count once; their components never add on top');
{
  const f = Dataset.build({ previews: [parse()], ledger: null }).forecast;

  /* referral 150 + FBA parent 200 + storage 40 = 390. If the components were
     added the total would be 570, and storage would double. */
  T.eqMoney('total is parents only', f.feeTotal, '390.00');
  T.eqMoney('advertising is excluded from that total', f.advertising, '60.00');
  T.eqMoney('storage uses the parent', f.storage, '40.00');

  const base = f.fees.find(x => x.name === 'Base fulfillment fee');
  const low = f.fees.find(x => x.name === 'Low-inventory-level fee');
  const fba = f.fees.find(x => x.name === 'FBA fulfillment fees');
  T.ok('components are marked non-additive', base.nonAdditive && low.nonAdditive,
    JSON.stringify([base.nonAdditive, low.nonAdditive]));
  T.ok('the parent is not', !fba.nonAdditive, String(fba.nonAdditive));
  T.eq('and the parent is what counts', fba.countedInTotal, true);

  /* The parts overshoot the parent by 10.00 in this fixture, as in the real
     files. Both are reported; neither is adjusted to match the other. */
  T.eqMoney('parent total is Amazon’s own', fba.total, '200.00');
  T.eqMoney('parts sum to something else, untouched', base.total + low.total, '210.00');
}

T.section('Order economics stop where per-order economics stop');
{
  const f = Dataset.build({ previews: [parse()], ledger: null }).forecast;
  /* referral 150 + FBA parent 200 = 350; storage and advertising are period
     charges and are NOT in the per-order figure. */
  T.eqMoney('order fees exclude period charges', f.orderFees, '350.00');
  T.eqMoney('net receivable is net sales less order fees', f.netReceivable, '650.00');
}

T.section('Per-product figures back the Profitability screen');
{
  const f = Dataset.build({ previews: [parse()], ledger: null }).forecast;
  T.eq('one row per product', f.bySku.length, 2);
  const a = f.bySku.find(r => r.msku === 'SKU-A');
  T.eqMoney('its net sales', a.netSales, '600.00');
  T.eqMoney('its order fees', a.orderFees, '210.00');
  T.eqMoney('its contribution before product cost', a.contribution, '390.00');
  T.eqMoney('its advertising is kept separate', a.advertising, '36.00');
  T.eq('products are ordered by net sales', f.bySku[0].msku, 'SKU-A');
}

T.section('Several files combine into one branch');
{
  const ds = Dataset.build({
    previews: [parse('09/17/2026', '09/30/2026'), parse('10/01/2026', '10/15/2026')],
    ledger: null,
  });
  T.eqMoney('net sales add up', ds.forecast.netSales, '2,000.00');
  T.eq('the period spans both', ds.forecast.period.from + '..' + ds.forecast.period.to,
    '2026-09-17..2026-10-15');
  T.eq('both files are listed', ds.forecast.files.length, 2);
}

T.section('A window filter includes a file whole or not at all');
{
  const previews = [parse('09/17/2026', '09/30/2026'), parse('12/01/2026', '12/15/2026')];
  const ds = Dataset.build({
    previews, ledger: null,
    forecastWindow: { from: '2026-09-01', to: '2026-10-31' },
  });
  T.eq('only the overlapping file is used', ds.forecast.files.length, 1);
  T.eq('the other is reported as excluded, not dropped silently', ds.forecast.excluded, 1);
  T.eqMoney('and no partial window total is invented', ds.forecast.netSales, '1,000.00');
}

/* ── the two branches stay apart ─────────────────────────────────────────── */

T.section('Forecast and actual never borrow from each other');
{
  const ds = Dataset.build({ previews: [parse()], ledger: null });
  T.eq('with no ledger the actual branch is absent', ds.actual.present, false);
  T.ok('but the dataset still reports data', ds.anyData);
  T.eq('and nothing was promoted into the actual branch',
    ds.actual.netRevenue === undefined, true);

  const empty = Dataset.build({ previews: [], ledger: null });
  T.eq('with nothing at all, forecast is absent', empty.forecast.present, false);
  T.eq('and the dataset says so', empty.anyData, false);
}

/* ── readiness ───────────────────────────────────────────────────────────── */

T.section('Readiness blocks only the features that are actually blocked');
{
  const ds = Dataset.build({ previews: [parse()], ledger: null, inputs: {} });
  const byId = {};
  for (const r of ds.readiness) byId[r.id] = r;

  T.eq('forecast sales and fees are ready from the preview alone',
    byId['forecast-sales'].ready, true);
  T.eq('actual fees are not', byId['actual-expenses'].ready, false);
  T.eq('the payout amount is not', byId['payout-amount'].ready, false);
  T.eq('bank arrival is not', byId['bank-arrival'].ready, false);

  T.ok('and each blocked item names what it needs',
    ds.readiness.filter(r => !r.ready).every(r => r.needs.length > 0),
    JSON.stringify(ds.readiness.filter(r => !r.ready && !r.needs.length).map(r => r.id)));

  T.eq('a balance unblocks the payout amount and nothing else',
    Dataset.build({ previews: [parse()], ledger: null, inputs: { hasBalance: true } })
      .readiness.filter(r => r.ready).map(r => r.id).sort().join(','),
    'forecast-sales,payout-amount');

  T.eq('bank arrival needs deposits specifically',
    byId['bank-arrival'].needs[0].label,
    'bank deposit history to measure transit from');
}

T.section('Readiness is honest when nothing is loaded');
{
  const ds = Dataset.build({ previews: [], ledger: null, inputs: {} });
  T.eq('nothing claims to be ready', Dataset.ready(ds.readiness).length, 0);
  T.eq('and everything in use is blocked - the optional transaction-history features are not counted',
    Dataset.blocking(ds.readiness).length, ds.readiness.filter(r => !r.optional).length);
}

/* ── the actual branch ───────────────────────────────────────────────────── */

const PAY_PREAMBLE = '"Includes Amazon Marketplace transactions"\n"All amounts in USD"';

function paymentsCsv() {
  const cols = CSV.PAYMENTS_COLUMNS.map(c => '"' + c + '"').join(',');
  const row = (date, sales, selling, fba) =>
    ['"' + date + '"', '"1001"', '"Order"', '"111-1"', '"SKU-A"', '"A widget"', '"1"',
      '"amazon.com"', '"Standard Orders"', '"Amazon"', '"D"', '"CO"', '"80204"', '"MF"',
      '"' + sales + '"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"', '"0"',
      '"' + selling + '"', '"' + fba + '"', '"0"', '"0"',
      '"' + (Number(sales) + Number(selling) + Number(fba)).toFixed(2) + '"',
      '"Released"', '"Sep 24, 2026 12:00:00 AM PDT"'].join(',');
  return '﻿' + PAY_PREAMBLE + '\n' + cols + '\n'
    + row('Sep 17, 2026 12:06:05 AM PDT', '100.00', '-15.00', '-20.00') + '\n'
    + row('Sep 18, 2026 3:12:00 PM PDT', '200.00', '-30.00', '-40.00') + '\n';
}

T.section('The actual branch reads the transaction export');
{
  const led = Ledger.create(100);
  Ledger.importText(led, paymentsCsv(), { name: 'p.csv' });
  const ds = Dataset.build({ previews: [], ledger: led, filter: {} });

  T.ok('the branch is present', ds.actual.present);
  T.eq('rows are counted', ds.actual.rowCount, 2);
  T.eq('the period comes from the rows',
    ds.actual.period.from + '..' + ds.actual.period.to, '2026-09-17..2026-09-18');
  T.eqMoney('charges are summed', ds.actual.grossCharges, '105.00');
  T.ok('categories are returned for the expenses table', ds.actual.categories.length > 0,
    String(ds.actual.categories.length));
  T.eq('actual fees are now ready',
    ds.readiness.find(r => r.id === 'actual-expenses').ready, true);
  T.eq('but forecast sales are not, with no preview',
    ds.readiness.find(r => r.id === 'forecast-sales').ready, false);
}

T.section('Both sources together keep both branches');
{
  const led = Ledger.create(100);
  Ledger.importText(led, paymentsCsv(), { name: 'p.csv' });
  const ds = Dataset.build({ previews: [parse()], ledger: led, filter: {} });
  T.ok('forecast is present', ds.forecast.present);
  T.ok('actual is present', ds.actual.present);
  T.eqMoney('forecast figures are unchanged by the ledger', ds.forecast.netSales, '1,000.00');
  T.eqMoney('actual figures are unchanged by the preview', ds.actual.grossCharges, '105.00');
  T.eq('and both features report ready',
    [ds.readiness.find(r => r.id === 'forecast-sales').ready,
      ds.readiness.find(r => r.id === 'actual-expenses').ready].join(','), 'true,true');
}

/* ── absent columns are unknown, never zero ──────────────────────────────── */

T.section('A fee family with no column is absent, not zero');
{
  const slim = ['Amazon store', 'Start date', 'End date', 'Parent ASIN', 'ASIN', 'FNSKU', 'MSKU',
    'Currency code', 'Average sales price', 'Units sold', 'Units returned', 'Net units sold',
    'Sales', 'Net sales'].join(',');
  const csv = '﻿' + slim + '\n'
    + 'US,09/17/2026,09/30/2026,BP,B1,X1,SKU-A,USD,25.00,10,0,10,600.00,600.00\n';
  const f = Dataset.build({ previews: [Preview.parse(csv, { name: 's.csv' })] }).forecast;

  const storage = f.fees.find(x => x.name === 'Monthly inventory storage fee');
  T.eq('the column is reported absent', storage.columnPresent, false);
  T.eq('its total is null, not 0', storage.total, null);
  T.eq('the storage figure is unavailable', f.storage, null);
  T.eqMoney('and net sales still reads', f.netSales, '600.00');
}

/* ── the same forecast downloaded on three days counts once ──────────────── */

T.section('Overlapping forecast downloads are versions, not additions');
{
  const head = ['Amazon store', 'Start date', 'End date', 'Parent ASIN', 'ASIN', 'FNSKU', 'MSKU',
    'Currency code', 'Average sales price', 'Units sold', 'Units returned', 'Net units sold',
    'Sales', 'Net sales'].join(',');
  const file = (from, to, net, name, cur) => Preview.parse('﻿' + head + '\n'
    + 'US,' + from + ',' + to + ',BP,B1,X1,SKU-A,' + (cur || 'USD') + ',25.00,10,0,10,' + net + ',' + net + '\n',
    { name });
  /* The shape in the bug report: a rolling eight-week window, fetched daily. */
  const d24 = file('09/25/2026', '11/18/2026', '193652.04', 'mon.csv');
  const d25 = file('09/25/2026', '11/19/2026', '198321.65', 'tue.csv');
  const d26 = file('09/26/2026', '11/20/2026', '196510.62', 'wed.csv');
  const three = Dataset.build({ previews: [d24, d25, d26] }).forecast;
  T.eqMoney('three overlapping downloads count once - the newest', three.netSales, '196,510.62');
  const act = Preview.active([d24, d25, d26]);
  T.eq('the newest is the one starting latest', act.files.map(f => f.name).join(','), 'wed.csv');
  T.eq('the older two are kept, marked as replaced', act.superseded.map(s => s.file.name + '>' + s.by.name).join(','),
    'tue.csv>wed.csv,mon.csv>wed.csv');
  /* Separate windows are separate estimates, and all of them count. */
  const sep = file('09/17/2026', '09/30/2026', '100.00', 'sep.csv');
  const oct = file('10/01/2026', '10/15/2026', '200.00', 'oct.csv');
  T.eqMoney('windows that do not overlap all count', Dataset.build({ previews: [sep, oct] }).forecast.netSales, '300.00');
  const cad = file('09/26/2026', '11/20/2026', '50.00', 'cad.csv', 'CAD');
  T.eq('a different currency never replaces one', Preview.active([d26, cad]).files.length, 2);
  T.eq('importing an older window later does not undo a newer one',
    Preview.active([d26, d24]).files.map(f => f.name).join(','), 'wed.csv');
}

process.exit(T.report() ? 0 : 1);
