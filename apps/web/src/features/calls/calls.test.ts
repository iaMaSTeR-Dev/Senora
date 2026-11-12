import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { webrtcManager, CallSession, optimizeOpusSdp } from './webrtcManager';
import { mediaDeviceManager } from './mediaDeviceManager';
import { wsManager } from '../../protocol/ws';
import { api } from '../../protocol/api';

vi.mock('../../protocol/ws', () => ({
  wsManager: {
    sendCallSignal: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onConnectionChange: vi.fn().mockReturnValue(() => {}),
    on: vi.fn(),
    off: vi.fn(),
  },
}));

vi.mock('../../protocol/api', () => ({
  api: {
    submitMessage: vi.fn().mockResolvedValue({}),
    createCallLog: vi.fn().mockResolvedValue({}),
    getIceServers: vi.fn().mockResolvedValue([]),
    getToken: vi.fn().mockReturnValue('mock_token'),
  },
}));

class MockAudioContext {
  static instances: MockAudioContext[] = [];
  state = 'running';
  currentTime = 0;
  destination = {};
  lastMixedTrack: FakeTrack | null = null;
  constructor() {
    MockAudioContext.instances.push(this);
  }
  createOscillator = vi.fn().mockReturnValue({
    type: 'sine',
    frequency: { setValueAtTime: vi.fn() },
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  });
  createGain = vi.fn().mockReturnValue({
    gain: {
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      exponentialRampToValueAtTime: vi.fn(),
    },
    connect: vi.fn(),
  });
  createMediaStreamDestination = vi.fn(() => {
    const mixedTrack = new FakeTrack('audio');
    this.lastMixedTrack = mixedTrack;
    return {
      stream: new FakeMediaStream([mixedTrack]),
    };
  });
  createMediaStreamSource = vi.fn().mockReturnValue({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  resume = vi.fn().mockResolvedValue(undefined);
  close = vi.fn().mockResolvedValue(undefined);
}

class MockRTCSessionDescription {
  type: any;
  sdp: any;
  constructor(init: any) {
    Object.assign(this, init);
  }
}

class MockRTCIceCandidate {
  candidate: any;
  sdpMid: any;
  sdpMLineIndex: any;
  usernameFragment: any;
  constructor(init: any) {
    Object.assign(this, init);
  }
  toJSON() {
    return {
      candidate: this.candidate,
      sdpMid: this.sdpMid,
      sdpMLineIndex: this.sdpMLineIndex,
      usernameFragment: this.usernameFragment,
    };
  }
}

describe('WebRTC Call Lifecycle and State Transitions', () => {
  beforeEach(() => {
    // Mock navigator.vibrate
    vi.stubGlobal('navigator', {
      vibrate: vi.fn(),
    });
    // Mock AudioContext with proper constructible class
    vi.stubGlobal('AudioContext', MockAudioContext);

    // Mock localStorage
    const mockStorage: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key in mockStorage ? mockStorage[key] : null),
      setItem: (key: string, val: string) => {
        mockStorage[key] = val;
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {},
    });

    webrtcManager.dispose();
    webrtcManager.setUserId('user_bob_callee');
    vi.clearAllMocks();
  });

  afterEach(() => {
    webrtcManager.dispose();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('transitions from idle to incoming_ringing upon receiving a valid invite', async () => {
    let currentSession: CallSession | null = null;
    const unsubscribe = webrtcManager.subscribe((session) => {
      currentSession = session;
    });

    expect(webrtcManager.getSession()).toBeNull();

    // Simulate incoming call signal from Alice to Bob
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_999',
      conversation_id: 'conv_123',
      caller_id: 'user_alice_caller',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'invite',
      data: {
        caller_name: 'Alice Cooper',
        caller_avatar: 'https://example.com/alice.png',
      },
    });

    expect(currentSession).not.toBeNull();
    expect(currentSession!.state).toBe('incoming_ringing');
    expect(currentSession!.callId).toBe('call_999');
    expect(currentSession!.conversationId).toBe('conv_123');
    expect(currentSession!.peerId).toBe('user_alice_caller');
    expect(currentSession!.peerName).toBe('Alice Cooper');
    expect(currentSession!.callType).toBe('video');
    expect(currentSession!.isIncoming).toBe(true);

    unsubscribe();
  });

  it('rejects a second incoming call as busy when already in an active call', async () => {
    // 1. Put Bob into an active call with Alice
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_active_1',
      conversation_id: 'conv_123',
      caller_id: 'user_alice_caller',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');
    expect(webrtcManager.getSession()?.callId).toBe('call_active_1');

    // 2. Third-party Charlie calls Bob while Bob is already ringing
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_charlie_2',
      conversation_id: 'conv_456',
      caller_id: 'user_charlie',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'invite',
      data: { caller_name: 'Charlie' },
    });

    // Bob's active call must NOT be corrupted or overwritten
    expect(webrtcManager.getSession()?.callId).toBe('call_active_1');
    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');

    // Server/Charlie must have received a busy rejection
    expect(wsManager.sendCallSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        call_id: 'call_charlie_2',
        receiver_id: 'user_bob_callee',
        signal_type: 'reject',
        data: { reason: 'busy' },
      })
    );
  });

  it('handles caller cancellation and resets state to ended', async () => {
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_cancel_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');

    // Caller cancels
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_cancel_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'cancel',
    });

    expect(webrtcManager.getSession()?.state).toBe('cancelled');
  });

  it('cleans up resources and transitions to rejected on declineCall', async () => {
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_decline_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');

    webrtcManager.declineCall();

    expect(wsManager.sendCallSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        call_id: 'call_decline_test',
        signal_type: 'reject',
      })
    );
    expect(webrtcManager.getSession()?.state).toBe('rejected');
  });

  it('times out incoming ringing after duration and ends call', async () => {
    vi.useFakeTimers();

    await webrtcManager.handleIncomingSignal({
      call_id: 'call_timeout_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');

    // Fast-forward 36 seconds (ringing timeout is 35s)
    vi.advanceTimersByTime(36000);

    expect(webrtcManager.getSession()?.state).toBe('timeout');

    vi.useRealTimers();
  });

  it('handles peer screen_share_start and screen_share_stop signals properly', async () => {
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_screen_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    // Remote peer starts screen sharing
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_screen_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'screen_share_start',
    });

    expect(webrtcManager.getSession()?.peerScreenSharing).toBe(true);
    expect(webrtcManager.getSession()?.hasRemoteVideo).toBe(true);

    // Remote peer stops screen sharing
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_screen_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'audio',
      signal_type: 'screen_share_stop',
    });

    expect(webrtcManager.getSession()?.peerScreenSharing).toBe(false);
  });

  it('safely queues ICE candidates arriving before remote description is set', async () => {
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_ice_queue_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    // Send early ICE candidate before SDP offer / remote description
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_ice_queue_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'ice_candidate',
      data: { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
    });

    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');
  });

  it('keeps early candidates queued across call states until remote description is established', async () => {
    // 1. Invite received
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_early_cand_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    // 2. Early candidate arrives before accept
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_early_cand_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'ice_candidate',
      data: { candidate: 'candidate:early 1 UDP 2130706431 1.2.3.4 50000 typ srflx', sdpMid: '0', sdpMLineIndex: 0 },
    });

    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');
  });

  it('optimizes Opus SDP with stereo, inband FEC, and high bitrate for voice and screen audio', () => {
    const rawSdp = [
      'v=0',
      'o=- 12345 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 0.0.0.0',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=20;useinbandfec=0',
    ].join('\r\n');

    // Voice call optimization
    const voiceSdp = optimizeOpusSdp(rawSdp, false);
    expect(voiceSdp).toContain('maxaveragebitrate=128000');
    expect(voiceSdp).toContain('stereo=1');
    expect(voiceSdp).toContain('sprop-stereo=1');
    expect(voiceSdp).toContain('useinbandfec=1');
    expect(voiceSdp).toContain('usedtx=0');
    expect(voiceSdp).toContain('b=AS:128');

    // Screen audio optimization (stereo high bitrate 256kbps)
    const screenSdp = optimizeOpusSdp(rawSdp, true);
    expect(screenSdp).toContain('maxaveragebitrate=256000');
    expect(screenSdp).toContain('b=AS:256');
  });

  it('handles screen share quality preset change and remote quality requests', async () => {
    // 1. Establish call session
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_quality_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    expect(webrtcManager.getSession()?.screenQuality).toBe('auto');

    // 2. Change quality directly
    await webrtcManager.setScreenShareQuality('1080p');
    expect(webrtcManager.getSession()?.screenQuality).toBe('1080p');

    // 3. Remote peer requests quality change
    webrtcManager.requestRemoteScreenQuality('720p');
    expect(webrtcManager.getSession()?.screenQuality).toBe('720p');
    expect(wsManager.sendCallSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        signal_type: 'screen_quality_request',
        data: { quality: '720p' },
      })
    );

    // 4. Remote peer signal notification of quality change
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_quality_test',
      conversation_id: 'conv_123',
      caller_id: 'user_alice',
      receiver_id: 'user_bob_callee',
      call_type: 'video',
      signal_type: 'screen_quality_change',
      data: { quality: '480p' },
    });

    expect(webrtcManager.getSession()?.screenQuality).toBe('480p');
  });
});

