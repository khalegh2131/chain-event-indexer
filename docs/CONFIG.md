# Configuration

Two things are configured: the **indexer config file** (what to index) and the
**process environment** (how to run).

## Loading pipeline

```
CONFIG_PATH ─► resolve path ─► JSON.parse ─► ${ENV} interpolation
           ─► zod shape validation ─► semantic normalization ─► NormalizedConfig
```

Every stage fails fast with an actionable error. Semantic problems are collected
so a single restart reports *all* of them:

```
Invalid configuration: contracts[0]: Invalid EVM address "0xnot-an-address";
contracts[1]: chainId 999 is not declared in "chains"
```

## Config file location

| Source | Priority |
| --- | --- |
| `loadConfig({ configPath })` (programmatic) | 1 |
| `CONFIG_PATH` environment variable | 2 |
| `./config/config.json` (default) | 3 |

Relative paths are resolved against the process working directory.

## Full example

```json
{
  "chains": [
    {
      "chainId": 1,
      "rpcUrl": "${ETH_RPC_URL}",
      "confirmations": 12,
      "pollIntervalMs": 10000,
      "maxBlockRange": 2000
    },
    {
      "chainId": 137,
      "rpcUrl": "https://polygon-rpc.example/v2/${POLYGON_KEY}",
      "confirmations": 128,
      "pollIntervalMs": 15000,
      "maxBlockRange": 1000
    }
  ],
  "contracts": [
    {
      "chainId": 1,
      "address": "0xdac17f958d2ee523a2206206994597c13d831ec7",
      "eventName": "Transfer",
      "eventSignature": "event Transfer(address indexed from, address indexed to, uint256 value)",
      "startBlock": "21000000"
    },
    {
      "chainId": 137,
      "address": "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
      "eventName": "Approval",
      "eventSignature": "event Approval(address indexed owner, address indexed spender, uint256 value)"
    }
  ]
}
```

The top-level object is **strict**: unknown keys are rejected.

## `chains[]`

| Field | Type | Required | Default | Constraints |
| --- | --- | --- | --- | --- |
| `chainId` | string or number | yes | — | Non-negative integer, ≤ 78 digits; normalized to a canonical string |
| `rpcUrl` | string | yes | — | Non-empty; `${ENV_VAR}` interpolated |
| `confirmations` | integer | no | `12` | ≥ 0 |
| `pollIntervalMs` | integer | no | `10000` | ≥ 1000 |
| `maxBlockRange` | integer | no | `2000` | 1–10000 |

`confirmations` is the safety margin behind the chain head:

```
targetBlock = latestBlock - confirmations
```

Only blocks `<= targetBlock` are indexed. Higher values are safer against reorgs;
lower values reduce latency.

`maxBlockRange` is the maximum number of blocks per `eth_getLogs` call. The
indexer halves it automatically if a provider rejects a range, so the configured
value is an upper bound and a throughput knob, not a hard requirement.

## `contracts[]`

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `chainId` | string or number | yes | Must match a declared chain |
| `address` | EVM address | yes | Validated with `viem.isAddress`, normalized to lowercase |
| `eventName` | string | yes | Must equal the name inside `eventSignature` |
| `eventSignature` | string | yes | Human-readable ABI event, parsed with `viem.parseAbiItem` |
| `startBlock` | string or number | no | Backfill start; see below |

### Derived values

- `topic0 = keccak256(canonical signature)` — derived once at startup with
  `viem.toEventSelector`. Indexed parameters are **not** part of the hash, so
  `Transfer(address,address,uint256)` is the same topic for ERC-20 and ERC-721.
- Duplicate contracts are rejected by `chainId + address + topic0`.

### `startBlock` semantics

| Value | Behaviour |
| --- | --- |
| Present (e.g. `"21000000"`) | The cursor is initialized to `startBlock - 1`, so indexing starts exactly at `startBlock`. Historical blocks before it are never queried. |
| Omitted | The cursor is initialized to the **current finalized head** (`latest - confirmations`) and nothing older is backfilled. Use this for "index from now on". |

`startBlock: 0` is supported: the internal cursor sentinel is `-1`, and the first
query is always at block `0` or later (a negative `fromBlock` is never sent).

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` hides `5xx` detail from responses |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | HTTP bind address |
| `LOG_LEVEL` | `info` | pino level (`debug` for per-cycle detail, `silent` in tests) |
| `DATABASE_URL` | — (**required**) | PostgreSQL connection string |
| `API_KEY` | empty | When set, protects everything except `/health` |
| `POLLER_ENABLED` | `true` | `false` runs the API only (useful for API-only replicas) |
| `CONFIG_PATH` | `./config/config.json` | Indexer config file |
| `ENV_FILE` | `./.env` | `.env` file loaded before config interpolation |
| `MIGRATIONS_DIR` | `./migrations` | Migration directory (mainly for tests/tools) |

Notes:

- `.env` is loaded **before** config interpolation but never overrides variables
  that already exist in the real environment.
- `DATABASE_URL` and `API_KEY` are redacted in logs by the logger itself.
- RPC URLs are never logged in full: `maskUrl` removes credentials, sensitive
  query parameters and long opaque path segments.

## Interpolation

Any string value in the config file may reference `${NAME}`:

```json
{ "rpcUrl": "https://eth-mainnet.example/v2/${ALCHEMY_KEY}" }
```

- The placeholder is replaced with the value of `NAME`.
- A **missing** variable throws `MissingEnvVarError` naming the variable and the
  config file — startup fails instead of connecting to an empty URL.
- Interpolation happens before validation, so an interpolated address or
  signature is validated like a literal one.

## Validation reference

| Rule | Error |
| --- | --- |
| Unknown top-level/chain/contract key | zod `Unrecognized key` |
| `chainId` not a non-negative integer | `Invalid chainId "x": must be a non-negative integer` |
| Duplicate `chainId` | `duplicate chainId 1` |
| Empty `rpcUrl` | `rpcUrl must not be empty` |
| Invalid address | `Invalid EVM address "0x…"` |
| Signature is not an event | `invalid eventSignature: "…" does not describe an event` |
| `eventName` mismatch | `eventName "X" does not match the name in eventSignature ("Y")` |
| Duplicate contract | `duplicate contract chainId=1 address=0x… eventSignature=event Transfer(…)` |
| Contract on an undeclared chain | `chainId 999 is not declared in "chains"` |
| No chains / no contracts | `at least one chain is required` / `at least one contract is required` |

## Operational example

```bash
# Development: local postgres, dedicated config file
export DATABASE_URL=postgres://indexer:indexer_password@localhost:5432/chain_event_indexer
export ETH_RPC_URL=https://ethereum-rpc.publicnode.com
export CONFIG_PATH=./config/config.json
npm run migrate && npm run dev

# API-only replica (no polling)
POLLER_ENABLED=false DATABASE_URL=... API_KEY=secret npm start
```
