import { defineConfig, devices } from '@playwright/test';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function allocateEphemeralPortPair(): { portfolioPort: number; personalPort: number } {
  if (process.env.PW_PORTFOLIO_PORT && process.env.PW_PERSONAL_PORT) {
    return {
      portfolioPort: Number(process.env.PW_PORTFOLIO_PORT),
      personalPort: Number(process.env.PW_PERSONAL_PORT),
    };
  }

  const probeScript = `
    const net = require('node:net');
    function getPort() {
      return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
          const addr = srv.address();
          const port = typeof addr === 'object' && addr ? addr.port : 0;
          srv.close((err) => (err ? reject(err) : resolve(port)));
        });
        srv.on('error', reject);
      });
    }
    (async () => {
      const p1 = await getPort();
      let p2 = await getPort();
      while (p2 === p1) p2 = await getPort();
      process.stdout.write(JSON.stringify({ portfolioPort: p1, personalPort: p2 }));
    })();
  `;

  const raw = execFileSync(process.execPath, ['-e', probeScript], { encoding: 'utf8' });
  const parsed = JSON.parse(raw) as { portfolioPort: number; personalPort: number };
  process.env.PW_PORTFOLIO_PORT = String(parsed.portfolioPort);
  process.env.PW_PERSONAL_PORT = String(parsed.personalPort);
  return parsed;
}

const { portfolioPort, personalPort } = allocateEphemeralPortPair();
const cliArgs = process.argv.join(' ');
const isInfoCommand = /(?:\s|^)(?:--list|--version|--help)(?:\s|$)/.test(cliArgs);
const onlyPortfolioRequested =
  /--project(?:=|\s+)portfolio\b/.test(cliArgs) && !/--project(?:=|\s+)personal\b/.test(cliArgs);
const onlyPersonalRequested =
  /--project(?:=|\s+)personal\b/.test(cliArgs) && !/--project(?:=|\s+)portfolio\b/.test(cliArgs);

function isPersonalBundleAuthConfigured(distDir: string): boolean {
  const indexHtml = path.join(distDir, 'index.html');
  const assetsDir = path.join(distDir, 'assets');
  if (!fs.existsSync(indexHtml) || !fs.existsSync(assetsDir)) return false;
  for (const entry of fs.readdirSync(assetsDir)) {
    if (!entry.endsWith('.js')) continue;
    const js = fs.readFileSync(path.join(assetsDir, entry), 'utf8');
    if (/https:\/\/[a-z0-9-]+\.supabase\.co/i.test(js)) {
      return true;
    }
  }
  return false;
}

if (!isInfoCommand && !process.env.PW_TEST_SOURCE_SCAN) {
  if (!onlyPersonalRequested && !fs.existsSync(path.join(process.cwd(), 'dist-portfolio', 'index.html'))) {
    execSync('npm run build:vite:portfolio', { stdio: 'inherit' });
  }
  if (!onlyPortfolioRequested && !isPersonalBundleAuthConfigured(path.join(process.cwd(), 'dist-personal'))) {
    execSync('npm run build:vite:personal', {
      stdio: 'inherit',
      env: {
        ...process.env,
        VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || 'https://e2e-verify.supabase.co',
        VITE_SUPABASE_ANON_KEY:
          process.env.VITE_SUPABASE_ANON_KEY ||
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e2e.verify',
      },
    });
  }
}

const webServers = [];
if (!onlyPersonalRequested) {
  webServers.push({
    command: `node ./node_modules/vite/bin/vite.js preview --outDir dist-portfolio --host 127.0.0.1 --port ${portfolioPort} --strictPort`,
    url: `http://127.0.0.1:${portfolioPort}`,
    reuseExistingServer: false,
    timeout: 30_000,
  });
}
if (!onlyPortfolioRequested) {
  webServers.push({
    command: `node ./node_modules/vite/bin/vite.js preview --outDir dist-personal --host 127.0.0.1 --port ${personalPort} --strictPort`,
    url: `http://127.0.0.1:${personalPort}`,
    reuseExistingServer: false,
    timeout: 30_000,
  });
}

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [['list']],
  use: {
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--js-flags=--max-old-space-size=512',
      ],
    },
  },
  projects: [
    {
      name: 'portfolio',
      grepInvert: /@personal-bundle/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${portfolioPort}`,
      },
    },
    {
      name: 'personal',
      grep: /@personal-bundle/,
      testIgnore: /visual-design\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        baseURL: `http://127.0.0.1:${personalPort}`,
      },
    },
  ],
  webServer: webServers,
});
