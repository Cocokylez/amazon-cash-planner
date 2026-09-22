/* Acceptance gates for the forecast, profit and reconciliation engines.
   Runs against the real exports where they are available; fictional values are
   used only where the specification's illustrations require them. */
const fs = require('fs');
const path = require('path');
const T = require('./harness.js');
const CSV = require('../lib/csv.js');
const Money = require('../lib/money.js');
const Ledger = require('../lib/ledger.js');
const Preview = require('../lib/preview.js');
const Cash = require('../lib/cash.js');
const Forecast = require('../lib/forecast.js');
const Profit = require('../lib/profit.js');
const Recon = require('../lib/recon.js');
const Store = require('../lib/store.js');

const SRC = process.env.FBA_PAYMENTS_CSV
  || 'C:/Users/Admin/Downloads/2025Aug1-2026Aug31CustomUnifiedTransaction.csv';
const DIR = process.env.FBA_PREVIEW_DIR || 'C:/Users/Admin/Downloads';
const $ = d => Math.round(d * 100);
const D = c => Money.fmt(c, { bare: true });

function streamInto(ledger, file) {
  return new Promise((resolve, reject) => {
    const imp = Ledger.Importer(ledger, { name: path.basename(file) });
    const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 });
    rs.on('data', c => imp.push(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(imp.finish()));
  });
}

