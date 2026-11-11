import { uiText, useUILanguage } from "../../app/language";
import React, { useEffect, useState } from 'react';
import { X, CheckCheck, Eye, ShieldAlert, User as UserIcon } from 'lucide-react';
import { Message, MessageReader } from '../../app/types';
import { api } from '../../protocol/api';
import { Language } from '../../app/i18n';

interface ReadByModalProps {
  conversationId: string;
  message: Message;
  lang?: Language;
  onClose: () => void;
  onOpenProfile?: (userId: string) => void;
}

export const ReadByModal: React.FC<ReadByModalProps> = ({
  conversationId,
  message,
  lang = 'en',
  onClose,
  onOpenProfile,
}) => {
  const uiLang = useUILanguage(lang);
  const [readers, setReaders] = useState<MessageReader[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isRTL = lang === 'fa';

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    setError(null);

    api.getMessageReaders(conversationId, message.id)
      .then((data) => {
        if (isMounted) {
          setReaders(data || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (isMounted) {
          const msg = err?.message || 'Failed to fetch readers';
          if (msg.includes('403') || msg.includes('FORBIDDEN') || msg.includes('administrators')) {
            setError(isRTL ? 'فقط مدیران یا نویسنده پیام می‌توانند وضعیت خوانده شدن را مشاهده کنند' : 'Only administrators or the message author can inspect read receipts');
          } else {
            setError(msg);
          }
          setLoading(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [conversationId, message.id, isRTL]);

  const formatReadTime = (dateStr: string) => {
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString(uiLang === 'fa' ? 'fa-IR' : 'en-US', { hour: '2-digit', minute: '2-digit' }) + ' • ' + d.toLocaleDateString(uiLang === 'fa' ? 'fa-IR' : 'en-US', { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="read-by-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        dir={isRTL ? 'rtl' : 'ltr'}
        className="w-full max-w-md bg-[#17212b] border border-[#242f3d] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] text-[#f5f5f5]"
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#242f3d]/60 bg-[#1e2c3a]/50">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-[#24A1DE]/20 text-[#24A1DE]">
              <Eye className="w-5 h-5" />
            </div>
            <div>
              <h3 id="read-by-title" className="font-semibold text-base">
                {isRTL ? uiText("خوانده شده توسط", uiLang) : uiText("Read by", uiLang)}
              </h3>
              {!loading && !error && (
                <span className="text-xs text-[#7f91a4]">
                  {readers.length} {isRTL ? 'نفر' : readers.length === 1 ? 'person' : 'people'}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#7f91a4] hover:text-white hover:bg-white/10 transition cursor-pointer"
            aria-label={uiText("Close", uiLang)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Message Preview Snippet */}
        <div className="px-5 py-3 bg-[#0e1621]/40 border-b border-[#242f3d]/40 text-xs text-[#7f91a4] truncate">
          <span className="text-[#24A1DE] font-medium mr-1.5">{isRTL ? 'پیام:' : 'Message:'}</span>
          <span className="text-white/80">{message.plaintext || message.ciphertext || uiText("(Media)", uiLang)}</span>
        </div>

        {/* Reader List Body */}
        <div className="flex-1 overflow-y-auto divide-y divide-[#242f3d]/30 min-h-[160px] p-2">
          {loading ? (
            <div className="flex flex-col gap-3 p-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex items-center gap-3 animate-pulse">
                  <div className="w-10 h-10 rounded-full bg-white/10" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 bg-white/10 rounded w-28" />
                    <div className="h-2.5 bg-white/5 rounded w-16" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center p-8 text-center text-[#7f91a4] gap-2">
              <ShieldAlert className="w-10 h-10 text-amber-400 mb-1" />
              <p className="text-sm font-medium text-white/90">{uiText(error, uiLang)}</p>
            </div>
          ) : readers.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center text-[#7f91a4] gap-2">
              <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mb-1">
                <CheckCheck className="w-6 h-6 text-[#7f91a4]/60" />
              </div>
              <p className="text-sm font-medium text-white/90">
                {isRTL ? 'هنوز کسی این پیام را نخوانده است' : 'No one has read this message yet'}
              </p>
              <span className="text-xs text-[#7f91a4]">
                {isRTL
                  ? 'به محض اینکه اعضای مجاز پیام را مشاهده کنند، در اینجا نمایش داده می‌شوند.'
                  : 'As soon as eligible participants view this message, their read status will appear here.'}
              </span>
            </div>
          ) : (
            readers.map((r) => (
              <div
                key={r.user_id || r.id}
                onClick={() => onOpenProfile && onOpenProfile(r.user_id || r.id || '')}
                className="flex items-center justify-between p-2.5 rounded-xl hover:bg-white/5 transition cursor-pointer group"
              >
                <div className="flex items-center gap-3">
                  {r.avatar_url ? (
                    <img
                      src={api.avatarURL(r.avatar_url)}
                      alt={r.display_name}
                      className="w-10 h-10 rounded-full object-cover border border-white/10"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#0088cc] flex items-center justify-center text-white font-semibold text-sm">
                      {r.display_name?.charAt(0)?.toUpperCase() || <UserIcon className="w-5 h-5 text-white/80" />}
                    </div>
                  )}
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-white group-hover:text-[#24A1DE] transition">
                      {r.display_name || r.username}
                    </span>
                    <span className="text-xs text-[#7f91a4]">@{r.username}</span>
                  </div>
                </div>

                <div className="flex items-center gap-1.5 text-xs text-[#7f91a4]">
                  <CheckCheck className="w-3.5 h-3.5 text-[#24A1DE]" />
                  <span>{formatReadTime(r.read_at)}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-3 bg-[#1e2c3a]/40 border-t border-[#242f3d]/60 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl bg-white/10 hover:bg-white/15 text-sm font-medium transition cursor-pointer"
          >
            {isRTL ? uiText("بستن", uiLang) : uiText("Close", uiLang)}
          </button>
        </div>
      </div>
    </div>
  );
};
