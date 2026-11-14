export type SyncStatus =
  | 'idle'
  | 'syncing'
  | 'throttled'
  | 'auth_failed'
  | 'disconnected'
  | 'synced'
  | 'corrupted'
  | 'upgrade_required'
  | 'incompatible'
  | 'error';

export type UXSyncState =
  | 'syncing'
  | 'offline'
  | 'waiting'
  | 'error'
  | 'idle'
  | 'local';

export interface SyncDeltaPayload {
  collection: string;
  groupId?: string;
  documents: Record<string, any>[];
  checkpoint?: string;
}

export interface CloudSyncProviderMetadata {
  id: string;
  name: string;
  description?: string;
  connectedAccount?: string | null;
}

export interface BlobStorageDriver {
  id: string;
  name: string;
  readBlob<T = any>(filename: string): Promise<T | null>;
  writeBlob<T = any>(filename: string, data: T): Promise<void>;
  deleteBlob?(filename: string): Promise<void>;
  getRemoteLinks?(): Promise<string[]>;
}

export interface TabularRow {
  id: string;
  values: any[];
  headers?: string[];
  updatedAt?: number | string;
  _deleted?: boolean;
  deletedAt?: string | null;
}

export interface TabularStorageDriver {
  id: string;
  name: string;
  ensureDocument?(title: string, tabs: string[]): Promise<string>;
  readTable(documentId: string, tabName: string): Promise<TabularRow[]>;
  writeTable(
    documentId: string,
    tabName: string,
    headers: string[],
    rows: TabularRow[]
  ): Promise<void>;
  repairTable?(
    documentId: string,
    tabNameOrExpectedLastModified?: string,
    expectedLastModified?: string
  ): Promise<void>;
  migrateTable?(documentId: string, expectedLastModified?: string): Promise<void>;
  checkHealth?(documentId: string): Promise<any>;
  getRemoteLinks?(): Promise<string[]>;
}

export type CollectionRoute =
  | {
      target: 'blob';
      filename: string;
    }
  | {
      target: 'tabular';
      tabName: string;
      documentKey?: string;
      documentTitle?: string;
    };

export interface CollectionSerializer {
  headers: string[];
  docToRow(doc: Record<string, any>): TabularRow;
  rowToDoc(row: TabularRow): Record<string, any>;
}

export interface GroupTabularSerializer {
  defaultHeaders: string[];
  rowToDoc(row: TabularRow, groupId: string): Record<string, any>;
  docToRow(doc: Record<string, any>, headers?: string[]): TabularRow;
}

export interface CompositeCloudSyncProviderOptions {
  id: string;
  name: string;
  description?: string;
  blobDriver?: BlobStorageDriver;
  tabularDriver?: TabularStorageDriver;
  routes?: Record<string, CollectionRoute>;
  activeGroupId?: string | null;
  serializers?: Record<string, CollectionSerializer>;
  groupSerializers?: Record<string, GroupTabularSerializer>;
  normalizeBlobDoc?: (collection: string, raw: any) => Record<string, any>;
  mergeBlobPush?: (
    collection: string,
    pushDocs: Record<string, any>[],
    existingDocs: Record<string, any>[],
    context: { lastPulledUpdatedAt: string | null; tabularDriver?: TabularStorageDriver }
  ) => Promise<{ docsToWrite: Record<string, any>[]; nextLastPulledUpdatedAt?: string | null }>;
  shouldSkipTabularPushDoc?: (collection: string, doc: Record<string, any>) => boolean;
  filterPulledTabularDoc?: (collection: string, doc: Record<string, any>) => boolean;
}

export interface CloudSyncProvider {
  id: string;
  name: string;
  description?: string;
  isInitialized(): boolean;
  getStatus(): SyncStatus;
  getLastSyncedTime(): string | null;
  getLastError?(): any;
  getConnectedAccount?(): string | null;
  getUserPicture?(): string | null;
  initialize(credentials?: any): Promise<void>;
  disconnect?(): Promise<void>;
  reauthenticate?(): Promise<void>;
  forceSync?(): Promise<void>;
  getRemoteLinks?(): Promise<string[]>;
  repair?(groupId?: string): Promise<void>;
  migrate?(groupId?: string): Promise<void>;
  getSchemaDiagnostic?(): Promise<{
    status: SyncStatus;
    missingColumns?: Record<string, string[]>;
    missingTabs?: string[];
  } | null>;
  pull(groupId?: string): Promise<SyncDeltaPayload[]>;
  push(payload: SyncDeltaPayload): Promise<void>;
  onStatusChange?(listener: (status: SyncStatus, error?: any) => void): () => void;
  onCredentialsChange?(listener: (credentials: any) => void): () => void;
}

export type CollaboratorRole = 'owner' | 'editor' | 'viewer';
export type GroupAccessMode = 'public' | 'restricted';
export type GroupAccountKind = 'personal' | 'shared' | 'offline';

export interface GroupCollaborator {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  role: CollaboratorRole;
}

export interface CloudContainerMetadata {
  id: string;
  name: string;
  isOwner: boolean;
  lastAccessed?: string;
  createdTime?: string;
  properties?: Record<string, string>;
  owners?: Array<{ emailAddress?: string }>;
  capabilities?: { canDelete?: boolean };
}

export interface CloudGroupCatalogDriver {
  id: string;
  name: string;
  listGroupContainers(): Promise<CloudContainerMetadata[]>;
  getGroupContainer(groupId: string): Promise<CloudContainerMetadata | null>;
  createGroupContainer(
    title: string,
    sheetTitles: string[],
    properties?: Record<string, string>
  ): Promise<string>;
  updateGroupContainer(
    groupId: string,
    metadata: { name?: string; properties?: Record<string, string> }
  ): Promise<void>;
  deleteGroupContainer(groupId: string): Promise<void>;
  checkContainerHealth(
    groupId: string
  ): Promise<{ available: boolean; reason?: 'trashed' | 'deleted' }>;
}

export interface CloudAccessControlDriver {
  id: string;
  name: string;
  listCollaborators(groupId: string): Promise<GroupCollaborator[]>;
  grantAccess(
    groupId: string,
    email: string,
    role?: 'editor' | 'viewer'
  ): Promise<{ displayName?: string }>;
  revokeAccess(groupId: string, collaboratorIdOrEmail: string): Promise<void>;
  getAccessMode(groupId: string): Promise<GroupAccessMode>;
  setAccessMode(groupId: string, mode: GroupAccessMode): Promise<void>;
}
