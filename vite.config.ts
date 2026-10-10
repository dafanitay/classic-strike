import { defineConfig } from 'vitest/config';

export default defineConfig({
  server: { port: 5180 },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
