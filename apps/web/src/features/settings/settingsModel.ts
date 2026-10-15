// Typed Settings Model & Persistence Engine for NexaChat
// Inspired by Telegram Desktop & Web Settings Architecture

export type ThemeOption = 'dark' | 'light' | 'system';
export type FontSizeOption = 'small' | 'medium' | 'large';
export type WallpaperOption = 'default' | 'stars' | 'matrix' | 'gradient' | 'solid';
export type PrivacyVisibility = 'everyone' | 'contacts' | 'nobody';
export type TimeFormat = '12h' | '24h';
export type BubbleStyle = 'modern' | 'classic';

export interface AppSettings {
  // Appearance
  theme: ThemeOption;
  accentColor: string;
  fontSize: FontSizeOption;
  chatWallpaper: WallpaperOption;
  reducedMotion: boolean;

  // Notifications & Sounds
  desktopNotifications: boolean;
  notificationSound: boolean;
  messagePreview: boolean;
  muteAll: boolean;

  // Privacy & Security
  lastSeenVisibility: PrivacyVisibility;
  profilePhotoVisibility: PrivacyVisibility;
  passcodeLockEnabled: boolean;
  passcodeHash: string;

  // Data & Storage
  autoDownloadPhotos: boolean;
  autoDownloadVideos: boolean;
  autoDownloadFiles: boolean;
  lowDataMode: boolean;

  // Language & Region
  language: 'en' | 'fa';
  fontFamily: 'Inter' | 'Vazirmatn';
  timeFormat: TimeFormat;

  // Chats & Messaging
  sendOnEnter: boolean;
  autoplayGifs: boolean;
  autoplayStickers: boolean;
  linkPreviews: boolean;
  bubbleStyle: BubbleStyle;

  // Accessibility
  highContrast: boolean;
  visibleFocus: boolean;
  largeTouchTargets: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'dark',
  accentColor: '#24A1DE',
  fontSize: 'medium',
  chatWallpaper: 'default',
  reducedMotion: false,

  desktopNotifications: true,
  notificationSound: true,
  messagePreview: true,
  muteAll: false,

  lastSeenVisibility: 'everyone',
  profilePhotoVisibility: 'everyone',
  passcodeLockEnabled: false,
  passcodeHash: '',

  autoDownloadPhotos: true,
  autoDownloadVideos: true,
  autoDownloadFiles: false,
  lowDataMode: false,

  language: 'en',
  fontFamily: 'Inter',
  timeFormat: '12h',

  sendOnEnter: true,
  autoplayGifs: true,
  autoplayStickers: true,
  linkPreviews: true,
  bubbleStyle: 'modern',

  highContrast: false,
  visibleFocus: false,
  largeTouchTargets: false,
};

const SETTINGS_STORAGE_KEY = 'nexachat_app_settings';

export const ACCENT_COLORS = [
  { name: 'Telegram Blue', hex: '#24A1DE' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Crimson', hex: '#ef4444' },
  { name: 'Rose', hex: '#ec4899' },
];

export const WALLPAPERS: { id: WallpaperOption; label: string; previewClass: string }[] = [
  { id: 'default', label: 'Default Charcoal', previewClass: 'bg-[#0e1621]' },
  { id: 'stars', label: 'Starfield Night', previewClass: 'bg-radial from-[#1e293b] via-[#0f172a] to-[#020617]' },
  { id: 'matrix', label: 'Deep Cyan', previewClass: 'bg-gradient-to-br from-[#042f2e] to-[#0f172a]' },
  { id: 'gradient', label: 'Midnight Blue', previewClass: 'bg-gradient-to-tr from-[#172554] via-[#0f172a] to-[#1e1b4b]' },
  { id: 'solid', label: 'Dark Slate', previewClass: 'bg-[#18222d]' },
];

import { api } from '../../protocol/api';

// Load settings with fallback to defaults
export function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    console.warn('[SettingsModel] Failed to load settings from localStorage:', e);
    return DEFAULT_SETTINGS;
  }
}

