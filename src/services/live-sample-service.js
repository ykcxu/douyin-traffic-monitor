const logger = require("../logger");
const { normalizeTargets } = require("../core/target-normalizer");
const { insertRoomSnapshot } = require("../db/repositories/snapshot-repository");
const { fetchLiveRoomState } = require("./live-room-page-service");

async function sampleSingleLiveTarget(db, target) {
  if (!target.liveWebRid) {
    return {
      status: "skipped",
      reason: "missing_live_web_rid",
      target
    };
  }

  const liveState = await fetchLiveRoomState(target.liveWebRid);
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
      ttwidCookie: liveState.ttwidCookie
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
  const limit = options.limit || normalizedTargets.length;
  const selectedTargets = normalizedTargets.slice(0, limit);
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
  sampleLiveTargets
};
