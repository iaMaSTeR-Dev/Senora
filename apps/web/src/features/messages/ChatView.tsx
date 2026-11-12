import { StreamingVideo } from './StreamingVideo';
import { uiText, useUILanguage } from "../../app/language";
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Conversation, Message, User, Sticker, StickerPack, GIFItem, ConversationMemberDetail, BotActionButton, ForumTopic, WatchPartySession, Attachment } from '../../app/types';
import { StickerPackModal } from './StickerPackModal';
import { WhisperMessageCard } from './WhisperMessageCard';
import { WhisperModal } from './WhisperModal';
import { WatchPartyModal } from './WatchPartyModal';
import { ShareMediaModal } from './ShareMediaModal';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';
import { signalManager } from '../../crypto/signalManager';
import { cryptoEngine } from '../../crypto/clientCrypto';
import { translations, Language } from '../../app/i18n';
import { webrtcManager } from '../calls/webrtcManager';
import { mediaDeviceManager } from '../calls/mediaDeviceManager';
import { loadSettings, WALLPAPERS } from '../settings/settingsModel';
import { useSettings, shouldAutoDownload } from '../settings/useSettings';
import { MotionImage, MotionVideo } from './MotionImage';
import { GameAction, GameEvent } from './gameRules';
import { DiceResult, newDiceResult, parseDiceResult } from './dice';
import { encryptWhisper } from '../../crypto/whisperCrypto';
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
import { AnimatedDiceCard } from './AnimatedDiceCard';
import { TicTacToeGameCard } from './TicTacToeGameCard';
import { RockPaperScissorsCard } from './RockPaperScissorsCard';
import { MiniGameModal } from './MiniGameModal';
import {
  Send,
  Lock,
  Check,
  CheckCheck,
  Gamepad2,
  Dices,
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
  UserPlus,
  Flame,
  Calendar,
  Hash,
  Layers,
  Reply
} from 'lucide-react';

function normalizeBotActions(value: unknown): BotActionButton[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value
    .filter(Array.isArray)
    .map((row) => row.filter((button): button is BotActionButton => Boolean(button) && typeof button === 'object' && typeof (button as BotActionButton).text === 'string'))
    .filter((row) => row.length > 0);
  return rows.length ? rows : undefined;
}

interface CircularVideoNotePlayerProps {
  src: string;
  onDownload?: () => void;
}

const CircularVideoNotePlayer: React.FC<CircularVideoNotePlayerProps> = ({ src, onDownload }) => {
  const uiLang = useUILanguage();
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
              title={uiText("Download Video Note", uiLang)}
            >
              <Download className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={toggleMute}
            className="p-1 rounded-full bg-black/60 text-white backdrop-blur-sm hover:bg-black/80 transition"
            title={isMuted ? uiText("Unmute", uiLang) : uiText("Mute", uiLang)}
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
  const uiLang = useUILanguage();
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
          title={uiText("Click to seek", uiLang)}
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
          <span className="text-[9px]">{uiText("E2EE Voice", uiLang)}</span>
        </div>
      </div>

      {/* Speed Multiplier Button */}
      <button
        type="button"
        onClick={onSpeedCycle}
        className="px-1.5 py-0.5 rounded-lg bg-[#242f3d] hover:bg-[#202b36] text-[10px] font-bold text-[#24A1DE] border border-[#24A1DE]/30 transition cursor-pointer flex-shrink-0"
        title={uiText("Playback Speed", uiLang)}
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
          title={uiText("Download Voice Note", uiLang)}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
};

export const URL_REGEX = /(https?:\/\/[^\s<]+)/gi;

