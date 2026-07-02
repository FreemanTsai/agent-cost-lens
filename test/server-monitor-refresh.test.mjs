// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'server.mjs'), 'utf8');

describe('Monitor data refresh', () => {
  it('refreshes generated session data before serving /api/monitor', () => {
    assert.match(serverSource, /const MONITOR_REPARSE_INTERVAL_MS = parseInt\(process\.env\.MONITOR_REPARSE_INTERVAL_MS, 10\) \|\| 10000;/);
    assert.match(serverSource, /function runDateOnlyReparse\(\)/);
    assert.match(serverSource, /function refreshMonitorDataIfStale\(\)/);
    assert.match(serverSource, /await refreshMonitorDataIfStale\(\);/);
  });

  it('prevents overlapping parser processes from polling clients', () => {
    assert.match(serverSource, /let monitorReparsePromise = null;/);
    assert.match(serverSource, /if \(monitorReparsePromise\) return monitorReparsePromise;/);
  });

  it('counts manual reparses toward the monitor refresh interval', () => {
    assert.match(serverSource, /if \(url === '\/api\/reparse'\) \{[\s\S]*\.then\(\(\{ message, writtenFiles \}\) => \{[\s\S]*lastMonitorReparseAt = Date\.now\(\);[\s\S]*res\.end\(JSON\.stringify\(\{ success: true, message, writtenFiles \}\)\);/);
  });
});
