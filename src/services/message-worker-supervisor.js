const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");
const logger = require("../logger");

const pidFile = path.join(config.paths.runtimeDir, "message-worker.pid");

function readPid() {
  if (!fs.existsSync(pidFile)) {
    return null;
  }
  const text = fs.readFileSync(pidFile, "utf8").trim();
  const pid = Number(text);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isPidRunning(pid) {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function isMessageWorkerRunning() {
  const pid = readPid();
  return {
    running: isPidRunning(pid),
    pid
  };
}

function startMessageWorkerIfNeeded() {
  const current = isMessageWorkerRunning();
  if (current.running) {
    return {
      started: false,
      pid: current.pid,
      reason: "already_running"
    };
  }

  if (!config.bridge.dyLiveCookies) {
    return {
      started: false,
      pid: null,
      reason: "missing_dy_live_cookies"
    };
  }

  const child = spawn(process.execPath, ["src/scripts/worker-messages.js"], {
    cwd: config.paths.rootDir,
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf8");

  logger.info("已触发消息 worker 恢复启动", {
    pid: child.pid
  });

  return {
    started: true,
    pid: child.pid,
    reason: "started"
  };
}

module.exports = {
  isMessageWorkerRunning,
  startMessageWorkerIfNeeded
};
