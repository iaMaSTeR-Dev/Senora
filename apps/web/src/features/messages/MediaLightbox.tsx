import React, { useEffect, useRef, useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Copy,
  Check
} from 'lucide-react';
import { mediaDeviceManager } from '../calls/mediaDeviceManager';

export interface LightboxMediaItem {
  id: string;
  url: string;
  type: 'photo' | 'video';
  filename?: string;
  senderName?: string;
  date?: string;
  caption?: string;
  currentIndex?: number;
  totalCount?: number;
}

interface MediaLightboxProps {
  media: LightboxMediaItem;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
  onJumpToMessage?: (msgId: string) => void;
}

export const MediaLightbox: React.FC<MediaLightboxProps> = ({
  media,
  onClose,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onJumpToMessage,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number>(1);
  const [copied, setCopied] = useState<boolean>(false);
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Reset zoom and pan when media changes
  useEffect(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, [media.id, media.url]);

  useEffect(() => {
    if (media.type === 'video' && videoRef.current) {
      mediaDeviceManager.applyAudioOutput(videoRef.current);
    }
  }, [media]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && onPrev && hasPrev) onPrev();
      if (e.key === 'ArrowRight' && onNext && hasNext) onNext();
      if (e.key === '+' || e.key === '=') zoomIn();
      if (e.key === '-') zoomOut();
      if (e.key === '0') resetZoom();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onPrev, onNext, hasPrev, hasNext, zoom]);

  const zoomIn = () => setZoom((prev) => Math.min(4, Number((prev + 0.25).toFixed(2))));
  const zoomOut = () => setZoom((prev) => Math.max(0.5, Number((prev - 0.25).toFixed(2))));
  const resetZoom = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    if (media.type === 'photo') {
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (zoom > 1 && media.type === 'photo') {
      setIsDragging(true);
      dragStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && zoom > 1) {
      setPan({
        x: e.clientX - dragStartRef.current.x,
        y: e.clientY - dragStartRef.current.y,
      });
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = media.url;
    a.download = media.filename || (media.type === 'video' ? 'video.mp4' : 'photo.jpg');
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleCopy = async () => {
    try {
      if (media.type === 'photo') {
        // Try fetching as blob and copying to clipboard
        const res = await fetch(media.url);
        const blob = await res.blob();
        if ((navigator.clipboard as any)?.write) {
          await (navigator.clipboard as any).write([
            new ClipboardItem({ [blob.type || 'image/png']: blob })
          ]);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          return;
        }
      }
      await navigator.clipboard.writeText(media.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      await navigator.clipboard.writeText(media.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div
      ref={containerRef}
      onWheel={handleWheel}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/95 backdrop-blur-md animate-fadeIn select-none overflow-hidden"
    >
      {/* Top Header Bar */}
      <div className="absolute top-0 inset-x-0 p-4 flex items-center justify-between bg-gradient-to-b from-black/80 via-black/40 to-transparent z-20">
        <div className="text-white flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-semibold">{media.senderName || 'Media'}</h4>
              {media.totalCount && media.totalCount > 1 && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-slate-300 font-mono">
                  {(media.currentIndex ?? 0) + 1} / {media.totalCount}
                </span>
              )}
            </div>
            <p className="text-xs text-slate-400">{media.date || ''}</p>
          </div>
          {onJumpToMessage && (
            <button
              type="button"
              onClick={() => onJumpToMessage(media.id)}
              className="text-xs text-[#24A1DE] hover:underline px-2 py-1 rounded hover:bg-white/5 transition cursor-pointer"
            >
              Show in Chat
            </button>
          )}
        </div>

        {/* Toolbar Controls */}
        <div className="flex items-center space-x-2">
          {media.type === 'photo' && (
            <>
              <button
                type="button"
                onClick={zoomOut}
                disabled={zoom <= 0.5}
                className="p-2 text-slate-300 hover:text-white rounded-full hover:bg-white/10 transition disabled:opacity-30 cursor-pointer"
                title="Zoom Out (-)"
              >
                <ZoomOut size={18} />
              </button>
              <span className="text-xs text-slate-400 font-mono w-10 text-center">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={zoomIn}
                disabled={zoom >= 4}
                className="p-2 text-slate-300 hover:text-white rounded-full hover:bg-white/10 transition disabled:opacity-30 cursor-pointer"
                title="Zoom In (+)"
              >
                <ZoomIn size={18} />
              </button>
              <button
                type="button"
                onClick={resetZoom}
                className="p-2 text-slate-300 hover:text-white rounded-full hover:bg-white/10 transition cursor-pointer"
                title="Reset Zoom (0)"
              >
                <RotateCcw size={18} />
              </button>
            </>
          )}

          <button
            type="button"
            onClick={handleCopy}
            className="p-2 text-slate-300 hover:text-white rounded-full hover:bg-white/10 transition cursor-pointer"
            title="Copy Image"
          >
            {copied ? <Check size={18} className="text-emerald-400" /> : <Copy size={18} />}
          </button>

          <button
            type="button"
            onClick={handleDownload}
            className="p-2 text-slate-300 hover:text-white rounded-full hover:bg-white/10 transition cursor-pointer"
            title="Download Original"
          >
            <Download size={18} />
          </button>

          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-300 hover:text-white rounded-full hover:bg-white/10 transition cursor-pointer"
            title="Close (Esc)"
          >
            <X size={22} />
          </button>
        </div>
      </div>

      {/* Navigation Arrows */}
      {hasPrev && onPrev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="absolute left-4 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all transform hover:scale-110 z-20 cursor-pointer"
          title="Previous (ArrowLeft)"
        >
          <ChevronLeft size={30} />
        </button>
      )}

      {hasNext && onNext && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="absolute right-4 p-3 rounded-full bg-white/10 hover:bg-white/20 text-white transition-all transform hover:scale-110 z-20 cursor-pointer"
          title="Next (ArrowRight)"
        >
          <ChevronRight size={30} />
        </button>
      )}

      {/* Main Media Viewport */}
      <div
        className="w-full h-full flex flex-col items-center justify-center p-4 relative"
        onMouseDown={handleMouseDown}
      >
        {media.type === 'video' ? (
          <video
            ref={videoRef}
            src={media.url}
            controls
            autoPlay
            className="max-w-[90vw] max-h-[82vh] rounded-2xl shadow-2xl object-contain z-10"
          />
        ) : (
          <div
            className="relative flex items-center justify-center max-w-[90vw] max-h-[82vh]"
            style={{
              cursor: zoom > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
            }}
          >
            <img
              src={media.url}
              alt={media.filename || 'Media'}
              draggable={false}
              className="max-w-[90vw] max-h-[82vh] rounded-2xl shadow-2xl object-contain select-none transition-transform duration-75"
              style={{
                transform: `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`,
              }}
            />
          </div>
        )}

        {/* Caption */}
        {media.caption && (
          <div className="absolute bottom-6 px-6 py-2.5 bg-black/70 backdrop-blur-md rounded-2xl max-w-xl text-center text-sm text-slate-200 z-20 border border-white/10">
            {media.caption}
          </div>
        )}
      </div>
    </div>
  );
};
