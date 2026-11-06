import React, { useState } from 'react';
import { AppSettings, TimeFormat } from './settingsModel';
import { Language, translations } from '../../app/i18n';
import {
  Bell,
  Download,
  Trash2,
} from 'lucide-react';
import { mediaDeviceManager } from '../calls/mediaDeviceManager';

interface GeneralSettingsProps {
  category: 'notifications' | 'chats' | 'data' | 'language' | 'accessibility' | 'about';
  settings: AppSettings;
  onChange: (partial: Partial<AppSettings>) => void;
  lang: Language;
}

export const GeneralSettings: React.FC<GeneralSettingsProps> = ({
  category,
  settings,
  onChange,
  lang,
}) => {
  const t = translations[lang];
  const [cacheCleared, setCacheCleared] = useState(false);
  const [notificationTestStatus, setNotificationTestStatus] = useState<string | null>(null);

  const handleClearCache = () => {
    try {
      // Clear non-critical temporary session stores
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('senora_cache_') || key.startsWith('blob:')) {
          localStorage.removeItem(key);
        }
      });
      setCacheCleared(true);
      setTimeout(() => setCacheCleared(false), 2500);
    } catch {}
  };

  const handleTestNotification = async () => {
    if (typeof Notification === 'undefined') {
      alert('Desktop notifications are not supported in this browser.');
      return;
    }
    if (Notification.permission === 'granted') {
      new Notification('Senora Test Notification', {
        body: 'Desktop notifications are active and working!',
        icon: '/favicon.ico',
      });
      setNotificationTestStatus('Notification sent!');
      setTimeout(() => setNotificationTestStatus(null), 2500);
    } else {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        new Notification('Senora Notifications Enabled', {
          body: 'You will now receive message alerts.',
        });
      }
    }

  };

  const handleExportDiagnostics = () => {
    const data = {
      app_version: '1.0.0-phase9',
      build_date: new Date().toISOString(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'Unknown',
      settings: {
        theme: settings.theme,
        fontSize: settings.fontSize,
        chatWallpaper: settings.chatWallpaper,
        language: settings.language,
        timeFormat: settings.timeFormat,
        bubbleStyle: settings.bubbleStyle,
        highContrast: settings.highContrast,
        reducedMotion: settings.reducedMotion,
      },
      browser_capabilities: {
        web_crypto: typeof window !== 'undefined' && !!window.crypto?.subtle,
        webrtc: typeof window !== 'undefined' && !!window.RTCPeerConnection,
        media_devices: typeof navigator !== 'undefined' && !!navigator.mediaDevices,
        set_sink_id: mediaDeviceManager.isSinkIdSupported(),
        audio_context: typeof window !== 'undefined' && !!(window.AudioContext || (window as any).webkitAudioContext),
      },
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `senora_diagnostics_${Date.now()}.json`;
    a.click();

    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 text-xs text-white">
      {/* 1. Notifications & Sounds */}
      {category === 'notifications' && (
        <div className="space-y-4">
          <div className="pb-3 border-b border-[#242f3d]">
            <h3 className="text-sm font-bold text-white">{t.settings_notifications}</h3>
            <p className="text-[11px] text-[#7f91a4] mt-0.5">
              Control browser alerts, chimes, and lock screen message previews
            </p>
          </div>

          <div className="space-y-3">
            {/* Desktop Notifications */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Desktop Notifications</span>
                <span className="text-[11px] text-[#7f91a4]">Show alerts when messages arrive</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ desktopNotifications: !settings.desktopNotifications })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.desktopNotifications ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.desktopNotifications ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>

            {/* Test Notification Button */}
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px] text-[#7f91a4]">
                Permission:{' '}
                <strong className="text-white">
                  {typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'}
                </strong>
              </span>
              <button
                type="button"
                onClick={handleTestNotification}
                className="px-3 py-1.5 rounded-lg bg-[#242f3d] hover:bg-[#208fc4] hover:text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
              >
                <Bell className="h-3.5 w-3.5" />
                <span>{notificationTestStatus || 'Send Test Notification'}</span>
              </button>
            </div>

            {/* Notification Sound */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Notification Chime</span>
                <span className="text-[11px] text-[#7f91a4]">Play chime for incoming messages</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ notificationSound: !settings.notificationSound })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.notificationSound ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.notificationSound ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>

            {/* Message Preview */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Message Previews</span>
                <span className="text-[11px] text-[#7f91a4]">Include sender name and text snippet in alerts</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ messagePreview: !settings.messagePreview })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.messagePreview ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.messagePreview ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>

            {/* Mute All */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Mute All Notifications</span>
                <span className="text-[11px] text-[#7f91a4]">Temporarily silence all sounds and alerts</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ muteAll: !settings.muteAll })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.muteAll ? 'bg-amber-500' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.muteAll ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. Chats & Messaging */}
      {category === 'chats' && (
        <div className="space-y-4">
          <div className="pb-3 border-b border-[#242f3d]">
            <h3 className="text-sm font-bold text-white">{t.settings_chats}</h3>
            <p className="text-[11px] text-[#7f91a4] mt-0.5">
              Customize keyboard shortcuts, animations, and media autoplay
            </p>
          </div>

          <div className="space-y-3">
            {/* Enter to Send */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">{t.send_on_enter}</span>
                <span className="text-[11px] text-[#7f91a4]">
                  {settings.sendOnEnter
                    ? 'Press Enter to send (Shift+Enter for newline)'
                    : 'Press Ctrl+Enter or Cmd+Enter to send'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ sendOnEnter: !settings.sendOnEnter })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.sendOnEnter ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.sendOnEnter ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>

            {/* Autoplay GIFs */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Autoplay GIFs</span>
                <span className="text-[11px] text-[#7f91a4]">Play animated GIFs automatically</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ autoplayGifs: !settings.autoplayGifs })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.autoplayGifs ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.autoplayGifs ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>

            {/* Autoplay Stickers */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Autoplay Animated Stickers</span>
                <span className="text-[11px] text-[#7f91a4]">Loop sticker animations in chat bubbles</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ autoplayStickers: !settings.autoplayStickers })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.autoplayStickers ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.autoplayStickers ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>

            {/* Link Previews */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Link Previews</span>
                <span className="text-[11px] text-[#7f91a4]">Generate rich preview cards for sent URLs</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ linkPreviews: !settings.linkPreviews })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.linkPreviews ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.linkPreviews ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 3. Data & Storage */}
      {category === 'data' && (
        <div className="space-y-4">
          <div className="pb-3 border-b border-[#242f3d]">
            <h3 className="text-sm font-bold text-white">{t.settings_data}</h3>
            <p className="text-[11px] text-[#7f91a4] mt-0.5">
              Manage automatic media downloads and local browser storage
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] space-y-3">
            <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wider block">
              Automatic Media Download
            </span>
            <div className="space-y-2">
              <label className="flex items-center justify-between cursor-pointer">
                <span>Photos & Images</span>
                <input
                  type="checkbox"
                  checked={settings.autoDownloadPhotos}
                  onChange={(e) => onChange({ autoDownloadPhotos: e.target.checked })}
                  className="rounded text-[#24A1DE] focus:ring-0"
                />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span>Videos & Round Notes</span>
                <input
                  type="checkbox"
                  checked={settings.autoDownloadVideos}
                  onChange={(e) => onChange({ autoDownloadVideos: e.target.checked })}
                  className="rounded text-[#24A1DE] focus:ring-0"
                />
              </label>
              <label className="flex items-center justify-between cursor-pointer">
                <span>Documents & Files</span>
                <input
                  type="checkbox"
                  checked={settings.autoDownloadFiles}
                  onChange={(e) => onChange({ autoDownloadFiles: e.target.checked })}
                  className="rounded text-[#24A1DE] focus:ring-0"
                />
              </label>
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#17212b] border border-[#242f3d] space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Local Cache Storage</span>
                <span className="text-[11px] text-[#7f91a4]">
                  Cached images, stickers, and temporary decrypted attachments
                </span>
              </div>
              <button
                type="button"
                onClick={handleClearCache}
                className="px-3 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>{t.clear_cache}</span>
              </button>
            </div>
            {cacheCleared && (
              <div className="p-2 rounded-lg bg-emerald-500/10 text-emerald-400 text-[11px]">
                {t.cache_cleared}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 4. Language & Region */}
      {category === 'language' && (
        <div className="space-y-4">
          <div className="pb-3 border-b border-[#242f3d]">
            <h3 className="text-sm font-bold text-white">{t.settings_language}</h3>
            <p className="text-[11px] text-[#7f91a4] mt-0.5">
              Select interface language, self-hosted typography, and time formats
            </p>
          </div>

          <div className="space-y-3">
            {/* Language */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Language</span>
                <span className="text-[11px] text-[#7f91a4]">English (LTR) vs فارسی (RTL)</span>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => onChange({ language: 'en', fontFamily: 'Inter' })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                    settings.language === 'en'
                      ? 'bg-[#24A1DE] text-white shadow'
                      : 'bg-[#17212b] text-[#7f91a4] hover:text-white'
                  }`}
                >
                  English
                </button>
                <button
                  type="button"
                  onClick={() => onChange({ language: 'fa', fontFamily: 'Vazirmatn' })}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                    settings.language === 'fa'
                      ? 'bg-emerald-600 text-white shadow'
                      : 'bg-[#17212b] text-[#7f91a4] hover:text-white'
                  }`}
                >
                  فارسی
                </button>
              </div>
            </div>

            {/* Time Format */}
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Time Display Format</span>
                <span className="text-[11px] text-[#7f91a4]">
                  Preview:{' '}
                  {settings.timeFormat === '12h'
                    ? new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
                    : new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
              <select
                value={settings.timeFormat}
                onChange={(e) => onChange({ timeFormat: e.target.value as TimeFormat })}
                className="rounded-lg bg-[#17212b] border border-[#242f3d] px-3 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
              >
                <option value="12h">12-Hour (1:45 PM)</option>
                <option value="24h">24-Hour (13:45)</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* 5. Accessibility */}
      {category === 'accessibility' && (
        <div className="space-y-4">
          <div className="pb-3 border-b border-[#242f3d]">
            <h3 className="text-sm font-bold text-white">{t.settings_accessibility}</h3>
            <p className="text-[11px] text-[#7f91a4] mt-0.5">
              Enhanced contrast, focus rings, and readable layout settings
            </p>
          </div>

          <div className="space-y-3">
            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">{t.high_contrast}</span>
                <span className="text-[11px] text-[#7f91a4]">Sharpen element borders and contrast</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ highContrast: !settings.highContrast })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.highContrast ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.highContrast ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>

            <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
              <div>
                <span className="font-semibold text-white block">Prominent Focus Rings</span>
                <span className="text-[11px] text-[#7f91a4]">Visible outline on keyboard-focused controls</span>
              </div>
              <button
                type="button"
                onClick={() => onChange({ visibleFocus: !settings.visibleFocus })}
                className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
                  settings.visibleFocus ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
                }`}
              >
                <div
                  className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
                    settings.visibleFocus ? 'left-6' : 'left-1'
                  }`}
                />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. About & Diagnostics */}
      {category === 'about' && (
        <div className="space-y-4">
          <div className="pb-3 border-b border-[#242f3d]">
            <h3 className="text-sm font-bold text-white">{t.settings_about}</h3>
            <p className="text-[11px] text-[#7f91a4] mt-0.5">
              Application version, cryptographic standards, and safe diagnostic reports
            </p>
          </div>

          <div className="p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-white text-sm">Senora Desktop / Web</span>
              <span className="px-2 py-0.5 rounded bg-[#24A1DE]/20 text-[#24A1DE] font-mono text-[10px] font-bold">
                v1.0.0
              </span>
            </div>

            <p className="text-[11px] text-[#7f91a4] leading-relaxed">
              High-fidelity secure self-hosted messaging platform with Signal Protocol Double Ratchet, peer-to-peer WebRTC calls, group voice chat, and self-hosted Vazirmatn typography.
            </p>
          </div>

          <div className="p-3.5 rounded-xl bg-[#17212b] border border-[#242f3d] space-y-2">
            <span className="font-semibold text-white block">Browser Hardware Diagnostics</span>
            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="flex items-center justify-between p-2 rounded bg-[#242f3d]/40">
                <span className="text-[#7f91a4]">Web Crypto</span>
                <span className="text-emerald-400 font-semibold">Ready</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-[#242f3d]/40">
                <span className="text-[#7f91a4]">WebRTC Mesh</span>
                <span className="text-emerald-400 font-semibold">Active</span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-[#242f3d]/40">
                <span className="text-[#7f91a4]">setSinkId Audio</span>
                <span className={mediaDeviceManager.isSinkIdSupported() ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
                  {mediaDeviceManager.isSinkIdSupported() ? 'Supported' : 'Fallback'}
                </span>
              </div>
              <div className="flex items-center justify-between p-2 rounded bg-[#242f3d]/40">
                <span className="text-[#7f91a4]">AudioContext</span>
                <span className="text-emerald-400 font-semibold">Ready</span>
              </div>
            </div>
          </div>

          <div className="pt-1">
            <button
              type="button"
              onClick={handleExportDiagnostics}
              className="w-full py-2.5 rounded-xl bg-[#242f3d] hover:bg-[#208fc4] text-xs font-bold text-white flex items-center justify-center gap-2 transition cursor-pointer shadow"
            >
              <Download className="h-4 w-4" />
              <span>Export Safe Diagnostics JSON</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
