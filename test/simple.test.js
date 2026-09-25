/* The forecast of sales and fees, from tomorrow to a chosen date.
   Fictional figures only. */
const T = require('./harness.js');
const Preview = require('../lib/preview.js');
const Simple = require('../lib/simple.js');

const HEAD = ['Amazon store', 'Start date', 'End date', 'Parent ASIN', 'ASIN', 'FNSKU', 'MSKU',
  'Currency code', 'Average sales price', 'Units sold', 'Units returned', 'Net units sold',
  'Sales', 'Net sales',
  'Referral fee per unit', 'Referral fee quantity', 'Referral fee total',
  'FBA fulfillment fees per unit', 'FBA fulfillment fees quantity', 'FBA fulfillment fees total',
  'Sponsored Products charge per unit', 'Sponsored Products charge quantity', 'Sponsored Products charge total',
].join(',');
/* rows: [msku, units, net, referral, fba, ads] */
const file = (from, to, rows, name) => Preview.parse('﻿' + HEAD + '\n'
  + rows.map(r => ['US', from, to, 'P', 'A-' + r[0], 'F', r[0], 'USD', '10.00', r[1], 0, r[1],
    r[2], r[2], '1.00', r[1], r[3], '2.00', r[1], r[4], '0.50', r[1], r[5]].join(',')).join('\n') + '\n',
  { name: name || 'f.csv' });

/* A 10-day download: $1,000 net sales, $150 referral, $200 FBA, $50 ads. */
const ten = file('10/01/2026', '10/10/2026', [['SKU-A', 60, '600.00', '90.00', '120.00', '30.00'],
  ['SKU-B', 40, '400.00', '60.00', '80.00', '20.00']], 'oct.csv');

T.section('The dates of the download: Amazon’s own figures');
{
  const f = Simple.forecastFor([ten], '2026-10-01', '2026-10-10');
  T.ok('it is exact', f.exact === true);
  T.eqMoney('net sales', f.netSales, '1,000.00');
  T.eqMoney('Amazon fees, parents only', f.feeTotal, '350.00');
  T.eqMoney('advertising, kept apart', f.advertising, '50.00');
  T.eqMoney('after fees', f.afterFees, '650.00');
  T.eqMoney('after fees and ads', f.afterFeesAndAds, '600.00');
  T.eq('units', f.units, 100);
  T.eq('each fee is listed, biggest first', f.fees.map(x => x.name).join(','), 'FBA fulfillment fees,Referral fee');
  T.eq('products, by sales', f.bySku.map(x => x.msku).join(','), 'SKU-A,SKU-B');
  T.eqMoney('a product’s net after fees and ads', f.bySku[0].net, '360.00');
  T.eq('every day is covered', f.coveredDays + '/' + f.days, '10/10');
}

T.section('Part of a download: split evenly by day, and said to be');
{
  const f = Simple.forecastFor([ten], '2026-10-01', '2026-10-05');
  T.ok('it is not exact', f.exact === false);
  T.eqMoney('half the days, half the sales', f.netSales, '500.00');
  T.eqMoney('and half the fees', f.feeTotal, '175.00');
  T.eq('and the units', f.units, 50);
}

T.section('Days beyond what is downloaded are named, never filled');
{
  const f = Simple.forecastFor([ten], '2026-10-05', '2026-10-14');
  T.eq('six days covered of ten', f.coveredDays + '/' + f.days, '6/10');
  T.eq('the gap is 11 to 14 October', f.gaps.map(g => g.from + '..' + g.to).join(','), '2026-10-11..2026-10-14');
  T.eqMoney('only the covered days count', f.netSales, '600.00');
  T.eq('and it is not called exact', f.exact, false);
  T.eq('it knows how far the download goes', f.loadedTo, '2026-10-10');
  const none = Simple.forecastFor([], '2026-10-01', '2026-10-10');
  T.eq('with nothing loaded, nothing is claimed', [none.netSales, none.coveredDays].join(','), ',0');
}