export const isBigEmojiOnly = (text: string): boolean => {
  if (!text) return false;
  const trimmed = text.trim();
  const emojiRegex = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*){1,3}$/u;
  return emojiRegex.test(trimmed);
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
    isViewOnce?: boolean;
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
          reactions: (incoming.reactions && typeof incoming.reactions === 'object' && !Array.isArray(incoming.reactions))
            ? incoming.reactions
            : (item.reactions && typeof item.reactions === 'object' && !Array.isArray(item.reactions) ? item.reactions : {}),
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
  const mediaSettings = useSettings();
  const uiLang = useUILanguage(lang);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const isSendingRef = useRef(false);
  const [peerPublicKey, setPeerPublicKey] = useState<string | null>(null);
  const [peerVerificationKey, setPeerVerificationKey] = useState<string | null>(null);
  const [safetyNumber, setSafetyNumber] = useState<string | null>(null);
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [verificationState, setVerificationState] = useState<'verified' | 'unverified' | 'key_changed' | 'unavailable'>('unavailable');


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

  // Sticker Pack inspection & share modal
  const [showStickerPackModal, setShowStickerPackModal] = useState(false);
  const [previewStickerPackId, setPreviewStickerPackId] = useState<string | null>(null);

  // Whisper Secret Message Modal
  const [showWhisperModal, setShowWhisperModal] = useState(false);

  // In-Chat Synchronized Watch Party & Media Share
  const [watchPartyOpen, setWatchPartyOpen] = useState(false);
  const [watchPartyMediaUrl, setWatchPartyMediaUrl] = useState<string | undefined>(undefined);
  const [watchPartyMediaTitle, setWatchPartyMediaTitle] = useState<string | undefined>(undefined);
  const [activeWatchPartySession, setActiveWatchPartySession] = useState<WatchPartySession | null>(null);
  const [shareMediaModalOpen, setShareMediaModalOpen] = useState(false);
  const [sharingAttachment, setSharingAttachment] = useState<Attachment | null>(null);

  useEffect(() => {
    if (!conversation?.id) return;
    api.getWatchParty(conversation.id).then((res) => {
      if (res.active && res.session) {
        setActiveWatchPartySession(res.session);
      } else {
        setActiveWatchPartySession(null);
      }
    }).catch(() => {});

    const unsubStart = wsManager.subscribe('watch_party.start', (data: any) => {
      if (data.conversation_id === conversation.id && data.session) {
        setActiveWatchPartySession(data.session);
      }
    });

    const unsubEnd = wsManager.subscribe('watch_party.end', (data: any) => {
      if (data.conversation_id === conversation.id) {
        setActiveWatchPartySession(null);
      }
    });

    return () => {
      unsubStart();
      unsubEnd();
    };
  }, [conversation?.id]);

  const handleOpenStickerPack = (packIdOrCode?: string) => {
    if (!packIdOrCode) return;
    setPreviewStickerPackId(packIdOrCode);
    setShowStickerPackModal(true);
  };

  const handleBotButtonClick = async (btn: BotActionButton, messageId?: string) => {
    if (btn.url) {
      const url = new URL(btn.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') window.open(url.toString(), '_blank', 'noopener,noreferrer');
      return;
    }
    if (btn.callback_data && messageId) {
      try { await api.invokeBotCallback(conversation.id, messageId, btn.callback_data); }
      catch (error) { alert(error instanceof Error ? error.message : 'Callback failed'); }
      return;
    }

    if (btn.action === 'download' || (btn.command && btn.command.includes('/api/v1/admin/backup/download'))) {
      const token = api.getToken() || '';
      const separator = (btn.command || '').includes('?') ? '&' : '?';
      const downloadUrl = `${btn.command}${separator}token=${encodeURIComponent(token)}`;
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = '';
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return;
    }
    if (btn.command) {
      try {
        await api.submitMessage(conversation.id, {
          ciphertext: btn.command,
          nonce: 'normal',
          idempotency_key: `cmd_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        });
      } catch (err: any) {
        alert(err?.message || uiText("Failed to execute command", uiLang));
      }
    }
  };

  // Mention suggestions
  const [mentionSuggestions, setMentionSuggestions] = useState<User[]>([]);
  const [showMentionSuggestions, setShowMentionSuggestions] = useState(false);
  const [mentionQueryRange, setMentionQueryRange] = useState<{ start: number; end: number } | null>(null);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);

  const handleMentionClick = async (username: string) => {
    const raw = username.trim();
    const clean = raw.replace(/^@/, '').trim().toLowerCase();
    if (!clean) return;

    if (currentUser.username.toLowerCase() === clean) {
      setInspectedUser(currentUser);
      return;
    }

    if (conversation.participants) {
      const match = conversation.participants.find((p) => p.username.toLowerCase() === clean);
      if (match) {
        setInspectedUser(match);
        return;
      }
    }

    try {
      const resolved = await api.resolveIdentifier(clean);
      if (resolved.type === 'user' && resolved.user) {
        setInspectedUser(resolved.user);
        return;
      }
      if ((resolved.type === 'channel' || resolved.type === 'group') && resolved.conversation) {
        try {
          const joinedConv = await api.joinConversation(resolved.conversation.id);
          onSelectConversation?.(joinedConv);
        } catch {
          onSelectConversation?.(resolved.conversation);
        }
        return;
      }
    } catch {}

    try {
      const user = await api.getUserByUsername(clean);
      if (user && user.id) {
        setInspectedUser(user);
        return;
      }
    } catch {}

    try {
      const res = await api.searchUsers(clean);
      if (res.users && res.users.length > 0) {
        const exact = res.users.find((u) => u.username.toLowerCase() === clean);
        if (exact) {
          setInspectedUser(exact);
          return;
        }
      }
    } catch (err) {
      console.warn('Failed to resolve mentioned entity:', err);
    }
  };

  const handleMentionInputChange = (val: string, cursorIndex: number) => {
    setInput(val);
    if (val.trim()) {
      localStorage.setItem('senora_draft_' + conversation.id, val);
    } else {
      localStorage.removeItem('senora_draft_' + conversation.id);
    }
    clearTimeout(typingDebounceRef.current);
    wsManager.sendTyping(conversation.id, true);
    typingDebounceRef.current = setTimeout(() => {
      wsManager.sendTyping(conversation.id, false);
    }, 2500);

    const textBeforeCursor = val.slice(0, cursorIndex);
    const match = /(?:^|\s)@([a-zA-Z0-9_]*)$/.exec(textBeforeCursor);

    if (match) {
      const q = match[1].toLowerCase();
      const matchStart = cursorIndex - match[1].length - 1;
      setMentionQueryRange({ start: matchStart, end: cursorIndex });

      const pool: User[] = [];
      const INLINE_BOTS: User[] = [
        { id: 'bot_master', username: 'masterbot', display_name: 'Master Bot (مدیریت سرور)', bio: 'ربات نظارت بر منابع سرور و استوریج' },
        { id: 'bot_whisper', username: 'whisper', display_name: 'Whisper Bot (پیام مخفی)', bio: 'ارسال پیام مخفی در چت و گروه (@whisper @نام‌کاربری متن)' },
        { id: 'bot_calc', username: 'calc', display_name: 'Calculator (ماشین‌حساب)', bio: 'انجام سریع محاسبات ریاضی' },
        { id: 'bot_poll', username: 'poll', display_name: 'Poll Creator (نظرسنجی)', bio: 'ایجاد نظرسنجی و کوییز فوری' },
        { id: 'bot_gif', username: 'gif', display_name: 'GIF Finder (جستجوی گیف)', bio: 'جستجو و ارسال انیمیشن‌های گیف' },
      ];
      pool.push(...INLINE_BOTS);
      if (conversation.participants) {
        for (const p of conversation.participants) {
          if (!pool.some((u) => u.id === p.id)) {
            pool.push(p);
          }
        }
      }
      if (conversationMembers && conversationMembers.length > 0) {
        for (const m of conversationMembers) {
          if (!pool.some((u) => u.id === m.user_id)) {
            pool.push({
              id: m.user_id,
              username: m.username,
              display_name: m.display_name,
              avatar_url: m.avatar_url,
              created_at: '',
              updated_at: '',
            } as User);
          }
        }
      }
      if (!pool.some((u) => u.id === currentUser.id)) {
        pool.push(currentUser);
      }

      // Strictly filter only this conversation's participants and inline bots
      // Never query the global user database across the platform
      const filtered = pool.filter((u) =>
        (u.username && u.username.toLowerCase().includes(q)) ||
        (u.display_name && u.display_name.toLowerCase().includes(q))
      );

      setMentionSuggestions(filtered.slice(0, 8));
      setShowMentionSuggestions(filtered.length > 0);
      setSelectedMentionIndex(0);
    } else {
      setShowMentionSuggestions(false);
      setMentionQueryRange(null);
    }
  };

  const handleSelectMention = (user: User) => {
    if (!mentionQueryRange) return;
    const before = input.slice(0, mentionQueryRange.start);
    const after = input.slice(mentionQueryRange.end);
    const inserted = `@${user.username} `;
    const newInput = before + inserted + after;
    setInput(newInput);
    setShowMentionSuggestions(false);
    setMentionQueryRange(null);

    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const nextPos = before.length + inserted.length;
        textareaRef.current.setSelectionRange(nextPos, nextPos);
      }
    }, 10);
  };

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

  // Dismiss reaction picker on click outside
  useEffect(() => {
    if (!activeReactionMsgId) return;
    const handleOutside = () => setActiveReactionMsgId(null);
    window.addEventListener('click', handleOutside);
    return () => window.removeEventListener('click', handleOutside);
  }, [activeReactionMsgId]);

  // Message Context Menu state
  const [contextMenuPos, setContextMenuPos] = useState<ContextMenuPosition | null>(null);

  // Formatting Toolbar state
  const [showFormattingToolbar, setShowFormattingToolbar] = useState(false);

  // Search in chat
  const [showSearch, setShowSearch] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);

  // Conversation mode & modal states
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

  // Selection, poll, scheduling & interactive states
  const [forwardingMessages, setForwardingMessages] = useState<Message[] | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedMsgIds, setSelectedMsgIds] = useState<Set<string>>(new Set());
  const [showSharedMedia, setShowSharedMedia] = useState(false);
  const [showCreatePollModal, setShowCreatePollModal] = useState(false);
  const [voicePlaybackSpeed, setVoicePlaybackSpeed] = useState<number>(1);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showMiniGameModal, setShowMiniGameModal] = useState(false);
  const [isSilentSend, setIsSilentSend] = useState(false);
  const [scheduledDateStr, setScheduledDateStr] = useState('');
  const [showChatInfoModal, setShowChatInfoModal] = useState(false);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [showAddMemberInput, setShowAddMemberInput] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [newMemberUsername, setNewMemberUsername] = useState('');

  // 1. View Once Media State
  const [burnedViewOnceIds, setBurnedViewOnceIds] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('senora_burned_view_once');
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch {
      return new Set();
    }
  });
  const [activeViewOnceModal, setActiveViewOnceModal] = useState<{
    msg: Message;
    url: string;
    countdown: number;
  } | null>(null);

  // View Once Countdown Timer Effect
  useEffect(() => {
    if (!activeViewOnceModal) return;
    if (activeViewOnceModal.countdown <= 0) {
      const burnedId = activeViewOnceModal.msg.id;
      setBurnedViewOnceIds((prev) => {
        const next = new Set(prev).add(burnedId);
        try {
          localStorage.setItem('senora_burned_view_once', JSON.stringify(Array.from(next)));
        } catch {}
        return next;
      });
      setActiveViewOnceModal(null);
      return;
    }
    const timer = setInterval(() => {
      setActiveViewOnceModal((prev) => (prev ? { ...prev, countdown: prev.countdown - 1 } : null));
    }, 1000);
    return () => clearInterval(timer);
  }, [activeViewOnceModal]);

  // 2. Supergroup Forum Topics State
  const [isForum, setIsForum] = useState<boolean>(Boolean(conversation.is_forum));
  const [forumTopics, setForumTopics] = useState<ForumTopic[]>([]);
  const [activeTopicId, setActiveTopicId] = useState<string | null>(null);
  const [showNewTopicModal, setShowNewTopicModal] = useState(false);
  const [newTopicTitle, setNewTopicTitle] = useState('');
  const [newTopicIcon, setNewTopicIcon] = useState('💬');
  const [newTopicColor, setNewTopicColor] = useState('#24A1DE');
  const [creatingTopic, setCreatingTopic] = useState(false);

  useEffect(() => {
    setIsForum(Boolean(conversation.is_forum));
    if (conversation.is_forum) {
      api.getConversationTopics(conversation.id)
        .then((res) => setForumTopics(res.topics || []))
        .catch(console.warn);
    } else {
      setForumTopics([]);
      setActiveTopicId(null);
    }
  }, [conversation.id, conversation.is_forum]);

  // 3. Multiple Pinned Messages & Pins Drawer
  const [currentPinIndex, setCurrentPinIndex] = useState(0);
  const [showPinsDrawer, setShowPinsDrawer] = useState(false);

  // 4. Swipe to Reply Touch Gesture
  const [swipingMsgId, setSwipingMsgId] = useState<string | null>(null);
  const [swipeOffset, setSwipeOffset] = useState<number>(0);
  const touchStartXRef = useRef<number>(0);

  // 5. Media Type & Date Search Filters
  const [searchMediaType, setSearchMediaType] = useState<'all' | 'media' | 'files' | 'voice' | 'links'>('all');
  const [searchDate, setSearchDate] = useState<string>('');

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
    const savedDraft = localStorage.getItem('senora_draft_' + conversation.id);
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
          attachment_ids: msg.attachmentMeta?.id ? [msg.attachmentMeta.id] : [],
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
        const encryptedPoll = await signalManager.encryptPollData(params.question, params.options, params.explanation);
        pollKeyBase64 = encryptedPoll.keyBase64;
        pollIvBase64 = encryptedPoll.ivBase64;
        pollCreationParams = {
          ...params,
          question: encryptedPoll.encryptedQuestion,
          options: encryptedPoll.encryptedOptions,
          explanation: encryptedPoll.encryptedExplanation,
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
      let ciphertext = text;
      let nonce = 'normal';
      const whisperCommand = text.match(/^(@whisper|\/whisper)\s+@?([a-zA-Z0-9_\-.]+)\s+([\s\S]+)$/i);
      if (whisperCommand) {
        const secret = await encryptWhisper({ target_username: whisperCommand[2], secret_text: whisperCommand[3], sender_id: currentUser.id, sender_username: currentUser.username }, await getEncryptionTargets(), conversation.id, currentUser.id);
        ciphertext = JSON.stringify({ type: 'whisper', ...secret });
      }
      if (securityMode === 'e2ee_active') {
        const encrypted = await signalManager.encryptMultiDevice(ciphertext, await getEncryptionTargets(), conversation.id, api.getToken() || undefined);
        ciphertext = encrypted.ciphertext; nonce = encrypted.nonce;
      }
      await api.scheduleMessage(conversation.id, {
        ciphertext, nonce,
        scheduled_for: new Date(scheduledDateStr).toISOString(),
        is_silent: isSilentSend,
      });
      alert(uiText("Message scheduled successfully!", uiLang));
      setShowScheduleModal(false);
      setInput('');
      localStorage.removeItem('senora_draft_' + conversation.id);
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

  // Voice recording lock and preview state
  const [isRecordingLocked, setIsRecordingLocked] = useState(false);
  const [isRecordingPaused, setIsRecordingPaused] = useState(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewAudioPlaying, setPreviewAudioPlaying] = useState(false);
  const [previewAudioCurrentTime, setPreviewAudioCurrentTime] = useState(0);
  const [previewAudioDuration, setPreviewAudioDuration] = useState(0);
  const previewAudioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const recordedVoiceBlobRef = useRef<Blob | null>(null);

  // Link Previews cache state
  const [linkPreviews, setLinkPreviews] = useState<Record<string, { url: string; title?: string; description?: string; image_url?: string; site_name?: string }>>({});

  // Group Slow Mode cooldown state
  const [slowModeRemaining, setSlowModeRemaining] = useState<number>(0);
  const slowModeTimerRef = useRef<any>(null);

  // Audio playback state
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  // File upload input ref
  const fileInputRef = useRef<HTMLInputElement>(null);


  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [newMessagesBelow, setNewMessagesBelow] = useState(0);
  const isNearBottomRef = useRef(true);
  const prevMessagesCountRef = useRef(0);

  const handleMessageScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isNear = distanceFromBottom < 120;
    isNearBottomRef.current = isNear;
    if (distanceFromBottom > 200) {
      setShowScrollBottom(true);
    } else if (isNear) {
      setShowScrollBottom(false);
      setNewMessagesBelow(0);
    }
  };

  const scrollToBottom = (smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
      });
    }
    setShowScrollBottom(false);
    setNewMessagesBelow(0);
    isNearBottomRef.current = true;
  };

  const t = translations[lang];

  const myDeviceId = localStorage.getItem('senora_device_id') || 'dev_current';
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

  // Group/channel member list state
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
        const valid = invites.filter((inv) => {
          if (inv.is_revoked) return false;
          if (inv.expires_at) {
            const exp = new Date(inv.expires_at).getTime();
            if (!isNaN(exp) && exp > 0 && exp <= Date.now()) {
              return false;
            }
          }
          return true;
        });
        if (valid.length > 0) {
          setActiveInviteCode(valid[0].invite_code);
          return;
        }
      }
      if (myRole === 'owner' || myRole === 'admin') {
        const inv = await api.createConversationInvite(conversation.id, { expires_in_hours: 48 });
        setActiveInviteCode(inv.invite_code);
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
      alert(err.message || uiText("Failed to generate invite", uiLang));
    } finally {
      setInviteLoading(false);
    }
  };

  const handleRevokeInvite = async (code: string) => {
    if (!confirm(uiText("Revoke this invite link? Users with this link will no longer be able to join.", uiLang))) return;
    setInviteLoading(true);
    try {
      await api.revokeConversationInvite(conversation.id, code);
      setActiveInviteCode(null);
      await loadInvites();
    } catch (err: any) {
      alert(err.message || uiText("Failed to revoke invite", uiLang));
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
      alert(err.message || uiText("Failed to update member role", uiLang));
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
      alert(err.message || uiText("Failed to update disappearing timer", uiLang));
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
              const verificationKey = pkg.devices[0].signed_pre_key ? (JSON.parse(pkg.devices[0].signed_pre_key).identityKey || firstKey) : firstKey;
              setPeerPublicKey(firstKey);
              setPeerVerificationKey(verificationKey);
              // Compute safety number using Signal identity
              try {
                const sn = await signalManager.calculateSafetyNumber(verificationKey);
                setSafetyNumber(sn);
              } catch (err) {
                console.warn('Safety number computation error:', err);
              }

              // Check verified status in local storage
              const savedKey = localStorage.getItem('verified_key_' + peerUser.id);
              if (!savedKey) {
                setVerificationState('unverified');
              } else if (savedKey === verificationKey) {
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
    if (!peerUser || !peerVerificationKey) return;
    if (verificationState === 'verified') {
      localStorage.removeItem('verified_key_' + peerUser.id);
      setVerificationState('unverified');
    } else {
      localStorage.setItem('verified_key_' + peerUser.id, peerVerificationKey);
      setVerificationState('verified');
    }
  };

  // Helper to parse message payload (text, media, voice, sticker, video note, poll, call_event, bot_actions)
  const parsePayload = (plaintext: string): {
    displayText: string;
    attachmentMeta?: any;
    pollId?: string;
    pollKey?: string;
    pollIv?: string;
    isForwarded?: boolean;
    forwardFromName?: string;
    gameAction?: GameAction;
    diceResult?: DiceResult;
    botActions?: BotActionButton[][];
    whisper?: {
      target_username: string;
      target_id?: string;
      secret_text: string;
      encrypted_secret?: string;
      secret_nonce?: string;
      sender_username?: string;
      sender_id?: string;
    };
    callEvent?: {
      call_id: string;
      call_type: 'audio' | 'video';
      outcome: 'completed' | 'missed' | 'declined' | 'rejected' | 'cancelled';
      duration_seconds: number;
      caller_id?: string;
      caller_name?: string;
      receiver_id?: string;
    };
    watchPartyInvite?: {
      session_id: string;
      media_title: string;
      media_url: string;
      leader_name: string;
    };
  } => {
    if (plaintext.startsWith('{') && plaintext.endsWith('}')) {
      try {
        const parsed: any = JSON.parse(plaintext);
        if (parsed.type === 'game_action' && typeof parsed.game_id === 'string') return { displayText: '', gameAction: parsed as GameAction };
        if (parsed.type === 'dice' && typeof parsed.emoji === 'string') return { displayText: parsed.emoji, diceResult: parseDiceResult(parsed) };
        if (parsed.type === 'whisper') {
          return {
            displayText: '🤫 پیام نجوا (Whisper)',
            whisper: {
              target_username: parsed.target_username || '',
              target_id: parsed.target_id || '',
              secret_text: parsed.secret_text || '',
              encrypted_secret: parsed.encrypted_secret,
              secret_nonce: parsed.secret_nonce,
              sender_username: parsed.sender_username || '',
              sender_id: parsed.sender_id || '',
            },
          };
        }
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
        if (parsed.type === 'watch_party_invite' || parsed.watch_party_invite) {
          const inv = parsed.watch_party_invite || parsed;
          return {
            displayText: `🎬 سینما پارتی: ${inv.media_title || 'ویدیو'}`,
            watchPartyInvite: {
              session_id: inv.session_id || '',
              media_title: inv.media_title || 'Video',
              media_url: inv.media_url || '',
              leader_name: inv.leader_name || 'Host',
            },
          };
        }
        const rawAtt = parsed.attachment || parsed.attachmentMeta;
        if (rawAtt || parsed.type === 'attachment' || parsed.type === 'voice' || parsed.type === 'sticker' || parsed.type === 'video_note') {
          const att = rawAtt ? { ...rawAtt } : undefined;
          if (att) {
            if (!att.isPhoto && (att.contentType?.startsWith('image/') || att.filename?.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i))) {
              att.isPhoto = true;
            }
            if (!att.isVideo && (att.contentType?.startsWith('video/') || att.filename?.match(/\.(mp4|webm|mov|mkv)$/i))) {
              att.isVideo = true;
            }
            if (!att.isVoice && (att.contentType?.startsWith('audio/') || att.filename?.match(/\.(ogg|mp3|wav|m4a)$/i))) {
              att.isVoice = true;
            }
          }
          return {
            displayText:
              parsed.text ||
              (parsed.type === 'voice' || att?.isVoice
                ? t.voice_message
                : parsed.type === 'video_note' || att?.isRoundVideo
                ? 'Video Note'
                : parsed.type === 'sticker' || att?.isSticker
                ? 'Sticker'
                : att?.isPhoto
                ? 'Photo'
                : att?.isVideo
                ? 'Video'
                : 'Attachment'),
            attachmentMeta: att,
            isForwarded: parsed.is_forwarded,
            forwardFromName: parsed.forward_from_name,
            botActions: normalizeBotActions(parsed.bot_actions),
          };
        }
        // General text, bot payloads, and forwarded messages
        if (typeof parsed.text === 'string' || Array.isArray(parsed.bot_actions) || parsed.is_forwarded) {
          return {
            displayText: typeof parsed.text === 'string' ? parsed.text : '',
            botActions: normalizeBotActions(parsed.bot_actions),
            isForwarded: Boolean(parsed.is_forwarded),
            forwardFromName: parsed.forward_from_name,
          };
        }
      } catch {}
    }
    return { displayText: plaintext };
  };


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
    let botActions: BotActionButton[][] | undefined = normalizeBotActions(msg.bot_actions);
    let callEvent = msg.callEvent;
    let whisper = msg.whisper;
    let gameAction = msg.game_action;
    let diceResult = msg.dice_result;

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
        if (parsed.whisper) whisper = parsed.whisper;
      if (parsed.gameAction) gameAction = parsed.gameAction;
      if (parsed.diceResult) diceResult = parsed.diceResult;
        if (parsed.botActions) botActions = parsed.botActions;
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
      if (parsed.whisper) whisper = parsed.whisper;
      if (parsed.gameAction) gameAction = parsed.gameAction;
      if (parsed.diceResult) diceResult = parsed.diceResult;
      if (parsed.botActions) botActions = parsed.botActions;
      if (parsed.callEvent) callEvent = parsed.callEvent;
    }

    // Parse reactions map safely to Record<string, string[]>
    let reactions: Record<string, string[]> = {};
    if (msg.reactions) {
      if (typeof msg.reactions === 'string') {
        try {
          const parsed = JSON.parse(msg.reactions);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            reactions = parsed;
          }
        } catch {}
      } else if (typeof msg.reactions === 'object' && !Array.isArray(msg.reactions)) {
        reactions = msg.reactions;
      }
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
      whisper: whisper || msg.whisper,
      game_action: gameAction,
      dice_result: diceResult,
      reactions,
      bot_actions: normalizeBotActions(botActions || msg.bot_actions),
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

      // Deduplicate loaded messages by ID and filter out deleted messages
      const seenIds = new Set<string>();
      const dedupedList: Message[] = [];
      for (const msg of decryptedList) {
        if (msg.id && !msg.is_deleted && !seenIds.has(msg.id)) {
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
        const oldest = dedupedList[0]?.created_at;
        const newest = dedupedList[dedupedList.length - 1]?.created_at;
        // A live event can arrive while HTTP history is being fetched. Retain
        // messages newer than that snapshot as well as older loaded history.
        const outsideSnapshot = prev.filter(m => m.conversation_id === conversation.id && !m.is_deleted && m.status !== 'sending' && !seenIds.has(m.id) && (!oldest || m.created_at < oldest || m.created_at > newest));
        return [...outsideSnapshot, ...dedupedList, ...pendingSending].reduce<Message[]>((all, message) => reconcileMessageList(all, message), []);
      });

      // Synchronize latest decrypted message preview to sidebar
      if (dedupedList.length > 0) {
        const last = dedupedList[dedupedList.length - 1];
        const preview = last.plaintext || (last.attachmentMeta?.isPhoto ? (lang === 'fa' ? '📷 عکس' : '📷 Photo') : (lang === 'fa' ? 'پیام' : 'Message'));
        window.dispatchEvent(new CustomEvent('senora_message_preview', {
          detail: { conversationId: conversation.id, text: preview, messageId: last.id }
        }));
      }

      // Automatically mark conversation read up to the latest unread incoming message if window is focused
      const unreadIncoming = res.messages.filter((m: Message) => m.sender_id !== currentUser.id && !m.is_read);
      if (unreadIncoming.length > 0 && typeof document !== 'undefined' && !document.hidden) {
        const latestUnread = unreadIncoming[unreadIncoming.length - 1];
        api.markConversationRead(conversation.id, latestUnread.id).catch(() => {});
        api.recordMessageRead(conversation.id, latestUnread.id).catch(() => {});
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

  const gameEvents = useMemo<GameEvent[]>(() => messages.filter(m => m.game_action && !m.edited_at && !m.is_deleted).map(m => ({ id: m.id, actorId: m.sender_id, createdAt: m.created_at, data: m.game_action! })), [messages]);
  const sendGameAction = async (action: GameAction) => {
    const plaintext = JSON.stringify({ type: 'game_action', ...action });
    let ciphertext = plaintext; let nonce = 'normal';
    if (securityMode === 'e2ee_active') {
      const encrypted = await signalManager.encryptMultiDevice(plaintext, await getEncryptionTargets(), conversation.id, api.getToken() || undefined);
      ciphertext = encrypted.ciphertext; nonce = encrypted.nonce;
    }
    await api.submitMessage(conversation.id, { ciphertext, nonce, idempotency_key: crypto.randomUUID() });
    await loadMessages();
  };

  // Decrypted E2EE content must never be passed to a server-side preview service.
  useEffect(() => {
    if (!mediaSettings.linkPreviews || securityMode === 'e2ee_active') return;
    const abort = new AbortController();
    const requested = new Set<string>();
    messages.forEach(m => {
      if (m.nonce !== 'normal') return;
      const match = (m.plaintext || m.ciphertext || '').match(URL_REGEX);
      const url = match?.[0];
      if (!url || linkPreviews[url] || requested.has(url)) return;
      requested.add(url);
      api.getLinkPreview(url, abort.signal).then(preview => {
        if (!abort.signal.aborted && preview) setLinkPreviews(current => ({ ...current, [url]: preview }));
      }).catch(() => {});
    });
    return () => abort.abort();
  }, [messages, mediaSettings.linkPreviews, securityMode]);

  const renderLinkPreviewCard = (rawText: string) => {
    if (!mediaSettings.linkPreviews || securityMode === "e2ee_active") return null;
    if (!rawText) return null;
    const match = rawText.match(URL_REGEX);
    if (!match || match.length === 0) return null;
    const firstUrl = match[0];
    const preview = linkPreviews[firstUrl];
    if (!preview || (!preview.title && !preview.description && !preview.image_url)) {
      return null;
    }

    let domain = '';
    try {
      domain = new URL(firstUrl).hostname.replace(/^www\./, '');
    } catch {
      domain = preview.site_name || firstUrl;
    }

    return (
      <a
        href={firstUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 block bg-[#1c2733]/90 hover:bg-[#202d3b] transition border-l-2 border-[#24A1DE] rounded-r-xl p-2.5 shadow-sm select-none group/link no-underline text-inherit"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-1.5 text-[11px] font-bold text-[#24A1DE]">
          <span>{preview.site_name || domain}</span>
        </div>
        {preview.title && (
          <h4 className="text-xs font-semibold text-white mt-0.5 line-clamp-1 group-hover/link:underline">
            {preview.title}
          </h4>
        )}
        {preview.description && (
          <p className="text-[11px] text-[#7f91a4] mt-0.5 line-clamp-2 leading-tight">
            {preview.description}
          </p>
        )}
        {preview.image_url && (
          <img
            src={preview.image_url}
            alt={preview.title || domain}
            className="mt-2 max-h-44 w-full object-cover rounded-lg bg-black/20"
            onError={(e) => {
              (e.target as HTMLElement).style.display = 'none';
            }}
          />
        )}
      </a>
    );
  };

  const startSlowModeTimer = (seconds: number) => {
    setSlowModeRemaining(seconds);
    if (slowModeTimerRef.current) clearInterval(slowModeTimerRef.current);
    slowModeTimerRef.current = setInterval(() => {
      setSlowModeRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(slowModeTimerRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // Real-time WebSocket message and conversation updates
  useEffect(() => {
    loadMessages();

    const unsub = wsManager.subscribe((event) => {
      if (event.type === 'bot.callback_answer' && !event.replay && event.payload?.conversation_id === conversation.id) {
        if (event.payload.text) alert(event.payload.text);
        return;
      }
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

          // Announce live decrypted preview to sidebar
          const preview = decryptedMsg.plaintext || (decryptedMsg.attachmentMeta?.isPhoto ? (lang === 'fa' ? '📷 عکس' : '📷 Photo') : (lang === 'fa' ? 'پیام' : 'Message'));
          window.dispatchEvent(new CustomEvent('senora_message_preview', {
            detail: { conversationId: conversation.id, text: preview, messageId: decryptedMsg.id }
          }));

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
          setMessages((prev) => prev.filter((m) => m.id !== msgId));
        }
      } else if (event.type === 'reaction.updated' || event.type === 'message.reaction') {
        const msgId = event.payload?.message_id;
        let reactions: Record<string, string[]> = {};
        if (event.payload?.reactions) {
          if (typeof event.payload.reactions === 'string') {
            try {
              const p = JSON.parse(event.payload.reactions);
              if (p && typeof p === 'object' && !Array.isArray(p)) reactions = p;
            } catch {}
          } else if (typeof event.payload.reactions === 'object' && !Array.isArray(event.payload.reactions)) {
            reactions = event.payload.reactions;
          }
        }
        if (msgId) {
          setMessages((prev) =>
            prev.map((m) => (m.id === msgId ? { ...m, reactions } : m))
          );
        }
      } else if (event.type === 'message.updated') {
        const updated = event.payload as Message;
        if (updated?.id && updated.ciphertext != null) {
          void decryptSingleMessage(updated).then(decoded => {
            setMessages(prev => prev.map(m => m.id === updated.id ? { ...m, ...decoded } : m));
          });
        } else { loadMessages(); }
      } else if (event.type === 'call_event') {
        loadMessages();
      }
    });

    return () => {
      unsub();
    };
  }, [conversation.id, peerPublicKey]);

  useEffect(() => {
    setShowScrollBottom(false);
    setNewMessagesBelow(0);
    isNearBottomRef.current = true;
    prevMessagesCountRef.current = 0;
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }, 50);
  }, [conversation.id]);

  useEffect(() => {
    const prevCount = prevMessagesCountRef.current;
    prevMessagesCountRef.current = messages.length;

    if (isNearBottomRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      setNewMessagesBelow(0);
    } else {
      if (messages.length > prevCount) {
        setShowScrollBottom(true);
        setNewMessagesBelow((prev) => prev + (messages.length - prevCount));
      }
    }
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
  const handleSendMessage = async (e?: React.FormEvent, overrideText?: string) => {
    if (e) e.preventDefault();
    const text = (overrideText !== undefined ? overrideText : input).trim();
    if (!text || isSendingRef.current) return;

    if (slowModeRemaining > 0 && myRole !== 'owner' && myRole !== 'admin') {
      alert(`${t.slow_mode_wait} ${slowModeRemaining}s`);
      return;
    }

    isSendingRef.current = true;
    setSending(true);

    try {
      const isE2EE = securityMode === 'e2ee_active';

      // Detect whisper command or raw whisper payload
      let textToSend = text;
      let diceResult: DiceResult | undefined;
      if (['🎲','🎯','🏀','⚽','🎰'].includes(text)) {
        diceResult = newDiceResult(); textToSend = JSON.stringify({ type: 'dice', emoji: text, text, ...diceResult });
      }
      let whisperData: Message['whisper'] = undefined;
      const whisperMatch = text.match(/^(@whisper|\/whisper)\s+@?([a-zA-Z0-9_\-\.]+)\s+([\s\S]+)$/i);
      if (whisperMatch) {
        const targetUsername = whisperMatch[2];
        const secretText = whisperMatch[3].trim();
        whisperData = {
          target_username: targetUsername,
          secret_text: secretText,
          sender_username: currentUser.username,
          sender_id: currentUser.id,
        };
        textToSend = JSON.stringify({
          type: 'whisper',
          ...whisperData,
        });
      } else if (text.startsWith('{') && text.endsWith('}')) {
        try {
          const parsed = JSON.parse(text);
          if (parsed.type === 'whisper') {
            whisperData = {
              target_username: parsed.target_username,
              secret_text: parsed.secret_text,
              encrypted_secret: parsed.encrypted_secret,
              secret_nonce: parsed.secret_nonce,
              target_id: parsed.target_id,
              sender_username: parsed.sender_username || currentUser.username,
              sender_id: parsed.sender_id || currentUser.id,
            };
          }
        } catch {}
      }

      if (editingMessage?.whisper && !whisperData) {
        whisperData = { ...editingMessage.whisper, secret_text: text };
      }
      if (whisperData?.secret_text) {
        whisperData = await encryptWhisper(whisperData, await getEncryptionTargets(), conversation.id, currentUser.id);
        textToSend = JSON.stringify({ type: 'whisper', ...whisperData });
      }
      if (editingMessage) {
        let ciphertext = textToSend;
        if (isE2EE) {
          ciphertext = (await signalManager.encryptMultiDevice(textToSend, await getEncryptionTargets(), conversation.id, api.getToken() || undefined)).ciphertext;
        }
        await api.editMessage(conversation.id, editingMessage.id, ciphertext);
        setEditingMessage(null); setInput(''); await loadMessages(); return;
      }

      // Normal send or reply
      let finalCiphertext = textToSend;
      let finalNonce = 'normal';

      if (isE2EE) {
        const targets = await getEncryptionTargets();
        const token = api.getToken() || undefined;
        const encrypted = await signalManager.encryptMultiDevice(textToSend, targets, conversation.id, token);
        finalCiphertext = encrypted.ciphertext;
        finalNonce = encrypted.nonce;
      }

      if (overrideText === undefined) {
        setInput('');
        localStorage.removeItem('senora_draft_' + conversation.id);
      }
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
        topic_id: activeTopicId || undefined,
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        plaintext: whisperData ? '🤫 پیام نجوا (Whisper)' : text,
        whisper: whisperData,
        reply_to_id: replyId,
        created_at: new Date().toISOString(),
        status: 'sending',
        dice_result: diceResult,
      };
      setMessages((prev) => reconcileMessageList(prev, optMsg));
      scrollToBottom(true);

      const saved = await api.submitMessage(conversation.id, {
        ciphertext: finalCiphertext,
        nonce: finalNonce,
        reply_to_id: replyId,
        idempotency_key: idempotencyKey,
        topic_id: activeTopicId || undefined,
      });

      let authoritativeReactions: Record<string, string[]> = {};
      if (saved.reactions) {
        if (typeof saved.reactions === 'string') {
          try {
            const p = JSON.parse(saved.reactions);
            if (p && typeof p === 'object' && !Array.isArray(p)) authoritativeReactions = p;
          } catch {}
        } else if (typeof saved.reactions === 'object' && !Array.isArray(saved.reactions)) {
          authoritativeReactions = saved.reactions;
        }
      }

      const authoritativeMsg: Message = {
        ...optMsg,
        ...saved,
        id: saved.id,
        idempotency_key: idempotencyKey,
        plaintext: whisperData ? '🤫 پیام نجوا (Whisper)' : text,
        whisper: whisperData,
        reactions: authoritativeReactions,
        status: 'delivered',
      };

      setMessages((prev) => reconcileMessageList(prev, authoritativeMsg, optMsg.id));
      window.dispatchEvent(new CustomEvent('senora_message_preview', {
        detail: { conversationId: conversation.id, text: whisperData ? '🤫 پیام نجوا' : text, messageId: saved.id }
      }));

      // Trigger slow mode cooldown for group members
      if (conversation.type === 'group' && conversation.slow_mode_seconds && conversation.slow_mode_seconds > 0 && myRole !== 'owner' && myRole !== 'admin') {
        startSlowModeTimer(conversation.slow_mode_seconds);
      }
    } catch (err: any) {
      console.error('Failed to submit message:', err);
      const waitMatch = err.message?.match(/wait (\d+) seconds/i);
      if (waitMatch && waitMatch[1]) {
        const secs = parseInt(waitMatch[1], 10);
        startSlowModeTimer(secs);
      }
      alert(err.message || uiText("Failed to submit message", uiLang));
    } finally {
      isSendingRef.current = false;
      setSending(false);
    }
  };

  // Dedicated helper to send a Whisper secret message
  const handleSendWhisper = async (targetUsername: string, secretText: string) => {
    const cleanUser = targetUsername.trim().replace(/^@/, '');
    const whisperPayload = {
      type: 'whisper',
      target_username: cleanUser,
      secret_text: secretText.trim(),
      sender_username: currentUser.username,
      sender_id: currentUser.id,
    };
    await handleSendMessage(undefined, JSON.stringify(whisperPayload));
  };

  // Clipboard Image Paste (keyboard Ctrl+V or right-click context menu Paste)
  const handlePaste = (e: React.ClipboardEvent | ClipboardEvent) => {
    const clipboardData = (e as any).clipboardData;
    if (!clipboardData) return;

    const items = clipboardData.items;
    const imageFiles: File[] = [];

    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            const ext = file.type.split('/')[1] || 'png';
            const namedFile = new File([file], `pasted_image_${Date.now()}.${ext}`, { type: file.type });
            imageFiles.push(namedFile);
          }
        }
      }
    }

    if (imageFiles.length === 0 && clipboardData.files && clipboardData.files.length > 0) {
      for (let i = 0; i < clipboardData.files.length; i++) {
        const file = clipboardData.files[i];
        if (file.type && file.type.startsWith('image/')) {
          imageFiles.push(file);
        }
      }
    }

    if (imageFiles.length > 0) {
      e.preventDefault();
      prepareFilesForSending(imageFiles);
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
      await api.deleteMessage(conversation.id, msgId, 'everyone', messages.find(m => m.id === msgId)?.attachmentMeta?.id ? [messages.find(m => m.id === msgId)!.attachmentMeta!.id] : []);
      setMessages((prev) => prev.filter((m) => m.id !== msgId));
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
    if (!confirm(uiText("Are you sure you want to permanently delete this chat for both participants?", uiLang))) return;
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
      let finalStickerUrl = sticker.asset_url || '';

      // If stickerUrl is a DataURL (e.g. from local creator or custom sticker),
      // upload it to server so ciphertext stays lightweight (~180 bytes) and never exceeds 64KB MaxCiphertextBytes!
      if (finalStickerUrl.startsWith('data:')) {
        try {
          const res = await api.uploadStickerAsset(finalStickerUrl);
          if (res && res.url) {
            finalStickerUrl = res.url;
            sticker.asset_url = res.url;
          }
        } catch (uploadErr) {
          console.warn('Could not upload sticker asset, using existing URL if small:', uploadErr);
        }
      }

      const payload: ParsedMessagePayload = {
        text: sticker.emoji || 'Sticker',
        type: 'sticker',
        attachment: {
          isSticker: true,
          stickerPackId: pack.id,
          stickerId: sticker.id,
          stickerUrl: finalStickerUrl,
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

      // Save to recent stickers
      try {
        const savedStickers = localStorage.getItem('senora_recent_stickers');
        const list: Sticker[] = savedStickers ? JSON.parse(savedStickers) : [];
        const updated = [sticker, ...list.filter((s) => s.id !== sticker.id)].slice(0, 24);
        localStorage.setItem('senora_recent_stickers', JSON.stringify(updated));
      } catch {}

      await loadMessages();
    } catch (err: any) {
      alert(`Failed to send sticker: ${err.message}`);
    } finally {
      isSendingRef.current = false;
      setSending(false);
    }
  };

  // Client-Side Encrypted File Upload Pipeline (multi-file support & progress)
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
    // Avoid heavy in-browser media processing on files larger than 20MB to prevent browser freeze/crash
    if (file.size > 20 * 1024 * 1024) return undefined;
    try {
      if (file.type.startsWith('image/')) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 3000);
          const img = new Image();
          const url = URL.createObjectURL(file);
          img.onload = () => {
            clearTimeout(timer);
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
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            resolve(undefined);
          };
          img.src = url;
        });
      } else if (file.type.startsWith('video/')) {
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 3000);
          const video = document.createElement('video');
          const url = URL.createObjectURL(file);
          video.preload = 'metadata';
          video.muted = true;
          video.playsInline = true;
          video.onloadeddata = () => {
            video.currentTime = 0.1;
          };
          video.onseeked = () => {
            clearTimeout(timer);
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
            clearTimeout(timer);
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

  const compressImageIfNeeded = async (rawFile: File): Promise<File> => {
    // Only compress standard images that exceed 1MB and are not animated GIFs
    if (!rawFile.type.startsWith('image/') || rawFile.type.includes('gif') || rawFile.size <= 1024 * 1024) {
      return rawFile;
    }

    return new Promise((resolve) => {
      try {
        const img = new Image();
        const objectUrl = URL.createObjectURL(rawFile);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          const canvas = document.createElement('canvas');
          let { width, height } = img;
          const maxDimension = 1920;

          if (width > maxDimension || height > maxDimension) {
            if (width > height) {
              height = Math.round((height * maxDimension) / width);
              width = maxDimension;
            } else {
              width = Math.round((width * maxDimension) / height);
              height = maxDimension;
            }
          }

          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(rawFile);
            return;
          }

          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob(
            (blob) => {
              if (blob && blob.size < rawFile.size) {
                const compressedName = rawFile.name.replace(/\.[^/.]+$/, '') + '.webp';
                const compressedFile = new File([blob], compressedName, { type: 'image/webp' });
                resolve(compressedFile);
              } else {
                resolve(rawFile);
              }
            },
            'image/webp',
            0.85
          );
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          resolve(rawFile);
        };
        img.src = objectUrl;
      } catch {
        resolve(rawFile);
      }
    });
  };

  const sendSingleFile = async (
    inputFile: File,
    caption: string,
    isViewOnce?: boolean,
    fileIndex: number = 0,
    totalFiles: number = 1
  ) => {
    const file = await compressImageIfNeeded(inputFile);
    const isE2EE = securityMode === 'e2ee_active';
    let att: any;
    let keyBase64 = '';
    let ivBase64 = '';

    const handleProgress = (percent: number, loaded: number, total: number) => {
      let filePercent = percent;
      if (total > 0 && typeof loaded === 'number') {
        filePercent = Math.min(100, Math.max(0, Math.round((loaded / total) * 100)));
      } else if (typeof percent === 'number') {
        filePercent = Math.min(100, Math.max(0, Math.round(percent)));
      }
      if (totalFiles > 1) {
        const batchPercent = Math.min(
          100,
          Math.max(0, Math.round(((fileIndex + filePercent / 100) / totalFiles) * 100))
        );
        setUploadProgress(batchPercent);
      } else {
        setUploadProgress(filePercent);
      }
    };

    if (isE2EE) {
      const encryptedFile = await signalManager.encryptAttachment(file);
      att = await api.uploadAttachmentWithProgress(
        conversation.id,
        encryptedFile.encryptedBlob,
        file.name,
        true,
        handleProgress,
        uploadAbortControllerRef.current?.signal,
        isViewOnce
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
        handleProgress,
        uploadAbortControllerRef.current?.signal,
        isViewOnce
      );
    }

    if (att?.id) {
      try {
        const localUrl = URL.createObjectURL(file);
        setDecryptedMediaUrls((prev) => ({
          ...prev,
          [att.id]: localUrl,
        }));
      } catch {}
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
        isViewOnce,
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
        attachment_ids: [att.id],
      topic_id: activeTopicId || undefined,
    });
  };

  const sendMultipleFiles = async (files: File[], caption: string, isViewOnce?: boolean) => {
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
        await sendSingleFile(file, itemCaption, isViewOnce, i, files.length);
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
        attachment_ids: [att.id],
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

  // Client-Side Decrypt and Download Attachment
  const handleDownloadAttachment = async (attMeta: any) => {
    if (!attMeta?.id) return;
    setDownloadingAttId(attMeta.id);
    try {
      const mediaURL = await getOrLoadDecryptedUrl(attMeta.id, attMeta);
      if (!mediaURL) throw new Error('Attachment is unavailable');
      const isStream = !mediaURL.startsWith('blob:');
      const downloadURL = new URL(mediaURL, window.location.origin);
      if (isStream) downloadURL.searchParams.set('download', 'true');

      let filename = attMeta.filename;
      if (!filename) {
        if (attMeta.isVoice) filename = `voice_note_${Date.now()}.webm`;
        else if (attMeta.isRoundVideo) filename = `video_note_${Date.now()}.mp4`;
        else if (attMeta.isPhoto) filename = `photo_${Date.now()}.jpg`;
        else if (attMeta.isVideo) filename = `video_${Date.now()}.mp4`;
        else filename = `attachment_${Date.now()}.bin`;
      }

      const url = isStream ? downloadURL.toString() : mediaURL;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

    } catch (e: any) {
      alert(`Decryption/download error: ${e.message}`);
    } finally {
      setDownloadingAttId(null);
    }
  };

  // Get or Load Decrypted Media Blob URL
  const mediaLoads = useRef(new Map<string, Promise<string | undefined>>());
  const mediaCache = useRef<Record<string,string>>({});
  // Shared work prevents parallel renderers from consuming a view-once file twice.
  const getOrLoadDecryptedUrl = async (msgId: string, attMeta: any): Promise<string | undefined> => {
    if (!attMeta?.id) return undefined;
    const key = attMeta.id;
    // Unencrypted media is served by the authenticated Range endpoint. Opening
    // a video must not download the entire file into a JavaScript Blob first.
    if (!attMeta.keyBase64 && !attMeta.ivBase64 && !attMeta.isViewOnce) {
      const url = api.attachmentStreamURL(key);
      setDecryptedMediaUrls(prev => ({ ...prev, [msgId]: url, [key]: url }));
      return url;
    }
    const cached = mediaCache.current[key] || decryptedMediaUrls[msgId] || decryptedMediaUrls[key];
    if (cached) return cached;
    const existing = mediaLoads.current.get(key);
    if (existing) return existing;
    const pending = (async () => {
      setDownloadingAttId(key);
      try {
        const blob = await api.downloadAttachment(key);
        const finalBlob = attMeta.keyBase64 && attMeta.ivBase64
          ? await signalManager.decryptAttachment(blob, attMeta.keyBase64, attMeta.ivBase64, attMeta.contentType)
          : blob;
        const url = URL.createObjectURL(finalBlob);
        mediaCache.current[key] = url;
        setDecryptedMediaUrls(prev => ({...prev, [msgId]:url, [key]:url}));
        return url;
      } catch (e) {
        console.warn('Failed to decrypt media:',e);
        return undefined;
      } finally { setDownloadingAttId(null); }
    })();
    mediaLoads.current.set(key,pending);
    try { return await pending; } finally { mediaLoads.current.delete(key); }
  };

  const autoLoadingMediaIdsRef = useRef<Set<string>>(new Set());

  // Auto-load media blobs for photos, stickers, and voice notes so they render automatically
  useEffect(() => {
    messages.forEach((m) => {
      const att = m.attachmentMeta;
      if (!att || !att.id || !shouldAutoDownload(mediaSettings, att)) return;
      if (decryptedMediaUrls[m.id] || decryptedMediaUrls[att.id] || autoLoadingMediaIdsRef.current.has(m.id)) return;

      // Do NOT auto-download large media files (> 20MB) into browser RAM; user can click to play/download on-demand
      if (att.sizeBytes && att.sizeBytes > 20 * 1024 * 1024) return;

      const isMedia =
        att.isPhoto ||
        att.isVideo ||
        att.isRoundVideo ||
        att.isVoice ||
        att.isSticker ||
        att.contentType?.startsWith('image/') ||
        att.contentType?.startsWith('video/') ||
        att.contentType?.startsWith('audio/') ||
        att.filename?.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg|mp4|webm|ogg|mp3|wav|m4a)$/i);

      if (isMedia || mediaSettings.autoDownloadFiles) {
        autoLoadingMediaIdsRef.current.add(m.id);
        getOrLoadDecryptedUrl(m.id, att).finally(() => {
          autoLoadingMediaIdsRef.current.delete(m.id);
        });
      }
    });
  }, [messages, decryptedMediaUrls, mediaSettings]);

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
      date: new Date(msg.created_at).toLocaleString(uiLang === 'fa' ? 'fa-IR' : 'en-US'),
      caption: msg.attachmentMeta?.caption,
      currentIndex: idx >= 0 ? idx : 0,
      totalCount: mediaMsgs.length,
      attachmentId: msg.attachmentMeta?.id,
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
        date: new Date(prevMsg.created_at).toLocaleString(uiLang === 'fa' ? 'fa-IR' : 'en-US'),
        caption: prevMsg.attachmentMeta?.caption,
        currentIndex: curIdx - 1,
        totalCount: mediaMsgs.length,
        attachmentId: prevMsg.attachmentMeta?.id,
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
        date: new Date(nextMsg.created_at).toLocaleString(uiLang === 'fa' ? 'fa-IR' : 'en-US'),
        caption: nextMsg.attachmentMeta?.caption,
        currentIndex: curIdx + 1,
        totalCount: mediaMsgs.length,
        attachmentId: nextMsg.attachmentMeta?.id,
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
      await api.deleteMessage(conversation.id, msg.id, 'everyone', msg.attachmentMeta?.id ? [msg.attachmentMeta.id] : []);
      setMessages((prev) => prev.filter((m) => m.id !== msg.id));
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
      alert(uiText("Saved to Saved Messages", uiLang));
    } catch (err: any) {
      console.error('Failed to save message:', err);
      alert(uiText("Failed to save message: ", uiLang) + err.message);
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
      alert(uiText("Failed to save messages: ", uiLang) + err.message);
    } finally {
      setSelectionMode(false);
      setSelectedMsgIds(new Set());
    }
  };

  // Voice Note Recording Pipeline with live audio waveform analysis
  const startVoiceRecording = async () => {
    try {
      const stream = await mediaDeviceManager.getAudioStream();
      const mimeType = (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'))
        ? 'audio/webm;codecs=opus'
        : (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/ogg;codecs=opus'))
        ? 'audio/ogg;codecs=opus'
        : '';
      const recorderOptions: MediaRecorderOptions = {
        audioBitsPerSecond: 128000,
      };
      if (mimeType) {
        recorderOptions.mimeType = mimeType;
      }
      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = new MediaRecorder(stream, recorderOptions);
      } catch {
        mediaRecorder = new MediaRecorder(stream);
      }
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

  const resetVoiceRecordingState = () => {
    if (previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl);
    }
    setPreviewAudioUrl(null);
    recordedVoiceBlobRef.current = null;
    setIsRecording(false);
    setIsRecordingLocked(false);
    setIsRecordingPaused(false);
    setPreviewAudioPlaying(false);
    setPreviewAudioCurrentTime(0);
    audioChunksRef.current = [];
  };

  const sendRecordedVoiceBlob = async (audioBlob: Blob) => {
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
        attachment_ids: [att.id],
        });
      } else {
        await api.submitMessage(conversation.id, {
          ciphertext: JSON.stringify(payload),
          nonce: 'normal',
          idempotency_key: idempotencyKey,
        attachment_ids: [att.id],
        });
      }

      if (conversation.type === 'group' && conversation.slow_mode_seconds && conversation.slow_mode_seconds > 0 && myRole !== 'owner' && myRole !== 'admin') {
        startSlowModeTimer(conversation.slow_mode_seconds);
      }

      await loadMessages();
    } catch (err: any) {
      alert(`Failed to send voice note: ${err.message}`);
    } finally {
      isSendingRef.current = false;
      setSending(false);
      resetVoiceRecordingState();
    }
  };

  const pauseVoiceRecordingForPreview = () => {
    if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') return;
    clearInterval(recordingTimerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);

    mediaRecorderRef.current.onstop = () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      audioChunksRef.current = [];
      recordedVoiceBlobRef.current = audioBlob;
      const url = URL.createObjectURL(audioBlob);
      setPreviewAudioUrl(url);
      setIsRecordingPaused(true);
      setIsRecordingLocked(true);
    };

    mediaRecorderRef.current.stop();
    mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
  };

  const togglePreviewPlay = () => {
    const p = previewAudioPlayerRef.current;
    if (!p) return;
    if (p.paused) {
      p.play().catch(console.warn);
      setPreviewAudioPlaying(true);
    } else {
      p.pause();
      setPreviewAudioPlaying(false);
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

    if (!shouldSend) {
      mediaRecorderRef.current.onstop = () => {
        resetVoiceRecordingState();
      };
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current.stream.getTracks().forEach((track) => track.stop());
      resetVoiceRecordingState();
      return;
    }

    mediaRecorderRef.current.onstop = async () => {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      audioChunksRef.current = [];
      await sendRecordedVoiceBlob(audioBlob);
    };

    if (mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
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

    if (showMentionSuggestions && mentionSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMentionIndex((prev) => (prev + 1) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMentionIndex((prev) => (prev - 1 + mentionSuggestions.length) % mentionSuggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectMention(mentionSuggestions[selectedMentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionSuggestions(false);
        return;
      }
    }

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

  // Multiple pinned messages
  const pinnedMessages = messages.filter((m) => m.is_pinned);
  const pinnedMessage = pinnedMessages.length > 0 ? pinnedMessages[currentPinIndex % pinnedMessages.length] : undefined;

  // Filter messages for search query, media types, calendar date, and active forum topic
  const displayedMessages = messages.filter((m) => {
    if (m.game_action) return false;
    // 1. Forum Topic Filter
    if (isForum && activeTopicId && m.topic_id !== activeTopicId) {
      return false;
    }

    // 2. Text Search Query
    if (chatSearchQuery.trim()) {
      const q = chatSearchQuery.toLowerCase();
      const matchText = m.plaintext?.toLowerCase().includes(q);
      const matchFilename = m.attachmentMeta?.filename?.toLowerCase().includes(q);
      const matchSender = m.sender_username?.toLowerCase().includes(q);
      if (!matchText && !matchFilename && !matchSender) return false;
    }

    // 3. Search Media Type Filter
    if (searchMediaType === 'media') {
      if (!m.attachmentMeta?.isPhoto && !m.attachmentMeta?.isVideo) return false;
    } else if (searchMediaType === 'files') {
      if (!m.attachmentMeta || m.attachmentMeta.isPhoto || m.attachmentMeta.isVideo || m.attachmentMeta.isVoice || m.attachmentMeta.isRoundVideo || m.attachmentMeta.isSticker) return false;
    } else if (searchMediaType === 'voice') {
      if (!m.attachmentMeta?.isVoice && !m.attachmentMeta?.isRoundVideo) return false;
    } else if (searchMediaType === 'links') {
      if (!m.plaintext || !/(https?:\/\/[^\s]+)/.test(m.plaintext)) return false;
    }

    // 4. Calendar Date Filter
    if (searchDate) {
      if (!m.created_at || !m.created_at.startsWith(searchDate)) return false;
    }

    return true;
  });

  return (
    <div
      className="flex-1 flex flex-col h-full max-h-[100dvh] w-full min-w-0 bg-[#0e1621] relative select-text text-white overflow-hidden"
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
            {lang === "fa" ? 'فایل‌ها را اینجا رها کنید تا ارسال شوند' : 'Drop files here to send'}
          </p>
          <p className="text-xs text-[#7f91a4] mt-1">
            {lang === "fa" ? 'تصاویر، ویدیوها، صوت‌ها و انواع فایل‌ها' : 'Images, videos, audio, and documents'}
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
      <header className="min-h-[3.5rem] h-[calc(3.5rem+env(safe-area-inset-top,0px))] pt-[env(safe-area-inset-top,0px))] px-2.5 sm:px-4 bg-[#17212b] border-b border-[#101921] flex items-center justify-between select-none z-20 flex-shrink-0 w-full max-w-full">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1 mr-1 rtl:mr-0 rtl:ml-1">
          {onBack && (
            <button
              id="chat-back-btn"
              onClick={onBack}
              aria-label={lang === "fa" ? 'بازگشت به گفتگوها' : 'Back to conversations'}
              title={lang === "fa" ? 'خروج از چت و بازگشت' : 'Back to conversations'}
              className="p-2 ltr:-ml-1 rtl:-mr-1 rounded-xl hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer flex-shrink-0 flex items-center justify-center lg:hidden"
            >
              <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
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
            title={!isGroup && !isChannel && peerUser ? uiText("View User Profile", uiLang) : uiText("View Chat Details", uiLang)}
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
                  <span>{lang === "fa" ? 'فضای ابری شخصی' : 'Personal cloud storage'}</span>
                ) : isChannel ? (
                  <span>{conversation.participants ? `${conversation.participants.length} ${uiText('subscribers', uiLang)}` : uiText("Channel • Broadcast", uiLang)}</span>
                ) : isGroup ? (
                  <span>{uiText("Group • ", uiLang)}{conversation.participants?.length || conversationMembers.length || 2}{uiText(" members", uiLang)}</span>
                ) : peerTyping ? (
                  <span className="text-[#24A1DE] font-semibold animate-pulse">{uiText("typing...", uiLang)}</span>
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
        {/* Desktop View (lg:flex) */}
        <div className="hidden lg:flex items-center gap-1 flex-shrink-0">
          {!isChannel && peerUser && (
            <>
              <button
                type="button"
                onClick={() =>
                  webrtcManager.startCall(
                    conversation.id,
                    peerUser.id,
                    peerUser.display_name || peerUser.username,
                    'audio',
                    peerUser.avatar_url,
                    currentUser.avatar_url,
                    currentUser.display_name || currentUser.username
                  )
                }
                className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-emerald-400 transition cursor-pointer"
                title={uiText("Voice Call", uiLang)}
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
                    'video',
                    peerUser.avatar_url,
                    currentUser.avatar_url,
                    currentUser.display_name || currentUser.username
                  )
                }
                className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-[#24A1DE] transition cursor-pointer"
                title={uiText("Video Call", uiLang)}
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
            title={uiText("Shared Media & Files", uiLang)}
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
            title={uiText("Select Messages", uiLang)}
          >
            <CheckSquare className="h-4 w-4" />
          </button>

          <button
            id="search-chat-btn"
            onClick={() => setShowSearch(!showSearch)}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
            title={uiText("Search in chat", uiLang)}
          >
            <Search className="h-4 w-4" />
          </button>

          {/* Group Voice Chat Button */}
          {isGroup && (
            <button
              type="button"
              onClick={() => setShowVoiceChatModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 hover:bg-emerald-500/25 transition text-xs font-semibold text-emerald-400 cursor-pointer"
              title={uiText("Group Voice Chat", uiLang)}
            >
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              <span className="hidden sm:inline">{uiText("Voice Chat", uiLang)}</span>
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
            title={!isGroup && !isChannel && peerUser ? uiText("User Profile", uiLang) : uiText("Chat Info", uiLang)}
          >
            <Info className="h-4 w-4" />
          </button>

          {/* Security Mode Badge */}
          {securityMode === 'e2ee_active' ? (
            <button
              onClick={() => setShowSecurityModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/20 transition text-xs font-semibold text-emerald-400 cursor-pointer"
              title={uiText("End-to-End Encrypted (Signal Protocol)", uiLang)}
            >
              <Lock className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{uiText("E2EE Chat", uiLang)}</span>
            </button>
          ) : (
            <button
              onClick={() => setShowModeModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/30 hover:bg-blue-500/20 transition text-xs font-medium text-[#24A1DE] cursor-pointer"
              title={uiText("Normal Chat (Standard Encryption)", uiLang)}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{uiText("Normal Chat", uiLang)}</span>
            </button>
          )}

          {/* Delete Chat Button */}
          <button
            onClick={() => setShowDeleteChatModal(true)}
            className="p-2 rounded-lg hover:bg-red-500/10 text-[#7f91a4] hover:text-red-400 transition cursor-pointer"
            title={uiText("Delete Chat", uiLang)}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        {/* Mobile View (flex lg:hidden) */}
        <div className="flex lg:hidden items-center gap-1 flex-shrink-0 relative">
          {!isChannel && peerUser && (
            <button
              type="button"
              onClick={() =>
                webrtcManager.startCall(
                  conversation.id,
                  peerUser.id,
                  peerUser.display_name || peerUser.username,
                  'audio',
                  peerUser.avatar_url,
                  currentUser.avatar_url,
                  currentUser.display_name || currentUser.username
                )
              }
              className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-emerald-400 transition cursor-pointer"
              title={uiText("Voice Call", uiLang)}
            >
              <Phone className="h-4 w-4" />
            </button>
          )}
          <button
            id="mobile-search-chat-btn"
            onClick={() => setShowSearch(!showSearch)}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
            title={uiText("Search in chat", uiLang)}
          >
            <Search className="h-4 w-4" />
          </button>
          <button
            id="chat-mobile-more-btn"
            type="button"
            onClick={() => setShowMobileHeaderMenu(!showMobileHeaderMenu)}
            className="p-2 rounded-lg hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
            title={uiText("More actions", uiLang)}
          >
            <MoreVertical className="h-4 w-4" />
          </button>

          {/* Mobile Dropdown Menu */}
          {showMobileHeaderMenu && (
            <div
              id="chat-mobile-header-menu"
              className="absolute ltr:right-0 rtl:left-0 top-11 w-56 bg-[#17212b] border border-[#242f3d] rounded-2xl shadow-2xl py-1.5 z-50 animate-fadeIn text-xs"
              onClick={() => setShowMobileHeaderMenu(false)}
            >
              {onBack && (
                <button
                  type="button"
                  id="chat-mobile-exit-btn"
                  onClick={() => {
                    setShowMobileHeaderMenu(false);
                    onBack();
                  }}
                  className="w-full px-3 py-2 text-left rtl:text-right text-xs text-amber-400 hover:text-amber-300 hover:bg-[#202b36] flex items-center gap-2 cursor-pointer border-b border-[#242f3d]/60 font-semibold"
                >
                  <ArrowLeft className="h-4 w-4 rtl:rotate-180" />
                  <span>{lang === "fa" ? 'خروج از گفتگو و بازگشت' : 'Exit Conversation'}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowSharedMedia(true)}
                className="w-full px-3 py-2 text-left text-xs text-[#7f91a4] hover:text-white hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
              >
                <Folder className="h-4 w-4 text-[#24A1DE]" />
                <span>{uiText("Shared Media & Files", uiLang)}</span>
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
                <span>{selectionMode ? uiText("Cancel Selection", uiLang) : uiText("Select Messages", uiLang)}</span>
              </button>
              {isGroup && (
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      const res = await api.toggleConversationForum(conversation.id, !isForum);
                      setIsForum(res.is_forum);
                      if (res.is_forum) {
                        const topRes = await api.getConversationTopics(conversation.id);
                        setForumTopics(topRes.topics || []);
                      }
                    } catch (e: any) {
                      alert(e.message || uiText("Failed to toggle forum", uiLang));
                    }
                  }}
                  className="w-full px-3 py-2 text-left text-xs text-[#24A1DE] hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
                >
                  <Hash className="h-4 w-4" />
                  <span>{isForum ? (lang === "fa" ? 'غیرفعال‌سازی تاپیک‌های انجمن' : 'Disable Forum Topics') : (lang === "fa" ? 'فعال‌سازی تاپیک‌های انجمن (سوپرگروه)' : 'Enable Forum Topics')}</span>
                </button>
              )}
              {!isChannel && peerUser && (
                <button
                  type="button"
                  onClick={() =>
                    webrtcManager.startCall(
                      conversation.id,
                      peerUser.id,
                      peerUser.display_name || peerUser.username,
                      'video',
                      peerUser.avatar_url,
                      currentUser.avatar_url,
                      currentUser.display_name || currentUser.username
                    )
                  }
                  className="w-full px-3 py-2 text-left text-xs text-[#24A1DE] hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
                >
                  <Video className="h-4 w-4" />
                  <span>{uiText("Video Call", uiLang)}</span>
                </button>
              )}
              {isGroup && (
                <button
                  type="button"
                  onClick={() => setShowVoiceChatModal(true)}
                  className="w-full px-3 py-2 text-left text-xs text-emerald-400 hover:bg-[#202b36] flex items-center gap-2 cursor-pointer"
                >
                  <Radio className="h-4 w-4" />
                  <span>{uiText("Group Voice Chat", uiLang)}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setShowMobileHeaderMenu(false);
                  setWatchPartyOpen(true);
                }}
                className="w-full px-3 py-2 text-left rtl:text-right text-xs text-indigo-400 hover:bg-[#202b36] flex items-center gap-2 cursor-pointer font-medium"
              >
                <Film className="h-4 w-4" />
                <span>{t.watch_party}</span>
              </button>
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
                <span>{!isGroup && !isChannel && peerUser ? uiText("User Profile", uiLang) : uiText("Chat Info & Details", uiLang)}</span>
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
                    <span className="text-emerald-400 font-medium">{uiText("Signal E2EE Active", uiLang)}</span>
                  </>
                ) : (
                  <>
                    <ShieldCheck className="h-4 w-4 text-[#24A1DE]" />
                    <span className="text-[#24A1DE] font-medium">{uiText("Normal Mode", uiLang)}</span>
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
                <span>{uiText("Delete Conversation", uiLang)}</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Active Watch Party Live Banner */}
      {activeWatchPartySession && (
        <div className="flex items-center justify-between px-4 py-2 bg-gradient-to-r from-indigo-950/90 via-purple-950/80 to-slate-900 border-b border-indigo-500/30 backdrop-blur-md animate-fade-in z-20">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
            </span>
            <Film className="w-4 h-4 text-indigo-400 shrink-0" />
            <div className="text-xs text-white truncate">
              <span className="font-bold">{t.watch_party_active}: </span>
              <span className="text-indigo-200">{activeWatchPartySession.media_title}</span>
              <span className="text-[11px] text-slate-400 mr-1.5">({activeWatchPartySession.leader_name})</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setWatchPartyMediaUrl(activeWatchPartySession.media_url);
              setWatchPartyMediaTitle(activeWatchPartySession.media_title);
              setWatchPartyOpen(true);
            }}
            className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm transition flex items-center gap-1 cursor-pointer shrink-0"
          >
            <Play className="w-3 h-3 fill-white" />
            <span>{t.join_watch_party}</span>
          </button>
        </div>
      )}

      {/* In-Chat Search Bar with Media Type & Date Filter */}
      {showSearch && (
        <div className="bg-[#17212b] border-b border-[#242f3d] flex flex-col animate-fade-in z-10">
          <div className="px-4 py-2 flex items-center gap-2">
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
                  setSearchMediaType('all');
                  setSearchDate('');
                }
              }}
              placeholder={lang === "fa" ? 'جستجوی پیام‌ها در این چت...' : 'Search messages in this chat...'}
              className="flex-1 bg-transparent text-xs text-white placeholder-[#7f91a4] focus:outline-none"
              autoFocus
            />
            {chatSearchQuery && (
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] text-[#7f91a4]">
                  {displayedMessages.length === 0
                    ? '0 / 0'
                    : `${searchMatchIndex + 1} / ${displayedMessages.length}`}
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
                  title={uiText("Previous result", uiLang)}
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
                  title={uiText("Next result", uiLang)}
                >
                  <ChevronDown className="h-4 w-4" />
                </button>
              </div>
            )}
            <button
              onClick={() => {
                setShowSearch(false);
                setChatSearchQuery('');
                setSearchMediaType('all');
                setSearchDate('');
              }}
              className="p-1 text-[#7f91a4] hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Media Type Tabs & Calendar Date Filter Strip */}
          <div className="px-4 pb-2 pt-0.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#242f3d]/60 bg-[#141d26]">
            <div className="flex items-center gap-1 text-[11px] overflow-x-auto no-scrollbar">
              {(['all', 'media', 'files', 'voice', 'links'] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setSearchMediaType(tab);
                    setSearchMatchIndex(0);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-medium transition cursor-pointer ${
                    searchMediaType === tab
                      ? 'bg-[#24A1DE] text-white shadow'
                      : 'text-[#7f91a4] hover:text-white hover:bg-[#242f3d]'
                  }`}
                >
                  {tab === 'all'
                    ? (lang === "fa" ? uiText("همه", uiLang) : uiText("All", uiLang))
                    : tab === 'media'
                    ? (lang === "fa" ? '📷 عکس/فیلم' : '📷 Media')
                    : tab === 'files'
                    ? (lang === "fa" ? '📄 فایل‌ها' : '📄 Files')
                    : tab === 'voice'
                    ? (lang === "fa" ? '🎵 صوت' : '🎵 Voice')
                    : (lang === "fa" ? '🔗 لینک‌ها' : '🔗 Links')}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 bg-[#17212b] px-2 py-1 rounded-lg border border-[#242f3d]">
              <Calendar className="h-3.5 w-3.5 text-[#24A1DE]" />
              <input
                type="date"
                value={searchDate}
                onChange={(e) => {
                  setSearchDate(e.target.value);
                  setSearchMatchIndex(0);
                }}
                className="bg-transparent text-[11px] text-white focus:outline-none cursor-pointer"
                title={lang === "fa" ? 'فیلتر بر اساس تاریخ' : 'Filter by date'}
              />
              {searchDate && (
                <button
                  type="button"
                  onClick={() => setSearchDate('')}
                  className="text-[#7f91a4] hover:text-white text-[11px] px-1"
                  title={uiText("Clear date", uiLang)}
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Supergroup Forum Topics Tab Bar */}
      {isForum && (
        <div className="bg-[#17212b] border-b border-[#242f3d] px-4 py-2 flex items-center gap-2 overflow-x-auto no-scrollbar z-10 select-none">
          <button
            type="button"
            onClick={() => setActiveTopicId(null)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
              activeTopicId === null
                ? 'bg-[#24A1DE] text-white shadow-md'
                : 'bg-[#242f3d] text-[#7f91a4] hover:text-white hover:bg-[#2b3a4a]'
            }`}
          >
            <span>💬</span>
            <span>{lang === "fa" ? 'همه پیام‌ها' : 'All Messages'}</span>
          </button>

          {forumTopics.map((topic) => (
            <button
              key={topic.id}
              type="button"
              onClick={() => setActiveTopicId(topic.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold flex items-center gap-1.5 transition whitespace-nowrap cursor-pointer ${
                activeTopicId === topic.id
                  ? 'text-white shadow-md'
                  : 'bg-[#242f3d] text-[#7f91a4] hover:text-white hover:bg-[#2b3a4a]'
              }`}
              style={activeTopicId === topic.id ? { backgroundColor: topic.color || '#24A1DE' } : {}}
            >
              <span>{topic.icon || '📌'}</span>
              <span>{topic.title}</span>
            </button>
          ))}

          <button
            type="button"
            onClick={() => setShowNewTopicModal(true)}
            className="px-2.5 py-1.5 rounded-full text-xs font-bold bg-[#242f3d]/60 hover:bg-[#242f3d] text-[#24A1DE] border border-dashed border-[#24A1DE]/40 flex items-center gap-1 transition whitespace-nowrap cursor-pointer"
            title={lang === "fa" ? 'ایجاد تاپیک جدید' : 'New Topic'}
          >
            <span>+</span>
            <span>{lang === "fa" ? 'تاپیک جدید' : 'New Topic'}</span>
          </button>
        </div>
      )}

      {/* Pinned Messages Banner (Multiple Pins + Cycle & Drawer) */}
      {pinnedMessages.length > 0 && pinnedMessage && (
        <div
          onClick={() => {
            const nextIdx = (currentPinIndex + 1) % pinnedMessages.length;
            setCurrentPinIndex(nextIdx);
            const target = pinnedMessages[nextIdx];
            const el = document.getElementById(`msg-${target.id}`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }}
          className="bg-[#182533] border-b border-[#242f3d] px-4 py-2 flex items-center justify-between text-xs cursor-pointer hover:bg-[#202f40] transition z-10 select-none"
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <Pin className="h-3.5 w-3.5 text-[#24A1DE] flex-shrink-0 animate-pulse" />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-[#24A1DE] block text-[11px]">
                  {lang === "fa"
                    ? (pinnedMessages.length > 1
                      ? `پیام سنجاق شده (${(currentPinIndex % pinnedMessages.length) + 1} از ${pinnedMessages.length})`
                      : 'پیام سنجاق شده')
                    : (pinnedMessages.length > 1
                      ? `Pinned Message (${(currentPinIndex % pinnedMessages.length) + 1} of ${pinnedMessages.length})`
                      : uiText("Pinned Message", uiLang))}
                </span>
                {pinnedMessages.length > 1 && (
                  <span className="text-[10px] text-[#7f91a4] font-mono">{uiText("(کلیک برای بعدی)", uiLang)}</span>
                )}
              </div>
              <p className="text-[#7f91a4] truncate text-xs">
                {pinnedMessage.plaintext || (pinnedMessage.attachmentMeta?.filename || uiText("Attachment", uiLang))}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {pinnedMessages.length > 1 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowPinsDrawer(true);
                }}
                className="p-1 text-[#24A1DE] hover:text-white bg-[#242f3d]/60 rounded-lg flex items-center gap-1 text-[11px] px-2 cursor-pointer"
                title={lang === "fa" ? 'مشاهده همه سنجاق‌ها' : 'View all pinned messages'}
              >
                <Layers className="h-3.5 w-3.5" />
                <span>{pinnedMessages.length}</span>
              </button>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleTogglePin(pinnedMessage);
              }}
              className="p-1 text-[#7f91a4] hover:text-white cursor-pointer"
              title={t.unpin}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
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
                ? uiText("Verified Identity", uiLang)
                : verificationState === 'key_changed'
                ? uiText("Identity Key Changed!", uiLang)
                : t.e2ee_verified}
            </h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">{t.e2ee_desc}</p>

            {safetyNumber && (
              <div className="p-3 rounded-xl bg-[#0e1621] border border-[#242f3d] mb-4 text-left">
                <span className="text-[10px] text-[#24A1DE] font-semibold uppercase tracking-wider block mb-1">{uiText("Signal Safety Number (Out-of-Band Verification)", uiLang)}</span>
                <div className="font-mono text-xs tracking-wider font-bold text-emerald-400 select-all break-all bg-[#17212b] p-2 rounded-lg border border-[#242f3d]">
                  {safetyNumber}
                </div>
                <p className="text-[10px] text-[#7f91a4] mt-1.5 leading-normal">{uiText("Both you and", uiLang)}{chatTitle}{uiText("have the same safety number. Compare in person or over a secure channel to verify zero tampering.", uiLang)}</p>
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
                    ? uiText("Revoke Verification", uiLang)
                    : uiText("Mark as Verified (Confirm Identity)", uiLang)}
                </span>
              </button>
            )}

            <button
              onClick={() => setShowSecurityModal(false)}
              className="w-full rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] py-2 text-xs font-semibold text-white cursor-pointer transition"
            >{uiText("Close", uiLang)}</button>
          </div>
        </div>
      )}

      {/* Security Mode Modal */}
      {showModeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center">
            <div className="h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 bg-blue-500/20 text-[#24A1DE]">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">{uiText("Normal Chat (Standard Security)", uiLang)}</h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">{uiText("In normal mode, messages and attachments are sent over TLS and processed and stored by the server. Server-side search, history backup, and multi-device synchronization are available.", uiLang)}</p>

            {!isChannel && !isGroup && peerUser && securityMode !== 'e2ee_active' && (
              <div className="p-3 rounded-xl bg-[#0e1621] border border-[#242f3d] mb-4 text-left">
                <span className="text-[10px] text-emerald-400 font-semibold uppercase tracking-wider block mb-1">{uiText("Optional End-to-End Encryption", uiLang)}</span>
                <p className="text-[11px] text-[#7f91a4] mb-3 leading-normal">{uiText("You can upgrade this chat to Signal Protocol End-to-End Encryption. Only you and", uiLang)}{peerUser.display_name || peerUser.username}{uiText("will be able to read message contents.", uiLang)}</p>
                <button
                  type="button"
                  onClick={handleActivateE2EE}
                  disabled={activatingE2EE}
                  className="w-full py-2.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold flex items-center justify-center gap-2 transition cursor-pointer shadow-md"
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span>{activatingE2EE ? uiText("Verifying & Activating...", uiLang) : uiText("Enable End-to-End Encryption", uiLang)}</span>
                </button>
              </div>
            )}

            <button
              onClick={() => setShowModeModal(false)}
              className="w-full rounded-xl bg-[#242f3d] hover:bg-[#202b36] py-2 text-xs font-semibold text-white cursor-pointer transition"
            >{uiText("Close", uiLang)}</button>
          </div>
        </div>
      )}

      {/* Delete Message Modal */}
      {deleteTargetMsg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center">
            <div className="h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 bg-red-500/20 text-red-400">
              <Trash2 className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">{uiText("Delete Message", uiLang)}</h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">{uiText("Select how you would like to delete this message.", uiLang)}</p>

            <div className="space-y-2 mb-4">
              <button
                type="button"
                onClick={executeDeleteForMe}
                className="w-full py-2.5 px-3 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-semibold transition cursor-pointer"
              >{uiText("Delete for Me", uiLang)}</button>

              {(deleteTargetMsg.sender_id === currentUser.id || conversation.type === 'channel' || conversation.type === 'direct' || myRole === 'owner' || myRole === 'admin') && (
                <button
                  type="button"
                  onClick={executeDeleteForEveryone}
                  className="w-full py-2.5 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition cursor-pointer shadow-md"
                >{uiText("Delete for Everyone", uiLang)}</button>
              )}
            </div>

            <button
              onClick={() => setDeleteTargetMsg(null)}
              className="text-xs text-[#7f91a4] hover:text-white transition cursor-pointer"
            >{uiText("Cancel", uiLang)}</button>
          </div>
        </div>
      )}

      {/* Delete Chat Modal */}
      {showDeleteChatModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center">
            <div className="h-12 w-12 rounded-full mx-auto flex items-center justify-center mb-3 bg-red-500/20 text-red-400">
              <Trash2 className="h-6 w-6" />
            </div>
            <h3 className="text-base font-bold text-white mb-1">{uiText("Delete Conversation", uiLang)}</h3>
            <p className="text-xs text-[#7f91a4] leading-relaxed mb-4">
              {conversation.type === 'direct'
                ? uiText("Do you want to delete this chat for yourself only, or permanently for both participants?", uiLang)
                : uiText("Clear this conversation history from your personal view?", uiLang)}
            </p>

            <div className="space-y-2 mb-4">
              <button
                type="button"
                onClick={executeDeleteChatForMe}
                disabled={deletingChat}
                className="w-full py-2.5 px-3 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-semibold transition cursor-pointer"
              >{uiText("Delete Chat for Me", uiLang)}</button>

              {conversation.type === 'direct' && (
                <button
                  type="button"
                  onClick={executeDeleteChatForBoth}
                  disabled={deletingChat}
                  className="w-full py-2.5 px-3 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-bold transition cursor-pointer shadow-md"
                >{uiText("Delete Chat for Both", uiLang)}</button>
              )}
            </div>

            <button
              onClick={() => setShowDeleteChatModal(false)}
              className="text-xs text-[#7f91a4] hover:text-white transition cursor-pointer"
            >{uiText("Cancel", uiLang)}</button>
          </div>
        </div>
      )}

      {/* Group Voice Chat Modal */}
      {showVoiceChatModal && (
        <GroupVoiceChatModal
          conversation={conversation}
          currentUser={currentUser}
          onClose={() => setShowVoiceChatModal(false)}
        />
      )}

      {/* Message History Area */}
      <div
        ref={messagesContainerRef}
        onScroll={handleMessageScroll}
        onPaste={handlePaste}
        className={`flex-1 overflow-y-auto overscroll-contain px-3 sm:px-4 py-2 space-y-1 sm:space-y-1.5 ${
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
            } else if (outcome === 'failed') {
              isDeclined = true;
              callText = lang === 'fa' ? 'تماس ناموفق' : 'Call Failed';
            } else {
              callText = lang === 'fa' ? (isVideo ? 'تماس تصویری' : 'تماس صوتی') : (isVideo ? 'Video Call' : 'Voice Call');
            }

            const callTime = new Date(msg.created_at).toLocaleTimeString(uiLang === 'fa' ? 'fa-IR' : 'en-US', { hour: '2-digit', minute: '2-digit' });

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

          if (msg.watchPartyInvite) {
            const inviteTime = new Date(msg.created_at).toLocaleTimeString(uiLang === 'fa' ? 'fa-IR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
            return (
              <div key={msg.id} id={`msg-${msg.id}`} className="flex justify-center my-3 animate-fadeIn select-none">
                <div className="flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-gradient-to-r from-indigo-950/95 via-purple-950/90 to-slate-900/95 border border-indigo-500/40 text-xs shadow-xl backdrop-blur-md max-w-sm">
                  <div className="p-2.5 rounded-xl bg-indigo-600/25 text-indigo-400 border border-indigo-500/30 shrink-0">
                    <Film className="w-5 h-5 animate-pulse" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] text-indigo-300 font-semibold flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      <span>{uiText("دعوت به سینما پارتی همزمان", uiLang)}</span>
                    </div>
                    <div className="text-xs font-bold text-white truncate mt-0.5">
                      {msg.watchPartyInvite.media_title}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{uiText("میزبان:", uiLang)}<span className="text-slate-200 font-medium">{msg.watchPartyInvite.leader_name}</span> • {inviteTime}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setWatchPartyMediaUrl(msg.watchPartyInvite?.media_url);
                      setWatchPartyMediaTitle(msg.watchPartyInvite?.media_title);
                      setWatchPartyOpen(true);
                    }}
                    className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition shadow-md shadow-indigo-600/30 flex items-center gap-1.5 cursor-pointer shrink-0"
                  >
                    <Play className="w-3.5 h-3.5 fill-white" />
                    <span>{uiText("ورود", uiLang)}</span>
                  </button>
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
                  title={uiText("Select Message", uiLang)}
                >
                  {selectedMsgIds.has(msg.id) ? (
                    <CheckSquare className="h-5 w-5 text-[#24A1DE]" />
                  ) : (
                    <Square className="h-5 w-5 text-[#7f91a4]" />
                  )}
                </button>
              )}

              <div
                className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'} max-w-[90%] sm:max-w-[75%] md:max-w-[520px] relative transition-transform duration-75`}
                style={{
                  transform: swipingMsgId === msg.id ? `translateX(${swipeOffset}px)` : undefined,
                }}
                onTouchStart={(e) => {
                  touchStartXRef.current = e.touches[0].clientX;
                  setSwipingMsgId(msg.id);
                  setSwipeOffset(0);
                }}
                onTouchMove={(e) => {
                  if (swipingMsgId !== msg.id) return;
                  const deltaX = e.touches[0].clientX - touchStartXRef.current;
                  // Allow swiping from right to left (deltaX is negative in RTL gesture)
                  if (deltaX <= 0 && deltaX >= -90) {
                    setSwipeOffset(deltaX);
                  }
                }}
                onTouchEnd={() => {
                  if (swipingMsgId === msg.id) {
                    if (swipeOffset < -35) {
                      setReplyingTo(msg);
                    }
                    setSwipingMsgId(null);
                    setSwipeOffset(0);
                  }
                }}
              >
                {/* Swipe to reply icon on the right */}
                {swipingMsgId === msg.id && swipeOffset < -20 && (
                  <div
                    className="absolute top-1/2 -translate-y-1/2 -right-10 p-2 rounded-full bg-[#24A1DE] text-white shadow-lg flex items-center justify-center transition-all"
                  >
                    <Reply size={16} />
                  </div>
                )}
                {/* Message Bubble */}
                <div
                  className={`w-full rounded-2xl relative shadow-md overflow-hidden ${
                        isMediaMsg ? 'p-0' : 'px-3 py-1.5'
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
                      <span>{uiText("Forwarded", uiLang)}{msg.forward_from_name ? `${uiText(' from ', uiLang)}${msg.forward_from_name}` : ''}</span>
                    </div>
                  )}

                  {/* Sender name for group chats */}
                  {(isGroup || isChannel) && !isOutgoing && (
                    <span className="block text-[11px] font-bold text-[#24A1DE] mb-1">
                      {msg.sender_username || uiText("Participant", uiLang)}
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
                        {repliedMsg.sender_username || uiText("Reply", uiLang)}
                      </span>
                      <span className="block text-xs text-white/90 truncate">
                        {repliedMsg.plaintext || (repliedMsg.attachmentMeta?.isPhoto ? uiText("Photo", uiLang) : uiText("Attachment", uiLang))}
                      </span>
                    </div>
                  </div>
                )}

                {/* Whisper Message, Poll Card, Encrypted Attachment, Sticker, Video Note, Media, Voice, or Text */}
                {msg.whisper ? (
                  <WhisperMessageCard
                    whisper={msg.whisper}
                    conversationId={conversation.id}
                    currentUserId={currentUser.id}
                    currentUsername={currentUser.username}
                    senderId={msg.sender_id}
                    senderUsername={msg.sender_username}
                    lang={lang}
                  />
                ) : msg.poll_id ? (
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
                    {msg.attachmentMeta.isViewOnce ? (
                      /* View Once / Self-Destructing Media */
                      burnedViewOnceIds.has(msg.id) || msg.attachmentMeta.viewOnceBurned ? (
                        <div className="flex items-center gap-2.5 p-3 rounded-2xl bg-black/40 border border-[#324252] text-[#7f91a4] select-none">
                          <div className="w-8 h-8 rounded-full bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-rose-400 flex-shrink-0">
                            <Flame size={16} />
                          </div>
                          <div className="text-left">
                            <span className="block text-xs font-semibold text-rose-300">
                              {lang === "fa" ? 'رسانه مشاهده و سوزانده شد' : 'Media viewed & burned'}
                            </span>
                            <span className="block text-[10px] text-[#7f91a4]">
                              {lang === "fa" ? 'این عکس/ویدیو فقط یکبار قابل نمایش بود' : 'Self-destructed after 1 view'}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={async (e) => {
                            e.stopPropagation();
                            let url = decryptedMediaUrls[msg.id];
                            if (!url && msg.attachmentMeta) {
                              url = (await getOrLoadDecryptedUrl(msg.id, msg.attachmentMeta)) || '';
                            }
                            if (url) {
                              setActiveViewOnceModal({ msg, url, countdown: 10 });
                            }
                          }}
                          className="flex items-center gap-3 p-3 rounded-2xl bg-gradient-to-r from-rose-950/50 via-[#182533] to-amber-950/40 border border-amber-500/40 hover:border-amber-400 transition cursor-pointer shadow-lg group/vo select-none text-left"
                        >
                          <div className="relative w-11 h-11 rounded-2xl bg-gradient-to-tr from-amber-500 to-rose-600 flex items-center justify-center text-white font-black text-sm shadow-md group-hover/vo:scale-105 transition-transform flex-shrink-0">
                            <span>1</span>
                            <Flame size={12} className="absolute -top-1 -right-1 text-amber-200 animate-bounce" />
                          </div>
                          <div>
                            <span className="block text-xs font-bold text-amber-200">
                              {lang === "fa" ? 'عکس/ویدیو یک‌باره (View Once)' : 'Self-Destructing Media'}
                            </span>
                            <span className="block text-[11px] text-amber-400/90 font-medium">
                              {lang === "fa" ? 'برای مشاهده کلیک کنید (تایمر ۱۰ ثانیه)' : 'Click to view (10s timer)'}
                            </span>
                          </div>
                        </button>
                      )
                    ) : msg.attachmentMeta.isSticker ? (
                      /* Sticker */
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenStickerPack(msg.attachmentMeta?.stickerPackId || (msg.attachmentMeta as any)?.pack_id || (msg.attachmentMeta as any)?.stickerId || msg.attachmentMeta?.id);
                        }}
                        className="flex flex-col items-center p-1 cursor-pointer group/sticker bg-transparent border-0 outline-none hover:opacity-95 transition"
                        title={lang === "fa" ? 'مشاهده و اشتراک‌گذاری پک استیکر' : 'View & Share Sticker Pack'}
                      >
                        {msg.attachmentMeta.stickerUrl?.includes('video/webm') || msg.attachmentMeta.stickerUrl?.endsWith('.webm') ? (
                          <MotionVideo
                            allowDownload={mediaSettings.autoDownloadVideos && !mediaSettings.lowDataMode}
                            src={msg.attachmentMeta.stickerUrl}
                            autoPlay={mediaSettings.autoplayStickers}
                            controls={!mediaSettings.autoplayStickers}
                            loop
                            muted
                            playsInline
                            className="w-36 h-36 sm:w-44 sm:h-44 object-contain drop-shadow-md select-none transition-transform group-hover/sticker:scale-105"
                          />
                        ) : (
                          <MotionImage
                            allowDownload={mediaSettings.autoDownloadPhotos && !mediaSettings.lowDataMode}
                            animate={mediaSettings.autoplayStickers}
                            src={msg.attachmentMeta.stickerUrl}
                            alt={uiText("Sticker", uiLang)}
                            className="w-36 h-36 sm:w-44 sm:h-44 object-contain drop-shadow-md select-none transition-transform group-hover/sticker:scale-105"
                            loading="lazy"
                          />
                        )}
                      </button>
                    ) : msg.attachmentMeta.isRoundVideo ? (
                      /* Circular Video Note */
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
                                    : uiText("Video Note", uiLang)}
                                </span>
                              </>
                            )}
                          </button>
                        )}
                      </div>
                    ) : msg.attachmentMeta.isPhoto ? (
                      /* Photo Message Card */
                      <div className="select-none">
                        <div
                          className="relative cursor-pointer group/photo overflow-hidden"
                          onClick={() => handleOpenLightbox(msg)}
                        >
                          {decryptedMediaUrls[msg.id] || (msg.attachmentMeta.id && decryptedMediaUrls[msg.attachmentMeta.id]) || msg.attachmentMeta.stickerUrl ? (
                            <div className="relative">
                              {(((decryptedMediaUrls[msg.id] || (msg.attachmentMeta.id && decryptedMediaUrls[msg.attachmentMeta.id]) || msg.attachmentMeta.stickerUrl)?.includes('video/webm') ||
                                (decryptedMediaUrls[msg.id] || (msg.attachmentMeta.id && decryptedMediaUrls[msg.attachmentMeta.id]) || msg.attachmentMeta.stickerUrl)?.endsWith('.webm'))) ? (
                                <MotionVideo
                                  allowDownload={mediaSettings.autoDownloadVideos && !mediaSettings.lowDataMode}
                                  src={decryptedMediaUrls[msg.id] || (msg.attachmentMeta.id && decryptedMediaUrls[msg.attachmentMeta.id]) || msg.attachmentMeta.stickerUrl}
                                  autoPlay={mediaSettings.autoplayGifs}
                                  controls={!mediaSettings.autoplayGifs}
                                  loop
                                  muted
                                  playsInline
                                  className="w-full max-h-[460px] object-cover block hover:opacity-95 transition"
                                />
                              ) : (
                                <MotionImage
                            allowDownload={mediaSettings.autoDownloadPhotos && !mediaSettings.lowDataMode}
                                  animate={mediaSettings.autoplayGifs}
                                  src={decryptedMediaUrls[msg.id] || (msg.attachmentMeta.id && decryptedMediaUrls[msg.attachmentMeta.id]) || msg.attachmentMeta.stickerUrl}
                                  alt={msg.attachmentMeta.filename || uiText("Photo", uiLang)}
                                  className="w-full max-h-[460px] object-cover block hover:opacity-95 transition"
                                />
                              )}
                              <div className="absolute top-2.5 right-2.5 flex items-center gap-1.5 opacity-0 group-hover/photo:opacity-100 transition z-10">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDownloadAttachment(msg.attachmentMeta);
                                  }}
                                  className="p-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-white shadow-lg cursor-pointer transition"
                                  title={uiText("Download Photo", uiLang)}
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
                                    : uiText("Photo", uiLang)}
                                </div>
                              </div>
                            </button>
                          )}
                        </div>
                        {/* Rich formatted caption directly inside the card */}
                        {(msg.attachmentMeta.caption || msg.plaintext) && (
                          <div dir="auto" className="px-3.5 pt-2.5 pb-1 chat-message-text text-sm leading-relaxed break-words text-white/95">
                            {renderFormattedText(msg.attachmentMeta.caption || msg.plaintext || '', { onMentionClick: handleMentionClick, lang })}
                          </div>
                        )}
                      </div>
                    ) : msg.attachmentMeta.isVideo ? (
                      /* Video Message Card */
                      <div className="relative group/video select-none">
                        {decryptedMediaUrls[msg.id] || (msg.attachmentMeta.id && decryptedMediaUrls[msg.attachmentMeta.id]) ? (
                          <div className="relative overflow-hidden">
                            <StreamingVideo preload="metadata"
                              ref={(el) => {
                                if (el) mediaDeviceManager.applyAudioOutput(el);
                              }}
                              src={decryptedMediaUrls[msg.id] || (msg.attachmentMeta.id && decryptedMediaUrls[msg.attachmentMeta.id])}
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
                                title={uiText("Fullscreen", uiLang)}
                              >
                                <Maximize2 className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownloadAttachment(msg.attachmentMeta)}
                                className="p-1.5 rounded-xl bg-black/60 hover:bg-black/80 text-white transition shadow-lg cursor-pointer"
                                title={uiText("Download Video", uiLang)}
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
                                  : uiText("Video", uiLang)}
                              </div>
                            </div>
                          </button>
                        )}
                        {/* Rich formatted caption */}
                        {(msg.attachmentMeta.caption || msg.plaintext) && (
                          <div dir="auto" className="px-3.5 pt-2.5 pb-1 chat-message-text text-sm leading-relaxed break-words text-white/95">
                            {renderFormattedText(msg.attachmentMeta.caption || msg.plaintext || '', { onMentionClick: handleMentionClick, lang })}
                          </div>
                        )}
                      </div>
                    ) : msg.attachmentMeta.isVoice ? (
                      /* Waveform Voice Note Player */
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
                      /* File Attachment Card */
                      <div>
                        <div className="flex items-center gap-3 p-2.5 rounded-xl bg-black/25 hover:bg-black/35 transition border border-white/5">
                          <div className="h-10 w-10 rounded-xl bg-[#24A1DE]/20 text-[#24A1DE] flex flex-col items-center justify-center flex-shrink-0">
                            <FileText className="h-4 w-4" />
                            <span className="text-[8px] uppercase font-bold tracking-wider font-mono">
                              {msg.attachmentMeta.filename?.split('.').pop()?.slice(0, 4) || uiText("FILE", uiLang)}
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
                                : uiText("File", uiLang)}
                              {msg.attachmentMeta.keyBase64 ? ' • E2EE Encrypted' : ''}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDownloadAttachment(msg.attachmentMeta)}
                            disabled={downloadingAttId === msg.attachmentMeta.id}
                            className="p-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] disabled:opacity-50 text-white transition flex-shrink-0 cursor-pointer shadow-sm"
                            title={uiText("Decrypt & Download", uiLang)}
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
                    {msg.is_deleted ? (
                      msg.plaintext || t.deleted_message
                    ) : ['🎲', '🎯', '🏀', '⚽', '🎰'].includes((msg.plaintext || msg.ciphertext || '').trim()) ? (
                      <AnimatedDiceCard
                        messageId={msg.id}
                        result={msg.dice_result}
                        onRollAgain={() => handleSendMessage(undefined, (msg.plaintext || msg.ciphertext).trim())}
                        emoji={(msg.plaintext || msg.ciphertext).trim() as any}
                        senderName={isOutgoing ? (lang === 'fa' ? 'شما' : 'You') : (msg.sender_username || (lang === 'fa' ? 'کاربر' : 'User'))}
                        isOutgoing={isOutgoing}
                        lang={lang}
                      />
                    ) : (msg.plaintext || msg.ciphertext || '').includes('[GAME:TICTACTOE]') || (msg.plaintext || msg.ciphertext || '').includes(uiText("بازی دوز", uiLang)) ? (
                      <TicTacToeGameCard
                        network={{ gameId: msg.id, challengerId: msg.sender_id, currentUserId: currentUser.id, events: gameEvents, sendAction: sendGameAction }}
                        challengerName={isOutgoing ? (lang === 'fa' ? 'شما' : 'You') : (msg.sender_username || (lang === 'fa' ? 'کاربر' : 'User'))}
                        isOutgoing={isOutgoing}
                        lang={lang}
                      />
                    ) : (msg.plaintext || msg.ciphertext || '').includes('[GAME:RPS]') || (msg.plaintext || msg.ciphertext || '').includes(uiText("سنگ، کاغذ، قیچی", uiLang)) ? (
                      <RockPaperScissorsCard
                        network={{ gameId: msg.id, challengerId: msg.sender_id, currentUserId: currentUser.id, events: gameEvents, sendAction: sendGameAction }}
                        challengerName={isOutgoing ? (lang === 'fa' ? 'شما' : 'You') : (msg.sender_username || (lang === 'fa' ? 'کاربر' : 'User'))}
                        isOutgoing={isOutgoing}
                        lang={lang}
                      />
                    ) : isBigEmojiOnly(msg.plaintext || msg.ciphertext) ? (
                      <div className="text-5xl py-1.5 my-1 select-text text-center leading-tight hover:scale-110 transition-transform">
                        {msg.plaintext || msg.ciphertext}
                      </div>
                    ) : (
                      <>
                        {renderFormattedText(msg.plaintext || msg.ciphertext, { onMentionClick: handleMentionClick, lang })}
                        {renderLinkPreviewCard(msg.plaintext || msg.ciphertext)}
                      </>
                    )}
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
                    {new Date(msg.created_at).toLocaleTimeString(uiLang === 'fa' ? 'fa-IR' : 'en-US', {
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

                {/* Inline Bot Action Keyboard */}
                {msg.bot_actions && msg.bot_actions.length > 0 && (
                  <div className={`flex flex-col gap-1.5 mt-1.5 w-full max-w-[480px] select-none ${
                    isOutgoing ? 'self-end' : 'self-start'
                  }`}>
                    {msg.bot_actions.map((row, rowIdx) => (
                      <div key={rowIdx} className="flex gap-1.5 w-full">
                        {row.map((btn, btnIdx) => (
                          <button
                            key={btnIdx}
                            type="button"
                            onClick={() => handleBotButtonClick(btn, msg.id)}
                            className="flex-1 py-2 px-3 rounded-xl bg-[#242f3d]/90 hover:bg-[#2c3e50] active:scale-[0.98] border border-[#2c3e50]/80 hover:border-[#24A1DE]/40 text-xs font-semibold text-white transition duration-150 flex items-center justify-center gap-1.5 shadow-md cursor-pointer text-center"
                          >
                            <span>{btn.text}</span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}

                {/* Emoji Reactions Pills anchored directly under bubble */}
                {(() => {
                  const validReactions = (msg.reactions && typeof msg.reactions === 'object' && !Array.isArray(msg.reactions))
                    ? Object.entries(msg.reactions).filter(([emoji, users]) => Array.isArray(users) && users.length > 0 && typeof emoji === 'string' && emoji.trim().length > 0)
                    : [];
                  if (validReactions.length === 0) return null;
                  return (
                    <div
                      className={`flex flex-wrap gap-1.5 mt-1 z-10 select-none ${
                        isOutgoing ? 'justify-end self-end' : 'justify-start self-start'
                      }`}
                    >
                      {validReactions.map(([emoji, users]) => {
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
                  );
                })()}

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

                {/* Message Action Toolbar */}
                <div
                  className={`mt-1 flex items-center gap-0.5 bg-[#17212b] border border-[#242f3d] rounded-xl px-1.5 py-0.5 shadow-lg text-[#7f91a4] select-none opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity z-10`}
                >
                  {/* Emoji quick reaction trigger */}
                  <button
                    type="button"
                    onClick={() => setActiveReactionMsgId(isMsgHovered ? null : msg.id)}
                    className="p-1 hover:text-white hover:bg-[#242f3d] rounded-lg transition cursor-pointer"
                    title={uiText("React", uiLang)}
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
                    title={uiText("Forward", uiLang)}
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
                    title={uiText("More Actions", uiLang)}
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

      {/* Floating Scroll to Bottom button */}
      {showScrollBottom && (
        <div className="relative w-full max-w-4xl mx-auto pointer-events-none z-30">
          <div className="absolute bottom-3 ltr:right-3 sm:ltr:right-4 rtl:left-3 sm:rtl:left-4 pointer-events-auto animate-in fade-in zoom-in-95 duration-150">
            <button
              id="scroll-to-bottom-btn"
              type="button"
              onClick={() => scrollToBottom(true)}
              aria-label={t.scroll_to_bottom}
              title={t.scroll_to_bottom}
              className="relative h-10 w-10 sm:h-11 sm:w-11 rounded-full bg-[#17212b]/95 hover:bg-[#202b36] border border-[#242f3d] text-[#7f91a4] hover:text-[#24A1DE] shadow-xl hover:shadow-2xl flex items-center justify-center transition-all duration-200 cursor-pointer hover:scale-105 active:scale-95 backdrop-blur-md group"
            >
              <ChevronDown className="h-5 w-5 transition-transform group-hover:translate-y-0.5" />
              {newMessagesBelow > 0 && (
                <span className="absolute -top-1.5 ltr:-right-1.5 rtl:-left-1.5 min-w-5 h-5 px-1.5 rounded-full bg-[#24A1DE] text-white text-[10px] font-bold flex items-center justify-center shadow-md animate-pulse">
                  {newMessagesBelow > 99 ? '99+' : newMessagesBelow}
                </span>
              )}
            </button>
          </div>
        </div>
      )}

      {/* Message Composer */}
      <div className="p-2.5 sm:p-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] bg-[#17212b] border-t border-[#101921] z-20 flex-shrink-0 w-full max-w-full">
        {/* Reply Preview Banner */}
        {replyingTo && (
          <div className="max-w-4xl mx-auto mb-2 px-3 py-1.5 rounded-xl bg-[#242f3d] border-l-4 border-[#24A1DE] flex items-center justify-between animate-fade-in text-xs">
            <div className="flex items-center gap-2 truncate">
              <CornerUpLeft className="h-3.5 w-3.5 text-[#24A1DE] flex-shrink-0" />
              <div className="truncate">
                <span className="font-bold text-[#24A1DE] block text-[11px]">{uiText("Replying to", uiLang)}{replyingTo.sender_username || uiText("Participant", uiLang)}
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
                <span className="font-bold text-amber-400 block text-[11px]">{uiText("Editing Message", uiLang)}</span>
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
                  localStorage.setItem('senora_draft_' + conversation.id, newText);
                } else {
                  localStorage.removeItem('senora_draft_' + conversation.id);
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
              {selectedMsgIds.size}{uiText(" message", uiLang)}{selectedMsgIds.size === 1 ? '' : 's'}{uiText("selected", uiLang)}</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleBulkCopy}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-white font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Copy className="h-3.5 w-3.5" />
                <span>{uiText("Copy", uiLang)}</span>
              </button>
              <button
                type="button"
                onClick={handleBulkSaveToSaved}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-[#24A1DE] font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Bookmark className="h-3.5 w-3.5" />
                <span>{uiText("Save", uiLang)}</span>
              </button>
              <button
                type="button"
                onClick={handleBulkForward}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Share2 className="h-3.5 w-3.5" />
                <span>{uiText("Forward", uiLang)}</span>
              </button>
              <button
                type="button"
                onClick={handleBulkDelete}
                disabled={selectedMsgIds.size === 0}
                className="px-3 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{uiText("Delete", uiLang)}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectionMode(false);
                  setSelectedMsgIds(new Set());
                }}
                className="px-2.5 py-1.5 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-white transition cursor-pointer"
              >{uiText("Cancel", uiLang)}</button>
            </div>
          </div>
        )}

        {/* Voice Recording Active Bar with live audio waveform bars, swipe-to-lock, and preview */}
        {previewAudioUrl || isRecordingPaused ? (
          <div className="max-w-4xl mx-auto flex items-center justify-between bg-[#1e2c3a] border border-[#2b5278] rounded-2xl px-4 py-2.5 shadow-xl text-white animate-fadeIn">
            <div className="flex items-center gap-3 flex-1 min-w-0 mr-3">
              <button
                type="button"
                onClick={togglePreviewPlay}
                className="h-9 w-9 rounded-full bg-[#24A1DE] hover:bg-[#208fc4] flex items-center justify-center text-white flex-shrink-0 shadow-md cursor-pointer"
              >
                {previewAudioPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5 fill-white" />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between text-[11px] text-[#7f91a4] mb-1">
                  <span className="font-semibold text-emerald-400">{t.listen_preview}</span>
                  <span className="font-mono">
                    {Math.floor(previewAudioCurrentTime)}s / {Math.floor(previewAudioDuration || recordingSeconds)}s
                  </span>
                </div>
                <div className="w-full bg-[#121921] h-1.5 rounded-full overflow-hidden">
                  <div
                    className="bg-[#24A1DE] h-full transition-all duration-100"
                    style={{ width: `${previewAudioDuration ? (previewAudioCurrentTime / previewAudioDuration) * 100 : 0}%` }}
                  />
                </div>
              </div>
              <audio
                ref={previewAudioPlayerRef}
                src={previewAudioUrl || undefined}
                onTimeUpdate={() => {
                  if (previewAudioPlayerRef.current) {
                    setPreviewAudioCurrentTime(previewAudioPlayerRef.current.currentTime);
                  }
                }}
                onLoadedMetadata={() => {
                  if (previewAudioPlayerRef.current) {
                    setPreviewAudioDuration(previewAudioPlayerRef.current.duration || recordingSeconds);
                  }
                }}
                onEnded={() => {
                  setPreviewAudioPlaying(false);
                  setPreviewAudioCurrentTime(0);
                }}
                className="hidden"
              />
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={resetVoiceRecordingState}
                className="p-2 rounded-xl bg-red-500/20 hover:bg-red-500/30 text-red-400 transition cursor-pointer"
                title={t.delete}
              >
                <Trash2 className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={sending}
                onClick={() => {
                  if (recordedVoiceBlobRef.current) {
                    sendRecordedVoiceBlob(recordedVoiceBlobRef.current);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition cursor-pointer flex items-center gap-1.5 shadow-md"
              >
                <Send className="h-3.5 w-3.5" />
                <span>{t.voice_message}</span>
              </button>
            </div>
          </div>
        ) : isRecording ? (
          <div className="max-w-4xl mx-auto flex items-center justify-between bg-red-950/80 border border-red-800 rounded-2xl px-4 py-2.5 animate-pulse">
            <div className="flex items-center gap-3 min-w-0">
              <span className="h-3 w-3 rounded-full bg-red-500 animate-ping flex-shrink-0" />
              <span className="text-xs font-semibold text-red-300 whitespace-nowrap">
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

            <div className="flex items-center gap-2 flex-shrink-0">
              {/* Swipe to lock toggle / button */}
              {!isRecordingLocked ? (
                <button
                  type="button"
                  onClick={() => setIsRecordingLocked(true)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 text-xs font-semibold transition cursor-pointer"
                  title={t.swipe_up_lock}
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">{t.swipe_up_lock}</span>
                </button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-amber-500/25 border border-amber-500/40 text-amber-300 text-[10px] font-bold">
                    <Lock className="h-3 w-3" />
                    <span>{t.recording_locked}</span>
                  </span>
                  <button
                    type="button"
                    onClick={pauseVoiceRecordingForPreview}
                    className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 text-xs font-semibold transition cursor-pointer"
                    title={t.listen_preview}
                  >
                    <Pause className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t.listen_preview}</span>
                  </button>
                </div>
              )}

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
                <span>{uiText("Send Voice", uiLang)}</span>
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
                  <span>{uiText("Video Note", uiLang)}</span>
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
                  <span>{isSilentSend ? uiText("Silent ON", uiLang) : uiText("Silent", uiLang)}</span>
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
                  <span>{uiText("Schedule", uiLang)}</span>
                </button>
              </div>
            )}

            {/* Composer Input Row */}
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
                        <span className="font-semibold block">{uiText("Photo or File", uiLang)}</span>
                        <span className="text-[10px] text-slate-400">{uiText("Send media or documents", uiLang)}</span>
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
                        <span className="font-semibold block">{uiText("Poll or Quiz", uiLang)}</span>
                        <span className="text-[10px] text-slate-400">{uiText("Create interactive vote", uiLang)}</span>
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
                        <span className="font-semibold block">{uiText("Video Note", uiLang)}</span>
                        <span className="text-[10px] text-slate-400">{uiText("Record circular video", uiLang)}</span>
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
                        <span className="font-semibold block">{uiText("Schedule Message", uiLang)}</span>
                        <span className="text-[10px] text-slate-400">{uiText("Send at scheduled time", uiLang)}</span>
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
                        <span className="font-semibold block">{isSilentSend ? uiText("Silent Send (Active)", uiLang) : uiText("Send Silently", uiLang)}</span>
                        <span className="text-[10px] text-slate-400">{uiText("No notification sound", uiLang)}</span>
                      </div>
                    </button>

                    <button
                      id="whisper-btn"
                      type="button"
                      onClick={() => {
                        setShowWhisperModal(true);
                        setShowAttachMenu(false);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-purple-500/15 text-purple-400 flex items-center justify-center flex-shrink-0">
                        <Lock className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">{lang === "fa" ? 'پیام مخفی (نجوا)' : 'Whisper Message'}</span>
                        <span className="text-[10px] text-slate-400">{lang === "fa" ? 'فقط برای مخاطب خاص (@whisper)' : 'Private secret message'}</span>
                      </div>
                    </button>

                    <div className="border-t border-[#242f3d] my-0.5" />

                    {/* Mini App Game */}
                    <button
                      id="mini-game-btn"
                      type="button"
                      onClick={() => {
                        setShowMiniGameModal(true);
                        setShowAttachMenu(false);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center flex-shrink-0">
                        <Gamepad2 className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">{lang === "fa" ? 'مینی‌اپ تلگرام (2048)' : 'Telegram Mini App (2048)'}</span>
                        <span className="text-[10px] text-slate-400">{lang === "fa" ? 'بازی و اشتراک رکورد در چت' : 'Play & share high score'}</span>
                      </div>
                    </button>

                    {/* Interactive Games Menu */}
                    <button
                      id="tictactoe-btn"
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        handleSendMessage(undefined, lang === 'fa' ? '❌⭕ [GAME:TICTACTOE] دعوت به بازی دوز! نوبت حرکته:' : '❌⭕ [GAME:TICTACTOE] Tic-Tac-Toe Challenge! Your move:');
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-pink-500/15 text-pink-400 flex items-center justify-center flex-shrink-0 text-sm font-bold">
                        ❌
                      </div>
                      <div>
                        <span className="font-semibold block">{lang === "fa" ? 'بازی دوز دونفره' : 'Tic-Tac-Toe Game'}</span>
                        <span className="text-[10px] text-slate-400">{lang === "fa" ? 'ارسال برد تعاملی دوز در چت' : 'Interactive 3x3 duel'}</span>
                      </div>
                    </button>

                    <button
                      id="rps-game-btn"
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        handleSendMessage(undefined, lang === 'fa' ? '✂️ [GAME:RPS] چالش سنگ، کاغذ، قیچی! حرکتت رو مخفیانه انتخاب کن:' : '✂️ [GAME:RPS] Rock Paper Scissors duel! Pick your secret move:');
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-purple-500/15 text-purple-400 flex items-center justify-center flex-shrink-0 text-sm">
                        ✌️
                      </div>
                      <div>
                        <span className="font-semibold block">{lang === "fa" ? uiText("سنگ، کاغذ، قیچی", uiLang) : 'Rock-Paper-Scissors'}</span>
                        <span className="text-[10px] text-slate-400">{lang === "fa" ? 'دوئل مخفی با کارت تعاملی' : 'Secret move clash'}</span>
                      </div>
                    </button>

                    <button
                      id="dice-roll-btn"
                      type="button"
                      onClick={() => {
                        setShowAttachMenu(false);
                        const diceEmojis = ['🎲', '🎯', '🏀', '⚽', '🎰'];
                        const picked = diceEmojis[Math.floor(Math.random() * diceEmojis.length)];
                        handleSendMessage(undefined, picked);
                      }}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-xl text-slate-200 hover:text-white hover:bg-[#202b36] transition cursor-pointer text-left"
                    >
                      <div className="h-7 w-7 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center flex-shrink-0">
                        <Dices className="h-4 w-4" />
                      </div>
                      <div>
                        <span className="font-semibold block">{lang === "fa" ? 'تاس و رولت متحرک' : 'Roll Telegram Dice'}</span>
                        <span className="text-[10px] text-slate-400">{lang === "fa" ? 'تاس، دارت، بسکتبال، فوتبال یا اسلات' : 'Animated dice, dart, slot'}</span>
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
                  onPaste={handlePaste}
                  onChange={(e) => {
                    handleMentionInputChange(e.target.value, e.target.selectionStart || 0);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder={
                    slowModeRemaining > 0 && myRole !== 'owner' && myRole !== 'admin'
                      ? `⏳ ${t.slow_mode_wait} ${slowModeRemaining}s`
                      : isSilentSend
                      ? uiText("Silent message...", uiLang)
                      : t.type_message
                  }
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
                    title={uiText("Format Text (Ctrl+B, Ctrl+I, Spoiler, Code...)", uiLang)}
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
                    title={uiText("Emojis & Stickers", uiLang)}
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

                {/* Floating Mention Suggestions Popover */}
                {showMentionSuggestions && mentionSuggestions.length > 0 && (
                  <div
                    className="absolute bottom-full left-0 mb-2 w-72 sm:w-80 max-h-56 overflow-y-auto rounded-2xl bg-[#17212b] border border-[#242f3d] shadow-2xl z-50 p-1.5 space-y-0.5 animate-in fade-in slide-in-from-bottom-2 duration-150 backdrop-blur-md"
                  >
                    <div className="px-2 py-1 text-[10px] font-bold text-[#7f91a4] uppercase tracking-wider flex items-center justify-between border-b border-[#242f3d] mb-1">
                      <span>{uiText("Mention", uiLang)}</span>
                      <span className="text-[9px] font-normal lowercase">{uiText("Tab or click to select", uiLang)}</span>
                    </div>
                    {mentionSuggestions.map((mUser, idx) => {
                      const isSelected = idx === selectedMentionIndex;
                      return (
                        <button
                          key={mUser.id}
                          type="button"
                          onClick={() => handleSelectMention(mUser)}
                          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl transition text-left cursor-pointer group ${
                            isSelected ? 'bg-[#2b5278] text-white' : 'hover:bg-[#202b36] text-white'
                          }`}
                        >
                          <div className="h-8 w-8 rounded-full bg-gradient-to-tr from-[#3ca9e2] to-[#24A1DE] flex items-center justify-center font-bold text-xs text-white overflow-hidden flex-shrink-0 shadow-sm">
                            {mUser.avatar_url ? (
                              <img src={api.avatarURL(mUser.avatar_url)} alt={mUser.display_name} className="h-full w-full object-cover" />
                            ) : (
                              (mUser.display_name || mUser.username).charAt(0).toUpperCase()
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-white truncate">{mUser.display_name || mUser.username}</p>
                            <p className={`text-[11px] truncate ${isSelected ? 'text-white/80' : 'text-[#7f91a4] group-hover:text-[#24A1DE]'}`}>
                              @{mUser.username}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Send or Voice Record Action Button */}
              {slowModeRemaining > 0 && myRole !== 'owner' && myRole !== 'admin' ? (
                <button
                  type="button"
                  disabled
                  className="h-10 px-3 rounded-full bg-[#242f3d] text-amber-400 font-mono text-xs flex items-center gap-1.5 opacity-80 cursor-not-allowed flex-shrink-0"
                  title={`${t.slow_mode_wait} ${slowModeRemaining}s`}
                >
                  <Clock className="h-3.5 w-3.5 animate-spin" />
                  <span>{slowModeRemaining}s</span>
                </button>
              ) : input.trim() || editingMessage ? (
                <button
                  id="send-message-btn"
                  type="button"
                  onClick={() => handleSendMessage()}
                  disabled={sending}
                  className="h-10 w-10 rounded-full bg-[#24A1DE] hover:bg-[#208fc4] flex items-center justify-center text-white shadow-lg shadow-[#24A1DE]/25 transition cursor-pointer flex-shrink-0"
                  title={uiText("Send", uiLang)}
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


      {/* Round Video Note Recorder Modal Overlay */}
      {showRoundVideoRecorder && (
        <RoundVideoRecorderModal
          onSend={handleSendRoundVideo}
          onCancel={() => setShowRoundVideoRecorder(false)}
          sending={sending}
        />
      )}

      {/* Media & Document Preview Modal */}
      {pendingMediaFiles && (
        <MediaPreviewModal
          file={pendingMediaFiles.file}
          files={pendingMediaFiles.files}
          previewUrl={pendingMediaFiles.previewUrl}
          isVideo={pendingMediaFiles.isVideo}
          isDocument={pendingMediaFiles.isDocument}
          uploadProgress={uploadProgress}
          onSend={(file, caption, isViewOnce) => sendMultipleFiles([file], caption, isViewOnce)}
          onSendMultiple={(files, caption, isViewOnce) => sendMultipleFiles(files, caption, isViewOnce)}
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
          onStartWatchParty={(media) => {
            setLightboxMedia(null);
            const serverUrl = media.attachmentId ? `/api/v1/attachments/${media.attachmentId}` : media.url;
            setWatchPartyMediaUrl(serverUrl);
            setWatchPartyMediaTitle(media.filename || 'Video');
            setWatchPartyOpen(true);
          }}
          onShareMedia={(media) => {
            setLightboxMedia(null);
            setSharingAttachment({
              id: media.attachmentId || media.id,
              filename: media.filename || 'media',
              content_type: media.type === 'video' ? 'video/mp4' : 'image/jpeg',
              size_bytes: 0,
              conversation_id: conversation.id,
              uploader_id: currentUser.id,
              is_encrypted: false,
              created_at: new Date().toISOString(),
            });
            setShareMediaModalOpen(true);
          }}
        />
      )}

      {/* In-Chat Synchronized Watch Party Modal / Floating PiP */}
      {watchPartyOpen && (
        <WatchPartyModal
          conversation={conversation}
          currentUser={currentUser}
          isOpen={watchPartyOpen}
          onClose={() => {
            setWatchPartyOpen(false);
            setWatchPartyMediaUrl(undefined);
            setWatchPartyMediaTitle(undefined);
          }}
          initialMediaUrl={watchPartyMediaUrl}
          initialMediaTitle={watchPartyMediaTitle}
          messages={messages}
          decryptedMediaUrls={decryptedMediaUrls}
        />
      )}

      {/* Public Stream & Dark Web Player Share Modal */}
      {shareMediaModalOpen && sharingAttachment && (
        <ShareMediaModal
          attachment={sharingAttachment}
          isOpen={shareMediaModalOpen}
          onClose={() => {
            setShareMediaModalOpen(false);
            setSharingAttachment(null);
          }}
        />
      )}

      {/* Message Context Menu */}
      {contextMenuPos && (
        <MessageContextMenu
          position={contextMenuPos}
          currentUser={currentUser}
          isOwnerOrAdmin={conversation.type === 'direct' || myRole === 'owner' || myRole === 'admin' || contextMenuPos.message.sender_id === currentUser.id}
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
              lang === 'fa'
                ? `اطلاعات پیام:\nشناسه: ${msg.id}\nفرستنده: ${msg.sender_username || msg.sender_id}\nزمان: ${new Date(msg.created_at).toLocaleString('fa-IR')}\nوضعیت: ${msg.status || 'delivered'}\nامنیت: ${securityMode === 'e2ee' ? uiText("رمزنگاری سرتاسری Signal", uiLang) : uiText("استاندارد", uiLang)}`
                : `Message Details:\nID: ${msg.id}\nSender: ${msg.sender_username || msg.sender_id}\nTime: ${new Date(msg.created_at).toLocaleString('en-US')}\nStatus: ${msg.status || 'delivered'}\nSecurity: ${securityMode === 'e2ee' ? uiText("Signal Protocol E2EE", uiLang) : 'Standard Secure'}`
            );
          }}
          onDeleteForMe={handleDeleteForMe}
          onDeleteForEveryone={handleDeleteForEveryone}
          onReact={handleAddReaction}
          onViewReadBy={(msg) => setReadByModalMessage(msg)}
          onStartWatchParty={(msg) => {
            const serverUrl = msg.attachmentMeta?.id ? `/api/v1/attachments/${msg.attachmentMeta.id}` : (msg.attachmentMeta as any)?.localUrl;
            if (serverUrl) {
              setWatchPartyMediaUrl(serverUrl);
              setWatchPartyMediaTitle(msg.attachmentMeta?.filename || 'Video');
              setWatchPartyOpen(true);
            }
          }}
          onShareMedia={(msg) => {
            if (msg.attachmentMeta) {
              setSharingAttachment({
                id: msg.attachmentMeta.id || msg.id,
                filename: msg.attachmentMeta.filename || 'media',
                content_type: msg.attachmentMeta.contentType || 'video/mp4',
                size_bytes: msg.attachmentMeta.sizeBytes || 0,
                conversation_id: conversation.id,
                uploader_id: msg.sender_id,
                is_encrypted: false,
                created_at: msg.created_at,
              });
              setShareMediaModalOpen(true);
            }
          }}
        />
      )}

      {/* Read By Modal */}
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
            <h3 className="text-base font-bold text-white text-center mb-1">{uiText("Schedule Message", uiLang)}</h3>
            <p className="text-xs text-[#7f91a4] text-center mb-4">{uiText("Send this message automatically at a future date and time.", uiLang)}</p>

            <div className="space-y-3 mb-5">
              <div>
                <label className="text-[11px] text-[#7f91a4] font-medium block mb-1">{uiText("Message Content", uiLang)}</label>
                <div className="p-2.5 rounded-xl bg-[#242f3d] text-xs text-white max-h-24 overflow-y-auto">
                  {input.trim() || <span className="italic text-slate-400">{uiText("Type in input box first", uiLang)}</span>}
                </div>
              </div>

              <div>
                <label className="text-[11px] text-[#7f91a4] font-medium block mb-1">{uiText("Schedule For", uiLang)}</label>
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
                <label htmlFor="schedule-silent" className="text-xs text-[#7f91a4] cursor-pointer">{uiText("Send silently (no sound notification)", uiLang)}</label>
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowScheduleModal(false)}
                className="flex-1 py-2 rounded-xl bg-[#242f3d] hover:bg-[#202b36] text-xs text-white transition cursor-pointer"
              >{uiText("Cancel", uiLang)}</button>
              <button
                type="button"
                onClick={handleScheduleSubmit}
                disabled={!input.trim() || !scheduledDateStr}
                className="flex-1 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition cursor-pointer shadow-md disabled:opacity-50"
              >{uiText("Schedule", uiLang)}</button>
            </div>
          </div>
        </div>
      )}

      {/* Chat Info & Members Modal */}
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
                {isSaved ? uiText("Saved Messages", uiLang) : isChannel ? uiText("Channel", uiLang) : isGroup ? uiText("Group Chat", uiLang) : uiText("Direct Conversation", uiLang)}
              </p>
            </div>

            <div className="space-y-2 text-xs bg-[#242f3d] p-3 rounded-xl mb-4 flex-shrink-0">
              {conversation.description && (
                <div>
                  <span className="text-[10px] text-[#7f91a4] block">{uiText("Description", uiLang)}</span>
                  <p className="text-white mt-0.5">{conversation.description}</p>
                </div>
              )}
              <div className="flex justify-between items-center py-1 border-b border-[#17212b]/50">
                <span className="text-[#7f91a4]">{uiText("Security Mode", uiLang)}</span>
                <span className="font-semibold text-emerald-400">
                  {securityMode === 'e2ee_active' ? uiText("Signal E2EE Active", uiLang) : uiText("TLS transport security (normal mode)", uiLang)}
                </span>
              </div>
              {myRole && (
                <div className="flex justify-between items-center py-1 border-b border-[#17212b]/50">
                  <span className="text-[#7f91a4]">{uiText("Your Role", uiLang)}</span>
                  <span className="font-semibold text-[#24A1DE] capitalize">{myRole}</span>
                </div>
              )}
              <div className="flex justify-between items-center py-1">
                <span className="text-[#7f91a4]">
                  {isChannel ? uiText("Subscribers", uiLang) : isGroup ? uiText("Members", uiLang) : uiText("Participants", uiLang)}
                </span>
                <span className="text-white font-medium">
                  {conversationMembers.length > 0
                    ? `${conversationMembers.length} ${isChannel ? uiText("subscribers", uiLang) : uiText("members", uiLang)}`
                    : `${conversation.participants?.length || 1} ${isChannel ? uiText("subscribers", uiLang) : uiText("members", uiLang)}`}
                </span>
              </div>
            </div>

            {/* Auto-Delete (Disappearing) Messages Settings */}
            <div className="bg-[#242f3d] p-3 rounded-xl mb-3 flex items-center justify-between gap-2 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-[#7f91a4]" />
                <div>
                  <span className="text-[10px] text-[#7f91a4] block">{uiText("Auto-Delete Messages", uiLang)}</span>
                  <span className="text-xs text-white font-medium">
                    {conversationTTL === 3600
                      ? uiText("1 Hour", uiLang)
                      : conversationTTL === 86400
                      ? uiText("1 Day", uiLang)
                      : conversationTTL === 604800
                      ? uiText("1 Week", uiLang)
                      : uiText("Off", uiLang)}
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
                  <option value={0}>{uiText("Off", uiLang)}</option>
                  <option value={3600}>{uiText("1 Hour", uiLang)}</option>
                  <option value={86400}>{uiText("1 Day", uiLang)}</option>
                  <option value={604800}>{uiText("1 Week", uiLang)}</option>
                </select>
              )}
            </div>

            {/* Authentic Token-based Invite Link for Group & Channel */}
            {(isGroup || isChannel) && (
              <div className="bg-[#242f3d] p-3 rounded-xl mb-3 space-y-2 flex-shrink-0">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-[#7f91a4] block font-semibold uppercase tracking-wider">{uiText("Private Invite Link", uiLang)}</span>
                  {(myRole === 'owner' || myRole === 'admin') && (
                    <button
                      type="button"
                      disabled={inviteLoading}
                      onClick={handleGenerateInvite}
                      className="text-[10px] text-[#24A1DE] hover:underline font-semibold cursor-pointer disabled:opacity-50"
                    >
                      {inviteLoading ? uiText("Generating...", uiLang) : activeInviteCode ? uiText("Create New Link", uiLang) : uiText("Generate Invite Link", uiLang)}
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
                        alert(uiText("Invite link copied to clipboard!", uiLang));
                      }}
                      className="p-1.5 rounded-lg bg-[#24A1DE]/20 hover:bg-[#24A1DE]/30 text-[#24A1DE] transition cursor-pointer"
                      title={uiText("Copy Invite Link", uiLang)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    {(myRole === 'owner' || myRole === 'admin') && activeInviteCode && (
                      <button
                        type="button"
                        disabled={inviteLoading}
                        onClick={() => handleRevokeInvite(activeInviteCode)}
                        className="p-1.5 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-red-400 transition cursor-pointer"
                        title={uiText("Revoke Invite Link", uiLang)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Group Slow Mode Anti-Spam Control for Admins/Owner */}
            {(myRole === 'owner' || myRole === 'admin') && isGroup && (
              <div className="mb-3.5 p-3 rounded-xl bg-[#121921]/60 border border-[#242f3d] flex-shrink-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-amber-400" />
                    <div>
                      <span className="text-xs font-semibold text-white block">{t.slow_mode}</span>
                      <span className="text-[10px] text-[#7f91a4]">{t.slow_mode_desc}</span>
                    </div>
                  </div>
                  <select
                    value={conversation.slow_mode_seconds || 0}
                    onChange={async (e) => {
                      const secs = Number(e.target.value);
                      try {
                        await api.setConversationSlowMode(conversation.id, secs);
                        conversation.slow_mode_seconds = secs;
                        alert(secs > 0 ? `حالت آهسته روی ${secs} ثانیه تنظیم شد.` : uiText("حالت آهسته خاموش شد.", uiLang));
                      } catch (err: any) {
                        alert(err.message || uiText("خطا در تنظیم حالت آهسته", uiLang));
                      }
                    }}
                    className="rounded-lg bg-[#17212b] border border-[#242f3d] px-2.5 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE] cursor-pointer"
                  >
                    <option value={0}>{t.slow_mode_off}</option>
                    <option value={10}>{uiText("10s", uiLang)}</option>
                    <option value={30}>{uiText("30s", uiLang)}</option>
                    <option value={60}>{uiText("1m", uiLang)}</option>
                    <option value={300}>{uiText("5m", uiLang)}</option>
                    <option value={900}>{uiText("15m", uiLang)}</option>
                    <option value={3600}>{uiText("1h", uiLang)}</option>
                  </select>
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
                      placeholder={uiText("User ID or @username", uiLang)}
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
                          alert(err.message || uiText("Failed to add member", uiLang));
                        } finally {
                          setAddingMember(false);
                        }
                      }}
                      className="px-3 py-1.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition disabled:opacity-50 cursor-pointer"
                    >
                      {addingMember ? uiText("Adding...", uiLang) : uiText("Add", uiLang)}
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
                    <span>{uiText("Add ", uiLang)}{isChannel ? uiText("Subscriber", uiLang) : uiText("Member", uiLang)}</span>
                  </button>
                )}
              </div>
            )}

            {/* Functional Member List for Group & Channel */}
            {(isGroup || isChannel) && (
              <div className="flex-1 overflow-y-auto mb-4 min-h-[120px] max-h-60 border border-[#242f3d] rounded-xl p-2 bg-[#121921]">
                <h4 className="text-[11px] font-bold text-[#7f91a4] uppercase px-2 py-1 tracking-wider">
                  {isChannel ? uiText("Subscribers", uiLang) : uiText("Members", uiLang)} ({conversationMembers.length})
                </h4>
                {loadingMembers ? (
                  <div className="flex items-center justify-center py-6 text-xs text-[#7f91a4] gap-2">
                    <div className="h-4 w-4 border-2 border-[#24A1DE] border-t-transparent rounded-full animate-spin" />
                    <span>{uiText("Loading members...", uiLang)}</span>
                  </div>
                ) : membersError ? (
                  <div className="p-3 text-xs text-amber-300 bg-amber-500/10 rounded-lg">
                    {membersError}
                  </div>
                ) : conversationMembers.length === 0 ? (
                  <div className="p-3 text-xs text-[#7f91a4] text-center">{uiText("No members found.", uiLang)}</div>
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
                        title={uiText("View Profile", uiLang)}
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="h-8 w-8 rounded-full bg-[#24A1DE] flex items-center justify-center font-bold text-xs text-white overflow-hidden flex-shrink-0">
                            {m.avatar_url ? (
                              <img src={api.avatarURL(m.avatar_url)} alt={m.display_name} className="h-full w-full object-cover" />
                            ) : (
                              (m.display_name || m.username || 'U').charAt(0).toUpperCase()
                            )}
                          </div>
                          <div className="min-w-0">
                            <span className="block text-xs font-semibold text-white truncate">
                              {m.display_name || m.username}
                              {m.user_id === currentUser.id && (
                                <span className="text-[10px] text-[#24A1DE] ml-1">{uiText("(You)", uiLang)}</span>
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
                                title={m.role === 'admin' ? uiText("Demote to Member", uiLang) : uiText("Promote to Admin", uiLang)}
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
                                    alert(err.message || uiText("Failed to remove member", uiLang));
                                  }
                                }}
                                className="p-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition cursor-pointer"
                                title={uiText("Remove Member", uiLang)}
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
            >{uiText("Close", uiLang)}</button>
          </div>
        </div>
      )}

      {/* User Profile Modal */}
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
              type,
              inspectedUser.avatar_url,
              currentUser.avatar_url,
              currentUser.display_name || currentUser.username
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



      {showStickerPackModal && (
        <StickerPackModal
          isOpen={showStickerPackModal}
          onClose={() => setShowStickerPackModal(false)}
          packIdOrCode={previewStickerPackId}
        />
      )}

      {showWhisperModal && (
        <WhisperModal
          isOpen={showWhisperModal}
          onClose={() => setShowWhisperModal(false)}
          onSend={handleSendWhisper}
          participants={conversation.participants}
          currentUserId={currentUser.id}
          lang={lang}
        />
      )}

      {/* 1. View-Once Self-Destructing Media Modal Overlay */}
      {activeViewOnceModal && (
        <div
          onContextMenu={(e) => e.preventDefault()}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-between bg-black/95 backdrop-blur-xl p-6 select-none animate-fadeIn"
        >
          {/* Top Bar with Countdown Ring and Close Button */}
          <div className="w-full max-w-xl flex items-center justify-between z-10">
            <div className="flex items-center gap-3">
              <div className="relative flex items-center justify-center w-11 h-11 rounded-full border-2 border-amber-400 bg-amber-500/20 text-amber-300 font-mono font-bold text-base shadow-[0_0_15px_rgba(251,191,36,0.5)]">
                <span>{activeViewOnceModal.countdown}</span>
              </div>
              <div>
                <span className="text-xs font-bold text-white block">
                  {lang === "fa" ? 'مشاهده یک‌باره (در حال سوختن...)' : 'View Once (Self-Destructing...)'}
                </span>
                <span className="text-[10px] text-amber-400 font-mono">
                  {activeViewOnceModal.countdown}{uiText("s remaining", uiLang)}</span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                const burnedId = activeViewOnceModal.msg.id;
                setBurnedViewOnceIds((prev) => {
                  const next = new Set(prev).add(burnedId);
                  try {
                    localStorage.setItem('senora_burned_view_once', JSON.stringify(Array.from(next)));
                  } catch {}
                  return next;
                });
                setActiveViewOnceModal(null);
              }}
              className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold transition cursor-pointer shadow-lg"
            >
              {lang === "fa" ? 'بستن و سوزاندن' : 'Close & Burn'}
            </button>
          </div>

          {/* Media Presentation */}
          <div className="flex-1 flex items-center justify-center max-w-2xl max-h-[75vh] w-full my-4">
            {activeViewOnceModal.msg.attachmentMeta?.isVideo ? (
              <video
                src={activeViewOnceModal.url}
                autoPlay
                playsInline
                controls={false}
                className="max-w-full max-h-full rounded-2xl object-contain shadow-2xl"
              />
            ) : (
              <img
                src={activeViewOnceModal.url}
                alt={uiText("View once", uiLang)}
                className="max-w-full max-h-full rounded-2xl object-contain shadow-2xl"
              />
            )}
          </div>

          {/* Security anti-screenshot notice */}
          <p className="text-[11px] text-[#7f91a4] font-medium z-10 text-center">
            🔒 {lang === "fa" ? 'محافظت شده با رمزنگاری سرتاسری E2EE - بدون ذخیره در حافظه' : 'Protected by E2EE - not cached locally'}
          </p>
        </div>
      )}

      {/* 2. Pinned Messages Drawer Modal */}
      {showPinsDrawer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-fadeIn">
          <div className="w-full max-w-md rounded-3xl bg-[#17212b] border border-[#242f3d] p-5 shadow-2xl flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between pb-3 border-b border-[#242f3d]">
              <div className="flex items-center gap-2 text-white font-bold text-sm">
                <Layers className="h-4 w-4 text-[#24A1DE]" />
                <span>{lang === "fa" ? `پیام‌های سنجاق شده (${pinnedMessages.length})` : `Pinned Messages (${pinnedMessages.length})`}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowPinsDrawer(false)}
                className="p-1 rounded-full text-[#7f91a4] hover:text-white hover:bg-[#242f3d] cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 py-3">
              {pinnedMessages.map((pinMsg, idx) => (
                <div
                  key={pinMsg.id}
                  onClick={() => {
                    setShowPinsDrawer(false);
                    setCurrentPinIndex(idx);
                    document.getElementById(`msg-${pinMsg.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  }}
                  className="p-3 rounded-2xl bg-[#242f3d]/60 hover:bg-[#242f3d] border border-[#324252] transition cursor-pointer flex items-center justify-between gap-3 group"
                >
                  <div className="min-w-0 text-left">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-[#24A1DE]">
                        {pinMsg.sender_username || uiText("Sender", uiLang)}
                      </span>
                      <span className="text-[10px] text-[#7f91a4]">
                        {new Date(pinMsg.created_at).toLocaleTimeString(uiLang === 'fa' ? 'fa-IR' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-xs text-white truncate mt-0.5">
                      {pinMsg.plaintext || (pinMsg.attachmentMeta?.filename || uiText("Attachment", uiLang))}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTogglePin(pinMsg);
                      }}
                      className="p-1.5 rounded-lg text-[#7f91a4] hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                      title={t.unpin}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3. Supergroup New Topic Modal */}
      {showNewTopicModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-fadeIn">
          <div className="w-full max-w-sm rounded-3xl bg-[#17212b] border border-[#242f3d] p-6 space-y-4 shadow-2xl text-left">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-white font-bold text-sm">
                <Hash className="h-5 w-5 text-[#24A1DE]" />
                <span>{lang === "fa" ? 'ایجاد تاپیک جدید' : 'Create Forum Topic'}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowNewTopicModal(false)}
                className="text-[#7f91a4] hover:text-white p-1 rounded-full cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-[#7f91a4]">
                {lang === "fa" ? 'عنوان تاپیک' : 'Topic Title'}
              </label>
              <input
                type="text"
                value={newTopicTitle}
                onChange={(e) => setNewTopicTitle(e.target.value)}
                placeholder={lang === "fa" ? 'مثال: اخبار، پشتیبانی، توسعه...' : 'e.g. Development, Support...'}
                className="w-full px-3 py-2 bg-[#242f3d] border border-[#324252] rounded-xl text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                autoFocus
              />
            </div>

            {/* Icon picker */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-[#7f91a4]">
                {lang === "fa" ? 'آیکون / اموجی' : 'Icon / Emoji'}
              </label>
              <div className="flex items-center gap-2">
                {['💬', '🛠️', '📢', '💡', '🎮', '🚀', '🔥', '📚'].map((ico) => (
                  <button
                    key={ico}
                    type="button"
                    onClick={() => setNewTopicIcon(ico)}
                    className={`w-8 h-8 rounded-xl flex items-center justify-center text-sm transition cursor-pointer ${
                      newTopicIcon === ico ? 'bg-[#24A1DE] scale-110 shadow' : 'bg-[#242f3d] hover:bg-[#2b3a4a]'
                    }`}
                  >
                    {ico}
                  </button>
                ))}
              </div>
            </div>

            {/* Color picker */}
            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-[#7f91a4]">
                {lang === "fa" ? 'رنگ تاپیک' : 'Topic Color'}
              </label>
              <div className="flex items-center gap-2">
                {['#24A1DE', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'].map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setNewTopicColor(c)}
                    className={`w-7 h-7 rounded-full border-2 transition cursor-pointer ${
                      newTopicColor === c ? 'border-white scale-110 shadow' : 'border-transparent opacity-80'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowNewTopicModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
              >
                {lang === "fa" ? uiText("انصراف", uiLang) : uiText("Cancel", uiLang)}
              </button>
              <button
                type="button"
                disabled={creatingTopic || !newTopicTitle.trim()}
                onClick={async () => {
                  setCreatingTopic(true);
                  try {
                    const created = await api.createConversationTopic(
                      conversation.id,
                      newTopicTitle.trim(),
                      newTopicIcon,
                      newTopicColor
                    );
                    setForumTopics((prev) => [...prev, created]);
                    setActiveTopicId(created.id);
                    setShowNewTopicModal(false);
                    setNewTopicTitle('');
                  } catch (e: any) {
                    alert(e.message || uiText("Failed to create topic", uiLang));
                  } finally {
                    setCreatingTopic(false);
                  }
                }}
                className="px-4 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] disabled:opacity-50 text-white text-xs font-bold shadow transition cursor-pointer"
              >
                {creatingTopic ? (lang === "fa" ? uiText("در حال ساخت...", uiLang) : uiText("Creating...", uiLang)) : (lang === "fa" ? 'ساخت تاپیک' : 'Create Topic')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showMiniGameModal && (
        <MiniGameModal
          lang={lang}
          onClose={() => setShowMiniGameModal(false)}
          onShareScore={(gameName, score) => {
            const shareText = lang === 'fa'
              ? `🎮 من در مینی‌اپ ${gameName} امتیاز ${score.toLocaleString('fa-IR')} گرفتم! کی می‌تونه رکوردم رو بزنه؟`
              : `🎮 I scored ${score} in ${gameName} Mini App! Can you beat my high score?`;
            handleSendMessage(undefined, shareText);
          }}
        />
      )}
    </div>
  );
};

