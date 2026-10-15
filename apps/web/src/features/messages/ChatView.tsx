import React, { useState, useEffect, useRef } from 'react';
import { Conversation, Message, User, Sticker, StickerPack, GIFItem, ConversationMemberDetail } from '../../app/types';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';
import { signalManager } from '../../crypto/signalManager';
import { cryptoEngine } from '../../crypto/clientCrypto';
import { translations, Language } from '../../app/i18n';
import { webrtcManager, CallSession } from '../calls/webrtcManager';
import { mediaDeviceManager } from '../calls/mediaDeviceManager';
import { loadSettings, WALLPAPERS } from '../settings/settingsModel';
import { CallModal } from '../calls/CallModal';
import { GroupVoiceChatModal } from '../calls/GroupVoiceChatModal';
import { EmojiStickerPicker } from './EmojiStickerPicker';
import { MediaLightbox, LightboxMediaItem } from './MediaLightbox';
import { MediaPreviewModal } from './MediaPreviewModal';
import { RoundVideoRecorderModal } from './RoundVideoRecorderModal';
import { PollCard } from './PollCard';
import { CreatePollModal } from './CreatePollModal';
import { ForwardModal } from './ForwardModal';
import { SharedMediaDrawer } from './SharedMediaDrawer';
import { UserProfileModal } from '../profile/UserProfileModal';
import { useUserPresence } from '../presence/presenceManager';
import { ReadByModal } from './ReadByModal';
import { renderFormattedText, applyFormatting } from './messageFormatter';
import { FormattingToolbar } from './FormattingToolbar';
import { MessageContextMenu, ContextMenuPosition } from './MessageContextMenu';
import {
  Send,
  Lock,
  Check,
  CheckCheck,
  ArrowLeft,
  Shield,
  ShieldCheck,
  AlertTriangle,
  Smile,
  Paperclip,
  Mic,
  CornerUpLeft,
  Pencil,
  Trash2,
  Pin,
  Copy,
  Download,
  Search,
  X,
  Play,
  Pause,
  FileText,
  Megaphone,
  Users,
  Phone,
  PhoneOff,
  Video,
  UploadCloud,
  Film,
  Radio,
  Share2,
  BarChart2,
  Folder,
  Clock,
  BellOff,
  Info,
  CheckSquare,
  Square,
  MoreVertical,
  Bookmark,
  Volume2,
  VolumeX,
  Type,
  ChevronUp,
  ChevronDown,
  Maximize2,
  Eye,
  UserPlus
} from 'lucide-react';

interface CircularVideoNotePlayerProps {
  src: string;
  onDownload?: () => void;
}

const CircularVideoNotePlayer: React.FC<CircularVideoNotePlayerProps> = ({ src, onDownload }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [showControlsOverlay, setShowControlsOverlay] = useState(true);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    mediaDeviceManager.applyAudioOutput(video);

    const onTimeUpdate = () => {
      if (video.duration) {
        setProgress(video.currentTime / video.duration);
        setCurrentTime(video.currentTime);
      }
    };
    const onLoadedMetadata = () => {
      setDuration(video.duration || 0);
    };
    const onPlay = () => {
      setIsPlaying(true);
      setShowControlsOverlay(false);
    };
    const onPause = () => {
      setIsPlaying(false);
      setShowControlsOverlay(true);
    };
    const onEnded = () => {
      setIsPlaying(false);
      setProgress(0);
      setShowControlsOverlay(true);
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
    };
  }, [src]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(console.warn);
    } else {
      video.pause();
    }
  };

  const toggleMute = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;
    video.muted = !video.muted;
    setIsMuted(video.muted);
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const radius = 96;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - progress * circumference;

  return (
    <div
      onClick={togglePlay}
      onMouseEnter={() => setShowControlsOverlay(true)}
      onMouseLeave={() => {
        if (isPlaying) setShowControlsOverlay(false);
      }}
      className="relative w-48 h-48 sm:w-56 sm:h-56 rounded-full overflow-hidden shadow-2xl bg-black cursor-pointer group select-none flex items-center justify-center"
      style={{
        clipPath: 'circle(50% at 50% 50%)',
        WebkitClipPath: 'circle(50% at 50% 50%)',
        borderRadius: '9999px',
      }}
    >
      <video
        ref={videoRef}
        src={src}
        playsInline
        autoPlay
        loop={false}
        className="w-full h-full object-cover rounded-full"
        style={{
          clipPath: 'circle(50% at 50% 50%)',
          WebkitClipPath: 'circle(50% at 50% 50%)',
        }}
      />

      {/* Circular Animated SVG Progress Border */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none -rotate-90"
        viewBox="0 0 200 200"
      >
        <circle
          cx="100"
          cy="100"
          r={radius}
          className="text-white/20"
          strokeWidth="4"
          stroke="currentColor"
          fill="transparent"
        />
        <circle
          cx="100"
          cy="100"
          r={radius}
          className="text-[#24A1DE] transition-all duration-100 ease-linear"
          strokeWidth="4"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          stroke="currentColor"
          fill="transparent"
        />
      </svg>

      {/* Center Play/Pause Overlay */}
      {showControlsOverlay && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-[1px] transition-opacity">
          <div className="h-12 w-12 rounded-full bg-black/60 flex items-center justify-center text-white shadow-lg">
            {isPlaying ? (
              <Pause className="h-6 w-6 text-white" />
            ) : (
              <Play className="h-6 w-6 text-white fill-white ml-0.5" />
            )}
          </div>
        </div>
      )}

      {/* Bottom Duration Badge & Controls */}
      <div className="absolute bottom-2 left-0 right-0 flex items-center justify-between px-5 pointer-events-none">
        <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded-full bg-black/60 text-white backdrop-blur-sm">
          {formatTime(currentTime > 0 ? currentTime : duration)}
        </span>
        <div className="flex items-center gap-1 pointer-events-auto">
          {onDownload && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              className="p-1 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/80 transition"
              title="Download Video Note"
            >
              <Download className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={toggleMute}
            className="p-1 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/80 transition"
            title={isMuted ? 'Unmute' : 'Mute'}
          >
            {isMuted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          </button>
        </div>
      </div>
    </div>
  );
};

interface VoiceNotePlayerProps {
  id: string;
  src?: string;
  attMeta: any;
  isPlaying: boolean;
  playbackSpeed: number;
  onPlayToggle: () => void;
  onSpeedCycle: () => void;
  onDownload?: () => void;
}

const VoiceNotePlayer: React.FC<VoiceNotePlayerProps> = ({
  id,
  src,
  attMeta,
  isPlaying,
  playbackSpeed,
  onPlayToggle,
  onSpeedCycle,
  onDownload,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [waveformBars, setWaveformBars] = useState<number[]>(() => {
    const seed = (attMeta?.sizeBytes || 12345) + (id.charCodeAt(0) || 7);
    return Array.from({ length: 32 }, (_, i) => {
      const val = Math.abs(Math.sin((i + 1) * 0.45 + seed) * 0.7 + Math.cos(i * 0.25) * 0.3);
      return Math.max(0.18, Math.min(1, val));
    });
  });

  // Decode real audio waveform if blob URL is available
  useEffect(() => {
    if (!src) return;
    let isCancelled = false;

    const generateWaveform = async () => {
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioCtx) return;
        const res = await fetch(src);
        const arrayBuf = await res.arrayBuffer();
        const ctx = new AudioCtx();
        const audioBuffer = await ctx.decodeAudioData(arrayBuf);
        if (isCancelled) return;

        const rawData = audioBuffer.getChannelData(0);
        const samples = 32;
        const blockSize = Math.floor(rawData.length / samples);
        const bars: number[] = [];

        for (let i = 0; i < samples; i++) {
          const start = blockSize * i;
          let sum = 0;
          for (let j = 0; j < blockSize; j++) {
            sum += Math.abs(rawData[start + j]);
          }
          const avg = sum / blockSize;
          bars.push(Math.max(0.15, Math.min(1, avg * 3.5)));
        }
        setWaveformBars(bars);
        ctx.close();
      } catch (err) {
        // Fallback to deterministic pseudo-waveform if decoding fails
      }
    };

    generateWaveform();
    return () => {
      isCancelled = true;
    };
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = playbackSpeed;
  }, [playbackSpeed]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.play().catch(console.warn);
    } else {
      audio.pause();
    }
  }, [isPlaying]);

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration || 0);
    }
  };

  const handleEnded = () => {
    setCurrentTime(0);
    onPlayToggle();
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    const seekTime = percentage * duration;
    audioRef.current.currentTime = seekTime;
    setCurrentTime(seekTime);
  };

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressRatio = duration > 0 ? currentTime / duration : 0;
  const currentBarIndex = Math.floor(progressRatio * 32);

  return (
    <div className="flex items-center gap-3 p-2.5 rounded-2xl bg-black/20 w-64 sm:w-72 select-none">
      {src && (
        <audio
          ref={audioRef}
          src={src}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={handleEnded}
        />
      )}

      {/* Play / Pause Circular Button */}
      <button
        type="button"
        onClick={onPlayToggle}
        className="h-10 w-10 rounded-full bg-[#24A1DE] hover:bg-[#208fc4] text-white flex items-center justify-center shadow-md transition flex-shrink-0 cursor-pointer"
      >
        {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 fill-white ml-0.5" />}
      </button>

      {/* Waveform Visualization & Time Display */}
      <div className="flex-1 min-w-0">
        <div
          onClick={handleSeek}
          className="flex items-center gap-[2.5px] h-7 cursor-pointer py-1"
          title="Click to seek"
        >
          {waveformBars.map((height, i) => {
            const isPlayed = i <= currentBarIndex;
            return (
              <div
                key={i}
                className="flex-1 rounded-full transition-colors duration-75"
                style={{
                  height: `${Math.round(height * 22)}px`,
                  backgroundColor: isPlayed ? '#24A1DE' : 'rgba(127, 145, 164, 0.45)',
                  minHeight: '4px',
                }}
              />
            );
          })}
        </div>

        <div className="flex items-center justify-between text-[10px] text-[#7f91a4] mt-0.5 font-mono">
          <span>{formatTime(currentTime > 0 ? currentTime : duration)}</span>
          <span className="text-[9px]">E2EE Voice</span>
        </div>
      </div>

      {/* Speed Multiplier Button */}
      <button
        type="button"
        onClick={onSpeedCycle}
        className="px-1.5 py-0.5 rounded-lg bg-[#242f3d] hover:bg-[#202b36] text-[10px] font-bold text-[#24A1DE] border border-[#24A1DE]/30 transition cursor-pointer flex-shrink-0"
        title="Playback Speed"
      >
        {playbackSpeed}x
      </button>

      {/* Download Voice Button */}
      {onDownload && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDownload();
          }}
          className="p-1.5 rounded-lg bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-[#24A1DE] transition cursor-pointer flex-shrink-0"
          title="Download Voice Note"
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};

interface ChatViewProps {
  conversation: Conversation;
  currentUser: User;
  onBack?: () => void;
  onSelectConversation?: (conv: Conversation) => void;
  lang: Language;
}

interface ParsedMessagePayload {
  text?: string;
  type?: 'attachment' | 'voice' | 'sticker' | 'video_note' | 'poll' | 'call_event';
  poll_id?: string;
  poll_key?: string;
  poll_iv?: string;
  is_forwarded?: boolean;
  forward_from_name?: string;
  call_id?: string;
  call_type?: 'voice' | 'video';
  outcome?: string;
  duration_seconds?: number;
  started_at?: string;
  ended_at?: string;
  attachment?: {
    id?: string;
    filename?: string;
    contentType?: string;
    sizeBytes?: number;
    keyBase64?: string;
    ivBase64?: string;
    isVoice?: boolean;
    isRoundVideo?: boolean;
    isPhoto?: boolean;
    isVideo?: boolean;
    isSticker?: boolean;
    stickerPackId?: string;
    stickerId?: string;
    stickerUrl?: string;
    caption?: string;
    blurredPreviewBase64?: string;
  };
}

export const reconcileMessageList = (
  existingList: Message[],
  incoming: Message,
  replaceId?: string
): Message[] => {
  const result: Message[] = [];
  let merged = false;

  const targetId = incoming.id;
  const targetIdemp = incoming.idempotency_key;

  for (const item of existingList) {
    const isIdMatch = Boolean(targetId && item.id === targetId);
    const isReplaceIdMatch = Boolean(replaceId && item.id === replaceId);
    const isIdempMatch = Boolean(targetIdemp && item.idempotency_key && item.idempotency_key === targetIdemp);

    if (isIdMatch || isReplaceIdMatch || isIdempMatch) {
      if (!merged) {
        result.push({
          ...item,
          ...incoming,
          plaintext: incoming.plaintext !== undefined ? incoming.plaintext : item.plaintext,
          attachmentMeta: incoming.attachmentMeta !== undefined ? incoming.attachmentMeta : item.attachmentMeta,
          reactions: incoming.reactions !== undefined ? incoming.reactions : item.reactions,
          status: item.status === 'read' ? 'read' : (incoming.status || item.status || 'delivered'),
          is_read: Boolean(item.is_read || incoming.is_read),
        });
        merged = true;
      }
    } else {
      result.push(item);
    }
  }

  if (!merged) {
    result.push(incoming);
  }

  return result;
};

