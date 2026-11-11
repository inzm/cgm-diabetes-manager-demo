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

function collectUsedLucideIcons(dir: string, out = new Set<string>()): Set<string> {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectUsedLucideIcons(full, out);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      const code = fs.readFileSync(full, 'utf8');
      const importRegex = /import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(code)) !== null) {
        for (const token of match[1].split(',')) {
          const rawName = token.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
          if (rawName) out.add(rawName);
        }
      }
    }
  }
  return out;
}

function optimizeLucideBarrel(): Plugin {
  let usedIcons: Set<string> | null = null;
  return {
    name: 'optimize-lucide-barrel',
    load(id) {
      const normalized = id.replace(/\\/g, '/').split('?')[0];
      if (!normalized.endsWith('lucide-react/dist/esm/lucide-react.js')) {
        return null;
      }
      if (!usedIcons) {
        usedIcons = collectUsedLucideIcons(path.resolve(__dirname, 'src'));
      }
      const raw = fs.readFileSync(normalized, 'utf8');
      const keptLines: string[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.includes('./icons/index.js') || line.includes('export { index as icons }')) {
          continue;
        }
        if (line.startsWith('export {') && line.includes("from './icons/")) {
          const words = new Set(line.split(/\W+/));
          const matchesUsed = Array.from(usedIcons).some((iconName) =>
            words.has(iconName)
          );
          if (matchesUsed) {
            keptLines.push(line);
          }
          continue;
        }
        if (!line.startsWith('//# sourceMappingURL=')) {
          keptLines.push(line);
        }
      }
      return keptLines.join('\n');
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), optimizeLucideBarrel(), excludeDemoDataInPersonalMode(mode)],
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
