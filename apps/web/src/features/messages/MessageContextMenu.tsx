import React, { useEffect, useRef } from 'react';
import {
  CornerUpLeft,
  Share2,
  Copy,
  Link as LinkIcon,
  Pencil,
  Pin,
  CheckSquare,
  Bookmark,
  Download,
  Maximize2,
  User as UserIcon,
  Info,
  CheckCheck,
  Trash2,
  Film
} from 'lucide-react';
import { Message, User } from '../../app/types';

export interface ContextMenuPosition {
  x: number;
  y: number;
  message: Message;
}

interface MessageContextMenuProps {
  position: ContextMenuPosition;
  currentUser: User;
  isOwnerOrAdmin: boolean;
  onClose: () => void;
  onReply: (msg: Message) => void;
  onForward: (msg: Message) => void;
  onCopyText: (msg: Message) => void;
  onCopyLink: (msg: Message) => void;
  onEdit: (msg: Message) => void;
  onTogglePin: (msg: Message) => void;
  onSelect: (msg: Message) => void;
  onSaveToSaved: (msg: Message) => void;
  onDownload: (attMeta: any) => void;
  onOpenMedia: (msg: Message) => void;
  onOpenProfile: (userId: string) => void;
  onShowInfo: (msg: Message) => void;
  onViewReadBy?: (msg: Message) => void;
  onDeleteForMe: (msg: Message) => void;
  onDeleteForEveryone: (msg: Message) => void;
  onReact: (msgId: string, emoji: string) => void;
  onStartWatchParty?: (msg: Message) => void;
  onShareMedia?: (msg: Message) => void;
}

