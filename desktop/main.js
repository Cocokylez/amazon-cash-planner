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

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, nativeImage, powerSaveBlocker,
  nativeTheme } = require('electron');
const { spawn } = require('child_process');
const os = require('os');
const http = require('http');
const path = require('path');

/* The decisions live next door, with no Electron in them, so the paths that
   matter most - the ones where this program declines to do something - can be
   tested without a window, a display, or a real failure to trigger them. */
const H = require('./helper.js');
const fs = require('fs');

/* Everything the shell says, kept in a file.
 *
 * stdout goes nowhere for an installed app: an update that quietly did not
 * install looks exactly like one that was never offered, and there was no way
 * to tell them apart afterwards. Nothing secret is written here - the token is
 * never part of a status line. */
function logLine(text) {
  try {
    const dir = H.dataDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'shell.log'),
      new Date().toISOString() + '  ' + text + '\n');
  } catch (e) { /* a log that cannot be written must not stop the app */ }
}

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

    /* --no-browser, because the window is this program's job. Run from the
       data folder: a working folder inside the program folder keeps it open,
       and an update cannot replace a folder something is sitting in. */
    const child = spawn(py, [path.join(ROOT(), 'worker', 'launch.py'),
      '--no-browser'], { cwd: H.dataDir(), windowsHide: true });

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

/* ── appearance ─────────────────────────────────────────────────────────

   Ledger draws its own title bar: the page's toolbar runs to the top of the
   window, and Windows' own minimise, maximise and close are drawn over its
   right-hand end in the page's colours. The choice of System, Light or Dark
   is the page's (Settings); it is kept in a file beside the log as well, so
   the loading window - which opens before the page exists - matches it. */
const THEMES = ['system', 'light', 'dark'];
const themeFile = () => path.join(H.dataDir(), 'theme.json');
function readTheme() {
  try {
    const t = JSON.parse(fs.readFileSync(themeFile(), 'utf8')).theme;
    return THEMES.includes(t) ? t : 'system';
  } catch (e) { return 'system'; }
}
function captionColours() {
  const dark = nativeTheme.shouldUseDarkColors;
  return { color: dark ? '#161618' : '#F5F5F7', symbolColor: dark ? '#F5F5F7' : '#1D1D1F', height: 40 };
}
/* Every window's frame: no title bar of its own, Windows' buttons over the
   page, and the page's background while it loads (no white flash in dark). */
function windowChrome() {
  const c = captionColours();
  return { titleBarStyle: 'hidden', titleBarOverlay: c, backgroundColor: c.color };
}
function paintCaptions() {
  const c = captionColours();
  for (const w of [appWindow, statusWindow]) {
    if (!w || w.isDestroyed()) continue;
    try { w.setTitleBarOverlay(c); } catch (e) { /* no overlay on this platform */ }
    try { w.setBackgroundColor(c.color); } catch (e) { /* cosmetic */ }
  }
}

/* ── running in the background ──────────────────────────────────────────

   The daily download runs at 6 in the morning, so the app can start with
   Windows - quietly, in the tray - and keep running when its window is
   closed. Both are the person's choice (Settings), and a started-by-Windows
   copy shows itself the moment anything needs them. */
const HIDDEN = process.argv.includes('--hidden');
let tray = null;
let quitting = false;
let keepAwake = null;

/* One copy at a time. A second start - the shortcut, while the first runs in
   the tray - brings the first one forward instead of starting another helper. */
const primary = app.requestSingleInstanceLock();
/* Windows shows notifications for an app it can name: the same id the
   installer gives the shortcuts. Without it, "Amazon needs you" at 6 AM could
   quietly never appear. */
if (process.platform === 'win32') app.setAppUserModelId('com.local.amazon-cash-planner');
if (!primary) app.quit();
app.on('second-instance', () => showApp());
app.on('before-quit', () => { quitting = true; });

function startsWithWindows() {
  try { return !!app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; } catch (e) { return false; }
}

function showApp() {
  const w = appWindow || statusWindow;
  if (!w) { if (primary) boot(); return; }
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function ensureTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    tray = new Tray(img.isEmpty() ? img : img.resize({ width: 16, height: 16 }));
  } catch (e) { tray = null; return; }
  tray.setToolTip('Ledger');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Ledger', click: showApp },
    { label: 'Download today\u2019s forecast now',
      click: () => { if (appWindow) appWindow.webContents.send('schedule:run'); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showApp);
}