(async () => {

  T.section('Daily allocation creates and loses no cents');
  {
    const parts = Forecast.allocate(10000, [1, 1, 1]);
    T.eq('an indivisible amount still sums exactly', parts.reduce((a, b) => a + b, 0), 10000);
    T.eq('and is spread as evenly as integers allow', parts.join(','), '3334,3333,3333');
    const w = Forecast.allocate(116702_65, [1.2, 0.9, 1.0, 1.1, 0.8, 0.7, 1.3]);
    T.eq('a weighted split also sums exactly', w.reduce((a, b) => a + b, 0), 11670265);
    const neg = Forecast.allocate(-5000, [1, 1, 1]);
    T.eq('negative amounts behave too', neg.reduce((a, b) => a + b, 0), -5000);
    T.eq('a zero-weight set does not divide by zero',
      Forecast.allocate(100, [0, 0]).join(','), '0,0');
  }

  T.section('Costs and cash stay in separate engines');
  {
    /* COGS changes profit. It must not change what Amazon will pay out. */
    const e = Cash.createEngine({ account: 'Standard Orders', cutoff: '2026-09-16' });
    e.setOpening({ available: $(10000), deferred: 0, reserve: 0, asOf: '2026-09-16', includesActivityThrough: '2026-09-16' });
    const before = e.run({ requests: [{ date: '2026-09-18', mode: 'all_eligible' }] });
    T.eq('eligible funds with no product cost recorded', D(before.bridges[0].eligible), '10,000.00');
    T.ok('the cash engine has no concept of product cost at all',
      !Object.values(Cash.EV).some(k => /cogs|cost/i.test(k)));

    /* Advertising billed on a card reduces company cash, not Amazon funds. */
    const cardAds = Forecast.advertisingEvents(
      [{ date: '2026-09-20', window: 'w', windowAdvertising: $(5000) }],
      { advertisingPaymentMethod: { method: 'card', from: '2026-06-01', evidence: 'invoice' } });
    T.eq('card-billed advertising creates no Amazon charge event', cardAds.events.length, 0);
    T.ok('and says where it does land instead',
      cardAds.notes.some(n => /reduces company bank cash/.test(n.message)));

    const amazonAds = Forecast.advertisingEvents(
      [{ date: '2026-09-20', window: 'w', windowAdvertising: $(5000) }],
      { advertisingPaymentMethod: { method: 'amazon_deduction', from: '2026-06-01', evidence: 'settlement' } });
    T.eq('Amazon-deducted advertising does create a charge', amazonAds.events.length, 1);
    T.eq('for the right amount', D(amazonAds.events[0].amount), '5,000.00');
    T.eq('and it is counted once', amazonAds.events.filter(x => x.window === 'w').length, 1);

    const unknownAds = Forecast.advertisingEvents(
      [{ date: '2026-09-20', window: 'w', windowAdvertising: $(5000) }], {});
    T.eq('an unknown billing method deducts nothing from Amazon', unknownAds.events.length, 0);
    T.ok('and names the evidence needed',
      /advertising payment-method history/.test(unknownAds.notes[0].missing));
  }

  T.section('Storage is scheduled once per month, never prorated per window');
  {
    const days = [
      { date: '2026-11-18', window: 'A', windowStorage: $(16398.02) },
      { date: '2026-11-25', window: 'A', windowStorage: $(16398.02) },
      { date: '2026-11-03', window: 'B', windowStorage: $(9000) },
    ];
    const r = Forecast.periodChargeEvents(days, {});
    const nov = r.events.filter(e => e.date.slice(0, 7) === '2026-11');
    T.eq('one storage charge for the month, not one per window', nov.length, 1);
    T.eq('and it is not the sum of the windows', D(nov[0].amount), '16,398.02');
    T.ok('the ambiguity is reported rather than silently resolved',
      r.notes.some(n => /One monthly charge is scheduled, not the sum/.test(n.message)));
    T.ok('the posting date is labelled as an observed pattern, not policy',
      /observed pattern, not a stated Amazon policy/.test(nov[0].basis));

    const none = Forecast.periodChargeEvents([{ date: '2026-10-05', window: 'C', windowStorage: null }], {});
    T.eq('a month with no storage columns schedules no charge', none.events.length, 0);
    T.ok('and records that storage is unknown, not zero',
      none.notes.some(n => /UNKNOWN, not zero/.test(n.message)));
  }

  T.section('Release timing is never a fixed rule');
  {
    const days = [{ date: '2026-09-20', netReceivable: $(10000), sourceFile: 'f' }];
    const mix = { shares: { 'Standard Orders': 0.99, 'Invoiced Orders': 0.01 } };
    const lags = new Map([
      ['Standard Orders', { median: 8, p10: 7, p90: 10 }],
      ['Invoiced Orders', { median: 30, p10: 15, p90: 31 }],
    ]);
    const base = Forecast.releaseEvents(days, { accountMix: mix, releaseLags: lags, scenario: 'base' });
    const std = base.events.find(e => e.account === 'Standard Orders');
    const inv = base.events.find(e => e.account === 'Invoiced Orders');
    T.eq('standard funds release on the observed median lag', std.date, '2026-09-28');
    T.eq('invoiced funds use their own, much longer lag', inv.date, '2026-10-20');
    T.ok('neither uses a posted+7 rule', std.lagDays !== 7 && inv.lagDays !== 7);
    T.eq('the split sums back to the day exactly',
      base.events.reduce((s, e) => s + e.amount, 0), $(10000));

    const low = Forecast.releaseEvents(days, { accountMix: mix, releaseLags: lags, scenario: 'low' });
    const high = Forecast.releaseEvents(days, { accountMix: mix, releaseLags: lags, scenario: 'high' });
    T.ok('the low case releases later', low.events[0].date > std.date);
    T.ok('the high case releases sooner', high.events[0].date < std.date);
    T.eq('but all three move the same total money',
      low.events.reduce((s, e) => s + e.amount, 0), high.events.reduce((s, e) => s + e.amount, 0));

    const noLag = Forecast.releaseEvents(days, {
      accountMix: mix, releaseLags: new Map(), scenario: 'base',
    });
    T.eq('with no observed lag nothing is scheduled', noLag.events.length, 0);
    T.eq('and the money goes to an unknown-timing bucket', noLag.unknownTiming.length, 2);
    T.ok('rather than being assumed immediately available',
      noLag.unknownTiming.reduce((s, x) => s + x.amount, 0) === $(10000));
  }

  T.section('Forecast runs are immutable and know only what they knew');
  {
    const run = Forecast.build({
      previewFiles: [], from: '2026-09-17', to: '2026-11-11',
      accountMix: { shares: { 'Standard Orders': 1 } }, releaseLags: new Map(),
      knownAt: '2026-09-16T12:00:00Z', runId: 'run-a', cutoff: '2026-09-16',
    });
    T.eq('the information cutoff is recorded on the run', run.knownAt, '2026-09-16T12:00:00Z');
    T.ok('the run carries the source versions it used', Array.isArray(run.sourceVersions));
    const copy = JSON.stringify(run);
    const run2 = Forecast.build({
      previewFiles: [], from: '2026-09-17', to: '2026-11-11',
      accountMix: { shares: { 'Standard Orders': 1 } }, releaseLags: new Map(),
      knownAt: '2026-09-20T12:00:00Z', runId: 'run-b', cutoff: '2026-09-16',
    });
    T.ok('a second run is a separate record, not an overwrite', run2.runId !== run.runId);
    T.eq('and the first is unchanged', JSON.stringify(run), copy);
  }

  T.section('Reconciliation reports Not tested when the controls are absent');
  {
    const none = Recon.settlementBridge(new Map(), null);
    T.eq('no statements means Not tested', none.status, Recon.NOT_TESTED);
    T.ok('not Pass', none.status !== Recon.PASS);
    T.ok('and it names the evidence needed', /official Statements/.test(none.missing));

    const bank = Recon.matchBankDeposits([{ date: '2026-09-01', amount: $(1000), account: 'Standard Orders' }], null);
    T.eq('no deposits means Not tested', bank.status, Recon.NOT_TESTED);
    T.eq('and no transit statistics are produced', bank.transitStats, null);

    const withDeposits = Recon.matchBankDeposits(
      [{ date: '2026-09-01', amount: $(1000), account: 'Standard Orders' },
        { date: '2026-09-10', amount: $(2500), account: 'Standard Orders' }],
      [{ date: '2026-09-03', amount: $(1000), account: 'Standard Orders' },
        { date: '2026-09-13', amount: $(2500), account: 'Standard Orders' }]);
    T.eq('supplied deposits match one to one', withDeposits.matches.length, 2);
    T.eq('and transit is measured, not assumed', withDeposits.transitStats.median, 2);
    T.ok('the basis says measured', /measured from matched deposits/.test(withDeposits.transitStats.basis));
    T.eq('nothing is left unmatched', withDeposits.unmatchedTransfers.length, 0);

    const split = Recon.matchBankDeposits(
      [{ date: '2026-09-01', amount: $(3000), account: 'A' }],
      [{ date: '2026-09-03', amount: $(1000), account: 'A' },
        { date: '2026-09-04', amount: $(2000), account: 'A' }]);
    T.eq('a transfer arriving as two deposits is matched as a split', split.matches[0].kind, 'split');
    T.eq('for the full amount', D(split.matches[0].amount), '3,000.00');
  }

  T.section('Error measures handle the awkward cases');
  {
    const s = Recon.score([
      { actual: $(100), forecast: $(80) },
      { actual: 0, forecast: $(50) },
      { actual: $(200), forecast: $(260) },
    ]);
    T.eq('zero actuals are counted, not dropped', s.n, 3);
    T.eq('and reported separately', s.zeroActuals, 1);
    T.ok('a zero actual produces no percentage rather than Infinity',
      s.rows[1].variancePct === null);
    T.eq('WAPE divides total error by total actual',
      Math.round(s.wape * 100) / 100, Math.round(((2000 + 5000 + 6000) / 30000) * 10000) / 100);
    T.ok('bias keeps its sign', s.bias !== Math.abs(s.bias));
    T.ok('and the measures are labelled as errors, not confidence',
      /not confidence intervals/.test(s.note));
  }

  T.section('A plan is not a transfer and not a receipt');
  {
    const fc = { runId: 'r1', cutoff: '2026-09-16', horizon: { from: '2026-09-17', to: '2026-11-11' },
      bridges: [{ requestDate: '2026-09-18', eligible: $(10000), requested: $(10000), expectedBankReceipt: { date: null } }] };
    const actual = { requests: [{ date: '2026-09-20', requested: $(9000), disbursed: $(9000) }] };
    const cmp = Recon.compareForecastToActual(fc, actual);
    T.eq('a request made on a different date is a planning change, not an error',
      cmp.planningChanges.filter(c => c.kind === 'request-added').length, 1);
    T.eq('and the unmade planned request is recorded too',
      cmp.planningChanges.filter(c => c.kind === 'request-not-made').length, 1);
    T.ok('the schedule variance is described as a decision',
      cmp.planningChanges.every(c => /planning decision|schedule variance/.test(c.message)));
    T.eq('bank timing stays untested without actual deposit dates',
      cmp.scores.bankTiming.status, Recon.NOT_TESTED);
    T.ok('fixed-horizon totals are reported so splitting payouts cannot look like earnings',
      cmp.horizonTotals[14] && cmp.horizonTotals[56]);
    T.ok('the original run is marked immutable', cmp.immutable);
  }

  T.section('The data checklist names what each gap blocks');
  {
    const empty = Store.outstanding({});
    T.eq('with nothing supplied, everything is outstanding', empty.length, Store.CHECKLIST.length);
    const blocked = Store.blockedScreens({});
    T.ok('the cash dashboard is blocked', blocked.has('cash-dashboard'));
    T.ok('by the current balance specifically',
      blocked.get('cash-dashboard').some(i => i.id === 'current-balances'));
    T.ok('the payout forecast is blocked by the October preview gap',
      blocked.get('payout-forecast').some(i => i.id === 'october-preview'));
    T.ok('profitability is blocked by product costs',
      blocked.get('profitability').some(i => i.id === 'product-costs'));
    T.ok('every checklist item explains what it unlocks',
      Store.CHECKLIST.every(i => i.unlocks && i.unlocks.length > 20));

    const some = Store.outstanding({
      balanceSnapshots: [{ available: 1 }],
      policy: { nextScheduledPayout: '2026-09-24' },
    });
    T.ok('supplying inputs removes them from the list', some.length < empty.length);
    T.ok('current balances no longer outstanding', !some.some(i => i.id === 'current-balances'));
  }

  T.section('Snapshots are compared, never summed');
  {
    const a = { observedAt: '2026-09-10', available: $(1000), deferred: $(500), reserve: 0, inTransit: 0 };
    const b = { observedAt: '2026-09-17', available: $(1400), deferred: $(300), reserve: 0, inTransit: 0 };
    const d = Store.diffSnapshots(a, b);
    T.eq('available change', D(d.changes.available), '400.00');
    T.eq('deferred change', D(d.changes.deferred), '-200.00');
    T.eq('days between', d.days, 7);
    T.ok('the result says it is a comparison', /never added together/.test(d.note));

    const prev = [{ orderId: '1', postedAt: 'x', amount: $(100), expectedRelease: '2026-09-20' },
      { orderId: '2', postedAt: 'y', amount: $(200), expectedRelease: '2026-09-21' }];
    const next = [{ orderId: '2', postedAt: 'y', amount: $(200), expectedRelease: '2026-09-25' },
      { orderId: '3', postedAt: 'z', amount: $(300), expectedRelease: '2026-09-26' }];
    const dd = Store.diffDeferred(prev, next);
    T.eq('one held transaction released', dd.released.length, 1);
    T.eq('one was postponed, and the previous date is kept', dd.postponed.length, 1);
    T.eq('previous expected release retained', dd.postponed[0].previousExpected, '2026-09-21');
    T.eq('one is new', dd.added.length, 1);
    T.ok('so the same receivable cannot be counted twice',
      dd.released.length + dd.postponed.length + dd.unchanged.length === prev.length);
  }

  /* ── source-backed gates ──────────────────────────────────────────────── */

  if (!fs.existsSync(SRC)) {
    T.notTested('Source-backed profit and forecast gates', 'Payments export not available.');
    process.exit(T.report() ? 0 : 1);
  }

  const led = Ledger.create(200000);
  await streamInto(led, SRC);

  T.section('Profit engine against the real ledger');
  {
    const st = Profit.statement(led, { filter: {} });
    T.eq('net revenue matches the verified ledger figure', D(st.revenue.netRevenue), '4,060,115.14');
    T.eq('gross product sales', D(st.revenue.grossProductSales), '4,297,072.13');
    T.eq('product refunds are measured on their own component', D(st.revenue.refundedProductSales), '-190,264.86');
    T.ok('a whole Refund row is NOT treated as refunded revenue',
      Math.abs(st.revenue.refundedProductSales) < 200000_00);
    T.eq('net profit is withheld without complete costs', st.netProfit.amount, null);
    T.ok('and names every missing input',
      /complete product costs/.test(st.netProfit.missing)
      && /operating costs outside Amazon/.test(st.netProfit.missing));
    T.eq('net margin is withheld too', st.netMargin.amount, null);
    T.ok('the contribution line is named for what it covers', !st.contributionComplete);
    T.eq('the operating result ties to the ledger bridge',
      D(st.operatingResult), '1,759,919.93');
    T.ok('which equals the independently verified non-transfer net activity',
      st.operatingResult === led.summary().nonTransferNet);
  }

  T.section('Weekday weights and account mix are measured, not assumed');
  {
    const w = Forecast.weekdayWeights(led, { from: '2026-04-01', to: '2026-08-31' });
    T.ok('weekday weights were measurable from history', !!w);
    T.eq('seven weights', w.weights.length, 7);
    T.ok('they average to 1', Math.abs(w.weights.reduce((a, b) => a + b, 0) / 7 - 1) < 1e-9);
    T.ok('and they are labelled as a model forecast', w.origin === 'MODEL FORECAST');

    const mix = Forecast.accountMix(led, { from: '2026-04-01', to: '2026-08-31' });
    T.ok('the account mix was measurable', !!mix);
    T.ok('it covers both streams', mix.shares['Standard Orders'] && mix.shares['Invoiced Orders']);
    T.ok('shares sum to 1',
      Math.abs(Object.values(mix.shares).reduce((a, b) => a + b, 0) - 1) < 1e-9);
    T.ok('standard orders dominate, as the ledger shows', mix.shares['Standard Orders'] > 0.9);

    const noMix = Forecast.buildDailyEconomics({ previewFiles: [], from: '2026-09-17', to: '2026-09-30', accountMix: null });
    T.ok('without a mix the economics are blocked, not guessed',
      /account split/.test(noMix.blocked));
  }

  T.section('Forecast built from the real previews');
  {
    const files = [];
    for (const id of ['6688759b-82df-483f-9438-f80496f1e536', '9c5ef61a-cea5-47d8-9279-eb8e230e4481',
      'f0b02774-9568-4406-bbe6-cb14b2ed4721', 'f38d482d-518d-4181-812c-0ff48a2b27e1']) {
      const p = path.join(DIR, id + '.amzn1.tortuga.4.na.csv');
      if (fs.existsSync(p)) files.push(Preview.parse(fs.readFileSync(p, 'utf8'), { name: id }));
    }
    const mix = Forecast.accountMix(led, { from: '2026-04-01', to: '2026-08-31' });
    const lags = led.releaseLags({ from: '2026-04-01', to: '2026-08-31' });
    const w = Forecast.weekdayWeights(led, { from: '2026-04-01', to: '2026-08-31' });
    const run = Forecast.build({
      previewFiles: files, from: '2026-09-17', to: '2026-11-11',
      accountMix: mix, releaseLags: lags, weekdayWeights: w,
      cutoff: '2026-09-16', knownAt: '2026-09-16T00:00:00Z',
    });
    T.ok('the forecast produced events', run.events.length > 0);
    T.eq('the October gap is reported as a limitation',
      run.limitations.filter(l => l.kind === 'coverage-gap').length, 1);
    const gap = run.limitations.find(l => l.kind === 'coverage-gap');
    T.eq('gap start', gap.from, '2026-10-16');
    T.eq('gap end', gap.to, '2026-10-31');
    T.ok('and it says the gap is not filled from neighbours',
      /not stretched to fill/.test(gap.message));
    T.eq('no daily economics exist inside the gap',
      run.dailyEconomics.filter(d => d.date >= '2026-10-16' && d.date <= '2026-10-31').length, 0);

    /* Sept 17–30 window: the daily parts must sum to the window's own total. */
    const sept = run.dailyEconomics.filter(d => d.window === '2026-09-17..2026-09-30');
    T.eq('the September window is split across 14 days', sept.length, 14);
    const septTotal = sept.reduce((s, d) => s + d.netReceivable, 0);
    const f = files[0];
    let ns = null;
    for (const r of f.rows) if (r.netSales != null) ns = ns == null ? r.netSales : ns + r.netSales;
    const fees = ['Referral fee', 'FBA fulfillment fees', 'Closing fee', 'Per-item selling fee',
      'Returns processing fee for Apparel and Shoes', 'Aged inventory surcharge']
      .map(n => Preview.familyTotal(f.rows, n).total)
      .filter(v => v != null)
      .reduce((s, v) => s + Money.round(v), 0);
    T.eq('daily parts sum exactly to net sales less order fees',
      D(septTotal), D(Money.round(ns) - fees));
    T.ok('no cents were created or lost in the split',
      septTotal === Money.round(ns) - fees);
    T.ok('the returns assumption states that refunds are not subtracted twice',
      run.assumptions.some(a => a.id === 'returns-netting' && /not subtracted a second time/.test(a.basis)));
    T.ok('the fee basis states that parents are used alone',
      run.assumptions.some(a => a.id === 'fee-parents' && /never added on top/.test(a.basis)));
  }

  T.section('Rolling-origin baselines reproduce the audited figures');
  {
    const base = Recon.rollingOriginBaselines(led.transfers());
    const recent = Recon.scoreBaselines(base, { from: '2026-04-01', to: '2026-08-31' });
    const pick = (acct, model) => recent.find(r => r.account === acct && r.model === model);
    const stdLast = pick('Standard Orders', 'Last transfer');
    const stdMean = pick('Standard Orders', 'Prior four mean');
    T.eq('Apr–Aug standard, last-transfer baseline N', stdLast.n, 97);
    T.eq('  MAE', D(Math.round(stdLast.mae)), '3,944.57');
    T.eq('  WAPE', stdLast.wape.toFixed(2), '38.43');
    T.eq('  bias', D(Math.round(stdLast.bias)), '-84.16');
    T.eq('Apr–Aug standard, prior-four-mean MAE', D(Math.round(stdMean.mae)), '3,650.65');
    T.eq('  WAPE', stdMean.wape.toFixed(2), '35.56');
    const all = Recon.scoreBaselines(base);
    const invLast = all.find(r => r.account === 'Invoiced Orders' && r.model === 'Last transfer');
    /* This one lands on an exact half-cent: the mean absolute error is
       $350.655. The audit's table shows 350.65 (rounding the tie down), this
       code rounds half-up to 350.66. Both describe the same number, so the
       assertion allows the one-cent tie rather than pretending either is wrong. */
    T.ok('all-tests invoiced last-transfer MAE is $350.655, to the half-cent',
      Math.abs(invLast.mae - 35065.5) < 0.51, 'got ' + (invLast.mae / 100).toFixed(3));
    T.eq('  WAPE', invLast.wape.toFixed(2), '49.62');
    T.ok('streams are scored separately, never pooled',
      new Set(all.map(r => r.account)).size === 2);
  }

  process.exit(T.report() ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
