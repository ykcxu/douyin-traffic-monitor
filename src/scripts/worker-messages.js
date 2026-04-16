const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const config = require("../config");
const logger = require("../logger");
const { bootstrapProject } = require("../services/bootstrap-service");
const { normalizeTargets } = require("../core/target-normalizer");
const { fetchLiveRoomStateViaApi } = require("../services/live-room-page-service");
const { startBridgeForRoom } = require("../services/message-bridge-service");
const { insertLiveMessage } = require("../db/repositories/message-repository");
const { listLatestSnapshotByAccount } = require("../db/repositories/snapshot-repository");
const pidFile = path.join(config.paths.runtimeDir, "message-worker.pid");
const statusFile = path.join(config.paths.runtimeDir, "message-worker-status.json");

function writePidFile() {
  try {
    fs.writeFileSync(pidFile, String(process.pid), "utf8");
  } catch (error) {
    logger.warn("消息 worker 写入 PID 文件失败", {
      error: error.message
    });
  }
}

function cleanupPidFile() {
  try {
    if (fs.existsSync(pidFile)) {
      const current = fs.readFileSync(pidFile, "utf8").trim();
      if (String(process.pid) === current) {
        fs.unlinkSync(pidFile);
      }
    }
  } catch (error) {
    logger.warn("消息 worker 清理 PID 文件失败", {
      error: error.message
    });
  }
}

