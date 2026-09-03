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
const parserScript = path.join(rootDir, 'scripts', 'parse-codex-logs.mjs');

describe('Codex config scanning', () => {
  it('writes an empty optimize report for Cost Lens-only mode', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(path.join(home, '.codex', 'sessions'), { recursive: true });

    execFileSync(process.execPath, [parserScript, '--date=2026-06-23', '--date-only'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      stdio: 'pipe',
    });

    const report = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-optimize.json'), 'utf8'));
    assert.equal(report.healthScore, 100);
    assert.equal(report.totalSavingsTokens, 0);
    assert.equal(report.findingCount, 0);
    assert.deepEqual(report.findings, []);
  });

  it('keeps shell subcommands out of core tool counts and counts agents', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const sessionDir = path.join(home, '.codex', 'sessions', '2026', '06', '23');
    const sessionFile = path.join(sessionDir, 'rollout-2026-06-23T00-00-00-019e0000-0000-7000-8000-000000000001.jsonl');

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, [
      {
        timestamp: '2026-06-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: '019e0000-0000-7000-8000-000000000001' },
      },
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'check tools' },
      },
      {
        timestamp: '2026-06-23T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: 'rg foo && sed -n 1,80p a && cat b && yarn test && go test ./...', workdir: cwd }),
          call_id: 'call_bash',
        },
      },
      {
        timestamp: '2026-06-23T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'spawn_agent',
          arguments: JSON.stringify({ target: '019e0000-0000-7000-8000-000000000002' }),
          call_id: 'call_spawn',
        },
      },
      {
        timestamp: '2026-06-23T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'wait_agent',
          arguments: JSON.stringify({ targets: ['019e0000-0000-7000-8000-000000000002'] }),
          call_id: 'call_wait',
        },
      },
      {
        timestamp: '2026-06-23T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 30000,
              cached_input_tokens: 0,
              output_tokens: 1000,
              reasoning_output_tokens: 1000,
              total_tokens: 31000,
            },
            model_context_window: 100000,
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

    const usage = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-usage-2026-06-23.json'), 'utf8'));
    const session = usage.sessions[0];
    const turn = usage.sessions[0].turns[0];

    assert.equal(session.contextWindowTokens, 100000);
    assert.equal(session.contextUsedTokens, 30000);
    assert.equal(session.contextRemainingPercent, 70);
    assert.equal(usage.days[0].commands.rg, 1);
    assert.equal(usage.days[0].commands['go test'], 1);
    assert.equal(turn.tools.Bash, 1);
    assert.equal(turn.tools.Agent, 2);
    assert.equal(turn.tools.rg, undefined);
    assert.equal(turn.tools['go test'], undefined);
    assert.equal(turn.commands.rg, 1);
    assert.equal(turn.commands.sed, 1);
    assert.equal(turn.commands.cat, 1);
    assert.equal(turn.commands['yarn test'], 1);
    assert.equal(turn.commands['go test'], 1);

    const burn = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-burn.json'), 'utf8'));
    assert.deepEqual(burn.topSessions, []);
  });

  it('flags search and test heavy sessions by edit ratio', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const sessionDir = path.join(home, '.codex', 'sessions', '2026', '06', '23');
    const sessionFile = path.join(sessionDir, 'rollout-2026-06-23T00-00-00-019e0000-0000-7000-8000-000000000011.jsonl');

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    const events = [
      {
        timestamp: '2026-06-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: '019e0000-0000-7000-8000-000000000011' },
      },
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'investigate flaky tests' },
      },
    ];
    let second = 2;
    const addCommandStep = (cmd) => {
      events.push({
        timestamp: `2026-06-23T00:00:${String(second++).padStart(2, '0')}.000Z`,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd, workdir: cwd }),
          call_id: `call_${second}`,
        },
      });
      events.push({
        timestamp: `2026-06-23T00:00:${String(second++).padStart(2, '0')}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
          },
        },
      });
    };

    ['rg a', 'sed -n 1,80p a', 'cat a', 'rg b', 'sed -n 1,80p b'].forEach(addCommandStep);
    ['yarn test', 'rg c', 'yarn test', 'cat b', 'yarn test', 'rg d', 'yarn test', 'sed -n 1,80p c', 'yarn test', 'cat c'].forEach(addCommandStep);

    fs.writeFileSync(sessionFile, events.map((event) => JSON.stringify(event)).join('\n'));

    execFileSync(process.execPath, [parserScript, '--date=2026-06-23', '--date-only'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      stdio: 'pipe',
    });

    const burn = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-burn.json'), 'utf8'));
    assert.equal(burn.topSessions[0].score, 89);
    assert.equal(burn.topSessions[0].primaryReason.label, 'Search Heavy / Low Edit');
    assert.deepEqual(burn.topSessions[0].deductions, [
      {
        label: 'Search Heavy / Low Edit',
        level: 'medium',
        points: 6,
        evidence: 'search 10 (rg 4, sed 3, cat 3), edits 0, ratio 10.0:1',
        logic: 'Flags many search/read commands with few edits.',
        levels: [
          { level: 'medium', text: '>= 10 search/read commands and >= 10:1 search/edit ratio' },
          { level: 'high', text: '>= 10 search/read commands and >= 25:1 search/edit ratio' },
        ],
        role: 'primary',
      },
      {
        label: 'Test Heavy / Low Edit',
        level: 'medium',
        points: 5,
        evidence: 'tests 5 (go 0, npm 0, pnpm 0, yarn 5), edits 0, ratio 5.0:1',
        logic: 'Flags many test commands with few edits.',
        levels: [
          { level: 'medium', text: '>= 5 test commands and >= 5:1 test/edit ratio' },
          { level: 'high', text: '>= 5 test commands and >= 10:1 test/edit ratio' },
        ],
        role: 'primary',
      },
    ]);
  });

  it('flags repeated rework only for consecutive verification retries', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const sessionDir = path.join(home, '.codex', 'sessions', '2026', '06', '23');
    const sessionFile = path.join(sessionDir, 'rollout-2026-06-23T00-00-00-019e0000-0000-7000-8000-000000000010.jsonl');

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });

    const events = [
      {
        timestamp: '2026-06-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: '019e0000-0000-7000-8000-000000000010' },
      },
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'fix retry logic' },
      },
    ];
    let second = 2;
    const addCommandStep = (cmd) => {
      events.push({
        timestamp: `2026-06-23T00:00:${String(second++).padStart(2, '0')}.000Z`,
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd, workdir: cwd }),
          call_id: `call_${second}`,
        },
      });
      events.push({
        timestamp: `2026-06-23T00:00:${String(second++).padStart(2, '0')}.000Z`,
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
          },
        },
      });
    };

    addCommandStep('yarn test');
    events.push({
      timestamp: `2026-06-23T00:00:${String(second++).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: { type: 'patch_apply_end', success: true, changes: { 'src/a.js': {} } },
    });
    addCommandStep('yarn test');
    addCommandStep('yarn test');
    addCommandStep('yarn test');

    fs.writeFileSync(sessionFile, events.map((event) => JSON.stringify(event)).join('\n'));

    execFileSync(process.execPath, [parserScript, '--date=2026-06-23', '--date-only'], {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
      },
      stdio: 'pipe',
    });

    const burn = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-burn.json'), 'utf8'));
    const repeated = burn.topSessions[0].deductions.find((item) => item.label === 'Repeated Rework');

    assert.ok(repeated, 'expected repeated rework deduction');
    assert.equal(repeated.evidence, 'longest verification retry run 3 (yarn test)');
    assert.deepEqual(repeated.levels, [
      { level: 'low', text: '>= 3 consecutive verification commands' },
      { level: 'medium', text: '>= 4 consecutive verification commands' },
      { level: 'high', text: '>= 6 consecutive verification commands' },
    ]);
  });

  it('marks internal model/reasoning sessions as assessment sessions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const sessionDir = path.join(home, '.codex', 'sessions', '2026', '06', '23');
    const sessionFile = path.join(sessionDir, 'rollout-2026-06-23T00-00-00-019e0000-0000-7000-8000-000000000012.jsonl');

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, [
      {
        timestamp: '2026-06-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: '019e0000-0000-7000-8000-000000000012' },
      },
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'model:GPT-5.5 medium reasoning effort' },
      },
      {
        timestamp: '2026-06-23T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
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

    const usage = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-usage-2026-06-23.json'), 'utf8'));

    assert.equal(usage.sessions[0].sessionType, 'assessment');
  });

  it('marks subagents from assessment parents as assessment sessions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const sessionDir = path.join(home, '.codex', 'sessions', '2026', '06', '23');
    const parentId = '019e0000-0000-7000-8000-000000000013';
    const childId = '019e0000-0000-7000-8000-000000000014';
    const parentFile = path.join(sessionDir, `rollout-2026-06-23T00-00-00-${parentId}.jsonl`);
    const childFile = path.join(sessionDir, `rollout-2026-06-23T00-00-01-${childId}.jsonl`);

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(parentFile, [
      {
        timestamp: '2026-06-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: parentId, thread_source: 'user' },
      },
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'model:GPT-5.5 medium reasoning effort' },
      },
      {
        timestamp: '2026-06-23T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
          },
        },
      },
    ].map((event) => JSON.stringify(event)).join('\n'));
    fs.writeFileSync(childFile, [
      {
        timestamp: '2026-06-23T00:00:03.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: childId, thread_source: 'subagent', parent_thread_id: parentId },
      },
      {
        timestamp: '2026-06-23T00:00:04.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'subagent work' },
      },
      {
        timestamp: '2026-06-23T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
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

    const usage = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-usage-2026-06-23.json'), 'utf8'));
    // ponytail: C – subagents aggregated into parent, not listed separately
    const child = usage.sessions.find((session) => session.sessionId === childId);
    assert.equal(child, undefined);
    const parent = usage.sessions.find((session) => session.sessionId === parentId);
    assert.equal(parent.sessionType, 'assessment');
    // parent cost should include child's 100 input + 20 output (assessment child aggregated)
    assert.equal(parent.inputTokens, 200);
    assert.equal(parent.outputTokens, 40);
  });

  it('counts explicit skill links without counting available skill paths', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const sessionDir = path.join(home, '.codex', 'sessions', '2026', '06', '23');
    const sessionFile = path.join(sessionDir, 'rollout-2026-06-23T00-00-00-019e0000-0000-7000-8000-000000000003.jsonl');

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, [
      {
        timestamp: '2026-06-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: '019e0000-0000-7000-8000-000000000003' },
      },
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: [
            '[$code-review-expert](/Users/me/.agents/skills/code-review-expert/SKILL.md) review this',
            'Available skills: (file: /Users/me/.codex/skills/.system/openai-docs/SKILL.md)',
            '(file: /Users/me/.codex/plugins/cache/openai-primary-runtime/pdf/26/skills/pdf/SKILL.md)',
            'skills/SKILL.md)\\n-',
          ].join('\n'),
        },
      },
      {
        timestamp: '2026-06-23T00:00:01.500Z',
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: `sed -n '1,120p' ${home}/.agents/skills/baseline-ui/SKILL.md`, workdir: cwd }),
          call_id: 'call_skill_read',
        },
      },
      {
        timestamp: '2026-06-23T00:00:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
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

    const usage = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-usage-2026-06-23.json'), 'utf8'));
    const skills = usage.sessions[0].turns[0].skills;

    assert.equal(skills['code-review-expert'], 1);
    assert.equal(skills['baseline-ui'], 1);
    assert.equal(skills['.system'], undefined);
    assert.equal(skills.pdf, undefined);
    assert.equal(skills['SKILL.md)\\n-'], undefined);
  });

  it('parses modern Codex events into turns, messages, tools, commands, skills, and files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cost-lens-'));
    const home = path.join(tmp, 'home');
    const cwd = path.join(tmp, 'workspace');
    const sessionId = '019e0000-0000-7000-8000-000000000021';
    const turnId = '019e0000-0000-7000-8000-000000000022';
    const sessionDir = path.join(home, '.codex', 'sessions', '2026', '06', '23');
    const sessionFile = path.join(sessionDir, `rollout-2026-06-23T00-00-00-${sessionId}.jsonl`);
    const userText = 'inspect the current implementation';
    const assistantText = 'I inspected the implementation and found the relevant file.';

    fs.mkdirSync(path.join(cwd, 'public', 'data'), { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, [
      {
        timestamp: '2026-06-23T00:00:00.000Z',
        type: 'session_meta',
        payload: { cwd, session_id: sessionId, thread_source: 'user' },
      },
      {
        timestamp: '2026-06-23T00:00:00.100Z',
        type: 'turn_context',
        payload: { turn_id: turnId, cwd, model: 'gpt-5.6-luna' },
      },
      {
        timestamp: '2026-06-23T00:00:00.900Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for the workspace' }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        timestamp: '2026-06-23T00:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: userText }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        timestamp: '2026-06-23T00:00:01.001Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: turnId,
          item: { type: 'UserMessage', id: 'user-item', content: [{ type: 'text', text: userText }] },
        },
      },
      {
        timestamp: '2026-06-23T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: assistantText }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        },
      },
      {
        timestamp: '2026-06-23T00:00:02.001Z',
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          turn_id: turnId,
          item: { type: 'AgentMessage', id: 'assistant-item', content: [{ type: 'Text', text: assistantText }] },
        },
      },
      {
        timestamp: '2026-06-23T00:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec',
          input: `const r = await tools.exec_command({cmd:"rtk sed -n 1,20p /Users/me/.agents/skills/baseline-ui/SKILL.md && rtk git status --short",workdir:${JSON.stringify(cwd)}}); text(r.output);`,
        },
      },
      {
        timestamp: '2026-06-23T00:00:04.000Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_patch',
          input: `const patch = ${JSON.stringify(`*** Begin Patch\\n*** Update File: ${cwd}/src/app.js\\n@@\\n-old\\n+new\\n*** End Patch`)}; text(await tools.apply_patch(patch));`,
        },
      },
      {
        timestamp: '2026-06-23T00:00:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_reasoning',
          text: 'Checking the implementation',
        },
      },
      {
        timestamp: '2026-06-23T00:00:06.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              cache_write_input_tokens: 10,
              output_tokens: 10,
              reasoning_output_tokens: 2,
              total_tokens: 110,
            },
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

    const usage = JSON.parse(fs.readFileSync(path.join(cwd, 'public', 'data', 'codex-usage-2026-06-23.json'), 'utf8'));
    const session = usage.sessions[0];
    const turn = session.turns[0];
    const step = turn.steps[0];

    assert.equal(session.turns.length, 1);
    assert.equal(turn.userMessage, userText);
    assert.equal(session.models['gpt-5.6-luna'], 1);
    assert.equal(step.message, assistantText);
    assert.equal(step.commentary[0], 'Checking the implementation');
    assert.equal(turn.tools.Bash, 1);
    assert.equal(turn.tools.Edit, 1);
    assert.equal(turn.commands.sed, 1);
    assert.equal(turn.commands.git, 1);
    assert.equal(turn.skills['baseline-ui'], 1);
    assert.equal(turn.files[`${cwd}/src/app.js`], 1);
    assert.equal(step.toolCalls.some((call) => call.name === 'exec_command'), true);
    assert.equal(step.toolCalls.some((call) => call.name === 'apply_patch'), true);
    assert.equal(turn.cacheWriteInputTokens, 10);
    assert.equal(step.cacheWriteInputTokens, 10);
    assert.equal(step.effectiveInputTokens, 70);
    // ponytail: reasoning billed as output (2 tokens * luna output $1.2/M)
    assert.equal(step.costUsd, 0.0000313);
  });
});
