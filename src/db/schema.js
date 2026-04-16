const schemaSql = `
CREATE TABLE IF NOT EXISTS monitor_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  department TEXT NOT NULL,
  account_type TEXT,
  account_name TEXT NOT NULL,
  account_uid TEXT,
  live_room_url TEXT,
  profile_url TEXT,
  monitoring_requirements TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT,
  account_uid TEXT,
  account_name TEXT,
  category TEXT,
  department TEXT,
  sample_time TEXT NOT NULL,
  is_live INTEGER NOT NULL DEFAULT 0,
  online_count INTEGER,
  like_count INTEGER,
  comment_count INTEGER,
  gift_count INTEGER,
  follow_count INTEGER,
  purchase_count INTEGER,
  stay_duration_estimate INTEGER,
  raw_payload TEXT
);

CREATE TABLE IF NOT EXISTS live_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  room_id TEXT,
  account_uid TEXT,
  event_time TEXT NOT NULL,
  message_type TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  content TEXT,
  gift_name TEXT,
  gift_count INTEGER,
  raw_payload TEXT
);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_uid TEXT,
  account_name TEXT,
  category TEXT,
  department TEXT,
  snapshot_time TEXT NOT NULL,
  followers_count INTEGER,
  post_count INTEGER,
  liked_count INTEGER,
  raw_payload TEXT
);

CREATE TABLE IF NOT EXISTS analysis_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL,
  report_date TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS script_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  room_id TEXT,
  account_uid TEXT,
  account_name TEXT,
  summary TEXT NOT NULL,
  effective_phrases_json TEXT NOT NULL,
  risky_phrases_json TEXT NOT NULL,
  recommended_rewrites_json TEXT NOT NULL,
  faq_response_suggestions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS peak_segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_date TEXT NOT NULL,
  room_id TEXT,
  account_uid TEXT,
  account_name TEXT,
  peak_start_time TEXT NOT NULL,
  peak_end_time TEXT NOT NULL,
  peak_reason TEXT NOT NULL,
  online_count_peak INTEGER,
  message_rate_peak INTEGER,
  recording_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  details_json TEXT NOT NULL
);
`;

module.exports = {
  schemaSql
};