class FakeTrack {
  id = 'trk_' + Math.random().toString(36).slice(2, 8);
  kind: 'audio' | 'video';
  enabled = true;
  muted = false;
  readyState: 'live' | 'ended' = 'live';
  onended: (() => void) | null = null;
  onmute: (() => void) | null = null;
  onunmute: (() => void) | null = null;
  applyConstraints = vi.fn().mockResolvedValue(undefined);
  constructor(kind: 'audio' | 'video', muted = false) {
    this.kind = kind;
    this.muted = muted;
  }
  stop = vi.fn(() => {
    this.readyState = 'ended';
  });
}

class FakeMediaStream {
  private tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  iceConnectionState: RTCIceConnectionState = 'new';
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: any = null;
  localDescription: any = null;
  onicecandidate: ((e: any) => void) | null = null;
  ontrack: ((e: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;

  transceivers: Array<{
    direction: RTCRtpTransceiverDirection;
    sender: {
      track: FakeTrack | null;
      replaceTrack: ReturnType<typeof vi.fn>;
      getParameters: ReturnType<typeof vi.fn>;
      setParameters: ReturnType<typeof vi.fn>;
    };
    receiver: { track: FakeTrack };
  }> = [];

  createOffer = vi.fn(async (opts?: RTCOfferOptions) => ({
    type: 'offer' as RTCSdpType,
    sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\n${opts?.iceRestart ? 'a=ice-ufrag:restarted\r\n' : ''}`,
  }));
  createAnswer = vi.fn(async () => ({
    type: 'answer' as RTCSdpType,
    sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\n',
  }));
  setLocalDescription = vi.fn(async (desc: any) => {
    this.localDescription = desc;
  });
  setRemoteDescription = vi.fn(async (desc: any) => {
    this.remoteDescription = desc;
  });
  addIceCandidate = vi.fn(async () => {});
  restartIce = vi.fn();
  getStats = vi.fn(async () => new Map());
  close = vi.fn(() => {
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  });

  lastConfig: RTCConfiguration | undefined;

  constructor(cfg?: RTCConfiguration) {
    this.lastConfig = cfg;
    FakeRTCPeerConnection.instances.push(this);
  }

  addTrack(track: FakeTrack) {
    const sender = {
      track: track as FakeTrack | null,
      replaceTrack: vi.fn(async (next: FakeTrack | null) => {
        sender.track = next;
      }),
      getParameters: vi.fn(() => ({ encodings: [{}] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    this.transceivers.push({
      direction: 'sendrecv',
      sender,
      receiver: { track: new FakeTrack(track.kind) },
    });
    return sender;
  }

  addTransceiver(kind: 'audio' | 'video', init?: { direction?: RTCRtpTransceiverDirection }) {
    const sender = {
      track: null as FakeTrack | null,
      replaceTrack: vi.fn(async (next: FakeTrack | null) => {
        sender.track = next;
      }),
      getParameters: vi.fn(() => ({ encodings: [{}] })),
      setParameters: vi.fn().mockResolvedValue(undefined),
    };
    const t = {
      direction: init?.direction || 'sendrecv',
      sender,
      receiver: { track: new FakeTrack(kind) },
    };
    this.transceivers.push(t);
    return t;
  }

  removeTrack = vi.fn((sender: any) => {
    const t = this.transceivers.find((tr) => tr.sender === sender);
    if (t) {
      sender.track = null;
      t.direction = 'recvonly';
    }
  });

  getTransceivers() {
    return this.transceivers;
  }

  getSenders() {
    return this.transceivers.map((t) => t.sender);
  }
}

describe('WebRTC Manager Remediation Verification (Real Failures & Recovery)', () => {
  let getUserMediaMock: ReturnType<typeof vi.fn>;
  let getDisplayMediaMock: ReturnType<typeof vi.fn>;
  let wsConnCb: ((connected: boolean) => void) | null = null;

  beforeEach(() => {
    FakeRTCPeerConnection.instances = [];
    MockAudioContext.instances = [];
    wsConnCb = null;

    getUserMediaMock = vi.fn(async (constraints: MediaStreamConstraints) => {
      const tracks: FakeTrack[] = [];
      if (constraints.audio) tracks.push(new FakeTrack('audio'));
      if (constraints.video) tracks.push(new FakeTrack('video'));
      return new FakeMediaStream(tracks) as any;
    });
    getDisplayMediaMock = vi.fn(async () => new FakeMediaStream([new FakeTrack('video')]) as any);

    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection);
    vi.stubGlobal('RTCSessionDescription', MockRTCSessionDescription);
    vi.stubGlobal('RTCIceCandidate', MockRTCIceCandidate);
    vi.stubGlobal('AudioContext', MockAudioContext);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      AudioContext: MockAudioContext,
    });
    vi.stubGlobal('navigator', {
      vibrate: vi.fn(),
      mediaDevices: {
        getUserMedia: getUserMediaMock,
        getDisplayMedia: getDisplayMediaMock,
        enumerateDevices: vi.fn().mockResolvedValue([]),
        addEventListener: vi.fn(),
      },
    });

    const mockStorage: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in mockStorage ? mockStorage[k] : null),
      setItem: (k: string, v: string) => {
        mockStorage[k] = v;
      },
      removeItem: (k: string) => {
        delete mockStorage[k];
      },
      clear: () => {},
    });

    (wsManager as any).onConnectionChange = vi.fn((cb: (connected: boolean) => void) => {
      wsConnCb = cb;
      return () => {
        wsConnCb = null;
      };
    });

    webrtcManager.dispose();
    webrtcManager.setUserId('user_alice');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    webrtcManager.dispose();
    vi.unstubAllGlobals();
  });

  it('places b=AS after c= in optimizeOpusSdp to satisfy RFC 4566 and avoid setRemoteDescription failures', () => {
    const raw = [
      'v=0',
      'o=- 1 2 IN IP4 127.0.0.1',
      's=-',
      't=0 0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'c=IN IP4 0.0.0.0',
      'b=AS:64',
      'a=rtpmap:111 opus/48000/2',
    ].join('\r\n');

    const opt = optimizeOpusSdp(raw, false);
    const lines = opt.split('\r\n');
    const cIdx = lines.indexOf('c=IN IP4 0.0.0.0');
    const bIdx = lines.indexOf('b=AS:128');
    const aIdx = lines.findIndex((l) => l.startsWith('a='));
    expect(cIdx).toBeGreaterThan(-1);
    expect(bIdx).toBe(cIdx + 1);
    expect(bIdx).toBeLessThan(aIdx);
    expect(lines.filter((l) => l.startsWith('b=AS:'))).toHaveLength(1);
  });

  it('propagates NotAllowedError from mediaDeviceManager and moves outgoing call to failed/permissions without alerting', async () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    getUserMediaMock.mockRejectedValueOnce(err);

    await expect(mediaDeviceManager.getAudioStream()).rejects.toThrow('Permission denied');
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    getUserMediaMock.mockRejectedValueOnce(err);
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');

    const session = webrtcManager.getSession();
    expect(session?.state).toBe('failed');
    expect(session?.failureStage).toBe('permissions');
    expect(wsManager.sendCallSignal).not.toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'invite' }));
  });

  it('waits for real ICE connected state instead of marking connected prematurely inside ontrack', async () => {
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callId = webrtcManager.getSession()!.callId;

    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'accept',
    });

    expect(webrtcManager.getSession()?.state).toBe('connecting');
    const pc = FakeRTCPeerConnection.instances[0];
    expect(pc).toBeDefined();

    // Simulate muted video m-line track arriving during audio call while ICE is still checking
    const mutedVideoTrack = new FakeTrack('video', true);
    const remoteAudioTrack = new FakeTrack('audio', false);
    pc.ontrack?.({ track: remoteAudioTrack, streams: [new FakeMediaStream([remoteAudioTrack, mutedVideoTrack]) as any] });
    pc.ontrack?.({ track: mutedVideoTrack, streams: [new FakeMediaStream([mutedVideoTrack]) as any] });

    expect(webrtcManager.getSession()?.state).toBe('connecting');
    expect(webrtcManager.getSession()?.hasRemoteVideo).toBeFalsy();

    // Now real ICE connects
    pc.iceConnectionState = 'connected';
    pc.oniceconnectionstatechange?.();
    expect(webrtcManager.getSession()?.state).toBe('connected');

    // Unmuting remote video track activates video stage dynamically
    mutedVideoTrack.muted = false;
    mutedVideoTrack.onunmute?.();
    expect(webrtcManager.getSession()?.hasRemoteVideo).toBe(true);
  });

  it('ignores duplicate invite for same active callId and ignores signals with wrong callId', async () => {
    webrtcManager.setUserId('user_bob');
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_active_x',
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'invite',
      data: { caller_name: 'Alice' },
    });

    vi.clearAllMocks();
    // Duplicate invite must not re-ring or overwrite
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_active_x',
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'invite',
    });
    expect(wsManager.sendCallSignal).not.toHaveBeenCalled();

    // Hangup for unrelated call_id must not terminate active call
    await webrtcManager.handleIncomingSignal({
      call_id: 'call_other_y',
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'hangup',
    });
    expect(webrtcManager.getSession()?.callId).toBe('call_active_x');
    expect(webrtcManager.getSession()?.state).toBe('incoming_ringing');
  });

  it('handles call.signal_status for offline peer and blocked peer accurately', async () => {
    webrtcManager.init();
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callId = webrtcManager.getSession()!.callId;

    const subCall = (wsManager.subscribe as any).mock.calls[0][0];
    subCall({
      type: 'call.signal_status',
      payload: { call_id: callId, status: 'target_offline' },
    });
    expect(webrtcManager.getSession()?.targetOffline).toBe(true);

    subCall({
      type: 'call.signal_status',
      payload: { call_id: callId, status: 'blocked' },
    });
    expect(webrtcManager.getSession()?.state).toBe('rejected');
    expect(webrtcManager.getSession()?.failureStage).toBe('blocked');
  });

  it('switches microphone and camera devices cleanly via replaceTrack and stops old hardware tracks', async () => {
    mediaDeviceManager.setSelectedAudioInputId('mic_1');
    mediaDeviceManager.setSelectedVideoInputId('cam_1');

    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'video');
    expect(getUserMediaMock).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.objectContaining({ deviceId: { exact: 'mic_1' } }) }));
    expect(getUserMediaMock).toHaveBeenCalledWith(expect.objectContaining({ video: expect.objectContaining({ deviceId: { exact: 'cam_1' } }) }));

    const callId = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'video',
      signal_type: 'accept',
    });

    const oldAudioTrack = webrtcManager.getSession()!.localStream!.getAudioTracks()[0] as unknown as FakeTrack;
    const oldVideoTrack = webrtcManager.getSession()!.localStream!.getVideoTracks()[0] as unknown as FakeTrack;

    await webrtcManager.switchAudioInput('mic_2');
    await webrtcManager.switchVideoInput('cam_2');

    expect(oldAudioTrack.stop).toHaveBeenCalled();
    expect(oldVideoTrack.stop).toHaveBeenCalled();
    const pc = FakeRTCPeerConnection.instances[0];
    const audioSender = pc.getSenders().find((s) => s.track?.kind === 'audio');
    const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
    expect(audioSender?.replaceTrack).toHaveBeenCalled();
    expect(videoSender?.replaceTrack).toHaveBeenCalled();
  });

  it('upgrades an audio call to video on toggleVideo(ON) and stops hardware camera on toggleVideo(OFF)', async () => {
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callId = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'accept',
    });

    const pc = FakeRTCPeerConnection.instances[0];
    pc.iceConnectionState = 'connected';
    pc.oniceconnectionstatechange?.();
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'sdp_answer',
      data: { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    });

    vi.clearAllMocks();
    // Turn camera ON during audio call
    await webrtcManager.toggleVideo();
    expect(webrtcManager.getSession()?.isVideoOff).toBe(false);
    const videoTrack = webrtcManager.getSession()!.localStream!.getVideoTracks()[0] as unknown as FakeTrack;
    expect(videoTrack).toBeDefined();
    expect(wsManager.sendCallSignal).toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'video_state', data: { enabled: true } }));

    // Turn camera OFF
    await webrtcManager.toggleVideo();
    expect(webrtcManager.getSession()?.isVideoOff).toBe(true);
    expect(videoTrack.stop).toHaveBeenCalled();
    expect(wsManager.sendCallSignal).toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'video_state', data: { enabled: false } }));
  });

  it('triggers ICE restart on iceConnectionState failed or WS reconnect and fails cleanly after 25s connecting timeout', async () => {
    vi.useFakeTimers();
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callId = webrtcManager.getSession()!.callId;

    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'accept',
    });

    const pc = FakeRTCPeerConnection.instances[0];
    vi.clearAllMocks();

    // Simulate ICE failed -> must call restartIce & send iceRestart offer
    pc.iceConnectionState = 'failed';
    pc.oniceconnectionstatechange?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(pc.restartIce).toHaveBeenCalled();
    expect(pc.createOffer).toHaveBeenCalledWith({ iceRestart: true });
    expect(wsManager.sendCallSignal).toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'sdp_offer' }));

    // Simulate WS reconnection also triggering ICE restart if disconnected
    wsConnCb?.(true);
    await Promise.resolve();
    expect(pc.createOffer).toHaveBeenCalledTimes(2);

    // Connecting timeout (25s) transitions to failed/turn_or_nat when no TURN configured and logs once
    vi.advanceTimersByTime(25500);
    expect(webrtcManager.getSession()?.state).toBe('failed');
    expect(webrtcManager.getSession()?.failureStage).toBe('turn_or_nat');
    expect(api.createCallLog).toHaveBeenCalledWith(
      expect.objectContaining({
        id: callId,
        caller_id: 'user_alice',
        receiver_id: 'user_bob',
        status: 'failed',
      })
    );
  });

  it('aborts toggleScreenShare immediately when user cancels getDisplayMedia (NotAllowedError)', async () => {
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callId = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'accept',
    });

    getDisplayMediaMock.mockRejectedValueOnce(Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' }));
    await webrtcManager.toggleScreenShare();

    expect(getDisplayMediaMock).toHaveBeenCalledTimes(1);
    expect(webrtcManager.getSession()?.isScreenSharing).toBeFalsy();
  });

  it('honors empty [] (STUN_SERVERS=none) and TURN-only ICE lists without injecting default STUN servers', async () => {
    (api.getIceServers as any).mockResolvedValueOnce([]);
    await webrtcManager.refreshIceServers();
    expect(webrtcManager.getIceServers()).toEqual([]);

    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callIdEmpty = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callIdEmpty,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'accept',
    });
    expect(FakeRTCPeerConnection.instances[0].lastConfig?.iceServers).toEqual([]);
    webrtcManager.resetSession();

    const turnOnly = [{ urls: 'turn:turn.example.com:3478?transport=udp', username: 'u1', credential: 'p1' }];
    (api.getIceServers as any).mockResolvedValueOnce(turnOnly);
    await webrtcManager.refreshIceServers();
    expect(webrtcManager.getIceServers()).toEqual(turnOnly);
  });

  it('stops screen capture tracks and rolls back isScreenSharing when replaceTrack fails', async () => {
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'video');
    const callId = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'video',
      signal_type: 'accept',
    });

    const pc = FakeRTCPeerConnection.instances[0];
    const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video')!;
    videoSender.replaceTrack.mockRejectedValueOnce(new Error('replaceTrack hardware failure'));

    const screenVideoTrack = new FakeTrack('video');
    const screenAudioTrack = new FakeTrack('audio');
    getDisplayMediaMock.mockResolvedValueOnce(new FakeMediaStream([screenVideoTrack, screenAudioTrack]) as any);

    vi.clearAllMocks();
    await webrtcManager.toggleScreenShare();

    expect(screenVideoTrack.stop).toHaveBeenCalled();
    expect(screenAudioTrack.stop).toHaveBeenCalled();
    expect(webrtcManager.getSession()?.isScreenSharing).toBe(false);
    expect(webrtcManager.getSession()?.screenStream).toBeUndefined();
    expect(wsManager.sendCallSignal).not.toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'screen_share_start' }));
  });

  it('rolls back capture, mixed audio, tracks, transceiver direction, and peer notification when createOffer rejects during toggleScreenShare', async () => {
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callId = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'accept',
    });

    const pc = FakeRTCPeerConnection.instances[0];
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'sdp_answer',
      data: { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    });

    const videoTransceiver = pc.transceivers.find((t) => t.receiver.track.kind === 'video')!;
    videoTransceiver.direction = 'recvonly';
    const videoSender = videoTransceiver.sender;
    const audioSender = pc.getSenders().find((s) => s.track?.kind === 'audio')!;
    const originalMicTrack = audioSender.track!;

    const screenVideoTrack = new FakeTrack('video');
    const screenAudioTrack = new FakeTrack('audio');
    getDisplayMediaMock.mockResolvedValueOnce(new FakeMediaStream([screenVideoTrack, screenAudioTrack]) as any);
    pc.createOffer.mockRejectedValueOnce(new Error('createOffer SDP failure'));

    vi.clearAllMocks();
    MockAudioContext.instances = [];

    await webrtcManager.toggleScreenShare();

    // 1. Capture tracks and mixed audio stream/context must all be stopped & closed
    expect(screenVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(screenVideoTrack.readyState).toBe('ended');
    expect(screenAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(screenAudioTrack.readyState).toBe('ended');
    expect(MockAudioContext.instances.length).toBeGreaterThanOrEqual(1);
    const screenAudioCtx = MockAudioContext.instances[MockAudioContext.instances.length - 1];
    expect(screenAudioCtx.close).toHaveBeenCalledTimes(1);
    expect(screenAudioCtx.lastMixedTrack).not.toBeNull();
    expect(screenAudioCtx.lastMixedTrack!.stop).toHaveBeenCalledTimes(1);
    expect(screenAudioCtx.lastMixedTrack!.readyState).toBe('ended');

    // 2. Video sender, audio sender, and transceiver direction must be restored
    expect(videoSender.track).toBeNull();
    expect(videoSender.replaceTrack).toHaveBeenLastCalledWith(null);
    expect(videoTransceiver.direction).toBe('recvonly');
    expect(audioSender.track).toBe(originalMicTrack);
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(originalMicTrack);

    // 3. Share state cleared and remote peer never told screen share is active
    expect(webrtcManager.getSession()?.isScreenSharing).toBe(false);
    expect(webrtcManager.getSession()?.screenStream).toBeUndefined();
    expect(wsManager.sendCallSignal).not.toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'screen_share_start' }));
    expect(wsManager.sendCallSignal).not.toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'sdp_offer' }));
  });

  it('rolls back capture, mixed audio, camera track, transceiver direction, and peer notification when setLocalDescription rejects during toggleScreenShare', async () => {
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'video');
    const callId = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'video',
      signal_type: 'accept',
    });

    const pc = FakeRTCPeerConnection.instances[0];
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'video',
      signal_type: 'sdp_answer',
      data: { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    });

    const videoTransceiver = pc.transceivers.find((t) => t.sender.track?.kind === 'video')!;
    videoTransceiver.direction = 'inactive';
    const videoSender = videoTransceiver.sender;
    const originalCamTrack = videoSender.track!;
    const audioSender = pc.getSenders().find((s) => s.track?.kind === 'audio')!;
    const originalMicTrack = audioSender.track!;

    const screenVideoTrack = new FakeTrack('video');
    const screenAudioTrack = new FakeTrack('audio');
    getDisplayMediaMock.mockResolvedValueOnce(new FakeMediaStream([screenVideoTrack, screenAudioTrack]) as any);
    pc.setLocalDescription.mockRejectedValueOnce(new Error('InvalidAccessError: setLocalDescription failed'));

    vi.clearAllMocks();
    MockAudioContext.instances = [];

    await webrtcManager.toggleScreenShare();

    // 1. Capture tracks and mixed audio stream/context must all be stopped & closed
    expect(screenVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(screenVideoTrack.readyState).toBe('ended');
    expect(screenAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(screenAudioTrack.readyState).toBe('ended');
    expect(MockAudioContext.instances.length).toBeGreaterThanOrEqual(1);
    const screenAudioCtx = MockAudioContext.instances[MockAudioContext.instances.length - 1];
    expect(screenAudioCtx.close).toHaveBeenCalledTimes(1);
    expect(screenAudioCtx.lastMixedTrack!.stop).toHaveBeenCalledTimes(1);
    expect(screenAudioCtx.lastMixedTrack!.readyState).toBe('ended');

    // 2. Previous camera track, mic track, and transceiver direction must be restored
    expect(videoSender.track).toBe(originalCamTrack);
    expect(videoSender.replaceTrack).toHaveBeenLastCalledWith(originalCamTrack);
    expect(videoTransceiver.direction).toBe('inactive');
    expect(audioSender.track).toBe(originalMicTrack);
    expect(audioSender.replaceTrack).toHaveBeenLastCalledWith(originalMicTrack);

    // 3. Share state cleared and peer not left thinking screen share succeeded
    expect(webrtcManager.getSession()?.isScreenSharing).toBe(false);
    expect(webrtcManager.getSession()?.screenStream).toBeUndefined();
    expect(wsManager.sendCallSignal).not.toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'screen_share_start' }));
    expect(wsManager.sendCallSignal).not.toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'sdp_offer' }));
  });

  it('handles makingOffer and concurrent negotiation safely without treating early returns as success', async () => {
    // 1. Early return when inactive must return { ok: false, status: "inactive" }
    const inactiveResult = await webrtcManager.renegotiate();
    expect(inactiveResult.ok).toBe(false);
    expect(inactiveResult.status).toBe('inactive');

    // Start connected session
    await webrtcManager.startCall('conv_1', 'user_bob', 'Bob', 'audio');
    const callId = webrtcManager.getSession()!.callId;
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'accept',
    });

    const pc = FakeRTCPeerConnection.instances[0];
    await webrtcManager.handleIncomingSignal({
      call_id: callId,
      conversation_id: 'conv_1',
      caller_id: 'user_alice',
      receiver_id: 'user_bob',
      call_type: 'audio',
      signal_type: 'sdp_answer',
      data: { type: 'answer', sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' },
    });

    // 2. Concurrent tracked renegotiate() waits for in-flight offer rather than silently succeeding early
    let resolveFirstOffer!: (offer: { type: RTCSdpType; sdp: string }) => void;
    const firstOfferPromise = new Promise<{ type: RTCSdpType; sdp: string }>((resolve) => {
      resolveFirstOffer = resolve;
    });
    pc.createOffer.mockImplementationOnce(() => firstOfferPromise);

    vi.clearAllMocks();
    const firstNegPromise = webrtcManager.renegotiate();
    let secondResolved = false;
    const secondNegPromise = webrtcManager.renegotiate({ iceRestart: true }).then((res) => {
      secondResolved = true;
      return res;
    });

    await Promise.resolve();
    await Promise.resolve();
    // Second call must NOT return early while first offer is still makingOffer
    expect(secondResolved).toBe(false);

    resolveFirstOffer({
      type: 'offer',
      sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\n',
    });

    const [res1, res2] = await Promise.all([firstNegPromise, secondNegPromise]);
    expect(res1.ok).toBe(true);
    expect(res1.status).toBe('sent');
    expect(res2.ok).toBe(true);
    expect(res2.status).toBe('sent');
    expect(pc.createOffer).toHaveBeenCalledTimes(2);
    expect(pc.createOffer).toHaveBeenLastCalledWith({ iceRestart: true });

    // 3. Untracked makingOffer=true / unstable signalingState returns busy (ok=false) and rolls back toggleScreenShare
    const videoTransceiver = pc.transceivers.find((t) => t.receiver.track.kind === 'video')!;
    videoTransceiver.direction = 'recvonly';
    const audioSender = pc.getSenders().find((s) => s.track?.kind === 'audio')!;
    const originalMicTrack = audioSender.track!;

    const screenVideoTrack = new FakeTrack('video');
    const screenAudioTrack = new FakeTrack('audio');
    getDisplayMediaMock.mockResolvedValueOnce(new FakeMediaStream([screenVideoTrack, screenAudioTrack]) as any);
    (webrtcManager as any).makingOffer = true;

    vi.clearAllMocks();
    MockAudioContext.instances = [];
    const busyRes = await webrtcManager.renegotiate();
    expect(busyRes.ok).toBe(false);
    expect(busyRes.status).toBe('busy');

    await webrtcManager.toggleScreenShare();
    (webrtcManager as any).makingOffer = false;

    expect(screenVideoTrack.stop).toHaveBeenCalledTimes(1);
    expect(screenAudioTrack.stop).toHaveBeenCalledTimes(1);
    expect(MockAudioContext.instances[MockAudioContext.instances.length - 1].close).toHaveBeenCalledTimes(1);
    expect(videoTransceiver.sender.track).toBeNull();
    expect(videoTransceiver.direction).toBe('recvonly');
    expect(audioSender.track).toBe(originalMicTrack);
    expect(webrtcManager.getSession()?.isScreenSharing).toBe(false);
    expect(wsManager.sendCallSignal).not.toHaveBeenCalledWith(expect.objectContaining({ signal_type: 'screen_share_start' }));
  });
});
