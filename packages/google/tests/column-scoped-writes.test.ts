import { describe, it, expect, vi } from 'vitest';
import {
  MANIFEST_KEYS,
  ValidationStatus,
  type SchemaDefinition,
} from '@qozara/cloud-sync';
import {
  GoogleSheetsContainerDriver,
  GoogleSheetsFetchClient,
  GoogleSheetsTabularDriver,
  columnIndexToA1,
  type IStorageLayer,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const quomidaSchema: SchemaDefinition = {
  version: 2,
  identity: {
    appId: 'quomida',
    docType: 'daily_logs',
    legacyMetaSheetNames: ['_quomida_meta'],
    legacyPropertyMatchers: [{ key: 'quomida_doc_type', value: 'daily_logs' }],
    legacyRequiredTabs: ['daily_logs'],
  },
  tabs: [
    {
      name: 'daily_logs',
      columns: [
        { name: 'id', type: 'string', required: true },
        { name: 'calories', type: 'number', required: true },
        { name: 'updatedAt', type: 'number' },
      ],
    },
  ],
};

describe('columnIndexToA1', () => {
  it('converts zero-based column indices including multi-letter columns beyond Z', () => {
    expect(columnIndexToA1(0)).toBe('A');
    expect(columnIndexToA1(25)).toBe('Z');
    expect(columnIndexToA1(26)).toBe('AA');
    expect(columnIndexToA1(27)).toBe('AB');
    expect(columnIndexToA1(51)).toBe('AZ');
    expect(columnIndexToA1(52)).toBe('BA');
  });
});

describe('GoogleSheetsContainerDriver', () => {
  it('inspects metadata, _meta, _migrations, and schema tab headers in 1 metadata + 1 batchGet call', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/drive/v3/files/')) {
        return jsonResponse({
          properties: { qozara_app: 'quomida', qozara_doc_type: 'daily_logs' },
          appProperties: { quomida_schema_version: '2' },
          modifiedTime: '2026-11-25T10:00:00.000Z',
        });
      }
      if (url.includes('values:batchGet')) {
        return jsonResponse({
          valueRanges: [
            {
              values: [
                ['key', 'value', 'updatedAt'],
                [MANIFEST_KEYS.APP_ID, 'quomida', '2026-11-25T10:00:00.000Z'],
                [MANIFEST_KEYS.DOC_TYPE, 'daily_logs', '2026-11-25T10:00:00.000Z'],
                [MANIFEST_KEYS.SCHEMA_VERSION, '2', '2026-11-25T10:00:00.000Z'],
              ],
            },
            { values: [['2', '2026-11-25T10:00:00.000Z']] },
            { values: [['id', 'custom_note', 'calories', 'updatedAt']] },
          ],
        });
      }
      if (url.includes('/v4/spreadsheets/doc-1')) {
        return jsonResponse({
          properties: { title: 'Quomida Daily Logs' },
          sheets: [
            { properties: { sheetId: 1, title: 'daily_logs' } },
            { properties: { sheetId: 2, title: '_meta' } },
            { properties: { sheetId: 3, title: '_migrations' } },
            { properties: { sheetId: 4, title: 'Charts' } },
          ],
        });
      }
      return jsonResponse({});
    });

    const client = new GoogleSheetsFetchClient({
      accessToken: 'tok-1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const driver = new GoogleSheetsContainerDriver(client);

    const inspection = await driver.inspectContainer('doc-1', quomidaSchema);

    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 sheets metadata + 1 drive metadata + 1 batchGet
    expect(inspection.metaEntries[MANIFEST_KEYS.APP_ID]).toBe('quomida');
    expect(inspection.migrationVersions).toEqual([2]);
    expect(inspection.tables.find((t) => t.name === 'daily_logs')?.headers).toEqual([
      'id',
      'custom_note',
      'calories',
      'updatedAt',
    ]);
  });
});

