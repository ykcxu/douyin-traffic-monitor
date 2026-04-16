function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function buildDerivedMessagesFromSnapshots(target, previousSnapshot, currentSnapshot) {
  if (!previousSnapshot || !currentSnapshot) {
    return [];
  }

  const prevOnline = toNum(previousSnapshot.onlineCount);
  const currOnline = toNum(currentSnapshot.onlineCount);
  const prevLike = toNum(previousSnapshot.likeCount);
  const currLike = toNum(currentSnapshot.likeCount);
  const prevLive = Number(previousSnapshot.isLive) === 1;
  const currLive = Number(currentSnapshot.isLive) === 1;

  const messages = [];
  const eventTime = currentSnapshot.sampleTime || new Date().toISOString();
  const roomId = currentSnapshot.roomId || previousSnapshot.roomId || null;
  const accountUid = target.accountUid || currentSnapshot.accountUid || null;

  if (currLive !== prevLive) {
    messages.push({
      messageType: "DerivedLiveStatus",
      content: currLive ? "直播状态变更：开播" : "直播状态变更：下播",
      roomId,
      accountUid,
      eventTime,
      rawPayload: {
        derived: true,
        metric: "is_live",
        previous: prevLive ? 1 : 0,
        current: currLive ? 1 : 0
      }
    });
  }

  const onlineDelta = currOnline - prevOnline;
  if (onlineDelta !== 0) {
    messages.push({
      messageType: "DerivedOnlineDelta",
      content: `在线人数变化 ${onlineDelta > 0 ? "+" : ""}${onlineDelta}（${prevOnline} -> ${currOnline}）`,
      roomId,
      accountUid,
      eventTime,
      rawPayload: {
        derived: true,
        metric: "online_count",
        delta: onlineDelta,
        previous: prevOnline,
        current: currOnline
      }
    });
  }

  const likeDelta = currLike - prevLike;
  if (likeDelta !== 0) {
    messages.push({
      messageType: "DerivedLikeDelta",
      content: `点赞数变化 ${likeDelta > 0 ? "+" : ""}${likeDelta}（${prevLike} -> ${currLike}）`,
      roomId,
      accountUid,
      eventTime,
      rawPayload: {
        derived: true,
        metric: "like_count",
        delta: likeDelta,
        previous: prevLike,
        current: currLike
      }
    });
  }

  return messages;
}

module.exports = {
  buildDerivedMessagesFromSnapshots
};
