import { CallSignal, CallSignalStatus } from '../../app/types';
import { wsManager } from '../../protocol/ws';
import { api } from '../../protocol/api';
import { soundManager } from './soundManager';
import { mediaDeviceManager } from './mediaDeviceManager';

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
  | 'cancelled'
  | 'failed';

export type CallFailureStage =
  | 'permissions'
  | 'signaling'
  | 'sdp'
  | 'ice'
  | 'turn_or_nat'
  | 'playback'
  | 'blocked';

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
  mediaPlaybackBlocked?: boolean;
  screenQuality?: ScreenQualityPreset;
  iceState?: RTCIceConnectionState;
  connectionState?: RTCPeerConnectionState;
  iceCandidateType?: string;
  targetOffline?: boolean;
  isReconnectingIce?: boolean;
  failureReason?: string;
  failureStage?: CallFailureStage;
  localStreamRevision?: number;
  remoteStreamRevision?: number;
}

export type CallEventListener = (session: CallSession | null) => void;

export interface RenegotiationResult {
  ok: boolean;
  status: 'sent' | 'busy' | 'inactive' | 'failed';
  error?: unknown;
}

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.services.mozilla.com:3478',
  'stun:stun.nextcloud.com:443',
];

const TERMINAL_STATES = new Set<CallState>(['ended', 'rejected', 'timeout', 'cancelled', 'failed']);

