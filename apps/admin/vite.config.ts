/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      port: 5174,
      // Dev: the console API lives on the server's admin listener (ADMIN_PORT, default 8081).
      proxy: { '/admin/v1': { target: env.VITE_DEV_ADMIN_TARGET || 'http://localhost:8081', changeOrigin: true } },
    },
    build: { target: 'es2022', chunkSizeWarningLimit: 800 },
    test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom' },
  };
});
