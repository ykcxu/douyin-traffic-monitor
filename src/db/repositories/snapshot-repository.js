function insertRoomSnapshot(db, snapshot) {
  db.prepare(`
    INSERT INTO room_snapshots (
      room_id,
      account_uid,
      account_name,
      category,
      department,
      sample_time,
      is_live,
      online_count,
      like_count,
      comment_count,
      gift_count,
      follow_count,
      purchase_count,
      stay_duration_estimate,
      raw_payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.roomId || null,
    snapshot.accountUid || null,
    snapshot.accountName,
    snapshot.category,
    snapshot.department,
    snapshot.sampleTime,
    snapshot.isLive ? 1 : 0,
    snapshot.onlineCount,
    snapshot.likeCount,
    snapshot.commentCount || null,
    snapshot.giftCount || null,
    snapshot.followCount || null,
    snapshot.purchaseCount || null,
    snapshot.stayDurationEstimate || null,
    JSON.stringify(snapshot.rawPayload)
  );
}

function listRecentRoomSnapshots(db, limit = 10) {
  return db
    .prepare(`
      SELECT
        room_id AS roomId,
        account_uid AS accountUid,
        account_name AS accountName,
        category,
        department,
        sample_time AS sampleTime,
        is_live AS isLive,
        online_count AS onlineCount,
        like_count AS likeCount
      FROM room_snapshots
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit);
}

module.exports = {
  insertRoomSnapshot,
  listRecentRoomSnapshots
};
