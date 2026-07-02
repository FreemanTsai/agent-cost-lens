// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monitorHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'monitor.html'), 'utf8');

function loadMonitorScript() {
  const script = monitorHtml.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
  assert.ok(script, 'monitor script should exist');

  const fixedNow = new Date(2026, 6, 2, 20, 42, 0);
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNow.getTime();
    }
  }

  const context = vm.createContext({
    Date: FixedDate,
    Number,
    String,
    Math,
    Array,
    encodeURIComponent,
    fetch: async () => { throw new Error('fetch should not run in render tests'); },
    document: { getElementById: () => ({ innerHTML: '', textContent: '', className: '' }) },
    requestAnimationFrame: () => {},
    setInterval: () => {},
    window: { open: () => {} },
  });

  vm.runInContext(script.replace(/\n\s*init\(\);\s*$/, ''), context);
  return context;
}

describe('Monitor rendering', () => {
  it('uses the local Codex logo asset and a product-style wordmark', () => {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'codex-color.svg')));
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'codex-text.svg')));
    assert.match(monitorHtml, /<img class="logo-mark" src="codex-color\.svg" alt="" \/>/);
    assert.match(monitorHtml, /<img class="wordmark" src="codex-text\.svg" alt="Codex" \/>/);
    assert.match(monitorHtml, /--brand-font:var\(--font\)/);
    assert.match(monitorHtml, /\.wordmark\{width:77px;height:auto;display:block;filter:invert\(1\)/);
  });

  it('keeps content clear of mobile display cutouts', () => {
    assert.match(monitorHtml, /viewport-fit=cover/);
    assert.match(monitorHtml, /padding:calc\(12px \+ env\(safe-area-inset-top\)\) calc\(8px \+ env\(safe-area-inset-right\)\) calc\(12px \+ env\(safe-area-inset-bottom\)\) calc\(8px \+ env\(safe-area-inset-left\)\)/);
    assert.match(monitorHtml, /@media\(orientation:landscape\) and \(max-height:500px\)\{body\{padding:calc\(10px \+ env\(safe-area-inset-top\)\) calc\(2px \+ env\(safe-area-inset-right\)\) calc\(10px \+ env\(safe-area-inset-bottom\)\) calc\(2px \+ env\(safe-area-inset-left\)\)\}\}/);
  });

  it('spaces session cards without showing a live status badge', () => {
    assert.match(monitorHtml, /\.sessions-list\{[^}]*display:flex[^}]*flex-direction:column[^}]*gap:12px/);
    assert.doesNotMatch(monitorHtml, /id="status"/);
    assert.doesNotMatch(monitorHtml, /● Live|○ Offline/);
  });

  it('animates session card reordering', () => {
    assert.match(monitorHtml, /data-session-id="\$\{escapeHtml\(s\.sessionId\)\}"/);
    assert.match(monitorHtml, /function getSessionCardPositions\(\)/);
    assert.match(monitorHtml, /function animateSessionMoves\(oldPositions\)/);
    assert.match(monitorHtml, /const oldSessionPositions = getSessionCardPositions\(\);/);
    assert.match(monitorHtml, /animateSessionMoves\(oldSessionPositions\);/);
    assert.match(monitorHtml, /\.session-card\{[^}]*transition:transform \.36s cubic-bezier\(\.2,\.8,\.2,1\),background \.15s,border-color \.15s/);
    assert.match(monitorHtml, /\.session-card\.session-moving/);
    assert.match(monitorHtml, /prefers-reduced-motion: reduce/);
  });

  it('reparses session data before polling monitor data', () => {
    assert.match(monitorHtml, /await fetch\('\/api\/reparse', \{ cache: 'no-store' \}\);[\s\S]*const res = await fetch\('\/api\/monitor', \{ cache: 'no-store' \}\);/);
  });

  it('shows remaining percent and absolute reset times', () => {
    const { renderUsageCard } = loadMonitorScript();
    const html = renderUsageCard({
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 2,
          reset_after_seconds: 3600,
        },
        secondary_window: {
          used_percent: 75,
          reset_after_seconds: (4 * 24 * 3600) + (5 * 3600),
        },
      },
    });

    assert.match(html, /98% left/);
    assert.match(html, /25% left/);
    assert.match(html, /style="width:98%"/);
    assert.match(html, /style="width:25%"/);
    assert.match(html, /Reset in 1h 0m \(09:42 PM\)/);
    assert.match(html, /Reset in 4d 5h \(Jul 7 01:42 AM\)/);
  });
});
