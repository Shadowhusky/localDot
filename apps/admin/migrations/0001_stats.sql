-- Aggregate counters only. No addresses, user agents, cookies, prompts, keys or file names.
CREATE TABLE counters (
  hour INTEGER NOT NULL,
  event TEXT NOT NULL,
  dimension TEXT NOT NULL,
  value TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, event, dimension, value)
) WITHOUT ROWID;
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE assets (
  id INTEGER PRIMARY KEY,
  version TEXT NOT NULL,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  downloads INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE TABLE download_days (day TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE login_limits (key TEXT PRIMARY KEY, expires INTEGER NOT NULL, n INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX login_expiry ON login_limits(expires);
