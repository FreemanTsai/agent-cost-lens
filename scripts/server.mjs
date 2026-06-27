// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = 'public';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const publicDir = path.join(rootDir, PUBLIC);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  let url = req.url.split('?')[0];

  if (url === '/api/reparse') {
    const script = path.join(__dirname, 'parse-codex-logs.mjs');
    execFile(process.execPath, [script, '--date-only'], { cwd: rootDir }, (err, stdout, stderr) => {
      res.writeHead(err ? 500 : 200, { 'Content-Type': 'application/json; charset=utf-8' });
      if (err) {
        res.end(JSON.stringify({ success: false, error: stderr || err.message }));
      } else {
        const lines = stdout.trim().split('\n');
        const writtenFiles = lines.filter(l => l.startsWith('- ')).map(l => l.replace(/^- /, ''));
        res.end(JSON.stringify({ success: true, message: stdout.trim(), writtenFiles }));
      }
    });
    return;
  }

  if (url === '/') url = '/index.html';
  const file = path.join(publicDir, url);
  if (!file.startsWith(publicDir)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const ext = path.extname(file);
  try {
    const content = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}).listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
