# Qozara Cloud Sync (`@qozara/cloud-sync`)

Cloud synchronization primitives, storage-agnostic tabular schema engine, and provider connectors shared across Qozara applications.

## Packages

- [`@qozara/cloud-sync`](./packages/core) — Cloud-agnostic synchronization contracts, error types, Last-Write-Wins (LWW) serializers, sync state evaluator, local reconciler, `SchemaEngine` (`ITabularContainerDriver`, `_meta` manifest provenance & migrations), `CompositeCloudSyncProvider`, and `MockCloudSyncProvider`. Zero runtime dependencies.
- [`@qozara/cloud-sync-google`](./packages/google) — Google Drive and Google Sheets drivers (`GoogleSheetsContainerDriver`, `GoogleValidationService`, `GoogleSheetsTabularDriver` with column-scoped formula-preserving writes, `GoogleDriveBlobDriver`, `GoogleDriveStorageLayer`, `StorageLayerCatalogAndAclDriver`) and `GoogleDriveSheetsCloudSyncProvider`.

## Dependency Direction

```text
@qozara/cloud-sync          (cloud-agnostic sync + schema engine, 0 deps)
        ▲
        │
@qozara/cloud-sync-google   (Google Drive & Google Sheets connector)
```

Adding new cloud connectors (e.g., `@qozara/cloud-sync-azure`, OneDrive, Dropbox, or local SQLite) only requires implementing `BlobStorageDriver`, `TabularStorageDriver`, and `ITabularContainerDriver` against `@qozara/cloud-sync`.

## Development

```bash
npm install
npm run check
npm run lint
npm run build
npm test
```