function writeWorkerStatusSnapshot(snapshot) {
  try {
    fs.writeFileSync(statusFile, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (error) {
    logger.warn("消息 worker 状态写入失败", {
      error: error.message
    });
  }
}

function buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, extra = {}) {
  const now = Date.now();
  const dedicatedRooms = [...dedicatedState.bridges.values()].map((item) => {
    const evalElapsedMs = Math.max(1, now - Number(item.stats?.evalAtMs || now));
    const ratePerMin = (Number(item.stats?.chatSinceEval || 0) * 60000) / evalElapsedMs;
    return {
      liveWebRid: item.target.liveWebRid,
      accountName: item.target.accountName,
      category: item.target.category || "",
      department: item.target.department || "",
      startedAt: new Date(Number(item.stats?.startedAtMs || now)).toISOString(),
      recentChatPerMin: Number(ratePerMin.toFixed(2)),
      totalChat: Number(item.stats?.totalChat || 0),
      lowStreak: Number(item.stats?.lowStreak || 0)
    };
  });

  return {
    time: new Date().toISOString(),
    pid: process.pid,
    running: true,
    rotatingCurrent: bridgeState.current
      ? {
          liveWebRid: bridgeState.current.liveWebRid,
          accountName: bridgeState.current.accountName
        }
      : null,
    dedicatedRooms,
    dedicatedCount: dedicatedRooms.length,
    cursor: {
      nextIndex: Number(cursorState.nextIndex || 0),
      lastAccountName: cursorState.lastAccountName || null
    },
    ...extra
  };
}

function pickMessageTargets(db, targets) {
  const normalized = normalizeTargets(targets).filter((target) => target.liveWebRid);
  if (normalized.length <= 1) {
    return normalized;
  }

  const targetByAccount = new Map(normalized.map((item) => [item.accountName, item]));
  const latest = listLatestSnapshotByAccount(db) || [];
  const liveFirst = latest
    .filter((item) => Number(item.isLive) === 1 && targetByAccount.has(item.accountName))
    .sort((a, b) => Number(b.onlineCount || 0) - Number(a.onlineCount || 0))
    .map((item) => targetByAccount.get(item.accountName));

  const ordered = [];
  const seen = new Set();
  for (const target of liveFirst) {
    if (!target || seen.has(target.accountName)) {
      continue;
    }
    ordered.push(target);
    seen.add(target.accountName);
  }

  for (const target of normalized) {
    if (seen.has(target.accountName)) {
      continue;
    }
    ordered.push(target);
    seen.add(target.accountName);
  }

  return ordered;
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

function toBridgeMessageRow(target, event) {
  const eventType = String(event?.eventType || "").trim();
  let normalizedType = "BridgeMessage";
  if (eventType === "chat") {
    normalizedType = "BridgeChatMessage";
  } else if (eventType === "like") {
    normalizedType = "BridgeLikeMessage";
  } else if (eventType === "member") {
    normalizedType = "BridgeMemberMessage";
  } else if (eventType === "gift") {
    normalizedType = "BridgeGiftMessage";
  } else if (eventType === "follow") {
    normalizedType = "BridgeFollowMessage";
  } else if (eventType === "room_stats") {
    normalizedType = "BridgeRoomStatsMessage";
  }

  const fallbackContent =
    toText(event?.content) || toText(event?.messageType) || toText(JSON.stringify(event).slice(0, 300));
  const rawMessageId = toText(event?.messageId);
  const stableId =
    rawMessageId ||
    crypto
      .createHash("md5")
      .update(`${target.accountUid || target.accountName}-${normalizedType}-${fallbackContent || ""}`)
      .digest("hex");

  return {
    messageId: `bridge-${stableId}`,
    roomId: toText(event?.roomId) || null,
    accountUid: target.accountUid || null,
    eventTime: event?.eventTime || new Date().toISOString(),
    messageType: normalizedType,
    userId: toText(event?.userId) || null,
    userName: toText(event?.userName) || target.accountName,
    content: fallbackContent || null,
    giftName: toText(event?.giftName) || null,
    giftCount: Number.isFinite(Number(event?.giftCount)) ? Number(event.giftCount) : null,
    rawPayload: {
      source: "bridge_websocket",
      liveWebRid: target.liveWebRid,
      event
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

function stopActiveBridge(bridgeState, reason = "manual_stop") {
  if (!bridgeState.current) {
    return;
  }
  const { child, liveWebRid } = bridgeState.current;
  logger.info("停止消息桥接进程", {
    liveWebRid,
    reason
  });
  try {
    child.kill("SIGTERM");
  } catch (error) {
    logger.warn("停止消息桥接失败", {
      liveWebRid,
      error: error.message
    });
  } finally {
    bridgeState.current = null;
  }
}

function ensureBridgeForTarget(context, bridgeState, seenCache, target, options = {}) {
  const role = options.role || "rotating";
  const onBridgeMessage = typeof options.onBridgeMessage === "function" ? options.onBridgeMessage : null;
  if (!target || !target.liveWebRid) {
    stopActiveBridge(bridgeState, "no_live_target");
    return;
  }

  if (bridgeState.current?.liveWebRid === target.liveWebRid) {
    return;
  }

  stopActiveBridge(bridgeState, "switch_target");
  logger.info("拉起消息桥接进程", {
    liveWebRid: target.liveWebRid,
    accountName: target.accountName,
    role
  });

  const child = startBridgeForRoom(target.liveWebRid, {
    onEvent: (payload) => {
      if (!payload) {
        return;
      }
      if (payload.type === "bridge_state") {
        logger.info("桥接状态", {
          liveWebRid: target.liveWebRid,
          state: payload.state,
          statusCode: payload.statusCode || null,
          closeMsg: payload.closeMsg || null
        });
        return;
      }
      if (payload.type === "bridge_error") {
        logger.warn("桥接上报错误", {
          liveWebRid: target.liveWebRid,
          error: payload.error || "unknown",
          hint: payload.hint || null
        });
        return;
      }
      if (payload.type !== "message") {
        return;
      }
      const row = toBridgeMessageRow(target, payload);
      if (!shouldKeepMessage(row) || isSeen(seenCache, row.messageId)) {
        return;
      }
      insertLiveMessage(context.db, row);
      markSeen(seenCache, row.messageId);
      if (onBridgeMessage) {
        onBridgeMessage(row, payload);
      }
    },
    onStderr: (chunk) => {
      const text = String(chunk || "").trim();
      if (!text) {
        return;
      }
      logger.warn("桥接 stderr", {
        liveWebRid: target.liveWebRid,
        role,
        stderr: text.slice(0, 300)
      });
    },
    onExit: (code, signal) => {
      logger.warn("消息桥接进程退出", {
        liveWebRid: target.liveWebRid,
        role,
        code,
        signal
      });
      if (bridgeState.current?.child === child) {
        bridgeState.current = null;
      }
    },
    onError: (error) => {
      logger.warn("消息桥接进程异常", {
        liveWebRid: target.liveWebRid,
        role,
        error: error.message
      });
    }
  });

  bridgeState.current = {
    liveWebRid: target.liveWebRid,
    accountName: target.accountName,
    child
  };
}

function stopDedicatedBridge(dedicatedState, liveWebRid, reason = "manual_stop") {
  const item = dedicatedState.bridges.get(liveWebRid);
  if (!item) {
    return;
  }
  logger.info("停止热房常驻桥接", {
    liveWebRid,
    accountName: item.target.accountName,
    reason
  });
  try {
    item.child.kill("SIGTERM");
  } catch (error) {
    logger.warn("停止热房常驻桥接失败", {
      liveWebRid,
      error: error.message
    });
  }
  dedicatedState.bridges.delete(liveWebRid);
}

function createDedicatedStats() {
  return {
    chatSinceEval: 0,
    evalAtMs: Date.now(),
    lowStreak: 0,
    totalChat: 0,
    startedAtMs: Date.now()
  };
}

function startDedicatedBridge(context, dedicatedState, seenCache, target, reason, detail = {}) {
  if (!target?.liveWebRid) {
    return false;
  }
  if (dedicatedState.bridges.has(target.liveWebRid)) {
    return true;
  }

  const maxDedicated = Math.max(1, Number(config.messages.hotRoomMaxDedicatedRooms || 2));
  if (dedicatedState.bridges.size >= maxDedicated) {
    logger.info("热房常驻桥接已达上限，跳过本次升级", {
      accountName: target.accountName,
      liveWebRid: target.liveWebRid,
      maxDedicated,
      reason,
      detail
    });
    return false;
  }

  logger.info("升级为热房常驻桥接", {
    accountName: target.accountName,
    liveWebRid: target.liveWebRid,
    reason,
    detail
  });

  const stats = createDedicatedStats();
  const child = startBridgeForRoom(target.liveWebRid, {
    onEvent: (payload) => {
      if (!payload) {
        return;
      }
      if (payload.type === "bridge_state") {
        logger.info("热房桥接状态", {
          liveWebRid: target.liveWebRid,
          accountName: target.accountName,
          state: payload.state,
          statusCode: payload.statusCode || null,
          closeMsg: payload.closeMsg || null
        });
        return;
      }
      if (payload.type === "bridge_error") {
        logger.warn("热房桥接上报错误", {
          liveWebRid: target.liveWebRid,
          accountName: target.accountName,
          error: payload.error || "unknown",
          hint: payload.hint || null
        });
        return;
      }
      if (payload.type !== "message") {
        return;
      }

      const row = toBridgeMessageRow(target, payload);
      if (!shouldKeepMessage(row) || isSeen(seenCache, row.messageId)) {
        return;
      }
      insertLiveMessage(context.db, row);
      markSeen(seenCache, row.messageId);

      if (row.messageType === "BridgeChatMessage") {
        stats.chatSinceEval += 1;
        stats.totalChat += 1;
      }
    },
    onStderr: (chunk) => {
      const text = String(chunk || "").trim();
      if (!text) {
        return;
      }
      logger.warn("热房桥接 stderr", {
        liveWebRid: target.liveWebRid,
        accountName: target.accountName,
        stderr: text.slice(0, 300)
      });
    },
    onExit: (code, signal) => {
      logger.warn("热房桥接进程退出", {
        liveWebRid: target.liveWebRid,
        accountName: target.accountName,
        code,
        signal
      });
      const current = dedicatedState.bridges.get(target.liveWebRid);
      if (current?.child === child) {
        dedicatedState.bridges.delete(target.liveWebRid);
      }
    },
    onError: (error) => {
      logger.warn("热房桥接进程异常", {
        liveWebRid: target.liveWebRid,
        accountName: target.accountName,
        error: error.message
      });
    }
  });

  dedicatedState.bridges.set(target.liveWebRid, {
    target,
    child,
    stats
  });
  return true;
}

function evaluateDedicatedBridges(dedicatedState) {
  const exitRatePerMin = Math.max(1, Number(config.messages.hotRoomExitChatPerMin || 8));
  const lowStreakNeed = Math.max(1, Number(config.messages.hotRoomExitLowStreak || 2));
  const now = Date.now();

  for (const [liveWebRid, item] of dedicatedState.bridges.entries()) {
    const elapsedMs = now - item.stats.evalAtMs;
    if (elapsedMs < 20000) {
      continue;
    }
    const elapsedMin = elapsedMs / 60000;
    const ratePerMin = item.stats.chatSinceEval / Math.max(elapsedMin, 0.01);
    if (ratePerMin <= exitRatePerMin) {
      item.stats.lowStreak += 1;
    } else {
      item.stats.lowStreak = 0;
    }

    logger.info("热房桥接频率评估", {
      liveWebRid,
      accountName: item.target.accountName,
      ratePerMin: Number(ratePerMin.toFixed(2)),
      threshold: exitRatePerMin,
      lowStreak: item.stats.lowStreak,
      lowStreakNeed
    });

    item.stats.chatSinceEval = 0;
    item.stats.evalAtMs = now;

    if (item.stats.lowStreak >= lowStreakNeed) {
      stopDedicatedBridge(dedicatedState, liveWebRid, "low_frequency");
    }
  }
}

function selectRotatingTargets(allTargets, dedicatedState) {
  const list = allTargets.filter((target) => !dedicatedState.bridges.has(target.liveWebRid));
  if (list.length > 0) {
    return list;
  }
  return allTargets;
}

function shouldPromoteDedicated(target, summary, previous) {
  const enterChatPerWindow = Math.max(1, Number(config.messages.hotRoomEnterChatPerWindow || 30));
  const missedEstimateThreshold = Math.max(
    1,
    Number(config.messages.hotRoomMissedEstimateThreshold || 25)
  );

  const windowHeavy = summary.bridgeChatCount >= enterChatPerWindow;
  let estimatedMissed = 0;
  if (previous) {
    const previousRate = previous.bridgeChatCount / Math.max(previous.windowSec || 1, 1);
    const gapSec = Math.max(0, (summary.startedAtMs - previous.endedAtMs) / 1000);
    estimatedMissed = previousRate * gapSec;
  }
  const continuityBroken = !!previous && estimatedMissed >= missedEstimateThreshold;

  return {
    promote: windowHeavy || continuityBroken,
    reason: windowHeavy ? "high_chat_frequency" : continuityBroken ? "continuity_gap_estimated" : "",
    detail: {
      bridgeChatCount: summary.bridgeChatCount,
      enterChatPerWindow,
      estimatedMissed: Number(estimatedMissed.toFixed(2)),
      missedEstimateThreshold
    }
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickNextTarget(targets, cursorState) {
  if (!Array.isArray(targets) || targets.length === 0) {
    cursorState.nextIndex = 0;
    cursorState.lastAccountName = null;
    return null;
  }

  const preferredIndex = targets.findIndex((target) => target.accountName === cursorState.lastAccountName);
  if (preferredIndex >= 0) {
    cursorState.nextIndex = (preferredIndex + 1) % targets.length;
  } else if (!Number.isInteger(cursorState.nextIndex) || cursorState.nextIndex < 0) {
    cursorState.nextIndex = 0;
  } else {
    cursorState.nextIndex = cursorState.nextIndex % targets.length;
  }

  const target = targets[cursorState.nextIndex];
  cursorState.lastAccountName = target?.accountName || null;
  cursorState.nextIndex = (cursorState.nextIndex + 1) % targets.length;
  return target || null;
}

async function sampleTargetOnce(context, seenCache, stateCache, target) {
  let inserted = 0;
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

  return {
    inserted,
    isLive: liveState.statusText === "live"
  };
}

async function runTargetWindow(context, seenCache, stateCache, bridgeState, target, shouldStopRef) {
  const stayMs = Math.max(5000, Number(config.messages.roomStaySec || 30) * 1000);
  const pollMs = Math.max(2000, Number(config.messages.apiPollIntervalSec || 8) * 1000);
  const startedAt = Date.now();
  let inserted = 0;
  let sampled = 0;
  let bridgeChatCount = 0;

  logger.info("开始驻留采样", {
    accountName: target.accountName,
    liveWebRid: target.liveWebRid,
    staySec: Math.floor(stayMs / 1000),
    pollSec: Math.floor(pollMs / 1000)
  });

  ensureBridgeForTarget(context, bridgeState, seenCache, target, {
    role: "rotating",
    onBridgeMessage: (row) => {
      if (row.messageType === "BridgeChatMessage") {
        bridgeChatCount += 1;
      }
    }
  });

  while (!shouldStopRef.value && Date.now() - startedAt < stayMs) {
    try {
      const result = await sampleTargetOnce(context, seenCache, stateCache, target);
      inserted += result.inserted;
      sampled += 1;
      if (!result.isLive) {
        stopActiveBridge(bridgeState, "target_offline_in_window");
      } else {
        ensureBridgeForTarget(context, bridgeState, seenCache, target, {
          role: "rotating",
          onBridgeMessage: (row) => {
            if (row.messageType === "BridgeChatMessage") {
              bridgeChatCount += 1;
            }
          }
        });
      }
    } catch (error) {
      logger.warn("驻留采样失败", {
        accountName: target.accountName,
        liveWebRid: target.liveWebRid,
        error: error.message
      });
    }

    const remainMs = stayMs - (Date.now() - startedAt);
    if (remainMs <= 0 || shouldStopRef.value) {
      break;
    }
    await sleep(Math.min(pollMs, remainMs));
  }

  stopActiveBridge(bridgeState, "window_completed");
  logger.info("结束驻留采样", {
    accountName: target.accountName,
    liveWebRid: target.liveWebRid,
    sampled,
    inserted,
    bridgeChatCount
  });

  return {
    startedAtMs: startedAt,
    endedAtMs: Date.now(),
    windowSec: stayMs / 1000,
    sampled,
    inserted,
    bridgeChatCount
  };
}

async function startLoop() {
  writePidFile();
  const shouldStopRef = {
    value: false
  };
  const dedicatedState = {
    bridges: new Map()
  };
  const roomWindowState = new Map();
  let bridgeState = {
    current: null
  };
  const shutdown = () => {
    shouldStopRef.value = true;
    stopActiveBridge(bridgeState, "shutdown");
    for (const liveWebRid of dedicatedState.bridges.keys()) {
      stopDedicatedBridge(dedicatedState, liveWebRid, "shutdown");
    }
    writeWorkerStatusSnapshot({
      time: new Date().toISOString(),
      pid: process.pid,
      running: false,
      reason: "shutdown",
      rotatingCurrent: null,
      dedicatedRooms: [],
      dedicatedCount: 0
    });
    cleanupPidFile();
  };

  process.on("exit", cleanupPidFile);
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  const context = bootstrapProject();
  const seenCache = createSeenCache();
  const stateCache = new Map();
  const cursorState = {
    nextIndex: 0,
    lastAccountName: null
  };
  writeWorkerStatusSnapshot(
    buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, {
      reason: "started"
    })
  );
  while (!shouldStopRef.value) {
    evaluateDedicatedBridges(dedicatedState);
    writeWorkerStatusSnapshot(
      buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, {
        phase: "evaluate"
      })
    );

    const allTargets = pickMessageTargets(context.db, context.targets);
    if (allTargets.length === 0) {
      logger.warn("没有可用直播间目标，消息 worker 暂停 10 秒");
      stopActiveBridge(bridgeState, "empty_targets");
      writeWorkerStatusSnapshot(
        buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, {
          phase: "idle",
          reason: "empty_targets"
        })
      );
      await sleep(10000);
      continue;
    }

    const rotatingTargets = selectRotatingTargets(allTargets, dedicatedState);
    const target = pickNextTarget(rotatingTargets, cursorState);
    if (!target) {
      writeWorkerStatusSnapshot(
        buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, {
          phase: "idle",
          reason: "no_target"
        })
      );
      await sleep(5000);
      continue;
    }
    writeWorkerStatusSnapshot(
      buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, {
        phase: "window_start",
        target: {
          liveWebRid: target.liveWebRid,
          accountName: target.accountName,
          department: target.department || ""
        }
      })
    );

    try {
      const summary = await runTargetWindow(
        context,
        seenCache,
        stateCache,
        bridgeState,
        target,
        shouldStopRef
      );
      const previous = roomWindowState.get(target.liveWebRid) || null;
      roomWindowState.set(target.liveWebRid, summary);
      if (!dedicatedState.bridges.has(target.liveWebRid)) {
        const decision = shouldPromoteDedicated(target, summary, previous);
        if (decision.promote) {
          startDedicatedBridge(
            context,
            dedicatedState,
            seenCache,
            target,
            decision.reason,
            decision.detail
          );
        }
      }
      evaluateDedicatedBridges(dedicatedState);
      writeWorkerStatusSnapshot(
        buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, {
          phase: "window_done",
          target: {
            liveWebRid: target.liveWebRid,
            accountName: target.accountName
          },
          bridgeChatCount: summary.bridgeChatCount,
          sampled: summary.sampled
        })
      );
    } catch (error) {
      logger.error("消息驻留窗口异常", {
        accountName: target.accountName,
        liveWebRid: target.liveWebRid,
        error: error.message
      });
      stopActiveBridge(bridgeState, "window_error");
      writeWorkerStatusSnapshot(
        buildWorkerStatusSnapshot(dedicatedState, bridgeState, cursorState, {
          phase: "window_error",
          target: {
            liveWebRid: target.liveWebRid,
            accountName: target.accountName
          },
          error: error.message
        })
      );
      await sleep(3000);
    }
  }
}

startLoop().catch((error) => {
  logger.error("消息 worker 启动失败", {
    error: error.message
  });
  process.exit(1);
});
