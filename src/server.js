const http = require("http");
const fs = require("fs");
const pathModule = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { URL } = require("url");
const config = require("./config");
const { bootstrapProject } = require("./services/bootstrap-service");
const { buildDepartmentComparison, buildCompetitorComparison } = require("./services/analysis-service");
const { buildDepartmentComparisonView, buildInternalVsCompetitorView } = require("./services/comparison-service");
const { buildDepartmentLiveAvgSeries } = require("./services/chart-service");
const { buildDailyInsights } = require("./services/insight-service");
const { getBusinessDayWindow } = require("./utils/business-day");
const { getAuthDiagnostics } = require("./services/auth-diagnostics-service");
const { startMessageWorkerIfNeeded, isMessageWorkerRunning } = require("./services/message-worker-supervisor");
const {
  listRecentRoomSnapshots,
  listLatestSnapshotByAccount,
  getRecentRestrictionStats
} = require("./db/repositories/snapshot-repository");
const { listRecentLiveMessages, countLiveMessages } = require("./db/repositories/message-repository");
const { normalizeTargets } = require("./core/target-normalizer");
const { fetchLiveRoomStateViaApi } = require("./services/live-room-page-service");
const logger = require("./logger");

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function writeFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store"
    });
    res.end(content);
  } catch (error) {
    writeJson(res, 404, { error: "not_found", filePath });
  }
}

function readRecentLogs(limit = 100) {
  const logsDir = pathModule.join(config.paths.runtimeDir, "logs");
  if (!fs.existsSync(logsDir)) {
    return [];
  }

  const files = fs
    .readdirSync(logsDir)
    .filter((name) => name.endsWith(".log"))
    .sort((a, b) => b.localeCompare(a, "en"));
  if (files.length === 0) {
    return [];
  }

  const latestFile = pathModule.join(logsDir, files[0]);
  const lines = fs.readFileSync(latestFile, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = lines.slice(-limit).reverse();

  return selected.map((line) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      return {
        time: new Date().toISOString(),
        level: "info",
        message: line
      };
    }
  });
}

function readMessageWorkerStatus() {
  const statusPath = pathModule.join(config.paths.runtimeDir, "message-worker-status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      running: false,
      dedicatedRooms: [],
      dedicatedCount: 0
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    return {
      running: Boolean(payload?.running),
      time: payload?.time || null,
      phase: payload?.phase || null,
      rotatingCurrent: payload?.rotatingCurrent || null,
      dedicatedRooms: Array.isArray(payload?.dedicatedRooms) ? payload.dedicatedRooms : [],
      dedicatedCount: Number(payload?.dedicatedCount || 0)
    };
  } catch (error) {
    return {
      running: false,
      error: "status_parse_failed",
      dedicatedRooms: [],
      dedicatedCount: 0
    };
  }
}

function readLiveWorkerStatus() {
  const statusPath = pathModule.join(config.paths.runtimeDir, "live-worker-status.json");
  if (!fs.existsSync(statusPath)) {
    return {
      running: false,
      time: null,
      phase: "missing"
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    return {
      running: Boolean(payload?.running),
      time: payload?.time || null,
      phase: payload?.phase || null,
      cycleDurationMs: Number(payload?.cycleDurationMs || 0),
      cycle: payload?.cycle || null,
      pid: payload?.pid || null,
      error: payload?.error || null
    };
  } catch (error) {
    return {
      running: false,
      time: null,
      phase: "parse_failed",
      error: error.message
    };
  }
}

function readJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return {};
  }
}

function tailJsonLines(filePath, limit = 200) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  return lines
    .slice(-Math.max(1, Number(limit || 200)))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean)
    .reverse();
}

