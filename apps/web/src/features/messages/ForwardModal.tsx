import React, { useState, useEffect } from 'react';
import { Conversation, Message, User } from '../../app/types';
import { api } from '../../protocol/api';
import { X, Search, EyeOff, Eye, Send, Users, Megaphone, Bookmark } from 'lucide-react';

interface ForwardModalProps {
  messages: Message[];
  currentUser: User;
  onClose: () => void;
  onForward: (targetConversationId: string, hideAttribution: boolean) => Promise<void>;
}

export const ForwardModal: React.FC<ForwardModalProps> = ({
  messages,
  currentUser,
  onClose,
  onForward,
}) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [hideAttribution, setHideAttribution] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const fetchConvs = async () => {
      try {
        setLoading(true);
        const res = await api.listConversations();
        setConversations(res.conversations || []);
      } catch (e) {
        console.warn('Failed to load conversations:', e);
      } finally {
        setLoading(false);
      }
    };
    fetchConvs();
  }, []);

  const filteredConvs = conversations.filter((c) => {
    const title =
      c.title ||
      c.participants?.find((p) => p.id !== currentUser.id)?.display_name ||
      c.participants?.find((p) => p.id !== currentUser.id)?.username ||
      'Chat';
    return title.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const handleConfirmForward = async () => {
    if (!selectedConvId || sending) return;
    setSending(true);
    try {
      await onForward(selectedConvId, hideAttribution);
      onClose();
    } catch (e: any) {
      alert(`Forwarding failed: ${e.message}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs p-2 sm:p-4 animate-fadeIn select-none">
      <div className="w-full max-w-md bg-[#17212b] border border-[#2b5278] rounded-2xl p-4 sm:p-5 shadow-2xl animate-scaleUp flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-[#242f3d]">
          <div>
            <h3 className="text-base font-bold text-white">Forward Message</h3>
            <p className="text-[11px] text-[#7f91a4]">
              Forwarding {messages.length} {messages.length === 1 ? 'message' : 'messages'}
            </p>
          </div>
          <button onClick={onClose} className="text-[#7f91a4] hover:text-white cursor-pointer">
            <X size={18} />
          </button>
        </div>

        {/* Message preview snippet */}
        <div className="my-3 p-2.5 rounded-xl bg-[#202b36] border border-[#242f3d] text-xs text-slate-300">
          <span className="text-[10px] font-bold text-[#24A1DE] uppercase tracking-wider block mb-0.5">
            Preview
          </span>
          <p className="line-clamp-2 text-slate-200 font-medium">
            {messages[0]?.plaintext || 'Attachment/Media message'}
          </p>
          {messages.length > 1 && (
            <span className="text-[10px] text-[#7f91a4] mt-1 block">
              + {messages.length - 1} more
            </span>
          )}
        </div>

        {/* Privacy toggle: Show vs Hide sender attribution */}
        <div className="mb-3 p-2.5 rounded-xl bg-[#0e1621] border border-[#242f3d] flex items-center justify-between">
          <div className="flex items-center gap-2">
            {hideAttribution ? (
              <EyeOff size={16} className="text-[#24A1DE]" />
            ) : (
              <Eye size={16} className="text-[#7f91a4]" />
            )}
            <div>
              <p className="text-xs font-semibold text-white">
                {hideAttribution ? 'Hide Sender Name' : 'Show Original Sender'}
              </p>
              <p className="text-[10px] text-[#7f91a4]">
                {hideAttribution
                  ? 'Forwards message anonymously without original attribution'
                  : 'Preserves original sender name and timestamp'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setHideAttribution(!hideAttribution)}
            className={`px-2.5 py-1 text-xs font-bold rounded-lg transition cursor-pointer ${
              hideAttribution
                ? 'bg-[#24A1DE] text-white'
                : 'bg-[#242f3d] text-[#7f91a4] hover:text-white'
            }`}
          >
            {hideAttribution ? 'Hidden' : 'Show'}
          </button>
        </div>

        {/* Search destination */}
        <div className="relative mb-2">
          <Search size={14} className="absolute left-3 top-2.5 text-[#7f91a4]" />
          <input
            type="text"
            placeholder="Search conversation..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 bg-[#242f3d] border border-[#101921] rounded-xl text-white text-xs placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
          />
        </div>

        {/* Destination List */}
        <div className="flex-1 overflow-y-auto space-y-1.5 my-2 pr-1 no-scrollbar">
          {loading ? (
            <div className="p-4 text-center text-xs text-[#7f91a4]">Loading chats...</div>
          ) : filteredConvs.length === 0 ? (
            <div className="p-4 text-center text-xs text-[#7f91a4]">No conversations found</div>
          ) : (
            filteredConvs.map((conv) => {
              const isSelected = selectedConvId === conv.id;
              const isSaved =
                conv.type === 'direct' &&
                conv.participants?.every((p) => p.id === currentUser.id);
              const title =
                conv.title ||
                conv.participants?.find((p) => p.id !== currentUser.id)?.display_name ||
                conv.participants?.find((p) => p.id !== currentUser.id)?.username ||
                (isSaved ? 'Saved Messages' : 'Chat');

              return (
                <button
                  key={conv.id}
                  type="button"
                  onClick={() => setSelectedConvId(conv.id)}
                  className={`w-full flex items-center justify-between p-2.5 rounded-xl border transition text-left cursor-pointer ${
                    isSelected
                      ? 'border-[#24A1DE] bg-[#24A1DE]/20 text-white'
                      : 'border-transparent bg-[#202b36] hover:bg-[#253240] text-slate-200'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa] flex items-center justify-center font-bold text-white text-xs flex-shrink-0">
                      {isSaved ? (
                        <Bookmark size={14} />
                      ) : conv.type === 'channel' ? (
                        <Megaphone size={14} />
                      ) : conv.type === 'group' ? (
                        <Users size={14} />
                      ) : (
                        title.charAt(0).toUpperCase()
                      )}
                    </div>
                    <div className="truncate">
                      <p className="text-xs font-semibold truncate text-white">{title}</p>
                      <span className="text-[10px] text-[#7f91a4] capitalize">
                        {conv.type}
                      </span>
                    </div>
                  </div>

                  <div
                    className={`h-4 w-4 rounded-full border flex items-center justify-center flex-shrink-0 ${
                      isSelected
                        ? 'border-[#24A1DE] bg-[#24A1DE] text-white'
                        : 'border-[#7f91a4]'
                    }`}
                  >
                    {isSelected && <div className="h-1.5 w-1.5 rounded-full bg-white" />}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer actions */}
        <div className="pt-3 border-t border-[#242f3d] flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-[#7f91a4] hover:text-white transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!selectedConvId || sending}
            onClick={handleConfirmForward}
            className="px-5 py-2 text-xs font-bold bg-[#24A1DE] hover:bg-[#1b8bc2] text-white rounded-xl transition disabled:opacity-50 flex items-center gap-1.5 cursor-pointer shadow-md"
          >
            <Send size={14} />
            <span>{sending ? 'Sending...' : 'Forward'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
