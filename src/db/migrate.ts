import fs from 'node:fs';
import path from 'node:path';
import { createDbClient, type PoolLike } from './client';
import { describeError } from '../utils/errors';

/**
 * Plain-SQL migration runner.
 *
 * - creates `schema_migrations` when missing
 * - applies every not-yet-applied `*.sql` file in lexicographic order
 * - wraps each migration in its own transaction
 * - is idempotent: a second run applies nothing
 * - exits non-zero when a migration fails
 *
 * Usage:
 *   npm run migrate                              (tsx, development)
 *   node dist/db/migrate.js                      (production image entrypoint)
 *   MIGRATIONS_DIR=/custom/path node dist/db/migrate.js
 */

const CREATE_MIGRATIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export interface RunMigrationsOptions {
  logger?: (message: string) => void;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Default `migrations/` directory (works from both `src/` and `dist/`). */
export function defaultMigrationsDir(): string {
  const configured = process.env['MIGRATIONS_DIR'];
  if (configured && configured.trim() !== '') {
    return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
  }
  return path.resolve(__dirname, '..', '..', 'migrations');
}

export function listMigrationFiles(migrationsDir: string): string[] {
  if (!fs.existsSync(migrationsDir)) {
    throw new Error(`Migrations directory not found: ${migrationsDir}`);
  }
  return fs
    .readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function runMigrations(
  pool: PoolLike,
  migrationsDir: string = defaultMigrationsDir(),
  options: RunMigrationsOptions = {},
): Promise<MigrationResult> {
  const log = options.logger ?? (() => undefined);
  const files = listMigrationFiles(migrationsDir);

  await pool.query(CREATE_MIGRATIONS_TABLE);

  const appliedRows = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const alreadyApplied = new Set(appliedRows.rows.map((row) => row.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (alreadyApplied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      log(`applied migration ${file}`);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original failure below.
      }
      throw new Error(`Migration ${file} failed: ${describeError(error)}`);
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString || connectionString.trim() === '') {
    process.stderr.write('DATABASE_URL is required to run migrations\n');
    process.exitCode = 1;
    return;
  }

  const pool = createDbClient({ connectionString, applicationName: 'chain-event-indexer-migrate' });
  try {
    const result = await runMigrations(pool, defaultMigrationsDir(), {
      logger: (message) => process.stdout.write(`${message}\n`),
    });
    process.stdout.write(
      `migrations complete: ${result.applied.length} applied, ${result.skipped.length} already applied\n`,
    );
  } catch (error) {
    process.stderr.write(`migration failed: ${describeError(error)}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  void main();
}
