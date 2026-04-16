const config = require("../config");

function parseParams(urlText) {
  if (!urlText) {
    return {};
  }

  try {
    const url = new URL(urlText);
    return {
      host: url.host,
      path: url.pathname,
      webid: url.searchParams.get("webid") || null,
      uifid: url.searchParams.get("uifid") || null,
      msToken: Boolean(url.searchParams.get("msToken")),
      aBogus: Boolean(url.searchParams.get("a_bogus"))
    };
  } catch (error) {
    return {
      parseError: error.message
    };
  }
}

async function probeUrl(urlText) {
  if (!urlText) {
    return {
      configured: false,
      ok: false
    };
  }

  const result = {
    configured: true,
    ok: false,
    statusCode: null,
    payloadShape: "unknown"
  };

  try {
    const response = await fetch(urlText, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
        referer: "https://live.douyin.com/"
      }
    });
    result.statusCode = response.status;
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;

    result.ok = response.ok;
    if (!body || typeof body !== "object") {
      result.payloadShape = "empty_or_non_json";
      return result;
    }

    if (Object.keys(body).length === 0) {
      result.payloadShape = "empty_object";
      return result;
    }

    if (typeof body.status_code === "number") {
      result.payloadShape = body.status_code === 0 ? "status_code_ok" : `status_code_${body.status_code}`;
    } else {
      result.payloadShape = "json_object";
    }
    return result;
  } catch (error) {
    return {
      configured: true,
      ok: false,
      error: error.message
    };
  }
}

async function getAuthDiagnostics() {
  const hasCookie = Boolean(config.bridge.dyLiveCookies && config.bridge.dyLiveCookies.trim());
  const userInfoMeta = parseParams(config.authProbe.userInfoUrl);
  const settingMeta = parseParams(config.authProbe.settingUrl);
  const [userInfoProbe, settingProbe] = await Promise.all([
    probeUrl(config.authProbe.userInfoUrl),
    probeUrl(config.authProbe.settingUrl)
  ]);

  let collectMode = "restricted";
  let messageRealtimeReady = false;

  if (hasCookie) {
    collectMode = "cookie";
    messageRealtimeReady = true;
  } else if (userInfoProbe.ok || settingProbe.ok) {
    collectMode = "guest_probe";
  }

  return {
    collectMode,
    messageRealtimeReady,
    hasCookie,
    userInfoUrl: {
      configured: Boolean(config.authProbe.userInfoUrl),
      meta: userInfoMeta,
      probe: userInfoProbe
    },
    settingUrl: {
      configured: Boolean(config.authProbe.settingUrl),
      meta: settingMeta,
      probe: settingProbe
    }
  };
}

module.exports = {
  getAuthDiagnostics
};
