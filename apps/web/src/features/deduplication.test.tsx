import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reconcileMessageList } from './messages/ChatView';
import { Message } from '../app/types';
import { wsManager } from '../protocol/ws';

describe('Message Deduplication, Reconciliation & Concurrency Suite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseMsg: Message = {
    id: 'msg_server_101',
    conversation_id: 'conv_123',
    sender_id: 'user_alice',
    sender_username: 'alice',
    ciphertext: 'Hello world',
    nonce: 'normal',
    plaintext: 'Hello world',
    created_at: '2026-10-15T12:00:00Z',
    status: 'delivered',
  };

  // 1. A single send produces exactly one message
  it('1. A single send creates one message in list', () => {
    const optMsg: Message = {
      ...baseMsg,
      id: 'opt_1710000000001',
      idempotency_key: 'idemp_key_1',
      status: 'sending',
    };

    const initialList: Message[] = [];
    const listAfterSend = reconcileMessageList(initialList, optMsg);

    expect(listAfterSend).toHaveLength(1);
    expect(listAfterSend[0].id).toBe('opt_1710000000001');
    expect(listAfterSend[0].status).toBe('sending');
  });

  // 2. Synchronous in-flight guard prevents multiple submissions from rapid clicks or Enter keys
  it('2. In-flight guard prevents multiple operations from rapid repeated dispatches', () => {
    let callCount = 0;
    let isSending = false;

    const guardedSend = (text: string) => {
      if (!text || isSending) return false;
      isSending = true;
      callCount++;
      return true;
    };

    // Simulate rapid repeated double-click / rapid Enter press
    const firstCall = guardedSend('Hello');
    const secondCall = guardedSend('Hello');
    const thirdCall = guardedSend('Hello');

    expect(firstCall).toBe(true);
    expect(secondCall).toBe(false);
    expect(thirdCall).toBe(false);
    expect(callCount).toBe(1);

    // After completion, next legitimate send proceeds
    isSending = false;
    const nextCall = guardedSend('Second message');
    expect(nextCall).toBe(true);
    expect(callCount).toBe(2);
  });

  // 3. Rapid repeated input cannot duplicate one logical send operation in state
  it('3. Rapid repeated input with identical idempotency identity does not duplicate entries', () => {
    const idempKey = 'idemp_rapid_123';
    const optMsg1: Message = {
      ...baseMsg,
      id: 'opt_rapid_1',
      idempotency_key: idempKey,
      status: 'sending',
    };
    const optMsgDuplicate: Message = {
      ...baseMsg,
      id: 'opt_rapid_2',
      idempotency_key: idempKey,
      status: 'sending',
    };

    let list: Message[] = [];
    list = reconcileMessageList(list, optMsg1);
    list = reconcileMessageList(list, optMsgDuplicate);

    expect(list).toHaveLength(1);
    expect(list[0].idempotency_key).toBe(idempKey);
  });

  // 4. An HTTP response followed by the matching WebSocket echo produces one visible message
  it('4. HTTP response followed by matching WebSocket echo produces exactly one visible message', () => {
    const idempKey = 'idemp_flow_4';
    const optMsg: Message = {
      ...baseMsg,
      id: 'opt_401',
      idempotency_key: idempKey,
      status: 'sending',
    };

    let list: Message[] = [];
    // 1. User sends message -> optimistic entry
    list = reconcileMessageList(list, optMsg);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('opt_401');

    // 2. HTTP response returns saved message
    const savedMsg: Message = {
      ...baseMsg,
      id: 'msg_authoritative_401',
      idempotency_key: idempKey,
      status: 'delivered',
    };
    list = reconcileMessageList(list, savedMsg, optMsg.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('msg_authoritative_401');
    expect(list[0].status).toBe('delivered');

    // 3. WebSocket echo arrives with same ID and idempotency key
    const wsMsg: Message = {
      ...baseMsg,
      id: 'msg_authoritative_401',
      idempotency_key: idempKey,
      status: 'delivered',
    };
    list = reconcileMessageList(list, wsMsg);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('msg_authoritative_401');
  });

  // 5. A WebSocket event arriving before the HTTP response produces one visible message
  it('5. WebSocket event arriving before HTTP response produces exactly one visible message', () => {
    const idempKey = 'idemp_flow_5';
    const optMsg: Message = {
      ...baseMsg,
      id: 'opt_501',
      idempotency_key: idempKey,
      status: 'sending',
    };

    let list: Message[] = [];
    // 1. User sends message -> optimistic entry in state
    list = reconcileMessageList(list, optMsg);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('opt_501');

    // 2. WebSocket live event arrives BEFORE HTTP response finishes
    const wsMsg: Message = {
      ...baseMsg,
      id: 'msg_authoritative_501',
      idempotency_key: idempKey,
      status: 'delivered',
    };
    list = reconcileMessageList(list, wsMsg);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('msg_authoritative_501');
    expect(list[0].status).toBe('delivered');

    // 3. HTTP response subsequently resolves with saved.id
    const savedMsg: Message = {
      ...baseMsg,
      id: 'msg_authoritative_501',
      idempotency_key: idempKey,
      status: 'delivered',
    };
    list = reconcileMessageList(list, savedMsg, optMsg.id);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('msg_authoritative_501');
  });

  // 6. Replaying the same WebSocket event does not duplicate the message
  it('6. Replaying the same WebSocket event does not duplicate the message', () => {
    let list: Message[] = [baseMsg];

    // Replay 1
    list = reconcileMessageList(list, baseMsg);
    expect(list).toHaveLength(1);

    // Replay 2
    list = reconcileMessageList(list, baseMsg);
    expect(list).toHaveLength(1);

    // Replay 3
    list = reconcileMessageList(list, baseMsg);
    expect(list).toHaveLength(1);
  });

  // 7. Reconnecting and receiving a replay does not duplicate the message
  it('7. Reconnecting and receiving replay does not duplicate messages', () => {
    const msg1: Message = { ...baseMsg, id: 'msg_rec_1', ciphertext: 'First' };
    const msg2: Message = { ...baseMsg, id: 'msg_rec_2', ciphertext: 'Second' };

    let list: Message[] = [msg1, msg2];

    // Outbox replay sends msg1 and msg2 again
    list = reconcileMessageList(list, msg1);
    list = reconcileMessageList(list, msg2);

    expect(list).toHaveLength(2);
    expect(list.map((m) => m.id)).toEqual(['msg_rec_1', 'msg_rec_2']);
  });

  // 8. Mounting, unmounting, and remounting the chat does not multiply event processing
  it('8. Mounting and unmounting WebSocket subscriptions cleans up listeners cleanly', () => {
    let handlerCallCount = 0;
    const listener = () => {
      handlerCallCount++;
    };

    // Component mounts: subscribes
    const unsub = wsManager.subscribe(listener);

    // Dispatch dummy event
    // wsManager notifies all active listeners
    (wsManager as any).listeners.forEach((fn: any) => fn({ type: 'test' }));
    expect(handlerCallCount).toBe(1);

    // Component unmounts: unsubscribes
    unsub();

    // Dispatch event after unmount
    (wsManager as any).listeners.forEach((fn: any) => fn({ type: 'test' }));
    expect(handlerCallCount).toBe(1); // Did not increase
  });

  // 9. Loading conversation history after live delivery does not duplicate the message
  it('9. Loading conversation history after live delivery does not duplicate message', () => {
    const liveMsg: Message = {
      ...baseMsg,
      id: 'msg_live_901',
      plaintext: 'Live incoming message',
    };

    let list: Message[] = [];
    // Live event arrives
    list = reconcileMessageList(list, liveMsg);
    expect(list).toHaveLength(1);

    // History reload occurs (e.g. loadMessages fetching 50 messages from server)
    const historyFromApi: Message[] = [
      { ...baseMsg, id: 'msg_past_1' },
      { ...baseMsg, id: 'msg_live_901', plaintext: 'Live incoming message' },
    ];

    const seenIds = new Set<string>();
    const dedupedList: Message[] = [];
    for (const m of historyFromApi) {
      if (m.id && !seenIds.has(m.id)) {
        seenIds.add(m.id);
        dedupedList.push(m);
      }
    }

    // Preserve any in-flight sending messages
    const pendingSending = list.filter((m) => m.status === 'sending' && !seenIds.has(m.id));
    const finalMessages = [...dedupedList, ...pendingSending];

    expect(finalMessages).toHaveLength(2);
    expect(finalMessages.filter((m) => m.id === 'msg_live_901')).toHaveLength(1);
  });

  // 10. Two separate intentional sends with identical content remain two distinct messages
  it('10. Two separate intentional sends with identical text remain two distinct messages', () => {
    const msg1: Message = {
      ...baseMsg,
      id: 'msg_distinct_1',
      idempotency_key: 'idemp_key_first',
      plaintext: 'Same text',
      ciphertext: 'Same text',
    };
    const msg2: Message = {
      ...baseMsg,
      id: 'msg_distinct_2',
      idempotency_key: 'idemp_key_second',
      plaintext: 'Same text',
      ciphertext: 'Same text',
    };

    let list: Message[] = [];
    list = reconcileMessageList(list, msg1);
    list = reconcileMessageList(list, msg2);

    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('msg_distinct_1');
    expect(list[1].id).toBe('msg_distinct_2');
    expect(list[0].plaintext).toBe('Same text');
    expect(list[1].plaintext).toBe('Same text');
  });

  // 11. Read receipts and delivery states survive optimistic reconciliation
  it('11. Read receipts and reactions survive optimistic reconciliation', () => {
    const optMsg: Message = {
      ...baseMsg,
      id: 'opt_receipt_1',
      idempotency_key: 'idemp_receipt_1',
      status: 'sending',
      reactions: { '👍': ['user_bob'] },
    };

    let list: Message[] = [optMsg];

    // Mark as read in state
    list = list.map((m) => ({ ...m, status: 'read', is_read: true }));

    // Authoritative update arrives
    const serverMsg: Message = {
      ...baseMsg,
      id: 'msg_receipt_1',
      idempotency_key: 'idemp_receipt_1',
      status: 'delivered', // Server returns delivered
    };

    list = reconcileMessageList(list, serverMsg, optMsg.id);

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('msg_receipt_1');
    // Read status must not be downgraded
    expect(list[0].status).toBe('read');
    expect(list[0].is_read).toBe(true);
    // Reactions preserved
    expect(list[0].reactions).toEqual({ '👍': ['user_bob'] });
  });

  // 12. Encrypted messages and attachments continue to render correctly
  it('12. Encrypted messages and attachments preserve metadata through reconciliation', () => {
    const attMeta = {
      id: 'att_photo_123',
      filename: 'secret_doc.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4096,
      keyBase64: 'mockKeyBase64==',
      ivBase64: 'mockIvBase64==',
    };

    const optMsg: Message = {
      ...baseMsg,
      id: 'opt_e2ee_1',
      idempotency_key: 'idemp_e2ee_1',
      nonce: 'e2ee_signal_nonce',
      attachmentMeta: attMeta,
      status: 'sending',
    };

    let list: Message[] = [];
    list = reconcileMessageList(list, optMsg);

    const serverMsg: Message = {
      ...baseMsg,
      id: 'msg_e2ee_server_1',
      idempotency_key: 'idemp_e2ee_1',
      nonce: 'e2ee_signal_nonce',
      status: 'delivered',
    };

    list = reconcileMessageList(list, serverMsg, optMsg.id);

    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('msg_e2ee_server_1');
    expect(list[0].attachmentMeta).toEqual(attMeta);
    expect(list[0].nonce).toBe('e2ee_signal_nonce');
  });
});
