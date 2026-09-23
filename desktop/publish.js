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

/* The release first, so the assets have somewhere to go. */
try {
  gh('release', 'view', TAG, '--repo', REPO);
  console.log('  release ' + TAG + ' already exists; reusing it');
} catch (e) {
  gh('release', 'create', TAG, '--repo', REPO, '--title', pkg.version,
    '--notes', 'Amazon Cash Planner ' + pkg.version);
  console.log('  created release ' + TAG);
}

for (const f of [asset, built + '.blockmap']) {
  const full = path.join(OUT, f);
  if (!fs.existsSync(full)) continue;
  const named = f.replace(/ /g, '-');
  if (named !== f) fs.copyFileSync(full, path.join(OUT, named));
  gh('release', 'upload', TAG, path.join(OUT, named), '--repo', REPO, '--clobber');
  console.log('  uploaded ' + named);
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
gh('release', 'upload', TAG, path.join(OUT, 'latest.yml'), '--repo', REPO, '--clobber');
console.log('  uploaded latest.yml');

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
