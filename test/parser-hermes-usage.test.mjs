// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const parserScript = path.join(rootDir, 'scripts', 'parse-hermes-usage.mjs');

// hermes state.db 語意：input_tokens 是 uncached（新增）token，
// cache_read_tokens 是獨立計數且可能大於 input_tokens。
describe('Hermes parser token accounting', () => {
  it('silently skips when the Hermes database is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');

    const result = spawnSync(
      process.execPath,
      [parserScript, '--date=2099-12-31', '--date-only'],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
        },
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });

  it('does not clamp cache_read_tokens to input_tokens', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const dbDir = path.join(home, '.hermes');
    const dbPath = path.join(dbDir, 'state.db');

    fs.mkdirSync(dbDir, { recursive: true });

    const inputTokens = 572517;
    const cacheReadTokens = 4372112;
    const outputTokens = 21272;
    const createdAt = Math.floor(
      new Date(2020, 0, 1, 12, 0, 0).getTime() / 1000,
    );

    execFileSync(
      'sqlite3',
      [
        dbPath,
        `
        CREATE TABLE sessions (
          id TEXT,
          model TEXT,
          input_tokens INTEGER,
          cache_read_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_tokens INTEGER,
          created_at INTEGER
        );
        INSERT INTO sessions VALUES (
          'test_session_1',
          'nvidia/nemotron-3-ultra-550b-a55b',
          ${inputTokens},
          ${cacheReadTokens},
          ${outputTokens},
          0,
          ${createdAt}
        );
        `,
      ],
      { stdio: 'pipe' },
    );

    execFileSync(
      process.execPath,
      [
        parserScript,
        '--date=2020-01-01',
        '--date-only',
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
        },
        stdio: 'pipe',
      },
    );

    const report = JSON.parse(
      fs.readFileSync(
        path.join(rootDir, 'public', 'data', 'hermes-usage-2020-01-01.json'),
        'utf8',
      ),
    );
    fs.rmSync(
      path.join(rootDir, 'public', 'data', 'hermes-usage-2020-01-01.json'),
      { force: true },
    );

    assert.equal(report.totals.inputTokens, inputTokens);
    assert.equal(
      report.totals.cachedInputTokens,
      cacheReadTokens,
      'cachedInputTokens must equal cache_read_tokens, not be clamped to input',
    );
    assert.equal(report.totals.effectiveInputTokens, inputTokens);
    assert.equal(report.totals.outputTokens, outputTokens);
    assert.equal(
      report.totals.totalTokens,
      inputTokens + cacheReadTokens + outputTokens,
    );
    assert.ok(
      Math.abs(
        report.totals.cacheRatio -
          cacheReadTokens / (inputTokens + cacheReadTokens),
      ) < 1e-9,
    );
  });
});
