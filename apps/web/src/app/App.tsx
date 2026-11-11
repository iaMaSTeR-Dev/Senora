import { uiText, useUILanguage } from "./language";
import React, { useState, useEffect, useRef } from 'react';
import { Conversation, User, AuthSession } from './types';
import { api } from '../protocol/api';
import { wsManager } from '../protocol/ws';
import { cryptoEngine } from '../crypto/clientCrypto';
import { signalManager } from '../crypto/signalManager';
import { Sidebar } from '../features/conversations/Sidebar';
import { ChatView } from '../features/messages/ChatView';
import { AuthModal } from '../features/auth/AuthModal';
import { SettingsModal, SettingsTab } from '../features/settings/SettingsModal';
import { loadSettings, saveSettings, applySettingsToDOM, syncSettingsFromBackend, resetSettings } from '../features/settings/settingsModel';
import { PasscodeLockScreen } from '../features/settings/PasscodeLockScreen';
import { soundManager } from '../features/calls/soundManager';
import { webrtcManager, CallSession } from '../features/calls/webrtcManager';
import { CallModal } from '../features/calls/CallModal';
import { buildNotificationData } from '../features/messages/notificationHelper';
import { MessageNotificationGate } from '../features/messages/notificationGate';
import { InAppNotificationBanner, InAppNotification } from '../components/InAppNotificationBanner';
import { StickerPackModal } from '../features/messages/StickerPackModal';
import { Language, translations } from './i18n';
import { Shield } from 'lucide-react';
import { StandaloneWebPlayer } from '../features/messages/StandaloneWebPlayer';
import { LanguageContext } from './language';

export const App: React.FC = () => {
  const [lang, setLang] = useState<Language>(() => loadSettings().language);
  return <LanguageContext.Provider value={lang}><AppContent lang={lang} setLang={setLang} /></LanguageContext.Provider>;
};

