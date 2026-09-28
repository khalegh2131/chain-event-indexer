/**
 * JSON safety helpers.
 *
 * Every value that leaves the ingestion pipeline (API responses, decoded event
 * arguments, structured logs) must be JSON-serializable. `bigint` is the main
 * offender because viem returns it for every numeric log field, so it is
 * converted recursively to a decimal string.
 */

export function bigIntToStringDeep(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => bigIntToStringDeep(entry));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = bigIntToStringDeep(entry);
  }
  return result;
}

/** Serializes any value to JSON with every `bigint` converted to a string. */
export function stringifyJsonSafe(value: unknown): string {
  return JSON.stringify(bigIntToStringDeep(value));
}

/**
 * Normalizes a decoded value into a plain JSON object. Non-object values are
 * wrapped so the database column always receives a valid JSONB object.
 */
export function toJsonRecord(value: unknown): Record<string, unknown> {
  const converted = bigIntToStringDeep(value);
  if (converted !== null && typeof converted === 'object' && !Array.isArray(converted)) {
    return converted as Record<string, unknown>;
  }
  return { value: converted };
}

/** Returns true when the value can be round-tripped through `JSON.stringify`. */
export function isJsonSafe(value: unknown): boolean {
  try {
    JSON.stringify(bigIntToStringDeep(value));
    return true;
  } catch {
    return false;
  }
}
