/* Everything the shell decides, with no Electron in it.
 *
 * Kept apart on purpose. The decisions that matter here are the ones about
 * NOT doing things - not stopping a process this program did not start, not
 * opening a window over a helper that never came up, not calling something
 * ready because a launcher printed a line. Those are exactly the paths a
 * person never sees during normal use, so they have to be testable without a
 * window, a display, or a real failure to trigger them.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

/* ── where things are ───────────────────────────────────────────────────── */

function appRoot(opts) {
  const o = opts || {};
  return o.packaged
    ? path.join(o.resourcesPath, 'app')
    : path.join(__dirname, '..');
}

/* Where this computer keeps its own things.
 *
 * MUST agree with worker/paths.py, character for character. They are two
 * languages looking for the same folder, and when they disagreed the result
 * was setup succeeding while the app insisted the helper was not set up:
 * Python wrote the token to the new place, JavaScript looked in the old one,
 * and neither could tell anything was wrong. There is a test that runs both
 * and compares.
 */
function dataDir() {
  const override = process.env.FBA_DATA_DIR;
  if (override) return override;

  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || home, 'Amazon Cash Planner');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support',
      'Amazon Cash Planner');
  }
  return path.join(process.env.XDG_DATA_HOME
    || path.join(home, '.local', 'share'), 'amazon-cash-planner');
}

/* The data folder first, then beside the code.
 *
 * The second is not legacy politeness - an installation part-way through
 * moving, or one whose migration could not finish, still has its environment
 * in the old place, and refusing to look there would break a copy that works
 * perfectly well. */
function candidates(root, ...parts) {
  return [path.join(dataDir(), ...parts),
    path.join(root, 'worker', ...parts)];
}

