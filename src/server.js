const http = require("http");
const fs = require("fs");
const pathModule = require("path");
const os = require("os");
const { spawnSync } = require("child_process");
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

function createFocusMonitor(context) {
  const runtimeDir = config.paths.runtimeDir;
  const focusConfigPath = pathModule.join(runtimeDir, "focus-speech-config.json");
  const focusStatePath = pathModule.join(runtimeDir, "focus-speech-state.json");
  const focusTranscriptPath = pathModule.join(runtimeDir, "focus-speech-transcripts.jsonl");
  const segmentSec = Math.max(8, Number(config.focusSpeech?.segmentSec || 20));
  const pollIntervalMs = Math.max(5000, Number(config.focusSpeech?.pollIntervalSec || 6) * 1000);
  const transcriptsKeep = Math.max(50, Number(config.focusSpeech?.transcriptsKeep || 300));

  const roomMap = new Map(
    normalizeTargets(context.targets)
      .filter((item) => item.liveWebRid)
      .map((item) => [item.liveWebRid, item])
  );

  const state = {
    busy: false,
    timer: null
  };

  function readConfig() {
    return readJsonIfExists(focusConfigPath, {
      enabled: false,
      liveWebRid: "",
      accountName: "",
      updatedAt: null
    });
  }

  function updateConfig(partial) {
    const next = {
      ...readConfig(),
      ...partial,
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(focusConfigPath, next);
    return next;
  }

  function writeState(partial) {
    const next = {
      ...readJsonIfExists(focusStatePath, {}),
      ...partial,
      updatedAt: new Date().toISOString()
    };
    writeJsonFile(focusStatePath, next);
    return next;
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

  function transcribeWithCommand(audioPath) {
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

    const exec = spawnSync(executable, args, {
      encoding: "utf8",
      timeout: Math.max(15000, segmentSec * 1000),
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8"
      }
    });
    if (exec.status !== 0) {
      throw new Error((exec.stderr || exec.stdout || "asr_command_failed").trim());
    }
    const text = String(exec.stdout || "").trim();
    return text || null;
  }

  function keepRecentTranscripts() {
    if (!fs.existsSync(focusTranscriptPath)) {
      return;
    }
    const rows = tailJsonLines(focusTranscriptPath, transcriptsKeep);
    rows.reverse();
    fs.writeFileSync(
      focusTranscriptPath,
      rows.map((item) => JSON.stringify(item)).join("\n") + (rows.length ? "\n" : ""),
      "utf8"
    );
  }

  async function captureAndTranscribe(liveWebRid, accountName) {
    const liveState = await fetchLiveRoomStateViaApi(liveWebRid);
    if (liveState.statusText !== "live") {
      writeState({
        running: true,
        status: "offline",
        selected: { liveWebRid, accountName },
        detail: "当前直播间离线"
      });
      return;
    }
    const hlsUrl = String(liveState?.roomData?.stream_url?.hls_pull_url || "").trim();
    if (!hlsUrl) {
      writeState({
        running: true,
        status: "live_no_stream",
        selected: { liveWebRid, accountName },
        detail: "在播但未获取到音频流地址"
      });
      return;
    }

    const tempDir = pathModule.join(runtimeDir, "focus-audio-temp");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const ts = Date.now();
    const wavPath = pathModule.join(tempDir, `focus-${liveWebRid}-${ts}.wav`);
    const ffmpeg = spawnSync(
      "ffmpeg",
      ["-y", "-loglevel", "error", "-i", hlsUrl, "-t", String(segmentSec), "-vn", "-ac", "1", "-ar", "16000", wavPath],
      { encoding: "utf8", timeout: Math.max(15000, segmentSec * 1000 + 12000) }
    );

    if (ffmpeg.status !== 0 || !fs.existsSync(wavPath)) {
      writeState({
        running: true,
        status: "ffmpeg_error",
        selected: { liveWebRid, accountName },
        detail: String(ffmpeg.stderr || ffmpeg.stdout || "ffmpeg_failed").slice(0, 300)
      });
      return;
    }

    let text = null;
    let asrBackend = "none";
    try {
      text = transcribeWithCommand(wavPath);
      if (text) {
        asrBackend = "command";
      }
      if (!text) {
        text = await transcribeWithOpenAI(wavPath);
        if (text) {
          asrBackend = "openai";
        }
      }
    } finally {
      try {
        fs.unlinkSync(wavPath);
      } catch (error) {
        // ignore
      }
    }

    if (!text) {
      writeState({
        running: true,
        status: "asr_unavailable",
        selected: { liveWebRid, accountName },
        detail: "未配置可用ASR后端（FOCUS_ASR_COMMAND 或 OPENAI_API_KEY）"
      });
      return;
    }

    const row = {
      time: new Date().toISOString(),
      liveWebRid,
      accountName,
      text,
      asrBackend
    };
    appendJsonLine(focusTranscriptPath, row);
    keepRecentTranscripts();
    writeState({
      running: true,
      status: "ok",
      selected: { liveWebRid, accountName },
      asrBackend,
      latest: row
    });
  }

  async function tick() {
    if (state.busy) {
      return;
    }
    state.busy = true;
    try {
      const conf = readConfig();
      if (!conf.enabled || !conf.liveWebRid) {
        writeState({
          running: true,
          status: "idle",
          selected: null,
          detail: "未启用重点直播间话术监控"
        });
        return;
      }

      const selectedTarget = roomMap.get(conf.liveWebRid) || {};
      const accountName = conf.accountName || selectedTarget.accountName || conf.liveWebRid;
      await captureAndTranscribe(conf.liveWebRid, accountName);
    } catch (error) {
      writeState({
        running: true,
        status: "error",
        detail: String(error.message || error).slice(0, 300)
      });
    } finally {
      state.busy = false;
    }
  }

  function start() {
    writeState({
      running: true,
      status: "booting",
      detail: "focus monitor started"
    });
    tick();
    state.timer = setInterval(tick, pollIntervalMs);
  }

  function stop() {
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    writeState({
      running: false,
      status: "stopped",
      detail: "focus monitor stopped"
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
      status: "idle"
    }),
    listTargets,
    listTranscripts: (limit) => tailJsonLines(focusTranscriptPath, limit)
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
      const rows = context.focusMonitor.listTranscripts(Number.isFinite(limit) ? limit : 200);
      writeJson(res, 200, {
        count: rows.length,
        rows
      });
      return;
    }

    if (path === "/api/focus/select" && req.method === "POST") {
      const body = await readJsonBody(req);
      const liveWebRid = String(body?.liveWebRid || "").trim();
      if (!liveWebRid) {
        writeJson(res, 400, {
          error: "missing_live_web_rid"
        });
        return;
      }
      const target = context.focusMonitor.listTargets().find((item) => item.liveWebRid === liveWebRid);
      const configRow = context.focusMonitor.updateConfig({
        enabled: true,
        liveWebRid,
        accountName: target?.accountName || ""
      });
      writeJson(res, 200, {
        ok: true,
        config: configRow
      });
      return;
    }

    if (path === "/api/focus/enable" && req.method === "POST") {
      const body = await readJsonBody(req);
      const enabled = Boolean(body?.enabled);
      const configRow = context.focusMonitor.updateConfig({
        enabled
      });
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
  const server = createAppServer(context);
  server.listen(config.server.port, config.server.host, () => {
    logger.info("API 服务已启动", {
      host: config.server.host,
      port: config.server.port
    });
  });

  const graceful = () => {
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
