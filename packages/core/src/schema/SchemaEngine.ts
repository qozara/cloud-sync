import {
  ConflictError,
  ForeignDocumentError,
  SchemaIncompatibleError,
  UnmanagedDocumentError,
} from '../errors.js';
import { computeSchemaHash } from './SchemaHasher.js';
import {
  MANIFEST_KEYS,
  QOZARA_MANIFEST_VERSION,
  ValidationStatus,
  type ContainerInspectionResult,
  type ITabularContainerDriver,
  type LifecycleOptions,
  type SchemaDefinition,
  type SchemaMigration,
  type SchemaStatusDTO,
  type TabularMigrationContext,
} from './types.js';

const DEFAULT_META_PROTECT_WARNING = 'Qozara System Manifest - Do not delete or alter.';

export class SchemaEngine {
  constructor(public readonly driver: ITabularContainerDriver) {}

  private createMigrationContext(containerId: string): TabularMigrationContext {
    return {
      driver: this.driver,
      containerId,
      ensureTable: (table) => this.driver.ensureTable(containerId, table),
      addColumns: (tableName, columns) => this.driver.addColumns(containerId, tableName, columns),
      readMeta: () => this.driver.readMeta(containerId),
      writeMeta: (entries, options) => this.driver.writeMeta(containerId, entries, options),
      getNativeClient: <T = unknown>() =>
        this.driver.getNativeClient ? this.driver.getNativeClient<T>() : undefined,
    };
  }

  private assertNoConcurrencyConflict(
    actualModifiedTime: string | undefined,
    expectedLastModified: string | undefined
  ): void {
    if (!expectedLastModified || !actualModifiedTime) return;
    const actualMs = new Date(actualModifiedTime).getTime();
    const expectedMs = new Date(expectedLastModified).getTime();
    if (Number.isFinite(actualMs) && Number.isFinite(expectedMs) && actualMs > expectedMs) {
      throw new ConflictError('Container has been modified since it was last fetched.');
    }
  }

  private hasVerifiedLegacyProvenance(
    inspection: ContainerInspectionResult,
    schema: SchemaDefinition
  ): boolean {
    const identity = schema.identity;
    if (!identity) return true;

    const tableNamesLower = new Set(
      inspection.tables.map((t) => t.name.trim().toLowerCase())
    );

    const hasRequiredLegacyTabs =
      !identity.legacyRequiredTabs ||
      identity.legacyRequiredTabs.length === 0 ||
      identity.legacyRequiredTabs.every((t) => tableNamesLower.has(t.trim().toLowerCase()));

    if (
      identity.legacyMetaSheetNames &&
      identity.legacyMetaSheetNames.some((name) => tableNamesLower.has(name.trim().toLowerCase()))
    ) {
      return true;
    }

    if (
      identity.legacyPropertyMatchers &&
      identity.legacyPropertyMatchers.some(
        ({ key, value }) =>
          String(inspection.indexProperties[key] ?? '').trim().toLowerCase() ===
          value.trim().toLowerCase()
      ) &&
      hasRequiredLegacyTabs
    ) {
      return true;
    }

    // Handles a Drive-copied legacy v3 Quozen sheet that had _meta + _migrations before app_id existed
    if (inspection.hasMetaTable && inspection.hasMigrationsTable && hasRequiredLegacyTabs) {
      return true;
    }

    return false;
  }

  private async buildCanonicalManifestEntries(
    containerId: string,
    schema: SchemaDefinition,
    extraMeta?: Record<string, string>
  ): Promise<Record<string, string>> {
    const schemaHash = await computeSchemaHash(schema);
    return {
      ...(extraMeta || {}),
      [MANIFEST_KEYS.MANIFEST_VERSION]: QOZARA_MANIFEST_VERSION,
      ...(schema.identity
        ? {
            [MANIFEST_KEYS.APP_ID]: schema.identity.appId,
            [MANIFEST_KEYS.DOC_TYPE]: schema.identity.docType,
          }
        : {}),
      [MANIFEST_KEYS.SCHEMA_VERSION]: String(schema.version),
      [MANIFEST_KEYS.SCHEMA_HASH]: schemaHash,
      [MANIFEST_KEYS.ORIGIN_CONTAINER_ID]: containerId,
    };
  }

