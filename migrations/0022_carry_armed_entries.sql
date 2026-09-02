CREATE TABLE IF NOT EXISTS carry_armed_entries (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('ARMED', 'TRIGGERING', 'TRIGGERED', 'CANCELLED', 'ERROR')),
  asset TEXT NOT NULL,
  short_symbol TEXT NOT NULL,
  long_symbol TEXT NOT NULL,
  credential_profile_id TEXT NOT NULL,
  credential_profile_label TEXT NOT NULL,
  strategy_json TEXT NOT NULL,
  gate_json TEXT NOT NULL,
  last_gate_reason TEXT,
  last_gate_metrics_json TEXT,
  triggered_strategy_id TEXT,
  error_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  triggered_at TEXT,
  cancelled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_carry_armed_entries_status_updated
  ON carry_armed_entries(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_carry_armed_entries_account_status
  ON carry_armed_entries(credential_profile_id, status);
