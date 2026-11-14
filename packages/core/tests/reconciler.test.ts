import { describe, it, expect } from 'vitest';
import { reconcileLwwRecords } from '../src/index.js';

describe('reconcileLwwRecords', () => {
  it('computes bidirectional pull and push deltas cleanly using LWW', () => {
    const local = [
      { id: '1', name: 'local-newer', updatedAt: '2026-11-05T10:00:00.000Z' },
      { id: '2', name: 'local-older', updatedAt: '2026-11-01T10:00:00.000Z' },
      { id: '3', name: 'local-only', updatedAt: '2026-11-02T10:00:00.000Z' },
    ];
    const remote = [
      { id: '1', name: 'remote-older', updatedAt: '2026-11-01T10:00:00.000Z' },
      { id: '2', name: 'remote-newer', updatedAt: '2026-11-06T10:00:00.000Z' },
      { id: '4', name: 'remote-only', updatedAt: '2026-11-04T10:00:00.000Z' },
    ];

    const result = reconcileLwwRecords(local, remote);
    expect(result.toPushToRemote.map((d) => d.id)).toEqual(['1', '3']);
    expect(result.toPullIntoLocal.map((d) => d.id)).toEqual(['2', '4']);
    expect(result.merged.find((d) => d.id === '1')?.name).toBe('local-newer');
    expect(result.merged.find((d) => d.id === '2')?.name).toBe('remote-newer');
    expect(result.merged).toHaveLength(4);
  });
});
