const { insertAnalysisReport, insertPeakSegment, insertScriptSuggestion } = require("../db/repositories/report-repository");
const {
  buildCompetitorComparison,
  buildDailyScriptSuggestionPlaceholders,
  buildDepartmentComparison,
  buildPeakSegmentPlaceholders
} = require("./analysis-service");

function getReportDate() {
  return new Date().toISOString().slice(0, 10);
}

function generateDailyReportArtifacts(db, targets) {
  const reportDate = getReportDate();
  const departmentComparison = buildDepartmentComparison(targets);
  const competitorComparison = buildCompetitorComparison(targets);
  const scriptSuggestions = buildDailyScriptSuggestionPlaceholders(targets);
  const peakSegments = buildPeakSegmentPlaceholders(targets, reportDate);

  insertAnalysisReport(db, {
    reportType: "department_comparison",
    reportDate,
    scopeType: "global",
    scopeKey: "all",
    summary: "按学科汇总监控目标分布，为后续直播对比分析提供基线。",
    details: departmentComparison
  });

  insertAnalysisReport(db, {
    reportType: "competitor_comparison",
    reportDate,
    scopeType: "global",
    scopeKey: "all",
    summary: "内部与竞品监控对象数量基线，用于后续直播表现对比。",
    details: competitorComparison
  });

  for (const suggestion of scriptSuggestions) {
    insertScriptSuggestion(db, {
      ...suggestion,
      reportDate
    });
  }

  for (const segment of peakSegments) {
    insertPeakSegment(db, segment);
  }

  return {
    reportDate,
    departmentComparison,
    competitorComparison,
    scriptSuggestionsCount: scriptSuggestions.length,
    peakSegmentsCount: peakSegments.length
  };
}

module.exports = {
  generateDailyReportArtifacts
};
