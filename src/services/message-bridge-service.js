const { spawn } = require("child_process");
const config = require("../config");
const logger = require("../logger");

function buildBridgeArgs(liveWebRid) {
  const args = [
    config.bridge.scriptPath,
    "--live-id",
    liveWebRid,
    "--source-root",
    config.bridge.sourceProjectPath,
    "--cookies",
    config.bridge.dyLiveCookies
  ];

  if (config.messages.bridgeDurationSec > 0) {
    args.push("--duration", String(config.messages.bridgeDurationSec));
  }

  return args;
}

function startBridgeForRoom(liveWebRid, handlers = {}) {
  const args = buildBridgeArgs(liveWebRid);
  logger.info("启动消息桥接进程", {
    liveWebRid,
    pythonBin: config.bridge.pythonBin
  });

  const child = spawn(config.bridge.pythonBin, args, {
    cwd: config.paths.rootDir,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const payload = JSON.parse(trimmed);
        handlers.onEvent && handlers.onEvent(payload);
      } catch (error) {
        logger.warn("解析桥接消息失败", {
          error: error.message,
          line: trimmed.slice(0, 300)
        });
      }
    }
  });

  child.stderr.on("data", (chunk) => {
    handlers.onStderr && handlers.onStderr(chunk);
  });

  child.on("exit", (code, signal) => {
    handlers.onExit && handlers.onExit(code, signal);
  });

  child.on("error", (error) => {
    handlers.onError && handlers.onError(error);
  });

  return child;
}

module.exports = {
  startBridgeForRoom
};
