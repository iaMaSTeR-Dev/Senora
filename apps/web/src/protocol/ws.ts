import { CallSignal } from '../app/types';
import { serverManager } from './serverManager';

export type WebSocketEventListener = (event: {
  type: string;
  cursor?: number;
  replay?: boolean;
  payload: any;
}) => void;

class WebSocketManager {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private listeners: Set<WebSocketEventListener> = new Set();
  private connectionListeners: Set<(connected: boolean) => void> = new Set();
  private lastCursor = 0;
  private cursorScope = "";
  private reconnectTimeout: any = null;
  private pingInterval: any = null;
  private isConnected = false;
  private connectedAt = 0;

  connect(token: string) {
    clearTimeout(this.reconnectTimeout);
    this.cleanup();
    this.token = token;

    const activeServer = serverManager.getActiveServer();
    const scope = `${activeServer.id}:${token}`;
    if (scope !== this.cursorScope) { this.lastCursor = 0; this.cursorScope = scope; }
    let wsUrl: string;
    if (activeServer.wsUrl && typeof window !== 'undefined' && window.location && !activeServer.wsUrl.includes(window.location.host)) {
      const baseWs = activeServer.wsUrl.split('?')[0];
      wsUrl = `${baseWs}?token=${encodeURIComponent(token)}`;
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      wsUrl = `${protocol}//${window.location.host}/api/v1/ws?token=${encodeURIComponent(token)}`;
    }

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        const wasConnected = this.isConnected;
        this.isConnected = true;
        this.connectedAt = Date.now();
        this.startHeartbeat();
        if (!wasConnected) {
          for (const cb of this.connectionListeners) {
            try {
              cb(true);
            } catch {}
          }
        }

        // Perform cursor sync catch-up on connect
        {
          this.send({
            type: 'sync.request',
            payload: { last_event_id: this.lastCursor },
          });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const envelope = JSON.parse(event.data);
          if (envelope.cursor && envelope.cursor > this.lastCursor) {
            this.lastCursor = envelope.cursor;
          }

          if (envelope.type === 'pong') {
            return;
          }

          // Notify all listeners
          // Older servers do not mark replay frames. Their pre-connection
          // messages are also history; updated servers explicitly mark both
          // live and replay frames, without relying on the client's clock.
          const replay = typeof envelope.replay === 'boolean'
            ? envelope.replay
            : envelope.type === 'message.created' &&
              Date.parse(envelope.payload?.created_at || '') <= this.connectedAt;
          for (const listener of this.listeners) {
            listener({
              type: envelope.type,
              cursor: envelope.cursor,
              replay,
              payload: envelope.payload,
            });
          }
        } catch (e) {
          console.error('[SENORA WS] Failed to parse frame:', e);
        }
      };

      this.ws.onclose = () => {
        this.cleanup();
        this.scheduleReconnect();
      };

      this.ws.onerror = (e) => {
        console.warn('[SENORA WS] Error:', e);
      };
    } catch (e) {
      console.error('[SENORA WS] Connection error:', e);
      this.scheduleReconnect();
    }
  }

  send(data: { type: string; payload?: any }) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ v: 1, ...data }));
    }
  }

  subscribe(listener: WebSocketEventListener): () => void;
  subscribe(eventType: string, callback: (payload: any) => void): () => void;
  subscribe(
    listenerOrType: WebSocketEventListener | string,
    callback?: (payload: any) => void
  ): () => void {
    if (typeof listenerOrType === 'string' && callback) {
      const filteredListener: WebSocketEventListener = (event) => {
        if (event.type === listenerOrType) {
          callback(event.payload);
        }
      };
      this.listeners.add(filteredListener);
      return () => {
        this.listeners.delete(filteredListener);
      };
    }

    const listener = listenerOrType as WebSocketEventListener;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(type: string, payload: any) {
    for (const listener of this.listeners) {
      listener({ type, payload });
    }
  }

  private startHeartbeat() {
    clearInterval(this.pingInterval);
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 25000);
  }

  private cleanup() {
    const wasConnected = this.isConnected;
    this.isConnected = false;
    clearInterval(this.pingInterval);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    if (wasConnected) {
      for (const cb of this.connectionListeners) {
        try {
          cb(false);
        } catch {}
      }
    }
  }

  onConnectionChange(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  private scheduleReconnect() {
    clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      if (this.token) {
        this.connect(this.token);
      }
    }, 3000);
  }

  disconnect() {
    this.token = null;
    clearTimeout(this.reconnectTimeout);
    this.cleanup();
  }

  sendTyping(conversationId: string, isTyping: boolean) {
    this.send({
      type: 'typing',
      payload: { conversation_id: conversationId, is_typing: isTyping },
    });
  }

  sendCallSignal(signal: CallSignal) {
    this.send({
      type: 'call.signal',
      payload: signal,
    });
  }

  sendVoiceChatSignal(signal: { conversation_id: string; room_id: string; target_user_id?: string; signal_type: string; data?: any }) {
    this.send({
      type: 'voice_chat.signal',
      payload: signal,
    });
  }

  get connected(): boolean {
    return this.isConnected;
  }
}

export const wsManager = new WebSocketManager();
