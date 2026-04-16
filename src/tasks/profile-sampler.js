function createProfileSamplerTask(config) {
  return {
    name: "profile-sampler",
    intervalSec: config.scheduler.profileSampleIntervalSec,
    description: "主页数据采样任务占位，后续接入粉丝数、作品数和获赞数采集。"
  };
}

module.exports = {
  createProfileSamplerTask
};
