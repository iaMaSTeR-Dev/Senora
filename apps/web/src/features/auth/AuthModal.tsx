import React, { useState } from 'react';
import { api } from '../../protocol/api';
import { cryptoEngine } from '../../crypto/clientCrypto';
import { AuthSession } from '../../app/types';
import { translations, Language } from '../../app/i18n';
import { Shield, Sparkles, Server, Clock, RefreshCw, ArrowLeft } from 'lucide-react';
import { ServerSelectionModal } from '../servers/ServerSelectionModal';
import { serverManager } from '../../protocol/serverManager';

interface AuthModalProps {
  onSuccess: (session: AuthSession) => void;
  lang: Language;
}

export const AuthModal: React.FC<AuthModalProps> = ({ onSuccess, lang }) => {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [deviceName] = useState('Web Client');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showServerModal, setShowServerModal] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<{ username: string; displayName?: string } | null>(null);
  const [checkingApproval, setCheckingApproval] = useState(false);

  const t = translations[lang];

  const handleCheckStatus = async () => {
    if (!pendingApproval) return;
    setCheckingApproval(true);
    setError(null);
    try {
      const session = await api.login({
        username: pendingApproval.username,
        password,
        device_name: deviceName,
      });

      if (session.token) {
        try {
          const keyPair = await cryptoEngine.getOrCreateDeviceKeyPair();
          if (session.device_id) {
            await api.registerKeys(session.device_id, keyPair.publicKeyBase64);
          }
        } catch (cryptoErr) {
          console.warn('Failed to register device crypto keys:', cryptoErr);
        }
        onSuccess(session);
      }
    } catch (err: any) {
      if (err?.code === 'ACCOUNT_PENDING_APPROVAL' || err?.message?.includes('تایید') || err?.message?.includes('pending')) {
        setError('حساب شما هنوز توسط مدیر سرور تایید نشده است. لطفاً شکیبا باشید.');
      } else {
        setError(err?.message || 'خطا در ورود مجدد');
      }
    } finally {
      setCheckingApproval(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      let session: AuthSession;
      if (isRegister) {
        session = await api.register({
          username,
          display_name: displayName || username,
          password,
          device_name: deviceName,
        });

        if (session.status === 'PENDING_APPROVAL') {
          setPendingApproval({ username, displayName: displayName || username });
          return;
        }
      } else {
        session = await api.login({
          username,
          password,
          device_name: deviceName,
        });
      }

      // Generate device identity key pair and publish to server for E2EE
      try {
        const keyPair = await cryptoEngine.getOrCreateDeviceKeyPair();
        if (session.device_id) {
          await api.registerKeys(session.device_id, keyPair.publicKeyBase64);
        }
      } catch (cryptoErr) {
        console.warn('Failed to register device crypto keys:', cryptoErr);
      }

      onSuccess(session);
    } catch (err: any) {
      if (err?.code === 'ACCOUNT_PENDING_APPROVAL' || err?.message?.includes('تایید') || err?.message?.includes('pending')) {
        setPendingApproval({ username, displayName: displayName || username });
      } else {
        setError(err?.message || 'Authentication failed');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-4 overflow-y-auto">
      <div className="w-full max-w-md my-auto rounded-2xl bg-[#17212b] p-6 sm:p-8 shadow-2xl border border-[#242f3d] animate-fade-in text-white">
        <div className="flex flex-col items-center mb-4 text-center">
          <div className="h-16 w-16 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#3ca9e2] flex items-center justify-center shadow-lg shadow-[#24A1DE]/20 mb-3">
            <Shield className="h-8 w-8 text-white" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">{t.app_title}</h2>
          <p className="text-xs text-[#7f91a4] mt-1">{t.subtitle}</p>
        </div>

        {/* Server Network Bar */}
        <div className="flex items-center justify-between p-2.5 rounded-xl bg-[#242f3d]/60 border border-[#242f3d] mb-4 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0" />
            <span className="text-[#7f91a4] shrink-0">Server:</span>
            <span className="font-semibold text-white truncate max-w-[150px]">{serverManager.getActiveServer().name}</span>
          </div>
          <button
            type="button"
            onClick={() => setShowServerModal(true)}
            className="flex items-center gap-1 text-[#24A1DE] hover:text-[#3ca9e2] font-semibold transition cursor-pointer shrink-0 ml-2"
          >
            <Server className="h-3 w-3" />
            <span>Change</span>
          </button>
        </div>

        {pendingApproval ? (
          <div className="space-y-4 animate-fade-in text-center py-2">
            <div className="relative mx-auto w-20 h-20 flex items-center justify-center">
              <div className="absolute inset-0 rounded-full bg-amber-500/20 animate-ping" />
              <div className="h-16 w-16 rounded-full bg-gradient-to-tr from-amber-500 to-orange-400 flex items-center justify-center shadow-lg shadow-amber-500/30">
                <Clock className="h-8 w-8 text-white" />
              </div>
            </div>

            <div>
              <h3 className="text-lg font-bold text-white">در انتظار تایید مدیر سرور</h3>
              <p className="text-xs text-[#7f91a4] mt-1.5 leading-relaxed">
                درخواست ثبت‌نام شما با موفقیت ثبت شد و برای مدیر سرور ارسال گردید. پس از بررسی و تایید می‌توانید وارد شوید.
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#242f3d]/70 border border-[#242f3d] text-right space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#7f91a4]">حساب کاربری:</span>
                <span className="font-semibold text-white">@{pendingApproval.username}</span>
              </div>
              {pendingApproval.displayName && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#7f91a4]">نام نمایشی:</span>
                  <span className="text-white">{pendingApproval.displayName}</span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs">
                <span className="text-[#7f91a4]">وضعیت:</span>
                <span className="text-amber-400 font-medium flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                  در انتظار تایید مالک سرور
                </span>
              </div>
            </div>

            {error && (
              <div className="p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-xs text-center">
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleCheckStatus}
              disabled={checkingApproval}
              className="w-full rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] py-3 text-sm font-semibold text-white shadow-lg shadow-[#24A1DE]/25 transition duration-150 ease-in-out disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer mt-2"
            >
              <RefreshCw className={`h-4 w-4 ${checkingApproval ? 'animate-spin' : ''}`} />
              {checkingApproval ? 'در حال بررسی وضعیت...' : 'بررسی مجدد وضعیت تایید'}
            </button>

            <button
              type="button"
              onClick={() => {
                setPendingApproval(null);
                setError(null);
              }}
              className="w-full py-2 text-xs text-[#7f91a4] hover:text-white transition flex items-center justify-center gap-1.5 cursor-pointer"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              بازگشت به فرم ورود
            </button>
          </div>
        ) : (
          <>
            {error && (
              <div className="mb-4 p-3 rounded-lg bg-red-500/15 border border-red-500/30 text-red-400 text-xs text-center">
                {error}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {isRegister && (
                <div>
                  <label className="block text-xs font-medium text-[#7f91a4] mb-1">
                    {t.display_name}
                  </label>
                  <div className="relative">
                    <input
                      type="text"
                      required
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="w-full rounded-xl bg-[#242f3d] px-4 py-2.5 text-sm text-white placeholder-[#7f91a4] focus:outline-none focus:ring-2 focus:ring-[#24A1DE]"
                      placeholder="e.g. Alice Wonderland"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-[#7f91a4] mb-1">
                  {t.username}
                </label>
                <div className="relative">
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full rounded-xl bg-[#242f3d] px-4 py-2.5 text-sm text-white placeholder-[#7f91a4] focus:outline-none focus:ring-2 focus:ring-[#24A1DE]"
                    placeholder="alice"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[#7f91a4] mb-1">
                  {t.password}
                </label>
                <div className="relative">
                  <input
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-xl bg-[#242f3d] px-4 py-2.5 text-sm text-white placeholder-[#7f91a4] focus:outline-none focus:ring-2 focus:ring-[#24A1DE]"
                    placeholder="••••••••"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] py-3 text-sm font-semibold text-white shadow-lg shadow-[#24A1DE]/25 transition duration-150 ease-in-out disabled:opacity-50 mt-2 flex items-center justify-center gap-2"
              >
                {loading ? (
                  <span className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    {isRegister ? t.register : t.login}
                  </>
                )}
              </button>
            </form>

            <div className="mt-6 text-center text-xs text-[#7f91a4]">
              {isRegister ? t.have_account : t.need_account}{' '}
              <button
                type="button"
                onClick={() => {
                  setIsRegister(!isRegister);
                  setError(null);
                }}
                className="text-[#24A1DE] font-semibold hover:underline"
              >
                {isRegister ? t.login : t.register}
              </button>
            </div>
          </>
        )}
      </div>

      {showServerModal && (
        <ServerSelectionModal
          isOpen={showServerModal}
          onClose={() => setShowServerModal(false)}
          onServerSwitched={() => {
            setShowServerModal(false);
            window.location.reload();
          }}
        />
      )}
    </div>
  );
};
