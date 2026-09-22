/* Acceptance gates for the availability and early-request engine.
 *
 * Every amount in this file is FICTIONAL test data, exactly as the
 * specification's illustration requires. None of it is this business's money,
 * and none of it reaches the application. */
const T = require('./harness.js');
const Cash = require('../lib/cash.js');
const Money = require('../lib/money.js');

const $ = d => Math.round(d * 100);          // dollars -> cents, for readability
const D = c => Money.fmt(c, { bare: true });

function engineWith(openingAvailable, extra) {
  const e = Cash.createEngine({
    account: 'Standard Orders', currency: 'USD',
    cutoff: '2026-09-16', policy: (extra && extra.policy) || {},
  });
  e.setOpening({
    available: openingAvailable,
    deferred: extra && extra.deferred != null ? extra.deferred : 0,
    reserve: extra && extra.reserve != null ? extra.reserve : 0,
    asOf: '2026-09-16', includesActivityThrough: '2026-09-16',
    source: 'fictional test snapshot',
  });
  return e;
}

T.section('The no-double-count invariant (specification illustration)');
{
  const e = engineWith($(30000));
  /* $10,000 of additional net funds release after the early request */
  e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-25', amount: $(10000), label: 'new eligible funds' });
  const r = e.run({
    requests: [
      { id: 'early', date: '2026-09-17', mode: 'all_eligible' },
      { id: 'later', date: '2026-09-30', mode: 'all_eligible' },
    ],
  });
  T.eq('the early request takes all 30,000', D(r.bridges[0].requested), '30,000.00');
  T.eq('available immediately after the early request', D(r.timeline.find(t => t.kind === 'request').balances.available), '0.00');
  T.eq('the later request can only take the 10,000 that has since released', D(r.bridges[1].requested), '10,000.00');
  T.eq('combined payouts', D(r.totalRequested), '40,000.00');
  T.ok('NOT 30,000 early plus another 40,000 later', r.totalRequested === $(40000));
  T.eq('ending available funds', D(r.ending.available), '0.00');
}

T.section('A request already made reduces every later forecast');
{
  const noRequest = engineWith($(30000));
  noRequest.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-25', amount: $(10000) });
  const a = noRequest.run({ requests: [{ date: '2026-09-30', mode: 'all_eligible' }] });
  T.eq('with no earlier request, the Sept 30 request takes everything', D(a.bridges[0].requested), '40,000.00');

  const withRequest = engineWith($(30000));
  withRequest.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-25', amount: $(10000) });
  const b = withRequest.run({
    requests: [{ date: '2026-09-17', mode: 'all_eligible' }, { date: '2026-09-30', mode: 'all_eligible' }],
  });
  T.eq('with an earlier request, the Sept 30 request takes only the new money', D(b.bridges[1].requested), '10,000.00');
  T.eq('but the total across both is identical', D(b.totalRequested), D(a.totalRequested));
  T.ok('so requesting early moved cash forward without creating any',
    a.totalRequested === b.totalRequested);
}

T.section('Moving a planned request changes timing, never total funds');
{
  const build = when => {
    const e = engineWith($(5000));
    e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-20', amount: $(3000) });
    e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-28', amount: $(2000) });
    return e.run({ requests: [{ date: when, mode: 'all_eligible' }, { date: '2026-10-05', mode: 'all_eligible' }] });
  };
  const early = build('2026-09-18'), late = build('2026-09-29');
  T.eq('an earlier first request pulls less cash', D(early.bridges[0].requested), '5,000.00');
  T.eq('a later first request pulls more', D(late.bridges[0].requested), '10,000.00');
  T.eq('total requested is the same either way', D(early.totalRequested), D(late.totalRequested));
  T.eq('and equals opening plus new activity', D(early.totalRequested), '10,000.00');
  T.eq('ending balances agree', D(early.ending.available), D(late.ending.available));
}

