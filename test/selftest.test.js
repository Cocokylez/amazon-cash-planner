/* Self-test reporting.
 *
 * The rule under test: a check the browser will not permit must report
 * `cannot-test`, never `fail`. Saying "helper offline" from a page that is
 * structurally incapable of reaching it would send someone to restart a helper
 * that was running the whole time.
 */
const T = require('./harness.js');
const SelfTest = require('../lib/selftest.js');

/* The module reads `location`, so give it one. */
function at(origin) {
  const u = new URL(origin);
  global.location = {
    origin, protocol: u.protocol, hostname: u.hostname, href: origin,
  };
}

const ctx = over => Object.assign({
  hasClaude: false,
  info: null,
  probe: async () => null,
  session: async () => null,
  syncProbe: async () => ({ ok: false, reason: 'not configured' }),
}, over || {});

const HEALTH = {
  ok: true, version: SelfTest.EXPECTED_HELPER,
  reports: [
    { id: 'fees-preview', label: 'Fees & Economics Preview', ready: true },
    { id: 'date-range-transactions', label: 'Payments transactions', ready: true },
  ],
  setupComplete: true,
};

(async () => {

  T.section('Served from claude.ai: helper checks cannot run, and say so');
  {
    at('https://claude.ai');
    T.eq('the page knows it is not served by the helper',
      SelfTest.servedByHelper(), false);

    /* On the real claude.ai `window.claude` exists, so the SYNC check can
       genuinely run there even though the three helper checks cannot. */
    const r = await SelfTest.run(ctx({
      hasClaude: true, syncProbe: async () => ({ ok: true }),
    }));
    const by = {};
    for (const x of r) by[x.id] = x;

    T.eq('reach is cannot-test, NOT fail', by.reach.status, 'cannot-test');
    T.eq('version is cannot-test', by.version.status, 'cannot-test');
    T.eq('amazon is cannot-test', by.amazon.status, 'cannot-test');
    T.ok('and the reason names the browser rule, not the helper',
      /browser/i.test(by.reach.detail) && !/offline/i.test(by.reach.detail),
      by.reach.detail);
    T.eq('each offers the local app as the fix', by.reach.fix.kind, 'open-local');

    const s = SelfTest.summary(r);
    T.eq('nothing is reported as failed', s.fail, 0);
    T.eq('the three helper checks are cannot-test', s.cannotTest, 4);
    T.eq('storage alone cannot prove account sync', by.sync.status, 'cannot-test');
  }

  T.section('Served by the helper: the checks actually run');
  {
    at('http://127.0.0.1:8765');
    T.eq('the page knows the helper serves it', SelfTest.servedByHelper(), true);

    const r = await SelfTest.run(ctx({
      probe: async () => HEALTH,
      session: async () => ({ everSignedIn: true }),
    }));
    const by = {};
    for (const x of r) by[x.id] = x;

    T.eq('reach passes', by.reach.status, 'pass');
    T.eq('version passes when it matches', by.version.status, 'pass');
    T.ok('and names the version', by.version.detail.indexOf(SelfTest.EXPECTED_HELPER) >= 0,
      by.version.detail);
  }

  T.section('A helper that answers but is the wrong version is a failure');
  {
    at('http://127.0.0.1:8765');
    const r = await SelfTest.checkVersion(ctx({ info: Object.assign({}, HEALTH, { version: '1.0.0' }) }));
    T.eq('reported as failed', r.status, 'fail');
    T.ok('says both versions', r.detail.indexOf('1.0.0') >= 0
      && r.detail.indexOf(SelfTest.EXPECTED_HELPER) >= 0, r.detail);
    T.ok('and explains that replacing files is not enough',
      /restart|already running/i.test(r.detail), r.detail);
    T.eq('offers the package', r.fix.kind, 'download-installer');
  }

  T.section('A helper with no version at all predates this app');
  {
    at('http://127.0.0.1:8765');
    const r = await SelfTest.checkVersion(ctx({ info: { ok: true } }));
    T.eq('reported as failed', r.status, 'fail');
    T.ok('and says it predates the app', /predates/i.test(r.detail), r.detail);
  }

  T.section('Amazon readiness distinguishes "not set up" from "unknown"');
  {
    at('http://127.0.0.1:8765');

    const notSetUp = await SelfTest.checkAmazon(ctx({
      info: Object.assign({}, HEALTH, {
        reports: [{ id: 'x', label: 'Payments transactions', ready: false }],
      }),
    }));
    T.eq('unrecorded reports fail', notSetUp.status, 'fail');
    T.eq('and the fix is to set them up', notSetUp.fix.kind, 'goto-setup');

    const ready = await SelfTest.checkAmazon(ctx({
      info: HEALTH, session: async () => ({ everSignedIn: true }),
    }));
    /* Set up, with a profile: whether Amazon still accepts the session cannot
       be known without contacting Amazon, so it is NOT a pass. */
    T.eq('a live session cannot be asserted without contacting Amazon',
      ready.status, 'not-tested');
    T.ok('and it says the real test is a download',
      ready.fix.kind === 'goto-download-test', JSON.stringify(ready.fix));

    const noProfile = await SelfTest.checkAmazon(ctx({
      info: HEALTH, session: async () => ({ everSignedIn: false }),
    }));
    T.eq('no signed-in profile is a failure', noProfile.status, 'fail');
  }

  T.section('Account sync is proved by a round trip, never assumed');
  {
    at('https://claude.ai');

    const nope = await SelfTest.checkSync(ctx({ hasClaude: false }));
    T.eq('outside claude.ai it cannot be tested', nope.status, 'cannot-test');
    T.ok('and it does not call local storage a sync',
      /this device only/i.test(nope.detail), nope.detail);

    const good = await SelfTest.checkSync(ctx({
      hasClaude: true, syncProbe: async () => ({ ok: true }),
    }));
    T.eq('a storage round trip cannot prove download sync', good.status, 'cannot-test');
    T.ok('and says data was written AND read back',
      /read it back/i.test(good.detail), good.detail);

    const bad = await SelfTest.checkSync(ctx({
      hasClaude: true, syncProbe: async () => ({ ok: false, reason: 'write refused' }),
    }));
    T.eq('a refused write fails', bad.status, 'fail');
    T.eq('with the reason given', bad.detail, 'write refused');
  }

  T.section('A helper that does not answer from the local app is a real failure');
  {
    at('http://127.0.0.1:8765');
    const r = await SelfTest.checkReach(ctx({ probe: async () => null }));
    T.eq('reported as failed', r.status, 'fail');
    T.ok('and points at the diagnostic tool', r.fix.kind === 'download-installer',
      JSON.stringify(r.fix));
  }

  process.exit(T.report() ? 0 : 1);
})();
