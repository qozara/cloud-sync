import { describe, it, expect } from 'vitest';
import { MockCloudSyncProvider } from '../src/index.js';

describe('MockCloudSyncProvider', () => {
  it('supports initialize, push, pull with LWW, and status simulation hooks', async () => {
    const mock = new MockCloudSyncProvider({
      shouldSkipPushDoc: (_col, doc) => doc.source === 'system',
    });

    expect(mock.isInitialized()).toBe(false);
    await mock.initialize();
    expect(mock.isInitialized()).toBe(true);
    expect(mock.getStatus()).toBe('idle');

    await mock.push({
      collection: 'base_ingredients',
      documents: [
        { id: 'sys-1', name: 'Sys', source: 'system', updatedAt: 10 },
        { id: 'i1', name: 'Flour', updatedAt: 100 },
      ],
    });
    const deltas = await mock.pull();
    expect(deltas).toHaveLength(1);
    expect(deltas[0].documents).toHaveLength(1);

    mock.simulateThrottled();
    expect(mock.getStatus()).toBe('throttled');
    mock.simulateAuthFailed();
    expect(mock.getStatus()).toBe('auth_failed');
    mock.simulateOffline();
    expect(mock.getStatus()).toBe('disconnected');
  });
});
