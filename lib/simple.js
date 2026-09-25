/* The forecast, and only the forecast.
 *
 * What the app is for, in the owner's words: Amazon's estimate of sales and
 * fees, from tomorrow to the date they pick. This turns the downloaded Fees &
 * Economics Previews into exactly that - totals, each kind of fee, week by
 * week, and product by product - for any range inside what is loaded.
 *
 * How a range is cut out of a download. Amazon states one total for each
 * download's period. When the chosen dates are that period, the figures are
 * Amazon's own, untouched ("exact"). When they are a part of it, each total
 * is split evenly by calendar day - an estimate made here, and said so on
 * screen. Overlapping downloads are versions of one forecast; only the
 * newest counts (Preview.active).
 *
 * Money is integer cents throughout, from Dataset.forecastBranch.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'), require('./preview.js'), require('./dataset.js'));
  } else root.Simple = factory(root.CSV, root.Preview, root.Dataset);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Preview, Dataset) {

  const daysIn = (a, b) => CSV.daysBetween(a, b) + 1;
  const add = (a, b) => (b == null ? a : (a == null ? 0 : a) + b);
  const mondayOf = d => CSV.addDays(d, -((CSV.weekdayOf(d) + 6) % 7));

  /* Every day from..to that a loaded download covers, and every gap. */
  function coverage(files, from, to) {
    const covered = new Set();
    for (const f of files) {
      const lo = f.period.start > from ? f.period.start : from;
      const hi = f.period.end < to ? f.period.end : to;
      for (let d = lo; d <= hi; d = CSV.addDays(d, 1)) covered.add(d);
    }
    const gaps = [];
    let run = null;
    for (let d = from; d <= to; d = CSV.addDays(d, 1)) {
      if (!covered.has(d)) { if (!run) run = { from: d, to: d }; else run.to = d; }
      else if (run) { gaps.push(run); run = null; }
    }
    if (run) gaps.push(run);
    return { covered: covered.size, gaps };
  }

  function forecastFor(previews, from, to) {
    const out = {
      from, to, days: from && to && from <= to ? daysIn(from, to) : 0,
      files: [], exact: true, superseded: 0,
      units: null, sales: null, netSales: null, feeTotal: null, advertising: null,
      fees: [], bySku: [], weeks: [], coveredDays: 0, gaps: [],
      currency: null, store: null, loadedTo: null, loadedFrom: null,
    };
    if (!out.days) return out;

    const chosen = Preview.active(previews || []);
    out.superseded = chosen.superseded.length;
    const dated = chosen.files.filter(f => f.period && f.period.start && f.period.end);
    if (dated.length) {
      out.loadedFrom = dated.map(f => f.period.start).sort()[0];
      out.loadedTo = dated.map(f => f.period.end).sort().pop();
    }
    const files = dated.filter(f => !(f.period.end < from || f.period.start > to));

    const fees = new Map();
    const skus = new Map();
    const weeks = new Map();
    const cur = new Set(), stores = new Set();

    for (const f of files) {
      const s = Dataset.forecastBranch([f], null);
      const lo = f.period.start > from ? f.period.start : from;
      const hi = f.period.end < to ? f.period.end : to;
      const fileDays = daysIn(f.period.start, f.period.end);
      const inDays = daysIn(lo, hi);
      const share = inDays / fileDays;
      if (inDays !== fileDays) out.exact = false;
      const part = v => (v == null ? null : Math.round(v * share));
      if (f.currency) cur.add(f.currency);
      if (f.store) stores.add(f.store);
      out.files.push({ name: f.name, from: f.period.start, to: f.period.end, used: { from: lo, to: hi },
        whole: inDays === fileDays });

      out.units = add(out.units, s.units && s.units.sold != null ? Math.round(s.units.sold * share) : null);
      out.sales = add(out.sales, part(s.sales));
      out.netSales = add(out.netSales, part(s.netSales));
      out.feeTotal = add(out.feeTotal, part(s.feeTotal));
      out.advertising = add(out.advertising, part(s.advertising));

      for (const fam of s.fees) {
        if (fam.total == null || fam.nonAdditive || fam.group === 'advertising') continue;
        const e = fees.get(fam.name) || { name: fam.name, group: fam.group, amount: 0 };
        e.amount += part(fam.total);
        fees.set(fam.name, e);
      }
      for (const r of s.bySku) {
        const e = skus.get(r.msku) || { msku: r.msku, asin: r.asin, units: 0, netSales: null,
          fees: null, advertising: null };
        e.units += Math.round((r.unitsSold || 0) * share);
        e.netSales = add(e.netSales, part(r.netSales));
        e.fees = add(e.fees, part(r.orderFees));
        e.advertising = add(e.advertising, part(r.advertising));
        skus.set(r.msku, e);
      }
      /* Week by week: each day carries an equal share of its download. */
      const perDay = v => (v == null ? null : v / fileDays);
      const dSales = perDay(s.netSales), dFees = perDay(s.feeTotal), dAds = perDay(s.advertising);
      for (let d = lo; d <= hi; d = CSV.addDays(d, 1)) {
        const k = mondayOf(d);
        const w = weeks.get(k) || { week: k, days: 0, netSales: 0, fees: 0, advertising: 0 };
        w.days++;
        if (dSales != null) w.netSales += dSales;
        if (dFees != null) w.fees += dFees;
        if (dAds != null) w.advertising += dAds;
        weeks.set(k, w);
      }
    }

    const cov = coverage(files, from, to);
    out.coveredDays = cov.covered;
    out.gaps = cov.gaps;
    if (out.coveredDays < out.days) out.exact = false;
    out.currency = cur.size === 1 ? [...cur][0] : null;
    out.store = stores.size === 1 ? [...stores][0] : null;
    out.fees = [...fees.values()].sort((a, b) => b.amount - a.amount);
    out.bySku = [...skus.values()].map(e => Object.assign(e, {
      net: e.netSales == null ? null : e.netSales - (e.fees || 0) - (e.advertising || 0),
    })).sort((a, b) => (b.netSales || 0) - (a.netSales || 0));
    out.weeks = [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1)).map(w => ({
      week: w.week, days: w.days,
      netSales: Math.round(w.netSales), fees: Math.round(w.fees), advertising: Math.round(w.advertising),
    }));
    out.afterFees = out.netSales == null ? null : out.netSales - (out.feeTotal || 0);
    out.afterFeesAndAds = out.afterFees == null ? null : out.afterFees - (out.advertising || 0);
    return out;
  }

  return { forecastFor, coverage };
});
