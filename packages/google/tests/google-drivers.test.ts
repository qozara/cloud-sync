import { describe, it, expect, vi } from 'vitest';
import { TableNotFoundError } from '@qozara/cloud-sync';
import {
  ConflictError,
  ValidationService,
  ValidationStatus,
  GoogleDriveBlobDriver,
  GoogleSheetsTabularDriver,
  StorageLayerCatalogAndAclDriver,
  GoogleDriveSheetsCloudSyncProvider,
  type IStorageLayer,
  type SchemaDefinition,
} from '../src/index.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const sampleSchema: SchemaDefinition = {
  version: 2,
  tabs: [
    {
      name: 'items',
      columns: [
        { name: 'id', type: 'string', required: true },
        { name: 'title', type: 'string', required: true },
      ],
    },
  ],
};

describe('ValidationService', () => {
  it('enforces requireTokenOnConstruct when true and allows lazy init by default', () => {
    expect(() => new ValidationService(() => null, { requireTokenOnConstruct: true })).toThrow(
      'requires a valid Google access token'
    );
    expect(() => new ValidationService(() => null)).not.toThrow();
  });

  it('checkHealth returns READY when spreadsheet matches default schema', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('fields=appProperties,modifiedTime')) {
        return jsonResponse({
          appProperties: { app_schema_version: '2' },
          modifiedTime: '2026-11-10T10:00:00.000Z',
        });
      }
      if (url.includes('values:batchGet')) {
        if (url.includes('_migrations')) {
          return jsonResponse({
            valueRanges: [{ values: [['2', '2026-11-09T00:00:00Z']] }],
          });
        }
        return jsonResponse({
          valueRanges: [{ values: [['id', 'title']] }],
        });
      }
      if (url.includes('sheets.googleapis.com/v4/spreadsheets/sheet-1') && !url.includes('values')) {
        return jsonResponse({
          sheets: [{ properties: { title: 'items', sheetId: 1 } }],
        });
      }
      return jsonResponse({});
    });

    const service = new ValidationService(() => 'tok-1', {
      httpClient: { fetch: fetchMock as unknown as typeof fetch },
      appPropertyPrefix: 'app',
      defaultSchema: sampleSchema,
    });

    const res = await service.checkHealth('sheet-1');
    expect(res.status).toBe(ValidationStatus.READY);
    expect(res.valid).toBe(true);
    expect(res.currentVersion).toBe(2);
    expect(res.lastModifiedTime).toBe('2026-11-10T10:00:00.000Z');
  });

  it('checkHealth delegates to SchemaEngine when useSchemaEngine is true', async () => {
    const service = new ValidationService(() => 'tok-1', {
      useSchemaEngine: true,
      defaultSchema: sampleSchema,
    });

    const engineSpy = vi.spyOn(service.engine, 'checkHealth').mockResolvedValue({
      spreadsheetId: 'sheet-2',
      currentVersion: 2,
      latestVersion: 2,
      status: ValidationStatus.READY,
      missingTabs: [],
      missingColumns: {},
      canAutoMigrate: false,
      lastModifiedTime: '2026-11-12T00:00:00.000Z',
    });

    const res = await service.checkHealth('sheet-2');
    expect(engineSpy).toHaveBeenCalledWith('sheet-2', sampleSchema);
    expect(res.valid).toBe(true);
    expect(res.status).toBe(ValidationStatus.READY);
  });

  it('repairFile adds missing tabs/columns and throws ConflictError on stale modifiedTime', async () => {
    const batchUpdates: unknown[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('fields=appProperties,modifiedTime')) {
        return jsonResponse({
          appProperties: { app_schema_version: '2' },
          modifiedTime: '2026-11-12T12:00:00.000Z',
        });
      }
      if (url.endsWith('/copy')) {
        return jsonResponse({ id: 'backup-1' });
      }
      if (url.endsWith(':batchUpdate')) {
        batchUpdates.push(JSON.parse(String(init?.body || '{}')));
        return jsonResponse({});
      }
      if (url.includes('values:batchGet')) {
        return jsonResponse({
          valueRanges: [{ values: [['id']] }],
        });
      }
      if (url.includes('spreadsheets/sheet-1') && (!init?.method || init.method === 'GET')) {
        return jsonResponse({
          sheets: [{ properties: { title: 'items', sheetId: 10 } }],
        });
      }
      if (url.includes('files/sheet-1') && init?.method === 'PATCH') {
        return jsonResponse({});
      }
      return jsonResponse({});
    });

    const service = new ValidationService(() => 'tok-1', {
      httpClient: { fetch: fetchMock as unknown as typeof fetch },
      appPropertyPrefix: 'app',
      defaultSchema: sampleSchema,
    });

    await expect(
      service.repairFile('sheet-1', '2026-11-11T00:00:00.000Z')
    ).rejects.toBeInstanceOf(ConflictError);

    const repairRes = await service.repairFile('sheet-1', '2026-11-12T12:00:00.000Z');
    expect(repairRes.backupFileId).toBe('backup-1');
    expect(batchUpdates.length).toBeGreaterThan(0);
  });

  it('migrateFile runs migrations and updates file metadata', async () => {
    const migrationUp = vi.fn(async () => {});
    const service = new ValidationService(() => 'tok-1', {
      defaultSchema: sampleSchema,
      migrations: [{ version: 2, up: migrationUp, down: async () => {} }],
      appPropertyPrefix: 'app',
    });

    vi.spyOn(service.client, 'createBackup').mockResolvedValue('backup-mig-1');
    vi.spyOn(service.client, 'acquireLock').mockResolvedValue(true);
    vi.spyOn(service.client, 'releaseLock').mockResolvedValue(true);
    vi.spyOn(service.client, 'getSpreadsheet').mockResolvedValue({
      sheets: [{ properties: { title: '_migrations', sheetId: 99 } }],
    });
    vi.spyOn(service.client, 'batchGet').mockResolvedValue({
      valueRanges: [{ values: [['1', '2026-11-01T00:00:00Z']] }],
    });
    vi.spyOn(service.client, 'batchUpdate').mockResolvedValue({});
    const updateMetaSpy = vi.spyOn(service.client, 'updateFileAppProperties').mockResolvedValue();

    const res = await service.migrateFile('sheet-m');
    expect(res.backupFileId).toBe('backup-mig-1');
    expect(migrationUp).toHaveBeenCalledTimes(1);
    expect(updateMetaSpy).toHaveBeenCalledWith(
      'sheet-m',
      expect.objectContaining({
        app_validation_status: ValidationStatus.READY,
        app_schema_version: '2',
      })
    );
  });
});