function createStatusWindow() {
  statusWindow = new BrowserWindow(Object.assign({
    width: 480, height: 340, resizable: false, maximizable: false, show: !HIDDEN,
    title: 'Ledger',
  }, windowChrome(), {
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  }));
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
  logLine(String(text));
  lastStatus = { text: String(text), kind: kind || 'working',
    action: action || null };
  /* Started quietly by Windows, and now something needs the person. */
  if (HIDDEN && kind && kind !== 'working' && statusWindow && !statusWindow.isDestroyed()
      && !statusWindow.isVisible()) statusWindow.show();
  if (statusWindow && !statusWindow.isDestroyed()) {
    statusWindow.webContents.send('status', lastStatus);
  }
}

function openApp(url) {
  appWindow = new BrowserWindow(Object.assign({
    width: 1400, height: 950, minWidth: 720, minHeight: 520, show: false,
    title: 'Ledger',
  }, windowChrome(), {
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      /* Three read-only facts, and nothing else. See app-preload.js. */
      preload: path.join(__dirname, 'app-preload.js'),
      /* The morning download runs while this window is hidden in the tray.
         Chromium otherwise slows a hidden page's timers to once a minute,
         which would stretch a one-hour run into several. */
      backgroundThrottling: false,
    },
  }));
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
    if (!HIDDEN) appWindow.show();
    if (statusWindow && !statusWindow.isDestroyed()) statusWindow.close();
  });
  /* Closing the window keeps the app in the tray while it is set to start
     with Windows - that is what makes the morning download possible. Quit is
     in the tray's menu. */
  appWindow.on('close', e => {
    if (!quitting && startsWithWindows()) {
      e.preventDefault();
      appWindow.hide();
    }
  });
  appWindow.on('closed', () => { appWindow = null; });
  ensureTray();
}

/* ── shutting down ──────────────────────────────────────────────────────── */

/* Only a helper THIS program started is stopped. One that was already running
   belongs to whoever started it - closing this window is not permission to
   end their session. */
function stopHelper(cfg) {
  if (!weStartedIt || !cfg) return Promise.resolve();
  return askToStop(cfg);
}

/* Before an update, the helper stops WHOEVER started it - usually Windows, at
   login, which is exactly why "only if we started it" left it running. It is
   this app's own helper (checked by its answer, not assumed), the update
   replaces the folder it runs from, and an installer that finds it there
   leaves that folder empty. Resolves true only once it has actually gone. */
