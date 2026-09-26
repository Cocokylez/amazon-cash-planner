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
    /* paths.py needs nothing but the standard library, so any Python will
       do: the development environment if there is one, else the system's. */
    const venvPy = path.join(__dirname, '..', 'worker', 'venv', 'Scripts', 'python.exe');
    let fromPython = null;
    for (const py of [venvPy, 'python', 'py']) {
      if (py === venvPy && !fs.existsSync(py)) continue;
      try {
        fromPython = execFileSync(py, ['-c',
          'import sys; sys.path.insert(0, r"' + path.join(__dirname, '..', 'worker')
          + '"); import paths; print(paths.data_dir())'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        break;
      } catch (e) { /* try the next */ }
    }
    if (fromPython != null) T.eq('the same folder, in both languages', H.dataDir(), fromPython);
    else T.ok('a Python to compare against (none found on this computer)', false);

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
    /* Any Python: launch.py needs only the standard library to import. */
    const venvPy = path.join(__dirname, '..', 'worker', 'venv', 'Scripts', 'python.exe');
    let fromPython = null;
    for (const py of [venvPy, 'python', 'py']) {
      if (py === venvPy && !fs.existsSync(py)) continue;
      try {
        fromPython = execFileSync(py, ['-c',
          'import sys; sys.path.insert(0, r"' + path.join(__dirname, '..', 'worker')
          + '"); import launch; print(launch.instance_id())'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        break;
      } catch (e) { /* try the next */ }
    }
    if (fromPython != null) {
      T.eq('the installation id agrees across languages',
        H.instanceId(path.join(__dirname, '..')), fromPython);
    } else T.ok('a Python to compare the installation id against (none found)', false);
  }

  {
    /* The check used to happen once, at launch - so an app left open, which
       is the whole point of it, would never see a release published an hour
       later. "I waited" met with nothing happening, because nothing was. */
    const src = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    T.ok('the app keeps asking while it is open',
      /setInterval\([\s\S]{0,200}checkForUpdates/.test(src));
    T.ok('and the repeat is started once the app is up',
      src.includes('keepCheckingForUpdates()'));
    T.ok('without keeping the app alive on its own',
      /recheckTimer\.unref/.test(src));
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

  /* The update bar.

     An update used to download, sit ready, and never get installed, because
     the only thing that said so was inside a collapsed panel below the
     mirror. These check the notice is somewhere it will actually be seen -
     not that it looks a particular way, but that it is not buried again. */
  {
    const fs2 = require('fs');
    const pj = (...a) => require('path').join(__dirname, '..', ...a);
    const html = fs2.readFileSync(pj('app.html'), 'utf8');
    const appjs = fs2.readFileSync(pj('lib', 'app.js'), 'utf8');

    T.ok('the page has a slot for the update notice',
      html.includes('id="updatebar"'));
    /* 6.0 (Ledger): straight under the toolbar - the toolbar is the window's
       title bar now, with Windows' buttons over its end - and above the page. */
    T.ok('and it sits at the top of every page, not inside a panel',
      html.indexOf('<header id="top"') < html.indexOf('id="updatebar"')
      && html.indexOf('id="updatebar"') < html.indexOf('id="largetitle"')
      && html.indexOf('id="updatebar"') < html.indexOf('id="view"'));
    T.ok('an empty slot takes up no room',
      html.includes('#updatebar:empty { display: none; }'));

    T.ok('something fills it on every render',
      /\$\('#updatebar'\)/.test(appjs));
    T.ok('a downloaded update offers to install itself',
      /u\.ready[\s\S]{0,600}data-installupdate/.test(appjs));
    T.ok('and names the version that is waiting',
      /u\.ready[\s\S]{0,400}readyVersion/.test(appjs));

    /* Being up to date is not news. A bar that is always there is furniture,
       and furniture does not get read. */
    const bar = appjs.slice(appjs.indexOf('function updateBar()'),
      appjs.indexOf('function render()'));
    T.ok('being up to date shows nothing', !/'current'/.test(bar));
    T.ok('and a quiet check shows nothing', !/'checking'/.test(bar));
    T.ok('only ready and downloading are loud',
      /u\.ready/.test(bar) && /'available'/.test(bar));
  }

  /* A helper left over from the previous version.

     This is what made every Supabase fix look like it had not worked: the
     app updated, the helper's files were replaced, but the running Python
     process kept the old code in memory. The app found it healthy, said
     "already running", and served everything from the version it had just
     replaced - for hours. */
  {
    const serveVersion = (v, extra) => new Promise(resolve => {
      const srv2 = http.createServer((req, res) => {
        if (req.url.startsWith('/api/health')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(Object.assign(
            { ok: true, worker: 'fba-local-worker', version: v }, extra || {})));
          return;
        }
        res.writeHead(404); res.end();
      });
      srv2.listen(0, '127.0.0.1', () => resolve(srv2));
    });

    let s2 = await serveVersion('4.9.14');
    const cfg2 = { port: s2.address().port, token: 'x' };
    T.eq('the running helper\'s version can be read',
      await H.helperVersion(cfg2), '4.9.14');
    await new Promise(r => s2.close(r));

    /* The distinction that matters: which version is LOADED, not which is
       installed. A file on disk proves nothing about a running process. */
    s2 = await serveVersion('4.9.16');
    T.eq('a current helper reports the current version',
      await H.helperVersion({ port: s2.address().port, token: 'x' }), '4.9.16');
    await new Promise(r => s2.close(r));

    const srv3 = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'not the worker', version: '9.9.9' }));
    });
    await new Promise(r => srv3.listen(0, '127.0.0.1', r));
    T.eq('a stranger is never read for a version',
      await H.helperVersion({ port: srv3.address().port, token: 'x' }), null);
    await new Promise(r => srv3.close(r));

    T.eq('and nothing listening is not a version',
      await H.helperVersion({ port: 1, token: 'x' }, 600), null);

    /* The app must ACT on a mismatch, not just report one. Reporting it is
       what it already did, in a panel, while staying broken. */
    const fs3 = require('fs');
    const main = fs3.readFileSync(
      require('path').join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
    T.ok('the app compares the running helper against itself',
      /helperVersion\(cfg\)[\s\S]{0,300}app\.getVersion\(\)/.test(main));
    T.ok('and asks a stale one to stop rather than using it',
      /running !== app\.getVersion\(\)[\s\S]{0,500}askSiblingToStop/.test(main));
    T.ok('and says so plainly when it will not stop',
      /did not stop when asked[\s\S]{0,120}Nothing was forced/.test(main));
  }

  /* The cloud-copy settings, and the first-launch setup window.

     The settings used to be read once at startup, BEFORE the helper
     connection existed: the read saw no helper, returned, and the panel
     said "Not set up" about a project that was set up. Any failure was
     swallowed the same way. These pin the order and the honesty. */
  {
    const fs4 = require('fs');
    const app = fs4.readFileSync(require('path').join(__dirname, '..', 'lib', 'app.js'), 'utf8');
    const boot = app.slice(app.indexOf('async function workerBoot'), app.indexOf('async function refreshJobs'));
    T.ok('the settings are read after the helper is known, not before',
      /state\.workerInfo = await[\s\S]*await loadMirror\(\)/.test(boot));
    T.ok('nothing reads them on its own at startup any more', !/mirrorBoot\(\)/.test(app));
    const load = app.slice(app.indexOf('async function loadMirror'), app.indexOf('function aboutPanel'));
    T.ok('a failed read is retried', /setTimeout\(\(\) => loadMirror\(attempt \+ 1\)/.test(load));
    T.ok('and ends as its own state, not as "not set up"', /mirrorLoad = 'failed'/.test(load));
    T.ok('the panel says it could not check, rather than that nothing is there',
      /Could not check/.test(app) && /not the same[\s\S]{0,20}as not being set up/.test(app));
    T.ok('the setup window can always be skipped', /data-setupskip[\s\S]{0,200}Skip for now/.test(app));
    T.ok('and a skipped setup stays visible on the Dashboard',
      /state\.screen === 'dashboard' \? setupCard\(\)/.test(app));
  }

  /* The page loads nothing from anywhere else.

     The font used to come from Google Fonts on every launch - a request that
     told a third party each time the app opened, and failed offline. It is
     bundled now; this keeps any remote resource from creeping back in. */
  {
    const fs5 = require('fs');
    const p5 = (...a) => require('path').join(__dirname, '..', ...a);
    const html = fs5.readFileSync(p5('app.html'), 'utf8');
    const remote = html.match(/<(?:link|script|img|iframe)[^>]+(?:href|src)=["']https?:\/\/[^"']+/gi) || [];
    T.eq('the page references no remote stylesheet, script or image', remote, []);
    T.ok('nor any remote font', !/url\(\s*["']?https?:/i.test(html));
    const faces = [...html.matchAll(/url\("(lib\/fonts\/[^"]+)"\)/g)].map(m => m[1]);
    T.ok('every bundled font the page names exists',
      faces.length > 0 && faces.every(f => fs5.existsSync(p5(f))));
    T.ok('and the font licence ships beside them', fs5.existsSync(p5('lib', 'fonts', 'OFL.txt')));
  }

  /* Automatic sending to the mirror: the switch, the route it calls, and the
     helper answering that route. Three files that must agree; a rename in any
     one would leave a switch that silently does nothing. */
  {
    const fs6 = require('fs');
    const p6 = (...a) => require('path').join(__dirname, '..', ...a);
    const app = fs6.readFileSync(p6('lib', 'app.js'), 'utf8');
    const client = fs6.readFileSync(p6('lib', 'worker.js'), 'utf8');
    const helper = fs6.readFileSync(p6('worker', 'worker.py'), 'utf8');
    T.ok('the panel has the automatic-sending switch', /id="mirrorauto"/.test(app));
    T.ok('and a handler that calls the helper with it',
      /id === 'mirrorauto'[\s\S]{0,200}mirrorAuto\(/.test(app));
    T.ok('the client sends it to /supabase/auto', /mirrorAuto:[\s\S]{0,80}'\/supabase\/auto'/.test(client));
    T.ok('the helper answers /api/supabase/auto', helper.includes('parsed.path == "/api/supabase/auto"'));
    T.ok('the helper starts its sender at launch', /MIRROR_SYNC\.start\(\)/.test(helper));
    T.ok('a stored report wakes the sender', /if stored:\s*\n\s*MIRROR_SYNC\.poke/.test(helper));
    T.ok('a deleted report wakes it too', /if forgotten:\s*\n\s*MIRROR_SYNC\.poke/.test(helper));
    T.ok('Send now and the sender share one lock',
      /with SYNC_LOCK:\s*\n\s*result = supabase\.sync\(/.test(helper));
  }

  /* The three hand-entered inputs. Their rules are tested in inputs.test.js;
     these check the page actually wires them up - a module the page never
     loads would pass every rule test and still do nothing. */
  {
    const fs7 = require('fs');
    const p7 = (...a) => require('path').join(__dirname, '..', ...a);
    const html = fs7.readFileSync(p7('app.html'), 'utf8');
    const app = fs7.readFileSync(p7('lib', 'app.js'), 'utf8');
    const at = n => html.indexOf('<script src="lib/' + n + '"></script>');
    T.ok('the page loads the inputs module', at('inputs.js') > 0);
    T.ok('after what it needs, before the app', at('recon.js') < at('inputs.js') && at('inputs.js') < at('app.js'));
    T.ok('no input card says the app cannot take it any more', !/cannot take this input yet/.test(app));
    for (const id of ['depositsform', 'costsform', 'adsform']) {
      T.ok('the ' + id + ' card exists and its cards jump to it',
        app.includes('id="' + id + '"') && app.includes('data-jump="' + id + '"'));
    }
    T.ok('the engines see measured transit, not only the typed rules',
      (app.match(/policy: enginePolicy\(\)/g) || []).length >= 3);
    T.ok('the Measured tag comes from a real measurement', /const measured = t\.available;/.test(app)
      && !/const measured = state\.bankDeposits\.length > 0/.test(app));
    T.ok('profit gets external advertising from the records, not a hard null',
      !/externalAdvertising: null,/.test(app));
    T.ok('forecast-only profit matches costs by MSKU', !/\[c\.sku, c\]/.test(app));
  }

  /* Ask Claude. The rules and the network call are tested in claude.test.js;
     these check the boundary: the key stays in the shell, and only the app
     window can reach it. */
  {
    const fs8 = require('fs');
    const p8 = (...a) => require('path').join(__dirname, '..', ...a);
    const pre = fs8.readFileSync(p8('desktop', 'app-preload.js'), 'utf8');
    const main = fs8.readFileSync(p8('desktop', 'main.js'), 'utf8');
    const app = fs8.readFileSync(p8('lib', 'app.js'), 'utf8');
    const pkg = JSON.parse(fs8.readFileSync(p8('package.json'), 'utf8'));
    T.ok('the SDK ships with the app, pinned', /^\d+\.\d+\.\d+$/.test((pkg.dependencies || {})['@anthropic-ai/sdk'] || ''));
    const exposed = (pre.match(/claude:\s*\{([\s\S]*?)\n  \},/) || [, ''])[1];
    T.eq('the page gets four things and no getter for the key',
      (exposed.match(/^\s{4}(\w+)[:(]/gm) || []).map(s => s.trim().replace(/[:(]$/, '')).join(','),
      'status,connect,forget,ask');
    for (const ch of ['claude:status', 'claude:connect', 'claude:forget', 'claude:ask']) {
      const at = main.indexOf("ipcMain.handle('" + ch + "'");
      T.ok(ch + ' answers only the app window', at > 0 && /fromAppWindow\(event\)/.test(main.slice(at, at + 200)));
    }
    T.ok('the key is encrypted by safeStorage', /safeStorage\.encryptString/.test(main));
    T.ok('the shell log records counts, never the question or answer',
      !/logLine\([^)]*(question|brief|r\.text)/.test(main));
    T.ok('the page asks the shell before anything else', /const dc = desktopClaude\(\);\s*if \(dc\)/.test(app));
  }

  /* Your figures on your other computers. Only ever through the helper's
     locked table - never the artifact store that had no server-side access
     control - and only once the project itself says it is ready. */
  {
    const fs9 = require('fs');
    const p9 = (...a) => require('path').join(__dirname, '..', ...a);
    const app = fs9.readFileSync(p9('lib', 'app.js'), 'utf8');
    const sync = fs9.readFileSync(p9('lib', 'sync.js'), 'utf8');
    const creates = app.match(/Sync\.create\(\{[\s\S]{0,80}/g) || [];
    T.ok('every sync the app starts writes through the helper',
      creates.length > 0 && creates.every(c => /use: Sync\.helperStore\(state\.worker\)/.test(c)));
    T.ok('sync never falls back to the artifact store', !/globalThis\.claude\.use/.test(sync));
    T.ok('it starts only after the project answers ready',
      /cloudStatus\(\)[\s\S]{0,400}if \(!st \|\| !st\.ready\)/.test(app));
    T.ok('disconnecting stops it', (app.match(/stopCloudSync\(\)/g) || []).length >= 2);
  }

  /* An update is never installed over a running helper. It was, whenever
     Windows had started the helper at login: the installer then emptied the
     helper's folder and the app could not start at all. */
  {
    const fs11 = require('fs');
    const p11 = (...a) => require('path').join(__dirname, '..', ...a);
    const main = fs11.readFileSync(p11('desktop', 'main.js'), 'utf8');
    const Hx = require('../desktop/helper.js');
    const inst = main.slice(main.indexOf("ipcMain.handle('shell:install-update'"));
    T.ok('installing stops the helper whoever started it, and checks it is gone',
      /stopHelperForUpdate\(readConfig\(\)\)/.test(inst.slice(0, 600))
      && /if \(!stopped\)[\s\S]{0,200}return \{ ok: false/.test(inst.slice(0, 900)));
    T.ok('installing on quit does the same, or keeps the update for next time',
      /window-all-closed[\s\S]{0,400}stopHelperForUpdate[\s\S]{0,400}autoInstallOnAppQuit = false/.test(main));
    T.ok('the helper is started from the data folder', /cwd: H\.dataDir\(\)/.test(main));
    const tmp = fs11.mkdtempSync(require('path').join(require('os').tmpdir(), 'acp-inst-'));
    fs11.mkdirSync(require('path').join(tmp, 'worker'));
    T.eq('an emptied install is recognised, file by file',
      Hx.missingProgramFiles(tmp).join(','), 'worker/launch.py,worker/worker.py,worker/paths.py,app.html');
    T.ok('and said as what it is, with a way to get the installer',
      /This installation is incomplete[\s\S]{0,400}kind: 'open-releases'/.test(main));
  }

  /* A finished report never shows an old error, and is imported once. */
  {
    const fs12 = require('fs');
    const p12 = (...a) => require('path').join(__dirname, '..', ...a);
    const app = fs12.readFileSync(p12('lib', 'app.js'), 'utf8');
    const helper = fs12.readFileSync(p12('worker', 'worker.py'), 'utf8');
    T.ok('marking a report imported clears any earlier error',
      /status="complete", finishedAt=now\(\), lastError=None/.test(helper));
    T.ok('the reports table shows what a finished report did, not a stale error',
      (app.match(/status === 'complete' \? \((j|job)\.statusDetail \|\| ''\)/g) || []).length === 2);
    T.ok('two refreshes cannot import the same report at once',
      /importingNow\.has\(j\.jobId\)/.test(app) && /finally \{\s*importingNow\.delete\(j\.jobId\)/.test(app)
      && !/_taken/.test(app));
    T.ok('the download panel says what the window will ask for, not an invented period',
      /It opens on the next eight weeks/.test(app)
      && !/state\.filters\.to \|\| CSV\.addDays\(state\.today, 13\)/.test(app));
  }

  /* The same file downloaded twice: counted once, belonging to both, and
     never taken away by deleting one of them. */
  {
    const fs13 = require('fs');
    const app = fs13.readFileSync(require('path').join(__dirname, '..', 'lib', 'app.js'), 'utf8');
    T.ok('an import remembers every download that delivered it',
      /rec\.jobIds = \[\.\.\.new Set/.test(app) && !/rec\.jobId = j\.jobId;/.test(app));
    T.ok('so an earlier download is not imported again on every refresh',
      /Array\.isArray\(r\.jobIds\) && r\.jobIds\.indexOf\(id\) >= 0/.test(app));
    T.ok('a repeat download reports the rows already there, not "None of None"',
      /sameAs: rec\.name/.test(app));
    T.ok('deleting one of two downloads of the same file keeps its figures',
      /imp && !keepFigures \? removeImport\(imp\.id\)/.test(app));
  }

  /* The "Get Amazon data" window: nothing is requested until the dates and
     country have been shown and Download pressed. */
  {
    const fs14 = require('fs');
    const p14 = (...a) => require('path').join(__dirname, '..', ...a);
    const app = fs14.readFileSync(p14('lib', 'app.js'), 'utf8');
    const helper = fs14.readFileSync(p14('worker', 'worker.py'), 'utf8');
    const startAll = app.slice(app.indexOf('async function startAll()'), app.indexOf('function openGetWindow('));
    T.ok('the button opens the window instead of downloading straight away',
      /return openGetWindow\(\);/.test(startAll) && !/return getTodaysData\(\);/.test(startAll));
    T.ok('the window sends its own forecast and history dates',
      /forecast: \(choice && choice\.forecast\) \|\| null/.test(app) && /history: \(choice && choice\.history\) \|\| null/.test(app));
    T.ok('the forecast cannot start before tomorrow', /g\.fFrom < tomorrow/.test(app));
    T.ok('the window is the forecast only - no transaction history section',
      !/Transaction history \\u00b7 Payments/.test(app) && /history: null/.test(app));
    T.ok('the helper uses the window’s forecast dates as a custom range',
      /if fc_win:[\s\S]{0,200}drange = "Custom date range"[\s\S]{0,40}dfrom, dto = fc_win/.test(helper));
    T.ok('and the window’s history dates, never reaching the future',
      /history_window\(\*\(hist_win or \(override_from, override_to\)\)\)/.test(helper));
  }

  /* The forecast-only app: two screens, the forecast first. */
  {
    const fs16 = require('fs');
    const p16 = (...a) => require('path').join(__dirname, '..', ...a);
    const app = fs16.readFileSync(p16('lib', 'app.js'), 'utf8');
    const html = fs16.readFileSync(p16('app.html'), 'utf8');
    const nav = app.slice(app.indexOf('const SCREENS = ['), app.indexOf('const HIDDEN_SCREENS = ['));
    T.eq('the navigation is the forecast and the downloads',
      (nav.match(/id: '(\w+)'/g) || []).join(','), "id: 'sales',id: 'data'");
    T.ok('the app opens on the forecast', /screen: 'sales', tab: null/.test(app));
    T.ok('the old screens are kept, just not in the navigation', /const HIDDEN_SCREENS = \[/.test(app)
      && /screens\.dashboard = function|screens\.dashboard=/.test(app));
    T.ok('the forecast screen reads the new calculation, newest download first', /forecastOf\(scoped, from, to\)/.test(app)
      && /const forecastOf = \(previews, from, to\) => Simple\.forecastFor\(previews, from, to, \{ whenOf: previewWhen\(\) \}\)/.test(app));
    T.ok('which the page loads', html.indexOf('<script src="lib/simple.js"></script>') > html.indexOf('lib/dataset.js')
      && html.indexOf('lib/simple.js') < html.indexOf('lib/app.js'));
    const dataScreen = app.slice(app.indexOf('screens.data = function'), app.indexOf('screens.data = function') + 6000);
    T.ok('Downloads no longer asks for balances, rules, deposits, costs or ad billing',
      !/depositsCard\(\)|payoutRulesCard\(\)|dataTiles\(ds\)|costsCard\(\)|adsCard\(\)/.test(dataScreen));
    const inputs = app.slice(app.indexOf('screens.inputs = function'), app.indexOf('screens.settings = function'));
    T.ok('they are under More tools, each only while Settings has it on',
      ['balance', 'rules', 'deposits', 'costs', 'ads'].every(k => inputs.indexOf('if (state.show.' + k + ')') >= 0));
    T.ok('the payout rules card is the one 5.0 took out, not a rewrite', /function payoutRulesCard\(\)/.test(app)
      && /Save the account rules/.test(app));
    T.ok('More tools lists every screen 5.0 took out of the navigation',
      /for \(const s of HIDDEN_SCREENS\)/.test(app) && /id="moretoggle"/.test(app));
    T.ok('and Settings is always in the sidebar', /for \(const s of APP_SCREENS\)/.test(app)
      && /id: 'settings'/.test(app));
    T.ok('Settings has a switch for each of the five, and More tools',
      /\{ key: 'balance'[\s\S]*key: 'rules'[\s\S]*key: 'deposits'[\s\S]*key: 'costs'[\s\S]*key: 'ads'/.test(app)
      && /sw\('more', 'More tools'/.test(app));
    T.ok('which are kept, and turning one off deletes nothing', /localStorage\.setItem\('fba-show-v1'/.test(app)
      && /nothing you entered is deleted/.test(app));
    T.ok('the sidebar says what forecast is loaded, not a feature count', /\$\('#sidenote'\)\.innerHTML = forecastStatus\(\);/.test(app));
  }

  /* Supabase is where the figures are kept. */
  {
    const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'app.js'), 'utf8');
    const push = app.slice(app.indexOf('async function syncPush('), app.indexOf('/* Resolving a conflict'));
    T.ok('files go up before the list that names them', push.indexOf('putBlob(') > 0
      && push.indexOf('putBlob(') < push.indexOf('pushState('));
    T.ok('"saved" is said only after asking the project', push.indexOf('pullState()') > push.indexOf('pushState(')
      && push.indexOf("setStatus('saved'") > push.indexOf('readManifest()', push.indexOf('pushState(')));
    T.ok('every computer checks the project every minute', /setInterval\(syncPull, 60000\)/.test(app));
    T.ok('and when its window comes back into view', /visibilitychange[\s\S]{0,80}pullIfStale/.test(app));
    T.ok('taking the project\u2019s copy is not sent straight back', /persist\(\{ quiet: true \}\)/.test(app)
      && /if \(!\(opts && opts\.quiet\)\) scheduleSyncPush\(\);/.test(app)
      && /Sync\.sameState\(merged, remote\.payload\)/.test(app));
    T.ok('the sidebar always says where the figures are', /row\('Supabase', cloud\[0\], cloud\[1\]\)/.test(app));
    T.ok('and every screen says so while Supabase is not holding them', /updateBar\(\) \+ scheduleBar\(\) \+ cloudBar\(\)/.test(app));
    T.ok('setup finishes with the one-time table', /Step ' \+ step \+ ' of 3/.test(app) && /data-copysql/.test(app)
      && /data-cloudcheck/.test(app));
  }

  /* The morning download: careful, stoppable, and in the person's hands. */
  {
    const fs3 = require('fs'), p3 = (...a) => require('path').join(__dirname, '..', ...a);
    const app = fs3.readFileSync(p3('lib', 'app.js'), 'utf8');
    const main = fs3.readFileSync(p3('desktop', 'main.js'), 'utf8');
    const run = app.slice(app.indexOf('async function runSchedule('), app.indexOf('function markScheduled('));
    T.ok('in batches: up to a set number asked for, one after another, then collected',
      /for \(let b = 0; b < windows\.length && run\.status !== 'stopping'; b \+= cfg\.batchSize\)/.test(run)
      && /const r = await askWindow\(w\);/.test(run) && /const r = await collectWindow\(x\.jobId, x\.w\);/.test(run));
    T.ok('each request waited for before the next, with a pause between them',
      /await pause\(cfg\.askGapSeconds \* 1000\)/.test(run) && /await pause\(cfg\.gapSeconds \* 1000\)/.test(run));
    T.ok('asking stops once Amazon has the request; collecting uses the saved ticket',
      /requestOnly: true/.test(run) && /state\.worker\.collect\(jobId\)/.test(run));
    const sk = fs3.readFileSync(p3('worker', 'sku_economics.py'), 'utf8');
    T.ok('the driver stops after Generate when asked only', /if request_only:\s*progress\("requested"/.test(sk));
    T.ok('a sign-in, CAPTCHA or check stops it and tells the person',
      /j\.status === 'login-required'[\s\S]{0,300}needsYou\(/.test(run));
    T.ok('and nobody there: it waits for Continue rather than trying the rest', /await waitForContinue\(\)/.test(run));
    T.ok('three failures in a row stop it', /\+\+inARow >= 3/.test(run));
    T.ok('it never asks for more than the daily cap', /maxPerDay/.test(fs3.readFileSync(p3('lib', 'schedule.js'), 'utf8')));
    T.ok('it asks Amazon for a fresh report, marked as the schedule\u2019s', /fresh: true, scheduled: w\.kind/.test(run));
    T.ok('a replaced download is recorded, so it is never imported back over the newer one',
      /Recorded as let go[\s\S]{0,700}Sync\.removal\(replaced, at\)/.test(app) && /!letGo\.has\(j\.jobId\)/.test(app));
    T.ok('only files the schedule downloaded are let go', /if \(i\.family !== 'Fees & Economics Preview' \|\| !i\.schedule\) continue;/.test(app));
    T.ok('test shortcuts never apply in the installed app', /if \(window\.desktopShell \|\| !\/\^\(localhost/.test(app));
    T.ok('only one copy of the app runs', /requestSingleInstanceLock\(\)/.test(main));
    T.ok('it can start with Windows, quietly', /setLoginItemSettings\(\{ openAtLogin: on, args: \['--hidden'\] \}\)/.test(main)
      && /show: !HIDDEN/.test(main) && /if \(!HIDDEN\) appWindow\.show\(\)/.test(main));
    T.ok('closing the window keeps it in the tray only while it starts with Windows',
      /if \(!quitting && startsWithWindows\(\)\) \{\s*e\.preventDefault\(\);\s*appWindow\.hide\(\);/.test(main));
    T.ok('the computer stays awake only while a run is going', /powerSaveBlocker\.start\('prevent-app-suspension'\)/.test(main)
      && /powerSaveBlocker\.stop\(keepAwake\)/.test(main));
    T.ok('a started-by-Windows copy shows itself when something needs the person',
      /if \(HIDDEN && kind && kind !== 'working'/.test(main));
  }

  /* Several computers, one morning download. */
  {
    const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'app.js'), 'utf8');
    const take = app.slice(app.indexOf('async function takeLease('), app.indexOf('async function keepLease('));
    T.ok('a computer writes its name, waits, and reads it back before going ahead',
      /writeLease\(/.test(take) && /await pause\(/.test(take) && /back\.device !== me/.test(take));
    T.ok('a live run on another computer makes this one stand down', /cur\.status === 'running' && leaseFresh\(cur\)/.test(take));
    T.ok('and one already done there today is not done again (unless asked by hand)',
      /other && cur\.status !== 'running' && !byHand/.test(take));
    const run = app.slice(app.indexOf('async function runSchedule('), app.indexOf('async function fetchWindow('));
    T.ok('before every report: still ours?', /if \(!\(await keepLease\(today\)\)\)/.test(run));
    T.ok('and a date another computer already fetched is skipped',
      /await syncPull\(\);\s*if \(scheduleDoneToday\(today\)\.has\(Schedule\.key\(w\)\)\)/.test(run));
    T.ok('the note is let go at the end', /await releaseLease\(today, run\.status\)/.test(run));
    T.ok('a duplicate that slipped through is cleared from this helper and Supabase too',
      /letGo\.has\(j\.jobId\) && j\.scheduled[\s\S]{0,200}state\.worker\.remove\(j\.jobId\)/.test(app));
    T.ok('if the computer set to run it has not, two hours on another steps in', /standInTime\(cfg\.time\)/.test(app)
      && /runSchedule\('stand-in'\)/.test(app));
    T.ok('standing in only where computers can see each other', /const supportsStandIn = \(\) => canShare\(\);/.test(app));
    const sb = require('fs').readFileSync(require('path').join(__dirname, '..', 'worker', 'supabase.py'), 'utf8');
    T.ok('the helper keeps that note, and nothing else new', /\(state\|lease\|blobs/.test(sb));
  }

  /* The guide: whole on a first install, what changed after an update. */
  {
    const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'app.js'), 'utf8');
    const pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'package.json'), 'utf8'));
    const latest = (app.match(/\{ version: '(\d+\.\d+\.\d+)', steps:/g) || []).pop() || '';
    T.ok('this version says what changed in it', latest.indexOf("'" + pkg.version + "'") >= 0);
    T.ok('the guide starts by itself', /setTimeout\(guideBoot, \d+\)/.test(app));
    T.ok('a copy already in use gets what changed, not the first-install guide',
      /used \? \{ done: true, seen: '5\.0\.1' \} : \{ done: false, seen: null \}/.test(app));
    T.ok('it waits for any window already open', /if \(state\.setupOpen \|\| state\.getWin\)/.test(app));
    T.ok('a part not on screen is named, never pointed at', /if \(el && !el\.getClientRects\(\)\.length\) el = null;/.test(app));
    const targets = (app.match(/target: '([^']+)'/g) || []).map(t => t.slice(9, -1));
    const ids = targets.map(t => (t.match(/#([\w-]+)/) || [])[1]).filter(Boolean);
    const page = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.html'), 'utf8');
    /* a literal id, or a chart drawn by overTime('x', ...), whose id is "xchart" */
    const exists = id => app.indexOf('id="' + id + '"') >= 0 || page.indexOf('id="' + id + '"') >= 0
      || (/chart$/.test(id) && app.indexOf("overTime('" + id.slice(0, -5) + "'") >= 0
        && app.indexOf("id=\"' + id + 'chart\"") >= 0);
    T.ok('every part it points at exists in the page', ids.every(exists), ids.filter(id => !exists(id)).join(','));
  }

  /* Notifications, and a forecast-only app. */
  {
    const fs15 = require('fs');
    const p15 = (...a) => require('path').join(__dirname, '..', ...a);
    const app = fs15.readFileSync(p15('lib', 'app.js'), 'utf8');
    const Dataset = require('../lib/dataset.js');
    T.ok('a bell sits at the top of every screen, beside the guide',
      /let html = guideButton\(\) \+ noticeBell\(\);/.test(app));
    T.ok('downloads report each change of state there', /noticeJobChanges\(\);/.test(app)
      && /'Complete: ' \+ name/.test(app) && /'Failed: ' \+ name/.test(app));
    T.ok('every import result goes there, receipt folded inside', /noticeForImport\(state\.lastImport\)/.test(app));
    T.ok('the Data screen no longer carries the import receipt card', !/html \+= importReceiptBlock\(\);/.test(app));
    T.ok('nor the download result box', !/esc\(REFRESH_WORDS\[phase\] \|\| phase\) \+ '\.<\/b>'/.test(app));
    T.ok('saved notifications are read without touching anything not yet defined',
      /function loadNotices\(\) \{\s*try \{\s*const raw = JSON\.parse\(localStorage\.getItem\('fba-notices-v1'\)/.test(
        app.replace(/\/\*[\s\S]*?\*\//g, '')));
    T.ok('the download asks Amazon for the forecast only', /reports: FETCHED/.test(app)
      && /const FETCHED = \['fees-preview'\]/.test(app));
    const rd = Dataset.readiness({ forecast: { present: true }, actual: { present: false } });
    T.eq('transaction-history features are optional, not missing',
      rd.filter(r => r.optional).map(r => r.id).join(','), 'actual-expenses,payout-timing');
    T.ok('and are not counted as blocking', !Dataset.blocking(rd).some(r => r.optional));
    T.eq('so the count is out of the features in use', Dataset.counted(rd).length, rd.length - 2);
  }

  /* "Today", and the periods built on it. */
  {
    const fs10 = require('fs');
    const app = fs10.readFileSync(require('path').join(__dirname, '..', 'lib', 'app.js'), 'utf8');
    T.ok('today is this computer’s date, not London’s', /today: localToday\(\)/.test(app)
      && !/today: new Date\(\)\.toISOString\(\)/.test(app));
    T.ok('a saved "Next 8 weeks" is worked out again for today when the app opens',
      /function applyStateDoc[\s\S]*?refreshPresetDates\(\);\s*\}/.test(app));
    T.ok('and again when the date changes with the app open', /setInterval\(checkDateRollover/.test(app));
    T.ok('forecast coverage is counted from tomorrow, like the forecast itself',
      /Preview\.coverage\(scopedPreviews\(\), horizonStart\(\), horizonEnd\(\)\)/.test(app));
    T.ok('one forward horizon everywhere', !/addDays\(state\.today, 55\)/.test(app));
    /* The preset rule itself, run for the example in question. */
    const next8 = /\{ id: 'next-8w'[\s\S]*?of: t => \(\{ from: CSV\.addDays\(t, (\d+)\), to: CSV\.addDays\(t, (\d+)\) \}\)/.exec(app);
    const CSV = require('../lib/csv.js');
    T.eq('on the 24th, "Next 8 weeks" is the 25th to 19 Nov',
      next8 && [CSV.addDays('2026-09-24', +next8[1]), CSV.addDays('2026-09-24', +next8[2])].join(' '),
      '2026-09-25 2026-11-19');
  }

  T.section('Ledger (6.0): the look, light and dark, and a quiet install');
  {
    const fsL = require('fs'), pL = (...a) => require('path').join(__dirname, '..', ...a);
    const main = fsL.readFileSync(pL('desktop', 'main.js'), 'utf8');
    const pre = fsL.readFileSync(pL('desktop', 'app-preload.js'), 'utf8');
    const app = fsL.readFileSync(pL('lib', 'app.js'), 'utf8');
    const html = fsL.readFileSync(pL('app.html'), 'utf8');
    const status = fsL.readFileSync(pL('desktop', 'status.html'), 'utf8');
    T.ok('the page is a standards-mode page, in UTF-8', /^<!doctype html>/i.test(html) && /<meta charset="utf-8">/.test(html));
    T.ok('every colour has a dark twin', /--bg-window:\s+light-dark\(/.test(html)
      && /:root\[data-theme="dark"\]\s*\{ color-scheme: dark; \}/.test(html));
    T.ok('the theme is taken only from the app window, and only a known one',
      /ipcMain\.handle\('shell:theme'[\s\S]{0,120}fromAppWindow\(event\) \|\| !THEMES\.includes\(t\)/.test(main));
    T.ok('the page tells the shell, and sets its own', /theme: t => ipcRenderer\.invoke\('shell:theme'/.test(pre)
      && /window\.desktopShell\.theme\(t\)/.test(app) && /setAttribute\('data-theme', t\)/.test(app));
    T.ok('the theme is applied before the first drawing', /boot\(\) \{\s*applyTheme\(state\.theme\);/.test(app));
    T.ok('the title bar is the page’s, with Windows’ own buttons over it',
      /titleBarStyle: 'hidden', titleBarOverlay: c/.test(main) && /nativeTheme\.on\('updated', paintCaptions\)/.test(main));
    T.ok('the toolbar is where the window is dragged from, and its buttons still click',
      /#top \{[^}]*-webkit-app-region: drag/.test(html) && /#top button[^{]*\{[^}]*-webkit-app-region: no-drag/.test(html));
    T.ok('and it keeps clear of the window buttons', /padding: 8px var\(--cap-r\)/.test(html)
      && /--cap-r: clamp\(16px, calc\(100vw - env\(titlebar-area-x[^;]*, 200px\)/.test(html));
    T.ok('download progress reaches the page', /updates\.percent = /.test(main) && /u\.percent/.test(app));
    T.ok('installing: the page says so, in its own look, before the window goes',
      /state\.installing = u\.readyVersion/.test(app) && /Installing Ledger/.test(app)
      && /setTimeout\(\(\) => autoUpdater\.quitAndInstall\(true, true\), \d+\)/.test(main));
    T.ok('an install that cannot start yet is said, not alerted', /state\.installHeld = r\.detail/.test(app)
      && !/alert\(r\.detail/.test(app));
    T.ok('the loading window is Ledger’s, light and dark', /light-dark\(/.test(status)
      && /<h1>Ledger<\/h1>/.test(status) && /-webkit-app-region: drag/.test(status));
    T.ok('and makes no claim about where the figures are kept', !/stay on this computer/.test(status));
    T.ok('the new guide notes point at things that exist', /version: '6\.0\.0'/.test(app)
      && app.includes('id="appearancecard"'));
  }

  T.report();
})();
