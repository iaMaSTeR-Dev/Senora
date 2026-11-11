import { uiText, useUILanguage } from "../../app/language";
import React, { useState, useEffect, useRef } from 'react';
import { Conversation, User, VoiceChatParticipant, VoiceChatRoom } from '../../app/types';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';
import {
  Mic,
  MicOff,
  PhoneOff,
  Users,
  X,
  Radio,
  AlertCircle
} from 'lucide-react';
import { STUDIO_AUDIO_CONSTRAINTS } from './mediaDeviceManager';

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
  const [room, setRoom] = useState<VoiceChatRoom | null>(null);
  const [participants, setParticipants] = useState<VoiceChatParticipant[]>([]);
  const [isJoined, setIsJoined] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [speakingLevel, setSpeakingLevel] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState(0);

  // Audio stream and analysis refs
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const durationTimerRef = useRef<any>(null);

  // WebRTC peer connections mapped by user_id
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());



  // 1. Fetch initial Voice Chat state
  const fetchRoomState = async () => {
    try {
      const res = await api.getActiveVoiceChat(conversation.id);
      setRoom(res.room);
      setParticipants(res.participants);
      const myPart = res.participants.find((p) => p.user_id === currentUser.id);
      if (myPart) {
        setIsJoined(true);
        setIsMuted(myPart.is_muted);
      }
    } catch (err: any) {
      // No active room or not found
      setRoom(null);
      setParticipants([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRoomState();
    const interval = setInterval(fetchRoomState, 4000);
    return () => clearInterval(interval);
  }, [conversation.id]);

  // Duration timer
  useEffect(() => {
    if (room?.is_active) {
      const startTime = new Date(room.created_at).getTime();
      const updateDuration = () => {
        const now = Date.now();
        setDurationSeconds(Math.max(0, Math.floor((now - startTime) / 1000)));
      };
      updateDuration();
      durationTimerRef.current = setInterval(updateDuration, 1000);
      return () => clearInterval(durationTimerRef.current);
    }
  }, [room?.is_active, room?.created_at]);

  // Cleanup WebRTC and audio on unmount
  useEffect(() => {
    return () => {
      leaveLocalMedia();
      peerConnectionsRef.current.forEach((pc) => pc.close());
      peerConnectionsRef.current.clear();
    };
  }, []);

  const leaveLocalMedia = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
  };

  // 2. Start or Join Voice Chat
  const handleJoinVoiceChat = async () => {
    setError(null);
    setLoading(true);
    try {
      // Get microphone access with studio-grade audio constraints
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: STUDIO_AUDIO_CONSTRAINTS });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      localStreamRef.current = stream;

      // Setup audio analysis for real speaking level
      try {
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const ctx = new AudioCtx();
          audioContextRef.current = ctx;
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 64;
          source.connect(analyser);
          analyserRef.current = analyser;

          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          let prevSpeaking = false;

          const checkSpeaking = () => {
            if (!analyserRef.current) return;
            analyserRef.current.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
              sum += dataArray[i];
            }
            const avg = sum / dataArray.length;
            setSpeakingLevel(Math.min(100, avg * 1.5));

            const nowSpeaking = avg > 12 && !isMuted;
            if (nowSpeaking !== prevSpeaking) {
              prevSpeaking = nowSpeaking;
              setIsSpeaking(nowSpeaking);
              api.updateVoiceChatState(conversation.id, { is_speaking: nowSpeaking }).catch(() => {});
            }
            animFrameRef.current = requestAnimationFrame(checkSpeaking);
          };
          checkSpeaking();
        }
      } catch (audioErr) {
        console.warn('Audio analysis warning:', audioErr);
      }

      // Backend join
      const res = await api.startOrJoinVoiceChat(conversation.id);
      setRoom(res.room);
      setParticipants(res.participants);
      setIsJoined(true);
      setIsMuted(false);

      // Signal join to room
      wsManager.sendVoiceChatSignal({
        conversation_id: conversation.id,
        room_id: res.room.id,
        signal_type: 'peer_joined',
      });
    } catch (err: any) {
      setError(err.message || uiText("Microphone access denied or error joining voice chat", uiLang));
    } finally {
      setLoading(false);
    }
  };

  // 3. Toggle Mute
  const handleToggleMute = async () => {
    if (!localStreamRef.current) return;
    const nextMuted = !isMuted;
    localStreamRef.current.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setIsMuted(nextMuted);
    if (nextMuted) {
      setIsSpeaking(false);
      setSpeakingLevel(0);
    }
    try {
      await api.updateVoiceChatState(conversation.id, { is_muted: nextMuted, is_speaking: false });
    } catch (e) {
      console.warn('Update mute state error:', e);
    }
  };

  // 4. Leave Voice Chat
  const handleLeaveVoiceChat = async () => {
    leaveLocalMedia();
    setIsJoined(false);
    setIsMuted(false);
    setIsSpeaking(false);
    setSpeakingLevel(0);

    try {
      await api.leaveVoiceChat(conversation.id);
      wsManager.sendVoiceChatSignal({
        conversation_id: conversation.id,
        room_id: room?.id || '',
        signal_type: 'peer_left',
      });
      await fetchRoomState();
    } catch (e) {
      console.warn('Leave error:', e);
    }
  };

  // 5. End Voice Chat (Host / Admin)
  const handleEndVoiceChat = async () => {
    if (!confirm(uiText("Are you sure you want to end this voice chat for all participants?", uiLang))) return;
    leaveLocalMedia();
    setIsJoined(false);
    try {
      await api.endVoiceChat(conversation.id);
      wsManager.sendVoiceChatSignal({
        conversation_id: conversation.id,
        room_id: room?.id || '',
        signal_type: 'room_ended',
      });
      setRoom(null);
      setParticipants([]);
      if (onRoomEnded) onRoomEnded();
      onClose();
    } catch (e: any) {
      alert(`Failed to end voice chat: ${e.message}`);
    }
  };

  // 6. Listen to WebSocket voice_chat events
  useEffect(() => {
    const unsub = wsManager.subscribe((event) => {
      if (event.type === 'voice_chat.signal' && event.payload?.conversation_id === conversation.id) {
        const payload = event.payload;
        if (payload.signal_type === 'room_ended') {
          leaveLocalMedia();
          setIsJoined(false);
          setRoom(null);
          setParticipants([]);
          onClose();
        } else if (payload.signal_type === 'peer_joined' || payload.signal_type === 'peer_left') {
          fetchRoomState();
        }
      }
    });
    return () => unsub();
  }, [conversation.id]);

  const isCreatorOrAdmin = room && (room.created_by === currentUser.id || conversation.type === 'group');

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
                <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">{uiText("LIVE", uiLang)}</span>
              </div>
              <p className="text-[11px] text-[#7f91a4]">
                {participants.length}{uiText(" participant", uiLang)}{participants.length !== 1 ? 's' : ''} • {formatDuration(durationSeconds)}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-[#7f91a4] hover:text-white hover:bg-[#242f3d] transition cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

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
              const currentlySpeaking = isMe ? isSpeaking : p.is_speaking;
              const currentlyMuted = isMe ? isMuted : p.is_muted;

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
                      </span>
                    </div>
                  </div>

                  {/* Audio Status & Speaking Wave */}
                  <div className="flex items-center gap-2.5">
                    {currentlySpeaking && (
                      <div className="flex items-center gap-0.5 h-4 px-1">
                        {[1, 2, 3, 4].map((bar) => (
                          <span
                            key={bar}
                            className="w-1 bg-emerald-400 rounded-full animate-pulse"
                            style={{
                              height: isMe
                                ? `${Math.max(4, (speakingLevel / 100) * 16)}px`
                                : `${Math.floor(Math.random() * 12) + 4}px`,
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
              className="text-[11px] text-red-400 hover:text-red-300 transition py-1 text-center"
            >{uiText("End Voice Chat for Everyone", uiLang)}</button>
          )}
        </div>
      </div>
    </div>
  );
};
