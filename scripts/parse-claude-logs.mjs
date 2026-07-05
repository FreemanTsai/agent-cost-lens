// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.
// Adapted for Claude Code logs (~/.claude/projects/) from parse-codex-logs.mjs

import fs from "fs";
import path from "path";

const CLAUDE_DIR = `${process.env.HOME}/.claude/projects`;
const OUTPUT_DIR = "public";
const DATA_DIR = path.join(OUTPUT_DIR, "data");
const OUTPUT_FILE_PREFIX = "claude-usage";

const args = process.argv.slice(2);
const RUN_ALL = args.includes("--all");
const RUN_DATE_ONLY = args.includes("--date-only");
const RUN_FILL = args.some((arg) => arg.startsWith("--fill"));
const FILL_DAYS = parseInt(
  args.find((arg) => arg.startsWith("--fill="))?.split("=")[1] || "30",
  10,
);
const TARGET_DATE =
  args.find((arg) => /^--date=\d{4}-\d{2}-\d{2}$/.test(arg))?.split("=")[1] ||
  new Date().toISOString().slice(0, 10);

const targetStart = new Date(`${TARGET_DATE}T00:00:00.000Z`);
const targetEnd = new Date(targetStart);
targetEnd.setUTCDate(targetEnd.getUTCDate() + 1);
const targetDatePath = TARGET_DATE.replaceAll("-", path.sep);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const analysisEnd = targetEnd;
const analysisStart = new Date(targetStart);
const defaultRangeDays = RUN_FILL ? FILL_DAYS : 6;
analysisStart.setUTCDate(analysisStart.getUTCDate() - defaultRangeDays);

// Claude model pricing (USD per 1M tokens)
const MODEL_PRICING_USD_PER_1M = {
  "claude-opus-4-8": { input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheWrite5m: 6.25, cacheRead: 0.5, output: 25 },
  "claude-sonnet-4-6": { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheRead: 0.1, output: 5 },
  "claude-opus-4": { input: 15, cacheWrite5m: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-4": { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-4": { input: 0.8, cacheWrite5m: 1, cacheRead: 0.08, output: 4 },
  "claude-opus-3-7": { input: 15, cacheWrite5m: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-3-7": { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-3-5": { input: 0.8, cacheWrite5m: 1, cacheRead: 0.08, output: 4 },
  "claude-opus-3-5": { input: 15, cacheWrite5m: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-3-5": { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  "claude-haiku-3": { input: 0.25, cacheWrite5m: 0.3125, cacheRead: 0.025, output: 1.25 },
  "claude-opus-3": { input: 15, cacheWrite5m: 18.75, cacheRead: 1.5, output: 75 },
  "claude-sonnet-3": { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
  default: { input: 3, cacheWrite5m: 3.75, cacheRead: 0.3, output: 15 },
};

function isFilePossiblyRelevant(full, stat) {
  if (RUN_ALL) return true;
  if (RUN_DATE_ONLY)
    return (
      full.includes(TARGET_DATE) ||
      full.includes(targetDatePath) ||
      (stat.mtime >= targetStart && stat.mtime < targetEnd)
    );
  return (
    full.includes(TARGET_DATE) ||
    full.includes(targetDatePath) ||
    (stat.mtime >= analysisStart && stat.mtime < analysisEnd)
  );
}

function walk(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const full = path.join(dir, name);

    if (entry.isDirectory()) {
      results.push(...walk(full));
    } else if (name.endsWith(".jsonl")) {
      const stat = fs.statSync(full);
      if (!isFilePossiblyRelevant(full, stat)) continue;
      results.push(full);
    }
  }

  return results;
}

function getDateKey(event, filePath) {
  // Claude Code events have a timestamp field at the top level
  const value = event.timestamp;
  if (value) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString().slice(0, 10);
    }
  }

  const match = filePath.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;

  return "unknown";
}

function ensureDay(map, date) {
  if (!map[date]) {
    map[date] = {
      date,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
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

function getPricingForModel(model) {
  const normalized = String(model || "").toLowerCase();
  const matchedKey = Object.keys(MODEL_PRICING_USD_PER_1M)
    .filter((key) => key !== "default")
    .find((key) => normalized.includes(key));
  return (
    MODEL_PRICING_USD_PER_1M[matchedKey] || MODEL_PRICING_USD_PER_1M.default
  );
}

function estimateCostUsd({
  inputTokens = 0,
  cachedInputTokens = 0,
  cacheCreationInputTokens = 0,
  outputTokens = 0,
  model = "unknown",
}) {
  const pricing = getPricingForModel(model);
  return (
    (inputTokens * pricing.input) / 1_000_000 +
    (cacheCreationInputTokens * pricing.cacheWrite5m) / 1_000_000 +
    (cachedInputTokens * pricing.cacheRead) / 1_000_000 +
    (outputTokens * pricing.output) / 1_000_000
  );
}

function findFirstStringByKeys(value, keys) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstStringByKeys(item, keys);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (keys.includes(lowerKey) && typeof child === "string" && child.trim()) {
      return child.trim();
    }
    const found = findFirstStringByKeys(child, keys);
    if (found) return found;
  }
  return null;
}

function extractModel(event) {
  // Claude Code stores model in the message field for assistant messages
  if (event.message?.model) return event.message.model;
  return (
    findFirstStringByKeys(event, [
      "model",
      "model_name",
      "modelid",
      "model_id",
    ]) || "unknown"
  );
}

function extractWorkdir(event) {
  return (
    findFirstStringByKeys(event, [
      "workdir",
      "cwd",
      "current_working_directory",
      "working_directory",
    ]) || null
  );
}

function projectNameFromPath(value) {
  if (!value) return null;
  const parts = String(value).split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || null;
}

// Claude Code project name comes from the directory path encoding:
// ~/.claude/projects/-Users-you-code-my-app/session.jsonl
// The folder name is the project path with slashes replaced by dashes
function projectNameFromFilePath(filePath) {
  // Find the project folder name (two levels up from the .jsonl file)
  const projectDir = path.basename(path.dirname(filePath));
  if (!projectDir || projectDir === "projects") return null;
  // Decode: leading dash, then dashes-as-separators
  // e.g. "-Users-you-code-my-app" → last segment "my-app"
  // Split on single dash that separates path components
  // The folder is URL-path-encoded: absolute path, slashes → dashes
  // We just want the last meaningful segment
  const parts = projectDir.split("-").filter(Boolean);
  return parts.at(-1) || null;
}

function createMetricBucket(extra = {}) {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
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
  target.cacheCreationInputTokens += source.cacheCreationInputTokens || 0;
  target.effectiveInputTokens +=
    source.effectiveInputTokens ??
    (source.inputTokens || 0);
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
  bucket.effectiveInputTokens = bucket.inputTokens;
  bucket.cacheRatio =
    bucket.totalTokens > 0 ? bucket.cachedInputTokens / bucket.totalTokens : 0;
  bucket.costUsd = Number((bucket.costUsd || 0).toFixed(6));
  return bucket;
}

function sortByCostDesc(items, limit = 30) {
  return items
    .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0))
    .slice(0, limit);
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

  const thisMonthStart = new Date(
    Date.UTC(todayStart.getUTCFullYear(), todayStart.getUTCMonth(), 1),
  );

  const sixMonthsStart = new Date(end);
  sixMonthsStart.setUTCMonth(sixMonthsStart.getUTCMonth() - 6);

  return [
    { key: "today", label: "Today", start: todayStart, end },
    { key: "7days", label: "7 Days", start: sevenDaysStart, end },
    { key: "30days", label: "30 Days", start: thirtyDaysStart, end },
    { key: "thisMonth", label: "This Month", start: thisMonthStart, end },
    { key: "6months", label: "6 Months", start: sixMonthsStart, end },
  ];
}

