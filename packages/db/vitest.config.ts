import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Integration tests share one database; run files sequentially.
    fileParallelism: false,
    globalSetup: './src/test/global-setup.ts',
    testTimeout: 20_000,
  },
});
