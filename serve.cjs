const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname);
const port = Number(process.env.PORT) || 4173;
const types = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.ico', 'image/x-icon'],
]);

http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch { response.writeHead(400).end('Bad request'); return; }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(target, (error, stat) => {
    if (error || !stat.isFile()) { response.writeHead(404).end('Not found'); return; }
    response.writeHead(200, {
      'Content-Type': types.get(path.extname(target)) || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
    });
    fs.createReadStream(target).pipe(response);
  });
}).listen(port, '127.0.0.1', () => console.log(`Gamepad Lab at http://127.0.0.1:${port}`));
