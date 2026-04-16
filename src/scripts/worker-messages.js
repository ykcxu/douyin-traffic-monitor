const crypto = require("crypto");
const config = require("../config");
const logger = require("../logger");
const { bootstrapProject } = require("../services/bootstrap-service");
const { normalizeTargets } = require("../core/target-normalizer");
const { fetchLiveRoomStateViaApi } = require("../services/live-room-page-service");
const { insertLiveMessage } = require("../db/repositories/message-repository");

function pickMessageTargets(targets) {
  return normalizeTargets(targets)
    .filter((target) => target.liveWebRid)
    .slice(0, config.messages.roomLimit);
}

function toChatItems(roomData) {
  const rows = roomData?.preview_expose?.chat_msgs;
  return Array.isArray(rows) ? rows : [];
}

function toText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text ? text : null;
}

function pickFirst(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function toPreviewMessageRow(target, liveState, chatItem) {
  const item = chatItem || {};
  const content =
    toText(
      pickFirst(item, [
        "content",
        "msg",
        "comment",
        "comment_content",
        "text",
        "display_text",
        "message"
      ])
    ) || toText(JSON.stringify(item).slice(0, 300));

  const userName = toText(
    pickFirst(item, [
      "user_name",
      "nickname",
      "nick_name",
      "name",
      "username",
      "display_name",
      "user.nickname"
    ])
  );
  const userId = toText(pickFirst(item, ["user_id", "uid", "sec_uid", "id", "userId"]));
  const rawId = pickFirst(item, ["msg_id", "message_id", "id", "id_str"]);
  const messageId =
    toText(rawId) ||
    crypto
      .createHash("md5")
      .update(`${target.accountUid || target.accountName}-${content || ""}-${JSON.stringify(item)}`)
      .digest("hex");

  return {
    messageId: `preview-${messageId}`,
    roomId: liveState.roomId || null,
    accountUid: target.accountUid || liveState.userId || null,
    eventTime: new Date().toISOString(),
    messageType: "PreviewChatMessage",
    userId: userId || null,
    userName: userName || target.accountName,
    content: content || null,
    giftName: null,
    giftCount: null,
    rawPayload: {
      source: "webcast_room_enter_api",
      liveWebRid: target.liveWebRid,
      chatItem: item
    }
  };
}

function shouldKeepMessage(row) {
  const content = row.content || "";
  if (!content || content === "{}" || content.length < 2) {
    return false;
  }
  return true;
}

function createSeenCache() {
  return new Map();
}

function isSeen(seenCache, messageId) {
  return seenCache.has(messageId);
}

function markSeen(seenCache, messageId) {
  seenCache.set(messageId, Date.now());
  if (seenCache.size > 3000) {
    const oldest = [...seenCache.entries()].sort((a, b) => a[1] - b[1]).slice(0, 500);
    for (const [key] of oldest) {
      seenCache.delete(key);
    }
  }
}

function createPulseMessage(target, liveState, previousState) {
  const status = liveState.statusText || "unknown";
  const online = liveState.userCount ?? 0;
  const like = liveState.likeCount ?? 0;
  const previousText = previousState
    ? `（上次: 状态${previousState.statusText}, 在线${previousState.onlineCount}, 点赞${previousState.likeCount}）`
    : "";

  return {
    messageId: `pulse-${target.liveWebRid}-${Date.now()}`,
    roomId: liveState.roomId || null,
    accountUid: target.accountUid || liveState.userId || null,
    eventTime: new Date().toISOString(),
    messageType: "ApiRoomPulse",
    userId: null,
    userName: target.accountName,
    content: `状态:${status} 在线:${online} 点赞:${like}${previousText}`,
    giftName: null,
    giftCount: null,
    rawPayload: {
      source: "webcast_room_enter_api",
      liveWebRid: target.liveWebRid,
      status: status,
      onlineCount: online,
      likeCount: like
    }
  };
}

function toStateSnapshot(liveState) {
  return {
    statusText: liveState.statusText || "unknown",
    onlineCount: liveState.userCount ?? 0,
    likeCount: liveState.likeCount ?? 0
  };
}

function stateChanged(previous, current) {
  if (!previous) {
    return true;
  }
  return (
    previous.statusText !== current.statusText ||
    previous.onlineCount !== current.onlineCount ||
    previous.likeCount !== current.likeCount
  );
}

async function runSingleCycle(context, seenCache, stateCache) {
  const targets = pickMessageTargets(context.targets);
  if (targets.length === 0) {
    logger.warn("没有可用直播间目标，消息 worker 等待下一轮");
    return;
  }

  let inserted = 0;
  for (const target of targets) {
    try {
      const liveState = await fetchLiveRoomStateViaApi(target.liveWebRid);
      const chats = toChatItems(liveState.roomData);

      for (const chatItem of chats) {
        const row = toPreviewMessageRow(target, liveState, chatItem);
        if (!shouldKeepMessage(row) || isSeen(seenCache, row.messageId)) {
          continue;
        }
        insertLiveMessage(context.db, row);
        markSeen(seenCache, row.messageId);
        inserted += 1;
      }

      const currentState = toStateSnapshot(liveState);
      const previousState = stateCache.get(target.liveWebRid);
      if (stateChanged(previousState, currentState)) {
        insertLiveMessage(context.db, createPulseMessage(target, liveState, previousState));
        inserted += 1;
      }
      stateCache.set(target.liveWebRid, currentState);
    } catch (error) {
      logger.warn("消息轮询失败", {
        accountName: target.accountName,
        liveWebRid: target.liveWebRid,
        error: error.message
      });
    }
  }

  logger.info("消息轮询完成", {
    targets: targets.length,
    inserted
  });
}

async function startLoop() {
  const context = bootstrapProject();
  const seenCache = createSeenCache();
  const stateCache = new Map();
  await runSingleCycle(context, seenCache, stateCache);

  setInterval(async () => {
    try {
      await runSingleCycle(context, seenCache, stateCache);
    } catch (error) {
      logger.error("消息轮询异常", {
        error: error.message
      });
    }
  }, config.messages.apiPollIntervalSec * 1000);
}

startLoop().catch((error) => {
  logger.error("消息 worker 启动失败", {
    error: error.message
  });
  process.exit(1);
});
