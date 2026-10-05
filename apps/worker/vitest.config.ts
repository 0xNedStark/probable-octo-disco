import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { globalSetup: '../../packages/db/src/test/global-setup.ts', testTimeout: 20_000 },
});