  private buildIndexProperties(
    schema: SchemaDefinition,
    status: ValidationStatus
  ): Record<string, string> {
    const props: Record<string, string> = {};
    if (schema.identity) {
      props.qozara_app = schema.identity.appId;
      props.qozara_doc_type = schema.identity.docType;
      if (schema.identity.legacyPropertyMatchers) {
        for (const { key, value } of schema.identity.legacyPropertyMatchers) {
          props[key] = value;
        }
      }
      props[`${schema.identity.appId}_validation_status`] = status;
      props[`${schema.identity.appId}_schema_version`] = String(schema.version);
      props[`${schema.identity.appId}_validation_time`] = new Date().toISOString();
    }
    return props;
  }

  async checkHealth(containerId: string, schema: SchemaDefinition): Promise<SchemaStatusDTO> {
    const inspection = await this.driver.inspectContainer(containerId, schema);
    const meta = inspection.metaEntries || {};
    const detectedAppId = meta[MANIFEST_KEYS.APP_ID]?.trim() || undefined;
    const detectedDocType = meta[MANIFEST_KEYS.DOC_TYPE]?.trim() || undefined;
    let isForkedCopy = false;

    if (schema.identity) {
      const expectedAppId = schema.identity.appId.trim().toLowerCase();
      const expectedDocType = schema.identity.docType.trim().toLowerCase();

      if (inspection.hasMetaTable && detectedAppId) {
        const normApp = detectedAppId.toLowerCase();
        const normDoc = detectedDocType?.toLowerCase();
        if (normApp !== expectedAppId || (normDoc && normDoc !== expectedDocType)) {
          return {
            spreadsheetId: containerId,
            containerId,
            currentVersion: 0,
            latestVersion: schema.version,
            status: ValidationStatus.FOREIGN_APP,
            valid: false,
            errors: [
              `Container belongs to "${detectedAppId}${detectedDocType ? `:${detectedDocType}` : ''}" instead of "${schema.identity.appId}:${schema.identity.docType}".`,
            ],
            missingTabs: [],
            missingColumns: {},
            canAutoMigrate: false,
            lastModifiedTime: inspection.lastModifiedTime,
            detectedAppId,
            detectedDocType,
            manifest: meta,
          };
        }

        const originId = meta[MANIFEST_KEYS.ORIGIN_CONTAINER_ID]?.trim();
        if (originId && originId !== containerId) {
          isForkedCopy = true;
        }
      } else {
        // Also check if another Qozara app owns the Drive index property
        const indexApp = inspection.indexProperties['qozara_app']?.trim().toLowerCase();
        const indexDocType = inspection.indexProperties['qozara_doc_type']?.trim().toLowerCase();
        if (indexApp && (indexApp !== expectedAppId || (indexDocType && indexDocType !== expectedDocType))) {
          return {
            spreadsheetId: containerId,
            containerId,
            currentVersion: 0,
            latestVersion: schema.version,
            status: ValidationStatus.FOREIGN_APP,
            valid: false,
            errors: [
              `Container index belongs to "${indexApp}${indexDocType ? `:${indexDocType}` : ''}" instead of "${schema.identity.appId}:${schema.identity.docType}".`,
            ],
            missingTabs: [],
            missingColumns: {},
            canAutoMigrate: false,
            lastModifiedTime: inspection.lastModifiedTime,
            detectedAppId: indexApp,
            detectedDocType: indexDocType,
            manifest: meta,
          };
        }

        if (!this.hasVerifiedLegacyProvenance(inspection, schema)) {
          return {
            spreadsheetId: containerId,
            containerId,
            currentVersion: 0,
            latestVersion: schema.version,
            status: ValidationStatus.UNMANAGED,
            valid: false,
            errors: ['Spreadsheet is not managed by this application (missing _meta manifest).'],
            missingTabs: [],
            missingColumns: {},
            canAutoMigrate: false,
            lastModifiedTime: inspection.lastModifiedTime,
            manifest: meta,
          };
        }
      }
    }

    // Resolve current schema version from _migrations and _meta
    let maxVersion: number | null = null;
    for (const v of inspection.migrationVersions) {
      if (Number.isFinite(v) && (maxVersion === null || v > maxVersion)) {
        maxVersion = v;
      }
    }
    const metaVersion = parseInt(meta[MANIFEST_KEYS.SCHEMA_VERSION] ?? '', 10);
    if (!Number.isNaN(metaVersion) && (maxVersion === null || metaVersion > maxVersion)) {
      maxVersion = metaVersion;
    }

    const currentVersion =
      maxVersion !== null ? maxVersion : inspection.tables.length > 0 ? 1 : 0;

    if (currentVersion > schema.version) {
      return {
        spreadsheetId: containerId,
        containerId,
        currentVersion,
        latestVersion: schema.version,
        status: ValidationStatus.INCOMPATIBLE,
        valid: false,
        errors: [
          `Container schema version (${currentVersion}) is newer than supported (${schema.version}).`,
        ],
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: false,
        lastModifiedTime: inspection.lastModifiedTime,
        isForkedCopy,
        detectedAppId,
        detectedDocType,
        manifest: meta,
      };
    }

    if (currentVersion < schema.version) {
      return {
        spreadsheetId: containerId,
        containerId,
        currentVersion,
        latestVersion: schema.version,
        status: ValidationStatus.UPGRADE_REQUIRED,
        valid: false,
        errors: [`Container schema version (${currentVersion}) requires upgrade to ${schema.version}.`],
        missingTabs: [],
        missingColumns: {},
        canAutoMigrate: true,
        lastModifiedTime: inspection.lastModifiedTime,
        isForkedCopy,
        detectedAppId,
        detectedDocType,
        manifest: meta,
      };
    }

    // Structural tab & column validation
    const tableMap = new Map<string, { name: string; headers: Set<string> }>();
    for (const t of inspection.tables) {
      const normalizedHeaders = new Set(
        (t.headers || []).map((h) => String(h).trim().toLowerCase()).filter(Boolean)
      );
      tableMap.set(t.name.trim().toLowerCase(), {
        name: t.name,
        headers: normalizedHeaders,
      });
    }

    const missingTabs: string[] = [];
    const missingColumns: Record<string, string[]> = {};
    const errors: string[] = [];

    for (const tab of schema.tabs) {
      const existing = tableMap.get(tab.name.trim().toLowerCase());
      if (!existing) {
        missingTabs.push(tab.name);
        errors.push(`Tab "${tab.name}" is missing`);
        continue;
      }

      const tabMissing: string[] = [];
      for (const col of tab.columns) {
        if (col.required === false) continue;
        if (!existing.headers.has(col.name.trim().toLowerCase())) {
          tabMissing.push(col.name);
          errors.push(`Tab "${tab.name}" is missing column "${col.name}"`);
        }
      }
      if (tabMissing.length > 0) {
        missingColumns[tab.name] = tabMissing;
      }
    }

    const isCorrupted =
      missingTabs.length > 0 || Object.keys(missingColumns).length > 0;

    return {
      spreadsheetId: containerId,
      containerId,
      currentVersion,
      latestVersion: schema.version,
      status: isCorrupted ? ValidationStatus.CORRUPTED : ValidationStatus.READY,
      valid: !isCorrupted,
      errors,
      missingTabs,
      missingColumns,
      canAutoMigrate: false,
      lastModifiedTime: inspection.lastModifiedTime,
      isForkedCopy,
      detectedAppId,
      detectedDocType,
      manifest: meta,
    };
  }