function isDateInRange(date, range) {
  const value = new Date(`${date}T00:00:00.000Z`);
  return value >= range.start && value < range.end;
}

function detectSkills(rawText) {
  const skills = [];

  for (const match of rawText.matchAll(
    /\[[^\]]+\]\([^)]*\/skills\/([^/()\s]+)\/SKILL\.md\)/gi,
  )) {
    skills.push(match[1]);
  }

  return skills;
}

function detectSkillReads(rawCommand) {
  if (!/\b(cat|less|sed|head|tail)\b/.test(rawCommand || "")) return [];
  return [
    ...String(rawCommand).matchAll(/\/skills\/([^/()"'\s]+)\/SKILL\.md/g),
  ].map((match) => match[1]);
}

function truncateText(text, max = 1000) {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return "";
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
  if (typeof value === "string") return truncateText(value, max);

  try {
    return truncateText(JSON.stringify(value), max);
  } catch {
    return truncateText(String(value), max);
  }
}

function looksLikeNoise(text) {
  if (!text) return true;
  if (text.length < 4) return true;
  if (
    /^(bash|read|edit|write|apply_patch|rg|sed|cat|git|npm|pnpm|yarn|docker)$/i.test(
      text,
    )
  )
    return true;
  if (/^[{}\[\],:"'\s0-9._/-]+$/.test(text)) return true;
  if (text.includes("cache_read_input_tokens")) return true;
  if (text.includes("cache_creation_input_tokens")) return true;
  if (text.includes("input_tokens")) return true;
  if (text.includes("output_tokens")) return true;
  if (/^(input_text|output_text|text|message|content)$/i.test(text))
    return true;
  return false;
}

function normalizeMessageRole(role) {
  const value = String(role || "").toLowerCase();
  if (value.includes("user")) return "user";
  if (value.includes("assistant")) return "assistant";
  if (value.includes("system")) return "system";
  if (value.includes("tool")) return "tool";
  return value || "unknown";
}

function extractTextFromContent(value, results = []) {
  if (typeof value === "string") {
    results.push(value);
    return results;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractTextFromContent(item, results);
    }
    return results;
  }

  if (value && typeof value === "object") {
    if (typeof value.text === "string") results.push(value.text);
    if (typeof value.content === "string") results.push(value.content);
    if (typeof value.output === "string") results.push(value.output);
    if (typeof value.message === "string") results.push(value.message);

    for (const [key, child] of Object.entries(value)) {
      const lowerKey = key.toLowerCase();
      if (["text", "content", "output", "message"].includes(lowerKey)) continue;
      extractTextFromContent(child, results);
    }
  }

  return results;
}

function getEventKind(event) {
  // Claude Code: role is top-level, type is in content blocks
  return [event.role, event.type].filter(Boolean).join(" / ");
}

function extractConversationEntries(event) {
  const entries = [];
  const eventKind = getEventKind(event);

  // Claude Code JSONL: each line has { role, content, ... }
  const msg = event.message || event;
  const role = normalizeMessageRole(msg.role || event.role);
  const content = msg.content || event.content;

  if (content) {
    const texts = extractTextFromContent(content, []);
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

    const textKey = text.replace(/^\[[^\]]+\]\s*/, "");
    if (seenText.has(textKey)) continue;

    seenText.add(textKey);
    result.push({ ...entry, text });
  }

  return result;
}

function stringifyCommandValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).join(" ");
  }

  if (value && typeof value === "object") {
    return safeStringify(value, 1000);
  }

  return String(value || "");
}

