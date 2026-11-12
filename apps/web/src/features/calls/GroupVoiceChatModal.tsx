import { uiText, useUILanguage } from "../../app/language";
import React, { useState, useEffect, useRef } from 'react';
import { Conversation, User } from '../../app/types';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';
import {
  Mic,
  MicOff,
  PhoneOff,
  Users,
  X,
  Radio,
  AlertCircle,
  Settings,
  Volume2,
} from 'lucide-react';
import { mediaDeviceManager } from './mediaDeviceManager';
import { groupVoiceChatManager, GroupVoiceChatState } from './groupVoiceChatManager';

interface GroupVoiceChatModalProps {
  conversation: Conversation;
  currentUser: User;
  onClose: () => void;
  onRoomEnded?: () => void;
}

export const GroupVoiceChatModal: React.FC<GroupVoiceChatModalProps> = ({
  conversation,
  currentUser,
  onClose,
  onRoomEnded,
}) => {
  const uiLang = useUILanguage();
  const [vcState, setVcState] = useState<GroupVoiceChatState | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [audioDevices, setAudioDevices] = useState<{
    audioInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
  }>({ audioInputs: [], audioOutputs: [] });
  const [selectedAudioIn, setSelectedAudioIn] = useState('');
  const [selectedAudioOut, setSelectedAudioOut] = useState('');

  const durationTimerRef = useRef<any>(null);
  const onCloseRef = useRef(onClose);
  const onRoomEndedRef = useRef(onRoomEnded);
  onCloseRef.current = onClose;
  onRoomEndedRef.current = onRoomEnded;

  // Subscribe to singleton GroupVoiceChatManager & open room
  useEffect(() => {
    groupVoiceChatManager.setUserId(currentUser.id);
    const unsub = groupVoiceChatManager.subscribe((next) => {
      setVcState(next);
    });
    void groupVoiceChatManager.openConversationRoom(conversation.id);

    const pollInterval = setInterval(() => {
      void groupVoiceChatManager.refreshRoomState(conversation.id);
    }, 4000);

    mediaDeviceManager.enumerateDevices().then((devs) => {
      setAudioDevices({ audioInputs: devs.audioInputs, audioOutputs: devs.audioOutputs });
      setSelectedAudioIn(mediaDeviceManager.getSelectedAudioInputId());
      setSelectedAudioOut(mediaDeviceManager.getSelectedAudioOutputId());
    });

    return () => {
      clearInterval(pollInterval);
      unsub();
      // Leave cleanly when modal unmounts so no ghost participant remains in DB or open mic tracks
      void groupVoiceChatManager.leaveRoom();
    };
  }, [conversation.id, currentUser.id]);

  // Listen specifically to authoritative server voice_chat.ended event
  useEffect(() => {
    const unsubEnded = wsManager.subscribe((event) => {
      if (
        event.type === 'voice_chat.ended' &&
        event.payload?.conversation_id === conversation.id
      ) {
        onRoomEndedRef.current?.();
        onCloseRef.current();
      }
    });
    return () => unsubEnded();
  }, [conversation.id]);

  const room = vcState?.room || null;
  const participants = vcState?.participants || [];
  const isJoined = !!vcState?.isJoined;
  const isMuted = !!vcState?.isMuted;
  const isSpeaking = !!vcState?.isSpeaking;
  const speakingLevel = vcState?.speakingLevel || 0;
  const remoteAudioLevels = vcState?.remoteAudioLevels || {};
  const peerIceStates = vcState?.peerIceStates || {};
  const loading = vcState ? vcState.loading : true;
  const error = localError || vcState?.error || null;

  // Duration timer
  useEffect(() => {
    if (room?.is_active && room.created_at) {
      const startTime = new Date(room.created_at).getTime();
      const updateDuration = () => {
        setDurationSeconds(Math.max(0, Math.floor((Date.now() - startTime) / 1000)));
      };
      updateDuration();
      durationTimerRef.current = setInterval(updateDuration, 1000);
      return () => clearInterval(durationTimerRef.current);
    }
  }, [room?.is_active, room?.created_at]);

  const handleJoinVoiceChat = async () => {
    setLocalError(null);
    await groupVoiceChatManager.joinRoom(conversation.id);
  };

  const handleToggleMute = async () => {
    await groupVoiceChatManager.toggleMute();
  };

  const handleLeaveVoiceChat = async () => {
    await groupVoiceChatManager.leaveRoom();
  };

  const handleCloseModal = async () => {
    if (isJoined) {
      await groupVoiceChatManager.leaveRoom();
    }
    onClose();
  };

  const handleEndVoiceChat = async () => {
    if (!confirm(uiText("Are you sure you want to end this voice chat for all participants?", uiLang))) return;
    setLocalError(null);
    try {
      await groupVoiceChatManager.endRoomForEveryone();
      onRoomEnded?.();
      onClose();
    } catch (e: any) {
      setLocalError(e?.message || (uiLang === 'fa' ? 'پایان گفتگوی صوتی ناموفق بود' : 'Failed to end voice chat'));
    }
  };

  const handleDeviceChange = async (kind: 'audioinput' | 'audiooutput', deviceId: string) => {
    if (kind === 'audioinput') {
      setSelectedAudioIn(deviceId);
      await groupVoiceChatManager.switchMicrophone(deviceId).catch((e) => {
        setLocalError(e?.message || 'Failed to switch microphone');
      });
    } else {
      setSelectedAudioOut(deviceId);
      mediaDeviceManager.setSelectedAudioOutputId(deviceId);
      await groupVoiceChatManager.refreshAudioOutput();
    }
  };

  const isCreatorOrAdmin = Boolean(
    room &&
      (room.created_by === currentUser.id ||
        vcState?.myRole === 'owner' ||
        vcState?.myRole === 'admin')
  );

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-4 animate-fade-in">
      <div className="w-full max-w-lg rounded-3xl bg-[#17212b] border border-[#242f3d] shadow-2xl flex flex-col overflow-hidden max-h-[90vh]">
        {/* Header */}
        <div className="p-4 bg-[#1f2b38] border-b border-[#242f3d] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-2xl bg-gradient-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-white shadow-lg">
              <Radio className="h-5 w-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white truncate max-w-[220px]">
                  {room?.title || conversation.title || uiText("Group Voice Chat", uiLang)}
                </h3>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  {uiText("LIVE", uiLang)}
                </span>
              </div>
              <p className="text-[11px] text-[#7f91a4]">
                {participants.length}
                {uiText(" participant", uiLang)}
                {participants.length !== 1 ? 's' : ''} • {formatDuration(durationSeconds)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowDeviceSettings(!showDeviceSettings)}
              className={`p-2 rounded-xl transition cursor-pointer ${
                showDeviceSettings
                  ? 'bg-[#24A1DE] text-white'
                  : 'text-[#7f91a4] hover:text-white hover:bg-[#242f3d]'
              }`}
              title={uiText("Audio & Video Devices", uiLang)}
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={handleCloseModal}
              className="p-2 rounded-xl text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
              title={uiText("Close", uiLang)}
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Audio Device Selector */}
        {showDeviceSettings && (
          <div className="p-3 bg-[#1b2633] border-b border-[#242f3d] text-xs text-slate-300 space-y-2.5">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">{uiText("Microphone", uiLang)}</label>
              <select
                value={selectedAudioIn}
                onChange={(e) => handleDeviceChange('audioinput', e.target.value)}
                className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
              >
                <option value="">{uiText("Default Microphone", uiLang)}</option>
                {audioDevices.audioInputs.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `${uiText('Microphone', uiLang)} ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>
            {mediaDeviceManager.isSinkIdSupported() && (
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{uiText("Audio Output / Speaker", uiLang)}</label>
                <select
                  value={selectedAudioOut}
                  onChange={(e) => handleDeviceChange('audiooutput', e.target.value)}
                  className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
                >
                  <option value="">{uiText("Default Speaker", uiLang)}</option>
                  {audioDevices.audioOutputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `${uiText('Speaker', uiLang)} ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Autoplay blocked unlock banner */}
        {vcState?.playbackBlocked && (
          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={() => groupVoiceChatManager.unlockPlayback()}
              className="w-full py-2 px-3 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 cursor-pointer shadow"
            >
              <Volume2 className="h-4 w-4" />
              <span>
                {uiLang === 'fa' ? 'برای شنیدن صدای شرکت‌کنندگان کلیک کنید' : 'Tap to Enable Voice Audio Playback'}
              </span>
            </button>
          </div>
        )}

        {/* Mesh scaling notice */}
        {vcState?.meshWarning && (
          <div className="mx-4 mt-3 p-2.5 rounded-xl bg-amber-950/60 border border-amber-700/60 text-amber-200 text-[11px]">
            {uiLang === 'fa'
              ? 'حالت فعلی P2P Mesh تا ۸ شرکت‌کننده را پشتیبانی می‌کند؛ برای اتاق‌های بزرگ‌تر به SFU خارجی نیاز است.'
              : 'P2P Mesh supports up to 8 concurrent peers; larger rooms require an external SFU.'}
          </div>
        )}

        {/* Error Alert */}
        {error && (
          <div className="m-4 p-3 rounded-2xl bg-red-950/80 border border-red-800 text-red-300 text-xs flex items-center gap-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{uiText(error, uiLang)}</span>
          </div>
        )}

        {/* Participants Grid / List */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
          <div className="flex items-center justify-between text-xs text-[#7f91a4] font-medium px-1 mb-1">
            <span>{uiText("Participants in Room (", uiLang)}{participants.length})</span>
            <span>{uiText("Microphone", uiLang)}</span>
          </div>

          {participants.length === 0 ? (
            <div className="py-12 text-center text-[#7f91a4]">
              <Users className="h-10 w-10 mx-auto mb-2 opacity-40" />
              <p className="text-xs">{uiText("No one is currently speaking in this room.", uiLang)}</p>
              <p className="text-[11px] text-[#7f91a4]/70 mt-1">{uiText("Be the first to join and start speaking!", uiLang)}</p>
            </div>
          ) : (
            participants.map((p) => {
              const isMe = p.user_id === currentUser.id;
              const remoteEnergy = isMe ? speakingLevel : (remoteAudioLevels[p.user_id] || 0);
              const currentlySpeaking = isMe ? isSpeaking : (p.is_speaking || remoteEnergy > 12);
              const currentlyMuted = isMe ? isMuted : p.is_muted;
              const iceState = isMe ? undefined : peerIceStates[p.user_id];

              return (
                <div
                  key={p.user_id}
                  className={`flex items-center justify-between p-3 rounded-2xl border transition ${
                    currentlySpeaking
                      ? 'bg-emerald-950/40 border-emerald-500/50 shadow-md shadow-emerald-950/30'
                      : 'bg-[#1b2633] border-[#242f3d]'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="relative">
                      {p.avatar_url ? (
                        <img
                          src={api.avatarURL(p.avatar_url)}
                          alt={p.display_name}
                          className="h-10 w-10 rounded-full object-cover border border-[#242f3d]"
                        />
                      ) : (
                        <div className="h-10 w-10 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#60a5fa] flex items-center justify-center text-white font-bold text-sm">
                          {(p.display_name || p.username).charAt(0).toUpperCase()}
                        </div>
                      )}
                      {currentlySpeaking && (
                        <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-emerald-500 border-2 border-[#17212b] animate-ping" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-bold text-white truncate">
                          {p.display_name || p.username}
                        </span>
                        {isMe && (
                          <span className="text-[10px] text-[#24A1DE] font-semibold">{uiText("(You)", uiLang)}</span>
                        )}
                      </div>
                      <span className="text-[10px] text-[#7f91a4] block">
                        @{p.username}
                        {!isMe && isJoined && iceState && (
                          <span className="ml-1.5 font-mono text-[9px] text-slate-400">
                            • {iceState === 'connected' || iceState === 'completed' ? 'WebRTC' : iceState}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  {/* Audio Status & Real Measured Speaking Wave */}
                  <div className="flex items-center gap-2.5">
                    {currentlySpeaking && (
                      <div className="flex items-center gap-0.5 h-4 px-1">
                        {[0.55, 0.9, 1.0, 0.7].map((scale, idx) => (
                          <span
                            key={idx}
                            className="w-1 bg-emerald-400 rounded-full transition-all duration-150"
                            style={{
                              height: `${Math.max(4, Math.min(16, (Math.max(remoteEnergy, 25) / 100) * 16 * scale))}px`,
                            }}
                          />
                        ))}
                      </div>
                    )}
                    <div
                      className={`h-8 w-8 rounded-full flex items-center justify-center transition ${
                        currentlyMuted
                          ? 'bg-red-500/20 text-red-400'
                          : 'bg-emerald-500/20 text-emerald-400'
                      }`}
                    >
                      {currentlyMuted ? (
                        <MicOff className="h-4 w-4" />
                      ) : (
                        <Mic className="h-4 w-4" />
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 bg-[#1f2b38] border-t border-[#242f3d] flex flex-col gap-3">
          {isJoined ? (
            <div className="flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={handleToggleMute}
                className={`flex-1 py-3 px-4 rounded-2xl font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-lg ${
                  isMuted
                    ? 'bg-red-600 hover:bg-red-500 text-white shadow-red-950/40'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-emerald-950/40'
                }`}
              >
                {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                <span>{isMuted ? uiText("Unmute Microphone", uiLang) : uiText("Mute Microphone", uiLang)}</span>
              </button>

              <button
                type="button"
                onClick={handleLeaveVoiceChat}
                className="py-3 px-4 rounded-2xl bg-[#242f3d] hover:bg-[#202b36] text-white font-bold text-xs flex items-center gap-2 transition cursor-pointer"
              >
                <PhoneOff className="h-4 w-4 text-red-400" />
                <span>{uiText("Leave", uiLang)}</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleJoinVoiceChat}
              disabled={loading}
              className="w-full py-3.5 px-4 rounded-2xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-lg shadow-emerald-950/40"
            >
              <Mic className="h-4 w-4" />
              <span>{uiText("Join Voice Chat", uiLang)}</span>
            </button>
          )}

          {isCreatorOrAdmin && isJoined && (
            <button
              type="button"
              onClick={handleEndVoiceChat}
              className="text-[11px] text-red-400 hover:text-red-300 transition py-1 text-center cursor-pointer"
            >
              {uiText("End Voice Chat for Everyone", uiLang)}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
