import { CallSignal } from '../../app/types';
import { wsManager } from '../../protocol/ws';
import { api } from '../../protocol/api';
import { soundManager } from './soundManager';
import { STUDIO_AUDIO_CONSTRAINTS } from './mediaDeviceManager';

export type ScreenQualityPreset = 'auto' | '1080p' | '720p' | '480p';

export type CallState = 
  | 'idle' 
  | 'outgoing_calling' 
  | 'outgoing_ringing'
  | 'incoming_ringing' 
  | 'connecting' 
  | 'connected' 
  | 'ended' 
  | 'rejected'
  | 'timeout'
  | 'cancelled';

export interface CallSession {
  callId: string;
  conversationId: string;
  peerId: string;
  peerName: string;
  peerAvatarUrl?: string;
  callType: 'audio' | 'video';
  isIncoming: boolean;
  state: CallState;
  startTime?: number;
  durationSeconds: number;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  screenStream?: MediaStream;
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing?: boolean;
  peerScreenSharing?: boolean;
  hasRemoteVideo?: boolean;
  autoplayBlocked?: boolean;
  screenQuality?: ScreenQualityPreset;
}

export type CallEventListener = (session: CallSession | null) => void;

// Professional Opus SDP Optimizer: enriches Opus with stereo, 128/256kbps HD audio, inband FEC, disables DTX clipping
export function optimizeOpusSdp(sdp: string, isScreenShare: boolean = false): string {
  if (!sdp) return sdp;
  try {
    const lines = sdp.split(/\r\n|\n/);
    let opusPt: string | null = null;

    // 1. Locate Opus payload type
    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000/i);
      if (match) {
        opusPt = match[1];
        break;
      }
    }

    const targetBitrate = isScreenShare ? 256000 : 128000;
    const opusParams = `minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${targetBitrate};cbr=0;usedtx=0`;

    let fmtpFound = false;
    const modifiedLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (opusPt && line.startsWith(`a=fmtp:${opusPt} `)) {
        fmtpFound = true;
        const prefix = `a=fmtp:${opusPt} `;
        const existing = line.substring(prefix.length).trim();
        const blacklist = ['minptime', 'useinbandfec', 'stereo', 'sprop-stereo', 'maxaveragebitrate', 'cbr', 'usedtx'];
        const parts = existing
          .split(';')
          .map((p) => p.trim())
          .filter((p) => {
            const key = p.split('=')[0]?.trim().toLowerCase();
            return key && !blacklist.includes(key);
          });
        parts.push(opusParams);
        modifiedLines.push(`${prefix}${parts.join(';')}`);
        continue;
      }

      modifiedLines.push(line);
    }

    if (opusPt && !fmtpFound) {
      const rtpIndex = modifiedLines.findIndex((l) => l.startsWith(`a=rtpmap:${opusPt}`));
      if (rtpIndex !== -1) {
        modifiedLines.splice(rtpIndex + 1, 0, `a=fmtp:${opusPt} ${opusParams}`);
      }
    }

    // 2. Set bandwidth on audio media section (b=AS:128 or b=AS:256)
    let inAudio = false;
    const finalLines: string[] = [];
    for (let i = 0; i < modifiedLines.length; i++) {
      const line = modifiedLines[i];
      if (line.startsWith('m=audio')) {
        inAudio = true;
        finalLines.push(line);
        finalLines.push(`b=AS:${isScreenShare ? 256 : 128}`);
        continue;
      }
      if (line.startsWith('m=video') || line.startsWith('m=application')) {
        inAudio = false;
      }
      if (inAudio && line.startsWith('b=AS:')) {
        continue;
      }
      finalLines.push(line);
    }

    return finalLines.join('\r\n');
  } catch (err) {
    console.warn('[WebRTC] optimizeOpusSdp error:', err);
    return sdp;
  }
}

export class RingtonePlayer {
  private audioCtx: AudioContext | null = null;
  private isRinging: boolean = false;
  private intervalId: any = null;
  private activeNodes: { osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode } | null = null;

  async start(onAutoplayBlocked?: () => void) {
    if (this.isRinging) return;
    this.isRinging = true;

    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new AudioCtx();
      }

      if (this.audioCtx.state === 'suspended') {
        try {
          await this.audioCtx.resume();
        } catch {
          if (onAutoplayBlocked) onAutoplayBlocked();
          return;
        }
      }

      if (this.audioCtx.state === 'suspended') {
        if (onAutoplayBlocked) onAutoplayBlocked();
        return;
      }

