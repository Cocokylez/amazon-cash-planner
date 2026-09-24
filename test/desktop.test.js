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
    T.ok('and it sits above the header, not inside a panel',
      html.indexOf('id="updatebar"') < html.indexOf('<header id="top"'));
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

  T.report();
})();
