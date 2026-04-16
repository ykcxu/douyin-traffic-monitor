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

async function fetchLiveRoomState(liveWebRid) {
  const { html, ttwidCookie } = await fetchLiveRoomPage(liveWebRid);
  const state = parseRoomStateFromHtml(html, liveWebRid);
  if (!state.roomId && state.status === null && html.length < 20000) {
    throw new LiveRoomFetchError("content_unavailable", "live room content unavailable");
  }

  return {
    ...state,
    ttwidCookie,
    rawHtmlLength: html.length
  };
}

module.exports = {
  fetchLiveRoomPage,
  fetchLiveRoomState,
  parseRoomStateFromHtml,
  LiveRoomFetchError
};
