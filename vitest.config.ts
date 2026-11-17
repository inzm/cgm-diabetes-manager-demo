import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    pool: 'threads',
    // Keep single worker thread to reuse Vite transform cache across the 4 test files (12.6s vs 27.5s multi-isolate startup on Windows)
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
