// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import fs from 'fs';
import path from 'path';

const CODEX_DIR = `${process.env.HOME}/.codex`;
const OUTPUT_DIR = 'public';
const DATA_DIR = path.join(OUTPUT_DIR, 'data');
const OUTPUT_FILE_PREFIX = 'codex-usage';

const args = process.argv.slice(2);
const RUN_ALL = args.includes('--all');
const RUN_DATE_ONLY = args.includes('--date-only');
const RUN_FILL = args.some((arg) => arg.startsWith('--fill'));
const FILL_DAYS = parseInt(args.find((arg) => arg.startsWith('--fill='))?.split('=')[1] || '30', 10);
const TARGET_DATE =
  args.find((arg) => /^--date=\d{4}-\d{2}-\d{2}$/.test(arg))?.split('=')[1] ||
  new Date().toISOString().slice(0, 10);

const targetStart = new Date(`${TARGET_DATE}T00:00:00.000Z`);
const targetEnd = new Date(targetStart);
targetEnd.setUTCDate(targetEnd.getUTCDate() + 1);
const targetDatePath = TARGET_DATE.replaceAll('-', path.sep);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const analysisEnd = targetEnd;
const analysisStart = new Date(targetStart);
const defaultRangeDays = RUN_FILL ? FILL_DAYS : 6;
analysisStart.setUTCDate(analysisStart.getUTCDate() - defaultRangeDays);

const MODEL_PRICING_USD_PER_1M = {
  'gpt-5.6': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-sol': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.6-terra': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.6-luna': { input: 1, cachedInput: 0.1, output: 6 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-medium': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.5-extra-high': { input: 5, cachedInput: 0.5, output: 30 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  default: { input: 5, cachedInput: 0.5, output: 30 },
};

function isFilePossiblyRelevant(full, stat) {
  if (RUN_ALL) return true;
  if (RUN_DATE_ONLY) return full.includes(TARGET_DATE) || full.includes(targetDatePath) || (stat.mtime >= targetStart && stat.mtime < targetEnd);
  return full.includes(TARGET_DATE) || full.includes(targetDatePath) || (stat.mtime >= analysisStart && stat.mtime < analysisEnd);
}

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const full = path.join(dir, name);

    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (name.endsWith('.jsonl')) {
      const stat = fs.statSync(full);
      if (!isFilePossiblyRelevant(full, stat)) continue;
      results.push(full);
    }
  }

  return results;
}

function getDateKey(event, filePath) {
  const value = event.timestamp || event.payload?.timestamp;
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  const match = filePath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  return 'unknown';
}

function ensureDay(map, date) {
  if (!map[date]) {
    map[date] = {
      date,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      eventCount: 0,
      tokenEventCount: 0,
      maxRateLimitUsedPercent: null,
      tools: {},
      commands: {},
      skills: {},
      files: {},
    };
  }

  return map[date];
}

function addCount(map, key, n = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + n;
}

function mergeCounts(target, source) {
  for (const [key, value] of Object.entries(source || {})) {
    addCount(target, key, value);
  }
}

function extractLastUsage(event) {
  if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
    return event.payload?.info?.last_token_usage || null;
  }

  return null;
}

function extractRateLimit(event) {
  return event.payload?.rate_limits?.primary?.used_percent ?? null;
}

function getPricingForModel(model) {
  const normalized = String(model || '').toLowerCase();
  const matchedKey = Object.keys(MODEL_PRICING_USD_PER_1M)
    .filter((key) => key !== 'default')
    .find((key) => normalized.includes(key));
  return MODEL_PRICING_USD_PER_1M[matchedKey] || MODEL_PRICING_USD_PER_1M.default;
}

function estimateCostUsd({ inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, model = 'unknown' }) {
  const pricing = getPricingForModel(model);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  return (
    (uncachedInputTokens * pricing.input) / 1_000_000 +
    (cachedInputTokens * pricing.cachedInput) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000
  );
}

function findFirstStringByKeys(value, keys) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKeys(item, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (keys.includes(lowerKey) && typeof child === 'string' && child.trim()) {
      return child.trim();
    }
    const found = findFirstStringByKeys(child, keys);
    if (found) return found;
  }
  return null;
}

function extractModel(event) {
  return findFirstStringByKeys(event, ['model', 'model_name', 'modelid', 'model_id']) || 'unknown';
}

function extractWorkdir(event) {
  return findFirstStringByKeys(event, ['workdir', 'cwd', 'current_working_directory', 'working_directory']) || null;
}

function projectNameFromPath(value) {
  if (!value) return null;
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || null;
}

function extractProjectName(event) {
  const workdir = extractWorkdir(event);
  return projectNameFromPath(workdir) || 'unknown';
}

function createMetricBucket(extra = {}) {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    effectiveInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    calls: 0,
    turns: 0,
    sessions: 0,
    costUsd: 0,
    tools: {},
    commands: {},
    skills: {},
    files: {},
    ...extra,
  };
}

function addMetrics(target, source) {
  target.inputTokens += source.inputTokens || 0;
  target.cachedInputTokens += source.cachedInputTokens || 0;
  target.effectiveInputTokens += source.effectiveInputTokens ?? Math.max(0, (source.inputTokens || 0) - (source.cachedInputTokens || 0));
  target.outputTokens += source.outputTokens || 0;
  target.reasoningOutputTokens += source.reasoningOutputTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.calls += source.calls || source.tokenEventCount || 0;
  target.turns += source.turns || 0;
  target.sessions += source.sessions || 0;
  target.costUsd += source.costUsd || 0;
  mergeCounts(target.tools, source.tools);
  mergeCounts(target.commands, source.commands);
  mergeCounts(target.skills, source.skills);
  mergeCounts(target.files, source.files);
}

function finalizeMetricBucket(bucket) {
  bucket.effectiveInputTokens = bucket.inputTokens - bucket.cachedInputTokens;
  bucket.cacheRatio = bucket.inputTokens > 0 ? bucket.cachedInputTokens / bucket.inputTokens : 0;
  bucket.costUsd = Number((bucket.costUsd || 0).toFixed(6));
  return bucket;
}

function sortByCostDesc(items, limit = 30) {
  return items.sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0)).slice(0, limit);
}

