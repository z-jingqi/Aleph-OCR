import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/containers': new URL('./test/stubs/cloudflare-containers.ts', import.meta.url).pathname,
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
});