async function stopHelperForUpdate(cfg) {
  if (!cfg) return true;
  if ((await portState(cfg)) !== 'ours') return true;
  await askToStop(cfg);
  for (let i = 0; i < 40; i++) {
    if ((await portState(cfg)) !== 'ours') return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function askToStop(cfg) {
  return new Promise(resolve => {
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

/* Asked again while the app stays open.
 *
 * The check used to happen once, at launch. Someone who leaves the app open -
 * which is the whole point of it - would never see a release published an
 * hour later, and "I waited" would be met with nothing happening, because
 * nothing was waiting.
 *
 * Six hours: often enough that a day's work picks up a release, rare enough
 * that it is not asking GitHub about a file that changes a few times a week.
 * An update that IS found still installs on quit, so this never interrupts
 * anything. */
const RECHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let recheckTimer = null;

function keepCheckingForUpdates() {
  if (recheckTimer) return;
  recheckTimer = setInterval(() => {
    /* Skipped while setup is running: it is already downloading a browser,
       and two large downloads at once helps nobody. */
    if (!setupRunning) checkForUpdates();
  }, RECHECK_EVERY_MS);
  /* Not a reason to keep the app alive when everything else has finished. */
  if (recheckTimer.unref) recheckTimer.unref();
}

/* ── Ask Claude ─────────────────────────────────────────────────────────── */

/* The key is encrypted for this Windows account by safeStorage and kept in
   the data folder; it never crosses to the page. Only the app window may
   ask, and only while it is showing the local app - a page that navigated
   anywhere else gets nothing. One question at a time: two in flight would
   spend twice for one screen. */
const Claude = require('./claude.js');
let claudeSdk;
const sdk = () => (claudeSdk === undefined ? (claudeSdk = Claude.loadSdk()) : claudeSdk);
let claudeBusy = false;

function claudeStore() {
  const { safeStorage } = require('electron');
  return Claude.keyStore({
    file: path.join(H.dataDir(), 'claude.json'),
    crypto: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: s => safeStorage.encryptString(s),
      decrypt: b => safeStorage.decryptString(b),
    },
  });
}

function fromAppWindow(event) {
  if (!appWindow || appWindow.isDestroyed() || event.sender !== appWindow.webContents) return false;
  try {
    const u = new URL(event.senderFrame ? event.senderFrame.url : event.sender.getURL());
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  } catch (e) { return false; }
}
const refused = { ok: false, code: 'not_allowed', error: 'Only the app window can use Claude.' };

ipcMain.handle('claude:status', event => {
  if (!fromAppWindow(event)) return refused;
  return Claude.status(claudeStore(), sdk());
});
ipcMain.handle('claude:connect', async (event, key) => {
  if (!fromAppWindow(event)) return refused;
  const r = await Claude.connect(claudeStore(), key, sdk());
  logLine('claude: connect ' + (r.ok ? 'ok' : 'refused (' + r.code + ')'));
  return r;
});
ipcMain.handle('claude:forget', event => {
  if (!fromAppWindow(event)) return refused;
  const gone = claudeStore().forget();
  logLine('claude: key removed');
  return Object.assign({ ok: true, forgotten: gone }, Claude.status(claudeStore(), sdk()));
});
ipcMain.handle('claude:ask', async (event, req) => {
  if (!fromAppWindow(event)) return refused;
  if (claudeBusy) return { ok: false, code: 'busy', error: 'Claude is still answering the last question.' };
  claudeBusy = true;
  const id = req && typeof req.id === 'string' ? req.id.slice(0, 40) : '';
  try {
    const r = await Claude.ask(claudeStore(), req, sdk(), text => {
      if (!event.sender.isDestroyed()) event.sender.send('claude:delta', { id, text });
    });
    /* Counts only - never the question, the figures or the answer. */
    logLine('claude: ' + (r.ok ? 'answered' : 'failed (' + r.code + ')')
      + (r.usage ? ' ' + r.usage.input + ' in / ' + r.usage.output + ' out'
        + (r.usage.cacheRead ? ' / ' + r.usage.cacheRead + ' cached' : '') : '')
      + (r.fellBack ? ' / answered by the fallback model' : ''));
    return r;
  } finally {
    claudeBusy = false;
  }
});

ipcMain.handle('shell:run-setup', () => { runSetup(); return true; });
ipcMain.handle('shell:open-releases', () => {
  const pkg = require('../package.json');
  const pub = (pkg.build && pkg.build.publish && pkg.build.publish[0]) || {};
  shell.openExternal('https://github.com/' + pub.owner + '/' + pub.repo + '/releases/latest');
  return true;
});
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

  const missing = H.missingProgramFiles(ROOT());
  if (missing.length) {
    say('This installation is incomplete: an update did not finish, and '
      + missing.join(', ') + ' ' + (missing.length === 1 ? 'is' : 'are') + ' missing. '
      + 'Your data is safe - it is kept separately. Download the installer, close '
      + 'this app, and run it once.', 'stopped',
      { label: 'Download the installer', kind: 'open-releases' });
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

  /* A helper left over from the previous version.

     The app and the helper ship together and are released in lockstep. An
     update replaces the helper's files, but a Python process already running
     keeps the old code in memory - so the app would come back updated, find
     that process healthy, and quietly serve everything from the version it
     just replaced. The About panel could say "Mismatch" for days while every
     fix sat unused on disk.

     Restarting it is the whole fix. It is this app's own helper, asked
     through its own shutdown endpoint, never forced. */
  if (before === 'ours') {
    const running = await H.helperVersion(cfg);
    if (running && running !== app.getVersion()) {
      say('The helper is still running ' + running + ' and this app is '
        + app.getVersion() + '. Restarting it so the update takes effect…',
        'working');
      const stopped = await H.askSiblingToStop(cfg, ROOT());
      if (stopped) {
        before = await portState(cfg);
      } else {
        say('The helper is running ' + running + ' but this app is '
          + app.getVersion() + ', and it did not stop when asked. Close this '
          + 'app completely and open it again. Nothing was forced.',
          'stopped');
        return;
      }
    }
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

  /* From here the app may stay open for days. Keep asking. */
  keepCheckingForUpdates();
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
  ready: false,            // downloaded and waiting to be applied
  readyVersion: '',
  version: '',             // the version being downloaded
  percent: null,           // how much of it has arrived, 0-100
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
  return { appVersion: app.getVersion(), updates: Object.assign({}, updates),
    hostname: os.hostname(), startup: startsWithWindows() };
}

/* Start with Windows (in the tray), asked for by the page's Settings. */
ipcMain.handle('shell:startup', (event, on) => {
  if (typeof on === 'boolean') {
    app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
    logLine('start with Windows: ' + (on ? 'on' : 'off'));
  }
  return startsWithWindows();
});

/* While the daily download runs, the computer is kept from sleeping - only
   the app's own work, never the screen - and released the moment it ends. */
ipcMain.handle('shell:busy', (event, on) => {
  if (on && keepAwake === null) keepAwake = powerSaveBlocker.start('prevent-app-suspension');
  if (!on && keepAwake !== null) { powerSaveBlocker.stop(keepAwake); keepAwake = null; }
  if (tray) tray.setToolTip(on ? 'Ledger \u2014 downloading today\u2019s forecast' : 'Ledger');
  return !!on;
});

ipcMain.handle('shell:show', () => { showApp(); return true; });

/* The page's Appearance setting: applied to the window frame at once, and
   kept for the loading window next time. Only the app window may set it. */
ipcMain.handle('shell:theme', (event, t) => {
  if (!fromAppWindow(event) || !THEMES.includes(t)) return readTheme();
  if (nativeTheme.themeSource !== t) nativeTheme.themeSource = t;
  try {
    fs.mkdirSync(H.dataDir(), { recursive: true });
    fs.writeFileSync(themeFile(), JSON.stringify({ theme: t }));
  } catch (e) { /* this session only */ }
  paintCaptions();
  return t;
});

ipcMain.handle('shell:info', () => shellInfo());
ipcMain.handle('shell:check-updates', async () => {
  checkForUpdates();
  return shellInfo();
});

/* Apply a downloaded update now.
 *
 * The helper is stopped FIRST, and only one this program started: the
 * installer replaces the folder the app runs from, and a process still
 * holding files in it is what produces "cannot be closed" half-installs. */
ipcMain.handle('shell:install-update', async () => {
  if (!updates.ready) return { ok: false, detail: 'No update is downloaded.' };
  /* Not installed over a running helper: that is what emptied its folder.
     If it will not stop, the update waits - nothing is forced. */
  let stopped = false;
  try { stopped = await stopHelperForUpdate(readConfig()); } catch (e) { stopped = false; }
  if (!stopped) {
    logLine('update ' + updates.readyVersion + ' held: the helper did not stop');
    return { ok: false, detail: 'A report is downloading from Amazon right now. The update '
      + 'will install once it has finished - try again in a minute.' };
  }
  logLine('installing update ' + updates.readyVersion);
  const { autoUpdater } = require('electron-updater');
  /* isSilent true, isForceRunAfter true: the page has already said it is
     installing (its own sheet, in its own look), the installer runs without
     a window of its own, and the app opens again by itself. A little later
     than the reply, so the sheet is on screen before the window goes. */
  setTimeout(() => autoUpdater.quitAndInstall(true, true), 900);
  return { ok: true };
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
  autoUpdater.on('update-available', info => {
    updates.version = (info && info.version) || '';
    updates.percent = 0;
    report('available', 'found');
  });
  autoUpdater.on('download-progress', p => {
    updates.percent = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
    setUpdateState('available', 'Downloading ' + (updates.version ? 'Ledger ' + updates.version : 'the update')
      + ': ' + updates.percent + '%');
  });
  autoUpdater.on('update-downloaded', info => {
    updates.ready = true;
    updates.readyVersion = (info && info.version) || '';
    /* Offered, not just announced. Relying on the quit to do it meant an
       update could sit "ready" indefinitely - downloaded, never applied, and
       indistinguishable from one that never arrived. */
    setUpdateState('available',
      'Version ' + (updates.readyVersion || 'the update')
      + ' is downloaded and ready to install.');
  });
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

app.whenReady().then(() => {
  nativeTheme.themeSource = readTheme();
  nativeTheme.on('updated', paintCaptions);
  if (primary) boot();
});

app.on('window-all-closed', async () => {
  const cfg = readConfig();
  if (updates.ready) {
    /* The update installs as the app quits, so the helper must be gone
       first. If it will not stop, the update is kept for next time rather
       than installed over it. */
    let stopped = false;
    try { stopped = await stopHelperForUpdate(cfg); } catch (e) { stopped = false; }
    if (!stopped) {
      try { require('electron-updater').autoUpdater.autoInstallOnAppQuit = false; } catch (e) { /* no updater */ }
      logLine('update ' + updates.readyVersion + ' kept for next time: the helper did not stop');
    }
  } else {
    await stopHelper(cfg);
  }
  app.quit();
});

app.on('activate', () => {
  if (!appWindow && !statusWindow) boot();
});