T.section('Deferred funds are shown, never subtracted from the available bridge');
{
  const e = engineWith($(20000), { deferred: $(7500) });
  e.add({ kind: Cash.EV.RELEASE, date: '2026-09-20', amount: $(2500), fromOpeningHold: true });
  const r = e.run({ requests: [{ date: '2026-09-21', mode: 'all_eligible' }] });
  const br = r.bridges[0];
  T.eq('opening available', D(br.lines[0].amount), '20,000.00');
  T.eq('release of an opening hold adds to available', D(br.lines[1].amount), '2,500.00');
  T.eq('eligible to request', D(br.eligible), '22,500.00');
  T.eq('funds still deferred are reported', D(br.stillDeferred), '5,000.00');
  T.ok('and are NOT one of the bridge lines',
    !br.lines.some(l => l.amount === br.stillDeferred && /defer/i.test(l.label)));
  T.ok('the bridge says why deferred funds are not subtracted',
    /never added to available/.test(br.deferredNote));
  T.eq('the released amount left deferred exactly once', D(r.ending.deferred), '5,000.00');
}

T.section('A held transaction releases once, and carries no second fee deduction');
{
  const e = engineWith($(0), { deferred: $(1000) });
  e.add({ kind: Cash.EV.RELEASE, date: '2026-09-20', amount: $(1000), fromOpeningHold: true, label: 'net order release' });
  /* An observed status change is not a second event; the engine is only ever
     told about the release once. */
  const r = e.run({ requests: [{ date: '2026-09-21', mode: 'all_eligible' }] });
  T.eq('available after release', D(r.bridges[0].eligible), '1,000.00');
  T.eq('deferred is emptied, not doubled', D(r.ending.deferred), '0.00');
  T.eq('the release appears once in the timeline',
    r.timeline.filter(t => t.kind === 'release').length, 1);
  T.eq('total requested equals the released net amount', D(r.totalRequested), '1,000.00');
}

T.section('Opening-snapshot membership stops activity being applied twice');
{
  const e = engineWith($(10000));
  e.add({ kind: Cash.EV.CHARGE, date: '2026-09-10', amount: $(500), label: 'storage fee already in the balance' });
  e.add({ kind: Cash.EV.CHARGE, date: '2026-09-20', amount: $(500), label: 'a genuinely new charge' });
  const r = e.run({ requests: [{ date: '2026-09-21', mode: 'all_eligible' }] });
  T.eq('the pre-cutoff charge is rejected, not applied again', D(r.bridges[0].eligible), '9,500.00');
  T.ok('and the rejection is recorded as an issue',
    r.issues.some(i => /falls inside the opening snapshot/.test(i)));
  T.eq('only one charge reached the timeline',
    r.timeline.filter(t => t.kind === 'charge').length, 1);
}

T.section('A negative balance is a shortfall, not a negative payout');
{
  const e = engineWith($(1000));
  e.add({ kind: Cash.EV.CHARGE, date: '2026-09-18', amount: $(2500), label: 'large charge' });
  const r = e.run({ requests: [{ date: '2026-09-19', mode: 'all_eligible' }] });
  const br = r.bridges[0];
  T.eq('requested amount', D(br.requested), '0.00');
  T.eq('shortfall reported', D(br.shortfall), '1,500.00');
  T.ok('and it is described as a shortfall', /shortfall/.test(br.blocked));
  T.ok('no negative payout was produced', br.requested >= 0);
}

T.section('Nothing about account policy is assumed');
{
  const e = engineWith($(10000));
  const r = e.run({ requests: [{ date: '2026-09-18', mode: 'partial', amount: $(4000) }] });
  const br = r.bridges[0];
  T.eq('a partial request is not granted without evidence', br.requested, null);
  T.ok('and it names the missing confirmation',
    /supports partial payout requests/.test(br.missing));
  T.ok('a cash target is called a planning goal, not permission',
    /planning goal, not proof/.test(br.blocked));

  const e2 = engineWith($(10000), { policy: { partialRequestsSupported: true } });
  const r2 = e2.run({ requests: [{ date: '2026-09-18', mode: 'partial', amount: $(4000) }] });
  T.eq('once the account is confirmed to support it, a partial request works', D(r2.bridges[0].requested), '4,000.00');
  T.eq('and the remainder stays available', D(r2.ending.available), '6,000.00');
}
{
  const e = engineWith($(10000));
  e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-19', amount: $(1000) });
  const r = e.run({
    requests: [{ date: '2026-09-18', mode: 'all_eligible' }, { date: '2026-09-20', mode: 'all_eligible' }],
  });
  T.ok('a second request is not blocked by an invented cooldown', r.bridges[1].requested === $(1000));
  T.ok('but the unverified restriction is warned about',
    r.bridges[1].warnings.some(w => /not verified/.test(w)));

  const e2 = engineWith($(10000), { policy: { cooldownDays: 7 } });
  e2.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-19', amount: $(1000) });
  const r2 = e2.run({
    requests: [{ date: '2026-09-18', mode: 'all_eligible' }, { date: '2026-09-20', mode: 'all_eligible' }],
  });
  T.ok('a verified cooldown IS enforced', /cooldown of 7 days/.test(r2.bridges[1].blocked));
}