function extractToolEntriesFromObject(value, entries = [], context = {}) {
  if (!value || typeof value !== "object") return entries;

  if (Array.isArray(value)) {
    for (const item of value) {
      extractToolEntriesFromObject(item, entries, context);
    }
    return entries;
  }

  const possibleName =
    value.name ||
    value.tool ||
    value.tool_name ||
    value.call?.name ||
    value.function?.name;
  const possibleType = value.type || value.kind || value.subtype;
  const nextContext = {
    name: possibleName || context.name,
    type: possibleType || context.type,
  };

  for (const [key, child] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();

    if (["cmd", "command", "arguments", "args", "input"].includes(lowerKey)) {
      const text = stringifyCommandValue(child);
      if (!looksLikeNoise(text)) {
        entries.push({
          tool: nextContext.name || nextContext.type || "tool",
          field: lowerKey,
          text: truncateText(text, 1000),
        });
      }
    }

    if (["stdout", "stderr", "output", "result", "error"].includes(lowerKey)) {
      const text = stringifyCommandValue(child);
      if (!looksLikeNoise(text)) {
        entries.push({
          tool: nextContext.name || nextContext.type || "tool",
          field: lowerKey,
          text: truncateText(text, 1000),
        });
      }
    }

    if (
      ![
        "cmd",
        "command",
        "arguments",
        "args",
        "input",
        "stdout",
        "stderr",
        "output",
        "result",
        "error",
      ].includes(lowerKey)
    ) {
      extractToolEntriesFromObject(child, entries, nextContext);
    }
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
    const prefix =
      entry.role && entry.role !== "unknown" ? `[${entry.role}] ` : "";
    return `${prefix}${entry.text}`;
  });
}

function extractChatMessages(event) {
  return formatEntries(extractConversationEntries(event));
}

function extractCommands(event) {
  return formatEntries(extractToolEntries(event));
}

// Claude Code session ID is the JSONL filename without extension
function getSessionId(file) {
  const base = path.basename(file, ".jsonl");
  const uuidMatch = base.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (uuidMatch) return uuidMatch[1];
  return base;
}

// Claude Code: user messages have role === 'user'
function isUserMessage(event) {
  const msg = event.message || event;
  return msg.role === "user";
}

// Claude Code: assistant messages have role === 'assistant'
function isAssistantMessage(event) {
  const msg = event.message || event;
  return msg.role === "assistant";
}

// Claude Code: tool use blocks are in assistant content with type === 'tool_use'
function extractToolUseBlocks(event) {
  const msg = event.message || event;
  if (msg.role !== "assistant") return [];
  const content = Array.isArray(msg.content) ? msg.content : [];
  return content.filter((block) => block?.type === "tool_use");
}

// Claude Code: tool result blocks are in user content with type === 'tool_result'
function extractToolResultBlocks(event) {
  const msg = event.message || event;
  if (msg.role !== "user") return [];
  const content = Array.isArray(msg.content) ? msg.content : [];
  return content.filter((block) => block?.type === "tool_result");
}

// Claude Code usage is in message.usage for assistant messages
function extractUsage(event) {
  const msg = event.message || event;
  if (msg.role !== "assistant") return null;
  const usage = msg.usage;
  if (!usage) return null;
  return {
    input_tokens: usage.input_tokens || 0,
    // Claude Code uses cache_read_input_tokens for cache hits
    cached_input_tokens: usage.cache_read_input_tokens || 0,
    // cache_creation_input_tokens counts tokens written to cache (billed at higher rate)
    cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    output_tokens: usage.output_tokens || 0,
    // Claude Code doesn't have reasoning_output_tokens
    reasoning_output_tokens: 0,
    total_tokens:
      (usage.input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.output_tokens || 0),
  };
}

// Claude Code tool name mapping (to match Codex output format)
const toolNameMap = {
  Bash: "Bash",
  Read: "Read",
  Edit: "Edit",
  Write: "Edit",
  MultiEdit: "Edit",
  NotebookRead: "Read",
  NotebookEdit: "Edit",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  TodoRead: "Read",
  TodoWrite: "Edit",
  Glob: "Glob",
  Grep: "Grep",
  LS: "Glob",
  Agent: "Agent",
  Task: "Agent",
  computer: "Computer",
};

function mapClaudeTool(toolName) {
  return toolNameMap[toolName] || toolName;
}

function detectSubCommands(cmd) {
  if (!cmd) return [];
  const known = [
    "rg",
    "sed",
    "cat",
    "go test",
    "npm test",
    "pnpm test",
    "yarn test",
    "yarn build",
    "yarn lint",
    "npm",
    "yarn",
    "pnpm",
    "docker",
    "git",
    "node",
    "python3",
    "python",
    "npx",
    "tsx",
    "curl",
    "wget",
    "gh",
    "aws",
    "gcloud",
  ];
  const boundaryBefore = "(?:^|[\\s;&|()<>])";
  const boundaryAfter = "(?=[\\s;&|()<>'\"]|$)";

  const matches = known
    .map((c) => {
      const escaped = c
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\s+/g, "\\s+");
      const match = new RegExp(
        `${boundaryBefore}${escaped}${boundaryAfter}`,
      ).exec(cmd);
      return match ? { command: c, index: match.index } : null;
    })
    .filter(Boolean);

  return matches
    .filter(
      (match) =>
        !matches.some(
          (other) =>
            other !== match &&
            other.index === match.index &&
            other.command.startsWith(`${match.command} `),
        ),
    )
    .sort((a, b) => a.index - b.index)
    .map((m) => m.command);
}

function isRelevantDate(date) {
  if (RUN_ALL) return true;
  if (RUN_DATE_ONLY) return date === TARGET_DATE;
  return (
    date !== "unknown" &&
    date >= analysisStart.toISOString().slice(0, 10) &&
    date <= TARGET_DATE
  );
}