  private assertMutableHealth(health: SchemaStatusDTO, operation: 'migrate' | 'repair'): void {
    if (health.status === ValidationStatus.FOREIGN_APP) {
      throw new ForeignDocumentError(
        undefined,
        health.detectedAppId,
        health.detectedDocType
      );
    }
    if (health.status === ValidationStatus.UNMANAGED) {
      throw new UnmanagedDocumentError(
        health.spreadsheetId,
        `Cannot ${operation} unmanaged spreadsheet: missing required _meta manifest.`
      );
    }
    if (health.status === ValidationStatus.INCOMPATIBLE) {
      throw new SchemaIncompatibleError(
        `Cannot ${operation} spreadsheet: the schema is from a newer version of the application.`
      );
    }
  }

  async repair(
    containerId: string,
    schema: SchemaDefinition,
    options?: LifecycleOptions | SchemaMigration[],
    migrations?: SchemaMigration[]
  ): Promise<{ backupFileId: string }> {
    let actualOptions: LifecycleOptions = {};
    let actualMigrations: SchemaMigration[] = [];

    if (Array.isArray(options)) {
      actualMigrations = options;
      if (migrations && !Array.isArray(migrations)) {
        actualOptions = migrations as LifecycleOptions;
      }
    } else {
      if (options) {
        actualOptions = { ...options };
        if (options.migrations) actualMigrations = options.migrations;
      }
      if (Array.isArray(migrations)) {
        actualMigrations = migrations;
      }
    }

    let health = await this.checkHealth(containerId, schema);
    this.assertMutableHealth(health, 'repair');
    this.assertNoConcurrencyConflict(health.lastModifiedTime, actualOptions.expectedLastModified);

    let backupId = '';
    if (health.status === ValidationStatus.UPGRADE_REQUIRED) {
      const migRes = await this.migrate(containerId, schema, actualMigrations, actualOptions);
      backupId = migRes.backupFileId;
      health = await this.checkHealth(containerId, schema);
      if (health.status === ValidationStatus.READY) {
        return { backupFileId: backupId };
      }
      this.assertMutableHealth(health, 'repair');
    }

    if (health.status === ValidationStatus.READY) {
      if (health.isForkedCopy) {
        await this.healForkedCopy(containerId, schema);
      }
      return { backupFileId: backupId };
    }

    if (!backupId && actualOptions.createBackup !== false) {
      backupId = await this.driver.createBackup(containerId, actualOptions.customBackupName);
    }

    try {
      for (const tabName of health.missingTabs) {
        const tabDef = schema.tabs.find((t) => t.name === tabName);
        if (!tabDef) continue;
        await this.driver.ensureTable(containerId, {
          name: tabDef.name,
          headers: tabDef.columns.map((c) => c.name),
          frozenHeaderRow: true,
        });
      }

      for (const [tabName, cols] of Object.entries(health.missingColumns)) {
        if (cols.length > 0) {
          await this.driver.addColumns(containerId, tabName, cols);
        }
      }

      const manifestEntries = await this.buildCanonicalManifestEntries(
        containerId,
        schema,
        actualOptions.extraMeta
      );
      await this.driver.writeMeta(containerId, manifestEntries, {
        hidden: true,
        protectWarning: DEFAULT_META_PROTECT_WARNING,
      });

      const finalHealth = await this.checkHealth(containerId, schema);
      if (finalHealth.status !== ValidationStatus.READY) {
        throw new Error(`Repair failed: schema is still ${finalHealth.status}`);
      }

      if (this.driver.syncIndexMetadata) {
        await this.driver
          .syncIndexMetadata(containerId, this.buildIndexProperties(schema, ValidationStatus.READY))
          .catch(() => {});
      }

      if (backupId && !actualOptions.keepBackup) {
        await this.driver.deleteBackup(backupId).catch(() => {});
      }

      return { backupFileId: backupId };
    } catch (repairError) {
      if (backupId) {
        await this.driver.restoreBackup(backupId, containerId).catch(() => {});
      }
      throw repairError;
    }
  }

