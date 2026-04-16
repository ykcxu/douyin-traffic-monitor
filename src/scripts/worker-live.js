const fs = require("fs");
const path = require("path");
const logger = require("../logger");
const config = require("../config");
const { bootstrapProject } = require("../services/bootstrap-service");
const { sampleLiveTargetsByDepartment } = require("../services/live-sample-service");
const { normalizeTargets } = require("../core/target-normalizer");
const { insertLiveMessage } = require("../db/repositories/message-repository");
const { listRecentSnapshotsByAccountName } = require("../db/repositories/snapshot-repository");
const { buildDerivedMessagesFromSnapshots } = require("../services/derived-message-service");

const REQUIRED_CYCLE_INTERVAL_SEC = Math.max(
  5,
  Number(config.scheduler.liveSampleIntervalSec || 20)
);
const statusFile = path.join(config.paths.runtimeDir, "live-worker-status.json");

function writeLiveWorkerStatus(snapshot) {
  try {
    fs.writeFileSync(
      statusFile,
      JSON.stringify(
        {
          time: new Date().toISOString(),
          pid: process.pid,
          running: true,
          ...snapshot
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    logger.warn("直播采样 worker 状态写入失败", {
      error: error.message
    });
  }
}

function writeDerivedMessages(context, result) {
  if (result.status !== "ok") {
    return 0;
  }

  const snapshots = listRecentSnapshotsByAccountName(context.db, result.target.accountName, 2);
  if (snapshots.length < 2) {
    return 0;
  }

  const currentSnapshot = snapshots[0];
  const previousSnapshot = snapshots[1];
  const derivedMessages = buildDerivedMessagesFromSnapshots(result.target, previousSnapshot, currentSnapshot);

  for (const item of derivedMessages) {
    insertLiveMessage(context.db, {
      messageId: null,
      roomId: item.roomId,
      accountUid: item.accountUid,
      eventTime: item.eventTime,
      messageType: item.messageType,
      userId: null,
      userName: result.target.accountName,
      content: item.content,
      giftName: null,
      giftCount: null,
      rawPayload: item.rawPayload
    });
  }

  return derivedMessages.length;
}

function getLiveDepartmentCount(targets) {
  return new Set(
    normalizeTargets(targets)
      .filter((item) => item.liveWebRid)
      .map((item) => String(item.department || "未分组").trim() || "未分组")
  ).size;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSingleCycle(context, departmentCursorState) {
  const results = await sampleLiveTargetsByDepartment(context.db, context.targets, departmentCursorState);
  const okCount = results.filter((item) => item.status === "ok").length;
  const restrictedCount = results.filter((item) => item.status === "restricted").length;
  const skippedCount = results.filter((item) => item.status === "skipped").length;
  const errorCount = results.filter((item) => item.status === "error").length;
  const sampledDepartments = new Set(results.map((item) => item?.target?.department).filter(Boolean)).size;
  const derivedCount = results.reduce((acc, item) => acc + writeDerivedMessages(context, item), 0);
  return {
    total: results.length,
    sampledDepartments,
    okCount,
    restrictedCount,
    skippedCount,
    errorCount,
    derivedCount
  };
}

function logCycleSummary(summary) {
  logger.info("直播采样轮次完成", {
    total: summary.total,
    sampledDepartments: summary.sampledDepartments,
    ok: summary.okCount,
    restricted: summary.restrictedCount,
    skipped: summary.skippedCount,
    error: summary.errorCount,
    derivedMessages: summary.derivedCount
  });
}

async function startLoop() {
  const context = bootstrapProject();
  const liveDepartmentCount = getLiveDepartmentCount(context.targets);
  const departmentCursorState = {};
  logger.info("直播采样 worker 启动", {
    intervalSec: REQUIRED_CYCLE_INTERVAL_SEC,
    liveDepartmentCount
  });
  writeLiveWorkerStatus({
    phase: "started",
    intervalSec: REQUIRED_CYCLE_INTERVAL_SEC,
    liveDepartmentCount,
    cycle: null
  });

  const markStopped = (reason) => {
    writeLiveWorkerStatus({
      running: false,
      phase: "stopped",
      reason,
      intervalSec: REQUIRED_CYCLE_INTERVAL_SEC,
      liveDepartmentCount
    });
  };
  process.on("SIGINT", () => {
    markStopped("sigint");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    markStopped("sigterm");
    process.exit(0);
  });

  while (true) {
    const startedAt = Date.now();
    try {
      const cycle = await runSingleCycle(context, departmentCursorState);
      logCycleSummary(cycle);
      writeLiveWorkerStatus({
        phase: "cycle_done",
        intervalSec: REQUIRED_CYCLE_INTERVAL_SEC,
        liveDepartmentCount,
        cycleDurationMs: Date.now() - startedAt,
        cycle
      });
    } catch (error) {
      logger.error("直播采样轮次异常", {
        error: error.message
      });
      writeLiveWorkerStatus({
        phase: "cycle_error",
        intervalSec: REQUIRED_CYCLE_INTERVAL_SEC,
        liveDepartmentCount,
        cycleDurationMs: Date.now() - startedAt,
        error: error.message
      });
    }
    const elapsed = Date.now() - startedAt;
    const waitMs = Math.max(0, REQUIRED_CYCLE_INTERVAL_SEC * 1000 - elapsed);
    await sleep(waitMs);
  }
}

startLoop().catch((error) => {
  logger.error("直播采样 worker 启动失败", {
    error: error.message
  });
  process.exit(1);
});
