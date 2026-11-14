import { describe, it, expect, vi } from 'vitest';
import {
  CompositeCloudSyncProvider,
  TableNotFoundError,
  GroupFileUnavailableError,
  type BlobStorageDriver,
  type TabularStorageDriver,
  type TabularRow,
} from '../src/index.js';

function createMemoryDrivers() {
  const blobs = new Map<string, unknown>();
  const tables = new Map<string, TabularRow[]>();

  const blobDriver: BlobStorageDriver = {
    id: 'mem-blob',
    name: 'Memory Blob',
    readBlob: vi.fn(async (key) => (blobs.has(key) ? structuredClone(blobs.get(key)) : null)) as BlobStorageDriver['readBlob'],
    writeBlob: vi.fn(async (key, data) => {
      blobs.set(key, structuredClone(data));
    }) as BlobStorageDriver['writeBlob'],
  };

  const tabularDriver: TabularStorageDriver = {
    id: 'mem-tab',
    name: 'Memory Tabular',
    ensureDocument: vi.fn(async (title) => `doc-${title}`),
    readTable: vi.fn(async (docId: string, tabName: string) =>
      structuredClone(tables.get(`${docId}:${tabName}`) ?? [])
    ),
    writeTable: vi.fn(async (docId: string, tabName: string, headers: string[], rows: TabularRow[]) => {
      tables.set(`${docId}:${tabName}`, rows.map((r) => ({ ...r, headers })));
    }),
    checkHealth: vi.fn(async () => ({ status: 'READY' })),
  };

  return { blobs, tables, blobDriver, tabularDriver };
}

describe('CompositeCloudSyncProvider', () => {
  it('handles document-key mode (Quomida) with LWW merge and settings sanitization', async () => {
    const { blobs, tables, blobDriver, tabularDriver } = createMemoryDrivers();
    blobs.set('settings.json', [{ id: 'global_settings', theme: 'dark', updatedAt: 200 }]);

    const provider = new CompositeCloudSyncProvider({
      id: 'quomida-composite',
      name: 'Quomida Composite',
      blobDriver,
      tabularDriver,
      routes: {
        user_settings: { target: 'blob', filename: 'settings.json' },
        items: {
          target: 'tabular',
          documentKey: 'catalog',
          documentTitle: 'Catalog',
          tabName: 'items',
        },
      },
      serializers: {
        items: {
          headers: ['id', 'name', 'updatedAt'],
          docToRow: (d) => ({ id: d.id, updatedAt: d.updatedAt, values: [d.id, d.name, d.updatedAt] }),
          rowToDoc: (r) => ({ id: r.values[0], name: r.values[1], updatedAt: r.values[2] }),
        },
      },
      shouldSkipTabularPushDoc: (_col, doc) => doc.source === 'system',
    });

    await provider.initialize();
    await provider.push({
      collection: 'user_settings',
      documents: [{ id: 'global_settings', theme: 'light', active_cloud_provider: 'google', updatedAt: 100 }],
    });
    expect((blobs.get('settings.json') as { theme: string }[])[0].theme).toBe('dark');

    await provider.push({
      collection: 'items',
      documents: [
        { id: 'sys-1', name: 'System', source: 'system', updatedAt: 10 },
        { id: 'usr-1', name: 'Custom', source: 'custom', updatedAt: 20 },
      ],
    });
    expect(tables.get('doc-Catalog:items')).toHaveLength(1);

    const deltas = await provider.pull();
    expect(deltas.find((d) => d.collection === 'items')?.documents).toHaveLength(1);
    expect(provider.getStatus()).toBe('idle');
  });

  it('handles group-scoped mode (Quozen) including health checks, TableNotFoundError, and GroupFileUnavailableError', async () => {
    const { blobs, blobDriver, tabularDriver } = createMemoryDrivers();
    blobs.set('quozen-settings.json', [{ id: 'global_settings', updatedAt: '2026-11-01T00:00:00.000Z' }]);

    const provider = new CompositeCloudSyncProvider({
      id: 'quozen-composite',
      name: 'Quozen Composite',
      blobDriver,
      tabularDriver,
      routes: {
        user_settings: { target: 'blob', filename: 'quozen-settings.json' },
        expenses: { target: 'tabular', tabName: 'Expenses' },
      },
      groupSerializers: {
        expenses: {
          defaultHeaders: ['id', 'description', 'updatedAt'],
          docToRow: (d, headers) => ({
            id: d.id,
            updatedAt: d.updatedAt,
            headers,
            values: [d.id, d.description, d.updatedAt],
          }),
          rowToDoc: (r, groupId) => ({
            id: r.values[0],
            description: r.values[1],
            updatedAt: r.values[2],
            groupId,
          }),
        },
      },
    });

    await provider.initialize();

    // Without groupId: pulls blobs only and skips health check / tabular tabs
    const globalPull = await provider.pull();
    expect(globalPull).toHaveLength(1);
    expect(tabularDriver.checkHealth).not.toHaveBeenCalled();

    // UPGRADE_REQUIRED health stops tabular pull and sets status
    vi.mocked(tabularDriver.checkHealth!).mockResolvedValueOnce({ status: 'UPGRADE_REQUIRED' });
    await provider.pull('group-1');
    expect(provider.getStatus()).toBe('upgrade_required');

    // TableNotFoundError during pull sets upgrade_required
    vi.mocked(tabularDriver.readTable).mockRejectedValueOnce(new TableNotFoundError('Expenses'));
    await provider.pull('group-1');
    expect(provider.getStatus()).toBe('upgrade_required');

    // 404 from readTable maps to GroupFileUnavailableError
    vi.mocked(tabularDriver.readTable).mockRejectedValueOnce(new Error('404 File not found'));
    await expect(provider.pull('group-2')).rejects.toBeInstanceOf(GroupFileUnavailableError);
  });
});
