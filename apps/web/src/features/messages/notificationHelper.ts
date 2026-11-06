import { Conversation, User } from '../../app/types';
import { AppSettings } from '../settings/settingsModel';
import { Language } from '../../app/i18n';
import { signalManager } from '../../crypto/signalManager';

export interface FormattedNotification {
  title: string;
  body: string;
  icon?: string;
  conversation?: Conversation;
  senderName: string;
  senderAvatarUrl?: string;
}

/**
 * Cleanly format message preview text, safely handling Unicode/emojis/Persian.
 */
export function formatMessagePreview(rawText: string, lang: Language = 'en'): string {
  if (!rawText) return lang === 'fa' ? 'پیام جدید' : 'New message';

  let textToParse = rawText.trim();
  if (textToParse.startsWith('{') && textToParse.endsWith('}')) {
    try {
      const parsed = JSON.parse(textToParse);

      if (parsed.type === 'call_event' || parsed.call_id) {
        return parsed.text || (lang === 'fa' ? 'تماس' : 'Call');
      }

      if (parsed.type === 'poll') {
        return `📊 ${parsed.text || (lang === 'fa' ? 'نظرسنجی جدید' : 'Poll')}`;
      }

      if (parsed.type === 'voice') {
        return lang === 'fa' ? '🎤 پیام صوتی' : '🎤 Voice message';
      }

      if (parsed.type === 'video_note') {
        return lang === 'fa' ? '⭕ پیام ویدیویی' : '⭕ Video Note';
      }

      if (parsed.type === 'sticker' || parsed.attachment?.isSticker) {
        const emoji = parsed.attachment?.emoji || parsed.text;
        return emoji && emoji !== 'Sticker'
          ? `${emoji} ${lang === 'fa' ? 'استیکر' : 'Sticker'}`
          : (lang === 'fa' ? 'استیکر' : 'Sticker');
      }

      if (parsed.type === 'attachment' || parsed.attachment) {
        const att = parsed.attachment || {};
        const mime = att.mime_type || '';
        if (mime.startsWith('image/') || att.isPhoto) {
          return att.caption || (lang === 'fa' ? '📷 عکس' : '📷 Photo');
        }
        if (mime.startsWith('video/') || att.isVideo) {
          return att.caption || (lang === 'fa' ? '📹 ویدیو' : '📹 Video');
        }
        if (mime.startsWith('audio/') || att.isAudio) {
          return att.caption || (lang === 'fa' ? '🎵 فایل صوتی' : '🎵 Audio');
        }
        return att.caption || (att.filename ? `📎 ${att.filename}` : (lang === 'fa' ? '📎 سند' : '📎 Document'));
      }

      if (parsed.is_forwarded) {
        return `${lang === 'fa' ? 'بازارسال: ' : 'Forwarded: '}${parsed.text || ''}`;
      }

      if (parsed.text) {
        textToParse = parsed.text;
      }
    } catch {
      // Fall through to plain text
    }
  }

  // Safe Unicode truncation to 80 code points (avoids cutting surrogate pairs/graphemes)
  const codePoints = Array.from(textToParse);
  if (codePoints.length > 80) {
    return codePoints.slice(0, 80).join('') + '…';
  }
  return textToParse;
}

/**
 * Format notification title and body according to sender identity, conversation type,
 * and privacy settings.
 */
export async function buildNotificationData(
  msg: any,
  conversations: Conversation[],
  currentUser: User | null,
  appSettings: AppSettings,
  lang: Language = 'en'
): Promise<FormattedNotification | null> {
  if (!msg) return null;

  // 1. Mute checks
  if (appSettings.muteAll) return null;

  try {
    const mutedRaw = localStorage.getItem('senora_muted_convs');
    if (mutedRaw) {
      const muted: string[] = JSON.parse(mutedRaw);
      if (Array.isArray(muted) && muted.includes(msg.conversation_id)) {
        return null;
      }
    }
  } catch {}

  // 2. Resolve Conversation
  const conv = conversations.find((c) => c.id === msg.conversation_id);

  // 3. Resolve Sender Name
  let senderName = msg.sender_display_name || '';
  if (!senderName && msg.sender_username) {
    senderName = `@${msg.sender_username}`;
  }
  if (!senderName && conv) {
    if (conv.type === 'direct' && conv.participants) {
      const other = conv.participants.find((p) => p.id !== currentUser?.id);
      if (other) {
        senderName = other.display_name || other.username;
      }
    }
    if (!senderName && conv.title) {
      senderName = conv.title;
    }
  }
  if (!senderName) {
    senderName = lang === 'fa' ? 'کاربر سنورا' : 'Senora User';
  }

  const senderAvatarUrl = msg.sender_avatar_url || conv?.avatar_url || undefined;

  // 4. Privacy: If message preview is disabled in settings, hide message content
  if (appSettings.messagePreview === false) {
    let title = senderName;
    if (conv && (conv.type === 'group' || conv.type === 'channel') && conv.title) {
      title = conv.title;
    }
    return {
      title,
      body: lang === 'fa' ? 'پیام جدید' : 'New message',
      icon: senderAvatarUrl || '/favicon.ico',
      conversation: conv,
      senderName,
      senderAvatarUrl,
    };
  }

  // 5. Decrypt content if E2EE, or use raw ciphertext if normal message
  let content = msg.ciphertext || '';
  const isNormal = msg.nonce === 'normal' || msg.nonce === '' || msg.nonce === 'system';

  if (!isNormal) {
    try {
      const myDeviceId = localStorage.getItem('senora_device_id') || '';
      content = await signalManager.decryptMessage(
        msg.ciphertext,
        msg.nonce,
        msg.sender_id,
        msg.sender_id === currentUser?.id ? myDeviceId : '',
        '',
        msg.conversation_id
      );
    } catch {
      content = lang === 'fa' ? '[پیام رمزنگاری‌شده]' : '[Encrypted Message]';
    }
  }

  const preview = formatMessagePreview(content, lang);

  // 6. Build final Title & Body based on chat type
  let title = senderName;
  let body = preview;

  if (conv) {
    if (conv.type === 'group') {
      title = conv.title || (lang === 'fa' ? 'گروه' : 'Group');
      body = `${senderName}: ${preview}`;
    } else if (conv.type === 'channel') {
      title = conv.title || (lang === 'fa' ? 'کانال' : 'Channel');
      body = preview;
    } else {
      // Direct message
      title = senderName;
      body = preview;
    }
  }

  return {
    title,
    body,
    icon: senderAvatarUrl || '/favicon.ico',
    conversation: conv,
    senderName,
    senderAvatarUrl,
  };
}
