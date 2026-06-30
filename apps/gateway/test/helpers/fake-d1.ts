import type { FakeGatewayEnv } from './types';

export class FakeStatement {
  private params: unknown[] = [];

  constructor(
    private readonly env: FakeGatewayEnv,
    private readonly sql: string,
  ) {}

  bind(...params: unknown[]) {
    this.params = params;
    return this;
  }

  async first<T>() {
    return this.selectRows()[0] as T | null;
  }

  async all<T>() {
    return { results: this.selectRows() as T[] };
  }

  async run() {
    const sql = normalizeSql(this.sql);
    let changes = 0;
    if (sql.includes('insert into tool_jobs')) changes = this.insertJob();
    else if (sql.includes('update tool_jobs') && sql.includes('attempt_count = attempt_count + 1')) changes = this.claimJob();
    else if (sql.includes('update tool_jobs') && sql.includes('workflow_id = ?')) changes = this.attachWorkflow();
    else if (sql.includes('update tool_jobs') && sql.includes('cancelled_at = ?')) changes = this.requestCancel();
    else if (sql.includes('update tool_jobs') && sql.includes('coalesce(cancelled_at')) changes = this.completeCancel();
    else if (sql.includes('update tool_jobs') && sql.includes('completed_at = null') && sql.includes('where job_id = ? and status = ?')) changes = this.requeueJobForRetry();
    else if (sql.includes('update tool_jobs') && sql.includes('where job_id = ? and status = ?')) changes = this.resetExpiredJob();
    else if (sql.includes('update tool_jobs') && sql.includes('coalesce')) changes = this.updateProgress();
    else if (sql.includes('update tool_jobs') && sql.includes('result_r2_key = ?')) changes = this.setReady();
    else if (sql.includes('update tool_jobs') && sql.includes('result_r2_key = null')) changes = this.setDeleted();
    else if (sql.includes('insert into tool_job_events')) changes = this.insertEvent();
    else if (sql.includes('insert into tool_webhook_deliveries')) changes = this.insertDelivery();
    else if (sql.includes('update tool_webhook_deliveries') && sql.includes('status = ?') && sql.includes('next_attempt_at = null')) changes = this.markDelivered();
    else if (sql.includes('update tool_webhook_deliveries') && sql.includes('next_attempt_at = ?')) changes = this.markFailed();
    return { success: true, meta: { changes, rows_written: changes } };
  }

  private insertJob() {
    const [
      jobId,
      clientId,
      status,
      progress,
      stage,
      documentJson,
      sourceR2Key,
      callbackUrl,
      callbackMetadataJson,
      idempotencyKey,
      idempotencyFingerprint,
      workflowId,
      tool,
      operation,
      toolOptionsJson,
      createdAt,
      updatedAt,
      expiresAt,
    ] = this.params;
    this.env.rows.set(jobId as string, {
      job_id: jobId as string,
      client_id: clientId as string,
      status: status as string,
      progress: progress as number,
      stage: stage as string,
      current_page: null,
      total_pages: null,
      document_json: documentJson as string,
      source_r2_key: sourceR2Key as string,
      result_r2_key: null,
      error: null,
      attempt_count: 0,
      processing_started_at: null,
      processing_lease_until: null,
      callback_url: callbackUrl as string | null,
      callback_metadata_json: callbackMetadataJson as string | null,
      idempotency_key: idempotencyKey as string | null,
      idempotency_fingerprint: idempotencyFingerprint as string | null,
      workflow_id: workflowId as string | null,
      cancelled_at: null,
      tool: (tool as string | null) ?? 'ocr',
      operation: operation as string | null,
      tool_options_json: toolOptionsJson as string | null,
      completed_at: null,
      created_at: createdAt as string,
      updated_at: updatedAt as string,
      expires_at: expiresAt as string,
    });
    return 1;
  }

  private attachWorkflow() {
    const [workflowId, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.workflow_id) return 0;
    row.workflow_id = workflowId as string;
    row.updated_at = updatedAt as string;
    return 1;
  }

