import React, { useState } from 'react';
import { api } from '../../protocol/api';
import { cryptoEngine } from '../../crypto/clientCrypto';
import { AuthSession } from '../../app/types';
import { translations, Language } from '../../app/i18n';
import { Shield, Sparkles } from 'lucide-react';

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

  const t = translations[lang];

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
        await api.registerKeys(session.device_id, keyPair.publicKeyBase64);
      } catch (cryptoErr) {
        console.warn('Failed to register device crypto keys:', cryptoErr);
      }

      onSuccess(session);
    } catch (err: any) {
      setError(err?.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-[#17212b] p-8 shadow-2xl border border-[#242f3d] animate-fade-in text-white">
        <div className="flex flex-col items-center mb-6 text-center">
          <div className="h-16 w-16 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#3ca9e2] flex items-center justify-center shadow-lg shadow-[#24A1DE]/20 mb-3">
            <Shield className="h-8 w-8 text-white" />
          </div>
          <h2 className="text-2xl font-bold tracking-tight">{t.app_title}</h2>
          <p className="text-xs text-[#7f91a4] mt-1">{t.subtitle}</p>
        </div>

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
      </div>
    </div>
  );
};
