/* Client for the local Python worker.
 *
 * The worker SERVES this app, so it is always same-origin: no CORS, no mixed
 * content, no cookie games. That also means the connection exists only when the
 * app is opened from the worker (http://127.0.0.1:8765). Opened any other way —
 * a published artifact on https://claude.ai, a file:// page, another dev server
 * — there is no worker, and this module says so rather than pretending.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Worker2 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* The token is handed over in the URL the worker prints at startup. It is
     kept out of the address bar afterwards so it does not end up in history or
     in a screenshot. */
  function takeToken() {
    let t = null;
    try {
      const u = new URL(location.href);
      t = new URLSearchParams(u.hash.slice(1)).get('token') || u.searchParams.get('token');
      if (t) {
        sessionStorage.setItem('fba-worker-token', t);
        u.searchParams.delete('token');
        u.hash = '';
        history.replaceState(null, '', u.toString());
      } else {
        t = sessionStorage.getItem('fba-worker-token');
      }
    } catch (e) { /* storage blocked: the worker simply stays unavailable */ }
    return t;
  }

  function create() {
    const token = takeToken();
    let info = null;

    const headers = () => {
      const h = { 'Content-Type': 'application/json' };
      if (token) h['X-Worker-Token'] = token;
      return h;
    };

    async function call(path, opts) {
      const res = await fetch('/api' + path, Object.assign({ headers: headers() }, opts));
      if (res.status === 401) {
        const e = new Error('The worker rejected this page’s token. Open the app using '
          + 'the link the worker printed when it started.');
        e.code = 'unauthorised';
        throw e;
      }
      if (!res.ok) {
        let detail = '';
        let payload = null;
        try { payload = await res.json(); detail = payload.error || ''; } catch (e) { /* not json */ }
        const err = new Error(detail || ('The worker returned ' + res.status + '.'));
        err.code = res.status === 409 ? 'conflict' : 'worker_error';
        err.status = res.status;
        /* A conflict carries the version that IS stored. Losing it here would
           leave the caller able to say only "that failed", when what it needs
           to say is "here is what someone else saved". */
        err.payload = payload;
        throw err;
      }
      return res.json();
    }

    return {
      get info() { return info; },
      get hasToken() { return !!token; },

      /* Never throws: absence is the normal case. */
      async probe() {
        try {
          const res = await fetch('/api/health', { cache: 'no-store', headers: headers() });
          if (!res.ok) throw new Error('bad status');
          info = await res.json();
          if (info.worker !== 'fba-local-worker') throw new Error('Wrong server');
          info.tokenPresent = !!token && info.authorized === true;
          return info;
        } catch (e) {
          info = null;
          return null;
        }
      },

      refreshToday: opts => call('/refresh', {
        method: 'POST', body: JSON.stringify(opts || {}),
      }),
      saveSettings: settings => call('/settings', {
        method: 'POST', body: JSON.stringify(settings || {}),
      }),
      session: () => call('/session'),
      chromeProfiles: () => call('/chrome/profiles'),
      setupStart: (reportType, chromeProfile) => call('/setup/start', {
        method: 'POST', body: JSON.stringify({ reportType, chromeProfile }),
      }),
      setupState: () => call('/setup/state'),
      setupAnswer: value => call('/setup/answer', {
        method: 'POST', body: JSON.stringify({ value }),
      }),
      setupSave: () => call('/setup/save', { method: 'POST', body: '{}' }),
      setupCancel: () => call('/setup/cancel', { method: 'POST', body: '{}' }),

      listJobs: () => call('/jobs'),
      archive: () => call('/archive'),

      /* The app's state document, held by the helper rather than by whichever
         browser happens to be open. `revision` is what this caller last read:
         sending it is what lets the helper refuse a save that would overwrite
         somebody else's without either of them noticing. */
      loadState: () => call('/state'),
      saveState: (body, revision, by) => call('/state', {
        method: 'POST',
        body: JSON.stringify({ body: body, revision: revision, by: by }),
      }),
      stateHistory: () => call('/state/history'),

      /* The mirror. The key travels once, on the way in; what comes back
         never contains it. */
      mirror: () => call('/supabase'),
      mirrorTest: (url, key) => call('/supabase/test', {
        method: 'POST', body: JSON.stringify({ url: url, key: key }) }),
      mirrorSave: (url, key) => call('/supabase', {
        method: 'POST', body: JSON.stringify({ url: url, key: key }) }),
      mirrorForget: () => call('/supabase/forget', { method: 'POST', body: '{}' }),
      /* The write key. Row Level Security does not apply to it, so it is the
         one thing that may write - and it never leaves this computer. */
      mirrorWriteKey: (key) => call('/supabase/write-key', {
        method: 'POST', body: JSON.stringify({ key: key }) }),
      mirrorWriteKeyForget: () => call('/supabase/write-key/forget', {
        method: 'POST', body: '{}' }),
      /* Can take a while on a first run: it is real rows going up a real
         connection, so it answers when it is actually done. */
      mirrorPush: () => call('/supabase/push', { method: 'POST', body: '{}' }),
      /* On by default: the helper sends a few seconds after each download or
         delete. Off leaves "Send now" as the only way anything goes. */
      /* Your figures on your other computers: documents in the project's
         app_docs table, read and written by the helper with the secret key. */
      cloudStatus: () => call('/cloud'),
      cloudGet: p => call('/cloud/doc?path=' + encodeURIComponent(p)),
      cloudSet: (p, data) => call('/cloud/doc', {
        method: 'POST', body: JSON.stringify({ path: p, data: data }) }),
      cloudDelete: p => call('/cloud/doc/delete', {
        method: 'POST', body: JSON.stringify({ path: p }) }),
      mirrorAuto: (enabled) => call('/supabase/auto', {
        method: 'POST', body: JSON.stringify({ enabled: !!enabled }) }),
      /* The rows THIS app parsed, sent back to be kept. The helper has no
         CSV parser and must not grow one: two parsers can disagree about
         the same file, and then neither can be trusted. */
      archiveRows: (jobId, rows, moneyScale) => call(
        '/jobs/' + encodeURIComponent(jobId) + '/archive-rows',
        { method: 'POST',
          body: JSON.stringify({ rows: rows, moneyScale: moneyScale }) }),
      job: id => call('/jobs/' + encodeURIComponent(id)),
      createJob: (reportType, from, to, marketplace, accountType) => call('/jobs', {
        method: 'POST', body: JSON.stringify({ reportType, from, to, marketplace, accountType }),
      }),
      /* The reason travels with the failure. Without it every import problem
         read the same in the job list and none could be acted on. */
      markImportFailed: (id, reason) => call(
        '/jobs/' + encodeURIComponent(id) + '/import-failed',
        { method: 'POST', body: JSON.stringify({ reason: reason || null }) }),
      retry: id => call('/jobs/' + encodeURIComponent(id) + '/retry', { method: 'POST' }),
      /* Deletes the REQUEST and the CSV the helper saved. Figures already
         imported live in this browser and are removed from Imported files. */
      remove: id => call('/jobs/' + encodeURIComponent(id) + '/delete', { method: 'POST' }),
      markImported: (id, counts) => call('/jobs/' + encodeURIComponent(id) + '/imported', {
        method: 'POST', body: JSON.stringify(counts || {}),
      }),

      /* The downloaded CSV, as a File, so it goes through exactly the same
         import path as a file dropped by hand. There is one parser. */
      async fetchFile(job) {
        const res = await fetch('/api/jobs/' + encodeURIComponent(job.jobId) + '/file',
          { headers: token ? { 'X-Worker-Token': token } : {} });
        if (!res.ok) {
          /* Carry the helper's own words. "The worker could not hand over the
             file" was the same sentence whatever had happened to it. */
          let why = '';
          try { why = (await res.json()).error || ''; } catch (_) { why = ''; }
          throw new Error(why || ('The worker could not hand over the file '
            + '(HTTP ' + res.status + ').'));
        }
        const blob = await res.blob();
        return new File([blob], job.fileName || 'amazon-report.csv', { type: 'text/csv' });
      },
    };
  }

  /* Plain-language status words. "Complete" is reserved for a job whose file
     has actually been imported. */
  const WORDS = {
    queued: 'Queued',
    'login-required': 'Waiting for you to sign in to Amazon',
    requesting: 'Requesting the report',
    generating: 'Amazon is generating the report',
    downloading: 'Downloading',
    validating: 'Checking the file',
    importing: 'Importing',
    complete: 'Complete',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  const TERMINAL = ['complete', 'failed', 'cancelled'];

  return { create, WORDS, TERMINAL };
});
