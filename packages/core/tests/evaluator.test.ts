import { describe, it, expect } from 'vitest';
import { resolveUXStatus, resolveProviderDiagnostic } from '../src/index.js';

describe('resolveUXStatus & resolveProviderDiagnostic', () => {
  it('resolves canonical 6-state UXSyncState for both Quomida and Quozen inputs', () => {
    expect(resolveUXStatus({ isOnline: true, adapter: null })).toBe('local');
    expect(resolveUXStatus({ isOnline: true, providerConnected: false, providerStatus: 'idle' })).toBe('local');
    expect(resolveUXStatus({ isOnline: true, providerConnected: true, providerStatus: 'disconnected' })).toBe('local');

    expect(resolveUXStatus({ isOnline: false, adapterStatus: 'idle' })).toBe('offline');
    expect(resolveUXStatus({ isOnline: false, providerConnected: true, providerStatus: 'syncing' })).toBe('offline');

    expect(resolveUXStatus({ isOnline: true, adapterStatus: 'syncing' })).toBe('syncing');
    expect(resolveUXStatus({ isOnline: true, adapterStatus: 'throttled' })).toBe('waiting');

    expect(resolveUXStatus({ isOnline: true, adapterStatus: 'auth_failed' })).toBe('error');
    expect(resolveUXStatus({ isOnline: true, adapterStatus: 'corrupted' })).toBe('error');
    expect(resolveUXStatus({ isOnline: true, adapterStatus: 'upgrade_required' })).toBe('error');
    expect(resolveUXStatus({ isOnline: true, providerConnected: true, providerStatus: 'incompatible' })).toBe('error');
    expect(resolveUXStatus({ isOnline: true, providerConnected: true, providerStatus: 'unmanaged' })).toBe('error');
    expect(resolveUXStatus({ isOnline: true, providerConnected: true, providerStatus: 'foreign_app' })).toBe('error');

    expect(resolveUXStatus({ isOnline: true, adapterStatus: 'idle' })).toBe('idle');
    expect(resolveUXStatus({ isOnline: true, providerConnected: true, providerStatus: 'synced' })).toBe('idle');
  });

  it('supports both resolveProviderDiagnostic overloads cleanly', () => {
    expect(resolveProviderDiagnostic('local', false)).toEqual({
      statusKey: 'notConnected',
      variant: 'offline',
    });
    expect(resolveProviderDiagnostic('error', true)).toEqual({
      statusKey: 'needsAttention',
      variant: 'attention',
      hasAlertBadge: true,
    });
    expect(resolveProviderDiagnostic('waiting', true)).toEqual({
      statusKey: 'paused',
      variant: 'paused',
    });
    expect(resolveProviderDiagnostic('syncing', true)).toEqual({
      statusKey: 'syncing',
      variant: 'online',
    });
    expect(resolveProviderDiagnostic('idle', true)).toEqual({
      statusKey: 'connected',
      variant: 'online',
    });

    expect(resolveProviderDiagnostic(true, false, 'idle')).toBe('disconnected');
    expect(resolveProviderDiagnostic(false, true, 'idle')).toBe('offline');
    expect(resolveProviderDiagnostic(true, true, 'syncing')).toBe('syncing');
    expect(resolveProviderDiagnostic(true, true, 'auth_failed')).toBe('auth_failed');
    expect(resolveProviderDiagnostic(true, true, 'incompatible')).toBe('incompatible');
    expect(resolveProviderDiagnostic(true, true, 'unmanaged')).toBe('unmanaged');
    expect(resolveProviderDiagnostic(true, true, 'foreign_app')).toBe('foreign_app');
    expect(resolveProviderDiagnostic(true, true, 'idle')).toBe('synced');
  });
});
