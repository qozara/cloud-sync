import {
  ForeignDocumentError,
  GroupFileUnavailableError,
  TableNotFoundError,
  UnmanagedDocumentError,
} from './errors.js';
import {
  isEntityNotFoundError,
  isNetworkError,
  parseTimestampMs,
  sanitizeRemoteDocument,
  shouldAcceptIncomingDoc,
} from './serializers.js';
import type {
  BlobStorageDriver,
  CloudSyncProvider,
  CollectionRoute,
  CollectionSerializer,
  CompositeCloudSyncProviderOptions,
  GroupTabularSerializer,
  SyncDeltaPayload,
  SyncStatus,
  TabularRow,
  TabularStorageDriver,
} from './types.js';

export class CompositeCloudSyncProvider implements CloudSyncProvider {
  id: string;
  name: string;
  description?: string;

  protected initialized = false;
  protected status: SyncStatus = 'disconnected';
  protected lastSyncedTime: string | null = null;
  protected lastError: any = null;
  protected statusListeners: Set<(status: SyncStatus, error?: any) => void> = new Set();
  protected credentialsListeners: Set<(credentials: any) => void> = new Set();
  protected blobDriver?: BlobStorageDriver;
  protected tabularDriver?: TabularStorageDriver;
  protected routes: Record<string, CollectionRoute>;
  protected activeGroupId: string | null;
  protected lastPulledUserSettingsUpdatedAt: string | null = null;
  protected documentIdCache: Map<string, string> = new Map();
  protected tabularCache: Map<string, Record<string, any>[]> = new Map();
  protected tabularHeadersCache: Map<string, string[]> = new Map();
  protected serializers: Record<string, CollectionSerializer>;
  protected groupSerializers: Record<string, GroupTabularSerializer>;
  protected normalizeBlobDoc?: (collection: string, raw: any) => Record<string, any>;
  protected mergeBlobPush?: CompositeCloudSyncProviderOptions['mergeBlobPush'];
  protected shouldSkipTabularPushDoc?: (collection: string, doc: Record<string, any>) => boolean;
  protected filterPulledTabularDoc?: (collection: string, doc: Record<string, any>) => boolean;

  constructor(options: CompositeCloudSyncProviderOptions) {
    this.id = options.id;
    this.name = options.name;
    this.description = options.description;
    this.blobDriver = options.blobDriver;
    this.tabularDriver = options.tabularDriver;
    this.routes = options.routes || {};
    this.activeGroupId = options.activeGroupId ?? null;
    this.serializers = options.serializers || {};
    this.groupSerializers = options.groupSerializers || {};
    this.normalizeBlobDoc = options.normalizeBlobDoc;
    this.mergeBlobPush = options.mergeBlobPush;
    this.shouldSkipTabularPushDoc = options.shouldSkipTabularPushDoc;
    this.filterPulledTabularDoc = options.filterPulledTabularDoc;
  }

  protected hasDocumentKeyRoutes(): boolean {
    return Object.values(this.routes).some(
      (r) => r.target === 'tabular' && Boolean(r.documentKey)
    );
  }

  getLastError(): any {
    return this.lastError;
  }

  setActiveGroupId(groupId: string | null): void {
    this.activeGroupId = groupId;
  }

