/* Lucide icon geometry, inlined.
 *
 * Inlined rather than loaded from a CDN: the app needs fifteen glyphs, and a
 * whole icon package is a network dependency and a failure mode for that. The
 * path data is Lucide's own (ISC licence), drawn on Lucide's 24×24 grid with a
 * 1.75–2 stroke, so the family stays visually consistent.
 *
 * `icon(name, opts)` always returns an aria-hidden decorative glyph. Anything
 * that carries meaning on its own — an icon-only button — must supply its own
 * accessible name, which is why there is no text baked in here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Icons = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const P = {
    /* navigation */
    LayoutDashboard:
      '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/>'
      + '<rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    CalendarClock:
      '<path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/>'
      + '<path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/>',
    ReceiptText:
      '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/>'
      + '<path d="M14 8H8"/><path d="M16 12H8"/><path d="M13 16H8"/>',
    ChartNoAxesCombined:
      '<path d="M12 16v5"/><path d="M16 14v7"/><path d="M20 10v11"/>'
      + '<path d="m22 3-8.646 8.646a.5.5 0 0 1-.708 0L9.354 8.354a.5.5 0 0 0-.707 0L2 15"/>'
      + '<path d="M4 18v3"/><path d="M8 14v7"/>',
    Wallet:
      '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/>'
      + '<path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    ListChecks:
      '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',
    Database:
      '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',

    /* concepts */
    LockKeyhole:
      '<circle cx="12" cy="16" r="1"/><rect x="3" y="10" width="18" height="12" rx="2"/>'
      + '<path d="M7 10V7a5 5 0 0 1 10 0v3"/>',
    Landmark:
      '<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/>'
      + '<path d="M18 18v-7"/><path d="m12 2 8 5H4Z"/>',
    ArrowRightLeft:
      '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
    Upload:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
    CircleAlert:
      '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
    CircleCheck:
      '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    SlidersHorizontal:
      '<path d="M21 4h-7"/><path d="M10 4H3"/><path d="M21 12h-9"/><path d="M8 12H3"/>'
      + '<path d="M21 20h-5"/><path d="M12 20H3"/><path d="M14 2v4"/><path d="M8 10v4"/><path d="M16 18v4"/>',

    /* supporting */
    ChevronRight: '<path d="m9 18 6-6-6-6"/>',
    ChevronDown: '<path d="m6 9 6 6 6-6"/>',
    Trash2:
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>'
      + '<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    Download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
    Store:
      '<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/>'
      + '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M15 22v-4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4"/>'
      + '<path d="M2 7h20"/>',
    Clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    Info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    Scale:
      '<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/>'
      + '<path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/>'
      + '<path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>',
    FileSpreadsheet:
      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/>'
      + '<path d="M8 13h2"/><path d="M14 13h2"/><path d="M8 17h2"/><path d="M14 17h2"/>',
    Plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  };

  /* Named for what they MEAN in this app, so call sites read as intent rather
     than as glyph names. */
  const ROLE = {
    dashboard: 'LayoutDashboard',
    forecast: 'CalendarClock',
    expenses: 'ReceiptText',
    profit: 'ChartNoAxesCombined',
    plan: 'Wallet',
    recon: 'ListChecks',
    data: 'Database',
    available: 'Wallet',
    deferred: 'LockKeyhole',
    bankReceipt: 'Landmark',
    inTransit: 'ArrowRightLeft',
    upload: 'Upload',
    missing: 'CircleAlert',
    verified: 'CircleCheck',
    assumptions: 'SlidersHorizontal',
    marketplace: 'Store',
    asOf: 'Clock',
    compare: 'Scale',
    remove: 'Trash2',
    download: 'Download',
    info: 'Info',
    file: 'FileSpreadsheet',
    chevronRight: 'ChevronRight',
    chevronDown: 'ChevronDown',
    add: 'Plus',
  };

  /* Decorative by default. A meaningful icon needs a label beside it, or the
     button needs its own aria-label — never a title on the glyph alone. */
  function icon(name, opts) {
    opts = opts || {};
    const d = P[ROLE[name] || name];
    if (!d) return '';
    const cls = 'ic' + (opts.size === 'sm' ? ' ic-sm' : opts.size === 'lg' ? ' ic-lg' : '')
      + (opts.cls ? ' ' + opts.cls : '');
    return '<svg class="' + cls + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false"'
      + (opts.style ? ' style="' + opts.style + '"' : '') + '>' + d + '</svg>';
  }

  return { icon, ROLE, PATHS: P };
});
