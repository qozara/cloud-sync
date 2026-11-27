import type {
  ContainerInspectionResult,
  EnsureTableOptions,
  ITabularContainerDriver,
  SchemaDefinition,
  WriteMetaOptions,
} from '@qozara/cloud-sync';
import { GoogleSheetsFetchClient } from './GoogleSheetsFetchClient.js';

const META_TAB_NAME = '_meta';
const MIGRATIONS_TAB_NAME = '_migrations';

export class GoogleSheetsContainerDriver implements ITabularContainerDriver {
  constructor(public readonly client: GoogleSheetsFetchClient) {}

  getNativeClient<T = unknown>(): T {
    return this.client as unknown as T;
  }

  private async getSheetMap(
    spreadsheetId: string
  ): Promise<{ title?: string; sheets: Map<string, { sheetId: number; title: string }> }> {
    const metadata = await this.client.getSpreadsheetMetadata(
      spreadsheetId,
      'properties.title,sheets.properties(sheetId,title)'
    );
    const map = new Map<string, { sheetId: number; title: string }>();
    for (const s of metadata?.sheets || []) {
      const title = s?.properties?.title;
      if (title) {
        map.set(title.trim().toLowerCase(), {
          sheetId: s.properties.sheetId,
          title,
        });
      }
    }
    return { title: metadata?.properties?.title, sheets: map };
  }

  async inspectContainer(
    spreadsheetId: string,
    schema: SchemaDefinition
  ): Promise<ContainerInspectionResult> {
    const [sheetMeta, driveMeta] = await Promise.all([
      this.client.getSpreadsheetMetadata(
        spreadsheetId,
        'properties.title,sheets.properties(sheetId,title)'
      ),
      this.client.getFileMetadata(spreadsheetId).catch(() => ({
        properties: {},
        appProperties: {},
        modifiedTime: undefined,
      })),
    ]);

    const rawSheets: any[] = sheetMeta?.sheets || [];
    const sheetMap = new Map<string, { sheetId: number; title: string }>();
    for (const s of rawSheets) {
      const title = s?.properties?.title;
      if (title) {
        sheetMap.set(title.trim().toLowerCase(), {
          sheetId: s.properties.sheetId,
          title,
        });
      }
    }

    const metaSheet = sheetMap.get(META_TAB_NAME);
    const migrationsSheet = sheetMap.get(MIGRATIONS_TAB_NAME);

    const ranges: string[] = [];
    let metaRangeIdx = -1;
    let migrationsRangeIdx = -1;
    const headerRangeIndices = new Map<string, number>();

    if (metaSheet) {
      metaRangeIdx = ranges.length;
      ranges.push(`'${metaSheet.title}'!A1:C50`);
    }
    if (migrationsSheet) {
      migrationsRangeIdx = ranges.length;
      ranges.push(`'${migrationsSheet.title}'!A2:B`);
    }

    for (const tab of schema.tabs) {
      const key = tab.name.trim().toLowerCase();
      const existing = sheetMap.get(key);
      if (existing && !headerRangeIndices.has(key)) {
        headerRangeIndices.set(key, ranges.length);
        ranges.push(`'${existing.title}'!1:1`);
      }
    }

    let valueRanges: any[] = [];
    if (ranges.length > 0) {
      const batchRes = await this.client.batchGet(spreadsheetId, ranges);
      valueRanges = batchRes?.valueRanges || [];
    }

    const metaEntries: Record<string, string> = {};
    if (metaRangeIdx >= 0) {
      const rows = valueRanges[metaRangeIdx]?.values || [];
      const startIdx =
        String(rows[0]?.[0] ?? '')
          .trim()
          .toLowerCase() === 'key'
          ? 1
          : 0;
      for (let i = startIdx; i < rows.length; i++) {
        const key = String(rows[i]?.[0] ?? '').trim();
        if (key) {
          metaEntries[key] = String(rows[i]?.[1] ?? '').trim();
        }
      }
    }

    const migrationVersions: number[] = [];
    if (migrationsRangeIdx >= 0) {
      const rows = valueRanges[migrationsRangeIdx]?.values || [];
      for (const row of rows) {
        if (row && row[0] !== undefined && row[0] !== null) {
          const val = parseInt(String(row[0]).trim(), 10);
          if (!Number.isNaN(val)) {
            migrationVersions.push(val);
          }
        }
      }
    }

    const tables = rawSheets
      .filter((s) => Boolean(s?.properties?.title))
      .map((s) => {
        const title = String(s.properties.title);
        const key = title.trim().toLowerCase();
        const hdrIdx = headerRangeIndices.get(key);
        const headers =
          hdrIdx !== undefined
            ? (valueRanges[hdrIdx]?.values?.[0] || []).map((h: any) => String(h).trim())
            : undefined;
        return {
          id: s.properties.sheetId,
          name: title,
          headers,
        };
      });

    const indexProperties: Record<string, string> = {
      ...(driveMeta.appProperties || {}),
      ...(driveMeta.properties || {}),
    };

    return {
      containerId: spreadsheetId,
      title: sheetMeta?.properties?.title,
      lastModifiedTime: driveMeta.modifiedTime,
      tables,
      metaEntries,
      hasMetaTable: Boolean(metaSheet),
      migrationVersions,
      hasMigrationsTable: Boolean(migrationsSheet),
      indexProperties,
    };
  }

