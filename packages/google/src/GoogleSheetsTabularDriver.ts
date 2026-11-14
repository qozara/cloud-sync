import {
  TableNotFoundError,
  type TabularRow,
  type TabularStorageDriver,
} from '@qozara/cloud-sync';
import {
  ValidationService,
  type ColumnDefinition,
  type GoogleDriverOptions,
  type GoogleHttpClient,
  type IStorageLayer,
  type SchemaDefinition,
  type SchemaStatusDTO,
  type TabDefinition,
} from '@qozara/gdocs-schema';

export interface GoogleSheetsTabularDriverOptions extends GoogleDriverOptions {
  defaultSchema?: SchemaDefinition;
  schemasByDocType?: Record<string, SchemaDefinition>;
  docTypeResolver?: (
    title: string,
    tabs: string[]
  ) => { docType: string; schema?: SchemaDefinition };
  tabMatcher?: (tabTitles: string[]) => SchemaDefinition | undefined;
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
  validationService?: ValidationService;
  validationServiceFactory?: (
    getToken: () => string | null,
    httpClient?: GoogleHttpClient
  ) => ValidationService;
}

export class GoogleSheetsTabularDriver implements TabularStorageDriver {
  id = 'google-sheets-tabular';
  name = 'Google Sheets Tabular Driver';

  public readonly storageLayer?: IStorageLayer;

  protected getAccessToken: () => string | null;
  protected client: GoogleHttpClient;
  protected validationService?: ValidationService;
  protected validationServiceFactory?: (
    getToken: () => string | null,
    httpClient?: GoogleHttpClient
  ) => ValidationService;
  protected documentSchemas: Map<string, SchemaDefinition> = new Map();
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
      const docTypeKey = this.options.appPropertyDocTypeKey ?? 'quomida_doc_type';
      const docTypes = this.options.docTypesForLinks ?? ['daily_logs', 'food_catalog'];

      for (const docType of docTypes) {
        const query = encodeURIComponent(
          `appProperties has { key='${docTypeKey}' and value='${docType}' } and trashed = false`
        );
        const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`;
        const res = await this.client.fetch(searchUrl, { method: 'GET', headers });
        if (res.ok) {
          const json = (await res.json()) as any;
          if (json.files && json.files.length > 0) {
            linkSet.add(`https://docs.google.com/spreadsheets/d/${json.files[0].id}/edit`);
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
      // Ignore schema resolution network error and fall back to defaultSchema
    }

