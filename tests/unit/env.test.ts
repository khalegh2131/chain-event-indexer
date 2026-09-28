import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MissingEnvVarError,
  interpolateEnvDeep,
  interpolateEnvString,
  loadEnvFile,
  maskSecret,
  maskUrl,
  parseBooleanEnv,
  parseEnvContent,
  parseIntegerEnv,
} from '../../src/utils/env';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('environment interpolation', () => {
  it('replaces ${VAR} with the resolved value', () => {
    expect(interpolateEnvString('https://rpc.example/${API_KEY}', { API_KEY: 'abc' })).toBe(
      'https://rpc.example/abc',
    );
  });

  it('supports several placeholders in one string', () => {
    expect(
      interpolateEnvString('${SCHEME}://${HOST}/v2', { SCHEME: 'https', HOST: 'rpc.example' }),
    ).toBe('https://rpc.example/v2');
  });

  it('leaves strings without placeholders untouched', () => {
    expect(interpolateEnvString('plain-value', {})).toBe('plain-value');
  });

  it('throws a clear error for a missing variable', () => {
    expect(() => interpolateEnvString('${MISSING}', {}, 'config file /tmp/x.json')).toThrowError(
      MissingEnvVarError,
    );
    try {
      interpolateEnvString('${MISSING}', {}, 'config file /tmp/x.json');
    } catch (error) {
      expect((error as MissingEnvVarError).variableName).toBe('MISSING');
      expect((error as Error).message).toContain('/tmp/x.json');
    }
  });

  it('walks nested objects and arrays', () => {
    const input = {
      chains: [{ rpcUrl: '${RPC}', nested: { again: ['${RPC}', 42, true, null] } }],
    };
    expect(interpolateEnvDeep(input, { RPC: 'https://rpc.example' })).toEqual({
      chains: [{ rpcUrl: 'https://rpc.example', nested: { again: ['https://rpc.example', 42, true, null] } }],
    });
  });

  it('returns non-string primitives unchanged', () => {
    expect(interpolateEnvDeep(7, {})).toBe(7);
    expect(interpolateEnvDeep(null, {})).toBeNull();
  });
});

describe('.env parsing', () => {
  it('parses keys, comments, quotes and export prefixes', () => {
    const parsed = parseEnvContent(
      [
        '# comment',
        '',
        'NODE_ENV=development',
        'export PORT=3000',
        'QUOTED="hello world"',
        "SINGLE='single value'",
        'EMPTY=',
        'not a pair',
        '=novalue',
        'INVALID-KEY=1',
      ].join('\n'),
    );

    expect(parsed).toEqual({
      NODE_ENV: 'development',
      PORT: '3000',
      QUOTED: 'hello world',
      SINGLE: 'single value',
      EMPTY: '',
    });
  });

  it('loads a .env file without overriding existing variables', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cei-env-'));
    tempDirs.push(dir);
    const envPath = path.join(dir, '.env');
    fs.writeFileSync(envPath, 'FROM_FILE=1\nALREADY_SET=from-file\n', 'utf8');

    const env: NodeJS.ProcessEnv = { ALREADY_SET: 'from-process' };
    const applied = loadEnvFile(envPath, env);

    expect(applied).toEqual(['FROM_FILE']);
    expect(env['FROM_FILE']).toBe('1');
    expect(env['ALREADY_SET']).toBe('from-process');
  });

  it('is a no-op when the file does not exist', () => {
    expect(loadEnvFile(path.join(os.tmpdir(), 'definitely-missing.env'), {})).toEqual([]);
  });
});

describe('secret masking', () => {
  it('masks credentials and sensitive query parameters of a URL', () => {
    const masked = maskUrl('https://user:hunter2@rpc.example/v2/abcdef0123456789abcdef?apikey=secret');
    expect(masked).not.toContain('hunter2');
    expect(masked).not.toContain('secret');
    expect(masked).toContain('***');
  });

  it('masks long opaque path segments', () => {
    const masked = maskUrl('https://rpc.example/v2/0123456789abcdef0123456789abcdef');
    expect(masked).not.toContain('0123456789abcdef0123456789abcdef');
  });

  it('masks non-URL secrets and keeps short values opaque', () => {
    expect(maskSecret('super-secret-token-value')).toBe('supe***ue');
    expect(maskSecret('short')).toBe('***');
    expect(maskSecret(undefined)).toBe('');
  });

  it('falls back gracefully for malformed URLs', () => {
    expect(maskSecret('http://[')).toContain('***');
  });
});

describe('environment parsing helpers', () => {
  it('parses booleans', () => {
    expect(parseBooleanEnv(undefined, true)).toBe(true);
    expect(parseBooleanEnv('', false)).toBe(false);
    expect(parseBooleanEnv('TRUE', false)).toBe(true);
    expect(parseBooleanEnv('1', false)).toBe(true);
    expect(parseBooleanEnv('off', true)).toBe(false);
    expect(parseBooleanEnv('nonsense', true)).toBe(true);
  });

  it('parses positive integers', () => {
    expect(parseIntegerEnv('3000', 80)).toBe(3000);
    expect(parseIntegerEnv(undefined, 80)).toBe(80);
    expect(parseIntegerEnv('0', 80)).toBe(80);
    expect(parseIntegerEnv('-5', 80)).toBe(80);
    expect(parseIntegerEnv('abc', 80)).toBe(80);
    expect(parseIntegerEnv('1.5', 80)).toBe(80);
  });
});
