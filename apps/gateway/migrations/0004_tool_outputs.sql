ALTER TABLE ocr_jobs ADD COLUMN tool TEXT NOT NULL DEFAULT 'ocr';
ALTER TABLE ocr_jobs ADD COLUMN operation TEXT;
ALTER TABLE ocr_jobs ADD COLUMN tool_options_json TEXT;
ALTER TABLE ocr_jobs ADD COLUMN output_r2_key TEXT;
ALTER TABLE ocr_jobs ADD COLUMN output_json TEXT;
ALTER TABLE ocr_jobs ADD COLUMN idempotency_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS ocr_jobs_tool_status ON ocr_jobs(tool, status, created_at DESC);
