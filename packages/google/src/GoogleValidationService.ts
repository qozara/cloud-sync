import {
  ConflictError,
  SchemaEngine,
  SchemaIncompatibleError,
  ValidationStatus,
  type LifecycleOptions,
  type SchemaDefinition,
  type SchemaMigration,
  type SchemaStatusDTO,
} from '@qozara/cloud-sync';
import { GoogleSheetsContainerDriver } from './GoogleSheetsContainerDriver.js';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';
import type { GoogleHttpClient } from './googleTypes.js';

export { ValidationStatus };

export interface ValidationServiceOptions {
  httpClient?: GoogleHttpClient;
  defaultSchema?: SchemaDefinition;
  migrations?: SchemaMigration[];
  appPropertyPrefix?: string;
  defaultFileType?: string;
  requireTokenOnConstruct?: boolean;
}

function isGoogleHttpClient(value: unknown): value is GoogleHttpClient {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'fetch' in value &&
      typeof (value as GoogleHttpClient).fetch === 'function'
  );
}

export class GoogleValidationService {
  private static inFlightMigrations = new Map<string, Promise<{ backupFileId: string }>>();

  public client: GoogleSheetsFetchClient;
  public containerDriver: GoogleSheetsContainerDriver;
  public engine: SchemaEngine;

  private getToken: () => string | null;
  private httpClient?: GoogleHttpClient;
  private defaultSchema?: SchemaDefinition;
  private migrations: SchemaMigration[];
  private appPropertyPrefix: string;
  private defaultFileType?: string;

  constructor(
    getToken: () => string | null,
    httpClientOrOptions?: GoogleHttpClient | ValidationServiceOptions
  ) {
    this.getToken = getToken;
    const options: ValidationServiceOptions = isGoogleHttpClient(httpClientOrOptions)
      ? { httpClient: httpClientOrOptions }
      : (httpClientOrOptions ?? {});

    if (options.requireTokenOnConstruct) {
      const token = this.getToken();
      if (!token) {
        throw new Error('ValidationService requires a valid Google access token.');
      }
    }

    this.httpClient = options.httpClient;
    this.defaultSchema = options.defaultSchema;
    this.migrations = options.migrations ?? [];
    this.appPropertyPrefix = options.appPropertyPrefix ?? 'quomida';
    this.defaultFileType = options.defaultFileType;

    const fetchImpl: typeof fetch = this.httpClient
      ? (this.httpClient.fetch.bind(this.httpClient) as typeof fetch)
      : (url: string | Request | URL, init?: RequestInit) => {
          const finalInit = init ? { ...init } : {};
          if (finalInit.method === 'GET' && finalInit.headers) {
            const headers = new Headers(finalInit.headers as HeadersInit);
            headers.delete('Content-Type');
            finalInit.headers = headers;
          }
          return globalThis.fetch(url, finalInit);
        };

    this.client = new GoogleSheetsFetchClient({
      accessToken: this.getToken,
      fetchImpl,
    });
    this.containerDriver = new GoogleSheetsContainerDriver(this.client);
    this.engine = new SchemaEngine(this.containerDriver);
  }

  private ensureToken(): void {
    if (!this.getToken()) {
      throw new Error('ValidationService requires a valid Google access token.');
    }
  }

  public async createBackup(spreadsheetId: string, customName?: string): Promise<string> {
    this.ensureToken();
    return this.client.createBackup(spreadsheetId, customName);
  }

  public async initializeFile(
    spreadsheetId: string,
    versionOrSchema?: number | SchemaDefinition,
    extraMeta?: Record<string, string>
  ): Promise<void> {
    this.ensureToken();
    const targetSchema: SchemaDefinition =
      typeof versionOrSchema === 'object'
        ? versionOrSchema
        : this.defaultSchema
          ? {
              ...this.defaultSchema,
              version: typeof versionOrSchema === 'number' ? versionOrSchema : this.defaultSchema.version,
            }
          : {
              version: typeof versionOrSchema === 'number' ? versionOrSchema : 1,
              tabs: [],
            };

    await this.engine.initializeFile(spreadsheetId, targetSchema, extraMeta);
    await this.updateFileMetadata(spreadsheetId, ValidationStatus.READY, targetSchema.version);
  }

  public async updateFileMetadata(
    spreadsheetId: string,
    status: ValidationStatus,
    schemaVersion?: number
  ): Promise<void> {
    const version = schemaVersion ?? this.defaultSchema?.version ?? 1;
    const prefix = this.appPropertyPrefix;
    const appProperties: Record<string, string> = {
      [`${prefix}_validation_status`]: status,
      [`${prefix}_validation_time`]: new Date().toISOString(),
      [`${prefix}_schema_version`]: String(version),
    };
    const publicProperties: Record<string, string> = {};

    if (this.defaultFileType) {
      appProperties[`${prefix}_type`] = this.defaultFileType;
      appProperties.version = '1.0';
      if (prefix === 'quozen') {
        publicProperties.quozen_type = this.defaultFileType;
      }
    }
    if (this.defaultSchema?.identity) {
      publicProperties.qozara_app = this.defaultSchema.identity.appId;
      publicProperties.qozara_doc_type = this.defaultSchema.identity.docType;
      appProperties.qozara_app = this.defaultSchema.identity.appId;
      appProperties.qozara_doc_type = this.defaultSchema.identity.docType;
    }

    await this.client
      .updateFileProperties(spreadsheetId, {
        ...(Object.keys(publicProperties).length > 0 ? { properties: publicProperties } : {}),
        appProperties,
      })
      .catch(() => {});
  }