function dateRangeDays(start, endExclusive) {
  const days = [];
  const cursor = new Date(start);
  while (cursor < endExclusive) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function getPeriodRanges(targetDate) {
  const end = new Date(`${targetDate}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);

  const todayStart = new Date(end);
  todayStart.setUTCDate(todayStart.getUTCDate() - 1);

  const sevenDaysStart = new Date(end);
  sevenDaysStart.setUTCDate(sevenDaysStart.getUTCDate() - 7);

  const thirtyDaysStart = new Date(end);
  thirtyDaysStart.setUTCDate(thirtyDaysStart.getUTCDate() - 30);

  const thisMonthStart = new Date(Date.UTC(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1));

  const sixMonthsStart = new Date(end);
  sixMonthsStart.setUTCMonth(sixMonthsStart.getUTCMonth() - 6);

  return [
    { key: 'today', label: 'Today', start: todayStart, end },
    { key: '7days', label: '7 Days', start: sevenDaysStart, end },
    { key: '30days', label: '30 Days', start: thirtyDaysStart, end },
    { key: 'thisMonth', label: 'This Month', start: thisMonthStart, end },
    { key: '6months', label: '6 Months', start: sixMonthsStart, end },
  ];
}

function isDateInRange(date, range) {
  const value = new Date(`${date}T00:00:00.000Z`);
  return value >= range.start && value < range.end;
}

function detectSkills(rawText) {
  const skills = [];

  for (const match of rawText.matchAll(/\[[^\]]+\]\([^)]*\/skills\/([^/()\s]+)\/SKILL\.md\)/gi)) {
    skills.push(match[1]);
  }

  return skills;
}

function detectSkillReads(rawCommand) {
  if (!/\b(cat|less|sed|head|tail)\b/.test(rawCommand || '')) return [];
  return [...String(rawCommand).matchAll(/\/skills\/([^/()"'\s]+)\/SKILL\.md/g)].map(match => match[1]);
}

function truncateText(text, max = 1000) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function addLimited(list, value, maxItems = 30, maxLength = 1000) {
  const text = truncateText(value, maxLength);
  if (!text) return;
  if (list.includes(text)) return;

  list.push(text);

  if (list.length > maxItems) {
    list.shift();
  }
}

function safeStringify(value, max = 1000) {
  if (typeof value === 'string') return truncateText(value, max);

  try {
    return truncateText(JSON.stringify(value), max);
  } catch {
    return truncateText(String(value), max);
  }
}

function looksLikeNoise(text) {
  if (!text) return true;
  if (text.length < 4) return true;
  if (/^(bash|read|edit|write|apply_patch|rg|sed|cat|git|npm|pnpm|yarn|docker)$/i.test(text)) return true;
  if (/^[{}\[\],:"'\s0-9._/-]+$/.test(text)) return true;
  if (text.includes('last_token_usage')) return true;
  if (text.includes('cached_input_tokens')) return true;
  if (text.includes('reasoning_output_tokens')) return true;
  if (text.includes('used_percent')) return true;
  if (/^(input_text|output_text|text|message|content)$/i.test(text)) return true;
  return false;
}

function normalizeMessageRole(role) {
  const value = String(role || '').toLowerCase();
  if (value.includes('user')) return 'user';
  if (value.includes('assistant')) return 'assistant';
  if (value.includes('system')) return 'system';
  if (value.includes('tool')) return 'tool';
  return value || 'unknown';
}

function extractTextFromContent(value, results = []) {
  if (typeof value === 'string') {
    results.push(value);
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractTextFromContent(item, results);
    }
    return results;
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') results.push(value.text);
    if (typeof value.content === 'string') results.push(value.content);
    if (typeof value.output === 'string') results.push(value.output);
    if (typeof value.message === 'string') results.push(value.message);

    for (const [key, child] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (['text', 'content', 'output', 'message'].includes(lowerKey)) continue;
      extractTextFromContent(child, results);
    }
  }

  return results;
}

function getEventKind(event) {
  return [event.type, event.payload?.type, event.payload?.subtype, event.payload?.kind]
    .filter(Boolean)
    .join(' / ');
}

function extractConversationEntries(event) {
  const entries = [];
  const payload = event.payload || {};
  const eventKind = getEventKind(event);

  const candidates = [
    event.message,
    event.content,
    event.text,
    payload.message,
    payload.messages,
    payload.content,
    payload.text,
    payload.delta,
    payload.item,
    payload.items,
    payload.info?.message,
    payload.info?.messages,
    payload.info?.content,
    payload.info?.text,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    const role = normalizeMessageRole(candidate.role || candidate.author?.role || payload.role || payload.author?.role || event.role);
    const texts = extractTextFromContent(candidate, []);

    for (const raw of texts) {
      const text = truncateText(raw, 1000);
      if (looksLikeNoise(text)) continue;
      entries.push({ role, text, eventKind });
    }
  }

  return dedupeEntries(entries).slice(0, 12);
}

function dedupeEntries(entries) {
  const seenText = new Set();
  const result = [];

  for (const entry of entries) {
    const text = truncateText(entry.text, 1000);
    if (!text || looksLikeNoise(text)) continue;

    const textKey = text.replace(/^\[[^\]]+\]\s*/, '');
    if (seenText.has(textKey)) continue;

    seenText.add(textKey);
    result.push({ ...entry, text });
  }

  return result;
}

function stringifyCommandValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(' ');
  }

  if (value && typeof value === 'object') {
    return safeStringify(value, 1000);
  }

  return String(value || '');
}

function extractToolEntriesFromObject(value, entries = [], context = {}) {
  if (!value || typeof value !== 'object') return entries;

  if (Array.isArray(value)) {
    for (const item of value) {
      extractToolEntriesFromObject(item, entries, context);
    }
    return entries;
  }

  const possibleName = value.name || value.tool || value.tool_name || value.call?.name || value.function?.name;
  const possibleType = value.type || value.kind || value.subtype;
  const nextContext = {
    name: possibleName || context.name,
    type: possibleType || context.type,
  };

  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();

    if (['cmd', 'command', 'arguments', 'args', 'input'].includes(lowerKey)) {
      const text = stringifyCommandValue(child);
      if (!looksLikeNoise(text)) {
        entries.push({
          tool: nextContext.name || nextContext.type || 'tool',
          field: lowerKey,
          text: truncateText(text, 1000),
        });
      }
    }

    if (['stdout', 'stderr', 'output', 'result', 'error'].includes(lowerKey)) {
      const text = stringifyCommandValue(child);
      if (!looksLikeNoise(text)) {
        entries.push({
          tool: nextContext.name || nextContext.type || 'tool',
          field: lowerKey,
          text: truncateText(text, 1000),
        });
      }
    }

    extractToolEntriesFromObject(child, entries, nextContext);
  }

  return entries;
}

function extractToolEntries(event) {
  return dedupeEntries(
    extractToolEntriesFromObject(event, []).map((entry) => ({
      role: `${entry.tool}:${entry.field}`,
      text: entry.text,
      eventKind: getEventKind(event),
    })),
  ).slice(0, 20);
}

function formatEntries(entries) {
  return entries.map((entry) => {
    const prefix = entry.role && entry.role !== 'unknown' ? `[${entry.role}] ` : '';
    return `${prefix}${entry.text}`;
  });
}

function extractChatMessages(event) {
  return formatEntries(extractConversationEntries(event));
}

function extractCommands(event) {
  return formatEntries(extractToolEntries(event));
}

function getSessionId(file) {
  const base = path.basename(file, '.jsonl');
  const uuidMatch = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (uuidMatch) return uuidMatch[1];
  return base;
}

function isUserMessage(event) {
  return event.type === 'event_msg' && event.payload?.type === 'user_message';
}

function isAssessmentPrompt(text) {
  const normalized = String(text || '').trim().toLowerCase();
  return normalized.startsWith('the following is the codex agent history')
    || /^model:\s*gpt-[\w.-]+(?:\s+[\w.-]+)*\s+reasoning\s+effort\b/.test(normalized);
}

function isSystemUserMessage(event) {
  return event.type === 'response_item' && event.payload?.type === 'message' && event.payload?.role === 'user';
}

function isAgentMessage(event) {
  return event.type === 'event_msg' && event.payload?.type === 'agent_message';
}

function isTokenCount(event) {
  return event.type === 'event_msg' && event.payload?.type === 'token_count';
}

function isFunctionCall(event) {
  return event.type === 'response_item' && event.payload?.type === 'function_call';
}

function isFunctionCallOutput(event) {
  return event.type === 'response_item' && event.payload?.type === 'function_call_output';
}

function isPatchApplyEnd(event) {
  return event.type === 'event_msg' && event.payload?.type === 'patch_apply_end';
}

const toolNameMap = {
  exec_command: 'Bash',
  write_stdin: 'Bash',
  read_file: 'Read',
  write_file: 'Edit',
  apply_diff: 'Edit',
  apply_patch: 'Edit',
  spawn_agent: 'Agent',
  close_agent: 'Agent',
  wait_agent: 'Agent',
  read_dir: 'Glob',
  grep: 'Grep',
};

function detectSubCommands(cmd) {
  if (!cmd) return [];
  const known = ['rg', 'sed', 'cat', 'go test', 'npm test', 'pnpm test', 'yarn test', 'yarn build', 'yarn lint', 'npm', 'yarn', 'pnpm', 'docker', 'git', 'node', 'python3', 'python', 'npx', 'tsx', 'curl', 'wget', 'gh', 'aws', 'gcloud'];
  const boundaryBefore = '(?:^|[\\s;&|()<>])';
  const boundaryAfter = '(?=[\\s;&|()<>\'"]|$)';

  const matches = known.map((c) => {
    const escaped = c
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+');
    const match = new RegExp(`${boundaryBefore}${escaped}${boundaryAfter}`).exec(cmd);
    return match ? { command: c, index: match.index } : null;
  }).filter(Boolean);

  return matches
    .filter((match) => !matches.some(other =>
      other !== match &&
      other.index === match.index &&
      other.command.startsWith(`${match.command} `)
    ))
    .sort((a, b) => a.index - b.index)
    .map((m) => m.command);
}

function isSpawnAgent(event) {
  return isFunctionCall(event) && event.payload?.name === 'spawn_agent';
}

function isWaitAgent(event) {
  return isFunctionCall(event) && event.payload?.name === 'wait_agent';
}

function isTaskComplete(event) {
  return event.type === 'event_msg' && event.payload?.type === 'task_complete';
}

function extractSpawnAgentTarget(event) {
  try {
    const args = JSON.parse(event.payload?.arguments || '{}');
    return args.target || null;
  } catch { return null; }
}

function extractWaitAgentTargets(event) {
  try {
    const args = JSON.parse(event.payload?.arguments || '{}');
    return args.targets || [];
  } catch { return []; }
}

function extractParentSessionId(payload = {}) {
  return payload.parent_thread_id
    || payload.forked_from_id
    || payload.source?.subagent?.thread_spawn?.parent_thread_id
    || null;
}

function extractUserMessageText(event) {
  if (event.type === 'event_msg' && event.payload?.message) {
    return event.payload.message;
  }
  return null;
}

function extractConversationText(event) {
  if (event.type === 'response_item' && event.payload?.type === 'message') {
    const content = event.payload?.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item?.type === 'input_text' && item?.text) return item.text;
      }
    }
  }
  return null;
}

function extractToolCallInfo(event) {
  return {
    name: event.payload?.name || 'unknown',
    arguments: (event.payload?.arguments || '').slice(0, 200),
    callId: event.payload?.call_id || '',
  };
}

function isRelevantDate(date) {
  if (RUN_ALL) return true;
  if (RUN_DATE_ONLY) return date === TARGET_DATE;
  return date !== 'unknown' && date >= analysisStart.toISOString().slice(0, 10) && date <= TARGET_DATE;
}

function ensureSession(map, sessionId, file) {
  if (!map[sessionId]) {
    map[sessionId] = {
      sessionId,
      file,
      projectName: 'unknown',
      models: {},
      date: null,

      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,

      eventCount: 0,
      tokenEventCount: 0,

      tools: {},
      commands: {},
      skills: {},
      files: {},
      steps: [],
      turns: [],
      _currentTurn: null,
      _toolAccum: {},
      _commandAccum: {},
      _skillAccum: {},
      _fileAccum: {},
      _toolCallAccum: [],
      _commentaryAccum: [],
      _isAssessment: false,
      isSubagent: false,
      forkedFromId: null,
      parentSessionId: null,
      agentNickname: null,
      agentRole: null,
      forkCutoff: null,
      _contextByDate: {},
      prevCumulativeTotal: null,
      prevInput: 0,
      prevCached: 0,
      prevOutput: 0,
      prevReasoning: 0,
    };
  }

  return map[sessionId];
}

// NOTE: tools/commands/skills/files detected via accumulateStepContext() only get
// merged into a turn's tools/commands/skills/files when a token_count event arrives
// (see handleTokenCount). If a turn ends (a new user message starts the
// next turn, or the file ends) before any token_count event occurs in it,
// whatever was accumulated used to be silently discarded when the
// accumulators were reset. This flushes any pending counts into the
// current turn first, so nothing is lost. (Detailed per-call info in
// _toolCallAccum / _commentaryAccum still requires a token_count event to
// be attached to a step, since steps are inherently tied to token usage.)
function flushPendingContext(session, targetTurn) {
  const turn = targetTurn || session._currentTurn;
  if (turn) {
    mergeCounts(turn.tools, session._toolAccum);
    mergeCounts(turn.commands, session._commandAccum);
    mergeCounts(turn.skills, session._skillAccum);
    mergeCounts(turn.files, session._fileAccum);
  }
  session._toolAccum = {};
  session._commandAccum = {};
  session._commandSeqAccum = [];
  session._skillAccum = {};
  session._fileAccum = {};
}

function startNewTurn(session, userMessage, date, timestamp) {
  // Capture whichever turn was active before this one starts. Anything
  // accumulated since that turn's last token_count belongs there. If there
  // was no previous turn at all (this is the very first turn in the
  // session), there's nothing earlier to attach it to, so it gets folded
  // into the new turn instead — that still beats silently dropping it.
  const previousTurn = session._currentTurn;

  const turn = {
    turnIndex: session.turns.length + 1,
    timestamp: timestamp || null,
    date,
    projectName: session.projectName || 'unknown',
    model: session._currentModel || 'unknown',
    userMessage: truncateText(userMessage || '', 1000),
    commentary: [],
    steps: [],
    subagentRefs: [],
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    reasoningOutputTokens: 0, totalTokens: 0, costUsd: 0,
    calls: 0, tools: {}, commands: {}, skills: {}, files: {},
  };

  flushPendingContext(session, previousTurn || turn);

  session.turns.push(turn);
  session._currentTurn = turn;
  session._currentModel = null;
  session._toolCallAccum = [];
  session._commentaryAccum = [];
  return turn;
}

function addAgentCommentary(session, message) {
  if (!message) return;
  const turn = session._currentTurn;
  if (turn) {
    if (!turn.commentary) turn.commentary = [];
    turn.commentary.push(truncateText(message, 500));
  }
}

function addToolCallToCurrentStep(session, info) {
  if (!session._toolCallAccum) session._toolCallAccum = [];
  session._toolCallAccum.push(info);
}

function addSubagentRef(session, targetSessionId) {
  const turn = session._currentTurn;
  if (!turn) return;
  if (!turn.subagentRefs) turn.subagentRefs = [];
  if (turn.subagentRefs.find(r => r.subagentSessionId === targetSessionId)) return;
  turn.subagentRefs.push({
    subagentSessionId: targetSessionId,
    role: 'worker',
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
  });
}

function accumulateStepContext(session, tools, commands, skills, files, commandSequence = commands) {
  if (!session._toolAccum) session._toolAccum = {};
  if (!session._commandAccum) session._commandAccum = {};
  if (!session._skillAccum) session._skillAccum = {};
  if (!session._fileAccum) session._fileAccum = {};
  if (!session._commandSeqAccum) session._commandSeqAccum = [];
  for (const t of tools) addCount(session._toolAccum, t);
  for (const c of commands) addCount(session._commandAccum, c);
  for (const s of skills) addCount(session._skillAccum, s);
  for (const f of [...new Set(files)]) addCount(session._fileAccum, f);
  session._commandSeqAccum.push(...commandSequence);
}

function handleTokenCount(event, session, day, date, detectedModel) {
  const usage = extractLastUsage(event);
  if (!usage) return;

  const input = usage.input_tokens || 0;
  const cached = usage.cached_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const reasoning = usage.reasoning_output_tokens || 0;
  const total = usage.total_tokens || input + output;
  const contextWindowTokens = Number(event.payload?.info?.model_context_window || 0);
  if (contextWindowTokens > 0) {
    const contextUsedTokens = Math.max(0, Number(total || 0) - reasoning);
    session._contextByDate[date] = {
      contextWindowTokens,
      contextUsedTokens,
      contextRemainingPercent: Math.trunc(
        Math.max(0, Math.min(100, 100 - (contextUsedTokens / contextWindowTokens) * 100)),
      ),
    };
  }
  const model = (detectedModel && detectedModel !== 'unknown') || session._currentModel || (session._currentTurn?.model) || 'unknown';
  const costUsd = estimateCostUsd({ inputTokens: input, cachedInputTokens: cached, outputTokens: output, model });

  const mc = session.modelCosts || (session.modelCosts = {});
  if (!mc[model]) mc[model] = { count: 0, costUsd: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  mc[model].count += 1;
  mc[model].costUsd += costUsd;
  mc[model].inputTokens += input;
  mc[model].cachedInputTokens += cached;
  mc[model].outputTokens += output;

  if (day) {
    day.inputTokens += input; day.cachedInputTokens += cached;
    day.outputTokens += output; day.reasoningOutputTokens += reasoning;
    day.totalTokens += total; day.tokenEventCount += 1;
  }
  session.tokenEventCount += 1;
  session.inputTokens += input;
  session.cachedInputTokens += cached;
  session.outputTokens += output;
  session.reasoningOutputTokens += reasoning;
  session.costUsd = (session.costUsd || 0) + costUsd;
  session.totalTokens += total;

  const turn = session._currentTurn || startNewTurn(session, '', date, event.timestamp);
  turn.model = model;

  turn.inputTokens += input; turn.cachedInputTokens += cached;
  turn.effectiveInputTokens = (turn.effectiveInputTokens || 0) + (input - cached);
  turn.outputTokens += output; turn.reasoningOutputTokens += reasoning;
  turn.totalTokens += total; turn.costUsd = (turn.costUsd || 0) + costUsd;
  turn.calls = (turn.calls || 0) + 1;

  const toolAccum = session._toolAccum || {};
  const commandAccum = session._commandAccum || {};
  const commandSeqAccum = session._commandSeqAccum || [];
  const skillAccum = session._skillAccum || {};
  const fileAccum = session._fileAccum || {};
  if (day) {
    mergeCounts(day.tools, toolAccum);
    mergeCounts(day.commands, commandAccum);
    mergeCounts(day.skills, skillAccum);
    mergeCounts(day.files, fileAccum);
  }
  mergeCounts(session.tools, toolAccum);
  mergeCounts(session.commands, commandAccum);
  mergeCounts(session.skills, skillAccum);
  mergeCounts(session.files, fileAccum);
  mergeCounts(turn.tools, toolAccum);
  mergeCounts(turn.commands, commandAccum);
  mergeCounts(turn.skills, skillAccum);
  mergeCounts(turn.files, fileAccum);

  const step = {
    stepIndex: (turn.steps?.length || 0) + 1,
    timestamp: event.timestamp || null,
    date, model, costUsd, calls: 1,
    inputTokens: input, cachedInputTokens: cached,
    effectiveInputTokens: input - cached,
    outputTokens: output, reasoningOutputTokens: reasoning,
    totalTokens: total, cacheRatio: input > 0 ? cached / input : 0,
    tools: { ...toolAccum }, commands: { ...commandAccum }, skills: { ...skillAccum }, files: { ...fileAccum },
    commandSequence: [...commandSeqAccum],
    role: 'codex',
    message: '',
    toolCalls: [...(session._toolCallAccum || [])],
    commentary: [...(session._commentaryAccum || [])],
  };

  turn.steps.push(step);

  if (!session.steps) session.steps = [];
  session.steps.push({ ...step, stepIndex: session.steps.length + 1 });

  session._toolAccum = {};
  session._commandAccum = {};
  session._commandSeqAccum = [];
  session._skillAccum = {};
  session._fileAccum = {};
  session._toolCallAccum = [];
  session._commentaryAccum = [];
}

const daily = {};
const sessions = {};
const _childToParent = {};
const files = walk(CODEX_DIR);
const seenDedupKeys = new Set();

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const sessionId = getSessionId(file);
  const session = ensureSession(sessions, sessionId, file);

  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    if (event.type === 'session_meta') {
      session.isSubagent = event.payload?.thread_source === 'subagent';
      session.threadSource = event.payload?.thread_source || null;
      session.forkedFromId = event.payload?.forked_from_id || session.forkedFromId;
      session.parentSessionId = extractParentSessionId(event.payload) || session.parentSessionId;
      session.agentNickname = event.payload?.agent_nickname
        || event.payload?.source?.subagent?.thread_spawn?.agent_nickname
        || null;
      session.agentRole = event.payload?.agent_role || 'worker';
      if (session.forkedFromId && event.timestamp) {
        session.forkCutoff = new Date(new Date(event.timestamp).getTime() + 5000).toISOString();
      }
      if (event.payload?.model) session._currentModel = event.payload.model;
      continue;
    }

    const date = getDateKey(event, file);
    const isTarget = isRelevantDate(date);
    const day = isTarget ? ensureDay(daily, date) : null;

    if (!session.date) session.date = date;
    if (day) day.eventCount += 1;

    if (session.forkCutoff && event.timestamp && event.timestamp < session.forkCutoff) continue;

    if (isFunctionCallOutput(event)) {
      continue;
    }

    const detectedWorkdir = extractWorkdir(event);
    const detectedProjectName = projectNameFromPath(detectedWorkdir) || 'unknown';
    if (detectedProjectName && detectedProjectName !== 'unknown') session.projectName = detectedProjectName;

    const detectedModel = extractModel(event);
    if (detectedModel && detectedModel !== 'unknown') {
      addCount(session.models, detectedModel);
      session._currentModel = detectedModel;
    }

    if (isUserMessage(event)) {
      const text = extractUserMessageText(event) || extractConversationText(event) || '';
      if (!session._isAssessment && !session.turns.length && isAssessmentPrompt(text)) {
        session._isAssessment = true;
      }
      startNewTurn(session, text, date, event.timestamp);
      accumulateStepContext(session, [], [], detectSkills(text), []);
      continue;
    }

    if (isTokenCount(event)) {
      const info = event.payload?.info;
      if (info?.total_token_usage && session.forkedFromId) {
        const t = info.total_token_usage;
        const dedupKey = `fork:${session.forkedFromId}:${t.total_tokens || 0}:${t.input_tokens || 0}:${t.cached_input_tokens || 0}:${t.output_tokens || 0}:${t.reasoning_output_tokens || 0}`;
        if (seenDedupKeys.has(dedupKey)) continue;
        seenDedupKeys.add(dedupKey);
      }

      handleTokenCount(event, session, day, date, detectedModel);

      const rateLimit = extractRateLimit(event);
      if (day && typeof rateLimit === 'number') {
        day.maxRateLimitUsedPercent =
          day.maxRateLimitUsedPercent === null
            ? rateLimit
            : Math.max(day.maxRateLimitUsedPercent, rateLimit);
      }
      continue;
    }

    if (isAgentMessage(event)) {
      const msg = event.payload?.message || '';
      addAgentCommentary(session, msg);
      continue;
    }

    if (isSpawnAgent(event)) {
      const target = extractSpawnAgentTarget(event);
      if (target) addSubagentRef(session, target);
    }

    if (isWaitAgent(event)) {
      const targets = extractWaitAgentTargets(event);
      for (const target of targets) {
        if (target) {
          addSubagentRef(session, target);
          _childToParent[target] = session.sessionId;
        }
      }
    }

    if (isFunctionCall(event)) {
      addToolCallToCurrentStep(session, extractToolCallInfo(event));
      const rawName = event.payload?.name || '';
      const mappedTool = toolNameMap[rawName] || rawName;
      let commands = [];
      let skills = [];
      let filePath = null;
      let rawCommand = '';
      try {
        const args = JSON.parse(event.payload?.arguments || '{}');
        filePath = args.file_path || args.path || null;
        rawCommand = args.command || args.cmd || '';
        if (rawName === 'exec_command' && rawCommand) {
          commands = detectSubCommands(String(rawCommand));
          skills = detectSkillReads(String(rawCommand));
        }
      } catch {}
      accumulateStepContext(session, [mappedTool], commands, skills, filePath ? [filePath] : []);
      continue;
    }

    if (isPatchApplyEnd(event)) {
      // NOTE: previously any patch_apply_end event was counted as a
      // successful file edit, even if the patch actually failed
      // (payload.success === false). Failed patches don't change any file
      // and shouldn't be counted as an Edit / file modification.
      if (event.payload?.success === false) continue;
      const changes = event.payload?.changes;
      const filePaths = typeof changes === 'object' && changes ? Object.keys(changes) : [];
      accumulateStepContext(session, ['Edit'], [], [], filePaths);
      continue;
    }

    accumulateStepContext(session, [], [], [], []);
  }

  // Flush any tools/skills/files accumulated after the last token_count
  // event in this file (e.g. trailing exec_command/patch_apply_end with no
  // following token_count before the log ends), so it isn't silently lost.
  flushPendingContext(session);
}

const days = Object.values(daily)
  .filter((day) => day.date !== 'unknown')
  .filter((day) => RUN_ALL || (!RUN_DATE_ONLY && isDateInRange(day.date, { start: analysisStart, end: analysisEnd })) || day.date === TARGET_DATE)
  .sort((a, b) => a.date.localeCompare(b.date));

const totals = days.reduce(
  (acc, day) => {
    acc.inputTokens += day.inputTokens;
    acc.cachedInputTokens += day.cachedInputTokens;
    acc.outputTokens += day.outputTokens;
    acc.reasoningOutputTokens += day.reasoningOutputTokens;
    acc.totalTokens += day.totalTokens;
    acc.eventCount += day.eventCount;
    acc.tokenEventCount += day.tokenEventCount;

    for (const [key, value] of Object.entries(day.tools)) {
      addCount(acc.tools, key, value);
    }

    for (const [key, value] of Object.entries(day.commands || {})) {
      addCount(acc.commands, key, value);
    }

    for (const [key, value] of Object.entries(day.skills)) {
      addCount(acc.skills, key, value);
    }

    return acc;
  },
  {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    eventCount: 0,
    tokenEventCount: 0,
    tools: {},
    commands: {},
    skills: {},
  },
);
for (const day of days) {
  day.effectiveInputTokens = day.inputTokens - day.cachedInputTokens;

  day.cacheRatio =
    day.inputTokens > 0 ? day.cachedInputTokens / day.inputTokens : 0;
}

const sessionList = Object.values(sessions)
  .filter((session) => RUN_ALL || session.tokenEventCount > 0)
  .map((session) => {
    session.effectiveInputTokens =
      session.inputTokens - session.cachedInputTokens;

    session.cacheRatio =
      session.inputTokens > 0
        ? session.cachedInputTokens / session.inputTokens
        : 0;

    for (const turn of session.turns || []) {
      turn.projectName = turn.projectName || session.projectName || 'unknown';
      turn.effectiveInputTokens = turn.inputTokens - turn.cachedInputTokens;
      turn.cacheRatio = turn.inputTokens > 0 ? turn.cachedInputTokens / turn.inputTokens : 0;
      turn.costUsd = Number((turn.costUsd || 0).toFixed(6));
      turn.calls = turn.calls || (turn.steps || []).length;
    }

    delete session._toolAccum;
    delete session._commandAccum;
    delete session._commandSeqAccum;
    delete session._skillAccum;
    delete session._fileAccum;
    delete session._toolCallAccum;
    delete session._commentaryAccum;
    delete session._currentTurn;

    return session;
  });

totals.effectiveInputTokens = totals.inputTokens - totals.cachedInputTokens;

totals.cacheRatio =
  totals.inputTokens > 0 ? totals.cachedInputTokens / totals.inputTokens : 0;

totals.sessionCount = sessionList.length;

const sortedSessions = sessionList.sort((a, b) => b.totalTokens - a.totalTokens);

// Build sessionId→session lookup for subagent ref resolution
const _sessionById = {};
for (const s of sortedSessions) {
  _sessionById[s.sessionId] = s;
  s.parentSessionId = s.parentSessionId || _childToParent[s.sessionId] || null;
  s.sessionType = s._isAssessment ? 'assessment' : 'normal';
}
for (const s of sortedSessions) {
  const parent = _sessionById[s.parentSessionId];
  if (s.isSubagent && parent?.sessionType === 'assessment') {
    s.sessionType = 'assessment';
  }
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit']);

function burnReasons(session) {
  const deductions = [];
  const effectiveInput = session.effectiveInputTokens ?? Math.max(0, (session.inputTokens || 0) - (session.cachedInputTokens || 0));
  const commands = aggregateTurnCounts(session, 'commands');
  const tools = aggregateTurnCounts(session, 'tools');
  const edits = tools.Edit || 0;
  const searchCount = (commands.rg || 0) + (commands.sed || 0) + (commands.cat || 0);
  const testCount = (commands['go test'] || 0) + (commands['npm test'] || 0) + (commands['pnpm test'] || 0) + (commands['yarn test'] || 0);
  const verificationCount = testCount + (commands['yarn build'] || 0) + (commands['yarn lint'] || 0);
  const searchPerEdit = searchCount / Math.max(1, edits);
  const testPerEdit = testCount / Math.max(1, edits);
  const retryRun = longestVerificationRetryRun(session);
  const add = (label, level, evidence, logic) => {
    deductions.push({ label, level, points: deductionPoints(label, level), evidence, logic, levels: deductionLevels(label), role: 'primary' });
  };

  if (effectiveInput >= 75000) add('Context Heavy', effectiveInput >= 300000 ? 'high' : effectiveInput >= 150000 ? 'medium' : 'low', `effective input ${fmtInt(effectiveInput)}; low >= 75,000, medium >= 150,000, high >= 300,000`, 'Uncached input is high.');
  if (verificationCount >= 8 && testCount < 5) add('High Verification Activity', verificationCount >= 20 ? 'high' : 'medium', `verify commands ${fmtInt(verificationCount)}`, 'Counts test, build, and lint commands when tests alone are not high.');
  if (searchCount >= 10 && searchPerEdit >= 10) add('Search Heavy / Low Edit', searchPerEdit >= 25 ? 'high' : 'medium', `search ${fmtInt(searchCount)} (rg ${fmtInt(commands.rg || 0)}, sed ${fmtInt(commands.sed || 0)}, cat ${fmtInt(commands.cat || 0)}), edits ${fmtInt(edits)}, ratio ${searchPerEdit.toFixed(1)}:1`, 'Flags many search/read commands with few edits.');
  if (testCount >= 5 && testPerEdit >= 5) add('Test Heavy / Low Edit', testPerEdit >= 10 ? 'high' : 'medium', `tests ${fmtInt(testCount)} (go ${fmtInt(commands['go test'] || 0)}, npm ${fmtInt(commands['npm test'] || 0)}, pnpm ${fmtInt(commands['pnpm test'] || 0)}, yarn ${fmtInt(commands['yarn test'] || 0)}), edits ${fmtInt(edits)}, ratio ${testPerEdit.toFixed(1)}:1`, 'Flags many test commands with few edits.');
  if (retryRun.length >= 3) add(
    'Repeated Rework',
    retryRun.length >= 6 ? 'high' : retryRun.length >= 4 ? 'medium' : 'low',
    `longest verification retry run ${fmtInt(retryRun.length)} (${retryRun.command || retryRun.family})`,
    'Flags consecutive test/build/lint retries without an edit or different command in between.'
  );

  return deductions;
}

function primaryBurnReason(deductions) {
  const priority = [
    'Repeated Rework',
    'Search Heavy / Low Edit',
    'Test Heavy / Low Edit',
    'Context Heavy',
    'High Verification Activity',
  ];
  return priority.map(label => deductions.find(item => item.label === label && (item.points || 0) > 0)).find(Boolean) || null;
}

function fmtInt(value) {
  return Math.round(Number(value || 0)).toLocaleString('en-US');
}

function ratio(left, right) {
  return Math.round(Number(left || 0) / Math.max(1, Number(right || 0)));
}

function verificationFamily(command) {
  if (['go test', 'npm test', 'pnpm test', 'yarn test'].includes(command)) return 'test';
  if (command === 'yarn build') return 'build';
  if (command === 'yarn lint') return 'lint';
  return '';
}

function stepCommandSequence(step) {
  if (Array.isArray(step.commandSequence) && step.commandSequence.length) return step.commandSequence;
  return Object.entries(step.commands || {}).flatMap(([command, count]) => Array(count).fill(command));
}

function longestVerificationRetryRun(session) {
  let best = { length: 0, family: '', command: '' };
  let prev = '';
  let run = 0;
  let runCommands = [];

  for (const turn of (session.turns || [])) {
    for (const step of (turn.steps || [])) {
      if (Object.keys(step.tools || {}).some(t => EDIT_TOOLS.has(t))) {
        prev = '';
        run = 0;
        runCommands = [];
      }
      for (const command of stepCommandSequence(step)) {
        const family = verificationFamily(command);
        if (!family) {
          prev = '';
          run = 0;
          runCommands = [];
          continue;
        }
        runCommands = family === prev ? [...runCommands, command] : [command];
        run = runCommands.length;
        prev = family;
        if (run > best.length) {
          const uniqueCommands = [...new Set(runCommands)];
          best = { length: run, family, command: uniqueCommands.length === 1 ? uniqueCommands[0] : uniqueCommands.join(', ') };
        }
      }
    }
  }

  return best;
}

function deductionPoints(label, level) {
  const weights = {
    'Context Heavy': { high: 6, medium: 3, low: 1 },
    'High Verification Activity': { high: 8, medium: 4, low: 1 },
    'Search Heavy / Low Edit': { high: 12, medium: 6, low: 2 },
    'Test Heavy / Low Edit': { high: 10, medium: 5, low: 2 },
    'Repeated Rework': { high: 20, medium: 10, low: 5 },
  };
  return weights[label]?.[level] ?? 1;
}

function deductionLevels(label) {
  const levels = {
    'Context Heavy': [
      ['low', '>= 75,000 effective input tokens'],
      ['medium', '>= 150,000 effective input tokens'],
      ['high', '>= 300,000 effective input tokens'],
    ],
    'High Verification Activity': [
      ['medium', '>= 8 build/lint/test commands when tests < 5'],
      ['high', '>= 20 build/lint/test commands when tests < 5'],
    ],
    'Search Heavy / Low Edit': [
      ['medium', '>= 10 search/read commands and >= 10:1 search/edit ratio'],
      ['high', '>= 10 search/read commands and >= 25:1 search/edit ratio'],
    ],
    'Test Heavy / Low Edit': [
      ['medium', '>= 5 test commands and >= 5:1 test/edit ratio'],
      ['high', '>= 5 test commands and >= 10:1 test/edit ratio'],
    ],
    'Repeated Rework': [
      ['low', '>= 3 consecutive verification commands'],
      ['medium', '>= 4 consecutive verification commands'],
      ['high', '>= 6 consecutive verification commands'],
    ],
  };
  return (levels[label] || []).map(([level, text]) => ({ level, text }));
}

function aggregateTurnCounts(session, field) {
  const result = {};
  for (const turn of (session.turns || [])) {
    mergeCounts(result, turn[field] || {});
  }
  return result;
}

function countRepeatedTurnCommands(turn) {
  return Object.values(turn.commands || {}).filter(count => count >= 3).length;
}

function buildBurnReport(allSessions) {
  const sessions = allSessions.filter(s => !s.isSubagent && (s.costUsd || 0) > 0);
  const topSessions = sessions
    .map((s) => {
      const effectiveInput = s.effectiveInputTokens ?? Math.max(0, (s.inputTokens || 0) - (s.cachedInputTokens || 0));
      const tools = aggregateTurnCounts(s, 'tools');
      const commands = aggregateTurnCounts(s, 'commands');
      const deductions = burnReasons(s);
      const primaryReason = primaryBurnReason(deductions);
      const score = Math.max(0, 100 - deductions.reduce((sum, item) => sum + item.points, 0));
      return {
        sessionId: s.sessionId,
        date: s.date || (s.turns || [])[0]?.date || null,
        projectName: s.projectName || 'unknown',
        costUsd: Number((s.costUsd || 0).toFixed(6)),
        totalTokens: s.totalTokens || 0,
        effectiveInputTokens: effectiveInput,
        outputTokens: s.outputTokens || 0,
        cacheRatio: s.cacheRatio || 0,
        turns: (s.turns || []).length,
        tools,
        commands,
        score,
        primaryReason,
        deductions,
      };
    })
    .filter(s => s.deductions.length > 0 && s.score < 100)
    .sort((a, b) => a.score - b.score || b.costUsd - a.costUsd)
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    totalCostUsd: Number(sessions.reduce((sum, s) => sum + (s.costUsd || 0), 0).toFixed(6)),
    totalTokens: sessions.reduce((sum, s) => sum + (s.totalTokens || 0), 0),
    topSessions,
  };
}

function writeBurnReport(sessions, filename) {
  const report = buildBurnReport(sessions);
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(report, null, 2));
  return report;
}

function emptyOptimizeReport() {
  return {
    generatedAt: new Date().toISOString(),
    healthScore: 100,
    totalSavingsTokens: 0,
    findingCount: 0,
    findings: [],
  };
}

function writeOptimizeReport(filename) {
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(emptyOptimizeReport(), null, 2));
}

fs.mkdirSync(DATA_DIR, { recursive: true });

writeOptimizeReport('codex-optimize.json');
writeBurnReport(sortedSessions, 'codex-burn.json');
console.log('Optimize: Cost Lens only');

// ── Per-period optimize analysis ──────────────────────────────────────
function filterSessionsByDateRange(sessions, startDate, endDate) {
  return sessions.filter(s => s.date && s.date >= startDate && s.date <= endDate);
}

const periods = (() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const d7 = new Date(now); d7.setDate(d7.getDate() - 6);
  const d30 = new Date(now); d30.setDate(d30.getDate() - 29);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    today: { start: today, end: today },
    yesterday: { start: yesterday.toISOString().slice(0, 10), end: yesterday.toISOString().slice(0, 10) },
    '7days': { start: d7.toISOString().slice(0, 10), end: today },
    '30days': { start: d30.toISOString().slice(0, 10), end: today },
    month: { start: monthStart.toISOString().slice(0, 10), end: today },
  };
})();

for (const [period, range] of Object.entries(periods)) {
  const filtered = filterSessionsByDateRange(sortedSessions, range.start, range.end);
  if (filtered.length === 0) {
    writeOptimizeReport(`codex-optimize-${period}.json`);
    fs.writeFileSync(path.join(DATA_DIR, `codex-burn-${period}.json`), JSON.stringify(buildBurnReport([]), null, 2));
    continue;
  }
  writeOptimizeReport(`codex-optimize-${period}.json`);
  writeBurnReport(filtered, `codex-burn-${period}.json`);
  console.log(`  ${period}: Cost Lens from ${filtered.length} sessions`);
}

function countListValues(values) {
  const result = {};
  for (const value of values || []) {
    addCount(result, value);
  }
  return result;
}

function normalizeCountMap(value) {
  if (Array.isArray(value)) return countListValues(value);
  return value || {};
}

function buildTurnMetric(session, turn) {
  const projectName = turn.projectName || session.projectName || 'unknown';
  const tools = normalizeCountMap(turn.tools);
  const commands = normalizeCountMap(turn.commands);
  const skills = normalizeCountMap(turn.skills);
  const files = normalizeCountMap(turn.files);

  return finalizeMetricBucket(createMetricBucket({
    projectName,
    sessionId: session.sessionId,
    turnIndex: turn.turnIndex,
    timestamp: turn.timestamp,
    date: turn.date,
    userMessagePreview: truncateText(turn.userMessage || '', 240),
    stepCount: (turn.steps || []).length,
    calls: turn.calls || (turn.steps || []).length,
    turns: 1,
    sessions: 0,
    inputTokens: turn.inputTokens || 0,
    cachedInputTokens: turn.cachedInputTokens || 0,
    effectiveInputTokens: turn.effectiveInputTokens ?? Math.max(0, (turn.inputTokens || 0) - (turn.cachedInputTokens || 0)),
    outputTokens: turn.outputTokens || 0,
    reasoningOutputTokens: turn.reasoningOutputTokens || 0,
    totalTokens: turn.totalTokens || 0,
    costUsd: turn.costUsd || 0,
    tools,
    commands,
    skills,
    files,
  }));
}

function buildPeriodAnalysis(date, allSessions) {
  const ranges = getPeriodRanges(date);
  const result = {};

  for (const range of ranges) {
    const daysInRange = dateRangeDays(range.start, range.end);
    const dailyMap = Object.fromEntries(
      daysInRange.map((day) => [day, createMetricBucket({ date: day })]),
    );

    const projectMap = {};
    const sessionMap = {};
    const turnRows = [];
    const skillMap = {};

    for (const session of allSessions) {
      const turnsInRange = (session.turns || []).filter((turn) => turn.date && isDateInRange(turn.date, range));
      if (!turnsInRange.length) continue;

      const projectName = session.projectName || turnsInRange[0]?.projectName || 'unknown';
      const sessionBucket = createMetricBucket({
        projectName,
        sessionId: session.sessionId,
        turns: turnsInRange.length,
        sessions: 1,
      });

      if (!projectMap[projectName]) {
        projectMap[projectName] = createMetricBucket({
          projectName,
          sessionsSet: new Set(),
          turns: 0,
        });
      }
      projectMap[projectName].sessionsSet.add(session.sessionId);

      for (const turn of turnsInRange) {
        const turnMetric = buildTurnMetric(session, turn);
        const dayKey = turnMetric.date;

        if (!dailyMap[dayKey]) dailyMap[dayKey] = createMetricBucket({ date: dayKey });

        addMetrics(dailyMap[dayKey], { ...turnMetric, turns: 1, sessions: 0 });
        addMetrics(sessionBucket, { ...turnMetric, turns: 0, sessions: 0 });
        addMetrics(projectMap[projectName], { ...turnMetric, turns: 1, sessions: 0 });

        for (const [skillName, count] of Object.entries(turnMetric.skills || {})) {
          if (!skillMap[skillName]) skillMap[skillName] = createMetricBucket({ skillName, count: 0 });
          skillMap[skillName].count += count;
          addMetrics(skillMap[skillName], { ...turnMetric, turns: 0, sessions: 0 });
        }


        turnRows.push(turnMetric);
      }

      sessionMap[session.sessionId] = finalizeMetricBucket(sessionBucket);
    }

    const dailyActivity = daysInRange.map((day) => finalizeMetricBucket(dailyMap[day] || createMetricBucket({ date: day })));

    const byProject = sortByCostDesc(Object.values(projectMap).map((project) => {
      project.sessions = project.sessionsSet?.size || 0;
      delete project.sessionsSet;
      return finalizeMetricBucket(project);
    }));

    const bySession = sortByCostDesc(Object.values(sessionMap).map(finalizeMetricBucket));
    const byTurn = sortByCostDesc(turnRows.map(finalizeMetricBucket));
    const bySkills = sortByCostDesc(Object.values(skillMap).map(finalizeMetricBucket));

    result[range.key] = {
      key: range.key,
      label: range.label,
      startDate: range.start.toISOString().slice(0, 10),
      endDate: new Date(range.end.getTime() - MS_PER_DAY).toISOString().slice(0, 10),
      dailyActivity,
      byProject,
      bySession,
      byTurn,
      bySkills,
    };
  }

  return result;
}

function serializeStep(step) {
  return {
    stepIndex: step.stepIndex,
    timestamp: step.timestamp,
    date: step.date,
    role: step.role,
    message: step.message || '',
    tools: step.tools || {},
    commands: step.commands || {},
    skills: step.skills || {},
    files: step.files || {},
    model: step.model,
    costUsd: step.costUsd || 0,
    calls: step.calls || 0,
    inputTokens: step.inputTokens || 0,
    cachedInputTokens: step.cachedInputTokens || 0,
    effectiveInputTokens: step.effectiveInputTokens || 0,
    outputTokens: step.outputTokens || 0,
    reasoningOutputTokens: step.reasoningOutputTokens || 0,
    totalTokens: step.totalTokens || 0,
    cacheRatio: step.cacheRatio || 0,
    toolCalls: step.toolCalls || [],
    commentary: step.commentary || [],
  };
}

function buildResultForDate(date) {
  const day = days.find((item) => item.date === date);
  const sessionsForDate = sortedSessions
    .map((session) => {
      const context = session._contextByDate?.[date];
      const parentTurns = [];
      for (const turn of (session.turns || [])) {
        if (turn.date !== date) continue;
        const filteredSteps = (turn.steps || [])
          .filter((step) => step.date === date)
          .map(serializeStep);
        const sumStep = (field) => filteredSteps.reduce((s, st) => s + (st[field] || 0), 0);
        parentTurns.push({
          turnIndex: turn.turnIndex,
          timestamp: turn.timestamp,
          date: turn.date,
          projectName: turn.projectName,
          model: turn.model,
          userMessage: turn.userMessage || '',
          inputTokens: sumStep('inputTokens'),
          cachedInputTokens: sumStep('cachedInputTokens'),
          effectiveInputTokens: sumStep('effectiveInputTokens'),
          outputTokens: sumStep('outputTokens'),
          reasoningOutputTokens: sumStep('reasoningOutputTokens'),
          totalTokens: sumStep('totalTokens'),
          cacheRatio: sumStep('totalTokens') > 0 ? sumStep('cachedInputTokens') / sumStep('totalTokens') : 0,
          costUsd: sumStep('costUsd'),
          calls: sumStep('calls'),
          tools: turn.tools || {},
          commands: turn.commands || {},
          skills: turn.skills || {},
          files: turn.files || {},
          commentary: turn.commentary || [],
          subagentRefs: (turn.subagentRefs || []).map(ref => {
            const sub = _sessionById[ref.subagentSessionId];
            return {
              subagentSessionId: ref.subagentSessionId,
              role: ref.role || 'worker',
              totalTokens: sub?.totalTokens || 0,
              costUsd: sub ? (sub.turns || []).reduce((s, t) => s + (t.costUsd || 0), 0) : 0,
              turns: sub ? (sub.turns || []).length : 0,
            };
          }),
          steps: filteredSteps,
        });

        // Flatten subagent turns after this parent turn
        const subagentRefs = turn.subagentRefs || [];
        for (const ref of subagentRefs) {
          const sub = _sessionById[ref.subagentSessionId];
          if (!sub || !sub.turns || !sub.turns.length) continue;
          const subTurns = sub.turns
            .map((st, i) => ({
              turnIndex: st.turnIndex,
              timestamp: st.timestamp,
              date: turn.date,
              projectName: st.projectName,
              model: st.model,
              userMessage: st.userMessage || '',
              inputTokens: st.inputTokens || 0,
              cachedInputTokens: st.cachedInputTokens || 0,
              effectiveInputTokens: st.effectiveInputTokens || 0,
              outputTokens: st.outputTokens || 0,
              reasoningOutputTokens: st.reasoningOutputTokens || 0,
              totalTokens: st.totalTokens || 0,
              cacheRatio: st.cacheRatio || 0,
              costUsd: st.costUsd || 0,
              calls: st.calls || 0,
              tools: st.tools || {},
              commands: st.commands || {},
              skills: st.skills || {},
              files: st.files || {},
              commentary: st.commentary || [],
              subagentRefs: [],
              steps: (st.steps || []).map(serializeStep),
              isSubagent: true,
              agentNickname: sub.agentNickname || null,
              agentRole: sub.agentRole || 'worker',
              baseContextTokens: i === 0 ? ((sub.turns?.[0]?.steps?.[0]?.effectiveInputTokens) || 0) : 0,
            }));
          parentTurns.push(...subTurns);
        }
      }
      const turns = parentTurns;

      if (!turns.length) return null;

      const bucket = createMetricBucket({
        sessionId: session.sessionId,
        file: session.file,
        projectName: session.projectName,
        models: session.models,
        modelCosts: session.modelCosts || {},
        date,
        turns: turns.length,
        sessions: 1,
        parentSessionId: session.parentSessionId || null,
        sessionType: session.sessionType || 'normal',
        agentNickname: session.agentNickname || null,
        agentRole: session.agentRole || null,
        baseContextTokens: (session.turns?.[0]?.steps?.[0]?.effectiveInputTokens) || 0,
        contextWindowTokens: context?.contextWindowTokens,
        contextUsedTokens: context?.contextUsedTokens,
        contextRemainingPercent: context?.contextRemainingPercent,
      });

      for (const turn of turns) {
        addMetrics(bucket, {
          inputTokens: turn.inputTokens,
          cachedInputTokens: turn.cachedInputTokens,
          effectiveInputTokens: turn.effectiveInputTokens,
          outputTokens: turn.outputTokens,
          reasoningOutputTokens: turn.reasoningOutputTokens,
          totalTokens: turn.totalTokens,
          calls: turn.calls,
          costUsd: turn.costUsd,
          tools: turn.tools,
          commands: turn.commands,
          skills: turn.skills,
          files: turn.files,
        });
      }

      finalizeMetricBucket(bucket);
      return {
        ...bucket,
        eventCount: 0,
        tokenEventCount: bucket.calls,
        turns,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));

  const dayTotals = day
    ? {
        inputTokens: day.inputTokens,
        cachedInputTokens: day.cachedInputTokens,
        effectiveInputTokens: day.effectiveInputTokens,
        outputTokens: day.outputTokens,
        reasoningOutputTokens: day.reasoningOutputTokens,
        totalTokens: day.totalTokens,
        eventCount: day.eventCount,
        tokenEventCount: day.tokenEventCount,
        maxRateLimitUsedPercent: day.maxRateLimitUsedPercent,
        tools: day.tools,
        commands: day.commands,
        skills: day.skills,
        files: day.files,
        cacheRatio: day.cacheRatio,
        sessionCount: sessionsForDate.length,
      }
    : {
        inputTokens: 0,
        cachedInputTokens: 0,
        effectiveInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        eventCount: 0,
        tokenEventCount: 0,
        maxRateLimitUsedPercent: null,
        tools: {},
        commands: {},
        skills: {},
        files: {},
        cacheRatio: 0,
        sessionCount: sessionsForDate.length,
      };

  return {
    generatedAt: new Date().toISOString(),
    sourceDir: CODEX_DIR,
    parsedJsonlFiles: files.length,
    targetDate: date,
    totals: dayTotals,
    days: day ? [day] : [],
    sessions: sessionsForDate,
  };
}

let outputDates = RUN_DATE_ONLY
  ? [TARGET_DATE]
  : days.map((day) => day.date);

if (RUN_FILL) {
  const missing = outputDates.filter((date) => !fs.existsSync(path.join(DATA_DIR, `${OUTPUT_FILE_PREFIX}-${date}.json`)));
  outputDates = missing.length > 0 ? missing : [TARGET_DATE];
}

const writtenFiles = [];

for (const date of outputDates) {
  const outputFile = path.join(DATA_DIR, `${OUTPUT_FILE_PREFIX}-${date}.json`);
  fs.writeFileSync(outputFile, JSON.stringify(buildResultForDate(date), null, 2));
  writtenFiles.push(outputFile);
}

console.log(
  RUN_ALL
    ? 'Mode: all history, write one file per day'
    : RUN_DATE_ONLY
      ? `Mode: single date ${TARGET_DATE}`
      : RUN_FILL
        ? `Mode: fill missing dates (last ${FILL_DAYS} days)`
        : 'Mode: last 7 days by default, write one file per day',
);
console.log(`Parsed ${files.length} JSONL files`);
console.log(`Wrote ${writtenFiles.length} file(s)`);
for (const file of writtenFiles) {
  console.log(`- ${file}`);
}
console.log(`Total tokens: ${totals.totalTokens.toLocaleString()}`);
console.log(`Input tokens: ${totals.inputTokens.toLocaleString()}`);
console.log(
  `Cached input tokens: ${totals.cachedInputTokens.toLocaleString()}`,
);
console.log(`Output tokens: ${totals.outputTokens.toLocaleString()}`);