T.section('Requesting is not receiving');
{
  const e = engineWith($(10000));
  const r = e.run({ requests: [{ date: '2026-09-18', mode: 'all_eligible' }] });
  T.eq('cash leaves available on request', D(r.ending.available), '0.00');
  T.eq('and sits in transit, not in the bank', D(r.ending.inTransit), '10,000.00');
  T.eq('bank cash is still zero', D(r.ending.bank), '0.00');
  T.eq('expected bank date is unknown without deposit history', r.bridges[0].expectedBankReceipt.date, null);
  T.ok('and it names what is missing',
    /matched bank deposit history/.test(r.bridges[0].expectedBankReceipt.missing));
  T.ok('no default transit time is asserted as fact',
    /no default transit time is assumed/.test(r.bridges[0].expectedBankReceipt.note));

  const e2 = engineWith($(10000), { policy: { bankTransitDaysLow: 2, bankTransitDaysHigh: 4 } });
  const r2 = e2.run({ requests: [{ date: '2026-09-18', mode: 'all_eligible' }] });
  T.eq('with supplied transit evidence, an arrival window appears',
    r2.bridges[0].expectedBankReceipt.low + '..' + r2.bridges[0].expectedBankReceipt.high,
    '2026-09-20..2026-09-22');
  T.eq('and the receipt clears in-transit exactly once', D(r2.ending.inTransit), '0.00');
  T.eq('landing in bank cash', D(r2.ending.bank), '10,000.00');
  T.eq('the receipt appears once in the timeline',
    r2.timeline.filter(t => t.kind === 'bank_receipt').length, 1);
}

T.section('Already-initiated transfers count once, as in-transit');
{
  const e = engineWith($(5000));
  const r = e.run({ requests: [], openingInTransit: $(12000) });
  T.eq('cash already on its way is carried, not re-forecast', D(r.ending.inTransit), '12,000.00');
  T.eq('and it is not added to available funds', D(r.ending.available), '5,000.00');
}

T.section('No opening balance means no number, with the input named');
{
  const e = Cash.createEngine({ account: 'Standard Orders', cutoff: '2026-09-16' });
  e.setOpening({ available: null, deferred: null, reserve: null, asOf: '2026-09-16' });
  let err = null;
  try { e.run({ requests: [{ date: '2026-09-18', mode: 'all_eligible' }] }); } catch (x) { err = x; }
  T.ok('running without a current balance throws rather than guessing', !!err);
  T.eq('the error is typed as Unavailable', err && err.name, 'Unavailable');
  T.ok('and names the specific missing input',
    /current available balance for Standard Orders/.test(err.missing));
  T.ok('every missing opening component is recorded as an issue',
    e.issues.length === 3);
}

T.section('The two-week comparison needs a confirmed anchor, not historical spacing');
{
  const none = Cash.scheduledPayoutDates(Cash.emptyPolicy(), '2026-09-17', '2026-11-11');
  T.eq('with no anchor there are no scheduled dates', none.dates, null);
  T.ok('and it says what is needed',
    /confirmed next scheduled payout date/.test(none.missing));
  T.ok('explicitly refusing to infer it from transfer gaps',
    /those gaps are early requests/.test(none.note));

  const p = Object.assign(Cash.emptyPolicy(), { nextScheduledPayout: '2026-09-24', scheduleIntervalDays: 14 });
  const got = Cash.scheduledPayoutDates(p, '2026-09-17', '2026-11-11');
  T.eq('with a confirmed anchor the fortnightly calendar is built',
    got.dates.join(' '), '2026-09-24 2026-10-08 2026-10-22 2026-11-05');
}

