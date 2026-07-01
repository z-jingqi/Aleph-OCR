# Cloudflare Service Binding Integration

Aleph Tools can be used as an internal Cloudflare Worker service through an HTTP Service Binding. This is the recommended integration for Aleph applications already running on Cloudflare Workers or Pages Functions.

Service bindings keep Worker-to-Worker traffic inside Cloudflare. Aleph Tools does not expose a public HTTP route. The `/v1/*` API contract and API-key authentication remain the same.

## Deploy Aleph Tools as an Internal Service

Generated configs are Service Binding only and do not expose a public Worker route.

```bash
pnpm deploy:generate:preview
pnpm deploy:preview
```

For production:

```bash
pnpm deploy:generate:prod
pnpm deploy:prod
```

The generated Worker has:

```json
{
  "workers_dev": false,
  "routes": []
}
```

The Worker remains callable by other Workers that declare a Service Binding to its deployed service name.

## Configure the Calling Worker

Add a service binding in the calling Worker's `wrangler.jsonc`:

```jsonc
{
  "services": [
    {
      "binding": "ALEPH_OCR",
      "service": "aleph-tools-gateway-prod"
    }
  ]
}
```

For preview:

```jsonc
{
  "services": [
    {
      "binding": "ALEPH_OCR",
      "service": "aleph-tools-gateway-preview"
    }
  ]
}
```

Store the Aleph Tools API key as a secret in the calling Worker:

```bash
wrangler secret put ALEPH_TOOLS_API_KEY
```

The API key is still required. Service Binding is a network boundary, not a tenant identity. The API key maps requests to a stable Aleph Tools `clientId`.

## Call the OCR API

Use `env.ALEPH_OCR.fetch()` with the same paths documented in [external-app-integration.md](external-app-integration.md). The hostname can be any valid URL host; routing is based on the path.

```ts
type Env = {
  ALEPH_OCR: Fetcher;
  ALEPH_TOOLS_API_KEY: string;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const form = new FormData();
    form.append('file', new File(['image-bytes'], 'receipt.jpg', { type: 'image/jpeg' }));
    form.append('metadata', JSON.stringify({ source: 'service-binding' }));

    return env.ALEPH_OCR.fetch(new Request('https://aleph-ocr.internal/v1/tools/ocr', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ALEPH_TOOLS_API_KEY}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: form,
    }));
  },
};
```

## Read Status and Result

```ts
async function readJob(env: Env, jobId: string) {
  const response = await env.ALEPH_OCR.fetch(`https://aleph-ocr.internal/v1/jobs/${jobId}`, {
    headers: { Authorization: `Bearer ${env.ALEPH_TOOLS_API_KEY}` },
  });
  return response.json();
}

async function readResult(env: Env, jobId: string) {
  const response = await env.ALEPH_OCR.fetch(`https://aleph-ocr.internal/v1/jobs/${jobId}/result`, {
    headers: { Authorization: `Bearer ${env.ALEPH_TOOLS_API_KEY}` },
  });
  return response.json();
}
```

## Operational Notes

- Prefer Service Binding for Cloudflare-hosted internal applications.
- Aleph Tools is not reachable directly from browsers, mobile apps, or external servers.
- Do not expose `ALEPH_TOOLS_API_KEY` to browsers or mobile clients.
- Source images are temporary and retained for at most 3 days.
- Aleph Tools does not provide a thumbnail endpoint. Generate/store thumbnails in the calling application if needed.
- SSE over Service Binding uses the same `/v1/jobs/:jobId/events` endpoint, but polling or webhooks are usually simpler for internal Worker workflows.
