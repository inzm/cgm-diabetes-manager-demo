import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

function excludeDemoDataInPersonalMode(mode: string): Plugin {
  return {
    name: 'exclude-demo-data-in-personal-mode',
    transformIndexHtml(html) {
      if (mode === 'portfolio') {
        return html.replace(
          '<!-- Fonts -->',
          '<!-- Preload initial 42-day glucose dataset in parallel with JS bundles (portfolio mode only) -->\n    <link rel="preload" href="/data/real_glucose_recent.json" as="fetch" crossorigin="anonymous" />\n\n    <!-- Fonts -->'
        );
      }
      return html;
    },
    closeBundle() {
      if (mode !== 'personal') return;
      const distDataDir = path.resolve(__dirname, 'dist', 'data');
      if (!fs.existsSync(distDataDir)) return;

      for (const entry of fs.readdirSync(distDataDir)) {
        if (entry.startsWith('real_glucose_') && entry.endsWith('.json')) {
          fs.rmSync(path.join(distDataDir, entry), { force: true });
        }
      }

      const remaining = fs.readdirSync(distDataDir);
      if (remaining.length === 0) {
        fs.rmdirSync(distDataDir);
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), excludeDemoDataInPersonalMode(mode)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (
              id.includes('echarts') ||
              id.includes('zrender') ||
              id.includes('size-sensor') ||
              id.includes('fast-deep-equal')
            ) {
              return 'vendor-echarts';
            }
            if (id.includes('dexie')) {
              return 'vendor-dexie';
            }
            if (id.includes('@supabase')) {
              return 'vendor-supabase';
            }
            if (id.includes('lucide-react')) {
              return 'vendor-icons';
            }
            if (
              id.includes('react') ||
              id.includes('react-dom') ||
              id.includes('scheduler')
            ) {
              return 'vendor-react';
            }
            return 'vendor-utils';
          }
        },
      },
    },
  },
  server: {
    port: 3000,
    open: false,
  },
}));
