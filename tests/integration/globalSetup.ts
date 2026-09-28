import { defaultMigrationsDir, runMigrations } from '../../src/db/migrate';
import { createDbClient } from '../../src/db/client';
import { TEST_DATABASE_URL } from './helpers';

/**
 * Vitest global setup for the integration suite.
 *
 * Applies every migration once against the dedicated test database before any
 * test file runs, so individual tests only have to truncate tables.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const pool = createDbClient({
    connectionString: TEST_DATABASE_URL,
    applicationName: 'chain-event-indexer-test-setup',
  });

  try {
    const result = await runMigrations(pool, defaultMigrationsDir());
    process.stdout.write(
      `[integration] database ready at ${TEST_DATABASE_URL} ` +
        `(applied ${result.applied.length}, already applied ${result.skipped.length})\n`,
    );
  } finally {
    await pool.end();
  }

  return async (): Promise<void> => {
    // Nothing to tear down: the database is disposable (docker compose down -v).
  };
}
