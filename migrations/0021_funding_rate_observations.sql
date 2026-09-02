CREATE TABLE IF NOT EXISTS funding_rate_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  funding_rate TEXT NOT NULL,
  next_funding_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'gate_crossex_websocket'
);

CREATE INDEX IF NOT EXISTS idx_funding_rate_observations_symbol_time
  ON funding_rate_observations(symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_funding_rate_observations_time
  ON funding_rate_observations(observed_at);
