function createLiveSamplerTask(config) {
  return {
    name: "live-sampler",
    intervalSec: config.scheduler.liveSampleIntervalSec,
    description: "直播间状态采样任务占位，后续接入真实直播间在线人数与互动指标采集。"
  };
}

module.exports = {
  createLiveSamplerTask
};