function appendJsonLine(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function ageSecondsFromIso(iso) {
  if (!iso) {
    return null;
  }
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.max(0, Math.round((Date.now() - ms) / 1000));
}

function startSystemHealthMonitor(context) {
  const intervalMs = 60 * 1000;
  const staleWarnSec = 180;
  const timer = setInterval(() => {
    try {
      const liveStatus = readLiveWorkerStatus();
      const messageStatus = readMessageWorkerStatus();
      const focusState = context.focusMonitor.readState();
      const focusRooms = Array.isArray(focusState?.monitoredRooms) ? focusState.monitoredRooms : [];
      const focusOk = focusRooms.filter((room) => room?.status?.status === "ok").length;
      const focusOffline = focusRooms.filter((room) => ["offline", "live_no_stream"].includes(room?.status?.status)).length;
      const focusLimited = focusRooms.filter((room) =>
        ["asr_unavailable", "ffmpeg_error", "error"].includes(room?.status?.status)
      ).length;
      const restrictionSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const restrictionStats = getRecentRestrictionStats(context.db, restrictionSince);
      const liveAgeSec = ageSecondsFromIso(liveStatus.time);
      const msgAgeSec = ageSecondsFromIso(messageStatus.time);
      const healthPayload = {
        liveWorker: {
          running: Boolean(liveStatus.running),
          phase: liveStatus.phase || null,
          ageSec: liveAgeSec,
          cycleDurationMs: liveStatus.cycleDurationMs || null,
          error: liveStatus.error || null
        },
        messageWorker: {
          running: Boolean(messageStatus.running),
          phase: messageStatus.phase || null,
          ageSec: msgAgeSec,
          rotatingCurrent: messageStatus.rotatingCurrent?.liveWebRid || null,
          dedicatedCount: Number(messageStatus.dedicatedCount || 0)
        },
        focusMonitor: {
          enabled: Boolean(focusState?.enabled),
          monitoredCount: Number(focusState?.monitoredCount || 0),
          okCount: focusOk,
          offlineCount: focusOffline,
          limitedCount: focusLimited
        },
        restrictionLast10m: restrictionStats
      };
      const hasStale = (liveAgeSec !== null && liveAgeSec > staleWarnSec) || (msgAgeSec !== null && msgAgeSec > staleWarnSec);
      if (!liveStatus.running || !messageStatus.running || hasStale) {
        logger.warn("系统健康心跳（告警）", healthPayload);
      } else {
        logger.info("系统健康心跳", healthPayload);
      }
    } catch (error) {
      logger.error("系统健康心跳失败", {
        error: error.message
      });
    }
  }, intervalMs);

  return () => {
    try {
      clearInterval(timer);
    } catch (error) {
      // ignore
    }
  };
}

function createFocusMonitor(context) {
  const runtimeDir = config.paths.runtimeDir;
  const focusConfigPath = pathModule.join(runtimeDir, "focus-speech-config.json");
  const focusStatePath = pathModule.join(runtimeDir, "focus-speech-state.json");
  const focusRootDir = pathModule.join(config.paths.docsDir, "focus-monitor");
  const segmentSec = Math.max(8, Number(config.focusSpeech?.segmentSec || 60));
  const pollIntervalMs = Math.max(5000, Number(config.focusSpeech?.pollIntervalSec || 6) * 1000);
  const transcriptsKeep = Math.max(50, Number(config.focusSpeech?.transcriptsKeep || 300));

  const roomMap = new Map(
    normalizeTargets(context.targets)
      .filter((item) => item.liveWebRid)
      .map((item) => [item.liveWebRid, item])
  );

  const state = {
    roomTimers: new Map(),
    roomBusy: new Set(),
    roomStatus: {}
  };

  if (!fs.existsSync(focusRootDir)) {
    fs.mkdirSync(focusRootDir, { recursive: true });
  }

  function readConfig() {
    const raw = readJsonIfExists(focusConfigPath, {
      enabled: false,
      monitoredLiveWebRids: [],
      selectedLiveWebRid: "",
      updatedAt: null
    });
    if (Array.isArray(raw.monitoredLiveWebRids)) {
      return raw;
    }
    const migratedRid = String(raw.liveWebRid || "").trim();
    return {
      enabled: Boolean(raw.enabled),
      monitoredLiveWebRids: migratedRid ? [migratedRid] : [],
      selectedLiveWebRid: migratedRid,
      updatedAt: raw.updatedAt || null
    };
  }

  function updateConfig(partial) {
    const current = readConfig();
    const merged = {
      ...current,
      ...partial
    };
    const deduped = Array.from(new Set((merged.monitoredLiveWebRids || []).map((item) => String(item || "").trim()).filter(Boolean)));
    merged.monitoredLiveWebRids = deduped;
    if (!merged.selectedLiveWebRid || !deduped.includes(merged.selectedLiveWebRid)) {
      merged.selectedLiveWebRid = deduped[0] || "";
    }
    const next = {
      ...merged,
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(focusConfigPath, next);
    ensureRoomTimers(next);
    writeStateSnapshot();
    return next;
  }

  function toSafeName(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getRoomMeta(liveWebRid) {
    const target = roomMap.get(liveWebRid) || {};
    const accountName = target.accountName || liveWebRid;
    return {
      liveWebRid,
      accountName,
      category: target.category || "",
      department: target.department || ""
    };
  }

  function getRoomPaths(liveWebRid) {
    const roomDir = pathModule.join(focusRootDir, liveWebRid);
    const audioDir = pathModule.join(roomDir, "audio");
    const transcriptJsonl = pathModule.join(roomDir, "transcripts.jsonl");
    const transcriptMd = pathModule.join(roomDir, "transcript.md");
    if (!fs.existsSync(audioDir)) {
      fs.mkdirSync(audioDir, { recursive: true });
    }
    return {
      roomDir,
      audioDir,
      transcriptJsonl,
      transcriptMd
    };
  }

  function readRoomTail(liveWebRid, limit = 200) {
    const paths = getRoomPaths(liveWebRid);
    return tailJsonLines(paths.transcriptJsonl, limit);
  }

  function keepRecentRoomTranscripts(liveWebRid) {
    const paths = getRoomPaths(liveWebRid);
    if (!fs.existsSync(paths.transcriptJsonl)) {
      return;
    }
    const rows = tailJsonLines(paths.transcriptJsonl, transcriptsKeep);
    rows.reverse();
    fs.writeFileSync(
      paths.transcriptJsonl,
      rows.map((item) => JSON.stringify(item)).join("\n") + (rows.length ? "\n" : ""),
      "utf8"
    );
  }

  function appendTranscriptMarkdown(liveWebRid, row) {
    const meta = getRoomMeta(liveWebRid);
    const paths = getRoomPaths(liveWebRid);
    if (!fs.existsSync(paths.transcriptMd)) {
      const header = `# 重点直播间话术转写\n\n- 直播间：${meta.accountName}\n- rid：${meta.liveWebRid}\n- 分类：${meta.category || "未分组"}\n- 学科：${meta.department || "未分组"}\n\n---\n`;
      fs.writeFileSync(paths.transcriptMd, header, "utf8");
    }
    const block = `\n## ${row.time}\n\n${row.text}\n`;
    fs.appendFileSync(paths.transcriptMd, block, "utf8");
  }

  function updateRoomStatus(liveWebRid, partial) {
    const prev = state.roomStatus[liveWebRid] || {};
    state.roomStatus[liveWebRid] = {
      ...prev,
      ...partial,
      updatedAt: new Date().toISOString()
    };
  }

  function writeStateSnapshot() {
    const conf = readConfig();
    const monitoredRooms = (conf.monitoredLiveWebRids || []).map((rid) => {
      const meta = getRoomMeta(rid);
      const roomPaths = getRoomPaths(rid);
      return {
        ...meta,
        status: state.roomStatus[rid] || { status: "idle" },
        transcriptFile: roomPaths.transcriptMd,
        transcriptJsonl: roomPaths.transcriptJsonl,
        audioDir: roomPaths.audioDir
      };
    });
    writeJsonFile(focusStatePath, {
      running: true,
      enabled: Boolean(conf.enabled),
      monitoredCount: monitoredRooms.length,
      selectedLiveWebRid: conf.selectedLiveWebRid || "",
      monitoredRooms,
      updatedAt: new Date().toISOString()
    });
  }

  async function transcribeWithOpenAI(audioPath) {
    const apiKey = String(config.focusSpeech?.openaiApiKey || "").trim();
    if (!apiKey) {
      return null;
    }
    const model = String(config.focusSpeech?.asrModel || "gpt-4o-mini-transcribe").trim();
    const data = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append("model", model);
    form.append("language", "zh");
    form.append("response_format", "json");
    form.append("file", new Blob([data], { type: "audio/wav" }), pathModule.basename(audioPath));
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form
    });
    if (!response.ok) {
      throw new Error(`openai_asr_http_${response.status}`);
    }
    const payload = await response.json();
    return String(payload?.text || "").trim() || null;
  }

  async function runProcessAsync(executable, args, options = {}) {
    return new Promise((resolve) => {
      const child = spawn(executable, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...options
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer = null;
      if (options.timeout && options.timeout > 0) {
        timer = setTimeout(() => {
          if (!settled) {
            try {
              child.kill("SIGTERM");
            } catch (error) {
              // ignore
            }
          }
        }, options.timeout);
      }
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("close", (code, signal) => {
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve({
          code,
          signal,
          stdout,
          stderr
        });
      });
      child.on("error", (error) => {
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve({
          code: -1,
          signal: null,
          stdout,
          stderr: `${stderr}\n${error.message}`.trim()
        });
      });
    });
  }

  async function transcribeWithCommand(audioPath) {
    const commandTemplate = String(config.focusSpeech?.asrCommand || "").trim();
    if (!commandTemplate) {
      return null;
    }

    const command = commandTemplate.replaceAll("{input}", audioPath);
    const tokens = command.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    if (tokens.length === 0) {
      throw new Error("asr_command_empty");
    }
    const executable = tokens[0].replace(/^"|"$/g, "");
    const args = tokens.slice(1).map((token) => token.replace(/^"|"$/g, ""));

    const exec = await runProcessAsync(executable, args, {
      timeout: Math.max(15000, segmentSec * 1000),
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      }
    });
    if (exec.code !== 0) {
      throw new Error((exec.stderr || exec.stdout || "asr_command_failed").trim());
    }
    const text = String(exec.stdout || "").trim();
    return text || null;
  }

  async function captureAndTranscribe(liveWebRid) {
    const meta = getRoomMeta(liveWebRid);
    const liveState = await fetchLiveRoomStateViaApi(liveWebRid);
    if (liveState.statusText !== "live") {
      updateRoomStatus(liveWebRid, {
        status: "offline",
        detail: "当前直播间离线"
      });
      return;
    }
    const hlsUrl = String(liveState?.roomData?.stream_url?.hls_pull_url || "").trim();
    if (!hlsUrl) {
      updateRoomStatus(liveWebRid, {
        status: "live_no_stream",
        detail: "在播但未获取到音频流地址"
      });
      return;
    }

    const paths = getRoomPaths(liveWebRid);
    const ts = Date.now();
    const wavPath = pathModule.join(paths.audioDir, `focus-${liveWebRid}-${ts}.wav`);
    const ffmpeg = await runProcessAsync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", hlsUrl, "-t", String(segmentSec), "-vn", "-ac", "1", "-ar", "16000", wavPath],
      { timeout: Math.max(15000, segmentSec * 1000 + 12000) }
    );

    if (ffmpeg.code !== 0 || !fs.existsSync(wavPath)) {
      updateRoomStatus(liveWebRid, {
        status: "ffmpeg_error",
        detail: String(ffmpeg.stderr || ffmpeg.stdout || "ffmpeg_failed").slice(0, 300)
      });
      return;
    }

    let text = null;
    let asrBackend = "none";
    try {
      text = await transcribeWithCommand(wavPath);
      if (text) {
        asrBackend = "command";
      }
      if (!text) {
        text = await transcribeWithOpenAI(wavPath);
        if (text) {
          asrBackend = "openai";
        }
      }
    } finally {}

    if (!text) {
      updateRoomStatus(liveWebRid, {
        status: "asr_unavailable",
        detail: "未配置可用ASR后端（FOCUS_ASR_COMMAND 或 OPENAI_API_KEY）"
      });
      return;
    }

    const row = {
      time: new Date().toISOString(),
      liveWebRid,
      accountName: meta.accountName,
      text,
      asrBackend,
      audioFile: wavPath
    };
    appendJsonLine(paths.transcriptJsonl, row);
    keepRecentRoomTranscripts(liveWebRid);
    appendTranscriptMarkdown(liveWebRid, row);
    updateRoomStatus(liveWebRid, {
      status: "ok",
      asrBackend,
      latest: row
    });
  }

  async function runRoomCycle(liveWebRid) {
    if (state.roomBusy.has(liveWebRid)) {
      return;
    }
    state.roomBusy.add(liveWebRid);
    try {
      await captureAndTranscribe(liveWebRid);
    } catch (error) {
      updateRoomStatus(liveWebRid, {
        status: "error",
        detail: String(error.message || error).slice(0, 300)
      });
    } finally {
      state.roomBusy.delete(liveWebRid);
      writeStateSnapshot();
    }
  }

  function stopRoomTimer(liveWebRid) {
    const timer = state.roomTimers.get(liveWebRid);
    if (timer) {
      clearInterval(timer);
      state.roomTimers.delete(liveWebRid);
    }
    delete state.roomStatus[liveWebRid];
  }

  function startRoomTimer(liveWebRid) {
    if (state.roomTimers.has(liveWebRid)) {
      return;
    }
    updateRoomStatus(liveWebRid, {
      status: "booting",
      detail: "room monitor started"
    });
    runRoomCycle(liveWebRid);
    const timer = setInterval(() => runRoomCycle(liveWebRid), pollIntervalMs);
    state.roomTimers.set(liveWebRid, timer);
  }

  function ensureRoomTimers(conf = readConfig()) {
    const enabled = Boolean(conf.enabled);
    const wanted = enabled ? new Set(conf.monitoredLiveWebRids || []) : new Set();
    for (const rid of state.roomTimers.keys()) {
      if (!wanted.has(rid)) {
        stopRoomTimer(rid);
      }
    }
    for (const rid of wanted) {
      if (roomMap.has(rid)) {
        startRoomTimer(rid);
      }
    }
    writeStateSnapshot();
  }

  function start() {
    ensureRoomTimers(readConfig());
  }

  function stop() {
    for (const rid of [...state.roomTimers.keys()]) {
      stopRoomTimer(rid);
    }
    writeJsonFile(focusStatePath, {
      running: false,
      enabled: false,
      monitoredCount: 0,
      monitoredRooms: [],
      selectedLiveWebRid: "",
      updatedAt: new Date().toISOString()
    });
  }

  function listTargets() {
    return [...roomMap.values()].map((item) => ({
      liveWebRid: item.liveWebRid,
      accountName: item.accountName,
      category: item.category || "",
      department: item.department || ""
    }));
  }

  return {
    start,
    stop,
    readConfig,
    updateConfig,
    readState: () => readJsonIfExists(focusStatePath, {
      running: false,
      enabled: false,
      monitoredRooms: []
    }),
    listTargets,
    listTranscripts: (liveWebRid, limit) => {
      if (!liveWebRid) {
        const conf = readConfig();
        liveWebRid = conf.selectedLiveWebRid || conf.monitoredLiveWebRids?.[0] || "";
      }
      if (!liveWebRid) {
        return [];
      }
      return readRoomTail(liveWebRid, limit);
    },
    setSelectedRoom: (liveWebRid) => updateConfig({
      selectedLiveWebRid: String(liveWebRid || "").trim()
    }),
    setMonitoredRooms: (liveWebRids, enabled = true) => updateConfig({
      monitoredLiveWebRids: Array.isArray(liveWebRids) ? liveWebRids : [],
      enabled: Boolean(enabled)
    })
  };
}

