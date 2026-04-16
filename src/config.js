const path = require("path");
const fs = require("fs");

function loadDotEnv(rootDir) {
  const envFile = path.join(rootDir, ".env");
  if (!fs.existsSync(envFile)) {
    return;
  }

  const content = fs.readFileSync(envFile, "utf8");
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");
    if (index <= 0) {
      continue;
    }

    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
  }
}

function readNumber(name, fallback) {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readTextFileIfExists(filePath) {
  if (!filePath) {
    return "";
  }
  try {
    const value = fs.readFileSync(filePath, "utf8").trim();
    return value;
  } catch (error) {
    return "";
  }
}

const rootDir = path.join(__dirname, "..");
loadDotEnv(rootDir);

module.exports = {
  app: {
    name: "douyin-traffic-monitor",
    env: process.env.NODE_ENV || "development"
  },
  server: {
    host: process.env.HOST || "0.0.0.0",
    port: readNumber("PORT", 3000)
  },
  paths: {
    rootDir,
    dataDir: path.join(rootDir, "data"),
    docsDir: path.join(rootDir, "docs"),
    storageDir: path.join(rootDir, "storage"),
    runtimeDir: path.join(rootDir, "data", "runtime"),
    databaseFile: path.join(rootDir, "storage", "app.db"),
    targetsFile: path.join(rootDir, "data", "monitor-targets.json"),
    targetsExampleFile: path.join(rootDir, "data", "monitor-targets.example.json")
  },
  scheduler: {
    liveSampleIntervalSec: readNumber("LIVE_SAMPLE_INTERVAL_SEC", 20),
    profileSampleIntervalSec: readNumber("PROFILE_SAMPLE_INTERVAL_SEC", 3600),
    analysisIntervalSec: readNumber("ANALYSIS_INTERVAL_SEC", 300),
    liveSampleBatchSize: readNumber("LIVE_SAMPLE_BATCH_SIZE", 12)
  },
  messages: {
    roomLimit: readNumber("MESSAGE_MONITOR_ROOM_LIMIT", 1),
    roomStaySec: readNumber("MESSAGE_ROOM_STAY_SEC", 30),
    bridgeDurationSec: readNumber("MESSAGE_BRIDGE_DURATION_SEC", 0),
    apiPollIntervalSec: readNumber("MESSAGE_API_POLL_INTERVAL_SEC", 5),
    hotRoomEnterChatPerWindow: readNumber("MESSAGE_HOT_ENTER_CHAT_PER_WINDOW", 15),
    hotRoomMissedEstimateThreshold: readNumber("MESSAGE_HOT_MISSED_ESTIMATE_THRESHOLD", 10),
    hotRoomExitChatPerMin: readNumber("MESSAGE_HOT_EXIT_CHAT_PER_MIN", 5),
    hotRoomExitLowStreak: readNumber("MESSAGE_HOT_EXIT_LOW_STREAK", 3),
    hotRoomMaxDedicatedRooms: readNumber("MESSAGE_HOT_MAX_DEDICATED_ROOMS", 4)
  },
  bridge: {
    pythonBin: process.env.PYTHON_BIN || "python",
    sourceProjectPath:
      process.env.DOUYIN_SPIDER_PATH || path.join(rootDir, "..", "DouYin_Spider"),
    scriptPath: path.join(rootDir, "src", "bridges", "douyin_live_bridge.py"),
    dyLiveCookies:
      process.env.DY_LIVE_COOKIES ||
      readTextFileIfExists(process.env.DY_LIVE_COOKIES_FILE || "")
  },
  authProbe: {
    userInfoUrl: process.env.DY_USER_INFO_URL || "",
    settingUrl: process.env.DY_WEBCAST_SETTING_URL || ""
  },
  focusSpeech: {
    segmentSec: readNumber("FOCUS_SEGMENT_SEC", 60),
    pollIntervalSec: readNumber("FOCUS_POLL_INTERVAL_SEC", 6),
    transcriptsKeep: readNumber("FOCUS_TRANSCRIPTS_KEEP", 300),
    asrCommand: process.env.FOCUS_ASR_COMMAND || "",
    asrModel: process.env.FOCUS_ASR_MODEL || "gpt-4o-mini-transcribe",
    openaiApiKey: process.env.OPENAI_API_KEY || ""
  }
};
