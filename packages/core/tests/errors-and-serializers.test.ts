import { describe, it, expect } from 'vitest';
import {
  TableNotFoundError,
  GroupFileUnavailableError,
  ConflictError,
  SchemaCorruptedError,
  SchemaUpgradeRequiredError,
  SchemaIncompatibleError,
  escapeFormulaInjection,
  sanitizeString,
  stripUnsafeKeys,
  shouldAcceptIncomingDoc,
  sanitizeRemoteDocument,
  createFieldGetter,
  parseBool,
  parseNumber,
} from '../src/index.js';

describe('errors', () => {
  it('constructs TableNotFoundError and GroupFileUnavailableError with expected metadata', () => {
    const tErr = new TableNotFoundError('Expenses');
    expect(tErr).toBeInstanceOf(Error);
    expect(tErr.name).toBe('TableNotFoundError');
    expect(tErr.tabName).toBe('Expenses');
    expect(tErr.message).toContain('Expenses');

    const gErr = new GroupFileUnavailableError('group-1', 'Trip', 'trashed');
    expect(gErr).toBeInstanceOf(Error);
    expect(gErr.name).toBe('GroupFileUnavailableError');
    expect(gErr.groupId).toBe('group-1');
    expect(gErr.groupName).toBe('Trip');
    expect(gErr.reason).toBe('trashed');

    expect(new ConflictError().name).toBe('ConflictError');
    expect(new SchemaCorruptedError().name).toBe('SchemaCorruptedError');
    expect(new SchemaUpgradeRequiredError().name).toBe('SchemaUpgradeRequiredError');
    expect(new SchemaIncompatibleError().name).toBe('SchemaIncompatibleError');
  });
});

describe('serializers & sanitization', () => {
  it('escapes formula injection prefixes and sanitizes escaped strings', () => {
    expect(escapeFormulaInjection('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(escapeFormulaInjection('+1+2')).toBe("'+1+2");
    expect(escapeFormulaInjection('-cmd')).toBe("'-cmd");
    expect(escapeFormulaInjection('@SUM(1)')).toBe("'@SUM(1)");
    expect(escapeFormulaInjection(42)).toBe(42);

    expect(sanitizeString("'=Formula <b>ok</b>")).toBe('=Formula ok');
    expect(sanitizeString(null, 'fallback')).toBe('fallback');
  });

  it('strips __proto__, constructor, and prototype keys recursively', () => {
    const dirty = JSON.parse(
      '{"a":1,"__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"ok":"yes"}}'
    );
    const cleaned = stripUnsafeKeys(dirty) as { a: number; nested: { ok: string } };
    expect(cleaned.a).toBe(1);
    expect(cleaned.nested.ok).toBe('yes');
    expect(Object.prototype.hasOwnProperty.call(cleaned, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(cleaned.nested, 'constructor')).toBe(false);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('evaluates LWW with (existing, incoming) parameter order for numbers and ISO dates', () => {
    expect(
      shouldAcceptIncomingDoc(undefined, { id: '1', updatedAt: 100 })
    ).toBe(true);
    expect(
      shouldAcceptIncomingDoc(
        { id: '1', updatedAt: 200 },
        { id: '1', updatedAt: 100 }
      )
    ).toBe(false);
    expect(
      shouldAcceptIncomingDoc(
        { id: '1', updatedAt: '2026-11-10T10:00:00.000Z' },
        { id: '1', updatedAt: '2026-11-10T12:00:00.000Z' }
      )
    ).toBe(true);
    expect(
      shouldAcceptIncomingDoc(
        { id: '1', updatedAt: 100, _deleted: true },
        { id: '1', updatedAt: 100, _deleted: false }
      )
    ).toBe(false);
  });

  it('sanitizes active_cloud_provider on user_settings and parses tabular helpers', () => {
    const cleaned = sanitizeRemoteDocument('user_settings', {
      id: 'global_settings',
      active_cloud_provider: 'google',
      theme: 'dark',
    });
    expect(cleaned.active_cloud_provider).toBeUndefined();
    expect(cleaned.theme).toBe('dark');

    const getField = createFieldGetter({
      id: '1',
      headers: ['ID', 'Active', 'Amount'],
      values: ['1', 'true', '12.5'],
    });
    expect(getField('id', 0)).toBe('1');
    expect(parseBool(getField('active', 1))).toBe(true);
    expect(parseNumber(getField('amount', 2))).toBe(12.5);
  });
});
