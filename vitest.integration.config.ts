import { defineConfig } from 'vitest/config';

/**
 * Integration test configuration.
 *
 * Requires a PostgreSQL instance. Start the dedicated test database with:
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgres://indexer:indexer_password@localhost:5433/chain_event_indexer_test npm run test:integration
 */
export default defineConfig({
  test: {
    name: 'integration',
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    globalSetup: ['tests/integration/globalSetup.ts'],
    restoreMocks: true,
    clearMocks: true,
    reporters: ['default'],
  },
});
