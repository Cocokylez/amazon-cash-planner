/* The hand-entered inputs: bank deposits, product costs, advertising billing.
   Fictional values only - these are rules about what is accepted, not
   readings of anybody's account. */
const T = require('./harness.js');
const I = require('../lib/inputs.js');

T.section('Amounts are read exactly, as typed');
T.eq('19.99 is 1999 cents, not 1998', I.parseAmount('19.99'), 1999);
T.eq('thousands separators and a dollar sign', I.parseAmount('$1,234.56'), 123456);
T.eq('a whole number', I.parseAmount('42'), 4200);
T.eq('a single decimal', I.parseAmount('4.2'), 420);
T.eq('a leading point', I.parseAmount('.5'), 50);
T.eq('a minus sign', I.parseAmount('-4.20'), -420);
T.eq('accounting brackets are negative', I.parseAmount('(12.00)'), -1200);
T.eq('a third decimal rounds half up to the cent', I.parseAmount('3.455'), 346);
T.eq('and below half rounds down', I.parseAmount('3.454'), 345);
T.eq('0.1 + 0.2 territory stays exact', I.parseAmount('0.30'), 30);
T.eq('blank is not zero', I.parseAmount(''), null);
T.eq('words are not money', I.parseAmount('twelve'), null);
T.eq('two points is not a number', I.parseAmount('1.2.3'), null);

T.section('A bank deposit');
{
  const ok = I.deposit({ date: '2026-09-10', amount: '1,500.00', account: 'Standard Orders',
    reference: 'AMAZON PAYMENTS', currency: 'USD' });
  T.ok('a complete deposit is accepted', ok.record && !ok.error);
  T.eq('its amount is in cents', ok.record.amount, 150000);
  T.eq('it is marked as entered by hand', ok.record.source, 'entered');
  T.ok('it has an id to remove it by', /^dep-/.test(ok.record.id));
  T.ok('no date is refused', !!I.deposit({ amount: '10' }).error);
  T.ok('an impossible date is refused', !!I.deposit({ date: '2026-02-30', amount: '10' }).error);
  T.ok('no amount is refused', !!I.deposit({ date: '2026-09-10' }).error);
  T.ok('zero is refused - nothing arrived', !!I.deposit({ date: '2026-09-10', amount: '0' }).error);
  T.ok('a negative is refused - that is not a deposit', !!I.deposit({ date: '2026-09-10', amount: '-5' }).error);
  T.ok('an unknown account stream is refused',
    !!I.deposit({ date: '2026-09-10', amount: '5', account: 'Savings' }).error);
  T.eq('no account stream is allowed, and matches either', I.deposit({ date: '2026-09-10', amount: '5' }).record.account, null);
}

T.section('Bank transit is measured, never assumed');
{
  const tr = (date, amount) => ({ date, amount, account: 'Standard Orders' });
  const dep = (date, amount) => ({ date, amount, account: 'Standard Orders' });
  const none = I.measuredTransit([tr('2026-09-01', 1000)], []);
  T.ok('no deposits: no range', none.available === false);
  T.ok('and it names what is missing', /bank deposits/.test(none.missing));
  const noLedger = I.measuredTransit([], [dep('2026-09-03', 1000)]);
  T.ok('no transfers: no range either', noLedger.available === false && /Payments/.test(noLedger.missing));

  const two = I.measuredTransit(
    [tr('2026-09-01', 1000), tr('2026-09-15', 2000)],
    [dep('2026-09-03', 1000), dep('2026-09-18', 2000)]);
  T.ok('two matches are too few to call a range', two.available === false && two.n === 2);
  T.ok('and it says how many more it needs', /at least 3/.test(two.missing));

  const three = I.measuredTransit(
    [tr('2026-08-01', 1000), tr('2026-08-15', 2000), tr('2026-09-01', 3000)],
    [dep('2026-08-03', 1000), dep('2026-08-20', 2000), dep('2026-09-04', 3000)]);
  T.ok('three matches give a range', three.available === true);
  T.eq('fastest is the fastest seen', three.low, 2);
  T.eq('slowest is the slowest seen', three.high, 5);
  T.ok('and the basis says it was measured', /measured from 3 matched/.test(three.basis));

  const stray = I.measuredTransit(
    [tr('2026-08-01', 1000)],
    [dep('2026-08-03', 999), dep('2026-08-04', 5000), dep('2026-08-05', 7000)]);
  T.ok('deposits that match no transfer measure nothing', stray.available === false && stray.n === 0);
}

T.section('A product cost');
{
  const c = I.cost({ msku: ' ABC-1 ', unitCost: '4.25', from: '2026-01-01', currency: 'USD' });
  T.ok('accepted', c.record && !c.error);
  T.eq('the MSKU is trimmed, never altered otherwise', c.record.msku, 'ABC-1');
  T.eq('the cost is in cents', c.record.unitCost, 425);
  T.ok('no MSKU is refused', !!I.cost({ unitCost: '1' }).error);
  T.ok('no cost is refused', !!I.cost({ msku: 'A' }).error);
  T.ok('a negative cost is refused', !!I.cost({ msku: 'A', unitCost: '-1' }).error);
  T.ok('a period that ends before it starts is refused',
    !!I.cost({ msku: 'A', unitCost: '1', from: '2026-05-01', to: '2026-04-01' }).error);
  T.eq('zero is a real cost (a free sample) and is kept', I.cost({ msku: 'A', unitCost: '0' }).record.unitCost, 0);
  T.ok('a sub-cent cost is flagged as rounded', I.cost({ msku: 'A', unitCost: '1.005' }).rounded === true);
}