describe('GoogleDriveBlobDriver', () => {
  it('reads, writes, and deletes blobs in appDataFolder via httpClient', async () => {
    const stored: { id?: string; payload?: unknown } = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('spaces=appDataFolder')) {
        return jsonResponse({ files: stored.id ? [{ id: stored.id, name: 'settings.json' }] : [] });
      }
      if (url.includes('uploadType=multipart')) {
        const body = String(init?.body || '');
        const parts = body.split('\r\n\r\n');
        stored.payload = JSON.parse(parts[2].split('\r\n--')[0]);
        stored.id = 'blob-1';
        return jsonResponse({ id: 'blob-1' });
      }
      if (url.endsWith('files/blob-1?alt=media')) {
        return jsonResponse(stored.payload ?? null);
      }
      if (init?.method === 'DELETE' && url.endsWith('files/blob-1')) {
        stored.id = undefined;
        stored.payload = undefined;
        return new Response(null, { status: 204 });
      }
      return jsonResponse({});
    });

    const driver = new GoogleDriveBlobDriver({
      getAccessToken: () => 'tok-blob',
      httpClient: { fetch: fetchMock as unknown as typeof fetch },
    });

    await driver.writeBlob('settings.json', { theme: 'dark' });
    const loaded = await driver.readBlob<{ theme: string }>('settings.json');
    expect(loaded).toEqual({ theme: 'dark' });

    await driver.deleteBlob('settings.json');
    const afterDelete = await driver.readBlob('settings.json');
    expect(afterDelete).toBeNull();
  });

  it('delegates to storageLayer when access token is null', async () => {
    const storageLayer = {
      listFiles: vi.fn(async () => [{ id: 'f-1', name: 'prefs.json' }]),
      getFile: vi.fn(async () => ({ locale: 'es' })),
      createFile: vi.fn(async () => 'f-2'),
      updateFile: vi.fn(async () => {}),
      deleteFile: vi.fn(async () => {}),
    } as unknown as IStorageLayer;

    const driver = new GoogleDriveBlobDriver({
      getAccessToken: () => null,
      storageLayer,
    });

    expect(await driver.readBlob('prefs.json')).toEqual({ locale: 'es' });
    await driver.writeBlob('prefs.json', { locale: 'en' });
    expect(storageLayer.updateFile).toHaveBeenCalledWith(
      'f-1',
      {},
      JSON.stringify({ locale: 'en' })
    );
    await driver.deleteBlob('prefs.json');
    expect(storageLayer.deleteFile).toHaveBeenCalledWith('f-1');
  });
});

