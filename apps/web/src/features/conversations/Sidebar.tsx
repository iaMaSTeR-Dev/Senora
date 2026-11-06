import React, { useState, useEffect } from 'react';
import { Conversation, User } from '../../app/types';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';
import { signalManager } from '../../crypto/signalManager';
import { translations, Language } from '../../app/i18n';
import {
  Search,
  Moon,
  Sun,
  LogOut,
  Shield,
  MessageSquarePlus,
  Menu,
  X,
  Users,
  Megaphone,
  Bookmark,
  Laptop,
  Settings as SettingsIcon,
  Plus,
  Pin,
  BellOff,
  Archive,
  Server,
  Bot,
  Folder,
  FolderPlus,
  Trash2,
  Edit2,
  Check,
  AtSign
} from 'lucide-react';
import { NewGroupOrChannelModal } from './NewGroupOrChannelModal';
import { OpenByIdModal } from './OpenByIdModal';
import { StoriesBar } from './StoriesBar';
import { UserProfileModal } from '../profile/UserProfileModal';
import { webrtcManager } from '../calls/webrtcManager';
import { useUserPresence, presenceManager } from '../presence/presenceManager';

interface SidebarProps {
  currentUser: User;
  conversations: Conversation[];
  activeConversation: Conversation | null;
  onSelectConversation: (conv: Conversation) => void;
  onConversationCreated: (conv: Conversation) => void;
  onOpenSettings: (tab?: string) => void;
  onLogout: () => void;
  lang: Language;
  onToggleLang: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

interface ConversationListItemProps {
  conversation: Conversation;
  isActive: boolean;
  isPinned: boolean;
  isMuted: boolean;
  currentUser: User;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  title: string;
  subtitle: string;
  isSaved: boolean;
  draft: string | null;
  lang: 'en' | 'fa';
}

const ConversationListItem: React.FC<ConversationListItemProps> = ({
  conversation: c,
  isActive,
  isPinned,
  isMuted,
  currentUser,
  onSelect,
  onContextMenu,
  title,
  subtitle,
  isSaved,
  draft,
  lang,
}) => {
  const peer = c.type === 'direct' && c.participants ? (c.participants.find((p) => p.id !== currentUser.id) || c.participants[0]) : null;
  const isMasterBot = c.id.includes('masterbot') || title.includes('Master Bot') || peer?.id === 'usr_senoramasterbot';
  const avatarSrc = isSaved ? null : (c.avatar_url || peer?.avatar_url);
  const peerPresence = useUserPresence(peer?.id, lang);
  const isOnline = Boolean(peer && peerPresence.isOnline);

  return (
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`w-full flex items-center gap-2.5 py-1.5 px-2.5 rounded-xl transition text-left cursor-pointer ${
        isActive ? 'bg-[#2b5278] text-white' : 'hover:bg-[#202b36] text-white'
      }`}
    >
      <div className="relative flex-shrink-0">
        <div
          className={`h-10 w-10 rounded-full flex items-center justify-center font-bold text-white shadow-sm overflow-hidden ${
            isSaved
              ? 'bg-[#24A1DE]'
              : isMasterBot
                ? 'bg-gradient-to-tr from-purple-600 to-indigo-600'
                : c.type === 'channel'
                  ? 'bg-gradient-to-tr from-purple-500 to-indigo-500'
                  : c.type === 'group'
                    ? 'bg-gradient-to-tr from-amber-500 to-orange-500'
                    : 'bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa]'
          }`}
        >
          {isSaved ? (
            <Bookmark className="h-5 w-5 text-white" />
          ) : avatarSrc ? (
            <img src={avatarSrc} alt={title} className="h-full w-full object-cover" />
          ) : isMasterBot ? (
            <Bot className="h-5 w-5 text-purple-200" />
          ) : c.type === 'channel' ? (
            <Megaphone className="h-5 w-5 text-white" />
          ) : c.type === 'group' ? (
            <Users className="h-5 w-5 text-white" />
          ) : (
            title.charAt(0).toUpperCase()
          )}
        </div>
        {c.type === 'direct' && !isSaved && isOnline && (
          <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full bg-emerald-500 border-2 border-[#17212b]" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5 truncate">
            {c.type === 'channel' && <Megaphone className="h-3 w-3 text-[#24A1DE] flex-shrink-0" />}
            {c.type === 'group' && <Users className="h-3 w-3 text-amber-400 flex-shrink-0" />}
            {isSaved && <Bookmark className="h-3 w-3 text-[#24A1DE] flex-shrink-0" />}
            <h3 className="text-xs font-semibold truncate">{title}</h3>
            {isMasterBot && (
              <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/25 text-purple-300 border border-purple-400/30 shrink-0">
                BOT
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-1">
            {isMuted && <BellOff className="h-3 w-3 text-[#7f91a4]" />}
            {isPinned && <Pin className="h-3 w-3 text-[#24A1DE]" />}
            <span className="text-[10px] text-[#7f91a4]">
              {new Date(c.updated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          {draft && draft.trim() ? (
            <p className="text-[11px] truncate flex-1 pr-1">
              <span className="text-red-400 font-semibold">Draft: </span>
              <span className="text-slate-300">{draft}</span>
            </p>
          ) : (
            <p className="text-[11px] text-[#7f91a4] truncate flex-1 pr-1">{subtitle}</p>
          )}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {c.pinned_message_id && <Pin className="h-3 w-3 text-[#24A1DE] flex-shrink-0" />}
            {c.unread_count !== undefined && c.unread_count > 0 && (
              <span className="min-w-4.5 h-4.5 px-1.5 flex items-center justify-center rounded-full bg-[#24A1DE] text-white text-[10px] font-bold shadow-sm">
                {c.unread_count > 99 ? '99+' : c.unread_count}
              </span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
};

export const formatPayloadPreview = (rawText: string, lang: 'en' | 'fa' = 'fa'): string => {
  if (!rawText) return '';
  const trimmed = rawText.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      // E2EE ciphertext envelope (Signal multi-device) - not readable as plaintext yet
      if (parsed.v === 2 || parsed.devices || parsed.device_messages || parsed.type === 'signal_multidevice') {
        return '';
      }
      if (parsed.type === 'call_event' || parsed.call_id) {
        return lang === 'fa' ? '📞 تماس' : '📞 Call';
      }
      if (parsed.type === 'poll' || parsed.poll_id) {
        return `📊 ${parsed.text || (lang === 'fa' ? 'نظرسنجی' : 'Poll')}`;
      }
      const att = parsed.attachment || parsed.attachmentMeta;
      if (att || parsed.type === 'attachment' || parsed.type === 'voice' || parsed.type === 'sticker' || parsed.type === 'video_note') {
        if (parsed.type === 'voice' || att?.isVoice) return lang === 'fa' ? '🎤 پیام صوتی' : '🎤 Voice message';
        if (parsed.type === 'video_note' || att?.isRoundVideo) return lang === 'fa' ? '📹 ویدیو مسیج' : '📹 Video note';
        if (parsed.type === 'sticker' || att?.isSticker) return lang === 'fa' ? '🎭 استیکر' : '🎭 Sticker';
        if (att?.isPhoto || att?.contentType?.startsWith('image/') || att?.filename?.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i)) {
          return parsed.text ? `📷 ${parsed.text}` : (lang === 'fa' ? '📷 عکس' : '📷 Photo');
        }
        if (att?.isVideo || att?.contentType?.startsWith('video/') || att?.filename?.match(/\.(mp4|webm|mov|mkv)$/i)) {
          return parsed.text ? `🎥 ${parsed.text}` : (lang === 'fa' ? '🎥 ویدیو' : '🎥 Video');
        }
        if (att?.fileName || att?.filename) {
          return `📁 ${att.fileName || att.filename}`;
        }
        return parsed.text || (lang === 'fa' ? '📁 فایل' : '📁 File');
      }
      if (typeof parsed.text === 'string' && parsed.text.trim()) {
        return parsed.text.trim();
      }
    } catch {}
  }
  return trimmed;
};

export interface ChatFolder {
  id: string;
  name: string;
  icon?: string;
  includedChatIds: string[];
}

export type CategoryTab = 'all' | 'direct' | 'groups' | 'channels' | 'bots' | 'saved' | 'archived' | string;

export const Sidebar: React.FC<SidebarProps> = ({
  currentUser,
  conversations,
  activeConversation,
  onSelectConversation,
  onConversationCreated,
  onOpenSettings,
  onLogout,
  lang,
  onToggleLang,
  theme,
  onToggleTheme,
}) => {
  const [activeTab, setActiveTab] = useState<CategoryTab>('all');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showOpenByIdModal, setShowOpenByIdModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    channels: Array<{ id: string; type: string; title: string; description: string; avatar_url: string; username?: string }>;
    users: User[];
    conversations: Conversation[];
  }>({ channels: [], users: [], conversations: [] });
  const [searching, setSearching] = useState(false);
  const [inspectedProfileUser, setInspectedProfileUser] = useState<User | null>(null);

  // Custom Chat Folders state
  const [customFolders, setCustomFolders] = useState<ChatFolder[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('senora_custom_folders') || '[]');
    } catch {
      return [];
    }
  });
  const [folderModalOpen, setFolderModalOpen] = useState(false);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderNameInput, setFolderNameInput] = useState('');
  const [folderSelectedConvIds, setFolderSelectedConvIds] = useState<string[]>([]);
  const [addToFolderModalConvId, setAddToFolderModalConvId] = useState<string | null>(null);

  const saveCustomFolders = (folders: ChatFolder[]) => {
    setCustomFolders(folders);
    try {
      localStorage.setItem('senora_custom_folders', JSON.stringify(folders));
    } catch (e) {
      console.warn('Failed to save folders to localStorage:', e);
    }
    api.setUserPreferences({ custom_folders: folders }).catch(() => {});
  };

  const openCreateFolder = () => {
    setEditingFolderId(null);
    setFolderNameInput('');
    setFolderSelectedConvIds([]);
    setFolderModalOpen(true);
  };

  const openEditFolder = (folder: ChatFolder, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setEditingFolderId(folder.id);
    setFolderNameInput(folder.name);
    setFolderSelectedConvIds([...folder.includedChatIds]);
    setFolderModalOpen(true);
  };

  const handleDeleteFolder = (folderId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const updated = customFolders.filter((f) => f.id !== folderId);
    saveCustomFolders(updated);
    if (activeTab === `folder_${folderId}`) {
      setActiveTab('all');
    }
  };

  const handleSaveCurrentFolder = () => {
    const trimmed = folderNameInput.trim();
    if (!trimmed) return;

    if (editingFolderId) {
      const updated = customFolders.map((f) =>
        f.id === editingFolderId ? { ...f, name: trimmed, includedChatIds: folderSelectedConvIds } : f
      );
      saveCustomFolders(updated);
    } else {
      const newFolder: ChatFolder = {
        id: 'fld_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        name: trimmed,
        includedChatIds: folderSelectedConvIds,
      };
      saveCustomFolders([...customFolders, newFolder]);
      setActiveTab(`folder_${newFolder.id}`);
    }
    setFolderModalOpen(false);
  };

  const toggleConvInFolder = (folderId: string, convId: string) => {
    const updated = customFolders.map((f) => {
      if (f.id !== folderId) return f;
      const exists = f.includedChatIds.includes(convId);
      return {
        ...f,
        includedChatIds: exists
          ? f.includedChatIds.filter((id) => id !== convId)
          : [...f.includedChatIds, convId],
      };
    });
    saveCustomFolders(updated);
  };

  // Pin, Mute, Archive state (Phase 10.7)
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('senora_pinned_convs') || '[]');
    } catch {
      return [];
    }
  });
  const [mutedIds, setMutedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('senora_muted_convs') || '[]');
    } catch {
      return [];
    }
  });
  const [archivedIds, setArchivedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('senora_archived_convs') || '[]');
    } catch {
      return [];
    }
  });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; convId: string } | null>(null);

  // Initial sync of user preferences (pinned, archived, muted, folders) from server across devices
  useEffect(() => {
    if (!currentUser?.id) return;
    let cancelled = false;

    api.getUserPreferences().then((remotePrefs) => {
      if (cancelled || !remotePrefs) return;

      // Pinned chats sync
      const remotePinned = remotePrefs.pinned_convs || remotePrefs.pinnedIds;
      if (Array.isArray(remotePinned)) {
        setPinnedIds(remotePinned);
        try { localStorage.setItem('senora_pinned_convs', JSON.stringify(remotePinned)); } catch {}
      } else {
        try {
          const localPinned = JSON.parse(localStorage.getItem('senora_pinned_convs') || '[]');
          if (localPinned.length > 0) {
            api.setUserPreferences({ pinned_convs: localPinned }).catch(() => {});
          }
        } catch {}
      }

      // Archived chats sync
      const remoteArchived = remotePrefs.archived_convs || remotePrefs.archivedIds;
      if (Array.isArray(remoteArchived)) {
        setArchivedIds(remoteArchived);
        try { localStorage.setItem('senora_archived_convs', JSON.stringify(remoteArchived)); } catch {}
      } else {
        try {
          const localArchived = JSON.parse(localStorage.getItem('senora_archived_convs') || '[]');
          if (localArchived.length > 0) {
            api.setUserPreferences({ archived_convs: localArchived }).catch(() => {});
          }
        } catch {}
      }

      // Muted chats sync
      const remoteMuted = remotePrefs.muted_convs || remotePrefs.mutedIds;
      if (Array.isArray(remoteMuted)) {
        setMutedIds(remoteMuted);
        try { localStorage.setItem('senora_muted_convs', JSON.stringify(remoteMuted)); } catch {}
      } else {
        try {
          const localMuted = JSON.parse(localStorage.getItem('senora_muted_convs') || '[]');
          if (localMuted.length > 0) {
            api.setUserPreferences({ muted_convs: localMuted }).catch(() => {});
          }
        } catch {}
      }

      // Custom Folders sync
      if (Array.isArray(remotePrefs.custom_folders)) {
        setCustomFolders(remotePrefs.custom_folders);
        try { localStorage.setItem('senora_custom_folders', JSON.stringify(remotePrefs.custom_folders)); } catch {}
      } else {
        try {
          const localFolders = JSON.parse(localStorage.getItem('senora_custom_folders') || '[]');
          if (localFolders.length > 0) {
            api.setUserPreferences({ custom_folders: localFolders }).catch(() => {});
          }
        } catch {}
      }
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [currentUser?.id]);

  // Real-time cross-device sync of user preferences via WebSocket
  useEffect(() => {
    const unsub = wsManager.subscribe((event) => {
      if (event.type === 'user.preferences_updated') {
        let prefs = event.payload;
        if (typeof prefs === 'string') {
          try {
            prefs = JSON.parse(prefs);
          } catch {}
        }
        if (prefs && typeof prefs === 'object') {
          const newPinned = prefs.pinned_convs || prefs.pinnedIds;
          if (Array.isArray(newPinned)) {
            setPinnedIds(newPinned);
            try { localStorage.setItem('senora_pinned_convs', JSON.stringify(newPinned)); } catch {}
          }
          const newArchived = prefs.archived_convs || prefs.archivedIds;
          if (Array.isArray(newArchived)) {
            setArchivedIds(newArchived);
            try { localStorage.setItem('senora_archived_convs', JSON.stringify(newArchived)); } catch {}
          }
          const newMuted = prefs.muted_convs || prefs.mutedIds;
          if (Array.isArray(newMuted)) {
            setMutedIds(newMuted);
            try { localStorage.setItem('senora_muted_convs', JSON.stringify(newMuted)); } catch {}
          }
          if (Array.isArray(prefs.custom_folders)) {
            setCustomFolders(prefs.custom_folders);
            try { localStorage.setItem('senora_custom_folders', JSON.stringify(prefs.custom_folders)); } catch {}
          }
        }
      }
    });
    return () => unsub();
  }, []);

  // Decrypted message previews cached per conversation
  const [decryptedPreviews, setDecryptedPreviews] = useState<Record<string, { msgId: string; text: string }>>(() => {
    const initial: Record<string, { msgId: string; text: string }> = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('senora_preview_')) {
          const convId = k.replace('senora_preview_', '');
          const val = JSON.parse(localStorage.getItem(k) || '{}');
          if (val && val.text) initial[convId] = val;
        }
      }
    } catch {}
    return initial;
  });

  // Listen for real-time decrypted preview announcements
  useEffect(() => {
    const onPreview = (e: any) => {
      const { conversationId, text, messageId } = e.detail || {};
      if (conversationId && text) {
        setDecryptedPreviews((prev) => ({
          ...prev,
          [conversationId]: { msgId: messageId || '', text },
        }));
        try {
          localStorage.setItem(
            'senora_preview_' + conversationId,
            JSON.stringify({ msgId: messageId || '', text })
          );
        } catch {}
      }
    };
    window.addEventListener('senora_message_preview', onPreview);
    return () => window.removeEventListener('senora_message_preview', onPreview);
  }, []);

  // Background decryption and preview caching
  useEffect(() => {
    const myDeviceId = localStorage.getItem('senora_device_id') || 'dev_current';

    conversations.forEach((c) => {
      const msg = c.last_message;
      if (!msg) return;

      // Already cached for this exact message?
      if (decryptedPreviews[c.id]?.msgId === msg.id) return;

      if (msg.is_deleted) {
        const text = translations[lang].deleted_message;
        setDecryptedPreviews((prev) => ({ ...prev, [c.id]: { msgId: msg.id, text } }));
        return;
      }

      // If plaintext already in memory
      if (msg.plaintext) {
        const text = formatPayloadPreview(msg.plaintext, lang);
        if (text) {
          setDecryptedPreviews((prev) => ({ ...prev, [c.id]: { msgId: msg.id, text } }));
          try {
            localStorage.setItem('senora_preview_' + c.id, JSON.stringify({ msgId: msg.id, text }));
          } catch {}
          return;
        }
      }

      // Try normal/unencrypted extraction
      const normalText = formatPayloadPreview(msg.ciphertext, lang);
      if (normalText) {
        setDecryptedPreviews((prev) => ({ ...prev, [c.id]: { msgId: msg.id, text: normalText } }));
        try {
          localStorage.setItem('senora_preview_' + c.id, JSON.stringify({ msgId: msg.id, text: normalText }));
        } catch {}
        return;
      }

      // E2EE background decryption
      const peer = c.participants?.find((p) => p.id !== currentUser.id) || c.participants?.[0];
      const targetUserId = peer ? peer.id : currentUser.id;

      api.getUserKeys(targetUserId).then(async (pkg) => {
        const peerKey = pkg?.devices?.[0]?.identity_public_key || '';
        const decrypted = await signalManager.decryptMessage(
          msg.ciphertext,
          msg.nonce,
          msg.sender_id,
          msg.sender_id === currentUser.id ? myDeviceId : '',
          peerKey,
          c.id
        );
        const text = formatPayloadPreview(decrypted, lang) || (lang === 'fa' ? 'پیام جدید' : 'New message');
        setDecryptedPreviews((prev) => ({ ...prev, [c.id]: { msgId: msg.id, text } }));
        try {
          localStorage.setItem('senora_preview_' + c.id, JSON.stringify({ msgId: msg.id, text }));
        } catch {}
      }).catch(() => {
        // Kept as localized Encrypted message fallback
      });
    });
  }, [conversations, currentUser.id, lang]);

  const togglePin = (convId: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(convId) ? prev.filter((id) => id !== convId) : [...prev, convId];
      try {
        localStorage.setItem('senora_pinned_convs', JSON.stringify(next));
      } catch {}
      api.setUserPreferences({ pinned_convs: next }).catch((err) => {
        console.error('Failed to sync pinned chats:', err);
      });
      return next;
    });
    setContextMenu(null);
  };

  const toggleMute = (convId: string) => {
    setMutedIds((prev) => {
      const next = prev.includes(convId) ? prev.filter((id) => id !== convId) : [...prev, convId];
      try {
        localStorage.setItem('senora_muted_convs', JSON.stringify(next));
      } catch {}
      api.setUserPreferences({ muted_convs: next }).catch((err) => {
        console.error('Failed to sync muted chats:', err);
      });
      return next;
    });
    setContextMenu(null);
  };

  const toggleArchive = (convId: string) => {
    setArchivedIds((prev) => {
      const next = prev.includes(convId) ? prev.filter((id) => id !== convId) : [...prev, convId];
      try {
        localStorage.setItem('senora_archived_convs', JSON.stringify(next));
      } catch {}
      api.setUserPreferences({ archived_convs: next }).catch((err) => {
        console.error('Failed to sync archived chats:', err);
      });
      return next;
    });
    setContextMenu(null);
  };

  const t = translations[lang];

  // Debounced global search across public channels, users, and conversations
  useEffect(() => {
    const raw = searchQuery.trim();
    if (!raw) {
      setSearchResults({ channels: [], users: [], conversations: [] });
      setSearching(false);
      return;
    }

    const clean = raw.replace(/^@/, '').trim();
    if (!clean) {
      setSearchResults({ channels: [], users: [], conversations: [] });
      setSearching(false);
      return;
    }

    setSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const qLower = clean.toLowerCase();

        // 1. Local active conversations matching query
        const localMatches = conversations.filter((c) => {
          if (c.title && c.title.toLowerCase().includes(qLower)) return true;
          if (c.description && c.description.toLowerCase().includes(qLower)) return true;
          if (c.participants) {
            return c.participants.some(
              (p) => p.username.toLowerCase().includes(qLower) || (p.display_name && p.display_name.toLowerCase().includes(qLower))
            );
          }
          return false;
        });

        // 2. Strict ID search for public channels and users:
        // Must be an explicit handle or ID: starts with '@', 'cnv_', 'usr_', OR length >= 3 with no spaces.
        const isPotentialID = raw.startsWith('@') || raw.startsWith('cnv_') || raw.startsWith('usr_') || (clean.length >= 3 && !/\s/.test(clean));

        let resChannels: any[] = [];
        let resUsers: User[] = [];
        let resConvs: Conversation[] = [];

        if (isPotentialID) {
          const res = await api.globalSearch(clean);
          resChannels = res.channels || [];
          resUsers = res.users || [];
          resConvs = res.conversations || [];
        }

        const isOwner = Boolean(currentUser?.is_owner);

        // Strict exact match filter for users:
        // Only keep if username exactly matches query OR id exactly matches query
        const exactUsers = isPotentialID
          ? resUsers.filter((u) => {
              if (u.id === 'usr_senoramasterbot' && !isOwner) return false;
              return u.username.toLowerCase() === qLower || u.id.toLowerCase() === qLower;
            })
          : [];

        // Strict exact match filter for channels:
        // Only keep if channel username exactly matches query OR conversation id exactly matches query
        const exactChannels = isPotentialID
          ? resChannels.filter((ch) => {
              return (
                (ch.username && ch.username.toLowerCase() === qLower) ||
                ch.id.toLowerCase() === qLower
              );
            })
          : [];

        const convMap = new Map<string, Conversation>();
        resConvs.forEach((c) => convMap.set(c.id, c));
        localMatches.forEach((c) => convMap.set(c.id, c));

        const filteredConvs = Array.from(convMap.values()).filter((c) => {
          if (!isOwner) {
            if (c.id.includes('masterbot') || c.participants?.some((p) => p.id === 'usr_senoramasterbot')) {
              return false;
            }
          }
          return true;
        });

        setSearchResults({
          channels: exactChannels,
          users: exactUsers,
          conversations: filteredConvs,
        });
      } catch (e) {
        console.error('Failed to execute global search:', e);
      } finally {
        setSearching(false);
      }
    }, 200);

    return () => clearTimeout(timeout);
  }, [searchQuery, conversations]);

  const handleStartDirectChat = async (targetUser: User) => {
    try {
      const conv = await api.createDirectConversation(targetUser.id);
      onConversationCreated(conv);
      onSelectConversation(conv);
      setSearchQuery('');
      setSearchResults({ channels: [], users: [], conversations: [] });
    } catch (e) {
      console.error('Failed to create conversation:', e);
    }
  };

  const handleOpenSavedMessages = async () => {
    setDrawerOpen(false);
    // Find or create direct chat with oneself
    const existing = conversations.find(
      (c) => c.type === 'saved' || (c.type === 'direct' && c.participants?.every((p) => p.id === currentUser.id))
    );
    if (existing) {
      onSelectConversation(existing);
      return;
    }
    try {
      const conv = await api.createDirectConversation(currentUser.id);
      onConversationCreated(conv);
      onSelectConversation(conv);
    } catch (e) {
      console.error('Failed to open saved messages:', e);
    }
  };

  const getConversationTitle = (c: Conversation): string => {
    if (c.type === 'saved') return t.saved_messages;
    if (c.type === 'direct' && c.participants) {
      const peer = c.participants.find((p) => p.id !== currentUser.id) || c.participants[0];
      if (peer) {
        if (peer.id === currentUser.id) return t.saved_messages;
        return peer.display_name || peer.username;
      }
    }
    if (c.title) return c.title;
    if (c.type === 'channel') return 'Channel';
    if (c.type === 'group') return 'Group';
    return 'Chat';
  };

  const getConversationSubtitle = (c: Conversation): string => {
    if (c.last_message) {
      if (c.last_message.is_deleted) return t.deleted_message;

      // 1. Check cached preview for this conversation
      const cached = decryptedPreviews[c.id];
      if (cached?.text) return cached.text;

      // 2. Plaintext if already available
      if (c.last_message.plaintext) {
        const preview = formatPayloadPreview(c.last_message.plaintext, lang);
        if (preview) return preview;
      }

      // 3. Normal / unencrypted ciphertext or JSON payload
      const unencryptedPreview = formatPayloadPreview(c.last_message.ciphertext, lang);
      if (unencryptedPreview) return unencryptedPreview;

      // 4. Fallback for pending E2EE decryption
      return t.encrypted_message || (lang === 'fa' ? 'پیام رمزگذاری‌شده' : 'Encrypted message');
    }
    if (c.type === 'channel') return c.description || t.channel_desc;
    return t.start_chat;
  };

  // Filter conversations according to category tab and archive status (Phase 10.7)
  const filteredConversations = conversations.filter((c) => {
    // Master Bot must NEVER be shown to non-owners
    const isBot = c.id.includes('masterbot') || c.participants?.some((p) => p.id === 'usr_senoramasterbot');
    if (isBot && !currentUser?.is_owner) {
      return false;
    }

    const isSaved = c.type === 'saved' || (c.type === 'direct' && c.participants?.every((p) => p.id === currentUser.id));
    const isArchived = archivedIds.includes(c.id);

    if (activeTab === 'archived') return isArchived;
    if (isArchived) return false;

    if (activeTab === 'all') return true;
    if (activeTab === 'saved') return isSaved;
    if (isSaved) return false;
    if (activeTab === 'direct') return c.type === 'direct';
    if (activeTab === 'groups') return c.type === 'group';
    if (activeTab === 'channels') return c.type === 'channel';
    if (activeTab === 'bots') return isBot;
    if (activeTab.startsWith('folder_')) {
      const folderId = activeTab.replace('folder_', '');
      const folder = customFolders.find((f) => f.id === folderId);
      return folder ? folder.includedChatIds.includes(c.id) : false;
    }
    return true;
  });

  const sortedConversations = [...filteredConversations].sort((a, b) => {
    const aPinned = pinnedIds.includes(a.id);
    const bPinned = pinnedIds.includes(b.id);
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  useEffect(() => {
    const peerIds = conversations
      .filter((c) => c.type === 'direct' && c.participants)
      .flatMap((c) => c.participants || [])
      .filter((p) => p.id !== currentUser.id)
      .map((p) => p.id);
    if (peerIds.length > 0) {
      presenceManager.loadBatchPresence(peerIds);
    }
  }, [conversations, currentUser.id]);

  return (
    <>
      <aside className="w-full md:w-80 lg:w-96 flex-shrink-0 flex flex-col h-full max-h-[100dvh] bg-[#17212b] border-r border-[#101921] select-none text-white relative overflow-hidden">
        {/* Top Header with Hamburger Menu and Search */}
        <div className="p-3.5 pt-[max(0.875rem,env(safe-area-inset-top,0px))] flex items-center justify-between border-b border-[#101921] bg-[#17212b] flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <button
              onClick={() => setDrawerOpen(true)}
              className="p-2 rounded-xl text-[#7f91a4] hover:text-white hover:bg-[#202b36] transition cursor-pointer"
              title="Open Menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm tracking-wide text-white">{t.app_title}</span>
              <span className="px-1.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[9px] font-bold tracking-wider">
                SIGNAL E2EE
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowNewModal(true)}
              className="p-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white shadow-md shadow-[#24A1DE]/25 transition cursor-pointer"
              title={t.new_chat}
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="px-3 pt-2 pb-1.5">
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-[#7f91a4]" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.search_placeholder}
              className="w-full rounded-xl bg-[#242f3d] py-2 pl-9 pr-4 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-2.5 text-[#7f91a4] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Stories Bar (Phase 15) */}
        {searchQuery.trim() === '' && <StoriesBar currentUser={currentUser} />}

        {/* Category Tabs (All, Direct, Groups, Channels, Saved Messages, Archived) */}
        {searchQuery.trim() === '' && (
          <div className="flex px-2 border-b border-[#101921] bg-[#17212b] overflow-x-auto no-scrollbar">
            <button
              onClick={() => setActiveTab('all')}
              className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${activeTab === 'all'
                  ? 'border-[#24A1DE] text-[#24A1DE]'
                  : 'border-transparent text-[#7f91a4] hover:text-white'
                }`}
            >
              {t.all_chats}
            </button>
            <button
              onClick={() => setActiveTab('direct')}
              className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${activeTab === 'direct'
                  ? 'border-[#24A1DE] text-[#24A1DE]'
                  : 'border-transparent text-[#7f91a4] hover:text-white'
                }`}
            >
              {t.direct}
            </button>
            <button
              onClick={() => setActiveTab('groups')}
              className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${activeTab === 'groups'
                  ? 'border-[#24A1DE] text-[#24A1DE]'
                  : 'border-transparent text-[#7f91a4] hover:text-white'
                }`}
            >
              {t.groups}
            </button>
            <button
              onClick={() => setActiveTab('channels')}
              className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${activeTab === 'channels'
                  ? 'border-[#24A1DE] text-[#24A1DE]'
                  : 'border-transparent text-[#7f91a4] hover:text-white'
                }`}
            >
              {t.channels}
            </button>
            <button
              onClick={() => setActiveTab('bots')}
              className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${activeTab === 'bots'
                  ? 'border-[#24A1DE] text-[#24A1DE]'
                  : 'border-transparent text-[#7f91a4] hover:text-white'
                }`}
            >
              {t.bots}
            </button>
            {/* Custom Chat Folders */}
            {customFolders.map((f) => (
              <div key={f.id} className="relative group/tab flex items-center">
                <button
                  onClick={() => setActiveTab(`folder_${f.id}`)}
                  className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${
                    activeTab === `folder_${f.id}`
                      ? 'border-[#24A1DE] text-[#24A1DE]'
                      : 'border-transparent text-[#7f91a4] hover:text-white'
                  }`}
                >
                  {f.name}
                </button>
                <button
                  type="button"
                  onClick={(e) => openEditFolder(f, e)}
                  title={t.edit_folder}
                  className="opacity-0 group-hover/tab:opacity-100 p-1 text-[#7f91a4] hover:text-[#24A1DE] transition -ml-1 mr-1 cursor-pointer"
                >
                  <Edit2 className="h-2.5 w-2.5" />
                </button>
              </div>
            ))}
            {/* Add New Folder Button */}
            <button
              type="button"
              onClick={openCreateFolder}
              title={t.new_folder}
              className="px-2 py-2 text-xs font-semibold whitespace-nowrap border-b-2 border-transparent text-[#7f91a4] hover:text-[#24A1DE] transition cursor-pointer flex items-center gap-1"
            >
              <FolderPlus className="h-3.5 w-3.5" />
              <span className="text-[11px]">+</span>
            </button>
            <button
              onClick={() => setActiveTab('saved')}
              className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${activeTab === 'saved'
                  ? 'border-[#24A1DE] text-[#24A1DE]'
                  : 'border-transparent text-[#7f91a4] hover:text-white'
                }`}
            >
              {t.saved_messages}
            </button>
            <button
              onClick={() => setActiveTab('archived')}
              className={`px-3 py-2 text-xs font-semibold whitespace-nowrap border-b-2 transition cursor-pointer ${activeTab === 'archived'
                  ? 'border-[#24A1DE] text-[#24A1DE]'
                  : 'border-transparent text-[#7f91a4] hover:text-white'
                }`}
            >
              {lang === 'fa' ? 'پوشه آرشیو' : 'Archived'} ({archivedIds.length})
            </button>
          </div>
        )}

        {/* Main List */}
        <div className="flex-1 overflow-y-auto px-2 py-0.5 space-y-0.5 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))]">
          {/* Global Search Results */}
          {searchQuery.trim() !== '' && (
            <div className="mb-3 space-y-3">
              {searching ? (
                <div className="p-4 text-center text-xs text-[#7f91a4]">Searching across Senora...</div>
              ) : searchResults.conversations.length === 0 && searchResults.channels.length === 0 && searchResults.users.length === 0 ? (
                <div className="p-4 rounded-2xl bg-[#1c2733] border border-[#242f3d] text-center space-y-2 my-2 select-none">
                  <div className="h-10 w-10 mx-auto rounded-full bg-[#24A1DE]/15 flex items-center justify-center text-[#24A1DE]">
                    <Search className="h-5 w-5" />
                  </div>
                  <p className="text-xs font-bold text-white">
                    {lang === 'fa' ? 'نتیجه‌ای با این شناسه یافت نشد' : 'No exact match found'}
                  </p>
                  <p className="text-[11px] text-[#7f91a4] leading-relaxed max-w-xs mx-auto">
                    {lang === 'fa'
                      ? 'جستجوی آزاد یوزرنیم و کانال غیرفعال است. جهت باز کردن گفتگو، کانال یا گروه، آیدی دقیق را وارد کنید (مانند username@ یا شناسه دقیق).'
                      : 'Public search is disabled. Enter the exact @username, channel handle, or conversation ID to open.'}
                  </p>
                </div>
              ) : (
                <>
                  {/* Matching Active Chats */}
                  {searchResults.conversations.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[11px] font-semibold text-[#7f91a4] uppercase tracking-wider">
                        {lang === 'fa' ? 'گفتگوهای شما' : 'Chats'}
                      </div>
                      {searchResults.conversations.map((c) => {
                        const title = getConversationTitle(c);
                        const subtitle = getConversationSubtitle(c);
                        const isSaved = c.type === 'saved' || (c.type === 'direct' && c.participants?.every((p) => p.id === currentUser.id));
                        const peer = c.type === 'direct' && c.participants ? (c.participants.find((p) => p.id !== currentUser.id) || c.participants[0]) : null;
                        const avatarSrc = isSaved ? null : (c.avatar_url || peer?.avatar_url);

                        return (
                          <button
                            key={c.id}
                            onClick={() => {
                              onSelectConversation(c);
                              setSearchQuery('');
                            }}
                            className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[#202b36] transition text-left cursor-pointer"
                          >
                            <div className="relative flex-shrink-0">
                              <div
                                className={`h-10 w-10 rounded-full flex items-center justify-center font-bold text-white shadow-sm overflow-hidden ${
                                  isSaved
                                    ? 'bg-[#24A1DE]'
                                    : c.type === 'channel'
                                      ? 'bg-gradient-to-tr from-purple-500 to-indigo-500'
                                      : c.type === 'group'
                                        ? 'bg-gradient-to-tr from-amber-500 to-orange-500'
                                        : 'bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa]'
                                }`}
                              >
                                {isSaved ? (
                                  <Bookmark className="h-5 w-5 text-white" />
                                ) : avatarSrc ? (
                                  <img src={avatarSrc} alt={title} className="h-full w-full object-cover" />
                                ) : (
                                  title.charAt(0).toUpperCase()
                                )}
                              </div>
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-white truncate">{title}</p>
                              <p className="text-xs text-[#7f91a4] truncate">{subtitle}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Public Channels & Groups */}
                  {searchResults.channels.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[11px] font-semibold text-[#7f91a4] uppercase tracking-wider">
                        {lang === 'fa' ? 'کانال‌ها و گروه‌ها' : 'Channels & Groups'}
                      </div>
                      {searchResults.channels.map((ch) => {
                        const isChannel = ch.type === 'channel';
                        return (
                          <button
                            key={ch.id}
                            onClick={async () => {
                              try {
                                const existing = conversations.find((c) => c.id === ch.id);
                                if (existing) {
                                  onSelectConversation(existing);
                                } else {
                                  const conv = await api.joinConversation(ch.id);
                                  onConversationCreated(conv);
                                  onSelectConversation(conv);
                                }
                              } catch {
                                try {
                                  const conv = await api.getConversation(ch.id);
                                  onConversationCreated(conv);
                                  onSelectConversation(conv);
                                } catch (e: any) {
                                  alert(e?.message || 'Could not open conversation');
                                }
                              }
                              setSearchQuery('');
                            }}
                            className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[#202b36] transition text-left cursor-pointer"
                          >
                            <div
                              className={`h-10 w-10 rounded-full flex items-center justify-center font-bold text-white shadow-sm overflow-hidden flex-shrink-0 ${
                                isChannel
                                  ? 'bg-gradient-to-tr from-purple-500 to-indigo-500'
                                  : 'bg-gradient-to-tr from-amber-500 to-orange-500'
                              }`}
                            >
                              {isChannel ? <Megaphone className="h-5 w-5 text-white" /> : <Users className="h-5 w-5 text-white" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <p className="text-sm font-medium text-white truncate">{ch.title}</p>
                                <span
                                  className={`px-1.5 py-0.5 rounded text-[9px] font-semibold ${
                                    isChannel ? 'bg-purple-500/20 text-purple-300' : 'bg-amber-500/20 text-amber-300'
                                  }`}
                                >
                                  {isChannel ? (lang === 'fa' ? 'کانال' : 'Channel') : (lang === 'fa' ? 'گروه' : 'Group')}
                                </span>
                              </div>
                              <p className="text-xs text-[#7f91a4] truncate">
                                {ch.username ? `@${ch.username}` : ch.description || (isChannel ? 'Public channel' : 'Group')}
                              </p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Users */}
                  {searchResults.users.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[11px] font-semibold text-[#7f91a4] uppercase tracking-wider">
                        {lang === 'fa' ? 'کاربران' : t.users_found}
                      </div>
                      {searchResults.users.map((user) => (
                        <button
                          key={user.id}
                          onClick={() => handleStartDirectChat(user)}
                          className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[#202b36] transition text-left cursor-pointer"
                        >
                          <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-[#3ca9e2] to-[#24A1DE] flex items-center justify-center font-bold text-white shadow-sm overflow-hidden flex-shrink-0">
                            {user.avatar_url ? (
                              <img src={user.avatar_url} alt={user.display_name} className="h-full w-full object-cover" />
                            ) : (
                              user.display_name.charAt(0).toUpperCase()
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-white truncate">{user.display_name}</p>
                              <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-[#24A1DE]/20 text-[#24A1DE]">
                                {lang === 'fa' ? 'کاربر' : 'User'}
                              </span>
                            </div>
                            <p className="text-xs text-[#7f91a4] truncate">@{user.username}</p>
                            {user.bio && <p className="text-[11px] text-[#7f91a4]/80 truncate">{user.bio}</p>}
                          </div>
                          <MessageSquarePlus className="h-4 w-4 text-[#24A1DE]" />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Conversations List */}
          {searchQuery.trim() === '' && filteredConversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-center p-4">
              <div className="h-12 w-12 rounded-full bg-[#242f3d] flex items-center justify-center mb-3 text-[#7f91a4]">
                {activeTab === 'groups' ? (
                  <Users className="h-6 w-6 text-[#24A1DE]" />
                ) : activeTab === 'channels' ? (
                  <Megaphone className="h-6 w-6 text-[#24A1DE]" />
                ) : (
                  <Shield className="h-6 w-6 text-[#24A1DE]" />
                )}
              </div>
              <p className="text-xs font-semibold text-white mb-1">
                {activeTab === 'groups'
                  ? 'No Groups Yet'
                  : activeTab === 'channels'
                    ? 'No Channels Yet'
                    : t.no_conversations}
              </p>
              <p className="text-[11px] text-[#7f91a4] max-w-[200px]">
                {activeTab === 'groups'
                  ? 'Create a group to chat with multiple peers'
                  : activeTab === 'channels'
                    ? 'Create a channel to broadcast updates'
                    : t.start_chat}
              </p>
            </div>
          ) : (
            sortedConversations.map((c) => (
              <ConversationListItem
                key={c.id}
                conversation={c}
                isActive={activeConversation?.id === c.id}
                isPinned={pinnedIds.includes(c.id)}
                isMuted={mutedIds.includes(c.id)}
                currentUser={currentUser}
                onSelect={() => onSelectConversation(c)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({ x: e.clientX, y: e.clientY, convId: c.id });
                }}
                title={getConversationTitle(c)}
                subtitle={getConversationSubtitle(c)}
                isSaved={Boolean(c.type === 'saved' || (c.type === 'direct' && c.participants?.every((p) => p.id === currentUser.id)))}
                draft={localStorage.getItem('senora_draft_' + c.id)}
                lang={lang}
              />
            ))
          )}
        </div>
      </aside>

      {/* Telegram Drawer / Menu */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 flex animate-fade-in select-none">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs transition"
            onClick={() => setDrawerOpen(false)}
          />

          {/* Drawer Panel */}
          <div className="relative w-72 md:w-80 h-full max-h-[100dvh] bg-[#17212b] border-r border-[#242f3d] flex flex-col z-10 shadow-2xl overflow-hidden">
            {/* User Profile Header */}
            <div
              onClick={() => {
                setDrawerOpen(false);
                setInspectedProfileUser(currentUser);
              }}
              className="p-5 pt-[max(1.25rem,env(safe-area-inset-top,0px))] bg-[#1f2b38] border-b border-[#242f3d] cursor-pointer hover:bg-[#233140] transition flex-shrink-0"
              title="View Profile"
            >
              <div className="flex items-center justify-between mb-3">
                <div className="h-14 w-14 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa] flex items-center justify-center font-bold text-white text-xl shadow-md overflow-hidden">
                  {currentUser.avatar_url ? (
                    <img src={currentUser.avatar_url} alt="Avatar" className="h-full w-full object-cover" />
                  ) : (
                    currentUser.display_name.charAt(0).toUpperCase()
                  )}
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDrawerOpen(false);
                  }}
                  className="p-1 rounded-lg text-[#7f91a4] hover:text-white"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <h2 className="text-sm font-bold text-white truncate">{currentUser.display_name}</h2>
              <p className="text-xs text-[#7f91a4] truncate">@{currentUser.username}</p>
              {currentUser.bio && (
                <p className="text-xs text-[#7f91a4]/90 mt-1 line-clamp-2 leading-relaxed">{currentUser.bio}</p>
              )}
            </div>

            {/* Menu Items */}
            <div className="flex-1 overflow-y-auto p-3 space-y-1">
              {currentUser.is_owner && (
                <button
                  onClick={async () => {
                    setDrawerOpen(false);
                    try {
                      const res = await api.getMasterBotConversation();
                      if (res.conversation) {
                        onSelectConversation(res.conversation);
                      }
                    } catch (err: any) {
                      alert(err?.message || 'Failed to open Master Bot');
                    }
                  }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-gradient-to-r from-purple-900/40 to-[#24A1DE]/20 hover:from-purple-900/60 hover:to-[#24A1DE]/40 border border-purple-500/30 transition text-left text-xs font-semibold text-white cursor-pointer shadow-sm mb-1.5"
                >
                  <div className="flex items-center gap-3.5">
                    <Bot className="h-4 w-4 text-purple-400" />
                    <span>🤖 Senora Master Bot</span>
                  </div>
                  <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-purple-500/30 text-purple-200 border border-purple-400/30">
                    OWNER
                  </span>
                </button>
              )}

              <button
                onClick={handleOpenSavedMessages}
                className="w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-[#202b36] transition text-left text-xs font-semibold text-white cursor-pointer"
              >
                <Bookmark className="h-4 w-4 text-[#24A1DE]" />
                <span>{t.saved_messages}</span>
              </button>

              <button
                onClick={() => {
                  setDrawerOpen(false);
                  setShowNewModal(true);
                }}
                className="w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-[#202b36] transition text-left text-xs font-semibold text-white cursor-pointer"
              >
                <Users className="h-4 w-4 text-amber-400" />
                <span>{t.new_group}</span>
              </button>

              <button
                onClick={() => {
                  setDrawerOpen(false);
                  setShowNewModal(true);
                }}
                className="w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-[#202b36] transition text-left text-xs font-semibold text-white cursor-pointer"
              >
                <Megaphone className="h-4 w-4 text-purple-400" />
                <span>{t.new_channel}</span>
              </button>

              <button
                onClick={() => {
                  setDrawerOpen(false);
                  setShowOpenByIdModal(true);
                }}
                className="w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-[#202b36] transition text-left text-xs font-semibold text-white cursor-pointer"
              >
                <AtSign className="h-4 w-4 text-[#24A1DE]" />
                <span>{lang === 'fa' ? 'باز کردن با شناسه یا آیدی' : 'Open by ID / Handle'}</span>
              </button>

              <button
                onClick={() => {
                  setDrawerOpen(false);
                  onOpenSettings('devices');
                }}
                className="w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-[#202b36] transition text-left text-xs font-semibold text-white cursor-pointer"
              >
                <Laptop className="h-4 w-4 text-emerald-400" />
                <span>{t.devices}</span>
              </button>

              <button
                onClick={() => {
                  setDrawerOpen(false);
                  onOpenSettings('servers');
                }}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-[#202b36] transition text-left text-xs font-semibold text-white cursor-pointer"
              >
                <div className="flex items-center gap-3.5">
                  <Server className="h-4 w-4 text-blue-400" />
                  <span>Server Network</span>
                </div>
                <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
              </button>

              <button
                onClick={() => {
                  setDrawerOpen(false);
                  onOpenSettings('profile');
                }}
                className="w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-[#202b36] transition text-left text-xs font-semibold text-white cursor-pointer"
              >
                <SettingsIcon className="h-4 w-4 text-[#7f91a4]" />
                <span>{t.settings}</span>
              </button>

              <div className="pt-2 border-t border-[#242f3d] my-2" />

              <div className="flex items-center justify-between px-3 py-2 text-xs text-[#7f91a4]">
                <div className="flex items-center gap-2">
                  {theme === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
                  <span>{theme === 'dark' ? t.theme_dark : t.theme_light}</span>
                </div>
                <button
                  onClick={onToggleTheme}
                  className="px-2.5 py-1 rounded-lg bg-[#242f3d] hover:bg-[#2b5278] text-white text-[11px] font-medium transition cursor-pointer"
                >
                  Toggle
                </button>
              </div>

              <div className="flex items-center justify-between px-3 py-2 text-xs text-[#7f91a4]">
                <span>Language</span>
                <button
                  onClick={onToggleLang}
                  className="px-2.5 py-1 rounded-lg bg-[#242f3d] hover:bg-emerald-600 text-white text-[11px] font-bold transition cursor-pointer"
                >
                  {lang === 'en' ? 'FA (فارسی)' : 'EN (English)'}
                </button>
              </div>

              <button
                onClick={() => {
                  setDrawerOpen(false);
                  onLogout();
                }}
                className="w-full flex items-center gap-3.5 px-3 py-2.5 rounded-xl hover:bg-red-500/20 text-red-400 transition text-left text-xs font-semibold cursor-pointer mt-4"
              >
                <LogOut className="h-4 w-4" />
                <span>{t.logout}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Conversation Right-Click Context Menu (Phase 10.7) */}
      {contextMenu && (
        <div
          className="fixed inset-0 z-50 select-none"
          onClick={() => setContextMenu(null)}
          onContextMenu={(e) => {
            e.preventDefault();
            setContextMenu(null);
          }}
        >
          <div
            className="absolute bg-[#17212b] border border-[#2b5278] rounded-xl shadow-2xl py-1 w-48 text-xs text-white z-50 animate-scaleUp"
            style={{
              top: Math.min(contextMenu.y, window.innerHeight - 180),
              left: Math.min(contextMenu.x, window.innerWidth - 200),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => togglePin(contextMenu.convId)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-[#202b36] text-left cursor-pointer transition"
            >
              <Pin size={14} className={pinnedIds.includes(contextMenu.convId) ? 'text-[#24A1DE]' : 'text-[#7f91a4]'} />
              <span>{pinnedIds.includes(contextMenu.convId) ? 'Unpin from Top' : 'Pin to Top'}</span>
            </button>
            <button
              onClick={() => toggleMute(contextMenu.convId)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-[#202b36] text-left cursor-pointer transition"
            >
              <BellOff size={14} className={mutedIds.includes(contextMenu.convId) ? 'text-amber-400' : 'text-[#7f91a4]'} />
              <span>{mutedIds.includes(contextMenu.convId) ? 'Unmute' : 'Mute Notifications'}</span>
            </button>
            <button
              onClick={() => toggleArchive(contextMenu.convId)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-[#202b36] text-left cursor-pointer transition"
            >
              <Archive size={14} className={archivedIds.includes(contextMenu.convId) ? 'text-[#24A1DE]' : 'text-[#7f91a4]'} />
              <span>{lang === 'fa' ? (archivedIds.includes(contextMenu.convId) ? 'خروج از آرشیو' : 'انتقال به آرشیو') : (archivedIds.includes(contextMenu.convId) ? 'Unarchive Chat' : 'Archive Chat')}</span>
            </button>
            <div className="border-t border-[#242f3d] my-1" />
            <button
              onClick={() => {
                const convId = contextMenu.convId;
                setContextMenu(null);
                setAddToFolderModalConvId(convId);
              }}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 hover:bg-[#202b36] text-left cursor-pointer transition text-[#24A1DE]"
            >
              <Folder size={14} className="text-[#24A1DE]" />
              <span>{t.add_to_folder}</span>
            </button>
          </div>
        </div>
      )}

      {/* New Group or Channel Modal */}
      {showNewModal && (
        <NewGroupOrChannelModal
          currentUser={currentUser}
          onClose={() => setShowNewModal(false)}
          onConversationCreated={(conv) => {
            onConversationCreated(conv);
            onSelectConversation(conv);
          }}
          lang={lang}
        />
      )}

      {/* Open by ID or Handle Modal */}
      {showOpenByIdModal && (
        <OpenByIdModal
          currentUser={currentUser}
          conversations={conversations}
          onClose={() => setShowOpenByIdModal(false)}
          onSelectConversation={onSelectConversation}
          onConversationCreated={onConversationCreated}
          lang={lang}
        />
      )}

      {/* Telegram-style User Profile Modal */}
      {inspectedProfileUser && (
        <UserProfileModal
          user={inspectedProfileUser}
          currentUser={currentUser}
          onClose={() => setInspectedProfileUser(null)}
          onStartCall={async (type: 'audio' | 'video') => {
            const target = inspectedProfileUser;
            setInspectedProfileUser(null);
            if (!target) return;
            try {
              const conv = await api.createDirectConversation(target.id);
              onSelectConversation(conv);
              webrtcManager.startCall(
                conv.id,
                target.id,
                target.display_name || target.username,
                type,
                target.avatar_url,
                currentUser.avatar_url,
                currentUser.display_name || currentUser.username
              );
            } catch (err) {
              console.error('Failed to start call from profile:', err);
            }
          }}
          onOpenDirectChat={async (targetUser: User) => {
            setInspectedProfileUser(null);
            handleStartDirectChat(targetUser);
          }}
          onUpdateCurrentUser={(updated: User) => {
            if (inspectedProfileUser.id === updated.id) {
              setInspectedProfileUser((prev) => (prev ? { ...prev, ...updated } : null));
            }
          }}
          lang={lang}
        />
      )}

      {/* Add To Folder Quick Modal */}
      {addToFolderModalConvId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn"
          onClick={() => setAddToFolderModalConvId(null)}
        >
          <div
            className="bg-[#17212b] border border-[#242f3d] rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl animate-scaleUp p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-[#242f3d]">
              <div className="flex items-center gap-2">
                <Folder className="h-5 w-5 text-[#24A1DE]" />
                <h3 className="font-bold text-sm">{t.add_to_folder}</h3>
              </div>
              <button
                type="button"
                onClick={() => setAddToFolderModalConvId(null)}
                className="text-[#7f91a4] hover:text-white transition cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="py-4 space-y-2 max-h-60 overflow-y-auto">
              {customFolders.length === 0 ? (
                <div className="text-center py-6 text-xs text-[#7f91a4]">
                  <p>هنوز پوشه‌ای ایجاد نکرده‌اید.</p>
                  <p className="text-[11px] mt-1">با ایجاد پوشه گفتگوهای خود را دسته‌بندی کنید.</p>
                </div>
              ) : (
                customFolders.map((f) => {
                  const isIn = f.includedChatIds.includes(addToFolderModalConvId);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => toggleConvInFolder(f.id, addToFolderModalConvId)}
                      className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition text-left cursor-pointer ${
                        isIn
                          ? 'bg-[#2b5278]/40 border-[#24A1DE] text-white'
                          : 'bg-[#242f3d]/50 border-transparent hover:bg-[#202b36] text-[#7f91a4] hover:text-white'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Folder className={`h-4 w-4 ${isIn ? 'text-[#24A1DE]' : 'text-[#7f91a4]'}`} />
                        <span className="text-xs font-semibold">{f.name}</span>
                        <span className="text-[10px] text-[#7f91a4]">({f.includedChatIds.length})</span>
                      </div>
                      <div
                        className={`h-4 w-4 rounded flex items-center justify-center border transition ${
                          isIn ? 'bg-[#24A1DE] border-[#24A1DE] text-white' : 'border-[#7f91a4]'
                        }`}
                      >
                        {isIn && <Check className="h-3 w-3 stroke-[3]" />}
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            <div className="pt-3 border-t border-[#242f3d] flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  const targetId = addToFolderModalConvId;
                  setAddToFolderModalConvId(null);
                  openCreateFolder();
                  if (targetId) setFolderSelectedConvIds([targetId]);
                }}
                className="flex items-center gap-1.5 text-xs font-semibold text-[#24A1DE] hover:underline cursor-pointer"
              >
                <FolderPlus className="h-4 w-4" />
                <span>{t.new_folder}</span>
              </button>
              <button
                type="button"
                onClick={() => setAddToFolderModalConvId(null)}
                className="px-4 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-xs font-semibold text-white transition cursor-pointer"
              >
                بستن
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Create / Edit Folder Modal */}
      {folderModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fadeIn"
          onClick={() => setFolderModalOpen(false)}
        >
          <div
            className="bg-[#17212b] border border-[#242f3d] rounded-2xl w-full max-w-md overflow-hidden shadow-2xl animate-scaleUp p-5 text-white flex flex-col max-h-[85vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b border-[#242f3d] flex-shrink-0">
              <div className="flex items-center gap-2">
                <Folder className="h-5 w-5 text-[#24A1DE]" />
                <h3 className="font-bold text-sm">
                  {editingFolderId ? t.edit_folder : t.new_folder}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setFolderModalOpen(false)}
                className="text-[#7f91a4] hover:text-white transition cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="py-4 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-[11px] font-semibold text-[#7f91a4] mb-1.5">
                  {t.folder_name}
                </label>
                <input
                  type="text"
                  value={folderNameInput}
                  onChange={(e) => setFolderNameInput(e.target.value)}
                  placeholder="مثلاً: کاری، خانواده، VIP"
                  autoFocus
                  className="w-full bg-[#242f3d] border border-[#242f3d] rounded-xl px-3 py-2 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-[#7f91a4] mb-1.5">
                  {t.include_chats} ({folderSelectedConvIds.length})
                </label>
                <div className="space-y-1 max-h-56 overflow-y-auto border border-[#242f3d] rounded-xl p-1 bg-[#101921]/50">
                  {conversations
                    .filter((c) => !c.id.includes('masterbot'))
                    .map((c) => {
                      const isSelected = folderSelectedConvIds.includes(c.id);
                      const title = getConversationTitle(c);
                      return (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => {
                            setFolderSelectedConvIds((prev) =>
                              prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id]
                            );
                          }}
                          className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition cursor-pointer ${
                            isSelected ? 'bg-[#2b5278]/40 text-white' : 'hover:bg-[#202b36] text-[#7f91a4] hover:text-white'
                          }`}
                        >
                          <span className="text-xs font-medium truncate">{title}</span>
                          <div
                            className={`h-4 w-4 rounded flex items-center justify-center border transition ${
                              isSelected ? 'bg-[#24A1DE] border-[#24A1DE] text-white' : 'border-[#7f91a4]'
                            }`}
                          >
                            {isSelected && <Check className="h-3 w-3 stroke-[3]" />}
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            </div>

            <div className="pt-3 border-t border-[#242f3d] flex items-center justify-between flex-shrink-0">
              {editingFolderId ? (
                <button
                  type="button"
                  onClick={() => handleDeleteFolder(editingFolderId)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-400 text-xs font-semibold transition cursor-pointer"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>{t.delete_folder}</span>
                </button>
              ) : (
                <div />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setFolderModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-xs font-semibold text-[#7f91a4] hover:text-white transition cursor-pointer"
                >
                  {t.cancel}
                </button>
                <button
                  type="button"
                  disabled={!folderNameInput.trim()}
                  onClick={handleSaveCurrentFolder}
                  className="px-4 py-1.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] disabled:opacity-40 text-xs font-bold text-white transition cursor-pointer shadow-md"
                >
                  {t.save_folder}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
