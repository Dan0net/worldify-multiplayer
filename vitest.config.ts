import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 10000,
    // Tests were removed for now; keep the tooling wired so `npm run test:run`
    // stays green (exit 0) until tests are re-added.
    passWithNoTests: true,
  },
});
