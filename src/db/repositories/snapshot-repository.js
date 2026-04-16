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
        like_count AS likeCount,
        raw_payload AS rawPayload
      FROM room_snapshots
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit);
}

function listRecentSnapshotsByAccountName(db, accountName, limit = 2) {
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
        like_count AS likeCount,
        raw_payload AS rawPayload
      FROM room_snapshots
      WHERE account_name = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(accountName, limit);
}

function listLatestSnapshotByAccount(db) {
  return db
    .prepare(`
      SELECT
        s.room_id AS roomId,
        s.account_uid AS accountUid,
        s.account_name AS accountName,
        s.category,
        s.department,
        s.sample_time AS sampleTime,
        s.is_live AS isLive,
        s.online_count AS onlineCount,
        s.like_count AS likeCount
      FROM room_snapshots s
      INNER JOIN (
        SELECT account_name, MAX(id) AS max_id
        FROM room_snapshots
        GROUP BY account_name
      ) latest
      ON latest.max_id = s.id
      ORDER BY s.id DESC
    `)
    .all();
}

function summarizeByDepartmentFromSnapshots(db) {
  return db
    .prepare(`
      SELECT
        department,
        COUNT(*) AS sampledRooms,
        SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) AS liveRooms,
        AVG(COALESCE(online_count, 0)) AS avgOnlineCount,
        MAX(COALESCE(online_count, 0)) AS peakOnlineCount,
        AVG(COALESCE(like_count, 0)) AS avgLikeCount
      FROM (
        SELECT s.*
        FROM room_snapshots s
        INNER JOIN (
          SELECT account_name, MAX(id) AS max_id
          FROM room_snapshots
          GROUP BY account_name
        ) latest
        ON latest.max_id = s.id
      )
      GROUP BY department
      ORDER BY department
    `)
    .all();
}

function summarizeInternalVsCompetitorFromSnapshots(db) {
  return db
    .prepare(`
      SELECT
        category,
        COUNT(*) AS sampledRooms,
        SUM(CASE WHEN is_live = 1 THEN 1 ELSE 0 END) AS liveRooms,
        AVG(COALESCE(online_count, 0)) AS avgOnlineCount,
        MAX(COALESCE(online_count, 0)) AS peakOnlineCount,
        AVG(COALESCE(like_count, 0)) AS avgLikeCount
      FROM (
        SELECT s.*
        FROM room_snapshots s
        INNER JOIN (
          SELECT account_name, MAX(id) AS max_id
          FROM room_snapshots
          GROUP BY account_name
        ) latest
        ON latest.max_id = s.id
      )
      GROUP BY category
      ORDER BY category
    `)
    .all();
}

function listDepartmentLiveAveragesByBucket(db, sinceIso, bucketSeconds = 60) {
  const safeBucketSeconds = Number.isFinite(bucketSeconds) && bucketSeconds > 0 ? Math.floor(bucketSeconds) : 60;
  return db
    .prepare(
      `
      SELECT
        department,
        datetime(CAST(CAST(strftime('%s', sample_time) AS INTEGER) / ? AS INTEGER) * ?, 'unixepoch') AS bucketTime,
        AVG(CASE WHEN is_live = 1 THEN COALESCE(online_count, 0) END) AS avgOnlineLive
      FROM room_snapshots
      WHERE sample_time >= ?
      GROUP BY department, bucketTime
      ORDER BY bucketTime ASC, department ASC
    `
    )
    .all(safeBucketSeconds, safeBucketSeconds, sinceIso);
}

function listSnapshotsForTrend(db, sinceIso) {
  return db
    .prepare(
      `
      SELECT
        account_name AS accountName,
        department,
        sample_time AS sampleTime,
        is_live AS isLive,
        online_count AS onlineCount
      FROM room_snapshots
      WHERE sample_time >= ?
      ORDER BY sample_time ASC, id ASC
    `
    )
    .all(sinceIso);
}

module.exports = {
  insertRoomSnapshot,
  listRecentRoomSnapshots,
  listRecentSnapshotsByAccountName,
  listLatestSnapshotByAccount,
  getRecentRestrictionStats,
  listDepartmentLiveAveragesByBucket,
  listSnapshotsForTrend,
  summarizeByDepartmentFromSnapshots,
  summarizeInternalVsCompetitorFromSnapshots
};

function getRecentRestrictionStats(db, sinceIso) {
  const row = db
    .prepare(
      `
      SELECT
        COUNT(*) AS total,
        SUM(
          CASE
            WHEN json_extract(raw_payload, '$.fetchStatus') = 'captcha_required'
              OR json_extract(raw_payload, '$.statusText') = 'restricted'
            THEN 1 ELSE 0
          END
        ) AS restricted
      FROM room_snapshots
      WHERE sample_time >= ?
    `
    )
    .get(sinceIso);

  return {
    total: row?.total || 0,
    restricted: row?.restricted || 0
  };
}
