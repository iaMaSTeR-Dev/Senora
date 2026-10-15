import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  resetSettings,
  hashPasscode,
  verifyPasscode,
  syncSettingsFromBackend,
  applySettingsToDOM,
} from './settingsModel';
import { mediaDeviceManager } from '../calls/mediaDeviceManager';

describe('Settings Center & Media Device Manager Unit Tests', () => {
  let mockStorage: Record<string, string> = {};

  beforeEach(() => {
    mockStorage = {};
    const mockLocalStorage = {
      getItem: (key: string) => (key in mockStorage ? mockStorage[key] : null),
      setItem: (key: string, val: string) => {
        mockStorage[key] = val;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        mockStorage = {};
      },
    };

    const mockClassList = {
      classes: new Set<string>(),
      add: (c: string) => mockClassList.classes.add(c),
      remove: (c: string) => mockClassList.classes.delete(c),
      contains: (c: string) => mockClassList.classes.has(c),
    };

    const mockRoot = {
      classList: mockClassList,
      attributes: {} as Record<string, string>,
      setAttribute: (k: string, v: string) => {
        mockRoot.attributes[k] = v;
      },
      getAttribute: (k: string) => mockRoot.attributes[k],
      style: {
        properties: {} as Record<string, string>,
        setProperty: (k: string, v: string) => {
          mockRoot.style.properties[k] = v;
        },
      },
    };

    (globalThis as any).window = {
      localStorage: mockLocalStorage,
      matchMedia: () => ({ matches: true }),
      crypto: globalThis.crypto,
    };
    (globalThis as any).localStorage = mockLocalStorage;
    (globalThis as any).document = {
      documentElement: mockRoot,
    };
  });

  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).localStorage;
    delete (globalThis as any).document;
  });

  describe('Settings Model & Persistence', () => {
    it('should return DEFAULT_SETTINGS when localStorage is empty', () => {
      const s = loadSettings();
      expect(s.theme).toBe('dark');
      expect(s.accentColor).toBe('#24A1DE');
      expect(s.fontSize).toBe('medium');
      expect(s.chatWallpaper).toBe('default');
      expect(s.sendOnEnter).toBe(true);
      expect(s.desktopNotifications).toBe(true);
      expect(s.language).toBe('en');
    });

    it('should save and partially merge updated settings', () => {
      const updated = saveSettings({
        theme: 'light',
        accentColor: '#10b981',
        sendOnEnter: false,
      });

      expect(updated.theme).toBe('light');
      expect(updated.accentColor).toBe('#10b981');
      expect(updated.sendOnEnter).toBe(false);
      // Preserved defaults
      expect(updated.fontSize).toBe('medium');

      const reloaded = loadSettings();
      expect(reloaded.theme).toBe('light');
      expect(reloaded.accentColor).toBe('#10b981');
      expect(reloaded.sendOnEnter).toBe(false);
    });

    it('should hash and verify 4-digit passcode using PBKDF2-HMAC-SHA256 (100k iterations) with random per-passcode salt', async () => {
      const hash1 = await hashPasscode('1234');
      const hash2 = await hashPasscode('1234');
      const hashFixed1 = await hashPasscode('1234', 'custom_salt_123');
      const hashFixed2 = await hashPasscode('1234', 'custom_salt_123');

      // Random salt ensures different hashes for the same PIN (defeating precomputed rainbow tables)
      expect(hash1).not.toBe(hash2);
      expect(hash1).toContain(':');
      expect(hash1.length).toBe(32 + 1 + 64); // 32 hex salt + ':' + 64 hex hash = 97 chars
      expect(hashFixed1).toBe(hashFixed2);

      // Verify validation with random salts
      expect(await verifyPasscode('1234', hash1)).toBe(true);
      expect(await verifyPasscode('1234', hash2)).toBe(true);
      expect(await verifyPasscode('0000', hash1)).toBe(false);
      expect(await verifyPasscode('', hash1)).toBe(false);

      // Verify legacy fallback (raw hash without colon)
      const legacyHash = await hashPasscode('1234', 'nexachat_pbkdf2_pin_salt');
      expect(await verifyPasscode('1234', legacyHash)).toBe(true);
      expect(await verifyPasscode('0000', legacyHash)).toBe(false);
    });

    it('should reset sensitive account settings on resetSettings (user switching defense)', () => {
      saveSettings({
        passcodeLockEnabled: true,
        passcodeHash: 'sample_hash_123',
        lastSeenVisibility: 'nobody',
        profilePhotoVisibility: 'nobody',
      });

      const reset = resetSettings();
      expect(reset.passcodeLockEnabled).toBe(false);
      expect(reset.passcodeHash).toBe('');
      expect(reset.lastSeenVisibility).toBe('everyone');
      expect(reset.profilePhotoVisibility).toBe('everyone');

      const loaded = loadSettings();
      expect(loaded.passcodeLockEnabled).toBe(false);
      expect(loaded.passcodeHash).toBe('');
    });

    it('should apply theme, direction, and accessibility classes to DOM', () => {
      const s = {
        ...DEFAULT_SETTINGS,
        theme: 'light' as const,
        language: 'fa' as const,
        reducedMotion: true,
        highContrast: true,
      };

      applySettingsToDOM(s);
      const root = (globalThis as any).document.documentElement;
      expect(root.classList.contains('light')).toBe(true);
      expect(root.classList.contains('reduce-motion')).toBe(true);
      expect(root.classList.contains('high-contrast')).toBe(true);
      expect(root.getAttribute('dir')).toBe('rtl');
      expect(root.getAttribute('lang')).toBe('fa');
    });

    it('should handle backend sync gracefully with network error', async () => {
      const s = await syncSettingsFromBackend();
      expect(s).toBeDefined();
      expect(s.theme).toBeDefined();
    });
  });

  describe('Media Device Manager', () => {
    it('should provide mediaDeviceManager singleton', () => {
      expect(mediaDeviceManager).toBeDefined();
      expect(typeof mediaDeviceManager.enumerateDevices).toBe('function');
      expect(typeof mediaDeviceManager.isSinkIdSupported).toBe('function');
      expect(typeof mediaDeviceManager.getState).toBe('function');
      expect(typeof mediaDeviceManager.subscribe).toBe('function');
    });

    it('should report sinkId support status as boolean', () => {
      const supported = mediaDeviceManager.isSinkIdSupported();
      expect(typeof supported).toBe('boolean');
    });

    it('should safely manage device selections', () => {
      mediaDeviceManager.setSelectedAudioInputId('dev-mic-1');
      mediaDeviceManager.setSelectedAudioOutputId('dev-speaker-1');
      mediaDeviceManager.setSelectedVideoInputId('dev-cam-1');

      expect(mediaDeviceManager.getSelectedAudioInputId()).toBe('dev-mic-1');
      expect(mediaDeviceManager.getSelectedAudioOutputId()).toBe('dev-speaker-1');
      expect(mediaDeviceManager.getSelectedVideoInputId()).toBe('dev-cam-1');
    });

    it('should handle applyAudioOutput on mock media element without throwing', async () => {
      const mockAudio = {
        setSinkId: vi.fn().mockResolvedValue(undefined),
      } as unknown as HTMLMediaElement;

      const res = await mediaDeviceManager.applyAudioOutput(mockAudio);
      // Even in test environment, call returns safely
      expect(typeof res).toBe('boolean');
    });

    it('should report permission status gracefully', async () => {
      const perms = await mediaDeviceManager.checkPermissions();
      expect(perms).toHaveProperty('audio');
      expect(perms).toHaveProperty('video');
    });
  });
});
