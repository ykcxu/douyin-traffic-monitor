async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`request failed: ${path} ${response.status}`);
  }
  return response.json();
}

async function postJson(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`request failed: ${path} ${response.status}`);
  }
  return response.json();
}

let refreshTimer = null;
let refreshKickoffTimer = null;
let focusRefreshTimer = null;
let challengePageUrl = "https://live.douyin.com/";
const INSIGHTS_REFRESH_MS = 30 * 60 * 1000;
const trendPalette = ["#0a4ad6", "#00a76f", "#ff7a00", "#8a52ff", "#ff4d6d", "#00a6ff", "#7f8c3a", "#b85c38"];
const trendState = {
  labels: [],
  departments: [],
  series: {},
  currentPayload: null,
  frameId: null
};
const logMessageState = {
  roomFilter: "ALL",
  typeFilter: "chat",
  rows: []
};
const insightsState = {
  payload: null,
  fetchedAtMs: 0,
  slotKey: null,
  displayUpdatedAt: null
};
const focusState = {
  targets: [],
  config: null,
  status: null,
  transcripts: [],
  draftMonitored: []
};

function fmtTime(value) {
  if (!value) {
    return "-";
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(d);
}

function toRoomDisplayName(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "未命名";
  }
  return source;
}

function fmtNowChina() {
  return fmtTime(new Date().toISOString());
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function asLiveRoomUrl(roomIdLike) {
  const rid = String(roomIdLike || "").trim();
  if (!rid) {
    return null;
  }
  return `https://live.douyin.com/${encodeURIComponent(rid)}`;
}

function parseRawPayload(rawPayload) {
  if (!rawPayload) {
    return null;
  }
  if (typeof rawPayload === "object") {
    return rawPayload;
  }
  try {
    return JSON.parse(rawPayload);
  } catch (error) {
    return null;
  }
}

function getLiveRoomUrlFromRow(row) {
  const roomId = String(row?.roomId || "").trim();
  if (roomId) {
    return asLiveRoomUrl(roomId);
  }
  const raw = parseRawPayload(row?.rawPayload);
  const liveWebRid = String(raw?.liveWebRid || raw?.roomId || "").trim();
  if (liveWebRid) {
    return asLiveRoomUrl(liveWebRid);
  }
  return null;
}

function toRoomLinkHtml(name, url) {
  const safeName = escapeHtml(name || "未命名");
  const safeUrl = escapeHtml(url || "");
  if (!safeUrl) {
    return safeName;
  }
  return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${safeName}</a>`;
}

function isNumericLike(value) {
  return /^\d+$/.test(String(value || "").trim());
}

function resolveRoomNameFromRow(row) {
  const accountName = String(row?.accountName || "").trim();
  const userName = String(row?.userName || "").trim();
  if (accountName && !isNumericLike(accountName)) {
    return accountName;
  }
  if (userName && !isNumericLike(userName)) {
    return userName;
  }
  if (accountName) {
    return accountName;
  }
  if (userName) {
    return userName;
  }
  return String(row?.accountUid || row?.roomId || "未命名");
}

function getRoomKey(row) {
  return row.accountUid || row.roomId || resolveRoomNameFromRow(row) || "unknown";
}

function pickTrendColor(index) {
  return trendPalette[index % trendPalette.length];
}

function fmtLabelMinute(iso) {
  if (!iso) {
    return "";
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso.slice(11, 16);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(d);
}

function normalizeTrendData(payload) {
  const labels = (payload?.points || []).map((point) => point.bucketTime);
  const departments = payload?.departments || [];
  const series = {};
  for (const dep of departments) {
    series[dep] = labels.map((_, idx) => payload.points[idx]?.values?.[dep] ?? null);
  }
  return { labels, departments, series };
}

function renderTrendLegend(departments) {
  const legend = document.getElementById("department-trend-legend");
  if (!legend) {
    return;
  }
  legend.innerHTML = "";
  for (const [idx, department] of departments.entries()) {
    const item = document.createElement("div");
    item.className = "trend-legend-item";
    const dot = document.createElement("span");
    dot.className = "trend-legend-dot";
    dot.style.backgroundColor = pickTrendColor(idx);
    const text = document.createElement("span");
    text.textContent = department;
    item.appendChild(dot);
    item.appendChild(text);
    legend.appendChild(item);
  }
}

function buildPolylinePath(values, getX, getY) {
  let path = "";
  let started = false;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      started = false;
      continue;
    }
    const x = getX(i);
    const y = getY(Number(value));
    if (!started) {
      path += `M ${x.toFixed(2)} ${y.toFixed(2)} `;
      started = true;
    } else {
      path += `L ${x.toFixed(2)} ${y.toFixed(2)} `;
    }
  }
  return path.trim();
}

function renderDepartmentTrendFrame(departments, labels, prevSeries, nextSeries, progress, shiftSteps) {
  const container = document.getElementById("department-trend-chart");
  if (!container) {
    return;
  }
  const width = 980;
  const height = 280;
  const padLeft = 44;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 34;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  const p = Math.max(0, Math.min(1, progress));

  const allValues = [];
  for (const dep of departments) {
    for (const value of nextSeries[dep] || []) {
      if (Number.isFinite(Number(value))) {
        allValues.push(Number(value));
      }
    }
  }
  const maxValue = allValues.length ? Math.max(...allValues) : 10;
  const yMax = Math.max(10, Math.ceil(maxValue * 1.15));
  const yStep = yMax / 4;

  const xShift = shiftSteps > 0 ? p * shiftSteps : 0;
  const getX = (index) => padLeft + ((index - xShift) / Math.max(1, labels.length - 1)) * plotW;
  const getY = (value) => padTop + plotH - (Math.max(0, value) / yMax) * plotH;

  const lines = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = i * yStep;
    const y = getY(value);
    lines.push(`<line x1="${padLeft}" y1="${y.toFixed(2)}" x2="${(padLeft + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#edf2fb" stroke-width="1" />`);
    lines.push(`<text x="${padLeft - 6}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#8aa0c2" font-size="11">${Math.round(value)}</text>`);
  }

  const tickStep = Math.max(1, Math.floor(labels.length / 6));
  for (let i = 0; i < labels.length; i += tickStep) {
    const x = getX(i);
    if (x < padLeft || x > padLeft + plotW) {
      continue;
    }
    lines.push(`<line x1="${x.toFixed(2)}" y1="${(padTop + plotH).toFixed(2)}" x2="${x.toFixed(2)}" y2="${(padTop + plotH + 4).toFixed(2)}" stroke="#b9c9e5" stroke-width="1" />`);
    lines.push(`<text x="${x.toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" fill="#8aa0c2" font-size="11">${fmtLabelMinute(labels[i])}</text>`);
  }

  const paths = [];
  for (const [depIndex, department] of departments.entries()) {
    const currentValues = (nextSeries[department] || []).map((nextVal, i) => {
      const alignedPrevIndex = Math.min(
        (prevSeries[department] || []).length - 1,
        Math.max(0, i + shiftSteps)
      );
      const prevVal = (prevSeries[department] || [])[alignedPrevIndex];
      if (Number.isFinite(Number(prevVal)) && Number.isFinite(Number(nextVal))) {
        return Number(prevVal) + (Number(nextVal) - Number(prevVal)) * p;
      }
      if (Number.isFinite(Number(nextVal))) {
        return Number(nextVal);
      }
      if (Number.isFinite(Number(prevVal))) {
        return Number(prevVal);
      }
      return null;
    });

    const d = buildPolylinePath(currentValues, getX, getY);
    if (!d) {
      continue;
    }
    paths.push(
      `<path d="${d}" fill="none" stroke="${pickTrendColor(depIndex)}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />`
    );
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="近30分钟各学科在播平均人次折线图">
      <rect x="${padLeft}" y="${padTop}" width="${plotW}" height="${plotH}" fill="#fcfdff" stroke="#eef3fb" />
      ${lines.join("")}
      ${paths.join("")}
    </svg>
  `;
}

function renderDepartmentTrend(payload) {
  const normalized = normalizeTrendData(payload);
  const { labels, departments, series } = normalized;
  const container = document.getElementById("department-trend-chart");
  if (!container) {
    return;
  }

  if (!labels.length || !departments.length) {
    container.innerHTML = `<div style="color:#6a7898;padding:24px 8px;">暂无图表数据（等待采样后自动生成）</div>`;
    renderTrendLegend([]);
    trendState.labels = labels;
    trendState.departments = departments;
    trendState.series = series;
    trendState.currentPayload = payload;
    return;
  }

  renderTrendLegend(departments);
  const previousLabels = trendState.labels || [];
  const previousSeries = trendState.series || {};
  const shiftSteps =
    previousLabels.length === labels.length &&
    previousLabels.length >= 2 &&
    previousLabels.slice(1).join("|") === labels.slice(0, -1).join("|")
      ? 1
      : 0;

  const fromSeries = previousLabels.length ? previousSeries : series;
  const duration = 900;
  const start = performance.now();
  if (trendState.frameId) {
    cancelAnimationFrame(trendState.frameId);
    trendState.frameId = null;
  }

  const frame = (now) => {
    const p = Math.min(1, (now - start) / duration);
    renderDepartmentTrendFrame(departments, labels, fromSeries, series, p, shiftSteps);
    if (p < 1) {
      trendState.frameId = requestAnimationFrame(frame);
      return;
    }
    trendState.frameId = null;
  };

  trendState.labels = labels;
  trendState.departments = departments;
  trendState.series = series;
  trendState.currentPayload = payload;
  trendState.frameId = requestAnimationFrame(frame);
}

function activateTab(tabName) {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.tab === tabName);
  }
  for (const pane of document.querySelectorAll(".tab-pane")) {
    pane.classList.toggle("active", pane.id === `tab-${tabName}`);
  }
}

function fillMetrics(summary, snapshots, messages) {
  document.getElementById("metric-targets").textContent = summary?.targetSummary?.total ?? "-";
  document.getElementById("metric-sampled").textContent = snapshots?.count ?? "-";
  document.getElementById("metric-messages").textContent = messages?.count ?? "-";
}

function renderDepartmentTable(payload) {
  const tbody = document.querySelector("#department-table tbody");
  tbody.innerHTML = "";
  const rows = payload?.rows || [];
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" style="color:#6a7898">暂无学科对比数据</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.department}</td>
      <td>${row.targetTotalAccounts}</td>
      <td>${row.sampledRooms}</td>
      <td>${row.liveRooms}</td>
      <td>${row.avgOnlineCount}</td>
      <td>${row.peakOnlineCount}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderCategoryTable(payload) {
  const tbody = document.querySelector("#category-table tbody");
  tbody.innerHTML = "";
  if (!payload?.targetBaseline || !payload?.snapshotView) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" style="color:#6a7898">暂无内部/竞品对比数据</td>`;
    tbody.appendChild(tr);
    return;
  }

  const rows = [
    {
      label: "内部",
      baselineAccounts: payload.targetBaseline.internalAccounts,
      baselineLiveRooms: payload.targetBaseline.internalLiveRooms,
      snap: payload.snapshotView.internal
    },
    {
      label: "竞品",
      baselineAccounts: payload.targetBaseline.competitorAccounts,
      baselineLiveRooms: payload.targetBaseline.competitorLiveRooms,
      snap: payload.snapshotView.competitor
    }
  ];

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.label}</td>
      <td>${row.baselineAccounts}</td>
      <td>${row.baselineLiveRooms}</td>
      <td>${row.snap.sampledRooms}</td>
      <td>${row.snap.liveRooms}</td>
      <td>${row.snap.avgOnlineCount}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderSnapshotTable(payload) {
  const tbody = document.querySelector("#snapshot-table tbody");
  tbody.innerHTML = "";
  const rows = payload?.rows || [];
  if (rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="6" style="color:#6a7898">暂无采样记录（请等待 worker 运行 1-2 分钟）</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const row of rows) {
    let raw = {};
    try {
      raw = typeof row.rawPayload === "string" ? JSON.parse(row.rawPayload) : row.rawPayload || {};
    } catch (error) {
      raw = {};
    }

    let statusClass = "offline";
    let statusText = "离线";
    if (raw.fetchStatus === "captcha_required" || raw.statusText === "restricted") {
      statusClass = "unknown";
      statusText = "受限";
    } else if (Number(row.isLive) === 1) {
      statusClass = "live";
      statusText = "在播";
    } else if (raw.statusText === "unknown") {
      statusClass = "unknown";
      statusText = "未知";
    }

    const tr = document.createElement("tr");
    const roomUrl = getLiveRoomUrlFromRow(row);
    tr.innerHTML = `
      <td>${fmtTime(row.sampleTime)}</td>
      <td>${toRoomLinkHtml(row.accountName || "-", roomUrl)}</td>
      <td>${row.department || "-"}</td>
      <td><span class="tag ${statusClass}">${statusText}</span></td>
      <td>${row.onlineCount ?? "-"}</td>
      <td>${row.likeCount ?? "-"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderMessageMetrics(payload) {
  const rows = payload.rows || [];
  const chatRows = rows.filter((item) => String(item.messageType || "").includes("Chat"));
  const totalChat = Number(payload?.totalChatCount || 0);
  document.getElementById("metric-chat").textContent = totalChat > 0 ? totalChat : chatRows.length;

  const roomCount = new Map();
  for (const row of chatRows) {
    const key = getRoomKey(row);
    const name = toRoomDisplayName(resolveRoomNameFromRow(row));
    const roomUrl = getLiveRoomUrlFromRow(row);
    const old = roomCount.get(key) || { name, count: 0, roomUrl: roomUrl || null };
    old.count += 1;
    if (!old.roomUrl && roomUrl) {
      old.roomUrl = roomUrl;
    }
    roomCount.set(key, old);
  }
  const topRooms = [...roomCount.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((item) => `${toRoomLinkHtml(item.name, item.roomUrl)}(${item.count})`);
  document.getElementById("metric-interact").innerHTML = topRooms.length ? topRooms.join(" / ") : "暂无";

  const wordCount = {};
  for (const row of chatRows) {
    for (const token of tokenizeForKeyword(row.content || "")) {
      if (token.length < 2) {
        continue;
      }
      wordCount[token] = (wordCount[token] || 0) + 1;
    }
  }
  const topWords = Object.entries(wordCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word, count]) => `${word}(${count})`);
  document.getElementById("metric-derived").textContent = topWords.length ? topWords.join(" / ") : "暂无";
}

function renderDedicatedRooms(payload) {
  const list = document.getElementById("dedicated-room-list");
  const updatedEl = document.getElementById("dedicated-rooms-updated");
  if (!list) {
    return;
  }

  list.innerHTML = "";
  const rows = Array.isArray(payload?.dedicatedRooms) ? payload.dedicatedRooms : [];
  if (updatedEl) {
    updatedEl.textContent = `更新时间：${payload?.time ? fmtTime(payload.time) : fmtNowChina()}`;
  }

  if (!rows.length) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><span class="tag">idle</span> 当前无高峰直播间单开线程监控</div>
      <div style="color:#6a7898;font-size:12px">系统会在弹幕频率升高时自动升级为独立跟踪</div>
    `;
    list.appendChild(li);
    return;
  }

  for (const item of rows) {
    const roomUrl = asLiveRoomUrl(item.liveWebRid);
    const li = document.createElement("li");
    li.innerHTML = `
      <div><span class="tag live">hot</span> ${toRoomLinkHtml(toRoomDisplayName(item.accountName || item.liveWebRid || "-"), roomUrl)}（${escapeHtml(item.department || "未分组")}）</div>
      <div style="color:#6a7898;font-size:12px">最近弹幕速率 ${item.recentChatPerMin || 0}/min · 累计弹幕 ${item.totalChat || 0} · 启动 ${fmtTime(item.startedAt)}</div>
    `;
    list.appendChild(li);
  }
}

