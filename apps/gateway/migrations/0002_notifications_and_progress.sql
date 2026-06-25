ALTER TABLE ocr_jobs ADD COLUMN progress INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ocr_jobs ADD COLUMN stage TEXT;
ALTER TABLE ocr_jobs ADD COLUMN current_page INTEGER;
ALTER TABLE ocr_jobs ADD COLUMN total_pages INTEGER;
ALTER TABLE ocr_jobs ADD COLUMN completed_at TEXT;
ALTER TABLE ocr_jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ocr_jobs ADD COLUMN processing_started_at TEXT;
ALTER TABLE ocr_jobs ADD COLUMN processing_lease_until TEXT;
ALTER TABLE ocr_jobs ADD COLUMN callback_url TEXT;
ALTER TABLE ocr_jobs ADD COLUMN callback_metadata_json TEXT;

CREATE TABLE IF NOT EXISTS ocr_job_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ocr_job_events_job_sequence ON ocr_job_events(job_id, sequence);
CREATE INDEX IF NOT EXISTS ocr_job_events_client_job ON ocr_job_events(client_id, job_id, sequence);

CREATE TABLE IF NOT EXISTS ocr_webhook_deliveries (
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

CREATE INDEX IF NOT EXISTS ocr_webhook_deliveries_due ON ocr_webhook_deliveries(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ocr_webhook_deliveries_job ON ocr_webhook_deliveries(job_id);