describe('GoogleSheetsTabularDriver', () => {
  it('reads, writes, and resolves remote links via storageLayer and aliases', async () => {
    const storageLayer = {
      batchGetValues: vi.fn(async () => [
        { values: [['id', 'Title'], ['1', 'Milk'], [' ', ' ']] },
      ]),
      batchUpdateValues: vi.fn(async () => {}),
      getSpreadsheet: vi.fn(async () => ({
        sheets: [{ properties: { title: 'items', sheetId: 42 } }],
      })),
      batchUpdateSpreadsheet: vi.fn(async () => {}),
      updateFile: vi.fn(async () => {}),
    } as unknown as IStorageLayer;

    const driver = new GoogleSheetsTabularDriver({
      getAccessToken: () => 'tok-sheets',
      storageLayer,
      defaultSchema: sampleSchema,
      filterEmptyRows: true,
      caseInsensitiveHeaders: true,
    });

    const rows = await driver.readTable('doc-1', 'items');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: '1', headers: ['id', 'Title'], values: ['1', 'Milk'] });

    await driver.writeTable('doc-1', 'items', ['id', 'title'], [
      { id: '2', headers: ['id', 'title'], values: ['2', 'Eggs'] },
    ]);
    expect(storageLayer.batchUpdateValues).toHaveBeenCalledWith('doc-1', [
      { range: 'items!A1', values: [['id', 'title'], ['2', 'Eggs']] },
    ]);
    expect(storageLayer.batchUpdateSpreadsheet).toHaveBeenCalledWith('doc-1', [
      {
        deleteDimension: {
          range: { sheetId: 42, dimension: 'ROWS', startIndex: 2, endIndex: 3 },
        },
      },
    ]);

    const fetchMock = vi.fn(async () => jsonResponse({ files: [{ id: 'doc-remote' }] }));
    const linkDriver = new GoogleSheetsTabularDriver({
      getAccessToken: () => 'tok-sheets',
      httpClient: { fetch: fetchMock as unknown as typeof fetch },
      docTypesForLinks: ['daily_logs'],
    });
    const links = await linkDriver.getRemoteLinks();
    expect(links).toEqual(['https://docs.google.com/spreadsheets/d/doc-remote/edit']);
  });

  it('throws TableNotFoundError when configured and sheet range is missing', async () => {
    const storageLayer = {
      batchGetValues: vi.fn(async () => {
        throw new Error('Unable to parse range: missing_tab!A1:Z');
      }),
    } as unknown as IStorageLayer;

    const driver = new GoogleSheetsTabularDriver({
      getAccessToken: () => 'tok-sheets',
      storageLayer,
      throwTableNotFoundError: true,
    });

    await expect(driver.readTable('doc-1', 'missing_tab')).rejects.toBeInstanceOf(
      TableNotFoundError
    );
  });
});

