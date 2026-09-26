/* Fees & Economics Preview — Amazon's own forward estimates.
 *
 * Two things make this file easy to get wrong, and both are handled here:
 *
 * 1. The fee columns are a HIERARCHY, not a list. "FBA fulfillment fees total"
 *    is the parent of base fulfilment, fuel surcharge and low-inventory-level;
 *    "Monthly inventory storage fee total" is the parent of base monthly
 *    storage and storage utilisation. Adding a parent to its children
 *    double-counts. In these files base monthly storage EQUALS its parent on
 *    every populated row, so summing both doubles storage outright.
 *
 * 2. The parent does not equal the sum of its visible children — it is short by
 *    $209.30 to $522.07 per file. That difference is reported as a signed
 *    reconciliation item. It is not silently allocated, and it is not treated
 *    as an extra fee.
 *
 * Blank is never zero. The 44-column variant omits the three storage triplets
 * entirely; those periods have UNKNOWN storage, not free storage.
 *
 * Money here keeps full source precision (Net sales carries up to 10 decimal
 * places) and rounds only at display.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'), require('./money.js'), require('./provenance.js'));
  } else root.Preview = factory(root.CSV, root.Money, root.Prov);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Money, Prov) {

  const FEES = CSV.PREVIEW_FEES;
  const AGGREGATES = FEES.filter(f => f.aggregate).map(f => f.name);
  const childrenOf = parent => FEES.filter(f => f.parent === parent).map(f => f.name);

  /* Parse one preview file. Returns rows with exact-decimal amounts, the
     detected column set, and per-file reconciliation. */
  function parse(text, meta) {
    const grid = CSV.parse(text);
    const det = CSV.detect(grid);
    if (det.family !== 'preview') {
      throw new Error('not a Fees & Economics Preview export');
    }
    const header = det.header;
    const at = CSV.indexer(header);
    const present = name => at(name) >= 0;

    /* Which fee families this variant actually carries. A family whose columns
       are absent is recorded as absent — never as zero. */
    const families = FEES.map(f => {
      const c = CSV.feeCols(f);
      return {
        name: f.name, parent: f.parent, group: f.group, aggregate: !!f.aggregate,
        columns: c,
        present: present(c.total),
        perUnitPresent: present(c.perUnit),
        quantityPresent: present(c.quantity),
      };
    });

    const rows = [];
    const issues = [];
    const rejected = [];
    let processed = 0;
    let netUnitsMismatch = 0, precisionBeyondScale = 0;

    /* A row that does not become data is RECORDED, with its line number and the
       reason, so "201 of 204 rows" can never be silently "201 rows". */
    const reject = (line, reason, detail) => {
      if (rejected.length < 200) rejected.push({ line, reason, detail: detail || null });
    };

    for (let i = det.headerIndex + 1; i < grid.length; i++) {
      const r = grid[i];
      if (!r) continue;
      /* A single empty cell is the trailing newline, not a row. */
      if (r.length <= 1 && String(r[0] == null ? '' : r[0]).trim() === '') continue;
      processed++;
      if (r.length < 5) {
        reject(i + 1, 'Too few columns', r.length + ' fields, at least 5 expected');
        continue;
      }
      const g = name => { const j = at(name); return j < 0 ? null : r[j]; };
      const msku = (g('MSKU') || '').trim();
      if (!msku) { reject(i + 1, 'No MSKU', 'the MSKU cell is blank'); continue; }

      const numOrNull = v => {
        if (v == null || String(v).trim() === '') return null;
        const sc = Money.scaleOf(v);
        if (sc != null && sc > Money.SCALE) precisionBeyondScale++;
        return Money.dec(v);
      };
      const intOrNull = v => {
        if (v == null || String(v).trim() === '') return null;
        const n = parseFloat(String(v).replace(/[, ]/g, ''));
        return Number.isFinite(n) ? n : null;
      };

      const unitsSold = intOrNull(g('Units sold'));
      const unitsReturned = intOrNull(g('Units returned'));
      const netUnits = intOrNull(g('Net units sold'));
      if (unitsSold != null && unitsReturned != null && netUnits != null
        && Math.abs((unitsSold - unitsReturned) - netUnits) > 1e-9) netUnitsMismatch++;

      const fees = {};
      for (const f of families) {
        fees[f.name] = f.present
          ? {
            total: numOrNull(g(f.columns.total)),
            perUnit: f.perUnitPresent ? numOrNull(g(f.columns.perUnit)) : null,
            quantity: f.quantityPresent ? intOrNull(g(f.columns.quantity)) : null,
            columnPresent: true,
          }
          : { total: null, perUnit: null, quantity: null, columnPresent: false };
      }

      const startDate = CSV.parseDate(g('Start date'));
      const endDate = CSV.parseDate(g('End date'));
      if (!startDate || !endDate) {
        reject(i + 1, 'Unreadable period', 'Start date "' + (g('Start date') || '')
          + '", End date "' + (g('End date') || '') + '" — the row is kept but the period '
          + 'could not be dated');
      }

      rows.push({
        store: (g('Amazon store') || '').trim(),
        start: startDate,
        end: endDate,
        startRaw: (g('Start date') || '').trim(),
        endRaw: (g('End date') || '').trim(),
        parentAsin: (g('Parent ASIN') || '').trim(),
        asin: (g('ASIN') || '').trim(),
        fnsku: (g('FNSKU') || '').trim(),
        msku,                                   // exact, suffixes never stripped
        currency: (g('Currency code') || '').trim().toUpperCase() || null,
        avgPrice: numOrNull(g('Average sales price')),
        unitsSold, unitsReturned, netUnits,
        sales: numOrNull(g('Sales')),
        netSales: numOrNull(g('Net sales')),
        fees,
        sourceLine: i + 1,
      });
    }

    if (!rows.length) {
      const e = new Error('The file was recognised as a Fees & Economics Preview, but no row '
        + 'carried an MSKU, so there was nothing to import.'
        + (rejected.length ? ' ' + rejected.length + ' rows were rejected — the first said: '
          + rejected[0].reason + '.' : ''));
      e.rejected = rejected;
      e.processed = processed;
      throw e;
    }

    /* Period and scope from the rows themselves, not from the filename. */
    const starts = [...new Set(rows.map(r => r.start).filter(Boolean))];
    const ends = [...new Set(rows.map(r => r.end).filter(Boolean))];
    const currencies = [...new Set(rows.map(r => r.currency).filter(Boolean))];
    const stores = [...new Set(rows.map(r => r.store).filter(Boolean))];

    if (starts.length > 1 || ends.length > 1) {
      issues.push('This file covers more than one period window: '
        + starts.join(', ') + ' to ' + ends.join(', '));
    }
    if (currencies.length > 1) issues.push('Mixed currencies in one file: ' + currencies.join(', '));
    if (netUnitsMismatch) issues.push(netUnitsMismatch + ' rows where units sold − units returned ≠ net units sold');
    if (precisionBeyondScale) {
      issues.push(precisionBeyondScale + ' cells carry more than ' + Money.SCALE
        + ' decimal places; the excess was not used');
    }

    const absentFamilies = families.filter(f => !f.present).map(f => f.name);
    if (absentFamilies.length) {
      issues.push('Columns absent from this export, so those costs are UNKNOWN for this period, not zero: '
        + absentFamilies.join(', '));
    }

    if (rejected.length) {
      const byReason = new Map();
      for (const r of rejected) byReason.set(r.reason, (byReason.get(r.reason) || 0) + 1);
      issues.push(rejected.length + ' rows were not imported: '
        + [...byReason.entries()].map(([k, v]) => v + ' × ' + k).join(', '));
    }

    return {
      family: 'preview',
      header, columnCount: header.length,
      headerLine: det.headerIndex + 1,
      preamble: grid.slice(0, det.headerIndex),
      rowsProcessed: processed,
      rowsAccepted: rows.length,
      rejected,
      variant: header.length >= 53 ? 'with-storage' : 'without-storage',
      rows, families, issues,
      period: { start: starts[0] || null, end: ends[0] || null },
      currency: currencies.length === 1 ? currencies[0] : null,
      store: stores.length === 1 ? stores[0] : null,
      mskuCount: new Set(rows.map(r => r.msku)).size,
      asinCount: new Set(rows.map(r => r.asin).filter(Boolean)).size,
      netUnitsMismatch,
      name: meta && meta.name,
      hash: meta && meta.hash,
      importedAt: (meta && meta.importedAt) || new Date().toISOString(),
    };
  }

  /* ── fee totals and hierarchy reconciliation ─────────────────────────── */

  /* Sum a fee family over rows, counting only populated cells and reporting how
     many rows were populated, so "0 across 3 blank rows" can never look like a
     known zero. */
  function familyTotal(rows, name) {
    let total = null, populated = 0, blank = 0, absent = 0;
    for (const r of rows) {
      const f = r.fees[name];
      if (!f || !f.columnPresent) { absent++; continue; }
      if (f.total == null) { blank++; continue; }
      total = total == null ? f.total : total + f.total;
      populated++;
    }
    return { name, total, populated, blank, absent, known: populated > 0 };
  }

  /* The reconciliation the spec demands: parent stays authoritative, children
     are explanatory, and the gap between them is shown with its sign. */
  function hierarchy(file) {
    const rows = file.rows;
    const out = [];
    for (const parent of AGGREGATES) {
      const p = familyTotal(rows, parent);
      const kids = childrenOf(parent).map(n => familyTotal(rows, n));
      const visible = kids.filter(k => k.known);
      const childSum = visible.length
        ? visible.reduce((s, k) => (s == null ? k.total : s + k.total), null) : null;
      out.push({
        parent,
        parentTotal: p.total,
        parentPopulated: p.populated,
        children: kids,
        childSum,
        /* signed: negative means the parent is SMALLER than its visible parts */
        difference: p.total != null && childSum != null ? p.total - childSum : null,
        identical: p.total != null && childSum != null && p.total === childSum,
        /* what the app must actually use when adding up costs */
        useForTotals: parent,
        note: 'Use the parent total. Children explain it and must never be added on top.',
      });
    }
    return out;
  }

  /* Every fee family total for one file, with the double-count rule applied:
     aggregates count once, their children are marked non-additive. */
  function feeSummary(file) {
    const rows = file.rows;
    const childNames = new Set(FEES.filter(f => f.parent).map(f => f.name));
    const lines = [];
    let countedTotal = null;
    for (const f of FEES) {
      const t = familyTotal(rows, f.name);
      const isChild = childNames.has(f.name);
      const counted = !isChild && f.group !== 'advertising';
      lines.push({
        name: f.name, group: f.group, parent: f.parent || null,
        total: t.total, populated: t.populated, blank: t.blank, absent: t.absent,
        columnPresent: t.absent < rows.length,
        nonAdditive: isChild,
        countedInTotal: counted,
        why: isChild ? 'Component of ' + f.parent + ' — shown for explanation only'
          : f.group === 'advertising' ? 'Advertising is counted separately; whether it '
            + 'reduces Amazon cash depends on the billing method' : null,
      });
      if (counted && t.total != null) countedTotal = countedTotal == null ? t.total : countedTotal + t.total;
    }
    const ads = familyTotal(rows, 'Sponsored Products charge');
    return { lines, platformFeeTotal: countedTotal, advertising: ads.total };
  }

  /* Rows that would quietly become zero if blanks were trusted. */
  function coverageGaps(file) {
    const gaps = [];
    const blankReferral = file.rows.filter(r => {
      const f = r.fees['Referral fee'];
      return f && f.columnPresent && f.total == null;
    });
    if (blankReferral.length) {
      gaps.push({
        kind: 'blank-referral', count: blankReferral.length,
        mskus: blankReferral.map(r => r.msku),
        message: blankReferral.length + ' rows have no referral fee. Blank is not an '
          + 'exemption — confirm the listing before treating it as zero.',
      });
    }
    const sellingNoFba = file.rows.filter(r => {
      const f = r.fees['FBA fulfillment fees'];
      return (r.unitsSold || 0) > 0 && f && f.columnPresent && f.total == null;
    });
    if (sellingNoFba.length) {
      gaps.push({
        kind: 'selling-without-fba', count: sellingNoFba.length,
        mskus: sellingNoFba.map(r => r.msku),
        message: sellingNoFba.length + ' SKUs forecast to sell carry no FBA fulfilment amount. '
          + 'Some may be seller-fulfilled; verify the fulfilment channel before assuming no fee.',
      });
    }
    const zeroSalesWithCost = file.rows.filter(r => {
      const sold = r.unitsSold || 0;
      const storage = r.fees['Monthly inventory storage fee'];
      const ad = r.fees['Sponsored Products charge'];
      const hasCost = (storage && storage.total != null && storage.total !== 0n)
        || (ad && ad.total != null && ad.total !== 0n);
      return sold === 0 && hasCost;
    });
    if (zeroSalesWithCost.length) {
      gaps.push({
        kind: 'cost-without-sales', count: zeroSalesWithCost.length,
        mskus: zeroSalesWithCost.map(r => r.msku),
        message: zeroSalesWithCost.length + ' SKUs forecast zero sales but still carry storage '
          + 'or advertising cost. These rows are kept, not filtered out.',
      });
    }
    return gaps;
  }

  /* ── multi-file coverage ─────────────────────────────────────────────── */

  /* Which calendar days across a horizon are actually backed by a preview.
     A day with no file is a GAP — never interpolated, never averaged. */
  function coverage(files, fromDate, toDate) {
    const days = [];
    const covered = new Map();
    for (const f of files) {
      if (!f.period.start || !f.period.end) continue;
      let d = f.period.start;
      while (d <= f.period.end) {
        covered.set(d, (covered.get(d) || []).concat(f.name || f.period.start));
        d = CSV.addDays(d, 1);
      }
    }
    let d = fromDate;
    while (d <= toDate) {
      days.push({ date: d, files: covered.get(d) || null, covered: covered.has(d) });
      d = CSV.addDays(d, 1);
    }
    const gaps = [];
    let run = null;
    for (const x of days) {
      if (!x.covered) { if (!run) run = { from: x.date, to: x.date }; else run.to = x.date; }
      else if (run) { gaps.push(run); run = null; }
    }
    if (run) gaps.push(run);
    return {
      days, gaps,
      coveredDays: days.filter(d => d.covered).length,
      totalDays: days.length,
      complete: gaps.length === 0,
      overlaps: [...covered.entries()].filter(([, v]) => v.length > 1).map(([d, v]) => ({ date: d, files: v })),
    };
  }

  /* Which previews count, when several overlap.

     Each download is Amazon's whole estimate for its window, not a slice of
     one. Two downloads a day apart cover almost the same eight weeks, and
     adding them counted the same sales, fees and storage twice - three
     downloads showed three times the real net receivable.

     So overlapping windows are versions of one forecast, and the newest
     counts: the one whose window starts latest (a rolling forecast moves
     forward), then ends latest, then was imported last. An older one that
     overlaps it is kept - still listed, still readable - but not added.
     Windows that do not overlap (September, October, November) all count.
     Only previews of the same currency and store compete. */
  function active(files) {
    const list = (files || []).map((f, i) => ({ f, i }))
      .filter(x => x.f && x.f.period && x.f.period.start && x.f.period.end);
    list.sort((a, b) => (b.f.period.start > a.f.period.start ? 1 : b.f.period.start < a.f.period.start ? -1
      : b.f.period.end > a.f.period.end ? 1 : b.f.period.end < a.f.period.end ? -1 : b.i - a.i));
    const kept = [], superseded = [];
    for (const { f } of list) {
      const by = kept.find(k => (k.currency || null) === (f.currency || null)
        && (k.store || null) === (f.store || null)
        && !(k.period.end < f.period.start || k.period.start > f.period.end));
      if (by) superseded.push({ file: f, by });
      else kept.push(f);
    }
    /* In the caller's order, and undated files untouched. */
    const keep = new Set(kept);
    const undated = (files || []).filter(f => !(f && f.period && f.period.start && f.period.end));
    return {
      files: (files || []).filter(f => keep.has(f)).concat(undated),
      superseded,
    };
  }
  const activeFiles = files => active(files).files;

  /* Which download each DAY's figures come from.

     Several downloads can cover one day: the same dates fetched again the next
     morning, a one-day report inside a weekly one, a manual eight-week file.
     Each day takes exactly ONE of them - never a sum, which would count the
     same sales twice - chosen in this order:
       1. the one downloaded on the latest calendar day (this computer's day),
          because Amazon's forecast moves and yesterday's is out of date;
       2. of those, the narrowest window - a one-day report is Amazon's own
          figure for that day, a longer one is split evenly across its days;
       3. then the later download, then the later file.
     Only files of the same currency and store compete for a day.

     whenOf(file) gives the download time (ISO); without it, files compete on
     width and order alone. Returns { owned: Map(file -> [days, ascending]),
     superseded: [files that own no day at all] }. */
  const localDay = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 10);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  };
  function ownership(files, opts) {
    const whenOf = (opts && opts.whenOf) || (() => null);
    const list = (files || []).map((f, i) => {
      if (!f || !f.period || !f.period.start || !f.period.end) return null;
      const w = whenOf(f) || '';
      return { f, i, w, day: localDay(w), span: CSV.daysBetween(f.period.start, f.period.end) + 1 };
    }).filter(Boolean);
    const better = (a, b) => (a.day !== b.day ? a.day > b.day
      : a.span !== b.span ? a.span < b.span
        : a.w !== b.w ? a.w > b.w : a.i > b.i);
    const best = new Map();
    for (const x of list) {
      const who = (x.f.currency || '') + '|' + (x.f.store || '') + '|';
      for (let d = x.f.period.start; d <= x.f.period.end; d = CSV.addDays(d, 1)) {
        const cur = best.get(who + d);
        if (!cur || better(x, cur)) best.set(who + d, x);
      }
    }
    const owned = new Map(list.map(x => [x.f, []]));
    for (const [key, x] of best) owned.get(x.f).push(key.slice(key.lastIndexOf('|') + 1));
    for (const days of owned.values()) days.sort();
    return { owned, superseded: list.filter(x => !owned.get(x.f).length).map(x => x.f) };
  }

  /* SKU reconciliation against the historical ledger. Suffixes are never
     stripped: `amzn.gr.XX-…-LN` and `XX-…` are different identifiers until a
     mapping is supplied by someone who knows. */
  function skuReconciliation(files, historicalSkus) {
    const preview = new Set();
    for (const f of files) for (const r of f.rows) preview.add(r.msku);
    const unmatched = [...preview].filter(m => !historicalSkus.has(m));
    return {
      previewCount: preview.size,
      historicalCount: historicalSkus.size,
      matched: preview.size - unmatched.length,
      unmatched,
      message: unmatched.length
        ? unmatched.length + ' preview MSKUs have no exact match in the transaction history. '
        + 'They are not auto-mapped; supply an explicit alias if they are the same product.'
        : null,
    };
  }

  return {
    parse, familyTotal, hierarchy, feeSummary, coverageGaps, coverage,
    skuReconciliation, childrenOf, active, activeFiles, ownership, AGGREGATES, FEES,
  };
});
