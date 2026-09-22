// Minimal static server for local dev. No dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = 5178;
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.csv':'text/csv', '.json':'application/json' };

http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400).end('bad request'); return; }
  const allowed = ['/', '/preview.html', '/app.html'].includes(url) || /^\/lib\/[a-z0-9-]+\.js$/.test(url);
  if (!allowed) { res.writeHead(404).end('not found'); return; }
  const file = path.join(ROOT, url === '/' ? 'preview.html' : url);
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, {'Content-Type':'text/plain'}).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`serving local preview on http://127.0.0.1:${PORT}; Amazon helper requires worker/open-app.cmd`));
