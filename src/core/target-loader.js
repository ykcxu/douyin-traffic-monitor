const fs = require("fs");
const path = require("path");
const config = require("../config");
const { readJson } = require("../utils/fs");

function resolveTargetsFile() {
  const privateFilePath = config.paths.targetsFile;
  const exampleFilePath = config.paths.targetsExampleFile;

  if (fs.existsSync(privateFilePath)) {
    return privateFilePath;
  }

  return exampleFilePath;
}

function loadTargets() {
  const filePath = resolveTargetsFile();
  return {
    filePath,
    targets: readJson(filePath)
  };
}

function summarizeTargets(targets) {
  return targets.reduce(
    (acc, target) => {
      acc.total += 1;
      if (target.liveRoomUrl) {
        acc.withLiveRoom += 1;
      }
      if (target.profileUrl) {
        acc.withProfile += 1;
      }

      acc.byCategory[target.category] = (acc.byCategory[target.category] || 0) + 1;
      acc.byDepartment[target.department] = (acc.byDepartment[target.department] || 0) + 1;
      acc.byAccountType[target.accountType || "未分类"] =
        (acc.byAccountType[target.accountType || "未分类"] || 0) + 1;

      return acc;
    },
    {
      total: 0,
      withLiveRoom: 0,
      withProfile: 0,
      byCategory: {},
      byDepartment: {},
      byAccountType: {}
    }
  );
}

module.exports = {
  loadTargets,
  summarizeTargets,
  resolveTargetsFile
};
