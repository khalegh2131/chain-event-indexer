import { defineConfig } from 'vitest/config';

/**
 * Unit test configuration.
 *
 * Unit tests must never require a network connection or a database.
 */
export default defineConfig({
  test: {
    name: 'unit',
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
    restoreMocks: true,
    clearMocks: true,
    reporters: ['default'],
  },
});
