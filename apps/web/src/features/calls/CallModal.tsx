import { uiText, useUILanguage } from "../../app/language";
import React, { useEffect, useRef, useState } from 'react';
import { CallSession, webrtcManager, ScreenQualityPreset } from './webrtcManager';
import { mediaDeviceManager } from './mediaDeviceManager';
import {
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Mic,
  MicOff,
  User,
  Monitor,
  Settings,
  ShieldCheck,
  Volume2,
  X,
  Maximize2,
  Minimize2,
  Maximize,
  Minimize,
  Sparkles,
  Check,
  ChevronDown,
  Scaling,
} from 'lucide-react';

interface CallModalProps {
  session: CallSession;
  lang?: 'en' | 'fa';
}

export const CallModal: React.FC<CallModalProps> = ({ session, lang = 'en' }) => {
  const uiLang = useUILanguage(lang);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const videoStageRef = useRef<HTMLDivElement>(null);

  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [isTheaterMode, setIsTheaterMode] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain');
  const [showQualityMenu, setShowQualityMenu] = useState(false);

  const [audioDevices, setAudioDevices] = useState<{
    audioInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
  }>({ audioInputs: [], audioOutputs: [], videoInputs: [] });

  const [selectedAudioIn, setSelectedAudioIn] = useState('');
  const [selectedAudioOut, setSelectedAudioOut] = useState('');
  const [selectedVideoIn, setSelectedVideoIn] = useState('');

  // Sync fullscreen state via standard browser event
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

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        const el = videoStageRef.current;
        if (el?.requestFullscreen) {
          await el.requestFullscreen();
        } else if ((el as any)?.webkitRequestFullscreen) {
          await (el as any).webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if ((document as any)?.webkitExitFullscreen) {
          await (document as any).webkitExitFullscreen();
        }
      }
    } catch (err) {
      console.warn('[CallModal] Fullscreen toggle failed:', err);
    }
  };

  const currentQuality: ScreenQualityPreset = session.screenQuality || 'auto';

  const handleSelectQuality = (preset: ScreenQualityPreset) => {
    setShowQualityMenu(false);
    if (session.isScreenSharing) {
      webrtcManager.setScreenShareQuality(preset);
    } else {
      webrtcManager.requestRemoteScreenQuality(preset);
    }
  };

  const qualityOptions: { id: ScreenQualityPreset; label: string; desc: string; badge: string }[] = [
    {
      id: 'auto',
      label: lang === 'fa' ? 'خودکار (هوشمند)' : 'Auto (Adaptive)',
      desc: lang === 'fa' ? 'تطبیق خودکار با سرعت شبکه' : 'Dynamically adapts to network',
      badge: 'AUTO',
    },
    {
      id: '1080p',
      label: '1080p 60fps',
      desc: lang === 'fa' ? 'کیفیت فوق‌العاده شفاف و روان' : 'FHD Ultra-smooth, crystal clear',
      badge: 'FHD',
    },
    {
      id: '720p',
      label: '720p 30fps',
      desc: lang === 'fa' ? 'کیفیت استاندارد اچ‌دی' : 'HD Balanced performance & clarity',
      badge: 'HD',
    },
    {
      id: '480p',
      label: '480p 30fps',
      desc: lang === 'fa' ? 'صرفه‌جویی در مصرف اینترنت' : 'Data saver, lightweight bandwidth',
      badge: 'SD',
    },
  ];

  // Load available devices
  useEffect(() => {
    mediaDeviceManager.enumerateDevices().then((devs) => {
      setAudioDevices(devs);
      setSelectedAudioIn(mediaDeviceManager.getSelectedAudioInputId());
      setSelectedAudioOut(mediaDeviceManager.getSelectedAudioOutputId());
      setSelectedVideoIn(mediaDeviceManager.getSelectedVideoInputId());
    });
  }, []);

  // Stable ref attachment callbacks to immediately bind MediaStream when DOM elements mount
  const tryPlayMedia = (el: HTMLMediaElement | null, isAudioCritical: boolean) => {
    if (!el) return;
    const p = el.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        if (isAudioCritical) {
          webrtcManager.setPlaybackBlocked(false);
        }
      }).catch((err) => {
        if (err?.name === 'NotAllowedError') {
          webrtcManager.setPlaybackBlocked(true);
        } else if (err?.name !== 'AbortError') {
          console.warn('[CallModal] media.play error:', err);
        }
      });
    }
  };

  const attachRemoteVideo = (el: HTMLVideoElement | null) => {
    (remoteVideoRef as any).current = el;
    if (el && session.remoteStream) {
      if (el.srcObject !== session.remoteStream) {
        el.srcObject = session.remoteStream;
      }
      tryPlayMedia(el, false);
    }
  };

  const attachScreenVideo = (el: HTMLVideoElement | null) => {
    (screenVideoRef as any).current = el;
    if (el && session.screenStream) {
      if (el.srcObject !== session.screenStream) {
        el.srcObject = session.screenStream;
      }
      tryPlayMedia(el, false);
    }
  };

  const attachLocalVideo = (el: HTMLVideoElement | null) => {
    (localVideoRef as any).current = el;
    if (el && session.localStream) {
      if (el.srcObject !== session.localStream) {
        el.srcObject = session.localStream;
      }
      tryPlayMedia(el, false);
    }
  };

  // Attach local stream
  useEffect(() => {
    if (localVideoRef.current && session.localStream) {
      if (localVideoRef.current.srcObject !== session.localStream) {
        localVideoRef.current.srcObject = session.localStream;
      }
      tryPlayMedia(localVideoRef.current, false);
    }
  }, [session.localStream, session.localStreamRevision, session.state, session.callType, session.isVideoOff]);

  // Attach screen stream
  useEffect(() => {
    if (screenVideoRef.current && session.screenStream) {
      if (screenVideoRef.current.srcObject !== session.screenStream) {
        screenVideoRef.current.srcObject = session.screenStream;
      }
      tryPlayMedia(screenVideoRef.current, false);
    }
  }, [session.screenStream, session.isScreenSharing, session.peerScreenSharing, session.hasRemoteVideo, session.state]);

  // Attach remote stream (audio and video)
  useEffect(() => {
    if (remoteVideoRef.current && session.remoteStream) {
      if (remoteVideoRef.current.srcObject !== session.remoteStream) {
        remoteVideoRef.current.srcObject = session.remoteStream;
      }
      tryPlayMedia(remoteVideoRef.current, false);
    }
    if (remoteAudioRef.current && session.remoteStream) {
      if (remoteAudioRef.current.srcObject !== session.remoteStream) {
        remoteAudioRef.current.srcObject = session.remoteStream;
      }
      tryPlayMedia(remoteAudioRef.current, true);
      mediaDeviceManager.applyAudioOutput(remoteAudioRef.current);
    }
  }, [session.remoteStream, session.remoteStreamRevision, session.state, session.hasRemoteVideo, session.peerScreenSharing]);

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const s = sec % 60;
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getStatusText = () => {
    switch (session.state) {
      case 'outgoing_calling':
        return lang === 'fa' ? 'در حال برقراری تماس...' : 'Calling...';
      case 'outgoing_ringing':
        return lang === 'fa' ? 'در حال زنگ خوردن...' : 'Ringing...';
      case 'incoming_ringing':
        return lang === 'fa' ? 'تماس ورودی...' : 'Incoming Call...';
      case 'connecting':
        return lang === 'fa' ? 'در حال اتصال امن...' : 'Connecting securely...';
      case 'connected':
        return formatDuration(session.durationSeconds);
      case 'rejected':
        return lang === 'fa' ? 'تماس رد شد' : 'Call Declined';
      case 'ended':
        return lang === 'fa' ? 'تماس پایان یافت' : 'Call Ended';
      case 'timeout':
        return lang === 'fa' ? 'بی‌پاسخ' : 'No Answer';
      case 'cancelled':
        return lang === 'fa' ? 'تماس لغو شد' : 'Call Cancelled';
      case 'failed':
        return session.failureReason || (lang === 'fa' ? 'برقراری تماس ناموفق بود' : 'Call Failed');
      default:
        return '';
    }
  };

  const isRinging =
    session.state === 'outgoing_calling' ||
    session.state === 'outgoing_ringing' ||
    session.state === 'incoming_ringing';

  const handleDeviceChange = async (
    kind: 'audioinput' | 'audiooutput' | 'videoinput',
    deviceId: string
  ) => {
    if (kind === 'audioinput') {
      setSelectedAudioIn(deviceId);
      await webrtcManager.switchAudioInput(deviceId).catch((e) => console.warn('[CallModal] switchAudioInput:', e));
    } else if (kind === 'audiooutput') {
      setSelectedAudioOut(deviceId);
      mediaDeviceManager.setSelectedAudioOutputId(deviceId);
      if (remoteVideoRef.current) mediaDeviceManager.applyAudioOutput(remoteVideoRef.current);
      if (remoteAudioRef.current) mediaDeviceManager.applyAudioOutput(remoteAudioRef.current);
    } else if (kind === 'videoinput') {
      setSelectedVideoIn(deviceId);
      await webrtcManager.switchVideoInput(deviceId).catch((e) => console.warn('[CallModal] switchVideoInput:', e));
    }
  };

  const hasLiveLocalVideo =
    !session.isVideoOff &&
    !!session.localStream?.getVideoTracks().some((t) => t.readyState === 'live');
  const showVideoStage =
    session.state === 'connected' &&
    (hasLiveLocalVideo || session.isScreenSharing || session.peerScreenSharing || session.hasRemoteVideo);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-xl p-4 animate-fadeIn select-none">
      {/* Hidden audio element for remote call audio routed cleanly through selected sink */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      <div className={`relative transition-all duration-300 w-full ${isTheaterMode ? 'max-w-6xl w-[96vw]' : 'max-w-xl'} bg-[#17212b]/95 border border-[#242f3d] rounded-3xl overflow-hidden shadow-2xl flex flex-col items-center`}>
        {/* Top Header Banner */}
        <div className="w-full flex items-center justify-between px-6 pt-5 pb-2 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <ShieldCheck size={15} />
              <span>{uiText("End-to-End Encrypted Call", uiLang)}</span>
            </div>
            {session.iceCandidateType && session.state === 'connected' && (
              <span className="px-2 py-0.5 rounded-full bg-white/5 text-[10px] font-mono text-slate-400">
                {session.iceCandidateType === 'relay' ? 'TURN' : session.iceCandidateType.toUpperCase()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {session.state === 'failed' && (
              <button
                type="button"
                onClick={() => webrtcManager.resetSession()}
                className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
                title={uiText("Close", uiLang)}
              >
                <X size={16} />
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowDeviceSettings(!showDeviceSettings)}
              className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
              title={uiText("Call Settings (Microphone, Camera, Audio)", uiLang)}
            >
              <Settings size={16} />
            </button>
          </div>
        </div>

        {/* Video / Screen Share Area (When Connected with Local Camera, Remote Video, or Screen Share) */}
        {showVideoStage ? (
          <div
            ref={videoStageRef}
            className={`relative w-full ${
              isFullscreen
                ? 'fixed inset-0 z-50 w-screen h-screen bg-black flex items-center justify-center'
                : isTheaterMode
                ? 'h-[68vh] sm:h-[75vh] bg-black flex items-center justify-center overflow-hidden transition-all duration-300'
                : 'h-84 sm:h-96 bg-black flex items-center justify-center overflow-hidden transition-all duration-300'
            }`}
          >
            {/* 1. Main Stage */}
            {session.peerScreenSharing || (session.remoteStream && session.hasRemoteVideo) ? (
              /* Remote Video or Remote Screen Share (Full Size) */
              <video
                ref={attachRemoteVideo}
                autoPlay
                playsInline
                muted
                className={`w-full h-full ${
                  session.peerScreenSharing
                    ? (fitMode === 'contain' ? 'object-contain' : 'object-cover')
                    : 'object-cover'
                } bg-black`}
              />
            ) : session.isScreenSharing && session.screenStream ? (
              /* Local Screen Preview (Full Size when remote has no video) */
              <video
                ref={attachScreenVideo}
                autoPlay
                playsInline
                muted
                className={`w-full h-full ${fitMode === 'contain' ? 'object-contain' : 'object-cover'} bg-slate-950`}
              />
            ) : (session.callType === 'video' || hasLiveLocalVideo) ? (
              /* Video or camera-upgraded call waiting for remote camera, show remote avatar */
              <div className="flex flex-col items-center justify-center space-y-3">
                <div className="w-24 h-24 rounded-full bg-slate-800 flex items-center justify-center text-white text-3xl font-bold border border-white/10">
                  {session.peerName ? session.peerName.charAt(0) : <User size={48} />}
                </div>
                <p className="text-sm text-slate-400">
                  {lang === "fa" ? 'در انتظار دریافت تصویر...' : 'Connecting video...'}
                </p>
              </div>
            ) : null}

            {/* 2. PiP Corner Window */}
            {(session.isScreenSharing && (session.peerScreenSharing || session.hasRemoteVideo)) ? (
              /* Local Screen Preview in PiP when viewing remote video/screen */
              <div className="absolute bottom-4 right-4 w-36 h-24 sm:w-48 sm:h-32 bg-slate-950 rounded-2xl overflow-hidden border-2 border-blue-500 shadow-2xl z-20">
                <video
                  ref={attachScreenVideo}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-contain bg-black"
                />
                <div className="absolute bottom-1 left-2 px-1.5 py-0.5 rounded bg-blue-600/90 text-[10px] text-white font-medium">
                  {lang === "fa" ? 'صفحه شما' : 'Your Screen'}
                </div>
              </div>
            ) : (hasLiveLocalVideo && session.localStream) ? (
              /* Local Camera PiP */
              <div className="absolute bottom-4 right-4 w-28 h-36 sm:w-36 sm:h-48 bg-slate-900 rounded-2xl overflow-hidden border-2 border-[#24A1DE] shadow-2xl z-20">
                <video
                  ref={attachLocalVideo}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover transform -scale-x-100"
                />
              </div>
            ) : null}

            {(session.autoplayBlocked || session.mediaPlaybackBlocked) && (
              <button
                type="button"
                onClick={() => webrtcManager.unlockAudio()}
                className="absolute bottom-4 left-4 z-30 px-4 py-2 rounded-full bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg animate-bounce transition cursor-pointer"
              >
                <span>🔊</span>
                <span>{lang === 'fa' ? 'برای فعال‌سازی صدای تماس کلیک کنید' : 'Tap to Enable Audio'}</span>
              </button>
            )}

            {session.isReconnectingIce && (
              <div className="absolute bottom-14 left-4 z-30 px-3 py-1 rounded-full bg-amber-500/90 text-slate-950 text-[11px] font-semibold shadow">
                {lang === 'fa' ? 'در حال اتصال مجدد رسانه...' : 'Reconnecting media...'}
              </div>
            )}

            {/* Top Left Status & Indicators Overlay */}
            <div className="absolute top-4 left-4 z-20 flex items-center gap-2">
              {session.isScreenSharing && (
                <div className="px-3 py-1.5 rounded-xl bg-blue-600/90 backdrop-blur-md text-white text-xs font-semibold shadow-lg flex items-center gap-2">
                  <Monitor size={15} className="animate-pulse" />
                  <span>{lang === "fa" ? 'در حال اشتراک صفحه' : 'Sharing Screen'}</span>
                </div>
              )}

              {session.peerScreenSharing && (
                <div className="px-3 py-1.5 rounded-xl bg-emerald-600/90 backdrop-blur-md text-white text-xs font-semibold shadow-lg flex items-center gap-2">
                  <Monitor size={15} />
                  <span>{session.peerName} {lang === "fa" ? '(صفحه اشتراکی)' : '(Screen)'}</span>
                </div>
              )}

              <div className="px-3 py-1.5 rounded-xl bg-black/60 backdrop-blur-md text-white text-xs flex items-center gap-2 border border-white/5">
                <span className="font-semibold">{session.peerName}</span>
                <span className="font-mono text-[#24A1DE]">{formatDuration(session.durationSeconds)}</span>
              </div>
            </div>

            {/* Top Right Controls Overlay: Quality Preset, Fit Mode, Theater Mode, Fullscreen */}
            <div className="absolute top-4 right-4 z-30 flex items-center gap-1.5 bg-black/60 backdrop-blur-md p-1.5 rounded-2xl border border-white/10 shadow-2xl">
              {/* Quality Dropdown Toggle */}
              {(session.isScreenSharing || session.peerScreenSharing) && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowQualityMenu(!showQualityMenu)}
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold transition cursor-pointer ${
                      showQualityMenu ? 'bg-[#24A1DE] text-white shadow-md' : 'text-slate-200 hover:bg-white/15'
                    }`}
                    title={lang === "fa" ? 'کیفیت اشتراک صفحه' : 'Screen Share Quality'}
                  >
                    <Sparkles size={13} className="text-amber-400" />
                    <span className="font-mono text-[11px] uppercase font-bold">{currentQuality}</span>
                    <ChevronDown size={13} />
                  </button>

                  {/* Quality Menu Popover */}
                  {showQualityMenu && (
                    <div className="absolute right-0 mt-2 w-56 bg-[#17212b] border border-[#242f3d] rounded-2xl shadow-2xl p-1.5 z-40 animate-fadeIn text-xs">
                      <div className="px-2.5 py-1 text-[10px] font-bold text-slate-400 uppercase tracking-wider border-b border-white/5 mb-1">
                        {lang === "fa" ? 'انتخاب کیفیت نمایش' : 'Stream Quality'}
                      </div>
                      {qualityOptions.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => handleSelectQuality(opt.id)}
                          className={`w-full flex items-center justify-between px-2.5 py-2 rounded-xl transition cursor-pointer text-left ${
                            currentQuality === opt.id
                              ? 'bg-[#24A1DE]/20 text-[#24A1DE] font-semibold'
                              : 'text-slate-300 hover:bg-white/5'
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span>{opt.label}</span>
                              <span className="px-1.5 py-0.2 rounded text-[9px] font-mono bg-white/10 text-slate-300">
                                {opt.badge}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 font-normal">{opt.desc}</div>
                          </div>
                          {currentQuality === opt.id && <Check size={14} className="text-[#24A1DE]" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Fit / Fill Aspect Toggle */}
              <button
                type="button"
                onClick={() => setFitMode(fitMode === 'contain' ? 'cover' : 'contain')}
                className={`p-1.5 rounded-xl text-xs transition cursor-pointer ${
                  fitMode === 'cover' ? 'bg-[#24A1DE] text-white' : 'text-slate-300 hover:bg-white/15'
                }`}
                title={
                  fitMode === 'contain'
                    ? (lang === "fa" ? 'تغییر اندازه: تمام کادر (Fill)' : 'Fill Frame (Crop)')
                    : (lang === "fa" ? 'تغییر اندازه: اندازه اصلی (Fit)' : 'Fit Frame (Original Aspect)')
                }
              >
                <Scaling size={16} />
              </button>

              {/* Theater Mode Toggle (hidden in fullscreen) */}
              {!isFullscreen && (
                <button
                  type="button"
                  onClick={() => setIsTheaterMode(!isTheaterMode)}
                  className={`p-1.5 rounded-xl text-xs transition cursor-pointer ${
                    isTheaterMode ? 'bg-[#24A1DE] text-white' : 'text-slate-300 hover:bg-white/15'
                  }`}
                  title={
                    isTheaterMode
                      ? (lang === "fa" ? 'خروج از حالت بزرگ‌تر (سینمایی)' : 'Exit Theater Mode')
                      : (lang === "fa" ? 'بزرگ‌تر کردن کادر (حالت سینمایی)' : 'Enlarge (Theater Mode)')
                  }
                >
                  {isTheaterMode ? <Minimize size={16} /> : <Maximize size={16} />}
                </button>
              )}

              {/* Native Fullscreen Toggle */}
              <button
                type="button"
                onClick={toggleFullscreen}
                className={`p-1.5 rounded-xl text-xs transition cursor-pointer ${
                  isFullscreen ? 'bg-[#24A1DE] text-white' : 'text-slate-300 hover:bg-white/15'
                }`}
                title={
                  isFullscreen
                    ? (lang === "fa" ? uiText("خروج از تمام‌صفحه", uiLang) : 'Exit Fullscreen')
                    : (lang === "fa" ? uiText("تمام‌صفحه", uiLang) : 'Enter Fullscreen')
                }
              >
                {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>

              {/* Stop Sharing Quick Button (when local user shares) */}
              {session.isScreenSharing && (
                <button
                  type="button"
                  onClick={() => webrtcManager.toggleScreenShare()}
                  className="px-2.5 py-1.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold shadow-md transition flex items-center gap-1 cursor-pointer"
                  title={lang === "fa" ? 'توقف اشتراک صفحه' : 'Stop Sharing'}
                >
                  <X size={13} />
                  <span className="hidden sm:inline">{lang === "fa" ? 'توقف' : 'Stop'}</span>
                </button>
              )}
            </div>

            {/* Fullscreen Floating Bottom Bar */}
            {isFullscreen && (
              <div className="absolute bottom-6 z-30 flex items-center gap-3 px-5 py-2.5 rounded-2xl bg-black/80 backdrop-blur-xl border border-white/15 shadow-2xl animate-fadeIn">
                <span className="text-white text-xs font-semibold">{session.peerName}</span>
                <span className="text-xs font-mono text-[#24A1DE]">{formatDuration(session.durationSeconds)}</span>
                <div className="w-px h-5 bg-white/20" />
                <button
                  type="button"
                  onClick={() => webrtcManager.toggleMute()}
                  className={`p-2 rounded-full cursor-pointer transition ${
                    session.isMuted ? 'bg-red-600 text-white' : 'bg-white/15 text-white hover:bg-white/25'
                  }`}
                  title={session.isMuted ? uiText("Unmute Mic", uiLang) : uiText("Mute Mic", uiLang)}
                >
                  {session.isMuted ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
                <button
                  type="button"
                  onClick={toggleFullscreen}
                  className="p-2 rounded-full bg-white/15 text-white hover:bg-white/25 cursor-pointer transition"
                  title={lang === "fa" ? uiText("خروج از تمام‌صفحه", uiLang) : 'Exit Fullscreen'}
                >
                  <Minimize2 size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => webrtcManager.hangupCall()}
                  className="p-2 rounded-full bg-red-600 hover:bg-red-700 text-white cursor-pointer transition shadow-lg"
                  title={lang === "fa" ? uiText("پایان تماس", uiLang) : uiText("End Call", uiLang)}
                >
                  <PhoneOff size={16} />
                </button>
              </div>
            )}
          </div>
        ) : (
          /* Voice Call or Ringing State View */
          <div className="py-10 px-6 flex flex-col items-center justify-center space-y-6 w-full">
            {/* Caller Avatar with Animated Audio Waves */}
            <div className="relative flex items-center justify-center">
              {/* Outer pulsing rings when ringing or speaking */}
              {isRinging && (
                <>
                  <div className="absolute w-36 h-36 rounded-full border border-[#24A1DE]/40 animate-ping" />
                  <div className="absolute w-44 h-44 rounded-full border border-[#24A1DE]/20 animate-pulse" />
                </>
              )}
              {session.state === 'connected' && (
                <div className="absolute w-36 h-36 rounded-full border-2 border-emerald-500/30 animate-pulse" />
              )}

              <div className="w-28 h-28 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#1e87bb] flex items-center justify-center text-white shadow-2xl shadow-[#24A1DE]/25 overflow-hidden z-10 border-2 border-white/10">
                {session.peerAvatarUrl ? (
                  <img
                    src={session.peerAvatarUrl}
                    alt={session.peerName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-3xl font-bold uppercase tracking-wider">
                    {session.peerName ? session.peerName.charAt(0) : <User size={48} />}
                  </span>
                )}
              </div>
            </div>

            {/* Peer Details & Status */}
            <div className="text-center space-y-1">
              <h3 className="text-2xl font-bold text-white tracking-wide">{session.peerName}</h3>
              <p className="text-xs font-semibold text-[#24A1DE] uppercase tracking-wider">
                {session.callType === 'video'
                  ? (lang === "fa" ? 'تماس تصویری SENORA' : 'SENORA Video Call')
                  : (lang === "fa" ? 'تماس صوتی SENORA' : 'SENORA Voice Call')}
              </p>
              <p className="text-base font-mono text-slate-300 pt-1 font-semibold">{getStatusText()}</p>
              {session.targetOffline && (
                <p className="text-xs text-amber-400 font-medium pt-1">
                  {lang === 'fa' ? 'کاربر در حال حاضر آفلاین است (در انتظار اتصال...)' : 'User appears offline (waiting for connection...)'}
                </p>
              )}
              {session.isReconnectingIce && (
                <p className="text-xs text-amber-400 font-medium pt-1 animate-pulse">
                  {lang === 'fa' ? 'در حال اتصال مجدد رسانه...' : 'Reconnecting media...'}
                </p>
              )}
            </div>

            {/* Autoplay blocked sound/media unlock button */}
            {(session.autoplayBlocked || session.mediaPlaybackBlocked) && (
              <button
                type="button"
                onClick={() => webrtcManager.unlockAudio()}
                className="px-4 py-2 rounded-full bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg animate-bounce transition cursor-pointer"
              >
                <span>🔊</span>
                <span>
                  {session.state === 'incoming_ringing'
                    ? (lang === "fa" ? 'برای پخش صدای زنگ کلیک کنید' : 'Tap to Unmute Ringtone')
                    : (lang === "fa" ? 'برای فعال‌سازی صدای تماس کلیک کنید' : 'Tap to Enable Call Audio')}
                </span>
              </button>
            )}
          </div>
        )}

        {/* Device Settings Popover */}
        {showDeviceSettings && (
          <div className="w-full bg-[#1e2a38] border-t border-[#242f3d] p-4 text-xs text-slate-300 animate-fadeIn space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-white/5">
              <span className="font-semibold text-white">{uiText("Call Audio & Video Devices", uiLang)}</span>
              <button
                type="button"
                onClick={() => setShowDeviceSettings(false)}
                className="p-1 hover:text-white transition cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            {/* Microphone Selection */}
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">{uiText("Microphone", uiLang)}</label>
              <select
                value={selectedAudioIn}
                onChange={(e) => handleDeviceChange('audioinput', e.target.value)}
                className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
              >
                <option value="">{uiText("Default Microphone", uiLang)}</option>
                {audioDevices.audioInputs.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `${uiText('Microphone', uiLang)} ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>

            {/* Speaker Selection (if supported) */}
            {mediaDeviceManager.isSinkIdSupported() && (
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{uiText("Audio Output / Speaker", uiLang)}</label>
                <select
                  value={selectedAudioOut}
                  onChange={(e) => handleDeviceChange('audiooutput', e.target.value)}
                  className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
                >
                  <option value="">{uiText("Default Speaker", uiLang)}</option>
                  {audioDevices.audioOutputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `${uiText('Speaker', uiLang)} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Camera Selection */}
            {(session.callType === 'video' || !session.isVideoOff || audioDevices.videoInputs.length > 0) && (
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{uiText("Camera", uiLang)}</label>
                <select
                  value={selectedVideoIn}
                  onChange={(e) => handleDeviceChange('videoinput', e.target.value)}
                  className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
                >
                  <option value="">{uiText("Default Camera", uiLang)}</option>
                  {audioDevices.videoInputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `${uiText('Camera', uiLang)} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Bottom Control Bar */}
        <div className="w-full bg-[#101720]/95 border-t border-[#242f3d] px-6 py-5 flex items-center justify-center">
          {session.state === 'incoming_ringing' ? (
            /* Incoming Call: Large Answer & Decline Buttons */
            <div className="flex items-center space-x-12">
              <button
                type="button"
                onClick={() => webrtcManager.rejectCall()}
                className="flex flex-col items-center space-y-1.5 group cursor-pointer"
              >
                <div className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center text-white shadow-xl shadow-red-600/30 transition-transform transform group-hover:scale-105 active:scale-95">
                  <PhoneOff size={28} />
                </div>
                <span className="text-xs text-slate-400 group-hover:text-red-400 font-medium">{uiText("Decline", uiLang)}</span>
              </button>

              <button
                type="button"
                onClick={() => webrtcManager.answerCall()}
                className="flex flex-col items-center space-y-1.5 group cursor-pointer"
              >
                <div className="w-16 h-16 rounded-full bg-emerald-600 hover:bg-emerald-700 flex items-center justify-center text-white shadow-xl shadow-emerald-600/30 transition-transform transform group-hover:scale-105 active:scale-95 animate-pulse">
                  <Phone size={28} />
                </div>
                <span className="text-xs text-slate-400 group-hover:text-emerald-400 font-medium">{uiText("Accept", uiLang)}</span>
              </button>
            </div>
          ) : session.state === 'outgoing_calling' || session.state === 'outgoing_ringing' ? (
            /* Outgoing Call Ringing: Cancel Button */
            <div className="flex items-center space-x-6">
              <button
                type="button"
                onClick={() => webrtcManager.hangupCall()}
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-red-600 hover:bg-red-700 text-white font-semibold text-sm shadow-xl shadow-red-600/30 transition-transform transform hover:scale-105 active:scale-95 cursor-pointer"
              >
                <PhoneOff size={18} />
                <span>{uiText("Cancel Call", uiLang)}</span>
              </button>
            </div>
          ) : (
            /* Active Call Controls */
            <div className="flex items-center space-x-4 sm:space-x-5">
              {/* Mute Mic */}
              <button
                type="button"
                onClick={() => webrtcManager.toggleMute()}
                className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                  session.isMuted
                    ? 'bg-red-600/25 text-red-400 border border-red-500/50 hover:bg-red-600/35'
                    : 'bg-[#242f3d] text-slate-200 hover:bg-[#2c3949] border border-white/5'
                }`}
                title={session.isMuted ? uiText("Unmute Microphone", uiLang) : uiText("Mute Microphone", uiLang)}
              >
                {session.isMuted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>

              {/* Toggle Video */}
              <button
                type="button"
                onClick={() => webrtcManager.toggleVideo()}
                className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                  session.isVideoOff
                    ? 'bg-[#242f3d] text-slate-400 hover:bg-[#2c3949] border border-white/5'
                    : 'bg-[#24A1DE] text-white shadow-[#24A1DE]/30'
                }`}
                title={session.isVideoOff ? uiText("Enable Camera", uiLang) : uiText("Disable Camera", uiLang)}
              >
                {session.isVideoOff ? <VideoOff size={20} /> : <Video size={20} />}
              </button>

              {/* Screen Sharing */}
              {session.state === 'connected' && (
                <button
                  type="button"
                  onClick={() => webrtcManager.toggleScreenShare()}
                  className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                    session.isScreenSharing
                      ? 'bg-blue-600 text-white shadow-blue-500/30 ring-2 ring-blue-400'
                      : 'bg-[#242f3d] text-slate-200 hover:bg-[#2c3949] border border-white/5'
                  }`}
                  title={
                    session.isScreenSharing
                      ? (lang === "fa" ? 'توقف اشتراک صفحه' : 'Stop Screen Share')
                      : (lang === "fa" ? 'اشتراک صفحه نمایش' : 'Share Screen')
                  }
                >
                  <Monitor size={20} />
                </button>
              )}

              {/* Speaker / Device Settings */}
              <button
                type="button"
                onClick={() => setShowDeviceSettings(!showDeviceSettings)}
                className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                  showDeviceSettings
                    ? 'bg-[#24A1DE] text-white'
                    : 'bg-[#242f3d] text-slate-200 hover:bg-[#2c3949] border border-white/5'
                }`}
                title={uiText("Audio & Video Devices", uiLang)}
              >
                <Volume2 size={20} />
              </button>

              {/* End Call */}
              <button
                type="button"
                onClick={() => webrtcManager.hangupCall()}
                className="p-3.5 sm:p-4 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-xl shadow-red-600/30 transition-transform hover:scale-105 active:scale-95 cursor-pointer ml-2"
                title={uiText("End Call", uiLang)}
              >
                <PhoneOff size={22} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