T.section('Early requests versus the two-week schedule reconcile at a common endpoint');
{
  const cmp = Cash.comparePolicies({
    account: 'Standard Orders', currency: 'USD', cutoff: '2026-09-16',
    opening: { available: $(30000), deferred: $(5000), reserve: 0, asOf: '2026-09-16', includesActivityThrough: '2026-09-16' },
    policy: { bankTransitDaysLow: 2, bankTransitDaysHigh: 2 },
    /* identical sales, fees and release assumptions on both sides */
    build: e => {
      e.add({ kind: Cash.EV.RELEASE, date: '2026-09-22', amount: $(5000), fromOpeningHold: true });
      e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-25', amount: $(8000) });
      e.add({ kind: Cash.EV.CHARGE, date: '2026-09-28', amount: $(1200) });
      e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-10-02', amount: $(6000) });
    },
    earlyRequests: [
      { date: '2026-09-17', mode: 'all_eligible' },
      { date: '2026-09-26', mode: 'all_eligible' },
      { date: '2026-10-05', mode: 'all_eligible' },
    ],
    scheduledRequests: [{ date: '2026-09-24', mode: 'all_eligible' }, { date: '2026-10-08', mode: 'all_eligible' }],
    endpoint: '2026-10-10',
  });
  T.ok('both policies ran', cmp.early.ok && cmp.scheduled.ok);
  const rec = cmp.reconciliation;
  T.eq('early policy total at the endpoint', D(rec.early.total), D(rec.scheduled.total));
  T.ok('the two policies balance exactly', rec.balanced);
  T.ok('and the difference is explained as timing, not income',
    /changes when cash arrives, not how much/.test(rec.note));
  T.ok('early requests pull more cash into the bank sooner',
    rec.early.received >= rec.scheduled.received);
  T.ok('identical assumptions produced different request counts',
    cmp.early.executed.length !== cmp.scheduled.executed.length);
}

T.section('Earliest-date-for-target mode');
{
  const e = engineWith($(5000));
  e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-20', amount: $(3000) });
  e.add({ kind: Cash.EV.NEW_AVAILABLE, date: '2026-09-27', amount: $(4000) });
  T.eq('a target already covered returns the cutoff', e.earliestDateFor($(4000)).date, '2026-09-16');
  T.eq('a target reached mid-horizon returns that date', e.earliestDateFor($(8000)).date, '2026-09-20');
  T.eq('a later target returns the later date', e.earliestDateFor($(11500)).date, '2026-09-27');
  const miss = e.earliestDateFor($(50000));
  T.eq('an unreachable target returns no date', miss.date, null);
  T.ok('and explains the horizon limit rather than inventing one',
    /does not reach this amount/.test(miss.note));
  T.eq('short by', D(miss.shortBy), '38,000.00');

  const blocked = Cash.createEngine({ account: 'Standard Orders', cutoff: '2026-09-16' });
  blocked.setOpening({ available: null, asOf: '2026-09-16' });
  T.ok('with no current balance the answer is unavailable, naming the input',
    /current available balance/.test(blocked.earliestDateFor($(1000)).missing));
}

T.section('Balances stay separate and profit is untouched');
{
  const e = engineWith($(10000), { deferred: $(2000), reserve: $(500) });
  e.add({ kind: Cash.EV.RESERVE_RELEASE, date: '2026-09-20', amount: $(500) });
  const r = e.run({ requests: [{ date: '2026-09-21', mode: 'all_eligible' }] });
  T.eq('a reserve release moves into available', D(r.bridges[0].eligible), '10,500.00');
  T.eq('and empties the reserve', D(r.ending.reserve), '0.00');
  T.eq('deferred is untouched by it', D(r.ending.deferred), '2,000.00');
  T.ok('reserve movement is listed as its own bridge line',
    r.bridges[0].lines.some(l => l.kind === 'reserve' && l.amount === $(500)));
  T.ok('no event kind in this engine reports a profit effect',
    Object.values(Cash.EV).every(k => k !== 'profit'));
}

process.exit(T.report() ? 0 : 1);
