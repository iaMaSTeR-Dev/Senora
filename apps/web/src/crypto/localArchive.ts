import { base64ToBuffer, bufferToBase64, buildCanonicalAAD } from './clientCrypto';
import { SignalIndexedDBStore } from './signalStore';

// A separate random key for each locally retained message avoids making the
// server's entire sent history decryptable with the long-term identity key.
export async function archiveEncrypt(store: SignalIndexedDBStore, text: string, conversationId: string) {
  const id = crypto.randomUUID();
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new Uint8Array(buildCanonicalAAD(conversationId, 2)) }, key, new TextEncoder().encode(text));
  await store.setMetadata(`archive:${id}`, raw);
  return { type: 998, body: bufferToBase64(data), nonce: bufferToBase64(iv.buffer), archiveId: id };
}

export async function archiveDecrypt(store: SignalIndexedDBStore, entry: { body: string; nonce?: string; archiveId?: string }, conversationId: string) {
  if (!entry.archiveId || !entry.nonce) throw new Error('ARCHIVE_METADATA_MISSING');
  const raw = await store.getMetadata<Uint8Array>(`archive:${entry.archiveId}`);
  if (!raw) throw new Error('LOCAL_HISTORY_KEY_MISSING: Restore this device’s encrypted key backup.');
  const key = await crypto.subtle.importKey('raw', new Uint8Array(raw), 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(base64ToBuffer(entry.nonce)), additionalData: new Uint8Array(buildCanonicalAAD(conversationId, 2)) }, key, new Uint8Array(base64ToBuffer(entry.body)));
  return new TextDecoder().decode(plain);
}