describe('StorageLayerCatalogAndAclDriver', () => {
  it('manages group containers, health checks, collaborators, and access modes', async () => {
    const storage = {
      listFiles: vi.fn(async () => [
        {
          id: 'g-1',
          name: 'Trip',
          createdTime: '2026-11-01T00:00:00Z',
          owners: [{ emailAddress: 'Owner@Example.com' }],
          properties: { quozen_type: 'group' },
        },
      ]),
      getFile: vi.fn(async () => ({
        id: 'g-1',
        name: 'Trip',
        trashed: false,
        createdTime: '2026-11-01T00:00:00Z',
        capabilities: { canDelete: true },
        properties: {},
      })),
      listPermissions: vi.fn(async () => [
        { id: 'p-1', type: 'user', emailAddress: 'alice@example.com', role: 'writer' },
        { id: 'p-pub', type: 'anyone', role: 'writer' },
      ]),
      createPermission: vi.fn(async () => ({ displayName: 'Bob' })),
      deletePermission: vi.fn(async () => {}),
    } as unknown as IStorageLayer;

    const driver = new StorageLayerCatalogAndAclDriver(storage, 'owner@example.com');

    const containers = await driver.listGroupContainers();
    expect(containers[0]).toMatchObject({ id: 'g-1', name: 'Trip', isOwner: true });

    const single = await driver.getGroupContainer('g-1');
    expect(single?.isOwner).toBe(true);

    expect(await driver.checkContainerHealth('g-1')).toEqual({ available: true });

    const collaborators = await driver.listCollaborators('g-1');
    expect(collaborators).toEqual([
      {
        id: 'p-1',
        email: 'alice@example.com',
        displayName: 'alice',
        avatarUrl: undefined,
        role: 'editor',
      },
    ]);

    expect(await driver.grantAccess('g-1', 'bob@example.com', 'viewer')).toEqual({
      displayName: 'Bob',
    });
    expect(storage.createPermission).toHaveBeenCalledWith(
      'g-1',
      'reader',
      'user',
      'bob@example.com'
    );

    await driver.revokeAccess('g-1', 'p-1');
    expect(storage.deletePermission).toHaveBeenCalledWith('g-1', 'p-1');

    expect(await driver.getAccessMode('g-1')).toBe('public');
    await driver.setAccessMode('g-1', 'restricted');
    expect(storage.deletePermission).toHaveBeenCalledWith('g-1', 'p-pub');
  });
});

describe('GoogleDriveSheetsCloudSyncProvider', () => {
  it('supports initialize, connected account formatting, reauthenticate, and disconnect', async () => {
    const onTokenRefresh = vi.fn(async () => 'refreshed-tok');
    const provider = new GoogleDriveSheetsCloudSyncProvider({ onTokenRefresh });
    const credListener = vi.fn();
    provider.onCredentialsChange(credListener);

    await provider.initialize({
      accessToken: 'initial-tok',
      userName: 'Ada',
      userEmail: 'ada@example.com',
    });

    expect(provider.isInitialized()).toBe(true);
    expect(provider.getConnectedAccount()).toBe('Ada (ada@example.com)');
    expect(provider.getStatus()).toBe('idle');

    await provider.reauthenticate();
    expect(onTokenRefresh).toHaveBeenCalledTimes(1);
    expect(credListener).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: 'refreshed-tok',
        userEmail: 'ada@example.com',
        userName: 'Ada',
      })
    );

    await provider.disconnect();
    expect(provider.isInitialized()).toBe(false);
    expect(provider.getConnectedAccount()).toBeNull();
  });
});
