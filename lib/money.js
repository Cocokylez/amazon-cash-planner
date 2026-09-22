/* Exact money.
 *
 * Two representations, because the two source families have genuinely different
 * precision and pretending otherwise loses cents:
 *
 *   cents  — signed integer USD cents in a plain Number. The Payments ledger is
 *            always exactly 2dp (verified across all 180,658 rows), so cents is
 *            lossless there and fast enough to scan 180k rows many times.
 *
 *   dec    — exact decimal as a BigInt scaled by 10^SCALE. The Fees & Economics
 *            Preview carries up to 10 decimal places on Net sales, Sales and
 *            Average sales price (e.g. "9551.4733333297"). Truncating those to
 *            cents shifts a file total by a few cents, so forecast inputs keep
 *            full precision until the one documented rounding step at display.
 *
 * Nothing here rounds implicitly. Rounding happens only in `round()`/`fmt()`,
 * half-up away from zero, and callers say when.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Money = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* ── exact decimal (BigInt, fixed scale) ─────────────────────────────── */

  const SCALE = 10;                        // covers every precision seen in source
  const POW = 10n ** BigInt(SCALE);
  const ZERO = 0n;

  /* Split a numeric string into sign / integer / fraction without any float
     step. Returns null for blank — blank is NOT zero anywhere in this app. */
  function split(v) {
    if (v == null) return null;
    let s = String(v).replace(/[$\s ]/g, '');
    if (s === '') return null;
    // thousands separators only between digits, so "1,234.5" works and "," doesn't
    s = s.replace(/,(?=\d{3}(\D|$))/g, '');
    if (s === '' || s === '-' || s === '+') return null;
    let neg = false;
    if (s[0] === '-') { neg = true; s = s.slice(1); }
    else if (s[0] === '+') s = s.slice(1);
    // parenthesised negatives, seen in some Amazon exports
    if (/^\(.*\)$/.test(s)) { neg = !neg; s = s.slice(1, -1); }
    const dot = s.indexOf('.');
    const whole = dot < 0 ? s : s.slice(0, dot);
    const frac = dot < 0 ? '' : s.slice(dot + 1);
    if (!/^\d*$/.test(whole) || !/^\d*$/.test(frac)) return null;
    if (whole === '' && frac === '') return null;
    return { neg, whole: whole || '0', frac };
  }

  /* Exact decimal from a source string. Returns null when the cell is blank or
     unparsable — the caller must decide what that means, never assume zero. */
  function dec(v) {
    const p = split(v);
    if (!p) return null;
    const frac = (p.frac + '0'.repeat(SCALE)).slice(0, SCALE);
    if (p.frac.length > SCALE) {
      // Beyond our scale: keep what we can and record nothing silently — the
      // importer surfaces this as a precision warning rather than rounding here.
      const kept = BigInt(p.whole) * POW + BigInt(p.frac.slice(0, SCALE));
      return p.neg ? -kept : kept;
    }
    const n = BigInt(p.whole) * POW + BigInt(frac || '0');
    return p.neg ? -n : n;
  }

  /* How many decimal places the source actually wrote. Used by the importer to
     assert the ledger really is 2dp and to warn when a preview exceeds SCALE. */
  function scaleOf(v) {
    const p = split(v);
    return p ? p.frac.length : null;
  }

  const decFromCents = c => BigInt(Math.trunc(c)) * (POW / 100n);
  const decAdd = (a, b) => (a == null ? b : b == null ? a : a + b);

  /* Round an exact decimal to whole cents, half-up away from zero. This is the
     only place a forecast amount loses precision, and it is called at display. */
  function round(d) {
    if (d == null) return null;
    const per = POW / 100n;                 // 10^8 units per cent
    const neg = d < ZERO;
    const a = neg ? -d : d;
    const q = a / per, r = a % per;
    const up = r * 2n >= per ? q + 1n : q;
    return Number(neg ? -up : up);
  }

  /* ── integer cents (the Payments ledger) ─────────────────────────────── */

  /* Exact cents from a 2dp source string. Returns null for blank.
     Throws nothing: `scaleOf` is how the importer catches >2dp ledger cells. */
  function cents(v) {
    const p = split(v);
    if (!p) return null;
    const frac = (p.frac + '00').slice(0, 2);
    const n = parseInt(p.whole, 10) * 100 + parseInt(frac || '0', 10);
    return p.neg ? -n : n;
  }

  /* Same, but a blank cell means 0. Only for columns where Amazon writes "0"
     and blank interchangeably within one row's component set — the component
     sum control proves that reading is right for the ledger money columns. */
  const cents0 = v => { const c = cents(v); return c == null ? 0 : c; };

  /* ── formatting ──────────────────────────────────────────────────────── */

  const group = s => s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /* Cents -> "1,234.56". Never returns "0.00" for an unknown: pass null and
     you get null back, so the caller must render "Unavailable" deliberately. */
  let displayCurrency = 'USD';
  const setCurrency = value => { displayCurrency = /^[A-Z]{3}$/.test(value || '') ? value : 'USD'; };
  function fmt(c, opts) {
    if (c == null || !Number.isFinite(c)) return null;
    const o = opts || {};
    const neg = c < 0;
    const a = Math.abs(c);
    const body = group(String(Math.floor(a / 100))) + '.' + String(a % 100).padStart(2, '0');
    const sign = neg ? '-' : (o.plus ? '+' : '');
    return sign + (o.bare ? '' : displayCurrency === 'USD' ? '$' : displayCurrency + ' ') + body;
  }
  const fmtDec = (d, opts) => fmt(round(d), opts);

  /* Compact form for axis labels and dense tables. Still never invents a zero. */
  function fmtShort(c) {
    if (c == null || !Number.isFinite(c)) return null;
    const neg = c < 0, a = Math.abs(c) / 100;
    const s = a >= 1e6 ? (a / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M'
      : a >= 1e3 ? (a / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'k'
        : a.toFixed(0);
    return (neg ? '-' : '') + (displayCurrency === 'USD' ? '$' : displayCurrency + ' ') + s;
  }

  /* Percentages carry their own zero-denominator rule: no denominator means
     N/A, not 0% and not Infinity. */
  function pct(num, den, dp) {
    if (num == null || den == null || den === 0) return null;
    return (num / den) * 100;
  }
  const fmtPct = (p, dp) => p == null || !Number.isFinite(p)
    ? null : (p >= 0 ? '' : '-') + Math.abs(p).toFixed(dp == null ? 1 : dp) + '%';

  /* Rates and FX keep more precision than money on purpose. */
  const fmtRate = (r, dp) => r == null || !Number.isFinite(r) ? null : r.toFixed(dp == null ? 4 : dp);

  /* ── crossing a boundary ──────────────────────────────────────────────
     JSON has no BigInt. Every exact value here is one, so anything leaving
     this process - to the archive, to a file, to another machine - goes as
     {$dec: "<scaled integer>"} rather than as a Number that has quietly
     rounded. Deep, because money is nested inside the fee families.

     The tag matters. A bare string could be read back as text; a bare number
     could be read back as a float that looks close enough to be believed. */
  function encodeExact(value) {
    if (typeof value === 'bigint') return { $dec: value.toString() };
    if (Array.isArray(value)) return value.map(encodeExact);
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = encodeExact(value[k]);
      return out;
    }
    return value;
  }

  /* The inverse, for reading back what was stored. */
  function decodeExact(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && typeof value.$dec === 'string') return BigInt(value.$dec);
    if (Array.isArray(value)) return value.map(decodeExact);
    if (value && typeof value === 'object') {
      const out = {};
      for (const k of Object.keys(value)) out[k] = decodeExact(value[k]);
      return out;
    }
    return value;
  }

  return {
    SCALE, POW, encodeExact, decodeExact,
    split, dec, scaleOf, decFromCents, decAdd, round,
    cents, cents0,
    fmt, fmtDec, fmtShort, pct, fmtPct, fmtRate, group, setCurrency,
  };
});