function renderFocusTargets() {
  const checklist = document.getElementById("focus-room-checklist");
  const displaySelect = document.getElementById("focus-transcript-select");
  if (!checklist || !displaySelect) {
    return;
  }
  const serverMonitored = (focusState.config?.monitoredLiveWebRids || []).map((item) => String(item));
  const draft = Array.isArray(focusState.draftMonitored) ? focusState.draftMonitored : [];
  const activeMonitored = draft.length ? draft : serverMonitored;
  const monitored = new Set(activeMonitored);

  checklist.innerHTML = "";
  for (const item of focusState.targets || []) {
    const row = document.createElement("div");
    row.className = "keyword-room-item";
    row.innerHTML = `
      <label class="focus-check-item">
        <input type="checkbox" class="focus-room-checkbox" value="${escapeHtml(item.liveWebRid)}" ${monitored.has(item.liveWebRid) ? "checked" : ""} />
        <span>${escapeHtml(item.accountName)}（${escapeHtml(item.department || "未分组")}）</span>
      </label>
    `;
    checklist.appendChild(row);
  }

  const selected = String(focusState.config?.selectedLiveWebRid || "");
  displaySelect.innerHTML = `<option value="">请选择</option>`;
  for (const rid of new Set(serverMonitored)) {
    const item = (focusState.targets || []).find((t) => t.liveWebRid === rid);
    if (!item) {
      continue;
    }
    const option = document.createElement("option");
    option.value = rid;
    option.textContent = `${item.accountName}（${item.department || "未分组"}）`;
    displaySelect.appendChild(option);
  }
  if (selected) {
    displaySelect.value = selected;
  }
}

