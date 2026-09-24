/* Self-tests, runnable from inside the app.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE
 *
 * A check that cannot run is NOT a check that failed. Published on claude.ai,
 * this page physically cannot reach a program on your computer — browsers
 * block an HTTPS page from calling http://127.0.0.1, and no setting changes
 * that. Reporting "helper offline" there would be a lie: the helper may be
 * running perfectly. So that case returns `cannot-test`, with the reason and
 * where the check CAN be run.
 *
 * Four outcomes, and they mean different things:
 *   pass        tested here, and it worked
 *   fail        tested here, and it did not work
 *   cannot-test the browser will not permit this check from this address
 *   not-tested  only a real run can answer it (an Amazon login, for instance)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SelfTest = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {

  /* The helper version this build of the app expects to talk to. */
  const EXPECTED_HELPER = '4.9.27';

  const result = (id, label, status, detail, fix) =>
    ({ id, label, status, detail, fix: fix || null });

  /* Is this page being served BY the helper? That is the only arrangement in
     which the checks below can reach it. */
  function servedByHelper() {
    try {
      return location.protocol === 'http:'
        && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
    } catch (e) { return false; }
  }

  const REMOTE_REASON = 'This page is served from ' + (typeof location !== 'undefined'
    ? location.origin : 'a website')
    + ', and a browser will not let a web page open a connection to a program '
    + 'running on your own computer. That is a browser security rule, not a '
    + 'setting on either side.';

  /* ── 1. can the app reach the helper ──────────────────────────────────── */

  async function checkReach(ctx) {
    const L = 'Can this app reach the helper on your computer?';
    if (!servedByHelper()) {
      return result('reach', L, 'cannot-test', REMOTE_REASON, {
        label: 'Open the local app',
        kind: 'open-local',
        note: 'Run these checks from http://127.0.0.1:8765, which the helper '
          + 'serves itself. Everything else in this app works here.',
      });
    }
    try {
      const info = await ctx.probe();
      if (!info) throw new Error('no answer');
      if (info.authorized === false) return result('reach', L, 'fail',
        'The helper is running, but this browser has no valid access token.',
        {label:'Open the desktop shortcut',kind:'open-local',note:'The desktop shortcut supplies a local token. A plain URL does not.'});
      return result('reach', L, 'pass',
        'The helper answered on ' + location.origin + '.');
    } catch (e) {
      return result('reach', L, 'fail',
        'Nothing answered at ' + location.origin + '/api/health.', {
          label: 'Get the diagnostic tool',
          kind: 'download-installer',
          note: 'The page loaded, so something served it — most likely the helper '
            + 'stopped after starting. Run DIAGNOSE.cmd in the worker folder; it '
            + 'reads the helper log and names the cause.',
        });
    }
  }

  /* ── 2. is it the version this app expects ────────────────────────────── */

  async function checkVersion(ctx) {
    const L = 'Is the helper running the expected version?';
    if (!servedByHelper()) {
      return result('version', L, 'cannot-test', REMOTE_REASON, {
        label: 'Open the local app', kind: 'open-local',
      });
    }
    const info = ctx.info || await ctx.probe();
    if (!info) {
      return result('version', L, 'not-tested',
        'The helper did not answer, so its version is unknown.');
    }
    const got = info.version || null;
    if (!got) {
      return result('version', L, 'fail',
        'The helper answered but reported no version, which means it predates '
        + 'this app build (expected ' + EXPECTED_HELPER + ').', {
          label: 'Get the current package', kind: 'download-installer',
          note: 'Extract it over your existing folder, then run worker\\UPDATE.cmd. '
            + 'Your Amazon session, settings and imports are preserved.',
        });
    }
    if (got !== EXPECTED_HELPER) {
      return result('version', L, 'fail',
        'The helper is version ' + got + '; this app expects ' + EXPECTED_HELPER
        + '. Replacing the files is not enough on its own — a helper that was '
        + 'already running keeps the old code until it is restarted.', {
          label: 'Get the current package', kind: 'download-installer',
          note: 'Extract over your folder, then run worker\\UPDATE.cmd, which stops '
            + 'and restarts it for you.',
        });
    }
    return result('version', L, 'pass', 'Helper version ' + got + ', as expected.');
  }

  /* ── 3. Amazon login and report setup ─────────────────────────────────── */

  async function checkAmazon(ctx) {
    const L = 'Is Amazon login and report setup ready?';
    if (!servedByHelper()) {
      return result('amazon', L, 'cannot-test', REMOTE_REASON, {
        label: 'Open the local app', kind: 'open-local',
      });
    }
    const info = ctx.info || await ctx.probe();
    if (!info) {
      return result('amazon', L, 'not-tested', 'The helper did not answer.');
    }
    if (info.authorized === false) return result('amazon', L, 'cannot-test',
      'Open the desktop shortcut to authorize this browser before checking report setup.',
      {label:'Open the desktop shortcut',kind:'open-local'});

    const reports = info.reports || [];
    const unready = reports.filter(r => !r.ready);
    if (unready.length) {
      return result('amazon', L, 'fail',
        unready.length + ' of ' + reports.length + ' reports have no recorded '
        + 'page steps yet: ' + unready.map(r => r.label).join(', ') + '.', {
          label: 'Set up reports', kind: 'goto-setup',
          note: 'One minute per report. A browser opens on Amazon and you click '
            + 'the controls the app names.',
        });
    }

    /* Setup done. Whether the SESSION is still valid cannot be known without
       contacting Amazon, and probing on a button press would be a download
       nobody asked for. */
    let session = null;
    try { session = await ctx.session(); } catch (e) { session = null; }
    const ever = session && session.everSignedIn;
    return result('amazon', L, ever ? 'not-tested' : 'fail',
      ever
        ? 'All reports are set up and a signed-in browser profile exists. '
          + 'Whether Amazon still accepts that session is only knowable when a '
          + 'report is actually requested — if it has expired, the job pauses '
          + 'and asks you to sign in rather than failing.'
        : 'Reports are set up but no signed-in browser profile exists yet.',
      ever ? {
        label: 'Run a real download test', kind: 'goto-download-test',
        note: 'That is the only thing that proves the session end to end.',
      } : {
        label: 'Set up reports', kind: 'goto-setup',
        note: 'Signing in happens during setup.',
      });
  }

  /* ── 4. can downloaded data reach your account ────────────────────────── */

  async function checkSync(ctx) {
    const L = 'Can your data sync to your Claude account?';
    if (!ctx.hasClaude) {
      return result('sync', L, 'cannot-test',
        'Account sync exists only inside claude.ai. This copy of the app is '
        + 'served from ' + (typeof location !== 'undefined' ? location.origin : 'elsewhere')
        + ', where there is no account to sync with — imports are saved on this '
        + 'device only.', {
          label: 'How to move data between them', kind: 'explain-migration',
          note: 'Export a backup here, restore it in the hosted app. Both are the '
            + 'same app; only the storage differs.',
        });
    }
    try {
      const out = await ctx.syncProbe();
      if (out && out.ok) {
        return result('sync', L, 'cannot-test',
          'Wrote a test value to your account and read it back. This tests storage only. '
          + 'Python downloads reaching this artifact and backend access isolation have not been tested. '
          + 'Export a full backup from the local app and restore it here for manual transfer.');
      }
      return result('sync', L, 'fail',
        (out && out.reason) || 'The account store did not answer.', {
          label: 'Retry', kind: 'rerun',
        });
    } catch (e) {
      return result('sync', L, 'fail', e && e.message ? e.message : String(e), {
        label: 'Retry', kind: 'rerun',
      });
    }
  }

  /* ── the run ──────────────────────────────────────────────────────────── */

  async function run(ctx) {
    const out = [];
    out.push(await checkReach(ctx));
    /* Reuse the one probe for the rest, so four checks are not four round
       trips against a helper that may be slow. */
    if (!ctx.info && servedByHelper()) {
      try { ctx.info = await ctx.probe(); } catch (e) { ctx.info = null; }
    }
    out.push(await checkVersion(ctx));
    out.push(await checkAmazon(ctx));
    out.push(await checkSync(ctx));
    return out;
  }

  const summary = results => ({
    pass: results.filter(r => r.status === 'pass').length,
    fail: results.filter(r => r.status === 'fail').length,
    cannotTest: results.filter(r => r.status === 'cannot-test').length,
    notTested: results.filter(r => r.status === 'not-tested').length,
  });

  return {
    run, summary, servedByHelper, EXPECTED_HELPER,
    checkReach, checkVersion, checkAmazon, checkSync,
  };
});