  async migrate(
    containerId: string,
    schema: SchemaDefinition,
    migrations: SchemaMigration[],
    options?: LifecycleOptions
  ): Promise<{ success: boolean; applied: number[]; backupFileId: string }> {
    const health = await this.checkHealth(containerId, schema);
    this.assertMutableHealth(health, 'migrate');
    this.assertNoConcurrencyConflict(health.lastModifiedTime, options?.expectedLastModified);

    let backupId = '';
    if (options?.createBackup !== false) {
      backupId = await this.driver.createBackup(containerId, options?.customBackupName);
    }

    const clientUuid =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).substring(2) + Date.now().toString(36);

    let lockAcquired = false;
    try {
      await this.driver.acquireLock(containerId, clientUuid);
      lockAcquired = true;

      const sortedMigrations = [...migrations].sort((a, b) => a.version - b.version);
      const pendingMigrations = sortedMigrations.filter((m) => m.version > health.currentVersion);

      await this.driver.ensureMigrationsTable(
        containerId,
        health.currentVersion > 0 && pendingMigrations.length === 0
          ? health.currentVersion
          : undefined
      );

      const migrationCtx = this.createMigrationContext(containerId);
      const nativeClient = this.driver.getNativeClient ? this.driver.getNativeClient() : undefined;
      const applied: number[] = [];

      for (const migration of pendingMigrations) {
        await migration.up(nativeClient, containerId, migrationCtx);
        await this.driver.appendMigrationRecord(
          containerId,
          migration.version,
          new Date().toISOString()
        );
        applied.push(migration.version);
      }

      const manifestEntries = await this.buildCanonicalManifestEntries(
        containerId,
        schema,
        options?.extraMeta
      );
      await this.driver.writeMeta(containerId, manifestEntries, {
        hidden: true,
        protectWarning: DEFAULT_META_PROTECT_WARNING,
      });

      if (this.driver.syncIndexMetadata) {
        await this.driver
          .syncIndexMetadata(containerId, this.buildIndexProperties(schema, ValidationStatus.READY))
          .catch(() => {});
      }

      if (backupId && !options?.keepBackup) {
        await this.driver.deleteBackup(backupId).catch(() => {});
      }

      return { success: true, applied, backupFileId: backupId };
    } catch (migrationError) {
      if (backupId) {
        await this.driver.restoreBackup(backupId, containerId).catch(() => {});
      }
      throw migrationError;
    } finally {
      if (lockAcquired) {
        await this.driver.releaseLock(containerId, clientUuid).catch(() => {});
      }
    }
  }

  async initializeFile(
    containerId: string,
    schema: SchemaDefinition,
    extraMeta?: Record<string, string>
  ): Promise<void> {
    const manifestEntries = await this.buildCanonicalManifestEntries(containerId, schema, extraMeta);
    await this.driver.writeMeta(containerId, manifestEntries, {
      hidden: true,
      protectWarning: DEFAULT_META_PROTECT_WARNING,
    });
    await this.driver.ensureMigrationsTable(containerId, schema.version);
    if (this.driver.syncIndexMetadata) {
      await this.driver
        .syncIndexMetadata(containerId, this.buildIndexProperties(schema, ValidationStatus.READY))
        .catch(() => {});
    }
  }

  async healForkedCopy(
    containerId: string,
    schema: SchemaDefinition,
    extraMeta?: Record<string, string>
  ): Promise<SchemaStatusDTO> {
    const health = await this.checkHealth(containerId, schema);
    if (health.status === ValidationStatus.FOREIGN_APP) {
      throw new ForeignDocumentError(undefined, health.detectedAppId, health.detectedDocType);
    }
    if (health.status === ValidationStatus.UNMANAGED) {
      throw new UnmanagedDocumentError(containerId);
    }

    const updates: Record<string, string> = {
      ...(extraMeta || {}),
      [MANIFEST_KEYS.MANIFEST_VERSION]: QOZARA_MANIFEST_VERSION,
      [MANIFEST_KEYS.ORIGIN_CONTAINER_ID]: containerId,
    };
    if (schema.identity) {
      updates[MANIFEST_KEYS.APP_ID] = schema.identity.appId;
      updates[MANIFEST_KEYS.DOC_TYPE] = schema.identity.docType;
    }

    await this.driver.writeMeta(containerId, updates, {
      hidden: true,
      protectWarning: DEFAULT_META_PROTECT_WARNING,
    });

    if (this.driver.syncIndexMetadata) {
      await this.driver
        .syncIndexMetadata(containerId, this.buildIndexProperties(schema, health.status))
        .catch(() => {});
    }

    return {
      ...health,
      isForkedCopy: false,
    };
  }
}
