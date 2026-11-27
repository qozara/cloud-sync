import {
  ForeignDocumentError,
  TableNotFoundError,
  UnmanagedDocumentError,
  ValidationStatus,
  type SchemaDefinition,
  type SchemaMigration,
  type SchemaStatusDTO,
  type TabDefinition,
  type TabularRow,
  type TabularStorageDriver,
} from '@qozara/cloud-sync';
import {
  GoogleValidationService,
  type ValidationServiceOptions,
} from './GoogleValidationService.js';
import type { GoogleDriverOptions, GoogleHttpClient } from './googleTypes.js';
import type { IStorageLayer } from './IStorageLayer.js';

export function columnIndexToA1(index: number): string {
  let n = index;
  let col = '';
  while (n >= 0) {
    col = String.fromCharCode((n % 26) + 65) + col;
    n = Math.floor(n / 26) - 1;
  }
  return col;
}

export interface GoogleSheetsTabularDriverOptions extends GoogleDriverOptions {
  defaultSchema?: SchemaDefinition;
  schemasByDocType?: Record<string, SchemaDefinition>;
  migrationsByDocType?: Record<string, SchemaMigration[]>;
  migrations?: SchemaMigration[];
  docTypeResolver?: (
    title: string,
    tabs: string[]
  ) => { docType: string; schema?: SchemaDefinition };
  tabMatcher?: (tabTitles: string[]) => SchemaDefinition | undefined;
  appId?: string;
  appPropertyDocTypeKey?: string;
  docTypesForLinks?: string[];
  metaSheetName?: string;
  metaBannerText?: string;
  metaDescription?: string;
  autoCreateMissingTabOnWrite?: boolean;
  throwTableNotFoundError?: boolean;
  filterEmptyRows?: boolean;
  caseInsensitiveHeaders?: boolean;
  headerAliases?: Record<string, string>;
  validationService?: GoogleValidationService;
  validationServiceFactory?: (
    getToken: () => string | null,
    httpClient?: GoogleHttpClient,
    options?: Partial<ValidationServiceOptions>
  ) => GoogleValidationService;
}

interface ColumnSpan {
  startCol: number;
  endCol: number;
  sourceIndices: number[];
}

export class GoogleSheetsTabularDriver implements TabularStorageDriver {
  id = 'google-sheets-tabular';
  name = 'Google Sheets Tabular Driver';

  public readonly storageLayer?: IStorageLayer;

  protected getAccessToken: () => string | null;
  protected client: GoogleHttpClient;
  protected validationService?: GoogleValidationService;
  protected validationServiceFactory?: GoogleSheetsTabularDriverOptions['validationServiceFactory'];
  protected documentSchemas: Map<string, SchemaDefinition> = new Map();
  protected liveHeadersCache: Map<string, string[]> = new Map();
  protected options: GoogleSheetsTabularDriverOptions;

  constructor(options: GoogleSheetsTabularDriverOptions) {
    this.options = options;
    this.getAccessToken = options.getAccessToken;
    this.storageLayer = options.storageLayer;
    this.client = options.httpClient || {
      fetch: (url, init) => globalThis.fetch(url, init),
    };
    this.validationServiceFactory = options.validationServiceFactory;
    this.validationService = options.validationService;
  }

