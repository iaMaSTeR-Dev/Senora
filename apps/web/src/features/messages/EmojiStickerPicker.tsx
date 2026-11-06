import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../protocol/api';
import { GIFItem, Sticker, StickerPack } from '../../app/types';
import { StickerPackCreatorModal } from './StickerPackCreatorModal';
import { StickerCreatorModal } from './StickerCreatorModal';
import { Search, Smile, Sticker as StickerIcon, X, Download, Trash2, Film, Plus, Sparkles, Upload, Share2, Check } from 'lucide-react';

interface EmojiStickerPickerProps {
  onSelectEmoji: (emoji: string) => void;
  onSelectSticker: (pack: StickerPack, sticker: Sticker) => void;
  onSelectGIF?: (gif: GIFItem) => void;
  onClose: () => void;
  isRtl?: boolean;
}

const EMOJI_CATEGORIES = [
  {
    id: 'smileys',
    name: 'Smileys',
    emojis: ['😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙', '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😤', '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰', '😥', '😓', '🤗', '🤔', '🤭', '🤫', '🤥', '😶', '😐', '😑', '😬', '🙄', '😯', '😦', '😧', '😮', '😲', '🥱', '😴', '🤤', '😪', '😵', '🤐', '🥴', '🤢', '🤮', '🤧', '😷', '🤒', '🤕']
  },
  {
    id: 'gestures',
    name: 'Gestures & People',
    emojis: ['👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '👌', '🤌', '🤏', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐', '🖖', '👋', '🤙', '💪', '🦾', '✍️', '🙏', '🤝', '👏', '🙌', '👐', '🤲', '🦶', '🦵', '👂', '👃', '🧠', '👀', '👁', '👅', '👄']
  },
  {
    id: 'animals',
    name: 'Animals & Nature',
    emojis: ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🐛', '🦋', '🐌', '🐞', '🐜', '🐢', '🐍', '🦎', '🐙', '🦑', '🦐', '🦀', '🐬', '🐳', '🦈', '🐊', '🐅', '🐆', '🦓', '🐘', '🐪', '🦒', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃']
  },
  {
    id: 'food',
    name: 'Food & Drink',
    emojis: ['🍏', '🍎', '🍐', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🍍', '🥥', '🥝', '🍅', '🥑', '🥦', '🥬', '🥒', '🌶', '🌽', '🥕', '🥔', '🥐', '🍞', '🥖', '🥨', '🧀', '🍳', '🥞', '🥓', '🍗', '🍖', '🌭', '🍔', '🍟', '🍕', '🥪', '🥙', '🌮', '🌯', '🥗', '🥘', '🍝', '🍜', '🍣', '🍱', '🍦', '🍧', '🍨', '🍩', '🍪', '🎂', '🍰', '🧁', '🍫', '🍬', '🍭', '🍿', '☕️', '🍵', '🧃', '🥤', '🍺', '🍻', '🍷', '🍹']
  },
  {
    id: 'activities',
    name: 'Activities & Travel',
    emojis: ['⚽️', '🏀', '🏈', '⚾️', '🎾', '🏐', '🏉', '🎱', '🏓', '🏸', '🥊', '🥋', '🛹', '🛼', '🎿', '🏂', '🏋️', '🧗', '🚴', '🚗', '🚕', '🚙', '🚌', '🏎', '🚓', '🚑', '🚒', '🚚', '🚲', '🛵', '🏍', '🚨', '✈️', '🚀', '🛸', '🚁', '⛵️', '🚤', '🛳', '🌋', '🗻', '🏕', '🏖', '🏜', '🏝', '🏛', '🏟', '🎡', '🎢']
  },
  {
    id: 'objects_symbols',
    name: 'Objects & Symbols',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '✨', '⭐️', '🌟', '💥', '🔥', '🌈', '☀️', '🌤', '⛅️', '☁️', '🌧', '⛈', '🌩', '❄️', '💡', '🔦', '💸', '💵', '💰', '💳', '💎', '🔑', '🔒', '🔓', '🔔', '📣', '📢', '📦', '🎁', '🎈', '🎉', '🎊', '📱', '💻', '📷', '🎥', '⏰', '⏱', '🔋', '🔌', '📝', '📌', '📍', '✅', '❌', '💯', '⚠️', '⛔️', 'ℹ️']
  }
];

