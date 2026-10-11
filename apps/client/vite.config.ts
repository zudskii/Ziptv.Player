/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs';

import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: {
      port: 5173,
      // Dev: same-origin API through the Vite proxy (no CORS setup needed locally).
      proxy: {
        '/api': { target: env.VITE_DEV_API_TARGET || 'http://localhost:8080', changeOrigin: true },
      },
    },
    build: {
      // Smart-TV and older mobile browsers are real users of an IPTV player.
      target: ['es2020', 'chrome87', 'safari14', 'firefox78', 'edge88'],
      chunkSizeWarningLimit: 1200,
    },
    test: {
      include: ['src/**/*.test.ts'],
      environment: 'node',
    },
  };
});