  public async checkHealth(
    spreadsheetId: string,
    schema?: SchemaDefinition
  ): Promise<SchemaStatusDTO & { valid: boolean; errors: string[]; lastModifiedTime: string }> {
    const targetSchema = schema ?? this.defaultSchema;
    if (!targetSchema) {
      throw new Error('ValidationService.checkHealth requires a SchemaDefinition.');
    }

    this.ensureToken();
    const result = await this.engine.checkHealth(spreadsheetId, targetSchema);
    return {
      ...result,
      valid: result.valid ?? result.status === ValidationStatus.READY,
      errors: result.errors ?? [],
      lastModifiedTime: result.lastModifiedTime || new Date().toISOString(),
    };
  }

  public async healForkedCopy(
    spreadsheetId: string,
    schema?: SchemaDefinition,
    extraMeta?: Record<string, string>
  ): Promise<SchemaStatusDTO> {
    const targetSchema = schema ?? this.defaultSchema;
    if (!targetSchema) {
      throw new Error('ValidationService.healForkedCopy requires a SchemaDefinition.');
    }
    this.ensureToken();
    const res = await this.engine.healForkedCopy(spreadsheetId, targetSchema, extraMeta);
    await this.updateFileMetadata(spreadsheetId, res.status, res.currentVersion || targetSchema.version);
    return res;
  }

  public async repairFile(
    spreadsheetId: string,
    schemaOrExpectedLastModified?: SchemaDefinition | string,
    expectedLastModified?: string,
    lifecycleOptions?: LifecycleOptions
  ): Promise<{ backupFileId: string }> {
    const schema =
      typeof schemaOrExpectedLastModified === 'object'
        ? schemaOrExpectedLastModified
        : this.defaultSchema;
    const expectedMod =
      typeof schemaOrExpectedLastModified === 'string'
        ? schemaOrExpectedLastModified
        : expectedLastModified;

    if (!schema) {
      throw new Error('ValidationService.repairFile requires a SchemaDefinition.');
    }

    this.ensureToken();

    try {
      const result = await this.engine.repair(
        spreadsheetId,
        schema,
        {
          ...(lifecycleOptions || {}),
          ...(expectedMod ? { expectedLastModified: expectedMod } : {}),
          migrations: lifecycleOptions?.migrations ?? this.migrations,
        },
        this.migrations
      );
      await this.updateFileMetadata(spreadsheetId, ValidationStatus.READY, schema.version);
      return result;
    } catch (e: any) {
      if (e instanceof ConflictError || e?.name === 'ConflictError') {
        throw e;
      }
      if (e instanceof SchemaIncompatibleError || e?.name === 'SchemaIncompatibleError') {
        throw e;
      }
      if (e?.message?.toLowerCase().includes('incompatible')) {
        throw new SchemaIncompatibleError(
          'Cannot repair spreadsheet: the schema is from a newer version of the application.'
        );
      }
      throw e;
    }
  }

  public async migrateFile(
    spreadsheetId: string,
    schemaOrExpectedLastModified?: SchemaDefinition | string,
    migrations?: SchemaMigration[],
    expectedLastModified?: string,
    lifecycleOptions?: LifecycleOptions
  ): Promise<{ backupFileId: string }> {
    const schema =
      typeof schemaOrExpectedLastModified === 'object'
        ? schemaOrExpectedLastModified
        : this.defaultSchema;
    const targetMigrations =
      typeof schemaOrExpectedLastModified === 'object'
        ? (migrations ?? this.migrations)
        : this.migrations;
    const expectedMod =
      typeof schemaOrExpectedLastModified === 'string'
        ? schemaOrExpectedLastModified
        : expectedLastModified;

    if (!schema) {
      throw new Error('ValidationService.migrateFile requires a SchemaDefinition.');
    }

    this.ensureToken();

    const inFlight = GoogleValidationService.inFlightMigrations.get(spreadsheetId);
    if (inFlight) {
      return inFlight;
    }

    const migrationPromise = (async (): Promise<{ backupFileId: string }> => {
      try {
        const result = await this.engine.migrate(spreadsheetId, schema, targetMigrations, {
          ...(lifecycleOptions || {}),
          ...(expectedMod ? { expectedLastModified: expectedMod } : {}),
        });
        await this.updateFileMetadata(spreadsheetId, ValidationStatus.READY, schema.version);
        return { backupFileId: result.backupFileId };
      } catch (e: any) {
        if (e instanceof SchemaIncompatibleError || e?.name === 'SchemaIncompatibleError') {
          throw e;
        }
        if (e?.message?.toLowerCase().includes('incompatible')) {
          throw new SchemaIncompatibleError(
            'Cannot migrate spreadsheet: the schema is from a newer version of the application.'
          );
        }
        throw e;
      }
    })();

    GoogleValidationService.inFlightMigrations.set(spreadsheetId, migrationPromise);
    try {
      return await migrationPromise;
    } finally {
      GoogleValidationService.inFlightMigrations.delete(spreadsheetId);
    }
  }
}

export { GoogleValidationService as ValidationService };
