// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function runParserWithoutDataDir(script) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-fresh-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-home-'));
  fs.mkdirSync(path.join(cwd, 'public'), { recursive: true });

  const result = spawnSync(process.execPath, [path.join(rootDir, 'scripts', script), '--fill=30'], {
    cwd,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  });

  return { cwd, result };
}

describe('fresh clone parser startup', () => {
  for (const script of ['parse-codex-logs.mjs', 'parse-claude-logs.mjs']) {
    it(`${script} creates public/data before writing reports`, () => {
      const { cwd, result } = runParserWithoutDataDir(script);

      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.ok(fs.existsSync(path.join(cwd, 'public', 'data')));
    });
  }
});
