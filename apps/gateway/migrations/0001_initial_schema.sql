CREATE TABLE IF NOT EXISTS ocr_jobs (
  job_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL,
  document_json TEXT NOT NULL,
  source_r2_key TEXT NOT NULL,
  result_r2_key TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ocr_jobs_client_created ON ocr_jobs(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ocr_jobs_status ON ocr_jobs(status);
CREATE INDEX IF NOT EXISTS ocr_jobs_expires ON ocr_jobs(expires_at);
