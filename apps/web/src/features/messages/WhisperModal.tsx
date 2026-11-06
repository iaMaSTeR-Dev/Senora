import React, { useState } from 'react';
import { Lock, X, Send, User } from 'lucide-react';
import { User as UserType } from '../../app/types';

interface WhisperModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSend: (targetUsername: string, secretText: string) => void;
  participants?: UserType[];
  currentUserId: string;
  lang?: 'en' | 'fa';
}

export const WhisperModal: React.FC<WhisperModalProps> = ({
  isOpen,
  onClose,
  onSend,
  participants = [],
  currentUserId,
  lang = 'fa',
}) => {
  const [targetUsername, setTargetUsername] = useState('');
  const [secretText, setSecretText] = useState('');

  if (!isOpen) return null;

  const candidateUsers = participants.filter((p) => p.id !== currentUserId && p.username);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUsername.trim() || !secretText.trim()) return;
    onSend(targetUsername.trim().replace(/^@/, ''), secretText.trim());
    setTargetUsername('');
    setSecretText('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-md rounded-3xl bg-[#17212b] border border-[#242f3d] shadow-2xl p-6 text-white flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#242f3d]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-tr from-purple-600 to-indigo-600 flex items-center justify-center shadow-lg shadow-purple-500/20 text-white">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">
                {lang === 'fa' ? 'ارسال پیام نجوا (Whisper)' : 'Send Whisper Message'}
              </h3>
              <p className="text-[11px] text-[#7f91a4]">
                {lang === 'fa'
                  ? 'پیام مخفی که فقط مخاطب مشخص‌شده می‌تواند آن را باز کند'
                  : 'Secret message unlockable only by target recipient'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[#7f91a4] mb-1.5">
              {lang === 'fa' ? 'نام‌کاربری مخاطب:' : 'Recipient Username:'}
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-purple-400 font-bold text-sm">@</span>
              <input
                type="text"
                value={targetUsername}
                onChange={(e) => setTargetUsername(e.target.value.replace(/^@/, ''))}
                placeholder={lang === 'fa' ? 'username' : 'username'}
                required
                className="w-full bg-[#101921] border border-[#242f3d] focus:border-purple-500 rounded-2xl pl-8 pr-3 py-2 text-sm text-white placeholder-slate-500 outline-none transition"
              />
            </div>
          </div>

          {/* Quick Member Selection Pills */}
          {candidateUsers.length > 0 && (
            <div>
              <span className="block text-[11px] text-[#7f91a4] mb-1.5">
                {lang === 'fa' ? 'انتخاب سریع از اعضای چت:' : 'Quick Select from Members:'}
              </span>
              <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                {candidateUsers.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => setTargetUsername(u.username)}
                    className={`px-2.5 py-1 rounded-xl text-xs transition cursor-pointer flex items-center gap-1 border ${
                      targetUsername.toLowerCase() === u.username.toLowerCase()
                        ? 'bg-purple-600/30 border-purple-500 text-purple-200'
                        : 'bg-[#242f3d] border-transparent hover:border-[#38495c] text-slate-300'
                    }`}
                  >
                    <User className="h-3 w-3" />
                    <span>@{u.username}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-[#7f91a4] mb-1.5">
              {lang === 'fa' ? 'متن پیام مخفی:' : 'Secret Message Text:'}
            </label>
            <textarea
              value={secretText}
              onChange={(e) => setSecretText(e.target.value)}
              placeholder={lang === 'fa' ? 'پیام مخفی خود را اینجا بنویسید...' : 'Type your secret whisper message here...'}
              rows={3}
              required
              className="w-full bg-[#101921] border border-[#242f3d] focus:border-purple-500 rounded-2xl p-3 text-sm text-white placeholder-slate-500 outline-none resize-none transition"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2 border-t border-[#242f3d]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl text-xs text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
            >
              {lang === 'fa' ? 'انصراف' : 'Cancel'}
            </button>
            <button
              type="submit"
              disabled={!targetUsername.trim() || !secretText.trim()}
              className="px-5 py-2 rounded-xl text-xs font-bold bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50 text-white transition flex items-center gap-2 cursor-pointer shadow-lg shadow-purple-600/30"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{lang === 'fa' ? 'ارسال نجوا' : 'Send Whisper'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
