/**
 * Encrypted Keystore Backup & Restore for SENORA
 * Uses PBKDF2 (100,000 iterations SHA-256) + AES-256-GCM
 * Exports Signal keys, prekeys, and sessions into .senorakeys files
 */

export interface EncryptedBackupContainer {
  app: 'SENORA';
  format: 'senorakeys-v1';
  algorithm: 'PBKDF2-AES-GCM';
  kdf_iterations: number;
  salt: string; // base64
  iv: string; // base64
  ciphertext: string; // base64
  exported_at: string;
  user_id: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Convert arbitrary object with ArrayBuffers/Uint8Arrays to JSON-serializable structure
function serializeValue(val: any): any {
  if (val === null || val === undefined) return val;
  if (val instanceof ArrayBuffer) {
    return { __type: 'ArrayBuffer', data: arrayBufferToBase64(val) };
  }
  if (val instanceof Uint8Array) {
    return { __type: 'Uint8Array', data: arrayBufferToBase64(val) };
  }
  if (Array.isArray(val)) {
    return val.map(serializeValue);
  }
  if (typeof val === 'object') {
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = serializeValue(v);
    }
    return res;
  }
  return val;
}

function deserializeValue(val: any): any {
  if (val === null || val === undefined) return val;
  if (typeof val === 'object') {
    if (val.__type === 'ArrayBuffer') {
      return base64ToArrayBuffer(val.data);
    }
    if (val.__type === 'Uint8Array') {
      return new Uint8Array(base64ToArrayBuffer(val.data));
    }
    if (Array.isArray(val)) {
      return val.map(deserializeValue);
    }
    const res: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      res[k] = deserializeValue(v);
    }
    return res;
  }
  return val;
}

async function deriveKey(password: string, salt: Uint8Array, iterations = 100000): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function exportEncryptedKeystore(
  userId: string,
  password: string,
  customData?: Record<string, any>
): Promise<string> {
  const backupPayload: Record<string, any> = {
    userId,
    exportedAt: new Date().toISOString(),
    stores: {} as Record<string, any>,
    localStorage: {} as Record<string, string>,
    custom: customData || {},
  };

  // 1. Export from localStorage
  if (typeof localStorage !== 'undefined') {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith('senora_') || key.startsWith('signal_'))) {
        backupPayload.localStorage[key] = localStorage.getItem(key) || '';
      }
    }
  }

  // 2. Export from IndexedDB
  if (typeof indexedDB !== 'undefined') {
    const dbName = `senora_signal_${userId || 'default'}`;
    try {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const req = indexedDB.open(dbName, 1);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });

      if (db) {
        const storeNames = ['meta', 'preKeys', 'signedPreKeys', 'sessions', 'identities'];
        for (const sName of storeNames) {
          if (db.objectStoreNames.contains(sName)) {
            const tx = db.transaction(sName, 'readonly');
            const store = tx.objectStore(sName);
            const items: Record<string, any> = {};
            await new Promise<void>((res) => {
              const curReq = store.openCursor();
              curReq.onsuccess = (e: any) => {
                const cursor = e.target.result;
                if (cursor) {
                  items[String(cursor.key)] = serializeValue(cursor.value);
                  cursor.continue();
                } else {
                  res();
                }
              };
              curReq.onerror = () => res();
            });
            backupPayload.stores[sName] = items;
          }
        }
        db.close();
      }
    } catch (e) {
      console.warn('Could not read IndexedDB for backup:', e);
    }
  }

  const jsonStr = JSON.stringify(backupPayload);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveKey(password, salt);

  const enc = new TextEncoder();
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    enc.encode(jsonStr)
  );

  const container: EncryptedBackupContainer = {
    app: 'SENORA',
    format: 'senorakeys-v1',
    algorithm: 'PBKDF2-AES-GCM',
    kdf_iterations: 100000,
    salt: arrayBufferToBase64(salt),
    iv: arrayBufferToBase64(iv),
    ciphertext: arrayBufferToBase64(ciphertextBuffer),
    exported_at: backupPayload.exportedAt,
    user_id: userId,
  };

  return JSON.stringify(container, null, 2);
}

export async function restoreEncryptedKeystore(
  userId: string,
  backupContent: string,
  password: string
): Promise<{ success: boolean; itemsRestored: number; message: string }> {
  let container: EncryptedBackupContainer;
  try {
    container = JSON.parse(backupContent);
  } catch {
    throw new Error('فایل پشتیبان نامعتبر است (فرمت JSON نیست)');
  }

  const validFormat = String(container.app).toUpperCase() === 'SENORA' && container.format === 'senorakeys-v1';
  if (!validFormat) {
    throw new Error('فرمت فایل پشتیبان با SENORA همخوانی ندارد');
  }

  const salt = new Uint8Array(base64ToArrayBuffer(container.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(container.iv));
  const ciphertext = base64ToArrayBuffer(container.ciphertext);

  const aesKey = await deriveKey(password, salt, container.kdf_iterations || 100000);

  let decryptedBuffer: ArrayBuffer;
  try {
    decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      aesKey,
      ciphertext
    );
  } catch {
    throw new Error('رمز عبور پشتیبان اشتباه است یا فایل دستکاری شده است');
  }

  const dec = new TextDecoder();
  const payloadStr = dec.decode(decryptedBuffer);
  const payload = JSON.parse(payloadStr);

  let itemsRestored = 0;

  // Restore localStorage items
  if (payload.localStorage && typeof localStorage !== 'undefined') {
    for (const [k, v] of Object.entries(payload.localStorage)) {
      if (typeof v === 'string') {
        localStorage.setItem(k, v);
        itemsRestored++;
      }
    }
  }

  // Restore IndexedDB stores
  if (payload.stores && typeof indexedDB !== 'undefined') {
    const targetUserId = userId || payload.userId || 'default';
    const dbName = `senora_signal_${targetUserId}`;
    try {
      const db = await new Promise<IDBDatabase | null>((resolve) => {
        const req = indexedDB.open(dbName, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          ['meta', 'preKeys', 'signedPreKeys', 'sessions', 'identities'].forEach((name) => {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
          });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      });

      if (db) {
        for (const [sName, storeItems] of Object.entries(payload.stores)) {
          if (db.objectStoreNames.contains(sName) && typeof storeItems === 'object') {
            const tx = db.transaction(sName, 'readwrite');
            const st = tx.objectStore(sName);
            for (const [rawKey, rawVal] of Object.entries(storeItems as Record<string, any>)) {
              const val = deserializeValue(rawVal);
              const key = !isNaN(Number(rawKey)) ? Number(rawKey) : rawKey;
              st.put(val, key);
              itemsRestored++;
            }
          }
        }
        db.close();
      }
    } catch (e) {
      console.warn('Could not restore to IndexedDB:', e);
    }
  }

  return {
    success: true,
    itemsRestored,
    message: 'تمام کلیدها و نشست‌های Double Ratchet با موفقیت بازیابی شدند',
  };
}
