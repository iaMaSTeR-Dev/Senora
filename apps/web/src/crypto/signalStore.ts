import {
  StorageType,
  KeyPairType,
  SessionRecordType,
  Direction,
} from '@privacyresearch/libsignal-protocol-typescript';

export class SignalIndexedDBStore implements StorageType {
  private dbName: string;
  private db: IDBDatabase | null = null;
  private isReadyPromise: Promise<void>;

  // In-memory cache for speed and fallback
  private identityKeyPair?: KeyPairType;
  private registrationId?: number;
  private preKeys = new Map<string | number, KeyPairType>();
  private signedPreKeys = new Map<string | number, KeyPairType>();
  private sessions = new Map<string, SessionRecordType>();
  private trustedIdentities = new Map<string, ArrayBuffer>();

  constructor(userId: string) {
    this.dbName = `senora_signal_${userId || 'default'}`;
    this.isReadyPromise = this.initDB();
  }

  private async initDB(): Promise<void> {
    if (typeof indexedDB === 'undefined') {
      return;
    }

    return new Promise((resolve) => {
      try {
        const req = indexedDB.open(this.dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta');
          }
          if (!db.objectStoreNames.contains('preKeys')) {
            db.createObjectStore('preKeys');
          }
          if (!db.objectStoreNames.contains('signedPreKeys')) {
            db.createObjectStore('signedPreKeys');
          }
          if (!db.objectStoreNames.contains('sessions')) {
            db.createObjectStore('sessions');
          }
          if (!db.objectStoreNames.contains('identities')) {
            db.createObjectStore('identities');
          }
        };

        req.onsuccess = async () => {
          this.db = req.result;
          await this.loadAllFromDB();
          resolve();
        };

        req.onerror = () => {
          resolve(); // Fall back to in-memory store
        };
      } catch {
        resolve();
      }
    });
  }

  private async loadAllFromDB(): Promise<void> {
    if (!this.db) return;

    try {
      // 1. Load meta
      const metaTx = this.db.transaction('meta', 'readonly');
      const metaStore = metaTx.objectStore('meta');
      const idKeyReq = metaStore.get('identityKeyPair');
      const regIdReq = metaStore.get('registrationId');

      await new Promise<void>((res) => {
        metaTx.oncomplete = () => {
          if (idKeyReq.result) this.identityKeyPair = idKeyReq.result;
          if (regIdReq.result) this.registrationId = regIdReq.result;
          res();
        };
        metaTx.onerror = () => res();
      });

      // 2. Load preKeys
      const pkTx = this.db.transaction('preKeys', 'readonly');
      const pkStore = pkTx.objectStore('preKeys');
      const pkCursorReq = pkStore.openCursor();
      pkCursorReq.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) {
          this.preKeys.set(cursor.key, cursor.value);
          cursor.continue();
        }
      };

      // 3. Load signedPreKeys
      const spkTx = this.db.transaction('signedPreKeys', 'readonly');
      const spkStore = spkTx.objectStore('signedPreKeys');
      const spkCursorReq = spkStore.openCursor();
      spkCursorReq.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) {
          this.signedPreKeys.set(cursor.key, cursor.value);
          cursor.continue();
        }
      };

      // 4. Load sessions
      const sessTx = this.db.transaction('sessions', 'readonly');
      const sessStore = sessTx.objectStore('sessions');
      const sessCursorReq = sessStore.openCursor();
      sessCursorReq.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) {
          this.sessions.set(String(cursor.key), cursor.value);
          cursor.continue();
        }
      };

      // 5. Load identities
      const idTx = this.db.transaction('identities', 'readonly');
      const idStore = idTx.objectStore('identities');
      const idCursorReq = idStore.openCursor();
      idCursorReq.onsuccess = (e: any) => {
        const cursor = e.target.result;
        if (cursor) {
          this.trustedIdentities.set(String(cursor.key), cursor.value);
          cursor.continue();
        }
      };
    } catch {
      // Ignore load errors, use memory
    }
  }

  public async ready(): Promise<void> {
    await this.isReadyPromise;
  }

  // --- Identity Key Pair ---

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    await this.ready();
    return this.identityKeyPair;
  }

  async setIdentityKeyPair(keyPair: KeyPairType): Promise<void> {
    await this.ready();
    this.identityKeyPair = keyPair;
    if (this.db) {
      try {
        const tx = this.db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(keyPair, 'identityKeyPair');
      } catch {
        // Fallback in memory
      }
    }
  }

  // --- Registration ID ---

  async getLocalRegistrationId(): Promise<number | undefined> {
    await this.ready();
    return this.registrationId;
  }

  async setLocalRegistrationId(regId: number): Promise<void> {
    await this.ready();
    this.registrationId = regId;
    if (this.db) {
      try {
        const tx = this.db.transaction('meta', 'readwrite');
        tx.objectStore('meta').put(regId, 'registrationId');
      } catch {
        // Fallback in memory
      }
    }
  }

  // --- Trusted Identities ---

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    _direction: Direction
  ): Promise<boolean> {
    await this.ready();
    const existing = this.trustedIdentities.get(identifier);
    if (!existing) {
      return true; // TOFU (Trust On First Use)
    }
    const a = new Uint8Array(existing);
    const b = new Uint8Array(identityKey);
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer,
    _nonblockingApproval?: boolean
  ): Promise<boolean> {
    await this.ready();
    this.trustedIdentities.set(encodedAddress, publicKey);
    if (this.db) {
      try {
        const tx = this.db.transaction('identities', 'readwrite');
        tx.objectStore('identities').put(publicKey, encodedAddress);
      } catch {
        // In-memory fallback
      }
    }
    return true;
  }

  // --- PreKeys ---

  async loadPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    await this.ready();
    return this.preKeys.get(keyId);
  }

  async storePreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    await this.ready();
    this.preKeys.set(keyId, keyPair);
    if (this.db) {
      try {
        const tx = this.db.transaction('preKeys', 'readwrite');
        tx.objectStore('preKeys').put(keyPair, keyId);
      } catch {
        // In-memory fallback
      }
    }
  }

  async removePreKey(keyId: string | number): Promise<void> {
    await this.ready();
    this.preKeys.delete(keyId);
    if (this.db) {
      try {
        const tx = this.db.transaction('preKeys', 'readwrite');
        tx.objectStore('preKeys').delete(keyId);
      } catch {
        // In-memory fallback
      }
    }
  }

  // --- Signed PreKeys ---

  async loadSignedPreKey(keyId: string | number): Promise<KeyPairType | undefined> {
    await this.ready();
    return this.signedPreKeys.get(keyId);
  }

  async storeSignedPreKey(keyId: string | number, keyPair: KeyPairType): Promise<void> {
    await this.ready();
    this.signedPreKeys.set(keyId, keyPair);
    if (this.db) {
      try {
        const tx = this.db.transaction('signedPreKeys', 'readwrite');
        tx.objectStore('signedPreKeys').put(keyPair, keyId);
      } catch {
        // In-memory fallback
      }
    }
  }

  async removeSignedPreKey(keyId: string | number): Promise<void> {
    await this.ready();
    this.signedPreKeys.delete(keyId);
    if (this.db) {
      try {
        const tx = this.db.transaction('signedPreKeys', 'readwrite');
        tx.objectStore('signedPreKeys').delete(keyId);
      } catch {
        // In-memory fallback
      }
    }
  }

  // --- Sessions ---

  async loadSession(encodedAddress: string): Promise<SessionRecordType | undefined> {
    await this.ready();
    return this.sessions.get(encodedAddress);
  }

  async storeSession(encodedAddress: string, record: SessionRecordType): Promise<void> {
    await this.ready();
    this.sessions.set(encodedAddress, record);
    if (this.db) {
      try {
        const tx = this.db.transaction('sessions', 'readwrite');
        tx.objectStore('sessions').put(record, encodedAddress);
      } catch {
        // In-memory fallback
      }
    }
  }
}
