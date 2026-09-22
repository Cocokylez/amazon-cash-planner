/* Wraps app.html the way the Artifact platform wraps it, so the same file can be
   opened locally before publishing. The engine modules are inlined here ONLY for
   the local preview — the published artifact ships them as supporting files.
   Output is gitignored. */
const fs = require('fs'), path = require('path');

const MODULES = [
  'money', 'provenance', 'csv', 'taxonomy', 'ledger',
  'preview', 'cash', 'forecast', 'profit', 'recon', 'dataset', 'store', 'sync', 'schema', 'worker', 'selftest', 'installer-payload', 'icons',
  'charts', 'app',
];

let body = fs.readFileSync(path.join(__dirname, 'app.html'), 'utf8');

for (const m of MODULES) {
  const tag = '<script src="lib/' + m + '.js"></script>';
  if (!body.includes(tag)) throw new Error('missing script tag for lib/' + m + '.js in app.html');
  const src = fs.readFileSync(path.join(__dirname, 'lib', m + '.js'), 'utf8');
  /* Function replacement, not a string: a literal $' or $& inside the module
     source would otherwise be read as a replacement pattern and splice the rest
     of the document back into the script. */
  body = body.replace(tag, () => '<script>' + src + '<' + '/script>');
}

const html = '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">'
  + '<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui,sans-serif}'
  + 'img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
  + body + '</body></html>';

fs.writeFileSync(path.join(__dirname, 'preview.html'), html);
console.log('wrote preview.html (' + html.length + ' bytes, '
  + MODULES.length + ' modules inlined for local viewing)');
