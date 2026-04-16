async function getJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`request failed: ${path} ${response.status}`);
  }
  return response.json();
}

function fmtTime(value) {
  if (!value) {
    return "-";
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
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

async function refresh() {
  try {
    const [summary, snapshots, dept, category, messages] = await Promise.all([
      getJson("/api/summary"),
      getJson("/api/snapshots/recent?limit=20"),
      getJson("/api/compare/departments"),
      getJson("/api/compare/internal-vs-competitor"),
      getJson("/api/messages/recent?limit=50")
    ]);

    fillMetrics(summary, snapshots, messages);
    renderDepartmentTable(dept);
    renderCategoryTable(category);
    renderSnapshotTable(snapshots);
    renderMessages(messages);
    document.getElementById("refresh-time").textContent = `最近刷新：${new Date().toLocaleString()}`;
  } catch (error) {
    document.getElementById("refresh-time").textContent = `刷新失败：${error.message}`;
  }
}

refresh();
setInterval(refresh, 8000);
