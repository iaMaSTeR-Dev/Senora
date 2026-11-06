import React, { useState, useEffect } from 'react';
import { User } from '../../app/types';
import { api } from '../../protocol/api';
import { Language, translations } from '../../app/i18n';
import {
  AppSettings,
  loadSettings,
  saveSettings,
  syncSettingsFromBackend
} from './settingsModel';
import { DevicesSettings } from './DevicesSettings';
import { AppearanceSettings } from './AppearanceSettings';
import { PrivacySettings } from './PrivacySettings';
import { GeneralSettings } from './GeneralSettings';
import { AvatarUploadModal } from './AvatarUploadModal';
import {
  X,
  User as UserIcon,
  Palette,
  Headphones,
  Bell,
  Shield,
  MessageSquare,
  HardDrive,
  Globe,
  Eye,
  Info,
  Search,
  Camera,
  Trash2,
  Save,
  CheckCircle,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Copy,
  Check,
  Server
} from 'lucide-react';
import { ServerSelectionModal } from '../servers/ServerSelectionModal';

export type SettingsTab =
  | 'profile'
  | 'appearance'
  | 'devices'
  | 'notifications'
  | 'privacy'
  | 'chats'
  | 'data'
  | 'servers'
  | 'language'
  | 'accessibility'
  | 'about';

