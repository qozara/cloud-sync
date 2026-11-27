import type { BlobStorageDriver } from '@qozara/cloud-sync';
import type { GoogleDriverOptions, GoogleHttpClient } from './googleTypes.js';
import type { IStorageLayer } from './IStorageLayer.js';

export interface GoogleDriveBlobDriverOptions extends GoogleDriverOptions {
  enableLegacyRootMigration?: boolean;
  multipartBoundary?: string;
}

export class GoogleDriveBlobDriver implements BlobStorageDriver {
  id = 'google-drive-appdata-blob';
  name = 'Google Drive AppData Blob Driver';

  private getAccessToken: () => string | null;
  private client: GoogleHttpClient;
  private storageLayer?: IStorageLayer;
  private fileIdCache: Map<string, string> = new Map();
  private writeQueues: Map<string, Promise<void>> = new Map();
  private enableLegacyRootMigration: boolean;
  private multipartBoundary: string;

  constructor(options: GoogleDriveBlobDriverOptions) {
    this.getAccessToken = options.getAccessToken;
    this.storageLayer = options.storageLayer;
    this.enableLegacyRootMigration = options.enableLegacyRootMigration ?? false;
    this.multipartBoundary = options.multipartBoundary ?? '-------quomida_blob_boundary';
    this.client = options.httpClient || {
      fetch: (url, init) => globalThis.fetch(url, init),
    };
  }

  private getAuthHeaders(): Record<string, string> {
    const token = this.getAccessToken();
    if (!token) {
      throw new Error('Google Auth Failed: Access token is missing or expired');
    }
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  private async handleResponseErrors(res: Response, context: string): Promise<void> {
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
      if (res.status === 429) {
        throw new Error(`Google Drive API Rate Limit / Quota Exceeded (429) during ${context}`);
      }
      throw new Error(
        `Google Drive API Error (${res.status}) during ${context}. Details: ${errText}`
      );
    }
  }

  private async findFileInAppData(filename: string, bypassCache = false): Promise<string | null> {
    if (!bypassCache && this.fileIdCache.has(filename)) {
      return this.fileIdCache.get(filename)!;
    }

    const headers = this.getAuthHeaders();
    const query = encodeURIComponent(`name = '${filename}' and trashed = false`);
    const orderBy = encodeURIComponent('modifiedTime desc');
    const url = `https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${query}&orderBy=${orderBy}&fields=files(id,name,modifiedTime,createdTime)`;

    const res = await this.client.fetch(url, { method: 'GET', headers });
    await this.handleResponseErrors(res, 'searching appDataFolder');

    const json = (await res.json()) as any;
    if (json.files && json.files.length > 0) {
      const files = [...json.files].sort(
        (a: any, b: any) =>
          new Date(b.modifiedTime || b.createdTime || 0).getTime() -
          new Date(a.modifiedTime || a.createdTime || 0).getTime()
      );
      const primaryId: string = files[0].id;
      this.fileIdCache.set(filename, primaryId);

      if (files.length > 1) {
        for (const dup of files.slice(1)) {
          if (dup?.id && dup.id !== primaryId) {
            this.client
              .fetch(`https://www.googleapis.com/drive/v3/files/${dup.id}`, {
                method: 'DELETE',
                headers,
              })
              .catch(() => {});
          }
        }
      }

      return primaryId;
    }
    return null;
  }

