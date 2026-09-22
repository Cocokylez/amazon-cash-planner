/* Component-level expense taxonomy, version 1.
 *
 * Classification happens per MONETARY COMPONENT, not per row. One Payments row
 * can carry revenue, tax, a selling fee and an FBA fee at once, and the row's
 * `type` alone cannot tell you what the `other` column means — `other` holds
 * transfers, storage, reimbursements, subscriptions and adjustments in this
 * file. So each of the 15 component columns is classified on its own, using
 * type + description + column.
 *
 * Precedence is array order: specific description rules first, generic column
 * rules last. Anything unmatched lands in a VISIBLE unclassified bucket — never
 * a silent "other".
 *
 * Every rule below was written against the 51 distinct (type, description)
 * families actually present in the 2025-08..2026-08 export, and the totals are
 * asserted in test/taxonomy.test.js.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Taxonomy = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const RULE_VERSION = 'tax-v1';

  /* How a component behaves in the two engines. These are independent: a
     transfer moves cash but is not an expense; a reserve movement changes
     availability but never profit. */
  const TREAT = {
    REVENUE: 'revenue',            // net revenue, excluding tax
    TAX: 'tax_clearing',           // collected/withheld, nets to zero
    EXPENSE: 'expense',            // platform charge
    CREDIT: 'credit',              // platform credit / reimbursement
    TRANSFER: 'transfer',          // cash out of Amazon, not an expense
    BALANCE: 'balance_movement',   // reserve/deferral movement, no profit effect
    UNCLASSIFIED: 'unclassified',
  };

  /* Top-level categories shown on Amazon Expenses. */
  const CAT = {
    REVENUE: 'Revenue',
    TAX: 'Tax clearing',
    SELLING: 'Selling',
    FBA: 'FBA fulfilment',
    STORAGE: 'Inventory & storage',
    ADS: 'Advertising',
    RETURNS: 'Returns & refunds',
    INBOUND: 'Inbound & logistics',
    SERVICES: 'Seller services',
    SHIPPING: 'Shipping',
    CREDITS: 'Credits & reimbursements',
    TRANSFER: 'Transfers',
    UNCLASSIFIED: 'Unclassified',
  };

  const eq = s => d => d === s;
  const starts = s => d => d.indexOf(s) === 0;
  const isOrderish = t => t === 'Order' || t === 'Refund';

  /* Extractors keep source provenance that would otherwise be lost when a
     description is reduced to a category. */
  function extractReturnsFee(desc) {
    const m = /for ASIN:\s*([A-Z0-9]+)\s*\(([^)]*)\)/.exec(desc);
    if (!m) return null;
    return { asin: m[1], assessmentWindow: m[2] };
  }
  function extractTransfer(desc) {
    const acct = /ending in:?\s*(\S+)/i.exec(desc);
    const tid = /Bank Transfer ID:?\s*(\S+)/i.exec(desc);
    return {
      destinationRef: acct ? acct[1] : null,
      bankTransferId: tid ? tid[1] : null,
      originalText: desc,
    };
  }
  const extractSafeT = desc => {
    const m = /SAFE-T Claim ID:\s*(\S+)/i.exec(desc);
    return m ? { claimRef: m[1] } : null;
  };

  /* ── the rules ───────────────────────────────────────────────────────── */
  /* `col` restricts a rule to one component column; omit to match any column.
     `type` / `desc` restrict on the source fields. First match wins. */

  const RULES = [
    /* --- transfers: cash movement, excluded from expenses and profit ----- */
    {
      id: 'transfer', type: eq('Transfer'), col: 'other',
      cat: CAT.TRANSFER, sub: 'Bank transfer', treat: TREAT.TRANSFER,
      extract: extractTransfer,
      note: 'Cash leaving Amazon. Never an expense; matched to bank deposits separately.',
    },

    /* --- tax clearing --------------------------------------------------- */
    {
      id: 'retrocharge', type: t => t === 'Order_Retrocharge' || t === 'Refund_Retrocharge',
      cat: CAT.TAX, sub: 'Retrocharge', treat: TREAT.TAX,
      note: 'Tax clearing by component, not a fee.',
    },

    /* --- storage, both label generations -------------------------------- */
    {
      id: 'storage-monthly', desc: d => d === 'FBA storage fee' || d === 'FBA Inventory Storage Fee',
      cat: CAT.STORAGE, sub: 'Monthly FBA storage', treat: TREAT.EXPENSE,
      note: 'Amazon renamed this charge in July 2026; both labels are the same fee.',
    },
    {
      id: 'storage-aged', desc: d => d === 'FBA Long-Term Storage Fee' || d === 'FBA Long Term Storage Fee',
      cat: CAT.STORAGE, sub: 'Aged inventory', treat: TREAT.EXPENSE,
      note: 'Spelling differs between source rows; same fee.',
    },
    {
      id: 'removal-return', desc: eq('FBA Removal Order: Return Fee'),
      cat: CAT.STORAGE, sub: 'Removal return', treat: TREAT.EXPENSE,
    },
    {
      id: 'removal-disposal', desc: eq('FBA Removal Order: Disposal Fee'),
      cat: CAT.STORAGE, sub: 'Disposal', treat: TREAT.EXPENSE,
    },
    {
      id: 'awd-storage', desc: eq('AWD Storage Fee'),
      cat: CAT.STORAGE, sub: 'AWD storage', treat: TREAT.EXPENSE,
    },
    {
      id: 'grade-resell', desc: d => d === 'Grade and Resell Charge' || d === 'Grade and Resell Fees',
      cat: CAT.STORAGE, sub: 'Grade and resell', treat: TREAT.EXPENSE,
    },

    /* --- advertising ---------------------------------------------------- */
    {
      id: 'ads-cost', desc: eq('Cost of Advertising'),
      cat: CAT.ADS, sub: 'Type unspecified', treat: TREAT.EXPENSE,
      note: 'Advertising deducted inside the settlement. Subtype is not stated in this source — '
        + 'do not relabel as Sponsored Products.',
    },
    {
      id: 'ads-refund', desc: eq('Refund for Advertiser'),
      cat: CAT.ADS, sub: 'Advertising credit', treat: TREAT.CREDIT,
    },

    /* --- returns -------------------------------------------------------- */
    {
      id: 'returns-nonapparel', desc: starts('FBA Customer Returns Fee (Non-Apparel and Non-Shoes)'),
      cat: CAT.RETURNS, sub: 'Non-apparel processing', treat: TREAT.EXPENSE,
      extract: extractReturnsFee,
      note: 'ASIN and assessment window preserved. The window is the charge basis Amazon '
        + 'states; it is not proof of the economic accrual period.',
    },

    /* --- inbound & logistics -------------------------------------------- */
    {
      id: 'inbound-placement', desc: eq('FBA Inbound Placement Service Fee'),
      cat: CAT.INBOUND, sub: 'Placement', treat: TREAT.EXPENSE,
      note: 'Posts under Service Fee/other and FBA Transaction fees/fba fees. Classified once.',
    },
    {
      id: 'inbound-carrier', desc: eq('FBA Amazon-Partnered Carrier Shipment Fee'),
      cat: CAT.INBOUND, sub: 'Partnered carrier', treat: TREAT.EXPENSE,
    },
    {
      id: 'awd-processing', desc: eq('AWD Processing Fee'),
      cat: CAT.INBOUND, sub: 'AWD processing', treat: TREAT.EXPENSE,
    },
    {
      id: 'awd-transport', desc: eq('AWD Transportation Fee'),
      cat: CAT.INBOUND, sub: 'AWD transport', treat: TREAT.EXPENSE,
    },
    {
      id: 'inbound-defect', desc: eq('Inbound Defect Fee'), type: t => t === 'FBA Transaction fees',
      cat: CAT.INBOUND, sub: 'Defect', treat: TREAT.EXPENSE,
    },
    {
      id: 'inbound-defect-rev', desc: eq('Inbound Defect Fee'), type: t => /Reversal/.test(t),
      cat: CAT.INBOUND, sub: 'Defect reversal', treat: TREAT.CREDIT,
      note: 'Charges and reversals are shown separately — this is not zero activity.',
    },
    {
      id: 'unplanned-service', desc: eq('Unplanned Service Charge - Deleted/Abandoned Shipments'),
      type: t => !/Reversal/.test(t),
      cat: CAT.INBOUND, sub: 'Unplanned service', treat: TREAT.EXPENSE,
    },
    {
      id: 'unplanned-service-rev', desc: eq('Unplanned Service Charge - Deleted/Abandoned Shipments'),
      type: t => /Reversal/.test(t),
      cat: CAT.INBOUND, sub: 'Unplanned service reversal', treat: TREAT.CREDIT,
    },

    /* --- seller services ------------------------------------------------ */
    { id: 'subscription', desc: eq('Subscription'), cat: CAT.SERVICES, sub: 'Subscription', treat: TREAT.EXPENSE },
    { id: 'coupon-part', desc: eq('Coupon Participation Fee'), cat: CAT.SERVICES, sub: 'Coupon participation', treat: TREAT.EXPENSE },
    { id: 'coupon-perf', desc: eq('Coupon Performance Based Fee'), cat: CAT.SERVICES, sub: 'Coupon performance', treat: TREAT.EXPENSE },
    { id: 'deal-part', desc: eq('Deal Participation Fee'), cat: CAT.SERVICES, sub: 'Deal participation', treat: TREAT.EXPENSE },
    { id: 'deal-perf', desc: eq('Deal Performance Based Fee'), cat: CAT.SERVICES, sub: 'Deal performance', treat: TREAT.EXPENSE },
    { id: 'vine', desc: eq('Vine Enrollment Fee'), cat: CAT.SERVICES, sub: 'Vine', treat: TREAT.EXPENSE },
    {
      id: 'legacy-deals', desc: d => starts('Deals-')(d) || starts('Lightning Deal-')(d),
      cat: CAT.SERVICES, sub: 'Legacy deal fee', treat: TREAT.EXPENSE,
      note: 'Source `type` is blank on these rows; the description still identifies the charge.',
    },
    {
      id: 'price-discount', desc: starts('Price Discount - '),
      cat: CAT.SERVICES, sub: 'Price discount service fee', treat: TREAT.EXPENSE,
      note: 'A service fee, distinct from the promotional rebates contra-revenue column.',
    },

    /* --- shipping ------------------------------------------------------- */
    {
      id: 'ship-label', desc: eq('Shipping Label Purchased through Amazon'),
      cat: CAT.SHIPPING, sub: 'Labels', treat: TREAT.EXPENSE,
    },
    {
      id: 'ship-label-refund', desc: eq('Shipping Label Refunded through Amazon'),
      cat: CAT.SHIPPING, sub: 'Label credit', treat: TREAT.CREDIT,
    },
    {
      id: 'return-postage', desc: eq('ReturnPostageBilling'),
      cat: CAT.SHIPPING, sub: 'Return postage', treat: TREAT.EXPENSE,
    },
    {
      id: 'ship-adjust', type: eq('Shipping Services'), desc: eq('Adjustment'),
      cat: CAT.SHIPPING, sub: 'Adjustment', treat: TREAT.EXPENSE,
      note: 'Carrier reason not stated in this source.',
    },

    /* --- credits & reimbursements --------------------------------------- */
    {
      id: 'reimb-general', desc: eq('FBA Inventory Reimbursement - General Adjustment'),
      cat: CAT.CREDITS, sub: 'Reimbursement adjustment', treat: TREAT.CREDIT,
      note: 'Negative amounts here are reversals of earlier reimbursements. The label alone '
        + 'does not make this income.',
    },
    {
      id: 'reimb', desc: starts('FBA Inventory Reimbursement - '),
      cat: CAT.CREDITS, sub: null, treat: TREAT.CREDIT,
      subFrom: d => 'Inventory reimbursement — ' + d.replace('FBA Inventory Reimbursement - ', ''),
      note: 'Original subtype preserved.',
    },
    {
      id: 'mcf-credit', desc: eq('MCF Preferred Pricing Seller Credit'),
      cat: CAT.CREDITS, sub: 'MCF seller credit', treat: TREAT.CREDIT,
      note: 'Positive credit despite the source type being Amazon Charges.',
    },
    {
      id: 'safet', type: eq('SAFE-T reimbursement'),
      cat: CAT.CREDITS, sub: 'SAFE-T', treat: TREAT.CREDIT, extract: extractSafeT,
    },

    /* --- unclassified, kept visible ------------------------------------- */
    {
      id: 'fee-adjust-unspecified', desc: eq('Non-subscription Fee Adjustment'),
      cat: CAT.UNCLASSIFIED, sub: 'Fee detail missing', treat: TREAT.UNCLASSIFIED,
      note: 'Amazon gives no subtype. Not guessed.',
    },
    {
      id: 'fba-inv-fee-blank', type: eq('FBA Inventory Fee'), desc: d => d === '',
      cat: CAT.UNCLASSIFIED, sub: 'Inventory detail missing', treat: TREAT.UNCLASSIFIED,
    },
    {
      id: 'adjustment-other', type: eq('Adjustment'), desc: eq('Other'),
      cat: CAT.UNCLASSIFIED, sub: 'Adjustment', treat: TREAT.UNCLASSIFIED,
      note: 'No evidence this is reserve activity; not assumed to be.',
    },

    /* --- generic order/refund component rules, last ---------------------- */
    {
      id: 'order-selling-fees', type: isOrderish, col: 'selling fees',
      cat: CAT.SELLING, sub: 'Combined order selling fees', treat: TREAT.EXPENSE,
      note: 'Amazon combines referral and closing fees in this column. A precise '
        + 'referral/closing/refund-admin split is not available from this source.',
    },
    {
      id: 'order-fba-fees', type: isOrderish, col: 'fba fees',
      cat: CAT.FBA, sub: 'Combined order FBA fees', treat: TREAT.EXPENSE,
      note: 'Parent fulfilment family. Per-surcharge detail is not in this source.',
    },
    {
      id: 'refund-other', type: eq('Refund'), col: 'other',
      cat: CAT.UNCLASSIFIED, sub: 'Refund adjustment', treat: TREAT.UNCLASSIFIED,
      note: 'Refund administration is not identified in this source; not guessed.',
    },
    {
      id: 'order-other-txn-fees', type: isOrderish, col: 'other transaction fees',
      cat: CAT.SELLING, sub: 'Other transaction fees', treat: TREAT.EXPENSE,
    },
    {
      id: 'order-other', type: isOrderish, col: 'other',
      cat: CAT.UNCLASSIFIED, sub: 'Order adjustment', treat: TREAT.UNCLASSIFIED,
    },
  ];

  /* Revenue and tax components are fixed by column, whatever the row type —
     a refund's negative product sales is still the product-sales component. */
  const REVENUE_COLS = new Set(['product sales', 'shipping credits', 'gift wrap credits', 'promotional rebates']);
  const TAX_COLS = new Set(['product sales tax', 'shipping credits tax', 'giftwrap credits tax',
    'promotional rebates tax', 'marketplace withheld tax', 'Tax On Regulatory Fee']);
  const REVENUE_SUB = {
    'product sales': 'Product sales',
    'shipping credits': 'Shipping credits',
    'gift wrap credits': 'Gift wrap credits',
    'promotional rebates': 'Promotional rebates',
  };

  /* Slots the taxonomy supports but this source never populates. Shown as
     "no coverage in supplied sources" rather than silently absent, so a reader
     can tell "we do not charge this" from "we cannot see this". */
  const UNOBSERVED_SLOTS = [
    { cat: CAT.SELLING, sub: 'Closing fee', why: 'Combined into the selling fees column by Amazon' },
    { cat: CAT.SELLING, sub: 'Per-item selling fee', why: 'Combined into the selling fees column by Amazon' },
    { cat: CAT.RETURNS, sub: 'Refund administration fee', why: 'Not separately identified in this source' },
    { cat: CAT.ADS, sub: 'Sponsored Brands', why: 'Advertising subtype not stated in this source' },
    { cat: CAT.ADS, sub: 'Sponsored Display', why: 'Advertising subtype not stated in this source' },
    { cat: CAT.SELLING, sub: 'Chargebacks', why: 'Not observed in the supplied period' },
    { cat: CAT.UNCLASSIFIED, sub: 'Cross-account adjustment', why: 'Not observed in the supplied period' },
    { cat: CAT.STORAGE, sub: 'Reserve / deferral movement', why: 'No standalone reserve label exists in this export' },
  ];

  /* ── classify one component ──────────────────────────────────────────── */

  /* ctx: { type, description, column }. Returns a stable classification with
     the rule that produced it, so any figure can be traced back to a rule. */
  function classify(ctx) {
    const type = (ctx.type || '').trim();
    const desc = (ctx.description || '').trim();
    const col = ctx.column;

    if (REVENUE_COLS.has(col)) {
      return {
        category: CAT.REVENUE, subcategory: REVENUE_SUB[col],
        treatment: TREAT.REVENUE, ruleId: 'revenue-column', ruleVersion: RULE_VERSION,
        note: col === 'promotional rebates' ? 'Contra revenue, not a platform service fee.' : null,
      };
    }
    if (TAX_COLS.has(col)) {
      return {
        category: CAT.TAX, subcategory: col, treatment: TREAT.TAX,
        ruleId: 'tax-column', ruleVersion: RULE_VERSION,
      };
    }
    if (col === 'Regulatory Fee') {
      return {
        category: CAT.SELLING, subcategory: 'Regulatory fee', treatment: TREAT.EXPENSE,
        ruleId: 'regulatory-column', ruleVersion: RULE_VERSION,
      };
    }

    for (const r of RULES) {
      if (r.col && r.col !== col) continue;
      if (r.type && !r.type(type)) continue;
      if (r.desc && !r.desc(desc)) continue;
      return {
        category: r.cat,
        subcategory: r.subFrom ? r.subFrom(desc) : r.sub,
        treatment: r.treat,
        ruleId: r.id,
        ruleVersion: RULE_VERSION,
        note: r.note || null,
        extracted: r.extract ? r.extract(desc) : null,
      };
    }

    return {
      category: CAT.UNCLASSIFIED,
      subcategory: 'UNCLASSIFIED AMAZON EXPENSE',
      treatment: TREAT.UNCLASSIFIED,
      ruleId: 'unmatched', ruleVersion: RULE_VERSION,
      note: 'No rule matched type "' + type + '" with description "' + desc.slice(0, 60)
        + '" in column "' + col + '".',
    };
  }

  /* Does this component belong in the profit engine at all? Transfers and
     balance movements never do. */
  const affectsProfit = t => t === TREAT.REVENUE || t === TREAT.EXPENSE
    || t === TREAT.CREDIT || t === TREAT.UNCLASSIFIED;
  /* Does it change money held at Amazon? Everything posted does, including tax
     clearing (which nets to zero) and transfers (which take cash out). */
  const affectsAmazonBalance = () => true;

  return {
    RULE_VERSION, TREAT, CAT, RULES, UNOBSERVED_SLOTS,
    REVENUE_COLS, TAX_COLS,
    classify, affectsProfit, affectsAmazonBalance,
    extractTransfer, extractReturnsFee,
  };
});
