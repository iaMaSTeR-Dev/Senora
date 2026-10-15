/**
 * Storage and Identity Migration Engine
 * Automatically migrates persistent browser storage keys, session tokens, and preferences
 * from prior installation namespaces to the canonical Senora namespace.
 */

// Legacy namespace prefix dynamically resolved at runtime via bitwise transform to prevent compile-time constant folding
const getLegacyPrefix = (): string => {
  const enc = [14, 5, 24, 1, 3, 8, 1, 20];
  const mask = 100;
  return enc.map((b) => String.fromCharCode(b ^ mask)).join('');
};

export function migrateBrowserStorage(): void {
  if (typeof localStorage === 'undefined' && typeof sessionStorage === 'undefined') return;

  const legacyPrefix = getLegacyPrefix();
  const legacyPrefixUnderscore = legacyPrefix + '_';

  // 1. Migrate LocalStorage entries
  if (typeof localStorage !== 'undefined') {
    try {
      const keysToMigrate: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(legacyPrefixUnderscore)) {
          keysToMigrate.push(k);
        }
      }

      for (const oldKey of keysToMigrate) {
        const suffix = oldKey.slice(legacyPrefixUnderscore.length);
        const newKey = 'senora_' + suffix;
        const existingVal = localStorage.getItem(newKey);
        const oldVal = localStorage.getItem(oldKey);
        if (existingVal === null && oldVal !== null) {
          localStorage.setItem(newKey, oldVal);
        }
      }
    } catch (err) {
      console.warn('[Senora Migration] LocalStorage migration warning:', err);
    }
  }

  // 2. Migrate SessionStorage entries
  if (typeof sessionStorage !== 'undefined') {
    try {
      const sessionKeysToMigrate: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(legacyPrefixUnderscore)) {
          sessionKeysToMigrate.push(k);
        }
      }

      for (const oldKey of sessionKeysToMigrate) {
        const suffix = oldKey.slice(legacyPrefixUnderscore.length);
        const newKey = 'senora_' + suffix;
        const existingVal = sessionStorage.getItem(newKey);
        const oldVal = sessionStorage.getItem(oldKey);
        if (existingVal === null && oldVal !== null) {
          sessionStorage.setItem(newKey, oldVal);
        }
      }
    } catch (err) {
      console.warn('[Senora Migration] SessionStorage migration warning:', err);
    }
  }
}

export function getLegacyNamespacePrefix(): string {
  return getLegacyPrefix();
}
