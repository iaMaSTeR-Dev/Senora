import { uiText, useUILanguage } from "../app/language";
import React, { useEffect } from 'react';
import { Conversation } from '../app/types';
import { X, MessageSquare, Bell } from 'lucide-react';

export interface InAppNotification {
  id: string;
  title: string;
  body: string;
  senderName: string;
  senderAvatarUrl?: string;
  conversation?: Conversation;
}

interface InAppNotificationBannerProps {
  notification: InAppNotification | null;
  onSelect: (conv: Conversation) => void;
  onDismiss: () => void;
}

export const InAppNotificationBanner: React.FC<InAppNotificationBannerProps> = ({
  notification,
  onSelect,
  onDismiss,
}) => {
  const uiLang = useUILanguage();
  useEffect(() => {
    if (!notification) return;
    const timer = setTimeout(() => {
      onDismiss();
    }, 4500);
    return () => clearTimeout(timer);
  }, [notification, onDismiss]);

  if (!notification) return null;

  return (
    <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-full max-w-md px-4 pointer-events-none animate-in slide-in-from-top-4 fade-in duration-200">
      <div
        onClick={() => {
          if (notification.conversation) {
            onSelect(notification.conversation);
            onDismiss();
          }
        }}
        className="pointer-events-auto bg-[#17212b]/95 hover:bg-[#1f2b38] border border-[#242f3d] shadow-2xl rounded-2xl p-3.5 flex items-center gap-3 cursor-pointer backdrop-blur-md text-white transition-all transform hover:scale-[1.01] active:scale-[0.99]"
      >
        {/* Avatar or Icon */}
        <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-[#24A1DE] to-indigo-500 flex items-center justify-center flex-shrink-0 text-white font-bold text-sm overflow-hidden shadow">
          {notification.senderAvatarUrl ? (
            <img
              src={notification.senderAvatarUrl}
              alt={notification.senderName}
              className="h-full w-full object-cover"
            />
          ) : (
            notification.senderName.charAt(0).toUpperCase() || <MessageSquare size={18} />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 pr-1">
          <div className="flex items-center gap-1.5">
            <Bell size={12} className="text-[#24A1DE] flex-shrink-0" />
            <h4 className="text-xs font-bold text-white truncate">
              {notification.title}
            </h4>
          </div>
          <p className="text-xs text-slate-300 truncate mt-0.5 font-normal">
            {notification.body}
          </p>
        </div>

        {/* Dismiss Button */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDismiss();
          }}
          className="p-1 rounded-lg text-[#7f91a4] hover:text-white hover:bg-white/10 transition cursor-pointer flex-shrink-0"
          title={uiText("Dismiss", uiLang)}
        >
          <X size={15} />
        </button>
      </div>
    </div>
  );
};
