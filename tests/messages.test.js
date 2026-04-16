const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const config = require("../src/config");
const { initDatabase } = require("../src/db/database");
const { insertLiveMessage, listRecentLiveMessages } = require("../src/db/repositories/message-repository");

function withTempDb(callback) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "douyin-messages-"));
  const originalPaths = { ...config.paths };

  try {
    config.paths.storageDir = path.join(tempRoot, "storage");
    config.paths.runtimeDir = path.join(tempRoot, "runtime");
    config.paths.databaseFile = path.join(config.paths.storageDir, "app.db");
    const db = initDatabase();
    callback(db);
  } finally {
    Object.assign(config.paths, originalPaths);
  }
}

test("message repository writes and reads recent live messages", () => {
  withTempDb((db) => {
    insertLiveMessage(db, {
      messageId: "m1",
      roomId: "r1",
      accountUid: "u1",
      eventTime: "2026-04-16T00:00:00.000Z",
      messageType: "WebcastChatMessage",
      userId: "sec1",
      userName: "Alice",
      content: "hello",
      giftName: null,
      giftCount: null,
      rawPayload: { source: "test" }
    });
    insertLiveMessage(db, {
      messageId: "m2",
      roomId: "r1",
      accountUid: "u1",
      eventTime: "2026-04-16T00:01:00.000Z",
      messageType: "WebcastLikeMessage",
      userId: "sec2",
      userName: "Bob",
      content: "点赞 3 次",
      giftName: null,
      giftCount: null,
      rawPayload: { source: "test" }
    });

    const rows = listRecentLiveMessages(db, 2);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].messageId, "m2");
    assert.equal(rows[1].messageId, "m1");
    assert.equal(rows[0].messageType, "WebcastLikeMessage");
  });
});
