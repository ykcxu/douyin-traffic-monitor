const http = require("http");
const fs = require("fs");
const pathModule = require("path");
const { URL } = require("url");
const config = require("./config");
const { bootstrapProject } = require("./services/bootstrap-service");
const { buildDepartmentComparison, buildCompetitorComparison } = require("./services/analysis-service");
const { buildDepartmentComparisonView, buildInternalVsCompetitorView } = require("./services/comparison-service");
const { buildDailyInsights } = require("./services/insight-service");
const { getAuthDiagnostics } = require("./services/auth-diagnostics-service");
const { startMessageWorkerIfNeeded, isMessageWorkerRunning } = require("./services/message-worker-supervisor");
const {
  listRecentRoomSnapshots,
  listLatestSnapshotByAccount,
  getRecentRestrictionStats
} = require("./db/repositories/snapshot-repository");
const { listRecentLiveMessages } = require("./db/repositories/message-repository");
const logger = require("./logger");

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function writeFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store"
    });
    res.end(content);
  } catch (error) {
    writeJson(res, 404, { error: "not_found", filePath });
  }
}

function readRecentLogs(limit = 100) {
  const logsDir = pathModule.join(config.paths.runtimeDir, "logs");
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith(".log"))
    .sort((a, b) => b.localeCompare(a, "en"));
  if (files.length === 0) {
    return [];
  }

  const latestFile = pathModule.join(logsDir, files[0]);
  const lines = fs.readFileSync(latestFile, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = lines.slice(-limit).reverse();

  return selected.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return {
        time: new Date().toISOString(),
        level: "info",
        message: line
      };
    }
  });
}

function createServerContext() {
  const boot = bootstrapProject();
  const baselineDepartment = buildDepartmentComparison(boot.targets);
  const baselineCompetitor = buildCompetitorComparison(boot.targets);
  const challengeCandidates = boot.targets
    .map((item) => String(item.liveRoomUrl || "").trim())
    .filter(Boolean);
  challengeCandidates.push("https://live.douyin.com/");

  return {
    ...boot,
    baselineDepartment,
    baselineCompetitor,
    challengeCandidates
  };
}

async function pickChallengeUrl(context) {
  const candidates = context.challengeCandidates || ["https://live.douyin.com/"];
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

  for (const url of candidates.slice(0, 10)) {
    try {
      if (url === "https://live.douyin.com/") {
        return url;
      }
      const response = await fetch(url, {
        headers: {
          "user-agent": ua,
          referer: "https://live.douyin.com/"
        }
      });
      const html = await response.text();
      if (!html.includes("直播已结束")) {
        return url;
      }
    } catch (error) {
      continue;
    }
  }

  return "https://live.douyin.com/";
}

function createAppServer(context) {
  const webDir = pathModule.join(config.paths.rootDir, "web");

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const path = url.pathname;

    if (path === "/health") {
      writeJson(res, 200, {
        ok: true,
        app: config.app.name,
        env: config.app.env,
        time: new Date().toISOString()
      });
      return;
    }

    if (path === "/" || path === "/dashboard") {
      writeFile(res, pathModule.join(webDir, "dashboard.html"), "text/html; charset=utf-8");
      return;
    }

    if (path === "/web/dashboard.css") {
      writeFile(res, pathModule.join(webDir, "dashboard.css"), "text/css; charset=utf-8");
      return;
    }

    if (path === "/web/dashboard.js") {
      writeFile(res, pathModule.join(webDir, "dashboard.js"), "application/javascript; charset=utf-8");
      return;
    }

    if (path === "/api/summary") {
      const latestSnapshots = listLatestSnapshotByAccount(context.db);
      writeJson(res, 200, {
        sourceFile: context.filePath,
        targetSummary: context.summary,
        latestSnapshotCount: latestSnapshots.length
      });
      return;
    }

    if (path === "/api/snapshots/recent") {
      const limit = Number(url.searchParams.get("limit") || "20");
      const rows = listRecentRoomSnapshots(context.db, Number.isFinite(limit) ? limit : 20);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

    if (path === "/api/compare/departments") {
      const rows = buildDepartmentComparisonView(context.db, context.baselineDepartment);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

    if (path === "/api/compare/internal-vs-competitor") {
      const payload = buildInternalVsCompetitorView(context.db, context.baselineCompetitor);
      writeJson(res, 200, payload);
      return;
    }

    if (path === "/api/messages/recent") {
      const limit = Number(url.searchParams.get("limit") || "50");
      const rows = listRecentLiveMessages(context.db, Number.isFinite(limit) ? limit : 50);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

    if (path === "/api/insights/daily") {
      const payload = buildDailyInsights(context.db);
      writeJson(res, 200, payload);
      return;
    }

    if (path === "/api/auth/status") {
      const payload = await getAuthDiagnostics();
      const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const restrictionStats = getRecentRestrictionStats(context.db, windowStart);
      const workerStatus = isMessageWorkerRunning();
      const challengePageUrl = await pickChallengeUrl(context);
      writeJson(res, 200, {
        ...payload,
        recentWindowStart: windowStart,
        restrictionStats,
        messageWorker: workerStatus,
        challengePageUrl
      });
      return;
    }

    if (path === "/api/auth/recover" && req.method === "POST") {
      const diagnostics = await getAuthDiagnostics();
      const recover = startMessageWorkerIfNeeded();
      writeJson(res, 200, {
        ok: true,
        diagnostics,
        recover
      });
      return;
    }

    if (path === "/api/auth/challenge-url") {
      const challengePageUrl = await pickChallengeUrl(context);
      writeJson(res, 200, {
        challengePageUrl
      });
      return;
    }

    if (path === "/api/logs/recent") {
      const limit = Number(url.searchParams.get("limit") || "100");
      const rows = readRecentLogs(Number.isFinite(limit) ? limit : 100);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

      writeJson(res, 404, {
        error: "not_found",
        path
      });
    } catch (error) {
      logger.error("API 请求处理失败", {
        error: error.message,
        path: req.url
      });
      writeJson(res, 500, {
        error: "internal_error"
      });
    }
  });
}

function main() {
  const context = createServerContext();
  const server = createAppServer(context);
  server.listen(config.server.port, config.server.host, () => {
    logger.info("API 服务已启动", {
      host: config.server.host,
      port: config.server.port
    });
  });
}

main();
