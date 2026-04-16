function insertLiveMessage(db, message) {
  db.prepare(`
    INSERT INTO live_messages (
      message_id,
      room_id,
      account_uid,
      event_time,
      message_type,
      user_id,
      user_name,
      content,
      gift_name,
      gift_count,
      raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    message.messageId || null,
    message.roomId || null,
    message.accountUid || null,
    message.eventTime,
    message.messageType,
    message.userId || null,
    message.userName || null,
    message.content || null,
    message.giftName || null,
    message.giftCount || null,
    JSON.stringify(message.rawPayload || {})
  );
}

function listRecentLiveMessages(db, limit = 50) {
  return db
    .prepare(`
      SELECT
        message_id AS messageId,
        room_id AS roomId,
        account_uid AS accountUid,
        event_time AS eventTime,
        message_type AS messageType,
        user_id AS userId,
        user_name AS userName,
        content,
        gift_name AS giftName,
        gift_count AS giftCount
      FROM live_messages
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit);
}

module.exports = {
  insertLiveMessage,
  listRecentLiveMessages
};
