// storagePartition.ts
// Secure multi-server and per-account storage partitioning for Senora

/**
 * Normalizes a server URL to a canonical origin key (lowercase scheme + host + port).
 */
export function normalizeServerOrigin(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return 'default';
  }
  try {
    const parsed = new URL(rawUrl.trim());
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;
  } catch {
    return rawUrl.trim().toLowerCase().replace(/\/+$/, '');
  }
}

/**
 * Creates a short, URL-safe alphanumeric hash from a string to keep storage keys clean.
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Derives a partitioned storage key for a server and optional user/resource.
 */
export function getPartitionKey(
  baseKey: string,
  serverOrigin: string,
  userId?: string | null
): string {
  const normOrigin = normalizeServerOrigin(serverOrigin);
  const serverTag = hashString(normOrigin);
  if (userId) {
    const userTag = hashString(userId);
    return `senora_s_${serverTag}_u_${userTag}_${baseKey}`;
  }
  return `senora_s_${serverTag}_${baseKey}`;
}

export const storagePartition = {
  getItem(baseKey: string, serverOrigin: string, userId?: string | null): string | null {
    if (typeof localStorage === 'undefined') return null;
    const key = getPartitionKey(baseKey, serverOrigin, userId);
    return localStorage.getItem(key);
  },

  setItem(baseKey: string, value: string, serverOrigin: string, userId?: string | null): void {
    if (typeof localStorage === 'undefined') return;
    const key = getPartitionKey(baseKey, serverOrigin, userId);
    localStorage.setItem(key, value);
  },

  removeItem(baseKey: string, serverOrigin: string, userId?: string | null): void {
    if (typeof localStorage === 'undefined') return;
    const key = getPartitionKey(baseKey, serverOrigin, userId);
    localStorage.removeItem(key);
  },

  clearServerData(serverOrigin: string): void {
    if (typeof localStorage === 'undefined') return;
    const normOrigin = normalizeServerOrigin(serverOrigin);
    const serverTag = hashString(normOrigin);
    const prefix = `senora_s_${serverTag}_`;
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => localStorage.removeItem(k));
  },
};
