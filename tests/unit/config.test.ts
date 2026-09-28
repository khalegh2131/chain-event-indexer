import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig, loadConfig, resolveConfigPath } from '../../src/config/load';
import { ConfigError } from '../../src/config/normalize';
import { MissingEnvVarError } from '../../src/utils/env';
import type { RawConfig } from '../../src/config/schema';
import {
  ERC20_TRANSFER_SIGNATURE,
  ERC20_TRANSFER_TOPIC0,
  USDT_ADDRESS,
  USDT_ADDRESS_CHECKSUMMED,
  rawConfig,
} from './fixtures';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cei-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('config normalization', () => {
  it('normalizes a valid configuration', () => {
    const { config, configPath } = buildConfig(
      rawConfig({
        contracts: [
          {
            chainId: '1',
            address: USDT_ADDRESS_CHECKSUMMED,
            eventName: 'Transfer',
            eventSignature: ERC20_TRANSFER_SIGNATURE,
            startBlock: '00100',
          },
        ],
      }),
    );

    expect(configPath).toBe('<inline>');
    expect(config.chains).toHaveLength(1);
    expect(config.chains[0]?.chainId).toBe('1');
    expect(config.contracts[0]?.address).toBe(USDT_ADDRESS);
    expect(config.contracts[0]?.topic0).toBe(ERC20_TRANSFER_TOPIC0);
    expect(config.contracts[0]?.startBlock).toBe('100');
  });

  it('applies documented defaults', () => {
    const { config } = buildConfig({
      chains: [{ chainId: '137', rpcUrl: 'https://polygon-rpc.example' }],
      contracts: [
        {
          chainId: 137,
          address: USDT_ADDRESS,
          eventName: 'Transfer',
          eventSignature: ERC20_TRANSFER_SIGNATURE,
        },
      ],
    } as unknown as RawConfig);

    expect(config.chains[0]).toMatchObject({
      chainId: '137',
      confirmations: 12,
      pollIntervalMs: 10_000,
      maxBlockRange: 2000,
    });
    expect(config.contracts[0]?.startBlock).toBeNull();
  });

  it('sorts chains by numeric chain id', () => {
    const { config } = buildConfig(
      rawConfig({
        chains: [
          { chainId: '10', rpcUrl: 'https://optimism.example' },
          { chainId: '1', rpcUrl: 'https://ethereum.example' },
          { chainId: '137', rpcUrl: 'https://polygon.example' },
        ],
        contracts: [
          {
            chainId: '1',
            address: USDT_ADDRESS,
            eventName: 'Transfer',
            eventSignature: ERC20_TRANSFER_SIGNATURE,
          },
        ],
      }),
    );

    expect(config.chains.map((chain) => chain.chainId)).toEqual(['1', '10', '137']);
  });

  it('rejects an invalid EVM address', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          contracts: [
            {
              chainId: '1',
              address: '0xnot-an-address',
              eventName: 'Transfer',
              eventSignature: ERC20_TRANSFER_SIGNATURE,
            },
          ],
        }),
      ),
    ).toThrowError(/Invalid EVM address/);
  });

  it('rejects a signature that is not an event', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          contracts: [
            {
              chainId: '1',
              address: USDT_ADDRESS,
              eventName: 'Transfer',
              eventSignature: 'function transfer(address to, uint256 value)',
            },
          ],
        }),
      ),
    ).toThrowError(/does not describe an event|invalid eventSignature/);
  });

  it('rejects an eventName that disagrees with the signature', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          contracts: [
            {
              chainId: '1',
              address: USDT_ADDRESS,
              eventName: 'Approval',
              eventSignature: ERC20_TRANSFER_SIGNATURE,
            },
          ],
        }),
      ),
    ).toThrowError(/does not match the name in eventSignature/);
  });

  it('rejects duplicate contracts', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          contracts: [
            {
              chainId: '1',
              address: USDT_ADDRESS,
              eventName: 'Transfer',
              eventSignature: ERC20_TRANSFER_SIGNATURE,
            },
            {
              chainId: 1,
              address: USDT_ADDRESS_CHECKSUMMED,
              eventName: 'Transfer',
              eventSignature: `  ${ERC20_TRANSFER_SIGNATURE}  `,
            },
          ],
        }),
      ),
    ).toThrowError(/duplicate contract/);
  });

  it('rejects a contract referencing an undeclared chain', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          contracts: [
            {
              chainId: '999',
              address: USDT_ADDRESS,
              eventName: 'Transfer',
              eventSignature: ERC20_TRANSFER_SIGNATURE,
            },
          ],
        }),
      ),
    ).toThrowError(/is not declared in "chains"/);
  });

  it('rejects unknown top-level keys', () => {
    expect(() =>
      buildConfig({
        ...rawConfig(),
        extraFeature: true,
      } as unknown as RawConfig),
    ).toThrowError(/Unrecognized key/);
  });

  it('rejects an out-of-range maxBlockRange', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          chains: [{ chainId: '1', rpcUrl: 'https://rpc.example', maxBlockRange: 10_001 }],
        }),
      ),
    ).toThrowError(/maxBlockRange|Too big/);
  });

  it('rejects a pollIntervalMs below one second', () => {
    expect(() =>
      buildConfig(
        rawConfig({
          chains: [{ chainId: '1', rpcUrl: 'https://rpc.example', pollIntervalMs: 500 }],
        }),
      ),
    ).toThrowError(/pollIntervalMs|Too small/);
  });

  it('collects every problem into a single ConfigError', () => {
    try {
      buildConfig(
        rawConfig({
          contracts: [
            {
              chainId: '1',
              address: 'nope',
              eventName: 'Transfer',
              eventSignature: ERC20_TRANSFER_SIGNATURE,
            },
            {
              chainId: '999',
              address: USDT_ADDRESS,
              eventName: 'Transfer',
              eventSignature: ERC20_TRANSFER_SIGNATURE,
            },
          ],
        }),
      );
      throw new Error('expected buildConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues).toHaveLength(2);
      expect(issues[0]).toContain('contracts[0]');
      expect(issues[1]).toContain('contracts[1]');
    }
  });
});

