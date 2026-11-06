import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Sticker, StickerPack } from '../../app/types';
import { api } from '../../protocol/api';
import {
  Sparkles,
  Upload,
  X,
  AlertCircle,
  Circle,
  Square,
  Maximize2,
  Type,
  Bookmark,
  RefreshCw,
  ZoomIn,
  Eraser,
  Check,
  Send,
  Plus,
  Layers,
} from 'lucide-react';

interface StickerCreatorModalProps {
  onClose: () => void;
  onSendSticker?: (pack: StickerPack, sticker: Sticker) => void;
  onStickerSaved?: (sticker: Sticker) => void;
  isRtl?: boolean;
}

export interface BatchStickerItem {
  id: string;
  file: File;
  fileName: string;
  previewUrl: string;
  sourceImage: HTMLImageElement | null;
  isVideo: boolean;
  isAnimated: boolean;
  emoji: string;
  cropMode: 'fit' | 'square' | 'circle';
  zoom: number;
  pan: { x: number; y: number };
  removeBackground: boolean;
  bgTolerance: number;
  overlayEmoji: string;
  overlayText: string;
}

const PRESET_EMOJIS = ['✨', '🔥', '❤️', '😂', '👍', '🚀', '🎉', '😍', '👀', '💯', '👏', '⚡', '🌟', '🦄', '🌈', '🍕'];
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB ceiling
const MAX_DIMENSION = 4096; // 4096px protection against decompression bombs
const CANVAS_SIZE = 512; // Standard sticker dimension (512x512)