export const MessageContextMenu: React.FC<MessageContextMenuProps> = ({
  position,
  currentUser,
  isOwnerOrAdmin,
  onClose,
  onReply,
  onForward,
  onCopyText,
  onCopyLink,
  onEdit,
  onTogglePin,
  onSelect,
  onSaveToSaved,
  onDownload,
  onOpenMedia,
  onOpenProfile,
  onShowInfo,
  onViewReadBy,
  onDeleteForMe,
  onDeleteForEveryone,
  onReact,
  onStartWatchParty,
  onShareMedia,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const msg = position.message;
  const isOutgoing = msg.sender_id === currentUser.id;
  const canEdit = isOutgoing && !msg.is_deleted && !msg.poll_id && !msg.ciphertext?.includes('call_event');
  const canDeleteForEveryone = (isOutgoing || isOwnerOrAdmin) && !msg.is_deleted;
  const hasAttachment = Boolean(msg.attachmentMeta);
  const isMedia = Boolean(
    msg.attachmentMeta?.isPhoto ||
    msg.attachmentMeta?.isVideo ||
    msg.attachmentMeta?.isRoundVideo
  );

  // Close on outside click or escape
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleScroll = () => {
      onClose();
    };

    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [onClose]);

  // Adjust coordinates to ensure menu never overflows viewport
  const menuWidth = 220;
  const menuHeight = 440;
  const adjustedX = Math.max(10, Math.min(position.x, window.innerWidth - menuWidth - 15));
  const adjustedY = Math.max(10, Math.min(position.y, window.innerHeight - menuHeight - 15));

  const emojis = ['👍', '❤️', '🔥', '👏', '🎉', '🚀', '😂', '😮'];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 w-[220px] bg-[#17212b] border border-[#242f3d] rounded-2xl shadow-2xl overflow-hidden py-1.5 text-xs text-slate-200 animate-fadeIn select-none backdrop-blur-md"
      style={{ top: `${adjustedY}px`, left: `${adjustedX}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Quick Emoji Reaction Strip */}
      <div className="flex items-center justify-around px-2 py-1.5 border-b border-white/5 mb-1">
        {emojis.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => {
              onReact(msg.id, emoji);
              onClose();
            }}
            className="text-base hover:scale-130 transition-transform duration-100 cursor-pointer p-0.5"
            title={`React ${emoji}`}
          >
            {emoji}
          </button>
        ))}
      </div>

      <div className="flex flex-col py-0.5">
        {/* Reply */}
        <button
          type="button"
          onClick={() => {
            onReply(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <CornerUpLeft size={14} className="text-[#24A1DE]" />
          <span>Reply</span>
        </button>

        {/* Forward */}
        <button
          type="button"
          onClick={() => {
            onForward(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <Share2 size={14} className="text-[#24A1DE]" />
          <span>Forward</span>
        </button>

        {/* Copy Text */}
        <button
          type="button"
          onClick={() => {
            onCopyText(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <Copy size={14} className="text-[#7f91a4]" />
          <span>Copy Text</span>
        </button>

        {/* Copy Message Link */}
        <button
          type="button"
          onClick={() => {
            onCopyLink(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <LinkIcon size={14} className="text-[#7f91a4]" />
          <span>Copy Link</span>
        </button>

        {/* Edit Message (if permitted) */}
        {canEdit && (
          <button
            type="button"
            onClick={() => {
              onEdit(msg);
              onClose();
            }}
            className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
          >
            <Pencil size={14} className="text-[#24A1DE]" />
            <span>Edit</span>
          </button>
        )}

        {/* Pin / Unpin */}
        <button
          type="button"
          onClick={() => {
            onTogglePin(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <Pin size={14} className={msg.is_pinned ? 'text-amber-400' : 'text-[#7f91a4]'} />
          <span>{msg.is_pinned ? 'Unpin' : 'Pin to Top'}</span>
        </button>

        {/* Save to Saved Messages */}
        <button
          type="button"
          onClick={() => {
            onSaveToSaved(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <Bookmark size={14} className="text-[#24A1DE]" />
          <span>Save to Saved Messages</span>
        </button>

        {/* Select Multiple Messages */}
        <button
          type="button"
          onClick={() => {
            onSelect(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <CheckSquare size={14} className="text-[#7f91a4]" />
          <span>Select Messages</span>
        </button>

        {/* Attachment specific actions */}
        {hasAttachment && (
          <>
            <div className="h-px bg-white/10 my-1" />
            <button
              type="button"
              onClick={() => {
                onDownload(msg.attachmentMeta);
                onClose();
              }}
              className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
            >
              <Download size={14} className="text-emerald-400" />
              <span>Download Attachment</span>
            </button>
          </>
        )}

        {/* Open Media Fullscreen */}
        {isMedia && (
          <button
            type="button"
            onClick={() => {
              onOpenMedia(msg);
              onClose();
            }}
            className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
          >
            <Maximize2 size={14} className="text-[#24A1DE]" />
            <span>Open Fullscreen</span>
          </button>
        )}

        {/* Video Watch Party & Direct Stream Link */}
        {msg.attachmentMeta?.isVideo && onStartWatchParty && (
          <button
            type="button"
            onClick={() => {
              onStartWatchParty(msg);
              onClose();
            }}
            className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left text-emerald-400 cursor-pointer"
          >
            <Film size={14} />
            <span>سینما پارتی (تماشای همزمان)</span>
          </button>
        )}

        {msg.attachmentMeta && onShareMedia && (
          <button
            type="button"
            onClick={() => {
              onShareMedia(msg);
              onClose();
            }}
            className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left text-indigo-400 cursor-pointer"
          >
            <Share2 size={14} />
            <span>لینک استریم مستقیم و وب پلیر</span>
          </button>
        )}

        <div className="h-px bg-white/10 my-1" />

        {/* Sender Profile */}
        <button
          type="button"
          onClick={() => {
            onOpenProfile(msg.sender_id);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <UserIcon size={14} className="text-[#7f91a4]" />
          <span>Sender Profile</span>
        </button>

        {/* Message Info */}
        <button
          type="button"
          onClick={() => {
            onShowInfo(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
        >
          <Info size={14} className="text-[#7f91a4]" />
          <span>Message Info</span>
        </button>

        {/* View Read By (Admins or Author) */}
        {(isOwnerOrAdmin || isOutgoing) && onViewReadBy && (
          <button
            type="button"
            onClick={() => {
              onViewReadBy(msg);
              onClose();
            }}
            className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-white/10 transition text-left cursor-pointer"
          >
            <CheckCheck size={14} className="text-[#24A1DE]" />
            <span>Read by{msg.read_count ? ` (${msg.read_count})` : ''}</span>
          </button>
        )}

        <div className="h-px bg-white/10 my-1" />

        {/* Delete For Me */}
        <button
          type="button"
          onClick={() => {
            onDeleteForMe(msg);
            onClose();
          }}
          className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-rose-500/20 text-rose-300 transition text-left cursor-pointer"
        >
          <Trash2 size={14} />
          <span>Delete for Me</span>
        </button>

        {/* Delete For Everyone */}
        {canDeleteForEveryone && (
          <button
            type="button"
            onClick={() => {
              onDeleteForEveryone(msg);
              onClose();
            }}
            className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-red-600/30 text-red-400 font-semibold transition text-left cursor-pointer"
          >
            <Trash2 size={14} />
            <span>Delete for Everyone</span>
          </button>
        )}
      </div>
    </div>
  );
};
