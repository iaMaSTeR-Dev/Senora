import { VoiceChatParticipant, VoiceChatRoom, VoiceChatSignal } from '../../app/types';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';
import { mediaDeviceManager } from './mediaDeviceManager';
import { optimizeOpusSdp } from './webrtcManager';

export interface GroupVoiceChatState {
  conversationId: string | null;
  room: VoiceChatRoom | null;
  participants: VoiceChatParticipant[];
  isJoined: boolean;
  isMuted: boolean;
  isSpeaking: boolean;
  speakingLevel: number;
  remoteAudioLevels: Record<string, number>;
  peerIceStates: Record<string, RTCIceConnectionState>;
  playbackBlocked: boolean;
  meshWarning: boolean;
  myRole: string;
  loading: boolean;
  error: string | null;
}

interface MeshPeer {
  userId: string;
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  iceQueue: RTCIceCandidateInit[];
  iceRestartAttempts: number;
  disconnectTimer: any;
  remoteStream?: MediaStream;
  audioEl?: HTMLAudioElement;
  analyserSource?: MediaStreamAudioSourceNode;
  analyser?: AnalyserNode;
}

const DEFAULT_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
  'stun:stun.services.mozilla.com:3478',
  'stun:stun.nextcloud.com:443',
];

const MAX_MESH_PEERS = 8;

type StateListener = (state: GroupVoiceChatState) => void;

class GroupVoiceChatManager {
  private currentUserId = '';
  private activeConversationId: string | null = null;
  private room: VoiceChatRoom | null = null;
  private participants: VoiceChatParticipant[] = [];
  private isJoined = false;
  private isMuted = false;
  private isSpeaking = false;
  private speakingLevel = 0;
  private remoteAudioLevels: Record<string, number> = {};
  private peerIceStates: Record<string, RTCIceConnectionState> = {};
  private playbackBlocked = false;
  private meshWarning = false;
  private myRole = 'member';
  private loading = false;
  private error: string | null = null;

  private listeners: Set<StateListener> = new Set();
  private peers: Map<string, MeshPeer> = new Map();
  private localStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private localAnalyser: AnalyserNode | null = null;
  private localSource: MediaStreamAudioSourceNode | null = null;
  private levelTimer: any = null;
  private iceServers: RTCIceServer[] = [{ urls: DEFAULT_STUN_URLS }];
  private iceServersPromise: Promise<void> | null = null;

  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeWsConn: (() => void) | null = null;
  private pageHideAttached = false;
  private joinSeq = 0;
  private isJoining = false;
  private audioContainer: HTMLDivElement | null = null;

  setUserId(id: string) {
    this.currentUserId = id;
  }

  private getSnapshot(): GroupVoiceChatState {
    return {
      conversationId: this.activeConversationId,
      room: this.room,
      participants: this.participants,
      isJoined: this.isJoined,
      isMuted: this.isMuted,
      isSpeaking: this.isSpeaking,
      speakingLevel: this.speakingLevel,
      remoteAudioLevels: { ...this.remoteAudioLevels },
      peerIceStates: { ...this.peerIceStates },
      playbackBlocked: this.playbackBlocked,
      meshWarning: this.meshWarning,
      myRole: this.myRole,
      loading: this.loading,
      error: this.error,
    };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const snap = this.getSnapshot();
    for (const cb of this.listeners) {
      cb(snap);
    }
  }

  private ensureAudioContainer(): HTMLDivElement | null {
    if (typeof document === 'undefined' || !document.body) return null;
    if (!this.audioContainer || !document.body.contains(this.audioContainer)) {
      const div = document.createElement('div');
      div.setAttribute('data-senora-voice-chat-audio', 'true');
      div.style.display = 'none';
      document.body.appendChild(div);
      this.audioContainer = div;
    }
    return this.audioContainer;
  }

  private isPolitePeer(remoteUserId: string): boolean {
    if (!this.currentUserId || !remoteUserId) return true;
    return this.currentUserId < remoteUserId;
  }