const SKIN_TONES = [
  { id: 'default', label: 'Default', mod: '' },
  { id: 'light', label: 'Light', mod: '🏻' },
  { id: 'medium-light', label: 'Medium-Light', mod: '🏼' },
  { id: 'medium', label: 'Medium', mod: '🏽' },
  { id: 'medium-dark', label: 'Medium-Dark', mod: '🏾' },
  { id: 'dark', label: 'Dark', mod: '🏿' },
];

export const EmojiStickerPicker: React.FC<EmojiStickerPickerProps> = ({
  onSelectEmoji,
  onSelectSticker,
  onSelectGIF,
  onClose,
  isRtl,
}) => {
  const [activeTab, setActiveTab] = useState<'emoji' | 'stickers' | 'gifs'>('emoji');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSkinTone, setSelectedSkinTone] = useState('');
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);

  // Stickers state
  const [installedPacks, setInstalledPacks] = useState<StickerPack[]>([]);
  const [allCatalogPacks, setAllCatalogPacks] = useState<StickerPack[]>([]);
  const [selectedPackId, setSelectedPackId] = useState<string>('');
  const [showCatalogModal, setShowCatalogModal] = useState(false);
  const [showCreatorModal, setShowCreatorModal] = useState(false);
  const [showStickerStudio, setShowStickerStudio] = useState(false);
  const [recentStickers, setRecentStickers] = useState<Sticker[]>([]);
  const [loadingStickers, setLoadingStickers] = useState(false);
  const [copiedPackId, setCopiedPackId] = useState<string | null>(null);
  const [sharingPackId, setSharingPackId] = useState<string | null>(null);

  const handleSharePack = async (pack: StickerPack) => {
    setSharingPackId(pack.id);
    try {
      let targetShareCode = pack.share_code;

      // Check if pack has local stickers or is a local pack that needs syncing to the server
      const isLocalPack = pack.id.startsWith('pack_custom_') || pack.id.startsWith('pack_local_');
      const packStickers = pack.stickers || [];
      const needsSync = isLocalPack || (pack.sticker_count !== undefined && packStickers.length > pack.sticker_count) || !pack.share_code || packStickers.some(s => s.asset_url?.startsWith('data:'));

      if (needsSync && packStickers.length > 0) {
        // Pre-upload any base64 data URLs to get clean asset URLs
        const cleanStickers: Array<{ emoji: string; asset_url: string }> = [];
        for (let i = 0; i < packStickers.length; i++) {
          const s = packStickers[i];
          let assetUrl = s.asset_url;
          if (assetUrl.startsWith('data:')) {
            try {
              const up = await api.uploadStickerAsset(assetUrl);
              if (up?.url) assetUrl = up.url;
            } catch (e) {
              console.warn('Asset upload error during sync:', e);
            }
          }
          cleanStickers.push({ emoji: s.emoji || '✨', asset_url: assetUrl });
        }

        // If it's a local pack or not created on server yet, create a real server pack with all stickers!
        if (isLocalPack || !pack.share_code) {
          const created = await api.createUserStickerPack({
            title: pack.title || 'My Stickers',
            name: (pack.title || 'my_stickers').toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'pack_' + Date.now(),
            stickers: cleanStickers,
          });
          targetShareCode = created.share_code;
          // Update installed packs list with server pack
          setInstalledPacks(prev => [created, ...prev.filter(p => p.id !== pack.id)]);
        } else {
          // If server pack already exists but only has 1 sticker while client has 26:
          // Add the missing stickers to the pack on the server
          for (const st of cleanStickers) {
            try {
              await api.addStickerToPack(pack.id, st);
            } catch {}
          }
          targetShareCode = pack.share_code;
        }
      }

      const code = targetShareCode || pack.share_code || pack.id;
      const link = `${window.location.origin}/?pack=${encodeURIComponent(code)}`;
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        setCopiedPackId(pack.id);
        setTimeout(() => setCopiedPackId(null), 2500);
      } else {
        prompt('لینک اشتراک‌گذاری پک استیکر:', link);
      }
    } catch (err: any) {
      console.error('Error preparing pack for share:', err);
      const code = pack.share_code || pack.id;
      const link = `${window.location.origin}/?pack=${encodeURIComponent(code)}`;
      prompt('لینک اشتراک‌گذاری پک استیکر:', link);
    } finally {
      setSharingPackId(null);
    }
  };

  // GIFs state
  const [gifQuery, setGifQuery] = useState('');
  const [gifs, setGifs] = useState<GIFItem[]>([]);
  const [loadingGIFs, setLoadingGIFs] = useState(false);

  // Load recent emojis & stickers from storage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('senora_recent_emojis');
      if (saved) {
        setRecentEmojis(JSON.parse(saved));
      }
      const savedStickers = localStorage.getItem('senora_recent_stickers');
      if (savedStickers) {
        setRecentStickers(JSON.parse(savedStickers));
      }
    } catch {}
  }, []);

  const handleStickerClick = (pack: StickerPack, sticker: Sticker) => {
    const updated = [sticker, ...recentStickers.filter((s) => s.id !== sticker.id)].slice(0, 24);
    setRecentStickers(updated);
    try {
      localStorage.setItem('senora_recent_stickers', JSON.stringify(updated));
    } catch {}
    onSelectSticker(pack, sticker);
  };

  // Load installed sticker packs
  const loadStickers = async () => {
    setLoadingStickers(true);
    try {
      const uninstalledRaw = localStorage.getItem('senora_uninstalled_packs');
      const uninstalledSet = new Set<string>(uninstalledRaw ? JSON.parse(uninstalledRaw) : []);

      const installedRes = await api.getInstalledStickers();
      let packs: StickerPack[] = installedRes.packs && installedRes.packs.length > 0 ? [...installedRes.packs] : [];

      // Check if user has initialized stickers for the first time
      const hasInitialized = localStorage.getItem('senora_stickers_initialized');
      if (packs.length === 0 && !hasInitialized && uninstalledSet.size === 0) {
        try {
          const allRes = await api.listStickerPacks();
          if (allRes.packs && allRes.packs.length > 0) {
            for (const p of allRes.packs) {
              await api.installStickerPack(p.id).catch(() => {});
            }
            packs = [...allRes.packs];
          }
          localStorage.setItem('senora_stickers_initialized', 'true');
        } catch {}
      }

      // Filter out explicitly uninstalled packs
      packs = packs.filter((p) => !uninstalledSet.has(p.id));

      // Deduplicate installed packs by ID to eliminate duplicate entries
      const seenPackIds = new Set<string>();
      packs = packs.filter((p) => {
        if (!p || !p.id || seenPackIds.has(p.id)) return false;
        seenPackIds.add(p.id);
        return true;
      });

      // Clear legacy phantom custom_stickers cache that previously synthesized duplicate "My Stickers" packs
      try {
        localStorage.removeItem('senora_custom_stickers');
      } catch {}

      setInstalledPacks(packs);
      if (packs.length > 0 && (!selectedPackId || !packs.find((p) => p.id === selectedPackId))) {
        setSelectedPackId(packs[0].id);
      } else if (packs.length === 0) {
        setSelectedPackId('');
      }
    } catch (e) {
      console.warn('Failed to load installed stickers:', e);
    } finally {
      setLoadingStickers(false);
    }
  };

  useEffect(() => {
    loadStickers();
    const handleUpdated = () => {
      loadStickers();
    };
    window.addEventListener('senora_stickers_updated', handleUpdated);
    return () => window.removeEventListener('senora_stickers_updated', handleUpdated);
  }, []);

  // Load catalog when modal opens
  const openCatalog = async () => {
    setShowCatalogModal(true);
    try {
      const res = await api.listStickerPacks();
      setAllCatalogPacks(res.packs || []);
    } catch (e) {
      console.warn('Failed to load sticker catalog:', e);
    }
  };

  // Search GIFs
  const fetchGIFs = async (q: string) => {
    setLoadingGIFs(true);
    try {
      const res = await api.searchGIFs(q);
      setGifs(res.gifs || []);
    } catch (e) {
      console.warn('GIF search error:', e);
    } finally {
      setLoadingGIFs(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'gifs') {
      fetchGIFs(gifQuery);
    }
  }, [activeTab, gifQuery]);

  const handleInstallPack = async (packId: string) => {
    try {
      // Remove from uninstalled set
      try {
        const uninstalled: string[] = JSON.parse(localStorage.getItem('senora_uninstalled_packs') || '[]');
        const updated = uninstalled.filter((id) => id !== packId);
        localStorage.setItem('senora_uninstalled_packs', JSON.stringify(updated));
      } catch {}

      await api.installStickerPack(packId);
      await loadStickers();
    } catch (e) {
      console.warn('Failed to install sticker pack:', e);
    }
  };

  const handleUninstallPack = async (packId: string) => {
    try {
      // 1. Try deleting completely via deleteStickerPack first
      // The updated backend deletes completely if creator/owner, or uninstalls for user if built-in/non-creator
      try {
        await api.deleteStickerPack(packId);
      } catch {
        await api.uninstallStickerPack(packId).catch(() => {});
      }

      // 2. Track in senora_uninstalled_packs
      try {
        const uninstalled: string[] = JSON.parse(localStorage.getItem('senora_uninstalled_packs') || '[]');
        if (!uninstalled.includes(packId)) {
          uninstalled.push(packId);
          localStorage.setItem('senora_uninstalled_packs', JSON.stringify(uninstalled));
        }
      } catch {}

      // 3. Clean senora_custom_stickers
      try {
        localStorage.removeItem('senora_custom_stickers');
      } catch {}

      // 4. Remove stickers of this pack from recent stickers
      const targetPack = installedPacks.find((p) => p.id === packId);
      if (targetPack?.stickers) {
        const removedIds = new Set(targetPack.stickers.map((s) => s.id));
        const updatedRecents = recentStickers.filter((s) => !removedIds.has(s.id));
        setRecentStickers(updatedRecents);
        try {
          localStorage.setItem('senora_recent_stickers', JSON.stringify(updatedRecents));
        } catch {}
      }

      // 5. Update local state immediately without waiting for network
      const remaining = installedPacks.filter((p) => p.id !== packId);
      setInstalledPacks(remaining);
      if (selectedPackId === packId) {
        setSelectedPackId(remaining[0]?.id || '');
      }

      // 6. Also remove from allCatalogPacks so it immediately disappears from Catalog too!
      setAllCatalogPacks((prev) => prev.filter((p) => p.id !== packId));
    } catch (e) {
      console.warn('Failed to delete/uninstall sticker pack:', e);
    }
  };

  const handleDeleteCustomSticker = async (packId: string, stickerId: string) => {
    try {
      // 1. If backend sticker, call API
      if (!stickerId.startsWith('local_stk_') && !stickerId.startsWith('stk_custom_local')) {
        try {
          await api.deleteSticker(stickerId);
        } catch (apiErr) {
          console.warn('Server delete sticker error:', apiErr);
        }
      }

      // 2. Remove from localStorage senora_custom_stickers
      try {
        const savedRaw = localStorage.getItem('senora_custom_stickers');
        if (savedRaw) {
          const customStickers: Sticker[] = JSON.parse(savedRaw);
          const filtered = customStickers.filter((s) => s.id !== stickerId);
          localStorage.setItem('senora_custom_stickers', JSON.stringify(filtered));
        }
      } catch {}

      // 3. Remove from recent stickers
      const updatedRecents = recentStickers.filter((s) => s.id !== stickerId);
      setRecentStickers(updatedRecents);
      try {
        localStorage.setItem('senora_recent_stickers', JSON.stringify(updatedRecents));
      } catch {}

      // 4. Update state in installedPacks
      setInstalledPacks((prev) =>
        prev.map((p) => {
          if (p.id === packId) {
            const updatedStickers = (p.stickers || []).filter((s) => s.id !== stickerId);
            return {
              ...p,
              stickers: updatedStickers,
              sticker_count: updatedStickers.length,
            };
          }
          return p;
        })
      );
    } catch (e) {
      console.warn('Failed to delete sticker:', e);
    }
  };

  const handleRemoveRecentSticker = (stickerId: string) => {
    const updated = recentStickers.filter((s) => s.id !== stickerId);
    setRecentStickers(updated);
    try {
      localStorage.setItem('senora_recent_stickers', JSON.stringify(updated));
    } catch {}
  };

  const handleEmojiClick = (emoji: string) => {
    const toneMod = selectedSkinTone;
    const finalEmoji = toneMod && !emoji.includes(toneMod) ? `${emoji}${toneMod}` : emoji;

    // Update recents
    const updated = [finalEmoji, ...recentEmojis.filter((e) => e !== finalEmoji)].slice(0, 32);
    setRecentEmojis(updated);
    try {
      localStorage.setItem('senora_recent_emojis', JSON.stringify(updated));
    } catch {}

    onSelectEmoji(finalEmoji);
  };

  // Filtered categories based on search
  const filteredCategories = useMemo(() => {
    if (!searchQuery.trim()) return EMOJI_CATEGORIES;
    const q = searchQuery.toLowerCase();
    return EMOJI_CATEGORIES.map((cat) => ({
      ...cat,
      emojis: cat.emojis.filter((e) => e.includes(q)),
    })).filter((cat) => cat.emojis.length > 0);
  }, [searchQuery]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const activePack = installedPacks.find((p) => p.id === selectedPackId) || installedPacks[0];

  return (
    <div
      dir={isRtl ? 'rtl' : 'ltr'}
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      className="w-80 sm:w-96 bg-[#17212b] border border-[#242f3d] rounded-2xl shadow-2xl flex flex-col h-[420px] max-h-[75vh] overflow-hidden select-none animate-in fade-in zoom-in-95 duration-150"
    >
      {/* Top Tabs */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-2 border-b border-[#242f3d] bg-[#101921]/50">
        <div className="flex items-center gap-1 bg-[#17212b] p-0.5 rounded-xl border border-[#242f3d]">
          <button
            onClick={() => setActiveTab('emoji')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition ${
              activeTab === 'emoji'
                ? 'bg-[#24A1DE] text-white shadow-sm'
                : 'text-[#7f91a4] hover:text-white'
            }`}
          >
            <Smile size={14} />
            <span>Emojis</span>
          </button>
          <button
            onClick={() => setActiveTab('stickers')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition ${
              activeTab === 'stickers'
                ? 'bg-[#24A1DE] text-white shadow-sm'
                : 'text-[#7f91a4] hover:text-white'
            }`}
          >
            <StickerIcon size={14} />
            <span>Stickers</span>
          </button>
          <button
            onClick={() => setActiveTab('gifs')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-semibold transition ${
              activeTab === 'gifs'
                ? 'bg-[#24A1DE] text-white shadow-sm'
                : 'text-[#7f91a4] hover:text-white'
            }`}
          >
            <Film size={14} />
            <span>GIFs</span>
          </button>
        </div>

        <button
          onClick={onClose}
          className="p-1.5 text-[#7f91a4] hover:text-white rounded-lg hover:bg-[#242f3d] transition cursor-pointer"
        >
          <X size={16} />
        </button>
      </div>

      {/* EMOJI TAB */}
      {activeTab === 'emoji' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Search bar & Skin tone selectors */}
          <div className="px-3 py-2 space-y-2 border-b border-[#242f3d]">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 text-[#7f91a4]" size={13} />
              <input
                type="text"
                placeholder="Search emoji..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1 text-xs bg-[#101921] border border-[#242f3d] rounded-xl text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
              />
            </div>

            {/* Skin tone pills */}
            <div className="flex items-center gap-1 pt-0.5 overflow-x-auto no-scrollbar">
              <span className="text-[10px] text-[#7f91a4] font-medium mr-1">Tone:</span>
              {SKIN_TONES.map((tone) => (
                <button
                  key={tone.id}
                  onClick={() => setSelectedSkinTone(tone.mod)}
                  className={`px-1.5 py-0.5 rounded text-[11px] transition ${
                    selectedSkinTone === tone.mod
                      ? 'bg-[#24A1DE]/30 text-[#24A1DE] border border-[#24A1DE]/50'
                      : 'bg-[#101921] text-[#7f91a4] hover:text-white border border-transparent'
                  }`}
                >
                  {tone.mod ? `✋${tone.mod}` : '✋'}
                </button>
              ))}
            </div>
          </div>

          {/* Emoji Scroll Area */}
          <div className="flex-1 overflow-y-auto p-3 space-y-3">
            {recentEmojis.length > 0 && !searchQuery && (
              <div>
                <span className="text-[10px] font-bold text-[#7f91a4] uppercase tracking-wider block mb-1">
                  Recently Used
                </span>
                <div className="grid grid-cols-8 gap-1">
                  {recentEmojis.map((emoji, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleEmojiClick(emoji)}
                      className="h-8 w-8 flex items-center justify-center text-lg hover:scale-125 transition rounded hover:bg-[#242f3d] cursor-pointer"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {filteredCategories.map((category) => (
              <div key={category.id}>
                <span className="text-[10px] font-bold text-[#7f91a4] uppercase tracking-wider block mb-1">
                  {category.name}
                </span>
                <div className="grid grid-cols-8 gap-1">
                  {category.emojis.map((emoji, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleEmojiClick(emoji)}
                      className="h-8 w-8 flex items-center justify-center text-lg hover:scale-125 transition rounded hover:bg-[#242f3d] cursor-pointer"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* STICKERS TAB */}
      {activeTab === 'stickers' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {/* Pack Selection Bar */}
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#242f3d] bg-[#101921]/50">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar flex-1 mr-2">
              {installedPacks.map((pack) => (
                <button
                  key={pack.id}
                  onClick={() => setSelectedPackId(pack.id)}
                  className={`px-2.5 py-1 rounded-xl text-xs font-semibold whitespace-nowrap transition ${
                    (selectedPackId === pack.id || (!selectedPackId && pack === installedPacks[0]))
                      ? 'bg-[#24A1DE]/25 text-[#24A1DE] border border-[#24A1DE]/50'
                      : 'text-[#7f91a4] hover:text-white hover:bg-[#242f3d]'
                  }`}
                >
                  {pack.title}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                onClick={() => setShowStickerStudio(true)}
                className="flex items-center gap-1 px-2.5 py-1 rounded-xl bg-gradient-to-r from-[#24A1DE] to-[#1d82b3] hover:from-[#208fc4] hover:to-[#176a92] text-white text-[11px] font-bold shadow-md shadow-[#24A1DE]/20 transition cursor-pointer"
                title="Create custom sticker from image"
              >
                <Sparkles size={12} />
                <span>Create Sticker</span>
              </button>
              <button
                onClick={() => setShowCreatorModal(true)}
                className="p-1 rounded-lg bg-[#24A1DE]/15 hover:bg-[#24A1DE]/25 text-[#24A1DE] transition cursor-pointer"
                title="Create / Share Custom Sticker Pack"
              >
                <Plus size={14} />
              </button>
              <button
                onClick={openCatalog}
                className="text-[11px] font-bold text-[#24A1DE] hover:underline px-1 cursor-pointer"
              >
                Catalog
              </button>
            </div>
          </div>

          {/* Stickers Grid */}
          <div className="flex-1 overflow-y-auto p-3 max-h-[310px] space-y-3">
            {/* Recently Used Stickers */}
            {recentStickers.length > 0 && (
              <div>
                <span className="text-[10px] font-bold text-[#7f91a4] uppercase tracking-wider block mb-1">
                  Recently Used
                </span>
                <div className="grid grid-cols-4 gap-2">
                  {recentStickers.slice(0, 8).map((stk) => (
                    <div key={stk.id} className="relative group/recent flex flex-col items-center justify-center">
                      <button
                        onClick={() => handleStickerClick(activePack || installedPacks[0], stk)}
                        className="p-1.5 rounded-xl hover:bg-[#242f3d] transition-transform hover:scale-105 active:scale-95 flex flex-col items-center justify-center group cursor-pointer w-full"
                        title={stk.emoji}
                      >
                        {stk.asset_url?.includes('video/webm') || stk.asset_url?.endsWith('.webm') ? (
                          <video
                            src={stk.asset_url}
                            autoPlay
                            loop
                            muted
                            playsInline
                            className="w-14 h-14 object-contain pointer-events-none drop-shadow-md"
                          />
                        ) : (
                          <img
                            src={stk.asset_url}
                            alt={stk.emoji || 'Sticker'}
                            className="w-14 h-14 object-contain pointer-events-none drop-shadow-md"
                            loading="lazy"
                          />
                        )}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRemoveRecentSticker(stk.id);
                        }}
                        className="absolute top-1 right-1 p-1 rounded-full bg-black/70 hover:bg-red-500 text-white/70 hover:text-white opacity-0 group-hover/recent:opacity-100 transition cursor-pointer z-10 shadow"
                        title="Remove from recents"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {loadingStickers ? (
              <div className="flex items-center justify-center py-12 text-[#7f91a4] text-xs">
                Loading stickers...
              </div>
            ) : activePack && activePack.stickers && activePack.stickers.length > 0 ? (
              <div>
                <div className="flex items-center justify-between mb-2 pb-1 border-b border-[#242f3d]/60">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">
                      {activePack.title}
                    </span>
                    <span className="text-[10px] text-[#7f91a4]">
                      ({activePack.stickers.length})
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleSharePack(activePack)}
                      disabled={sharingPackId === activePack.id}
                      className="flex items-center gap-1 px-2.5 py-0.5 text-[11px] text-[#24A1DE] hover:text-[#52bcf5] hover:bg-[#24A1DE]/10 disabled:opacity-50 rounded-lg border border-[#24A1DE]/30 transition cursor-pointer"
                      title="اشتراک‌گذاری پک استیکر (کپی لینک) / Share Sticker Pack"
                    >
                      {sharingPackId === activePack.id ? (
                        <span className="text-[10px]">⏳</span>
                      ) : copiedPackId === activePack.id ? (
                        <Check size={11} />
                      ) : (
                        <Share2 size={11} />
                      )}
                      <span>
                        {sharingPackId === activePack.id
                          ? 'در حال اشتراک...'
                          : copiedPackId === activePack.id
                          ? 'کپی شد!'
                          : 'اشتراک‌گذاری'}
                      </span>
                    </button>
                    <button
                      onClick={() => handleUninstallPack(activePack.id)}
                      className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg border border-red-500/30 transition cursor-pointer"
                      title={activePack.is_builtin ? "حذف از لیست منو" : "حذف کامل این پک استیکر"}
                    >
                      <Trash2 size={11} />
                      <span>{activePack.is_builtin ? 'حذف از منو' : 'حذف کامل پک'}</span>
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {activePack.stickers.map((stk) => (
                    <div key={stk.id} className="relative group/stk flex flex-col items-center justify-center">
                      <button
                        onClick={() => handleStickerClick(activePack, stk)}
                        className="p-1.5 rounded-xl hover:bg-[#242f3d] transition-transform hover:scale-105 active:scale-95 flex flex-col items-center justify-center group cursor-pointer w-full"
                        title={stk.emoji}
                      >
                        {stk.asset_url?.includes('video/webm') || stk.asset_url?.endsWith('.webm') ? (
                          <video
                            src={stk.asset_url}
                            autoPlay
                            loop
                            muted
                            playsInline
                            className="w-16 h-16 object-contain pointer-events-none drop-shadow-md"
                          />
                        ) : (
                          <img
                            src={stk.asset_url}
                            alt={stk.emoji}
                            className="w-16 h-16 object-contain pointer-events-none drop-shadow-md"
                            loading="lazy"
                          />
                        )}
                        <span className="text-[10px] text-[#7f91a4] group-hover:text-white mt-1">
                          {stk.emoji}
                        </span>
                      </button>
                      {/* Delete individual custom sticker */}
                      {!activePack.is_builtin && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteCustomSticker(activePack.id, stk.id);
                          }}
                          className="absolute top-1 right-1 p-1 rounded-full bg-black/70 hover:bg-red-500 text-white/70 hover:text-white opacity-0 group-hover/stk:opacity-100 transition cursor-pointer z-10 shadow"
                          title="Delete sticker"
                        >
                          <Trash2 size={10} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 space-y-3 text-center">
                <StickerIcon className="text-[#7f91a4]" size={36} />
                <p className="text-xs text-[#7f91a4]">No sticker packs installed</p>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowStickerStudio(true)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-[#24A1DE] hover:bg-[#208fc4] text-white rounded-xl text-xs font-semibold shadow cursor-pointer"
                  >
                    <Sparkles size={13} />
                    <span>Create Sticker</span>
                  </button>
                  <button
                    onClick={openCatalog}
                    className="px-3 py-1.5 bg-[#242f3d] hover:bg-[#2f3d4f] text-white rounded-xl text-xs font-semibold shadow cursor-pointer"
                  >
                    Sticker Catalog
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* GIFS TAB (Track F) */}
      {activeTab === 'gifs' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="p-2 border-b border-[#242f3d] flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 text-[#7f91a4]" size={13} />
              <input
                type="text"
                placeholder="Search GIFs (e.g. clap, excited, dancing)..."
                value={gifQuery}
                onChange={(e) => setGifQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1 text-xs bg-[#101921] border border-[#242f3d] rounded-xl text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
              />
            </div>
            <label
              className="p-1.5 rounded-xl bg-[#242f3d] hover:bg-[#208fc4] hover:text-white text-[#7f91a4] transition cursor-pointer flex-shrink-0"
              title="Upload animated WebM, WebP, or GIF"
            >
              <Upload size={14} />
              <input
                type="file"
                accept="image/gif,image/webp,video/webm,.webm,.webp,.gif"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file || !onSelectGIF) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = reader.result as string;
                    onSelectGIF({
                      id: `custom_gif_${Date.now()}`,
                      title: file.name,
                      url: dataUrl,
                      preview_url: dataUrl,
                      width: 320,
                      height: 240,
                    });
                    onClose();
                  };
                  reader.readAsDataURL(file);
                }}
                className="hidden"
              />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {loadingGIFs ? (
              <div className="flex items-center justify-center py-12 text-[#7f91a4] text-xs">
                Searching GIFs...
              </div>
            ) : gifs.length > 0 ? (
              <div className="grid grid-cols-2 gap-2">
                {gifs.map((gif) => (
                  <button
                    key={gif.id}
                    onClick={() => {
                      if (onSelectGIF) {
                        onSelectGIF(gif);
                      }
                      onClose();
                    }}
                    className="relative group rounded-xl overflow-hidden bg-[#101921] border border-[#242f3d] hover:border-[#24A1DE] transition aspect-video flex items-center justify-center cursor-pointer shadow-md"
                  >
                    {gif.url?.includes('video/webm') || gif.url?.endsWith('.webm') ? (
                      <video
                        src={gif.url}
                        autoPlay
                        loop
                        muted
                        playsInline
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <img
                        src={gif.url}
                        alt={gif.title}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    )}
                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-end p-1.5">
                      <span className="text-[10px] text-white font-semibold truncate">
                        {gif.title}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-[#7f91a4] text-center">
                <Film size={32} className="opacity-40 mb-2" />
                <p className="text-xs">No animated GIFs found for "{gifQuery}"</p>
                <p className="text-[10px] text-[#7f91a4]/70 mt-1">Try another search term or click the upload icon above</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Catalog Modal */}
      {showCatalogModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md bg-[#17212b] border border-[#242f3d] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]">
            <div className="flex items-center justify-between p-4 border-b border-[#242f3d]">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <StickerIcon className="text-[#24A1DE]" size={16} />
                <span>Sticker Pack Catalog</span>
              </h3>
              <button
                onClick={() => setShowCatalogModal(false)}
                className="text-[#7f91a4] hover:text-white p-1 rounded-lg"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {allCatalogPacks.map((pack) => {
                const isInstalled = installedPacks.some((p) => p.id === pack.id);
                return (
                  <div
                    key={pack.id}
                    className="flex items-center justify-between p-3 bg-[#1b2633] border border-[#242f3d] rounded-xl"
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={pack.thumbnail_url}
                        alt={pack.title}
                        className="w-12 h-12 object-contain rounded-lg bg-[#101921] p-1"
                      />
                      <div>
                        <h4 className="text-xs font-bold text-white">{pack.title}</h4>
                        <p className="text-[11px] text-[#7f91a4]">
                          by @{pack.author} • {pack.sticker_count} stickers
                        </p>
                      </div>
                    </div>

                    {isInstalled ? (
                      <button
                        onClick={() => handleUninstallPack(pack.id)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg border border-red-500/30 transition cursor-pointer"
                        title={pack.is_builtin ? "حذف از منو" : "حذف کامل پک"}
                      >
                        <Trash2 size={13} />
                        <span>{pack.is_builtin ? 'Remove' : 'Delete'}</span>
                      </button>
                    ) : (
                      <button
                        onClick={() => handleInstallPack(pack.id)}
                        className="flex items-center gap-1 px-3 py-1.5 text-xs bg-[#24A1DE] hover:bg-[#208fc4] text-white font-semibold rounded-lg shadow transition cursor-pointer"
                      >
                        <Download size={13} />
                        <span>Add</span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Creator Modal */}
      {showCreatorModal && (
        <StickerPackCreatorModal
          onClose={() => setShowCreatorModal(false)}
          onPackCreatedOrInstalled={async () => {
            await loadStickers();
          }}
        />
      )}

      {/* Individual Sticker Studio */}
      {showStickerStudio && (
        <StickerCreatorModal
          onClose={() => setShowStickerStudio(false)}
          onSendSticker={(pack, sticker) => {
            handleStickerClick(pack, sticker);
            onClose();
          }}
          onStickerSaved={async () => {
            await loadStickers();
          }}
          isRtl={isRtl}
        />
      )}
    </div>
  );
};
