import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/backend/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    testTimeout: 15000,
  },
});