  init() {
    if (!this.unsubscribeWs) {
      this.unsubscribeWs = wsManager.subscribe((event) => {
        this.handleWsEvent(event);
      });
    }

    if (!this.unsubscribeWsConn && typeof (wsManager as any).onConnectionChange === 'function') {
      this.unsubscribeWsConn = (wsManager as any).onConnectionChange((connected: boolean) => {
        if (connected && this.isJoined && this.activeConversationId) {
          void this.refreshRoomState(this.activeConversationId);
          for (const [peerId, peer] of this.peers.entries()) {
            if (peer.pc.iceConnectionState === 'disconnected' || peer.pc.iceConnectionState === 'failed') {
              void this.attemptPeerIceRestart(peerId);
            }
          }
        }
      });
    }

    if (!this.pageHideAttached && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      this.pageHideAttached = true;
      window.addEventListener('pagehide', () => {
        if (this.isJoined && this.activeConversationId) {
          void this.leaveRoom();
        }
      });
    }

    if (!this.iceServersPromise) {
      void this.refreshIceServers();
    }
  }

  getIceServers(): RTCIceServer[] {
    return this.iceServers;
  }

  async refreshIceServers(): Promise<void> {
    if (typeof api.getIceServers !== 'function') return;
    const reqPromise = api
      .getIceServers()
      .then((servers) => {
        if (this.iceServersPromise === reqPromise && Array.isArray(servers)) {
          // Honor server policy verbatim: STUN_SERVERS=none yields [] or TURN-only without injecting default STUN
          this.iceServers = servers as RTCIceServer[];
        }
      })
      .catch(() => {});
    this.iceServersPromise = reqPromise;
    await reqPromise;
  }

  async openConversationRoom(conversationId: string): Promise<void> {
    this.init();
    if (this.activeConversationId && this.activeConversationId !== conversationId && this.isJoined) {
      await this.leaveRoom();
    }
    this.activeConversationId = conversationId;
    this.error = null;
    this.loading = true;
    this.myRole = 'member';
    this.notify();

    if (typeof api.getConversationRole === 'function') {
      api
        .getConversationRole(conversationId)
        .then((res) => {
          if (this.activeConversationId === conversationId && res?.role) {
            this.myRole = res.role;
            this.notify();
          }
        })
        .catch(() => {});
    }

    await this.refreshRoomState(conversationId);
  }

  async refreshRoomState(conversationId: string = this.activeConversationId || ''): Promise<void> {
    if (!conversationId) return;
    try {
      const res = await api.getActiveVoiceChat(conversationId);
      if (this.activeConversationId !== conversationId) return;
      this.room = res.room || null;
      this.participants = Array.isArray(res.participants) ? res.participants : [];
      this.meshWarning = this.participants.length > MAX_MESH_PEERS;

      if (!this.room && this.isJoined) {
        this.teardownLocalMediaAndPeers();
        this.isJoined = false;
      } else if (this.isJoined && this.room) {
        await this.syncMeshPeers();
      }
    } catch {
      if (this.activeConversationId === conversationId) {
        this.room = null;
        this.participants = [];
      }
    } finally {
      if (this.activeConversationId === conversationId) {
        this.loading = false;
        this.notify();
      }
    }
  }

