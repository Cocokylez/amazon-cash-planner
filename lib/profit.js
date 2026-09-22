/* The profitability engine.
 *
 * Separate from the cash engine on purpose. Product cost changes profit and
 * never changes what Amazon will pay out; a transfer moves cash and never
 * changes profit. The two must not borrow numbers from each other.
 *
 * The rule that shapes every result here: a measure is named for what it
 * actually covers. With incomplete product costs the bottom line is
 * "contribution after recorded costs", never "net profit" and never a "net
 * margin" — and the cost coverage travels beside the figure so the gap is
 * visible rather than implied.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./taxonomy.js'), require('./provenance.js'));
  } else root.Profit = factory(root.Taxonomy, root.Prov);
})(typeof self !== 'undefined' ? self : globalThis, function (Taxonomy, Prov) {

  const T = Taxonomy.TREAT;
  const C = Taxonomy.CAT;

  /* Which normalised subcategories are variable order costs (contribution) and
     which are period costs (operating). Anything unmapped stays visible in its
     own bucket rather than being silently swept into one or the other. */
  const VARIABLE_SUBS = new Set([
    'Combined order selling fees', 'Combined order FBA fees',
    'Non-apparel processing', 'Other transaction fees', 'Regulatory fee',
  ]);
  const PERIOD_SUBS = new Set([
    'Monthly FBA storage', 'Aged inventory', 'AWD storage', 'Subscription',
    'Removal return', 'Disposal', 'Grade and resell',
    'Coupon participation', 'Coupon performance', 'Deal participation',
    'Deal performance', 'Vine', 'Legacy deal fee', 'Price discount service fee',
    'Placement', 'Partnered carrier', 'AWD processing', 'AWD transport',
    'Defect', 'Defect reversal', 'Unplanned service', 'Unplanned service reversal',
    'Labels', 'Label credit', 'Return postage', 'Adjustment',
  ]);

  /* ── revenue ─────────────────────────────────────────────────────────── */

  /* Net revenue from signed components, excluding tax. Gross sales and refunded
     product sales are measured separately, because a Refund row's `total` also
     carries fee credits and tax and cannot be treated as refunded revenue. */
  function revenue(ledger, filter) {
    const ok = ledger.makePredicate(filter);
    const idx = n => ledger.COMPONENTS.indexOf(n);
    const ps = idx('product sales'), sc = idx('shipping credits'),
      gw = idx('gift wrap credits'), pr = idx('promotional rebates');
    const orderType = ledger.dicts.type.id('Order');
    const refundType = ledger.dicts.type.id('Refund');

    const out = {
      grossProductSales: 0, refundedProductSales: 0,
      shippingCredits: 0, giftWrapCredits: 0, promotionalRebates: 0,
      netRevenue: 0, orderRows: 0, refundRows: 0,
    };
    for (let i = 0; i < ledger.rowCount; i++) {
      if (!ok(i)) continue;
      const t = ledger.cols.type.a[i];
      const p = ledger.comp[ps].a[i];
      if (t === orderType) { if (p > 0) out.grossProductSales += p; out.orderRows++; }
      else if (t === refundType) { if (p < 0) out.refundedProductSales += p; out.refundRows++; }
      out.shippingCredits += ledger.comp[sc].a[i];
      out.giftWrapCredits += ledger.comp[gw].a[i];
      out.promotionalRebates += ledger.comp[pr].a[i];
      /* the signed sum across every row type, which is the actual net */
      out.netRevenue += p + ledger.comp[sc].a[i] + ledger.comp[gw].a[i] + ledger.comp[pr].a[i];
    }
    out.label = 'Net revenue including shipping and promotions';
    out.note = 'Signed product sales, shipping credits, gift wrap credits and promotional '
      + 'rebates, excluding all tax. Distinct from the preview\'s "Net sales".';
    return out;
  }

  /* ── costs ───────────────────────────────────────────────────────────── */

  /* Amazon-charged costs grouped the way the profit engine needs them. */
  function amazonCosts(ledger, filter) {
    const cats = ledger.componentTotals(filter);
    const out = {
      variable: 0, period: 0, advertising: 0, credits: 0,
      unclassified: 0, unclassifiedCredits: 0,
      lines: [], unmapped: [],
    };
    for (const [catName, cat] of cats) {
      if (catName === C.REVENUE || catName === C.TAX || catName === C.TRANSFER) continue;
      for (const [subName, sub] of cat.subs) {
        const line = {
          category: catName, subcategory: subName, treatment: sub.treatment,
          debit: sub.debit, credit: sub.credit, net: sub.net, rows: sub.rows,
          bucket: null,
        };
        if (catName === C.ADS) { line.bucket = 'advertising'; out.advertising += -sub.net; }
        else if (catName === C.CREDITS) { line.bucket = 'credit'; out.credits += sub.net; }
        else if (catName === C.UNCLASSIFIED) {
          line.bucket = 'unclassified';
          out.unclassified += sub.debit; out.unclassifiedCredits += sub.credit;
        } else if (VARIABLE_SUBS.has(subName)) { line.bucket = 'variable'; out.variable += -sub.net; }
        else if (PERIOD_SUBS.has(subName)) { line.bucket = 'period'; out.period += -sub.net; }
        else {
          line.bucket = 'unmapped';
          out.unmapped.push(line);
        }
        out.lines.push(line);
      }
    }
    return out;
  }

  /* ── product cost ────────────────────────────────────────────────────── */

  /* Effective-dated landed cost. `costs` is a list of
     { msku, currency, unitCost (cents), from, to, policy, evidence }.
     An unknown cost is UNKNOWN — never zero, never an average of the others. */
  function costFor(costs, msku, date) {
    let best = null;
    for (const c of costs) {
      if (c.msku !== msku) continue;
      if (c.from && date < c.from) continue;
      if (c.to && date > c.to) continue;
      if (!best || (c.from || '') > (best.from || '')) best = c;
    }
    return best;
  }

  /* Units sold per SKU from the ledger, with refunds tracked separately.
     A return does NOT automatically restore COGS — disposition decides, and
     without disposition evidence the restored quantity stays unknown. */
  function unitsBySku(ledger, filter) {
    const ok = ledger.makePredicate(filter);
    const orderType = ledger.dicts.type.id('Order');
    const refundType = ledger.dicts.type.id('Refund');
    const map = new Map();
    for (let i = 0; i < ledger.rowCount; i++) {
      if (!ok(i)) continue;
      const t = ledger.cols.type.a[i];
      if (t !== orderType && t !== refundType) continue;
      const sku = ledger.dicts.sku.get(ledger.cols.sku.a[i]);
      if (!sku) continue;
      const qRaw = ledger.dicts.quantity.get(ledger.cols.quantity.a[i]);
      const q = parseFloat(qRaw);
      if (!Number.isFinite(q)) continue;
      let m = map.get(sku);
      if (!m) map.set(sku, m = { msku: sku, unitsSold: 0, unitsRefunded: 0 });
      if (t === orderType) m.unitsSold += q; else m.unitsRefunded += q;
    }
    return map;
  }

  /* Matched COGS plus an honest coverage record. */
  function cogs(ledger, costs, filter, opts) {
    opts = opts || {};
    const units = unitsBySku(ledger, filter);
    const asOf = (filter && filter.to) || opts.asOf || null;
    let matched = 0, matchedUnits = 0, unmatchedUnits = 0;
    const missing = [], covered = [];
    for (const [sku, u] of units) {
      const c = asOf ? costFor(costs, sku, asOf) : costFor(costs, sku, '9999-12-31');
      if (!c || c.unitCost == null) {
        unmatchedUnits += u.unitsSold;
        missing.push({ msku: sku, unitsSold: u.unitsSold });
        continue;
      }
      /* Returns restore cost only where disposition says the unit is sellable
         again. With no disposition record, nothing is restored. */
      const restored = opts.restoreOnReturn && c.sellableOnReturn ? u.unitsRefunded : 0;
      const billable = u.unitsSold - restored;
      matched += billable * c.unitCost;
      matchedUnits += u.unitsSold;
      covered.push({ msku: sku, unitsSold: u.unitsSold, unitCost: c.unitCost, from: c.from, policy: c.policy || null });
    }
    const totalUnits = matchedUnits + unmatchedUnits;
    return {
      cogs: totalUnits ? matched : null,
      matchedUnits, unmatchedUnits, totalUnits,
      coverage: Prov.coverage(matchedUnits, totalUnits, 'units with a recorded product cost'),
      missing: missing.sort((a, b) => b.unitsSold - a.unitsSold),
      covered,
      complete: totalUnits > 0 && unmatchedUnits === 0,
      note: 'Inbound costs already capitalised into landed cost are not expensed again, '
        + 'and inventory purchase cash belongs in the Cash Plan, not here.',
    };
  }

  /* ── the statement ───────────────────────────────────────────────────── */

  /* Build the profit statement with names that match what is actually covered. */
  function statement(ledger, opts) {
    opts = opts || {};
    const filter = opts.filter || {};
    const rev = revenue(ledger, filter);
    const costs = amazonCosts(ledger, filter);
    const productCost = opts.productCosts ? cogs(ledger, opts.productCosts, filter, opts) : {
      cogs: null, coverage: Prov.coverage(0, 0, 'units with a recorded product cost'),
      complete: false, missing: [], unmatchedUnits: null,
      note: 'No product costs have been supplied.',
    };
    /* External operating costs the export cannot contain. */
    const operating = opts.operatingCosts || [];
    const operatingTotal = operating.length
      ? operating.reduce((s, o) => s + (o.amount || 0), 0) : null;

    /* Advertising billed outside Amazon still belongs in the period's P&L. */
    const externalAds = opts.externalAdvertising == null ? null : opts.externalAdvertising;
    const advertisingTotal = externalAds == null
      ? costs.advertising
      : costs.advertising + externalAds;

    const lines = [];
    const push = (label, amount, meta) => lines.push(Object.assign({ label, amount }, meta || {}));

    push('Gross product sales', rev.grossProductSales, { origin: 'ACTUAL' });
    push('Product refunds', rev.refundedProductSales, {
      origin: 'ACTUAL',
      note: 'Refunded product sales only. The rest of a Refund row is fee credits and tax, '
        + 'and is not counted here.',
    });
    push('Shipping credits', rev.shippingCredits, { origin: 'ACTUAL' });
    push('Gift wrap credits', rev.giftWrapCredits, { origin: 'ACTUAL' });
    push('Promotional rebates', rev.promotionalRebates, { origin: 'ACTUAL', note: 'Contra revenue.' });
    push(rev.label, rev.netRevenue, { origin: 'CALCULATED', emphasis: true });

    push('Amazon variable order fees', -costs.variable, { origin: 'ACTUAL' });
    push('Advertising', -advertisingTotal, {
      origin: externalAds == null ? 'ACTUAL' : 'CALCULATED',
      note: externalAds == null
        ? 'Amazon settlement deductions only. Settlement advertising stopped in June 2026; '
        + 'if it moved to a card or invoice, those amounts are not in this figure.'
        : 'Amazon deductions plus supplied external advertising billing.',
      incomplete: externalAds == null,
    });

    const grossProfit = productCost.cogs == null ? null : rev.netRevenue - productCost.cogs;
    push('Product cost (COGS)', productCost.cogs == null ? null : -productCost.cogs, {
      origin: productCost.cogs == null ? null : 'CALCULATED',
      missing: productCost.cogs == null ? 'effective-dated product and landed costs' : null,
      coverage: productCost.coverage,
    });

    const contribution = rev.netRevenue - costs.variable - advertisingTotal
      - (productCost.cogs == null ? 0 : productCost.cogs);

    /* The name changes with the evidence. */
    const contributionComplete = productCost.complete && externalAds != null;
    push(contributionComplete ? 'Contribution' : 'Contribution after recorded costs', contribution, {
      origin: 'CALCULATED', emphasis: true,
      incomplete: !contributionComplete,
      why: !productCost.complete
        ? (productCost.unmatchedUnits == null
          ? 'No product costs supplied, so this is before product cost entirely.'
          : productCost.unmatchedUnits + ' units sold have no recorded product cost.')
        : 'External advertising billing has not been supplied.',
    });

    push('Amazon period charges', -costs.period, { origin: 'ACTUAL' });
    push('Amazon credits and reimbursements', costs.credits, {
      origin: 'ACTUAL',
      note: 'Approved amounts only. Unconfirmed reimbursement claims are not included.',
    });
    push('Unresolved Amazon debits', -costs.unclassified, {
      origin: 'ACTUAL',
      note: 'Charges Amazon did not describe in enough detail to classify. Shown rather than '
        + 'buried in an "other" bucket.',
    });
    push('Unresolved Amazon credits', costs.unclassifiedCredits, { origin: 'ACTUAL' });
    push('Operating costs outside Amazon', operatingTotal == null ? null : -operatingTotal, {
      origin: operatingTotal == null ? null : 'ACTUAL',
      missing: operatingTotal == null ? 'operating costs (rent, software, wages, accountancy)' : null,
    });

    const operatingResult = operatingTotal == null ? null
      : contribution - costs.period + costs.credits - costs.unclassified
      + costs.unclassifiedCredits - operatingTotal;
    const operatingBeforeOpex = contribution - costs.period + costs.credits
      - costs.unclassified + costs.unclassifiedCredits;

    push(operatingTotal == null ? 'Operating result before external operating costs' : 'Operating profit',
      operatingTotal == null ? operatingBeforeOpex : operatingResult, {
      origin: 'CALCULATED', emphasis: true,
      incomplete: operatingTotal == null || !contributionComplete,
    });

    /* Net profit and net margin are withheld unless everything is covered. */
    const canClaimNetProfit = productCost.complete && operatingTotal != null && externalAds != null;
    const netProfit = canClaimNetProfit
      ? Prov.val(operatingResult, { origin: Prov.ORIGIN.CALCULATED })
      : Prov.unavailable(
        [!productCost.complete ? 'complete product costs' : null,
          operatingTotal == null ? 'operating costs outside Amazon' : null,
          externalAds == null ? 'advertising billed outside Amazon' : null,
          'financing and tax where relevant'].filter(Boolean).join(', '),
        { origin: Prov.ORIGIN.CALCULATED });

    return {
      period: { from: filter.from || null, to: filter.to || null },
      basis: filter.basis === 'release' ? 'funds release date' : 'posted date',
      basisNote: filter.basis === 'release' ? null
        : 'Posted date is used as a proxy for the economic period. Amazon does not supply an '
        + 'economic service period in this export.',
      revenue: rev,
      costs,
      productCost,
      lines,
      contribution,
      contributionComplete,
      operatingResult: operatingTotal == null ? operatingBeforeOpex : operatingResult,
      netProfit,
      netMargin: canClaimNetProfit && rev.netRevenue
        ? Prov.val(null, { origin: Prov.ORIGIN.CALCULATED })
        : Prov.unavailable('complete cost coverage before a margin can be named'),
      coverage: {
        productCost: productCost.coverage,
        operatingCosts: operatingTotal != null,
        externalAdvertising: externalAds != null,
      },
      /* Things that must never be done, asserted as data so the UI can show them */
      guards: [
        'Product cost reduces profit and never reduces Amazon available funds.',
        'Inventory purchases are cash commitments, not an expense on top of COGS.',
        'Transfers move cash and never affect profit.',
        'Returns do not automatically restore product cost; disposition decides.',
      ],
    };
  }

  /* Per-SKU economics, with unallocated account-level charges kept visible
     rather than spread across SKUs by an invented rule. */
  function bySku(ledger, opts) {
    opts = opts || {};
    const filter = opts.filter || {};
    const ok = ledger.makePredicate(filter);
    const idx = n => ledger.COMPONENTS.indexOf(n);
    const ps = idx('product sales'), sc = idx('shipping credits'), gw = idx('gift wrap credits'),
      pr = idx('promotional rebates'), sf = idx('selling fees'), ff = idx('fba fees');
    const orderType = ledger.dicts.type.id('Order');
    const refundType = ledger.dicts.type.id('Refund');

    const map = new Map();
    let unallocatedFees = 0, unallocatedRows = 0;
    for (let i = 0; i < ledger.rowCount; i++) {
      if (!ok(i)) continue;
      const sku = ledger.dicts.sku.get(ledger.cols.sku.a[i]);
      const t = ledger.cols.type.a[i];
      const isOrderish = t === orderType || t === refundType;
      if (!sku || !isOrderish) {
        /* Account-level charges have no SKU. They stay in their own line. */
        for (let c = 0; c < ledger.COMPONENTS.length; c++) {
          const v = ledger.comp[c].a[i];
          if (!v) continue;
          const cl = ledger.classifyAt(i, c);
          if (cl.treatment === Taxonomy.TREAT.EXPENSE) { unallocatedFees += -v; unallocatedRows++; }
        }
        continue;
      }
      let m = map.get(sku);
      if (!m) map.set(sku, m = {
        msku: sku, unitsSold: 0, unitsRefunded: 0,
        netRevenue: 0, sellingFees: 0, fbaFees: 0, rows: 0,
      });
      const q = parseFloat(ledger.dicts.quantity.get(ledger.cols.quantity.a[i]));
      if (Number.isFinite(q)) { if (t === orderType) m.unitsSold += q; else m.unitsRefunded += q; }
      m.netRevenue += ledger.comp[ps].a[i] + ledger.comp[sc].a[i]
        + ledger.comp[gw].a[i] + ledger.comp[pr].a[i];
      m.sellingFees += ledger.comp[sf].a[i];
      m.fbaFees += ledger.comp[ff].a[i];
      m.rows++;
    }

    const costs = opts.productCosts || [];
    const asOf = filter.to || '9999-12-31';
    const rows = [...map.values()].map(m => {
      const c = costFor(costs, m.msku, asOf);
      const cogsAmount = c && c.unitCost != null ? m.unitsSold * c.unitCost : null;
      return Object.assign(m, {
        unitCost: c && c.unitCost != null ? c.unitCost : null,
        cogs: cogsAmount,
        contribution: cogsAmount == null ? null
          : m.netRevenue + m.sellingFees + m.fbaFees - cogsAmount,
        contributionBeforeCost: m.netRevenue + m.sellingFees + m.fbaFees,
        costKnown: cogsAmount != null,
      });
    });

    return {
      rows: rows.sort((a, b) => b.netRevenue - a.netRevenue),
      unallocated: {
        amount: unallocatedFees, rows: unallocatedRows,
        note: 'Account-level Amazon charges with no SKU. They are not spread across products: '
          + 'a share of a storage bill allocated to one listing is a number with nothing '
          + 'behind it unless an allocation basis is chosen deliberately.',
      },
      costCoverage: Prov.coverage(
        rows.filter(r => r.costKnown).length, rows.length, 'SKUs with a recorded product cost'),
    };
  }

  return { revenue, amazonCosts, cogs, unitsBySku, costFor, statement, bySku, VARIABLE_SUBS, PERIOD_SUBS };
});
