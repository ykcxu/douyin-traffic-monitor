const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/config");
const { loadTargets, summarizeTargets } = require("../src/core/target-loader");
const { bootstrapProject } = require("../src/services/bootstrap-service");
const { generateDailyReportArtifacts } = require("../src/services/report-service");

function withTempConfig(overrides, callback) {
  const originalPaths = { ...config.paths };

  try {
    Object.assign(config.paths, overrides);
    return callback();
  } finally {
    Object.assign(config.paths, originalPaths);
  }
}

test("target loader falls back to example file and summarizes targets", () => {
  const exampleFile = path.join(__dirname, "..", "data", "monitor-targets.example.json");
  const missingPrivateFile = path.join(os.tmpdir(), `missing-targets-${Date.now()}.json`);

  withTempConfig(
    {
      targetsFile: missingPrivateFile,
      targetsExampleFile: exampleFile
    },
    () => {
      const { filePath, targets } = loadTargets();
      const summary = summarizeTargets(targets);

      assert.equal(filePath, exampleFile);
      assert.equal(targets.length, 2);
      assert.equal(summary.total, 2);
      assert.equal(summary.withLiveRoom, 1);
      assert.equal(summary.withProfile, 2);
      assert.equal(summary.byCategory["内部"], 1);
      assert.equal(summary.byCategory["竞品"], 1);
    }
  );
});

test("bootstrap project creates database and syncs monitor targets", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-bootstrap-"));
  const tempStorageDir = path.join(tempRoot, "storage");
  const tempRuntimeDir = path.join(tempRoot, "runtime");
  const tempDbFile = path.join(tempStorageDir, "app.db");
  const exampleFile = path.join(__dirname, "..", "data", "monitor-targets.example.json");

  withTempConfig(
    {
      storageDir: tempStorageDir,
      runtimeDir: tempRuntimeDir,
      databaseFile: tempDbFile,
      targetsFile: path.join(tempRoot, "private-targets.json"),
      targetsExampleFile: exampleFile
    },
    () => {
      const { db, summary } = bootstrapProject();
      const row = db.prepare("SELECT COUNT(*) AS count FROM monitor_targets").get();

      assert.equal(summary.total, 2);
      assert.equal(row.count, 2);
      assert.equal(fs.existsSync(tempDbFile), true);
    }
  );
});

test("daily report generation writes comparison reports and placeholders", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-report-"));
  const tempStorageDir = path.join(tempRoot, "storage");
  const tempRuntimeDir = path.join(tempRoot, "runtime");
  const tempDbFile = path.join(tempStorageDir, "app.db");

  withTempConfig(
    {
      storageDir: tempStorageDir,
      runtimeDir: tempRuntimeDir,
      databaseFile: tempDbFile
    },
    () => {
      const { initDatabase } = require("../src/db/database");
      const db = initDatabase();
      const targets = [
        {
          platform: "抖音",
          category: "内部",
          department: "小数",
          accountType: "IP号",
          accountName: "账号A",
          accountUid: "uid-a",
          liveRoomUrl: "https://live.douyin.com/a",
          profileUrl: "https://www.douyin.com/user/a",
          monitoringRequirements: ""
        },
        {
          platform: "抖音",
          category: "内部",
          department: "小语",
          accountType: "组织号",
          accountName: "账号B",
          accountUid: "uid-b",
          liveRoomUrl: "https://live.douyin.com/b",
          profileUrl: "https://www.douyin.com/user/b",
          monitoringRequirements: ""
        },
        {
          platform: "抖音",
          category: "竞品",
          department: "小数",
          accountType: "",
          accountName: "竞品A",
          accountUid: "",
          liveRoomUrl: "",
          profileUrl: "https://www.douyin.com/user/c",
          monitoringRequirements: ""
        }
      ];

      const result = generateDailyReportArtifacts(db, targets);
      const reportsCount = db.prepare("SELECT COUNT(*) AS count FROM analysis_reports").get().count;
      const suggestionsCount = db.prepare("SELECT COUNT(*) AS count FROM script_suggestions").get().count;
      const peaksCount = db.prepare("SELECT COUNT(*) AS count FROM peak_segments").get().count;

      assert.equal(result.departmentComparison.length, 2);
      assert.equal(result.competitorComparison.internalAccounts, 2);
      assert.equal(result.competitorComparison.competitorAccounts, 1);
      assert.equal(reportsCount, 2);
      assert.equal(suggestionsCount, 2);
      assert.equal(peaksCount, 2);
    }
  );
});