    return this.options.defaultSchema;
  }

  async ensureDocument(title: string, tabs: string[]): Promise<string> {
    const headers = this.getAuthHeaders();
    const docTypeKey = this.options.appPropertyDocTypeKey ?? 'quomida_doc_type';
    const metaSheetName = this.options.metaSheetName ?? '_quomida_meta';
    const metaBannerText = this.options.metaBannerText ?? 'QUOMIDA SYSTEM FILE - DO NOT DELETE';
    const metaDescription = this.options.metaDescription ?? 'Quomida System Metadata';

    const resolvedDocType = this.options.docTypeResolver
      ? this.options.docTypeResolver(title, tabs)
      : {
          docType: tabs.includes('daily_logs') || title.includes('Daily Logs') ? 'daily_logs' : 'food_catalog',
          schema:
            this.options.schemasByDocType?.[
              tabs.includes('daily_logs') || title.includes('Daily Logs')
                ? 'daily_logs'
                : 'food_catalog'
            ] ?? this.options.defaultSchema,
        };

    const { docType, schema } = resolvedDocType;

    const query = encodeURIComponent(
      `appProperties has { key='${docTypeKey}' and value='${docType}' } and trashed = false`
    );
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`;

    const searchRes = await this.client.fetch(searchUrl, { method: 'GET', headers });
    await this.handleResponseErrors(searchRes, `searching spreadsheet metadata "${docType}"`);

    const searchJson = (await searchRes.json()) as any;
    let docId: string | null = null;

    if (searchJson.files && searchJson.files.length > 0) {
      docId = searchJson.files[0].id;
    } else {
      const titleQuery = encodeURIComponent(
        `name = '${title}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`
      );
      const titleSearchUrl = `https://www.googleapis.com/drive/v3/files?q=${titleQuery}&fields=files(id,name)`;
      const titleRes = await this.client.fetch(titleSearchUrl, { method: 'GET', headers });
      if (titleRes.ok) {
        const titleJson = (await titleRes.json()) as any;
        if (titleJson.files && titleJson.files.length > 0) {
          docId = titleJson.files[0].id;
          try {
            await this.client.fetch(`https://www.googleapis.com/drive/v3/files/${docId}`, {
              method: 'PATCH',
              headers,
              body: JSON.stringify({
                appProperties: { [docTypeKey]: docType },
              }),
            });
          } catch {
            // Non-critical metadata backfill
          }
        }
      }
    }

    if (docId) {
      if (schema) {
        this.documentSchemas.set(docId, schema);
      }

      try {
        const getMetaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${docId}?fields=sheets(properties(title))`;
        const metaRes = await this.client.fetch(getMetaUrl, { method: 'GET', headers });
        if (metaRes.ok) {
          const metaJson = (await metaRes.json()) as any;
          const existingTabs = new Set((metaJson.sheets || []).map((s: any) => s.properties?.title));
          const allRequiredTabs = [...tabs, metaSheetName];
          const missingTabs = allRequiredTabs.filter((t) => !existingTabs.has(t));

          if (missingTabs.length > 0) {
            const addSheetRequests = missingTabs.map((tabName) => ({
              addSheet: { properties: { title: tabName } },
            }));
            const addRes = await this.client.fetch(
              `https://sheets.googleapis.com/v4/spreadsheets/${docId}:batchUpdate`,
              {
                method: 'POST',
                headers,
                body: JSON.stringify({ requests: addSheetRequests }),
              }
            );

            if (addRes.ok) {
              const currentSchema = this.documentSchemas.get(docId);
              if (currentSchema) {
                const headerData = missingTabs
                  .filter((t) => t !== metaSheetName)
                  .map((tabName) => {
                    const tabDef = currentSchema.tabs.find((t) => t.name === tabName);
                    if (!tabDef) return null;
                    return {
                      range: `${tabName}!A1:Z1`,
                      majorDimension: 'ROWS',
                      values: [tabDef.columns.map((c) => c.name)],
                    };
                  })
                  .filter(Boolean);

                if (headerData.length > 0) {
                  try {
                    await this.client.fetch(
                      `https://sheets.googleapis.com/v4/spreadsheets/${docId}/values:batchUpdate`,
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
                    // Non-critical header init
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn(
          `[GoogleSheetsTabularDriver] Failed to verify/add missing tabs for ${docId}:`,
          err
        );
      }

      return docId;
    }

    const createUrl = 'https://sheets.googleapis.com/v4/spreadsheets';
    const allTabs = [...tabs, metaSheetName];
    const createBody = {
      properties: { title },
      sheets: allTabs.map((tabName) => ({
        properties: { title: tabName },
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

    const patchUrl = `https://www.googleapis.com/drive/v3/files/${createdDocId}`;
    const patchBody = {
      appProperties: {
        [docTypeKey]: docType,
      },
    };
    const patchRes = await this.client.fetch(patchUrl, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patchBody),
    });
    await this.handleResponseErrors(patchRes, `attaching metadata to spreadsheet "${title}"`);

    const schemaVersion = this.documentSchemas.get(createdDocId)?.version || 1;
    const valuesUrl = `https://sheets.googleapis.com/v4/spreadsheets/${createdDocId}/values:batchUpdate`;
    const valuesBody = {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `${metaSheetName}!A1:B2`,
          majorDimension: 'ROWS',
          values: [
            [metaBannerText, ''],
            ['Schema Version:', schemaVersion],
          ],
        },
      ],
    };
    const valuesRes = await this.client.fetch(valuesUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(valuesBody),
    });
    await this.handleResponseErrors(
      valuesRes,
      `populating ${metaSheetName} in spreadsheet "${title}"`
    );

    const metaSheetId = createJson.sheets?.find(
      (s: any) => s.properties?.title === metaSheetName
    )?.properties?.sheetId;
    if (metaSheetId !== undefined) {
      const protectUrl = `https://sheets.googleapis.com/v4/spreadsheets/${createdDocId}:batchUpdate`;
      const protectBody = {
        requests: [
          {
            addProtectedRange: {
              protectedRange: {
                range: { sheetId: metaSheetId },
                description: metaDescription,
                warningOnly: true,
              },
            },
          },
        ],
      };
      const protectRes = await this.client.fetch(protectUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(protectBody),
      });
      await this.handleResponseErrors(
        protectRes,
        `protecting ${metaSheetName} in spreadsheet "${title}"`
      );
    }

    const currentSchema = this.documentSchemas.get(createdDocId);
    if (currentSchema) {
      const headerData = tabs
        .map((tabName) => {
          const tabDef = currentSchema.tabs.find((t) => t.name === tabName);
          if (!tabDef) return null;
          return {
            range: `${tabName}!A1:Z1`,
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
        .filter((col: ColumnDefinition) => col.required && !headerSet.has(col.name.toLowerCase()))
        .map((col: ColumnDefinition) => col.name);

      if (missingRequired.length > 0) {
        throw new Error(
          `Schema corruption: missing required column "${missingRequired[0]}" in tab "${tabName}". (Missing: ${missingRequired.join(', ')})`
        );
      }
      return;
    }

    const headerSet = new Set(sheetHeaders);
    const missingRequired = tabDef.columns
      .filter((col: ColumnDefinition) => col.required && !headerSet.has(col.name))
      .map((col: ColumnDefinition) => col.name);

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
        res = await this.storageLayer.batchGetValues(documentId, [`${tabName}!A1:Z`]);
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
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values/${encodeURIComponent(tabName)}!A1:Z`;
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

    if (values.length <= 1) {
      return [];
    }

    const sheetHeaders: string[] = (values[0] || []).map((h) => String(h).trim());
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

  async writeTable(
    documentId: string,
    tabName: string,
    headers: string[],
    rows: TabularRow[]
  ): Promise<void> {
    const allValues = [headers, ...rows.map((r) => r.values)];

    if (this.storageLayer) {
      let existing: any[] = [];
      try {
        existing = await this.storageLayer.batchGetValues(documentId, [`${tabName}!A1:Z`]);
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
      try {
        await this.storageLayer.batchUpdateValues(documentId, [
          { range: `${tabName}!A1`, values: allValues },
        ]);
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

      if (existingRows.length > allValues.length) {
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
                    startIndex: allValues.length,
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

      await this.storageLayer
        .updateFile(documentId, {
          properties: { _lastSyncTrigger: new Date().toISOString() },
        })
        .catch(() => {});
      return;
    }

    const authHeaders = this.getAuthHeaders();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values:batchUpdate`;
    const body = {
      valueInputOption: 'USER_ENTERED',
      data: [
        {
          range: `${tabName}!A1:Z`,
          majorDimension: 'ROWS',
          values: allValues,
        },
      ],
    };

    let res = await this.client.fetch(url, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(body),
    });

    if (!res.ok && (this.options.autoCreateMissingTabOnWrite ?? true)) {
      const errText = await res
        .clone()
        .text()
        .catch(() => '');
      if (errText.includes('Unable to parse range') || errText.includes('range')) {
        try {
          const addSheetRequests = [
            {
              addSheet: { properties: { title: tabName } },
            },
          ];
          const addRes = await this.client.fetch(
            `https://sheets.googleapis.com/v4/spreadsheets/${documentId}:batchUpdate`,
            {
              method: 'POST',
              headers: authHeaders,
              body: JSON.stringify({ requests: addSheetRequests }),
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
      const clearRange = `${encodeURIComponent(tabName)}!A${allValues.length + 1}:Z`;
      const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${documentId}/values/${clearRange}:clear`;
      await this.client.fetch(clearUrl, {
        method: 'POST',
        headers: authHeaders,
      });
    } catch {
      // Non-critical trailing row cleanup
    }
  }

  private getValidationServiceInstance(): ValidationService {
    if (this.validationService) {
      return this.validationService;
    }
    if (this.validationServiceFactory) {
      return this.validationServiceFactory(this.getAccessToken, this.client);
    }
    this.validationService = new ValidationService(this.getAccessToken, {
      httpClient: this.client,
      defaultSchema: this.options.defaultSchema,
    });
    return this.validationService;
  }

  async repairTable(
    documentId: string,
    _tabNameOrExpectedLastModified?: string,
    expectedLastModified?: string
  ): Promise<void> {
    const svc = this.getValidationServiceInstance();
    const schema = await this.resolveSchemaForDocument(documentId);
    const expected = expectedLastModified ?? _tabNameOrExpectedLastModified;
    if (this.validationServiceFactory) {
      await svc.repairFile(documentId, expected);
    } else {
      await svc.repairFile(documentId, schema, expected);
    }
  }

  async migrateTable(documentId: string, expectedLastModified?: string): Promise<void> {
    const svc = this.getValidationServiceInstance();
    const schema = await this.resolveSchemaForDocument(documentId);
    if (this.validationServiceFactory) {
      await svc.migrateFile(documentId, expectedLastModified);
    } else {
      await svc.migrateFile(documentId, schema, [], expectedLastModified);
    }
  }

  async checkHealth(documentId: string): Promise<SchemaStatusDTO> {
    const svc = this.getValidationServiceInstance();
    const schema = await this.resolveSchemaForDocument(documentId);
    if (this.validationServiceFactory) {
      return await svc.checkHealth(documentId);
    }
    return await svc.checkHealth(documentId, schema);
  }
}
