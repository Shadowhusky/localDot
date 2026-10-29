-- Report metadata; each report's gzipped bundle is in KV under bundle:<id>.
CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  install_id TEXT NOT NULL,
  version TEXT NOT NULL,
  channel TEXT NOT NULL,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'investigating', 'fixed', 'wontfix')),
  notes TEXT NOT NULL DEFAULT '',
  bundle_bytes INTEGER NOT NULL,
  -- SHA-256 of the token the sender keeps to see or delete this report.
  reporter_hash TEXT NOT NULL
);
CREATE INDEX reports_received ON reports (received_at DESC);
CREATE INDEX reports_status ON reports (status, received_at DESC);
CREATE INDEX reports_install ON reports (install_id, received_at DESC);

-- Hourly counters per hashed client address; no address is stored.
CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
