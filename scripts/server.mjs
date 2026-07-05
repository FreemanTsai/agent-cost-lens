// Copyright (c) 2026 Agent Cost Lens contributors. MIT License.

import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { execFile } from "child_process";

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC = "public";
const MONITOR_REPARSE_INTERVAL_MS =
  parseInt(process.env.MONITOR_REPARSE_INTERVAL_MS, 10) || 10000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const publicDir = path.join(rootDir, PUBLIC);
const codexParserScript = path.join(__dirname, "parse-codex-logs.mjs");
const claudeParserScript = path.join(__dirname, "parse-claude-logs.mjs");
const CLAUDE_USAGE_FILE = path.join(
  os.homedir(),
  ".claude",
  "usage-exact.json",
);
const CLAUDE_CREDENTIALS_FILE = path.join(
  os.homedir(),
  ".claude",
  ".credentials.json",
);
const CLAUDE_USAGE_REFRESH_INTERVAL_MS = 300000;
let monitorReparsePromise = null;
let lastMonitorReparseAt = 0;
let claudeMonitorReparsePromise = null;
let lastClaudeMonitorReparseAt = 0;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function refreshAccessToken(auth, authPath) {
  const resp = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refresh_token,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    }),
  });
  if (!resp.ok) throw new Error("Token refresh failed");
  const data = await resp.json();
  auth.tokens.access_token = data.access_token;
  if (data.refresh_token) auth.tokens.refresh_token = data.refresh_token;
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
  return data.access_token;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function fileAgeMs(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

function secondsUntil(iso) {
  const ms = Date.parse(iso) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : null;
}

function claudeWindow(metric) {
  if (!metric || metric.percent_used == null) return null;
  return {
    used_percent: Number(metric.percent_used || 0),
    reset_after_seconds: secondsUntil(metric.resets_at),
  };
}

function formatClaudeRateLimits(cache) {
  const metrics = cache?.metrics;
  if (!metrics) return null;

  const primary = claudeWindow(metrics.session);
  const secondary = claudeWindow(metrics.week_all);
  const sonnet = claudeWindow(metrics.week_sonnet);
  if (!primary && !secondary && !sonnet) return null;

  return {
    plan_type: "claude",
    rate_limit: {
      primary_window: primary,
      secondary_window: secondary,
    },
    additional_rate_limits: sonnet
      ? [
          {
            limit_name: "Sonnet",
            rate_limit: { secondary_window: sonnet },
          },
        ]
      : [],
  };
}

async function refreshClaudeUsageApi() {
  const token = readJsonFile(CLAUDE_CREDENTIALS_FILE)?.claudeAiOauth
    ?.accessToken;
  if (!token) return null;

  const resp = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) return null;

  const data = await resp.json();
  if (data?.five_hour?.utilization == null) return null;

  const cache = {
    timestamp: new Date().toISOString(),
    source: "api",
    metrics: {
      session: {
        percent_used: data.five_hour.utilization,
        percent_remaining: 100 - data.five_hour.utilization,
        resets_at: data.five_hour.resets_at,
      },
      week_all: {
        percent_used: data.seven_day?.utilization,
        percent_remaining: 100 - (data.seven_day?.utilization || 0),
        resets_at: data.seven_day?.resets_at,
      },
      week_sonnet: data.seven_day_sonnet
        ? {
            percent_used: data.seven_day_sonnet.utilization,
            percent_remaining: 100 - data.seven_day_sonnet.utilization,
            resets_at: data.seven_day_sonnet.resets_at,
          }
        : null,
    },
  };

  fs.mkdirSync(path.dirname(CLAUDE_USAGE_FILE), { recursive: true });
  fs.writeFileSync(CLAUDE_USAGE_FILE, JSON.stringify(cache, null, 2));
  return cache;
}