function ensureSession(map, sessionId, file) {
  if (!map[sessionId]) {
    map[sessionId] = {
      sessionId,
      file,
      projectName: projectNameFromFilePath(file) || "unknown",
      models: {},
      date: null,

      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,

      eventCount: 0,
      tokenEventCount: 0,

      costUsd: 0,

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
      agentNickname: null,
      agentRole: null,
      forkCutoff: null,
      prevCumulativeTotal: null,
      prevInput: 0,
      prevCached: 0,
      prevCacheCreation: 0,
      prevOutput: 0,
      prevReasoning: 0,
    };
  }

  return map[sessionId];
}

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
  const previousTurn = session._currentTurn;

  const turn = {
    turnIndex: session.turns.length + 1,
    timestamp: timestamp || null,
    date,
    projectName: session.projectName || "unknown",
    model: session._currentModel || "unknown",
    userMessage: truncateText(userMessage || "", 1000),
    commentary: [],
    steps: [],
    subagentRefs: [],
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    calls: 0,
    tools: {},
    commands: {},
    skills: {},
    files: {},
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
  if (turn.subagentRefs.find((r) => r.subagentSessionId === targetSessionId))
    return;
  turn.subagentRefs.push({
    subagentSessionId: targetSessionId,
    role: "worker",
    totalTokens: 0,
    costUsd: 0,
    turns: 0,
  });
}

function accumulateStepContext(
  session,
  tools,
  commands,
  skills,
  files,
  commandSequence = commands,
) {
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
  const usage = extractUsage(event);
  if (!usage) return;

  const input = usage.input_tokens || 0;
  const cached = usage.cached_input_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const output = usage.output_tokens || 0;
  const reasoning = usage.reasoning_output_tokens || 0;
  const total = usage.total_tokens || input + output;
  const model =
    (detectedModel && detectedModel !== "unknown") ||
    session._currentModel ||
    session._currentTurn?.model ||
    "unknown";
  const costUsd = estimateCostUsd({
    inputTokens: input,
    cachedInputTokens: cached,
    cacheCreationInputTokens: cacheCreation,
    outputTokens: output,
    model,
  });

  const mc = session.modelCosts || (session.modelCosts = {});
  if (!mc[model])
    mc[model] = {
      count: 0,
      costUsd: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      outputTokens: 0,
    };
  mc[model].count += 1;
  mc[model].costUsd += costUsd;
  mc[model].inputTokens += input;
  mc[model].cachedInputTokens += cached;
  mc[model].cacheCreationInputTokens += cacheCreation;
  mc[model].outputTokens += output;

  if (day) {
    day.inputTokens += input;
    day.cachedInputTokens += cached;
    day.cacheCreationInputTokens += cacheCreation;
    day.outputTokens += output;
    day.reasoningOutputTokens += reasoning;
    day.totalTokens += total;
    day.tokenEventCount += 1;
  }
  session.tokenEventCount += 1;
  session.inputTokens += input;
  session.cachedInputTokens += cached;
  session.cacheCreationInputTokens += cacheCreation;
  session.outputTokens += output;
  session.reasoningOutputTokens += reasoning;
  session.costUsd = (session.costUsd || 0) + costUsd;
  session.totalTokens += total;

  const turn =
    session._currentTurn || startNewTurn(session, "", date, event.timestamp);
  turn.model = model;

  turn.inputTokens += input;
  turn.cachedInputTokens += cached;
  turn.cacheCreationInputTokens += cacheCreation;
  turn.effectiveInputTokens = (turn.effectiveInputTokens || 0) + input;
  turn.outputTokens += output;
  turn.reasoningOutputTokens += reasoning;
  turn.totalTokens += total;
  turn.costUsd = (turn.costUsd || 0) + costUsd;
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
    date,
    model,
    costUsd,
    calls: 1,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheCreationInputTokens: cacheCreation,
    effectiveInputTokens: input,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: total,
    cacheRatio: total > 0 ? cached / total : 0,
    tools: { ...toolAccum },
    commands: { ...commandAccum },
    skills: { ...skillAccum },
    files: { ...fileAccum },
    commandSequence: [...commandSeqAccum],
    role: "claude",
    message: "",
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

// Extract user text from a Claude Code user message event
function extractUserMessageText(event) {
  const msg = event.message || event;
  if (msg.role !== "user") return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && block.text) return block.text;
    }
  }
  return null;
}

// Extract assistant text content for commentary
function extractAssistantText(event) {
  const msg = event.message || event;
  if (msg.role !== "assistant") return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((b) => b?.type === "text" && b.text)
      .map((b) => b.text);
    return texts.join("\n") || null;
  }
  return null;
}

const daily = {};
const sessions = {};
const _childToParent = {};
const files = walk(CLAUDE_DIR);
const seenDedupKeys = new Set();