  async joinRoom(conversationId: string): Promise<void> {
    this.init();
    if (this.isJoining) return;
    if (this.activeConversationId && this.activeConversationId !== conversationId && this.isJoined) {
      await this.leaveRoom();
    }

    this.activeConversationId = conversationId;
    this.isJoining = true;
    const seq = ++this.joinSeq;
    this.error = null;
    this.loading = true;
    this.notify();

    let acquiredStream: MediaStream;
    try {
      acquiredStream = await mediaDeviceManager.getAudioStream();
    } catch (err: any) {
      this.isJoining = false;
      this.loading = false;
      this.error = err?.message || 'Microphone access denied or error joining voice chat';
      this.notify();
      return;
    }

    if (seq !== this.joinSeq || this.activeConversationId !== conversationId) {
      acquiredStream.getTracks().forEach((t) => t.stop());
      this.isJoining = false;
      this.loading = false;
      this.notify();
      return;
    }

    try {
      if (this.iceServersPromise) {
        await Promise.race([this.iceServersPromise, new Promise<void>((r) => setTimeout(r, 1500))]);
      }

      const res = await api.startOrJoinVoiceChat(conversationId);
      if (seq !== this.joinSeq || this.activeConversationId !== conversationId) {
        acquiredStream.getTracks().forEach((t) => t.stop());
        void api.leaveVoiceChat(conversationId).catch(() => {});
        this.isJoining = false;
        this.loading = false;
        return;
      }

      this.localStream = acquiredStream;
      this.room = res.room;
      this.participants = Array.isArray(res.participants) ? res.participants : [];
      this.isJoined = true;
      this.isMuted = false;
      this.isSpeaking = false;
      this.meshWarning = this.participants.length > MAX_MESH_PEERS;

      this.setupAudioMonitorLoop();

      // Backend JoinVoiceChat initializes is_muted=true by default; immediately synchronize unmuted state
      api.updateVoiceChatState(conversationId, { is_muted: false, is_speaking: false }).catch(() => {});

      await this.syncMeshPeers();

      wsManager.sendVoiceChatSignal({
        conversation_id: conversationId,
        room_id: res.room.id,
        signal_type: 'peer_joined',
      });
    } catch (err: any) {
      acquiredStream.getTracks().forEach((t) => t.stop());
      this.error = err?.message || 'Failed to join voice chat';
    } finally {
      this.isJoining = false;
      this.loading = false;
      this.notify();
    }
  }

  async toggleMute(): Promise<void> {
    if (!this.isJoined || !this.localStream || !this.activeConversationId) return;
    const nextMuted = !this.isMuted;
    this.isMuted = nextMuted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    if (nextMuted) {
      this.isSpeaking = false;
      this.speakingLevel = 0;
    }
    this.notify();
    try {
      await api.updateVoiceChatState(this.activeConversationId, {
        is_muted: nextMuted,
        is_speaking: false,
      });
    } catch (e) {
      console.warn('[GroupVoiceChat] Update mute state error:', e);
    }
  }

  async switchMicrophone(deviceId: string): Promise<void> {
    mediaDeviceManager.setSelectedAudioInputId(deviceId);
    if (!this.isJoined) return;
    const newStream = await mediaDeviceManager.getAudioStream(undefined, deviceId);
    const newTrack = newStream.getAudioTracks()[0];
    if (!newTrack) {
      newStream.getTracks().forEach((t) => t.stop());
      return;
    }
    if (!this.isJoined) {
      newStream.getTracks().forEach((t) => t.stop());
      return;
    }
    newTrack.enabled = !this.isMuted;

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((t) => {
        t.stop();
        this.localStream!.removeTrack(t);
      });
      this.localStream.addTrack(newTrack);
    } else {
      this.localStream = newStream;
    }

    for (const peer of this.peers.values()) {
      const audioSender = peer.pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (audioSender) {
        await audioSender.replaceTrack(newTrack).catch(() => {});
      }
    }

