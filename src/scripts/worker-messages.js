const config = require("../config");
const logger = require("../logger");
const { bootstrapProject } = require("../services/bootstrap-service");
const { normalizeTargets } = require("../core/target-normalizer");
const { startBridgeForRoom } = require("../services/message-bridge-service");
const { insertLiveMessage } = require("../db/repositories/message-repository");

function mapBridgeMessageToRow(target, payload) {
  return {
    messageId: payload.messageId || null,
    roomId: payload.roomId || null,
    accountUid: target.accountUid || payload.userId || null,
    eventTime: payload.eventTime || new Date().toISOString(),
    messageType: payload.messageType || payload.eventType || "unknown",
    userId: payload.userId || null,
    userName: payload.userName || null,
    content: payload.content || null,
    giftName: payload.giftName || null,
    giftCount: payload.giftCount || null,
    rawPayload: payload
  };
}

function pickMessageTargets(targets) {
  return normalizeTargets(targets)
    .filter((target) => target.liveWebRid)
    .slice(0, config.messages.roomLimit);
}

function startMessageWorkers(context) {
  const targets = pickMessageTargets(context.targets);
  if (targets.length === 0) {
    logger.warn("没有可用直播间目标，消息 worker 退出");
    process.exit(0);
  }

  if (!config.bridge.dyLiveCookies) {
    logger.error("未配置 DY_LIVE_COOKIES，消息 worker 无法启动");
    process.exit(2);
  }

  for (const target of targets) {
    const child = startBridgeForRoom(target.liveWebRid, {
      onEvent: (payload) => {
        if (payload.type === "message") {
          const row = mapBridgeMessageToRow(target, payload);
          insertLiveMessage(context.db, row);
          logger.info("消息入库", {
            accountName: target.accountName,
            messageType: row.messageType,
            userName: row.userName
          });
          return;
        }

        if (payload.type === "bridge_error") {
          logger.warn("桥接进程错误事件", {
            accountName: target.accountName,
            error: payload.error
          });
          return;
        }

        if (payload.type === "bridge_state") {
          logger.info("桥接状态变化", {
            accountName: target.accountName,
            state: payload.state
          });
        }
      },
      onStderr: (chunk) => {
        logger.warn("桥接 stderr", {
          accountName: target.accountName,
          stderr: String(chunk).trim().slice(0, 500)
        });
      },
      onExit: (code, signal) => {
        logger.warn("桥接进程退出", {
          accountName: target.accountName,
          code,
          signal
        });
      },
      onError: (error) => {
        logger.error("桥接进程异常", {
          accountName: target.accountName,
          error: error.message
        });
      }
    });

    logger.info("消息 worker 已连接直播间", {
      accountName: target.accountName,
      liveWebRid: target.liveWebRid,
      pid: child.pid
    });
  }
}

function main() {
  const context = bootstrapProject();
  startMessageWorkers(context);
}

main();
