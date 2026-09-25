/* The shared dataset every screen reads.
 *
 * THE BUG THIS MODULE EXISTS TO FIX
 *
 * Imported data reached exactly two places. `state.previews` was consumed only
 * by `previewCoverage()` and `currentForecast()`; Expenses, Profitability and
 * Reconciliation each opened with `if (!state.ledger) return needLedger(...)`
 * and never looked at a preview at all. So importing a Fees & Economics
 * Preview populated one branch of the app while three screens read a different
 * branch and reported nothing — the file was parsed, stored and listed, and
 * still invisible.
 *
 * There was no shared dataset. This is it.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not move numbers between sources to fill a gap. A preview carries
 * Amazon's FORECAST of sales and fees; the Payments export carries what
 * ACTUALLY happened. They are kept in separate branches with separate origins,
 * and a screen renders whichever branches exist. Nothing is averaged,
 * interpolated or promoted from forecast to actual.
 *
 * MONEY
 *
 * Preview amounts are exact BigInt decimals at 10 dp; ledger amounts are
 * integer cents. Everything leaving this module is integer cents, rounded once,
 * here — so screens never mix the two representations.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./money.js'), require('./preview.js'),
      require('./csv.js'), require('./taxonomy.js'), require('./profit.js'));
  } else root.Dataset = factory(root.Money, root.Preview, root.CSV, root.Taxonomy, root.Profit);
})(typeof self !== 'undefined' ? self : globalThis, function (Money, Preview, CSV, Tax, Profit) {

  const cents = d => (d == null ? null : Money.round(d));
  const addC = (a, b) => (a == null ? b : b == null ? a : a + b);

  /* ── the forecast branch, from Fees & Economics Preview files ─────────── */

  /* `window` optionally narrows to files overlapping [from,to]; a file is
     included whole or not at all, because a preview states a window total and
     slicing it would be inventing a daily split this branch does not claim. */
  /* Inclusive day count, on account-local calendar dates. */
  const daysIn = (from, to) => CSV.daysBetween(from, to) + 1;

  /* How much of a file's own period the selected range covers. */
  function overlapOf(period, window) {
    if (!period.start || !period.end) return null;
    const total = daysIn(period.start, period.end);
    if (!window || !window.from || !window.to) {
      return { days: total, total, complete: true, from: period.start, to: period.end };
    }
    const from = window.from > period.start ? window.from : period.start;
    const to = window.to < period.end ? window.to : period.end;
    if (to < from) return { days: 0, total, complete: false, from: null, to: null };
    const days = daysIn(from, to);
    return { days, total, complete: days === total, from, to };
  }

  function forecastBranch(previews, window) {
    /* Only the newest of any overlapping downloads is added - see
       Preview.active. The same forecast downloaded three days running used
       to count three times here too. */
    const all = Preview.activeFiles(previews || []);
    const files = all.filter(p => {
      if (!window || !window.from || !window.to) return true;
      if (!p.period.start || !p.period.end) return true;
      return !(p.period.end < window.from || p.period.start > window.to);
    });
    if (!files.length) {
      return {
        present: false, files: [], excluded: all.length,
        /* What IS available, so the caller can offer "view available period"
           instead of an unexplained blank. */
        availablePeriods: all.filter(p => p.period.start).map(p => ({
          from: p.period.start, to: p.period.end, name: p.name,
        })),
      };
    }

    const rows = [];
    for (const f of files) for (const r of f.rows) rows.push(r);

    let unitsSold = 0, unitsReturned = 0, netUnits = 0;
    let sales = null, netSales = null;
    let unitsKnown = false;
    for (const r of rows) {
      if (r.unitsSold != null) { unitsSold += r.unitsSold; unitsKnown = true; }
      if (r.unitsReturned != null) unitsReturned += r.unitsReturned;
      if (r.netUnits != null) netUnits += r.netUnits;
      if (r.sales != null) sales = sales == null ? r.sales : sales + r.sales;
      if (r.netSales != null) netSales = netSales == null ? r.netSales : netSales + r.netSales;
    }

    /* Fee families with the hierarchy rule applied: parents count, children
       explain. Absent columns stay absent rather than becoming zero. */
    const childNames = new Set(Preview.FEES.filter(f => f.parent).map(f => f.name));
    const fees = [];
    let feeTotal = null;            // parents only, advertising excluded
    let orderFees = null;           // the per-unit economics that become cash
    const ORDER_FAMILIES = ['Referral fee', 'FBA fulfillment fees', 'Closing fee',
      'Per-item selling fee', 'Returns processing fee for Apparel and Shoes',
      'Aged inventory surcharge'];

    for (const fam of Preview.FEES) {
      const t = Preview.familyTotal(rows, fam.name);
      const isChild = childNames.has(fam.name);
      const counted = !isChild && fam.group !== 'advertising';
      fees.push({
        name: fam.name, group: fam.group, parent: fam.parent || null,
        total: cents(t.total),
        populated: t.populated, blank: t.blank,
        columnPresent: t.absent < rows.length,
        nonAdditive: isChild,
        countedInTotal: counted,
        why: isChild ? 'Part of ' + fam.parent + ', shown to explain it — never added on top'
          : fam.group === 'advertising'
            ? 'Counted separately: whether it reduces Amazon cash depends on the billing method'
            : null,
      });
      if (counted && t.total != null) feeTotal = addC(feeTotal, cents(t.total));
      if (ORDER_FAMILIES.indexOf(fam.name) >= 0 && t.total != null) {
        orderFees = addC(orderFees, cents(t.total));
      }
    }

    const advertising = cents(Preview.familyTotal(rows, 'Sponsored Products charge').total);
    const storage = cents(Preview.familyTotal(rows, 'Monthly inventory storage fee').total);
    const netSalesC = cents(netSales);
    const netReceivable = netSalesC == null ? null : netSalesC - (orderFees || 0);

    /* Per-SKU, so Profitability can name what it is missing a cost for. */
    const bySku = new Map();
    for (const r of rows) {
      let e = bySku.get(r.msku);
      if (!e) {
        bySku.set(r.msku, e = {
          msku: r.msku, asin: r.asin, unitsSold: 0, netUnits: 0,
          netSales: null, orderFees: null, advertising: null,
        });
      }
      if (r.unitsSold != null) e.unitsSold += r.unitsSold;
      if (r.netUnits != null) e.netUnits += r.netUnits;
      if (r.netSales != null) e.netSales = addC(e.netSales, cents(r.netSales));
      for (const fam of ORDER_FAMILIES) {
        const f = r.fees[fam];
        if (f && f.total != null) e.orderFees = addC(e.orderFees, cents(f.total));
      }
      const ad = r.fees['Sponsored Products charge'];
      if (ad && ad.total != null) e.advertising = addC(e.advertising, cents(ad.total));
    }
    for (const e of bySku.values()) {
      e.contribution = e.netSales == null ? null : e.netSales - (e.orderFees || 0);
    }

    const starts = files.map(f => f.period.start).filter(Boolean).sort();
    const ends = files.map(f => f.period.end).filter(Boolean).sort();
    const currencies = [...new Set(files.map(f => f.currency).filter(Boolean))];
    const stores = [...new Set(files.map(f => f.store).filter(Boolean))];

    /* Coverage of the selection against each file's own period. */
    const overlaps = files.map(f => overlapOf(f.period, window)).filter(Boolean);
    const selDays = overlaps.reduce((a, o) => a + o.days, 0);
    const srcDays = overlaps.reduce((a, o) => a + o.total, 0);
    const partial = srcDays > 0 && selDays < srcDays;

    /* Pro rata, by calendar day, and named as such. Amazon states a window
       total; splitting it evenly is THIS app's model, not Amazon's figure, and
       is labelled MODEL FORECAST wherever it is shown. */
    const share = srcDays > 0 ? selDays / srcDays : 1;
    const prorate = v => (v == null ? null : Math.round(v * share));
    const selection = !partial ? null : {
      days: selDays, sourceDays: srcDays, share,
      method: 'Amazon states one total for each report period. The selected range covers '
        + selDays + ' of those ' + srcDays + ' days, so the figures below are that share of '
        + 'the period total, split evenly by calendar day. It is an estimate made by this app, '
        + 'not a figure Amazon supplied for these dates.',
      netSales: prorate(netSalesC),
      orderFees: prorate(orderFees),
      netReceivable: prorate(netReceivable),
      feeTotal: prorate(feeTotal),
      advertising: prorate(advertising),
      /* Storage is a monthly charge, not a daily accrual: a part-month
         selection does not make a part-month storage fee, so it is not
         prorated and is reported whole with that stated. */
      storage: storage,
      storageNote: 'Storage is charged once a month, so it is shown in full for the period '
        + 'rather than split across the selected days.',
    };

    return {
      present: true,
      files: files.map((f, i) => ({
        importId: f.importId, name: f.name, period: f.period, rows: f.rows.length,
        columns: f.columnCount, currency: f.currency, store: f.store,
        variant: f.variant, issues: f.issues || [],
        rowsProcessed: f.rowsProcessed, rowsAccepted: f.rowsAccepted,
        rejected: f.rejected || [],
        coverage: overlaps[i],
      })),
      /* Whole source periods, always Amazon's own numbers. */
      partial, selection,
      selectedDays: selDays, sourceDays: srcDays,
      availablePeriods: all.filter(p => p.period.start).map(p => ({
        from: p.period.start, to: p.period.end, name: p.name,
      })),
      excluded: (previews || []).length - files.length,
      period: { from: starts[0] || null, to: ends[ends.length - 1] || null },
      currency: currencies.length === 1 ? currencies[0] : null,
      store: stores.length === 1 ? stores[0] : null,
      skuCount: bySku.size,
      units: { sold: unitsKnown ? unitsSold : null, returned: unitsReturned, net: netUnits },
      sales: cents(sales),
      netSales: netSalesC,
      fees, feeTotal, orderFees, advertising, storage, netReceivable,
      bySku: [...bySku.values()].sort((a, b) => (b.netSales || 0) - (a.netSales || 0)),
      issues: files.reduce((acc, f) => acc.concat(f.issues || []), []),
    };
  }

  /* ── the actual branch, from the Payments transaction export ──────────── */

  function actualBranch(ledger, filter) {
    if (!ledger || !ledger.rowCount) return { present: false };
    const full = ledger.dateRange();
    const selected = ledger.summary(filter);
    if (!selected.rows) return { present: false, sourceRange: full, excludedByRange: true };
    if (filter && (filter.from || filter.to)) {
      const from = filter.from || full.from, to = filter.to || full.to;
      if (full.from && full.to && (to < full.from || from > full.to)) {
        return { present: false, sourceRange: full, excludedByRange: true };
      }
    }
    const cats = ledger.componentTotals(filter);
    const rev = Profit.revenue(ledger, filter);

    let gross = 0, credits = 0, adsGross = 0, adsCredit = 0;
    let unresolvedD = 0, unresolvedC = 0, reimbD = 0, reimbC = 0;
    const categories = [];
    for (const [name, c] of cats) {
      if (name === Tax.CAT.REVENUE || name === Tax.CAT.TAX || name === Tax.CAT.TRANSFER) continue;
      categories.push({
        name, debit: c.debit, credit: c.credit, net: c.net, rows: c.rows, subs: c.subs,
      });
      if (name === Tax.CAT.ADS) { adsGross += c.debit; adsCredit += c.credit; continue; }
      if (name === Tax.CAT.UNCLASSIFIED) { unresolvedD += c.debit; unresolvedC += c.credit; continue; }
      if (name === Tax.CAT.CREDITS) { reimbD += c.debit; reimbC += c.credit; continue; }
      gross += c.debit; credits += c.credit;
    }
    categories.sort((a, b) => (b.debit - b.credit) - (a.debit - a.credit));

    const range = ledger.dateRange();
    return {
      present: true,
      sourceRange: range,
      /* The dates on screen are the ones asked for; the source may hold more. */
      period: {
        from: (filter && filter.from) || range.from,
        to: (filter && filter.to) || range.to,
      },
      rowCount: selected.rows,
      netRevenue: rev.netRevenue,
      revenue: rev,
      categories,
      grossCharges: gross, credits,
      netCost: gross - credits,
      advertising: adsGross - adsCredit,
      unresolved: unresolvedD, unresolvedCredits: unresolvedC,
      reimbursements: reimbD - reimbC,
      months: ledger.monthly(filter),
    };
  }

  /* ── what each feature can and cannot do, given what is loaded ────────── */

  /* One list, computed once, so every screen agrees about what is possible and
     the app stops repeating the same warning in six places. */
  function readiness(ctx) {
    const f = ctx.forecast, a = ctx.actual;
    const has = {
      forecast: !!(f && f.present),
      actual: !!(a && a.present),
      balance: !!ctx.hasBalance,
      plans: !!ctx.hasPlans,
      deposits: !!ctx.hasBankDeposits,
      productCosts: !!ctx.hasProductCosts,
      operatingCosts: !!ctx.hasOperatingCosts,
      commitments: !!ctx.hasCommitments,
      bankCash: ctx.hasOpeningBankCash,
      adBilling: !!ctx.hasAdvertisingBilling,
    };

    const need = (label, where) => ({ label, where });
    const item = (id, label, ready, needs, screen) =>
      ({ id, label, ready, needs: needs || [], screen });

    return [
      item('forecast-sales', 'Forecast sales and fees', has.forecast,
        has.forecast ? [] : [need('a Fees & Economics Preview CSV', 'data')], 'forecast'),

      item('actual-expenses', 'Actual fees you have been charged', has.actual,
        has.actual ? [] : [need('the Payments date-range transaction CSV', 'data')], 'expenses'),

      item('payout-amount', 'How much you could request', has.balance,
        has.balance ? [] : [need('your current Amazon balances', 'data')], 'dashboard'),

      item('payout-timing', 'When a payout would be released', has.actual && has.balance,
        [].concat(has.actual ? [] : [need('the transaction CSV, to measure release timing', 'data')],
          has.balance ? [] : [need('your current Amazon balances', 'data')]), 'forecast'),

      item('bank-arrival', 'When cash reaches your bank', has.deposits,
        has.deposits ? [] : [need('bank deposit history to measure transit from', 'data')], 'forecast'),

      /* Actual or forecast: the Profitability screen works from either, and
         with a preview alone it shows each product's forecast profit. */
      item('product-profit', 'Profit per product', (has.actual || has.forecast) && has.productCosts,
        [].concat(has.actual || has.forecast ? [] : [need('the transaction CSV or a Fees & Economics Preview', 'data')],
          has.productCosts ? [] : [need('what each product costs you', 'data')]), 'profit'),

      item('spendable', 'What is safe to spend', has.bankCash && has.commitments,
        [].concat(has.bankCash ? [] : [need('your opening bank balance', 'plan')],
          has.commitments ? [] : [need('the bills already committed', 'plan')]), 'plan'),

      item('ad-cash', 'Whether advertising reduces Amazon cash', has.adBilling,
        has.adBilling ? [] : [need('how advertising is billed', 'data')], 'expenses'),
    ];
  }

  /* ── the whole thing ──────────────────────────────────────────────────── */

  function build(opts) {
    opts = opts || {};
    const filter = opts.filter || {};
    const win = opts.forecastWindow
      || (filter.from || filter.to ? { from: filter.from, to: filter.to } : null);
    const scoped = (opts.previews || []).filter(p =>
      (!filter.currency || p.currency === filter.currency) &&
      (!filter.marketplace || p.store === filter.marketplace));
    const currencies = [...new Set(scoped.map(p => p.currency).filter(Boolean))];
    const forecast = currencies.length > 1
      ? { present: false, files: [], reason: 'Select one currency before adding forecast amounts.' }
      : forecastBranch(scoped, win);
    const actual = actualBranch(opts.ledger, filter);
    const ctx = Object.assign({ forecast, actual }, opts.inputs || {});
    return {
      forecast, actual,
      window: win,
      readiness: readiness(ctx),
      anyData: forecast.present || actual.present,
      /* Something was imported, but the chosen range excludes all of it. */
      hiddenByRange: !forecast.present && !actual.present
        && ((opts.previews || []).length > 0 || !!(opts.ledger && opts.ledger.rowCount)),
    };
  }

  const blocking = list => list.filter(r => !r.ready);
  const ready = list => list.filter(r => r.ready);

  return { build, forecastBranch, actualBranch, readiness, blocking, ready, overlapOf };
});
