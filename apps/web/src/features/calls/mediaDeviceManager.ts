// Media Device Manager for SENORA
// Manages real microphone, camera, and speaker enumeration, selection, persistence, and routing

export interface MediaDeviceState {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  selectedAudioInputId: string;
  selectedAudioOutputId: string;
  selectedVideoInputId: string;
  hasAudioPermission: boolean;
  hasVideoPermission: boolean;
  isSinkIdSupported: boolean;
}

const STORAGE_KEY_AUDIO_INPUT = 'senora_audio_input_id';
const STORAGE_KEY_AUDIO_OUTPUT = 'senora_audio_output_id';
const STORAGE_KEY_VIDEO_INPUT = 'senora_video_input_id';

export const STUDIO_AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: { ideal: true },
  noiseSuppression: { ideal: true },
  autoGainControl: { ideal: true },
  sampleRate: { ideal: 48000 },
  channelCount: { ideal: 2 },
};

class MediaDeviceManager {
  private audioInputs: MediaDeviceInfo[] = [];
  private audioOutputs: MediaDeviceInfo[] = [];
  private videoInputs: MediaDeviceInfo[] = [];
  private listeners: Set<(state: MediaDeviceState) => void> = new Set();
  private initialized = false;

  constructor() {
    if (typeof window !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        this.enumerateDevices().catch((e) => console.warn('[MediaDeviceManager] devicechange error:', e));
      });
    }
  }

  // Check if HTMLMediaElement.setSinkId is supported in current browser
  isSinkIdSupported(): boolean {
    if (typeof window === 'undefined' || typeof HTMLMediaElement === 'undefined') return false;
    return typeof (HTMLMediaElement.prototype as any)?.setSinkId === 'function';
  }

  // Get current stored selection or default
  getSelectedAudioInputId(): string {
    return localStorage.getItem(STORAGE_KEY_AUDIO_INPUT) || '';
  }

  getSelectedAudioOutputId(): string {
    return localStorage.getItem(STORAGE_KEY_AUDIO_OUTPUT) || '';
  }

  getSelectedVideoInputId(): string {
    return localStorage.getItem(STORAGE_KEY_VIDEO_INPUT) || '';
  }

  setSelectedAudioInputId(deviceId: string): void {
    localStorage.setItem(STORAGE_KEY_AUDIO_INPUT, deviceId);
    this.notify();
  }

  setSelectedAudioOutputId(deviceId: string): void {
    localStorage.setItem(STORAGE_KEY_AUDIO_OUTPUT, deviceId);
    this.notify();
  }

  setSelectedVideoInputId(deviceId: string): void {
    localStorage.setItem(STORAGE_KEY_VIDEO_INPUT, deviceId);
    this.notify();
  }

  // Enumerate all available audio and video devices
  async enumerateDevices(): Promise<{
    audioInputs: MediaDeviceInfo[];
    audioOutputs: MediaDeviceInfo[];
    videoInputs: MediaDeviceInfo[];
  }> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
      return { audioInputs: [], audioOutputs: [], videoInputs: [] };
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputs = devices.filter((d) => d.kind === 'audioinput');
      this.audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
      this.videoInputs = devices.filter((d) => d.kind === 'videoinput');

      // Verify that selected IDs still exist, otherwise fallback gracefully
      const curAudioIn = this.getSelectedAudioInputId();
      if (curAudioIn && !this.audioInputs.some((d) => d.deviceId === curAudioIn)) {
        console.warn(`[MediaDeviceManager] Selected audio input ${curAudioIn} no longer available, falling back to default`);
      }

      const curAudioOut = this.getSelectedAudioOutputId();
      if (curAudioOut && !this.audioOutputs.some((d) => d.deviceId === curAudioOut)) {
        console.warn(`[MediaDeviceManager] Selected audio output ${curAudioOut} no longer available, falling back to default`);
      }

      const curVideoIn = this.getSelectedVideoInputId();
      if (curVideoIn && !this.videoInputs.some((d) => d.deviceId === curVideoIn)) {
        console.warn(`[MediaDeviceManager] Selected video input ${curVideoIn} no longer available, falling back to default`);
      }

      this.initialized = true;
      this.notify();

      return {
        audioInputs: this.audioInputs,
        audioOutputs: this.audioOutputs,
        videoInputs: this.videoInputs,
      };
    } catch (err) {
      console.warn('[MediaDeviceManager] enumerateDevices failed:', err);
      return { audioInputs: [], audioOutputs: [], videoInputs: [] };
    }
  }

  // Request real audio stream using selected (or override) microphone with studio-grade constraints
  async getAudioStream(extraConstraints?: MediaTrackConstraints, deviceIdOverride?: string): Promise<MediaStream> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('MediaDevices API is not supported in this environment');
    }

    const selectedId = deviceIdOverride !== undefined ? deviceIdOverride : this.getSelectedAudioInputId();
    const audioConstraint: MediaTrackConstraints = {
      ...STUDIO_AUDIO_CONSTRAINTS,
      ...extraConstraints,
    };

    if (selectedId) {
      audioConstraint.deviceId = { exact: selectedId };
    }

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioConstraint });
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        throw err;
      }
      // If exact deviceId or studio constraints fail, fallback gracefully
      console.warn(`[MediaDeviceManager] HD audio stream attempt failed, attempting fallback`, err);
      try {
        const fallbackConstraint: MediaTrackConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        if (selectedId) fallbackConstraint.deviceId = { ideal: selectedId };
        return await navigator.mediaDevices.getUserMedia({ audio: fallbackConstraint });
      } catch (err2: any) {
        if (err2?.name === 'NotAllowedError' || err2?.name === 'PermissionDeniedError') {
          throw err2;
        }
        return await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    }
  }

  // Request real video stream using selected (or override) camera
  async getVideoStream(extraConstraints?: MediaTrackConstraints, deviceIdOverride?: string): Promise<MediaStream> {
    if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('MediaDevices API is not supported in this environment');
    }

    const selectedId = deviceIdOverride !== undefined ? deviceIdOverride : this.getSelectedVideoInputId();
    const videoConstraint: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      ...extraConstraints,
    };

    if (selectedId) {
      videoConstraint.deviceId = { exact: selectedId };
    }

    try {
      return await navigator.mediaDevices.getUserMedia({ video: videoConstraint });
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        throw err;
      }
      console.warn(`[MediaDeviceManager] HD/specific camera failed, falling back to standard video`, err);
      return await navigator.mediaDevices.getUserMedia({ video: true });
    }
  }

  // Request combined video + audio stream (e.g. for round video notes)
  async getCombinedStream(
    videoConstraints?: MediaTrackConstraints,
    audioConstraints?: MediaTrackConstraints
  ): Promise<MediaStream> {
    const selectedVideoId = this.getSelectedVideoInputId();
    const selectedAudioId = this.getSelectedAudioInputId();

    const videoReq: MediaTrackConstraints = {
      facingMode: 'user',
      width: { ideal: 480 },
      height: { ideal: 480 },
      ...videoConstraints,
    };
    if (selectedVideoId) {
      videoReq.deviceId = { exact: selectedVideoId };
    }

    const audioReq: MediaTrackConstraints = {
      ...STUDIO_AUDIO_CONSTRAINTS,
      ...audioConstraints,
    };
    if (selectedAudioId) {
      audioReq.deviceId = { exact: selectedAudioId };
    }

    try {
      return await navigator.mediaDevices.getUserMedia({
        video: videoReq,
        audio: audioReq,
      });
    } catch (err) {
      console.warn('[MediaDeviceManager] Failed exact combined stream, falling back to default', err);
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } },
        audio: true,
      });
    }
  }

  // Apply selected audio output device to an HTMLMediaElement (audio or video)
  async applyAudioOutput(element: HTMLMediaElement | null): Promise<boolean> {
    if (!element || !this.isSinkIdSupported()) {
      return false;
    }

    const sinkId = this.getSelectedAudioOutputId();
    try {
      await (element as any).setSinkId(sinkId || '');
      return true;
    } catch (err) {
      console.warn(`[MediaDeviceManager] setSinkId('${sinkId}') failed:`, err);
      return false;
    }
  }

  // Real live microphone test with AudioContext and AnalyserNode
  async testMicrophone(onLevel: (level: number) => void): Promise<{ stop: () => void }> {
    const stream = await this.getAudioStream();
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;

    if (!AudioContextClass) {
      return {
        stop: () => {
          stream.getTracks().forEach((t) => t.stop());
        },
      };
    }

    const audioCtx = new AudioContextClass();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 64;
    source.connect(analyser);

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let isRunning = true;
    let animFrame: number;

    const checkLevel = () => {
      if (!isRunning) return;
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / dataArray.length;
      const normalizedLevel = Math.min(100, Math.round((avg / 255) * 100 * 2.5));
      onLevel(normalizedLevel);
      animFrame = requestAnimationFrame(checkLevel);
    };

    animFrame = requestAnimationFrame(checkLevel);

    const stop = () => {
      isRunning = false;
      cancelAnimationFrame(animFrame);
      try {
        source.disconnect();
        analyser.disconnect();
        audioCtx.close().catch(() => {});
      } catch {}
      stream.getTracks().forEach((track) => track.stop());
      onLevel(0);
    };

    return { stop };
  }

  // Play a pleasant diagnostic test chime through selected output sink
  async testAudioOutput(): Promise<void> {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    try {
      const audioCtx = new AudioContextClass();
      const dest = audioCtx.createMediaStreamDestination();

      const playTone = (freq: number, startTime: number, duration: number) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startTime);

        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.exponentialRampToValueAtTime(0.3, startTime + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

        osc.connect(gain);
        gain.connect(audioCtx.destination);
        gain.connect(dest);

        osc.start(startTime);
        osc.stop(startTime + duration);
      };

      const now = audioCtx.currentTime;
      playTone(523.25, now, 0.2); // C5
      playTone(659.25, now + 0.15, 0.2); // E5
      playTone(783.99, now + 0.3, 0.4); // G5

      // Route through an audio element with setSinkId if supported
      if (this.isSinkIdSupported()) {
        const audio = new Audio();
        audio.srcObject = dest.stream;
        await this.applyAudioOutput(audio);
        audio.play().catch(() => {});
        setTimeout(() => {
          audio.pause();
          audio.srcObject = null;
        }, 1000);
      }

      setTimeout(() => {
        audioCtx.close().catch(() => {});
      }, 1000);
    } catch (e) {
      console.warn('[MediaDeviceManager] testAudioOutput failed:', e);
    }
  }

  // Real live camera test with preview element
  async testCamera(videoElement: HTMLVideoElement): Promise<{ stop: () => void }> {
    const stream = await this.getVideoStream();
    videoElement.srcObject = stream;
    videoElement.play().catch(() => {});
    const stop = () => {
      videoElement.srcObject = null;
      stream.getTracks().forEach((track) => track.stop());
    };
    return { stop };
  }

  // Check hardware permission state using navigator.permissions API
  async checkPermissions(): Promise<{ audio: PermissionState | 'unknown'; video: PermissionState | 'unknown' }> {
    const res: { audio: PermissionState | 'unknown'; video: PermissionState | 'unknown' } = {
      audio: 'unknown',
      video: 'unknown',
    };
    if (typeof navigator !== 'undefined' && navigator.permissions?.query) {
      try {
        const audioStatus = await navigator.permissions.query({ name: 'microphone' as any });
        res.audio = audioStatus.state;
      } catch {}
      try {
        const videoStatus = await navigator.permissions.query({ name: 'camera' as any });
        res.video = videoStatus.state;
      } catch {}
    }
    return res;
  }

  getState(): MediaDeviceState {
    return {
      audioInputs: this.audioInputs,
      audioOutputs: this.audioOutputs,
      videoInputs: this.videoInputs,
      selectedAudioInputId: this.getSelectedAudioInputId(),
      selectedAudioOutputId: this.getSelectedAudioOutputId(),
      selectedVideoInputId: this.getSelectedVideoInputId(),
      hasAudioPermission: this.audioInputs.length > 0 && !!this.audioInputs[0].label,
      hasVideoPermission: this.videoInputs.length > 0 && !!this.videoInputs[0].label,
      isSinkIdSupported: this.isSinkIdSupported(),
    };
  }

  subscribe(listener: (state: MediaDeviceState) => void): () => void {
    this.listeners.add(listener);
    if (!this.initialized) {
      this.enumerateDevices();
    }
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const state = this.getState();
    this.listeners.forEach((l) => l(state));
  }
}

export const mediaDeviceManager = new MediaDeviceManager();
