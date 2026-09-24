/* The three inputs typed by hand: bank deposits, product costs and
 * advertising billing.
 *
 * Kept apart from the screens so the rules are testable on their own, and
 * apart from the engines because none of this is Amazon's data - it is what
 * the owner tells the app, and each record says so (source: 'entered').
 *
 * Money is whole cents, parsed from the text as typed rather than through a
 * float, so "19.99" is 1999 and never 1998.9999. Nothing here fills a gap
 * with a default: a period the records do not cover stays uncovered, and the
 * figures that depend on it say what is missing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'), require('./recon.js'));
  } else root.Inputs = factory(root.CSV, root.Recon);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Recon) {

  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const ACCOUNTS = ['Standard Orders', 'Invoiced Orders'];
  const AD_METHODS = {
    card: 'Card',
    invoice: 'Invoice',
    amazon_deduction: 'Deducted from Amazon payouts',
  };

  const isDate = s => typeof s === 'string' && DATE.test(s)
    && !Number.isNaN(Date.parse(s + 'T00:00:00Z'))
    && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

  /* "1,234.56", "$19.99", "-4.2", "(12.00)" -> cents. More than two decimals
     rounds half away from zero to the cent, and says so through `rounded`. */
  function parseAmount(text) {
    let s = String(text == null ? '' : text).trim().replace(/[$€£,\s]/g, '');
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (s[0] === '-') { neg = !neg; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
    const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (!m[1] && !m[2])) return null;
    const whole = m[1] || '0';
    const frac = (m[2] || '');
    let c = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
    if (frac.length > 2 && frac[2] >= '5') c += 1n;
    if (c > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const n = Number(c);
    return neg ? -n : n;
  }
  const hadSubCent = text => /\.\d{3,}/.test(String(text || '').replace(/[,\s]/g, ''));

  const newId = prefix => prefix + '-' + Date.now().toString(36) + '-'
    + Math.random().toString(36).slice(2, 7);

  /* ── bank deposits ─────────────────────────────────────────────────── */

  function deposit(fields) {
    const f = fields || {};
    const amount = typeof f.amount === 'number' ? f.amount : parseAmount(f.amount);
    if (!isDate(f.date)) return { error: 'Enter the date the money reached the bank.' };
    if (amount == null) return { error: 'Enter the amount that arrived, e.g. 1234.56.' };
    if (amount <= 0) return { error: 'A deposit is money arriving, so it is more than zero.' };
    if (f.account && ACCOUNTS.indexOf(f.account) < 0) return { error: 'Unknown account stream.' };
    return { record: {
      id: f.id || newId('dep'),
      date: f.date, amount,
      currency: f.currency || null,
      account: f.account || null,
      reference: String(f.reference || '').trim().slice(0, 120) || null,
      source: 'entered', recordedAt: f.recordedAt || new Date().toISOString(),
    } };
  }

  /* Transit measured from deposits matched to Amazon's transfer rows. Only
     matched pairs count; a deposit with no transfer is not evidence of how
     long a transfer takes. Fewer than three matches is too few to call a
     range, and the answer says so instead of offering one. */
  const MIN_MATCHES = 3;
  function measuredTransit(transfers, deposits, opts) {
    opts = opts || {};
    if (!deposits || !deposits.length) {
      return { available: false, n: 0, missing: 'bank deposits matched to Amazon transfers' };
    }
    if (!transfers || !transfers.length) {
      return { available: false, n: 0,
        missing: 'the Payments transaction history, which holds the transfers to match against' };
    }
    const match = Recon.matchBankDeposits(transfers, deposits, opts);
    /* Only matches that are evidence of an arrival date: a deposit of exactly
       the transfer's amount, or a split whose deposits are each used whole.
       Recon also pairs a transfer with PART of a larger deposit - useful for
       reconciling, but the date of a deposit that is mostly something else
       says nothing about how long this transfer took. */
    const days = match.matches.filter(m => m.kind === 'one-to-one'
      || (m.kind === 'split' && (m.applied || []).every(u => u.applied === u.deposit.amount)))
      .map(m => m.transitDays).filter(x => x != null && x >= 0).sort((a, b) => a - b);
    const n = days.length;
    const pick = q => days[Math.floor(q * (n - 1))];
    const st = n ? { n, min: days[0], max: days[n - 1], median: pick(0.5), p10: pick(0.1), p90: pick(0.9) } : null;
    if (n < MIN_MATCHES) {
      return { available: false, n, match,
        missing: n ? 'at least ' + MIN_MATCHES + ' matched deposits (' + n + ' so far)'
          : 'a deposit that matches an Amazon transfer by amount within ' + (opts.windowDays || 14) + ' days' };
    }
    /* The whole observed range while the sample is small; the 10th to 90th
       percentile once there are enough that one odd deposit should not set
       the edge. Either way it is what happened, labelled as such. */
    const wide = n < 10;
    return {
      available: true, n, match,
      low: wide ? st.min : st.p10,
      high: wide ? st.max : st.p90,
      median: st.median,
      basis: 'measured from ' + n + ' matched bank deposits'
        + (wide ? ' (full observed range)' : ' (10th–90th percentile)'),
    };
  }

  /* ── product costs ─────────────────────────────────────────────────── */

  function cost(fields) {
    const f = fields || {};
    const msku = String(f.msku || '').trim();
    const unitCost = typeof f.unitCost === 'number' ? f.unitCost : parseAmount(f.unitCost);
    if (!msku) return { error: 'Enter the MSKU exactly as Amazon shows it.' };
    if (msku.length > 80) return { error: 'That MSKU is longer than Amazon allows.' };
    if (unitCost == null) return { error: 'Enter what one unit costs you, e.g. 4.25.' };
    if (unitCost < 0) return { error: 'A unit cost cannot be negative.' };
    if (f.from && !isDate(f.from)) return { error: 'The "from" date is not a date.' };
    if (f.to && !isDate(f.to)) return { error: 'The "to" date is not a date.' };
    if (f.from && f.to && f.to < f.from) return { error: 'The cost ends before it starts.' };
    return { record: {
      id: f.id || newId('cost'),
      msku, unitCost,
      currency: f.currency || null,
      from: f.from || null, to: f.to || null,
      evidence: String(f.evidence || '').trim().slice(0, 160) || null,
      source: 'entered', recordedAt: f.recordedAt || new Date().toISOString(),
    }, rounded: typeof f.unitCost === 'string' && hadSubCent(f.unitCost) };
  }

  /* Many costs at once, pasted from a spreadsheet: one product per line,
     "MSKU, unit cost" with an optional third column for the date it applies
     from. Tabs work as well as commas, so a copied column pair pastes as is.
     Every line is accounted for: accepted, or refused with its line number. */
  function parseCostPaste(text, defaults) {
    defaults = defaults || {};
    const rows = [], errors = [];
    const lines = String(text || '').split(/\r?\n/);
    lines.forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      const parts = (line.indexOf('\t') >= 0 ? line.split('\t') : splitCsvLine(line))
        .map(p => p.trim());
      /* A header row is recognised and skipped, never costed. */
      if (i === 0 && /sku/i.test(parts[0]) && parseAmount(parts[1]) == null) return;
      const got = cost({ msku: parts[0], unitCost: parts[1],
        from: parts[2] || defaults.from || null, currency: defaults.currency,
        evidence: defaults.evidence || 'pasted list' });
      if (got.error) errors.push({ line: i + 1, text: line.slice(0, 80), error: got.error });
      else rows.push(got.record);
    });
    return { rows, errors };
  }

  function splitCsvLine(line) {
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }

  /* Adding costs never silently overwrites one. The same MSKU from the same
     date replaces the old figure (that is a correction); a different date is
     a new effective-dated cost and both are kept. */
  function mergeCosts(existing, incoming) {
    const key = c => c.msku + '|' + (c.currency || '') + '|' + (c.from || '');
    const byKey = new Map(existing.map(c => [key(c), c]));
    let added = 0, replaced = 0;
    for (const c of incoming) {
      if (byKey.has(key(c))) replaced++; else added++;
      byKey.set(key(c), Object.assign({}, c, byKey.has(key(c)) ? { id: byKey.get(key(c)).id } : {}));
    }
    return { list: [...byKey.values()], added, replaced };
  }

  /* The costs that apply to one currency. A cost recorded without a currency
     applies to all of them - that is how it was entered, so it is honoured. */
  const costsIn = (costs, currency) => (costs || [])
    .filter(c => !c.currency || !currency || c.currency === currency);

  /* ── advertising billing ───────────────────────────────────────────── */

  function adBill(fields) {
    const f = fields || {};
    if (!AD_METHODS[f.method]) return { error: 'Choose how this advertising was paid.' };
    if (!isDate(f.from)) return { error: 'Enter the first day of the period this covers.' };
    if (!isDate(f.to)) return { error: 'Enter the last day of the period this covers.' };
    if (f.to < f.from) return { error: 'The period ends before it starts.' };
    const amount = f.amount === '' || f.amount == null ? null
      : typeof f.amount === 'number' ? f.amount : parseAmount(f.amount);
    if (f.amount !== '' && f.amount != null && amount == null) {
      return { error: 'The amount is not a number.' };
    }
    if (amount != null && amount < 0) return { error: 'Enter what was billed as a positive amount.' };
    if (f.method !== 'amazon_deduction' && amount == null) {
      return { error: 'Enter what the ' + AD_METHODS[f.method].toLowerCase()
        + ' was billed for this period.' };
    }
    return { record: {
      id: f.id || newId('ads'),
      method: f.method, from: f.from, to: f.to,
      amount: f.method === 'amazon_deduction' ? null : amount,
      currency: f.currency || null,
      evidence: String(f.evidence || '').trim().slice(0, 160) || null,
      source: 'entered', recordedAt: f.recordedAt || new Date().toISOString(),
    } };
  }

  /* How advertising is paid on a date - the record whose period holds it,
     latest start winning. Outside every period the answer is "not recorded",
     never the nearest record stretched to fit. */
  function adMethodAt(bills, date) {
    let best = null;
    for (const b of bills || []) {
      if (!b || !b.method || b.from > date || b.to < date) continue;
      if (!best || b.from > best.from) best = b;
    }
    return best ? { method: best.method, from: best.from, to: best.to,
      evidence: best.evidence || 'entered by hand' } : null;
  }

  /* The payment method a forecast starting on `date` should use: the one in
     force that day, or failing that the most recent one that has started,
     because billing arrangements continue until changed. Labelled either way. */
  function adMethodForForecast(bills, date) {
    const now = adMethodAt(bills, date);
    if (now) return now;
    let last = null;
    for (const b of bills || []) {
      if (!b || !b.method || b.from > date) continue;
      if (!last || b.to > last.to) last = b;
    }
    return last ? { method: last.method, from: last.from, to: null,
      evidence: (last.evidence || 'entered by hand') + '; latest recorded, carried forward',
      carriedForward: true } : null;
  }

  /* Advertising billed OUTSIDE Amazon for a profit period.
     A bill whose service period runs past the edge of the report period is
     counted by calendar day - the only allocation that needs no invented
     rule - and the count of such bills is returned so the page can say so.
     Days no record covers leave the figure unavailable: "we don't know" is
     not zero. Periods paid by Amazon deduction count as covered and add
     nothing, because those charges are already in the transaction rows. */
  function externalAdvertising(bills, from, to, currency) {
    if (!isDate(from) || !isDate(to) || to < from) {
      return { amount: null, complete: false, coveredDays: 0, totalDays: 0,
        missing: 'a report period with a start and an end' };
    }
    const list = (bills || []).filter(b => b && (!currency || !b.currency || b.currency === currency));
    const totalDays = CSV.daysBetween(from, to) + 1;
    const covered = new Set();
    let amount = 0n, prorated = 0, counted = 0;
    for (const b of list) {
      const lo = b.from > from ? b.from : from;
      const hi = b.to < to ? b.to : to;
      if (lo > hi) continue;
      for (let d = lo; d <= hi; d = CSV.addDays(d, 1)) covered.add(d);
      if (b.method === 'amazon_deduction' || b.amount == null) continue;
      counted++;
      const span = CSV.daysBetween(b.from, b.to) + 1;
      const inside = CSV.daysBetween(lo, hi) + 1;
      if (inside === span) amount += BigInt(b.amount);
      else {
        prorated++;
        /* Exact until the last step, then rounded half up to the cent. */
        const num = BigInt(b.amount) * BigInt(inside);
        amount += (num * 2n + BigInt(span)) / (2n * BigInt(span));
      }
    }
    const complete = covered.size === totalDays;
    return {
      amount: complete ? Number(amount) : null,
      partialAmount: Number(amount),
      complete, coveredDays: covered.size, totalDays, prorated, counted,
      missing: complete ? null
        : 'advertising billing for ' + (totalDays - covered.size) + ' of the '
          + totalDays + ' days in this period',
    };
  }

  return {
    ACCOUNTS, AD_METHODS, MIN_MATCHES,
    parseAmount, isDate,
    deposit, measuredTransit,
    cost, parseCostPaste, mergeCosts, costsIn,
    adBill, adMethodAt, adMethodForForecast, externalAdvertising,
  };
});
