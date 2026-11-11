import { uiText, useUILanguage } from "../../app/language";
import React, { useState } from 'react';
import { Conversation, User } from '../../app/types';
import { api } from '../../protocol/api';
import { Language } from '../../app/i18n';
import { X, Search, AtSign, Megaphone, Users, MessageSquarePlus, Loader2 } from 'lucide-react';

interface OpenByIdModalProps {
  currentUser: User;
  conversations: Conversation[];
  onClose: () => void;
  onSelectConversation: (conv: Conversation) => void;
  onConversationCreated: (conv: Conversation) => void;
  lang: Language;
}

export const OpenByIdModal: React.FC<OpenByIdModalProps> = ({
  currentUser,
  conversations,
  onClose,
  onSelectConversation,
  onConversationCreated,
  lang,
}) => {
  const uiLang = useUILanguage(lang);
  const [identifier, setIdentifier] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{
    type: 'user' | 'channel' | 'group';
    user?: User;
    conversation?: Conversation;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const isFa = lang === 'fa';

  const handleResolve = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const raw = identifier.trim();
    if (!raw || loading) return;

    setLoading(true);
    setError(null);
    setResolved(null);

    try {
      const clean = raw.replace(/^@/, '').trim();
      const res = await api.resolveIdentifier(clean);
      if (!res || (!res.user && !res.conversation)) {
        setError(isFa ? 'کاربر، کانال یا گروهی با این شناسه دقیق یافت نشد.' : 'No user, channel, or group found with this exact identifier.');
      } else {
        setResolved(res);
      }
    } catch (err: any) {
      setError(err?.message || (isFa ? 'خطا در بررسی شناسه' : 'Failed to resolve identifier'));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenResolved = async () => {
    if (!resolved || actionLoading) return;
    setActionLoading(true);
    setError(null);

    try {
      if (resolved.type === 'user' && resolved.user) {
        if (resolved.user.id === currentUser.id) {
          const savedConv = conversations.find((c) => c.type === 'saved');
          if (savedConv) {
            onSelectConversation(savedConv);
            onClose();
            return;
          }
        }
        // Direct conversation with user
        const existing = conversations.find(
          (c) => c.type === 'direct' && c.participants?.some((p) => p.id === resolved.user!.id)
        );
        if (existing) {
          onSelectConversation(existing);
          onClose();
          return;
        }
        const conv = await api.createDirectConversation(resolved.user.id);
        onConversationCreated(conv);
        onSelectConversation(conv);
        onClose();
      } else if ((resolved.type === 'channel' || resolved.type === 'group') && resolved.conversation) {
        // Channel or group: Join and open
        const convId = resolved.conversation.id;
        const existing = conversations.find((c) => c.id === convId);
        if (existing) {
          onSelectConversation(existing);
          onClose();
          return;
        }
        try {
          const joinedConv = await api.joinConversation(convId);
          onConversationCreated(joinedConv);
          onSelectConversation(joinedConv);
        } catch {
          // If already member or join returns error, fallback to getConversation
          const conv = await api.getConversation(convId);
          onConversationCreated(conv);
          onSelectConversation(conv);
        }
        onClose();
      }
    } catch (err: any) {
      setError(err?.message || (isFa ? 'خطا در باز کردن گفتگو' : 'Failed to open conversation'));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in select-none">
      <div className="w-full max-w-md rounded-2xl bg-[#17212b] border border-[#242f3d] shadow-2xl flex flex-col overflow-hidden text-white">
        {/* Header */}
        <div className="p-4 border-b border-[#242f3d] flex items-center justify-between bg-[#1f2b38]">
          <div className="flex items-center gap-2.5">
            <div className="h-8 w-8 rounded-full bg-[#24A1DE]/20 flex items-center justify-center text-[#24A1DE]">
              <AtSign className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">
                {isFa ? 'باز کردن با شناسه یا آیدی' : 'Open by ID or Handle'}
              </h2>
              <p className="text-[10px] text-[#7f91a4]">
                {isFa ? 'ورود مستقیم به چت، کانال یا گروه بدون نیاز به شماره' : 'Direct access to chat, channel, or group via exact ID'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#7f91a4] hover:text-white hover:bg-[#2b3a4a] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4">
          <form onSubmit={handleResolve} className="space-y-3">
            <label className="block text-xs font-medium text-[#7f91a4]">
              {isFa ? 'آیدی یا شناسه دقیق (یوزرنیم شخص، کانال یا گروه)' : 'Exact Handle or ID (@username, channel_handle, cnv_...)'}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <span className="absolute left-3.5 top-2.5 text-xs text-[#7f91a4]">@</span>
                <input
                  type="text"
                  value={identifier}
                  onChange={(e) => {
                    setIdentifier(e.target.value);
                    setError(null);
                    setResolved(null);
                  }}
                  autoFocus
                  placeholder={isFa ? 'مثال: alice یا news_channel' : 'e.g. alice or news_channel'}
                  className="w-full rounded-xl bg-[#242f3d] pl-8 pr-3.5 py-2.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
                />
              </div>
              <button
                type="submit"
                disabled={!identifier.trim() || loading}
                className="px-4 py-2.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition disabled:opacity-40 cursor-pointer flex items-center gap-1.5 shadow-md shadow-[#24A1DE]/25"
              >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                <span>{isFa ? 'بررسی' : 'Check'}</span>
              </button>
            </div>
          </form>

          {/* Error notice */}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-xs">
              {error}
            </div>
          )}

          {/* Resolved Entity Card */}
          {resolved && (
            <div className="p-3.5 rounded-xl bg-[#202b36] border border-[#242f3d] space-y-3 animate-fade-in">
              <div className="flex items-center gap-3">
                {resolved.type === 'user' && resolved.user && (
                  <>
                    <div className="h-11 w-11 rounded-full bg-gradient-to-tr from-[#3ca9e2] to-[#24A1DE] flex items-center justify-center font-bold text-white text-sm shadow-md overflow-hidden flex-shrink-0">
                      {resolved.user.avatar_url ? (
                        <img src={api.avatarURL(resolved.user.avatar_url)} alt={uiText("Avatar", uiLang)} className="h-full w-full object-cover" />
                      ) : (
                        resolved.user.display_name.charAt(0).toUpperCase()
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-bold text-white truncate">{resolved.user.display_name}</p>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-[#24A1DE]/20 text-[#24A1DE]">
                          {isFa ? 'کاربر' : 'User'}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#7f91a4]">@{resolved.user.username}</p>
                      {resolved.user.bio && (
                        <p className="text-[11px] text-slate-300 mt-1 line-clamp-2">{resolved.user.bio}</p>
                      )}
                    </div>
                  </>
                )}

                {resolved.type === 'channel' && resolved.conversation && (
                  <>
                    <div className="h-11 w-11 rounded-full bg-gradient-to-tr from-purple-500 to-indigo-500 flex items-center justify-center font-bold text-white shadow-md overflow-hidden flex-shrink-0">
                      <Megaphone className="h-5 w-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-bold text-white truncate">{resolved.conversation.title}</p>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-purple-500/20 text-purple-300">
                          {isFa ? uiText("کانال عمومی", uiLang) : 'Public Channel'}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#7f91a4]">
                        {resolved.conversation.username ? `@${resolved.conversation.username}` : resolved.conversation.id}
                      </p>
                      {resolved.conversation.description && (
                        <p className="text-[11px] text-slate-300 mt-1 line-clamp-2">{resolved.conversation.description}</p>
                      )}
                    </div>
                  </>
                )}

                {resolved.type === 'group' && resolved.conversation && (
                  <>
                    <div className="h-11 w-11 rounded-full bg-gradient-to-tr from-amber-500 to-orange-500 flex items-center justify-center font-bold text-white shadow-md overflow-hidden flex-shrink-0">
                      <Users className="h-5 w-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-bold text-white truncate">{resolved.conversation.title}</p>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-500/20 text-amber-300">
                          {isFa ? uiText("گروه", uiLang) : uiText("Group", uiLang)}
                        </span>
                      </div>
                      <p className="text-[11px] text-[#7f91a4]">
                        {resolved.conversation.username ? `@${resolved.conversation.username}` : resolved.conversation.id}
                      </p>
                      {resolved.conversation.description && (
                        <p className="text-[11px] text-slate-300 mt-1 line-clamp-2">{resolved.conversation.description}</p>
                      )}
                    </div>
                  </>
                )}
              </div>

              <button
                type="button"
                onClick={handleOpenResolved}
                disabled={actionLoading}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#24A1DE] to-[#3ca9e2] hover:brightness-110 text-xs font-bold text-white transition flex items-center justify-center gap-2 cursor-pointer shadow-md shadow-[#24A1DE]/25 disabled:opacity-50"
              >
                {actionLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <MessageSquarePlus className="h-4 w-4" />
                )}
                <span>
                  {resolved.type === 'user'
                    ? isFa ? 'شروع گفتگو (Direct Chat)' : 'Start Direct Chat'
                    : isFa ? 'باز کردن و عضویت (Open & Join)' : 'Open & Join'}
                </span>
              </button>
            </div>
          )}

          {/* Privacy Note */}
          <div className="p-3 rounded-xl bg-[#101720]/60 border border-white/5 text-[11px] text-[#7f91a4] leading-relaxed">
            <p>
              {isFa
                ? '🔒 جهت حفظ حریم خصوصی کاربران، جستجوی همگانی و حدس زدن نام‌ها غیرفعال است. تنها با داشتن شناسه دقیق (@username یا آیدی) می‌توانید گفتگوها و کانال‌ها را باز کنید.'
                : '🔒 For maximum privacy, public user/channel browsing is disabled. Direct access is exclusively available by inputting the exact @username or ID.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
