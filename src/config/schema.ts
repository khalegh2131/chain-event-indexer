import { z } from 'zod';

/**
 * Zod schemas for the raw JSON configuration file.
 *
 * These schemas only cover shape and JSON-level types. Semantic validation
 * (checksum-free address checks, ABI parsing, duplicate detection, chain
 * references) happens in `normalize.ts` so the two concerns stay testable in
 * isolation.
 */

const MAX_DECIMAL_DIGITS = 78;

/** EVM quantities are accepted as JSON strings or numbers and normalized later. */
export const numericStringSchema = z.union([
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer string')
    .max(MAX_DECIMAL_DIGITS, `must not exceed ${MAX_DECIMAL_DIGITS} digits`),
  z.number().int().nonnegative(),
]);

export const chainSchema = z
  .object({
    chainId: numericStringSchema,
    rpcUrl: z.string().min(1, 'rpcUrl must not be empty'),
    confirmations: z.number().int().nonnegative().default(12),
    pollIntervalMs: z.number().int().min(1000).default(10_000),
    maxBlockRange: z.number().int().min(1).max(10_000).default(2000),
  })
  .strict();

export const contractSchema = z
  .object({
    chainId: numericStringSchema,
    address: z.string().min(1, 'address must not be empty'),
    eventName: z.string().min(1, 'eventName must not be empty'),
    eventSignature: z.string().min(1, 'eventSignature must not be empty'),
    startBlock: numericStringSchema.optional(),
  })
  .strict();

export const configFileSchema = z
  .object({
    chains: z.array(chainSchema).min(1, 'at least one chain is required'),
    contracts: z.array(contractSchema).min(1, 'at least one contract is required'),
  })
  .strict();

export type RawChainConfig = z.infer<typeof chainSchema>;
export type RawContractConfig = z.infer<typeof contractSchema>;
export type RawConfig = z.infer<typeof configFileSchema>;

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
