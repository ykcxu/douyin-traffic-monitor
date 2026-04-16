function getBusinessDayWindow(now = new Date(), options = {}) {
  const startHour = Number.isFinite(Number(options.startHour)) ? Number(options.startHour) : 5;
  const timezoneOffsetHours = Number.isFinite(Number(options.timezoneOffsetHours))
    ? Number(options.timezoneOffsetHours)
    : 8;

  const offsetMs = timezoneOffsetHours * 60 * 60 * 1000;
  const shiftedNow = new Date(now.getTime() + offsetMs);
  const y = shiftedNow.getUTCFullYear();
  const m = shiftedNow.getUTCMonth();
  const d = shiftedNow.getUTCDate();
  const h = shiftedNow.getUTCHours();

  let startShiftedMs = Date.UTC(y, m, d, startHour, 0, 0, 0);
  if (h < startHour) {
    startShiftedMs -= 24 * 60 * 60 * 1000;
  }
  const endShiftedMs = startShiftedMs + 24 * 60 * 60 * 1000;

  const since = new Date(startShiftedMs - offsetMs).toISOString();
  const until = new Date(endShiftedMs - offsetMs).toISOString();
  return {
    since,
    until,
    startHour,
    timezoneOffsetHours
  };
}

function getPreviousBusinessDayWindow(now = new Date(), options = {}) {
  const current = getBusinessDayWindow(now, options);
  const sinceMs = new Date(current.since).getTime() - 24 * 60 * 60 * 1000;
  const untilMs = new Date(current.since).getTime();
  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    startHour: current.startHour,
    timezoneOffsetHours: current.timezoneOffsetHours
  };
}

module.exports = {
  getBusinessDayWindow,
  getPreviousBusinessDayWindow
};

