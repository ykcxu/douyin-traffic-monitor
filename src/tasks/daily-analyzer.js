function createDailyAnalyzerTask(config) {
  return {
    name: "daily-analyzer",
    intervalSec: config.scheduler.analysisIntervalSec,
    description: "日报分析任务占位，后续接入弹幕、高峰时段和话术建议生成。"
  };
}

module.exports = {
  createDailyAnalyzerTask
};
