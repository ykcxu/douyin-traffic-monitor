function parseUrl(value) {
  if (!value) {
    return null;
  }

  try {
    return new URL(value);
  } catch (error) {
    return null;
  }
}

function sanitizeLabel(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return String(value)
    .normalize("NFKC")
    .replace(/\uFFFD+/g, "")
    .replace(/\?{2,}/g, "")
    .trim();
}

function extractLiveWebRid(liveRoomUrl) {
  const parsed = parseUrl(liveRoomUrl);
  if (!parsed) {
    return null;
  }

  const match = parsed.pathname.match(/\/(\d+)$/);
  return match ? match[1] : null;
}

function normalizeTarget(target) {
  const accountName = sanitizeLabel(target.accountName);
  const platform = sanitizeLabel(target.platform);
  const category = sanitizeLabel(target.category);
  const department = sanitizeLabel(target.department);
  const accountType = sanitizeLabel(target.accountType);
  return {
    ...target,
    accountName,
    platform,
    category,
    department,
    accountType,
    liveWebRid: extractLiveWebRid(target.liveRoomUrl),
    hasLiveRoom: Boolean(target.liveRoomUrl),
    hasProfile: Boolean(target.profileUrl)
  };
}

function normalizeTargets(targets) {
  return targets.map(normalizeTarget);
}

module.exports = {
  extractLiveWebRid,
  normalizeTarget,
  normalizeTargets
};
