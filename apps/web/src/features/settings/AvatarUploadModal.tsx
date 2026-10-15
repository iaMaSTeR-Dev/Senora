import React, { useState, useRef, useEffect } from 'react';
import { User } from '../../app/types';
import { api } from '../../protocol/api';
import {
  Camera,
  Upload,
  ZoomIn,
  ZoomOut,
  Trash2,
  Check,
  X,
  AlertCircle
} from 'lucide-react';

interface AvatarUploadModalProps {
  currentUser: User;
  onClose: () => void;
  onSuccess: (updatedUser: User) => void;
}

export const AvatarUploadModal: React.FC<AvatarUploadModalProps> = ({
  currentUser,
  onClose,
  onSuccess,
}) => {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (!file.type.startsWith('image/')) {
        setError('Please select a valid image file (PNG, JPG, WebP).');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        setImageSrc(reader.result as string);
        setZoom(1);
        setPan({ x: 0, y: 0 });
      };
      reader.readAsDataURL(file);
    }
  };

  // Draw on Canvas
  useEffect(() => {
    if (!imageSrc) return;
    const img = new Image();
    img.src = imageSrc;
    img.onload = () => {
      imageRef.current = img;
      drawCanvas();
    };
  }, [imageSrc, zoom, pan]);

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    const img = imageRef.current;
    if (!canvas || !img) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = canvas.width; // 300x300
    ctx.clearRect(0, 0, size, size);

    // Circular clipping
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    // Scale and translate
    const scale = Math.max(size / img.width, size / img.height) * zoom;
    const w = img.width * scale;
    const h = img.height * scale;
    const x = (size - w) / 2 + pan.x;
    const y = (size - h) / 2 + pan.y;

    ctx.drawImage(img, x, y, w, h);
    ctx.restore();

    // Outer subtle border
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = '#24A1DE';
    ctx.lineWidth = 2;
    ctx.stroke();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // Upload cropped image
  const handleSaveAvatar = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    setSaving(true);
    setError(null);

    canvas.toBlob(async (blob) => {
      if (!blob) {
        setError('Could not process avatar image.');
        setSaving(false);
        return;
      }

      try {
        const updated = await api.uploadAvatar(blob);
        onSuccess(updated);
        onClose();
      } catch (err: any) {
        setError(err.message || 'Avatar upload failed.');
      } finally {
        setSaving(false);
      }
    }, 'image/png');
  };

  // Remove Avatar
  const handleDeleteAvatar = async () => {
    if (!confirm('Are you sure you want to remove your avatar?')) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.deleteAvatar();
      onSuccess(updated);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to remove avatar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-md rounded-3xl bg-[#17212b] border border-[#242f3d] shadow-2xl p-6 text-white flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#242f3d]">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-[#24A1DE]/20 text-[#24A1DE] flex items-center justify-center">
              <Camera className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold">Profile Avatar</h3>
              <p className="text-[11px] text-[#7f91a4]">Crop, reposition, and update your photo</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="mt-4 p-3 rounded-2xl bg-red-950/80 border border-red-800 text-red-300 text-xs flex items-center gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Crop & Preview Canvas or Select Prompt */}
        <div className="my-6 flex flex-col items-center justify-center">
          {imageSrc ? (
            <div className="flex flex-col items-center gap-4">
              <div
                className="relative rounded-full shadow-2xl overflow-hidden cursor-grab active:cursor-grabbing border-4 border-[#242f3d]"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                <canvas
                  ref={canvasRef}
                  width={280}
                  height={280}
                  className="bg-[#0e1621] block"
                />
              </div>

              {/* Zoom Controls */}
              <div className="flex items-center gap-3 w-64 bg-[#1f2b38] px-3 py-1.5 rounded-2xl border border-[#242f3d]">
                <ZoomOut className="h-4 w-4 text-[#7f91a4]" />
                <input
                  type="range"
                  min="1"
                  max="3"
                  step="0.05"
                  value={zoom}
                  onChange={(e) => setZoom(parseFloat(e.target.value))}
                  className="flex-1 accent-[#24A1DE] cursor-pointer"
                />
                <ZoomIn className="h-4 w-4 text-[#7f91a4]" />
              </div>
              <span className="text-[10px] text-[#7f91a4]">Drag to reposition image</span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                {currentUser.avatar_url ? (
                  <img
                    src={currentUser.avatar_url}
                    alt={currentUser.display_name}
                    className="h-36 w-36 rounded-full object-cover border-4 border-[#24A1DE] shadow-xl"
                  />
                ) : (
                  <div className="h-36 w-36 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa] flex items-center justify-center text-white text-4xl font-bold shadow-xl border-4 border-[#242f3d]">
                    {(currentUser.display_name || currentUser.username).charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
              <p className="text-xs text-[#7f91a4]">Select a new image from your device</p>
            </div>
          )}

          <input
            type="file"
            ref={fileInputRef}
            accept="image/png, image/jpeg, image/webp"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>

        {/* Buttons */}
        <div className="flex flex-col gap-2 pt-2 border-t border-[#242f3d]">
          {imageSrc ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSaveAvatar}
                disabled={saving}
                className="flex-1 py-2.5 px-4 rounded-2xl bg-[#24A1DE] hover:bg-[#208fc4] text-white font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-lg"
              >
                <Check className="h-4 w-4" />
                <span>{saving ? 'Saving...' : 'Set New Avatar'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setImageSrc(null);
                }}
                disabled={saving}
                className="py-2.5 px-4 rounded-2xl bg-[#242f3d] hover:bg-[#202b36] text-[#7f91a4] hover:text-white font-semibold text-xs transition cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full py-2.5 px-4 rounded-2xl bg-[#24A1DE] hover:bg-[#208fc4] text-white font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-lg"
            >
              <Upload className="h-4 w-4" />
              <span>Choose Photo from Device</span>
            </button>
          )}

          {currentUser.avatar_url && !imageSrc && (
            <button
              type="button"
              onClick={handleDeleteAvatar}
              disabled={saving}
              className="w-full py-2 px-4 rounded-2xl bg-red-500/10 hover:bg-red-500/20 text-red-400 font-semibold text-xs flex items-center justify-center gap-2 transition cursor-pointer border border-red-500/20"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>Remove Current Photo</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
