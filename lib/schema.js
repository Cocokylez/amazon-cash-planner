/* The storage schema, and the repository interface pages talk to.
 *
 * WHY THIS EXISTS
 *
 * Screens currently reach into `state.previews`, `state.ledger`,
 * `state.balanceSnapshots` and friends directly. That is why swapping the
 * storage layer would otherwise mean editing every tab. Everything a page needs
 * goes through a Repository; the Repository is backed by an adapter, and the
 * adapter is the only thing that changes when the data moves online.
 *
 * NOTHING HERE PICKS A DATABASE PROVIDER. The schema is written so it maps
 * cleanly onto a relational store (Postgres and friends) or a document store,
 * and the local adapter below satisfies it today with IndexedDB. No provider,
 * account or deployment is required to use it.
 *
 * CREDENTIALS ARE NOT IN HERE. Browser sessions and Amazon logins live in the
 * automation runtime, never beside financial records — see `worker/` and the
 * `downloadJobs` notes below.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Schema = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  const VERSION = 1;

  /* ── tables ─────────────────────────────────────────────────────────────
     `key` is the primary key. `refs` names foreign keys, so the same shape can
     become relational tables or nested documents. `scope` says who the row
     belongs to: 'org' rows are shared by an organization, 'user' rows are
     private to one person, 'secret' rows never leave the automation runtime. */

  const TABLES = {

    /* who */
    organizations: { key: 'orgId', scope: 'org', fields: ['orgId', 'name', 'createdAt'] },
    users: { key: 'userId', scope: 'user', fields: ['userId', 'displayName', 'createdAt'] },
    memberships: {
      key: 'membershipId', scope: 'org', refs: { orgId: 'organizations', userId: 'users' },
      fields: ['membershipId', 'orgId', 'userId', 'role', 'createdAt'],
      note: 'role: owner | admin | member | viewer',
    },

    /* what account the data is about */
    sellerAccounts: {
      key: 'sellerAccountId', scope: 'org', refs: { orgId: 'organizations' },
      fields: ['sellerAccountId', 'orgId', 'label', 'merchantToken', 'homeMarketplace',
        'defaultCurrency', 'createdAt'],
    },
    marketplaces: {
      key: 'marketplaceId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['marketplaceId', 'sellerAccountId', 'code', 'name', 'currency', 'timezone'],
      note: 'Currency lives here: totals are never mixed across marketplaces without a '
        + 'recorded conversion.',
    },

    /* the files themselves */
    importFiles: {
      key: 'importId', scope: 'org',
      refs: { sellerAccountId: 'sellerAccounts', downloadJobId: 'downloadJobs' },
      fields: ['importId', 'sellerAccountId', 'reportType', 'sourceKind', 'fileName',
        'contentHash', 'byteSize', 'headerLine', 'columnCount', 'currency', 'marketplaceCode',
        'periodStart', 'periodEnd', 'rowsProcessed', 'rowsAccepted', 'rowsRejected',
        'status', 'supersedesImportId', 'isActive', 'importedAt', 'downloadJobId',
        'storageRef'],
      note: 'sourceKind: manual-upload | amazon-download. contentHash makes an identical '
        + 'file recognisable from either route, so a manual upload and a scheduled download '
        + 'of the same report cannot both be counted. supersedesImportId + isActive keep '
        + 'revised forecasts as VERSIONS rather than replacing history.',
    },
    importIssues: {
      key: 'issueId', scope: 'org', refs: { importId: 'importFiles' },
      fields: ['issueId', 'importId', 'severity', 'line', 'reason', 'detail'],
      note: 'Rejected rows and validation findings, kept per file so a short import can '
        + 'always be explained.',
    },
    rawReportRows: {
      key: 'rawRowId', scope: 'org', refs: { importId: 'importFiles' },
      fields: ['rawRowId', 'importId', 'lineNo', 'columns'],
      note: 'The source row, verbatim. Optional for large exports; the columnar ledger '
        + 'reconstructs rows without it.',
    },

    /* normalized financial records */
    transactions: {
      key: 'transactionId', scope: 'org',
      refs: { importId: 'importFiles', sellerAccountId: 'sellerAccounts' },
      fields: ['transactionId', 'importId', 'sellerAccountId', 'sourceRowRef', 'settlementId',
        'orderId', 'sku', 'type', 'description', 'quantity', 'marketplaceCode', 'accountStream',
        'fulfillment', 'postedDate', 'postedTime', 'postedTz', 'releaseDate', 'status',
        'total', 'currency'],
      note: 'accountStream keeps Standard and Invoiced Orders apart. sourceRowRef is the '
        + 'source identity used for overlap matching — legitimately identical rows are kept, '
        + 'and are never deduplicated by value.',
    },
    monetaryComponents: {
      key: 'componentId', scope: 'org', refs: { transactionId: 'transactions' },
      fields: ['componentId', 'transactionId', 'component', 'category', 'subcategory',
        'amount', 'sign'],
      note: 'One row per money column, so category totals reconcile to source components. '
        + '`total` is a control, never a component.',
    },

    /* forecasts */
    forecastReports: {
      key: 'forecastReportId', scope: 'org', refs: { importId: 'importFiles' },
      fields: ['forecastReportId', 'importId', 'periodStart', 'periodEnd', 'forecastAsOf',
        'version', 'supersedesId', 'isActive', 'marketplaceCode', 'currency'],
      note: 'A revised forecast for the same period is a new VERSION. Older versions stay '
        + 'readable; exactly one is active per period.',
    },
    forecastRows: {
      key: 'forecastRowId', scope: 'org', refs: { forecastReportId: 'forecastReports' },
      fields: ['forecastRowId', 'forecastReportId', 'msku', 'asin', 'fnsku', 'unitsSold',
        'unitsReturned', 'netUnits', 'sales', 'netSales'],
    },
    forecastFees: {
      key: 'forecastFeeId', scope: 'org', refs: { forecastRowId: 'forecastRows' },
      fields: ['forecastFeeId', 'forecastRowId', 'family', 'parentFamily', 'isComponent',
        'perUnit', 'quantity', 'total', 'columnPresent'],
      note: 'isComponent marks a fee that rolls INTO parentFamily. Totals must never add a '
        + 'parent and its components together.',
    },

    /* products and costs */
    productMappings: {
      key: 'productId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['productId', 'sellerAccountId', 'msku', 'asin', 'fnsku', 'title', 'aliasOf'],
      note: 'aliasOf is set only by a person. MSKU suffixes are never stripped to force a '
        + 'match.',
    },
    productCosts: {
      key: 'costId', scope: 'org', refs: { productId: 'productMappings' },
      fields: ['costId', 'productId', 'unitCost', 'currency', 'effectiveFrom', 'effectiveTo',
        'source', 'recordedAt'],
      note: 'Effective-dated, so a cost change does not rewrite history.',
    },
    operatingCosts: {
      key: 'operatingCostId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['operatingCostId', 'sellerAccountId', 'label', 'amount', 'currency', 'cadence',
        'effectiveFrom', 'effectiveTo'],
    },

    /* balances and cash */
    balanceObservations: {
      key: 'observationId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['observationId', 'sellerAccountId', 'accountStream', 'available', 'deferred',
        'reserve', 'inTransit', 'currency', 'observedAt', 'includesActivityThrough', 'source',
        'recordedAt'],
      note: 'A snapshot, never a running total. Snapshots are compared, not summed.',
    },
    deferredObservations: {
      key: 'deferredId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['deferredId', 'sellerAccountId', 'amount', 'expectedRelease', 'observedAt',
        'source'],
      note: 'Deferred funds are held revenue, NOT an expense.',
    },
    payoutPlans: {
      key: 'planId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['planId', 'sellerAccountId', 'accountStream', 'requestDate', 'mode', 'amount',
        'status', 'createdAt', 'executedTransferId'],
      note: 'A plan, not an instruction: this app never submits a payout request.',
    },
    transfers: {
      key: 'transferId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['transferId', 'sellerAccountId', 'accountStream', 'initiatedDate', 'amount',
        'currency', 'kind', 'sourceImportId'],
      note: 'An initiated transfer is money already leaving — never counted again as a '
        + 'future payout.',
    },
    bankReceipts: {
      key: 'receiptId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['receiptId', 'sellerAccountId', 'bankDate', 'amount', 'currency', 'reference',
        'source'],
    },
    reconciliationLinks: {
      key: 'linkId', scope: 'org',
      refs: { transferId: 'transfers', receiptId: 'bankReceipts' },
      fields: ['linkId', 'transferId', 'receiptId', 'settlementId', 'status', 'difference',
        'matchedBy', 'matchedAt'],
      note: 'status: matched | unmatched | not-reconciled. Absence of evidence is '
        + '"not reconciled", never a successful check.',
    },

    /* assumptions and saved work */
    assumptions: {
      key: 'assumptionId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['assumptionId', 'sellerAccountId', 'key', 'value', 'origin', 'basis',
        'effectiveFrom', 'recordedBy', 'recordedAt'],
      note: 'origin: ACTUAL | CURRENT | AMAZON FORECAST | MODEL FORECAST | ASSUMPTION | '
        + 'CALCULATED. Every figure on screen can name one.',
    },
    forecastRuns: {
      key: 'runId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['runId', 'sellerAccountId', 'scenario', 'horizonFrom', 'horizonTo', 'knownAt',
        'inputsHash', 'payload', 'createdAt'],
      note: 'knownAt fixes the information cutoff so a replay cannot borrow facts from the '
        + 'future, and a forecast can later be scored against what actually happened.',
    },

    /* automation */
    downloadJobs: {
      key: 'jobId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['jobId', 'sellerAccountId', 'reportType', 'requestedFrom', 'requestedTo',
        'status', 'statusDetail', 'attempt', 'queuedAt', 'startedAt', 'finishedAt',
        'lastError', 'resultImportId', 'workerId'],
      note: 'status: queued | login-required | requesting | generating | downloading | '
        + 'validating | importing | complete | failed | cancelled. A job waiting for a '
        + 'login stays login-required — never complete. NO CREDENTIALS HERE.',
    },
    syncSchedules: {
      key: 'scheduleId', scope: 'org', refs: { sellerAccountId: 'sellerAccounts' },
      fields: ['scheduleId', 'sellerAccountId', 'reportType', 'cron', 'timezone', 'enabled',
        'lookbackDays', 'lastAttemptAt', 'lastSuccessAt', 'lastCoverageFrom', 'lastCoverageTo',
        'consecutiveFailures'],
      note: 'lookbackDays re-fetches a recent window so refunds and late postings are picked '
        + 'up. A schedule only runs while its worker runs.',
    },
    workerSessions: {
      key: 'workerSessionId', scope: 'secret',
      fields: ['workerSessionId', 'sellerAccountId', 'profileDir', 'lastAuthenticatedAt',
        'expiresAt', 'status'],
      note: 'NEVER stored with financial records and never sent to the browser. The browser '
        + 'profile itself stays on the machine running the worker; only status is reported.',
    },
  };

  /* Storage-layer capability flags. A page asks the repository what it can do
     rather than assuming; "cross-device" is false until an online adapter is
     actually configured and has answered. */
  function capabilities(adapter) {
    return {
      name: adapter && adapter.name ? adapter.name : 'none',
      persistent: !!(adapter && adapter.persistent),
      crossDevice: !!(adapter && adapter.crossDevice),
      authenticated: !!(adapter && adapter.authenticated),
      fileStorage: !!(adapter && adapter.fileStorage),
      note: adapter && adapter.note ? adapter.note : null,
    };
  }

  /* ── the repository ─────────────────────────────────────────────────────
     Pages call these. The adapter supplies `read(table, query)` and
     `write(table, rows)`; nothing else about storage leaks upward. */
  function Repository(adapter) {
    const a = adapter || {};
    const need = fn => {
      if (typeof a[fn] !== 'function') {
        const e = new Error('This storage adapter cannot ' + fn + '.');
        e.code = 'unsupported';
        throw e;
      }
      return a[fn];
    };
    return {
      get capabilities() { return capabilities(a); },
      get schemaVersion() { return VERSION; },

      list(table, query) { return need('read')(table, query || {}); },
      put(table, rows) { return need('write')(table, [].concat(rows)); },
      remove(table, keys) { return need('remove')(table, [].concat(keys)); },

      /* Convenience reads the pages actually use, so a screen never writes a
         query against a table name. */
      activeForecastReports(sellerAccountId) {
        return this.list('forecastReports', { sellerAccountId, isActive: true });
      },
      importHistory(sellerAccountId) {
        return this.list('importFiles', { sellerAccountId });
      },
      openJobs(sellerAccountId) {
        return this.list('downloadJobs', {
          sellerAccountId,
          statusIn: ['queued', 'login-required', 'requesting', 'generating', 'downloading',
            'validating', 'importing'],
        });
      },
    };
  }

  return { VERSION, TABLES, Repository, capabilities };
});
