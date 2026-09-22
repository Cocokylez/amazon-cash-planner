/* Streaming CSV, header recognition and source-family detection.
 *
 * The 78 MB Payments export cannot be read into a string and split — that is
 * how the browser tab dies. Everything here is chunk-fed: you push slices of
 * text in, rows come out, and nothing retains more than the current row.
 *
 * The header is FOUND, not assumed. Today it sits on line 10 of the Payments
 * export behind a nine-line preamble; the preamble is preserved verbatim
 * because it carries the currency statement and the deferred-transactions note,
 * both of which are evidence.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CSV = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* ── incremental parser ──────────────────────────────────────────────── */

  /* Feed text chunks; `onRow(fields, rawLine)` fires per complete record.
     Handles quoted fields containing commas and newlines, doubled quotes,
     CRLF, and a leading BOM. */
  function Reader(onRow) {
    let cell = '', row = [], q = false, pendingCR = false, raw = '', started = false;

    function endCell() { row.push(cell); cell = ''; }
    function endRow() {
      endCell();
      if (row.length > 1 || (row[0] || '').trim() !== '') onRow(row, raw);
      row = []; raw = '';
    }

    return {
      push(text) {
        if (!started) { text = text.replace(/^﻿/, ''); started = true; }
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (pendingCR) { pendingCR = false; if (ch === '\n') { endRow(); continue; } }
          if (q) {
            if (ch === '"') {
              if (text[i + 1] === '"') { cell += '"'; raw += '""'; i++; }
              else { q = false; raw += '"'; }
            } else { cell += ch; raw += ch; }
          } else if (ch === '"') { q = true; raw += '"'; }
          else if (ch === ',') { endCell(); raw += ','; }
          else if (ch === '\n') { endRow(); }
          else if (ch === '\r') { pendingCR = true; }
          else { cell += ch; raw += ch; }
        }
      },
      end() { if (cell.length || row.length) endRow(); },
    };
  }

  /* Whole-string convenience, for the small preview files and for tests. */
  function parse(text) {
    const rows = [];
    const r = Reader(f => rows.push(f));
    r.push(String(text)); r.end();
    return rows;
  }

  /* ── source families ─────────────────────────────────────────────────── */

  const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');

  /* Exact Payments header, in source order. Used to recognise the header line
     wherever it appears and to detect a schema change rather than silently
     mapping the wrong column. */
  const PAYMENTS_COLUMNS = [
    'date/time', 'settlement id', 'type', 'order id', 'sku', 'description', 'quantity',
    'marketplace', 'account type', 'fulfillment', 'order city', 'order state', 'order postal',
    'tax collection model', 'product sales', 'product sales tax', 'shipping credits',
    'shipping credits tax', 'gift wrap credits', 'giftwrap credits tax', 'Regulatory Fee',
    'Tax On Regulatory Fee', 'promotional rebates', 'promotional rebates tax',
    'marketplace withheld tax', 'selling fees', 'fba fees', 'other transaction fees',
    'other', 'total', 'Transaction Status', 'Transaction Release Date',
  ];

  /* The Payments money components. `total` is deliberately absent: it is the
     control aggregate, never a component to add. */
  const PAYMENTS_COMPONENTS = [
    'product sales', 'product sales tax', 'shipping credits', 'shipping credits tax',
    'gift wrap credits', 'giftwrap credits tax', 'Regulatory Fee', 'Tax On Regulatory Fee',
    'promotional rebates', 'promotional rebates tax', 'marketplace withheld tax',
    'selling fees', 'fba fees', 'other transaction fees', 'other',
  ];

  const PREVIEW_CORE = ['Amazon store', 'Start date', 'End date', 'Parent ASIN', 'ASIN',
    'FNSKU', 'MSKU', 'Currency code', 'Average sales price', 'Units sold', 'Units returned',
    'Net units sold', 'Sales', 'Net sales'];

  /* Fee families in the preview. `parent` names the aggregate a component rolls
     into — components must never be added on top of their parent. */
  const PREVIEW_FEES = [
    { name: 'Aged inventory surcharge', parent: null, group: 'storage' },
    { name: 'Base fulfillment fee', parent: 'FBA fulfillment fees', group: 'fulfilment' },
    { name: 'Base monthly storage fee', parent: 'Monthly inventory storage fee', group: 'storage' },
    { name: 'Closing fee', parent: null, group: 'selling' },
    { name: 'FBA fulfillment fees', parent: null, group: 'fulfilment', aggregate: true },
    { name: 'Fuel and Logistics-related surcharge', parent: 'FBA fulfillment fees', group: 'fulfilment' },
    { name: 'Low-inventory-level fee', parent: 'FBA fulfillment fees', group: 'fulfilment' },
    { name: 'Monthly inventory storage fee', parent: null, group: 'storage', aggregate: true },
    { name: 'Per-item selling fee', parent: null, group: 'selling' },
    { name: 'Referral fee', parent: null, group: 'selling' },
    { name: 'Returns processing fee for Apparel and Shoes', parent: null, group: 'returns' },
    { name: 'Storage utilization surcharge', parent: 'Monthly inventory storage fee', group: 'storage' },
    { name: 'Sponsored Products charge', parent: null, group: 'advertising' },
  ];
  const feeCols = f => ({
    perUnit: f.name + ' per unit',
    quantity: f.name + ' quantity',
    total: f.name + ' total',
  });

  /* Does this row look like the Payments header? Matches on the leading field
     names rather than a line number, so a future export with a longer preamble
     or extra trailing columns is still recognised. */
  function isPaymentsHeader(fields) {
    if (!fields || fields.length < 20) return false;
    const h = fields.map(norm);
    return h[0] === 'date/time' && h[1] === 'settlement id' && h[2] === 'type';
  }
  function isPreviewHeader(fields) {
    if (!fields || fields.length < 8) return false;
    const h = fields.map(norm);

    /* WHAT MAKES THIS THE PREVIEW: the columns that identify a row. Every
       export of this report carries them, whatever was ticked when it was
       asked for. */
    const identity = h.includes('amazon store') && h.includes('msku')
      && h.includes('start date') && h.includes('end date');
    if (!identity) return false;

    /* AND at least one column worth reading. Which ones are present depends on
       the options chosen on Amazon's page: a report asked for with only the
       fulfilment options has no sales columns at all.
       This used to insist on "net sales", so such a file was refused outright
       as "not a Fees & Economics Preview export" - 208 rows of real fulfilment
       fees thrown away because one unrelated box had not been ticked. */
    const hasSales = h.includes('net sales') || h.includes('sales')
      || h.includes('units sold') || h.includes('average sales price');
    const hasFee = PREVIEW_FEES.some(f => h.includes(norm(f.name + ' total')));
    return hasSales || hasFee;
  }

  /* Scan the first rows for a header. Everything before it is preamble and is
     kept verbatim as source evidence. */
  function detect(rows) {
    for (let i = 0; i < rows.length && i < 60; i++) {
      if (isPaymentsHeader(rows[i])) {
        return { family: 'payments', headerIndex: i, header: rows[i].map(s => s.trim()) };
      }
      if (isPreviewHeader(rows[i])) {
        return { family: 'preview', headerIndex: i, header: rows[i].map(s => s.trim()) };
      }
    }
    return { family: null, headerIndex: -1, header: null };
  }

  /* Report exactly how a recognised header differs from the one we mapped
     against, so a schema change is visible instead of silently shifting data. */
  function schemaDiff(header, expected) {
    const h = header.map(norm), e = expected.map(norm);
    return {
      missing: expected.filter((c, i) => !h.includes(e[i])),
      extra: header.filter((c, i) => !e.includes(h[i])),
      reordered: expected.every((c, i) => e[i] === h[i]) ? false : true,
      count: header.length,
    };
  }

  /* Column index lookup that is tolerant of case/spacing but never guesses:
     an unmatched name returns -1 and the caller treats it as "column absent",
     which is not the same as zero. */
  function indexer(header) {
    const map = new Map();
    header.forEach((h, i) => { if (!map.has(norm(h))) map.set(norm(h), i); });
    return name => { const i = map.get(norm(name)); return i == null ? -1 : i; };
  }

  /* ── file identity ───────────────────────────────────────────────────── */

  /* FNV-1a over the bytes, 128-bit-ish via two independent 32-bit lanes plus
     length. Enough to reject an identical re-import; not a security hash, and
     labelled as such wherever it is shown. */
  function Hasher() {
    let a = 0x811c9dc5, b = 0x01000193, len = 0;
    return {
      push(bytes) {
        for (let i = 0; i < bytes.length; i++) {
          const c = bytes[i];
          a ^= c; a = Math.imul(a, 0x01000193) >>> 0;
          b = (b + c) >>> 0; b = Math.imul(b, 0x85ebca6b) >>> 0; b ^= b >>> 13;
        }
        len += bytes.length;
      },
      digest() {
        return (a >>> 0).toString(16).padStart(8, '0')
          + (b >>> 0).toString(16).padStart(8, '0')
          + len.toString(16).padStart(10, '0');
      },
      get length() { return len; },
    };
  }

  /* ── timestamps ──────────────────────────────────────────────────────── */

  const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const MONN = Object.keys(MON);

  /* "Aug 1, 2025 12:00:36 AM PDT" -> calendar parts in the ACCOUNT's own zone,
     with the original zone abbreviation kept.
     Deliberately not converted to UTC: the spec is explicit that a timezone
     conversion must not move a posting across a calendar cutoff, and every
     period boundary in this app is an account-local calendar date. */
  function parseStamp(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (!t) return null;
    const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})(?:[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?\s*([A-Z]{2,5})?/.exec(t);
    if (!m || !(m[1] in MON)) return null;
    let hh = m[4] == null ? 0 : parseInt(m[4], 10);
    const ap = (m[7] || '').toUpperCase();
    if (ap === 'PM' && hh < 12) hh += 12;
    if (ap === 'AM' && hh === 12) hh = 0;
    return {
      y: +m[3], m: MON[m[1]], d: +m[2],
      hh, mm: m[5] == null ? 0 : +m[5], ss: m[6] == null ? 0 : +m[6],
      tz: m[8] || null, raw: t,
    };
  }
  /* Account-local calendar date, the key every period filter uses. */
  const dateOf = t => t ? t.y + '-' + String(t.m + 1).padStart(2, '0') + '-' + String(t.d).padStart(2, '0') : null;
  const monthOf = t => t ? t.y + '-' + String(t.m + 1).padStart(2, '0') : null;

  /* Rebuild the original string from stored parts, to prove nothing was lost. */
  function formatStamp(t) {
    if (!t) return null;
    const h12 = t.hh % 12 === 0 ? 12 : t.hh % 12;
    const ap = t.hh < 12 ? 'AM' : 'PM';
    return MONN[t.m] + ' ' + t.d + ', ' + t.y + ' ' + h12 + ':' + String(t.mm).padStart(2, '0')
      + ':' + String(t.ss).padStart(2, '0') + ' ' + ap + (t.tz ? ' ' + t.tz : '');
  }

  /* Plain "MM/DD/YYYY" or "YYYY-MM-DD", as the preview writes its period
     boundaries. Returns an account-local calendar date string. */
  function parseDate(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (!t) return null;
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    if (m) return t;
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
    if (m) return m[3] + '-' + String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
    const st = parseStamp(t);
    return st ? dateOf(st) : null;
  }

  /* Calendar arithmetic on account-local dates, with no Date object and so no
     timezone to shift anything. */
  function addDays(date, n) {
    const [y, m, d] = date.split('-').map(Number);
    const t = Date.UTC(y, m - 1, d) + n * 86400000;
    const u = new Date(t);
    return u.getUTCFullYear() + '-' + String(u.getUTCMonth() + 1).padStart(2, '0')
      + '-' + String(u.getUTCDate()).padStart(2, '0');
  }
  function daysBetween(a, b) {
    const [ay, am, ad] = a.split('-').map(Number), [by, bm, bd] = b.split('-').map(Number);
    return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
  }
  const weekdayOf = date => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();          // 0 = Sunday
  };

  return {
    Reader, parse, detect, indexer, schemaDiff, norm, Hasher,
    isPaymentsHeader, isPreviewHeader,
    PAYMENTS_COLUMNS, PAYMENTS_COMPONENTS, PREVIEW_CORE, PREVIEW_FEES, feeCols,
    parseStamp, formatStamp, dateOf, monthOf, parseDate, addDays, daysBetween, weekdayOf,
  };
});
