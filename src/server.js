const http = require("http");
const { URL } = require("url");
const config = require("./config");
const { bootstrapProject } = require("./services/bootstrap-service");
const { buildDepartmentComparison, buildCompetitorComparison } = require("./services/analysis-service");
const { buildDepartmentComparisonView, buildInternalVsCompetitorView } = require("./services/comparison-service");
const {
  listRecentRoomSnapshots,
  listLatestSnapshotByAccount
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

function createServerContext() {
  const boot = bootstrapProject();
  const baselineDepartment = buildDepartmentComparison(boot.targets);
  const baselineCompetitor = buildCompetitorComparison(boot.targets);
  return {
    ...boot,
    baselineDepartment,
    baselineCompetitor
  };
}

function createAppServer(context) {
  return http.createServer((req, res) => {
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

    writeJson(res, 404, {
      error: "not_found",
      path
    });
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
