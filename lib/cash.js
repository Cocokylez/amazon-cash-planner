/* Availability and the early-payout request engine.
 *
 * This is the part the whole application exists for: if a payout is requested
 * on a chosen date, how much should be available, when should it reach the
 * bank, and what is left for the next one.
 *
 * Three events are kept strictly apart, because conflating any two of them is
 * how a cash forecast starts lying:
 *
 *   RELEASE    funds stop being deferred and become eligible
 *   REQUEST    we ask Amazon for a payout, and a transfer is initiated
 *   RECEIPT    the money lands in the bank
 *
 * Requesting early moves the second and third. It does not create sales, does
 * not make deferred money eligible sooner, and does not change profit. A payout
 * already requested reduces the balance every later forecast starts from — the
 * single invariant that stops "$30,000 now AND $40,000 later".
 *
 * Nothing here assumes an account policy. Cooldowns, partial-request support,
 * schedule resets and bank transit times all start UNVERIFIED, and any output
 * that depends on one is Unavailable, naming the input it needs. Historical
 * transfer spacing is deliberately never used to infer a schedule: the user has
 * confirmed the recent cadence is their own early requests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./csv.js'), require('./provenance.js'));
  } else root.Cash = factory(root.CSV, root.Prov);
})(typeof self !== 'undefined' ? self : globalThis, function (CSV, Prov) {

  /* Event kinds. Each one changes exactly one pair of balances, once. */
  const EV = {
    OPENING: 'opening',              // the snapshot every forecast starts from
    RELEASE: 'release',              // deferred -> available, same net amount
    NEW_AVAILABLE: 'new_available',  // new activity landing straight in available
    NEW_DEFERRED: 'new_deferred',    // new activity landing in deferred
    CHARGE: 'charge',                // a fee/debit hitting available
    CREDIT: 'credit',                // a credit landing in available
    RESERVE_HOLD: 'reserve_hold',    // available -> reserve
    RESERVE_RELEASE: 'reserve_release',
    REQUEST: 'request',              // a payout request; initiates a transfer
    BANK_RECEIPT: 'bank_receipt',    // in-transit -> bank
  };

  /* An account policy with nothing assumed. `null` means "not verified", and
     every consumer must treat null as blocking rather than as a default. */
  function emptyPolicy() {
    return {
      partialRequestsSupported: null,
      minimumRequest: null,
      cooldownDays: null,
      scheduleResetsOnRequest: null,
      nextScheduledPayout: null,
      scheduleIntervalDays: null,
      bankTransitDaysLow: null,
      bankTransitDaysHigh: null,
      instantPayoutAvailable: null,
      source: null,
      observedAt: null,
    };
  }

  /* ── the balance state machine ───────────────────────────────────────── */

  function Balances(init) {
    return {
      available: init && init.available != null ? init.available : null,
      deferred: init && init.deferred != null ? init.deferred : null,
      reserve: init && init.reserve != null ? init.reserve : null,
      inTransit: init && init.inTransit != null ? init.inTransit : 0,
      bank: 0,
    };
  }
  const cloneBal = b => ({ ...b });

  /* Apply one event. Returns the new balances plus a description of what moved,
     so the payout bridge can be rendered line by line from real movements
     rather than re-derived by a second, divergent calculation. */
  function apply(bal, ev) {
    const b = cloneBal(bal);
    const moved = { kind: ev.kind, date: ev.date, amount: ev.amount, from: null, to: null };
    const needAvailable = () => {
      if (b.available == null) {
        throw new Unavailable('a verified opening available balance',
          'Event "' + ev.kind + '" on ' + ev.date + ' changes available funds, but the '
          + 'opening available balance was never supplied.');
      }
    };
    switch (ev.kind) {
      case EV.OPENING:
        b.available = ev.available;
        b.deferred = ev.deferred;
        b.reserve = ev.reserve;
        moved.to = 'opening';
        break;
      case EV.RELEASE:
        needAvailable();
        /* The same net amount moves. No revenue is recognised again and no fee
           is deducted again — the amount released is already net. */
        if (b.deferred != null) b.deferred -= ev.amount;
        b.available += ev.amount;
        moved.from = 'deferred'; moved.to = 'available';
        break;
      case EV.NEW_AVAILABLE:
        needAvailable();
        b.available += ev.amount;
        moved.to = 'available';
        break;
      case EV.NEW_DEFERRED:
        if (b.deferred == null) b.deferred = 0;
        b.deferred += ev.amount;
        moved.to = 'deferred';
        break;
      case EV.CHARGE:
        needAvailable();
        b.available -= ev.amount;
        moved.from = 'available';
        break;
      case EV.CREDIT:
        needAvailable();
        b.available += ev.amount;
        moved.to = 'available';
        break;
      case EV.RESERVE_HOLD:
        needAvailable();
        b.available -= ev.amount;
        b.reserve = (b.reserve || 0) + ev.amount;
        moved.from = 'available'; moved.to = 'reserve';
        break;
      case EV.RESERVE_RELEASE:
        needAvailable();
        b.available += ev.amount;
        b.reserve = (b.reserve || 0) - ev.amount;
        moved.from = 'reserve'; moved.to = 'available';
        break;
      case EV.REQUEST:
        needAvailable();
        /* THE invariant. Requested cash leaves available immediately and is in
           transit until the bank confirms it. Every later calculation starts
           from the reduced balance. */
        b.available -= ev.amount;
        b.inTransit += ev.amount;
        moved.from = 'available'; moved.to = 'inTransit';
        break;
      case EV.BANK_RECEIPT:
        b.inTransit -= ev.amount;
        b.bank += ev.amount;
        moved.from = 'inTransit'; moved.to = 'bank';
        break;
      default:
        throw new Error('unknown event kind: ' + ev.kind);
    }
    return { balances: b, moved };
  }

  /* A typed error so a blocked calculation carries the specific missing input
     all the way to the screen instead of becoming a zero. */
  function Unavailable(missing, detail) {
    const e = new Error(detail || ('Unavailable — ' + missing));
    e.name = 'Unavailable';
    e.missing = missing;
    e.detail = detail || null;
    return e;
  }

  /* ── the engine ──────────────────────────────────────────────────────── */

  /* One engine per account stream and currency. Streams are never combined:
     Standard Orders and Invoiced Orders have different release behaviour and
     their own transfers. */
  function createEngine(opts) {
    opts = opts || {};
    const account = opts.account || 'Standard Orders';
    const currency = opts.currency || 'USD';
    /* The instant the opening snapshot describes. Every event must be strictly
       after it, so a charge already inside the opening balance cannot be
       applied a second time. */
    const cutoff = opts.cutoff || null;
    const policy = Object.assign(emptyPolicy(), opts.policy || {});

    const events = [];
    let opening = null;
    const issues = [];

    const api = {
      account, currency, policy, get cutoff() { return cutoff; },
      get events() { return events.slice(); },
      get opening() { return opening; },
      get issues() { return issues.slice(); },
    };

    /* The opening snapshot. Without it nothing downstream can produce a
       number, and that is the intended behaviour. */
    api.setOpening = function (snap) {
      opening = {
        kind: EV.OPENING,
        date: snap.asOf || cutoff,
        available: snap.available == null ? null : snap.available,
        deferred: snap.deferred == null ? null : snap.deferred,
        reserve: snap.reserve == null ? null : snap.reserve,
        asOf: snap.asOf || null,
        source: snap.source || null,
        /* Membership: what the opening balance already includes, so the same
           activity is never applied twice. */
        includesActivityThrough: snap.includesActivityThrough || snap.asOf || null,
      };
      if (opening.available == null) issues.push('Opening available balance not supplied.');
      if (opening.deferred == null) issues.push('Opening deferred balance not supplied.');
      if (opening.reserve == null) issues.push('Opening reserve balance not supplied — reserves are '
        + 'tracked separately and are not assumed to be zero.');
      return api;
    };

    /* Add an event. Events at or before the opening cutoff are REJECTED rather
       than applied, because the opening balance already contains them. */
    api.add = function (ev) {
      if (!ev || !ev.date) throw new Error('event needs a date');
      const member = opening && opening.includesActivityThrough;
      if (member && ev.date <= member && ev.kind !== EV.OPENING) {
        issues.push('Event on ' + ev.date + ' (' + ev.kind + ') falls inside the opening '
          + 'snapshot period and was not applied again.');
        return api;
      }
      events.push(Object.assign({ account, currency }, ev));
      return api;
    };
    api.addAll = function (list) { for (const e of list) api.add(e); return api; };

    /* Sort key: date, then a fixed ordering within a day so a release that
       lands on the request date is counted before the request reads the
       balance, and a request is counted before the next day's activity. */
    const ORDER = {
      [EV.OPENING]: 0, [EV.RELEASE]: 1, [EV.NEW_AVAILABLE]: 2, [EV.NEW_DEFERRED]: 2,
      [EV.CREDIT]: 3, [EV.CHARGE]: 4, [EV.RESERVE_RELEASE]: 5, [EV.RESERVE_HOLD]: 5,
      [EV.REQUEST]: 6, [EV.BANK_RECEIPT]: 7,
    };
    const sorted = () => events.slice().sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1
        : (ORDER[a.kind] - ORDER[b.kind]) || (a.seq || 0) - (b.seq || 0));

    /* ── run ──────────────────────────────────────────────────────────── */

    /* Walk every event in order, applying each exactly once, and record the
       running balances. `requests` are planned payout requests, injected as
       REQUEST events at their chosen dates.

       Returns a timeline plus a bridge for each request. Throws Unavailable —
       with the specific missing input — rather than inventing a number. */
    api.run = function (runOpts) {
      runOpts = runOpts || {};
      const plannedRequests = (runOpts.requests || []).slice()
        .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

      if (!opening) throw Unavailable('a current balance snapshot', 'No opening snapshot was set.');
      if (opening.available == null) {
        throw Unavailable('the current available balance for ' + account,
          'The payout bridge starts from opening available funds; that figure has not been supplied.');
      }

      let bal = Balances({
        available: opening.available, deferred: opening.deferred,
        reserve: opening.reserve, inTransit: runOpts.openingInTransit || 0,
      });

      const all = sorted();
      const timeline = [];
      const bridges = [];
      const executed = [];

      /* Bridge accumulators, reset after each request so every request gets its
         own explanation of where its money came from. */
      let acc = newAcc();
      function newAcc() {
        return {
          openingAvailable: bal.available,
          releasesOfOpeningHolds: 0,
          releasesOfNewActivity: 0,
          newAvailableActivity: 0,
          credits: 0,
          charges: 0,
          reserveMovement: 0,
        };
      }

      /* Events bucketed by date, each bucket already in within-day order.
         Bank receipts are discovered as requests execute, so the date list
         grows during the walk — it is therefore held as a set and the next
         unprocessed date is picked each turn, rather than iterating an array
         that is being appended to. */
      const byDate = new Map();
      for (const ev of all) {
        let b = byDate.get(ev.date);
        if (!b) byDate.set(ev.date, b = []);
        b.push(ev);
      }
      const reqByDate = new Map();
      for (const r of plannedRequests) {
        let b = reqByDate.get(r.date);
        if (!b) reqByDate.set(r.date, b = []);
        b.push(r);
      }
      const receiptsByDate = new Map();
      const pending = new Set([...byDate.keys(), ...reqByDate.keys()]);
      const done = new Set();

      for (;;) {
        let date = null;
        for (const d of pending) if (!done.has(d) && (date === null || d < date)) date = d;
        if (date === null) break;
        done.add(date);

        /* 1. everything that happened on this date, before any request reads
              the balance — a release landing on the request date counts. */
        for (const ev of byDate.get(date) || []) {
          bal = apply(bal, ev).balances;
          switch (ev.kind) {
            case EV.RELEASE:
              if (ev.fromOpeningHold) acc.releasesOfOpeningHolds += ev.amount;
              else acc.releasesOfNewActivity += ev.amount;
              break;
            case EV.NEW_AVAILABLE: acc.newAvailableActivity += ev.amount; break;
            case EV.CREDIT: acc.credits += ev.amount; break;
            case EV.CHARGE: acc.charges += ev.amount; break;
            case EV.RESERVE_HOLD: acc.reserveMovement -= ev.amount; break;
            case EV.RESERVE_RELEASE: acc.reserveMovement += ev.amount; break;
            default: break;
          }
          timeline.push({ date, kind: ev.kind, amount: ev.amount, label: ev.label || null, balances: cloneBal(bal) });
        }

        /* 2. bank receipts from earlier requests arriving today. These move
              in-transit cash into the bank; they never change availability. */
        for (const r of receiptsByDate.get(date) || []) {
          bal = apply(bal, { kind: EV.BANK_RECEIPT, date, amount: r.amount }).balances;
          timeline.push({ date, kind: EV.BANK_RECEIPT, amount: r.amount, label: 'Expected bank receipt', balances: cloneBal(bal) });
        }

        /* 3. requests planned for today */
        for (const req of reqByDate.get(date) || []) {
          const outcome = evaluateRequest(req, bal, acc, executed);
          bridges.push(outcome.bridge);
          if (outcome.amount != null && outcome.amount > 0) {
            bal = apply(bal, { kind: EV.REQUEST, date, amount: outcome.amount }).balances;
            executed.push({ date, amount: outcome.amount, planId: req.id || null });
            timeline.push({ date, kind: EV.REQUEST, amount: outcome.amount, label: 'Payout request', balances: cloneBal(bal) });
            const t = bankReceipt(date, outcome.amount);
            if (t.date) {
              let b = receiptsByDate.get(t.date);
              if (!b) receiptsByDate.set(t.date, b = []);
              b.push({ amount: outcome.amount });
              pending.add(t.date);
            }
            outcome.bridge.expectedBankReceipt = t;
          }
          acc = newAcc();
        }
      }

      return {
        account, currency, cutoff,
        opening: Object.assign({}, opening),
        timeline, bridges, executed,
        ending: cloneBal(bal),
        issues: issues.slice(),
        totalRequested: executed.reduce((s, e) => s + e.amount, 0),
      };
    };

    /* What can actually be requested on this date, given the account policy. */
    function evaluateRequest(req, bal, acc, executed) {
      const preRequestAvailable = bal.available;
      const bridge = {
        requestDate: req.date,
        mode: req.mode || 'all_eligible',
        account, currency,
        lines: [
          { label: 'Opening available funds', amount: acc.openingAvailable, kind: 'opening' },
          { label: 'Releases of funds held at the opening snapshot', amount: acc.releasesOfOpeningHolds, kind: 'release' },
          { label: 'Releases of activity posted since the snapshot', amount: acc.releasesOfNewActivity, kind: 'release' },
          { label: 'New activity already available', amount: acc.newAvailableActivity, kind: 'new' },
          { label: 'Separate credits', amount: acc.credits, kind: 'credit' },
          { label: 'Separate charges', amount: -acc.charges, kind: 'charge' },
          { label: 'Reserve movement', amount: acc.reserveMovement, kind: 'reserve' },
        ],
        preRequestAvailable,
        /* Shown for context and explicitly NOT subtracted from the bridge: these
           funds were never added to available in the first place. */
        stillDeferred: bal.deferred,
        deferredNote: 'Funds still deferred are shown for context only. They are not '
          + 'subtracted here — they were never added to available funds.',
        eligible: null,
        requested: null,
        blocked: null,
        warnings: [],
      };

      if (preRequestAvailable < 0) {
        bridge.eligible = 0;
        bridge.requested = 0;
        bridge.shortfall = -preRequestAvailable;
        bridge.blocked = 'Available funds are negative at this cutoff. That is a shortfall of '
          + (bridge.shortfall / 100).toFixed(2) + ', not a negative payout.';
        return { amount: null, bridge };
      }

      bridge.eligible = preRequestAvailable;

      /* Cooldown: only enforced when the account's actual rule is known. An
         unverified cooldown blocks the claim, not the calculation. */
      if (executed.length && policy.cooldownDays != null) {
        const last = executed[executed.length - 1];
        const gap = CSV.daysBetween(last.date, req.date);
        if (gap < policy.cooldownDays) {
          bridge.blocked = 'The account\'s verified cooldown of ' + policy.cooldownDays
            + ' days has not elapsed since the request on ' + last.date + '.';
          bridge.requested = 0;
          return { amount: null, bridge };
        }
      } else if (executed.length) {
        bridge.warnings.push('Whether Amazon permits another request this soon is not verified. '
          + 'Supply the account\'s displayed request restrictions to enforce it.');
      }

      const mode = req.mode || 'all_eligible';
      if (mode === 'all_eligible') {
        bridge.requested = preRequestAvailable;
        return { amount: preRequestAvailable, bridge };
      }

      /* Partial requests are offered only where the account is known to support
         them. A cash target is a planning goal, not evidence of permission. */
      if (mode === 'partial') {
        if (policy.partialRequestsSupported !== true) {
          bridge.blocked = 'Partial requests are not confirmed as supported on this account. '
            + 'A cash target is a planning goal, not proof Amazon permits a partial withdrawal. '
            + 'Supply the account\'s request options to enable this mode.';
          bridge.requested = null;
          bridge.missing = 'confirmation that this account supports partial payout requests';
          return { amount: null, bridge };
        }
        const want = req.amount == null ? preRequestAvailable : req.amount;
        const amount = Math.min(want, preRequestAvailable);
        if (policy.minimumRequest != null && amount < policy.minimumRequest) {
          bridge.blocked = 'Below the account minimum request of ' + (policy.minimumRequest / 100).toFixed(2) + '.';
          bridge.requested = 0;
          return { amount: null, bridge };
        }
        bridge.requested = amount;
        if (want > preRequestAvailable) {
          bridge.warnings.push('Requested ' + (want / 100).toFixed(2) + ' but only '
            + (preRequestAvailable / 100).toFixed(2) + ' is eligible on this date.');
        }
        return { amount, bridge };
      }
      throw new Error('unknown request mode: ' + mode);
    }

    /* Bank arrival. With no matched deposit history this stays unknown — there
       is no "usually two days" default presented as fact. */
    function bankReceipt(requestDate, amount) {
      if (policy.bankTransitDaysLow == null || policy.bankTransitDaysHigh == null) {
        return {
          date: null, low: null, high: null,
          missing: 'matched bank deposit history for ' + account,
          note: 'Bank arrival is unknown. Transfer initiation is not bank receipt, and no '
            + 'default transit time is assumed.',
        };
      }
      return {
        date: CSV.addDays(requestDate, policy.bankTransitDaysLow),
        low: CSV.addDays(requestDate, policy.bankTransitDaysLow),
        high: CSV.addDays(requestDate, policy.bankTransitDaysHigh),
        basis: policy.source || 'supplied bank transit range',
      };
    }
    api.bankReceipt = bankReceipt;

    /* ── target mode ─────────────────────────────────────────────────── */

    /* "What is the earliest date I could request $X?" Walks the same event
       ledger and reports the first date the running available balance reaches
       the target. Returns unavailable when the inputs cannot support a date. */
    api.earliestDateFor = function (target, runOpts) {
      runOpts = runOpts || {};
      if (!opening || opening.available == null) {
        return { date: null, missing: 'the current available balance for ' + account };
      }
      let bal = Balances({
        available: opening.available, deferred: opening.deferred,
        reserve: opening.reserve, inTransit: 0,
      });
      if (bal.available >= target) {
        return { date: runOpts.from || cutoff, amount: bal.available, alreadyMet: true };
      }
      const all = sorted().filter(e => e.kind !== EV.REQUEST && e.kind !== EV.BANK_RECEIPT);
      let lastDate = null;
      for (const ev of all) {
        bal = apply(bal, ev).balances;
        lastDate = ev.date;
        if (bal.available >= target) {
          return { date: ev.date, amount: bal.available, alreadyMet: false };
        }
      }
      return {
        date: null,
        amount: bal.available,
        shortBy: target - bal.available,
        horizonEnd: lastDate,
        missing: null,
        note: 'The modelled activity through ' + (lastDate || 'the end of the horizon')
          + ' does not reach this amount. Extending the answer beyond that date would need '
          + 'forecast inputs that have not been supplied.',
      };
    };

    return api;
  }

  /* ── policy comparison ───────────────────────────────────────────────── */

  /* Run the SAME sales, fees and release assumptions under two different
     withdrawal decisions, and reconcile them at a common endpoint. Any
     difference must be timing, funds still held, or a verified fee — never new
     income. This function asserts that and reports the reconciliation.

     `build(engine)` must add the identical non-request events to each engine. */
  function comparePolicies(opts) {
    const make = () => {
      const e = createEngine({
        account: opts.account, currency: opts.currency,
        cutoff: opts.cutoff, policy: opts.policy,
      });
      e.setOpening(opts.opening);
      opts.build(e);
      return e;
    };

    const runOne = (requests, label) => {
      const engine = make();
      try {
        const r = engine.run({ requests, openingInTransit: opts.openingInTransit || 0 });
        return Object.assign({ label, ok: true }, r);
      } catch (err) {
        if (err.name === 'Unavailable') {
          return { label, ok: false, missing: err.missing, detail: err.detail };
        }
        throw err;
      }
    };

    const early = runOne(opts.earlyRequests || [], opts.earlyLabel || 'Early requests');
    const scheduled = runOne(opts.scheduledRequests || [], opts.scheduledLabel || 'Normal two-week schedule');

    if (!early.ok || !scheduled.ok) {
      return { early, scheduled, reconciliation: null, missing: (early.missing || scheduled.missing) };
    }

    /* At a common endpoint: cash received + cash still in transit + funds still
       at Amazon must agree between the two policies. */
    const endpointOf = r => ({
      received: r.ending.bank,
      inTransit: r.ending.inTransit,
      amazonAvailable: r.ending.available,
      amazonDeferred: r.ending.deferred == null ? 0 : r.ending.deferred,
      amazonReserve: r.ending.reserve == null ? 0 : r.ending.reserve,
      get total() {
        return this.received + this.inTransit + this.amazonAvailable
          + this.amazonDeferred + this.amazonReserve;
      },
    });
    const a = endpointOf(early), b = endpointOf(scheduled);
    const difference = a.total - b.total;

    return {
      early, scheduled,
      reconciliation: {
        endpoint: opts.endpoint || null,
        early: { received: a.received, inTransit: a.inTransit, atAmazon: a.amazonAvailable + a.amazonDeferred + a.amazonReserve, total: a.total },
        scheduled: { received: b.received, inTransit: b.inTransit, atAmazon: b.amazonAvailable + b.amazonDeferred + b.amazonReserve, total: b.total },
        difference,
        balanced: difference === 0,
        note: difference === 0
          ? 'Both policies end with the same total. Requesting earlier changes when cash '
          + 'arrives, not how much there is.'
          : 'The two policies differ by ' + (difference / 100).toFixed(2) + ' at this endpoint. '
          + 'That must be explained by timing, funds still held, or a verified fee — '
          + 'an early request cannot create income.',
      },
    };
  }

  /* Build the comparison schedule for the previous normal cadence. Requires a
     CONFIRMED anchor date: the cadence is never inferred from historical
     transfer spacing, because that spacing reflects the user's own requests. */
  function scheduledPayoutDates(policy, from, to) {
    if (!policy.nextScheduledPayout) {
      return {
        dates: null,
        missing: 'the confirmed next scheduled payout date shown by the account',
        note: 'The two-week comparison needs an anchor date read from Seller Central. '
          + 'Historical transfer gaps cannot supply it — those gaps are early requests.',
      };
    }
    const interval = policy.scheduleIntervalDays || 14;
    const dates = [];
    let d = policy.nextScheduledPayout;
    while (d <= to) {
      if (d >= from) dates.push(d);
      d = CSV.addDays(d, interval);
    }
    return { dates, interval, anchor: policy.nextScheduledPayout, missing: null };
  }

  /* ── the bank, day by day (Cash Plan) ──────────────────────────────────

     What is in the bank, plus Amazon money arriving on the dates it can be
     dated, less commitments on their due dates. The lowest point of that
     line, less the buffer you want to keep, is what is safe to spend.

     Held to the same rules as everything else here:
     - No opening bank cash, no projection. Unavailable, not zero.
     - A commitment due before the opening cash was recorded is not taken
       off again: that cash was counted AFTER it, so it may well be paid
       already. It is listed as not counted, never silently dropped.
     - Amazon money whose bank arrival cannot be dated is not guessed onto a
       date. It is reported as undated, so the figure is visibly
       conservative rather than quietly optimistic.
     - Safe to spend can be negative. That is a shortfall, and it is named as
       one - it is not floored to zero.

     opts: { opening, openingDate, from, to, buffer,
             receipts:    [{ date, amount, label }]  dated Amazon arrivals
             commitments: [{ due, amount, label }]   amounts positive
             undated:     cents of Amazon money with no bank date }        */
  function bankProjection(opts) {
    opts = opts || {};
    if (opts.opening == null) {
      throw Unavailable('your current bank cash',
        'A spendable figure starts from what is in the bank now.');
    }
    const from = opts.from, to = opts.to;
    const since = opts.openingDate || from;
    const rows = [];
    const notCounted = [];
    for (const c of opts.commitments || []) {
      if (!c || !c.due || c.amount == null) continue;
      if (c.due < since) { notCounted.push(Object.assign({}, c, { why: 'due before the bank cash was recorded' })); continue; }
      if (c.due > to) continue;
      rows.push({ date: c.due, label: c.label || 'Commitment', inflow: 0, outflow: c.amount, kind: 'commitment' });
    }
    for (const r of opts.receipts || []) {
      if (!r || !r.date || r.amount == null) continue;
      if (r.date < from || r.date > to) continue;
      rows.push({ date: r.date, label: r.label || 'Amazon payout reaches the bank', inflow: r.amount, outflow: 0, kind: 'receipt' });
    }
    /* Within one day, outflows go FIRST. The order a bank applies same-day
       movements in varies, and assuming the receipt lands before the bill
       would flatter the low point - so the conservative reading is used. */
    rows.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1
      : (a.kind === b.kind ? 0 : a.kind === 'commitment' ? -1 : 1));

    let bal = opts.opening;
    let lowest = { amount: bal, date: since };
    for (const r of rows) {
      bal += r.inflow - r.outflow;
      r.balance = bal;
      if (bal < lowest.amount) lowest = { amount: bal, date: r.date };
    }
    const buffer = opts.buffer == null ? 0 : opts.buffer;
    const safe = lowest.amount - buffer;
    return {
      opening: opts.opening, openingDate: since, from, to,
      rows, notCounted,
      lowest, buffer, bufferSet: opts.buffer != null,
      safeToSpend: safe,
      shortfall: safe < 0 ? -safe : 0,
      ending: bal,
      undated: opts.undated || 0,
    };
  }

  return {
    EV, emptyPolicy, Balances, apply, createEngine, comparePolicies,
    scheduledPayoutDates, bankProjection, Unavailable,
  };
});
