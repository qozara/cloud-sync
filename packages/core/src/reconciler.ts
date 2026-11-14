import { parseTimestampMs, shouldAcceptIncomingDoc } from './serializers.js';

export type TimestampedRecord = Record<string, any> & {
  id: string;
  updatedAt?: number | string;
  _deleted?: boolean;
};

export interface ReconcileResult<T extends TimestampedRecord> {
  toPullIntoLocal: T[];
  toPushToRemote: T[];
  merged: T[];
}

export function compareTimestamps(a: unknown, b: unknown): number {
  const ta = parseTimestampMs(a);
  const tb = parseTimestampMs(b);
  if (ta > tb) return 1;
  if (ta < tb) return -1;
  return 0;
}

export function normalizeTimestamp(value: unknown, fallback?: string): string {
  const ms = parseTimestampMs(value);
  if (ms > 0) {
    return new Date(ms).toISOString();
  }
  return fallback ?? new Date().toISOString();
}

/**
 * Pure LWW diff computation between local and remote document collections.
 */
export function reconcileLwwRecords<T extends TimestampedRecord>(
  localDocs: readonly T[],
  remoteDocs: readonly T[]
): ReconcileResult<T> {
  const localById = new Map<string, T>();
  const remoteById = new Map<string, T>();

  for (const doc of localDocs) {
    if (doc && typeof doc.id === 'string') {
      localById.set(doc.id, doc);
    }
  }
  for (const doc of remoteDocs) {
    if (doc && typeof doc.id === 'string') {
      remoteById.set(doc.id, doc);
    }
  }

  const toPullIntoLocal: T[] = [];
  const toPushToRemote: T[] = [];
  const mergedMap = new Map<string, T>();

  for (const [id, remoteDoc] of remoteById.entries()) {
    const localDoc = localById.get(id);
    if (!localDoc) {
      toPullIntoLocal.push(remoteDoc);
      mergedMap.set(id, remoteDoc);
    } else if (
      parseTimestampMs(remoteDoc.updatedAt) > parseTimestampMs(localDoc.updatedAt) ||
      (parseTimestampMs(remoteDoc.updatedAt) === parseTimestampMs(localDoc.updatedAt) &&
        Boolean(remoteDoc._deleted) &&
        !localDoc._deleted)
    ) {
      toPullIntoLocal.push(remoteDoc);
      mergedMap.set(id, remoteDoc);
    } else {
      mergedMap.set(id, localDoc);
    }
  }

  for (const [id, localDoc] of localById.entries()) {
    const remoteDoc = remoteById.get(id);
    if (!remoteDoc) {
      toPushToRemote.push(localDoc);
      mergedMap.set(id, localDoc);
    } else if (
      parseTimestampMs(localDoc.updatedAt) > parseTimestampMs(remoteDoc.updatedAt) ||
      (parseTimestampMs(localDoc.updatedAt) === parseTimestampMs(remoteDoc.updatedAt) &&
        Boolean(localDoc._deleted) &&
        !remoteDoc._deleted) ||
      (!mergedMap.has(id) && shouldAcceptIncomingDoc(remoteDoc, localDoc))
    ) {
      toPushToRemote.push(localDoc);
      mergedMap.set(id, localDoc);
    }
  }

  return {
    toPullIntoLocal,
    toPushToRemote,
    merged: Array.from(mergedMap.values()),
  };
}