    this.setupAudioMonitorLoop();
    this.notify();
  }

  async refreshAudioOutput(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.audioEl) {
        await mediaDeviceManager.applyAudioOutput(peer.audioEl);
      }
    }
  }

  async unlockPlayback(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume().catch(() => {});
    }
    let stillBlocked = false;
    for (const peer of this.peers.values()) {
      if (peer.audioEl) {
        try {
          await peer.audioEl.play();
        } catch (err: any) {
          if (err?.name === 'NotAllowedError') {
            stillBlocked = true;
          }
        }
      }
    }
    this.playbackBlocked = stillBlocked;
    this.notify();
  }

  async leaveRoom(): Promise<void> {
    this.joinSeq++;
    this.isJoining = false;
    const convId = this.activeConversationId;
    const roomId = this.room?.id || '';
    const wasJoined = this.isJoined;

    this.teardownLocalMediaAndPeers();
    this.isJoined = false;
    this.isMuted = false;
    this.isSpeaking = false;
    this.speakingLevel = 0;
    this.playbackBlocked = false;
    this.remoteAudioLevels = {};
    this.peerIceStates = {};
    this.notify();

    if (wasJoined && convId) {
      try {
        if (roomId) {
          wsManager.sendVoiceChatSignal({
            conversation_id: convId,
            room_id: roomId,
            signal_type: 'peer_left',
          });
        }
        await api.leaveVoiceChat(convId);
        await this.refreshRoomState(convId);
      } catch (e) {
        console.warn('[GroupVoiceChat] Leave error:', e);
      }
    }
  }

  async endRoomForEveryone(): Promise<boolean> {
    if (!this.activeConversationId) return false;
    const convId = this.activeConversationId;
    await api.endVoiceChat(convId);
    this.teardownLocalMediaAndPeers();
    this.isJoined = false;
    this.room = null;
    this.participants = [];
    this.notify();
    return true;
  }

  private teardownLocalMediaAndPeers() {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    if (this.localSource) {
      try {
        this.localSource.disconnect();
      } catch {}
      this.localSource = null;
    }
    if (this.localAnalyser) {
      try {
        this.localAnalyser.disconnect();
      } catch {}
      this.localAnalyser = null;
    }

    for (const peerId of Array.from(this.peers.keys())) {
      this.closePeer(peerId);
    }

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      this.localStream = null;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  dispose(): void {
    this.joinSeq++;
    this.isJoining = false;
    this.teardownLocalMediaAndPeers();
    this.isJoined = false;
    this.room = null;
    this.participants = [];
    this.activeConversationId = null;
    this.error = null;
    this.loading = false;
    this.isMuted = false;
    this.isSpeaking = false;
    this.speakingLevel = 0;
    this.playbackBlocked = false;
    this.remoteAudioLevels = {};
    this.peerIceStates = {};
    this.iceServersPromise = null;
    this.iceServers = [{ urls: DEFAULT_STUN_URLS }];
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
    this.notify();
  }

  private setupAudioMonitorLoop() {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    const AudioCtxClass = typeof window !== 'undefined' ? window.AudioContext || (window as any).webkitAudioContext : null;
    if (!AudioCtxClass) return;

    try {
      if (!this.audioCtx || this.audioCtx.state === 'closed') {
        this.audioCtx = new AudioCtxClass();
      }
      if (this.localSource) {
        try {
          this.localSource.disconnect();
        } catch {}
        this.localSource = null;
      }
      if (this.localStream && this.localStream.getAudioTracks().length > 0) {
        this.localSource = this.audioCtx.createMediaStreamSource(this.localStream);
        this.localAnalyser = this.audioCtx.createAnalyser();
        this.localAnalyser.fftSize = 64;
        this.localSource.connect(this.localAnalyser);
      }

      // Attach analysers for any remote peer streams already received
      for (const peer of this.peers.values()) {
        this.attachRemoteAnalyser(peer);
      }
    } catch (e) {
      console.warn('[GroupVoiceChat] AudioContext init warning:', e);
    }

    let prevSpeaking = false;
    const buf = new Uint8Array(32);

    this.levelTimer = setInterval(() => {
      if (!this.isJoined) return;
      let changed = false;

      if (this.localAnalyser) {
        this.localAnalyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length;
        const nextLevel = this.isMuted ? 0 : Math.min(100, Math.round(avg * 1.5));
        if (nextLevel !== this.speakingLevel) {
          this.speakingLevel = nextLevel;
          changed = true;
        }
        const nowSpeaking = avg > 10 && !this.isMuted;
        if (nowSpeaking !== prevSpeaking) {
          prevSpeaking = nowSpeaking;
          this.isSpeaking = nowSpeaking;
          changed = true;
          if (this.activeConversationId) {
            api
              .updateVoiceChatState(this.activeConversationId, {
                is_muted: this.isMuted,
                is_speaking: nowSpeaking,
              })
              .catch(() => {});
          }
        }
      }

      for (const [peerId, peer] of this.peers.entries()) {
        if (!peer.analyser) continue;
        peer.analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i];
        const avg = sum / buf.length;
        const level = Math.min(100, Math.round(avg * 1.6));
        if (this.remoteAudioLevels[peerId] !== level) {
          this.remoteAudioLevels[peerId] = level;
          changed = true;
        }
      }

      if (changed) {
        this.notify();
      }
    }, 150);
  }

  private attachRemoteAnalyser(peer: MeshPeer) {
    if (!peer.remoteStream || !this.audioCtx || this.audioCtx.state === 'closed') return;
    if (peer.remoteStream.getAudioTracks().length === 0) return;
    try {
      if (peer.analyserSource) peer.analyserSource.disconnect();
      peer.analyserSource = this.audioCtx.createMediaStreamSource(peer.remoteStream);
      peer.analyser = this.audioCtx.createAnalyser();
      peer.analyser.fftSize = 64;
      peer.analyserSource.connect(peer.analyser);
    } catch {}
  }

  private async syncMeshPeers(): Promise<void> {
    if (!this.isJoined || !this.room || !this.activeConversationId) return;

    const activeRemoteIds = new Set<string>();
    for (const p of this.participants) {
      if (p.user_id && p.user_id !== this.currentUserId) {
        activeRemoteIds.add(p.user_id);
      }
    }

    // Remove peers who left
    for (const existingPeerId of Array.from(this.peers.keys())) {
      if (!activeRemoteIds.has(existingPeerId)) {
        this.closePeer(existingPeerId);
      }
    }

    // Connect missing peers (cap at MAX_MESH_PEERS to prevent browser CPU overload)
    for (const remoteUserId of activeRemoteIds) {
      if (!this.peers.has(remoteUserId)) {
        if (this.peers.size >= MAX_MESH_PEERS) {
          this.meshWarning = true;
          continue;
        }
        const shouldInitiate = !!this.currentUserId && this.currentUserId > remoteUserId;
        this.createPeer(remoteUserId, shouldInitiate);
      }
    }
    this.notify();
  }

  private createPeer(remoteUserId: string, initiateOffer: boolean): MeshPeer {
    const existing = this.peers.get(remoteUserId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 2,
    });

    const peer: MeshPeer = {
      userId: remoteUserId,
      pc,
      makingOffer: false,
      ignoreOffer: false,
      iceQueue: [],
      iceRestartAttempts: 0,
      disconnectTimer: null,
    };
    this.peers.set(remoteUserId, peer);
    this.peerIceStates[remoteUserId] = pc.iceConnectionState;

    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || !this.activeConversationId || !this.room) return;
      const candData = event.candidate.toJSON
        ? event.candidate.toJSON()
        : {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          };
      wsManager.sendVoiceChatSignal({
        conversation_id: this.activeConversationId,
        room_id: this.room.id,
        target_user_id: remoteUserId,
        signal_type: 'ice_candidate',
        data: candData,
      });
    };

    pc.ontrack = (event) => {
      if (!peer.remoteStream) {
        peer.remoteStream = new MediaStream();
      }
      if (!peer.remoteStream.getTracks().some((t) => t.id === event.track.id)) {
        peer.remoteStream.addTrack(event.track);
      }
      if (event.streams?.[0]) {
        event.streams[0].getTracks().forEach((t) => {
          if (!peer.remoteStream!.getTracks().some((x) => x.id === t.id)) {
            peer.remoteStream!.addTrack(t);
          }
        });
      }

      if (typeof document !== 'undefined') {
        if (!peer.audioEl) {
          const el = document.createElement('audio');
          el.autoplay = true;
          el.setAttribute('playsinline', 'true');
          el.setAttribute('data-vc-peer', remoteUserId);
          this.ensureAudioContainer()?.appendChild(el);
          peer.audioEl = el;
        }
        if (peer.audioEl.srcObject !== peer.remoteStream) {
          peer.audioEl.srcObject = peer.remoteStream;
        }
        void mediaDeviceManager.applyAudioOutput(peer.audioEl);
        const playPromise = peer.audioEl.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.catch((err) => {
            if (err?.name === 'NotAllowedError') {
              this.playbackBlocked = true;
              this.notify();
            }
          });
        }
      }

      this.attachRemoteAnalyser(peer);
      this.notify();
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.peerIceStates[remoteUserId] = state;

      if (state === 'connected' || state === 'completed') {
        peer.iceRestartAttempts = 0;
        if (peer.disconnectTimer) {
          clearTimeout(peer.disconnectTimer);
          peer.disconnectTimer = null;
        }
      } else if (state === 'disconnected') {
        if (!peer.disconnectTimer) {
          peer.disconnectTimer = setTimeout(() => {
            peer.disconnectTimer = null;
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
              void this.attemptPeerIceRestart(remoteUserId);
            }
          }, 3500);
        }
      } else if (state === 'failed') {
        if (peer.disconnectTimer) {
          clearTimeout(peer.disconnectTimer);
          peer.disconnectTimer = null;
        }
        void this.attemptPeerIceRestart(remoteUserId);
      }
      this.notify();
    };

    if (initiateOffer) {
      void this.createAndSendOffer(remoteUserId);
    }

    return peer;
  }

  private async createAndSendOffer(remoteUserId: string, options?: RTCOfferOptions) {
    const peer = this.peers.get(remoteUserId);
    if (!peer || !this.activeConversationId || !this.room || peer.makingOffer) return;

    try {
      peer.makingOffer = true;
      const offer = await peer.pc.createOffer(options);
      const optimized: RTCSessionDescriptionInit = {
        type: offer.type,
        sdp: optimizeOpusSdp(offer.sdp || '', false),
      };
      await peer.pc.setLocalDescription(optimized);
      wsManager.sendVoiceChatSignal({
        conversation_id: this.activeConversationId,
        room_id: this.room.id,
        target_user_id: remoteUserId,
        signal_type: 'sdp_offer',
        data: optimized,
      });
    } catch (err) {
      console.warn(`[GroupVoiceChat] createOffer to ${remoteUserId} error:`, err);
    } finally {
      peer.makingOffer = false;
    }
  }

  private async attemptPeerIceRestart(remoteUserId: string) {
    const peer = this.peers.get(remoteUserId);
    if (!peer || !this.isJoined || peer.iceRestartAttempts >= 2) return;
    peer.iceRestartAttempts++;
    try {
      if (typeof peer.pc.restartIce === 'function') {
        peer.pc.restartIce();
      }
      if (peer.pc.signalingState === 'stable') {
        await this.createAndSendOffer(remoteUserId, { iceRestart: true });
      }
    } catch (e) {
      console.warn(`[GroupVoiceChat] ICE restart for ${remoteUserId} error:`, e);
    }
  }

  private closePeer(remoteUserId: string) {
    const peer = this.peers.get(remoteUserId);
    if (!peer) return;
    if (peer.disconnectTimer) {
      clearTimeout(peer.disconnectTimer);
    }
    try {
      peer.analyserSource?.disconnect();
      peer.analyser?.disconnect();
    } catch {}
    if (peer.audioEl) {
      try {
        peer.audioEl.pause();
        peer.audioEl.srcObject = null;
        peer.audioEl.remove();
      } catch {}
    }
    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.oniceconnectionstatechange = null;
      peer.pc.close();
    } catch {}
    this.peers.delete(remoteUserId);
    delete this.remoteAudioLevels[remoteUserId];
    delete this.peerIceStates[remoteUserId];
  }

  private async drainPeerIceCandidates(peer: MeshPeer) {
    if (!peer.pc.remoteDescription) return;
    while (peer.iceQueue.length > 0) {
      const cand = peer.iceQueue.shift();
      if (cand?.candidate) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(cand));
        } catch {}
      }
    }
  }

  private handleWsEvent(event: { type: string; payload: any }) {
    if (!this.activeConversationId || !event?.payload) return;
    const convId = event.payload.conversation_id;
    if (convId !== this.activeConversationId) return;

    switch (event.type) {
      case 'voice_chat.ended':
        this.teardownLocalMediaAndPeers();
        this.isJoined = false;
        this.room = null;
        this.participants = [];
        this.notify();
        break;

      case 'voice_chat.participant_joined':
        if (event.payload.participant) {
          const joined = event.payload.participant as VoiceChatParticipant;
          const idx = this.participants.findIndex((p) => p.user_id === joined.user_id);
          if (idx >= 0) {
            this.participants = this.participants.map((p, i) => (i === idx ? { ...p, ...joined } : p));
          } else {
            this.participants = [...this.participants, joined];
          }
          if (this.room && typeof event.payload.count === 'number') {
            this.room = { ...this.room, participant_count: event.payload.count };
          }
          this.meshWarning = this.participants.length > MAX_MESH_PEERS;
          if (this.isJoined) {
            void this.syncMeshPeers();
          }
          this.notify();
        } else {
          void this.refreshRoomState(convId);
        }
        break;

      case 'voice_chat.participant_left':
        if (event.payload.user_id) {
          const leftId = event.payload.user_id as string;
          this.participants = this.participants.filter((p) => p.user_id !== leftId);
          this.closePeer(leftId);
          if (this.room && typeof event.payload.count === 'number') {
            this.room = { ...this.room, participant_count: event.payload.count };
          }
          this.meshWarning = this.participants.length > MAX_MESH_PEERS;
          this.notify();
        } else {
          void this.refreshRoomState(convId);
        }
        break;

      case 'voice_chat.participant_updated':
        if (event.payload.user_id) {
          const uid = event.payload.user_id as string;
          this.participants = this.participants.map((p) =>
            p.user_id === uid
              ? {
                  ...p,
                  is_muted: typeof event.payload.is_muted === 'boolean' ? event.payload.is_muted : p.is_muted,
                  is_speaking:
                    typeof event.payload.is_speaking === 'boolean' ? event.payload.is_speaking : p.is_speaking,
                }
              : p
          );
          this.notify();
        }
        break;

      case 'voice_chat.signal':
        void this.handleVoiceChatSignal(event.payload as VoiceChatSignal);
        break;
    }
  }

  private async handleVoiceChatSignal(signal: VoiceChatSignal) {
    if (!this.isJoined || !this.room || signal.room_id !== this.room.id) return;

    const senderId = signal.sender_user_id;
    if (!senderId || senderId === this.currentUserId) return;

    // Never trust forged room_ended over WS signal channel; real termination comes only from voice_chat.ended
    if ((signal.signal_type as string) === 'room_ended') return;

    if (signal.signal_type === 'peer_joined') {
      await this.refreshRoomState(signal.conversation_id);
      return;
    }

    if (signal.signal_type === 'peer_left') {
      this.closePeer(senderId);
      this.participants = this.participants.filter((p) => p.user_id !== senderId);
      this.notify();
      return;
    }

    let peer = this.peers.get(senderId);
    if (!peer && (signal.signal_type === 'sdp_offer' || signal.signal_type === 'ice_candidate')) {
      peer = this.createPeer(senderId, false);
    }
    if (!peer) return;

    if (signal.signal_type === 'sdp_offer' && signal.data) {
      const offerCollision = peer.makingOffer || peer.pc.signalingState !== 'stable';
      const polite = this.isPolitePeer(senderId);
      peer.ignoreOffer = !polite && offerCollision;
      if (peer.ignoreOffer) return;

      try {
        if (polite && offerCollision) {
          await peer.pc.setLocalDescription({ type: 'rollback' });
        }
        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
        await this.drainPeerIceCandidates(peer);
        const answer = await peer.pc.createAnswer();
        const optimized: RTCSessionDescriptionInit = {
          type: answer.type,
          sdp: optimizeOpusSdp(answer.sdp || '', false),
        };
        await peer.pc.setLocalDescription(optimized);
        wsManager.sendVoiceChatSignal({
          conversation_id: signal.conversation_id,
          room_id: this.room.id,
          target_user_id: senderId,
          signal_type: 'sdp_answer',
          data: optimized,
        });
      } catch (err) {
        console.warn(`[GroupVoiceChat] sdp_offer from ${senderId} failed:`, err);
      }
    } else if (signal.signal_type === 'sdp_answer' && signal.data) {
      try {
        await peer.pc.setRemoteDescription(new RTCSessionDescription(signal.data));
        await this.drainPeerIceCandidates(peer);
      } catch (err) {
        console.warn(`[GroupVoiceChat] sdp_answer from ${senderId} failed:`, err);
      }
    } else if (signal.signal_type === 'ice_candidate' && signal.data) {
      if (!peer.pc.remoteDescription || !peer.pc.remoteDescription.type) {
        peer.iceQueue.push(signal.data);
      } else if (signal.data.candidate) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(signal.data));
        } catch {}
      }
    }
  }
}

export const groupVoiceChatManager = new GroupVoiceChatManager();