T.section('Costs pasted from a spreadsheet');
{
  const p = I.parseCostPaste('MSKU,Cost\nA-1,4.25\n"B,2",3\nC-3\t7.50\t2026-03-01\n\nD-4,abc\n',
    { currency: 'USD' });
  T.eq('three good lines become three costs', p.rows.length, 3);
  T.eq('the header row is skipped, not costed', p.rows[0].msku, 'A-1');
  T.eq('a quoted MSKU with a comma survives', p.rows[1].msku, 'B,2');
  T.eq('a tab-separated line works', p.rows[2].unitCost, 750);
  T.eq('and carries its own start date', p.rows[2].from, '2026-03-01');
  T.eq('every row gets the chosen currency', p.rows[0].currency, 'USD');
  T.eq('the bad line is reported, not dropped', p.errors.length, 1);
  T.eq('with its line number', p.errors[0].line, 6);
}

T.section('Adding costs never silently loses one');
{
  const a = I.cost({ msku: 'A', unitCost: '1', from: '2026-01-01' }).record;
  const a2 = I.cost({ msku: 'A', unitCost: '2', from: '2026-01-01' }).record;
  const a3 = I.cost({ msku: 'A', unitCost: '3', from: '2026-06-01' }).record;
  const m = I.mergeCosts([a], [a2, a3]);
  T.eq('same MSKU and start date replaces (a correction)', m.replaced, 1);
  T.eq('a new start date is a new cost', m.added, 1);
  T.eq('both dated costs are kept', m.list.length, 2);
  T.eq('the correction keeps the original id', m.list.find(c => c.from === '2026-01-01').id, a.id);
  T.eq('and carries the new figure', m.list.find(c => c.from === '2026-01-01').unitCost, 200);
  T.eq('costs in another currency are left out',
    I.costsIn([{ msku: 'A', currency: 'CAD' }, { msku: 'B', currency: 'USD' }, { msku: 'C' }], 'USD')
      .map(c => c.msku).join(','), 'B,C');
}

T.section('Advertising billing');
{
  const card = I.adBill({ method: 'card', from: '2026-09-01', to: '2026-09-30', amount: '300.00' });
  T.ok('a card bill is accepted', card.record && !card.error);
  T.eq('its amount is in cents', card.record.amount, 30000);
  T.ok('a card bill needs an amount', !!I.adBill({ method: 'card', from: '2026-09-01', to: '2026-09-30' }).error);
  const ded = I.adBill({ method: 'amazon_deduction', from: '2026-01-01', to: '2026-05-31' });
  T.ok('an Amazon-deducted period needs no amount - it is in the transactions', !ded.error);
  T.eq('and stores none, so it can never be counted twice', ded.record.amount, null);
  T.ok('an unknown method is refused', !!I.adBill({ method: 'cash', from: '2026-09-01', to: '2026-09-30', amount: '1' }).error);
  T.ok('a backwards period is refused', !!I.adBill({ method: 'card', from: '2026-09-30', to: '2026-09-01', amount: '1' }).error);

  const bills = [ded.record, card.record];
  T.eq('the method on a date inside a period', (I.adMethodAt(bills, '2026-09-15') || {}).method, 'card');
  T.eq('an earlier period has its own method', (I.adMethodAt(bills, '2026-03-01') || {}).method, 'amazon_deduction');
  T.eq('a gap between periods is not recorded', I.adMethodAt(bills, '2026-07-01'), null);
  const fwd = I.adMethodForForecast(bills, '2026-10-05');
  T.eq('a forecast after the last period carries the latest method forward', fwd.method, 'card');
  T.ok('and says it did', fwd.carriedForward === true && /carried forward/.test(fwd.evidence));
  T.eq('with nothing recorded, the forecast has no method', I.adMethodForForecast([], '2026-10-05'), null);
}

T.section('Advertising outside Amazon, for a profit period');
{
  const b = (method, from, to, amount) => I.adBill({ method, from, to, amount }).record;
  const sep = b('card', '2026-09-01', '2026-09-30', '300.00');
  const aug = b('card', '2026-08-01', '2026-08-31', '310.00');
  const early = b('amazon_deduction', '2026-01-01', '2026-07-31');

  const whole = I.externalAdvertising([sep], '2026-09-01', '2026-09-30');
  T.ok('a period fully covered by one bill is complete', whole.complete);
  T.eq('and counts the whole bill', whole.amount, 30000);
  T.eq('with nothing prorated', whole.prorated, 0);

  const half = I.externalAdvertising([sep], '2026-09-01', '2026-09-15');
  T.eq('half the month counts half the bill, by day', half.amount, 15000);
  T.eq('and says one bill was prorated', half.prorated, 1);

  const gap = I.externalAdvertising([sep], '2026-08-20', '2026-09-30');
  T.ok('days with no record leave it incomplete', !gap.complete);
  T.eq('so there is no amount - unknown is not zero', gap.amount, null);
  T.eq('it counts the uncovered days', gap.totalDays - gap.coveredDays, 12);
  T.ok('and names them', /12 of the 42 days/.test(gap.missing));

  const span = I.externalAdvertising([early, aug, sep], '2026-07-01', '2026-09-30');
  T.ok('Amazon-deducted days count as covered', span.complete);
  T.eq('but add nothing - they are already in the transactions', span.amount, 31000 + 30000);

  const odd = I.externalAdvertising([b('card', '2026-09-01', '2026-09-30', '100.00')], '2026-09-01', '2026-09-10');
  T.eq('a prorated share rounds half up to the cent once', odd.amount, 3333);

  T.eq('a period with no end is not a period',
    I.externalAdvertising([sep], '2026-09-01', null).amount, null);
  T.eq('bills in another currency are left out',
    I.externalAdvertising([Object.assign({}, sep, { currency: 'CAD' })], '2026-09-01', '2026-09-30', 'USD').complete, false);
}

process.exit(T.report() ? 0 : 1);
