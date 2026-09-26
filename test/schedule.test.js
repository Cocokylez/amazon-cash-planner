/* The daily download plan: which windows, when, and what is let go. */
const T = require('./harness.js');
const Schedule = require('../lib/schedule.js');
const CSV = require('../lib/csv.js');

const TODAY = '2026-09-26';          // a Saturday

T.section('The windows: the next 30 days one by one, then weeks to about four months');
{
  const { daily, weekly } = Schedule.windows(TODAY);
  T.eq('30 one-day windows', daily.length, 30);
  T.eq('starting tomorrow', daily[0].from + '..' + daily[0].to, '2026-09-27..2026-09-27');
  T.eq('ending 30 days out', daily[29].from, '2026-10-26');
  T.eq('the weeks start the very next day, so nothing falls between', weekly[0].from, '2026-10-27');
  T.eq('and the first stops at its Sunday', weekly[0].to, '2026-11-01');
  T.ok('every other week is Monday to Sunday', weekly.slice(1).every(w => CSV.weekdayOf(w.from) === 1
    && CSV.weekdayOf(w.to) === 0 && CSV.daysBetween(w.from, w.to) === 6));
  T.ok('they reach at least four months out', weekly[weekly.length - 1].to >= CSV.addDays(TODAY, 120));
  let gap = false;
  const all = daily.concat(weekly);
  for (let i = 1; i < all.length; i++) if (CSV.addDays(all[i - 1].to, 1) !== all[i].from) gap = true;
  T.ok('no day is missed and none is asked for twice', !gap);
  T.ok('about 45 reports on the morning the weeks are refreshed', daily.length + weekly.length <= 45);
  const tomorrow = Schedule.windows('2026-09-27');
  T.ok('a week keeps its dates from one morning to the next',
    tomorrow.weekly.some(w => w.from === '2026-11-02' && w.to === '2026-11-08')
    && weekly.some(w => w.from === '2026-11-02' && w.to === '2026-11-08'));
}

T.section('What is due this morning');
{
  const first = Schedule.due(TODAY, null, {});
  T.eq('the first morning: every day and every week', first.length, Schedule.windows(TODAY).daily.length
    + Schedule.windows(TODAY).weekly.length);
  T.eq('nearest first', first[0].from, '2026-09-27');
  const later = Schedule.due(TODAY, null, { lastWeekly: '2026-09-22', covered: () => true });
  T.eq('between weekly refreshes: only the 30 days', later.length, 30);
  const edge = Schedule.due(TODAY, null, { lastWeekly: '2026-09-22', covered: d => d < '2026-01-20' });
  T.ok('but a week with a day nobody has is still fetched', edge.some(w => w.kind === 'week'));
  const weekOn = Schedule.due(TODAY, null, { lastWeekly: '2026-09-19', covered: () => true });
  T.ok('a week after the last refresh, the weeks are fetched again', weekOn.filter(w => w.kind === 'week').length > 10);
  const done = new Set(['2026-09-27..2026-09-27', '2026-09-28..2026-09-28']);
  const resumed = Schedule.due(TODAY, null, { doneToday: done, lastWeekly: '2026-09-22', covered: () => true });
  T.eq('a run that stopped half way picks up where it was', resumed[0].from, '2026-09-29');
  T.eq('never more than the daily cap', Schedule.due(TODAY, { maxPerDay: 10 }, {}).length, 10);
}

T.section('When it runs');
{
  T.ok('at the set time', Schedule.isDue({ date: TODAY, time: '06:00' }, null, '2026-09-25'));
  T.ok('not before it', !Schedule.isDue({ date: TODAY, time: '05:59' }, null, '2026-09-25'));
  T.ok('and once a day', !Schedule.isDue({ date: TODAY, time: '09:00' }, null, TODAY));
  T.ok('a morning missed (laptop asleep) is caught up later', Schedule.isDue({ date: TODAY, time: '14:30' }, null, '2026-09-24'));
  T.ok('switched off, never', !Schedule.isDue({ date: TODAY, time: '09:00' }, { enabled: false }, null));
}

T.section('What is let go, and what never is');
{
  const gone = Schedule.prunable([
    { id: 'a', scheduled: true, to: '2026-10-01', owns: 0 },    // every day newer elsewhere
    { id: 'b', scheduled: true, to: '2026-10-02', owns: 1 },    // still the newest for a day
    { id: 'c', scheduled: true, to: '2026-08-01', owns: 1 },    // long past
    { id: 'd', scheduled: false, to: '2026-10-01', owns: 0 },   // imported by hand
    { id: 'e', scheduled: false, to: '2026-01-01', owns: 1 },   // by hand, long past
  ], TODAY);
  T.eq('replaced and long-past scheduled files go', gone.join(), 'a,c');
  T.ok('a file someone imported themselves is never touched', gone.indexOf('d') < 0 && gone.indexOf('e') < 0);
}

process.exit(T.report() ? 0 : 1);