  async getRemoteLinks(): Promise<string[]> {
    const linkSet = new Set<string>();

    for (const docId of this.documentSchemas.keys()) {
      linkSet.add(`https://docs.google.com/spreadsheets/d/${docId}/edit`);
    }

    try {
      const headers = this.getAuthHeaders();
      const appId = this.options.appId ?? this.options.defaultSchema?.identity?.appId;
      const docTypeKey = this.options.appPropertyDocTypeKey ?? 'quomida_doc_type';
      const docTypes = this.options.docTypesForLinks ?? ['daily_logs', 'food_catalog'];

      for (const docType of docTypes) {
        const queries: string[] = [];
        if (appId) {
          queries.push(
            `properties has { key='qozara_app' and value='${appId}' } and properties has { key='qozara_doc_type' and value='${docType}' } and trashed = false`
          );
        }
        queries.push(
          `appProperties has { key='${docTypeKey}' and value='${docType}' } and trashed = false`
        );

        for (const rawQuery of queries) {
          const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(rawQuery)}&fields=files(id)`;
          const res = await this.client.fetch(searchUrl, { method: 'GET', headers });
          if (res.ok) {
            const json = (await res.json()) as any;
            if (json.files && json.files.length > 0) {
              linkSet.add(`https://docs.google.com/spreadsheets/d/${json.files[0].id}/edit`);
              break;
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to resolve remote links via Google Drive API:', e);
    }
    return Array.from(linkSet);
  }

  protected getAuthHeaders(): Record<string, string> {
    const token = this.getAccessToken();
    if (!token) {
      throw new Error('Google Auth Failed: Access token is missing or expired');
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  protected async handleResponseErrors(res: Response, context: string): Promise<void> {
    if (!res.ok) {
      let errText = '';
      try {
        errText = await res.text();
      } catch {
        // Ignore read error
      }

      if (res.status === 401 || res.status === 403) {
        let isQuotaExceeded = false;
        try {
          const json = JSON.parse(errText);
          if (json.error?.errors?.[0]?.reason === 'storageQuotaExceeded') {
            isQuotaExceeded = true;
          }
        } catch {
          // Ignore parse error
        }

        if (isQuotaExceeded) {
          throw new Error(
            `Google Drive Storage Quota Exceeded (403) during ${context}. Please free up space in your Google account.`
          );
        }
        const error: any = new Error(
          `Google Auth Failed (${res.status}) during ${context}. Details: ${errText}`
        );
        error.status = res.status;
        throw error;
      }
      if (res.status === 404) {
        for (const docId of Array.from(this.documentSchemas.keys())) {
          if (context.includes(docId)) {
            this.documentSchemas.delete(docId);
          }
        }
      }
      if (res.status === 429) {
        throw new Error(
          `Google Sheets API Rate Limit / Quota Exceeded (429) during ${context}`
        );
      }
      throw new Error(
        `Google Sheets API Error (${res.status}) during ${context}. Details: ${errText}`
      );
    }
  }

  protected isMissingSheetError(status: number, message: string, tabName: string): boolean {
    const lowerMsg = message.toLowerCase();
    const lowerTab = tabName.toLowerCase();
    return (
      (status === 400 || status === 404) &&
      (lowerMsg.includes('unable to parse range') || lowerMsg.includes('not found')) &&
      lowerMsg.includes(lowerTab)
    );
  }

  invalidateDocument(documentId: string): void {
    this.documentSchemas.delete(documentId);
    for (const key of Array.from(this.liveHeadersCache.keys())) {
      if (key.startsWith(`${documentId}:`)) {
        this.liveHeadersCache.delete(key);
      }
    }
  }

  protected async resolveSchemaForDocument(documentId: string): Promise<SchemaDefinition | undefined> {
    if (this.documentSchemas.has(documentId)) {
      return this.documentSchemas.get(documentId);
    }

    if (this.options.defaultSchema && !this.options.tabMatcher && !this.options.schemasByDocType) {
      return this.options.defaultSchema;
    }

    try {
      const headers = this.getAuthHeaders();
      const res = await this.client.fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${documentId}?fields=sheets(properties(title))`,
        { headers }
      );
      if (res.ok) {
        const json = (await res.json()) as any;
        const tabTitles = (json.sheets || []).map((s: any) => s.properties?.title as string);
        if (this.options.tabMatcher) {
          const matched = this.options.tabMatcher(tabTitles);
          if (matched) {
            this.documentSchemas.set(documentId, matched);
            return matched;
          }
        }
        if (this.options.schemasByDocType) {
          for (const candidateSchema of Object.values(this.options.schemasByDocType)) {
            if (candidateSchema.tabs.some((t) => tabTitles.includes(t.name))) {
              this.documentSchemas.set(documentId, candidateSchema);
              return candidateSchema;
            }
          }
        }
      }
    } catch {
      // Fall back to defaultSchema
    }

    return this.options.defaultSchema;
  }

  private resolveMigrationsForSchema(schema?: SchemaDefinition): SchemaMigration[] {
    const docType = schema?.identity?.docType;
    if (docType && this.options.migrationsByDocType?.[docType]) {
      return this.options.migrationsByDocType[docType];
    }
    return this.options.migrations ?? [];
  }

  async ensureDocument(title: string, tabs: string[]): Promise<string> {
    const headers = this.getAuthHeaders();
    const docTypeKey = this.options.appPropertyDocTypeKey ?? 'quomida_doc_type';

    const resolvedDocType = this.options.docTypeResolver
      ? this.options.docTypeResolver(title, tabs)
      : {
          docType:
            tabs.includes('daily_logs') || title.includes('Daily Logs')
              ? 'daily_logs'
              : 'food_catalog',
          schema:
            this.options.schemasByDocType?.[
              tabs.includes('daily_logs') || title.includes('Daily Logs')
                ? 'daily_logs'
                : 'food_catalog'
            ] ?? this.options.defaultSchema,
        };

    const { docType, schema } = resolvedDocType;
    const appId = this.options.appId ?? schema?.identity?.appId;

    let docId: string | null = null;

    // 1. Query standardized public properties (survives across clients)
    if (appId) {
      const propQuery = encodeURIComponent(
        `properties has { key='qozara_app' and value='${appId}' } and properties has { key='qozara_doc_type' and value='${docType}' } and trashed = false`
      );
      const propRes = await this.client.fetch(
        `https://www.googleapis.com/drive/v3/files?q=${propQuery}&fields=files(id,name)`,
        { method: 'GET', headers }
      );
      if (propRes.ok) {
        const propJson = (await propRes.json()) as any;
        if (propJson.files && propJson.files.length > 0) {
          docId = propJson.files[0].id;
        }
      }
    }

    // 2. Query legacy appProperties
    if (!docId) {
      const query = encodeURIComponent(
        `appProperties has { key='${docTypeKey}' and value='${docType}' } and trashed = false`
      );
      const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`;
      const searchRes = await this.client.fetch(searchUrl, { method: 'GET', headers });
      await this.handleResponseErrors(searchRes, `searching spreadsheet metadata "${docType}"`);
      const searchJson = (await searchRes.json()) as any;
      if (searchJson.files && searchJson.files.length > 0) {
        docId = searchJson.files[0].id;
      }
    }

    // 3. Safe title fallback: verify _meta / legacy provenance BEFORE touching any candidate file
    if (!docId) {
      const titleQuery = encodeURIComponent(
        `name = '${title}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`
      );
      const titleSearchUrl = `https://www.googleapis.com/drive/v3/files?q=${titleQuery}&fields=files(id,name)`;
      const titleRes = await this.client.fetch(titleSearchUrl, { method: 'GET', headers });
      if (titleRes.ok) {
        const titleJson = (await titleRes.json()) as any;
        const candidates: Array<{ id: string; name?: string }> = titleJson.files || [];
        const svc = this.getValidationServiceInstance(schema);
        for (const candidate of candidates) {
          try {
            const health = schema
              ? await svc.checkHealth(candidate.id, schema)
              : await svc.checkHealth(candidate.id);
            if (
              health.status === ValidationStatus.UNMANAGED ||
              health.status === ValidationStatus.FOREIGN_APP
            ) {
              // Strictly leave unrelated or foreign-app files untouched!
              continue;
            }
            docId = candidate.id;
            await svc
              .updateFileMetadata(docId, health.status, health.currentVersion || schema?.version)
              .catch(() => {});
            break;
          } catch {
            // Skip candidate if inspection fails
          }
        }
      }
    }

    if (docId) {
      if (schema) {
        this.documentSchemas.set(docId, schema);
      }
      return docId;
    }

    // 4. Create brand-new managed spreadsheet with hidden _meta and _migrations
    const createUrl = 'https://sheets.googleapis.com/v4/spreadsheets';
    const uniqueTabs = Array.from(new Set([...tabs, '_meta', '_migrations']));
    const createBody = {
      properties: { title },
      sheets: uniqueTabs.map((tabName) => ({
        properties: {
          title: tabName,
          ...(tabName === '_meta' || tabName === '_migrations' ? { hidden: true } : {}),
          gridProperties: { frozenRowCount: 1 },
        },
      })),
    };

    const createRes = await this.client.fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(createBody),
    });
    await this.handleResponseErrors(createRes, `creating spreadsheet "${title}"`);

