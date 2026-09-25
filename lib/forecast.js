/* The 56-day forecast: turning Amazon's preview estimates into dated cash events.
 *
 * The chain is deliberately explicit, because every link is a place a cash
 * forecast can quietly invent money:
 *
 *   preview window  ->  daily economic estimate  ->  posted date
 *                   ->  release date (per account stream)  ->  eligible funds
 *
 * Rules enforced here:
 *   - Only days actually covered by a preview produce events. A gap stays a
 *     gap; it is never interpolated or back-filled from a neighbouring window.
 *   - `Net sales` already has returns netted out of it, so expected refunds are
 *     NOT subtracted again.
 *   - Fee parents are used; their components are never added on top.
 *   - Release timing comes from matured-cohort lag observations per account
 *     stream, labelled MODEL FORECAST. There is no fixed posted+7 rule.
 *   - The preview has no account-type column, so the standard/invoiced split is
 *     either measured from history or overridden explicitly — never guessed.
 *   - Storage, subscriptions and other period charges are scheduled on their
 *     own observed cadence, not prorated because a preview window is half a
 *     month.
 *   - Unconfirmed reimbursements stay out of expected cash and are reported
 *     separately as potential upside.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'), require('./money.js'),
      require('./preview.js'), require('./cash.js'));
  } else root.Forecast = factory(root.CSV, root.Money, root.Preview, root.Cash);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Money, Preview, Cash) {

  /* Split `totalCents` across `n` weighted days so the parts sum EXACTLY to the
     total. Largest-remainder: no cent is created and none is lost. */
  function allocate(totalCents, weights) {
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!sum) return weights.map(() => 0);
    const exact = weights.map(w => (totalCents * w) / sum);
    const floor = exact.map(x => Math.floor(x));
    let remainder = totalCents - floor.reduce((a, b) => a + b, 0);
    const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac);
    const out = floor.slice();
    for (let k = 0; k < order.length && remainder > 0; k++) { out[order[k].i]++; remainder--; }
    for (let k = order.length - 1; k >= 0 && remainder < 0; k--) { out[order[k].i]--; remainder++; }
    return out;
  }

  /* Weekday demand weights measured from the ledger. Returns null when there is
     not enough history, and the caller then falls back to a UNIFORM allocation
     that is labelled as an assumption on screen. */
  function weekdayWeights(ledger, opts) {
    opts = opts || {};
    if (!ledger) return null;
    const from = opts.from, to = opts.to;
    const totals = [0, 0, 0, 0, 0, 0, 0], counts = [0, 0, 0, 0, 0, 0, 0];
    const psIdx = ledger.COMPONENTS.indexOf('product sales');
    const orderType = ledger.dicts.type.id('Order');
    const fromDay = from ? ledger.dayNum({ y: +from.slice(0, 4), m: +from.slice(5, 7) - 1, d: +from.slice(8, 10) }) : -Infinity;
    const toDay = to ? ledger.dayNum({ y: +to.slice(0, 4), m: +to.slice(5, 7) - 1, d: +to.slice(8, 10) }) : Infinity;
    const seenDays = new Set();
    for (let i = 0; i < ledger.rowCount; i++) {
      if (ledger.cols.type.a[i] !== orderType) continue;
      const d = ledger.cols.postedDay.a[i];
      if (d < fromDay || d > toDay) continue;
      const date = ledger.dayToDate(d);
      const w = CSV.weekdayOf(date);
      totals[w] += ledger.comp[psIdx].a[i];
      if (!seenDays.has(d)) { seenDays.add(d); counts[w]++; }
    }
    const grand = totals.reduce((a, b) => a + b, 0);
    if (!grand || counts.some(c => c === 0)) return null;
    /* average per calendar day of that weekday, normalised to mean 1 */
    const perDay = totals.map((t, w) => t / counts[w]);
    const mean = perDay.reduce((a, b) => a + b, 0) / 7;
    return {
      weights: perDay.map(x => x / mean),
      basis: 'measured from order product sales, ' + (from || 'start') + ' to ' + (to || 'end'),
      days: seenDays.size,
      origin: 'MODEL FORECAST',
    };
  }

  /* The standard/invoiced revenue split measured from history. The preview
     cannot supply it, so it is either measured or explicitly overridden. */
  function accountMix(ledger, opts) {
    opts = opts || {};
    if (!ledger) return null;
    const psIdx = ledger.COMPONENTS.indexOf('product sales');
    const fromDay = opts.from ? ledger.dayNum({ y: +opts.from.slice(0, 4), m: +opts.from.slice(5, 7) - 1, d: +opts.from.slice(8, 10) }) : -Infinity;
    const toDay = opts.to ? ledger.dayNum({ y: +opts.to.slice(0, 4), m: +opts.to.slice(5, 7) - 1, d: +opts.to.slice(8, 10) }) : Infinity;
    const byAcct = new Map();
    for (let i = 0; i < ledger.rowCount; i++) {
      const d = ledger.cols.postedDay.a[i];
      if (d < fromDay || d > toDay) continue;
      const v = ledger.comp[psIdx].a[i];
      if (v <= 0) continue;
      const a = ledger.dicts.accountType.get(ledger.cols.accountType.a[i]);
      byAcct.set(a, (byAcct.get(a) || 0) + v);
    }
    const total = [...byAcct.values()].reduce((a, b) => a + b, 0);
    if (!total) return null;
    const shares = {};
    for (const [a, v] of byAcct) shares[a] = v / total;
    return {
      shares, total,
      basis: 'measured from order product sales, ' + (opts.from || 'start') + ' to ' + (opts.to || 'end'),
      origin: 'MODEL FORECAST',
    };
  }

  /* ── building the daily economic series ──────────────────────────────── */

  /* Turn preview files into per-day, per-account net receivable events.
     Returns events plus the assumption record that produced them. */
  function buildDailyEconomics(opts) {
    /* Overlapping downloads are versions of one forecast: only the newest is
       added (see Preview.active). Adding all of them counted it three times. */
    const chosen = Preview.active(opts.previewFiles || []);
    const files = chosen.files;
    const from = opts.from, to = opts.to;
    const cov = Preview.coverage(files, from, to);
    const weights = opts.weekdayWeights || null;
    const mix = opts.accountMix;
    const assumptions = [];
    const days = [];

    /* A missing account split blocks RELEASE TIMING, not the economics. The
       preview states its own sales and fees; splitting them across account
       streams is a later step. Returning nothing here was hiding a file that
       had already been read successfully, so the economics are always built
       and the split is reported as the thing that is missing. */
    const mixAvailable = !!(mix && mix.shares);

    assumptions.push({
      id: 'weekday-allocation',
      label: weights ? 'Daily split of each preview window' : 'Daily split of each preview window',
      value: weights ? 'weekday weights ' + weights.weights.map(w => w.toFixed(2)).join('/') : 'uniform across every day',
      origin: weights ? 'MODEL FORECAST' : 'ASSUMPTION',
      basis: weights ? weights.basis : 'No weekday pattern was measured, so each day in a '
        + 'window carries an equal share. This is an assumption, not a measurement.',
    });
    assumptions.push(mixAvailable ? {
      id: 'account-mix',
      label: 'Standard vs invoiced split of forecast sales',
      value: Object.entries(mix.shares).map(([k, v]) => k + ' ' + (v * 100).toFixed(1) + '%').join(', '),
      origin: mix.origin || 'ASSUMPTION',
      basis: mix.basis,
    } : {
      id: 'account-mix',
      label: 'Standard vs invoiced split of forecast sales',
      value: 'not established',
      origin: 'ASSUMPTION',
      basis: 'The Fees & Economics Preview has no account type column, and no transaction '
        + 'history has been loaded to measure the split from. The economics below are still '
        + 'Amazon\'s own figures; only the release timing per stream is unavailable.',
    });
    assumptions.push({
      id: 'returns-netting',
      label: 'Returns treatment',
      value: 'already inside Net sales',
      origin: 'CALCULATED',
      basis: 'The preview\'s Net sales is Sales less forecast returns. Expected refunds are '
        + 'therefore not subtracted a second time.',
    });
    assumptions.push({
      id: 'fee-parents',
      label: 'Fee basis',
      value: 'parent aggregates only',
      origin: 'AMAZON FORECAST',
      basis: 'FBA fulfilment and monthly storage use the reported parent totals. Base '
        + 'fulfilment, fuel, low-inventory and storage utilisation are components and are '
        + 'never added on top.',
    });

    for (const file of files) {
      if (!file.period.start || !file.period.end) continue;
      /* only the days of this window that fall inside the horizon */
      const winDays = [];
      let d = file.period.start;
      while (d <= file.period.end) {
        if (d >= from && d <= to) winDays.push(d);
        d = CSV.addDays(d, 1);
      }
      if (!winDays.length) continue;

      /* Whole-window totals, then split. Fees use parents only. */
      let netSales = null;
      for (const r of file.rows) if (r.netSales != null) netSales = netSales == null ? r.netSales : netSales + r.netSales;
      const referral = Preview.familyTotal(file.rows, 'Referral fee').total;
      const fba = Preview.familyTotal(file.rows, 'FBA fulfillment fees').total;
      const closing = Preview.familyTotal(file.rows, 'Closing fee').total;
      const perItem = Preview.familyTotal(file.rows, 'Per-item selling fee').total;
      const apparelReturns = Preview.familyTotal(file.rows, 'Returns processing fee for Apparel and Shoes').total;
      const aged = Preview.familyTotal(file.rows, 'Aged inventory surcharge').total;
      const ads = Preview.familyTotal(file.rows, 'Sponsored Products charge').total;
      const storage = Preview.familyTotal(file.rows, 'Monthly inventory storage fee').total;

      const c = v => (v == null ? null : Money.round(v));
      const orderFeeCents = [referral, fba, closing, perItem, apparelReturns, aged]
        .filter(v => v != null).reduce((s, v) => s + Money.round(v), 0);

      /* Per-unit order economics become available cash; period charges do not. */
      const netReceivable = c(netSales) == null ? null : c(netSales) - orderFeeCents;

      const dayWeights = winDays.map(day => weights ? weights.weights[CSV.weekdayOf(day)] : 1);
      const salesByDay = netReceivable == null ? null : allocate(netReceivable, dayWeights);

      for (let i = 0; i < winDays.length; i++) {
        days.push({
          date: winDays[i],
          netReceivable: salesByDay ? salesByDay[i] : null,
          sourceFile: file.name,
          window: file.period.start + '..' + file.period.end,
          origin: 'AMAZON FORECAST',
          /* Period charges are carried on the window, not smeared per day. */
          windowStorage: c(storage),
          windowAdvertising: c(ads),
          storageColumnPresent: storage != null,
        });
      }
    }

    days.sort((a, b) => a.date < b.date ? -1 : 1);
    if (chosen.superseded.length) {
      assumptions.push({
        id: 'overlapping-previews',
        label: 'Overlapping forecast downloads',
        value: 'newest counted; ' + chosen.superseded.length + ' older '
          + (chosen.superseded.length === 1 ? 'one' : 'ones') + ' not added',
        origin: 'CALCULATED',
        basis: 'Each download is Amazon\'s whole estimate for its window. Where windows overlap '
          + 'they are versions of the same forecast, so only the newest counts - adding them '
          + 'would count the same sales and fees more than once.',
      });
    }
    return {
      days, coverage: cov, assumptions, blocked: null, mixAvailable,
      superseded: chosen.superseded.map(s => ({ name: s.file.name, by: s.by.name })),
      /* What the economics alone cannot tell you. */
      missingForTiming: mixAvailable ? null
        : 'the standard/invoiced account split for future sales',
    };
  }

  /* ── release timing ──────────────────────────────────────────────────── */

  /* Turn posted-date economics into release events using the observed lag for
     each account stream. Amounts are split by the account mix first, so each
     stream gets its own lag. Everything produced here is MODEL FORECAST. */
  function releaseEvents(dailyDays, opts) {
    const mix = opts.accountMix.shares;
    const lags = opts.releaseLags;              // Map account -> {median,p10,p90}
    const scenario = opts.scenario || 'base';
    const out = [];
    const unknownTiming = [];

    for (const day of dailyDays) {
      if (day.netReceivable == null) continue;
      const accounts = Object.keys(mix);
      const parts = allocate(day.netReceivable, accounts.map(a => mix[a]));
      accounts.forEach((acct, i) => {
        const amount = parts[i];
        if (!amount) return;
        const lag = lags.get ? lags.get(acct) : lags[acct];
        if (!lag || lag.median == null) {
          unknownTiming.push({ date: day.date, account: acct, amount });
          return;
        }
        const days = scenario === 'low' ? lag.p90 : scenario === 'high' ? lag.p10 : lag.median;
        out.push({
          kind: Cash.EV.NEW_AVAILABLE,
          date: CSV.addDays(day.date, days),
          postedDate: day.date,
          amount, account: acct,
          label: 'Forecast net order receipts',
          origin: 'MODEL FORECAST',
          lagDays: days,
          lagBasis: 'observed posted-to-release lag, matured cohorts, ' + acct,
          sourceFile: day.sourceFile,
        });
      });
    }
    return { events: out, unknownTiming };
  }

  /* Period charges on their own observed cadence. Storage historically debits
     around the 7th; that is a posting pattern from history, NOT a rule, and it
     is labelled as such. A half-month preview window never triggers half a
     monthly storage charge, and never two. */
  function periodChargeEvents(dailyDays, opts) {
    const out = [];
    const notes = [];
    const byMonth = new Map();
    for (const d of dailyDays) {
      const mo = d.date.slice(0, 7);
      let m = byMonth.get(mo);
      if (!m) byMonth.set(mo, m = { month: mo, storageWindows: new Map(), adsWindows: new Map() });
      if (d.windowStorage != null) m.storageWindows.set(d.window, d.windowStorage);
      if (d.windowAdvertising != null) m.adsWindows.set(d.window, d.windowAdvertising);
    }

    for (const [mo, m] of byMonth) {
      /* Storage: one monthly charge. If more than one window in the month
         reports a storage total, they are DIFFERENT halves of the same monthly
         fee in Amazon's preview, so the largest is used once and the ambiguity
         is reported rather than summed. */
      const vals = [...m.storageWindows.values()];
      if (!vals.length) {
        notes.push({
          month: mo, kind: 'storage',
          message: 'No storage columns in the preview covering ' + mo
            + '. Storage cost for that month is UNKNOWN, not zero.',
        });
      } else {
        const amount = Math.max(...vals);
        if (vals.length > 1) {
          notes.push({
            month: mo, kind: 'storage',
            message: mo + ' has ' + vals.length + ' preview windows reporting storage. '
              + 'One monthly charge is scheduled, not the sum, and the windows are listed '
              + 'for review.',
            windows: [...m.storageWindows.keys()],
          });
        }
        const day = opts.storageDayOfMonth || 7;
        out.push({
          kind: Cash.EV.CHARGE,
          date: mo + '-' + String(day).padStart(2, '0'),
          amount, label: 'Monthly FBA storage',
          origin: 'AMAZON FORECAST',
          basis: 'Amount from the preview; posting date follows the historical pattern of '
            + 'storage debiting around the ' + day + 'th. That is an observed pattern, not a '
            + 'stated Amazon policy, and the economic service month is not established by it.',
          nonAdditiveWithComponents: true,
        });
      }
    }
    return { events: out, notes };
  }

  /* Advertising only reduces Amazon funds when Amazon actually deducts it.
     The payment method is an effective-dated record; with no evidence, the
     deduction is NOT modelled and the fact is reported. */
  function advertisingEvents(dailyDays, opts) {
    const method = opts.advertisingPaymentMethod;   // {method, from, to, evidence}
    const notes = [];
    const out = [];
    const windows = new Map();
    for (const d of dailyDays) if (d.windowAdvertising != null) windows.set(d.window, { amount: d.windowAdvertising, start: d.date });

    if (!method || !method.method || method.method === 'unknown') {
      notes.push({
        kind: 'advertising',
        message: 'Advertising is forecast at '
          + Money.fmt([...windows.values()].reduce((s, w) => s + w.amount, 0))
          + ' across the covered windows, but the billing method is not recorded. '
          + 'Settlement deductions stopped in June 2026, so it is not modelled as an Amazon '
          + 'deduction here. It still affects profitability in its service period.',
        missing: 'advertising payment-method history and invoices from May 2026 onward',
      });
      return { events: out, notes };
    }
    if (method.method === 'amazon_deduction') {
      for (const [win, w] of windows) {
        out.push({
          kind: Cash.EV.CHARGE, date: w.start, amount: w.amount,
          label: 'Advertising deducted by Amazon', origin: 'AMAZON FORECAST',
          basis: 'Payment method recorded as an Amazon settlement deduction from '
            + method.from + (method.evidence ? '; evidence: ' + method.evidence : ''),
          window: win,
        });
      }
    } else {
      notes.push({
        kind: 'advertising',
        message: 'Advertising is billed by ' + method.method + ', so it reduces company bank '
          + 'cash on its payment date and does not reduce Amazon funds. It is carried into '
          + 'the Cash Plan as a commitment and into profitability in its service period.',
      });
    }
    return { events: out, notes };
  }

  /* ── the whole forecast ──────────────────────────────────────────────── */

  /* Assemble everything into an immutable forecast run. `knownAt` fixes the
     information cutoff so a later replay cannot borrow facts from the future. */
  function build(opts) {
    const from = opts.from, to = opts.to;
    const runId = opts.runId || ('run-' + Date.now());
    const scenario = opts.scenario || 'base';

    const econ = buildDailyEconomics({
      previewFiles: opts.previewFiles, from, to,
      weekdayWeights: opts.weekdayWeights, accountMix: opts.accountMix,
    });

    const limitations = [];
    if (econ.blocked) limitations.push({ kind: 'blocked', missing: econ.blocked, message: econ.note });
    const lagsAvailable = !!(opts.releaseLags
      && (opts.releaseLags.size ? opts.releaseLags.size > 0 : Object.keys(opts.releaseLags).length > 0));
    if (!econ.mixAvailable || !lagsAvailable) {
      limitations.push({
        kind: 'no-cash-timing',
        missing: 'the Payments date-range transaction CSV',
        message: 'Amazon\'s forecast economics below are complete and are shown in full. '
          + 'Turning them into dated bank receipts needs the transaction history, which is '
          + 'where the posted-to-release lag and the standard/invoiced split are measured. '
          + 'Neither is assumed, so the payout schedule stays unavailable until that file is '
          + 'imported.',
      });
    }
    for (const g of econ.coverage.gaps) {
      limitations.push({
        kind: 'coverage-gap', from: g.from, to: g.to,
        message: 'No Fees & Economics Preview covers ' + g.from + ' to ' + g.to
          + '. Those days produce no forecast activity and are shown as uncovered. '
          + 'Neighbouring windows are not stretched to fill the gap.',
        missing: 'the Fees & Economics Preview for ' + g.from + ' to ' + g.to,
      });
    }

    const rel = econ.days.length && econ.mixAvailable && lagsAvailable
      ? releaseEvents(econ.days, { accountMix: opts.accountMix, releaseLags: opts.releaseLags, scenario })
      : { events: [], unknownTiming: [] };
    if (rel.unknownTiming.length) {
      limitations.push({
        kind: 'unknown-release-timing',
        message: rel.unknownTiming.length + ' forecast day/account amounts have no observed '
          + 'release lag and are held in an unknown-timing bucket rather than assumed immediate.',
        amount: rel.unknownTiming.reduce((s, x) => s + x.amount, 0),
      });
    }

    const charges = periodChargeEvents(econ.days, opts);
    const ads = advertisingEvents(econ.days, opts);

    const events = [].concat(rel.events, charges.events, ads.events);
    const notes = [].concat(charges.notes, ads.notes);

    return {
      runId, scenario,
      knownAt: opts.knownAt || new Date().toISOString(),
      cutoff: opts.cutoff || null,
      horizon: { from, to, days: CSV.daysBetween(from, to) + 1 },
      events,
      dailyEconomics: econ.days,
      superseded: econ.superseded || [],
      coverage: econ.coverage,
      assumptions: econ.assumptions.concat(opts.extraAssumptions || []),
      limitations, notes,
      /* True when the preview economics are present but cannot be dated. */
      economicsOnly: !econ.mixAvailable || !lagsAvailable,
      unknownTiming: rel.unknownTiming,
      sourceVersions: (opts.previewFiles || []).map(f => ({ name: f.name, hash: f.hash, period: f.period })),
      /* Potential credits that deliberately do NOT count as expected cash. */
      potentialCredits: opts.potentialCredits || [],
    };
  }

  /* Group forecast bank receipts into calendar weeks, as the Payout Forecast
     screen displays them. */
  function byBankWeek(bridges, from, to) {
    const weeks = new Map();
    let d = from;
    while (d <= to) {
      const wd = CSV.weekdayOf(d);
      const start = CSV.addDays(d, -((wd + 6) % 7));       // week starts Monday
      if (!weeks.has(start)) {
        weeks.set(start, { weekStart: start, weekEnd: CSV.addDays(start, 6), receipts: [], total: 0, unknown: 0 });
      }
      d = CSV.addDays(d, 1);
    }
    for (const b of bridges) {
      const r = b.expectedBankReceipt;
      if (!r || !r.date) {
        const anyWeek = weeks.get([...weeks.keys()].sort()[0]);
        if (anyWeek) anyWeek.unknown += (b.requested || 0);
        continue;
      }
      const wd = CSV.weekdayOf(r.date);
      const start = CSV.addDays(r.date, -((wd + 6) % 7));
      let w = weeks.get(start);
      if (!w) weeks.set(start, w = { weekStart: start, weekEnd: CSV.addDays(start, 6), receipts: [], total: 0, unknown: 0 });
      w.receipts.push(b);
      w.total += b.requested || 0;
    }
    return [...weeks.values()].sort((a, b) => a.weekStart < b.weekStart ? -1 : 1);
  }

  return {
    allocate, weekdayWeights, accountMix, buildDailyEconomics,
    releaseEvents, periodChargeEvents, advertisingEvents, build, byBankWeek,
  };
});
