const {
  summarizeByDepartmentFromSnapshots,
  summarizeInternalVsCompetitorFromSnapshots
} = require("../db/repositories/snapshot-repository");

function toNumber(value, digits = 2) {
  if (value === null || value === undefined) {
    return 0;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Number(parsed.toFixed(digits));
}

function normalizeSnapshotDepartmentSummary(rows) {
  return rows.map((row) => ({
    department: row.department,
    sampledRooms: row.sampledRooms,
    liveRooms: row.liveRooms,
    avgOnlineCount: toNumber(row.avgOnlineCount),
    peakOnlineCount: toNumber(row.peakOnlineCount, 0),
    avgLikeCount: toNumber(row.avgLikeCount)
  }));
}

function normalizeSnapshotCategorySummary(rows) {
  return rows.map((row) => ({
    category: row.category,
    sampledRooms: row.sampledRooms,
    liveRooms: row.liveRooms,
    avgOnlineCount: toNumber(row.avgOnlineCount),
    peakOnlineCount: toNumber(row.peakOnlineCount, 0),
    avgLikeCount: toNumber(row.avgLikeCount)
  }));
}

function buildDepartmentComparisonView(db, targetDepartmentBaseline) {
  const snapshotSummary = normalizeSnapshotDepartmentSummary(summarizeByDepartmentFromSnapshots(db));
  const snapshotByDepartment = Object.fromEntries(snapshotSummary.map((item) => [item.department, item]));

  return targetDepartmentBaseline.map((baseline) => ({
    department: baseline.department,
    targetTotalAccounts: baseline.totalAccounts,
    targetLiveEnabledAccounts: baseline.liveEnabledAccounts,
    targetInternalAccounts: baseline.internalAccounts,
    targetCompetitorAccounts: baseline.competitorAccounts,
    sampledRooms: snapshotByDepartment[baseline.department]?.sampledRooms || 0,
    liveRooms: snapshotByDepartment[baseline.department]?.liveRooms || 0,
    avgOnlineCount: snapshotByDepartment[baseline.department]?.avgOnlineCount || 0,
    peakOnlineCount: snapshotByDepartment[baseline.department]?.peakOnlineCount || 0,
    avgLikeCount: snapshotByDepartment[baseline.department]?.avgLikeCount || 0
  }));
}

function buildInternalVsCompetitorView(db, competitorBaseline) {
  const snapshotSummary = normalizeSnapshotCategorySummary(summarizeInternalVsCompetitorFromSnapshots(db));
  const snapshotByCategory = Object.fromEntries(snapshotSummary.map((item) => [item.category, item]));

  const internal = snapshotByCategory["内部"] || {
    category: "内部",
    sampledRooms: 0,
    liveRooms: 0,
    avgOnlineCount: 0,
    peakOnlineCount: 0,
    avgLikeCount: 0
  };
  const competitor = snapshotByCategory["竞品"] || {
    category: "竞品",
    sampledRooms: 0,
    liveRooms: 0,
    avgOnlineCount: 0,
    peakOnlineCount: 0,
    avgLikeCount: 0
  };

  return {
    targetBaseline: competitorBaseline,
    snapshotView: {
      internal,
      competitor
    }
  };
}

module.exports = {
  buildDepartmentComparisonView,
  buildInternalVsCompetitorView
};
