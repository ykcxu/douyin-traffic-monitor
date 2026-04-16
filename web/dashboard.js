async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`request failed: ${path} ${response.status}`);
  }
  return response.json();
}

let refreshTimer = null;

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
  for (const row of payload.rows || []) {
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
  for (const row of payload.rows || []) {
    const statusClass = Number(row.isLive) === 1 ? "live" : "offline";
    const statusText = Number(row.isLive) === 1 ? "在播" : "离线";
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
  for (const row of payload.rows || []) {
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
  const derived = rows.filter((item) => String(item.messageType).startsWith("Derived")).length;

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
  for (const row of payload.rows || []) {
    const li = document.createElement("li");
    li.innerHTML = `<div><span class="tag">${row.level || "info"}</span> ${row.message || "-"}</div>
      <div style="color:#6a7898;font-size:12px">${fmtTime(row.time)}</div>`;
    list.appendChild(li);
  }
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
    const [summary, snapshots, dept, category, messages, logs] = await Promise.all([
      getJson("/api/summary"),
      getJson("/api/snapshots/recent?limit=20"),
      getJson("/api/compare/departments"),
      getJson("/api/compare/internal-vs-competitor"),
      getJson("/api/messages/recent?limit=50"),
      getJson("/api/logs/recent?limit=100")
    ]);

    fillMetrics(summary, snapshots, messages);
    renderDepartmentTable(dept);
    renderCategoryTable(category);
    renderSnapshotTable(snapshots);
    renderMessages(messages);
    renderMessageMetrics(messages);
    renderKeywordCloud(messages);
    renderLogs(logs);
    document.getElementById("refresh-time").textContent = `最近刷新：${new Date().toLocaleString()}`;
  } catch (error) {
    document.getElementById("refresh-time").textContent = `刷新失败：${error.message}`;
  }
}

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
}

document.getElementById("auto-refresh").addEventListener("change", resetAutoRefresh);
document.getElementById("refresh-interval").addEventListener("change", resetAutoRefresh);
document.getElementById("refresh-now").addEventListener("click", refresh);

refresh();
resetAutoRefresh();
