#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(PROJECT_ROOT, "public", "data");
const HERMES_DB = path.join(os.homedir(), ".hermes", "state.db");

const MODEL_PRICING_USD_PER_1M = {
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-5.6": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10 },
};

function getArgValue(prefix) {
  const arg = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

const RUN_ALL = process.argv.includes("--all");
const RUN_DATE_ONLY = process.argv.includes("--date-only");
const TARGET_DATE = getArgValue("--date=");
const FILL_DAYS = Math.max(
  0,
  Number.parseInt(getArgValue("--fill=") ?? "0", 10) || 0,
);

function normalizeModel(model) {
  return String(model || "unknown").trim() || "unknown";
}

function getPricingForModel(model) {
  const normalized = normalizeModel(model).toLowerCase();

  if (MODEL_PRICING_USD_PER_1M[normalized]) {
    return MODEL_PRICING_USD_PER_1M[normalized];
  }

  const key = Object.keys(MODEL_PRICING_USD_PER_1M)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => normalized.startsWith(candidate));

  return key ? MODEL_PRICING_USD_PER_1M[key] : null;
}

function estimateCostUsd({
  model,
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  reasoningOutputTokens = 0,
}) {
  const pricing = getPricingForModel(model);
  if (!pricing) return 0;

  // hermes DB 語意：input_tokens 已是 uncached（新增）token，
  // cache_read_tokens 是獨立計數，可能大於 input。
  const input = Math.max(0, Number(inputTokens) || 0);
  const cached = Math.max(0, Number(cachedInputTokens) || 0);
  const uncachedInput = input;
  const output = Math.max(0, Number(outputTokens) || 0);
  const reasoning = Math.max(0, Number(reasoningOutputTokens) || 0);

  return (
    (uncachedInput / 1_000_000) * pricing.input +
    (cached / 1_000_000) * pricing.cachedInput +
    ((output + reasoning) / 1_000_000) * pricing.output
  );
}

