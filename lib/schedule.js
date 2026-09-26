/* The daily download plan.
 *
 * Every morning the app asks Amazon for its forecast one window at a time:
 *
 *   the next 30 days, each day on its own     refreshed every day; this is
 *                                             where the forecast moves most
 *   day 31 to about four months out, a week   refreshed once a week; far-off
 *   at a time (Monday to Sunday)              estimates change slowly
 *
 * Weeks are calendar weeks so a week keeps the same dates from one morning to
 * the next; the first one starts the day after the daily run ends and stops
 * at its Sunday, so no day falls between the two.
 *
 * Nothing here talks to Amazon or to the helper. It only says what is due,
 * what is finished with, and when to run - so all of it can be tested.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'));
  } else root.Schedule = factory(root.CSV);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV) {

  const DEFAULTS = {
    enabled: true,
    time: '06:00',        // local time, 24-hour
    near: 30,             // one-day reports for this many days from tomorrow
    far: 120,             // weekly reports out to this many days (about four months)
    weeklyEvery: 7,       // days between refreshes of the weekly reports
    gapSeconds: 30,       // pause between one report and the next
    keepPastDays: 30,     // a scheduled file whose dates are this long past is let go
    maxPerDay: 60,        // never ask Amazon for more than this in one morning
  };
  const settings = cfg => Object.assign({}, DEFAULTS, cfg || {});

  const key = w => w.from + '..' + w.to;

  function windows(today, cfg) {
    const c = settings(cfg);
    const daily = [];
    for (let d = 1; d <= c.near; d++) {
      const day = CSV.addDays(today, d);
      daily.push({ from: day, to: day, kind: 'day' });
    }
    const weekly = [];
    const last = CSV.addDays(today, c.far);
    let start = CSV.addDays(today, c.near + 1);
    while (start <= last) {
      const toSunday = (7 - CSV.weekdayOf(start)) % 7;      // weekdayOf: 0 = Sunday
      const end = CSV.addDays(start, toSunday);
      weekly.push({ from: start, to: end, kind: 'week' });
      start = CSV.addDays(end, 1);
    }
    return { daily, weekly };
  }

  /* What to ask for this morning.
       doneToday   keys of windows already downloaded today (a run that was
                   interrupted picks up where it stopped)
       lastWeekly  the day the weekly reports were last refreshed, or null
       covered     day -> whether any download has figures for it; between
                   weekly refreshes, a week with a day nobody covers (the far
                   end moving out one day each morning) is still fetched */
  function due(today, cfg, known) {
    const c = settings(cfg);
    const k = known || {};
    const done = k.doneToday || new Set();
    const covered = k.covered || (() => false);
    const { daily, weekly } = windows(today, c);
    const weeklyDue = !k.lastWeekly || CSV.daysBetween(k.lastWeekly, today) >= c.weeklyEvery;
    const out = daily.filter(w => !done.has(key(w)));
    for (const w of weekly) {
      if (done.has(key(w))) continue;
      if (weeklyDue) { out.push(w); continue; }
      for (let d = w.from; d <= w.to; d = CSV.addDays(d, 1)) {
        if (!covered(d)) { out.push(w); break; }
      }
    }
    return out.slice(0, c.maxPerDay);
  }

  /* Whether this morning's run should start: at or after the set time, and
     not already run today. now: { date: 'YYYY-MM-DD', time: 'HH:MM' }. */
  function isDue(now, cfg, lastRunDate) {
    const c = settings(cfg);
    return !!c.enabled && now.date !== lastRunDate && now.time >= c.time;
  }

  /* Files the schedule itself downloaded and no longer needs: every day of
     them is covered by a newer download, or their dates are long past.
     Only ever files it downloaded - a file someone imported by hand is theirs.
     entries: [{ id, scheduled, to, owns }] where owns = days it still speaks for. */
  function prunable(entries, today, cfg) {
    const c = settings(cfg);
    const cutoff = CSV.addDays(today, -c.keepPastDays);
    return (entries || []).filter(e => e && e.scheduled && (e.owns === 0 || (e.to && e.to < cutoff)))
      .map(e => e.id);
  }

  return { DEFAULTS, settings, key, windows, due, isDue, prunable };
});
