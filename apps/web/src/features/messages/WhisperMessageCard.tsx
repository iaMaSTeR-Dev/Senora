import React, { useState } from 'react';
import { Lock, Unlock, Eye, EyeOff, ShieldAlert, Sparkles } from 'lucide-react';

interface WhisperMessageCardProps {
  whisper: {
    target_username: string;
    target_id?: string;
    secret_text: string;
    sender_username?: string;
    sender_id?: string;
  };
  currentUserId: string;
  currentUsername?: string;
  senderId?: string;
  senderUsername?: string;
  lang?: 'en' | 'fa';
}

export const WhisperMessageCard: React.FC<WhisperMessageCardProps> = ({
  whisper,
  currentUserId,
  currentUsername,
  senderId,
  senderUsername,
  lang = 'fa',
}) => {
  const [isRevealed, setIsRevealed] = useState(false);
  const [unauthAlert, setUnauthAlert] = useState(false);

  const cleanTarget = (whisper.target_username || '').replace(/^@/, '').toLowerCase();
  const cleanCurrent = (currentUsername || '').toLowerCase();
  const cleanSender = (senderUsername || whisper.sender_username || '').toLowerCase();

  const isRecipient = (cleanTarget && cleanCurrent === cleanTarget) || (whisper.target_id && currentUserId === whisper.target_id);
  const isSender = currentUserId === senderId || (whisper.sender_id && currentUserId === whisper.sender_id) || (cleanCurrent && cleanCurrent === cleanSender);
  const canView = isRecipient || isSender;

  const handleToggle = () => {
    if (!canView) {
      setUnauthAlert(true);
      setTimeout(() => setUnauthAlert(false), 4000);
      return;
    }
    setIsRevealed(!isRevealed);
  };

  return (
    <div className="my-1.5 w-full min-w-[240px] sm:min-w-[300px] rounded-2xl bg-gradient-to-tr from-purple-950/70 via-[#17212b] to-[#1e1b4b] border border-purple-500/30 p-3 shadow-lg select-none">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-purple-500/20">
        <div className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-lg bg-purple-500/20 text-purple-300 flex items-center justify-center">
            {isRevealed ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
          </div>
          <span className="text-xs font-bold text-purple-200">
            {lang === 'fa' ? '🤫 پیام نجوا (Whisper)' : '🤫 Whisper Message'}
          </span>
        </div>
        <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-400/30">
          @{cleanTarget}
        </span>
      </div>

      {/* Secret content or locked state */}
      {isRevealed && canView ? (
        <div className="p-2.5 rounded-xl bg-purple-900/30 border border-purple-400/30 text-white text-xs leading-relaxed my-2 animate-in fade-in duration-200 select-text">
          <div className="flex items-center gap-1.5 text-[10px] text-purple-300 mb-1 font-semibold">
            <Sparkles className="h-3 w-3" />
            <span>{lang === 'fa' ? 'متن پیام مخفی:' : 'Secret text:'}</span>
          </div>
          <p className="whitespace-pre-wrap break-words">{whisper.secret_text}</p>
        </div>
      ) : (
        <div className="py-2 px-1 text-[11px] text-[#9ca3af]">
          {lang === 'fa'
            ? `این پیام نجوا فقط توسط @${cleanTarget} و فرستنده قابل بازگشایی است.`
            : `This whisper message can only be opened by @${cleanTarget} and the sender.`}
        </div>
      )}

      {/* Action Button */}
      <div className="mt-1">
        <button
          type="button"
          onClick={handleToggle}
          className={`w-full py-1.5 px-3 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition cursor-pointer shadow-md ${
            isRevealed
              ? 'bg-purple-900/40 hover:bg-purple-900/60 text-purple-200 border border-purple-500/30'
              : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-purple-600/30'
          }`}
        >
          {isRevealed ? (
            <>
              <EyeOff className="h-3.5 w-3.5" />
              <span>{lang === 'fa' ? 'مخفی کردن پیام' : 'Hide Whisper'}</span>
            </>
          ) : (
            <>
              <Eye className="h-3.5 w-3.5" />
              <span>{lang === 'fa' ? 'مشاهده پیام نجوا' : 'View Whisper'}</span>
            </>
          )}
        </button>
      </div>

      {/* Unauthorized Warning Alert */}
      {unauthAlert && (
        <div className="mt-2 p-2 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-[11px] flex items-center gap-1.5 animate-in fade-in duration-150">
          <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
          <span>
            {lang === 'fa'
              ? `این پیام نجوا برای شما نیست! فقط @${cleanTarget} و فرستنده مجاز هستند.`
              : `You are not authorized! Only @${cleanTarget} and the sender can open it.`}
          </span>
        </div>
      )}
    </div>
  );
};
