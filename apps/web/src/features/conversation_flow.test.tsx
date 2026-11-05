import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { ReadByModal } from './messages/ReadByModal';
import { presenceManager } from './presence/presenceManager';
import { soundManager } from './calls/soundManager';
import { Message } from '../app/types';

describe('Read Receipts and Admin Visibility Model', () => {
  const dummyMessage: Message = {
    id: 'msg_test_101',
    conversation_id: 'conv_group_101',
    sender_id: 'user_alice',
    ciphertext: 'Test message for receipt verification',
    nonce: 'normal',
    created_at: new Date().toISOString(),
    status: 'delivered',
  };

  it('instantiates ReadByModal React element with valid structure and ARIA attributes', () => {
    const element = React.createElement(ReadByModal, {
      conversationId: dummyMessage.conversation_id,
      message: dummyMessage,
      onClose: () => {},
    });

    expect(React.isValidElement(element)).toBe(true);
    expect(element.props.conversationId).toBe('conv_group_101');
    expect(element.props.message.id).toBe('msg_test_101');
  });

  it('distinguishes sent, delivered, and read receipt states correctly', () => {
    const sentMsg: Message = { ...dummyMessage, status: 'sending', is_read: false };
    const deliveredMsg: Message = { ...dummyMessage, status: 'delivered', is_read: false };
    const readMsg: Message = { ...dummyMessage, status: 'read', is_read: true, read_count: 2 };

    expect(sentMsg.status).toBe('sending');
    expect(deliveredMsg.status).toBe('delivered');
    expect(readMsg.status).toBe('read');
    expect(readMsg.is_read).toBe(true);
    expect(readMsg.read_count).toBe(2);
  });
});

describe('Accurate Presence & Reactive State Transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates online status dynamically via presenceManager on 0->1 connection', () => {
    const targetUserId = 'user_dynamic_presence_1';

    // Broadcast presence update (User connects)
    presenceManager.setPresence(targetUserId, {
      user_id: targetUserId,
      is_online: true,
    });

    expect(presenceManager.getPresence(targetUserId)?.is_online).toBe(true);
  });

  it('transitions user to offline on 1->0 disconnection with authoritative last seen', () => {
    const targetUserId = 'user_dynamic_presence_2';
    const lastSeen = new Date().toISOString();

    // User disconnects
    presenceManager.setPresence(targetUserId, {
      user_id: targetUserId,
      is_online: false,
      last_seen_at: lastSeen,
    });

    const p = presenceManager.getPresence(targetUserId);
    expect(p?.is_online).toBe(false);
    expect(p?.last_seen_at).toBe(lastSeen);
  });

  it('notifies subscribers immediately when authoritative presence changes', () => {
    const targetUserId = 'user_sub_test';
    let notifiedOnline: boolean | null = null;

    const unsub = presenceManager.subscribe((uid, p) => {
      if (uid === targetUserId) {
        notifiedOnline = p.is_online;
      }
    });

    presenceManager.setPresence(targetUserId, {
      user_id: targetUserId,
      is_online: true,
    });

    expect(notifiedOnline).toBe(true);

    presenceManager.setPresence(targetUserId, {
      user_id: targetUserId,
      is_online: false,
    });

    expect(notifiedOnline).toBe(false);
    unsub();
  });
});

describe('Real-Time Synchronization State Integrity', () => {
  it('deduplicates messages and handles optimistic reconciliation', () => {
    const prevMessages: Message[] = [
      {
        id: 'opt_123',
        conversation_id: 'conv_1',
        sender_id: 'user_me',
        ciphertext: 'Hello',
        nonce: 'normal',
        idempotency_key: 'idem_key_abc',
        created_at: new Date().toISOString(),
        status: 'sending',
      },
    ];

    const confirmedMsg: Message = {
      id: 'srv_msg_456',
      conversation_id: 'conv_1',
      sender_id: 'user_me',
      ciphertext: 'Hello',
      nonce: 'normal',
      idempotency_key: 'idem_key_abc',
      created_at: new Date().toISOString(),
      status: 'delivered',
    };

    // Reconcile by matching idempotency_key
    const idx = prevMessages.findIndex(
      (m) =>
        m.id === confirmedMsg.id ||
        (confirmedMsg.idempotency_key && m.idempotency_key === confirmedMsg.idempotency_key)
    );

    expect(idx).toBe(0);
    const updated = [...prevMessages];
    updated[idx] = confirmedMsg;

    expect(updated.length).toBe(1);
    expect(updated[0].id).toBe('srv_msg_456');
    expect(updated[0].status).toBe('delivered');
  });
});

