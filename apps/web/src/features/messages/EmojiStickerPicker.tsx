import React, { useState, useEffect, useMemo } from 'react';
import { api } from '../../protocol/api';
import { GIFItem, Sticker, StickerPack } from '../../app/types';
import { StickerPackCreatorModal } from './StickerPackCreatorModal';
import { Search, Smile, Sticker as StickerIcon, X, Download, Trash2, Film, Plus } from 'lucide-react';

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
  const [loadingStickers, setLoadingStickers] = useState(false);

  // GIFs state
  const [gifQuery, setGifQuery] = useState('');
  const [gifs, setGifs] = useState<GIFItem[]>([]);
  const [loadingGIFs, setLoadingGIFs] = useState(false);

  // Load recent emojis from storage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('senora_recent_emojis');
      if (saved) {
        setRecentEmojis(JSON.parse(saved));
      }
    } catch {}
  }, []);

  // Load installed sticker packs
  const loadStickers = async () => {
    setLoadingStickers(true);
    try {
      const installedRes = await api.getInstalledStickers();
      if (installedRes.packs && installedRes.packs.length > 0) {
        setInstalledPacks(installedRes.packs);
        if (!selectedPackId) {
          setSelectedPackId(installedRes.packs[0].id);
        }
      } else {
        const allRes = await api.listStickerPacks();
        setInstalledPacks(allRes.packs || []);
        if (allRes.packs && allRes.packs.length > 0 && !selectedPackId) {
          setSelectedPackId(allRes.packs[0].id);
        }
      }
    } catch (e) {
      console.warn('Failed to load installed stickers:', e);
    } finally {
      setLoadingStickers(false);
    }
  };

  useEffect(() => {
    loadStickers();
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
      await api.installStickerPack(packId);
      await loadStickers();
    } catch (e) {
      console.warn('Failed to install sticker pack:', e);
    }
  };

  const handleUninstallPack = async (packId: string) => {
    try {
      await api.uninstallStickerPack(packId);
      await loadStickers();
    } catch (e) {
      console.warn('Failed to uninstall sticker pack:', e);
    }
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

            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => setShowCreatorModal(true)}
                className="p-1 rounded-lg bg-[#24A1DE]/20 hover:bg-[#24A1DE]/30 text-[#24A1DE] transition cursor-pointer"
                title="Create / Share Custom Sticker Pack"
              >
                <Plus size={15} />
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
          <div className="flex-1 overflow-y-auto p-3 max-h-[310px]">
            {loadingStickers ? (
              <div className="flex items-center justify-center py-12 text-[#7f91a4] text-xs">
                Loading stickers...
              </div>
            ) : activePack && activePack.stickers && activePack.stickers.length > 0 ? (
              <div className="grid grid-cols-4 gap-2">
                {activePack.stickers.map((stk) => (
                  <button
                    key={stk.id}
                    onClick={() => onSelectSticker(activePack, stk)}
                    className="p-1.5 rounded-xl hover:bg-[#242f3d] transition-transform hover:scale-110 active:scale-95 flex flex-col items-center justify-center group cursor-pointer"
                    title={stk.emoji}
                  >
                    <img
                      src={stk.asset_url}
                      alt={stk.emoji}
                      className="w-16 h-16 object-contain pointer-events-none drop-shadow-md"
                      loading="lazy"
                    />
                    <span className="text-[10px] text-[#7f91a4] group-hover:text-white mt-1">
                      {stk.emoji}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-10 space-y-3 text-center">
                <StickerIcon className="text-[#7f91a4]" size={36} />
                <p className="text-xs text-[#7f91a4]">No stickers in this pack</p>
                <button
                  onClick={openCatalog}
                  className="px-3 py-1.5 bg-[#24A1DE] hover:bg-[#208fc4] text-white rounded-xl text-xs font-semibold shadow cursor-pointer"
                >
                  Browse Sticker Catalog
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* GIFS TAB (Track F) */}
      {activeTab === 'gifs' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="p-2 border-b border-[#242f3d]">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 text-[#7f91a4]" size={13} />
              <input
                type="text"
                placeholder="Search GIFs (e.g. clap, excited, dancing)..."
                value={gifQuery}
                onChange={(e) => setGifQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1 text-xs bg-[#101921] border border-[#242f3d] rounded-xl text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
              />
            </div>
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
                    <img
                      src={gif.url}
                      alt={gif.title}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
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
                <p className="text-[10px] text-[#7f91a4]/70 mt-1">Try another search term</p>
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
                      >
                        <Trash2 size={13} />
                        <span>Remove</span>
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
    </div>
  );
};
