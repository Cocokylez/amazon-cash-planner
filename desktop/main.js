/* The desktop shell.
 *
 * It does as little as possible. The helper already knows how to start itself
 * safely - it health-checks before claiming success, and it refuses to stop a
 * process it does not own - so this spawns `launch.py` and reads what it says
 * rather than reimplementing any of that judgement in JavaScript.
 *
 * NOTHING is shown as working until the helper answers its own health check.
 * The window that appears first is a status window, not the app: an app frame
 * drawn over a helper that never started would be a claim that it worked.
 */
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

/* The decisions live next door, with no Electron in them, so the paths that
   matter most - the ones where this program declines to do something - can be
   tested without a window, a display, or a real failure to trigger them. */
const H = require('./helper.js');

const ROOT = () => H.appRoot({
  packaged: app.isPackaged, resourcesPath: process.resourcesPath });
const readConfig = () => H.readConfig(ROOT());
const portState = cfg => H.portState(cfg, 2000, ROOT());


/* ── starting the helper ────────────────────────────────────────────────── */

/* Resolves { ok, url } or { ok: false, message }. The message is the
   launcher's own, because it is the one that knows what went wrong. */
function startHelper(onProgress) {
  return new Promise(resolve => {
    const py = H.pythonPath(ROOT());
    if (!py) {
      resolve({ ok: false, message: H.setupNeeded(ROOT(), 'no-python'),
        action: { label: 'Set up the helper', kind: 'run-setup' } });
      return;
    }

    onProgress('Starting the helper…');

    /* --no-browser, because the window is this program's job. */
    const child = spawn(py, [path.join(ROOT(), 'worker', 'launch.py'),
      '--no-browser'], { cwd: path.join(ROOT(), 'worker'), windowsHide: true });

    let out = '';
    let err = '';
    child.stdout.on('data', d => {
      out += d;
      const line = String(d).trim();
      if (line) onProgress(line.slice(0, 200));
    });
    child.stderr.on('data', d => { err += d; });

    child.on('error', e => resolve({ ok: false, message:
      'The helper could not be started: ' + e.message }));

    child.on('close', () => resolve(H.readLauncherOutput(out, err)));
  });
}

/* ── windows ────────────────────────────────────────────────────────────── */

let statusWindow = null;
let appWindow = null;
let weStartedIt = false;

function createStatusWindow() {
  statusWindow = new BrowserWindow({
    width: 520, height: 320, resizable: false, show: true,
    title: 'Amazon Cash Planner',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  statusWindow.removeMenu();
  statusWindow.on('closed', () => { statusWindow = null; });

  /* Resolves when the page can actually receive. A fixed wait was a guess,
     and when it guessed short the first message vanished - leaving someone
     looking at "Starting..." with no button and nothing happening, while the
     log said it had been told. */
  return new Promise(resolve => {
    statusWindow.webContents.once('did-finish-load', () => resolve(statusWindow));
    statusWindow.loadFile(path.join(__dirname, 'status.html'));
  });
}

/* The last thing said, so a window that loads late can ask for it rather
   than miss it. Belt and braces on purpose: this is the one message some
   people will ever see. */
let lastStatus = { text: 'Starting…', kind: 'working', action: null };
ipcMain.handle('shell:status', () => lastStatus);

function say(text, kind, action) {
  /* Also to stdout. A shell that will not start is exactly when someone needs
     to know why, and a message that exists only inside a window they cannot
     open is no message at all. Nothing secret passes through here - the token
     is never part of a status line. */
  console.log('[shell] ' + String(text));
  lastStatus = { text: String(text), kind: kind || 'working',
    action: action || null };
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('status', lastStatus);
  }
}

function openApp(url) {
  appWindow = new BrowserWindow({
    width: 1400, height: 950, show: false,
    title: 'Amazon Cash Planner',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      /* Three read-only facts, and nothing else. See app-preload.js. */
      preload: path.join(__dirname, 'app-preload.js'),
    },
  });
  appWindow.removeMenu();

  /* This window shows one thing: the local app. A page that tried to send it
     somewhere else would be opened in the person's own browser instead, where
     they can see where they are going. */
  const allowed = new URL(url).origin;
  appWindow.webContents.on('will-navigate', (e, target) => {
    if (new URL(target).origin !== allowed) {
      e.preventDefault();
      shell.openExternal(target);
    }
  });
  appWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  appWindow.loadURL(url);
  appWindow.once('ready-to-show', () => {
    appWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.close();
  });
  appWindow.on('closed', () => { appWindow = null; });
}

/* ── shutting down ──────────────────────────────────────────────────────── */

