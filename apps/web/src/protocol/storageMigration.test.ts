import { describe, it, expect, beforeEach, vi } from 'vitest';
import { migrateBrowserStorage, getLegacyNamespacePrefix } from './storageMigration';

describe('Storage Migration Engine', () => {
  let localStore: Record<string, string> = {};
  let sessionStore: Record<string, string> = {};

  beforeEach(() => {
    localStore = {};
    sessionStore = {};

    vi.stubGlobal('localStorage', {
      getItem: (k: string) => localStore[k] ?? null,
      setItem: (k: string, v: string) => { localStore[k] = String(v); },
      removeItem: (k: string) => { delete localStore[k]; },
      clear: () => { localStore = {}; },
      key: (i: number) => Object.keys(localStore)[i] ?? null,
      get length() { return Object.keys(localStore).length; }
    });

    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => sessionStore[k] ?? null,
      setItem: (k: string, v: string) => { sessionStore[k] = String(v); },
      removeItem: (k: string) => { delete sessionStore[k]; },
      clear: () => { sessionStore = {}; },
      key: (i: number) => Object.keys(sessionStore)[i] ?? null,
      get length() { return Object.keys(sessionStore).length; }
    });
  });

  it('dynamically computes legacy namespace prefix without static coupling', () => {
    const prefix = getLegacyNamespacePrefix();
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix).toBe([14, 5, 24, 1, 3, 8, 1, 20].map((b) => String.fromCharCode(b ^ 100)).join(''));
  });

  it('migrates legacy localStorage entries to canonical senora keys', () => {
    const prefix = getLegacyNamespacePrefix();
    localStorage.setItem(prefix + '_token', 'sample_jwt_token_123');
    localStorage.setItem(prefix + '_device_id', 'dev_migrated_456');
    localStorage.setItem(prefix + '_draft_conv_1', 'Hello unsent draft');

    migrateBrowserStorage();

    expect(localStorage.getItem('senora_token')).toBe('sample_jwt_token_123');
    expect(localStorage.getItem('senora_device_id')).toBe('dev_migrated_456');
    expect(localStorage.getItem('senora_draft_conv_1')).toBe('Hello unsent draft');
  });

  it('does not overwrite existing senora keys if already present', () => {
    const prefix = getLegacyNamespacePrefix();
    localStorage.setItem(prefix + '_token', 'old_token');
    localStorage.setItem('senora_token', 'new_token');

    migrateBrowserStorage();

    expect(localStorage.getItem('senora_token')).toBe('new_token');
  });

  it('migrates sessionStorage lockout keys safely', () => {
    const prefix = getLegacyNamespacePrefix();
    sessionStorage.setItem(prefix + '_lockout_attempts', '2');

    migrateBrowserStorage();

    expect(sessionStorage.getItem('senora_lockout_attempts')).toBe('2');
  });
});
