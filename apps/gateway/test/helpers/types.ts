export type JobRow = {
  job_id: string;
  client_id: string;
  status: string;
  progress: number;
  stage: string | null;
  current_page: number | null;
  total_pages: number | null;
  document_json: string;
  source_r2_key: string;
  result_r2_key: string | null;
  error: string | null;
  attempt_count: number;
  processing_started_at: string | null;
  processing_lease_until: string | null;
  callback_url: string | null;
  callback_metadata_json: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  workflow_id: string | null;
  cancelled_at: string | null;
  tool: string;
  operation: string | null;
  tool_options_json: string | null;
  output_r2_key: string | null;
  output_json: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

export type PageRow = {
  job_id: string;
  client_id: string;
  page_index: number;
  status: string;
  attempt_count: number;
  result_r2_key: string | null;
  error: string | null;
  processing_started_at: string | null;
  processing_lease_until: string | null;
  created_at: string;
  updated_at: string;
};

export type EventRow = {
  event_id: string;
  job_id: string;
  client_id: string;
  sequence: number;
  type: string;
  payload_json: string;
  created_at: string;
};

export type DeliveryRow = {
  delivery_id: string;
  event_id: string;
  job_id: string;
  client_id: string;
  callback_url: string;
  payload_json: string;
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type FakeGatewayEnv = {
  DB: D1Database;
  ASSETS: R2Bucket;
  TOOLS_JOBS: Queue<{ jobId: string }>;
  TOOLS_WORKFLOW?: Workflow<{ jobId: string }>;
  ALEPH_TOOLS_API_KEYS: string;
  ALEPH_TOOLS_ENGINE_URL: string;
  WEBHOOK_SIGNING_SECRET: string;
  MAX_JOB_ATTEMPTS?: string;
  MAX_ACTIVE_JOBS_PER_CLIENT?: string;
  MAX_IMAGE_UPLOAD_BYTES?: string;
  ENABLE_SYNC_ENDPOINTS?: string;
  ENABLE_LEGACY_IMAGE_ENDPOINTS?: string;
  TOOLS_ENGINE_INSTANCE_COUNT?: string;
  rows: Map<string, JobRow>;
  events: EventRow[];
  deliveries: Map<string, DeliveryRow>;
  pages: PageRow[];
  objects: Map<string, Uint8Array | string>;
  queueMessages: Array<{ jobId: string }>;
  workflowCreates: Array<{ id?: string; params?: { jobId: string } }>;
  failJsonResultPut: boolean;
};
