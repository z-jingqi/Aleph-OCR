import { FakeStatement } from './fake-d1';
import type { FakeGatewayEnv } from './types';

export function fakeEnv(overrides: Partial<FakeGatewayEnv> = {}): FakeGatewayEnv {
  const rows = new Map();
  const events: FakeGatewayEnv['events'] = [];
  const deliveries = new Map();
  const objects = new Map<string, Uint8Array | string>();
  const queueMessages: Array<{ jobId: string }> = [];
  const workflowCreates: Array<{ id?: string; params?: { jobId: string } }> = [];
  const env = {
    DB: undefined as unknown as D1Database,
    ASSETS: undefined as unknown as R2Bucket,
    TOOLS_JOBS: {
      async send(message: { jobId: string }) {
        queueMessages.push(message);
      },
    } as unknown as Queue<{ jobId: string }>,
    ALEPH_TOOLS_API_KEYS: '{"example-client-dev":"dev-key","other-client":"other-key"}',
    ALEPH_TOOLS_WEBHOOK_SECRETS: '{"example-client-dev":"test-webhook-secret","other-client":"other-webhook-secret"}',
    GOOGLE_VISION_API_KEY: 'test-google-key',
    ENABLE_SYNC_ENDPOINTS: 'true',
    IMAGES: undefined as ImagesBinding | undefined,
    rows,
    events,
    deliveries,
    objects,
    queueMessages,
    workflowCreates,
    failJsonResultPut: false,
    ...overrides,
  };
  env.DB = {
    prepare(sql: string) {
      return new FakeStatement(env, sql);
    },
  } as unknown as D1Database;
  env.ASSETS = {
    async put(key: string, value: string | ReadableStream | ArrayBuffer, options?: R2PutOptions) {
      if (env.failJsonResultPut && options?.httpMetadata?.contentType === 'application/json') {
        throw new Error('R2 result write failed');
      }
      objects.set(key, await normalizeR2Value(value));
    },
    async get(key: string) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return {
        async text() {
          return typeof value === 'string' ? value : new TextDecoder().decode(value);
        },
        async arrayBuffer() {
          if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
          return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        },
        body: typeof value === 'string' ? new Blob([value]).stream() : new Blob([value]).stream(),
      } as R2ObjectBody;
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? '';
      return {
        objects: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      };
    },
  } as unknown as R2Bucket;
  if (!env.TOOLS_WORKFLOW) {
    (env as FakeGatewayEnv & { TOOLS_WORKFLOW?: Workflow<{ jobId: string }> }).TOOLS_WORKFLOW = {
      async create(options: { id?: string; params?: { jobId: string } }) {
        workflowCreates.push(options);
        return {} as WorkflowInstance;
      },
    } as unknown as Workflow<{ jobId: string }>;
  }
  if (!Object.prototype.hasOwnProperty.call(overrides, 'IMAGES')) {
    env.IMAGES = fakeImagesBinding(env as FakeGatewayEnv);
  }
  return env as FakeGatewayEnv;
}

function fakeImagesBinding(env: FakeGatewayEnv): ImagesBinding {
  return {
    async info() {
      return { format: 'image/jpeg', fileSize: 3, width: 100, height: 100 };
    },
    input() {
      return {
        transform() {
          return this;
        },
        draw() {
          return this;
        },
        async output() {
          return {
            response() {
              return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/jpeg' } });
            },
            contentType() {
              return 'image/jpeg';
            },
            image() {
              return new Blob([new Uint8Array([1, 2, 3])]).stream();
            },
          } as ImageTransformationResult;
        },
      } as ImageTransformer;
    },
    hosted: {} as HostedImagesBinding,
  };
}

async function normalizeR2Value(value: string | ReadableStream | ArrayBuffer): Promise<Uint8Array | string> {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  const reader = value.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value: chunk, done } = await reader.read();
    if (done) break;
    chunks.push(chunk);
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
