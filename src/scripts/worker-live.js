const config = require("../config");
const logger = require("../logger");
const { bootstrapProject } = require("../services/bootstrap-service");
const { sampleLiveTargets } = require("../services/live-sample-service");

async function runSingleCycle(context) {
  const results = await sampleLiveTargets(context.db, context.targets, {
    limit: config.scheduler.liveSampleBatchSize
  });
  const okCount = results.filter((item) => item.status === "ok").length;
  const errorCount = results.filter((item) => item.status === "error").length;
  logger.info("直播采样轮次完成", {
    total: results.length,
    ok: okCount,
    error: errorCount
  });
}

async function startLoop() {
  const context = bootstrapProject();
  await runSingleCycle(context);

  setInterval(async () => {
    try {
      await runSingleCycle(context);
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
