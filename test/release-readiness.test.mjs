// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

describe('release readiness', () => {
  it('does not ship placeholder repository URLs', () => {
    for (const file of ['package.json', 'README.md', 'README_zh.md']) {
      assert.ok(!read(file).includes('YOUR_USER'), `${file} still contains YOUR_USER`);
    }
  });

  it('documents the generated data path used by the dashboard', () => {
    assert.ok(read('README.md').includes('public/data/codex-optimize.json'));
    assert.ok(read('README_zh.md').includes('public/data/codex-optimize.json'));
  });

  it('does not contain maintainer-local absolute paths in shipped source', () => {
    for (const file of ['scripts/parse-codex-logs.mjs', 'README.md', 'README_zh.md', 'package.json']) {
      assert.ok(!read(file).includes('/Users/FreemanTsai'), `${file} contains a maintainer-local path`);
    }
  });

  it('binds the local server to loopback by default', () => {
    const source = read('scripts/server.mjs');
    assert.match(source, /HOST\s*=\s*process\.env\.HOST\s*\|\|\s*["']127\.0\.0\.1["']/);
    assert.match(source, /\.listen\(PORT,\s*HOST,/);
  });
});
