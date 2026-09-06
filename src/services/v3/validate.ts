/**
 * Bounded structural validation -- implementation plan [X-04], closing v2 [O-19].
 *
 * Nothing parsed from the network reaches canonicalStringify, signature
 * verification or decryption until it has passed through here. The v2 code fed
 * unbounded network JSON straight into a recursive serialiser.
 */

import {
  MAX_JSON_DEPTH,
  MAX_OBJECT_KEYS,
  MAX_ARRAY_ELEMENTS,
} from './constants';

export class ValidationError extends Error {
  constructor(message: string, public readonly path: string = '') {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'ValidationError';
  }
}

/** Keys that must never appear in parsed network input. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const encoder = new TextEncoder();

export function byteLength(value: string): number {
  return encoder.encode(value).length;
}

export interface StructureLimits {
  maxDepth?: number;
  maxKeys?: number;
  maxArray?: number;
}

/**
 * Recursively enforces depth, breadth and key-safety bounds. Throws
 * ValidationError on the first violation; never returns a partial result.
 */
export function validateStructure(value: unknown, limits: StructureLimits = {}, path = '$'): void {
  const maxDepth = limits.maxDepth ?? MAX_JSON_DEPTH;
  const maxKeys = limits.maxKeys ?? MAX_OBJECT_KEYS;
  const maxArray = limits.maxArray ?? MAX_ARRAY_ELEMENTS;

  const walk = (node: unknown, depth: number, nodePath: string): void => {
    if (depth > maxDepth) throw new ValidationError(`depth exceeds ${maxDepth}`, nodePath);

    if (node === null || node === undefined) return;

    const kind = typeof node;
    if (kind === 'string' || kind === 'boolean') return;
    if (kind === 'number') {
      if (!Number.isFinite(node as number)) throw new ValidationError('non-finite number', nodePath);
      return;
    }
    if (kind !== 'object') throw new ValidationError(`unsupported type ${kind}`, nodePath);

    if (Array.isArray(node)) {
      if (node.length > maxArray) {
        throw new ValidationError(`array exceeds ${maxArray} elements`, nodePath);
      }
      node.forEach((item, i) => walk(item, depth + 1, `${nodePath}[${i}]`));
      return;
    }

    const keys = Object.keys(node as Record<string, unknown>);
    if (keys.length > maxKeys) {
      throw new ValidationError(`object exceeds ${maxKeys} keys`, nodePath);
    }
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ValidationError(`forbidden key "${key}"`, nodePath);
      }
      walk((node as Record<string, unknown>)[key], depth + 1, `${nodePath}.${key}`);
    }
  };

  walk(value, 1, path);
}

/**
 * Parses JSON with a byte-size ceiling applied first, then structural bounds.
 * Returns null rather than throwing so hot receive paths can drop input cheaply.
 */
export function safeParse(
  raw: string,
  maxBytes: number,
  limits?: StructureLimits
): unknown | null {
  if (byteLength(raw) > maxBytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  try {
    validateStructure(parsed, limits);
  } catch {
    return null;
  }
  return parsed;
}

// ----------------------------------------------------------------------------
// Field helpers used by the per-packet schemas
// ----------------------------------------------------------------------------

export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('expected object', path);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  obj: Record<string, unknown>,
  key: string,
  maxBytes: number,
  path: string
): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new ValidationError(`missing string "${key}"`, path);
  if (byteLength(value) > maxBytes) {
    throw new ValidationError(`"${key}" exceeds ${maxBytes} bytes`, path);
  }
  return value;
}

export function optionalString(
  obj: Record<string, unknown>,
  key: string,
  maxBytes: number,
  path: string
): string | undefined {
  if (obj[key] === undefined) return undefined;
  return requireString(obj, key, maxBytes, path);
}

export function requireInt(obj: Record<string, unknown>, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(`missing integer "${key}"`, path);
  }
  return value;
}

export function requireLiteral<T extends string>(
  obj: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  path: string
): T {
  const value = obj[key];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(`"${key}" must be one of ${allowed.join('|')}`, path);
  }
  return value as T;
}

export function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  maxItems: number,
  maxItemBytes: number,
  path: string
): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) throw new ValidationError(`missing array "${key}"`, path);
  if (value.length > maxItems) {
    throw new ValidationError(`"${key}" exceeds ${maxItems} items`, path);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string' || byteLength(item) > maxItemBytes) {
      throw new ValidationError(`"${key}[${i}]" invalid`, path);
    }
    return item;
  });
}

/**
 * Enforces [M-04]: a packet declaring requiredExtensions this build does not
 * implement is rejected outright rather than partially interpreted.
 */
export function checkRequiredExtensions(
  obj: Record<string, unknown>,
  supported: ReadonlySet<string>,
  path: string
): void {
  const declared = obj.requiredExtensions;
  if (declared === undefined) return;
  if (!Array.isArray(declared)) {
    throw new ValidationError('requiredExtensions must be an array', path);
  }
  for (const ext of declared) {
    if (typeof ext !== 'string' || !supported.has(ext)) {
      throw new ValidationError(`unsupported required extension "${String(ext)}"`, path);
    }
  }
}
