/* The desktop shell's judgement, tested without a window.
 *
 * The valuable paths here are the ones a person never sees working normally:
 * a port held by someone else's program, a helper that never came up, a
 * launcher that said nothing useful. Each ends in this program NOT doing
 * something, and "it did not do the wrong thing" is exactly the kind of
 * behaviour that rots unnoticed.
 */
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const T = require('./harness.js');
const H = require('../desktop/helper.js');

(async function () {

  T.section('Desktop shell: who holds the port');

  {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, worker: 'fba-local-worker' }));
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const state = await H.portState({ port: srv.address().port, token: 'x' });
    await new Promise(r => srv.close(r));
    T.eq('the helper for this installation is recognised', state, 'ours');
  }

  {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html>somebody else entirely</html>');
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const state = await H.portState({ port: srv.address().port, token: 'x' });
    await new Promise(r => srv.close(r));
    T.eq('another program on the port is a stranger', state, 'stranger');
  }

  {
    /* Silent and stranger must never be confused. Silent means start the
       helper; stranger means stop and explain. Treating a stranger as silence
       is how a program ends up fighting something it should leave alone. */
    const srv = http.createServer(() => {});
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    await new Promise(r => srv.close(r));
    T.eq('a port with nothing on it is silent, not a stranger',
      await H.portState({ port, token: 'x' }, 800), 'silent');
  }

  const stranger = H.strangerOnPort(8765);
  T.ok('the stranger message names the port', stranger.includes('8765'));
  T.ok('and says nothing was stopped', /nothing was stopped/i.test(stranger));
  T.ok('and says what the person can do',
    /close that program yourself|change the port/i.test(stranger));
  T.ok('and never offers to end it for them',
    !/\bkill\b|terminate|force/i.test(stranger));

  T.section('Desktop shell: stopping the helper on the way out');

  T.eq('a helper this program started is stopped',
    H.shouldStopHelper('silent'), true);
  /* Closing this window is not permission to end somebody else's session. */
  T.eq('one that was already running is left alone',
    H.shouldStopHelper('ours'), false);

  T.section('Desktop shell: reading what the launcher said');

  const healthy = H.readLauncherOutput(
    'Healthy: http://127.0.0.1:8765 (version 4.7.0)\n', '');
  T.eq('a healthy launch is recognised', healthy.ok, true);
  T.eq('and yields the address to open', healthy.base, 'http://127.0.0.1:8765');

  /* Not paraphrased. The launcher is the part that knows what went wrong, and
     a friendlier rewording here would be a guess about someone else's
     failure - including the reassurance that nothing was stopped. */
  const refused = H.readLauncherOutput(
    'ERROR: Port belongs to another app or installation. No process was stopped.\n', '');
  T.eq('a refusal is a failure', refused.ok, false);
  T.ok('in the launcher’s own words',
    /no process was stopped/i.test(refused.message));

  const onStderr = H.readLauncherOutput('', 'ERROR: Python environment is missing.');
  T.eq('a failure on stderr is still read', onStderr.ok, false);
  T.ok('and keeps its reason', /python environment/i.test(onStderr.message));

  /* The one that matters most. A launcher that printed nothing has not said
     it worked, and treating silence as success would open a window over a
     helper that never started. */
  const silence = H.readLauncherOutput('', '');
  T.eq('silence is a failure, not a success', silence.ok, false);
  T.ok('and it admits it does not know why',
    /did not say why/i.test(silence.message));

  T.eq('a line merely mentioning health is not a healthy launch',
    H.readLauncherOutput('Checking health of the helper...\n', '').ok, false);

  T.section('Desktop shell: finding the installation');

  T.eq('development runs against the repository itself',
    H.appRoot({ packaged: false }), path.join(__dirname, '..'));
  T.eq('packaged runs against the copy inside resources',
    H.appRoot({ packaged: true, resourcesPath: path.join('C:', 'r') }),
    path.join('C:', 'r', 'app'));

  T.eq('a missing config is reported, not invented',
    H.readConfig(path.join(__dirname, 'no-such-installation')), null);

  {
    /* Half a config is not a config: opening the app with no token would show
       a page that cannot talk to its own helper. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-cfg-'));
    fs.mkdirSync(path.join(dir, 'worker'));
    fs.writeFileSync(path.join(dir, 'worker', 'config.json'),
      JSON.stringify({ port: 8765 }));
    T.eq('a config with no token is refused', H.readConfig(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  T.section('Desktop shell: asking for setup');

  {
    /* A first run on a machine with no Python is the most likely failure this
       app will ever have, and it is the one where vague wording costs the
       most. The message has to point at a file, not at a folder. */
    const root = path.join('C:', 'Program Files', 'Amazon Cash Planner');
    const msg = H.setupNeeded(root, 'no-python');
    T.ok('the setup message names the file to run',
      msg.includes(path.join(root, 'worker', 'SETUP.cmd')));
    T.ok('and says what to do after', /start the app again/i.test(msg));
    T.ok('without sending anyone to look for a folder',
      !/installation folder/i.test(msg));

    const noCfg = H.setupNeeded(root, 'no-config');
    T.ok('a missing token is explained as setup, not as an error',
      /not been set up/i.test(noCfg));
    T.ok('and points at the same file',
      noCfg.includes(path.join(root, 'worker', 'SETUP.cmd')));
  }

  T.section('Desktop shell: automatic updates');

  /* The important case is the one that is true today: no feed. It must say so
     rather than stay quiet, because "it updates itself" is a promise and a
     silent no-op is how that promise is discovered to be false at the worst
     possible moment. */
  T.eq('an installation with no feed at all has no feed',
    H.updateFeed(path.join(__dirname, 'no-such-installation')), null);
  T.ok('and it says so plainly',
    /not configured/i.test(H.updateStatus(null)));
  T.ok('rather than leaving someone to assume it updates',
    /will not[\s\S]*update itself/i.test(H.updateStatus(null)));

  {
    /* THE case that was broken. A packaged build carries app-update.yml in
       resources/, which autoUpdater reads by itself. The old lookup only
       checked ROOT()/desktop/update-feed.json - and when packaged, ROOT() is
       resources/app, which never contains desktop/. So the feed was
       unfindable in exactly the builds meant to update themselves, and the
       tests passed because they aimed at a development layout. */
    const res = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-res-'));
    const appDir = path.join(res, 'app');
    fs.mkdirSync(appDir);

    T.eq('before publishing, a packaged build has no feed',
      H.updateFeed(appDir, res), null);

    fs.writeFileSync(path.join(res, 'app-update.yml'),
      ['provider: github', 'owner: Cocokylez',
        'repo: amazon-cash-planner'].join('\n') + '\n');
    const built = H.updateFeed(appDir, res);
    T.ok('a published build finds the feed electron-builder wrote',
      !!built && built.builtIn === true);
    T.ok('and says where it found it',
      !!built && String(built.from).endsWith('app-update.yml'));

    /* It must not be handed back to autoUpdater: that config is already
       loaded, and replacing it here would substitute a guess for what the
       build was actually published against. */
    T.eq('a built-in feed is marked so it is not overridden',
      built.builtIn, true);
    fs.rmSync(res, { recursive: true, force: true });
  }

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-feed-'));
    fs.mkdirSync(path.join(dir, 'desktop'));
    const write = o => fs.writeFileSync(
      path.join(dir, 'desktop', 'update-feed.json'), JSON.stringify(o));

    write({ provider: 'github', owner: 'someone', repo: 'something' });
    T.eq('a feed file is read', (H.updateFeed(dir) || {}).provider, 'github');

    /* Half a feed is not a feed. Handing electron-updater something without a
       provider produces an error at check time, which reads as "updates are
       broken" rather than "updates were never set up". */
    write({ owner: 'someone', repo: 'something' });
    T.eq('a feed with no provider is refused', H.updateFeed(dir), null);

    fs.writeFileSync(path.join(dir, 'desktop', 'update-feed.json'), 'not json');
    T.eq('an unreadable feed is refused, not guessed at',
      H.updateFeed(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const feed = { provider: 'github', owner: 'a', repo: 'b' };
  T.ok('a failed check is reported, not swallowed',
    /update check failed/i.test(H.updateStatus(feed, 'failed', 'network down')));
  T.ok('with the reason', /network down/.test(
    H.updateStatus(feed, 'failed', 'network down')));
  T.ok('and says the app is unaffected',
    /app is unaffected/i.test(H.updateStatus(feed, 'failed', 'x')));
  T.ok('a failure with no reason still admits there was one',
    /no reason given/i.test(H.updateStatus(feed, 'failed')));

  T.report();
})();