function renderFocusStatus() {
  const statusEl = document.getElementById("focus-status");
  if (!statusEl) {
    return;
  }
  const conf = focusState.config || {};
  const st = focusState.status || {};
  const selectedRid = conf.selectedLiveWebRid || "";
  const monitoredCount = (conf.monitoredLiveWebRids || []).length;
  const selectedRoom = (focusState.targets || []).find((item) => item.liveWebRid === selectedRid);
  const selectedState = (st.monitoredRooms || []).find((item) => item.liveWebRid === selectedRid);
  statusEl.innerHTML = `
    <div>监控房间数：${monitoredCount}</div>
    <div>监控开关：${conf.enabled ? "已开启" : "已关闭"}</div>
    <div>当前展示：${selectedRoom ? selectedRoom.accountName : "未选择"}</div>
    <div>当前状态：${selectedState?.status?.status || "idle"}</div>
    <div>文档路径：${selectedState?.transcriptFile || "-"}</div>
    <div>音频目录：${selectedState?.audioDir || "-"}</div>
    <div>最近更新时间：${fmtTime(st.updatedAt || conf.updatedAt || new Date().toISOString())}</div>
  `;
}

function renderFocusTranscripts() {
  const list = document.getElementById("focus-transcript-list");
  if (!list) {
    return;
  }
  list.innerHTML = "";
  const rows = focusState.transcripts || [];
  const enabled = Boolean(focusState?.config?.enabled);
  if (!rows.length) {
    const li = document.createElement("li");
    if (enabled) {
      li.innerHTML = `
        <div><span class="tag live">listening</span> 正在监听转写中<span class="typing-cursor">|</span></div>
        <div style="color:#6a7898;font-size:12px">已开启重点监控，等待下一段转写结果写入</div>
      `;
    } else {
      li.innerHTML = `
        <div><span class="tag">empty</span> 暂无转写结果</div>
        <div style="color:#6a7898;font-size:12px">选定直播间并保持在播后，系统会分段转写并自动展示</div>
      `;
    }
    list.appendChild(li);
    return;
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const isLatest = i === 0;
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${toRoomDisplayName(row.accountName || row.liveWebRid || "-")}：${escapeHtml(row.text || "-")}${isLatest ? '<span class="typing-cursor">|</span>' : ""}</div>
      <div style="color:#6a7898;font-size:12px"><span class="tag">${row.asrBackend || "asr"}</span> ${fmtTime(row.time)}</div>
    `;
    list.appendChild(li);
  }
}

async function refreshFocusPanel() {
  try {
    const [targets, status] = await Promise.all([
      getJson("/api/focus/targets"),
      getJson("/api/focus/status")
    ]);
    focusState.targets = targets?.rows || [];
    focusState.config = status?.config || null;
    focusState.status = status?.state || null;
    if (!Array.isArray(focusState.draftMonitored) || !focusState.draftMonitored.length) {
      focusState.draftMonitored = (focusState.config?.monitoredLiveWebRids || []).map((item) => String(item));
    }
    const currentRid =
      String(focusState.config?.selectedLiveWebRid || "").trim() ||
      String((focusState.config?.monitoredLiveWebRids || [])[0] || "").trim();
    if (currentRid) {
      const transcripts = await getJson(`/api/focus/transcripts?limit=120&liveWebRid=${encodeURIComponent(currentRid)}`);
      focusState.transcripts = transcripts?.rows || [];
    } else {
      focusState.transcripts = [];
    }
    renderFocusTargets();
    renderFocusStatus();
    renderFocusTranscripts();
  } catch (error) {
    const statusEl = document.getElementById("focus-status");
    if (statusEl) {
      statusEl.textContent = `重点话术监控加载失败：${error.message}`;
    }
  }
}

function buildRoomFilterOptions(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = getRoomKey(row);
    if (!map.has(key)) {
      map.set(key, toRoomDisplayName(resolveRoomNameFromRow(row)));
    }
  }
  return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"));
}

function renderLogMessageRoomFilter(rows) {
  const select = document.getElementById("log-message-room-filter");
  if (!select) {
    return;
  }
  const options = buildRoomFilterOptions(rows);
  const prevValue = logMessageState.roomFilter;
  select.innerHTML = `<option value="ALL">全部直播间</option>`;
  for (const [key, label] of options) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = label;
    select.appendChild(option);
  }
  if (prevValue !== "ALL" && options.some(([key]) => key === prevValue)) {
    select.value = prevValue;
  } else {
    select.value = "ALL";
    logMessageState.roomFilter = "ALL";
  }
}

function tokenizeForKeyword(text) {
  return String(text || "")
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function renderRoomKeywords(rows) {
  const stopWords = new Set(["在线人数变化", "点赞数变化", "直播状态变更", "进入直播间", "关注主播"]);
  const roomWordMap = new Map();

  for (const row of rows) {
    if (!String(row.messageType || "").includes("Chat")) {
      continue;
    }
    const roomKey = getRoomKey(row);
    if (!roomWordMap.has(roomKey)) {
      roomWordMap.set(roomKey, {
        shortName: toRoomDisplayName(resolveRoomNameFromRow(row)),
        roomUrl: getLiveRoomUrlFromRow(row),
        counts: {}
      });
    }
    const info = roomWordMap.get(roomKey);
    if (!info.roomUrl) {
      info.roomUrl = getLiveRoomUrlFromRow(row);
    }
    for (const token of tokenizeForKeyword(row.content || "")) {
      if (token.length < 2 || stopWords.has(token)) {
        continue;
      }
      info.counts[token] = (info.counts[token] || 0) + 1;
    }
  }

  const list = document.getElementById("keyword-room-list");
  list.innerHTML = "";
  if (roomWordMap.size === 0) {
    list.textContent = "暂无可统计关键词";
    return;
  }

  const rooms = [...roomWordMap.entries()].sort((a, b) => a[1].shortName.localeCompare(b[1].shortName, "zh-CN"));
  for (const [, roomInfo] of rooms) {
    const topWords = Object.entries(roomInfo.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const item = document.createElement("div");
    item.className = "keyword-room-item";

    const title = document.createElement("div");
    title.className = "keyword-room-title";
    title.innerHTML = toRoomLinkHtml(roomInfo.shortName, roomInfo.roomUrl);
    item.appendChild(title);

    const chips = document.createElement("div");
    chips.className = "keyword-room-chips";
    if (topWords.length === 0) {
      const empty = document.createElement("span");
      empty.className = "keyword-chip";
      empty.textContent = "暂无";
      chips.appendChild(empty);
    } else {
      for (const [word, count] of topWords) {
        const chip = document.createElement("span");
        chip.className = "keyword-chip";
        chip.textContent = `${word} (${count})`;
        chips.appendChild(chip);
      }
    }
    item.appendChild(chips);
    list.appendChild(item);
  }
}

function classifyMessageType(row) {
  const type = String(row?.messageType || "");
  if (type.includes("Chat")) {
    return "chat";
  }
  if (type.includes("Like")) {
    return "like";
  }
  if (type.includes("Gift")) {
    return "gift";
  }
  if (type.includes("Member")) {
    return "member";
  }
  if (type.includes("RoomStats")) {
    return "room_stats";
  }
  if (type.startsWith("Derived") || type.startsWith("ApiRoomPulse")) {
    return "derived";
  }
  return "other";
}

function getFilteredLogMessageRows(rows) {
  let filtered = rows;
  if (logMessageState.roomFilter !== "ALL") {
    filtered = filtered.filter((row) => getRoomKey(row) === logMessageState.roomFilter);
  }
  if (logMessageState.typeFilter !== "all") {
    filtered = filtered.filter((row) => classifyMessageType(row) === logMessageState.typeFilter);
  }
  return filtered;
}

function renderLogMessages(payload) {
  const list = document.getElementById("log-message-list");
  if (!list) {
    return;
  }
  list.innerHTML = "";
  const rows = payload?.rows || [];
  logMessageState.rows = rows;
  renderLogMessageRoomFilter(rows);
  const filtered = getFilteredLogMessageRows(rows);
  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><span class="tag">empty</span> 当前筛选条件下暂无消息流</div>
      <div style="color:#6a7898;font-size:12px">${fmtNowChina()}</div>
    `;
    list.appendChild(li);
    return;
  }

  for (const row of filtered) {
    const roomName = toRoomDisplayName(resolveRoomNameFromRow(row));
    const roomUrl = getLiveRoomUrlFromRow(row);
    const userId = row.userId || "-";
    const text = escapeHtml(row.content || "-");
    const li = document.createElement("li");
    li.innerHTML = `
      <div>${toRoomLinkHtml(roomName, roomUrl)}_${escapeHtml(userId)}：${text}</div>
      <div style="color:#6a7898;font-size:12px"><span class="tag">${row.messageType || "unknown"}</span> ${fmtTime(row.eventTime)}</div>
    `;
    list.appendChild(li);
  }
}
function renderLogs(payload) {
  const list = document.getElementById("log-list");
  list.innerHTML = "";
  const rows = payload?.rows || [];
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<div><span class="tag">log</span> 暂无日志输出</div>
      <div style="color:#6a7898;font-size:12px">${fmtNowChina()}</div>`;
    list.appendChild(li);
    return;
  }

  for (const row of rows) {
    const li = document.createElement("li");
    li.innerHTML = `<div><span class="tag">${row.level || "info"}</span> ${row.message || "-"}</div>
      <div style="color:#6a7898;font-size:12px">${fmtTime(row.time)}</div>`;
    list.appendChild(li);
  }
}

function renderAuthStatus(payload) {
  const el = document.getElementById("auth-status");
  const alertBox = document.getElementById("auth-alert");
  const alertText = document.getElementById("auth-alert-text");
  if (!el) {
    return;
  }

  const modeLabel = payload.collectMode === "cookie"
    ? "完整 Cookie 模式（可抓实时弹幕）"
    : payload.collectMode === "guest_probe"
      ? "游客探测模式（可采样，弹幕能力受限）"
      : "受限模式（建议补充完整 Cookie）";

  const userInfoShape = payload?.userInfoUrl?.probe?.payloadShape || "-";
  const settingShape = payload?.settingUrl?.probe?.payloadShape || "-";
  const restricted = payload?.restrictionStats?.restricted || 0;
  const sampled = payload?.restrictionStats?.total || 0;
  const workerRunning = payload?.messageWorker?.running ? "运行中" : "未运行";
  challengePageUrl = payload?.challengePageUrl || "https://live.douyin.com/";

  el.innerHTML = `
    <div><span class="tag">${modeLabel}</span></div>
    <div>user/info: ${userInfoShape}</div>
    <div>webcast/setting: ${settingShape}</div>
    <div>近10分钟受限采样: ${restricted}/${sampled}</div>
    <div>消息worker: ${workerRunning}</div>
  `;

  if (payload.collectMode === "restricted" || restricted > 0) {
    alertBox.classList.remove("hidden");
    alertText.textContent = "检测到验证码/风控限制。请在浏览器手动完成验证后，点击右侧按钮自动重试恢复。";
  } else {
    alertBox.classList.add("hidden");
    alertText.textContent = "";
  }
}

function renderInsights(payload) {
  const peaksEl = document.getElementById("insight-peaks");
  const suggestionEl = document.getElementById("insight-suggestions");
  const updateEl = document.getElementById("insight-updated-at");
  if (!peaksEl || !suggestionEl) {
    return;
  }
  if (updateEl) {
    const timeText = insightsState.displayUpdatedAt
      ? fmtTime(insightsState.displayUpdatedAt)
      : payload?.generatedAt
        ? fmtTime(payload.generatedAt)
        : "-";
    updateEl.textContent = `更新时间：${timeText}（每30分钟）`;
  }

  const peaks = payload.peaks || [];
  const lines = [];
  if (peaks.length === 0) {
    lines.push("高峰时段：暂无数据");
  } else {
    const text = peaks
      .map((item) => `${item.hour}（均值 ${item.avgOnline}，峰值 ${item.peakOnline}）`)
      .join("；");
    lines.push(`高峰时段：${text}`);
  }

  const category = payload.categoryComparison || {};
  if (category.internal || category.competitor) {
    const internal = category.internal || { avgOnline: 0, liveRate: 0 };
    const competitor = category.competitor || { avgOnline: 0, liveRate: 0 };
    lines.push(
      `内部vs竞品：内部均值 ${internal.avgOnline} / 在播率 ${internal.liveRate}%；竞品均值 ${competitor.avgOnline} / 在播率 ${competitor.liveRate}%`
    );
  }

  const departmentRows = payload.departmentRows || [];
  if (departmentRows.length > 0) {
    const top = departmentRows
      .slice(0, 3)
      .map((item) => `${item.department}(${item.avgOnline})`)
      .join("、");
    lines.push(`学科对比（今日均值在线Top）：${top}`);
  }
  peaksEl.innerHTML = lines.map((line) => `<div>${line}</div>`).join("");

  const suggestions = payload.suggestions || [];
  const scriptAdvice = payload.scriptAdvice || [];
  const merged = [...scriptAdvice, ...suggestions];
  if (merged.length === 0) {
    suggestionEl.textContent = "话术建议：暂无";
    return;
  }
  suggestionEl.innerHTML = merged.map((item) => `<div>• ${item}</div>`).join("");
}

function resetAutoRefresh() {
  if (refreshKickoffTimer) {
    clearTimeout(refreshKickoffTimer);
    refreshKickoffTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const enabled = document.getElementById("auto-refresh").checked;
  if (!enabled) {
    return;
  }

  const interval = Number(document.getElementById("refresh-interval").value || "30000");
  const delay = interval - (Date.now() % interval);
  refreshKickoffTimer = setTimeout(() => {
    refresh();
    refreshTimer = setInterval(refresh, interval);
  }, delay);
}

async function refresh() {
  try {
    const endpoints = [
      "/api/summary",
      "/api/snapshots/recent?limit=20",
      "/api/compare/departments",
      "/api/compare/internal-vs-competitor",
      "/api/messages/recent?limit=1000&scope=today",
      "/api/messages/worker-status",
      "/api/logs/recent?limit=100",
      "/api/auth/status",
      "/api/charts/department-live-avg?minutes=30&bucketSeconds=30&smoothWindow=3"
    ];
    const result = await Promise.allSettled(endpoints.map((item) => getJson(item)));
    const pick = (index, fallback) => (result[index]?.status === "fulfilled" ? result[index].value : fallback);

    const summary = pick(0, { targetSummary: { total: "-" } });
    const snapshots = pick(1, { count: 0, rows: [] });
    const dept = pick(2, { rows: [] });
    const category = pick(3, null);
    const messages = pick(4, { count: 0, rows: [] });
    const workerStatus = pick(5, { dedicatedRooms: [] });
    const logs = pick(6, { count: 0, rows: [] });
    const authStatus = pick(7, {});
    const departmentTrend = pick(8, { points: [], departments: [] });

    const nowMs = Date.now();
    const slotKey = Math.floor(nowMs / INSIGHTS_REFRESH_MS);
    const shouldRefreshInsights =
      !insightsState.payload || insightsState.slotKey === null || insightsState.slotKey !== slotKey;
    if (shouldRefreshInsights) {
      try {
        const latestInsights = await getJson("/api/insights/daily");
        insightsState.payload = latestInsights;
        insightsState.fetchedAtMs = nowMs;
        insightsState.slotKey = slotKey;
        insightsState.displayUpdatedAt = new Date(nowMs).toISOString();
      } catch (error) {
        // 保留上一次洞察，避免因单次接口失败导致板块空白。
      }
    }
    const insights = insightsState.payload || { peaks: [], suggestions: [], generatedAt: null };

    fillMetrics(summary, snapshots, messages);
    renderDepartmentTable(dept);
    renderCategoryTable(category);
    renderSnapshotTable(snapshots);
    renderLogMessages(messages);
    renderMessageMetrics(messages);
    renderRoomKeywords(messages.rows || []);
    renderDedicatedRooms(workerStatus);
    renderLogs(logs);
    renderInsights(insights);
    renderDepartmentTrend(departmentTrend);
    refreshFocusPanel();
    if (authStatus && Object.keys(authStatus).length > 0) {
      renderAuthStatus(authStatus);
    }

    const failed = result.filter((item) => item.status === "rejected").length;
    document.getElementById("refresh-time").textContent =
      failed > 0
        ? `最近刷新：${fmtNowChina()}（${failed} 个接口失败，已使用降级显示）`
        : `最近刷新：${fmtNowChina()}`;
  } catch (error) {
    document.getElementById("refresh-time").textContent = `刷新失败：${error.message}`;
  }
}

async function triggerAuthRecover() {
  const timeEl = document.getElementById("refresh-time");
  try {
    const result = await postJson("/api/auth/recover", {});
    const reason = result?.recover?.reason || "unknown";
    const started = result?.recover?.started ? "已尝试启动消息 worker" : "未启动消息 worker";
    timeEl.textContent = `恢复操作完成：${started}（${reason}）`;
    await refresh();
  } catch (error) {
    timeEl.textContent = `恢复失败：${error.message}`;
  }
}

async function openChallengePage() {
  const timeEl = document.getElementById("refresh-time");
  try {
    const payload = await getJson("/api/auth/challenge-url");
    const url = payload?.challengePageUrl || challengePageUrl || "https://live.douyin.com/";
    window.open(url, "_blank", "noopener");
    timeEl.textContent = `已打开验证码页面：${url}`;
  } catch (error) {
    window.open(challengePageUrl || "https://live.douyin.com/", "_blank", "noopener");
    timeEl.textContent = `已打开默认验证码页面（自动挑选失败）：${error.message}`;
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
}

document.getElementById("auto-refresh").addEventListener("change", resetAutoRefresh);
document.getElementById("refresh-interval").addEventListener("change", resetAutoRefresh);
document.getElementById("refresh-now").addEventListener("click", refresh);
document.getElementById("auth-recover").addEventListener("click", triggerAuthRecover);
document.getElementById("auth-open-challenge").addEventListener("click", openChallengePage);
document.getElementById("log-message-room-filter").addEventListener("change", (event) => {
  logMessageState.roomFilter = event.target.value || "ALL";
  renderLogMessages({ rows: logMessageState.rows || [] });
});
document.getElementById("log-message-type-filter").addEventListener("change", (event) => {
  logMessageState.typeFilter = event.target.value || "chat";
  renderLogMessages({ rows: logMessageState.rows || [] });
});
document.getElementById("focus-room-checklist").addEventListener("change", () => {
  focusState.draftMonitored = [...document.querySelectorAll(".focus-room-checkbox:checked")]
    .map((el) => String(el.value || "").trim())
    .filter(Boolean);
});
document.getElementById("focus-start-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("focus-status");
  const checked = [...document.querySelectorAll(".focus-room-checkbox:checked")].map((el) => String(el.value || "").trim()).filter(Boolean);
  if (!checked.length) {
    if (statusEl) {
      statusEl.textContent = "请先勾选至少一个直播间，再点击“开始监控”。";
    }
    return;
  }
  try {
    if (statusEl) {
      statusEl.textContent = "正在启动重点直播间监控...";
    }
    await postJson("/api/focus/monitor-set", {
      liveWebRids: checked,
      enabled: true
    });
    focusState.draftMonitored = [...checked];
    await refreshFocusPanel();
    if (statusEl) {
      statusEl.textContent = `已开始监控 ${checked.length} 个直播间。`;
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `启动重点监控失败：${error.message}`;
    }
  }
});
document.getElementById("focus-stop-btn").addEventListener("click", async () => {
  const statusEl = document.getElementById("focus-status");
  try {
    if (statusEl) {
      statusEl.textContent = "正在停止重点监控...";
    }
    await postJson("/api/focus/monitor-set", {
      liveWebRids: focusState.config?.monitoredLiveWebRids || [],
      enabled: false
    });
    focusState.draftMonitored = (focusState.config?.monitoredLiveWebRids || []).map((item) => String(item));
    await refreshFocusPanel();
    if (statusEl) {
      statusEl.textContent = "重点话术监控已暂停。";
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `切换重点监控失败：${error.message}`;
    }
  }
});
document.getElementById("focus-transcript-select").addEventListener("change", async (event) => {
  const liveWebRid = String(event.target.value || "").trim();
  if (!liveWebRid) {
    return;
  }
  try {
    await postJson("/api/focus/display-select", {
      liveWebRid
    });
    await refreshFocusPanel();
  } catch (error) {
    const statusEl = document.getElementById("focus-status");
    if (statusEl) {
      statusEl.textContent = `切换展示直播间失败：${error.message}`;
    }
  }
});

if (focusRefreshTimer) {
  clearInterval(focusRefreshTimer);
}
focusRefreshTimer = setInterval(refreshFocusPanel, 8000);

refresh();
refreshFocusPanel();
resetAutoRefresh();
