const config = require("../config");

const htmlUnescapeMap = {
  '\\"': '"',
  "\\\\": "\\",
  "\\/": "/",
  "\\n": "\n"
};

class LiveRoomFetchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LiveRoomFetchError";
    this.code = code;
  }
}

function unescapeInlineJson(value) {
  return value.replace(/\\"|\\\\|\\\/|\\n/g, (token) => htmlUnescapeMap[token] || token);
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseCount(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const text = String(value).trim().replace(/,/g, "");
  if (!text) {
    return null;
  }

  const unit = text.slice(-1);
  const base = Number(unit === "万" || unit === "亿" ? text.slice(0, -1) : text);
  if (!Number.isFinite(base)) {
    return null;
  }

  if (unit === "万") {
    return Math.round(base * 10000);
  }
  if (unit === "亿") {
    return Math.round(base * 100000000);
  }
  return Math.round(base);
}

function parseRoomStateFromHtml(html, liveWebRid) {
  const roomId = html.match(/\\"roomId\\":\\"(\d+)\\"/)?.[1] || null;
  const userId = html.match(/\\"user_unique_id\\":\\"(\d+)\\"/)?.[1] || null;
  const roomInfoMatch =
    html.match(
      /\\"roomInfo\\":\{\\"room\\":\{\\"id_str\\":\\".*?\\",\\"status\\":(.*?),\\"status_str\\":\\".*?\\",\\"title\\":\\"(.*?)\\"/
    ) || [];
  const title = roomInfoMatch[2] ? unescapeInlineJson(roomInfoMatch[2]) : null;
  const status = roomInfoMatch[1] ? toNumber(roomInfoMatch[1]) : null;
  const userCountStr = html.match(/\\"user_count_str\\":\\"(.*?)\\"/)?.[1] || null;
  const likeCount = toNumber(html.match(/\\"like_count\\":(.*?)(,|})/)?.[1] || null);
  const ownerUserId = html.match(/\\"owner_user_id_str\\":\\"(.*?)\\"/)?.[1] || null;

  return {
    liveWebRid,
    roomId,
    userId,
    ownerUserId,
    title,
    status,
    statusText: status === 2 ? "live" : status === 4 ? "offline" : "unknown",
    userCountText: userCountStr ? unescapeInlineJson(userCountStr) : null,
    userCount: toNumber(userCountStr),
    likeCount,
    fetchedAt: new Date().toISOString()
  };
}

async function fetchLiveRoomPage(liveWebRid) {
  const response = await fetch(`https://live.douyin.com/${liveWebRid}`, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9"
    }
  });

  if (!response.ok) {
    throw new Error(`fetch live room page failed: ${response.status}`);
  }

  const html = await response.text();
  if (html.includes("验证码中间页") || html.includes("sec_sdk_build") || html.includes("captcha/index.js")) {
    throw new LiveRoomFetchError("captcha_required", "captcha page returned");
  }

  const ttwidCookie = response.headers.getSetCookie
    ? response.headers.getSetCookie().find((item) => item.startsWith("ttwid=")) || null
    : response.headers.get("set-cookie");

  return {
    html,
    ttwidCookie
  };
}

async function fetchLiveRoomStateViaApi(liveWebRid) {
  if (!config.bridge.dyLiveCookies) {
    throw new LiveRoomFetchError("missing_cookie", "dy live cookies not configured");
  }

  const query = new URLSearchParams({
    aid: "6383",
    app_name: "douyin_web",
    live_id: "1",
    device_platform: "web",
    enter_from: "web_live",
    web_rid: liveWebRid
  });
  const url = `https://live.douyin.com/webcast/room/web/enter/?${query.toString()}`;

  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36",
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9",
      cookie: config.bridge.dyLiveCookies,
      referer: `https://live.douyin.com/${liveWebRid}`
    }
  });

  if (!response.ok) {
    throw new LiveRoomFetchError("api_http_error", `web enter api failed: ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new LiveRoomFetchError("api_json_error", error.message);
  }

  if (payload?.status_code !== 0) {
    throw new LiveRoomFetchError("api_status_error", `status_code=${payload?.status_code}`);
  }

  const room = payload?.data?.data?.[0];
  if (!room) {
    throw new LiveRoomFetchError("api_room_empty", "missing room data");
  }

  const status = Number(room.status);
  const userCountText = room.user_count_str || room?.stats?.user_count_str || null;
  const likeCountText = room.like_count || room?.stats?.like_count || null;

  return {
    liveWebRid,
    roomId: room.id_str || null,
    userId: room?.owner?.id_str || room?.owner?.id || null,
    ownerUserId: room.owner_user_id_str || null,
    title: room.title || null,
    status: Number.isFinite(status) ? status : null,
    statusText: status === 2 ? "live" : status === 4 ? "offline" : "unknown",
    userCountText: userCountText ? String(userCountText) : null,
    userCount: parseCount(userCountText),
    likeCount: parseCount(likeCountText),
    fetchedAt: new Date().toISOString(),
    ttwidCookie: null,
    rawHtmlLength: null,
    source: "webcast_room_enter_api"
  };
}

async function fetchLiveRoomState(liveWebRid) {
  try {
    return await fetchLiveRoomStateViaApi(liveWebRid);
  } catch (apiError) {
    if (apiError instanceof LiveRoomFetchError) {
      const fallbackAllowedCodes = new Set([
        "missing_cookie",
        "api_http_error",
        "api_json_error",
        "api_status_error",
        "api_room_empty"
      ]);
      if (!fallbackAllowedCodes.has(apiError.code)) {
        throw apiError;
      }
    }
  }

  const { html, ttwidCookie } = await fetchLiveRoomPage(liveWebRid);
  const state = parseRoomStateFromHtml(html, liveWebRid);
  if (!state.roomId && state.status === null && html.length < 20000) {
    throw new LiveRoomFetchError("content_unavailable", "live room content unavailable");
  }
  return {
    ...state,
    ttwidCookie,
    rawHtmlLength: html.length,
    source: "live_room_page"
  };
}

module.exports = {
  fetchLiveRoomPage,
  fetchLiveRoomState,
  parseRoomStateFromHtml,
  LiveRoomFetchError
};
