const config = require("../config");
const logger = require("../logger");
const { bootstrapProject } = require("../services/bootstrap-service");
const { sampleLiveTargets } = require("../services/live-sample-service");
const { normalizeTargets } = require("../core/target-normalizer");
const { insertLiveMessage } = require("../db/repositories/message-repository");
const { listRecentSnapshotsByAccountName } = require("../db/repositories/snapshot-repository");
const { buildDerivedMessagesFromSnapshots } = require("../services/derived-message-service");

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

function getLiveTargetCount(targets) {
  return normalizeTargets(targets).filter((item) => item.liveWebRid).length;
}

async function runSingleCycle(context, startIndex = 0) {
  const results = await sampleLiveTargets(context.db, context.targets, {
    limit: config.scheduler.liveSampleBatchSize,
    startIndex
  });
  const okCount = results.filter((item) => item.status === "ok").length;
  const errorCount = results.filter((item) => item.status === "error").length;
  const derivedCount = results.reduce((acc, item) => acc + writeDerivedMessages(context, item), 0);
  logger.info("直播采样轮次完成", {
    total: results.length,
    ok: okCount,
    error: errorCount,
    derivedMessages: derivedCount
  });
}

async function startLoop() {
  const context = bootstrapProject();
  const totalTargets = getLiveTargetCount(context.targets);
  let cursor = 0;
  await runSingleCycle(context, cursor);
  if (totalTargets > 0) {
    cursor = (cursor + config.scheduler.liveSampleBatchSize) % totalTargets;
  }

  setInterval(async () => {
    try {
      await runSingleCycle(context, cursor);
      if (totalTargets > 0) {
        cursor = (cursor + config.scheduler.liveSampleBatchSize) % totalTargets;
      }
    } catch (error) {
      logger.error("直播采样轮次异常", {
        error: error.message
      });
    }
  }, config.scheduler.liveSampleIntervalSec * 1000);
}

startLoop().catch((error) => {
  logger.error("直播采样 worker 启动失败", {
    error: error.message
  });
  process.exit(1);
});