      this.playRingCycle();
      this.intervalId = setInterval(() => {
        if (!this.isRinging) return;
        this.playRingCycle();
      }, 3500);
    } catch (e) {
      console.warn('Ringtone init error:', e);
      if (onAutoplayBlocked) onAutoplayBlocked();
    }
  }

  private playRingCycle() {
    if (!this.audioCtx || this.audioCtx.state !== 'running' || !this.isRinging) return;

    try {
      // Standard North American/European dual tone: 440 Hz + 480 Hz
      const osc1 = this.audioCtx.createOscillator();
      const osc2 = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(440, this.audioCtx.currentTime);
      osc2.frequency.setValueAtTime(480, this.audioCtx.currentTime);

      const now = this.audioCtx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
      gain.gain.setValueAtTime(0.15, now + 0.8);
      gain.gain.linearRampToValueAtTime(0, now + 0.85);

      gain.gain.setValueAtTime(0, now + 1.25);
      gain.gain.linearRampToValueAtTime(0.15, now + 1.3);
      gain.gain.setValueAtTime(0.15, now + 2.0);
      gain.gain.linearRampToValueAtTime(0, now + 2.05);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 2.1);
      osc2.stop(now + 2.1);

      this.activeNodes = { osc1, osc2, gain };
    } catch (err) {
      console.warn('Ring cycle error:', err);
    }
  }

  async resume() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch {}
    }
    if (this.isRinging && this.audioCtx?.state === 'running') {
      this.playRingCycle();
    }
  }

  stop() {
    this.isRinging = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    if (this.activeNodes) {
      try {
        this.activeNodes.gain.gain.setValueAtTime(0, this.audioCtx?.currentTime || 0);
        this.activeNodes.osc1.stop();
        this.activeNodes.osc2.stop();
      } catch {}
      this.activeNodes = null;
    }
  }
}

class WebRTCManager {
  private peerConnection: RTCPeerConnection | null = null;
  private currentSession: CallSession | null = null;
  private screenStream: MediaStream | null = null;
  private listeners: Set<CallEventListener> = new Set();
  private durationTimer: any = null;
  private ringingTimeoutTimer: any = null;
  private cleanupTimer: any = null;
  private unsubscribeWs: (() => void) | null = null;
  private loggedCallIds = new Set<string>();
  private currentUserId: string = '';
  private iceCandidateQueue: RTCIceCandidateInit[] = [];
  private screenAudioContext: AudioContext | null = null;
  private originalMicTrack: MediaStreamTrack | null = null;

  resetSession(): void {
    this.clearRingingTimeout();
    this.stopRingingEffects();
    this.iceCandidateQueue = [];
    if (this.screenAudioContext) {
      try {
        this.screenAudioContext.close();
      } catch {}
      this.screenAudioContext = null;
    }
    this.originalMicTrack = null;
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.currentSession = null;
    this.notify();
  }

  setUserId(id: string) {
    this.currentUserId = id;
  }

  private clearRingingTimeout() {
    if (this.ringingTimeoutTimer) {
      clearTimeout(this.ringingTimeoutTimer);
      this.ringingTimeoutTimer = null;
    }
  }

