/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],
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
