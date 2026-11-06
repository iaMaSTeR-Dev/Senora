import React, { useState, useEffect, useRef } from 'react';
import { MediaShare } from '../../app/types';
import { api } from '../../protocol/api';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize2,
  Minimize2,
  Tv,
  Download,
  Film,
  Lock,
  ArrowRight,
  AlertCircle
} from 'lucide-react';

interface StandaloneWebPlayerProps {
  shareId: string;
}

export const StandaloneWebPlayer: React.FC<StandaloneWebPlayerProps> = ({ shareId }) => {
  const [share, setShare] = useState<MediaShare | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  // Player controls
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsTimeoutRef = useRef<any>(null);

  useEffect(() => {
    const fetchShare = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.getMediaShare(shareId);
        setShare(res.share);
        if (!res.share.has_password) {
          setIsUnlocked(true);
        }
      } catch (err: any) {
        if (err.message && err.message.includes('410')) {
          setError('این لینک استریم منقضی شده است یا به سقف دانلود رسیده است.');
        } else {
          setError('فایل یا لینک استریم مورد نظر یافت نشد.');
        }
      } finally {
        setLoading(false);
      }
    };
    fetchShare();
  }, [shareId]);

  // Fullscreen event listener
  useEffect(() => {
    const handleFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFs);
    return () => document.removeEventListener('fullscreenchange', handleFs);
  }, []);

  // Keyboard controls
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) return;
      const v = videoRef.current;
      if (!v) return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key === 'm' || e.key === 'M') {
        e.preventDefault();
        v.muted = !v.muted;
        setIsMuted(v.muted);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        v.currentTime = Math.min(v.duration, v.currentTime + 5);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isUnlocked, isPlaying]);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.play().catch(() => {});
      setIsPlaying(true);
    } else {
      v.pause();
      setIsPlaying(false);
    }
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const togglePiP = async () => {
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (v.requestPictureInPicture) {
        await v.requestPictureInPicture();
      }
    } catch (e) {
      console.warn('PiP not supported or failed:', e);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = Number(e.target.value);
    const v = videoRef.current;
    if (v) {
      v.currentTime = target;
      setCurrentTime(target);
    }
  };

  const handleRateChange = (rate: number) => {
    const v = videoRef.current;
    if (v) {
      v.playbackRate = rate;
      setPlaybackRate(rate);
    }
  };

  const handleMouseMove = () => {
    setShowControls(true);
    if (controlsTimeoutRef.current) clearTimeout(controlsTimeoutRef.current);
    controlsTimeoutRef.current = setTimeout(() => {
      if (isPlaying) setShowControls(false);
    }, 3000);
  };

  const handlePasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setIsUnlocked(true);
  };

  const formatTime = (secs: number) => {
    if (isNaN(secs) || secs < 0) return '00:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const streamSrc = share
    ? `/api/v1/s/${share.id}${password ? `?pwd=${encodeURIComponent(password)}` : ''}`
    : '';

  const downloadSrc = share
    ? `/api/v1/s/${share.id}?download=true${password ? `&pwd=${encodeURIComponent(password)}` : ''}`
    : '';

  if (loading) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center p-4">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
          <span className="text-slate-400 text-sm font-medium">در حال آماده‌سازی استریم...</span>
        </div>
      </div>
    );
  }

  if (error || !share) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center p-4" dir="rtl">
        <div className="w-full max-w-md p-6 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-2xl text-center space-y-4">
          <div className="w-12 h-12 rounded-full bg-red-500/10 text-red-400 flex items-center justify-center mx-auto border border-red-500/20">
            <AlertCircle className="w-6 h-6" />
          </div>
          <h2 className="text-lg font-bold text-white">خطا در بارگذاری استریم</h2>
          <p className="text-sm text-slate-400 leading-relaxed">{error || 'فایل مورد نظر یافت نشد.'}</p>
          <a
            href="/"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-xs font-semibold transition"
          >
            <span>ورود به پیام‌رسان</span>
            <ArrowRight className="w-4 h-4 rotate-180" />
          </a>
        </div>
      </div>
    );
  }

  // Password Gate
  if (!isUnlocked && share.has_password) {
    return (
      <div className="min-h-screen bg-[#090d16] flex items-center justify-center p-4" dir="rtl">
        <div className="w-full max-w-md p-8 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-2xl text-center space-y-5">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center mx-auto border border-amber-500/20">
            <Lock className="w-7 h-7" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">استریم محافظت‌شده</h1>
            <p className="text-xs text-slate-400 mt-1 truncate">
              برای مشاهده <strong>{share.file_name}</strong> رمز عبور را وارد کنید.
            </p>
          </div>
          <form onSubmit={handlePasswordSubmit} className="space-y-3.5">
            <input
              type="password"
              placeholder="رمز عبور فایل..."
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-3 bg-slate-950 border border-slate-700/80 rounded-xl text-sm text-white placeholder-slate-500 text-center focus:outline-none focus:border-indigo-500"
              autoFocus
              required
            />
            {passwordError && <p className="text-xs text-red-400">{passwordError}</p>}
            <button
              type="submit"
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-semibold rounded-xl text-sm transition shadow-lg shadow-indigo-600/30 cursor-pointer"
            >
              ورود و شروع پخش
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      className={`min-h-screen bg-[#070b13] flex flex-col text-slate-100 select-none ${
        isFullscreen ? 'w-screen h-screen' : ''
      }`}
      dir="rtl"
    >
      {/* Top Navigation Bar */}
      <header
        className={`flex items-center justify-between px-4 sm:px-6 py-3.5 bg-slate-950/80 backdrop-blur-xl border-b border-slate-800/80 z-20 transition-opacity duration-300 ${
          isFullscreen && !showControls ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-indigo-600 to-blue-500 flex items-center justify-center text-white shrink-0 shadow-md shadow-indigo-500/20">
            <Film className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <h1 className="text-sm sm:text-base font-bold text-white truncate max-w-xs sm:max-w-lg">
              {share.file_name}
            </h1>
            <div className="text-[11px] text-slate-400 flex items-center gap-2">
              <span>{(share.file_size / (1024 * 1024)).toFixed(2)} MB</span>
              <span>•</span>
              <span className="text-indigo-400 font-medium">Senora Stream Player</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <a
            href={downloadSrc}
            download={share.file_name}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white text-xs font-semibold flex items-center gap-1.5 transition"
            title="دانلود فایل مستقیم"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">دانلود مستقیم</span>
          </a>
          <a
            href="/"
            className="px-3 py-1.5 rounded-xl bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 text-xs font-semibold transition"
          >
            ورود به چت
          </a>
        </div>
      </header>

      {/* Main Video Viewport */}
      <main
        onDoubleClick={toggleFullscreen}
        className="relative flex-1 bg-black flex items-center justify-center overflow-hidden"
      >
        <video
          ref={videoRef}
          src={streamSrc}
          className="w-full h-full object-contain cursor-pointer"
          playsInline
          onClick={togglePlay}
          onTimeUpdate={() => videoRef.current && setCurrentTime(videoRef.current.currentTime)}
          onLoadedMetadata={() => videoRef.current && setDuration(videoRef.current.duration)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onError={() => {
            if (share.has_password) {
              setPasswordError('رمز عبور نادرست است یا امکان رمزگشایی جریان وجود ندارد.');
              setIsUnlocked(false);
            } else {
              setError('خطا در پخش استریم. لطفاً اتصال اینترنت خود را بررسی کنید.');
            }
          }}
        />

        {/* Central Play/Pause Watermark Overlay on Hover / Pause */}
        {(!isPlaying || showControls) && (
          <button
            onClick={togglePlay}
            className="absolute inset-0 m-auto w-16 h-16 rounded-full bg-slate-900/80 hover:bg-slate-900 text-white flex items-center justify-center border border-indigo-500/30 shadow-2xl backdrop-blur-md transition-transform transform hover:scale-110 cursor-pointer"
          >
            {isPlaying ? (
              <Pause className="w-7 h-7 text-white" />
            ) : (
              <Play className="w-7 h-7 text-white ml-0.5" />
            )}
          </button>
        )}

        {/* Bottom Floating Control Bar */}
        <div
          className={`absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black/90 via-black/60 to-transparent flex flex-col gap-2 z-20 transition-opacity duration-300 ${
            showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
        >
          {/* Progress Slider */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-mono text-slate-300 shrink-0 w-12 text-left">
              {formatTime(currentTime)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 100}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="flex-1 h-1.5 bg-slate-700/80 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <span className="text-[11px] font-mono text-slate-400 shrink-0 w-12">
              {formatTime(duration)}
            </span>
          </div>

          {/* Action Row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={togglePlay}
                className="p-2 rounded-lg hover:bg-white/10 text-white transition cursor-pointer"
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
              </button>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    const v = videoRef.current;
                    if (v) {
                      v.muted = !isMuted;
                      setIsMuted(!isMuted);
                    }
                  }}
                  className="p-2 rounded-lg hover:bg-white/10 text-white transition cursor-pointer"
                >
                  {isMuted ? <VolumeX className="w-5 h-5 text-rose-400" /> : <Volume2 className="w-5 h-5" />}
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
                    const v = videoRef.current;
                    if (v) {
                      v.volume = val;
                      v.muted = false;
                      setIsMuted(false);
                    }
                  }}
                  className="w-16 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500 hidden sm:block"
                />
              </div>

              {/* Speed Pills */}
              <div className="hidden sm:flex items-center gap-1 bg-white/5 rounded-lg p-0.5 border border-white/10 text-xs">
                {[0.75, 1.0, 1.25, 1.5, 2.0].map((rate) => (
                  <button
                    key={rate}
                    onClick={() => handleRateChange(rate)}
                    className={`px-2 py-0.5 rounded-md font-semibold transition cursor-pointer ${
                      playbackRate === rate
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {rate}x
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Picture-in-Picture */}
              {typeof document !== 'undefined' && document.pictureInPictureEnabled && (
                <button
                  onClick={togglePiP}
                  className="p-2 rounded-lg hover:bg-white/10 text-white transition cursor-pointer"
                  title="تصویر در تصویر (PiP)"
                >
                  <Tv className="w-5 h-5" />
                </button>
              )}

              {/* Fullscreen Toggle */}
              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-lg hover:bg-white/10 text-white transition cursor-pointer"
                title="تمام‌صفحه (F)"
              >
                {isFullscreen ? <Minimize2 className="w-5 h-5" /> : <Maximize2 className="w-5 h-5" />}
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
