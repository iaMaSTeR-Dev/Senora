import React, { useEffect, useRef, useState } from 'react';
import { CallSession, webrtcManager } from './webrtcManager';
import { mediaDeviceManager } from './mediaDeviceManager';
import {
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Mic,
  MicOff,
  User,
  Monitor,
  Settings,
  ShieldCheck,
  Volume2,
  X
} from 'lucide-react';

interface CallModalProps {
  session: CallSession;
  lang?: string;
}

export const CallModal: React.FC<CallModalProps> = ({ session, lang = 'en' }) => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [showDeviceSettings, setShowDeviceSettings] = useState(false);
  const [audioDevices, setAudioDevices] = useState<{
    audioInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
  }>({ audioInputs: [], audioOutputs: [], videoInputs: [] });

  const [selectedAudioIn, setSelectedAudioIn] = useState('');
  const [selectedAudioOut, setSelectedAudioOut] = useState('');
  const [selectedVideoIn, setSelectedVideoIn] = useState('');

  // Load available devices
  useEffect(() => {
    mediaDeviceManager.enumerateDevices().then((devs) => {
      setAudioDevices(devs);
      setSelectedAudioIn(mediaDeviceManager.getSelectedAudioInputId());
      setSelectedAudioOut(mediaDeviceManager.getSelectedAudioOutputId());
      setSelectedVideoIn(mediaDeviceManager.getSelectedVideoInputId());
    });
  }, []);

  // Attach local stream
  useEffect(() => {
    if (localVideoRef.current && session.localStream) {
      localVideoRef.current.srcObject = session.localStream;
    }
  }, [session.localStream]);

  // Attach remote stream (audio and video)
  useEffect(() => {
    if (remoteVideoRef.current && session.remoteStream) {
      remoteVideoRef.current.srcObject = session.remoteStream;
      mediaDeviceManager.applyAudioOutput(remoteVideoRef.current);
    }
    if (remoteAudioRef.current && session.remoteStream) {
      remoteAudioRef.current.srcObject = session.remoteStream;
      mediaDeviceManager.applyAudioOutput(remoteAudioRef.current);
    }
  }, [session.remoteStream]);

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const s = sec % 60;
    return `${mins.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const getStatusText = () => {
    switch (session.state) {
      case 'outgoing_calling':
        return lang === 'fa' ? 'در حال برقراری تماس...' : 'Calling...';
      case 'outgoing_ringing':
        return lang === 'fa' ? 'در حال زنگ خوردن...' : 'Ringing...';
      case 'incoming_ringing':
        return lang === 'fa' ? 'تماس ورودی...' : 'Incoming Call...';
      case 'connecting':
        return lang === 'fa' ? 'در حال اتصال امن...' : 'Connecting securely...';
      case 'connected':
        return formatDuration(session.durationSeconds);
      case 'rejected':
        return lang === 'fa' ? 'تماس رد شد' : 'Call Declined';
      case 'ended':
        return lang === 'fa' ? 'تماس پایان یافت' : 'Call Ended';
      case 'timeout':
        return lang === 'fa' ? 'بی‌پاسخ' : 'No Answer';
      case 'cancelled':
        return lang === 'fa' ? 'تماس لغو شد' : 'Call Cancelled';
      default:
        return '';
    }
  };

  const isRinging =
    session.state === 'outgoing_calling' ||
    session.state === 'outgoing_ringing' ||
    session.state === 'incoming_ringing';

  const handleDeviceChange = async (
    kind: 'audioinput' | 'audiooutput' | 'videoinput',
    deviceId: string
  ) => {
    if (kind === 'audioinput') {
      setSelectedAudioIn(deviceId);
      mediaDeviceManager.setSelectedAudioInputId(deviceId);
    } else if (kind === 'audiooutput') {
      setSelectedAudioOut(deviceId);
      mediaDeviceManager.setSelectedAudioOutputId(deviceId);
      if (remoteVideoRef.current) mediaDeviceManager.applyAudioOutput(remoteVideoRef.current);
      if (remoteAudioRef.current) mediaDeviceManager.applyAudioOutput(remoteAudioRef.current);
    } else if (kind === 'videoinput') {
      setSelectedVideoIn(deviceId);
      mediaDeviceManager.setSelectedVideoInputId(deviceId);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-xl p-4 animate-fadeIn select-none">
      {/* Hidden audio element for audio calls to guarantee playback through selected sink */}
      <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

      <div className="relative w-full max-w-xl bg-[#17212b]/95 border border-[#242f3d] rounded-3xl overflow-hidden shadow-2xl flex flex-col items-center">
        {/* Top Header Banner */}
        <div className="w-full flex items-center justify-between px-6 pt-5 pb-2 text-xs text-slate-400">
          <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
            <ShieldCheck size={15} />
            <span>End-to-End Encrypted Call</span>
          </div>
          <button
            type="button"
            onClick={() => setShowDeviceSettings(!showDeviceSettings)}
            className="p-1.5 rounded-xl hover:bg-white/10 hover:text-white transition cursor-pointer"
            title="Call Settings (Microphone, Camera, Audio)"
          >
            <Settings size={16} />
          </button>
        </div>

        {/* Video Area (When Video Call is Connected) */}
        {session.callType === 'video' && session.state === 'connected' ? (
          <div className="relative w-full h-84 sm:h-96 bg-black flex items-center justify-center overflow-hidden">
            {/* Remote Video (Full Size) */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              className="w-full h-full object-cover"
            />

            {/* Local Video PiP (Corner) */}
            <div className="absolute bottom-4 right-4 w-28 h-36 sm:w-36 sm:h-48 bg-slate-900 rounded-2xl overflow-hidden border-2 border-[#24A1DE] shadow-2xl">
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                className="w-full h-full object-cover transform -scale-x-100"
              />
            </div>

            {/* Remote Info Overlay */}
            <div className="absolute top-4 left-4 px-3 py-1.5 rounded-xl bg-black/60 backdrop-blur-md text-white text-xs flex items-center gap-2">
              <span className="font-semibold">{session.peerName}</span>
              <span className="font-mono text-[#24A1DE]">{formatDuration(session.durationSeconds)}</span>
            </div>
          </div>
        ) : (
          /* Voice Call or Ringing State View */
          <div className="py-10 px-6 flex flex-col items-center justify-center space-y-6 w-full">
            {/* Caller Avatar with Animated Audio Waves */}
            <div className="relative flex items-center justify-center">
              {/* Outer pulsing rings when ringing or speaking */}
              {isRinging && (
                <>
                  <div className="absolute w-36 h-36 rounded-full border border-[#24A1DE]/40 animate-ping" />
                  <div className="absolute w-44 h-44 rounded-full border border-[#24A1DE]/20 animate-pulse" />
                </>
              )}
              {session.state === 'connected' && (
                <div className="absolute w-36 h-36 rounded-full border-2 border-emerald-500/30 animate-pulse" />
              )}

              <div className="w-28 h-28 rounded-full bg-gradient-to-tr from-[#24A1DE] to-[#1e87bb] flex items-center justify-center text-white shadow-2xl shadow-[#24A1DE]/25 overflow-hidden z-10 border-2 border-white/10">
                {session.peerAvatarUrl ? (
                  <img
                    src={session.peerAvatarUrl}
                    alt={session.peerName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-3xl font-bold uppercase tracking-wider">
                    {session.peerName ? session.peerName.charAt(0) : <User size={48} />}
                  </span>
                )}
              </div>
            </div>

            {/* Peer Details & Status */}
            <div className="text-center space-y-1">
              <h3 className="text-2xl font-bold text-white tracking-wide">{session.peerName}</h3>
              <p className="text-xs font-semibold text-[#24A1DE] uppercase tracking-wider">
                {session.callType === 'video'
                  ? (lang === 'fa' ? 'تماس تصویری سنورا' : 'Senora Video Call')
                  : (lang === 'fa' ? 'تماس صوتی سنورا' : 'Senora Voice Call')}
              </p>
              <p className="text-base font-mono text-slate-300 pt-1 font-semibold">{getStatusText()}</p>
            </div>

            {/* Autoplay blocked sound unlock button */}
            {session.state === 'incoming_ringing' && session.autoplayBlocked && (
              <button
                type="button"
                onClick={() => webrtcManager.unlockAudio()}
                className="px-4 py-2 rounded-full bg-amber-400 hover:bg-amber-300 text-slate-950 font-bold text-xs flex items-center gap-2 shadow-lg animate-bounce transition cursor-pointer"
              >
                <span>🔊</span>
                <span>{lang === 'fa' ? 'برای پخش صدای زنگ کلیک کنید' : 'Tap to Unmute Ringtone'}</span>
              </button>
            )}
          </div>
        )}

        {/* Device Settings Popover */}
        {showDeviceSettings && (
          <div className="w-full bg-[#1e2a38] border-t border-[#242f3d] p-4 text-xs text-slate-300 animate-fadeIn space-y-3">
            <div className="flex items-center justify-between pb-1 border-b border-white/5">
              <span className="font-semibold text-white">Call Audio & Video Devices</span>
              <button
                type="button"
                onClick={() => setShowDeviceSettings(false)}
                className="p-1 hover:text-white transition cursor-pointer"
              >
                <X size={14} />
              </button>
            </div>

            {/* Microphone Selection */}
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Microphone</label>
              <select
                value={selectedAudioIn}
                onChange={(e) => handleDeviceChange('audioinput', e.target.value)}
                className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
              >
                <option value="">Default Microphone</option>
                {audioDevices.audioInputs.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </select>
            </div>

            {/* Speaker Selection (if supported) */}
            {mediaDeviceManager.isSinkIdSupported() && (
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Audio Output / Speaker</label>
                <select
                  value={selectedAudioOut}
                  onChange={(e) => handleDeviceChange('audiooutput', e.target.value)}
                  className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
                >
                  <option value="">Default Speaker</option>
                  {audioDevices.audioOutputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Speaker ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Camera Selection */}
            {session.callType === 'video' && (
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Camera</label>
                <select
                  value={selectedVideoIn}
                  onChange={(e) => handleDeviceChange('videoinput', e.target.value)}
                  className="w-full bg-[#242f3d] text-white px-2.5 py-1.5 rounded-lg border border-white/10 focus:outline-none"
                >
                  <option value="">Default Camera</option>
                  {audioDevices.videoInputs.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        )}

        {/* Bottom Control Bar */}
        <div className="w-full bg-[#101720]/95 border-t border-[#242f3d] px-6 py-5 flex items-center justify-center">
          {session.state === 'incoming_ringing' ? (
            /* Incoming Call: Large Answer & Decline Buttons */
            <div className="flex items-center space-x-12">
              <button
                type="button"
                onClick={() => webrtcManager.rejectCall()}
                className="flex flex-col items-center space-y-1.5 group cursor-pointer"
              >
                <div className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center text-white shadow-xl shadow-red-600/30 transition-transform transform group-hover:scale-105 active:scale-95">
                  <PhoneOff size={28} />
                </div>
                <span className="text-xs text-slate-400 group-hover:text-red-400 font-medium">Decline</span>
              </button>

              <button
                type="button"
                onClick={() => webrtcManager.answerCall()}
                className="flex flex-col items-center space-y-1.5 group cursor-pointer"
              >
                <div className="w-16 h-16 rounded-full bg-emerald-600 hover:bg-emerald-700 flex items-center justify-center text-white shadow-xl shadow-emerald-600/30 transition-transform transform group-hover:scale-105 active:scale-95 animate-pulse">
                  <Phone size={28} />
                </div>
                <span className="text-xs text-slate-400 group-hover:text-emerald-400 font-medium">Accept</span>
              </button>
            </div>
          ) : session.state === 'outgoing_calling' || session.state === 'outgoing_ringing' ? (
            /* Outgoing Call Ringing: Cancel Button */
            <div className="flex items-center space-x-6">
              <button
                type="button"
                onClick={() => webrtcManager.hangupCall()}
                className="flex items-center gap-2 px-6 py-3 rounded-full bg-red-600 hover:bg-red-700 text-white font-semibold text-sm shadow-xl shadow-red-600/30 transition-transform transform hover:scale-105 active:scale-95 cursor-pointer"
              >
                <PhoneOff size={18} />
                <span>Cancel Call</span>
              </button>
            </div>
          ) : (
            /* Active Call Controls */
            <div className="flex items-center space-x-4 sm:space-x-5">
              {/* Mute Mic */}
              <button
                type="button"
                onClick={() => webrtcManager.toggleMute()}
                className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                  session.isMuted
                    ? 'bg-red-600/25 text-red-400 border border-red-500/50 hover:bg-red-600/35'
                    : 'bg-[#242f3d] text-slate-200 hover:bg-[#2c3949] border border-white/5'
                }`}
                title={session.isMuted ? 'Unmute Microphone' : 'Mute Microphone'}
              >
                {session.isMuted ? <MicOff size={20} /> : <Mic size={20} />}
              </button>

              {/* Toggle Video */}
              <button
                type="button"
                onClick={() => webrtcManager.toggleVideo()}
                className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                  session.isVideoOff || session.callType !== 'video'
                    ? 'bg-[#242f3d] text-slate-400 hover:bg-[#2c3949] border border-white/5'
                    : 'bg-[#24A1DE] text-white shadow-[#24A1DE]/30'
                }`}
                title={session.isVideoOff ? 'Enable Camera' : 'Disable Camera'}
              >
                {session.isVideoOff || session.callType !== 'video' ? <VideoOff size={20} /> : <Video size={20} />}
              </button>

              {/* Screen Sharing */}
              {session.state === 'connected' && (
                <button
                  type="button"
                  onClick={() => webrtcManager.toggleScreenShare()}
                  className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                    session.isScreenSharing
                      ? 'bg-blue-600 text-white shadow-blue-500/30'
                      : 'bg-[#242f3d] text-slate-200 hover:bg-[#2c3949] border border-white/5'
                  }`}
                  title={session.isScreenSharing ? 'Stop Screen Share' : 'Share Screen'}
                >
                  <Monitor size={20} />
                </button>
              )}

              {/* Speaker / Device Settings */}
              <button
                type="button"
                onClick={() => setShowDeviceSettings(!showDeviceSettings)}
                className={`p-3.5 sm:p-4 rounded-full transition-all shadow-md cursor-pointer ${
                  showDeviceSettings
                    ? 'bg-[#24A1DE] text-white'
                    : 'bg-[#242f3d] text-slate-200 hover:bg-[#2c3949] border border-white/5'
                }`}
                title="Audio & Video Devices"
              >
                <Volume2 size={20} />
              </button>

              {/* End Call */}
              <button
                type="button"
                onClick={() => webrtcManager.hangupCall()}
                className="p-3.5 sm:p-4 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-xl shadow-red-600/30 transition-transform hover:scale-105 active:scale-95 cursor-pointer ml-2"
                title="End Call"
              >
                <PhoneOff size={22} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
