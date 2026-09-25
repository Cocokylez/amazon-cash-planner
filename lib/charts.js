/* Charts.
 *
 * Inline SVG, no library. Four forms, each chosen for the job its data does:
 *   bank receipts over eight weeks  -> columns over time, one measure
 *   the payout estimate             -> waterfall, polarity (adds vs takes away)
 *   expense categories              -> horizontal bars, magnitude, ONE series
 *   early vs scheduled              -> grouped columns, two series
 *
 * Drawn in PIXEL units, at the size v3 draws them (a full-width card is 1072
 * wide), and never stretched past that: an SVG in a 0-100 box scaled its text
 * with the card, and at full width axis labels came out 39px tall. Now text is
 * a true 14px on a wide window and only ever scales DOWN on a narrow one.
 *
 * Rules held to throughout: bars sized to their band (v3: 72px weekly columns),
 * with a 4px rounded data-end
 * square at the baseline; solid hairline gridlines (never dashed — dashing on a
 * grid reads as "projection"); a 2px surface gap between adjacent marks; text
 * always in ink tokens, never in the series colour; a legend whenever there are
 * two series; labels placed selectively and only where they fit.
 *
 * Forecast marks are distinguished by fill AND hatch AND legend, so the
 * actual/forecast difference never depends on colour alone.
 *
 * Nothing here invents a value to fill a layout: a chart with no data returns
 * its empty state, naming what is missing.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./money.js'), require('./icons.js'));
  } else root.Charts = factory(root.Money, root.Icons);
})(typeof self !== 'undefined' ? self : globalThis, function (Money, Icons) {

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const BAR_MAX = 24;      // horizontal bars: thickness
  const COL_MAX = 72;      // columns: v3's weekly receipts are 72px wide
  const RADIUS = 4;        // rounded data-end
  const GAP = 2;           // surface gap between touching marks

  /* A column with a rounded cap and a square foot on the baseline. */
  function colPath(x, y, w, h) {
    if (h <= 0.5) return '';
    const r = Math.min(RADIUS, w / 2, h);
    return 'M' + x + ',' + (y + h)
      + 'L' + x + ',' + (y + r)
      + 'Q' + x + ',' + y + ' ' + (x + r) + ',' + y
      + 'L' + (x + w - r) + ',' + y
      + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r)
      + 'L' + (x + w) + ',' + (y + h) + 'Z';
  }
  /* A bar growing rightwards: rounded at the tip, square at the axis. */
  function barPath(x, y, w, h) {
    if (w <= 0.5) return '';
    const r = Math.min(RADIUS, h / 2, w);
    return 'M' + x + ',' + y
      + 'L' + (x + w - r) + ',' + y
      + 'Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r)
      + 'L' + (x + w) + ',' + (y + h - r)
      + 'Q' + (x + w) + ',' + (y + h) + ' ' + (x + w - r) + ',' + (y + h)
      + 'L' + x + ',' + (y + h) + 'Z';
  }

  /* Hatch fill for forecast marks — the second, non-colour channel. */
  const HATCH = '<pattern id="fc-hatch" width="6" height="6" patternUnits="userSpaceOnUse" '
    + 'patternTransform="rotate(45)">'
    + '<rect width="6" height="6" fill="var(--mark-1-soft)"/>'
    + '<line x1="0" y1="0" x2="0" y2="6" stroke="var(--mark-1)" stroke-width="1.6" opacity=".55"/>'
    + '</pattern>';

  function emptyState(title, detail) {
    return '<div class="empty">' + Icons.icon('missing', { size: 'lg' })
      + '<h3>' + esc(title) + '</h3>'
      + (detail ? '<p>' + esc(detail) + '</p>' : '') + '</div>';
  }

  /* Nice round axis ceiling, so ticks land on readable numbers. */
  function niceMax(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / mag;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * mag;
  }
  const short = c => Money.fmtShort(c) || '';

  /* ── 1. bank receipts over eight weeks ───────────────────────────────── */

  /* weeks: [{label, from, to, amount|null, forecast:bool, note}] */
  function bankReceipts(weeks, opts) {
    opts = opts || {};
    const known = weeks.filter(w => w.amount != null);
    if (!known.length) {
      return emptyState(
        opts.emptyTitle || 'No bank receipts can be dated yet',
        opts.emptyDetail || 'This chart plots money arriving in the bank. It needs a current '
        + 'balance, at least one planned request, and bank deposit history to date the arrival.');
    }

    const W = 1072, H = 300, padL = 64, padR = 16, padT = 20, padB = 40;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = niceMax(Math.max(...known.map(w => Math.abs(w.amount))));
    const band = plotW / weeks.length;
    const bw = Math.max(8, Math.min(COL_MAX, band - 14));
    const y0 = padT + plotH;

    let g = '', bars = '', labels = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      g += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 10) + '" y="' + (y + 5) + '" text-anchor="end">'
        + esc(i === 0 ? '0' : short(max * i / 4)) + '</text>';
    }
    weeks.forEach((w, i) => {
      const cx = padL + band * i + band / 2;
      if (w.amount != null) {
        const h = (Math.abs(w.amount) / max) * plotH;
        const x = cx - bw / 2;
        bars += '<path class="ch-bar" d="' + colPath(x, y0 - h, bw, h) + '" '
          + 'fill="' + (w.forecast ? 'url(#fc-hatch)' : 'var(--mark-1)') + '"'
          + (w.forecast ? ' stroke="var(--mark-1)" stroke-width="1.5"' : '') + '>'
          + '<title>' + esc(w.label + ' — ' + (Money.fmt(w.amount) || '')
            + (w.forecast ? ' (forecast)' : ' (actual)')) + '</title></path>';
      } else {
        /* an uncovered week is drawn as an absence, not as zero */
        bars += '<line x1="' + (cx - bw / 2) + '" y1="' + y0 + '" x2="' + (cx + bw / 2) + '" y2="' + y0
          + '" stroke="var(--line-2)" stroke-width="3" stroke-linecap="round">'
          + '<title>' + esc(w.label + ' — ' + (w.note || 'no dated receipt')) + '</title></line>';
      }
      /* Every week is labelled when there is room for it, which at this width
         there is; alternate weeks only when bands get narrow. */
      if (band >= 70 || i % 2 === 0) {
        labels += '<text class="ch-axis" x="' + cx + '" y="' + (H - 14) + '" text-anchor="middle">'
          + esc(w.short || w.label) + '</text>';
      }
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px" role="img" '
      + 'aria-label="' + esc(opts.ariaLabel || 'Bank receipts by week') + '">'
      + '<defs>' + HATCH + '</defs>' + g + bars
      + '<line class="ch-base" x1="' + padL + '" y1="' + y0 + '" x2="' + (W - padR) + '" y2="' + y0 + '"/>'
      + labels + '</svg>'
      + '<div class="legend">'
      + '<span><i class="key solid"></i>Actual receipt</span>'
      + '<span><i class="key fc"></i>Forecast receipt</span>'
      + '<span style="color:var(--ink-3)">A flat line marks a week with nothing dated.</span>'
      + '</div>';
  }

  /* ── 2. waterfall for the payout estimate ────────────────────────────── */

  /* steps: [{label, amount, kind:'start'|'add'|'sub'|'total'}] */
  function waterfall(steps, opts) {
    opts = opts || {};
    const usable = steps.filter(s => s.amount != null);
    if (usable.length < 2) {
      return emptyState('The payout bridge is not available yet',
        'It is built from your opening balance and the movements after it. '
        + 'Record current balances to see it.');
    }

    /* running extent, so the axis covers the whole path */
    let run = 0, lo = 0, hi = 0;
    const laid = steps.map(s => {
      if (s.amount == null) return null;
      if (s.kind === 'start' || s.kind === 'total') {
        const from = 0, to = s.kind === 'start' ? s.amount : run;
        if (s.kind === 'start') run = s.amount;
        lo = Math.min(lo, 0, run); hi = Math.max(hi, run);
        return { ...s, from, to: s.kind === 'start' ? s.amount : run };
      }
      const from = run;
      run += s.amount;
      lo = Math.min(lo, run); hi = Math.max(hi, run);
      return { ...s, from, to: run };
    }).filter(Boolean);

    const max = niceMax(Math.max(Math.abs(hi), Math.abs(lo)));
    const W = 1024, H = 320, padL = 64, padR = 16, padT = 30, padB = 44;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const band = plotW / laid.length;
    const bw = Math.max(8, Math.min(COL_MAX, band - 18));
    const yOf = v => padT + plotH - (v / max) * plotH;

    let g = '', marks = '', labels = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      g += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 10) + '" y="' + (y + 5) + '" text-anchor="end">'
        + esc(i === 0 ? '0' : short(max * i / 4)) + '</text>';
    }
    laid.forEach((s, i) => {
      const cx = padL + band * i + band / 2;
      const x = cx - bw / 2;
      const yA = yOf(Math.max(s.from, s.to)), yB = yOf(Math.min(s.from, s.to));
      const h = Math.max(Math.abs(yB - yA), 2);
      const fill = s.kind === 'total' || s.kind === 'start' ? 'var(--mark-neutral)'
        : s.amount >= 0 ? 'var(--mark-1)' : 'var(--mark-2)';
      marks += '<path class="ch-bar" d="' + colPath(x, yA, bw, h) + '" fill="' + fill + '">'
        + '<title>' + esc(s.label + ' — ' + (Money.fmt(s.amount, { plus: s.kind === 'add' || s.kind === 'sub' }) || '')) + '</title></path>';
      /* connector between steps, hairline and solid */
      if (i < laid.length - 1 && s.kind !== 'total') {
        const yEnd = yOf(s.to);
        marks += '<line x1="' + (x + bw) + '" y1="' + yEnd + '" x2="' + (cx + band - bw / 2) + '" y2="' + yEnd
          + '" stroke="var(--line-2)" stroke-width="1"/>';
      }
      /* label only the start and the total — the rest are read from the tooltip */
      if (s.kind === 'start' || s.kind === 'total') {
        labels += '<text class="ch-val" x="' + cx + '" y="' + (yOf(Math.max(s.from, s.to)) - 8)
          + '" text-anchor="middle">' + esc(short(s.to)) + '</text>';
      }
      labels += '<text class="ch-axis" x="' + cx + '" y="' + (H - 16) + '" text-anchor="middle">'
        + esc(s.short || '') + '</text>';
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px" role="img" '
      + 'aria-label="How the payout estimate is built">'
      + g + marks
      + '<line class="ch-base" x1="' + padL + '" y1="' + yOf(0) + '" x2="' + (W - padR) + '" y2="' + yOf(0) + '"/>'
      + labels + '</svg>'
      + '<div class="legend">'
      + '<span><i class="key solid"></i>Adds to the balance</span>'
      + '<span><i class="key neg"></i>Takes away</span>'
      + '<span><i class="key" style="background:var(--mark-neutral)"></i>Opening and result</span>'
      + '</div>';
  }

  /* ── 3. expense categories ───────────────────────────────────────────── */

  /* ONE series, so one colour for every bar. Shading bars by their own length
     would double-encode magnitude and burn the only free channel. */
  function categoryBars(rows, opts) {
    opts = opts || {};
    if (!rows || !rows.length) {
      return emptyState('No expenses to show for this period',
        'Load the Payments transaction report to see what Amazon charged.');
    }
    const top = rows.slice(0, opts.limit || 9);
    const max = niceMax(Math.max(...top.map(r => Math.abs(r.value))));
    const W = 1072, rowH = 36, labelW = 300, valueW = 150;
    const H = top.length * rowH + 22;

    let out = '<div style="overflow-x:auto"><svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" '
      + 'style="min-width:520px;max-width:' + W + 'px" role="img" aria-label="'
      + esc(opts.ariaLabel || 'Expenses by category') + '">';
    const plotX = labelW, plotW = W - labelW - valueW;
    for (let i = 0; i <= 4; i++) {
      const x = plotX + (plotW * i / 4);
      out += '<line class="ch-grid" x1="' + x + '" y1="8" x2="' + x + '" y2="' + (H - 16) + '"/>';
    }
    top.forEach((r, i) => {
      const y = i * rowH + 8;
      const w = (Math.abs(r.value) / max) * plotW;
      const bh = Math.min(BAR_MAX, rowH - 10);
      out += '<text class="ch-axis" x="' + (labelW - 14) + '" y="' + (y + bh / 2 + 5)
        + '" text-anchor="end">' + esc(r.label.length > 36 ? r.label.slice(0, 35) + '…' : r.label)
        + '<title>' + esc(r.label) + '</title></text>'
        + '<path class="ch-bar" d="' + barPath(plotX, y, w, bh) + '" fill="var(--mark-1)">'
        + '<title>' + esc(r.label + ' — ' + (Money.fmt(r.value) || '')) + '</title></path>'
        + '<text class="ch-val" x="' + (W - valueW + 12) + '" y="' + (y + bh / 2 + 5) + '">'
        + esc(Money.fmt(r.value) || '') + '</text>';
    });
    out += '<line class="ch-base" x1="' + plotX + '" y1="8" x2="' + plotX + '" y2="' + (H - 16) + '"/>';
    out += '</svg></div>';
    if (rows.length > top.length) {
      out += '<div class="meta" style="margin-top:8px">Showing the ' + top.length
        + ' largest of ' + rows.length + ' categories. The full list is in the table below.</div>';
    }
    return out;
  }

  /* ── 4. early requests versus the normal schedule ────────────────────── */

  /* groups: [{label, early, scheduled}] — two series, so a legend is required. */
  function policyCompare(groups, opts) {
    opts = opts || {};
    const usable = (groups || []).filter(g => g.early != null && g.scheduled != null);
    if (!usable.length) {
      return emptyState('The comparison is not available yet',
        'It needs a current balance and a confirmed next scheduled payout date, so both '
        + 'policies can run on the same sales and fee assumptions.');
    }
    const max = niceMax(Math.max(...usable.flatMap(g => [Math.abs(g.early), Math.abs(g.scheduled)])));
    const W = 1072, H = 300, padL = 64, padR = 16, padT = 20, padB = 40;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const band = plotW / usable.length;
    const bw = Math.max(8, Math.min(COL_MAX, (band - 60) / 2));
    const y0 = padT + plotH;

    let g = '', marks = '', labels = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      g += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 10) + '" y="' + (y + 5) + '" text-anchor="end">'
        + esc(i === 0 ? '0' : short(max * i / 4)) + '</text>';
    }
    usable.forEach((grp, i) => {
      const cx = padL + band * i + band / 2;
      const pairs = [
        { v: grp.early, fill: 'var(--mark-1)', name: 'Request early', dx: -(bw + GAP) },
        { v: grp.scheduled, fill: 'var(--mark-2)', name: 'Wait for the schedule', dx: GAP },
      ];
      for (const p of pairs) {
        const h = (Math.abs(p.v) / max) * plotH;
        marks += '<path class="ch-bar" d="' + colPath(cx + p.dx, y0 - h, bw, h) + '" fill="' + p.fill + '">'
          + '<title>' + esc(p.name + ' — ' + grp.label + ' — ' + (Money.fmt(p.v) || '')) + '</title></path>';
      }
      labels += '<text class="ch-axis" x="' + cx + '" y="' + (H - 14) + '" text-anchor="middle">'
        + esc(grp.short || grp.label) + '</text>';
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px" role="img" '
      + 'aria-label="Early requests compared with the normal two-week schedule">'
      + g + marks
      + '<line class="ch-base" x1="' + padL + '" y1="' + y0 + '" x2="' + (W - padR) + '" y2="' + y0 + '"/>'
      + labels + '</svg>'
      + '<div class="legend">'
      + '<span><i class="key solid"></i>Request early</span>'
      + '<span><i class="key neg"></i>Wait for the schedule</span>'
      + '</div>';
  }

  /* ── 5. available to request over time (redesign v3) ─────────────────── */

  /* A line over days: how much could be requested on each one. It rises as
     funds are released and drops to nothing at each planned request - so the
     picture shows at a glance why an earlier request leaves less for later.

     Drawn in PIXEL units rather than the 0-100 box the bar charts use: this
     one carries a dozen text labels, and text that scales with the width is
     unreadable at one end of the range or the other.

     points:   [{date, available, kind, amount}] end-of-event balances, in order;
               the first is the recorded opening snapshot (actual)
     opts:     { today, selected, requests: [{date, amount}],
                 gaps: [{from, to}] - days no Amazon forecast covers }

     Inside a gap the line is still drawn - the engine does compute a figure -
     but grey rather than teal, under a hatched band that says why: it
     excludes days nobody has a forecast for, so it reads low. */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayMs = 864e5;
  const toT = d => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');
  const fromT = t => new Date(t).toISOString().slice(0, 10);
  const mmmd = d => { const p = String(d).slice(0, 10).split('-'); return MON[+p[1] - 1] + ' ' + (+p[2]); };

  function availability(points, opts) {
    opts = opts || {};
    const pts = (points || []).filter(p => p && p.date && p.available != null);
    if (pts.length < 2) {
      return emptyState(opts.emptyTitle || 'Nothing to project yet',
        opts.emptyDetail || 'This chart needs a recorded Amazon balance and at least one '
        + 'imported forecast to show how available funds move from day to day.');
    }
    const requests = (opts.requests || []).filter(r => r && r.date);
    const gaps = (opts.gaps || []).filter(g => g && g.from && g.to);

    /* End-of-day value: the last event of each date wins. */
    const byDay = new Map();
    for (const p of pts) byDay.set(String(p.date).slice(0, 10), p.available);
    const t0 = toT(pts[0].date);
    let t1 = toT(pts[pts.length - 1].date);
    for (const g of gaps) t1 = Math.max(t1, toT(g.to));
    for (const r of requests) t1 = Math.max(t1, toT(r.date));
    if (t1 - t0 < 7 * dayMs) t1 = t0 + 7 * dayMs;

    const daily = [];
    let last = pts[0].available;
    for (let t = t0; t <= t1; t += dayMs) {
      const d = fromT(t);
      if (byDay.has(d)) last = byDay.get(d);
      daily.push({ d, v: last, gap: gaps.some(g => d >= g.from && d <= g.to) });
    }

    /* 680 beside a companion card (dashboard); 1072 across a whole card. */
    const W = opts.wide ? 1072 : 680, H = 360, padL = 58, padR = 18, padT = 40, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = niceMax(Math.max(1, ...daily.map(x => x.v), ...requests.map(r => r.amount || 0)));
    const X = t => padL + ((t - t0) / (t1 - t0)) * plotW;
    const Y = v => padT + plotH - (Math.max(0, v) / max) * plotH;
    const y0 = padT + plotH;

    /* The currency is named once, above the axis - not again on every tick. */
    const num = c => short(c).replace(/^([\-\u2212]?)[^\d]+/, '$1');
    let grid = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - plotH * i / 4;
      grid += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end">'
        + esc(i === 0 ? '0' : num(max * i / 4)) + '</text>';
    }
    grid += '<text class="ch-axis" x="' + (padL - 8) + '" y="' + (padT - 16) + '" text-anchor="end">'
      + esc(opts.currency || 'USD') + '</text>';

    /* x labels: about six, on whole days */
    let xl = '';
    const steps = Math.min(6, daily.length - 1);
    for (let i = 0; i <= steps; i++) {
      const t = t0 + Math.round((t1 - t0) / dayMs * i / steps) * dayMs;
      xl += '<text class="ch-axis" x="' + X(t) + '" y="' + (H - 8) + '" text-anchor="'
        + (i === 0 ? 'start' : i === steps ? 'end' : 'middle') + '">' + esc(mmmd(fromT(t))) + '</text>';
    }

    /* gap bands, named where they are */
    let bands = '';
    for (const g of gaps) {
      const xa = X(Math.max(t0, toT(g.from))), xb = X(Math.min(t1, toT(g.to) + dayMs));
      if (xb - xa < 1) continue;
      bands += '<rect x="' + xa + '" y="' + padT + '" width="' + (xb - xa) + '" height="' + plotH
        + '" fill="url(#av-hatch)"><title>' + esc('No Amazon forecast, ' + mmmd(g.from) + ' – '
        + mmmd(g.to) + '. Figures here exclude these days.') + '</title></rect>'
        + '<text class="ch-axis" x="' + ((xa + xb) / 2) + '" y="' + (padT + 18) + '" text-anchor="middle" '
        + 'style="fill:var(--warn);font-weight:600">No Amazon forecast</text>';
    }

    /* the line, as a step: level through the day, then the move */
    let dCov = '', dGap = '';
    for (let i = 0; i < daily.length; i++) {
      const x = X(t0 + i * dayMs), y = Y(daily[i].v);
      const seg = (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1);
      if (i > 0) {
        const px = X(t0 + i * dayMs), py = Y(daily[i - 1].v);
        const piece = 'M' + X(t0 + (i - 1) * dayMs).toFixed(1) + ',' + py.toFixed(1)
          + 'L' + px.toFixed(1) + ',' + py.toFixed(1) + 'L' + px.toFixed(1) + ',' + y.toFixed(1);
        if (daily[i].gap || daily[i - 1].gap) dGap += piece; else dCov += piece;
      } else dCov += seg;
    }
    const line = '<path d="' + dCov + '" fill="none" stroke="var(--mark-1)" stroke-width="2" '
      + 'stroke-dasharray="6 4" stroke-linejoin="round"/>'
      + (dGap ? '<path d="' + dGap + '" fill="none" stroke="var(--mark-neutral)" stroke-width="2" '
        + 'stroke-dasharray="6 4" stroke-linejoin="round"/>' : '');

    /* markers */
    let marks = '';
    /* Two label rows above the plot, one per marker, so "Today" and the chosen
       date never sit on top of each other when they are a day apart. Near an
       edge a label hangs inwards rather than off the chart or onto the axis. */
    const vline = (t, label, colour, row) => {
      const x = X(t);
      const anchor = x < padL + 90 ? 'start' : x > W - padR - 90 ? 'end' : 'middle';
      const tx = anchor === 'start' ? x + 5 : anchor === 'end' ? x - 5 : x;
      return '<line x1="' + x + '" y1="' + padT + '" x2="' + x + '" y2="' + y0 + '" stroke="' + colour
        + '" stroke-width="1.5"/>'
        + '<text class="ch-axis" x="' + tx + '" y="' + (row === 1 ? padT - 22 : padT - 6)
        + '" text-anchor="' + anchor + '" style="fill:' + colour + ';font-weight:600">'
        + esc(label) + '</text>';
    };
    if (opts.today && toT(opts.today) >= t0 && toT(opts.today) <= t1) {
      marks += vline(toT(opts.today), 'Today', 'var(--ink)', 1);
    }
    if (opts.selected && toT(opts.selected) >= t0 && toT(opts.selected) <= t1
        && opts.selected !== opts.today) {
      marks += vline(toT(opts.selected), 'Selected ' + mmmd(opts.selected), 'var(--accent)', 2);
    }
    /* recorded opening: the one ACTUAL point, drawn solid */
    marks += '<circle cx="' + X(t0) + '" cy="' + Y(pts[0].available) + '" r="5" fill="var(--mark-1)">'
      + '<title>' + esc('Recorded balance, ' + mmmd(pts[0].date) + ': ' + (Money.fmt(pts[0].available) || ''))
      + '</title></circle>';
    for (const r of requests) {
      const t = toT(r.date);
      if (t < t0 || t > t1) continue;
      /* The marker sits at what was available just before the request drew it down. */
      const at = r.amount != null ? r.amount : daily[Math.round((t - t0) / dayMs)].v;
      const x = X(t), y = Y(at);
      marks += '<circle cx="' + x + '" cy="' + y + '" r="5.5" fill="var(--surface)" stroke="var(--ink)" '
        + 'stroke-width="2"><title>' + esc('Planned request, ' + mmmd(r.date) + ': '
          + (Money.fmt(r.amount) || 'amount not set')) + '</title></circle>'
        + '<text class="ch-axis" x="' + x + '" y="' + (y - 22) + '" text-anchor="middle">Request</text>'
        + '<text class="ch-val" x="' + x + '" y="' + (y - 9) + '" text-anchor="middle">'
        + esc(num(r.amount)) + '</text>';
    }

    const svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px" role="img" '
      + 'aria-label="' + esc(opts.ariaLabel || 'Available to request, day by day') + '">'
      + '<defs><pattern id="av-hatch" width="7" height="7" patternUnits="userSpaceOnUse" '
      + 'patternTransform="rotate(45)"><rect width="7" height="7" fill="var(--surface-alt)"/>'
      + '<line x1="0" y1="0" x2="0" y2="7" stroke="var(--line-2)" stroke-width="1.5"/></pattern></defs>'
      + bands + grid
      + '<line class="ch-base" x1="' + padL + '" y1="' + y0 + '" x2="' + (W - padR) + '" y2="' + y0 + '"/>'
      + line + marks + xl + '</svg>';

    const legend = '<div class="legend">'
      + '<span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="var(--mark-1)"/></svg>'
      + 'Recorded balance (actual)</span>'
      + '<span><svg width="22" height="12" aria-hidden="true"><line x1="0" y1="6" x2="22" y2="6" stroke="var(--mark-1)" '
      + 'stroke-width="2" stroke-dasharray="5 3"/></svg>Projected available (forecast)</span>'
      + (requests.length ? '<span><svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" '
        + 'fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/></svg>Planned request</span>' : '')
      + gaps.map(g => '<span><i class="key" style="background:var(--surface-alt);border:1px solid var(--line-2)"></i>'
        + 'No Amazon forecast, ' + esc(mmmd(g.from)) + ' – ' + esc(mmmd(g.to)) + '</span>').join('')
      + '</div>';

    /* The same figures as a table, for anyone who cannot or would rather not
       read the line. Every event, not a sample of them. */
    let rows = '';
    for (const p of pts) {
      rows += '<tr><td>' + esc(mmmd(p.date)) + '</td><td class="wrap">' + esc(p.label || '') + '</td>'
        + '<td class="n">' + esc(Money.fmt(p.available) || '') + '</td></tr>';
    }
    const table = '<details class="plain"><summary>' + Icons.icon('chevronRight', { size: 'sm' })
      + 'Show as table</summary><div class="tscroll" style="max-height:360px"><table><thead><tr>'
      + '<th>Date</th><th class="wrap">What happens</th><th class="n">Available after</th></tr></thead>'
      + '<tbody>' + rows + '</tbody></table></div></details>';

    return svg + legend + table;
  }

  /* ── 6. the sales & fees forecast, with a reading under the pointer ─────

     One measure at a time (the tile that is picked), over the chosen dates:
     either the running total to each day, or each week's amount. Moving the
     pointer - or the arrow keys, or a tap - reads out that day or week, with
     all four measures, as Amazon's own charts do.

     days: Simple.forecastFor(...).daily. Money is integer cents. Fees and
     advertising are drawn as the size of the cost, and read out signed, as
     the tiles show them. A day no download covers is shaded and named; it
     adds nothing, and nothing is drawn as if it did. */
  const MEASURES = [
    { key: 'netSales', name: 'Net sales', colour: 'var(--mark-1)', sign: 1 },
    { key: 'fees', name: 'Amazon fees', colour: 'var(--mark-2)', sign: -1 },
    { key: 'advertising', name: 'Advertising', colour: 'var(--mark-3)', sign: -1 },
    { key: 'after', name: 'After fees and ads', colour: 'var(--mark-4)', sign: 1 },
  ];
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = d => DOW[new Date(toT(d)).getUTCDay()] + ' ' + mmmd(d);
  const valueOf = (e, key) => (!e || !e.covered ? null
    : key === 'after' ? e.netSales - e.fees - e.advertising : e[key]);

  /* What is drawn: one entry per day (the running total to it) or per week
     (that week's amount), each with its reading. Kept apart from the drawing
     so the arithmetic can be tested without a browser. */
  function forecastItems(days, opts) {
    opts = opts || {};
    const m = MEASURES.find(x => x.key === opts.metric) || MEASURES[0];
    const cur = opts.currency || 'USD';
    const monday = opts.mondayOf || (d => d);
    const items = [];
    if (opts.mode === 'weekly') {
      const byWeek = new Map();
      for (const e of days) {
        const k = monday(e.date);
        const w = byWeek.get(k) || { days: 0, covered: 0, sums: {} };
        w.days++;
        if (e.covered) {
          w.covered++;
          for (const x of MEASURES) w.sums[x.key] = (w.sums[x.key] || 0) + valueOf(e, x.key);
        }
        byWeek.set(k, w);
      }
      for (const [k, w] of byWeek) {
        items.push({ v: w.covered ? w.sums[m.key] : null, gap: !w.covered,
          head: 'Week of ' + mmmd(k) + (w.days < 7 ? ' · ' + w.days + ' of its days' : ''),
          note: !w.covered ? 'No forecast downloaded for this week'
            : w.covered < w.days ? (w.days - w.covered) + ' of these days have no forecast' : '',
          rows: MEASURES.map(x => [x.name, w.covered ? w.sums[x.key] * x.sign : null, x.key === m.key]),
          label: mmmd(k) });
      }
    } else {
      const run = {};
      for (const e of days) {
        for (const x of MEASURES) run[x.key] = (run[x.key] || 0) + (valueOf(e, x.key) || 0);
        const that = valueOf(e, m.key);
        items.push({ v: run[m.key], gap: !e.covered, head: 'Through ' + dayName(e.date),
          note: !e.covered ? 'No forecast downloaded for this day'
            : 'That day: ' + cur + ' ' + (Money.fmt(that * m.sign, { bare: true }) || ''),
          rows: MEASURES.map(x => [x.name, run[x.key] * x.sign, x.key === m.key]),
          label: mmmd(e.date) });
      }
    }
    return { items, measure: m };
  }

  function forecast(days, opts) {
    opts = opts || {};
    days = (days || []).filter(e => e && e.date);
    if (!days.some(e => e.covered)) {
      return emptyState('Nothing to draw yet', 'None of these dates has a downloaded forecast.');
    }
    const weekly = opts.mode === 'weekly';
    const cur = opts.currency || 'USD';
    const { items, measure: m } = forecastItems(days, opts);

    const W = 1072, H = 340, padL = 64, padR = 18, padT = 30, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const vals = items.filter(x => x.v != null).map(x => x.v);
    const vHi = Math.max(0, ...vals), vLo = Math.min(0, ...vals);
    const step = niceMax(Math.max(1, vHi - vLo) / 4);
    const lo = Math.floor(vLo / step) * step, hi = Math.max(step, Math.ceil(vHi / step) * step);
    const band = plotW / items.length;
    const X = i => padL + band * (i + 0.5);
    const Y = v => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
    const y0 = Y(0);

    const num = c => short(c).replace(/^([\-−]?)[^\d]+/, '$1');
    let grid = '';
    for (let t = lo; t <= hi + step / 2; t += step) {
      const y = Y(t);
      grid += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 8) + '" y="' + (y + 4) + '" text-anchor="end">'
        + esc(t === 0 ? '0' : num(t)) + '</text>';
    }
    grid += '<text class="ch-axis" x="' + (padL - 8) + '" y="' + (padT - 12) + '" text-anchor="end">'
      + esc(cur) + '</text>';

    /* about seven date labels, never crowding */
    let xl = '';
    const every = Math.max(1, Math.ceil(items.length / 7));
    for (let i = 0; i < items.length; i += every) {
      xl += '<text class="ch-axis" x="' + X(i) + '" y="' + (H - 8) + '" text-anchor="middle">'
        + esc(items[i].label) + '</text>';
    }

    /* shaded where nothing is downloaded */
    let bands = '';
    for (let i = 0; i < items.length; i++) {
      if (!items[i].gap) continue;
      let j = i;
      while (j + 1 < items.length && items[j + 1].gap) j++;
      bands += '<rect x="' + (padL + band * i) + '" y="' + padT + '" width="' + (band * (j - i + 1))
        + '" height="' + plotH + '" fill="url(#fc-gap)"/>';
      if (band * (j - i + 1) > 170) {
        bands += '<text class="ch-axis" x="' + (padL + band * (i + j + 1) / 2) + '" y="' + (padT + 18)
          + '" text-anchor="middle" style="fill:var(--warn);font-weight:600">No forecast downloaded</text>';
      }
      i = j;
    }

    let marks = '';
    if (weekly) {
      const w = Math.min(COL_MAX, band - 8);
      items.forEach((it, i) => {
        if (!it.v) return;
        const top = Math.min(Y(it.v), y0), h = Math.abs(Y(it.v) - y0);
        const x = X(i) - w / 2;
        /* rounded at the end away from zero, square on the axis */
        marks += '<path d="' + colPath(x, top, w, h) + '" fill="' + m.colour + '"'
          + (it.v < 0 ? ' transform="rotate(180 ' + (x + w / 2) + ' ' + (top + h / 2) + ')"' : '') + '/>';
      });
    } else {
      /* the running total: a line with a light fill under it; across days
         with no forecast it runs level, grey and dashed */
      let area = '', line = '', flat = '';
      items.forEach((it, i) => {
        const p = X(i).toFixed(1) + ',' + Y(it.v).toFixed(1);
        if (i === 0) { line = 'M' + p; area = 'M' + X(0).toFixed(1) + ',' + y0.toFixed(1) + 'L' + p; return; }
        if (it.gap) { flat += 'M' + X(i - 1).toFixed(1) + ',' + Y(items[i - 1].v).toFixed(1) + 'L' + p; line += 'M' + p; }
        else line += 'L' + p;
        area += 'L' + p;
      });
      area += 'L' + X(items.length - 1).toFixed(1) + ',' + y0.toFixed(1) + 'Z';
      marks = '<path d="' + area + '" fill="' + m.colour + '" opacity=".12"/>'
        + '<path d="' + line + '" fill="none" stroke="' + m.colour + '" stroke-width="2.5" '
        + 'stroke-linejoin="round" stroke-linecap="round"/>'
        + (flat ? '<path d="' + flat + '" fill="none" stroke="var(--mark-neutral)" stroke-width="2" '
          + 'stroke-dasharray="5 4"/>' : '');
      const last = items.length - 1;
      marks += '<circle cx="' + X(last) + '" cy="' + Y(items[last].v) + '" r="4" fill="' + m.colour + '"/>';
    }

    /* the reading: a guide line and a dot, moved by forecastHover */
    const hover = '<g class="fc-cursor" style="display:none">'
      + '<line class="fc-guide" x1="0" y1="' + padT + '" x2="0" y2="' + (padT + plotH) + '" stroke="var(--ink-3)" '
      + 'stroke-width="1" stroke-dasharray="3 3"/>'
      + '<circle class="fc-dot" r="5.5" cx="0" cy="0" fill="var(--surface)" stroke="' + m.colour
      + '" stroke-width="2.5"/></g>';

    const data = { W, band, padL, padT, weekly, currency: cur,
      colours: MEASURES.map(x => x.colour),
      items: items.map((it, i) => ({ x: +X(i).toFixed(1), y: it.v == null ? null : +Y(it.v).toFixed(1),
        head: it.head, note: it.note, rows: it.rows })) };

    const svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" style="max-width:' + W + 'px" '
      + 'aria-hidden="true">'
      + '<defs><pattern id="fc-gap" width="7" height="7" patternUnits="userSpaceOnUse" '
      + 'patternTransform="rotate(45)"><rect width="7" height="7" fill="var(--surface-alt)"/>'
      + '<line x1="0" y1="0" x2="0" y2="7" stroke="var(--line-2)" stroke-width="1.5"/></pattern></defs>'
      + bands + grid
      + '<line class="ch-base" x1="' + padL + '" y1="' + y0 + '" x2="' + (W - padR) + '" y2="' + y0 + '"/>'
      + marks + hover + xl + '</svg>';

    return '<div class="fchart" tabindex="0" role="group" aria-label="' + esc(m.name + ', '
      + (weekly ? 'week by week' : 'running total') + '. Use the arrow keys to read each '
      + (weekly ? 'week' : 'day') + '.') + '" data-fc="' + esc(JSON.stringify(data)) + '">'
      + svg + '<div class="fc-tip" role="status" aria-live="polite" hidden></div></div>';
  }

  function fcData(el) {
    if (!el._fc) { try { el._fc = JSON.parse(el.getAttribute('data-fc')); } catch (e) { return null; } }
    return el._fc;
  }

  /* Show the reading for item i, or hide it for null. Browser only. */
  function forecastHover(el, i) {
    const data = el && fcData(el);
    if (!data) return;
    const tip = el.querySelector('.fc-tip'), cursor = el.querySelector('.fc-cursor');
    const svg = el.querySelector('svg');
    if (i == null || !data.items[i]) {
      tip.hidden = true;
      cursor.style.display = 'none';
      el._fcAt = null;
      return;
    }
    el._fcAt = i;
    const it = data.items[i];
    const fmt = c => (c == null ? '—' : data.currency + ' ' + (Money.fmt(c, { bare: true }) || ''));
    tip.innerHTML = '<div class="fc-h">' + esc(it.head) + '</div>'
      + it.rows.map((r, k) => '<div class="fc-r' + (r[2] ? ' on' : '') + '"><span><i style="background:'
        + data.colours[k] + '"></i>' + esc(r[0]) + '</span><b' + (r[1] < 0 ? ' class="neg"' : '') + '>'
        + esc(fmt(r[1])) + '</b></div>').join('')
      + (it.note ? '<div class="fc-n">' + esc(it.note) + '</div>' : '');
    tip.hidden = false;
    cursor.style.display = '';
    const guide = cursor.querySelector('.fc-guide');
    guide.setAttribute('x1', it.x);
    guide.setAttribute('x2', it.x);
    const dot = cursor.querySelector('.fc-dot');
    if (it.y == null || data.weekly) dot.style.display = 'none';
    else { dot.style.display = ''; dot.setAttribute('cx', it.x); dot.setAttribute('cy', it.y); }
    /* beside the guide, on whichever side has room */
    const box = svg.getBoundingClientRect(), host = el.getBoundingClientRect();
    const k = box.width / data.W;
    const px = box.left - host.left + it.x * k;
    const tw = tip.offsetWidth;
    let left = px + 16;
    if (left + tw > host.width) left = px - 16 - tw;
    tip.style.left = Math.max(0, left) + 'px';
    tip.style.top = Math.max(0, box.top - host.top + data.padT * k) + 'px';
  }

  /* Which item is under the pointer at clientX, or null. */
  function forecastAt(el, clientX) {
    const data = fcData(el);
    if (!data) return null;
    const box = el.querySelector('svg').getBoundingClientRect();
    const x = (clientX - box.left) / (box.width / data.W);
    const i = Math.floor((x - data.padL) / data.band);
    return i < 0 || i >= data.items.length ? null : i;
  }

  /* The arrow keys, Home and End walk the reading along. True if handled. */
  function forecastStep(el, key) {
    const data = el && fcData(el);
    if (!data || !/^(ArrowLeft|ArrowRight|Home|End)$/.test(key)) return false;
    const n = data.items.length, at = el._fcAt;
    const i = key === 'Home' ? 0 : key === 'End' ? n - 1
      : at == null ? (key === 'ArrowLeft' ? n - 1 : 0)
      : Math.max(0, Math.min(n - 1, at + (key === 'ArrowLeft' ? -1 : 1)));
    forecastHover(el, i);
    return true;
  }

  return { bankReceipts, waterfall, categoryBars, policyCompare, availability, forecast, forecastItems,
    forecastHover, forecastAt, forecastStep, MEASURES, emptyState, colPath, barPath, niceMax };
});
