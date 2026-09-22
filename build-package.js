/* Builds the downloadable setup package.
 *
 * Deliberately a plain zip written by hand: no build tooling to install, and
 * the exact byte layout is visible here rather than hidden in a dependency.
 * Stored (uncompressed) entries keep it simple and verifiable; the payload is
 * a few hundred KB of text.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'amazon-cash-planner-setup.zip');
const TOP = 'amazon-cash-planner';

/* What ships. Anything not listed stays behind — notably worker/profile
   (an Amazon session), worker/config.json (a token), worker/downloads and
   worker/venv (this machine's paths). */
const FILES = [
  'START-HERE.txt',
  'app.html',
  'server.js',
  'gen-preview.js',
  'worker/SETUP.cmd',
  'worker/UPDATE.cmd',
  'worker/DIAGNOSE.cmd',
  'worker/diagnose.py',
  'worker/test_matching.py',
  'UPDATING.txt',
  'worker/install.py',
  'worker/launch.py',
  'worker/open-app.cmd',
  'worker/start-helper.cmd',
  'worker/make_shortcut.py',
  'worker/worker.py',
  'worker/seller_central.py',
  'worker/setup_flow.py',
  'worker/chrome_profiles.py',
  'worker/discover.py',
  'worker/requirements.txt',
  'worker/INSTALL.txt',
  'worker/README.md',
];

for (const f of fs.readdirSync(path.join(ROOT, 'lib'))) {
  /* Not installer-payload.js: it is a copy of this very zip, so packaging it
     would double the download every build. The local app does not need it —
     the setup files are already right there beside it. */
  if (f.endsWith('.js') && f !== 'installer-payload.js') FILES.push('lib/' + f);
}
// Tests and historical handoff notes contain controls derived from private
// source exports. Keep them local; they are not application runtime files.

/* ── zip writing ──────────────────────────────────────────────────────── */

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return buf => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function dosTime(d) {
  return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
}
function dosDate(d) {
  return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
}

const now = new Date();
const locals = [];
const centrals = [];
let offset = 0;

for (const rel of FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    throw new Error('Required package file missing: ' + rel);
  }
  let raw = fs.readFileSync(src);
  /* Windows batch files need CRLF: with LF-only endings `goto` and labels
     misbehave, and a setup script that fails on a label is the worst possible
     first impression. Plain-text instructions get CRLF too, so Notepad does
     not show them as one long line. */
  if (rel.endsWith('.cmd') || rel.endsWith('.bat') || rel.endsWith('.txt')) {
    const text = raw.toString('utf8')
      .split('\r\n').join('\n')
      .split('\n').join('\r\n');
    raw = Buffer.from(text, 'utf8');
  }
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;

  const name = Buffer.from(TOP + '/' + rel, 'utf8');
  const crc = CRC(raw);

  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6);            // UTF-8 names
  lh.writeUInt16LE(method, 8);
  lh.writeUInt16LE(dosTime(now), 10);
  lh.writeUInt16LE(dosDate(now), 12);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(data.length, 18);
  lh.writeUInt32LE(raw.length, 22);
  lh.writeUInt16LE(name.length, 26);
  lh.writeUInt16LE(0, 28);

  locals.push(lh, name, data);

  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(dosTime(now), 12);
  ch.writeUInt16LE(dosDate(now), 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(data.length, 20);
  ch.writeUInt32LE(raw.length, 24);
  ch.writeUInt16LE(name.length, 28);
  ch.writeUInt16LE(0, 30);
  ch.writeUInt16LE(0, 32);
  ch.writeUInt16LE(0, 34);
  ch.writeUInt16LE(0, 36);
  ch.writeUInt32LE(0, 38);
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, name);

  offset += lh.length + name.length + data.length;
}

const centralBuf = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(centrals.length / 2, 8);
end.writeUInt16LE(centrals.length / 2, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.writeFileSync(OUT, Buffer.concat([...locals, centralBuf, end]));

/* Embed the finished zip for the published app: the artifact platform will
   not serve a .zip, and page code there cannot start a download, so the
   bytes travel as base64 and the page hands them over via the downloads
   capability. */
const zipBytes = fs.readFileSync(OUT);
const payloadLines = [
  '/* The setup package, embedded. Regenerated by build-package.js;',
  ' * do not edit by hand. A published artifact cannot serve a .zip, so',
  ' * the bytes ride along as base64 and are handed to the viewer at',
  ' * download time through the downloads capability. */',
  '(function (root) {',
  '  root.InstallerZip = {',
  "    name: '" + path.basename(OUT) + "',",
  '    bytes: ' + zipBytes.length + ',',
  "    b64: '" + zipBytes.toString('base64') + "',",
  '  };',
  "})(typeof self !== 'undefined' ? self : globalThis);",
  '',
];
const payload = payloadLines.join('\n');
fs.writeFileSync(path.join(ROOT, 'lib', 'installer-payload.js'), payload);
console.log('wrote lib/installer-payload.js  ('
  + (payload.length / 1024).toFixed(0) + ' KB)');

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log('wrote ' + path.basename(OUT) + '  (' + kb + ' KB, '
  + centrals.length / 2 + ' files)');