/* Only a helper THIS program started is stopped. One that was already running
   belongs to whoever started it - closing this window is not permission to
   end their session. */
function stopHelper(cfg) {
  return new Promise(resolve => {
    if (!weStartedIt || !cfg) { resolve(); return; }
    const req = http.request({
      host: '127.0.0.1', port: cfg.port, path: '/api/shutdown',
      method: 'POST', timeout: 4000,
      headers: { 'Content-Type': 'application/json', 'X-Worker-Token': cfg.token },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.on('error', () => resolve());
    req.end('{}');
  });
}

/* ── boot ───────────────────────────────────────────────────────────────── */

/* ── setting the helper up, from inside the app ─────────────────────────── */

let setupRunning = false;

/* install.py, run with whatever Python this computer already has, with its own
   output on screen as it goes.
 *
 * Being handed a path to a .cmd and told to go and run it was the worst moment
 * in this program: it is the first thing a new installation says, it arrives
 * exactly when somebody expected to see their figures, and every reinstall so
 * far ended there. The app knows what is missing and can fix it, so it offers.
 *
 * install.py's own words are used as they are. It already narrates five steps
 * and says what went wrong; paraphrasing would be inventing a version of
 * somebody else's error. */
function runSetup() {
  if (setupRunning) return;

  const py = H.findPython();
  if (!py.found) {
    /* Two different problems, two different answers. Telling someone to
       install Python when they already have it is how they decide the app is
       broken. */
    say(py.detail, 'stopped', { label: 'Open python.org', kind: 'open-python' });
    return;
  }

  setupRunning = true;
  say('Setting up the helper with Python ' + py.version
    + '. This downloads a browser, so give it a few minutes.', 'working');

  const child = spawn(py.exe,
    py.args.concat([path.join(ROOT(), 'worker', 'install.py')]),
    { cwd: path.join(ROOT(), 'worker'), windowsHide: true });

  let tail = '';
  const show = data => {
    tail += data;
    /* The last non-empty line: install.py prints a running commentary, and the
       most recent line is the one describing what is happening now. */
    const lines = String(data).split(/\r?\n/).filter(l => l.trim());
    if (lines.length) say(lines[lines.length - 1].trim().slice(0, 200), 'working');
  };
  child.stdout.on('data', show);
  child.stderr.on('data', show);

  child.on('error', e => {
    setupRunning = false;
    say('Setup could not be started: ' + e.message, 'stopped',
      { label: 'Try again', kind: 'run-setup' });
  });

  child.on('close', code => {
    setupRunning = false;
    if (code === 0) {
      say('Setup finished. Starting the helper…', 'working');
      boot();                    /* straight on - no second launch needed */
      return;
    }
    const said = tail.trim().split(/\r?\n/).filter(l => l.trim()).slice(-6)
      .join('  ').slice(0, 400);
    say('Setup did not finish. ' + (said || 'It gave no reason.'), 'stopped',
      { label: 'Try again', kind: 'run-setup' });
  });
}

ipcMain.handle('shell:run-setup', () => { runSetup(); return true; });
ipcMain.handle('shell:open-python', () => {
  shell.openExternal('https://www.python.org/downloads/');
  return true;
});

/* ── boot ───────────────────────────────────────────────────────────────── */

async function boot() {
  /* Waited for, not guessed at. */
  await createStatusWindow();

  /* BEFORE anything that can fail.
     This used to be the last line of a successful start, which meant a copy
     that could not start never asked for a newer one - and a copy that cannot
     start is exactly the one that most needs the version where that is fixed.
     A broken installation could not update itself out of being broken. */
  checkForUpdates();

  /* Not a file path any more. The app knows what is missing, can fix it, and
     has a window to do it in - so it offers, and waits to be asked. */
  if (H.setupState(ROOT()) !== 'ready') {
    say('The helper is not set up on this computer yet. It runs once, takes a '
      + 'few minutes, and everything stays on this computer.', 'stopped',
      { label: 'Set up the helper', kind: 'run-setup' });
    return;
  }

  const cfg = readConfig();
  if (!cfg) {
    say(H.setupNeeded(ROOT(), 'no-config'), 'stopped',
      { label: 'Set up the helper', kind: 'run-setup' });
    return;
  }

  let before = await portState(cfg);

  if (before === 'stranger') {
    /* Explained, not resolved by force. Somebody else's program is not this
       program's to end. */
    say(H.strangerOnPort(cfg.port), 'stopped');
    return;
  }

  if (before === 'sibling') {
    /* Another copy of THIS app, installed elsewhere. The one being opened now
       is the one somebody wants, so the older one is asked to stand down -
       through its own shutdown endpoint, not by force. */
    say('Another copy of this app is already using port ' + cfg.port
      + '. Asking it to stop so this one can take over…', 'working');
    const stopped = await H.askSiblingToStop(cfg, ROOT());
    if (!stopped) {
      say('Another copy of this app is using port ' + cfg.port + ' and did '
        + 'not stop when asked. Close it yourself, then start this one again. '
        + 'Nothing was forced.', 'stopped');
      return;
    }
    say('The other copy stopped.', 'working');
    before = await portState(cfg);
  }

  weStartedIt = H.shouldStopHelper(before);
  if (!weStartedIt) say('The helper was already running.', 'working');

  const started = await startHelper(line => say(line, 'working'));
  if (!started.ok) { say(started.message, 'stopped', started.action); return; }

  /* Asked again, directly. The launcher says it is healthy; this confirms it
     from here before anything is shown as working. */
  const after = await portState(cfg);
  if (after !== 'ours') {
    say('The helper reported itself healthy, but this program could not reach '
      + 'it afterwards. Nothing was opened. Run DIAGNOSE in the installation '
      + 'folder.', 'stopped');
    return;
  }

  say('Ready.', 'ready');
  openApp(started.base + '/#token=' + encodeURIComponent(cfg.token));
}

/* What the last update check found.

   Kept in one place so the window and the log cannot disagree. 'unknown'
   until something has actually been attempted - not 'up to date', which
   would be a claim made before asking. */
const updates = {
  configured: false,
  state: 'unknown',        // unknown | checking | current | available | failed | off
  detail: '',
  checkedAt: null,
};

function setUpdateState(state, detail) {
  updates.state = state;
  updates.detail = detail || '';
  updates.checkedAt = new Date().toISOString();

  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.webContents.send('update-status', shellInfo());
  }

  /* The status window too. When the app cannot open, that is the only window
     there is - and "an update is downloading" is the single most useful thing
     someone staring at a failure can be told. */
  if (statusWindow && !statusWindow.isDestroyed()
      && (state === 'available' || state === 'checking')) {
    statusWindow.webContents.send('status', {
      text: detail || 'Checking for updates\u2026', kind: 'working' });
  }
}

function shellInfo() {
  return { appVersion: app.getVersion(), updates: Object.assign({}, updates) };
}

ipcMain.handle('shell:info', () => shellInfo());
ipcMain.handle('shell:check-updates', async () => {
  checkForUpdates();
  return shellInfo();
});

/* Wired, and inert until a feed exists.

   NOT VERIFIED END TO END. The mechanism is here and the no-feed path is
   tested, but no update has ever been published for this app, so "it updates
   itself" is not yet a claim anyone should rely on. It becomes one the first
   time a real release is published and an installed copy picks it up. */
function checkForUpdates() {
  const feed = H.updateFeed(ROOT(), process.resourcesPath);
  updates.configured = !!feed;
  if (!feed) {
    console.log('[shell] ' + H.updateStatus(null));
    setUpdateState('off', H.updateStatus(null));
    return;
  }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    const why = H.updateStatus(feed, 'failed',
      'the updater is not installed in this copy');
    console.log('[shell] ' + why);
    setUpdateState('failed', why);
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const report = (state, outcome, detail) => {
    const said = H.updateStatus(feed, outcome, detail);
    console.log('[shell] ' + said);
    setUpdateState(state, said);
  };

  autoUpdater.removeAllListeners();
  autoUpdater.on('update-not-available', () => report('current', 'none'));
  autoUpdater.on('update-available', () => report('available', 'found'));
  autoUpdater.on('download-progress', p => setUpdateState('available',
    'Downloading the update: ' + Math.round(p.percent || 0) + '%'));
  autoUpdater.on('update-downloaded', () => setUpdateState('available',
    'The update is ready. It installs when you close the app.'));
  autoUpdater.on('error',
    e => report('failed', 'failed', e && e.message));

  setUpdateState('checking', 'Checking for updates\u2026');
  try {
    /* A built-in feed is already loaded from app-update.yml. Handing it over
       again would replace what the build was published against with a guess
       made here. */
    if (!feed.builtIn) autoUpdater.setFeedURL(feed);
    autoUpdater.checkForUpdates();
  } catch (e) {
    report('failed', 'failed', e && e.message);
  }
}

app.whenReady().then(boot);

app.on('window-all-closed', async () => {
  await stopHelper(readConfig());
  app.quit();
});

app.on('activate', () => {
  if (!appWindow && !statusWindow) boot();
});
