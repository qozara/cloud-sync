import { describe, it, expect, vi } from 'vitest';
import {
  CompositeCloudSyncProvider,
  ConflictError,
  ForeignDocumentError,
  MANIFEST_KEYS,
  QOZARA_MANIFEST_VERSION,
  SchemaEngine,
  SchemaIncompatibleError,
  UnmanagedDocumentError,
  ValidationStatus,
  computeSchemaHash,
  type ContainerInspectionResult,
  type ITabularContainerDriver,
  type SchemaDefinition,
  type TabularRow,
  type TabularStorageDriver,
} from '../src/index.js';

const quozenLikeSchema: SchemaDefinition = {
  version: 4,
  identity: {
    appId: 'quozen',
    docType: 'group',
    legacyPropertyMatchers: [{ key: 'quozen_type', value: 'group' }],
    legacyRequiredTabs: ['Expenses', 'Settlements', 'Members'],
  },
  tabs: [
    {
      name: 'Expenses',
      columns: [
        { name: 'id', type: 'string', required: true },
        { name: 'amount', type: 'number', required: true },
      ],
    },
    {
      name: 'Settlements',
      columns: [{ name: 'id', type: 'string', required: true }],
    },
    {
      name: 'Members',
      columns: [{ name: 'userId', type: 'string', required: true }],
    },
  ],
};

function createMockContainerDriver(
  initial: Partial<ContainerInspectionResult> = {}
): {
  driver: ITabularContainerDriver;
  state: ContainerInspectionResult;
} {
  const state: ContainerInspectionResult = {
    containerId: initial.containerId ?? 'doc-1',
    title: initial.title ?? 'Test Sheet',
    lastModifiedTime: initial.lastModifiedTime ?? '2026-11-20T10:00:00.000Z',
    tables: initial.tables ?? [],
    metaEntries: { ...(initial.metaEntries ?? {}) },
    hasMetaTable: initial.hasMetaTable ?? false,
    migrationVersions: [...(initial.migrationVersions ?? [])],
    hasMigrationsTable: initial.hasMigrationsTable ?? false,
    indexProperties: { ...(initial.indexProperties ?? {}) },
  };

  const driver: ITabularContainerDriver = {
    inspectContainer: vi.fn(async () => structuredClone(state)),
    ensureTable: vi.fn(async (_id, table) => {
      if (!state.tables.some((t) => t.name.toLowerCase() === table.name.toLowerCase())) {
        state.tables.push({ name: table.name, headers: table.headers ? [...table.headers] : [] });
      }
    }),
    addColumns: vi.fn(async (_id, tableName, columns) => {
      const target = state.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
      if (target) {
        target.headers = [...(target.headers || []), ...columns];
      }
    }),
    readMeta: vi.fn(async () => ({ ...state.metaEntries })),
    writeMeta: vi.fn(async (_id, entries) => {
      state.hasMetaTable = true;
      Object.assign(state.metaEntries, entries);
    }),
    ensureMigrationsTable: vi.fn(async (_id, initialVersion) => {
      state.hasMigrationsTable = true;
      if (initialVersion !== undefined && !state.migrationVersions.includes(initialVersion)) {
        state.migrationVersions.push(initialVersion);
      }
    }),
    appendMigrationRecord: vi.fn(async (_id, version) => {
      state.migrationVersions.push(version);
    }),
    createBackup: vi.fn(async () => 'backup-1'),
    restoreBackup: vi.fn(async () => {}),
    deleteBackup: vi.fn(async () => {}),
    acquireLock: vi.fn(async () => true),
    releaseLock: vi.fn(async () => true),
    syncIndexMetadata: vi.fn(async (_id, props) => {
      Object.assign(state.indexProperties, props);
    }),
    getNativeClient: vi.fn(() => ({ customNative: true })) as ITabularContainerDriver['getNativeClient'],
  };

  return { driver, state };
}

