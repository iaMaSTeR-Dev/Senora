import { uiText, useUILanguage } from "../../app/language";
import React, { useState } from 'react';
import { StickerPack } from '../../app/types';
import { api } from '../../protocol/api';
import {
  Sparkles,
  Copy,
  Check,
  Download,
  X,
  AlertCircle,
  Upload,
  Plus
} from 'lucide-react';

interface StickerPackCreatorModalProps {
  onClose: () => void;
  onPackCreatedOrInstalled: (pack: StickerPack) => void;
}

export const StickerPackCreatorModal: React.FC<StickerPackCreatorModalProps> = ({
  onClose,
  onPackCreatedOrInstalled,
}) => {
  const uiLang = useUILanguage();
  const [tab, setTab] = useState<'create' | 'import'>('create');

  // Create state
  const [title, setTitle] = useState('');
  const [name, setName] = useState('');
  const [stickers, setStickers] = useState<Array<{ emoji: string; asset_url: string }>>([
    { emoji: '🌟', asset_url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><polygon points="50,5 64,36 98,36 70,57 81,91 50,70 19,91 30,57 2,36 36,36" fill="%23FFD700"/></svg>' },
    { emoji: '🚀', asset_url: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%2324A1DE"/><text x="50" y="65" font-size="45" text-anchor="middle" fill="white">🚀</text></svg>' },
  ]);
  const [newEmoji, setNewEmoji] = useState('🔥');
  const [newAssetUrl, setNewAssetUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const [createdPack, setCreatedPack] = useState<StickerPack | null>(null);
  const [copiedShare, setCopiedShare] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  // Import state
  const [shareInput, setShareInput] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectedPack, setInspectedPack] = useState<StickerPack | null>(null);
  const [installing, setInstalling] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const PRESET_EMOJIS = ['✨', '🔥', '❤️', '😂', '👍', '🚀', '🎉', '😍', '👀', '💯', '👏', '⚡', '🌟', '🦄', '🌈', '🍕'];

  const handleBatchFileUpload = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setUploadingBatch(true);
    setError(null);

    const validMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/svg+xml', 'video/webm'];
    const validExtensions = /\.(png|jpe?g|webp|gif|svg|webm)$/i;

    const loadedStickers: Array<{ emoji: string; asset_url: string }> = [];

    for (let i = 0; i < fileArray.length; i++) {
      const file = fileArray[i];
      if (file.size > 100 * 1024 * 1024) continue; // 100MB limit
      const isMimeValid = validMimes.includes(file.type.toLowerCase()) || validExtensions.test(file.name);
      if (!isMimeValid) continue;

      const assignedEmoji = PRESET_EMOJIS[(stickers.length + loadedStickers.length) % PRESET_EMOJIS.length];

      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        loadedStickers.push({
          emoji: assignedEmoji,
          asset_url: dataUrl,
        });
      } catch (e) {
        console.warn('Batch upload read error:', file.name, e);
      }
    }

    if (loadedStickers.length > 0) {
      setStickers((prev) => [...prev, ...loadedStickers]);
    }
    setUploadingBatch(false);
  };

  const handleAddSticker = () => {
    if (!newEmoji.trim()) return;
    const asset = newAssetUrl.trim() || `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%2324A1DE"/><text x="50" y="65" font-size="45" text-anchor="middle" fill="white">${newEmoji}</text></svg>`;
    setStickers((prev) => [...prev, { emoji: newEmoji.trim(), asset_url: asset }]);
    setNewAssetUrl('');
  };

  const handleRemoveSticker = (idx: number) => {
    setStickers((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCreatePack = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || stickers.length === 0) {
      setError(uiText("Please provide a title and at least one sticker.", uiLang));
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const cleanStickers: Array<{ emoji: string; asset_url: string }> = [];
      for (let i = 0; i < stickers.length; i++) {
        const s = stickers[i];
        let assetUrl = s.asset_url;
        if (assetUrl.startsWith('data:')) {
          try {
            const up = await api.uploadStickerAsset(assetUrl);
            if (up?.url) {
              assetUrl = up.url;
            }
          } catch (upErr) {
            console.warn('Asset upload error:', upErr);
          }
        }
        cleanStickers.push({ emoji: s.emoji || '✨', asset_url: assetUrl });
      }

      const packName = (name.trim() || title).toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'pack_' + Date.now();
      const pack = await api.createUserStickerPack({
        title: title.trim(),
        name: packName,
        stickers: cleanStickers,
      });
      setCreatedPack(pack);
      onPackCreatedOrInstalled(pack);
    } catch (err: any) {
      setError(err.message || uiText("Failed to create sticker pack", uiLang));
    } finally {
      setSaving(false);
    }
  };

  const handleInspectShare = async () => {
    const raw = shareInput.trim();
    if (!raw) return;
    setError(null);
    setInspecting(true);

    // Extract code from link if URL was pasted
    let code = raw;
    if (code.includes('/stickers/share/')) {
      code = code.split('/stickers/share/')[1].split('/')[0].split('?')[0];
    }

    try {
      const pack = await api.getStickerPackByShareCode(code);
      setInspectedPack(pack);
    } catch (err: any) {
      setError(err.message || uiText("Sticker pack not found with this code", uiLang));
    } finally {
      setInspecting(false);
    }
  };

  const handleInstallInspected = async () => {
    if (!inspectedPack) return;
    setInstalling(true);
    setError(null);
    try {
      await api.installStickerPack(inspectedPack.id);
      onPackCreatedOrInstalled(inspectedPack);
      onClose();
    } catch (err: any) {
      setError(err.message || uiText("Failed to install sticker pack", uiLang));
    } finally {
      setInstalling(false);
    }
  };

  const handleCopyLink = () => {
    if (!createdPack) return;
    const link = `${window.location.origin}/stickers/share/${createdPack.share_code}`;
    navigator.clipboard.writeText(link);
    setCopiedShare(true);
    setTimeout(() => setCopiedShare(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-lg rounded-3xl bg-[#17212b] border border-[#242f3d] shadow-2xl p-6 text-white flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#242f3d]">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold">{uiText("Custom Sticker Packs", uiLang)}</h3>
              <p className="text-[11px] text-[#7f91a4]">{uiText("Create, publish, and share sticker packs", uiLang)}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab switch */}
        <div className="flex bg-[#101921] p-1 rounded-2xl my-4">
          <button
            type="button"
            onClick={() => setTab('create')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-xl transition cursor-pointer ${
              tab === 'create' ? 'bg-[#24A1DE] text-white shadow' : 'text-[#7f91a4] hover:text-white'
            }`}
          >{uiText("Create Pack", uiLang)}</button>
          <button
            type="button"
            onClick={() => setTab('import')}
            className={`flex-1 py-1.5 text-xs font-semibold rounded-xl transition cursor-pointer ${
              tab === 'import' ? 'bg-[#24A1DE] text-white shadow' : 'text-[#7f91a4] hover:text-white'
            }`}
          >{uiText("Import via Share Code", uiLang)}</button>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-2xl bg-red-950/80 border border-red-800 text-red-300 text-xs flex items-center gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{uiText(error, uiLang)}</span>
          </div>
        )}

        {/* CREATE TAB */}
        {tab === 'create' && (
          <div className="flex-1 overflow-y-auto space-y-4 pr-1">
            {createdPack ? (
              <div className="py-6 flex flex-col items-center text-center space-y-4">
                <div className="h-16 w-16 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center">
                  <Check className="h-8 w-8" />
                </div>
                <div>
                  <h4 className="text-base font-bold text-white">{createdPack.title}{uiText(" Published!", uiLang)}</h4>
                  <p className="text-xs text-[#7f91a4] mt-1">{uiText("Your sticker pack is now active and ready to share.", uiLang)}</p>
                </div>

                <div className="w-full bg-[#101921] p-3 rounded-2xl border border-[#242f3d] text-left">
                  <span className="text-[10px] text-[#7f91a4] uppercase font-semibold block mb-1">{uiText("Share Code", uiLang)}</span>
                  <div className="flex items-center justify-between font-mono text-sm text-[#24A1DE] font-bold">
                    <span>{createdPack.share_code}</span>
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="px-3 py-1 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white text-xs font-sans font-semibold flex items-center gap-1.5 transition cursor-pointer"
                    >
                      {copiedShare ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      <span>{copiedShare ? uiText("Copied", uiLang) : uiText("Copy Link", uiLang)}</span>
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onClose}
                  className="w-full py-2.5 rounded-2xl bg-[#242f3d] hover:bg-[#202b36] text-white text-xs font-semibold cursor-pointer"
                >{uiText("Done", uiLang)}</button>
              </div>
            ) : (
              <form onSubmit={handleCreatePack} className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-[#7f91a4] block mb-1">{uiText("Pack Title *", uiLang)}</label>
                  <input
                    type="text"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={uiText("e.g. Neon Kittens", uiLang)}
                    className="w-full bg-[#101921] border border-[#242f3d] rounded-2xl px-3.5 py-2 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                    required
                  />
                </div>

                <div>
                  <label className="text-xs font-semibold text-[#7f91a4] block mb-1">{uiText("Short Identifier (Optional)", uiLang)}</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={uiText("e.g. neon_kittens", uiLang)}
                    className="w-full bg-[#101921] border border-[#242f3d] rounded-2xl px-3.5 py-2 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
                  />
                </div>

                {/* Stickers List */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-semibold text-[#7f91a4]">{uiText("Stickers (", uiLang)}{stickers.length})
                    </label>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex items-center gap-1.5 text-xs font-semibold text-[#24A1DE] hover:underline cursor-pointer"
                    >
                      <Plus size={13} />
                      <span>{uiText("Batch Upload Photos / WebM / WebP", uiLang)}</span>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/webm,.webm,.webp"
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleBatchFileUpload(e.target.files);
                        }
                      }}
                      className="hidden"
                    />
                  </div>

                  <div
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                        handleBatchFileUpload(e.dataTransfer.files);
                      }
                    }}
                    className="grid grid-cols-4 gap-2.5 max-h-48 overflow-y-auto p-1.5 bg-[#101921] rounded-2xl border border-[#242f3d]"
                  >
                    {stickers.map((stk, idx) => (
                      <div
                        key={idx}
                        className="relative group h-20 rounded-xl bg-[#17212b] border border-[#242f3d] flex flex-col items-center justify-center p-2"
                      >
                        {stk.asset_url?.includes('video/webm') || stk.asset_url?.endsWith('.webm') ? (
                          <video
                            src={stk.asset_url}
                            autoPlay
                            loop
                            muted
                            playsInline
                            className="h-10 w-10 object-contain pointer-events-none"
                          />
                        ) : (
                          <img
                            src={stk.asset_url}
                            alt={stk.emoji}
                            className="h-10 w-10 object-contain"
                          />
                        )}
                        <span className="text-xs mt-1">{stk.emoji}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveSticker(idx)}
                          className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {uploadingBatch && (
                    <div className="text-[11px] text-[#24A1DE] mt-1 flex items-center gap-1">
                      <Upload size={12} className="animate-bounce" />
                      <span>{uiText("Processing uploaded media...", uiLang)}</span>
                    </div>
                  )}
                </div>

                {/* Add new sticker inline */}
                <div className="p-3 rounded-2xl bg-[#1b2633] border border-[#242f3d] flex items-center gap-2">
                  <input
                    type="text"
                    value={newEmoji}
                    onChange={(e) => setNewEmoji(e.target.value)}
                    placeholder={uiText("Emoji", uiLang)}
                    className="w-14 bg-[#101921] border border-[#242f3d] rounded-xl px-2 py-1.5 text-center text-sm"
                  />
                  <input
                    type="text"
                    value={newAssetUrl}
                    onChange={(e) => setNewAssetUrl(e.target.value)}
                    placeholder={uiText("Custom Image URL, WebM URL, or SVG", uiLang)}
                    className="flex-1 bg-[#101921] border border-[#242f3d] rounded-xl px-3 py-1.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleAddSticker}
                    className="py-1.5 px-3 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white font-semibold text-xs transition cursor-pointer"
                  >{uiText("Add", uiLang)}</button>
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full py-3 rounded-2xl bg-[#24A1DE] hover:bg-[#208fc4] text-white font-bold text-xs shadow-lg transition cursor-pointer"
                >
                  {saving ? uiText("Creating Pack...", uiLang) : uiText("Publish & Install Sticker Pack", uiLang)}
                </button>
              </form>
            )}
          </div>
        )}

        {/* IMPORT TAB */}
        {tab === 'import' && (
          <div className="flex-1 overflow-y-auto space-y-4">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={shareInput}
                onChange={(e) => setShareInput(e.target.value)}
                placeholder={uiText("Paste Share Code (e.g. stk_...) or Share Link", uiLang)}
                className="flex-1 bg-[#101921] border border-[#242f3d] rounded-2xl px-3.5 py-2 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
              />
              <button
                type="button"
                onClick={handleInspectShare}
                disabled={inspecting}
                className="py-2 px-4 rounded-2xl bg-[#24A1DE] hover:bg-[#208fc4] text-white font-semibold text-xs transition cursor-pointer"
              >
                {inspecting ? uiText("Inspecting...", uiLang) : uiText("Find Pack", uiLang)}
              </button>
            </div>

            {inspectedPack && (
              <div className="p-4 rounded-2xl bg-[#101921] border border-[#242f3d] space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-bold text-white">{inspectedPack.title}</h4>
                    <p className="text-[11px] text-[#7f91a4]">{uiText("By @", uiLang)}{inspectedPack.author} • {inspectedPack.sticker_count}{uiText("stickers", uiLang)}</p>
                  </div>
                  <button
                    type="button"
                    onClick={handleInstallInspected}
                    disabled={installing}
                    className="py-1.5 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shadow-md"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>{installing ? uiText("Installing...", uiLang) : uiText("Install", uiLang)}</span>
                  </button>
                </div>

                <div className="grid grid-cols-4 gap-2 pt-2 border-t border-[#242f3d] max-h-48 overflow-y-auto">
                  {inspectedPack.stickers?.map((stk) => (
                    <div
                      key={stk.id}
                      className="h-16 rounded-xl bg-[#17212b] border border-[#242f3d] flex flex-col items-center justify-center p-1.5"
                    >
                      {stk.asset_url?.includes('video/webm') || stk.asset_url?.endsWith('.webm') ? (
                        <video
                          src={stk.asset_url}
                          autoPlay
                          loop
                          muted
                          playsInline
                          className="h-8 w-8 object-contain pointer-events-none"
                        />
                      ) : (
                        <img
                          src={stk.asset_url}
                          alt={stk.emoji}
                          className="h-8 w-8 object-contain"
                        />
                      )}
                      <span className="text-[11px] mt-1">{stk.emoji}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