for (const file of files) {
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const sessionId = getSessionId(file);
  const session = ensureSession(sessions, sessionId, file);

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    // Claude Code JSONL: each event is { type, role, message, timestamp, ... }
    // The actual message data may be in event.message or directly in event

    const date = getDateKey(event, file);
    const isTarget = isRelevantDate(date);
    const day = isTarget ? ensureDay(daily, date) : null;

    if (!session.date) session.date = date;
    if (day) day.eventCount += 1;

    const msg = event.message || event;
    if (isUserMessage(event)) {
      const text = extractUserMessageText(event) || "";
      const toolResults = extractToolResultBlocks(event);
      if (toolResults.length > 0 && !text) {
        accumulateStepContext(session, [], [], [], []);
        continue;
      }
    }

    // Detect workdir from event
    const detectedWorkdir = extractWorkdir(event);
    const detectedProjectName =
      projectNameFromPath(detectedWorkdir) ||
      projectNameFromFilePath(file) ||
      "unknown";
    if (detectedProjectName && detectedProjectName !== "unknown")
      session.projectName = detectedProjectName;

    // Detect model from assistant messages
    const detectedModel = extractModel(event);
    if (detectedModel && detectedModel !== "unknown") {
      addCount(session.models, detectedModel);
      session._currentModel = detectedModel;
    }

    // Handle user messages — start a new turn
    if (isUserMessage(event)) {
      const text = extractUserMessageText(event) || "";
      startNewTurn(session, text, date, event.timestamp);
      accumulateStepContext(session, [], [], detectSkills(text), []);
      continue;
    }

    // Handle assistant messages — extract token usage and tool calls
    if (isAssistantMessage(event)) {
      const usage = extractUsage(event);

      // Process tool_use blocks first (accumulate before token count)
      const toolUseBlocks = extractToolUseBlocks(event);
      for (const block of toolUseBlocks) {
        const rawName = block.name || "";
        const mappedTool = mapClaudeTool(rawName);
        let commands = [];
        let skills = [];
        let filePath = null;
        let rawCommand = "";

        const inputData = block.input || {};
        filePath = inputData.file_path || inputData.path || null;
        rawCommand = inputData.command || inputData.cmd || "";

        if (rawName === "Bash" && rawCommand) {
          commands = detectSubCommands(String(rawCommand));
          skills = detectSkillReads(String(rawCommand));
        }

        // Detect sub-agent spawning (Task tool in Claude Code)
        if (rawName === "Task" || rawName === "Agent") {
          const targetId = inputData.session_id || inputData.target || null;
          if (targetId) {
            addSubagentRef(session, targetId);
            _childToParent[targetId] = session.sessionId;
          }
        }

        addToolCallToCurrentStep(session, {
          name: rawName,
          arguments: JSON.stringify(inputData).slice(0, 200),
          callId: block.id || "",
        });

        accumulateStepContext(
          session,
          [mappedTool],
          commands,
          skills,
          filePath ? [filePath] : [],
        );
      }

      // Extract assistant text for commentary
      const assistantText = extractAssistantText(event);
      if (assistantText) {
        addAgentCommentary(session, assistantText);
      }

      // Process token usage (equivalent to token_count event in Codex)
      if (usage) {
        handleTokenCount(event, session, day, date, detectedModel);
      }

      continue;
    }

    accumulateStepContext(session, [], [], [], []);
  }

  // Flush any accumulated context after processing file
  flushPendingContext(session);
}

const days = Object.values(daily)
  .filter((day) => day.date !== "unknown")
  .filter(
    (day) =>
      RUN_ALL ||
      (!RUN_DATE_ONLY &&
        isDateInRange(day.date, { start: analysisStart, end: analysisEnd })) ||
      day.date === TARGET_DATE,
  )
  .sort((a, b) => a.date.localeCompare(b.date));

