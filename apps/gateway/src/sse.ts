import { getJob, listJobEvents, publicJob } from './job-store';
import type { Env } from './types';

export function createJobEventStream(
  env: Env & { DB: D1Database },
  clientId: string,
  jobId: string,
  afterSequence: number,
  once: boolean,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let cursor = afterSequence;
      const send = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const sendEvent = (event: string, id: number, data: unknown) => {
        send(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const job = await getJob(env, clientId, jobId);
      if (!job) {
        controller.close();
        return;
      }
      sendEvent('job.snapshot', cursor, publicJob(job));

      while (true) {
        const events = await listJobEvents(env, clientId, jobId, cursor);
        for (const event of events) {
          cursor = event.sequence;
          sendEvent(event.type, event.sequence, event.payload);
        }
        if (once) {
          controller.close();
          return;
        }
        send(`event: ping\ndata: {"timestamp":"${new Date().toISOString()}"}\n\n`);
        await sleep(15000);
      }
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
