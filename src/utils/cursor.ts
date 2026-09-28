/**
 * Opaque, tamper-evident-enough pagination cursors.
 *
 * The cursor is the base64url encoding of a tiny versioned JSON envelope that
 * carries the internal `id` of the last returned row. Consumers treat it as an
 * opaque string; the encoding keeps internal identifiers out of the public API.
 */

export class InvalidCursorError extends Error {
  constructor(message = 'Invalid cursor') {
    super(message);
    this.name = 'InvalidCursorError';
  }
}

interface CursorEnvelope {
  v: 1;
  id: string;
}

const MAX_CURSOR_LENGTH = 512;

export function encodeCursor(id: string | number | bigint): string {
  const normalized = String(id);
  if (!/^\d+$/.test(normalized)) {
    throw new InvalidCursorError('Cursor id must be a non-negative integer');
  }
  const envelope: CursorEnvelope = { v: 1, id: normalized };
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor and returns the internal row id.
 * Throws {@link InvalidCursorError} for anything that is not a canonical cursor.
 */
export function decodeCursor(cursor: string): string {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new InvalidCursorError();
  }
  let decoded = '';
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new InvalidCursorError();
  }
  // Reject non-canonical base64url payloads (Buffer.from is lenient).
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) {
    throw new InvalidCursorError();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new InvalidCursorError();
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new InvalidCursorError();
  }
  const envelope = parsed as Partial<CursorEnvelope>;
  if (envelope.v !== 1 || typeof envelope.id !== 'string' || !/^\d+$/.test(envelope.id)) {
    throw new InvalidCursorError();
  }
  return envelope.id;
}
