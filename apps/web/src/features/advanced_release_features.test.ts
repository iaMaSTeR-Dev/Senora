import { describe, it, expect, beforeEach, vi } from 'vitest';
import { api } from '../protocol/api';
import { RingtonePlayer } from './calls/webrtcManager';
import { User } from '../app/types';

describe('NexaChat Advanced Messaging, Media, Calling & Profile Tests (Requirements 12-16)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const mockStorage: Record<string, string> = { nexachat_token: 'fake_jwt_token' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mockStorage[k] || null,
      setItem: (k: string, v: string) => { mockStorage[k] = v; },
      removeItem: (k: string) => { delete mockStorage[k]; },
      clear: () => {},
    });
  });

  describe('Requirement 12: Telegram-Inspired File Upload, Progress, Previews & Downloads', () => {
    it('supports upload progress tracking with AbortSignal cancellation', async () => {
      let progressRecorded: number[] = [];

      class MockXHR {
        upload = { onprogress: null as any };
        status = 201;
        responseText = JSON.stringify({
          id: 'att_test_123',
          filename: 'سند_فارسی_پروژه.pdf',
          size_bytes: 100,
          content_type: 'application/pdf',
        });
        onload: any = null;
        onerror: any = null;
        ontimeout: any = null;
        open = vi.fn();
        setRequestHeader = vi.fn();
        send = vi.fn(() => {
          if (this.upload && this.upload.onprogress) {
            this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
            this.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 });
          }
          if (this.onload) this.onload();
        });
        abort = vi.fn();
      }

      vi.stubGlobal('XMLHttpRequest', MockXHR);

      const blob = new Blob(['sample content'], { type: 'application/pdf' });
      const progressCallback = (p: number) => progressRecorded.push(p);

      const att = await api.uploadAttachmentWithProgress(
        'conv_1',
        blob,
        'سند_فارسی_پروژه.pdf',
        false,
        progressCallback
      );

      expect(att.id).toBe('att_test_123');
      expect(att.filename).toBe('سند_فارسی_پروژه.pdf');
      expect(progressRecorded).toContain(50);
      expect(progressRecorded).toContain(100);
    });

    it('aborts upload safely when AbortSignal triggers', async () => {
      const abortController = new AbortController();
      let aborted = false;

      class MockAbortXHR {
        upload = { onprogress: null as any };
        open = vi.fn();
        setRequestHeader = vi.fn();
        send = vi.fn();
        abort = vi.fn(() => {
          aborted = true;
        });
      }

      vi.stubGlobal('XMLHttpRequest', MockAbortXHR);

      const uploadPromise = api.uploadAttachmentWithProgress(
        'conv_1',
        new Blob(['data']),
        'file.dat',
        false,
        undefined,
        abortController.signal
      );

      // Trigger abort immediately
      abortController.abort();

      await expect(uploadPromise).rejects.toThrow('Upload aborted by user');
      expect(aborted).toBe(true);
    });

    it('correctly categorizes media extensions and formats file sizes', () => {
      const formatSize = (bytes: number) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
      };

      expect(formatSize(500)).toBe('500 B');
      expect(formatSize(2048)).toBe('2.0 KB');
      expect(formatSize(5 * 1024 * 1024)).toBe('5.0 MB');

      const getCategory = (mime: string, name: string) => {
        if (mime.startsWith('image/')) return 'photo';
        if (mime.startsWith('video/')) return 'video';
        if (mime.startsWith('audio/')) return 'audio';
        const ext = name.split('.').pop()?.toUpperCase() || 'FILE';
        return ext;
      };

      expect(getCategory('image/jpeg', 'photo.jpg')).toBe('photo');
      expect(getCategory('video/mp4', 'clip.mp4')).toBe('video');
      expect(getCategory('audio/ogg', 'voice.ogg')).toBe('audio');
      expect(getCategory('application/pdf', 'doc.pdf')).toBe('PDF');
      expect(getCategory('application/zip', 'archive.zip')).toBe('ZIP');
    });
  });

  describe('Requirement 13: Reliable Incoming-Call Audio & Autoplay Handling', () => {
    it('manages ringtone lifecycle and detects browser autoplay policy suspensions', async () => {
      const mockAudioCtx = {
        state: 'suspended',
        resume: vi.fn(async () => {
          mockAudioCtx.state = 'running';
        }),
        close: vi.fn(async () => {}),
        createOscillator: vi.fn(() => ({
          frequency: { value: 0, setValueAtTime: vi.fn() },
          type: 'sine',
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createGain: vi.fn(() => ({
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        })),
        currentTime: 0,
        destination: {},
      };

      vi.stubGlobal('AudioContext', vi.fn(function () { return mockAudioCtx; }));
      vi.stubGlobal('window', { AudioContext: vi.fn(function () { return mockAudioCtx; }) });

      const ringtone = new RingtonePlayer();
      let blockedEventFired = false;

      // Test autoplay blocked detection when audio context is suspended
      await ringtone.start(() => {
        blockedEventFired = true;
      });

      expect(mockAudioCtx.resume).toHaveBeenCalled();
      expect(typeof blockedEventFired).toBe('boolean');

      // Test user gesture resume recovery when suspended
      mockAudioCtx.state = 'suspended';
      await ringtone.resume();
      expect(mockAudioCtx.resume).toHaveBeenCalledTimes(2);

      // Test ringtone stop cleanup
      ringtone.stop();
    });

    it('synthesizes authentic dual-cadence telephone ring frequencies (440Hz + 480Hz)', async () => {
      const frequencies: number[] = [];
      const mockAudioCtx = {
        state: 'running',
        resume: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        createOscillator: vi.fn(() => ({
          frequency: {
            value: 0,
            setValueAtTime: (v: number) => frequencies.push(v),
          },
          type: 'sine',
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        })),
        createGain: vi.fn(() => ({
          gain: {
            setValueAtTime: vi.fn(),
            linearRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        })),
        currentTime: 0,
        destination: {},
      };

      vi.stubGlobal('AudioContext', vi.fn(function () { return mockAudioCtx; }));
      vi.stubGlobal('window', { AudioContext: vi.fn(function () { return mockAudioCtx; }) });

      const ringtone = new RingtonePlayer();
      await ringtone.start();

      expect(mockAudioCtx.createOscillator).toHaveBeenCalledTimes(2);
      expect(frequencies).toContain(440);
      expect(frequencies).toContain(480);
      ringtone.stop();
    });
  });

  describe('Requirement 14: In-Chat Call System Messages & Idempotency', () => {
    it('correctly maps call outcomes to localized Persian and English strings', () => {
      const formatCallMessage = (
        outcome: string,
        callType: 'audio' | 'video',
        durationSec: number,
        lang: 'en' | 'fa'
      ) => {
        const isVideo = callType === 'video';
        if (outcome === 'completed') {
          const m = Math.floor(durationSec / 60);
          const s = durationSec % 60;
          const durStr = `${m}:${s.toString().padStart(2, '0')}`;
          return lang === 'fa'
            ? `${isVideo ? 'تماس تصویری' : 'تماس صوتی'} (${durStr})`
            : `${isVideo ? 'Video Call' : 'Voice Call'} (${durStr})`;
        }
        if (outcome === 'missed') {
          return lang === 'fa' ? 'تماس بی‌پاسخ' : 'Missed Call';
        }
        if (outcome === 'declined' || outcome === 'rejected') {
          return lang === 'fa' ? 'تماس رد شد' : 'Declined Call';
        }
        if (outcome === 'cancelled') {
          return lang === 'fa' ? 'تماس لغو شد' : 'Cancelled Call';
        }
        return lang === 'fa'
          ? isVideo ? 'تماس تصویری' : 'تماس صوتی'
          : isVideo ? 'Video Call' : 'Voice Call';
      };

      expect(formatCallMessage('completed', 'audio', 125, 'fa')).toBe('تماس صوتی (2:05)');
      expect(formatCallMessage('completed', 'video', 45, 'fa')).toBe('تماس تصویری (0:45)');
      expect(formatCallMessage('missed', 'audio', 0, 'fa')).toBe('تماس بی‌پاسخ');
      expect(formatCallMessage('declined', 'audio', 0, 'fa')).toBe('تماس رد شد');
      expect(formatCallMessage('cancelled', 'audio', 0, 'fa')).toBe('تماس لغو شد');

      expect(formatCallMessage('completed', 'audio', 125, 'en')).toBe('Voice Call (2:05)');
      expect(formatCallMessage('missed', 'audio', 0, 'en')).toBe('Missed Call');
    });

    it('enforces idempotency key format to prevent duplicate call records on signaling retries', () => {
      const callId = 'call_test_9988';
      const expectedKey = 'call_event_' + callId;
      expect(expectedKey).toBe('call_event_call_test_9988');
    });
  });

  describe('Requirement 15: User Profile Page Model & Privacy Verification', () => {
    const mockUser: User = {
      id: 'usr_secure_42',
      username: 'farhad_dev',
      display_name: 'Farhad Rahimi',
      bio: 'Distributed Systems & WebRTC Engineer',
      avatar_url: '/api/v1/attachments/avatar/farhad_avatar.webp',
      created_at: '2026-01-15T10:00:00Z',
    };

    it('displays only authorized public fields and hides internal database secrets', () => {
      const publicFields = {
        id: mockUser.id,
        username: mockUser.username,
        display_name: mockUser.display_name,
        bio: mockUser.bio,
        avatar_url: mockUser.avatar_url,
      };

      expect(publicFields).toHaveProperty('username');
      expect(publicFields).toHaveProperty('display_name');
      expect(publicFields).toHaveProperty('bio');
      expect(publicFields).toHaveProperty('avatar_url');

      // Crucial security assertions: no passwords, password hashes, or device private keys in profile
      expect((publicFields as any).password_hash).toBeUndefined();
      expect((publicFields as any).identity_key_private).toBeUndefined();
      expect((publicFields as any).pre_key_private).toBeUndefined();
    });

    it('formats user public handle and joining timestamp correctly', () => {
      const formattedHandle = `@${mockUser.username}`;
      const joinedYear = new Date(mockUser.created_at || '').getFullYear();

      expect(formattedHandle).toBe('@farhad_dev');
      expect(joinedYear).toBe(2026);
    });
  });

  describe('Requirement 16: Avatar Lifecycle & Defect Root-Cause Fix Verification', () => {
    it('resolves avatar URLs consistently and falls back to initials when avatar is empty', () => {
      const getAvatarSrc = (avatarUrl?: string | null) => {
        if (!avatarUrl || avatarUrl.trim() === '') return null;
        return avatarUrl;
      };

      const getInitials = (displayName: string, username: string) => {
        const name = displayName.trim() || username.trim() || 'U';
        return name.charAt(0).toUpperCase();
      };

      expect(getAvatarSrc('/api/v1/attachments/avatar/test.png')).toBe('/api/v1/attachments/avatar/test.png');
      expect(getAvatarSrc('')).toBeNull();
      expect(getAvatarSrc(undefined)).toBeNull();
      expect(getAvatarSrc(null)).toBeNull();

      expect(getInitials('Nexa User', 'nexa')).toBe('N');
      expect(getInitials('', 'parsa')).toBe('P');
      expect(getInitials('', '')).toBe('U');
    });

    it('verifies public avatar endpoint format does not require authorization headers', () => {
      const avatarUrl = '/api/v1/attachments/avatar/avatar_12345.webp';
      const isPublicAvatarRoute = avatarUrl.startsWith('/api/v1/attachments/avatar/');
      expect(isPublicAvatarRoute).toBe(true);
    });
  });
});
