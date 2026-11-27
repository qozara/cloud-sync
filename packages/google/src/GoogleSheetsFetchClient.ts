export interface GoogleSheetsFetchClientOptions {
  accessToken: string | (() => string | null);
  fetchImpl?: typeof fetch;
}

export class GoogleSheetsFetchClient {
  private accessToken: string | (() => string | null);
  private fetch: typeof fetch;

  constructor(options: GoogleSheetsFetchClientOptions) {
    this.accessToken = options.accessToken;
    this.fetch = options.fetchImpl || globalThis.fetch;
  }

  private resolveAccessToken(): string {
    const token =
      typeof this.accessToken === 'function' ? this.accessToken() : this.accessToken;
    if (!token) {
      throw new Error('Google Auth Failed: Access token is missing or expired');
    }
    return token;
  }

  private async request(url: string, init: RequestInit = {}): Promise<any> {
    const token = this.resolveAccessToken();
    const hasBody = init.body !== undefined || (Boolean(init.method) && init.method !== 'GET');
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers as Record<string, string> | undefined),
    };

    const response = await this.fetch(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Google API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    if (typeof response.text === 'function') {
      const text = await response.text();
      if (!text) {
        return {};
      }
      return JSON.parse(text);
    }

    return response.json();
  }

  async getSpreadsheet(spreadsheetId: string): Promise<any> {
    return this.request(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`);
  }

  async getSpreadsheetMetadata(
    spreadsheetId: string,
    fields = 'properties.title,sheets.properties(sheetId,title)'
  ): Promise<any> {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=${encodeURIComponent(fields)}`
    );
  }

  async batchGet(spreadsheetId: string, ranges: string[]): Promise<any> {
    const encodedRanges = ranges.map(encodeURIComponent).join('&ranges=');
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?ranges=${encodedRanges}`
    );
  }

  async batchUpdate(spreadsheetId: string, requests: any[]): Promise<any> {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({ requests }),
      }
    );
  }

  async batchUpdateValues(
    spreadsheetId: string,
    data: Array<{ range: string; values: any[][] }>
  ): Promise<any> {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`,
      {
        method: 'POST',
        body: JSON.stringify({
          valueInputOption: 'USER_ENTERED',
          data,
        }),
      }
    );
  }

  async batchClearValues(spreadsheetId: string, ranges: string[]): Promise<any> {
    return this.request(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchClear`,
      {
        method: 'POST',
        body: JSON.stringify({ ranges }),
      }
    );
  }

  async acquireLock(
    spreadsheetId: string,
    clientUuid: string,
    ttlMs = 3 * 60 * 1000
  ): Promise<boolean> {
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=appProperties`;
    const metadata = await this.request(fileUrl);

    const appProperties = metadata.appProperties || {};
    const existingLockStr = appProperties.migration_lock;

    if (existingLockStr) {
      try {
        const existingLock = JSON.parse(existingLockStr);
        const now = Date.now();
        if (
          existingLock.acquiredAt &&
          now - existingLock.acquiredAt < ttlMs &&
          existingLock.owner !== clientUuid
        ) {
          throw new Error('Lock already acquired by another client');
        }
      } catch (err: any) {
        if (err.message === 'Lock already acquired by another client') {
          throw err;
        }
      }
    }

    const newLock = {
      owner: clientUuid,
      acquiredAt: Date.now(),
    };

    try {
      await this.request(fileUrl, {
        method: 'PATCH',
        body: JSON.stringify({
          appProperties: {
            migration_lock: JSON.stringify(newLock),
          },
        }),
      });
      return true;
    } catch (err: any) {
      if (err.message?.includes('412')) {
        throw new Error('Lock acquisition failed due to concurrency conflict');
      }
      throw err;
    }
  }

  async releaseLock(spreadsheetId: string, clientUuid: string): Promise<boolean> {
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=appProperties`;
    const metadata = await this.request(fileUrl);

    const appProperties = metadata.appProperties || {};
    const existingLockStr = appProperties.migration_lock;

    if (!existingLockStr) {
      return true;
    }

    try {
      const existingLock = JSON.parse(existingLockStr);
      if (existingLock.owner !== clientUuid) {
        throw new Error('Lock is owned by a different client');
      }
    } catch {
      // Allow clearing invalid lock payload
    }

    await this.request(fileUrl, {
      method: 'PATCH',
      body: JSON.stringify({
        appProperties: {
          migration_lock: null,
        },
      }),
    });

    return true;
  }

  async createBackup(spreadsheetId: string, customName?: string): Promise<string> {
    const copyUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}/copy`;
    const result = await this.request(copyUrl, {
      method: 'POST',
      body: JSON.stringify({
        name: customName || `Backup of ${spreadsheetId} - ${new Date().toISOString()}`,
      }),
    });
    return result.id;
  }

  async restoreBackup(backupId: string, spreadsheetId: string): Promise<void> {
    const targetMeta = await this.getSpreadsheet(spreadsheetId);
    const originalSheets = targetMeta.sheets || [];

    const backupMeta = await this.getSpreadsheet(backupId);
    const backupSheets = backupMeta.sheets || [];

    const copiedSheets: { newSheetId: number; originalTitle: string }[] = [];
    for (const sheet of backupSheets) {
      const copyUrl = `https://sheets.googleapis.com/v4/spreadsheets/${backupId}/sheets/${sheet.properties.sheetId}:copyTo`;
      const copyResult = await this.request(copyUrl, {
        method: 'POST',
        body: JSON.stringify({ destinationSpreadsheetId: spreadsheetId }),
      });
      copiedSheets.push({
        newSheetId: copyResult.sheetId,
        originalTitle: sheet.properties.title,
      });
    }

    const requests: any[] = [];
    for (const sheet of originalSheets) {
      requests.push({
        deleteSheet: { sheetId: sheet.properties.sheetId },
      });
    }
    for (const copied of copiedSheets) {
      requests.push({
        updateSheetProperties: {
          properties: {
            sheetId: copied.newSheetId,
            title: copied.originalTitle,
          },
          fields: 'title',
        },
      });
    }

    await this.batchUpdate(spreadsheetId, requests);
  }

  async getFileMetadata(spreadsheetId: string): Promise<{
    properties: Record<string, string>;
    appProperties: Record<string, string>;
    modifiedTime?: string;
  }> {
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=properties,appProperties,modifiedTime`;
    const metadata = await this.request(fileUrl);
    return {
      properties: metadata.properties || {},
      appProperties: metadata.appProperties || {},
      modifiedTime: metadata.modifiedTime,
    };
  }

  async getFileAppProperties(
    spreadsheetId: string
  ): Promise<{ appProperties: Record<string, string>; modifiedTime?: string }> {
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=appProperties,modifiedTime`;
    const metadata = await this.request(fileUrl);
    return {
      appProperties: metadata.appProperties || {},
      modifiedTime: metadata.modifiedTime,
    };
  }

  async updateFileAppProperties(
    spreadsheetId: string,
    properties: Record<string, string | null>
  ): Promise<void> {
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=appProperties`;
    await this.request(fileUrl, {
      method: 'PATCH',
      body: JSON.stringify({
        appProperties: properties,
      }),
    });
  }

  async updateFileProperties(
    spreadsheetId: string,
    payload: {
      properties?: Record<string, string | null>;
      appProperties?: Record<string, string | null>;
    }
  ): Promise<void> {
    const fileUrl = `https://www.googleapis.com/drive/v3/files/${spreadsheetId}?fields=properties,appProperties`;
    await this.request(fileUrl, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
  }

  async deleteFile(fileId: string): Promise<void> {
    const deleteUrl = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    await this.request(deleteUrl, {
      method: 'DELETE',
    });
  }
}
