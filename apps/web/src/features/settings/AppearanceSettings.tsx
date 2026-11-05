import React from 'react';
import {
  AppSettings,
  ACCENT_COLORS,
  WALLPAPERS,
  ThemeOption,
  FontSizeOption,
  WallpaperOption,
  BubbleStyle
} from './settingsModel';
import { Language, translations } from '../../app/i18n';
import { Moon, Sun, Monitor, Check } from 'lucide-react';

interface AppearanceSettingsProps {
  settings: AppSettings;
  onChange: (partial: Partial<AppSettings>) => void;
  lang: Language;
}

export const AppearanceSettings: React.FC<AppearanceSettingsProps> = ({
  settings,
  onChange,
  lang,
}) => {
  const t = translations[lang];

  return (
    <div className="space-y-6 text-xs text-white">
      {/* Header */}
      <div className="pb-3 border-b border-[#242f3d]">
        <h3 className="text-sm font-bold text-white">{t.settings_appearance}</h3>
        <p className="text-[11px] text-[#7f91a4] mt-0.5">
          Customize themes, colors, message bubbles, wallpapers, and typography
        </p>
      </div>

      {/* 1. Theme Selection */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-slate-300">Theme Mode</label>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { id: 'dark', label: t.theme_dark, icon: Moon },
              { id: 'light', label: t.theme_light, icon: Sun },
              { id: 'system', label: 'System', icon: Monitor },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const isSelected = settings.theme === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onChange({ theme: item.id as ThemeOption })}
                className={`p-3 rounded-xl border flex flex-col items-center gap-2 transition cursor-pointer ${
                  isSelected
                    ? 'bg-[#24A1DE]/20 border-[#24A1DE] text-white shadow-md'
                    : 'bg-[#242f3d]/40 border-[#242f3d] text-[#7f91a4] hover:text-white hover:bg-[#242f3d]/70'
                }`}
              >
                <Icon className={`h-5 w-5 ${isSelected ? 'text-[#24A1DE]' : ''}`} />
                <span className="font-semibold text-xs">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Accent Color Palette */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-slate-300">{t.accent_color}</label>
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {ACCENT_COLORS.map((c) => {
            const isSelected = settings.accentColor.toLowerCase() === c.hex.toLowerCase();
            return (
              <button
                key={c.hex}
                type="button"
                onClick={() => onChange({ accentColor: c.hex })}
                className={`p-2.5 rounded-xl border flex flex-col items-center gap-1.5 transition cursor-pointer ${
                  isSelected
                    ? 'border-white bg-[#242f3d] shadow-lg'
                    : 'border-[#242f3d] bg-[#242f3d]/30 hover:bg-[#242f3d]/60'
                }`}
                title={c.name}
              >
                <div
                  className="h-6 w-6 rounded-full flex items-center justify-center shadow-inner"
                  style={{ backgroundColor: c.hex }}
                >
                  {isSelected && <Check className="h-3.5 w-3.5 text-white" />}
                </div>
                <span className="text-[10px] text-[#7f91a4] truncate max-w-full">{c.name}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. Message Font Size */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-slate-300">{t.chat_font_size}</label>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { id: 'small', label: 'Small (13px)', desc: 'Compact' },
              { id: 'medium', label: 'Medium (15px)', desc: 'Standard' },
              { id: 'large', label: 'Large (17px)', desc: 'Spacious' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => onChange({ fontSize: f.id as FontSizeOption })}
              className={`p-3 rounded-xl border text-center transition cursor-pointer ${
                settings.fontSize === f.id
                  ? 'bg-[#24A1DE]/20 border-[#24A1DE] text-white shadow'
                  : 'bg-[#242f3d]/40 border-[#242f3d] text-[#7f91a4] hover:text-white'
              }`}
            >
              <div className="font-semibold text-xs">{f.label}</div>
              <div className="text-[10px] text-[#7f91a4] mt-0.5">{f.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 4. Chat Bubble Style */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-slate-300">Message Bubble Style</label>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { id: 'modern', label: 'Modern Rounded', desc: 'Curved 18px corners' },
              { id: 'classic', label: 'Classic Compact', desc: 'Subtle 8px corners' },
            ] as const
          ).map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => onChange({ bubbleStyle: b.id as BubbleStyle })}
              className={`p-3 rounded-xl border text-center transition cursor-pointer ${
                settings.bubbleStyle === b.id
                  ? 'bg-[#24A1DE]/20 border-[#24A1DE] text-white shadow'
                  : 'bg-[#242f3d]/40 border-[#242f3d] text-[#7f91a4] hover:text-white'
              }`}
            >
              <div className="font-semibold text-xs">{b.label}</div>
              <div className="text-[10px] text-[#7f91a4] mt-0.5">{b.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* 5. Chat Wallpaper */}
      <div className="space-y-2">
        <label className="block text-xs font-semibold text-slate-300">{t.wallpaper}</label>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {WALLPAPERS.map((w) => {
            const isSelected = settings.chatWallpaper === w.id;
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => onChange({ chatWallpaper: w.id as WallpaperOption })}
                className={`p-2 rounded-xl border flex flex-col items-center gap-2 transition cursor-pointer ${
                  isSelected
                    ? 'border-[#24A1DE] bg-[#242f3d]/80 shadow'
                    : 'border-[#242f3d] bg-[#242f3d]/30 hover:bg-[#242f3d]/60'
                }`}
              >
                <div
                  className={`w-full h-14 rounded-lg ${w.previewClass} border border-white/10 flex items-center justify-center`}
                >
                  {isSelected && <Check className="h-4 w-4 text-white drop-shadow" />}
                </div>
                <span className="text-[10px] font-medium text-[#7f91a4] truncate max-w-full">
                  {w.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 6. Reduced Motion Toggle */}
      <div className="p-3.5 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] flex items-center justify-between">
        <div>
          <span className="font-semibold text-white block">{t.reduced_motion}</span>
          <span className="text-[11px] text-[#7f91a4]">
            Disable heavy transitions and smooth scroll effects
          </span>
        </div>
        <button
          type="button"
          onClick={() => onChange({ reducedMotion: !settings.reducedMotion })}
          className={`w-11 h-6 rounded-full transition-colors relative cursor-pointer ${
            settings.reducedMotion ? 'bg-[#24A1DE]' : 'bg-[#17212b]'
          }`}
        >
          <div
            className={`w-4 h-4 rounded-full bg-white transition-transform absolute top-1 ${
              settings.reducedMotion ? 'left-6' : 'left-1'
            }`}
          />
        </button>
      </div>

      {/* 7. Live Preview Card */}
      <div className="p-4 rounded-xl bg-[#17212b] border border-[#242f3d] space-y-3 select-none">
        <span className="text-[11px] font-bold text-[#7f91a4] uppercase tracking-wider block">
          Live Chat Appearance Preview
        </span>

        <div
          className={`p-4 rounded-xl border border-white/5 space-y-3 ${
            WALLPAPERS.find((w) => w.id === settings.chatWallpaper)?.previewClass || 'bg-[#0e1621]'
          }`}
        >
          {/* Incoming Bubble */}
          <div className="flex justify-start">
            <div
              className={`max-w-[75%] p-3 text-white bg-[#242f3d] shadow-md ${
                settings.bubbleStyle === 'modern' ? 'rounded-2xl rounded-bl-sm' : 'rounded-lg'
              }`}
              style={{
                fontSize:
                  settings.fontSize === 'small'
                    ? '13px'
                    : settings.fontSize === 'large'
                    ? '17px'
                    : '15px',
              }}
            >
              <div className="text-[11px] font-bold text-[#24A1DE] mb-0.5">Alice</div>
              <p className="leading-snug">Hello! How do you like this chat styling?</p>
              <span className="text-[10px] text-[#7f91a4] block text-right mt-1">10:42 AM</span>
            </div>
          </div>

          {/* Outgoing Bubble */}
          <div className="flex justify-end">
            <div
              className={`max-w-[75%] p-3 text-white shadow-md ${
                settings.bubbleStyle === 'modern' ? 'rounded-2xl rounded-br-sm' : 'rounded-lg'
              }`}
              style={{
                backgroundColor: settings.accentColor,
                fontSize:
                  settings.fontSize === 'small'
                    ? '13px'
                    : settings.fontSize === 'large'
                    ? '17px'
                    : '15px',
              }}
            >
              <p className="leading-snug">It looks gorgeous! The live preview is working perfectly.</p>
              <span className="text-[10px] text-white/70 block text-right mt-1">10:43 AM ✓✓</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