async function getClaudeRateLimits() {
  const cached = readJsonFile(CLAUDE_USAGE_FILE);
  if (fileAgeMs(CLAUDE_USAGE_FILE) < CLAUDE_USAGE_REFRESH_INTERVAL_MS) {
    return formatClaudeRateLimits(cached);
  }
  return formatClaudeRateLimits((await refreshClaudeUsageApi()) || cached);
}

function getRecentDailyFiles(publicDir, provider = "codex") {
  const dataDir = path.join(publicDir, "data");
  let files;
  try {
    files = fs.readdirSync(dataDir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith(`${provider}-usage-`) && f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, 3)
    .map((f) => path.join(dataDir, f));
}

function runDateOnlyReparse(provider = "codex") {
  const parserScript =
    provider === "claude" ? claudeParserScript : codexParserScript;
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [parserScript, "--date-only"],
      { cwd: rootDir },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
          return;
        }
        const lines = stdout.trim().split("\n");
        const writtenFiles = lines
          .filter((l) => l.startsWith("- "))
          .map((l) => l.replace(/^- /, ""));
        resolve({ message: stdout.trim(), writtenFiles });
      },
    );
  });
}

function refreshMonitorDataIfStale() {
  if (monitorReparsePromise) return monitorReparsePromise;
  const now = Date.now();
  if (now - lastMonitorReparseAt < MONITOR_REPARSE_INTERVAL_MS)
    return Promise.resolve(null);

  monitorReparsePromise = runDateOnlyReparse()
    .then((result) => {
      lastMonitorReparseAt = Date.now();
      return result;
    })
    .catch(() => null)
    .finally(() => {
      monitorReparsePromise = null;
    });
  return monitorReparsePromise;
}

function refreshClaudeMonitorDataIfStale() {
  if (claudeMonitorReparsePromise) return claudeMonitorReparsePromise;
  const now = Date.now();
  if (now - lastClaudeMonitorReparseAt < MONITOR_REPARSE_INTERVAL_MS)
    return Promise.resolve(null);

  claudeMonitorReparsePromise = runDateOnlyReparse("claude")
    .then((result) => {
      lastClaudeMonitorReparseAt = Date.now();
      return result;
    })
    .catch(() => null)
    .finally(() => {
      claudeMonitorReparsePromise = null;
    });
  return claudeMonitorReparsePromise;
}

async function getRecentSessions(provider) {
  const sessionFiles = await Promise.all(
    getRecentDailyFiles(publicDir, provider).map((f) =>
      fs.promises
        .readFile(f, "utf-8")
        .then(JSON.parse)
        .catch(() => null),
    ),
  );
  return sessionFiles
    .filter(Boolean)
    .flatMap((d) => d.sessions || [])
    .filter((s) => s.sessionType !== "assessment" && !s.parentSessionId)
    .map((s) => {
      const lastTs = (s.turns || []).reduce((max, t) => {
        const ts = t.timestamp || "";
        return ts > max ? ts : max;
      }, "");
      const firstMsg = s.turns?.find((t) => t.userMessage)?.userMessage || "";
      const preview = firstMsg
        .replace(/^\[[^\]]+\]\([^)]+\)\s*/, "")
        .slice(0, 40);
      return {
        sessionId: s.sessionId,
        costUsd: s.costUsd,
        lastTimestamp: lastTs,
        preview,
      };
    })
    .sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp))
    .slice(0, 5);
}

async function getSessionById(provider, sessionId) {
  if (!sessionId) return null;
  const sessionFiles = await Promise.all(
    getRecentDailyFiles(publicDir, provider).map((f) =>
      fs.promises
        .readFile(f, "utf-8")
        .then(JSON.parse)
        .catch(() => null),
    ),
  );
  return (
    sessionFiles
      .filter(Boolean)
      .flatMap((d) => d.sessions || [])
      .find(
        (s) =>
          s.sessionId === sessionId &&
          s.sessionType !== "assessment" &&
          !s.parentSessionId,
      ) || null
  );
}