const AppContent: React.FC<{ lang: Language; setLang: (language: Language) => void }> = ({ lang, setLang }) => {
  const notificationGate = useRef(new MessageNotificationGate());
  const uiLang = useUILanguage(lang);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [loading, setLoading] = useState(true);
  const [settingsModalTab, setSettingsModalTab] = useState<SettingsTab | null>(null);
  const [appSettings, setAppSettings] = useState(() => loadSettings());
  const [isLocked, setIsLocked] = useState(() => {
    const s = loadSettings();
    return !!(s.passcodeLockEnabled && s.passcodeHash);
  });
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const [inAppNotif, setInAppNotif] = useState<InAppNotification | null>(null);

  // Standalone Web Player (/watch/:id) & Direct Stream Redirect (/s/:id)
  const [standaloneWatchId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      if (window.location.pathname.startsWith('/s/')) {
        const sid = window.location.pathname.replace(/^\/s\//, '');
        window.location.replace('/api/v1/s/' + sid + window.location.search);
        return null;
      }
      if (window.location.pathname.startsWith('/watch/')) {
        const wid = window.location.pathname.replace(/^\/watch\//, '').split('/')[0].trim();
        return wid || null;
      }
    }
    return null;
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

  // Shared Sticker Pack Link Handling (?pack=:codeOrId)
  const [pendingStickerPackCode, setPendingStickerPackCode] = useState<string | null>(() => {
    if (typeof window !== 'undefined' && window.location.search) {
      const params = new URLSearchParams(window.location.search);
      return params.get('pack') || null;
    }
    return null;
  });

  // Initialize settings and Service Worker from model on mount
  useEffect(() => {
    const s = loadSettings();
    applySettingsToDOM(s);
    if (s.theme === 'light') setTheme('light');
    setLang(s.language);

    // Register Service Worker for PWA & push notifications
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator && process.env.NODE_ENV !== 'test') {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('Service worker registration failed:', err);
      });
    }
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

  // Synchronize App Badge & Document Title with unread messages count
  useEffect(() => {
    const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    if (typeof navigator !== 'undefined' && 'setAppBadge' in navigator) {
      if (totalUnread > 0) {
        (navigator as any).setAppBadge(totalUnread).catch(() => {});
      } else {
        (navigator as any).clearAppBadge().catch(() => {});
      }
    }
    document.title = totalUnread > 0 ? `(${totalUnread}) SENORA` : 'SENORA — Secure Self-Hosted Messaging';
  }, [conversations]);

  // Global Desktop Keyboard Shortcuts (Alt+Up/Down for chat switching, Ctrl+F for search, Esc)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      // Escape: Close modals
      if (e.key === 'Escape') {
        if (settingsModalTab) setSettingsModalTab(null);
        if (pendingStickerPackCode) setPendingStickerPackCode(null);
      }
      // Alt + ArrowUp / ArrowDown: Switch active conversation
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        if (conversations.length > 0) {
          const currentIdx = activeConversation ? conversations.findIndex((c) => c.id === activeConversation.id) : -1;
          let nextIdx = 0;
          if (e.key === 'ArrowDown') {
            nextIdx = currentIdx < conversations.length - 1 ? currentIdx + 1 : 0;
          } else {
            nextIdx = currentIdx > 0 ? currentIdx - 1 : conversations.length - 1;
          }
          setActiveConversation(conversations[nextIdx]);
        }
      }
      // Ctrl + F or Cmd + F: Focus search input
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        const searchInput = document.querySelector<HTMLInputElement>('input[placeholder*="Search"], input[placeholder*="جستجو"]');
        if (searchInput) {
          e.preventDefault();
          searchInput.focus();
          searchInput.select();
        }
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [conversations, activeConversation, settingsModalTab, pendingStickerPackCode]);

  // Attempt session restoration on mount
  useEffect(() => {
    const token = api.getToken();
    if (token) {
      api.getMe()
        .then(async (user) => {
          setCurrentUser(user);
          wsManager.connect(token);
          webrtcManager.init();
          webrtcManager.setUserId(user.id);
          const deviceId = localStorage.getItem('senora_device_id') || 'dev_' + Date.now();
          localStorage.setItem('senora_device_id', deviceId);

          // Synchronize remote settings
          syncSettingsFromBackend().then((s) => {
            applySettingsToDOM(s);
            if (s.theme === 'light') setTheme('light');
            setLang(s.language);
          });

          // Initialize Signal Protocol Manager with IndexedDB store
          try {
            await signalManager.initialize(user.id, deviceId, token);
          } catch (err) {
            console.warn('Signal protocol init warning on restore:', err);
          }


        })
        .catch((err) => {
          if (err?.status === 401 || err?.message?.includes('401') || err?.message?.includes('Unauthorized') || err?.message?.includes('INVALID_TOKEN')) {
            api.setToken(null);
          } else {
            console.warn('getMe non-fatal network or rate-limit error on restore:', err);
          }
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
      // WebSocket handles instant updates; background polling is kept gentle (25s) and pauses when hidden
      const interval = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        loadConversations();
      }, 25000);
      return () => clearInterval(interval);
    }
  }, [currentUser]);

  // Global WebRTC call listener
  useEffect(() => {
    const unsub = webrtcManager.subscribe((session) => {
      setCallSession(session);
    });
    return () => unsub();
  }, []);

  // Subscribe to real-time events over WebSocket
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (refreshTimer !== undefined) return;
      refreshTimer = setTimeout(() => { refreshTimer = undefined; loadConversations(); }, 100);
    };
    const unsubscribe = wsManager.subscribe((event) => {
      if (
        event.type === 'message.created' ||
        event.type === 'message.updated' ||
        event.type === 'message.deleted' ||
        event.type === 'message.pinned' ||
        event.type === 'conversation.created' ||
        event.type === 'conversation.read'
      ) {
        refresh();

        if (notificationGate.current.shouldNotify(event, currentUser?.id || '')) {
          const rawMsg = event.payload;
          if (rawMsg && rawMsg.sender_id !== currentUser?.id) {
            buildNotificationData(rawMsg, conversations, currentUser, appSettings, lang).then((notifData) => {
              if (!notifData) return;

              // Play notification chime if sound enabled and not muted
              if (appSettings.notificationSound !== false) {
                soundManager.playMessageNotification();
              }

              const isViewingThisChat = !document.hidden && activeConversation?.id === rawMsg.conversation_id;

              // Foreground in-app notification banner if user is viewing another chat
              if (!isViewingThisChat) {
                setInAppNotif({
                  id: rawMsg.id || String(Date.now()),
                  title: notifData.title,
                  body: notifData.body,
                  senderName: notifData.senderName,
                  senderAvatarUrl: notifData.senderAvatarUrl,
                  conversation: notifData.conversation,
                });
              }

              // Desktop browser notification if backgrounded or viewing another chat
              if (
                !isViewingThisChat &&
                appSettings.desktopNotifications !== false &&
                typeof window !== 'undefined' &&
                'Notification' in window &&
                Notification.permission === 'granted'
              ) {
                try {
                  const notif = new Notification(notifData.title, {
                    body: notifData.body,
                    icon: notifData.icon || '/favicon.ico',
                    tag: `msg-${rawMsg.id || rawMsg.conversation_id}`,
                  });
                  notif.onclick = () => {
                    window.focus();
                    if (notifData.conversation) {
                      setActiveConversation(notifData.conversation);
                    }
                  };
                } catch (e) {
                  console.warn('Browser notification error:', e);
                }
              }
            });
          }
        }
      }
    });
    return () => { unsubscribe(); clearTimeout(refreshTimer); };
  }, [currentUser, activeConversation?.id, conversations, appSettings, lang]);

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
    if (session.device_id) {
      localStorage.setItem('senora_device_id', session.device_id);
    }
    setCurrentUser(session.user);
    if (session.token) {
      wsManager.connect(session.token);
    }
    webrtcManager.init();
    webrtcManager.setUserId(session.user.id);

    const syncedSettings = await syncSettingsFromBackend();
    setAppSettings(syncedSettings);
    setLang(syncedSettings.language);
    applySettingsToDOM(syncedSettings);

    if (session.device_id && session.token) {
      try {
        await signalManager.initialize(session.user.id, session.device_id, session.token);
      } catch (e) {
        console.warn('Signal manager init error on login:', e);
      }
    }

    loadConversations();
  };

  const handleLogout = async () => {
    await api.logout();
    wsManager.disconnect();
    webrtcManager.setUserId('');
    cryptoEngine.resetCache();
    localStorage.removeItem('senora_device_id');
    const defaults = resetSettings();
    setAppSettings(defaults);
    setLang(defaults.language);
    setIsLocked(false);
    setCurrentUser(null);
    setActiveConversation(null);
    setConversations([]);
  };

  const handleToggleLang = () => {
    const language = lang === 'en' ? 'fa' : 'en';
    setAppSettings(saveSettings({ language }));
    setLang(language);
  };

  if (standaloneWatchId) {
    return <StandaloneWebPlayer shareId={standaloneWatchId} />;
  }

  if (loading) {
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-[#0e1621] text-white">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 border-2 border-[#24A1DE] border-t-transparent rounded-full animate-spin" />
          <p className="text-xs text-[#7f91a4]">{uiText("Initializing SENORA...", uiLang)}</p>
        </div>
      </div>
    );
  }

  if (!currentUser) {
    return <AuthModal onSuccess={handleAuthSuccess} lang={lang} onToggleLang={handleToggleLang} />;
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
    <div className="flex h-full h-[100dvh] w-full max-w-full overflow-hidden bg-[#0e1621] text-white">
      {/* Sidebar (Always visible on desktop, hidden when chat active on mobile) */}
      <div className={`${activeConversation ? 'hidden md:flex' : 'flex'} w-full md:w-auto h-full flex-shrink-0 overflow-hidden`}>
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
          onToggleLang={handleToggleLang}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        />
      </div>

      {/* Main Chat Panel */}
      <main className={`flex-1 h-full min-w-0 ${!activeConversation ? 'hidden md:flex' : 'flex'} flex-col overflow-hidden`}>
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
                <span>{uiText("Checking invite link...", uiLang)}</span>
              </div>
            ) : inviteError ? (
              <div className="space-y-3 my-2 w-full">
                <p className="text-xs text-red-400 bg-red-500/10 p-3 rounded-xl border border-red-500/20">{inviteError}</p>
                <button
                  type="button"
                  onClick={handleDismissInvite}
                  className="w-full py-2 rounded-xl bg-[#242f3d] hover:bg-[#2c3846] text-xs font-bold text-white transition cursor-pointer"
                >{uiText("Close", uiLang)}</button>
              </div>
            ) : invitePreview ? (
              <div className="space-y-4 my-2 w-full">
                <div>
                  <h3 className="text-base font-bold text-white">{invitePreview.title}</h3>
                  <p className="text-xs text-[#7f91a4] mt-0.5 capitalize">
                    {uiText(invitePreview.type === 'channel' ? 'Channel' : 'Group', uiLang)} • {invitePreview.participant_count} {invitePreview.type === 'channel' ? uiText("subscribers", uiLang) : uiText("members", uiLang)}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleDismissInvite}
                    className="flex-1 py-2 rounded-xl bg-[#242f3d] hover:bg-[#2c3846] text-xs font-bold text-white transition cursor-pointer"
                  >{uiText("Cancel", uiLang)}</button>
                  <button
                    type="button"
                    disabled={joiningInvite}
                    onClick={handleJoinInvite}
                    className="flex-1 py-2 rounded-xl bg-[#24A1DE] hover:bg-[#208fc4] text-xs font-bold text-white transition cursor-pointer disabled:opacity-50"
                  >
                    {joiningInvite ? uiText("Joining...", uiLang) : uiText(invitePreview.type === 'channel' ? 'Join Channel' : 'Join Group', uiLang)}
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
          onToggleLang={handleToggleLang}
          theme={theme}
          onToggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          initialTab={settingsModalTab}
        />
      )}
      {/* Floating In-App Notification Toast Banner */}
      <InAppNotificationBanner
        notification={inAppNotif}
        onSelect={(conv) => setActiveConversation(conv)}
        onDismiss={() => setInAppNotif(null)}
      />

      {/* Global WebRTC Incoming / Active Call Modal Overlay */}
      {callSession && <CallModal session={callSession} lang={lang} />}



      {/* Shared Sticker Pack Preview Modal (?pack=...) */}
      {pendingStickerPackCode && (
        <StickerPackModal
          isOpen={!!pendingStickerPackCode}
          onClose={() => {
            setPendingStickerPackCode(null);
            if (typeof window !== 'undefined' && window.history?.replaceState) {
              const url = new URL(window.location.href);
              url.searchParams.delete('pack');
              window.history.replaceState({}, document.title, url.toString());
            }
          }}
          packIdOrCode={pendingStickerPackCode}
        />
      )}
    </div>
  );
};
