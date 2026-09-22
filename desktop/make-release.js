/* Assembles what a person actually receives.
 *
 * electron-builder produces an installer. It does not produce the two things
 * that have to sit BESIDE the installer: the helper setup, and instructions.
 * Those cannot live inside the thing they explain how to install.
 *
 * Run after `npm run desktop:build`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BUILT = path.join(ROOT, 'dist-desktop');
const EXTRAS = path.join(__dirname, 'dist-extras');
const OUT = path.join(BUILT, 'Amazon Cash Planner');

function fail(message) {
  console.error('\n  ' + message + '\n');
  process.exit(1);
}

if (!fs.existsSync(BUILT)) {
  fail('There is no dist-desktop yet. Run: npm run desktop:build');
}

const installer = fs.readdirSync(BUILT)
  .filter(f => /^Amazon Cash Planner Setup .*\.exe$/.test(f))
  .sort()
  .pop();

if (!installer) {
  fail('No installer in dist-desktop. Run: npm run desktop:build');
}

/* -- is the packaged app complete? ------------------------------------- */

/* Named one by one, because "everything under worker/" is what the filter
   was supposed to guarantee and did not. Each of these is something the
   installed app reaches for and cannot invent. */
const REQUIRED = [
  'worker/requirements.txt',   // install.py pip-installs from it
  'worker/install.py',
  'worker/launch.py',
  'worker/worker.py',
  'worker/archive.py',
  'worker/sku_economics.py',
  'worker/seller_central.py',
  'worker/SETUP.cmd',
  'worker/DIAGNOSE.cmd',
  'worker/open-app.cmd',
  'app.html',
  'lib/app.js',
  'lib/money.js',
  'lib/store.js',
  'lib/worker.js',
];

const packaged = path.join(BUILT, 'win-unpacked', 'resources', 'app');
if (fs.existsSync(packaged)) {
  const missing = REQUIRED.filter(
    f => !fs.existsSync(path.join(packaged, f.split('/').join(path.sep))));
  if (missing.length) {
    fail('The packaged app is missing ' + missing.join(', ')
      + '.\n  Whoever installed it would hit that as a failure with no useful '
      + 'cause.\n  Nothing was assembled.');
  }
}

/* And the reverse: nothing personal rode along into the installed tree. */
const NEVER = ['worker/config.json', 'worker/jobs.json', 'worker/reports.db',
  'worker/settings.json', 'worker/dataset.json', 'worker/profile',
  'worker/downloads', 'worker/logs'];
if (fs.existsSync(packaged)) {
  const leaked = NEVER.filter(
    f => fs.existsSync(path.join(packaged, f.split('/').join(path.sep))));
  if (leaked.length) {
    fail('The packaged app contains ' + leaked.join(', ')
      + ' - that is this computer\'s data and must not be handed to anyone.'
      + '\n  Nothing was assembled.');
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* The installer keeps its own name. It is what latest.yml will reference once
   updates are published, and renaming it for tidiness would quietly break
   that later. */
const carried = [];
for (const f of [installer, installer + '.blockmap']) {
  const from = path.join(BUILT, f);
  if (!fs.existsSync(from)) continue;
  fs.copyFileSync(from, path.join(OUT, f));
  carried.push(f);
}

for (const f of fs.readdirSync(EXTRAS)) {
  fs.copyFileSync(path.join(EXTRAS, f), path.join(OUT, f));
  carried.push(f);
}

/* Said out loud, because a release folder that quietly contained someone's
   token or reports would be the worst possible thing to hand around. */
const forbidden = ['config.json', 'jobs.json', 'reports.db',
  'settings.json', 'dataset.json'];
const found = fs.readdirSync(OUT).filter(f => forbidden.includes(f));
if (found.length) fail('Release folder contains ' + found.join(', ')
  + ' - that must never be handed to anyone. Nothing was published.');

const size = fs.readdirSync(OUT)
  .reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);

console.log('\n  ' + OUT);
for (const f of carried.sort()) {
  const bytes = fs.statSync(path.join(OUT, f)).size;
  console.log('    ' + String(Math.round(bytes / 1024) + ' KB').padStart(10)
    + '  ' + f);
}
console.log('\n  ' + (size / (1024 * 1024)).toFixed(0) + ' MB in total.');
console.log('  Two clicks: the installer, then "Set up the helper.cmd".\n');
