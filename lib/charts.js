/* Charts.
 *
 * Inline SVG, no library. Four forms, each chosen for the job its data does:
 *   bank receipts over eight weeks  -> columns over time, one measure
 *   the payout estimate             -> waterfall, polarity (adds vs takes away)
 *   expense categories              -> horizontal bars, magnitude, ONE series
 *   early vs scheduled              -> grouped columns, two series
 *
 * Rules held to throughout: bars capped at 24px with a 4px rounded data-end
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

  const BAR_MAX = 24;      // never fill the band; the leftover is air
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

    const W = 100, H = 46, padL = 12, padR = 2, padT = 8, padB = 12;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const max = niceMax(Math.max(...known.map(w => Math.abs(w.amount))));
    const band = plotW / weeks.length;
    const bw = Math.min(BAR_MAX / 8, band - GAP);     // viewBox units
    const y0 = padT + plotH;

    let g = '', bars = '', labels = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      g += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 3) + '" y="' + (y + 1.2) + '" text-anchor="end" '
        + 'style="font-size:3px">' + esc(short(max * i / 4)) + '</text>';
    }
    weeks.forEach((w, i) => {
      const cx = padL + band * i + band / 2;
      if (w.amount != null) {
        const h = (Math.abs(w.amount) / max) * plotH;
        const x = cx - bw / 2;
        bars += '<path class="ch-bar" d="' + colPath(x, y0 - h, bw, h) + '" '
          + 'fill="' + (w.forecast ? 'url(#fc-hatch)' : 'var(--mark-1)') + '"'
          + (w.forecast ? ' stroke="var(--mark-1)" stroke-width=".5"' : '') + '>'
          + '<title>' + esc(w.label + ' — ' + (Money.fmt(w.amount) || '')
            + (w.forecast ? ' (forecast)' : ' (actual)')) + '</title></path>';
      } else {
        /* an uncovered week is drawn as an absence, not as zero */
        bars += '<line x1="' + (cx - bw / 2) + '" y1="' + y0 + '" x2="' + (cx + bw / 2) + '" y2="' + y0
          + '" stroke="var(--line-2)" stroke-width=".8" stroke-linecap="round">'
          + '<title>' + esc(w.label + ' — ' + (w.note || 'no dated receipt')) + '</title></line>';
      }
      if (i % 2 === 0 || weeks.length <= 5) {
        labels += '<text class="ch-axis" x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" '
          + 'style="font-size:3px">' + esc(w.short || w.label) + '</text>';
      }
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" '
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
    const W = 100, H = 50, padL = 12, padR = 2, padT = 10, padB = 14;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const band = plotW / laid.length;
    const bw = Math.min(BAR_MAX / 8, band - GAP * 1.5);
    const yOf = v => padT + plotH - (v / max) * plotH;

    let g = '', marks = '', labels = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      g += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 3) + '" y="' + (y + 1.2) + '" text-anchor="end" '
        + 'style="font-size:3px">' + esc(short(max * i / 4)) + '</text>';
    }
    laid.forEach((s, i) => {
      const cx = padL + band * i + band / 2;
      const x = cx - bw / 2;
      const yA = yOf(Math.max(s.from, s.to)), yB = yOf(Math.min(s.from, s.to));
      const h = Math.max(Math.abs(yB - yA), 0.6);
      const fill = s.kind === 'total' || s.kind === 'start' ? 'var(--mark-neutral)'
        : s.amount >= 0 ? 'var(--mark-1)' : 'var(--mark-2)';
      marks += '<path class="ch-bar" d="' + colPath(x, yA, bw, h) + '" fill="' + fill + '">'
        + '<title>' + esc(s.label + ' — ' + (Money.fmt(s.amount, { plus: s.kind === 'add' || s.kind === 'sub' }) || '')) + '</title></path>';
      /* connector between steps, hairline and solid */
      if (i < laid.length - 1 && s.kind !== 'total') {
        const yEnd = yOf(s.to);
        marks += '<line x1="' + (x + bw) + '" y1="' + yEnd + '" x2="' + (cx + band - bw / 2) + '" y2="' + yEnd
          + '" stroke="var(--line-2)" stroke-width=".5"/>';
      }
      /* label only the start and the total — the rest are read from the tooltip */
      if (s.kind === 'start' || s.kind === 'total') {
        labels += '<text class="ch-val" x="' + cx + '" y="' + (yOf(Math.max(s.from, s.to)) - 2)
          + '" text-anchor="middle" style="font-size:3.2px">' + esc(short(s.to)) + '</text>';
      }
      labels += '<text class="ch-axis" x="' + cx + '" y="' + (H - 4) + '" text-anchor="middle" '
        + 'style="font-size:2.7px">' + esc(s.short || '') + '</text>';
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" '
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
    const rowH = 30, labelW = 178, valueW = 92;
    const H = top.length * rowH + 22;

    let out = '<div style="overflow-x:auto"><svg class="chart" viewBox="0 0 640 ' + H + '" '
      + 'style="min-width:520px" role="img" aria-label="' + esc(opts.ariaLabel || 'Expenses by category') + '">';
    const plotX = labelW, plotW = 640 - labelW - valueW;
    for (let i = 0; i <= 4; i++) {
      const x = plotX + (plotW * i / 4);
      out += '<line class="ch-grid" x1="' + x + '" y1="8" x2="' + x + '" y2="' + (H - 16) + '"/>';
    }
    top.forEach((r, i) => {
      const y = i * rowH + 8;
      const w = (Math.abs(r.value) / max) * plotW;
      const bh = Math.min(BAR_MAX, rowH - 10);
      out += '<text class="ch-axis" x="' + (labelW - 12) + '" y="' + (y + bh / 2 + 4)
        + '" text-anchor="end">' + esc(r.label.length > 26 ? r.label.slice(0, 25) + '…' : r.label)
        + '<title>' + esc(r.label) + '</title></text>'
        + '<path class="ch-bar" d="' + barPath(plotX, y, w, bh) + '" fill="var(--mark-1)">'
        + '<title>' + esc(r.label + ' — ' + (Money.fmt(r.value) || '')) + '</title></path>'
        + '<text class="ch-val" x="' + (640 - valueW + 8) + '" y="' + (y + bh / 2 + 4) + '">'
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
    const W = 100, H = 46, padL = 13, padR = 2, padT = 8, padB = 13;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const band = plotW / usable.length;
    const bw = Math.min(BAR_MAX / 9, (band - GAP * 2) / 2);
    const y0 = padT + plotH;

    let g = '', marks = '', labels = '';
    for (let i = 0; i <= 4; i++) {
      const y = padT + plotH - (plotH * i / 4);
      g += '<line class="ch-grid" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>'
        + '<text class="ch-axis" x="' + (padL - 3) + '" y="' + (y + 1.2) + '" text-anchor="end" '
        + 'style="font-size:3px">' + esc(short(max * i / 4)) + '</text>';
    }
    usable.forEach((grp, i) => {
      const cx = padL + band * i + band / 2;
      const pairs = [
        { v: grp.early, fill: 'var(--mark-1)', name: 'Request early', dx: -(bw + GAP / 2) },
        { v: grp.scheduled, fill: 'var(--mark-2)', name: 'Wait for the schedule', dx: GAP / 2 },
      ];
      for (const p of pairs) {
        const h = (Math.abs(p.v) / max) * plotH;
        marks += '<path class="ch-bar" d="' + colPath(cx + p.dx, y0 - h, bw, h) + '" fill="' + p.fill + '">'
          + '<title>' + esc(p.name + ' — ' + grp.label + ' — ' + (Money.fmt(p.v) || '')) + '</title></path>';
      }
      labels += '<text class="ch-axis" x="' + cx + '" y="' + (H - 3) + '" text-anchor="middle" '
        + 'style="font-size:2.9px">' + esc(grp.short || grp.label) + '</text>';
    });

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" '
      + 'aria-label="Early requests compared with the normal two-week schedule">'
      + g + marks
      + '<line class="ch-base" x1="' + padL + '" y1="' + y0 + '" x2="' + (W - padR) + '" y2="' + y0 + '"/>'
      + labels + '</svg>'
      + '<div class="legend">'
      + '<span><i class="key solid"></i>Request early</span>'
      + '<span><i class="key neg"></i>Wait for the schedule</span>'
      + '</div>';
  }

  return { bankReceipts, waterfall, categoryBars, policyCompare, emptyState, colPath, barPath, niceMax };
});
