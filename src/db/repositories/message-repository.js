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

function listRecentLiveMessages(db, limit = 50, options = {}) {
  const clauses = [];
  const params = [];
  if (options.since) {
    clauses.push("m.event_time >= ?");
    params.push(options.since);
  }
  if (options.until) {
    clauses.push("m.event_time < ?");
    params.push(options.until);
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  return db
    .prepare(`
      SELECT
        m.message_id AS messageId,
        m.room_id AS roomId,
        m.account_uid AS accountUid,
        m.event_time AS eventTime,
        m.message_type AS messageType,
        m.user_id AS userId,
        m.user_name AS userName,
        m.content,
        m.gift_name AS giftName,
        m.gift_count AS giftCount,
        COALESCE(
          (
            SELECT t.account_name
            FROM monitor_targets t
            WHERE t.account_uid = m.account_uid
            LIMIT 1
          ),
          (
            SELECT t2.account_name
            FROM monitor_targets t2
            WHERE m.room_id IS NOT NULL AND t2.live_room_url LIKE ('%' || m.room_id || '%')
            LIMIT 1
          ),
          (
            SELECT s.account_name
            FROM room_snapshots s
            WHERE
              (m.account_uid IS NOT NULL AND s.account_uid = m.account_uid)
              OR
              (m.room_id IS NOT NULL AND s.room_id = m.room_id)
            ORDER BY s.id DESC
            LIMIT 1
          ),
          m.user_name
        ) AS accountName
      FROM live_messages m
      ${whereSql}
      ORDER BY m.id DESC
      LIMIT ?
    `)
    .all(...params, limit);
}

function countLiveMessages(db, options = {}) {
  const clauses = [];
  const params = [];
  if (options.since) {
    clauses.push("event_time >= ?");
    params.push(options.since);
  }
  if (options.until) {
    clauses.push("event_time < ?");
    params.push(options.until);
  }
  if (options.chatOnly) {
    clauses.push("message_type LIKE '%Chat%'");
  }
  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const row = db
    .prepare(
      `
      SELECT COUNT(*) AS total
      FROM live_messages
      ${whereSql}
    `
    )
    .get(...params);
  return Number(row?.total || 0);
}

module.exports = {
  insertLiveMessage,
  listRecentLiveMessages,
  countLiveMessages
};
