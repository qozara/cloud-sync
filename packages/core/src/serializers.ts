import type { TabularRow } from './types.js';

const UNSAFE_PROPERTY_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isUnsafePropertyKey(key: string): boolean {
  return UNSAFE_PROPERTY_KEYS.has(key);
}

/**
 * Strips prototype-pollution keys (`__proto__`, `constructor`, `prototype`) recursively.
 */
export function stripUnsafeKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUnsafeKeys(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const clean: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isUnsafePropertyKey(key)) continue;
      clean[key] = stripUnsafeKeys(val);
    }
    return clean as T;
  }
  return value;
}

export function createFieldGetter(row: TabularRow) {
  const headers = row.headers;
  const v = row.values;

  if (headers && headers.length > 0) {
    const map = new Map<string, number>();
    for (let i = 0; i < headers.length; i++) {
      const h = String(headers[i] ?? '').trim().toLowerCase();
      if (h && !map.has(h)) {
        map.set(h, i);
      }
    }
    return (colName: string, _fallbackIndex: number) => {
      const target = colName.trim().toLowerCase();
      const idx = map.get(target);
      return idx !== undefined ? v[idx] : undefined;
    };
  }

  return (_colName: string, fallbackIndex: number) => {
    return v[fallbackIndex];
  };
}

export const parseBool = (val: any): boolean => {
  if (typeof val === 'string') return val.toLowerCase() === 'true';
  return Boolean(val);
};

export const parseNumber = (val: any, fallback = 0): number => {
  if (val === null || val === undefined || val === '') return fallback;
  const n = typeof val === 'number' ? val : Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const escapeFormulaInjection = (val: any): any => {
  if (typeof val !== 'string') return val;
  if (/^[=+\-@\t\r]/.test(val)) {
    return `'${val}`;
  }
  return val;
};

export const sanitizeString = (val: any, fallback = ''): string => {
  if (val === null || val === undefined) return fallback;
  let str = String(val);
  if (str.startsWith("'") && /^[=+\-@\t\r]/.test(str.slice(1))) {
    str = str.slice(1);
  }
  return str.replace(/<[^>]*>/g, '').trim();
};

export function parseTimestampMs(val: unknown): number {
  if (!val) return 0;
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
  if (val instanceof Date) {
    const ms = val.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const ms = Date.parse(val);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

export function isNetworkError(err: any): boolean {
  if (!err) return false;
  if (typeof globalThis !== 'undefined' && (globalThis as any).navigator?.onLine === false) {
    return true;
  }
  const msg = String(err?.message || err);
  const lower = msg.toLowerCase();
  return (
    (err?.name === 'TypeError' && (msg.includes('fetch') || msg.includes('Failed to fetch'))) ||
    msg.includes('net::ERR_INTERNET_DISCONNECTED') ||
    msg.includes('NetworkError') ||
    lower.includes('network error') ||
    lower.includes('fetch') ||
    lower.includes('network') ||
    msg.includes('ERR_CONNECTION_') ||
    msg.includes('ERR_NETWORK_CHANGED') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout')
  );
}

export function isEntityNotFoundError(err: any): boolean {
  if (!err) return false;
  if (err.status === 404 || err.code === 404 || err.statusCode === 404) {
    return true;
  }
  const msg = String(err?.message || err);
  const lower = msg.toLowerCase();
  return (
    msg.includes('404') ||
    msg.includes('NOT_FOUND') ||
    msg.includes('Requested entity was not found') ||
    lower.includes('file not found')
  );
}

/**
 * Evaluates Last-Write-Wins (LWW) precedence supporting both epoch numbers and ISO date strings.
 */
export function shouldAcceptIncomingDoc(
  existing: Record<string, any> | undefined,
  incoming: Record<string, any>
): boolean {
  if (!existing) return true;
  const existingTime = parseTimestampMs(existing.updatedAt);
  const incomingTime = parseTimestampMs(incoming.updatedAt);
  if (incomingTime > existingTime) return true;
  if (incomingTime < existingTime) return false;
  if (existing._deleted && !incoming._deleted) return false;
  return true;
}

export function sanitizeRemoteDocument(
  collection: string,
  doc: Record<string, any>
): Record<string, any> {
  if (collection === 'user_settings' && doc && typeof doc === 'object' && 'active_cloud_provider' in doc) {
    const copy = { ...doc };
    delete copy.active_cloud_provider;
    return copy;
  }
  return doc;
}
