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
    module.exports = factory(require('./csv.js'), require('./preview.js'), require('./dataset.js'),
      require('./money.js'));
  } else root.Simple = factory(root.CSV, root.Preview, root.Dataset, root.Money);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Preview, Dataset, Money) {

  const daysIn = (a, b) => CSV.daysBetween(a, b) + 1;
  /* The fees that make up "Amazon fees": each parent family, advertising
     apart. Children only explain a parent and are never added on top. */
  const FEE_FAMILIES = Preview.FEES.filter(x => !x.parent && x.group !== 'advertising').map(x => x.name);
  const add = (a, b) => (b == null ? a : (a == null ? 0 : a) + b);
  const mondayOf = d => CSV.addDays(d, -((CSV.weekdayOf(d) + 6) % 7));
  /* A whole number of cents shared over n days so the days add back to it
     exactly: the odd cents go to the first days, one each. */
  const spread = (total, n) => {
    if (total == null) return () => 0;
    const q = Math.trunc(total / n), r = total - q * n;
    return i => q + (i < Math.abs(r) ? Math.sign(r) : 0);
  };

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

  /* opts.whenOf(file): when it was downloaded (ISO), so that for any day the
     newest download's figure is the one used (Preview.ownership). */
  function forecastFor(previews, from, to, opts) {
    const out = {
      from, to, days: from && to && from <= to ? daysIn(from, to) : 0,
      files: [], exact: true, superseded: 0,
      units: null, sales: null, netSales: null, feeTotal: null, advertising: null,
      fees: [], bySku: [], weeks: [], daily: [], parts: [], coveredDays: 0, gaps: [],
      currency: null, store: null, loadedTo: null, loadedFrom: null,
    };
    if (!out.days) return out;

    /* Each day from the one download that owns it: overlapping downloads are
       versions of one forecast, and adding them would count it twice. */
    const own = Preview.ownership(previews || [], { whenOf: opts && opts.whenOf });
    out.superseded = own.superseded.length;
    const dated = [...own.owned.keys()].filter(f => own.owned.get(f).length);
    if (dated.length) {
      out.loadedFrom = dated.map(f => own.owned.get(f)[0]).sort()[0];
      out.loadedTo = dated.map(f => own.owned.get(f)[own.owned.get(f).length - 1]).sort().pop();
    }
    const inRange = f => own.owned.get(f).filter(d => d >= from && d <= to);
    const files = dated.filter(f => inRange(f).length);

    const fees = new Map();
    const skus = new Map();
    const days = new Map();
    const cur = new Set(), stores = new Set();

    for (const f of files) {
      const s = Dataset.forecastBranch([f], null);
      const mine = inRange(f);                     // the days this download speaks for
      const lo = mine[0], hi = mine[mine.length - 1];
      const fileDays = daysIn(f.period.start, f.period.end);
      const inDays = mine.length;
      const share = inDays / fileDays;
      if (inDays !== fileDays) out.exact = false;
      const part = v => (v == null ? null : Math.round(v * share));
      if (f.currency) cur.add(f.currency);
      if (f.store) stores.add(f.store);
      out.files.push({ name: f.name, from: f.period.start, to: f.period.end, used: { from: lo, to: hi },
        days: inDays, whole: inDays === fileDays });

      out.units = add(out.units, s.units && s.units.sold != null ? Math.round(s.units.sold * share) : null);
      out.sales = add(out.sales, part(s.sales));
      out.netSales = add(out.netSales, part(s.netSales));
      out.feeTotal = add(out.feeTotal, part(s.feeTotal));
      out.advertising = add(out.advertising, part(s.advertising));

      /* What this download gives the chosen dates, kept per download so any
         line - one kind of fee, one product - can be laid out day by day
         (seriesFor) the same way the totals were. */
      const piece = { from: lo, to: hi, days: inDays, dayList: mine, netSales: part(s.netSales),
        advertising: part(s.advertising), fees: {}, skus: new Map() };
      out.parts.push(piece);
      for (const fam of s.fees) {
        if (fam.total == null || fam.nonAdditive || fam.group === 'advertising') continue;
        const e = fees.get(fam.name) || { name: fam.name, group: fam.group, amount: 0 };
        e.amount += part(fam.total);
        piece.fees[fam.name] = part(fam.total);
        fees.set(fam.name, e);
      }
      for (const r of s.bySku) {
        const e = skus.get(r.msku) || { msku: r.msku, asin: r.asin, units: 0, netSales: null,
          fees: null, feeBy: {}, advertising: null };
        e.units += Math.round((r.unitsSold || 0) * share);
        e.netSales = add(e.netSales, part(r.netSales));
        e.advertising = add(e.advertising, part(r.advertising));
        skus.set(r.msku, e);
        piece.skus.set(r.msku, { netSales: part(r.netSales), advertising: part(r.advertising), fees: {} });
      }
      /* Each product's fees, kind by kind, so the screen can show what is
         taking the most from each one. The same families as the fee total. */
      const exact = new Map();
      for (const r of f.rows) {
        for (const n of FEE_FAMILIES) {
          const x = r.fees && r.fees[n];
          if (!x || x.total == null) continue;
          const m = exact.get(r.msku) || new Map();
          m.set(n, (m.get(n) || 0n) + x.total);
          exact.set(r.msku, m);
        }
      }
      for (const [msku, m] of exact) {
        const e = skus.get(msku);
        if (!e) continue;
        const mine = piece.skus.get(msku);
        for (const [n, t] of m) {
          const c = part(Money.round(t));
          e.feeBy[n] = (e.feeBy[n] || 0) + c;
          e.fees = add(e.fees, c);
          if (mine) mine.fees[n] = c;
        }
      }
      /* Day by day: each day carries an equal share of what this download
         gives the chosen dates, in whole cents that add back to it. */
      const dSales = spread(part(s.netSales), inDays), dFees = spread(part(s.feeTotal), inDays),
        dAds = spread(part(s.advertising), inDays);
      mine.forEach((d, i) => {
        const e = days.get(d) || { netSales: 0, fees: 0, advertising: 0 };
        e.netSales += dSales(i); e.fees += dFees(i); e.advertising += dAds(i);
        days.set(d, e);
      });
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
    /* Every day of the range, in order; a day no download covers is marked
       and carries nothing, never a guess. */
    for (let d = from; d <= to; d = CSV.addDays(d, 1)) {
      const e = days.get(d);
      out.daily.push(e ? { date: d, covered: true, netSales: e.netSales, fees: e.fees, advertising: e.advertising }
        : { date: d, covered: false, netSales: null, fees: null, advertising: null });
    }
    /* Week by week, from the days, so the weeks add up to the total exactly. */
    const weeks = new Map();
    for (const e of out.daily) {
      if (!e.covered) continue;
      const k = mondayOf(e.date);
      const w = weeks.get(k) || { week: k, days: 0, netSales: 0, fees: 0, advertising: 0 };
      w.days++; w.netSales += e.netSales; w.fees += e.fees; w.advertising += e.advertising;
      weeks.set(k, w);
    }
    out.weeks = [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
    out.afterFees = out.netSales == null ? null : out.netSales - (out.feeTotal || 0);
    out.afterFeesAndAds = out.afterFees == null ? null : out.afterFees - (out.advertising || 0);
    return out;
  }

  /* Any line of a forecast, day by day, for the charts: all products, or
     one (msku). Each download's share of the chosen dates is laid over its
     days exactly as the totals were, so a line's days add back to its total.
     Keys: netSales, advertising, fees (all Amazon fees), 'fee:<kind>' for
     each kind of fee, and left (after fees and advertising). A day no
     download covers is marked, and carries nothing. */
  function seriesFor(f, msku) {
    const days = new Map();
    for (const p of (f && f.parts) || []) {
      const src = msku == null ? p : (p.skus.get(msku) || { netSales: 0, advertising: 0, fees: {} });
      const lines = { netSales: spread(src.netSales, p.days), advertising: spread(src.advertising, p.days) };
      for (const n of Object.keys(src.fees || {})) lines['fee:' + n] = spread(src.fees[n], p.days);
      const list = p.dayList || [];
      list.forEach((d, i) => {
        const e = days.get(d) || {};
        for (const k of Object.keys(lines)) e[k] = (e[k] || 0) + lines[k](i);
        days.set(d, e);
      });
    }
    return ((f && f.daily) || []).map(x => {
      const e = days.get(x.date);
      if (!x.covered || !e) return { date: x.date, covered: false, v: null };
      let fees = 0;
      for (const k of Object.keys(e)) if (k.slice(0, 4) === 'fee:') fees += e[k];
      return { date: x.date, covered: true,
        v: Object.assign({}, e, { fees, left: (e.netSales || 0) - fees - (e.advertising || 0) }) };
    });
  }

  return { forecastFor, coverage, mondayOf, seriesFor };
});
