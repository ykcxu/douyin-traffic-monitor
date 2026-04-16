const { listSnapshotsForTrend } = require("../db/repositories/snapshot-repository");

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

function smoothSeries(values, windowSize = 3) {
  const safeWindow = Math.max(1, Number.isFinite(windowSize) ? Math.floor(windowSize) : 3);
  if (safeWindow <= 1) {
    return [...values];
  }

  const radius = Math.floor(safeWindow / 2);
  return values.map((value, index) => {
    const currentMissing = value === null || value === undefined;
    const current = currentMissing ? null : Number(value);
    if (!currentMissing && !Number.isFinite(current)) {
      return value;
    }

    let sum = 0;
    let count = 0;
    let positiveSum = 0;
    let positiveCount = 0;
    for (let i = Math.max(0, index - radius); i <= Math.min(values.length - 1, index + radius); i += 1) {
      const n = Number(values[i]);
      if (!Number.isFinite(n)) {
        continue;
      }
      sum += n;
      count += 1;
      if (n > 0) {
        positiveSum += n;
        positiveCount += 1;
      }
    }

    if (count === 0) {
      return null;
    }

    // 孤立的 0 点优先参考周围正值，减少视觉抖动。
    if (currentMissing) {
      return positiveCount > 0 ? toNumber(positiveSum / positiveCount, 1) : null;
    }
    const base = current === 0 && positiveCount > 0 ? positiveSum / positiveCount : sum / count;
    return toNumber(base, 1);
  });
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
  const freshnessSeconds = Number(options.freshnessSeconds || Math.max(90, bucketSeconds * 3));
  const smoothWindow = Math.max(1, Number(options.smoothWindow || 3));
  const labels = buildRecentBucketLabels(minutes, bucketSeconds);
  const rawSinceMs = new Date(`${labels[0]}Z`).getTime() - freshnessSeconds * 1000;
  const sinceIso = new Date(rawSinceMs).toISOString();
  const rows = listSnapshotsForTrend(db, sinceIso);

  const safeDepartments = Array.from(
    new Set(
      (departments || [])
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    )
  );

  const byAccount = new Map();
  for (const row of rows) {
    const accountName = String(row.accountName || "").trim();
    if (!accountName) {
      continue;
    }
    if (!byAccount.has(accountName)) {
      byAccount.set(accountName, []);
    }
    byAccount.get(accountName).push({
      department: String(row.department || "").trim() || "未分组",
      sampleTimeMs: new Date(row.sampleTime).getTime(),
      isLive: Number(row.isLive) === 1,
      onlineCount: Number(row.onlineCount || 0)
    });
    if (!safeDepartments.includes(row.department)) {
      safeDepartments.push(row.department);
    }
  }

  const accountStates = Array.from(byAccount.entries()).map(([accountName, snapshots]) => ({
    accountName,
    snapshots,
    idx: -1
  }));
  const freshnessMs = Math.max(30, Number.isFinite(freshnessSeconds) ? freshnessSeconds : 90) * 1000;

  const points = labels.map((bucketTime) => ({
    bucketTime: `${bucketTime}Z`,
    values: (() => {
      const bucketMs = new Date(`${bucketTime}Z`).getTime();
      const agg = {};
      for (const department of safeDepartments) {
        agg[department] = { sum: 0, count: 0 };
      }

      for (const state of accountStates) {
        while (
          state.idx + 1 < state.snapshots.length &&
          state.snapshots[state.idx + 1].sampleTimeMs <= bucketMs
        ) {
          state.idx += 1;
        }
        if (state.idx < 0) {
          continue;
        }
        const snap = state.snapshots[state.idx];
        if (!Number.isFinite(snap.sampleTimeMs) || bucketMs - snap.sampleTimeMs > freshnessMs) {
          continue;
        }
        if (!snap.isLive) {
          continue;
        }
        if (!agg[snap.department]) {
          agg[snap.department] = { sum: 0, count: 0 };
          if (!safeDepartments.includes(snap.department)) {
            safeDepartments.push(snap.department);
          }
        }
        agg[snap.department].sum += snap.onlineCount;
        agg[snap.department].count += 1;
      }

      const values = {};
      for (const department of safeDepartments) {
        const item = agg[department] || { sum: 0, count: 0 };
        values[department] = item.count > 0 ? toNumber(item.sum / item.count, 1) : null;
      }
      return values;
    })()
  }));

  if (smoothWindow > 1) {
    for (const department of safeDepartments) {
      const raw = points.map((point) => point.values?.[department] ?? 0);
      const smoothed = smoothSeries(raw, smoothWindow);
      for (let i = 0; i < points.length; i += 1) {
        points[i].values[department] = smoothed[i];
      }
    }
  }

  return {
    minutes: Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 30,
    bucketSeconds: Number.isFinite(bucketSeconds) && bucketSeconds > 0 ? Math.floor(bucketSeconds) : 60,
    freshnessSeconds: Math.max(30, Number.isFinite(freshnessSeconds) ? Math.floor(freshnessSeconds) : 90),
    smoothWindow,
    departments: safeDepartments,
    points
  };
}

module.exports = {
  buildDepartmentLiveAvgSeries
};