function queryHermesSqlite(sql) {
  if (!fs.existsSync(HERMES_DB)) return [];

  try {
    const stdout = execFileSync(
      "sqlite3",
      ["-json", HERMES_DB, sql],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();

    return stdout ? JSON.parse(stdout) : [];
  } catch (error) {
    const stderr = error?.stderr?.toString?.().trim();
    console.error(
      `[hermes] sqlite query failed: ${stderr || error.message}`,
    );
    return [];
  }
}

function getSessionColumns() {
  return new Set(
    queryHermesSqlite("PRAGMA table_info(sessions);").map(
      (row) => row.name,
    ),
  );
}

function pickColumn(columns, candidates) {
  return candidates.find((name) => columns.has(name)) ?? null;
}

function quoteIdentifier(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}

function numberValue(row, column) {
  if (!column) return 0;

  const value = Number(row[column]);
  return Number.isFinite(value) ? value : 0;
}

function parseTimestamp(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const text = String(value).trim();

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) return null;

    const millis = numeric > 1e12 ? numeric : numeric * 1000;
    const date = new Date(millis);

    return Number.isNaN(date.getTime()) ? null : date;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function projectNameFromPath(value) {
  if (!value) return "hermes";

  try {
    return path.basename(path.resolve(String(value))) || "hermes";
  } catch {
    return "hermes";
  }
}

function loadHermesSessions() {
  const columns = getSessionColumns();

  if (columns.size === 0) {
    console.error(
      "[hermes] sessions table not found or contains no columns",
    );
    return [];
  }

  const idColumn = pickColumn(columns, ["session_id", "id"]);
  const modelColumn = pickColumn(columns, ["model", "model_name"]);
  const projectColumn = pickColumn(columns, ["project_name"]);
  const workdirColumn = pickColumn(columns, [
    "cwd",
    "workdir",
    "working_directory",
  ]);

  const inputColumn = pickColumn(columns, ["input_tokens"]);
  const cachedColumn = pickColumn(columns, [
    "cached_input_tokens",
    "cache_read_tokens",
  ]);
  const outputColumn = pickColumn(columns, ["output_tokens"]);
  const reasoningColumn = pickColumn(columns, [
    "reasoning_output_tokens",
  ]);
  const totalColumn = pickColumn(columns, ["total_tokens"]);

  const timestampColumns = [
    "created_at",
    "started_at",
    "updated_at",
    "last_active_at",
  ].filter((name) => columns.has(name));

  if (!idColumn) {
    console.error(
      "[hermes] sessions table has neither session_id nor id",
    );
    return [];
  }

  const selectedColumns = [
    idColumn,
    modelColumn,
    projectColumn,
    workdirColumn,
    inputColumn,
    cachedColumn,
    outputColumn,
    reasoningColumn,
    totalColumn,
    ...timestampColumns,
  ].filter(Boolean);

  const uniqueColumns = [...new Set(selectedColumns)];

  const sql = `
    SELECT ${uniqueColumns.map(quoteIdentifier).join(", ")}
    FROM sessions
  `;

  const rows = queryHermesSqlite(sql);

  return rows.map((row) => {
    const sessionId = String(row[idColumn]);
    const model = normalizeModel(
      modelColumn ? row[modelColumn] : "unknown",
    );

    const inputTokens = Math.max(
      0,
      numberValue(row, inputColumn),
    );

    const cachedInputTokens = Math.max(
      0,
      numberValue(row, cachedColumn),
    );

    const effectiveInputTokens = inputTokens;

    const outputTokens = Math.max(
      0,
      numberValue(row, outputColumn),
    );

    const reasoningOutputTokens = Math.max(
      0,
      numberValue(row, reasoningColumn),
    );

    const storedTotalTokens = Math.max(
      0,
      numberValue(row, totalColumn),
    );

    const totalTokens =
      storedTotalTokens > 0
        ? storedTotalTokens
        : inputTokens + cachedInputTokens + outputTokens;

    const timestamp =
      timestampColumns
        .map((column) => parseTimestamp(row[column]))
        .find(Boolean) ?? null;

    const date = timestamp
      ? formatLocalDate(timestamp)
      : "unknown";

    const timestampIso = timestamp
      ? timestamp.toISOString()
      : null;

    const projectName =
      projectColumn && row[projectColumn]
        ? String(row[projectColumn])
        : workdirColumn && row[workdirColumn]
          ? projectNameFromPath(row[workdirColumn])
          : "hermes";

    const costUsd = estimateCostUsd({
      model,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens,
    });

    const cacheRatio =
      inputTokens + cachedInputTokens > 0
        ? cachedInputTokens / (inputTokens + cachedInputTokens)
        : 0;

    const step = {
      stepIndex: 1,
      role: "hermes",
      timestamp: timestampIso,
      model,

      inputTokens,
      cachedInputTokens,
      effectiveInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,

      costUsd,

      tools: {},
      commands: {},
      skills: {},
      files: {},
      toolCalls: [],
    };

    const turn = {
      turnIndex: 1,
      timestamp: timestampIso,
      date,
      projectName,
      model,

      userMessage: "",

      inputTokens,
      cachedInputTokens,
      effectiveInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,

      costUsd,
      calls: 1,

      tools: {},
      commands: {},
      skills: {},
      files: {},

      commentary: [],
      subagentRefs: [],

      steps: [step],
    };

    return {
      source: "hermes",

      sessionId,
      file: HERMES_DB,
      projectName,

      models: {
        [model]: 1,
      },

      modelCosts: {
        [model]: costUsd,
      },

      date,

      inputTokens,
      cachedInputTokens,
      effectiveInputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,

      tokenEventCount: 1,
      eventCount: 1,

      tools: {},
      commands: {},
      skills: {},
      files: {},

      turns: [turn],
      steps: [step],

      costUsd,
      cacheRatio,

      maxRateLimitUsedPercent: null,

      isSubagent: false,
      parentSessionId: null,
      sessionType: "normal",
    };
  });
}

function mergeCountMaps(items, field) {
  const result = {};

  for (const item of items) {
    const values = item[field] || {};

    for (const [key, value] of Object.entries(values)) {
      result[key] =
        (result[key] || 0) + Number(value || 0);
    }
  }

  return result;
}

function buildResultForDate(date, allSessions) {
  const sessions = allSessions.filter(
    (session) => session.date === date,
  );

  const sum = (field) =>
    sessions.reduce(
      (total, session) =>
        total + Number(session[field] || 0),
      0,
    );

  const inputTokens = sum("inputTokens");
  const cachedInputTokens = sum("cachedInputTokens");

  const totals = {
    inputTokens,
    cachedInputTokens,

    effectiveInputTokens: sum("effectiveInputTokens"),
    outputTokens: sum("outputTokens"),
    reasoningOutputTokens: sum("reasoningOutputTokens"),
    totalTokens: sum("totalTokens"),

    costUsd: sum("costUsd"),

    eventCount: sum("eventCount"),
    tokenEventCount: sum("tokenEventCount"),
    sessionCount: sessions.length,

    maxRateLimitUsedPercent: null,

    tools: mergeCountMaps(sessions, "tools"),
    commands: mergeCountMaps(sessions, "commands"),
    skills: mergeCountMaps(sessions, "skills"),
    files: mergeCountMaps(sessions, "files"),

    cacheRatio:
      inputTokens + cachedInputTokens > 0
        ? cachedInputTokens / (inputTokens + cachedInputTokens)
        : 0,
  };

  return {
    generatedAt: new Date().toISOString(),
    sourceDir: HERMES_DB,
    parsedJsonlFiles: 0,
    targetDate: date,

    totals,

    days: [
      {
        date,
        ...totals,
      },
    ],

    sessions,
  };
}

function dateRangeDays(endDate, count) {
  const result = [];
  const cursor = new Date(`${endDate}T00:00:00`);

  for (let index = 0; index < count; index += 1) {
    result.unshift(formatLocalDate(cursor));
    cursor.setDate(cursor.getDate() - 1);
  }

  return result;
}

function resolveOutputDates(sessions) {
  const knownDates = [
    ...new Set(
      sessions
        .map((session) => session.date)
        .filter(
          (date) =>
            date &&
            date !== "unknown",
        ),
    ),
  ].sort();

  const today = formatLocalDate(new Date());

  if (TARGET_DATE) {
    return [TARGET_DATE];
  }

  if (FILL_DAYS > 0) {
    return dateRangeDays(today, FILL_DAYS);
  }

  if (RUN_DATE_ONLY) {
    return [today];
  }

  if (RUN_ALL) {
    return knownDates;
  }

  return [today];
}

function main() {
  if (!fs.existsSync(HERMES_DB)) return;

  const sessions = loadHermesSessions();
  const outputDates = resolveOutputDates(sessions);

  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true,
  });

  console.log(
    `[hermes] parsed ${sessions.length} sessions from ${HERMES_DB}`,
  );

  for (const date of outputDates) {
    const result = buildResultForDate(
      date,
      sessions,
    );

    const outputPath = path.join(
      OUTPUT_DIR,
      `hermes-usage-${date}.json`,
    );

    fs.writeFileSync(
      outputPath,
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );

    console.log(
      `[hermes] wrote ${outputPath}`,
    );
  }
}

main();