export const ChatView: React.FC<ChatViewProps> = ({
  conversation,
  currentUser,
  onBack,
  onSelectConversation,
  lang,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const isSendingRef = useRef(false);
  const [peerPublicKey, setPeerPublicKey] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [verificationState, setVerificationState] = useState<'verified' | 'unverified' | 'key_changed' | 'unavailable'>('unavailable');

  // Calling state
  const [callSession, setCallSession] = useState<CallSession | null>(null);

  // Typing state
  const [peerTyping, setPeerTyping] = useState(false);
  const peerTypingTimeoutRef = useRef<any>(null);
  const typingDebounceRef = useRef<any>(null);

  // Emoji and Sticker picker
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  // Round video note recorder
  const [showRoundVideoRecorder, setShowRoundVideoRecorder] = useState(false);

  // Mobile responsive menus
  const [showMobileHeaderMenu, setShowMobileHeaderMenu] = useState(false);
  const [showMobileToolsTray, setShowMobileToolsTray] = useState(false);

  // User Profile inspection modal
  const [inspectedUser, setInspectedUser] = useState<User | null>(null);

  // Drag and drop overlay
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const dragCounterRef = useRef(0);

  // Upload progress & cancellation
  const [uploadProgress, setUploadProgress] = useState<number | undefined>(undefined);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);

  // Downloading attachment status
  const [downloadingAttId, setDownloadingAttId] = useState<string | null>(null);

  // Media preview modal (before send - supports single and multiple files)
  const [pendingMediaFiles, setPendingMediaFiles] = useState<{
    files: File[];
    file?: File;
    isVideo?: boolean;
    isDocument?: boolean;
    previewUrl?: string;
  } | null>(null);

  // Lightbox viewer
  const [lightboxMedia, setLightboxMedia] = useState<LightboxMediaItem | null>(null);

  // Decrypted media URLs cache
  const [decryptedMediaUrls, setDecryptedMediaUrls] = useState<Record<string, string>>({});

  // Textarea ref for cursor positioning
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Live audio waveform bars for voice recording
  const [audioLevels, setAudioLevels] = useState<number[]>([15, 25, 40, 20, 10, 30, 45, 15]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Message Actions state
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [activeReactionMsgId, setActiveReactionMsgId] = useState<string | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  // Message Context Menu state
  const [contextMenuPos, setContextMenuPos] = useState<ContextMenuPosition | null>(null);

  // Formatting Toolbar state
  const [showFormattingToolbar, setShowFormattingToolbar] = useState(false);

  // Search in chat
  const [showSearch, setShowSearch] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);

  // Phase 9 States
  const [securityMode, setSecurityMode] = useState<string>(conversation.security_mode || 'normal');
  const [showModeModal, setShowModeModal] = useState(false);
  const [activatingE2EE, setActivatingE2EE] = useState(false);
  const [showVoiceChatModal, setShowVoiceChatModal] = useState(false);
  const [deleteTargetMsg, setDeleteTargetMsg] = useState<Message | null>(null);
  const [showDeleteChatModal, setShowDeleteChatModal] = useState(false);
  const [deletingChat, setDeletingChat] = useState(false);

  useEffect(() => {
    setSecurityMode(conversation.security_mode || 'normal');
  }, [conversation.id, conversation.security_mode]);

  // Phase 10–15 Platform States
  const [forwardingMessages, setForwardingMessages] = useState<Message[] | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  const [showSharedMedia, setShowSharedMedia] = useState(false);
  const [showCreatePollModal, setShowCreatePollModal] = useState(false);
  const [voicePlaybackSpeed, setVoicePlaybackSpeed] = useState<number>(1);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [isSilentSend, setIsSilentSend] = useState(false);
  const [scheduledDateStr, setScheduledDateStr] = useState('');
  const [showChatInfoModal, setShowChatInfoModal] = useState(false);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [showAddMemberInput, setShowAddMemberInput] = useState(false);
  const [newMemberUsername, setNewMemberUsername] = useState('');
  const [addingMember, setAddingMember] = useState(false);

  // Attachment Popover Menu state
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);

  // Outside click listener for emoji picker & attach popover
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        showEmojiPicker &&
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(target) &&
        !document.getElementById('emoji-picker-btn')?.contains(target)
      ) {
        setShowEmojiPicker(false);
      }
      if (
        showAttachMenu &&
        attachMenuRef.current &&
        !attachMenuRef.current.contains(target) &&
        !document.getElementById('attach-file-btn')?.contains(target)
      ) {
        setShowAttachMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showEmojiPicker, showAttachMenu]);

  // Per-conversation draft persistence
  useEffect(() => {
    const savedDraft = localStorage.getItem('nexachat_draft_' + conversation.id);
    if (savedDraft) {
      setInput(savedDraft);
    } else {
      setInput('');
    }
  }, [conversation.id]);

  // Role lookup for groups/channels
  useEffect(() => {
    if (conversation.type === 'group' || conversation.type === 'channel') {
      api.getConversationRole(conversation.id)
        .then((res) => setMyRole(res.role))
        .catch(() => setMyRole(null));
    } else {
      setMyRole(null);
    }
  }, [conversation.id, conversation.type]);

  const toggleSelectMessage = (id: string) => {
    setSelectedMsgIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (selectedMsgIds.size === 0) return;
    if (!confirm(`Delete ${selectedMsgIds.size} selected messages?`)) return;
    try {
      for (const id of Array.from(selectedMsgIds)) {
        await api.deleteMessage(conversation.id, id, 'me');
      }
      setSelectionMode(false);
      setSelectedMsgIds(new Set());
      await loadMessages();
    } catch (err: any) {
      alert(`Failed to delete messages: ${err.message}`);
    }
  };

  const handleBulkForward = () => {
    if (selectedMsgIds.size === 0) return;
    const msgs = messages.filter((m) => selectedMsgIds.has(m.id));
    if (msgs.length > 0) {
      setForwardingMessages(msgs);
    }
  };

  const handleExecuteForward = async (targetConversationId: string, hideAttribution: boolean) => {
    if (!forwardingMessages || forwardingMessages.length === 0 || isSendingRef.current) return;
    isSendingRef.current = true;
    try {
      // Determine if destination is E2EE
      let isTargetE2EE = false;
      const targetTargets: Array<{ userId: string; deviceId: string; publicKeyBase64?: string }> = [];
      try {
        const res = await api.listConversations();
        const targetConv = (res.conversations || []).find((c: Conversation) => c.id === targetConversationId);
        if (targetConv && targetConv.security_mode === 'e2ee_active') {
          isTargetE2EE = true;
          for (const p of targetConv.participants || [currentUser]) {
            try {
              const pkg = await api.getUserKeys(p.id);
              for (const d of pkg.devices || []) {
                targetTargets.push({ userId: p.id, deviceId: d.device_id, publicKeyBase64: d.identity_public_key });
              }
            } catch {}
          }
        }
      } catch {}

      for (const msg of forwardingMessages) {
        const payload: any = {
          text: msg.plaintext || msg.ciphertext,
          is_forwarded: true,
          forward_from_name: hideAttribution ? undefined : (msg.sender_username || 'User'),
        };
        if (msg.attachmentMeta) {
          payload.attachment = msg.attachmentMeta;
          payload.type = msg.attachmentMeta.isVoice
            ? 'voice'
            : msg.attachmentMeta.isRoundVideo
            ? 'video_note'
            : msg.attachmentMeta.isSticker
            ? 'sticker'
            : 'attachment';
        }
        if (msg.poll_id) {
          if (isTargetE2EE) {
            payload.type = 'poll';
            payload.poll_id = msg.poll_id;
            payload.poll_key = msg.poll_key;
            payload.poll_iv = msg.poll_iv;
          } else {
            // In normal chat, do not leak E2EE poll decryption keys to server storage
            payload.text = msg.plaintext || '📊 Poll';
          }
        }
        const payloadStr = JSON.stringify(payload);
        let finalCiphertext = payloadStr;
        let finalNonce = 'normal';

        if (isTargetE2EE) {
          if (targetTargets.length === 0) {
            throw new Error('E2EE_KEYS_UNAVAILABLE: Cannot forward to E2EE chat without recipient cryptographic keys.');
          }
          const token = api.getToken() || undefined;
          const encrypted = await signalManager.encryptMultiDevice(payloadStr, targetTargets, targetConversationId, token);
          finalCiphertext = encrypted.ciphertext;
          finalNonce = encrypted.nonce;
        }

        const idempotencyKey = 'idemp_fwd_' + msg.id + '_' + Date.now();
        await api.submitMessage(targetConversationId, {
          ciphertext: finalCiphertext,
          nonce: finalNonce,
          idempotency_key: idempotencyKey,
        });
      }
      setForwardingMessages(null);
      setSelectionMode(false);
      setSelectedMsgIds(new Set());
      if (targetConversationId === conversation.id) {
        await loadMessages();
      }
    } catch (err: any) {
      alert(`Failed to forward message: ${err.message}`);
    } finally {
      isSendingRef.current = false;
    }
  };

  const cycleVoiceSpeed = () => {
    const speeds = [1, 1.5, 2];
    const nextIdx = (speeds.indexOf(voicePlaybackSpeed) + 1) % speeds.length;
    const nextSpeed = speeds[nextIdx];
    setVoicePlaybackSpeed(nextSpeed);
    if (audioPlayerRef.current) {
      audioPlayerRef.current.playbackRate = nextSpeed;
    }
  };

  const handlePollCreated = async (params: {
    question: string;
    options: string[];
    is_anonymous: boolean;
    allows_multiple: boolean;
    is_quiz: boolean;
    correct_option?: number;
    explanation?: string;
  }) => {
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    try {
      const isE2EE = securityMode === 'e2ee_active';
      let pollCreationParams = params;
      let pollKeyBase64: string | undefined = undefined;
      let pollIvBase64: string | undefined = undefined;

      if (isE2EE) {
        const encryptedPoll = await signalManager.encryptPollData(params.question, params.options);
        pollKeyBase64 = encryptedPoll.keyBase64;
        pollIvBase64 = encryptedPoll.ivBase64;
        pollCreationParams = {
          ...params,
          question: encryptedPoll.encryptedQuestion,
          options: encryptedPoll.encryptedOptions,
          explanation: params.explanation ? (await signalManager.encryptPollData(params.explanation, [])).encryptedQuestion : undefined,
        };
      }

      const poll = await api.createPoll(conversation.id, pollCreationParams);
      setShowCreatePollModal(false);
      const pollPayload = {
        type: 'poll',
        poll_id: poll.id,
        poll_key: pollKeyBase64,
        poll_iv: pollIvBase64,
        text: `📊 ${params.question}`,
      };
      const payloadStr = JSON.stringify(pollPayload);
      let finalCiphertext = payloadStr;
      let finalNonce = 'normal';

      if (isE2EE) {
        const targets = await getEncryptionTargets();
        if (targets.length === 0) {
          throw new Error('E2EE_KEYS_UNAVAILABLE: Cannot create E2EE poll without recipient cryptographic keys.');
        }
        const token = api.getToken() || undefined;
        const encrypted = await signalManager.encryptMultiDevice(payloadStr, targets, conversation.id, token);
        finalCiphertext = encrypted.ciphertext;
        finalNonce = encrypted.nonce;
      }

      const idempotencyKey = 'idemp_poll_' + poll.id;
      await api.submitMessage(conversation.id, {
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        idempotency_key: idempotencyKey,
      });
      await loadMessages();
    } catch (err: any) {
      alert(`Failed to create poll: ${err.message}`);
    } finally {
      isSendingRef.current = false;
    }
  };

  const handleScheduleSubmit = async () => {
    const text = input.trim();
    if (!text || !scheduledDateStr) return;
    try {
      await api.scheduleMessage(conversation.id, {
        ciphertext: text,
        scheduled_for: new Date(scheduledDateStr).toISOString(),
        is_silent: isSilentSend,
      });
      alert('Message scheduled successfully!');
      setShowScheduleModal(false);
      setInput('');
      localStorage.removeItem('nexachat_draft_' + conversation.id);
    } catch (err: any) {
      alert(`Failed to schedule message: ${err.message}`);
    }
  };

  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<any>(null);

  // Audio playback state
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  // File upload input ref
  const fileInputRef = useRef<HTMLInputElement>(null);


  const messagesEndRef = useRef<HTMLDivElement>(null);
  const t = translations[lang];

  const myDeviceId = localStorage.getItem('nexachat_device_id') || 'dev_current';
  const peerUser = conversation.participants?.find((p) => p.id !== currentUser.id);
  const peerPresence = useUserPresence(peerUser?.id, lang);
  const [readByModalMessage, setReadByModalMessage] = useState<Message | null>(null);
  const isChannel = conversation.type === 'channel';
  const isGroup = conversation.type === 'group';
  const isSaved = conversation.type === 'saved' || conversation.title === 'Saved Messages' || (!peerUser && conversation.type === 'direct');
  const chatTitle = isSaved
    ? (lang === 'fa' ? 'پیام‌های ذخیره‌شده' : 'Saved Messages')
    : conversation.title || peerUser?.display_name || peerUser?.username || 'Chat';
  const activeAvatarUrl = isSaved ? undefined : (conversation.avatar_url || peerUser?.avatar_url);

  // Members state for group/channel inspection modal (Issue 3)
  const [conversationMembers, setConversationMembers] = useState<ConversationMemberDetail[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);

  const loadMembers = async () => {
    if (!isGroup && !isChannel) return;
    setLoadingMembers(true);
    setMembersError(null);
    try {
      const res = await api.getConversationMembers(conversation.id);
      setConversationMembers(res.members || []);
    } catch (err: any) {
      setMembersError(err.message || 'Failed to load member list');
      setConversationMembers([]);
    } finally {
      setLoadingMembers(false);
    }
  };

  // Invites & Disappearing Messages state
  const [activeInviteCode, setActiveInviteCode] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [conversationTTL, setConversationTTL] = useState<number>(conversation.disappearing_ttl || 0);
  const [updatingTTL, setUpdatingTTL] = useState(false);
  const [updatingRoleUserId, setUpdatingRoleUserId] = useState<string | null>(null);

  useEffect(() => {
    setConversationTTL(conversation.disappearing_ttl || 0);
  }, [conversation.id, conversation.disappearing_ttl]);

  const loadInvites = async () => {
    if (!isGroup && !isChannel) return;
    try {
      const invites = await api.listConversationInvites(conversation.id);
      if (Array.isArray(invites) && invites.length > 0) {
        setActiveInviteCode(invites[0].invite_code);
      } else {
        setActiveInviteCode(null);
      }
    } catch (err) {
      console.warn('Failed to load invites:', err);
    }
  };

  const handleGenerateInvite = async () => {
    setInviteLoading(true);
    try {
      const inv = await api.createConversationInvite(conversation.id, { expires_in_hours: 48 });
      setActiveInviteCode(inv.invite_code);
    } catch (err: any) {
      alert(err.message || 'Failed to generate invite');
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRevokeInvite = async (code: string) => {
    if (!confirm('Revoke this invite link? Users with this link will no longer be able to join.')) return;
    setInviteLoading(true);
    try {
      await api.revokeConversationInvite(conversation.id, code);
      setActiveInviteCode(null);
      await loadInvites();
    } catch (err: any) {
      alert(err.message || 'Failed to revoke invite');
    } finally {
      setInviteLoading(false);
    }
  };

  const handleUpdateRole = async (targetUserId: string, newRole: 'admin' | 'member') => {
    setUpdatingRoleUserId(targetUserId);
    try {
      await api.updateMemberRole(conversation.id, targetUserId, newRole);
      await loadMembers();
    } catch (err: any) {
      alert(err.message || 'Failed to update member role');
    } finally {
      setUpdatingRoleUserId(null);
    }
  };

  const handleSetTTL = async (ttl: number) => {
    setUpdatingTTL(true);
    try {
      await api.setConversationTTL(conversation.id, ttl);
      setConversationTTL(ttl);
      conversation.disappearing_ttl = ttl;
    } catch (err: any) {
      alert(err.message || 'Failed to update disappearing timer');
    } finally {
      setUpdatingTTL(false);
    }
  };

  useEffect(() => {
    if (showChatInfoModal && (isGroup || isChannel)) {
      loadMembers();
      loadInvites();
    }
  }, [showChatInfoModal, conversation.id, isGroup, isChannel]);

  // Initialize Signal Protocol Manager for this user session
  useEffect(() => {
    const token = api.getToken();
    if (token) {
      signalManager.initialize(currentUser.id, myDeviceId, token).catch((e) => {
        console.warn('Signal manager init warning:', e);
      });
    }
  }, [currentUser.id, myDeviceId]);

  // Load Peer Device keys and compute Safety Number
  useEffect(() => {
    if (peerUser) {
      api.getUserKeys(peerUser.id)
        .then(async (pkg) => {
          if (pkg.devices && pkg.devices.length > 0) {
            const firstKey = pkg.devices[0].identity_public_key;
            if (firstKey) {
              setPeerPublicKey(firstKey);
              // Compute safety number using Signal identity
              try {
                const sn = await signalManager.calculateSafetyNumber(firstKey);
                setSafetyNumber(sn);
              } catch (err) {
                console.warn('Safety number computation error:', err);
              }

              // Check verified status in local storage
              const savedKey = localStorage.getItem('verified_key_' + peerUser.id);
              if (!savedKey) {
                setVerificationState('unverified');
              } else if (savedKey === firstKey) {
                setVerificationState('verified');
              } else {
                setVerificationState('key_changed');
              }
            }
          }
        })
        .catch((e) => console.warn('Could not fetch peer keys:', e));
    } else {
      setVerificationState('unavailable');
    }
  }, [conversation.id, peerUser?.id]);

  const toggleVerification = () => {
    if (!peerUser || !peerPublicKey) return;
    if (verificationState === 'verified') {
      localStorage.removeItem('verified_key_' + peerUser.id);
      setVerificationState('unverified');
    } else {
      localStorage.setItem('verified_key_' + peerUser.id, peerPublicKey);
      setVerificationState('verified');
    }
  };

  // Helper to parse message payload (text, media, voice, sticker, video note, poll, call_event)
  const parsePayload = (plaintext: string): {
    displayText: string;
    attachmentMeta?: any;
    pollId?: string;
    pollKey?: string;
    pollIv?: string;
    isForwarded?: boolean;
    forwardFromName?: string;
    callEvent?: {
      call_id: string;
      call_type: 'audio' | 'video';
      outcome: 'completed' | 'missed' | 'declined' | 'rejected' | 'cancelled';
      duration_seconds: number;
      caller_id?: string;
      caller_name?: string;
      receiver_id?: string;
    };
  } => {
    if (plaintext.startsWith('{') && plaintext.endsWith('}')) {
      try {
        const parsed: ParsedMessagePayload = JSON.parse(plaintext);
        if (parsed.type === 'call_event' || parsed.call_id) {
          const callType: 'audio' | 'video' = parsed.call_type === 'video' ? 'video' : 'audio';
          const outcome = (parsed.outcome as any) || 'completed';
          return {
            displayText: parsed.text || 'Call',
            callEvent: {
              call_id: parsed.call_id || '',
              call_type: callType,
              outcome,
              duration_seconds: parsed.duration_seconds || 0,
            },
          };
        }
        if (parsed.type === 'poll' && parsed.poll_id) {
          return {
            displayText: parsed.text || '📊 Poll',
            pollId: parsed.poll_id,
            pollKey: parsed.poll_key,
            pollIv: parsed.poll_iv,
          };
        }
        if (parsed.type === 'attachment' || parsed.type === 'voice' || parsed.type === 'sticker' || parsed.type === 'video_note') {
          return {
            displayText:
              parsed.text ||
              (parsed.type === 'voice'
                ? t.voice_message
                : parsed.type === 'video_note'
                ? 'Video Note'
                : parsed.type === 'sticker'
                ? 'Sticker'
                : 'Attachment'),
            attachmentMeta: parsed.attachment,
            isForwarded: parsed.is_forwarded,
            forwardFromName: parsed.forward_from_name,
          };
        }
        if (parsed.is_forwarded) {
          return {
            displayText: parsed.text || plaintext,
            isForwarded: true,
            forwardFromName: parsed.forward_from_name,
          };
        }
      } catch {}
    }
    return { displayText: plaintext };
  };

  // WebRTC Call Subscription
  useEffect(() => {
    const unsub = webrtcManager.subscribe((session) => {
      setCallSession(session);
    });
    return () => unsub();
  }, []);

  // Typing indicator listener
  useEffect(() => {
    const unsub = wsManager.subscribe((event) => {
      if (event.type === 'typing' && event.payload?.conversation_id === conversation.id) {
        if (event.payload.user_id !== currentUser.id) {
          setPeerTyping(event.payload.is_typing);
          clearTimeout(peerTypingTimeoutRef.current);
          if (event.payload.is_typing) {
            peerTypingTimeoutRef.current = setTimeout(() => {
              setPeerTyping(false);
            }, 4000);
          }
        }
      }
    });
    return () => {
      unsub();
      clearTimeout(peerTypingTimeoutRef.current);
    };
  }, [conversation.id, currentUser.id]);


  // Decrypt and format a single message
  const decryptSingleMessage = async (msg: Message): Promise<Message> => {
    const isRead = Boolean(msg.is_read);
    if (msg.is_deleted) {
      return {
        ...msg,
        plaintext: t.deleted_message,
        status: isRead ? 'read' : 'delivered',
      };
    }

    let plaintext = msg.ciphertext;
    let decryptionError = false;
    let attachmentMeta = undefined;
    let pollId: string | undefined = undefined;
    let pollKey: string | undefined = undefined;
    let pollIv: string | undefined = undefined;
    let isForwarded: boolean | undefined = undefined;
    let forwardFromName: string | undefined = undefined;
    let callEvent = msg.callEvent;

    // Message classification: Normal Chat messages and system messages are server-readable
    const isNormalMessage = msg.nonce === 'normal' || msg.nonce === '' || msg.nonce === 'system';

    if (!isNormalMessage) {
      try {
        // E2EE decryption
        const decrypted = await signalManager.decryptMessage(
          msg.ciphertext,
          msg.nonce,
          msg.sender_id,
          msg.sender_id === currentUser.id ? myDeviceId : '',
          peerPublicKey || '',
          conversation.id
        );
        const parsed = parsePayload(decrypted);
        plaintext = parsed.displayText;
        attachmentMeta = parsed.attachmentMeta;
        pollId = parsed.pollId;
        pollKey = parsed.pollKey;
        pollIv = parsed.pollIv;
        isForwarded = parsed.isForwarded;
        forwardFromName = parsed.forwardFromName;
        if (parsed.callEvent) callEvent = parsed.callEvent;
      } catch (err: any) {
        const errMsg = err?.message || '';
        if (errMsg.includes('EMPTY_ENVELOPE')) {
          plaintext = `[${t.error_legacy_envelope}]`;
        } else if (errMsg.includes('DEVICE_NOT_TARGETED')) {
          plaintext = `[${t.error_not_for_device}]`;
        } else {
          // Cryptographic integrity failure, key mismatch, or ciphertext tampering
          decryptionError = true;
        }
      }
    } else {
      // Normal Chat / System Message (Server-readable payload)
      const parsed = parsePayload(msg.ciphertext);
      plaintext = parsed.displayText;
      attachmentMeta = parsed.attachmentMeta;
      pollId = parsed.pollId;
      pollKey = parsed.pollKey;
      pollIv = parsed.pollIv;
      isForwarded = parsed.isForwarded;
      forwardFromName = parsed.forwardFromName;
      if (parsed.callEvent) callEvent = parsed.callEvent;
    }

    // Parse reactions map if string
    let reactions = msg.reactions;
    if (typeof reactions === 'string') {
      try {
        reactions = JSON.parse(reactions);
      } catch {}
    }

    return {
      ...msg,
      plaintext,
      attachmentMeta,
      poll_id: pollId || msg.poll_id,
      poll_key: pollKey || msg.poll_key,
      poll_iv: pollIv || msg.poll_iv,
      is_forwarded: isForwarded || msg.is_forwarded,
      forward_from_name: forwardFromName || msg.forward_from_name,
      callEvent,
      reactions,
      decryptionError,
      status: isRead ? 'read' : 'delivered',
    };
  };

  // Load initial conversation messages
  const loadMessages = async () => {
    try {
      const res = await api.listMessages(conversation.id, 50);
      const decryptedList: Message[] = await Promise.all(
        res.messages.map((m) => decryptSingleMessage(m))
      );

      // Deduplicate loaded messages by ID
      const seenIds = new Set<string>();
      const dedupedList: Message[] = [];
      for (const msg of decryptedList) {
        if (msg.id && !seenIds.has(msg.id)) {
          seenIds.add(msg.id);
          dedupedList.push(msg);
        }
      }

      setMessages((prev) => {
        // Retain any pending in-flight messages that have not yet arrived in history
        const pendingSending = prev.filter(
          (m) =>
            m.status === 'sending' &&
            !seenIds.has(m.id) &&
            (!m.idempotency_key || !dedupedList.some((d) => d.idempotency_key === m.idempotency_key))
        );
        return [...dedupedList, ...pendingSending];
      });

      // Automatically mark conversation read up to the latest unread incoming message if window is focused
      const unreadIncoming = res.messages.filter((m: Message) => m.sender_id !== currentUser.id && !m.is_read);
      if (unreadIncoming.length > 0 && typeof document !== 'undefined' && !document.hidden) {
        const latestUnread = unreadIncoming[unreadIncoming.length - 1];
        api.markConversationRead(conversation.id, latestUnread.id).catch(() => {});
        unreadIncoming.forEach((m: Message) => {
          api.recordMessageRead(conversation.id, m.id).catch(() => {});
        });
      }

      // Record views for channel messages
      if (conversation.type === 'channel') {
        res.messages.slice(-5).forEach((m: Message) => {
          api.recordMessageView(conversation.id, m.id).catch(() => {});
        });
      }
    } catch (e) {
      console.error('Failed to load messages:', e);
    }
  };

  // Real-time synchronization without reopening chats or aggressive polling (Phase 3)
  useEffect(() => {
    loadMessages();

    const unsub = wsManager.subscribe((event) => {
      if (event.payload?.conversation_id !== conversation.id) {
        return;
      }

      if (event.type === 'message.created') {
        const payload = event.payload || {};
        const msgId = payload.id || payload.message_id;
        const rawMsg = {
          ...payload,
          id: msgId,
          idempotency_key: payload.idempotency_key || payload.idempotencyKey,
        } as Message;

        decryptSingleMessage(rawMsg).then((decryptedMsg) => {
          setMessages((prev) => reconcileMessageList(prev, decryptedMsg));

          // Mark incoming message as read if user is actively viewing this conversation and tab is visible
          if (decryptedMsg.sender_id !== currentUser.id && decryptedMsg.id && typeof document !== 'undefined' && !document.hidden) {
            api.recordMessageRead(conversation.id, decryptedMsg.id).catch(() => {});
          }
        });
      } else if (event.type === 'message.read') {
        const msgId = event.payload?.message_id || event.payload?.id;
        if (msgId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId
                ? { ...m, is_read: true, status: 'read', read_count: Math.max(m.read_count || 0, (m.read_count || 0) + 1) }
                : m
            )
          );
        }
      } else if (event.type === 'conversation.read') {
        const readAtStr = event.payload?.read_at;
        const targetMsgId = event.payload?.message_id;
        const readerId = event.payload?.user_id || event.payload?.reader_id;

        // Only mark sender's outgoing messages up to the reader's cutoff timestamp
        if (readerId && readerId !== currentUser.id) {
          setMessages((prev) => {
            const targetMsg = targetMsgId ? prev.find((m) => m.id === targetMsgId) : null;
            const cutoffTime = targetMsg
              ? new Date(targetMsg.created_at).getTime()
              : (readAtStr ? new Date(readAtStr).getTime() : 0);

            return prev.map((m) => {
              if (m.sender_id === currentUser.id && !m.is_read) {
                if (cutoffTime > 0) {
                  const mTime = new Date(m.created_at).getTime();
                  if (mTime <= cutoffTime) {
                    return { ...m, is_read: true, status: 'read' };
                  }
                  return m;
                }
                return { ...m, is_read: true, status: 'read' };
              }
              return m;
            });
          });
        }
      } else if (event.type === 'message.deleted') {
        const msgId = event.payload?.message_id || event.payload?.id;
        if (msgId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === msgId ? { ...m, is_deleted: true, plaintext: t.deleted_message } : m
            )
          );
        }
      } else if (event.type === 'reaction.updated') {
        const msgId = event.payload?.message_id;
        let reactions = event.payload?.reactions;
        if (typeof reactions === 'string') {
          try {
            reactions = JSON.parse(reactions);
          } catch {}
        }
        if (msgId) {
          setMessages((prev) =>
            prev.map((m) => (m.id === msgId ? { ...m, reactions } : m))
          );
        }
      } else if (event.type === 'message.updated' || event.type === 'call_event') {
        loadMessages();
      }
    });

    return () => {
      unsub();
    };
  }, [conversation.id, peerPublicKey]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Build target recipients across conversation
  const getEncryptionTargets = async (): Promise<Array<{ userId: string; deviceId: string; publicKeyBase64?: string }>> => {
    const targets: Array<{ userId: string; deviceId: string; publicKeyBase64?: string }> = [];
    const participants = conversation.participants || (peerUser ? [currentUser, peerUser] : [currentUser]);

    for (const p of participants) {
      if (p.id === currentUser.id) {
        // Own device(s): fetch keys and include all devices
        try {
          const pkg = await api.getUserKeys(currentUser.id);
          for (const d of pkg.devices || []) {
            targets.push({ userId: currentUser.id, deviceId: d.device_id, publicKeyBase64: d.identity_public_key });
          }
        } catch {}
        // Fallback: ensure current device is present
        if (!targets.some((t) => t.userId === currentUser.id && t.deviceId === myDeviceId)) {
          const myKeyPair = await cryptoEngine.getOrCreateDeviceKeyPair(currentUser.id, myDeviceId);
          targets.push({ userId: currentUser.id, deviceId: myDeviceId, publicKeyBase64: myKeyPair.publicKeyBase64 });
        }
      } else {
        // Recipient devices
        try {
          const pkg = await api.getUserKeys(p.id);
          for (const d of pkg.devices || []) {
            targets.push({ userId: p.id, deviceId: d.device_id, publicKeyBase64: d.identity_public_key });
          }
        } catch {}
      }
    }

    return targets;
  };

  // Send or Edit message
  const handleSendMessage = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const text = input.trim();
    if (!text || isSendingRef.current) return;

    isSendingRef.current = true;
    setSending(true);

    try {
      const isE2EE = securityMode === 'e2ee_active';

      // Check if we are currently editing an existing message
      if (editingMessage) {
        if (isE2EE) {
          const targets = await getEncryptionTargets();
          const token = api.getToken() || undefined;
          const encrypted = await signalManager.encryptMultiDevice(text, targets, conversation.id, token);
          await api.editMessage(conversation.id, editingMessage.id, encrypted.ciphertext);
        } else {
          await api.editMessage(conversation.id, editingMessage.id, text);
        }
        setEditingMessage(null);
        setInput('');
        await loadMessages();
        return;
      }

      // Normal send or reply
      let finalCiphertext = text;
      let finalNonce = 'normal';

      if (isE2EE) {
        const targets = await getEncryptionTargets();
        const token = api.getToken() || undefined;
        const encrypted = await signalManager.encryptMultiDevice(text, targets, conversation.id, token);
        finalCiphertext = encrypted.ciphertext;
        finalNonce = encrypted.nonce;
      }

      setInput('');
      localStorage.removeItem('nexachat_draft_' + conversation.id);
      const replyId = replyingTo?.id;
      setReplyingTo(null);

      const idempotencyKey = 'idemp_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);

      // Optimistic append
      const optMsg: Message = {
        id: 'opt_' + Date.now(),
        idempotency_key: idempotencyKey,
        conversation_id: conversation.id,
        sender_id: currentUser.id,
        sender_username: currentUser.username,
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        plaintext: text,
        reply_to_id: replyId,
        created_at: new Date().toISOString(),
        status: 'sending',
      };
      setMessages((prev) => reconcileMessageList(prev, optMsg));

      const saved = await api.submitMessage(conversation.id, {
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        reply_to_id: replyId,
        idempotency_key: idempotencyKey,
      });

      const authoritativeMsg: Message = {
        ...optMsg,
        ...saved,
        id: saved.id,
        idempotency_key: idempotencyKey,
        plaintext: text,
        status: 'delivered',
      };

      setMessages((prev) => reconcileMessageList(prev, authoritativeMsg, optMsg.id));
    } catch (err: any) {
      console.error('Failed to submit message:', err);
    } finally {
      isSendingRef.current = false;
      setSending(false);
    }
  };

  // Send GIF
  const handleSendGIF = async (gif: GIFItem) => {
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    setShowEmojiPicker(false);
    setSending(true);
    try {
      const payload: ParsedMessagePayload = {
        text: gif.title || 'GIF',
        type: 'attachment',
        attachment: {
          isPhoto: true,
          contentType: 'image/gif',
          caption: gif.title,
          filename: `${gif.title || 'animated'}.gif`,
          keyBase64: '',
          ivBase64: '',
          stickerUrl: gif.url,
        },
      };

      const payloadStr = JSON.stringify(payload);
      const isE2EE = securityMode === 'e2ee_active';

      let finalCiphertext = payloadStr;
      let finalNonce = 'normal';

      if (isE2EE) {
        const targets = await getEncryptionTargets();
        const token = api.getToken() || undefined;
        const encrypted = await signalManager.encryptMultiDevice(payloadStr, targets, conversation.id, token);
        finalCiphertext = encrypted.ciphertext;
        finalNonce = encrypted.nonce;
      }

      const idempotencyKey = 'idemp_gif_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      await api.submitMessage(conversation.id, {
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        idempotency_key: idempotencyKey,
      });

      await loadMessages();
    } catch (err: any) {
      alert(`Failed to send GIF: ${err.message}`);
    } finally {
      isSendingRef.current = false;
      setSending(false);
    }
  };

  // Message Actions
  const handleReply = (msg: Message) => {
    setEditingMessage(null);
    setReplyingTo(msg);
  };

  const handleStartEdit = (msg: Message) => {
    setReplyingTo(null);
    setEditingMessage(msg);
    setInput(msg.plaintext || '');
  };

  const handleDeleteClick = (msg: Message) => {
    setDeleteTargetMsg(msg);
  };

  const executeDeleteForMe = async () => {
    if (!deleteTargetMsg) return;
    const msgId = deleteTargetMsg.id;
    setDeleteTargetMsg(null);
    try {
      await api.deleteMessage(conversation.id, msgId, 'me');
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
    } catch (e: any) {
      alert(`Delete for me failed: ${e.message}`);
    }
  };

  const executeDeleteForEveryone = async () => {
    if (!deleteTargetMsg) return;
    const msgId = deleteTargetMsg.id;
    setDeleteTargetMsg(null);
    try {
      await api.deleteMessage(conversation.id, msgId, 'everyone');
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, is_deleted: true, plaintext: t.deleted_message } : m))
      );
    } catch (e: any) {
      alert(`Delete for everyone failed: ${e.message}`);
    }
  };

  const executeDeleteChatForMe = async () => {
    setDeletingChat(true);
    try {
      await api.deleteConversation(conversation.id, 'me');
      setShowDeleteChatModal(false);
      setMessages([]);
      await loadMessages();
    } catch (e: any) {
      alert(`Clear chat failed: ${e.message}`);
    } finally {
      setDeletingChat(false);
    }
  };

  const executeDeleteChatForBoth = async () => {
    if (!confirm('Are you sure you want to permanently delete this chat for both participants?')) return;
    setDeletingChat(true);
    try {
      await api.deleteConversation(conversation.id, 'both');
      setShowDeleteChatModal(false);
      if (onBack) onBack();
    } catch (e: any) {
      alert(`Delete chat for both failed: ${e.message}`);
    } finally {
      setDeletingChat(false);
    }
  };

  const handleActivateE2EE = async () => {
    if (!peerUser) return;
    setActivatingE2EE(true);
    try {
      const peerKeys = await api.getUserKeys(peerUser.id);
      if (!peerKeys.devices || peerKeys.devices.length === 0) {
        throw new Error(`${peerUser.display_name || peerUser.username} has not registered device keys yet.`);
      }
      await api.setConversationSecurityMode(conversation.id, 'e2ee_active');
      setSecurityMode('e2ee_active');
      conversation.security_mode = 'e2ee_active';
      setShowModeModal(false);
    } catch (err: any) {
      alert(`Could not enable E2EE: ${err.message}`);
    } finally {
      setActivatingE2EE(false);
    }
  };

  const handleTogglePin = async (msg: Message) => {
    const nextPinState = !msg.is_pinned;
    try {
      await api.pinMessage(conversation.id, msg.id, nextPinState);
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, is_pinned: nextPinState } : m))
      );
    } catch (e: any) {
      alert(`Pin toggle failed: ${e.message}`);
    }
  };

  const handleAddReaction = async (msgId: string, emoji: string) => {
    setActiveReactionMsgId(null);
    try {
      const res = await api.addReaction(conversation.id, msgId, emoji);
      let reactions: Record<string, string[]> = {};
      try {
        reactions = JSON.parse(res.reactions);
      } catch {}
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, reactions } : m))
      );
    } catch (e: any) {
      console.error('Reaction failed:', e);
    }
  };

  const handleCopyText = (msg: Message) => {
    const text = msg.plaintext || '';
    navigator.clipboard.writeText(text);
    setCopiedMsgId(msg.id);
    setTimeout(() => setCopiedMsgId(null), 2000);
  };

  // Insert emoji at current cursor position
  const handleInsertEmoji = (emoji: string) => {
    if (!textareaRef.current) {
      setInput((prev) => prev + emoji);
      return;
    }
    const el = textareaRef.current;
    const start = el.selectionStart || input.length;
    const end = el.selectionEnd || input.length;
    const next = input.substring(0, start) + emoji + input.substring(end);
    setInput(next);
    setTimeout(() => {
      el.selectionStart = el.selectionEnd = start + emoji.length;
      el.focus();
    }, 10);
  };

  // Send Sticker
  const handleSendSticker = async (pack: StickerPack, sticker: Sticker) => {
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    setShowEmojiPicker(false);
    setSending(true);
    try {
      const payload: ParsedMessagePayload = {
        text: sticker.emoji || 'Sticker',
        type: 'sticker',
        attachment: {
          isSticker: true,
          stickerPackId: pack.id,
          stickerId: sticker.id,
          stickerUrl: sticker.asset_url,
        },
      };

      const payloadStr = JSON.stringify(payload);
      const isE2EE = securityMode === 'e2ee_active';

      let finalCiphertext = payloadStr;
      let finalNonce = 'normal';

      if (isE2EE) {
        const targets = await getEncryptionTargets();
        const token = api.getToken() || undefined;
        const encryptedMsg = await signalManager.encryptMultiDevice(payloadStr, targets, conversation.id, token);
        finalCiphertext = encryptedMsg.ciphertext;
        finalNonce = encryptedMsg.nonce;
      }

      const idempotencyKey = 'idemp_sticker_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      await api.submitMessage(conversation.id, {
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        idempotency_key: idempotencyKey,
      });

      await loadMessages();
    } catch (err: any) {
      alert(`Failed to send sticker: ${err.message}`);
    } finally {
      isSendingRef.current = false;
      setSending(false);
    }
  };

  // Client-Side Encrypted File Upload Pipeline (Telegram-style preview & progress, multi-file support)
  const prepareFilesForSending = (files: File[]) => {
    if (files.length === 0) return;
    const firstFile = files[0];
    const isVid = firstFile.type.startsWith('video/');
    const isDoc = !firstFile.type.startsWith('image/') && !firstFile.type.startsWith('video/');
    const previewUrl = !isDoc ? URL.createObjectURL(firstFile) : undefined;
    setPendingMediaFiles({
      files,
      file: firstFile,
      isVideo: isVid,
      isDocument: isDoc,
      previewUrl,
    });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    prepareFilesForSending(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const generateBlurredPreview = async (file: File): Promise<string | undefined> => {
    try {
      if (file.type.startsWith('image/')) {
        return new Promise((resolve) => {
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => {
            URL.revokeObjectURL(url);
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 24;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0, 32, 24);
              resolve(canvas.toDataURL('image/jpeg', 0.4));
            } else {
              resolve(undefined);
            }
          };
          img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(undefined);
          };
          img.src = url;
        });
      } else if (file.type.startsWith('video/')) {
        return new Promise((resolve) => {
          const video = document.createElement('video');
          const url = URL.createObjectURL(file);
          video.preload = 'metadata';
          video.muted = true;
          video.playsInline = true;
          video.onloadeddata = () => {
            video.currentTime = 0.1;
          };
          video.onseeked = () => {
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 24;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, 32, 24);
              URL.revokeObjectURL(url);
              resolve(canvas.toDataURL('image/jpeg', 0.4));
            } else {
              URL.revokeObjectURL(url);
              resolve(undefined);
            }
          };
          video.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(undefined);
          };
          video.src = url;
        });
      }
    } catch {
      return undefined;
    }
    return undefined;
  };

  const sendSingleFile = async (file: File, caption: string) => {
    const isE2EE = securityMode === 'e2ee_active';
    let att: any;
    let keyBase64 = '';
    let ivBase64 = '';

    if (isE2EE) {
      const encryptedFile = await signalManager.encryptAttachment(file);
      att = await api.uploadAttachmentWithProgress(
        conversation.id,
        encryptedFile.encryptedBlob,
        file.name,
        true,
        (percent) => setUploadProgress(percent),
        uploadAbortControllerRef.current?.signal
      );
      keyBase64 = encryptedFile.keyBase64;
      ivBase64 = encryptedFile.ivBase64;
    } else {
      // Normal Chat: Upload raw attachment directly to server with real progress
      att = await api.uploadAttachmentWithProgress(
        conversation.id,
        file,
        file.name,
        false,
        (percent) => setUploadProgress(percent),
        uploadAbortControllerRef.current?.signal
      );
    }

    const isPhoto = file.type.startsWith('image/');
    const isVideo = file.type.startsWith('video/');
    const blurredPreviewBase64 = (isPhoto || isVideo) ? await generateBlurredPreview(file) : undefined;

    const payload: ParsedMessagePayload = {
      text: caption || file.name,
      type: 'attachment',
      attachment: {
        id: att.id,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        keyBase64,
        ivBase64,
        isPhoto,
        isVideo,
        caption,
        blurredPreviewBase64,
      },
    };

    const payloadStr = JSON.stringify(payload);
    let finalCiphertext = payloadStr;
    let finalNonce = 'normal';

    if (isE2EE) {
      const targets = await getEncryptionTargets();
      const token = api.getToken() || undefined;
      const encryptedMsg = await signalManager.encryptMultiDevice(payloadStr, targets, conversation.id, token);
      finalCiphertext = encryptedMsg.ciphertext;
      finalNonce = encryptedMsg.nonce;
    }

    const idempotencyKey = 'idemp_file_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    await api.submitMessage(conversation.id, {
      ciphertext: finalCiphertext,
      nonce: finalNonce,
      idempotency_key: idempotencyKey,
    });
  };

  const sendMultipleFiles = async (files: File[], caption: string) => {
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    setSending(true);
    setUploadProgress(0);
    uploadAbortControllerRef.current = new AbortController();
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Apply caption to the first item
        const itemCaption = i === 0 ? caption : '';
        await sendSingleFile(file, itemCaption);
      }
      await loadMessages();
      setPendingMediaFiles(null);
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        alert(`File upload failed: ${err.message}`);
      }
    } finally {
      isSendingRef.current = false;
      setSending(false);
      setUploadProgress(undefined);
      uploadAbortControllerRef.current = null;
    }
  };

  // Send Round Video Note
  const handleSendRoundVideo = async (videoBlob: Blob) => {
    if (isSendingRef.current) return;
    isSendingRef.current = true;
    setSending(true);
    try {
      const isE2EE = securityMode === 'e2ee_active';
      const filename = `video_note_${Date.now()}.webm`;
      let att: any;
      let keyBase64 = '';
      let ivBase64 = '';

      if (isE2EE) {
        const encryptedVideo = await signalManager.encryptAttachment(videoBlob);
        att = await api.uploadAttachment(conversation.id, encryptedVideo.encryptedBlob, filename, true);
        keyBase64 = encryptedVideo.keyBase64;
        ivBase64 = encryptedVideo.ivBase64;
      } else {
        // Normal Chat: Upload raw video directly
        att = await api.uploadAttachment(conversation.id, videoBlob, filename, false);
      }

      const payload: ParsedMessagePayload = {
        text: 'Video Note',
        type: 'video_note',
        attachment: {
          id: att.id,
          filename,
          contentType: 'video/webm',
          sizeBytes: videoBlob.size,
          keyBase64,
          ivBase64,
          isRoundVideo: true,
        },
      };

      const payloadStr = JSON.stringify(payload);
      let finalCiphertext = payloadStr;
      let finalNonce = 'normal';

      if (isE2EE) {
        const targets = await getEncryptionTargets();
        const token = api.getToken() || undefined;
        const encryptedMsg = await signalManager.encryptMultiDevice(payloadStr, targets, conversation.id, token);
        finalCiphertext = encryptedMsg.ciphertext;
        finalNonce = encryptedMsg.nonce;
      }

      const idempotencyKey = 'idemp_video_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
      await api.submitMessage(conversation.id, {
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        idempotency_key: idempotencyKey,
      });

      setShowRoundVideoRecorder(false);
      await loadMessages();
    } catch (err: any) {
      alert(`Failed to send video note: ${err.message}`);
    } finally {
      isSendingRef.current = false;
      setSending(false);
    }
  };

  // Client-Side Decrypt and Download Attachment (Telegram-style secure download)
  const handleDownloadAttachment = async (attMeta: any) => {
    if (!attMeta?.id) return;
    setDownloadingAttId(attMeta.id);
    try {
      const blob = await api.downloadAttachment(attMeta.id);
      let finalBlob = blob;
      if (attMeta.keyBase64 && attMeta.ivBase64) {
        finalBlob = await signalManager.decryptAttachment(
          blob,
          attMeta.keyBase64,
          attMeta.ivBase64,
          attMeta.contentType
        );
      }

      let filename = attMeta.filename;
      if (!filename) {
        if (attMeta.isVoice) filename = `voice_note_${Date.now()}.webm`;
        else if (attMeta.isRoundVideo) filename = `video_note_${Date.now()}.mp4`;
        else if (attMeta.isPhoto) filename = `photo_${Date.now()}.jpg`;
        else if (attMeta.isVideo) filename = `video_${Date.now()}.mp4`;
        else filename = `attachment_${Date.now()}.bin`;
      }

      const url = URL.createObjectURL(finalBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e: any) {
      alert(`Decryption/download error: ${e.message}`);
    } finally {
      setDownloadingAttId(null);
    }
  };

  // Get or Load Decrypted Media Blob URL
  const getOrLoadDecryptedUrl = async (msgId: string, attMeta: any): Promise<string | undefined> => {
    if (decryptedMediaUrls[msgId]) return decryptedMediaUrls[msgId];
    if (attMeta?.id) {
      setDownloadingAttId(attMeta.id);
    }
    try {
      const blob = await api.downloadAttachment(attMeta.id);
      let finalBlob = blob;
      if (attMeta.keyBase64 && attMeta.ivBase64) {
        finalBlob = await signalManager.decryptAttachment(
          blob,
          attMeta.keyBase64,
          attMeta.ivBase64,
          attMeta.contentType
        );
      }
      const url = URL.createObjectURL(finalBlob);
      setDecryptedMediaUrls((prev) => ({ ...prev, [msgId]: url }));
      return url;
    } catch (e) {
      console.warn('Failed to decrypt media:', e);
      return undefined;
    } finally {
      setDownloadingAttId(null);
    }
  };

  // Fullscreen Media Lightbox Gallery Navigation
  const handleOpenLightbox = async (msg: Message) => {
    let url = decryptedMediaUrls[msg.id];
    if (!url && msg.attachmentMeta) {
      url = (await getOrLoadDecryptedUrl(msg.id, msg.attachmentMeta)) || '';
    }
    const mediaMsgs = messages.filter(
      (m) => m.attachmentMeta?.isPhoto || m.attachmentMeta?.isVideo || m.attachmentMeta?.isRoundVideo
    );
    const idx = mediaMsgs.findIndex((m) => m.id === msg.id);

    setLightboxMedia({
      id: msg.id,
      url: url || '',
      type: msg.attachmentMeta?.isVideo || msg.attachmentMeta?.isRoundVideo ? 'video' : 'photo',
      filename: msg.attachmentMeta?.filename,
      senderName: msg.sender_username,
      date: new Date(msg.created_at).toLocaleString(),
      caption: msg.attachmentMeta?.caption,
      currentIndex: idx >= 0 ? idx : 0,
      totalCount: mediaMsgs.length,
    });
  };

  const handleLightboxPrev = async () => {
    if (!lightboxMedia) return;
    const mediaMsgs = messages.filter(
      (m) => m.attachmentMeta?.isPhoto || m.attachmentMeta?.isVideo || m.attachmentMeta?.isRoundVideo
    );
    const curIdx = mediaMsgs.findIndex((m) => m.id === lightboxMedia.id);
    if (curIdx > 0) {
      const prevMsg = mediaMsgs[curIdx - 1];
      let url = decryptedMediaUrls[prevMsg.id];
      if (!url && prevMsg.attachmentMeta) {
        url = (await getOrLoadDecryptedUrl(prevMsg.id, prevMsg.attachmentMeta)) || '';
      }
      setLightboxMedia({
        id: prevMsg.id,
        url: url || '',
        type: prevMsg.attachmentMeta?.isVideo || prevMsg.attachmentMeta?.isRoundVideo ? 'video' : 'photo',
        filename: prevMsg.attachmentMeta?.filename,
        senderName: prevMsg.sender_username,
        date: new Date(prevMsg.created_at).toLocaleString(),
        caption: prevMsg.attachmentMeta?.caption,
        currentIndex: curIdx - 1,
        totalCount: mediaMsgs.length,
      });
    }
  };

  const handleLightboxNext = async () => {
    if (!lightboxMedia) return;
    const mediaMsgs = messages.filter(
      (m) => m.attachmentMeta?.isPhoto || m.attachmentMeta?.isVideo || m.attachmentMeta?.isRoundVideo
    );
    const curIdx = mediaMsgs.findIndex((m) => m.id === lightboxMedia.id);
    if (curIdx >= 0 && curIdx < mediaMsgs.length - 1) {
      const nextMsg = mediaMsgs[curIdx + 1];
      let url = decryptedMediaUrls[nextMsg.id];
      if (!url && nextMsg.attachmentMeta) {
        url = (await getOrLoadDecryptedUrl(nextMsg.id, nextMsg.attachmentMeta)) || '';
      }
      setLightboxMedia({
        id: nextMsg.id,
        url: url || '',
        type: nextMsg.attachmentMeta?.isVideo || nextMsg.attachmentMeta?.isRoundVideo ? 'video' : 'photo',
        filename: nextMsg.attachmentMeta?.filename,
        senderName: nextMsg.sender_username,
        date: new Date(nextMsg.created_at).toLocaleString(),
        caption: nextMsg.attachmentMeta?.caption,
        currentIndex: curIdx + 1,
        totalCount: mediaMsgs.length,
      });
    }
  };

  // Context Menu & Message Action Handlers
  const handleCopyLink = (msg: Message) => {
    const url = `${window.location.origin}${window.location.pathname}#msg-${msg.id}`;
    navigator.clipboard.writeText(url);
    setCopiedMsgId(msg.id);
    setTimeout(() => setCopiedMsgId(null), 2000);
  };

  const handleDeleteForMe = async (msg: Message) => {
    try {
      await api.deleteMessage(conversation.id, msg.id, 'me');
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    } catch (e: any) {
      alert(`Delete for me failed: ${e.message}`);
    }
  };

  const handleDeleteForEveryone = async (msg: Message) => {
    try {
      await api.deleteMessage(conversation.id, msg.id, 'everyone');
      setMessages((prev) =>
        prev.map((m) => (m.id === msg.id ? { ...m, is_deleted: true, plaintext: t.deleted_message } : m))
      );
    } catch (e: any) {
      alert(`Delete for everyone failed: ${e.message}`);
    }
  };

  const handleSaveToSavedMessages = async (msg: Message) => {
    try {
      const res = await api.listConversations();
      const convs = res.conversations;
      let savedConv = convs.find(
        (c: Conversation) => c.type === 'saved' || (c.type === 'direct' && c.participants?.every((p: User) => p.id === currentUser.id))
      );
      if (!savedConv) {
        savedConv = await api.createDirectConversation(currentUser.id);
      }
      const textToSave = msg.plaintext || msg.ciphertext;
      const idempotencyKey = 'idemp_saved_' + msg.id + '_' + Date.now();
      await api.submitMessage(savedConv.id, {
        ciphertext: textToSave,
        nonce: 'normal',
        idempotency_key: idempotencyKey,
      });
      alert('Saved to Saved Messages');
    } catch (err: any) {
      console.error('Failed to save message:', err);
      alert('Failed to save message: ' + err.message);
    }
  };

  const handleBulkCopy = () => {
    const selectedMsgs = messages.filter((m) => selectedMsgIds.has(m.id));
    const fullText = selectedMsgs
      .map((m) => m.plaintext || m.attachmentMeta?.filename || m.ciphertext || '')
      .join('\n\n');
    navigator.clipboard.writeText(fullText);
    setSelectionMode(false);
    setSelectedMsgIds(new Set());
    alert(`Copied ${selectedMsgs.length} messages`);
  };

  const handleBulkSaveToSaved = async () => {
    const selectedMsgs = messages.filter((m) => selectedMsgIds.has(m.id));
    try {
      const res = await api.listConversations();
      const convs = res.conversations;
      let savedConv = convs.find(
        (c: Conversation) => c.type === 'saved' || (c.type === 'direct' && c.participants?.every((p: User) => p.id === currentUser.id))
      );
      if (!savedConv) {
        savedConv = await api.createDirectConversation(currentUser.id);
      }
      for (const msg of selectedMsgs) {
        const idempotencyKey = 'idemp_saved_' + msg.id + '_' + Date.now();
        await api.submitMessage(savedConv.id, {
          ciphertext: msg.plaintext || msg.ciphertext,
          nonce: 'normal',
          idempotency_key: idempotencyKey,
        });
      }
      alert(`Saved ${selectedMsgs.length} messages to Saved Messages`);
    } catch (err: any) {
      alert('Failed to save messages: ' + err.message);
    } finally {
      setSelectionMode(false);
      setSelectedMsgIds(new Set());
    }
  };

  // Voice Note Recording Pipeline with live audio waveform analysis
  const startVoiceRecording = async () => {
    try {
      const stream = await mediaDeviceManager.getAudioStream();
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioContextClass) {
          const audioCtx = new AudioContextClass();
          audioContextRef.current = audioCtx;
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 32;
          source.connect(analyser);
          analyserRef.current = analyser;

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          const updateLevels = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(dataArray);
            const levels: number[] = [];
            for (let i = 0; i < 8; i++) {
              const val = dataArray[i * 2] || 0;
              levels.push(Math.max(10, Math.min(100, (val / 255) * 100)));
            }
            setAudioLevels(levels);
            animFrameRef.current = requestAnimationFrame(updateLevels);
          };
          animFrameRef.current = requestAnimationFrame(updateLevels);
        }
      } catch (e) {
        console.warn('AudioContext analyser unavailable:', e);
      }

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);

      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((prev) => prev + 1);
      }, 1000);
    } catch (e: any) {
      alert(`Microphone permission denied or not supported: ${e.message}`);
    }
  };

  const stopVoiceRecording = async (shouldSend: boolean) => {
    if (!mediaRecorderRef.current) return;

    clearInterval(recordingTimerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    setIsRecording(false);

    mediaRecorderRef.current.onstop = async () => {
      if (!shouldSend) {
        audioChunksRef.current = [];
        return;
      }

      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      audioChunksRef.current = [];

      if (isSendingRef.current) return;
      isSendingRef.current = true;
      setSending(true);
      try {
        const isE2EE = securityMode === 'e2ee_active';
        let att: any;
        let attachmentMeta: any;
        const filename = `voice_${Date.now()}.webm`;

        if (isE2EE) {
          const encryptedVoice = await signalManager.encryptAttachment(audioBlob);
          att = await api.uploadAttachment(conversation.id, encryptedVoice.encryptedBlob, filename, true);
          attachmentMeta = {
            id: att.id,
            filename,
            contentType: 'audio/webm',
            sizeBytes: audioBlob.size,
            keyBase64: encryptedVoice.keyBase64,
            ivBase64: encryptedVoice.ivBase64,
            isVoice: true,
          };
        } else {
          att = await api.uploadAttachment(conversation.id, audioBlob, filename, false);
          attachmentMeta = {
            id: att.id,
            filename,
            contentType: 'audio/webm',
            sizeBytes: audioBlob.size,
            isVoice: true,
          };
        }

        const payload: ParsedMessagePayload = {
          text: t.voice_message,
          type: 'voice',
          attachment: attachmentMeta,
        };

        const idempotencyKey = 'idemp_voice_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        if (isE2EE) {
          const targets = await getEncryptionTargets();
          const token = api.getToken() || undefined;
          const encryptedMsg = await signalManager.encryptMultiDevice(JSON.stringify(payload), targets, conversation.id, token);
          await api.submitMessage(conversation.id, {
            ciphertext: encryptedMsg.ciphertext,
            nonce: encryptedMsg.nonce,
            idempotency_key: idempotencyKey,
          });
        } else {
          await api.submitMessage(conversation.id, {
            ciphertext: JSON.stringify(payload),
            nonce: 'normal',
            idempotency_key: idempotencyKey,
          });
        }

        await loadMessages();
      } catch (err: any) {
        alert(`Failed to send voice note: ${err.message}`);
      } finally {
        isSendingRef.current = false;
        setSending(false);
      }
    };

    mediaRecorderRef.current.stop();
    mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
  };

  const handlePlayVoice = async (msgId: string, attMeta: any) => {
    if (playingAudioId === msgId) {
      audioPlayerRef.current?.pause();
      setPlayingAudioId(null);
      return;
    }

    try {
      const rawBlob = await api.downloadAttachment(attMeta.id);
      let playableBlob = rawBlob;
      if (attMeta.keyBase64 && attMeta.ivBase64) {
        playableBlob = await signalManager.decryptAttachment(
          rawBlob,
          attMeta.keyBase64,
          attMeta.ivBase64,
          'audio/webm'
        );
      }
      const url = URL.createObjectURL(playableBlob);

      if (audioPlayerRef.current) {
        audioPlayerRef.current.pause();
      }

      const audio = new Audio(url);
      await mediaDeviceManager.applyAudioOutput(audio);
      audioPlayerRef.current = audio;
      audio.onended = () => setPlayingAudioId(null);
      audio.play();
      setPlayingAudioId(msgId);
    } catch (e: any) {
      alert(`Failed to play voice message: ${e.message}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const el = textareaRef.current;
    const isMod = e.ctrlKey || e.metaKey;

    if (isMod && el) {
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        const res = applyFormatting(el, 'bold');
        setInput(res.newText);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(res.newStart, res.newEnd);
        }, 10);
        return;
      }
      if (key === 'i') {
        e.preventDefault();
        const res = applyFormatting(el, 'italic');
        setInput(res.newText);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(res.newStart, res.newEnd);
        }, 10);
        return;
      }
      if (key === 'u') {
        e.preventDefault();
        const res = applyFormatting(el, 'underline');
        setInput(res.newText);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(res.newStart, res.newEnd);
        }, 10);
        return;
      }
      if (e.shiftKey && (key === 'x' || key === 's')) {
        e.preventDefault();
        const res = applyFormatting(el, 'strike');
        setInput(res.newText);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(res.newStart, res.newEnd);
        }, 10);
        return;
      }
      if (key === 'k') {
        e.preventDefault();
        setShowFormattingToolbar(true);
        return;
      }
      if (e.shiftKey && key === 'p') {
        e.preventDefault();
        const res = applyFormatting(el, 'spoiler');
        setInput(res.newText);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(res.newStart, res.newEnd);
        }, 10);
        return;
      }
      if (e.shiftKey && key === 'q') {
        e.preventDefault();
        const res = applyFormatting(el, 'quote');
        setInput(res.newText);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(res.newStart, res.newEnd);
        }, 10);
        return;
      }
      if (key === '`' || (e.shiftKey && key === 'm')) {
        e.preventDefault();
        const res = applyFormatting(el, 'code');
        setInput(res.newText);
        setTimeout(() => {
          el.focus();
          el.setSelectionRange(res.newStart, res.newEnd);
        }, 10);
        return;
      }
    }

    if (e.key === 'Escape') {
      if (showFormattingToolbar) {
        setShowFormattingToolbar(false);
        return;
      }
      if (editingMessage) {
        setEditingMessage(null);
        setInput('');
        return;
      }
      if (replyingTo) {
        setReplyingTo(null);
        return;
      }
    }

    const settings = loadSettings();
    if (settings.sendOnEnter) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
      }
    } else {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSendMessage();
      }
    }
  };

  // Find pinned message in messages list
  const pinnedMessage = messages.find((m) => m.is_pinned);

  // Filter messages for search query
  const displayedMessages = chatSearchQuery.trim()
    ? messages.filter((m) =>
        m.plaintext?.toLowerCase().includes(chatSearchQuery.toLowerCase())
      )
    : messages;

  return (
    <div
      className="flex-1 flex flex-col h-full bg-[#0e1621] relative select-text text-white"
      onDragEnter={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current += 1;
        if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
          setIsDraggingOver(true);
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        e.stopPropagation();
        dragCounterRef.current -= 1;
        if (dragCounterRef.current <= 0) {
          setIsDraggingOver(false);
          dragCounterRef.current = 0;
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingOver(false);
        dragCounterRef.current = 0;
        const droppedFiles = Array.from(e.dataTransfer.files || []);
        if (droppedFiles.length > 0) {
          prepareFilesForSending(droppedFiles);
        }
      }}
    >
      {/* Drag & Drop Visual Overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 bg-[#17212b]/90 border-2 border-dashed border-[#24A1DE] flex flex-col items-center justify-center pointer-events-none backdrop-blur-sm animate-fadeIn">
          <div className="h-16 w-16 rounded-full bg-[#24A1DE]/20 text-[#24A1DE] flex items-center justify-center mb-3">
            <UploadCloud className="h-8 w-8 animate-bounce" />
          </div>
          <p className="text-base font-bold text-white">
            {lang === 'fa' ? 'فایل‌ها را اینجا رها کنید تا ارسال شوند' : 'Drop files here to send'}
          </p>
          <p className="text-xs text-[#7f91a4] mt-1">
            {lang === 'fa' ? 'تصاویر، ویدیوها، صوت‌ها و انواع فایل‌ها' : 'Images, videos, audio, and documents'}
          </p>
        </div>
      )}

      {/* Hidden File Input */}
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileUpload}
        multiple
        className="hidden"
      />

      {/* Chat Header */}
      <header className="h-14 px-4 bg-[#17212b] border-b border-[#101921] flex items-center justify-between select-none z-20">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button
              id="chat-back-btn"
              onClick={onBack}
              aria-label="Back to conversations"
              className="md:hidden p-2 -ml-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white cursor-pointer"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}

          <div
            onClick={() => {
              if (!isGroup && !isChannel && peerUser) {
                setInspectedUser(peerUser);
              } else {
                setShowChatInfoModal(true);
              }
            }}
            className="flex items-center gap-3 min-w-0 cursor-pointer hover:opacity-90 transition"
            title={!isGroup && !isChannel && peerUser ? "View User Profile" : "View Chat Details"}
          >
            <div
              className={`h-10 w-10 rounded-full flex items-center justify-center font-bold text-white shadow-sm flex-shrink-0 overflow-hidden ${
                isSaved
                  ? 'bg-[#24A1DE]'
                  : isChannel
                  ? 'bg-gradient-to-tr from-purple-500 to-indigo-500'
                  : isGroup
                  ? 'bg-gradient-to-tr from-amber-500 to-orange-500'
                  : 'bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa]'
              }`}
            >
              {isSaved ? (
                <Bookmark className="h-5 w-5 text-white" />
              ) : activeAvatarUrl ? (
                <img
                  src={activeAvatarUrl}
                  alt={chatTitle}
                  className="h-full w-full object-cover"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              ) : isChannel ? (
                <Megaphone className="h-5 w-5 text-white" />
              ) : isGroup ? (
                <Users className="h-5 w-5 text-white" />
              ) : (
                chatTitle.charAt(0).toUpperCase()
              )}
            </div>

            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-white leading-tight truncate flex items-center gap-1.5">
                <span>{chatTitle}</span>
                {myRole && (
                  <span className="text-[10px] font-normal px-1.5 py-0.2 rounded bg-[#24A1DE]/20 text-[#24A1DE] capitalize">
                    {myRole}
                  </span>
                )}
              </h2>
              <div className="flex items-center gap-1.5 text-[11px] text-[#7f91a4]">
                {isSaved ? (
                  <span>{lang === 'fa' ? 'فضای ابری شخصی' : 'Personal cloud storage'}</span>
                ) : isChannel ? (
                  <span>{conversation.participants ? `${conversation.participants.length} subscribers` : 'Channel • Broadcast'}</span>
                ) : isGroup ? (
                  <span>Group • {conversation.participants?.length || conversationMembers.length || 2} members</span>
                ) : peerTyping ? (
                  <span className="text-[#24A1DE] font-semibold animate-pulse">typing...</span>
                ) : peerPresence.isOnline ? (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    <span className="text-emerald-400">{peerPresence.formattedLastSeen}</span>
                  </>
                ) : (
                  <span>{peerPresence.formattedLastSeen}</span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Header Right Actions: Calls, Shared Media, Selection, Search & E2EE Badge */}
        {/* Desktop View (md:flex) */}
        <div className="hidden md:flex items-center gap-1 flex-shrink-0">
          {!isChannel && peerUser && (
            <>
              <button
                type="button"
                onClick={() =>
                  webrtcManager.startCall(
                    conversation.id,
                    peerUser.id,
                    peerUser.display_name || peerUser.username,
                    'audio'
                  )
                }
                className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-emerald-400 transition cursor-pointer"
                title="Voice Call"
              >
                <Phone className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() =>
                  webrtcManager.startCall(
                    conversation.id,
                    peerUser.id,
                    peerUser.display_name || peerUser.username,
                    'video'
                  )
                }
                className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-[#24A1DE] transition cursor-pointer"
                title="Video Call"
              >
                <Video className="h-4 w-4" />
              </button>
            </>
          )}

          {/* Shared Media Drawer Button */}
          <button
            id="shared-media-btn"
            type="button"
            onClick={() => setShowSharedMedia(true)}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-[#24A1DE] transition cursor-pointer"
            title="Shared Media & Files"
          >
            <Folder className="h-4 w-4" />
          </button>

          {/* Multi-Select Messages Toggle */}
          <button
            id="select-messages-btn"
            type="button"
            onClick={() => {
              setSelectionMode(!selectionMode);
              setSelectedMsgIds(new Set());
            }}
            className={`p-2 rounded-lg transition cursor-pointer ${
              selectionMode
                ? 'bg-[#24A1DE] text-white'
                : 'hover:bg-[#202b36] text-[#7f91a4] hover:text-white'
            }`}
            title="Select Messages"
          >
            <CheckSquare className="h-4 w-4" />
          </button>

          <button
            id="search-chat-btn"
            onClick={() => setShowSearch(!showSearch)}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
            title="Search in chat"
          >
            <Search className="h-4 w-4" />
          </button>

          {/* Group Voice Chat Button */}
          {isGroup && (
            <button
              type="button"
              onClick={() => setShowVoiceChatModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 transition text-xs font-semibold text-emerald-400 cursor-pointer"
              title="Group Voice Chat"
            >
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              <span className="hidden sm:inline">Voice Chat</span>
            </button>
          )}

          {/* Chat / User Profile Info Modal Button */}
          <button
            type="button"
            onClick={() => {
              if (!isGroup && !isChannel && peerUser) {
                setInspectedUser(peerUser);
              } else {
                setShowChatInfoModal(true);
              }
            }}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
            title={!isGroup && !isChannel && peerUser ? "User Profile" : "Chat Info"}
          >
            <Info className="h-4 w-4" />
          </button>

          {/* Security Mode Badge */}
          {securityMode === 'e2ee_active' ? (
            <button
              onClick={() => setShowSecurityModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/20 transition text-xs font-semibold text-emerald-400 cursor-pointer"
              title="End-to-End Encrypted (Signal Protocol)"
            >
              <Lock className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">E2EE Chat</span>
            </button>
          ) : (
            <button
              onClick={() => setShowModeModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/20 transition text-xs font-medium text-[#24A1DE] cursor-pointer"
              title="Normal Chat (Standard Encryption)"
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Normal Chat</span>
            </button>
          )}

          {/* Delete Chat Button */}
          <button
            onClick={() => setShowDeleteChatModal(true)}
            className="p-2 rounded-lg hover:bg-red-500/10 text-[#7f91a4] hover:text-red-400 transition cursor-pointer"
            title="Delete Chat"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        {/* Mobile View (flex md:hidden) */}
        <div className="flex md:hidden items-center gap-1 flex-shrink-0 relative">
          {!isChannel && peerUser && (
            <button
              type="button"
              onClick={() =>
                webrtcManager.startCall(
                  conversation.id,
                  peerUser.id,
                  peerUser.display_name || peerUser.username,
                  'audio'
                )
              }
              className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-emerald-400 transition cursor-pointer"
              title="Voice Call"
            >
              <Phone className="h-4 w-4" />
            </button>
          )}
          <button
            id="mobile-search-chat-btn"
            onClick={() => setShowSearch(!showSearch)}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
            title="Search in chat"
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            id="chat-mobile-more-btn"
            type="button"
            onClick={() => setShowMobileHeaderMenu(!showMobileHeaderMenu)}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
            title="More actions"
          >
            <MoreVertical className="h-4 w-4" />
          </button>

          {/* Mobile Dropdown Menu */}
          {showMobileHeaderMenu && (
            <div
              id="chat-mobile-header-menu"
              className="absolute right-0 top-11 w-52 bg-[#17212b] border border-[#242f3d] rounded-xl shadow-2xl py-1.5 z-50 animate-fadeIn"
              onClick={() => setShowMobileHeaderMenu(false)}
            >
              <button
                type="button"
                onClick={() => setShowSharedMedia(true)}
                className="w-full px-3 py-2 text-left text-xs text-[#7f91a4] hover:text-white hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
              >
                <Folder className="h-4 w-4 text-[#24A1DE]" />
                <span>Shared Media & Files</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectionMode(!selectionMode);
                  setSelectedMsgIds(new Set());
                }}
                className="w-full px-3 py-2 text-left text-xs text-[#7f91a4] hover:text-white hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
              >
                <CheckSquare className="h-4 w-4 text-[#24A1DE]" />
                <span>{selectionMode ? 'Cancel Selection' : 'Select Messages'}</span>
              </button>
              {isGroup && (
                <button
                  type="button"
                  onClick={() => setShowVoiceChatModal(true)}
                  className="w-full px-3 py-2 text-left text-xs text-emerald-400 hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
                >
                  <Radio className="h-4 w-4" />
                  <span>Group Voice Chat</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowMobileHeaderMenu(false);
                  if (!isGroup && !isChannel && peerUser) {
                    setInspectedUser(peerUser);
                  } else {
                    setShowChatInfoModal(true);
                  }
                }}
                className="w-full px-3 py-2 text-left text-xs text-[#7f91a4] hover:text-white hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
              >
                <Info className="h-4 w-4 text-[#24A1DE]" />
                <span>{!isGroup && !isChannel && peerUser ? "User Profile" : "Chat Info & Details"}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  if (securityMode === 'e2ee_active') setShowSecurityModal(true);
                  else setShowModeModal(true);
                }}
                className="w-full px-3 py-2 text-left text-xs text-[#7f91a4] hover:text-white hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
              >
                {securityMode === 'e2ee_active' ? (
                  <>
                    <Lock className="h-4 w-4 text-emerald-400" />
                    <span className="text-emerald-400 font-medium">Signal E2EE Active</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4 text-[#24A1DE]" />
                    <span className="text-[#24A1DE] font-medium">Normal Mode</span>
                  </>
                )}
              </button>
              <div className="border-t border-[#242f3d] my-1" />
              <button
                type="button"
                onClick={() => setShowDeleteChatModal(true)}
                className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-red-500/10 flex items-center gap-2 cursor-pointer"
              >
                <Trash2 className="h-4 w-4" />
                <span>Delete Conversation</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* In-Chat Search Bar */}
      {showSearch && (
        <div className="bg-[#17212b] px-4 py-2 border-b border-[#242f3d] flex items-center gap-2 animate-fade-in z-10">
          <Search className="h-4 w-4 text-[#7f91a4]" />
          <input
            type="text"
            value={chatSearchQuery}
            onChange={(e) => {
              setChatSearchQuery(e.target.value);
              setSearchMatchIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (displayedMessages.length === 0) return;
                const nextIdx = e.shiftKey
                  ? (searchMatchIndex - 1 + displayedMessages.length) % displayedMessages.length
                  : (searchMatchIndex + 1) % displayedMessages.length;
                setSearchMatchIndex(nextIdx);
                const target = displayedMessages[nextIdx];
                if (target) {
                  document.getElementById(`msg-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              } else if (e.key === 'Escape') {
                setShowSearch(false);
                setChatSearchQuery('');
              }
            }}
            placeholder="Search messages in this chat..."
            className="flex-1 bg-transparent text-xs text-white placeholder-[#7f91a4] focus:outline-none"
            autoFocus
          />
          {chatSearchQuery && (
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] text-[#7f91a4]">
                {displayedMessages.length === 0
                  ? 'No results'
                  : `${searchMatchIndex + 1} of ${displayedMessages.length}`}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (displayedMessages.length === 0) return;
                  const prevIdx = (searchMatchIndex - 1 + displayedMessages.length) % displayedMessages.length;
                  setSearchMatchIndex(prevIdx);
                  const target = displayedMessages[prevIdx];
                  if (target) {
                    document.getElementById(`msg-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                }}
                disabled={displayedMessages.length === 0}
                className="p-1 text-[#7f91a4] hover:text-white disabled:opacity-40 rounded"
                title="Previous result"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (displayedMessages.length === 0) return;
                  const nextIdx = (searchMatchIndex + 1) % displayedMessages.length;
                  setSearchMatchIndex(nextIdx);
                  const target = displayedMessages[nextIdx];
                  if (target) {
                    document.getElementById(`msg-${target.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }
                }}
                disabled={displayedMessages.length === 0}
                className="p-1 text-[#7f91a4] hover:text-white disabled:opacity-40 rounded"
                title="Next result"
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            </div>
          )}
          <button
            onClick={() => {
              setShowSearch(false);
              setChatSearchQuery('');
            }}
            className="p-1 text-[#7f91a4] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Pinned Message Banner */}
      {pinnedMessage && (
        <div
          onClick={() => {
            const el = document.getElementById(`msg-${pinnedMessage.id}`);
            el?.scrollIntoView({ behavior: 'smooth' });
          }}
          className="bg-[#182533] border-b border-[#242f3d] px-4 py-2 flex items-center justify-between text-xs cursor-pointer hover:bg-[#202f40] transition z-10"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Pin className="h-3.5 w-3.5 text-[#24A1DE] flex-shrink-0" />
            <div className="min-w-0">
              <span className="font-semibold text-[#24A1DE] block text-[11px]">{t.pinned_message}</span>
              <p className="text-[#7f91a4] truncate text-xs">{pinnedMessage.plaintext}</p>
            </div>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              handleTogglePin(pinnedMessage);
            }}
            className="p-1 text-[#7f91a4] hover:text-white"
            title={t.unpin}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Security Modal */}
      {showSecurityModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center">
            <div className={`h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 ${
              verificationState === 'verified'
                ? 'bg-emerald-500/20 text-emerald-400'
                : verificationState === 'key_changed'
                ? 'bg-red-500/20 text-red-400'
                : 'bg-blue-500/20 text-blue-400'
            }`}>
              {verificationState === 'verified' ? (
                <ShieldCheck className="h-6 w-6" />
              ) : verificationState === 'key_changed' ? (
                <AlertTriangle className="h-6 w-6" />
              ) : (
                <Lock className="h-6 w-6" />
              )}
            </div>
            <h3 className="text-base font-bold text-white mb-1">
              {verificationState === 'verified'
                ? 'Verified Identity'
                : verificationState === 'key_changed'
                ? 'Identity Key Changed!'
                : t.e2ee_verified}
            </h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">{t.e2ee_desc}</p>

            {safetyNumber && (
              <div className="p-3 rounded-xl bg-[#0e1621] border border-[#242f3d] mb-4 text-left">
                <span className="text-[10px] text-[#24A1DE] font-semibold uppercase tracking-wider block mb-1">
                  Signal Safety Number (Out-of-Band Verification)
                </span>
                <div className="font-mono text-xs tracking-wider font-bold text-emerald-400 select-all break-all bg-[#17212b] p-2 rounded-lg border border-[#242f3d]">
                  {safetyNumber}
                </div>
                <p className="text-[10px] text-[#7f91a4] mt-1.5 leading-normal">
                  Both you and {chatTitle} have the same safety number. Compare in person or over a secure channel to verify zero tampering.
                </p>
              </div>
            )}

            {peerPublicKey && (
              <button
                type="button"
                onClick={toggleVerification}
                className={`w-full mb-3 py-2 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer ${
                  verificationState === 'verified'
                    ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/30'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md'
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                <span>
                  {verificationState === 'verified'
                    ? 'Revoke Verification'
                    : 'Mark as Verified (Confirm Identity)'}
                </span>
              </button>
            )}

            <button
              onClick={() => setShowSecurityModal(false)}
              className="w-full rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] py-2 text-xs font-semibold text-white cursor-pointer transition"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Security Mode Modal (Track A) */}
      {showModeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center">
            <div className="h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 bg-blue-500/20 text-[#24A1DE]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">
              Normal Chat (Standard Security)
            </h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">
              Messages and attachments are transmitted over TLS and encrypted at rest on the server. Server-side message search, history backup, and multi-device synchronization are active.
            </p>

            {!isChannel && !isGroup && peerUser && securityMode !== 'e2ee_active' && (
              <div className="p-3 rounded-xl bg-[#0e1621] border border-[#242f3d] mb-4 text-left">
                <span className="text-[10px] text-emerald-400 font-semibold uppercase tracking-wider block mb-1">
                  Optional End-to-End Encryption
                </span>
                <p className="text-[11px] text-[#7f91a4] mb-3 leading-normal">
                  You can upgrade this chat to Signal Protocol End-to-End Encryption. Only you and {peerUser.display_name || peerUser.username} will be able to read message contents.
                </p>
                <button
                  type="button"
                  onClick={handleActivateE2EE}
                  disabled={activatingE2EE}
                  className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer shadow-md"
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span>{activatingE2EE ? 'Verifying & Activating...' : 'Enable End-to-End Encryption'}</span>
                </button>
              </div>
            )}

            <button
              onClick={() => setShowModeModal(false)}
              className="w-full rounded-xl bg-[#242f3d] hover:bg-[#202b36] py-2 text-xs font-semibold text-white cursor-pointer transition"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Delete Message Modal (Track H) */}
      {deleteTargetMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center">
            <div className="h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 bg-red-500/20 text-red-400">
              <Trash2 className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">Delete Message</h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">
              Select how you would like to delete this message.
            </p>

            <div className="space-y-2 mb-4">
              <button
                type="button"
                onClick={executeDeleteForMe}
                className="w-full py-2.5 px-3 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-semibold transition cursor-pointer"
              >
                Delete for Me
              </button>

              {(deleteTargetMsg.sender_id === currentUser.id || conversation.type === 'channel') && (
                <button
                  type="button"
                  onClick={executeDeleteForEveryone}
                  className="w-full py-2.5 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition cursor-pointer shadow-md"
                >
                  Delete for Everyone
                </button>
              )}
            </div>

            <button
              onClick={() => setDeleteTargetMsg(null)}
              className="text-xs text-[#7f91a4] hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Delete Chat Modal (Track I) */}
      {showDeleteChatModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center">
            <div className="h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 bg-red-500/20 text-red-400">
              <Trash2 className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">Delete Conversation</h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">
              {conversation.type === 'direct'
                ? 'Do you want to delete this chat for yourself only, or permanently for both participants?'
                : 'Clear this conversation history from your personal view?'}
            </p>

            <div className="space-y-2 mb-4">
              <button
                type="button"
                onClick={executeDeleteChatForMe}
                disabled={deletingChat}
                className="w-full py-2.5 px-3 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-semibold transition cursor-pointer"
              >
                Delete Chat for Me
              </button>

              {conversation.type === 'direct' && (
                <button
                  type="button"
                  onClick={executeDeleteChatForBoth}
                  disabled={deletingChat}
                  className="w-full py-2.5 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition cursor-pointer shadow-md"
                >
                  Delete Chat for Both
                </button>
              )}
            </div>

            <button
              onClick={() => setShowDeleteChatModal(false)}
              className="text-xs text-[#7f91a4] hover:text-white transition cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Group Voice Chat Modal (Track B) */}
      {showVoiceChatModal && (
        <GroupVoiceChatModal
          conversation={conversation}
          currentUser={currentUser}
          onClose={() => setShowVoiceChatModal(false)}
        />
      )}

      {/* Message History Area */}
      <div
        className={`flex-1 overflow-y-auto p-4 space-y-2.5 ${
          WALLPAPERS.find((w) => w.id === loadSettings().chatWallpaper)?.previewClass ||
          'bg-[radial-gradient(#17212b_1px,transparent_1px)] [background-size:16px_16px]'
        }`}
      >
        {displayedMessages.map((msg) => {
          if (msg.callEvent) {
            const isVideo = msg.callEvent.call_type === 'video';
            const outcome = msg.callEvent.outcome;
            const duration = msg.callEvent.duration_seconds || 0;

            let callText = '';
            let isMissed = false;
            let isDeclined = false;

            if (outcome === 'completed') {
              const minutes = Math.floor(duration / 60);
              const seconds = duration % 60;
              const durStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;
              if (lang === 'fa') {
                callText = `${isVideo ? 'تماس تصویری' : 'تماس صوتی'} (${durStr})`;
              } else {
                callText = `${isVideo ? 'Video Call' : 'Voice Call'} (${durStr})`;
              }
            } else if (outcome === 'missed') {
              isMissed = true;
              callText = lang === 'fa' ? 'تماس بی‌پاسخ' : 'Missed Call';
            } else if (outcome === 'declined' || outcome === 'rejected') {
              isDeclined = true;
              callText = lang === 'fa' ? 'تماس رد شد' : 'Declined Call';
            } else if (outcome === 'cancelled') {
              callText = lang === 'fa' ? 'تماس لغو شد' : 'Cancelled Call';
            } else {
              callText = lang === 'fa' ? (isVideo ? 'تماس تصویری' : 'تماس صوتی') : (isVideo ? 'Video Call' : 'Voice Call');
            }

            const callTime = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            return (
              <div key={msg.id} id={`msg-${msg.id}`} className="flex justify-center my-3 animate-fadeIn select-none">
                <div className="flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#182533]/90 border border-[#242f3d] text-xs shadow-md backdrop-blur-sm">
                  {isVideo ? (
                    <Video className={`h-4 w-4 ${isMissed || isDeclined ? 'text-rose-400' : 'text-[#24A1DE]'}`} />
                  ) : isMissed || isDeclined ? (
                    <PhoneOff className="h-4 w-4 text-rose-400" />
                  ) : (
                    <Phone className="h-4 w-4 text-emerald-400" />
                  )}
                  <span className={`font-medium ${isMissed || isDeclined ? 'text-rose-400' : 'text-slate-200'}`}>
                    {callText}
                  </span>
                  <span className="text-[10px] text-slate-400 ml-1">
                    {callTime}
                  </span>
                </div>
              </div>
            );
          }

          const isOutgoing = msg.sender_id === currentUser.id;
          const repliedMsg = msg.reply_to_id ? messages.find((m) => m.id === msg.reply_to_id) : undefined;
          const isMsgHovered = activeReactionMsgId === msg.id;
          const isMediaMsg = Boolean(msg.attachmentMeta?.isPhoto || msg.attachmentMeta?.isVideo);

          return (
            <div
              key={msg.id}
              id={`msg-${msg.id}`}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setContextMenuPos({ x: e.clientX, y: e.clientY, message: msg });
              }}
              className={`group flex items-center gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'} animate-fade-in relative`}
            >
              {selectionMode && (
                <button
                  type="button"
                  onClick={() => toggleSelectMessage(msg.id)}
                  className="p-1 text-[#24A1DE] self-center cursor-pointer flex-shrink-0"
                  title="Select Message"
                >
                  {selectedMsgIds.has(msg.id) ? (
                    <CheckSquare className="h-5 w-5 text-[#24A1DE]" />
                  ) : (
                    <Square className="h-5 w-5 text-[#7f91a4]" />
                  )}
                </button>
              )}

              <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'} max-w-[90%] sm:max-w-[75%] md:max-w-[520px] relative`}>
                {/* Message Bubble */}
                <div
                  className={`w-full rounded-2xl relative shadow-md overflow-hidden ${
                        isMediaMsg ? 'p-0' : 'px-3.5 py-2'
                      } ${
                        isOutgoing
                          ? 'bg-[#2b5278] text-white rounded-br-xs'
                          : 'bg-[#182533] text-white rounded-bl-xs'
                      } ${msg.is_pinned ? 'border border-[#24A1DE]/40' : ''}`}
                    >
                  {/* Forwarded Header Banner */}
                  {msg.is_forwarded && (
                    <div className="flex items-center gap-1 text-[11px] text-[#24A1DE] mb-1 italic">
                      <Share2 className="h-3 w-3" />
                      <span>Forwarded{msg.forward_from_name ? ` from ${msg.forward_from_name}` : ''}</span>
                    </div>
                  )}

                  {/* Sender name for group chats */}
                  {(isGroup || isChannel) && !isOutgoing && (
                    <span className="block text-[11px] font-bold text-[#24A1DE] mb-1">
                      {msg.sender_username || 'Participant'}
                    </span>
                  )}

                {/* Quoted Message preview */}
                {repliedMsg && (
                  <div
                    onClick={() => {
                      const el = document.getElementById(`msg-${repliedMsg.id}`);
                      el?.scrollIntoView({ behavior: 'smooth' });
                    }}
                    className="m-2.5 px-3 py-1.5 rounded-xl bg-purple-900/35 border-l-3 border-[#a855f7] flex items-center justify-between gap-2.5 text-left cursor-pointer hover:bg-purple-900/45 transition select-none"
                  >
                    <div className="min-w-0">
                      <span className="block text-[11px] font-bold text-purple-300">
                        {repliedMsg.sender_username || 'Reply'}
                      </span>
                      <span className="block text-xs text-white/90 truncate">
                        {repliedMsg.plaintext || (repliedMsg.attachmentMeta?.isPhoto ? 'Photo' : 'Attachment')}
                      </span>
                    </div>
                  </div>
                )}

                {/* Poll Card, Encrypted Attachment, Sticker, Video Note, Media, Voice, or Text */}
                {msg.poll_id ? (
                  <div className="my-1.5 w-full min-w-[260px] sm:min-w-[320px]">
                    <PollCard
                      pollId={msg.poll_id}
                      conversationId={conversation.id}
                      currentUserId={currentUser.id}
                      isOwnerOrAdmin={myRole === 'owner' || myRole === 'admin' || msg.sender_id === currentUser.id}
                      pollKey={msg.poll_key}
                      pollIv={msg.poll_iv}
                    />
                  </div>
                ) : msg.attachmentMeta ? (
                  <div className="my-1">
                    {msg.attachmentMeta.isSticker ? (
                      /* Sticker */
                      <div className="flex flex-col items-center p-1">
                        <img
                          src={msg.attachmentMeta.stickerUrl}
                          alt="Sticker"
                          className="w-36 h-36 sm:w-44 sm:h-44 object-contain drop-shadow-md select-none transition-transform hover:scale-105"
                          loading="lazy"
                        />
                      </div>
                    ) : msg.attachmentMeta.isRoundVideo ? (
                      /* Circular Video Note (Issue 5) */
                      <div className="flex flex-col items-center p-1">
                        {decryptedMediaUrls[msg.id] ? (
                          <CircularVideoNotePlayer
                            src={decryptedMediaUrls[msg.id]}
                            onDownload={() => handleDownloadAttachment(msg.attachmentMeta)}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => getOrLoadDecryptedUrl(msg.id, msg.attachmentMeta)}
                            className="w-48 h-48 sm:w-56 sm:h-56 rounded-full bg-black/60 hover:bg-black/50 transition text-white border-2 border-[#24A1DE] shadow-xl flex flex-col items-center justify-center cursor-pointer select-none relative overflow-hidden"
                            style={{
                              clipPath: 'circle(50% at 50% 50%)',
                              WebkitClipPath: 'circle(50% at 50% 50%)',
                              borderRadius: '9999px',
                            }}
                          >
                            {downloadingAttId === msg.attachmentMeta.id ? (
                              <div className="h-10 w-10 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                            ) : (
                              <>
                                <Play size={44} className="fill-white" />
                                <span className="text-[10px] text-slate-300 mt-2 font-mono">
                                  {msg.attachmentMeta.sizeBytes
                                    ? msg.attachmentMeta.sizeBytes < 1024 * 1024
                                      ? `${(msg.attachmentMeta.sizeBytes / 1024).toFixed(1)} KB`
                                      : `${(msg.attachmentMeta.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                    : 'Video Note'}
                                </span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    ) : msg.attachmentMeta.isPhoto ? (
                      /* Photo Message (Telegram Card Treatment matching reference image) */
                      <div className="select-none">
                        <div
                          className="relative cursor-pointer group/photo overflow-hidden"
                          onClick={() => handleOpenLightbox(msg)}
                        >
                          {decryptedMediaUrls[msg.id] ? (
                            <div className="relative">
                              <img
                                src={decryptedMediaUrls[msg.id]}
                                alt={msg.attachmentMeta.filename || 'Photo'}
                                className="w-full max-h-[460px] object-cover block hover:opacity-95 transition"
                              />
                              <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 opacity-0 group-hover/photo:opacity-100 transition z-10">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownloadAttachment(msg.attachmentMeta);
                                  }}
                                  className="p-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-white shadow-lg cursor-pointer transition"
                                  title="Download Photo"
                                >
                                  <Download className="h-4 w-4" />
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                getOrLoadDecryptedUrl(msg.id, msg.attachmentMeta);
                              }}
                              className="relative w-full h-64 bg-slate-900/90 overflow-hidden flex flex-col items-center justify-center p-4 transition group/photo-load cursor-pointer select-none"
                            >
                              {msg.attachmentMeta.blurredPreviewBase64 ? (
                                <img
                                  src={msg.attachmentMeta.blurredPreviewBase64}
                                  alt=""
                                  className="absolute inset-0 w-full h-full object-cover filter blur-md scale-110 opacity-70 transition duration-300"
                                />
                              ) : (
                                <div className="absolute inset-0 bg-gradient-to-br from-slate-800 via-slate-900 to-sky-950 opacity-90" />
                              )}
                              <div className="relative z-10 flex flex-col items-center justify-center">
                                <div className="w-14 h-14 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white shadow-xl group-hover/photo-load:scale-105 group-hover/photo-load:bg-[#24A1DE] transition">
                                  {downloadingAttId === msg.attachmentMeta.id ? (
                                    <div className="h-6 w-6 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                                  ) : (
                                    <Download className="h-6 w-6 text-white" />
                                  )}
                                </div>
                                <div className="mt-2.5 px-3 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[11px] font-medium text-white/90 shadow">
                                  {msg.attachmentMeta.sizeBytes
                                    ? msg.attachmentMeta.sizeBytes < 1024 * 1024
                                      ? `${(msg.attachmentMeta.sizeBytes / 1024).toFixed(1)} KB`
                                      : `${(msg.attachmentMeta.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                    : 'Photo'}
                                </div>
                              </div>
                            </button>
                          )}
                        </div>
                        {/* Rich formatted caption directly inside the card */}
                        {(msg.attachmentMeta.caption || msg.plaintext) && (
                          <div dir="auto" className="px-3.5 pt-2.5 pb-1 chat-message-text text-sm leading-relaxed break-words text-white/95">
                            {renderFormattedText(msg.attachmentMeta.caption || msg.plaintext || '')}
                          </div>
                        )}
                      </div>
                    ) : msg.attachmentMeta.isVideo ? (
                      /* Video Message (Telegram Card Treatment matching reference image 2) */
                      <div className="relative group/video select-none">
                        {decryptedMediaUrls[msg.id] ? (
                          <div className="relative overflow-hidden">
                            <video
                              ref={(el) => {
                                if (el) mediaDeviceManager.applyAudioOutput(el);
                              }}
                              src={decryptedMediaUrls[msg.id]}
                              controls
                              className="w-full max-h-[460px] object-contain bg-black block"
                            />
                            {/* Top-left duration & mute badge overlay */}
                            <div className="absolute top-2.5 left-2.5 z-10 pointer-events-none flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-[11px] font-mono text-white shadow-md">
                              <span>
                                {(() => {
                                  const dur = (msg.attachmentMeta as any)?.duration_seconds || (msg.attachmentMeta as any)?.duration;
                                  return dur ? `${Math.floor(dur / 60)}:${(dur % 60).toString().padStart(2, '0')}` : '0:58';
                                })()}
                              </span>
                              <Volume2 className="h-3.5 w-3.5 text-white/90" />
                            </div>
                            <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 opacity-0 group-hover/video:opacity-100 transition z-10">
                              <button
                                type="button"
                                onClick={() => handleOpenLightbox(msg)}
                                className="p-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-white transition shadow-lg cursor-pointer"
                                title="Fullscreen"
                              >
                                <Maximize2 className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadAttachment(msg.attachmentMeta)}
                                className="p-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-white transition shadow-lg cursor-pointer"
                                title="Download Video"
                              >
                                <Download className="h-4 w-4" />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              getOrLoadDecryptedUrl(msg.id, msg.attachmentMeta);
                            }}
                            className="relative w-full h-64 bg-slate-900/90 overflow-hidden flex flex-col items-center justify-center p-4 transition group/video-load cursor-pointer select-none"
                          >
                            {msg.attachmentMeta.blurredPreviewBase64 ? (
                              <img
                                src={msg.attachmentMeta.blurredPreviewBase64}
                                alt=""
                                className="absolute inset-0 w-full h-full object-cover filter blur-md scale-110 opacity-70 transition duration-300"
                              />
                            ) : (
                              <div className="absolute inset-0 bg-gradient-to-br from-slate-800 via-slate-900 to-indigo-950 opacity-90" />
                            )}
                            <div className="relative z-10 flex flex-col items-center justify-center">
                              <div className="w-14 h-14 rounded-full bg-black/60 backdrop-blur-md border border-white/20 flex items-center justify-center text-white shadow-xl group-hover/video-load:scale-105 group-hover/video-load:bg-[#24A1DE] transition">
                                {downloadingAttId === msg.attachmentMeta.id ? (
                                  <div className="h-6 w-6 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                                ) : (
                                  <Play className="h-6 w-6 fill-white text-white ml-0.5" />
                                )}
                              </div>
                              <div className="mt-2.5 px-3 py-0.5 rounded-full bg-black/60 backdrop-blur-md text-[11px] font-medium text-white/90 shadow">
                                {msg.attachmentMeta.sizeBytes
                                  ? msg.attachmentMeta.sizeBytes < 1024 * 1024
                                    ? `${(msg.attachmentMeta.sizeBytes / 1024).toFixed(1)} KB`
                                    : `${(msg.attachmentMeta.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                  : 'Video'}
                              </div>
                            </div>
                          </button>
                        )}
                        {/* Rich formatted caption */}
                        {(msg.attachmentMeta.caption || msg.plaintext) && (
                          <div dir="auto" className="px-3.5 pt-2.5 pb-1 chat-message-text text-sm leading-relaxed break-words text-white/95">
                            {renderFormattedText(msg.attachmentMeta.caption || msg.plaintext || '')}
                          </div>
                        )}
                      </div>
                    ) : msg.attachmentMeta.isVoice ? (
                      /* Waveform Voice Note Player (Issue 8) */
                      <VoiceNotePlayer
                        id={msg.id}
                        src={decryptedMediaUrls[msg.id]}
                        attMeta={msg.attachmentMeta}
                        isPlaying={playingAudioId === msg.id}
                        playbackSpeed={voicePlaybackSpeed}
                        onPlayToggle={async () => {
                          if (playingAudioId === msg.id) {
                            setPlayingAudioId(null);
                          } else {
                            if (!decryptedMediaUrls[msg.id]) {
                              await getOrLoadDecryptedUrl(msg.id, msg.attachmentMeta);
                            }
                            setPlayingAudioId(msg.id);
                          }
                        }}
                        onSpeedCycle={cycleVoiceSpeed}
                        onDownload={() => handleDownloadAttachment(msg.attachmentMeta)}
                      />
                    ) : (
                      /* Enhanced Telegram-style File Attachment Card */
                      <div>
                        <div className="flex items-center gap-3 p-2.5 rounded-xl bg-black/25 hover:bg-black/35 transition border border-white/5">
                          <div className="h-10 w-10 rounded-xl bg-[#24A1DE]/20 text-[#24A1DE] flex flex-col items-center justify-center flex-shrink-0">
                            <FileText className="h-4 w-4" />
                            <span className="text-[8px] uppercase font-bold tracking-wider font-mono">
                              {msg.attachmentMeta.filename?.split('.').pop()?.slice(0, 4) || 'FILE'}
                            </span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-semibold text-white truncate" title={msg.attachmentMeta.filename}>
                              {msg.attachmentMeta.filename}
                            </p>
                            <p className="text-[10px] text-[#7f91a4] mt-0.5">
                              {msg.attachmentMeta.sizeBytes
                                ? msg.attachmentMeta.sizeBytes < 1024 * 1024
                                  ? `${(msg.attachmentMeta.sizeBytes / 1024).toFixed(1)} KB`
                                  : `${(msg.attachmentMeta.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                                : 'File'}
                              {msg.attachmentMeta.keyBase64 ? ' • E2EE Encrypted' : ''}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDownloadAttachment(msg.attachmentMeta)}
                            disabled={downloadingAttId === msg.attachmentMeta.id}
                            className="p-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] disabled:opacity-50 text-white transition flex-shrink-0 cursor-pointer shadow-sm"
                            title="Decrypt & Download"
                          >
                            {downloadingAttId === msg.attachmentMeta.id ? (
                              <div className="h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Download className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                        {msg.attachmentMeta.caption && (
                          <p dir="auto" className="text-xs text-white/95 mt-1.5 px-1 leading-normal break-words">
                            {msg.attachmentMeta.caption}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ) : msg.decryptionError ? (
                  <div className="flex items-center gap-1.5 text-xs text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>{t.error_tampered}</span>
                  </div>
                ) : (
                  <div
                    dir="auto"
                    className={`chat-message-text text-sm leading-relaxed break-words ${
                      msg.is_deleted ? 'italic text-white/50' : ''
                    }`}
                  >
                    {msg.is_deleted
                      ? (msg.plaintext || t.deleted_message)
                      : renderFormattedText(msg.plaintext || msg.ciphertext)}
                  </div>
                )}

                {/* Footer: timestamp, view count, edited badge, delivery ticks */}
                <div className={`flex items-center justify-end gap-1.5 text-[10px] text-white/65 select-none ${
                  Boolean(msg.attachmentMeta?.isPhoto || msg.attachmentMeta?.isVideo) ? 'px-3.5 pb-2 pt-0.5' : 'mt-1'
                }`}>
                  {/* Channel View Count with authentic database view counts */}
                  {(isChannel || conversation.type === 'channel' || (msg.views_count !== undefined && msg.views_count > 0)) && (
                    <span className="inline-flex items-center gap-1 text-white/70 mr-1">
                      <Eye className="h-3 w-3" />
                      <span>{msg.views_count !== undefined && msg.views_count > 0 ? (msg.views_count >= 1000 ? `${(msg.views_count / 1000).toFixed(1)}K` : msg.views_count) : '1'}</span>
                    </span>
                  )}
                  {copiedMsgId === msg.id && (
                    <span className="text-emerald-400 font-bold">{t.copied}</span>
                  )}
                  {msg.edited_at && !msg.is_deleted && (
                    <span className="text-[10px] text-white/50">{t.edited}</span>
                  )}
                  {msg.is_pinned && <Pin className="h-2.5 w-2.5 text-[#24A1DE]" />}
                  <span>
                    {new Date(msg.created_at).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  {isOutgoing && (
                    <span>
                      {msg.status === 'read' || msg.is_read ? (
                        <CheckCheck className="h-3 w-3 text-[#24A1DE]" />
                      ) : msg.status === 'sending' ? (
                        <Clock className="h-3 w-3 text-white/50" />
                      ) : (
                        <Check className="h-3 w-3 text-white/70" />
                      )}
                    </span>
                  )}
                </div>
              </div>

                {/* Emoji Reactions Pills anchored directly under bubble */}
                {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                  <div
                    className={`flex flex-wrap gap-1.5 mt-1 z-10 select-none ${
                      isOutgoing ? 'justify-end self-end' : 'justify-start self-start'
                    }`}
                  >
                    {Object.entries(msg.reactions).map(([emoji, users]) => {
                      const hasMyReaction = users.includes(currentUser.id);
                      return (
                        <button
                          key={emoji}
                          type="button"
                          onClick={() => handleAddReaction(msg.id, emoji)}
                          className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs transition cursor-pointer select-none ${
                            hasMyReaction
                              ? 'bg-[#24A1DE]/30 border border-[#24A1DE] text-white shadow-sm font-semibold'
                              : 'bg-white/10 hover:bg-white/15 text-white/90 border border-white/5 font-medium'
                          }`}
                        >
                          <span className="text-sm">{emoji}</span>
                          <span>{users.length >= 1000 ? `${(users.length / 1000).toFixed(1)}K` : users.length}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Floating Emoji Quick Reaction Picker */}
                {isMsgHovered && (
                  <div
                    className={`absolute -top-9 z-30 flex items-center gap-1 bg-[#17212b] border border-[#242f3d] rounded-2xl px-2 py-1 shadow-2xl animate-fade-in ${
                      isOutgoing ? 'right-0' : 'left-0'
                    }`}
                  >
                    {['👍', '❤️', '🔥', '👏', '🎉', '🚀'].map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          handleAddReaction(msg.id, emoji);
                          setActiveReactionMsgId(null);
                        }}
                        className="text-base hover:scale-125 transition px-1 cursor-pointer"
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}

                {/* Message Context Action Toolbar Below Bubble (Issue 10) */}
                <div
                  className={`mt-1 flex items-center gap-0.5 bg-[#17212b] border border-[#242f3d] rounded-xl px-1.5 py-0.5 shadow-lg text-[#7f91a4] select-none opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity z-10`}
                >
                  {/* Emoji quick reaction trigger */}
                  <button
                    type="button"
                    onClick={() => setActiveReactionMsgId(isMsgHovered ? null : msg.id)}
                    className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                    title="React"
                  >
                    <Smile className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReply(msg)}
                    className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                    title={t.reply}
                  >
                    <CornerUpLeft className="h-3.5 w-3.5" />
                  </button>
                  {/* Forward Message Button */}
                  <button
                    type="button"
                    onClick={() => setForwardingMessages([msg])}
                    className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                    title="Forward"
                  >
                    <Share2 className="h-3.5 w-3.5" />
                  </button>
                  {isOutgoing && !msg.is_deleted && (
                    <button
                      type="button"
                      onClick={() => handleStartEdit(msg)}
                      className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                      title={t.edit}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleTogglePin(msg)}
                    className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                    title={msg.is_pinned ? t.unpin : t.pin}
                  >
                    <Pin className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleCopyText(msg)}
                    className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                    title={t.copy}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                  {!msg.is_deleted && (
                    <button
                      type="button"
                      onClick={() => handleDeleteClick(msg)}
                      className="p-1 hover:text-red-400 hover:bg-red-500/20 rounded-lg transition cursor-pointer"
                      title={t.delete}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {/* 3-dots More Actions Menu trigger */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      const rect = e.currentTarget.getBoundingClientRect();
                      setContextMenuPos({
                        x: rect.left,
                        y: rect.bottom + 5,
                        message: msg,
                      });
                    }}
                    className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                    title="More Actions"
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Message Composer */}
      <div className="p-3 bg-[#17212b] border-t border-[#101921] z-20">
        {/* Reply Preview Banner */}
        {replyingTo && (
          <div className="max-w-4xl mx-auto mb-2 px-3 py-1.5 rounded-xl bg-[#242f3d] border-l-4 border-[#24A1DE] flex items-center justify-between animate-fade-in text-xs">
            <div className="flex items-center gap-2 truncate">
              <CornerUpLeft className="h-3.5 w-3.5 text-[#24A1DE] flex-shrink-0" />
              <div className="truncate">
                <span className="font-bold text-[#24A1DE] block text-[11px]">
                  Replying to {replyingTo.sender_username || 'Participant'}
                </span>
                <span className="text-[#7f91a4] truncate block">{replyingTo.plaintext}</span>
              </div>
            </div>
            <button
              onClick={() => setReplyingTo(null)}
              className="p-1 text-[#7f91a4] hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Edit Preview Banner */}
        {editingMessage && (
          <div className="max-w-4xl mx-auto mb-2 px-3 py-1.5 rounded-xl bg-[#242f3d] border-l-4 border-amber-400 flex items-center justify-between animate-fade-in text-xs">
            <div className="flex items-center gap-2 truncate">
              <Pencil className="h-3.5 w-3.5 text-amber-400 flex-shrink-0" />
              <div className="truncate">
                <span className="font-bold text-amber-400 block text-[11px]">Editing Message</span>
                <span className="text-[#7f91a4] truncate block">{editingMessage.plaintext}</span>
              </div>
            </div>
            <button
              onClick={() => {
                setEditingMessage(null);
                setInput('');
              }}
              className="p-1 text-[#7f91a4] hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        {/* Floating Formatting Toolbar */}
        {showFormattingToolbar && (
          <div className="max-w-4xl mx-auto mb-2 flex justify-start">
            <FormattingToolbar
              textareaRef={textareaRef}
              onApply={(newText) => {
                setInput(newText);
                if (newText.trim()) {
                  localStorage.setItem('nexachat_draft_' + conversation.id, newText);
                } else {
                  localStorage.removeItem('nexachat_draft_' + conversation.id);
                }
              }}
              onClose={() => setShowFormattingToolbar(false)}
            />
          </div>
        )}

        {/* Floating Bulk Action Bar */}
        {selectionMode && (
          <div className="max-w-4xl mx-auto mb-2 px-4 py-2 rounded-2xl bg-[#182533] border border-[#242f3d] flex items-center justify-between shadow-2xl animate-fade-in text-xs">
            <span className="font-semibold text-white">
              {selectedMsgIds.size} message{selectedMsgIds.size === 1 ? '' : 's'} selected
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleBulkCopy}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-white font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>Copy</span>
              </button>
              <button
                type="button"
                onClick={handleBulkSaveToSaved}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-[#24A1DE] font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Bookmark className="h-3.5 w-3.5" />
                <span>Save</span>
              </button>
              <button
                type="button"
                onClick={handleBulkForward}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Share2 className="h-3.5 w-3.5" />
                <span>Forward</span>
              </button>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectionMode(false);
                  setSelectedMsgIds(new Set());
                }}
                className="px-2.5 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Voice Recording Active Bar with live audio waveform bars */}
        {isRecording ? (
          <div className="max-w-4xl mx-auto flex items-center justify-between bg-red-950/80 border border-red-800 rounded-2xl px-4 py-2.5 animate-pulse">
            <div className="flex items-center gap-3">
              <span className="h-3 w-3 rounded-full bg-red-500 animate-ping" />
              <span className="text-xs font-semibold text-red-300">
                {t.recording} {recordingSeconds}s
              </span>
              {/* Live Audio Waveform Bars */}
              <div className="flex items-center gap-1 h-5 px-2">
                {audioLevels.map((lvl, idx) => (
                  <div
                    key={idx}
                    className="w-1 bg-red-400 rounded-full transition-all duration-75"
                    style={{ height: `${Math.max(4, (lvl / 100) * 20)}px` }}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => stopVoiceRecording(false)}
                className="px-3 py-1 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-xs font-semibold text-white transition cursor-pointer"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                onClick={() => stopVoiceRecording(true)}
                className="px-3 py-1 rounded-xl bg-red-600 hover:bg-red-500 text-xs font-bold text-white transition cursor-pointer flex items-center gap-1.5 shadow-md"
              >
                <Send className="h-3.5 w-3.5" />
                <span>Send Voice</span>
              </button>
            </div>
          </div>
        ) : (
          /* Normal Composer */
          <div className="flex flex-col max-w-4xl mx-auto relative w-full">
            {/* Mobile Tools Quick Tray (when toggled on mobile) */}
            {showMobileToolsTray && (
              <div
                id="mobile-tools-tray"
                className="sm:hidden flex items-center justify-between gap-1.5 px-3 py-2 bg-[#17212b] border border-[#242f3d] rounded-xl mb-1.5 shadow-xl animate-fadeIn"
              >
                <button
                  id="round-video-btn-mobile"
                  type="button"
                  onClick={() => {
                    setShowRoundVideoRecorder(true);
                    setShowMobileToolsTray(false);
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-[#202b36] text-[11px] font-medium text-[#7f91a4] hover:text-[#24A1DE] cursor-pointer"
                >
                  <Film className="h-3.5 w-3.5 text-[#24A1DE]" />
                  <span>Video Note</span>
                </button>
                <button
                  id="silent-send-btn-mobile"
                  type="button"
                  onClick={() => {
                    setIsSilentSend(!isSilentSend);
                    setShowMobileToolsTray(false);
                  }}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-medium cursor-pointer ${
                    isSilentSend ? 'bg-amber-400/20 text-amber-300' : 'bg-[#202b36] text-[#7f91a4]'
                  }`}
                >
                  <BellOff className="h-3.5 w-3.5" />
                  <span>{isSilentSend ? 'Silent ON' : 'Silent'}</span>
                </button>
                <button
                  id="schedule-msg-btn-mobile"
                  type="button"
                  onClick={() => {
                    setShowScheduleModal(true);
                    setShowMobileToolsTray(false);
                  }}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-[#202b36] text-[11px] font-medium text-[#7f91a4] hover:text-[#24A1DE] cursor-pointer"
                >
                  <Clock className="h-3.5 w-3.5 text-[#24A1DE]" />
                  <span>Schedule</span>
                </button>
              </div>
            )}

            {/* Clean Telegram Desktop Composer Layout */}
            <div className="flex items-end gap-2 w-full relative">
              {/* Attachment Button with Popover Menu */}
              <div className="relative flex-shrink-0" ref={attachMenuRef}>
                <button
                  id="attach-file-btn"
                  type="button"
                  onClick={() => setShowAttachMenu(!showAttachMenu)}
                  className={`p-2.5 rounded-full transition cursor-pointer ${
                    showAttachMenu
                      ? 'text-[#24A1DE] bg-[#24A1DE]/15'
                      : 'text-[#7f91a4] hover:text-white hover:bg-[#202b36]'
                  }`}
                  title={t.attach_file}
                >
                  <Paperclip className="h-5 w-5" />
                </button>

                {/* Elegant Attachment Popover Menu */}
                {showAttachMenu && (
                  <div
                    className="absolute bottom-full left-0 mb-3 w-56 bg-[#17212b] border border-[#242f3d] rounded-2xl p-1.5 shadow-2xl z-50 animate-in fade-in slide-in-from-bottom-2 duration-150 flex flex-col gap-0.5 text-xs select-none"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        fileInputRef.current?.click();
                        setShowAttachMenu(false);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-blue-500/15 text-blue-400 flex items-center justify-center flex-shrink-0">
                        <Paperclip className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">Photo or File</span>
                        <span className="text-[10px] text-slate-400">Send media or documents</span>
                      </div>
                    </button>

                    <button
                      id="create-poll-btn"
                      type="button"
                      onClick={() => {
                        setShowCreatePollModal(true);
                        setShowAttachMenu(false);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center flex-shrink-0">
                        <BarChart2 className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">Poll or Quiz</span>
                        <span className="text-[10px] text-slate-400">Create interactive vote</span>
                      </div>
                    </button>

                    <button
                      id="round-video-btn"
                      type="button"
                      onClick={() => {
                        setShowRoundVideoRecorder(true);
                        setShowAttachMenu(false);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center flex-shrink-0">
                        <Film className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">Video Note</span>
                        <span className="text-[10px] text-slate-400">Record circular video</span>
                      </div>
                    </button>

                    <button
                      id="schedule-msg-btn"
                      type="button"
                      onClick={() => {
                        setShowScheduleModal(true);
                        setShowAttachMenu(false);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center flex-shrink-0">
                        <Clock className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">Schedule Message</span>
                        <span className="text-[10px] text-slate-400">Send at scheduled time</span>
                      </div>
                    </button>

                    <button
                      id="silent-send-btn"
                      type="button"
                      onClick={() => {
                        setIsSilentSend(!isSilentSend);
                        setShowAttachMenu(false);
                      }}
                      className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-xl transition cursor-pointer text-left ${
                        isSilentSend ? 'bg-amber-400/20 text-amber-300' : 'text-slate-200 hover:text-white hover:bg-[#202b36]'
                      }`}
                    >
                      <div className="h-7 w-7 rounded-lg bg-orange-500/15 text-orange-400 flex items-center justify-center flex-shrink-0">
                        <BellOff className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">{isSilentSend ? 'Silent Send (Active)' : 'Send Silently'}</span>
                        <span className="text-[10px] text-slate-400">No notification sound</span>
                      </div>
                    </button>
                  </div>
                )}
              </div>

              {/* Main Input Capsule (Receives 85%+ of horizontal space) */}
              <div className="flex-1 min-w-0 rounded-2xl bg-[#242f3d] px-3.5 py-1.5 flex items-center gap-1.5 focus-within:ring-1 focus-within:ring-[#24A1DE]/40 transition relative">
                <textarea
                  id="message-input-textarea"
                  dir="auto"
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    const val = e.target.value;
                    setInput(val);
                    if (val.trim()) {
                      localStorage.setItem('nexachat_draft_' + conversation.id, val);
                    } else {
                      localStorage.removeItem('nexachat_draft_' + conversation.id);
                    }
                    clearTimeout(typingDebounceRef.current);
                    wsManager.sendTyping(conversation.id, true);
                    typingDebounceRef.current = setTimeout(() => {
                      wsManager.sendTyping(conversation.id, false);
                    }, 2500);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={isSilentSend ? 'Silent message...' : t.type_message}
                  rows={1}
                  className="flex-1 min-w-0 bg-transparent text-sm text-white placeholder-[#7f91a4] focus:outline-none resize-none max-h-36 leading-relaxed py-1"
                />

                {/* Inside Capsule Actions: Format Toggle & Emoji Picker */}
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  {/* Format Toggle Pill */}
                  <button
                    id="format-text-btn"
                    type="button"
                    onClick={() => setShowFormattingToolbar(!showFormattingToolbar)}
                    className={`p-1.5 rounded-lg transition cursor-pointer ${
                      showFormattingToolbar
                        ? 'text-[#24A1DE] bg-[#24A1DE]/15'
                        : 'text-[#7f91a4] hover:text-[#24A1DE] hover:bg-[#17212b]'
                    }`}
                    title="Format Text (Ctrl+B, Ctrl+I, Spoiler, Code...)"
                  >
                    <Type className="h-4 w-4" />
                  </button>

                  {/* Emoji & Sticker Button */}
                  <button
                    id="emoji-picker-btn"
                    type="button"
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    className={`p-1.5 rounded-lg transition cursor-pointer ${
                      showEmojiPicker
                        ? 'text-[#24A1DE] bg-[#24A1DE]/15'
                        : 'text-[#7f91a4] hover:text-white hover:bg-[#17212b]'
                    }`}
                    title="Emojis & Stickers"
                  >
                    <Smile className="h-4.5 w-4.5" />
                  </button>
                </div>

                {/* Anchored Floating Emoji & Sticker Picker Popover */}
                {showEmojiPicker && (
                  <div
                    ref={emojiPickerRef}
                    className="absolute bottom-full right-0 mb-3 z-50 shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-150"
                  >
                    <EmojiStickerPicker
                      onSelectEmoji={handleInsertEmoji}
                      onSelectSticker={handleSendSticker}
                      onSelectGIF={handleSendGIF}
                      onClose={() => setShowEmojiPicker(false)}
                      isRtl={lang === 'fa'}
                    />
                  </div>
                )}
              </div>

              {/* Send or Voice Record Action Button */}
              {input.trim() || editingMessage ? (
                <button
                  id="send-message-btn"
                  type="button"
                  onClick={() => handleSendMessage()}
                  disabled={sending}
                  className="h-10 w-10 rounded-full bg-[#24A1DE] hover:bg-[#208fc4] flex items-center justify-center text-white shadow-lg shadow-[#24A1DE]/25 transition cursor-pointer flex-shrink-0"
                  title="Send"
                >
                  <Send className="h-4 w-4" />
                </button>
              ) : (
                <button
                  id="voice-record-btn"
                  type="button"
                  onClick={startVoiceRecording}
                  className="h-10 w-10 rounded-full bg-[#242f3d] hover:bg-[#24A1DE] hover:text-white text-[#7f91a4] flex items-center justify-center shadow-md transition cursor-pointer flex-shrink-0"
                  title={t.audio_record}
                >
                  <Mic className="h-4.5 w-4.5" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* WebRTC Active Call Modal Overlay */}
      {callSession && <CallModal session={callSession} lang={lang} />}

      {/* Round Video Note Recorder Modal Overlay */}
      {showRoundVideoRecorder && (
        <RoundVideoRecorderModal
          onSend={handleSendRoundVideo}
          onCancel={() => setShowRoundVideoRecorder(false)}
          sending={sending}
        />
      )}

      {/* Telegram-style Media & Document Preview Modal Overlay */}
      {pendingMediaFiles && (
        <MediaPreviewModal
          file={pendingMediaFiles.file}
          files={pendingMediaFiles.files}
          previewUrl={pendingMediaFiles.previewUrl}
          isVideo={pendingMediaFiles.isVideo}
          isDocument={pendingMediaFiles.isDocument}
          uploadProgress={uploadProgress}
          onSend={(file, caption) => sendMultipleFiles([file], caption)}
          onSendMultiple={(files, caption) => sendMultipleFiles(files, caption)}
          onCancel={() => {
            if (sending && uploadAbortControllerRef.current) {
              uploadAbortControllerRef.current.abort();
            }
            setPendingMediaFiles(null);
            setUploadProgress(undefined);
          }}
          sending={sending}
          lang={lang}
        />
      )}

      {/* Full-Screen Media Lightbox Overlay */}
      {lightboxMedia && (
        <MediaLightbox
          media={lightboxMedia}
          onClose={() => setLightboxMedia(null)}
          onPrev={handleLightboxPrev}
          onNext={handleLightboxNext}
          hasPrev={(lightboxMedia.currentIndex ?? 0) > 0}
          hasNext={(lightboxMedia.currentIndex ?? 0) < (lightboxMedia.totalCount ?? 0) - 1}
          onJumpToMessage={(msgId) => {
            setLightboxMedia(null);
            document.getElementById(`msg-${msgId}`)?.scrollIntoView({ behavior: 'smooth' });
          }}
        />
      )}

      {/* Telegram-style Message Context Menu Overlay */}
      {contextMenuPos && (
        <MessageContextMenu
          position={contextMenuPos}
          currentUser={currentUser}
          isOwnerOrAdmin={myRole === 'owner' || myRole === 'admin' || contextMenuPos.message.sender_id === currentUser.id}
          onClose={() => setContextMenuPos(null)}
          onReply={handleReply}
          onForward={(msg) => setForwardingMessages([msg])}
          onCopyText={handleCopyText}
          onCopyLink={handleCopyLink}
          onEdit={handleStartEdit}
          onTogglePin={handleTogglePin}
          onSelect={(msg) => {
            setSelectionMode(true);
            setSelectedMsgIds((prev) => new Set(prev).add(msg.id));
          }}
          onSaveToSaved={handleSaveToSavedMessages}
          onDownload={(attMeta) => handleDownloadAttachment(attMeta)}
          onOpenMedia={handleOpenLightbox}
          onOpenProfile={(userId) => {
            api.getUserProfile(userId).then(setInspectedUser).catch(() => {
              setInspectedUser({
                id: userId,
                username: contextMenuPos.message.sender_username || 'user',
                display_name: contextMenuPos.message.sender_username || 'Participant',
              });
            });
          }}
          onShowInfo={(msg) => {
            alert(
              `Message Details:\nID: ${msg.id}\nSender: ${msg.sender_username || msg.sender_id}\nTime: ${new Date(msg.created_at).toLocaleString()}\nStatus: ${msg.status || 'delivered'}\nSecurity: ${securityMode === 'e2ee' ? 'Signal Protocol E2EE' : 'Standard Secure'}`
            );
          }}
          onDeleteForMe={handleDeleteForMe}
          onDeleteForEveryone={handleDeleteForEveryone}
          onReact={handleAddReaction}
          onViewReadBy={(msg) => setReadByModalMessage(msg)}
        />
      )}

      {/* Read By Modal (Phase 1) */}
      {readByModalMessage && (
        <ReadByModal
          conversationId={conversation.id}
          message={readByModalMessage}
          lang={lang}
          onClose={() => setReadByModalMessage(null)}
          onOpenProfile={(userId) => {
            setReadByModalMessage(null);
            api.getUserProfile(userId).then(setInspectedUser).catch(() => {});
          }}
        />
      )}

      {/* Forward Modal Overlay */}
      {forwardingMessages && (
        <ForwardModal
          messages={forwardingMessages}
          currentUser={currentUser}
          onClose={() => setForwardingMessages(null)}
          onForward={handleExecuteForward}
        />
      )}

      {/* Create Poll Modal Overlay */}
      {showCreatePollModal && (
        <CreatePollModal
          onClose={() => setShowCreatePollModal(false)}
          onSubmit={handlePollCreated}
        />
      )}

      {/* Shared Media Drawer Overlay */}
      {showSharedMedia && (
        <SharedMediaDrawer
          messages={messages}
          onClose={() => setShowSharedMedia(false)}
          onDownloadFile={handleDownloadAttachment}
          onPlayVoice={handlePlayVoice}
        />
      )}

      {/* Schedule Message Modal */}
      {showScheduleModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d]">
            <div className="h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 bg-[#24A1DE]/20 text-[#24A1DE]">
              <Clock className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white text-center mb-1">Schedule Message</h3>
            <p className="text-xs text-[#7f91a4] text-center mb-4">
              Send this message automatically at a future date and time.
            </p>

            <div className="space-y-3 mb-5">
              <div>
                <label className="text-[11px] text-[#7f91a4] font-medium block mb-1">
                  Message Content
                </label>
                <div className="p-2.5 rounded-xl bg-[#242f3d] text-xs text-white max-h-24 overflow-y-auto">
                  {input.trim() || <span className="italic text-slate-400">Type in input box first</span>}
                </div>
              </div>

              <div>
                <label className="text-[11px] text-[#7f91a4] font-medium block mb-1">
                  Schedule For
                </label>
                <input
                  type="datetime-local"
                  value={scheduledDateStr}
                  onChange={(e) => setScheduledDateStr(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#242f3d] text-xs text-white border border-[#101921] focus:outline-none focus:border-[#24A1DE]"
                />
              </div>

              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="schedule-silent"
                  checked={isSilentSend}
                  onChange={(e) => setIsSilentSend(e.target.checked)}
                  className="rounded text-[#24A1DE]"
                />
                <label htmlFor="schedule-silent" className="text-xs text-[#7f91a4] cursor-pointer">
                  Send silently (no sound notification)
                </label>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowScheduleModal(false)}
                className="flex-1 py-2 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-xs text-white transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleScheduleSubmit}
                disabled={!input.trim() || !scheduledDateStr}
                className="flex-1 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition cursor-pointer shadow-md disabled:opacity-50"
              >
                Schedule
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Info Modal & Member List Inspector (Issue 3) */}
      {showChatInfoModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-md rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] max-h-[85vh] flex flex-col">
            <div className="flex flex-col items-center text-center mb-4 flex-shrink-0">
              <div
                className={`h-16 w-16 rounded-full flex items-center justify-center font-bold text-xl text-white shadow-lg mb-3 overflow-hidden ${
                  isSaved
                    ? 'bg-[#24A1DE]'
                    : isChannel
                    ? 'bg-gradient-to-tr from-purple-500 to-indigo-500'
                    : isGroup
                    ? 'bg-gradient-to-tr from-amber-500 to-orange-500'
                    : 'bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa]'
                }`}
              >
                {isSaved ? (
                  <Bookmark className="h-8 w-8 text-white" />
                ) : activeAvatarUrl ? (
                  <img src={activeAvatarUrl} alt={chatTitle} className="h-full w-full object-cover" />
                ) : isChannel ? (
                  <Megaphone className="h-8 w-8 text-white" />
                ) : isGroup ? (
                  <Users className="h-8 w-8 text-white" />
                ) : (
                  chatTitle.charAt(0).toUpperCase()
                )}
              </div>
              <h3 className="text-base font-bold text-white">{chatTitle}</h3>
              <p className="text-xs text-[#7f91a4] mt-0.5">
                {isSaved ? 'Saved Messages' : isChannel ? 'Channel' : isGroup ? 'Group Chat' : 'Direct Conversation'}
              </p>
            </div>

            <div className="space-y-2 text-xs bg-[#242f3d] p-3 rounded-xl mb-4 flex-shrink-0">
              {conversation.description && (
                <div>
                  <span className="text-[10px] text-[#7f91a4] block">Description</span>
                  <p className="text-white mt-0.5">{conversation.description}</p>
                </div>
              )}
              <div className="flex justify-between items-center py-1 border-b border-[#17212b]/50">
                <span className="text-[#7f91a4]">Security Mode</span>
                <span className="font-semibold text-emerald-400">
                  {securityMode === 'e2ee_active' ? 'Signal E2EE Active' : 'TLS & Encrypted at Rest'}
                </span>
              </div>
              {myRole && (
                <div className="flex justify-between items-center py-1 border-b border-[#17212b]/50">
                  <span className="text-[#7f91a4]">Your Role</span>
                  <span className="font-semibold text-[#24A1DE] capitalize">{myRole}</span>
                </div>
              )}
              <div className="flex justify-between items-center py-1">
                <span className="text-[#7f91a4]">
                  {isChannel ? 'Subscribers' : isGroup ? 'Members' : 'Participants'}
                </span>
                <span className="text-white font-medium">
                  {conversationMembers.length > 0
                    ? `${conversationMembers.length} ${isChannel ? 'subscribers' : 'members'}`
                    : `${conversation.participants?.length || 1} ${isChannel ? 'subscribers' : 'members'}`}
                </span>
              </div>
            </div>

            {/* Auto-Delete (Disappearing) Messages Settings */}
            <div className="bg-[#242f3d] p-3 rounded-xl mb-3 flex items-center justify-between gap-2 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-[#7f91a4]" />
                <div>
                  <span className="text-[10px] text-[#7f91a4] block">Auto-Delete Messages</span>
                  <span className="text-xs text-white font-medium">
                    {conversationTTL === 3600
                      ? '1 Hour'
                      : conversationTTL === 86400
                      ? '1 Day'
                      : conversationTTL === 604800
                      ? '1 Week'
                      : 'Off'}
                  </span>
                </div>
              </div>
              {(myRole === 'owner' || myRole === 'admin' || (!isGroup && !isChannel)) && (
                <select
                  value={conversationTTL}
                  disabled={updatingTTL}
                  onChange={(e) => handleSetTTL(Number(e.target.value))}
                  className="bg-[#17212b] border border-[#242f3d] rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-[#24A1DE] cursor-pointer"
                >
                  <option value={0}>Off</option>
                  <option value={3600}>1 Hour</option>
                  <option value={86400}>1 Day</option>
                  <option value={604800}>1 Week</option>
                </select>
              )}
            </div>

            {/* Authentic Token-based Invite Link for Group & Channel */}
            {(isGroup || isChannel) && (
              <div className="bg-[#242f3d] p-3 rounded-xl mb-3 space-y-2 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[#7f91a4] block font-semibold uppercase tracking-wider">Private Invite Link</span>
                  {(myRole === 'owner' || myRole === 'admin') && (
                    <button
                      type="button"
                      disabled={inviteLoading}
                      onClick={handleGenerateInvite}
                      className="text-[10px] text-[#24A1DE] hover:underline font-semibold cursor-pointer disabled:opacity-50"
                    >
                      {inviteLoading ? 'Generating...' : activeInviteCode ? 'Create New Link' : 'Generate Invite Link'}
                    </button>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 bg-[#17212b] p-2 rounded-lg border border-[#242f3d]">
                  <span className="text-xs text-white truncate block select-all font-mono">
                    {activeInviteCode
                      ? `${window.location.origin}/join/${activeInviteCode}`
                      : `${window.location.origin}/join/${conversation.id}`}
                  </span>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      type="button"
                      onClick={async () => {
                        const link = activeInviteCode
                          ? `${window.location.origin}/join/${activeInviteCode}`
                          : `${window.location.origin}/join/${conversation.id}`;
                        await navigator.clipboard.writeText(link);
                        alert('Invite link copied to clipboard!');
                      }}
                      className="p-1.5 rounded-lg bg-[#24A1DE]/20 hover:bg-[#24A1DE]/30 text-[#24A1DE] transition cursor-pointer"
                      title="Copy Invite Link"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    {(myRole === 'owner' || myRole === 'admin') && activeInviteCode && (
                      <button
                        type="button"
                        disabled={inviteLoading}
                        onClick={() => handleRevokeInvite(activeInviteCode)}
                        className="p-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition cursor-pointer"
                        title="Revoke Invite Link"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Add Member Row for Admins/Owner */}
            {(myRole === 'owner' || myRole === 'admin') && (isGroup || isChannel) && (
              <div className="mb-3 flex-shrink-0">
                {showAddMemberInput ? (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={newMemberUsername}
                      onChange={(e) => setNewMemberUsername(e.target.value)}
                      placeholder="User ID or @username"
                      className="flex-1 bg-[#121921] border border-[#242f3d] rounded-xl px-3 py-1.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                    />
                    <button
                      type="button"
                      disabled={addingMember || !newMemberUsername.trim()}
                      onClick={async () => {
                        if (!newMemberUsername.trim()) return;
                        setAddingMember(true);
                        try {
                          let targetUserId = newMemberUsername.trim().replace(/^@/, '');
                          try {
                            const searchRes = await api.searchUsers(targetUserId);
                            if (searchRes.users && searchRes.users.length > 0) {
                              const match = searchRes.users.find(
                                (u: any) =>
                                  u.username.toLowerCase() === targetUserId.toLowerCase() || u.id === targetUserId
                              );
                              if (match) targetUserId = match.id;
                            }
                          } catch (_) {}
                          await api.addConversationMember(conversation.id, targetUserId, 'member');
                          setNewMemberUsername('');
                          setShowAddMemberInput(false);
                          await loadMembers();
                        } catch (err: any) {
                          alert(err.message || 'Failed to add member');
                        } finally {
                          setAddingMember(false);
                        }
                      }}
                      className="px-3 py-1.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition disabled:opacity-50 cursor-pointer"
                    >
                      {addingMember ? 'Adding...' : 'Add'}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddMemberInput(false);
                        setNewMemberUsername('');
                      }}
                      className="p-1.5 rounded-xl bg-[#242f3d] hover:bg-[#2c3846] text-[#7f91a4] hover:text-white transition cursor-pointer"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowAddMemberInput(true)}
                    className="w-full py-2 px-3 rounded-xl bg-[#242f3d] hover:bg-[#2c3846] text-[#24A1DE] text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                  >
                    <UserPlus className="h-4 w-4" />
                    <span>Add {isChannel ? 'Subscriber' : 'Member'}</span>
                  </button>
                )}
              </div>
            )}

            {/* Functional Member List for Group & Channel */}
            {(isGroup || isChannel) && (
              <div className="flex-1 overflow-y-auto mb-4 min-h-[120px] max-h-60 border border-[#242f3d] rounded-xl p-2 bg-[#121921]">
                <h4 className="text-[11px] font-bold text-[#7f91a4] uppercase px-2 py-1 tracking-wider">
                  {isChannel ? 'Subscribers' : 'Members'} ({conversationMembers.length})
                </h4>
                {loadingMembers ? (
                  <div className="flex items-center justify-center py-6 text-xs text-[#7f91a4] gap-2">
                    <div className="h-4 w-4 border-2 border-[#24A1DE] border-t-transparent rounded-full animate-spin" />
                    <span>Loading members...</span>
                  </div>
                ) : membersError ? (
                  <div className="p-3 text-xs text-amber-300 bg-amber-500/10 rounded-lg">
                    {membersError}
                  </div>
                ) : conversationMembers.length === 0 ? (
                  <div className="p-3 text-xs text-[#7f91a4] text-center">No members found.</div>
                ) : (
                  <div className="space-y-1">
                    {conversationMembers.map((m) => (
                      <div
                        key={m.user_id}
                        onClick={() => {
                          setShowChatInfoModal(false);
                          setInspectedUser({
                            id: m.user_id,
                            username: m.username,
                            display_name: m.display_name,
                            avatar_url: m.avatar_url,
                          } as User);
                        }}
                        className="flex items-center justify-between p-2 rounded-lg hover:bg-[#202b36] transition cursor-pointer"
                        title="View Profile"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="h-8 w-8 rounded-full bg-[#24A1DE] flex items-center justify-center font-bold text-xs text-white overflow-hidden flex-shrink-0">
                            {m.avatar_url ? (
                              <img src={m.avatar_url} alt={m.display_name} className="h-full w-full object-cover" />
                            ) : (
                              (m.display_name || m.username || 'U').charAt(0).toUpperCase()
                            )}
                          </div>
                          <div className="min-w-0">
                            <span className="block text-xs font-semibold text-white truncate">
                              {m.display_name || m.username}
                              {m.user_id === currentUser.id && (
                                <span className="text-[10px] text-[#24A1DE] ml-1">(You)</span>
                              )}
                            </span>
                            <span className="block text-[10px] text-[#7f91a4] truncate">
                              @{m.username}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {/* Role Badge */}
                          <span
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize ${
                              m.role === 'owner'
                                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                                : m.role === 'admin'
                                ? 'bg-[#24A1DE]/20 text-[#24A1DE] border border-[#24A1DE]/30'
                                : 'bg-[#242f3d] text-[#7f91a4]'
                            }`}
                          >
                            {m.role}
                          </span>

                          {/* Promote / Demote Role Button for Owner / Admin */}
                          {(myRole === 'owner' || (myRole === 'admin' && m.role === 'member')) &&
                            m.role !== 'owner' &&
                            m.user_id !== currentUser.id && (
                              <button
                                type="button"
                                disabled={updatingRoleUserId === m.user_id}
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  const nextRole = m.role === 'admin' ? 'member' : 'admin';
                                  if (
                                    !confirm(
                                      `${nextRole === 'admin' ? 'Promote' : 'Demote'} ${
                                        m.display_name || m.username
                                      } to ${nextRole}?`
                                    )
                                  )
                                    return;
                                  await handleUpdateRole(m.user_id, nextRole);
                                }}
                                className={`p-1 rounded-lg transition cursor-pointer ${
                                  m.role === 'admin'
                                    ? 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10'
                                    : 'text-[#24A1DE] hover:text-[#208fc4] hover:bg-[#24A1DE]/10'
                                }`}
                                title={m.role === 'admin' ? 'Demote to Member' : 'Promote to Admin'}
                              >
                                <Shield className="h-3.5 w-3.5" />
                              </button>
                            )}

                          {/* Remove Member button for admins/owner */}
                          {(myRole === 'owner' || myRole === 'admin') &&
                            m.role !== 'owner' &&
                            m.user_id !== currentUser.id && (
                              <button
                                type="button"
                                onClick={async (e) => {
                                  e.stopPropagation();
                                  if (
                                    !confirm(
                                      `Remove ${m.display_name || m.username} from this ${
                                        isChannel ? 'channel' : 'group'
                                      }?`
                                    )
                                  )
                                    return;
                                  try {
                                    await api.removeConversationMember(conversation.id, m.user_id);
                                    await loadMembers();
                                  } catch (err: any) {
                                    alert(err.message || 'Failed to remove member');
                                  }
                                }}
                                className="p-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition cursor-pointer"
                                title="Remove Member"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowChatInfoModal(false)}
              className="w-full py-2.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition cursor-pointer flex-shrink-0"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* Telegram-style User Profile Modal */}
      {inspectedUser && (
        <UserProfileModal
          user={inspectedUser}
          currentUser={currentUser}
          conversationId={conversation.id}
          onClose={() => setInspectedUser(null)}
          onStartCall={async (type: 'audio' | 'video') => {
            const peerId = inspectedUser.id;
            const peerName = inspectedUser.display_name || inspectedUser.username;
            setInspectedUser(null);
            let callConvId = conversation.id;
            if (conversation.type !== 'direct') {
              try {
                const directConv = await api.createDirectConversation(peerId);
                callConvId = directConv.id;
                onSelectConversation?.(directConv);
              } catch (err) {
                console.warn('Fallback to current conv for call:', err);
              }
            }
            webrtcManager.startCall(
              callConvId,
              peerId,
              peerName,
              type
            );
          }}
          onOpenDirectChat={async (targetUser: User) => {
            setInspectedUser(null);
            try {
              const conv = await api.createDirectConversation(targetUser.id);
              onSelectConversation?.(conv);
            } catch (err) {
              console.error('Failed to open direct chat:', err);
            }
          }}
          onOpenSharedMedia={() => {
            setInspectedUser(null);
            setShowSharedMedia(true);
          }}
          onUpdateCurrentUser={(updated: User) => {
            if (inspectedUser.id === updated.id) {
              setInspectedUser((prev) => (prev ? { ...prev, ...updated } : null));
            }
          }}
          lang={lang}
        />
      )}
    </div>
  );
};

