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
const path = require('path');

/* ── where things are ───────────────────────────────────────────────────── */

function appRoot(opts) {
  const o = opts || {};
  return o.packaged
    ? path.join(o.resourcesPath, 'app')
    : path.join(__dirname, '..');
}

function pythonPath(root) {
  const candidates = process.platform === 'win32'
    ? [path.join(root, 'worker', 'venv', 'Scripts', 'python.exe')]
    : [path.join(root, 'worker', 'venv', 'bin', 'python')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function readConfig(root) {
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(root, 'worker', 'config.json'), 'utf8'));
    if (!cfg.token || !cfg.port) return null;
    return cfg;
  } catch (e) {
    return null;
  }
}

/* ── who holds the port ─────────────────────────────────────────────────── */

/* One of:
     'ours'      the helper for this installation answered
     'stranger'  something else is on the port
     'silent'    nothing answered

   A stranger is NEVER stopped. Killing whatever happens to hold a port is how
   a cash planner ends someone's unrelated work, and no amount of convenience
   is worth that. It is named and explained instead. */
function portState(cfg, timeout) {
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
          resolve(parsed.worker === 'fba-local-worker' ? 'ours' : 'stranger');
        } catch (e) { resolve('stranger'); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve('silent'); });
    req.on('error', () => resolve('silent'));
    req.end();
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
  appRoot, pythonPath, readConfig, portState,
  readLauncherOutput, strangerOnPort, shouldStopHelper, setupNeeded,
  updateFeed, updateStatus,
};
