// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
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

async function refreshAccessToken(auth, authPath) {
  const resp = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: auth.tokens.refresh_token,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    }),
  });
  if (!resp.ok) throw new Error('Token refresh failed');
  const data = await resp.json();
  auth.tokens.access_token = data.access_token;
  if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token;
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
  return data.access_token;
}

function getRecentDailyFiles(publicDir) {
  const dataDir = path.join(publicDir, 'data');
  const files = fs.readdirSync(dataDir)
    .filter(f => f.startsWith('codex-usage-') && f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, 3)
    .map(f => path.join(dataDir, f));
  return files;
}

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

  if (url === '/api/monitor') {
    (async () => {
      try {
        const authPath = path.join(os.homedir(), '.codex', 'auth.json');
        const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
        const token = auth.tokens?.access_token;
        if (!token) throw new Error('No access token');

        let usageRes = await fetch('https://chatgpt.com/backend-api/wham/usage', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (usageRes.status === 401) {
          const newToken = await refreshAccessToken(auth, authPath);
          usageRes = await fetch('https://chatgpt.com/backend-api/wham/usage', {
            headers: { Authorization: `Bearer ${newToken}` },
          });
        }
        const rateLimits = usageRes.ok ? await usageRes.json() : null;

        const sessionFiles = await Promise.all(
          getRecentDailyFiles(publicDir).map(f =>
            fs.promises.readFile(f, 'utf-8').then(JSON.parse).catch(() => null)
          )
        );
        const sessions = sessionFiles
          .filter(Boolean)
          .flatMap(d => d.sessions || [])
          .map(s => {
            const lastTs = (s.turns || []).reduce((max, t) => {
              const ts = t.timestamp || '';
              return ts > max ? ts : max;
            }, '');
            const firstMsg = s.turns?.find(t => t.userMessage)?.userMessage || '';
            const preview = firstMsg.replace(/^\[[^\]]+\]\([^)]+\)\s*/, '').slice(0, 40);
            return { sessionId: s.sessionId, costUsd: s.costUsd, lastTimestamp: lastTs, preview };
          })
          .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp))
          .slice(0, 5);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ rateLimits, sessions, fetchedAt: new Date().toISOString() }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })();
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
