import type { ToolResult } from '@aleph-tools/shared';
import { type JobStoreEnv, type StoredJob } from './schema';

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

export async function deleteJobObjects(env: JobStoreEnv & { ASSETS: R2Bucket }, job: StoredJob): Promise<void> {
  await Promise.all([
    env.ASSETS.delete(job.sourceR2Key),
    ...(job.resultR2Key ? [env.ASSETS.delete(job.resultR2Key)] : []),
  ]);
}