function pythonPath(root) {
  const rel = process.platform === 'win32'
    ? ['venv', 'Scripts', 'python.exe']
    : ['venv', 'bin', 'python'];
  for (const c of candidates(root, ...rel)) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function readConfig(root) {
  for (const c of candidates(root, 'config.json')) {
    try {
      const cfg = JSON.parse(fs.readFileSync(c, 'utf8'));
      if (cfg.token && cfg.port) return cfg;
    } catch (e) { /* try the next one */ }
  }
  return null;
}

/* ── finding a Python to build the environment with ─────────────────────── */

/* Setup needs an interpreter before there is one of its own, so it has to
   borrow whatever the computer already has. SETUP.cmd has always done this;
   doing it here too is what lets the app offer a button instead of a file
   path.

   Order matters: the launcher `py` understands `-3` and picks the newest,
   which is what someone with several Pythons almost certainly wants. */
const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [['py', ['-3']], ['python', []], ['python3', []]]
  : [['python3', []], ['python', []]];

/* 3.10 is what the helper's code assumes. An older one gets far enough to be
   confusing and then fails somewhere unrelated, so it is refused by name. */
const MIN_PYTHON = [3, 10];

function checkPython(exe, args, runner) {
  const probe = 'import sys; print("%d.%d.%d" % sys.version_info[:3])';
  try {
    const out = runner(exe, args.concat(['-c', probe]));
    const version = String(out || '').trim().split(/\s+/).pop();
    const parts = version.split('.').map(Number);
    if (!parts.length || Number.isNaN(parts[0])) return null;
    const enough = parts[0] > MIN_PYTHON[0]
      || (parts[0] === MIN_PYTHON[0] && parts[1] >= MIN_PYTHON[1]);
    return { exe, args, version, enough };
  } catch (e) {
    return null;
  }
}

/* Returns one of:
     { found: true, exe, args, version }
     { found: false, reason: 'none' }        nothing on this computer
     { found: false, reason: 'old', version } there is one, but too old

   The two failures are kept apart on purpose: "install Python" and "your
   Python is from 2019" need completely different things from a person, and
   telling someone to install what they already have is how they conclude the
   app is broken. */
function findPython(runner) {
  const run = runner || ((exe, args) =>
    require('child_process').execFileSync(exe, args,
      { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }));

  let tooOld = null;
  for (const [exe, args] of PYTHON_CANDIDATES) {
    const got = checkPython(exe, args, run);
    if (!got) continue;
    if (got.enough) {
      return { found: true, exe: got.exe, args: got.args, version: got.version };
    }
    if (!tooOld) tooOld = got;
  }

  if (tooOld) {
    return { found: false, reason: 'old', version: tooOld.version,
      detail: 'Python ' + tooOld.version + ' is installed, but this needs '
        + MIN_PYTHON.join('.') + ' or newer. Installing a current version from '
        + 'python.org and ticking "Add python.exe to PATH" is enough - the old '
        + 'one can stay.' };
  }
  return { found: false, reason: 'none',
    detail: 'Python is not installed on this computer. The helper is a small '
      + 'Python program, so it is needed once. It is free, takes a couple of '
      + 'minutes, and the only thing to watch for is ticking "Add python.exe '
      + 'to PATH" on the first screen.' };
}

/* Is the helper ready to run, or does setup still have to happen? */
function setupState(root) {
  if (pythonPath(root) && readConfig(root)) return 'ready';
  if (pythonPath(root)) return 'no-config';
  return 'no-python';
}

/* ── who holds the port ─────────────────────────────────────────────────── */

/* Which installation this is, as launch.py computes it: the sha256 of the
   worker folder's path, lowercased, first 20 hex characters. Two copies of
   this app installed in different folders have different ids.

   MUST match launch.py's instance_id(). There is a test that runs both. */
function instanceId(root) {
  return require('crypto').createHash('sha256')
    .update(path.join(root, 'worker').toLowerCase())
    .digest('hex').slice(0, 20);
}

/* One of:
     'ours'      this very installation's helper answered
     'sibling'   this app's helper, but from a DIFFERENT installation
     'stranger'  something else entirely is on the port
     'silent'    nothing answered

   The middle one used to be missing, and that is what made "Port belongs to
   another app or installation" a dead end: a second copy of this same app
   was treated exactly like somebody's unrelated web server, so the only way
   forward was to go and find it yourself.

   A sibling can be asked to stand down - politely, through its own shutdown
   endpoint, because every installation on this machine shares one data folder
   and therefore one token. A STRANGER is still never touched: ending
   somebody's unrelated work to save them a click is not a trade this program
   gets to make. */
function portState(cfg, timeout, root) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: cfg.port, path: '/api/health',
      timeout: timeout || 2000,
      headers: { 'X-Worker-Token': cfg.token },
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.worker !== 'fba-local-worker') return resolve('stranger');
          if (!root || !parsed.instance) return resolve('ours');
          resolve(parsed.instance === instanceId(root) ? 'ours' : 'sibling');
        } catch (e) { resolve('stranger'); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('silent'); });
    req.on('error', () => resolve('silent'));
    req.end();
  });
}

/* Ask a sibling to stop, and wait until the port is actually free.
   Resolves true only when it really has gone - a shutdown that returned 200
   and then did not happen would leave the next step failing for a reason
   nobody could see. */
function askSiblingToStop(cfg, root, waitMs) {
  return new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port: cfg.port, path: '/api/shutdown',
      method: 'POST', timeout: 5000,
      headers: { 'Content-Type': 'application/json',
        'X-Worker-Token': cfg.token },
    }, res => { res.resume(); res.on('end', () => resolve(true)); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end('{}');
  }).then(async asked => {
    if (!asked) return false;
    const until = Date.now() + (waitMs || 15000);
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 500));
      const now = await portState(cfg, 1500, root);
      if (now === 'silent' || now === 'ours') return true;
    }
    return false;
  });
}

/* ── reading what the launcher said ─────────────────────────────────────── */

/* launch.py health-checks before it claims anything, and says either
   "Healthy: <url>" or "ERROR: <why>". Its words are used as they are: it is
   the part that knows what went wrong, and a friendlier paraphrase written
   here would be a guess about someone else's failure. */
