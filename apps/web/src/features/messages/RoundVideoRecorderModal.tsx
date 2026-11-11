import { uiText, useUILanguage } from "../../app/language";
import React, { useState, useEffect, useRef } from 'react';
import { X, Send, Square, RefreshCw } from 'lucide-react';
import { mediaDeviceManager } from '../calls/mediaDeviceManager';

interface RoundVideoRecorderModalProps {
  onSend: (videoBlob: Blob, durationSeconds: number) => void;
  onCancel: () => void;
  sending?: boolean;
}

export const RoundVideoRecorderModal: React.FC<RoundVideoRecorderModalProps> = ({
  onSend,
  onCancel,
  sending,
}) => {
  const uiLang = useUILanguage();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const videoLiveRef = useRef<HTMLVideoElement>(null);
  const videoPreviewRef = useRef<HTMLVideoElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);

  // Initialize camera stream
  useEffect(() => {
    let activeStream: MediaStream | null = null;
    mediaDeviceManager
      .getCombinedStream()
      .then((s) => {
        activeStream = s;
        setStream(s);
        if (videoLiveRef.current) {
          videoLiveRef.current.srcObject = s;
        }
      })
      .catch((e) => {
        alert(uiText("Could not access camera/microphone: ", uiLang) + e.message);
        onCancel();
      });

    return () => {
      if (activeStream) {
        activeStream.getTracks().forEach((track) => track.stop());
      }
      clearInterval(timerRef.current);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, []);

  const startRecording = () => {
    if (!stream) return;
    chunksRef.current = [];
    setSeconds(0);

    const options = { mimeType: 'video/webm;codecs=vp8,opus' };
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch {
      recorder = new MediaRecorder(stream);
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };

    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: 'video/webm' });
      setRecordedBlob(blob);
      const url = URL.createObjectURL(blob);
      setPreviewUrl(url);
      if (videoPreviewRef.current) {
        mediaDeviceManager.applyAudioOutput(videoPreviewRef.current);
      }
    };

    recorder.start(250);
    mediaRecorderRef.current = recorder;
    setIsRecording(true);

    timerRef.current = setInterval(() => {
      setSeconds((prev) => {
        if (prev >= 59) {
          stopRecording();
          return 60;
        }
        return prev + 1;
      });
    }, 1000);
  };

  const stopRecording = () => {
    clearInterval(timerRef.current);
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const handleRetake = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setRecordedBlob(null);
    setPreviewUrl(null);
    setSeconds(0);
    if (videoLiveRef.current && stream) {
      videoLiveRef.current.srcObject = stream;
    }
  };

  const handleSend = () => {
    if (!recordedBlob || sending) return;
    onSend(recordedBlob, seconds || 1);
  };

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-md p-2 sm:p-4 animate-fadeIn">
      <div className="relative w-full max-w-sm bg-slate-900 border border-slate-700/80 rounded-3xl p-4 sm:p-6 flex flex-col items-center space-y-4 sm:space-y-6 shadow-2xl">
        {/* Top Header */}
        <div className="w-full flex items-center justify-between">
          <span className="text-sm font-bold text-white tracking-wide">{uiText("Video Note", uiLang)}</span>
          <button
            onClick={onCancel}
            disabled={sending}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Circular Viewfinder */}
        <div className="relative w-48 h-48 sm:w-64 sm:h-64 rounded-full overflow-hidden border-4 border-primary-500 shadow-2xl bg-black flex items-center justify-center group">
          {previewUrl ? (
            <video
              ref={videoPreviewRef}
              src={previewUrl}
              autoPlay
              loop
              playsInline
              className="w-full h-full object-cover rounded-full"
            />
          ) : (
            <video
              ref={videoLiveRef}
              autoPlay
              muted
              playsInline
              className="w-full h-full object-cover rounded-full transform -scale-x-100"
            />
          )}

          {/* Recording pulse overlay */}
          {isRecording && (
            <div className="absolute inset-0 rounded-full border-4 border-red-500 animate-pulse pointer-events-none" />
          )}

          {/* Timer badge */}
          <div className="absolute bottom-4 px-3 py-1 bg-black/70 backdrop-blur-md rounded-full text-xs font-mono font-bold text-white shadow">
            {formatTime(seconds)} / 1:00
          </div>
        </div>

        {/* Controls */}
        <div className="w-full flex items-center justify-center space-x-6">
          {!recordedBlob ? (
            !isRecording ? (
              <button
                onClick={startRecording}
                className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center text-white shadow-xl shadow-red-600/40 transition-transform hover:scale-105 active:scale-95"
                title={uiText("Start Recording", uiLang)}
              >
                <div className="w-6 h-6 rounded-full bg-white" />
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="w-16 h-16 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center text-white shadow-xl shadow-red-600/40 transition-transform hover:scale-105 active:scale-95"
                title={uiText("Stop Recording", uiLang)}
              >
                <Square size={24} className="fill-white" />
              </button>
            )
          ) : (
            /* Post recording review buttons */
            <div className="flex items-center space-x-6">
              <button
                onClick={handleRetake}
                disabled={sending}
                className="p-3.5 rounded-full bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white border border-slate-700 shadow-md transition-colors"
                title={uiText("Retake", uiLang)}
              >
                <RefreshCw size={20} />
              </button>

              <button
                onClick={handleSend}
                disabled={sending}
                className="flex items-center space-x-2 px-6 py-3.5 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 text-white text-xs font-bold rounded-2xl shadow-xl shadow-primary-600/30 transition-transform hover:scale-105 active:scale-95"
              >
                {sending ? (
                  <span>{uiText("Encrypting...", uiLang)}</span>
                ) : (
                  <>
                    <Send size={16} />
                    <span>{uiText("Send Video Note", uiLang)}</span>
                  </>
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
