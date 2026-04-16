const config = require("../config");
const { createDailyAnalyzerTask } = require("./daily-analyzer");
const { createLiveSamplerTask } = require("./live-sampler");
const { createProfileSamplerTask } = require("./profile-sampler");

function buildTaskRegistry() {
  return [
    createLiveSamplerTask(config),
    createProfileSamplerTask(config),
    createDailyAnalyzerTask(config)
  ];
}

module.exports = {
  buildTaskRegistry
};
