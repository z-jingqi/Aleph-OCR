import type { ToolResult } from '@aleph-tools/shared';
import { PAGE_RESULT_PREFIX, type JobStoreEnv, type StoredJob } from './schema';

export async function getSourceFile(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<R2ObjectBody | null> {
  return env.ASSETS.get(job.sourceR2Key);
}

export async function getResult(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<ToolResult | null> {
  if (!job.resultR2Key) return null;
  const object = await env.ASSETS.get(job.resultR2Key);
  if (!object) return null;
  return JSON.parse(await object.text()) as ToolResult;
}

export async function getOutputFile(
  env: JobStoreEnv & { ASSETS: R2Bucket },
  job: StoredJob,
): Promise<R2ObjectBody | null> {
  if (!job.outputR2Key) return null;
  return env.ASSETS.get(job.outputR2Key);
}

export async function deleteJobObjects(env: JobStoreEnv & { ASSETS: R2Bucket }, job: StoredJob): Promise<void> {
  const pagePrefix = `${PAGE_RESULT_PREFIX}/${job.clientId}/${job.jobId}/`;
  const pageDeletes: Promise<void>[] = [];
  if ('list' in env.ASSETS) {
    const listed = await env.ASSETS.list({ prefix: pagePrefix });
    pageDeletes.push(...listed.objects.map((object) => env.ASSETS.delete(object.key)));
  }
  await Promise.all([
    env.ASSETS.delete(job.sourceR2Key),
    ...(job.resultR2Key ? [env.ASSETS.delete(job.resultR2Key)] : []),
    ...(job.outputR2Key ? [env.ASSETS.delete(job.outputR2Key)] : []),
    ...pageDeletes,
  ]);
}
