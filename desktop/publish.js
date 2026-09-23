/* Publish a release, the way that actually works.
 *
 * electron-builder's own uploader failed on the 112 MB installer while the
 * 119 KB blockmap went up fine, and `gh` uploaded the identical file first
 * try. Until that is understood, the build is made here and the upload is
 * done by gh - which also means latest.yml has to be written here, because
 * electron-builder only writes it as part of the publish it did not finish.
 *
 * latest.yml is the whole point. Without it a release is a download link and
 * nothing installed can discover that a newer version exists. Its sha512 is
 * base64, and electron-updater REFUSES an update whose hash does not match -
 * so it is computed from the file, and then checked against the copy actually
 * sitting on the release rather than the one on this disk.
 */
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GH = 'C:\\Program Files\\GitHub CLI\\gh.exe';
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-desktop');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const REPO = pkg.build.publish[0].owner + '/' + pkg.build.publish[0].repo;
const TAG = 'v' + pkg.version;

const gh = (...args) =>
  execFileSync(GH, args, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();

function sha512Base64(file) {
  const h = crypto.createHash('sha512');
  h.update(fs.readFileSync(file));
  return h.digest('base64');
}

/* GitHub replaces spaces in asset names with dashes, and latest.yml has to
   name the asset exactly as it is served. */
/* readdirSync on a folder that is not there throws before the check below
   ever runs, turning "you forgot to build" into a stack trace about scandir.
   The advice was already written; it just needed to be reachable. */
const built = (fs.existsSync(OUT) ? fs.readdirSync(OUT) : [])
  .find(f => f.startsWith('Amazon Cash Planner Setup ') && f.endsWith('.exe'));
if (!built) {
  console.error('\n  No installer in dist-desktop. Run the build first.\n');
  process.exit(1);
}
const asset = built.replace(/ /g, '-');
fs.copyFileSync(path.join(OUT, built), path.join(OUT, asset));

const size = fs.statSync(path.join(OUT, asset)).size;
const digest = sha512Base64(path.join(OUT, asset));

console.log('  ' + asset + '  ' + size + ' bytes');

/* Everything that must go up, confirmed present BEFORE a release exists.
   An empty release is not a harmless half-finished job: GitHub makes it the
   latest one, every installed copy then asks it for latest.yml, and the
   answer is 404. The app stops being able to update at all - which is the
   one failure that cannot be fixed by shipping a fix. */
const wanted = [asset, built + '.blockmap'].filter(f =>
  fs.existsSync(path.join(OUT, f)));
if (!wanted.includes(asset)) {
  console.error('\n  ' + asset + ' is missing from dist-desktop. Nothing was '
    + 'published.\n  (Two builds sharing this folder will do that: one\'s '
    + 'rm -rf lands in the middle of the other\'s upload.)\n');
  process.exit(1);
}

/* The release, and whether THIS run is what created it - because only then
   is it ours to remove when something later fails. */
let createdHere = false;
try {
  gh('release', 'view', TAG, '--repo', REPO);
  console.log('  release ' + TAG + ' already exists; reusing it');
} catch (e) {
  gh('release', 'create', TAG, '--repo', REPO, '--title', pkg.version,
    '--notes', 'Amazon Cash Planner ' + pkg.version);
  createdHere = true;
  console.log('  created release ' + TAG);
}

/* From here on a failure must not leave a release standing. */
function abandon(why) {
  console.error('\n  ' + why);
  if (createdHere) {
    try {
      gh('release', 'delete', TAG, '--repo', REPO, '--yes', '--cleanup-tag');
      console.error('  removed the empty release ' + TAG
        + ' so it cannot become the latest one.');
    } catch (e2) {
      console.error('  COULD NOT remove ' + TAG + ': ' + e2.message
        + '\n  Delete it by hand - while it exists and is empty, no '
        + 'installed copy can update.');
    }
  } else {
    console.error('  ' + TAG + ' already existed, so it was left alone. '
      + 'Check its assets by hand.');
  }
  process.exit(1);
}

try {
  for (const f of wanted) {
    const named = f.replace(/ /g, '-');
    if (named !== f) fs.copyFileSync(path.join(OUT, f), path.join(OUT, named));
    gh('release', 'upload', TAG, path.join(OUT, named), '--repo', REPO,
      '--clobber');
    console.log('  uploaded ' + named);
  }
} catch (e) {
  abandon('Uploading the installer failed: ' + e.message);
}

const when = JSON.parse(gh('release', 'view', TAG, '--repo', REPO,
  '--json', 'publishedAt,createdAt'));

const latest = [
  'version: ' + pkg.version,
  'files:',
  '  - url: ' + asset,
  '    sha512: ' + digest,
  '    size: ' + size,
  'path: ' + asset,
  'sha512: ' + digest,
  "releaseDate: '" + (when.publishedAt || when.createdAt) + "'",
  '',
].join('\n');

fs.writeFileSync(path.join(OUT, 'latest.yml'), latest);
try {
  gh('release', 'upload', TAG, path.join(OUT, 'latest.yml'), '--repo', REPO,
    '--clobber');
} catch (e) {
  abandon('Uploading latest.yml failed: ' + e.message);
}
console.log('  uploaded latest.yml');

/* Asked of GitHub, not assumed from the fact that no call threw. A release
   without latest.yml is the exact shape that breaks every updater, so it is
   worth one more request to be certain it is not what we just made. */
{
  const names = JSON.parse(gh('release', 'view', TAG, '--repo', REPO,
    '--json', 'assets')).assets.map(a => a.name);
  for (const need of ['latest.yml', asset]) {
    if (!names.includes(need)) {
      abandon('The release is missing ' + need + ' after uploading it. '
        + 'GitHub lists: ' + (names.join(', ') || '(nothing)'));
    }
  }
  console.log('  release carries: ' + names.join(', '));
}

/* Checked against what GitHub serves, not what is on this disk. A wrong hash
   here would show up as an update that fails for reasons nobody could guess. */
const url = 'https://github.com/' + REPO + '/releases/download/' + TAG + '/' + asset;

/* Downloaded OUTSIDE the build folder. It used to land in dist-desktop, and
   a copy left behind - or still held by the download - made the NEXT build
   fail on "cannot remove: Device or resource busy". A verification step must
   not be able to break the thing it verifies. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-verify-'));
const tmp = path.join(scratch, 'downloaded.bin');
let served;
try {
  execFileSync('curl', ['-sL', '-o', tmp, url], { maxBuffer: 1 << 26 });
  served = sha512Base64(tmp);
} finally {
  /* Always, even when the download or the hash threw. */
  fs.rmSync(scratch, { recursive: true, force: true });
}

if (served !== digest) {
  console.error('\n  The asset on the release does NOT match latest.yml.'
    + '\n  Every update would refuse to install. Fix before telling anyone'
    + '\n  this is published.\n');
  process.exit(1);
}

console.log('\n  verified: the file GitHub serves matches latest.yml');
console.log('  https://github.com/' + REPO + '/releases/tag/' + TAG + '\n');
