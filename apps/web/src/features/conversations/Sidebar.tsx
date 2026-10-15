import React, { useState, useEffect } from 'react';
import { Conversation, User } from '../../app/types';
import { api } from '../../protocol/api';
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
  Archive
} from 'lucide-react';
import { NewGroupOrChannelModal } from './NewGroupOrChannelModal';
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
  const avatarSrc = isSaved ? null : (c.avatar_url || peer?.avatar_url);
  const peerPresence = useUserPresence(peer?.id, lang);
  const isOnline = Boolean(peer && peerPresence.isOnline);

  return (
    <button
      onClick={onSelect}
      onContextMenu={onContextMenu}
      className={`w-full flex items-center gap-3 p-2.5 rounded-xl transition text-left cursor-pointer ${
        isActive ? 'bg-[#2b5278] text-white' : 'hover:bg-[#202b36] text-white'
      }`}
    >
      <div className="relative flex-shrink-0">
        <div
          className={`h-11 w-11 rounded-full flex items-center justify-center font-bold text-white shadow-sm overflow-hidden ${
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

export type CategoryTab = 'all' | 'direct' | 'groups' | 'channels' | 'saved' | 'archived';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    channels: Array<{ id: string; type: string; title: string; description: string; avatar_url: string }>;
    users: User[];
    conversations: Conversation[];
  }>({ channels: [], users: [], conversations: [] });
  const [searching, setSearching] = useState(false);
  const [inspectedProfileUser, setInspectedProfileUser] = useState<User | null>(null);

  // Pin, Mute, Archive state (Phase 10.7)
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('nexachat_pinned_convs') || '[]');
    } catch {
      return [];
    }
  });
  const [mutedIds, setMutedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('nexachat_muted_convs') || '[]');
    } catch {
      return [];
    }
  });
  const [archivedIds, setArchivedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('nexachat_archived_convs') || '[]');
    } catch {
      return [];
    }
  });
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; convId: string } | null>(null);

  const togglePin = (convId: string) => {
    setPinnedIds((prev) => {
      const next = prev.includes(convId) ? prev.filter((id) => id !== convId) : [...prev, convId];
      localStorage.setItem('nexachat_pinned_convs', JSON.stringify(next));
      return next;
    });
    setContextMenu(null);
  };

  const toggleMute = (convId: string) => {
    setMutedIds((prev) => {
      const next = prev.includes(convId) ? prev.filter((id) => id !== convId) : [...prev, convId];
      localStorage.setItem('nexachat_muted_convs', JSON.stringify(next));
      return next;
    });
    setContextMenu(null);
  };

  const toggleArchive = (convId: string) => {
    setArchivedIds((prev) => {
      const next = prev.includes(convId) ? prev.filter((id) => id !== convId) : [...prev, convId];
      localStorage.setItem('nexachat_archived_convs', JSON.stringify(next));
      return next;
    });
    setContextMenu(null);
  };

  const t = translations[lang];

  // Debounced global search across public channels, users, and conversations
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults({ channels: [], users: [], conversations: [] });
      setSearching(false);
      return;
    }

    setSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const res = await api.globalSearch(searchQuery.trim());
        setSearchResults({
          channels: res.channels || [],
          users: res.users || [],
          conversations: res.conversations || [],
        });
      } catch (e) {
        console.error('Failed to execute global search:', e);
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => clearTimeout(timeout);
  }, [searchQuery]);

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
      if (c.last_message.plaintext) return c.last_message.plaintext;
      return 'Encrypted message';
    }
    if (c.type === 'channel') return c.description || t.channel_desc;
    return t.start_chat;
  };

  // Filter conversations according to category tab and archive status (Phase 10.7)
  const filteredConversations = conversations.filter((c) => {
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
      <aside className="w-full md:w-80 lg:w-96 flex-shrink-0 flex flex-col h-full bg-[#17212b] border-r border-[#101921] select-none text-white relative">
        {/* Top Header with Hamburger Menu and Search */}
        <div className="p-3.5 flex items-center justify-between border-b border-[#101921] bg-[#17212b]">
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
              Archived ({archivedIds.length})
            </button>
          </div>
        )}

        {/* Main List */}
        <div className="flex-1 overflow-y-auto px-2 py-1 space-y-1">
          {/* Global Search Results */}
          {searchQuery.trim() !== '' && (
            <div className="mb-3 space-y-3">
              {searching ? (
                <div className="p-4 text-center text-xs text-[#7f91a4]">Searching across Senora...</div>
              ) : searchResults.conversations.length === 0 && searchResults.channels.length === 0 && searchResults.users.length === 0 ? (
                <div className="p-4 text-center text-xs text-[#7f91a4]">No results found</div>
              ) : (
                <>
                  {/* Matching Active Chats */}
                  {searchResults.conversations.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[11px] font-semibold text-[#7f91a4] uppercase tracking-wider">
                        Chats
                      </div>
                      {searchResults.conversations.map((c) => (
                        <button
                          key={c.id}
                          onClick={() => {
                            onSelectConversation(c);
                            setSearchQuery('');
                          }}
                          className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[#202b36] transition text-left cursor-pointer"
                        >
                          <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center font-bold text-white shadow-sm overflow-hidden flex-shrink-0">
                            {c.title ? c.title.charAt(0).toUpperCase() : 'C'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white truncate">{c.title || 'Conversation'}</p>
                            <p className="text-xs text-[#7f91a4] truncate">{c.description || `${c.type} chat`}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Public Channels */}
                  {searchResults.channels.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[11px] font-semibold text-[#7f91a4] uppercase tracking-wider">
                        Public Channels
                      </div>
                      {searchResults.channels.map((ch) => (
                        <button
                          key={ch.id}
                          onClick={() => {
                            const existing = conversations.find((c) => c.id === ch.id);
                            if (existing) {
                              onSelectConversation(existing);
                            } else {
                              api.getConversation(ch.id).then((conv: Conversation) => {
                                onConversationCreated(conv);
                                onSelectConversation(conv);
                              });
                            }
                            setSearchQuery('');
                          }}
                          className="w-full flex items-center gap-3 p-2.5 rounded-xl hover:bg-[#202b36] transition text-left cursor-pointer"
                        >
                          <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center font-bold text-white shadow-sm overflow-hidden flex-shrink-0">
                            <Megaphone className="h-5 w-5 text-white" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-white truncate">{ch.title}</p>
                            <p className="text-xs text-[#7f91a4] truncate">{ch.description || 'Public channel'}</p>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Users */}
                  {searchResults.users.length > 0 && (
                    <div>
                      <div className="px-2 py-1 text-[11px] font-semibold text-[#7f91a4] uppercase tracking-wider">
                        {t.users_found}
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
                            <p className="text-sm font-medium text-white truncate">{user.display_name}</p>
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
                draft={localStorage.getItem('nexachat_draft_' + c.id)}
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
          <div className="relative w-72 md:w-80 h-full bg-[#17212b] border-r border-[#242f3d] flex flex-col z-10 shadow-2xl">
            {/* User Profile Header */}
            <div
              onClick={() => {
                setDrawerOpen(false);
                setInspectedProfileUser(currentUser);
              }}
              className="p-5 bg-[#1f2b38] border-b border-[#242f3d] cursor-pointer hover:bg-[#233140] transition"
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
              <span>{archivedIds.includes(contextMenu.convId) ? 'Unarchive Chat' : 'Archive Chat'}</span>
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
                type
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
    </>
  );
};
