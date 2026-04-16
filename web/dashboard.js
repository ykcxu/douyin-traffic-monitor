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
let challengePageUrl = "https://live.douyin.com/";

function fmtTime(value) {
  if (!value) {
    return "-";
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
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
    tr.innerHTML = `
      <td>${fmtTime(row.sampleTime)}</td>
      <td>${row.accountName || "-"}</td>
      <td>${row.department || "-"}</td>
      <td><span class="tag ${statusClass}">${statusText}</span></td>
      <td>${row.onlineCount ?? "-"}</td>
      <td>${row.likeCount ?? "-"}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderMessages(payload) {
  const list = document.getElementById("message-list");
  list.innerHTML = "";
  const rows = payload?.rows || [];
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><span class="tag">empty</span> 当前暂无消息</div>
      <div>可能是直播间本身弹幕较少，或刚启动尚未积累到最近窗口。</div>
      <div style="color:#6a7898;font-size:12px">${new Date().toLocaleString()}</div>
    `;
    list.appendChild(li);
    return;
  }

  for (const row of rows) {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><span class="tag">${row.messageType || "unknown"}</span> <strong>${row.userName || row.accountUid || "-"}</strong></div>
      <div>${row.content || "-"}</div>
      <div style="color:#6a7898;font-size:12px">${fmtTime(row.eventTime)}</div>
    `;
    list.appendChild(li);
  }
}

function renderMessageMetrics(payload) {
  const rows = payload.rows || [];
  const chat = rows.filter((item) => String(item.messageType).includes("Chat")).length;
  const interact = rows.filter((item) => /(Like|Gift)/.test(String(item.messageType))).length;
  const derived = rows.filter((item) => {
    const type = String(item.messageType);
    return type.startsWith("Derived") || type.startsWith("ApiRoomPulse");
  }).length;

  document.getElementById("metric-chat").textContent = chat;
  document.getElementById("metric-interact").textContent = interact;
  document.getElementById("metric-derived").textContent = derived;
}

function renderKeywordCloud(payload) {
  const words = {};
  const stopWords = new Set(["在线人数变化", "点赞数变化", "直播状态变更", "进入直播间", "关注主播"]);
  for (const row of payload.rows || []) {
    const text = (row.content || "").replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, " ").trim();
    if (!text) {
      continue;
    }
    for (const token of text.split(/\s+/)) {
      if (!token || token.length < 2 || stopWords.has(token)) {
        continue;
      }
      words[token] = (words[token] || 0) + 1;
    }
  }

  const top = Object.entries(words)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20);
  const box = document.getElementById("keyword-cloud");
  box.innerHTML = "";
  if (top.length === 0) {
    box.textContent = "暂无可统计关键词";
    return;
  }

  for (const [word, count] of top) {
    const span = document.createElement("span");
    span.className = "keyword-chip";
    span.textContent = `${word} (${count})`;
    box.appendChild(span);
  }
}

function renderLogs(payload) {
  const list = document.getElementById("log-list");
  list.innerHTML = "";
  const rows = payload?.rows || [];
  if (rows.length === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<div><span class="tag">log</span> 暂无日志输出</div>
      <div style="color:#6a7898;font-size:12px">${new Date().toLocaleString()}</div>`;
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
  if (!peaksEl || !suggestionEl) {
    return;
  }

  const peaks = payload.peaks || [];
  if (peaks.length === 0) {
    peaksEl.textContent = "高峰时段：暂无数据";
  } else {
    const text = peaks
      .map((item) => `${item.hour}（均值 ${item.avgOnline}，峰值 ${item.peakOnline}）`)
      .join("；");
    peaksEl.textContent = `高峰时段：${text}`;
  }

  const suggestions = payload.suggestions || [];
  if (suggestions.length === 0) {
    suggestionEl.textContent = "话术建议：暂无";
    return;
  }

  suggestionEl.innerHTML = suggestions.map((item) => `<div>• ${item}</div>`).join("");
}

function resetAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  const enabled = document.getElementById("auto-refresh").checked;
  if (!enabled) {
    return;
  }

  const interval = Number(document.getElementById("refresh-interval").value || "8000");
  refreshTimer = setInterval(refresh, interval);
}

async function refresh() {
  try {
    const endpoints = [
      "/api/summary",
      "/api/snapshots/recent?limit=20",
      "/api/compare/departments",
      "/api/compare/internal-vs-competitor",
      "/api/messages/recent?limit=50",
      "/api/logs/recent?limit=100",
      "/api/insights/daily",
      "/api/auth/status"
    ];
    const result = await Promise.allSettled(endpoints.map((item) => getJson(item)));
    const pick = (index, fallback) => (result[index]?.status === "fulfilled" ? result[index].value : fallback);

    const summary = pick(0, { targetSummary: { total: "-" } });
    const snapshots = pick(1, { count: 0, rows: [] });
    const dept = pick(2, { rows: [] });
    const category = pick(3, null);
    const messages = pick(4, { count: 0, rows: [] });
    const logs = pick(5, { count: 0, rows: [] });
    const insights = pick(6, { peaks: [], suggestions: [] });
    const authStatus = pick(7, {});

    fillMetrics(summary, snapshots, messages);
    renderDepartmentTable(dept);
    renderCategoryTable(category);
    renderSnapshotTable(snapshots);
    renderMessages(messages);
    renderMessageMetrics(messages);
    renderKeywordCloud(messages);
    renderLogs(logs);
    renderInsights(insights);
    if (authStatus && Object.keys(authStatus).length > 0) {
      renderAuthStatus(authStatus);
    }

    const failed = result.filter((item) => item.status === "rejected").length;
    document.getElementById("refresh-time").textContent =
      failed > 0
        ? `最近刷新：${new Date().toLocaleString()}（${failed} 个接口失败，已使用降级显示）`
        : `最近刷新：${new Date().toLocaleString()}`;
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

refresh();
resetAutoRefresh();
