CREATE TABLE IF NOT EXISTS tool_jobs (
  job_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  stage TEXT,
  current_page INTEGER,
  total_pages INTEGER,
  document_json TEXT NOT NULL,
  source_r2_key TEXT NOT NULL,
  result_r2_key TEXT,
  error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  processing_started_at TEXT,
  processing_lease_until TEXT,
  callback_url TEXT,
  callback_metadata_json TEXT,
  idempotency_key TEXT,
  idempotency_fingerprint TEXT,
  workflow_id TEXT,
  cancelled_at TEXT,
  tool TEXT NOT NULL,
  operation TEXT NOT NULL,
  tool_options_json TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tool_jobs_client_created ON tool_jobs(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_jobs_status ON tool_jobs(status);
CREATE INDEX IF NOT EXISTS tool_jobs_expires ON tool_jobs(expires_at);
CREATE INDEX IF NOT EXISTS tool_jobs_tool_status ON tool_jobs(tool, status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS tool_jobs_client_idempotency ON tool_jobs(client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS tool_jobs_workflow ON tool_jobs(workflow_id);

CREATE TABLE IF NOT EXISTS tool_job_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tool_job_events_job_sequence ON tool_job_events(job_id, sequence);
CREATE INDEX IF NOT EXISTS tool_job_events_client_job ON tool_job_events(client_id, job_id, sequence);

CREATE TABLE IF NOT EXISTS tool_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS tool_webhook_deliveries_due ON tool_webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS tool_webhook_deliveries_job ON tool_webhook_deliveries(job_id);
