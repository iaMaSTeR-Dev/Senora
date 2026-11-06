import { useEffect, useState } from 'react';
import { UserPresence } from '../../app/types';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';

type PresenceListener = (userId: string, presence: UserPresence) => void;

class PresenceManager {
  private presenceMap: Map<string, UserPresence> = new Map();
  private listeners: Set<PresenceListener> = new Set();
  private fetchingUsers: Set<string> = new Set();

  constructor() {
    if (typeof window !== 'undefined') {
      wsManager.subscribe((event) => {
        if (event.type === 'presence.update' && event.payload?.user_id) {
          const { user_id, is_online, last_seen_at } = event.payload;
          this.setPresence(user_id, {
            user_id,
            is_online: Boolean(is_online),
            last_seen_at,
          });
        }
      });
    }
  }

  setPresence(userId: string, presence: UserPresence) {
    this.presenceMap.set(userId, presence);
    for (const listener of this.listeners) {
      try {
        listener(userId, presence);
      } catch (e) {
        console.warn('[PresenceManager] Listener error:', e);
      }
    }
  }

  getPresence(userId: string): UserPresence | undefined {
    return this.presenceMap.get(userId);
  }

  async loadPresence(userId: string, force = false): Promise<UserPresence | null> {
    if (!userId) return null;
    if (!force && this.presenceMap.has(userId)) {
      return this.presenceMap.get(userId)!;
    }
    if (this.fetchingUsers.has(userId)) {
      return this.presenceMap.get(userId) || null;
    }

    this.fetchingUsers.add(userId);
    try {
      const p = await api.getUserPresence(userId);
      this.setPresence(userId, p);
      return p;
    } catch {
      return this.presenceMap.get(userId) || null;
    } finally {
      this.fetchingUsers.delete(userId);
    }
  }

  async loadBatchPresence(userIds: string[]): Promise<void> {
    const unique = Array.from(new Set(userIds)).filter((id) => id && !this.fetchingUsers.has(id));
    if (unique.length === 0) return;
    unique.forEach((id) => this.fetchingUsers.add(id));
    try {
      const list = await api.getBatchPresence(unique);
      for (const p of list) {
        if (p && p.user_id) {
          this.setPresence(p.user_id, p);
        }
      }
    } catch (e) {
      console.warn('[PresenceManager] Failed batch presence:', e);
    } finally {
      unique.forEach((id) => this.fetchingUsers.delete(id));
    }
  }

  async refreshAll(): Promise<void> {
    const userIds = Array.from(this.presenceMap.keys());
    if (userIds.length > 0) {
      await this.loadBatchPresence(userIds);
    }
  }

  subscribe(listener: PresenceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const presenceManager = new PresenceManager();

export function useUserPresence(userId?: string, lang: 'en' | 'fa' = 'en') {
  const [presence, setPresence] = useState<UserPresence | undefined>(() =>
    userId ? presenceManager.getPresence(userId) : undefined
  );

  useEffect(() => {
    if (!userId) return;

    // Fast-path: render existing cached presence immediately
    const cached = presenceManager.getPresence(userId);
    if (cached) {
      setPresence(cached);
    } else {
      presenceManager.loadPresence(userId, false).then((p) => {
        if (p) setPresence(p);
      });
    }

    const unsub = presenceManager.subscribe((uid, p) => {
      if (uid === userId) {
        setPresence({ ...p });
      }
    });

    return unsub;
  }, [userId]);

  const isOnline = Boolean(presence?.is_online);
  const lastSeenAt = presence?.last_seen_at;

  const getFormattedLastSeen = (): string => {
    const isFa = lang === 'fa';
    if (isOnline) {
      return isFa ? 'آنلاین' : 'online';
    }

    if (!lastSeenAt) {
      return isFa ? 'آخرین بازدید اخیراً' : 'last seen recently';
    }

    try {
      const d = new Date(lastSeenAt);
      if (isNaN(d.getTime())) {
        return isFa ? 'آخرین بازدید اخیراً' : 'last seen recently';
      }

      const now = new Date();
      const diffMs = now.getTime() - d.getTime();
      const diffMins = Math.floor(diffMs / 60000);

      if (diffMins < 1) {
        return isFa ? 'آخرین بازدید همین الان' : 'last seen just now';
      }
      if (diffMins < 60) {
        return isFa ? `آخرین بازدید ${diffMins} دقیقه پیش` : `last seen ${diffMins}m ago`;
      }

      const isToday = d.toDateString() === now.toDateString();
      const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      if (isToday) {
        return isFa ? `آخرین بازدید امروز در ${timeStr}` : `last seen today at ${timeStr}`;
      }

      return isFa
        ? `آخرین بازدید ${d.toLocaleDateString('fa-IR')} در ${timeStr}`
        : `last seen ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeStr}`;
    } catch {
      return isFa ? 'آخرین بازدید اخیراً' : 'last seen recently';
    }
  };

  return {
    isOnline,
    lastSeenAt,
    formattedLastSeen: getFormattedLastSeen(),
  };
}
