import fs from 'node:fs';
import path from 'node:path';
import { interpolateEnvDeep } from '../utils/env';
import { describeError } from '../utils/errors';
import type { NormalizedConfig } from '../types';
import { ConfigError, normalizeConfig } from './normalize';
import { configFileSchema, formatZodIssues, type RawConfig } from './schema';

/**
 * Configuration loading pipeline:
 *
 *   path resolution -> JSON parse -> `${ENV}` interpolation -> shape validation
 *   -> semantic normalization
 *
 * Every stage fails fast with an actionable error.
 */

export const DEFAULT_CONFIG_PATH = './config/config.json';

export interface LoadConfigOptions {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface LoadedConfig {
  config: NormalizedConfig;
  raw: RawConfig;
  configPath: string;
}

export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configured = options.configPath ?? env['CONFIG_PATH'] ?? DEFAULT_CONFIG_PATH;
  const trimmed = configured.trim();
  if (trimmed === '') {
    throw new ConfigError('CONFIG_PATH must not be empty');
  }
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

export function readConfigFile(configPath: string): unknown {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      `Config file not found at ${configPath}. Copy config/config.example.json to config/config.json or set CONFIG_PATH.`,
    );
  }
  const content = fs.readFileSync(configPath, 'utf8');
  try {
    return JSON.parse(content) as unknown;
  } catch (error) {
    throw new ConfigError(`Config file ${configPath} is not valid JSON: ${describeError(error)}`);
  }
}

/** Validates and normalizes an already-parsed configuration object. */
export function buildConfig(input: unknown, configPath = '<inline>'): LoadedConfig {
  const parsed = configFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid configuration in ${configPath}`,
      formatZodIssues(parsed.error),
    );
  }
  return {
    config: normalizeConfig(parsed.data),
    raw: parsed.data,
    configPath,
  };
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(options);
  const parsed = readConfigFile(configPath);
  const interpolated = interpolateEnvDeep(parsed, env, `config file ${configPath}`);
  return buildConfig(interpolated, configPath);
}
