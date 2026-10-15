import { CallSignal } from '../../app/types';
import { wsManager } from '../../protocol/ws';
import { api } from '../../protocol/api';
import { soundManager } from './soundManager';

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
  isMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing?: boolean;
  autoplayBlocked?: boolean;
}

export type CallEventListener = (session: CallSession | null) => void;

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
  private unsubscribeWs: (() => void) | null = null;
  private loggedCallIds = new Set<string>();

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
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
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
        this.setIceServers(servers as RTCIceServer[]);
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
    callerAvatarUrl?: string
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
        audio: true,
        video: callType === 'video',
      });
    } catch (e: any) {
      console.error('Failed to get media devices:', e);
      alert('Could not access microphone/camera: ' + (e.message || 'Permission denied'));
      return;
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
    };
    this.notify();

    // Send invite signal via WebSocket
    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: '', // Server validates client ID
      receiver_id: peerId,
      call_type: callType,
      signal_type: 'invite',
      data: { peer_name: peerName, caller_avatar_url: callerAvatarUrl },
    });

    // Start outgoing ringback tone for caller
    soundManager.startOutgoingRingback(() => {
      if (this.currentSession) {
        this.currentSession.autoplayBlocked = true;
        this.notify();
      }
    });
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
    soundManager.stopAll();
    if (!this.currentSession || !this.currentSession.isIncoming) return;

    const { callType, callId, conversationId, peerId } = this.currentSession;

    let localStream: MediaStream | undefined;
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video',
      });
    } catch (e: any) {
      console.error('Failed to acquire media devices for answer:', e);
      this.rejectCall();
      alert('Could not access microphone/camera: ' + (e.message || 'Permission denied'));
      return;
    }

    this.currentSession.localStream = localStream;
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

    // Send accept signal
    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: peerId,
      receiver_id: '',
      call_type: callType,
      signal_type: 'accept',
    });
  }

  // Reject incoming call
  rejectCall(): void {
    soundManager.stopAll();
    if (!this.currentSession) return;

    const { callId, conversationId, peerId, callType } = this.currentSession;

    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: peerId,
      receiver_id: '',
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

  // Hangup call
  hangupCall(): void {
    soundManager.stopAll();
    if (!this.currentSession) return;

    const { callId, conversationId, peerId, callType, durationSeconds, state } = this.currentSession;

    const signalType = state === 'outgoing_calling' || state === 'outgoing_ringing' ? 'cancel' : 'hangup';
    wsManager.sendCallSignal({
      call_id: callId,
      conversation_id: conversationId,
      caller_id: '',
      receiver_id: peerId,
      call_type: callType,
      signal_type: signalType,
    });

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

    this.cleanupCall('ended');
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

  // Screen sharing toggle (Phase 14)
  async toggleScreenShare(): Promise<void> {
    if (!this.currentSession || !this.peerConnection) return;
    if (this.currentSession.isScreenSharing) {
      if (this.screenStream) {
        this.screenStream.getTracks().forEach((track) => track.stop());
        this.screenStream = null;
      }
      const videoSender = this.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
      const localVideoTrack = this.currentSession.localStream?.getVideoTracks()[0];
      if (videoSender && localVideoTrack) {
        await videoSender.replaceTrack(localVideoTrack);
      }
      this.currentSession.isScreenSharing = false;
      this.notify();
    } else {
      try {
        if (!navigator.mediaDevices?.getDisplayMedia) {
          throw new Error('Screen sharing not supported');
        }
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        this.screenStream = stream;
        const screenTrack = stream.getVideoTracks()[0];
        if (!screenTrack) return;

        screenTrack.onended = () => {
          if (this.currentSession?.isScreenSharing) {
            this.toggleScreenShare();
          }
        };

        const videoSender = this.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(screenTrack);
        } else {
          this.peerConnection.addTrack(screenTrack, stream);
        }
        this.currentSession.isScreenSharing = true;
        this.notify();
      } catch (err) {
        console.warn('Screen share cancelled or failed:', err);
      }
    }
  }

  // Private: Setup WebRTC connection
  private async setupPeerConnection(): Promise<void> {
    if (this.peerConnection) {
      this.peerConnection.close();
    }

    this.peerConnection = new RTCPeerConnection(this.rtcConfig);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate && this.currentSession) {
        wsManager.sendCallSignal({
          call_id: this.currentSession.callId,
          conversation_id: this.currentSession.conversationId,
          caller_id: '',
          receiver_id: this.currentSession.peerId,
          call_type: this.currentSession.callType,
          signal_type: 'ice_candidate',
          data: event.candidate,
        });
      }
    };

    this.peerConnection.ontrack = (event) => {
      if (this.currentSession) {
        this.currentSession.remoteStream = event.streams[0];
        this.notify();
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (!this.peerConnection || !this.currentSession) return;
      const state = this.peerConnection.connectionState;
      if (state === 'connected') {
        this.currentSession.state = 'connected';
        this.currentSession.startTime = Date.now();
        this.startDurationTimer();
        this.notify();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.cleanupCall('ended');
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      if (!this.peerConnection || !this.currentSession) return;
      const iceState = this.peerConnection.iceConnectionState;
      if (iceState === 'failed') {
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
    soundManager.stopAll();
    clearInterval(this.durationTimer);

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

    if (this.currentSession) {
      this.currentSession.state = finalState;
      this.notify();

      setTimeout(() => {
        this.currentSession = null;
        this.notify();
      }, 1500);
    }
  }

  // Handle incoming WebSocket call signals
  private async handleIncomingSignal(signal: CallSignal) {
    switch (signal.signal_type) {
      case 'invite':
        if (this.currentSession) {
          // Busy: reject
          wsManager.sendCallSignal({
            call_id: signal.call_id,
            conversation_id: signal.conversation_id,
            caller_id: signal.caller_id,
            receiver_id: '',
            call_type: signal.call_type,
            signal_type: 'reject',
            data: { reason: 'busy' },
          });
          return;
        }

        this.currentSession = {
          callId: signal.call_id,
          conversationId: signal.conversation_id,
          peerId: signal.caller_id,
          peerName: signal.data?.peer_name || 'Caller',
          peerAvatarUrl: signal.data?.caller_avatar_url,
          callType: signal.call_type,
          isIncoming: true,
          state: 'incoming_ringing',
          durationSeconds: 0,
          isMuted: false,
          isVideoOff: false,
          autoplayBlocked: false,
        };
        this.notify();

        // Send ringing acknowledgement back to caller
        wsManager.sendCallSignal({
          call_id: signal.call_id,
          conversation_id: signal.conversation_id,
          caller_id: signal.caller_id,
          receiver_id: '',
          call_type: signal.call_type,
          signal_type: 'ringing',
        });

        // Start incoming call ringtone
        soundManager.startIncomingRingtone(() => {
          if (this.currentSession) {
            this.currentSession.autoplayBlocked = true;
            this.notify();
          }
        });
        break;

      case 'ringing':
        if (this.currentSession && !this.currentSession.isIncoming && this.currentSession.state === 'outgoing_calling') {
          this.currentSession.state = 'outgoing_ringing';
          this.notify();
        }
        break;

      case 'accept':
        soundManager.stopAll();
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

          // Create SDP Offer
          if (this.peerConnection) {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            wsManager.sendCallSignal({
              call_id: this.currentSession.callId,
              conversation_id: this.currentSession.conversationId,
              caller_id: '',
              receiver_id: this.currentSession.peerId,
              call_type: this.currentSession.callType,
              signal_type: 'sdp_offer',
              data: offer,
            });
          }
        }
        break;

      case 'sdp_offer':
        if (this.currentSession && this.peerConnection) {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.data));
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);

          wsManager.sendCallSignal({
            call_id: this.currentSession.callId,
            conversation_id: this.currentSession.conversationId,
            caller_id: '',
            receiver_id: this.currentSession.peerId,
            call_type: this.currentSession.callType,
            signal_type: 'sdp_answer',
            data: answer,
          });
        }
        break;

      case 'sdp_answer':
        if (this.currentSession && this.peerConnection) {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.data));
        }
        break;

      case 'ice_candidate':
        if (this.peerConnection && signal.data) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.data));
          } catch (e) {
            console.warn('Error adding ICE candidate:', e);
          }
        }
        break;

      case 'cancel':
        if (this.currentSession) {
          this.persistCallEvent('missed', 0);
          this.cleanupCall('ended');
        }
        break;

      case 'reject':
        if (this.currentSession) {
          this.persistCallEvent('declined', 0);
          this.cleanupCall('rejected');
        }
        break;

      case 'hangup':
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
