import fs from 'node:fs';

/**
 * Environment handling: `${VAR}` interpolation for configuration files, a very
 * small `.env` reader (no third-party dependency), and secret masking helpers
 * used before anything is written to the logs.
 */

export class MissingEnvVarError extends Error {
  readonly variableName: string;

  constructor(variableName: string, source: string) {
    super(`Missing environment variable "${variableName}" referenced in ${source}`);
    this.name = 'MissingEnvVarError';
    this.variableName = variableName;
  }
}

const ENV_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function interpolateEnvString(
  value: string,
  env: NodeJS.ProcessEnv,
  source = 'configuration',
): string {
  return value.replace(ENV_PATTERN, (_match, name: string) => {
    const resolved = env[name];
    if (resolved === undefined) {
      throw new MissingEnvVarError(name, source);
    }
    return resolved;
  });
}

/**
 * Recursively interpolates `${VAR}` placeholders inside every string value of a
 * parsed JSON structure. Arrays and nested objects are supported.
 */
export function interpolateEnvDeep<T>(
  value: T,
  env: NodeJS.ProcessEnv,
  source = 'configuration',
): T {
  if (typeof value === 'string') {
    return interpolateEnvString(value, env, source) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateEnvDeep(entry, env, source)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = interpolateEnvDeep(entry, env, source);
    }
    return result as unknown as T;
  }
  return value;
}

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parses a `.env` file body into a plain key/value map. */
export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = withoutExport.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = withoutExport.slice(0, separatorIndex).trim();
    if (!ENV_KEY_PATTERN.test(key)) continue;
    let value = withoutExport.slice(separatorIndex + 1).trim();
    const isDoubleQuoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.length >= 2 && value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Loads a `.env` file into the supplied environment object without overriding
 * variables that are already defined. Returns the list of applied keys.
 */
export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = parseEnvContent(fs.readFileSync(filePath, 'utf8'));
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) {
      env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

const SENSITIVE_PARAM_PATTERN = /(key|token|secret|apikey|api_key|auth|password)/i;

/** Masks credentials and long opaque path/query segments of a URL. */
export function maskUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username !== '' || url.password !== '') {
      url.username = url.username === '' ? '' : '***';
      url.password = url.password === '' ? '' : '***';
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAM_PATTERN.test(key)) {
        url.searchParams.set(key, '***');
      }
    }
    url.pathname = url.pathname
      .split('/')
      .map((segment) => (segment.length > 20 ? `${segment.slice(0, 4)}***` : segment))
      .join('/');
    return url.toString();
  } catch {
    // Malformed URL: fall back to a length-based mask instead of recursing.
    return raw.length <= 8 ? '***' : `${raw.slice(0, 4)}***`;
  }
}

/** Best-effort masking for values that may embed a secret. */
export function maskSecret(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw === '') return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return maskUrl(raw);
  }
  if (raw.length <= 8) return '***';
  return `${raw.slice(0, 4)}***${raw.slice(-2)}`;
}

/** Reads a boolean-ish environment variable with a safe default. */
export function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

/** Reads a positive integer environment variable with a safe default. */
export function parseIntegerEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
