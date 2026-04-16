function formatHourKey(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function extractKeywords(text) {
  if (!text) {
    return [];
  }
  const normalized = String(text).replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ");
  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .filter((token) => !/^\d+$/.test(token));
}

function buildDailyInsights(db) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const stopWords = new Set([
    "在线人数变化",
    "点赞数变化",
    "直播状态变更",
    "进入直播间",
    "关注主播",
    "开播",
    "下播"
  ]);

  const hourlyRows = db
    .prepare(
      `
      SELECT
        CAST(strftime('%H', sample_time) AS INTEGER) AS hour,
        COUNT(*) AS samples,
        AVG(COALESCE(online_count, 0)) AS avgOnline,
        MAX(COALESCE(online_count, 0)) AS maxOnline
      FROM room_snapshots
      WHERE sample_time >= ?
      GROUP BY CAST(strftime('%H', sample_time) AS INTEGER)
      ORDER BY maxOnline DESC, avgOnline DESC
      LIMIT 3
    `
    )
    .all(since);

  const peaks = hourlyRows.map((item) => ({
    hour: formatHourKey(item.hour),
    avgOnline: Math.round(item.avgOnline || 0),
    peakOnline: item.maxOnline || 0,
    samples: item.samples || 0
  }));

  const messageRows = db
    .prepare(
      `
      SELECT content
      FROM live_messages
      WHERE event_time >= ?
      ORDER BY id DESC
      LIMIT 500
    `
    )
    .all(since);

  const keywordCounter = {};
  for (const row of messageRows) {
    for (const keyword of extractKeywords(row.content)) {
      if (stopWords.has(keyword)) {
        continue;
      }
      keywordCounter[keyword] = (keywordCounter[keyword] || 0) + 1;
    }
  }

  const topKeywords = Object.entries(keywordCounter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([word, count]) => ({ word, count }));

  const departmentRows = db
    .prepare(
      `
      SELECT
        department,
        AVG(COALESCE(online_count, 0)) AS avgOnline,
        MAX(COALESCE(online_count, 0)) AS peakOnline
      FROM room_snapshots
      WHERE sample_time >= ?
      GROUP BY department
      ORDER BY avgOnline DESC
      LIMIT 5
    `
    )
    .all(since)
    .map((row) => ({
      department: row.department || "未分组",
      avgOnline: Math.round(row.avgOnline || 0),
      peakOnline: row.peakOnline || 0
    }));

  const suggestions = [];
  if (topKeywords.length > 0) {
    const selected = topKeywords.slice(0, 3).map((item) => item.word);
    const topWords = selected.join("、");
    suggestions.push(`高频提问集中在：${topWords}。建议把这 ${selected.length} 个问题前置到开场 3 分钟口播。`);
  } else {
    suggestions.push("当前弹幕样本偏少，建议先稳定开播时长并增加提问互动，累积 1-2 天后再优化话术。");
  }

  if (peaks.length > 0) {
    suggestions.push(`建议把转化话术放在高峰时段（${peaks[0].hour}）重复 2-3 轮，并配合评论区引导。`);
  }

  return {
    generatedAt: new Date().toISOString(),
    since,
    peaks,
    topKeywords,
    departmentRows,
    suggestions
  };
}

module.exports = {
  buildDailyInsights
};