async function getProviderSummary(provider) {
  const sessionFiles = await Promise.all(
    getRecentDailyFiles(publicDir, provider).map((f) =>
      fs.promises
        .readFile(f, "utf-8")
        .then(JSON.parse)
        .catch(() => null),
    ),
  );
  const totals = sessionFiles.filter(Boolean).reduce(
    (acc, data) => {
      const day = data.totals || {};
      acc.costUsd += (data.sessions || []).reduce(
        (sum, s) => sum + Number(s.costUsd || 0),
        0,
      );
      acc.totalTokens += Number(day.totalTokens || 0);
      acc.sessions += Number(day.sessionCount || (data.sessions || []).length);
      acc.calls += Number(day.tokenEventCount || 0);
      return acc;
    },
    { provider, costUsd: 0, totalTokens: 0, sessions: 0, calls: 0 },
  );
  totals.costUsd = Number(totals.costUsd.toFixed(6));
  return totals;
}

http
  .createServer((req, res) => {
    let url = req.url.split("?")[0];
    const params = new URL(req.url, `http://${HOST}:${PORT}`).searchParams;

    if (url === "/api/reparse") {
      runDateOnlyReparse()
        .then(({ message, writtenFiles }) => {
          lastMonitorReparseAt = Date.now();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: true, message, writtenFiles }));
        })
        .catch((err) => {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      return;
    }

    if (url === "/api/claude-reparse") {
      runDateOnlyReparse("claude")
        .then(({ message, writtenFiles }) => {
          lastClaudeMonitorReparseAt = Date.now();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: true, message, writtenFiles }));
        })
        .catch((err) => {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      return;
    }

    if (url === "/api/monitor") {
      (async () => {
        try {
          await refreshMonitorDataIfStale();

          const authPath = path.join(os.homedir(), ".codex", "auth.json");
          const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
          const token = auth.tokens?.access_token;
          if (!token) throw new Error("No access token");

          let usageRes = await fetch(
            "https://chatgpt.com/backend-api/wham/usage",
            {
              headers: { Authorization: `Bearer ${token}` },
            },
          );
          if (usageRes.status === 401) {
            const newToken = await refreshAccessToken(auth, authPath);
            usageRes = await fetch(
              "https://chatgpt.com/backend-api/wham/usage",
              {
                headers: { Authorization: `Bearer ${newToken}` },
              },
            );
          }
          const rateLimits = usageRes.ok ? await usageRes.json() : null;

          const sessions = await getRecentSessions("codex");

          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(
            JSON.stringify({
              success: true,
              rateLimits,
              sessions,
              fetchedAt: new Date().toISOString(),
            }),
          );
        } catch (err) {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      })();
      return;
    }

    if (url === "/api/session") {
      (async () => {
        try {
          await refreshMonitorDataIfStale();
          const session = await getSessionById("codex", params.get("id"));
          if (!session) {
            res.writeHead(404, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(
              JSON.stringify({ success: false, error: "Session not found" }),
            );
            return;
          }
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: true, session }));
        } catch (err) {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      })();
      return;
    }

    if (url === "/api/claude-monitor") {
      (async () => {
        try {
          await refreshClaudeMonitorDataIfStale();
          const [rateLimits, summary, sessions] = await Promise.all([
            getClaudeRateLimits(),
            getProviderSummary("claude"),
            getRecentSessions("claude"),
          ]);

          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(
            JSON.stringify({
              success: true,
              rateLimits,
              summary,
              sessions,
              fetchedAt: new Date().toISOString(),
            }),
          );
        } catch (err) {
          res.writeHead(500, {
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      })();
      return;
    }

    if (url === "/") url = "/index.html";
    const file = path.join(publicDir, url);
    if (!file.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    const ext = path.extname(file);
    try {
      const content = fs.readFileSync(file);
      res.writeHead(200, {
        "Content-Type": MIME[ext] || "application/octet-stream",
      });
      res.end(content);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
  });