  getActiveGroupId(): string | null {
    return this.activeGroupId;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getLastSyncedTime(): string | null {
    return this.lastSyncedTime;
  }

  getConnectedAccount(): string | null {
    return this.initialized ? 'connected-account' : null;
  }

  getUserPicture(): string | null {
    return null;
  }

  onStatusChange(listener: (status: SyncStatus, error?: any) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onCredentialsChange(listener: (credentials: any) => void): () => void {
    this.credentialsListeners.add(listener);
    return () => {
      this.credentialsListeners.delete(listener);
    };
  }

  protected setStatus(newStatus: SyncStatus, error?: any): void {
    if (error !== undefined) {
      this.lastError = error;
    } else if (newStatus === 'idle' || newStatus === 'synced') {
      this.lastError = null;
    }
    this.status = newStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus, this.lastError);
      } catch (err) {
        console.error('Error in status change listener', err);
      }
    }
  }

  protected notifyCredentialsChange(credentials: any): void {
    for (const listener of this.credentialsListeners) {
      try {
        listener(credentials);
      } catch (err) {
        console.error('Error in credentials change listener', err);
      }
    }
  }

  setCorruptedStatus(): void {
    this.setStatus('corrupted');
  }

  setUpgradeRequiredStatus(): void {
    this.setStatus('upgrade_required');
  }

  async getRemoteLinks(): Promise<string[]> {
    const links: string[] = [];
    if (this.blobDriver?.getRemoteLinks) {
      links.push(...(await this.blobDriver.getRemoteLinks()));
    }
    if (this.tabularDriver?.getRemoteLinks) {
      links.push(...(await this.tabularDriver.getRemoteLinks()));
    }
    return links;
  }

  async initialize(_credentials?: any): Promise<void> {
    this.initialized = true;
    this.lastSyncedTime = new Date().toISOString();
    this.setStatus('idle');
  }

  async disconnect(): Promise<void> {
    this.initialized = false;
    this.documentIdCache.clear();
    this.tabularCache.clear();
    this.tabularHeadersCache.clear();
    this.setStatus('disconnected');
  }

  async reauthenticate(): Promise<void> {
    if (this.initialized) {
      this.setStatus('idle');
      this.lastSyncedTime = new Date().toISOString();
    } else {
      this.setStatus('auth_failed');
    }
  }

  async forceSync(): Promise<void> {
    if (!this.initialized) return;
    this.setStatus('syncing');
    await this.pull();
    this.lastSyncedTime = new Date().toISOString();
    this.setStatus('idle');
  }

  async repair(groupId?: string): Promise<void> {
    if (!this.tabularDriver?.repairTable) {
      throw new Error('Repair is not supported by this sync adapter driver');
    }

    this.setStatus('syncing');
    try {
      if (groupId) {
        await this.tabularDriver.repairTable(groupId);
      } else {
        const docIds = new Set<string>();
        for (const route of Object.values(this.routes)) {
          if (route.target === 'tabular' && route.documentKey) {
            const docId = await this.resolveDocumentId(
              route.documentKey,
              route.documentTitle || route.documentKey
            );
            docIds.add(docId);
          }
        }
        for (const docId of docIds) {
          await this.tabularDriver.repairTable(docId);
        }
      }
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('corrupted');
      throw err;
    }
  }

  async migrate(groupId?: string): Promise<void> {
    if (!this.tabularDriver?.migrateTable) {
      throw new Error('Migration is not supported by this sync adapter driver');
    }

    this.setStatus('syncing');
    try {
      if (groupId) {
        await this.tabularDriver.migrateTable(groupId);
      } else {
        const docIds = new Set<string>();
        for (const route of Object.values(this.routes)) {
          if (route.target === 'tabular' && route.documentKey) {
            const docId = await this.resolveDocumentId(
              route.documentKey,
              route.documentTitle || route.documentKey
            );
            docIds.add(docId);
          }
        }
        for (const docId of docIds) {
          await this.tabularDriver.migrateTable(docId);
        }
      }
      this.setStatus('idle');
    } catch (err) {
      this.setStatus('upgrade_required');
      throw err;
    }
  }

  async getSchemaDiagnostic(): Promise<{
    status: SyncStatus;
    missingColumns?: Record<string, string[]>;
    missingTabs?: string[];
  } | null> {
    if (
      this.status !== 'corrupted' &&
      this.status !== 'upgrade_required' &&
      this.status !== 'unmanaged' &&
      this.status !== 'foreign_app' &&
      this.status !== 'incompatible'
    ) {
      return null;
    }
    if (!this.tabularDriver?.checkHealth) {
      return { status: this.status };
    }

    try {
      const allMissingCols: Record<string, string[]> = {};
      const allMissingTabs: string[] = [];

      for (const route of Object.values(this.routes)) {
        if (route.target === 'tabular' && route.documentKey) {
          const docId = await this.resolveDocumentId(
            route.documentKey,
            route.documentTitle || route.documentKey
          );
          const health = await this.tabularDriver.checkHealth(docId);
          if (health?.missingColumns) {
            Object.assign(allMissingCols, health.missingColumns);
          }
          if (health?.missingTabs) {
            allMissingTabs.push(...health.missingTabs);
          }
        }
      }

      return {
        status: this.status,
        missingColumns: allMissingCols,
        missingTabs: allMissingTabs,
      };
    } catch {
      return { status: this.status };
    }
  }

  async push(payload: SyncDeltaPayload): Promise<void> {
    if (!this.initialized) return;

    const docKeyMode = this.hasDocumentKeyRoutes();
    if (docKeyMode) {
      if (this.status === 'corrupted') {
        throw new Error(
          'Sync suspended: remote spreadsheet schema is corrupted. Please repair the spreadsheet before syncing.'
        );
      }
      if (this.status === 'upgrade_required') {
        throw new Error(
          'Sync suspended: remote spreadsheet schema requires upgrade. Please migrate the spreadsheet before syncing.'
        );
      }
      if (this.status === 'unmanaged') {
        throw new UnmanagedDocumentError(
          undefined,
          'Sync suspended: remote spreadsheet is not managed by this application (missing _meta manifest).'
        );
      }
      if (this.status === 'foreign_app') {
        throw new ForeignDocumentError(
          undefined,
          undefined,
          undefined,
          'Sync suspended: remote spreadsheet belongs to another application.'
        );
      }
    } else if (
      payload.collection !== 'user_settings' &&
      (this.status === 'upgrade_required' ||
        this.status === 'corrupted' ||
        this.status === 'incompatible' ||
        this.status === 'unmanaged' ||
        this.status === 'foreign_app')
    ) {
      return;
    }

    const prevStatus = this.status;
    this.setStatus('syncing');

    try {
      const route = this.routes[payload.collection];
      if (!route) {
        console.warn(
          `[CompositeCloudSyncProvider] Skipping unrouted collection "${payload.collection}"`
        );
        return;
      }

      if (route.target === 'blob') {
        if (!this.blobDriver) {
          throw new Error(`BlobStorageDriver is required for collection "${payload.collection}"`);
        }

        const existingRaw = await this.blobDriver.readBlob<any>(route.filename);
        const existingDocs: Record<string, any>[] = existingRaw
          ? Array.isArray(existingRaw)
            ? existingRaw
            : [
                existingRaw.id
                  ? existingRaw
                  : this.normalizeBlobDoc
                    ? this.normalizeBlobDoc(payload.collection, existingRaw)
                    : existingRaw,
              ]
          : [];

        let docsToWrite: Record<string, any>[];
        if (this.mergeBlobPush) {
          const merged = await this.mergeBlobPush(
            payload.collection,
            payload.documents,
            existingDocs,
            {
              lastPulledUpdatedAt: this.lastPulledUserSettingsUpdatedAt,
              tabularDriver: this.tabularDriver,
            }
          );
          docsToWrite = merged.docsToWrite;
          if (merged.nextLastPulledUpdatedAt !== undefined) {
            this.lastPulledUserSettingsUpdatedAt = merged.nextLastPulledUpdatedAt;
          } else if (payload.collection === 'user_settings' && docsToWrite[0]?.updatedAt) {
            this.lastPulledUserSettingsUpdatedAt = docsToWrite[0].updatedAt;
          }
        } else {
          const docMap = new Map(
            existingDocs.map((d) => [d.id, sanitizeRemoteDocument(payload.collection, d)])
          );
          for (const doc of payload.documents) {
            if (doc.id) {
              const sanitized = sanitizeRemoteDocument(payload.collection, doc);
              const current = docMap.get(doc.id);
              if (shouldAcceptIncomingDoc(current, sanitized)) {
                docMap.set(doc.id, sanitized);
              }
            }
          }
          docsToWrite = Array.from(docMap.values());
        }

        await this.blobDriver.writeBlob(route.filename, docsToWrite);
      } else if (route.target === 'tabular') {
        if (!this.tabularDriver) {
          throw new Error(
            `TabularStorageDriver is required for collection "${payload.collection}"`
          );
        }

        if (route.documentKey) {
          const serializer = this.serializers[payload.collection];
          if (!serializer) {
            throw new Error(
              `No tabular serializer registered for collection "${payload.collection}"`
            );
          }

          let docId = await this.resolveDocumentId(
            route.documentKey,
            route.documentTitle || route.documentKey
          );
          let cacheKey = `${docId}_${route.tabName}`;

          let existingDocs: Record<string, any>[] = [];
          if (this.tabularCache.has(cacheKey)) {
            existingDocs = this.tabularCache.get(cacheKey)!;
          } else {
            try {
              const existingRows = await this.tabularDriver.readTable(docId, route.tabName);
              if (existingRows[0]?.headers?.length) {
                this.tabularHeadersCache.set(cacheKey, existingRows[0].headers);
              }
              existingDocs = existingRows.map((r) => serializer.rowToDoc(r));
            } catch (err: any) {
              if (
                err?.message?.includes('corruption') ||
                err?.message?.includes('missing required column')
              ) {
                throw err;
              }
              if (isEntityNotFoundError(err)) {
                this.invalidateDocument(route.documentKey, docId);
                docId = await this.resolveDocumentId(
                  route.documentKey,
                  route.documentTitle || route.documentKey,
                  true
                );
                cacheKey = `${docId}_${route.tabName}`;
                existingDocs = [];
              }
            }
          }

          const docMap = new Map(existingDocs.map((d) => [d.id, d]));
          for (const doc of payload.documents) {
            if (doc.id) {
              if (this.shouldSkipTabularPushDoc?.(payload.collection, doc)) {
                continue;
              }
              const current = docMap.get(doc.id);
              if (shouldAcceptIncomingDoc(current, doc)) {
                docMap.set(doc.id, doc);
              }
            }
          }

          const mergedDocs = Array.from(docMap.values());
          this.tabularCache.set(cacheKey, mergedDocs);

          const liveHeaders = this.tabularHeadersCache.get(cacheKey) || serializer.headers;
          const rows = mergedDocs.map((doc) => serializer.docToRow(doc, liveHeaders));
          try {
            await this.tabularDriver.writeTable(docId, route.tabName, liveHeaders, rows);
          } catch (writeErr: any) {
            if (isEntityNotFoundError(writeErr)) {
              this.invalidateDocument(route.documentKey, docId);
              const freshDocId = await this.resolveDocumentId(
                route.documentKey,
                route.documentTitle || route.documentKey,
                true
              );
              const freshCacheKey = `${freshDocId}_${route.tabName}`;
              this.tabularCache.set(freshCacheKey, mergedDocs);
              const freshHeaders = this.tabularHeadersCache.get(freshCacheKey) || serializer.headers;
              const freshRows = mergedDocs.map((doc) => serializer.docToRow(doc, freshHeaders));
              await this.tabularDriver.writeTable(
                freshDocId,
                route.tabName,
                freshHeaders,
                freshRows
              );
            } else {
              throw writeErr;
            }
          }
        } else {
          const targetGroupId =
            payload.groupId || payload.documents[0]?.groupId || this.activeGroupId;
          if (!targetGroupId) {
            throw new Error(
              `groupId is required to push tabular collection "${payload.collection}"`
            );
          }

          const serializer = this.groupSerializers[payload.collection];
          if (!serializer) {
            throw new Error(
              `No serializer registered for tabular collection "${payload.collection}"`
            );
          }

          let existingRows: TabularRow[] = [];
          try {
            existingRows = await this.tabularDriver.readTable(targetGroupId, route.tabName);
          } catch (readErr: any) {
            if (readErr instanceof TableNotFoundError || readErr?.name === 'TableNotFoundError') {
              this.setStatus('upgrade_required');
              return;
            }
            throw readErr;
          }

          const rawHeaders = existingRows[0]?.headers || serializer.defaultHeaders;
          const headersToWrite = [...rawHeaders];
          if (
            serializer.defaultHeaders.some((h) => h.trim().toLowerCase() === 'updatedat') &&
            !headersToWrite.some((h) => h.trim().toLowerCase() === 'updatedat')
          ) {
            headersToWrite.push('updatedAt');
          }

          const rawDocs = existingRows.map((r) => serializer.rowToDoc(r, targetGroupId));
          const existingDocs = this.filterPulledTabularDoc
            ? rawDocs.filter((d) => this.filterPulledTabularDoc!(payload.collection, d))
            : rawDocs.filter((d) => Boolean(d.id));

          const docMap = new Map(existingDocs.map((d) => [d.id, d]));
          for (const doc of payload.documents) {
            if (doc.id) {
              if (doc.deletedAt) {
                docMap.delete(doc.id);
              } else {
                docMap.set(doc.id, doc);
              }
            }
          }

          const activeDocs = Array.from(docMap.values()).filter((d) => !d.deletedAt);
          const rows = activeDocs.map((d) => serializer.docToRow(d, headersToWrite));
          try {
            await this.tabularDriver.writeTable(
              targetGroupId,
              route.tabName,
              headersToWrite,
              rows
            );
          } catch (writeErr: any) {
            if (writeErr instanceof TableNotFoundError || writeErr?.name === 'TableNotFoundError') {
              this.setStatus('upgrade_required');
              return;
            }
            throw writeErr;
          }
        }
      }

      this.lastSyncedTime = new Date().toISOString();
      if (
        !docKeyMode &&
        (prevStatus === 'upgrade_required' ||
          prevStatus === 'corrupted' ||
          prevStatus === 'incompatible' ||
          prevStatus === 'unmanaged' ||
          prevStatus === 'foreign_app')
      ) {
        this.setStatus(prevStatus);
      } else {
        this.setStatus('idle');
      }
    } catch (err: any) {
      this.handleSyncException(err, docKeyMode);
      throw err;
    }
  }

  async pull(groupId?: string): Promise<SyncDeltaPayload[]> {
    if (!this.initialized) return [];

    const docKeyMode = this.hasDocumentKeyRoutes();
    if (docKeyMode && !groupId) {
      if (this.status === 'corrupted') {
        throw new Error(
          'Sync suspended: remote spreadsheet schema is corrupted. Please repair the spreadsheet before syncing.'
        );
      }
      if (this.status === 'upgrade_required') {
        throw new Error(
          'Sync suspended: remote spreadsheet schema requires upgrade. Please migrate the spreadsheet before syncing.'
        );
      }
      if (this.status === 'unmanaged') {
        throw new UnmanagedDocumentError(
          undefined,
          'Sync suspended: remote spreadsheet is not managed by this application (missing _meta manifest).'
        );
      }
      if (this.status === 'foreign_app') {
        throw new ForeignDocumentError(
          undefined,
          undefined,
          undefined,
          'Sync suspended: remote spreadsheet belongs to another application.'
        );
      }

      this.setStatus('syncing');
      try {
        const results: SyncDeltaPayload[] = [];
        const checkedDocIds = new Set<string>();
        for (const [collection, route] of Object.entries(this.routes)) {
          if (route.target === 'blob' && this.blobDriver) {
            const docs = await this.blobDriver.readBlob<Record<string, any>[]>(route.filename);
            if (docs && Array.isArray(docs)) {
              results.push({ collection, documents: docs });
            }
          } else if (route.target === 'tabular' && this.tabularDriver && route.documentKey) {
            const serializer = this.serializers[collection];
            if (serializer) {
              try {
                let docId = await this.resolveDocumentId(
                  route.documentKey,
                  route.documentTitle || route.documentKey
                );
                if (
                  typeof this.tabularDriver.checkHealth === 'function' &&
                  !checkedDocIds.has(docId)
                ) {
                  checkedDocIds.add(docId);
                  const health = await this.tabularDriver.checkHealth(docId);
                  if (health?.status === 'UPGRADE_REQUIRED') {
                    this.setStatus('upgrade_required');
                    return results;
                  }
                  if (health?.status === 'INCOMPATIBLE') {
                    this.setStatus('incompatible');
                    return results;
                  }
                  if (health?.status === 'CORRUPTED') {
                    this.setStatus('corrupted');
                    return results;
                  }
                  if (health?.status === 'UNMANAGED') {
                    this.setStatus('unmanaged');
                    return results;
                  }
                  if (health?.status === 'FOREIGN_APP') {
                    this.setStatus('foreign_app');
                    return results;
                  }
                }
                let rows: TabularRow[];
                try {
                  rows = await this.tabularDriver.readTable(docId, route.tabName);
                } catch (readErr: any) {
                  if (isEntityNotFoundError(readErr)) {
                    this.invalidateDocument(route.documentKey, docId);
                    docId = await this.resolveDocumentId(
                      route.documentKey,
                      route.documentTitle || route.documentKey,
                      true
                    );
                    rows = await this.tabularDriver.readTable(docId, route.tabName);
                  } else {
                    throw readErr;
                  }
                }
                const cacheKey = `${docId}_${route.tabName}`;
                if (rows[0]?.headers?.length) {
                  this.tabularHeadersCache.set(cacheKey, rows[0].headers);
                }
                const documents = rows.map((r) => serializer.rowToDoc(r));
                this.tabularCache.set(cacheKey, documents);
                results.push({ collection, documents });
              } catch (tabErr: any) {
                if (
                  tabErr?.message?.includes('corruption') ||
                  tabErr?.message?.includes('missing required column') ||
                  tabErr instanceof UnmanagedDocumentError ||
                  tabErr?.name === 'UnmanagedDocumentError' ||
                  tabErr instanceof ForeignDocumentError ||
                  tabErr?.name === 'ForeignDocumentError'
                ) {
                  throw tabErr;
                }
                results.push({ collection, documents: [] });
              }
            }
          }
        }
        this.lastSyncedTime = new Date().toISOString();
        this.setStatus('idle');
        return results;
      } catch (err: any) {
        this.handleSyncException(err, true);
        throw err;
      }
    }

    // Group-scoped mode (e.g. Quozen)
    if (groupId) {
      this.activeGroupId = groupId;
    }
    const targetGroupId = groupId;
    const results: SyncDeltaPayload[] = [];

    for (const [collection, route] of Object.entries(this.routes)) {
      if (route.target === 'blob' && this.blobDriver) {
        try {
          const rawBlob = await this.blobDriver.readBlob<any>(route.filename);
          if (rawBlob) {
            const docs = Array.isArray(rawBlob)
              ? rawBlob
              : [
                  rawBlob.id
                    ? rawBlob
                    : this.normalizeBlobDoc
                      ? this.normalizeBlobDoc(collection, rawBlob)
                      : rawBlob,
                ];
            if (collection === 'user_settings' && docs[0]?.updatedAt) {
              this.lastPulledUserSettingsUpdatedAt = docs[0].updatedAt;
            }
            results.push({ collection, documents: docs });
          }
        } catch (blobErr) {
          console.warn(`[Sync] Failed to read blob route ${route.filename}:`, blobErr);
        }
      }
    }

    const metaEnv =
      typeof import.meta !== 'undefined'
        ? (import.meta as unknown as { env?: Record<string, string> }).env
        : undefined;
    const isMockMode =
      metaEnv?.VITE_USE_MOCK_STORAGE === 'true' || metaEnv?.VITE_USE_MOCK_STORAGE === 'remote';

    if (!isMockMode && targetGroupId && typeof this.tabularDriver?.checkHealth === 'function') {
      try {
        const health = await this.tabularDriver.checkHealth(targetGroupId);
        if (health?.status === 'UPGRADE_REQUIRED') {
          this.setStatus('upgrade_required');
          return results;
        }
        if (health?.status === 'INCOMPATIBLE') {
          this.setStatus('incompatible');
          return results;
        }
        if (health?.status === 'CORRUPTED') {
          this.setStatus('corrupted');
          return results;
        }
        if (health?.status === 'UNMANAGED') {
          this.setStatus('unmanaged');
          return results;
        }
        if (health?.status === 'FOREIGN_APP') {
          this.setStatus('foreign_app');
          return results;
        }
      } catch (healthErr: any) {
        const healthMsg = String(healthErr?.message || healthErr).toLowerCase();
        if (
          healthMsg.includes('404') ||
          healthMsg.includes('not found') ||
          healthMsg.includes('410') ||
          healthErr?.name === 'NotFoundError' ||
          healthMsg.includes('trash')
        ) {
          throw new GroupFileUnavailableError(
            targetGroupId,
            undefined,
            healthMsg.includes('trash') ? 'trashed' : 'deleted'
          );
        }
        if (healthErr?.name === 'ForeignDocumentError') {
          this.setStatus('foreign_app');
          return results;
        }
        if (healthErr?.name === 'UnmanagedDocumentError') {
          this.setStatus('unmanaged');
          return results;
        }
        if (healthErr?.name === 'SchemaIncompatibleError') {
          this.setStatus('incompatible');
          return results;
        }
        if (
          healthErr?.name === 'SchemaUpgradeRequiredError' ||
          healthMsg.includes('upgrade')
        ) {
          this.setStatus('upgrade_required');
          return results;
        }
        if (healthErr?.name === 'SchemaCorruptedError') {
          this.setStatus('corrupted');
          return results;
        }
      }
    }

    this.setStatus('syncing');
    try {
      for (const [collection, route] of Object.entries(this.routes)) {
        if (route.target === 'tabular' && this.tabularDriver && targetGroupId) {
          const serializer = this.groupSerializers[collection];
          if (serializer) {
            try {
              const rows = await this.tabularDriver.readTable(targetGroupId, route.tabName);
              if (rows) {
                const mappedDocs = rows.map((r) => serializer.rowToDoc(r, targetGroupId));
                const documents = this.filterPulledTabularDoc
                  ? mappedDocs.filter((d) => this.filterPulledTabularDoc!(collection, d))
                  : mappedDocs.filter((d) => Boolean(d.id));
                results.push({ collection, groupId: targetGroupId, documents });
              }
            } catch (tabErr: any) {
              const errMsg = String(tabErr?.message || tabErr).toLowerCase();
              if (tabErr instanceof TableNotFoundError || tabErr?.name === 'TableNotFoundError') {
                this.setStatus('upgrade_required');
                return results;
              }
              if (
                errMsg.includes('404') ||
                errMsg.includes('not found') ||
                errMsg.includes('410') ||
                tabErr?.name === 'NotFoundError' ||
                errMsg.includes('trash')
              ) {
                throw new GroupFileUnavailableError(
                  targetGroupId,
                  undefined,
                  errMsg.includes('trash') ? 'trashed' : 'deleted'
                );
              }
              throw tabErr;
            }
          }
        }
      }

      this.lastSyncedTime = new Date().toISOString();
      this.setStatus('idle');
      return results;
    } catch (err: any) {
      this.handleSyncException(err, false);
      throw err;
    }
  }

  invalidateDocument(documentKey: string, staleDocId?: string): void {
    this.documentIdCache.delete(documentKey);
    if (staleDocId) {
      for (const key of Array.from(this.tabularCache.keys())) {
        if (key.startsWith(`${staleDocId}_`)) {
          this.tabularCache.delete(key);
        }
      }
      for (const key of Array.from(this.tabularHeadersCache.keys())) {
        if (key.startsWith(`${staleDocId}_`)) {
          this.tabularHeadersCache.delete(key);
        }
      }
    }
  }

  protected async resolveDocumentId(
    documentKey: string,
    documentTitle: string,
    bypassCache = false
  ): Promise<string> {
    if (!bypassCache && this.documentIdCache.has(documentKey)) {
      return this.documentIdCache.get(documentKey)!;
    }
    if (!this.tabularDriver?.ensureDocument) {
      throw new Error('TabularStorageDriver with ensureDocument is not configured');
    }

    const relevantTabs = Object.values(this.routes)
      .filter((r) => r.target === 'tabular' && r.documentKey === documentKey)
      .map((r) => (r as Extract<CollectionRoute, { target: 'tabular' }>).tabName);

    const docId = await this.tabularDriver.ensureDocument(documentTitle, relevantTabs);
    this.documentIdCache.set(documentKey, docId);
    return docId;
  }

  protected handleSyncException(err: any, docKeyMode: boolean): void {
    this.lastError = err;
    const msg = String(err?.message || err);
    if (
      !docKeyMode &&
      (err instanceof GroupFileUnavailableError || err?.name === 'GroupFileUnavailableError')
    ) {
      this.setStatus('idle', err);
      return;
    }
    if (err instanceof ForeignDocumentError || err?.name === 'ForeignDocumentError') {
      this.setStatus('foreign_app', err);
      return;
    }
    if (err instanceof UnmanagedDocumentError || err?.name === 'UnmanagedDocumentError') {
      this.setStatus('unmanaged', err);
      return;
    }
    if (err?.name === 'SchemaIncompatibleError' || (!docKeyMode && msg.includes('incompatible'))) {
      this.setStatus('incompatible', err);
      return;
    }
    if (err instanceof TableNotFoundError || err?.name === 'TableNotFoundError') {
      this.setStatus('upgrade_required', err);
      return;
    }
    if (
      msg.includes('corruption') ||
      msg.includes('missing required column') ||
      err?.name === 'SchemaCorruptedError'
    ) {
      this.setStatus('corrupted', err);
    } else if (
      msg.includes('upgrade') ||
      msg.includes('SchemaUpgradeRequired') ||
      err?.name === 'SchemaUpgradeRequiredError'
    ) {
      this.setStatus('upgrade_required', err);
    } else if (
      msg.includes('Google Auth Failed') ||
      msg.includes('401') ||
      msg.includes('unauthorized')
    ) {
      this.setStatus('auth_failed', err);
    } else if (msg.includes('Rate Limit') || msg.includes('429')) {
      this.setStatus('throttled', err);
    } else if (isNetworkError(err) || isEntityNotFoundError(err) || parseTimestampMs(0) < 0) {
      this.setStatus('idle', docKeyMode ? undefined : err);
    } else {
      this.setStatus('error', err);
    }
  }
}
