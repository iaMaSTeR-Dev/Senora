import { api } from '../protocol/api';
import { signalManager } from './signalManager';

export interface WhisperPayload {
  target_username: string;
  target_id?: string;
  secret_text: string;
  sender_username?: string;
  sender_id?: string;
  encrypted_secret?: string;
  secret_nonce?: string;
}

export async function encryptWhisper(payload: WhisperPayload, targets: Array<{ userId: string; deviceId: string; publicKeyBase64?: string }>, conversationId: string, senderId: string): Promise<WhisperPayload> {
  const target = await api.getUserByUsername(payload.target_username);
  const recipients = targets.filter(device => device.userId === target.id || device.userId === senderId);
  if (!recipients.some(device => device.userId === target.id)) throw new Error('مخاطب نجوا باید عضو گفتگو باشد و دستگاه رمزنگاری‌شدهٔ فعال داشته باشد.');
  const encrypted = await signalManager.encryptMultiDevice(payload.secret_text, recipients, conversationId, api.getToken() || undefined);
  return { ...payload, target_id: target.id, sender_id: senderId, secret_text: '', encrypted_secret: encrypted.ciphertext, secret_nonce: encrypted.nonce };
}
