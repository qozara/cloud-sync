import type { CloudSyncProvider, SyncStatus, UXSyncState } from './types.js';

export interface ResolveUXStatusParams {
  isOnline: boolean;
  providerConnected?: boolean;
  providerStatus?: SyncStatus;
  adapter?: CloudSyncProvider | { getStatus(): SyncStatus } | null;
  adapterStatus?: SyncStatus;
}

export interface ProviderDiagnostic {
  statusKey: 'notConnected' | 'needsAttention' | 'paused' | 'syncing' | 'connected';
  variant: 'offline' | 'attention' | 'paused' | 'online';
  hasAlertBadge?: boolean;
}

export type ProviderDiagnosticKey =
  | 'synced'
  | 'syncing'
  | 'offline'
  | 'auth_failed'
  | 'throttled'
  | 'corrupted'
  | 'upgrade_required'
  | 'incompatible'
  | 'error'
  | 'disconnected';

/**
 * Pure State Evaluator function mapping low-level network and sync adapter states
 * into the canonical 6-value UXSyncState (`idle | syncing | offline | waiting | error | local`).
 */
export function resolveUXStatus(params: ResolveUXStatusParams): UXSyncState {
  const { isOnline, adapter } = params;
  const status: SyncStatus =
    params.providerStatus !== undefined
      ? params.providerStatus
      : params.adapterStatus !== undefined
        ? params.adapterStatus
        : adapter
          ? adapter.getStatus()
          : 'disconnected';

  const isConnected =
    params.providerConnected !== undefined
      ? params.providerConnected
      : adapter === null
        ? false
        : adapter !== undefined
          ? true
          : status !== 'disconnected';

  // No adapter configured or disconnected
  if (!isConnected || adapter === null || status === 'disconnected') {
    return 'local';
  }

  // Device Offline takes precedence over adapter syncing/waiting/idle
  if (!isOnline) {
    return 'offline';
  }

  // Active sync in progress
  if (status === 'syncing') {
    return 'syncing';
  }

  // 429 Rate Limit / Transient 5xx
  if (status === 'throttled') {
    return 'waiting';
  }

  // Auth Revoked / Persistent Error / Schema Remediation Needed
  if (
    status === 'auth_failed' ||
    status === 'error' ||
    status === 'corrupted' ||
    status === 'upgrade_required' ||
    status === 'incompatible'
  ) {
    return 'error';
  }

  // All clean & synced
  if (status === 'idle' || status === 'synced') {
    return 'idle';
  }

  return 'local';
}

/**
 * Resolves unified visual diagnostic descriptor for Popover and Settings panels (Quomida signature)
 * OR resolves the localization diagnostic key (`sync.diagnostics.*`) (Quozen signature).
 */
export function resolveProviderDiagnostic(
  uxSyncState: UXSyncState,
  hasAdapter: boolean
): ProviderDiagnostic;
export function resolveProviderDiagnostic(
  isOnline: boolean,
  providerConnected: boolean,
  providerStatus: SyncStatus
): ProviderDiagnosticKey;
export function resolveProviderDiagnostic(
  arg1: UXSyncState | boolean,
  arg2: boolean,
  arg3?: SyncStatus
): ProviderDiagnostic | ProviderDiagnosticKey {
  if (typeof arg1 === 'boolean') {
    const isOnline = arg1;
    const providerConnected = arg2;
    const providerStatus = arg3 ?? 'disconnected';

    if (!providerConnected || providerStatus === 'disconnected') {
      return 'disconnected';
    }
    if (!isOnline) {
      return 'offline';
    }
    if (providerStatus === 'syncing') {
      return 'syncing';
    }
    if (
      providerStatus === 'auth_failed' ||
      providerStatus === 'throttled' ||
      providerStatus === 'corrupted' ||
      providerStatus === 'upgrade_required' ||
      providerStatus === 'incompatible' ||
      providerStatus === 'error'
    ) {
      return providerStatus;
    }
    return 'synced';
  }

  const uxSyncState = arg1;
  const hasAdapter = arg2;
  if (!hasAdapter || uxSyncState === 'local') {
    return { statusKey: 'notConnected', variant: 'offline' };
  }
  if (uxSyncState === 'error') {
    return { statusKey: 'needsAttention', variant: 'attention', hasAlertBadge: true };
  }
  if (uxSyncState === 'offline' || uxSyncState === 'waiting') {
    return { statusKey: 'paused', variant: 'paused' };
  }
  if (uxSyncState === 'syncing') {
    return { statusKey: 'syncing', variant: 'online' };
  }
  return { statusKey: 'connected', variant: 'online' };
}
