const { nowIso } = require("../../utils/time");

function insertAnalysisReport(db, report) {
  db.prepare(`
    INSERT INTO analysis_reports (
      report_type,
      report_date,
      scope_type,
      scope_key,
      summary,
      details_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    report.reportType,
    report.reportDate,
    report.scopeType,
    report.scopeKey,
    report.summary,
    JSON.stringify(report.details),
    nowIso()
  );
}

function insertScriptSuggestion(db, suggestion) {
  db.prepare(`
    INSERT INTO script_suggestions (
      report_date,
      room_id,
      account_uid,
      account_name,
      summary,
      effective_phrases_json,
      risky_phrases_json,
      recommended_rewrites_json,
      faq_response_suggestions_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    suggestion.reportDate,
    suggestion.roomId || null,
    suggestion.accountUid || null,
    suggestion.accountName,
    suggestion.summary,
    JSON.stringify(suggestion.effectivePhrases),
    JSON.stringify(suggestion.riskyPhrases),
    JSON.stringify(suggestion.recommendedRewrites),
    JSON.stringify(suggestion.faqResponseSuggestions),
    nowIso()
  );
}

function insertPeakSegment(db, segment) {
  db.prepare(`
    INSERT INTO peak_segments (
      report_date,
      room_id,
      account_uid,
      account_name,
      peak_start_time,
      peak_end_time,
      peak_reason,
      online_count_peak,
      message_rate_peak,
      recording_status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    segment.reportDate,
    segment.roomId || null,
    segment.accountUid || null,
    segment.accountName,
    segment.peakStartTime,
    segment.peakEndTime,
    segment.peakReason,
    segment.onlineCountPeak || null,
    segment.messageRatePeak || null,
    segment.recordingStatus || "pending",
    nowIso()
  );
}

module.exports = {
  insertAnalysisReport,
  insertScriptSuggestion,
  insertPeakSegment
};
