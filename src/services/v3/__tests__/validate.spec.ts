import { describe, it, expect } from 'vitest';
import {
  checkRequiredExtensions,
  safeParse,
  validateStructure,
  ValidationError,
} from '../validate';
import { MAX_ARRAY_ELEMENTS, MAX_JSON_DEPTH, MAX_OBJECT_KEYS } from '../constants';

function nest(depth: number): unknown {
  let node: unknown = 1;
  for (let i = 0; i < depth; i++) node = { child: node };
  return node;
}

describe('structural bounds -- closes v2 [O-19]', () => {
  it('accepts ordinary input', () => {
    expect(() => validateStructure({ a: 1, b: ['x'], c: { d: true } })).not.toThrow();
  });

  it('rejects excessive depth', () => {
    expect(() => validateStructure(nest(MAX_JSON_DEPTH + 4))).toThrow(ValidationError);
  });

  it('rejects too many object keys', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i <= MAX_OBJECT_KEYS; i++) wide[`k${i}`] = i;
    expect(() => validateStructure(wide)).toThrow(/exceeds/);
  });

  it('rejects oversized arrays', () => {
    expect(() => validateStructure(new Array(MAX_ARRAY_ELEMENTS + 1).fill(0))).toThrow(/exceeds/);
  });

  it('rejects prototype-polluting keys', () => {
    const hostile = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(() => validateStructure(hostile)).toThrow(/forbidden key/);
    expect(() => validateStructure(JSON.parse('{"constructor": 1}'))).toThrow(/forbidden key/);
  });

  it('rejects non-finite numbers', () => {
    expect(() => validateStructure({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/);
  });

  it('honours tighter per-packet bounds', () => {
    expect(() => validateStructure({ m: [1, 2, 3] }, { maxArray: 2 })).toThrow(/exceeds 2/);
  });
});

describe('safeParse', () => {
  it('enforces the byte ceiling before parsing', () => {
    expect(safeParse('"' + 'x'.repeat(200) + '"', 50)).toBeNull();
  });

  it('returns null rather than throwing on bad input', () => {
    expect(safeParse('{oops', 1000)).toBeNull();
    expect(safeParse(JSON.stringify(nest(40)), 100000)).toBeNull();
  });

  it('round-trips valid input', () => {
    expect(safeParse('{"a":1}', 1000)).toEqual({ a: 1 });
  });
});

describe('requiredExtensions -- [M-04]', () => {
  const supported = new Set(['airthread/3-nostr-transport']);

  it('passes when absent', () => {
    expect(() => checkRequiredExtensions({}, supported, '$')).not.toThrow();
  });

  it('passes when every declared extension is known', () => {
    expect(() =>
      checkRequiredExtensions(
        { requiredExtensions: ['airthread/3-nostr-transport'] },
        supported,
        '$'
      )
    ).not.toThrow();
  });

  it('rejects rather than partially interpreting an unknown extension', () => {
    expect(() =>
      checkRequiredExtensions({ requiredExtensions: ['airthread/9-future'] }, supported, '$')
    ).toThrow(/unsupported required extension/);
  });

  it('rejects a malformed declaration', () => {
    expect(() =>
      checkRequiredExtensions({ requiredExtensions: 'nope' }, supported, '$')
    ).toThrow(/must be an array/);
  });
});
