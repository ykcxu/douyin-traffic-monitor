function buildDepartmentComparison(targets) {
  const bucket = {};

  for (const target of targets) {
    if (!bucket[target.department]) {
      bucket[target.department] = {
        department: target.department,
        totalAccounts: 0,
        internalAccounts: 0,
        competitorAccounts: 0,
        liveEnabledAccounts: 0
      };
    }

    const record = bucket[target.department];
    record.totalAccounts += 1;
    record.liveEnabledAccounts += target.liveRoomUrl ? 1 : 0;

    if (target.category === "内部") {
      record.internalAccounts += 1;
    } else {
      record.competitorAccounts += 1;
    }
  }

  return Object.values(bucket).sort((a, b) => a.department.localeCompare(b.department, "zh-CN"));
}

function buildCompetitorComparison(targets) {
  const internal = targets.filter((item) => item.category === "内部");
  const competitor = targets.filter((item) => item.category === "竞品");

  return {
    internalAccounts: internal.length,
    competitorAccounts: competitor.length,
    internalLiveRooms: internal.filter((item) => item.liveRoomUrl).length,
    competitorLiveRooms: competitor.filter((item) => item.liveRoomUrl).length
  };
}

function buildDailyScriptSuggestionPlaceholders(targets) {
  return targets
    .filter((target) => target.liveRoomUrl)
    .slice(0, 5)
    .map((target) => ({
      accountName: target.accountName,
      accountUid: target.accountUid || null,
      roomId: null,
      summary: `待接入真实弹幕和人数数据后，为 ${target.accountName} 生成核心话术建议。`,
      effectivePhrases: [],
      riskyPhrases: [],
      recommendedRewrites: [
        "补充开场价值说明，减少泛泛寒暄。",
        "在人数上涨前后的 3 分钟内对主播话术做自动比对。",
        "将高频问题整理成标准回应模板。"
      ],
      faqResponseSuggestions: []
    }));
}

function buildPeakSegmentPlaceholders(targets, reportDate) {
  return targets
    .filter((target) => target.liveRoomUrl)
    .slice(0, 5)
    .map((target) => ({
      reportDate,
      accountName: target.accountName,
      accountUid: target.accountUid || null,
      roomId: null,
      peakStartTime: `${reportDate}T20:00:00.000Z`,
      peakEndTime: `${reportDate}T20:05:00.000Z`,
      peakReason: "待接入实时人数与弹幕速率后自动判定高峰片段",
      onlineCountPeak: null,
      messageRatePeak: null,
      recordingStatus: "pending"
    }));
}

module.exports = {
  buildDepartmentComparison,
  buildCompetitorComparison,
  buildDailyScriptSuggestionPlaceholders,
  buildPeakSegmentPlaceholders
};
