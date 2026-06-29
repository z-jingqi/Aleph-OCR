CREATE INDEX IF NOT EXISTS tool_jobs_client_status_created ON tool_jobs(client_id, status, created_at DESC);
