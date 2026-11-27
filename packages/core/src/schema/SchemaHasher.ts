import type { SchemaDefinition } from './types.js';

export async function computeSchemaHash(
  schema: SchemaDefinition,
  customHasher?: (data: string) => Promise<string>
): Promise<string> {
  const canonical = {
    version: schema.version,
    ...(schema.identity
      ? {
          identity: {
            appId: schema.identity.appId,
            docType: schema.identity.docType,
          },
        }
      : {}),
    tabs: schema.tabs.map((tab) => ({
      name: tab.name,
      columns: tab.columns.map((col) => ({
        name: col.name,
        type: col.type,
        required: col.required !== false,
      })),
    })),
  };

  const dataStr = JSON.stringify(canonical);

  if (customHasher) {
    return customHasher(dataStr);
  }

  const encoder = new TextEncoder();
  const data = encoder.encode(dataStr);
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
