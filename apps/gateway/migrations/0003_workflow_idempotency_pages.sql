ALTER TABLE ocr_jobs ADD COLUMN idempotency_key TEXT;
ALTER TABLE ocr_jobs ADD COLUMN workflow_id TEXT;
ALTER TABLE ocr_jobs ADD COLUMN cancelled_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ocr_jobs_client_idempotency ON ocr_jobs(client_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ocr_jobs_workflow ON ocr_jobs(workflow_id);

CREATE TABLE IF NOT EXISTS ocr_job_pages (
  job_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  page_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_r2_key TEXT,
  error TEXT,
  processing_started_at TEXT,
  processing_lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (job_id, page_index)
);

CREATE INDEX IF NOT EXISTS ocr_job_pages_status ON ocr_job_pages(job_id, status, page_index);
