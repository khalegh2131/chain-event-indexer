-- 0001_init.sql
--
-- Initial schema for the chain event indexer.
--
-- All EVM quantities (chain ids, block numbers, log indexes) are stored as
-- NUMERIC(78,0) so they can hold a full uint256 without precision loss. Every
-- statement is idempotent so re-running the migration is harmless.

CREATE TABLE IF NOT EXISTS contracts (
  id BIGSERIAL PRIMARY KEY,
  chain_id NUMERIC(78, 0) NOT NULL,
  address TEXT NOT NULL,
  event_name TEXT NOT NULL,
  event_signature TEXT NOT NULL,
  topic0 TEXT NOT NULL,
  start_block NUMERIC(78, 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT contracts_chain_id_address_event_signature_key
    UNIQUE (chain_id, address, event_signature),
  CONSTRAINT contracts_chain_id_non_negative CHECK (chain_id >= 0),
  CONSTRAINT contracts_start_block_non_negative CHECK (start_block IS NULL OR start_block >= 0)
);

CREATE TABLE IF NOT EXISTS event_logs (
  id BIGSERIAL PRIMARY KEY,
  chain_id NUMERIC(78, 0) NOT NULL,
  contract_id BIGINT NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  tx_hash TEXT NOT NULL,
  log_index NUMERIC(78, 0) NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash TEXT NOT NULL,
  tx_index NUMERIC(78, 0) NOT NULL,
  event_name TEXT NOT NULL,
  args JSONB NOT NULL,
  raw_topics TEXT[] NOT NULL,
  data TEXT NOT NULL,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_logs_chain_id_tx_hash_log_index_key
    UNIQUE (chain_id, tx_hash, log_index),
  CONSTRAINT event_logs_log_index_non_negative CHECK (log_index >= 0),
  CONSTRAINT event_logs_block_number_non_negative CHECK (block_number >= 0)
);

CREATE INDEX IF NOT EXISTS event_logs_chain_block_log_idx
  ON event_logs (chain_id, block_number, log_index);

CREATE INDEX IF NOT EXISTS event_logs_contract_block_log_idx
  ON event_logs (contract_id, block_number, log_index);

CREATE INDEX IF NOT EXISTS event_logs_tx_hash_idx
  ON event_logs (tx_hash);

CREATE TABLE IF NOT EXISTS ingestion_state (
  contract_id BIGINT PRIMARY KEY REFERENCES contracts (id) ON DELETE CASCADE,
  last_finalized_block NUMERIC(78, 0) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- NOTE: `last_finalized_block` may legitimately be -1, meaning "nothing has been
-- processed yet". That sentinel is what makes `startBlock: 0` expressible without
-- ever querying a negative block range.
