const fs = require("fs");
const path = require("path");
const config = require("./config");
const { ensureDir } = require("./utils/fs");
const { nowIso } = require("./utils/time");

const logsDir = path.join(config.paths.runtimeDir, "logs");
ensureDir(logsDir);

function writeLine(level, message, meta = {}) {
  const payload = {
    time: nowIso(),
    level,
    message,
    ...meta
  };

  const line = JSON.stringify(payload);
  const date = payload.time.slice(0, 10);
  const filePath = path.join(logsDir, `${date}.log`);
  fs.appendFileSync(filePath, `${line}\n`, "utf8");
  console.log(`[${level.toUpperCase()}] ${message}`);
}

module.exports = {
  info(message, meta) {
    writeLine("info", message, meta);
  },
  warn(message, meta) {
    writeLine("warn", message, meta);
  },
  error(message, meta) {
    writeLine("error", message, meta);
  }
};
