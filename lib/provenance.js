/* Provenance-carrying values.
 *
 * The rule this module exists to enforce: a number on screen must say where it
 * came from, and a number we do not have must say what is missing rather than
 * render as $0. Every figure the UI prints goes through `Val`.
 *
 * Origin is not a decoration. `CALCULATED` over forecast inputs stays
 * forecast-derived — `derive()` propagates the weakest origin of its inputs, so
 * a sum of AMAZON FORECAST rows can never present itself as ACTUAL.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Prov = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* Ordered weakest-evidence-last. derive() takes the max index present. */
  const ORIGIN = {
    ACTUAL: 'ACTUAL',                     // observed, posted, in a source row
    CURRENT: 'CURRENT',                   // an as-of balance/state snapshot
    CALCULATED: 'CALCULATED',             // arithmetic over other values
    AMAZON_FORECAST: 'AMAZON FORECAST',   // Amazon's own estimate, from a preview
    MODEL_FORECAST: 'MODEL FORECAST',     // our estimate
    ASSUMPTION: 'ASSUMPTION',             // a stated planning input
  };
  const RANK = [ORIGIN.ACTUAL, ORIGIN.CURRENT, ORIGIN.CALCULATED,
    ORIGIN.AMAZON_FORECAST, ORIGIN.MODEL_FORECAST, ORIGIN.ASSUMPTION];

  /* Why a value is absent. Kept distinct on purpose: the four mean different
     things to a reader and must never collapse into one "0". */
  const ABSENCE = {
    UNKNOWN: 'UNKNOWN',                   // exists, we do not have it
    NOT_SUPPLIED: 'NOT_SUPPLIED',         // the source did not include it
    NOT_APPLICABLE: 'NOT_APPLICABLE',     // meaningless in this context
    BLOCKED: 'BLOCKED',                   // needs a named input we lack
  };

  /* A value that is genuinely, evidenced zero — distinct from unknown. */
  const KNOWN_ZERO = 'KNOWN_ZERO';

  class Val {
    /* amount: integer cents, or null when absent.
       meta: { origin, asOf, period, account, marketplace, currency,
               completeness, issues[], sources[], formula, ruleVersion } */
    constructor(amount, meta) {
      this.amount = amount == null ? null : amount;
      const m = meta || {};
      this.origin = m.origin || ORIGIN.CALCULATED;
      this.asOf = m.asOf || null;
      this.period = m.period || null;
      this.account = m.account || null;
      this.marketplace = m.marketplace || null;
      this.currency = m.currency || 'USD';
      this.completeness = m.completeness || null;
      this.issues = m.issues || [];
      this.sources = m.sources || [];
      this.formula = m.formula || null;
      this.ruleVersion = m.ruleVersion || null;
      this.absence = m.absence || null;
      this.missing = m.missing || null;   // the specific named input we need
      this.nonAdditive = !!m.nonAdditive; // an explanatory breakdown row
      Object.freeze(this.issues);
    }
    get known() { return this.amount != null; }
    /* True only when the source positively evidences zero. */
    get isKnownZero() { return this.amount === 0 && this.completeness !== KNOWN_ZERO ? true : this.amount === 0; }

    with(patch) { return new Val(patch && 'amount' in patch ? patch.amount : this.amount, Object.assign(this.meta(), patch)); }
    meta() {
      return {
        origin: this.origin, asOf: this.asOf, period: this.period,
        account: this.account, marketplace: this.marketplace, currency: this.currency,
        completeness: this.completeness, issues: this.issues.slice(), sources: this.sources.slice(),
        formula: this.formula, ruleVersion: this.ruleVersion,
        absence: this.absence, missing: this.missing, nonAdditive: this.nonAdditive,
      };
    }
  }

  /* Constructors ------------------------------------------------------- */

  const val = (amount, meta) => new Val(amount, meta);
  const actual = (amount, meta) => new Val(amount, Object.assign({ origin: ORIGIN.ACTUAL }, meta));
  const current = (amount, meta) => new Val(amount, Object.assign({ origin: ORIGIN.CURRENT }, meta));
  const amazonForecast = (amount, meta) => new Val(amount, Object.assign({ origin: ORIGIN.AMAZON_FORECAST }, meta));
  const modelForecast = (amount, meta) => new Val(amount, Object.assign({ origin: ORIGIN.MODEL_FORECAST }, meta));
  const assumption = (amount, meta) => new Val(amount, Object.assign({ origin: ORIGIN.ASSUMPTION }, meta));

  /* The important one. `missing` must name the specific input, so the UI can
     print "Unavailable — current available balance not supplied" rather than a
     bare dash, and so the Data checklist can link straight to it. */
  function unavailable(missing, meta) {
    return new Val(null, Object.assign({
      absence: (meta && meta.absence) || ABSENCE.BLOCKED,
      missing: missing,
      origin: (meta && meta.origin) || ORIGIN.CALCULATED,
    }, meta));
  }
  const notSupplied = (what, meta) => unavailable(what, Object.assign({ absence: ABSENCE.NOT_SUPPLIED }, meta));
  const notApplicable = (why, meta) => unavailable(why, Object.assign({ absence: ABSENCE.NOT_APPLICABLE }, meta));

  /* Arithmetic ---------------------------------------------------------- */

  /* Weakest origin among inputs wins. A calculation over forecasts is a
     forecast; it does not become ACTUAL by being added up. */
  function weakest(vals) {
    let worst = 0;
    for (const v of vals) {
      const i = RANK.indexOf(v.origin);
      if (i > worst) worst = i;
    }
    return RANK[worst];
  }

  /* Combine values. Any unknown input makes the result unknown, carrying every
     reason — a forecast with a hole in it is not a smaller forecast. */
  function derive(vals, fn, meta) {
    const list = vals.filter(Boolean);
    const unknowns = list.filter(v => !v.known);
    const m = Object.assign({
      origin: list.length ? weakest(list) : ORIGIN.CALCULATED,
      sources: [].concat(...list.map(v => v.sources || [])),
      issues: [].concat(...list.map(v => v.issues || [])),
      currency: list.length ? list[0].currency : 'USD',
    }, meta || {});
    if (unknowns.length) {
      return new Val(null, Object.assign(m, {
        absence: ABSENCE.BLOCKED,
        missing: [...new Set(unknowns.map(v => v.missing).filter(Boolean))].join('; ')
          || (meta && meta.missing) || 'an input',
      }));
    }
    // Currencies never silently combine.
    const curs = new Set(list.map(v => v.currency));
    if (curs.size > 1) {
      return new Val(null, Object.assign(m, {
        absence: ABSENCE.BLOCKED,
        missing: 'a dated FX rate — ' + [...curs].join(' and ') + ' cannot be added',
      }));
    }
    return new Val(fn(list.map(v => v.amount)), m);
  }

  const add = (vals, meta) => derive(vals, xs => xs.reduce((a, b) => a + b, 0),
    Object.assign({ formula: 'sum' }, meta));
  const sub = (a, b, meta) => derive([a, b], xs => xs[0] - xs[1],
    Object.assign({ formula: 'difference' }, meta));
  const neg = (a, meta) => derive([a], xs => -xs[0], meta);

  /* Percent-of, with the zero-denominator rule the spec asks for: no
     denominator is N/A, and it says so rather than showing 0% or ∞. */
  function ratio(num, den, meta) {
    if (!num.known || !den.known) {
      return new Val(null, Object.assign({
        absence: ABSENCE.BLOCKED,
        missing: [num, den].filter(v => !v.known).map(v => v.missing).filter(Boolean).join('; ') || 'an input',
      }, meta));
    }
    if (den.amount === 0) {
      return new Val(null, Object.assign({
        absence: ABSENCE.NOT_APPLICABLE, missing: 'denominator is zero',
        origin: weakest([num, den]),
      }, meta));
    }
    const v = new Val(null, Object.assign({ origin: weakest([num, den]) }, meta));
    v.rate = (num.amount / den.amount) * 100;
    return v;
  }

  /* Completeness ------------------------------------------------------- */

  /* A small record the UI shows beside a result: how much of what the figure
     claims to cover is actually backed by source. */
  function coverage(coveredUnits, totalUnits, label) {
    return {
      covered: coveredUnits, total: totalUnits, label: label || null,
      pct: totalUnits ? (coveredUnits / totalUnits) * 100 : null,
      complete: totalUnits > 0 && coveredUnits === totalUnits,
    };
  }

  return {
    ORIGIN, ABSENCE, RANK, KNOWN_ZERO, Val,
    val, actual, current, amazonForecast, modelForecast, assumption,
    unavailable, notSupplied, notApplicable,
    derive, add, sub, neg, ratio, weakest, coverage,
  };
});
