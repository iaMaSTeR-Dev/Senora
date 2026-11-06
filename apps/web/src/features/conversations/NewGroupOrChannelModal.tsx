import React, { useState, useEffect } from 'react';
import { Conversation, User } from '../../app/types';
import { api } from '../../protocol/api';
import { Language, translations } from '../../app/i18n';
import { X, Users, Megaphone, Search, Check, Shield } from 'lucide-react';

interface NewGroupOrChannelModalProps {
  currentUser: User;
  onClose: () => void;
  onConversationCreated: (conv: Conversation) => void;
  lang: Language;
}

export const NewGroupOrChannelModal: React.FC<NewGroupOrChannelModalProps> = ({
  currentUser,
  onClose,
  onConversationCreated,
  lang,
}) => {
  const [type, setType] = useState<'group' | 'channel'>('group');
  const [title, setTitle] = useState('');
  const [channelUsername, setChannelUsername] = useState('');
  const [description, setDescription] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [selectedMembers, setSelectedMembers] = useState<User[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const t = translations[lang];

  useEffect(() => {
    const clean = searchQuery.replace(/^@/, '').trim().toLowerCase();
    if (!clean || (clean.length < 3 && !clean.startsWith('usr_'))) {
      setSearchResults([]);
      return;
    }
    const timeout = setTimeout(async () => {
      try {
        const res = await api.searchUsers(clean);
        setSearchResults(
          (res.users || []).filter(
            (u) => u.id !== currentUser.id && (u.username.toLowerCase() === clean || u.id.toLowerCase() === clean)
          )
        );
      } catch (e) {
        console.error('Search error:', e);
      }
    }, 250);
    return () => clearTimeout(timeout);
  }, [searchQuery, currentUser.id]);

  const toggleSelectMember = (user: User) => {
    if (selectedMembers.some((m) => m.id === user.id)) {
      setSelectedMembers((prev) => prev.filter((m) => m.id !== user.id));
    } else {
      setSelectedMembers((prev) => [...prev, user]);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || creating) return;

    setCreating(true);
    setError(null);

    try {
      let conv: Conversation;
      if (type === 'group') {
        const memberIds = selectedMembers.map((m) => m.id);
        conv = await api.createGroupConversation(title.trim(), memberIds);
      } else {
        conv = await api.createChannelConversation(
          title.trim(),
          description.trim(),
          channelUsername.trim() ? channelUsername.trim() : undefined
        );
      }
      onConversationCreated(conv);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to create conversation');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in select-none">
      <div className="w-full max-w-md rounded-2xl bg-[#17212b] border border-[#242f3d] shadow-2xl flex flex-col overflow-hidden text-white max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-[#242f3d] flex items-center justify-between bg-[#1f2b38]">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-bold text-white">
              {type === 'group' ? t.new_group : t.new_channel}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#7f91a4] hover:text-white hover:bg-[#2b3a4a] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Type Toggle */}
        <div className="flex border-b border-[#242f3d] bg-[#17212b]">
          <button
            type="button"
            onClick={() => setType('group')}
            className={`flex-1 py-3 text-xs font-semibold flex items-center justify-center gap-2 border-b-2 transition cursor-pointer ${
              type === 'group'
                ? 'border-[#24A1DE] text-[#24A1DE] bg-[#242f3d]/30'
                : 'border-transparent text-[#7f91a4] hover:text-white hover:bg-[#202b36]'
            }`}
          >
            <Users className="h-4 w-4" />
            <span>{t.group_chat}</span>
          </button>
          <button
            type="button"
            onClick={() => setType('channel')}
            className={`flex-1 py-3 text-xs font-semibold flex items-center justify-center gap-2 border-b-2 transition cursor-pointer ${
              type === 'channel'
                ? 'border-[#24A1DE] text-[#24A1DE] bg-[#242f3d]/30'
                : 'border-transparent text-[#7f91a4] hover:text-white hover:bg-[#202b36]'
            }`}
          >
            <Megaphone className="h-4 w-4" />
            <span>{t.channel}</span>
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleCreate} className="p-5 flex-1 overflow-y-auto space-y-4">
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[#7f91a4] mb-1.5">
              {type === 'group' ? 'Group Name' : 'Channel Name'} *
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder={type === 'group' ? 'e.g. Engineering Core' : 'e.g. Announcements'}
              className="w-full rounded-xl bg-[#242f3d] px-3.5 py-2.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
            />
          </div>

          {type === 'channel' && (
            <div>
              <label className="block text-xs font-medium text-[#7f91a4] mb-1.5">
                Channel Username / آیدی عمومی کانال (اختیاری)
              </label>
              <div className="relative">
                <span className="absolute left-3.5 top-2.5 text-xs text-[#7f91a4]">@</span>
                <input
                  type="text"
                  value={channelUsername}
                  onChange={(e) => setChannelUsername(e.target.value.replace(/^@/, ''))}
                  placeholder="channel_handle"
                  className="w-full rounded-xl bg-[#242f3d] pl-8 pr-3.5 py-2.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
                />
              </div>
              <p className="text-[10px] text-[#7f91a4] mt-1">
                تنها با وارد کردن دقیق این آیدی، دیگران می‌توانند کانال شما را باز و عضو شوند.
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[#7f91a4] mb-1.5">Description (Optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder={type === 'group' ? t.group_desc : t.channel_desc}
              className="w-full rounded-xl bg-[#242f3d] px-3.5 py-2.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE] resize-none"
            />
          </div>

          {/* Members selector for group */}
          {type === 'group' && (
            <div className="space-y-3 pt-2 border-t border-[#242f3d]">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-[#7f91a4]">Add Members</label>
                <span className="text-[11px] text-[#24A1DE] font-semibold">
                  {selectedMembers.length} selected
                </span>
              </div>

              {/* Selected Pills */}
              {selectedMembers.length > 0 && (
                <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto p-1 bg-[#0e1621] rounded-xl border border-[#242f3d]">
                  {selectedMembers.map((m) => (
                    <span
                      key={m.id}
                      onClick={() => toggleSelectMember(m)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-[#24A1DE]/20 text-[#24A1DE] text-[11px] font-medium cursor-pointer hover:bg-red-500/20 hover:text-red-400 transition"
                      title="Click to remove"
                    >
                      <span>{m.display_name}</span>
                      <X className="h-3 w-3" />
                    </span>
                  ))}
                </div>
              )}

              {/* Search User Input */}
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-[#7f91a4]" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Enter exact username (e.g. @alice)..."
                  className="w-full rounded-xl bg-[#242f3d] py-2 pl-8 pr-3 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
                />
              </div>

              {/* Search Results list */}
              {searchResults.length > 0 && (
                <div className="space-y-1 max-h-36 overflow-y-auto">
                  {searchResults.map((user) => {
                    const isSelected = selectedMembers.some((m) => m.id === user.id);
                    return (
                      <button
                        type="button"
                        key={user.id}
                        onClick={() => toggleSelectMember(user)}
                        className={`w-full flex items-center justify-between p-2 rounded-xl transition text-left cursor-pointer ${
                          isSelected ? 'bg-[#2b5278] text-white' : 'hover:bg-[#202b36] text-[#7f91a4]'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <div className="h-7 w-7 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa] flex items-center justify-center font-bold text-white text-xs">
                            {user.display_name.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-white truncate">{user.display_name}</p>
                            <p className="text-[10px] text-[#7f91a4]">@{user.username}</p>
                          </div>
                        </div>
                        {isSelected && <Check className="h-4 w-4 text-emerald-400" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="pt-2">
            <button
              type="submit"
              disabled={!title.trim() || creating}
              className="w-full py-2.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition disabled:opacity-40 cursor-pointer shadow-lg shadow-[#24A1DE]/25 flex items-center justify-center gap-2"
            >
              <Shield className="h-4 w-4" />
              <span>{creating ? 'Creating...' : type === 'group' ? 'Create Group' : 'Create Channel'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
