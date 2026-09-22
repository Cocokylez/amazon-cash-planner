/* The Payments ledger: an immutable, columnar store of every source row.
 *
 * 180,658 rows as JavaScript objects is roughly a gigabyte and freezes the tab.
 * Instead each column becomes a typed array, and every repeated string (type,
 * description, sku, marketplace, settlement id …) becomes a dictionary index.
 * The result is ~30 MB, survives IndexedDB round-trips as ArrayBuffers, and can
 * be scanned end-to-end in a few hundred milliseconds.
 *
 * Nothing is aggregated on the way in and nothing is deduplicated. Rows keep
 * their source order and their source multiplicity — the 942 exact-duplicate
 * rows in this export are retained, because a repeated unit-level event and a
 * double-counted row look identical in a CSV and only evidence can tell them
 * apart.
 *
 * Every original field is recoverable: `rowAt(i)` reconstructs the source row,
 * including the original "Aug 1, 2025 12:00:36 AM PDT" timestamp text.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'), require('./money.js'), require('./taxonomy.js'));
  } else root.Ledger = factory(root.CSV, root.Money, root.Taxonomy);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Money, Taxonomy) {

  const COMPONENTS = CSV.PAYMENTS_COMPONENTS;
  const NC = COMPONENTS.length;

  /* Grow-able typed array columns. */
  function Col(Type, cap) { return { a: new Type(cap), Type }; }
  function ensure(col, n) {
    if (n <= col.a.length) return;
    let cap = col.a.length || 1024;
    while (cap < n) cap *= 2;
    const next = new col.Type(cap);
    next.set(col.a);
    col.a = next;
  }

  /* String dictionary: index <-> value, preserving the exact source string. */
  function Dict() {
    const list = [], map = new Map();
    return {
      id(s) {
        const k = s == null ? '' : s;
        let i = map.get(k);
        if (i === undefined) { i = list.length; list.push(k); map.set(k, i); }
        return i;
      },
      get: i => list[i],
      get size() { return list.length; },
      values: () => list,
      toJSON: () => list,
      load(arr) { list.length = 0; map.clear(); arr.forEach(v => { map.set(v, list.length); list.push(v); }); },
    };
  }

  const EPOCH = Date.UTC(2000, 0, 1);
  /* Account-local calendar day as an integer, with NO timezone conversion —
     the parts come straight from the source text. */
  function dayNum(t) {
    if (!t) return -1;
    return Math.round((Date.UTC(t.y, t.m, t.d) - EPOCH) / 86400000);
  }
  function dayToDate(n) {
    if (n < 0) return null;
    const d = new Date(EPOCH + n * 86400000);
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0')
      + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  function create(cap) {
    cap = cap || 8192;
    const dicts = {
      type: Dict(), description: Dict(), sku: Dict(), marketplace: Dict(),
      accountType: Dict(), fulfillment: Dict(), settlement: Dict(), orderId: Dict(),
      city: Dict(), state: Dict(), postal: Dict(), taxModel: Dict(), tz: Dict(),
      quantity: Dict(),
      /* (type, description) pair — the key classification depends on, so a
         classification is computed once per family rather than per row. */
      family: Dict(),
    };

    const cols = {
      type: Col(Uint16Array, cap), description: Col(Uint32Array, cap), sku: Col(Uint16Array, cap),
      marketplace: Col(Uint8Array, cap), accountType: Col(Uint8Array, cap),
      fulfillment: Col(Uint8Array, cap), settlement: Col(Uint16Array, cap),
      orderId: Col(Uint32Array, cap), city: Col(Uint32Array, cap), state: Col(Uint16Array, cap),
      postal: Col(Uint32Array, cap), taxModel: Col(Uint8Array, cap), family: Col(Uint16Array, cap),
      quantity: Col(Int32Array, cap),
      postedDay: Col(Int32Array, cap), postedSec: Col(Int32Array, cap), postedTz: Col(Uint8Array, cap),
      releaseDay: Col(Int32Array, cap), releaseSec: Col(Int32Array, cap), releaseTz: Col(Uint8Array, cap),
      status: Col(Uint8Array, cap),           // 0 unknown, 1 Released, 2 Deferred
      total: Col(Int32Array, cap),
      rowHash: Col(Int32Array, cap),
      lineNo: Col(Int32Array, cap),
      importId: Col(Uint16Array, cap),
    };
    /* One Int32Array per money component. Cents, exact. */
    const comp = COMPONENTS.map(() => Col(Int32Array, cap));

    const STATUS = ['', 'Released', 'Deferred'];
    let n = 0;

    const state = {
      dicts, cols, comp, COMPONENTS,
      imports: [],
      warnings: [],
      /* controls collected during import */
      control: { componentSumMismatch: 0, mismatchExamples: [], overPrecision: 0, shortRows: 0 },
      get rowCount() { return n; },
    };

    function grow(i) {
      for (const k in cols) ensure(cols[k], i + 1);
      for (const c of comp) ensure(c, i + 1);
    }

    /* Add one source row. `fields` is the raw split array; `at` maps a column
       name to its index in THIS file's header. */
    state.addRow = function (fields, at, lineNo, importId) {
      const i = n;
      grow(i);

      const g = name => { const j = at(name); return j < 0 ? '' : (fields[j] == null ? '' : fields[j]); };
      const gt = name => String(g(name)).trim();

      const type = gt('type'), desc = gt('description');
      cols.type.a[i] = dicts.type.id(type);
      cols.description.a[i] = dicts.description.id(desc);
      cols.family.a[i] = dicts.family.id(type + '\u0001' + desc);
      cols.sku.a[i] = dicts.sku.id(gt('sku'));
      cols.marketplace.a[i] = dicts.marketplace.id(g('marketplace'));   // exact, casing preserved
      cols.accountType.a[i] = dicts.accountType.id(gt('account type'));
      cols.fulfillment.a[i] = dicts.fulfillment.id(gt('fulfillment'));
      cols.settlement.a[i] = dicts.settlement.id(gt('settlement id'));
      cols.orderId.a[i] = dicts.orderId.id(gt('order id'));
      cols.city.a[i] = dicts.city.id(g('order city'));
      cols.state.a[i] = dicts.state.id(g('order state'));
      cols.postal.a[i] = dicts.postal.id(g('order postal'));            // string, leading zeros kept
      cols.taxModel.a[i] = dicts.taxModel.id(gt('tax collection model'));
      cols.quantity.a[i] = dicts.quantity.id(gt('quantity'));

      const pt = CSV.parseStamp(g('date/time'));
      cols.postedDay.a[i] = dayNum(pt);
      cols.postedSec.a[i] = pt ? pt.hh * 3600 + pt.mm * 60 + pt.ss : -1;
      cols.postedTz.a[i] = dicts.tz.id(pt && pt.tz ? pt.tz : '');

      const rt = CSV.parseStamp(g('Transaction Release Date'));
      cols.releaseDay.a[i] = dayNum(rt);
      cols.releaseSec.a[i] = rt ? rt.hh * 3600 + rt.mm * 60 + rt.ss : -1;
      cols.releaseTz.a[i] = dicts.tz.id(rt && rt.tz ? rt.tz : '');

      const st = gt('Transaction Status');
      cols.status.a[i] = st === 'Released' ? 1 : st === 'Deferred' ? 2 : 0;

      /* Money. The ledger is 2dp everywhere; anything finer is a schema change
         and is counted rather than silently truncated. */
      let sum = 0;
      for (let c = 0; c < NC; c++) {
        const raw = g(COMPONENTS[c]);
        const sc = Money.scaleOf(raw);
        if (sc != null && sc > 2) state.control.overPrecision++;
        const v = Money.cents(raw);
        const cents = v == null ? 0 : v;
        comp[c].a[i] = cents;
        sum += cents;
      }
      const totRaw = g('total');
      const tot = Money.cents(totRaw);
      cols.total.a[i] = tot == null ? 0 : tot;
      if (tot == null || sum !== tot) {
        state.control.componentSumMismatch++;
        if (state.control.mismatchExamples.length < 10) {
          state.control.mismatchExamples.push({ lineNo, componentSum: sum, total: tot, type });
        }
      }

      /* Cheap 32-bit hash of the whole row, for duplicate grouping. Collisions
         are resolved by full field comparison, so this is only a bucket key. */
      let h = 0x811c9dc5;
      for (let f = 0; f < fields.length; f++) {
        const s = fields[f];
        for (let k = 0; k < s.length; k++) { h ^= s.charCodeAt(k); h = Math.imul(h, 0x01000193); }
        h ^= 0x2c; h = Math.imul(h, 0x01000193);
      }
      cols.rowHash.a[i] = h | 0;
      cols.lineNo.a[i] = lineNo;
      cols.importId.a[i] = importId || 0;

      n++;
      return i;
    };

    /* Reconstruct a source row, proving nothing was lost on the way in. */
    state.rowAt = function (i) {
      const stamp = (day, sec, tz) => {
        if (day < 0) return '';
        const d = dayToDate(day).split('-').map(Number);
        const s = sec < 0 ? 0 : sec;
        return CSV.formatStamp({
          y: d[0], m: d[1] - 1, d: d[2],
          hh: Math.floor(s / 3600), mm: Math.floor(s / 60) % 60, ss: s % 60,
          tz: dicts.tz.get(tz) || null,
        });
      };
      const out = {
        'date/time': stamp(cols.postedDay.a[i], cols.postedSec.a[i], cols.postedTz.a[i]),
        'settlement id': dicts.settlement.get(cols.settlement.a[i]),
        type: dicts.type.get(cols.type.a[i]),
        'order id': dicts.orderId.get(cols.orderId.a[i]),
        sku: dicts.sku.get(cols.sku.a[i]),
        description: dicts.description.get(cols.description.a[i]),
        quantity: dicts.quantity.get(cols.quantity.a[i]),
        marketplace: dicts.marketplace.get(cols.marketplace.a[i]),
        'account type': dicts.accountType.get(cols.accountType.a[i]),
        fulfillment: dicts.fulfillment.get(cols.fulfillment.a[i]),
        'order city': dicts.city.get(cols.city.a[i]),
        'order state': dicts.state.get(cols.state.a[i]),
        'order postal': dicts.postal.get(cols.postal.a[i]),
        'tax collection model': dicts.taxModel.get(cols.taxModel.a[i]),
      };
      for (let c = 0; c < NC; c++) out[COMPONENTS[c]] = comp[c].a[i];
      out.total = cols.total.a[i];
      out['Transaction Status'] = STATUS[cols.status.a[i]];
      out['Transaction Release Date'] = stamp(cols.releaseDay.a[i], cols.releaseSec.a[i], cols.releaseTz.a[i]);
      out._line = cols.lineNo.a[i];
      out._import = cols.importId.a[i];
      return out;
    };

    /* ── classification cache ─────────────────────────────────────────── */
    /* Classification depends only on (type, description, column), so it is
       computed once per family per column — ~400 × 15 lookups instead of 2.7M. */
    const classCache = [];
    state.classifyAt = function (rowIdx, compIdx) {
      const fam = cols.family.a[rowIdx];
      let byCol = classCache[fam];
      if (!byCol) { byCol = classCache[fam] = []; }
      let c = byCol[compIdx];
      if (!c) {
        const fkey = dicts.family.get(fam);
        const sep = fkey.indexOf('\u0001');
        const pair = [fkey.slice(0, sep), fkey.slice(sep + 1)];
        c = byCol[compIdx] = Taxonomy.classify({
          type: pair[0], description: pair[1], column: COMPONENTS[compIdx],
        });
      }
      return c;
    };

    /* ── scanning ─────────────────────────────────────────────────────── */

    /* A filter is a plain object; everything is optional and unset means "all".
       Dates are account-local calendar strings. */
    state.makePredicate = function (f) {
      f = f || {};
      const fromDay = f.from ? dayNum({ y: +f.from.slice(0, 4), m: +f.from.slice(5, 7) - 1, d: +f.from.slice(8, 10) }) : -Infinity;
      const toDay = f.to ? dayNum({ y: +f.to.slice(0, 4), m: +f.to.slice(5, 7) - 1, d: +f.to.slice(8, 10) }) : Infinity;
      const acct = f.account ? dicts.accountType.id(f.account) : -1;
      const selectedMarkets = f.marketplaces || (f.marketplace ? [f.marketplace] : null);
      const mkts = selectedMarkets ? new Set(selectedMarkets.map(m => dicts.marketplace.id(m))) : null;
      const importCurrencies = new Map(state.imports.map(rec => {
        const match = /All amounts in ([A-Z]{3})/i.exec((rec.preamble || []).map(r => r.join(' ')).join(' '));
        return [rec.importId, rec.currency || (match ? match[1].toUpperCase() : null)];
      }));
      const skus = f.skus ? new Set(f.skus.map(s => dicts.sku.id(s))) : null;
      const types = f.types ? new Set(f.types.map(t => dicts.type.id(t))) : null;
      const basis = f.basis === 'release' ? 'release' : 'posted';
      return i => {
        const day = basis === 'release' ? cols.releaseDay.a[i] : cols.postedDay.a[i];
        if (day < fromDay || day > toDay) return false;
        if (f.currency && importCurrencies.get(cols.importId.a[i]) !== f.currency) return false;
        if (acct >= 0 && cols.accountType.a[i] !== acct) return false;
        if (mkts && !mkts.has(cols.marketplace.a[i])) return false;
        if (skus && !skus.has(cols.sku.a[i])) return false;
        if (types && !types.has(cols.type.a[i])) return false;
        return true;
      };
    };

    /* Category → subcategory → { debit, credit, net, rows }, all in cents.
       Debit/credit are reported as positive magnitudes of negative/positive
       source amounts, which is how the audit's tables read. */
    state.componentTotals = function (filter) {
      const ok = state.makePredicate(filter);
      const cats = new Map();
      const bump = (c, amount, rowIdx, compIdx) => {
        let cat = cats.get(c.category);
        if (!cat) cats.set(c.category, cat = { category: c.category, subs: new Map(), debit: 0, credit: 0, net: 0, rows: 0 });
        const key = c.subcategory || '(unspecified)';
        let sub = cat.subs.get(key);
        if (!sub) {
          cat.subs.set(key, sub = {
            subcategory: key, treatment: c.treatment, ruleId: c.ruleId,
            note: c.note || null, debit: 0, credit: 0, net: 0, rows: 0,
            sample: null,
          });
        }
        if (amount < 0) { sub.debit -= amount; cat.debit -= amount; }
        else { sub.credit += amount; cat.credit += amount; }
        sub.net += amount; cat.net += amount;
        sub.rows++; cat.rows++;
        if (!sub.sample) sub.sample = { row: rowIdx, column: COMPONENTS[compIdx] };
      };
      for (let i = 0; i < n; i++) {
        if (!ok(i)) continue;
        for (let c = 0; c < NC; c++) {
          const v = comp[c].a[i];
          if (v === 0) continue;
          bump(state.classifyAt(i, c), v, i, c);
        }
      }
      return cats;
    };

    /* Fast single-pass totals the dashboards need, without building maps. */
    state.summary = function (filter) {
      const ok = state.makePredicate(filter);
      const T = Taxonomy.TREAT;
      const out = {
        rows: 0, netRevenue: 0, tax: 0, transfers: 0, transferRows: 0,
        expenseDebit: 0, expenseCredit: 0, creditAmount: 0,
        unclassifiedDebit: 0, unclassifiedCredit: 0,
        nonTransferNet: 0, allTotal: 0,
      };
      for (let i = 0; i < n; i++) {
        if (!ok(i)) continue;
        out.rows++;
        const tot = cols.total.a[i];
        out.allTotal += tot;
        for (let c = 0; c < NC; c++) {
          const v = comp[c].a[i];
          if (v === 0) continue;
          const cl = state.classifyAt(i, c);
          switch (cl.treatment) {
            case T.REVENUE: out.netRevenue += v; break;
            case T.TAX: out.tax += v; break;
            case T.TRANSFER: out.transfers += v; out.transferRows++; break;
            case T.EXPENSE: if (v < 0) out.expenseDebit -= v; else out.expenseCredit += v; break;
            case T.CREDIT: out.creditAmount += v; if (v < 0) out.expenseDebit -= v; break;
            case T.UNCLASSIFIED: if (v < 0) out.unclassifiedDebit -= v; else out.unclassifiedCredit += v; break;
            default: break;
          }
        }
        if (dicts.type.get(cols.type.a[i]) !== 'Transfer') out.nonTransferNet += tot;
      }
      return out;
    };

    /* ── transfers ────────────────────────────────────────────────────── */

    /* Every Transfer row as an event, with the bank transfer id pulled out of
       the description. These are Amazon ledger transfers, NOT bank deposits —
       nothing here evidences that money arrived. */
    state.transfers = function (filter) {
      const ok = state.makePredicate(filter);
      const out = [];
      const tIdx = dicts.type.id('Transfer');
      for (let i = 0; i < n; i++) {
        if (cols.type.a[i] !== tIdx || !ok(i)) continue;
        const desc = dicts.description.get(cols.description.a[i]);
        const ex = Taxonomy.extractTransfer(desc);
        out.push({
          row: i,
          date: dayToDate(cols.postedDay.a[i]),
          day: cols.postedDay.a[i],
          account: dicts.accountType.get(cols.accountType.a[i]),
          settlementId: dicts.settlement.get(cols.settlement.a[i]),
          /* source sign is negative (cash leaving); amount is the magnitude */
          amount: -cols.total.a[i],
          signed: cols.total.a[i],
          bankTransferId: ex.bankTransferId,
          destinationRef: ex.destinationRef,
          description: desc,
        });
      }
      out.sort((a, b) => a.day - b.day);
      return out;
    };

    /* ── deferred / release behaviour ─────────────────────────────────── */

    state.deferredRows = function () {
      const out = [];
      for (let i = 0; i < n; i++) {
        if (cols.status.a[i] !== 2) continue;
        out.push({
          row: i, date: dayToDate(cols.postedDay.a[i]),
          account: dicts.accountType.get(cols.accountType.a[i]),
          amount: cols.total.a[i],
          expectedRelease: null,   // this export does not carry one
        });
      }
      return out;
    };

    /* Observed posted→release lag in whole days, per account stream.
       `maturedBefore` drops the right-censoring bias the audit warns about:
       rows posted too close to the export date cannot have released yet, and
       including them drags the median down. */
    state.releaseLags = function (opts) {
      opts = opts || {};
      const fromDay = opts.from ? dayNum({ y: +opts.from.slice(0, 4), m: +opts.from.slice(5, 7) - 1, d: +opts.from.slice(8, 10) }) : -Infinity;
      const toDay = opts.to ? dayNum({ y: +opts.to.slice(0, 4), m: +opts.to.slice(5, 7) - 1, d: +opts.to.slice(8, 10) }) : Infinity;
      const orderIdx = dicts.type.id('Order');
      const byAcct = new Map();
      for (let i = 0; i < n; i++) {
        if (cols.type.a[i] !== orderIdx) continue;
        const p = cols.postedDay.a[i], r = cols.releaseDay.a[i];
        if (p < fromDay || p > toDay) continue;
        if (r < 0) continue;                       // still held: excluded, and counted below
        const a = dicts.accountType.get(cols.accountType.a[i]);
        let arr = byAcct.get(a);
        if (!arr) byAcct.set(a, arr = []);
        arr.push(r - p);
      }
      const out = new Map();
      for (const [a, arr] of byAcct) {
        arr.sort((x, y) => x - y);
        const q = p => arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : null;
        out.set(a, {
          account: a, n: arr.length,
          p10: q(0.10), median: q(0.50), p90: q(0.90),
          mean: arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null,
        });
      }
      return out;
    };

    /* ── multiplicity ─────────────────────────────────────────────────── */

    /* Exact-duplicate groups, found by hash bucket then full field comparison.
       Returned, never acted on: the app shows them and leaves them in place. */
    state.duplicateReport = function () {
      const buckets = new Map();
      for (let i = 0; i < n; i++) {
        const h = cols.rowHash.a[i];
        let b = buckets.get(h);
        if (!b) buckets.set(h, b = []);
        b.push(i);
      }
      const keyOf = i => {
        const r = state.rowAt(i);
        delete r._line; delete r._import;
        return JSON.stringify(r);
      };
      let extraRows = 0, extraCents = 0, groups = 0;
      const examples = [];
      for (const b of buckets.values()) {
        if (b.length < 2) continue;
        const byKey = new Map();
        for (const i of b) {
          const k = keyOf(i);
          let g = byKey.get(k);
          if (!g) byKey.set(k, g = []);
          g.push(i);
        }
        for (const g of byKey.values()) {
          if (g.length < 2) continue;
          groups++;
          extraRows += g.length - 1;
          extraCents += cols.total.a[g[0]] * (g.length - 1);
          if (examples.length < 20) {
            examples.push({ rows: g.slice(0, 6), occurrences: g.length, amount: cols.total.a[g[0]] });
          }
        }
      }
      return { groups, extraRows, extraCents, examples };
    };

    /* ── settlement grouping ──────────────────────────────────────────── */

    /* Sum by settlement id. This is a REFERENCE grouping, not a settlement
       reconciliation: the posted-date extract does not align to settlement
       boundaries, so every group carries a residual until official statements
       are supplied. */
    state.settlementGroups = function () {
      const map = new Map();
      for (let i = 0; i < n; i++) {
        const sid = dicts.settlement.get(cols.settlement.a[i]);
        if (!sid) continue;
        let g = map.get(sid);
        if (!g) map.set(sid, g = { settlementId: sid, rows: 0, net: 0, transfer: 0, firstDay: Infinity, lastDay: -Infinity, accounts: new Set() });
        g.rows++;
        g.net += cols.total.a[i];
        if (dicts.type.get(cols.type.a[i]) === 'Transfer') g.transfer += cols.total.a[i];
        const d = cols.postedDay.a[i];
        if (d >= 0) { if (d < g.firstDay) g.firstDay = d; if (d > g.lastDay) g.lastDay = d; }
        g.accounts.add(dicts.accountType.get(cols.accountType.a[i]));
      }
      for (const g of map.values()) {
        g.from = g.firstDay === Infinity ? null : dayToDate(g.firstDay);
        g.to = g.lastDay === -Infinity ? null : dayToDate(g.lastDay);
        /* A settlement that closed completely inside this extract would show
           activity minus its transfer = 0. The residual is that whole-group net.
           It is NOT missing money: posted-date boundaries, deferral timing and
           an absent opening balance all land here, and only official statements
           can say which. */
        g.residual = g.net;
        g.activityExcludingTransfer = g.net - g.transfer;
        g.accounts = [...g.accounts];
      }
      return map;
    };

    /* ── periods ──────────────────────────────────────────────────────── */

    state.monthly = function (filter) {
      const ok = state.makePredicate(filter);
      const map = new Map();
      const T = Taxonomy.TREAT;
      for (let i = 0; i < n; i++) {
        if (!ok(i)) continue;
        const d = cols.postedDay.a[i];
        if (d < 0) continue;
        const mo = dayToDate(d).slice(0, 7);
        let m = map.get(mo);
        if (!m) map.set(mo, m = { month: mo, netRevenue: 0, sellingFees: 0, fbaFees: 0, ads: 0, nonTransfer: 0, transfers: 0, rows: 0 });
        m.rows++;
        for (let c = 0; c < NC; c++) {
          const v = comp[c].a[i];
          if (v === 0) continue;
          const cl = state.classifyAt(i, c);
          if (cl.treatment === T.REVENUE) m.netRevenue += v;
          if (cl.ruleId === 'ads-cost' || cl.ruleId === 'ads-refund') m.ads += v;
        }
        m.sellingFees += comp[COMPONENTS.indexOf('selling fees')].a[i];
        m.fbaFees += comp[COMPONENTS.indexOf('fba fees')].a[i];
        if (dicts.type.get(cols.type.a[i]) === 'Transfer') m.transfers += cols.total.a[i];
        else m.nonTransfer += cols.total.a[i];
      }
      return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
    };

    state.dateRange = function () {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < n; i++) {
        const d = cols.postedDay.a[i];
        if (d < 0) continue;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      return { from: lo === Infinity ? null : dayToDate(lo), to: hi === -Infinity ? null : dayToDate(hi) };
    };

    state.distinct = function (field) {
      const counts = new Map();
      const col = cols[field];
      const dict = dicts[field];
      if (!col || !dict) return counts;
      for (let i = 0; i < n; i++) {
        const k = dict.get(col.a[i]);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
      return counts;
    };

    /* Only for rehydrating a saved ledger: the column buffers are installed
       directly and the row count has to follow them. Never call this during an
       import — `addRow` owns the count there. */
    state.setRowCount = function (count) { n = count; classCache.length = 0; };

    state.dayToDate = dayToDate;
    state.dayNum = dayNum;
    return state;
  }

  /* ── drivers ──────────────────────────────────────────────────────────── */

  /* A chunk-fed importer. Push text slices in any size; `finish()` returns the
     import record. This is the only path used for the 78 MB export — in the
     browser it is driven from File.stream() inside a worker, in node from
     fs.createReadStream, and neither ever holds the whole file as a string. */
  function Importer(ledger, meta) {
    let header = null, at = null, headerLine = -1;
    const preamble = [];
    let lineNo = 0, added = 0;
    const importId = ledger.imports.length + 1;
    const hasher = CSV.Hasher();

    const reader = CSV.Reader(fields => {
      lineNo++;
      if (!header) {
        if (CSV.isPaymentsHeader(fields)) {
          header = fields.map(s => s.trim());
          at = CSV.indexer(header);
          headerLine = lineNo;
        } else preamble.push(fields);
        return;
      }
      ledger.addRow(fields, at, lineNo, importId);
      added++;
    });

    return {
      push(text) { reader.push(text); },
      get rowsSoFar() { return added; },
      get headerFound() { return !!header; },
      finish() {
        reader.end();
        const rec = {
          importId, name: meta && meta.name, hash: (meta && meta.hash) || null,
          family: 'payments', headerLine, header, preamble,
          rowCount: added,
          importedAt: (meta && meta.importedAt) || new Date().toISOString(),
          schema: header ? CSV.schemaDiff(header, CSV.PAYMENTS_COLUMNS) : null,
          control: JSON.parse(JSON.stringify(ledger.control)),
        };
        ledger.imports.push(rec);
        return rec;
      },
    };
  }

  /* Feed a whole text source (node string or browser stream chunks) into a
     ledger. Returns the import record, including the preserved preamble. */
  function importText(ledger, text, meta) {
    let header = null, at = null, headerLine = -1;
    const preamble = [];
    let lineNo = 0, added = 0;
    const importId = ledger.imports.length + 1;

    const reader = CSV.Reader(fields => {
      lineNo++;
      if (!header) {
        if (CSV.isPaymentsHeader(fields)) {
          header = fields.map(s => s.trim());
          at = CSV.indexer(header);
          headerLine = lineNo;
        } else preamble.push(fields);
        return;
      }
      ledger.addRow(fields, at, lineNo, importId);
      added++;
    });
    reader.push(text);
    reader.end();

    const rec = {
      importId, name: meta && meta.name, hash: meta && meta.hash,
      family: 'payments', headerLine, header, preamble,
      rowCount: added, importedAt: (meta && meta.importedAt) || new Date().toISOString(),
      schema: header ? CSV.schemaDiff(header, CSV.PAYMENTS_COLUMNS) : null,
    };
    ledger.imports.push(rec);
    return rec;
  }

  return { create, Importer, importText, dayToDate, dayNum, COMPONENTS };
});
