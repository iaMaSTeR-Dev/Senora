import React, { useState, useEffect } from 'react';
import { Conversation, User, AuthSession } from './types';
import { api } from '../protocol/api';
import { wsManager } from '../protocol/ws';
import { cryptoEngine } from '../crypto/clientCrypto';
import { signalManager } from '../crypto/signalManager';
import { Sidebar } from '../features/conversations/Sidebar';
import { ChatView } from '../features/messages/ChatView';
import { AuthModal } from '../features/auth/AuthModal';
import { SettingsModal, SettingsTab } from '../features/settings/SettingsModal';
import { loadSettings, applySettingsToDOM, syncSettingsFromBackend, resetSettings } from '../features/settings/settingsModel';
import { PasscodeLockScreen } from '../features/settings/PasscodeLockScreen';
import { soundManager } from '../features/calls/soundManager';
import { Language, translations } from './i18n';
import { Shield } from 'lucide-react';

export const App: React.FC = () => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [lang, setLang] = useState<Language>('en');
  const [loading, setLoading] = useState(true);
  const [settingsModalTab, setSettingsModalTab] = useState<SettingsTab | null>(null);
  const [appSettings, setAppSettings] = useState(() => loadSettings());
  const [isLocked, setIsLocked] = useState(() => {
    const s = loadSettings();
    return !!(s.passcodeLockEnabled && s.passcodeHash);
  });

  // Dynamic Invite Join Handling (/join/:code)
  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(() => {
    if (typeof window !== 'undefined' && window.location.pathname.startsWith('/join/')) {
      const code = window.location.pathname.replace(/^\/join\//, '').trim();
      return code || null;
    }
    return null;
  });
  const [invitePreview, setInvitePreview] = useState<{
    invite_code: string;
    conversation_id: string;
    title: string;
    type: string;
    avatar_url: string;
    description: string;
    participant_count: number;
    expires_at?: string;
  } | null>(null);
  const [loadingInvitePreview, setLoadingInvitePreview] = useState(false);
  const [joiningInvite, setJoiningInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Initialize settings from model on mount
  useEffect(() => {
    const s = loadSettings();
    applySettingsToDOM(s);
    if (s.theme === 'light') setTheme('light');
    if (s.language === 'fa') setLang('fa');
  }, []);

  // Set document direction and theme classes
  useEffect(() => {
    document.documentElement.setAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', lang);
  }, [lang]);

  useEffect(() => {
    if (theme === 'light') {
      document.documentElement.classList.add('light');
    } else {
      document.documentElement.classList.remove('light');
    }
  }, [theme]);

  // Attempt session restoration on mount
  useEffect(() => {
    const token = api.getToken();
    if (token) {
      api.getMe()
        .then(async (user) => {
          setCurrentUser(user);
          wsManager.connect(token);
          const deviceId = localStorage.getItem('senora_device_id') || 'dev_' + Date.now();
          localStorage.setItem('senora_device_id', deviceId);

          // Synchronize remote settings
          syncSettingsFromBackend().then((s) => {
            applySettingsToDOM(s);
            if (s.theme === 'light') setTheme('light');
            if (s.language === 'fa') setLang('fa');
          });

          // Initialize Signal Protocol Manager with IndexedDB store
          try {
            await signalManager.initialize(user.id, deviceId, token);
          } catch (err) {
            console.warn('Signal protocol init warning on restore:', err);
          }

          // Register device keypair scoped to user and device
          try {
            const kp = await cryptoEngine.getOrCreateDeviceKeyPair(user.id, deviceId);
            await api.registerKeys(deviceId, kp.publicKeyBase64);
          } catch (err) {
            console.warn('Auto key registration on restore:', err);
          }
        })
        .catch(() => {
          api.setToken(null);
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  // Fetch conversations when user is logged in
  const loadConversations = () => {
    if (currentUser) {
      api.listConversations()
        .then((res) => {
          setConversations(res.conversations);
          setActiveConversation((prevActive) => {
            if (!prevActive) return null;
            const updated = res.conversations.find((c) => c.id === prevActive.id);
            return updated || prevActive;
          });
        })
        .catch((e) => console.error('Failed to list conversations:', e));
    }
  };

  useEffect(() => {
    if (currentUser) {
      loadConversations();
      const interval = setInterval(loadConversations, 5000);
      return () => clearInterval(interval);
    }
  }, [currentUser]);

  // Subscribe to real-time events over WebSocket
  useEffect(() => {
    const unsubscribe = wsManager.subscribe((event) => {
      if (
        event.type === 'message.created' ||
        event.type === 'message.updated' ||
        event.type === 'message.deleted' ||
        event.type === 'message.pinned' ||
        event.type === 'conversation.created' ||
        event.type === 'conversation.read'
      ) {
        loadConversations();

        if (event.type === 'message.created') {
          const rawMsg = event.payload;
          if (rawMsg && rawMsg.sender_id !== currentUser?.id) {
            let isMuted = false;
            try {
              const muted = JSON.parse(localStorage.getItem('senora_muted_convs') || '[]');
              isMuted = Array.isArray(muted) && muted.includes(rawMsg.conversation_id);
            } catch {}

            // Play notification chime if sound enabled and not muted
            if (!isMuted && appSettings.notificationSound !== false) {
              soundManager.playMessageNotification();
            }

            // Desktop browser notification if backgrounded
            if (
              !isMuted &&
              appSettings.desktopNotifications !== false &&
              typeof window !== 'undefined' &&
              'Notification' in window &&
              Notification.permission === 'granted' &&
              (document.hidden || activeConversation?.id !== rawMsg.conversation_id)
            ) {
              try {
                const notif = new Notification('Senora', {
                  body: 'New message received',
                  icon: '/favicon.ico',
                  tag: `msg-${rawMsg.id || rawMsg.conversation_id}`,
                });
                notif.onclick = () => {
                  window.focus();
                };
              } catch (e) {
                console.warn('Browser notification error:', e);
              }
            }
          }
        }
      }
    });
    return unsubscribe;
  }, [currentUser, activeConversation?.id, appSettings]);

  // Load Invite Preview if URL has /join/:code
  useEffect(() => {
    if (pendingInviteCode && currentUser) {
      setLoadingInvitePreview(true);
      setInviteError(null);
      api.getInvitePreview(pendingInviteCode)
        .then((preview) => {
          setInvitePreview(preview);
        })
        .catch((err) => {
          setInviteError(err.message || 'Invalid or expired invite link');
        })
        .finally(() => setLoadingInvitePreview(false));
    }
  }, [pendingInviteCode, currentUser]);

  const handleJoinInvite = async () => {
    if (!pendingInviteCode) return;
    setJoiningInvite(true);
    try {
      const conv = await api.joinConversationInvite(pendingInviteCode);
      setConversations((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
      setActiveConversation(conv);
      setPendingInviteCode(null);
      setInvitePreview(null);
      window.history.replaceState({}, '', '/');
    } catch (err: any) {
      setInviteError(err.message || 'Failed to join via invite');
    } finally {
      setJoiningInvite(false);
    }
  };

  const handleDismissInvite = () => {
    setPendingInviteCode(null);
    setInvitePreview(null);
    setInviteError(null);
    window.history.replaceState({}, '', '/');
  };

  const handleAuthSuccess = async (session: AuthSession) => {
    localStorage.setItem('senora_device_id', session.device_id);
    setCurrentUser(session.user);
    wsManager.connect(session.token);

    try {
      await signalManager.initialize(session.user.id, session.device_id, session.token);
      const kp = await cryptoEngine.getOrCreateDeviceKeyPair(session.user.id, session.device_id);
      await api.registerKeys(session.device_id, kp.publicKeyBase64);
    } catch (e) {
      console.warn('Signal manager init error on login:', e);
    }

    loadConversations();
  };

  const handleLogout = async () => {
    await api.logout();
    wsManager.disconnect();
    cryptoEngine.resetCache();
    localStorage.removeItem('senora_device_id');
    resetSettings();
    setAppSettings(loadSettings());
    setIsLocked(false);
    setCurrentUser(null);
    setActiveConversation(null);
    setConversations([]);
  };

  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0e1621] text-white">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 border-2 border-[#24A1DE] border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-[#7f91a4]">Initializing Senora...</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <AuthModal onSuccess={handleAuthSuccess} lang={lang} />;
  }

  if (isLocked && appSettings.passcodeLockEnabled && appSettings.passcodeHash) {
    return (
      <PasscodeLockScreen
        storedHash={appSettings.passcodeHash}
        onUnlock={() => setIsLocked(false)}
        onLogout={handleLogout}
        lang={lang}
      />
    );
  }

  const t = translations[lang];

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0e1621] text-white">
      {/* Sidebar (Always visible on desktop, hidden when chat active on mobile) */}
      <div className={`${activeConversation ? 'hidden md:flex' : 'flex'} w-full md:w-auto h-full`}>
        <Sidebar
          currentUser={currentUser}
          conversations={conversations}
          activeConversation={activeConversation}
          onSelectConversation={(conv) => {
            setActiveConversation(conv);
            setConversations((prev) =>
              prev.map((c) => (c.id === conv.id ? { ...c, unread_count: 0 } : c))
            );
          }}
          onConversationCreated={(conv) => {
            setConversations((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
          }}
          onOpenSettings={(tab) => setSettingsModalTab((tab as SettingsTab) || 'profile')}
          onLogout={handleLogout}
          lang={lang}
          onToggleLang={() => setLang(lang === 'en' ? 'fa' : 'en')}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      </div>

      {/* Main Chat Panel */}
      <main className={`flex-1 h-full min-w-0 ${!activeConversation ? 'hidden md:flex' : 'flex'} flex-col`}>
        {activeConversation ? (
          <ChatView
            conversation={activeConversation}
            currentUser={currentUser}
            onBack={() => setActiveConversation(null)}
            onSelectConversation={(conv) => setActiveConversation(conv)}
            lang={lang}
          />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-6 text-center bg-[#0e1621] select-none">
            <div className="h-20 w-20 rounded-full bg-[#17212b] border border-[#242f3d] flex items-center justify-center mb-4 text-[#24A1DE] shadow-xl">
              <Shield className="h-10 w-10" />
            </div>
            <h2 className="text-lg font-bold text-white mb-1">{t.select_chat}</h2>
            <p className="text-xs text-[#7f91a4] max-w-sm leading-relaxed">
              {t.e2ee_desc}
            </p>
          </div>
        )}
      </main>

      {/* Invite Join Modal */}
      {pendingInviteCode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-fade-in">
          <div className="w-full max-w-sm rounded-2xl bg-[#17212b] p-6 shadow-2xl border border-[#242f3d] text-center flex flex-col items-center">
            <div className="h-16 w-16 rounded-full bg-gradient-to-tr from-[#24A1DE] to-indigo-500 flex items-center justify-center font-bold text-2xl text-white shadow-lg mb-3">
              {invitePreview?.type === 'channel' ? '📢' : '👥'}
            </div>
            {loadingInvitePreview ? (
              <div className="py-6 text-xs text-[#7f91a4] flex items-center gap-2">
                <div className="h-4 w-4 border-2 border-[#24A1DE] border-t-transparent rounded-full animate-spin" />
                <span>Checking invite link...</span>
              </div>
            ) : inviteError ? (
              <div className="space-y-3 my-2 w-full">
                <p className="text-xs text-red-400 bg-red-500/10 p-3 rounded-xl border border-red-500/20">{inviteError}</p>
                <button
                  type="button"
                  onClick={handleDismissInvite}
                  className="w-full py-2 rounded-xl bg-[#242f3d] hover:bg-[#2c3846] text-xs font-bold text-white transition cursor-pointer"
                >
                  Close
                </button>
              </div>
            ) : invitePreview ? (
              <div className="space-y-4 my-2 w-full">
                <div>
                  <h3 className="text-base font-bold text-white">{invitePreview.title}</h3>
                  <p className="text-xs text-[#7f91a4] mt-0.5 capitalize">
                    {invitePreview.type} • {invitePreview.participant_count} {invitePreview.type === 'channel' ? 'subscribers' : 'members'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDismissInvite}
                    className="flex-1 py-2 rounded-xl bg-[#242f3d] hover:bg-[#2c3846] text-xs font-bold text-white transition cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={joiningInvite}
                    onClick={handleJoinInvite}
                    className="flex-1 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition cursor-pointer disabled:opacity-50"
                  >
                    {joiningInvite ? 'Joining...' : `Join ${invitePreview.type === 'channel' ? 'Channel' : 'Group'}`}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Settings Modal */}
      {settingsModalTab && (
        <SettingsModal
          currentUser={currentUser}
          onClose={() => {
            setSettingsModalTab(null);
            setAppSettings(loadSettings());
          }}
          onUpdateUser={(updated) => setCurrentUser(updated)}
          lang={lang}
          onToggleLang={() => setLang(lang === 'en' ? 'fa' : 'en')}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          initialTab={settingsModalTab}
        />
      )}
    </div>
  );
};