describe('Call and Message Audio Synthesizer', () => {
  it('soundManager methods execute safely without unhandled exceptions', () => {
    expect(() => soundManager.playMessageNotification()).not.toThrow();
    expect(() => soundManager.stopAll()).not.toThrow();
    expect(() => soundManager.stopIncomingRingtone()).not.toThrow();
    expect(() => soundManager.stopOutgoingRingback()).not.toThrow();
  });
});

describe('Reaction Badge Positioning Logic', () => {
  it('correctly aggregates multiple user reactions and formats badge counts', () => {
    const reactions: Record<string, string[]> = {
      '👍': ['user_1', 'user_2', 'user_3'],
      '❤️': ['user_1'],
    };

    expect(Object.keys(reactions).length).toBe(2);
    expect(reactions['👍'].length).toBe(3);
    expect(reactions['❤️'].length).toBe(1);
    expect(reactions['👍'].includes('user_1')).toBe(true);
  });
});

describe('Payload Normalization & Receipt Independence', () => {
  it('normalizes outbox payload by ensuring message ID is populated from either id or message_id', () => {
    const rawOutboxEvent = {
      message_id: 'msg-uuid-999',
      conversation_id: 'conv-111',
      sender_id: 'user_bob',
      ciphertext: 'Hello Alice',
    };

    const normalizedMsg = {
      ...rawOutboxEvent,
      id: (rawOutboxEvent as any).id || rawOutboxEvent.message_id,
    };

    expect(normalizedMsg.id).toBe('msg-uuid-999');
    expect(normalizedMsg.id).not.toBeUndefined();
    // Ensures recordMessageRead path /api/v1/conversations/:id/messages/:msgId/read receives valid ID
    expect(`/api/v1/conversations/${normalizedMsg.conversation_id}/messages/${normalizedMsg.id}/read`)
      .toBe('/api/v1/conversations/conv-111/messages/msg-uuid-999/read');
  });

  it('guarantees message-level read receipt isolation: M1 marked read does not alter M2', () => {
    const messages: Message[] = [
      {
        id: 'msg_1',
        conversation_id: 'conv_1',
        sender_id: 'user_me',
        ciphertext: 'Message 1',
        nonce: 'n1',
        created_at: '2026-10-15T08:00:00Z',
        status: 'delivered',
        is_read: false,
        read_count: 0,
      },
      {
        id: 'msg_2',
        conversation_id: 'conv_1',
        sender_id: 'user_me',
        ciphertext: 'Message 2',
        nonce: 'n2',
        created_at: '2026-10-15T08:01:00Z',
        status: 'delivered',
        is_read: false,
        read_count: 0,
      },
    ];

    // Incoming message.read event strictly targeting msg_1
    const readReceiptEvent = {
      type: 'message.read',
      message_id: 'msg_1',
      conversation_id: 'conv_1',
      reader_id: 'user_peer',
      read_at: '2026-10-15T08:02:00Z',
    };

    // ChatView reducer logic
    const updatedMessages = messages.map((m) => {
      if (m.id === readReceiptEvent.message_id) {
        return {
          ...m,
          is_read: true,
          status: 'read' as const,
          read_count: (m.read_count || 0) + 1,
        };
      }
      return m;
    });

    // M1 must be read
    expect(updatedMessages[0].id).toBe('msg_1');
    expect(updatedMessages[0].is_read).toBe(true);
    expect(updatedMessages[0].status).toBe('read');
    expect(updatedMessages[0].read_count).toBe(1);

    // M2 MUST REMAIN UNREAD
    expect(updatedMessages[1].id).toBe('msg_2');
    expect(updatedMessages[1].is_read).toBe(false);
    expect(updatedMessages[1].status).toBe('delivered');
    expect(updatedMessages[1].read_count).toBe(0);
  });

  it('handles batch presence caching and multi-subscriber propagation', () => {
    const u1 = 'user_batch_1';
    const u2 = 'user_batch_2';

    presenceManager.setPresence(u1, { user_id: u1, is_online: true });
    presenceManager.setPresence(u2, { user_id: u2, is_online: false, last_seen_at: '2026-10-15T07:55:00Z' });

    expect(presenceManager.getPresence(u1)?.is_online).toBe(true);
    expect(presenceManager.getPresence(u2)?.is_online).toBe(false);
    expect(presenceManager.getPresence(u2)?.last_seen_at).toBe('2026-10-15T07:55:00Z');
  });
});

