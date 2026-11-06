import React, { useState, useEffect } from 'react';
import { AppSettings, hashPasscode, PrivacyVisibility } from './settingsModel';
import { Device, User } from '../../app/types';
import { api } from '../../protocol/api';
import { Language, translations } from '../../app/i18n';
import {
  Shield,
  Lock,
  Key,
  Smartphone,
  Trash2,
  AlertCircle,
  RefreshCw,
  Download,
  Upload,
  CheckCircle2,
  FileKey
} from 'lucide-react';
import { exportEncryptedKeystore, restoreEncryptedKeystore } from '../../crypto/keystoreBackup';

interface PrivacySettingsProps {
  settings: AppSettings;
  onChange: (partial: Partial<AppSettings>) => void;
  lang: Language;
  currentUser?: User;
  onUpdateUser?: (updated: User) => void;
}

export const PrivacySettings: React.FC<PrivacySettingsProps> = ({
  settings,
  onChange,
  lang,
  currentUser,
  onUpdateUser,
}) => {
  const t = translations[lang];
  const [devices, setDevices] = useState<Device[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  // Account Self-Destruct state
  const [selfDestructMonths, setSelfDestructMonths] = useState<number>(() => {
    return currentUser?.self_destruct_months || 6;
  });
  const [savingSelfDestruct, setSavingSelfDestruct] = useState(false);

  const handleSetSelfDestruct = async (months: number) => {
    setSelfDestructMonths(months);
    setSavingSelfDestruct(true);
    try {
      await api.setSelfDestructMonths(months);
      if (currentUser && onUpdateUser) {
        onUpdateUser({ ...currentUser, self_destruct_months: months });
      }
    } catch (e: any) {
      alert(`خطا در تنظیم دوره حذف حساب: ${e.message || 'Unknown error'}`);
    } finally {
      setSavingSelfDestruct(false);
    }
  };

  // Passcode modal state
  const [showPasscodeModal, setShowPasscodeModal] = useState(false);
  const [passcodeVal, setPasscodeVal] = useState('');
  const [passcodeConfirm, setPasscodeConfirm] = useState('');
  const [passcodeError, setPasscodeError] = useState<string | null>(null);

  // Keystore Backup & Restore state
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [backupMode, setBackupMode] = useState<'export' | 'restore'>('export');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupFileContent, setBackupFileContent] = useState('');
  const [backupFileName, setBackupFileName] = useState('');
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupStatusMsg, setBackupStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const currentDeviceId = typeof window !== 'undefined' ? localStorage.getItem('senora_device_id') : '';

  const loadDevices = async () => {
    setLoadingDevices(true);
    setDeviceError(null);
    try {
      const list = await api.listDevices();
      setDevices(list);
    } catch (e: any) {
      setDeviceError(e.message || 'Failed to load devices');
    } finally {
      setLoadingDevices(false);
    }
  };

  useEffect(() => {
    loadDevices();
  }, []);

  const handleRevokeDevice = async (deviceId: string) => {
    if (deviceId === currentDeviceId) {
      if (!confirm('Revoking your current device will log you out immediately. Proceed?')) {
        return;
      }
    }
    setRevokingId(deviceId);
    try {
      await api.revokeDevice(deviceId);
      setDevices((prev) => prev.filter((d) => d.id !== deviceId));
      if (deviceId === currentDeviceId) {
        window.location.reload();
      }
    } catch (e: any) {
      alert(`Could not revoke device: ${e.message}`);
    } finally {
      setRevokingId(null);
    }
  };

  const handleSavePasscode = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasscodeError(null);
    if (!/^\d{4}$/.test(passcodeVal)) {
      setPasscodeError('Passcode must be exactly 4 digits.');
      return;
    }
    if (passcodeVal !== passcodeConfirm) {
      setPasscodeError('Passcodes do not match.');
      return;
    }
    const hash = await hashPasscode(passcodeVal);
    onChange({ passcodeLockEnabled: true, passcodeHash: hash });
    setShowPasscodeModal(false);
    setPasscodeVal('');
    setPasscodeConfirm('');
  };

  const handleDisablePasscode = () => {
    onChange({ passcodeLockEnabled: false, passcodeHash: '' });
  };

  return (
    <div className="space-y-6 text-xs text-white">
      {/* Header */}
      <div className="pb-3 border-b border-[#242f3d]">
        <h3 className="text-sm font-bold text-white">{t.settings_privacy}</h3>
        <p className="text-[11px] text-[#7f91a4] mt-0.5">
          Manage visibility, local app passcode, active device sessions, and Signal E2EE
        </p>
      </div>

      {/* 1. Visibility Settings */}
      <div className="space-y-4 p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d]">
        <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block">
          Privacy & Visibility
        </span>

        {/* Last Seen */}
        <div className="flex items-center justify-between">
          <div>
            <span className="font-semibold text-white block">Last Seen & Online</span>
            <span className="text-[11px] text-[#7f91a4]">Who can see your online status</span>
          </div>
          <select
            value={settings.lastSeenVisibility}
            onChange={(e) => onChange({ lastSeenVisibility: e.target.value as PrivacyVisibility })}
            className="rounded-lg bg-[#17212b] border border-[#242f3d] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
          >
            <option value="everyone">Everyone</option>
            <option value="contacts">My Contacts</option>
            <option value="nobody">Nobody</option>
          </select>
        </div>

        {/* Profile Photo */}
        <div className="flex items-center justify-between pt-2 border-t border-[#242f3d]/60">
          <div>
            <span className="font-semibold text-white block">Profile Photo</span>
            <span className="text-[11px] text-[#7f91a4]">Who can see your avatar photo</span>
          </div>
          <select
            value={settings.profilePhotoVisibility}
            onChange={(e) =>
              onChange({ profilePhotoVisibility: e.target.value as PrivacyVisibility })
            }
            className="rounded-lg bg-[#17212b] border border-[#242f3d] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
          >
            <option value="everyone">Everyone</option>
            <option value="contacts">My Contacts</option>
            <option value="nobody">Nobody</option>
          </select>
        </div>
      </div>

      {/* Account Self-Destruct on Inactivity */}
      <div className="p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Trash2 className="h-4 w-4 text-rose-400 flex-shrink-0" />
            <div>
              <span className="font-semibold text-white block">{t.self_destruct}</span>
              <span className="text-[11px] text-[#7f91a4]">{t.self_destruct_desc}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {savingSelfDestruct && <span className="text-[10px] text-emerald-400 animate-pulse">ذخیره...</span>}
            <select
              value={selfDestructMonths}
              onChange={(e) => handleSetSelfDestruct(Number(e.target.value))}
              className="rounded-lg bg-[#17212b] border border-[#242f3d] px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE] cursor-pointer"
            >
              <option value={1}>{t.one_month}</option>
              <option value={3}>{t.three_months}</option>
              <option value={6}>{t.six_months}</option>
              <option value={12}>{t.one_year}</option>
            </select>
          </div>
        </div>
      </div>

      {/* 2. Local Passcode Lock */}
      <div className="p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-amber-400" />
            <span className="font-semibold text-white">{t.passcode_lock}</span>
          </div>
          {settings.passcodeLockEnabled ? (
            <button
              type="button"
              onClick={handleDisablePasscode}
              className="px-2.5 py-1 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 text-xs font-semibold transition cursor-pointer"
            >
              {t.turn_off}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setShowPasscodeModal(true)}
              className="px-3 py-1 rounded-lg bg-[#24A1DE] text-white hover:bg-[#208fc4] text-xs font-semibold transition cursor-pointer"
            >
              {t.set_passcode}
            </button>
          )}
        </div>
        <p className="text-[11px] text-[#7f91a4] leading-relaxed">
          {settings.passcodeLockEnabled
            ? 'Local screen lock is enabled (PBKDF2-HMAC-SHA256, 100k iterations). Blocks casual physical access on this browser; does not encrypt local storage at rest.'
            : 'When enabled, locks the app on reload and inactivity until your 4-digit PIN is entered. Protects against casual in-person access on this device.'}
        </p>
      </div>

      {/* 3. Active Devices & Sessions */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-xs font-bold text-white">{t.active_devices}</h4>
            <p className="text-[11px] text-[#7f91a4]">Devices authorized for Signal Protocol E2EE</p>
          </div>
          <button
            type="button"
            onClick={loadDevices}
            disabled={loadingDevices}
            className="text-xs text-[#24A1DE] hover:underline flex items-center gap-1 cursor-pointer"
          >
            <RefreshCw className={`h-3 w-3 ${loadingDevices ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        {deviceError && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs flex items-center gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{deviceError}</span>
          </div>
        )}

        <div className="space-y-2">
          {devices.map((dev) => {
            const isCurrent = dev.id === currentDeviceId;
            return (
              <div
                key={dev.id}
                className={`p-3 rounded-xl border flex items-center justify-between transition ${
                  isCurrent
                    ? 'bg-[#242f3d]/80 border-[#24A1DE]/40'
                    : 'bg-[#242f3d]/30 border-[#242f3d] hover:bg-[#242f3d]/60'
                }`}
              >
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-lg bg-[#17212b] border border-[#242f3d] flex items-center justify-center text-[#24A1DE]">
                    <Smartphone className="h-4 w-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-white">
                        {dev.device_name || 'Browser Client'}
                      </span>
                      {isCurrent && (
                        <span className="px-1.5 py-0.2 rounded-full bg-[#24A1DE]/20 text-[#24A1DE] text-[10px] font-bold">
                          Current
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-[#7f91a4]">
                      Last seen: {new Date(dev.last_seen_at).toLocaleDateString()}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleRevokeDevice(dev.id)}
                  disabled={revokingId === dev.id}
                  className="px-2.5 py-1 rounded-lg bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 text-[11px] font-medium flex items-center gap-1 transition cursor-pointer disabled:opacity-50"
                  title="Revoke session"
                >
                  <Trash2 className="h-3 w-3" />
                  <span>{revokingId === dev.id ? 'Revoking...' : t.revoke}</span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 4. Encrypted Keystore Backup & Restore */}
      <div className="p-4 rounded-xl bg-[#17212b] border border-[#242f3d] space-y-3 text-left">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[#24A1DE] font-bold text-xs uppercase tracking-wider">
            <FileKey className="h-4 w-4" />
            <span>{lang === 'fa' ? 'پشتیبان‌گیری رمزنگاری‌شده کلیدها' : 'Encrypted Keystore Backup'}</span>
          </div>
          <span className="text-[10px] font-mono text-[#7f91a4] bg-[#242f3d] px-2 py-0.5 rounded-full">
            AES-256-GCM + PBKDF2
          </span>
        </div>
        <p className="text-[11px] text-[#7f91a4] leading-relaxed">
          {lang === 'fa'
            ? 'می‌توانید کلیدهای احراز هویت Signal Protocol، کلیدهای پیش‌فرض (PreKeys) و نشست‌های رمزنگاری دوطرفه خود را با رمز عبور قوی به فایل .senorakeys صادر کرده یا در دستگاه دیگر بازیابی کنید.'
            : 'Export or restore your Signal Double Ratchet identity keys, prekeys, and sessions protected with PBKDF2 (100,000 rounds) and AES-256-GCM (.senorakeys).'}
        </p>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => {
              setBackupMode('export');
              setBackupPassword('');
              setBackupStatusMsg(null);
              setShowBackupModal(true);
            }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-white text-xs font-semibold shadow transition cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            <span>{lang === 'fa' ? 'استخراج نسخه پشتیبان (.senorakeys)' : 'Export Backup (.senorakeys)'}</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setBackupMode('restore');
              setBackupPassword('');
              setBackupFileContent('');
              setBackupFileName('');
              setBackupStatusMsg(null);
              setShowBackupModal(true);
            }}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#242f3d] hover:bg-[#2b3a4a] text-white text-xs font-semibold border border-[#324252] transition cursor-pointer"
          >
            <Upload className="h-3.5 w-3.5 text-emerald-400" />
            <span>{lang === 'fa' ? 'بازیابی از فایل پشتیبان' : 'Restore from Backup'}</span>
          </button>
        </div>
      </div>

      {/* 5. Signal E2EE Architecture Info */}
      <div className="p-4 rounded-xl bg-[#17212b] border border-[#242f3d] space-y-2.5 text-left">
        <div className="flex items-center gap-2 text-emerald-400 font-bold text-xs uppercase tracking-wider">
          <Shield className="h-4 w-4" />
          <span>Signal Protocol Double Ratchet</span>
        </div>
        <p className="text-[11px] text-[#7f91a4] leading-relaxed">
          Senora uses Double Ratchet session evolution, X3DH prekeys, and AES-256-GCM authenticated encryption. Private keys remain strictly within your device's IndexedDB.
        </p>
        <div className="p-2.5 rounded-lg bg-[#0e1621] border border-[#242f3d] flex items-center justify-between">
          <span className="text-[#7f91a4] text-[10px]">Local Device ID:</span>
          <code className="font-mono text-[#24A1DE] text-[11px] truncate max-w-[200px]">
            {currentDeviceId || 'Unknown'}
          </code>
        </div>
      </div>

      {/* Passcode Modal Overlay */}
      {showPasscodeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 animate-fade-in">
          <form
            onSubmit={handleSavePasscode}
            className="w-full max-w-xs rounded-2xl bg-[#17212b] border border-[#242f3d] p-5 space-y-4 shadow-2xl text-center"
          >
            <div className="h-10 w-10 rounded-full mx-auto flex items-center justify-center bg-amber-500/20 text-amber-400">
              <Key className="h-5 w-5" />
            </div>
            <h4 className="text-sm font-bold text-white">{t.set_passcode}</h4>
            <p className="text-[11px] text-[#7f91a4]">{t.passcode_prompt}</p>

            {passcodeError && (
              <div className="p-2 rounded-lg bg-red-500/10 text-red-400 text-[11px]">
                {passcodeError}
              </div>
            )}

            <div className="space-y-2">
              <input
                type="password"
                maxLength={4}
                value={passcodeVal}
                onChange={(e) => setPasscodeVal(e.target.value)}
                placeholder="4-digit PIN"
                className="w-full text-center tracking-widest text-lg font-mono rounded-xl bg-[#242f3d] px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
              />
              <input
                type="password"
                maxLength={4}
                value={passcodeConfirm}
                onChange={(e) => setPasscodeConfirm(e.target.value)}
                placeholder="Confirm PIN"
                className="w-full text-center tracking-widest text-lg font-mono rounded-xl bg-[#242f3d] px-3 py-2 text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
              />
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowPasscodeModal(false)}
                className="flex-1 py-2 rounded-xl bg-[#242f3d] hover:bg-[#2b3a4a] text-xs font-semibold text-[#7f91a4]"
              >
                {t.cancel}
              </button>
              <button
                type="submit"
                className="flex-1 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white shadow"
              >
                {t.save}
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Keystore Backup & Restore Modal */}
      {showBackupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-fadeIn">
          <div className="w-full max-w-sm rounded-3xl bg-[#17212b] border border-[#242f3d] p-6 space-y-4 shadow-2xl text-left">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-white font-bold text-sm">
                <FileKey className="h-5 w-5 text-[#24A1DE]" />
                <span>
                  {backupMode === 'export'
                    ? (lang === 'fa' ? 'استخراج کلیدهای رمزنگاری' : 'Export Keystore Backup')
                    : (lang === 'fa' ? 'بازیابی کلیدهای رمزنگاری' : 'Restore Keystore Backup')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowBackupModal(false)}
                className="text-[#7f91a4] hover:text-white p-1 rounded-full"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-[#7f91a4] leading-relaxed">
              {backupMode === 'export'
                ? (lang === 'fa'
                  ? 'یک رمز عبور قوی برای محافظت از کلیدهای استخراج‌شده وارد کنید. بدون این رمز، بازگردانی نسخه پشتیبان امکان‌پذیر نخواهد بود.'
                  : 'Enter a strong password to encrypt your exported keys. You will need this password to restore your keystore on another device.')
                : (lang === 'fa'
                  ? 'فایل .senorakeys را انتخاب کرده و رمزی که هنگام استخراج تعیین کرده بودید را وارد کنید.'
                  : 'Select your .senorakeys file and enter the password you created when exporting the backup.')}
            </p>

            {backupStatusMsg && (
              <div
                className={`p-3 rounded-xl text-xs flex items-center gap-2 ${
                  backupStatusMsg.type === 'success'
                    ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                    : 'bg-rose-500/10 border border-rose-500/30 text-rose-400'
                }`}
              >
                {backupStatusMsg.type === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
                ) : (
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                )}
                <span>{backupStatusMsg.text}</span>
              </div>
            )}

            {backupMode === 'restore' && (
              <div className="space-y-1.5">
                <label className="text-[11px] font-semibold text-[#7f91a4]">
                  {lang === 'fa' ? 'انتخاب فایل پشتیبان (.senorakeys)' : 'Backup File (.senorakeys)'}
                </label>
                <input
                  type="file"
                  accept=".senorakeys,.json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setBackupFileName(file.name);
                      const reader = new FileReader();
                      reader.onload = (event) => {
                        setBackupFileContent((event.target?.result as string) || '');
                      };
                      reader.readAsText(file);
                    }
                  }}
                  className="w-full text-xs text-[#7f91a4] file:mr-3 file:py-1.5 file:px-3 file:rounded-xl file:border-0 file:text-xs file:font-semibold file:bg-[#242f3d] file:text-white hover:file:bg-[#2b3a4a] cursor-pointer"
                />
                {backupFileName && (
                  <span className="text-[10px] text-emerald-400 font-mono">✓ {backupFileName}</span>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-[11px] font-semibold text-[#7f91a4]">
                {lang === 'fa' ? 'رمز عبور پشتیبان' : 'Backup Password'}
              </label>
              <input
                type="password"
                value={backupPassword}
                onChange={(e) => setBackupPassword(e.target.value)}
                placeholder={lang === 'fa' ? 'حداقل ۸ نویسه...' : 'Min 8 characters...'}
                className="w-full px-3 py-2 bg-[#242f3d] border border-[#324252] rounded-xl text-xs text-white placeholder-[#7f91a4] focus:outline-none focus:border-[#24A1DE]"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowBackupModal(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
              >
                {lang === 'fa' ? 'انصراف' : 'Cancel'}
              </button>

              <button
                type="button"
                disabled={
                  backupLoading ||
                  !backupPassword ||
                  backupPassword.length < 6 ||
                  (backupMode === 'restore' && !backupFileContent)
                }
                onClick={async () => {
                  setBackupLoading(true);
                  setBackupStatusMsg(null);
                  try {
                    const uId = currentUser?.id || 'default_user';
                    if (backupMode === 'export') {
                      const backupStr = await exportEncryptedKeystore(uId, backupPassword);
                      const blob = new Blob([backupStr], { type: 'application/json' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `senora-backup-${currentUser?.username || 'user'}-${new Date().toISOString().slice(0, 10)}.senorakeys`;
                      document.body.appendChild(a);
                      a.click();
                      document.body.removeChild(a);
                      URL.revokeObjectURL(url);
                      setBackupStatusMsg({
                        type: 'success',
                        text: lang === 'fa' ? 'فایل پشتیبان رمزنگاری‌شده با موفقیت دانلود شد' : 'Encrypted backup downloaded successfully',
                      });
                    } else {
                      const res = await restoreEncryptedKeystore(uId, backupFileContent, backupPassword);
                      setBackupStatusMsg({
                        type: 'success',
                        text: lang === 'fa' ? `بازیابی با موفقیت انجام شد (${res.itemsRestored} کلید/نشست بازگردانده شد)` : `Restored successfully (${res.itemsRestored} items restored)`,
                      });
                    }
                  } catch (err: any) {
                    setBackupStatusMsg({
                      type: 'error',
                      text: err.message || 'Operation failed',
                    });
                  } finally {
                    setBackupLoading(false);
                  }
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] disabled:opacity-50 text-white text-xs font-bold shadow transition cursor-pointer"
              >
                {backupLoading ? (
                  <span>{lang === 'fa' ? 'در حال پردازش...' : 'Processing...'}</span>
                ) : backupMode === 'export' ? (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    <span>{lang === 'fa' ? 'استخراج و دانلود' : 'Export & Download'}</span>
                  </>
                ) : (
                  <>
                    <Upload className="h-3.5 w-3.5" />
                    <span>{lang === 'fa' ? 'رمزگشایی و بازیابی' : 'Decrypt & Restore'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
