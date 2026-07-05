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
    assert.match(serverSource, /const MONITOR_REPARSE_INTERVAL_MS\s*=\s*parseInt\(process\.env\.MONITOR_REPARSE_INTERVAL_MS,\s*10\)\s*\|\|\s*10000;/);
    assert.match(serverSource, /function runDateOnlyReparse\(provider = ["']codex["']\)/);
    assert.match(serverSource, /function refreshMonitorDataIfStale\(\)/);
    assert.match(serverSource, /await refreshMonitorDataIfStale\(\);/);
  });

  it('prevents overlapping parser processes from polling clients', () => {
    assert.match(serverSource, /let monitorReparsePromise = null;/);
    assert.match(serverSource, /if \(monitorReparsePromise\) return monitorReparsePromise;/);
  });

  it('counts manual reparses toward the monitor refresh interval', () => {
    assert.match(serverSource, /if \(url === ["']\/api\/reparse["']\) \{[\s\S]*\.then\(\(\{ message, writtenFiles \}\) => \{[\s\S]*lastMonitorReparseAt = Date\.now\(\);[\s\S]*res\.end\(\s*JSON\.stringify\(\{ success: true, message, writtenFiles \}\)\s*\);/);
  });

  it('excludes Codex assessment and subagent child sessions from the monitor list', () => {
    assert.match(serverSource, /\.flatMap\(\(?d\)? => d\.sessions \|\| \[\]\)[\s\S]*\.filter\(\(?s\)? => s\.sessionType !== ["']assessment["'] && !s\.parentSessionId\)[\s\S]*\.map\(\(?s\)? => \{/);
  });

  it('serves full Codex session detail by session id', () => {
    assert.match(serverSource, /async function getSessionById\(provider,\s*sessionId\)/);
    assert.match(serverSource, /if \(url === ["']\/api\/session["']\) \{/);
    assert.match(serverSource, /const session = await getSessionById\(["']codex["'],\s*params\.get\(["']id["']\)\);/);
    assert.match(serverSource, /\.find\(\s*\(?s\)? =>[\s\S]*s\.sessionId === sessionId[\s\S]*s\.sessionType !== ["']assessment["'][\s\S]*!s\.parentSessionId[\s\S]*\)/);
    assert.match(serverSource, /res\.end\(JSON\.stringify\(\{ success: true, session \}\)\);/);
  });

  it('serves a separate Claude monitor backed by Claude parser output', () => {
    assert.match(serverSource, /const claudeParserScript = path\.join\(__dirname,\s*["']parse-claude-logs\.mjs["']\);/);
    assert.match(serverSource, /if \(url === ["']\/api\/claude-reparse["']\) \{/);
    assert.match(serverSource, /if \(url === ["']\/api\/claude-monitor["']\) \{/);
    assert.match(serverSource, /getRecentDailyFiles\(publicDir,\s*provider\)/);
    assert.match(serverSource, /getProviderSummary\(["']claude["']\)/);
    assert.match(serverSource, /runDateOnlyReparse\(["']claude["']\)/);
  });

  it('fetches Claude rate limits the same way as claude-code-statusline', () => {
    assert.match(serverSource, /const CLAUDE_USAGE_FILE = path\.join\(\s*os\.homedir\(\),\s*["']\.claude["'],\s*["']usage-exact\.json["'],\s*\);/);
    assert.match(serverSource, /const CLAUDE_CREDENTIALS_FILE = path\.join\(\s*os\.homedir\(\),\s*["']\.claude["'],\s*["']\.credentials\.json["'],\s*\);/);
    assert.match(serverSource, /claudeAiOauth\s*\?\.\s*accessToken/);
    assert.match(serverSource, /https:\/\/api\.anthropic\.com\/api\/oauth\/usage/);
    assert.match(serverSource, /["']anthropic-beta["']:\s*["']oauth-2025-04-20["']/);
    assert.match(serverSource, /getClaudeRateLimits\(\)/);
    assert.match(serverSource, /success: true,[\s\S]*rateLimits,[\s\S]*summary,[\s\S]*sessions,[\s\S]*fetchedAt: new Date\(\)\.toISOString\(\),/);
  });
});