// Professional Opus SDP Optimizer: enriches Opus with stereo, 128/256kbps HD audio, inband FEC, disables DTX clipping
// Follows RFC 4566 m-section line order: m= -> i= -> c= -> b= -> a=
export function optimizeOpusSdp(sdp: string, isScreenShare: boolean = false): string {
  if (!sdp) return sdp;
  try {
    const lines = sdp.split(/\r\n|\n/);
    let opusPt: string | null = null;

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

    // Insert b=AS:<kbps> in the audio media section cleanly AFTER c= (or m=audio if c= is absent)
    const bandwidthLine = `b=AS:${isScreenShare ? 256 : 128}`;
    const finalLines: string[] = [];
    let inAudio = false;
    let bandwidthInserted = false;

    for (let i = 0; i < modifiedLines.length; i++) {
      const line = modifiedLines[i];
      if (line.startsWith('m=audio')) {
        inAudio = true;
        bandwidthInserted = false;
        finalLines.push(line);
        continue;
      }
      if (line.startsWith('m=')) {
        if (inAudio && !bandwidthInserted) {
          finalLines.push(bandwidthLine);
          bandwidthInserted = true;
        }
        inAudio = false;
      }
      if (inAudio && line.startsWith('b=AS:')) {
        continue;
      }
      if (inAudio && !bandwidthInserted && (line.startsWith('a=') || line.startsWith('k='))) {
        finalLines.push(bandwidthLine);
        bandwidthInserted = true;
      }
      finalLines.push(line);
      if (inAudio && !bandwidthInserted && line.startsWith('c=')) {
        finalLines.push(bandwidthLine);
        bandwidthInserted = true;
      }
    }
    if (inAudio && !bandwidthInserted) {
      finalLines.push(bandwidthLine);
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
  private connectingTimeoutTimer: any = null;
  private iceDisconnectGraceTimer: any = null;
  private cleanupTimer: any = null;
  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeWsConn: (() => void) | null = null;
  private pageHideAttached = false;
  private loggedCallIds = new Set<string>();
  private currentUserId: string = '';
  private iceCandidateQueue: RTCIceCandidateInit[] = [];
  private screenAudioContext: AudioContext | null = null;
  private screenMixedStream: MediaStream | null = null;
  private originalMicTrack: MediaStreamTrack | null = null;
  private iceServersPromise: Promise<void> | null = null;

  // Concurrency & Perfect Negotiation state
  private attemptSeq = 0;
  private isStarting = false;
  private isAnswering = false;
  private isTogglingScreenShare = false;
  private isTogglingVideo = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private isSettingRemoteAnswerPending = false;
  private hasCompletedInitialNegotiation = false;
  private suppressNegotiationNeeded = false;
  private inFlightNegotiation: Promise<RenegotiationResult> | null = null;
  private inFlightNegotiationToken: object | null = null;
  private pendingRenegotiationOptions: RTCOfferOptions | null = null;
  private pendingRemoteOffers: Array<{ callId: string; sdp: RTCSessionDescriptionInit }> = [];
  private iceRestartAttempts = 0;
  private readonly maxIceRestartAttempts = 2;

  private rtcConfig: RTCConfiguration = {
    iceServers: [{ urls: DEFAULT_STUN_URLS }],
    iceCandidatePoolSize: 2,
  };

  private isTerminalState(state?: CallState): boolean {
    return !state || TERMINAL_STATES.has(state) || state === 'idle';
  }

  private isPolitePeer(): boolean {
    if (!this.currentSession) return true;
    if (this.currentUserId && this.currentSession.peerId && this.currentUserId !== this.currentSession.peerId) {
      return this.currentUserId < this.currentSession.peerId;
    }
    return this.currentSession.isIncoming;
  }

  private clearAllCallTimers() {
    this.clearRingingTimeout();
    if (this.connectingTimeoutTimer) {
      clearTimeout(this.connectingTimeoutTimer);
      this.connectingTimeoutTimer = null;
    }
    if (this.iceDisconnectGraceTimer) {
      clearTimeout(this.iceDisconnectGraceTimer);
      this.iceDisconnectGraceTimer = null;
    }
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  private stopMediaStream(stream?: MediaStream | null) {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      try {
        track.onended = null;
        track.stop();
      } catch {}
    });
  }

  resetSession(): void {
    this.attemptSeq++;
    this.isStarting = false;
    this.isAnswering = false;
    this.isTogglingScreenShare = false;
    this.isTogglingVideo = false;
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.isSettingRemoteAnswerPending = false;
    this.hasCompletedInitialNegotiation = false;
    this.suppressNegotiationNeeded = false;
    this.inFlightNegotiation = null;
    this.inFlightNegotiationToken = null;
    this.pendingRenegotiationOptions = null;
    this.pendingRemoteOffers = [];
    this.iceRestartAttempts = 0;

    this.clearAllCallTimers();
    this.stopRingingEffects();
    this.iceCandidateQueue = [];

    if (this.screenAudioContext) {
      try {
        this.screenAudioContext.close();
      } catch {}
      this.screenAudioContext = null;
    }
    this.stopMediaStream(this.screenMixedStream);
    this.screenMixedStream = null;
    this.originalMicTrack = null;

    this.stopMediaStream(this.screenStream);
    this.screenStream = null;
    this.stopMediaStream(this.currentSession?.localStream);

    if (this.peerConnection) {
      try {
        this.peerConnection.onicecandidate = null;
        this.peerConnection.ontrack = null;
        this.peerConnection.onconnectionstatechange = null;
        this.peerConnection.oniceconnectionstatechange = null;
        this.peerConnection.onnegotiationneeded = null;
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }
    this.currentSession = null;
    this.notify();
  }

  dispose(): void {
    this.resetSession();
    this.loggedCallIds.clear();
    this.iceServersPromise = null;
    this.rtcConfig = {
      iceServers: [{ urls: DEFAULT_STUN_URLS }],
      iceCandidatePoolSize: 2,
    };
    if (this.unsubscribeWs) {
      try {
        this.unsubscribeWs();
      } catch {}
      this.unsubscribeWs = null;
    }
    if (this.unsubscribeWsConn) {
      try {
        this.unsubscribeWsConn();
      } catch {}
      this.unsubscribeWsConn = null;
    }
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

  private startConnectingTimeout() {
    if (this.connectingTimeoutTimer) {
      clearTimeout(this.connectingTimeoutTimer);
    }
    const callIdAtStart = this.currentSession?.callId;
    this.connectingTimeoutTimer = setTimeout(() => {
      this.connectingTimeoutTimer = null;
      if (
        !this.currentSession ||
        this.currentSession.callId !== callIdAtStart ||
        this.currentSession.state !== 'connecting'
      ) {
        return;
      }
      const hasTurn = (this.rtcConfig.iceServers || []).some((srv) => {
        const urls = Array.isArray(srv.urls) ? srv.urls.join(',') : String(srv.urls || '');
        return urls.includes('turn:') || urls.includes('turns:');
      });
      const stage: CallFailureStage = hasTurn ? 'ice' : 'turn_or_nat';
      const reason = hasTurn
        ? 'Media connection timed out (ICE failed)'
        : 'Media connection timed out (no TURN relay configured for symmetric NAT)';
      this.recordCallOutcome('failed', 0);
      this.sendSignal('hangup');
      this.cleanupCall('failed', stage, reason);
    }, 25000);
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

  private recordCallOutcome(
    status: 'completed' | 'missed' | 'rejected' | 'declined' | 'cancelled' | 'failed',
    durationSeconds: number = 0
  ) {
    if (!this.currentSession) return;
    const { callId, conversationId, peerId, callType, isIncoming } = this.currentSession;
    if (!callId || this.loggedCallIds.has(callId)) return;
    this.loggedCallIds.add(callId);

    const callerId = isIncoming ? peerId : this.currentUserId || '';
    const receiverId = isIncoming ? this.currentUserId || '' : peerId;
    const normalizedStatus = status === 'declined' ? 'rejected' : status;

    api
      .createCallLog({
        id: callId,
        conversation_id: conversationId,
        caller_id: callerId || undefined,
        receiver_id: receiverId,
        call_type: callType,
        status: normalizedStatus,
        duration_seconds: Math.max(0, durationSeconds),
      })
      .catch((e) => console.warn('[WebRTC] Failed to record call log:', e));
  }

  setIceServers(servers: RTCIceServer[]) {
    this.rtcConfig.iceServers = servers;
  }

  getIceServers(): RTCIceServer[] {
    return this.rtcConfig.iceServers || [];
  }

  async refreshIceServers(): Promise<void> {
    if (typeof api.getIceServers !== 'function') return;
    const reqPromise = api
      .getIceServers()
      .then((servers) => {
        if (this.iceServersPromise === reqPromise && Array.isArray(servers)) {
          // Honor server policy verbatim: STUN_SERVERS=none yields [] or TURN-only without injecting default STUN
          this.setIceServers(servers as RTCIceServer[]);
        }
      })
      .catch((e) => {
        console.warn('[WebRTC] Falling back to default ICE servers:', e);
      });
    this.iceServersPromise = reqPromise;
    await reqPromise;
  }

  init() {
    if (!this.unsubscribeWs) {
      this.unsubscribeWs = wsManager.subscribe((event) => {
        if (event.type === 'call.signal') {
          void this.handleIncomingSignal(event.payload as CallSignal);
        } else if (event.type === 'call.signal_status') {
          this.handleSignalStatus(event.payload as CallSignalStatus);
        }
      });
    }

    if (!this.unsubscribeWsConn && typeof (wsManager as any).onConnectionChange === 'function') {
      this.unsubscribeWsConn = (wsManager as any).onConnectionChange((connected: boolean) => {
        if (connected && this.currentSession && !this.isTerminalState(this.currentSession.state)) {
          if (
            this.peerConnection &&
            (this.peerConnection.iceConnectionState === 'disconnected' ||
              this.peerConnection.iceConnectionState === 'failed')
          ) {
            void this.attemptIceRestart('ws_reconnected');
          }
        }
      });
    }

    if (!this.pageHideAttached && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.pageHideAttached = true;
      window.addEventListener('pagehide', () => {
        if (this.currentSession && !this.isTerminalState(this.currentSession.state)) {
          const signalType =
            this.currentSession.state === 'outgoing_calling' || this.currentSession.state === 'outgoing_ringing'
              ? 'cancel'
              : 'hangup';
          this.sendSignal(signalType);
          this.resetSession();
        }
      });
    }

    if (!this.iceServersPromise) {
      void this.refreshIceServers();
    }
  }

  subscribe(listener: CallEventListener): () => void {
    this.listeners.add(listener);
    listener(this.currentSession ? { ...this.currentSession } : null);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const snapshot = this.currentSession ? { ...this.currentSession } : null;
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  getSession(): CallSession | null {
    return this.currentSession;
  }

  private handleSignalStatus(status: CallSignalStatus) {
    if (!this.currentSession || !status || status.call_id !== this.currentSession.callId) return;
    if (status.status === 'target_offline') {
      this.currentSession.targetOffline = true;
      this.notify();
    } else if (status.status === 'blocked') {
      this.recordCallOutcome('rejected', 0);
      this.cleanupCall('rejected', 'blocked', 'Call could not be delivered (user blocked)');
    }
  }

  private async acquireInitialMedia(callType: 'audio' | 'video'): Promise<{
    stream: MediaStream;
    hasVideo: boolean;
  }> {
    const audioStream = await mediaDeviceManager.getAudioStream();
    const combined = new MediaStream(audioStream.getAudioTracks());

    if (callType === 'video') {
      try {
        const videoStream = await mediaDeviceManager.getVideoStream();
        videoStream.getVideoTracks().forEach((t) => combined.addTrack(t));
        return { stream: combined, hasVideo: combined.getVideoTracks().length > 0 };
      } catch (videoErr: any) {
        if (videoErr?.name === 'NotAllowedError' || videoErr?.name === 'PermissionDeniedError') {
          this.stopMediaStream(combined);
          throw videoErr;
        }
        console.warn('[WebRTC] Camera unavailable for video call, continuing with audio only:', videoErr);
        return { stream: combined, hasVideo: false };
      }
    }

    return { stream: combined, hasVideo: false };
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
    if (this.isStarting || (this.currentSession && !this.isTerminalState(this.currentSession.state))) {
      console.warn('Call already in progress');
      return;
    }

    this.isStarting = true;
    const seq = ++this.attemptSeq;
    const callId = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    let acquired: { stream: MediaStream; hasVideo: boolean };
    try {
      acquired = await this.acquireInitialMedia(callType);
    } catch (finalErr: any) {
      this.isStarting = false;
      console.error('Failed to get media devices:', finalErr);
      const errMsg = finalErr?.message || 'Microphone/camera permission denied';
      this.currentSession = {
        callId,
        conversationId,
        peerId,
        peerName,
        peerAvatarUrl,
        callType,
        isIncoming: false,
        state: 'failed',
        durationSeconds: 0,
        isMuted: false,
        isVideoOff: true,
        failureStage: 'permissions',
        failureReason: errMsg,
      };
      this.notify();
      this.cleanupTimer = setTimeout(() => {
        if (this.currentSession?.callId === callId && this.currentSession.state === 'failed') {
          this.currentSession = null;
          this.cleanupTimer = null;
          this.notify();
        }
      }, 3000);
      return;
    }

    if (seq !== this.attemptSeq || (this.currentSession && !this.isTerminalState(this.currentSession.state))) {
      this.stopMediaStream(acquired.stream);
      this.isStarting = false;
      return;
    }

    this.isStarting = false;
    this.iceRestartAttempts = 0;
    this.hasCompletedInitialNegotiation = false;
    this.pendingRemoteOffers = [];
    this.iceCandidateQueue = [];

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
      localStream: acquired.stream,
      isMuted: false,
      isVideoOff: !acquired.hasVideo,
      screenQuality: 'auto',
      localStreamRevision: 1,
      remoteStreamRevision: 0,
    };
    this.notify();

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

    this.startRingingEffects(false);

    this.clearRingingTimeout();
    this.ringingTimeoutTimer = setTimeout(() => {
      if (
        this.currentSession &&
        this.currentSession.callId === callId &&
        (this.currentSession.state === 'outgoing_calling' || this.currentSession.state === 'outgoing_ringing')
      ) {
        this.hangupCall(true);
      }
    }, 35000);
  }

  // Method to unmute ringtone or blocked media playback via user gesture
  async unlockAudio(): Promise<void> {
    await soundManager.resumeContext();
    if (this.currentSession) {
      this.currentSession.autoplayBlocked = false;
      this.currentSession.mediaPlaybackBlocked = false;
      this.currentSession.remoteStreamRevision = (this.currentSession.remoteStreamRevision || 0) + 1;
      this.notify();
    }
  }

  setPlaybackBlocked(blocked: boolean): void {
    if (!this.currentSession) return;
    if (this.currentSession.mediaPlaybackBlocked !== blocked) {
      this.currentSession.mediaPlaybackBlocked = blocked;
      this.notify();
    }
  }

  // Answer incoming call
  async answerCall(): Promise<void> {
    if (this.isAnswering) return;
    if (!this.currentSession || !this.currentSession.isIncoming || this.currentSession.state !== 'incoming_ringing') {
      return;
    }

    this.isAnswering = true;
    this.clearRingingTimeout();
    this.stopRingingEffects();

    const seq = this.attemptSeq;
    const { callType, callId, conversationId, peerId } = this.currentSession;

    let acquired: { stream: MediaStream; hasVideo: boolean };
    try {
      acquired = await this.acquireInitialMedia(callType);
    } catch (finalErr: any) {
      this.isAnswering = false;
      console.error('Failed to acquire media devices for answer:', finalErr);
      if (this.currentSession && this.currentSession.callId === callId) {
        this.sendSignal('reject', { reason: 'media_permission_denied' });
        this.recordCallOutcome('failed', 0);
        this.cleanupCall('failed', 'permissions', finalErr?.message || 'Microphone/camera permission denied');
      }
      return;
    }

    if (
      seq !== this.attemptSeq ||
      !this.currentSession ||
      this.currentSession.callId !== callId ||
      this.isTerminalState(this.currentSession.state)
    ) {
      this.stopMediaStream(acquired.stream);
      this.isAnswering = false;
      return;
    }

    this.hasCompletedInitialNegotiation = false;
    this.iceRestartAttempts = 0;
    this.currentSession.localStream = acquired.stream;
    this.currentSession.isVideoOff = !acquired.hasVideo;
    this.currentSession.screenQuality = 'auto';
    this.currentSession.state = 'connecting';
    this.currentSession.localStreamRevision = (this.currentSession.localStreamRevision || 0) + 1;
    this.notify();
    this.startConnectingTimeout();

    await this.setupPeerConnection();

    if (!this.currentSession || this.currentSession.callId !== callId || !this.peerConnection) {
      this.isAnswering = false;
      return;
    }

    this.isAnswering = false;

    // Notify caller we accepted — caller initiates initial sdp_offer
    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: peerId,
      receiver_id: this.currentUserId || '',
      call_type: callType,
      signal_type: 'accept',
    });

    // If caller's sdp_offer arrived while we were acquiring media or waiting for ICE servers, apply it now
    const bufferedOffer = this.pendingRemoteOffers.find((o) => o.callId === callId);
    this.pendingRemoteOffers = [];
    if (bufferedOffer) {
      await this.processRemoteOffer(bufferedOffer.sdp);
    }
  }

  declineCall(): void {
    this.rejectCall();
  }

  rejectCall(): void {
    this.attemptSeq++;
    this.isAnswering = false;
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

    this.recordCallOutcome('rejected', 0);
    this.cleanupCall('rejected');
  }

  endCall(): void {
    this.hangupCall();
  }

  hangupCall(isTimeout: boolean = false): void {
    this.attemptSeq++;
    this.isStarting = false;
    this.isAnswering = false;
    this.clearRingingTimeout();
    this.stopRingingEffects();
    if (!this.currentSession) return;

    const { callId, conversationId, peerId, callType, durationSeconds, state, isIncoming } = this.currentSession;
    const isPreAnswer = state === 'outgoing_calling' || state === 'outgoing_ringing' || state === 'incoming_ringing';
    const signalType = !isIncoming && (state === 'outgoing_calling' || state === 'outgoing_ringing') ? 'cancel' : 'hangup';

    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: isIncoming ? peerId : this.currentUserId || '',
      receiver_id: isIncoming ? this.currentUserId || '' : peerId,
      call_type: callType,
      signal_type: signalType,
    });

    const finalState: CallState = isTimeout ? 'timeout' : signalType === 'cancel' ? 'cancelled' : 'ended';
    const status =
      state === 'connected'
        ? 'completed'
        : signalType === 'cancel'
        ? isTimeout
          ? 'missed'
          : 'cancelled'
        : isPreAnswer
        ? 'missed'
        : 'completed';

    this.recordCallOutcome(status, durationSeconds);
    this.cleanupCall(finalState);
  }

  toggleMute(): void {
    if (!this.currentSession?.localStream) return;
    const audioTracks = this.currentSession.localStream.getAudioTracks();
    if (audioTracks.length === 0) return;
    const nextMuted = !this.currentSession.isMuted;
    audioTracks.forEach((t) => {
      t.enabled = !nextMuted;
    });
    this.currentSession.isMuted = nextMuted;
    this.notify();
  }

  async switchAudioInput(deviceId: string): Promise<void> {
    mediaDeviceManager.setSelectedAudioInputId(deviceId);
    if (!this.currentSession || this.isTerminalState(this.currentSession.state)) return;

    const callId = this.currentSession.callId;
    const seq = this.attemptSeq;
    const newStream = await mediaDeviceManager.getAudioStream(undefined, deviceId);
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) {
      this.stopMediaStream(newStream);
      return;
    }

    if (seq !== this.attemptSeq || !this.currentSession || this.currentSession.callId !== callId) {
      this.stopMediaStream(newStream);
      return;
    }

    newTrack.enabled = !this.currentSession.isMuted;

    if (!this.currentSession.localStream) {
      this.currentSession.localStream = new MediaStream();
    }
    this.currentSession.localStream.getAudioTracks().forEach((old) => {
      old.stop();
      this.currentSession!.localStream!.removeTrack(old);
    });
    this.currentSession.localStream.addTrack(newTrack);
    this.currentSession.localStreamRevision = (this.currentSession.localStreamRevision || 0) + 1;

    if (this.currentSession.isScreenSharing && this.originalMicTrack) {
      this.originalMicTrack = newTrack;
    } else if (this.peerConnection) {
      const audioSender = this.findSenderByKind('audio');
      if (audioSender) {
        await audioSender.replaceTrack(newTrack).catch((e) => console.warn('[WebRTC] switchAudio replaceTrack:', e));
      }
    }

    this.notify();
  }

  async switchVideoInput(deviceId: string): Promise<void> {
    mediaDeviceManager.setSelectedVideoInputId(deviceId);
    if (!this.currentSession || this.isTerminalState(this.currentSession.state) || this.currentSession.isVideoOff) {
      return;
    }

    const callId = this.currentSession.callId;
    const seq = this.attemptSeq;
    const newStream = await mediaDeviceManager.getVideoStream(undefined, deviceId);
    const newTrack = newStream.getVideoTracks()[0];
    if (!newTrack) {
      this.stopMediaStream(newStream);
      return;
    }

    if (seq !== this.attemptSeq || !this.currentSession || this.currentSession.callId !== callId) {
      this.stopMediaStream(newStream);
      return;
    }

    if (!this.currentSession.localStream) {
      this.currentSession.localStream = new MediaStream();
    }
    this.currentSession.localStream.getVideoTracks().forEach((old) => {
      old.stop();
      this.currentSession!.localStream!.removeTrack(old);
    });
    this.currentSession.localStream.addTrack(newTrack);
    this.currentSession.localStreamRevision = (this.currentSession.localStreamRevision || 0) + 1;

    if (!this.currentSession.isScreenSharing && this.peerConnection) {
      const videoSender = this.findSenderByKind('video');
      if (videoSender) {
        await videoSender.replaceTrack(newTrack).catch((e) => console.warn('[WebRTC] switchVideo replaceTrack:', e));
      }
    }

    this.notify();
  }

  // Toggle camera cleanly: stops hardware capture when disabling, acquires camera & upgrades audio->video call when enabling
  async toggleVideo(): Promise<void> {
    if (!this.currentSession || this.isTogglingVideo || this.isTerminalState(this.currentSession.state)) return;

    this.isTogglingVideo = true;
    const callId = this.currentSession.callId;
    const seq = this.attemptSeq;

    try {
      const existingTracks = this.currentSession.localStream?.getVideoTracks() || [];
      const currentlyHasLiveVideo = !this.currentSession.isVideoOff && existingTracks.some((t) => t.readyState === 'live');

      if (currentlyHasLiveVideo) {
        this.currentSession.isVideoOff = true;
        existingTracks.forEach((t) => {
          try {
            t.stop();
          } catch {}
          this.currentSession?.localStream?.removeTrack(t);
        });
        this.currentSession.localStreamRevision = (this.currentSession.localStreamRevision || 0) + 1;

        if (!this.currentSession.isScreenSharing && this.peerConnection) {
          const videoSender = this.findSenderByKind('video');
          if (videoSender) {
            await videoSender.replaceTrack(null).catch(() => {});
          }
        }
        this.sendSignal('video_state', { enabled: false });
        this.notify();
      } else {
        const videoStream = await mediaDeviceManager.getVideoStream();
        const newTrack = videoStream.getVideoTracks()[0];
        if (!newTrack) {
          this.stopMediaStream(videoStream);
          return;
        }

        if (
          seq !== this.attemptSeq ||
          !this.currentSession ||
          this.currentSession.callId !== callId ||
          this.isTerminalState(this.currentSession.state)
        ) {
          this.stopMediaStream(videoStream);
          return;
        }

        if (!this.currentSession.localStream) {
          this.currentSession.localStream = new MediaStream();
        }
        this.currentSession.localStream.getVideoTracks().forEach((old) => {
          try {
            old.stop();
          } catch {}
          this.currentSession!.localStream!.removeTrack(old);
        });
        this.currentSession.localStream.addTrack(newTrack);
        this.currentSession.isVideoOff = false;
        this.currentSession.localStreamRevision = (this.currentSession.localStreamRevision || 0) + 1;

        if (!this.currentSession.isScreenSharing && this.peerConnection) {
          const videoTransceiver = this.findTransceiverByKind('video');
          const previousDirection = videoTransceiver?.direction;
          let addedVideoSender: RTCRtpSender | null = null;
          let needsRenegotiation = false;

          this.suppressNegotiationNeeded = true;
          try {
            if (videoTransceiver) {
              if (videoTransceiver.direction === 'recvonly' || videoTransceiver.direction === 'inactive') {
                videoTransceiver.direction = 'sendrecv';
                needsRenegotiation = true;
              }
              await videoTransceiver.sender.replaceTrack(newTrack);
            } else {
              addedVideoSender = this.peerConnection.addTrack(newTrack, this.currentSession.localStream);
              needsRenegotiation = true;
            }
            if (needsRenegotiation && this.hasCompletedInitialNegotiation) {
              const negResult = await this.renegotiate();
              if (!negResult.ok) {
                throw negResult.error instanceof Error
                  ? negResult.error
                  : new Error(`Video toggle renegotiation failed (${negResult.status})`);
              }
            }
          } catch (toggleErr) {
            try {
              newTrack.stop();
            } catch {}
            this.currentSession.localStream?.removeTrack(newTrack);
            this.currentSession.isVideoOff = true;
            this.currentSession.localStreamRevision = (this.currentSession.localStreamRevision || 0) + 1;
            if (videoTransceiver) {
              await videoTransceiver.sender.replaceTrack(null).catch(() => {});
              if (previousDirection) {
                try {
                  videoTransceiver.direction = previousDirection;
                } catch {}
              }
            }
            if (addedVideoSender && this.peerConnection) {
              try {
                this.peerConnection.removeTrack(addedVideoSender);
              } catch {}
            }
            this.notify();
            throw toggleErr;
          } finally {
            this.suppressNegotiationNeeded = false;
          }
        }

        this.sendSignal('video_state', { enabled: true });
        this.notify();
      }
    } catch (err) {
      console.warn('[WebRTC] toggleVideo error:', err);
    } finally {
      this.suppressNegotiationNeeded = false;
      this.isTogglingVideo = false;
    }
  }

  private findTransceiverByKind(kind: 'audio' | 'video'): RTCRtpTransceiver | undefined {
    if (!this.peerConnection) return undefined;
    return this.peerConnection
      .getTransceivers()
      .find((t) => t.sender.track?.kind === kind || t.receiver.track?.kind === kind);
  }

  private findSenderByKind(kind: 'audio' | 'video'): RTCRtpSender | undefined {
    if (!this.peerConnection) return undefined;
    return (
      this.findTransceiverByKind(kind)?.sender ||
      this.peerConnection.getSenders().find((s) => s.track?.kind === kind)
    );
  }

  private attachLocalTracksToPeerConnection(ensureVideoTransceiver: boolean): void {
    if (!this.peerConnection || !this.currentSession) return;
    const localStream = this.currentSession.localStream;

    if (localStream) {
      for (const track of localStream.getTracks()) {
        if (track.kind === 'video' && this.currentSession.isVideoOff) continue;
        const kind = track.kind as 'audio' | 'video';
        const transceiver = this.findTransceiverByKind(kind);
        if (transceiver) {
          if (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive') {
            transceiver.direction = 'sendrecv';
          }
          transceiver.sender.replaceTrack(track).catch((e) => console.warn('[WebRTC] attach replaceTrack:', e));
        } else {
          this.peerConnection.addTrack(track, localStream);
        }
      }
    }

    if (ensureVideoTransceiver && !this.findTransceiverByKind('video')) {
      try {
        this.peerConnection.addTransceiver('video', { direction: 'sendrecv' });
      } catch (e) {
        console.warn('[WebRTC] addTransceiver video error:', e);
      }
    }
  }

  private sendSignal(signalType: CallSignal['signal_type'], data?: any): void {
    if (!this.currentSession) return;
    const callerId = this.currentSession.isIncoming ? this.currentSession.peerId : this.currentUserId || '';
    const receiverId = this.currentSession.isIncoming ? this.currentUserId || '' : this.currentSession.peerId;
    wsManager.sendCallSignal({
      call_id: this.currentSession.callId,
      conversation_id: this.currentSession.conversationId,
      caller_id: callerId,
      receiver_id: receiverId,
      call_type: this.currentSession.callType,
      signal_type: signalType,
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

  async renegotiate(options?: RTCOfferOptions): Promise<RenegotiationResult> {
    if (!this.peerConnection || !this.currentSession || this.isTerminalState(this.currentSession.state)) {
      return { ok: false, status: 'inactive' };
    }

    while (this.inFlightNegotiation) {
      await this.inFlightNegotiation.catch(() => undefined);
    }

    if (!this.peerConnection || !this.currentSession || this.isTerminalState(this.currentSession.state)) {
      return { ok: false, status: 'inactive' };
    }

    if (this.makingOffer || this.peerConnection.signalingState !== 'stable') {
      this.pendingRenegotiationOptions = options
        ? { ...(this.pendingRenegotiationOptions || {}), ...options }
        : this.pendingRenegotiationOptions || {};
      return {
        ok: false,
        status: 'busy',
        error: new Error('Renegotiation deferred: offer already in progress or signaling not stable'),
      };
    }

    const token = {};
    this.inFlightNegotiationToken = token;
    const negotiationPromise = this.executeRenegotiation(options, token);
    if (this.inFlightNegotiationToken === token) {
      this.inFlightNegotiation = negotiationPromise;
    }
    return negotiationPromise;
  }

  private async executeRenegotiation(
    options: RTCOfferOptions | undefined,
    token: object
  ): Promise<RenegotiationResult> {
    if (!this.peerConnection || !this.currentSession || this.isTerminalState(this.currentSession.state)) {
      if (this.inFlightNegotiationToken === token) {
        this.inFlightNegotiationToken = null;
        this.inFlightNegotiation = null;
      }
      return { ok: false, status: 'inactive' };
    }
    const callId = this.currentSession.callId;
    const seq = this.attemptSeq;

    try {
      this.makingOffer = true;
      const offer = await this.peerConnection.createOffer(options);
      if (
        !this.peerConnection ||
        !this.currentSession ||
        this.currentSession.callId !== callId ||
        seq !== this.attemptSeq ||
        this.isTerminalState(this.currentSession.state)
      ) {
        return { ok: false, status: 'inactive' };
      }
      const optimizedSdp = optimizeOpusSdp(offer.sdp || '', !!this.currentSession.isScreenSharing);
      const modifiedOffer: RTCSessionDescriptionInit = { type: offer.type, sdp: optimizedSdp };
      await this.peerConnection.setLocalDescription(modifiedOffer);
      if (
        !this.peerConnection ||
        !this.currentSession ||
        this.currentSession.callId !== callId ||
        seq !== this.attemptSeq ||
        this.isTerminalState(this.currentSession.state)
      ) {
        return { ok: false, status: 'inactive' };
      }
      this.applyAudioSenderParameters();
      this.sendSignal('sdp_offer', modifiedOffer);
      return { ok: true, status: 'sent' };
    } catch (err) {
      console.warn('[WebRTC] Renegotiation offer failed:', err);
      return { ok: false, status: 'failed', error: err };
    } finally {
      this.makingOffer = false;
      if (this.inFlightNegotiationToken === token) {
        this.inFlightNegotiationToken = null;
        this.inFlightNegotiation = null;
      }
    }
  }

  private async attemptIceRestart(reason: string): Promise<void> {
    if (!this.peerConnection || !this.currentSession || this.isTerminalState(this.currentSession.state)) return;

    if (this.iceRestartAttempts >= this.maxIceRestartAttempts) {
      this.recordCallOutcome('failed', this.currentSession.durationSeconds);
      this.sendSignal('hangup');
      this.cleanupCall('failed', 'turn_or_nat', `ICE connection failed (${reason})`);
      return;
    }

    this.iceRestartAttempts++;
    this.currentSession.isReconnectingIce = true;
    this.notify();

    console.warn(`[WebRTC] Attempting ICE restart #${this.iceRestartAttempts} (${reason})`);
    try {
      if (typeof this.peerConnection.restartIce === 'function') {
        this.peerConnection.restartIce();
      }
      if (this.peerConnection.signalingState === 'stable') {
        const res = await this.renegotiate({ iceRestart: true });
        if (!res.ok) {
          console.warn('[WebRTC] ICE restart renegotiation did not send offer:', res.status, res.error);
        }
      } else {
        this.pendingRenegotiationOptions = { ...(this.pendingRenegotiationOptions || {}), iceRestart: true };
      }
    } catch (err) {
      console.warn('[WebRTC] ICE restart error:', err);
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
        const videoSender = this.findSenderByKind('video');
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
              params.encodings[0].scaleResolutionDownBy = 1.0;
            } else if (preset === '480p') {
              params.encodings[0].maxBitrate = 750000;
              params.encodings[0].maxFramerate = 30;
              params.encodings[0].scaleResolutionDownBy = 1.0;
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

  requestRemoteScreenQuality(preset: ScreenQualityPreset): void {
    if (!this.currentSession) return;
    this.currentSession.screenQuality = preset;
    this.sendSignal('screen_quality_request', { quality: preset });
    this.notify();
  }

  // Screen sharing toggle (Video + System/Tab Audio mixing)
  async toggleScreenShare(): Promise<void> {
    if (!this.currentSession || !this.peerConnection || this.isTogglingScreenShare) return;

    this.isTogglingScreenShare = true;
    const callId = this.currentSession.callId;
    const seq = this.attemptSeq;

    try {
      if (this.currentSession.isScreenSharing) {
        this.suppressNegotiationNeeded = true;
        this.stopMediaStream(this.screenStream);
        this.screenStream = null;
        this.currentSession.screenStream = undefined;
        this.currentSession.isScreenSharing = false;

        if (this.screenAudioContext) {
          try {
            this.screenAudioContext.close();
          } catch {}
          this.screenAudioContext = null;
        }
        this.stopMediaStream(this.screenMixedStream);
        this.screenMixedStream = null;

        const audioSender = this.findSenderByKind('audio');
        const micTrack = this.originalMicTrack || this.currentSession.localStream?.getAudioTracks()[0] || null;
        if (audioSender && micTrack) {
          await audioSender.replaceTrack(micTrack).catch((e) => console.warn('[WebRTC] Restore mic track error:', e));
        }
        this.originalMicTrack = null;

        const videoSender = this.findSenderByKind('video');
        const localVideoTrack = !this.currentSession.isVideoOff
          ? this.currentSession.localStream?.getVideoTracks().find((t) => t.readyState === 'live') || null
          : null;

        if (videoSender) {
          await videoSender.replaceTrack(localVideoTrack).catch((e) => console.warn('[WebRTC] replaceTrack on stop failed:', e));
        }

        this.sendSignal('screen_share_stop');
        if (this.hasCompletedInitialNegotiation) {
          const stopNeg = await this.renegotiate();
          if (!stopNeg.ok) {
            console.warn('[WebRTC] Renegotiation on screen share stop did not complete:', stopNeg.status, stopNeg.error);
          }
        }
        this.notify();
      } else {
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
        } catch (err: any) {
          if (err?.name === 'NotAllowedError' || err?.name === 'AbortError' || err?.name === 'PermissionDeniedError') {
            return;
          }
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: { cursor: 'always' } as any,
              audio: true,
            });
          } catch (err2: any) {
            if (err2?.name === 'NotAllowedError' || err2?.name === 'AbortError' || err2?.name === 'PermissionDeniedError') {
              return;
            }
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: false,
            });
          }
        }

        if (
          seq !== this.attemptSeq ||
          !this.currentSession ||
          this.currentSession.callId !== callId ||
          !this.peerConnection ||
          this.isTerminalState(this.currentSession.state)
        ) {
          this.stopMediaStream(stream);
          return;
        }

        const screenVideoTrack = stream.getVideoTracks()[0];
        const screenAudioTrack = stream.getAudioTracks()[0];
        if (!screenVideoTrack) {
          this.stopMediaStream(stream);
          return;
        }

        const videoTransceiver = this.findTransceiverByKind('video');
        const videoSender = videoTransceiver?.sender || this.findSenderByKind('video');
        const previousVideoDirection = videoTransceiver?.direction;
        const previousVideoTrack = !this.currentSession.isVideoOff
          ? this.currentSession.localStream?.getVideoTracks().find((t) => t.readyState === 'live') || null
          : null;
        const audioSender = this.findSenderByKind('audio');
        const savedMicTrack = audioSender?.track || this.currentSession.localStream?.getAudioTracks()[0] || null;
        const wasScreenSharing = !!this.currentSession.isScreenSharing;

        let videoReplaced = false;
        let addedScreenSender: RTCRtpSender | null = null;
        let audioReplaced = false;
        let sentStartSignal = false;
        this.suppressNegotiationNeeded = true;

        try {
          if (videoTransceiver && videoTransceiver.direction !== 'sendrecv') {
            videoTransceiver.direction = 'sendrecv';
          }

          if (videoSender) {
            await videoSender.replaceTrack(screenVideoTrack);
            videoReplaced = true;
          } else {
            addedScreenSender = this.peerConnection.addTrack(screenVideoTrack, stream);
          }

          if (screenAudioTrack && audioSender) {
            this.originalMicTrack = savedMicTrack;
            try {
              const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
              if (AudioCtxClass) {
                const ctx = new AudioCtxClass();
                this.screenAudioContext = ctx;
                const destination = ctx.createMediaStreamDestination();
                this.screenMixedStream = destination.stream;

                const screenSource = ctx.createMediaStreamSource(new MediaStream([screenAudioTrack]));
                screenSource.connect(destination);

                if (this.originalMicTrack && this.originalMicTrack.readyState === 'live') {
                  const micSource = ctx.createMediaStreamSource(new MediaStream([this.originalMicTrack]));
                  micSource.connect(destination);
                }

                const mixedTrack = destination.stream.getAudioTracks()[0];
                if (mixedTrack) {
                  await audioSender.replaceTrack(mixedTrack);
                  audioReplaced = true;
                }
              } else {
                await audioSender.replaceTrack(screenAudioTrack);
                audioReplaced = true;
              }
            } catch (mixErr) {
              console.warn('[WebRTC] Audio mix error, sending screen audio directly:', mixErr);
              await audioSender.replaceTrack(screenAudioTrack).then(() => {
                audioReplaced = true;
              }).catch(() => {});
            }
          }

          // Mark sharing active temporarily only for 256kbps SDP offer/bitrate tuning during renegotiation;
          // wait until renegotiation succeeds before committing screenStream or emitting screen_share_start.
          this.currentSession.isScreenSharing = true;
          if (this.hasCompletedInitialNegotiation) {
            const negResult = await this.renegotiate();
            if (!negResult.ok) {
              throw negResult.error instanceof Error
                ? negResult.error
                : new Error(`Screen share renegotiation failed (${negResult.status})`);
            }
          }

          if (screenAudioTrack && audioSender) {
            screenAudioTrack.onended = () => {
              if (this.originalMicTrack && audioSender) {
                audioSender.replaceTrack(this.originalMicTrack).catch(() => {});
              }
            };
          }

          screenVideoTrack.onended = () => {
            if (this.currentSession?.isScreenSharing) {
              void this.toggleScreenShare();
            }
          };

          this.screenStream = stream;
          this.currentSession.screenStream = stream;
          this.currentSession.isScreenSharing = true;

          this.sendSignal('screen_share_start');
          sentStartSignal = true;
          this.notify();
        } catch (startErr) {
          this.stopMediaStream(stream);
          this.stopMediaStream(this.screenMixedStream);
          this.screenMixedStream = null;
          if (this.screenAudioContext) {
            try {
              this.screenAudioContext.close();
            } catch {}
            this.screenAudioContext = null;
          }
          if (videoReplaced && videoSender) {
            await videoSender.replaceTrack(previousVideoTrack).catch(() => {});
          }
          if (videoTransceiver && previousVideoDirection) {
            try {
              videoTransceiver.direction = previousVideoDirection;
            } catch {}
          }
          if (addedScreenSender && this.peerConnection) {
            try {
              this.peerConnection.removeTrack(addedScreenSender);
            } catch {}
          }
          if (audioReplaced && audioSender) {
            await audioSender.replaceTrack(savedMicTrack).catch(() => {});
          }
          this.originalMicTrack = null;
          this.screenStream = null;
          if (this.currentSession && this.currentSession.callId === callId) {
            this.currentSession.screenStream = undefined;
            this.currentSession.isScreenSharing = wasScreenSharing;
            if (sentStartSignal) {
              this.sendSignal('screen_share_stop');
            }
            this.notify();
          }
          throw startErr;
        }
      }
    } catch (err: any) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        console.warn('[WebRTC] Screen share failed:', err);
      }
    } finally {
      this.suppressNegotiationNeeded = false;
      this.isTogglingScreenShare = false;
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

  private async inspectSelectedCandidateType(): Promise<void> {
    if (!this.peerConnection || !this.currentSession || typeof this.peerConnection.getStats !== 'function') return;
    try {
      const stats = await this.peerConnection.getStats();
      let selectedPairId = '';
      const candidates = new Map<string, any>();
      stats.forEach((report: any) => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
          selectedPairId = report.selectedCandidatePairId;
        }
        if (report.type === 'local-candidate') {
          candidates.set(report.id, report);
        }
      });
      stats.forEach((report: any) => {
        if (report.type === 'candidate-pair' && (report.id === selectedPairId || (report.nominated && report.state === 'succeeded'))) {
          const localCand = candidates.get(report.localCandidateId);
          if (localCand?.candidateType && this.currentSession) {
            this.currentSession.iceCandidateType = localCand.candidateType;
            this.notify();
          }
        }
      });
    } catch {}
  }

  private markCallConnected(): void {
    if (!this.currentSession) return;
    if (this.connectingTimeoutTimer) {
      clearTimeout(this.connectingTimeoutTimer);
      this.connectingTimeoutTimer = null;
    }
    this.currentSession.isReconnectingIce = false;
    this.iceRestartAttempts = 0;

    if (this.currentSession.state === 'connected') {
      this.notify();
      return;
    }
    this.clearRingingTimeout();
    this.stopRingingEffects();
    this.currentSession.state = 'connected';
    this.currentSession.startTime = this.currentSession.startTime || Date.now();
    this.startDurationTimer();
    void this.inspectSelectedCandidateType();
    this.notify();
  }

  private async setupPeerConnection(): Promise<void> {
    // Wait briefly (up to 2s) if initial ICE server config fetch is still in flight so TURN credentials are included
    if (this.iceServersPromise) {
      await Promise.race([
        this.iceServersPromise,
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
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

    this.peerConnection.onnegotiationneeded = () => {
      if (
        !this.peerConnection ||
        !this.currentSession ||
        !this.hasCompletedInitialNegotiation ||
        this.suppressNegotiationNeeded ||
        this.isTerminalState(this.currentSession.state)
      ) {
        return;
      }
      void this.renegotiate();
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

      this.currentSession.remoteStreamRevision = (this.currentSession.remoteStreamRevision || 0) + 1;

      if (event.track.kind === 'video') {
        // Only treat remote video as active if track is actually receiving live frames or explicitly video/screen-share
        if (!event.track.muted && event.track.readyState === 'live') {
          this.currentSession.hasRemoteVideo = true;
        }

        event.track.onended = () => {
          if (this.currentSession) {
            const hasVideo = this.currentSession.remoteStream
              ?.getVideoTracks()
              .some((t) => t.readyState === 'live' && !t.muted);
            this.currentSession.hasRemoteVideo = !!hasVideo || !!this.currentSession.peerScreenSharing;
            this.currentSession.remoteStreamRevision = (this.currentSession.remoteStreamRevision || 0) + 1;
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
            this.currentSession.remoteStreamRevision = (this.currentSession.remoteStreamRevision || 0) + 1;
            this.notify();
          }
        };
      }

      this.notify();
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection || !this.currentSession) return;
      const state = this.peerConnection.connectionState;
      this.currentSession.connectionState = state;
      if (state === 'connected') {
        this.markCallConnected();
      } else if (state === 'failed') {
        void this.attemptIceRestart('connection_failed');
      } else if (state === 'closed' && !this.isTerminalState(this.currentSession.state)) {
        this.cleanupCall('ended');
      } else {
        this.notify();
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      if (!this.peerConnection || !this.currentSession) return;
      const iceState = this.peerConnection.iceConnectionState;
      this.currentSession.iceState = iceState;

      if (iceState === 'connected' || iceState === 'completed') {
        if (this.iceDisconnectGraceTimer) {
          clearTimeout(this.iceDisconnectGraceTimer);
          this.iceDisconnectGraceTimer = null;
        }
        this.markCallConnected();
      } else if (iceState === 'disconnected') {
        this.currentSession.isReconnectingIce = true;
        this.notify();
        if (!this.iceDisconnectGraceTimer) {
          this.iceDisconnectGraceTimer = setTimeout(() => {
            this.iceDisconnectGraceTimer = null;
            if (
              this.peerConnection &&
              (this.peerConnection.iceConnectionState === 'disconnected' ||
                this.peerConnection.iceConnectionState === 'failed')
            ) {
              void this.attemptIceRestart('ice_disconnected_timeout');
            }
          }, 3500);
        }
      } else if (iceState === 'failed') {
        if (this.iceDisconnectGraceTimer) {
          clearTimeout(this.iceDisconnectGraceTimer);
          this.iceDisconnectGraceTimer = null;
        }
        void this.attemptIceRestart('ice_failed');
      } else {
        this.notify();
      }
    };
  }

  private async processRemoteOffer(sdpInit: RTCSessionDescriptionInit): Promise<void> {
    if (!this.peerConnection || !this.currentSession) return;
    const pc = this.peerConnection;
    const readyForOffer = !this.makingOffer && (pc.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
    const offerCollision = !readyForOffer;
    const polite = this.isPolitePeer();

    this.ignoreOffer = !polite && offerCollision;
    if (this.ignoreOffer) {
      console.warn('[WebRTC] Ignoring colliding glare offer (impolite peer)');
      return;
    }

    try {
      if (polite && offerCollision) {
        await pc.setLocalDescription({ type: 'rollback' });
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sdpInit));

      // Bind local media tracks to existing transceivers before creating answer
      this.attachLocalTracksToPeerConnection(false);
      // If peer offered video m-line without us having a video track or screen share, mark recvonly
      const videoTransceiver = this.findTransceiverByKind('video');
      const hasLocalVideo =
        (!this.currentSession.isVideoOff &&
          !!this.currentSession.localStream?.getVideoTracks().some((t) => t.readyState === 'live')) ||
        !!this.currentSession.isScreenSharing;
      if (videoTransceiver && !hasLocalVideo && videoTransceiver.direction === 'sendrecv') {
        videoTransceiver.direction = 'recvonly';
      }

      await this.drainIceCandidates();

      const answer = await pc.createAnswer();
      const optimizedSdp = optimizeOpusSdp(answer.sdp || '', !!this.currentSession.isScreenSharing);
      const modifiedAnswer: RTCSessionDescriptionInit = { type: answer.type, sdp: optimizedSdp };
      await pc.setLocalDescription(modifiedAnswer);
      this.applyAudioSenderParameters();
      this.hasCompletedInitialNegotiation = true;

      this.sendSignal('sdp_answer', modifiedAnswer);
      if (
        this.pendingRenegotiationOptions &&
        !this.makingOffer &&
        !this.inFlightNegotiation &&
        pc.signalingState === 'stable'
      ) {
        const pendingOpts = this.pendingRenegotiationOptions;
        this.pendingRenegotiationOptions = null;
        void this.renegotiate(pendingOpts);
      }
    } catch (err: any) {
      console.warn('[WebRTC] Error processing sdp_offer:', err);
      if (this.currentSession && !this.hasCompletedInitialNegotiation) {
        this.recordCallOutcome('failed', this.currentSession.durationSeconds);
        this.cleanupCall('failed', 'sdp', err?.message || 'SDP negotiation failed');
      }
    }
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

  private cleanupCall(
    finalState: CallState = 'ended',
    failureStage?: CallFailureStage,
    failureReason?: string
  ) {
    this.clearAllCallTimers();
    this.stopRingingEffects();
    this.iceCandidateQueue = [];
    this.pendingRemoteOffers = [];
    this.isStarting = false;
    this.isAnswering = false;
    this.isTogglingScreenShare = false;
    this.isTogglingVideo = false;
    this.makingOffer = false;
    this.hasCompletedInitialNegotiation = false;
    this.suppressNegotiationNeeded = false;
    this.inFlightNegotiation = null;
    this.inFlightNegotiationToken = null;
    this.pendingRenegotiationOptions = null;

    if (this.screenAudioContext) {
      try {
        this.screenAudioContext.close();
      } catch {}
      this.screenAudioContext = null;
    }
    this.stopMediaStream(this.screenMixedStream);
    this.screenMixedStream = null;
    this.originalMicTrack = null;

    this.stopMediaStream(this.screenStream);
    this.screenStream = null;
    this.stopMediaStream(this.currentSession?.localStream);

    if (this.peerConnection) {
      try {
        this.peerConnection.onicecandidate = null;
        this.peerConnection.ontrack = null;
        this.peerConnection.onconnectionstatechange = null;
        this.peerConnection.oniceconnectionstatechange = null;
        this.peerConnection.onnegotiationneeded = null;
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    if (this.currentSession) {
      const closedCallId = this.currentSession.callId;
      this.currentSession.screenStream = undefined;
      this.currentSession.isScreenSharing = false;
      this.currentSession.peerScreenSharing = false;
      this.currentSession.hasRemoteVideo = false;
      this.currentSession.isReconnectingIce = false;
      if (failureStage) this.currentSession.failureStage = failureStage;
      if (failureReason) this.currentSession.failureReason = failureReason;
      this.currentSession.state = finalState;
      this.notify();

      this.cleanupTimer = setTimeout(() => {
        if (this.currentSession?.callId === closedCallId) {
          this.currentSession = null;
          this.cleanupTimer = null;
          this.notify();
        }
      }, finalState === 'failed' ? 3000 : 1500);
    }
  }

  // Handle incoming WebSocket call signals
  async handleIncomingSignal(signal: CallSignal) {
    if (!signal || !signal.call_id) return;

    if (signal.signal_type === 'invite') {
      // Ignore duplicate invite for the exact same active call session
      if (
        this.currentSession &&
        this.currentSession.callId === signal.call_id &&
        !this.isTerminalState(this.currentSession.state)
      ) {
        return;
      }

      const isSessionActive =
        this.isStarting || (this.currentSession && !this.isTerminalState(this.currentSession.state));
      if (isSessionActive) {
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

      this.attemptSeq++;
      this.iceCandidateQueue = [];
      this.pendingRemoteOffers = [];
      this.iceRestartAttempts = 0;
      this.hasCompletedInitialNegotiation = false;

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
        isVideoOff: signal.call_type !== 'video',
        autoplayBlocked: false,
        screenQuality: 'auto',
        localStreamRevision: 0,
        remoteStreamRevision: 0,
      };
      this.notify();

      wsManager.sendCallSignal({
        call_id: signal.call_id,
        conversation_id: signal.conversation_id,
        caller_id: signal.caller_id,
        receiver_id: this.currentUserId || '',
        call_type: signal.call_type,
        signal_type: 'ringing',
      });

      this.startRingingEffects(true);

      this.clearRingingTimeout();
      const ringingCallId = signal.call_id;
      this.ringingTimeoutTimer = setTimeout(() => {
        if (
          this.currentSession &&
          this.currentSession.callId === ringingCallId &&
          this.currentSession.state === 'incoming_ringing'
        ) {
          this.stopRingingEffects();
          this.recordCallOutcome('missed', 0);
          this.cleanupCall('timeout');
        }
      }, 35000);
      return;
    }

    // Strict call_id + peer matching for every non-invite signal
    if (!this.currentSession || this.currentSession.callId !== signal.call_id) {
      return;
    }
    const senderId = this.currentSession.isIncoming ? signal.caller_id : signal.receiver_id;
    if (senderId && this.currentSession.peerId && senderId !== this.currentSession.peerId) {
      return;
    }

    switch (signal.signal_type) {
      case 'ringing':
        if (!this.currentSession.isIncoming && this.currentSession.state === 'outgoing_calling') {
          this.currentSession.targetOffline = false;
          this.currentSession.state = 'outgoing_ringing';
          this.notify();
        }
        break;

      case 'accept':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        if (!this.currentSession.isIncoming && !this.isTerminalState(this.currentSession.state)) {
          const acceptedCallId = this.currentSession.callId;
          this.currentSession.targetOffline = false;
          this.currentSession.state = 'connecting';
          this.notify();
          this.startConnectingTimeout();

          await this.setupPeerConnection();
          if (!this.currentSession || this.currentSession.callId !== acceptedCallId || !this.peerConnection) {
            return;
          }

          this.attachLocalTracksToPeerConnection(true);

          try {
            this.makingOffer = true;
            const offer = await this.peerConnection.createOffer();
            if (!this.currentSession || this.currentSession.callId !== acceptedCallId || !this.peerConnection) {
              return;
            }
            const optimizedSdp = optimizeOpusSdp(offer.sdp || '', !!this.currentSession.isScreenSharing);
            const modifiedOffer: RTCSessionDescriptionInit = { type: offer.type, sdp: optimizedSdp };
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
          } catch (err: any) {
            console.warn('[WebRTC] Initial offer creation failed:', err);
            this.recordCallOutcome('failed', 0);
            this.cleanupCall('failed', 'sdp', err?.message || 'Failed to create SDP offer');
          } finally {
            this.makingOffer = false;
          }
        }
        break;

      case 'sdp_offer':
        if (!signal.data) break;
        if (this.isAnswering || !this.peerConnection) {
          this.pendingRemoteOffers.push({ callId: signal.call_id, sdp: signal.data });
        } else {
          await this.processRemoteOffer(signal.data);
        }
        break;

      case 'sdp_answer':
        if (this.peerConnection && signal.data) {
          this.isSettingRemoteAnswerPending = true;
          let answerApplied = false;
          try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.data));
            this.hasCompletedInitialNegotiation = true;
            await this.drainIceCandidates();
            answerApplied = true;
          } catch (err: any) {
            console.warn('[WebRTC] Error applying sdp_answer:', err);
          } finally {
            this.isSettingRemoteAnswerPending = false;
          }
          if (
            answerApplied &&
            this.peerConnection &&
            this.pendingRenegotiationOptions &&
            !this.makingOffer &&
            !this.inFlightNegotiation &&
            this.peerConnection.signalingState === 'stable'
          ) {
            const pendingOpts = this.pendingRenegotiationOptions;
            this.pendingRenegotiationOptions = null;
            void this.renegotiate(pendingOpts);
          }
        }
        break;

      case 'ice_candidate':
        if (signal.data) {
          if (!this.peerConnection || !this.peerConnection.remoteDescription || !this.peerConnection.remoteDescription.type) {
            this.iceCandidateQueue.push(signal.data);
          } else if (signal.data.candidate) {
            try {
              await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.data));
            } catch (e) {
              if (!this.ignoreOffer) {
                console.warn('[WebRTC] Error adding ICE candidate:', e);
              }
            }
          }
        }
        break;

      case 'video_state':
        if (typeof signal.data?.enabled === 'boolean') {
          this.currentSession.hasRemoteVideo = !!signal.data.enabled || !!this.currentSession.peerScreenSharing;
          this.currentSession.remoteStreamRevision = (this.currentSession.remoteStreamRevision || 0) + 1;
          this.notify();
        }
        break;

      case 'screen_share_start':
        this.currentSession.peerScreenSharing = true;
        this.currentSession.hasRemoteVideo = true;
        this.currentSession.remoteStreamRevision = (this.currentSession.remoteStreamRevision || 0) + 1;
        this.notify();
        break;

      case 'screen_share_stop':
        this.currentSession.peerScreenSharing = false;
        const hasVideoTrack = this.currentSession.remoteStream
          ?.getVideoTracks()
          .some((t) => t.readyState === 'live' && t.enabled && !t.muted);
        this.currentSession.hasRemoteVideo = !!hasVideoTrack;
        this.currentSession.remoteStreamRevision = (this.currentSession.remoteStreamRevision || 0) + 1;
        this.notify();
        break;

      case 'screen_quality_request':
        if (this.currentSession.isScreenSharing && signal.data?.quality) {
          void this.setScreenShareQuality(signal.data.quality);
        }
        break;

      case 'screen_quality_change':
        if (signal.data?.quality) {
          this.currentSession.screenQuality = signal.data.quality;
          this.notify();
        }
        break;

      case 'cancel':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        this.recordCallOutcome('missed', 0);
        this.cleanupCall('cancelled');
        break;

      case 'reject':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        this.recordCallOutcome('rejected', 0);
        this.cleanupCall(
          'rejected',
          undefined,
          signal.data?.reason === 'busy' ? 'User is busy on another call' : undefined
        );
        break;

      case 'hangup':
        this.clearRingingTimeout();
        this.stopRingingEffects();
        {
          const outcome = this.currentSession.state === 'connected' ? 'completed' : 'missed';
          this.recordCallOutcome(outcome, this.currentSession.durationSeconds);
          this.cleanupCall('ended');
        }
        break;
    }
  }
}

export const webrtcManager = new WebRTCManager();
