const { nowIso } = require("../../utils/time");

function replaceTargets(db, targets) {
  const timestamp = nowIso();

  db.exec("DELETE FROM monitor_targets;");

  const statement = db.prepare(`
    INSERT INTO monitor_targets (
      platform,
      category,
      department,
      account_type,
      account_name,
      account_uid,
      live_room_url,
      profile_url,
      monitoring_requirements,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const target of targets) {
    statement.run(
      target.platform,
      target.category,
      target.department,
      target.accountType || null,
      target.accountName,
      target.accountUid || null,
      target.liveRoomUrl || null,
      target.profileUrl || null,
      target.monitoringRequirements || null,
      timestamp,
      timestamp
    );
  }
}

function listTargetSummaries(db) {
  return db
    .prepare(`
      SELECT
        category,
        department,
        account_type AS accountType,
        account_name AS accountName,
        account_uid AS accountUid,
        live_room_url AS liveRoomUrl,
        profile_url AS profileUrl
      FROM monitor_targets
      ORDER BY category, department, account_name
    `)
    .all();
}

module.exports = {
  replaceTargets,
  listTargetSummaries
};
