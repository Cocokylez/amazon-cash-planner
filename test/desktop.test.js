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

  {
    /* The data folder is machine-wide, so these have to run against an empty
       one or they find this computer's real token and pass for the wrong
       reason. That is what happened the moment the fallback was added. */
    const wasSet = process.env.FBA_DATA_DIR;
    process.env.FBA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-none-'));

    T.eq('a missing config is reported, not invented',
      H.readConfig(path.join(__dirname, 'no-such-installation')), null);

    /* Half a config is not a config: opening the app with no token would show
       a page that cannot talk to its own helper. */
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-cfg-'));
    fs.mkdirSync(path.join(dir, 'worker'));
    fs.writeFileSync(path.join(dir, 'worker', 'config.json'),
      JSON.stringify({ port: 8765 }));
    T.eq('a config with no token is refused', H.readConfig(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });

    if (wasSet === undefined) delete process.env.FBA_DATA_DIR;
    else process.env.FBA_DATA_DIR = wasSet;
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

  T.section('Desktop shell: a broken copy can still update itself');

  {
    /* This one is checked against the SOURCE, because the thing that matters
       is an ordering inside boot() and there is no way to observe it without
       a window. It is worth encoding anyway: the update check used to be the
       last line of a successful start, so a copy that could not start never
       asked for a newer one - and a copy that cannot start is exactly the one
       that needs the version where that is fixed. 4.9.1 sat unable to reach
       4.9.2, which would have repaired it. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    const boot = src.slice(src.indexOf('async function boot()'));
    const check = boot.indexOf('checkForUpdates()');
    const firstReturn = boot.indexOf('return;');

    T.ok('boot() checks for updates', check > -1);
    T.ok('before the first thing that can give up',
      check > -1 && firstReturn > -1 && check < firstReturn);

    /* And the news has somewhere to go when the app window never opens. */
    T.ok('update progress reaches the status window too',
      /statusWindow[\s\S]{0,400}update/i.test(src)
      || /setUpdateState[\s\S]{0,600}statusWindow/.test(src));
  }

  T.section('Desktop shell: Python and JavaScript agree where data lives');

  {
    /* THE bug this guards. worker/paths.py moved the token and the virtual
       environment to a folder outside the install directory. desktop/helper.js
       was left looking beside the code. So setup wrote the token to the new
       place, the app looked in the old one, and told someone the helper was
       not set up moments after they had set it up. Neither side could tell
       anything was wrong, because each was internally consistent.

       Two languages, one answer. Asked of both, every run. */
    const { execFileSync } = require('node:child_process');
    const py = path.join(__dirname, '..', 'worker', 'venv', 'Scripts', 'python.exe');
    if (fs.existsSync(py)) {
      const fromPython = execFileSync(py, ['-c',
        'import sys; sys.path.insert(0, r"' + path.join(__dirname, '..', 'worker')
        + '"); import paths; print(paths.data_dir())'],
        { encoding: 'utf8' }).trim();
      T.eq('the same folder, in both languages', H.dataDir(), fromPython);
    } else {
      T.ok('python environment present to compare against', false);
    }

    /* And the override has to work in both, or a test run migrates a live
       installation as a side effect of importing a module. */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-dd-'));
    const before = process.env.FBA_DATA_DIR;
    process.env.FBA_DATA_DIR = tmp;
    T.eq('the override is honoured', H.dataDir(), tmp);
    if (before === undefined) delete process.env.FBA_DATA_DIR;
    else process.env.FBA_DATA_DIR = before;
  }

  {
    /* An installation part-way through moving still has its environment beside
       the code. Refusing to look there would break a copy that works. */
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-old-'));
    fs.mkdirSync(path.join(root, 'worker'), { recursive: true });
    fs.writeFileSync(path.join(root, 'worker', 'config.json'),
      JSON.stringify({ token: 'abc', port: 8765 }));

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-empty-'));
    const before = process.env.FBA_DATA_DIR;
    process.env.FBA_DATA_DIR = empty;
    const cfg = H.readConfig(root);
    T.ok('a token still beside the code is found', !!cfg && cfg.token === 'abc');

    /* But the data folder wins when both exist: that is the one setup writes
       to now, so it is the current one. */
    fs.writeFileSync(path.join(empty, 'config.json'),
      JSON.stringify({ token: 'newer', port: 8765 }));
    T.eq('and the data folder takes precedence',
      (H.readConfig(root) || {}).token, 'newer');

    if (before === undefined) delete process.env.FBA_DATA_DIR;
    else process.env.FBA_DATA_DIR = before;
  }

  {
    /* Same trap as the data folder: two languages computing one identity.
       When they disagree, a copy mistakes itself for a stranger - or worse,
       mistakes a stranger for itself. */
    const { execFileSync } = require('node:child_process');
    const py = path.join(__dirname, '..', 'worker', 'venv', 'Scripts', 'python.exe');
    if (fs.existsSync(py)) {
      const fromPython = execFileSync(py, ['-c',
        'import sys; sys.path.insert(0, r"' + path.join(__dirname, '..', 'worker')
        + '"); import launch; print(launch.instance_id())'],
        { encoding: 'utf8' }).trim();
      T.eq('the installation id agrees across languages',
        H.instanceId(path.join(__dirname, '..')), fromPython);
    }
  }

  T.section('One version number, kept in three files by hand');

  {
    /* package.json, worker.py and lib/selftest.js each carry the version, and
       every release has meant editing all three. A release where they
       disagree ships an app that tells its owner the helper is the wrong
       version - a confusing way to find out somebody forgot a sed. */
    const root = path.join(__dirname, '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const worker = (/^HELPER_VERSION = "([^"]+)"/m
      .exec(fs.readFileSync(path.join(root, 'worker', 'worker.py'), 'utf8')) || [])[1];
    const selftest = (/EXPECTED_HELPER = '([^']+)'/
      .exec(fs.readFileSync(path.join(root, 'lib', 'selftest.js'), 'utf8')) || [])[1];

    T.eq('worker.py matches package.json', worker, pkg);
    T.eq('selftest.js matches package.json', selftest, pkg);
  }

  T.section('Desktop shell: finding a Python to set up with');

  {
    /* Setup needs an interpreter before it has one of its own. The app can
       find it, which is what lets it offer a button instead of handing
       someone a path to a .cmd file - the moment every reinstall so far has
       ended at. */
    const fake = versions => (exe, args) => {
      if (!(exe in versions)) { const e = new Error('not found'); throw e; }
      return versions[exe];
    };

    const modern = H.findPython(fake({ py: '3.12.10' }));
    T.eq('a current Python is found', modern.found, true);
    T.eq('and its version is reported', modern.version, '3.12.10');

    /* Too old and absent are DIFFERENT problems. Telling someone to install
       Python when they already have it is how they conclude the app is
       broken. */
    const old = H.findPython(fake({ python: '3.8.10' }));
    T.eq('an old Python is not accepted', old.found, false);
    T.eq('and is called out as old, not missing', old.reason, 'old');
    T.ok('naming the version they actually have',
      old.detail.includes('3.8.10'));
    T.ok('and saying the old one can stay',
      /can stay/i.test(old.detail));

    const none = H.findPython(fake({}));
    T.eq('no Python at all is its own answer', none.reason, 'none');
    T.ok('which explains why it is needed',
      /small Python program/i.test(none.detail));
    T.ok('and warns about the one setting people miss',
      /Add python\.exe to PATH/i.test(none.detail));

    /* A newer one is preferred over an older one that also answers. */
    const both = H.findPython(fake({ py: '3.12.1', python: '3.8.0' }));
    T.eq('the launcher is asked first', both.version, '3.12.1');

    /* Garbage from a shim must not read as a version. */
    T.eq('nonsense output is not a Python',
      H.findPython(fake({ py: 'Python was not found; run without arguments' })).found,
      false);
  }

  T.section('Desktop shell: is the helper ready?');

  {
    const wasSet = process.env.FBA_DATA_DIR;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-state-'));
    process.env.FBA_DATA_DIR = empty;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fba-root-'));
    fs.mkdirSync(path.join(root, 'worker'), { recursive: true });
    T.eq('nothing installed reads as no-python', H.setupState(root), 'no-python');

    /* An environment but no token is its own state: setup got part-way. */
    const vdir = path.join(empty, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin');
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(path.join(vdir,
      process.platform === 'win32' ? 'python.exe' : 'python'), '');
    T.eq('an environment with no token is no-config', H.setupState(root), 'no-config');

    fs.writeFileSync(path.join(empty, 'config.json'),
      JSON.stringify({ token: 'abc', port: 8765 }));
    T.eq('both present is ready', H.setupState(root), 'ready');

    if (wasSet === undefined) delete process.env.FBA_DATA_DIR;
    else process.env.FBA_DATA_DIR = wasSet;
  }

  T.section('Desktop shell: another copy of this app on the port');

  {
    /* "Port belongs to another app or installation" was a dead end: a second
       copy of THIS app was treated exactly like somebody's unrelated web
       server, so the only way forward was to go and find it yourself. The
       two are now told apart. */
    const root = path.join(__dirname, '..');

    const mine = H.instanceId(root);
    T.ok('an installation has an id', /^[0-9a-f]{20}$/.test(mine));
    T.ok('and a different folder is a different installation',
      H.instanceId(path.join('C:', 'elsewhere')) !== mine);

    const serve = payload => {
      const srv = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      });
      return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
    };

    let srv = await serve({ worker: 'fba-local-worker', instance: mine });
    T.eq('this very installation reads as ours',
      await H.portState({ port: srv.address().port, token: 'x' }, 2000, root),
      'ours');
    await new Promise(r => srv.close(r));

    srv = await serve({ worker: 'fba-local-worker', instance: 'somethingelse' });
    T.eq('another installation of this app is a sibling',
      await H.portState({ port: srv.address().port, token: 'x' }, 2000, root),
      'sibling');
    await new Promise(r => srv.close(r));

    /* The line that must never move. Somebody else's program is not this
       program's to end, however convenient that would be. */
    srv = await serve({ hello: 'some other server' });
    T.eq('anything else is still a stranger',
      await H.portState({ port: srv.address().port, token: 'x' }, 2000, root),
      'stranger');
    await new Promise(r => srv.close(r));

    /* A sibling that will not stop is reported, not forced. */
    const stubborn = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ worker: 'fba-local-worker', instance: 'other' }));
    });
    await new Promise(r => stubborn.listen(0, '127.0.0.1', r));
    const gone = await H.askSiblingToStop(
      { port: stubborn.address().port, token: 'x' }, root, 2500);
    T.eq('a sibling that keeps answering is not reported as stopped',
      gone, false);
    await new Promise(r => stubborn.close(r));
  }

  T.report();
})();
