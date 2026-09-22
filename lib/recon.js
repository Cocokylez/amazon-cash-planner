/* Reconciliation and forecast scoring.
 *
 * Three separate jobs, kept apart because each needs different evidence:
 *
 *   settlementBridge   ties Amazon's own statement controls together. Needs
 *                      official settlement detail; without it the answer is
 *                      "Not tested", never "Pass".
 *   bankMatching       ties transfers to money that actually arrived. Needs
 *                      bank deposits; without them a transfer evidences cash
 *                      leaving Amazon and nothing more.
 *   forecast scoring   measures a saved forecast against what happened, with
 *                      planning-decision changes scored separately from
 *                      financial error.
 *
 * Zero internal arithmetic variance is not an independent match, and this
 * module says so rather than showing a green tick for a self-check.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'), require('./money.js'));
  } else root.Recon = factory(root.CSV, root.Money);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Money) {

  const NOT_TESTED = 'NOT_TESTED';
  const PASS = 'PASS';
  const VARIANCE = 'UNRECONCILED_VARIANCE';

  /* ── settlement bridge ───────────────────────────────────────────────── */

  /* opening + eligible activity ± reserve movement − transfer = ending.
     `statements` are official settlement records with independently reported
     control amounts. Grouping the posted-date extract by settlement id is NOT
     a substitute and is reported as such. */
  function settlementBridge(ledgerGroups, statements) {
    if (!statements || !statements.length) {
      return {
        status: NOT_TESTED,
        message: 'No official settlement detail has been supplied. The posted-date extract '
          + 'can be grouped by settlement id, but those boundaries do not align with '
          + 'settlement periods, so every group carries a residual.',
        missing: 'official Statements / settlement detail with opening, closing, reserve and '
          + 'transfer control amounts',
        groups: [...ledgerGroups.values()].map(g => ({
          settlementId: g.settlementId, rows: g.rows, from: g.from, to: g.to,
          accounts: g.accounts, residual: g.residual, transfer: g.transfer,
          note: 'Reference grouping only.',
        })).sort((a, b) => Math.abs(b.residual) - Math.abs(a.residual)),
      };
    }

    const results = [];
    for (const s of statements) {
      const g = ledgerGroups.get(s.settlementId);
      const derived = g ? g.net : null;
      const expected = s.opening != null && s.ending != null
        ? s.ending - s.opening : null;
      const variance = derived != null && expected != null ? derived - expected : null;
      results.push({
        settlementId: s.settlementId,
        account: s.account, currency: s.currency,
        period: { from: s.from, to: s.to },
        opening: s.opening, ending: s.ending, transfer: s.transfer,
        reserveMovement: s.reserveMovement == null ? null : s.reserveMovement,
        derivedActivity: derived,
        variance,
        status: variance == null ? NOT_TESTED : variance === 0 ? PASS : VARIANCE,
        cause: variance ? (s.cause || 'Unknown') : null,
      });
    }
    return {
      status: results.every(r => r.status === PASS) ? PASS
        : results.some(r => r.status === VARIANCE) ? VARIANCE : NOT_TESTED,
      results,
      message: 'Derived from official statement controls.',
    };
  }

  /* ── bank matching ───────────────────────────────────────────────────── */

  /* Match transfers to bank deposits: one-to-one, split (one transfer arriving
     as several deposits) and aggregated (several transfers in one deposit).
     Unmatched items on either side are reported, never quietly dropped. */
  function matchBankDeposits(transfers, deposits, opts) {
    opts = opts || {};
    if (!deposits || !deposits.length) {
      return {
        status: NOT_TESTED,
        missing: 'matched bank deposit history',
        message: 'Transfer rows evidence cash leaving Amazon. Without bank deposits there is '
          + 'no evidence of arrival, so bank dates and any transit time remain unavailable.',
        matches: [], unmatchedTransfers: transfers.slice(), unmatchedDeposits: [],
        transitStats: null,
      };
    }
    const windowDays = opts.windowDays == null ? 14 : opts.windowDays;
    const remaining = deposits.map((d, i) => ({ ...d, _i: i, _left: d.amount }));
    const matches = [];
    const unmatchedTransfers = [];

    for (const t of transfers) {
      const candidates = remaining.filter(d =>
        d._left > 0
        && (!d.account || !t.account || d.account === t.account)
        && d.date >= t.date
        && CSV.daysBetween(t.date, d.date) <= windowDays);
      /* exact single match first */
      const exact = candidates.find(d => d._left === t.amount);
      if (exact) {
        exact._left = 0;
        matches.push({
          kind: 'one-to-one', transfer: t, deposits: [exact],
          amount: t.amount, transitDays: CSV.daysBetween(t.date, exact.date), difference: 0,
        });
        continue;
      }
      /* split: accumulate deposits until the transfer is covered */
      let need = t.amount;
      const used = [];
      for (const d of candidates) {
        if (need <= 0) break;
        const take = Math.min(need, d._left);
        d._left -= take; need -= take;
        used.push({ deposit: d, applied: take });
      }
      if (used.length && need === 0) {
        matches.push({
          kind: used.length === 1 ? 'partial' : 'split', transfer: t,
          deposits: used.map(u => u.deposit), applied: used,
          amount: t.amount,
          transitDays: CSV.daysBetween(t.date, used[used.length - 1].deposit.date),
          difference: 0,
        });
      } else {
        for (const u of used) { u.deposit._left += u.applied; }
        unmatchedTransfers.push(t);
      }
    }
    const unmatchedDeposits = remaining.filter(d => d._left > 0);
    const transits = matches.map(m => m.transitDays).filter(x => x != null).sort((a, b) => a - b);
    return {
      status: unmatchedTransfers.length || unmatchedDeposits.length ? VARIANCE : PASS,
      matches, unmatchedTransfers, unmatchedDeposits,
      transitStats: transits.length ? {
        n: transits.length,
        min: transits[0], max: transits[transits.length - 1],
        median: transits[Math.floor((transits.length - 1) / 2)],
        p10: transits[Math.floor(0.1 * (transits.length - 1))],
        p90: transits[Math.floor(0.9 * (transits.length - 1))],
        basis: 'measured from matched deposits, not assumed',
      } : null,
      message: unmatchedTransfers.length || unmatchedDeposits.length
        ? unmatchedTransfers.length + ' transfers and ' + unmatchedDeposits.length
        + ' deposits could not be matched within ' + windowDays + ' days.'
        : 'Every transfer matched a deposit.',
    };
  }

  /* ── error measures ──────────────────────────────────────────────────── */

  /* Variance is actual minus forecast. Percentage variance divides by ACTUAL,
     and a zero actual has no percentage — it is reported as such rather than
     becoming Infinity or being silently dropped. */
  function score(pairs) {
    const rows = pairs.map(p => {
      const variance = p.actual - p.forecast;
      const pct = p.actual === 0 ? null : (variance / Math.abs(p.actual)) * 100;
      return Object.assign({}, p, { variance, variancePct: pct });
    });
    const n = rows.length;
    if (!n) return { n: 0, mae: null, wape: null, mape: null, bias: null, dateMae: null, rows, zeroActuals: 0 };
    const absSum = rows.reduce((s, r) => s + Math.abs(r.variance), 0);
    const actualSum = rows.reduce((s, r) => s + Math.abs(r.actual), 0);
    const withPct = rows.filter(r => r.variancePct != null);
    const dated = rows.filter(r => r.dateError != null);
    return {
      n,
      mae: absSum / n,
      wape: actualSum ? (absSum / actualSum) * 100 : null,
      mape: withPct.length ? withPct.reduce((s, r) => s + Math.abs(r.variancePct), 0) / withPct.length : null,
      bias: rows.reduce((s, r) => s + r.variance, 0) / n,
      dateMae: dated.length ? dated.reduce((s, r) => s + Math.abs(r.dateError), 0) / dated.length : null,
      zeroActuals: rows.filter(r => r.actual === 0).length,
      rows,
      note: 'Errors measured against actuals. These are errors, not confidence intervals, '
        + 'and no probability is attached to them.',
    };
  }

  /* ── rolling-origin transfer baselines ───────────────────────────────── */

  /* The naive baselines the audit measured, reproduced here so the app can show
     WHY per-payout averaging is the wrong core model rather than just asserting
     it. At each origin only earlier transfers in the same stream are visible.

     These are reconstructed baselines, not forecasts that were saved at the
     time — the app labels them that way. */
  function rollingOriginBaselines(transfers, opts) {
    opts = opts || {};
    const minPrior = opts.minPrior == null ? 4 : opts.minPrior;
    const byAccount = new Map();
    for (const t of transfers) {
      let a = byAccount.get(t.account);
      if (!a) byAccount.set(t.account, a = []);
      a.push(t);
    }
    const out = new Map();
    for (const [account, list] of byAccount) {
      list.sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
      const events = [];
      for (let i = minPrior; i < list.length; i++) {
        const prior = list.slice(0, i);
        const origin = prior[prior.length - 1];
        const actual = list[i];
        /* date prediction: median of up to the last four inter-transfer gaps */
        const gaps = [];
        for (let j = Math.max(1, prior.length - 4); j < prior.length; j++) {
          gaps.push(CSV.daysBetween(prior[j - 1].date, prior[j].date));
        }
        gaps.sort((a, b) => a - b);
        const medianGap = gaps.length
          ? (gaps.length % 2 ? gaps[(gaps.length - 1) / 2]
            : Math.round((gaps[gaps.length / 2 - 1] + gaps[gaps.length / 2]) / 2))
          : null;
        const forecastDate = medianGap == null ? null : CSV.addDays(origin.date, medianGap);
        const last4 = prior.slice(-4);
        events.push({
          account, origin: origin.date, actualDate: actual.date, forecastDate,
          dateError: forecastDate ? CSV.daysBetween(forecastDate, actual.date) : null,
          actual: actual.amount,
          lastForecast: origin.amount,
          mean4Forecast: Math.round(last4.reduce((s, t) => s + t.amount, 0) / last4.length),
        });
      }
      out.set(account, events);
    }
    return out;
  }

  /* Score those baselines, optionally restricted to a date window. */
  function scoreBaselines(baselines, opts) {
    opts = opts || {};
    const from = opts.from, to = opts.to;
    const results = [];
    for (const [account, events] of baselines) {
      const sel = events.filter(e => (!from || e.actualDate >= from) && (!to || e.actualDate <= to));
      results.push({
        account, model: 'Last transfer',
        ...score(sel.map(e => ({ actual: e.actual, forecast: e.lastForecast, dateError: e.dateError }))),
      });
      results.push({
        account, model: 'Prior four mean',
        ...score(sel.map(e => ({ actual: e.actual, forecast: e.mean4Forecast, dateError: e.dateError }))),
      });
    }
    return results;
  }

  /* ── forecast vs actual ──────────────────────────────────────────────── */

  /* A saved forecast run is immutable. A revision creates a NEW record; the
     original keeps its own score, and the difference between the two request
     calendars is reported as a planning decision, not as forecast error. */
  function compareForecastToActual(original, actual, revision) {
    const byDate = new Map();
    for (const b of original.bridges || []) byDate.set(b.requestDate, b);

    const financial = [];
    const planningChanges = [];

    for (const a of actual.requests || []) {
      const f = byDate.get(a.date);
      if (f) {
        financial.push({
          date: a.date,
          forecastEligible: f.eligible,
          forecastRequested: f.requested,
          actualRequested: a.requested,
          actualDisbursed: a.disbursed == null ? null : a.disbursed,
          actualBankDate: a.bankDate || null,
          forecastBankDate: f.expectedBankReceipt ? f.expectedBankReceipt.date : null,
          bankDateError: (a.bankDate && f.expectedBankReceipt && f.expectedBankReceipt.date)
            ? CSV.daysBetween(f.expectedBankReceipt.date, a.bankDate) : null,
          bankTimingVerified: !!a.bankDate,
        });
        byDate.delete(a.date);
      } else {
        planningChanges.push({
          kind: 'request-added', date: a.date, amount: a.requested,
          message: 'A request was made on ' + a.date + ' that the saved forecast did not plan. '
            + 'This is a planning decision, not a forecast error.',
        });
      }
    }
    for (const [date, f] of byDate) {
      planningChanges.push({
        kind: 'request-not-made', date, plannedAmount: f.requested,
        message: 'The saved forecast planned a request on ' + date + ' that was not made. '
          + 'Scored as a schedule variance, not a financial error.',
      });
    }

    const eligibleScore = score(financial
      .filter(r => r.actualRequested != null && r.forecastEligible != null)
      .map(r => ({ actual: r.actualRequested, forecast: r.forecastEligible })));
    const disbursementScore = score(financial
      .filter(r => r.actualDisbursed != null && r.forecastRequested != null)
      .map(r => ({ actual: r.actualDisbursed, forecast: r.forecastRequested })));
    const bankTiming = financial.filter(r => r.bankDateError != null);

    return {
      originalRunId: original.runId,
      revisionRunId: revision ? revision.runId : null,
      immutable: true,
      financial,
      planningChanges,
      scores: {
        eligibleAtCutoff: eligibleScore,
        requestedVsDisbursed: disbursementScore,
        bankTiming: bankTiming.length
          ? { n: bankTiming.length, mae: bankTiming.reduce((s, r) => s + Math.abs(r.bankDateError), 0) / bankTiming.length }
          : { n: 0, mae: null, status: NOT_TESTED, missing: 'actual bank deposit dates' },
      },
      horizonTotals: horizonTotals(original, actual),
      note: 'Revised forecasts are scored separately and never overwrite this record.',
    };
  }

  /* Cash received over fixed horizons, so splitting one payout into several
     cannot look like an earnings change. */
  function horizonTotals(original, actual) {
    const out = {};
    for (const days of [14, 56]) {
      const from = original.cutoff || (original.horizon && original.horizon.from);
      if (!from) { out[days] = { status: NOT_TESTED, missing: 'a forecast cutoff date' }; continue; }
      const to = CSV.addDays(from, days);
      const f = (original.bridges || [])
        .filter(b => b.requestDate > from && b.requestDate <= to)
        .reduce((s, b) => s + (b.requested || 0), 0);
      const a = (actual.requests || [])
        .filter(r => r.date > from && r.date <= to)
        .reduce((s, r) => s + (r.requested || 0), 0);
      out[days] = {
        from, to, forecast: f, actual: a, variance: a - f,
        variancePct: a === 0 ? null : ((a - f) / Math.abs(a)) * 100,
      };
    }
    return out;
  }

  return {
    NOT_TESTED, PASS, VARIANCE,
    settlementBridge, matchBankDeposits, score,
    rollingOriginBaselines, scoreBaselines, compareForecastToActual, horizonTotals,
  };
});