// Save partial or full settings
export function saveSettings(partial: Partial<AppSettings>): AppSettings {
  const current = loadSettings();
  const updated: AppSettings = { ...current, ...partial };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(updated));
    applySettingsToDOM(updated);
    if (typeof window !== 'undefined' && localStorage.getItem('nexachat_token')) {
      const backendPayload: Record<string, any> = { ...partial };
      delete backendPayload.passcodeHash;
      api.setUserPreferences(backendPayload).catch((err) => {
        console.warn('[SettingsModel] Backend preferences sync error:', err);
      });
    }
  } catch (e) {
    console.error('[SettingsModel] Failed to save settings to localStorage:', e);
  }
  return updated;
}

// Sync settings from backend upon authentication
export async function syncSettingsFromBackend(): Promise<AppSettings> {
  const current = loadSettings();
  if (typeof window === 'undefined' || !localStorage.getItem('nexachat_token')) {
    return current;
  }
  try {
    const remote = await api.getUserPreferences();
    if (remote && typeof remote === 'object') {
      const merged: AppSettings = { ...current, ...remote };
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
      applySettingsToDOM(merged);
      return merged;
    }
  } catch (e) {
    console.warn('[SettingsModel] Failed to sync settings from backend:', e);
  }
  return current;
}

// Reset all settings to defaults
export function resetSettings(): AppSettings {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
    applySettingsToDOM(DEFAULT_SETTINGS);
    if (typeof window !== 'undefined' && localStorage.getItem('nexachat_token')) {
      api.setUserPreferences(DEFAULT_SETTINGS).catch(() => {});
    }
  } catch (e) {}
  return DEFAULT_SETTINGS;
}

// Generate a cryptographically random 16-byte hex salt
export function generateRandomSalt(): string {
  const cryptoObj = typeof window !== 'undefined' && window.crypto ? window.crypto : globalThis.crypto;
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Compute PBKDF2-HMAC-SHA256 hash (100,000 iterations) of passcode with a salt
// If customSalt is omitted, a random 16-byte salt is generated and returned as "saltHex:hashHex"
export async function hashPasscode(passcode: string, customSalt?: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoObj = typeof window !== 'undefined' && window.crypto ? window.crypto : globalThis.crypto;
  const actualSalt = customSalt !== undefined ? customSalt : generateRandomSalt();
  const keyMaterial = await cryptoObj.subtle.importKey(
    'raw',
    enc.encode(passcode),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const derivedBits = await cryptoObj.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: enc.encode(actualSalt),
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const hashArray = Array.from(new Uint8Array(derivedBits));
  const rawHash = hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  return customSalt !== undefined ? rawHash : `${actualSalt}:${rawHash}`;
}

// Verify entered passcode against stored PBKDF2 hash (supporting "saltHex:hashHex" or legacy raw hash)
export async function verifyPasscode(enteredPin: string, storedHash: string): Promise<boolean> {
  if (!enteredPin || !storedHash) return false;
  if (storedHash.includes(':')) {
    const [saltHex, expectedHash] = storedHash.split(':');
    const computed = await hashPasscode(enteredPin, saltHex);
    return computed === expectedHash;
  }
  // Legacy fallback for pre-existing static salt hashes
  const legacyHash = await hashPasscode(enteredPin, 'nexachat_pbkdf2_pin_salt');
  return legacyHash === storedHash;
}

// Apply settings directly to HTML document elements
export function applySettingsToDOM(settings: AppSettings): void {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  // 1. Theme
  if (settings.theme === 'light') {
    root.classList.add('light');
  } else if (settings.theme === 'dark') {
    root.classList.remove('light');
  } else {
    // System
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      root.classList.remove('light');
    } else {
      root.classList.add('light');
    }
  }

  // 2. Language & Direction
  root.setAttribute('dir', settings.language === 'fa' ? 'rtl' : 'ltr');
  root.setAttribute('lang', settings.language);

  // 3. Accent Color CSS Variable
  root.style.setProperty('--accent-color', settings.accentColor);

  // 4. Font Size
  const fontSizes = {
    small: '13px',
    medium: '15px',
    large: '17px',
  };
  root.style.setProperty('--chat-font-size', fontSizes[settings.fontSize] || '15px');

  // 5. Reduced Motion
  if (settings.reducedMotion) {
    root.classList.add('reduce-motion');
  } else {
    root.classList.remove('reduce-motion');
  }

  // 6. High Contrast
  if (settings.highContrast) {
    root.classList.add('high-contrast');
  } else {
    root.classList.remove('high-contrast');
  }
}
