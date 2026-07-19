import { defineConfig, devices } from '@playwright/test';
import { config as e2e } from './config.mjs';

// Fake-media flags let WebRTC + voice work headless with no real hardware; an optional WAV
// (E2E_AUDIO_FILE) feeds real audio so speech-to-text produces a verbal transcript.
const mediaArgs = [
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  ...(e2e.audioFile ? [`--use-file-for-fake-audio-capture=${e2e.audioFile}`] : []),
];

// Targets production by default (E2E_WEB_URL) with dedicated QA accounts — there is no
// separate dev DB. workers:1 keeps the two shared QA sessions from racing each other.
// Self-contained in website/e2e/ so the real Vite app package never depends on Playwright.
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: '.artifacts/report', open: 'never' }],
    ['json', { outputFile: '.artifacts/results.json' }],
  ],
  outputDir: '.artifacts/test-results',
  use: {
    baseURL: e2e.webUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    launchOptions: { args: mediaArgs },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 860 } },
    },
    {
      // Responsive pass — the mobile-web viewport RN-app users also hit on the web.
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
});
