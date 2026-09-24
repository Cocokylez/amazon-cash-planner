/* The interface.
 *
 * One rule governs everything on screen: a figure either comes from a source
 * and says which, or it is Unavailable and says exactly what is missing. There
 * is no third state, and in particular there is no $0 standing in for "we do
 * not know". `amount()` is the only way a number reaches the DOM.
 *
 * The financial engines are not touched from here — this file arranges, labels
 * and explains what they return.
 */
(function () {
  'use strict';

  const M = window.Money, P = window.Prov, CSV = window.CSV, Tax = window.Taxonomy,
    Ledger = window.Ledger, Preview = window.Preview, Cash = window.Cash,
    Forecast = window.Forecast, Profit = window.Profit, Recon = window.Recon,
    Store = window.Store, Icons = window.Icons, Charts = window.Charts,
    Inputs = window.Inputs;

  const $ = (s, r) => (r || document).querySelector(s);
  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ico = (n, o) => Icons.icon(n, o);

  /* ── state ────────────────────────────────────────────────────────────── */

  const state = {
    screen: 'dashboard', tab: null,
    ledger: null,
    previews: [],
    balanceSnapshots: [],
    deferredSnapshots: [],
    policy: Cash.emptyPolicy(),
    requestPlans: [],
    productCosts: [],
    operatingCosts: [],
    cashCommitments: [],
    settlements: [],
    bankDeposits: [],
    advertisingBilling: [],
    forecastRuns: [],
    openingBankCash: null,
    /* The Cash Plan's two settings: the buffer to hold back, and WHEN the
       bank cash was recorded - bills due before that are not taken off it
       again. The buffer field used to exist on screen and never be saved. */
    cashPlan: { buffer: null, bankCashAt: null },
    storage: null,
    imports: [],
    mirror: null,              // the off-machine copy's settings, if any
    mirrorBusy: '',            // 'testing' | 'saving' while one is in flight
    mirrorSaid: null,          // what the last real attempt found
    inputSaid: null,           // { form, ok, text, errors } after a deposit/cost/ads save
    shell: null,               // what the desktop shell says it is, if any
    stateHome: 'local',        // 'helper' once its copy is the one in use
    stateRevision: 0,          // the revision this window last read or wrote
    stateConflict: null,       // another window saved first; both are kept
    stateNote: '',             // what happened to the shared copy, in words
    jobsListedOk: false,       // the helper answered, so an empty list means empty
    confirmJob: null,          // a report awaiting a yes before it is deleted
    jobNote: '',               // what the helper said it removed
    filters: { from: null, to: null, preset: null, account: null, marketplace: null, currency: 'USD' },
    requestDate: null,
    expanded: {},
    confirmRemove: null,
    viewReport: null,
    worker: null,
    workerInfo: null,
    jobs: [],
    jobPoll: null,
    refreshPhase: null,      /* connecting | login | downloading | importing | done */
    refreshNote: null,
    setup: null,
    setupPoll: null,
    workerWatch: null,
    watchGaveUp: false,
    selfTest: null,              /* results of the last run */
    selfTestBusy: false,
    dlTest: null,                /* the real-download test */
    dlTestOpen: false,
    marketplaces: null,          /* null until the helper says what is saved */
    accountType: null,
    skuDateRange: null,
    skuMarketplace: null,
    lastImport: null,
    exportStatus: null,
    exportText: null,
    ask: { open: false, turns: [], busy: false, available: null, checked: false, error: null },
    db: null,
    sync: null,                       /* the Sync instance, once connected */
    syncState: { status: 'connecting', reason: null },
    syncBusy: false,
    /* The date on THIS computer's clock. It was the UTC date, which for
       anyone east of London is still yesterday for the first hours of the
       morning - so "tomorrow" and every forward window were a day behind. */
    today: localToday(),
  };

  /* In the order, and under the groups, of redesign v3: what you can spend,
     then why, then the inputs behind both. The page title IS the nav name, so
     the word you clicked is the word you land on. */
  const SCREENS = [
    { id: 'dashboard', group: 'Cash', name: 'Cash Dashboard', title: 'Cash Dashboard',
      short: 'Cash', icon: 'dashboard',
      blurb: 'What you can request, when it lands, and what is left' },
    { id: 'forecast', group: 'Cash', name: 'Payout Forecast', title: 'Payout Forecast',
      short: 'Forecast', icon: 'forecast',
      blurb: 'Eight weeks of releases, requests and bank arrivals' },
    { id: 'plan', group: 'Cash', name: 'Cash Plan', title: 'Cash Plan', short: 'Plan',
      icon: 'plan',
      blurb: 'What is safe to spend after commitments and your buffer' },
    { id: 'expenses', group: 'Analysis', name: 'Amazon Expenses', title: 'Amazon Expenses',
      short: 'Expenses', icon: 'expenses',
      blurb: 'Every fee Amazon charged, grouped by what it was for' },
    { id: 'profit', group: 'Analysis', name: 'Profitability', title: 'Profitability',
      short: 'Profit', icon: 'profit',
      blurb: 'What you kept after the costs recorded here' },
    { id: 'recon', group: 'Analysis', name: 'Reconciliation', title: 'Reconciliation',
      short: 'Reconcile', icon: 'recon',
      blurb: 'Checks that tie the figures back to Amazon\u2019s files' },
    { id: 'data', group: 'Setup', name: 'Data & Assumptions', title: 'Data & Assumptions',
      short: 'Data', icon: 'data',
      blurb: 'Imports, freshness and the inputs each figure needs' },
  ];
  /* Screens whose figures depend on the reporting period get the Period
     control in their header. The rest read the whole dataset, or dates of
     their own (a request date, a forecast horizon). */
  const RANGED = new Set(['expenses', 'profit', 'recon']);
  const screenById = id => SCREENS.find(s => s.id === id) || SCREENS[0];

  /* ── rendering money with provenance ─────────────────────────────────── */

  /* Where a number came from, in the plainest words that stay accurate, with
     the long version on hover and in the legend below. */
  const TAG = {
    'ACTUAL': ['is-actual', 'Actual',
      'Taken straight from your Amazon transaction export. This already happened.'],
    'CURRENT': ['is-current', 'Current balance',
      'A balance you recorded from Seller Central, at the moment you recorded it.'],
    'AMAZON FORECAST': ['is-forecast', 'Amazon forecast',
      'Amazon\u2019s own estimate, read from the Fees & Economics Preview. Not a guess by this app.'],
    'MODEL FORECAST': ['is-forecast', 'Projected',
      'Worked out by this app from your own history \u2014 for example how long money usually '
      + 'takes to be released. An estimate, not a promise.'],
    'MEASURED': ['is-actual', 'Measured',
      'Measured from your own matched bank deposits \u2014 not assumed.'],
    'ASSUMPTION': ['is-assumed', 'Assumption',
      'A value nobody has confirmed yet. Replace it with a real figure when you have one.'],
    'CALCULATED': ['is-assumed', 'Calculated',
      'Arithmetic on the figures beside it \u2014 no new information was added.'],
  };
  function tag(origin) {
    const t = TAG[origin];
    if (!t) return '';
    const isFc = t[0] === 'is-forecast';
    return '<span class="tag ' + t[0] + '" title="' + esc(t[2]) + '">'
      + ico(isFc ? 'assumptions' : 'verified', { size: 'sm' }) + esc(t[1]) + '</span>';
  }

  /* One legend, reused wherever tagged figures appear, so the vocabulary is
     never something the reader has to infer. */
  function tagLegend(origins) {
    const list = (origins || Object.keys(TAG)).filter(o => TAG[o]);
    if (!list.length) return '';
    return '<details class="legend-d"><summary>' + ico('info', { size: 'sm' })
      + 'What do these labels mean?</summary>'
      + '<dl class="dl" style="margin-top:12px">'
      + list.map(o => '<dt>' + tag(o) + '</dt><dd class="meta" style="text-align:left">'
        + esc(TAG[o][2]) + '</dd>').join('')
      + '</dl></details>';
  }

  /* The only path a number takes to the screen. */
  function amount(v, opts) {
    opts = opts || {};
    let cents = null, missing = null, origin = opts.origin || null;
    if (v == null) missing = opts.missing || 'a required input';
    else if (typeof v === 'number') cents = v;
    else if (typeof v === 'object') {
      cents = v.amount == null ? null : v.amount;
      missing = v.missing || opts.missing;
      origin = origin || v.origin;
      if (cents == null && !missing) missing = 'a required input';
    }
    if (cents == null) return unavailable(missing, opts);
    const cls = 'fig ' + (opts.size || '') + (opts.colour !== false && cents < 0 ? ' neg' : '');
    return '<span class="' + cls.trim() + '">' + esc((state.filters.currency || 'Unknown currency') + ' ' + M.fmt(cents, { plus: opts.plus, bare: true })) + '</span>'
      + (opts.tag && origin ? ' ' + tag(origin) : '');
  }

  function unavailable(missing, opts) {
    opts = opts || {};
    return '<span class="na' + (opts.size === 'sm' ? ' na-sm' : '') + '">'
      + ico('missing', { size: 'sm' })
      + '<span><b>Unavailable</b>' + (missing ? '<span>Needs ' + esc(missing) + '</span>' : '') + '</span>'
      + '</span>';
  }

  const pctText = (num, den) => (num == null || den == null || den === 0)
    ? 'N/A' : M.fmtPct((num / den) * 100, 1);

  /* ── derived state ───────────────────────────────────────────────────── */

  const latestBalance = account => {
    const list = state.balanceSnapshots.filter(b => !account || b.account === account)
      .sort((a, b) => (a.observedAt || '') < (b.observedAt || '') ? -1 : 1);
    return list.length ? list[list.length - 1] : null;
  };
  const latestDeferred = account => {
    const list = state.deferredSnapshots.filter(b => !account || b.account === account)
      .sort((a, b) => (a.observedAt || '') < (b.observedAt || '') ? -1 : 1);
    return list.length ? list[list.length - 1] : null;
  };

  function checklistState() {
    return {
      balanceSnapshots: state.balanceSnapshots, deferredSnapshots: state.deferredSnapshots,
      settlements: state.settlements, bankDeposits: state.bankDeposits,
      productCosts: state.productCosts, operatingCosts: state.operatingCosts,
      advertisingBilling: state.advertisingBilling, cashCommitments: state.cashCommitments,
      policy: enginePolicy(),
      ledgerRange: state.ledger ? state.ledger.dateRange() : null,
      previewCoverageComplete: previewCoverage() ? previewCoverage().complete : false,
    };
  }
  function scopedPreviews() {
    const f = state.filters;
    return state.previews.filter(p => p.currency === f.currency && (!f.marketplace || p.store === f.marketplace));
  }
  /* The forward horizon: from tomorrow, eight full weeks - the same window
     the "Next 8 weeks" period and the fee preview use. Coverage counted from
     TODAY could never be complete, because no forecast covers a day that is
     already half over: it stopped at 55 of 56 however much was fetched. */
  const horizonStart = () => CSV.addDays(state.today, 1);
  const horizonEnd = () => CSV.addDays(state.today, 56);
  function previewCoverage() {
    if (!state.previews.length) return null;
    return Preview.coverage(scopedPreviews(), horizonStart(), horizonEnd());
  }
  const blockedBy = screen => (Store.blockedScreens(checklistState()).get(screen) || []);

  /* ── the reporting range ─────────────────────────────────── */

  /* Deliberately NOT the payout request date: one is the period you are
     reading about, the other is a date you are planning for. */
  const RANGE_PRESETS = [
    { id: 'this-month', label: 'This month', of: t => {
      const m = t.slice(0, 7);
      return { from: m + '-01', to: CSV.addDays(CSV.addDays(m + '-01', 32).slice(0, 7) + '-01', -1) };
    } },
    { id: 'last-month', label: 'Last month', of: t => {
      const first = t.slice(0, 7) + '-01';
      const prev = CSV.addDays(first, -1);
      return { from: prev.slice(0, 7) + '-01', to: prev };
    } },
    { id: 'last-30', label: 'Last 30 days', of: t => ({ from: CSV.addDays(t, -29), to: t }) },
    /* The forward ranges start TOMORROW.

       Today is already part-spent: a forecast that includes it counts a day
       that is half over as a whole one, and the figure is wrong by however
       much of it has already happened. Starting tomorrow gives a clean
       forward window, and it matches what the fee preview is estimating. */
    { id: 'next-14', label: 'Next 14 days',
      of: t => ({ from: CSV.addDays(t, 1), to: CSV.addDays(t, 14) }) },
    { id: 'next-8w', label: 'Next 8 weeks',
      of: t => ({ from: CSV.addDays(t, 1), to: CSV.addDays(t, 56) }) },
  ];

  /* A preset is a rule ("the next eight weeks"), not two dates. Its dates
     were worked out once, when it was chosen, and then saved - so the next
     day it still said yesterday's eight weeks, and the download used them.
     Worked out again whenever the app opens or the date changes. */
  function refreshPresetDates() {
    const p = RANGE_PRESETS.find(x => x.id === state.filters.preset);
    if (!p) return false;
    const r = p.of(state.today);
    if (r.from === state.filters.from && r.to === state.filters.to) return false;
    state.filters.from = r.from; state.filters.to = r.to;
    return true;
  }

  /* Midnight passes while the app is open - it is meant to stay open. */
  function checkDateRollover() {
    const t = localToday();
    if (t === state.today) return;
    state.today = t;
    refreshPresetDates();
    bumpForecast();
    persist();
    render();
  }
  setInterval(checkDateRollover, 60 * 1000);
  window.addEventListener('focus', checkDateRollover);

  function applyPreset(id) {
    state.rangeCustomOpen = false;
    const p = RANGE_PRESETS.find(x => x.id === id);
    if (!p) { state.filters.from = null; state.filters.to = null; state.filters.preset = null; }
    else {
      const r = p.of(state.today);
      state.filters.from = r.from; state.filters.to = r.to; state.filters.preset = id;
    }
    bumpForecast();
    persist();
    render();
  }

  /* The preset periods live in the header's Period menu (v3). What is left
     here is the one thing a menu cannot hold: your own From and To dates.
     Shown only on the screens that read the period, and only when custom
     dates are chosen - it used to be a full card above every screen. */
  function rangeControl() {
    const f = state.filters;
    if (!RANGED.has(state.screen)) return '';
    const custom = !f.preset && (f.from || f.to || state.rangeCustomOpen);
    if (!custom) return '';
    return '<div class="rangebar"><div class="rangebar-in">'
      + '<span class="rangebar-l">' + ico('asOf', { size: 'sm' }) + 'Custom period</span>'
      + '<div class="rangebar-d">'
      + '<label class="lbl" for="g-from">From</label>'
      + '<input type="date" id="g-from" value="' + esc(f.from || '') + '">'
      + '<label class="lbl" for="g-to">To</label>'
      + '<input type="date" id="g-to" value="' + esc(f.to || '') + '">'
      + '</div>'
      + '<button class="chip" data-preset="all">Show all dates</button>'
      + '</div></div>';
  }

  /* Which dates the screen in front of you is actually using. */
  const DATE_BASIS = {
    dashboard: 'Forecast figures use the <b>target period</b> of each imported report. '
      + 'Actual figures use the <b>posted date</b> of each transaction. Balances are a '
      + '<b>snapshot</b> taken at the moment you recorded them.',
    forecast: 'Sales and fees use the <b>target period</b> of each report, with the '
      + 'forecast-as-of date shown on the run. Release and bank dates are separate and are '
      + 'named where they appear.',
    expenses: 'Actual charges use the <b>posted date</b> — Amazon does not supply an economic '
      + 'service period in this export. Forecast fees use the report\u2019s <b>target period</b>.',
    profit: 'Posted date is used as a proxy for the economic period, because the export does '
      + 'not state one. Forecast figures use the report\u2019s <b>target period</b>.',
    plan: 'Expected receipts use <b>release dates</b>; commitments use their <b>due dates</b>. '
      + 'Neither is a bank date.',
    recon: 'Settlements use <b>settlement dates</b>, transfers use <b>transfer dates</b>, and '
      + 'bank receipts use <b>bank receipt dates</b>. They are never merged.',
    data: 'Each imported report states its own covered dates, shown against every file below.',
  };

  function dateBasisNote() {
    const t = DATE_BASIS[state.screen];
    if (!t) return '';
    /* The text is one flex item: left loose, each bold phrase became its own
       column and the sentence read in pieces. */
    return '<div class="meta datebasis">' + ico('info', { size: 'sm' }) + '<span>' + t + '</span></div>';
  }

  /* Something is loaded, but the chosen range excludes all of it. */
  function rangeEmptyCard(ds) {
    const periods = (ds.forecast.availablePeriods || []).slice();
    const led = ds.actual.sourceRange;
    let html = '<section class="card">' + Charts.emptyState(
      'Nothing falls in ' + fmtDay(state.filters.from) + ' – ' + fmtDay(state.filters.to),
      'Your imported reports are intact. They just cover different dates.');
    html += '<div class="tscroll"><table><thead><tr><th>What is loaded</th>'
      + '<th>Dates it covers</th><th class="act"></th></tr></thead><tbody>';
    for (const p of periods) {
      html += '<tr><td class="wrap">' + esc(p.name || 'Fees &amp; Economics Preview') + '</td>'
        + '<td>' + esc(fmtDay(p.from)) + ' – ' + esc(fmtDay(p.to)) + '</td>'
        + '<td class="act"><button class="btn sec sm" data-viewperiod="' + esc(p.from) + '|'
        + esc(p.to) + '">View available period</button></td></tr>';
    }
    if (led && led.from) {
      html += '<tr><td class="wrap">Payments transaction history</td>'
        + '<td>' + esc(fmtDay(led.from)) + ' – ' + esc(fmtDay(led.to)) + '</td>'
        + '<td class="act"><button class="btn sec sm" data-viewperiod="' + esc(led.from) + '|'
        + esc(led.to) + '">View available period</button></td></tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="btnrow" style="margin-top:16px">'
      + '<button class="btn sec" data-preset="all">Show all dates</button>'
      + '<button class="btn" data-go="data">' + ico('upload', { size: 'sm' })
      + 'Import a report for these dates</button></div>';
    html += '</section>';
    return html;
  }

  /* ── the shared dataset ────────────────────────────────────────────────
     Every screen reads this. Before it existed, `state.previews` reached only
     the forecast and three screens read `state.ledger` alone, so an imported
     preview was parsed, stored, listed — and invisible everywhere else. */

  let dsMemo = null, dsKey = null;
  function dataset() {
    const f = state.filters;
    const key = [fcEpoch, state.previews.length, state.ledger ? state.ledger.rowCount : 0,
      f.from, f.to, f.preset, f.account, f.marketplace, f.currency, state.balanceSnapshots.length, state.requestPlans.length,
      state.productCosts.length, state.operatingCosts.length, state.cashCommitments.length,
      state.bankDeposits.length, state.advertisingBilling.length, state.openingBankCash].join('|');
    if (dsMemo && dsKey === key) return dsMemo;
    dsKey = key;
    dsMemo = Dataset.build({
      previews: state.previews,
      ledger: state.ledger,
      filter: { from: f.from, to: f.to, account: f.account, marketplace: f.marketplace, marketplaces: f.marketplace ? [f.marketplace] : null, currency: f.currency },
      inputs: {
        hasBalance: !!latestBalance(f.account || 'Standard Orders'),
        hasPlans: state.requestPlans.length > 0,
        hasBankDeposits: state.bankDeposits.length > 0,
        hasProductCosts: state.productCosts.length > 0,
        hasOperatingCosts: state.operatingCosts.length > 0,
        hasCommitments: state.cashCommitments.length > 0,
        hasOpeningBankCash: state.openingBankCash != null,
        hasAdvertisingBilling: state.advertisingBilling.length > 0,
      },
    });
    return dsMemo;
  }

  /* ── one checklist, not a box per missing figure ───────────────────────
     The dashboard was showing six separate yellow panels that between them
     said one thing. This says it once, compactly, with the detail folded. */
  function readinessPanel(opts) {
    opts = opts || {};
    const list = dataset().readiness;
    const blocked = Dataset.blocking(list);
    const ok = Dataset.ready(list);
    if (!blocked.length) {
      return '<div class="note is-ok">' + ico('verified') + '<div><b>Everything this app can '
        + 'calculate is available.</b></div></div>';
    }

    let html = '<section class="card"><div class="card-h">' + ico('assumptions')
      + '<h2>' + esc(opts.title || 'What is ready, and what is not') + '</h2></div>';

    if (ok.length) {
      html += '<div class="note is-ok" style="margin-top:0">' + ico('verified') + '<div>'
        + '<b>Working now from what you have imported:</b> '
        + ok.map(r => esc(r.label)).join(' · ') + '.</div></div>';
    }

    html += '<div class="checklist">';
    for (const r of blocked) {
      const needs = [...new Set(r.needs.map(n => n.label))];
      html += '<div class="ck"><div class="ck-i">' + ico('missing', { size: 'sm' }) + '</div>'
        + '<div><b>' + esc(r.label) + '</b>'
        + '<div class="meta">Needs ' + esc(needs.join(', and ')) + '.</div></div>'
        + '<div class="ck-a"><button class="btn sec sm" data-go="' + esc(r.needs[0]
          ? r.needs[0].where : 'data') + '">Add this</button></div></div>';
    }
    html += '</div>';

    html += '<details style="margin-top:16px"><summary>' + ico('info', { size: 'sm' })
      + 'Why each of these is needed</summary><dl class="dl" style="margin-top:12px">'
      + '<dt>Current Amazon balances</dt><dd class="wrap" style="text-align:left">'
      + 'A payout figure is a balance projected forward. Without the starting balance there is '
      + 'nothing to project, and a guess would look like a real number.</dd>'
      + '<dt>The Payments transaction CSV</dt><dd class="wrap" style="text-align:left">'
      + 'Holds what actually happened: the fees you were really charged, and how long Amazon '
      + 'took to release each payment. Release timing is measured from it, never assumed.</dd>'
      + '<dt>Bank deposit history</dt><dd class="wrap" style="text-align:left">'
      + 'Requesting a payout is not the same as receiving it. Dating the arrival needs past '
      + 'deposits to measure transit from.</dd>'
      + '<dt>Product costs</dt><dd class="wrap" style="text-align:left">'
      + 'Revenue less Amazon\u2019s fees is not profit until what you paid for the goods is in.</dd>'
      + '<dt>How advertising is billed</dt><dd class="wrap" style="text-align:left">'
      + 'If Amazon deducts it from your settlement it reduces your payout; if it is charged to a '
      + 'card it does not. The two give very different cash answers.</dd>'
      + '</dl></details>';

    html += '</section>';
    return html;
  }

  /* A compact inline version, for screens that need the reason beside a figure
     rather than a whole panel. */
  function needsLine(ids) {
    const list = dataset().readiness.filter(r => ids.indexOf(r.id) >= 0 && !r.ready);
    if (!list.length) return '';
    const needs = [...new Set([].concat.apply([], list.map(r => r.needs.map(n => n.label))))];
    return '<div class="note is-warn">' + ico('missing') + '<div>'
      + '<b>' + esc(list.map(r => r.label).join(' and ')) + ' still needs '
      + esc(needs.join(', and ')) + '.</b> Everything else on this page is from your imported '
      + 'data and is shown in full.'
      + '<div class="btnrow" style="margin-top:12px">'
      + '<button class="btn sec" data-go="' + esc(list[0].needs[0] ? list[0].needs[0].where : 'data')
      + '">Add what is missing</button></div></div></div>';
  }

  /* Forecast figures, rendered identically wherever they appear so the same
     number never looks like two different things on two screens. */
  /* Spec 4: a preview states a WINDOW total. When the reporting range covers
     only part of that window, say so, show Amazon's whole-period figure as
     Amazon's, and give the pro-rata share separately as a model estimate. The
     full-period number is never repeated across days as if it were daily. */
  function partialPeriodNote(f) {
    if (!f || !f.partial || !f.selection) return '';
    const sel = f.selection;
    return '<div class="note is-warn">' + ico('missing') + '<div>'
      + '<b>Your reporting period covers ' + sel.days + ' of the ' + sel.sourceDays
      + ' days these reports describe.</b> Amazon states one total per report period, not a '
      + 'daily breakdown, so the headline figures on this page are for the <b>whole period</b>, '
      + 'not the selected slice.'
      + '<div class="tscroll" style="margin-top:12px"><table><thead><tr><th>Figure</th>'
      + '<th class="n">Whole report period</th><th class="n">Your selected ' + sel.days
      + ' days</th></tr></thead><tbody>'
      + '<tr><td>Net sales</td><td class="n">' + amount(f.netSales) + '</td>'
      + '<td class="n">' + amount(sel.netSales) + '</td></tr>'
      + '<tr><td>Amazon fees</td><td class="n">' + amount(f.feeTotal) + '</td>'
      + '<td class="n">' + amount(sel.feeTotal) + '</td></tr>'
      + '<tr><td>Advertising</td><td class="n">' + amount(f.advertising) + '</td>'
      + '<td class="n">' + amount(sel.advertising) + '</td></tr>'
      + '<tr><td>Storage</td><td class="n">' + amount(f.storage) + '</td>'
      + '<td class="n">' + amount(f.storage) + '</td></tr>'
      + '<tr class="ctx"><td>Where the figure comes from</td><td class="n">'
      + tag('AMAZON FORECAST') + '</td><td class="n">' + tag('MODEL FORECAST') + '</td></tr>'
      + '</tbody></table></div>'
      + '<details style="margin-top:12px"><summary>' + ico('info', { size: 'sm' })
      + 'How the selected-days figure is worked out</summary>'
      + '<p class="meta" style="margin:12px 0">' + esc(sel.method) + '</p>'
      + '<p class="meta" style="margin:12px 0">' + esc(sel.storageNote) + '</p>'
      + '</details></div></div>';
  }

  function forecastSummaryCards(f) {
    let html = '<div class="grid g4">';
    html += statCard('forecast', 'Forecast net sales', f.netSales,
      'a Fees & Economics Preview', 'AMAZON FORECAST');
    html += statText('forecast', 'Forecast units sold',
      f.units.sold == null ? '\u2014' : f.units.sold.toLocaleString(), 'AMAZON FORECAST');
    html += statCard('expenses', 'Forecast Amazon fees',
      f.feeTotal == null ? null : -f.feeTotal, 'fee columns in the export', 'AMAZON FORECAST');
    html += statCard('expenses', 'Forecast advertising',
      f.advertising == null ? null : -f.advertising,
      'advertising columns in the export', 'AMAZON FORECAST');
    html += '</div>';
    return html;
  }

  /* Bank transit measured from deposits matched to Amazon's transfers, in
     the currency on screen. Memoised with the forecast: both change only
     when an input does, and bumpForecast() is called wherever one does. */
  let transitMemo = null, transitKey = null;
  function transitMeasure() {
    const cur = state.filters.currency;
    const deps = state.bankDeposits.filter(d => !d.currency || !cur || d.currency === cur);
    const key = fcEpoch + '|' + cur + '|' + deps.length + '|' + (state.ledger ? state.ledger.rowCount : 0);
    if (key === transitKey && transitMemo) return transitMemo;
    const tr = state.ledger && deps.length ? state.ledger.transfers({ currency: cur }) : [];
    transitMemo = Inputs.measuredTransit(tr, deps);
    transitKey = key;
    return transitMemo;
  }

  /* The account rules the engines see. Where deposits measure the bank
     transit it replaces any typed-in estimate, and says so in its basis;
     otherwise the typed rules stand, labelled as they always were. */
  function enginePolicy() {
    const t = transitMeasure();
    if (!t.available) return state.policy;
    return Object.assign({}, state.policy, {
      bankTransitDaysLow: t.low, bankTransitDaysHigh: t.high,
      source: t.basis, transitMeasured: true,
    });
  }

  function buildEngine(account, opts) {
    opts = opts || {};
    const bal = latestBalance(account);
    const engine = Cash.createEngine({
      account, currency: state.filters.currency,
      cutoff: bal ? (bal.observedAt || '').slice(0, 10) : state.today,
      policy: enginePolicy(),
    });
    engine.setOpening({
      available: bal ? bal.available : null,
      deferred: bal ? bal.deferred : null,
      reserve: bal ? bal.reserve : null,
      asOf: bal ? bal.observedAt : null,
      includesActivityThrough: bal ? (bal.observedAt || '').slice(0, 10) : null,
      source: bal ? bal.source : null,
    });
    const def = latestDeferred(account);
    if (def && def.transactions) {
      for (const t of def.transactions) {
        if (!t.expectedRelease) continue;
        engine.add({ kind: Cash.EV.RELEASE, date: t.expectedRelease, amount: t.amount,
          fromOpeningHold: true, label: 'Held funds released' });
      }
    }
    const fc = currentForecast(account, opts.scenario || 'base');
    /* An economics-only forecast carries the period CHARGES from the preview
       but none of the receipts, because release timing is unmeasured. Applying
       one side of that would walk the balance down past storage and
       advertising while no sales ever arrive — a plausible-looking number
       built from half the evidence. Nothing is applied until both sides can
       be dated. */
    if (fc && !fc.economicsOnly) {
      for (const ev of fc.events) {
        if (ev.account && ev.account !== account) continue;
        engine.add(ev);
      }
    }
    return { engine, forecast: fc, balance: bal, deferred: def };
  }

  /* Building a forecast scans every preview row and re-measures release lags
     over 180k ledger rows. The dashboard alone asks for it five times per
     render (base, plus low/base/high for the planning range, plus the
     comparison), so the result is memoised against the inputs that can change
     it. `bumpForecast()` is called wherever those inputs are edited. */
  const fcMemo = new Map();
  let fcEpoch = 0;
  const bumpForecast = () => { fcEpoch++; fcMemo.clear(); dsMemo = null; dsKey = null; };

  /* A forecast needs previews. It does NOT need the transaction history: the
     preview carries Amazon's own economics, and history only adds the release
     timing and the account split on top. Requiring both meant a user who had
     imported a valid preview saw an empty screen and no explanation. */
  function currentForecast(account, scenario) {
    if (!scopedPreviews().length) return null;
    const key = state.filters.currency + '|' + state.filters.marketplace + '|' + fcEpoch + '|' + account + '|' + (scenario || 'base') + '|' + state.today
      + '|' + state.previews.length + '|' + (state.ledger ? state.ledger.rowCount : 0);
    if (fcMemo.has(key)) return fcMemo.get(key);
    const built = buildForecastUncached(account, scenario);
    fcMemo.set(key, built);
    return built;
  }

  function buildForecastUncached(account, scenario) {
    const from = horizonStart(), to = horizonEnd();
    /* Measure over whatever history exists, not a window baked into the code:
       a hard-coded range silently produced no mix for any other file. */
    let lags = new Map(), mix = null, weights = null;
    if (state.ledger) {
      const range = state.ledger.dateRange();
      const win = Object.assign({}, state.filters, { from: range.from, to: range.to });
      lags = state.ledger.releaseLags(win);
      mix = Forecast.accountMix(state.ledger, win);
      weights = Forecast.weekdayWeights(state.ledger, win);
    }
    return Forecast.build({
      previewFiles: scopedPreviews(), from, to,
      accountMix: mix, releaseLags: lags, weekdayWeights: weights,
      scenario: scenario || 'base', cutoff: from,
      advertisingPaymentMethod: Inputs.adMethodForForecast(state.advertisingBilling, from),
      knownAt: new Date().toISOString(),
    });
  }

  function runFor(account, reqDate) {
    const { engine, forecast, balance } = buildEngine(account);
    const plans = state.requestPlans.filter(p => !p.account || p.account === account)
      .sort((a, b) => a.date < b.date ? -1 : 1);
    const requests = plans.length
      ? plans.map(p => ({ id: p.id, date: p.date, mode: p.mode || 'all_eligible', amount: p.amount }))
      : [{ date: reqDate, mode: 'all_eligible' }];
    try {
      return { run: engine.run({ requests }), forecast, balance, plans, err: null };
    } catch (e) {
      if (e.name === 'Unavailable') return { run: null, forecast, balance, plans, err: e };
      throw e;
    }
  }

  /* ── screens ─────────────────────────────────────────────────────────── */

  const screens = {};

  /* ---------- Cash Dashboard ---------- */
  screens.dashboard = function () {
    const account = state.filters.account || 'Standard Orders';
    const reqDate = state.requestDate || CSV.addDays(state.today, 1);
    const { run, forecast, balance, err } = runFor(account, reqDate);
    const br = run && run.bridges[0];
    const ds = dataset();
    let html = '';

    if (!ds.anyData) {
      html += '<section class="card">' + Charts.emptyState('Nothing imported yet',
        'Drop your Amazon exports on Data & assumptions and this page fills in. '
        + 'The app will say what each file unlocks.')
        + '<div style="text-align:center"><button class="btn" data-go="data">'
        + ico('upload', { size: 'sm' }) + 'Import reports</button></div></section>';
      return html;
    }

    /* v3: this screen answers three questions and nothing else - what can be
       requested, when it lands, what is left. The forecast and the actuals
       that used to open it have their own screens (Payout Forecast, Amazon
       Expenses); the sidebar's Data status says they are there. */

    /* No balance: nothing here can be worked out, so say that, with the form
       that fixes it - and point at what the imports DO already show. */
    if (!balance) {
      html += '<section class="card is-primary">' + Charts.emptyState(
        'Record your Amazon balance to see what you can request',
        'Every figure on this page is your current Amazon balance projected forward. '
        + 'Read it from Seller Central \u2192 Payments, all at the same moment.') + '</section>';
      html += balanceEntryCard(account);
      if (ds.forecast.present || ds.actual.present) {
        html += '<div class="note">' + ico('info') + '<div>Meanwhile, your imports already show '
          + (ds.forecast.present ? 'Amazon\u2019s forecast on <b>Payout Forecast</b>' : '')
          + (ds.forecast.present && ds.actual.present ? ', and ' : '')
          + (ds.actual.present ? 'every fee charged on <b>Amazon Expenses</b>' : '') + '.'
          + '<div class="btnrow" style="margin-top:10px">'
          + (ds.forecast.present ? '<button class="btn sec sm" data-go="forecast">'
            + ico('forecast', { size: 'sm' }) + 'Payout Forecast</button>' : '')
          + (ds.actual.present ? '<button class="btn sec sm" data-go="expenses">'
            + ico('expenses', { size: 'sm' }) + 'Amazon Expenses</button>' : '')
          + '</div></div></div>';
      }
      html += readinessPanel({ title: 'Would sharpen these figures' });
      return html;
    }

    /* Updating the balance: the form opens at the top, where the button was. */
    if (state.balanceFormOpen) html += balanceEntryCard(account, { update: true });

    html += requestToolbar(reqDate, account);

    /* The lead figures describe the date chosen above - with any requests
       already planned BEFORE it taken off first, because those really would
       have drawn the balance down by then. (They used to describe the first
       planned request while the label named the chosen date.) */
    const lead = leadRun(account, reqDate);
    const lbr = lead.br;

    if (!lbr) {
      html += '<div class="note is-warn banner">' + ico('missing') + '<div><b>The request figures '
        + 'cannot be worked out yet.</b> '
        + esc(lead.err && lead.err.message ? lead.err.message
          : 'The balance recorded for this account is incomplete.')
        + '</div><button class="btn warn sm" data-updbal="1">Update balance</button></div>';
    } else {
      html += '<div class="grid g-lead">'
        + leadAvailableCard(lbr, reqDate, account)
        + leadArrivalCard(lbr)
        + leadRemainingCard(lbr, lead.run, reqDate)
        + '</div>';
      if (forecast && forecast.economicsOnly) {
        html += '<div class="note is-warn banner">' + ico('missing') + '<div>'
          + '<b>These figures contain no forecast activity.</b> They walk your recorded balance '
          + 'forward with nothing added and nothing taken away, because release timing has not '
          + 'been measured yet. Applying the forecast\u2019s charges without its receipts would '
          + 'read lower than the truth.</div></div>';
      }
    }

    html += '<div class="grid g-main">'
      + availabilityCard(run, reqDate)
      + recordedBalanceCard(balance)
      + '</div>';

    if (br) html += comparisonCard(account, reqDate);

    if (run) html += bankReceiptsCard(run);

    /* How it is built: explanation, so it folds away by default. */
    if (lbr) html += calculationsCard(lbr);

    html += plannedRequestsCard(account);
    html += readinessPanel({ title: 'Would sharpen these figures' });
    return html;
  };

  /* A run for the date in the toolbar: planned requests before it, then it. */
  function leadRun(account, reqDate) {
    const { engine } = buildEngine(account);
    const earlier = state.requestPlans
      .filter(p => (!p.account || p.account === account) && p.date < reqDate)
      .sort((a, b) => a.date < b.date ? -1 : 1)
      .map(p => ({ id: p.id, date: p.date, mode: p.mode || 'all_eligible', amount: p.amount }));
    try {
      const run = engine.run({ requests: earlier.concat([{ id: 'selected', date: reqDate,
        mode: 'all_eligible' }]) });
      return { run, br: run.bridges[run.bridges.length - 1] || null, err: null };
    } catch (e) {
      if (e.name === 'Unavailable') return { run: null, br: null, err: e };
      throw e;
    }
  }

  /* What could be requested on a date, read off a run's timeline. */
  function availableAt(run, date) {
    let v = run && run.opening ? run.opening.available : null;
    for (const t of (run && run.timeline) || []) {
      if (t.date > date) break;
      v = t.balances.available;
    }
    return v;
  }

  function nextScheduledAfter(date) {
    const sched = Cash.scheduledPayoutDates(state.policy, state.today, CSV.addDays(state.today, 90));
    return sched.dates ? (sched.dates.find(d => d > date) || null) : null;
  }

  const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = d => WEEKDAY[new Date(String(d).slice(0, 10) + 'T12:00:00Z').getUTCDay()];

  /* v3's request-date strip: step a day at a time, or jump to the two dates
     people actually pick. */
  function requestToolbar(reqDate, account) {
    const tomorrow = CSV.addDays(state.today, 1);
    const next = nextScheduledAfter(state.today);
    return '<div class="toolbar">'
      + '<span class="tb-l"><label for="reqdate">Request date</label></span>'
      + '<span class="hctl">'
      + '<button class="chip" data-reqshift="-1" aria-label="One day earlier"'
      + (reqDate <= state.today ? ' disabled' : '') + '>' + ico('chevronRight', { size: 'sm' })
        .replace('<svg', '<svg style="transform:rotate(180deg)"') + '</button>'
      + '<input type="date" id="reqdate" value="' + esc(reqDate) + '" min="' + esc(state.today) + '">'
      + '<button class="chip" data-reqshift="1" aria-label="One day later">'
      + ico('chevronRight', { size: 'sm' }) + '</button>'
      + '<b style="min-width:2.4em">' + esc(weekday(reqDate)) + '</b></span>'
      + '<button class="chip" data-reqdate="' + esc(tomorrow) + '"'
      + (reqDate === tomorrow ? ' aria-pressed="true"' : '') + '>Tomorrow</button>'
      + (next ? '<button class="chip" data-reqdate="' + esc(next) + '"'
        + (reqDate === next ? ' aria-pressed="true"' : '') + '>Next scheduled \u00b7 '
        + esc(fmtShortDay(next)) + '</button>' : '')
      + '<span class="tb-r">All eligible funds \u00b7 ' + esc(account) + '</span>'
      + '</div>';
  }

  /* A figure with its currency code set beside it, smaller, as v3 has it.
     Bare formatting, as amount() uses: stripping a symbol off the formatted
     string instead printed "USD -$1,200.50" for anything negative. */
  function money(cents) {
    if (cents == null) return '';
    const code = state.filters.currency || 'USD';
    return '<span class="cur">' + esc(code) + '</span>'
      + '<span' + (cents < 0 ? ' class="neg"' : '') + '>' + esc(M.fmt(cents, { bare: true }) || '')
      + '</span>';
  }

  function leadAvailableCard(br, reqDate, account) {
    /* The low/high cases are run for this date alone. With a request already
       planned before it they would describe a different situation from the
       figure above them - so in that case they are left out, not shown wrong. */
    const earlier = state.requestPlans.some(p => (!p.account || p.account === account)
      && p.date < reqDate);
    const scen = earlier ? null : scenarioRange(account, reqDate);
    let html = '<section class="card is-primary" aria-labelledby="leadh">'
      + '<div class="card-h"><h2 id="leadh">Available to request</h2>' + tag('MODEL FORECAST') + '</div>'
      + '<div class="hero fig" style="margin-top:14px">' + money(br.eligible) + '</div>'
      + '<div class="meta" style="margin-top:6px">If requested ' + esc(weekday(reqDate)) + ', '
      + esc(fmtShortDay(reqDate)) + (earlier ? ', after your earlier planned requests' : '') + '</div>';
    if (scen) {
      const flat = scen.low === scen.high;
      html += '<div class="meta" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft)" '
        + 'title="Low and high change release timing only. They are not a confidence interval.">'
        + (flat ? 'The same in every release-timing case: this comes from funds already available.'
          : 'Range ' + esc(M.fmt(scen.low, { bare: true })) + ' \u2013 '
            + esc(M.fmt(scen.high, { bare: true }))
            + ' \u00b7 release timing only') + '</div>';
    }
    if (br.blocked) html += '<div class="note is-error">' + ico('missing') + '<div>' + esc(br.blocked) + '</div></div>';
    for (const w of br.warnings || []) {
      html += '<div class="note is-warn">' + ico('missing') + '<div>' + esc(w) + '</div></div>';
    }
    return html + '</section>';
  }

  function leadArrivalCard(br) {
    const r = br.expectedBankReceipt;
    const t = transitMeasure();
    const measured = t.available;
    let html = '<section class="card"><div class="card-h"><h2>Expected bank arrival</h2>'
      + (r && r.low ? tag(measured ? 'MEASURED' : 'ASSUMPTION') : '') + '</div>';
    if (r && r.low) {
      const pol = enginePolicy();
      const lo = pol.bankTransitDaysLow, hi = pol.bankTransitDaysHigh;
      html += '<div class="bigdate" style="margin-top:14px">' + esc(weekday(r.low)) + ', '
        + esc(fmtShortDay(r.low))
        + (r.high && r.high !== r.low ? ' \u2013 ' + esc(fmtShortDay(r.high)) : '') + '</div>'
        + '<div class="meta" style="margin-top:6px">' + esc(lo === hi ? lo + ' days' : lo + '\u2013' + hi + ' days')
        + ' in transit</div>'
        + '<div class="meta" style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line-soft)">'
        + (measured ? 'Measured from ' + t.n + ' deposit' + (t.n === 1 ? '' : 's')
          + ' matched to Amazon transfers'
          : 'Transit days entered by hand' + (state.bankDeposits.length
            ? ' - measuring needs ' + t.missing + '.'
            : '. Add bank deposits to measure them.')) + '</div>';
    } else {
      html += '<div style="margin-top:14px">' + unavailable((r && r.missing) || 'matched bank deposit history')
        + '</div><div class="meta" style="margin-top:10px">Requesting is not receiving. No default '
        + 'transit time is assumed.</div>';
      html += '<div class="btnrow" style="margin-top:12px"><button class="btn sec sm" data-go="data" '
        + 'data-then="depositsform">Add bank deposits</button></div>';
    }
    return html + '</section>';
  }

  function leadRemainingCard(br, run, reqDate) {
    const after = (br.preRequestAvailable || 0) - (br.requested || 0);
    const next = nextScheduledAfter(reqDate);
    let html = '<section class="card"><div class="card-h"><h2>Remaining after the request</h2>'
      + tag('MODEL FORECAST') + '</div><dl class="dl" style="margin-top:8px">'
      + '<dt>Available right after</dt><dd>' + amount(after) + '</dd>'
      + '<dt>Still deferred</dt><dd>' + amount(br.stillDeferred, { missing: 'a current deferred balance' })
      + '</dd></dl>';
    if (next && run) {
      html += '<div style="display:flex;align-items:baseline;gap:10px;margin-top:10px;padding-top:10px;'
        + 'border-top:1px solid var(--line-soft)"><b style="white-space:nowrap">Released by '
        + esc(fmtShortDay(next)) + '</b>'
        + '<span class="stat-v fig" style="margin-left:auto;white-space:nowrap">'
        + money(availableAt(run, next)) + '</span></div><div class="meta">Available for the next scheduled payout</div>';
    } else if (run) {
      html += '<div style="display:flex;align-items:baseline;gap:10px;margin-top:10px;padding-top:10px;'
        + 'border-top:1px solid var(--line-soft)"><b>Left for the next payout</b>'
        + '<span class="stat-v fig" style="margin-left:auto;white-space:nowrap">'
        + money(run.ending.available) + '</span></div><div class="meta">The next scheduled date is not confirmed yet, so this is '
        + 'the end of the forecast.</div>';
    }
    return html + '</section>';
  }

  /* The day-by-day line (v3). Every event of the run, not a sample. */
  function availabilityCard(run, reqDate, wide) {
    let html = '<section class="card"><div class="card-h"><h2>Available to request over time</h2></div>';
    if (!run) {
      return html + Charts.availability([]) + '</section>';
    }
    const pts = [{ date: String(run.opening.asOf || state.today).slice(0, 10),
      available: run.opening.available, label: 'Recorded balance' }];
    const LABEL = { release: 'Funds released', new_available: 'New sales available',
      credit: 'Credit', charge: 'Charge', request: 'Payout request', bank_receipt: 'Reaches the bank',
      reserve_hold: 'Reserve held', reserve_release: 'Reserve released' };
    for (const t of run.timeline) {
      if (t.kind === Cash.EV.BANK_RECEIPT) continue;   // moves bank cash, never availability
      pts.push({ date: t.date, available: t.balances.available,
        label: t.label || LABEL[t.kind] || t.kind });
    }
    const first = pts[0].date, lastD = pts[pts.length - 1].date;
    const cov = previewCoverage();
    const gaps = cov ? cov.gaps.filter(g => g.to >= first && g.from <= lastD) : [];
    const planned = state.requestPlans.length;
    html += '<div class="meta">' + esc(fmtShortDay(first)) + ' \u2013 ' + esc(fmtShortDay(lastD))
      + ' \u00b7 daily balance, ' + esc(state.filters.currency || 'USD')
      + (planned ? ' \u00b7 with your ' + planned + ' planned request' + (planned === 1 ? '' : 's') : '')
      + '</div>'
      + '<div class="sub" style="margin-top:6px">The line is the Amazon balance you could request on '
      + 'each day. It rises as funds are released and drops to zero at each planned request, so an '
      + 'earlier request leaves less for the next one.</div>'
      + Charts.availability(pts, { today: state.today, selected: reqDate, gaps, wide: !!wide,
        currency: state.filters.currency || 'USD',
        requests: run.executed.map(e => ({ date: e.date, amount: e.amount })) })
      + '</section>';
    return html;
  }

  /* The balance every figure stands on, and how old it is. */
  function recordedBalanceCard(balance) {
    const day = String(balance.observedAt || '').slice(0, 10);
    const fresh = day === state.today;
    return '<section class="card"><div class="card-h"><h2>Recorded balance</h2>'
      + '<span class="tag ' + (fresh ? 'is-ok' : 'is-warn') + '">'
      + (fresh ? 'Current \u00b7 today' : 'From ' + esc(fmtShortDay(day))) + '</span></div>'
      + '<div class="hero fig" style="font-size:30px;margin-top:10px">' + money(balance.available) + '</div>'
      + '<div class="meta">Available at Amazon</div>'
      + '<dl class="dl" style="margin-top:12px">'
      + '<dt>Deferred</dt><dd>' + amount(balance.deferred, { missing: 'a deferred balance' }) + '</dd>'
      + '<dt>Reserve</dt><dd>' + amount(balance.reserve, { missing: 'a reserve balance' }) + '</dd>'
      + '<dt>In transit</dt><dd>' + amount(balance.inTransit != null ? balance.inTransit : null,
        { missing: 'transfers already initiated' }) + '</dd></dl>'
      + '<div class="meta" style="margin-top:10px">Observed ' + esc(fmtDay(day))
      + ' \u00b7 ' + esc(balance.source || 'entered by hand') + '</div>'
      + '<div class="btnrow" style="margin-top:14px"><button class="btn sec sm" data-updbal="1">'
      + 'Update balance</button></div></section>';
  }

  function bankReceiptsCard(run) {
    const weeks = bankWeeks(run);
    let html = '<section class="card"><div class="card-h"><h2>Expected bank receipts</h2></div>'
      + '<div class="sub">Eight weeks of money reaching your bank, grouped by the week it lands.</div>'
      + Charts.bankReceipts(weeks);
    if (weeks.some(w => w.amount != null)) {
      html += '<details class="plain"><summary>' + ico('chevronRight', { size: 'sm' })
        + 'Show as table</summary><div class="tscroll"><table><thead><tr><th>Week</th>'
        + '<th class="n">Expected</th><th class="wrap">Basis</th></tr></thead><tbody>';
      for (const w of weeks) {
        html += '<tr><td>' + esc(w.label) + '</td><td class="n">'
          + (w.amount != null ? esc(M.fmt(w.amount)) : '\u2014') + '</td><td class="wrap">'
          + esc(w.amount != null ? (w.forecast ? 'Forecast' : 'Actual') : (w.note || 'Nothing dated'))
          + '</td></tr>';
      }
      html += '</tbody></table></div></details>';
    }
    return html + '</section>';
  }

  /* v3's "Calculations and assumptions": the whole working, folded away. The
     tag says whether the steps add back up to the figure they explain. */
  function calculationsCard(br) {
    const steps = waterfallSteps(br);
    const sum = (br.lines || []).reduce((s, l) => s + (l.amount || 0), 0);
    const ties = br.preRequestAvailable != null && Math.abs(sum - br.preRequestAvailable) < 1;
    return '<details class="card"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'Calculations and assumptions'
      + '<span class="tag ' + (ties ? 'is-ok' : 'is-warn') + '" style="margin-left:auto">'
      + (ties ? 'Reconciles: ' + esc(M.fmt(br.preRequestAvailable, { bare: true }))
        : 'Does not reconcile')
      + '</span></summary><div class="body">'
      + '<p class="meta" style="margin:0 0 12px">Every step below is a movement in the event ledger, '
      + 'not a separate estimate.</p>'
      + Charts.waterfall(steps) + bridgeList(br)
      + tagLegend(['CURRENT', 'ACTUAL', 'AMAZON FORECAST', 'MODEL FORECAST', 'MEASURED', 'CALCULATED'])
      + '</div></details>';
  }

  function plannedRequestsCard(account) {
    return '<section class="card"><div class="card-h"><h2>Planned requests</h2></div>'
      + plannedRequestsBlock(account) + '</section>';
  }

  /* A stat card whose value is a count or a label rather than money. */
  function statText(icon, label, text, origin, meta) {
    return '<div class="tile">'
      + '<div class="tile-l">' + esc(label) + '</div>'
      + '<div class="tile-v fig">' + esc(text) + '</div>'
      + (origin || meta ? '<div class="tile-m">' + (origin ? tag(origin) : '')
        + (meta ? '<span' + (origin ? ' style="margin-left:8px"' : '') + '>' + esc(meta) + '</span>' : '')
        + '</div>' : '')
      + '</div>';
  }

  /* ── "your data is loaded, the view is just looking elsewhere" ─────────
     An imported file whose period sits outside what the screen is showing
     looked exactly like a failed import. Both notices below name the period
     that was imported and offer one click to go and look at it. */

  /* Forecast screen: the preview window falls outside the 56-day horizon. */
  function outOfHorizonNotice(fc) {
    if (!state.previews.length) return '';
    const outside = state.previews.filter(p => p.period.start && p.period.end
      && (p.period.end < fc.horizon.from || p.period.start > fc.horizon.to));
    if (!outside.length || outside.length !== state.previews.length) return '';
    const p = outside[0];
    return '<div class="note is-warn">' + ico('missing') + '<div>'
      + '<b>Your imported preview covers ' + esc(fmtDay(p.period.start)) + ' to '
      + esc(fmtDay(p.period.end)) + ', which is outside the ' + esc(fmtDay(fc.horizon.from))
      + ' – ' + esc(fmtDay(fc.horizon.to)) + ' window this screen forecasts.</b> '
      + 'The data is imported and intact — nothing was lost. The forecast horizon runs eight '
      + 'weeks from today, so a window further out shows no activity here.'
      + '<div class="btnrow" style="margin-top:12px">'
      + '<button class="btn" data-viewperiod="' + esc(p.period.start) + '|' + esc(p.period.end)
      + '" data-viewscreen="data">' + ico('forecast', { size: 'sm' })
      + 'View imported period</button></div></div></div>';
  }

  /* Ledger screens: the active from/to filter excludes every imported row. */
  function filterHidesDataNotice() {
    if (!state.ledger) return '';
    const range = state.ledger.dateRange();
    if (!range.from || !range.to) return '';
    const f = state.filters;
    if (!f.from && !f.to) return '';
    const from = f.from || range.from, to = f.to || range.to;
    if (!(to < range.from || from > range.to)) return '';
    return '<div class="note is-warn">' + ico('missing') + '<div>'
      + '<b>The date filter is hiding every imported row.</b> Your transaction history covers '
      + esc(fmtDay(range.from)) + ' to ' + esc(fmtDay(range.to)) + ', but this screen is filtered '
      + 'to ' + esc(fmtDay(from)) + ' – ' + esc(fmtDay(to)) + '. The records are stored and intact.'
      + '<div class="btnrow" style="margin-top:12px">'
      + '<button class="btn" data-viewperiod="' + esc(range.from) + '|' + esc(range.to) + '">'
      + ico('forecast', { size: 'sm' }) + 'View imported period</button></div></div></div>';
  }

  /* v3's stat tile: what it is, the figure, and where the figure came from.
     The icon argument is kept for callers but no longer drawn - v3's tiles
     lead with the word, and the provenance tag does the categorising. */
  function statCard(icon, label, cents, missing, origin, meta) {
    return '<div class="tile">'
      + '<div class="tile-l">' + esc(label) + '</div>'
      + (cents == null ? '<div style="margin-top:6px">' + unavailable(missing, { size: 'sm' }) + '</div>'
        : '<div class="tile-v fig">' + money(cents) + '</div>'
        + (origin || meta ? '<div class="tile-m">' + (origin ? tag(origin) : '')
          + (meta ? '<span' + (origin ? ' style="margin-left:8px"' : '') + '>' + esc(meta) + '</span>' : '')
          + '</div>' : ''))
      + '</div>';
  }

  function scenarioBlock(scen) {
    const flat = scen.low === scen.base && scen.base === scen.high;
    if (flat) {
      return '<div class="note">' + ico('info')
        + '<div>Low, base and high all give the same figure: on this date the money comes from '
        + 'funds already available, so changing release timing cannot move it. Pick a later date '
        + 'to see the cases separate.</div></div>';
    }
    return '<div class="note">' + ico('assumptions') + '<div>'
      + '<b>Planning range</b> — low ' + esc(M.fmt(scen.low)) + ' · base ' + esc(M.fmt(scen.base))
      + ' · high ' + esc(M.fmt(scen.high))
      + '<br>These change release timing only, and are <b>not</b> a confidence interval — '
      + 'they are not calibrated against saved forecasts.</div></div>';
  }

  function scenarioRange(account, reqDate) {
    const out = {};
    for (const s of ['low', 'base', 'high']) {
      try {
        const { engine } = buildEngine(account, { scenario: s });
        out[s] = engine.run({ requests: [{ date: reqDate, mode: 'all_eligible' }] }).bridges[0].eligible;
      } catch (e) { return null; }
    }
    return out;
  }

  /* Weeks for the receipts chart, built only from real modelled receipts. */
  function bankWeeks(run) {
    const weeks = [];
    let d = state.today;
    const end = horizonEnd();
    while (d <= end) {
      const wd = CSV.weekdayOf(d);
      const start = CSV.addDays(d, -((wd + 6) % 7));
      if (!weeks.length || weeks[weeks.length - 1].from !== start) {
        weeks.push({ from: start, to: CSV.addDays(start, 6), amount: null, forecast: true,
          label: fmtDay(start) + ' – ' + fmtDay(CSV.addDays(start, 6)),
          short: fmtShortDay(start), note: 'no dated receipt' });
      }
      d = CSV.addDays(d, 1);
    }
    if (!run) return weeks;
    for (const t of run.timeline) {
      if (t.kind !== Cash.EV.BANK_RECEIPT) continue;
      const w = weeks.find(x => t.date >= x.from && t.date <= x.to);
      if (w) w.amount = (w.amount || 0) + t.amount;
    }
    return weeks;
  }

  function waterfallSteps(br) {
    if (!br) return [];
    const steps = [{ label: 'Opening available funds', short: 'Opening',
      amount: br.lines[0].amount, kind: 'start' }];
    const map = [
      ['Releases of opening holds', 'Holds', 1],
      ['Releases since the snapshot', 'Released', 2],
      ['New available activity', 'New', 3],
      ['Separate credits', 'Credits', 4],
      ['Separate charges', 'Charges', 5],
      ['Reserve movement', 'Reserve', 6],
    ];
    for (const [label, short, i] of map) {
      const v = br.lines[i] && br.lines[i].amount;
      if (!v) continue;
      steps.push({ label, short, amount: v, kind: v >= 0 ? 'add' : 'sub' });
    }
    steps.push({ label: 'Eligible to request', short: 'Eligible', amount: br.eligible, kind: 'total' });
    return steps;
  }

  function bridgeList(br) {
    let html = '<ul class="bridge" style="margin-top:20px">';
    for (const l of br.lines) {
      if (l.amount === 0 && l.kind !== 'opening') continue;
      html += '<li><span class="l">' + esc(l.label) + '</span><span class="v">'
        + amount(l.amount, { plus: l.kind !== 'opening' }) + '</span></li>';
    }
    html += '<li class="total"><span class="l">Eligible to request</span><span class="v">'
      + amount(br.eligible) + '</span></li>';
    html += '<li class="ctx"><span class="l">Funds still deferred</span><span class="v">'
      + amount(br.stillDeferred, { missing: 'a current deferred balance' }) + '</span></li>';
    html += '</ul>';
    html += '<div class="note">' + ico('info') + '<div>' + esc(br.deferredNote) + '</div></div>';
    return html;
  }

  function accountOptions(current) {
    const accounts = state.ledger
      ? [...state.ledger.distinct('accountType').keys()].filter(Boolean)
      : ['Standard Orders', 'Invoiced Orders'];
    return accounts.map(a => '<option value="' + esc(a) + '"'
      + (a === current ? ' selected' : '') + '>' + esc(a) + '</option>').join('');
  }

  function comparisonCard(account, reqDate) {
    const nextS = nextScheduledAfter(state.today);
    let html = '<section class="card" id="comparecard"><div class="card-h">'
      + '<h2>Request on ' + esc(weekday(reqDate)) + ', ' + esc(fmtShortDay(reqDate))
      + ', or wait for the scheduled payout</h2>'
      + (nextS ? '<span class="meta" style="margin-left:0">Compared through '
        + esc(fmtDay(horizonEnd())) + '</span>' : '') + '</div>'
      + '<div class="sub">Same sales, fees and release timing in both columns. Only the request '
      + 'date changes, so the total paid out by the scheduled payout is identical. Earlier payouts '
      + 'change when cash arrives, not profit.</div>';

    const sched = Cash.scheduledPayoutDates(state.policy, state.today, horizonEnd());
    if (!sched.dates) {
      html += Charts.policyCompare([]);
      html += '<div class="note is-warn">' + ico('missing') + '<div><b>Needs '
        + esc(sched.missing) + '.</b><br>' + esc(sched.note) + '</div></div>';
      html += '<div class="frow f2" style="max-width:520px">'
        + '<div class="field"><label class="lbl" for="anchordate">Confirmed next scheduled payout</label>'
        + '<input type="date" id="anchordate"></div>'
        + '<div class="field"><label class="lbl">&nbsp;</label>'
        + '<button class="btn" id="saveanchor">Save anchor date</button></div></div>';
      return html + '</section>';
    }

    const bal = latestBalance(account);
    if (!bal) {
      html += Charts.policyCompare([]);
      html += '<div class="note is-warn">' + ico('missing')
        + '<div>Needs a current available balance for ' + esc(account) + '.</div></div>';
      return html + '</section>';
    }

    const fc = currentForecast(account, 'base');
    const cmp = Cash.comparePolicies({
      account, currency: state.filters.currency, cutoff: (bal.observedAt || '').slice(0, 10),
      opening: { available: bal.available, deferred: bal.deferred, reserve: bal.reserve,
        asOf: bal.observedAt, includesActivityThrough: (bal.observedAt || '').slice(0, 10) },
      policy: enginePolicy(),
      build: e => {
        const def = latestDeferred(account);
        if (def && def.transactions) for (const t of def.transactions) {
          if (t.expectedRelease) {
            e.add({ kind: Cash.EV.RELEASE, date: t.expectedRelease, amount: t.amount, fromOpeningHold: true });
          }
        }
        if (fc) for (const ev of fc.events) {
          if (ev.account && ev.account !== account) continue;
          e.add(ev);
        }
      },
      earlyRequests: (state.requestPlans.length
        ? state.requestPlans.map(p => ({ date: p.date, mode: p.mode || 'all_eligible', amount: p.amount }))
        : [{ date: reqDate, mode: 'all_eligible' }]),
      scheduledRequests: sched.dates.map(d => ({ date: d, mode: 'all_eligible' })),
      endpoint: horizonEnd(),
    });

    if (!cmp.early.ok || !cmp.scheduled.ok) {
      html += Charts.policyCompare([]);
      html += '<div class="note is-warn">' + ico('missing') + '<div>Needs '
        + esc(cmp.missing || 'a current balance') + '.</div></div>';
      return html + '</section>';
    }
    const r = cmp.reconciliation;
    html += Charts.policyCompare([
      { label: 'Cash received in the bank', short: 'In bank', early: r.early.received, scheduled: r.scheduled.received },
      { label: 'Still in transit', short: 'In transit', early: r.early.inTransit, scheduled: r.scheduled.inTransit },
      { label: 'Still at Amazon', short: 'At Amazon', early: r.early.atAmazon, scheduled: r.scheduled.atAmazon },
    ]);
    html += '<div class="tscroll" style="margin-top:20px"><table><thead><tr>'
      + '<th>At ' + esc(fmtDay(horizonEnd())) + '</th>'
      + '<th class="n">Request early</th><th class="n">Wait for the schedule</th>'
      + '<th class="n">Difference</th></tr></thead><tbody>';
    const row = (label, a, b) => '<tr><td>' + esc(label) + '</td><td class="n">'
      + amount(a) + '</td><td class="n">' + amount(b)
      + '</td><td class="n">' + amount(a - b, { plus: true }) + '</td></tr>';
    html += row('Cash received in the bank', r.early.received, r.scheduled.received);
    html += row('Still in transit', r.early.inTransit, r.scheduled.inTransit);
    html += row('Still at Amazon', r.early.atAmazon, r.scheduled.atAmazon);
    html += '<tr class="sum"><td>Total</td><td class="n">' + amount(r.early.total)
      + '</td><td class="n">' + amount(r.scheduled.total)
      + '</td><td class="n">' + amount(r.difference, { plus: true }) + '</td></tr>';
    html += '</tbody></table></div>';
    html += '<div class="note ' + (r.balanced ? 'is-ok' : 'is-warn') + '">'
      + ico(r.balanced ? 'verified' : 'missing') + '<div>' + esc(r.note) + '</div></div>';
    html += '<div class="meta">Early plan: ' + cmp.early.executed.length + ' request'
      + (cmp.early.executed.length === 1 ? '' : 's') + '. Scheduled plan: '
      + cmp.scheduled.executed.length + ' payout' + (cmp.scheduled.executed.length === 1 ? '' : 's')
      + ' from the confirmed anchor ' + esc(fmtDay(sched.anchor)) + ', every ' + sched.interval
      + ' days.</div>';
    return html + '</section>';
  }

  function plannedRequestsBlock(account) {
    let html = '<div class="sub">Each request takes what is eligible on its date and leaves the rest. '
      + 'Adding one earlier does not add money — it moves it forward.</div>';
    const plans = state.requestPlans.filter(p => !p.account || p.account === account)
      .sort((a, b) => a.date < b.date ? -1 : 1);

    if (!plans.length) {
      html += '<div class="note">' + ico('info') + '<div>No requests planned. The figures above '
        + 'use the single date chosen at the top.</div></div>';
    } else {
      let run = null;
      try {
        const { engine } = buildEngine(account);
        run = engine.run({ requests: plans.map(p => ({ id: p.id, date: p.date,
          mode: p.mode || 'all_eligible', amount: p.amount })) });
      } catch (e) { if (e.name !== 'Unavailable') throw e; }
      html += '<div class="tscroll"><table><thead><tr><th>Request date</th><th>Mode</th>'
        + '<th class="n">Eligible</th><th class="n">Requested</th><th class="n">Left after</th>'
        + '<th class="act"></th></tr></thead><tbody>';
      plans.forEach((p, i) => {
        const br = run && run.bridges[i];
        html += '<tr><td>' + esc(fmtDay(p.date)) + '</td>'
          + '<td>' + esc(p.mode === 'partial' ? 'Set amount' : 'All eligible') + '</td>'
          + '<td class="n">' + (br ? amount(br.eligible) : unavailable('a current balance', { size: 'sm' })) + '</td>'
          + '<td class="n">' + (br ? amount(br.requested, { missing: br.missing }) : '—') + '</td>'
          + '<td class="n">' + (br ? amount((br.eligible || 0) - (br.requested || 0)) : '—') + '</td>'
          + '<td class="act"><button class="btn sec sm" data-delplan="' + esc(p.id) + '" '
          + 'aria-label="Remove the request planned for ' + esc(fmtDay(p.date)) + '">'
          + ico('remove', { size: 'sm' }) + 'Remove</button></td></tr>';
      });
      if (run) {
        html += '<tr class="sum"><td>Across the plan</td><td></td><td class="n"></td>'
          + '<td class="n">' + amount(run.totalRequested) + '</td>'
          + '<td class="n">' + amount(run.ending.available) + '</td><td class="act"></td></tr>';
      }
      html += '</tbody></table></div>';
      html += '<div class="note is-ok">' + ico('verified')
        + '<div><b>These are plans, not transfers.</b> Nothing has been requested from Amazon and '
        + 'no money has moved. This app records and models requests; it never submits them.</div></div>';
    }

    html += '<div class="frow f3" style="margin-top:16px">'
      + '<div class="field"><label class="lbl" for="np-date">Add a request date</label>'
      + '<input type="date" id="np-date" min="' + esc(state.today) + '"></div>'
      + '<div class="field"><label class="lbl" for="np-mode">Mode</label>'
      + '<select id="np-mode"><option value="all_eligible">All eligible funds</option>'
      + '<option value="partial">A set amount</option></select></div>'
      + '<div class="field"><label class="lbl" for="np-amount">Amount, if a set amount</label>'
      + '<input type="number" step="0.01" id="np-amount" placeholder="Only if supported"></div>'
      + '</div><button class="btn" id="addplan">Add to the plan</button>';
    return html;
  }

  /* Snapshots are compared, never summed, and the newest is the one every
     payout figure is built on — so which one that is has to be visible, and
     a wrong entry has to be removable. */
  function recordedBalancesCard() {
    const list = state.balanceSnapshots.slice()
      .sort((a, b) => (a.observedAt || '') < (b.observedAt || '') ? 1 : -1);
    if (!list.length) return '';
    const inForce = new Set();
    for (const acct of new Set(list.map(b => b.account))) {
      const latest = latestBalance(acct);
      if (latest) inForce.add(latest);
    }

    let html = '<section class="card"><div class="card-h">' + ico('available')
      + '<h2>Recorded balances</h2></div>'
      + '<div class="sub">Each row is what you saw in Seller Central at one moment. They are '
      + 'compared, never added together — the most recent one for each account stream is the '
      + 'one your payout figures use.</div>'
      + '<div class="tscroll"><table><thead><tr><th>Observed</th><th>Account stream</th>'
      + '<th class="n">Available</th><th class="n">Deferred</th><th class="n">Reserve</th>'
      + '<th>Source</th><th class="act"></th></tr></thead><tbody>';
    for (const b of list) {
      html += '<tr><td>' + esc(fmtDay(b.observedAt))
        + (inForce.has(b) ? ' <span class="tag is-current" title="Every payout figure for this '
          + 'account stream is built on this row.">' + ico('verified', { size: 'sm' })
          + 'In use</span>' : '') + '</td>'
        + '<td>' + esc(b.account || '\u2014') + '</td>'
        + '<td class="n">' + amount(b.available == null ? null : b.available,
          { missing: 'an available balance' }) + '</td>'
        + '<td class="n">' + amount(b.deferred == null ? null : b.deferred,
          { missing: 'a deferred balance' }) + '</td>'
        + '<td class="n">' + amount(b.reserve == null ? null : b.reserve,
          { missing: 'a reserve balance' }) + '</td>'
        + '<td class="wrap">' + esc(b.source || '\u2014') + '</td>'
        + '<td class="act"><button class="btn sec sm" data-delbal="' + esc(balId(b)) + '" '
        + 'aria-label="Remove the balance recorded on ' + esc(fmtDay(b.observedAt)) + '">'
        + ico('remove', { size: 'sm' }) + 'Remove</button></td></tr>';
    }
    html += '</tbody></table></div></section>';
    return html;
  }

  /* Snapshots saved before ids existed are matched on their contents. */
  const balId = b => b.id || [b.account, b.observedAt, b.available, b.deferred, b.reserve].join('|');

  function balanceEntryCard(account, opts) {
    opts = opts || {};
    return '<section class="card' + (opts.update ? ' is-primary' : '') + '" id="balanceform">'
      + '<div class="card-h">' + ico('available')
      + '<h2>' + (opts.update ? 'Update your Amazon balances' : 'Record your current Amazon balances')
      + '</h2></div>'
      + '<div class="sub">The one input that unblocks every payout figure. Read them from '
      + 'Seller Central → Payments, all at the same moment.</div>'
      + '<div class="frow f3">'
      + '<div class="field"><label class="lbl" for="b-available">Available</label>'
      + '<input type="number" step="0.01" id="b-available" placeholder="0.00"></div>'
      + '<div class="field"><label class="lbl" for="b-deferred">Deferred / held</label>'
      + '<input type="number" step="0.01" id="b-deferred" placeholder="0.00"></div>'
      + '<div class="field"><label class="lbl" for="b-reserve">Reserve</label>'
      + '<input type="number" step="0.01" id="b-reserve" placeholder="0.00"></div></div>'
      + '<div class="frow f3">'
      + '<div class="field"><label class="lbl" for="b-transit">Transfers already initiated</label>'
      + '<input type="number" step="0.01" id="b-transit" placeholder="0.00"></div>'
      + '<div class="field"><label class="lbl" for="b-asof">Observed at</label>'
      + '<input type="date" id="b-asof" value="' + esc(state.today) + '"></div>'
      + '<div class="field"><label class="lbl" for="b-acct">Account stream</label>'
      + '<select id="b-acct">' + accountOptions(account) + '</select></div></div>'
      + '<div class="note">' + ico('info') + '<div>Each save is a point-in-time snapshot. Snapshots '
      + 'are compared, never added together, and every one is kept so forecasts can later be scored '
      + 'against what was actually known at the time.</div></div>'
      + '<div class="btnrow"><button class="btn" id="savebalance">Save this snapshot</button>'
      + (opts.update ? '<button class="btn sec" id="cancelbal">Cancel</button>' : '')
      + '</div></section>';
  }

  /* ---------- Payout Forecast ---------- */
  screens.forecast = function () {
    const account = state.filters.account || 'Standard Orders';
    if (!state.previews.length) {
      return '<section class="card">' + Charts.emptyState('No forecast inputs loaded',
        'The eight-week model runs on Amazon\'s Fees & Economics Preview exports.')
        + '<div style="text-align:center"><button class="btn" data-go="data">'
        + ico('upload', { size: 'sm' }) + 'Import reports</button></div></section>';
    }
    const fc = currentForecast(account, 'base');
    const reqDate = state.requestDate || CSV.addDays(state.today, 1);
    const { run } = runFor(account, reqDate);
    let html = '';

    html += outOfHorizonNotice(fc);

    /* Without the transaction history the economics are still Amazon's own
       numbers and are shown in full. Only the dated payout schedule is held
       back, and the screen says which file would unlock it. */
    if (fc.economicsOnly) {
      html += partialPeriodNote(dataset().forecast);
      html += economicsCards(fc);
    } else {
      html += forecastTiles(fc, run, account);
      html += coverageGapBanners(fc);
      html += availabilityCard(run, reqDate, true);
      if (run) html += bankReceiptsCard(run);
      html += weekByWeek(fc, run);
    }

    /* Notes are warnings: they stay visible, above the folded reference. */
    for (const n of fc.notes) {
      html += '<div class="note is-warn banner">' + ico('missing') + '<div>' + esc(n.message) + '</div></div>';
    }

    if (fc.limitations.length) {
      html += '<section class="card"><div class="card-h"><h2>What limits this forecast</h2></div>'
        + '<ul class="bridge">';
      for (const l of fc.limitations) html += '<li><span class="l">' + esc(l.message) + '</span></li>';
      html += '</ul></section>';
    }

    html += assumptionsCard(fc) + dailyEconomicsDetails(fc);
    return html;
  };

  /* v3's four tiles. Each one is a sum of real events in the run - nothing
     here is a separate estimate that could disagree with the chart below. */
  function forecastTiles(fc, run, account) {
    const from = fc.horizon.from, to = fc.horizon.to;
    const inH = t => t.date >= from && t.date <= to;
    const tl = (run && run.timeline) || [];
    const eligible = run ? tl.filter(t => inH(t) && (t.kind === Cash.EV.RELEASE
      || t.kind === Cash.EV.NEW_AVAILABLE)).reduce((a, t) => a + (t.amount || 0), 0) : null;
    const receipts = tl.filter(t => inH(t) && t.kind === Cash.EV.BANK_RECEIPT);
    const toBank = receipts.length ? receipts.reduce((a, t) => a + (t.amount || 0), 0) : null;
    const nReq = run ? run.executed.filter(e => e.date >= from && e.date <= to).length : 0;
    const bal = latestBalance(account);

    let html = '<div class="grid g4">';
    html += statCard('forecast', 'Becoming eligible, ' + fmtShortDay(from) + ' \u2013 ' + fmtShortDay(to),
      eligible, 'a current balance and release timing', 'MODEL FORECAST');
    html += statCard('bankReceipt', 'Reaches your bank', toBank,
      nReq ? 'bank transit days or deposit history' : 'at least one planned request',
      null, nReq ? 'From ' + nReq + ' planned request' + (nReq === 1 ? '' : 's') : null);
    html += statText('forecast', 'Forecast coverage',
      fc.coverage.coveredDays + ' of ' + fc.coverage.totalDays + ' days', null,
      fc.coverage.complete ? 'Every day has an Amazon forecast'
        : (fc.coverage.totalDays - fc.coverage.coveredDays) + ' days without one');
    html += statCard('available', 'Available now', bal ? bal.available : null,
      'a recorded Amazon balance', null,
      bal ? 'Recorded ' + fmtDay(bal.observedAt) : null);
    return html + '</div>';
  }

  /* A day no forecast covers produces nothing - not zero sales, nothing
     known. Each gap is named, with the file that would fill it. */
  function coverageGapBanners(fc) {
    let html = '';
    for (const g of (fc.coverage.gaps || [])) {
      const n = CSV.daysBetween(g.from, g.to) + 1;
      html += '<div class="note is-warn banner">' + ico('missing') + '<div>'
        + '<b>No preview covers ' + esc(fmtShortDay(g.from)) + ' \u2013 ' + esc(fmtShortDay(g.to))
        + '.</b> Those ' + n + ' day' + (n === 1 ? '' : 's') + ' add nothing to the figures above - '
        + 'not zero sales, just nothing known.</div>'
        + '<button class="btn warn sm" data-go="data">' + ico('upload', { size: 'sm' })
        + 'Import preview</button></div>';
    }
    return html;
  }

  /* The economics the Fees & Economics Preview supports on its own. */
  function economicsCards(fc) {
    const days = fc.dailyEconomics;
    const net = days.reduce((s, d) => s + (d.netReceivable || 0), 0);
    const windows = new Map();
    for (const d of days) {
      let w = windows.get(d.window);
      if (!w) windows.set(d.window, w = { window: d.window, days: 0, net: 0,
        storage: d.windowStorage, ads: d.windowAdvertising, file: d.sourceFile });
      w.days++; w.net += (d.netReceivable || 0);
    }

    let html = '<div class="grid g4">';
    html += statCard('forecast', 'Forecast net receivable', net, null, 'AMAZON FORECAST');
    html += statText('forecast', 'Days covered by a preview',
      fc.coverage.coveredDays + ' of ' + fc.coverage.totalDays, 'AMAZON FORECAST');
    const storage = [...windows.values()].reduce((s, w) => s + (w.storage || 0), 0);
    const ads = [...windows.values()].reduce((s, w) => s + (w.ads || 0), 0);
    html += statCard('expenses', 'Monthly storage in these windows', storage || null,
      'storage columns in the export', 'AMAZON FORECAST');
    html += statCard('expenses', 'Sponsored Products in these windows', ads || null,
      'advertising columns in the export', 'AMAZON FORECAST');
    html += '</div>';

    html += '<section class="card"><div class="card-h">' + ico('forecast')
      + '<h2>Forecast economics by preview window</h2></div>'
      + '<div class="sub">Amazon\'s own estimate for each window you imported. Net sales already '
      + 'has forecast returns removed, and fee parents are used — components are never added on '
      + 'top.</div>'
      + '<div class="tscroll"><table><thead><tr><th>Window</th><th>Source file</th>'
      + '<th class="n">Days in horizon</th><th class="n">Net receivable</th>'
      + '<th class="n">Storage</th><th class="n">Advertising</th></tr></thead><tbody>';
    for (const w of windows.values()) {
      const parts = w.window.split('..');
      html += '<tr><td>' + esc(fmtDay(parts[0])) + ' – ' + esc(fmtDay(parts[1])) + '</td>'
        + '<td class="wrap">' + esc(w.file || '—') + '</td>'
        + '<td class="n">' + w.days + '</td>'
        + '<td class="n">' + amount(w.net) + '</td>'
        + '<td class="n">' + amount(w.storage == null ? null : w.storage,
          { missing: 'storage columns' }) + '</td>'
        + '<td class="n">' + amount(w.ads == null ? null : w.ads,
          { missing: 'advertising columns' }) + '</td></tr>';
    }
    html += '</tbody></table></div>'
      + '<div class="meta" style="margin-top:12px">These are posted-date economics, not bank '
      + 'dates. Money posted on a day is not money you can spend that day.</div></section>';

    return html;
  }

  function weekByWeek(fc, run) {
    let html = '<section class="card"><div class="card-h"><h2>Week-by-week breakdown</h2></div>'
      + '<div class="sub">Each bank-receipt week, and whether an Amazon forecast covers the days '
      + 'behind it.</div>';
    html += '<div class="tscroll"><table><thead><tr><th>Bank-receipt week</th>'
      + '<th>Economic coverage</th><th class="n">Payout</th><th>Bank date</th></tr></thead><tbody>';
    for (const w of bankWeeks(run)) {
      const daysIn = fc.coverage.days.filter(x => x.date >= w.from && x.date <= w.to);
      const covered = daysIn.filter(x => x.covered).length;
      const label = !daysIn.length ? '—'
        : covered === daysIn.length ? 'Covered'
          : covered === 0 ? 'Preview missing' : covered + ' of ' + daysIn.length + ' days';
      html += '<tr><td>' + esc(fmtDay(w.from)) + ' – ' + esc(fmtDay(w.to)) + '</td>'
        + '<td>' + (covered === daysIn.length && daysIn.length
          ? '<span class="tag is-actual">' + ico('verified', { size: 'sm' }) + 'Covered</span>'
          : '<span class="tag is-forecast">' + ico('missing', { size: 'sm' }) + esc(label) + '</span>') + '</td>'
        + '<td class="n">' + (w.amount == null
          ? unavailable('a planned request and a current balance', { size: 'sm' }) : amount(w.amount)) + '</td>'
        + '<td>' + (w.amount == null ? unavailable('bank deposit history', { size: 'sm' })
          : esc(fmtDay(w.from))) + '</td></tr>';
    }
    html += '</tbody></table></div></section>';
    return html;
  }

  function assumptionsCard(fc) {
    let html = '<details class="card"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'Assumptions in force \u00b7 ' + fc.assumptions.length + '</summary><div class="body">'
      + '<p class="meta" style="margin:0 0 12px">Each one says where it came from. Nothing here '
      + 'is a silent default.</p>'
      + '<div class="tscroll"><table><thead><tr><th>Assumption</th><th>Value</th><th>Origin</th>'
      + '<th class="wrap">Basis</th></tr></thead><tbody>';
    for (const a of fc.assumptions) {
      html += '<tr><td class="wrap">' + esc(a.label) + '</td><td>' + esc(a.value) + '</td>'
        + '<td>' + tag(a.origin) + '</td><td class="wrap">' + esc(a.basis) + '</td></tr>';
    }
    html += '</tbody></table></div>'
      + tagLegend(['AMAZON FORECAST', 'MODEL FORECAST', 'CALCULATED', 'ASSUMPTION'])
      + '</div></details>';
    return html;
  }

  function dailyEconomicsDetails(fc) {
    let html = '<details class="card"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'Daily economic estimate behind the forecast</summary><div class="body">'
      + '<div class="tscroll"><table><thead><tr><th>Date</th><th>Window</th>'
      + '<th class="n">Net receivable</th><th>Origin</th></tr></thead><tbody>';
    for (const day of fc.dailyEconomics.slice(0, 80)) {
      html += '<tr><td>' + esc(fmtDay(day.date)) + '</td><td>' + esc(day.window) + '</td>'
        + '<td class="n">' + amount(day.netReceivable) + '</td>'
        + '<td>' + tag('AMAZON FORECAST') + '</td></tr>';
    }
    html += '</tbody></table></div>'
      + '<div class="note">' + ico('info') + '<div>Net sales already has forecast returns removed, '
      + 'so expected refunds are not subtracted a second time. Fee parents are used; base '
      + 'fulfilment, fuel, low-inventory and storage utilisation are components and are never '
      + 'added on top.</div></div></div></details>';
    return html;
  }

  /* ---------- Amazon Expenses ---------- */
  screens.expenses = function () {
    const ds = dataset();
    if (!ds.anyData) return needLedger('Amazon expenses');

    /* Forecast-only is a perfectly good expenses view: it is what Amazon says
       it will charge. It used to render nothing at all. */
    if (!ds.actual.present) {
      let html = '';
      html += '<div class="note is-ok">' + ico('verified') + '<div>'
        + '<b>Showing Amazon\u2019s forecast fees for ' + esc(fmtDay(ds.forecast.period.from))
        + ' – ' + esc(fmtDay(ds.forecast.period.to)) + '.</b> These come from your Fees &amp; '
        + 'Economics Preview. To see the fees you were <em>actually</em> charged, import the '
        + 'Payments date-range transaction CSV.</div></div>';
      html += '<div class="grid g4">'
        + statCard('expenses', 'Forecast Amazon fees',
          ds.forecast.feeTotal == null ? null : -ds.forecast.feeTotal, null, 'AMAZON FORECAST')
        + statCard('expenses', 'Forecast advertising',
          ds.forecast.advertising == null ? null : -ds.forecast.advertising, null, 'AMAZON FORECAST')
        + statCard('expenses', 'Forecast storage',
          ds.forecast.storage == null ? null : -ds.forecast.storage, null, 'AMAZON FORECAST')
        + statText('expenses', 'Fees as a share of sales',
          pctText(ds.forecast.feeTotal, ds.forecast.netSales), 'CALCULATED')
        + '</div>';
      html += forecastFeeTable(ds.forecast);
      html += needsLine(['actual-expenses']);
      html += tagLegend(['AMAZON FORECAST', 'CALCULATED']);
      return html;
    }

    const f = state.filters;
    const filter = { from: f.from, to: f.to, account: f.account, marketplace: f.marketplace, currency: f.currency };
    const cats = state.ledger.componentTotals(filter);
    const rev = Profit.revenue(state.ledger, filter);

    let gross = 0, credits = 0, adsGross = 0, adsCredit = 0,
      unresolvedD = 0, unresolvedC = 0, reimbD = 0, reimbC = 0;
    for (const [name, c] of cats) {
      if (name === Tax.CAT.REVENUE || name === Tax.CAT.TAX || name === Tax.CAT.TRANSFER) continue;
      if (name === Tax.CAT.ADS) { adsGross += c.debit; adsCredit += c.credit; continue; }
      if (name === Tax.CAT.UNCLASSIFIED) { unresolvedD += c.debit; unresolvedC += c.credit; continue; }
      if (name === Tax.CAT.CREDITS) { reimbD += c.debit; reimbC += c.credit; continue; }
      gross += c.debit; credits += c.credit;
    }

    /* The period and the account stream are in the header now (v3). What is
       kept from the old filter card is the warning when a date filter hides
       everything - that one has to stay where the empty figures are. */
    let html = filterHidesDataNotice();

    html += '<div class="grid g4">';
    html += statCard('expenses', 'Gross platform charges', gross, null, 'ACTUAL',
      pctText(gross, rev.netRevenue) + ' of net revenue');
    html += statCard('verified', 'Credits received', credits, null, 'ACTUAL',
      'Shown separately, never netted');
    html += statCard('expenses', 'Net platform cost', gross - credits, null, 'CALCULATED',
      'Charges less credits');
    html += statCard('missing', 'Unresolved', unresolvedD, null, null,
      'Debits \u00b7 ' + M.fmt(unresolvedC, { bare: true }) + ' credits \u00b7 not in totals');
    html += '</div>';

    /* chart of the biggest categories — one series, one colour */
    const bars = [...cats.entries()]
      .filter(([n]) => n !== Tax.CAT.REVENUE && n !== Tax.CAT.TAX && n !== Tax.CAT.TRANSFER)
      .map(([n, c]) => ({ label: n, value: c.debit - c.credit }))
      .filter(r => r.value > 0)
      .sort((a, b) => b.value - a.value);
    const catNames = [...cats.keys()]
      .filter(n => n !== Tax.CAT.REVENUE && n !== Tax.CAT.TAX && n !== Tax.CAT.TRANSFER);
    const anyOpen = catNames.some(n => state.expanded[n]);

    /* v3 puts the picture and the detail in one card: the bars answer "where
       did it go", the table underneath answers "exactly how much". */
    html += '<section class="card"><div class="card-h"><h2>By category</h2>'
      + '<button class="btn sec sm" style="margin-left:auto" data-expandall="'
      + esc(anyOpen ? '[]' : JSON.stringify(catNames)) + '">'
      + (anyOpen ? 'Collapse all' : 'Expand all') + '</button></div>'
      + '<div class="sub">Net cost by category, charges less credits, on a posted-date basis. '
      + 'Charges and credits are never netted into one row: a reversal is not the absence of a '
      + 'charge.</div>'
      + Charts.categoryBars(bars);
    html += '<div class="tscroll" style="margin-top:16px"><table><thead><tr><th>Category</th>'
      + '<th class="n">Charges</th><th class="n">Credits</th><th class="n">Net</th>'
      + '<th class="n">% of net revenue</th><th class="n">Rows</th></tr></thead><tbody>';
    const share = (debit, credit) => {
      const net = debit - credit;
      if (net <= 0) return credit > 0 ? 'Credit' : 'N/A';
      return pctText(net, rev.netRevenue);
    };
    const order = [...cats.entries()]
      .filter(([n]) => n !== Tax.CAT.REVENUE && n !== Tax.CAT.TAX && n !== Tax.CAT.TRANSFER)
      .sort((a, b) => (b[1].debit - b[1].credit) - (a[1].debit - a[1].credit));
    for (const [name, c] of order) {
      const open = !!state.expanded[name];
      html += '<tr class="group"><td>'
        + '<button class="expander" data-expand="' + esc(name) + '" aria-expanded="' + open + '" '
        + 'aria-label="' + (open ? 'Collapse ' : 'Expand ') + esc(name) + '">'
        + ico('chevronRight', { size: 'sm' }) + '</button>' + esc(name) + '</td>'
        + '<td class="n">' + amount(c.debit, { colour: false }) + '</td>'
        + '<td class="n">' + amount(c.credit, { colour: false }) + '</td>'
        + '<td class="n">' + amount(c.net) + '</td>'
        + '<td class="n">' + esc(share(c.debit, c.credit)) + '</td>'
        + '<td class="n">' + c.rows.toLocaleString() + '</td></tr>';
      if (!open) continue;
      for (const s of [...c.subs.values()].sort((a, b) => (b.debit - b.credit) - (a.debit - a.credit))) {
        html += '<tr class="child"><td title="' + esc(s.note || '') + '">' + esc(s.subcategory) + '</td>'
          + '<td class="n">' + amount(s.debit, { colour: false }) + '</td>'
          + '<td class="n">' + amount(s.credit, { colour: false }) + '</td>'
          + '<td class="n">' + amount(s.net) + '</td>'
          + '<td class="n">' + esc(share(s.debit, s.credit)) + '</td>'
          + '<td class="n">' + s.rows.toLocaleString() + '</td></tr>';
      }
    }
    html += '</tbody></table></div>';
    html += '<div class="meta" style="margin-top:12px">Net revenue in this period: '
      + amount(rev.netRevenue) + '. Transfers are excluded — they move cash out of Amazon and are '
      + 'not a cost. Reimbursement reversals stay in the reimbursement family rather than inflating '
      + 'charges.</div>';
    html += '</section>';

    const months = state.ledger.monthly(filter);
    const zeroAds = months.filter(m => m.ads === 0 && m.netRevenue > 0);
    if (zeroAds.length) {
      html += '<div class="note is-warn banner">' + ico('missing') + '<div><b>No advertising '
        + 'deducted in ' + esc(fmtMonths(zeroAds.map(m => m.month))) + '.</b> '
        + 'That is an absence of a deduction in this export, not an absence of advertising cost.'
        + '</div><button class="btn warn sm" data-go="data">Add billing</button></div>';
    }

    html += '<details class="card"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'Fee types this export can\u2019t show \u00b7 ' + Tax.UNOBSERVED_SLOTS.length
      + '</summary><div class="body">'
      + '<p class="meta" style="margin:0 0 12px">The difference between “we are not charged this” '
      + 'and “we cannot see it” matters, so the second case is listed rather than left blank.</p>'
      + '<div class="tscroll"><table><thead><tr><th>Category</th><th>Subcategory</th>'
      + '<th class="wrap">Why there is no coverage</th></tr></thead><tbody>';
    for (const s of Tax.UNOBSERVED_SLOTS) {
      html += '<tr><td>' + esc(s.cat) + '</td><td>' + esc(s.sub) + '</td>'
        + '<td class="wrap">' + esc(s.why) + '</td></tr>';
    }
    html += '</tbody></table></div></div></details>';

    if (ds.forecast.present) {
      html += forecastFeeTable(ds.forecast, { alsoActual: true });
    }
    html += tagLegend(['ACTUAL', 'AMAZON FORECAST', 'CALCULATED']);
    return html;
  };

  /* Amazon's forecast of what it will charge, by family, with the hierarchy
     rule intact: parents count, components explain. */
  function forecastFeeTable(f, opts) {
    opts = opts || {};
    const counted = f.fees.filter(x => x.countedInTotal && x.total != null);
    const parts = f.fees.filter(x => x.nonAdditive && x.total != null);
    const ads = f.fees.find(x => x.group === 'advertising');

    let html = partialPeriodNote(f);
    html += '<section class="card"><div class="card-h">' + ico('expenses')
      + '<h2>Forecast fee breakdown</h2></div>'
      + '<div class="sub">Amazon\u2019s estimate for ' + esc(fmtDay(f.period.from)) + ' – '
      + esc(fmtDay(f.period.to)) + '. These are forecasts, not charges you have been billed.'
      + (opts.alsoActual ? ' Your actual charges are in the section above.' : '') + '</div>';

    html += '<div class="tscroll"><table><thead><tr><th>Fee</th><th>Group</th>'
      + '<th class="n">Forecast</th><th class="n">% of net sales</th><th>Basis</th>'
      + '</tr></thead><tbody>';
    for (const x of counted.sort((a, b) => (b.total || 0) - (a.total || 0))) {
      html += '<tr><td>' + esc(plainFeeName(x.name)) + '</td><td>' + esc(x.group) + '</td>'
        + '<td class="n">' + amount(x.total, { colour: false }) + '</td>'
        + '<td class="n">' + esc(pctText(x.total, f.netSales)) + '</td>'
        + '<td>' + tag('AMAZON FORECAST') + '</td></tr>';
    }
    html += '<tr class="sum"><td>Total Amazon fees</td><td></td>'
      + '<td class="n">' + amount(f.feeTotal, { colour: false }) + '</td>'
      + '<td class="n">' + esc(pctText(f.feeTotal, f.netSales)) + '</td><td></td></tr>';
    if (ads && ads.total != null) {
      html += '<tr><td>' + esc(plainFeeName(ads.name)) + '</td><td>advertising</td>'
        + '<td class="n">' + amount(ads.total, { colour: false }) + '</td>'
        + '<td class="n">' + esc(pctText(ads.total, f.netSales)) + '</td>'
        + '<td>' + tag('AMAZON FORECAST') + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="meta" style="margin-top:12px">Advertising is listed under the total, not '
      + 'inside it: whether it reduces your Amazon balance depends on how it is billed.</div>';

    if (parts.length) {
      html += '<details style="margin-top:16px"><summary>' + ico('info', { size: 'sm' })
        + 'What makes up those fees (' + parts.length + ' components)</summary>'
        + '<p class="meta" style="margin:12px 0">These sit <b>inside</b> the totals above and are '
        + 'never added on top. Amazon\u2019s parent total is the authority; the parts do not always '
        + 'sum to it exactly, and the difference is Amazon\u2019s, not a rounding error here.</p>'
        + '<div class="tscroll"><table><thead><tr><th>Component</th><th>Part of</th>'
        + '<th class="n">Forecast</th></tr></thead><tbody>';
      for (const x of parts.sort((a, b) => (b.total || 0) - (a.total || 0))) {
        html += '<tr class="child"><td>' + esc(plainFeeName(x.name)) + '</td>'
          + '<td>' + esc(plainFeeName(x.parent)) + '</td>'
          + '<td class="n">' + amount(x.total, { colour: false }) + '</td></tr>';
      }
      html += '</tbody></table></div></details>';
    }

    const absent = f.fees.filter(x => !x.columnPresent);
    if (absent.length) {
      html += '<div class="note is-warn" style="margin-top:16px">' + ico('missing') + '<div>'
        + '<b>' + absent.length + ' fee types are not in this export\u2019s columns</b>, so they are '
        + 'unknown for this period rather than zero: '
        + esc(absent.map(x => plainFeeName(x.name)).join(', ')) + '.</div></div>';
    }
    html += '</section>';
    return html;
  }

  /* Amazon's column names, in words an owner uses. */
  const FEE_WORDS = {
    'FBA fulfillment fees': 'Fulfilment (FBA)',
    'Base fulfillment fee': 'Base fulfilment',
    'Fuel and Logistics-related surcharge': 'Fuel and logistics surcharge',
    'Low-inventory-level fee': 'Low-inventory fee',
    'Monthly inventory storage fee': 'Monthly storage',
    'Base monthly storage fee': 'Base monthly storage',
    'Storage utilization surcharge': 'Storage utilisation surcharge',
    'Aged inventory surcharge': 'Aged inventory surcharge',
    'Referral fee': 'Referral fee',
    'Per-item selling fee': 'Per-item selling fee',
    'Closing fee': 'Closing fee',
    'Returns processing fee for Apparel and Shoes': 'Returns processing (apparel)',
    'Sponsored Products charge': 'Sponsored Products advertising',
  };
  const plainFeeName = n => FEE_WORDS[n] || n || '\u2014';

  /* What a preview can be checked against: itself. Row acceptance, the fee
     hierarchy, and which days of the horizon it actually covers. */
  function previewChecks(f) {
    let html = '<section class="card"><div class="card-h">' + ico('recon')
      + '<h2>Checks on the imported forecast</h2></div>'
      + '<div class="sub">Every one of these is computed from the file you imported.</div>';

    html += '<div class="tscroll"><table><thead><tr><th>Check</th><th>Result</th>'
      + '<th class="wrap">What it means</th></tr></thead><tbody>';

    const files = f.files || [];
    const processed = files.reduce((a, x) => a + (x.rowsProcessed || 0), 0);
    const accepted = files.reduce((a, x) => a + (x.rowsAccepted || 0), 0);
    const rejected = files.reduce((a, x) => a + (x.rejected || []).length, 0);

    const row = (label, ok, result, why) =>
      '<tr><td>' + esc(label) + '</td><td>'
      + (ok ? '<span class="tag is-actual">' + ico('verified', { size: 'sm' }) + esc(result)
        + '</span>' : '<span class="tag is-forecast">' + ico('missing', { size: 'sm' })
        + esc(result) + '</span>')
      + '</td><td class="wrap">' + esc(why) + '</td></tr>';

    html += row('Rows read and accepted', rejected === 0,
      accepted.toLocaleString() + ' of ' + processed.toLocaleString(),
      rejected === 0 ? 'Every data row in the file became a record.'
        : rejected + ' rows were rejected; they are listed on Data & assumptions.');

    /* Parent vs components, per aggregate family. */
    for (const parent of ['FBA fulfillment fees', 'Monthly inventory storage fee']) {
      const p = f.fees.find(x => x.name === parent);
      if (!p || p.total == null) continue;
      const kids = f.fees.filter(x => x.parent === parent && x.total != null);
      if (!kids.length) continue;
      const sum = kids.reduce((a, x) => a + x.total, 0);
      const diff = p.total - sum;
      html += row(plainFeeName(parent) + ': parent vs its parts', diff === 0,
        diff === 0 ? 'Identical' : M.fmt(diff) + ' difference',
        diff === 0 ? 'The parts add up to Amazon\u2019s total exactly.'
          : 'Amazon\u2019s own total differs from the sum of the parts it reports. The parent is '
            + 'used everywhere in this app; the parts are never added on top.');
    }

    const cov = previewCoverage();
    if (cov) {
      html += row('Days of the next 8 weeks covered', cov.complete,
        cov.coveredDays + ' of ' + cov.totalDays,
        cov.complete ? 'Every day in the forecast horizon is backed by a preview.'
          : 'Uncovered days produce no forecast activity. They are never filled in from a '
            + 'neighbouring window.');
      if (cov.overlaps && cov.overlaps.length) {
        html += row('Overlapping windows', false, cov.overlaps.length + ' days',
          'More than one imported file claims these days. Check you have not loaded two '
          + 'versions of the same period.');
      }
    }

    html += '</tbody></table></div></section>';
    return html;
  }

  function needLedger(what) {
    /* If something HAS been imported, say so first. An empty screen that does
       not acknowledge the file you just loaded reads as a failed import. */
    let html = '';
    if (state.previews.length) {
      const periods = state.previews.map(p => fmtDay(p.period.start) + ' – ' + fmtDay(p.period.end));
      html += '<div class="note is-ok">' + ico('verified') + '<div>'
        + '<b>' + state.previews.length + ' Fees &amp; Economics Preview '
        + (state.previews.length === 1 ? 'file is' : 'files are') + ' imported and in use</b> ('
        + esc(periods.join(', ')) + '). ' + esc(what) + ' is a record of what already happened, '
        + 'so it reads the Payments transaction export instead — a forecast file cannot supply it.'
        + '<div class="btnrow" style="margin-top:12px">'
        + '<button class="btn sec" data-go="forecast">' + ico('forecast', { size: 'sm' })
        + 'See what the preview does show</button></div></div></div>';
    }
    return html + '<section class="card">'
      + Charts.emptyState(what + ' needs the transaction history',
        'Load the Payments “Date range transaction” CSV. Nothing here is estimated from anything '
        + 'else in the meantime.')
      + '<div style="text-align:center"><button class="btn" data-go="data">'
      + ico('upload', { size: 'sm' }) + 'Import reports</button></div></section>';
  }

  /* ---------- Profitability ---------- */
  screens.profit = function () {
    const ds = dataset();
    if (!ds.anyData) return needLedger('Profitability');

    /* Forecast-only: revenue and Amazon's costs are both known, so contribution
       before product cost is a real figure. Product cost is what is missing,
       and the SKUs missing one are named rather than silently dropped. */
    if (!ds.actual.present) {
      const f = ds.forecast;
      /* By MSKU, and the cost in force at the end of the forecast period -
         the same rule the statement uses, so the two never disagree. */
      const inCur = Inputs.costsIn(state.productCosts, state.filters.currency);
      const costed = new Map();
      for (const r of f.bySku) {
        const c = Profit.costFor(inCur, r.msku, f.period.to || '9999-12-31');
        if (c) costed.set(r.msku, c);
      }
      const missing = f.bySku.filter(r => !costed.has(r.msku));
      let cogs = null;
      for (const r of f.bySku) {
        const c = costed.get(r.msku);
        if (c && c.unitCost != null && r.netUnits != null) {
          cogs = (cogs || 0) + Math.round(c.unitCost * r.netUnits);
        }
      }

      let html = '<div class="note is-ok">' + ico('verified') + '<div>'
        + '<b>Showing forecast profitability for ' + esc(fmtDay(f.period.from)) + ' – '
        + esc(fmtDay(f.period.to)) + '</b>, built from your Fees &amp; Economics Preview. It is '
        + 'what Amazon expects, not what has happened.</div></div>';

      html += '<div class="grid g4">'
        + statCard('available', 'Forecast net sales', f.netSales, null, 'AMAZON FORECAST')
        + statCard('expenses', 'Amazon fees', f.feeTotal == null ? null : -f.feeTotal,
          null, 'AMAZON FORECAST')
        + statCard('expenses', 'Product cost', cogs == null ? null : -cogs,
          'what each product costs you', cogs == null ? null : 'CALCULATED')
        + statCard('profit', 'Contribution before product cost',
          f.netSales == null ? null : f.netSales - (f.feeTotal || 0), null, 'CALCULATED')
        + '</div>';

      html += '<section class="card"><div class="card-h">' + ico('profit')
        + '<h2>Forecast contribution</h2></div>'
        + '<div class="sub">Amazon\u2019s forecast revenue less Amazon\u2019s forecast fees. It is '
        + 'not net profit: it stops short of what you paid for the goods and of your own '
        + 'operating costs.</div>'
        + '<ul class="bridge">'
        + '<li><span class="l">Forecast net sales</span><span class="v">'
        + esc(M.fmt(f.netSales)) + '</span></li>'
        + '<li><span class="l">Amazon fees (parents only)</span><span class="v">'
        + esc(M.fmt(-(f.feeTotal || 0))) + '</span></li>'
        + '<li><span class="l">Advertising</span><span class="v">'
        + esc(M.fmt(-(f.advertising || 0))) + '</span></li>'
        + '<li class="total"><span class="l">Contribution before product cost</span>'
        + '<span class="v">' + esc(M.fmt((f.netSales || 0) - (f.feeTotal || 0)
          - (f.advertising || 0))) + '</span></li>'
        + '</ul></section>';

      html += '<section class="card"><div class="card-h">' + ico('profit')
        + '<h2>By product</h2></div>'
        + '<div class="sub">Ordered by forecast net sales. A product with no recorded cost shows '
        + 'its contribution before product cost, never a made-up margin.</div>'
        + '<div class="tscroll"><table><thead><tr><th>MSKU</th><th>ASIN</th>'
        + '<th class="n">Units</th><th class="n">Net sales</th><th class="n">Amazon fees</th>'
        + '<th class="n">Before product cost</th><th>Product cost</th></tr></thead><tbody>';
      for (const r of f.bySku.slice(0, 200)) {
        html += '<tr><td class="wrap">' + esc(r.msku) + '</td><td>' + esc(r.asin || '\u2014') + '</td>'
          + '<td class="n">' + (r.unitsSold == null ? '\u2014' : r.unitsSold.toLocaleString()) + '</td>'
          + '<td class="n">' + amount(r.netSales) + '</td>'
          + '<td class="n">' + amount(r.orderFees == null ? null : -r.orderFees) + '</td>'
          + '<td class="n">' + amount(r.contribution) + '</td>'
          + '<td>' + (costed.has(r.msku) ? tag('ACTUAL')
            : '<span class="tag is-forecast" title="No cost recorded for this product.">'
            + ico('missing', { size: 'sm' }) + 'Not recorded</span>') + '</td></tr>';
      }
      html += '</tbody></table></div>';
      if (f.bySku.length > 200) {
        html += '<div class="meta" style="margin-top:8px">Showing the top 200 of '
          + f.bySku.length + ' products by forecast net sales.</div>';
      }
      html += '</section>';

      if (missing.length) {
        html += '<div class="note is-warn">' + ico('missing') + '<div><b>'
          + missing.length + ' of ' + f.bySku.length + ' products have no recorded cost</b>, so '
          + 'net profit cannot be calculated for them. Everything above stops at contribution '
          + 'before product cost, which is a real figure on its own.</div></div>';
      }
      html += needsLine(['product-profit']);
      html += tagLegend(['AMAZON FORECAST', 'CALCULATED', 'ACTUAL']);
      return html;
    }

    /* v3 shows the statement and the products together; they used to be two
       tabs, so the one question "which products cost me" was always one click
       away from the answer it qualified. */
    const f = state.filters;
    const filter = { from: f.from, to: f.to, account: f.account, marketplace: f.marketplace,
      marketplaces: f.marketplace ? [f.marketplace] : null, currency: f.currency };
    /* Advertising billed outside Amazon, for exactly this period. Days no
       billing record covers leave it unsupplied - never zero - and the
       statement keeps its "after recorded costs" name until they are. */
    const lr = state.ledger.dateRange();
    const pFrom = f.from || lr.from, pTo = f.to || lr.to;
    const ads = Inputs.externalAdvertising(state.advertisingBilling, pFrom, pTo, f.currency);
    const costsHere = Inputs.costsIn(state.productCosts, f.currency);
    const st = Profit.statement(state.ledger, {
      filter,
      productCosts: costsHere.length ? costsHere : null,
      operatingCosts: state.operatingCosts.length ? state.operatingCosts : null,
      externalAdvertising: ads.complete ? ads.amount : null,
    });
    const sk = Profit.bySku(state.ledger, { filter, productCosts: costsHere });

    let html = filterHidesDataNotice();
    /* Top-aligned: the coverage card is short, and stretched to the
       statement's height it would be mostly empty. */
    html += '<div class="grid g-main" style="align-items:start">';

    html += '<section class="card"><div class="card-h"><h2>'
      + esc(st.contributionComplete ? 'Profit' : 'Contribution after recorded costs')
      + '</h2></div><div class="sub">' + esc(st.basisNote || '') + '</div>';
    html += '<ul class="bridge">';
    for (const l of st.lines) {
      html += '<li' + (l.emphasis ? ' class="total"' : '') + '><span class="l">' + esc(l.label)
        + (l.incomplete ? ' <span class="tag is-forecast">Incomplete</span>' : '')
        + (l.note ? '<div class="meta">' + esc(l.note) + '</div>' : '')
        + (l.why ? '<div class="meta">' + esc(l.why) + '</div>' : '')
        + '</span><span class="v">'
        + amount(l.amount, { missing: l.missing || 'an input' }) + '</span></li>';
    }
    html += '<li class="total"><span class="l">Net profit</span><span class="v">'
      + amount(st.netProfit) + '</span></li>';
    html += '<li class="ctx"><span class="l">Net margin</span><span class="v">'
      + amount(st.netMargin) + '</span></li></ul>';
    html += '<details class="plain"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'What this engine will not do</summary><ul class="meta" style="padding-left:18px">'
      + st.guards.map(g => '<li>' + esc(g) + '</li>').join('') + '</ul></details>';
    html += '</section>';

    /* What the statement is missing, beside it - not a warning under it. */
    const cov = st.productCost.coverage;
    const skuMissing = sk.costCoverage.total - sk.costCoverage.covered;
    html += '<section class="card"><div class="card-h"><h2>Cost coverage</h2>'
      + (skuMissing ? '<span class="tag is-warn">' + skuMissing + ' missing</span>'
        : '<span class="tag is-ok">Complete</span>') + '</div>'
      + '<dl class="dl" style="margin-top:8px">'
      + '<dt>Units with a product cost</dt><dd>' + (cov.total
        ? esc(cov.covered.toLocaleString() + ' of ' + cov.total.toLocaleString()) : 'None supplied') + '</dd>'
      + '<dt>Products with a cost</dt><dd>' + esc(sk.costCoverage.covered + ' of ' + sk.costCoverage.total)
      + '</dd>'
      + '<dt>Operating costs</dt><dd>' + (st.coverage.operatingCosts ? 'Recorded' : 'Not supplied') + '</dd>'
      + '<dt>External advertising</dt><dd>' + (st.coverage.externalAdvertising
        ? 'Recorded' + (ads.prorated ? ' \u00b7 ' + ads.prorated + ' bill' + (ads.prorated === 1 ? '' : 's')
          + ' counted by day' : '')
        : state.advertisingBilling.length && ads.totalDays
          ? esc(ads.coveredDays + ' of ' + ads.totalDays + ' days recorded') : 'Not supplied') + '</dd></dl>'
      + '<div class="meta" style="margin-top:10px">Revenue less Amazon\u2019s fees is not profit until '
      + 'what you paid for the goods is in.</div>'
      + (skuMissing || !st.coverage.externalAdvertising ? '<div class="btnrow" style="margin-top:14px">'
        + (skuMissing ? '<button class="btn sec sm" data-go="data" data-then="costsform">'
          + ico('add', { size: 'sm' }) + 'Add missing costs</button>' : '')
        + (!st.coverage.externalAdvertising ? '<button class="btn sec sm" data-go="data" data-then="adsform"'
          + (skuMissing ? ' style="margin-left:8px"' : '') + '>'
          + ico('add', { size: 'sm' }) + 'Add advertising billing</button>' : '')
        + '</div>' : '')
      + '</section>';
    html += '</div>';

    /* By product, with v3's filter: everything, or just the products whose
       figures stop short because their cost is missing. */
    const pf = state.profitFilter === 'missing' ? 'missing' : 'all';
    const rows = pf === 'missing' ? sk.rows.filter(r => r.cogs == null) : sk.rows;
    const nMissing = sk.rows.filter(r => r.cogs == null).length;
    html += '<section class="card"><div class="card-h"><h2>By product</h2>'
      + '<span class="seg" role="group" aria-label="Which products" style="margin-left:auto">'
      + '<button data-pfilter="all" aria-pressed="' + (pf === 'all') + '">All \u00b7 '
      + sk.rows.length + '</button>'
      + '<button data-pfilter="missing" aria-pressed="' + (pf === 'missing') + '">Missing cost \u00b7 '
      + nMissing + '</button></span></div>'
      + '<div class="sub">' + sk.costCoverage.covered + ' of ' + sk.costCoverage.total
      + ' products have a recorded cost. One without shows its contribution before product cost, '
      + 'never a made-up margin.</div>';
    html += '<div class="tscroll"><table><thead><tr><th>MSKU</th><th class="n">Units</th>'
      + '<th class="n">Net revenue</th><th class="n">Selling fees</th><th class="n">FBA fees</th>'
      + '<th class="n">Product cost</th><th class="n">Contribution</th></tr></thead><tbody>';
    for (const r of rows.slice(0, 250)) {
      html += '<tr><td>' + esc(r.msku) + '</td>'
        + '<td class="n">' + r.unitsSold.toLocaleString() + '</td>'
        + '<td class="n">' + amount(r.netRevenue) + '</td>'
        + '<td class="n">' + amount(r.sellingFees) + '</td>'
        + '<td class="n">' + amount(r.fbaFees) + '</td>'
        + '<td class="n">' + amount(r.cogs == null ? null : -r.cogs,
          { missing: 'a product cost', size: 'sm' }) + '</td>'
        + '<td class="n">' + amount(r.contribution,
          { missing: 'a product cost', size: 'sm' }) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    if (rows.length > 250) {
      html += '<div class="meta" style="margin-top:8px">Showing the first 250 of ' + rows.length
        + ' products.</div>';
    }
    html += '<div class="meta" style="margin-top:12px">Unallocated account-level charges: '
      + amount(sk.unallocated.amount) + ' across ' + sk.unallocated.rows.toLocaleString()
      + ' rows. ' + esc(sk.unallocated.note) + '</div></section>';

    html += tagLegend(['ACTUAL', 'CALCULATED', 'ASSUMPTION']);
    return html;
  };

  /* ---------- Cash Plan ---------- */
  screens.plan = function () {
    const account = state.filters.account || 'Standard Orders';
    const reqDate = state.requestDate || CSV.addDays(state.today, 1);
    const to = horizonEnd();
    const { run } = runFor(account, reqDate);
    const planned = state.requestPlans.filter(p => !p.account || p.account === account).length;

    /* Amazon money reaches the plan only on dates the engine can put on it.
       What it cannot date is counted separately and said out loud, so the
       figure is visibly conservative rather than quietly optimistic. */
    const receipts = run ? run.timeline.filter(t => t.kind === Cash.EV.BANK_RECEIPT)
      .map(t => ({ date: t.date, amount: t.amount, label: 'Amazon payout reaches the bank' })) : [];
    const undated = run ? run.bridges.filter(b => b.requested > 0
      && !(b.expectedBankReceipt && b.expectedBankReceipt.date))
      .reduce((a, b) => a + b.requested, 0) : 0;

    let proj = null, err = null;
    try {
      proj = Cash.bankProjection({
        opening: state.openingBankCash, openingDate: state.cashPlan.bankCashAt || state.today,
        from: state.today, to, buffer: state.cashPlan.buffer, receipts, undated,
        commitments: state.cashCommitments.map(c => ({ due: c.due, amount: c.amount, label: c.label })),
      });
    } catch (e) {
      if (e.name !== 'Unavailable') throw e;
      err = e;
    }

    let html = '<div class="grid g3">';
    if (proj) {
      html += '<div class="tile">'
        + '<div class="tile-l">Safe to spend through ' + esc(fmtShortDay(to)) + '</div>'
        + '<div class="tile-v fig">' + money(proj.safeToSpend) + '</div>'
        + '<div class="tile-m">' + (proj.shortfall
          ? '<span class="tag is-error">Short by ' + esc(M.fmt(proj.shortfall, { bare: true })) + '</span>'
          : 'Lowest projected balance, less your buffer') + '</div></div>';
      html += '<div class="tile"><div class="tile-l">Lowest projected bank balance</div>'
        + '<div class="tile-v fig">' + money(proj.lowest.amount) + '</div>'
        + '<div class="tile-m">On ' + esc(weekday(proj.lowest.date)) + ', ' + esc(fmtShortDay(proj.lowest.date))
        + '</div></div>';
    } else {
      html += statCard('plan', 'Safe to spend through ' + fmtShortDay(to), null,
        'your current bank cash', null);
      html += statCard('plan', 'Lowest projected bank balance', null, 'your current bank cash', null);
    }
    const buf = state.cashPlan.buffer;
    html += '<div class="tile"><div class="tile-l"><label for="bank-buffer">Buffer to keep</label></div>'
      + '<div class="hctl" style="margin-top:6px"><span class="cur">' + esc(state.filters.currency || 'USD')
      + '</span><input type="number" step="0.01" id="bank-buffer" style="width:140px" placeholder="0.00" value="'
      + (buf == null ? '' : (buf / 100).toFixed(2)) + '">'
      + '<button class="btn sec sm" id="savebuffer">Save</button></div>'
      + '<div class="tile-m">' + (buf == null ? 'Not set, so nothing is held back yet'
        : 'Held back from safe-to-spend') + '</div></div>';
    html += '</div>';

    /* The bank cash every figure above starts from, and when it was read. */
    html += '<div class="toolbar"><span class="tb-l"><label for="bank-open">Bank cash today</label></span>'
      + '<span class="hctl"><span class="cur">' + esc(state.filters.currency || 'USD') + '</span>'
      + '<input type="number" step="0.01" id="bank-open" style="width:160px" placeholder="0.00" value="'
      + (state.openingBankCash == null ? '' : (state.openingBankCash / 100).toFixed(2)) + '">'
      + '<button class="btn sec sm" id="savebank">Save</button></span>'
      + '<span class="meta">' + (state.openingBankCash == null ? 'Not recorded yet'
        : 'recorded ' + (state.cashPlan.bankCashAt ? esc(fmtDay(state.cashPlan.bankCashAt)) : 'on an unrecorded date'))
      + '</span>'
      + '<span class="tb-r">Amazon payouts: ' + (planned
        ? 'from your ' + planned + ' planned request' + (planned === 1 ? '' : 's')
        : 'from a request on ' + esc(fmtShortDay(reqDate)) + ' (none planned)') + '</span></div>';

    if (err) {
      html += '<div class="note is-warn banner">' + ico('missing') + '<div><b>Enter your bank cash above.</b> '
        + 'A spendable figure starts from what is in the bank now. Until then none is shown, because '
        + 'a plausible-looking one would be worse than none.</div></div>';
    } else if (undated) {
      html += '<div class="note is-warn banner">' + ico('missing') + '<div><b>'
        + esc(M.fmt(undated, { bare: true })) + ' of Amazon payouts is not counted</b>, because when it '
        + 'reaches the bank cannot be dated yet. The figures above are lower than they will be.</div>'
        + '<button class="btn warn sm" data-go="data">Add bank timing</button></div>';
    }

    html += cashFlowCard(proj, to);
    return html;
  };

  /* Every movement the plan counts, in order, with the balance after each -
     and the ones it deliberately does not count, with the reason. */
  function cashFlowCard(proj, to) {
    let html = '<section class="card" id="cashflow"><div class="card-h"><h2>Cash flow by date</h2></div>'
      + '<div class="sub">Bills, cards and stock purchases by due date, and Amazon payouts on the day '
      + 'they reach your bank, through ' + esc(fmtDay(to)) + '. Amazon\u2019s fees are already inside '
      + 'the payouts, so they are not taken off again.</div>';
    if (proj && (proj.rows.length || proj.notCounted.length)) {
      html += '<div class="tscroll"><table><thead><tr><th>Date</th><th class="wrap">What</th>'
        + '<th class="n">In</th><th class="n">Out</th><th class="n">Bank after</th></tr></thead><tbody>'
        + '<tr><td>' + esc(fmtDay(proj.openingDate)) + '</td><td class="wrap">Bank cash recorded</td>'
        + '<td class="n"></td><td class="n"></td><td class="n">' + amount(proj.opening) + '</td></tr>';
      for (const r of proj.rows) {
        const low = r.date === proj.lowest.date && r.balance === proj.lowest.amount;
        html += '<tr' + (low ? ' style="font-weight:600"' : '') + '><td>' + esc(fmtDay(r.date)) + '</td>'
          + '<td class="wrap">' + esc(r.label) + (low ? ' <span class="tag is-warn">Lowest point</span>' : '')
          + '</td><td class="n">' + (r.inflow ? amount(r.inflow) : '') + '</td>'
          + '<td class="n">' + (r.outflow ? amount(-r.outflow) : '') + '</td>'
          + '<td class="n">' + amount(r.balance) + '</td></tr>';
      }
      for (const c of proj.notCounted) {
        html += '<tr style="color:var(--ink-3)"><td>' + esc(fmtDay(c.due)) + '</td><td class="wrap">'
          + esc(c.label) + ' <span class="tag">Not counted: ' + esc(c.why) + '</span></td>'
          + '<td class="n"></td><td class="n">' + amount(-c.amount) + '</td><td class="n">\u2014</td></tr>';
      }
      html += '</tbody></table></div>';
    } else if (proj) {
      html += Charts.emptyState('Nothing due yet',
        'Add the bills, card payments and stock purchases you already know about.');
    }
    html += '<div class="frow f3" style="margin-top:16px">'
      + '<div class="field"><label class="lbl" for="c-label">Description</label>'
      + '<input type="text" id="c-label" placeholder="Supplier invoice"></div>'
      + '<div class="field"><label class="lbl" for="c-amount">Amount</label>'
      + '<input type="number" step="0.01" id="c-amount"></div>'
      + '<div class="field"><label class="lbl" for="c-due">Due date</label>'
      + '<input type="date" id="c-due"></div></div>'
      + '<button class="btn" id="addcommit">' + ico('add', { size: 'sm' }) + 'Add commitment</button>';
    return html + '</section>';
  }

  /* ---------- Reconciliation ---------- */
  screens.recon = function () {
    const dsR = dataset();
    if (!dsR.anyData) return needLedger('Reconciliation');
    if (!state.ledger) {
      let html = '<div class="note is-ok">' + ico('verified') + '<div>'
        + '<b>Checking your Fees &amp; Economics Preview.</b> The settlement and transfer checks '
        + 'below need the Payments transaction export; the checks this file supports are shown '
        + 'here.</div></div>';
      html += previewChecks(dsR.forecast);
      html += needsLine(['actual-expenses']);
      return html;
    }
    /* v3: one card, the checks first, a count on a tab wherever the count is
       exact and cheap. The forecast-file checks used to appear only when there
       was NO transaction history - importing more data hid them. */
    const hasFc = dsR.forecast.present;
    const tab = state.tab || (hasFc ? 'checks' : 'settlements');
    const nSettle = state.ledger.settlementGroups().size;
    const nRuns = state.forecastRuns.length;
    const tb = (id, label, n) => '<button data-tab="' + id + '" role="tab" aria-current="'
      + (tab === id) + '">' + label + (n != null ? ' <span class="count">' + n + '</span>' : '')
      + '</button>';
    let html = '<div class="card tabcard"><div class="subtabs" role="tablist">'
      + (hasFc ? tb('checks', 'Checks') : '')
      + tb('settlements', 'Settlements', nSettle)
      + tb('bank', 'Bank &amp; transfers')
      + tb('fva', 'Forecast vs actual', nRuns)
      + tb('baselines', 'Baselines')
      + '</div>';

    if (tab === 'checks' && hasFc) html += previewChecks(dsR.forecast);

    if (tab === 'settlements') {
      const groups = state.ledger.settlementGroups();
      const br = Recon.settlementBridge(groups, state.settlements);
      html += '<section class="card"><div class="card-h">' + ico('recon')
        + '<h2>Settlement bridge</h2></div>';
      if (br.status === Recon.NOT_TESTED) {
        html += '<div class="note is-warn">' + ico('missing') + '<div><b>Not tested — needs '
          + esc(br.missing) + '.</b><br>' + esc(br.message) + '</div></div>';
      }
      html += '<div class="sub">Reference grouping of the posted-date extract by settlement id. '
        + 'A settlement that closed inside the extract would net to zero; none do.</div>';
      html += '<div class="tscroll"><table><thead><tr><th>Settlement</th><th class="n">Rows</th>'
        + '<th>Covered</th><th>Streams</th><th class="n">Transfer</th>'
        + '<th class="n">Residual</th></tr></thead><tbody>';
      for (const g of (br.groups || []).slice(0, 60)) {
        html += '<tr><td>' + esc(g.settlementId) + '</td><td class="n">' + g.rows.toLocaleString() + '</td>'
          + '<td>' + esc(g.from || '—') + ' → ' + esc(g.to || '—') + '</td>'
          + '<td>' + esc((g.accounts || []).join(', ')) + '</td>'
          + '<td class="n">' + amount(-g.transfer, { colour: false }) + '</td>'
          + '<td class="n">' + amount(g.residual) + '</td></tr>';
      }
      html += '</tbody></table></div>'
        + '<div class="note">' + ico('info') + '<div>A residual is not missing money. Posted-date '
        + 'boundaries, deferral timing and the absent opening balance all land here, and only '
        + 'official statements can separate them.</div></div></section>';
    }

    if (tab === 'bank') {
      const tr = state.ledger.transfers(state.filters);
      const match = Recon.matchBankDeposits(tr, state.bankDeposits.filter(d =>
        !d.currency || !state.filters.currency || d.currency === state.filters.currency));
      html += '<section class="card"><div class="card-h">' + ico('inTransit')
        + '<h2>Transfers out of Amazon</h2></div>';
      if (match.status === Recon.NOT_TESTED) {
        html += '<div class="note is-warn">' + ico('missing') + '<div><b>Bank timing unverified — '
          + 'needs ' + esc(match.missing) + '.</b><br>' + esc(match.message) + '</div></div>';
      } else if (match.transitStats) {
        html += '<div class="note is-ok">' + ico('verified') + '<div>Measured transit: median '
          + match.transitStats.median + ' days (' + match.transitStats.p10 + '–'
          + match.transitStats.p90 + '), from ' + match.transitStats.n
          + ' matched deposits. Measured, not assumed.</div></div>';
      }
      html += '<div class="tscroll"><table><thead><tr><th>Date</th><th>Stream</th>'
        + '<th>Bank transfer ID</th><th>To account</th><th class="n">Amount</th>'
        + '<th>Bank date</th></tr></thead><tbody>';
      for (const t of tr.slice(-80).reverse()) {
        const m = (match.matches || []).find(x => x.transfer === t);
        html += '<tr><td>' + esc(fmtDay(t.date)) + '</td><td>' + esc(t.account) + '</td>'
          + '<td>' + esc(t.bankTransferId || '—') + '</td>'
          + '<td>' + esc(t.destinationRef || '—') + '</td>'
          + '<td class="n">' + amount(t.amount, { colour: false }) + '</td>'
          + '<td>' + (m ? esc(fmtDay(m.deposits[m.deposits.length - 1].date))
            : unavailable('bank deposit history', { size: 'sm' })) + '</td></tr>';
      }
      html += '</tbody></table></div></section>';
    }

    if (tab === 'fva') {
      html += '<section class="card"><div class="card-h">' + ico('recon')
        + '<h2>Forecast versus actual</h2></div>';
      if (!state.forecastRuns.length) {
        html += Charts.emptyState('No forecast has been saved yet',
          'A forecast becomes scoreable the moment it is saved with its information cutoff frozen. '
          + 'Nothing here is reconstructed after the fact — a forecast rebuilt with today\'s '
          + 'knowledge is not a forecast.')
          + '<div style="text-align:center"><button class="btn" id="saverun">'
          + 'Save the current forecast run</button></div>';
      } else {
        html += '<div class="tscroll"><table><thead><tr><th>Run</th><th>Cutoff</th>'
          + '<th>Horizon</th><th>Scenario</th><th>Status</th></tr></thead><tbody>';
        for (const r of state.forecastRuns) {
          html += '<tr><td>' + esc(r.runId) + '</td><td>' + esc((r.knownAt || '').slice(0, 10)) + '</td>'
            + '<td>' + esc(r.horizon.from) + ' → ' + esc(r.horizon.to) + '</td>'
            + '<td>' + esc(r.scenario) + '</td><td>Immutable — awaiting actuals</td></tr>';
        }
        html += '</tbody></table></div>'
          + '<div class="note">' + ico('info') + '<div>Original runs are never overwritten. A '
          + 'revision is scored separately, and a change to your request dates is recorded as a '
          + 'planning decision rather than as forecast error.</div></div>';
      }
      html += '</section>';
    }

    if (tab === 'baselines') {
      const base = Recon.rollingOriginBaselines(state.ledger.transfers());
      const all = Recon.scoreBaselines(base);
      const recent = Recon.scoreBaselines(base, { from: '2026-04-01', to: '2026-08-31' });
      html += '<section class="card"><div class="card-h">' + ico('profit')
        + '<h2>Why per-payout averaging is the wrong model</h2></div>'
        + '<div class="sub">Rolling-origin baselines over historical transfers: at each point, '
        + 'predict the next transfer from earlier transfers only. These are <b>reconstructed</b> '
        + 'baselines, not forecasts saved at the time. They are shown because they demonstrate '
        + 'that averaging individual payouts cannot work when you choose the withdrawal dates '
        + 'yourself — not because the chosen-date model is expected to be this inaccurate.</div>';
      const tbl = (rows, label) => {
        let h = '<h3 style="font-size:15px;margin:20px 0 8px">' + esc(label) + '</h3>'
          + '<div class="tscroll"><table><thead><tr><th>Stream</th><th>Baseline</th>'
          + '<th class="n">N</th><th class="n">MAE</th><th class="n">WAPE</th>'
          + '<th class="n">MAPE</th><th class="n">Bias</th><th class="n">Date MAE</th>'
          + '</tr></thead><tbody>';
        for (const r of rows) {
          h += '<tr><td>' + esc(r.account) + '</td><td>' + esc(r.model) + '</td>'
            + '<td class="n">' + r.n + '</td>'
            + '<td class="n">' + esc(M.fmt(Math.round(r.mae))) + '</td>'
            + '<td class="n">' + esc(M.fmtPct(r.wape, 2)) + '</td>'
            + '<td class="n">' + esc(M.fmtPct(r.mape, 2)) + '</td>'
            + '<td class="n">' + esc(M.fmt(Math.round(r.bias))) + '</td>'
            + '<td class="n">' + r.dateMae.toFixed(2) + '</td></tr>';
        }
        return h + '</tbody></table></div>';
      };
      html += tbl(all, 'All eligible tests') + tbl(recent, 'April–August 2026');
      html += '<div class="note">' + ico('info') + '<div>Errors, not confidence intervals. No '
        + 'probability is attached to them, and no model is advertised as a winner on the same '
        + 'sample that chose it.</div></div></section>';
    }
    return html + '</div>';
  };

  /* What the last import actually did. An import that says nothing but
     "loaded" is indistinguishable from one that silently dropped every row. */
  function importReceiptBlock() {
    const li = state.lastImport;
    if (!li) return '';

    if (li.error) {
      return '<div class="note is-error">' + ico('missing') + '<div>'
        + '<b>' + esc(li.name) + ' was not imported.</b><br>' + esc(li.error)
        + (li.detail ? '<div class="meta" style="margin-top:8px">' + esc(li.detail) + '</div>' : '')
        + '</div></div>';
    }

    const r = li.receipt;
    if (!r) return '';

    const rejected = r.rejected || [];
    const cls = li.duplicate ? 'is-warn' : rejected.length ? 'is-warn' : 'is-ok';
    const kb = r.bytes == null ? null : (r.bytes / 1024).toFixed(0) + ' KB';

    let html = '<section class="card"><div class="card-h">'
      + ico(cls === 'is-ok' ? 'verified' : 'missing')
      + '<h2>' + (li.duplicate ? 'Not imported \u2014 already loaded' : 'Import receipt')
      + '</h2></div>'
      + '<div class="sub">' + esc(r.file) + (kb ? ' \u00b7 ' + esc(kb) : '') + '</div>';

    html += '<div class="tscroll"><table><tbody>';
    const row = (k, v) => '<tr><td style="width:44%">' + esc(k) + '</td><td>' + v + '</td></tr>';
    html += row('Detected report type', '<b>' + esc(r.family) + '</b>');
    html += row('Date range', r.period ? '<b>' + esc(r.period) + '</b>'
      : unavailable('readable period dates', { size: 'sm' }));
    html += row('Marketplace', r.marketplace ? esc(r.marketplace)
      : unavailable('a marketplace column', { size: 'sm' }));
    html += row('Currency', r.currency ? esc(r.currency)
      : unavailable('a currency column', { size: 'sm' }));
    if (r.columns != null) {
      html += row('Columns', esc(String(r.columns))
        + (r.headerLine ? ' \u00b7 header on line ' + esc(String(r.headerLine)) : ''));
    }
    html += row('Rows processed', r.rowsProcessed == null ? '\u2014'
      : '<b>' + r.rowsProcessed.toLocaleString() + '</b>');
    html += row('Rows accepted', r.rowsAccepted == null ? '\u2014'
      : '<b>' + r.rowsAccepted.toLocaleString() + '</b>');
    html += row('Rows rejected', rejected.length
      ? '<b>' + rejected.length.toLocaleString() + '</b>' : '0');
    if (r.stored) {
      html += row('Saved to this browser', r.stored.ok
        ? '<span class="tag is-actual">' + ico('verified', { size: 'sm' })
          + 'Committed and read back</span>'
        : '<span class="tag is-forecast">' + ico('missing', { size: 'sm' })
          + 'In memory only</span>'
          + '<div class="meta" style="margin-top:4px">' + esc(r.stored.reason || '') + '</div>');
    }
    if (r.integrity) html += row('Integrity check', esc(r.integrity));
    html += '</tbody></table></div>';

    if (rejected.length) {
      const byReason = new Map();
      for (const x of rejected) byReason.set(x.reason, (byReason.get(x.reason) || 0) + 1);
      html += '<div class="note is-warn" style="margin-top:16px">' + ico('missing') + '<div>'
        + '<b>' + rejected.length + ' rows were rejected.</b> They are listed rather than '
        + 'quietly dropped, so the difference between a short file and a mis-read one is '
        + 'visible.</div></div>';
      html += '<div class="tscroll"><table><thead><tr><th>Line</th><th>Reason</th>'
        + '<th class="wrap">Detail</th></tr></thead><tbody>';
      for (const x of rejected.slice(0, 50)) {
        html += '<tr><td>' + esc(String(x.line)) + '</td><td>' + esc(x.reason) + '</td>'
          + '<td class="wrap">' + esc(x.detail || '\u2014') + '</td></tr>';
      }
      html += '</tbody></table></div>';
      if (rejected.length > 50) {
        html += '<div class="meta" style="margin-top:8px">Showing the first 50 of '
          + rejected.length + '.</div>';
      }
    }

    for (const issue of (r.issues || [])) {
      html += '<div class="note is-warn" style="margin-top:12px">' + ico('info') + '<div>'
        + esc(issue) + '</div></div>';
    }

    /* Where this file actually landed, so a successful import is never a
       dead end on a screen that cannot use it. */
    if (!li.duplicate && li.ok) {
      const dest = r.family === 'Payments transactions'
        ? [['expenses', 'Amazon expenses'], ['profit', 'Profitability'], ['recon', 'Reconciliation']]
        : [['forecast', 'Payout forecast']];
      html += '<div class="note is-ok" style="margin-top:12px">' + ico('verified') + '<div>'
        + '<b>This data is live now on:</b> '
        + dest.map(d => esc(d[1])).join(', ') + '.'
        + '<div class="btnrow" style="margin-top:12px">'
        + dest.map(d => '<button class="btn sec" data-go="' + esc(d[0]) + '">'
          + esc('Open ' + d[1]) + '</button>').join('')
        + '</div></div></div>';
    }

    html += '</section>';
    return html;
  }

  /* The parsed contents of one imported file, so "202 rows" can be opened and
     checked against the CSV rather than taken on trust. */
  function reportView(id) {
    const imp = state.imports.find(i => i.id === id);
    if (!imp) return '';
    const p = state.previews.find(x => x.importId === id);

    let html = '<section class="card"><div class="card-h">' + ico('file')
      + '<h2>' + esc(imp.name) + '</h2></div>'
      + '<div class="sub">' + esc(imp.family) + ' · ' + esc(imp.coverage || '')
      + ' · ' + esc(imp.marketplace || 'marketplace not stated') + ' · '
      + esc(imp.currency || '') + '</div>'
      + '<div class="btnrow" style="margin-bottom:16px">'
      + '<button class="btn sec" data-viewreport="">' + ico('chevronRight', { size: 'sm' })
      + 'Close this report</button></div>';

    if (!p) {
      html += '<div class="note is-warn">' + ico('missing') + '<div>This is the transaction '
        + 'history. Its ' + (imp.rowCount || 0).toLocaleString() + ' rows drive Amazon expenses, '
        + 'Profitability and Reconciliation — open those screens to see them broken down.'
        + '</div></div></section>';
      return html;
    }

    const f = Dataset.forecastBranch([p]);
    html += '<div class="grid g4">'
      + statText('file', 'Rows accepted',
        (p.rowsAccepted || 0).toLocaleString() + ' of ' + (p.rowsProcessed || 0).toLocaleString(), null)
      + statText('file', 'Products', String(f.skuCount), null)
      + statText('file', 'Columns', String(p.columnCount), null)
      + statCard('available', 'Forecast net sales', f.netSales, null, 'AMAZON FORECAST')
      + '</div>';

    html += '<div class="tscroll" style="margin-top:20px"><table><thead><tr><th>MSKU</th>'
      + '<th>ASIN</th><th class="n">Units sold</th><th class="n">Net units</th>'
      + '<th class="n">Net sales</th><th class="n">Amazon fees</th>'
      + '<th class="n">Advertising</th></tr></thead><tbody>';
    for (const r of f.bySku.slice(0, 300)) {
      html += '<tr><td class="wrap">' + esc(r.msku) + '</td>'
        + '<td>' + esc(r.asin || '\u2014') + '</td>'
        + '<td class="n">' + (r.unitsSold == null ? '\u2014' : r.unitsSold.toLocaleString()) + '</td>'
        + '<td class="n">' + (r.netUnits == null ? '\u2014' : r.netUnits.toLocaleString()) + '</td>'
        + '<td class="n">' + amount(r.netSales) + '</td>'
        + '<td class="n">' + amount(r.orderFees == null ? null : -r.orderFees) + '</td>'
        + '<td class="n">' + amount(r.advertising == null ? null : -r.advertising) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    if (f.bySku.length > 300) {
      html += '<div class="meta" style="margin-top:8px">Showing the first 300 of '
        + f.bySku.length + ' products.</div>';
    }
    html += '</section>';

    html += forecastFeeTable(f);
    html += previewChecks(f);

    if ((p.rejected || []).length) {
      html += '<section class="card"><div class="card-h">' + ico('missing')
        + '<h2>Rows not imported</h2></div>'
        + '<div class="tscroll"><table><thead><tr><th>Line</th><th>Reason</th>'
        + '<th class="wrap">Detail</th></tr></thead><tbody>';
      for (const x of p.rejected.slice(0, 100)) {
        html += '<tr><td>' + esc(String(x.line)) + '</td><td>' + esc(x.reason) + '</td>'
          + '<td class="wrap">' + esc(x.detail || '\u2014') + '</td></tr>';
      }
      html += '</tbody></table></div></section>';
    }
    return html;
  }

  /* How many payout rules are still blank. Blank is "not verified", and
     every calculation that needs one stays unavailable until it is filled. */
  function policyUnverified(p) {
    return ['nextScheduledPayout', 'scheduleIntervalDays', 'cooldownDays',
      'partialRequestsSupported', 'scheduleResetsOnRequest', 'bankTransitDaysLow',
      'bankTransitDaysHigh'].filter(k => p[k] == null || p[k] === '').length;
  }

  /* ── the three inputs typed by hand ──────────────────────────────────
     Bank deposits, product costs and advertising billing: what the owner
     knows and Amazon's exports do not. Each form checks what it is given
     (lib/inputs.js), refuses with a reason rather than guessing, and each
     record can be removed again. They save like everything else here - to
     this computer, and to the shared copy if one is set up. */

  /* Records restored from an older backup may have no id; they are matched
     on their contents, as balances are. */
  const depKey = d => d.id || [d.date, d.amount, d.account || ''].join('|');
  const adKey = b => b.id || [b.from, b.to, b.method].join('|');
  const adWords = m => m === 'amazon_deduction' ? 'deduction from Amazon payouts'
    : (Inputs.AD_METHODS[m] || m).toLowerCase();

  /* Every MSKU the data knows about, most units first: sold in the history,
     or forecast in the previews. The one list both the costs form and the
     readiness count read, so they cannot disagree. */
  let skuMemo = null, skuKey = null;
  function knownSkus() {
    const cur = state.filters.currency;
    const key = fcEpoch + '|' + cur + '|' + (state.ledger ? state.ledger.rowCount : 0) + '|' + state.previews.length;
    if (key === skuKey && skuMemo) return skuMemo;
    const units = new Map();
    if (state.ledger) {
      for (const [sku, u] of Profit.unitsBySku(state.ledger, { currency: cur })) {
        units.set(sku, (units.get(sku) || 0) + (u.unitsSold || 0));
      }
    }
    const f = dataset().forecast;
    if (f && f.present) {
      for (const r of f.bySku) if (r.msku && !units.has(r.msku)) units.set(r.msku, r.unitsSold || 0);
    }
    skuMemo = [...units].map(([msku, n]) => ({ msku, units: n })).sort((a, b) => b.units - a.units);
    skuKey = key;
    return skuMemo;
  }
  const costedSkus = () => new Set(Inputs.costsIn(state.productCosts, state.filters.currency)
    .filter(c => c.unitCost != null).map(c => c.msku));

  function inputSaid(form) {
    const s = state.inputSaid;
    if (!s || s.form !== form) return '';
    return '<div class="note ' + (s.ok ? 'is-ok' : 'is-warn') + '" role="status">'
      + ico(s.ok ? 'verified' : 'missing') + '<div>' + esc(s.text)
      + (s.errors && s.errors.length ? '<ul class="meta" style="padding-left:18px;margin:6px 0 0">'
        + s.errors.slice(0, 8).map(x => '<li>Line ' + x.line + ' (' + esc(x.text) + '): '
          + esc(x.error) + '</li>').join('')
        + (s.errors.length > 8 ? '<li>and ' + (s.errors.length - 8) + ' more</li>' : '') + '</ul>' : '')
      + '</div></div>';
  }

  const removeBtn = (attr, id, what) => '<button class="btn sec sm" ' + attr + '="' + esc(id) + '" '
    + 'aria-label="Remove ' + esc(what) + '">' + ico('remove', { size: 'sm' }) + 'Remove</button>';
  const inCurrency = list => list.filter(r => !r.currency || !state.filters.currency
    || r.currency === state.filters.currency);
  const otherCurrency = list => list.length - inCurrency(list).length;

  function depositsCard() {
    const t = transitMeasure();
    const shown = inCurrency(state.bankDeposits).slice()
      .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    const matched = new Set();
    if (t.match) for (const m of t.match.matches) for (const d of m.deposits) matched.add(d.id);
    const acct = state.filters.account || '';
    let html = '<section class="card" id="depositsform" data-keeptyped><div class="card-h">'
      + ico('inTransit') + '<h2>Bank deposits</h2>' + (t.available ? tag('MEASURED') : '') + '</div>'
      + '<div class="sub">Each time an Amazon payout reaches your bank: the day it arrived and '
      + 'the amount. Matched to the transfers in your transaction history, they measure how long '
      + 'money really takes to arrive - and that replaces any transit days typed in by hand.</div>';
    html += '<div class="note' + (t.available ? ' is-ok' : '') + '">' + ico(t.available ? 'verified' : 'info')
      + '<div>' + (t.available
        ? '<b>Bank transit ' + esc(t.low === t.high ? t.low + ' days' : t.low + '\u2013' + t.high + ' days')
          + '</b>, ' + esc(t.basis) + '. Every expected bank date uses it.'
        : '<b>Transit is not measured yet.</b> It needs ' + esc(t.missing) + '.')
      + '</div></div>';
    html += '<div class="frow f4">'
      + '<div class="field"><label class="lbl" for="d-date">Arrived in the bank</label>'
      + '<input type="date" id="d-date" value="' + esc(state.today) + '" max="' + esc(state.today) + '"></div>'
      + '<div class="field"><label class="lbl" for="d-amount">Amount (' + esc(state.filters.currency) + ')</label>'
      + '<input type="text" inputmode="decimal" id="d-amount" placeholder="0.00" autocomplete="off"></div>'
      + '<div class="field"><label class="lbl" for="d-acct">From account stream</label>'
      + '<select id="d-acct"><option value="">Either / not sure</option>'
      + Inputs.ACCOUNTS.map(a => '<option' + (a === acct ? ' selected' : '') + '>' + esc(a) + '</option>').join('')
      + '</select></div>'
      + '<div class="field"><label class="lbl" for="d-ref">Bank reference (optional)</label>'
      + '<input type="text" id="d-ref" maxlength="120" autocomplete="off"></div></div>'
      + '<div class="btnrow"><button class="btn" id="adddeposit">' + ico('add', { size: 'sm' })
      + 'Add deposit</button></div>' + inputSaid('dep');
    if (shown.length) {
      html += '<div class="tscroll" style="max-height:360px;margin-top:14px"><table><thead><tr>'
        + '<th>Arrived</th><th class="n">Amount</th><th>Account stream</th><th>Reference</th>'
        + '<th>Matched</th><th class="act"></th></tr></thead><tbody>';
      for (const d of shown) {
        html += '<tr><td>' + esc(fmtDay(d.date)) + '</td>'
          + '<td class="n">' + amount(d.amount) + '</td>'
          + '<td>' + esc(d.account || 'Either') + '</td>'
          + '<td class="wrap">' + esc(d.reference || '\u2014') + '</td>'
          + '<td>' + (!state.ledger ? '<span class="meta">No history to match</span>'
            : matched.has(d.id) ? '<span class="tag is-ok">' + ico('verified', { size: 'sm' }) + 'Transfer found</span>'
            : '<span class="tag" title="No transfer of this amount in the 14 days before it.">No transfer found</span>')
          + '</td><td class="act">' + removeBtn('data-deldep', depKey(d), 'the deposit of ' + fmtDay(d.date)) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    const other = otherCurrency(state.bankDeposits);
    if (other) {
      html += '<div class="meta" style="margin-top:8px">' + other + ' deposit' + (other === 1 ? '' : 's')
        + ' in another currency not shown. Switch currency to see ' + (other === 1 ? 'it' : 'them') + '.</div>';
    }
    return html + '</section>';
  }

  function costsCard() {
    const cur = state.filters.currency;
    const known = knownSkus();
    const costed = costedSkus();
    const missing = known.filter(k => !costed.has(k.msku));
    const list = inCurrency(state.productCosts).slice()
      .sort((a, b) => a.msku < b.msku ? -1 : a.msku > b.msku ? 1 : (a.from || '') < (b.from || '') ? 1 : -1);
    let html = '<section class="card" id="costsform" data-keeptyped><div class="card-h">' + ico('profit')
      + '<h2>Product costs</h2>'
      + (known.length ? '<span class="tag ' + (missing.length ? 'is-warn' : 'is-ok') + '">'
        + (known.length - missing.length) + ' of ' + known.length + ' costed</span>' : '') + '</div>'
      + '<div class="sub">What one unit costs you, landed - the product, freight in and duty - by '
      + 'MSKU exactly as Amazon shows it. A cost applies from its start date until the next one for '
      + 'the same MSKU, so a price change never rewrites months already reported.</div>';
    if (missing.length) {
      html += '<div class="meta" style="margin-bottom:8px">Most sold without a cost: '
        + missing.slice(0, 8).map(k => '<button class="chip" data-costfill="' + esc(k.msku) + '" '
          + 'title="Fill in this MSKU">' + esc(k.msku) + '</button>').join(' ')
        + (missing.length > 8 ? ' <span>and ' + (missing.length - 8) + ' more</span>' : '') + '</div>';
    }
    html += '<datalist id="skulist">' + known.slice(0, 500).map(k => '<option value="' + esc(k.msku) + '">')
      .join('') + '</datalist>'
      + '<div class="frow f4">'
      + '<div class="field"><label class="lbl" for="c-msku">MSKU</label>'
      + '<input type="text" id="c-msku" list="skulist" autocomplete="off" spellcheck="false"></div>'
      + '<div class="field"><label class="lbl" for="c-cost">Unit cost (' + esc(cur) + ')</label>'
      + '<input type="text" inputmode="decimal" id="c-cost" placeholder="0.00" autocomplete="off"></div>'
      + '<div class="field"><label class="lbl" for="c-from">Applies from (optional)</label>'
      + '<input type="date" id="c-from"></div>'
      + '<div class="field"><label class="lbl" for="c-evid">Where it comes from (optional)</label>'
      + '<input type="text" id="c-evid" maxlength="160" placeholder="e.g. supplier invoice 1042" autocomplete="off"></div></div>'
      + '<div class="btnrow"><button class="btn" id="addcost">' + ico('add', { size: 'sm' }) + 'Save cost</button></div>'
      + '<details class="plain" style="margin-top:12px"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'Paste many at once from a spreadsheet</summary>'
      + '<div class="meta" style="margin:8px 0">One product per line: <code>MSKU, unit cost</code>, and '
      + 'optionally <code>, applies-from date</code> (YYYY-MM-DD). Two columns copied from a '
      + 'spreadsheet paste as they are. A header row is skipped.</div>'
      + '<textarea id="c-paste" rows="6" spellcheck="false" style="width:100%;font-family:var(--mono, monospace)" '
      + 'placeholder="ABC-123, 4.25&#10;XYZ-9, 11.80, 2026-06-01"></textarea>'
      + '<div class="btnrow" style="margin-top:8px"><button class="btn sec" id="pastecosts">Save these costs</button></div>'
      + '</details>' + inputSaid('cost');
    if (list.length) {
      html += '<div class="tscroll" style="max-height:360px;margin-top:14px"><table><thead><tr>'
        + '<th>MSKU</th><th class="n">Unit cost</th><th>Applies from</th><th>Evidence</th>'
        + '<th class="act"></th></tr></thead><tbody>';
      for (const c of list) {
        html += '<tr><td class="wrap">' + esc(c.msku) + '</td>'
          + '<td class="n">' + amount(c.unitCost) + '</td>'
          + '<td>' + (c.from ? esc(fmtDay(c.from)) : 'Always') + (c.to ? ' \u2013 ' + esc(fmtDay(c.to)) : '') + '</td>'
          + '<td class="wrap">' + esc(c.evidence || '\u2014') + '</td>'
          + '<td class="act">' + removeBtn('data-delcost', c.id || c.msku + '|' + (c.from || ''), 'the cost of ' + c.msku) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    const other = otherCurrency(state.productCosts);
    if (other) {
      html += '<div class="meta" style="margin-top:8px">' + other + ' cost' + (other === 1 ? '' : 's')
        + ' in another currency not shown.</div>';
    }
    return html + '</section>';
  }

  function adsCard() {
    const y = +state.today.slice(0, 4), m = +state.today.slice(5, 7);
    const thisFirst = y + '-' + String(m).padStart(2, '0') + '-01';
    const lastTo = CSV.addDays(thisFirst, -1);
    const lastFrom = lastTo.slice(0, 8) + '01';
    const now = Inputs.adMethodAt(state.advertisingBilling, state.today);
    const list = inCurrency(state.advertisingBilling).slice().sort((a, b) => a.from < b.from ? 1 : -1);
    let html = '<section class="card" id="adsform" data-keeptyped><div class="card-h">' + ico('expenses')
      + '<h2>Advertising billing</h2></div>'
      + '<div class="sub">How advertising was paid, period by period. Paid by card or invoice it '
      + 'leaves your bank, never your Amazon balance, and its amount belongs in profit. Deducted '
      + 'by Amazon it is already in the transactions, so it adds nothing here - but recording the '
      + 'period tells the forecast to take it out of your payouts.</div>';
    html += '<div class="note">' + ico('info') + '<div>'
      + (now ? 'Today: <b>' + esc(Inputs.AD_METHODS[now.method]) + '</b>, recorded for '
        + esc(fmtDay(now.from)) + ' \u2013 ' + esc(fmtDay(now.to)) + '.'
        : 'Nothing recorded for today. The forecast uses the latest period recorded, and says so; '
          + 'with none at all, advertising is left out of the payout forecast rather than guessed.')
      + '</div></div>';
    html += '<div class="frow f4">'
      + '<div class="field"><label class="lbl" for="a-method">Paid by</label>'
      + '<select id="a-method">'
      + Object.keys(Inputs.AD_METHODS).map(k => '<option value="' + k + '">' + esc(Inputs.AD_METHODS[k]) + '</option>').join('')
      + '</select></div>'
      + '<div class="field"><label class="lbl" for="a-from">Period from</label>'
      + '<input type="date" id="a-from" value="' + esc(lastFrom) + '"></div>'
      + '<div class="field"><label class="lbl" for="a-to">Period to</label>'
      + '<input type="date" id="a-to" value="' + esc(lastTo) + '"></div>'
      + '<div class="field"><label class="lbl" for="a-amount">Amount billed (' + esc(state.filters.currency) + ')</label>'
      + '<input type="text" inputmode="decimal" id="a-amount" placeholder="Not needed if Amazon deducted it" autocomplete="off"></div></div>'
      + '<div class="frow f2"><div class="field"><label class="lbl" for="a-evid">Evidence (optional)</label>'
      + '<input type="text" id="a-evid" maxlength="160" placeholder="e.g. card statement, Sep 2026" autocomplete="off"></div></div>'
      + '<div class="btnrow"><button class="btn" id="addads">' + ico('add', { size: 'sm' })
      + 'Save this period</button></div>' + inputSaid('ads');
    if (list.length) {
      html += '<div class="tscroll" style="max-height:320px;margin-top:14px"><table><thead><tr>'
        + '<th>Period</th><th>Paid by</th><th class="n">Amount</th><th>Evidence</th>'
        + '<th class="act"></th></tr></thead><tbody>';
      for (const b of list) {
        html += '<tr><td>' + esc(fmtDay(b.from)) + ' \u2013 ' + esc(fmtDay(b.to)) + '</td>'
          + '<td>' + esc(Inputs.AD_METHODS[b.method] || b.method) + '</td>'
          + '<td class="n">' + (b.method === 'amazon_deduction'
            ? '<span class="meta">In the transactions</span>' : amount(b.amount)) + '</td>'
          + '<td class="wrap">' + esc(b.evidence || '\u2014') + '</td>'
          + '<td class="act">' + removeBtn('data-delads', adKey(b), 'the advertising period from ' + fmtDay(b.from)) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    return html + '</section>';
  }

  /* After a save the form starts empty again, on purpose: a redraw keeps
     what was typed (see render), so a saved form has to be cleared first or
     the same entry would sit there looking unsaved. */
  function clearForm(id) {
    const f = document.getElementById(id);
    if (!f) return;
    for (const el of f.querySelectorAll('input, textarea, select')) {
      if (el.tagName === 'SELECT') for (const o of el.options) o.selected = o.defaultSelected;
      else if (el.type !== 'file' && el.type !== 'checkbox') el.value = el.defaultValue;
    }
  }

  function saved(form, text, errors) {
    state.inputSaid = { form, ok: !(errors && errors.length), text, errors: errors || null };
    bumpForecast(); persist(); render();
  }
  function refused(form, text) {
    state.inputSaid = { form, ok: false, text };
    render();
  }

  /* One place for every click the three forms can produce. Returns true
     when it handled the click. */
  function handleInputClick(e) {
    const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    const cur = state.filters.currency;

    if (e.target.closest('#adddeposit')) {
      const got = Inputs.deposit({ date: val('d-date'), amount: val('d-amount'),
        account: val('d-acct'), reference: val('d-ref'), currency: cur });
      if (got.error) { refused('dep', got.error); return true; }
      const r = got.record;
      const dup = state.bankDeposits.find(d => d.date === r.date && d.amount === r.amount
        && (d.currency || cur) === cur && (d.account || '') === (r.account || ''));
      if (dup) { refused('dep', 'A deposit of this amount on this day is already recorded. Remove '
        + 'that one first if it was wrong - two identical rows would be matched as two arrivals.'); return true; }
      state.bankDeposits.push(r);
      clearForm('depositsform');
      saved('dep', 'Saved: ' + M.fmt(r.amount) + ' arriving ' + fmtDay(r.date) + '.');
      return true;
    }
    const dd = e.target.closest('[data-deldep]');
    if (dd) {
      const id = dd.getAttribute('data-deldep');
      state.bankDeposits = state.bankDeposits.filter(d => depKey(d) !== id);
      saved('dep', 'Deposit removed.');
      return true;
    }

    const fill = e.target.closest('[data-costfill]');
    if (fill) {
      const f = document.getElementById('c-msku');
      if (f) { f.value = fill.getAttribute('data-costfill'); const c = document.getElementById('c-cost'); if (c) c.focus(); }
      return true;
    }
    if (e.target.closest('#addcost')) {
      const got = Inputs.cost({ msku: val('c-msku'), unitCost: val('c-cost'), from: val('c-from'),
        evidence: val('c-evid'), currency: cur });
      if (got.error) { refused('cost', got.error); return true; }
      const m = Inputs.mergeCosts(state.productCosts, [got.record]);
      state.productCosts = m.list;
      clearForm('costsform');
      saved('cost', (m.replaced ? 'Updated: ' : 'Saved: ') + got.record.msku + ' at '
        + M.fmt(got.record.unitCost) + ' a unit'
        + (got.record.from ? ' from ' + fmtDay(got.record.from) : '') + '.'
        + (got.rounded ? ' Rounded to the cent.' : ''));
      return true;
    }
    if (e.target.closest('#pastecosts')) {
      const p = Inputs.parseCostPaste(val('c-paste'), { currency: cur });
      if (!p.rows.length) {
        state.inputSaid = { form: 'cost', ok: false, errors: p.errors,
          text: p.errors.length ? 'Nothing was saved - no line could be read.' : 'There is nothing to save yet.' };
        render(); return true;
      }
      const m = Inputs.mergeCosts(state.productCosts, p.rows);
      state.productCosts = m.list;
      clearForm('costsform');
      saved('cost', 'Saved ' + p.rows.length + ' cost' + (p.rows.length === 1 ? '' : 's')
        + (m.replaced ? ' (' + m.replaced + ' replacing one with the same MSKU and start date)' : '') + '.'
        + (p.errors.length ? ' ' + p.errors.length + ' line' + (p.errors.length === 1 ? '' : 's')
          + ' could not be read and ' + (p.errors.length === 1 ? 'was' : 'were') + ' not saved:' : ''),
        p.errors);
      return true;
    }
    const dc = e.target.closest('[data-delcost]');
    if (dc) {
      const id = dc.getAttribute('data-delcost');
      state.productCosts = state.productCosts.filter(c => (c.id || c.msku + '|' + (c.from || '')) !== id);
      saved('cost', 'Cost removed.');
      return true;
    }

    if (e.target.closest('#addads')) {
      const got = Inputs.adBill({ method: val('a-method'), from: val('a-from'), to: val('a-to'),
        amount: val('a-amount'), evidence: val('a-evid'), currency: cur });
      if (got.error) { refused('ads', got.error); return true; }
      const r = got.record;
      const clash = state.advertisingBilling.find(b => (b.currency || cur) === cur
        && b.from <= r.to && b.to >= r.from);
      if (clash) {
        refused('ads', 'This overlaps the period already recorded for ' + fmtDay(clash.from) + ' \u2013 '
          + fmtDay(clash.to) + '. Remove that one first, so no day of advertising is counted twice.');
        return true;
      }
      state.advertisingBilling.push(r);
      clearForm('adsform');
      saved('ads', 'Saved: ' + adWords(r.method) + ' for ' + fmtDay(r.from)
        + ' \u2013 ' + fmtDay(r.to) + (r.amount != null ? ', ' + M.fmt(r.amount) : '') + '.');
      return true;
    }
    const da = e.target.closest('[data-delads]');
    if (da) {
      const id = da.getAttribute('data-delads');
      state.advertisingBilling = state.advertisingBilling.filter(b => adKey(b) !== id);
      saved('ads', 'Advertising period removed.');
      return true;
    }
    return false;
  }

  /* The seven inputs every figure stands on, each with a state that is
     measured, never assumed, and the one action that moves it forward.

     Three of them - bank deposits, product costs, advertising billing - the
     engines read but no screen can write yet. Their cards say so plainly
     instead of offering a button that leads nowhere. */
  function inputStates(ds) {
    const acct = state.filters.account || 'Standard Orders';
    const bal = latestBalance(acct);
    const cov = previewCoverage();
    const led = ds.actual && ds.actual.sourceRange;
    const unver = policyUnverified(state.policy);
    const known = knownSkus();
    const skus = known.length;
    const costedSet = costedSkus();
    const costed = skus ? known.filter(k => costedSet.has(k.msku)).length : costedSet.size;
    const tm = transitMeasure();
    const adNow = Inputs.adMethodAt(state.advertisingBilling, state.today);
    const adFwd = Inputs.adMethodForForecast(state.advertisingBilling, state.today);
    const pick = '<label class="btn sec sm" style="cursor:pointer">{L}<input type="file" '
      + 'data-filepick="1" multiple accept=".csv" hidden></label>';
    const list = [
      { name: 'Payments transaction history', status: led && led.to ? 'ready' : 'missing',
        detail: led && led.to ? 'Covers ' + fmtDay(led.from) + ' \u2013 ' + fmtDay(led.to)
          : 'What actually happened: fees charged, and how long Amazon takes to release money.',
        action: pick.replace('{L}', led && led.to ? 'Replace' : 'Import') },
      { name: 'Fees & Economics Preview',
        status: !cov ? 'missing' : cov.complete ? 'ready' : 'partial',
        detail: !cov ? 'Amazon\u2019s own forecast of what you will sell and be charged.'
          : cov.coveredDays + ' of ' + cov.totalDays + ' days in the next eight weeks covered',
        action: pick.replace('{L}', !cov ? 'Import' : cov.complete ? 'Replace' : 'Import missing windows') },
      { name: 'Current Amazon balance',
        status: !bal ? 'missing' : String(bal.observedAt).slice(0, 10) === state.today ? 'ready' : 'partial',
        detail: !bal ? 'The starting point every payout figure is projected from.'
          : 'Recorded ' + fmtDay(bal.observedAt),
        action: '<button class="btn sec sm" data-updbal="1">' + (bal ? 'Update' : 'Record balance') + '</button>' },
      { name: 'Bank deposit history',
        status: tm.available ? 'ready' : state.bankDeposits.length ? 'partial' : 'missing',
        detail: tm.available
          ? 'Transit measured: ' + (tm.low === tm.high ? tm.low : tm.low + '\u2013' + tm.high)
            + ' days, from ' + tm.n + ' matched deposits'
          : state.bankDeposits.length
            ? state.bankDeposits.length + ' recorded. Measuring transit needs ' + tm.missing + '.'
            : 'Dates when a payout really reached the bank, to measure transit time.',
        action: '<button class="btn sec sm" data-jump="depositsform">'
          + (state.bankDeposits.length ? 'Add more' : 'Add deposits') + '</button>' },
      { name: 'Payout rules', status: unver === 0 ? 'ready' : unver === 7 ? 'missing' : 'partial',
        detail: unver === 0 ? 'Every rule entered' : unver + ' of 7 not verified',
        action: '<button class="btn sec sm" data-jump="payoutrules">Review rules</button>' },
      { name: 'Product costs',
        status: !costed ? 'missing' : skus && costed < skus ? 'partial' : 'ready',
        detail: costed ? costed + (skus ? ' of ' + skus : '') + ' products costed'
          : 'What you pay for each product. Without it there is contribution, not profit.',
        action: '<button class="btn sec sm" data-jump="costsform">'
          + (costed ? 'Add or change' : 'Add costs') + '</button>' },
      { name: 'Advertising billing',
        status: adNow ? 'ready' : state.advertisingBilling.length ? 'partial' : 'missing',
        detail: adNow ? 'Paid by ' + adWords(adNow.method) + ' today'
          : adFwd ? 'Nothing recorded for today; the latest ('
            + adWords(adFwd.method) + ') is carried forward'
          : 'Whether ads come out of your payout or go on a card. The cash answers differ.',
        action: '<button class="btn sec sm" data-jump="adsform">'
          + (state.advertisingBilling.length ? 'Add a period' : 'Record billing') + '</button>' },
    ];
    for (const i of list) i.actionable = /<(button|label)\b/.test(i.action || '');
    return list;
  }

  function dataTiles(ds) {
    const inputs = inputStates(ds);
    const ready = inputs.filter(i => i.status === 'ready').length;
    const attention = inputs.filter(i => i.status !== 'ready').length;
    /* Next is an input on THIS screen, and one that can be acted on now if
       any can - pointing first at something the app cannot take is a dead
       end presented as advice. */
    const open = inputs.filter(i => i.status !== 'ready');
    const next = open.find(i => i.actionable) || open[0] || null;
    const cov = previewCoverage();
    const led = ds.actual && ds.actual.sourceRange;
    const bal = latestBalance(state.filters.account || 'Standard Orders');
    const row = (l, v, kind) => '<span class="ds-r" style="display:flex;gap:8px;align-items:center">'
      + '<span class="dot' + (kind ? ' is-' + kind : '') + '"></span>' + esc(l)
      + '<b style="margin-left:auto;font-weight:500">' + esc(v) + '</b></span>';
    return '<div class="grid g3">'
      + '<div class="tile"><div class="tile-l">Report readiness</div>'
      + '<div class="tile-v fig">' + ready + ' of ' + inputs.length + ' ready</div>'
      + '<div class="tile-m">Each input below says what it is missing</div></div>'
      + '<div class="tile"><div class="tile-l">Data freshness</div><div style="display:grid;gap:4px;margin-top:6px">'
      + row('Transactions', led && led.to ? 'to ' + fmtShortDay(led.to) : 'None', led && led.to ? 'ok' : null)
      + row('Forecast', cov ? cov.coveredDays + '/' + cov.totalDays + ' days' : 'None',
        cov ? (cov.complete ? 'ok' : 'warn') : null)
      + row('Balance', bal ? fmtShortDay(bal.observedAt) : 'None',
        bal ? (String(bal.observedAt).slice(0, 10) === state.today ? 'ok' : 'warn') : 'warn')
      + '</div></div>'
      + '<div class="tile"><div class="tile-l">Needs attention</div>'
      + '<div class="tile-v fig">' + attention + ' input' + (attention === 1 ? '' : 's') + '</div>'
      + (next ? '<div class="tile-m">Most useful next: <b>' + esc(next.name) + '</b></div>'
        + (next.actionable ? '<div class="btnrow" style="margin-top:10px">' + next.action + '</div>' : '')
        : '<div class="tile-m">Nothing outstanding</div>') + '</div>'
      + '</div>';
  }

  function inputCards(ds) {
    const TAGS = { ready: ['is-ok', 'Ready'], partial: ['is-warn', 'Partial'], missing: ['', 'Missing'] };
    let html = '<div class="grid g3">';
    for (const i of inputStates(ds)) {
      const t = TAGS[i.status];
      html += '<article class="card" style="display:flex;flex-direction:column;gap:8px;padding:20px 22px">'
        + '<div class="card-h nowrap" style="margin:0"><h2 style="font-size:var(--t-h2)">'
        + esc(i.name) + '</h2><span class="tag ' + t[0] + '">' + t[1] + '</span></div>'
        + '<div class="meta" style="flex:1">' + esc(i.detail) + '</div>'
        + (i.action ? '<div class="btnrow">' + i.action + '</div>' : '')
        + '</article>';
    }
    /* The drop zone is the eighth cell, as v3 draws it. */
    html += '<div id="drop" style="display:flex;flex-direction:column;justify-content:center">'
      + ico('upload', { size: 'lg' }) + '<h3>Drop CSV files here</h3>'
      + '<div class="meta">or <label style="color:var(--accent);cursor:pointer;text-decoration:underline">'
      + 'choose files<input type="file" id="filepick" multiple accept=".csv" hidden></label>'
      + ' \u00b7 the app detects each report</div>'
      + '<div class="bar" id="prog" hidden><i></i></div>'
      + '<div class="meta" id="progtext" style="margin-top:8px">'
      + (state.lastImport ? esc(state.lastImport.message) : '') + '</div></div>';
    return html + '</div>';
  }

  /* ---------- Data & Assumptions ---------- */
  screens.data = function () {
    if (state.viewReport) {
      const v = reportView(state.viewReport);
      if (v) return v;
      state.viewReport = null;
    }
    const ds = dataset();
    let html = '';

    /* v3: where you stand, then every input with its state and the one thing
       to do about it, then the detail. Where the data lives (the account
       panel) sits with Backup at the end, which is the same question. */
    html += dataTiles(ds);
    html += inputCards(ds);
    html += importReceiptBlock();

    /* Fetching from Amazon is what this app exists to do. v3 leaves it out of
       this screen; it stays, directly under the inputs it fills. */
    html += downloadsPanel();

    const p = state.policy;
    const unverified = policyUnverified(p);
    html += '<section class="card" id="payoutrules"><div class="card-h"><h2>Payout rules</h2>'
      + (unverified ? '<span class="tag is-warn">' + unverified + ' not verified</span>'
        : '<span class="tag is-ok">All verified</span>') + '</div>'
      + '<div class="sub">Nothing here is assumed. Every blank means a calculation that depends on '
      + 'it stays unavailable.</div>';
    html += '<div class="frow f2">'
      + '<div class="field"><label class="lbl" for="p-next">Confirmed next scheduled payout</label>'
      + '<input type="date" id="p-next" value="' + esc(p.nextScheduledPayout || '') + '"></div>'
      + '<div class="field"><label class="lbl" for="p-interval">Normal schedule interval (days)</label>'
      + '<input type="number" id="p-interval" value="'
      + esc(p.scheduleIntervalDays == null ? 14 : p.scheduleIntervalDays) + '"></div></div>'
      + '<div class="frow f3">'
      + '<div class="field"><label class="lbl" for="p-cooldown">Cooldown between requests (days)</label>'
      + '<input type="number" id="p-cooldown" value="' + esc(p.cooldownDays == null ? '' : p.cooldownDays)
      + '" placeholder="Not verified"></div>'
      + '<div class="field"><label class="lbl" for="p-partial">Partial requests supported</label>'
      + '<select id="p-partial"><option value="">Not verified</option>'
      + '<option value="yes"' + (p.partialRequestsSupported === true ? ' selected' : '') + '>Yes</option>'
      + '<option value="no"' + (p.partialRequestsSupported === false ? ' selected' : '') + '>No</option></select></div>'
      + '<div class="field"><label class="lbl" for="p-reset">Early request resets the schedule</label>'
      + '<select id="p-reset"><option value="">Not verified</option>'
      + '<option value="yes"' + (p.scheduleResetsOnRequest === true ? ' selected' : '') + '>Yes</option>'
      + '<option value="no"' + (p.scheduleResetsOnRequest === false ? ' selected' : '') + '>No</option></select></div>'
      + '</div>'
      + '<div class="frow f2">'
      + '<div class="field"><label class="lbl" for="p-transit-lo">Bank transit, fastest (days)</label>'
      + '<input type="number" id="p-transit-lo" value="'
      + esc(p.bankTransitDaysLow == null ? '' : p.bankTransitDaysLow) + '" placeholder="Not verified"></div>'
      + '<div class="field"><label class="lbl" for="p-transit-hi">Bank transit, slowest (days)</label>'
      + '<input type="number" id="p-transit-hi" value="'
      + esc(p.bankTransitDaysHigh == null ? '' : p.bankTransitDaysHigh) + '" placeholder="Not verified"></div>'
      + '</div>'
      + (transitMeasure().available
        ? '<div class="note is-ok">' + ico('verified') + '<div><b>Bank transit is measured from your '
          + 'deposits</b> (' + esc(enginePolicy().bankTransitDaysLow + '\u2013'
          + enginePolicy().bankTransitDaysHigh) + ' days). The two transit fields above are not used '
          + 'while it is.</div></div>' : '')
      + '<div class="note is-warn">' + ico('missing') + '<div>Leave the transit fields blank unless '
      + 'you are deliberately entering an estimate. Anything you type here is an <b>unvalidated '
      + 'assumption</b>, not measured behaviour — it is labelled as such wherever a bank date '
      + 'appears. Supplying real bank deposit history replaces it with a measured range.</div></div>'
      + '<button class="btn" id="savepolicy">Save the account rules</button>'
      + '<div class="note">' + ico('info') + '<div>Historical transfer spacing is deliberately not '
      + 'used to infer any of this. You have confirmed the recent cadence is your own early '
      + 'requests, so those gaps describe your decisions, not Amazon\'s schedule.</div></div></section>';


    html += recordedBalancesCard();
    html += depositsCard();
    html += costsCard();
    html += adsCard();

    html += '<section class="card"><div class="card-h">' + ico('file')
      + '<h2>Imported files</h2></div>';
    if (state.ledgerRestoreFailed) {
      html += '<div class="note is-warn">' + ico('missing') + '<div><b>The saved transaction history '
        + 'could not be restored.</b> It has been removed from the list rather than left showing as '
        + 'loaded. Drop the Payments CSV again to rebuild it.</div></div>';
    }
    if (state.previewRestoreFailed) {
      html += '<div class="note is-warn">' + ico('missing') + '<div><b>The saved forecast previews '
        + 'could not be restored.</b> Drop the Fees &amp; Economics Preview CSVs again.</div></div>';
    }
    if (!state.imports.length) {
      html += Charts.emptyState('Nothing imported yet',
        'Drop your Amazon exports above to begin. The app will say what each file unlocks.');
    } else {
      html += '<div class="tscroll"><table><thead><tr><th>File</th><th>Type</th><th>Coverage</th>'
        + '<th class="n">Rows</th><th class="n">Rejected</th><th>Market</th><th>Currency</th>'
        + '<th class="act"></th></tr></thead><tbody>';
      for (const i of state.imports) {
        const rej = (i.rejected || []).length;
        html += '<tr><td>' + esc(i.name) + '</td><td>' + esc(i.family) + '</td>'
          + '<td>' + esc(i.coverage || '—') + '</td>'
          + '<td class="n">' + (i.rowCount || 0).toLocaleString() + '</td>'
          + '<td class="n">' + (rej ? '<b>' + rej + '</b>' : '0') + '</td>'
          + '<td>' + esc(i.marketplace || '—') + '</td>'
          + '<td>' + esc(i.currency || '—') + '</td>'
          + '<td class="act">' + (state.confirmRemove === i.id
            ? '<span class="tag">Confirm below</span>'
            : '<button class="btn sec sm" data-viewreport="' + esc(i.id) + '" '
            + 'aria-label="View the data in ' + esc(i.name) + '">'
            + ico('file', { size: 'sm' }) + 'View this report\u2019s data</button>'
            + '<button class="btn sec sm" data-removeask="' + esc(i.id) + '" '
            + 'style="margin-left:8px" aria-label="Remove ' + esc(i.name) + '">'
            + ico('remove', { size: 'sm' }) + 'Remove</button>') + '</td></tr>';
        /* Its report was deleted, but these rows were not. Worth saying: the
           figures on every page still come from here, and the Reports table
           below no longer explains where they came from. */
        if (i.jobId && state.jobsListedOk
            && !state.jobs.some(j => j.jobId === i.jobId)) {
          html += '<tr class="child"><td colspan="8" class="wrap">' + ico('info', { size: 'sm' })
            + ' The report this came from has been deleted. These '
            + (i.rowCount || 0).toLocaleString() + ' rows are still here and still feed every '
            + 'page \u2014 use Remove above to clear them.</td></tr>';
        }
        /* Anything this file could not supply stays visible for as long as the
           file is loaded, not just in the receipt that scrolls away. */
        for (const issue of (i.issues || [])) {
          html += '<tr class="child"><td colspan="8" class="wrap">' + ico('info', { size: 'sm' })
            + ' ' + esc(issue) + '</td></tr>';
        }
      }
      html += '</tbody></table></div>';

      const pending = state.imports.find(i => i.id === state.confirmRemove);
      if (pending) {
        const eff = removalEffect(pending);
        html += '<div class="note is-warn">' + ico('missing') + '<div>'
          + '<b>Remove ' + esc(eff.what) + '?</b> This clears it from this browser. Your original '
          + 'CSV file is untouched and can be dropped again.'
          + (eff.alsoGoes ? '<br><br>' + esc(eff.alsoGoes) : '')
          + '<div class="btnrow" style="margin-top:12px">'
          + '<button class="btn danger" data-removeyes="' + esc(pending.id) + '">Remove it</button>'
          + '<button class="btn sec" data-removeno="1">Keep it</button></div></div></div>';
      }
      html += '<div class="btnrow" style="margin-top:12px">'
        + (state.confirmRemove === '__all__'
          ? '<button class="btn danger" data-removeyes="__all__">Yes, remove everything</button>'
          + '<button class="btn sec" data-removeno="1">Cancel</button>'
          : '<button class="btn sec" data-removeask="__all__">' + ico('remove', { size: 'sm' })
          + 'Remove all imported data</button>')
        + '</div>';
      if (state.confirmRemove === '__all__') {
        html += '<div class="note is-warn">' + ico('missing') + '<div><b>Remove every imported '
          + 'file?</b> The transaction history and all forecast previews are cleared from this '
          + 'browser. Balances, planned requests, account rules and saved forecast runs are kept — '
          + 'export a backup first if you want those too.</div></div>';
      }
    }
    html += '</section>';

    const out = Store.outstanding(checklistState());
    html += '<details class="card"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'What is still needed \u00b7 ' + out.length + '</summary><div class="body">'
      + '<div class="sub">In the order that unblocks the most. ' + out.length + ' of '
      + Store.CHECKLIST.length + ' outstanding.</div>';
    for (const item of out) {
      html += '<details><summary>' + ico('chevronRight', { size: 'sm' }) + esc(item.title) + '</summary>'
        + (item.detail ? '<p class="meta">' + esc(item.detail) + '</p>' : '')
        + '<p class="meta"><b>Unlocks:</b> ' + esc(item.unlocks) + '</p></details>';
    }
    html += '</div></details>';


    /* Technical details: the checks nobody reads on a normal day, and reaches
       for the day something looks wrong. Folded, never removed. */
    html += '<details class="card nested"><summary>' + ico('chevronRight', { size: 'sm' })
      + 'Technical details \u00b7 integrity, storage, fee hierarchy, diagnostics</summary>'
      + '<div class="body">';
    if (state.storage) {
      html += '<div class="note ' + (state.storage.available
        ? (state.storage.durable ? 'is-ok' : 'is-warn') : 'is-warn') + '">'
        + ico(state.storage.available && state.storage.durable ? 'verified' : 'missing') + '<div>'
        + (state.storage.available
          ? '<b>Storage verified'
            + (state.storage.durable ? ' and marked persistent' : '') + '.</b> '
            + 'Imports are saved in <b>this browser on this device only</b> — there is no '
            + 'account and no server, so they do not follow you to another device or another '
            + 'browser. Use Export a backup to move them.'
            + (state.storage.quota ? ' About ' + Math.round(state.storage.quota / 1048576)
              + ' MB is available.' : '')
            + (state.storage.reason ? ' ' + esc(state.storage.reason) : '')
          : '<b>Storage is not available.</b> ' + esc(state.storage.reason || '')
          + ' Everything runs in memory for this session only — export a backup before closing '
          + 'the tab.') + '</div></div>';
    }
    if (state.ledger) {
      const c = state.ledger.control;
      html += '<div class="note ' + (c.componentSumMismatch ? 'is-error' : 'is-ok') + '">'
        + ico(c.componentSumMismatch ? 'missing' : 'verified') + '<div><b>Integrity controls.</b> '
        + (c.componentSumMismatch
          ? c.componentSumMismatch + ' rows where the monetary components do not sum to the reported total.'
          : 'Every row\'s monetary components sum to its reported total, to the cent.')
        + (c.overPrecision ? ' ' + c.overPrecision + ' cells carried more than two decimal places.' : '')
        + '</div></div>';
      html += '<button class="btn sec sm" id="dupscan">Scan for repeated rows</button>';
      if (state.ledger._dupCache) {
        const d = state.ledger._dupCache;
        html += '<div class="note is-warn">' + ico('missing') + '<div><b>'
          + d.extraRows.toLocaleString() + ' rows repeat an earlier row exactly</b>, worth '
          + esc(M.fmt(d.extraCents)) + ' net, in ' + d.groups.toLocaleString() + ' groups. They are '
          + 'kept at their source multiplicity. A repeated unit-level event and a double-counted row '
          + 'look identical in a CSV, and only evidence can tell them apart — so nothing is '
          + 'deleted.</div></div>';
      }
    }

    if (state.previews.length) {
      const cov = previewCoverage();
      html += '<section class="card"><div class="card-h">' + ico('forecast')
        + '<h2>Forecast input coverage</h2></div>'
        + '<div class="sub">' + cov.coveredDays + ' of ' + cov.totalDays
        + ' days in the next eight weeks are backed by an Amazon preview.</div>';
      html += '<div class="tscroll"><table><thead><tr><th>Window</th><th class="n">Columns</th>'
        + '<th class="n">MSKUs</th><th class="n">Net sales</th>'
        + '<th class="n">FBA (parent)</th><th class="n">Storage</th></tr></thead><tbody>';
      for (const p of state.previews.slice().sort((a, b) => a.period.start < b.period.start ? -1 : 1)) {
        let ns = null;
        for (const r of p.rows) if (r.netSales != null) ns = ns == null ? r.netSales : ns + r.netSales;
        const st = Preview.familyTotal(p.rows, 'Monthly inventory storage fee');
        html += '<tr><td>' + esc(fmtDay(p.period.start)) + ' – ' + esc(fmtDay(p.period.end)) + '</td>'
          + '<td class="n">' + p.columnCount + '</td><td class="n">' + p.mskuCount + '</td>'
          + '<td class="n">' + amount(M.round(ns)) + '</td>'
          + '<td class="n">' + amount(M.round(Preview.familyTotal(p.rows, 'FBA fulfillment fees').total)) + '</td>'
          + '<td class="n">' + (st.total == null
            ? unavailable('the storage columns, absent here', { size: 'sm' })
            : amount(M.round(st.total))) + '</td></tr>';
      }
      html += '</tbody></table></div>';
      if (cov.gaps.length) {
        html += '<div class="note is-warn">' + ico('missing') + '<div><b>Gaps:</b> '
          + cov.gaps.map(g => esc(fmtDay(g.from)) + ' to ' + esc(fmtDay(g.to))).join('; ')
          + '. These days produce no forecast activity. Neighbouring windows are not stretched to '
          + 'cover them and nothing is interpolated.</div></div>';
      }
      html += '<details><summary>' + ico('info', { size: 'sm' }) + 'Fee hierarchy check</summary>'
        + '<div class="tscroll"><table><thead><tr><th>Window</th><th>Parent</th>'
        + '<th class="n">Parent total</th><th class="n">Visible children</th>'
        + '<th class="n">Difference</th></tr></thead><tbody>';
      for (const p of state.previews.slice().sort((a, b) => a.period.start < b.period.start ? -1 : 1)) {
        for (const h of Preview.hierarchy(p)) {
          if (h.parentTotal == null) continue;
          html += '<tr><td>' + esc(fmtDay(p.period.start)) + '</td><td>' + esc(h.parent) + '</td>'
            + '<td class="n">' + amount(M.round(h.parentTotal)) + '</td>'
            + '<td class="n">' + (h.childSum == null ? '—' : amount(M.round(h.childSum))) + '</td>'
            + '<td class="n">' + (h.difference == null ? '—'
              : amount(M.round(h.difference), { plus: true })) + '</td></tr>';
        }
      }
      html += '</tbody></table></div>'
        + '<div class="note">' + ico('info') + '<div>The parent total is what the forecast uses. '
        + 'Components explain it and are never added on top. Where the parent is smaller than its '
        + 'visible parts, the signed difference is displayed rather than allocated away.</div></div>'
        + '</details></section>';
    }

    /* Diagnostics. Nobody opens these on a normal day; they are what you
       reach for when a download failed or the helper went quiet. */
    html += '<h3 style="font-size:var(--t-h3);margin:6px 0 12px">If something is not working</h3>'
      + selfTestCard()
      + downloadTestCard();

    html += '</div></details>';

    html += syncPanel();
    html += '<section class="card"><div class="card-h">' + ico('download')
      + '<h2>Backup</h2></div>'
      + '<div class="sub">Everything entered by hand, every snapshot and every saved forecast run. '
      + 'Includes transaction rows and parsed forecasts. Keep this financial backup private; no Amazon sessions or helper tokens are exported.</div>'
      + '<div class="btnrow"><button class="btn" id="exportbtn">' + ico('download', { size: 'sm' })
      + 'Export a backup</button>'
      + '<label class="btn sec" style="cursor:pointer">Restore a backup'
      + '<input type="file" id="restorepick" accept=".json" hidden></label></div>'
      + (state.exportStatus ? '<div class="note ' + (state.exportStatus.bad ? 'is-warn' : 'is-ok') + '">'
        + ico(state.exportStatus.bad ? 'missing' : 'verified') + '<div>'
        + esc(state.exportStatus.msg) + '</div></div>' : '')
      + (state.exportText ? '<div class="field" style="margin-top:12px">'
        + '<label class="lbl" for="exporttext">Backup contents — select all and copy</label>'
        + '<textarea id="exporttext" rows="8" readonly>' + esc(state.exportText) + '</textarea></div>' : '')
      + '</section>';

    return html;
  };

  /* ── Ask Claude ──────────────────────────────────────────────────────── */

  const SUGGESTED = [
    'Explain this payout estimate.',
    'What changes if we request a payout today?',
    'Which Amazon expenses increased?',
    'What information is missing?',
  ];

  /* The brief is built from what the engines actually computed. Claude is given
     the figures and the gaps, and told not to produce any number that is not
     here — the financial engine stays the only source of arithmetic. */
  function buildBrief() {
    const account = state.filters.account || 'Standard Orders';
    const reqDate = state.requestDate || CSV.addDays(state.today, 1);
    const { run, balance, err } = runFor(account, reqDate);
    const L = [];
    L.push('APPLICATION: Amazon cash availability and early-payout planner.');
    L.push('TODAY: ' + state.today + '. ACCOUNT STREAM: ' + account + '. CURRENCY: '
      + state.filters.currency + '.');
    L.push('');
    L.push('CHOSEN REQUEST DATE: ' + reqDate);
    if (err) {
      L.push('ELIGIBLE AMOUNT: UNAVAILABLE. Missing input: ' + err.missing);
    } else {
      const br = run.bridges[0];
      L.push('ELIGIBLE TO REQUEST: ' + M.fmt(br.eligible) + ' (MODEL FORECAST)');
      L.push('PAYOUT BRIDGE:');
      for (const l of br.lines) if (l.amount) L.push('  ' + l.label + ': ' + M.fmt(l.amount));
      L.push('  = Eligible: ' + M.fmt(br.eligible));
      L.push('STILL DEFERRED (shown for context, NOT subtracted from the bridge): '
        + (br.stillDeferred == null ? 'unavailable' : M.fmt(br.stillDeferred)));
      L.push('AFTER THIS REQUEST, AVAILABLE BECOMES: ' + M.fmt(run.ending.available));
      L.push('EXPECTED BANK ARRIVAL: ' + (br.expectedBankReceipt && br.expectedBankReceipt.date
        ? br.expectedBankReceipt.date
        : 'UNAVAILABLE — ' + ((br.expectedBankReceipt && br.expectedBankReceipt.missing) || 'no bank history')));
      for (const w of br.warnings || []) L.push('WARNING: ' + w);
    }
    L.push('');
    if (balance) {
      L.push('CURRENT BALANCES (as observed ' + balance.observedAt + ', entered by hand):');
      L.push('  available: ' + (balance.available == null ? 'unavailable' : M.fmt(balance.available)));
      L.push('  deferred: ' + (balance.deferred == null ? 'unavailable' : M.fmt(balance.deferred)));
      L.push('  reserve: ' + (balance.reserve == null ? 'unavailable' : M.fmt(balance.reserve)));
      L.push('  in transit: ' + (balance.inTransit == null ? 'unavailable' : M.fmt(balance.inTransit)));
    } else {
      L.push('CURRENT BALANCES: NONE RECORDED. Every payout figure is therefore unavailable.');
    }

    if (state.ledger) {
      const r = state.ledger.dateRange();
      const s = state.ledger.summary();
      L.push('');
      L.push('TRANSACTION HISTORY: ' + state.ledger.rowCount.toLocaleString() + ' rows, '
        + r.from + ' to ' + r.to + ' (ACTUAL).');
      L.push('  net revenue incl. shipping and promotions: ' + M.fmt(s.netRevenue));
      L.push('  transfers out: ' + M.fmt(-s.transfers));
      L.push('  non-transfer net activity: ' + M.fmt(s.nonTransferNet));
      L.push('  NOTE: the extract net movement is NOT a current balance.');
      const cats = state.ledger.componentTotals(state.filters);
      L.push('EXPENSE CATEGORIES (charges / credits / net):');
      for (const [n, c] of cats) {
        if (n === Tax.CAT.REVENUE || n === Tax.CAT.TAX || n === Tax.CAT.TRANSFER) continue;
        L.push('  ' + n + ': ' + M.fmt(c.debit) + ' / ' + M.fmt(c.credit) + ' / ' + M.fmt(c.net));
      }
      const months = state.ledger.monthly();
      L.push('MONTHLY (month, net revenue, advertising deducted by Amazon, transfers out):');
      for (const m of months) {
        L.push('  ' + m.month + ': ' + M.fmt(m.netRevenue) + ', ' + M.fmt(m.ads) + ', ' + M.fmt(-m.transfers));
      }
    } else {
      L.push('TRANSACTION HISTORY: not loaded.');
    }

    if (state.previews.length) {
      const cov = previewCoverage();
      L.push('');
      L.push('FORECAST INPUTS: ' + state.previews.length + ' Fees & Economics Preview files '
        + '(AMAZON FORECAST). Coverage ' + cov.coveredDays + '/' + cov.totalDays + ' days.');
      if (cov.gaps.length) {
        L.push('  GAPS (no forecast activity, nothing interpolated): '
          + cov.gaps.map(g => g.from + '..' + g.to).join('; '));
      }
    }

    const out = Store.outstanding(checklistState());
    L.push('');
    L.push('MISSING INPUTS, most blocking first:');
    for (const i of out) L.push('  - ' + i.title + ' — unlocks: ' + i.unlocks);

    L.push('');
    L.push('POLICY FLAGS (null means NOT VERIFIED and must be treated as unknown):');
    L.push('  cooldownDays: ' + state.policy.cooldownDays);
    L.push('  partialRequestsSupported: ' + state.policy.partialRequestsSupported);
    L.push('  nextScheduledPayout: ' + state.policy.nextScheduledPayout);
    const pol = enginePolicy();
    L.push('  bank transit: ' + (pol.bankTransitDaysLow == null ? 'unknown'
      : pol.bankTransitDaysLow + '-' + pol.bankTransitDaysHigh + ' days ('
        + (pol.transitMeasured ? pol.source : 'typed in by hand, unvalidated') + ')'));
    return L.join('\n');
  }

  const ASK_SYSTEM =
    'You explain an Amazon cash-planning app to its owner. You are given a BRIEF containing '
    + 'every figure the application has computed, plus the inputs it is missing.\n\n'
    + 'Rules you must follow:\n'
    + '1. Use ONLY numbers that appear in the BRIEF. Never calculate a new figure, never '
    + 'estimate, never fill a gap with a plausible number.\n'
    + '2. If the BRIEF says a value is UNAVAILABLE or NOT VERIFIED, say so plainly and name the '
    + 'input needed. Do not guess around it.\n'
    + '3. Name the origin of figures you cite (actual, current, Amazon forecast, model forecast, '
    + 'assumption) and point to where in the app they come from.\n'
    + '4. Requesting a payout early moves cash forward. It never creates revenue, never releases '
    + 'deferred funds sooner, and never changes profit. Do not imply otherwise.\n'
    + '5. Be concise and concrete. Plain language, no hedging filler.';

  /* Ask Claude runs in the desktop shell, which holds the key; the page
     only ever sees whether one is connected. */
  const desktopClaude = () => (window.desktopShell && window.desktopShell.claude) || null;

  function askConnectView(body, foot) {
    const s = state.ask.status || {};
    body.innerHTML = '<div class="note">' + ico('info') + '<div>'
      + '<b>Connect Claude with your own Anthropic API key.</b> Answers come from Claude Opus 5, '
      + 'using only the figures this app has worked out - it is told never to invent one.'
      + '<br><br>Each question is charged to your Anthropic API credit, typically a few US '
      + 'cents. That credit is separate from any Claude.ai subscription.'
      + '<br><br>If Claude Opus 5 declines a question for safety reasons, Anthropic retries it '
      + 'on another Claude model automatically, and the answer says when that happened.</div></div>'
      + (s.sdk === false ? '<div class="note is-warn">' + ico('missing') + '<div>This copy of the '
        + 'app is missing the Anthropic library. Update the app, then connect.</div></div>' : '')
      + (state.ask.connectError ? '<div class="note is-warn" role="status">' + ico('missing')
        + '<div>' + esc(state.ask.connectError) + '</div></div>' : '')
      + '<p class="meta">What it will answer, from this app\'s verified figures:</p>'
      + '<div class="suggest">'
      + SUGGESTED.map(q => '<button type="button" disabled style="opacity:.55;cursor:not-allowed">'
        + esc(q) + '</button>').join('') + '</div>';
    foot.innerHTML = '<div class="field" style="margin:0">'
      + '<label class="lbl" for="askkey">Anthropic API key</label>'
      + '<input id="askkey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-ant-\u2026"'
      + (state.ask.connectBusy ? ' disabled' : '') + '></div>'
      + '<div class="btnrow" style="margin-top:8px">'
      + '<button class="btn" id="askconnect"' + (state.ask.connectBusy || s.sdk === false ? ' disabled' : '') + '>'
      + (state.ask.connectBusy ? 'Checking the key\u2026' : 'Connect') + '</button>'
      + '<a class="btn sec" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">'
      + 'Get a key</a></div>'
      + '<p class="meta" style="margin:8px 0 0">Kept on this computer only, encrypted for your '
      + 'Windows account. The app never shows it again and sends it nowhere but Anthropic.</p>';
  }

  function askPanel() {
    const body = $('#askbody'), foot = $('#askfoot');
    if (!body) return;

    if (state.ask.mode === 'desktop' && !state.ask.available) {
      askConnectView(body, foot);
      return;
    }

    if (state.ask.available === false) {
      /* The suggestions still show, disabled, so it is clear what the panel
         would answer — but nothing is simulated in place of a real reply. */
      body.innerHTML = '<div class="note is-warn">' + ico('missing')
        + '<div><b>Claude is not connected here.</b> This panel needs the assistant capability, '
        + 'which this view has not granted. Nothing is simulated — rather than show an invented '
        + 'answer, the panel stays off.<br><br>Ask Claude works in the desktop app, where your '
        + 'API key stays encrypted on this computer.</div></div>'
        + '<p class="meta">What it would answer, from this app\'s verified figures:</p>'
        + '<div class="suggest">'
        + SUGGESTED.map(q => '<button type="button" disabled style="opacity:.55;cursor:not-allowed">'
          + esc(q) + '</button>').join('') + '</div>';
      foot.innerHTML = '';
      return;
    }

    let html = '';
    if (state.ask.note && !state.ask.turns.length) {
      html += '<div class="note is-ok" role="status">' + ico('verified') + '<div>'
        + esc(state.ask.note) + '</div></div>';
    }
    if (!state.ask.turns.length) {
      html += '<p class="meta">Claude answers from the figures this app has computed, names its '
        + 'assumptions, and says when something is unavailable rather than guessing.</p>'
        + '<div class="suggest">'
        + SUGGESTED.map(q => '<button type="button" data-askq="' + esc(q) + '">'
          + esc(q) + '</button>').join('') + '</div>';
    }
    for (const t of state.ask.turns) {
      if (t.role === 'you') html += '<div class="turn you">' + esc(t.text) + '</div>';
      else {
        html += '<div class="turn claude"><div class="who">'
          + '<svg class="ic ic-sm" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">'
          + '<path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z"/></svg>'
          + 'Claude</div>' + esc(t.text)
          + (t.meta ? '<div class="meta" style="margin-top:6px;font-size:var(--t-tag)">' + esc(t.meta) + '</div>' : '')
          + '</div>';
      }
    }
    if (state.ask.busy) html += '<div class="turn claude"><span class="meta">Thinking…</span></div>';
    if (state.ask.error) {
      html += '<div class="note is-warn">' + ico('missing') + '<div>' + esc(state.ask.error) + '</div></div>';
    }
    body.innerHTML = html;
    body.scrollTop = body.scrollHeight;

    foot.innerHTML = '<div class="field" style="margin:0">'
      + '<label class="lbl" for="askinput">Ask about your cash position</label>'
      + '<textarea id="askinput" rows="2" placeholder="Ask a question…"></textarea></div>'
      + '<div class="btnrow" style="margin-top:8px">'
      + '<button class="btn" id="asksend"' + (state.ask.busy ? ' disabled' : '') + '>Send</button>'
      + (state.ask.turns.length ? '<button class="btn sec" id="askclear">Clear</button>' : '')
      + '</div>'
      + (state.ask.mode === 'desktop' && state.ask.status
        ? '<p class="meta" style="margin:8px 0 0;font-size:var(--t-tag)">Claude Opus 5 \u00b7 key '
          + esc(state.ask.status.keyHint || 'connected')
          + ' \u00b7 <button type="button" class="linkbtn" id="askforget" '
          + 'style="background:none;border:0;padding:0;color:var(--accent);cursor:pointer;font:inherit">'
          + 'Disconnect</button></p>' : '');
  }

  async function connectClaude() {
    const dc = desktopClaude();
    const f = $('#askkey');
    const key = f ? f.value.trim() : '';
    if (!dc || state.ask.connectBusy) return;
    state.ask.connectBusy = true; state.ask.connectError = null;
    askPanel();
    let r;
    try { r = await dc.connect(key); } catch (e) { r = { ok: false, error: e && e.message }; }
    state.ask.connectBusy = false;
    if (r && r.ok) {
      state.ask.status = r; state.ask.available = true;
      state.ask.turns = []; state.ask.error = null;
      state.ask.note = r.detail || null;
    } else {
      /* The key is not put back in the field: a credential left sitting in a
         form is how it ends up in a screenshot. */
      state.ask.connectError = (r && r.error) || 'The key could not be connected.';
    }
    askPanel();
    if (r && r.ok) { const i = $('#askinput'); if (i) i.focus(); }
  }

  async function forgetClaude() {
    const dc = desktopClaude();
    if (!dc) return;
    try { state.ask.status = await dc.forget(); } catch (e) { /* the status call below says */ }
    state.ask.available = false; state.ask.turns = []; state.ask.error = null;
    state.ask.connectError = null;
    askPanel();
  }

  async function ensureAsk() {
    if (state.ask.checked) return state.ask.available;
    state.ask.checked = true;
    const dc = desktopClaude();
    if (dc) {
      state.ask.mode = 'desktop';
      try {
        state.ask.status = await dc.status();
        state.ask.available = !!(state.ask.status && state.ask.status.connected);
      } catch (e) { state.ask.status = null; state.ask.available = false; }
      askPanel();
      return state.ask.available;
    }
    state.ask.mode = 'artifact';
    try {
      if (window.claude && typeof window.claude.use === 'function') {
        state.ask.sample = await window.claude.use('sample');
        state.ask.available = !!state.ask.sample;
      } else state.ask.available = false;
    } catch (e) { state.ask.available = false; }
    askPanel();
    return state.ask.available;
  }

  async function askClaude(question) {
    if (!question) return;
    state.ask.turns.push({ role: 'you', text: question });
    state.ask.busy = true; state.ask.error = null;
    askPanel();

    const ok = await ensureAsk();
    if (!ok) { state.ask.busy = false; askPanel(); return; }

    if (state.ask.mode === 'desktop') {
      /* Earlier questions and answers go back as context; the one just asked
         goes as the question. The rules live in the shell, not here. */
      const prior = state.ask.turns.slice(0, -1).filter(t => t.text)
        .map(t => ({ role: t.role === 'you' ? 'user' : 'assistant', text: t.text }));
      let brief = '';
      try { brief = buildBrief(); } catch (e) { brief = ''; }
      const turn = { role: 'claude', text: '' };
      state.ask.turns.push(turn);
      let res;
      try {
        res = await desktopClaude().ask({ brief, question, history: prior },
          text => { turn.text = text; askPanel(); });
      } catch (e) { res = { ok: false, error: e && e.message }; }
      if (res && res.ok) {
        turn.text = res.text || turn.text;
        const u = res.usage || {};
        turn.meta = (res.fellBack ? 'Answered by ' + res.model + ' after Claude Opus 5 declined'
          : 'Claude Opus 5') + ' \u00b7 ' + (u.input || 0).toLocaleString() + ' tokens in, '
          + (u.output || 0).toLocaleString() + ' out'
          + (res.truncated ? ' \u00b7 cut off at the length limit' : '');
      } else {
        state.ask.turns.pop();
        state.ask.error = (res && res.error) || 'Claude could not answer.';
        if (res && (res.code === 'not_connected' || res.code === 'auth')) {
          state.ask.available = false; state.ask.checked = false;
          state.ask.connectError = res.error;
        }
      }
      state.ask.busy = false;
      askPanel();
      return;
    }

    const prompt = ASK_SYSTEM + '\n\n=== BRIEF ===\n' + buildBrief()
      + '\n=== END BRIEF ===\n\nQuestion: ' + question;
    const turn = { role: 'claude', text: '' };
    state.ask.turns.push(turn);
    try {
      const res = await state.ask.sample(prompt, {
        modelTier: 'default',
        onText: ({ text }) => { turn.text = text; askPanel(); },
      });
      turn.text = res.text || turn.text;
    } catch (err) {
      const code = err && err.code;
      state.ask.turns.pop();
      state.ask.error = code === 'not_granted'
        ? 'Claude was not granted permission in this view, so the panel stays off rather than '
        + 'showing a simulated answer.'
        : code === 'rate_limited' ? 'Too many questions just now — wait a moment and try again.'
          : 'Claude could not answer (' + (code || 'unknown error') + ').';
    }
    state.ask.busy = false;
    askPanel();
  }

  function toggleAsk(open) {
    state.ask.open = open;
    const el = $('#ask');
    el.hidden = !open;
    el.setAttribute('data-open', String(open));
    let scrim = $('#scrim');
    if (open) {
      if (!scrim && window.innerWidth < 1000) {
        scrim = document.createElement('div');
        scrim.id = 'scrim';
        document.body.appendChild(scrim);
      }
      ensureAsk();
      askPanel();
      const ta = $('#askinput'); if (ta) ta.focus();
    } else if (scrim) scrim.remove();
  }

  /* ── removing an import ──────────────────────────────────────────────── */

  const newImportId = () => 'imp-' + Date.now().toString(36)
    + '-' + Math.random().toString(36).slice(2, 7);

  function removalEffect(rec) {
    if (!rec) return null;
    if (rec.family !== 'Payments transactions') {
      return { what: rec.coverage ? 'the forecast preview for ' + rec.coverage : 'this preview',
        alsoGoes: null };
    }
    const others = state.imports.filter(i => i.family === 'Payments transactions' && i.id !== rec.id);
    return {
      what: 'the transaction history',
      alsoGoes: others.length
        ? 'All transaction history goes with it, including ' + others.map(o => o.name).join(' and ')
        + ' — those rows share one store and cannot be separated. You would need to re-import the '
        + 'ones you want to keep.'
        : null,
    };
  }

  async function removeImport(id) {
    const rec = state.imports.find(i => i.id === id);
    if (!rec) return;
    /* Captured before the filters run, because removing the transaction
       history removes every import row that shares the ledger. */
    const gone = rec.family === 'Payments transactions'
      ? state.imports.filter(i => i.family === 'Payments transactions')
      : [rec];
    if (rec.family === 'Payments transactions') {
      state.ledger = null;
      state.ledgerRestoreFailed = false;
      state.imports = state.imports.filter(i => i.family !== 'Payments transactions');
      if (state.db) { try { await Store.del(state.db, 'ledgerBlobs', 'ledger'); } catch (e) { /* gone */ } }
    } else {
      state.previews = state.previews.filter(p => p.importId !== id);
      state.imports = state.imports.filter(i => i.id !== id);
    }
    /* Drop the account copy as well, or the next reconcile pulls it back. */
    if (state.sync && state.sync.available) {
      for (const r of gone) {
        try { await state.sync.deleteBlob('imp-' + String(r.id)); } catch (e) { /* best effort */ }
      }
    }
    state.confirmRemove = null; state.lastImport = null;
    bumpForecast(); await persist(); render();
  }

  async function removeEverything() {
    const gone = state.imports.slice();
    state.ledger = null; state.previews = []; state.imports = [];
    state.lastImport = null; state.ledgerRestoreFailed = false;
    state.previewRestoreFailed = false; state.confirmRemove = null;
    if (state.db) { try { await Store.del(state.db, 'ledgerBlobs', 'ledger'); } catch (e) { /* gone */ } }
    if (state.sync && state.sync.available) {
      for (const r of gone) {
        try { await state.sync.deleteBlob('imp-' + String(r.id)); } catch (e) { /* best effort */ }
      }
    }
    bumpForecast(); await persist(); render();
  }

  /* ── backup export ───────────────────────────────────────────────────── */

  async function exportBackup() {
    const json = JSON.stringify(Store.exportBackup(state), null, 2);
    const filename = 'amazon-cash-backup-' + state.today + '.json';
    const say = (msg, bad) => { state.exportStatus = { msg, bad: !!bad }; render(); };

    let downloads = null;
    try {
      if (window.claude && typeof window.claude.use === 'function') {
        downloads = await window.claude.use('downloads');
      }
    } catch (err) { downloads = null; }

    if (downloads) {
      try {
        const r = await downloads.save({ filename, data: json });
        say(r.status === 'delivered' ? 'Backup sent to the destination you chose.'
          : 'Backup saved as ' + filename + '.');
      } catch (err) {
        const code = err && err.code;
        if (code === 'declined') say('Backup cancelled — nothing was saved.');
        else if (code === 'rate_limited') say('A save prompt is already open. Try again in a moment.', true);
        else if (code === 'too_large') say('This backup is too large for that destination.', true);
        else say('The backup could not be saved here (' + (code || 'unknown') + ').', true);
      }
      return;
    }
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      say('Backup offered as ' + filename + '. If no download appeared, copy the text below instead.');
    } catch (err) {
      say('Saving is not available here. Copy the text below instead.', true);
    }
    state.exportText = json;
    render();
  }

  /* ── import pipeline ─────────────────────────────────────────────────── */

  /* Every import ends in a RECEIPT: what the file was taken to be, what period
     and marketplace it covers, how many rows were read, how many became data,
     and every row that did not, with its reason. "Imported" is only claimed
     after the records are committed to the store and read back. */
  async function importFile(file) {
    const setProg = (pct, text, final) => {
      const bar = $('#prog'), t = $('#progtext');
      if (bar) { bar.hidden = false; bar.firstElementChild.style.width = pct + '%'; }
      if (t) t.textContent = text;
      if (final) {
        state.lastImport = Object.assign(
          { name: file.name, message: text, at: new Date().toISOString() },
          final === true ? {} : final);
      }
    };

    const fail = (message, detail) => {
      setProg(100, message, { ok: false, error: message, detail: detail || null });
      render();
    };

    try {
      if (!file.size) {
        fail(file.name + ' is empty \u2014 0 bytes. Nothing was imported.');
        return;
      }

      const head = await file.slice(0, 262144).text();
      const headGrid = CSV.parse(head);
      const det = CSV.detect(headGrid);

      /* A content fingerprint, so the same export dropped on a second device
         is recognised as the file already held rather than imported twice. */
      const contentHash = await hashFile(file);
      const already = state.imports.find(i => i.contentHash === contentHash);
      if (already) {
        setProg(100, file.name + ' is the same file as ' + (already.name || 'one already loaded')
          + ', which was imported ' + fmtDay((already.importedAt || '').slice(0, 10))
          + '. It was not imported again.',
          { ok: false, duplicate: true });
        render();
        return;
      }

      if (det.family === 'preview') { await importPreview(file, setProg, fail, contentHash); return; }
      if (det.family === 'payments') { await importPayments(file, setProg, fail, contentHash); return; }

      /* Not recognised: say what was actually seen, so a wrong file can be told
         apart from an export whose schema has changed. */
      const firstReal = headGrid.find(r => r && r.filter(c => String(c).trim()).length > 2);
      fail(file.name + ' was not recognised as an Amazon Payments transaction export or a '
        + 'Fees & Economics Preview export. Nothing was imported.',
        firstReal
          ? 'The first substantial line had ' + firstReal.length + ' columns, starting: '
            + firstReal.slice(0, 6).map(c => String(c).slice(0, 24)).join(' | ')
          : 'No comma-separated rows were found in the first 256 KB of the file.');
    } catch (e) {
      fail('That file could not be imported: ' + (e && e.message ? e.message : String(e)),
        e && e.rejected && e.rejected.length
          ? e.rejected.slice(0, 5).map(r => 'line ' + r.line + ': ' + r.reason).join('; ')
          : null);
    }
  }

  async function importPreview(file, setProg, fail, contentHash) {
    setProg(20, 'Reading ' + file.name + '\u2026');
    const p = Preview.parse(await file.text(), { name: file.name, hash: null });

    /* An identical FILE is a duplicate and is skipped by content hash, before
       this point. A matching PERIOD is not: Amazon reissues previews for the
       same window as its estimates change, and refusing those was throwing
       away the newer forecast. A same-period import REPLACES the older one and
       says so. */
    const prior = state.previews.find(x => x.period.start === p.period.start
      && x.period.end === p.period.end);

    p.importId = newImportId();
    let replaced = null;
    if (prior) {
      replaced = state.imports.find(i => i.id === prior.importId) || null;
      state.previews = state.previews.filter(x => x !== prior);
      state.imports = state.imports.filter(i => i.id !== prior.importId);
      if (state.sync && state.sync.available) {
        try { await state.sync.deleteBlob('imp-' + String(prior.importId)); }
        catch (e) { /* best effort */ }
      }
      p.supersedes = { name: prior.name || null, importedAt: replaced && replaced.importedAt };
    }
    state.previews.push(p);
    state.imports.push({
      id: p.importId, name: file.name, family: 'Fees & Economics Preview',
      coverage: p.period.start + ' \u2192 ' + p.period.end, rowCount: p.rows.length,
      currency: p.currency, marketplace: p.store, status: 'accepted',
      importedAt: new Date().toISOString(), issues: p.issues,
      rowsProcessed: p.rowsProcessed, rowsAccepted: p.rowsAccepted, rejected: p.rejected,
      contentHash,
    });
    bumpForecast();

    setProg(85, 'Saving ' + p.rows.length + ' rows\u2026');
    const saved = await persistAndVerify('previews', p.importId);

    const receipt = receiptFor(file, p, 'Fees & Economics Preview');
    receipt.stored = saved;
    receipt.replaced = p.supersedes || null;
    setProg(100, p.rowsAccepted + ' of ' + p.rowsProcessed + ' rows imported from ' + file.name
      + ' \u00b7 ' + fmtDay(p.period.start) + ' \u2013 ' + fmtDay(p.period.end)
      + (p.supersedes ? ' \u00b7 replaced the earlier forecast for this period' : '')
      + ' \u00b7 ' + (saved.ok ? 'saved to this browser'
        : 'HELD IN MEMORY ONLY \u2014 ' + saved.reason),
      { ok: true, receipt });
    render();
  }

  async function importPayments(file, setProg, fail, contentHash) {
    const led = state.ledger || Ledger.create(200000);
    const before = led.rowCount;
    const imp = Ledger.Importer(led, { name: file.name });
    const CHUNK = 4 << 20;
    let offset = 0;
    const t0 = Date.now();
    while (offset < file.size) {
      const slice = await file.slice(offset, Math.min(offset + CHUNK, file.size)).text();
      imp.push(slice);
      offset += CHUNK;
      setProg(Math.min(90, (offset / file.size) * 90),
        imp.rowsSoFar.toLocaleString() + ' rows read\u2026');
      await new Promise(r => setTimeout(r, 0));
    }
    const rec = imp.finish();

    /* Header found but nothing under it: never report success. */
    if (!rec.rowCount) {
      if (!before) state.ledger = null;
      fail(file.name + ' has an Amazon transaction header but no data rows beneath it. '
        + 'Nothing was imported.',
        rec.headerLine > 0 ? 'The header was found on line ' + rec.headerLine + '.' : null);
      return;
    }

    state.ledger = led;
    bumpForecast();
    const range = led.dateRange();
    const id = newImportId();
    const currency = currencyFromPreamble(rec.preamble) || null;
    rec.currency = currency;
    const markets = marketplacesIn(led);
    state.imports.push({
      id, name: file.name, family: 'Payments transactions',
      coverage: range.from + ' \u2192 ' + range.to, rowCount: rec.rowCount,
      currency, marketplace: markets, status: currency ? 'accepted' : 'currency unknown — excluded from currency totals',
      importedAt: new Date().toISOString(),
      rowsProcessed: rec.rowCount, rowsAccepted: rec.rowCount, rejected: [],
      schema: rec.schema, issues: schemaIssues(rec.schema), contentHash,
    });

    setProg(95, rec.rowCount.toLocaleString() + ' rows in '
      + ((Date.now() - t0) / 1000).toFixed(1) + 's \u00b7 saving\u2026');
    const savedLedger = await persistLedger();
    const saved = await persistAndVerify('imports', id);
    const ok = savedLedger && saved.ok;

    const receipt = receiptFor(file, {
      period: { start: range.from, end: range.to },
      currency, store: markets,
      rowsProcessed: rec.rowCount, rowsAccepted: rec.rowCount, rejected: [],
      columnCount: rec.header ? rec.header.length : null,
      headerLine: rec.headerLine,
      issues: schemaIssues(rec.schema),
    }, 'Payments transactions');
    receipt.stored = { ok, reason: ok ? null
      : (saved.reason || 'the browser refused to store the transaction rows') };
    receipt.integrity = rec.control.componentSumMismatch === 0
      ? 'Every row\u2019s monetary components sum to its reported total, to the cent.'
      : rec.control.componentSumMismatch + ' rows do not balance to their reported total.';

    setProg(100, rec.rowCount.toLocaleString() + ' rows imported from ' + file.name
      + ' \u00b7 ' + fmtDay(range.from) + ' \u2013 ' + fmtDay(range.to)
      + ' \u00b7 ' + (ok ? 'saved to this browser'
        : 'HELD IN MEMORY ONLY \u2014 re-import next session'),
      { ok: true, receipt });
    render();
  }

  /* The receipt rendered on screen after every import. */
  function receiptFor(file, p, family) {
    return {
      file: file.name,
      bytes: file.size,
      family,
      period: p.period && p.period.start
        ? fmtDay(p.period.start) + ' \u2013 ' + fmtDay(p.period.end) : null,
      periodRaw: p.period || null,
      marketplace: p.store || null,
      currency: p.currency || null,
      columns: p.columnCount == null ? null : p.columnCount,
      headerLine: p.headerLine == null ? null : p.headerLine,
      rowsProcessed: p.rowsProcessed == null ? null : p.rowsProcessed,
      rowsAccepted: p.rowsAccepted == null ? null : p.rowsAccepted,
      rejected: p.rejected || [],
      issues: p.issues || [],
    };
  }

  const currencyFromPreamble = pre => {
    for (const line of pre || []) {
      const m = /All amounts in ([A-Z]{3})/.exec((line || []).join(' '));
      if (m) return m[1];
    }
    return null;
  };

  function marketplacesIn(led) {
    try {
      const seen = new Set();
      for (let i = 0; i < led.rowCount && seen.size < 6; i++) {
        const m = led.dicts.marketplace.get(led.cols.marketplace.a[i]);
        if (m) seen.add(m);
      }
      return [...seen].join(', ') || null;
    } catch (e) { return null; }
  }

  function schemaIssues(schema) {
    if (!schema || !schema.missing || !schema.missing.length) return [];
    return ['Columns this export does not carry, so anything derived from them is unavailable '
      + 'rather than zero: ' + schema.missing.join(', ')];
  }

  /* Write to the store, then READ IT BACK. Success is not claimed on the
     strength of a write nobody confirmed. */
  async function persistAndVerify(what, id) {
    if (!state.db) {
      return { ok: false, reason: (state.storage && state.storage.reason)
        || 'this browser has no storage available for this page' };
    }
    try {
      await persist();
      const rows = await Store.all(state.db, 'meta');
      const saved = rows.find(r => r.id === 'state');
      const list = saved && (what === 'previews' ? saved.previews : saved.imports);
      const found = (list || []).some(x => (x.importId || x.id) === id);
      return found ? { ok: true, reason: null }
        : { ok: false, reason: 'the write completed but the record was not found on read-back' };
    } catch (e) {
      return { ok: false, reason: e && e.message ? e.message : 'the browser refused the write' };
    }
  }

  /* Streamed, so a 78 MB export is never held as one string just to hash it. */
  async function hashFile(file) {
    const h = CSV.Hasher();
    const CH = 4 << 20;
    for (let off = 0; off < file.size; off += CH) {
      const buf = await file.slice(off, Math.min(off + CH, file.size)).arrayBuffer();
      h.push(new Uint8Array(buf));
    }
    return h.digest();
  }

  /* ── Amazon downloads via the local worker ──────────────────────── */

  /* ── one button ──────────────────────────────────────────

     "Get today's Amazon data" asks the helper for every configured report over
     that report's own natural range — the forecast looks forward, the
     transaction history looks back — then the files come back through the
     ordinary import path. */

  /* Amazon's own names in the marketplace switcher. The helper matches on
     these strings, so they must read exactly as the page does. */
  const MARKETPLACES = [
    'United States', 'Canada', 'Mexico', 'Brazil',
    'United Kingdom', 'Germany', 'France', 'Italy', 'Spain', 'Netherlands',
    'Sweden', 'Poland', 'Belgium', 'Ireland', 'Turkey',
    'United Arab Emirates', 'Saudi Arabia', 'Egypt',
    'Japan', 'Australia', 'Singapore', 'India',
  ];

  const REFRESH_WORDS = {
    connecting: 'Connecting to the helper…',
    login: 'Waiting for you to sign in to Amazon',
    downloading: 'Downloading from Amazon',
    importing: 'Importing',
    done: 'Updated',
    failed: 'Could not finish',
  };

  async function getTodaysData() {
    state.refreshPhase = 'connecting';
    state.refreshNote = null;
    render();

    /* Re-probe: the helper may have been started since the page loaded. */
    state.workerInfo = await state.worker.probe();
    if (!state.workerInfo) {
      state.refreshPhase = 'failed';
      state.refreshNote = 'The helper is not running on this computer.';
      watchForWorker();
      render();
      return;
    }
    /* The gate is "can anything be fetched", not "is everything set up".
       setupComplete means EVERY report is ready, and using it here stopped a
       report that was ready to run because a different one was not. */
    const ready = (state.workerInfo.reports || []).filter(r => r.ready);
    if (!ready.length) {
      state.refreshPhase = 'failed';
      state.refreshNote = (state.workerInfo.reports || []).length
        ? 'No report is set up yet — it is a one-time step per report. '
          + 'Open "Reports, countries and account type" below to do it.'
        : 'The helper did not return the list of reports, so there is nothing '
          + 'to fetch. Open the app from the Desktop shortcut.';
      render();
      return;
    }

    /* Countries apply only to reports that fetch one country at a time. A
       report that ticks every marketplace itself does not need the choice, so
       an empty list must not block it. */
    const needsCountries = ready.some(r => r.needsMarketplace);
    const chosen = selectedMarketplaces();
    if (needsCountries && !chosen.length) {
      state.refreshPhase = 'failed';
      state.refreshNote = 'Choose at least one country first.';
      render();
      return;
    }
    try {
      const r = await state.worker.refreshToday({
        marketplaces: chosen,
        accountType: state.accountType || 'All (Unified Reports)',
        /* The historical report follows the reporting period you are looking
           at; the forecast keeps its own forward window. */
        from: state.filters.from || null,
        to: state.filters.to || null,
      });
      const n = (r.created || []).length, running = (r.alreadyRunning || []).length;
      state.refreshPhase = 'downloading';
      const blocked = (r.notConfigured || []).length;
      /* Countries are only mentioned when a report was actually fetched per
         country. Saying "across 1 country" for a report that covers all of
         them would be wrong in the direction that matters. */
      state.refreshNote = n
        ? 'Asked Amazon for ' + n + ' report' + (n === 1 ? '' : 's')
          + (needsCountries ? ' across ' + chosen.length + ' '
            + (chosen.length === 1 ? 'country' : 'countries') : '') + '.'
          + (blocked ? ' ' + blocked + ' still '
            + (blocked === 1 ? 'needs' : 'need') + ' setting up and '
            + (blocked === 1 ? 'was' : 'were') + ' skipped.' : '')
        /* Name WHAT is running. "Already running" on its own was said
           over a job that had stopped long before, with no browser open
           and nothing for the seller to look at or do. */
        : running ? 'Already running: '
          + (r.alreadyRunning || []).map(j => (j.reportType || 'a report')
            + (j.status ? ' \u2014 ' + (Worker2.WORDS[j.status] || j.status) : ''))
            .join('; ')
          + '. Nothing was requested twice.'
          : 'Nothing to fetch.';
    } catch (e) {
      state.refreshPhase = 'failed';
      state.refreshNote = e.message;
      render();
      return;
    }
    await refreshJobs();
    render();
  }

  /* The phase shown on the button follows the jobs, so it cannot claim
     "Updated" while something is still downloading or waiting for a login. */
  function derivePhase() {
    if (!state.jobs.length) return state.refreshPhase;
    const live = state.jobs.filter(j => Worker2.TERMINAL.indexOf(j.status) < 0);
    if (live.some(j => j.status === 'login-required')) return 'login';
    if (live.some(j => j.status === 'importing')) return 'importing';
    if (live.length) return 'downloading';
    if (state.refreshPhase && state.refreshPhase !== 'failed') {
      return state.jobs.some(j => j.status === 'failed') ? 'failed' : 'done';
    }
    return state.refreshPhase;
  }

  /* When the helper is absent, look for it appearing rather than making the
     person reload. Slow on purpose: this is a poll for a local port. */
  /* Bounded: fifteen seconds, then a plain answer and three things to do.
     An indicator that spins for ever tells the reader nothing and cannot be
     distinguished from a hang. */
  const WATCH_SECONDS = 15;

  function watchForWorker() {
    if (state.workerWatch) return;
    state.watchGaveUp = false;
    let tries = 0;
    const tick = async () => {
      tries++;
      const info = await state.worker.probe();
      if (info) {
        state.workerInfo = info;
        state.workerWatch = null;
        state.watchGaveUp = false;
        state.refreshNote = 'The helper is running now.';
        render();
        return;
      }
      if (tries * 2 >= WATCH_SECONDS) {
        state.workerWatch = null;
        state.watchGaveUp = true;
        render();
        return;
      }
      state.workerWatch = setTimeout(tick, 2000);
    };
    state.workerWatch = setTimeout(tick, 2000);
    render();
  }

  function selectedMarketplaces() {
    if (state.marketplaces && state.marketplaces.length) return state.marketplaces;
    const w = state.workerInfo;
    const saved = w && w.settings && w.settings.marketplaces;
    return saved && saved.length ? saved : ['United States'];
  }

  async function saveDownloadSettings() {
    if (!state.worker || !state.workerInfo) return;
    try {
      const saved = await state.worker.saveSettings({
        marketplaces: selectedMarketplaces(),
        accountType: state.accountType || 'All (Unified Reports)',
        skuDateRange: state.skuDateRange
          || ((state.workerInfo.settings || {}).skuDateRange)
          || 'Custom date range',
        skuMarketplace: state.skuMarketplace
          || ((state.workerInfo.settings || {}).skuMarketplace) || 'US',
      });
      state.workerInfo = Object.assign({}, state.workerInfo, { settings: saved });
      state.settingsNote = null;
    } catch (e) {
      /* Swallowing this left the chip looking saved when it was not — the
         next download would then run against the wrong countries. */
      state.settingsNote = e.code === 'unauthorised'
        ? 'Your country choice was NOT saved to the helper: this page has no '
          + 'helper token. Open the app from the Desktop shortcut and try again.'
        : 'Your country choice was NOT saved to the helper (' + e.message + ').';
    }
    render();
  }

  /* Country and Account Type are separate choices: one says WHICH STORE, the
     other which order streams inside it. */
  /* ── Test connection & setup ──────────────────────────────── */

  const TEST_WORDS = {
    pass: ['is-actual', 'verified', 'Pass'],
    fail: ['is-forecast', 'missing', 'Failed'],
    'cannot-test': ['is-assumed', 'info', 'Cannot test from here'],
    'not-tested': ['is-assumed', 'asOf', 'Not tested'],
  };

  async function runSelfTest() {
    state.selfTestBusy = true;
    state.selfTest = null;
    render();

    const ctx = {
      hasClaude: !!(window.claude && typeof window.claude.use === 'function'),
      info: null,
      probe: () => (state.worker ? state.worker.probe() : Promise.resolve(null)),
      session: () => (state.worker ? state.worker.session() : Promise.resolve(null)),
      /* A real round trip: write a value, read it back, delete it. Claiming
         sync works without moving a byte would be exactly the kind of false
         success this panel exists to prevent. */
      syncProbe: async () => {
        try {
          const db = await window.claude.use('db');
          const user = await window.claude.use('user');
          if (!db) return { ok: false, reason: 'The account store is not available in this view.' };
          const uid = user ? await user.id() : null;
          if (!uid) {
            return { ok: false, reason: 'Your account could not be identified, so there is '
              + 'no private place to write to.' };
          }
          const doc = db.doc('data/users/' + uid + '/selftest');
          const stamp = 'probe-' + Date.now();
          await doc.set({ stamp, at: new Date().toISOString() });
          const back = await doc.get();
          const ok = back.exists && back.data() && back.data().stamp === stamp;
          try { await doc.delete(); } catch (e) { /* leaving it is harmless */ }
          return ok ? { ok: true }
            : { ok: false, reason: 'The write completed but read back something else.' };
        } catch (e) {
          return { ok: false, reason: (e && e.message) || 'The account store refused the write.' };
        }
      },
    };

    try {
      state.selfTest = await SelfTest.run(ctx);
    } catch (e) {
      state.selfTest = [{ id: 'error', label: 'Self-test', status: 'fail',
        detail: (e && e.message) || String(e) }];
    }
    state.selfTestBusy = false;
    render();
  }

  function selfTestCard() {
    let html = '<section class="card"><div class="card-h">' + ico('recon')
      + '<h2>Test connection &amp; setup</h2></div>'
      + '<div class="sub">Checks what this app can actually verify from where it '
      + 'is running. A check that the browser will not permit says so, rather '
      + 'than reporting a failure that is not one.</div>';

    html += '<div class="btnrow"><button class="btn" id="runselftest"'
      + (state.selfTestBusy ? ' disabled' : '') + '>'
      + ico('recon', { size: 'sm' })
      + (state.selfTestBusy ? 'Testing\u2026' : 'Test connection &amp; setup')
      + '</button></div>';

    if (!state.selfTest) {
      html += '</section>';
      return html;
    }

    const sum = SelfTest.summary(state.selfTest);
    html += '<div class="meta" style="margin:16px 0 0">'
      + sum.pass + ' passed · ' + sum.fail + ' failed · '
      + sum.cannotTest + ' cannot be tested here · '
      + sum.notTested + ' not tested</div>';

    html += '<div class="checklist" style="margin-top:8px">';
    for (const r of state.selfTest) {
      const w = TEST_WORDS[r.status] || TEST_WORDS['not-tested'];
      html += '<div class="ck" style="align-items:flex-start">'
        + '<div class="ck-i" style="color:inherit">'
        + '<span class="tag ' + w[0] + '">' + ico(w[1], { size: 'sm' })
        + esc(w[2]) + '</span></div>'
        + '<div><b>' + esc(r.label) + '</b>'
        + '<div class="meta" style="margin-top:4px">' + esc(r.detail || '') + '</div>'
        + (r.fix && r.fix.note
          ? '<div class="meta" style="margin-top:6px"><b>What to do:</b> '
            + esc(r.fix.note) + '</div>' : '')
        + '</div>'
        + '<div class="ck-a">' + (r.fix
          ? '<button class="btn sec sm" data-fix="' + esc(r.fix.kind) + '">'
            + esc(r.fix.label) + '</button>' : '') + '</div>'
        + '</div>';
    }
    html += '</div>';

    if (sum.cannotTest) {
      html += '<div class="note" style="margin-top:16px">' + ico('info') + '<div>'
        + '<b>“Cannot test from here” is not a failure.</b> Those checks need this '
        + 'page and the helper to be the same address. Open '
        + '<code>http://127.0.0.1:8765</code> — the helper serves the same app — '
        + 'and run this again.</div></div>';
    }

    html += '</section>';
    return html;
  }

  /* ── Test Amazon download ────────────────────────────────── */

  function downloadTestCard() {
    if (!state.workerInfo) return '';
    const chosen = selectedMarketplaces();
    const t = state.dlTest || {};
    const from = t.from || CSV.addDays(state.today, -13);
    const to = t.to || state.today;

    let html = '<section class="card"><div class="card-h">' + ico('download')
      + '<h2>Test Amazon download</h2></div>'
      + '<div class="sub">One report, end to end: request it, wait for Amazon to '
      + 'build it, download it, import it, and show it in the tabs.</div>';

    html += '<div class="note is-warn">' + ico('missing') + '<div>'
      + '<b>This requests a REAL report from your Amazon account.</b> It is not a '
      + 'simulation and uses no sample data. Amazon will show it in your Reports '
      + 'Repository like any other request, and it may take several minutes to '
      + 'build. Saved request tickets are reused on retry; ambiguous matching is refused.</div></div>';

    if (!state.dlTestOpen) {
      html += '<div class="btnrow"><button class="btn" id="opendltest">'
        + ico('download', { size: 'sm' }) + 'Try one download</button></div>'
        + '</section>';
      return html;
    }

    html += '<div class="frow f3">'
      + '<div class="field"><label class="lbl" for="dt-mkt">Country</label>'
      + '<select id="dt-mkt">'
      + chosen.map(m => '<option' + (m === (t.marketplace || chosen[0]) ? ' selected' : '')
        + '>' + esc(m) + '</option>').join('')
      + '</select></div>'
      + '<div class="field"><label class="lbl" for="dt-from">From</label>'
      + '<input type="date" id="dt-from" value="' + esc(from) + '"></div>'
      + '<div class="field"><label class="lbl" for="dt-to">To</label>'
      + '<input type="date" id="dt-to" value="' + esc(to) + '"></div>'
      + '</div>';
    html += '<div class="meta" style="margin-bottom:12px">A short range finishes '
      + 'faster. Two weeks is plenty to prove the whole path works.</div>';

    html += '<div class="btnrow">'
      + '<button class="btn" id="startdltest"' + (t.jobId ? ' disabled' : '') + '>'
      + ico('download', { size: 'sm' }) + 'Request this report from Amazon</button>'
      + '<button class="btn sec" id="canceldltest">Close</button></div>';

    if (t.jobId) {
      const job = state.jobs.find(j => j.jobId === t.jobId);
      const steps = [
        ['requesting', 'Requesting from Amazon'],
        ['generating', 'Amazon is building the report'],
        ['downloading', 'Downloading'],
        ['importing', 'Importing'],
        ['complete', 'Showing in your tabs'],
      ];
      const order = ['queued', 'login-required', 'requesting', 'generating',
        'downloading', 'validating', 'importing', 'complete'];
      const at = job ? order.indexOf(job.status) : -1;

      html += '<div class="checklist" style="margin-top:20px">';
      for (const [key, label] of steps) {
        const idx = order.indexOf(key);
        const done = at > idx && at >= 0;
        const now = job && (job.status === key
          || (key === 'downloading' && job.status === 'validating'));
        html += '<div class="ck"><div class="ck-i" style="color:inherit">'
          + (done ? '<span class="tag is-actual">' + ico('verified', { size: 'sm' })
            + 'Done</span>'
            : now ? '<span class="tag is-assumed">' + ico('asOf', { size: 'sm' })
              + 'Now</span>'
              : '<span class="tag">·</span>')
          + '</div><div><b>' + esc(label) + '</b></div><div class="ck-a"></div></div>';
      }
      html += '</div>';

      if (job) {
        html += '<div class="note ' + (job.status === 'complete' ? 'is-ok'
          : job.status === 'failed' ? 'is-error' : 'is-warn')
          + '" style="margin-top:16px">'
          + ico(job.status === 'complete' ? 'verified' : 'missing') + '<div>'
          + '<b>' + esc(Worker2.WORDS[job.status] || job.status) + '.</b> '
          + esc(job.lastError || job.statusDetail || '')
          + (job.status === 'login-required'
            ? ' Sign in in the Amazon window, then press Retry below.' : '')
          + '</div></div>';
        if (job.status === 'failed' || job.status === 'login-required') {
          html += '<div class="btnrow"><button class="btn" data-retry="'
            + esc(job.jobId) + '">Retry</button></div>';
        }
        if (job.status === 'complete') {
          html += '<div class="btnrow">'
            + '<button class="btn" data-go="expenses">See it in Amazon expenses</button>'
            + '<button class="btn sec" data-go="dashboard">See the dashboard</button>'
            + '</div>';
        }
      }
    }

    html += '</section>';
    return html;
  }

  async function startDownloadTest() {
    const mkt = ($('#dt-mkt') || {}).value || selectedMarketplaces()[0];
    const from = ($('#dt-from') || {}).value;
    const to = ($('#dt-to') || {}).value;
    if (!from || !to || from > to) {
      state.dlTest = Object.assign({}, state.dlTest,
        { error: 'Choose a From date on or before the To date.' });
      render();
      return;
    }
    try {
      const job = await state.worker.createJob('date-range-transactions', from, to,
        mkt, state.accountType || 'All (Unified Reports)');
      state.dlTest = { marketplace: mkt, from, to, jobId: job.jobId,
        reused: !!job.reused };
      await refreshJobs();
    } catch (e) {
      state.dlTest = Object.assign({}, state.dlTest, { error: e.message });
    }
    render();
  }

  function downloadScopeCard(w) {
    const chosen = selectedMarketplaces();
    const acct = state.accountType
      || (w.settings && w.settings.accountType) || 'All (Unified Reports)';
    const txn = (w.reports || []).find(r => r.id === 'date-range-transactions');
    const acctTypes = (txn && txn.accountTypes) || ['All (Unified Reports)'];

    let html = '<div class="frow f2" style="margin-top:4px">';
    html += '<div class="field"><label class="lbl" for="dl-acct">Account type</label>'
      + '<select id="dl-acct">'
      + acctTypes.map(t => '<option' + (t === acct ? ' selected' : '') + '>'
        + esc(t) + '</option>').join('')
      + '</select>'
      + '<div class="meta" style="margin-top:6px">Applies to the transaction '
      + 'report. The forecast has no account type.</div></div>';
    /* The marketplaces this page offers, by the code it prints beside each
       flag. ONE report covers ONE marketplace, so this is a choice rather
       than the list of tick boxes further down, which belongs to the
       transaction report and means something different there. */
    const SKU_MARKETS = [
      { code: 'US', name: 'United States' },
      { code: 'CA', name: 'Canada' },
      { code: 'MX', name: 'Mexico' },
      { code: 'BR', name: 'Brazil' },
    ];
    const skuMkt = (w.settings && w.settings.skuMarketplace) || 'US';
    html += '<div class="field">'
      + '<label class="lbl" for="dl-skumkt">SKU Economics marketplace</label>'
      + '<select id="dl-skumkt">'
      + SKU_MARKETS.map(m => '<option value="' + esc(m.code) + '"'
        + (m.code === skuMkt ? ' selected' : '') + '>'
        + esc(m.code) + ' — ' + esc(m.name) + '</option>').join('')
      + (SKU_MARKETS.some(m => m.code === skuMkt) ? ''
        : '<option selected value="' + esc(skuMkt) + '">'
          + esc(skuMkt) + '</option>')
      + '</select>'
      + '<div class="meta" style="margin-top:6px">One report covers one '
      + 'marketplace. The page lists them by code, so this is the code it '
      + 'ticks.</div></div></div>';

    html += '<div class="frow f2" style="margin-top:4px">';

    /* Amazon's own choices on that page, worded as it words them. Not free
       text: a range the page does not offer would be discovered only at the
       moment of asking. The custom one is first because it is the only one
       that uses the reporting period on this page. */
    const SKU_RANGES = ['Custom date range', 'Next 7 days', 'Next 30 days',
      'Next 120 days'];
    const skuRange = (w.settings && w.settings.skuDateRange)
      || 'Custom date range';
    html += '<div class="field">'
      + '<label class="lbl" for="dl-skurange">SKU Economics date range</label>'
      + '<select id="dl-skurange">'
      + SKU_RANGES.map(r => '<option' + (r === skuRange ? ' selected' : '') + '>'
        + esc(r) + '</option>').join('')
      + (SKU_RANGES.indexOf(skuRange) < 0
        ? '<option selected>' + esc(skuRange) + '</option>' : '')
      + '</select>'
      + '<div class="meta" style="margin-top:6px">'
      + (skuRange === 'Custom date range'
        ? 'The reporting period at the top of this page is typed into the From '
          + 'and To boxes Amazon reveals — currently <b>'
          + esc(fmtDay(state.filters.from || state.today)) + '</b> to <b>'
          + esc(fmtDay(state.filters.to || CSV.addDays(state.today, 13))) + '</b>.'
        : 'One of Amazon’s own named windows, which ignores the dates on '
          + 'this page. It is read back from the page before anything is '
          + 'requested.')
      + '</div>'
      + '</div></div>';

    html += '<div class="frow f2" style="margin-top:4px">'
      + '<div class="field"><label class="lbl">Countries</label>'
      + '<div class="meta">These apply to the transaction report, which is '
      + 'fetched once per country. The SKU Economics report has its own '
      + 'marketplace above.</div></div></div>';

    html += '<div class="mkts">';
    for (const m of MARKETPLACES) {
      const on = chosen.indexOf(m) >= 0;
      html += '<label class="mkt' + (on ? ' on' : '') + '">'
        + '<input type="checkbox" data-mkt="' + esc(m) + '"' + (on ? ' checked' : '')
        + '> ' + esc(m) + '</label>';
    }
    html += '</div>';
    html += '<div class="meta" style="margin-top:10px">Selected: <b>'
      + esc(chosen.join(', ')) + '</b></div>';
    if (state.settingsNote) {
      html += '<div class="note is-error" style="margin-top:12px">' + ico('missing')
        + '<div>' + esc(state.settingsNote) + '</div></div>';
    }
    return html;
  }

  /* ONE button.
     There used to be five on this screen: get-everything, one download per
     report, and one setup per report. They were five names for two states -
     "not set up yet" and "set up". So this is one button that reads the state
     and does the next thing, and it keeps going: setup for the first report
     runs into setup for the second, which runs into the first download. The
     individual buttons still exist, folded away, for when one report needs
     redoing on its own. */
  function startButton(w) {
    const phase = derivePhase();
    const busy = phase && ['connecting', 'login', 'downloading',
      'importing'].indexOf(phase) >= 0;
    const known = (w.reports || []).length > 0;
    const unready = (w.reports || []).filter(r => !r.ready);

    let label, note;
    if (busy) {
      label = REFRESH_WORDS[phase] || 'Working\u2026';
    } else if (!known) {
      /* An empty report list is NOT an empty to-do list. It means the helper
         has not told us yet - usually because this page has no worker token,
         so the answer was refused rather than given. Saying "Get today's
         Amazon data" here would promise something that cannot be checked. */
      label = 'Start';
      note = 'The helper has not confirmed which reports are set up. Open the '
        + 'app from the Desktop shortcut so it carries the worker token; '
        + 'without it the helper refuses to answer. Start will say what is '
        + 'missing rather than guess.';
    } else if (unready.length && unready.length < (w.reports || []).length) {
      /* Some ready, some not. Fetch what works now: being unable to set up one
         report is not a reason to withhold the other. The one that is missing
         is named, not hidden, so nothing looks complete when it is not. */
      label = 'Get today\u2019s Amazon data';
      note = 'Fetches ' + ((w.reports || []).length - unready.length)
        + ' of ' + (w.reports || []).length + ' reports. '
        + unready.map(r => r.label).join(' and ')
        + ' still needs setting up \u2014 open the panel below when you want to '
        + 'do it. Until then the tabs that depend on it will say so.';
    } else if (unready.length) {
      label = 'Start';
      note = 'Sets up ' + (unready.length === 1 ? 'the report'
        : 'both reports') + ', then fetches today\u2019s data. About a minute, '
        + 'once. A browser window opens and you click the controls this app names.';
    } else {
      label = phase === 'done' ? 'Get today\u2019s Amazon data again'
        : 'Get today\u2019s Amazon data';
      note = 'Every report you have set up, for the reporting period at the top '
        + 'of this page.';
    }

    return '<div class="btnrow" style="margin-top:16px">'
      + '<button class="btn" data-startall="1"' + (busy ? ' disabled' : '') + '>'
      + ico(busy ? 'asOf' : 'download', { size: 'sm' }) + esc(label) + '</button></div>'
      + (note ? '<div class="meta" style="margin-top:8px">' + esc(note) + '</div>' : '');
  }

  /* The chain. Pressing Start once should not mean pressing Start again three
     times. Each finished step asks what is still missing and goes there. */
  async function startAll() {
    /* Ask the helper again before acting. Acting on a cached list risks
       setting up a report that is already done, or skipping one that is not. */
    try {
      state.workerInfo = await state.worker.probe();
    } catch (e) { /* keep what we had; the check below handles an empty list */ }

    const w = state.workerInfo || {};
    if (!(w.reports || []).length) {
      state.refreshNote = 'The helper did not return the list of reports, so '
        + 'there is nothing to start. If this page was opened by typing the '
        + 'address, open it from the Desktop shortcut instead — the helper '
        + 'refuses requests that do not carry its token.';
      render();
      return;
    }

    const unready = w.reports.filter(r => !r.ready);
    /* Only walk into setup when NOTHING can be fetched yet. If one report is
       ready, fetching it beats blocking on the other one's setup. */
    if (unready.length === w.reports.length) {
      state.startChain = true;
      return chooseProfileThenSetup(unready[0].id);
    }
    state.startChain = false;
    return getTodaysData();
  }

  /* The same button as Start, in the toolbar at the top of every page. It
     calls the same startAll() and reads the same state, so the two can never
     disagree about whether there is anything to fetch. */
  function refreshButton() {
    const w = state.workerInfo || {};
    const phase = derivePhase();
    const busy = phase && ['connecting', 'login', 'downloading', 'importing'].indexOf(phase) >= 0;
    /* Not set up, or not KNOWN to be set up: offering to fetch would promise
       something this app cannot deliver yet. An empty report list means the
       helper did not answer - which is not the same as nothing being left. */
    const known = (w.reports || []).length > 0;
    const unready = (w.reports || []).filter(r => !r.ready);
    const label = busy ? REFRESH_WORDS[phase]
      : (!known || unready.length === (w.reports || []).length) ? 'Start setup'
        : phase === 'done' ? 'Updated \u00b7 get again'
          : 'Get today\u2019s Amazon data';
    return '<button class="btn" data-startall="1"' + (busy ? ' disabled' : '') + '>'
      + ico(busy ? 'asOf' : 'download', { size: 'sm' }) + esc(label) + '</button>';
  }

  /* ── in-app report setup ─────────────────────────────────── */

  /* Offer the Chrome profile you are already signed into Amazon with, so
     setup does not begin from a blank browser. */
  async function chooseProfileThenSetup(reportType) {
    let info = null;
    try { info = await state.worker.chromeProfiles(); } catch (e) { info = null; }
    if (!info || !info.profiles || !info.profiles.length) {
      return setupStart(reportType, null);        // no Chrome; blank browser
    }
    state.setup = {
      phase: 'choose-profile', reportType, recorded: [],
      chromeInfo: info,
      prompt: 'Which Chrome profile are you signed into Amazon with?',
      hint: 'The helper copies that profile’s signed-in session so Amazon does '
        + 'not ask you to log in again. Your Chrome is not changed.',
    };
    render();
  }

  async function setupStart(reportType, chromeProfile) {
    try {
      state.setup = await state.worker.setupStart(reportType, chromeProfile || null);
      pollSetup();
    } catch (e) {
      state.setup = { phase: 'error', error: e.message };
    }
    render();
  }

  function pollSetup() {
    if (state.setupPoll) clearTimeout(state.setupPoll);
    state.setupPoll = setTimeout(async () => {
      try {
        state.setup = await state.worker.setupState();
      } catch (e) { state.setup = { phase: 'error', error: e.message }; }
      render();
      if (state.setup && !state.setup.done && state.setup.phase !== 'idle') pollSetup();
    }, 1200);
  }

  async function setupAnswer(value) {
    try {
      state.setup = await state.worker.setupAnswer(value);
      pollSetup();
    } catch (e) { state.setup = { phase: 'error', error: e.message }; }
    render();
  }

  async function setupSave() {
    try {
      await state.worker.setupSave();
      state.setup = null;
      /* Re-probe before deciding what is next: what counts as "ready" is the
         helper's answer, not this page's memory of it. */
      state.workerInfo = await state.worker.probe();
    } catch (e) {
      state.setup = { phase: 'error', error: e.message };
      state.startChain = false;            // a broken step does not run on
      render();
      return;
    }

    if (state.startChain) {
      const left = ((state.workerInfo || {}).reports || []).filter(r => !r.ready);
      if (left.length) {
        render();
        return chooseProfileThenSetup(left[0].id);
      }
      state.startChain = false;
      render();
      return getTodaysData();              // everything is set up: go and get it
    }
    render();
  }

  /* An id is for code; a person needs the name Amazon uses. */
  function reportSpec(id) {
    return (((state.workerInfo || {}).reports) || []).find(r => r.id === id) || null;
  }

  function reportLabel(id) {
    const r = reportSpec(id);
    return (r && r.label) || id || 'a report';
  }

  function reportUrl(id) {
    const r = reportSpec(id);
    return (r && (r.resolvedUrl || r.url)) || '';
  }

  function setupCard() {
    const su = state.setup;
    if (!su || su.phase === 'idle') return '';
    let html = '<section class="card"><div class="card-h">' + ico('assumptions')
      /* The report's own name, not the id this code files it under.
         "fees-preview" means nothing on Amazon's site. */
      + '<h2>Setting up ' + esc(reportLabel(su.reportType)) + '</h2></div>'
      /* The page that will open, spelled out. Setup navigates here, and
         if it lands anywhere else it stops rather than record the wrong
         controls - so this is the address, checkable before you begin. */
      + (reportUrl(su.reportType)
        ? '<div class="meta" style="margin-bottom:12px">Opens '
          + '<code>' + esc(reportUrl(su.reportType)) + '</code></div>' : '');

    if (su.phase === 'error') {
      html += '<div class="note is-error">' + ico('missing') + '<div>'
        + esc(su.error || 'Setup failed.') + '</div></div>'
        + '<div class="btnrow"><button class="btn sec" id="setupcancel">Close</button></div>'
        + '</section>';
      return html;
    }

    html += '<div class="note">' + ico('info') + '<div><b>' + esc(su.prompt || '')
      + '</b>' + (su.hint ? '<div class="meta" style="margin-top:6px">' + esc(su.hint)
        + '</div>' : '') + '</div></div>';

    if (su.phase === 'choose-profile') {
      const info = su.chromeInfo || {};
      html += '<div class="frow f2"><div class="field">'
        + '<label class="lbl" for="su-prof">Chrome profile</label>'
        + '<select id="su-prof">'
        + (info.profiles || []).map(pf => '<option value="' + esc(pf.id) + '">'
          + esc(pf.name) + (pf.email ? ' — ' + esc(pf.email) : '') + '</option>').join('')
        + '<option value="">None — sign in fresh in the helper window</option>'
        + '</select></div></div>';
      if (info.chromeRunning) {
        html += '<div class="note is-warn">' + ico('missing') + '<div>'
          + 'Chrome is open right now. To copy a profile’s session you will be '
          + 'asked to close all Chrome windows for a moment — you can reopen it '
          + 'straight after.</div></div>';
      }
      html += '<div class="btnrow"><button class="btn" data-setupgo="profile">'
        + 'Continue</button>'
        + '<button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'close-chrome') {
      html += '<div class="btnrow"><button class="btn" data-setupgo="text">'
        + 'I closed Chrome — Continue</button>'
        + '<button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'login' || su.phase === 'confirm-account'
        || su.phase === 'confirm-page') {
      html += '<div class="frow f2"><div class="field">'
        + '<label class="lbl" for="su-text">A word from the page that identifies the '
        + 'account (exact name required at page confirmation)</label>'
        + '<input type="text" id="su-text" placeholder="e.g. your store name"></div></div>'
        + '<div class="btnrow"><button class="btn" data-setupgo="text">Continue</button>'
        + '<button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'date-format') {
      html += '<div class="frow f2"><div class="field">'
        + '<label class="lbl" for="su-fmt">Date format on the page</label>'
        + '<select id="su-fmt"><option>MM/DD/YYYY</option><option>YYYY-MM-DD</option>'
        + '<option>DD/MM/YYYY</option></select></div></div>'
        + '<div class="btnrow"><button class="btn" data-setupgo="fmt">Continue</button>'
        + '<button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'ask-date-range') {
      /* Typed rather than chosen from a list this side, because only the
         Amazon page knows which ranges it offers, and its wording is what the
         automation has to match. The suggestions are a convenience; the value
         is verified against the real dropdown before anything is requested. */
      html += '<div class="frow f2"><div class="field">'
        + '<label class="lbl" for="su-range">Date range, worded exactly as the '
        + 'dropdown words it</label>'
        + '<input type="text" id="su-range" list="su-ranges" '
        + 'placeholder="e.g. Next 30 days">'
        + '<datalist id="su-ranges">'
        + ['Next 30 days', 'Next 7 days', 'Last 30 days', 'Last 7 days',
           'Month to date', 'Last month']
            .map(function (r) { return '<option value="' + esc(r) + '">'; }).join('')
        + '</datalist></div></div>'
        + '<div class="btnrow"><button class="btn" data-setupgo="range">Continue</button>'
        + '<button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'ask-scope') {
      html += '<div class="btnrow"><button class="btn" data-setupgo="ack">'
        + 'The list is open — Continue</button>'
        + '<button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'ask-controls' || su.phase === 'ask-range-mode'
        || su.phase === 'ask-tag' || su.phase === 'ask-aggregation') {
      html += '<div class="btnrow">'
        + '<button class="btn" data-setupgo="yes">Yes</button>'
        + '<button class="btn sec" data-setupgo="no">No</button>'
        + '<button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'has-generate') {
      html += '<div class="btnrow">'
        + '<button class="btn" data-setupgo="gen-yes">Yes, there is one</button>'
        + '<button class="btn sec" data-setupgo="gen-no">No, it downloads directly</button>'
        + '</div>';
    } else if (su.phase === 'pick') {
      html += '<div class="meta">Waiting for your click in the Amazon window…</div>'
        + '<div class="btnrow"><button class="btn sec" id="setupcancel">Cancel</button></div>';
    } else if (su.phase === 'done') {
      html += '<div class="note is-ok">' + ico('verified') + '<div>'
        + '<b>Recorded.</b> This report can now be fetched by the daily button.'
        + '</div></div>'
        + '<div class="btnrow"><button class="btn" id="setupsave">Save it</button>'
        + '<button class="btn sec" id="setupcancel">Discard</button></div>';
    }

    if ((su.recorded || []).length) {
      html += '<div class="tscroll" style="margin-top:16px"><table><thead><tr>'
        + '<th>Control</th><th class="wrap">What was recorded</th></tr></thead><tbody>';
      for (const r of su.recorded) {
        html += '<tr><td>' + esc(r.label) + '</td><td class="wrap"><code>'
          + esc(r.selector) + '</code>' + (r.text ? ' — ' + esc(r.text) : '')
          + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }
    html += '</section>';
    return html;
  }

  /* The setup package. It ships as a published file beside this app, so the
     link works from the artifact and from a local copy alike. */
  /* The setup package travels with the app as base64 (see
     lib/installer-payload.js). A published artifact cannot serve a .zip and
     page code there cannot start a download, so the bytes are handed to the
     viewer through the downloads capability; a local copy falls back to an
     ordinary link, which works because there is no sandbox in the way. */
  async function downloadInstaller() {
    const pkg = typeof InstallerZip !== 'undefined' ? InstallerZip : null;
    if (!pkg) {
      state.refreshNote = 'The setup package is not bundled with this copy of the app. '
        + 'The files are in the worker folder beside it.';
      render();
      return;
    }

    state.refreshNote = 'Preparing the download…';
    render();

    const bin = Uint8Array.from(atob(pkg.b64), c => c.charCodeAt(0));

    try {
      if (window.claude && typeof window.claude.use === 'function') {
        const d = await window.claude.use('downloads');
        if (d) {
          await d.save({ filename: pkg.name, data: bin });
          state.refreshNote = 'Saved ' + pkg.name + '. Extract it, open the worker folder '
            + 'inside, and double-click SETUP.';
          render();
          return;
        }
      }
    } catch (e) {
      if (e && e.code === 'declined') {
        state.refreshNote = 'Download cancelled — nothing was saved.';
        render();
        return;
      }
      /* fall through to the link route */
    }

    try {
      const url = URL.createObjectURL(new Blob([bin], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = url; link.download = pkg.name;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
      state.refreshNote = 'Downloading ' + pkg.name + '. Extract it, open the worker folder '
        + 'inside, and double-click SETUP.';
    } catch (e) {
      state.refreshNote = 'This page is not allowed to save files. Ask for '
        + pkg.name + ' to be sent to you directly.';
    }
    render();
  }

  /* The shared copy, once the helper has answered.

     Read first, because it is the one every browser sees. If the helper has
     nothing yet and this browser does, that work moves up - but only after it
     has been read back and checked. "Migrated" is a claim about someone's
     financial records, and it is not made on the strength of a write that
     returned without error. */
  async function adoptHelperState() {
    if (!state.worker || !state.workerInfo) return;

    let got;
    try {
      got = await state.worker.loadState();
    } catch (e) {
      state.stateNote = 'The shared copy could not be read (' + e.message
        + '). This browser is using its own stored data.';
      return;
    }

    if (got && got.body) {
      /* The helper has the document. It wins: it is what every other browser
         on this machine is also reading. */
      applyStateDoc(M.decodeExact(got.body));
      state.stateRevision = got.revision;
      state.stateHome = 'helper';
      bumpForecast();
      /* Written back to this browser too, so the local copy does not drift
         behind the shared one and mislead if the helper later goes away. */
      try {
        if (state.db) {
          await Store.put(state.db, 'meta',
            Object.assign({ id: 'state' }, stateDoc()));
        }
      } catch (e) { /* the probe has already said storage is refusing */ }
      return;
    }

    if (!got || got.revision !== 0) {
      state.stateNote = 'The shared copy is not readable, so this browser is '
        + 'using its own stored data.';
      return;
    }

    /* The helper is reachable and holds nothing. If this browser has work,
       it moves up. If it does not, there is simply nothing to move. */
    const mine = stateDoc();
    const shape = docShape(mine);
    const anything = Object.keys(shape).some(k => shape[k] > 0);
    if (!anything) {
      state.stateHome = 'helper';
      state.stateRevision = 0;
      return;
    }

    let wrote;
    try {
      wrote = await state.worker.saveState(M.encodeExact(mine), 0, windowLabel());
    } catch (e) {
      state.stateNote = 'Your data could not be copied to the shared database ('
        + e.message + '). It is still here in this browser, unchanged.';
      return;
    }

    /* Read it back. A write that returned without error is not proof that
       what came back is what went up. */
    let back;
    try {
      back = await state.worker.loadState();
    } catch (e) {
      state.stateNote = 'Your data was sent to the shared database but could '
        + 'not be read back, so this browser is still using its own copy.';
      return;
    }

    const landed = docShape(M.decodeExact((back && back.body) || null));
    if (!sameShape(shape, landed)) {
      const differs = Object.keys(shape)
        .filter(k => shape[k] !== landed[k])
        .map(k => k + ': ' + shape[k] + ' here, ' + landed[k] + ' there');
      state.stateNote = 'The shared copy does not match what was sent ('
        + differs.join('; ') + '), so this browser is still using its own '
        + 'data. Nothing was deleted.';
      return;
    }

    state.stateHome = 'helper';
    state.stateRevision = back.revision;
    state.stateNote = 'Your data now lives in the shared database — '
      + shape.imports + ' imported '
      + (shape.imports === 1 ? 'file' : 'files') + ' and '
      + shape.previewRows.toLocaleString() + ' rows, checked after writing. '
      + 'Every browser on this computer reads the same copy now.';
  }

  async function workerBoot() {
    if (typeof Worker2 === 'undefined') return;
    state.worker = Worker2.create();
    state.workerInfo = await state.worker.probe();
    if (state.workerInfo) {
      /* Before the jobs, so the catch-up import decides what to fetch against
         the shared copy rather than against this browser's older one. */
      await adoptHelperState();
      render();
      await refreshJobs();
      await loadMirror();
    }
    render();
  }

  async function refreshJobs() {
    if (!state.worker || !state.workerInfo) return;
    try {
      const r = await state.worker.listJobs();
      state.jobs = r.jobs || [];
      /* Whether this list can be trusted to be COMPLETE. An empty list because
         the helper is unreachable looks exactly like an empty list because
         every report was deleted, and one of those must not be read as the
         other. */
      state.jobsListedOk = true;
    } catch (e) { state.jobs = []; state.jobsListedOk = false; return; }

    /* A job whose file is ready is imported through the ordinary pipeline, so
       a download and a manual drop cannot diverge.

       "Complete" is recorded on the HELPER, which every browser shares. The
       parsed data lives in THIS browser. So a report imported in one browser
       is marked done for all of them, and a second browser - or the same one
       after its storage was cleared, or a different device - would show
       "Nothing imported yet" over a job that says it imported 208 rows.

       So the question asked here is not "did the helper import this", it is
       "does THIS browser have it". The helper keeps the file, so anything
       missing can simply be fetched again. */
    const haveHere = id => state.imports.some(r => r.jobId === id);
    for (const j of state.jobs) {
      const waiting = j.status === 'importing';
      const doneElsewhere = j.status === 'complete' && j.filePath && !haveHere(j.jobId);
      if ((!waiting && !doneElsewhere) || j._taken) continue;
      j._taken = true;
      try {
        const file = await state.worker.fetchFile(j);
        state.lastImport = null;
        await importFile(file);
        const imported = state.lastImport;
        const hash = await hashFile(file);
        const savedRec = state.imports.find(r => r.contentHash === hash);
        if (!savedRec || !(imported && (imported.duplicate || (imported.ok && imported.receipt && imported.receipt.stored.ok)))) {
          throw new Error((imported && imported.error) || 'Import was not verified in persistent storage.');
        }
        /* Freshness is about the fetch, not about the app being opened. */
        const rec = savedRec;
        if (rec.family === 'Payments transactions' && !await persistLedger()) throw new Error('Transaction storage could not be verified.');
        if (rec) {
          rec.fetchedAt = new Date().toISOString();
          rec.jobId = j.jobId;
          rec.source = 'amazon-download';
          /* Keep what the download knew that the CSV may not say: which store
             it came from, which streams, and the range that was asked for. */
          if (j.marketplace) rec.marketplace = rec.marketplace || j.marketplace;
          if (j.accountType) rec.accountStream = j.accountType;
          if (j.reportTag) rec.reportTag = j.reportTag;
          if (j.coverageFrom) rec.requestedFrom = j.coverageFrom;
          if (j.coverageTo) rec.requestedTo = j.coverageTo;
        }
        const savedMeta = await persistAndVerify('imports', rec.id);
        if (!savedMeta.ok) throw new Error(savedMeta.reason);
        const li = state.lastImport || {};
        if (j.status === 'importing') {
          await state.worker.markImported(j.jobId, {
            rowsAccepted: li.receipt ? li.receipt.rowsAccepted : null,
            rowsProcessed: li.receipt ? li.receipt.rowsProcessed : null,
          });
        }

        /* Into the archive, so these figures outlive this browser.
           AFTER the import has been verified, never before: the archive is a
           record of what was accepted, and recording something that failed to
           import would make it a record of a guess.
           Preview rows only for now. The transaction ledger is a different
           shape and can run to tens of megabytes; it needs its own table
           rather than being forced through this one. */
        const parsed = state.previews.find(pv => pv.importId === rec.id);
        if (parsed && parsed.rows && parsed.rows.length) {
          try {
            const put = await state.worker.archiveRows(
              j.jobId, M.encodeExact(parsed.rows), M.SCALE);
            rec.archivedRows = put && put.rowsStored;
            if (put && put.rowsStored) refreshMirrorSoon();
          } catch (e) {
            /* A record of the work is never the work. The import stands. */
            rec.archiveError = e && e.message ? e.message : String(e);
          }
        }
        /* A job already marked complete stays complete: this browser has
           simply caught up with what the helper already knew. */
      } catch (e) {
        state.lastImport = { ok: false, error: e.message,
          message: 'Download is retained by the helper. Import failed: ' + e.message };
        /* Only a job that was WAITING to be imported can fail at it. One that
           the helper already completed is being copied into this browser; if
           that does not work, the helper's record is still true and must not
           be overwritten with a failure. */
        if (j.status === 'importing') {
          try {
            await state.worker.markImportFailed(j.jobId, e.message);
          } catch (_) { /* keep the visible error */ }
        }
      }
    }

    const busy = state.jobs.some(j => Worker2.TERMINAL.indexOf(j.status) < 0);
    if (state.jobPoll) { clearTimeout(state.jobPoll); state.jobPoll = null; }
    /* Poll only while something is actually running — switching tabs or
       changing dates must never trigger a download. */
    if (busy) state.jobPoll = setTimeout(() => refreshJobs().then(render), 3000);
  }

  async function startDownload(reportType) {
    if (!state.worker || !state.workerInfo) return;
    const f = state.filters;
    const from = f.from || state.today;
    const to = f.to || CSV.addDays(state.today, 13);
    try {
      await state.worker.createJob(reportType, from, to, selectedMarketplaces()[0], state.accountType || 'All (Unified Reports)');
      await refreshJobs();
    } catch (e) {
      state.lastImport = { name: 'Download', message: e.message, error: e.message,
        at: new Date().toISOString() };
    }
    render();
  }

  function downloadsPanel() {
    const w = state.workerInfo;
    let html = '<section class="card"><div class="card-h">' + ico('download')
      + '<h2>Download from Amazon</h2></div>';

    if (!w) {
      html += '<div class="sub">Reports can be fetched straight from Seller Central by a small '
        + 'program that runs on your own computer.</div>'
        + '<div class="note is-warn">' + ico('missing') + '<div>'
        + '<b>Not connected.</b> The downloader is a Python worker that runs on your machine '
        + 'and serves this app at <code>http://127.0.0.1:8765</code>. This page is open at '
        + '<code>' + esc(location.origin) + '</code>, so there is nothing to talk to.'
        + '<div class="meta" style="margin-top:10px">A page served from claude.ai '
        + '<b>cannot</b> reach a program on your computer — browsers block it. To use '
        + 'downloads, start the worker and open the address it prints. Manual CSV import '
        + 'above works everywhere and is unaffected.</div>'
        + '<details style="margin-top:12px" open><summary>' + ico('info', { size: 'sm' })
        + 'Set it up (once)</summary>'
        + '<ol class="meta" style="margin:12px 0 0 18px">'
        + '<li>Open a terminal in the app folder and run '
        + '<code>python worker/install.py</code>. That is the only time you need a '
        + 'terminal.</li>'
        + '<li>It installs everything under <code>worker/</code>, registers the helper to '
        + 'start when you log in, and prints a link.</li>'
        + '<li>Open that link and bookmark it. After that, one button does the rest.</li>'
        + '</ol>'
        + '<p class="meta" style="margin-top:10px">Already installed but not running? '
        + 'Double-click <code>worker/start-helper.cmd</code> (Windows) or '
        + '<code>worker/start-helper.sh</code> (Mac/Linux). Full instructions are in '
        + '<code>worker/INSTALL.txt</code>.</p>'
        + '<p class="meta">Your computer and the helper must be running. Nothing downloads '
        + 'while they are off.</p></details>'
        + (state.watchGaveUp
          ? '<div class="note is-warn" style="margin-top:12px">' + ico('missing')
            + '<div><b>Still no helper after ' + WATCH_SECONDS + ' seconds.</b> '
            + 'Either it is not installed yet, or it is installed but not running. '
            + 'Manual CSV import keeps working either way.</div></div>'
          : '')
        + '<div class="btnrow" style="margin-top:12px">'
        + '<button class="btn" id="getinstaller">' + ico('download', { size: 'sm' })
        + 'Download setup package</button>'
        + '<button class="btn sec" id="openlocal">' + ico('forecast', { size: 'sm' })
        + 'Open local app</button>'
        + '<button class="btn sec" id="watchworker"' + (state.workerWatch ? ' disabled' : '') + '>'
        + (state.workerWatch ? 'Looking\u2026 (' + WATCH_SECONDS + 's)'
          : 'Retry connection') + '</button></div>'
        + (state.refreshNote ? '<div class="meta" style="margin-top:8px">'
          + esc(state.refreshNote) + '</div>' : '')
        + '</div></div></section>';
      return html;
    }

    html += '<div class="sub">Connected to the helper on this computer. '
      + 'Reports are fetched with your own signed-in Amazon session; this app never sees '
      + 'your password.</div>';

    const phase = derivePhase();
    html += startButton(w);
    if (phase) {
      html += '<div class="note ' + (phase === 'done' ? 'is-ok'
        : phase === 'failed' ? 'is-error' : '') + '" style="margin-top:12px">'
        + ico(phase === 'done' ? 'verified' : phase === 'failed' ? 'missing' : 'asOf')
        + '<div><b>' + esc(REFRESH_WORDS[phase] || phase) + '.</b>'
        + (state.refreshNote ? ' ' + esc(state.refreshNote) : '')
        + (phase === 'login' ? ' Finish signing in in the Amazon window, then press Retry '
          + 'on the job below — your place is kept and nothing is requested twice.' : '')
        + '</div></div>';
    }

    /* Freshness is the coverage of what was actually fetched, never "today"
       because the app happened to open today. */
    const fetched = state.imports.filter(i => i.fetchedAt);
    if (fetched.length) {
      html += '<div class="tscroll" style="margin-top:16px"><table><thead><tr>'
        + '<th>Report</th><th>Covers</th><th>Last fetched</th></tr></thead><tbody>';
      for (const i of fetched.slice(0, 6)) {
        html += '<tr><td class="wrap">' + esc(i.family) + '</td>'
          + '<td>' + esc(i.coverage || '—') + '</td>'
          + '<td>' + esc(new Date(i.fetchedAt).toLocaleString()) + '</td></tr>';
      }
      html += '</tbody></table></div>';
    }

    if (!w.tokenPresent) {
      html += '<div class="note is-warn">' + ico('missing') + '<div><b>No worker token.</b> '
        + 'Open the app using the Desktop shortcut, or downloads will be '
        + 'refused.</div></div>';
    }

    html += '<div class="meta" style="margin-top:10px">Uses the reporting period at the top '
      + 'of the page: <b>' + esc(fmtDay(state.filters.from || state.today)) + ' – '
      + esc(fmtDay(state.filters.to || CSV.addDays(state.today, 13))) + '</b>.</div>';

    html += setupCard();

    /* Everything below is for when one report needs redoing on its own, or
       when you want to see exactly which page will be opened. Folded away by
       default: it is reference, not a step. */
    if (!state.setup || state.setup.phase === 'idle') {
      html += '<details class="dl" style="margin-top:20px"><summary>'
        + 'Reports, countries and account type</summary><div style="padding-top:12px">';

      html += '<div class="tscroll"><table><thead><tr><th>Report</th>'
        + '<th class="wrap">Page it opens</th><th>State</th><th class="act"></th>'
        + '</tr></thead><tbody>';
      for (const r of w.reports || []) {
        html += '<tr><td class="wrap">' + esc(r.label) + '</td>'
          /* The address a download will really open: what setup recorded if it
             has run, otherwise what it will start from. Shown rather than
             described, so a report pointed at the wrong page is visible here
             instead of being discovered in a bad export. */
          + '<td class="wrap"><code>' + esc(r.resolvedUrl || r.url || '\u2014')
          + '</code></td>'
          /* A STATE, not an instruction. "Set up" next to a button reads as
             something you still have to do. */
          + '<td>' + (r.ready
            ? '<span class="tag is-actual">Ready</span>'
              + (r.driver ? '<div class="meta">No setup needed — this page '
                + 'is driven from its own headings.</div>' : '')
            : '<span class="tag">Needs setup</span>')
          + '</td><td class="act">'
          + (r.ready
            ? '<button class="btn sec" data-dl="' + esc(r.id) + '">Get this one</button>'
            : '<button class="btn sec" data-setup="' + esc(r.id) + '">Set up</button>')
          + '</td></tr>';
      }
      html += '</tbody></table></div>';

      html += downloadScopeCard(w);

      html += '<div class="note" style="margin-top:12px">' + ico('info') + '<div>'
        + '<b>Downloads only work in the local version of this app</b> '
        + '(<code>http://127.0.0.1:8765</code>, served by the helper). On '
        + '<code>claude.ai</code> the browser blocks any page from reaching a program on '
        + 'your computer. Manual CSV import and every figure on every tab work in both.'
        + '</div></div>';

      html += '</div></details>';
    }

    html += aboutPanel();

    html += mirrorPanel();

    /* Where this window's data actually lives, and what happened to the
       shared copy. Said on the screen that is about data, not buried. */
    if (state.stateHome === 'helper') {
      html += '<div class="note is-ok">' + ico('verified') + '<div><b>Shared on this '
        + 'computer.</b> Your figures live in the helper\u2019s database, so every '
        + 'browser here reads the same copy. A copy is kept in this browser too, in '
        + 'case the database is ever lost.</div></div>';
    } else if (state.worker && state.workerInfo) {
      html += '<div class="note is-warn">' + ico('missing') + '<div><b>This browser '
        + 'only.</b> Your figures are stored in this browser and are not shared with '
        + 'others on this computer.</div></div>';
    }

    if (state.stateNote) {
      html += '<div class="note">' + ico('info') + '<div>' + esc(state.stateNote)
        + '</div></div>';
    }

    /* Two windows, two versions. Neither has been thrown away, and neither is
       chosen here: whoever is sitting in front of this decides. */
    if (state.stateConflict) {
      const mine = docShape(stateDoc());
      const theirs = docShape(state.stateConflict.theirs);
      const line = (label, a, b) => '<tr><td>' + esc(label) + '</td><td class="n">'
        + a.toLocaleString() + '</td><td class="n">' + b.toLocaleString() + '</td></tr>';
      html += '<div class="note is-warn">' + ico('missing') + '<div>'
        + '<b>Another window saved changes after this one loaded.</b> Nothing has been '
        + 'overwritten. Here is what each holds:'
        + '<div class="tscroll" style="margin-top:12px"><table><thead><tr><th></th>'
        + '<th class="n">This window</th><th class="n">The saved copy</th></tr></thead><tbody>'
        + line('Imported files', mine.imports, theirs.imports)
        + line('Report rows', mine.previewRows, theirs.previewRows)
        + line('Balance snapshots', mine.balances, theirs.balances)
        + line('Product costs', mine.costs, theirs.costs)
        + '</tbody></table></div>'
        + '<div class="btnrow" style="margin-top:12px">'
        + '<button class="btn" data-stateuse="theirs">Use the saved copy</button>'
        + '<button class="btn sec" data-stateuse="mine">Keep what is in this window</button>'
        + '</div></div></div>';
    }

    if (state.jobNote) {
      html += '<div class="note"' + '>' + ico('info') + '<div>' + esc(state.jobNote)
        + '</div></div>';
    }

    if (state.jobs.length) {
      html += '<div class="tscroll" style="margin-top:20px"><table><thead><tr>'
        + '<th>Report</th><th>Dates</th><th>Status</th><th class="wrap">Detail</th>'
        + '<th class="act"></th></tr></thead><tbody>';
      for (const j of state.jobs.slice(0, 12)) {
        const word = Worker2.WORDS[j.status] || j.status;
        const bad = j.status === 'failed';
        const waiting = j.status === 'login-required';
        html += '<tr><td>' + esc(j.reportType) + '</td>'
          + '<td>' + esc(fmtDay(j.requestedFrom)) + ' – ' + esc(fmtDay(j.requestedTo)) + '</td>'
          + '<td><span class="tag ' + (j.status === 'complete' ? 'is-actual'
            : bad || waiting ? 'is-forecast' : 'is-assumed') + '">'
          + ico(j.status === 'complete' ? 'verified' : bad || waiting ? 'missing' : 'asOf',
            { size: 'sm' }) + esc(word) + '</span></td>'
          + '<td class="wrap">' + esc(j.lastError || j.statusDetail || '') + '</td>'
          + '<td class="act">' + (state.confirmJob === j.jobId
            ? '<span class="tag">Confirm below</span>'
            : ((bad || waiting
              ? '<button class="btn sec sm" data-retry="' + esc(j.jobId) + '">Retry</button>'
              : '')
              /* Only a report that has stopped can be deleted. One still
                 working would leave the helper holding a job nothing knows
                 about, and a half-written file behind it. */
              + (Worker2.TERMINAL.indexOf(j.status) >= 0
                ? '<button class="btn sec sm" data-jobdel="' + esc(j.jobId) + '"'
                + (bad || waiting ? ' style="margin-left:8px"' : '')
                + ' aria-label="Delete this report request">'
                + ico('remove', { size: 'sm' }) + 'Delete</button>'
                : ''))) + '</td></tr>';
      }
      html += '</tbody></table></div>';

      const doomed = state.jobs.find(j => j.jobId === state.confirmJob);
      if (doomed) {
        /* What actually goes, named before it goes: the request, the file it
           downloaded, and the figures it put on the pages. Those three used to
           be separated, and deleting every report left the dashboard showing
           the same net sales and fees as before - nobody deletes a report
           meaning "and please keep the numbers". */
        const hasFile = !!doomed.fileName;
        const imp = state.imports.find(i => i.jobId === doomed.jobId);
        /* Transaction history cannot be removed one file at a time: those rows
           share a single ledger. Said here rather than discovered afterwards. */
        const spread = imp ? removalEffect(imp).alsoGoes : null;
        html += '<div class="note is-warn">' + ico('missing') + '<div>'
          + '<b>Delete this ' + esc(fmtDay(doomed.requestedFrom)) + ' \u2013 '
          + esc(fmtDay(doomed.requestedTo)) + ' report?</b> '
          + (hasFile
            ? 'The downloaded file <b>' + esc(doomed.fileName) + '</b> is deleted with it.'
            : 'Nothing was downloaded, so only the request is removed.')
          + (imp
            ? ' <b>The ' + (imp.rowCount || 0).toLocaleString() + ' rows imported from it are '
            + 'removed too</b>, so the figures they feed leave every page on this device.'
            + (spread ? ' ' + esc(spread) : '')
            : '')
          + '<br><br>Your Amazon account is not touched, and the report stays in Generated '
          + 'Reports on Seller Central.'
          + '<div class="btnrow" style="margin-top:12px">'
          + '<button class="btn danger" data-jobdelyes="' + esc(doomed.jobId) + '">Delete it</button>'
          + '<button class="btn sec" data-jobdelno="1">Keep it</button></div></div></div>';
      }
    }

    html += '</section>';
    return html;
  }

  /* ── about ─────────────────────────────────────────── */

  /* Plain words for each update state. "Not checked yet" is a real answer and
     is given as one: saying "up to date" before anything has been asked would
     be a guess dressed as a fact. */
  const UPDATE_WORDS = {
    unknown:  'Not checked yet.',
    checking: 'Checking\u2026',
    current:  'This is the newest version.',
    available: 'A newer version is on its way.',
    failed:   'The last check did not work.',
    off:      'This copy does not update itself.',
  };

  /* ── the off-machine copy ─────────────────────────────────── */

  /* Connecting and sending are two different things, and conflating them is
     how "Connected" ends up meaning nothing. Connected proves the credentials
     reach the project. This is the part that actually moves figures, and it
     needs a key the project's access rules do not apply to - which is why it
     is asked for separately and stays on this computer. */
  function sendingSection(m, busy) {
    const mir = m.mirror || {};
    const pending = Number(mir.pending || 0);
    const total = Number(mir.reports || 0);
    let html = '<div style="margin-top:14px;padding-top:14px;'
      + 'border-top:1px solid var(--line)">';

    html += '<p class="muted" style="margin:0 0 8px"><b>Sending your '
      + 'figures.</b> Connecting proved the credentials work. Nothing is '
      + 'copied across until this computer is allowed to write.</p>';

    if (!m.canWrite && state.setupOpen) {
      html += '<div class="note">' + ico('info') + '<div>Being set up in the window that opened. '
        + '<button class="btn sec sm" data-setupopen="1" style="margin-left:8px">Show it</button>'
        + '</div></div></div>';
      return html;
    }
    if (!m.canWrite) {
      html += writeKeyForm(busy) + '</div>';
      return html;
    }
    return sendingStatus(html, m, mir, pending, total, busy);
  }

  function writeKeyForm(busy) {
      let html = '<div class="note"' + '>' + ico('info') + '<div>'
        + 'Your tables are locked - nothing can read or write them by '
        + 'accident. Writing needs the project\u2019s <b>secret</b> key '
        + '(<code>sb_secret_\u2026</code> or <code>service_role</code>), from '
        + 'the same <b>Project Settings \u2192 API</b> page. It is kept on '
        + 'this computer only: never in the installer, never uploaded, never '
        + 'shown back to you.</div></div>'
        + '<div style="margin-top:10px">'
        + '<label class="muted" for="sbwrite">secret key (this computer '
        + 'only)</label>'
        + '<input id="sbwrite" type="password" spellcheck="false" '
        + 'placeholder="sb_secret_\u2026" style="width:100%;margin:4px 0 0">'
        + '</div>'
        + '<div class="btnrow" style="margin-top:10px">'
        + '<button class="btn" data-mirror="writekey"'
        + (busy ? ' disabled' : '') + '>'
        + (busy === 'writekey' ? 'Saving\u2026' : 'Allow this computer to write')
        + '</button></div>';
      return html;
  }

  function sendingStatus(html, m, mir, pending, total, busy) {
    const dels = Number(mir.pendingDeletes || 0);
    const auto = m.auto || {};
    const last = auto.last;

    /* What was SENT, from this machine's own record - never a claim about
       what is in Supabase now. It could have been emptied there and this
       would not know, so the words are "sent", never "in sync". */
    html += '<div class="note ' + (pending || dels ? 'is-warn' : 'is-ok') + '">'
      + ico(pending || dels ? 'missing' : 'verified') + '<div>'
      + (total === 0
        ? 'Nothing to send yet - no reports have been imported.'
        : (pending === 0
          ? '<b>All ' + total + ' report' + (total === 1 ? '' : 's')
            + ' sent.</b>'
          : '<b>' + pending + ' of ' + total + ' report'
            + (total === 1 ? '' : 's') + ' not sent yet.</b>'))
      + (dels
        ? '<br><b>' + dels + ' deleted report' + (dels === 1 ? '' : 's')
          + ' still to be removed from the mirror.</b>'
        : '')
      + (mir.lastPushAt
        ? '<br><span class="muted">last sent '
          + esc(fmtDay(String(mir.lastPushAt).slice(0, 10))) + '</span>'
        : '')
      + '<br><span class="muted">This is what this computer sent. It is not a '
      + 'reading of what is in Supabase now.</span>'
      + '<br><span class="muted">write key ' + esc(m.writeKeyHint || 'set')
      + '</span></div></div>';

    /* Automatic sending, and what it last did. The result is the helper's
       own record of a real pass - kept only while the helper runs, so after a
       restart this line is simply absent rather than stale. */
    html += '<label style="display:flex;gap:8px;align-items:flex-start;margin-top:12px;cursor:pointer">'
      + '<input type="checkbox" id="mirrorauto" style="margin-top:3px"'
      + (m.autoPush !== false ? ' checked' : '') + (busy ? ' disabled' : '') + '>'
      + '<span>Send automatically after each download, and remove what is deleted here'
      + '<br><span class="muted">A few seconds after the change. Off means only '
      + '\u201cSend now\u201d sends.</span></span></label>';
    if (last && last.at) {
      const t = new Date(last.at);
      const when = isNaN(t) ? '' : ' ' + fmtDay(t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0')) + ' '
        + t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      html += '<div class="note ' + (last.ok ? '' : 'is-warn') + '" style="margin-top:8px">'
        + ico(last.ok ? 'info' : 'missing') + '<div>'
        + '<b>' + (last.ok ? 'Last automatic send' : 'The last automatic send did not work')
        + '</b><span class="muted">' + esc(when) + '</span><br>' + esc(last.detail || '')
        + (last.ok ? ''
          : m.autoPush === false
          ? ' Automatic sending is off now, so it will not retry; “Send now” will.'
          : (Number(auto.failures || 0) <= 3
            ? ' It will try again on its own.'
            : ' It will try again after the next download, or press \u201cSend now\u201d.'))
        + '</div></div>';
    }

    html += '<div class="btnrow" style="margin-top:10px">'
      + '<button class="btn" data-mirror="push"'
      + (busy || (total === 0 && dels === 0) ? ' disabled' : '') + '>'
      + (busy === 'pushing' ? 'Sending\u2026' : 'Send now')
      + '</button>'
      + '<button class="btn sec sm" data-mirror="writeforget" '
      + 'style="margin-left:8px">' + ico('remove', { size: 'sm' })
      + 'Remove write key</button></div>';

    html += '</div>';
    return html;
  }

  /* The helper sends on its own a few seconds after a change. Look again
     once it has had the chance, so the panel shows what happened rather than
     what was true before it - and stop looking once there is nothing left. */
  let mirrorPeek = null;
  function refreshMirrorSoon() {
    if (!state.worker || !state.mirror || !state.mirror.canWrite
        || state.mirror.autoPush === false) return;
    clearTimeout(mirrorPeek);
    let tries = 0;
    const look = () => {
      state.worker.mirror().then(m => {
        state.mirror = m;
        const a = m.auto || {};
        const mir = m.mirror || {};
        if (++tries < 4 && a.enabled && (a.busy || mir.pending || mir.pendingDeletes)) {
          mirrorPeek = setTimeout(look, 8000);
        }
        render();
      }).catch(() => { /* the next render or reload will say */ });
    };
    mirrorPeek = setTimeout(look, 6000);
  }

  function mirrorPanel() {
    const m = state.mirror;
    const busy = state.mirrorBusy;
    const said = state.mirrorSaid;

    if (!m && state.mirrorLoad === 'failed') {
      return '<details class="panel" id="mirror" open><summary>' + ico('marketplace', { size: 'sm' })
        + 'Read your figures from another device <span class="tag is-warn">Could not check</span>'
        + '</summary><div class="body"><div class="note is-warn">' + ico('missing') + '<div>'
        + '<b>Your connection settings could not be read from the helper.</b> That is not the same '
        + 'as not being set up - nothing has been lost or changed. '
        + esc(state.mirrorLoadError || '') + '</div></div>'
        + '<div class="btnrow"><button class="btn sec sm" data-mirror="reload">Try again</button></div>'
        + '</div></details>';
    }
    if (!m) {
      return '<details class="panel" id="mirror"><summary>' + ico('marketplace', { size: 'sm' })
        + 'Read your figures from another device <span class="tag">Checking\u2026</span>'
        + '</summary></details>';
    }

    /* Open, and saying so, until it is set up.
       A folded panel is the right shape for something already working and the
       wrong shape for something waiting to be done: it was collapsed, below
       two other panels, and simply not found. Once connected it folds away
       like everything else. */
    const waiting = !(m && m.configured);
    let html = '<details class="panel" id="mirror"' + (waiting ? ' open' : '')
      + '><summary>' + ico('marketplace', { size: 'sm' })
      + 'Read your figures from another device'
      + (waiting ? ' <span class="tag is-assumed">Not set up</span>' : '')
      + '</summary><div class="body">';

    html += '<p class="muted" style="margin-top:0">Your figures stay on this '
      + 'computer, and a <b>copy</b> goes to a Supabase project you own. Another '
      + 'computer running this app - with the same project connected and its secret '
      + 'key added there too - opens with the same figures. If two computers change '
      + 'something at once, nothing is overwritten: you are shown both and choose. '
      + 'A phone cannot run this app, so it cannot read them.</p>';

    if (m && m.configured) {
      const ok = m.lastResult && m.lastResult.ok;
      html += '<div class="note ' + (ok ? 'is-ok' : 'is-warn') + '">'
        + ico(ok ? 'verified' : 'missing') + '<div>'
        + '<b>' + (ok ? 'Connected' : 'Saved, but the last check failed')
        + '.</b> ' + esc(m.url)
        + '<br><span class="muted">key ' + esc(m.keyHint || 'set')
        + (m.lastTestedAt ? ' \u00b7 checked ' + esc(fmtDay(m.lastTestedAt.slice(0, 10)))
          : '') + '</span>'
        + (m.lastResult && m.lastResult.detail
          ? '<br>' + esc(m.lastResult.detail) : '')
        + '</div></div>';
      html += sendingSection(m, busy);

      /* Your figures on your other computers - said as it is, from the
         project's own answer, never from the settings alone. */
      if (m.canWrite) {
        const cs = state.cloudStatus;
        const st = state.syncState || {};
        const on = !!state.sync;
        html += '<div class="note ' + (on && st.status !== 'failed' ? 'is-ok' : 'is-warn') + '" style="margin-top:12px">'
          + ico(on ? 'verified' : 'missing') + '<div><b>Your figures on your other computers: '
          + esc(on ? (SYNC_WORDS[st.status] || SYNC_WORDS.connecting)[2] : 'not yet') + '.</b> '
          + (on ? 'Balances, entries, settings and imported files are kept in the project for '
            + 'your other computers.'
            : esc((cs && cs.detail) || 'Checking the project\\u2026'))
          + '</div></div>';
      }

      html += '<div class="btnrow" style="margin-top:12px">'
        + '<button class="btn sec sm" data-mirror="test"' + (busy ? ' disabled' : '')
        + '>' + (busy === 'testing' ? 'Checking\u2026' : 'Check it again') + '</button>'
        + '<button class="btn sec sm" data-mirror="forget" style="margin-left:8px">'
        + ico('remove', { size: 'sm' }) + 'Disconnect</button></div>';
    } else if (state.setupOpen) {
      /* The same fields are in the setup window right now; one copy of a
         form is the only way its ids stay unique. */
      html += '<div class="note">' + ico('info') + '<div>Being set up in the window that opened. '
        + '<button class="btn sec sm" data-setupopen="1" style="margin-left:8px">Show it</button>'
        + '</div></div>';
    } else {
      html += mirrorConnectForm(busy);
    }
    return mirrorPanelTail(html, m, said);
  }

  /* The first-launch setup window (asked for by the owner: make the cloud copy
     the first thing a new install sees, but never a wall). Two steps, each
     skippable; closing it leaves a card on the Dashboard until it is done. */
  function setupModal() {
    const m = state.mirror;
    if (!state.setupOpen || !m || (m.configured && m.canWrite)) return '';
    const busy = state.mirrorBusy;
    const said = state.mirrorSaid;
    const step = m.configured ? 2 : 1;
    let html = '<div class="modal-scrim" data-setupskip="1"></div>'
      + '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="setuph">'
      + '<div class="modal-h"><span class="tag nodot">Step ' + step + ' of 2</span>'
      + '<button class="btn sec sm" data-setupskip="1" style="margin-left:auto">Skip for now</button></div>'
      + '<h2 id="setuph">' + (step === 1 ? 'Keep a copy of your figures in your own database'
        : 'Let this computer send your figures') + '</h2>'
      + '<p class="meta" style="margin:6px 0 14px">' + (step === 1
        ? 'Everything stays on this computer: your downloads, your Amazon session, your keys. '
          + 'This sends a <b>copy</b> of the figures to a Supabase project you own, so a phone or '
          + 'laptop can read them and a lost laptop does not take your history with it.'
        : 'Connected. One key to go: the secret key lets this computer write to the tables, which '
          + 'stay locked to everything else. It is stored encrypted, on this computer only.') + '</p>';
    html += step === 1 ? mirrorConnectForm(busy) : writeKeyForm(busy);
    if (said) {
      html += '<div class="note ' + (said.ok ? 'is-ok' : 'is-warn') + '" style="margin-top:12px">'
        + ico(said.ok ? 'verified' : 'missing') + '<div>' + esc(said.detail || '') + '</div></div>';
    }
    if (step === 1 && m.schemaSql) {
      html += '<details class="plain"><summary>' + ico('chevronRight', { size: 'sm' })
        + 'First time? The tables it needs (paste into Supabase \u2192 SQL Editor \u2192 Run)'
        + '</summary><pre style="white-space:pre-wrap;font-size:12px;background:var(--surface-alt);'
        + 'padding:12px;border-radius:8px;border:1px solid var(--line);overflow:auto;max-height:220px">'
        + esc(m.schemaSql) + '</pre></details>';
    }
    html += '<p class="meta" style="margin:14px 0 0;color:var(--ink-3)">You can do this later from the '
      + 'Dashboard, or from Data &amp; Assumptions.</p></div>';
    return html;
  }

  /* Once the window is closed with setup unfinished, this stays at the top
     of the Dashboard - so skipping is a choice that remains visible, not a
     prompt that disappears. */
  function setupCard() {
    const m = state.mirror;
    if (!state.workerInfo || state.mirrorLoad !== 'ok' || !m || state.setupOpen) return '';
    if (m.configured && m.canWrite) return '';
    const half = m.configured && !m.canWrite;
    return '<section class="card is-primary" style="display:flex;gap:16px;align-items:center;'
      + 'flex-wrap:wrap">' + '<div style="flex:1 1 360px"><div class="card-h" style="margin:0 0 4px">'
      + '<h2>' + (half ? 'Your cloud copy is connected, but nothing is being sent'
        : 'Your figures live only on this computer') + '</h2>'
      + '<span class="tag is-warn">' + (half ? '1 step left' : 'Not set up') + '</span></div>'
      + '<div class="meta">' + (half ? 'Add the secret key so this computer can send a copy.'
        : 'Keep a copy in your own Supabase database, so a phone or laptop can read it and a lost '
          + 'laptop does not take your history with it.') + '</div></div>'
      + '<button class="btn" data-setupopen="1">' + (half ? 'Finish setup' : 'Set it up') + '</button>'
      + '</section>';
  }

  function mirrorConnectForm(busy) {
      /* The two fields, and what to paste into each. Named exactly as
         Supabase names them, because "the key" is ambiguous and the wrong
         one is a key that bypasses every access rule in the project.
         Both key names are given because Supabase renamed it: older projects
         show "anon public", newer ones "Publishable key". Naming only one
         leaves half of all users hunting for a label not on their screen. */
      let html = '<div class="note"' + '>' + ico('info') + '<div>'
        + 'In Supabase: <b>Project Settings \u2192 API</b>. Copy the '
        + '<b>Project URL</b> \u2014 it looks like '
        + '<code>https://yourproject.supabase.co</code>, <i>not</i> the '
        + 'dashboard address in your browser\u2019s address bar \u2014 and '
        + 'the key labelled <b>anon public</b>, or <b>Publishable key</b> '
        + 'on newer projects. '
        + '<b>Not</b> the <code>service_role</code> or <code>secret</code> key '
        + '\u2014 those ignore every access rule, and this app refuses '
        + 'them.</div></div>';

      html += '<div style="margin-top:12px">'
        + '<label class="muted" for="sburl">Project URL</label>'
        + '<input id="sburl" type="url" spellcheck="false" '
        + 'placeholder="https://yourproject.supabase.co" '
        + 'style="width:100%;margin:4px 0 12px" value="'
        + esc(state.mirrorUrl || '') + '">'
        + '<label class="muted" for="sbkey">anon public key '
        + '<span style="opacity:.65">or publishable key</span></label>'
        + '<input id="sbkey" type="password" spellcheck="false" '
        + 'placeholder="eyJhbGciOi\u2026" style="width:100%;margin:4px 0 0">'
        + '</div>';

      html += '<div class="btnrow" style="margin-top:12px">'
        + '<button class="btn" data-mirror="save"' + (busy ? ' disabled' : '') + '>'
        + (busy === 'saving' ? 'Checking the connection\u2026'
          : 'Connect') + '</button></div>';
      return html;
  }

  function mirrorPanelTail(html, m, said) {
    /* Whatever the last REAL attempt found, in its own words. */
    if (said) {
      html += '<div class="note ' + (said.ok ? 'is-ok' : 'is-warn') + '" '
        + 'style="margin-top:12px">' + ico(said.ok ? 'verified' : 'missing')
        + '<div>' + esc(said.detail || '') + '</div></div>';
    }

    if (m && m.schemaSql) {
      html += '<details style="margin-top:12px"><summary class="muted">'
        + 'The tables this needs (paste into Supabase \u2192 SQL Editor)'
        + '</summary><pre style="white-space:pre-wrap;font-size:12px;'
        + 'background:var(--surface-alt);padding:12px;border-radius:8px;'
        + 'border:1px solid var(--line);overflow:auto">'
        + esc(m.schemaSql) + '</pre></details>';
    }

    html += '</div></details>';
    return html;
  }

  /* Read the mirror settings from the helper.

     This used to run once at startup, BEFORE the helper connection existed,
     see no helper, and return - so on every fresh launch the panel said
     "Not set up" about a project that was set up. And any failure was
     swallowed with the same result. "Could not read the settings" and "there
     are no settings" are different states, and are now shown as different
     states; a failure is retried, because the likeliest cause is a helper
     that was restarting when the app opened (which is what an update does). */
  async function loadMirror(attempt) {
    attempt = attempt || 0;
    if (!state.worker || !state.workerInfo) return;
    state.mirrorLoad = 'loading';
    try {
      state.mirror = await state.worker.mirror();
      state.mirrorLoad = 'ok';
      state.mirrorLoadError = null;
      startCloudSync();
      /* The first time the app lands with nothing set up, it asks - once per
         launch, and never again once skipped this session. */
      if (!state.setupSkipped && state.mirror && (!state.mirror.configured || !state.mirror.canWrite)) {
        state.setupOpen = true;
      }
    } catch (e) {
      if (attempt < 3) {
        setTimeout(() => loadMirror(attempt + 1), [1500, 4000, 10000][attempt]);
        return;
      }
      state.mirrorLoad = 'failed';
      state.mirrorLoadError = String(e && e.message ? e.message : e).slice(0, 200);
    }
    render();
    if (state.setupOpen) setTimeout(() => { const f = $('#sburl') || $('#sbwrite'); if (f) f.focus(); }, 40);
  }

  function aboutPanel() {
    const sh = state.shell;
    const helper = (state.workerInfo && state.workerInfo.version) || null;

    const rows = [];
    rows.push(['App', sh
      ? esc(sh.appVersion)
      : 'Running in a browser, so there is no app version to report']);
    rows.push(['Helper', helper ? esc(helper)
      : 'Not connected, so its version is unknown']);

    /* The two are built and released together. When they disagree, one of
       them did not update - which is worth seeing rather than discovering
       through some later failure that makes no sense. */
    if (sh && helper && sh.appVersion !== helper) {
      rows.push(['Mismatch',
        'The app is ' + esc(sh.appVersion) + ' and the helper is '
        + esc(helper) + '. These ship together, so one of them did not '
        + 'update. Closing and reopening the app usually settles it.']);
    }

    if (sh) {
      const u = sh.updates || {};
      const words = UPDATE_WORDS[u.state] || UPDATE_WORDS.unknown;
      rows.push(['Updates', esc(u.detail || words)
        + (u.checkedAt ? ' <span class="muted">(checked '
          + esc(shortTime(u.checkedAt)) + ')</span>' : '')]);
    }

    let html = '<details class="panel" id="about"><summary>'
      + ico('info', { size: 'sm' }) + 'About this app</summary><div class="body">';
    html += '<div class="tscroll"><table><tbody>';
    for (const [label, value] of rows) {
      html += '<tr><td style="width:140px"><b>' + esc(label) + '</b></td>'
        + '<td class="wrap">' + value + '</td></tr>';
    }
    html += '</tbody></table></div>';

    if (sh) {
      const ready = sh.updates && sh.updates.ready;
      html += '<div class="btnrow" style="margin-top:12px">';
      if (ready) {
        /* An update that has downloaded but never applied looks exactly like
           one that never arrived. So it is offered, plainly, rather than left
           to happen at some later quit. */
        html += '<button class="btn" data-installupdate="1">'
          + ico('download', { size: 'sm' }) + 'Restart and install '
          + esc(sh.updates.readyVersion || 'the update') + '</button>';
      }
      html += '<button class="btn sec sm" data-checkupdates="1"'
        + (ready ? ' style="margin-left:8px"' : '') + '>'
        + ico('compare', { size: 'sm' }) + 'Check for updates</button></div>';
    }
    html += '</div></details>';
    return html;
  }

  function shortTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  /* Asked once at boot, and again whenever the shell says something changed,
     so the panel is never showing a state the shell has moved on from. */
  async function shellBoot() {
    if (typeof window === 'undefined' || !window.desktopShell) return;
    try {
      state.shell = await window.desktopShell.info();
      window.desktopShell.onUpdate(info => { state.shell = info; render(); });
      render();
    } catch (e) { /* a shell that will not answer is the same as no shell */ }
  }

  /* ── account sync ───────────────────────────────── */

  /* Local storage keeps working exactly as before; this adds a second,
     account-scoped copy so another device can pick the data up. Nothing here
     may delete local data on the strength of what the server says. */

  const blobKeyFor = imp => 'imp-' + String(imp.id || '').replace(/[^A-Za-z0-9_\-.~:@+]/g, '_');

  async function syncBoot() {
    state.sync = null;
    state.syncState = { status: 'unavailable', reason: 'Your figures are on this computer only. '
      + 'To have them on your other computers, connect your Supabase project and add its secret '
      + 'key on each one (Data & Assumptions \u2192 Read your figures from another device).' };
    paintSyncBadge();
    render();
  }

  /* On once the project is connected with its secret key AND has the table
     to hold your figures - asked of the project, not assumed from settings.
     Until then nothing is claimed: the badge says "This computer only". */
  let cloudStarting = false;
  async function startCloudSync() {
    if (cloudStarting || state.sync) return;
    const m = state.mirror;
    if (!state.worker || !m || !m.configured || !m.canWrite) { syncBoot(); return; }
    cloudStarting = true;
    try {
      let st;
      try { st = await state.worker.cloudStatus(); } catch (e) { st = { ready: false, detail: e.message }; }
      state.cloudStatus = st;
      if (!st || !st.ready) {
        state.syncState = { status: 'unavailable', reason: (st && st.detail) || 'The project could not be checked.' };
        paintSyncBadge();
        return;
      }
      const sync = Sync.create({
        use: Sync.helperStore(state.worker),
        onStatus: s => {
          state.syncState = s;
          paintSyncBadge();
          /* A settled state changes what the panels say; redraw once for it. */
          if (/^(saved|failed|conflict|connected)$/.test(s.status) && state.screen === 'data') render();
        },
      });
      if (!(await sync.connect())) return;
      state.sync = sync;
      await syncReconcile();
    } finally {
      cloudStarting = false;
      render();
    }
  }

  function stopCloudSync() {
    state.sync = null;
    state.cloudStatus = null;
    syncBoot();
  }

  /* First contact on this device. Neither side is authoritative, so the two
     are merged: imports union by content hash, accumulated records union by
     id, and single-valued settings prefer whichever side has any. */
  async function syncReconcile() {
    const sync = state.sync;
    if (!sync) return;
    try {
      state.syncBusy = true;
      sync.setStatus('syncing');
      const remote = await sync.pullState();
      const localHasData = state.imports.length > 0 || state.balanceSnapshots.length > 0;

      if (!remote) {
        /* Nothing in the account yet: this device seeds it. With nothing to
           seed, the account is merely reachable — saying "saved" there would
           claim a write that never happened. */
        sync.setBaseRev(0);
        if (localHasData) await syncPush(true);
        else sync.setStatus('connected');
        return;
      }

      sync.setBaseRev(remote.rev);
      const merged = sync.mergeState(collectSyncState(), remote.payload, false);
      const beforeIds = new Set(state.imports.map(i => i.id));
      applySyncState(merged);

      /* Pull down the bulk for any import this device did not already hold. */
      for (const imp of state.imports) {
        if (beforeIds.has(imp.id)) continue;
        if (imp.family === 'Fees & Economics Preview') {
          const p = await sync.getBlob(blobKeyFor(imp));
          if (p && !state.previews.some(x => x.importId === imp.id)) {
            p.importId = imp.id;
            state.previews.push(p);
          } else if (!p) {
            imp.remoteOnly = true;      /* row is known, bulk is not here yet */
          }
        } else if (imp.family === 'Payments transactions' && !state.ledger) {
          const blob = await sync.getBlob(blobKeyFor(imp));
          if (blob) {
            const led = Store.deserialiseLedger(blob, Ledger);
            if (led && led.rowCount) state.ledger = led;
            else imp.remoteOnly = true;
          } else imp.remoteOnly = true;
        }
      }
      bumpForecast();
      await persist();
      await syncPush(true);
    } catch (e) {
      if (e && e.code === 'conflict') return;           /* already surfaced */
      state.sync.setStatus('failed', { reason: describeSyncError(e) });
    } finally {
      state.syncBusy = false;
    }
  }

  function collectSyncState() {
    const out = {};
    for (const k of Sync.STATE_KEYS) out[k] = state[k];
    return out;
  }

  function applySyncState(merged) {
    Object.assign(state, {
      balanceSnapshots: merged.balanceSnapshots || [],
      deferredSnapshots: merged.deferredSnapshots || [],
      policy: Object.assign(Cash.emptyPolicy(), merged.policy || {}),
      requestPlans: merged.requestPlans || [],
      productCosts: merged.productCosts || [],
      operatingCosts: merged.operatingCosts || [],
      cashCommitments: merged.cashCommitments || [],
      settlements: merged.settlements || [],
      bankDeposits: merged.bankDeposits || [],
      advertisingBilling: merged.advertisingBilling || [],
      forecastRuns: merged.forecastRuns || [],
      openingBankCash: merged.openingBankCash == null ? null : merged.openingBankCash,
      cashPlan: Object.assign({ buffer: null, bankCashAt: null }, merged.cashPlan || {}),
      imports: merged.imports || [],
    });
  }

  function describeSyncError(e) {
    if (!e) return 'The sync service did not respond.';
    if (e.code === 'too_large') return e.message;
    if (e.code === 'quota_exceeded') return 'Your account\u2019s sync storage is full. '
      + 'Remove an old import to make room.';
    if (e.code === 'resource_exhausted') return 'Too many changes at once. '
      + 'The next save will pick this up.';
    if (e.code === 'revoked') return 'Access to account sync was withdrawn while the app was open. '
      + 'Reload to sign in again.';
    return e.message || 'The sync service did not respond.';
  }

  /* Push settings, then any bulk that is not up there yet. */
  async function syncPush(quiet) {
    const sync = state.sync;
    if (!sync || !sync.available || state.syncBusy && !quiet) return;
    try {
      sync.setStatus('saving');
      await sync.pushState(collectSyncState());

      const manifest = await sync.readManifest();
      for (const imp of state.imports) {
        if (imp.remoteOnly) continue;
        const key = sync.safeKey ? sync.safeKey(blobKeyFor(imp)) : blobKeyFor(imp);
        if (manifest[key]) continue;
        state.syncState = Object.assign({}, state.syncState,
          { progress: { name: imp.name, chunk: 0, chunks: 0 } });
        paintSyncBadge();
        if (imp.family === 'Fees & Economics Preview') {
          const p = state.previews.find(x => x.importId === imp.id);
          if (p) await sync.putBlob(blobKeyFor(imp), p, { kind: 'preview', name: imp.name });
        } else if (imp.family === 'Payments transactions' && state.ledger) {
          await sync.putBlob(blobKeyFor(imp), Store.serialiseLedger(state.ledger),
            { kind: 'ledger', name: imp.name });
        }
      }
      sync.setStatus('saved', { lastSyncedAt: new Date().toISOString(), progress: null });
    } catch (e) {
      if (e && e.code === 'conflict') { render(); return; }
      sync.setStatus('failed', { reason: describeSyncError(e), progress: null });
    }
  }

  /* Resolving a conflict is always the person's choice, never a silent pick. */
  async function resolveConflict(choice) {
    const sync = state.sync;
    const c = state.syncState.conflict;
    if (!sync || !c) return;
    try {
      sync.setStatus('syncing');
      if (choice === 'theirs') {
        applySyncState(sync.mergeState(collectSyncState(), c.remotePayload, false));
      } else if (choice === 'merge') {
        applySyncState(sync.mergeState(collectSyncState(), c.remotePayload, true));
      }
      sync.setBaseRev(c.remoteRev);
      bumpForecast();
      await persist();
      await sync.pushState(collectSyncState(), true);
      sync.setStatus('saved', { lastSyncedAt: new Date().toISOString(), conflict: null });
    } catch (e) {
      sync.setStatus('failed', { reason: describeSyncError(e) });
    }
    render();
  }

  const SYNC_WORDS = {
    connecting: ['is-assumed', 'asOf', 'Connecting\u2026'],
    syncing:    ['is-assumed', 'asOf', 'Syncing\u2026'],
    saving:     ['is-assumed', 'asOf', 'Saving\u2026'],
    saved:      ['is-actual', 'verified', 'Synced'],
    failed:     ['is-forecast', 'missing', 'Not synced'],
    conflict:   ['is-forecast', 'missing', 'Changed on another computer'],
    idle:       ['is-assumed', 'asOf', 'Ready'],
    connected:  ['is-actual', 'verified', 'Ready to sync'],
    unavailable:['is-forecast', 'missing', 'This computer only'],
  };

  function syncBadge() {
    const st = state.syncState || { status: 'connecting' };
    const w = SYNC_WORDS[st.status] || SYNC_WORDS.connecting;
    const prog = st.progress && st.progress.chunks
      ? ' ' + st.progress.chunk + '/' + st.progress.chunks : '';
    return '<button class="tag ' + w[0] + '" data-go="data" '
      + 'title="' + esc(st.reason || (st.lastSyncedAt
        ? 'Last synced at ' + new Date(st.lastSyncedAt).toLocaleTimeString()
        : 'Sync with your other computers')) + '" '
      + 'style="border:0;cursor:pointer;font:inherit;font-size:var(--t-tag);font-weight:600">'
      + ico(w[1], { size: 'sm' }) + esc(w[2] + prog) + '</button>';
  }

  /* The full account-sync story, on the screen where data is managed. */
  function syncPanel() {
    const st = state.syncState || { status: 'connecting' };
    const w = SYNC_WORDS[st.status] || SYNC_WORDS.connecting;
    const ok = st.status === 'saved' || st.status === 'connected';
    const bad = st.status === 'failed' || st.status === 'unavailable' || st.status === 'conflict';

    let html = '<section class="card"><div class="card-h">' + ico('asOf')
      + '<h2>Your other computers</h2></div>'
      + '<div class="sub">Where this data lives, and whether your other computers can see it.</div>';

    html += '<div class="note ' + (ok ? 'is-ok' : bad ? 'is-warn' : '') + '">'
      + ico(ok ? 'verified' : bad ? 'missing' : 'asOf') + '<div>'
      + '<b>' + esc(w[2]) + '.</b> ';

    if (st.status === 'unavailable') {
      /* "In this browser" stopped being true once the helper's database
         became the source of truth. Saying it anyway would understate where
         the data actually is, and leave someone thinking a second browser
         would show nothing. Which copy is in use is a fact this app already
         knows, so it is stated rather than assumed. */
      html += esc(st.reason || '')
        + (state.stateHome === 'helper'
          ? ' Everything still works. Your figures are in the helper’s '
            + 'database on this computer, so every browser here reads the same '
            + 'copy — but nothing leaves this computer.'
          : ' Everything still works; it is kept in this browser on this '
            + 'device.')
        + ' Use <b>Export a backup</b> to carry it elsewhere.';
    } else if (st.status === 'failed') {
      html += esc(st.reason || '') + ' Your data is still saved on this device \u2014 nothing was '
        + 'lost. Sync will be retried on the next change, or use Retry below.';
    } else if (st.status === 'conflict') {
      html += 'This app was also changed on another computer since this one last synced. '
        + 'Nothing has been overwritten. Choose below which version to keep.';
    } else if (st.status === 'connected') {
      html += 'This computer can reach your Supabase project, but there is nothing to sync '
        + 'yet. Import a report and it is sent automatically.';
    } else if (ok) {
      html += 'Imported reports, balances, entries and settings are in your Supabase project. '
        + 'Another computer running this app, with the same project and its secret key added, '
        + 'picks them up when it opens.'
        + (st.lastSyncedAt ? ' Last synced ' + esc(new Date(st.lastSyncedAt).toLocaleString()) + '.' : '');
    } else {
      html += 'Checking your account\u2026';
    }
    html += '</div></div>';

    if (st.status === 'conflict' && st.conflict) {
      const c = st.conflict;
      const theirs = c.remotePayload || {};
      const mineN = state.imports.length;
      const theirsN = (theirs.imports || []).length;
      html += '<div class="note is-warn">' + ico('missing') + '<div>'
        + '<b>Two versions exist.</b>'
        + '<dl class="dl" style="margin-top:12px">'
        + '<dt>On this device</dt><dd>' + mineN + ' imported '
        + (mineN === 1 ? 'report' : 'reports') + '</dd>'
        + '<dt>In your project' + (c.remoteAt ? ', saved ' + esc(new Date(c.remoteAt).toLocaleString()) : '')
        + '</dt><dd>' + theirsN + ' imported ' + (theirsN === 1 ? 'report' : 'reports') + '</dd>'
        + '</dl>'
        + '<p class="meta" style="margin-top:8px">Combining keeps every imported report from both '
        + 'sides \u2014 the same file on both is kept once. It is the safe choice; nothing is '
        + 'deleted.</p>'
        + '<div class="btnrow" style="margin-top:12px">'
        + '<button class="btn" data-conflict="merge">Combine both (recommended)</button>'
        + '<button class="btn sec" data-conflict="theirs">Use the project\u2019s version</button>'
        + '<button class="btn sec" data-conflict="mine">Use this device\u2019s version</button>'
        + '</div></div></div>';
    }

    const retryable = st.status === 'failed' || st.status === 'idle' || st.status === 'saved'
      || st.status === 'connected';
    if (retryable && state.sync && state.sync.available) {
      html += '<div class="btnrow"><button class="btn sec" id="syncnow">'
        + ico('asOf', { size: 'sm' }) + 'Sync now</button></div>';
    }

    const pending = state.imports.filter(i => i.remoteOnly);
    if (pending.length) {
      html += '<div class="note is-warn">' + ico('missing') + '<div><b>' + pending.length
        + ' of your imports are listed in your project but their data has not arrived on this '
        + 'computer.</b> They may still be uploading from the computer that imported them, or they '
        + 'were too large to sync. Re-import the CSV here to fill them in.</div></div>';
    }

    html += '</section>';
    return html;
  }

  function paintSyncBadge() {
    const el = $('#syncbadge');
    if (el) el.innerHTML = syncBadge();
  }

  /* ── persistence ─────────────────────────────────────────────────────── */

  async function persistLedger() {
    if (!state.db || !state.ledger) return false;
    try {
      await Store.put(state.db, 'ledgerBlobs', Store.serialiseLedger(state.ledger));
      const blobs = await Store.all(state.db, 'ledgerBlobs');
      const restored = Store.deserialiseLedger(blobs.find(b => b.id === 'ledger'), Ledger);
      return !!restored && restored.rowCount === state.ledger.rowCount;
    } catch (e) { return false; }
  }

  /* ONE definition of what the saved document contains, because there are now
     two places it goes and a field added to only one of them would be a bug
     nobody notices until the other place is the one being read. */
  function stateDoc() {
    return {
      balanceSnapshots: state.balanceSnapshots, deferredSnapshots: state.deferredSnapshots,
      policy: state.policy, requestPlans: state.requestPlans,
      productCosts: state.productCosts, operatingCosts: state.operatingCosts,
      cashCommitments: state.cashCommitments, settlements: state.settlements,
      bankDeposits: state.bankDeposits, advertisingBilling: state.advertisingBilling,
      forecastRuns: state.forecastRuns, openingBankCash: state.openingBankCash,
      cashPlan: state.cashPlan,
      imports: state.imports, previews: state.previews,
      filters: state.filters,
    };
  }

  function applyStateDoc(s) {
    if (!s) return;
    Object.assign(state, {
      balanceSnapshots: s.balanceSnapshots || [], deferredSnapshots: s.deferredSnapshots || [],
      policy: Object.assign(Cash.emptyPolicy(), s.policy || {}),
      requestPlans: s.requestPlans || [], productCosts: s.productCosts || [],
      operatingCosts: s.operatingCosts || [], cashCommitments: s.cashCommitments || [],
      settlements: s.settlements || [], bankDeposits: s.bankDeposits || [],
      advertisingBilling: s.advertisingBilling || [], forecastRuns: s.forecastRuns || [],
      openingBankCash: s.openingBankCash == null ? null : s.openingBankCash,
      cashPlan: Object.assign({ buffer: null, bankCashAt: null }, s.cashPlan || {}),
      imports: s.imports || [], previews: s.previews || [],
      /* The reporting range is part of where you were, so it survives a
         reload the same way the data does. */
      filters: Object.assign({ from: null, to: null, preset: null, account: null,
        marketplace: null, currency: 'USD' }, s.filters || {}),
    });
    refreshPresetDates();
  }

  /* Enough of the document to tell whether a copy of it arrived whole. Counts
     rather than a hash, because a hash can only say "different" and these can
     say WHAT is different. */
  function docShape(s) {
    const n = k => ((s && s[k]) || []).length;
    return {
      imports: n('imports'), previews: n('previews'),
      previewRows: ((s && s.previews) || []).reduce(
        (t, p) => t + ((p.rows || []).length), 0),
      balances: n('balanceSnapshots'), costs: n('productCosts'),
      settlements: n('settlements'), deposits: n('bankDeposits'),
      runs: n('forecastRuns'), plans: n('requestPlans'),
    };
  }

  const sameShape = (a, b) => Object.keys(a).every(k => a[k] === b[k]);

  /* Which window saved, so "another window changed this" can say which one.
     The browser's own name, nothing about the person. */
  function windowLabel() {
    const ua = navigator.userAgent || '';
    const name = /Edg\//.test(ua) ? 'Edge'
      : /OPR\//.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
      : /Chrome\//.test(ua) ? 'Chrome'
      : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    return name;
  }

  async function persist() {
    const doc = stateDoc();

    /* The local copy first: it cannot conflict and it cannot be refused, so
       whatever happens next, the work is not lost. */
    if (state.db) {
      try {
        await Store.put(state.db, 'meta', Object.assign({ id: 'state' }, doc));
      } catch (e) { /* storage refusal already reported by the probe */ }
    }

    /* Then the shared copy, if this window is using one. */
    if (state.stateHome === 'helper' && state.worker) {
      try {
        const res = await state.worker.saveState(
          M.encodeExact(doc), state.stateRevision, windowLabel());
        state.stateRevision = res.revision;
        state.stateConflict = null;
      } catch (e) {
        if (e.code === 'conflict' && e.payload) {
          /* Another window saved after this one loaded. NOTHING was
             overwritten - not theirs, and not this window's local copy. The
             choice belongs to whoever is sitting here. */
          state.stateConflict = {
            revision: e.payload.revision,
            theirs: M.decodeExact(e.payload.body),
          };
        } else {
          state.stateNote = 'The shared copy could not be saved: ' + e.message
            + ' Your work is still stored in this browser.';
        }
        /* Drawn HERE. Most callers render before this save has finished, so
           without it the collision sat in state with nothing on screen - which
           is the silent overwrite this whole mechanism exists to prevent. */
        render();
      }
    }
    /* Every local save mirrors to the account. Hooking it here rather than at
       each of the fourteen call sites means a new one cannot forget to. */
    scheduleSyncPush();
  }

  /* Coalesced: a burst of edits becomes one write, which is what the store
     asks for and what keeps a slow connection from queueing behind itself. */
  let syncTimer = null;
  function scheduleSyncPush() {
    if (!state.sync || !state.sync.available || state.syncBusy) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; syncPush(); }, 900);
  }

  async function restore() {
    if (!state.db) return;
    try {
      const rows = await Store.all(state.db, 'meta');
      applyStateDoc(rows.find(r => r.id === 'state'));
    } catch (e) { /* nothing stored yet */ }

    try {
      const blobs = await Store.all(state.db, 'ledgerBlobs');
      const blob = blobs.find(b => b.id === 'ledger');
      const claimed = state.imports.some(i => i.family === 'Payments transactions');
      if (blob && !claimed) {
        try { await Store.del(state.db, 'ledgerBlobs', 'ledger'); } catch (e) { /* gone */ }
      } else if (blob) {
        const led = Store.deserialiseLedger(blob, Ledger);
        if (led && led.rowCount) state.ledger = led;
        else {
          state.imports = state.imports.filter(i => i.family !== 'Payments transactions');
          state.ledgerRestoreFailed = true;
        }
      } else if (claimed) {
        state.imports = state.imports.filter(i => i.family !== 'Payments transactions');
        state.ledgerRestoreFailed = true;
      }
    } catch (e) {
      state.imports = state.imports.filter(i => i.family !== 'Payments transactions');
      state.ledgerRestoreFailed = true;
    }

    if (state.imports.some(i => i.family === 'Fees & Economics Preview') && !state.previews.length) {
      state.imports = state.imports.filter(i => i.family !== 'Fees & Economics Preview');
      state.previewRestoreFailed = true;
    }
  }

  /* ── helpers ─────────────────────────────────────────────────────────── */

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(d) {
    if (!d) return '—';
    const p = String(d).slice(0, 10).split('-');
    if (p.length !== 3) return String(d);
    return +p[2] + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  }
  function fmtMonths(keys) {
    const byYear = new Map();
    for (const k of keys) {
      const [y, m] = String(k).split('-');
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(MONTHS[+m - 1]);
    }
    const join = a => a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
    return join([...byYear.entries()].map(([y, ms]) => join(ms) + ' ' + y));
  }
  function fmtShortDay(d) {
    if (!d) return '';
    const p = String(d).slice(0, 10).split('-');
    return +p[2] + ' ' + MONTHS[+p[1] - 1];
  }
  const cents = v => {
    const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  /* ── render ──────────────────────────────────────────────────────────── */

  /* ── header controls ─────────────────────────────────────────────────────
     Per screen, as v3 lays them out: the filters that screen actually reads,
     how old the balance is, and the one action the screen is for. A control
     only appears where changing it changes something. */

  function periodLabel() {
    const f = state.filters;
    if (f.preset) {
      const p = RANGE_PRESETS.find(x => x.id === f.preset);
      if (p) return p.label;
    }
    if (f.from || f.to) return (f.from ? fmtDay(f.from) : 'start') + ' – '
      + (f.to ? fmtDay(f.to) : 'now');
    return 'All dates';
  }

  function periodSelect() {
    const f = state.filters;
    const custom = !f.preset && (f.from || f.to || state.rangeCustomOpen);
    const cur = f.preset || (custom ? 'custom' : 'all');
    const opt = (v, l) => '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>'
      + esc(l) + '</option>';
    return '<span class="hctl"><label class="lbl" for="g-preset">Period</label>'
      + '<select id="g-preset">' + opt('all', 'All dates')
      + RANGE_PRESETS.map(p => opt(p.id, p.label)).join('')
      + opt('custom', 'Custom dates…') + '</select></span>';
  }

  /* On a screen with no Period control, a period chosen elsewhere would still
     be filtering what it shows - silently. So it is named, with a way out. */
  function activePeriodPill() {
    const f = state.filters;
    if (!f.preset && !f.from && !f.to) return '';
    return '<button class="pill is-warn" data-preset="all" '
      + 'title="A reporting period chosen on another screen is filtering this one. '
      + 'Click to show all dates.">' + ico('asOf', { size: 'sm' })
      + 'Period: ' + esc(periodLabel()) + ' · show all</button>';
  }

  /* Payout screens take ONE stream: two streams are never combined into one
     payout schedule. The analysis screens may read both together. */
  function accountSelect(allowBoth) {
    const cur = state.filters.account || (allowBoth ? '' : 'Standard Orders');
    return '<span class="hctl"><label class="lbl" for="h-acct">Account</label>'
      + '<select id="h-acct">'
      + (allowBoth ? '<option value=""' + (cur === '' ? ' selected' : '') + '>Both streams</option>' : '')
      + accountOptions(cur) + '</select></span>';
  }

  function marketplaceSelect() {
    const marketplaces = state.ledger
      ? [...state.ledger.distinct('marketplace').keys()].filter(Boolean)
      : [];
    for (const p of state.previews) if (p.store && !marketplaces.includes(p.store)) marketplaces.push(p.store);
    /* One marketplace is not a choice. */
    if (marketplaces.length < 2) return '';
    return '<span class="hctl"><label class="lbl" for="mkt">Marketplace</label>'
      + '<select id="mkt"><option value="">All marketplaces</option>'
      + marketplaces.map(m => '<option value="' + esc(m) + '"'
        + (state.filters.marketplace === m ? ' selected' : '') + '>' + esc(m) + '</option>').join('')
      + '</select></span>';
  }

  function currencySelect() {
    const all = [...new Set(['USD', ...state.previews.map(p => p.currency),
      ...state.imports.map(i => i.currency)])].filter(Boolean);
    /* Nor is one currency. The figures still say which it is, beside them. */
    if (all.length < 2) return '';
    return '<span class="hctl"><label class="lbl" for="cur">Currency</label>'
      + '<select id="cur">' + all.map(c => '<option' + (c === state.filters.currency ? ' selected' : '')
        + '>' + esc(c) + '</option>').join('') + '</select></span>';
  }

  /* How old the balance behind every payout figure is. Stated in the header
     because a stale balance quietly makes everything below it stale too. */
  function balancePill() {
    const bal = latestBalance(state.filters.account || 'Standard Orders');
    if (!bal) {
      return '<button class="pill is-warn" id="updbal-pill" title="Record your Amazon balance">'
        + ico('missing', { size: 'sm' }) + 'No balance recorded</button>';
    }
    const day = String(bal.observedAt || '').slice(0, 10);
    const when = bal.recordedAt && day === state.today
      ? new Date(bal.recordedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : null;
    if (day === state.today) {
      return '<span class="pill is-ok" title="Recorded by hand from Seller Central">'
        + ico('asOf', { size: 'sm' }) + 'Balance today' + (when ? ', ' + esc(when) : '') + '</span>';
    }
    return '<span class="pill is-warn" title="Every payout figure uses this balance. '
      + 'Record a newer one if Seller Central has moved on.">' + ico('asOf', { size: 'sm' })
      + 'Balance as of ' + esc(fmtDay(day)) + '</span>';
  }

  function topControls() {
    const s = state.screen;
    let html = '';
    if (RANGED.has(s)) html += periodSelect();
    else html += activePeriodPill();
    if (s === 'dashboard' || s === 'forecast') html += accountSelect(false);
    if (s === 'expenses' || s === 'profit') html += accountSelect(true);
    html += marketplaceSelect() + currencySelect();
    if (s !== 'plan' && s !== 'data') html += balancePill();

    if (s === 'dashboard') html += '<button class="btn sec" id="updbal">Update balance</button>';
    if (s === 'forecast') html += '<button class="btn sec" id="h-saverun">Save forecast run</button>';
    if (s === 'plan') html += '<button class="btn" id="h-addcommit">' + ico('add', { size: 'sm' })
      + 'Add commitment</button>';
    if (s === 'data') html += '<button class="btn sec" id="importbtn">' + ico('upload', { size: 'sm' })
      + 'Import files</button>';
    /* The thing this app exists to do. v3 leaves it out of the header; it is
       kept, because a redesign is not a reason to hide the main action. */
    if (state.workerInfo) html += refreshButton();
    return html;
  }

  /* The screen that was on display last time this ran. Scrolling to the top
     belongs to CHANGING screens, not to redrawing the one you are reading. */
  let lastDrawn = null;

  /* The update bar: the one thing in this app that has to be noticed.

     It sat in the About panel, collapsed, below the mirror - so an update
     could download, sit ready for days, and never be applied, because there
     was nothing to see. Now a ready update says so at the top of every tab
     until it is installed or the app is restarted. Nothing else earns that
     spot: checking quietly and being up to date are both invisible. */
  function updateBar() {
    const sh = state.shell;
    if (!sh || !sh.updates) return '';
    const u = sh.updates;

    if (u.ready) {
      return '<div class="updbar is-ready">' + ico('verified')
        + '<span class="grow"><b>Version ' + esc(u.readyVersion || '')
        + ' is downloaded and ready.</b> It installs when the app restarts '
        + '\u2014 about ten seconds.</span>'
        + '<button class="btn sm" data-installupdate="1">Restart and '
        + 'install</button></div>';
    }

    /* Downloading is worth showing because it explains the disk and network
       activity, and because it is the state people catch mid-flight and
       assume has stalled. */
    if (u.state === 'available') {
      return '<div class="updbar is-working">' + ico('download')
        + '<span class="grow"><b>Downloading an update\u2026</b> '
        + esc(u.detail || 'It will install itself when you restart.')
        + '</span></div>';
    }
    return '';
  }

  /* The sidebar's Data status card: every input the figures stand on, and how
     fresh it is, in view on every screen. Each row says what is there - never
     a tick for something that is merely configured.

     Bank deposits are counted as RECORDED, not matched: matching needs the
     full reconciliation run, and a count that was not computed is not shown. */
  function dataStatus(readyN, totalN) {
    const ds = dataset();
    const row = (label, value, kind) => '<span class="ds-r"><span class="dot'
      + (kind ? ' is-' + kind : '') + '"></span>' + esc(label) + '<b>' + esc(value) + '</b></span>';

    const led = ds.actual && ds.actual.sourceRange;
    const tx = led && led.to ? row('Transactions', 'to ' + fmtShortDay(led.to), 'ok')
      : row('Transactions', 'None', null);

    const cov = previewCoverage();
    const fc = !cov ? row('Forecast', 'None', null)
      : row('Forecast', cov.coveredDays + '/' + cov.totalDays + ' days',
        cov.complete ? 'ok' : 'warn');

    const bal = latestBalance(state.filters.account || 'Standard Orders');
    let bl;
    if (!bal) bl = row('Balance', 'None', 'warn');
    else {
      const day = String(bal.observedAt || '').slice(0, 10);
      bl = day === state.today
        ? row('Balance', bal.recordedAt ? new Date(bal.recordedAt).toLocaleTimeString([],
          { hour: 'numeric', minute: '2-digit' }) : 'Today', 'ok')
        : row('Balance', fmtShortDay(day), 'warn');
    }

    const nDep = state.bankDeposits.length;
    const dep = nDep ? row('Bank deposits', nDep + ' recorded', 'ok')
      : row('Bank deposits', 'None', null);

    return '<span class="ds-t">Data status</span>' + tx + fc + bl + dep
      + (ds.anyData ? '<button type="button" class="ds-r" data-go="data" '
        + 'title="Each feature needs certain data. Data & Assumptions lists what is still missing."'
        + ' style="background:none;border:0;padding:0;text-align:left;cursor:pointer;'
        + 'color:var(--ink-3);font:inherit;font-size:var(--t-tag)">'
        + readyN + ' of ' + totalN + ' features have their data \u00b7 '
        + '<span style="color:var(--accent)">see what\u2019s missing</span></button>' : '');
  }

  function render() {
    /* While a download is running this redraws every three seconds. It used to
       end with scrollTo(0, 0), which meant the page snatched itself back to
       the top before anything below the fold could be read - the list of jobs
       being the very thing worth watching. So where the reader is, and what
       they are typing in, are put back afterwards. */
    const wasScreen = lastDrawn;
    const keepY = window.scrollY || window.pageYOffset || 0;

    /* ...and anything typed into a hand-entry form but not saved yet. The
       page redraws every few seconds during a download; without this a half
       typed deposit vanished mid-word. Only forms that opt in, and never a
       password field. */
    const typed = [];
    for (const el of document.querySelectorAll('[data-keeptyped] input[id], [data-keeptyped] textarea[id], [data-keeptyped] select[id]')) {
      if (el.type === 'file' || el.type === 'password' || el.type === 'checkbox') continue;
      const changed = el.tagName === 'SELECT'
        ? [...el.options].some(o => o.selected !== o.defaultSelected)
        : el.value !== el.defaultValue;
      if (changed) typed.push([el.id, el.value]);
    }

    const active = document.activeElement;
    const keepFocus = active && active.id
      && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName) ? active.id : null;
    let keepStart = null, keepEnd = null;
    if (keepFocus) {
      try { keepStart = active.selectionStart; keepEnd = active.selectionEnd; }
      catch (e) { /* a select has no selection range */ }
    }

    M.setCurrency(state.filters.currency);
    const sc = screenById(state.screen);
    $('#pagetitle').textContent = sc.title;
    const blurb = $('#pageblurb');
    if (blurb) blurb.textContent = sc.blurb || '';

    const ub = $('#updatebar');
    if (ub) ub.innerHTML = updateBar();

    $('#topcontrols').innerHTML = topControls();
    $('#rangebar').innerHTML = rangeControl();

    /* A screen that throws used to leave the page half-rendered and silent:
       the title updated, the view and the navigation did not, and the reader
       saw the previous tab's content under the new tab's heading. Now the
       failure is shown, and the rest of the chrome still renders. */
    let body;
    try {
      const ds = dataset();
      body = ds.hiddenByRange && state.screen !== 'data'
        ? rangeEmptyCard(ds)
        : (screens[state.screen] || screens.dashboard)();
    } catch (e) {
      body = '<div class="note is-error">' + ico('missing') + '<div>'
        + '<b>This screen could not be drawn.</b> Your imported data is not affected — '
        + 'nothing has been changed or deleted. Other tabs may still work.'
        + '<div class="meta" style="margin-top:8px">' + esc(String(e && e.message ? e.message : e))
        + '</div></div></div>';
      if (typeof console !== 'undefined' && console.error) console.error(e);
    }
    $('#view').innerHTML = (state.screen === 'dashboard' ? setupCard() : '') + body + dateBasisNote();
    const sm = $('#setupmodal');
    if (sm) sm.innerHTML = setupModal();

    const rd = dataset().readiness;
    const readyN = Dataset.ready(rd).length, blockedN = Dataset.blocking(rd).length;

    /* Grouped as v3 groups them. The count on Data & Assumptions is the
       number of inputs still blocking a figure - so it points at work, not
       at a vague "setup". */
    let navHtml = '', lastGroup = null;
    for (const s of SCREENS) {
      if (s.group !== lastGroup) {
        navHtml += '<div class="navgroup" aria-hidden="true">' + esc(s.group) + '</div>';
        lastGroup = s.group;
      }
      const badge = s.id === 'data' && dataset().anyData && blockedN > 0
        ? '<span class="navbadge" title="' + blockedN + ' input' + (blockedN === 1 ? '' : 's')
          + ' still needed">' + blockedN + '</span>' : '';
      navHtml += '<button data-go="' + s.id + '"' + (s.id === state.screen ? ' aria-current="page"' : '')
        + '>' + ico(s.icon) + '<span>' + esc(s.name) + '</span>' + badge + '</button>';
    }
    $('#sidenav').innerHTML = navHtml;
    /* Every screen is reachable on a phone — the bar scrolls rather than
       hiding the last two behind a "More" that nobody finds. */
    $('#tabbar').innerHTML = SCREENS.map(s =>
      '<button data-go="' + s.id + '"' + (s.id === state.screen ? ' aria-current="page"' : '') + '>'
      + ico(s.icon) + '<span>' + esc(s.short) + '</span></button>').join('');

    $('#sidenote').innerHTML = dataStatus(readyN, rd.length);

    if (state.ask.open) askPanel();

    if (wasScreen !== state.screen) {
      window.scrollTo(0, 0);              // a NEW screen starts at the top
    } else if (keepY) {
      /* The page may have grown or shrunk; the browser clamps this for us. */
      window.scrollTo(0, keepY);
    }
    lastDrawn = state.screen;

    for (const [id, v] of typed) {
      const el = document.getElementById(id);
      if (el && el.closest('[data-keeptyped]')) el.value = v;
    }

    if (keepFocus) {
      const back = document.getElementById(keepFocus);
      if (back && back !== document.activeElement) {
        try {
          back.focus({ preventScroll: true });
          if (keepStart !== null && back.setSelectionRange) {
            back.setSelectionRange(keepStart, keepEnd);
          }
        } catch (e) { /* not focusable any more */ }
      }
    }
  }

  function go(id) { state.screen = id; state.tab = null; render(); }

  function jumpTo(id) {
    const t = document.getElementById(id);
    if (!t) return;
    t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const f = t.querySelector('input:not([type=hidden]), select, textarea');
    if (f) f.focus({ preventScroll: true });
  }

  /* ── events ──────────────────────────────────────────────────────────── */

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-go]');
    if (t) {
      go(t.getAttribute('data-go'));
      const then = t.getAttribute('data-then');
      if (then) setTimeout(() => jumpTo(then), 60);
      return;
    }
    const t2 = e.target.closest('[data-tab]');
    if (t2) { state.tab = t2.getAttribute('data-tab'); render(); return; }

    const jmp = e.target.closest('[data-jump]');
    if (jmp) { jumpTo(jmp.getAttribute('data-jump')); return; }
    if (handleInputClick(e)) return;
    const pfl = e.target.closest('[data-pfilter]');
    if (pfl) { state.profitFilter = pfl.getAttribute('data-pfilter'); render(); return; }
    const exAll = e.target.closest('[data-expandall]');
    if (exAll) {
      let names = [];
      try { names = JSON.parse(exAll.getAttribute('data-expandall') || '[]'); } catch (err) { names = []; }
      if (names.length) for (const n of names) state.expanded[n] = true;
      else for (const k of Object.keys(state.expanded)) state.expanded[k] = false;
      render();
      return;
    }
    const ex = e.target.closest('[data-expand]');
    if (ex) {
      const k = ex.getAttribute('data-expand');
      state.expanded[k] = !state.expanded[k];
      render();
      return;
    }

    if (e.target.closest('#runselftest')) { runSelfTest(); return; }
    if (e.target.closest('#opendltest')) { state.dlTestOpen = true; render(); return; }
    if (e.target.closest('#canceldltest')) {
      state.dlTestOpen = false; state.dlTest = null; render(); return;
    }
    if (e.target.closest('#startdltest')) { startDownloadTest(); return; }

    const fix = e.target.closest('[data-fix]');
    if (fix) {
      const kind = fix.getAttribute('data-fix');
      if (kind === 'open-local') window.open('http://127.0.0.1:8765/', '_blank', 'noopener');
      else if (kind === 'download-installer') downloadInstaller();
      else if (kind === 'goto-setup') {
        go('data');
        setTimeout(() => {
          const b = document.querySelector('[data-setup]');
          if (b) b.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
      } else if (kind === 'goto-download-test') {
        state.dlTestOpen = true; render();
        setTimeout(() => {
          const el = document.querySelector('#startdltest');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
      } else if (kind === 'explain-migration') {
        go('data');
        setTimeout(() => {
          const b = document.querySelector('#exportbtn');
          if (b) b.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 200);
      } else if (kind === 'rerun') runSelfTest();
      return;
    }

    if (e.target.closest('[data-startall]')) { startAll(); return; }
    const mkt = e.target.closest('[data-mkt]');
    if (mkt) {
      const name = mkt.getAttribute('data-mkt');
      const cur = selectedMarketplaces().slice();
      const i = cur.indexOf(name);
      if (i >= 0) cur.splice(i, 1); else cur.push(name);
      state.marketplaces = cur;
      saveDownloadSettings();
      return;
    }
    if (e.target.closest('#watchworker')) { watchForWorker(); return; }
    if (e.target.closest('#openlocal')) {
      window.open('http://127.0.0.1:8765/', '_blank', 'noopener');
      return;
    }
    if (e.target.closest('#getinstaller')) { downloadInstaller(); return; }
    /* Picking one report deliberately means only that report: it must not
       run on into the next one the way Start does. */
    const su = e.target.closest('[data-setup]');
    if (su) state.startChain = false;
    if (su) { chooseProfileThenSetup(su.getAttribute('data-setup')); return; }
    const sg = e.target.closest('[data-setupgo]');
    if (sg) {
      const k = sg.getAttribute('data-setupgo');
      if (k === 'profile') {
        /* Not yet a live session: start it now with the chosen profile. */
        const rt = state.setup && state.setup.reportType;
        setupStart(rt, ($('#su-prof') || {}).value || null);
      } else if (k === 'text') setupAnswer(($('#su-text') || {}).value || '');
      else if (k === 'fmt') setupAnswer(($('#su-fmt') || {}).value || 'MM/DD/YYYY');
      else if (k === 'range') setupAnswer((($('#su-range') || {}).value || '').trim());
      else if (k === 'ack') setupAnswer(true);
      else if (k === 'yes') setupAnswer(true);
      else if (k === 'no') setupAnswer(false);
      else setupAnswer(k === 'gen-yes');
      return;
    }
    if (e.target.closest('#setupsave')) { setupSave(); return; }
    if (e.target.closest('#setupcancel')) {
      state.worker.setupCancel().catch(() => {});
      state.setup = null; render(); return;
    }

    const dl = e.target.closest('[data-dl]');
    if (dl && !dl.disabled) { startDownload(dl.getAttribute('data-dl')); return; }
    const rt = e.target.closest('[data-retry]');
    if (rt) {
      state.worker.retry(rt.getAttribute('data-retry'))
        .then(refreshJobs).then(render).catch(() => render());
      return;
    }

    if (e.target.closest('[data-setupskip]')) {
      state.setupOpen = false; state.setupSkipped = true; state.mirrorSaid = null; render(); return;
    }
    if (e.target.closest('[data-setupopen]')) {
      state.setupOpen = true; state.mirrorSaid = null; render();
      setTimeout(() => { const f = $('#sburl') || $('#sbwrite'); if (f) f.focus(); }, 40);
      return;
    }
    const mir = e.target.closest('[data-mirror]');
    if (mir) {
      const what = mir.getAttribute('data-mirror');

      if (what === 'reload') { state.mirrorLoad = 'loading'; render(); loadMirror(); return; }

      if (what === 'forget') {
        state.worker.mirrorForget()
          .then(r => { state.mirror = r; state.mirrorSaid = null; stopCloudSync(); })
          .catch(err => { state.mirrorSaid = { ok: false, detail: err.message }; })
          .then(render);
        return;
      }

      if (what === 'writeforget') {
        state.worker.mirrorWriteKeyForget()
          .then(r => { state.mirror = r; state.mirrorSaid = null; stopCloudSync(); })
          .catch(err => { state.mirrorSaid = { ok: false, detail: err.message }; })
          .then(render);
        return;
      }

      if (what === 'writekey') {
        const wk = (($('#sbwrite') || {}).value || '').trim();
        state.mirrorBusy = 'writekey'; render();
        state.worker.mirrorWriteKey(wk)
          .then(r => {
            state.mirror = r;
            state.mirrorSaid = { ok: true, detail: r.autoPush !== false
              ? 'This computer may now write. Your reports are being sent now; '
                + 'this panel shows the result when it is done.'
              : 'This computer may now write. Nothing has been sent yet - use '
                + '\u201cSend now\u201d.' };
            refreshMirrorSoon();
            startCloudSync();
          })
          .catch(err => { state.mirrorSaid = { ok: false, detail: err.message }; })
          .then(() => { state.mirrorBusy = ''; render(); });
        return;
      }

      /* A real upload of real rows. It reports what actually landed, and a
         push that stopped half way is a failure carrying its own count -
         never "done" with some of the reports missing. */
      if (what === 'push') {
        state.mirrorBusy = 'pushing'; render();
        state.worker.mirrorPush()
          .then(r => {
            state.mirrorSaid = { ok: !!r.ok, detail: r.detail };
            return state.worker.mirror();
          })
          .then(m => { state.mirror = m; })
          .catch(err => { state.mirrorSaid = { ok: false, detail: err.message }; })
          .then(() => { state.mirrorBusy = ''; render(); });
        return;
      }

      if (what === 'test') {
        state.mirrorBusy = 'testing'; render();
        state.worker.mirror()
          .then(m => { state.mirror = m; state.mirrorSaid = m.lastResult || null; })
          .catch(err => { state.mirrorSaid = { ok: false, detail: err.message }; })
          .then(() => { state.mirrorBusy = ''; render(); });
        return;
      }

      /* Save. The URL is kept on screen if this fails, because retyping it
         after a rejected key is pure punishment. The key is not: it is a
         credential, and leaving it in a field is how it ends up in a
         screenshot. */
      const url = ($('#sburl') || {}).value || '';
      const key = ($('#sbkey') || {}).value || '';
      state.mirrorUrl = url.trim();
      state.mirrorBusy = 'saving'; render();
      state.worker.mirrorSave(url.trim(), key.trim())
        .then(saved => {
          state.mirror = saved;
          state.mirrorSaid = { ok: true, detail:
            'Connected. The project answered, so this is a real connection '
            + 'and not just a saved setting.' };
          state.mirrorUrl = '';
        })
        .catch(err => {
          state.mirrorSaid = { ok: false, detail: err.message };
        })
        .then(() => { state.mirrorBusy = ''; render(); });
      return;
    }

    const iu = e.target.closest('[data-installupdate]');
    if (iu && window.desktopShell && window.desktopShell.install) {
      iu.disabled = true;
      iu.textContent = 'Installing…';
      window.desktopShell.install().catch(() => render());
      return;
    }

    const cu = e.target.closest('[data-checkupdates]');
    if (cu && window.desktopShell) {
      window.desktopShell.check()
        .then(info => { state.shell = info; render(); })
        .catch(() => render());
      return;
    }

    const pick = e.target.closest('[data-stateuse]');
    if (pick) {
      const which = pick.getAttribute('data-stateuse');
      const conflict = state.stateConflict;
      state.stateConflict = null;
      if (!conflict) { render(); return; }
      if (which === 'theirs') {
        /* Take the saved copy. This window's version is still in this
           browser's own storage until the next save replaces it. */
        applyStateDoc(conflict.theirs);
        state.stateRevision = conflict.revision;
        state.stateNote = 'Now showing the copy saved by the other window.';
        bumpForecast();
        persist().then(render);
      } else {
        /* Keep this window's. Saving on TOP of their revision, so it is a
           deliberate replacement rather than a second collision. */
        state.stateRevision = conflict.revision;
        state.stateNote = 'Kept what was in this window; it has replaced the '
          + 'other copy. The previous version is still in the database\u2019s '
          + 'history.';
        persist().then(render);
      }
      return;
    }

    const jd = e.target.closest('[data-jobdel]');
    if (jd) { state.confirmJob = jd.getAttribute('data-jobdel'); render(); return; }
    const jn = e.target.closest('[data-jobdelno]');
    if (jn) { state.confirmJob = null; render(); return; }
    const jy = e.target.closest('[data-jobdelyes]');
    if (jy) {
      const id = jy.getAttribute('data-jobdelyes');
      /* Found BEFORE the delete, because once the report is gone there is
         nothing left to match the import against. */
      const imp = state.imports.find(i => i.jobId === id);
      state.confirmJob = null;
      state.worker.remove(id)
        .then(res => {
          if (res && res.archived) refreshMirrorSoon();
          /* Reported, not assumed. The helper says what it actually removed:
             a file it did not put there is left alone and says so. */
          const rows = imp ? ' and the ' + (imp.rowCount || 0).toLocaleString()
            + ' rows it put in the app' : '';
          state.jobNote = res && res.fileKept
            ? res.fileKept
            : (res && res.fileDeleted
              ? 'Deleted the report, ' + res.fileDeleted + rows + '.'
              : 'Deleted the report' + rows + '.');
        })
        .catch(err => { state.jobNote = 'Could not delete it: ' + (err && err.message || err); })
        /* Only once the helper has answered. Removing the figures first would
           leave the pages empty while the report was still listed. */
        .then(() => imp ? removeImport(imp.id) : null)
        .then(refreshJobs).then(render);
      return;
    }

    const pre = e.target.closest('[data-preset]');
    if (pre) { applyPreset(pre.getAttribute('data-preset')); return; }

    const vr = e.target.closest('[data-viewreport]');
    if (vr) {
      state.viewReport = vr.getAttribute('data-viewreport') || null;
      go('data');
      return;
    }

    const vp = e.target.closest('[data-viewperiod]');
    if (vp) {
      const [from, to] = vp.getAttribute('data-viewperiod').split('|');
      state.filters.from = from || null;
      state.filters.to = to || null;
      const scr = vp.getAttribute('data-viewscreen');
      if (scr) { go(scr); return; }
      render();
      return;
    }

    const cf = e.target.closest('[data-conflict]');
    if (cf) { resolveConflict(cf.getAttribute('data-conflict')); return; }
    if (e.target.closest('#syncnow')) { syncReconcile().then(render); return; }

    if (e.target.closest('#importbtn')) { go('data'); return; }

    /* Header actions (v3). Each lands on the thing it names, focused, rather
       than on a screen you then have to search. */
    if (e.target.closest('#cancelbal')) { state.balanceFormOpen = false; render(); return; }
    const rs = e.target.closest('[data-reqshift]');
    if (rs) {
      const cur = state.requestDate || CSV.addDays(state.today, 1);
      const next = CSV.addDays(cur, +rs.getAttribute('data-reqshift'));
      /* Never before today: a request cannot be planned in the past. */
      state.requestDate = next < state.today ? state.today : next;
      render(); return;
    }
    const rq = e.target.closest('[data-reqdate]');
    if (rq) { state.requestDate = rq.getAttribute('data-reqdate'); render(); return; }
    if (e.target.closest('#updbal, #updbal-pill, [data-updbal]')) {
      state.balanceFormOpen = true;
      if (state.screen !== 'dashboard') go('dashboard'); else render();
      setTimeout(() => {
        const f = $('#b-available');
        if (f) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); f.focus({ preventScroll: true }); }
      }, 60);
      return;
    }
    if (e.target.closest('#h-addcommit')) {
      const f = $('#c-label');
      if (f) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); f.focus({ preventScroll: true }); }
      return;
    }
    if (e.target.closest('#h-saverun')) {
      const fc = currentForecast(state.filters.account || 'Standard Orders', 'base');
      if (fc) { state.forecastRuns.push(fc); persist(); render(); }
      return;
    }
    if (e.target.closest('#gocompare')) {
      const c = $('#comparecard');
      if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (e.target.closest('#askbtn')) { toggleAsk(true); return; }
    if (e.target.closest('#askclose') || e.target.closest('#scrim')) { toggleAsk(false); return; }
    const q = e.target.closest('[data-askq]');
    if (q) { askClaude(q.getAttribute('data-askq')); return; }
    if (e.target.closest('#asksend')) {
      const ta = $('#askinput');
      const text = ta && ta.value.trim();
      if (text) { ta.value = ''; askClaude(text); }
      return;
    }
    if (e.target.closest('#askclear')) { state.ask.turns = []; state.ask.error = null; askPanel(); return; }
    if (e.target.closest('#askconnect')) { connectClaude(); return; }
    if (e.target.closest('#askforget')) { forgetClaude(); return; }

    const removeAsk = e.target.closest('[data-removeask]');
    if (removeAsk) { state.confirmRemove = removeAsk.getAttribute('data-removeask'); render(); return; }
    if (e.target.closest('[data-removeno]')) { state.confirmRemove = null; render(); return; }
    const removeYes = e.target.closest('[data-removeyes]');
    if (removeYes) {
      const id = removeYes.getAttribute('data-removeyes');
      if (id === '__all__') removeEverything(); else removeImport(id);
      return;
    }

    if (e.target.closest('#savebalance')) {
      state.balanceSnapshots.push({
        id: 'bal-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
        account: $('#b-acct').value,
        available: cents($('#b-available').value), deferred: cents($('#b-deferred').value),
        reserve: cents($('#b-reserve').value), inTransit: cents($('#b-transit').value),
        observedAt: $('#b-asof').value, source: 'entered by hand from Seller Central',
        recordedAt: new Date().toISOString(),
      });
      state.balanceFormOpen = false;
      bumpForecast(); persist(); render(); return;
    }
    const delBal = e.target.closest('[data-delbal]');
    if (delBal) {
      const id = delBal.getAttribute('data-delbal');
      const before = state.balanceSnapshots.length;
      state.balanceSnapshots = state.balanceSnapshots.filter(b => balId(b) !== id);
      if (state.balanceSnapshots.length !== before) { bumpForecast(); persist(); render(); }
      return;
    }
    if (e.target.closest('#savepolicy')) {
      const v = id => $('#' + id).value;
      state.policy = Object.assign(Cash.emptyPolicy(), state.policy, {
        nextScheduledPayout: v('p-next') || null,
        scheduleIntervalDays: v('p-interval') ? +v('p-interval') : null,
        cooldownDays: v('p-cooldown') === '' ? null : +v('p-cooldown'),
        partialRequestsSupported: v('p-partial') === '' ? null : v('p-partial') === 'yes',
        scheduleResetsOnRequest: v('p-reset') === '' ? null : v('p-reset') === 'yes',
        bankTransitDaysLow: v('p-transit-lo') === '' ? null : +v('p-transit-lo'),
        bankTransitDaysHigh: v('p-transit-hi') === '' ? null : +v('p-transit-hi'),
        source: 'entered by hand from the account', observedAt: new Date().toISOString(),
      });
      bumpForecast(); persist(); render(); return;
    }
    if (e.target.closest('#saveanchor')) {
      const d = $('#anchordate').value;
      if (d) {
        state.policy.nextScheduledPayout = d;
        if (state.policy.scheduleIntervalDays == null) state.policy.scheduleIntervalDays = 14;
        persist(); render();
      }
      return;
    }
    if (e.target.closest('#addplan')) {
      const d = $('#np-date').value;
      if (d) {
        state.requestPlans.push({ id: 'plan-' + Date.now(),
          account: state.filters.account || 'Standard Orders', date: d,
          mode: $('#np-mode').value, amount: cents($('#np-amount').value),
          createdAt: new Date().toISOString(), executed: false });
        persist(); render();
      }
      return;
    }
    const delPlan = e.target.closest('[data-delplan]');
    if (delPlan) {
      state.requestPlans = state.requestPlans.filter(p => p.id !== delPlan.getAttribute('data-delplan'));
      bumpForecast(); persist(); render(); return;
    }
    if (e.target.closest('#savebank')) {
      const was = state.openingBankCash;
      state.openingBankCash = cents($('#bank-open').value);
      /* A changed figure is a new reading, so it gets today's date. An
         unchanged one keeps the date it was really read on. */
      if (state.openingBankCash !== was || !state.cashPlan.bankCashAt) {
        state.cashPlan = Object.assign({}, state.cashPlan,
          { bankCashAt: state.openingBankCash == null ? null : state.today });
      }
      bumpForecast(); persist(); render(); return;
    }
    if (e.target.closest('#savebuffer')) {
      const b = $('#bank-buffer');
      state.cashPlan = Object.assign({}, state.cashPlan, { buffer: b ? cents(b.value) : null });
      persist(); render(); return;
    }
    if (e.target.closest('#addcommit')) {
      const amt = cents($('#c-amount').value), label = $('#c-label').value.trim(), due = $('#c-due').value;
      if (amt != null && label && due) {
        state.cashCommitments.push({ label, amount: amt, due, kind: 'bill', confirmed: false });
        persist(); render();
      }
      return;
    }
    if (e.target.closest('#dupscan')) {
      const b = e.target.closest('#dupscan');
      b.disabled = true; b.textContent = 'Scanning…';
      setTimeout(() => { state.ledger._dupCache = state.ledger.duplicateReport(); render(); }, 20);
      return;
    }
    if (e.target.closest('#saverun')) {
      const fc = currentForecast(state.filters.account || 'Standard Orders', 'base');
      if (fc) { state.forecastRuns.push(fc); persist(); render(); }
      return;
    }
    if (e.target.closest('#exportbtn')) { exportBackup(); return; }
  });

  document.addEventListener('change', e => {
    const id = e.target.id;
    if (id === 'mirrorauto' && state.worker) {
      const on = !!e.target.checked;
      state.mirrorBusy = 'auto'; render();
      state.worker.mirrorAuto(on)
        .then(r => {
          state.mirror = Object.assign({}, state.mirror, r);
          state.mirrorSaid = { ok: true, detail: on
            ? 'Sending automatically. Anything not sent yet goes in a few seconds.'
            : 'Automatic sending is off. Nothing is sent until you press \u201cSend now\u201d.' };
          if (on) refreshMirrorSoon();
        })
        .catch(err => { state.mirrorSaid = { ok: false, detail: err.message }; })
        .then(() => { state.mirrorBusy = ''; render(); });
      return;
    }
    if (id === 'reqdate') { state.requestDate = e.target.value; render(); }
    if (id === 'acctsel' || id === 'f-acct' || id === 'h-acct') {
      state.filters.account = e.target.value || null; render();
    }
    if (id === 'g-preset') {
      const v = e.target.value;
      if (v === 'custom') {
        /* Opens the From / To row, pre-filled with whatever period was in
           force - so choosing "Custom" alone never changes the figures. */
        state.rangeCustomOpen = true;
        state.filters.preset = null;
        render();
        setTimeout(() => { const f = $('#g-from'); if (f) f.focus(); }, 30);
      } else {
        applyPreset(v);
      }
    }
    if (id === 'cur') { state.filters.currency = e.target.value; persist(); render(); }
    if (id === 'mkt') { state.filters.marketplace = e.target.value || null; render(); }
    if (id === 'f-from' || id === 'g-from') {
      state.filters.from = e.target.value || null; state.filters.preset = null;
      bumpForecast(); persist(); render();
    }
    if (id === 'f-to' || id === 'g-to') {
      state.filters.to = e.target.value || null; state.filters.preset = null;
      bumpForecast(); persist(); render();
    }
    if (id === 'dl-acct') { state.accountType = e.target.value; saveDownloadSettings(); }
    if (id === 'dl-skurange') { state.skuDateRange = e.target.value; saveDownloadSettings(); }
    if (id === 'dl-skumkt') { state.skuMarketplace = e.target.value; saveDownloadSettings(); }
    if (id === 'filepick' || (e.target.hasAttribute && e.target.hasAttribute('data-filepick'))) {
      (async () => { for (const f of Array.from(e.target.files)) await importFile(f); })();
    }
    if (id === 'restorepick') {
      const f = e.target.files[0];
      if (f) f.text().then(async t => {
        try {
          const d = JSON.parse(t);
          if (d.format !== 'fba-cash-organizer/backup') throw new Error('not a backup file');
          const previews = Store.decodePreviews(d.previews || []);
          const restoredLedger = d.ledger ? Store.deserialiseLedger(Sync.decode(d.ledger), Ledger) : null;
          if (d.ledger && !restoredLedger) throw new Error('Transaction ledger could not be decoded. Existing data was kept.');
          if (state.imports.length && !confirm('Restore replaces the current dataset. Export a backup first if you need to keep it. Continue?')) return;
          Object.assign(state, {
            previews, ledger: restoredLedger,
            openingBankCash: d.openingBankCash == null ? null : d.openingBankCash,
            cashPlan: Object.assign({ buffer: null, bankCashAt: null }, d.cashPlan || {}),
            imports: d.imports || [],
            balanceSnapshots: d.balanceSnapshots || [], deferredSnapshots: d.deferredSnapshots || [],
            policy: Object.assign(Cash.emptyPolicy(), d.policy || {}),
            requestPlans: d.requestPlans || [], productCosts: d.productCosts || [],
            operatingCosts: d.operatingCosts || [], cashCommitments: d.cashCommitments || [],
            settlements: d.settlements || [], bankDeposits: d.bankDeposits || [],
            advertisingBilling: d.advertisingBilling || [], forecastRuns: d.forecastRuns || [],
          });
          bumpForecast();
          if (state.db) {
            if (restoredLedger) { if (!await persistLedger()) throw new Error('Could not save restored transactions.'); }
            else await Store.del(state.db, 'ledgerBlobs', 'ledger');
          }
          await persist(); render();
          state.lastImport = {
            name: f.name, at: new Date().toISOString(),
            message: 'Restored ' + previews.length + ' forecast report'
              + (previews.length === 1 ? '' : 's') + ' and your saved settings. '
              + (restoredLedger ? restoredLedger.rowCount + ' transaction rows restored.' : 'Legacy backup has no transaction rows; re-import its Payments CSV.'),
          };
          render();
        } catch (err) { alert('That file could not be restored: ' + err.message); }
      });
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.ask.open) toggleAsk(false);
    if (e.key === 'Enter' && e.target && e.target.id === 'askkey') { e.preventDefault(); connectClaude(); }
    if (e.key === 'Escape' && state.setupOpen) {
      state.setupOpen = false; state.setupSkipped = true; state.mirrorSaid = null; render();
    }
    /* The shortcut the sidebar advertises. Not while typing in a field, where
       Ctrl+J may mean something to the browser or the text. */
    if ((e.key === 'j' || e.key === 'J') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
        && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '')) {
      e.preventDefault();
      toggleAsk(!state.ask.open);
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.id === 'askinput') {
      const text = e.target.value.trim();
      if (text) { e.target.value = ''; askClaude(text); }
    }
  });

  document.addEventListener('dragover', e => {
    if (!$('#drop')) return;
    e.preventDefault(); $('#drop').classList.add('over');
  });
  document.addEventListener('dragleave', e => {
    if ($('#drop') && !e.relatedTarget) $('#drop').classList.remove('over');
  });
  document.addEventListener('drop', e => {
    if (!$('#drop')) return;
    e.preventDefault(); $('#drop').classList.remove('over');
    for (const f of e.dataTransfer.files) importFile(f);
  });

  /* ── boot ────────────────────────────────────────────────────────────── */

  (async function boot() {
    render();
    state.storage = await Store.probeStorage();
    if (state.storage.available) {
      try { state.db = await Store.open(); await restore(); }
      catch (e) { state.storage = { available: false, durable: false, reason: e.message }; }
    }
    render();
    /* Local data is on screen before the network is consulted, so a slow or
       absent account never delays the app. */
    syncBoot();
    workerBoot();
    shellBoot();
  })();
})();
