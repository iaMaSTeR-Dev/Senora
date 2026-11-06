import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Conversation, User, WatchPartySession, Message } from '../../app/types';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';
import { serverManager } from '../../protocol/serverManager';
import {
  X,
  Play,
  Pause,
  Maximize2,
  Minimize2,
  Tv,
  Volume2,
  VolumeX,
  RotateCcw,
  FastForward,
  Film,
  Share2,
  Copy,
  Check,
  Upload,
  Link2,
  Sparkles,
  AlertCircle,
  GripHorizontal
} from 'lucide-react';

interface FloatingReaction {
  id: string;
  emoji: string;
  senderName: string;
  leftPercent: number;
}

interface WatchPartyModalProps {
  conversation: Conversation;
  currentUser: User;
  isOpen: boolean;
  onClose: () => void;
  initialMediaUrl?: string;
  initialMediaTitle?: string;
  messages?: Message[];
  decryptedMediaUrls?: Record<string, string>;
  onSendInviteMessage?: (text: string, payload?: any) => Promise<void>;
}

export const WatchPartyModal: React.FC<WatchPartyModalProps> = ({
  conversation,
  currentUser,
  isOpen,
  onClose,
  initialMediaUrl,
  initialMediaTitle,
  messages = [],
  decryptedMediaUrls = {},
  onSendInviteMessage,
}) => {
  const [session, setSession] = useState<WatchPartySession | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [leaderNotice, setLeaderNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [inviteSent, setInviteSent] = useState(false);
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  // Launcher state for starting without pre-existing session
  const [launchTab, setLaunchTab] = useState<'chat' | 'url' | 'upload'>('chat');
  const [customUrl, setCustomUrl] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [isStarting, setIsStarting] = useState(false);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const isSyncingFromRemote = useRef<boolean>(false);
  const lastSyncBroadcast = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Draggable mini-player coordinates & physics
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ startX: number; startY: number; initX: number; initY: number }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });

  const handleDragStart = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    isDraggingRef.current = true;
    const cardEl = containerRef.current?.querySelector('.pointer-events-auto') as HTMLElement;
    const rect = cardEl?.getBoundingClientRect();
    const currentX = rect ? rect.left : window.innerWidth - 350;
    const currentY = rect ? rect.top : window.innerHeight - 250;

    dragStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initX: currentX,
      initY: currentY,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return;
      const deltaX = moveEvent.clientX - dragStartRef.current.startX;
      const deltaY = moveEvent.clientY - dragStartRef.current.startY;
      const newX = Math.max(10, Math.min(window.innerWidth - 320, dragStartRef.current.initX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 200, dragStartRef.current.initY + deltaY));
      setMiniPos({ x: newX, y: newY });
    };

    const handleMouseUp = () => {
      isDraggingRef.current = false;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    isDraggingRef.current = true;
    const cardEl = containerRef.current?.querySelector('.pointer-events-auto') as HTMLElement;
    const rect = cardEl?.getBoundingClientRect();
    const currentX = rect ? rect.left : window.innerWidth - 350;
    const currentY = rect ? rect.top : window.innerHeight - 250;

    dragStartRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      initX: currentX,
      initY: currentY,
    };

    const handleTouchMove = (moveEvent: TouchEvent) => {
      if (!isDraggingRef.current || moveEvent.touches.length !== 1) return;
      const t = moveEvent.touches[0];
      const deltaX = t.clientX - dragStartRef.current.startX;
      const deltaY = t.clientY - dragStartRef.current.startY;
      const newX = Math.max(10, Math.min(window.innerWidth - 300, dragStartRef.current.initX + deltaX));
      const newY = Math.max(10, Math.min(window.innerHeight - 180, dragStartRef.current.initY + deltaY));
      setMiniPos({ x: newX, y: newY });
    };

    const handleTouchEnd = () => {
      isDraggingRef.current = false;
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleTouchEnd);
    };

    window.addEventListener('touchmove', handleTouchMove);
    window.addEventListener('touchend', handleTouchEnd);
  };

  // Monitor native fullscreen state
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Keyboard shortcut listener (Space, F, M, Escape)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        const v = videoRef.current;
        if (v) {
          v.muted = !isMuted;
          setIsMuted(!isMuted);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  // Load existing session or initiate new one
  useEffect(() => {
    if (!isOpen) return;

    const initParty = async () => {
      try {
        const res = await api.getWatchParty(conversation.id);
        if (res.active && res.session) {
          setSession(res.session);
          setPlaybackRate(res.session.playback_rate || 1.0);
        } else if (initialMediaUrl) {
          // Auto start with initial media
          startSessionWithMedia(initialMediaUrl, initialMediaTitle || 'Video');
        }
      } catch (e) {
        console.warn('Failed to get watch party session:', e);
      }
    };

    initParty();
  }, [isOpen, conversation.id, initialMediaUrl, initialMediaTitle]);

  // Subscribe to real-time Watch Party WebSocket events
  useEffect(() => {
    if (!isOpen) return;

    const unsubscribeStart = wsManager.subscribe('watch_party.start', (data: any) => {
      if (data.conversation_id === conversation.id && data.session) {
        setSession(data.session);
        setPlaybackError(null);
        setLeaderNotice(`${data.starter_name || 'Host'} started the Watch Party!`);
        setTimeout(() => setLeaderNotice(null), 3000);
      }
    });

    const unsubscribeSync = wsManager.subscribe('watch_party.sync', (data: any) => {
      if (data.conversation_id !== conversation.id) return;
      if (data.sender_id === currentUser.id) return; // Ignore own broadcast

      const video = videoRef.current;
      if (!video) return;

      isSyncingFromRemote.current = true;

      // Drift auto-correction (if diff > 1.2s, adjust position)
      if (typeof data.current_time === 'number') {
        const drift = Math.abs(video.currentTime - data.current_time);
        if (drift > 1.2) {
          video.currentTime = data.current_time;
        }
      }

      if (data.playback_rate && data.playback_rate !== video.playbackRate) {
        video.playbackRate = data.playback_rate;
        setPlaybackRate(data.playback_rate);
      }

      if (data.state === 'playing' && video.paused) {
        video.play().catch(() => {});
        setIsPlaying(true);
      } else if (data.state === 'paused' && !video.paused) {
        video.pause();
        setIsPlaying(false);
      }

      setTimeout(() => {
        isSyncingFromRemote.current = false;
      }, 500);
    });

    const unsubscribeReaction = wsManager.subscribe('watch_party.reaction', (data: any) => {
      if (data.conversation_id !== conversation.id) return;

      const newReaction: FloatingReaction = {
        id: Math.random().toString(),
        emoji: data.emoji,
        senderName: data.sender_name || 'User',
        leftPercent: 15 + Math.random() * 70,
      };

      setReactions((prev) => [...prev, newReaction]);
      setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== newReaction.id));
      }, 3500);
    });

    const unsubscribeEnd = wsManager.subscribe('watch_party.end', (data: any) => {
      if (data.conversation_id === conversation.id) {
        setSession(null);
        setLeaderNotice(`${data.ended_by_name || 'Host'} ended the watch party.`);
        setTimeout(() => {
          onClose();
        }, 1500);
      }
    });

    return () => {
      unsubscribeStart();
      unsubscribeSync();
      unsubscribeReaction();
      unsubscribeEnd();
    };
  }, [isOpen, conversation.id, currentUser.id, onClose]);

  // Sync state broadcast helper
  const broadcastSync = useCallback(
    (actionState: 'playing' | 'paused' | 'seeking') => {
      if (isSyncingFromRemote.current) return;
      const video = videoRef.current;
      if (!video) return;

      const now = Date.now();
      if (now - lastSyncBroadcast.current < 200 && actionState === 'seeking') return;
      lastSyncBroadcast.current = now;

      api.sendWatchPartyAction(conversation.id, {
        action: 'sync',
        state: actionState,
        current_time: video.currentTime,
        playback_rate: video.playbackRate,
      }).catch((err) => console.warn('Failed to sync action:', err));
    },
    [conversation.id]
  );

  const startSessionWithMedia = async (url: string, title: string) => {
    setIsStarting(true);
    setPlaybackError(null);
    try {
      // Ensure attachment URLs have auth token attached so any viewer can play
      let targetUrl = url;
      if (targetUrl.startsWith('/api/v1/attachments/') && !targetUrl.includes('auth=') && !targetUrl.includes('token=')) {
        const token = api.getToken();
        if (token) {
          targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(token);
        }
      }

      const startRes = await api.sendWatchPartyAction(conversation.id, {
        action: 'start',
        media_url: targetUrl,
        media_title: title || 'Video',
        current_time: 0,
        playback_rate: 1.0,
      });
      if (startRes && startRes.session) {
        setSession(startRes.session);
      }
    } catch (err: any) {
      console.warn('Failed to start watch party:', err);
      setPlaybackError(err.message || 'Failed to start watch party');
    } finally {
      setIsStarting(false);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;

    if (video.paused) {
      video.play().then(() => {
        setIsPlaying(true);
        broadcastSync('playing');
      }).catch((err) => {
        console.warn('Playback error:', err);
        setPlaybackError('امکان پخش ویدیو وجود ندارد. ممکن است فرمت یا آدرس ویدیو معتبر نباشد.');
      });
    } else {
      video.pause();
      setIsPlaying(false);
      broadcastSync('paused');
    }
  };

  const handleSeek = (seconds: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(duration, seconds));
    setCurrentTime(video.currentTime);
    broadcastSync('seeking');
  };

  const handleSpeedChange = (speed: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.playbackRate = speed;
    setPlaybackRate(speed);
    broadcastSync(isPlaying ? 'playing' : 'paused');
  };

  const sendReaction = (emoji: string) => {
    api.sendWatchPartyAction(conversation.id, {
      action: 'reaction',
      emoji,
    }).catch(() => {});
  };

  const endParty = async () => {
    try {
      await api.sendWatchPartyAction(conversation.id, { action: 'end' });
      onClose();
    } catch (e) {
      console.warn('Failed to end party:', e);
    }
  };

  const toggleFullscreen = async () => {
    try {
      const target = containerRef.current || videoRef.current;
      if (!document.fullscreenElement) {
        if (target?.requestFullscreen) {
          await target.requestFullscreen();
        } else if ((target as any)?.webkitRequestFullscreen) {
          await (target as any).webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any)?.webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        }
      }
    } catch (e) {
      console.warn('Fullscreen toggle failed:', e);
    }
  };

  const togglePiP = async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP error:', e);
    }
  };

  const handleSendInviteToChat = async () => {
    if (!session) return;
    try {
      const invitePayload = {
        text: `🎬 سینما پارتی همزمان: ${session.media_title} (میزبان: ${session.leader_name})`,
        type: 'watch_party_invite',
        session_id: session.conversation_id,
        media_title: session.media_title,
        media_url: session.media_url,
        leader_name: session.leader_name,
      };

      if (onSendInviteMessage) {
        await onSendInviteMessage(invitePayload.text, invitePayload);
      } else {
        const idempotencyKey = 'idemp_wp_' + Date.now();
        await api.submitMessage(conversation.id, {
          ciphertext: JSON.stringify(invitePayload),
          nonce: 'normal',
          idempotency_key: idempotencyKey,
        });
      }
      setInviteSent(true);
      setTimeout(() => setInviteSent(false), 3000);
    } catch (e) {
      console.warn('Failed to send invite message:', e);
    }
  };

  const handleCopyLink = () => {
    if (!session) return;
    const activeServer = serverManager.getActiveServer();
    const origin = (activeServer.url && activeServer.url.startsWith('http'))
      ? activeServer.url.replace(/\/+$/, '')
      : window.location.origin;

    let fullUrl = session.media_url;
    if (fullUrl.startsWith('/')) {
      fullUrl = `${origin}${fullUrl}`;
    }
    navigator.clipboard.writeText(fullUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs)) return '0:00';
    const mins = Math.floor(secs / 60);
    const remainingSecs = Math.floor(secs % 60);
    return `${mins}:${remainingSecs < 10 ? '0' : ''}${remainingSecs}`;
  };

  if (!isOpen) return null;

  // Extract available video messages from conversation for the quick launcher
  const videoMessages = messages.filter((m) => {
    const att = m.attachmentMeta;
    return att && (
      att.isVideo ||
      att.isRoundVideo ||
      att.contentType?.startsWith('video/') ||
      att.filename?.match(/\.(mp4|webm|mov|mkv)$/i)
    );
  });

  // Resolve video playback URL: prioritize local decrypted blob if available
  const resolvePlaybackUrl = () => {
    if (!session) return '';
    // Check if the current session url matches any local decrypted blob in this chat
    for (const [key, decryptedUrl] of Object.entries(decryptedMediaUrls)) {
      if (session.media_url.includes(key)) {
        return decryptedUrl;
      }
    }
    // If it's a relative attachment URL without auth param, append token
    let url = session.media_url;
    if (url.startsWith('/api/v1/attachments/') && !url.includes('auth=') && !url.includes('token=')) {
      const token = api.getToken();
      if (token) {
        url += (url.includes('?') ? '&' : '?') + 'auth=' + encodeURIComponent(token);
      }
    }
    return url;
  };

  // -------------------------------------------------------------
  // RENDER: LAUNCHPAD IF NO ACTIVE PARTY
  // -------------------------------------------------------------
  if (!session) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
        <div className="relative w-full max-w-xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col text-slate-100">
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30">
                <Film className="w-5 h-5" />
              </div>
              <div>
                <h2 className="text-base font-bold text-white">سینما پارتی همزمان (Watch Party)</h2>
                <p className="text-xs text-slate-400">تماشای همزمان ویدیو با اعضای گفتگو با همگام‌سازی زنده</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Tab Selector */}
          <div className="flex border-b border-slate-800 bg-slate-950/30 px-6 pt-3 gap-4">
            <button
              onClick={() => setLaunchTab('chat')}
              className={`pb-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
                launchTab === 'chat'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Film className="w-4 h-4" />
              <span>ویدیوهای این گفتگو ({videoMessages.length})</span>
            </button>

            <button
              onClick={() => setLaunchTab('url')}
              className={`pb-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
                launchTab === 'url'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Link2 className="w-4 h-4" />
              <span>لینک مستقیم یا استریم</span>
            </button>

            <button
              onClick={() => setLaunchTab('upload')}
              className={`pb-2.5 text-xs font-semibold border-b-2 transition flex items-center gap-1.5 cursor-pointer ${
                launchTab === 'upload'
                  ? 'border-indigo-500 text-indigo-400'
                  : 'border-transparent text-slate-400 hover:text-slate-200'
              }`}
            >
              <Upload className="w-4 h-4" />
              <span>آپلود از دستگاه</span>
            </button>
          </div>

          {/* Body Content */}
          <div className="p-6 overflow-y-auto max-h-[60vh]">
            {playbackError && (
              <div className="mb-4 p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{playbackError}</span>
              </div>
            )}

            {/* TAB 1: Chat Videos */}
            {launchTab === 'chat' && (
              <div className="space-y-3">
                {videoMessages.length === 0 ? (
                  <div className="text-center py-8 text-slate-400 space-y-2">
                    <Film className="w-10 h-10 mx-auto text-slate-600 stroke-[1.5]" />
                    <p className="text-sm">هنوز ویدیویی در این چت ارسال نشده است.</p>
                    <p className="text-xs text-slate-500">می‌توانید از تب «لینک مستقیم» یا «آپلود» یک ویدیو اضافه کنید.</p>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    {videoMessages.map((msg) => {
                      const att = msg.attachmentMeta;
                      if (!att) return null;
                      const videoUrl = decryptedMediaUrls[msg.id] || `/api/v1/attachments/${att.id}`;
                      const title = att.filename || 'Video';

                      return (
                        <div
                          key={msg.id}
                          className="flex items-center justify-between p-3 rounded-xl bg-slate-800/60 hover:bg-slate-800 border border-slate-700/60 transition gap-3"
                        >
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            <div className="w-10 h-10 rounded-lg bg-indigo-600/20 text-indigo-400 flex items-center justify-center shrink-0">
                              <Film className="w-5 h-5" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-white truncate">{title}</div>
                              <div className="text-xs text-slate-400">
                                ارسال شده توسط: {msg.sender_username || 'User'}
                              </div>
                            </div>
                          </div>
                          <button
                            disabled={isStarting}
                            onClick={() => startSessionWithMedia(videoUrl, title)}
                            className="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm transition flex items-center gap-1.5 cursor-pointer shrink-0 disabled:opacity-50"
                          >
                            <Play className="w-3.5 h-3.5 fill-white" />
                            <span>شروع پارتی</span>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: Direct URL */}
            {launchTab === 'url' && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">آدرس اینترنتی ویدیو یا لینک استریم</label>
                  <input
                    type="url"
                    placeholder="https://example.com/video.mp4 یا /s/sh_..."
                    value={customUrl}
                    onChange={(e) => setCustomUrl(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[11px] text-slate-400">پشتیبانی از لینک‌های مستقیم MP4، WebM، و لینک‌های ساخته شده سنورا (/s/...).</p>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-slate-300">عنوان ویدیو (اختیاری)</label>
                  <input
                    type="text"
                    placeholder="نام ویدیو برای نمایش به اعضا..."
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-800 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <button
                  disabled={!customUrl.trim() || isStarting}
                  onClick={() => startSessionWithMedia(customUrl.trim(), customTitle.trim() || 'Online Stream')}
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold shadow-lg shadow-indigo-600/30 transition flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>{isStarting ? 'در حال ایجاد اتاق...' : 'شروع سینما پارتی'}</span>
                </button>
              </div>
            )}

            {/* TAB 3: Upload Local Video */}
            {launchTab === 'upload' && (
              <div className="space-y-4 text-center py-6">
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="video/*"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    setIsStarting(true);
                    setPlaybackError(null);
                    try {
                      const att = await api.uploadAttachmentWithProgress(
                        conversation.id,
                        file,
                        file.name,
                        false
                      );
                      const streamUrl = `/api/v1/attachments/${att.id}`;
                      await startSessionWithMedia(streamUrl, file.name);
                    } catch (err: any) {
                      setPlaybackError(err.message || 'خطا در آپلود ویدیو');
                      setIsStarting(false);
                    }
                  }}
                />
                <div
                  onClick={() => fileInputRef.current?.click()}
                  className="p-8 border-2 border-dashed border-slate-700 hover:border-indigo-500/60 rounded-2xl bg-slate-950/40 hover:bg-slate-950/60 transition cursor-pointer flex flex-col items-center justify-center gap-3"
                >
                  <div className="w-12 h-12 rounded-full bg-indigo-600/20 text-indigo-400 flex items-center justify-center">
                    <Upload className="w-6 h-6" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-white">انتخاب فایل ویدیو از سیستم</div>
                    <div className="text-xs text-slate-400 mt-1">فرمت‌های MP4، WebM، MKV، MOV پشتیبانی می‌شوند</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const isLeader = session.leader_id === currentUser.id;
  const playbackSource = resolvePlaybackUrl();

  // -------------------------------------------------------------
  // RENDER: UNIFIED WATCH PARTY STAGE (THEATER & DRAGGABLE PIP MINI-PLAYER)
  // -------------------------------------------------------------
  return (
    <div
      ref={containerRef}
      className={
        isMinimized
          ? 'fixed inset-0 pointer-events-none z-50 overflow-hidden'
          : `fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md animate-fade-in ${
              isFullscreen ? 'p-0 w-screen h-screen' : 'p-3 md:p-6'
            }`
      }
    >
      <div
        style={
          isMinimized
            ? miniPos
              ? { left: `${miniPos.x}px`, top: `${miniPos.y}px` }
              : { bottom: '5.5rem', right: '1.5rem' }
            : undefined
        }
        className={
          isMinimized
            ? 'pointer-events-auto absolute z-50 w-76 sm:w-88 rounded-2xl shadow-[0_25px_60px_-15px_rgba(0,0,0,0.95)] border border-indigo-500/40 bg-slate-900/95 backdrop-blur-2xl overflow-hidden flex flex-col text-white transition-all group'
            : `relative w-full bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col text-slate-100 ${
                isFullscreen ? 'w-screen h-screen rounded-none max-h-screen' : 'max-w-5xl rounded-2xl max-h-[92vh]'
              }`
        }
      >
        {/* Floating live reaction animations container */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-30">
          {reactions.map((r) => (
            <div
              key={r.id}
              className={`absolute bottom-16 flex flex-col items-center animate-float-up opacity-90 transition-all duration-300 ${
                isMinimized ? 'scale-75' : ''
              }`}
              style={{ left: `${r.leftPercent}%` }}
            >
              <span className={isMinimized ? 'text-xl' : 'text-3xl'}>{r.emoji}</span>
              {!isMinimized && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/60 text-white font-medium mt-0.5">
                  {r.senderName}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Header Bar */}
        {isMinimized ? (
          /* Mini Player Drag Header */
          <div
            onMouseDown={handleDragStart}
            onTouchStart={handleTouchStart}
            className="flex items-center justify-between px-3 py-2 bg-slate-950/90 border-b border-slate-800/80 cursor-grab active:cursor-grabbing select-none z-20"
          >
            <div className="flex items-center gap-2 min-w-0">
              <GripHorizontal className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
              <span className="text-xs font-bold truncate max-w-[130px] sm:max-w-[160px] text-white">
                {session.media_title}
              </span>
            </div>

            <div className="flex items-center gap-1 shrink-0" onMouseDown={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  if (videoRef.current) {
                    videoRef.current.muted = !isMuted;
                    setIsMuted(!isMuted);
                  }
                }}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                title={isMuted ? 'صدادار' : 'بی‌صدا'}
              >
                {isMuted ? <VolumeX className="w-3.5 h-3.5 text-rose-400" /> : <Volume2 className="w-3.5 h-3.5" />}
              </button>
              <button
                onClick={() => setIsMinimized(false)}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                title="بزرگنمایی به تئاتر"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={onClose}
                className="p-1 rounded-lg hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                title="بستن"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          /* Full Theater Header */
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-800 bg-slate-950/70 z-20">
            <div className="flex items-center gap-3 min-w-0">
              <div className="p-2 rounded-xl bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 shrink-0">
                <Film className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm md:text-base font-bold text-white truncate max-w-xs md:max-w-md">
                    {session.media_title}
                  </h2>
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-1 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    زنده (Watch Party)
                  </span>
                </div>
                <p className="text-xs text-slate-400 truncate">
                  میزبان: <span className="text-indigo-400 font-medium">{session.leader_name}</span>
                  {isLeader && <span className="mr-1 text-emerald-400 font-semibold">(شما)</span>}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              {/* Invite Button to Chat */}
              <button
                onClick={handleSendInviteToChat}
                className="px-2.5 py-1.5 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/30 text-indigo-300 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                title="ارسال پیام دعوت در این چت برای ورود اعضا"
              >
                {inviteSent ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Share2 className="w-3.5 h-3.5" />}
                <span className="hidden sm:inline">{inviteSent ? 'ارسال شد!' : 'دعوت به پارتی'}</span>
              </button>

              {/* Copy Shareable Link */}
              <button
                onClick={handleCopyLink}
                className="p-2 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                title="کپی لینک استریم"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>

              {/* System PiP */}
              {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
                <button
                  onClick={togglePiP}
                  className="p-2 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                  title="تصویر در تصویر سیستم"
                >
                  <Tv className="w-4 h-4" />
                </button>
              )}

              {/* Minimize to PiP */}
              {!isFullscreen && (
                <button
                  onClick={() => setIsMinimized(true)}
                  className="p-2 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                  title="کوچک کردن به حالت شناور"
                >
                  <Minimize2 className="w-4 h-4" />
                </button>
              )}

              {/* Native Fullscreen Toggle */}
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                title={isFullscreen ? 'خروج از تمام‌صفحه' : 'تمام‌صفحه (F)'}
              >
                <Maximize2 className="w-4 h-4" />
              </button>

              {/* Close */}
              <button
                onClick={onClose}
                className="p-2 rounded-xl hover:bg-slate-800 text-slate-300 hover:text-white transition cursor-pointer"
                title="بستن"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>
        )}

        {/* Video Player Display — PERSISTENT SINGLE NODE IN REACT */}
        <div
          onDoubleClick={isMinimized ? () => setIsMinimized(false) : toggleFullscreen}
          className={
            isMinimized
              ? 'relative aspect-video bg-black flex items-center justify-center overflow-hidden'
              : 'relative flex-1 bg-black flex items-center justify-center overflow-hidden min-h-[340px]'
          }
        >
          <video
            ref={videoRef}
            src={playbackSource}
            crossOrigin="anonymous"
            className="w-full h-full object-contain cursor-pointer"
            playsInline
            onClick={togglePlay}
            onTimeUpdate={() => videoRef.current && setCurrentTime(videoRef.current.currentTime)}
            onLoadedMetadata={() => videoRef.current && setDuration(videoRef.current.duration)}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onError={() => {
              setPlaybackError('خطا در پخش منبع ویدیو. لطفاً مطمئن شوید فایل یا آدرس در دسترس است.');
            }}
          />

          {/* Central Play/Pause indicator */}
          {!isPlaying ? (
            <button
              onClick={togglePlay}
              className={`absolute inset-0 m-auto rounded-full bg-indigo-600/80 hover:bg-indigo-600 text-white flex items-center justify-center transition shadow-2xl backdrop-blur-md cursor-pointer hover:scale-110 ${
                isMinimized ? 'w-11 h-11' : 'w-16 h-16'
              }`}
            >
              <Play className={`${isMinimized ? 'w-5 h-5 ml-0.5' : 'w-8 h-8 ml-1'} fill-white`} />
            </button>
          ) : isMinimized ? (
            <button
              onClick={togglePlay}
              className="absolute inset-0 m-auto w-11 h-11 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition opacity-0 group-hover:opacity-100 cursor-pointer backdrop-blur-md"
            >
              <Pause className="w-5 h-5 text-white" />
            </button>
          ) : null}

          {/* Leader notification banner */}
          {leaderNotice && !isMinimized && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 rounded-full bg-indigo-600/90 text-white text-xs font-semibold shadow-lg backdrop-blur-md animate-fade-in z-20">
              {leaderNotice}
            </div>
          )}

          {/* Playback Error Alert Overlay */}
          {playbackError && (
            <div className="absolute inset-0 m-auto max-w-sm h-fit p-4 rounded-2xl bg-slate-900/90 border border-rose-500/40 text-center space-y-3 z-30 shadow-2xl backdrop-blur-md">
              <AlertCircle className="w-8 h-8 text-rose-400 mx-auto" />
              <div className="text-xs text-rose-200">{playbackError}</div>
              <button
                onClick={() => {
                  setPlaybackError(null);
                  if (videoRef.current) {
                    videoRef.current.load();
                    videoRef.current.play().catch(() => {});
                  }
                }}
                className="px-4 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold cursor-pointer shadow-md"
              >
                تلاش مجدد
              </button>
            </div>
          )}
        </div>

        {/* Controls Footer: Mini Footer vs Theater Footer */}
        {isMinimized ? (
          <div className="px-3 py-2 bg-slate-950/90 border-t border-slate-800/80 flex flex-col gap-1.5 z-20">
            {/* Timeline Scrubber */}
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-slate-400 font-mono shrink-0">
                {formatTime(currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                onChange={(e) => handleSeek(Number(e.target.value))}
                className="flex-1 h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <span className="text-[10px] text-slate-400 font-mono shrink-0">
                {formatTime(duration)}
              </span>
            </div>

            {/* Quick reaction row */}
            <div className="flex items-center justify-between pt-0.5">
              <div className="flex items-center gap-1">
                {['❤️', '🔥', '😂', '👏'].map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => sendReaction(emoji)}
                    className="w-6 h-6 rounded hover:bg-slate-800 text-xs flex items-center justify-center transition cursor-pointer hover:scale-125"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-indigo-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>{session.leader_name}</span>
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 bg-slate-950/90 border-t border-slate-800 space-y-3 z-20">
            {/* Timeline Scrubber */}
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-400 font-mono w-10 text-right">
                {formatTime(currentTime)}
              </span>
              <input
                type="range"
                min={0}
                max={duration || 100}
                step={0.1}
                value={currentTime}
                onChange={(e) => handleSeek(Number(e.target.value))}
                className="flex-1 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
              />
              <span className="text-xs text-slate-400 font-mono w-10">
                {formatTime(duration)}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
              {/* Playback action buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={togglePlay}
                  className="p-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white transition flex items-center justify-center cursor-pointer shadow-md shadow-indigo-600/30"
                >
                  {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5 fill-white" />}
                </button>

                <button
                  onClick={() => handleSeek(currentTime - 10)}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                  title="۱۰ ثانیه به عقب"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>

                <button
                  onClick={() => handleSeek(currentTime + 10)}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                  title="۱۰ ثانیه به جلو"
                >
                  <FastForward className="w-4 h-4" />
                </button>

                {/* Volume Slider */}
                <div className="hidden sm:flex items-center gap-1.5 px-2 py-1 bg-slate-900 rounded-lg border border-slate-800">
                  <button
                    onClick={() => {
                      const video = videoRef.current;
                      if (!video) return;
                      video.muted = !isMuted;
                      setIsMuted(!isMuted);
                    }}
                    className="text-slate-400 hover:text-white cursor-pointer"
                  >
                    {isMuted ? <VolumeX className="w-4 h-4 text-rose-400" /> : <Volume2 className="w-4 h-4" />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={isMuted ? 0 : volume}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setVolume(val);
                      if (videoRef.current) {
                        videoRef.current.volume = val;
                        videoRef.current.muted = false;
                        setIsMuted(false);
                      }
                    }}
                    className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                </div>

                {/* Playback Rate Selector */}
                <select
                  value={playbackRate}
                  onChange={(e) => handleSpeedChange(Number(e.target.value))}
                  className="px-2 py-1.5 bg-slate-800 border border-slate-700 text-xs text-white rounded-lg cursor-pointer focus:outline-none"
                >
                  <option value={0.5}>0.5x</option>
                  <option value={0.75}>0.75x</option>
                  <option value={1.0}>1.0x</option>
                  <option value={1.25}>1.25x</option>
                  <option value={1.5}>1.5x</option>
                  <option value={2.0}>2.0x</option>
                </select>
              </div>

              {/* Live Floating Reactions Bar */}
              <div className="flex items-center gap-1.5 p-1 bg-slate-900/90 rounded-xl border border-slate-800">
                <span className="text-[11px] text-slate-400 px-2 font-medium">واکنش:</span>
                {['❤️', '🔥', '😂', '👏', '🎉', '😱'].map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => sendReaction(emoji)}
                    className="w-7 h-7 rounded-lg hover:bg-slate-800 hover:scale-125 transition-transform flex items-center justify-center text-sm cursor-pointer"
                  >
                    {emoji}
                  </button>
                ))}
              </div>

              {/* Actions: Fullscreen, Invite & End Party */}
              <div className="flex items-center gap-2">
                <button
                  onClick={toggleFullscreen}
                  className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition cursor-pointer"
                  title={isFullscreen ? 'خروج از تمام‌صفحه' : 'تمام‌صفحه (F)'}
                >
                  <Maximize2 className="w-4 h-4" />
                </button>

                {isLeader && (
                  <button
                    onClick={endParty}
                    className="px-3 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 text-xs font-semibold border border-rose-500/30 transition cursor-pointer"
                  >
                    پایان پارتی
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
