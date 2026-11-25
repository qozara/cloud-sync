import {
  CompositeCloudSyncProvider,
  type CollectionRoute,
  type CollectionSerializer,
  type CompositeCloudSyncProviderOptions,
  type GroupTabularSerializer,
  type SyncDeltaPayload,
} from '@qozara/cloud-sync';
import type { GoogleHttpClient } from '@qozara/gdocs-schema';
import {
  GoogleDriveBlobDriver,
  type GoogleDriveBlobDriverOptions,
} from './GoogleDriveBlobDriver.js';
import {
  GoogleSheetsTabularDriver,
  type GoogleSheetsTabularDriverOptions,
} from './GoogleSheetsTabularDriver.js';

export interface GoogleDriveSheetsCloudSyncProviderOptions {
  id?: string;
  name?: string;
  description?: string;
  httpClient?: GoogleHttpClient;
  routes?: Record<string, CollectionRoute>;
  serializers?: Record<string, CollectionSerializer>;
  groupSerializers?: Record<string, GroupTabularSerializer>;
  blobDriverOptions?: Partial<Omit<GoogleDriveBlobDriverOptions, 'getAccessToken'>>;
  tabularDriverOptions?: Partial<Omit<GoogleSheetsTabularDriverOptions, 'getAccessToken'>>;
  shouldSkipTabularPushDoc?: CompositeCloudSyncProviderOptions['shouldSkipTabularPushDoc'];
  filterPulledTabularDoc?: CompositeCloudSyncProviderOptions['filterPulledTabularDoc'];
  mergeBlobPush?: CompositeCloudSyncProviderOptions['mergeBlobPush'];
  normalizeBlobDoc?: CompositeCloudSyncProviderOptions['normalizeBlobDoc'];
  getAccessToken?: () => string | null;
  onTokenRefresh?: () => Promise<string>;
  now?: () => number;
}

export class GoogleDriveSheetsCloudSyncProvider extends CompositeCloudSyncProvider {
  protected accessToken: string | null = null;
  protected userEmail: string | null = null;
  protected userName: string | null = null;
  protected userPicture: string | null = null;
  protected httpClient?: GoogleHttpClient;
  protected externalGetAccessToken?: () => string | null;
  protected onTokenRefresh?: () => Promise<string>;
  protected now: () => number;

  constructor(options?: GoogleDriveSheetsCloudSyncProviderOptions) {
    const httpClient = options?.httpClient;
    let resolveToken = (): string | null => null;

    const blobDriver = new GoogleDriveBlobDriver({
      ...options?.blobDriverOptions,
      getAccessToken: () => resolveToken(),
      httpClient: options?.blobDriverOptions?.httpClient ?? httpClient,
    });

    const tabularDriver = new GoogleSheetsTabularDriver({
      ...options?.tabularDriverOptions,
      getAccessToken: () => resolveToken(),
      httpClient: options?.tabularDriverOptions?.httpClient ?? httpClient,
    });

    super({
      id: options?.id ?? 'google-drive-sheets',
      name: options?.name ?? 'Google Drive / Sheets BYOS Adapter',
      description:
        options?.description ?? 'Direct synchronization to personal Google Drive spreadsheets',
      blobDriver,
      tabularDriver,
      routes: options?.routes,
      serializers: options?.serializers,
      groupSerializers: options?.groupSerializers,
      shouldSkipTabularPushDoc: options?.shouldSkipTabularPushDoc,
      filterPulledTabularDoc: options?.filterPulledTabularDoc,
      mergeBlobPush: options?.mergeBlobPush,
      normalizeBlobDoc: options?.normalizeBlobDoc,
    });

    this.httpClient = httpClient;
    this.externalGetAccessToken = options?.getAccessToken;
    this.onTokenRefresh = options?.onTokenRefresh;
    this.now = options?.now ?? (() => Date.now());
    resolveToken = () => this.getEffectiveAccessToken();
  }

  protected getEffectiveAccessToken(): string | null {
    if (this.externalGetAccessToken) {
      const ext = this.externalGetAccessToken();
      if (ext && ext.trim()) {
        return ext.trim();
      }
      return this.accessToken;
    }
    return this.accessToken;
  }

