/* The data model, persistence, and the prioritised data checklist.
 *
 * Raw imports are immutable. Normalised entities reference them by import id
 * and line number, so a rule change re-derives figures without touching source
 * evidence, and a rollback restores the previous financial view without
 * deleting anything.
 *
 * Persistence is IndexedDB, and its availability is VERIFIED at runtime rather
 * than assumed — where storage is blocked the app says so plainly and runs in
 * memory for the session instead of pretending the data is safe.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'));
  } else root.Store = factory(root.CSV);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV) {

  const DB_NAME = 'fba-cash-organizer';
  const DB_VERSION = 1;
  const STORES = ['imports', 'snapshots', 'deferredSnapshots', 'assumptions', 'requestPlans',
    'forecastRuns', 'productCosts', 'cashCommitments', 'settlements', 'bankDeposits',
    'advertisingBilling', 'fxRates', 'ledgerBlobs', 'meta'];

  /* ── the data checklist ──────────────────────────────────────────────── */

  /* Everything the application needs but does not have, in the order that
     unblocks the most. Each item names exactly what it unlocks, so the list is
     a work queue rather than a complaint. */
  const CHECKLIST = [
    {
      id: 'current-balances', priority: 1,
      title: 'Current Amazon balances, all at the same timestamp',
      detail: 'Total, available, deferred, reserve, open settlement and any next-transfer '
        + 'information, per account stream and marketplace.',
      unlocks: 'Every real "available to request" amount. Without it the payout engine has no '
        + 'opening balance and returns Unavailable rather than a guess.',
      blocks: ['cash-dashboard', 'payout-forecast', 'cash-plan'],
    },
    {
      id: 'deferred-export', priority: 1,
      title: 'Current Deferred Transactions export',
      detail: 'The full held population including September, with expected release dates.',
      unlocks: 'The near-term release schedule, and which held funds land before a chosen '
        + 'request date.',
      blocks: ['payout-forecast'],
    },
    {
      id: 'september-transactions', priority: 1,
      title: 'Payments transaction report, 1 September to today',
      detail: 'The supplied history stops on 31 August 2026.',
      unlocks: 'The bridge from the August history to the current state.',
      blocks: ['cash-dashboard', 'reconciliation'],
    },
    {
      id: 'settlements', priority: 1,
      title: 'Statements / settlement detail and disbursement status history',
      detail: 'Twelve months preferred, plus the current open settlement. Recent two to three '
        + 'complete periods are enough to start.',
      unlocks: 'A real settlement bridge. Today all 151 settlement-id groups carry residuals '
        + 'between -$57,213.61 and $40,972.13, and only official controls can explain them.',
      blocks: ['reconciliation'],
    },
    {
      id: 'request-policy', priority: 1,
      title: 'Your intended request dates and the account\'s request rules',
      detail: 'Planned early-request dates, the confirmed next normal scheduled payout date, '
        + 'and any restrictions Seller Central displays (cooldown, partial amounts, '
        + 'minimum, instant availability).',
      unlocks: 'The chosen-date calculation and the two-week comparison. Nothing about these '
        + 'rules is assumed, and historical transfer spacing cannot supply them because that '
        + 'spacing is your own early requests.',
      blocks: ['cash-dashboard', 'payout-forecast'],
    },
    {
      id: 'advertising-billing', priority: 1,
      title: 'Advertising billing records and payment-method history',
      detail: 'May 2026 onward, with invoices, service periods and evidence of card or '
        + 'Amazon-deduction billing.',
      unlocks: 'Correct advertising in both engines. Settlement deductions are zero from June '
        + 'to August 2026 while the preview still forecasts substantial spend, so the expense '
        + 'is currently visible in neither Amazon cash nor company cash.',
      blocks: ['profitability', 'cash-plan'],
    },
    {
      id: 'october-preview', priority: 1,
      title: 'The missing Fees & Economics Preview for 16–31 October 2026',
      detail: 'Refresh the near-term previews together.',
      unlocks: 'Complete economic coverage across the eight-week horizon. Those 16 days '
        + 'currently produce no forecast activity and are shown as uncovered.',
      blocks: ['payout-forecast'],
    },
    {
      id: 'bank-deposits', priority: 1,
      title: 'Bank deposit history',
      detail: 'Twelve months preferred; two to three recent months to begin. Dates and amounts.',
      unlocks: 'Bank arrival dates. Until then a transfer evidences cash leaving Amazon and '
        + 'nothing about when it lands, and no transit time is assumed.',
      blocks: ['cash-dashboard', 'reconciliation', 'cash-plan'],
    },
    {
      id: 'product-costs', priority: 1,
      title: 'Product and landed costs, with effective dates',
      detail: 'Per MSKU, with the landed-cost policy and SKU mapping.',
      unlocks: 'Gross profit and any claim about margin. Without it the bottom line stays '
        + '"contribution after recorded costs".',
      blocks: ['profitability'],
    },
    {
      id: 'operating-costs', priority: 1,
      title: 'Operating costs outside Amazon',
      detail: 'Rent, software, wages, accountancy and the rest, with dates.',
      unlocks: 'Operating profit, and with product costs also supplied, the first figure this '
        + 'app can honestly call net profit rather than contribution.',
      blocks: ['profitability'],
    },
    {
      id: 'bank-cash', priority: 1,
      title: 'Opening bank cash and dated commitments',
      detail: 'Current bank balance, due bills, credit cards, inventory purchase commitments '
        + 'and the cash buffer you want to hold.',
      unlocks: 'Cash available for bills. No spendable-cash figure is shown until these exist.',
      blocks: ['cash-plan'],
    },
    {
      id: 'storage-reports', priority: 2,
      title: 'Detailed monthly storage, fee adjustment and reimbursement reports',
      detail: 'Especially around the July 2026 label change and the blank-description rows.',
      unlocks: 'Economic service periods for storage, and identification of the $3,733.47 of '
        + 'unresolved debits.',
      blocks: ['expenses'],
    },
    {
      id: 'inventory', priority: 2,
      title: 'Inventory on hand, on order, lead times and planned promotions',
      unlocks: 'Inventory-constrained forecasts and purchase timing.',
      blocks: ['cash-plan'],
    },
    {
      id: 'snapshots', priority: 2,
      title: 'Daily or weekly saved balance snapshots, starting now',
      detail: 'The app saves one every time you record current balances.',
      unlocks: 'Genuine point-in-time backtesting. Today\'s forecast accuracy cannot be '
        + 'measured against history that was never recorded.',
      blocks: ['forecast-vs-actual'],
    },
  ];

  /* Which checklist items are still outstanding, given what has been supplied. */
  function outstanding(state) {
    const have = new Set();
    if (state.balanceSnapshots && state.balanceSnapshots.length) have.add('current-balances');
    if (state.deferredSnapshots && state.deferredSnapshots.length) have.add('deferred-export');
    if (state.settlements && state.settlements.length) have.add('settlements');
    if (state.bankDeposits && state.bankDeposits.length) have.add('bank-deposits');
    if (state.productCosts && state.productCosts.length) have.add('product-costs');
    if (state.operatingCosts && state.operatingCosts.length) have.add('operating-costs');
    if (state.advertisingBilling && state.advertisingBilling.length) have.add('advertising-billing');
    if (state.cashCommitments && state.cashCommitments.length) have.add('bank-cash');
    if (state.policy && state.policy.nextScheduledPayout) have.add('request-policy');
    if (state.ledgerRange && state.ledgerRange.to && state.ledgerRange.to >= '2026-09-01') have.add('september-transactions');
    if (state.previewCoverageComplete) have.add('october-preview');
    return CHECKLIST.filter(c => !have.has(c.id));
  }

  /* Which screens are blocked, and by what. Drives the "Unavailable — …" copy
     so the reason is always specific. */
  function blockedScreens(state) {
    const out = new Map();
    for (const item of outstanding(state)) {
      for (const screen of item.blocks || []) {
        if (!out.has(screen)) out.set(screen, []);
        out.get(screen).push(item);
      }
    }
    return out;
  }

  /* ── snapshots ───────────────────────────────────────────────────────── */

  /* Snapshots are never summed. Each is a point-in-time observation, and the
     only valid operation across two of them is comparison. */
  function diffSnapshots(a, b) {
    if (!a || !b) return null;
    const keys = ['available', 'deferred', 'reserve', 'inTransit'];
    const changes = {};
    for (const k of keys) {
      changes[k] = (a[k] == null || b[k] == null) ? null : b[k] - a[k];
    }
    return {
      from: a.observedAt, to: b.observedAt,
      days: a.observedAt && b.observedAt
        ? CSV.daysBetween(a.observedAt.slice(0, 10), b.observedAt.slice(0, 10)) : null,
      changes,
      note: 'A comparison of two observations. Snapshots are never added together.',
    };
  }

  /* Match held transactions across two deferred snapshots so a receivable is
     never counted twice and a postponement is visible. */
  function diffDeferred(prev, next) {
    const key = t => (t.orderId || '') + '|' + (t.postedAt || '') + '|' + t.amount;
    const prevMap = new Map((prev || []).map(t => [key(t), t]));
    const nextMap = new Map((next || []).map(t => [key(t), t]));
    const released = [], added = [], postponed = [], unchanged = [];
    for (const [k, t] of prevMap) {
      const n = nextMap.get(k);
      if (!n) released.push(t);
      else if (n.expectedRelease && t.expectedRelease && n.expectedRelease > t.expectedRelease) {
        postponed.push({ ...n, previousExpected: t.expectedRelease });
      } else unchanged.push(n);
    }
    for (const [k, t] of nextMap) if (!prevMap.has(k)) added.push(t);
    return {
      released, added, postponed, unchanged,
      releasedAmount: released.reduce((s, t) => s + t.amount, 0),
      addedAmount: added.reduce((s, t) => s + t.amount, 0),
      note: 'Transactions are matched between snapshots so the same receivable is never '
        + 'counted twice and a delayed release is visible rather than silent.',
    };
  }

  /* ── IndexedDB ───────────────────────────────────────────────────────── */

  /* Verify storage really works before claiming durability. Returns a report
     the UI shows verbatim — no optimistic assumptions. */
  function probeStorage() {
    return new Promise(resolve => {
      if (typeof indexedDB === 'undefined') {
        resolve({ available: false, reason: 'IndexedDB is not available in this context.', durable: false });
        return;
      }
      let settled = false;
      const done = r => { if (!settled) { settled = true; resolve(r); } };
      const timer = setTimeout(() => done({
        available: false, durable: false,
        reason: 'IndexedDB did not respond. This usually means site data is blocked.',
      }), 4000);
      try {
        const req = indexedDB.open('__fba_probe__', 1);
        req.onupgradeneeded = () => { req.result.createObjectStore('t'); };
        req.onerror = () => { clearTimeout(timer); done({ available: false, durable: false, reason: 'IndexedDB was refused, most likely a private window or blocked site data.' }); };
        req.onsuccess = () => {
          clearTimeout(timer);
          const db = req.result;
          try {
            const tx = db.transaction('t', 'readwrite');
            tx.objectStore('t').put(1, 'k');
            tx.oncomplete = () => {
              db.close();
              indexedDB.deleteDatabase('__fba_probe__');
              /* A successful write proves the data is STORED. It does not prove
                 the browser will keep it: without a persistence grant, storage
                 is evictable under pressure. Ask for the grant, then report
                 what was actually granted rather than assuming it. */
              const est = (navigator.storage && navigator.storage.estimate)
                ? navigator.storage.estimate() : Promise.resolve(null);
              const persist = (navigator.storage && navigator.storage.persist)
                ? navigator.storage.persist().catch(() => false)
                : Promise.resolve(null);
              Promise.all([est, persist]).then(([e, granted]) => done({
                available: true,
                durable: granted === true,
                evictable: granted !== true,
                persistenceAsked: granted !== null,
                quota: e ? e.quota : null, usage: e ? e.usage : null,
                reason: granted === true ? null
                  : granted === null
                    ? 'This browser does not expose a persistence grant, so stored data may be '
                      + 'evicted if the device runs low on space.'
                    : 'The browser stored the data but declined to mark it persistent, so it '
                      + 'may be evicted if the device runs low on space.',
              })).catch(() => done({
                available: true, durable: false, evictable: true,
                quota: null, usage: null,
                reason: 'Storage is available but its durability could not be established.',
              }));
            };
            tx.onerror = () => { db.close(); done({ available: false, durable: false, reason: 'A write to IndexedDB failed.' }); };
          } catch (e) {
            done({ available: false, durable: false, reason: 'IndexedDB threw: ' + e.message });
          }
        };
      } catch (e) {
        clearTimeout(timer);
        done({ available: false, durable: false, reason: 'IndexedDB threw: ' + e.message });
      }
    });
  }

  function open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) {
          if (!db.objectStoreNames.contains(s)) {
            db.createObjectStore(s, { keyPath: 'id', autoIncrement: true });
          }
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const tx = (db, store, mode) => db.transaction(store, mode).objectStore(store);
  const wrap = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const put = (db, store, value) => wrap(tx(db, store, 'readwrite').put(value));
  const all = (db, store) => wrap(tx(db, store, 'readonly').getAll());
  const clear = (db, store) => wrap(tx(db, store, 'readwrite').clear());
  const del = (db, store, id) => wrap(tx(db, store, 'readwrite').delete(id));

  /* The columnar ledger persists as raw ArrayBuffers plus its dictionaries —
     roughly 30 MB for 180,658 rows, which IndexedDB handles comfortably and
     localStorage could never hold. */
  function serialiseLedger(ledger) {
    const cols = {};
    for (const k in ledger.cols) {
      const a = ledger.cols[k].a;
      cols[k] = { type: a.constructor.name, buffer: a.buffer.slice(0, ledger.rowCount * a.BYTES_PER_ELEMENT) };
    }
    const comp = ledger.comp.map(c => ({
      type: c.a.constructor.name,
      buffer: c.a.buffer.slice(0, ledger.rowCount * c.a.BYTES_PER_ELEMENT),
    }));
    const dicts = {};
    for (const k in ledger.dicts) dicts[k] = ledger.dicts[k].values();
    return {
      id: 'ledger', rowCount: ledger.rowCount, cols, comp, dicts,
      imports: ledger.imports, control: ledger.control,
      savedAt: new Date().toISOString(),
    };
  }

  /* Rebuild a ledger from what `serialiseLedger` wrote. The caller supplies the
     Ledger factory so this module stays free of that dependency. Returns null
     when the stored shape does not match the current code, rather than
     resurrecting a ledger whose columns mean something different now. */
  function deserialiseLedger(blob, LedgerModule) {
    if (!blob || !blob.rowCount) return null;
    const TYPES = {
      Int8Array, Uint8Array, Int16Array, Uint16Array,
      Int32Array, Uint32Array, Float32Array, Float64Array,
    };
    const led = LedgerModule.create(blob.rowCount || 1024);
    try {
      for (const k in blob.cols) {
        if (!led.cols[k]) return null;                  // schema drift
        const T = TYPES[blob.cols[k].type];
        if (!T) return null;
        led.cols[k].a = new T(blob.cols[k].buffer);
      }
      if (!Array.isArray(blob.comp) || blob.comp.length !== led.comp.length) return null;
      blob.comp.forEach((c, i) => {
        const T = TYPES[c.type];
        led.comp[i].a = new T(c.buffer);
      });
      for (const k in blob.dicts) {
        if (led.dicts[k]) led.dicts[k].load(blob.dicts[k]);
      }
      led.setRowCount(blob.rowCount);
      led.imports.length = 0;
      for (const r of blob.imports || []) led.imports.push(r);
      Object.assign(led.control, blob.control || {});
      return led;
    } catch (e) {
      return null;
    }
  }

  /* Export everything as one JSON file, so a session-only environment still has
     a real backup rather than a promise of one. */
  /* JSON has no BigInt. Tag it rather than lose cents. */
  function encodePreviews(previews) {
    return JSON.parse(JSON.stringify(previews, (k, v) =>
      (typeof v === 'bigint' ? { __big: v.toString() } : v)));
  }
  function decodePreviews(raw) {
    const revive = v => {
      if (v && typeof v === 'object') {
        if (typeof v.__big === 'string') return BigInt(v.__big);
        if (Array.isArray(v)) return v.map(revive);
        const out = {};
        for (const k in v) out[k] = revive(v[k]);
        return out;
      }
      return v;
    };
    return revive(raw || []);
  }

  function exportBackup(state) {
    return {
      format: 'fba-cash-organizer/backup', version: 2,
      openingBankCash: state.openingBankCash == null ? null : state.openingBankCash,
      cashPlan: state.cashPlan || null,
      ledger: state.ledger ? JSON.stringify(serialiseLedger(state.ledger), (key, value) => {
        if (!(value instanceof ArrayBuffer)) return value;
        const bytes = new Uint8Array(value);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) {
          binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
        }
        return { __buf: btoa(binary) };
      }) : null,
      exportedAt: new Date().toISOString(),
      imports: state.imports || [],
      balanceSnapshots: state.balanceSnapshots || [],
      deferredSnapshots: state.deferredSnapshots || [],
      assumptions: state.assumptions || [],
      requestPlans: state.requestPlans || [],
      forecastRuns: state.forecastRuns || [],
      productCosts: state.productCosts || [],
      operatingCosts: state.operatingCosts || [],
      cashCommitments: state.cashCommitments || [],
      settlements: state.settlements || [],
      bankDeposits: state.bankDeposits || [],
      advertisingBilling: state.advertisingBilling || [],
      fxRates: state.fxRates || [],
      policy: state.policy || null,
      /* The parsed forecast reports travel WITH the backup. Without them a
         restore listed the imports and showed no figures, which is not a
         migration. Amounts are exact BigInt decimals, so they are tagged on
         the way out and restored on the way back rather than coerced. */
      previews: encodePreviews(state.previews || []),
      note: 'Includes parsed forecast reports and full transaction ledger. Transfer this financial-data file only to a trusted destination. It contains no Amazon browser session or helper credentials.',
    };
  }

  return {
    DB_NAME, DB_VERSION, STORES, CHECKLIST,
    outstanding, blockedScreens, diffSnapshots, diffDeferred,
    probeStorage, open, put, all, clear, del, serialiseLedger, deserialiseLedger, exportBackup,
    encodePreviews, decodePreviews,
  };
});
