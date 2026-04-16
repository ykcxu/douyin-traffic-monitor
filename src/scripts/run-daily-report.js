const { bootstrapProject } = require("../services/bootstrap-service");
const { generateDailyReportArtifacts } = require("../services/report-service");

function main() {
  const { db, targets } = bootstrapProject();
  const result = generateDailyReportArtifacts(db, targets);

  console.log("每日报告骨架生成完成。");
  console.log(`报告日期: ${result.reportDate}`);
  console.log(`学科对比结果: ${result.departmentComparison.length}`);
  console.log(`话术建议占位: ${result.scriptSuggestionsCount}`);
  console.log(`高峰片段占位: ${result.peakSegmentsCount}`);
}

main();