  override isInitialized(): boolean {
    return this.initialized && Boolean(this.getEffectiveAccessToken());
  }

  override getConnectedAccount(): string | null {
    if (!this.isInitialized()) return null;
    if (this.userName && this.userEmail) {
      return `${this.userName} (${this.userEmail})`;
    }
    if (this.userEmail) {
      return this.userEmail;
    }
    if (this.userName) {
      return this.userName;
    }
    return 'google-user@drive.google.com';
  }

  override getUserPicture(): string | null {
    return this.userPicture;
  }

  override async initialize(credentials?: string | Record<string, any>): Promise<void> {
    let hadExpiredProvidedCredentials = false;

    if (typeof credentials === 'string') {
      this.accessToken = credentials.trim() || null;
      this.userEmail = null;
      this.userName = null;
      this.userPicture = null;
    } else if (credentials && typeof credentials === 'object') {
      this.userEmail = credentials.userEmail || null;
      this.userName = credentials.userName || null;
      this.userPicture = credentials.userPicture || null;
      if (credentials.httpClient) {
        this.httpClient = credentials.httpClient;
      }

      const isProvidedTokenExpired =
        typeof credentials.expiresAt === 'number' &&
        Number.isFinite(credentials.expiresAt) &&
        credentials.expiresAt <= this.now();

      if (isProvidedTokenExpired) {
        this.accessToken = null;
        hadExpiredProvidedCredentials = true;
      } else if (typeof credentials.accessToken === 'string' && credentials.accessToken.trim()) {
        this.accessToken = credentials.accessToken.trim();
      }
    }

    const activeToken = this.getEffectiveAccessToken();
    if (activeToken) {
      this.initialized = true;
      this.lastSyncedTime = new Date(this.now()).toISOString();
      this.setStatus('idle');
      return;
    }

    // If initialized on boot with expired persisted credentials, do not trigger an unprompted popup;
    // preserve profile state and report 'auth_failed' so the user can reconnect interactively.
    if (hadExpiredProvidedCredentials) {
      this.initialized = true;
      this.setStatus('auth_failed');
      return;
    }

    if (this.onTokenRefresh) {
      try {
        const refreshed = await this.onTokenRefresh();
        this.accessToken = refreshed;
        this.initialized = true;
        this.lastSyncedTime = new Date(this.now()).toISOString();
        this.setStatus('idle');
        this.notifyCredentialsChange({
          accessToken: refreshed,
          userEmail: this.userEmail,
          userName: this.userName,
          ...(this.userPicture ? { userPicture: this.userPicture } : {}),
          expiresAt: this.now() + 3500000,
        });
      } catch {
        this.initialized = false;
        this.setStatus('auth_failed');
      }
    } else {
      this.initialized = false;
      this.setStatus('disconnected');
    }
  }

  override async disconnect(): Promise<void> {
    this.accessToken = null;
    this.userEmail = null;
    this.userName = null;
    this.userPicture = null;
    await super.disconnect();
  }

  override async reauthenticate(): Promise<void> {
    if (this.onTokenRefresh) {
      try {
        const newToken = await this.onTokenRefresh();
        this.accessToken = newToken;
        this.initialized = true;
        this.setStatus('idle');
        this.lastSyncedTime = new Date(this.now()).toISOString();
        this.notifyCredentialsChange({
          accessToken: newToken,
          userEmail: this.userEmail,
          userName: this.userName,
          ...(this.userPicture ? { userPicture: this.userPicture } : {}),
          expiresAt: this.now() + 3500000,
        });
        return;
      } catch {
        this.setStatus('auth_failed');
        return;
      }
    }

    if (this.getEffectiveAccessToken()) {
      this.initialized = true;
      this.setStatus('idle');
      this.lastSyncedTime = new Date(this.now()).toISOString();
    } else {
      this.setStatus('auth_failed');
    }
  }

  override async push(payload: SyncDeltaPayload): Promise<void> {
    if (!this.isInitialized()) {
      return;
    }
    await super.push(payload);
  }

  override async pull(groupId?: string): Promise<SyncDeltaPayload[]> {
    if (!this.isInitialized()) {
      return [];
    }
    return super.pull(groupId);
  }
}
