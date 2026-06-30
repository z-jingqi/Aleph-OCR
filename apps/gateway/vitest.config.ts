import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
});