  private startRingingEffects(isIncoming: boolean) {
    if (isIncoming) {
      soundManager.startIncomingRingtone(() => {
        if (this.currentSession) {
          this.currentSession.autoplayBlocked = true;
          this.notify();
        }
      });
      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate([200, 100, 200, 100, 200]);
        } catch {}
      }
    } else {
      soundManager.startOutgoingRingback(() => {
        if (this.currentSession) {
          this.currentSession.autoplayBlocked = true;
          this.notify();
        }
      });
    }
  }

  private stopRingingEffects() {
    soundManager.stopAll();
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(0);
      } catch {}
    }
  }

  private async persistCallEvent(outcome: 'completed' | 'missed' | 'declined' | 'cancelled', duration: number = 0) {
    if (!this.currentSession) return;
    const { conversationId, callId, callType } = this.currentSession;
    if (!callId || this.loggedCallIds.has(callId)) return;
    this.loggedCallIds.add(callId);

    const isVideo = callType === 'video';
    const text = isVideo
      ? (outcome === 'completed' ? `Video Call (${duration}s)` : outcome === 'missed' ? 'Missed Video Call' : outcome === 'declined' ? 'Declined Video Call' : 'Cancelled Video Call')
      : (outcome === 'completed' ? `Voice Call (${duration}s)` : outcome === 'missed' ? 'Missed Voice Call' : outcome === 'declined' ? 'Declined Voice Call' : 'Cancelled Voice Call');

    const payload = {
      type: 'call_event',
      call_id: callId,
      call_type: isVideo ? 'video' : 'audio',
      outcome,
      duration_seconds: duration,
      text,
    };

    try {
      await api.submitMessage(conversationId, {
        ciphertext: JSON.stringify(payload),
        nonce: 'system',
        idempotency_key: `call_event_${callId}`,
      });
    } catch (e) {
      console.warn('Failed to persist call event:', e);
    }
  }

  private rtcConfig: RTCConfiguration = {
    iceServers: [
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun2.l.google.com:19302',
          'stun:stun.cloudflare.com:3478',
          'stun:stun.services.mozilla.com:3478',
          'stun:stun.nextcloud.com:443',
        ],
      },
    ],
    iceCandidatePoolSize: 2,
  };

  setIceServers(servers: RTCIceServer[]) {
    this.rtcConfig.iceServers = servers;
  }

  getIceServers(): RTCIceServer[] {
    return this.rtcConfig.iceServers || [];
  }

  init() {
    if (this.unsubscribeWs) return;

    this.unsubscribeWs = wsManager.subscribe((event) => {
      if (event.type === 'call.signal') {
        this.handleIncomingSignal(event.payload as CallSignal);
      }
    });

    api.getIceServers().then((servers) => {
      if (servers && Array.isArray(servers) && servers.length > 0) {
        const fallbackUrls = [
          'stun:stun.l.google.com:19302',
          'stun:stun1.l.google.com:19302',
          'stun:stun.cloudflare.com:3478',
          'stun:stun.services.mozilla.com:3478',
          'stun:stun.nextcloud.com:443',
        ];
        this.setIceServers([
          ...servers as RTCIceServer[],
          { urls: fallbackUrls },
        ]);
      }
    }).catch((e) => {
      console.warn('[WebRTC] Falling back to default ICE servers:', e);
    });
  }

  subscribe(listener: CallEventListener): () => void {
    this.listeners.add(listener);
    listener(this.currentSession);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    for (const listener of this.listeners) {
      listener(this.currentSession ? { ...this.currentSession } : null);
    }
  }

  getSession(): CallSession | null {
    return this.currentSession;
  }

  // Start outgoing call
  async startCall(
    conversationId: string, 
    peerId: string, 
    peerName: string, 
    callType: 'audio' | 'video',
    peerAvatarUrl?: string,
    callerAvatarUrl?: string,
    callerName?: string
  ): Promise<void> {
    this.init();
    if (this.currentSession) {
      console.warn('Call already in progress');
      return;
    }

    const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    let localStream: MediaStream | undefined;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: STUDIO_AUDIO_CONSTRAINTS,
        video: callType === 'video' ? {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        } : false,
      });
    } catch (e: any) {
      console.warn('Initial HD media constraints failed, falling back to standard audio:', e);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: callType === 'video',
        });
      } catch (fallbackErr: any) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: callType === 'video',
          });
        } catch (finalErr: any) {
          console.error('Failed to get media devices:', finalErr);
          alert('Could not access microphone/camera: ' + (finalErr.message || 'Permission denied'));
          return;
        }
      }
    }

    this.currentSession = {
      callId,
      conversationId,
      peerId,
      peerName,
      peerAvatarUrl,
      callType,
      isIncoming: false,
      state: 'outgoing_calling',
      durationSeconds: 0,
      localStream,
      isMuted: false,
      isVideoOff: false,
      screenQuality: 'auto',
    };
    this.notify();

    // Send invite signal via WebSocket
    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: this.currentUserId || '',
      receiver_id: peerId,
      call_type: callType,
      signal_type: 'invite',
      data: {
        caller_name: callerName || 'Caller',
        caller_avatar_url: callerAvatarUrl,
        peer_name: peerName,
      },
    });

    // Start outgoing ringback tone for caller
    this.startRingingEffects(false);

    // Ringing timeout for caller (35s)
    this.clearRingingTimeout();
    this.ringingTimeoutTimer = setTimeout(() => {
      if (this.currentSession && (this.currentSession.state === 'outgoing_calling' || this.currentSession.state === 'outgoing_ringing')) {
        this.hangupCall(true);
      }
    }, 35000);
  }

  // Method to unmute ringtone if blocked by autoplay policy
  async unlockAudio(): Promise<void> {
    await soundManager.resumeContext();
    if (this.currentSession) {
      this.currentSession.autoplayBlocked = false;
      this.notify();
    }
  }

  // Answer incoming call
  async answerCall(): Promise<void> {
    this.clearRingingTimeout();
    this.stopRingingEffects();
    if (!this.currentSession || !this.currentSession.isIncoming) return;

    const { callType, callId, conversationId, peerId } = this.currentSession;

    let localStream: MediaStream | undefined;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: STUDIO_AUDIO_CONSTRAINTS,
        video: callType === 'video' ? {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 },
        } : false,
      });
    } catch (e: any) {
      console.warn('Initial HD media constraints failed for answer, falling back to standard audio:', e);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: callType === 'video',
        });
      } catch (fallbackErr: any) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: callType === 'video',
          });
        } catch (finalErr: any) {
          console.error('Failed to acquire media devices for answer:', finalErr);
          this.rejectCall();
          alert('Could not access microphone/camera: ' + (finalErr.message || 'Permission denied'));
          return;
        }
      }
    }

    this.currentSession.localStream = localStream;
    this.currentSession.screenQuality = 'auto';
    this.currentSession.state = 'connecting';
    this.notify();

    // Create RTCPeerConnection
    await this.setupPeerConnection();

    // Add local tracks
    if (localStream && this.peerConnection) {
      localStream.getTracks().forEach((track) => {
        this.peerConnection?.addTrack(track, localStream!);
      });
    }

    // Ensure video transceiver exists so video/screen-share m-line is negotiated
    if (this.peerConnection && !this.peerConnection.getTransceivers().some((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video')) {
      try {
        this.peerConnection.addTransceiver('video', { direction: 'sendrecv' });
      } catch (e) {
        console.warn('[WebRTC] addTransceiver video error:', e);
      }
    }

    // Send accept signal
    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: peerId,
      receiver_id: this.currentUserId || '',
      call_type: callType,
      signal_type: 'accept',
    });
  }

  // Reject / Decline incoming call
  declineCall(): void {
    this.rejectCall();
  }

  rejectCall(): void {
    this.clearRingingTimeout();
    this.stopRingingEffects();
    if (!this.currentSession) return;

    const { callId, conversationId, peerId, callType } = this.currentSession;

    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: peerId,
      receiver_id: this.currentUserId || '',
      call_type: callType,
      signal_type: 'reject',
    });

    // Record rejected call log and conversation message
    this.persistCallEvent('declined', 0);
    api.createCallLog({
      id: callId,
      conversation_id: conversationId,
      receiver_id: peerId,
      call_type: callType,
      status: 'rejected',
      duration_seconds: 0,
    }).catch(console.warn);

    this.cleanupCall('rejected');
  }

  // Hangup / End call
  endCall(): void {
    this.hangupCall();
  }

  hangupCall(isTimeout: boolean = false): void {
    this.clearRingingTimeout();
    this.stopRingingEffects();
    if (!this.currentSession) return;

    const { callId, conversationId, peerId, callType, durationSeconds, state } = this.currentSession;

    const signalType = state === 'outgoing_calling' || state === 'outgoing_ringing' ? 'cancel' : 'hangup';
    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: this.currentUserId || '',
      receiver_id: peerId,
      call_type: callType,
      signal_type: signalType,
    });

    const finalState = isTimeout ? 'timeout' : (signalType === 'cancel' ? 'cancelled' : 'ended');
    const status = state === 'connected' ? 'completed' : (state === 'outgoing_calling' || state === 'outgoing_ringing' ? 'cancelled' : 'missed');
    this.persistCallEvent(status as any, durationSeconds);
    api.createCallLog({
      id: callId,
      conversation_id: conversationId,
      receiver_id: peerId,
      call_type: callType,
      status: state === 'connected' ? 'completed' : 'missed',
      duration_seconds: durationSeconds,
    }).catch(console.warn);

    this.cleanupCall(finalState);
  }

  // Mute toggle
  toggleMute(): void {
    if (!this.currentSession?.localStream) return;
    const audioTrack = this.currentSession.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      this.currentSession.isMuted = !audioTrack.enabled;
      this.notify();
    }
  }

  // Video toggle
  toggleVideo(): void {
    if (!this.currentSession?.localStream) return;
    const videoTrack = this.currentSession.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      this.currentSession.isVideoOff = !videoTrack.enabled;
      this.notify();
    }
  }

  private sendSignal(signalType: string, data?: any): void {
    if (!this.currentSession) return;
    const callerId = this.currentSession.isIncoming ? this.currentSession.peerId : (this.currentUserId || '');
    const receiverId = this.currentSession.isIncoming ? (this.currentUserId || '') : this.currentSession.peerId;
    wsManager.sendCallSignal({
      call_id: this.currentSession.callId,
      conversation_id: this.currentSession.conversationId,
      caller_id: callerId,
      receiver_id: receiverId,
      call_type: this.currentSession.callType,
      signal_type: signalType as any,
      data,
    });
  }

  private applyAudioSenderParameters(): void {
    if (!this.peerConnection) return;
    try {
      const audioSenders = this.peerConnection.getSenders().filter((s) => s.track?.kind === 'audio');
      for (const sender of audioSenders) {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = this.currentSession?.isScreenSharing ? 256000 : 128000;
        sender.setParameters(params).catch(() => {});
      }
    } catch (e) {
      console.warn('[WebRTC] applyAudioSenderParameters error:', e);
    }
  }

  async renegotiate(): Promise<void> {
    if (!this.peerConnection || !this.currentSession) return;
    try {
      const offer = await this.peerConnection.createOffer();
      const optimizedSdp = optimizeOpusSdp(offer.sdp || '', !!this.currentSession.isScreenSharing);
      const modifiedOffer = { type: offer.type, sdp: optimizedSdp };
      await this.peerConnection.setLocalDescription(modifiedOffer);
      this.applyAudioSenderParameters();
      this.sendSignal('sdp_offer', modifiedOffer);
    } catch (err) {
      console.warn('[WebRTC] Renegotiation offer failed:', err);
    }
  }

  // Set quality preset for screen sharing (Auto, 1080p 60fps, 720p 30fps, 480p 30fps)
  async setScreenShareQuality(preset: ScreenQualityPreset): Promise<void> {
    if (!this.currentSession) return;
    this.currentSession.screenQuality = preset;

    if (this.currentSession.isScreenSharing && this.screenStream) {
      const videoTrack = this.screenStream.getVideoTracks()[0];
      if (videoTrack) {
        try {
          if (preset === '1080p') {
            await videoTrack.applyConstraints({
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 60, max: 60 },
            });
          } else if (preset === '720p') {
            await videoTrack.applyConstraints({
              width: { ideal: 1280 },
              height: { ideal: 720 },
              frameRate: { ideal: 30, max: 30 },
            });
          } else if (preset === '480p') {
            await videoTrack.applyConstraints({
              width: { ideal: 854 },
              height: { ideal: 480 },
              frameRate: { ideal: 30, max: 30 },
            });
          } else {
            await videoTrack.applyConstraints({
              frameRate: { ideal: 30 },
            });
          }
        } catch (e) {
          console.warn('[WebRTC] applyConstraints error on quality change:', e);
        }
      }

      if (this.peerConnection) {
        const videoSender = this.peerConnection.getSenders().find((s) => s.track?.kind === 'video');
        if (videoSender) {
          try {
            const params = videoSender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            if (preset === '1080p') {
              params.encodings[0].maxBitrate = 3500000;
              params.encodings[0].maxFramerate = 60;
              params.encodings[0].scaleResolutionDownBy = 1.0;
            } else if (preset === '720p') {
              params.encodings[0].maxBitrate = 1800000;
              params.encodings[0].maxFramerate = 30;
              params.encodings[0].scaleResolutionDownBy = 1.5;
            } else if (preset === '480p') {
              params.encodings[0].maxBitrate = 750000;
              params.encodings[0].maxFramerate = 30;
              params.encodings[0].scaleResolutionDownBy = 2.0;
            } else {
              delete params.encodings[0].maxBitrate;
              delete params.encodings[0].maxFramerate;
              delete params.encodings[0].scaleResolutionDownBy;
            }
            await videoSender.setParameters(params);
          } catch (e) {
            console.warn('[WebRTC] setParameters error on quality change:', e);
          }
        }
      }

      this.sendSignal('screen_quality_change', { quality: preset });
    }

    this.notify();
  }

  // Viewer requests remote peer to adjust screen sharing quality
  requestRemoteScreenQuality(preset: ScreenQualityPreset): void {
    if (!this.currentSession) return;
    this.currentSession.screenQuality = preset;
    this.sendSignal('screen_quality_request', { quality: preset });
    this.notify();
  }

  // Screen sharing toggle (Phase 14 & 17: Video + Background Audio)
  async toggleScreenShare(): Promise<void> {
    if (!this.currentSession || !this.peerConnection) return;

    if (this.currentSession.isScreenSharing) {
      // 1. Stop local screen capture tracks
      if (this.screenStream) {
        this.screenStream.getTracks().forEach((track) => track.stop());
        this.screenStream = null;
      }
      this.currentSession.screenStream = undefined;
      this.currentSession.isScreenSharing = false;

      // 2. Close screen audio mixing and restore original microphone track
      if (this.screenAudioContext) {
        try {
          this.screenAudioContext.close();
        } catch {}
        this.screenAudioContext = null;
      }

      const audioTransceiver = this.peerConnection.getTransceivers().find(
        (t) => t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio'
      );
      const audioSender = audioTransceiver?.sender || this.peerConnection.getSenders().find((s) => s.track?.kind === 'audio');
      const micTrack = this.originalMicTrack || this.currentSession.localStream?.getAudioTracks()[0] || null;

      if (audioSender && micTrack) {
        try {
          await audioSender.replaceTrack(micTrack);
        } catch (e) {
          console.warn('[WebRTC] Failed to restore mic track on stop screen share:', e);
        }
      }
      this.originalMicTrack = null;

      // 3. Revert video sender back to local camera track (or null if audio call / camera off)
      const videoTransceiver = this.peerConnection.getTransceivers().find(
        (t) => t.sender.track?.kind === 'video' || t.receiver.track?.kind === 'video'
      );
      const videoSender = videoTransceiver?.sender || this.peerConnection.getSenders().find((s) => s.track?.kind === 'video');

      const localVideoTrack = (this.currentSession.callType === 'video' && !this.currentSession.isVideoOff)
        ? this.currentSession.localStream?.getVideoTracks()[0] || null
        : null;

      if (videoSender) {
        try {
          await videoSender.replaceTrack(localVideoTrack);
        } catch (e) {
          console.warn('[WebRTC] replaceTrack on stop failed:', e);
        }
      }

      // 4. Notify peer that screen sharing stopped and renegotiate
      this.sendSignal('screen_share_stop');
      await this.renegotiate();
      this.notify();
    } else {
      // Start screen sharing with video and background/tab/system audio
      try {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw new Error('Screen sharing not supported in this browser');
        }

        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              cursor: 'always',
              displaySurface: 'monitor',
            } as any,
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            } as any,
          });
        } catch (audioErr) {
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: {
                cursor: 'always',
              } as any,
              audio: true,
            });
          } catch (simpleAudioErr) {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: false,
            });
          }
        }

        this.screenStream = stream;
        this.currentSession.screenStream = stream;
        this.currentSession.isScreenSharing = true;

        const screenVideoTrack = stream.getVideoTracks()[0];
        const screenAudioTrack = stream.getAudioTracks()[0];
        if (!screenVideoTrack) return;

        screenVideoTrack.onended = () => {
          if (this.currentSession?.isScreenSharing) {
            this.toggleScreenShare();
          }
        };

        // 1. Video track replacement
        const videoTransceiver = this.peerConnection.getTransceivers().find(
          (t) => t.sender.track?.kind === 'video' || t.receiver.track?.kind === 'video'
        );
        let videoSender = videoTransceiver?.sender || this.peerConnection.getSenders().find((s) => s.track?.kind === 'video');

        if (videoTransceiver && videoTransceiver.direction !== 'sendrecv') {
          videoTransceiver.direction = 'sendrecv';
        }

        if (videoSender) {
          await videoSender.replaceTrack(screenVideoTrack);
        } else {
          this.peerConnection.addTrack(screenVideoTrack, stream);
        }

        // 2. Background audio mixing: mix screen audio with mic audio
        const audioTransceiver = this.peerConnection.getTransceivers().find(
          (t) => t.sender.track?.kind === 'audio' || t.receiver.track?.kind === 'audio'
        );
        const audioSender = audioTransceiver?.sender || this.peerConnection.getSenders().find((s) => s.track?.kind === 'audio');
        const micTrack = this.currentSession.localStream?.getAudioTracks()[0];

        if (screenAudioTrack && audioSender) {
          this.originalMicTrack = audioSender.track || micTrack || null;
          try {
            const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
            if (AudioCtxClass) {
              const ctx = new AudioCtxClass();
              this.screenAudioContext = ctx;
              const destination = ctx.createMediaStreamDestination();

              const screenSource = ctx.createMediaStreamSource(new MediaStream([screenAudioTrack]));
              screenSource.connect(destination);

              if (this.originalMicTrack && this.originalMicTrack.readyState === 'live') {
                const micSource = ctx.createMediaStreamSource(new MediaStream([this.originalMicTrack]));
                micSource.connect(destination);
              }

              const mixedTrack = destination.stream.getAudioTracks()[0];
              if (mixedTrack) {
                await audioSender.replaceTrack(mixedTrack);
              }
            } else {
              await audioSender.replaceTrack(screenAudioTrack);
            }
          } catch (mixErr) {
            console.warn('[WebRTC] Audio mix error, sending screen audio directly:', mixErr);
            try {
              await audioSender.replaceTrack(screenAudioTrack);
            } catch {}
          }

          screenAudioTrack.onended = () => {
            if (this.originalMicTrack && audioSender) {
              audioSender.replaceTrack(this.originalMicTrack).catch(console.warn);
            }
          };
        }

        // 3. Notify remote peer that screen sharing started and renegotiate
        this.sendSignal('screen_share_start');
        await this.renegotiate();
        this.notify();
      } catch (err: any) {
        if (err.name !== 'NotAllowedError') {
          console.warn('[WebRTC] Screen share failed:', err);
        }
      }
    }
  }

  private async drainIceCandidates(): Promise<void> {
    if (!this.peerConnection || !this.peerConnection.remoteDescription) return;
    while (this.iceCandidateQueue.length > 0) {
      const cand = this.iceCandidateQueue.shift();
      if (cand && cand.candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(cand));
        } catch (e) {
          console.warn('[WebRTC] Error adding queued ICE candidate:', e);
        }
      }
    }
  }

  private markCallConnected(): void {
    if (!this.currentSession || this.currentSession.state === 'connected') return;
    this.clearRingingTimeout();
    this.stopRingingEffects();
    this.currentSession.state = 'connected';
    this.currentSession.startTime = this.currentSession.startTime || Date.now();
    this.startDurationTimer();
    this.notify();
  }

  // Private: Setup WebRTC connection
  private async setupPeerConnection(): Promise<void> {
    if (this.peerConnection) {
      this.peerConnection.close();
    }

    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.currentSession) {
        const candData = event.candidate.toJSON
          ? event.candidate.toJSON()
          : {
              candidate: event.candidate.candidate,
              sdpMid: event.candidate.sdpMid,
              sdpMLineIndex: event.candidate.sdpMLineIndex,
              usernameFragment: event.candidate.usernameFragment,
            };
        this.sendSignal('ice_candidate', candData);
      }
    };

    this.peerConnection.ontrack = (event) => {
      if (!this.currentSession) return;

      if (!this.currentSession.remoteStream) {
        this.currentSession.remoteStream = new MediaStream();
      }

      if (!this.currentSession.remoteStream.getTracks().some((t) => t.id === event.track.id)) {
        this.currentSession.remoteStream.addTrack(event.track);
      }

      if (event.streams && event.streams[0]) {
        event.streams[0].getTracks().forEach((track) => {
          if (!this.currentSession!.remoteStream!.getTracks().some((t) => t.id === track.id)) {
            this.currentSession!.remoteStream!.addTrack(track);
          }
        });
      }

      // If tracks are arriving and session is still connecting, immediately mark connected
      if (this.currentSession.state === 'connecting') {
        this.markCallConnected();
      }

      if (event.track.kind === 'video') {
        this.currentSession.hasRemoteVideo = true;

        event.track.onended = () => {
          if (this.currentSession) {
            const hasVideo = this.currentSession.remoteStream
              ?.getVideoTracks()
              .some((t) => t.readyState === 'live');
            this.currentSession.hasRemoteVideo = !!hasVideo;
            this.notify();
          }
        };

        event.track.onmute = () => {
          if (this.currentSession && !this.currentSession.peerScreenSharing) {
            const hasActiveVideo = this.currentSession.remoteStream
              ?.getVideoTracks()
              .some((t) => t.readyState === 'live' && !t.muted);
            this.currentSession.hasRemoteVideo = !!hasActiveVideo;
            this.notify();
          }
        };

        event.track.onunmute = () => {
          if (this.currentSession) {
            this.currentSession.hasRemoteVideo = true;
            this.notify();
          }
        };
      }

      this.notify();
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection || !this.currentSession) return;
      const state = this.peerConnection.connectionState;
      if (state === 'connected') {
        this.markCallConnected();
      } else if (state === 'failed') {
        if (this.peerConnection.iceConnectionState === 'failed') {
          this.cleanupCall('ended');
        }
      } else if (state === 'closed') {
        this.cleanupCall('ended');
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      if (!this.peerConnection || !this.currentSession) return;
      const iceState = this.peerConnection.iceConnectionState;
      if (iceState === 'connected' || iceState === 'completed') {
        this.markCallConnected();
      } else if (iceState === 'failed') {
        console.warn('[WebRTC] ICE failed, attempting restart...');
        if ('restartIce' in this.peerConnection) {
          (this.peerConnection as any).restartIce();
        }
      }
    };
  }

  private startDurationTimer() {
    clearInterval(this.durationTimer);
    this.durationTimer = setInterval(() => {
      if (this.currentSession && this.currentSession.startTime) {
        this.currentSession.durationSeconds = Math.floor((Date.now() - this.currentSession.startTime) / 1000);
        this.notify();
      }
    }, 1000);
  }

  private cleanupCall(finalState: CallState = 'ended') {
    this.clearRingingTimeout();
    this.stopRingingEffects();
    this.iceCandidateQueue = [];
    clearInterval(this.durationTimer);

    if (this.screenAudioContext) {
      try {
        this.screenAudioContext.close();
      } catch {}
      this.screenAudioContext = null;
    }
    this.originalMicTrack = null;

    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => track.stop());
      this.screenStream = null;
    }

    if (this.currentSession?.localStream) {
      this.currentSession.localStream.getTracks().forEach((track) => track.stop());
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.currentSession) {
      this.currentSession.screenStream = undefined;
      this.currentSession.isScreenSharing = false;
      this.currentSession.peerScreenSharing = false;
      this.currentSession.hasRemoteVideo = false;
      this.currentSession.state = finalState;
      this.notify();

      this.cleanupTimer = setTimeout(() => {
        this.currentSession = null;
        this.cleanupTimer = null;
        this.notify();
      }, 1500);
    }
  }

  // Handle incoming WebSocket call signals
  async handleIncomingSignal(signal: CallSignal) {
    switch (signal.signal_type) {
      case 'invite':
        const isSessionActive = this.currentSession && !['ended', 'rejected', 'timeout', 'cancelled'].includes(this.currentSession.state);
        if (isSessionActive) {
          // Busy: reject
          wsManager.sendCallSignal({
            call_id: signal.call_id,
            conversation_id: signal.conversation_id,
            caller_id: signal.caller_id,
            receiver_id: this.currentUserId || '',
            call_type: signal.call_type,
            signal_type: 'reject',
            data: { reason: 'busy' },
          });
          return;
        }

        if (this.cleanupTimer) {
          clearTimeout(this.cleanupTimer);
          this.cleanupTimer = null;
        }

        this.currentSession = {
          callId: signal.call_id,
          conversationId: signal.conversation_id,
          peerId: signal.caller_id,
          peerName: signal.data?.caller_name || signal.data?.peer_name || 'Caller',
          peerAvatarUrl: signal.data?.caller_avatar_url,
          callType: signal.call_type,
          isIncoming: true,
          state: 'incoming_ringing',
          durationSeconds: 0,
          isMuted: false,
          isVideoOff: false,
          autoplayBlocked: false,
          screenQuality: 'auto',
        };
        this.notify();

        // Send ringing acknowledgement back to caller
        wsManager.sendCallSignal({
          call_id: signal.call_id,
          conversation_id: signal.conversation_id,
          caller_id: signal.caller_id,
          receiver_id: this.currentUserId || '',
          call_type: signal.call_type,
          signal_type: 'ringing',
        });

        // Start incoming call ringtone and optional vibration
        this.startRingingEffects(true);

        // Recipient ringing timeout (35s)
        this.clearRingingTimeout();
        this.ringingTimeoutTimer = setTimeout(() => {
          if (this.currentSession && this.currentSession.state === 'incoming_ringing') {
            this.stopRingingEffects();
            this.persistCallEvent('missed', 0);
            this.cleanupCall('timeout');
          }
        }, 35000);
        break;

      case 'ringing':
        if (this.currentSession && !this.currentSession.isIncoming && this.currentSession.state === 'outgoing_calling') {
          this.currentSession.state = 'outgoing_ringing';
          this.notify();
        }
        break;

      case 'accept':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        if (this.currentSession && !this.currentSession.isIncoming) {
          this.currentSession.state = 'connecting';
          this.notify();

          await this.setupPeerConnection();

          // Add local tracks to peer connection
          if (this.currentSession.localStream && this.peerConnection) {
            this.currentSession.localStream.getTracks().forEach((track) => {
              this.peerConnection?.addTrack(track, this.currentSession!.localStream!);
            });
          }

          // Ensure video transceiver exists so video/screen-share m-line is negotiated
          if (this.peerConnection && !this.peerConnection.getTransceivers().some((t) => t.receiver.track?.kind === 'video' || t.sender.track?.kind === 'video')) {
            try {
              this.peerConnection.addTransceiver('video', { direction: 'sendrecv' });
            } catch (e) {
              console.warn('[WebRTC] addTransceiver video error:', e);
            }
          }

          // Create SDP Offer
          if (this.peerConnection) {
            const offer = await this.peerConnection.createOffer();
            const optimizedSdp = optimizeOpusSdp(offer.sdp || '', !!this.currentSession.isScreenSharing);
            const modifiedOffer = { type: offer.type, sdp: optimizedSdp };
            await this.peerConnection.setLocalDescription(modifiedOffer);
            this.applyAudioSenderParameters();

            wsManager.sendCallSignal({
              call_id: this.currentSession.callId,
              conversation_id: this.currentSession.conversationId,
              caller_id: this.currentUserId || '',
              receiver_id: this.currentSession.peerId,
              call_type: this.currentSession.callType,
              signal_type: 'sdp_offer',
              data: modifiedOffer,
            });
          }
        }
        break;

      case 'sdp_offer':
        if (this.currentSession && this.peerConnection) {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.data));
          await this.drainIceCandidates();
          const answer = await this.peerConnection.createAnswer();
          const optimizedSdp = optimizeOpusSdp(answer.sdp || '', !!this.currentSession.isScreenSharing);
          const modifiedAnswer = { type: answer.type, sdp: optimizedSdp };
          await this.peerConnection.setLocalDescription(modifiedAnswer);
          this.applyAudioSenderParameters();

          wsManager.sendCallSignal({
            call_id: this.currentSession.callId,
            conversation_id: this.currentSession.conversationId,
            caller_id: this.currentSession.peerId,
            receiver_id: this.currentUserId || '',
            call_type: this.currentSession.callType,
            signal_type: 'sdp_answer',
            data: modifiedAnswer,
          });
        }
        break;

      case 'sdp_answer':
        if (this.currentSession && this.peerConnection) {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.data));
          await this.drainIceCandidates();
        }
        break;

      case 'ice_candidate':
        if (this.currentSession && signal.data) {
          if (!this.peerConnection || !this.peerConnection.remoteDescription || !this.peerConnection.remoteDescription.type) {
            this.iceCandidateQueue.push(signal.data);
          } else {
            if (signal.data.candidate) {
              try {
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.data));
              } catch (e) {
                console.warn('[WebRTC] Error adding ICE candidate:', e);
              }
            }
          }
        }
        break;

      case 'screen_share_start':
        if (this.currentSession) {
          this.currentSession.peerScreenSharing = true;
          this.currentSession.hasRemoteVideo = true;
          this.notify();
        }
        break;

      case 'screen_share_stop':
        if (this.currentSession) {
          this.currentSession.peerScreenSharing = false;
          const hasVideoTrack = this.currentSession.remoteStream?.getVideoTracks().some(
            (t) => t.readyState === 'live' && t.enabled && !t.muted
          );
          this.currentSession.hasRemoteVideo = !!hasVideoTrack && this.currentSession.callType === 'video';
          this.notify();
        }
        break;

      case 'screen_quality_request':
        if (this.currentSession && this.currentSession.isScreenSharing && signal.data?.quality) {
          this.setScreenShareQuality(signal.data.quality);
        }
        break;

      case 'screen_quality_change':
        if (this.currentSession && signal.data?.quality) {
          this.currentSession.screenQuality = signal.data.quality;
          this.notify();
        }
        break;

      case 'cancel':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        if (this.currentSession) {
          this.persistCallEvent('missed', 0);
          this.cleanupCall('cancelled');
        }
        break;

      case 'reject':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        if (this.currentSession) {
          this.persistCallEvent('declined', 0);
          this.cleanupCall('rejected');
        }
        break;

      case 'hangup':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        if (this.currentSession) {
          const outcome = this.currentSession.state === 'connected' ? 'completed' : 'missed';
          this.persistCallEvent(outcome, this.currentSession.durationSeconds);
          this.cleanupCall('ended');
        }
        break;
    }
  }
}

export const webrtcManager = new WebRTCManager();
