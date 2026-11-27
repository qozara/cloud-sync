export enum ValidationStatus {
  READY = 'READY',
  UPGRADE_REQUIRED = 'UPGRADE_REQUIRED',
  CORRUPTED = 'CORRUPTED',
  INCOMPATIBLE = 'INCOMPATIBLE',
  UNMANAGED = 'UNMANAGED',
  FOREIGN_APP = 'FOREIGN_APP',
}

export const QOZARA_MANIFEST_VERSION = '1';

export const MANIFEST_KEYS = {
  MANIFEST_VERSION: 'qozara_manifest_version',
  APP_ID: 'app_id',
  DOC_TYPE: 'doc_type',
  SCHEMA_VERSION: 'schema_version',
  SCHEMA_HASH: 'schema_hash',
  ORIGIN_CONTAINER_ID: 'origin_container_id',
} as const;

export interface SchemaIdentity {
  appId: string;
  docType: string;
  legacyMetaSheetNames?: string[];
  legacyPropertyMatchers?: Array<{ key: string; value: string }>;
  legacyRequiredTabs?: string[];
}

export interface ColumnDefinition {
  name: string;
  type?: 'string' | 'number' | 'boolean' | 'integer';
  required?: boolean;
}

export interface TabDefinition {
  name: string;
  columns: ColumnDefinition[];
}

export interface SchemaDefinition {
  version: number;
  identity?: SchemaIdentity;
  tabs: TabDefinition[];
}

export interface SchemaStatusDTO {
  spreadsheetId: string;
  containerId?: string;
  currentVersion: number;
  latestVersion: number;
  status: ValidationStatus;
  valid?: boolean;
  errors?: string[];
  missingTabs: string[];
  missingColumns: Record<string, string[]>;
  canAutoMigrate: boolean;
  lastModifiedTime?: string;
  isForkedCopy?: boolean;
  detectedAppId?: string;
  detectedDocType?: string;
  manifest?: Record<string, string>;
}

export interface ContainerTableInfo {
  id?: string | number;
  name: string;
  headers?: string[];
}

export interface ContainerInspectionResult {
  containerId: string;
  title?: string;
  lastModifiedTime?: string;
  tables: ContainerTableInfo[];
  metaEntries: Record<string, string>;
  hasMetaTable: boolean;
  migrationVersions: number[];
  hasMigrationsTable: boolean;
  indexProperties: Record<string, string>;
}

export interface EnsureTableOptions {
  name: string;
  headers?: string[];
  hidden?: boolean;
  protectWarning?: string;
  frozenHeaderRow?: boolean;
}

export interface WriteMetaOptions {
  hidden?: boolean;
  protectWarning?: string;
}

export interface ITabularContainerDriver {
  inspectContainer(containerId: string, schema: SchemaDefinition): Promise<ContainerInspectionResult>;
  ensureTable(containerId: string, table: EnsureTableOptions): Promise<void>;
  addColumns(containerId: string, tableName: string, columns: string[]): Promise<void>;
  readMeta(containerId: string): Promise<Record<string, string>>;
  writeMeta(
    containerId: string,
    entries: Record<string, string>,
    options?: WriteMetaOptions
  ): Promise<void>;
  ensureMigrationsTable(
    containerId: string,
    initialVersion?: number
  ): Promise<void>;
  appendMigrationRecord(
    containerId: string,
    version: number,
    migratedAt: string
  ): Promise<void>;
  createBackup(containerId: string, customName?: string): Promise<string>;
  restoreBackup(backupId: string, containerId: string): Promise<void>;
  deleteBackup(backupId: string): Promise<void>;
  acquireLock(containerId: string, clientUuid: string, ttlMs?: number): Promise<boolean>;
  releaseLock(containerId: string, clientUuid: string): Promise<boolean>;
  syncIndexMetadata?(containerId: string, properties: Record<string, string>): Promise<void>;
  getNativeClient?<T = unknown>(): T;
}

export interface TabularMigrationContext {
  driver: ITabularContainerDriver;
  containerId: string;
  ensureTable: (table: EnsureTableOptions) => Promise<void>;
  addColumns: (tableName: string, columns: string[]) => Promise<void>;
  readMeta: () => Promise<Record<string, string>>;
  writeMeta: (entries: Record<string, string>, options?: WriteMetaOptions) => Promise<void>;
  getNativeClient: <T = unknown>() => T | undefined;
}

export interface SchemaMigration {
  version: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  up: (client: any, containerId: string, ctx?: TabularMigrationContext) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  down?: (client: any, containerId: string, ctx?: TabularMigrationContext) => Promise<any>;
}

export type Migration = SchemaMigration;

export interface LifecycleOptions {
  createBackup?: boolean;
  customBackupName?: string;
  migrations?: SchemaMigration[];
  keepBackup?: boolean;
  expectedLastModified?: string;
  extraMeta?: Record<string, string>;
}