const totals = days.reduce(
  (acc, day) => {
    acc.inputTokens += day.inputTokens;
    acc.cachedInputTokens += day.cachedInputTokens;
    acc.cacheCreationInputTokens += day.cacheCreationInputTokens;
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
    cacheCreationInputTokens: 0,
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
  day.effectiveInputTokens = day.inputTokens;

  day.cacheRatio =
    day.totalTokens > 0 ? day.cachedInputTokens / day.totalTokens : 0;
}

const sessionList = Object.values(sessions)
  .filter((session) => RUN_ALL || session.tokenEventCount > 0)
  .map((session) => {
    session.effectiveInputTokens = session.inputTokens;

    session.cacheRatio =
      session.totalTokens > 0
        ? session.cachedInputTokens / session.totalTokens
        : 0;

    for (const turn of session.turns || []) {
      turn.projectName = turn.projectName || session.projectName || "unknown";
      turn.effectiveInputTokens = turn.inputTokens;
      turn.cacheRatio =
        turn.totalTokens > 0 ? turn.cachedInputTokens / turn.totalTokens : 0;
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

totals.effectiveInputTokens = totals.inputTokens;

totals.cacheRatio =
  totals.totalTokens > 0 ? totals.cachedInputTokens / totals.totalTokens : 0;

totals.sessionCount = sessionList.length;

const sortedSessions = sessionList.sort(
  (a, b) => b.totalTokens - a.totalTokens,
);

// Build sessionId→session lookup for subagent ref resolution
const _sessionById = {};
for (const s of sortedSessions) {
  _sessionById[s.sessionId] = s;
  s.parentSessionId = _childToParent[s.sessionId] || null;
  s.sessionType = s._isAssessment ? "assessment" : "normal";
}

const EDIT_TOOLS = new Set([
  "Edit",
  "Write",
  "FileEditTool",
  "FileWriteTool",
  "NotebookEdit",
  "MultiEdit",
]);

function burnReasons(session) {
  const deductions = [];
  const effectiveInput =
    session.effectiveInputTokens ??
    Math.max(0, (session.inputTokens || 0) - (session.cachedInputTokens || 0));
  const commands = aggregateTurnCounts(session, "commands");
  const tools = aggregateTurnCounts(session, "tools");
  const edits = tools.Edit || 0;
  const searchCount =
    (commands.rg || 0) + (commands.sed || 0) + (commands.cat || 0);
  const testCount =
    (commands["go test"] || 0) +
    (commands["npm test"] || 0) +
    (commands["pnpm test"] || 0) +
    (commands["yarn test"] || 0);
  const verificationCount =
    testCount + (commands["yarn build"] || 0) + (commands["yarn lint"] || 0);
  const searchPerEdit = searchCount / Math.max(1, edits);
  const testPerEdit = testCount / Math.max(1, edits);
  const retryRun = longestVerificationRetryRun(session);
  const add = (label, level, evidence, logic) => {
    deductions.push({
      label,
      level,
      points: deductionPoints(label, level),
      evidence,
      logic,
      levels: deductionLevels(label),
      role: "primary",
    });
  };

  if (effectiveInput >= 75000)
    add(
      "Context Heavy",
      effectiveInput >= 300000
        ? "high"
        : effectiveInput >= 150000
          ? "medium"
          : "low",
      `effective input ${fmtInt(effectiveInput)}; low >= 75,000, medium >= 150,000, high >= 300,000`,
      "Uncached input is high.",
    );
  if (verificationCount >= 8 && testCount < 5)
    add(
      "High Verification Activity",
      verificationCount >= 20 ? "high" : "medium",
      `verify commands ${fmtInt(verificationCount)}`,
      "Counts test, build, and lint commands when tests alone are not high.",
    );
  if (searchCount >= 10 && searchPerEdit >= 10)
    add(
      "Search Heavy / Low Edit",
      searchPerEdit >= 25 ? "high" : "medium",
      `search ${fmtInt(searchCount)} (rg ${fmtInt(commands.rg || 0)}, sed ${fmtInt(commands.sed || 0)}, cat ${fmtInt(commands.cat || 0)}), edits ${fmtInt(edits)}, ratio ${searchPerEdit.toFixed(1)}:1`,
      "Flags many search/read commands with few edits.",
    );
  if (testCount >= 5 && testPerEdit >= 5)
    add(
      "Test Heavy / Low Edit",
      testPerEdit >= 10 ? "high" : "medium",
      `tests ${fmtInt(testCount)} (go ${fmtInt(commands["go test"] || 0)}, npm ${fmtInt(commands["npm test"] || 0)}, pnpm ${fmtInt(commands["pnpm test"] || 0)}, yarn ${fmtInt(commands["yarn test"] || 0)}), edits ${fmtInt(edits)}, ratio ${testPerEdit.toFixed(1)}:1`,
      "Flags many test commands with few edits.",
    );
  if (retryRun.length >= 3)
    add(
      "Repeated Rework",
      retryRun.length >= 6 ? "high" : retryRun.length >= 4 ? "medium" : "low",
      `longest verification retry run ${fmtInt(retryRun.length)} (${retryRun.command || retryRun.family})`,
      "Flags consecutive test/build/lint retries without an edit or different command in between.",
    );

  return deductions;
}

function primaryBurnReason(deductions) {
  const priority = [
    "Repeated Rework",
    "Search Heavy / Low Edit",
    "Test Heavy / Low Edit",
    "Context Heavy",
    "High Verification Activity",
  ];
  return (
    priority
      .map((label) =>
        deductions.find(
          (item) => item.label === label && (item.points || 0) > 0,
        ),
      )
      .find(Boolean) || null
  );
}

function fmtInt(value) {
  return Math.round(Number(value || 0)).toLocaleString("en-US");
}

function ratio(left, right) {
  return Math.round(Number(left || 0) / Math.max(1, Number(right || 0)));
}

function verificationFamily(command) {
  if (["go test", "npm test", "pnpm test", "yarn test"].includes(command))
    return "test";
  if (command === "yarn build") return "build";
  if (command === "yarn lint") return "lint";
  return "";
}

function stepCommandSequence(step) {
  if (Array.isArray(step.commandSequence) && step.commandSequence.length)
    return step.commandSequence;
  return Object.entries(step.commands || {}).flatMap(([command, count]) =>
    Array(count).fill(command),
  );
}

function longestVerificationRetryRun(session) {
  let best = { length: 0, family: "", command: "" };
  let prev = "";
  let run = 0;
  let runCommands = [];

  for (const turn of session.turns || []) {
    for (const step of turn.steps || []) {
      if (Object.keys(step.tools || {}).some((t) => EDIT_TOOLS.has(t))) {
        prev = "";
        run = 0;
        runCommands = [];
      }
      for (const command of stepCommandSequence(step)) {
        const family = verificationFamily(command);
        if (!family) {
          prev = "";
          run = 0;
          runCommands = [];
          continue;
        }
        runCommands = family === prev ? [...runCommands, command] : [command];
        run = runCommands.length;
        prev = family;
        if (run > best.length) {
          const uniqueCommands = [...new Set(runCommands)];
          best = {
            length: run,
            family,
            command:
              uniqueCommands.length === 1
                ? uniqueCommands[0]
                : uniqueCommands.join(", "),
          };
        }
      }
    }
  }

  return best;
}

function deductionPoints(label, level) {
  const weights = {
    "Context Heavy": { high: 6, medium: 3, low: 1 },
    "High Verification Activity": { high: 8, medium: 4, low: 1 },
    "Search Heavy / Low Edit": { high: 12, medium: 6, low: 2 },
    "Test Heavy / Low Edit": { high: 10, medium: 5, low: 2 },
    "Repeated Rework": { high: 20, medium: 10, low: 5 },
  };
  return weights[label]?.[level] ?? 1;
}

function deductionLevels(label) {
  const levels = {
    "Context Heavy": [
      ["low", ">= 75,000 effective input tokens"],
      ["medium", ">= 150,000 effective input tokens"],
      ["high", ">= 300,000 effective input tokens"],
    ],
    "High Verification Activity": [
      ["medium", ">= 8 build/lint/test commands when tests < 5"],
      ["high", ">= 20 build/lint/test commands when tests < 5"],
    ],
    "Search Heavy / Low Edit": [
      ["medium", ">= 10 search/read commands and >= 10:1 search/edit ratio"],
      ["high", ">= 10 search/read commands and >= 25:1 search/edit ratio"],
    ],
    "Test Heavy / Low Edit": [
      ["medium", ">= 5 test commands and >= 5:1 test/edit ratio"],
      ["high", ">= 5 test commands and >= 10:1 test/edit ratio"],
    ],
    "Repeated Rework": [
      ["low", ">= 3 consecutive verification commands"],
      ["medium", ">= 4 consecutive verification commands"],
      ["high", ">= 6 consecutive verification commands"],
    ],
  };
  return (levels[label] || []).map(([level, text]) => ({ level, text }));
}

function aggregateTurnCounts(session, field) {
  const result = {};
  for (const turn of session.turns || []) {
    mergeCounts(result, turn[field] || {});
  }
  return result;
}

function countRepeatedTurnCommands(turn) {
  return Object.values(turn.commands || {}).filter((count) => count >= 3)
    .length;
}

function buildBurnReport(allSessions) {
  const sessions = allSessions.filter(
    (s) => !s.isSubagent && (s.costUsd || 0) > 0,
  );
  const topSessions = sessions
    .map((s) => {
      const effectiveInput =
        s.effectiveInputTokens ??
        Math.max(0, (s.inputTokens || 0) - (s.cachedInputTokens || 0));
      const tools = aggregateTurnCounts(s, "tools");
      const commands = aggregateTurnCounts(s, "commands");
      const deductions = burnReasons(s);
      const primaryReason = primaryBurnReason(deductions);
      const score = Math.max(
        0,
        100 - deductions.reduce((sum, item) => sum + item.points, 0),
      );
      return {
        sessionId: s.sessionId,
        date: s.date || (s.turns || [])[0]?.date || null,
        projectName: s.projectName || "unknown",
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
    .filter((s) => s.deductions.length > 0 && s.score < 100)
    .sort((a, b) => a.score - b.score || b.costUsd - a.costUsd)
    .slice(0, 20);

  return {
    generatedAt: new Date().toISOString(),
    sessionCount: sessions.length,
    totalCostUsd: Number(
      sessions.reduce((sum, s) => sum + (s.costUsd || 0), 0).toFixed(6),
    ),
    totalTokens: sessions.reduce((sum, s) => sum + (s.totalTokens || 0), 0),
    topSessions,
  };
}

function writeBurnReport(sessions, filename) {
  const report = buildBurnReport(sessions);
  fs.writeFileSync(
    path.join(DATA_DIR, filename),
    JSON.stringify(report, null, 2),
  );
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
  fs.writeFileSync(
    path.join(DATA_DIR, filename),
    JSON.stringify(emptyOptimizeReport(), null, 2),
  );
}

fs.mkdirSync(DATA_DIR, { recursive: true });

writeOptimizeReport("claude-optimize.json");
writeBurnReport(sortedSessions, "claude-burn.json");
console.log("Optimize: Cost Lens only");

// ── Per-period optimize analysis ──────────────────────────────────────
function filterSessionsByDateRange(sessions, startDate, endDate) {
  return sessions.filter(
    (s) => s.date && s.date >= startDate && s.date <= endDate,
  );
}

const periods = (() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const d7 = new Date(now);
  d7.setDate(d7.getDate() - 6);
  const d30 = new Date(now);
  d30.setDate(d30.getDate() - 29);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    today: { start: today, end: today },
    yesterday: {
      start: yesterday.toISOString().slice(0, 10),
      end: yesterday.toISOString().slice(0, 10),
    },
    "7days": { start: d7.toISOString().slice(0, 10), end: today },
    "30days": { start: d30.toISOString().slice(0, 10), end: today },
    month: { start: monthStart.toISOString().slice(0, 10), end: today },
  };
})();

for (const [period, range] of Object.entries(periods)) {
  const filtered = filterSessionsByDateRange(
    sortedSessions,
    range.start,
    range.end,
  );
  if (filtered.length === 0) {
    writeOptimizeReport(`claude-optimize-${period}.json`);
    fs.writeFileSync(
      path.join(DATA_DIR, `claude-burn-${period}.json`),
      JSON.stringify(buildBurnReport([]), null, 2),
    );
    continue;
  }
  writeOptimizeReport(`claude-optimize-${period}.json`);
  writeBurnReport(filtered, `claude-burn-${period}.json`);
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
  const projectName = turn.projectName || session.projectName || "unknown";
  const tools = normalizeCountMap(turn.tools);
  const commands = normalizeCountMap(turn.commands);
  const skills = normalizeCountMap(turn.skills);
  const files = normalizeCountMap(turn.files);

  return finalizeMetricBucket(
    createMetricBucket({
      projectName,
      sessionId: session.sessionId,
      turnIndex: turn.turnIndex,
      timestamp: turn.timestamp,
      date: turn.date,
      userMessagePreview: truncateText(turn.userMessage || "", 240),
      stepCount: (turn.steps || []).length,
      calls: turn.calls || (turn.steps || []).length,
      turns: 1,
      sessions: 0,
      inputTokens: turn.inputTokens || 0,
      cachedInputTokens: turn.cachedInputTokens || 0,
      cacheCreationInputTokens: turn.cacheCreationInputTokens || 0,
      effectiveInputTokens: turn.effectiveInputTokens ?? turn.inputTokens ?? 0,
      outputTokens: turn.outputTokens || 0,
      reasoningOutputTokens: turn.reasoningOutputTokens || 0,
      totalTokens: turn.totalTokens || 0,
      costUsd: turn.costUsd || 0,
      tools,
      commands,
      skills,
      files,
    }),
  );
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
      const turnsInRange = (session.turns || []).filter(
        (turn) => turn.date && isDateInRange(turn.date, range),
      );
      if (!turnsInRange.length) continue;

      const projectName =
        session.projectName || turnsInRange[0]?.projectName || "unknown";
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

        if (!dailyMap[dayKey])
          dailyMap[dayKey] = createMetricBucket({ date: dayKey });

        addMetrics(dailyMap[dayKey], { ...turnMetric, turns: 1, sessions: 0 });
        addMetrics(sessionBucket, { ...turnMetric, turns: 0, sessions: 0 });
        addMetrics(projectMap[projectName], {
          ...turnMetric,
          turns: 1,
          sessions: 0,
        });

        for (const [skillName, count] of Object.entries(
          turnMetric.skills || {},
        )) {
          if (!skillMap[skillName])
            skillMap[skillName] = createMetricBucket({ skillName, count: 0 });
          skillMap[skillName].count += count;
          addMetrics(skillMap[skillName], {
            ...turnMetric,
            turns: 0,
            sessions: 0,
          });
        }

        turnRows.push(turnMetric);
      }

      sessionMap[session.sessionId] = finalizeMetricBucket(sessionBucket);
    }

    const dailyActivity = daysInRange.map((day) =>
      finalizeMetricBucket(dailyMap[day] || createMetricBucket({ date: day })),
    );

    const byProject = sortByCostDesc(
      Object.values(projectMap).map((project) => {
        project.sessions = project.sessionsSet?.size || 0;
        delete project.sessionsSet;
        return finalizeMetricBucket(project);
      }),
    );

    const bySession = sortByCostDesc(
      Object.values(sessionMap).map(finalizeMetricBucket),
    );
    const byTurn = sortByCostDesc(turnRows.map(finalizeMetricBucket));
    const bySkills = sortByCostDesc(
      Object.values(skillMap).map(finalizeMetricBucket),
    );

    result[range.key] = {
      key: range.key,
      label: range.label,
      startDate: range.start.toISOString().slice(0, 10),
      endDate: new Date(range.end.getTime() - MS_PER_DAY)
        .toISOString()
        .slice(0, 10),
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
    message: step.message || "",
    tools: step.tools || {},
    commands: step.commands || {},
    skills: step.skills || {},
    files: step.files || {},
    model: step.model,
    costUsd: step.costUsd || 0,
    calls: step.calls || 0,
    inputTokens: step.inputTokens || 0,
    cachedInputTokens: step.cachedInputTokens || 0,
    cacheCreationInputTokens: step.cacheCreationInputTokens || 0,
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
      const parentTurns = [];
      for (const turn of session.turns || []) {
        if (turn.date !== date) continue;
        const filteredSteps = (turn.steps || [])
          .filter((step) => step.date === date)
          .map(serializeStep);
        const sumStep = (field) =>
          filteredSteps.reduce((s, st) => s + (st[field] || 0), 0);
        parentTurns.push({
          turnIndex: turn.turnIndex,
          timestamp: turn.timestamp,
          date: turn.date,
          projectName: turn.projectName,
          model: turn.model,
          userMessage: turn.userMessage || "",
          inputTokens: sumStep("inputTokens"),
          cachedInputTokens: sumStep("cachedInputTokens"),
          cacheCreationInputTokens: sumStep("cacheCreationInputTokens"),
          effectiveInputTokens: sumStep("effectiveInputTokens"),
          outputTokens: sumStep("outputTokens"),
          reasoningOutputTokens: sumStep("reasoningOutputTokens"),
          totalTokens: sumStep("totalTokens"),
          cacheRatio:
            sumStep("totalTokens") > 0
              ? sumStep("cachedInputTokens") / sumStep("totalTokens")
              : 0,
          costUsd: sumStep("costUsd"),
          calls: sumStep("calls"),
          tools: turn.tools || {},
          commands: turn.commands || {},
          skills: turn.skills || {},
          files: turn.files || {},
          commentary: turn.commentary || [],
          subagentRefs: (turn.subagentRefs || []).map((ref) => {
            const sub = _sessionById[ref.subagentSessionId];
            return {
              subagentSessionId: ref.subagentSessionId,
              role: ref.role || "worker",
              totalTokens: sub?.totalTokens || 0,
              costUsd: sub
                ? (sub.turns || []).reduce((s, t) => s + (t.costUsd || 0), 0)
                : 0,
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
          const subTurns = sub.turns.map((st, i) => ({
            turnIndex: st.turnIndex,
            timestamp: st.timestamp,
            date: turn.date,
            projectName: st.projectName,
            model: st.model,
            userMessage: st.userMessage || "",
            inputTokens: st.inputTokens || 0,
            cachedInputTokens: st.cachedInputTokens || 0,
            cacheCreationInputTokens: st.cacheCreationInputTokens || 0,
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
            agentRole: sub.agentRole || "worker",
            baseContextTokens:
              i === 0
                ? sub.turns?.[0]?.steps?.[0]?.effectiveInputTokens || 0
                : 0,
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
        sessionType: session.sessionType || "normal",
        agentNickname: session.agentNickname || null,
        agentRole: session.agentRole || null,
        baseContextTokens:
          session.turns?.[0]?.steps?.[0]?.effectiveInputTokens || 0,
      });

      for (const turn of turns) {
        addMetrics(bucket, {
          inputTokens: turn.inputTokens,
          cachedInputTokens: turn.cachedInputTokens,
          cacheCreationInputTokens: turn.cacheCreationInputTokens,
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
        cacheCreationInputTokens: day.cacheCreationInputTokens,
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
        cacheCreationInputTokens: 0,
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
    sourceDir: CLAUDE_DIR,
    parsedJsonlFiles: files.length,
    targetDate: date,
    totals: dayTotals,
    days: day ? [day] : [],
    sessions: sessionsForDate,
  };
}

let outputDates = RUN_DATE_ONLY ? [TARGET_DATE] : days.map((day) => day.date);

if (RUN_FILL) {
  const missing = outputDates.filter(
    (date) =>
      !fs.existsSync(path.join(DATA_DIR, `${OUTPUT_FILE_PREFIX}-${date}.json`)),
  );
  outputDates = missing.length > 0 ? missing : [TARGET_DATE];
}

const writtenFiles = [];

for (const date of outputDates) {
  const outputFile = path.join(DATA_DIR, `${OUTPUT_FILE_PREFIX}-${date}.json`);
  fs.writeFileSync(
    outputFile,
    JSON.stringify(buildResultForDate(date), null, 2),
  );
  writtenFiles.push(outputFile);
}

console.log(
  RUN_ALL
    ? "Mode: all history, write one file per day"
    : RUN_DATE_ONLY
      ? `Mode: single date ${TARGET_DATE}`
      : RUN_FILL
        ? `Mode: fill missing dates (last ${FILL_DAYS} days)`
        : "Mode: last 7 days by default, write one file per day",
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
