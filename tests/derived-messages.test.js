const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDerivedMessagesFromSnapshots } = require("../src/services/derived-message-service");

test("derived message builder creates online and like deltas", () => {
  const target = { accountUid: "uid-1" };
  const previousSnapshot = {
    roomId: "r-1",
    sampleTime: "2026-04-16T01:00:00.000Z",
    isLive: 0,
    onlineCount: 10,
    likeCount: 20
  };
  const currentSnapshot = {
    roomId: "r-1",
    sampleTime: "2026-04-16T01:00:30.000Z",
    isLive: 1,
    onlineCount: 30,
    likeCount: 50
  };

  const rows = buildDerivedMessagesFromSnapshots(target, previousSnapshot, currentSnapshot);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].messageType, "DerivedLiveStatus");
  assert.equal(rows[1].messageType, "DerivedOnlineDelta");
  assert.equal(rows[2].messageType, "DerivedLikeDelta");
});
