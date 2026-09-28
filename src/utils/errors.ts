/**
 * Tiny error helpers shared across modules.
 */

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function errorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
