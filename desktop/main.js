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

const { app, BrowserWindow, shell } = require('electron');
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
const portState = cfg => H.portState(cfg);


/* ── starting the helper ────────────────────────────────────────────────── */

/* Resolves { ok, url } or { ok: false, message }. The message is the
   launcher's own, because it is the one that knows what went wrong. */
function startHelper(onProgress) {
  return new Promise(resolve => {
    const py = H.pythonPath(ROOT());
    if (!py) {
      resolve({ ok: false, message: H.setupNeeded(ROOT(), 'no-python') });
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
  statusWindow.loadFile(path.join(__dirname, 'status.html'));
  statusWindow.on('closed', () => { statusWindow = null; });
  return statusWindow;
}

function say(text, kind) {
  /* Also to stdout. A shell that will not start is exactly when someone needs
     to know why, and a message that exists only inside a window they cannot
     open is no message at all. Nothing secret passes through here - the token
     is never part of a status line. */
  console.log('[shell] ' + String(text));
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('status', { text: String(text), kind: kind || 'working' });
  }
}

function openApp(url) {
  appWindow = new BrowserWindow({
    width: 1400, height: 950, show: false,
    title: 'Amazon Cash Planner',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
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

async function boot() {
  createStatusWindow();
  /* A moment for the status window to load before anything is sent to it. */
  await new Promise(r => setTimeout(r, 250));

  const cfg = readConfig();
  if (!cfg) {
    say(H.setupNeeded(ROOT(), 'no-config'), 'stopped');
    return;
  }

  const before = await portState(cfg);
  if (before === 'stranger') {
    /* Explained, not resolved by force. */
    say(H.strangerOnPort(cfg.port), 'stopped');
    return;
  }

  weStartedIt = H.shouldStopHelper(before);
  if (!weStartedIt) say('The helper was already running.', 'working');

  const started = await startHelper(line => say(line, 'working'));
  if (!started.ok) { say(started.message, 'stopped'); return; }

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

  /* AFTER the app is open, never before. An update check is not a reason to
     delay someone's own data, and a check that fails must not stop the app. */
  checkForUpdates();
}

/* Wired, and inert until a feed exists.

   NOT VERIFIED END TO END. The mechanism is here and the no-feed path is
   tested, but no update has ever been published for this app, so "it updates
   itself" is not yet a claim anyone should rely on. It becomes one the first
   time a real release is published and an installed copy picks it up. */
function checkForUpdates() {
  const feed = H.updateFeed(ROOT(), process.resourcesPath);
  if (!feed) { console.log('[shell] ' + H.updateStatus(null)); return; }

  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    console.log('[shell] ' + H.updateStatus(feed, 'failed',
      'the updater is not installed in this copy'));
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-not-available',
    () => console.log('[shell] ' + H.updateStatus(feed, 'none')));
  autoUpdater.on('update-available',
    () => console.log('[shell] ' + H.updateStatus(feed, 'found')));
  autoUpdater.on('error',
    e => console.log('[shell] ' + H.updateStatus(feed, 'failed', e && e.message)));

  try {
    /* A built-in feed is already loaded from app-update.yml. Handing it over
       again would replace what the build was published against with a guess
       made here. */
    if (!feed.builtIn) autoUpdater.setFeedURL(feed);
    autoUpdater.checkForUpdates();
  } catch (e) {
    console.log('[shell] ' + H.updateStatus(feed, 'failed', e && e.message));
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
