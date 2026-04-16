const config = require("../config");
const { ensureDir } = require("../utils/fs");
const { initDatabase } = require("../db/database");
const { loadTargets, summarizeTargets } = require("../core/target-loader");
const { normalizeTargets } = require("../core/target-normalizer");
const { replaceTargets } = require("../db/repositories/target-repository");
const logger = require("../logger");

function bootstrapProject() {
  ensureDir(config.paths.storageDir);
  ensureDir(config.paths.runtimeDir);

  const db = initDatabase();
  const { filePath, targets } = loadTargets();
  const normalizedTargets = normalizeTargets(targets);
  replaceTargets(db, normalizedTargets);

  const summary = summarizeTargets(normalizedTargets);
  logger.info("项目启动初始化完成", {
    filePath,
    targetCount: summary.total
  });

  return {
    db,
    filePath,
    targets: normalizedTargets,
    summary
  };
}

module.exports = {
  bootstrapProject
};
