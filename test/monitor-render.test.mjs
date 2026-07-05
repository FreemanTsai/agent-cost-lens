// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const monitorHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'monitor.html'), 'utf8');

function loadMonitorScript(html = monitorHtml) {
  const script = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)?.[1];
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
    document: {
      getElementById: () => ({ innerHTML: '', textContent: '', className: '' }),
      querySelectorAll: () => [],
    },
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
    assert.match(monitorHtml, /--brand-font:\s*var\(--font\)/);
    assert.match(monitorHtml, /\.wordmark\s*\{[^}]*width:\s*77px;[^}]*height:\s*auto;[^}]*display:\s*block;[^}]*filter:\s*invert\(1\)/);
  });

  it('keeps content clear of mobile display cutouts', () => {
    assert.match(monitorHtml, /viewport-fit=cover/);
    assert.match(monitorHtml, /--page-pad-left:\s*calc\(\d+px \+ env\(safe-area-inset-left\)\)/);
    assert.match(monitorHtml, /--page-pad-right:\s*calc\(\d+px \+ env\(safe-area-inset-right\)\)/);
    assert.match(monitorHtml, /padding:\s*var\(--page-pad-top\)\s+var\(--page-pad-right\)[\s\S]*var\(--page-pad-bottom\)\s+var\(--page-pad-left\)/);
    assert.match(monitorHtml, /@media \(orientation: landscape\) and \(max-height: 500px\)[\s\S]*--page-pad-left:\s*calc\(2px \+ env\(safe-area-inset-left\)\)/);
  });

  it('spaces session cards without showing a live status badge', () => {
    assert.match(monitorHtml, /\.sessions-list\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column[^}]*gap:\s*12px/);
    assert.doesNotMatch(monitorHtml, /id="status"/);
    assert.doesNotMatch(monitorHtml, /● Live|○ Offline/);
  });

  it('keeps monitor sections equal-sized by orientation', () => {
    assert.match(monitorHtml, /\.app\s*\{[^}]*width:\s*calc\(100dvw - var\(--page-pad-left\) - var\(--page-pad-right\)\)[^}]*min-width:\s*0[^}]*grid-template-rows:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(monitorHtml, /@media \(orientation: landscape\), \(min-width: 768px\)[\s\S]*\.app\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*grid-template-rows:\s*1fr/);
    assert.match(monitorHtml, /\.usage-card,\s*\.sessions-list\s*\{[^}]*height:\s*100%[^}]*min-width:\s*0[^}]*min-height:\s*0/);
    assert.match(monitorHtml, /\.glass-card,\s*\.session-card\s*\{[^}]*min-width:\s*0/);
  });

  it('animates session card reordering', () => {
    assert.match(monitorHtml, /data-session-id="\$\{escapeHtml\(s\.sessionId\)\}"/);
    assert.match(monitorHtml, /function getSessionCardPositions\(\)/);
    assert.match(monitorHtml, /function animateSessionMoves\(oldPositions\)/);
    assert.match(monitorHtml, /const oldSessionPositions = getSessionCardPositions\(\);/);
    assert.match(monitorHtml, /animateSessionMoves\(oldSessionPositions\);/);
    assert.match(monitorHtml, /\.session-card\s*\{[^}]*transition:[^}]*transform 0\.36s cubic-bezier\(0\.2,\s*0\.8,\s*0\.2,\s*1\)[^}]*background 0\.15s[^}]*border-color 0\.15s/);
    assert.match(monitorHtml, /\.session-card\.session-moving\s*\{/);
    assert.match(monitorHtml, /prefers-reduced-motion: reduce/);
  });

  it('reparses session data before polling monitor data', () => {
    assert.match(monitorHtml, /await fetch\(["']\/api\/reparse["'], \{ cache: ["']no-store["'] \}\);[\s\S]*const res = await fetch\(["']\/api\/monitor["'], \{ cache: ["']no-store["'] \}\);/);
  });

  it('opens session details in a monitor dialog', () => {
    assert.match(monitorHtml, /<dialog class="modal-dialog" id="sessionDetailDialog">/);
    assert.match(monitorHtml, /async function showSession\(id\)/);
    assert.match(monitorHtml, /new URLSearchParams\(\{ id: String\(id \|\| ""\) \}\)/);
    assert.match(monitorHtml, /fetch\("\/api\/session\?" \+ params\.toString\(\),\s*\{ cache: "no-store" \}\)/);
    assert.match(monitorHtml, /\.showModal\(\)/);
    assert.match(monitorHtml, /dialog\.modal-dialog\s*\{[\s\S]*position: fixed;[\s\S]*top: 50%;[\s\S]*left: 50%;[\s\S]*transform: translate\(-50%, -50%\);[\s\S]*margin: 0;/);
    assert.doesNotMatch(monitorHtml, /window\.open\("\/\?session="/);
  });

  it('ships a Claude monitor page with matching layout and Claude endpoints', () => {
    const claudeMonitorPath = path.join(__dirname, '..', 'public', 'claude-monitor.html');
    assert.ok(fs.existsSync(claudeMonitorPath), 'claude-monitor.html should exist');
    const claudeMonitorHtml = fs.readFileSync(claudeMonitorPath, 'utf8');

    assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'claude-color.svg')));
    assert.match(claudeMonitorHtml, /<title>Claude Monitor<\/title>/);
    assert.match(claudeMonitorHtml, /<img class="logo-mark" src="claude-color\.svg" alt="" \/>/);
    assert.match(claudeMonitorHtml, /<span class="wordmark text-wordmark">Claude<\/span>/);
    assert.match(claudeMonitorHtml, /await fetch\('\/api\/claude-reparse', \{ cache: 'no-store' \}\);[\s\S]*const res = await fetch\('\/api\/claude-monitor', \{ cache: 'no-store' \}\);/);
    assert.match(claudeMonitorHtml, /\.app\{[^}]*grid-template-rows:repeat\(2,minmax\(0,1fr\)\)/);
    assert.match(claudeMonitorHtml, /renderUsageCard\(data\.rateLimits\)/);
    assert.doesNotMatch(claudeMonitorHtml, /@lobehub\/icons|from ['"]@lobehub\/icons|codex-color\.svg|codex-text\.svg|GPT-5\.3-Codex-Spark/);
  });

  it('renders Claude rate limits', () => {
    const claudeMonitorHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'claude-monitor.html'), 'utf8');
    const { renderUsageCard } = loadMonitorScript(claudeMonitorHtml);
    const html = renderUsageCard({
      plan_type: 'claude',
      rate_limit: {
        primary_window: {
          used_percent: 35,
          reset_after_seconds: 9000,
        },
        secondary_window: {
          used_percent: 17,
          reset_after_seconds: (3 * 24 * 3600) + (13 * 3600),
        },
      },
      additional_rate_limits: [
        {
          limit_name: 'Sonnet',
          rate_limit: {
            secondary_window: {
              used_percent: 10,
              reset_after_seconds: (3 * 24 * 3600) + (13 * 3600),
            },
          },
        },
      ],
    });

    assert.match(html, /<span>5h<\/span><span class="js-flip" data-key="5h">65% left<\/span>/);
    assert.match(html, /<span>weekly<\/span><span class="js-flip" data-key="7d">83% left<\/span>/);
    assert.match(html, /<div class="limit-group-title">Sonnet<\/div>/);
    assert.match(html, /<span>weekly<\/span><span class="js-flip" data-key="sonnet-weekly">90% left<\/span>/);
    assert.doesNotMatch(html, /API-equivalent estimate|Cost|Tokens/);
  });

  it('shows an empty rate limit state instead of summary values', () => {
    const claudeMonitorHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'claude-monitor.html'), 'utf8');
    const { renderUsageCard } = loadMonitorScript(claudeMonitorHtml);
    const html = renderUsageCard(null);
    const summaryHtml = renderUsageCard({
      costUsd: 12.5,
      totalTokens: 100000,
      calls: 25,
      sessions: 5,
    });

    assert.match(html, /No Claude rate limit data/);
    assert.doesNotMatch(html, /Cost|Tokens|Calls|Sessions|API-equivalent estimate/);
    assert.match(summaryHtml, /No Claude rate limit data/);
    assert.doesNotMatch(summaryHtml, /\$12\.5000|100,000/);
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
    assert.doesNotMatch(html, /usage-card compact/);
    assert.doesNotMatch(html, /limit-group-title/);
  });

  it('shows separate GPT-5.3 Spark rate limits from additional limits', () => {
    const { renderUsageCard } = loadMonitorScript();
    const html = renderUsageCard({
      plan_type: 'pro',
      rate_limit: {
        primary_window: {
          used_percent: 10,
          reset_after_seconds: 3600,
        },
        secondary_window: {
          used_percent: 20,
          reset_after_seconds: 604800,
        },
      },
      additional_rate_limits: [
        {
          limit_name: 'GPT-5.3-Codex-Spark',
          metered_feature: 'codex_bengalfox',
          rate_limit: {
            primary_window: {
              used_percent: 4,
              reset_after_seconds: 7200,
            },
            secondary_window: {
              used_percent: 16,
              reset_after_seconds: (4 * 24 * 3600) + (12 * 3600),
            },
          },
        },
      ],
    });

    assert.match(html, /usage-card compact/);
    assert.doesNotMatch(html, /<div class="limit-group-title">Codex<\/div>/);
    assert.match(html, /<div class="limit-group-title">GPT-5\.3-Codex-Spark<\/div>/);
    assert.match(html, /class="limit-group"/);
    assert.match(html, /<span>5h<\/span><span class="js-flip" data-key="5\.3-5h">96% left<\/span>/);
    assert.match(html, /<span>weekly<\/span><span class="js-flip" data-key="5\.3-weekly">84% left<\/span>/);
    assert.match(html, /Reset in 2h 0m \(10:42 PM\)/);
    assert.match(html, /Reset in 4d 12h \(Jul 7 08:42 AM\)/);
  });
});