  private claimJob() {
    const [status, progress, stage, startedAt, leaseUntil, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || !['queued', 'failed'].includes(row.status)) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      error: null,
      attempt_count: row.attempt_count + 1,
      processing_started_at: startedAt,
      processing_lease_until: leaseUntil,
      updated_at: updatedAt,
    });
    return 1;
  }

  private resetExpiredJob() {
    const [status, progress, stage, error, updatedAt, jobId, expectedStatus] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.status !== expectedStatus) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      error,
      processing_started_at: null,
      processing_lease_until: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private requeueJobForRetry() {
    const [status, progress, stage, error, updatedAt, jobId, expectedStatus] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.status !== expectedStatus) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      error,
      processing_started_at: null,
      processing_lease_until: null,
      completed_at: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private requestCancel() {
    const [status, progress, stage, cancelledAt, completedAt, updatedAt, jobId, clientId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || row.client_id !== clientId || ['ready', 'failed', 'cancelled', 'deleted'].includes(row.status)) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      processing_started_at: null,
      processing_lease_until: null,
      cancelled_at: cancelledAt,
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private completeCancel() {
    const [status, progress, stage, cancelledAt, completedAt, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string);
    if (!row || !['cancel_requested', 'processing', 'queued'].includes(row.status)) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      processing_started_at: null,
      processing_lease_until: null,
      cancelled_at: row.cancelled_at ?? (cancelledAt as string),
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private updateProgress() {
    const [status, progress, stage, currentPage, totalPages, error, completedAt, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string)!;
    Object.assign(row, {
      status: status ?? row.status,
      progress: progress ?? row.progress,
      stage: stage ?? row.stage,
      current_page: currentPage as number | null,
      total_pages: totalPages as number | null,
      error: error as string | null,
      completed_at: completedAt as string | null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private setReady() {
    const [status, progress, stage, currentPage, totalPages, resultR2Key, completedAt, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string)!;
    Object.assign(row, {
      status,
      progress,
      stage,
      current_page: currentPage as number | null,
      total_pages: totalPages as number | null,
      result_r2_key: resultR2Key,
      error: null,
      processing_started_at: null,
      processing_lease_until: null,
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private setDeleted() {
    const [status, progress, stage, completedAt, updatedAt, jobId] = this.params;
    const row = this.env.rows.get(jobId as string)!;
    if (!row) return 0;
    Object.assign(row, {
      status,
      progress,
      stage,
      result_r2_key: null,
      processing_started_at: null,
      processing_lease_until: null,
      completed_at: completedAt,
      updated_at: updatedAt,
    });
    return 1;
  }

  private insertEvent() {
    const [eventId, jobId, clientId, sequence, type, payloadJson, createdAt] = this.params;
    this.env.events.push({
      event_id: eventId as string,
      job_id: jobId as string,
      client_id: clientId as string,
      sequence: sequence as number,
      type: type as string,
      payload_json: payloadJson as string,
      created_at: createdAt as string,
    });
    return 1;
  }

  private insertDelivery() {
    const [deliveryId, eventId, jobId, clientId, callbackUrl, payloadJson, status, nextAttemptAt, createdAt, updatedAt] = this.params;
    this.env.deliveries.set(deliveryId as string, {
      delivery_id: deliveryId as string,
      event_id: eventId as string,
      job_id: jobId as string,
      client_id: clientId as string,
      callback_url: callbackUrl as string,
      payload_json: payloadJson as string,
      status: status as string,
      attempt_count: 0,
      next_attempt_at: nextAttemptAt as string,
      last_error: null,
      created_at: createdAt as string,
      updated_at: updatedAt as string,
    });
    return 1;
  }

  private markDelivered() {
    const [status, updatedAt, deliveryId] = this.params;
    const row = this.env.deliveries.get(deliveryId as string)!;
    if (!row) return 0;
    Object.assign(row, {
      status,
      attempt_count: row.attempt_count + 1,
      next_attempt_at: null,
      last_error: null,
      updated_at: updatedAt,
    });
    return 1;
  }

  private markFailed() {
    const [status, attempts, nextAttemptAt, error, updatedAt, deliveryId] = this.params;
    const row = this.env.deliveries.get(deliveryId as string)!;
    if (!row) return 0;
    Object.assign(row, {
      status,
      attempt_count: attempts,
      next_attempt_at: nextAttemptAt,
      last_error: error,
      updated_at: updatedAt,
    });
    return 1;
  }

  private selectRows() {
    const sql = normalizeSql(this.sql);
    if (sql.includes('select coalesce(max(sequence)')) {
      const [jobId] = this.params;
      const max = this.env.events.filter((row) => row.job_id === jobId).reduce((value, row) => Math.max(value, row.sequence), 0);
      return [{ sequence: max + 1 }];
    }
    if (sql.includes('from tool_job_events')) {
      const [jobId, clientId, afterSequence] = this.params;
      return this.env.events
        .filter((row) => row.job_id === jobId && row.client_id === clientId && row.sequence > (afterSequence as number))
        .sort((a, b) => a.sequence - b.sequence)
        .slice(0, 100);
    }
    if (sql.includes("where status in ('queued', 'processing', 'cancel_requested')") && !sql.includes('client_id = ?')) {
      return [...this.env.rows.values()]
        .filter((row) => ['queued', 'processing', 'cancel_requested'].includes(row.status))
        .map((row) => ({ job_id: row.job_id }));
    }
    if (sql.includes("status in ('queued', 'processing', 'cancel_requested')")) {
      const [clientId] = this.params;
      return [...this.env.rows.values()]
        .filter((row) => row.client_id === clientId && ['queued', 'processing', 'cancel_requested'].includes(row.status))
        .map((row) => ({ job_id: row.job_id }));
    }
    if (sql.includes('from tool_webhook_deliveries')) {
      const [now] = this.params;
      return [...this.env.deliveries.values()].filter(
        (row) => ['pending', 'failed'].includes(row.status) && (!row.next_attempt_at || row.next_attempt_at <= (now as string)),
      );
    }
    if (sql.includes('where client_id = ? and idempotency_key = ?')) {
      const [clientId, idempotencyKey] = this.params;
      return [...this.env.rows.values()].filter((row) => row.client_id === clientId && row.idempotency_key === idempotencyKey);
    }
    if (sql.includes('where job_id = ? and client_id = ?')) {
      const [jobId, clientId] = this.params;
      const row = this.env.rows.get(jobId as string);
      return row && row.client_id === clientId ? [row] : [];
    }
    if (sql.includes('where expires_at <= ?')) {
      const [now, deleted] = this.params;
      return [...this.env.rows.values()].filter((row) => row.expires_at <= (now as string) && row.status !== deleted);
    }
    if (sql.includes('where status = ? and processing_lease_until')) {
      const [status, now] = this.params;
      return [...this.env.rows.values()]
        .filter((row) => row.status === status && row.processing_lease_until && row.processing_lease_until <= (now as string))
        .map((row) => ({ job_id: row.job_id }));
    }
    if (sql.includes('where job_id = ?')) {
      const row = this.env.rows.get(this.params[0] as string);
      return row ? [row] : [];
    }
    return [];
  }
}

function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/\s+/g, ' ');
}