function readLauncherOutput(stdout, stderr) {
  const out = String(stdout || '');
  const err = String(stderr || '');

  const healthy = /Healthy:\s*(http:\/\/\S+?)\s*(?:\(|$)/m.exec(out);
  if (healthy) return { ok: true, base: healthy[1] };

  const said = /^ERROR:\s*(.+)$/m.exec(out) || /^ERROR:\s*(.+)$/m.exec(err);
  if (said) return { ok: false, message: said[1].trim() };

  return { ok: false, message:
    'The helper did not report itself healthy, and did not say why. Run '
    + 'DIAGNOSE in the installation folder.' };
}

/* ── the words for a port that is not ours ──────────────────────────────── */

function strangerOnPort(port) {
  return 'Port ' + port + ' is being used by another program, and it is not '
    + 'this app’s helper. Nothing was stopped. Close that program '
    + 'yourself, or change the port in worker\\config.json, then start this '
    + 'app again.';
}

/* ── whether to stop the helper on the way out ──────────────────────────── */

/* Only one this program started. A helper that was already running belongs to
   whoever started it, and closing this window is not permission to end their
   session. */
function shouldStopHelper(stateBeforeStart) {
  return stateBeforeStart !== 'ours';
}

/* -- asking someone to run setup ---------------------------------------- */

/* Names the FILE, not "the installation folder". Someone who has just
   installed this does not know where that is, and being told to look for
   something without being told where is how a first run ends in giving up. */
function setupNeeded(root, why) {
  const file = path.join(root, 'worker', 'SETUP.cmd');
  const reason = why === 'no-config'
    ? 'The helper has not been set up on this computer yet, so there is no '
      + 'access token for it.'
    : 'The helper is not set up on this computer yet.';
  return reason + ' Run this file once, then start the app again:  ' + file;
}

/* -- where updates would come from, if anywhere ------------------------- */

/* Two places, and the order matters.

   1. app-update.yml, which electron-builder writes into resources/ whenever
      build.publish is set. autoUpdater reads it by itself, so its PRESENCE is
      the feed and nothing needs to be handed over.

   2. desktop/update-feed.json, written by hand. Used in development, and to
      point one copy somewhere else without rebuilding it.

   The first used to be missing entirely. The lookup went to
   ROOT()/desktop/update-feed.json, and when packaged ROOT() is resources/app
   - which never contains desktop/, because that goes into the asar. So the
   feed could not be found in precisely the builds that need to update
   themselves, and the tests passed anyway because they aimed at a directory
   laid out the development way.

   No feed at all means the shell SAYS so rather than staying quiet. "It
   updates itself" is a promise, and one made against nothing is the kind
   discovered to be false at the worst possible moment. */
function updateFeed(root, resourcesPath) {
  if (resourcesPath) {
    const built = path.join(resourcesPath, 'app-update.yml');
    try {
      if (fs.statSync(built).isFile()) {
        return { builtIn: true, from: built };
      }
    } catch (e) { /* not a published build */ }
  }

  try {
    const raw = fs.readFileSync(
      path.join(root, 'desktop', 'update-feed.json'), 'utf8');
    const feed = JSON.parse(raw);
    if (!feed || typeof feed !== 'object' || !feed.provider) return null;
    return feed;
  } catch (e) {
    return null;
  }
}

function updateStatus(feed, outcome, detail) {
  if (!feed) {
    return 'Automatic updates are not configured, so this copy will not '
      + 'update itself. A build published with a release feed updates on its '
      + 'own; this one was not.';
  }
  if (outcome === 'none') return 'No update available.';
  if (outcome === 'found') return 'An update is downloading; it installs when '
    + 'you close the app.';
  if (outcome === 'failed') {
    /* Non-fatal, and named. An updater that fails silently is worse than one
       that is switched off, because it looks like it is working. */
    return 'The update check failed (' + String(detail || 'no reason given')
      + '). The app is unaffected.';
  }
  return 'Checking for updates…';
}

module.exports = {
  appRoot, dataDir, pythonPath, readConfig, portState,
  instanceId, askSiblingToStop,
  findPython, setupState,
  readLauncherOutput, strangerOnPort, shouldStopHelper, setupNeeded,
  updateFeed, updateStatus,
};