describe('config loading from disk', () => {
  it('reads the file, interpolates ${ENV} and validates it', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        chains: [
          {
            chainId: '1',
            rpcUrl: '${TEST_RPC_URL}',
            confirmations: 3,
          },
        ],
        contracts: [
          {
            chainId: '1',
            address: USDT_ADDRESS,
            eventName: 'Transfer',
            eventSignature: ERC20_TRANSFER_SIGNATURE,
          },
        ],
      }),
      'utf8',
    );

    const loaded = loadConfig({
      configPath,
      env: { TEST_RPC_URL: 'https://rpc.example/v2/SECRET' },
    });

    expect(loaded.configPath).toBe(configPath);
    expect(loaded.config.chains[0]?.rpcUrl).toBe('https://rpc.example/v2/SECRET');
    expect(loaded.raw.chains[0]?.confirmations).toBe(3);
  });

  it('throws when a referenced environment variable is missing', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        chains: [{ chainId: '1', rpcUrl: '${NOT_SET_ANYWHERE}' }],
        contracts: [
          {
            chainId: '1',
            address: USDT_ADDRESS,
            eventName: 'Transfer',
            eventSignature: ERC20_TRANSFER_SIGNATURE,
          },
        ],
      }),
      'utf8',
    );

    expect(() => loadConfig({ configPath, env: {} })).toThrowError(MissingEnvVarError);
  });

  it('reports a missing config file clearly', () => {
    expect(() => loadConfig({ configPath: path.join(tempDir(), 'nope.json') })).toThrowError(
      /Config file not found/,
    );
  });

  it('reports invalid JSON clearly', () => {
    const dir = tempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{ not json', 'utf8');
    expect(() => loadConfig({ configPath })).toThrowError(/is not valid JSON/);
  });

  it('resolves CONFIG_PATH relative to the working directory', () => {
    expect(resolveConfigPath({ cwd: '/srv/app', env: {} })).toBe(
      path.resolve('/srv/app', './config/config.json'),
    );
    expect(resolveConfigPath({ cwd: '/srv/app', env: { CONFIG_PATH: 'custom/other.json' } })).toBe(
      path.resolve('/srv/app', 'custom/other.json'),
    );
    expect(resolveConfigPath({ env: { CONFIG_PATH: '/etc/cei/config.json' } })).toBe(
      '/etc/cei/config.json',
    );
  });
});