export const StickerCreatorModal: React.FC<StickerCreatorModalProps> = ({
  onClose,
  onSendSticker,
  onStickerSaved,
  isRtl,
}) => {
  // Batch state
  const [batchItems, setBatchItems] = useState<BatchStickerItem[]>([]);
  const [activeItemIndex, setActiveItemIndex] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingStatus, setSavingStatus] = useState<string>('');

  // Target pack title
  const [packTitle, setPackTitle] = useState<string>(() => (isRtl ? 'استیکرهای من' : 'My Stickers'));

  // Drag interaction state
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const activeItem = batchItems[activeItemIndex] || null;

  // Helper: Read file as Data URL
  const readFileAsDataUrl = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  // Helper: Load Image
  const loadImage = (url: string): Promise<HTMLImageElement> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Failed to decode image'));
      img.src = url;
    });
  };

  // Handle batch file selection and validation (supporting WEBM, WEBP, GIF, PNG, JPG, SVG)
  const handleFilesSelect = async (files: FileList | File[]) => {
    setError(null);
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setLoading(true);
    const validMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml', 'video/webm'];
    const validExtensions = /\.(png|jpe?g|webp|gif|svg|webm)$/i;

    const newItems: BatchStickerItem[] = [];

    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];

      // 1. File size check
      if (file.size > MAX_FILE_SIZE_BYTES) {
        setError(`"${file.name}" is too large (${(file.size / (1024 * 1024)).toFixed(1)}MB). Max allowed size is 100MB.`);
        continue;
      }

      // 2. MIME & format validation
      const isMimeValid = validMimes.includes(file.type.toLowerCase()) || validExtensions.test(file.name);
      if (!isMimeValid) {
        setError(`"${file.name}" is not a supported format. Please upload PNG, JPG, WebP, GIF, SVG, or WebM.`);
        continue;
      }

      const isVideo = file.type === 'video/webm' || file.name.toLowerCase().endsWith('.webm');
      const isAnimated = isVideo || file.type === 'image/gif' || file.name.toLowerCase().endsWith('.gif');
      const assignedEmoji = PRESET_EMOJIS[(batchItems.length + newItems.length) % PRESET_EMOJIS.length];

      try {
        const dataUrl = await readFileAsDataUrl(file);
        if (isVideo) {
          newItems.push({
            id: `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${i}`,
            file,
            fileName: file.name,
            previewUrl: dataUrl,
            sourceImage: null,
            isVideo: true,
            isAnimated: true,
            emoji: assignedEmoji,
            cropMode: 'fit',
            zoom: 1.0,
            pan: { x: 0, y: 0 },
            removeBackground: false,
            bgTolerance: 32,
            overlayEmoji: '',
            overlayText: '',
          });
        } else {
          const img = await loadImage(dataUrl);
          if (img.naturalWidth > MAX_DIMENSION || img.naturalHeight > MAX_DIMENSION) {
            setError(`"${file.name}" dimensions exceed safe limit of ${MAX_DIMENSION}px.`);
            continue;
          }
          newItems.push({
            id: `batch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}_${i}`,
            file,
            fileName: file.name,
            previewUrl: dataUrl,
            sourceImage: img,
            isVideo: false,
            isAnimated,
            emoji: assignedEmoji,
            cropMode: 'fit',
            zoom: 1.0,
            pan: { x: 0, y: 0 },
            removeBackground: false,
            bgTolerance: 32,
            overlayEmoji: '',
            overlayText: '',
          });
        }
      } catch (err: any) {
        console.warn('Error processing file:', file.name, err);
      }
    }

    setLoading(false);
    if (newItems.length > 0) {
      setBatchItems((prev) => {
        const updated = [...prev, ...newItems];
        return updated;
      });
      if (batchItems.length === 0) {
        setActiveItemIndex(0);
      }
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesSelect(e.dataTransfer.files);
    }
  };

  // Update current active item property
  const updateActiveItem = (updates: Partial<BatchStickerItem>) => {
    setBatchItems((prev) =>
      prev.map((item, idx) => (idx === activeItemIndex ? { ...item, ...updates } : item))
    );
  };

  const handleRemoveBatchItem = (index: number) => {
    setBatchItems((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      if (activeItemIndex >= next.length && next.length > 0) {
        setActiveItemIndex(next.length - 1);
      }
      return next;
    });
  };

  // Canvas background removal routine
  const applyBackgroundRemoval = (ctx: CanvasRenderingContext2D, tolerance: number) => {
    const imgData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    const data = imgData.data;

    const sampleCorners = [
      [0, 0],
      [CANVAS_SIZE - 1, 0],
      [0, CANVAS_SIZE - 1],
      [CANVAS_SIZE - 1, CANVAS_SIZE - 1],
    ];

    let avgR = 0;
    let avgG = 0;
    let avgB = 0;
    let sampleCount = 0;

    for (const [cx, cy] of sampleCorners) {
      const idx = (cy * CANVAS_SIZE + cx) * 4;
      if (data[idx + 3] > 10) {
        avgR += data[idx];
        avgG += data[idx + 1];
        avgB += data[idx + 2];
        sampleCount++;
      }
    }

    if (sampleCount > 0) {
      avgR = Math.round(avgR / sampleCount);
      avgG = Math.round(avgG / sampleCount);
      avgB = Math.round(avgB / sampleCount);

      const tol = tolerance;
      const feather = 18;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        if (a === 0) continue;

        const dist = Math.sqrt(
          Math.pow(r - avgR, 2) + Math.pow(g - avgG, 2) + Math.pow(b - avgB, 2)
        );

        if (dist < tol) {
          data[i + 3] = 0;
        } else if (dist < tol + feather) {
          const factor = (dist - tol) / feather;
          data[i + 3] = Math.round(a * factor);
        }
      }

      ctx.putImageData(imgData, 0, 0);
    }
  };

  // High-Quality Canvas redraw effect
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeItem || !activeItem.sourceImage || activeItem.isVideo) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;

    // Crisp high-quality supersampling
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.save();

    // Clipping path for circle mode
    if (activeItem.cropMode === 'circle') {
      ctx.beginPath();
      ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 4, 0, Math.PI * 2);
      ctx.clip();
    }

    const sw = activeItem.sourceImage.naturalWidth || activeItem.sourceImage.width;
    const sh = activeItem.sourceImage.naturalHeight || activeItem.sourceImage.height;

    let dw = CANVAS_SIZE;
    let dh = CANVAS_SIZE;
    let dx = 0;
    let dy = 0;

    if (activeItem.cropMode === 'fit') {
      const ratio = Math.min((CANVAS_SIZE - 24) / sw, (CANVAS_SIZE - 24) / sh);
      dw = sw * ratio * activeItem.zoom;
      dh = sh * ratio * activeItem.zoom;
      dx = (CANVAS_SIZE - dw) / 2 + activeItem.pan.x;
      dy = (CANVAS_SIZE - dh) / 2 + activeItem.pan.y;
    } else {
      const scale = Math.max(CANVAS_SIZE / sw, CANVAS_SIZE / sh) * activeItem.zoom;
      dw = sw * scale;
      dh = sh * scale;
      dx = (CANVAS_SIZE - dw) / 2 + activeItem.pan.x;
      dy = (CANVAS_SIZE - dh) / 2 + activeItem.pan.y;
    }

    ctx.drawImage(activeItem.sourceImage, dx, dy, dw, dh);
    ctx.restore();

    // Background removal filter
    if (activeItem.removeBackground) {
      applyBackgroundRemoval(ctx, activeItem.bgTolerance);
    }

    // Emoji Stamp
    if (activeItem.overlayEmoji) {
      ctx.save();
      ctx.font = '64px sans-serif';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 8;
      ctx.fillText(activeItem.overlayEmoji, CANVAS_SIZE - 80, 75);
      ctx.restore();
    }

    // Text Caption
    if (activeItem.overlayText.trim()) {
      ctx.save();
      ctx.font = 'bold 36px "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round';
      ctx.strokeText(activeItem.overlayText.trim(), CANVAS_SIZE / 2, CANVAS_SIZE - 20);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(activeItem.overlayText.trim(), CANVAS_SIZE / 2, CANVAS_SIZE - 20);
      ctx.restore();
    }
  }, [activeItem]);

  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Canvas Drag/Pan controls
  const handleMouseDown = (e: React.MouseEvent<HTMLElement>) => {
    if (!activeItem || activeItem.isVideo) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - activeItem.pan.x, y: e.clientY - activeItem.pan.y });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLElement>) => {
    if (!isDragging || !activeItem || activeItem.isVideo) return;
    updateActiveItem({
      pan: {
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y,
      },
    });
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  // High-fidelity sticker generation per item: preserves animated WebM/WebP/GIF or exports crisp WebP (0.96)
  const generateStickerDataUrlForItem = (item: BatchStickerItem): string => {
    // 1. WebM Video Sticker: preserve raw video binary so VP8/VP9 frames and alpha stay 100% intact!
    if (item.isVideo) {
      return item.previewUrl;
    }

    // 2. Animated WebP / GIF without destructive transformations: preserve full animation
    if (item.isAnimated && !item.removeBackground && !item.overlayText.trim() && !item.overlayEmoji) {
      return item.previewUrl;
    }

    // 3. Render via High-Quality Offscreen Canvas
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx || !item.sourceImage) return item.previewUrl;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    ctx.save();
    if (item.cropMode === 'circle') {
      ctx.beginPath();
      ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 4, 0, Math.PI * 2);
      ctx.clip();
    }

    const sw = item.sourceImage.naturalWidth || item.sourceImage.width;
    const sh = item.sourceImage.naturalHeight || item.sourceImage.height;

    let dw = CANVAS_SIZE;
    let dh = CANVAS_SIZE;
    let dx = 0;
    let dy = 0;

    if (item.cropMode === 'fit') {
      const ratio = Math.min((CANVAS_SIZE - 24) / sw, (CANVAS_SIZE - 24) / sh);
      dw = sw * ratio * item.zoom;
      dh = sh * ratio * item.zoom;
      dx = (CANVAS_SIZE - dw) / 2 + item.pan.x;
      dy = (CANVAS_SIZE - dh) / 2 + item.pan.y;
    } else {
      const scale = Math.max(CANVAS_SIZE / sw, CANVAS_SIZE / sh) * item.zoom;
      dw = sw * scale;
      dh = sh * scale;
      dx = (CANVAS_SIZE - dw) / 2 + item.pan.x;
      dy = (CANVAS_SIZE - dh) / 2 + item.pan.y;
    }

    ctx.drawImage(item.sourceImage, dx, dy, dw, dh);
    ctx.restore();

    if (item.removeBackground) {
      applyBackgroundRemoval(ctx, item.bgTolerance);
    }

    if (item.overlayEmoji) {
      ctx.save();
      ctx.font = '64px sans-serif';
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 8;
      ctx.fillText(item.overlayEmoji, CANVAS_SIZE - 80, 75);
      ctx.restore();
    }

    if (item.overlayText.trim()) {
      ctx.save();
      ctx.font = 'bold 36px "Segoe UI", Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round';
      ctx.strokeText(item.overlayText.trim(), CANVAS_SIZE / 2, CANVAS_SIZE - 20);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(item.overlayText.trim(), CANVAS_SIZE / 2, CANVAS_SIZE - 20);
      ctx.restore();
    }

    try {
      const webp = canvas.toDataURL('image/webp', 0.88);
      if (webp.startsWith('data:image/webp')) return webp;
    } catch {}
    return canvas.toDataURL('image/png');
  };

  // Batch Save All to Sticker Pack
  const handleSaveAllToPack = async () => {
    if (batchItems.length === 0) return;
    setSaving(true);
    setError(null);
    setSavingStatus(`Processing ${batchItems.length} stickers...`);

    try {
      const stickersToSave = batchItems.map((item) => ({
        emoji: item.emoji || '✨',
        asset_url: generateStickerDataUrlForItem(item),
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
      }));

      const rawTitle = packTitle.trim() || (isRtl ? 'استیکرهای من' : 'My Stickers');
      const cleanSlug = rawTitle.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'pack';
      const cleanName = `${cleanSlug}_${Date.now()}`;

      // Check existing user pack strictly by title (case-insensitive)
      const installed = await api.getInstalledStickers();
      const existingUserPack = installed.packs?.find(
        (p) => !p.is_builtin && !p.id.startsWith('pack_local_') && !p.id.startsWith('pack_custom_') && p.title.trim().toLowerCase() === rawTitle.toLowerCase()
      );

      let targetPack: StickerPack;
      let lastSticker: Sticker | null = null;

      if (existingUserPack) {
        targetPack = existingUserPack;
        for (let i = 0; i < stickersToSave.length; i++) {
          setSavingStatus(`Adding sticker ${i + 1}/${stickersToSave.length}...`);
          lastSticker = await api.addStickerToPack(existingUserPack.id, stickersToSave[i]);
        }
      } else {
        targetPack = await api.createUserStickerPack({
          title: rawTitle,
          name: cleanName,
          stickers: stickersToSave,
        });
        lastSticker = targetPack.stickers?.[0] || null;
      }

      // Auto-install pack on server if available
      try {
        if (targetPack?.id && !targetPack.id.startsWith('pack_local_')) {
          await api.installStickerPack(targetPack.id);
        }
      } catch {}

      // Ensure target pack or pack_custom_local is not in uninstalled list
      try {
        const uninstalledRaw = localStorage.getItem('senora_uninstalled_packs');
        if (uninstalledRaw) {
          const uninstalled: string[] = JSON.parse(uninstalledRaw);
          const filtered = uninstalled.filter((id) => id !== 'pack_custom_local' && id !== targetPack?.id);
          localStorage.setItem('senora_uninstalled_packs', JSON.stringify(filtered));
        }
      } catch {}

      // Purge legacy custom_stickers cache to prevent duplicate "My Stickers" phantom packs
      try {
        localStorage.removeItem('senora_custom_stickers');
      } catch {}

      if (onStickerSaved && lastSticker) {
        onStickerSaved(lastSticker);
      }

      onClose();
    } catch (err: any) {
      console.warn('Backend batch sticker save failed, using local offline fallback:', err);
      // Offline fallback
      const localPack: StickerPack = {
        id: `pack_local_${Date.now()}`,
        name: 'my_local_stickers',
        title: packTitle || 'My Stickers',
        thumbnail_url: batchItems[0]?.previewUrl || '',
        author: 'You',
        sticker_count: batchItems.length,
        is_builtin: false,
      };

      const localStickers: Sticker[] = batchItems.map((item, idx) => ({
        id: `stk_local_${Date.now()}_${idx}`,
        pack_id: localPack.id,
        emoji: item.emoji || '✨',
        asset_url: generateStickerDataUrlForItem(item),
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
      }));
      localPack.stickers = localStickers;

      try {
        const uninstalledRaw = localStorage.getItem('senora_uninstalled_packs');
        if (uninstalledRaw) {
          const uninstalled: string[] = JSON.parse(uninstalledRaw);
          const filtered = uninstalled.filter((id) => id !== 'pack_custom_local' && id !== localPack.id);
          localStorage.setItem('senora_uninstalled_packs', JSON.stringify(filtered));
        }
      } catch {}

      try {
        const savedRaw = localStorage.getItem('senora_custom_stickers');
        const customList: Sticker[] = savedRaw ? JSON.parse(savedRaw) : [];
        const merged = [...localStickers, ...customList].slice(0, 25);
        localStorage.setItem('senora_custom_stickers', JSON.stringify(merged));
      } catch (e) {
        console.warn('LocalStorage quota limit reached:', e);
      }

      if (onStickerSaved && localStickers[0]) {
        onStickerSaved(localStickers[0]);
      }
      onClose();
    } finally {
      setSaving(false);
      setSavingStatus('');
    }
  };

  // Send Current or Send All
  const handleSendCurrent = async () => {
    if (!activeItem || !onSendSticker) return;
    setSaving(true);
    try {
      const assetUrl = generateStickerDataUrlForItem(activeItem);
      const virtualPack: StickerPack = {
        id: 'pack_custom_direct',
        name: 'custom_direct',
        title: packTitle || 'Custom Stickers',
        thumbnail_url: assetUrl,
        author: 'You',
        sticker_count: 1,
        is_builtin: false,
      };
      const virtualSticker: Sticker = {
        id: `stk_custom_${Date.now()}`,
        pack_id: virtualPack.id,
        emoji: activeItem.emoji || '✨',
        asset_url: assetUrl,
        width: CANVAS_SIZE,
        height: CANVAS_SIZE,
      };
      onSendSticker(virtualPack, virtualSticker);
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to send sticker');
    } finally {
      setSaving(false);
    }
  };

  const handleSendAll = async () => {
    if (batchItems.length === 0 || !onSendSticker) return;
    setSaving(true);
    try {
      const virtualPack: StickerPack = {
        id: `pack_batch_${Date.now()}`,
        name: 'custom_batch',
        title: packTitle || 'Custom Stickers',
        thumbnail_url: batchItems[0]?.previewUrl || '',
        author: 'You',
        sticker_count: batchItems.length,
        is_builtin: false,
      };

      for (let i = 0; i < batchItems.length; i++) {
        const item = batchItems[i];
        const assetUrl = generateStickerDataUrlForItem(item);
        const virtualSticker: Sticker = {
          id: `stk_batch_${Date.now()}_${i}`,
          pack_id: virtualPack.id,
          emoji: item.emoji || '✨',
          asset_url: assetUrl,
          width: CANVAS_SIZE,
          height: CANVAS_SIZE,
        };
        onSendSticker(virtualPack, virtualSticker);
      }
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to send stickers');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-in fade-in duration-200 select-none"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-3xl bg-[#17212b] border border-[#242f3d] rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[94vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#242f3d] bg-[#101921]/60">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-[#24A1DE]/20 text-[#24A1DE] flex items-center justify-center">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span>Sticker & GIF Studio</span>
                {batchItems.length > 1 && (
                  <span className="px-2 py-0.5 rounded-full bg-[#24A1DE]/20 text-[#24A1DE] text-[11px] font-mono">
                    {batchItems.length} items
                  </span>
                )}
              </h2>
              <p className="text-xs text-[#7f91a4]">
                Batch multi-photo, WebM video sticker, and WebP support with HD quality
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-[#7f91a4] hover:text-white rounded-xl hover:bg-[#242f3d] transition cursor-pointer"
            title="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/15 border border-red-500/30 rounded-xl text-red-400 text-xs">
              <AlertCircle size={16} className="flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {batchItems.length === 0 ? (
            /* Upload Zone: Multi-file & Drag & Drop */
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-[#242f3d] hover:border-[#24A1DE] transition-all rounded-3xl p-10 flex flex-col items-center justify-center text-center cursor-pointer bg-[#101921]/40 group"
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/webm,.webm,.webp,.png,.jpg,.jpeg,.gif,.svg"
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) {
                    handleFilesSelect(e.target.files);
                  }
                }}
                className="hidden"
              />
              <div className="h-16 w-16 rounded-3xl bg-[#24A1DE]/15 text-[#24A1DE] flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                <Upload size={28} />
              </div>
              <h3 className="text-sm font-semibold text-white mb-1">
                Choose multiple photos, WebM, or WebP files
              </h3>
              <p className="text-xs text-[#7f91a4] max-w-sm mb-4">
                Supports batch selection of WebM (animated/video sticker), WebP, PNG, JPG, and GIF without quality loss
              </p>
              <button
                type="button"
                className="px-4 py-2 bg-[#24A1DE] hover:bg-[#208fc4] text-white text-xs font-semibold rounded-xl shadow-lg shadow-[#24A1DE]/20 transition"
              >
                {loading ? 'Processing files...' : 'Select Photos / Videos'}
              </button>
            </div>
          ) : (
            /* Studio Editor with Multi-Sticker Filmstrip */
            <div className="space-y-4">
              {/* Batch Thumbnails Filmstrip */}
              <div className="bg-[#101921] p-2.5 rounded-2xl border border-[#242f3d] space-y-2">
                <div className="flex items-center justify-between text-xs px-1">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <Layers size={13} className="text-[#24A1DE]" />
                    <span>Batch Queue ({batchItems.length} stickers)</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex items-center gap-1 text-[11px] font-semibold text-[#24A1DE] hover:underline cursor-pointer"
                  >
                    <Plus size={12} />
                    <span>Add More Photos</span>
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/webm,.webm,.webp,.png,.jpg,.jpeg,.gif,.svg"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        handleFilesSelect(e.target.files);
                      }
                    }}
                    className="hidden"
                  />
                </div>

                <div className="flex items-center gap-2 overflow-x-auto no-scrollbar py-1">
                  {batchItems.map((item, idx) => (
                    <div
                      key={item.id}
                      onClick={() => setActiveItemIndex(idx)}
                      className={`relative group flex-shrink-0 w-16 h-16 rounded-xl border-2 overflow-hidden cursor-pointer transition-all ${
                        activeItemIndex === idx
                          ? 'border-[#24A1DE] shadow-md shadow-[#24A1DE]/30 scale-105 bg-[#17212b]'
                          : 'border-[#242f3d] hover:border-[#7f91a4] opacity-75 hover:opacity-100 bg-[#17212b]'
                      }`}
                    >
                      {item.isVideo ? (
                        <video
                          src={item.previewUrl}
                          autoPlay
                          loop
                          muted
                          playsInline
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <img
                          src={item.previewUrl}
                          alt={item.fileName}
                          className="w-full h-full object-cover"
                        />
                      )}

                      {/* Emoji Tag Badge */}
                      <span className="absolute bottom-0.5 right-0.5 text-[11px] bg-black/70 rounded px-1">
                        {item.emoji}
                      </span>

                      {/* Format Badge */}
                      <span className="absolute top-0.5 left-0.5 text-[8px] font-bold uppercase bg-black/75 text-white/90 rounded px-1">
                        {item.isVideo ? 'WebM' : item.fileName.split('.').pop() || 'IMG'}
                      </span>

                      {/* Delete button */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveBatchItem(idx);
                        }}
                        className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow"
                        title="Remove"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {/* Main Canvas / Video Stage + Controls */}
              {activeItem && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Left Column: Canvas Preview */}
                  <div className="flex flex-col items-center space-y-3">
                    <div
                      className="relative w-64 h-64 sm:w-72 sm:h-72 rounded-2xl overflow-hidden border border-[#242f3d] shadow-xl flex items-center justify-center cursor-move"
                      style={{
                        backgroundImage:
                          'linear-gradient(45deg, #101921 25%, transparent 25%), linear-gradient(-45deg, #101921 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #101921 75%), linear-gradient(-45deg, transparent 75%, #101921 75%)',
                        backgroundSize: '16px 16px',
                        backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
                        backgroundColor: '#1b2633',
                      }}
                      onMouseDown={handleMouseDown}
                      onMouseMove={handleMouseMove}
                      onMouseUp={handleMouseUp}
                      onMouseLeave={handleMouseUp}
                    >
                      {activeItem.isVideo ? (
                        <video
                          src={activeItem.previewUrl}
                          autoPlay
                          loop
                          muted
                          playsInline
                          className="w-full h-full object-contain pointer-events-none"
                        />
                      ) : (
                        <canvas
                          ref={canvasRef}
                          className="w-full h-full object-contain pointer-events-none"
                        />
                      )}

                      <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-sm text-[10px] text-white/80">
                        {activeItem.isVideo ? 'WebM Video Sticker (Looping)' : 'Drag to reposition'}
                      </div>

                      {activeItem.isVideo && (
                        <div className="absolute top-2 right-2 px-2 py-0.5 rounded-md bg-[#24A1DE] text-[10px] text-white font-bold shadow">
                          HD Video
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] text-[#7f91a4] truncate max-w-[200px]">
                        {activeItem.fileName}
                      </span>
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        className="flex items-center gap-1 text-[11px] text-[#24A1DE] hover:underline cursor-pointer"
                      >
                        <RefreshCw size={12} />
                        <span>Replace</span>
                      </button>
                    </div>

                    {/* Tag Emoji selector */}
                    <div className="w-full bg-[#101921] p-2.5 rounded-2xl border border-[#242f3d] space-y-1.5">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-[#7f91a4] font-medium">Sticker Emoji Tag:</span>
                        <span className="text-base">{activeItem.emoji}</span>
                      </div>
                      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
                        {PRESET_EMOJIS.map((em) => (
                          <button
                            key={em}
                            onClick={() => updateActiveItem({ emoji: em })}
                            className={`h-7 w-7 rounded-lg text-sm flex items-center justify-center transition cursor-pointer ${
                              activeItem.emoji === em
                                ? 'bg-[#24A1DE] text-white shadow'
                                : 'hover:bg-[#242f3d]'
                            }`}
                          >
                            {em}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Right Column: Controls */}
                  <div className="space-y-4">
                    {/* Crop / Shape Mode */}
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-[#7f91a4] block">
                        Sticker Shape & Fit
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() => updateActiveItem({ cropMode: 'fit' })}
                          className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-medium border transition cursor-pointer ${
                            activeItem.cropMode === 'fit'
                              ? 'bg-[#24A1DE]/20 border-[#24A1DE] text-[#24A1DE]'
                              : 'bg-[#101921] border-[#242f3d] text-[#7f91a4] hover:text-white'
                          }`}
                        >
                          <Maximize2 size={13} />
                          <span>Fit Aspect</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => updateActiveItem({ cropMode: 'square' })}
                          className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-medium border transition cursor-pointer ${
                            activeItem.cropMode === 'square'
                              ? 'bg-[#24A1DE]/20 border-[#24A1DE] text-[#24A1DE]'
                              : 'bg-[#101921] border-[#242f3d] text-[#7f91a4] hover:text-white'
                          }`}
                        >
                          <Square size={13} />
                          <span>Square</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => updateActiveItem({ cropMode: 'circle' })}
                          className={`flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-medium border transition cursor-pointer ${
                            activeItem.cropMode === 'circle'
                              ? 'bg-[#24A1DE]/20 border-[#24A1DE] text-[#24A1DE]'
                              : 'bg-[#101921] border-[#242f3d] text-[#7f91a4] hover:text-white'
                          }`}
                        >
                          <Circle size={13} />
                          <span>Round</span>
                        </button>
                      </div>
                    </div>

                    {/* Zoom / Scale Slider */}
                    {!activeItem.isVideo && (
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-[#7f91a4] font-medium flex items-center gap-1">
                            <ZoomIn size={13} />
                            <span>Zoom / Scale</span>
                          </span>
                          <span className="text-white font-mono">{Math.round(activeItem.zoom * 100)}%</span>
                        </div>
                        <input
                          type="range"
                          min="0.5"
                          max="2.5"
                          step="0.05"
                          value={activeItem.zoom}
                          onChange={(e) => updateActiveItem({ zoom: parseFloat(e.target.value) })}
                          className="w-full accent-[#24A1DE] cursor-pointer"
                        />
                      </div>
                    )}

                    {/* Background Removal Tool */}
                    {!activeItem.isVideo && (
                      <div className="bg-[#101921] p-3 rounded-2xl border border-[#242f3d] space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                            <Eraser size={14} className="text-[#24A1DE]" />
                            <span>Remove Background</span>
                          </span>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={activeItem.removeBackground}
                              onChange={(e) => updateActiveItem({ removeBackground: e.target.checked })}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-[#242f3d] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-[#24A1DE]"></div>
                          </label>
                        </div>
                        {activeItem.removeBackground && (
                          <div className="space-y-1 pt-1 animate-in fade-in duration-150">
                            <div className="flex items-center justify-between text-[11px] text-[#7f91a4]">
                              <span>Tolerance</span>
                              <span className="font-mono">{activeItem.bgTolerance}</span>
                            </div>
                            <input
                              type="range"
                              min="10"
                              max="80"
                              step="2"
                              value={activeItem.bgTolerance}
                              onChange={(e) => updateActiveItem({ bgTolerance: parseInt(e.target.value) })}
                              className="w-full accent-[#24A1DE] cursor-pointer"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Text & Emoji Overlay Decorations */}
                    <div className="space-y-2">
                      <label className="text-xs font-semibold text-[#7f91a4] flex items-center gap-1">
                        <Type size={13} />
                        <span>Decorations & Text</span>
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          placeholder="Add caption (e.g. LOL)..."
                          value={activeItem.overlayText}
                          onChange={(e) => updateActiveItem({ overlayText: e.target.value })}
                          maxLength={18}
                          className="px-3 py-1.5 text-xs bg-[#101921] border border-[#242f3d] rounded-xl text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                        />
                        <input
                          type="text"
                          placeholder="Emoji stamp (e.g. 🔥)..."
                          value={activeItem.overlayEmoji}
                          onChange={(e) => updateActiveItem({ overlayEmoji: e.target.value })}
                          maxLength={4}
                          className="px-3 py-1.5 text-xs bg-[#101921] border border-[#242f3d] rounded-xl text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                        />
                      </div>
                    </div>

                    {/* Target Pack Title */}
                    <div className="space-y-1">
                      <label className="text-xs font-semibold text-[#7f91a4] block">
                        {isRtl ? 'نام پک استیکر (عنوان ذخیره‌سازی):' : 'Save to Sticker Pack:'}
                      </label>
                      <input
                        type="text"
                        value={packTitle}
                        onChange={(e) => setPackTitle(e.target.value)}
                        maxLength={32}
                        placeholder={isRtl ? 'نام دلخواه پک (مثلاً: استیکرهای خنده‌دار)' : 'Pack title (e.g. My Stickers)'}
                        className="w-full px-3 py-1.5 text-xs bg-[#101921] border border-[#242f3d] rounded-xl text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-[#242f3d] bg-[#101921]/60">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-[#7f91a4] hover:text-white rounded-xl hover:bg-[#242f3d] transition cursor-pointer"
          >
            Cancel
          </button>

          {batchItems.length > 0 && (
            <div className="flex items-center gap-2">
              {/* Save All to Pack */}
              <button
                type="button"
                onClick={handleSaveAllToPack}
                disabled={saving}
                className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#242f3d] hover:bg-[#2f3d4f] text-white rounded-xl transition cursor-pointer disabled:opacity-50"
              >
                <Bookmark size={13} />
                <span>
                  {batchItems.length > 1
                    ? `Save All (${batchItems.length}) to Pack`
                    : 'Save to Collection'}
                </span>
              </button>

              {onSendSticker && (
                <>
                  <button
                    type="button"
                    onClick={handleSendCurrent}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-[#24A1DE]/25 hover:bg-[#24A1DE]/35 text-[#24A1DE] border border-[#24A1DE]/40 rounded-xl transition cursor-pointer disabled:opacity-50"
                  >
                    <Send size={13} />
                    <span>Send Current</span>
                  </button>

                  <button
                    type="button"
                    onClick={batchItems.length > 1 ? handleSendAll : handleSendCurrent}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-[#24A1DE] hover:bg-[#208fc4] text-white rounded-xl shadow-lg shadow-[#24A1DE]/25 transition cursor-pointer disabled:opacity-50"
                  >
                    <Check size={14} />
                    <span>
                      {saving
                        ? savingStatus || 'Processing...'
                        : batchItems.length > 1
                        ? `Send All (${batchItems.length}) Stickers`
                        : 'Send Now'}
                    </span>
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
