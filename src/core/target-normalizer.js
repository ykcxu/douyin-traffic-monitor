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

function extractLiveWebRid(liveRoomUrl) {
  const parsed = parseUrl(liveRoomUrl);
  if (!parsed) {
    return null;
  }

  const match = parsed.pathname.match(/\/(\d+)$/);
  return match ? match[1] : null;
}

function normalizeTarget(target) {
  return {
    ...target,
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
