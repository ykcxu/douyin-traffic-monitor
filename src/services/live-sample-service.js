const logger = require("../logger");
const { normalizeTargets } = require("../core/target-normalizer");
const { insertRoomSnapshot } = require("../db/repositories/snapshot-repository");
const { fetchLiveRoomState, LiveRoomFetchError } = require("./live-room-page-service");

async function sampleSingleLiveTarget(db, target) {
  if (!target.liveWebRid) {
    return {
      status: "skipped",
      reason: "missing_live_web_rid",
      target
    };
  }

  let liveState;
  try {
    liveState = await fetchLiveRoomState(target.liveWebRid);
  } catch (error) {
    if (
      error instanceof LiveRoomFetchError &&
      (error.code === "captcha_required" || error.code === "content_unavailable")
    ) {
      const snapshot = {
        roomId: null,
        accountUid: target.accountUid || null,
        accountName: target.accountName,
        category: target.category,
        department: target.department,
        sampleTime: new Date().toISOString(),
        isLive: false,
        onlineCount: null,
        likeCount: null,
        rawPayload: {
          liveWebRid: target.liveWebRid,
          fetchStatus: "captcha_required",
          fetchCode: error.code,
          statusText: "restricted"
        }
      };
      insertRoomSnapshot(db, snapshot);
      logger.warn("直播间采样受限（验证码）", {
        accountName: target.accountName,
        liveWebRid: target.liveWebRid
      });
      return {
        status: "restricted",
        target,
        snapshot
      };
    }
    throw error;
  }
  const snapshot = {
    roomId: liveState.roomId,
    accountUid: target.accountUid || liveState.userId || null,
    accountName: target.accountName,
    category: target.category,
    department: target.department,
    sampleTime: liveState.fetchedAt,
    isLive: liveState.status === 2,
    onlineCount: liveState.userCount,
    likeCount: liveState.likeCount,
    rawPayload: {
      liveWebRid: target.liveWebRid,
      title: liveState.title,
      status: liveState.status,
      statusText: liveState.statusText,
      userId: liveState.userId,
      ownerUserId: liveState.ownerUserId,
      userCountText: liveState.userCountText,
      rawHtmlLength: liveState.rawHtmlLength,
      ttwidCookie: liveState.ttwidCookie,
      source: liveState.source || "unknown"
    }
  };

  insertRoomSnapshot(db, snapshot);
  logger.info("直播间采样完成", {
    accountName: target.accountName,
    liveWebRid: target.liveWebRid,
    roomId: liveState.roomId,
    status: liveState.statusText,
    onlineCount: liveState.userCount,
    likeCount: liveState.likeCount
  });

  return {
    status: "ok",
    target,
    snapshot
  };
}

async function sampleLiveTargets(db, targets, options = {}) {
  const normalizedTargets = normalizeTargets(targets).filter((target) => target.liveWebRid);
  const total = normalizedTargets.length;
  const limit = Math.max(1, Math.min(options.limit || total, total || 1));
  const startIndexRaw = Number.isFinite(options.startIndex) ? options.startIndex : 0;
  const startIndex = total > 0 ? ((startIndexRaw % total) + total) % total : 0;
  const selectedTargets = [];
  for (let i = 0; i < limit && i < total; i += 1) {
    selectedTargets.push(normalizedTargets[(startIndex + i) % total]);
  }
  const results = [];

  for (const target of selectedTargets) {
    try {
      const result = await sampleSingleLiveTarget(db, target);
      results.push(result);
    } catch (error) {
      logger.error("直播间采样失败", {
        accountName: target.accountName,
        liveWebRid: target.liveWebRid,
        error: error.message
      });
      results.push({
        status: "error",
        target,
        error: error.message
      });
    }
  }

  return results;
}

function pickRoundRobinTargetsByDepartment(targets, departmentCursorState = {}) {
  const grouped = new Map();
  for (const target of normalizeTargets(targets).filter((item) => item.liveWebRid)) {
    const department = String(target.department || "未分组").trim() || "未分组";
    if (!grouped.has(department)) {
      grouped.set(department, []);
    }
    grouped.get(department).push(target);
  }

  const selected = [];
  for (const department of Array.from(grouped.keys()).sort()) {
    const list = grouped.get(department);
    if (!list || list.length === 0) {
      continue;
    }
    const cursor = Number(departmentCursorState[department] || 0);
    const index = ((cursor % list.length) + list.length) % list.length;
    selected.push(list[index]);
    departmentCursorState[department] = (index + 1) % list.length;
  }

  return selected;
}

async function sampleLiveTargetsByDepartment(db, targets, departmentCursorState = {}) {
  const selectedTargets = pickRoundRobinTargetsByDepartment(targets, departmentCursorState);
  const results = [];
  for (const target of selectedTargets) {
    try {
      const result = await sampleSingleLiveTarget(db, target);
      results.push(result);
    } catch (error) {
      logger.error("直播间采样失败", {
        accountName: target.accountName,
        liveWebRid: target.liveWebRid,
        error: error.message
      });
      results.push({
        status: "error",
        target,
        error: error.message
      });
    }
  }
  return results;
}

module.exports = {
  sampleSingleLiveTarget,
  sampleLiveTargets,
  sampleLiveTargetsByDepartment
};
