import { describe, expect, it } from 'vitest';
import {
  bigIntToStringDeep,
  isJsonSafe,
  stringifyJsonSafe,
  toJsonRecord,
} from '../../src/utils/json';

describe('bigIntToStringDeep', () => {
  it('converts a top-level bigint', () => {
    expect(bigIntToStringDeep(10n)).toBe('10');
  });

  it('converts nested structures recursively', () => {
    const input = {
      from: '0xabc',
      value: 123456789012345678901234567890n,
      nested: {
        list: [1n, 2n, { deep: 3n }],
        flag: true,
        nothing: null,
      },
    };

    expect(bigIntToStringDeep(input)).toEqual({
      from: '0xabc',
      value: '123456789012345678901234567890',
      nested: {
        list: ['1', '2', { deep: '3' }],
        flag: true,
        nothing: null,
      },
    });
  });

  it('does not mutate the input', () => {
    const input = { value: 5n };
    bigIntToStringDeep(input);
    expect(input.value).toBe(5n);
  });

  it('converts Date to an ISO string', () => {
    expect(bigIntToStringDeep(new Date('2024-01-02T03:04:05.000Z'))).toBe(
      '2024-01-02T03:04:05.000Z',
    );
  });

  it('passes through primitives', () => {
    expect(bigIntToStringDeep('text')).toBe('text');
    expect(bigIntToStringDeep(42)).toBe(42);
    expect(bigIntToStringDeep(undefined)).toBeUndefined();
  });

  it('handles negative and zero bigints', () => {
    expect(bigIntToStringDeep(-1n)).toBe('-1');
    expect(bigIntToStringDeep(0n)).toBe('0');
  });
});

describe('stringifyJsonSafe', () => {
  it('serializes bigint values without throwing', () => {
    expect(stringifyJsonSafe({ value: 10n })).toBe('{"value":"10"}');
  });

  it('round-trips through JSON.parse', () => {
    const parsed = JSON.parse(stringifyJsonSafe({ a: [1n, 2n] })) as { a: string[] };
    expect(parsed.a).toEqual(['1', '2']);
  });
});

describe('toJsonRecord', () => {
  it('returns objects unchanged after conversion', () => {
    expect(toJsonRecord({ value: 2n })).toEqual({ value: '2' });
  });

  it('wraps non-objects so the JSONB column always receives an object', () => {
    expect(toJsonRecord(5n)).toEqual({ value: '5' });
    expect(toJsonRecord(['a'])).toEqual({ value: ['a'] });
    expect(toJsonRecord(null)).toEqual({ value: null });
  });
});

describe('isJsonSafe', () => {
  it('accepts bigints because they are converted first', () => {
    expect(isJsonSafe({ value: 1n })).toBe(true);
  });

  it('rejects circular structures', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(isJsonSafe(circular)).toBe(false);
  });
});