describe('GoogleSheetsTabularDriver column-scoped writes & safe ensureDocument', () => {
  it('preserves user-added formula columns in storageLayer mode using column-scoped spans', async () => {
    const batchUpdateValues = vi.fn(async () => {});
    const batchUpdateSpreadsheet = vi.fn(async () => {});
    const storageLayer = {
      batchGetValues: vi.fn(async () => [
        {
          values: [
            ['user_prefix', 'id', 'my_math', 'calories', 'updatedAt', 'user_suffix'],
            ['A', '1', '=D2*2', 300, 100, 'ok'],
            ['B', '2', '=D3*2', 400, 200, 'ok'],
          ],
        },
      ]),
      batchUpdateValues,
      batchUpdateSpreadsheet,
      updateFile: vi.fn(async () => {}),
    } as unknown as IStorageLayer;

    const driver = new GoogleSheetsTabularDriver({
      getAccessToken: () => 'tok-1',
      storageLayer,
      defaultSchema: quomidaSchema,
    });

    await driver.writeTable(
      'doc-1',
      'daily_logs',
      ['user_prefix', 'id', 'my_math', 'calories', 'updatedAt', 'user_suffix'],
      [
        {
          id: '1',
          headers: ['user_prefix', 'id', 'my_math', 'calories', 'updatedAt', 'user_suffix'],
          values: [undefined, '1', undefined, 350, 150, undefined],
        },
      ]
    );

    // Must write ONLY column B (id) and columns D:E (calories, updatedAt) — leaving A, C, F untouched!
    expect(batchUpdateValues).toHaveBeenNthCalledWith(1, 'doc-1', [
      {
        range: 'daily_logs!B1:B2',
        values: [['id'], ['1']],
      },
      {
        range: 'daily_logs!D1:E2',
        values: [
          ['calories', 'updatedAt'],
          [350, 150],
        ],
      },
    ]);

    // Trailing row cleanup clears ONLY managed columns B and D:E instead of deleteDimension on full row
    expect(batchUpdateValues).toHaveBeenNthCalledWith(2, 'doc-1', [
      { range: 'daily_logs!B3:B3', values: [['']] },
      { range: 'daily_logs!D3:E3', values: [['', '']] },
    ]);
    expect(batchUpdateSpreadsheet).not.toHaveBeenCalled();
  });

  it('preserves user-added formula columns in direct fetch mode via values:batchUpdate + values:batchClear', async () => {
    const postedBodies: Array<{ url: string; body: any }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postedBodies.push({ url, body: JSON.parse(String(init.body || '{}')) });
        return jsonResponse({});
      }
      if (url.includes('/values/daily_logs!A1:ZZ')) {
        return jsonResponse({
          values: [
            ['id', 'custom_kcal_pct', 'calories', 'updatedAt'],
            ['1', '=C2/2000', 500, 10],
          ],
        });
      }
      return jsonResponse({});
    });

    const driver = new GoogleSheetsTabularDriver({
      getAccessToken: () => 'tok-1',
      httpClient: { fetch: fetchMock as unknown as typeof fetch },
      defaultSchema: quomidaSchema,
    });

    const rows = await driver.readTable('doc-1', 'daily_logs');
    expect(rows).toHaveLength(1);

    await driver.writeTable('doc-1', 'daily_logs', ['id', 'calories', 'updatedAt'], [
      { id: '1', values: ['1', 650, 20] },
    ]);

    const writeCall = postedBodies.find((c) => c.url.includes('/values:batchUpdate'));
    expect(writeCall?.body.data).toEqual([
      {
        range: 'daily_logs!A1:A2',
        majorDimension: 'ROWS',
        values: [['id'], ['1']],
      },
      {
        range: 'daily_logs!C1:D2',
        majorDimension: 'ROWS',
        values: [
          ['calories', 'updatedAt'],
          [650, 20],
        ],
      },
    ]);

    const clearCall = postedBodies.find((c) => c.url.includes('/values:batchClear'));
    expect(clearCall?.body.ranges).toEqual(['daily_logs!A3:A', 'daily_logs!C3:D']);
  });

  it('never touches an UNMANAGED title-matched spreadsheet in ensureDocument() and creates a fresh managed file', async () => {
    const patchUrls: string[] = [];
    const batchUpdateUrls: string[] = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patchUrls.push(url);
        return jsonResponse({});
      }
      if (url.includes('/drive/v3/files?q=') && (url.includes('appProperties') || url.includes('qozara_app'))) {
        return jsonResponse({ files: [] });
      }
      if (url.includes('/drive/v3/files?q=') && url.includes('name')) {
        return jsonResponse({
          files: [{ id: 'unrelated-personal-sheet', name: 'Quomida Daily Logs' }],
        });
      }
      if (url.includes('/drive/v3/files/unrelated-personal-sheet')) {
        return jsonResponse({ properties: {}, appProperties: {} });
      }
      if (url.includes('/v4/spreadsheets/unrelated-personal-sheet')) {
        return jsonResponse({
          properties: { title: 'Quomida Daily Logs' },
          sheets: [{ properties: { sheetId: 1, title: 'Personal Notes' } }],
        });
      }
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && init?.method === 'POST') {
        return jsonResponse({
          spreadsheetId: 'fresh-managed-doc',
          sheets: [
            { properties: { sheetId: 1, title: 'daily_logs' } },
            { properties: { sheetId: 2, title: '_meta' } },
            { properties: { sheetId: 3, title: '_migrations' } },
          ],
        });
      }
      if (url.includes('/v4/spreadsheets/fresh-managed-doc')) {
        if (url.includes(':batchUpdate')) {
          batchUpdateUrls.push(url);
        }
        return jsonResponse({
          properties: { title: 'Quomida Daily Logs' },
          sheets: [
            { properties: { sheetId: 1, title: 'daily_logs' } },
            { properties: { sheetId: 2, title: '_meta' } },
            { properties: { sheetId: 3, title: '_migrations' } },
          ],
        });
      }
      return jsonResponse({});
    });

    const driver = new GoogleSheetsTabularDriver({
      getAccessToken: () => 'tok-1',
      httpClient: { fetch: fetchMock as unknown as typeof fetch },
      defaultSchema: quomidaSchema,
      schemasByDocType: { daily_logs: quomidaSchema },
      docTypeResolver: () => ({ docType: 'daily_logs', schema: quomidaSchema }),
    });

    const resolvedId = await driver.ensureDocument('Quomida Daily Logs', ['daily_logs']);
    expect(resolvedId).toBe('fresh-managed-doc');

    // Verify ZERO PATCH or batchUpdate calls targeted the unrelated personal spreadsheet
    expect(patchUrls.some((u) => u.includes('unrelated-personal-sheet'))).toBe(false);
    expect(batchUpdateUrls.some((u) => u.includes('unrelated-personal-sheet'))).toBe(false);
    expect(patchUrls.some((u) => u.includes('fresh-managed-doc'))).toBe(true);
    expect(ValidationStatus.UNMANAGED).toBe('UNMANAGED');
  });
});