  async ensureTable(spreadsheetId: string, table: EnsureTableOptions): Promise<void> {
    const { sheets } = await this.getSheetMap(spreadsheetId);
    const existing = sheets.get(table.name.trim().toLowerCase());
    let sheetId = existing?.sheetId;

    if (!existing) {
      const addRes = await this.client.batchUpdate(spreadsheetId, [
        {
          addSheet: {
            properties: {
              title: table.name,
              ...(table.hidden ? { hidden: true } : {}),
              ...(table.frozenHeaderRow !== false
                ? { gridProperties: { frozenRowCount: 1 } }
                : {}),
            },
          },
        },
      ]);
      sheetId = addRes?.replies?.[0]?.addSheet?.properties?.sheetId;
    }

    if (sheetId !== undefined && table.protectWarning) {
      await this.client
        .batchUpdate(spreadsheetId, [
          {
            addProtectedRange: {
              protectedRange: {
                range: { sheetId },
                description: table.protectWarning,
                warningOnly: true,
              },
            },
          },
        ])
        .catch(() => {});
    }

    if (table.headers && table.headers.length > 0 && sheetId !== undefined) {
      const existingTitle = existing?.title || table.name;
      let hasHeaderRow = false;
      if (existing) {
        const hdrRes = await this.client.batchGet(spreadsheetId, [`'${existingTitle}'!1:1`]);
        const row0 = hdrRes?.valueRanges?.[0]?.values?.[0] || [];
        hasHeaderRow = row0.length > 0;
      }
      if (!hasHeaderRow) {
        await this.client.batchUpdate(spreadsheetId, [
          {
            updateCells: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: table.headers.length,
              },
              rows: [
                {
                  values: table.headers.map((h) => ({
                    userEnteredValue: { stringValue: h },
                  })),
                },
              ],
              fields: 'userEnteredValue',
            },
          },
        ]);
      }
    }
  }

  async addColumns(spreadsheetId: string, tableName: string, columns: string[]): Promise<void> {
    if (columns.length === 0) return;
    const { sheets } = await this.getSheetMap(spreadsheetId);
    const existing = sheets.get(tableName.trim().toLowerCase());
    if (!existing) return;

    const headerRes = await this.client.batchGet(spreadsheetId, [`'${existing.title}'!1:1`]);
    const rowValues = headerRes?.valueRanges?.[0]?.values?.[0] || [];
    const existingHeaders = rowValues.map((h: any) => String(h).trim());
    const existingLower = new Set(existingHeaders.map((h: string) => h.toLowerCase()));

    const missing = columns.filter((c) => !existingLower.has(c.trim().toLowerCase()));
    if (missing.length === 0) return;

    const startIndex = existingHeaders.length;
    await this.client.batchUpdate(spreadsheetId, [
      {
        appendDimension: {
          sheetId: existing.sheetId,
          dimension: 'COLUMNS',
          length: missing.length,
        },
      },
      {
        updateCells: {
          range: {
            sheetId: existing.sheetId,
            startRowIndex: 0,
            endRowIndex: 1,
            startColumnIndex: startIndex,
            endColumnIndex: startIndex + missing.length,
          },
          rows: [
            {
              values: missing.map((colName) => ({
                userEnteredValue: { stringValue: colName },
              })),
            },
          ],
          fields: 'userEnteredValue',
        },
      },
    ]);
  }

  async readMeta(spreadsheetId: string): Promise<Record<string, string>> {
    try {
      const res = await this.client.batchGet(spreadsheetId, [`${META_TAB_NAME}!A1:C50`]);
      const rows = res?.valueRanges?.[0]?.values || [];
      const result: Record<string, string> = {};
      const startIdx =
        String(rows[0]?.[0] ?? '')
          .trim()
          .toLowerCase() === 'key'
          ? 1
          : 0;
      for (let i = startIdx; i < rows.length; i++) {
        const key = String(rows[i]?.[0] ?? '').trim();
        if (key) {
          result[key] = String(rows[i]?.[1] ?? '').trim();
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  async writeMeta(
    spreadsheetId: string,
    entries: Record<string, string>,
    options?: WriteMetaOptions
  ): Promise<void> {
    await this.ensureTable(spreadsheetId, {
      name: META_TAB_NAME,
      headers: ['key', 'value', 'updatedAt'],
      hidden: options?.hidden ?? true,
      protectWarning: options?.protectWarning,
      frozenHeaderRow: true,
    });

    let rows: any[][] = [];
    try {
      const res = await this.client.batchGet(spreadsheetId, [`${META_TAB_NAME}!A1:C50`]);
      rows = res?.valueRanges?.[0]?.values || [];
    } catch {
      rows = [];
    }

    if (
      rows.length === 0 ||
      String(rows[0]?.[0] ?? '')
        .trim()
        .toLowerCase() !== 'key'
    ) {
      rows = [['key', 'value', 'updatedAt']];
    }

    const nowIso = new Date().toISOString();
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) continue;
      const idx = rows.findIndex((r, i) => i > 0 && String(r?.[0] ?? '').trim() === key);
      if (idx >= 0) {
        rows[idx] = [key, value, nowIso];
      } else {
        rows.push([key, value, nowIso]);
      }
    }

    await this.client.batchUpdateValues(spreadsheetId, [
      { range: `${META_TAB_NAME}!A1`, values: rows },
    ]);
  }

  async ensureMigrationsTable(spreadsheetId: string, initialVersion?: number): Promise<void> {
    const { sheets } = await this.getSheetMap(spreadsheetId);
    const existing = sheets.get(MIGRATIONS_TAB_NAME);
    if (existing) return;

    const addRes = await this.client.batchUpdate(spreadsheetId, [
      {
        addSheet: {
          properties: {
            title: MIGRATIONS_TAB_NAME,
            hidden: true,
          },
        },
      },
    ]);
    const migrationsSheetId = addRes?.replies?.[0]?.addSheet?.properties?.sheetId;
    if (migrationsSheetId === undefined) return;

    const initialRows: any[] = [
      {
        values: [
          { userEnteredValue: { stringValue: 'version' } },
          { userEnteredValue: { stringValue: 'migrated_at' } },
        ],
      },
    ];

    if (initialVersion !== undefined && initialVersion > 0) {
      initialRows.push({
        values: [
          { userEnteredValue: { numberValue: initialVersion } },
          { userEnteredValue: { stringValue: new Date().toISOString() } },
        ],
      });
    }

    await this.client.batchUpdate(spreadsheetId, [
      {
        updateCells: {
          rows: initialRows,
          fields: 'userEnteredValue',
          range: {
            sheetId: migrationsSheetId,
            startRowIndex: 0,
            startColumnIndex: 0,
          },
        },
      },
    ]);
  }

  async appendMigrationRecord(
    spreadsheetId: string,
    version: number,
    migratedAt: string
  ): Promise<void> {
    const { sheets } = await this.getSheetMap(spreadsheetId);
    const migrationsSheet = sheets.get(MIGRATIONS_TAB_NAME);
    if (!migrationsSheet) return;

    await this.client.batchUpdate(spreadsheetId, [
      {
        appendCells: {
          sheetId: migrationsSheet.sheetId,
          rows: [
            {
              values: [
                { userEnteredValue: { numberValue: version } },
                { userEnteredValue: { stringValue: migratedAt } },
              ],
            },
          ],
          fields: 'userEnteredValue',
        },
      },
    ]);
  }

  async createBackup(spreadsheetId: string, customName?: string): Promise<string> {
    return this.client.createBackup(spreadsheetId, customName);
  }

  async restoreBackup(backupId: string, spreadsheetId: string): Promise<void> {
    return this.client.restoreBackup(backupId, spreadsheetId);
  }

  async deleteBackup(backupId: string): Promise<void> {
    return this.client.deleteFile(backupId);
  }

  async acquireLock(
    spreadsheetId: string,
    clientUuid: string,
    ttlMs?: number
  ): Promise<boolean> {
    return this.client.acquireLock(spreadsheetId, clientUuid, ttlMs);
  }

  async releaseLock(spreadsheetId: string, clientUuid: string): Promise<boolean> {
    return this.client.releaseLock(spreadsheetId, clientUuid);
  }

  async syncIndexMetadata(
    spreadsheetId: string,
    properties: Record<string, string>
  ): Promise<void> {
    const publicProps: Record<string, string> = {};
    const appProps: Record<string, string> = {};

    for (const [key, val] of Object.entries(properties)) {
      if (
        key === 'qozara_app' ||
        key === 'qozara_doc_type' ||
        key === 'quozen_type' ||
        key === 'quomida_doc_type'
      ) {
        publicProps[key] = val;
      }
      appProps[key] = val;
    }

    await this.client.updateFileProperties(spreadsheetId, {
      ...(Object.keys(publicProps).length > 0 ? { properties: publicProps } : {}),
      ...(Object.keys(appProps).length > 0 ? { appProperties: appProps } : {}),
    });
  }
}
