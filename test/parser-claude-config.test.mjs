// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');
const parserScript = path.join(rootDir, 'scripts', 'parse-claude-logs.mjs');

describe('Claude parser cost accounting', () => {
  it('prices base input, cache reads, cache writes, and output separately', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const projectDir = path.join(home, '.claude', 'projects', '-tmp-workspace');
    const sessionFile = path.join(projectDir, '2026-06-23-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(sessionFile, [
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'user',
        message: {
          role: 'user',
          content: 'check claude cost',
        },
      },
      {
        timestamp: '2026-06-23T00:00:02.000Z',
        type: 'assistant',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'done' }],
          usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 3000,
            output_tokens: 400,
          },
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'));

    execFileSync(process.execPath, [parserScript, '--date=2026-06-23', '--date-only'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      stdio: 'pipe',
    });

    const usage = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'claude-usage-2026-06-23.json'), 'utf8'));
    const session = usage.sessions[0];
    const turn = session.turns[0];
    const step = turn.steps[0];

    assert.equal(usage.totals.inputTokens, 1000);
    assert.equal(usage.totals.cachedInputTokens, 2000);
    assert.equal(usage.totals.cacheCreationInputTokens, 3000);
    assert.equal(usage.totals.totalTokens, 6400);

    assert.equal(session.cacheCreationInputTokens, 3000);
    assert.equal(turn.cacheCreationInputTokens, 3000);
    assert.equal(step.cacheCreationInputTokens, 3000);
    assert.equal(step.totalTokens, 6400);

    assert.equal(Number(session.costUsd.toFixed(6)), 0.02085);
  });
}
);
