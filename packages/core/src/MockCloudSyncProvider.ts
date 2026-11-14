import { sanitizeRemoteDocument, shouldAcceptIncomingDoc } from './serializers.js';
import type { CloudSyncProvider, SyncDeltaPayload, SyncStatus } from './types.js';

export interface MockCloudSyncProviderOptions {
  id?: string;
  name?: string;
  description?: string;
  connectedAccount?: string | null;
  shouldSkipPushDoc?: (collection: string, doc: Record<string, any>) => boolean;
}

export class MockCloudSyncProvider implements CloudSyncProvider {
  id: string;
  name: string;
  description?: string;
  private initialized = false;
  private status: SyncStatus = 'disconnected';
  private lastSyncedTime: string | null = null;
  private connectedAccount: string | null;
  private storage: Map<string, Record<string, any>[]> = new Map();
  private statusListeners: Set<(status: SyncStatus, error?: any) => void> = new Set();
  private shouldSkipPushDoc?: (collection: string, doc: Record<string, any>) => boolean;

  constructor(options: MockCloudSyncProviderOptions = {}) {
    this.id = options.id ?? 'mock-sync-adapter';
    this.name = options.name ?? 'Mock Cloud Connector';
    this.description =
      options.description ?? 'Local in-memory cloud simulator for testing sync states';
    this.connectedAccount = options.connectedAccount ?? 'test-user@mock-cloud.internal';
    this.shouldSkipPushDoc = options.shouldSkipPushDoc;
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
    return this.initialized ? this.connectedAccount : null;
  }

  onStatusChange(listener: (status: SyncStatus, error?: any) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  private setStatus(newStatus: SyncStatus, error?: any): void {
    this.status = newStatus;
    for (const listener of this.statusListeners) {
      try {
        listener(newStatus, error);
      } catch (err) {
        console.error('Error in status change listener', err);
      }
    }
  }

  simulateThrottled(durationMs?: number): void {
    this.setStatus('throttled');
    if (durationMs && durationMs > 0) {
      setTimeout(() => {
        if (this.status === 'throttled') {
          this.setStatus('idle');
        }
      }, durationMs);
    }
  }

  simulateAuthFailed(): void {
    this.setStatus('auth_failed');
  }

  simulateOffline(): void {
    this.setStatus('disconnected');
  }

  simulateIdle(): void {
    this.setStatus('idle');
  }

  simulateSyncing(): void {
    this.setStatus('syncing');
  }

  async initialize(_credentials?: any): Promise<void> {
    this.initialized = true;
    this.lastSyncedTime = new Date().toISOString();
    this.setStatus('idle');
  }

  async disconnect(): Promise<void> {
    this.initialized = false;
    this.setStatus('disconnected');
  }

  async reauthenticate(): Promise<void> {
    if (!this.initialized) {
      this.initialized = true;
    }
    this.setStatus('idle');
    this.lastSyncedTime = new Date().toISOString();
  }

  async forceSync(): Promise<void> {
    this.setStatus('syncing');
    await new Promise((resolve) => setTimeout(resolve, 50));
    this.lastSyncedTime = new Date().toISOString();
    this.setStatus('idle');
  }

  async pull(_groupId?: string): Promise<SyncDeltaPayload[]> {
    const results: SyncDeltaPayload[] = [];
    for (const [collection, documents] of this.storage.entries()) {
      results.push({ collection, documents });
    }
    this.lastSyncedTime = new Date().toISOString();
    return results;
  }

  async push(payload: SyncDeltaPayload): Promise<void> {
    this.setStatus('syncing');
    const existing = this.storage.get(payload.collection) || [];

    const map = new Map(
      existing.map((doc) => [doc.id, sanitizeRemoteDocument(payload.collection, doc)])
    );
    for (const doc of payload.documents) {
      if (doc.id) {
        if (this.shouldSkipPushDoc?.(payload.collection, doc)) {
          continue;
        }
        const sanitized = sanitizeRemoteDocument(payload.collection, doc);
        const current = map.get(doc.id);
        if (shouldAcceptIncomingDoc(current, sanitized)) {
          map.set(doc.id, sanitized);
        }
      }
    }

    this.storage.set(payload.collection, Array.from(map.values()));
    this.lastSyncedTime = new Date().toISOString();
    this.setStatus('idle');
  }
}
