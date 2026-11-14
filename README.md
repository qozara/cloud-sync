# Qozara Cloud Sync (`@qozara/cloud-sync`)

Cloud synchronization primitives and provider connectors shared across Qozara applications.

## Packages

- [`@qozara/cloud-sync`](./packages/core) — Cloud-agnostic synchronization contracts, error types, Last-Write-Wins (LWW) serializers, sync state evaluator, local reconciler, `CompositeCloudSyncProvider`, and `MockCloudSyncProvider`. Has zero runtime dependencies.
- [`@qozara/cloud-sync-google`](./packages/google) — Google Drive and Google Sheets synchronization drivers (`GoogleDriveBlobDriver`, `GoogleSheetsTabularDriver`, `StorageLayerCatalogAndAclDriver`) and `GoogleDriveSheetsCloudSyncProvider`, built on `@qozara/cloud-sync` and `@qozara/gdocs-schema`.

## Dependency Direction

```text
@qozara/cloud-sync          (cloud-agnostic contracts & sync primitives, 0 deps)
        ▲
        │
@qozara/cloud-sync-google   ───► @qozara/gdocs-schema (Google Sheets/Drive schema & API SDK)
```

`@qozara/gdocs-schema` remains independent of `@qozara/cloud-sync`, allowing new cloud connector packages (e.g., Dropbox, OneDrive, iCloud) to be added under `packages/` in this repository without coupling provider SDKs to cloud-sync abstractions.

## Development

```bash
npm install
npm run check
npm run lint
npm run build
npm test
```
