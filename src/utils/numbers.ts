/**
 * Decimal string helpers.
 *
 * EVM quantities travel through the system as decimal strings (uint256 does not
 * fit in a JavaScript number), so comparison must be length-aware.
 */

export function isDecimalString(value: string): boolean {
  return /^\d+$/.test(value);
}

/** Compares two non-negative decimal strings without converting to Number. */
export function compareDecimalStrings(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, '');
  const b = right.replace(/^0+(?=\d)/, '');
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export function maxDecimalString(left: string, right: string): string {
  return compareDecimalStrings(left, right) >= 0 ? left : right;
}

export function toBigIntOrNull(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Subtracts two non-negative decimal strings and returns a decimal string. */
export function subtractDecimalStrings(minuend: string, subtrahend: string): string {
  const result = BigInt(minuend) - BigInt(subtrahend);
  return result.toString();
}