    const createJson = (await createRes.json()) as any;
    const createdDocId: string = createJson.spreadsheetId;

    if (schema) {
      this.documentSchemas.set(createdDocId, schema);
    }

    const svc = this.getValidationServiceInstance(schema);
    if (schema) {
      await svc.initializeFile(createdDocId, schema);
    } else {
      await svc.initializeFile(createdDocId, 1);
    }

    // Ensure legacy appPropertyDocTypeKey is also present when custom key differs
    if (docTypeKey !== 'qozara_doc_type') {
      await this.client
        .fetch(`https://www.googleapis.com/drive/v3/files/${createdDocId}?fields=properties,appProperties`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({
            appProperties: { [docTypeKey]: docType },
          }),
        })
        .catch(() => {});
    }

    if (schema) {
      const headerData = tabs
        .map((tabName) => {
          const tabDef = schema.tabs.find((t) => t.name === tabName);
          if (!tabDef) return null;
          return {
            range: `${tabName}!A1`,
            majorDimension: 'ROWS',
            values: [tabDef.columns.map((c) => c.name)],
          };
        })
        .filter(Boolean);

      if (headerData.length > 0) {
        try {
          await this.client.fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${createdDocId}/values:batchUpdate`,
            {
              method: 'POST',
              headers,
              body: JSON.stringify({
                valueInputOption: 'USER_ENTERED',
                data: headerData,
              }),
            }
          );
        } catch {
          // Ignore non-critical header init errors
        }
      }
    }

    return createdDocId;
  }

  protected async validateHeaders(
    documentId: string,
    tabName: string,
    sheetHeaders: string[]
  ): Promise<void> {
    const schema = await this.resolveSchemaForDocument(documentId);
    if (!schema) return;

    const tabDef = schema.tabs.find((t: TabDefinition) => t.name === tabName);
    if (!tabDef) return;

    if (this.options.caseInsensitiveHeaders) {
      const headerSet = new Set(sheetHeaders.map((h) => h.toLowerCase()));
      if (this.options.headerAliases) {
        for (const [alias, canonical] of Object.entries(this.options.headerAliases)) {
          if (headerSet.has(alias.toLowerCase())) {
            headerSet.add(canonical.toLowerCase());
          }
        }
      }

      const missingRequired = tabDef.columns
        .filter((col) => col.required && !headerSet.has(col.name.toLowerCase()))
        .map((col) => col.name);

      if (missingRequired.length > 0) {
        throw new Error(
          `Schema corruption: missing required column "${missingRequired[0]}" in tab "${tabName}". (Missing: ${missingRequired.join(', ')})`
        );
      }
      return;
    }

    const headerSet = new Set(sheetHeaders);
    const missingRequired = tabDef.columns
      .filter((col) => col.required && !headerSet.has(col.name))
      .map((col) => col.name);

    if (missingRequired.length > 0) {
      throw new Error(
        `Schema corruption: missing required column "${missingRequired[0]}" in tab "${tabName}". (Missing: ${missingRequired.join(', ')})`
      );
    }
  }

  async readTable(documentId: string, tabName: string): Promise<TabularRow[]> {
    let values: any[][];

    if (this.storageLayer) {
      let res: any[];
      try {
        res = await this.storageLayer.batchGetValues(documentId, [`${tabName}!A1:ZZ`]);
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (this.options.throwTableNotFoundError && this.isMissingSheetError(400, msg, tabName)) {
          throw new TableNotFoundError(
            tabName,
            `Tabular sheet "${tabName}" not found in document ${documentId}`
          );
        }
        throw err;
      }
      values = res[0]?.values || [];
    } else {
      const headers = this.getAuthHeaders();
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values/${encodeURIComponent(tabName)}!A1:ZZ`;
      const res = await this.client.fetch(url, { method: 'GET', headers });
      if (!res.ok) {
        if (this.options.throwTableNotFoundError) {
          let errText = '';
          try {
            errText = await res.text();
          } catch {
            // Ignore read error
          }
          if (this.isMissingSheetError(res.status, errText, tabName)) {
            throw new TableNotFoundError(
              tabName,
              `Tabular sheet "${tabName}" not found in document ${documentId}`
            );
          }
        }
        await this.handleResponseErrors(res, `reading table "${tabName}" from document ${documentId}`);
      }
      const json = (await res.json()) as any;
      values = json.values || [];
    }

    if (values.length === 0) {
      return [];
    }

    const sheetHeaders: string[] = (values[0] || []).map((h) => String(h).trim());
    if (sheetHeaders.length > 0) {
      this.liveHeadersCache.set(`${documentId}:${tabName}`, sheetHeaders);
    }

    if (values.length <= 1) {
      return [];
    }

    await this.validateHeaders(documentId, tabName, sheetHeaders);

    const dataRows = this.options.filterEmptyRows
      ? values
          .slice(1)
          .filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? '').trim() !== ''))
      : values.slice(1);

    return dataRows.map((row) => ({
      id: String(row[0] || ''),
      headers: sheetHeaders,
      values: row,
    }));
  }

  private buildColumnWritePlan(
    tabName: string,
    existingSheetHeaders: string[] | undefined,
    incomingHeaders: string[],
    rows: TabularRow[],
    schema?: SchemaDefinition
  ): {
    isColumnScoped: boolean;
    valueRanges: Array<{ range: string; values: any[][] }>;
    spans: ColumnSpan[];
    totalRowCount: number;
  } {
    const normalize = (s: string) => String(s ?? '').trim().toLowerCase();
    const schemaTab = schema?.tabs.find((t) => normalize(t.name) === normalize(tabName));
    const schemaColNames = schemaTab ? new Set(schemaTab.columns.map((c) => normalize(c.name))) : null;

    const liveHeaders =
      existingSheetHeaders && existingSheetHeaders.length > 0
        ? [...existingSheetHeaders]
        : [...incomingHeaders];

    const incomingIndexByNorm = new Map<string, number>();
    incomingHeaders.forEach((h, idx) => {
      const norm = normalize(h);
      if (norm && !incomingIndexByNorm.has(norm)) {
        incomingIndexByNorm.set(norm, idx);
      }
    });

    // Append any incoming headers missing from liveHeaders
    const liveNormSet = new Set(liveHeaders.map(normalize));
    for (const h of incomingHeaders) {
      const norm = normalize(h);
      if (norm && !liveNormSet.has(norm)) {
        liveHeaders.push(h);
        liveNormSet.add(norm);
      }
    }

    // Identify which columns in liveHeaders are managed vs custom user columns
    const managedColMapping = new Map<number, number>(); // liveColIdx -> incomingRowIdx
    let hasUnmanagedColumns = false;

    for (let liveIdx = 0; liveIdx < liveHeaders.length; liveIdx++) {
      const norm = normalize(liveHeaders[liveIdx]);
      const srcIdx = incomingIndexByNorm.get(norm);

      if (srcIdx === undefined) {
        hasUnmanagedColumns = true;
        continue;
      }

      // If schema defines known columns for this tab and this column isn't in schema, treat as user column
      // (unless row values explicitly populate it; if rows leave it undefined, protect it!)
      const isKnownInSchema = !schemaColNames || schemaColNames.has(norm);
      const allRowsUndefinedAtCol =
        rows.length > 0 && rows.every((r) => r.values[srcIdx] === undefined);

      if (!isKnownInSchema && (rows.length === 0 || allRowsUndefinedAtCol)) {
        hasUnmanagedColumns = true;
        continue;
      }

      managedColMapping.set(liveIdx, srcIdx);
    }

    const totalRowCount = 1 + rows.length;

    if (!hasUnmanagedColumns && managedColMapping.size === liveHeaders.length) {
      const isExactSameOrder =
        liveHeaders.length === incomingHeaders.length &&
        liveHeaders.every((h, idx) => normalize(h) === normalize(incomingHeaders[idx]));

      const allValues = isExactSameOrder
        ? [incomingHeaders, ...rows.map((r) => r.values)]
        : [
            liveHeaders,
            ...rows.map((r) =>
              liveHeaders.map((_, liveIdx) => {
                const srcIdx = managedColMapping.get(liveIdx)!;
                return r.values[srcIdx] ?? '';
              })
            ),
          ];

      return {
        isColumnScoped: false,
        valueRanges: [{ range: `${tabName}!A1`, values: allValues }],
        spans: [
          {
            startCol: 0,
            endCol: Math.max(0, liveHeaders.length - 1),
            sourceIndices: liveHeaders.map((_, i) => managedColMapping.get(i)!),
          },
        ],
        totalRowCount,
      };
    }

    // Group contiguous managed column indices into ValueRange spans so custom user columns are untouched
    const spans: ColumnSpan[] = [];
    let currentSpan: ColumnSpan | null = null;

    for (let liveIdx = 0; liveIdx < liveHeaders.length; liveIdx++) {
      const srcIdx = managedColMapping.get(liveIdx);
      if (srcIdx === undefined) {
        if (currentSpan) {
          spans.push(currentSpan);
          currentSpan = null;
        }
        continue;
      }
      if (!currentSpan) {
        currentSpan = { startCol: liveIdx, endCol: liveIdx, sourceIndices: [srcIdx] };
      } else {
        currentSpan.endCol = liveIdx;
        currentSpan.sourceIndices.push(srcIdx);
      }
    }
    if (currentSpan) {
      spans.push(currentSpan);
    }

    const valueRanges = spans.map((span) => {
      const startA1 = columnIndexToA1(span.startCol);
      const endA1 = columnIndexToA1(span.endCol);
      const headerSlice = [];
      for (let c = span.startCol; c <= span.endCol; c++) {
        headerSlice.push(liveHeaders[c]);
      }
      const dataSlice = rows.map((r) =>
        span.sourceIndices.map((srcIdx) => (r.values[srcIdx] === undefined ? '' : r.values[srcIdx]))
      );
      return {
        range: `${tabName}!${startA1}1:${endA1}${totalRowCount}`,
        values: [headerSlice, ...dataSlice],
      };
    });

    return {
      isColumnScoped: true,
      valueRanges,
      spans,
      totalRowCount,
    };
  }

  async writeTable(
    documentId: string,
    tabName: string,
    headers: string[],
    rows: TabularRow[]
  ): Promise<void> {
    const schema = await this.resolveSchemaForDocument(documentId);

    if (this.storageLayer) {
      let existing: any[] = [];
      try {
        existing = await this.storageLayer.batchGetValues(documentId, [`${tabName}!A1:ZZ`]);
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (this.options.throwTableNotFoundError && this.isMissingSheetError(400, msg, tabName)) {
          throw new TableNotFoundError(
            tabName,
            `Tabular sheet "${tabName}" not found in document ${documentId}`
          );
        }
        throw err;
      }

      const existingRows = existing[0]?.values || [];
      const existingHeaders: string[] | undefined =
        existingRows[0]?.map((h: any) => String(h).trim()) ||
        this.liveHeadersCache.get(`${documentId}:${tabName}`);

      const plan = this.buildColumnWritePlan(tabName, existingHeaders, headers, rows, schema);

      if (plan.valueRanges.length > 0) {
        try {
          await this.storageLayer.batchUpdateValues(documentId, plan.valueRanges);
        } catch (writeErr: any) {
          const msg = String(writeErr?.message || writeErr);
          if (this.options.throwTableNotFoundError && this.isMissingSheetError(400, msg, tabName)) {
            throw new TableNotFoundError(
              tabName,
              `Tabular sheet "${tabName}" not found in document ${documentId}`
            );
          }
          throw writeErr;
        }
      }

      if (existingRows.length > plan.totalRowCount) {
        if (plan.isColumnScoped) {
          // Clear trailing cells ONLY inside managed columns so user formula columns are never removed
          const trailingCount = existingRows.length - plan.totalRowCount;
          const clearRanges = plan.spans.map((span) => {
            const startA1 = columnIndexToA1(span.startCol);
            const endA1 = columnIndexToA1(span.endCol);
            const colWidth = span.endCol - span.startCol + 1;
            const emptyRows = Array.from({ length: trailingCount }, () =>
              new Array(colWidth).fill('')
            );
            return {
              range: `${tabName}!${startA1}${plan.totalRowCount + 1}:${endA1}${existingRows.length}`,
              values: emptyRows,
            };
          });
          if (clearRanges.length > 0) {
            await this.storageLayer.batchUpdateValues(documentId, clearRanges).catch(() => {});
          }
        } else {
          try {
            const sheetMeta = await this.storageLayer.getSpreadsheet(documentId, 'sheets.properties');
            const sheetId = sheetMeta.sheets?.find((s: any) => s.properties?.title === tabName)
              ?.properties?.sheetId;
            if (sheetId !== undefined) {
              await this.storageLayer.batchUpdateSpreadsheet(documentId, [
                {
                  deleteDimension: {
                    range: {
                      sheetId,
                      dimension: 'ROWS',
                      startIndex: plan.totalRowCount,
                      endIndex: existingRows.length,
                    },
                  },
                },
              ]);
            }
          } catch {
            // Non-critical cleanup
          }
        }
      }

      await this.storageLayer
        .updateFile(documentId, {
          properties: { _lastSyncTrigger: new Date().toISOString() },
        })
        .catch(() => {});
      return;
    }

    const authHeaders = this.getAuthHeaders();

    // Check cached or live row 1 headers so custom user columns/order are preserved
    let existingHeaders = this.liveHeadersCache.get(`${documentId}:${tabName}`);
    if (!existingHeaders) {
      try {
        const hdrRes = await this.client.fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values/${encodeURIComponent(tabName)}!1:1`,
          { method: 'GET', headers: authHeaders }
        );
        if (hdrRes.ok) {
          const hdrJson = (await hdrRes.json()) as any;
          const row0 = hdrJson.values?.[0] || [];
          if (row0.length > 0) {
            existingHeaders = row0.map((h: any) => String(h).trim());
            this.liveHeadersCache.set(`${documentId}:${tabName}`, existingHeaders!);
          }
        }
      } catch {
        // Proceed with incoming headers if header inspection is unavailable
      }
    }

    const plan = this.buildColumnWritePlan(tabName, existingHeaders, headers, rows, schema);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values:batchUpdate`;
    const body = {
      valueInputOption: 'USER_ENTERED',
      data: plan.valueRanges.map((vr) => ({
        range: vr.range,
        majorDimension: 'ROWS',
        values: vr.values,
      })),
    };

    let res = await this.client.fetch(url, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    });

    if (!res.ok && (this.options.autoCreateMissingTabOnWrite ?? false)) {
      const errText = await res
        .clone()
        .text()
        .catch(() => '');
      if (errText.includes('Unable to parse range') || errText.includes('range')) {
        try {
          const addRes = await this.client.fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${documentId}:batchUpdate`,
            {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({
                requests: [{ addSheet: { properties: { title: tabName } } }],
              }),
            }
          );
          if (addRes.ok) {
            res = await this.client.fetch(url, {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify(body),
            });
          }
        } catch {
          // Fall through to standard error handling
        }
      }
    }

    await this.handleResponseErrors(res, `writing table "${tabName}" in document ${documentId}`);

    try {
      if (plan.isColumnScoped) {
        const clearRanges = plan.spans.map((span) => {
          const startA1 = columnIndexToA1(span.startCol);
          const endA1 = columnIndexToA1(span.endCol);
          return `${tabName}!${startA1}${plan.totalRowCount + 1}:${endA1}`;
        });
        await this.client.fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values:batchClear`,
          {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({ ranges: clearRanges }),
          }
        );
      } else {
        const endA1 = columnIndexToA1(Math.max(0, (existingHeaders?.length || headers.length) - 1));
        const clearRange = `${encodeURIComponent(tabName)}!A${plan.totalRowCount + 1}:${endA1}`;
        const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values/${clearRange}:clear`;
        await this.client.fetch(clearUrl, {
          method: 'POST',
          headers: authHeaders,
        });
      }
    } catch {
      // Non-critical trailing row cleanup
    }
  }

  private getValidationServiceInstance(schemaOverride?: SchemaDefinition): GoogleValidationService {
    if (this.validationService) {
      return this.validationService;
    }
    const schema = schemaOverride ?? this.options.defaultSchema;
    const migrations = this.resolveMigrationsForSchema(schema);
    if (this.validationServiceFactory) {
      return this.validationServiceFactory(this.getAccessToken, this.client, {
        defaultSchema: schema,
        migrations,
      });
    }
    this.validationService = new GoogleValidationService(this.getAccessToken, {
      httpClient: this.client,
      defaultSchema: schema,
      migrations,
      appPropertyPrefix: this.options.appId ?? schema?.identity?.appId ?? 'quomida',
    });
    return this.validationService;
  }

  async repairTable(
    documentId: string,
    _tabNameOrExpectedLastModified?: string,
    expectedLastModified?: string
  ): Promise<void> {
    const schema = await this.resolveSchemaForDocument(documentId);
    const svc = this.getValidationServiceInstance(schema);
    const expected = expectedLastModified ?? _tabNameOrExpectedLastModified;
    await svc.repairFile(documentId, schema, expected);
  }

  async migrateTable(documentId: string, expectedLastModified?: string): Promise<void> {
    const schema = await this.resolveSchemaForDocument(documentId);
    const svc = this.getValidationServiceInstance(schema);
    const migrations = this.resolveMigrationsForSchema(schema);
    await svc.migrateFile(documentId, schema, migrations, expectedLastModified);
  }

  async healForkedCopy(documentId: string): Promise<void> {
    const schema = await this.resolveSchemaForDocument(documentId);
    const svc = this.getValidationServiceInstance(schema);
    await svc.healForkedCopy(documentId, schema);
  }

  async checkHealth(documentId: string): Promise<SchemaStatusDTO> {
    const schema = await this.resolveSchemaForDocument(documentId);
    const svc = this.getValidationServiceInstance(schema);
    return await svc.checkHealth(documentId, schema);
  }
}

export { ForeignDocumentError, UnmanagedDocumentError };
