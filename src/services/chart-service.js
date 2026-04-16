const { listDepartmentLiveAveragesByBucket } = require("../db/repositories/snapshot-repository");

function toNumber(value, digits = 1) {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return null;
  }
  return Number(n.toFixed(digits));
}

function buildRecentBucketLabels(minutes = 30, bucketSeconds = 60) {
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 30;
  const safeBucketSeconds = Number.isFinite(bucketSeconds) && bucketSeconds > 0 ? Math.floor(bucketSeconds) : 60;

  const pointCount = Math.max(2, Math.ceil((safeMinutes * 60) / safeBucketSeconds) + 1);
  const nowMs = Date.now();
  const bucketMs = safeBucketSeconds * 1000;
  const alignedNow = Math.floor(nowMs / bucketMs) * bucketMs;
  const startMs = alignedNow - (pointCount - 1) * bucketMs;

  const labels = [];
  for (let i = 0; i < pointCount; i += 1) {
    labels.push(new Date(startMs + i * bucketMs).toISOString().slice(0, 19));
  }
  return labels;
}

function buildDepartmentLiveAvgSeries(db, departments = [], options = {}) {
  const minutes = Number(options.minutes || 30);
  const bucketSeconds = Number(options.bucketSeconds || 60);
  const labels = buildRecentBucketLabels(minutes, bucketSeconds);
  const sinceIso = `${labels[0]}Z`;
  const rows = listDepartmentLiveAveragesByBucket(db, sinceIso, bucketSeconds);

  const safeDepartments = Array.from(
    new Set(
      (departments || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );

  const valueMapByBucket = new Map();
  for (const row of rows) {
    const bucketTime = String(row.bucketTime || "").replace(" ", "T").slice(0, 19);
    if (!bucketTime) {
      continue;
    }
    if (!valueMapByBucket.has(bucketTime)) {
      valueMapByBucket.set(bucketTime, {});
    }
    const avgValue = toNumber(row.avgOnlineLive, 1);
    valueMapByBucket.get(bucketTime)[row.department] = avgValue === null ? 0 : avgValue;
    if (!safeDepartments.includes(row.department)) {
      safeDepartments.push(row.department);
    }
  }

  const points = labels.map((bucketTime) => ({
    bucketTime: `${bucketTime}Z`,
    values: safeDepartments.reduce((acc, department) => {
      acc[department] = valueMapByBucket.get(bucketTime)?.[department] ?? 0;
      return acc;
    }, {})
  }));

  return {
    minutes: Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 30,
    bucketSeconds: Number.isFinite(bucketSeconds) && bucketSeconds > 0 ? Math.floor(bucketSeconds) : 60,
    departments: safeDepartments,
    points
  };
}

module.exports = {
  buildDepartmentLiveAvgSeries
};