describe('SchemaEngine (storage-agnostic)', () => {
  it('returns UNMANAGED and blocks repair/migrate without mutations on unrelated spreadsheets', async () => {
    const { driver } = createMockContainerDriver({
      containerId: 'taxes-2026',
      tables: [{ name: 'Sheet1', headers: ['Month', 'Income', 'Tax'] }],
    });
    const engine = new SchemaEngine(driver);

    const health = await engine.checkHealth('taxes-2026', quozenLikeSchema);
    expect(health.status).toBe(ValidationStatus.UNMANAGED);
    expect(health.valid).toBe(false);
    expect(health.canAutoMigrate).toBe(false);

    await expect(engine.repair('taxes-2026', quozenLikeSchema)).rejects.toBeInstanceOf(
      UnmanagedDocumentError
    );
    await expect(
      engine.migrate('taxes-2026', quozenLikeSchema, [])
    ).rejects.toBeInstanceOf(UnmanagedDocumentError);

    expect(driver.createBackup).not.toHaveBeenCalled();
    expect(driver.ensureTable).not.toHaveBeenCalled();
    expect(driver.addColumns).not.toHaveBeenCalled();
    expect(driver.writeMeta).not.toHaveBeenCalled();
  });

  it('returns FOREIGN_APP and blocks repair/migrate when _meta belongs to another app', async () => {
    const { driver } = createMockContainerDriver({
      containerId: 'quomida-doc',
      hasMetaTable: true,
      metaEntries: {
        [MANIFEST_KEYS.APP_ID]: 'quomida',
        [MANIFEST_KEYS.DOC_TYPE]: 'daily_logs',
        [MANIFEST_KEYS.SCHEMA_VERSION]: '2',
      },
      tables: [{ name: 'daily_logs', headers: ['id', 'date'] }],
    });
    const engine = new SchemaEngine(driver);

    const health = await engine.checkHealth('quomida-doc', quozenLikeSchema);
    expect(health.status).toBe(ValidationStatus.FOREIGN_APP);
    expect(health.detectedAppId).toBe('quomida');
    expect(health.detectedDocType).toBe('daily_logs');

    await expect(engine.repair('quomida-doc', quozenLikeSchema)).rejects.toBeInstanceOf(
      ForeignDocumentError
    );
    await expect(
      engine.migrate('quomida-doc', quozenLikeSchema, [])
    ).rejects.toBeInstanceOf(ForeignDocumentError);
    expect(driver.createBackup).not.toHaveBeenCalled();
  });

  it('upgrades verified legacy files and stamps canonical _meta manifest', async () => {
    const { driver, state } = createMockContainerDriver({
      containerId: 'legacy-group-1',
      indexProperties: { quozen_type: 'group' },
      tables: [
        { name: 'Expenses', headers: ['id', 'amount'] },
        { name: 'Settlements', headers: ['id'] },
        { name: 'Members', headers: ['userId'] },
      ],
    });
    const engine = new SchemaEngine(driver);

    const health = await engine.checkHealth('legacy-group-1', quozenLikeSchema);
    expect(health.status).toBe(ValidationStatus.UPGRADE_REQUIRED);
    expect(health.currentVersion).toBe(1);
    expect(health.canAutoMigrate).toBe(true);

    const ranVersions: number[] = [];
    const res = await engine.migrate('legacy-group-1', quozenLikeSchema, [
      {
        version: 4,
        up: async (_client, _id, ctx) => {
          ranVersions.push(4);
          expect(ctx?.containerId).toBe('legacy-group-1');
          expect(ctx?.getNativeClient()).toEqual({ customNative: true });
        },
      },
    ]);

    expect(res.success).toBe(true);
    expect(res.applied).toEqual([4]);
    expect(ranVersions).toEqual([4]);
    expect(state.metaEntries[MANIFEST_KEYS.MANIFEST_VERSION]).toBe(QOZARA_MANIFEST_VERSION);
    expect(state.metaEntries[MANIFEST_KEYS.APP_ID]).toBe('quozen');
    expect(state.metaEntries[MANIFEST_KEYS.DOC_TYPE]).toBe('group');
    expect(state.metaEntries[MANIFEST_KEYS.SCHEMA_VERSION]).toBe('4');
    expect(state.metaEntries[MANIFEST_KEYS.ORIGIN_CONTAINER_ID]).toBe('legacy-group-1');
    expect(state.metaEntries[MANIFEST_KEYS.SCHEMA_HASH]).toBe(
      await computeSchemaHash(quozenLikeSchema)
    );
    expect(state.indexProperties.qozara_app).toBe('quozen');
    expect(state.indexProperties.qozara_doc_type).toBe('group');
    expect(driver.deleteBackup).toHaveBeenCalledWith('backup-1');
  });

  it('detects Google Drive copies (isForkedCopy) and heals origin_container_id + index properties', async () => {
    const { driver, state } = createMockContainerDriver({
      containerId: 'copied-sheet-999',
      hasMetaTable: true,
      hasMigrationsTable: true,
      migrationVersions: [4],
      metaEntries: {
        [MANIFEST_KEYS.APP_ID]: 'quozen',
        [MANIFEST_KEYS.DOC_TYPE]: 'group',
        [MANIFEST_KEYS.SCHEMA_VERSION]: '4',
        [MANIFEST_KEYS.ORIGIN_CONTAINER_ID]: 'original-sheet-111',
      },
      tables: [
        { name: 'Expenses', headers: ['id', 'amount', 'my_tax_formula'] },
        { name: 'Settlements', headers: ['id'] },
        { name: 'Members', headers: ['userId'] },
      ],
    });
    const engine = new SchemaEngine(driver);

    const health = await engine.checkHealth('copied-sheet-999', quozenLikeSchema);
    expect(health.status).toBe(ValidationStatus.READY);
    expect(health.isForkedCopy).toBe(true);

    const healed = await engine.healForkedCopy('copied-sheet-999', quozenLikeSchema);
    expect(healed.isForkedCopy).toBe(false);
    expect(state.metaEntries[MANIFEST_KEYS.ORIGIN_CONTAINER_ID]).toBe('copied-sheet-999');
    expect(state.indexProperties.qozara_app).toBe('quozen');
  });

  it('detects CORRUPTED, repairs missing tabs/columns, detects INCOMPATIBLE, and enforces OCC', async () => {
    const { driver, state } = createMockContainerDriver({
      containerId: 'group-corrupted',
      lastModifiedTime: '2026-11-20T12:00:00.000Z',
      hasMetaTable: true,
      hasMigrationsTable: true,
      migrationVersions: [4],
      metaEntries: {
        [MANIFEST_KEYS.APP_ID]: 'quozen',
        [MANIFEST_KEYS.DOC_TYPE]: 'group',
        [MANIFEST_KEYS.SCHEMA_VERSION]: '4',
        [MANIFEST_KEYS.ORIGIN_CONTAINER_ID]: 'group-corrupted',
      },
      tables: [
        { name: 'Expenses', headers: ['id'] }, // missing 'amount'
        { name: 'Members', headers: ['userId'] },
        // missing 'Settlements'
      ],
    });
    const engine = new SchemaEngine(driver);

    const health = await engine.checkHealth('group-corrupted', quozenLikeSchema);
    expect(health.status).toBe(ValidationStatus.CORRUPTED);
    expect(health.missingTabs).toEqual(['Settlements']);
    expect(health.missingColumns).toEqual({ Expenses: ['amount'] });

    await expect(
      engine.repair('group-corrupted', quozenLikeSchema, {
        expectedLastModified: '2026-11-19T00:00:00.000Z',
      })
    ).rejects.toBeInstanceOf(ConflictError);

    await engine.repair('group-corrupted', quozenLikeSchema, {
      expectedLastModified: '2026-11-20T12:00:00.000Z',
    });

    const postRepair = await engine.checkHealth('group-corrupted', quozenLikeSchema);
    expect(postRepair.status).toBe(ValidationStatus.READY);

    state.migrationVersions.push(99);
    const incomp = await engine.checkHealth('group-corrupted', quozenLikeSchema);
    expect(incomp.status).toBe(ValidationStatus.INCOMPATIBLE);
    await expect(engine.repair('group-corrupted', quozenLikeSchema)).rejects.toBeInstanceOf(
      SchemaIncompatibleError
    );
  });

  it('suspends CompositeCloudSyncProvider docKeyMode on UNMANAGED/FOREIGN_APP and preserves live headers on push', async () => {
    const writeCalls: Array<{ headers: string[]; rows: TabularRow[] }> = [];
    const tabularDriver: TabularStorageDriver = {
      id: 'mem-tab',
      name: 'Memory Tabular',
      ensureDocument: vi.fn(async () => 'doc-logs'),
      checkHealth: vi.fn(async () => ({ status: ValidationStatus.READY })),
      readTable: vi.fn(async () => [
        {
          id: '1',
          headers: ['name', 'custom_formula', 'id', 'updatedAt'],
          values: ['Lunch', '=1+1', '1', 100],
        },
      ]),
      writeTable: vi.fn(async (_docId, _tab, headers, rows) => {
        writeCalls.push({ headers, rows });
      }),
    };

    const docToRowCalls: Array<string[] | undefined> = [];
    const provider = new CompositeCloudSyncProvider({
      id: 'quomida-test',
      name: 'Quomida Test',
      tabularDriver,
      routes: {
        daily_logs: {
          target: 'tabular',
          documentKey: 'logs',
          documentTitle: 'Quomida Daily Logs',
          tabName: 'daily_logs',
        },
      },
      serializers: {
        daily_logs: {
          headers: ['id', 'name', 'updatedAt'],
          docToRow: (doc, headers) => {
            docToRowCalls.push(headers);
            const activeHeaders = headers ?? ['id', 'name', 'updatedAt'];
            return {
              id: doc.id,
              updatedAt: doc.updatedAt,
              headers: activeHeaders,
              values: activeHeaders.map((h) => {
                if (h === 'id') return doc.id;
                if (h === 'name') return doc.name;
                if (h === 'updatedAt') return doc.updatedAt;
                return undefined;
              }),
            };
          },
          rowToDoc: (r) => ({
            id: r.values[2],
            name: r.values[0],
            updatedAt: r.values[3],
          }),
        },
      },
    });

    await provider.initialize();
    await provider.pull();
    await provider.push({
      collection: 'daily_logs',
      documents: [{ id: '2', name: 'Dinner', updatedAt: 200 }],
    });

    expect(docToRowCalls[0]).toEqual(['name', 'custom_formula', 'id', 'updatedAt']);
    expect(writeCalls[0].headers).toEqual(['name', 'custom_formula', 'id', 'updatedAt']);
    expect(writeCalls[0].rows[1].values).toEqual(['Dinner', undefined, '2', 200]);

    // Check UNMANAGED health halts pull & push without touching table
    vi.mocked(tabularDriver.checkHealth!).mockResolvedValueOnce({
      status: ValidationStatus.UNMANAGED,
    });
    await provider.pull();
    expect(provider.getStatus()).toBe('unmanaged');
    await expect(
      provider.push({ collection: 'daily_logs', documents: [{ id: '3', name: 'Snack', updatedAt: 300 }] })
    ).rejects.toBeInstanceOf(UnmanagedDocumentError);
  });
});
