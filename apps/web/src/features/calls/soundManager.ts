// Sound Manager for Call Ringtones, Outgoing Ringback, and Message Chimes
// Uses the Web Audio API synthesizer — 100% resilient, zero dependency on external audio files

class SoundManager {
  private audioCtx: AudioContext | null = null;
  private ringtoneInterval: any = null;
  private ringbackInterval: any = null;
  private isRingtonePlaying = false;
  private isRingbackPlaying = false;

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtxClass) return null;

    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      try {
        this.audioCtx = new AudioCtxClass();
      } catch {
        return null;
      }
    }
    return this.audioCtx;
  }

  async resumeContext(onBlocked?: () => void): Promise<boolean> {
    const ctx = this.getContext();
    if (!ctx) return false;

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        if (onBlocked) onBlocked();
        return false;
      }
    }
    return ctx.state === 'running';
  }

  // -------------------------------------------------------------
  // Incoming Call Ringtone
  // -------------------------------------------------------------
  async startIncomingRingtone(onAutoplayBlocked?: () => void): Promise<void> {
    if (this.isRingtonePlaying) return;
    this.stopOutgoingRingback(); // Ensure no conflicting ringback
    this.isRingtonePlaying = true;

    const ok = await this.resumeContext(onAutoplayBlocked);
    if (!ok && onAutoplayBlocked) {
      onAutoplayBlocked();
    }

    this.playRingtoneSequence();
    this.ringtoneInterval = setInterval(() => {
      if (!this.isRingtonePlaying) return;
      this.playRingtoneSequence();
    }, 3200);
  }

  private playRingtoneSequence() {
    const ctx = this.getContext();
    if (!ctx || ctx.state !== 'running' || !this.isRingtonePlaying) return;

    try {
      // Pleasant melodic chime: E5 (659Hz) -> G5 (784Hz) -> B5 (988Hz) -> E6 (1318Hz)
      const notes = [
        { freq: 659.25, time: 0.0, dur: 0.18 },
        { freq: 783.99, time: 0.18, dur: 0.18 },
        { freq: 987.77, time: 0.36, dur: 0.22 },
        { freq: 1318.51, time: 0.58, dur: 0.45 },
        // Repeat phrase
        { freq: 987.77, time: 1.2, dur: 0.18 },
        { freq: 1318.51, time: 1.4, dur: 0.5 },
      ];

      const now = ctx.currentTime;
      for (const n of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(n.freq, now + n.time);

        gain.gain.setValueAtTime(0.001, now + n.time);
        gain.gain.exponentialRampToValueAtTime(0.2, now + n.time + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + n.time + n.dur);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + n.time);
        osc.stop(now + n.time + n.dur);
      }
    } catch (e) {
      console.warn('[SoundManager] Ringtone play error:', e);
    }
  }

  stopIncomingRingtone(): void {
    this.isRingtonePlaying = false;
    if (this.ringtoneInterval) {
      clearInterval(this.ringtoneInterval);
      this.ringtoneInterval = null;
    }
  }

  // -------------------------------------------------------------
  // Outgoing Call Ringback Tone
  // -------------------------------------------------------------
  async startOutgoingRingback(onAutoplayBlocked?: () => void): Promise<void> {
    if (this.isRingbackPlaying) return;
    this.stopIncomingRingtone(); // Ensure no conflicting ringtone
    this.isRingbackPlaying = true;

    const ok = await this.resumeContext(onAutoplayBlocked);
    if (!ok && onAutoplayBlocked) {
      onAutoplayBlocked();
    }

    this.playRingbackBurst();
    this.ringbackInterval = setInterval(() => {
      if (!this.isRingbackPlaying) return;
      this.playRingbackBurst();
    }, 4000);
  }

  private playRingbackBurst() {
    const ctx = this.getContext();
    if (!ctx || ctx.state !== 'running' || !this.isRingbackPlaying) return;

    try {
      // Standard North American/ITU-T dual tone: 440 Hz + 480 Hz for 1.8 seconds
      const now = ctx.currentTime;
      const duration = 1.8;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(440, now);

      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(480, now);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.05);
      gain.gain.setValueAtTime(0.08, now + duration - 0.05);
      gain.gain.linearRampToValueAtTime(0.001, now + duration);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + duration);
      osc2.stop(now + duration);
    } catch (e) {
      console.warn('[SoundManager] Ringback play error:', e);
    }
  }

  stopOutgoingRingback(): void {
    this.isRingbackPlaying = false;
    if (this.ringbackInterval) {
      clearInterval(this.ringbackInterval);
      this.ringbackInterval = null;
    }
  }

  // -------------------------------------------------------------
  // Message Notification Sound
  // -------------------------------------------------------------
  playMessageNotification(): void {
    const ctx = this.getContext();
    if (!ctx) return;

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    try {
      const now = ctx.currentTime;
      // Two-tone modern Telegram-style notification chime: F5 (698Hz) -> C6 (1046Hz)
      const tone1 = ctx.createOscillator();
      const tone2 = ctx.createOscillator();
      const gain = ctx.createGain();

      tone1.type = 'sine';
      tone1.frequency.setValueAtTime(698.46, now);

      tone2.type = 'sine';
      tone2.frequency.setValueAtTime(1046.5, now + 0.08);

      gain.gain.setValueAtTime(0.001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      tone1.connect(gain);
      tone2.connect(gain);
      gain.connect(ctx.destination);

      tone1.start(now);
      tone1.stop(now + 0.1);

      tone2.start(now + 0.08);
      tone2.stop(now + 0.35);
    } catch (e) {
      console.warn('[SoundManager] Message chime error:', e);
    }
  }

  // Stop all active audio
  stopAll(): void {
    this.stopIncomingRingtone();
    this.stopOutgoingRingback();
  }
}

export const soundManager = new SoundManager();
