import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Shown on the main menu, so a player can tell which build they are running.
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
  server: {
    port: 5180,
    // In development the game server runs separately (npm run dev:server).
    proxy: { '/ws': { target: 'ws://127.0.0.1:8080', ws: true } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
  test: { include: ['src/**/*.test.ts', 'server/**/*.test.ts'], environment: 'node' },
});
