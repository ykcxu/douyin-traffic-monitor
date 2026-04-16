const { getBusinessDayWindow } = require("../utils/business-day");

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
  const { since, until } = getBusinessDayWindow(new Date(), {
    startHour: 5,
    timezoneOffsetHours: 8
  });
  const stopWords = new Set([
    "在线人数变化",
    "点赞数变化",
    "直播状态变更",
    "进入直播间",
    "关注主播",
    "开播",
    "下播",
    "点赞",
    "状态",
    "在线",
    "人数",
    "变化",
    "直播间",
    "用户"
  ]);

  const hourlyRows = db
    .prepare(
      `
      SELECT
        CAST(strftime('%H', sample_time, '+8 hours') AS INTEGER) AS hour,
        COUNT(*) AS samples,
        AVG(COALESCE(online_count, 0)) AS avgOnline,
        MAX(COALESCE(online_count, 0)) AS maxOnline
      FROM room_snapshots
      WHERE sample_time >= ?
        AND sample_time < ?
      GROUP BY CAST(strftime('%H', sample_time, '+8 hours') AS INTEGER)
      ORDER BY maxOnline DESC, avgOnline DESC
      LIMIT 3
    `
    )
    .all(since, until);

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
        AND event_time < ?
        AND message_type LIKE '%Chat%'
      ORDER BY id DESC
      LIMIT 500
    `
    )
    .all(since, until);

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
        AND sample_time < ?
      GROUP BY department
      ORDER BY avgOnline DESC
      LIMIT 5
    `
    )
    .all(since, until)
    .map((row) => ({
      department: row.department || "未分组",
      avgOnline: Math.round(row.avgOnline || 0),
      peakOnline: row.peakOnline || 0
    }));

  const categoryRows = db
    .prepare(
      `
      SELECT
        category,
        COUNT(*) AS samples,
        SUM(CASE WHEN COALESCE(is_live, 0) = 1 THEN 1 ELSE 0 END) AS liveSamples,
        AVG(COALESCE(online_count, 0)) AS avgOnline,
        MAX(COALESCE(online_count, 0)) AS peakOnline
      FROM room_snapshots
      WHERE sample_time >= ?
        AND sample_time < ?
      GROUP BY category
    `
    )
    .all(since, until);

  const categoryMap = new Map(
    categoryRows.map((item) => [
      item.category || "unknown",
      {
        category: item.category || "unknown",
        samples: Number(item.samples || 0),
        liveSamples: Number(item.liveSamples || 0),
        avgOnline: Math.round(item.avgOnline || 0),
        peakOnline: Number(item.peakOnline || 0)
      }
    ])
  );
  const internalCategory =
    categoryMap.get("内部") ||
    categoryMap.get("internal") || {
      category: "内部",
      samples: 0,
      liveSamples: 0,
      avgOnline: 0,
      peakOnline: 0
    };
  const competitorCategory =
    categoryMap.get("竞品") ||
    categoryMap.get("外部") ||
    categoryMap.get("competitor") || {
      category: "竞品",
      samples: 0,
      liveSamples: 0,
      avgOnline: 0,
      peakOnline: 0
    };

  const liveRate = (row) => {
    if (!row.samples) {
      return 0;
    }
    return Math.round((row.liveSamples / row.samples) * 100);
  };
  const internalLiveRate = liveRate(internalCategory);
  const competitorLiveRate = liveRate(competitorCategory);

  const departmentTop = departmentRows.slice(0, 3);

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

  if (departmentTop.length > 0) {
    const topDepartment = departmentTop[0];
    suggestions.push(
      `学科侧重点：优先复用「${topDepartment.department}」的高峰节奏（均值 ${topDepartment.avgOnline}，峰值 ${topDepartment.peakOnline}）。`
    );
  }

  if (internalCategory.samples > 0 || competitorCategory.samples > 0) {
    const avgDiff = internalCategory.avgOnline - competitorCategory.avgOnline;
    if (avgDiff >= 0) {
      suggestions.push(
        `内部对竞品优势：内部均值在线高 ${avgDiff}，建议固化当前开场结构并扩展到其他学科直播间。`
      );
    } else {
      suggestions.push(
        `竞品当前更强：内部均值在线低 ${Math.abs(avgDiff)}，建议在开播前 5 分钟增加“问题-承诺-案例”三段式话术。`
      );
    }
  }

  const scriptAdvice = [];
  if (topKeywords.length > 0) {
    const topWords = topKeywords.slice(0, 3).map((item) => item.word);
    scriptAdvice.push(`开场 90 秒先答：${topWords.join("、")}。`);
    scriptAdvice.push("高峰前 2 分钟重复一次核心利益点，并加评论区提问引导。");
  } else {
    scriptAdvice.push("弹幕样本不足，先提升互动提问频率后再做精细话术优化。");
  }

  return {
    generatedAt: new Date().toISOString(),
    since,
    until,
    peaks,
    topKeywords,
    departmentRows,
    categoryComparison: {
      internal: {
        ...internalCategory,
        liveRate: internalLiveRate
      },
      competitor: {
        ...competitorCategory,
        liveRate: competitorLiveRate
      }
    },
    suggestions
    ,
    scriptAdvice
  };
}

module.exports = {
  buildDailyInsights
};
