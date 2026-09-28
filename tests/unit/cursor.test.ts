import { describe, expect, it } from 'vitest';
import { InvalidCursorError, decodeCursor, encodeCursor } from '../../src/utils/cursor';

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

describe('cursor encoding', () => {
  it('round-trips a row id', () => {
    const cursor = encodeCursor('9007199254740993');
    expect(decodeCursor(cursor)).toBe('9007199254740993');
  });

  it('accepts numbers and bigints', () => {
    expect(decodeCursor(encodeCursor(42))).toBe('42');
    expect(decodeCursor(encodeCursor(42n))).toBe('42');
  });

  it('is opaque: the raw id is not readable at a glance', () => {
    const cursor = encodeCursor('12345');
    expect(cursor).not.toContain('12345');
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces a canonical base64url payload', () => {
    expect(decodeCursor(encodeCursor('7'))).toBe('7');
    expect(base64url(JSON.stringify({ v: 1, id: '7' }))).toBe(encodeCursor('7'));
  });

  it('rejects a non-numeric id', () => {
    expect(() => encodeCursor('abc')).toThrowError(InvalidCursorError);
    expect(() => encodeCursor('-1')).toThrowError(InvalidCursorError);
  });
});

describe('cursor decoding', () => {
  it('rejects an empty string', () => {
    expect(() => decodeCursor('')).toThrowError(InvalidCursorError);
  });

  it('rejects non-base64url garbage', () => {
    expect(() => decodeCursor('!!!not-base64!!!')).toThrowError(InvalidCursorError);
  });

  it('rejects valid base64 of non-JSON content', () => {
    expect(() => decodeCursor(base64url('just-a-string'))).toThrowError(InvalidCursorError);
  });

  it('rejects an unknown envelope version', () => {
    expect(() => decodeCursor(base64url(JSON.stringify({ v: 2, id: '1' })))).toThrowError(
      InvalidCursorError,
    );
  });

  it('rejects a payload without an id', () => {
    expect(() => decodeCursor(base64url(JSON.stringify({ v: 1 })))).toThrowError(InvalidCursorError);
  });

  it('rejects a non-numeric id', () => {
    expect(() => decodeCursor(base64url(JSON.stringify({ v: 1, id: 'x' })))).toThrowError(
      InvalidCursorError,
    );
  });

  it('rejects an over-long cursor', () => {
    expect(() => decodeCursor('a'.repeat(600))).toThrowError(InvalidCursorError);
  });
});
