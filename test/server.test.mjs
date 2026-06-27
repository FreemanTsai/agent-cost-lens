// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = path.join(__dirname, '..', 'scripts', 'server.mjs');
const TEST_PORT = 9876;

let serverProcess;
let baseUrl;

before(() => {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, [SERVER_SCRIPT], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: 'pipe',
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('Server did not start in time'));
    }, 5000);

    serverProcess.stdout.on('data', (data) => {
      if (!started && data.toString().includes('Server running')) {
        started = true;
        clearTimeout(timeout);
        baseUrl = `http://127.0.0.1:${TEST_PORT}`;
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('server err:', data.toString());
    });

    serverProcess.on('error', reject);
  });
});

after(() => {
  if (serverProcess) serverProcess.kill();
});

describe('Server', () => {
  it('responds to GET / with 200', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Agent Cost Lens'));
  });

  it('responds to GET /api/reparse with JSON', async () => {
    const res = await fetch(`${baseUrl}/api/reparse`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.success === 'boolean');
    assert.ok(data.message);
  });

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    assert.strictEqual(res.status, 404);
  });

  it('blocks directory traversal', async () => {
    const res = await new Promise((resolve) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: TEST_PORT, path: '/../package.json', method: 'GET' },
        resolve,
      );
      req.end();
    });
    assert.strictEqual(res.statusCode, 403);
  });
});