function createServerContext() {
  const boot = bootstrapProject();
  const focusMonitor = createFocusMonitor(boot);
  const baselineDepartment = buildDepartmentComparison(boot.targets);
  const baselineCompetitor = buildCompetitorComparison(boot.targets);
  const challengeCandidates = boot.targets
    .map((item) => String(item.liveRoomUrl || "").trim())
    .filter(Boolean);
  challengeCandidates.push("https://live.douyin.com/");

  return {
    ...boot,
    focusMonitor,
    baselineDepartment,
    baselineCompetitor,
    challengeCandidates
  };
}

async function pickChallengeUrl(context) {
  const candidates = context.challengeCandidates || ["https://live.douyin.com/"];
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";

  for (const url of candidates.slice(0, 10)) {
    try {
      if (url === "https://live.douyin.com/") {
        return url;
      }
      const response = await fetch(url, {
        headers: {
          "user-agent": ua,
          referer: "https://live.douyin.com/"
        }
      });
      const html = await response.text();
      if (!html.includes("直播已结束")) {
        return url;
      }
    } catch (error) {
      continue;
    }
  }

  return "https://live.douyin.com/";
}

function createAppServer(context) {
  const webDir = pathModule.join(config.paths.rootDir, "web");
  const buildScopeWindow = (scope) => {
    if (scope !== "today") {
      return {
        since: null,
        until: null,
        label: "recent"
      };
    }
    const window = getBusinessDayWindow(new Date(), {
      startHour: 5,
      timezoneOffsetHours: 8
    });
    return {
      ...window,
      label: "today_0500"
    };
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const path = url.pathname;

    if (path === "/health") {
      writeJson(res, 200, {
        ok: true,
        app: config.app.name,
        env: config.app.env,
        time: new Date().toISOString()
      });
      return;
    }

    if (path === "/" || path === "/dashboard") {
      writeFile(res, pathModule.join(webDir, "dashboard.html"), "text/html; charset=utf-8");
      return;
    }

    if (path === "/web/dashboard.css") {
      writeFile(res, pathModule.join(webDir, "dashboard.css"), "text/css; charset=utf-8");
      return;
    }

    if (path === "/web/dashboard.js") {
      writeFile(res, pathModule.join(webDir, "dashboard.js"), "application/javascript; charset=utf-8");
      return;
    }

    if (path === "/api/summary") {
      const latestSnapshots = listLatestSnapshotByAccount(context.db);
      writeJson(res, 200, {
        sourceFile: context.filePath,
        targetSummary: context.summary,
        latestSnapshotCount: latestSnapshots.length
      });
      return;
    }

    if (path === "/api/snapshots/recent") {
      const limit = Number(url.searchParams.get("limit") || "20");
      const rows = listRecentRoomSnapshots(context.db, Number.isFinite(limit) ? limit : 20);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

    if (path === "/api/compare/departments") {
      const rows = buildDepartmentComparisonView(context.db, context.baselineDepartment);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

    if (path === "/api/compare/internal-vs-competitor") {
      const payload = buildInternalVsCompetitorView(context.db, context.baselineCompetitor);
      writeJson(res, 200, payload);
      return;
    }

    if (path === "/api/messages/recent") {
      const limit = Number(url.searchParams.get("limit") || "50");
      const scope = String(url.searchParams.get("scope") || "").trim().toLowerCase();
      const window = buildScopeWindow(scope);
      const rows = listRecentLiveMessages(context.db, Number.isFinite(limit) ? limit : 50, {
        since: window.since,
        until: window.until
      });
      const totalCount = countLiveMessages(context.db, {
        since: window.since,
        until: window.until
      });
      const totalChatCount = countLiveMessages(context.db, {
        since: window.since,
        until: window.until,
        chatOnly: true
      });
      writeJson(res, 200, {
        count: rows.length,
        rows,
        scope: scope || "recent",
        scopeLabel: window.label,
        since: window.since,
        until: window.until,
        totalCount,
        totalChatCount
      });
      return;
    }

    if (path === "/api/messages/worker-status") {
      const payload = readMessageWorkerStatus();
      writeJson(res, 200, payload);
      return;
    }

    if (path === "/api/system/health") {
      const liveStatus = readLiveWorkerStatus();
      const messageStatus = readMessageWorkerStatus();
      const focusState = context.focusMonitor.readState();
      const focusRooms = Array.isArray(focusState?.monitoredRooms) ? focusState.monitoredRooms : [];
      const focusOk = focusRooms.filter((room) => room?.status?.status === "ok").length;
      const focusOffline = focusRooms.filter((room) => ["offline", "live_no_stream"].includes(room?.status?.status)).length;
      const focusLimited = focusRooms.filter((room) =>
        ["asr_unavailable", "ffmpeg_error", "error"].includes(room?.status?.status)
      ).length;
      const restrictionSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const restrictionStats = getRecentRestrictionStats(context.db, restrictionSince);
      writeJson(res, 200, {
        time: new Date().toISOString(),
        liveWorker: {
          running: Boolean(liveStatus.running),
          phase: liveStatus.phase || null,
          ageSec: ageSecondsFromIso(liveStatus.time),
          cycleDurationMs: liveStatus.cycleDurationMs || null,
          error: liveStatus.error || null
        },
        messageWorker: {
          running: Boolean(messageStatus.running),
          phase: messageStatus.phase || null,
          ageSec: ageSecondsFromIso(messageStatus.time),
          rotatingCurrent: messageStatus.rotatingCurrent?.liveWebRid || null,
          dedicatedCount: Number(messageStatus.dedicatedCount || 0)
        },
        focusMonitor: {
          enabled: Boolean(focusState?.enabled),
          monitoredCount: Number(focusState?.monitoredCount || 0),
          okCount: focusOk,
          offlineCount: focusOffline,
          limitedCount: focusLimited
        },
        restrictionLast10m: restrictionStats
      });
      return;
    }

    if (path === "/api/focus/targets") {
      writeJson(res, 200, {
        count: context.focusMonitor.listTargets().length,
        rows: context.focusMonitor.listTargets()
      });
      return;
    }

    if (path === "/api/focus/status") {
      writeJson(res, 200, {
        config: context.focusMonitor.readConfig(),
        state: context.focusMonitor.readState()
      });
      return;
    }

    if (path === "/api/focus/transcripts") {
      const limit = Number(url.searchParams.get("limit") || "200");
      const liveWebRid = String(url.searchParams.get("liveWebRid") || "").trim();
      const rows = context.focusMonitor.listTranscripts(liveWebRid, Number.isFinite(limit) ? limit : 200);
      writeJson(res, 200, {
        count: rows.length,
        liveWebRid,
        rows
      });
      return;
    }

    if (path === "/api/focus/monitor-set" && req.method === "POST") {
      const body = await readJsonBody(req);
      const liveWebRids = Array.isArray(body?.liveWebRids) ? body.liveWebRids : [];
      const enabled = body?.enabled === undefined ? true : Boolean(body.enabled);
      const configRow = context.focusMonitor.setMonitoredRooms(liveWebRids, enabled);
      writeJson(res, 200, {
        ok: true,
        config: configRow
      });
      return;
    }

    if (path === "/api/focus/display-select" && req.method === "POST") {
      const body = await readJsonBody(req);
      const liveWebRid = String(body?.liveWebRid || "").trim();
      const configRow = context.focusMonitor.setSelectedRoom(liveWebRid);
      writeJson(res, 200, {
        ok: true,
        config: configRow
      });
      return;
    }

    if (path === "/api/insights/daily") {
      const payload = buildDailyInsights(context.db);
      writeJson(res, 200, payload);
      return;
    }

    if (path === "/api/charts/department-live-avg") {
      const minutes = Number(url.searchParams.get("minutes") || "30");
      const bucketSeconds = Number(url.searchParams.get("bucketSeconds") || "60");
      const smoothWindow = Number(url.searchParams.get("smoothWindow") || "3");
      const departments = (context.baselineDepartment || []).map((item) => item.department);
      const payload = buildDepartmentLiveAvgSeries(context.db, departments, {
        minutes,
        bucketSeconds,
        smoothWindow
      });
      writeJson(res, 200, payload);
      return;
    }

    if (path === "/api/auth/status") {
      const payload = await getAuthDiagnostics();
      const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const restrictionStats = getRecentRestrictionStats(context.db, windowStart);
      const workerStatus = isMessageWorkerRunning();
      const challengePageUrl = await pickChallengeUrl(context);
      writeJson(res, 200, {
        ...payload,
        recentWindowStart: windowStart,
        restrictionStats,
        messageWorker: workerStatus,
        challengePageUrl
      });
      return;
    }

    if (path === "/api/auth/recover" && req.method === "POST") {
      const diagnostics = await getAuthDiagnostics();
      const recover = startMessageWorkerIfNeeded();
      writeJson(res, 200, {
        ok: true,
        diagnostics,
        recover
      });
      return;
    }

    if (path === "/api/auth/challenge-url") {
      const challengePageUrl = await pickChallengeUrl(context);
      writeJson(res, 200, {
        challengePageUrl
      });
      return;
    }

    if (path === "/api/logs/recent") {
      const limit = Number(url.searchParams.get("limit") || "100");
      const rows = readRecentLogs(Number.isFinite(limit) ? limit : 100);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

      writeJson(res, 404, {
        error: "not_found",
        path
      });
    } catch (error) {
      logger.error("API 请求处理失败", {
        error: error.message,
        path: req.url
      });
      writeJson(res, 500, {
        error: "internal_error"
      });
    }
  });
}

function main() {
  const context = createServerContext();
  context.focusMonitor.start();
  const stopHealthMonitor = startSystemHealthMonitor(context);
  const server = createAppServer(context);
  server.listen(config.server.port, config.server.host, () => {
    logger.info("API 服务已启动", {
      host: config.server.host,
      port: config.server.port
    });
  });

  const graceful = () => {
    try {
      stopHealthMonitor();
    } catch (error) {
      // ignore
    }
    try {
      context.focusMonitor.stop();
    } catch (error) {
      // ignore
    }
    try {
      server.close();
    } catch (error) {
      // ignore
    }
  };
  process.on("SIGINT", graceful);
  process.on("SIGTERM", graceful);
}

main();