interface SettingsModalProps {
  currentUser: User;
  onClose: () => void;
  onUpdateUser: (updated: User) => void;
  lang: Language;
  onToggleLang: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  initialTab?: SettingsTab | 'security';
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  currentUser,
  onClose,
  onUpdateUser,
  lang,
  onToggleLang,
  theme,
  onToggleTheme,
  initialTab = 'profile',
}) => {
  // Normalize legacy initialTab
  const normalizedInitialTab: SettingsTab =
    initialTab === 'security' ? 'privacy' : (initialTab as SettingsTab) || 'profile';

  const [activeTab, setActiveTab] = useState<SettingsTab>(normalizedInitialTab);
  const [searchQuery, setSearchQuery] = useState('');
  const [settings, setSettings] = useState<AppSettings>(loadSettings());

  // Profile editing state
  const [displayName, setDisplayName] = useState(currentUser.display_name || '');
  const [bio, setBio] = useState(currentUser.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(currentUser.avatar_url || '');
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [copiedUsername, setCopiedUsername] = useState(false);

  // Mobile master-detail view state
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  const t = translations[lang];

  useEffect(() => {
    // Sync latest preferences from backend
    syncSettingsFromBackend().then((synced) => {
      setSettings(synced);
    });
  }, []);

  const handleSettingsChange = (partial: Partial<AppSettings>) => {
    const updated = saveSettings(partial);
    setSettings(updated);
    if (partial.theme && partial.theme !== theme && partial.theme !== 'system') {
      onToggleTheme();
    }
    if (partial.language && partial.language !== lang) {
      onToggleLang();
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setProfileSuccess(false);
    try {
      const updated = await api.updateProfile({
        display_name: displayName.trim(),
        bio: bio.trim(),
        avatar_url: avatarUrl.trim(),
      });
      onUpdateUser(updated);
      setProfileSuccess(true);
      setTimeout(() => setProfileSuccess(false), 2500);
    } catch (err: any) {
      alert(`Failed to save profile: ${err.message}`);
    } finally {
      setSavingProfile(false);
    }
  };

  const handleDeleteAvatar = async () => {
    if (!confirm('Are you sure you want to remove your avatar?')) return;
    try {
      const updated = await api.deleteAvatar();
      setAvatarUrl('');
      onUpdateUser(updated);
    } catch (e: any) {
      alert(`Failed to delete avatar: ${e.message}`);
    }
  };

  const handleCopyUsername = () => {
    navigator.clipboard.writeText(currentUser.username);
    setCopiedUsername(true);
    setTimeout(() => setCopiedUsername(false), 2000);
  };

  // Categories definitions
  const categories: {
    id: SettingsTab;
    label: string;
    icon: React.FC<{ className?: string }>;
    color: string;
    desc: string;
  }[] = [
    {
      id: 'profile',
      label: t.profile,
      icon: UserIcon,
      color: 'text-[#24A1DE]',
      desc: 'Name, bio, avatar, and account details',
    },
    {
      id: 'appearance',
      label: t.settings_appearance,
      icon: Palette,
      color: 'text-purple-400',
      desc: 'Theme, accent colors, wallpapers, font size',
    },
    {
      id: 'devices',
      label: t.settings_devices_media,
      icon: Headphones,
      color: 'text-amber-400',
      desc: 'Microphones, speakers, camera, live level test',
    },
    {
      id: 'notifications',
      label: t.settings_notifications,
      icon: Bell,
      color: 'text-rose-400',
      desc: 'Alerts, notification sounds, message previews',
    },
    {
      id: 'privacy',
      label: t.settings_privacy,
      icon: Shield,
      color: 'text-emerald-400',
      desc: 'Passcode lock, sessions, Signal Double Ratchet',
    },
    {
      id: 'chats',
      label: t.settings_chats,
      icon: MessageSquare,
      color: 'text-cyan-400',
      desc: 'Send on Enter, GIF/sticker autoplay, link previews',
    },
    {
      id: 'data',
      label: t.settings_data,
      icon: HardDrive,
      color: 'text-orange-400',
      desc: 'Auto-download media, local storage cache',
    },
    {
      id: 'servers',
      label: 'Servers & Network',
      icon: Server,
      color: 'text-blue-400',
      desc: 'Active node, custom self-hosted servers, connectivity',
    },
    {
      id: 'language',
      label: t.settings_language,
      icon: Globe,
      color: 'text-teal-400',
      desc: 'English, Persian RTL, Vazirmatn font, time format',
    },
    {
      id: 'accessibility',
      label: t.settings_accessibility,
      icon: Eye,
      color: 'text-indigo-400',
      desc: 'High contrast, focus rings, reduced animations',
    },
    {
      id: 'about',
      label: t.settings_about,
      icon: Info,
      color: 'text-slate-400',
      desc: 'App version, diagnostics export, protocol info',
    },
  ];

  // Search filter across categories
  const filteredCategories = categories.filter((c) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return c.label.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-md p-2 sm:p-4 animate-fade-in select-none">
      <div className="w-full max-w-4xl h-[92vh] sm:h-[86vh] rounded-3xl bg-[#17212b] border border-[#242f3d] shadow-2xl flex flex-col overflow-hidden text-white">
        {/* Top Header */}
        <div className="px-5 py-3.5 border-b border-[#242f3d] flex items-center justify-between bg-[#1f2b38]/80">
          <div className="flex items-center gap-3">
            {mobileDetailOpen && (
              <button
                type="button"
                onClick={() => setMobileDetailOpen(false)}
                className="md:hidden p-1.5 rounded-lg text-[#7f91a4] hover:text-white hover:bg-[#2b3a4a] transition cursor-pointer"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            )}
            <h2 className="text-base font-bold text-white tracking-wide">{t.settings}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#7f91a4] hover:text-white hover:bg-[#2b3a4a] transition cursor-pointer"
            title="Close Settings (Esc)"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Main Body: Master-Detail Layout */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Category Navigation (Hidden on mobile when detail is open) */}
          <div
            className={`w-full md:w-72 md:border-r border-[#242f3d] bg-[#17212b] flex flex-col flex-shrink-0 ${
              mobileDetailOpen ? 'hidden md:flex' : 'flex'
            }`}
          >
            {/* Search Input */}
            <div className="p-3 border-b border-[#242f3d]/60">
              <div className="relative flex items-center">
                <Search className="h-4 w-4 text-[#7f91a4] absolute left-3 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t.settings_search}
                  className="w-full rounded-xl bg-[#242f3d] pl-9 pr-3 py-2 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
                />
              </div>
            </div>

            {/* Category List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {filteredCategories.length === 0 ? (
                <div className="p-6 text-center text-xs text-[#7f91a4]">
                  {t.no_settings_found}
                </div>
              ) : (
                filteredCategories.map((c) => {
                  const Icon = c.icon;
                  const isActive = activeTab === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setActiveTab(c.id);
                        setMobileDetailOpen(true);
                      }}
                      className={`w-full p-2.5 rounded-xl flex items-center justify-between text-left transition cursor-pointer ${
                        isActive
                          ? 'bg-[#242f3d] text-white shadow-sm border border-white/5'
                          : 'text-[#7f91a4] hover:text-white hover:bg-[#202b36]'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-8 w-8 rounded-lg flex items-center justify-center ${
                            isActive ? 'bg-[#17212b]' : 'bg-[#242f3d]/50'
                          } ${c.color}`}
                        >
                          <Icon className="h-4 w-4" />
                        </div>
                        <div>
                          <span className="text-xs font-semibold block text-white">{c.label}</span>
                          <span className="text-[10px] text-[#7f91a4] truncate max-w-[150px] block">
                            {c.desc}
                          </span>
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 opacity-40" />
                    </button>
                  );
                })
              )}
            </div>

            {/* User Footnote */}
            <div className="p-3 border-t border-[#242f3d] bg-[#141d26] flex items-center justify-between text-xs">
              <div className="flex items-center gap-2 truncate">
                <div className="h-7 w-7 rounded-full bg-[#24A1DE] flex items-center justify-center font-bold text-white text-[11px] overflow-hidden">
                  {currentUser.avatar_url ? (
                    <img src={currentUser.avatar_url} alt="Avatar" className="h-full w-full object-cover" />
                  ) : (
                    currentUser.username.charAt(0).toUpperCase()
                  )}
                </div>
                <div className="truncate">
                  <span className="font-semibold text-white truncate block">
                    {currentUser.display_name || currentUser.username}
                  </span>
                  <span className="text-[10px] text-[#7f91a4]">@{currentUser.username}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Right Detail Panel (Hidden on mobile when detail is NOT open) */}
          <div
            className={`flex-1 overflow-y-auto p-5 sm:p-7 bg-[#17212b] ${
              !mobileDetailOpen ? 'hidden md:block' : 'block'
            }`}
          >
            {/* PROFILE TAB */}
            {activeTab === 'profile' && (
              <div className="space-y-6 text-xs text-white">
                <div className="pb-3 border-b border-[#242f3d]">
                  <h3 className="text-sm font-bold text-white">{t.profile}</h3>
                  <p className="text-[11px] text-[#7f91a4] mt-0.5">
                    Update personal profile, avatar photo, and bio description
                  </p>
                </div>

                <form onSubmit={handleSaveProfile} className="space-y-4">
                  {/* Avatar Section */}
                  <div className="flex items-center gap-4">
                    <div className="relative group">
                      <div className="h-20 w-20 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa] flex items-center justify-center text-2xl font-bold text-white shadow-xl overflow-hidden flex-shrink-0">
                        {avatarUrl ? (
                          <img src={avatarUrl} alt="Avatar" className="h-full w-full object-cover" />
                        ) : (
                          (displayName || currentUser.username).charAt(0).toUpperCase()
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowAvatarModal(true)}
                        className="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition cursor-pointer text-white"
                        title="Upload photo"
                      >
                        <Camera className="h-6 w-6" />
                      </button>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setShowAvatarModal(true)}
                          className="px-3 py-1.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer shadow"
                        >
                          <Camera className="h-3.5 w-3.5" />
                          <span>Change Photo</span>
                        </button>
                        {avatarUrl && (
                          <button
                            type="button"
                            onClick={handleDeleteAvatar}
                            className="px-3 py-1.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span>Remove</span>
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-[#7f91a4]">
                        JPG, PNG, or WebP. Maximum 10MB.
                      </p>
                    </div>
                  </div>

                  {/* Display Name */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      {t.display_name}
                    </label>
                    <input
                      type="text"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Your name"
                      className="w-full rounded-xl bg-[#242f3d] px-3.5 py-2.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
                    />
                  </div>

                  {/* Username (Read-Only Handle) */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      {t.username}
                    </label>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-xl bg-[#242f3d]/60 px-3.5 py-2.5 text-xs text-slate-300 font-mono">
                        @{currentUser.username}
                      </div>
                      <button
                        type="button"
                        onClick={handleCopyUsername}
                        className="p-2.5 rounded-xl bg-[#242f3d] hover:bg-[#2b3a4a] text-[#7f91a4] hover:text-white transition cursor-pointer"
                        title="Copy username"
                      >
                        {copiedUsername ? (
                          <Check className="h-4 w-4 text-emerald-400" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                  </div>

                  {/* Bio */}
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                      {t.bio}
                    </label>
                    <textarea
                      value={bio}
                      onChange={(e) => setBio(e.target.value)}
                      rows={3}
                      placeholder="A few words about you..."
                      className="w-full rounded-xl bg-[#242f3d] px-3.5 py-2.5 text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:ring-1 focus:ring-[#24A1DE] resize-none"
                    />
                  </div>

                  {profileSuccess && (
                    <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs flex items-center gap-2">
                      <CheckCircle className="h-4 w-4 flex-shrink-0" />
                      <span>Profile updated successfully!</span>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={savingProfile}
                    className="w-full py-2.5 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white flex items-center justify-center gap-2 transition disabled:opacity-50 cursor-pointer shadow-lg shadow-[#24A1DE]/20"
                  >
                    <Save className="h-4 w-4" />
                    <span>{savingProfile ? 'Saving...' : t.save}</span>
                  </button>
                </form>

                {/* Account Actions */}
                <div className="pt-4 border-t border-[#242f3d]">
                  <button
                    type="button"
                    onClick={async () => {
                      if (confirm('Are you sure you want to log out?')) {
                        await api.logout();
                        window.location.reload();
                      }
                    }}
                    className="w-full py-2.5 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-semibold flex items-center justify-center gap-2 transition cursor-pointer"
                  >
                    <LogOut className="h-4 w-4" />
                    <span>{t.logout}</span>
                  </button>
                </div>
              </div>
            )}

            {/* APPEARANCE TAB */}
            {activeTab === 'appearance' && (
              <AppearanceSettings
                settings={settings}
                onChange={handleSettingsChange}
                lang={lang}
              />
            )}

            {/* DEVICES & MEDIA TAB */}
            {activeTab === 'devices' && <DevicesSettings lang={lang} />}

            {/* PRIVACY & SECURITY TAB */}
            {activeTab === 'privacy' && (
              <PrivacySettings
                settings={settings}
                onChange={handleSettingsChange}
                lang={lang}
                currentUser={currentUser}
                onUpdateUser={onUpdateUser}
              />
            )}

            {/* SERVERS & NETWORK TAB */}
            {activeTab === 'servers' && (
              <ServerSelectionModal
                isOpen={true}
                onClose={() => setActiveTab('profile')}
                onServerSwitched={() => {
                  window.location.reload();
                }}
              />
            )}

            {/* GENERAL SETTINGS TABS */}
            {(activeTab === 'notifications' ||
              activeTab === 'chats' ||
              activeTab === 'data' ||
              activeTab === 'language' ||
              activeTab === 'accessibility' ||
              activeTab === 'about') && (
              <GeneralSettings
                category={activeTab}
                settings={settings}
                onChange={handleSettingsChange}
                lang={lang}
              />
            )}
          </div>
        </div>
      </div>

      {showAvatarModal && (
        <AvatarUploadModal
          currentUser={currentUser}
          onClose={() => setShowAvatarModal(false)}
          onSuccess={(updated) => {
            setAvatarUrl(updated.avatar_url || '');
            onUpdateUser(updated);
          }}
        />
      )}
    </div>
  );
};
