import { defineConfig } from '@playwright/test';

const PORT = 3100;
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ?? 'postgres://solar:solar@localhost:5432/solar_e2e';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  workers: 1,
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `pnpm build && pnpm next start --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 240_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      STORAGE_DRIVER: 'local',
      STORAGE_LOCAL_DIR: './test-results/storage',
      PUBLIC_BASE_URL: `http://localhost:${PORT}`,
      AI_BILL_EXTRACTION: 'off',
    },
  },
});
