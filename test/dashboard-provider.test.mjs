// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

describe('Dashboard provider routing', () => {
  it('shows monitor navigation instead of provider switching', () => {
    assert.doesNotMatch(dashboardHtml, /id="providerSelect"/);
    assert.doesNotMatch(dashboardHtml, /switchProvider/);
    assert.match(dashboardHtml, /onclick="window\.location\.href='monitor\.html'"/);
  });

  it('derives data file prefixes from the selected provider', () => {
    assert.match(dashboardHtml, /const PROVIDERS = \{/);
    assert.match(dashboardHtml, /codex:\s*\{[\s\S]*dataPrefix:\s*["']codex["']/);
    assert.match(dashboardHtml, /claude:\s*\{[\s\S]*dataPrefix:\s*["']claude["']/);
    assert.match(dashboardHtml, /function getProviderConfig\(\)/);
    assert.match(dashboardHtml, /providerConfig\.dataPrefix}-usage-\$\{date\}\.json/);
    assert.match(dashboardHtml, /providerConfig\.dataPrefix}-burn/);
    assert.match(dashboardHtml, /providerConfig\.dataPrefix}-optimize/);
  });

  it('uses provider labels for assistant turn copy', () => {
    assert.match(dashboardHtml, /function getAssistantLabel\(\)/);
    assert.match(dashboardHtml, /getTurnAssistantPreview/);
    assert.doesNotMatch(dashboardHtml, /function getTurnCodexPreview/);
    assert.match(dashboardHtml, /\$\{escapeHtml\(getAssistantLabel\(\)\)\}: \$\{escapeHtml\(assistantPreview\)\}/);
    assert.match(dashboardHtml, /\$\{escapeHtml\(getAssistantLabel\(\)\)\} Commentary/);
    assert.match(dashboardHtml, /\$\{escapeHtml\(getAssistantLabel\(\)\)\} Work Process/);
  });
});
