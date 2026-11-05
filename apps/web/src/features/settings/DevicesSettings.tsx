import React, { useState, useEffect, useRef } from 'react';
import { mediaDeviceManager, MediaDeviceState } from '../calls/mediaDeviceManager';
import { Language, translations } from '../../app/i18n';
import {
  Mic,
  Volume2,
  Video,
  Play,
  Square,
  HelpCircle,
  RefreshCw,
  Sliders
} from 'lucide-react';

interface DevicesSettingsProps {
  lang: Language;
}

export const DevicesSettings: React.FC<DevicesSettingsProps> = ({ lang }) => {
  const t = translations[lang];
  const [deviceState, setDeviceState] = useState<MediaDeviceState>(mediaDeviceManager.getState());
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [micTestStop, setMicTestStop] = useState<(() => void) | null>(null);

  const [isPlayingTestSound, setIsPlayingTestSound] = useState(false);
  const [isTestingCamera, setIsTestingCamera] = useState(false);
  const [cameraTestStop, setCameraTestStop] = useState<(() => void) | null>(null);
  const cameraVideoRef = useRef<HTMLVideoElement | null>(null);

  const [permissions, setPermissions] = useState<{ audio: string; video: string }>({
    audio: 'unknown',
    video: 'unknown',
  });

  useEffect(() => {
    const unsub = mediaDeviceManager.subscribe((state) => {
      setDeviceState(state);
    });
    mediaDeviceManager.checkPermissions().then(setPermissions);
    return () => {
      unsub();
      if (micTestStop) micTestStop();
      if (cameraTestStop) cameraTestStop();
    };
  }, []);

  const handleStartMicTest = async () => {
    if (isTestingMic) {
      if (micTestStop) micTestStop();
      setIsTestingMic(false);
      setMicLevel(0);
      setMicTestStop(null);
      return;
    }

    try {
      setIsTestingMic(true);
      const test = await mediaDeviceManager.testMicrophone((level) => {
        setMicLevel(level);
      });
      setMicTestStop(() => test.stop);
      // Refresh permissions
      mediaDeviceManager.checkPermissions().then(setPermissions);
    } catch (err: any) {
      alert('Could not start microphone test: ' + err.message);
      setIsTestingMic(false);
      setMicLevel(0);
    }
  };

  const handlePlaySoundTest = async () => {
    setIsPlayingTestSound(true);
    await mediaDeviceManager.testAudioOutput();
    setTimeout(() => setIsPlayingTestSound(false), 1200);
  };

  const handleToggleCameraTest = async () => {
    if (isTestingCamera) {
      if (cameraTestStop) cameraTestStop();
      setIsTestingCamera(false);
      setCameraTestStop(null);
      return;
    }

    setIsTestingCamera(true);
    setTimeout(async () => {
      if (cameraVideoRef.current) {
        try {
          const test = await mediaDeviceManager.testCamera(cameraVideoRef.current);
          setCameraTestStop(() => test.stop);
          mediaDeviceManager.checkPermissions().then(setPermissions);
        } catch (err: any) {
          alert('Could not start camera test: ' + err.message);
          setIsTestingCamera(false);
        }
      }
    }, 50);
  };

  const handleRefreshDevices = async () => {
    await mediaDeviceManager.enumerateDevices();
    mediaDeviceManager.checkPermissions().then(setPermissions);
  };

  return (
    <div className="space-y-6 text-xs text-white">
      {/* Header with refresh */}
      <div className="flex items-center justify-between pb-3 border-b border-[#242f3d]">
        <div>
          <h3 className="text-sm font-bold text-white">{t.settings_devices_media}</h3>
          <p className="text-[11px] text-[#7f91a4] mt-0.5">
            Configure real input/output hardware for voice notes, calls, and video messages
          </p>
        </div>
        <button
          type="button"
          onClick={handleRefreshDevices}
          className="px-2.5 py-1.5 rounded-lg bg-[#242f3d] hover:bg-[#2b3a4a] text-[#7f91a4] hover:text-white transition flex items-center gap-1.5 cursor-pointer"
          title="Refresh Device List"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          <span>Refresh</span>
        </button>
      </div>

      {/* 1. Audio Input (Microphone) */}
      <div className="p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] space-y-3">
        <div className="flex items-center gap-2 text-amber-400 font-semibold text-xs">
          <Mic className="h-4 w-4" />
          <span>{t.mic_input}</span>
        </div>

        <div>
          <select
            value={deviceState.selectedAudioInputId}
            onChange={(e) => mediaDeviceManager.setSelectedAudioInputId(e.target.value)}
            className="w-full rounded-xl bg-[#17212b] border border-[#242f3d] px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
          >
            <option value="">Default - System Microphone</option>
            {deviceState.audioInputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </div>

        {/* Live Mic Test & Input Level Meter */}
        <div className="p-3 rounded-lg bg-[#17212b]/80 border border-[#242f3d] flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-[#7f91a4]">{t.mic_level}</span>
            <button
              type="button"
              onClick={handleStartMicTest}
              className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
                isTestingMic
                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                  : 'bg-[#24A1DE] text-white hover:bg-[#208fc4]'
              }`}
            >
              {isTestingMic ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              <span>{isTestingMic ? t.stop_test : t.test_mic}</span>
            </button>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-3 rounded-full bg-[#242f3d] overflow-hidden p-0.5">
              <div
                className={`h-full rounded-full transition-all duration-75 ${
                  micLevel > 70 ? 'bg-red-500' : micLevel > 35 ? 'bg-emerald-400' : 'bg-[#24A1DE]'
                }`}
                style={{ width: `${isTestingMic ? micLevel : 0}%` }}
              />
            </div>
            <span className="font-mono text-[11px] text-[#7f91a4] w-8 text-right">
              {isTestingMic ? `${micLevel}%` : '0%'}
            </span>
          </div>
        </div>
      </div>

      {/* 2. Audio Output (Speakers / Headphones) */}
      <div className="p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[#24A1DE] font-semibold text-xs">
            <Volume2 className="h-4 w-4" />
            <span>{t.speaker_output}</span>
          </div>
          <span
            className={`px-2 py-0.5 rounded text-[10px] font-bold ${
              deviceState.isSinkIdSupported
                ? 'bg-emerald-500/20 text-emerald-400'
                : 'bg-amber-500/20 text-amber-400'
            }`}
          >
            {deviceState.isSinkIdSupported ? 'setSinkId Supported' : 'Standard Output Only'}
          </span>
        </div>

        <div>
          <select
            value={deviceState.selectedAudioOutputId}
            onChange={(e) => mediaDeviceManager.setSelectedAudioOutputId(e.target.value)}
            disabled={!deviceState.isSinkIdSupported}
            className="w-full rounded-xl bg-[#17212b] border border-[#242f3d] px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE] disabled:opacity-60"
          >
            <option value="">Default - System Output</option>
            {deviceState.audioOutputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Speaker / Headphone ${i + 1}`}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between pt-1">
          <p className="text-[11px] text-[#7f91a4] max-w-xs">
            {deviceState.isSinkIdSupported ? t.sink_supported : t.sink_unsupported}
          </p>
          <button
            type="button"
            onClick={handlePlaySoundTest}
            disabled={isPlayingTestSound}
            className="px-3 py-1.5 rounded-lg bg-[#242f3d] hover:bg-[#208fc4] hover:text-white text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer disabled:opacity-50"
          >
            <Volume2 className="h-3.5 w-3.5" />
            <span>{isPlayingTestSound ? 'Playing Chime...' : t.test_sound}</span>
          </button>
        </div>
      </div>

      {/* 3. Video Input (Camera) */}
      <div className="p-4 rounded-xl bg-[#242f3d]/40 border border-[#242f3d] space-y-3">
        <div className="flex items-center gap-2 text-purple-400 font-semibold text-xs">
          <Video className="h-4 w-4" />
          <span>{t.camera_input}</span>
        </div>

        <div>
          <select
            value={deviceState.selectedVideoInputId}
            onChange={(e) => mediaDeviceManager.setSelectedVideoInputId(e.target.value)}
            className="w-full rounded-xl bg-[#17212b] border border-[#242f3d] px-3 py-2 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#24A1DE]"
          >
            <option value="">Default - Front / User Camera</option>
            {deviceState.videoInputs.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {d.label || `Camera ${i + 1}`}
              </option>
            ))}
          </select>
        </div>

        {/* Live Camera Preview */}
        <div className="flex flex-col items-center gap-3 pt-1">
          {isTestingCamera ? (
            <div className="relative w-48 h-48 rounded-full overflow-hidden border-2 border-[#24A1DE] shadow-xl bg-black">
              <video
                ref={cameraVideoRef}
                autoPlay
                muted
                playsInline
                className="w-full h-full object-cover transform -scale-x-100"
              />
            </div>
          ) : null}

          <button
            type="button"
            onClick={handleToggleCameraTest}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition cursor-pointer ${
              isTestingCamera
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30'
                : 'bg-[#242f3d] text-white hover:bg-[#208fc4]'
            }`}
          >
            {isTestingCamera ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            <span>{isTestingCamera ? 'Stop Camera Preview' : t.test_camera}</span>
          </button>
        </div>
      </div>

      {/* 4. Permissions & Hardware Capabilities Status */}
      <div className="p-4 rounded-xl bg-[#17212b] border border-[#242f3d] space-y-2.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-300">
          <Sliders className="h-3.5 w-3.5 text-[#24A1DE]" />
          <span>Device Permissions & Capability Status</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 text-[11px]">
          <div className="p-2.5 rounded-lg bg-[#242f3d]/50 flex items-center justify-between">
            <span className="text-[#7f91a4]">Microphone</span>
            <span
              className={`font-semibold capitalize ${
                permissions.audio === 'granted'
                  ? 'text-emerald-400'
                  : permissions.audio === 'denied'
                  ? 'text-red-400'
                  : 'text-amber-400'
              }`}
            >
              {permissions.audio}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-[#242f3d]/50 flex items-center justify-between">
            <span className="text-[#7f91a4]">Camera</span>
            <span
              className={`font-semibold capitalize ${
                permissions.video === 'granted'
                  ? 'text-emerald-400'
                  : permissions.video === 'denied'
                  ? 'text-red-400'
                  : 'text-amber-400'
              }`}
            >
              {permissions.video}
            </span>
          </div>

          <div className="p-2.5 rounded-lg bg-[#242f3d]/50 flex items-center justify-between">
            <span className="text-[#7f91a4]">Audio Sink ID</span>
            <span
              className={`font-semibold ${
                deviceState.isSinkIdSupported ? 'text-emerald-400' : 'text-slate-400'
              }`}
            >
              {deviceState.isSinkIdSupported ? 'Available' : 'Fallback'}
            </span>
          </div>
        </div>
      </div>

      {/* Troubleshooting Tips */}
      <div className="p-3.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-[#7f91a4] text-[11px] flex gap-2.5">
        <HelpCircle className="h-4 w-4 text-[#24A1DE] flex-shrink-0 mt-0.5" />
        <div className="space-y-1">
          <span className="font-semibold text-white">Device Troubleshooting</span>
          <p className="leading-relaxed">
            If device labels appear as "Microphone 1" or permissions are blocked, click the lock icon in your browser address bar to allow microphone and camera access for Senora.
          </p>
        </div>
      </div>
    </div>
  );
};