  private async findLegacyFileInRootDrive(filename: string): Promise<string | null> {
    const headers = this.getAuthHeaders();
    const query = encodeURIComponent(`name = '${filename}' and trashed = false`);
    const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,createdTime)`;

    const res = await this.client.fetch(url, { method: 'GET', headers });
    if (!res.ok) return null;

    const json = (await res.json()) as any;
    if (json.files && json.files.length > 0) {
      return json.files[0].id;
    }
    return null;
  }

  async readBlob<T = any>(filename: string): Promise<T | null> {
    if (this.storageLayer && !this.getAccessToken()) {
      const files = await this.storageLayer.listFiles(
        `name = '${filename}' and trashed = false`
      );
      if (files.length === 0) return null;
      let fileToUse = files[0];
      if (files.length > 1) {
        const sortedFiles = [...files].sort(
          (a: any, b: any) =>
            new Date(b.modifiedTime || b.createdTime || 0).getTime() -
            new Date(a.modifiedTime || a.createdTime || 0).getTime()
        );
        fileToUse = sortedFiles[0];
        for (const dup of sortedFiles.slice(1)) {
          await this.storageLayer.deleteFile(dup.id).catch(() => {});
        }
      }
      const data = await this.storageLayer.getFile(fileToUse.id, { alt: 'media' });
      return (data as T) || null;
    }

    const headers = this.getAuthHeaders();
    let fileId = await this.findFileInAppData(filename);

    if (fileId) {
      let url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
      let res = await this.client.fetch(url, { method: 'GET', headers });
      if (res.status === 404) {
        this.fileIdCache.delete(filename);
        fileId = await this.findFileInAppData(filename, true);
        if (!fileId) return null;
        url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        res = await this.client.fetch(url, { method: 'GET', headers });
      }
      await this.handleResponseErrors(res, 'reading blob from appDataFolder');
      return (await res.json()) as T;
    }

    if (this.enableLegacyRootMigration) {
      const legacyFileId = await this.findLegacyFileInRootDrive(filename);
      if (legacyFileId) {
        const url = `https://www.googleapis.com/drive/v3/files/${legacyFileId}?alt=media`;
        const res = await this.client.fetch(url, { method: 'GET', headers });
        if (res.ok) {
          const legacyData = (await res.json()) as T;
          try {
            await this.writeBlob(filename, legacyData);
          } catch (e) {
            console.warn('[GoogleDriveBlobDriver] Failed to write migrated blob to appDataFolder:', e);
          }
          return legacyData;
        }
      }
    }

    return null;
  }

  async writeBlob<T = any>(filename: string, data: T): Promise<void> {
    const previousQueue = this.writeQueues.get(filename) || Promise.resolve();
    const nextQueue = (async () => {
      await previousQueue.catch(() => {});
      await this.doWriteBlob(filename, data);
    })();
    this.writeQueues.set(filename, nextQueue);
    return nextQueue;
  }

  private async doWriteBlob<T = any>(filename: string, data: T): Promise<void> {
    if (this.storageLayer && !this.getAccessToken()) {
      const files = await this.storageLayer.listFiles(
        `name = '${filename}' and trashed = false`
      );
      if (files.length > 0) {
        let fileToUse = files[0];
        if (files.length > 1) {
          const sortedFiles = [...files].sort(
            (a: any, b: any) =>
              new Date(b.modifiedTime || b.createdTime || 0).getTime() -
              new Date(a.modifiedTime || a.createdTime || 0).getTime()
          );
          fileToUse = sortedFiles[0];
          for (const dup of sortedFiles.slice(1)) {
            await this.storageLayer.deleteFile(dup.id).catch(() => {});
          }
        }
        await this.storageLayer.updateFile(fileToUse.id, {}, JSON.stringify(data));
      } else {
        await this.storageLayer.createFile(filename, 'application/json', {}, JSON.stringify(data));
      }
      return;
    }

    let existingFileId = await this.findFileInAppData(filename);
    const headers = this.getAuthHeaders();
    const boundary = this.multipartBoundary;
    const delimiter = `\r\n--${boundary}\r\n`;
    const closeDelimiter = `\r\n--${boundary}--`;

    const buildBody = (isUpdate: boolean) => {
      const metadata = isUpdate
        ? { name: filename }
        : { name: filename, parents: ['appDataFolder'] };

      return (
        delimiter +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) +
        delimiter +
        'Content-Type: application/json\r\n\r\n' +
        JSON.stringify(data) +
        closeDelimiter
      );
    };

    const sendUpload = async (targetFileId: string | null) => {
      const url = targetFileId
        ? `https://www.googleapis.com/upload/drive/v3/files/${targetFileId}?uploadType=multipart`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';
      const method = targetFileId ? 'PATCH' : 'POST';

      return this.client.fetch(url, {
        method,
        headers: {
          ...headers,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body: buildBody(Boolean(targetFileId)),
      });
    };

    let res = await sendUpload(existingFileId);
    if (existingFileId && res.status === 404) {
      this.fileIdCache.delete(filename);
      existingFileId = await this.findFileInAppData(filename, true);
      res = await sendUpload(existingFileId);
    }

    await this.handleResponseErrors(res, 'writing blob to appDataFolder');

    try {
      const resJson = (await res.json()) as any;
      if (resJson && typeof resJson.id === 'string' && resJson.id) {
        this.fileIdCache.set(filename, resJson.id);
      }
    } catch {
      // Ignore empty/non-JSON response body on upload
    }
  }

  async deleteBlob(filename: string): Promise<void> {
    if (this.storageLayer && !this.getAccessToken()) {
      const files = await this.storageLayer.listFiles(
        `name = '${filename}' and trashed = false`
      );
      for (const f of files) {
        await this.storageLayer.deleteFile(f.id);
      }
      return;
    }

    const fileId = await this.findFileInAppData(filename);
    this.fileIdCache.delete(filename);
    if (!fileId) return;

    const headers = this.getAuthHeaders();
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;
    const res = await this.client.fetch(url, { method: 'DELETE', headers });
    await this.handleResponseErrors(res, 'deleting blob from appDataFolder');
  }
}
