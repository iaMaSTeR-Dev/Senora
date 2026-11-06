import React, { useState, useEffect } from 'react';
import { StickerPack, Sticker } from '../../app/types';
import { api } from '../../protocol/api';
import { X, Copy, Check, Share2, Sparkles, Plus, Trash2 } from 'lucide-react';

interface StickerPackModalProps {
  isOpen: boolean;
  onClose: () => void;
  pack?: StickerPack | null;
  packIdOrCode?: string | null;
  onPackInstalled?: (pack: StickerPack) => void;
  onSendSticker?: (pack: StickerPack, sticker: Sticker) => void;
}

export const StickerPackModal: React.FC<StickerPackModalProps> = ({
  isOpen,
  onClose,
  pack: initialPack,
  packIdOrCode,
  onPackInstalled,
  onSendSticker,
}) => {
  const [pack, setPack] = useState<StickerPack | null>(initialPack || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (initialPack) {
      setPack(initialPack);
      checkIfInstalled(initialPack.id);
    } else if (packIdOrCode && isOpen) {
      loadPack(packIdOrCode);
    }
  }, [initialPack, packIdOrCode, isOpen]);

  const checkIfInstalled = async (id: string) => {
    try {
      const res = await api.getInstalledStickers();
      const isInst = res.packs?.some((p) => p.id === id);
      setInstalled(Boolean(isInst));
    } catch {
      setInstalled(false);
    }
  };

  const loadPack = async (idOrCode: string) => {
    setLoading(true);
    setError(null);
    try {
      let loaded: StickerPack | null = null;
      if (idOrCode.startsWith('pack_') || idOrCode.startsWith('stk_') || idOrCode.length > 20) {
        try {
          loaded = await api.getStickerPack(idOrCode);
        } catch {
          loaded = await api.getStickerPackByShareCode(idOrCode);
        }
      } else {
        try {
          loaded = await api.getStickerPack(idOrCode);
        } catch {
          loaded = await api.getStickerPackByShareCode(idOrCode);
        }
      }
      setPack(loaded);
      if (loaded?.id) {
        checkIfInstalled(loaded.id);
      }
    } catch (e: any) {
      setError(e?.message || 'پک استیکر یافت نشد');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const shareCode = pack?.share_code || pack?.name || pack?.id;
  const shareLink = `${window.location.origin}/?pack=${encodeURIComponent(shareCode || '')}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleToggleInstall = async () => {
    if (!pack) return;
    setInstalling(true);
    try {
      if (installed) {
        try {
          await api.deleteStickerPack(pack.id);
        } catch {
          await api.uninstallStickerPack(pack.id).catch(() => {});
        }
        try {
          const uninstalled: string[] = JSON.parse(localStorage.getItem('senora_uninstalled_packs') || '[]');
          if (!uninstalled.includes(pack.id)) {
            uninstalled.push(pack.id);
            localStorage.setItem('senora_uninstalled_packs', JSON.stringify(uninstalled));
          }
        } catch {}
        setInstalled(false);
        window.dispatchEvent(new CustomEvent('senora_stickers_updated', { detail: { pack, uninstalled: true } }));
      } else {
        try {
          const uninstalled: string[] = JSON.parse(localStorage.getItem('senora_uninstalled_packs') || '[]');
          const updated = uninstalled.filter((id) => id !== pack.id);
          localStorage.setItem('senora_uninstalled_packs', JSON.stringify(updated));
        } catch {}
        await api.installStickerPack(pack.id);
        setInstalled(true);
        if (onPackInstalled) onPackInstalled(pack);
        window.dispatchEvent(new CustomEvent('senora_stickers_updated', { detail: { pack, installed: true } }));
      }
    } catch (e: any) {
      alert(e?.message || 'خطا در عملیات پک استیکر');
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-md rounded-3xl bg-[#17212b] border border-[#242f3d] shadow-2xl p-6 text-white flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-[#242f3d]">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-tr from-[#24A1DE] to-purple-600 flex items-center justify-center shadow-lg shadow-[#24A1DE]/20 text-white">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white line-clamp-1">
                {pack?.title || 'پک استیکر'}
              </h3>
              <p className="text-[11px] text-[#7f91a4]">
                {pack?.author ? `توسط @${pack.author}` : 'پک رسمی / سفارشی'} • {pack?.stickers?.length || 0} استیکر
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-xl text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto py-4 space-y-4">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-[#7f91a4] text-xs gap-3">
              <div className="h-6 w-6 border-2 border-[#24A1DE] border-t-transparent rounded-full animate-spin" />
              <span>در حال بارگذاری استیکرها...</span>
            </div>
          ) : error ? (
            <div className="p-4 rounded-2xl bg-red-950/80 border border-red-800 text-red-300 text-xs text-center">
              {error}
            </div>
          ) : pack ? (
            <>
              {/* Share Banner */}
              <div className="p-3 rounded-2xl bg-[#101921] border border-[#242f3d] flex items-center justify-between gap-3">
                <div className="truncate">
                  <span className="text-[10px] text-[#7f91a4] uppercase font-bold block mb-0.5">
                    لینک اشتراک‌گذاری پک
                  </span>
                  <p className="font-mono text-xs text-[#24A1DE] font-semibold truncate select-all">
                    {shareLink}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="px-3 py-1.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shrink-0 shadow"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  <span>{copied ? 'کپی شد!' : 'کپی لینک'}</span>
                </button>
              </div>

              {/* Stickers Grid */}
              <div className="grid grid-cols-4 gap-2.5 max-h-[340px] overflow-y-auto p-1">
                {pack.stickers?.map((stk) => (
                  <button
                    key={stk.id}
                    onClick={() => {
                      if (onSendSticker) {
                        onSendSticker(pack, stk);
                        onClose();
                      }
                    }}
                    className="p-2 rounded-2xl bg-[#101921]/60 hover:bg-[#242f3d] border border-transparent hover:border-[#24A1DE]/40 transition hover:scale-105 active:scale-95 flex flex-col items-center justify-center cursor-pointer group"
                    title={stk.emoji || 'Sticker'}
                  >
                    {stk.asset_url?.includes('video/webm') || stk.asset_url?.endsWith('.webm') ? (
                      <video
                        src={stk.asset_url}
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="w-14 h-14 object-contain pointer-events-none drop-shadow"
                      />
                    ) : (
                      <img
                        src={stk.asset_url}
                        alt={stk.emoji || 'Sticker'}
                        className="w-14 h-14 object-contain pointer-events-none drop-shadow"
                        loading="lazy"
                      />
                    )}
                    {stk.emoji && (
                      <span className="text-[10px] text-[#7f91a4] group-hover:text-white mt-1">
                        {stk.emoji}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>

        {/* Footer Actions */}
        {pack && (
          <div className="pt-3 border-t border-[#242f3d] flex items-center gap-2.5">
            <button
              type="button"
              onClick={handleToggleInstall}
              disabled={installing}
              className={`flex-1 py-2.5 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-lg ${
                installed
                  ? 'bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30'
                  : 'bg-gradient-to-r from-[#24A1DE] to-[#1c80b0] hover:from-[#208fc4] hover:to-[#176a92] text-white shadow-[#24A1DE]/25'
              }`}
            >
              {installed ? (
                <>
                  <Trash2 className="h-4 w-4" />
                  <span>{pack.is_builtin ? 'حذف از پک‌های من' : 'حذف کامل پک'}</span>
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4" />
                  <span>افزودن {pack.stickers?.length || ''} استیکر به حساب من</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleCopyLink}
              className="p-2.5 rounded-2xl bg-[#242f3d] hover:bg-[#2c3e50] text-[#7f91a4] hover:text-white transition cursor-pointer"
              title="اشتراک‌گذاری پک"
            >
              <Share2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
