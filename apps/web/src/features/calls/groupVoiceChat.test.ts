import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { groupVoiceChatManager } from './groupVoiceChatManager';
import { api } from '../../protocol/api';
import { wsManager } from '../../protocol/ws';

vi.mock('../../protocol/ws', () => ({
  wsManager: {
    sendVoiceChatSignal: vi.fn(),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('../../protocol/api', () => ({
  api: {
    getIceServers: vi.fn().mockResolvedValue([]),
    getConversationRole: vi.fn().mockResolvedValue({ role: 'member' }),
    getActiveVoiceChat: vi.fn().mockResolvedValue({ room: null, participants: [] }),
    startOrJoinVoiceChat: vi.fn(),
    updateVoiceChatState: vi.fn().mockResolvedValue({ status: 'updated' }),
    leaveVoiceChat: vi.fn().mockResolvedValue({ status: 'left' }),
    endVoiceChat: vi.fn().mockResolvedValue({ status: 'ended' }),
  },
}));

class VCFakeTrack {
  id = 'vc_trk_' + Math.random().toString(36).slice(2, 7);
  kind: 'audio' = 'audio';
  enabled = true;
  stop = vi.fn();
}

class VCFakeStream {
  tracks: VCFakeTrack[];
  constructor(tracks: VCFakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks;
  }
}

class VCFakePC {
  static instances: VCFakePC[] = [];
  iceConnectionState: RTCIceConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  remoteDescription: any = null;
  onicecandidate: ((e: any) => void) | null = null;
  ontrack: ((e: any) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  senders: any[] = [];
  lastConfig: RTCConfiguration | undefined;
  constructor(cfg?: RTCConfiguration) {
    this.lastConfig = cfg;
    VCFakePC.instances.push(this);
  }
  addTrack = vi.fn((track: any) => {
    this.senders.push({ track, replaceTrack: vi.fn().mockResolvedValue(undefined) });
  });
  getSenders = () => this.senders;
  createOffer = vi.fn(async () => ({ type: 'offer' as RTCSdpType, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\n' }));
  createAnswer = vi.fn(async () => ({ type: 'answer' as RTCSdpType, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nc=IN IP4 0.0.0.0\r\na=rtpmap:111 opus/48000/2\r\n' }));
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn(async (d: any) => {
    this.remoteDescription = d;
  });
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  restartIce = vi.fn();
  close = vi.fn(() => {
    this.iceConnectionState = 'closed';
  });
}

class MockVCAudioContext {
  state = 'running';
  freqProvider: () => number;
  constructor(freqProvider: () => number) {
    this.freqProvider = freqProvider;
  }
  close = vi.fn().mockResolvedValue(undefined);
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 64,
    connect: vi.fn(),
    disconnect: vi.fn(),
    getByteFrequencyData: (arr: Uint8Array) => arr.fill(this.freqProvider()),
  }));
}

class MockVCRTCSessionDescription {
  type: any;
  sdp: any;
  constructor(init: any) {
    Object.assign(this, init);
  }
}

class MockVCRTCIceCandidate {
  candidate: any;
  sdpMid: any;
  sdpMLineIndex: any;
  usernameFragment: any;
  constructor(init: any) {
    Object.assign(this, init);
  }
}

describe('GroupVoiceChatManager WebRTC Mesh & State Verification', () => {
  let wsCb: ((ev: any) => void) | null = null;
  let freqData = 0;

  beforeEach(() => {
    VCFakePC.instances = [];
    freqData = 0;
    wsCb = null;

    (wsManager.subscribe as any).mockImplementation((cb: (ev: any) => void) => {
      wsCb = cb;
      return () => {
        wsCb = null;
      };
    });

    vi.stubGlobal('MediaStream', VCFakeStream);
    vi.stubGlobal('RTCPeerConnection', VCFakePC);
    vi.stubGlobal('RTCSessionDescription', MockVCRTCSessionDescription);
    vi.stubGlobal('RTCIceCandidate', MockVCRTCIceCandidate);

    const fakeAudioEl = {
      autoplay: true,
      srcObject: null as any,
      setAttribute: vi.fn(),
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      remove: vi.fn(),
    };

    vi.stubGlobal('document', {
      body: {
        contains: vi.fn().mockReturnValue(true),
        appendChild: vi.fn(),
      },
      createElement: vi.fn((tag: string) => {
        if (tag === 'audio') return { ...fakeAudioEl };
        return {
          setAttribute: vi.fn(),
          style: {},
          appendChild: vi.fn(),
        };
      }),
    });

    class TestWindowAudioContext extends MockVCAudioContext {
      constructor() {
        super(() => freqData);
      }
    }

    vi.stubGlobal('AudioContext', TestWindowAudioContext);
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      AudioContext: TestWindowAudioContext,
    });

    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new VCFakeStream([new VCFakeTrack()]) as any),
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

    groupVoiceChatManager.setUserId('user_bob');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await groupVoiceChatManager.leaveRoom();
    groupVoiceChatManager.dispose();
    vi.unstubAllGlobals();
  });

  it('syncs unmuted state on join, creates mesh peer connections, and preserves mute across speaking changes', async () => {
    vi.useFakeTimers();
    (api.startOrJoinVoiceChat as any).mockResolvedValueOnce({
      room: { id: 'room_1', conversation_id: 'conv_grp', created_by: 'user_alice', is_active: true, participant_count: 2 },
      participants: [
        { user_id: 'user_alice', username: 'alice', display_name: 'Alice', is_muted: false, is_speaking: false },
        { user_id: 'user_bob', username: 'bob', display_name: 'Bob', is_muted: true, is_speaking: false },
      ],
    });

    let latestState: any = null;
    const unsub = groupVoiceChatManager.subscribe((s) => {
      latestState = s;
    });

    await groupVoiceChatManager.openConversationRoom('conv_grp');
    await groupVoiceChatManager.joinRoom('conv_grp');

    expect(latestState.isJoined).toBe(true);
    expect(latestState.isMuted).toBe(false);
    // Immediate sync with server (fixes backend default is_muted=true)
    expect(api.updateVoiceChatState).toHaveBeenCalledWith('conv_grp', { is_muted: false, is_speaking: false });
    // Deterministic mesh initiator: 'user_bob' > 'user_alice'
    expect(VCFakePC.instances).toHaveLength(1);
    expect(VCFakePC.instances[0].createOffer).toHaveBeenCalled();
    expect(wsManager.sendVoiceChatSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv_grp',
        room_id: 'room_1',
        target_user_id: 'user_alice',
        signal_type: 'sdp_offer',
      })
    );

    // Mute mic -> speaking detector tick MUST NOT overwrite is_muted back to false
    await groupVoiceChatManager.toggleMute();
    expect(api.updateVoiceChatState).toHaveBeenLastCalledWith('conv_grp', { is_muted: true, is_speaking: false });

    freqData = 80;
    vi.advanceTimersByTime(300);
    expect(latestState.isMuted).toBe(true);
    expect(latestState.isSpeaking).toBe(false);

    unsub();
  });

  it('ignores forged room_ended WS signals but tears down cleanly on authoritative voice_chat.ended', async () => {
    (api.startOrJoinVoiceChat as any).mockResolvedValueOnce({
      room: { id: 'room_2', conversation_id: 'conv_grp2', created_by: 'user_alice', is_active: true, participant_count: 2 },
      participants: [
        { user_id: 'user_alice', username: 'alice', display_name: 'Alice', is_muted: false, is_speaking: false },
        { user_id: 'user_bob', username: 'bob', display_name: 'Bob', is_muted: false, is_speaking: false },
      ],
    });

    let latestState: any = null;
    const unsub = groupVoiceChatManager.subscribe((s) => {
      latestState = s;
    });

    await groupVoiceChatManager.openConversationRoom('conv_grp2');
    await groupVoiceChatManager.joinRoom('conv_grp2');

    // Forged WS room_ended signal from non-admin peer -> must be ignored!
    wsCb?.({
      type: 'voice_chat.signal',
      payload: {
        room_id: 'room_2',
        conversation_id: 'conv_grp2',
        sender_user_id: 'user_alice',
        signal_type: 'room_ended',
      },
    });
    await Promise.resolve();
    expect(latestState.isJoined).toBe(true);
    expect(latestState.room).not.toBeNull();

    // Authoritative server event voice_chat.ended -> tears down room & peer connections
    wsCb?.({
      type: 'voice_chat.ended',
      payload: { room_id: 'room_2', conversation_id: 'conv_grp2' },
    });
    expect(latestState.isJoined).toBe(false);
    expect(latestState.room).toBeNull();
    expect(VCFakePC.instances[0].close).toHaveBeenCalled();

    unsub();
  });

  it('flags mesh scaling warning when participants exceed 8 and checks RBAC role', async () => {
    (api.getConversationRole as any).mockResolvedValueOnce({ role: 'admin' });
    const manyParticipants = Array.from({ length: 10 }, (_, i) => ({
      user_id: `u_${i}`,
      username: `user${i}`,
      display_name: `User ${i}`,
      is_muted: false,
      is_speaking: false,
    }));
    (api.getActiveVoiceChat as any).mockResolvedValueOnce({
      room: { id: 'room_big', conversation_id: 'conv_big', created_by: 'u_0', is_active: true, participant_count: 10 },
      participants: manyParticipants,
    });

    let latestState: any = null;
    const unsub = groupVoiceChatManager.subscribe((s) => {
      latestState = s;
    });

    await groupVoiceChatManager.openConversationRoom('conv_big');
    await Promise.resolve();
    expect(latestState.myRole).toBe('admin');
    expect(latestState.meshWarning).toBe(true);

    unsub();
  });

  it('honors empty [] (STUN_SERVERS=none) and TURN-only ICE lists without injecting default STUN', async () => {
    (api.getIceServers as any).mockResolvedValueOnce([]);
    await groupVoiceChatManager.refreshIceServers();
    expect(groupVoiceChatManager.getIceServers()).toEqual([]);

    const turnOnly = [{ urls: 'turn:turn.example.com:3478?transport=udp', username: 'u1', credential: 'p1' }];
    (api.getIceServers as any).mockResolvedValueOnce(turnOnly);
    await groupVoiceChatManager.refreshIceServers();
    expect(groupVoiceChatManager.getIceServers()).toEqual(turnOnly);

    (api.startOrJoinVoiceChat as any).mockResolvedValueOnce({
      room: { id: 'room_turn', conversation_id: 'conv_turn', created_by: 'user_alice', is_active: true, participant_count: 2 },
      participants: [
        { user_id: 'user_alice', username: 'alice', display_name: 'Alice', is_muted: false, is_speaking: false },
        { user_id: 'user_bob', username: 'bob', display_name: 'Bob', is_muted: false, is_speaking: false },
      ],
    });
    await groupVoiceChatManager.joinRoom('conv_turn');
    expect(VCFakePC.instances).toHaveLength(1);
    expect(VCFakePC.instances[0].lastConfig?.iceServers).toEqual(turnOnly);
  });
});
