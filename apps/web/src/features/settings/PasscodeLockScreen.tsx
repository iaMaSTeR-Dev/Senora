import { uiText, useUILanguage } from "../../app/language";
import React, { useState, useEffect } from 'react';
import { Lock, Delete, LogOut, ShieldAlert } from 'lucide-react';
import { verifyPasscode } from './settingsModel';
import { Language, translations } from '../../app/i18n';

interface PasscodeLockScreenProps {
  storedHash: string;
  onUnlock: () => void;
  onLogout: () => void;
  lang: Language;
}

export const PasscodeLockScreen: React.FC<PasscodeLockScreenProps> = ({
  storedHash,
  onUnlock,
  onLogout,
  lang,
}) => {
  const uiLang = useUILanguage(lang);
  const t = translations[lang];
  const [pin, setPin] = useState('');

  // Read initial attempts and lockout from sessionStorage to prevent bypass via reload
  const getInitialAttempts = (): number => {
    if (typeof window === 'undefined') return 0;
    try {
      const raw = sessionStorage.getItem('senora_lockout_attempts');
      return raw ? parseInt(raw, 10) || 0 : 0;
    } catch {
      return 0;
    }
  };

  const getInitialCooldown = (): number => {
    if (typeof window === 'undefined') return 0;
    try {
      const until = sessionStorage.getItem('senora_lockout_until');
      if (until) {
        const remaining = Math.ceil((parseInt(until, 10) - Date.now()) / 1000);
        return remaining > 0 ? remaining : 0;
      }
    } catch {}
    return 0;
  };

  const [attempts, setAttempts] = useState(getInitialAttempts);
  const [cooldownSeconds, setCooldownSeconds] = useState(getInitialCooldown);
  const [error, setError] = useState<string | null>(() => {
    const cd = getInitialCooldown();
    return cd > 0 ? `Too many failed attempts. Locked for ${cd} seconds.` : null;
  });

  // Handle countdown timer if locked out
  useEffect(() => {
    if (cooldownSeconds <= 0) {
      if (typeof window !== 'undefined') {
        try {
          sessionStorage.removeItem('senora_lockout_until');
        } catch {}
      }
      return;
    }
    const interval = setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setAttempts(0);
          setError(null);
          if (typeof window !== 'undefined') {
            try {
              sessionStorage.removeItem('senora_lockout_until');
              sessionStorage.removeItem('senora_lockout_attempts');
            } catch {}
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldownSeconds]);

  const handleDigit = async (digit: string) => {
    if (cooldownSeconds > 0) return;
    if (pin.length >= 4) return;

    const newPin = pin + digit;
    setPin(newPin);
    setError(null);

    if (newPin.length === 4) {
      const isValid = await verifyPasscode(newPin, storedHash);
      if (isValid) {
        if (typeof window !== 'undefined') {
          try {
            sessionStorage.removeItem('senora_lockout_until');
            sessionStorage.removeItem('senora_lockout_attempts');
          } catch {}
        }
        onUnlock();
      } else {
        const nextAttempts = attempts + 1;
        setAttempts(nextAttempts);
        setPin('');
        if (typeof window !== 'undefined') {
          try {
            sessionStorage.setItem('senora_lockout_attempts', String(nextAttempts));
          } catch {}
        }
        if (nextAttempts >= 5) {
          const lockoutUntil = Date.now() + 30000;
          if (typeof window !== 'undefined') {
            try {
              sessionStorage.setItem('senora_lockout_until', String(lockoutUntil));
            } catch {}
          }
          setCooldownSeconds(30);
          setError(uiText("Too many failed attempts. Locked for 30 seconds.", uiLang));
        } else {
          setError(`Incorrect passcode. (${5 - nextAttempts} attempts left)`);
        }
      }
    }
  };

  const handleBackspace = () => {
    if (cooldownSeconds > 0) return;
    setPin((prev) => prev.slice(0, -1));
    setError(null);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        handleBackspace();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pin, cooldownSeconds, attempts, storedHash]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0e1621] text-white select-none">
      <div className="w-full max-w-xs flex flex-col items-center px-4">
        {/* Lock Icon */}
        <div className="h-16 w-16 rounded-2xl bg-[#17212b] border border-[#242f3d] flex items-center justify-center text-[#24A1DE] mb-5 shadow-xl">
          <Lock className="h-8 w-8" />
        </div>

        <h2 className="text-base font-bold text-white mb-1">{t.passcode_lock}</h2>
        <p className="text-xs text-[#7f91a4] mb-6 text-center">
          {cooldownSeconds > 0
            ? (lang === 'fa' ? `????? ${cooldownSeconds} ????? ??? ????` : `Please wait ${cooldownSeconds}s before retrying`)
            : t.passcode_prompt}
        </p>

        {/* PIN Dots Display */}
        <div className="flex gap-4 mb-6">
          {[0, 1, 2, 3].map((idx) => {
            const isFilled = pin.length > idx;
            return (
              <div
                key={idx}
                className={`h-3.5 w-3.5 rounded-full transition-all duration-200 ${
                  isFilled
                    ? 'bg-[#24A1DE] scale-110 shadow-[0_0_8px_rgba(36,161,222,0.6)]'
                    : 'bg-[#242f3d] border border-[#7f91a4]/30'
                }`}
              />
            );
          })}
        </div>

        {/* Error / Warning Notice */}
        {error && (
          <div className="mb-4 text-center px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-[11px] font-medium flex items-center gap-1.5 animate-shake">
            <ShieldAlert className="h-3.5 w-3.5 flex-shrink-0" />
            <span>{uiText(error, uiLang)}</span>
          </div>
        )}

        {/* Keypad */}
        <div className="grid grid-cols-3 gap-3 w-full max-w-[240px] mb-6">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
            <button
              key={digit}
              type="button"
              disabled={cooldownSeconds > 0}
              onClick={() => handleDigit(digit)}
              className="h-14 rounded-full bg-[#17212b] hover:bg-[#242f3d] active:scale-95 text-lg font-bold text-white transition flex items-center justify-center border border-[#242f3d]/60 disabled:opacity-40 cursor-pointer"
            >
              {digit}
            </button>
          ))}
          <div />
          <button
            type="button"
            disabled={cooldownSeconds > 0}
            onClick={() => handleDigit('0')}
            className="h-14 rounded-full bg-[#17212b] hover:bg-[#242f3d] active:scale-95 text-lg font-bold text-white transition flex items-center justify-center border border-[#242f3d]/60 disabled:opacity-40 cursor-pointer"
          >
            0
          </button>
          <button
            type="button"
            disabled={cooldownSeconds > 0 || pin.length === 0}
            onClick={handleBackspace}
            className="h-14 rounded-full bg-transparent hover:bg-[#242f3d]/40 active:scale-95 text-[#7f91a4] hover:text-white transition flex items-center justify-center disabled:opacity-20 cursor-pointer"
            title={uiText("Delete", uiLang)}
          >
            <Delete className="h-5 w-5" />
          </button>
        </div>

        {/* Logout Option */}
        <button
          type="button"
          onClick={() => {
            if (typeof window !== 'undefined') {
              try {
                sessionStorage.removeItem('senora_lockout_until');
                sessionStorage.removeItem('senora_lockout_attempts');
              } catch {}
            }
            onLogout();
          }}
          className="text-[11px] text-[#7f91a4] hover:text-red-400 flex items-center gap-1.5 transition cursor-pointer"
        >
          <LogOut className="h-3.5 w-3.5" />
          <span>{uiText("Forgot passcode? Log Out", uiLang)}</span>
        </button>
      </div>
    </div>
  );
};
