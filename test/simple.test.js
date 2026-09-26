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
  const run = Charts.forecastItems(f.daily, { metrics: ['netSales'], mode: 'running', mondayOf: Simple.mondayOf });
  const end = run.items[run.items.length - 1];
  T.eq('a running total per day', run.items.length, 12);
  T.eq('ends at the net sales tile', end.vs.netSales, f.netSales);
  T.eq('and stays level across days with no forecast', run.items[11].vs.netSales, run.items[9].vs.netSales);
  T.ok('which are marked as gaps', run.items[10].gap && run.items[11].gap && !run.items[9].gap);
  T.eq('the reading gives all four to date, fees and ads as costs',
    run.items[9].rows.map(r => r[2]).join(','), [f.netSales, -f.feeTotal, -f.advertising, f.afterFeesAndAds].join(','));
  T.eq('and each one for that day', run.items[0].rows[0][1], f.daily[0].netSales);
  T.eq('a day with no forecast reads as nothing that day', run.items[11].rows[0][1], null);
  T.eq('with the picked one marked', end.rows.map(r => r[3] ? 1 : 0).join(''), '1000');

  const two = Charts.forecastItems(f.daily, { metrics: ['fees', 'netSales'], mode: 'running' });
  T.eq('several at once, in the tiles\u2019 order', two.measures.map(m => m.key).join(','), 'netSales,fees');
  T.eq('each plotted to its own total', [two.items[11].vs.netSales, two.items[11].vs.fees].join(','),
    [f.netSales, f.feeTotal].join(','));
  T.eq('both marked in the reading', two.items[0].rows.map(r => r[3] ? 1 : 0).join(''), '1100');
  const none = Charts.forecastItems(f.daily, { metrics: [], mode: 'running' });
  T.eq('with none picked, net sales is shown rather than nothing', none.measures.map(m => m.key).join(), 'netSales');

  const wk = Charts.forecastItems(f.daily, { metrics: ['after'], mode: 'weekly', mondayOf: Simple.mondayOf });
  T.eq('weekly: one entry per week (28 Sep, 5 Oct, 12 Oct)', wk.items.length, 3);
  T.ok('the week with nothing downloaded is a gap, not zero', wk.items[2].gap && wk.items[2].vs.after == null);
  T.eq('the weeks add to the after-fees tile', wk.items.reduce((s, x) => s + (x.vs.after || 0), 0), f.afterFeesAndAds);

  const html = Charts.forecast(f.daily, { metrics: ['fees'], mode: 'running', mondayOf: Simple.mondayOf });
  T.ok('it draws, with a reading to hover', /class="fchart"/.test(html) && /data-fc=/.test(html)
    && /fc-tip/.test(html));
  T.ok('and shades the days with nothing downloaded', /url\(#fc-gap\)/.test(html));
  const all = Charts.forecast(f.daily, { metrics: ['netSales', 'fees', 'advertising', 'after'], mode: 'running' });
  T.eq('all four: four lines and a legend', [(all.match(/stroke-width="2.5" stroke-linejoin/g) || []).length,
    /class="legend"/.test(all)].join(','), '4,true');
  const bars = Charts.forecast(f.daily, { metrics: ['netSales', 'fees'], mode: 'weekly', mondayOf: Simple.mondayOf });
  T.eq('weekly with two: side by side, two bars a covered week', (bars.match(/<path d="M[^"]*" fill="var\(--mark-[12]\)"/g) || []).length, 4);
  T.ok('with nothing downloaded it says so and draws nothing',
    /Nothing to draw yet/.test(Charts.forecast(Simple.forecastFor([], '2026-10-01', '2026-10-05').daily)));
}

T.section('What each product\u2019s fees are made of');
{
  /* 10 days: SKU-A $600 net, $90 referral, $120 FBA, $30 ads */
  const f = Simple.forecastFor([ten], '2026-10-01', '2026-10-10');
  const a = f.bySku.find(r => r.msku === 'SKU-A');
  T.eqMoney('referral, for this product', a.feeBy['Referral fee'], '90.00');
  T.eqMoney('FBA fulfilment, for this product', a.feeBy['FBA fulfillment fees'], '120.00');
  T.eqMoney('its fees are the kinds added up', a.fees, '210.00');
  T.eq('the products\u2019 fees add to the Amazon fees tile', f.bySku.reduce((s, r) => s + (r.fees || 0), 0), f.feeTotal);
  const half = Simple.forecastFor([ten], '2026-10-01', '2026-10-05').bySku.find(r => r.msku === 'SKU-A');
  T.eqMoney('part of a download: each kind split by day too', half.feeBy['FBA fulfillment fees'], '60.00');
}

T.section('Where net sales go: the bars say what the tiles say');
{
  const Charts = require('../lib/charts.js');
  const html = Charts.spend([{ label: 'All products', netSales: 100000, parts: [
    { name: 'FBA fulfillment fees', amount: 30000 }, { name: 'Referral fee', amount: 15000 },
    { name: 'Advertising', amount: 5000 }] }], { share: true, currency: 'USD' });
  T.eq('one piece per cost, and one for what is left', (html.match(/class="sp-seg"/g) || []).length, 4);
  T.ok('each piece reads out its amount and share', /Left after fees and ads/.test(html) && /50\.0%/.test(html));
  const loss = Charts.spend([{ label: 'SKU-X', netSales: 10000, parts: [{ name: 'FBA fulfillment fees', amount: 15000 }] }],
    { share: true, label: true, currency: 'USD' });
  T.ok('a product that costs more than it sells says so', /loses \$50\.00/.test(loss));
  T.ok('with nothing left to show', !/data-tip="[^"]*Left after fees and ads&quot;,&quot;\$50/.test(loss));
  const Money = require('../lib/money.js');
  T.eq('money reads with its sign', [Money.fmt(97461, { currency: 'USD' }), Money.fmt(-31851, { currency: 'USD' }),
    Money.fmt(-31851, { currency: 'CAD' }), Money.fmt(100, { currency: 'SEK' })].join(' '),
    '$974.61 -$318.51 -CA$318.51 SEK 1.00');
  T.eq('and short, on the axes', [Money.fmtShort(5000000, 'USD'), Money.fmtShort(-1500000, 'MXN')].join(' '),
    '$50k -MX$15k');
  const noSales = Charts.spend([{ label: 'SKU-Y', netSales: 0, parts: [{ name: 'Monthly inventory storage fee', amount: 1200 }] }],
    { share: true, label: true, currency: 'USD' });
  T.ok('fees with no sales are named, not drawn as a share', /No sales on these dates/.test(noSales));
  T.ok('nothing at all: said, not drawn', /Nothing to show/.test(Charts.spend([], {})));
}

T.section('Fees against net sales, day by day: every line adds back to its total');
{
  const Charts = require('../lib/charts.js');
  const f = Simple.forecastFor([ten], '2026-10-01', '2026-10-12');
  const all = Simple.seriesFor(f, null);
  const sum = (arr, k) => arr.reduce((s, e) => s + (e.v ? e.v[k] || 0 : 0), 0);
  T.eq('one entry per day', all.length, 12);
  T.eq('net sales add to the tile', sum(all, 'netSales'), f.netSales);
  T.eq('each kind of fee adds to its row', sum(all, 'fee:FBA fulfillment fees'),
    f.fees.find(x => x.name === 'FBA fulfillment fees').amount);
  T.eq('all fees add to the Amazon fees tile', sum(all, 'fees'), f.feeTotal);
  T.eq('what is left adds to the after-fees-and-ads tile', sum(all, 'left'), f.afterFeesAndAds);
  T.ok('days with no download carry nothing', all[10].covered === false && all[10].v === null);
  const a = Simple.seriesFor(f, 'SKU-A');
  const ra = f.bySku.find(r => r.msku === 'SKU-A');
  T.eq('one product: its own net sales', sum(a, 'netSales'), ra.netSales);
  T.eq('its own fees, kind by kind', sum(a, 'fee:Referral fee'), ra.feeBy['Referral fee']);
  T.eq('and what it keeps', sum(a, 'left'), ra.net);
  T.eq('a product not in the forecast: covered days, all zero', sum(Simple.seriesFor(f, 'NOPE'), 'netSales'), 0);

  const series = [{ key: 'netSales', name: 'Net sales', colour: '#000', sign: 1 },
    { key: 'fee:Referral fee', name: 'Referral fee', colour: '#111', sign: -1 }];
  const it = Charts.forecastItems(all, { series, metrics: ['netSales', 'fee:Referral fee'], mode: 'running',
    pctOf: 'netSales' });
  const end = it.items[9].rows;
  T.eq('the reading gives each line\u2019s share of sales to date', end.map(r => r[5]).join(','), '1,0.15');
  T.eq('and the fee as a cost', end[1][2], -f.fees.find(x => x.name === 'Referral fee').amount);
}

T.section('Zoom, and every line named');
{
  const Charts = require('../lib/charts.js');
  const f = Simple.forecastFor([ten], '2026-10-01', '2026-10-12');
  const full = Charts.forecast(f.daily, { metrics: ['netSales'], mode: 'running' });
  const zoomed = Charts.forecast(f.daily, { metrics: ['netSales'], mode: 'running',
    zoom: { from: '2026-10-04', to: '2026-10-06' } });
  const itemsOf = h => JSON.parse(h.match(/data-fc="([^"]*)"/)[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')).items;
  T.eq('all twelve days, unzoomed', itemsOf(full).length, 12);
  const zi = itemsOf(zoomed);
  T.eq('zoomed: only those three days are drawn', zi.map(x => x.from).join(','), '2026-10-04,2026-10-05,2026-10-06');
  T.eq('with the totals still counted from the start', zi[0].rows[0][2], f.daily.slice(0, 4)
    .reduce((s, e) => s + e.netSales, 0));
  const four = Charts.forecast(f.daily, { metrics: ['netSales', 'fees', 'advertising', 'after'], mode: 'running' });
  const labs = [...four.matchAll(/<text class="ch-lab" x="[^"]+" y="([^"]+)"/g)].map(m => +m[1]).sort((a, b) => a - b);
  T.eq('four lines, four names at their ends', labs.length, 4);
  T.ok('never on top of each other', labs.every((y, i) => !i || y - labs[i - 1] >= 16.9));
  T.ok('after fees and ads is dashed, so a line under it shows', /stroke="var\(--mark-4\)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="9 5"/.test(four));
  const wk = Charts.forecast(f.daily, { metrics: ['netSales'], mode: 'weekly', mondayOf: Simple.mondayOf,
    zoom: { from: '2026-10-05', to: '2026-10-11' } });
  T.eq('weekly zoom keeps whole weeks', itemsOf(wk).map(x => x.from).join(), '2026-10-05');
}

T.section('Each day from the newest download that covers it');
{
  /* A week, downloaded last Monday: $700 net sales, $10 FBA a day's worth each day. */
  const week = file('10/05/2026', '10/11/2026', [['SKU-A', 70, '700.00', '0.00', '70.00', '0.00']], 'week.csv');
  /* One day inside it, downloaded this morning: Amazon's own figure for the 7th. */
  const day7 = file('10/07/2026', '10/07/2026', [['SKU-A', 25, '250.00', '0.00', '20.00', '0.00']], 'day7.csv');
  const when = new Map([[week, '2026-09-21T06:10:00'], [day7, '2026-09-28T06:05:00']]);
  const f = Simple.forecastFor([week, day7], '2026-10-05', '2026-10-11', { whenOf: x => when.get(x) });
  T.eqMoney('the day has its own figure, the other six share the week', f.netSales, '850.00');   // 250 + 700 * 6/7
  const d = f.daily.find(e => e.date === '2026-10-07');
  T.eqMoney('the 7th is exactly the one-day report', d.netSales, '250.00');
  T.eq('nothing is counted twice: the week gives up the 7th', f.files.find(x => x.name === 'week.csv').days, 6);
  T.eq('and the week is not called exact any more', f.exact, false);

  /* The same dates downloaded again the next day win, even if wider. */
  const wide = file('10/05/2026', '10/11/2026', [['SKU-A', 70, '1400.00', '0.00', '0.00', '0.00']], 'wide-newer.csv');
  const when2 = new Map([[day7, '2026-09-28T06:05:00'], [wide, '2026-09-29T09:00:00']]);
  const g = Simple.forecastFor([day7, wide], '2026-10-07', '2026-10-07', { whenOf: x => when2.get(x) });
  T.eqMoney('a later day\u2019s download wins, because the forecast moved', g.netSales, '200.00');   // 1400 / 7

  /* The same morning: the narrow one-day report beats a manual eight-week file. */
  const when3 = new Map([[day7, '2026-09-28T06:05:00'], [wide, '2026-09-28T09:00:00']]);
  const h = Simple.forecastFor([day7, wide], '2026-10-07', '2026-10-07', { whenOf: x => when3.get(x) });
  T.eqMoney('on the same day, the one-day report is used', h.netSales, '250.00');

  const Preview2 = require('../lib/preview.js');
  const o = Preview2.ownership([week, day7, wide], { whenOf: x => (x === wide ? '2026-09-29T01:00:00' : when.get(x)) });
  T.eq('a download every day of which is newer elsewhere owns nothing', o.superseded.map(x => x.name).join(), 'week.csv,day7.csv');
  T.eq('the rest own every day between them', [...o.owned.values()].reduce((n, d) => n + d.length, 0), 7);
  const gbp = file('10/07/2026', '10/07/2026', [['SKU-A', 1, '1.00', '0.00', '0.00', '0.00']], 'other-store.csv');
  gbp.store = 'UK';
  const o2 = Preview2.ownership([day7, gbp]);
  T.eq('another store never competes for the day', o2.superseded.length, 0);
}

process.exit(T.report() ? 0 : 1);