T.section('Week by week adds up to the total');
{
  const f = Simple.forecastFor([ten], '2026-10-01', '2026-10-10');
  T.eq('1-10 Oct 2026 spans two weeks (Mon 28 Sep, Mon 5 Oct)', f.weeks.map(w => w.week + ':' + w.days).join(','),
    '2026-09-28:4,2026-10-05:6');
  T.eq('the weeks sum to the total', f.weeks.reduce((s, w) => s + w.netSales, 0), f.netSales);
}

T.section('The same forecast downloaded twice counts once');
{
  const again = file('10/01/2026', '10/10/2026', [['SKU-A', 66, '660.00', '99.00', '132.00', '33.00']], 'oct-again.csv');
  const f = Simple.forecastFor([ten, again], '2026-10-01', '2026-10-10');
  T.eqMoney('only the newest counts', f.netSales, '660.00');
  T.eq('and the older is reported as replaced', f.superseded, 1);
}

T.section('Day by day, for the chart: whole cents that add back exactly');
{
  const sum = (a, k) => a.reduce((s, e) => s + (e[k] || 0), 0);
  /* 3 of 10 days: $300.00 over 3 days, and an odd amount that does not divide */
  const odd = file('10/01/2026', '10/07/2026', [['SKU-A', 7, '100.00', '10.01', '0.00', '0.00']], 'odd.csv');
  const f = Simple.forecastFor([odd], '2026-10-01', '2026-10-07');
  T.eq('one entry per day', f.daily.length, 7);
  T.eq('net sales per day add to the total', sum(f.daily, 'netSales'), f.netSales);
  T.eq('fees per day add to the total, odd cents and all', sum(f.daily, 'fees'), f.feeTotal);
  T.ok('every day is whole cents', f.daily.every(e => Number.isInteger(e.netSales) && Number.isInteger(e.fees)));
  const g = Simple.forecastFor([ten], '2026-10-08', '2026-10-13');
  T.eq('days past the download are marked, not filled', g.daily.map(e => e.covered ? 1 : 0).join(''), '111000');
  T.ok('and carry nothing', g.daily.slice(3).every(e => e.netSales == null));
  T.eq('the covered days add to the total', sum(g.daily, 'netSales'), g.netSales);
}

T.section('The chart reads what the tiles say');
{
  const Charts = require('../lib/charts.js');
  const f = Simple.forecastFor([ten], '2026-10-01', '2026-10-12');
  const run = Charts.forecastItems(f.daily, { metric: 'netSales', mode: 'running', mondayOf: Simple.mondayOf });
  T.eq('a running total per day', run.items.length, 12);
  T.eq('ends at the net sales tile', run.items[run.items.length - 1].v, f.netSales);
  T.eq('and stays level across days with no forecast', run.items[11].v, run.items[9].v);
  T.ok('which are marked as gaps', run.items[10].gap && run.items[11].gap && !run.items[9].gap);
  const last = run.items[run.items.length - 1].rows;
  T.eq('the reading gives all four, fees and ads as costs',
    last.map(r => r[1]).join(','), [f.netSales, -f.feeTotal, -f.advertising, f.afterFeesAndAds].join(','));
  T.eq('with the picked one marked', last.map(r => r[2] ? 1 : 0).join(''), '1000');
  const wk = Charts.forecastItems(f.daily, { metric: 'after', mode: 'weekly', mondayOf: Simple.mondayOf });
  T.eq('weekly: one entry per week (28 Sep, 5 Oct, 12 Oct)', wk.items.length, 3);
  T.ok('the week with nothing downloaded is a gap, not zero', wk.items[2].gap && wk.items[2].v == null);
  T.eq('the weeks add to the after-fees tile', wk.items.reduce((s, x) => s + (x.v || 0), 0), f.afterFeesAndAds);
  const html = Charts.forecast(f.daily, { metric: 'fees', mode: 'running', mondayOf: Simple.mondayOf });
  T.ok('it draws, with a reading to hover', /class="fchart"/.test(html) && /data-fc=/.test(html)
    && /fc-tip/.test(html));
  T.ok('and shades the days with nothing downloaded', /url\(#fc-gap\)/.test(html));
  T.ok('with nothing downloaded it says so and draws nothing',
    /Nothing to draw yet/.test(Charts.forecast(Simple.forecastFor([], '2026-10-01', '2026-10-05').daily)));
}

process.exit(T.report() ? 0 : 1);
